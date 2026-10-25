import { addPeer, closeChannel, getNode, getPeers, openChannel, type AuthenticatedLnd, type GetPeersResult } from "lightning";
import { errorText } from "./errorText.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * LND refused the call for want of a permission on the macaroon: its
 * macaroon check answers "permission denied" before the call runs — so
 * nothing was done, and no retry helps until the macaroon does.
 */
export const isPermissionDenied = (error: unknown): boolean =>
  /permission denied/i.test(typeof error === "string" ? error : errorText(error));

/**
 * Why no channel can be opened when LND won't list its peers to the write
 * macaroon (no `peers:read`, which SECURITY.md's least-privilege recipe left
 * out before): every open checks its connection to the peer with LND's
 * ListPeers — LightningMate's own check, and the lightning library's addPeer
 * after it dials. This node's setup, never a peer that is away.
 */
export const PEERS_READ_MISSING =
  "the write macaroon lacks peers:read — LND refused to list its peers to it, and every channel open checks its connection to the peer that way; " +
  "add peers:read to the macaroon (SECURITY.md) and restart LightningMate";

/** LND refused a check the write client must make, for want of a permission
 *  on its macaroon (`permission`, in LND's words). The message says what
 *  is blocked and what to do. */
export class MissingPermission extends Error {
  constructor(
    readonly permission: string,
    message: string,
  ) {
    super(message);
    this.name = "MissingPermission";
  }
}

/** Clients LND has refused to list its peers to (no peers:read) — until a
 *  listing goes through again. So the areas that open channels can say they
 *  are blocked, not only the open that ran into it. Per client object: one
 *  LND connection's verdict is never another's. */
const peersReadRefused = new WeakSet<AuthenticatedLnd>();

/** Why this (write) client can open no channel right now — LND refused it
 *  the peer listing every open needs — or null. */
export function opensBlocked(lnd: AuthenticatedLnd | undefined): string | null {
  return lnd && peersReadRefused.has(lnd) ? PEERS_READ_MISSING : null;
}

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
  /** The routing fee the channel starts with (ppm, and base msat): without
   *  one it takes LND's configured default (stock LND: 1 sat + 1 ppm) until
   *  something sets a fee — forever, with fee automation off. Ignored by
   *  LND before 0.16. */
  routingFeePpm?: number;
  routingBaseFeeMsat?: number;
  /** Kept by LND with the channel (its memo, LND ≥ 0.17; older versions
   *  ignore it): a sale's open names its order (capital.ts saleTag). */
  description?: string;
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
 * (no connection, a size below LND's floor), LND refusing the macaroon the
 * call ("permission denied": its check runs before the call does), and LND
 * or the peer saying no during the negotiation (peer offline, too many
 * pending channels, a size the peer won't take, a wallet that can't fund it,
 * LND's anchor reserve).
 *
 * Anything else — a dropped gRPC stream, a timeout, an error we don't know —
 * may have come AFTER LND broadcast the funding transaction. Such an open is
 * not "failed": its caller keeps the "opening" record and looks for the
 * channel in LND before opening again or releasing the buyer's payment
 * (otherwise: a second channel, or a refunded buyer with a free channel).
 *
 * A peer's own error ("received funding error from <peer>: …", whatever it
 * says) and LND giving up on the peer's answer ("reservation timed out") are
 * negotiation too: LND passes a peer's error on only while the channel is
 * still being negotiated, and publishes the funding only after the peer has
 * signed it — after that the open answers with the pending channel. (Review
 * 2026-10-25: seven of nine common refusals — "channel rejected", "Funding
 * amount too small", "invalid funding_amount", "channel too large" … — read
 * as "may have opened a channel": the run stopped, the next peer wasn't
 * tried, and the day's cooldown started for nothing.)
 */
const PRE_BROADCAST_REFUSAL =
  /couldn't connect|channel size must be|PeerIsNotOnline|is not online|RemotePeerDisconnected|disconnected$|RemotePeerExited|peer exiting|RemoteNodeDoesNotSupportMultipleChannels|multiple channels unsupported|PeerPendingChannelsExceedMaximumAllowable|pending channels exceed|InsufficientFundsToCreateChannel|not enough witness outputs|insufficient funds|reserved wallet balance invalidated|ChainUnsupported|CannotOpenChannelToOwnNode|WalletNotFullySynced|RemoteNodeSyncing|MaxChannelDescriptionLengthExceeded|ExpectedLargerChannelSizeForChannelOpen|rejected the channel|chan size of .* is (below|above)|chan size of .* exceeds max|permission denied|received funding error from|reservation timed out/i;

export function isPreBroadcastRefusal(error: string): boolean {
  return PRE_BROADCAST_REFUSAL.test(error);
}

/**
 * A refusal that comes from THIS node, not the peer — what it names, or null
 * for anything else (review of P4: the channel autopilot booked these against
 * the peers it was trying, backed each one off for a day, then a week, and
 * wrote a failed run for each; one unsynced wallet used up the whole
 * suggestion list). LND's wallet not synced to the chain yet, a wallet that
 * can't fund the open ("not enough witness outputs": too few confirmed
 * coins), an open that would dip into the coins LND keeps for anchor
 * channels, a chain LND doesn't run, or the "peer" being this node itself.
 *
 * Both forms count: the library's code for the errors it knows
 * (WalletNotFullySynced, InsufficientFundsToCreateChannel, ChainUnsupported,
 * CannotOpenChannelToOwnNode) and LND's own text for the ones it passes on.
 * A peer's error arrives as "received funding error from <peer>: …" — that is
 * the peer's, whatever it says. And LND refusing the write macaroon the open
 * ("permission denied", answered before the call runs) is this node's setup:
 * no peer has seen the open, and no funding exists (PRE_BROADCAST_REFUSAL).
 */
export function nodeSideRefusal(error: string): string | null {
  if (/received funding error from/i.test(error)) return null;
  if (isPermissionDenied(error)) {
    return "the write macaroon may not open channels (LND: permission denied — an open needs onchain:write and offchain:write, see SECURITY.md)";
  }
  if (/WalletNotFullySynced|wallet is fully synced/i.test(error)) return "LND's wallet isn't fully synced to the chain yet";
  // Before "insufficient funds": LND's text for it says that too.
  if (/reserved wallet balance invalidated/i.test(error)) return "the open would dip into the coins LND keeps for closing anchor channels";
  if (/InsufficientFundsToCreateChannel|not enough witness outputs|insufficient funds/i.test(error)) {
    return "LND's wallet can't fund it (not enough confirmed coins)";
  }
  if (/ChainUnsupported|unknown chain/i.test(error)) return "LND doesn't run this chain";
  if (/CannotOpenChannelToOwnNode|channel to self/i.test(error)) return "that is this node itself";
  return null;
}

/** The peer couldn't be reached, or dropped while the open was negotiated —
 *  its doing, unless this node is reachable by nobody at all right now (the
 *  caller checks that before blaming the peer). */
export const isUnreachable = (error: string): boolean =>
  /couldn't connect|PeerIsNotOnline|is not online|RemotePeerDisconnected|disconnected$|RemotePeerExited|peer exiting/i.test(error);

/** An amount in LND's error text: btcutil.Amount prints "0.02 BTC"; other
 *  wordings say "2000000 sat". A bare number with a decimal point is BTC. */
function amountSats(value: string, unit: string | undefined): number | null {
  const n = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const btc = unit ? /^btc$/i.test(unit) : value.includes(".");
  return Math.round(btc ? n * 100_000_000 : n);
}

/** The smallest channel the peer said it takes, from its refusal — LND's
 *  ErrChanTooSmall: "chan size of 0.01 BTC is below min chan size of 0.02 BTC"
 *  (the reliable source: a peer's LN+ setting is only what it declares). */
export function peerMinChannelFromError(error: string): number | null {
  const m = /below min(?:imum)?\s+chan(?:nel)?\s+size\s+of\s+([\d.,]+)\s*(BTC|sats?)?/i.exec(error);
  return m ? amountSats(m[1], m[2]) : null;
}

/** The largest channel the peer said it takes — LND's ErrChanTooLarge:
 *  "chan size of 0.2 BTC exceeds maximum chan size of 0.16777215 BTC". */
export function peerMaxChannelFromError(error: string): number | null {
  const m = /(?:exceeds|above)\s+max(?:imum)?\s+chan(?:nel)?\s+size\s+of\s+([\d.,]+)\s*(BTC|sats?)?/i.exec(error);
  return m ? amountSats(m[1], m[2]) : null;
}

/** LND refused because the peer already has as many pending channels as it
 *  accepts (LND's default is one) — gone once the earlier one confirms. */
export const isPendingChannelsLimit = (error: string): boolean =>
  /PeerPendingChannelsExceedMaximumAllowable|pending channels exceed/i.test(error);

/**
 * The peers LND is connected to, as this client may see them — null when LND
 * didn't answer. LND refusing the listing for want of peers:read throws
 * MissingPermission (and is remembered for the client, opensBlocked): before,
 * it read as "not connected", so every open said the peer looked offline and
 * every Magma order was turned down as "the buyer's node is unreachable".
 */
async function connectedKeys(lnd: AuthenticatedLnd): Promise<Set<string> | null> {
  let listed: GetPeersResult;
  try {
    listed = await getPeers({ lnd });
  } catch (err) {
    if (!isPermissionDenied(err)) return null;
    peersReadRefused.add(lnd);
    throw new MissingPermission("peers:read", PEERS_READ_MISSING);
  }
  peersReadRefused.delete(lnd);
  return new Set(listed.peers.map((p) => p.public_key));
}

/** @throws MissingPermission when LND won't list its peers to this client. */
async function isConnected(lnd: AuthenticatedLnd, pubkey: string): Promise<boolean> {
  return (await connectedKeys(lnd))?.has(pubkey) ?? false;
}

/**
 * Ask LND once whether it lists its peers to this (write) client — at start,
 * so a macaroon without peers:read shows the channel and Magma areas as
 * blocked before an open or an order runs into it. Never throws.
 */
export async function checkPeerListing(lnd: AuthenticatedLnd): Promise<void> {
  try {
    await connectedKeys(lnd);
  } catch {
    // MissingPermission: remembered (opensBlocked)
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
 * @throws MissingPermission when LND won't list its peers to this client.
 */
async function dial(lnd: AuthenticatedLnd, pubkey: string, socket: string): Promise<boolean> {
  try {
    await addPeer({ lnd, public_key: pubkey, socket, retry_count: 1, retry_delay: 1_000, timeout: CONNECT_ATTEMPT_MS });
  } catch {
    // "already connected", a dial error — or the library's own ListPeers
    // after ConnectPeer refused (no peers:read) — verify below either way
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
 *
 * @throws MissingPermission when LND won't list its peers to this client (no
 * peers:read): no connection can be checked, so none is dialed — this node's
 * setup to fix, not the peer's absence.
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

/** A peer connection for an open: made — or not, and then why, in words an
 *  open's failure can carry. `blocked`: not the peer's doing but this node's
 *  setup (the write macaroon lacks a permission every open needs) — no other
 *  peer would fare better until the operator fixes it. */
export type PeerConnection = { ok: true } | { ok: false; error: string; blocked?: true };

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
): Promise<PeerConnection> {
  const sockets = [...(params.socket ? [params.socket] : []), ...(params.sockets ?? [])];
  try {
    return (await ensureConnected(writeLnd, params.pubkey, sockets)) ? { ok: true } : { ok: false, error: couldNotConnect(params.pubkey) };
  } catch (err) {
    if (err instanceof MissingPermission) return { ok: false, error: err.message, blocked: true };
    throw err;
  }
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
      ...(params.routingFeePpm !== undefined ? { fee_rate: params.routingFeePpm } : {}),
      // A string: "0" is a base fee of zero (the library tests it for
      // presence, and "0" is set).
      ...(params.routingBaseFeeMsat !== undefined ? { base_fee_mtokens: String(params.routingBaseFeeMsat) } : {}),
      ...(params.description ? { description: params.description } : {}),
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
