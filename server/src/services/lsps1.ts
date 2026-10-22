import {
  addAdvertisedFeature,
  addExternalSocket,
  getChainFeeRate,
  getInvoice,
  getWalletInfo,
  removeExternalSocket,
  sendMessageToPeer,
  subscribeToInvoice,
  subscribeToPeerMessages,
  type AuthenticatedLnd,
} from "lightning";
import * as lnService from "lightning";

// lightning@10 exports removeAdvertisedFeature at runtime but forgot it in the
// package typings (peers/index.d.ts) — same call shape as addAdvertisedFeature.
const removeAdvertisedFeature = (
  lnService as unknown as {
    removeAdvertisedFeature: (args: { lnd: AuthenticatedLnd; feature: number }) => Promise<void>;
  }
).removeAdvertisedFeature;
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { EventEmitter } from "node:events";
import { JsonStore, recordStoreIncident } from "../store.js";
import type { SettingsStore } from "./settings.js";
import type { EarningsLog } from "./earningsLog.js";
import { getMagmaRecommendations, MAGMA_V2_DEFAULTS } from "./magmaRecommend.js";
import { onchainCosts } from "./nodeEconomics.js";
import { saleFeeConfig, type ServiceFeeLedger } from "./serviceFee.js";
import { checkPeerListing, couldNotConnect, ensureConnected, fundChannel, isPendingChannelsLimit, isPreBroadcastRefusal, opensBlocked } from "./channelOps.js";
import { HODL_CANCEL_MARGIN_BLOCKS, cancelHodl, createHodl, heldUntilHeightOf, newHodlSecret, settleHodl } from "./hodl.js";
import {
  CapitalLedger,
  channelsWith,
  findOpenedChannel,
  readChain,
  saleTag,
  spendableOnchain,
  spendableWith,
  type ChainReads,
  type Reservation,
} from "./capital.js";
import { leaseCapFrom, type LeaseCap, type OfferFeeCaps, type SoldLease } from "./leaseCaps.js";

/**
 * LSP mode — LSPS1 (bLIP-51) channel selling over LSPS0 (bLIP-50) transport.
 *
 * Wallets and nodes speaking the open LSP standard connect to us as a peer and
 * talk JSON-RPC 2.0 over BOLT8 custom messages (type 37913).
 *
 * Phase 2 (orders): `lsps1.create_order` prices a channel with the same engine
 * Magma selling uses (profit floor + market level, duration-scaled), collects
 * payment via a **HODL invoice**, opens the channel once the payment is held,
 * and only then settles. Any failure cancels the invoice → the buyer is
 * automatically refunded. This settle-after-broadcast ordering is the critical
 * fund-safety property: we can never keep a payment without delivering.
 *
 * Spec rules implemented (bLIP-50/51):
 *  - one BOLT8 message = one complete JSON-RPC 2.0 object, UTF-8 encoded
 *  - malformed payload → `-32700` with `id: null`; unknown method → `-32601`
 *  - order errors: `100` option_mismatch, `101` not found, `1` client_rejected
 *  - sat amounts are strings; `payment.bolt11` sub-object with state machine
 *    EXPECT_PAYMENT → HOLD → PAID | REFUNDED; order CREATED → COMPLETED | FAILED
 *
 * One deliberate deviation (D14): bLIP-50 wants `-32602` for a parameter the
 * LSP doesn't know. ZEUS — the one wallet known to order over peer messages
 * — sends an informational `client_info` with every create_order and shows
 * nothing when it is refused (no retry), so every ZEUS order failed while the
 * Settings card counted get_info requests and looked healthy. Unknown
 * parameters are now accepted and ignored (their names logged and counted);
 * every known parameter is still validated strictly. Every error carries a
 * human `data.message`: it is the only part of an error ZEUS displays.
 */

/** BOLT8 custom message type carrying all LSPS traffic (bLIP-50). */
export const LSPS0_MESSAGE_TYPE = 37913;

/** `option_supports_lsps` (bLIP-50): advertised in the node announcement while
 *  LSP mode is on, so graph crawlers and wallets can discover the node as an
 *  LSP. Clients MUST NOT set this bit — we only ever set it as the LSP side. */
export const LSPS_FEATURE_BIT = 729;

/** Protocol-side offer constants (sizes shared with the Magma sell caps). */
const LSPS1_LIMITS = {
  /** Smallest channel we sell — matches the Magma minimum sell size. */
  minChannelSat: 1_000_000,
  /** We don't do zero-conf: the client gets channel_ready after 1 conf. */
  minRequiredChannelConfirmations: 1,
  /** Fastest funding-confirmation promise a client may request. */
  minFundingConfirmsWithinBlocks: 6,
  supportsZeroChannelReserve: false,
  /** Longest lease we promise not to close: ~3 months. ZEUS offers 1, 3, 6
   *  and 12 months (4,380 / 13,140 / 26,280 / 52,560 blocks) without looking
   *  at the LSP's maximum; at 12,960 its "3 months" was refused with
   *  option_mismatch. 13,140 takes it (and is ZEUS's default: it starts at
   *  the advertised maximum). */
  maxChannelExpiryBlocks: 13_140,
};

/** Per-peer inbound message budget — order spam / DoS guard. */
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_MAX_PEERS = 500;

/** Unpaid orders expire after an hour; the HODL invoice carries the deadline. */
const ORDER_EXPIRY_MS = 60 * 60 * 1000;
/** Abuse caps: open unpaid/held orders, per peer and total. A buyer at its
 *  own cap that asks again replaces its oldest unpaid quote (supersede) —
 *  at the pace below. */
const MAX_PENDING_PER_PEER = 2;
const MAX_PENDING_TOTAL = 10;
/** Asking again, bounded. Every new order is a hold invoice in LND (kept
 *  there once cancelled, unless the operator has LND delete them), a turn of
 *  the on-chain mutex every Magma accept and open waits on, and a save of the
 *  order file. Replacing quotes without a pace let one connected peer make
 *  one per message — about 43,000 a day — and a few peers keep the mutex
 *  busy. So: a request with the same terms as the buyer's newest unpaid
 *  quote, within SAME_QUOTE_MS, is answered with that quote (ZEUS gives up on
 *  an answer after 7 s and the buyer taps again); a buyer at its cap
 *  replaces a quote no sooner than REQUOTE_MIN_GAP_MS after its last order;
 *  and no buyer gets more than ORDERS_PER_PEER_PER_HOUR new orders an hour,
 *  replaced ones included. */
const SAME_QUOTE_MS = 10 * 60_000;
const REQUOTE_MIN_GAP_MS = 60_000;
const ORDERS_PER_PEER_PER_HOUR = 6;
/** LND's balance and reserve inputs, as get_info, the status card and
 *  create_order's first look use them: read at most this often. The check
 *  that decides an order reads LND afresh, inside the on-chain mutex. */
const CHAIN_READS_FRESH_MS = 30_000;
/** A paid order whose buyer is offline looks for it again this often; the
 *  buyer's next LSPS message (a wallet asking get_order) wakes it at once. */
const OPEN_RETRY_DELAY_MS = 60_000;
/** The final CLTV delta of an LSPS1 invoice: how long the buyer's payment
 *  may stay held — about a day. bLIP-51: the LSP MUST wait for the buyer's
 *  connection before it opens, and a phone wallet may be offline for hours
 *  after paying. (Before, LND's default — 80 blocks on stock LND — applied
 *  and a buyer had 10 minutes, then was refunded.) */
const HODL_CLTV_DELTA = 144;
/** An open needs this many blocks left before the held HTLC expires: the
 *  margin at which the payment is released anyway, plus the open and the
 *  settle right after it. Below it the buyer is refunded instead. */
const OPEN_MIN_BLOCKS_LEFT = HODL_CANCEL_MARGIN_BLOCKS + 6;
/** When LND names no expiry height for the held payment: how long after it
 *  was first seen held an open may still be tried — inside the smallest CLTV
 *  a stock LND gives an invoice (80 blocks, ~13 h), minus the margin. */
const HELD_FALLBACK_MS = 6 * 3_600_000;
/** Restart recovery: an order LND can't answer for yet (still starting up,
 *  unlocking) is looked at again — after 30 s, doubling to 5 min. */
const RECOVERY_RETRY_MIN_MS = 30_000;
const RECOVERY_RETRY_MAX_MS = 5 * 60_000;
/** Pricing: fresh for a minute; until 15 minutes old it is used as it is and
 *  refreshed behind the answer. ZEUS gives create_order 7 s — the Magma
 *  engine's market read (several Amboss calls, over Tor when routed so)
 *  must not run in the request path. */
const PRICING_FRESH_MS = 60_000;
const PRICING_STALE_OK_MS = 15 * 60_000;
/** With no price cached at all, create_order waits this long for the market
 *  and then quotes from the local profit floor. */
const PRICING_WAIT_MS = 4_000;
/** Ended orders kept beyond the ones that still matter (trimOrders). */
const ORDERS_KEPT = 200;
/** Blocks come every ~10 minutes; a lease's end is estimated with half again
 *  as long, so a run of slow blocks never ends it early (as magmaJournal.ts). */
const LEASE_MS_PER_BLOCK = 10 * 60_000 * 1.5;
const BLOCKS_PER_YEAR = MAGMA_V2_DEFAULTS.blocksPerYear;

type JsonRpcId = string | number | null;

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
/** A JSON-RPC error. `data.message` always says what went wrong in words:
 *  ZEUS shows `error.data.message` and nothing else (LSPStore.ts), so an
 *  error without it reached the buyer as a spinner that just stopped. */
const rpcError = (id: JsonRpcId, code: number, message: string, data: { message: string } & Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, data },
});

/** The methods this service answers; anything else counts as "other". */
const METHODS = ["lsps0.list_protocols", "lsps1.get_info", "lsps1.create_order", "lsps1.get_order"] as const;
/** The parameters each method knows — validated strictly. Anything else is
 *  accepted and ignored (D14). */
const KNOWN_PARAMS: Record<(typeof METHODS)[number], readonly string[]> = {
  "lsps0.list_protocols": [],
  "lsps1.get_info": [],
  "lsps1.create_order": [
    "lsp_balance_sat",
    "client_balance_sat",
    "required_channel_confirmations",
    "funding_confirms_within_blocks",
    "channel_expiry_blocks",
    "token",
    "refund_onchain_address",
    "announce_channel",
  ],
  "lsps1.get_order": ["order_id"],
};
/** Distinct ignored parameter names / client names kept for the status card
 *  (any peer can send any name: bounded). */
const IGNORED_NAMES_KEPT = 20;
const CLIENTS_KEPT = 10;

/** A name from a peer, safe for a log line and the UI. */
const peerText = (v: unknown, max = 40): string => String(v ?? "").replace(/[^\w .+:/-]/g, "?").slice(0, max);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** After a restart mid-open (or an open whose outcome LND left unclear): how
 *  long LND gets to show the channel before we conclude the open never
 *  happened (same as Magma, magmaDesk.ts). */
const OPENING_GRACE_MS = 10 * 60_000;
/** Opens with an unclear outcome (each followed by the grace above, with no
 *  channel in LND) before the order is refunded instead of tried again. */
const MAX_UNCLEAR_OPENS = 3;

/** ln-service throws array errors: [code, name, { err }] — dig out the detail. */
function lndErrorDetail(err: unknown): string {
  if (Array.isArray(err)) {
    const extra = err[2] as { err?: { details?: string; message?: string } } | undefined;
    return extra?.err?.details ?? extra?.err?.message ?? String(err[1] ?? err[0]);
  }
  return err instanceof Error ? err.message : String(err);
}

/** LND answered that it has no invoice with this hash ("unable to locate
 *  invoice") — an answer, unlike LND not answering at all. */
function isMissingInvoice(err: unknown): boolean {
  let text = lndErrorDetail(err);
  try {
    text += ` ${JSON.stringify(err)}`;
  } catch {
    // circular: the detail alone
  }
  return /unable to locate invoice|InvoiceNotFound/i.test(text);
}

// ── orders ────────────────────────────────────────────────────────────────────

/**
 * A channel this service opened that may still be inside its lease: funded,
 * and not yet past the lease measured generously from its funding. Whatever
 * the order's end: a sold channel carries its routing-fee promise and its
 * share of the deploy cap; one whose order failed after the open (the buyer
 * refunded) still claims its channel, so no other order's open adopts it.
 * The fee autopilot tells the lease's end by block height (leaseCaps.ts);
 * this only decides what may be forgotten.
 */
function lsps1ChannelMayRun(o: Lsps1Order, nowMs: number): boolean {
  if (!o.channel) return false;
  const from = Date.parse(o.channel.fundedAt);
  return !Number.isFinite(from) || nowMs < from + o.channelExpiryBlocks * LEASE_MS_PER_BLOCK;
}

/** The order's channel is open and its payment not claimed yet: the settle
 *  is under way, or LND refused it so far (recovery tries it again). */
function unclaimed(o: Lsps1Order): boolean {
  return o.orderState === "CREATED" && o.paymentState === "HOLD" && !!o.channel;
}

/** The order failed while LND still holds the buyer's payment: the cancel
 *  that releases it is not confirmed yet (failAndRefund). */
function refundPending(o: Lsps1Order): boolean {
  return o.orderState === "FAILED" && (!!o.cancelPending || o.paymentState === "HOLD");
}

export type Lsps1OrderState = "CREATED" | "COMPLETED" | "FAILED";
export type Lsps1PaymentState = "EXPECT_PAYMENT" | "HOLD" | "PAID" | "REFUNDED";

export interface Lsps1Order {
  orderId: string;
  /** Buyer pubkey (the peer that placed the order — also who we open to). */
  peer: string;
  createdAt: string;
  lspBalanceSat: number;
  /** Always 0 — we sell pure inbound, no push amount. */
  clientBalanceSat: number;
  requiredChannelConfirmations: number;
  fundingConfirmsWithinBlocks: number;
  channelExpiryBlocks: number;
  token: string;
  announceChannel: boolean;
  orderState: Lsps1OrderState;
  paymentState: Lsps1PaymentState;
  feeTotalSat: number;
  orderTotalSat: number;
  invoice: string;
  /** Payment hash of the HODL invoice. */
  invoiceId: string;
  /** Preimage — required to settle once the channel is irrevocably opening. */
  invoiceSecret: string;
  invoiceExpiresAt: string;
  channel: { fundedAt: string; fundingOutpoint: string; expiresAt: string } | null;
  /** Written BEFORE the channel open: when it started and which channels to
   *  the buyer existed then. A restart that finds this without `channel`
   *  looks for the open in LND before ever opening again. `unclear` is the
   *  error of an open whose outcome LND left open (a dropped stream, a
   *  timeout) — the same search decides what happened. */
  opening?: { startedAt: string; preExisting: string[]; unclear?: string };
  /** Opens whose outcome was unclear and turned out not to have happened. */
  unclearOpens?: number;
  /** When the buyer's payment was first seen held, and the lowest CLTV
   *  expiry height of its held HTLC(s) as LND last reported it: the end of
   *  the wait for an offline buyer, and the last moment for the open. */
  heldAt?: string;
  heldUntilHeight?: number;
  /** Paid, but the buyer wasn't connected at the last try: since when the
   *  open has been waiting for it (cleared once the open goes ahead). */
  waitingForBuyerSince?: string;
  /** An unpaid quote the same buyer replaced by asking again (its invoice
   *  cancelled): the newer order's id. */
  supersededBy?: string;
  /** The order ended, but LND refused to cancel its invoice: restart
   *  recovery cancels it until LND confirms (failAndRefund). */
  cancelPending?: boolean;
  /** LEGACY: fee paid inline by older versions. The service-fee ledger is the
   *  source of truth for orders completed since. */
  serviceFeePaidSat: number;
  /** The routing-fee promise this sale carries for its lease — the same one
   *  this node's Magma offers make (leaseCaps.ts), locked when the order is
   *  created. The fee autopilot keeps the sold channel within it. Absent on
   *  orders created before the promise existed: nothing was promised then. */
  feeRateCapPpm?: number;
  baseFeeCapSats?: number;
  error?: string;
}

/** What a buyer asks for in create_order — a request with the same terms as
 *  its newest unpaid quote is answered with that quote (sameQuote). */
interface OrderTerms {
  lspBalanceSat: number;
  clientBalanceSat: number;
  requiredChannelConfirmations: number;
  fundingConfirmsWithinBlocks: number;
  channelExpiryBlocks: number;
  token: string;
  announceChannel: boolean;
}

/** Order view for the app UI — never includes the invoice preimage. */
export interface Lsps1OrderView {
  orderId: string;
  peer: string;
  createdAt: string;
  sizeSat: number;
  feeSat: number;
  orderState: Lsps1OrderState;
  paymentState: Lsps1PaymentState;
  channelExpiryBlocks: number;
  invoiceExpiresAt: string;
  fundingOutpoint: string | null;
  serviceFeePaidSat: number;
  /** Paid; the open waits for the buyer to come online (since then). */
  waitingForBuyerSince?: string;
  /** Replaced by a newer order of the same buyer before it was paid. */
  superseded?: boolean;
  /** Failed, and LND still holds the buyer's payment: the refund is tried
   *  again until LND confirms it. */
  refundPending?: boolean;
  error?: string;
}

/** What one JSON-RPC method was asked, and how it was answered. */
export interface Lsps1MethodStats {
  /** One of the methods served, or "other" (unknown method, unreadable message). */
  method: string;
  served: number;
  /** Refusals by JSON-RPC error code, with the last message sent. */
  errors: { code: number; count: number; lastMessage: string; lastAt: string }[];
}

export interface Lsps1Status {
  enabled: boolean;
  /** Peer-message subscription is live (write mode on + LND reachable). */
  running: boolean;
  canWrite: boolean;
  /** Why no new order is taken right now — LND refuses the write macaroon
   *  the peer listing every channel open needs (no peers:read) — or null.
   *  Apart from `lastError`: such a macaroon still reads peer messages, so
   *  the listener runs, and the card (which shows `lastError` only while it
   *  doesn't) said "Listening for LSP clients" and nothing of why every
   *  order was turned away (review of P8, run 2). */
  blocked: string | null;
  /** Requests answered with a result (any method). */
  requestsServed: number;
  /** The last request of any kind — served or refused. */
  lastRequestAt: string | null;
  /** The service's own last error: the peer-message listener's, or an
   *  internal one while handling a request — not why orders are refused. */
  lastError: string | null;
  /** Per method: served and refused (by error code). Before, only served
   *  requests counted — every ZEUS order refused while the card counted its
   *  get_info requests and looked healthy. */
  requests: Lsps1MethodStats[];
  /** Parameters accepted and ignored (D14), by name. */
  ignoredParams: { name: string; count: number }[];
  /** Wallets that named themselves (client_info), the latest first. */
  clients: { app: string; version: string; lastAt: string }[];
  /** Recovery: orders waiting on LND, tried again with backoff. `waiting`
   *  counts them all; of those, `refunds` are failed orders whose payment
   *  LND still holds (it refused the cancel) and `settles` are opened
   *  channels whose payment LND hasn't claimed (it refused the settle). The
   *  rest are orders LND hasn't answered for (e.g. while it starts up). */
  recovery: { waiting: number; refunds: number; settles: number; lastError: string | null; nextTryAt: string | null };
  ordersPending: number;
  ordersCompleted: number;
  ordersFailed: number;
  /** Gross lease fees collected on completed LSPS1 sales. */
  earnedSat: number;
  /** Disclosed service fee on completed sales (same as Magma sales). */
  serviceFeeBps: number;
  /** Graph discovery: feature bit 729 announced? null error = fine/unknown. */
  featureBit: { set: boolean; error: string | null };
  /** Clearnet address announced via peersrpc ("" = none configured). */
  announcedSocket: { address: string; applied: boolean; error: string | null };
  /** What `lsps1.get_info` currently answers — shown in the Settings card. */
  offer: {
    minChannelSat: number;
    maxChannelSat: number;
    deployableSat: number;
    maxChannelExpiryBlocks: number;
    minFundingConfirmsWithinBlocks: number;
  } | null;
}

/** Cached pricing inputs (refreshed every 60s; orders are rare, quotes cheap). */
interface PricingContext {
  at: number;
  /** Routing-adjusted minimum lease yield (ppm of size, per year). */
  minLeasePpmPerYear: number;
  /** Market-level effective price (ppm per year) from the Magma engine, if known. */
  marketPpmPerYear: number | null;
  openCostSat: number;
  closeCostSat: number;
  serviceFeeRate: number;
}

export class Lsps1Service {
  private sub: EventEmitter | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryMs = 10_000;
  private requestsServed = 0;
  private lastRequestAt: string | null = null;
  private lastError: string | null = null;
  /** Per method: served and refused (Lsps1Status.requests). */
  private readonly methodStats = new Map<string, { served: number; errors: Map<number, { count: number; lastMessage: string; lastAt: string }> }>();
  /** Unknown parameters accepted and ignored, by name (D14). */
  private readonly ignoredParams = new Map<string, number>();
  /** Wallets that named themselves in client_info, the latest first. */
  private clients: { app: string; version: string; lastAt: string }[] = [];
  private readonly rateWindow = new Map<string, number[]>();
  /** LND's side of the on-chain budget, at most CHAIN_READS_FRESH_MS old,
   *  and the read under way (one at a time, shared). */
  private chainCache: (ChainReads & { at: number }) | undefined;
  private chainRead: Promise<ChainReads> | undefined;
  /** A read begun at or before this moment no longer stands for the wallet:
   *  an open of ours has spent from it since (recordChannel). */
  private chainSpentAt = 0;
  private pricingCache: PricingContext | undefined;
  /** The market read under way (one at a time, behind the answers). */
  private pricingRefresh: Promise<PricingContext> | undefined;
  /** Retry pacing — instance fields so tests can shrink the waits. */
  private openRetryDelayMs = OPEN_RETRY_DELAY_MS;
  private settleRetryBaseMs = 2_000;
  private recoveryRetryMinMs = RECOVERY_RETRY_MIN_MS;
  private recoveryRetryMs = RECOVERY_RETRY_MIN_MS;
  private pricingWaitMs = PRICING_WAIT_MS;
  /** Recovery: a pass under way, another asked for meanwhile, the timer of
   *  the next try, and LND's last refusal. */
  private recovering = false;
  private recoverAgain = false;
  private recoveryTimer: NodeJS.Timeout | undefined;
  private recoveryNextAt: number | null = null;
  private recoveryError: string | null = null;
  /** Orders the last recovery pass got no answer from LND for. */
  private lookupRefused = new Set<string>();
  /** Orders whose channel is open while LND refused to settle the payment
   *  (settleAndRecord): recovery settles them, with its backoff, until LND
   *  claims the payment. In memory: after a restart the first pass tries
   *  every unclaimed payment anyway. */
  private readonly settleRefused = new Set<string>();
  /** Opens waiting for an offline buyer, by its pubkey: woken early by the
   *  buyer's next LSPS message (or by stop()). */
  private readonly peerWaiters = new Map<string, Set<() => void>>();
  private featureBitSet = false;
  private featureBitError: string | null = null;
  /** Last applied toggle state — detects on→off transitions (withdraw the bit). */
  private lastEnabled: boolean | undefined;
  /** Last clearnet socket applied via peersrpc; undefined = unknown (re-assert). */
  private lastAppliedSocket: string | undefined;
  private socketError: string | null = null;

  private readonly ordersStore: JsonStore<Lsps1Order[]>;
  private orders: Lsps1Order[];
  /** Live invoice subscriptions by payment hash. */
  private readonly invoiceSubs = new Map<string, EventEmitter>();
  /** Orders currently in the open-and-settle critical section. */
  private readonly fulfilling = new Set<string>();
  /** Opens whose funding outpoint is not yet on disk — shutdown waits for these. */
  private opensInFlight = 0;
  /** Set by stop(): no new channel open may begin. */
  private stopping = false;
  private socketTimer: NodeJS.Timeout | undefined;
  /** "Look again for the interrupted open" timers — cleared by stop(). */
  private readonly resumeTimers = new Set<NodeJS.Timeout>();
  /** The on-chain budget shared with Magma selling and the channel autopilot. */
  private readonly capital: CapitalLedger;

  constructor(
    private readonly dataDir: string,
    private readonly readLnd: AuthenticatedLnd,
    private readonly writeLnd: AuthenticatedLnd | undefined,
    private readonly settings: SettingsStore,
    /** Live sell caps (shared with Magma): max channel size, on-chain reserve,
     *  aggregate deploy cap. */
    private readonly caps: () => { maxChannelSats: number; reserveSats: number; maxDeploySats: number },
    /** The Magma engine's inputs (pricing mode, adaptive level, capital caps,
     *  the routing-fee promise), so both demand sources price — and promise —
     *  alike. */
    private readonly pricingMode: () => {
      sellPricingMode: "fast" | "balanced" | "premium" | "auto";
      adaptiveLevel: number;
      offerFeeCaps?: OfferFeeCaps | null;
    },
    private readonly ambossKey: () => string,
    private readonly earnings: EarningsLog,
    /** Completed sales enqueue their service fee here (paid in the background). */
    private readonly serviceFees: ServiceFeeLedger,
    /** Surface a completed sale in the run history / Overview digest. */
    private readonly onSale?: (orderId: string, sizeSats: number, transactionId: string) => void,
    /** Shared with the autopilot (index.ts): one mutex and one set of
     *  reservations for every on-chain commitment. */
    capital?: CapitalLedger,
  ) {
    this.ordersStore = new JsonStore<Lsps1Order[]>(dataDir, "lsps1-orders.json");
    this.orders = this.ordersStore.read([]);
    this.capital = capital ?? new CapitalLedger();
    this.capital.register("lsps1", {
      reservations: () => this.reservations(),
      deployedSat: () => this.deployedSat(),
      claimedOutpoints: () => this.orders.map((o) => o.channel?.fundingOutpoint ?? ""),
      leaseCaps: () => this.leaseCaps(),
      soldLeases: () => this.soldLeases(),
    });
  }

  /** Every channel this service sold whose lease may still run, promise or
   *  not (the rebalancer never pulls from them). */
  soldLeases(): SoldLease[] {
    return this.orders
      .filter((o) => o.orderState !== "FAILED" && !!o.channel?.fundingOutpoint)
      .map((o) => ({
        fundingOutpoint: o.channel?.fundingOutpoint as string,
        source: "lsps1" as const,
        orderId: o.orderId,
        leaseBlocks: o.channelExpiryBlocks > 0 ? o.channelExpiryBlocks : 4_320,
      }));
  }

  /** The routing-fee promises of the channels this service sold (a failed
   *  order sold nothing, so it promised nothing). */
  leaseCaps(): LeaseCap[] {
    return this.orders
      .filter((o) => o.orderState !== "FAILED" && o.channel)
      .map((o) =>
        leaseCapFrom({
          fundingOutpoint: o.channel?.fundingOutpoint,
          source: "lsps1",
          orderId: o.orderId,
          feeRateCapPpm: o.feeRateCapPpm,
          baseFeeCapSats: o.baseFeeCapSats,
          leaseBlocks: o.channelExpiryBlocks,
        }),
      )
      .filter((c): c is LeaseCap => c !== null);
  }

  start(): void {
    this.applySettings();
    // Whether LND lists its peers to the write client at all (peers:read):
    // without it no order's channel can be opened — the status says so from
    // the start, and no order is taken (createOrder).
    if (this.writeLnd) void checkPeerListing(this.writeLnd);
    void this.recoverOrders();
    // Hourly re-check of the announced clearnet address: a DDNS name follows
    // the home IP, so re-resolve and swap the announcement when it moved.
    this.socketTimer = setInterval(() => void this.applyAnnouncedSocket(), 60 * 60_000);
    this.socketTimer.unref?.();
  }

  /**
   * Process shutdown. Stops listening and refuses to start new channel opens;
   * the graph announcements are left as they are (this is not "LSP mode off").
   * Held payments stay held — restart recovery resumes them, and every state
   * change is already on disk. Await `waitForOpens()` before exiting so an open
   * that already started can record its funding outpoint.
   */
  stop(): void {
    this.stopping = true;
    if (this.socketTimer) clearInterval(this.socketTimer);
    this.socketTimer = undefined;
    for (const t of this.resumeTimers) clearTimeout(t);
    this.resumeTimers.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryNextAt = null;
    // Opens waiting for an offline buyer return now (they see `stopping` and
    // leave the payment held: restart recovery resumes them).
    for (const waiters of [...this.peerWaiters.values()]) for (const wake of [...waiters]) wake();
    // Detach directly (stopSub() would log "LSP mode off", which it isn't).
    this.sub?.removeAllListeners();
    this.sub = undefined;
    for (const sub of this.invoiceSubs.values()) sub.removeAllListeners();
    this.invoiceSubs.clear();
  }

  /** Resolves when no channel open is between broadcast and its record on disk. */
  async waitForOpens(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.opensInFlight > 0) {
      if (Date.now() >= deadline) return false;
      await sleep(100);
    }
    return true;
  }

  /** Call after the LSP-mode toggle or clearnet address changes — starts/stops
   *  the subscription and keeps the graph announcements in sync. */
  applySettings(): void {
    const enabled = this.settings.get().lspModeEnabled && !!this.writeLnd;
    if (enabled) {
      this.startSub(); // asserts the feature bit
    } else {
      this.stopSub();
      // Withdraw only on a real on→off transition — a boot with the mode off
      // shouldn't touch (and needlessly re-gossip) the node announcement.
      if (this.lastEnabled) void this.advertiseFeature(false);
    }
    this.lastEnabled = enabled;
    // The clearnet announcement is independent of the LSP toggle — reachability
    // helps the node either way, and buyers may connect before enabling.
    void this.applyAnnouncedSocket();
  }

  /** Announce (or withdraw) the configured clearnet address via peersrpc.
   *
   *  LND resolves a hostname only ONCE when it's announced, so for DDNS names
   *  (dynamic home IPs) we resolve ourselves, announce the IP literal, and
   *  re-check hourly — when the IP behind the name changes, the stale address
   *  is withdrawn and the new one announced. Runtime announcements also don't
   *  survive an LND restart, so the reconnect path re-asserts too. */
  private async applyAnnouncedSocket(): Promise<void> {
    if (!this.writeLnd) return;
    const desired = (this.settings.get().lspClearnetAddress ?? "").trim();
    let target = ""; // the ip:port we actually announce ("" = withdraw)
    try {
      if (desired) {
        const [host, port] = desired.split(":");
        const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : (await lookup(host, { family: 4 })).address;
        target = `${ip}:${port}`;
      }
      if (this.lastAppliedSocket === target) {
        this.socketError = null;
        return; // same IP as announced — nothing to gossip
      }
      // IP changed / address cleared: withdraw the previous announcement (boot
      // = unknown, nothing to withdraw — LND lost runtime updates on restart).
      if (this.lastAppliedSocket) {
        await this.lndRemoveSocket(this.lastAppliedSocket).catch(() => undefined);
      }
      if (target) await this.lndAddSocket(target);
      this.lastAppliedSocket = target;
      this.socketError = null;
      if (target) console.log(`[lsps1] announcing clearnet address ${target} (${desired}) in the node graph`);
    } catch (err) {
      const detail = lndErrorDetail(err);
      // A no-op add means the address is already announced (e.g. via lnd.conf).
      if (/already|no modification/i.test(detail)) {
        this.lastAppliedSocket = target;
        this.socketError = null;
        return;
      }
      this.socketError = detail;
      console.warn(`[lsps1] could not announce clearnet address "${desired}": ${detail}`);
    }
  }

  /** Advertise (or withdraw) `option_supports_lsps` in the node announcement.
   *  Best-effort: a node without a public graph presence, or an LND without the
   *  peersrpc subserver, can't announce — LSP mode still works via directly
   *  shared URIs, so this never blocks; the Settings card shows the outcome. */
  private async advertiseFeature(on: boolean): Promise<void> {
    if (!this.writeLnd) return;
    try {
      if (on) await addAdvertisedFeature({ lnd: this.writeLnd, feature: LSPS_FEATURE_BIT });
      else await removeAdvertisedFeature({ lnd: this.writeLnd, feature: LSPS_FEATURE_BIT });
      this.featureBitSet = on;
      this.featureBitError = null;
      console.log(`[lsps1] feature bit ${LSPS_FEATURE_BIT} ${on ? "announced" : "withdrawn"} in the node graph`);
    } catch (err) {
      const detail = lndErrorDetail(err);
      // A no-op update means the bit already is in the desired state.
      if (/already|no modification|not set|not advertised/i.test(detail)) {
        this.featureBitSet = on;
        this.featureBitError = null;
        return;
      }
      if (on) this.featureBitSet = false;
      this.featureBitError = detail;
      console.warn(`[lsps1] could not ${on ? "announce" : "withdraw"} feature bit ${LSPS_FEATURE_BIT}: ${detail}`);
    }
  }

  /** Capital promised to paid-but-not-yet-opened orders. */
  committedSat(): number {
    return this.orders
      .filter((o) => o.orderState === "CREATED" && o.paymentState === "HOLD" && !o.channel)
      .reduce((s, o) => s + o.lspBalanceSat, 0);
  }

  /** This service's share of the shared capital ledger: PAID orders whose
   *  channel isn't open yet. An unpaid quote is not a promise anyone else
   *  must honour: any peer connected in LSP mode can ask for one (two per
   *  peer, ten in all, renewable hourly), and counting them let quotes nobody
   *  meant to pay turn Magma buyers away and sink an already paid Magma order. */
  reservations(): Reservation[] {
    return this.orders
      .filter((o) => o.orderState === "CREATED" && o.paymentState === "HOLD" && !o.channel)
      .map((o) => ({ key: `lsps1:${o.orderId}`, sats: o.lspBalanceSat, reserveSat: this.caps().reserveSats }));
  }

  /** Unpaid quotes: LSPS1's own soft claims. They count against its NEW
   *  quotes (so two buyers aren't quoted the same coins) and its own deploy
   *  headroom — never against Magma or the open of a paid order. */
  private unpaidQuotes(exceptOrderId?: string): Reservation[] {
    return this.orders
      .filter((o) => o.orderState === "CREATED" && o.paymentState === "EXPECT_PAYMENT" && !o.channel && o.orderId !== exceptOrderId)
      .map((o) => ({ key: `lsps1:${o.orderId}`, sats: o.lspBalanceSat, reserveSat: this.caps().reserveSats }));
  }

  /** Capital sitting in LSPS1-sold channels whose lease hasn't expired —
   *  counts against the shared sellMaxDeploySats cap (as Magma's deployed does). */
  deployedSat(): number {
    const now = Date.now();
    // A channel opened but not yet settled counts too: it is no longer a
    // reservation (the funding transaction is out), but the capital is sold.
    return this.orders
      .filter(
        (o) => o.orderState !== "FAILED" && o.channel && new Date(o.channel.expiresAt).getTime() > now,
      )
      .reduce((s, o) => s + o.lspBalanceSat, 0);
  }

  /** Deploy-cap headroom for a NEW order: cap minus everything sold and still
   *  leased (Magma and LSPS1), minus every promised order of both demand
   *  sources, minus this service's own unpaid quotes (so two of its buyers
   *  can't oversell the cap together; MAX_PENDING_* keeps that abuse-bounded).
   *  `exceptOrderId`: a quote the new order replaces (supersede). */
  private deployHeadroomSat(exceptOrderId?: string): number {
    const unpaid = this.unpaidQuotes(exceptOrderId).reduce((s, r) => s + r.sats, 0);
    return Math.max(0, this.caps().maxDeploySats - this.capital.deployedSat() - this.capital.reservedSat() - unpaid);
  }

  orderViews(): Lsps1OrderView[] {
    return this.orders.map((o) => ({
      orderId: o.orderId,
      peer: o.peer,
      createdAt: o.createdAt,
      sizeSat: o.lspBalanceSat,
      feeSat: o.feeTotalSat,
      orderState: o.orderState,
      paymentState: o.paymentState,
      channelExpiryBlocks: o.channelExpiryBlocks,
      invoiceExpiresAt: o.invoiceExpiresAt,
      fundingOutpoint: o.channel?.fundingOutpoint ?? null,
      serviceFeePaidSat: this.serviceFees.paidFor("lsps1", o.orderId) ?? o.serviceFeePaidSat,
      ...(o.waitingForBuyerSince && o.orderState === "CREATED" ? { waitingForBuyerSince: o.waitingForBuyerSince } : {}),
      ...(o.supersededBy ? { superseded: true } : {}),
      ...(refundPending(o) ? { refundPending: true } : {}),
      error: o.error,
    }));
  }

  async status(): Promise<Lsps1Status> {
    const enabled = this.settings.get().lspModeEnabled;
    let offer: Lsps1Status["offer"] = null;
    if (this.writeLnd) {
      try {
        offer = await this.offerView();
      } catch {
        // Chain balance unavailable — status still renders without the offer.
      }
    }
    const completed = this.orders.filter((o) => o.orderState === "COMPLETED");
    const lnd = this.recoveryCounts();
    const waiting = lnd.lookups + lnd.refunds + lnd.settles;
    return {
      enabled,
      running: !!this.sub,
      canWrite: !!this.writeLnd,
      // No new order while LND refuses the write macaroon the peer listing
      // every open needs (createOrder) — said for as long as it does.
      blocked: opensBlocked(this.writeLnd),
      requestsServed: this.requestsServed,
      lastRequestAt: this.lastRequestAt,
      lastError: this.lastError,
      requests: [...this.methodStats].map(([method, s]) => ({
        method,
        served: s.served,
        errors: [...s.errors].map(([code, e]) => ({ code, ...e })),
      })),
      ignoredParams: [...this.ignoredParams].map(([name, count]) => ({ name, count })),
      clients: this.clients.map((c) => ({ ...c })),
      recovery: {
        waiting,
        refunds: lnd.refunds,
        settles: lnd.settles,
        lastError: waiting > 0 ? this.recoveryError : null,
        nextTryAt: waiting > 0 && this.recoveryNextAt !== null ? new Date(this.recoveryNextAt).toISOString() : null,
      },
      ordersPending: this.orders.filter((o) => o.orderState === "CREATED").length,
      ordersCompleted: completed.length,
      ordersFailed: this.orders.filter((o) => o.orderState === "FAILED").length,
      earnedSat: completed.reduce((s, o) => s + o.feeTotalSat, 0),
      serviceFeeBps: saleFeeConfig().bps,
      featureBit: { set: this.featureBitSet, error: this.featureBitError },
      announcedSocket: {
        address: (this.settings.get().lspClearnetAddress ?? "").trim(),
        applied: !!this.lastAppliedSocket && this.socketError == null,
        error: this.socketError,
      },
      offer,
    };
  }

  // ── transport ────────────────────────────────────────────────────────────────

  private startSub(): void {
    if (this.sub || !this.writeLnd || this.stopping) return;
    try {
      const sub = subscribeToPeerMessages({ lnd: this.writeLnd });
      sub.on("message_received", (m: { message: string; public_key: string; type: number }) => {
        void this.onMessage(m);
      });
      sub.on("error", (err: unknown) => {
        this.lastError = err instanceof Error ? err.message : JSON.stringify(err);
        this.scheduleReconnect();
      });
      this.sub = sub;
      this.lastError = null;
      this.retryMs = 10_000;
      console.log("[lsps1] LSP mode on — listening for LSPS peer messages (type 37913)");
      // (Re)assert the graph announcements: an LND restart (the usual reason
      // this stream reconnects) drops runtime announcement updates.
      void this.advertiseFeature(true);
      this.lastAppliedSocket = undefined;
      void this.applyAnnouncedSocket();
      // LND is back (or just switched on): every order not yet followed is
      // picked up now rather than at the recovery's next try; and a price is
      // ready before the first wallet asks.
      void this.recoverOrders();
      void this.refreshPricing().catch(() => undefined);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
    }
  }

  private stopSub(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.sub) return;
    // Removing all listeners terminates the underlying gRPC subscription. Note:
    // in-flight ORDER watchers stay alive regardless of the toggle — a held
    // payment must always resolve to settled or refunded.
    this.sub.removeAllListeners();
    this.sub = undefined;
    console.log("[lsps1] LSP mode off — stopped listening");
  }

  /** LND restarts drop the stream — retry with backoff while the mode is on. */
  private scheduleReconnect(): void {
    this.sub?.removeAllListeners();
    this.sub = undefined;
    if (!this.settings.get().lspModeEnabled || this.retryTimer || this.stopping) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 300_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.settings.get().lspModeEnabled) this.startSub();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async onMessage(msg: { message: string; public_key: string; type: number }): Promise<void> {
    // Hard boundary: this handles input from ARBITRARY network peers, and the
    // process-level unhandledRejection handler exits — nothing a peer sends may
    // ever escape as a rejection, or a single message becomes a crash-loop DoS.
    try {
      if (msg.type !== LSPS0_MESSAGE_TYPE) return;
      if (!this.settings.get().lspModeEnabled) return;
      if (!this.allowPeer(msg.public_key)) return; // over budget → stay silent
      // A message from the buyer: it is connected right now — a paid order
      // waiting for it opens at once instead of at its next check.
      this.wakePeer(msg.public_key);
      const raw = Buffer.from(msg.message, "hex").toString("utf8");
      const response = await this.dispatch(raw, msg.public_key);
      if (response) await this.send(msg.public_key, response);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[lsps1] peer message handling failed: ${this.lastError}`);
    }
  }

  private async send(publicKey: string, payload: object): Promise<void> {
    if (!this.writeLnd) return;
    try {
      await sendMessageToPeer({
        lnd: this.writeLnd,
        public_key: publicKey,
        type: LSPS0_MESSAGE_TYPE,
        message: Buffer.from(JSON.stringify(payload), "utf8").toString("hex"),
      });
    } catch {
      // Peer disconnected before the reply — per LSPS0 no different from a
      // delivered response the client never acted on.
    }
  }

  /** Sliding one-minute window per pubkey; map bounded so peers can't grow it. */
  private allowPeer(pubkey: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const hits = (this.rateWindow.get(pubkey) ?? []).filter((t) => t > cutoff);
    hits.push(now);
    this.rateWindow.set(pubkey, hits);
    if (this.rateWindow.size > RATE_LIMIT_MAX_PEERS) {
      for (const [key, times] of this.rateWindow) {
        if (!times.some((t) => t > cutoff)) this.rateWindow.delete(key);
      }
    }
    return hits.length <= RATE_LIMIT_PER_MINUTE;
  }

  // ── JSON-RPC dispatch ────────────────────────────────────────────────────────

  /** One request: answered, and counted per method — served or refused by
   *  error code (the Settings card shows both). */
  private async dispatch(raw: string, peer: string): Promise<Record<string, unknown> | null> {
    let method = "other";
    const response = await this.answer(raw, peer, (m) => (method = (METHODS as readonly string[]).includes(m) ? m : "other"));
    if (response) this.track(method, response);
    return response;
  }

  private async answer(raw: string, peer: string, named: (method: string) => void): Promise<Record<string, unknown> | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("payload is not a single JSON object");
      }
    } catch {
      console.warn("[lsps1] unparseable LSPS payload from peer (ignored)");
      return rpcError(null, -32700, "Parse error", { message: "the message is not one JSON-RPC 2.0 object (UTF-8 JSON)" });
    }

    const { jsonrpc, id, method, params } = parsed as {
      jsonrpc?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    // Clients MUST NOT send notifications — nothing to respond to; drop it.
    if (id === undefined) return null;
    const rid: JsonRpcId = typeof id === "string" || typeof id === "number" ? id : null;
    if (jsonrpc !== "2.0" || typeof method !== "string") {
      return rpcError(rid, -32600, "Invalid Request", { message: 'a JSON-RPC 2.0 request needs jsonrpc "2.0" and a method name' });
    }
    named(method);
    // bLIP-50: params must be by-name (an object), never by-position.
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return rpcError(rid, -32602, "Invalid params", { message: "params must be passed by name (a JSON object)" });
    }
    const p = (params ?? {}) as Record<string, unknown>;
    if ((METHODS as readonly string[]).includes(method)) this.ignoreUnknown(method as (typeof METHODS)[number], p);

    switch (method) {
      case "lsps0.list_protocols":
        return rpcResult(rid, { protocols: [1] });
      case "lsps1.get_info": {
        try {
          const info = await this.getInfo();
          // A wallet asks get_info before it orders: the price is ready by then.
          void this.refreshPricing({ ifStale: true }).catch(() => undefined);
          return rpcResult(rid, info);
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
          return rpcError(rid, -32603, "Internal error", { message: "the LSP could not read its node — try again shortly" });
        }
      }
      case "lsps1.create_order": {
        try {
          return await this.createOrder(rid, peer, p);
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
          console.warn(`[lsps1] create_order failed: ${lndErrorDetail(err)}`);
          return rpcError(rid, -32603, "Internal error", { message: "the LSP could not create the order — try again shortly" });
        }
      }
      case "lsps1.get_order": {
        const orderId = p.order_id;
        if (typeof orderId !== "string") {
          return rpcError(rid, -32602, "Invalid params", { property: "order_id", message: "order_id must be a string" });
        }
        // Orders are private to the peer that created them.
        const order = this.orders.find((o) => o.orderId === orderId && o.peer === peer);
        if (!order) return rpcError(rid, 101, "Not found", { message: "no order with this id for your node" });
        return rpcResult(rid, this.orderPayload(order));
      }
      default:
        return rpcError(rid, -32601, "Method not found", { message: `this LSP does not offer ${peerText(method, 60)}` });
    }
  }

  /**
   * D14: a parameter this method doesn't know is accepted and ignored — named
   * in the log (once per name) and counted for the Settings card. ZEUS's
   * `client_info` is informational: the wallet and version it names are kept
   * for the card too. Known parameters are validated strictly by each method.
   */
  private ignoreUnknown(method: (typeof METHODS)[number], p: Record<string, unknown>): void {
    const known = KNOWN_PARAMS[method];
    const extra = Object.keys(p).filter((k) => !known.includes(k));
    if (extra.length === 0) return;
    const fresh: string[] = [];
    for (const raw of extra) {
      const name = peerText(raw, 64) || "?";
      const seen = this.ignoredParams.get(name);
      if (seen === undefined && this.ignoredParams.size >= IGNORED_NAMES_KEPT) continue;
      if (seen === undefined) fresh.push(name);
      this.ignoredParams.set(name, (seen ?? 0) + 1);
    }
    if (fresh.length) console.log(`[lsps1] ${method}: ignoring parameter(s) this LSP doesn't use: ${fresh.join(", ")}`);
    const info = p.client_info;
    if (info && typeof info === "object" && !Array.isArray(info)) {
      const i = info as Record<string, unknown>;
      const app = peerText(i.app);
      const version = peerText(i.app_version ?? i.version);
      if (app) this.noteClient(app, version);
    }
  }

  private noteClient(app: string, version: string): void {
    const known = this.clients.some((c) => c.app === app && c.version === version);
    if (!known) console.log(`[lsps1] a wallet named itself: ${app}${version ? ` ${version}` : ""}`);
    this.clients = [
      { app, version, lastAt: new Date().toISOString() },
      ...this.clients.filter((c) => !(c.app === app && c.version === version)),
    ].slice(0, CLIENTS_KEPT);
  }

  /** Count a request's answer under its method. */
  private track(method: string, response: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.lastRequestAt = now;
    const s = this.methodStats.get(method) ?? { served: 0, errors: new Map() };
    this.methodStats.set(method, s);
    const error = response.error as { code?: number; data?: { message?: string } } | undefined;
    if (!error) {
      s.served += 1;
      this.requestsServed += 1;
      return;
    }
    const code = typeof error.code === "number" ? error.code : 0;
    const e = s.errors.get(code) ?? { count: 0, lastMessage: "", lastAt: now };
    s.errors.set(code, { count: e.count + 1, lastMessage: error.data?.message ?? "", lastAt: now });
  }

  // ── LND seams ────────────────────────────────────────────────────────────────
  // Every fund-moving/lookup call in the order path goes through these
  // one-liners, so the state machine can be exercised without a node in tests.

  private lndCreateHodl(id: string, tokens: number, description: string, expiresAt: string) {
    return createHodl(this.writeLnd!, { id, tokens, description, expiresAt, cltvDelta: HODL_CLTV_DELTA });
  }
  private lndSettle(secret: string) {
    return settleHodl(this.writeLnd!, secret);
  }
  private lndCancel(id: string) {
    return cancelHodl(this.writeLnd!, id);
  }
  private lndInvoice(id: string) {
    return getInvoice({ lnd: this.writeLnd!, id });
  }
  /** The open itself — the buyer was connected before the mutex (lndConnect).
   *  The channel carries its order's tag, so an open whose outcome is unclear
   *  is found in LND by its own order (findOurOpen). */
  private lndOpen(order: Lsps1Order, feeRate: number | undefined) {
    return fundChannel(this.writeLnd!, {
      pubkey: order.peer,
      localTokens: order.lspBalanceSat,
      feeRate,
      isPrivate: !order.announceChannel,
      description: saleTag("lsps1", order.orderId),
    });
  }
  /** The chain tip LND knows (the held payment's deadline is a height). */
  private async lndHeight(): Promise<number> {
    return (await getWalletInfo({ lnd: this.writeLnd! })).current_block_height;
  }
  /** The buyer placed the order over BOLT8, so it is usually still a peer;
   *  if not, the graph's addresses are dialed (Tor: up to ~1.5 min). */
  private lndConnect(pubkey: string) {
    return ensureConnected(this.writeLnd!, pubkey, []);
  }
  private lndFeeRate(confirmationTarget: number) {
    return getChainFeeRate({ lnd: this.writeLnd!, confirmation_target: confirmationTarget });
  }
  private lndAddSocket(socket: string) {
    return addExternalSocket({ lnd: this.writeLnd!, socket });
  }
  private lndRemoveSocket(socket: string) {
    return removeExternalSocket({ lnd: this.writeLnd!, socket });
  }

  // ── the offer ────────────────────────────────────────────────────────────────

  /**
   * On-chain capital a NEW order could be funded with: balance minus the
   * effective reserve (the sell reserve or LND's anchor reserve, whichever is
   * larger, plus a funding fee for this open and every promised one — D5),
   * minus every promise: paid orders of both demand sources (the shared
   * ledger) and this service's own unpaid quotes, as they stand now.
   * `exceptOrderId`: a quote the new order replaces (supersede) — not
   * counted. LND's side is read at most every CHAIN_READS_FRESH_MS (get_info,
   * the status card, create_order's first look); `fresh` reads it now
   * (create_order's check inside the mutex). Before, a request replacing a
   * quote always read LND afresh, outside the mutex — one read per request a
   * spamming peer sent.
   */
  private async quotableSat(fresh = false, exceptOrderId?: string): Promise<number> {
    if (!this.writeLnd) return 0;
    const reads = await this.chainReads(fresh);
    return spendableWith(reads, this.capital, this.caps().reserveSats, { extra: this.unpaidQuotes(exceptOrderId) }).spendableSat;
  }

  /** LND's balance and reserve inputs: from the cache unless `fresh`. A
   *  fresh read never joins one already under way — that one may have
   *  started before a spend the caller must see. */
  private async chainReads(fresh: boolean): Promise<ChainReads> {
    const cached = this.chainCache;
    if (!fresh && cached && Date.now() - cached.at <= CHAIN_READS_FRESH_MS) return cached;
    if (!fresh && this.chainRead) return this.chainRead;
    // Dated when it began; a read that began earlier never replaces it, nor
    // one that began before an open of ours spent from the wallet.
    const startedAt = Date.now();
    const read = readChain(this.writeLnd!).then((r) => {
      if (startedAt > this.chainSpentAt && (!this.chainCache || this.chainCache.at <= startedAt)) this.chainCache = { ...r, at: startedAt };
      return r;
    });
    if (fresh) return read;
    const shared: Promise<ChainReads> = read.finally(() => {
      if (this.chainRead === shared) this.chainRead = undefined;
    });
    this.chainRead = shared;
    return shared;
  }

  /** What the open of a PAID order may use, fresh: the shared ledger minus
   *  its own reservation — an unpaid quote never stands in a paid order's way. */
  private async fundableFor(order: Lsps1Order): Promise<number> {
    const sp = await spendableOnchain(this.writeLnd!, this.capital, this.caps().reserveSats, { exceptKey: `lsps1:${order.orderId}` });
    return sp.spendableSat;
  }

  private async offerView(exceptOrderId?: string) {
    const deployable = await this.quotableSat(false, exceptOrderId);
    // Never advertise more than we could actually fund, capped by the shared
    // Magma sell cap; clamped up to min so the min ≤ max spec constraint holds
    // even when the wallet is empty. The clamp vouches for nothing:
    // create_order checks the real capital before it quotes — against
    // `deployableSat` first, then fresh, inside the on-chain mutex.
    const maxChannelSat = Math.max(
      LSPS1_LIMITS.minChannelSat,
      Math.min(deployable, this.caps().maxChannelSats),
    );
    return {
      minChannelSat: LSPS1_LIMITS.minChannelSat,
      maxChannelSat,
      deployableSat: deployable,
      maxChannelExpiryBlocks: LSPS1_LIMITS.maxChannelExpiryBlocks,
      minFundingConfirmsWithinBlocks: LSPS1_LIMITS.minFundingConfirmsWithinBlocks,
    };
  }

  /** bLIP-51 `lsps1.get_info` result — sat amounts are strings per spec. */
  private async getInfo(): Promise<Record<string, unknown>> {
    const offer = await this.offerView();
    const min = String(LSPS1_LIMITS.minChannelSat);
    const max = String(offer.maxChannelSat);
    return {
      min_required_channel_confirmations: LSPS1_LIMITS.minRequiredChannelConfirmations,
      min_funding_confirms_within_blocks: LSPS1_LIMITS.minFundingConfirmsWithinBlocks,
      supports_zero_channel_reserve: LSPS1_LIMITS.supportsZeroChannelReserve,
      max_channel_expiry_blocks: LSPS1_LIMITS.maxChannelExpiryBlocks,
      // We sell pure inbound: the client side starts empty (no push amount).
      min_initial_client_balance_sat: "0",
      max_initial_client_balance_sat: "0",
      min_initial_lsp_balance_sat: min,
      max_initial_lsp_balance_sat: max,
      min_channel_balance_sat: min,
      max_channel_balance_sat: max,
    };
  }

  // ── pricing ──────────────────────────────────────────────────────────────────

  /**
   * Pricing inputs: the market level from the shared Magma engine, the profit
   * floor, the on-chain costs. Not read in the request path while a price is
   * known: fresh for a minute, and up to PRICING_STALE_OK_MS old it is used
   * as it is while a refresh runs behind the answer. With none at all (the
   * first order after a start), the market gets PRICING_WAIT_MS, then the
   * local profit floor answers and the market read lands for the next order.
   * (Before, every order more than a minute after the last one waited for
   * the engine's Amboss reads — over Tor when routed so — and ZEUS gives up
   * on create_order after 7 s; the order was made anyway, and two such
   * abandoned quotes locked the buyer out for an hour.)
   */
  private async pricingContext(): Promise<PricingContext> {
    const cached = this.pricingCache;
    const age = cached ? Date.now() - cached.at : Infinity;
    if (cached && age < PRICING_FRESH_MS) return cached;
    const refresh = this.refreshPricing();
    if (cached && age < PRICING_STALE_OK_MS) {
      void refresh.catch(() => undefined);
      return cached;
    }
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.pricingWaitMs);
    });
    try {
      const ctx = await Promise.race([refresh, waited]);
      if (ctx) return ctx;
    } catch {
      // the market read failed outright: the local floor below
    } finally {
      clearTimeout(timer);
    }
    void refresh.catch(() => undefined);
    return this.localPricing();
  }

  /** Read the pricing inputs now — one read at a time, shared by whoever
   *  asks meanwhile. `ifStale`: only when the cached price isn't fresh. */
  private refreshPricing(opts: { ifStale?: boolean } = {}): Promise<PricingContext> {
    const cached = this.pricingCache;
    if (opts.ifStale && cached && Date.now() - cached.at < PRICING_FRESH_MS) return Promise.resolve(cached);
    this.pricingRefresh ??= this.readPricing()
      .then((ctx) => {
        this.pricingCache = ctx;
        return ctx;
      })
      .finally(() => {
        this.pricingRefresh = undefined;
      });
    return this.pricingRefresh;
  }

  /** The market from the Magma engine; the local profit floor when the
   *  market can't be read. */
  private async readPricing(): Promise<PricingContext> {
    try {
      const report = await this.marketReport();
      const rec = report.sell.recommendations[0];
      return {
        at: Date.now(),
        minLeasePpmPerYear: report.sell.recommendedMinLeasePpmPerYear,
        marketPpmPerYear:
          rec != null
            ? rec.recommended.effectiveFeePpm / (rec.recommended.minBlockLength / BLOCKS_PER_YEAR)
            : null,
        openCostSat: report.sell.onchainOpenCostSat,
        closeCostSat: report.sell.onchainCloseCostSat,
        serviceFeeRate: saleFeeConfig().bps / 10_000,
      };
    } catch {
      // Market unreachable — quote from the local profit floor only.
      return this.localPricing();
    }
  }

  /** The local profit floor alone: no market level. */
  private async localPricing(): Promise<PricingContext> {
    const oc = await onchainCosts(this.readLnd);
    return {
      at: Date.now(),
      minLeasePpmPerYear: Math.round(MAGMA_V2_DEFAULTS.defaultRoutingOpportunityPpmPerYear * MAGMA_V2_DEFAULTS.minLeaseVsRoutingRatio),
      marketPpmPerYear: null,
      openCostSat: oc.openCostSat,
      closeCostSat: oc.closeCostSat,
      serviceFeeRate: saleFeeConfig().bps / 10_000,
    };
  }

  /** The Magma engine's report — the market side of the price (a seam). */
  private marketReport() {
    return getMagmaRecommendations(this.readLnd, this.ambossKey(), this.pricingMode());
  }

  /** Price an order: market level scaled to the requested duration, never below
   *  the profit floor (routing opportunity + on-chain costs + min net profit,
   *  all net of the service fee) — the same economics Magma selling uses. */
  private async quote(sizeSat: number, durationBlocks: number): Promise<{ feeTotalSat: number; effectivePpm: number }> {
    const ctx = await this.pricingContext();
    const years = durationBlocks / BLOCKS_PER_YEAR;
    const costPpm = ((ctx.openCostSat + ctx.closeCostSat) / sizeSat) * 1_000_000;
    const floorRouting = (ctx.minLeasePpmPerYear * years + costPpm) / (1 - ctx.serviceFeeRate);
    const floorMinProfit =
      ((MAGMA_V2_DEFAULTS.minNetLeaseProfitSat + ctx.openCostSat + ctx.closeCostSat) /
        (sizeSat * (1 - ctx.serviceFeeRate))) *
      1_000_000;
    const floor = Math.max(floorRouting, floorMinProfit, MAGMA_V2_DEFAULTS.minFeeRatePpm);
    const market = ctx.marketPpmPerYear != null ? ctx.marketPpmPerYear * years : 0;
    const effectivePpm = Math.min(Math.max(floor, market), MAGMA_V2_DEFAULTS.maxFeeRatePpm);
    return { feeTotalSat: Math.ceil((sizeSat * effectivePpm) / 1_000_000), effectivePpm: Math.round(effectivePpm) };
  }

  // ── create_order ─────────────────────────────────────────────────────────────

  private async createOrder(
    rid: JsonRpcId,
    peer: string,
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.writeLnd) return rpcError(rid, -32603, "Internal error", { message: "this LSP has no write access to its node" });
    const invalid = (property: string, message: string) =>
      rpcError(rid, -32602, "Invalid params", { property, message: `${property} ${message}` });
    const mismatch = (property: string, message: string) =>
      rpcError(rid, 100, "Option mismatch", { property, message: `${property}: ${message}` });
    const refused = (message: string) => rpcError(rid, 1, "Client rejected", { message });

    // Sat amounts arrive as strings per spec (tolerate plain numbers).
    const satParam = (v: unknown): number | null => {
      const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : typeof v === "number" ? v : NaN;
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    const uintParam = (v: unknown): number | null =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

    const lspBalanceSat = satParam(p.lsp_balance_sat);
    if (lspBalanceSat == null) return invalid("lsp_balance_sat", "must be a satoshi amount string");
    const clientBalanceSat = satParam(p.client_balance_sat);
    if (clientBalanceSat == null) return invalid("client_balance_sat", "must be a satoshi amount string");
    const requiredConfs = uintParam(p.required_channel_confirmations);
    if (requiredConfs == null) return invalid("required_channel_confirmations", "must be an unsigned integer");
    const confirmsWithin = uintParam(p.funding_confirms_within_blocks);
    if (confirmsWithin == null) return invalid("funding_confirms_within_blocks", "must be an unsigned integer");
    const expiryBlocks = uintParam(p.channel_expiry_blocks);
    if (expiryBlocks == null) return invalid("channel_expiry_blocks", "must be an unsigned integer");
    if (typeof p.announce_channel !== "boolean") return invalid("announce_channel", "must be a boolean");
    const token = p.token === undefined ? "" : p.token;
    if (typeof token !== "string" || token.length > 512) return invalid("token", "must be a short string");
    if (p.refund_onchain_address !== undefined && typeof p.refund_onchain_address !== "string") {
      return invalid("refund_onchain_address", "must be a string");
    }
    const announceChannel = p.announce_channel;
    const terms: OrderTerms = {
      lspBalanceSat,
      clientBalanceSat,
      requiredChannelConfirmations: requiredConfs,
      fundingConfirmsWithinBlocks: confirmsWithin,
      channelExpiryBlocks: expiryBlocks,
      token,
      announceChannel,
    };

    // The same request again — ZEUS gives up on an answer after 7 s, and
    // the buyer taps again: the quote already made is the answer. No new
    // invoice, no LND read, no turn of the mutex.
    const same = this.sameQuote(peer, terms);
    if (same) return rpcResult(rid, this.orderPayload(same));

    // LND refuses the write macaroon the peer listing every open needs (no
    // peers:read — found at start, or by an open): asked again (cheap), and
    // while it still refuses, no order is made — a buyer must not pay for a
    // channel this node can't open. The buyer hears only that; the operator
    // reads why in the LSP status (status()).
    if (opensBlocked(this.writeLnd)) {
      await checkPeerListing(this.writeLnd);
      if (opensBlocked(this.writeLnd)) return refused("this LSP can't open channels right now — try again later");
    }

    // Abuse caps: open (unresolved) orders, per peer and total, and the
    // pace of asking again (orderSlot). A buyer at its own cap that asks
    // for something else replaces its oldest unpaid quote — once the new
    // order has passed every check below; before, two abandoned quotes
    // refused the buyer for the hour their invoices ran. A first look here,
    // before anything is read or priced: a request refused here costs no
    // LND call. What decides is the look inside the on-chain mutex, where
    // orders are made.
    const early = this.orderSlot(peer);
    if ("refuse" in early) return refused(early.refuse);

    // Options must match what lsps1.get_info advertises (error 100 otherwise)
    // — from LND's balance as last read (≤ 30 s), against the promises as
    // they stand; the quote being replaced doesn't count against it.
    const offer = await this.offerView(early.replace?.orderId);
    if (clientBalanceSat !== 0) return mismatch("client_balance_sat", "a client balance is not supported (max 0)");
    if (lspBalanceSat < offer.minChannelSat) {
      return mismatch("lsp_balance_sat", `below min_initial_lsp_balance_sat (${offer.minChannelSat})`);
    }
    if (lspBalanceSat > offer.maxChannelSat) {
      return mismatch("lsp_balance_sat", `above max_initial_lsp_balance_sat (${offer.maxChannelSat})`);
    }
    if (requiredConfs < LSPS1_LIMITS.minRequiredChannelConfirmations) {
      return mismatch("required_channel_confirmations", "zero-conf is not supported");
    }
    if (confirmsWithin < LSPS1_LIMITS.minFundingConfirmsWithinBlocks) {
      return mismatch(
        "funding_confirms_within_blocks",
        `below min_funding_confirms_within_blocks (${LSPS1_LIMITS.minFundingConfirmsWithinBlocks})`,
      );
    }
    if (expiryBlocks < 1 || expiryBlocks > LSPS1_LIMITS.maxChannelExpiryBlocks) {
      return mismatch(
        "channel_expiry_blocks",
        `this LSP leases channels for 1 to ${LSPS1_LIMITS.maxChannelExpiryBlocks} blocks (about ${Math.round(LSPS1_LIMITS.maxChannelExpiryBlocks / 4_380)} months)`,
      );
    }
    // The operator's per-channel limit (sellMaxChannelSats, shared with
    // Magma selling). get_info's maximum is clamped up to the 1M minimum so
    // min ≤ max holds, and the size checks above compare with that clamped
    // figure: with the limit set below 1M (0 included), a 1M order was
    // quoted and, once paid, a 1M channel opened — against the limit the
    // docs promise. Refused here, before any capital look or LND read.
    const perChannel = this.caps().maxChannelSats;
    if (lspBalanceSat > perChannel) {
      return refused(
        perChannel < LSPS1_LIMITS.minChannelSat
          ? "this LSP is not selling channels right now"
          : `this LSP is not selling channels of this size right now (its per-channel limit is ${perChannel} sat)`,
      );
    }
    // Aggregate deploy cap (shared with Magma selling): reject up front rather
    // than refunding a paid order later.
    const atCap = () => refused("this LSP is at its capital deployment cap — try again later");
    if (lspBalanceSat > this.deployHeadroomSat(early.replace?.orderId)) return atCap();
    // The coins, as last read: get_info's maximum is clamped up to the 1M
    // minimum (min ≤ max), so with less than that to spend the size checks
    // above let every 1M request through. Without this look, each one took
    // a turn of the on-chain mutex and a fresh LND read only to be refused
    // in there — and, making no order, never counted against the buyer's
    // pace: any connected peer could keep the mutex that every Magma accept
    // and open waits on busy, 30 times a minute. The look inside the mutex,
    // with a fresh read, still decides: a figure too high here only lets the
    // request on to it; one too low (coins that arrived since) refuses until
    // the next read, at most CHAIN_READS_FRESH_MS later.
    // Below the smallest channel sold there is no smaller one to suggest — and
    // the exact coins on chain below 1M are nobody's business (get_info
    // shows what is fundable from 1M up, never less).
    const noCapital = (availableSat: number) =>
      refused(
        availableSat < LSPS1_LIMITS.minChannelSat
          ? "this LSP has no on-chain capital for a channel right now — try again later"
          : `this LSP has no on-chain capital for a channel this size right now (${availableSat} sat available) — try a smaller channel or later`,
      );
    if (lspBalanceSat > offer.deployableSat) return noCapital(offer.deployableSat);

    // Pricing may ask Amboss for the market — never while holding the mutex.
    const { feeTotalSat } = await this.quote(lspBalanceSat, expiryBlocks);
    // The routing-fee promise of this sale, locked now (leaseCaps.ts).
    const caps = this.pricingMode().offerFeeCaps ?? null;

    // The coins must exist NOW, net of every promise: checked with a fresh
    // balance inside the on-chain mutex, and the order recorded in the same
    // turn — so a Magma accept or another quote can't plan the same coins at
    // the same moment. (get_info's maximum is clamped up to the minimum so
    // min ≤ max holds; it never vouched for capital. Before, an order up to
    // that clamped maximum was taken on with nothing behind it.)
    return this.capital.mutex.run("lsps1 order", async () => {
      // The same request that crossed this one made its quote meanwhile:
      // that quote is the answer.
      const made = this.sameQuote(peer, terms);
      if (made) return rpcResult(rid, this.orderPayload(made));
      // The caps and the pace again, as the orders stand now. Requests of
      // one buyer that crossed had each picked the same oldest quote above:
      // the first replaced it, and every other one, finding it gone, made
      // its order beside the rest — four at once left a buyer with five
      // open orders (cap: two), and the total cap gave way the same way.
      // Orders are made only in here, one at a time, so this count holds.
      const slot = this.orderSlot(peer);
      if ("refuse" in slot) return refused(slot.refuse);
      const replace = slot.replace;
      if (lspBalanceSat > this.deployHeadroomSat(replace?.orderId)) return atCap();
      const spendable = await this.quotableSat(true, replace?.orderId);
      if (lspBalanceSat > spendable) return noCapital(spendable);

      const orderId = randomUUID();
      // Only now, with the new order sure to be made, the quote it replaces
      // is cancelled. One paid meanwhile stays — and opens.
      const replaced = replace ? await this.supersede(replace, orderId) : "replaced";
      if (replaced === "paid") return refused("your earlier order was just paid — its channel is being opened; wait for it before ordering again");
      if (replaced === "unclear") return refused("this LSP could not cancel your earlier unpaid order right now — try again in a minute");

      // HODL invoice: we hold the payment until the channel is irrevocably
      // opening, then settle with the preimage; every failure path cancels
      // instead — the buyer's payment automatically bounces back.
      const { id: invoiceId, secret } = newHodlSecret();
      const expiresAt = new Date(Date.now() + ORDER_EXPIRY_MS).toISOString();
      const inv = await this.lndCreateHodl(
        invoiceId,
        feeTotalSat,
        `LSPS1 ${orderId}: ${lspBalanceSat} sat channel for ${expiryBlocks} blocks`,
        expiresAt,
      );

      const order: Lsps1Order = {
        orderId,
        peer,
        createdAt: new Date().toISOString(),
        lspBalanceSat,
        clientBalanceSat: 0,
        requiredChannelConfirmations: requiredConfs,
        fundingConfirmsWithinBlocks: confirmsWithin,
        channelExpiryBlocks: expiryBlocks,
        token,
        announceChannel,
        orderState: "CREATED",
        paymentState: "EXPECT_PAYMENT",
        feeTotalSat,
        orderTotalSat: feeTotalSat, // + client_balance (always 0)
        invoice: inv.request,
        invoiceId,
        invoiceSecret: secret,
        invoiceExpiresAt: expiresAt,
        channel: null,
        serviceFeePaidSat: 0,
        ...(caps ? { feeRateCapPpm: caps.feeRateCapPpm, baseFeeCapSats: caps.baseFeeCapSats } : {}),
      };
      this.orders.unshift(order); // counts against the next quote at once (unpaidQuotes)
      this.persistOrders();
      this.watchInvoice(order);
      console.log(`[lsps1] order ${orderId}: ${lspBalanceSat} sat / ${expiryBlocks} blocks → ${feeTotalSat} sat fee`);
      return rpcResult(rid, this.orderPayload(order));
    });
  }

  /**
   * Room for a new order of `peer` under the abuse caps, as the orders stand
   * now: the reason it is refused, or the slot — with the buyer's oldest
   * unpaid quote it replaces when the buyer is at its own cap (the total
   * doesn't grow then). Only an unpaid quote no open has started on is ever
   * replaced, never a paid one. Asking again has a pace: a replacement no
   * sooner than REQUOTE_MIN_GAP_MS after the buyer's last order, and no more
   * than ORDERS_PER_PEER_PER_HOUR new orders an hour, replaced ones included
   * — every one is a hold invoice and a turn of the on-chain mutex. Reads
   * nothing from LND: a request refused here costs nothing.
   */
  private orderSlot(peer: string, nowMs = Date.now()): { refuse: string } | { replace?: Lsps1Order } {
    const pending = this.orders.filter((o) => o.orderState === "CREATED");
    const mine = pending.filter((o) => o.peer === peer);
    let replace: Lsps1Order | undefined;
    if (mine.length >= MAX_PENDING_PER_PEER) {
      // The list is newest first: on equal times the later one is older.
      replace = mine
        .filter((o) => o.paymentState === "EXPECT_PAYMENT" && !o.channel && !this.fulfilling.has(o.orderId))
        .reduce<Lsps1Order | undefined>((oldest, o) => (!oldest || Date.parse(o.createdAt) <= Date.parse(oldest.createdAt) ? o : oldest), undefined);
      if (!replace) return { refuse: "you have paid orders here whose channels are still being opened — wait for them before ordering again" };
    }
    // Every order of this buyer counts here — replaced, expired and failed
    // ones too: a replaced quote was an invoice all the same.
    const ages = this.orders
      .filter((o) => o.peer === peer)
      .map((o) => nowMs - Date.parse(o.createdAt))
      .filter((a) => Number.isFinite(a));
    const lastHour = ages.filter((a) => a < 3_600_000).length;
    if (lastHour >= ORDERS_PER_PEER_PER_HOUR) {
      return { refuse: `you asked for ${lastHour} new quotes within the hour — pay the one you have, or try again later` };
    }
    if (replace) {
      if (ages.some((a) => a < REQUOTE_MIN_GAP_MS)) return { refuse: "you asked for a new quote a moment ago — pay it or try again in a minute" };
      return { replace };
    }
    if (pending.length >= MAX_PENDING_TOTAL) return { refuse: "this LSP has too many open orders right now — try again later" };
    return {};
  }

  /**
   * The buyer's quote for exactly these terms, if it is still the one to
   * pay: its newest unpaid quote (no open started, not being replaced),
   * made less than SAME_QUOTE_MS ago, with the same channel, lease,
   * confirmations, announcement and token. A wallet that gave up waiting
   * and asks again gets it back — its invoice still has most of its hour.
   */
  private sameQuote(peer: string, terms: OrderTerms, nowMs = Date.now()): Lsps1Order | null {
    // The list is newest first: on equal times the earlier entry is newer.
    const newest = this.orders
      .filter((o) => o.peer === peer && o.orderState === "CREATED" && o.paymentState === "EXPECT_PAYMENT" && !o.channel && !o.supersededBy)
      .reduce<Lsps1Order | undefined>((n, o) => (!n || Date.parse(o.createdAt) > Date.parse(n.createdAt) ? o : n), undefined);
    if (!newest || this.fulfilling.has(newest.orderId)) return null;
    const age = nowMs - Date.parse(newest.createdAt);
    if (!(age < SAME_QUOTE_MS)) return null; // (NaN: a damaged record — never reused)
    const same =
      newest.lspBalanceSat === terms.lspBalanceSat &&
      newest.clientBalanceSat === terms.clientBalanceSat &&
      newest.requiredChannelConfirmations === terms.requiredChannelConfirmations &&
      newest.fundingConfirmsWithinBlocks === terms.fundingConfirmsWithinBlocks &&
      newest.channelExpiryBlocks === terms.channelExpiryBlocks &&
      newest.announceChannel === terms.announceChannel &&
      newest.token === terms.token;
    return same ? newest : null;
  }

  /**
   * Replace a buyer's unpaid quote: its invoice cancelled, the order ended.
   * "paid" when it turns out paid (the payment held, or it is being opened):
   * it stays — and opens. "unclear" when LND can't say how it stands, or
   * refuses the cancel: it stays as it is.
   *
   * While it is looked at, the order is kept off the open path (`fulfilling`):
   * a payment that arrives in between must not start an open of a channel
   * whose payment this then cancels. Once LND has cancelled the invoice, a
   * payment that arrived meanwhile has gone back to the buyer.
   */
  private async supersede(old: Lsps1Order, byOrderId: string): Promise<"replaced" | "paid" | "unclear"> {
    // Read afresh after every await: the invoice watch may move the order on.
    const now = () => ({ order: old.orderState as Lsps1OrderState, payment: old.paymentState as Lsps1PaymentState });
    if (now().order !== "CREATED") return "replaced"; // ended meanwhile: nothing left to replace
    if (now().payment !== "EXPECT_PAYMENT" || old.channel || this.fulfilling.has(old.orderId)) return "paid";
    this.fulfilling.add(old.orderId);
    try {
      const inv = await this.lndInvoice(old.invoiceId);
      if (inv.is_held || inv.is_confirmed) return "paid";
      if (!inv.is_canceled) await this.lndCancel(old.invoiceId);
      // The invoice watch may have marked it failed as the cancel landed
      // ("expired unpaid"): the record says what really ended it.
      if (now().payment === "HOLD") old.paymentState = "REFUNDED";
      old.orderState = "FAILED";
      old.supersededBy = byOrderId;
      old.error = "replaced by a newer order of the same buyer before it was paid";
      this.persistOrders();
      console.log(`[lsps1] order ${old.orderId}: unpaid, replaced by the buyer's new order ${byOrderId}`);
      return "replaced";
    } catch (err) {
      console.warn(`[lsps1] could not replace order ${old.orderId}: ${lndErrorDetail(err)}`);
      return "unclear";
    } finally {
      this.fulfilling.delete(old.orderId);
      // Paid while it was looked at: open it now (the watch's own call found
      // it busy).
      if (now().order === "CREATED" && now().payment === "HOLD") void this.fulfill(old);
    }
  }

  /** bLIP-51 order object, shared by create_order and get_order. */
  private orderPayload(o: Lsps1Order): Record<string, unknown> {
    return {
      order_id: o.orderId,
      lsp_balance_sat: String(o.lspBalanceSat),
      client_balance_sat: String(o.clientBalanceSat),
      required_channel_confirmations: o.requiredChannelConfirmations,
      funding_confirms_within_blocks: o.fundingConfirmsWithinBlocks,
      channel_expiry_blocks: o.channelExpiryBlocks,
      token: o.token,
      created_at: o.createdAt,
      announce_channel: o.announceChannel,
      order_state: o.orderState,
      payment: {
        bolt11: {
          state: o.paymentState,
          expires_at: o.invoiceExpiresAt,
          fee_total_sat: String(o.feeTotalSat),
          order_total_sat: String(o.orderTotalSat),
          invoice: o.invoice,
        },
      },
      channel: o.channel
        ? {
            funded_at: o.channel.fundedAt,
            funding_outpoint: o.channel.fundingOutpoint,
            expires_at: o.channel.expiresAt,
          }
        : null,
    };
  }

  private persistOrders(): void {
    this.trimOrders();
    this.ordersStore.write(this.orders);
  }

  /**
   * Keep the newest ORDERS_KEPT orders, and beyond them every order that
   * still matters: one in progress (its held payment, reservation and
   * invoice watch live here), one whose payment still has to be released
   * (needsRecovery), and one whose channel's lease may still run —
   * its routing-fee promise (leaseCaps), its claimed outpoint and its share
   * of the deploy cap must outlive the trim. Before, a plain slice dropped
   * them: any peer can leave ~10 abandoned orders an hour (MAX_PENDING_TOTAL,
   * one-hour expiry), so a 30-day sale lost its promise about 20 hours in,
   * and the fee autopilot stopped keeping its channel within the cap.
   */
  private trimOrders(nowMs = Date.now()): void {
    let others = 0;
    this.orders = this.orders.filter(
      (o) => o.orderState === "CREATED" || this.needsRecovery(o) || lsps1ChannelMayRun(o, nowMs) || ++others <= ORDERS_KEPT,
    );
  }

  // ── payment → channel-open state machine ────────────────────────────────────

  /** Follow the order's invoice in LND. False when the watch could not be
   *  set up (restart recovery tries again). */
  private watchInvoice(order: Lsps1Order): boolean {
    if (!this.writeLnd) return false;
    if (this.invoiceSubs.has(order.invoiceId)) return true;
    let sub: EventEmitter;
    try {
      sub = subscribeToInvoice({ lnd: this.writeLnd, id: order.invoiceId });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
    this.invoiceSubs.set(order.invoiceId, sub);
    const detach = () => {
      sub.removeAllListeners();
      this.invoiceSubs.delete(order.invoiceId);
    };
    sub.on("invoice_updated", (inv: { is_held?: boolean; is_confirmed: boolean; is_canceled?: boolean; payments?: { is_held?: boolean; timeout?: number }[] }) => {
      if (inv.is_held && order.orderState === "CREATED" && order.paymentState === "EXPECT_PAYMENT") {
        order.paymentState = "HOLD";
        this.noteHeld(order, heldUntilHeightOf(inv));
        this.persistOrders();
        console.log(`[lsps1] order ${order.orderId}: payment held — opening channel to ${order.peer.slice(0, 12)}…`);
        void this.fulfill(order);
      } else if (inv.is_confirmed) {
        detach(); // settled — fulfill() already recorded completion
      } else if (inv.is_canceled) {
        // Either we cancelled (refund path) or the invoice expired unpaid —
        // or LND released a payment we were still holding (its HTLC near
        // expiry).
        if (order.orderState === "CREATED" && order.channel) {
          // Its channel is open: the settle never got through in time.
          this.channelUnpaid(order, "LND released the buyer's held payment before it could be claimed");
        } else if (order.orderState === "CREATED") {
          if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
          order.orderState = "FAILED";
          // Say why, not the wait's own note.
          if (order.waitingForBuyerSince) order.error = "the buyer stayed offline until its held payment had to be released — refunded";
          order.error ??= order.paymentState === "REFUNDED" ? "payment refunded" : "order expired unpaid";
          this.persistOrders();
        }
        detach();
      }
    });
    sub.on("error", () => {
      detach();
      // Re-attach later while the order is still live (LND restart etc.).
      const timer = setTimeout(() => {
        const current = this.orders.find((o) => o.orderId === order.orderId);
        if (current && current.orderState === "CREATED") this.watchInvoice(current);
      }, 30_000);
      timer.unref?.();
    });
    return true;
  }

  /** Open the channel for a held payment, settle on success, refund on failure.
   *  Settle happens ONLY after the funding tx is broadcast — never before. */
  private async fulfill(order: Lsps1Order): Promise<void> {
    if (!this.writeLnd || this.fulfilling.has(order.orderId)) return;
    this.fulfilling.add(order.orderId);
    try {
      // A channel was already funded for this order (e.g. settle failed and we
      // restarted) — never open a second one; just finish claiming the payment.
      if (order.channel) {
        await this.settleAndRecord(order);
        return;
      }
      // An open was under way when the process last stopped (its outpoint
      // never reached the disk), or ended with an unclear error: find that
      // channel in LND before anything else.
      if (order.opening) {
        const found = await this.reconcileOpening(order);
        if (found === "found") {
          await this.settleAndRecord(order);
          return;
        }
        if (found === "wait") {
          this.resumeLater(order);
          return;
        }
        if ((order.unclearOpens ?? 0) >= MAX_UNCLEAR_OPENS) {
          await this.failAndRefund(order, `the channel open failed ${order.unclearOpens} times without a clear answer from LND`);
          return;
        }
      }

      // Honor funding_confirms_within_blocks via the chain fee estimator.
      let feeRate: number | undefined;
      try {
        feeRate = (await this.lndFeeRate(order.fundingConfirmsWithinBlocks)).tokens_per_vbyte;
      } catch {
        feeRate = undefined; // let LND pick
      }

      // The buyer must be connected as a peer: it reached us over BOLT8, but a
      // phone wallet may go offline right after paying, and there is no
      // address to dial it at. bLIP-51: the LSP MUST wait for the peer
      // connection before opening — so wait, for as long as the held payment
      // allows (holdLeft), checking every openRetryDelayMs and at once when
      // the buyer sends anything. (Before: ten tries a minute apart, then a
      // refund — while the payment could have stayed held for hours.)
      let lastError = "open not attempted";
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) await this.waitForPeer(order.peer, this.openRetryDelayMs);
        // Shutting down: leave the payment held. Restart recovery resumes this
        // order from its saved state — far better than being killed mid-open.
        if (this.stopping) return;
        const hold = await this.holdLeft(order);
        if (hold.kind === "gone") {
          lastError = "payment no longer held";
          break;
        }
        if (hold.kind === "late") {
          lastError = hold.why;
          break;
        }
        // LND didn't answer the lookup: no open on a payment it can't vouch
        // for — look again (bounded: holdLeft's deadline runs by the clock).
        if (hold.kind === "unknown") continue;
        if (this.stopping) return;
        // Connect first, OUTSIDE the mutex: dialing over Tor can take a minute
        // and a half, and must not hold up anyone else's open meanwhile. LND
        // refusing the write macaroon the peer listing (no peers:read) throws
        // MissingPermission: no open is possible until the operator fixes the
        // macaroon and restarts, so the order ends at once — refunded, with
        // that reason (below) — never read as a buyer that is offline.
        if (!(await this.lndConnect(order.peer))) {
          lastError = couldNotConnect(order.peer);
          this.noteWaitingForBuyer(order, true);
          continue; // the buyer may reconnect — wait for it
        }
        this.noteWaitingForBuyer(order, false);
        if (this.stopping) return;
        // One open at a time across Magma, LSPS1 and the autopilot — held only
        // for this attempt, never across the retry wait above.
        let step: Awaited<ReturnType<Lsps1Service["openOnce"]>>;
        try {
          step = await this.capital.mutex.run("lsps1 open", () => this.openOnce(order, feeRate));
        } catch (err) {
          // LND didn't answer a read before the open (the balance, the
          // buyer's channels): nothing was sent — try again in a while.
          lastError = lndErrorDetail(err);
          continue;
        }
        if (step.done) {
          // The outpoint is on record: claim the held payment — after the
          // mutex. Settling retries with waits of up to 10 s (30 s in all);
          // inside the mutex those held up every Magma accept and open.
          if (order.channel) await this.settleAndRecord(order);
          return;
        }
        if (step.unclear) {
          // LND may have funded it: look for the channel before anything else.
          this.resumeLater(order);
          return;
        }
        lastError = step.error;
        // Only a connect problem (or the buyer's pending-channel limit) is
        // worth waiting out; anything else is final.
        if (!step.retry) break;
      }
      await this.failAndRefund(order, lastError);
    } catch (err) {
      await this.failAndRefund(order, err instanceof Error ? err.message : String(err));
    } finally {
      this.fulfilling.delete(order.orderId);
    }
  }

  /** The payment is held: since when (the first time it is seen), and until
   *  which block its HTLC may stay held, as LND reports it. */
  private noteHeld(order: Lsps1Order, heldUntil: number | null): void {
    order.heldAt ??= new Date().toISOString();
    if (heldUntil !== null) order.heldUntilHeight = heldUntil;
  }

  /**
   * Whether the held payment still allows an open: held in LND, with at least
   * OPEN_MIN_BLOCKS_LEFT blocks before its HTLC expires (LND cancels a held
   * HTLC itself shortly before that, and an open the payment can't outlive
   * gives the channel away). The expiry height is LND's, recorded with the
   * order; with none known, or no height to compare it with, the deadline is
   * HELD_FALLBACK_MS after the payment was first seen held — by the clock, so
   * an LND that stops answering ends the wait too.
   */
  private async holdLeft(
    order: Lsps1Order,
  ): Promise<{ kind: "ok" } | { kind: "gone" } | { kind: "late"; why: string } | { kind: "unknown" }> {
    let held: boolean | null = null;
    let until: number | null = null;
    try {
      const inv = await this.lndInvoice(order.invoiceId);
      held = !!inv.is_held;
      until = heldUntilHeightOf(inv as { payments?: { is_held?: boolean; timeout?: number }[] });
    } catch {
      held = null; // LND didn't answer
    }
    if (held === false) return { kind: "gone" };
    const before = `${order.heldAt}|${order.heldUntilHeight}`;
    this.noteHeld(order, until);
    if (`${order.heldAt}|${order.heldUntilHeight}` !== before) this.persistOrders();
    const waited = order.waitingForBuyerSince ? "the buyer did not come back online before" : "no open was possible before";
    if (order.heldUntilHeight) {
      const height = await this.lndHeight().catch(() => null);
      if (height !== null) {
        const left = order.heldUntilHeight - height;
        if (left < OPEN_MIN_BLOCKS_LEFT) {
          return { kind: "late", why: `${waited} its held payment had to be released (${Math.max(0, left)} blocks left, ${OPEN_MIN_BLOCKS_LEFT} needed for the open)` };
        }
        return held ? { kind: "ok" } : { kind: "unknown" };
      }
    }
    const heldAt = Date.parse(order.heldAt ?? "");
    if (Number.isFinite(heldAt) && Date.now() - heldAt > HELD_FALLBACK_MS) {
      return { kind: "late", why: `${waited} its held payment had to be released (${Math.round(HELD_FALLBACK_MS / 3_600_000)} h after it was paid)` };
    }
    return held ? { kind: "ok" } : { kind: "unknown" };
  }

  /** The open waits for the buyer to come online (on), or goes ahead (off):
   *  on record, so the Orders tab says what is happening. */
  private noteWaitingForBuyer(order: Lsps1Order, on: boolean): void {
    if (on && !order.waitingForBuyerSince) {
      order.waitingForBuyerSince = new Date().toISOString();
      order.error = "the buyer is offline — its payment stays held, and the channel opens as soon as it reconnects";
      this.persistOrders();
      console.log(`[lsps1] order ${order.orderId}: paid, the buyer is offline — waiting for it to reconnect`);
    } else if (!on && order.waitingForBuyerSince) {
      order.waitingForBuyerSince = undefined;
      if (order.error?.startsWith("the buyer is offline")) order.error = undefined;
      this.persistOrders();
    }
  }

  /** Resolves after `ms`, or as soon as the buyer `pubkey` sends a message
   *  (wakePeer), or at stop(). */
  private waitForPeer(pubkey: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiters = this.peerWaiters.get(pubkey) ?? new Set<() => void>();
      this.peerWaiters.set(pubkey, waiters);
      const wake = () => {
        clearTimeout(timer);
        waiters.delete(wake);
        if (waiters.size === 0 && this.peerWaiters.get(pubkey) === waiters) this.peerWaiters.delete(pubkey);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      waiters.add(wake);
    });
  }

  /** The buyer `pubkey` is connected (it just sent a message): every open
   *  waiting for it looks again now. */
  private wakePeer(pubkey: string): void {
    for (const wake of [...(this.peerWaiters.get(pubkey) ?? [])]) wake();
  }

  /** One open attempt, inside the on-chain mutex: check capital with a fresh
   *  balance, record the intent, open, record the outpoint. `done` with the
   *  channel on the order: the caller settles, once the mutex is released. */
  private async openOnce(
    order: Lsps1Order,
    feeRate: number | undefined,
  ): Promise<{ done: true } | { done: false; error: string; retry: boolean; unclear?: boolean }> {
    // Only an order still under way with its payment held is opened. It may
    // have ended while this open waited for the mutex — its quote replaced
    // (supersede cancels it in here), its payment released, the order
    // refunded: an open now would give the channel away. Whoever ended it
    // has seen to its payment; nothing is left to do here.
    if (order.orderState !== "CREATED" || order.paymentState !== "HOLD") {
      console.warn(`[lsps1] order ${order.orderId}: ended (${order.orderState}, payment ${order.paymentState}) before its channel was opened — not opened`);
      return { done: true };
    }
    // Capital gate with a FRESH balance, net of everything promised elsewhere
    // (paid orders only — an unpaid quote never blocks a paid order).
    const deployable = await this.fundableFor(order);
    if (order.lspBalanceSat > deployable) {
      return { done: false, error: "insufficient on-chain capital at open time", retry: false };
    }
    // Deploy cap re-check at open time — catches a cap the user LOWERED
    // after this order was created (create-time already serialized siblings).
    if (this.capital.deployedSat() + order.lspBalanceSat > this.caps().maxDeploySats) {
      return { done: false, error: "capital deployment cap reached", retry: false };
    }
    // The per-channel limit likewise: lowered below this order's size since
    // it was quoted, the channel is not sold — the payment goes back.
    if (order.lspBalanceSat > this.caps().maxChannelSats) {
      return { done: false, error: `the per-channel limit (${this.caps().maxChannelSats} sat) is below this order's ${order.lspBalanceSat} sat`, retry: false };
    }
    const preExisting = (await channelsWith(this.writeLnd!, order.peer)).map((c) => c.outpoint);
    // Check again: the reads above waited on LND, and a shutdown that began
    // meanwhile has already been told "no open in flight" (the count below is
    // still 0) — the process may exit at any moment. An open started now could
    // fund a channel whose outpoint never reaches disk. Leave the payment held
    // instead; restart recovery resumes it. Nothing below awaits before the
    // count goes up, so this check cannot go stale.
    if (this.stopping) return { done: true };
    // Never move funds we couldn't record: if the order file can't be written
    // now, the funding outpoint couldn't be either. Refund instead. The
    // "opening" mark it saves is what a restart uses to find this open.
    order.opening = { startedAt: new Date().toISOString(), preExisting };
    try {
      this.ordersStore.writeOrThrow(this.orders);
    } catch (err) {
      order.opening = undefined;
      return {
        done: false,
        error: `cannot save order state (${err instanceof Error ? err.message : String(err)}) — refunded instead of opening`,
        retry: false,
      };
    }
    this.opensInFlight += 1;
    try {
      const res = await this.lndOpen(order, feeRate);
      if (res.ok && res.transactionId) {
        this.recordChannel(order, `${res.transactionId}:${res.transactionVout ?? 0}`);
        return { done: true };
      }
      // An error after the broadcast must not lead to a refund plus a channel.
      const found = await this.findOurOpen(order).catch(() => null);
      if (found) {
        this.recordChannel(order, found);
        return { done: true };
      }
      const error = res.error ?? "open failed";
      if (!isPreBroadcastRefusal(error)) {
        // Not a refusal LND gives before funding (a dropped stream, a
        // timeout, an unknown error): LND may have broadcast without showing
        // the channel yet. The "opening" mark stays, and reconcileOpening
        // decides once LND has had ample time — no refund (the buyer would
        // keep a free channel) and no second open before that.
        order.opening = { ...(order.opening ?? { startedAt: new Date().toISOString(), preExisting }), unclear: error };
        order.error = `open outcome unclear (${error}) — looking for the channel in LND before anything else`;
        this.persistOrders();
        return { done: false, error, retry: false, unclear: true };
      }
      order.opening = undefined;
      this.persistOrders();
      // The buyer's LND takes one pending channel at a time by default: that
      // clears once the earlier channel confirms — worth waiting out too.
      return { done: false, error, retry: error.includes("couldn't connect") || isPendingChannelsLimit(error) };
    } finally {
      this.opensInFlight -= 1;
    }
  }

  /** The channel this order's open funded, if LND shows one — never one
   *  another sale has claimed: LSPS1's own, and Magma's (the same buyer may
   *  have bought a channel of the same size there; adopting it would have the
   *  buyer pay twice for one channel). The open tagged its channel with the
   *  order (lndOpen): a channel with this order's tag is the one, and one
   *  tagged for another order is never taken — even one not on record yet. */
  private async findOurOpen(order: Lsps1Order): Promise<string | null> {
    const found = await findOpenedChannel(this.writeLnd!, {
      pubkey: order.peer,
      capacity: order.lspBalanceSat,
      exclude: [...(order.opening?.preExisting ?? []), ...this.capital.claimedOutpoints()],
      tag: saleTag("lsps1", order.orderId),
    });
    return found?.outpoint ?? null;
  }

  /** An "opening" mark without a channel: the process stopped mid-open, or
   *  the open's outcome was unclear. Adopt the channel LND shows; give LND
   *  time before concluding there is none — and only then may a new open
   *  start.
   *
   *  The lookup and its record happen under the on-chain mutex: a sale's open
   *  (LSPS1's, Magma's) holds it until its funding outpoint is recorded, so
   *  the lookup never meets a channel LND lists already for another sale that
   *  hasn't claimed it yet — and takes it as this order's, settling this
   *  buyer's payment for a channel another buyer paid for. The mutex isn't
   *  re-entrant: never call this from inside it (openOnce looks with
   *  findOurOpen itself). */
  private async reconcileOpening(order: Lsps1Order): Promise<"found" | "wait" | "none"> {
    return this.capital.mutex.run("lsps1 reconcile", async () => {
      // LND not answering is no answer: look again later. (Before, a failed
      // lookup read as "no channel" — once the grace was over, a second open
      // followed for an order whose channel may well exist: say, right after
      // a restart, while LND is still starting up.)
      const found = await this.findOurOpen(order).catch(() => undefined);
      if (found === undefined) return "wait";
      if (found) {
        const expiresAt = new Date(Date.now() + order.channelExpiryBlocks * 10 * 60_000).toISOString();
        order.channel = { fundedAt: order.opening?.startedAt ?? new Date().toISOString(), fundingOutpoint: found, expiresAt };
        order.opening = undefined;
        this.persistOrders();
        console.log(`[lsps1] order ${order.orderId}: found the channel of the interrupted open (${found})`);
        return "found";
      }
      const startedAt = order.opening ? Date.parse(order.opening.startedAt) : 0;
      if (Date.now() - startedAt < OPENING_GRACE_MS) return "wait";
      if (order.opening?.unclear) order.unclearOpens = (order.unclearOpens ?? 0) + 1;
      order.opening = undefined;
      this.persistOrders();
      return "none";
    });
  }

  /** Look for an interrupted open's channel again in a minute. */
  private resumeLater(order: Lsps1Order): void {
    if (this.stopping) return;
    const t = setTimeout(() => {
      this.resumeTimers.delete(t);
      const current = this.orders.find((o) => o.orderId === order.orderId);
      if (current && current.orderState === "CREATED" && current.paymentState === "HOLD") void this.fulfill(current);
    }, 60_000);
    t.unref?.();
    this.resumeTimers.add(t);
  }

  /** Funding tx is broadcast — record the outpoint FIRST (so a crash can never
   *  lead to a second open for the same order); the caller then settles and
   *  books the sale, outside the on-chain mutex.
   *
   *  If the record cannot be saved (the disk filled up since the save before
   *  the open), fail closed: the outpoint stays in memory, so this process
   *  never opens again for the order; an alert says what happened; and after
   *  a restart the "opening" mark saved before the open leads recovery to this
   *  channel in LND instead of to a second open. The payment is still settled
   *  — the channel was delivered. */
  private recordChannel(order: Lsps1Order, fundingOutpoint: string): void {
    const expiresAt = new Date(Date.now() + order.channelExpiryBlocks * 10 * 60_000).toISOString();
    order.channel = { fundedAt: new Date().toISOString(), fundingOutpoint, expiresAt };
    order.opening = undefined;
    // Its reservation ends here, and the balance last read still holds the
    // coins the open just spent: read LND again for the next quote.
    this.chainCache = undefined;
    this.chainRead = undefined;
    this.chainSpentAt = Date.now();
    try {
      this.trimOrders();
      this.ordersStore.writeOrThrow(this.orders);
    } catch (err) {
      const detail =
        `LSP order ${order.orderId}: channel ${fundingOutpoint} opened, but it could not be saved ` +
        `(${err instanceof Error ? err.message : String(err)}). It will not be opened again; after a restart it is found in LND.`;
      console.error(`[lsps1] CRITICAL ${detail}`);
      recordStoreIncident(this.dataDir, { file: "lsps1-orders.json", kind: "unrecorded_open", detail });
    }
  }

  /**
   * The channel is irrevocably opening: claim the held payment. If LND
   * refuses the settle (busy, restarting) it is tried again — five times
   * here, then by recovery, with its backoff (30 s, doubling to 5 min),
   * until LND claims the payment: the alternative is a channel given away.
   * The channel on record blocks any second open meanwhile, and the preimage
   * is on disk. (Before, only a restart tried again: a process that ran on
   * until LND released the held HTLC — about a day — gave the channel away.)
   */
  private async settleAndRecord(order: Lsps1Order): Promise<void> {
    if (!this.writeLnd) return;
    let settled = false;
    let detail = "";
    for (let attempt = 0; attempt < 5 && !settled; attempt++) {
      // Ended meanwhile (the invoice watch saw LND release the payment):
      // nothing is left to claim.
      if (order.orderState !== "CREATED") return;
      try {
        await this.lndSettle(order.invoiceSecret);
        settled = true;
      } catch (err) {
        detail = lndErrorDetail(err);
        this.lastError = detail;
        await sleep(this.settleRetryBaseMs * (attempt + 1));
      }
    }
    if (!settled) {
      if (order.orderState !== "CREATED") return;
      this.settleRefused.add(order.orderId);
      order.error = "the channel is open, but LND hasn't claimed the buyer's payment yet — tried again automatically";
      this.recoveryError = `order ${order.orderId.slice(0, 8)}…: settle refused — ${detail}`;
      this.persistOrders();
      console.error(`[lsps1] CRITICAL order ${order.orderId}: the channel is open, but LND refused to settle the payment (${detail}) — trying again`);
      this.scheduleRecovery(true);
      return;
    }

    this.settleRefused.delete(order.orderId);
    order.paymentState = "PAID";
    order.orderState = "COMPLETED";
    order.error = undefined;
    // Book the sale BEFORE saving COMPLETED: if we crash in between, recovery
    // sees a settled invoice on a not-yet-completed order and books it then —
    // recordSale is idempotent, so it can never count twice.
    this.recordSale(order);
    this.persistOrders();
    this.onSale?.(order.orderId, order.lspBalanceSat, order.channel?.fundingOutpoint.split(":")[0] ?? "");
    console.log(
      `[lsps1] order ${order.orderId} COMPLETED: ${order.lspBalanceSat} sat channel, ${order.feeTotalSat} sat fee collected`,
    );
  }

  /** P&L income + the disclosed service fee for a settled order. The fee is
   *  only ENQUEUED — the ledger pays it in the background, so it can never
   *  delay or fail the settle. Income is feeTotalSat, our fee for the lease —
   *  not the hold invoice's amount (orderTotalSat), which would also carry a
   *  client balance: that part is the buyer's own, handed back to them in the
   *  channel. (Today a client balance is refused at order time, so the two are
   *  equal.) Both steps are idempotent per order. */
  private recordSale(order: Lsps1Order): void {
    this.earnings.appendOnce({
      at: new Date().toISOString(),
      via: "lsps1",
      orderId: order.orderId,
      leaseSats: order.feeTotalSat,
      ...(order.channelExpiryBlocks > 0 ? { leaseBlocks: order.channelExpiryBlocks } : {}),
    });
    this.serviceFees.enqueue({ source: "lsps1", orderId: order.orderId, earnedSats: order.feeTotalSat });
  }

  /**
   * The order's channel is open, but its payment can no longer be claimed:
   * LND released it (its HTLC near expiry, while the settle kept failing),
   * or no longer has the invoice. The buyer has the channel without paying
   * for it. Said loudly — a CRITICAL log line and an alert that stays until
   * the operator acknowledges it — never filed as a plain "payment refunded".
   */
  private channelUnpaid(order: Lsps1Order, why: string): void {
    order.orderState = "FAILED";
    if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
    order.error = `the channel was opened, but ${why} — the buyer has the channel without paying for it`;
    this.settleRefused.delete(order.orderId);
    this.persistOrders();
    const detail =
      `LSP order ${order.orderId}: a ${order.lspBalanceSat} sat channel (${order.channel?.fundingOutpoint ?? "outpoint unknown"}) was opened ` +
      `for the buyer, but ${why} — the buyer has the channel without paying the ${order.feeTotalSat} sat lease fee.`;
    console.error(`[lsps1] CRITICAL ${detail}`);
    recordStoreIncident(this.dataDir, { file: "lsps1-orders.json", kind: "unpaid_channel", detail });
  }

  /**
   * Any failure with a held payment ends in a refund — cancel the HODL
   * invoice. If LND refuses the cancel (unreachable, say), the order still
   * ends here, marked `cancelPending`: recovery cancels it again until LND
   * confirms (before, it was left to the HTLC's expiry, hours away, with
   * the order reading "failed" while the buyer's money stayed locked).
   */
  private async failAndRefund(order: Lsps1Order, reason: string): Promise<void> {
    if (order.orderState !== "CREATED") return;
    let cancelled = false;
    try {
      if (this.writeLnd) await this.lndCancel(order.invoiceId);
      cancelled = true;
      if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
    } catch (err) {
      this.recoveryError = `order ${order.orderId.slice(0, 8)}…: refund refused — ${lndErrorDetail(err)}`;
      console.error(`[lsps1] order ${order.orderId}: cancel failed (${lndErrorDetail(err)}) — tried again until LND confirms it`);
    }
    order.orderState = "FAILED";
    order.error = reason;
    if (!cancelled) order.cancelPending = true;
    this.persistOrders();
    console.warn(`[lsps1] order ${order.orderId} FAILED: ${reason}`);
    if (!cancelled) this.scheduleRecovery(true);
  }

  /**
   * Recovery — at start-up, and then for as long as anything waits on LND.
   *
   * Every order still CREATED that nobody follows (no invoice watch, no open
   * under way) is picked up: a held payment resumed (the channel opened and
   * the payment settled), an unpaid one watched again, a dead one ended. An
   * opened channel whose payment LND refused to settle is settled — the
   * invoice watch never does that. A failed order whose payment LND didn't
   * release (the cancel failed) is released. While LND can't answer — Umbrel
   * starts apps while LND is still unlocking — or keeps refusing a settle or
   * a cancel, the pass runs again 30 s later, doubling to 5 min, until every
   * order is followed or final; and again whenever the peer-message stream
   * (re)connects. Before, one pass ran at start-up and logged "[object
   * Object]": an order whose lookup failed then was never looked at again —
   * a buyer's held payment neither opened nor refunded, and its size kept
   * out of the on-chain budget until the next restart.
   *
   * Resolves once the pass is done, the opens it started included.
   */
  private async recoverOrders(): Promise<void> {
    if (!this.writeLnd || this.stopping) return;
    if (this.recovering) {
      this.recoverAgain = true; // asked again meanwhile: one more pass after this one
      return;
    }
    this.recovering = true;
    const opens: Promise<void>[] = [];
    let unanswered = new Set<string>();
    try {
      do {
        this.recoverAgain = false;
        unanswered = new Set<string>();
        for (const order of this.orders.filter((o) => this.needsRecovery(o))) {
          if (this.stopping) return;
          try {
            const step = await this.recoverOne(order);
            if (step === "unwatched") unanswered.add(order.orderId);
            // fulfill() ends every failure itself; should one still escape,
            // it is logged here — a rejection nobody handles ends the process.
            else if (step) opens.push(step.open.catch((err) => console.error(`[lsps1] order ${order.orderId}: resuming it failed (${lndErrorDetail(err)})`)));
          } catch (err) {
            unanswered.add(order.orderId);
            this.recoveryError = `order ${order.orderId.slice(0, 8)}…: ${lndErrorDetail(err)}`;
            console.warn(`[lsps1] recovery: LND could not answer for order ${order.orderId} (${lndErrorDetail(err)}) — trying again`);
          }
        }
      } while (this.recoverAgain && !this.stopping);
    } finally {
      this.recovering = false;
    }
    this.lookupRefused = unanswered;
    // Anything still waiting on LND — an order it didn't answer for, a
    // refund or a settle it refused (one being tried right now included) —
    // brings the next pass, at a pace that grows while LND keeps refusing.
    const c = this.recoveryCounts();
    const waiting = c.lookups + c.refunds + c.settles;
    if (waiting === 0) this.recoveryError = null;
    this.scheduleRecovery(waiting > 0);
    await Promise.all(opens);
  }

  /** An order recovery must see to: failed with its payment not released;
   *  opened with its payment not claimed, whatever its invoice watch (that
   *  only ever starts an open — it never settles); or CREATED and followed
   *  by nothing here. One being opened or settled right now is left alone. */
  private needsRecovery(o: Lsps1Order): boolean {
    if (o.orderState === "FAILED") return refundPending(o);
    if (o.orderState !== "CREATED" || this.fulfilling.has(o.orderId)) return false;
    return unclaimed(o) || !this.invoiceSubs.has(o.invoiceId);
  }

  /** What recovery waits on LND for, as the orders stand now: refunds it
   *  refused, opened channels whose payment it refused (or didn't answer)
   *  to settle, and orders the last pass got no answer for. */
  private recoveryCounts(): { lookups: number; refunds: number; settles: number } {
    let lookups = 0;
    let refunds = 0;
    let settles = 0;
    for (const o of this.orders) {
      if (refundPending(o)) refunds += 1;
      else if (unclaimed(o) && (this.settleRefused.has(o.orderId) || this.lookupRefused.has(o.orderId))) settles += 1;
      else if (this.lookupRefused.has(o.orderId) && this.needsRecovery(o)) lookups += 1;
    }
    return { lookups, refunds, settles };
  }

  /** The next recovery pass: in `recoveryRetryMs` (doubling, to the max)
   *  while something waits for LND; nothing — and the pace reset — when
   *  nothing does. */
  private scheduleRecovery(retry: boolean): void {
    if (!retry) {
      this.recoveryRetryMs = this.recoveryRetryMinMs;
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
      this.recoveryNextAt = null;
      return;
    }
    if (this.recoveryTimer || this.stopping) return;
    const delay = this.recoveryRetryMs;
    this.recoveryRetryMs = Math.min(this.recoveryRetryMs * 2, RECOVERY_RETRY_MAX_MS);
    this.recoveryNextAt = Date.now() + delay;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      this.recoveryNextAt = null;
      void this.recoverOrders();
    }, delay);
    this.recoveryTimer.unref?.();
  }

  /**
   * One order, as LND has it now. Throws while LND can't answer (the caller
   * tries again later). Returns the open it started (a held payment) —
   * wrapped, so the pass doesn't wait for it — or "unwatched" when an
   * unpaid order could not be watched (tried again too).
   */
  private async recoverOne(order: Lsps1Order): Promise<{ open: Promise<void> } | "unwatched" | null> {
    if (order.orderState === "FAILED") {
      await this.releaseHeld(order);
      return null;
    }
    let inv: Awaited<ReturnType<Lsps1Service["lndInvoice"]>>;
    try {
      inv = await this.lndInvoice(order.invoiceId);
    } catch (err) {
      if (!isMissingInvoice(err)) throw err;
      // LND answered: there is no such invoice (never made, or a cancelled
      // one LND has since deleted) — nothing is held, nothing can be paid.
      if (order.channel) {
        this.channelUnpaid(order, "LND no longer has the order's invoice, so the payment can't be claimed");
        return null;
      }
      order.orderState = "FAILED";
      if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
      order.error = "LND no longer has the order's invoice — nothing was paid";
      this.persistOrders();
      return null;
    }
    if (inv.is_confirmed) {
      // We settled before the crash: the channel open succeeded first
      // (settle strictly follows broadcast), only the bookkeeping is lost —
      // so book the sale now (idempotent), or it vanishes from P&L and its
      // service fee is never paid.
      if (order.paymentState !== "PAID" || order.orderState !== "COMPLETED") {
        this.settleRefused.delete(order.orderId);
        order.paymentState = "PAID";
        order.orderState = "COMPLETED";
        order.error = order.channel ? undefined : "completed across restart — funding outpoint not recorded";
        this.recordSale(order);
        this.persistOrders();
        this.onSale?.(order.orderId, order.lspBalanceSat, order.channel?.fundingOutpoint.split(":")[0] ?? "");
      }
      return null;
    }
    if (inv.is_held) {
      order.paymentState = "HOLD";
      this.noteHeld(order, heldUntilHeightOf(inv as { payments?: { is_held?: boolean; timeout?: number }[] }));
      this.persistOrders();
      this.watchInvoice(order);
      // Not one after the other: an open waiting for an offline buyer may
      // wait for hours. (The opens themselves still go one at a time: the
      // on-chain mutex.) Wrapped: an async function returning the promise
      // itself would hand back its outcome — and the pass would wait for
      // each open in turn, every other order behind it, while no next
      // pass could be scheduled.
      return { open: this.fulfill(order) };
    }
    if (order.channel) {
      // Its channel is open, and LND holds no payment for it any more: it
      // was released (its HTLC near expiry) while the settle kept failing.
      // An invoice still open is cancelled, so nothing more can land on it.
      if (!inv.is_canceled) await this.lndCancel(order.invoiceId).catch(() => undefined);
      this.channelUnpaid(order, "LND released the buyer's held payment before it could be claimed");
      return null;
    }
    if (inv.is_canceled || new Date(order.invoiceExpiresAt).getTime() < Date.now()) {
      if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
      order.orderState = "FAILED";
      order.error ??= "expired across restart";
      this.persistOrders();
      return null;
    }
    // Still awaiting payment.
    return this.watchInvoice(order) === false ? "unwatched" : null;
  }

  /**
   * A failed order whose payment LND didn't release when it ended: release
   * it now. Throws while LND can't answer (tried again later).
   */
  private async releaseHeld(order: Lsps1Order): Promise<void> {
    let inv: Awaited<ReturnType<Lsps1Service["lndInvoice"]>> | null;
    try {
      inv = await this.lndInvoice(order.invoiceId);
    } catch (err) {
      if (!isMissingInvoice(err)) throw err;
      inv = null; // no such invoice: nothing held
    }
    if (inv?.is_confirmed) {
      // Settled although the order failed (it should not happen): nothing to
      // release — said, not hidden.
      order.paymentState = "PAID";
      console.error(`[lsps1] CRITICAL order ${order.orderId}: it failed, yet LND shows its payment settled`);
    } else {
      if (inv && !inv.is_canceled) await this.lndCancel(order.invoiceId);
      if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
      console.log(`[lsps1] order ${order.orderId}: the held payment is released — the buyer gets it back`);
    }
    order.cancelPending = undefined;
    this.persistOrders();
  }
}
