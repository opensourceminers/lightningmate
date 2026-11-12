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

/** One connection attempt may take this long (measured 2026-11-08 through a
 *  node's Tor proxy: an onion address answered after 4 s, a clearnet one after
 *  35 s, or not within 45 s). */
const CONNECT_ATTEMPT_MS = 45_000;
/** All addresses of one peer together get at most this long. */
const CONNECT_BUDGET_MS = 90_000;
/** How many times each address is tried within that budget. */
const CONNECT_ROUNDS = 2;
/** After a dial that went through, LND lists the peer once the two have
 *  exchanged their first messages: looked for this often, half a second apart. */
const CONNECT_LISTED_CHECKS = 20;
/** The library's own ListPeers, right after a dial that went through. */
const NOT_LISTED_YET = /FailedToSuccessfullyConnectToRemotePeer/;

/**
 * Dial one address and wait for the outcome, then verify the peer shows up as
 * connected. `is_temporary` is what makes it wait: without it the library
 * sends perm: true, and LND's ConnectPeer then answers at once and dials in
 * the background ("Otherwise, the call will be synchronous", lightning.proto).
 * Looking for the peer 1.5 s later found it only if it was already there:
 * a buyer behind a Tor circuit took longer, and every such Magma order was
 * turned down within seconds as "the buyer's node is unreachable" (order
 * cbebc117, 2026-10-31: rejected after 5.3 s of a two-hour window; reproduced
 * on regtest, server/e2e/dial.ts). A channel makes the connection persistent
 * once it is open.
 * @throws MissingPermission when LND won't list its peers to this client.
 */
async function dial(
  lnd: AuthenticatedLnd,
  pubkey: string,
  socket: string,
  timeoutMs: number,
  onDialError?: (socket: string, error: string) => void,
): Promise<boolean> {
  let failure: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // LND's own timeout doesn't bind a dial through its Tor proxy (regtest: an
    // answer after 100 s of a 45 s timeout), so the attempt ends here. Should
    // the dial still get through, the next look finds the peer connected.
    await Promise.race([
      addPeer({ lnd, public_key: pubkey, socket, is_temporary: true, retry_count: 1, timeout: timeoutMs }),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${Math.max(1, Math.round(timeoutMs / 1000))} s`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    // "already connected" answers success. The library's own ListPeers after
    // ConnectPeer refused (no peers:read) lands here too: isConnected below
    // says so.
    const text = errorText(err);
    if (!NOT_LISTED_YET.test(text)) failure = text.replace(/^503 UnexpectedErrorAddingPeer: /, "");
  } finally {
    clearTimeout(timer);
  }
  for (let check = failure === null ? CONNECT_LISTED_CHECKS : 1; check > 0; check--) {
    if (await isConnected(lnd, pubkey)) return true;
    if (check > 1) await sleep(500);
  }
  onDialError?.(socket, failure ?? "connected, but LND doesn't list the peer");
  return false;
}

/**
 * Make sure there's a live connection to the peer before funding a channel —
 * otherwise openChannel fails with RemotePeerDisconnected. Dials each given
 * socket in turn, then the addresses the graph knows, within one overall
 * budget (onDialError hears why each attempt failed; socket "": no address). Before, one missing or stale socket meant "peer offline" at once,
 * even when the buyer listed another address or the graph had a working one.
 *
 * @throws MissingPermission when LND won't list its peers to this client (no
 * peers:read): no connection can be checked, so none is dialed — this node's
 * setup to fix, not the peer's absence.
 */
export async function ensureConnected(
  lnd: AuthenticatedLnd,
  pubkey: string,
  sockets: string[] = [],
  onDialError?: (socket: string, error: string) => void,
  budgetMs = CONNECT_BUDGET_MS,
): Promise<boolean> {
  if (await isConnected(lnd, pubkey)) return true;
  const deadline = Date.now() + Math.min(budgetMs, CONNECT_BUDGET_MS);
  const addresses = dialOrder([...sockets, ...(await graphSockets(lnd, pubkey))]);
  if (addresses.length === 0) onDialError?.("", "no address of it is known");
  // Tor circuits fail at random, and LND gives a handshake only five seconds
  // once the circuit stands: a second try while the budget lasts. In the first
  // round each address gets its share of what is left: two that stay silent
  // used up the budget, and a live third was never dialed.
  for (let round = 0; round < CONNECT_ROUNDS; round++) {
    for (const [i, socket] of addresses.entries()) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      const share = round === 0 ? left / (addresses.length - i) : left;
      if (await dial(lnd, pubkey, socket, Math.min(CONNECT_ATTEMPT_MS, Math.ceil(share)), onDialError)) return true;
    }
  }
  return false;
}

/** The addresses to dial: each once, as LND takes them (host:port), onions
 *  first. They are the quick way through a Tor proxy (4 s against 35 s or more
 *  for a clearnet address, measured 2026-11-08), and cost little without one. */
function dialOrder(sockets: string[]): string[] {
  const hosts = [...new Set(sockets.map((s) => s.replace(/^[0-9a-f]{66}@/i, "")).filter(Boolean))];
  return [...hosts.filter((s) => /\.onion(:\d+)?$/i.test(s)), ...hosts.filter((s) => !/\.onion(:\d+)?$/i.test(s))];
}

/** The error text of a peer that could not be connected (a pre-broadcast refusal). */
export const couldNotConnect = (pubkey: string, why?: string | null): string =>
  `couldn't connect to ${pubkey.slice(0, 12)}… — the peer looks offline. Try again later.${why ? ` (${why})` : ""}`;

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
  const dialErrors: string[] = [];
  try {
    return (await ensureConnected(writeLnd, params.pubkey, sockets, (socket, error) => void (socket && dialErrors.push(`${socket}: ${error}`))))
      ? { ok: true }
      : { ok: false, error: couldNotConnect(params.pubkey, dialErrors.join("; ")) };
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
  /** Not closed yet, but not failed either: LND goes on with the close. */
  stillClosing?: boolean;
}

/**
 * Close a channel by funding outpoint. Cooperative by default (needs the peer
 * online); force-close when the peer is unreachable. Real on-chain action.
 *
 * `feeRate` (sat/vByte) only applies to a cooperative close — a force-close
 * broadcasts the pre-signed commitment tx whose fee was fixed at open time.
 */
/** LND's words when the peer holds out for more than a cooperative close may
 *  pay (three times the rate asked for, unless told otherwise). */
const CLOSE_FEE_REFUSED = /fee proposal exceeds max fee/i;
/** Before, this read "Close failed" while the channel went on to close, and
 *  someone believing it might force-close a channel already on its way. */
export const CLOSE_FEE_REFUSED_TEXT =
  "The peer wants more than three times the fee you chose, so this round ended without a closing transaction. The channel is shutting down all the same: LND normally finishes the close with the peer at its own fee estimate, usually within minutes. Wait for it. If it still hasn't closed after a few hours, a force-close remains possible.";
/** The same for a close that named its maximum (the lease-end close of a sold
 *  channel, MagmaDesk.closeFinishedLeases). Before, that case was a plain
 *  failure: nothing said the shutdown was out, and the close was asked again
 *  on every run — of a channel already closing, possibly at more than the
 *  maximum it was asked with (review 2026-11-10, CHAN-5). */
export const closeFeeRefusedAtMaxText = (maxFeeRate: number): string =>
  `The peer wants more than the ${Math.round(maxFeeRate)} sat/vB maximum, so this round ended without a closing transaction. ` +
  "The channel is shutting down all the same: LND normally finishes the close with the peer at its own fee estimate — which can be above that maximum.";

/** The same for a close by hand with its maximum (review 2026-11-10, CHAN-2):
 *  what LND does next, and what to do. */
export const manualCloseRefusedText = (maxRate: number): string =>
  `The peer wants more than ${Math.round(maxRate)} sat/vB, the most this close may pay, so this round ended without a closing transaction. ` +
  "The channel is shutting down all the same: LND normally finishes the close with the peer at its own fee estimate — which can be above that rate — usually within minutes. " +
  "Wait for it. If it still hasn't closed after a few hours, a force-close remains possible.";

export async function closeChannelByOutpoint(
  writeLnd: AuthenticatedLnd,
  transactionId: string,
  transactionVout: number,
  isForce: boolean,
  feeRate?: number,
  /** The most a cooperative close may pay (sat/vB): LND otherwise negotiates up
   *  to three times `feeRate`. */
  maxFeeRate?: number,
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
            ...(maxFeeRate && maxFeeRate > 0 ? { max_tokens_per_vbyte: Math.round(maxFeeRate) } : {}),
          },
    );
    return { ok: true, transactionId: res.transaction_id };
  } catch (err) {
    const error = describe(err);
    // The shutdown is out: LND goes on with the peer, this was only the
    // first round of haggling over the fee (seen on regtest with LND 0.21).
    return !isForce && CLOSE_FEE_REFUSED.test(error)
      ? { ok: false, stillClosing: true, error: maxFeeRate && maxFeeRate > 0 ? closeFeeRefusedAtMaxText(maxFeeRate) : CLOSE_FEE_REFUSED_TEXT }
      : { ok: false, error };
  }
}
