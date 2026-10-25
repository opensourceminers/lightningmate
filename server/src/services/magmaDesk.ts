import { getChannels, getWalletInfo, type AuthenticatedLnd, type GetChannelsResult } from "lightning";
import { JsonStore, recordStoreIncident } from "../store.js";
import {
  AmbossError,
  ORDER_FAILED,
  ORDER_SUCCEEDED,
  isAmbossOutage,
  isAuthError,
  isNotFoundAnswer,
  isQueryRejected,
  isRateLimited,
} from "./amboss.js";
import {
  FUNDING_REPORTED_STATUSES,
  LEASE_RUNNING_STATUSES,
  acceptSale,
  addSaleTransaction,
  getSale,
  listSales,
  msatOf,
  rejectSale,
  type SaleOrder,
  type SaleOrderDetail,
  type SalesFilter,
} from "./magmaApi.js";
import { MagmaJournal, TERMINAL_PHASES, type MagmaJournalEntry, type MagmaPhase, type RefusalKind } from "./magmaJournal.js";
import {
  HODL_CANCEL_MARGIN_BLOCKS,
  cancelHodl,
  createHodl,
  findInvoicesByDescription,
  hodlStatus,
  newHodlSecret,
  settleHodl,
  type CreateHodlParams,
  type FoundInvoice,
  type HodlStatus,
} from "./hodl.js";
import { channelsWith, findOpenedChannel, saleTag, spendableOnchain, type CapitalLedger } from "./capital.js";
import {
  MissingPermission,
  closeChannelByOutpoint,
  couldNotConnect,
  ensureConnected,
  fundChannel,
  isPendingChannelsLimit,
  isPreBroadcastRefusal,
  type OpenChannelParams,
} from "./channelOps.js";
import type { AmbossStore } from "./ambossStore.js";
import type { EarningsLog } from "./earningsLog.js";
import type { ServiceFeeLedger } from "./serviceFee.js";
import { errorText } from "./errorText.js";
import { getOwnPubkey } from "./node.js";
import type { SoldLease } from "./leaseCaps.js";
import { standardChannelId } from "./leases.js";
import { orderFeeSat } from "./magmaRecommend.js";

/**
 * Magma selling, end to end, on the Magma API — the "order desk".
 *
 * The order LANE (tick, every 45 s from the autopilot) asks Amboss which sales
 * need us (`sales(action_needed: true)`) and walks every order this node has
 * taken on through its journal (magmaJournal.ts):
 *
 *   accept    with a HODL invoice for `fees.seller`, expiring in 49 h; the
 *             preimage is saved before the invoice exists (D2)
 *   held      the buyer's payment is held by that invoice (checked in LND)
 *   open      the channel, under the shared on-chain mutex; "opening" is saved
 *             before the open and the funding outpoint right after (D3)
 *   report    the outpoint to Amboss (add_transaction), retried until Amboss
 *             has it — never a second open
 *   settle    only when Amboss says VALID_CHANNEL_OPENING (or later); then the
 *             sale is booked and its service fee enqueued, once
 *   cancel    the HODL invoice on any failure, so the buyer gets the payment
 *             back automatically — and before the held HTLC would expire
 *   reject    orders this node cannot serve, right away (D6), instead of
 *             letting them time out
 *
 * The lane holds no lock shared with the 30-minute autopilot run: a slow
 * rebalance payment or a slow Amboss call in the main run cannot delay it.
 * What it shares with every other on-chain commitment (LSPS1 opens, routing
 * opens, manual opens) is the capital ledger and its mutex (capital.ts).
 *
 * When Amboss can't be asked — no key, a key Amboss refuses, Amboss down —
 * the lane still does what needs only LND (maintainFromLnd): a held payment
 * is released before its HTLC expires, and an invoice that can no longer be
 * paid ends its order's capital reservation. Nothing waits for the key.
 *
 * Manual actions from the Orders tab (accept, open, reject) go through the
 * same journal, the same per-order serialisation and the same mutex, so a
 * click can never race the lane into a second channel. And a decision made
 * by a click that finds the order — Amboss shows it as this node's, awaiting
 * approval, or the lane has it on record as awaiting approval (unreadClick) —
 * wins over the lane (byHand): a reject Amboss hasn't confirmed is sent again
 * on every pass until it is or the order ends, and an order whose accept by
 * hand didn't go through is left to the operator — the lane never accepts or
 * rejects an order the operator is deciding. That holds for an order the lane
 * isn't working on when the click comes. The click waits for the order's turn
 * (withOrder): a step the lane has begun on it — its capital check, its dial
 * of the buyer (up to ~90 s over Tor), its own accept or reject, the resend
 * of the operator's earlier reject — finishes first, and a click that then
 * finds the order accepted or rejected says so, changing nothing: done, if
 * that is what it asked for; refused, if it asked for the other (README,
 * SECURITY.md; magmaByHand.test.ts pins it). Nor does a click take back an
 * accept already sent whose answer was lost ("accepting"), the lane's or the
 * operator's: an accept that may have reached Amboss is completed first, and
 * a Reject meanwhile is refused, saying why.
 */

/** Amboss: the HODL invoice "must expire in at least 48 hours". */
export const HODL_EXPIRY_MS = 49 * 3_600_000;
/** An invoice is re-used for a repeated accept only while it still has this
 *  much life left (Amboss checks the 48 h at accept time). */
const MIN_INVOICE_LIFE_MS = 48 * 3_600_000 + 5 * 60_000;
/** Blocks a paid HTLC may stay held: room for the open, its confirmations
 *  and Amboss's check (~2 days), well inside a sender's 2016-block limit. */
export const HODL_CLTV_DELTA = 288;
/** Release a held payment this many blocks before its HTLC would expire
 *  (LND itself cancels at 12; we do it earlier, and on the record) — the
 *  margin LSPS1 keeps too (hodl.ts). */
export const CANCEL_MARGIN_BLOCKS = HODL_CANCEL_MARGIN_BLOCKS;
/** An open needs the held payment to outlive the cancel margin by the time
 *  the channel takes to confirm and Amboss to validate it (~6 h). With only
 *  the cancel margin, an open at 25 blocks left was followed one block later
 *  by the release of the buyer's payment: a channel delivered for nothing. */
export const OPEN_MIN_BLOCKS_LEFT = CANCEL_MARGIN_BLOCKS + 36;
/** After a crash mid-open (or an open whose outcome LND left unclear): how
 *  long LND gets to show the channel before we conclude it never happened. */
export const OPENING_GRACE_MS = 10 * 60_000;
/** Passes in a row in which Amboss may refuse to show an order (with the key
 *  itself fine), or answer that it has no such order — each time while its
 *  own listing of the orders waiting on us leaves the order out — before an
 *  order with nothing of ours tied to it is dropped. */
const MAX_REFUSALS = 3;
/** How the note of a failed read of an order starts (unreadable,
 *  couldNotRead) — and that of a key Amboss refused while the lane worked on
 *  the order (advance). Each is stale once Amboss shows the order again, and
 *  goes then (advance). Any other error stays: it is about a step — an accept
 *  Amboss refused, an open LND left unclear — not about reading the order. */
const READ_FAILED = /^(could not read the order from Amboss|Amboss refused to show this order|Amboss refused the key)/;
/** Without Amboss, an order paid outside a HODL invoice (accepted before the
 *  journal) keeps its reservation until its open deadline, or this long. */
const LEGACY_HOLD_MS = 48 * 3_600_000;
/** A transient open failure (peer offline, coins not yet confirmed) is
 *  retried on later passes while the channel-open deadline is this far away. */
const OPEN_RETRY_MIN_TIME_LEFT_MS = 10 * 60_000;
/** …or, when Amboss gives no deadline, for this long after the payment. */
const OPEN_RETRY_WINDOW_MS = 30 * 60_000;
const MAX_ACCEPT_ATTEMPTS = 3;
/** Reject (rather than wait) once the approval deadline is this close. */
const REJECT_MARGIN_MS = 2 * 60_000;
/** An order Amboss reports no fee for is looked at once more this long after
 *  it was placed before it is turned down (a fee filled in right after the
 *  match is not missed). It does not stay 0 "until settled": the order of
 *  2026-10-23 read 0 in every fee part from its first read to its end. */
const ZERO_FEE_GRACE_MS = 60_000;
/** An invoice billed from an order's fee parts (fees.seller read 0) must be
 *  an offer's price for the order's size to within this many sats. */
const PARTS_MATCH_SATS = 1;
/** Slack when the block an order was placed in is estimated from its time at
 *  10 minutes a block: a few blocks, plus a tenth of the blocks since — blocks
 *  come faster than that while the hashrate grows, and a day can run 10+
 *  blocks ahead of 144 (as leases.ts allows for purchases). */
const ORDER_HEIGHT_SLACK_BLOCKS = 6;
const ORDER_HEIGHT_SLACK_SHARE = 0.1;
/** An order the lane was deciding when selling was switched off (or all
 *  automation paused): nothing was promised — it is the operator's now. */
export const SELLING_OFF_SKIP =
  "Liquidity provision was switched off before it was accepted — nothing was promised; accept or reject it on Market → Orders";
/** An order the operator took into their own hands whose accept didn't go
 *  through: nothing was promised, and it is theirs to decide — the lane
 *  neither accepts nor rejects it (byHand). */
export const MANUAL_ACCEPT_SKIP =
  "your accept didn't go through — nothing was promised; accept or reject it on Market → Orders";
/** The reasons on record for the operator's own decisions. */
const ACCEPTED_BY_YOU = "accepted by you";
const REJECTED_BY_YOU = "rejected by you";
/** What a click's reject that didn't go through is told — Amboss didn't
 *  confirm it, or the click couldn't read an order the lane has on record
 *  (unreadClick). The resends stop once Amboss confirms it or the order ends
 *  (advance, couldNotRead) — the click is told both (review of P9, final
 *  round: it said only the first). */
const REJECT_STANDS = "Your reject stands: the order lane sends it again until Amboss confirms it or the order ends, and won't accept this order.";
/** A click asking for what the order already is — accepted here, or
 *  rejected — is told so: done, not refused. Review of P9, final round: a
 *  Reject clicked while the lane sent the operator's own reject again was
 *  refused ("Order is SELLER_REJECTED — only orders awaiting approval can be
 *  rejected."), and an Accept clicked while the lane accepted that order
 *  ("Order is WAITING_FOR_BUYER_PAYMENT, not awaiting approval."), each order
 *  ending as the click asked. */
const ALREADY_ACCEPTED = "Order is already accepted.";
const ALREADY_REJECTED = "Order is already rejected.";
/** Why a Reject can't turn down an order with an accept of ours under way
 *  ("accepting") — the lane's or the operator's. Sent, its answer lost: it
 *  may have reached Amboss, and is completed (resumeAccept), though Amboss
 *  may still show the order awaiting approval. Cut short by a stop before it
 *  was sent: the lane's next pass completes it — or withdraws one of its own
 *  with selling off. (Review of P9, final round: "Order is already accepting
 *  here.") */
export const NOT_REJECTED_ACCEPT_SENT =
  "Not rejected: the earlier accept of this order was already sent and is being confirmed with Amboss, so it can't be withdrawn.";
const NOT_REJECTED_ACCEPT_UNSENT =
  "Not rejected: an accept of this order was under way when LightningMate stopped — the order lane completes or withdraws it on its next pass.";
/** A click's answer, a second sentence added: the first one's own closing
 *  period (Amboss's "Unexpected error.", say) isn't doubled. */
const thenSay = (first: string, second: string): string => `${first.replace(/\.+$/, "")}. ${second}`;
/** An order with nothing of ours tied to it that Amboss neither lists nor
 *  shows any more ends here this long after its approval deadline (Amboss has
 *  ended it by then; the slack covers clocks that differ). */
const SEEN_GRACE_MS = 10 * 60_000;
/** …or, with no approval deadline on record, this long after it was first
 *  recorded — far beyond any approval window Amboss gives. */
const SEEN_MAX_AGE_MS = 24 * 3_600_000;
/** A successful report Amboss still hasn't acted on is re-sent after this. */
const REPORT_RESEND_MS = 10 * 60_000;
/** The deployed-capital listing is re-read at most this often. */
const DEPLOYED_TTL_MS = 30_000;
/** A listing of sold capital that fails: the last good one stands for this
 *  long (with this journal's own sales since), so an order the wallet can fund
 *  is still decided (review 2026-10-25: it was rejected at its deadline). */
const DEPLOYED_FALLBACK_MS = 60 * 60_000;
/** The last listing of this node's sales with a running lease (the lease
 *  registry's fallback for sales the journal never recorded) is trusted this
 *  long; the close list and a close ask Amboss again after it. */
export const AMBOSS_LEASES_MAX_AGE_MS = 3_600_000;
/** How long the close list or a close waits for that listing — then it goes
 *  on with the last one known (kept on disk). */
const AMBOSS_LEASES_WAIT_MS = 5_000;
/** A listing that failed is not asked for again before this. */
const AMBOSS_LEASES_RETRY_MS = 5 * 60_000;

/** A sale of this node that Amboss lists with a running lease, and its channel. */
export interface AmbossRunningLease {
  orderId: string;
  channelId: string;
}

/** magma-amboss-leases.json: the last such listing, and when it was made. */
interface AmbossLeasesFile {
  at: string | null;
  leases: AmbossRunningLease[];
}

export type SellActionKind =
  | "accept"
  | "reject"
  | "open"
  | "report"
  | "settle"
  | "cancel"
  | "close"
  | "skip"
  | "relist"
  | "reprice"
  | "resize"
  /** The offer's standard terms set: the lease buyers use, the routing-fee promise. */
  | "terms"
  | "enable"
  | "disable"
  | "create"
  | "error";

/** One Magma action as the run history shows it. */
export interface MagmaSellAction {
  orderId: string;
  action: SellActionKind;
  sizeSats: number;
  ok: boolean;
  transactionId?: string;
  error?: string;
  /** "manual": an accept or reject that carries out a decision the operator
   *  made by hand (byHand) — their reject sent again, their accept completed
   *  — not one of the lane's own. Absent: the lane's or the offer upkeep's
   *  own (on older runs too). */
  via?: "manual";
}

export interface MagmaDeskConfig {
  sellEnabled: boolean;
  sellMaxChannelSats: number;
  sellMaxDeploySats: number;
  sellReserveSats: number;
}

export interface MagmaDeskDeps {
  dataDir: string;
  readLnd: AuthenticatedLnd;
  writeLnd: AuthenticatedLnd | undefined;
  amboss: AmbossStore;
  capital: CapitalLedger;
  earnings: EarningsLog;
  serviceFees: ServiceFeeLedger;
  config: () => MagmaDeskConfig;
  /** The smallest fee the lane accepts an order for: what opening and closing
   *  its channel costs on chain now, after the service fee
   *  (Autopilot.saleFeeFloorSats). Without it, no floor beyond "not 0". */
  saleFloorSats?: () => Promise<number>;
  /** For the close of a finished lease's channel (closeFinishedLeases): the
   *  economy fee rate a close pays now (null: no estimate) and the
   *  operator's maximum on-chain fee rate (sat/vB), and whether a channel
   *  routes well enough to keep (Autopilot.soldChannelClose). Without it,
   *  no such channel is closed: never at any rate. */
  soldChannelClose?: () => Promise<{ feeRate: number | null; maxFeeRate: number; routesWell: (channelId: string) => boolean }>;
  /** The prices this node's offers ask, or asked lately
   *  (Autopilot.knownOfferPrices): an invoice billed from an order's fee
   *  parts — fees.seller read 0 — must be one of them for the order's size.
   *  Without it, the lane bills no such order. */
  offerPrices?: () => Array<{ feeRatePpm: number; baseFeeSats: number }>;
  /** The routing fee a new channel starts with (Autopilot.initialRoutingFee):
   *  a sold channel's too, within what its lease promised. Without it, LND's
   *  own default. */
  initialRoutingFee?: () => { feeRatePpm: number; baseFeeMsat: number };
}

/** A finished lease's channel with less than this share of its capacity on
 *  our side is kept: what is left is inbound worth keeping, and closing it
 *  frees little (review 2026-10-25: 20k of 2M closed, 1.98M of inbound given
 *  up). */
export const SOLD_CLOSE_MIN_LOCAL_SHARE = 0.25;

/** The open channel at a funding outpoint ("txid:vout"); with no vout, the
 *  one channel of that funding transaction — none when it funds several
 *  (two channels can share one transaction: which one isn't known). */
export function channelAtOutpoint<T extends { transaction_id: string; transaction_vout: number }>(open: readonly T[], outpoint: string): T | undefined {
  const [txid, vout] = outpoint.split(":");
  if (vout !== undefined && vout !== "" && Number.isInteger(Number(vout))) {
    return open.find((c) => c.transaction_id === txid && c.transaction_vout === Number(vout));
  }
  const same = open.filter((c) => c.transaction_id === txid);
  return same.length === 1 ? same[0] : undefined;
}

/** Outcome of a manual action, for the API route. */
export interface DeskResult {
  ok: boolean;
  /** Why it did not go through — the route maps it to an HTTP status. */
  code?:
    | "no_key"
    | "read_only"
    | "shutting_down"
    | "amboss"
    /** LND did not answer (nothing was changed). */
    | "node"
    /** LND refused the write macaroon a call this needs (nothing was
     *  changed): the operator's to fix — the message names the permission. */
    | "permission"
    | "bad_status"
    | "capital"
    | "unreachable"
    | "not_held"
    | "journal"
    | "open_failed"
    /** An accept by hand that pays less than its channel costs on chain now:
     *  sent again with `belowCost: true` only after the operator said yes. */
    | "below_cost";
  message: string;
  /** With "below_cost": what the order pays, and the accept floor — what
   *  opening and closing its channel costs on chain now, after the service
   *  fee (sat). */
  feeSats?: number;
  floorSats?: number;
  phase?: MagmaPhase;
  outpoint?: string;
  transactionId?: string;
  /** For an opened channel: has Amboss taken the funding transaction yet?
   *  (If not, the order lane keeps reporting it — it is never reopened.) */
  reported?: boolean;
  /** An accepted order: does the lane open its channel once the buyer has
   *  paid (opensItself), or must the operator click "Open channel"? */
  opensItself?: boolean;
}

/** What this node knows about an order — merged into the Orders view. */
export interface MagmaOrderLocal {
  phase: MagmaPhase;
  via: MagmaJournalEntry["via"];
  updatedAt: string;
  fundingOutpoint: string | null;
  reason: string | null;
  decision: MagmaJournalEntry["decision"] | null;
  lastError: string | null;
  /** For a settled order: was it booked as a sale (a payment of ours held or
   *  settled it)? null until it settles. */
  booked: boolean | null;
  /** Ended here without LightningMate taking it on (see the journal). */
  external: MagmaJournalEntry["external"] | null;
  /** What our hold invoice bills — what the order earns (null: none yet). */
  invoiceSats?: number | null;
}

export type { RefusalKind } from "./magmaJournal.js";

/** An order the lane turned down, for the alert and the Overview digest. */
export interface MagmaRefusal {
  orderId: string;
  sizeSats: number;
  reason: string;
  /** What it was refused for: only "cap" and "capital" refusals are helped
   *  by raising the caps or funding the wallet. */
  kind: RefusalKind;
  at: string;
}

/** Why the caps or the wallet can't take an order (capitalFor). */
interface Lacking {
  kind: "cap" | "capital";
  reason: string;
}

/** The kind of a refusal recorded before the kind was kept — from the words
 *  capitalFor uses (a refusal of the last two days still raises its alert). */
export function refusalKindOf(reason: string): RefusalKind {
  if (/^(above your max channel size|deploy cap reached)/.test(reason)) return "cap";
  if (/^not enough on-chain capital/.test(reason)) return "capital";
  return "other";
}

export interface LaneStatus {
  lastTickAt: string | null;
  /** null: the last pass had nothing to do (see `idle`). */
  ok: boolean | null;
  error: string | null;
  /** Whether the lane's next pass may clear `error` by itself (an outage, a
   *  refused read). False when it can't: Amboss rejects LightningMate's
   *  request as such (only an update of LightningMate fixes that), or there
   *  is no key to ask with. */
  retrying: boolean;
  /** Why the last pass had nothing to do, when it hadn't. */
  idle: string | null;
  running: boolean;
  openOrders: number;
}

/** Readable for LND's array errors too (they used to reach an order's reason
 *  as "503,UnexpectedErrorWhenGettingChainBalance,[object Object]"). */
const msg = errorText;
/** The memo of every invoice this app made for an order — 0.7.x's plain ones
 *  and the HODL ones since. With the order's record lost, it is how LND tells
 *  what was paid for it. */
export const orderMemo = (orderId: string): string => `Magma order ${orderId}`;
const now = (): string => new Date().toISOString();
const feeSatsOf = (e: MagmaJournalEntry): number => Number(BigInt(e.feeMsat || "0") / 1000n);
/** Phases with a funding outpoint on record: never opened again. */
const FUNDED: ReadonlySet<MagmaPhase> = new Set(["funded", "reported", "settled"]);
/** Phases in which the buyer's payment may be held by our invoice. */
const HOLDING: ReadonlySet<MagmaPhase> = new Set(["held", "opening", "funded", "reported"]);
/** The phase as it is NOW (after awaited steps that may have moved it). */
const phaseOf = (e: MagmaJournalEntry): MagmaPhase => e.phase;
/** A reject the operator clicked that Amboss hasn't confirmed (its call
 *  failed, or Amboss refused it): the order is still "seen" and theirs, and
 *  their decision stands — the lane sends the reject again on every pass
 *  until Amboss confirms it or the order ends (advance, couldNotRead). */
const rejectByHand = (e: MagmaJournalEntry): boolean => e.phase === "seen" && e.via === "manual" && e.decision?.action === "reject";
/** An accept or reject of an order the operator took into their own hands
 *  (byHand) carries out their decision — the lane decides none of those
 *  (decide) — and its run-history line says so: the Overview's "Last change
 *  by the autopilot" leaves it out (autopilot.ts, lastAutopilotActionAt).
 *  Review of P9, final round: the lane's resend of the operator's reject,
 *  once Amboss confirmed it, read as the autopilot's latest change. */
const theirs = (e: MagmaJournalEntry): Pick<MagmaSellAction, "via"> => (e.via === "manual" ? { via: "manual" } : {});
/** Open failures worth retrying while there is time. "Too many pending
 *  channels" too: the buyer's LND takes one at a time by default (two orders
 *  from one buyer), and it clears once the earlier channel confirms. */
const TRANSIENT_OPEN = /couldn't connect|offline|not online|disconnect|not enough on-chain capital|insufficient|witness/i;
const isTransientOpen = (error: string): boolean => TRANSIENT_OPEN.test(error) || isPendingChannelsLimit(error);

const NO_KEY =
  "no Amboss key — orders in flight can't be opened, reported or settled; held payments are still released before they expire";
const KEY_REJECTED =
  "Amboss rejects your key — orders in flight can't be opened, reported or settled; held payments are still released before they expire";

/** The lane status when Amboss rejects the lane's request as such (the query
 *  no longer fits the Magma API): not an outage, and not about one order. */
const queryRejectedText = (err: unknown): string =>
  `Amboss rejected LightningMate's request (${msg(err)}) — the Magma API may have changed; ` +
  "orders can't be acted on until LightningMate is updated";

/** One pass of the order lane: how much of Amboss it may still use. */
interface LanePass {
  /** Amboss can't be used for the rest of this pass (no key, a key Amboss
   *  refuses, Amboss unreachable): only the LND-side work runs. */
  lndOnly: boolean;
  /** Why — the lane's status says so. */
  reason: string | null;
  /** The key check was asked once this pass already. */
  rechecked: boolean;
  /** A problem that isn't an outage and won't clear by itself — Amboss
   *  rejecting the lane's own request, or LND refusing the write macaroon
   *  the peer listing every order's open needs — for the lane's status (the
   *  pass goes on). */
  problem: string | null;
  /** The orders this pass's listing shows waiting on us, as listed (null: no
   *  listing this pass). An order in it exists, whatever a read of it
   *  answered — and the listing says enough to turn it down. */
  listed: ReadonlyMap<string, SaleOrder> | null;
  /** What Amboss answered for each order it would not show this pass, the
   *  pass going on with the others — for the lane's status. */
  unread: string[];
  /** Order reads this pass that failed the way they do when Amboss is down:
   *  no answer in time, no connection, a server error at the HTTP level. The
   *  first may be about that one order alone (a resolver slow for it) and the
   *  pass goes on; a second makes the rest of the pass LND-only. */
  outages: number;
  /** What each order the lane could not decide on this pass ran into — a
   *  check before the accept that could not be made — for the lane's status. */
  undecided: string[];
  /** Amboss's listing of your sold capital (the deploy cap's share) failed in
   *  this pass: not asked again for every further new order (each time up to
   *  its deadline) — those orders wait for the next pass, or are rejected. */
  deployedFailure: { err: unknown } | null;
  /** Some call to Amboss answered in this pass (the listing, an order's
   *  read). Then reads that time out are about those orders — "could not
   *  read N orders" — not "Amboss unreachable". */
  answered: boolean;
  /** This node's public key: only its orders are acted on (one Amboss
   *  account can sell for several nodes). Empty until known. */
  own: string;
}

/** Amboss answers for these statuses only once an order was accepted. */
const PAST_APPROVAL: ReadonlySet<string> = new Set([
  "WAITING_FOR_BUYER_PAYMENT",
  "WAITING_FOR_CHANNEL_OPEN",
  ...FUNDING_REPORTED_STATUSES,
  ...ORDER_SUCCEEDED,
]);

/** The lane's status when the pass turns to LND alone over order reads that
 *  failed as if Amboss were down. Said as what it is: a rate limit is a rate
 *  limit; reads failing while the listing (or another read) answered in the
 *  same pass are those orders' reads, not "Amboss unreachable" — that is
 *  only said when nothing at all answered. */
const outageText = (err: unknown, pass: Pick<LanePass, "answered" | "outages">): string =>
  isRateLimited(err)
    ? `Amboss is limiting requests (${msg(err)}) — the rest of this pass ran on LND alone; held payments are still watched in LND`
    : pass.answered
      ? `could not read ${pass.outages === 1 ? "1 order" : `${pass.outages} orders`} from Amboss (${msg(err)}) — the rest of this pass ran on LND alone; held payments are still watched in LND`
      : `Amboss unreachable (${msg(err)}) — held payments are still watched in LND`;

/** The lane's status when Amboss would not show some orders (not an outage:
 *  the pass went on with the others, and the next one asks again). */
const unreadText = (unread: string[]): string =>
  `could not read ${unread.length === 1 ? "1 order" : `${unread.length} orders`} from Amboss (${unread[0]})`;

/** The lane's status when it could not decide on some new orders (a check
 *  before the accept could not be made; the next pass tries again). */
const undecidedText = (undecided: string[]): string =>
  `could not decide ${undecided.length === 1 ? "1 order" : `${undecided.length} orders`} (${undecided[0]})`;

/** What a capital check before an accept ran into: Amboss's listing of your
 *  sold capital (the deploy cap's share — the check's only Amboss call), or
 *  LND (the wallet, the channels). Amboss's bare "Internal server error" on
 *  an order's record said neither. */
const capitalCheckFailed = (err: unknown): string =>
  err instanceof AmbossError
    ? `could not read your sold capital from Amboss: ${msg(err)}`
    : `LND did not answer the capital check: ${msg(err)}`;

export class MagmaDesk {
  readonly journal: MagmaJournal;
  private laneBusy = false;
  private stopping = false;
  private active = 0;
  private readonly orderChains = new Map<string, Promise<void>>();
  private lane: Omit<LaneStatus, "running" | "openOrders"> = { lastTickAt: null, ok: null, error: null, retrying: false, idle: null };
  /** Magma capital in sold channels with a running lease (and orders accepted
   *  outside this journal), from the last listing — the deploy-cap share. */
  /** Amboss's last good listing of this node's sold capital: the sats (the
   *  orders this journal reserved then left out), when, and the orders it
   *  showed waiting for this node's approval. */
  private deployed: { sats: number; at: number; awaiting: string[] } = { sats: 0, at: 0, awaiting: [] };
  /** When that listing last failed (it isn't asked again at once). */
  private deployedFailedAt = 0;
  /** This node's sales Amboss reports with a running lease and a channel,
   *  from the same listing (refreshDeployed) — the lease registry's fallback
   *  for sales this journal never recorded (leases.ts) — and when that
   *  listing was made. Kept on disk (review of P4: it lived in memory only,
   *  so after a restart, or while selling was off, the registry knew none of
   *  these sales and the close list offered them mid-lease). */
  private ambossLeases: AmbossRunningLease[] = [];
  private ambossLeasesAt = 0;
  private ambossLeasesSavedAt = 0;
  private ambossLeasesTriedAt = 0;
  private ambossLeasesRefresh: Promise<void> | null = null;
  private readonly ambossLeasesStore: JsonStore<AmbossLeasesFile>;
  /** Funding outpoints ("txid:vout") of finished leases, learned once per
   *  process. */
  private readonly finishedTxids = new Map<string, string | null>();
  /** A finished lease's channel kept open, and why (said once per process). */
  private readonly closeKept = new Map<string, string>();
  /** Orders whose last read Amboss refused or failed, whatever the failure
   *  (this process), each with WHEN its read was last attempted — a sequence
   *  number (readSeq), set right before the read: monotonic, so two reads
   *  in the same millisecond still have an order. The lane walks these after
   *  every other order, least recently tried first: a read that hangs every
   *  pass (a resolver slow for one order) then costs one deadline at the end
   *  of each pass, and never anyone's turn. Before, this group was walked in
   *  a fixed order, so two orders whose reads failed every pass took both read
   *  slots every pass (the second outage turns the pass LND-only) and starved
   *  the rest of the group for good: a confirmed channel never settled, a paid
   *  order never opened, a new order never decided. And the run history gets
   *  one line when an order becomes unreadable, not one per pass — Amboss's
   *  answer may differ each time, and the autopilot drops only identical
   *  repeats; the order's record keeps the latest. */
  private readonly unreadOrders = new Map<string, number>();
  private readSeq = 0;

  constructor(private readonly deps: MagmaDeskDeps) {
    this.journal = new MagmaJournal(deps.dataDir);
    this.ambossLeasesStore = new JsonStore<AmbossLeasesFile>(deps.dataDir, "magma-amboss-leases.json");
    const kept = this.ambossLeasesStore.read({ at: null, leases: [] });
    const keptAt = typeof kept.at === "string" ? Date.parse(kept.at) : NaN;
    if (Number.isFinite(keptAt) && Array.isArray(kept.leases)) {
      this.ambossLeases = kept.leases.filter(
        (l): l is AmbossRunningLease => !!l && typeof l.orderId === "string" && typeof l.channelId === "string",
      );
      this.ambossLeasesAt = keptAt;
      this.ambossLeasesSavedAt = keptAt;
    }
    deps.capital.register("magma", {
      // Each accepted order's open will be checked against the sell reserve.
      reservations: () => this.journal.reservations(deps.config().sellReserveSats),
      deployedSat: () => this.deployedNow(),
      claimedOutpoints: () => this.journal.claimedOutpoints(),
      // A lease Amboss still lists as running holds — the routing-fee
      // promise and the rebalancer's hands-off alike — whatever the
      // journal's own count says (review of P4: only the close protections
      // took Amboss's word).
      leaseCaps: () => this.markRunningOnAmboss(this.journal.leaseCaps()),
      soldLeases: () => this.soldLeasesWithAmboss(),
    });
  }

  /** The journal's sale records, each marked when Amboss's last listing has
   *  its lease running. */
  private markRunningOnAmboss<T extends { orderId: string }>(items: T[]): (T & { ambossRunning?: boolean })[] {
    const running = new Set(this.ambossLeases.map((l) => l.orderId));
    return items.map((i) => (running.has(i.orderId) ? { ...i, ambossRunning: true } : i));
  }

  /** Every channel sold on Magma whose lease may run: the journal's, marked
   *  as above — and the sales only Amboss knows of (completed before the
   *  journal existed, or with another tool), by the channel Amboss names. */
  private soldLeasesWithAmboss(): SoldLease[] {
    const own = this.markRunningOnAmboss(this.journal.soldLeases());
    const known = new Set(own.map((l) => l.orderId));
    const onlyAmboss = this.ambossLeases
      .filter((l) => !known.has(l.orderId))
      .map((l): SoldLease => ({ fundingOutpoint: "", source: "magma", orderId: l.orderId, leaseBlocks: 0, ambossRunning: true, channelId: l.channelId }));
    return [...own, ...onlyAmboss];
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Shutdown: no new step starts; the one under way finishes (waitIdle). */
  stop(): void {
    this.stopping = true;
  }

  isBusy(): boolean {
    return this.laneBusy || this.active > 0;
  }

  async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.isBusy()) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  laneStatus(): LaneStatus {
    return { ...this.lane, running: this.laneBusy, openOrders: this.journal.open().length };
  }

  /** Orders with something of ours under way (accepted, paid, opening, …) —
   *  Settings warns with this before the Amboss key is removed. */
  ordersInFlight(): number {
    return this.journal.inFlight().length;
  }

  /**
   * Orders the lane turned down in the last two days (not by a click),
   * not yet dismissed — each a buyer this node could have served with a
   * bigger cap or more coins, or couldn't reach. Before, a refused order
   * left no trace when nothing else happened in the same run: no alert, no
   * Overview line — while the operator assumed the autopilot had it handled.
   */
  refusals(nowMs = Date.now()): MagmaRefusal[] {
    return this.journal
      .all()
      .filter(
        (e) =>
          e.phase === "rejected" &&
          e.via !== "manual" &&
          e.decision?.action === "reject" &&
          !e.alertAckAt &&
          nowMs - Date.parse(e.decision.at) <= 48 * 3_600_000,
      )
      .map((e) => {
        const reason = e.reason ?? e.decision?.reason ?? "rejected";
        return { orderId: e.orderId, sizeSats: e.sizeSats, reason, kind: e.refusalKind ?? refusalKindOf(reason), at: e.decision!.at };
      });
  }

  /** The operator read the alert about a turned-down order. */
  acknowledgeRefusal(orderId: string): boolean {
    const e = this.journal.get(orderId);
    if (!e || e.phase !== "rejected") return false;
    e.alertAckAt = now();
    this.journal.note(e);
    return true;
  }

  /**
   * What the lane did with recent orders, newest first: each order's latest
   * decision (accept, reject, skip, wait) or outcome, with its reason — so
   * an order turned down for the deploy cap, or skipped while Amboss reported
   * no fee, is visible (a6-ux: refused orders left no trace when nothing else
   * happened in the same run).
   */
  recentOrders(limit = 10): {
    orderId: string;
    sizeSats: number;
    phase: MagmaPhase;
    seenAt: string;
    at: string;
    action: string;
    reason: string | null;
    via: MagmaJournalEntry["via"];
    external: MagmaJournalEntry["external"] | null;
  }[] {
    return this.journal
      .all()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((e) => ({
        orderId: e.orderId,
        sizeSats: e.sizeSats,
        phase: e.phase,
        seenAt: e.createdAt,
        at: e.decision?.at ?? e.updatedAt,
        action: TERMINAL_PHASES.has(e.phase) ? e.phase : (e.decision?.action ?? e.phase),
        reason: e.reason ?? e.lastError ?? e.decision?.reason ?? null,
        via: e.via,
        external: e.external ?? null,
      }));
  }

  /**
   * Does the order lane open this order's channel by itself once the buyer
   * has paid — or is it the operator's "Open channel" click? With Liquidity
   * provision on, every paid order of this node is the lane's (an unknown
   * one is adopted); with it off — or all automation paused — only those
   * the lane accepted itself, which it carries to their end (fulfil: auto).
   * Without write mode or an Amboss key, nothing is opened by itself — nor
   * for an order this node has finished with (settled, cancelled, rejected,
   * failed: its held payment released, say) or one accepted outside
   * LightningMate or by another node of the account (`external`), whatever
   * Amboss still lists: the lane opens no channel for those (advance()).
   * (Review of P7: Market → Orders said "waiting for you to open the
   * channel" for orders the lane was about to open itself. Review of P8:
   * and "the autopilot opens the channel · accepted outside LightningMate"
   * for one it never opens.) With selling off, "accepted itself" means past
   * "seen": an order the paused lane only saw is the operator's to decide
   * (SELLING_OFF_SKIP) — accepted on Amboss's site after all, Orders said
   * "Paid — the autopilot opens the channel" until the next pass found it
   * accepted elsewhere (review of P8, final round).
   */
  opensItself(orderId: string): boolean {
    if (!this.deps.writeLnd || !this.deps.amboss.hasKey()) return false;
    const entry = this.journal.get(orderId);
    if (entry && (TERMINAL_PHASES.has(entry.phase) || entry.external)) return false;
    return this.deps.config().sellEnabled || (entry?.via === "autopilot" && entry.phase !== "seen");
  }

  localView(orderId: string): MagmaOrderLocal | null {
    const e = this.journal.get(orderId);
    if (!e) return null;
    return {
      phase: e.phase,
      via: e.via,
      updatedAt: e.updatedAt,
      fundingOutpoint: e.fundingOutpoint ?? null,
      reason: e.reason ?? null,
      decision: e.decision ?? null,
      lastError: e.lastError ?? null,
      booked: e.phase === "settled" ? !e.unbooked : null,
      external: e.external ?? null,
      invoiceSats: BigInt(e.feeMsat || "0") > 0n ? Number(BigInt(e.feeMsat) / 1000n) : null,
    };
  }

  // ── the lane ───────────────────────────────────────────────────────────────

  /**
   * One pass of the order lane. Cheap when there is nothing to do: with
   * selling off and no order of ours in flight — or without a key and no
   * invoice of ours out — it makes no call at all. Never overlaps itself;
   * never waits for the main autopilot run.
   *
   * Without a usable key (none, or one Amboss refuses) the pass still runs
   * for the orders this node has taken on, on LND alone: before, it returned
   * at once, so a held payment ran into its HTLC expiry and the order's coins
   * stayed reserved — blocking routing opens, LSPS1 and the offer — until a
   * key came back.
   */
  async tick(): Promise<MagmaSellAction[]> {
    const { writeLnd, amboss } = this.deps;
    if (this.laneBusy || this.stopping || !writeLnd) return [];
    const cfg = this.deps.config();
    const mine = this.journal.open();
    const keyed = amboss.hasKey();
    // Nothing to do — and the status says so. Before, it kept the last busy
    // pass's: after an outage, "Amboss unreachable … retrying" stayed on
    // screen for good once selling was switched off, with nothing retrying.
    if (!keyed && !mine.some((e) => e.invoice || e.phase !== "seen")) {
      return this.idle("no Amboss key, and no order of yours in flight");
    }
    if (!cfg.sellEnabled && mine.length === 0) {
      return this.idle("Liquidity provision is off, and no order of yours is in flight");
    }
    this.laneBusy = true;
    const pass: LanePass = {
      lndOnly: !keyed,
      reason: keyed ? null : NO_KEY,
      rechecked: false,
      problem: null,
      listed: null,
      unread: [],
      outages: 0,
      undecided: [],
      deployedFailure: null,
      answered: false,
      own: "",
    };
    const out: MagmaSellAction[] = [];
    let listError: { text: string; retrying: boolean } | null = null;
    try {
      if (keyed && amboss.getValidity() === false) {
        // Amboss refused this key before: ask again (the check is cached for
        // a few minutes), and until it says yes, do only what LND can do.
        await amboss.checkValidity();
        if (amboss.getValidity() === false) this.lndOnlyFor(pass, KEY_REJECTED);
      }
      // Orders waiting on us — only with selling on. In manual mode the lane
      // only carries the orders already taken on (journal) to their end: a
      // held payment must always end settled or refunded.
      let actionable: SaleOrder[] = [];
      // Only this node's orders are ours to act on: one Amboss account can
      // sell for several nodes, and its listing shows all of them.
      if (!pass.lndOnly) pass.own = await this.ownPubkey();
      if (!pass.lndOnly && cfg.sellEnabled) {
        try {
          actionable = (await this.ambossSales(amboss.getKey(), { actionNeeded: true })).orders.filter((o) => o.sellerPubkey === pass.own);
          pass.listed = new Map(actionable.map((o) => [o.id, o]));
          pass.answered = true;
          amboss.markValid();
        } catch (err) {
          // No new orders this pass; the ones in flight are still carried on —
          // with Amboss, unless it is down: a listing that failed inside a
          // GraphQL answer (a 500 of its resolver) is that request's error,
          // not a reason to stop opening, reporting and settling.
          listError = isQueryRejected(err)
            ? { text: queryRejectedText(err), retrying: false }
            : { text: `could not list your sales on Amboss: ${msg(err)}`, retrying: true };
          if (isAuthError(err)) await this.keyStillValid(pass);
          else if (isAmbossOutage(err)) this.lndOnlyFor(pass, outageText(err, pass));
        }
      }
      // An order this node has finished with (rejected, cancelled, failed,
      // settled) has nothing left to do here, whatever Amboss still lists —
      // unless it ended "failed" with nothing of ours tied to it while Amboss
      // waits for our approval after all (revive).
      const fresh = actionable.filter((o) => {
        const e = this.journal.get(o.id);
        return !e || !TERMINAL_PHASES.has(e.phase) || this.revive(e, o.status);
      });
      const ids = this.walkOrder(mine, fresh);
      for (const id of ids) {
        if (this.stopping) break;
        out.push(...(await this.withOrder(id, () => this.advance(id, pass))));
      }
      // Orders the lane no longer walks (ended, or no longer listed) are
      // forgotten as unreadable too.
      const walked = new Set(ids);
      for (const id of [...this.unreadOrders.keys()]) if (!walked.has(id)) this.unreadOrders.delete(id);
      // What the status reports, and whether the next pass may clear it. A
      // request Amboss rejects as such fails the same way every pass until
      // LightningMate is updated: the Orders tab must not say "retrying".
      // Orders Amboss would not show, and new orders the lane could not
      // decide on, are reported too (never silently).
      const leftOver = [
        pass.unread.length > 0 ? unreadText(pass.unread) : null,
        pass.undecided.length > 0 ? undecidedText(pass.undecided) : null,
      ].filter((t): t is string => t !== null);
      const problem: { text: string; retrying: boolean } | null = pass.lndOnly
        ? { text: pass.reason ?? "Amboss can't be asked", retrying: pass.reason !== NO_KEY }
        : (listError ??
          (pass.problem !== null ? { text: pass.problem, retrying: false } : null) ??
          (leftOver.length > 0 ? { text: leftOver.join("; "), retrying: true } : null));
      this.lane = { lastTickAt: now(), ok: problem === null, error: problem?.text ?? null, retrying: problem?.retrying ?? false, idle: null };
    } catch (err) {
      this.lane = { lastTickAt: now(), ok: false, error: msg(err), retrying: true, idle: null };
      console.warn(`[magma] order lane: ${msg(err)}`);
    } finally {
      this.laneBusy = false;
    }
    return out;
  }

  /**
   * The order in which a pass walks the orders:
   *  1. orders with something of ours at stake — an invoice out, a payment
   *     held, a channel being opened, reported or settled: their turn must
   *     never depend on a decision about a new order;
   *  2. then orders still to be decided (journal first, then new ones);
   *  3. and, after all of these, every order whose last read failed (any
   *     failure — a timeout too), at stake or not — least recently tried
   *     first (unreadOrders), at stake first among equals.
   * A read that hangs costs its whole deadline. Before, the order whose read
   * hung every pass came first in every pass whenever it was the newest one
   * at stake — and as that failure counted as "Amboss down", every order
   * after it was left to LND alone, pass after pass: an older paid order was
   * never opened, a confirmed channel never settled (its payment released
   * unclaimed near expiry), new orders never decided. Walked last, it can't
   * hold up anyone — and walked least-recently-tried first, two such orders
   * can't hold up the others in their group either: whichever was skipped
   * (the pass went LND-only before its read) is read first next time. (The
   * sort is stable: journal order — newest first — breaks the last ties.)
   */
  private walkOrder(mine: MagmaJournalEntry[], fresh: SaleOrder[]): string[] {
    const ids = [...new Set([...mine.map((e) => e.orderId), ...fresh.map((o) => o.id)])];
    const atStake = (id: string): boolean => {
      const e = this.journal.get(id);
      return e !== undefined && e.phase !== "seen";
    };
    return ids
      .map((id, i) => ({ id, i, stake: atStake(id), tried: this.unreadOrders.get(id) }))
      .sort((a, b) => {
        const unreadA = a.tried !== undefined;
        const unreadB = b.tried !== undefined;
        if (unreadA !== unreadB) return unreadA ? 1 : -1;
        if (unreadA && unreadB && a.tried !== b.tried) return (a.tried as number) - (b.tried as number);
        if (a.stake !== b.stake) return a.stake ? -1 : 1;
        return a.i - b.i;
      })
      .map((x) => x.id);
  }

  /**
   * An order this node ended as "failed" with nothing of ours tied to it (no
   * invoice, no channel) that Amboss shows waiting for our approval after
   * all: it is not over — back to "seen", to be decided (by the lane, or by a
   * click). An order is only ended so when Amboss's listing leaves it out;
   * should one ever be ended while Amboss still waits on us, this keeps it
   * from timing out on us (the seller-score hit D6 exists to prevent) with
   * the Orders tab hiding its Accept and Reject. True: revived.
   */
  private revive(entry: MagmaJournalEntry | undefined, status: string): boolean {
    if (!entry || entry.phase !== "failed" || entry.invoice || entry.fundingOutpoint) return false;
    if (status !== "WAITING_FOR_SELLER_APPROVAL") return false;
    this.backToSeen(entry);
    entry.reason = undefined;
    entry.refusals = undefined;
    entry.notFound = undefined;
    this.journal.event(entry, "Amboss shows it waiting for your approval after all — to be decided again");
    this.journal.note(entry);
    return true;
  }

  /** A pass with nothing to do: no call made, and the status says why. */
  private idle(why: string): MagmaSellAction[] {
    this.lane = { lastTickAt: now(), ok: null, error: null, retrying: false, idle: why };
    return [];
  }

  private lndOnlyFor(pass: LanePass, reason: string): void {
    if (pass.lndOnly) return;
    pass.lndOnly = true;
    pass.reason = reason;
  }

  /**
   * Amboss refused a call. A refusal can be about one resource, so the key
   * check decides (asked at most once per pass): a refused key turns the rest
   * of the pass to LND-only work; a fine key makes it this order's problem
   * alone, and the other orders go on.
   */
  private async keyStillValid(pass: LanePass): Promise<boolean> {
    if (!pass.rechecked) {
      pass.rechecked = true;
      await this.deps.amboss.recheckAfterRefusal();
    }
    if (this.deps.amboss.getValidity() === false) {
      this.lndOnlyFor(pass, KEY_REJECTED);
      return false;
    }
    return true;
  }

  /** Move one order as far as it can go now. Errors stay with the order. */
  private async advance(id: string, pass: LanePass): Promise<MagmaSellAction[]> {
    const cfg = this.deps.config();
    let entry = this.journal.get(id);
    if (pass.lndOnly) return entry ? this.maintainFromLnd(entry) : [];
    let order: SaleOrderDetail;
    // When this read was tried (for the walk order of unreadable orders).
    const triedAt = ++this.readSeq;
    if (this.unreadOrders.has(id)) this.unreadOrders.set(id, triedAt);
    try {
      order = await this.ambossSale(this.deps.amboss.getKey(), id);
    } catch (err) {
      return this.unreadable(id, entry, err, pass, triedAt);
    }
    this.unreadOrders.delete(id);
    pass.answered = true;
    // Another node of the same Amboss account sells this one: never this
    // node's to accept, open or reject.
    if (order.sellerPubkey !== pass.own) return this.notThisNode(entry, order);
    if (entry) {
      entry.lastStatus = order.status;
      entry.lastStatusAt = now();
      entry.timeout = order.timeout;
      entry.refusals = undefined;
      entry.notFound = undefined;
      // Amboss has just shown the order: a failed read on record — Amboss
      // down, refusing to show the order, or refusing the key — no longer
      // holds, and goes (saved with the journal's next write, as lastStatus
      // is). What the record says next is this pass's. Review of P10, round
      // 2: nothing cleared it. With selling off — no listing: every order on
      // record is read on its own — an outage of more than one pass left
      // "could not read the order from Amboss" on Market → Orders and in the
      // recent orders, over MANUAL_ACCEPT_SKIP or SELLING_OFF_SKIP, until the
      // order timed out on the operator.
      if (entry.lastError && READ_FAILED.test(entry.lastError)) {
        entry.lastError = undefined;
        entry.lastErrorAt = undefined;
      }
    }
    const out: MagmaSellAction[] = [];
    try {
      if (ORDER_FAILED.has(order.status)) {
        if (entry && !TERMINAL_PHASES.has(entry.phase)) {
          // Ended after we funded it (say, the report came too late): the
          // buyer is refunded either way, and the channel stays ours to close.
          const channel = entry.fundingOutpoint ? ` — the channel ${entry.fundingOutpoint} stays open; close it if you don't want it` : "";
          out.push(...(await this.release(entry, `Amboss ended the order: ${order.status}${channel}`)));
        }
        return out;
      }
      // Only seen here (no invoice of ours — never accepted here), yet past
      // approval on Amboss: accepted outside LightningMate. Before, such an
      // order was booked as income, with its service fee, once Amboss said
      // the channel was confirmed — on Amboss's word alone.
      if (entry?.phase === "seen" && !entry.invoice && PAST_APPROVAL.has(order.status)) {
        return this.acceptedElsewhere(entry, order, { auto: cfg.sellEnabled });
      }
      if (ORDER_SUCCEEDED.has(order.status)) {
        if (entry && !TERMINAL_PHASES.has(entry.phase)) out.push(...(await this.settle(entry, order)));
        return out;
      }
      switch (order.status) {
        case "WAITING_FOR_SELLER_APPROVAL":
          if (entry?.phase === "accepting") out.push(...(await this.resumeAccept(entry, order, pass)));
          // The operator's reject that Amboss hasn't confirmed: carried out —
          // sent again on every pass until Amboss confirms it or the order
          // ends, whatever the switch says (their decision, not the lane's;
          // via stays "manual": no "turned down" alert). Review of P8, final
          // round: nothing sent it again ("will try again" wasn't true), and
          // with selling on the next pass ACCEPTED the order they had
          // rejected — and once it was paid, opened its channel.
          else if (entry && rejectByHand(entry)) out.push(...(await this.rejectOrder(entry, REJECTED_BY_YOU)));
          // The lane's own reject that Amboss didn't confirm ("will try
          // again"), with Liquidity provision switched off — or all
          // automation paused — since: nothing sends it again (the lane
          // decides nothing now). The order is the operator's, and its record
          // says so; the retry it promised goes. (Before, it kept "will try
          // again" while the order timed out on the operator.)
          else if (entry?.phase === "seen" && entry.via === "autopilot" && entry.decision?.action === "reject" && !cfg.sellEnabled) {
            entry.lastError = undefined;
            entry.lastErrorAt = undefined;
            out.push(this.skip(entry, SELLING_OFF_SKIP));
          }
          // A new order is the lane's to decide while Liquidity provision is
          // on. One the operator is deciding is taken up whatever the switch
          // says — only to say so on its record: decide() leaves it to them.
          // So is one whose accept by the lane was handed back (its invoice
          // released, the accept refused or never sent: backToSeen) and that
          // nothing has decided since: with selling off, only for its record
          // to say that the order is the operator's now (SELLING_OFF_SKIP).
          // Review of P10: a paused lane left that record alone — Market →
          // Orders said "within your caps and capital" under an order nothing
          // of ours was tied to, until it timed out on the operator.
          else if ((!entry || entry.phase === "seen") && (cfg.sellEnabled || entry?.via === "manual" || entry?.decision?.action === "accept")) {
            out.push(...(await this.decide(order, pass)));
          }
          break;
        case "WAITING_FOR_BUYER_PAYMENT":
          if (entry?.phase === "accepting") this.toPhase(entry, "accepted", "Amboss shows the order accepted");
          if (entry?.phase === "accepted") out.push(...(await this.checkHeld(entry)));
          break;
        case "WAITING_FOR_CHANNEL_OPEN":
          if (!entry) {
            if (!cfg.sellEnabled) break;
            entry = await this.adoptLegacy(order);
            // A held payment released for good (its record was lost): on
            // the run history too, not only on the order.
            if (entry.phase === "cancelled") {
              out.push({ orderId: id, action: "cancel", sizeSats: entry.sizeSats, ok: true, error: entry.reason });
            }
          }
          if (!TERMINAL_PHASES.has(entry.phase)) {
            out.push(...(await this.fulfil(entry, order, { auto: entry.via === "autopilot" || cfg.sellEnabled })));
          }
          break;
        default:
          // SELLER_SENT_TRANSACTION … SELLER_OPENED_CHANNEL: Amboss has our
          // funding transaction (a report whose answer we lost ends up here).
          if (entry && FUNDING_REPORTED_STATUSES.has(order.status)) {
            if (entry.phase === "opening") await this.reconcileOpening(entry);
            if (entry.phase === "funded") {
              entry.reportedAt = now();
              this.toPhase(entry, "reported", `Amboss has the funding transaction (${order.status})`);
            }
            // Amboss sees the transaction but no confirmation yet. LND
            // rebroadcasts its own funding transactions; if LND no longer
            // knows this one at all, a human must look — opening again
            // would be a second channel for the same order.
            if (order.status === "SELLER_SENT_TRANSACTION" && entry.phase === "reported" && entry.fundingOutpoint) {
              const known = (await channelsWith(this.deps.readLnd, entry.buyerPubkey)).some((c) => c.outpoint === entry!.fundingOutpoint);
              if (!known) this.noteError(entry, `LND no longer knows the funding transaction ${entry.fundingOutpoint} (dropped from the mempool?) — check this channel`);
            }
          }
          break;
      }
      if (entry && !TERMINAL_PHASES.has(entry.phase)) out.push(...(await this.cancelIfExpiring(entry)));
    } catch (err) {
      // The entry as it is now: deciding on a new order creates it.
      entry ??= this.journal.get(id);
      if (isAuthError(err) && !(await this.keyStillValid(pass))) {
        // The key itself is refused now: what LND alone can do still happens.
        this.noteError(entry, `Amboss refused the key (${msg(err)})`);
        if (entry) out.push(...(await this.maintainFromLnd(entry)));
        return out;
      }
      if (isQueryRejected(err)) pass.problem ??= queryRejectedText(err);
      // Anything else (LND not answering, Amboss refusing one step) is this
      // order's error for now; the next pass tries again from the record.
      this.noteError(entry, msg(err));
      out.push({ orderId: id, action: "error", sizeSats: order.sizeSats, ok: false, error: msg(err) });
    }
    return out;
  }

  /** Amboss would not show us this order. `triedAt`: when its read was tried
   *  (unreadOrders). */
  private async unreadable(
    id: string,
    entry: MagmaJournalEntry | undefined,
    err: unknown,
    pass: LanePass,
    triedAt: number,
  ): Promise<MagmaSellAction[]> {
    // Listed as waiting on us in this very pass: the order exists, and it is
    // ours to decide — whatever its read answered.
    const listed = pass.listed?.get(id) ?? null;
    if (isAuthError(err)) {
      if (!(await this.keyStillValid(pass))) return entry ? this.maintainFromLnd(entry) : [];
      // The key works — Amboss refuses this one order. Before, this aborted
      // the whole pass, every pass: one such order blocked every other order
      // for good. One taken on under another account's key, say, isn't
      // listed as waiting on us either: with nothing of ours tied to it, it
      // is dropped after a few refusals in a row. A refusal counts toward
      // that only against a listing this pass HAS, one that leaves the order
      // out. One Amboss lists is never dropped on a refusal (an edge's 403, a
      // hiccup in Amboss's guard) — and without a listing (selling off, or
      // the listing refused or failed too: Amboss's guard sits in front of
      // both) nothing tells the two apart, so nothing is counted. Before,
      // three such passes ended an order still waiting for approval: never
      // accepted nor rejected — not even by hand ("already failed here") —
      // it timed out on us. An unlisted one still ends once its approval
      // deadline is long past (couldNotRead).
      if (entry) {
        if (listed) entry.refusals = undefined;
        else if (pass.listed !== null) entry.refusals = (entry.refusals ?? 0) + 1;
        if (!entry.invoice && entry.phase === "seen" && (entry.refusals ?? 0) >= MAX_REFUSALS) {
          entry.reason = `Amboss refuses to show this order to your key (${msg(err)}) — nothing of ours is tied to it`;
          this.toPhase(entry, "failed", entry.reason);
          return [];
        }
      }
      return this.couldNotRead(id, entry, listed, `Amboss refused to show this order (${msg(err)})`, msg(err), pass, triedAt);
    }
    if (isAmbossOutage(err)) {
      // Amboss may be down — unreachable, too slow, failing at the HTTP level
      // — or only this order's read failing that way (a resolver slow for
      // one order runs into the deadline, a proxy fails one request) while
      // the listing and every other read answer. One such failure is this
      // order's own: the pass goes on with the others, and the order is
      // walked last from now on (walkOrder). A second one in the same pass,
      // or a rate limit (it holds for every call), means Amboss as a whole:
      // the other reads would only fail too, each up to its deadline — the
      // rest of the pass goes on with LND alone. Before, the first one did
      // that: a read that hung every pass left every order after it to LND
      // alone, pass after pass, under "Amboss unreachable".
      pass.outages += 1;
      if (isRateLimited(err) || pass.outages > 1) {
        this.lndOnlyFor(pass, outageText(err, pass));
        const error = `could not read the order from Amboss: ${msg(err)}`;
        this.noteError(entry, error);
        const out = this.unreadLine(id, entry?.sizeSats ?? listed?.sizeSats ?? 0, error, triedAt);
        // Amboss unreadable is no reason to let a held HTLC run into expiry,
        // nor to keep an unpaid invoice past its end: LND's answers suffice.
        return entry ? [...out, ...(await this.maintainFromLnd(entry))] : out;
      }
      return this.couldNotRead(id, entry, listed, `could not read the order from Amboss: ${msg(err)}`, msg(err), pass, triedAt);
    }
    // Amboss rejected the query itself (its API changed): says nothing about
    // this order — and the lane's status must say what is wrong.
    if (isQueryRejected(err)) pass.problem ??= queryRejectedText(err);
    if (entry && isNotFoundAnswer(err) && this.goneFromAmboss(entry, err, pass)) return [];
    // Anything else says nothing about the order: a resolver that failed
    // ("Unexpected error.", or a 500 it reports inside its answer), a
    // rejected query. It stays where it is, and the next pass decides.
    // (Before, ANY GraphQL error here ended a "seen" order for good: one
    // hiccup on Amboss's side, and an order still waiting for approval was
    // never accepted nor rejected — it timed out on us, the seller-score hit
    // D6 exists to prevent.)
    return this.couldNotRead(id, entry, listed, `could not read the order from Amboss: ${msg(err)}`, msg(err), pass, triedAt);
  }

  /**
   * An order Amboss would not show this pass, for a reason of its own — or
   * as the first read of the pass to fail as if Amboss were down (see
   * unreadable): the pass goes on with the other orders. Never silently:
   *  - the error is on the order's record (until Amboss shows the order
   *    again: advance), in the run history (once, when the order becomes
   *    unreadable) and in the lane's status;
   *  - a new order Amboss lists as waiting for our approval gets a record
   *    ("seen", from the listing), so the Orders tab shows it, and why;
   *  - once its approval deadline is close, it is rejected — a reject needs
   *    only the order's id — rather than left to time out on us (D6); the
   *    operator's own reject is sent again at once (rejectsUnread) — with no
   *    listing to tell too;
   *  - whatever LND alone can do for it still happens.
   * Before, a new order whose read kept failing left no trace at all — no
   * record, no history line, a lane reporting "ok" — and timed out.
   * `detail` is Amboss's answer, for the lane's status and the reasons.
   */
  private async couldNotRead(
    id: string,
    found: MagmaJournalEntry | undefined,
    listed: SaleOrder | null,
    error: string,
    detail: string,
    pass: LanePass,
    triedAt: number,
  ): Promise<MagmaSellAction[]> {
    let entry = found;
    // Waiting for our decision, with nothing of ours tied to it yet.
    const undecided = listed?.status === "WAITING_FOR_SELLER_APPROVAL" && (!entry || (entry.phase === "seen" && !entry.invoice));
    if (listed && undecided) entry ??= this.seenFromListing(listed);
    if (entry && !listed && this.pastApproval(entry)) {
      // Not listed as waiting on us (or no listing to tell), long past its
      // approval deadline, still unreadable: Amboss has ended it, and nothing
      // of ours is tied to it. It ends here too — rather than being asked
      // about, and reported unreadable, for good. (Should Amboss list it
      // waiting for approval after all, it is revived.)
      entry.reason = entry.timeout
        ? `its approval deadline passed while Amboss would not show it (${detail}) — nothing of ours is tied to it`
        : `recorded over a day ago with no approval deadline, and Amboss would not show it (${detail}) — nothing of ours is tied to it`;
      this.toPhase(entry, "failed", entry.reason);
      return [];
    }
    this.noteError(entry, error);
    // Turned down now — a reject needs only the order's id: one this pass's
    // listing shows awaiting our approval, as rejectsUnread says; and, with
    // no listing to tell (selling off or all automation paused, when the
    // listing isn't asked for — or the listing failed), the operator's own
    // reject Amboss hasn't confirmed: their decision, carried out whatever
    // the switch says, as advance() does when the read works. Amboss refuses
    // a reject of an order no longer awaiting approval, and once its deadline
    // is long past (byHand keeps it) the order ends here instead (above).
    // Review of P9: with selling off, a reject whose click failed was never
    // sent again while the order's own read failed — though the click was
    // told it would be — and the order timed out on the operator.
    if (entry && (listed ? undecided && this.rejectsUnread(entry, listed) : pass.listed === null && rejectByHand(entry))) {
      const rejected = await this.rejectUnread(entry, detail, pass);
      if (phaseOf(entry) === "rejected") return rejected;
      // The reject didn't go through either: still unread, and still ours.
      pass.unread.push(detail);
      return [...this.unreadLine(id, entry.sizeSats, error, triedAt), ...rejected];
    }
    pass.unread.push(detail);
    const out = this.unreadLine(id, entry?.sizeSats ?? listed?.sizeSats ?? 0, error, triedAt);
    if (entry) out.push(...(await this.maintainFromLnd(entry)));
    return out;
  }

  /** An order whose read failed: one run-history line when it becomes
   *  unreadable, none on the passes after (see unreadOrders). `triedAt`: when
   *  that read was tried — the order's place in the walked-last group. */
  private unreadLine(id: string, sizeSats: number, error: string, triedAt: number): MagmaSellAction[] {
    if (this.unreadOrders.has(id)) return [];
    this.unreadOrders.set(id, triedAt);
    return [{ orderId: id, action: "error", sizeSats, ok: false, error }];
  }

  /** A record for an order known only from the listing (its read failed). */
  private seenFromListing(o: SaleOrder): MagmaJournalEntry {
    const entry = this.journal.create({
      orderId: o.id,
      via: "autopilot",
      buyerPubkey: o.buyerPubkey,
      sizeSats: o.sizeSats,
      isPrivate: o.isPrivate,
      feeMsat: String(this.invoiceMsat(o)),
      lastStatus: o.status,
      lastStatusAt: now(),
      timeout: o.timeout,
    });
    this.journal.event(entry, "listed by Amboss as waiting for your approval");
    return entry;
  }

  /**
   * Is an order Amboss would not show — though this pass's listing has it
   * awaiting our approval, and a reject needs only its id — turned down now?
   * The operator's own reject that Amboss hasn't confirmed: yes, on every
   * such pass (as advance() sends it whenever the order's read shows it
   * awaiting approval). The lane's own reject: by a running lane, once the
   * approval deadline is close, rather than letting the order time out (D6)
   * — never for an order the operator is deciding (an accept of theirs that
   * didn't go through: decide). Review of P8, final round: that near-deadline
   * reject turned down an order the operator had accepted, and held their
   * own reject back until the deadline was close.
   */
  private rejectsUnread(entry: MagmaJournalEntry, listed: SaleOrder): boolean {
    if (rejectByHand(entry)) return true;
    return entry.via !== "manual" && this.deps.config().sellEnabled && this.nearDeadline(listed, REJECT_MARGIN_MS) && !this.deadlinePassed(listed);
  }

  /** Turn down an order Amboss would not show (rejectsUnread, couldNotRead) —
   *  the operator's reject with their own reason. rejectOrder leaves a refused
   *  key, and a request Amboss rejects as such, to the pass (it throws
   *  them): dealt with here, as this order's error. */
  private async rejectUnread(entry: MagmaJournalEntry, detail: string, pass: LanePass): Promise<MagmaSellAction[]> {
    const reason = rejectByHand(entry) ? REJECTED_BY_YOU : `Amboss would not show this order (${detail}) — rejected rather than left to time out`;
    try {
      return await this.rejectOrder(entry, reason);
    } catch (err) {
      if (isAuthError(err)) await this.keyStillValid(pass);
      else if (isQueryRejected(err)) pass.problem ??= queryRejectedText(err);
      this.noteError(entry, `Amboss would not show this order (${detail}), and rejecting it failed: ${msg(err)}`);
      return [{ orderId: entry.orderId, action: "reject", sizeSats: entry.sizeSats, ok: false, error: entry.lastError, ...theirs(entry) }];
    }
  }

  /** A "seen" order (nothing of ours tied to it) long past its approval
   *  deadline — or, with no deadline on record (Amboss gave none, or a click
   *  of an older version recorded the order without it, every read of it
   *  failing since), a day old: otherwise it would be asked about for good, a
   *  refused one with a forced key check every pass — and an operator's
   *  reject Amboss hasn't confirmed sent again for good (couldNotRead). */
  private pastApproval(entry: MagmaJournalEntry): boolean {
    if (entry.phase !== "seen" || entry.invoice) return false;
    const deadline = entry.timeout ? Date.parse(entry.timeout) : NaN;
    const end = Number.isFinite(deadline) ? deadline + SEEN_GRACE_MS : Date.parse(entry.createdAt) + SEEN_MAX_AGE_MS;
    return end < Date.now();
  }

  /**
   * Amboss answered that it has no such order. Taken at its word only when it
   * says so MAX_REFUSALS passes in a row, each time while its own listing of
   * the orders waiting on us, fetched in that pass, leaves the order out — and
   * only for an order with nothing of ours tied to it ("seen", no invoice:
   * nothing held, nothing payable, nothing reserved). A pass without a
   * listing (selling off, or the listing failed) has nothing to check the
   * answer against and counts nothing, as for a refusal: such an order ends
   * once its approval deadline is long past (couldNotRead). An order with an
   * invoice of ours is never dropped on Amboss's word: its payment may be
   * held, and LND alone carries it to its end (maintainFromLnd). True: the
   * order ended here.
   */
  private goneFromAmboss(entry: MagmaJournalEntry, err: unknown, pass: LanePass): boolean {
    if (pass.listed === null) return false;
    if (pass.listed.has(entry.orderId)) {
      // Listed as waiting on us in this very pass: Amboss knows it.
      entry.notFound = undefined;
      return false;
    }
    entry.notFound = (entry.notFound ?? 0) + 1;
    if (entry.invoice || entry.phase !== "seen" || entry.notFound < MAX_REFUSALS) return false;
    entry.reason = `Amboss no longer knows this order (${msg(err)} — ${entry.notFound} times in a row); nothing of ours is tied to it`;
    this.toPhase(entry, "failed", entry.reason);
    return true;
  }

  /**
   * What an order needs from LND alone — whenever Amboss can't be asked
   * about it (no key, a key Amboss refuses, Amboss down, an order Amboss
   * won't show):
   *  - a held payment is released before its HTLC would expire (D2);
   *  - an invoice LND has cancelled, lost, or that expired unpaid ends the
   *    order (and with it the coins reserved for it);
   *  - an interrupted open is looked for in LND;
   *  - an order paid outside a HODL invoice (accepted before the journal)
   *    gives its reservation up once its open deadline has passed.
   * Opening, reporting and settling need Amboss and wait for it.
   */
  private async maintainFromLnd(entry: MagmaJournalEntry): Promise<MagmaSellAction[]> {
    if (TERMINAL_PHASES.has(entry.phase) || entry.phase === "seen") return [];
    try {
      if (entry.phase === "opening") await this.reconcileOpening(entry);
      const inv = entry.invoice;
      if (!inv) return this.endLegacyPastDeadline(entry);
      const st = await this.lndHodlStatus(inv.id);
      if (entry.phase === "accepting" && (st.state === "missing" || st.state === "canceled")) {
        // No invoice the buyer could pay: nothing of ours is out there. The
        // order goes back to "seen" (its reservation ends) — without the
        // accept's "checking with Amboss on the next pass", which no longer
        // holds (backToSeen). With Amboss back, the lane takes it up afresh
        // (advance, decide): a running lane decides on it again; one the
        // operator accepted, or the lane's own with selling off, is left to
        // the operator — and its record says so.
        this.backToSeen(entry);
        this.journal.event(entry, `its invoice is ${st.state} in LND — nothing was offered; the reservation ends`);
        this.journal.note(entry);
        return [];
      }
      if (st.state === "missing" || st.state === "canceled") {
        return this.release(entry, `its invoice was ${st.state === "missing" ? "not found" : "cancelled or expired"} in LND before the sale completed`);
      }
      if (st.state === "open") {
        return Date.parse(inv.expiresAt) <= Date.now() ? this.release(entry, "its invoice expired before the buyer paid") : [];
      }
      if (st.state === "settled") return this.checkHeld(entry); // only we settle: recover the record
      // Held. The buyer paid — record it, and release it in time.
      if ((entry.phase === "accepting" || entry.phase === "accepted") && st.heldMtokens >= BigInt(entry.feeMsat || "0")) {
        entry.heldAt = now();
        entry.heldUntilHeight = st.heldUntilHeight;
        this.toPhase(entry, "held", `buyer's payment held (${feeSatsOf(entry)} sat)`);
      } else if (st.heldUntilHeight !== null) {
        entry.heldUntilHeight = st.heldUntilHeight;
      }
      return this.cancelIfExpiring(entry);
    } catch (err) {
      this.noteError(entry, `could not check the order in LND: ${msg(err)}`);
      return [];
    }
  }

  /** An order paid through a plain invoice (accepted before this journal)
   *  has no HODL invoice to release. While Amboss can't be asked, it keeps
   *  its coins reserved only until its open deadline (as last seen) — past
   *  that, Amboss has ended it either way. */
  private endLegacyPastDeadline(entry: MagmaJournalEntry): MagmaSellAction[] {
    if (entry.phase !== "held") return [];
    const deadline = entry.timeout
      ? Date.parse(entry.timeout)
      : Date.parse(entry.heldAt ?? entry.createdAt) + LEGACY_HOLD_MS;
    if (!(deadline < Date.now())) return [];
    entry.reason = "its channel-open deadline passed while Amboss could not be asked — the coins reserved for it are free again";
    this.toPhase(entry, "failed", entry.reason);
    return [];
  }

  // ── deciding on a new order (D6) ───────────────────────────────────────────

  /** The HODL invoice amount: what the seller earns, `fees.seller`. Should it
   *  read 0 while its parts (fixed + variable — the buyer pays those plus
   *  Amboss's own fee) don't, the parts are billed. (Not seen live: the 0
   *  order of 2026-10-23 had every part at 0 — nothing to bill, see decide.) */
  private invoiceMsat(order: SaleOrder): bigint {
    const seller = msatOf(order.fees.seller) ?? 0n;
    if (seller > 0n) return seller;
    return (msatOf(order.fees.fixed) ?? 0n) + (msatOf(order.fees.variable) ?? 0n);
  }

  private nearDeadline(order: SaleOrder, marginMs: number): boolean {
    return order.timeout !== null && Date.parse(order.timeout) - Date.now() <= marginMs;
  }

  private deadlinePassed(order: SaleOrder): boolean {
    return order.timeout !== null && Date.parse(order.timeout) <= Date.now();
  }

  /**
   * Can a channel of `sizeSats` be funded (and, with `caps`, is it within the
   * autopilot's limits)? Null when yes, else the reason. `exceptKey` is this
   * order's own reservation, which must not count against itself. The same
   * check runs at accept and at open. Every accepted order reserves its size
   * AND what its open will need on top (its funding fee, its step of LND's
   * anchor reserve, the sell reserve — capital.ts), so an order accepted now
   * still passes this check when its own open comes, after the others.
   */
  private async capitalFor(
    sizeSats: number,
    opts: {
      caps: boolean;
      exceptKey?: string;
      /** false inside the mutex: no Amboss call there */
      refresh?: boolean;
      /** The lane pass asking: a listing of your sold capital that failed in
       *  it is not asked again (see refreshDeployedFor). */
      pass?: LanePass | null;
    },
  ): Promise<Lacking | null> {
    const cfg = this.deps.config();
    if (opts.caps && sizeSats > cfg.sellMaxChannelSats) {
      return { kind: "cap", reason: `above your max channel size (${fmt(sizeSats)} > ${fmt(cfg.sellMaxChannelSats)} sat)` };
    }
    // The wallet before the deploy cap: LND is local and quick, and an order
    // the wallet can't fund is turned down at once — whatever Amboss's
    // listing of your sold capital answers below, or fails to.
    const sp = await spendableOnchain(this.deps.readLnd, this.deps.capital, cfg.sellReserveSats, { exceptKey: opts.exceptKey });
    if (sp.spendableSat < sizeSats) {
      const n = sp.reserve.pendingOpens;
      const fees = n > 0 ? `the funding fees of this and ${n} promised open${n === 1 ? "" : "s"}` : "the funding fee";
      return {
        kind: "capital",
        reason:
          `not enough on-chain capital: ${fmt(sp.spendableSat)} sat spendable after a ${fmt(sp.reserve.totalSat)} sat ` +
          `reserve (incl. LND's anchor reserve and ${fees}) and ${fmt(sp.reservedSat)} sat promised to other orders`,
      };
    }
    if (opts.caps) {
      if (opts.refresh !== false) await this.refreshDeployedFor(opts.pass ?? null);
      const committed = this.deps.capital.deployedSat() + this.deps.capital.reservedSat(opts.exceptKey);
      if (committed + sizeSats > cfg.sellMaxDeploySats) {
        return { kind: "cap", reason: `deploy cap reached (${fmt(committed)} sat already sold or promised, cap ${fmt(cfg.sellMaxDeploySats)} sat)` };
      }
    }
    return null;
  }

  /** The deploy cap's share from Amboss, for a decision in a lane pass. A
   *  listing that failed is not asked again in the same pass: before, every
   *  further new order fetched it afresh — on a timeout, 15 s each. */
  private async refreshDeployedFor(pass: LanePass | null): Promise<void> {
    if (pass?.deployedFailure) throw pass.deployedFailure.err;
    try {
      await this.refreshDeployed();
    } catch (err) {
      if (pass) pass.deployedFailure = { err };
      throw err;
    }
  }

  /**
   * A check before the accept could not be made (Amboss's listing of your
   * sold capital, LND's wallet or channels, the invoice): nothing was promised
   * and nothing created — the order is still to be decided. Never silently:
   * its error is on its record (saying what failed), in the lane's status and
   * in the run history, and the next pass decides afresh. Once its approval
   * deadline is close, it is rejected instead (rejectUndecided). Before, such
   * an order sat "seen" with Amboss's bare "Internal server error" on record,
   * under a lane reporting "ok", until it timed out on us.
   */
  private async undecided(entry: MagmaJournalEntry, order: SaleOrder, what: string, pass: LanePass): Promise<MagmaSellAction[]> {
    const rejected = await this.rejectUndecided(entry, order, what, pass);
    if (rejected) return rejected;
    this.noteError(entry, what);
    pass.undecided.push(what);
    return [{ orderId: entry.orderId, action: "error", sizeSats: entry.sizeSats, ok: false, error: what }];
  }

  /** An order the lane can't decide on, with its approval deadline close:
   *  rejected — a reject needs only its id — rather than left to time out on
   *  us (D6). Null: there is time, and the next pass tries again (or the
   *  deadline has passed already: Amboss has ended the order, and could only
   *  refuse a reject). */
  private async rejectUndecided(
    entry: MagmaJournalEntry,
    order: SaleOrder,
    what: string,
    pass: LanePass,
  ): Promise<MagmaSellAction[] | null> {
    if (!this.nearDeadline(order, REJECT_MARGIN_MS) || this.deadlinePassed(order)) return null;
    const out = await this.rejectOrder(entry, `could not decide on it in time: ${what} — rejected rather than left to time out`);
    if (phaseOf(entry) !== "rejected") pass.undecided.push(what);
    return out;
  }

  /**
   * The lane's decision on an order waiting for approval: accept, or reject
   * at once when it cannot be served — never let it time out.
   *
   * Only while Liquidity provision is on, asked live — before anything is
   * decided and again after every wait (the capital check, the dial): a
   * paused lane never turns an order down on its own, as it never accepts
   * one (acceptOrder); the order is the operator's (SELLING_OFF_SKIP). D6's
   * immediate reject is a RUNNING lane's. Review of P7: advance() calls this
   * on the settings read before the order's Amboss read, and the capital
   * check and the buyer's dial (up to ~90 s over Tor) are awaited — a pause
   * in any of them still sent RejectOrder ("the buyer's node is
   * unreachable", "not enough on-chain capital", or "could not decide on it
   * in time" near the deadline).
   *
   * Never an order the operator took into their own hands (byHand): theirs
   * to decide, whatever the switch says — advance() brings one here only so
   * its record says so (MANUAL_ACCEPT_SKIP); their reject is carried out
   * before it gets here (advance). With selling off, advance() and
   * resumeAccept bring here the lane's own accept that was handed back, too
   * — only so its record says that the order is the operator's now
   * (SELLING_OFF_SKIP), not "within your caps and capital" (review of P10).
   */
  private async decide(order: SaleOrderDetail, pass: LanePass): Promise<MagmaSellAction[]> {
    const entry =
      this.journal.get(order.id) ??
      this.journal.create({
        orderId: order.id,
        via: "autopilot",
        buyerPubkey: order.buyerPubkey,
        sizeSats: order.sizeSats,
        isPrivate: order.isPrivate,
        feeMsat: String(this.invoiceMsat(order)),
      });
    entry.lastStatus = order.status;
    entry.timeout = order.timeout;
    if (order.timeout !== null && Date.parse(order.timeout) <= Date.now()) {
      return [this.skip(entry, "the approval deadline has passed")];
    }
    // An accept of the operator's that didn't go through: the lane neither
    // accepts the order nor applies its caps to it — they don't bind a manual
    // pick. Asked before the switch: with selling off too, the record says
    // what holds the order (not "switched off before it was accepted"). Review
    // of P8, final round: an accept clicked for an order above the caps,
    // failing on an LND blink, was turned down by the next pass — silently,
    // as the operator's record raises no alert.
    if (entry.via === "manual") return [this.skip(entry, MANUAL_ACCEPT_SKIP)];
    const sellingOff = () => !this.deps.config().sellEnabled;
    if (sellingOff()) return [this.skip(entry, SELLING_OFF_SKIP)];
    if (order.assetType !== "BASE_ASSET") return this.rejectOrder(entry, `not a bitcoin channel (${order.assetType})`);
    if (!/^[0-9a-f]{66}$/i.test(order.buyerPubkey)) return this.rejectOrder(entry, "the order names no valid buyer node");
    if (order.sizeSats <= 0) return this.rejectOrder(entry, "the order has no channel size");
    const fee = this.invoiceMsat(order);
    if (fee <= 0n) {
      // Amboss can match an order to this node at 0 sats (2026-10-23: a
      // 1.95M sat order, every fee part 0, while a partial offer update had
      // left the fee rate at 0). Nothing to earn: turned down at once (D6) —
      // after one more look a minute in — not left waiting for its deadline.
      const placed = Date.parse(order.createdAt);
      if (Number.isFinite(placed) && Date.now() - placed < ZERO_FEE_GRACE_MS && !this.nearDeadline(order, REJECT_MARGIN_MS)) {
        return [this.skip(entry, "Amboss reports no fee for this order yet — looked at again in a minute")];
      }
      return this.rejectOrder(entry, "Amboss priced it at 0 sats for this node — there is nothing to earn");
    }
    // fees.seller reads 0 while its parts don't: the lane bills the parts only
    // when they are an offer's price for the order's size. Anything else —
    // more than Amboss pays out, or less than the order earns — is not billed
    // here: the order is the operator's to judge, neither accepted nor turned
    // down by the lane (review 2026-10-25: the parts were billed unchecked).
    const unmatched = this.partsUnmatched(order);
    if (unmatched) return [this.skip(entry, unmatched)];
    // Never at a loss, however the order came to be priced so (an offer listed
    // too low for a while, a price set elsewhere): what it pays must at least
    // cover opening and closing its channel on chain.
    const floorSats = await this.acceptFloorSats();
    if (fee < BigInt(floorSats) * 1000n) {
      return this.rejectOrder(
        entry,
        `it pays ${(Number(fee) / 1000).toLocaleString("en-US")} sat — less than opening and closing its channel costs on chain now (${floorSats.toLocaleString("en-US")} sat)`,
      );
    }
    // That read is awaited: the switch, again.
    if (sellingOff()) return [this.skip(entry, SELLING_OFF_SKIP)];
    // Cheap capital check first: no point dialing a buyer we must turn down.
    let lacking: Lacking | null;
    try {
      lacking = await this.capitalFor(order.sizeSats, { caps: true, exceptKey: `magma:${order.id}`, pass });
    } catch (err) {
      // A key Amboss refuses now: the pass turns to LND alone (advance).
      if (isAuthError(err) && !(await this.keyStillValid(pass))) throw err;
      if (isQueryRejected(err)) pass.problem ??= queryRejectedText(err);
      // Paused while the check ran: not undecided — the operator's to decide
      // (never "could not decide on it in time" near the deadline).
      if (sellingOff()) return [this.skip(entry, SELLING_OFF_SKIP)];
      return this.undecided(entry, order, capitalCheckFailed(err), pass);
    }
    // The check is awaited (LND's wallet, maybe Amboss's listing).
    if (sellingOff()) return [this.skip(entry, SELLING_OFF_SKIP)];
    if (lacking) return this.rejectOrder(entry, lacking.reason, lacking.kind);
    const reached = await this.connectBuyer(order);
    // Dialing the buyer can take a minute and a half over Tor: Liquidity
    // provision may have been switched off — or all automation paused —
    // meanwhile (review of P7: the lane accepted on the switch it read when
    // the pass began, and turned the order down when the dial then failed).
    // Then nothing is promised and nothing refused: the order waits for the
    // operator's decision on Market → Orders. (acceptOrder asks again after
    // each of its own waits, up to the moment the accept goes out.)
    if (sellingOff()) return [this.skip(entry, SELLING_OFF_SKIP)];
    if (!reached.ok && reached.blocked) {
      // LND won't list its peers to the write macaroon (no peers:read): the
      // buyer's connection can't be checked, and no channel could be opened
      // for it. Still turned down at once (D6) — never left to time out —
      // but for what it is: this node's setup, not the buyer (before: "the
      // buyer's node is unreachable", for every order). The lane says it too.
      pass.problem ??= reached.blocked;
      return this.rejectOrder(entry, `this node can't check its connection to the buyer: ${reached.blocked}`);
    }
    if (!reached.ok) return this.rejectOrder(entry, "the buyer's node is unreachable");
    if (this.stopping) return [this.skip(entry, "shutting down")];
    return this.acceptOrder(entry, order, fee, "autopilot", pass);
  }

  /** The accept floor (deps.saleFloorSats) in whole sats; 0 without one. */
  private async acceptFloorSats(): Promise<number> {
    const floor = this.deps.saleFloorSats ? await this.deps.saleFloorSats() : 0;
    return Number.isFinite(floor) && floor > 0 ? Math.ceil(floor) : 0;
  }

  /**
   * Why the lane can't bill an order's fee parts — or null: fees.seller reads
   * more than 0 (it is billed), or the parts (fixed + variable) are an offer's
   * price for the order's size, fee rate × size + base, to within a sat — of
   * an offer of this node, at a price it asks or asked lately. fees.seller
   * is what Amboss pays out: an invoice above it is never paid, one below it
   * earns less. (Not seen live: the 0 order of 2026-10-23 had every part 0.)
   */
  private partsUnmatched(order: SaleOrder): string | null {
    if ((msatOf(order.fees.seller) ?? 0n) > 0n) return null;
    const parts = Number(this.invoiceMsat(order)) / 1000;
    const prices = this.deps.offerPrices?.() ?? [];
    const at = prices.map((p) => orderFeeSat(p.feeRatePpm, p.baseFeeSats, order.sizeSats));
    if (at.some((sats) => Math.abs(sats - parts) <= PARTS_MATCH_SATS)) return null;
    const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
    const distinct = [...new Set(at.map(fmt))];
    const yours = distinct.length ? ` (your price${distinct.length === 1 ? "" : "s"}: ${distinct.join(" or ")} sat)` : "";
    return (
      `Amboss shows no amount for this order, and its fee parts — ${fmt(parts)} sat — aren't your price for a ${fmt(order.sizeSats)} sat channel${yours}: ` +
      "the lane doesn't accept it; accept or reject it on Market → Orders"
    );
  }

  private skip(entry: MagmaJournalEntry, reason: string): MagmaSellAction {
    entry.decision = { at: now(), action: "skip", reason };
    this.journal.note(entry);
    return { orderId: entry.orderId, action: "skip", sizeSats: entry.sizeSats, ok: false, error: reason };
  }

  // ── accept ─────────────────────────────────────────────────────────────────

  /**
   * Accept with a HODL invoice. Each step is saved before the next external
   * action: reserve the coins + save the preimage (under the mutex, so two
   * accepts can't promise the same coins) → create the invoice → save its
   * request → send accept → save the result.
   *
   * Only a journal that can't be saved turns the buyer away at once (an
   * accept whose preimage isn't on disk could never be settled). An LND read
   * failing in the capital check — the balance, the channel list — is no
   * reason to: nothing was reserved or created, the order stays "seen", and
   * the next pass decides afresh (undecided) — unless its approval deadline
   * is close by then, when it is rejected rather than left to time out. A
   * click is told LND's error. (Before, any error in here was reported as
   * "cannot save the order journal" and the order rejected — a blink of LND
   * cost a sale and seller reputation.) `pass`: the lane's, or null for a
   * click.
   */
  private async acceptOrder(
    entry: MagmaJournalEntry,
    order: SaleOrderDetail,
    feeMsat: bigint,
    via: "autopilot" | "manual",
    pass: LanePass | null,
  ): Promise<MagmaSellAction[]> {
    const fail = (error: string): MagmaSellAction => ({ orderId: entry.orderId, action: "accept", sizeSats: entry.sizeSats, ok: false, error, ...theirs(entry) });
    // The lane's accept is selling's: it goes on only while Liquidity
    // provision is on, asked after every wait and read — so that nothing is
    // awaited between the last check and the step it guards (review of P7,
    // round 2: a pause that landed during the capital re-read, or while the
    // HODL invoice was made, still accepted the order). Switched off, the
    // order is the operator's: the lane neither accepts nor rejects it. A
    // click is the operator's own decision.
    const sellingOff = () => via === "autopilot" && !this.deps.config().sellEnabled;
    const secret = newHodlSecret();
    const step = await this.deps.capital.mutex.run(
      "magma accept",
      async (): Promise<{ lacking: Lacking } | { unsaved: string } | { unchecked: unknown } | { off: true } | null> => {
        // The wait for the mutex can be long (an open broadcasting).
        if (sellingOff()) return { off: true };
        // The deploy-cap listing was refreshed just before (decide): no slow
        // Amboss call while the on-chain mutex is held.
        let lacking: Lacking | null;
        try {
          lacking = await this.capitalFor(order.sizeSats, { caps: via === "autopilot", exceptKey: `magma:${entry.orderId}`, refresh: false });
        } catch (err) {
          return sellingOff() ? { off: true } : { unchecked: err }; // nothing changed yet
        }
        // The re-read (LND's balance and channels) is awaited: the switch
        // again, before anything is reserved — or the order turned down.
        if (sellingOff()) return { off: true };
        if (lacking) return { lacking };
        entry.via = via;
        entry.phase = "accepting";
        entry.sizeSats = order.sizeSats;
        entry.isPrivate = order.isPrivate;
        entry.buyerPubkey = order.buyerPubkey;
        entry.feeMsat = String(feeMsat);
        entry.leaseBlocks = order.promises.minBlockLength || null;
        entry.feeRateCapPpm = order.promises.feeRateCapPpm;
        entry.baseFeeCapSats = order.promises.baseFeeCapSats;
        entry.invoice = {
          id: secret.id,
          secret: secret.secret,
          request: null,
          expiresAt: new Date(Date.now() + HODL_EXPIRY_MS).toISOString(),
          cltvDelta: HODL_CLTV_DELTA,
        };
        // A new attempt: its accept has not gone out (sendAccept marks it).
        entry.acceptSentAt = undefined;
        entry.acceptAttempts += 1;
        entry.decision = { at: now(), action: "accept", reason: via === "manual" ? ACCEPTED_BY_YOU : "within your caps and capital" };
        this.journal.event(entry, "accepting: preimage saved");
        try {
          this.journal.commit(entry);
        } catch (err) {
          // Not on disk: nothing is reserved and nothing created — undone
          // before the mutex is released, so no other check sees it reserved.
          this.backToSeen(entry);
          return { unsaved: msg(err) };
        }
        return null;
      },
    );
    if (step && "off" in step) return [this.skip(entry, SELLING_OFF_SKIP)];
    if (step && "unchecked" in step) {
      if (via === "manual" || !pass) throw step.unchecked; // the click is told; nothing changed
      return this.undecided(entry, order, capitalCheckFailed(step.unchecked), pass);
    }
    if (step && "unsaved" in step) {
      const reason = `cannot save the order journal (${step.unsaved}) — not accepting`;
      this.noteError(entry, reason);
      return via === "autopilot" ? [fail(reason), ...(await this.rejectOrder(entry, reason))] : [fail(reason)];
    }
    if (step) return via === "autopilot" ? this.rejectOrder(entry, step.lacking.reason, step.lacking.kind) : [fail(step.lacking.reason)];
    const made = await this.ensureInvoice(entry);
    // Making the invoice is awaited too: the switch, once more, right before
    // the accept goes out. (A failed invoice left nothing reserved either.)
    if (sellingOff()) return [made ? await this.withdrawAccept(entry) : this.skip(entry, SELLING_OFF_SKIP)];
    if (!made) return this.invoiceFailed(entry, order, pass);
    return this.sendAccept(entry, order, pass);
  }

  /**
   * Selling was switched off — or all automation paused — after the lane's
   * accept had reserved the coins and made the HODL invoice, but before the
   * accept went out: nothing was offered to Amboss, so nothing is promised.
   * The coins are free again, the invoice is released (nobody but this node
   * has its request; if LND can't cancel it now, it expires unpaid), and the
   * order waits for the operator's decision on Market → Orders, as one the
   * lane never took up.
   */
  private async withdrawAccept(entry: MagmaJournalEntry): Promise<MagmaSellAction> {
    const inv = entry.invoice;
    // An error of an earlier attempt (an accept Amboss refused, a read that
    // failed) goes with it: what holds the order now is SELLING_OFF_SKIP.
    this.backToSeen(entry);
    // Never sent: the count of accepts Amboss refused stays true (MAX_ACCEPT_ATTEMPTS).
    entry.acceptAttempts = Math.max(0, entry.acceptAttempts - 1);
    this.journal.event(entry, "Liquidity provision was switched off before the accept was sent — its invoice was released, nothing promised");
    const skipped = this.skip(entry, SELLING_OFF_SKIP); // saved: the reservation is gone on disk too
    if (inv) await this.lndCancel(inv.id).catch(() => undefined);
    return skipped;
  }

  /**
   * LND could not make (or find) the order's HODL invoice — or the accept's
   * mark could not be saved (unmarkedAccept): nothing Amboss holds us to was
   * offered (unmarkedAccept says why for a resend), the order is back to
   * "seen", nothing reserved. A running lane tries again on its next pass;
   * with the approval deadline close, it rejects the order instead of
   * leaving it to time out. A paused lane — Liquidity provision
   * off, or all automation paused, asked live — turns nothing down on its
   * own: the order is the operator's (SELLING_OFF_SKIP), as in decide(). A
   * click is only told. (Review of P8, round 2: a resend whose mark couldn't
   * be saved, the lane paused since the first send, was rejected near its
   * deadline with a "turned down" alert — the one reject path left that
   * didn't ask the switch.)
   *
   * An accept of the operator's that the lane carries on (resumeAccept: one
   * under way when the process stopped, say) is theirs whatever the switch
   * says (byHand): never turned down here, near its deadline or not — and
   * its record says at once that it didn't go through, as a click's does
   * (accept), not "accepted by you" for an order back at "seen" until the
   * next pass.
   */
  private async invoiceFailed(entry: MagmaJournalEntry, order: SaleOrder, pass: LanePass | null): Promise<MagmaSellAction[]> {
    const error = entry.lastError ?? "could not create the HODL invoice";
    const failed: MagmaSellAction = { orderId: entry.orderId, action: "accept", sizeSats: entry.sizeSats, ok: false, error, ...theirs(entry) };
    if (!pass) return [failed];
    if (entry.via === "manual") {
      this.skip(entry, MANUAL_ACCEPT_SKIP);
      return [failed];
    }
    if (!this.deps.config().sellEnabled) {
      this.skip(entry, SELLING_OFF_SKIP);
      return [failed];
    }
    const rejected = await this.rejectUndecided(entry, order, error, pass);
    if (rejected) return [failed, ...rejected];
    pass.undecided.push(error);
    return [failed];
  }

  /** Make sure the HODL invoice for the saved preimage exists in LND and its
   *  request is saved — resumes cleanly after a crash at any point. */
  private async ensureInvoice(entry: MagmaJournalEntry): Promise<boolean> {
    const inv = entry.invoice;
    if (!inv) return false;
    if (inv.request) return true;
    try {
      const st = await this.lndHodlStatus(inv.id);
      if (st.state === "open" && st.request) {
        inv.request = st.request; // created before a crash; only its record was lost
      } else if (st.state === "missing") {
        const { request } = await this.lndCreateHodl({
          id: inv.id,
          mtokens: entry.feeMsat,
          description: orderMemo(entry.orderId),
          expiresAt: inv.expiresAt,
          cltvDelta: inv.cltvDelta,
        });
        inv.request = request;
      } else {
        throw new Error(`the order's invoice is already ${st.state}`);
      }
      this.journal.event(entry, "HODL invoice created");
      this.journal.commit(entry);
      return true;
    } catch (err) {
      // Nothing was promised to Amboss yet: drop the invoice and start over.
      await this.lndCancel(inv.id).catch(() => undefined);
      this.backToSeen(entry);
      this.noteError(entry, `could not create the HODL invoice: ${msg(err)}`);
      return false;
    }
  }

  /**
   * Send the accept. `acceptSentAt` is on disk BEFORE it goes out: after a
   * crash, resumeAccept tells an accept that may have reached Amboss (it is
   * completed, as the step under way) from one that never left (with selling
   * off since, it is withdrawn — review of P7: nothing recorded whether the
   * accept went out, so a lane paused before a crash still sent it after the
   * restart). A marker that can't be saved sends nothing — the journal's
   * rule for every external step (unmarkedAccept). `pass`: the lane's, or
   * null for a click.
   */
  private async sendAccept(entry: MagmaJournalEntry, order: SaleOrder, pass: LanePass | null): Promise<MagmaSellAction[]> {
    const inv = entry.invoice!;
    const base = { orderId: entry.orderId, action: "accept" as const, sizeSats: entry.sizeSats, ...theirs(entry) };
    const sentBefore = entry.acceptSentAt;
    entry.acceptSentAt = now();
    this.journal.event(entry, "sending the accept");
    try {
      this.journal.commit(entry);
    } catch (err) {
      entry.acceptSentAt = sentBefore;
      return this.unmarkedAccept(entry, order, pass, msg(err), sentBefore !== undefined);
    }
    let ok: boolean;
    try {
      ok = await this.ambossAccept(this.deps.amboss.getKey(), entry.orderId, inv.request!);
    } catch (err) {
      // A refused key, or a request Amboss rejected as such (not applied):
      // the pass deals with those (key check, lane status).
      if (isAuthError(err) || isQueryRejected(err)) throw err;
      // Maybe applied, maybe not: the next pass asks Amboss (resumeAccept).
      this.noteError(entry, `accept not confirmed (${msg(err)}) — checking with Amboss on the next pass`);
      return [{ ...base, ok: false, error: entry.lastError }];
    }
    if (ok) {
      this.toPhase(entry, "accepted", "Amboss confirmed the accept");
      return [{ ...base, ok: true }];
    }
    // Refused: release the unused invoice; the lane may try again (bounded).
    await this.lndCancel(inv.id).catch(() => undefined);
    this.backToSeen(entry);
    this.noteError(entry, "Amboss refused the accept");
    if (entry.acceptAttempts >= MAX_ACCEPT_ATTEMPTS && entry.via === "autopilot") {
      // Paused while the accept was out: no reject of the lane's own — the
      // order (nothing promised: the invoice is released) is the operator's.
      if (!this.deps.config().sellEnabled) {
        this.skip(entry, SELLING_OFF_SKIP);
        return [{ ...base, ok: false, error: "Amboss refused the accept" }];
      }
      const rejected = await this.rejectOrder(entry, `Amboss refused the accept ${entry.acceptAttempts} times`);
      return rejected.length ? rejected : [{ ...base, ok: false, error: "Amboss refused the accept" }];
    }
    // The operator's accept, sent again by the lane (resumeAccept): the bound
    // above is the lane's — their order is never turned down for it (byHand),
    // and its record says at once that the accept didn't go through, as a
    // click's does (accept), not "accepted by you" until the next pass.
    if (entry.via === "manual" && pass) this.skip(entry, MANUAL_ACCEPT_SKIP);
    return [{ ...base, ok: false, error: "Amboss refused the accept" }];
  }

  /**
   * The accept's mark could not be saved (a full disk, say), so the accept
   * is not sent: one that went out unmarked could, after a crash, be
   * withdrawn while Amboss holds us to it. Nothing is kept for it — the
   * invoice is released, the coins are free, the order is back to "seen" as
   * a failed invoice leaves it — and that withdraws nothing Amboss holds us
   * to. On a first send nothing reached Amboss: nobody but this node has the
   * invoice's request. On a resend (`resent`) the earlier send of this
   * attempt went out, marked, and may well have handed Amboss the request —
   * but Amboss has not applied it: only resumeAccept resends, and it is
   * called only while the order, read from Amboss just before (the lane's
   * pass in advance(), or a click's accept), still awaits the seller's
   * approval. An accept Amboss applied moves the order on, and the pass
   * takes it as accepted instead. The attempt is not counted — unless it was
   * a resend: its earlier send went out, and that one counts
   * (MAX_ACCEPT_ATTEMPTS). Then as invoiceFailed: a running lane decides
   * afresh on its next pass, and with the approval deadline close it rejects
   * the order rather than leave it to time out on us (D6); the lane's status
   * says why meanwhile. A paused lane leaves the order to the operator. A
   * click — or an order taken on by hand — is only told. (Review of P8: the
   * entry stayed "accepting" with its invoice open in LND, tried again every
   * pass until the order timed out — SELLER_FAILED_TO_REACT, the
   * seller-score hit D6 exists to prevent. Round 3: this said nothing had
   * been offered, which a resend's earlier send may have done.)
   */
  private async unmarkedAccept(
    entry: MagmaJournalEntry,
    order: SaleOrder,
    pass: LanePass | null,
    error: string,
    resent: boolean,
  ): Promise<MagmaSellAction[]> {
    const inv = entry.invoice;
    this.backToSeen(entry);
    if (!resent) entry.acceptAttempts = Math.max(0, entry.acceptAttempts - 1);
    this.noteError(entry, `cannot save the order journal (${error}) — the accept was not sent and its invoice was released`);
    if (inv) await this.lndCancel(inv.id).catch(() => undefined);
    return this.invoiceFailed(entry, order, pass);
  }

  /**
   * An accept under way when the last pass (or process) stopped, and the
   * order still waits for approval. Sent — maybe it reached Amboss (a
   * timeout, a crash after `acceptSentAt` was saved): sent again with the
   * same invoice while that still has its 48 h — the step under way is
   * completed, whatever the switch says now. Never sent (a crash between the
   * invoice and the accept): with Liquidity provision off since — or all
   * automation paused — the lane's accept is withdrawn as if the pause had
   * come before it (withdrawAccept: back to "seen", coins and invoice
   * released, the attempt not counted); a click's is the operator's own and
   * goes on. An invoice older than that: start over. `pass`: the lane's, or
   * null for a click.
   *
   * The switch is asked before the invoice is checked and again after: when
   * a crash lost the invoice's request, ensureInvoice asks LND for it — an
   * await, during which a pause can land — and acceptOrder, too, asks after
   * its own invoice wait. (Review of P8, round 2: a pause during that lookup
   * still sent the lane's never-sent accept.)
   */
  /** An accept whose invoice is gone, or too old to be sent again. */
  private acceptStale(entry: MagmaJournalEntry): boolean {
    const inv = entry.invoice;
    return !inv || Date.parse(inv.expiresAt) - Date.now() < MIN_INVOICE_LIFE_MS;
  }

  /** A stale accept (acceptStale) released: its invoice cancelled, the order
   *  back to "seen". Nothing checks this accept again: its "checking with
   *  Amboss on the next pass" goes with it (backToSeen). Review of P9, final
   *  round: it stayed, shown before MANUAL_ACCEPT_SKIP on Market → Orders and
   *  in the recent orders, while the order waited for the operator. */
  private async releaseStaleAccept(entry: MagmaJournalEntry): Promise<void> {
    const inv = entry.invoice;
    if (inv) await this.lndCancel(inv.id).catch(() => undefined);
    this.backToSeen(entry);
    this.journal.event(entry, "earlier accept never confirmed; its invoice was released");
    this.journal.note(entry);
  }

  private async resumeAccept(entry: MagmaJournalEntry, order: SaleOrderDetail, pass: LanePass | null): Promise<MagmaSellAction[]> {
    if (this.acceptStale(entry)) {
      await this.releaseStaleAccept(entry);
      // The lane's pass takes the order up afresh, as advance() does
      // (decide): a running lane decides on it again; one of the operator's
      // goes back to them, and so does one of the lane's own with selling
      // off — each said on its record (MANUAL_ACCEPT_SKIP, SELLING_OFF_SKIP).
      // A click repeats its accept itself. (Review of P10: with selling off,
      // the lane's own kept "within your caps and capital" for an order
      // nothing of ours was tied to.)
      if (!pass) return [];
      return this.decide(order, pass);
    }
    // The lane's own accept that never went out, with selling off by now.
    const toWithdraw = () => !entry.acceptSentAt && entry.via === "autopilot" && pass !== null && !this.deps.config().sellEnabled;
    if (toWithdraw()) return [await this.withdrawAccept(entry)];
    if (!(await this.ensureInvoice(entry))) return this.invoiceFailed(entry, order, pass);
    if (toWithdraw()) return [await this.withdrawAccept(entry)];
    return this.sendAccept(entry, order, pass);
  }

  // ── reject ─────────────────────────────────────────────────────────────────

  /** Turn an order down with Amboss. `kind`: what the refusal was about —
   *  the caps or the wallet (the alert then says raising the caps or funding
   *  the wallet would serve orders like it), or anything else (an unreachable
   *  buyer, an asset or a fee Amboss didn't report, a deadline: more capital
   *  wouldn't have helped, and the alert doesn't say it would). */
  private async rejectOrder(entry: MagmaJournalEntry, reason: string, kind: RefusalKind = "other"): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "reject" as const, sizeSats: entry.sizeSats, ...theirs(entry) };
    entry.decision = { at: now(), action: "reject", reason };
    let ok: boolean;
    try {
      ok = await this.ambossReject(this.deps.amboss.getKey(), entry.orderId);
    } catch (err) {
      // A refused key, or a request Amboss rejected as such (not applied):
      // the pass deals with those (key check, lane status).
      if (isAuthError(err) || isQueryRejected(err)) throw err;
      this.noteError(entry, `reject not confirmed (${msg(err)}) — will try again`);
      return [{ ...base, ok: false, error: `${reason} — reject failed: ${msg(err)}` }];
    }
    if (!ok) {
      this.noteError(entry, "Amboss refused the reject");
      return [{ ...base, ok: false, error: `${reason} — Amboss refused the reject` }];
    }
    entry.reason = reason;
    entry.refusalKind = kind;
    this.toPhase(entry, "rejected", `rejected: ${reason}`);
    console.log(`[magma] rejected order ${entry.orderId}: ${reason}`);
    return [{ ...base, ok: true, error: reason }];
  }

  // ── held → open → report ───────────────────────────────────────────────────

  /** Is the buyer's payment held by our invoice? */
  private async checkHeld(entry: MagmaJournalEntry): Promise<MagmaSellAction[]> {
    if (!entry.invoice) return [];
    const st = await this.lndHodlStatus(entry.invoice.id);
    if (st.state === "held" && st.heldMtokens >= BigInt(entry.feeMsat || "0")) {
      entry.heldAt = now();
      entry.heldUntilHeight = st.heldUntilHeight;
      this.toPhase(entry, "held", `buyer's payment held (${feeSatsOf(entry)} sat)`);
    } else if (st.state === "canceled" || st.state === "missing") {
      return this.release(entry, "the invoice expired or was cancelled before the buyer paid");
    } else if (st.state === "settled") {
      // Only we settle, and only after Amboss confirmed: recover the record.
      entry.settledAt = now();
      this.book(entry);
      this.toPhase(entry, "settled", "payment found settled");
    }
    return [];
  }

  /** WAITING_FOR_CHANNEL_OPEN: open (when allowed), then report. */
  private async fulfil(
    entry: MagmaJournalEntry,
    order: SaleOrderDetail,
    how: { auto: boolean; manual?: boolean },
  ): Promise<MagmaSellAction[]> {
    const out: MagmaSellAction[] = [];
    if (entry.phase === "accepting" || entry.phase === "accepted") {
      if (entry.phase === "accepting") this.journal.event(entry, "Amboss shows the order accepted and paid");
      out.push(...(await this.checkHeld(entry)));
      // (checkHeld moves the phase on — read it afresh, not as narrowed above)
      if (phaseOf(entry) !== "held") {
        if (!TERMINAL_PHASES.has(entry.phase)) {
          entry.decision = { at: now(), action: "wait", reason: "Amboss says paid, but our invoice holds no payment yet" };
          this.journal.note(entry);
        }
        return out;
      }
    }
    if (entry.phase === "opening") await this.reconcileOpening(entry);
    if (entry.phase === "held") {
      if (!how.auto && !how.manual) {
        entry.decision = { at: now(), action: "wait", reason: "payment held — waiting for you to open the channel" };
        this.journal.note(entry);
        return out;
      }
      out.push(...(await this.openFor(entry, order)));
    }
    if (entry.phase === "funded") {
      out.push(...(await this.report(entry)));
    } else if (entry.phase === "reported" && entry.reportedAt && Date.now() - Date.parse(entry.reportedAt) > REPORT_RESEND_MS) {
      // Amboss said yes long ago but still waits for the transaction: tell it again.
      entry.phase = "funded";
      out.push(...(await this.report(entry)));
    }
    return out;
  }

  /**
   * Open the channel for a held order. The buyer is dialed first, OUTSIDE the
   * on-chain mutex — over Tor that can take a minute and a half, and it must
   * not hold up anyone else's open or a Magma accept's capital check. Inside
   * the mutex: the payment is checked once more, then the capital; the intent
   * is saved before the open and the outpoint right after.
   */
  private async openFor(entry: MagmaJournalEntry, order: SaleOrderDetail): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "open" as const, sizeSats: entry.sizeSats };
    const unfit = await this.cannotOpen(entry, order);
    if (unfit) return unfit;
    const reached = await this.connectBuyer(order);
    // A macaroon LND won't list peers to blocks every open — the operator's
    // to fix (and restart): the payment stays held while there is time, as
    // for a buyer that is away, and is released with this reason after.
    if (!reached.ok) {
      return reached.blocked ? this.openFailed(entry, order, reached.blocked, true) : this.openFailed(entry, order, couldNotConnect(entry.buyerPubkey));
    }
    if (this.stopping) return [{ ...base, ok: false, error: "shutting down" }];
    return this.deps.capital.mutex.run("magma open", async (): Promise<MagmaSellAction[]> => {
      if (entry.phase !== "held") return []; // someone else got here first
      // Again: dialing took a while, and LND may have released the payment.
      const gone = await this.cannotOpen(entry, order);
      if (gone) return gone;
      const lacking = await this.capitalFor(entry.sizeSats, { caps: false, exceptKey: `magma:${entry.orderId}` });
      if (lacking) return this.openFailed(entry, order, lacking.reason);
      const preExisting = (await channelsWith(this.deps.readLnd, entry.buyerPubkey)).map((c) => c.outpoint);
      if (this.stopping) return [{ ...base, ok: false, error: "shutting down" }];
      entry.phase = "opening";
      entry.opening = { startedAt: now(), preExisting };
      entry.openAttempts += 1;
      this.journal.event(entry, "open started");
      try {
        this.journal.commit(entry);
      } catch (err) {
        entry.phase = "held";
        entry.opening = undefined;
        const reason = `cannot save the order journal (${msg(err)}) — not opening`;
        this.noteError(entry, reason);
        return [{ ...base, ok: false, error: reason }];
      }
      // Nothing is awaited between the save above and the open: a shutdown
      // that began meanwhile still finds this open on the record.
      const res = await this.lndOpen({
        pubkey: entry.buyerPubkey,
        sockets: order.sockets,
        localTokens: entry.sizeSats,
        isPrivate: entry.isPrivate,
        // Its order's tag — what finds it again (findOurOpen) — and a routing
        // fee from the start: a new channel's, within the lease's promise
        // (review 2026-10-25: LND's default 1 sat + 1 ppm until something
        // set a fee — forever, with fee automation off).
        description: saleTag("magma", entry.orderId),
        ...this.startingRoutingFee(entry),
      });
      if (res.ok && res.transactionId) {
        this.recordFunding(entry, `${res.transactionId}:${res.transactionVout ?? 0}`);
        return [{ ...base, ok: true, transactionId: res.transactionId }];
      }
      // An error after the broadcast must not lead to a second open.
      const opened = await this.findOurOpen(entry).catch(() => null);
      if (opened) {
        this.recordFunding(entry, opened);
        return [{ ...base, ok: true, transactionId: opened.split(":")[0] }];
      }
      const error = res.error ?? "channel open failed";
      if (!isPreBroadcastRefusal(error)) {
        // Not a refusal LND gives before funding (a dropped stream, a timeout,
        // an error we don't know): the funding transaction may exist without
        // LND showing it yet. Stay "opening" — reconcileOpening adopts the
        // channel once LND shows it, and only after LND has had ample time to
        // (OPENING_GRACE_MS) may anything else happen: a second open, or
        // releasing the payment while a channel appears (a free channel).
        entry.opening = { ...(entry.opening ?? { startedAt: now(), preExisting }), unclear: error };
        this.noteError(entry, `the open's outcome is unclear (${error}) — waiting for LND to show the channel before anything else`);
        return [{ ...base, ok: false, error: entry.lastError }];
      }
      entry.phase = "held";
      entry.opening = undefined;
      return this.openFailed(entry, order, error);
    });
  }

  /**
   * Reasons not to open now, each with the buyer's payment released: no
   * time left for another attempt, a payment no longer held (LND releases a
   * held HTLC on its own shortly before it expires), or one that would not
   * stay held until the channel is confirmed and validated. Null: go ahead.
   */
  private async cannotOpen(entry: MagmaJournalEntry, order: SaleOrder): Promise<MagmaSellAction[] | null> {
    const base = { orderId: entry.orderId, action: "open" as const, sizeSats: entry.sizeSats };
    if (entry.openAttempts > 0 && !this.timeLeftToOpen(entry, order)) {
      return [{ ...base, ok: false, error: "no time left to open the channel" }, ...(await this.release(entry, "the channel could not be opened in time"))];
    }
    if (!entry.invoice) return null; // paid by a plain invoice (before the journal): nothing held
    const st = await this.lndHodlStatus(entry.invoice.id);
    if (st.state !== "held") {
      return [{ ...base, ok: false, error: "the buyer's payment is no longer held" }, ...(await this.release(entry, `the buyer's payment is no longer held (${st.state})`))];
    }
    const height = (await getWalletInfo({ lnd: this.deps.readLnd })).current_block_height;
    const until = st.heldUntilHeight ?? entry.heldUntilHeight ?? null;
    if (until !== null && until - height < OPEN_MIN_BLOCKS_LEFT) {
      return [
        { ...base, ok: false, error: "the held payment expires too soon" },
        ...(await this.release(
          entry,
          `the held payment would expire before the channel could be confirmed (${Math.max(0, until - height)} blocks left, ${OPEN_MIN_BLOCKS_LEFT} needed)`,
        )),
      ];
    }
    return null;
  }

  /** A failed open: retried on later passes while it may still work and there
   *  is time; otherwise the held payment is released (buyer refunded).
   *  `retry`: whether it may still work — by default, from the error's words
   *  (isTransientOpen). */
  private async openFailed(entry: MagmaJournalEntry, order: SaleOrder, error: string, retry = isTransientOpen(error)): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "open" as const, sizeSats: entry.sizeSats };
    if (retry && this.timeLeftToOpen(entry, order)) {
      this.noteError(entry, `${error} — will try again`);
      return [{ ...base, ok: false, error: `${error} — will try again` }];
    }
    return [{ ...base, ok: false, error }, ...(await this.release(entry, `channel open failed: ${error}`))];
  }

  private timeLeftToOpen(entry: MagmaJournalEntry, order: SaleOrder): boolean {
    if (order.timeout) return Date.parse(order.timeout) - Date.now() > OPEN_RETRY_MIN_TIME_LEFT_MS;
    const since = entry.heldAt ? Date.parse(entry.heldAt) : Date.now();
    return Date.now() - since < OPEN_RETRY_WINDOW_MS;
  }

  /** The funding outpoint is the record that prevents a second channel: saved
   *  at once. If it can't be saved (disk full), fail closed: it stays in
   *  memory (this process never opens again), an alert says so, and after a
   *  restart the "opening" record on disk leads to the channel in LND. */
  private recordFunding(entry: MagmaJournalEntry, outpoint: string): void {
    entry.phase = "funded";
    entry.fundingOutpoint = outpoint;
    entry.fundedAt = now();
    entry.lastError = undefined;
    this.journal.event(entry, `funded ${outpoint}`);
    try {
      this.journal.commit(entry);
    } catch (err) {
      const detail =
        `Magma order ${entry.orderId}: channel ${outpoint} opened, but it could not be saved (${msg(err)}). ` +
        "It will not be opened again; after a restart it is found in LND.";
      console.error(`[magma] CRITICAL ${detail}`);
      recordStoreIncident(this.deps.dataDir, { file: "magma-orders.json", kind: "unrecorded_open", detail });
    }
  }

  /** The channel this order's open funded, if LND shows one: ours, to the
   *  buyer, of the order's size — and neither there before the open started
   *  nor already tied to another sale (Magma's or LSPS1's: the same buyer may
   *  have bought a channel of the same size there). */
  private async findOurOpen(entry: MagmaJournalEntry): Promise<string | null> {
    const found = await findOpenedChannel(this.deps.readLnd, {
      pubkey: entry.buyerPubkey,
      capacity: entry.sizeSats,
      exclude: [...(entry.opening?.preExisting ?? []), ...this.deps.capital.claimedOutpoints()],
      tag: saleTag("magma", entry.orderId),
    });
    return found?.outpoint ?? null;
  }

  /** The routing fee a sold channel opens with: a new channel's
   *  (deps.initialRoutingFee), never above what its lease promised. */
  private startingRoutingFee(entry: MagmaJournalEntry): { routingFeePpm?: number; routingBaseFeeMsat?: number } {
    const start = this.deps.initialRoutingFee?.();
    if (!start) return {};
    const capPpm = entry.feeRateCapPpm;
    const capBaseMsat = entry.baseFeeCapSats !== null ? entry.baseFeeCapSats * 1000 : null;
    return {
      routingFeePpm: capPpm !== null && capPpm >= 0 ? Math.min(start.feeRatePpm, capPpm) : start.feeRatePpm,
      routingBaseFeeMsat: capBaseMsat !== null && capBaseMsat >= 0 ? Math.min(start.baseFeeMsat, capBaseMsat) : start.baseFeeMsat,
    };
  }

  /**
   * "opening" without an outpoint (a crash mid-open, or an open whose outcome
   * LND left unclear): adopt the channel LND shows, or — once LND has had
   * ample time — conclude no open happened.
   *
   * The lookup and its record happen under the on-chain mutex. A sale's open
   * (Magma's, LSPS1's) holds the mutex from before it asks LND until its
   * funding outpoint is recorded as that sale's, so a lookup under the mutex
   * never meets a channel that LND lists already but whose sale hasn't
   * claimed it yet. Outside the mutex it could: another sale's fresh channel
   * to the same buyer, of the same size, claimed by nobody for a moment —
   * adopted and reported here, while its own sale settles too (one channel,
   * paid for twice). The mutex isn't re-entrant: never call this from inside
   * it (openFor, which holds it, looks with findOurOpen itself).
   */
  private async reconcileOpening(entry: MagmaJournalEntry): Promise<void> {
    await this.deps.capital.mutex.run("magma reconcile", async () => {
      if (entry.phase !== "opening") return;
      const found = await this.findOurOpen(entry);
      if (found) {
        this.journal.event(entry, "the interrupted open's channel was found in LND");
        this.recordFunding(entry, found);
        return;
      }
      const startedAt = entry.opening ? Date.parse(entry.opening.startedAt) : 0;
      if (Date.now() - startedAt < OPENING_GRACE_MS) {
        entry.decision = { at: now(), action: "wait", reason: "an open was under way — waiting for LND to show its channel" };
        this.journal.note(entry);
        return;
      }
      const unclear = entry.opening?.unclear;
      entry.phase = "held";
      entry.opening = undefined;
      this.journal.event(
        entry,
        unclear
          ? `no channel appeared after the unclear open (${unclear}) — it never happened`
          : "no channel appeared for the interrupted open — it never happened",
      );
      this.journal.note(entry);
    });
  }

  /** Report the funding outpoint. The attempt is on the record before it is
   *  sent; a lost answer is resolved by Amboss's status on the next pass. */
  private async report(entry: MagmaJournalEntry): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "report" as const, sizeSats: entry.sizeSats };
    if (this.stopping || !entry.fundingOutpoint) return [];
    entry.reportAttempts += 1;
    entry.reportSentAt = now();
    this.journal.event(entry, "funding transaction sent to Amboss");
    this.journal.note(entry);
    let ok: boolean;
    try {
      ok = await this.ambossAddTx(this.deps.amboss.getKey(), entry.orderId, entry.fundingOutpoint);
    } catch (err) {
      // A refused key, or a request Amboss rejected as such (not applied):
      // the pass deals with those (key check, lane status).
      if (isAuthError(err) || isQueryRejected(err)) throw err;
      this.noteError(entry, `report not confirmed (${msg(err)}) — checking with Amboss on the next pass`);
      return [{ ...base, ok: false, error: entry.lastError }];
    }
    if (!ok) {
      this.noteError(entry, "Amboss did not accept the funding transaction — will report it again");
      return [{ ...base, ok: false, error: entry.lastError }];
    }
    entry.reportedAt = now();
    this.toPhase(entry, "reported", "Amboss accepted the funding transaction");
    return [{ ...base, ok: true, transactionId: entry.fundingOutpoint.split(":")[0] }];
  }

  // ── settle / cancel ────────────────────────────────────────────────────────

  /** Amboss confirmed the channel (VALID_CHANNEL_OPENING or later): claim the
   *  held payment, then book the sale and enqueue its service fee — once. */
  private async settle(entry: MagmaJournalEntry, order: SaleOrderDetail): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "settle" as const, sizeSats: entry.sizeSats };
    if (entry.phase === "opening") await this.reconcileOpening(entry);
    // Opened outside LightningMate (by hand with another tool, say): the
    // channel Amboss names, as LND shows it — so the lease's routing-fee
    // promise binds it and the rebalancer leaves it alone (review
    // 2026-10-25: such a sale was settled, booked and charged with neither).
    if (!entry.fundingOutpoint) await this.adoptReportedChannel(entry, order);
    if (!entry.fundingOutpoint) this.journal.event(entry, `Amboss reports ${order.status} but no funding outpoint is on record here`);
    // Amboss's word alone is never income: only a payment our invoice holds
    // is claimed, booked and charged the service fee.
    if (entry.invoice) {
      const st = await this.lndHodlStatus(entry.invoice.id);
      if (st.state === "held") {
        try {
          await this.lndSettle(entry.invoice.secret);
        } catch (err) {
          const again = await this.lndHodlStatus(entry.invoice.id).catch(() => null);
          if (again?.state !== "settled") {
            this.noteError(entry, `settle failed (${msg(err)}) — will try again`);
            return [{ ...base, ok: false, error: entry.lastError }];
          }
        }
      } else if (st.state === "canceled") {
        entry.reason = "the held payment was released before Amboss confirmed the channel (LND cancels held payments near expiry)";
        entry.cancelledAt = now();
        this.toPhase(entry, "cancelled", entry.reason);
        return [{ orderId: entry.orderId, action: "cancel", sizeSats: entry.sizeSats, ok: true, error: entry.reason }];
      } else if (st.state === "missing") {
        // Gone from LND: nothing can be claimed for this order, ever. It ends
        // here, unbooked — rather than keeping its coins reserved, and the
        // lane asking, for as long as Amboss lists it.
        return this.release(entry, `Amboss reports ${order.status}, but our invoice is gone from LND — nothing to settle, nothing booked`);
      } else if (st.state !== "settled") {
        this.noteError(entry, `Amboss reports ${order.status}, but our invoice is ${st.state} — nothing to settle`);
        return [{ ...base, ok: false, error: entry.lastError }];
      }
    }
    entry.settledAt = now();
    // An order taken on with no fee on record (accepted before the journal,
    // while Amboss still read fees.seller as 0): book what it earns now.
    if (BigInt(entry.feeMsat || "0") === 0n) entry.feeMsat = String(this.invoiceMsat(order));
    // Booked before the "settled" record: a crash in between is recovered on
    // the next pass (the invoice reads settled), and booking twice is a no-op.
    this.book(entry);
    this.toPhase(
      entry,
      "settled",
      entry.invoice ? "payment settled — sale complete" : entry.unbooked ? "channel confirmed — not booked: no payment of ours" : "sale complete",
    );
    console.log(`[magma] order ${entry.orderId} complete: ${entry.sizeSats} sat channel, ${feeSatsOf(entry)} sat earned`);
    return [{ ...base, ok: true, transactionId: entry.fundingOutpoint?.split(":")[0] }];
  }

  /**
   * The channel Amboss reports for an order with no outpoint on record, when
   * LND shows it: ours, to the buyer, at the outpoint (or funding
   * transaction) Amboss names — or with its channel id — and tied to no other
   * sale. Only the outpoint is recorded: no "funded" time (its open was not
   * this node's, and the deploy share counts it from Amboss's listing).
   */
  private async adoptReportedChannel(entry: MagmaJournalEntry, order: SaleOrderDetail): Promise<void> {
    const [txid, vout] = String(order.transactionId ?? "").split(":");
    const channelId = standardChannelId(order.channelId);
    if (!txid && !channelId) return;
    let channels: GetChannelsResult["channels"];
    try {
      channels = (await getChannels({ lnd: this.deps.readLnd, partner_public_key: entry.buyerPubkey })).channels;
    } catch {
      return; // LND didn't answer: the event below says no outpoint is on record
    }
    const claimed = new Set(this.deps.capital.claimedOutpoints());
    const found = channels.find(
      (c) =>
        c.partner_public_key === entry.buyerPubkey &&
        !c.is_partner_initiated &&
        !claimed.has(`${c.transaction_id}:${c.transaction_vout}`) &&
        ((!!txid && c.transaction_id === txid && (vout === undefined || Number(vout) === c.transaction_vout)) || (!!channelId && c.id === channelId)),
    );
    if (!found) return;
    entry.fundingOutpoint = `${found.transaction_id}:${found.transaction_vout}`;
    this.journal.event(entry, `its channel ${entry.fundingOutpoint} was opened outside LightningMate — taken from Amboss and LND`);
  }

  /** Book the completed sale and enqueue the disclosed service fee. Both are
   *  idempotent per order, so a retried or recovered settle never counts twice.
   *  (Saved by the caller.) */
  private book(entry: MagmaJournalEntry): void {
    if (!entry.invoice && !entry.paidInvoiceId) {
      // No invoice of ours held or settled the payment (accepted with another
      // tool's invoice, or outside LightningMate altogether): nothing to book
      // as income, and no service fee on money this node can't show it
      // received. (Before, only orders found with no record here were held
      // to this; an order merely SEEN here was booked on Amboss's word.)
      this.journal.event(entry, "not booked as a sale: LND shows no payment of ours for this order");
      entry.unbooked = true;
      entry.bookedAt = now();
      return;
    }
    const earned = feeSatsOf(entry);
    if (earned > 0) {
      // 0.7.x paid the 1% inline as soon as it had opened the channel — even
      // when Amboss had refused the report — and booked it as feePaidSats.
      // Such an order is completed here now; the fee ledger doesn't know that
      // payment, so it must not be charged a second time.
      const inlineFee = this.deps.earnings.find("magma", entry.orderId)?.feePaidSats ?? 0;
      this.deps.earnings.appendOnce({
        at: now(),
        via: entry.via === "manual" ? "manual" : "autopilot",
        orderId: entry.orderId,
        leaseSats: earned,
        ...(entry.leaseBlocks && entry.leaseBlocks > 0 ? { leaseBlocks: entry.leaseBlocks } : {}),
      });
      if (inlineFee > 0) {
        this.journal.event(entry, `service fee already paid by an earlier version (${inlineFee} sat) — not charged again`);
      } else {
        this.deps.serviceFees.enqueue({ source: "magma", orderId: entry.orderId, earnedSats: earned });
      }
    }
    entry.bookedAt = now();
  }

  /** End an order on our side: cancel the HODL invoice (the buyer's payment
   *  returns automatically) when we hold one. */
  private async release(entry: MagmaJournalEntry, reason: string): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "cancel" as const, sizeSats: entry.sizeSats };
    if (!entry.invoice) {
      entry.reason = reason;
      this.toPhase(entry, "failed", reason);
      return [];
    }
    try {
      await this.lndCancel(entry.invoice.id);
    } catch (err) {
      const st = await this.lndHodlStatus(entry.invoice.id).catch(() => null);
      if (st?.state === "settled") {
        this.noteError(entry, `${reason} — but the payment is already settled here; check this order`);
        return [{ ...base, ok: false, error: entry.lastError }];
      }
      if (st?.state !== "canceled" && st?.state !== "missing") {
        this.noteError(entry, `could not cancel the HODL invoice (${msg(err)}) — will try again`);
        return [{ ...base, ok: false, error: entry.lastError }];
      }
    }
    entry.cancelledAt = now();
    entry.reason = reason;
    this.toPhase(entry, "cancelled", `cancelled: ${reason}`);
    console.warn(`[magma] order ${entry.orderId}: ${reason} — HODL invoice cancelled, the buyer gets the payment back`);
    return [{ ...base, ok: true, error: reason }];
  }

  /** Release a held payment before its HTLC would expire. */
  private async cancelIfExpiring(entry: MagmaJournalEntry): Promise<MagmaSellAction[]> {
    if (!entry.invoice || !entry.heldUntilHeight || !HOLDING.has(entry.phase)) return [];
    const height = (await getWalletInfo({ lnd: this.deps.readLnd })).current_block_height;
    if (height < entry.heldUntilHeight - CANCEL_MARGIN_BLOCKS) return [];
    return this.release(entry, "the held payment was about to expire before Amboss confirmed the channel");
  }

  // ── orders found with no record here ───────────────────────────────────────

  /**
   * An order waiting for its channel that this journal has no record of:
   * accepted by an older version (a plain invoice, settled on payment), with
   * another tool — or by this version, with the record since lost (the
   * journal and its backup damaged). Before anything is recorded or opened,
   * LND says what was paid: the invoices of ours for the order (memo
   * "Magma order <id>", the one every version used).
   *  - One is SETTLED: paid to this node (0.7.x settled on payment). Fulfilled,
   *    and booked once Amboss confirms the channel.
   *  - A HODL invoice still holds (or awaits) the payment: its preimage was
   *    lost with the record, so the payment can never be claimed. Opening gave
   *    the channel away — and booking it, with its service fee, counted money
   *    never received. The invoice is cancelled instead: the buyer gets the
   *    payment back, and the order ends here.
   *  - Only cancelled ones, or a plain one still unpaid: nothing was paid to
   *    this node — no channel.
   *  - None at all: accepted with another tool's invoice. Fulfilled as before,
   *    but not booked — LND shows no payment to book.
   * Then, before any open, LND is asked whether a channel for it exists
   * already: the old code could open one and then fail to report it.
   * Every LND read comes before the record: one that fails leaves nothing
   * behind, and the next pass asks again.
   */
  private async adoptLegacy(order: SaleOrderDetail): Promise<MagmaJournalEntry> {
    const invoices = await this.lndOrderInvoices(order);
    return this.adoptWithInvoices(order, invoices, null);
  }

  /** adoptLegacy, from LND's invoices of ours for the order — into `into`
   *  (an existing "seen" entry, see acceptedElsewhere) or a new record. */
  private async adoptWithInvoices(
    order: SaleOrderDetail,
    invoices: FoundInvoice[],
    into: MagmaJournalEntry | null,
  ): Promise<MagmaJournalEntry> {
    const paid = invoices.find((i) => i.state === "settled");
    const terms = {
      orderId: order.id,
      via: "legacy" as const,
      buyerPubkey: order.buyerPubkey,
      sizeSats: order.sizeSats,
      isPrivate: order.isPrivate,
      timeout: order.timeout,
      leaseBlocks: order.promises.minBlockLength || null,
      feeRateCapPpm: order.promises.feeRateCapPpm,
      baseFeeCapSats: order.promises.baseFeeCapSats,
    };
    if (!paid && invoices.length > 0) return this.endUnpaidLegacy(order, terms, invoices, into);

    const height = (await getWalletInfo({ lnd: this.deps.readLnd })).current_block_height;
    const blocksSince = Math.ceil((Date.now() - Date.parse(order.createdAt)) / 600_000);
    // The lookup and the record under the on-chain mutex, as in
    // reconcileOpening: a channel another sale's open has broadcast but not
    // yet recorded can't be taken for this order's.
    return this.deps.capital.mutex.run("magma adopt", async () => {
      const found = await findOpenedChannel(this.deps.readLnd, {
        pubkey: order.buyerPubkey,
        capacity: order.sizeSats,
        exclude: this.deps.capital.claimedOutpoints(),
        // Funded before the order was placed (with slack for clocks and for
        // blocks faster than 10 minutes: ORDER_HEIGHT_SLACK_*): an older
        // channel of ours to this buyer — a routing one, or a sale whose
        // record was trimmed — never the one this buyer paid for. Review
        // 2026-10-25: 6 blocks of slack missed, a day after the order, the
        // channel opened right after it (158 blocks that day), and a second
        // channel was opened for one payment.
        notBeforeHeight: height - blocksSince - ORDER_HEIGHT_SLACK_BLOCKS - Math.ceil(blocksSince * ORDER_HEIGHT_SLACK_SHARE),
        tag: saleTag("magma", order.id),
      });
      const fields = {
        ...terms,
        // What the paid invoice brought in. Without one, the order's fee:
        // fees.seller reads 0 until Amboss settles it; its parts don't.
        feeMsat: paid && paid.receivedMtokens > 0n ? String(paid.receivedMtokens) : String(this.invoiceMsat(order)),
        phase: "held" as const,
        heldAt: now(),
        paidInvoiceId: paid?.id ?? null,
      };
      const entry = into ? Object.assign(into, fields) : this.journal.create(fields);
      this.journal.event(
        entry,
        paid
          ? `found waiting for its channel with no record here; paid to this node (invoice ${paid.id.slice(0, 12)}… settled)`
          : "found waiting for its channel with no record here, and no invoice of ours for it in LND (accepted with another tool?) — fulfilled, but not booked as a sale",
      );
      if (found) {
        this.journal.event(entry, "a channel for it already exists — reporting that one instead of opening another");
        this.recordFunding(entry, found.outpoint);
      } else {
        this.journal.note(entry);
      }
      return entry;
    });
  }

  /**
   * An order with no record here whose invoices of ours show no payment this
   * node can keep: no channel, and it ends here. Every invoice of ours for it
   * that could still take a payment is cancelled first:
   *  - a HODL invoice, holding the buyer's payment or still payable: its
   *    preimage went with the record, it can never be settled — the buyer
   *    gets the payment back;
   *  - a plain (0.7.x) invoice still unpaid: a plain invoice settles the
   *    moment an HTLC arrives, so a payment in flight, or a late one, would
   *    be kept by this node with no channel, no booking and the order over.
   * LND cancels any invoice that isn't settled. A cancel that fails — say,
   * the invoice settled just now — throws before anything is recorded: the
   * next pass finds it settled and fulfils the order.
   */
  private async endUnpaidLegacy(
    order: SaleOrderDetail,
    terms: Pick<MagmaJournalEntry, "orderId" | "via" | "buyerPubkey" | "sizeSats" | "isPrivate"> & Partial<MagmaJournalEntry>,
    invoices: FoundInvoice[],
    into: MagmaJournalEntry | null = null,
  ): Promise<MagmaJournalEntry> {
    const payable = invoices.filter((i) => i.state === "held" || i.state === "open");
    for (const inv of payable) await this.lndCancel(inv.id);
    const unclaimable = payable.some((i) => i.hold);
    const reason = unclaimable
      ? "its record here was lost, and with it the preimage of its hold invoice: the buyer's payment could never be claimed, so it was released to the buyer instead of opening a channel nobody would pay for"
      : payable.length > 0
        ? "Amboss shows it paid, but its invoice in LND is unpaid — no channel for a payment this node never received (that invoice is cancelled now, so no payment can land on it later)"
        : "its invoice in LND is cancelled — the payment went back to the buyer; no channel is opened for it";
    const fields = {
      ...terms,
      feeMsat: String(this.invoiceMsat(order)),
      phase: (unclaimable ? "cancelled" : "failed") as MagmaPhase,
      ...(unclaimable ? { cancelledAt: now() } : {}),
      reason,
    };
    const entry = into ? Object.assign(into, fields) : this.journal.create(fields);
    this.journal.event(entry, `found waiting for its channel with no record of ours here — ${reason}`);
    this.journal.note(entry);
    console.warn(`[magma] order ${order.id}: ${reason}`);
    return entry;
  }

  // ── orders this node never took on ─────────────────────────────────────────

  /**
   * An order this node only SAW ("seen": no invoice of ours — never accepted
   * here) that Amboss shows past approval: it was accepted outside
   * LightningMate (on amboss.tech, with another tool, by an older version).
   * Before, such an order was booked as income and its 1% service fee
   * enqueued as soon as Amboss reported the channel confirmed — on Amboss's
   * word alone, for money this node never received — and the Orders tab
   * called it "completed · payment settled". Now:
   *  - waiting for its channel, with a payment of ours in LND (an invoice of
   *    ours, memo "Magma order <id>", settled — an older LightningMate's
   *    plain one): it is this node's after all — fulfilled, and booked once
   *    Amboss confirms the channel (exactly as an order found with no record
   *    here). Unpaid invoices of ours for it are cancelled (endUnpaidLegacy);
   *  - otherwise: recorded as accepted outside LightningMate and ended here —
   *    nothing booked, nothing charged, and no channel opened by
   *    LightningMate for a payment it can't see.
   * Every LND read comes before anything is recorded: one that fails leaves
   * the entry as it was, and the next pass asks again.
   */
  private async acceptedElsewhere(
    entry: MagmaJournalEntry,
    order: SaleOrderDetail,
    how: { auto: boolean; manual?: boolean },
  ): Promise<MagmaSellAction[]> {
    if (order.status === "WAITING_FOR_CHANNEL_OPEN") {
      const invoices = await this.lndOrderInvoices(order);
      if (invoices.length > 0) {
        await this.adoptWithInvoices(order, invoices, entry);
        if (TERMINAL_PHASES.has(entry.phase)) return [];
        return this.fulfil(entry, order, how);
      }
    }
    entry.external = "accepted_elsewhere";
    entry.reason =
      `accepted outside LightningMate (Amboss shows ${order.status}) — no invoice of ours is tied to it: ` +
      "nothing is booked or charged here, and LightningMate opens no channel for it";
    entry.decision = { at: now(), action: "skip", reason: entry.reason };
    this.toPhase(entry, "failed", entry.reason);
    console.warn(`[magma] order ${entry.orderId}: ${entry.reason}`);
    return [];
  }

  /**
   * An order of another node of the same Amboss account (one account can sell
   * for several nodes; its listing and its orders show all of them). Never
   * this node's to accept, open, reject or book. One this node had taken on
   * anyway (before orders were told apart by node) and not funded yet is
   * released — our invoice cancelled, the buyer's payment back — and ended
   * here; one with a channel of ours already (or an open under way) is left
   * to Amboss's verdict on that channel, as any other.
   */
  private async notThisNode(entry: MagmaJournalEntry | undefined, order: SaleOrderDetail): Promise<MagmaSellAction[]> {
    if (!entry || TERMINAL_PHASES.has(entry.phase)) return [];
    const why = `an order of another node of your Amboss account (${order.sellerPubkey.slice(0, 12)}…) — not this node's to accept, open or reject`;
    if (entry.fundingOutpoint || entry.phase === "opening") {
      this.noteError(entry, why);
      return [];
    }
    entry.external = "other_node";
    return this.release(entry, why);
  }

  // ── manual actions (Orders tab) ────────────────────────────────────────────

  private guard(): DeskResult | null {
    if (!this.deps.writeLnd) return { ok: false, code: "read_only", message: "Enable write mode to fulfil orders." };
    if (!this.deps.amboss.hasKey()) return { ok: false, code: "no_key", message: "Connect Amboss in Settings first." };
    if (this.stopping) return { ok: false, code: "shutting_down", message: "LightningMate is shutting down." };
    return null;
  }

  private async readForManual(id: string): Promise<SaleOrderDetail | DeskResult> {
    let order: SaleOrderDetail;
    try {
      order = await this.ambossSale(this.deps.amboss.getKey(), id);
    } catch (err) {
      if (isAuthError(err)) await this.deps.amboss.recheckAfterRefusal();
      return { ok: false, code: "amboss", message: `Could not read the order from Amboss: ${msg(err)}` };
    }
    // Whose order it is takes this node's key, from LND (asked once per
    // connection: after a restart, LND may not answer yet). Not answering is
    // this read's failure too — as one of Amboss's is (unreadClick).
    let own: string;
    try {
      own = await this.ownPubkey();
    } catch (err) {
      return { ok: false, code: "node", message: `Could not read this node's key from LND: ${msg(err)}` };
    }
    if (order.sellerPubkey !== own) return otherNodeResult(order);
    return order;
  }

  private async manual(id: string, fn: () => Promise<DeskResult>): Promise<DeskResult> {
    const blocked = this.guard();
    if (blocked) return blocked;
    this.active += 1;
    try {
      return await this.withOrder(id, fn);
    } catch (err) {
      // LND not answering (a capital check, an invoice lookup) is not Amboss's
      // failure: nothing was changed, try again.
      return { ok: false, code: err instanceof AmbossError ? "amboss" : "node", message: msg(err) };
    } finally {
      this.active -= 1;
    }
  }

  /** Accept an order by hand: same journal, same HODL invoice, same capital
   *  check as the lane (the autopilot's caps don't bind a manual pick). An
   *  order accepted already, with an accept of ours under way here, is
   *  answered as done. One that pays less than its channel costs on chain
   *  now is refused ("below_cost") unless `belowCost` says the operator
   *  confirmed it. */
  accept(id: string, opts: { belowCost?: boolean } = {}): Promise<DeskResult> {
    return this.manual(id, async () => {
      const order = await this.readForManual(id);
      if ("ok" in order) return this.unreadClick(id, "accept", order);
      if (order.status !== "WAITING_FOR_SELLER_APPROVAL") {
        // Accepted already, with an accept of ours under way here — the
        // lane's, made while this click waited for the order's turn, or an
        // earlier click's whose answer was lost: what the click asks for is
        // done (ALREADY_ACCEPTED). Not an order accepted outside
        // LightningMate (no accept of ours on record): no channel of this
        // app's follows that one (acceptedElsewhere).
        const ours = this.journal.get(id);
        if (PAST_APPROVAL.has(order.status) && ours && !ours.external && ours.phase !== "seen" && !TERMINAL_PHASES.has(ours.phase)) {
          return { ok: true, phase: ours.phase, message: ALREADY_ACCEPTED };
        }
        return { ok: false, code: "bad_status", message: `Order is ${order.status}, not awaiting approval.` };
      }
      const entry = this.journal.get(id);
      // Ended here with nothing of ours tied to it, while Amboss still waits
      // for your approval: yours to decide after all.
      this.revive(entry, order.status);
      if (entry?.phase === "accepting") {
        entry.via = "manual";
        const [res] = await this.resumeAccept(entry, order, null);
        if (phaseOf(entry) !== "seen") return this.result(entry, res);
        // its invoice had grown too old and was released: accept afresh below
      } else if (entry && entry.phase !== "seen") {
        return { ok: entry.phase === "accepted", ...(entry.phase === "accepted" ? {} : { code: "bad_status" as const }), phase: entry.phase, message: `Order is already ${entry.phase} here.` };
      }
      // Yours from this click on, whatever becomes of it (byHand).
      const mine = this.byHand(entry, order, "accept");
      try {
        const fee = this.invoiceMsat(order);
        if (fee <= 0n) {
          // Within the minute after it was placed, Amboss may still fill the
          // fee in; after that it is an order at 0 sats.
          const placed = Date.parse(order.createdAt);
          const fresh = Number.isFinite(placed) && Date.now() - placed < ZERO_FEE_GRACE_MS;
          return {
            ok: false,
            code: "amboss",
            message: fresh
              ? "Amboss reports no fee for this order yet — try again in a minute."
              : "Amboss priced this order at 0 sats for this node — there is nothing to earn. Reject it rather than let it time out.",
          };
        }
        // Below what opening and closing its channel costs on chain now: only
        // with the operator's explicit yes — the click is told both figures
        // and asked (review 2026-10-25: an Accept sold below cost unasked,
        // where the lane turns such an order down). Asked before the buyer is
        // dialed; the order is theirs meanwhile — the lane leaves it alone.
        if (!opts.belowCost) {
          const floorSats = await this.acceptFloorSats();
          if (fee < BigInt(floorSats) * 1000n) {
            const feeSats = Number(fee) / 1000;
            return {
              ok: false,
              code: "below_cost",
              feeSats,
              floorSats,
              message:
                `Not accepted: this order pays ${feeSats.toLocaleString("en-US")} sat — less than opening and closing its channel costs on chain now ` +
                `(${floorSats.toLocaleString("en-US")} sat, after the service fee).`,
            };
          }
        }
        const reached = await this.connectBuyer(order);
        if (!reached.ok && reached.blocked) {
          // This node's setup, not the buyer: nothing to reject the order for
          // — fix the macaroon, restart, and accept it while there is time.
          return { ok: false, code: "permission", message: `Not accepted: this node can't check its connection to the buyer — ${reached.blocked}.` };
        }
        if (!reached.ok) {
          return { ok: false, code: "unreachable", message: "The buyer's node is unreachable right now — rejecting the order is safer than accepting it." };
        }
        const [res] = await this.acceptOrder(mine, order, fee, "manual", null);
        return this.result(mine, res, /capital/.test(res?.error ?? "") ? "capital" : undefined);
      } finally {
        // Didn't go through — whatever stopped it, a check here, LND or
        // Amboss: nothing was promised, and the order says so at once. It
        // stays yours to decide; the lane leaves it alone (decide).
        if (phaseOf(mine) === "seen") this.skip(mine, MANUAL_ACCEPT_SKIP);
      }
    });
  }

  /** Open the channel for a paid order by hand. Idempotent: an order with a
   *  channel on record is only reported again, never opened twice. */
  open(id: string): Promise<DeskResult> {
    return this.manual(id, async () => {
      const order = await this.readForManual(id);
      if ("ok" in order) return order;
      let entry = this.journal.get(id);
      if (entry && FUNDED.has(entry.phase)) {
        if (entry.phase === "funded" && order.status === "WAITING_FOR_CHANNEL_OPEN") await this.report(entry);
        return this.result(entry, undefined);
      }
      // Only seen here, but accepted elsewhere: see acceptedElsewhere (a
      // payment of ours in LND makes it this node's to open; otherwise it
      // ends here, and the click is told why).
      if (entry?.phase === "seen" && !entry.invoice && PAST_APPROVAL.has(order.status)) {
        await this.acceptedElsewhere(entry, order, { auto: true, manual: true });
        if (FUNDED.has(entry.phase)) return this.result(entry, undefined);
        if (TERMINAL_PHASES.has(entry.phase)) {
          return { ok: false, code: "bad_status", phase: entry.phase, message: `No channel opened: ${entry.reason ?? `the order is ${entry.phase} here`}.` };
        }
      }
      if (FUNDING_REPORTED_STATUSES.has(order.status)) {
        return { ok: true, phase: entry?.phase, message: `Amboss already has this order's channel (${order.status}).` };
      }
      if (order.status !== "WAITING_FOR_CHANNEL_OPEN") {
        return { ok: false, code: "bad_status", message: `Order is ${order.status}, not ready for a channel.` };
      }
      entry ??= await this.adoptLegacy(order);
      if (TERMINAL_PHASES.has(entry.phase)) {
        return { ok: false, code: "bad_status", phase: entry.phase, message: `Order is ${entry.phase} here: ${entry.reason ?? ""}`.trim() };
      }
      const actions = await this.fulfil(entry, order, { auto: true, manual: true });
      if (entry.phase === "accepting" || entry.phase === "accepted") {
        return { ok: false, code: "not_held", phase: entry.phase, message: "The buyer's payment is not held by our invoice yet." };
      }
      const failedOpen = actions.find((a) => a.action === "open" && !a.ok);
      if (failedOpen && !entry.fundingOutpoint) {
        return {
          ok: false,
          code: /capital/.test(failedOpen.error ?? "") ? "capital" : "open_failed",
          phase: entry.phase,
          message: failedOpen.error ?? "Channel open failed.",
        };
      }
      // Never "ok" for a click that opened nothing: the Orders tab says
      // "Channel opening" on ok. (Before, an order only seen here answered
      // ok: true, "Order seen.")
      if (entry.phase === "opening") {
        // An earlier open whose outcome LND left unclear (or one under way):
        // nothing is opened again until LND shows that channel or has had
        // ample time to (reconcileOpening).
        return {
          ok: false,
          code: "open_failed",
          phase: entry.phase,
          message: "An earlier open of this channel is still unclear — waiting for LND to show it before anything else; nothing was opened now.",
        };
      }
      if (!FUNDED.has(entry.phase)) {
        return {
          ok: false,
          code: "bad_status",
          phase: entry.phase,
          message: `No channel opened: the order is ${entry.phase} here${entry.lastError ? ` (${entry.lastError})` : entry.reason ? ` (${entry.reason})` : ""}.`,
        };
      }
      return this.result(entry, undefined);
    });
  }

  /**
   * The order as a reject needs it: its status (only an order awaiting
   * approval can be rejected), and who and what it is for the record. When
   * Amboss won't show the order itself, its listing of the orders waiting on
   * us says as much. (Before, a read that kept failing left the operator no
   * way to turn such an order down: it timed out on them.)
   */
  private async readForReject(id: string): Promise<SaleOrder | DeskResult> {
    const read = await this.readForManual(id);
    if (!("ok" in read)) return read;
    try {
      const own = await this.ownPubkey();
      const listed = (await this.ambossSales(this.deps.amboss.getKey(), { actionNeeded: true })).orders.find(
        (o) => o.id === id && o.sellerPubkey === own,
      );
      if (listed) return listed;
    } catch {
      // The read's own error says what is wrong.
    }
    return read;
  }

  /** Reject an order by hand (only while it waits for approval). One Amboss
   *  doesn't confirm stands: the lane sends it again (advance) — as it does
   *  one whose read of an order the lane has on record failed (unreadClick).
   *  An order Amboss shows rejected already is answered as done; one with an
   *  accept of ours under way is refused, saying why. */
  reject(id: string): Promise<DeskResult> {
    return this.manual(id, async () => {
      const order = await this.readForReject(id);
      if ("ok" in order) return this.unreadClick(id, "reject", order);
      // Rejected already — by the lane's resend of an earlier reject of
      // yours while this click waited for the order's turn, say: what the
      // click asks for is done (ALREADY_REJECTED). Nothing changes.
      if (order.status === "SELLER_REJECTED") return { ok: true, message: ALREADY_REJECTED };
      if (order.status !== "WAITING_FOR_SELLER_APPROVAL") {
        return { ok: false, code: "bad_status", message: `Order is ${order.status} — only orders awaiting approval can be rejected.` };
      }
      const entry = this.journal.get(id);
      this.revive(entry, order.status); // as in accept
      // An accept whose invoice has grown too old to send again (one that
      // hung for most of an hour): nothing can complete it any more. Released
      // first, as the lane's next pass would — then this reject goes out.
      // (Before, the Reject was refused, and with selling on the lane then
      // released the accept and accepted the order afresh.)
      if (entry?.phase === "accepting" && this.acceptStale(entry)) await this.releaseStaleAccept(entry);
      // An accept of ours under way, though Amboss still shows the order
      // awaiting approval: completed first — one that may have reached Amboss
      // is never withdrawn (resumeAccept). Refused, as before — now saying
      // why (review of P9, final round: "Order is already accepting here.").
      if (entry?.phase === "accepting") {
        const message = entry.acceptSentAt ? NOT_REJECTED_ACCEPT_SENT : NOT_REJECTED_ACCEPT_UNSENT;
        return { ok: false, code: "bad_status", phase: entry.phase, message };
      }
      if (entry && entry.phase !== "seen") {
        return { ok: false, code: "bad_status", phase: entry.phase, message: `Order is already ${entry.phase} here.` };
      }
      // The operator's decision (byHand), also on an order the lane recorded
      // first (one it left to them — SELLING_OFF_SKIP — or couldn't decide):
      // never a "turned down" alert, nor a refusal on the Overview
      // (refusals() counts the lane's own).
      const mine = this.byHand(entry, order, "reject");
      const [res] = await this.rejectOrder(mine, REJECTED_BY_YOU);
      const result = this.result(mine, res);
      return !result.ok && rejectByHand(mine) ? { ...result, message: thenSay(result.message, REJECT_STANDS) } : result;
    });
  }

  /**
   * An order awaiting approval that the operator takes into their own hands —
   * a click on Accept or Reject, from the moment it is taken up, whatever
   * becomes of it. The order is theirs from then on (via "manual"), and their
   * latest click is what stands: the lane never decides it on its own — it
   * neither accepts it nor turns it down (decide) — and carries out what they
   * decided: a reject Amboss hasn't confirmed is sent again on every pass
   * until Amboss confirms it or the order ends (advance), an accept that
   * didn't go through leaves the order to them (MANUAL_ACCEPT_SKIP). An error
   * on record was about an earlier attempt — a reject that didn't go through,
   * say, whose "will try again" no longer holds once they accept. The order's
   * approval deadline is kept with it: a reject of theirs is sent again even
   * while Amboss won't show the order (couldNotRead) — until shortly after
   * that deadline, not for a day (pastApproval). Saved before anything is
   * sent: after a restart the order is still theirs. (A click that can't
   * read the order at all takes one the lane has on record the same way:
   * unreadClick.) A click is taken up once it has the order's turn
   * (withOrder): a step the lane had begun on the order finishes first, and
   * a click that then finds it accepted or rejected says so before it gets
   * here (done, if that is what it asked for; refused, if not) — the lane's
   * decision stands. Nor does a click get here for an order with an accept
   * already sent whose answer was lost ("accepting"), the lane's or theirs:
   * an accept that may have reached Amboss is completed first (resumeAccept),
   * and a Reject meanwhile is refused (NOT_REJECTED_ACCEPT_SENT) — their
   * latest click does not stand against it.
   *
   * Review of P8, final round: a click whose call failed on a transient error
   * (Amboss HTTP 502, an LND blink) left the order to the lane's next pass,
   * which accepted an order the operator had rejected — or turned down one
   * they had accepted, for caps that don't bind a manual pick. An accept
   * failing before its reservation left an order the lane had recorded first
   * the lane's (only the reservation marked it the operator's). And a reject
   * was saved only once Amboss had answered: the process dying while it was
   * out left nothing on disk, and the restarted lane accepted the order.
   */
  private byHand(found: MagmaJournalEntry | undefined, order: SaleOrder, action: "accept" | "reject"): MagmaJournalEntry {
    const entry =
      found ??
      this.journal.create({
        orderId: order.id,
        via: "manual",
        buyerPubkey: order.buyerPubkey,
        sizeSats: order.sizeSats,
        isPrivate: order.isPrivate,
        feeMsat: String(this.invoiceMsat(order)),
      });
    entry.via = "manual";
    entry.decision = { at: now(), action, reason: action === "reject" ? REJECTED_BY_YOU : ACCEPTED_BY_YOU };
    entry.timeout = order.timeout;
    entry.lastError = undefined;
    entry.lastErrorAt = undefined;
    this.journal.note(entry);
    return entry;
  }

  /**
   * A click on Accept or Reject that couldn't read the order — Amboss didn't
   * answer (an HTTP error, a timeout; for a reject, its listing didn't
   * either), or LND couldn't say which node this is — for an order the lane
   * has on record as "seen": the order is the operator's from this click on,
   * as byHand makes it. Their reject stands — the lane sends it (advance,
   * couldNotRead) and never accepts the order — and their accept leaves the
   * order to them (MANUAL_ACCEPT_SKIP: nothing was promised). The click is
   * told the read failed — and, for a reject, that it stands.
   *
   * Only a "seen" record qualifies: only such a record was read or listed as
   * this node's order awaiting approval, with nothing of ours tied to it. One
   * further on is decided already (an accept under way is completed). Any
   * other order is left as it was — one with no record here (nothing tells
   * whose order it is), or one ended here (Amboss had stopped showing it; it
   * is taken up again only once Amboss lists it awaiting approval: revive):
   * nothing tells whether it awaits approval, and the lane sends a recorded
   * reject without reading the order first. Nor an order of another node of
   * the account (bad_status): never this node's to decide.
   *
   * Review of P9, round 2: such a click recorded nothing, and the lane's next
   * pass decided the order as its own. With selling on it ACCEPTED an order
   * the operator had rejected — one the lane had held back, waiting for
   * Amboss to report its fee, or undecided when its capital check failed —
   * and an accept clicked after a reject that didn't go through left that
   * reject to be sent: the earlier click overrode the latest.
   */
  private unreadClick(id: string, action: "accept" | "reject", failed: DeskResult): DeskResult {
    if (failed.code !== "amboss" && failed.code !== "node") return failed;
    const entry = this.journal.get(id);
    if (entry?.phase !== "seen") return failed;
    entry.via = "manual";
    // About an earlier attempt (a reject's "will try again", say): no longer
    // what holds the order — as byHand clears it.
    entry.lastError = undefined;
    entry.lastErrorAt = undefined;
    if (action === "accept") {
      this.skip(entry, MANUAL_ACCEPT_SKIP); // saved
      return failed;
    }
    entry.decision = { at: now(), action: "reject", reason: REJECTED_BY_YOU };
    this.journal.note(entry);
    return { ...failed, message: thenSay(failed.message, REJECT_STANDS) };
  }

  private result(entry: MagmaJournalEntry, action: MagmaSellAction | undefined, code?: DeskResult["code"]): DeskResult {
    const ok = action ? action.ok : FUNDED.has(entry.phase) || !entry.lastError;
    const opened = entry.fundingOutpoint
      ? {
          outpoint: entry.fundingOutpoint,
          transactionId: entry.fundingOutpoint.split(":")[0],
          reported: entry.phase === "reported" || entry.phase === "settled",
        }
      : {};
    let message: string;
    if (!ok) message = action?.error ?? entry.lastError ?? "failed";
    else if (entry.phase === "funded") message = `Channel opened (${entry.fundingOutpoint}); reporting it to Amboss is retried: ${entry.lastError ?? "pending"}.`;
    else message = `Order ${entry.phase}.`;
    return { ok, ...(ok ? {} : { code: code ?? "amboss" }), phase: entry.phase, message, ...opened };
  }

  // ── the main run's share: deployed capital, finished leases ────────────────

  /** Magma capital whose lease is still running, plus orders accepted outside
   *  this journal (they will need coins too) — the deploy-cap share. */
  async refreshDeployed(force = false): Promise<number> {
    if (!this.deps.amboss.hasKey()) return this.deployedNow();
    if (!force && Date.now() - this.deployed.at < DEPLOYED_TTL_MS) return this.deployedNow();
    // Failed a moment ago: the last good listing stands rather than another
    // wait on Amboss (each failure can be a 15 s timeout).
    if (!force && this.deployedFailedAt > 0 && Date.now() - this.deployedFailedAt < DEPLOYED_TTL_MS && this.lastListingUsable()) {
      return this.deployedNow();
    }
    const reserving = new Set(this.journal.reservations(0).map((r) => r.key));
    const own = await this.ownPubkey();
    let orders: Awaited<ReturnType<MagmaDesk["ambossSales"]>>["orders"];
    try {
      ({ orders } = await this.ambossSales(this.deps.amboss.getKey(), {
        status: [...LEASE_RUNNING_STATUSES, "WAITING_FOR_BUYER_PAYMENT", "WAITING_FOR_CHANNEL_OPEN", "WAITING_FOR_SELLER_APPROVAL"],
      }));
    } catch (err) {
      // Only this listing failed: the last good one (under an hour old) with
      // this journal's own sales since decides; the wallet check still runs
      // (capitalFor). Older than that, the decision waits (undecided).
      if (this.lastListingUsable()) {
        this.deployedFailedAt = Date.now();
        console.warn(`[magma] the listing of your sold capital failed (${errorText(err)}) — deciding on the one from ${new Date(this.deployed.at).toISOString()}`);
        return this.deployedNow();
      }
      throw err;
    }
    this.deployedFailedAt = 0;
    // This node's sold capital only (another node of the account has its own
    // wallet); orders this journal reserves are counted as reservations
    // already; an order waiting for approval holds nothing of the wallet yet.
    const mine = orders.filter((o) => o.sellerPubkey === own);
    const sats = mine
      .filter((o) => o.status !== "WAITING_FOR_SELLER_APPROVAL" && !reserving.has(`magma:${o.id}`))
      .reduce((s, o) => s + o.sizeSats, 0);
    this.deployed = { sats, at: Date.now(), awaiting: mine.filter((o) => o.status === "WAITING_FOR_SELLER_APPROVAL").map((o) => o.id) };
    const running = new Set<string>(LEASE_RUNNING_STATUSES);
    this.keepAmbossLeases(
      orders
        .filter((o) => o.sellerPubkey === own && running.has(o.status) && !!o.channelId)
        .map((o) => ({ orderId: o.id, channelId: o.channelId as string })),
    );
    return this.deployedNow();
  }

  /** The last good listing of sold capital is recent enough to decide on. */
  private lastListingUsable(): boolean {
    return this.deployed.at > 0 && Date.now() - this.deployed.at < DEPLOYED_FALLBACK_MS;
  }

  /**
   * The deploy cap's share now: Amboss's last listing plus this journal's own
   * sales funded since it, which that listing can't show yet. Before, an order
   * funded within the listing's 30 s cache counted neither as reserved (it
   * wasn't any more) nor as deployed (the cached listing predated it), and a
   * second order got past the deploy cap (review 2026-10-25).
   */
  private deployedNow(): number {
    if (this.deployed.at <= 0) return this.deployed.sats;
    return this.deployed.sats + this.journal.fundedSince(this.deployed.at);
  }

  /** Orders that hold part of this node's offers unsold: waiting for its
   *  approval (Amboss's last listing), or taken on here and not yet booked —
   *  the offer upkeep tops up and gives back nothing meanwhile. */
  ordersPending(): number {
    const ids = new Set(this.lastListingUsable() ? this.deployed.awaiting : []);
    for (const e of this.journal.pendingSale()) ids.add(e.orderId);
    return ids.size;
  }

  /** A new listing of the running leases: in memory, and on disk when it
   *  changed (or the copy there is getting old — its time says how fresh it
   *  is after a restart). */
  private keepAmbossLeases(leases: AmbossRunningLease[]): void {
    const nowMs = Date.now();
    const changed = JSON.stringify(leases) !== JSON.stringify(this.ambossLeases);
    this.ambossLeases = leases;
    this.ambossLeasesAt = nowMs;
    if (changed || nowMs - this.ambossLeasesSavedAt >= AMBOSS_LEASES_MAX_AGE_MS / 2) {
      this.ambossLeasesStore.write({ at: new Date(nowMs).toISOString(), leases });
      this.ambossLeasesSavedAt = nowMs;
    }
  }

  /** This node's sales whose lease Amboss reported running at its last
   *  listing (with their channel) — this process's, or the one before's
   *  (kept on disk). */
  runningLeasesOnAmboss(): AmbossRunningLease[] {
    return [...this.ambossLeases];
  }

  /** When that listing was made (null: never). */
  runningLeasesListedAt(): string | null {
    return this.ambossLeasesAt > 0 ? new Date(this.ambossLeasesAt).toISOString() : null;
  }

  /**
   * The running leases as Amboss lists them, asked again first when the last
   * listing is older than AMBOSS_LEASES_MAX_AGE_MS and an Amboss key is set —
   * for the close list and a close, which must not go by a listing from
   * hours ago (or none: the deploy cap's listing runs only while selling
   * does). Waits at most AMBOSS_LEASES_WAIT_MS for Amboss (the listing then
   * lands for the next read); a failed listing is not asked for again
   * before AMBOSS_LEASES_RETRY_MS. Never throws.
   */
  async runningLeasesFresh(): Promise<AmbossRunningLease[]> {
    const nowMs = Date.now();
    const stale = nowMs - this.ambossLeasesAt > AMBOSS_LEASES_MAX_AGE_MS;
    if (stale && this.deps.amboss.hasKey() && (this.ambossLeasesRefresh || nowMs - this.ambossLeasesTriedAt >= AMBOSS_LEASES_RETRY_MS)) {
      if (!this.ambossLeasesRefresh) {
        this.ambossLeasesTriedAt = nowMs;
        this.ambossLeasesRefresh = this.refreshDeployed(true)
          .then(
            () => undefined,
            () => undefined, // Amboss unreachable: the last listing known stands
          )
          .finally(() => {
            this.ambossLeasesRefresh = null;
          });
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, AMBOSS_LEASES_WAIT_MS);
        timer.unref?.();
        void this.ambossLeasesRefresh?.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.runningLeasesOnAmboss();
  }

  /**
   * Close sold channels whose lease is over (CHANNEL_MONITORING_FINISHED):
   * the sale's own channel, by its funding outpoint — txid AND vout: two
   * channels can share one funding transaction, and matching the txid alone
   * closed the first one LND listed, another buyer's whose lease still ran
   * (review 2026-10-25). Never one whose lease Amboss still lists as running.
   * Kept open when our side holds under SOLD_CLOSE_MIN_LOCAL_SHARE of it (what
   * is left is inbound worth keeping) or it routes well; closed at the
   * economy fee rate, never above the operator's maximum on-chain fee rate
   * (it paid LND's 6-block rate, whatever that was).
   */
  async closeFinishedLeases(): Promise<MagmaSellAction[]> {
    const { writeLnd, amboss } = this.deps;
    if (!writeLnd || !amboss.hasKey()) return [];
    const key = amboss.getKey();
    const own = await this.ownPubkey();
    const orders = (await this.ambossSales(key, { status: ["CHANNEL_MONITORING_FINISHED"] })).orders.filter(
      (o) => o.sellerPubkey === own,
    );
    if (orders.length === 0) return [];
    const open = (await getChannels({ lnd: this.deps.readLnd })).channels;
    // Other sales' leases, as Amboss last listed them running.
    const running = new Set(this.runningLeasesOnAmboss().map((l) => standardChannelId(l.channelId)));
    let terms: Awaited<ReturnType<NonNullable<MagmaDeskDeps["soldChannelClose"]>>> | null | undefined;
    const out: MagmaSellAction[] = [];
    for (const o of orders) {
      // (Auto-close is selling's automation: none starts once Liquidity
      // provision is switched off — or all automation paused — meanwhile.)
      if (this.stopping || !this.deps.config().sellEnabled) break;
      let point = this.journal.get(o.id)?.fundingOutpoint ?? this.finishedTxids.get(o.id);
      if (point === undefined) {
        // Asked once per process — but only Amboss's answer is remembered. A
        // read that failed is asked again on the next run (before, one
        // hiccup was remembered as "no funding transaction", and that lease's
        // channel stayed open until a restart).
        const sale = await this.ambossSale(key, o.id).catch(() => null);
        if (!sale) continue;
        point = sale.transactionId ?? null;
        this.finishedTxids.set(o.id, point);
      }
      const ch = point ? channelAtOutpoint(open, point) : undefined;
      if (!ch) continue; // closed already, not ours, or not which one of a shared funding
      if (running.has(standardChannelId(ch.id))) continue; // a lease still runs on it
      // Is it worth closing? (Asked once per pass, when a close is due.)
      terms ??= this.deps.soldChannelClose ? await this.deps.soldChannelClose().catch(() => null) : null;
      const keep =
        ch.local_balance < SOLD_CLOSE_MIN_LOCAL_SHARE * ch.capacity
          ? `kept open: ${Math.round(ch.local_balance).toLocaleString("en-US")} of its ${Math.round(ch.capacity).toLocaleString("en-US")} sat are on our side — the rest is inbound worth keeping`
          : terms?.routesWell(ch.id)
            ? "kept open: it routes well (it earns at least what a sat of this node's channels earns)"
            : !terms
              ? "not closed yet: no on-chain fee estimate to close it at an economy rate"
              : terms.feeRate === null
                ? "not closed yet: LND gave no on-chain fee estimate"
                : terms.feeRate > terms.maxFeeRate
                  ? `not closed yet: on-chain fees are ${terms.feeRate} sat/vB at the economy rate — above your ${terms.maxFeeRate} sat/vB maximum`
                  : null;
      if (keep) {
        // Said once per process (in the order's history, or the log for a
        // sale the journal doesn't know), not each run.
        if (this.closeKept.get(o.id) !== keep) {
          this.closeKept.set(o.id, keep);
          const entry = this.journal.get(o.id);
          if (entry) {
            this.journal.event(entry, `lease over — ${keep}`);
            this.journal.note(entry);
          } else console.log(`[magma] order ${o.id}: lease over — ${keep}`);
        }
        continue;
      }
      // Again right before the close: the read above may have taken a while.
      if (this.stopping || !this.deps.config().sellEnabled) break;
      const res = await closeChannelByOutpoint(writeLnd, ch.transaction_id, ch.transaction_vout, false, terms?.feeRate ?? undefined);
      const entry = this.journal.get(o.id);
      if (entry && res.ok) {
        entry.closedAt = now();
        entry.closeTxid = res.transactionId;
        this.journal.event(entry, "lease over — channel closed");
        this.journal.note(entry);
      }
      out.push({ orderId: o.id, action: "close", sizeSats: o.sizeSats, ok: res.ok, transactionId: res.transactionId, error: res.error });
    }
    return out;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private toPhase(entry: MagmaJournalEntry, phase: MagmaPhase, what: string): void {
    entry.phase = phase;
    entry.lastError = undefined;
    entry.lastErrorAt = undefined;
    this.journal.event(entry, what);
    this.journal.note(entry);
  }

  /**
   * Back to "seen" — every path that hands an order back goes through here:
   * nothing of ours is tied to it any more (its invoice released, or never
   * made), and it is to be decided again, by the lane or by the operator.
   * An error on record was about what ends here, and goes with it. Market →
   * Orders shows an order's last error before its decision, and the recent
   * orders (recentOrders) before all but its reason: a stale one hid what
   * holds the order now — "your accept didn't go through" (MANUAL_ACCEPT_SKIP),
   * "switched off before it was accepted" (SELLING_OFF_SKIP) — and said
   * "checking with Amboss on the next pass" while nothing would check, so
   * the order could time out on the operator (review of P9, final round). A
   * hand-back for an error of its own notes that error right after. Saved by
   * the caller.
   */
  private backToSeen(entry: MagmaJournalEntry): void {
    entry.phase = "seen";
    entry.invoice = null;
    entry.lastError = undefined;
    entry.lastErrorAt = undefined;
  }

  private noteError(entry: MagmaJournalEntry | undefined, error: string): void {
    if (!entry) return;
    entry.lastError = error;
    entry.lastErrorAt = now();
    this.journal.event(entry, error);
    this.journal.note(entry);
  }

  /** One action per order at a time, whoever asks (lane or click), in the
   *  order they ask. A click that comes while the lane is deciding or acting
   *  on the order waits for that step — the capital check, the dial (up to
   *  ~90 s over Tor), the accept or reject — and then reads the order afresh:
   *  one accepted or rejected meanwhile is answered as it is — done, for a
   *  click that asked for that; refused, for one that asked for the other.
   *  So a decision made by hand wins over the lane only for an order the lane
   *  isn't working on — the limit the docs state (magmaByHand.test.ts pins
   *  it). */
  private async withOrder<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.orderChains.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = prev.then(() => mine);
    this.orderChains.set(id, chain);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.orderChains.get(id) === chain) this.orderChains.delete(id);
    }
  }

  /** Dial the buyer: connected, or not — and `blocked` (the reason) when
   *  LND won't list its peers to the write macaroon (no peers:read), so no
   *  buyer's connection can be checked: this node's setup, never the buyer's
   *  node being unreachable (MissingPermission). */
  private async connectBuyer(order: SaleOrderDetail): Promise<{ ok: true } | { ok: false; blocked: string | null }> {
    try {
      return (await this.lndConnect(order.buyerPubkey, order.sockets)) ? { ok: true } : { ok: false, blocked: null };
    } catch (err) {
      return { ok: false, blocked: err instanceof MissingPermission ? err.message : null };
    }
  }

  // ── seams: every external call, so a test can drive (and crash) each step ──

  private ambossSales(key: string, filter: SalesFilter) {
    return listSales(key, filter);
  }
  private ambossSale(key: string, id: string) {
    return getSale(key, id);
  }
  private ambossAccept(key: string, id: string, request: string) {
    return acceptSale(key, id, request);
  }
  private ambossAddTx(key: string, id: string, outpoint: string) {
    return addSaleTransaction(key, id, outpoint);
  }
  private ambossReject(key: string, id: string) {
    return rejectSale(key, id);
  }
  private lndCreateHodl(p: CreateHodlParams) {
    return createHodl(this.deps.writeLnd!, p);
  }
  private lndHodlStatus(id: string): Promise<HodlStatus> {
    return hodlStatus(this.deps.writeLnd!, id);
  }
  private lndSettle(secret: string) {
    return settleHodl(this.deps.writeLnd!, secret);
  }
  private lndCancel(id: string) {
    return cancelHodl(this.deps.writeLnd!, id);
  }
  /** The invoices of ours for an order (by memo). They are made at accept
   *  time, after the order was placed: the scan starts an hour before that
   *  (clocks differ) — on a busy node, not through months of invoices. */
  private lndOrderInvoices(order: SaleOrder): Promise<FoundInvoice[]> {
    const placed = Date.parse(order.createdAt);
    const since = new Date((Number.isFinite(placed) ? placed : Date.now() - 7 * 86_400_000) - 3_600_000).toISOString();
    return findInvoicesByDescription(this.deps.writeLnd!, orderMemo(order.id), since, 50);
  }
  /** The open itself — the buyer was dialed before the mutex (connectBuyer). */
  private lndOpen(p: OpenChannelParams) {
    return fundChannel(this.deps.writeLnd!, p);
  }
  private lndConnect(pubkey: string, sockets: string[]) {
    return ensureConnected(this.deps.writeLnd!, pubkey, sockets);
  }
  /** This node's public key (cached per LND connection). */
  private ownPubkey(): Promise<string> {
    return getOwnPubkey(this.deps.readLnd);
  }
}

/** The answer to a click on an order of another node of the account. */
const otherNodeResult = (order: SaleOrder): DeskResult => ({
  ok: false,
  code: "bad_status",
  message:
    `This order is for another node of your Amboss account (${order.sellerPubkey.slice(0, 12)}…) — ` +
    "LightningMate only accepts, opens and rejects this node's orders.",
});

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
