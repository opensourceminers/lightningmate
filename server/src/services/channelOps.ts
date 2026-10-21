import { addPeer, closeChannel, getNode, getPeers, openChannel, type AuthenticatedLnd } from "lightning";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface OpenChannelParams {
  pubkey: string;
  /** The address to dial first (connectForOpen; the open itself dials nothing). */
  socket?: string;
  /** More addresses to try, in order (e.g. every socket a Magma buyer lists).
   *  When none connects, the addresses the network graph has are tried too. */
  sockets?: string[];
  localTokens: number;
  /** On-chain fee rate in sat/vByte; omit to let LND estimate. */
  feeRate?: number;
  isPrivate?: boolean;
}

export interface OpenChannelResult {
  ok: boolean;
  pubkey: string;
  localTokens: number;
  transactionId?: string;
  transactionVout?: number;
  error?: string;
}

/** LND won't open channels below ~20k sat; keep a sane floor. */
export const MIN_CHANNEL_SATS = 20_000;

function describe(err: unknown): string {
  if (Array.isArray(err)) {
    const code = err[1] ?? err[0];
    const extra = err[2] as { err?: string | { details?: string; message?: string }; details?: string } | undefined;
    // The library passes LND's own text as a plain string for errors it has
    // no name for ([503, "FailedToOpenChannel", { err: "<LND's details>" }]) —
    // that text is what tells "the peer refused" from "the stream dropped".
    const detail =
      (typeof extra?.err === "string" ? extra.err : (extra?.err?.details ?? extra?.err?.message)) ?? extra?.details ?? "";
    return detail ? `${code}: ${detail}` : String(code);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Refusals that come before any funding transaction exists: our own checks
 * (no connection, a size below LND's floor), and LND or the peer saying no
 * during the negotiation (peer offline, too many pending channels, a size
 * the peer won't take, a wallet that can't fund it, LND's anchor reserve).
 *
 * Anything else — a dropped gRPC stream, a timeout, an error we don't know —
 * may have come AFTER LND broadcast the funding transaction. Such an open is
 * not "failed": its caller keeps the "opening" record and looks for the
 * channel in LND before opening again or releasing the buyer's payment
 * (otherwise: a second channel, or a refunded buyer with a free channel).
 */
const PRE_BROADCAST_REFUSAL =
  /couldn't connect|channel size must be|PeerIsNotOnline|is not online|RemotePeerDisconnected|disconnected$|RemotePeerExited|peer exiting|RemoteNodeDoesNotSupportMultipleChannels|multiple channels unsupported|PeerPendingChannelsExceedMaximumAllowable|pending channels exceed|InsufficientFundsToCreateChannel|not enough witness outputs|insufficient funds|reserved wallet balance invalidated|ChainUnsupported|CannotOpenChannelToOwnNode|WalletNotFullySynced|RemoteNodeSyncing|MaxChannelDescriptionLengthExceeded|ExpectedLargerChannelSizeForChannelOpen|rejected the channel|chan size of .* is (below|above)/i;

export function isPreBroadcastRefusal(error: string): boolean {
  return PRE_BROADCAST_REFUSAL.test(error);
}

/** LND refused because the peer already has as many pending channels as it
 *  accepts (LND's default is one) — gone once the earlier one confirms. */
export const isPendingChannelsLimit = (error: string): boolean =>
  /PeerPendingChannelsExceedMaximumAllowable|pending channels exceed/i.test(error);

async function isConnected(lnd: AuthenticatedLnd, pubkey: string): Promise<boolean> {
  try {
    const { peers } = await getPeers({ lnd });
    return peers.some((p) => p.public_key === pubkey);
  } catch {
    return false;
  }
}

/** The addresses the network graph lists for a node (none when unknown). */
async function graphSockets(lnd: AuthenticatedLnd, pubkey: string): Promise<string[]> {
  try {
    const node = await getNode({ lnd, public_key: pubkey, is_omitting_channels: true });
    return (node.sockets ?? []).map((s) => s.socket).filter((s): s is string => typeof s === "string" && s.length > 0);
  } catch {
    return []; // not in our graph (e.g. a private node)
  }
}

/** One connection attempt may take this long (Tor circuits are slow). */
const CONNECT_ATTEMPT_MS = 30_000;
/** All addresses of one peer together get at most this long. */
const CONNECT_BUDGET_MS = 90_000;

/**
 * Dial one address: two attempts (the library's own default is ten, with
 * exponential backoff — about 50 s per call before, and it was called three
 * times per address, so an unreachable peer took minutes), then verify the
 * peer shows up as connected (the handshake can take a moment).
 */
async function dial(lnd: AuthenticatedLnd, pubkey: string, socket: string): Promise<boolean> {
  try {
    await addPeer({ lnd, public_key: pubkey, socket, retry_count: 1, retry_delay: 1_000, timeout: CONNECT_ATTEMPT_MS });
  } catch {
    // "already connected" or a dial error — verify below either way
  }
  for (let check = 0; check < 3; check++) {
    if (await isConnected(lnd, pubkey)) return true;
    await sleep(500);
  }
  return false;
}

/**
 * Make sure there's a live connection to the peer before funding a channel —
 * otherwise openChannel fails with RemotePeerDisconnected. Dials each given
 * socket in turn, then the addresses the graph knows, within one overall
 * budget. Before, one missing or stale socket meant "peer offline" at once,
 * even when the buyer listed another address or the graph had a working one.
 */
export async function ensureConnected(lnd: AuthenticatedLnd, pubkey: string, sockets: string[] = []): Promise<boolean> {
  if (await isConnected(lnd, pubkey)) return true;
  const deadline = Date.now() + CONNECT_BUDGET_MS;
  const tried = new Set<string>();
  const attempt = async (socket: string): Promise<boolean> => {
    if (!socket || tried.has(socket) || Date.now() >= deadline) return false;
    tried.add(socket);
    return dial(lnd, pubkey, socket);
  };
  for (const socket of sockets) if (await attempt(socket)) return true;
  for (const socket of await graphSockets(lnd, pubkey)) if (await attempt(socket)) return true;
  return false;
}

/** The error text of a peer that could not be connected (a pre-broadcast refusal). */
export const couldNotConnect = (pubkey: string): string =>
  `couldn't connect to ${pubkey.slice(0, 12)}… — the peer looks offline. Try again later.`;

/**
 * Connect to the peer (dialing each address given, then the graph's), and
 * report the failure the way an open would. Slow over Tor — up to about a
 * minute and a half — so callers that hold the on-chain mutex for the open
 * itself do this BEFORE taking it: a peer that doesn't answer must not hold
 * up anyone else's open (or a Magma accept's capital check).
 */
export async function connectForOpen(
  writeLnd: AuthenticatedLnd,
  params: Pick<OpenChannelParams, "pubkey" | "socket" | "sockets">,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sockets = [...(params.socket ? [params.socket] : []), ...(params.sockets ?? [])];
  return (await ensureConnected(writeLnd, params.pubkey, sockets)) ? { ok: true } : { ok: false, error: couldNotConnect(params.pubkey) };
}

/**
 * Open (fund) a channel to a peer that is connected — connectForOpen comes
 * first, outside any lock; openChannel otherwise fails with "not online". A
 * peer that dropped meanwhile makes LND refuse before funding, a refusal the
 * caller can retry. This spends real funds and is irreversible — callers must
 * gate it behind write access and explicit user confirmation.
 */
export async function fundChannel(writeLnd: AuthenticatedLnd, params: OpenChannelParams): Promise<OpenChannelResult> {
  const base = { ok: false, pubkey: params.pubkey, localTokens: params.localTokens };

  if (!Number.isFinite(params.localTokens) || params.localTokens < MIN_CHANNEL_SATS) {
    return { ...base, error: `channel size must be at least ${MIN_CHANNEL_SATS} sat` };
  }

  try {
    const res = await openChannel({
      lnd: writeLnd,
      partner_public_key: params.pubkey,
      local_tokens: params.localTokens,
      // No partner_socket: with one, the library dials the peer AGAIN before
      // opening (addPeer with its default ten retries, ~50 s) — a dial inside
      // the caller's on-chain mutex. connectForOpen has connected it already.
      ...(params.feeRate ? { chain_fee_tokens_per_vbyte: params.feeRate } : {}),
      ...(params.isPrivate ? { is_private: true } : {}),
    });
    return {
      ...base,
      ok: true,
      transactionId: res.transaction_id,
      transactionVout: res.transaction_vout,
    };
  } catch (err) {
    return { ...base, error: describe(err) };
  }
}

export interface CloseChannelResult {
  ok: boolean;
  transactionId?: string;
  error?: string;
}

/**
 * Close a channel by funding outpoint. Cooperative by default (needs the peer
 * online); force-close when the peer is unreachable. Real on-chain action.
 *
 * `feeRate` (sat/vByte) only applies to a cooperative close — a force-close
 * broadcasts the pre-signed commitment tx whose fee was fixed at open time.
 */
export async function closeChannelByOutpoint(
  writeLnd: AuthenticatedLnd,
  transactionId: string,
  transactionVout: number,
  isForce: boolean,
  feeRate?: number,
): Promise<CloseChannelResult> {
  try {
    const res = await closeChannel(
      isForce
        ? { lnd: writeLnd, transaction_id: transactionId, transaction_vout: transactionVout, is_force_close: true }
        : {
            lnd: writeLnd,
            transaction_id: transactionId,
            transaction_vout: transactionVout,
            ...(feeRate && feeRate > 0 ? { tokens_per_vbyte: Math.round(feeRate) } : {}),
          },
    );
    return { ok: true, transactionId: res.transaction_id };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}
