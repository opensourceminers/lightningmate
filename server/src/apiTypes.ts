/**
 * The HTTP API's payload types — ONE source of truth for the server and the
 * web (review a8-engineering:web-server-type-drift).
 *
 * Before, web/src/types.ts was a hand-kept copy of the server's shapes, and it
 * drifted: fields the server added never reached the UI (a fee
 * recommendation's base fee — the manual Apply sent the current one, so a
 * base-fee-only change never cleared), unions differed, and nothing noticed.
 *
 * Now:
 *  - a payload the server builds from a type of its own is that type,
 *    re-exported here — under the name the web uses for it;
 *  - a body a route composes (a type plus a field or two, a few figures put
 *    together, a small `{ ok, … }` answer) is declared here, and the route
 *    checks the object it sends against it (`satisfies`): a route that
 *    drifts doesn't compile;
 *  - the web imports this module, type-only (web/src/types.ts re-exports it;
 *    nothing of the server reaches the browser bundle), so a change of shape
 *    here — or in any type it re-exports — fails the web's type-check where
 *    the web uses it;
 *  - the web client names, per path, the type it reads the answer as; the
 *    contract check pairs the two — every body the route can send must be
 *    assignable to that type — so a route answering with another type, or a
 *    client reading the wrong one, fails too;
 *  - what the web SENDS is declared here as well (the request bodies and
 *    query strings): the web's API client takes them as its parameter types
 *    and names one per request, and the route reads its body through
 *    `bodyOf<that type>(req)` and its query through `queryOf<that type>(req)`
 *    (routes/api.ts), whose keys are the type's — a field renamed on either
 *    side fails to compile on the other, and the check pairs each request
 *    with the type its route reads.
 * `npm run check:api-types` (CI) checks those rules hold.
 *
 * Type declarations only: this module has no runtime code (the check
 * enforces that too).
 */
import type { SuggestionV2, SuggestV2Report } from "./services/suggestRecommend.js";
import type { AmbossKeyStatus } from "./services/ambossStore.js";
import type { AutomationSwitch, Autopilot, AutopilotChange, AutopilotRun, OfferControl, OfferSyncStatus } from "./services/autopilot.js";
import type { AUTOPILOT_CONFIG_BOUNDS } from "./services/autopilotConfig.js";
import type { OpenChannelResult as ChannelOpsOpenResult } from "./services/channelOps.js";
import type { FeeEstimates, OnchainState as WalletState, SendBudget, SendResult } from "./services/onchain.js";
import type { ChannelView as LndChannel } from "./services/channels.js";
import type { ChannelLease } from "./services/leases.js";
import type { OfflineInfo } from "./services/channelUptime.js";
import type { BuyQuote, OrderState as AmbossOrderState } from "./services/amboss.js";
import type { PayResult as LndPayResult } from "./services/payments.js";
import type { FiatCurrency } from "./services/settings.js";
import type { TorRoute } from "./services/http.js";
import type { Lsps1OrderView, Lsps1Status } from "./services/lsps1.js";
import type { LaneStatus, MagmaOrderLocal } from "./services/magmaDesk.js";
import type { MyOffer, MyOrder as AmbossSale } from "./services/magmaApi.js";
import type { BuyOffer } from "./services/magmaBuy.js";
import type { MagmaPurchase } from "./services/magmaPurchases.js";
import type { FeeApplyItem, FeeApplyResult, FeePolicy } from "./services/fees.js";
import type { FeeMode } from "./services/overrides.js";
import type { AppSettings } from "./services/settings.js";
import type { SendCheckCode } from "./services/onchain.js";
import type { BoughtInboundRoi } from "./services/inboundRoi.js";
import type { LnPlusNode, LnPlusPoolNode as LnPlusPoolEntry, LnPlusSwap as LnPlusSwapEntry } from "./services/lnplus.js";
import type { RebalanceCosts } from "./services/rebalanceCosts.js";
import type { RebalanceExecParams } from "./services/rebalance.js";
import type { RebalanceLog, RebalanceRecord } from "./services/rebalanceLog.js";
import type { UnservedDemand } from "./services/htlcTelemetry.js";
import type { SuggestionPolicy } from "./services/suggestions.js";
import type { YieldEvidence } from "./services/openPlan.js";

// ── the server's own types, as the API sends them ───────────────────────────

export type { Alert } from "./services/alerts.js";
export type { BuyQuote, MagmaOffer, MarketView, OfferCondition } from "./services/amboss.js";
export type {
  AreaDecision,
  AreaStatus,
  AutomationSwitch,
  AutopilotChange,
  AutopilotChannelOpen,
  AutopilotRebalance,
  AutopilotRun,
  AutopilotSell,
  DecisionArea,
  DecisionState,
  OfferControl,
  OfferFields,
  OfferSyncEntry,
  OfferSyncStatus,
  OfferWrite,
  RebalanceBudget,
  RefillInFlight,
  RunSummary,
} from "./services/autopilot.js";
export type { AutopilotConfig, AutopilotConfigPatch, NumberBounds } from "./services/autopilotConfig.js";
export type { CloseChannelResult } from "./services/channelOps.js";
export type { OfflineInfo } from "./services/channelUptime.js";
export type { ChannelRole } from "./services/channels.js";
export type { ActivityItem, ActivityKind, DashboardData, LeaseBenchmark } from "./services/dashboard.js";
export type { FeeRecMetrics, FeeRecReport, FeeRecState, FeeRecommendation, NodeBenchmarks } from "./services/feeRecommend.js";
export type { FeeApplyItem, FeeApplyResult, FeePolicy, FeePreview, FeeProposal } from "./services/fees.js";
export type {
  ChannelFlow,
  ChannelFlowDirection,
  ChannelForwardStat,
  DailyBucket,
  FlowSummary,
  ForwardEvent,
  ForwardsReport,
  ResolvedForward,
  RollingTotals,
  RoutingCorridor,
} from "./services/forwards.js";
export type { TorRoute } from "./services/http.js";
export type { BoughtInboundRoi } from "./services/inboundRoi.js";
export type { ChannelLease } from "./services/leases.js";
export type { LnPlusNode, LnPlusSwapParticipant } from "./services/lnplus.js";
export type { MyOffer } from "./services/magmaApi.js";
export type { BuyOffer, ConditionCheck } from "./services/magmaBuy.js";
export type { DeskResult, MagmaOrderLocal } from "./services/magmaDesk.js";
export type { Eligibility, EligibilityVerdict } from "./services/magmaEligibility.js";
export type { ClearingStats } from "./services/magmaHistory.js";
export type { MagmaPhase } from "./services/magmaJournal.js";
export type { MagmaPurchase, PurchaseState } from "./services/magmaPurchases.js";
export type {
  MagmaBuyRecommendation,
  MagmaSellAnalytics,
  MagmaSellOfferState,
  MagmaSellRecommendation,
  MagmaV2Report,
  PricePoint,
} from "./services/magmaRecommend.js";
export type { MaxHtlcChange } from "./services/maxHtlc.js";
export type { NodeSummary } from "./services/node.js";
export type { FeeEstimates, NewAddress, OnchainTx, SendBudget, SendCheck, SendCheckCode, SendPreview } from "./services/onchain.js";
export type { YieldEvidence } from "./services/openPlan.js";
export type { FeeOutcome, OutcomesReport, RebalanceOutcome } from "./services/outcomes.js";
export type { ChannelOverride, FeeMode, OverrideMap } from "./services/overrides.js";
export type { CreatedInvoice, DecodedRequest, LnActivity } from "./services/payments.js";
export type { PnlSummary } from "./services/pnl.js";
export type { RebalancePolicy, RebalanceExecResult } from "./services/rebalance.js";
export type { RebalanceRecord } from "./services/rebalanceLog.js";
export type {
  RebalanceRecConfig,
  RebalanceRecState,
  RebalanceRecSummary,
  RebalanceRecommendation,
  RefillNote,
} from "./services/rebalanceRecommend.js";
export type { NodeScore, ScoreCategory } from "./services/score.js";
export type { CheckStatus, DiagnosticCheck, OfferTermsView, SellDiagnostics } from "./services/sellDiagnostics.js";
export type { AppSettings, FiatCurrency } from "./services/settings.js";
export type { NodeNeed, PendingChannel, ProtectedChannel } from "./services/suggestRecommend.js";
export type { NetworkRank, SuggestionPolicy } from "./services/suggestions.js";

// ── named differently on the server ─────────────────────────────────────────

/** The Magma order lane's status (magmaDesk.ts LaneStatus). */
export type { LaneStatus as MagmaLaneStatus } from "./services/magmaDesk.js";
/** A cell of the selling check: offers like this node's (CellStats). */
export type { CellStats as EligibilityCell } from "./services/magmaEligibility.js";
/** What the key check said (ambossStore.ts KeyCheck). */
export type { KeyCheck as AmbossKeyCheck } from "./services/ambossStore.js";
/** GET /backup/status (backup.ts BackupStatusResult). */
export type { BackupStatusResult as BackupStatus } from "./services/backup.js";
/** A source a refill may draw from (rebalanceRecommend.ts SourceCandidate). */
export type { SourceCandidate as RebalanceSourceCandidate } from "./services/rebalanceRecommend.js";
/** A channel worth closing, and the close list (suggestRecommend.ts). */
export type { CloseSuggestion as CloseCandidate, CloseV2Report as CloseCandidatesResponse } from "./services/suggestRecommend.js";
/** One LSPS1 order as Market → Orders shows it (lsps1.ts Lsps1OrderView). */
export type { Lsps1OrderView as LspOrder } from "./services/lsps1.js";

/** A peer's LN+ reputation, as a suggestion carries it. */
export type LnPlusRating = NonNullable<SuggestionV2["lnplus"]>;
/** One coin of the on-chain wallet (GET /onchain). */
export type OnchainUtxo = WalletState["utxos"][number];
/** The allowed range of every numeric setting (GET /autopilot `bounds`). */
export type AutopilotBounds = typeof AUTOPILOT_CONFIG_BOUNDS;

// ── bodies the routes compose ───────────────────────────────────────────────
// Each is checked where it is sent (routes/api.ts: `satisfies`).

/** A channel as GET /channels lists it: LND's, with what it charges now,
 *  its lease (sold on Magma or LSPS1, or bought on Magma) and how long its
 *  peer has been away. */
export type ChannelView = LndChannel & {
  /** Its outbound fee now (null: not known, e.g. still pending). */
  feeRatePpm: number | null;
  baseFeeMsat: number | null;
  lease: ChannelLease | null;
  /** How long its peer has been away (null: online). */
  offline: OfflineInfo | null;
};

/** How this node's payment for a purchase stands ("unclear": only the pay
 *  call reported a failure — LND is being asked). */
export interface PurchasePaymentHint {
  state: "paying" | "paid" | "failed" | "unclear";
  error?: string;
  feeSats?: number;
}

/** GET /amboss/order: Amboss's order, and how this node's payment for it stands. */
export type OrderState = AmbossOrderState & { payment: PurchasePaymentHint | null };

/** POST /ln/pay: a payment, or why it failed (a failure is a result, not an error status). */
export type PayResult = LndPayResult & { error?: string };

/** GET /onchain: the wallet, and what it can spare for a send (null: LND couldn't say). */
export type OnchainState = WalletState & { budget: SendBudget | null };

/** POST /onchain/send: sent, or why not (an error LND gave is a result). */
export type OnchainSendResult = SendResult & { error?: string };

/** GET /rebalance/recommendations: the autopilot's own plan, with today's
 *  fee budget and the refills still in flight. */
export type RebalanceRecReport = Awaited<ReturnType<Autopilot["rebalanceRecommendations"]>>;

/** GET /autopilot (and what the autopilot's POSTs answer with). */
export type AutopilotState = ReturnType<Autopilot["getState"]> & {
  /** LSP mode (Settings) answering wallet orders. Not one of the
   *  autopilot's switches: "Pause all automation" leaves it on. */
  lspModeOn: boolean;
};

/** GET /api/health — open (no login needed). */
export interface HealthInfo {
  ok: boolean;
  service: string;
  /** Image version (git tag, e.g. "v0.8.0"), or "dev". */
  version: string;
  /** Running as the Umbrel app, or on its own (LND settings in .env). */
  platform: "umbrel" | "standalone";
}

/** The routing fee a channel is opened with. */
export interface StartingFee {
  feeRatePpm: number;
  baseFeeMsat: number;
}

/** POST /channels/open: the open, and — when it went out — the routing fee
 *  the channel starts with. */
export interface OpenChannelResult extends ChannelOpsOpenResult {
  startingFee?: StartingFee;
}

/** What opening a channel would cost and leave (GET /channels/open-estimate). */
export interface OpenEstimate {
  sizeSats: number;
  fees: FeeEstimates;
  /** What can be spent after the reserve and the coins promised to buyers. */
  spendableSat: number | null;
  reserveSat: number | null;
  promisedSat: number | null;
  /** What a sat in this node's month-old channels earned (ppm/yr); null: not
   *  measured (none a month old, or too little routing — see yieldEvidence). */
  yieldPpmYear: number | null;
  /** What that yield stands on over the last 30 days (null: LND unreadable). */
  yieldEvidence: YieldEvidence | null;
  /** The yield counts with this many forwards, or this much earned (sat). */
  minYieldForwards: number;
  minYieldEarnedSat: number;
  openVbytes: number;
  closeVbytes: number;
  /** The autopilot's payback horizon (months). */
  paybackMonths: number;
  autopilotMaxFeeRate: number;
  /** The routing fee a new channel starts with (the fee engine's new-channel fee). */
  initialRoutingFee: StartingFee;
}

/** A peer suggestion (GET /suggestions): the engine's, and whether it is on
 *  the operator's "never open automatically" list. */
export type ChannelSuggestion = SuggestionV2 & { neverOpen: boolean };

/** GET /suggestions. */
export type SuggestionsResponse = Omit<SuggestV2Report, "suggestions"> & { suggestions: ChannelSuggestion[] };

/** Where LightningMate's own lookups go, and by which route (GET /privacy). */
export interface PrivacyInfo {
  /** Umbrel's Tor proxy (host:port), or null: everything goes direct. */
  torProxy: string | null;
  torRoute: TorRoute;
  lnplusLookups: boolean;
  destinations: { service: string; what: string; active: boolean; viaTor: boolean }[];
}

/** LSP mode (LSPS1) live status (GET /lsp/status): the service's, with this
 *  node's key and addresses. */
export type LspStatus = Lsps1Status & { pubkey: string; uris: string[] };

/** GET /price. */
export interface PriceInfo {
  currency: FiatCurrency;
  btcPrice: number | null;
}

/** One channel of the failed-HTLC telemetry, named, with the fees its
 *  de-noised attempts would have paid at the channel's current fee. */
export interface UnservedDemandChannel extends UnservedDemand {
  alias: string;
  missedFeesSats: number;
}

/** GET /htlc/demand: forwards refused for lack of liquidity, raw and
 *  de-noised (D20: probes, retries and HTLCs no refill could carry apart). */
export interface UnservedDemandReport {
  days: number;
  /** How long events have been collected (days, one decimal). */
  trackedDays: number;
  /** Since when refusals are classified (older ones are raw only). */
  classifiedSince: string | null;
  channels: UnservedDemandChannel[];
}

/** A refill by hand (POST /rebalance/execute): the executor's parameters
 *  (one source), and when the plan the row came from was made. */
export type RebalanceExecRequest = Omit<RebalanceExecParams, "sources"> & {
  /** When the plan the row came from was made (its generatedAt): a target
   *  refilled — or tried — since then is refused (409 stale_plan). */
  planAt?: string;
};

/** The rebalance log's totals over a stated window. */
export type RebalanceLogSummary = ReturnType<RebalanceLog["summary"]>;

/** GET /rebalance/log. */
export interface RebalanceLogResponse {
  summary: RebalanceLogSummary;
  records: RebalanceRecord[];
  /** Since when LightningMate's log covers rebalances (null: none yet). */
  trackedSince: string | null;
}

/** What rebalancing cost over a window, per refilled channel (GET /rebalance/costs). */
export type RebalanceCostsResponse = RebalanceCosts & { windowDays: number };

/** GET /amboss/buy-offers: the offers ranked for this node at a size. */
export interface BuyOffersResponse {
  sizeSats: number;
  offers: BuyOffer[];
  ambossFeeTiers: { ambossFeePpm: number; upToSats: number | null }[];
  inboundSatsPerUsd: number | null;
  satsPerUsd: number | null;
}

/** GET /amboss/my-offers. */
export interface MyOffersResponse {
  offers: MyOffer[];
  sync: OfferSyncStatus;
  /** Who owns each offer's terms. */
  controls: Record<string, OfferControl>;
  /** The routing-fee promise every offer carries (D7). */
  feeCaps: { feeRateCapPpm: number; baseFeeCapSats: number };
}

/** GET /amboss/status (and POST /amboss/key/check): the key's state, the
 *  service fee on sales, and the orders under way. */
export type AmbossStatus = AmbossKeyStatus & {
  saleFeeBps: number;
  /** Magma orders this node has taken on and not finished (accepted, paid,
   *  opening, …): without a key they can't be fulfilled. */
  ordersInFlight: number;
};

/** A sale on Market → Orders: Amboss's order, this node's record of it, and
 *  who opens its channel once it is paid. */
export type MyOrder = AmbossSale & {
  local: MagmaOrderLocal | null;
  /** The order lane opens the channel once it is paid (else the operator). */
  opensItself: boolean;
};

/** GET /amboss/my-orders. */
export interface MyOrdersView {
  orders: MyOrder[];
  /** Orders waiting on you: approval, or the channel open. */
  pendingSeller: number;
  lane: LaneStatus;
}

/** GET /analytics/bought-inbound: each Magma purchase against the fees of
 *  the forwards that came in through its channel during the lease. */
export interface BoughtInboundResponse {
  method: string;
  windowDays: number;
  /** The window's share of what inbound bought cost, spread over each lease. */
  amortizedSats: number;
  /** False when LND holds more forwards than were read (the newest missing);
   *  absent with no purchase to follow. */
  forwardsComplete?: boolean;
  items: BoughtInboundRoi[];
}

/** GET /lnplus/status. */
export interface LnPlusStatus {
  /** The operator's LN+ switch (Settings → Privacy). */
  enabled: boolean;
  /** LN+ lookups go through Umbrel's Tor proxy right now. */
  viaTor: boolean;
  /** The app has Umbrel's Tor proxy (when it does and viaTor is false, the
   *  Tor route is set to Direct). */
  torProxy: boolean;
  pubkey: string;
  onLnPlus: boolean;
  me: LnPlusNode | null;
  cache: {
    cached: number;
    withProfile: number;
    paused: boolean;
    lastError: string | null;
    callsToday: number;
    remainingToday: number;
  };
}

/** A Liquidity Pool participant (GET /lnplus/pool), and whether this node
 *  has a channel with it already. */
export type LnPlusPoolNode = LnPlusPoolEntry & { alreadyPeered: boolean };

/** GET /lnplus/pool. */
export interface LnPlusPoolResponse {
  nodes: LnPlusPoolNode[];
}

/** A Liquidity Swap (GET /lnplus/swaps), with whether this node could join
 *  it — checked against the gates LN+ publishes. */
export type LnPlusSwap = LnPlusSwapEntry & { eligibility: { eligible: boolean; blockers: string[] } };

/** GET /lnplus/swaps: the open swaps, each with whether this node may join. */
export interface LnPlusSwapsResponse {
  me: {
    capacitySats: number;
    channelCount: number;
    hasClearnet: boolean;
    hasTor: boolean;
    prime: boolean;
    pro: boolean;
  };
  swaps: LnPlusSwap[];
}

// ── the small answers of the routes that act ────────────────────────────────
// Each is checked where it is sent, too (review of P8: these envelopes were
// written out again in web/src/api.ts — renaming `sellingWasOn` in the route
// passed every check, and the Resume dialog would have lost it).

/** GET /auth/status — open (no login needed). */
export interface AuthStatus {
  /** The API wants a session token (APP_PASSWORD is set). */
  authRequired: boolean;
  /** This request carried a valid one. */
  unlocked: boolean;
}

/** POST /auth/unlock: the session token for the app password. */
export interface AuthUnlockResult {
  token: string;
}

/** POST /alerts/ack: the alert is dismissed (an unknown one answers 404). */
export interface AlertAckResult {
  ok: true;
}

/** POST /peers/connect: dialled, or why not (a failure is a result here). */
export interface PeerConnectResult {
  ok: boolean;
  error?: string;
}

/** POST /fees/apply: what LND did with each fee set by hand. */
export interface FeeApplyResponse {
  results: FeeApplyResult[];
}

/** POST /fees/apply-recommended: the writes, on the autopilot's books. */
export interface ApplyRecommendedResponse {
  changes: AutopilotChange[];
}

/** POST /autopilot/run: the run, and the autopilot's state after it. */
export interface AutopilotRunResult {
  run: AutopilotRun;
  state: AutopilotState;
}

/** POST /autopilot/resume: the switches back on — never selling (D9):
 *  `sellingWasOn` says it had been on, so the page can say so. */
export interface AutopilotResumeResult {
  resumed: AutomationSwitch[];
  sellingWasOn: boolean;
  state: AutopilotState;
}

/** POST /channels/never-open: the "never open automatically" list after the change. */
export interface NeverOpenResult {
  ok: true;
  neverOpen: ReturnType<Autopilot["neverOpenPeers"]>;
}

/** GET /lsp/orders: LSPS1 orders for Market → Orders (no invoice secrets). */
export interface LspOrdersResponse {
  orders: Lsps1OrderView[];
}

/** POST /sign: a message signed with the node's key. */
export interface SignResult {
  signature: string;
}

/** POST /amboss/key (saved once Amboss accepted it) and DELETE /amboss/key. */
export interface AmbossKeyResult {
  ok: true;
  connected: boolean;
}

/** POST /amboss/buy/quote: the quote — and, for an offer picked from the
 *  ranked list, that its seller is the one the order went to. */
export type BuyQuoteResponse = BuyQuote & { sellerChosen?: boolean };

/** POST /amboss/buy/pay: the payment is under way (it lands in the
 *  background), for this many sat. */
export interface BuyPayResult {
  ok: true;
  sats: number;
}

/** POST /amboss/buy/cancel: whether Amboss confirmed the cancel, in words. */
export interface BuyCancelResult {
  ok: true;
  cancelled: boolean;
  message: string;
}

/** GET /amboss/purchases: inbound bought here, newest first. */
export interface PurchasesResponse {
  purchases: MagmaPurchase[];
}

/** POST /amboss/offer: the offer Amboss created. */
export interface OfferCreateResult {
  ok: true;
  offerId: string;
}

/** POST /amboss/offer/update: written, and read back — `verified` says
 *  whether Amboss stored the terms (null: the read-back failed). */
export interface OfferUpdateResult {
  ok: true;
  verified: boolean | null;
  offer: MyOffer | null;
}

/** POST /amboss/offer/toggle: the offer's status now, and whether this
 *  request changed it. */
export interface OfferToggleResult {
  status: string;
  changed: boolean;
}

/** POST /amboss/offer/automation: the offers' sync and who owns their terms. */
export interface OfferAutomationResult {
  ok: true;
  sync: OfferSyncStatus;
  controls: Record<string, OfferControl>;
}

// ── what the web sends ──────────────────────────────────────────────────────
// The request bodies of the routes that read one (the query strings follow
// below): the web client's parameter types, and what the route
// reads — `bodyOf<…>(req)` in routes/api.ts, whose keys are the type's. A
// field renamed on one side fails to compile on the other (review of P8,
// final round: the routes destructured an untyped `req.body`, and renaming
// `localTokens` in POST /channels/open passed every check — every Open from
// the UI would have been refused; a renamed `breakLease` or `spendPromised`
// would have dropped the operator's confirmation without a word). What
// arrives is still checked at run time: these say what the web sends.

/** POST /auth/unlock. */
export interface AuthUnlockRequest {
  password: string;
}

/** POST /overrides: a channel's fee mode (`fixedPpm` with "fixed"). */
export interface OverrideRequest {
  channelId: string;
  mode: FeeMode;
  fixedPpm?: number;
}

/** POST /alerts/ack. */
export interface AlertAckRequest {
  id: string;
}

/** POST /channels/close, by funding outpoint. `feeRate` (sat/vB): a
 *  cooperative close's only. `breakLease`: sent only once the operator
 *  confirmed breaking a running lease (409 lease_active otherwise). */
export interface ChannelCloseRequest {
  transactionId: string;
  transactionVout: number;
  isForce: boolean;
  feeRate?: number;
  breakLease?: boolean;
}

/** POST /peers/connect. */
export interface PeerConnectRequest {
  pubkey: string;
  socket?: string;
}

/** POST /fees/apply. */
export interface FeeApplyRequest {
  items: FeeApplyItem[];
}

/** POST /fees/apply-recommended: the rows the operator saw (none: all). */
export interface ApplyRecommendedRequest {
  channelIds?: string[];
}

/** POST /channels/never-open. */
export interface NeverOpenRequest {
  pubkey: string;
  never: boolean;
  alias?: string;
}

/** POST /channels/open. `spendPromised`: sent only once the operator
 *  confirmed spending coins promised to buyers (409 capital_promised
 *  otherwise). */
export interface ChannelOpenRequest {
  pubkey: string;
  socket?: string;
  localTokens: number;
  feeRate?: number;
  isPrivate?: boolean;
  spendPromised?: boolean;
}

/** POST /settings: the settings to change. */
export type SettingsPatch = Partial<AppSettings>;

/** POST /ln/decode. */
export interface LnDecodeRequest {
  request: string;
}

/** POST /ln/invoice. */
export interface LnInvoiceRequest {
  tokens: number;
  description: string;
  expirySec?: number;
}

/** POST /ln/pay. `tokens`: for an invoice without an amount. */
export interface LnPayRequest {
  request: string;
  maxFeeSats: number;
  tokens?: number;
}

/** POST /onchain/send: an amount or `sendAll`. `confirmed`: the preview's
 *  checks the operator said yes to a second time; `spendPromised`: coins
 *  promised to buyers, confirmed too. */
export interface OnchainSendRequest {
  address: string;
  feeRate: number;
  tokens?: number;
  sendAll?: boolean;
  spendPromised?: boolean;
  confirmed?: SendCheckCode[];
  /** Never sent: the preview's `max` goes as its amount (refused, 400). */
  max?: never;
  /** Never sent: the preview's `all` is `sendAll` here (refused, 400). */
  all?: never;
}

/** POST /sign. */
export interface SignRequest {
  message: string;
}

/** POST /amboss/key. */
export interface AmbossKeyRequest {
  apiKey: string;
}

/** POST /amboss/buy/quote: a dollar amount (Amboss picks the seller), or an
 *  offer picked from the ranked list, at a size it sells. */
export interface BuyQuoteRequest {
  usdCents: number;
  private: boolean;
  offerId?: string;
  sizeSats?: number;
}

/** POST /amboss/buy/pay: the quote's order, for the amount the operator
 *  confirmed — and the quote's invoice when the page has it (any other is
 *  refused). */
export interface BuyPayRequest {
  orderId: string;
  maxSats: number;
  paymentRequest?: string;
}

/** POST /amboss/buy/cancel. */
export interface BuyCancelRequest {
  orderId: string;
}

/** POST /amboss/offer: an offer's terms — sizes and base fee in sat, the
 *  rate in ppm, the minimum lease in blocks. */
export interface OfferTermsRequest {
  totalSizeSats: number;
  minSizeSats: number;
  maxSizeSats: number;
  feeRatePpm: number;
  baseFeeSats: number;
  minBlockLength: number;
}

/** POST /amboss/offer/update: an offer of this node's, and its new terms. */
export interface OfferUpdateRequest extends OfferTermsRequest {
  id: string;
}

/** POST /amboss/offer/toggle: flip it — or, with `want`, put it in that state. */
export interface OfferToggleRequest {
  id: string;
  want?: "ENABLED" | "DISABLED";
}

/** POST /amboss/offer/automation: hand the offer to the autopilot (true), or
 *  take it over (false). */
export interface OfferAutomationRequest {
  id: string;
  managed: boolean;
}

/** POST /amboss/order/accept, /open and /reject: the order. */
export interface OrderActionRequest {
  id: string;
}

// ── the query strings the web sends ─────────────────────────────────────────
// What a GET carries after the `?`, the same way: the web client builds the
// query from the type (web/src/api.ts get<Answer, Query>) and the route reads
// it through `queryOf<…>(req)`, whose keys are the type's. Before, every
// route read `req.query` by hand and the web wrote its query strings out —
// a parameter renamed on one side passed every check, and the page silently
// got the route's default (review of P8, run 2: GET /suggestions/close was
// offered a `days` it never read). Values arrive as text: the route still
// parses and bounds each one.

/** GET /flows, /pnl, /htlc/demand, /rebalance/costs and
 *  /analytics/bought-inbound: the window, in days (each has a default). */
export interface DaysQuery {
  days?: number;
}

/** GET /dashboard: the viewer's time zone, minutes east of UTC — the daily
 *  series are the viewer's own days. */
export interface TzQuery {
  tz?: number;
}

/** GET /forwards/report: the window in days, in the viewer's time zone. */
export interface ForwardsReportQuery {
  days?: number;
  tz?: number;
}

/** GET /fees/preview: the policy numbers to preview with (the rest: the
 *  node's own). */
export type FeePreviewQuery = Partial<Pick<FeePolicy, "minPpm" | "maxPpm" | "baseFeeMsat" | "step" | "minChangePpm">>;

/** GET /suggestions: the settings to rank peers with (the rest: defaults). */
export type SuggestionsQuery = Partial<SuggestionPolicy>;

/** GET /lnplus/pool: only nodes holding at least this many credits (sats). */
export interface LnPlusPoolQuery {
  minCredits?: number;
}

/** GET /lnplus/swaps: which swaps — pending ones when not said. */
export interface LnPlusSwapsQuery {
  status?: "pending" | "opening" | "completed";
}

/** GET /channels/open-estimate and /amboss/buy-offers: a channel size (sats). */
export interface SizeQuery {
  size: number;
}

/** GET /onchain/send-preview's query: an address, a fee rate (sat/vB), and
 *  one of an amount, `max` (the most that can go) or `all` (every coin). */
export interface SendPreviewQuery {
  address: string;
  feeRate: number;
  tokens?: number;
  max?: boolean;
  all?: boolean;
}

/** GET /amboss/order: the order. */
export interface OrderQuery {
  id: string;
}

/** GET /amboss/eligibility: read the live book again, not the day's copy. */
export interface EligibilityQuery {
  refresh?: boolean;
}
