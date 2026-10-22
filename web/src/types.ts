// Mirrors the server's response shapes (server/src/services/*).

export interface NodeSummary {
  alias: string;
  pubkey: string;
  color: string;
  version: string;
  syncedToChain: boolean;
  syncedToGraph: boolean;
  blockHeight: number;
  peersCount: number;
  activeChannelsCount: number;
  pendingChannelsCount: number;
  balances: {
    localSats: number;
    inboundSats: number;
    onchainConfirmedSats: number;
    onchainPendingSats: number;
  };
}

export type ChannelRole = "source" | "sink" | "router";

export interface ChannelView {
  id: string;
  peerPubkey: string;
  peerAlias: string;
  active: boolean;
  private: boolean;
  initiator: "local" | "remote";
  capacity: number;
  transactionId: string;
  transactionVout: number;
  localBalance: number;
  remoteBalance: number;
  localRatio: number;
  totalSent: number;
  totalReceived: number;
  unsettled: number;
  status: "open" | "pending_close" | "pending_open";
  /** Force-close in progress: blocks until time-locked funds are spendable. */
  timelockBlocks?: number;
  /** A channel still closing: its closing (or commitment) transaction. */
  closeTransactionId?: string;
  role: ChannelRole;
  /** What it charges now (GET /channels; null: not known, e.g. pending). */
  feeRatePpm?: number | null;
  baseFeeMsat?: number | null;
  /** Open channels: a force-close's time-lock (LND's local CSV delay,
   *  blocks) and the commitment fee LND last signed (sat). */
  csvDelayBlocks?: number;
  commitFeeSats?: number;
  /** LND's per-channel monitoring since it started (ms). */
  timeOfflineMs?: number;
  timeOnlineMs?: number;
  /** Sold on Magma or over LSPS1, or bought on Magma (GET /channels). */
  lease?: ChannelLease | null;
  /** How long its peer has been away (GET /channels; null: online). */
  offline?: OfflineInfo | null;
}

/** A channel's lease (server leases.ts): sold or bought, running or over. */
export interface ChannelLease {
  kind: "magma_sale" | "lsps1_sale" | "magma_purchase";
  orderId: string;
  leaseBlocks: number;
  /** The last block (exclusive) it binds; null while the funding is unconfirmed. */
  untilHeight: number | null;
  blocksLeft: number | null;
  untilApprox: string | null;
  running: boolean;
  /** A purchase: what it cost (sat) and when it was paid. */
  costSats?: number;
  paidAt?: string | null;
  /** A purchase still being paid: the payment is held until Amboss confirms
   *  the seller's channel — a close now cancels the purchase. */
  paying?: boolean;
  /** A sale whose lease runs because Amboss reports it running — one only
   *  Amboss knows of (no journal record), or one the journal counts as over
   *  (Amboss confirmed the channel late): its end is Amboss's to say. */
  reportedByAmboss?: boolean;
  /** …as of Amboss's listing at this time (null: unknown). */
  reportedAt?: string | null;
}

/** How long a channel's peer has been away (server channelUptime.ts). */
export interface OfflineInfo {
  since: string | null;
  hours: number | null;
  /** LND's share of time online over ≥ 14 days of monitoring (else null). */
  uptimeShare: number | null;
  /** Counts toward a close: offline ≥ 72 h, or online < 50 % of the time. */
  long: boolean;
}

export interface FeeEstimates {
  fast: number | null;
  /** The confirmation target `fast` is LND's rate for: 1 — or 2 on an LND
   *  that won't estimate for one block (before 0.20). */
  fastTarget: 1 | 2 | null;
  normal: number | null;
  economy: number | null;
}

export interface ChannelFlow {
  channelId: string;
  routedOut: number;
  routedIn: number;
  feesEarned: number;
  forwardCount: number;
  /** Fees of the forwards that came in through this channel (earned on
   *  their outgoing channel). */
  inboundFeesEarned: number;
  inboundForwardCount: number;
}

export interface ForwardEvent {
  createdAt: string;
  incomingChannel: string;
  outgoingChannel: string;
  tokens: number;
  fee: number;
}

export interface FlowSummary {
  windowDays: number;
  totalForwards: number;
  totalRoutedSats: number;
  totalFeesEarnedSats: number;
  perChannel: ChannelFlow[];
  recent: ForwardEvent[];
  /** False when LND had more forwards than were read: the most recent are missing. */
  complete: boolean;
}

export type ChannelFlowDirection = "draining" | "filling" | "balanced";

export interface ChannelForwardStat {
  channelId: string;
  alias: string;
  forwardCount: number;
  routedOutSats: number;
  routedInSats: number;
  feesEarnedSats: number;
  /** Forwards that came in through this channel, and the fees they earned
   *  (on their outgoing channel): what it brought in. */
  inboundForwardCount: number;
  inboundFeesSats: number;
  localRatio: number;
  capacity: number;
  /** "closed": no longer one of the node's channels. */
  status: "open" | "pending" | "closed";
  flow: ChannelFlowDirection;
  spark: number[];
}

export interface RoutingCorridor {
  inChannel: string;
  outChannel: string;
  inAlias: string;
  outAlias: string;
  forwards: number;
  routedSats: number;
  feesSats: number;
}

export interface DailyBucket {
  date: string;
  forwards: number;
  routedSats: number;
  feesSats: number;
}

export interface ResolvedForward {
  createdAt: string;
  incoming: string;
  outgoing: string;
  tokens: number;
  fee: number;
}

export interface RollingTotals {
  forwards: number;
  routedSats: number;
  feesSats: number;
}

export interface ForwardsReport {
  windowDays: number;
  totalForwards: number;
  totalRoutedSats: number;
  totalFeesEarnedSats: number;
  avgFeePpm: number;
  maxForwardSats: number;
  busiestDay: string | null;
  perChannel: ChannelForwardStat[];
  corridors: RoutingCorridor[];
  /** One bucket per local day the window touches (first and last partial). */
  daily: DailyBucket[];
  recent: ResolvedForward[];
  /** The last 24 h and 7 days, rolling — ending now. */
  rolling: { last24h: RollingTotals; last7d: RollingTotals };
  /** The most recent half of the window against the half before it. */
  trend: { halfDays: number; recentFeesSats: number; priorFeesSats: number; growthPct: number | null };
  tzOffsetMin: number;
  /** False when LND had more forwards than were read: the most recent are missing. */
  complete: boolean;
}

export interface FeePolicy {
  minPpm: number;
  maxPpm: number;
  neutralPpm: number;
  baseFeeMsat: number;
  protectPpm: number;
  safetyMargin: number;
  noFlowRatchetSteps: number;
  exploreLowerModifier: number;
  step: number;
  minChangePpm: number;
}

export interface FeeProposal {
  id: string;
  peerAlias: string;
  active: boolean;
  transactionId: string | null;
  transactionVout: number | null;
  localRatio: number;
  currentPpm: number;
  proposedPpm: number;
  deltaPpm: number;
  currentBaseMsat: number;
  proposedBaseMsat: number;
  willChange: boolean;
  reason: string;
}

export interface FeePreview {
  policy: FeePolicy;
  proposals: FeeProposal[];
  changeCount: number;
}

export interface FeeApplyItem {
  id: string;
  transactionId: string;
  transactionVout: number;
  feeRatePpm: number;
  baseFeeMsat: number;
}

export interface FeeApplyResult {
  id: string;
  ok: boolean;
  /** The fee rate applied (after a sold channel's lease promise, if one bound it). */
  feeRatePpm: number;
  baseFeeMsat?: number;
  /** Set when a sold channel's lease promise lowered what was asked for. */
  clampedBy?: string;
  error?: string;
}

export interface AutopilotConfig {
  enabled: boolean;
  intervalMinutes: number;
  cooldownMinutes: number;
  maxChangesPerRun: number;
  policy: FeePolicy;
  rebalanceEnabled: boolean;
  rebalancePolicy: RebalancePolicy;
  maxRebalancesPerRun: number;
  rebalanceCooldownMinutes: number;
  rebalanceHourStart: number;
  rebalanceHourEnd: number;
  /** Rebalance fees per UTC day, the autopilot's and manual runs together.
   *  null = explicitly no daily cap. */
  rebalanceDailyBudgetSats: number | null;
  channelEnabled: boolean;
  channelReserveSats: number;
  channelSizeSats: number;
  channelCooldownMinutes: number;
  /** The most an automatic open pays on-chain (sat/vByte, economy rate). */
  channelMaxFeeRate: number;
  sellEnabled: boolean;
  sellMaxDeploySats: number;
  sellReserveSats: number;
  sellMaxChannelSats: number;
  sellAutoClose: boolean;
  sellAutoRelist: boolean;
  sellAutoReprice: boolean;
  sellAutoSize: boolean;
  sellPricingMode: "fast" | "balanced" | "premium" | "auto";
  maxHtlcEnabled: boolean;
  /** Let a profit floor lift a fee above policy.maxPpm (off: capped). */
  feeFloorAboveMax: boolean;
}

/** Failed-HTLC telemetry: forwards refused for lack of liquidity, raw and
 *  de-noised (D20: probes, retries and HTLCs no refill could carry apart). */
export interface UnservedDemandReport {
  days: number;
  /** How long events have been collected (days, one decimal). */
  trackedDays: number;
  /** Since when refusals are classified (older ones are raw only). */
  classifiedSince?: string | null;
  channels: UnservedDemandChannel[];
}

export interface UnservedDemandChannel {
  outChannel: string;
  alias: string;
  /** Raw: every refusal for lack of liquidity (probes and retries included). */
  liquidityCount: number;
  liquiditySats: number;
  otherCount: number;
  probeCount: number;
  probeSats: number;
  retryCount: number;
  retrySats: number;
  oversizedCount: number;
  oversizedSats: number;
  unclassifiedCount: number;
  unclassifiedSats: number;
  /** De-noised: distinct attempts a refilled channel could have carried. */
  demandCount: number;
  demandSats: number;
  demandDays: number;
  demandMedianSats: number | null;
  /** Those attempts × the channel's current fee. */
  missedFeesSats: number;
}

export interface MaxHtlcChange {
  id: string;
  alias: string;
  fromSat: number | null;
  toSat: number;
  ok: boolean;
  error?: string;
}

export interface AutopilotChange {
  id: string;
  alias: string;
  fromPpm: number;
  toPpm: number;
  /** Base fee before and after (msat), when the write set it. */
  fromBaseMsat?: number;
  toBaseMsat?: number;
  /** Why: the engine's main reason, the lease promise kept, or "set by hand". */
  why?: string;
  via?: "autopilot" | "lease" | "manual";
  /** A sold channel's lease promise lowered what was asked for. */
  clampedBy?: string;
  ok: boolean;
  error?: string;
}

export interface AutopilotRebalance {
  alias: string;
  amountSats: number;
  feeSats: number | null;
  costPpm: number | null;
  ok: boolean;
  error?: string;
  /** Sent, and LND hasn't said how it ended yet: no failure (yet). */
  inFlight?: boolean;
}

export interface AutopilotChannelOpen {
  alias: string;
  sizeSats: number;
  ok: boolean;
  transactionId?: string;
  error?: string;
}

export interface AutopilotSell {
  orderId: string;
  action:
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
    | "terms"
    | "enable"
    | "disable"
    | "create"
    | "error";
  sizeSats: number;
  ok: boolean;
  transactionId?: string;
  error?: string;
}

export interface AutopilotRun {
  at: string;
  attempted: number;
  applied: number;
  failed: number;
  changes: AutopilotChange[];
  rebalances: AutopilotRebalance[];
  channels: AutopilotChannelOpen[];
  sells: AutopilotSell[];
  maxHtlc?: MaxHtlcChange[];
  /** Stages that threw (each stage is isolated; the others still ran). A
   *  run as "Run once now" answers it lists every one; a line of the run
   *  history only those that are news (not the same failure again). */
  errors?: { stage: string; error: string }[];
}

/** The Magma order lane (every 45 s, independent of the main run). */
export interface MagmaLaneStatus {
  lastTickAt: string | null;
  /** null: the last pass had nothing to do (see `idle`). */
  ok: boolean | null;
  error: string | null;
  /** Whether the lane's next pass may clear `error` by itself. False when it
   *  can't: Amboss rejects LightningMate's request as such (only an update
   *  fixes that), or there is no key to ask with. */
  retrying?: boolean;
  /** Why the last pass had nothing to do, when it hadn't. */
  idle?: string | null;
  running: boolean;
  openOrders: number;
}

/** Allowed range of one numeric setting (mirrors server autopilotConfig.ts). */
export interface NumberBounds {
  min: number;
  max: number;
  integer: boolean;
  /** null is a meaningful value (e.g. "no limit"). */
  nullable?: boolean;
}

export interface AutopilotBounds {
  config: Partial<Record<keyof AutopilotConfig, NumberBounds>>;
  policy: Record<keyof FeePolicy, NumberBounds>;
  rebalancePolicy: Record<keyof RebalancePolicy, NumberBounds>;
  /** The rules that span fields (the form checks them before sending). */
  rules?: { channelSizeMinSats: number };
}

/** A settings update: any subset of fields; the policies merge field by field. */
export type AutopilotConfigPatch = Partial<Omit<AutopilotConfig, "policy" | "rebalancePolicy">> & {
  policy?: Partial<FeePolicy>;
  rebalancePolicy?: Partial<RebalancePolicy>;
};

/** The areas of the autopilot that keep a "last decision" (D16). */
export type DecisionArea = "fees" | "rebalance" | "channels" | "magma" | "maxHtlc";

/** What an area did with its last chance to act (server: autopilot.ts):
 *  acted, idle (nothing needed doing), waiting (held back until a condition
 *  passes), deferred (left for something else on purpose), blocked (needs
 *  the operator), error. Waiting and deferred are never failures (D15). */
export type DecisionState = "acted" | "idle" | "waiting" | "deferred" | "blocked" | "error";

export interface AreaDecision {
  at: string;
  /** Absent on decisions stored before states were kept. */
  state?: DecisionState;
  text: string;
  since?: string;
  repeats?: number;
  lastError?: { at: string; text: string };
}

/** An area as the UI shows it: its last decision — or off, or blocked now. */
export interface AreaStatus {
  /** "not_run": switched on, and no decision made yet. */
  state: DecisionState | "off" | "not_run";
  text: string;
  /** null: no decision yet. */
  at: string | null;
  since?: string;
  repeats?: number;
  lastError?: { at: string; text: string };
  /** Off or blocked: what it decided while it last ran. */
  last?: AreaDecision;
}

/** The main run's last pass in numbers (every pass, no-op ones too). */
export interface RunSummary {
  at: string;
  attempted: number;
  applied: number;
  failed: number;
  feeChanges: { ok: number; failed: number };
  rebalances: { ok: number; failed: number; inFlight: number };
  opens: { ok: number; failed: number };
  sells: { ok: number; failed: number };
  maxHtlc: { ok: number; failed: number };
  errors: string[];
}

/** The switches "Pause all automation" turns off. */
export type AutomationSwitch = "enabled" | "rebalanceEnabled" | "channelEnabled" | "maxHtlcEnabled" | "sellEnabled";

export interface AutopilotState {
  canWrite: boolean;
  config: AutopilotConfig;
  /** Server-side bounds of every numeric setting. */
  bounds: AutopilotBounds;
  lastRunAt: string | null;
  history: AutopilotRun[];
  /** The main run in progress, if any: since when. */
  runningSince?: string | null;
  magmaLane?: MagmaLaneStatus;
  /** Per area, the latest decision and why (as stored). */
  decisions?: Partial<Record<DecisionArea, AreaDecision>>;
  /** Per area, what to show: the last decision, or off / blocked. */
  status?: Record<DecisionArea, AreaStatus>;
  /** The main run's last pass in numbers. */
  lastRun?: RunSummary | null;
  /** When the autopilot itself last changed something (a run, the lane, a
   *  sold channel's fee promise kept — never a fee set by hand). */
  lastActionAt?: string | null;
  /** "Pause all automation" in force: since when, and what was on. */
  paused?: { at: string; was: AutomationSwitch[] } | null;
  /** LSP mode (Settings) answering wallet orders. Not one of the autopilot's
   *  switches: "Pause all automation" leaves it on, and says so while it is. */
  lspModeOn?: boolean;
  /** Today's rebalance fee budget (UTC day) — autopilot and manual runs together. */
  rebalanceBudget?: RebalanceBudget;
}

/** Today's rebalance fee budget: what was spent (fees paid, and the maximum
 *  fee of payments still in flight) and what is left. */
export interface RebalanceBudget {
  day: string;
  /** null: no daily limit. */
  budgetSats: number | null;
  spentSats: number;
  inFlightSats: number;
  leftSats: number | null;
  /** When the next day's budget starts (00:00 UTC). */
  resetsAt: string;
}

/** The rebalance settings — each one binds the profit gate. */
export interface RebalancePolicy {
  /** The most a refill's route may cost, as a share of what it is expected to earn (0.05–1). */
  econRatio: number;
  /** A refill must be expected to net at least this much (sat). */
  minNetProfitSats: number;
  /** Its fee must be earned back within this many days. */
  maxPaybackDays: number;
  /** The most one refill moves (sat). */
  maxAmountSats: number;
}

export interface RebalanceExecResult {
  ok: boolean;
  targetId: string;
  targetAlias: string;
  /** The source that paid (or, when none did, the first). */
  sourceId: string;
  sourceAlias: string;
  amountSats: number;
  budgetPpm: number;
  feeSats: number | null;
  costPpm: number | null;
  error?: string;
  /** The payment that paid (its hash). */
  paymentId?: string;
  /** Stopped waiting while the payment was still in flight (the hard limit,
   *  or LND didn't say how it ended): it may still land. Tracked, and logged
   *  once LND knows. */
  inFlight?: { paymentId: string; maxFeeSats: number };
  targetSentBefore?: number;
  /** The target's outbound fee (ppm) as read for this refill: its hold is
   *  booked at no more than this. */
  targetPpm?: number;
  failedSourceIds?: string[];
  /** Stopped before its next attempt because LightningMate is shutting down:
   *  a skip, not a failure — nothing more was sent. */
  stopped?: boolean;
}

/** A refill by hand (POST /rebalance/execute). */
export interface RebalanceExecRequest {
  targetId: string;
  sourceId: string;
  amountSats: number;
  /** Fallback cost cap (× the target's fee) when no maxFeePpm is given. */
  econRatio: number;
  maxFeePpm?: number;
  /** The most the refill may pay (sat) — what the confirm dialog promised. */
  maxFeeSats?: number;
  /** The profit gate's earnings side: every size tried pays at most what
   *  it earns above the minimum net profit. A refill run with it passed the
   *  same check as the autopilot's, and its price is held the same way. */
  gate?: { revenuePpm: number; demandSats: number; minNetSats: number };
  /** When the plan the row came from was made (its generatedAt): a target
   *  refilled — or tried — since then is refused (409 stale_plan). */
  planAt?: string;
}

/** A rebalance payment that may still land: its two channels are left alone
 *  (no refill through them, by hand or by the autopilot) until LND says how
 *  it ended. */
export interface RefillInFlight {
  targetId: string;
  /** The target's peer alias. */
  alias: string;
  sourceId?: string;
  sourceAlias?: string;
  amountSats: number;
  maxFeeSats: number;
  /** When it was sent. */
  at: string;
  via: "autopilot" | "manual";
}

export interface RebalanceRecord {
  at: string;
  via: "manual" | "autopilot";
  targetId: string;
  targetAlias: string;
  sourceId: string;
  sourceAlias: string;
  amountSats: number;
  budgetPpm: number;
  feeSats: number | null;
  costPpm: number | null;
  ok: boolean;
  error?: string;
  /** When it was sent: its fee counts on that day's budget. */
  startedAt?: string;
  /** The payment's hash (booked once, whatever restarts in between). */
  paymentId?: string;
  targetSentBefore?: number;
  /** What the profit gate valued the refill at (ppm): the fee engine holds it. */
  holdPpm?: number;
}

export interface RebalanceLogSummary {
  /** The window the totals cover (days). */
  windowDays: number;
  count: number;
  failed: number;
  totalFeeSats: number;
  totalAmountSats: number;
  avgCostPpm: number;
}

export interface RebalanceLogResponse {
  summary: RebalanceLogSummary;
  records: RebalanceRecord[];
  /** Since when LightningMate's log covers rebalances (null: none yet). */
  trackedSince?: string | null;
}

/** What rebalancing cost over a window, per refilled channel (GET /rebalance/costs). */
export interface RebalanceCostsResponse {
  windowDays: number;
  /** "lnd": LND's payments (every tool's rebalances); "log": LightningMate's own log only. */
  source: "lnd" | "log";
  feeSats: number;
  count: number;
  amountSats: number;
  /** By refilled channel, with who it is with and whether it is still
   *  there (absent where the server doesn't know). */
  perChannel: { channelId: string; feeSats: number; count: number; alias?: string; status?: "open" | "pending" | "closed" }[];
  /** Rebalances LND lists, from when LightningMate's log covers them on,
   *  that it didn't make (another tool). */
  notLogged: number;
  /** Rebalances LND lists from before LightningMate's log began — its own
   *  older ones among them: whose they were can't be told. */
  beforeLog: number;
  logOnly: number;
  logTrackedSince: string | null;
  note: string | null;
}

export interface SuggestionPolicy {
  count: number;
  minChannels: number;
  maxStaleDays: number;
  minSizeSats: number;
  maxSizeSats: number;
  requireClearnet: boolean;
}

export type NodeNeed =
  | "need_inbound"
  | "need_outbound"
  | "need_routing_diversity"
  | "need_revenue"
  | "balanced";

export interface ChannelSuggestion {
  pubkey: string;
  alias: string;
  socket: string;
  hasClearnet: boolean;
  channels: number;
  capacitySats: number;
  avgChannelSats: number;
  avgFeePpm: number;
  lastSeenDays: number;

  score: number;
  graphScore: number;
  demandScore: number;
  weightedReachScore: number;
  roleFitScore: number;
  economicsScore: number;

  newReach: number;
  weightedNewReach: number;
  qualityReachCount: number;

  demandOverlapCount: number;
  demandFlowSharePct: number;

  portfolioOverlap: number;

  recommendedSizeSats: number;
  sizeReason: string;

  usefulness: "high" | "medium" | "low";
  badges: string[];
  reasons: string[];
  warnings: string[];

  /** LN+ reputation when the peer has a profile there, else null. */
  lnplus: LnPlusRating | null;
  /** Every advertised address, in dialing order (.onion first on a Tor-only node). */
  sockets?: string[];
  /** The smallest channel the peer says it accepts (LN+), or null. */
  peerMinChannelSats?: number | null;
  /** This node closed a channel with the peer this many days ago (≤ 90), or null. */
  closedDaysAgo?: number | null;
  /** On the operator's "never open automatically" list. */
  neverOpen?: boolean;
}

export interface LnPlusRating {
  rank: number;
  rankName: string;
  prime: boolean;
  verified: boolean;
  positiveRatings: number;
  negativeRatings: number;
  profileUrl: string;
  /** What the reputation did to the score, in percent (+8 = lifted by 8%). */
  scoreEffectPct: number;
}

export interface CloseCandidate {
  channelId: string;
  alias: string;
  peerPubkey: string;
  transactionId: string;
  transactionVout: number;
  active: boolean;
  weOpened: boolean;
  capacitySats: number;
  localSats: number;
  capitalFreedSats: number;
  closeCostSat: number;
  inboundLiquidityLostSats: number;
  closeScore: number;
  pnl30dSats: number;
  /** 60 days: fees earned + fees of the forwards it brought in − rebalancing. */
  pnl60dSats: number;
  /** Of that, the fees of the forwards that came in through it. */
  assisted60dSats?: number;
  flow60dSats: number;
  forwards60d: number;
  ageDays: number | null;
  reachContribution: number;
  uniqueReachLost: number;
  feeV2State: string;
  opportunityCandidates: { alias: string; score: number; sizeSats: number }[];
  /** Its peer is away (null: online); `long` = it counts toward a close. */
  offline: OfflineInfo | null;
  /** A lease the channel had, over now (a bought one with its cost). */
  lease: ChannelLease | null;
  csvDelayBlocks: number | null;
  commitFeeSats: number | null;
  reasons: string[];
  warnings: string[];
}

/** A channel the close list leaves alone, and why. */
export interface ProtectedChannel {
  channelId: string;
  alias: string;
  reason: string;
  lease: ChannelLease | null;
}

/** A channel still opening or closing: never closable from the list. */
export interface PendingChannel {
  channelId: string;
  alias: string;
  status: "pending_open" | "pending_close";
  capacitySats: number;
  localSats: number;
  lease: ChannelLease | null;
  timelockBlocks: number | null;
}

export interface CloseCandidatesResponse {
  windowDays: number;
  candidates: CloseCandidate[];
  protectedCount: number;
  protected: ProtectedChannel[];
  pending: PendingChannel[];
  totalCapitalFreedSats: number;
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

/** Month-old channels and their routing over the last 30 days (server openPlan.ts). */
export interface YieldEvidence {
  channels: number;
  capacitySat: number;
  forwards: number;
  earnedSat: number;
  /** False: LND's forwarding history couldn't be read. */
  forwardsRead: boolean;
}

/** The routing fee a channel is opened with. */
export interface StartingFee {
  feeRatePpm: number;
  baseFeeMsat: number;
}

export interface OpenChannelResult {
  ok: boolean;
  pubkey: string;
  localTokens: number;
  transactionId?: string;
  transactionVout?: number;
  error?: string;
  /** The routing fee the channel was opened with (a successful open). */
  startingFee?: StartingFee;
}

export interface SuggestionsResponse {
  policy: SuggestionPolicy;
  nodeNeed: NodeNeed;
  nodeNeedReason: string;
  hasDemandData: boolean;
  suggestions: ChannelSuggestion[];
  graphAgeSec: number;
  lnplus: {
    enabled: boolean;
    checked: number;
    known: number;
    paused: boolean;
    error: string | null;
  };
  portfolioSummary: {
    selectedCount: number;
    estimatedNewReach: number;
    estimatedWeightedNewReach: number;
    demandCoveragePct: number;
  };
}

export type FeeMode = "auto" | "fixed" | "exclude";
export interface ChannelOverride {
  mode: FeeMode;
  fixedPpm?: number;
}
export type OverrideMap = Record<string, ChannelOverride>;

export interface Alert {
  level: "warn" | "info";
  message: string;
  /** Present on alerts that stay until acknowledged (damaged state files,
   *  service-fee problems); POST it to /alerts/ack to dismiss. */
  id?: string;
}

/** GET /api/health — open (no login needed). */
export interface HealthInfo {
  ok: boolean;
  service: string;
  /** Image version (git tag, e.g. "v0.7.8"), or "dev". */
  version: string;
  /** Running as the Umbrel app, or on its own (LND settings in .env). */
  platform?: "umbrel" | "standalone";
}

export interface CloseChannelResult {
  ok: boolean;
  transactionId?: string;
  error?: string;
}

export type FiatCurrency = "off" | "USD" | "EUR" | "GBP" | "CHF";

export interface AppSettings {
  fiatCurrency: FiatCurrency;
  /** Look peers (and this node) up on lightningnetwork.plus. */
  lnplusLookups: boolean;
  /** Which outbound requests go through Umbrel's Tor proxy, when there is one. */
  torRoute: TorRoute;
  lspModeEnabled: boolean;
  lspClearnetAddress: string;
}

export type TorRoute = "lookups" | "all" | "direct";

/** Where LightningMate's own lookups go, and by which route (GET /privacy). */
export interface PrivacyInfo {
  /** Umbrel's Tor proxy (host:port), or null: everything goes direct. */
  torProxy: string | null;
  torRoute: TorRoute;
  lnplusLookups: boolean;
  destinations: { service: string; what: string; active: boolean; viaTor: boolean }[];
}

/** LSP mode (LSPS1) live status from GET /lsp/status. */
export interface LspStatus {
  enabled: boolean;
  running: boolean;
  canWrite: boolean;
  /** Requests answered with a result (any method). */
  requestsServed: number;
  /** The last request of any kind — served or refused. */
  lastRequestAt: string | null;
  lastError: string | null;
  /** Per method: served, and refused by JSON-RPC error code (with the last
   *  message sent). "other": unknown methods and unreadable messages. */
  requests: {
    method: string;
    served: number;
    errors: { code: number; count: number; lastMessage: string; lastAt: string }[];
  }[];
  /** Parameters wallets sent that this LSP accepts and ignores (D14). */
  ignoredParams: { name: string; count: number }[];
  /** Wallets that named themselves (client_info), the latest first. */
  clients: { app: string; version: string; lastAt: string }[];
  /** Recovery: orders waiting on LND, tried again with backoff. `waiting`
   *  counts them all; of those, `refunds` are failed orders whose payment LND
   *  still holds (it refused the cancel) and `settles` are opened channels
   *  whose payment LND hasn't claimed (it refused the settle). The rest are
   *  orders LND hasn't answered for (e.g. while it starts up). */
  recovery: { waiting: number; refunds: number; settles: number; lastError: string | null; nextTryAt: string | null };
  ordersPending: number;
  ordersCompleted: number;
  ordersFailed: number;
  earnedSat: number;
  serviceFeeBps: number;
  featureBit: { set: boolean; error: string | null };
  announcedSocket: { address: string; applied: boolean; error: string | null };
  offer: {
    minChannelSat: number;
    maxChannelSat: number;
    deployableSat: number;
    maxChannelExpiryBlocks: number;
    minFundingConfirmsWithinBlocks: number;
  } | null;
  pubkey: string;
  uris: string[];
}

/** One LSPS1 order (direct channel sale) from GET /lsp/orders. */
export interface LspOrder {
  orderId: string;
  peer: string;
  createdAt: string;
  sizeSat: number;
  feeSat: number;
  orderState: "CREATED" | "COMPLETED" | "FAILED";
  paymentState: "EXPECT_PAYMENT" | "HOLD" | "PAID" | "REFUNDED";
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

export interface PriceInfo {
  currency: FiatCurrency;
  btcPrice: number | null;
}

// ── Lightning send / receive ──────────────────────────────────────────────────
export interface CreatedInvoice {
  id: string;
  request: string;
  tokens: number;
  description: string;
  createdAt: string;
  expiresAt: string;
}

export interface DecodedRequest {
  id: string;
  destination: string;
  tokens: number;
  description: string;
  expiresAt: string;
  expired: boolean;
}

export interface PayResult {
  ok: boolean;
  id: string;
  tokens: number;
  feeSats: number;
  secret: string;
  error?: string;
}

export interface LnActivity {
  invoices: {
    id: string;
    tokens: number;
    description: string;
    isPaid: boolean;
    receivedSats: number;
    createdAt: string;
  }[];
  payments: {
    id: string;
    destination: string;
    tokens: number;
    feeSats: number;
    isConfirmed: boolean;
    createdAt: string;
  }[];
}

// ── On-chain wallet ───────────────────────────────────────────────────────────
export interface OnchainUtxo {
  outpoint: string;
  address: string;
  tokens: number;
  confirmations: number;
}

export interface OnchainState {
  confirmedSats: number;
  pendingSats: number;
  utxos: OnchainUtxo[];
  suggestedFeeRate: number | null;
  /** What the wallet can spare: what "Max" fills in at `feeRate` (the
   *  suggested rate the send form starts with) for a typical send — the
   *  confirmed coins less the on-chain reserve (D5), the coins promised to
   *  buyers and the fee (null: LND couldn't say). */
  budget: { reserveSats: number; promisedSats: number; availableSats: number; feeRate: number | null } | null;
}

/** Something about an on-chain send the operator must confirm a second time. */
export type SendCheckCode = "fee_rate_high" | "fee_share_high" | "below_reserve";
export interface SendCheck {
  code: SendCheckCode;
  message: string;
}

/** GET /onchain/send-preview: what a send costs and leaves, before it is sent. */
export interface SendPreview {
  mode: "amount" | "max" | "all";
  address: string;
  /** What the address receives (estimated for "all"). */
  amountSats: number;
  feeRate: number;
  vbytes: number;
  feeSats: number;
  /** The size is the app's estimate from the wallet's coins, not LND's. */
  feeApprox: boolean;
  estimates: FeeEstimates;
  confirmedSats: number;
  reserveSats: number;
  promisedSats: number;
  availableSats: number;
  remainingSats: number;
  /** The send takes coins promised to buyers (asked separately, naming the orders). */
  touchesPromised: boolean;
  checks: SendCheck[];
  /** Why this send can't be made. */
  error?: string;
}

export interface OnchainTx {
  id: string;
  amountSats: number;
  feeSats: number;
  confirmations: number;
  isConfirmed: boolean;
  isOutgoing: boolean;
  createdAt: string;
  /** The transactions whose outputs it spends (when LND lists them). */
  spends?: string[];
  /** Those of them whose spent output was no wallet coin (an anchor, a
   *  commitment's output): a closing channel's fee bump or sweep. */
  spendsNonWallet?: string[];
}

export interface NewAddress {
  address: string;
}

export interface OnchainSendResult {
  ok: boolean;
  transactionId: string;
  error?: string;
}

// ── Overview dashboard ────────────────────────────────────────────────────────
export type ActivityKind =
  | "forward"
  | "received"
  | "sent"
  | "rebalance"
  | "onchain_in"
  | "onchain_out"
  | "channel_open"
  | "channel_close";

export interface ActivityItem {
  at: string;
  kind: ActivityKind;
  title: string;
  amountSats: number;
  routedSats?: number;
  feeSats?: number;
}

export interface DashboardData {
  windowDays: number;
  earnedSats: number;
  forwardCount: number;
  routedSats: number;
  /** The last 24 h and 7 days, rolling (the sparklines end in a partial day). */
  rolling: { last24h: RollingTotals; last7d: RollingTotals };
  /** False when LND had more forwards in the window than were read: the most
   *  recent are missing, `rolling` with them. */
  forwardsComplete: boolean;
  feesSpark: number[];
  forwardsSpark: number[];
  routedSpark: number[];
  rebalancedCount: number;
  rebalancedSats: number;
  /** Every channel's capacity, peers' sides and pending channels included. */
  totalCapacitySats: number;
  /** This node's own capital in its open channels (their local balance). */
  ownCapitalSats?: number;
  /** Routing fees on that capital, annualised — gross (ppm/year). */
  yieldPpmYear: number;
  /** The same after the window's rebalancing fees. */
  netYieldPpmYear?: number;
  rebalanceFeesSats?: number;
  rebalanceSource?: "lnd" | "log";
  /** What leasing out on Magma would earn this node — live (D12). */
  leaseBenchmark?: LeaseBenchmark;
  activity: ActivityItem[];
  autopilot: {
    fees: boolean;
    rebalance: boolean;
    channel: boolean;
    sell: boolean;
    /** The main run's last pass … */
    lastRunAt: string | null;
    /** … and what THAT pass did (null: no summary of it on record). */
    lastRun: {
      applied: number;
      attempted: number;
      /** Everything that failed in it, each stage that threw included. */
      failed: number;
      feeChanges: number;
      rebalances: number;
      sells: number;
      opens: number;
      maxHtlc: number;
      /** The stages that threw in it, by name. */
      errors: string[];
    } | null;
    /** When the autopilot itself last changed something — never a fee set
     *  by hand (its own item). */
    lastActionAt: string | null;
    intervalMinutes: number;
    /** "Pause all automation" in force since (null: not paused). */
    pausedAt?: string | null;
    /** LSP mode (Settings) answering wallet orders — no switch of the
     *  autopilot's: a pause leaves it on, and the digest says so. */
    lspModeOn?: boolean;
    /** Per area: the last decision, or off / blocked (compact). */
    status: Partial<Record<DecisionArea, { state: AreaStatus["state"]; text: string; at: string | null }>>;
    /** Magma orders the lane turned down in the last two days (not dismissed). */
    magmaRefusals?: number;
    magmaRefusalReason?: string | null;
  };
}

export interface LeaseBenchmark {
  status: "eligible" | "not_realistic" | "no_data" | "unknown";
  /** Median annual rate buyers paid for comparable leases (gross), in %. */
  grossAprPct: number | null;
  sales: number | null;
  windowDays: number | null;
  text: string;
}

export interface NetworkRank {
  position: number;
  total: number;
  percentile: number;
  degree: number;
}

export interface ScoreCategory {
  key: string;
  label: string;
  /** null: not enough data to judge — left out of the overall score. */
  score: number | null;
  weight: number;
  detail: string;
  hint: string;
}

export interface NodeScore {
  score: number;
  grade: string;
  categories: ScoreCategory[];
  rank: NetworkRank | null;
  /** Why the grade is provisional (a category not graded yet), or null. */
  provisional: string | null;
}

export type FeeRecState =
  | "normal"
  | "exploring_lower_fee"
  | "protecting_liquidity"
  | "recovering_cost"
  | "close_candidate";

export interface FeeRecMetrics {
  localRatio: number;
  targetLocalRatio: number;
  channelAgeDays: number | null;
  routedOut14d: number;
  routedIn14d: number;
  routedOut30d: number;
  routedIn30d: number;
  grossFlow14d: number;
  netDrain14d: number;
  grossFlow30d: number;
  netDrain30d: number;
  revenue14d: number;
  revenue30d: number;
  revenuePpm14d: number | null;
  revenuePpm30d: number | null;
  /** What the refilled sats still in it cost (the autopilot's refills of the last 30 days). */
  costBasisPpm: number | null;
  costBasisSource: "rebalance_avg" | "unknown";
  costBasisRefills: number;
  costBasisLatestAt: string | null;
  /** Refilled sats still in the channel (not routed out yet). */
  refillRemainingSats: number;
  /** The price a refill's floor holds (what the profit gate valued it at). */
  refillHoldPpm: number | null;
  /** The floor was released under low flow. */
  profitFloorReleased: boolean;
  /** The floor in force (capped at maxPpm unless opted in). */
  profitFloorPpm: number | null;
  profitFloorCapped: boolean;
  peerGate: "ok" | "weak";
  role: string;
  isTopEarner: boolean;
  benchmarkComparison: "above" | "median" | "below";
  /** What other nodes charge to forward into this peer (public graph). */
  marketPpm: number | null;
  marketSamples: number;
  /** A remembered reference — this report's graph had none for the peer
   *  (kept up to 7 days): when it was last seen. Null: this report's own. */
  marketSeenAt: string | null;
  peerFeeToUsPpm: number | null;
  /** The least a refill costs on the market (into the peer + its hop back). */
  replacementCostPpm: number | null;
  /** Draining, and priced below what replacing its outbound costs. */
  belowReplacement: boolean;
  marketComparison: "above" | "in_line" | "below" | null;
  draining: boolean;
  /** Possible demand, 14 days: de-noised HTLCs refused for lack of outbound
   *  that a refilled channel could have carried. */
  refusedAttempts14d: number;
  refusedSats14d: number;
  refusedDays14d: number;
  inDemand: boolean;
  elasticityMod: number;
}

export interface FeeRecommendation {
  channelId: string;
  alias: string;
  capacity: number;
  currentPpm: number;
  /** This update's move. */
  targetPpm: number;
  /** Where the engine wants the fee to end up (moves are bounded steps). */
  aimPpm: number;
  transactionId: string | null;
  transactionVout: number | null;
  currentBaseMsat: number;
  /** The base fee the engine sets (applied with the rate). */
  recommendedBaseMsat: number;
  noFlowLowering: boolean;
  /** Pinned by hand: applied exactly as set. */
  pinned: boolean;
  /** A channel this node sold whose order locked a routing-fee promise. */
  leaseCap: { source: "magma" | "lsps1"; orderId: string; feeRateCapPpm: number; baseFeeCapMsat: number; untilHeight: number | null } | null;
  /** Its current fee breaks that promise (lowered at once). */
  leaseCapBreach: boolean;
  wouldApply: boolean;
  blockedByGuards: string[];
  state: FeeRecState;
  reasons: string[];
  metrics: FeeRecMetrics;
}

export interface NodeBenchmarks {
  activeChannelCount: number;
  topGrossFlow14d: number;
  medianGrossFlow14d: number;
  topRevenue30d: number;
  medianRevenue30d: number;
  topRevenuePpm30d: number;
  medianRevenuePpm30d: number;
}

export interface FeeRecReport {
  generatedAt: string;
  nodeBenchmarks: NodeBenchmarks;
  /** How many channels have a market reference from the public graph. */
  marketReferenced: number;
  /** How many channels the elasticity learner has enough evidence for. */
  elasticityLearned: number;
  recommendations: FeeRecommendation[];
}

export type RebalanceRecState =
  | "not_needed"
  | "watching"
  | "fee_adjust_first"
  | "profitable_rebalance_candidate"
  | "route_found_profitable"
  | "route_found_too_expensive"
  | "unprofitable_skip"
  | "close_candidate";

export interface RebalanceSourceCandidate {
  channelId: string;
  alias: string;
  localRatio: number;
  /** What it can give and still keep its own share (sat). */
  spareSats: number;
  /** The local ratio it keeps. */
  keepRatio: number;
  reason: string;
  /** Probed and no route passed the gate from it. */
  rejected?: boolean;
  rejectedReason?: string;
}

export interface RebalanceRecommendation {
  channelId: string;
  alias: string;
  role: string;
  state: RebalanceRecState;
  wouldRebalance: boolean;
  blockedBy: string[];
  reasons: string[];
  localRatio: number;
  targetLocalRatio: number;
  capacity: number;
  currentPpm: number;
  /** The fee engine's next move … */
  feeV2TargetPpm: number | null;
  /** … and where it is heading. */
  feeV2AimPpm: number | null;
  feeV2State: string | null;
  profitFloorPpm: number | null;
  routedOut14d: number;
  routedIn14d: number;
  routedOut30d: number;
  routedIn30d: number;
  netDrain14d: number;
  grossFlow14d: number;
  /** De-noised refused HTLCs (possible demand), 14 days. */
  refusedSats14d: number;
  inDemand: boolean;
  revenue14d: number;
  revenue30d: number;
  revenuePpm14d: number | null;
  revenuePpm30d: number | null;
  /** The estimate before the refill (ppm). */
  preRefillPpm: number | null;
  /** What the gate values the refilled sats at (ppm): the estimate before
   *  the refill, or the lower fee the engine charges after it. */
  expectedRevenuePpm: number | null;
  /** Where the fee engine takes the fee after the refill (its hold included). */
  postRefillPpm: number | null;
  avgDailyRevenueSats: number;
  maxCostPpm: number | null;
  maxCostSatsByPayback: number | null;
  maxPaybackDays: number;
  /** The gate's earnings are capped at this 14-day outflow (sat). */
  earningDemandSats: number;
  minNetProfitSats: number;
  /** The most this move may pay in routing fees (sat) — the payment's cap. */
  maxFeeSats: number | null;
  recommendedAmount: number | null;
  amountToReachTargetLocalRatio: number;
  demandSizedAmount: number;
  sourceCandidates: RebalanceSourceCandidate[];
  selectedSourceChannel: string | null;
  estimatedRouteFeeSats: number | null;
  estimatedRouteCostPpm: number | null;
  expectedPaybackDays: number | null;
  expectedNetProfitSats: number | null;
}

export interface RebalanceRecSummary {
  totalCandidates: number;
  profitableRecommendations: number;
  feeAdjustFirstCount: number;
  tooExpensiveCount: number;
  closeCandidateCount: number;
  expectedTotalCostSats: number;
  expectedTotalNetProfitSats: number;
}

/** Refilling outbound: what a rebalance's route costs now vs raising the fee. */
export interface RefillNote {
  routeTypicalPpm: number | null;
  feeFirstCount: number;
  note: string;
}

/** The rebalance gate's settings as the plan used them. */
export interface RebalanceRecConfig {
  /** The most a refill's route may cost, as a share of what it is expected to earn (the autopilot's econRatio). */
  profitShare: number;
  maxPaybackDays: number;
  minExpectedNetProfitSats: number;
  demandCoverageMultiplier: number;
  maxCapacityRefillRatio: number;
  minRebalanceAmount: number;
  maxRebalanceAmountPerChannel: number;
  targetDeficitThreshold: number;
  sourceExcessThreshold: number;
  minRevenuePpm: number;
  newChannelProtectionDays: number;
  sourceMinAgeDays: number;
  sourceKeepMargin: number;
  maxSourcesPerTarget: number;
  maxCandidates: number;
  probeCeilingPpm: number;
}

export interface RebalanceRecReport {
  generatedAt: string;
  config?: RebalanceRecConfig;
  summary: RebalanceRecSummary;
  refill: RefillNote;
  recommendations: RebalanceRecommendation[];
  /** Today's fee budget (what the autopilot plans within). */
  budget?: RebalanceBudget;
  /** Rebalance payments that may still land: a row whose channels one goes
   *  through shows it instead of a Run button. */
  inFlight?: RefillInFlight[];
}

export interface LiveForward {
  at: string;
  tokens: number;
  fee: number;
  incoming: string;
  outgoing: string;
}

export interface PnlSummary {
  windowDays: number;
  routingRevenueSats: number;
  forwardCount: number;
  /** Lease income: Magma and LSPS1 sales. */
  magmaRevenueSats: number;
  magmaSaleCount: number;
  rebalanceCostSats: number;
  rebalanceCount: number;
  /** "lnd": every tool's rebalances (LND's payments); "log": LightningMate's own only. */
  rebalanceSource: "lnd" | "log";
  /** Of rebalanceCount, those made outside LightningMate (another tool),
   *  from when its log covers rebalances on. */
  rebalanceNotLogged: number;
  /** Of rebalanceCount, those from before LightningMate's log began
   *  (rebalanceLogSince): whose they were can't be told. */
  rebalanceBeforeLog: number;
  rebalanceLogSince: string | null;
  channelOpenCostSats: number;
  channelCloseCostSats: number;
  channelCloseCount: number;
  /** Closes in the window whose cost couldn't all be worked out. */
  channelCloseUnknownCount: number;
  /** Inbound bought on Magma (invoice + routing fee). */
  inboundPurchaseCostSats: number;
  inboundPurchaseCount: number;
  otherChainFeesSats: number;
  /** Routing fees of the Lightning payments this node sent (not rebalances,
   *  Magma purchases or the service fee) — shown apart, not counted in net. */
  lightningPaymentFeesSats: number;
  lightningPaymentCount: number;
  serviceFeePaidSats: number;
  totalCostSats: number;
  netProfitSats: number;
  /** What the figures can't see, in words. */
  notes: string[];
}

export interface OfferCondition {
  condition: string;
  operator: string;
  value: string;
}

export interface MagmaOffer {
  id: string;
  sellerPubkey: string;
  minSizeSats: number;
  maxSizeSats: number;
  baseFeeSats: number;
  feeRatePpm: number;
  sellerScore: number;
  availableSats: number;
  totalSizeSats?: number;
  minBlockLength?: number;
  feeRateCapPpm?: number | null;
  baseFeeCapSats?: number | null;
  conditions?: OfferCondition[];
}

export interface MarketView {
  offers: MagmaOffer[];
  /** The bitcoin price: sats per US dollar. */
  satsPerUsd: number | null;
  /** Inbound capacity one US dollar buys at today's market rate. */
  inboundSatsPerUsd?: number | null;
}

export interface BuyQuote {
  orderId: string;
  paymentRequest: string;
  sats: number;
  channelSizeSats: number;
  /** The terms a targeted buy locked: lease and the seller's fee promise. */
  leaseBlocks?: number | null;
  feeRateCapPpm?: number | null;
  baseFeeCapSats?: number | null;
  ambossFeeSats?: number | null;
}

/** One buyer condition, checked against this node. */
export interface ConditionCheck {
  condition: string;
  /** null: can't be checked from here. */
  pass: boolean | null;
  text: string;
}

/** An offer ranked for buying, evaluated at the chosen size (server: magmaBuy.ts). */
export interface BuyOffer {
  offerId: string;
  sellerPubkey: string;
  sellerScore: number;
  minSizeSats: number;
  maxSizeSats: number;
  availableSats: number;
  sizeSats: number;
  fits: boolean;
  leaseBlocks: number;
  leaseDays: number;
  feeRatePpm: number;
  baseFeeSats: number;
  sellerFeeSats: number;
  ambossFeeSats: number | null;
  totalFeeSats: number;
  costPpmPerYear: number;
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  eligible: boolean | null;
  conditions: ConditionCheck[];
}

export interface BuyOffersResponse {
  sizeSats: number;
  offers: BuyOffer[];
  ambossFeeTiers: { ambossFeePpm: number; upToSats: number | null }[];
  inboundSatsPerUsd: number | null;
  satsPerUsd: number | null;
}

export type PurchaseState = "quoted" | "declined" | "cancel_failed" | "paying" | "paid" | "pay_failed" | "channel_open" | "order_failed";

/** Inbound bought on Magma (server: magmaPurchases.ts). */
export interface MagmaPurchase {
  orderId: string;
  createdAt: string;
  updatedAt: string;
  offerId: string | null;
  sellerPubkey: string | null;
  sizeSats: number;
  feeSats: number;
  paymentHash: string;
  expiresAt: string;
  leaseBlocks: number | null;
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  usdCents: number | null;
  state: PurchaseState;
  routingFeeSats: number | null;
  paidAt?: string;
  payStartedAt?: string;
  /** LND confirmed the failure (or never saw the payment); unset on a
   *  failure only the pay call reported — the order lane checks with LND. */
  failureConfirmed?: boolean;
  /** LND has no record of the payment though the channel opened. */
  paymentNotFound?: boolean;
  orderStatus: string | null;
  channelId: string | null;
  error?: string;
}

export interface OrderState {
  status: string;
  paymentStatus: string | null;
  channelId: string | null;
  channelSizeSats: number;
  done: boolean;
  failed: boolean;
  /** The terms the order locked and who sells — named once Amboss matched a
   *  seller (a dollar buy's quote can't say them). Null: not told. */
  leaseBlocks?: number | null;
  feeRateCapPpm?: number | null;
  baseFeeCapSats?: number | null;
  sellerPubkey?: string | null;
  /** "unclear": only the pay call reported a failure — LND is being asked. */
  payment: { state: "paying" | "paid" | "failed" | "unclear"; error?: string; feeSats?: number } | null;
}

export interface MyOffer {
  id: string;
  /** The node the offer sells for (only this node's are listed here). */
  nodePubkey?: string;
  status: string;
  minSizeSats: number;
  maxSizeSats: number;
  /** Listed capacity, including what live orders have locked. */
  totalSizeSats: number;
  lockedSats: number;
  /** What a new buyer can still order (total − locked). */
  availableSats: number;
  baseFeeSats: number;
  feeRatePpm: number;
  minBlockLength: number;
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  filledOrders: number;
  createdAt: string;
}

/** This node's own record of a Magma sale (server: magmaJournal.ts). */
export type MagmaPhase =
  | "seen"
  | "accepting"
  | "accepted"
  | "held"
  | "opening"
  | "funded"
  | "reported"
  | "settled"
  | "cancelled"
  | "rejected"
  | "failed";

export interface MagmaOrderLocal {
  phase: MagmaPhase;
  via: "autopilot" | "manual" | "legacy";
  updatedAt: string;
  fundingOutpoint: string | null;
  /** Why it was rejected, cancelled or failed. */
  reason: string | null;
  /** The order lane's latest decision (accept / reject / skip / wait) and why. */
  decision: { at: string; action: string; reason: string } | null;
  lastError: string | null;
  /** For a settled order: was it booked as a sale (a payment of ours)? */
  booked?: boolean | null;
  /** Ended here without LightningMate taking it on. */
  external?: "accepted_elsewhere" | "other_node" | null;
}

export interface MyOrder {
  id: string;
  status: string;
  side: "SELL";
  sizeSats: number;
  /** What you earn (Amboss reports 0 until it has settled it). */
  feeSats: number;
  /** The buyer's node id. */
  destination: string;
  buyerAlias: string | null;
  isPrivate: boolean;
  paymentStatus: string | null;
  channelId: string | null;
  transactionId: string | null;
  blocksUntilClosable: number | null;
  leaseActive: boolean;
  sold: boolean;
  timeout: string | null;
  createdAt: string;
  local: MagmaOrderLocal | null;
}

export interface MyOrdersView {
  orders: MyOrder[];
  pendingSeller: number;
  lane?: MagmaLaneStatus;
}

/** An offer's terms as Amboss has them, or as the autopilot wants them. */
export interface OfferFields {
  status: string;
  minSizeSats: number;
  maxSizeSats: number;
  totalSizeSats: number;
  availableSats: number;
  feeRatePpm: number;
  baseFeeSats: number;
  minBlockLength: number;
  feeRateCapPpm?: number | null;
  baseFeeCapSats?: number | null;
}

/** Who decides what about an offer (server: autopilot.ts OfferControl):
 *  its terms (yours after a manual create/edit), and whether it is listed. */
export interface OfferControl {
  /** You took the offer's terms over: when, and by doing what. */
  manual?: { since: string; why: string };
  /** The autopilot disabled it for lack of capital (it lists it again once it can be funded). */
  autoDisabledAt?: string;
  /** The autopilot sent that disable without an answer yet: the next read of the offer settles it. */
  autoDisablingAt?: string;
  /** You disabled it by hand: it stays disabled until you enable it. */
  disabledByHandAt?: string;
}

export interface OfferWrite {
  at: string;
  by: "autopilot" | "manual";
  action: "create" | "update" | "enable" | "disable";
  fields: Record<string, number | string>;
  ok: boolean;
  error?: string;
  verified?: boolean;
  reason?: string;
}

export interface OfferSyncEntry {
  offerId: string;
  checkedAt: string;
  amboss: OfferFields;
  wanted: OfferFields | null;
  inSync: boolean;
  differences: string[];
  lastWrite: OfferWrite | null;
  control?: OfferControl;
}

/** What the autopilot wants for your offers vs what Amboss has. */
export interface OfferSyncStatus {
  at: string | null;
  managed: boolean;
  offers: OfferSyncEntry[];
  lastError: { at: string; message: string } | null;
}

export interface MyOffersResponse {
  offers: MyOffer[];
  sync: OfferSyncStatus;
  /** Who owns each offer's terms. */
  controls?: Record<string, OfferControl>;
  /** The routing-fee promise every offer carries (D7). */
  feeCaps?: { feeRateCapPpm: number; baseFeeCapSats: number };
}

export type EligibilityVerdict = "not_realistic" | "possible_but_slow" | "realistic" | "unknown";

export interface EligibilityCell {
  offers: number;
  sold: number;
  fills: number;
  offerMonths: number;
  fillsPerMonth: number;
  upperBoundPerMonth: number | null;
}

/** Can this node realistically sell on Magma? (server: magmaEligibility.ts) */
export interface Eligibility {
  verdict: EligibilityVerdict;
  indicative: true;
  computedAt: string;
  bookFetchedAt: string | null;
  own: { sellerScore: number | null; confirmedSells: number | null; listableSat: number; maxChannelSat: number };
  tier: { ambossFee: number; fromSat: number; toSat: number | null } | null;
  /** Every Amboss fee tier of the live book: ppm, up to which order size (null: above). */
  feeTiers: { ambossFeePpm: number; upToSats: number | null }[];
  scoreSplit: { median: number; side: "at_or_below" | "above" } | null;
  comparable: EligibilityCell | null;
  widened: boolean;
  otherSide: EligibilityCell | null;
  expectedSalesPerYear: number | null;
  /** liquidity.buy orders start at $5: that order's channel at the market
   *  rate and at this node's own price (null: no offer of its own listed). */
  usdOrders: { minOrderSat: number; atOwnPriceSat: number | null; fits: boolean } | null;
  reasons: string[];
}

export type CheckStatus = "ok" | "problem" | "info" | "unknown";

export interface DiagnosticCheck {
  id: string;
  status: CheckStatus;
  label: string;
  detail: string;
  fix?: { tab: string; sub?: string; label: string };
}

export interface OfferTermsView {
  status: string;
  feeRatePpm: number;
  baseFeeSats: number;
  minSizeSats: number;
  maxSizeSats: number;
  minBlockLength: number;
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
}

/** "Why don't I sell?" (server: sellDiagnostics.ts) */
export interface SellDiagnostics {
  generatedAt: string;
  checks: DiagnosticCheck[];
  offers: {
    offerId: string;
    owner: "autopilot" | "you" | "nobody";
    amboss: OfferTermsView;
    target: Omit<OfferTermsView, "status"> | null;
    differences: string[];
    lastWrite: OfferWrite | null;
  }[];
  orders: {
    recent: { orderId: string; sizeSats: number; phase: string; seenAt: string; at: string; action: string; reason: string | null }[];
    failedOnAmboss: Record<string, number> | null;
  };
  lane: MagmaLaneStatus;
  eligibility: Eligibility | null;
}

/** valid / rejected (Amboss refused it) / unreachable (no answer — the last
 *  verdict is kept) / unknown (not checked yet). */
export type AmbossKeyCheck = "valid" | "rejected" | "unreachable" | "unknown";

export interface AmbossStatus {
  connected: boolean;
  keyValid: boolean | null;
  keyCheck: AmbossKeyCheck;
  checkedAt: string | null;
  lastError: string | null;
  saleFeeBps?: number;
  /** Magma orders this node has taken on and not finished (accepted, paid,
   *  opening, …): without a key they can't be fulfilled. */
  ordersInFlight?: number;
}

/** Outcome of a manual order action (accept / open / reject). */
export interface DeskResult {
  ok: boolean;
  code?: string;
  message: string;
  phase?: MagmaPhase;
  outpoint?: string;
  transactionId?: string;
  /** For an opened channel: has Amboss taken its funding transaction yet? */
  reported?: boolean;
}

// ── Magma v2 (profit-aware recommendations) ──
export type MagmaSellOfferState =
  | "well_priced"
  | "underpriced"
  | "overpriced"
  | "below_profit_floor"
  | "do_not_list_unprofitable"
  | "do_not_list_uncompetitive"
  | "exhausted"
  | "inactive";

export interface PricePoint {
  feeRatePpm: number;
  baseFeeSat: number;
  effectiveFeePpm: number;
  leaseApy: number;
}

/** What buyers paid for comparable leases (Amboss's completed orders),
 *  expressed for one lease length (`blocks`). */
export interface ClearingStats {
  count: number;
  windowDays: number;
  ordersPerMonth: number;
  p25Ppm: number;
  medianPpm: number;
  p75Ppm: number;
  medianApr: number;
  medianSizeSat: number;
  blocks: number;
}

export interface MagmaSellRecommendation {
  offerId: string | null;
  mode: "create" | "update" | "hold";
  state: MagmaSellOfferState;
  shouldReprice: boolean;
  repriceDirection: "up" | "down" | "none";
  current: { feeRatePpm: number; baseFeeSat: number; effectiveFeePpm: number } | null;
  /** The terms the offer should carry; every price here (and in `pricing`)
   *  is for `minBlockLength` — the lease it carries after the next write. */
  recommended: PricePoint & {
    minBlockLength: number;
    sizeSat: number;
    feeRateCapPpm: number | null;
    baseFeeCapSats: number | null;
  };
  market: {
    sizeBand: string;
    segmentCount: number;
    fallbackLevel: "size_band" | "all_offers";
    p10: number;
    p25: number;
    median: number;
    p75: number;
    mySellerScore: number | null;
    segmentMedianScore: number;
    myRank: number | null;
  };
  economics: {
    sizeSat: number;
    leaseYears: number;
    leaseFeeSat: number;
    serviceFeeSat: number;
    openCostSat: number;
    closeCostSat: number;
    netLeaseProfitSat: number;
    leasePpmPerYear: number;
    leaseApy: number;
    routingOpportunityPpmPerYear: number | null;
    adjustedRoutingPpmPerYear: number;
    profitFloorEffectivePpm: number;
    beatsRouting: boolean;
  };
  pricing: { fast: PricePoint; balanced: PricePoint; premium: PricePoint; profitFloor: PricePoint };
  /** What buyers paid for comparable leases, for this offer's lease. */
  clearing: ClearingStats | null;
  reasons: string[];
  warnings: string[];
}

export interface MagmaBuyRecommendation {
  offerId: string;
  sellerPubkey: string;
  state: "best_value" | "cheap_but_low_score" | "reliable_but_expensive" | "good_fit" | "size_mismatch";
  valueScore: number;
  effectiveCostPpm: number;
  sellerScore: number;
  minSizeSat: number;
  maxSizeSat: number;
  availableSat: number;
  reasons: string[];
}

export interface MagmaSellAnalytics {
  mySellerScore: number | null;
  offersActive: number;
  offersInactive: number;
  offersExhausted: number;
  totalListedSat: number;
  availableSat: number;
  deployedSat: number;
  filledOrders30d: number;
  filledOrdersAllTime: number;
  grossEarningsSat: number;
  serviceFeesSat: number;
  onchainCostsSat: number;
  netProfitSat: number;
  avgLeaseFeePpm: number | null;
  fillRate: number | null;
  closableSoon: number;
}

export interface FeeOutcome {
  channelId: string;
  alias: string;
  at: string;
  fromPpm: number;
  toPpm: number;
  raised: boolean;
  via: "autopilot" | "lease" | "manual";
  /** The intervals compared (days): until the neighbouring changes, ≤ 14. */
  beforeDays: number;
  afterDays: number;
  beforeDailyAvgSat: number;
  afterDailyAvgSat: number;
  forwardsBefore: number;
  forwardsAfter: number;
  /** Market-adjusted revenue change (null: nothing earned before). */
  deltaPct: number | null;
  /** Enough revenue before to count in the headline. */
  measurable: boolean;
}
export interface RebalanceOutcome {
  targetId: string;
  alias: string;
  at: string;
  amountSats: number;
  costSats: number;
  /** Its sats that routed out (first in, first out), and what those forwards earned. */
  routedOutSats: number;
  earnedSats: number;
  /** Its sats that left by a payment, not a forward (no fee). */
  otherOutSats: number;
  remainingSats: number;
  earnedBackPct: number;
  netSats: number;
  paidBack: boolean;
  status: "measured" | "measuring";
}
export interface OutcomesReport {
  measureWindowDays: number;
  fees: {
    windowDays: number;
    measured: number;
    /** Counted in the headline (enough revenue before). */
    measurable: number;
    pending: number;
    tooClose: number;
    raises: number;
    cuts: number;
    /** Revenue-weighted; null below minMeasured changes. */
    avgRevenueDeltaPct: number | null;
    minMeasured: number;
    confidence: "none" | "low" | "medium";
    note: string;
    items: FeeOutcome[];
  };
  rebalances: {
    /** How a refill is credited, in words. */
    method: string;
    measureDays: number;
    measured: number;
    measuring: number;
    totalCostSats: number;
    totalEarnedBackSats: number;
    avgEarnedBackPct: number | null;
    paidBackCount: number;
    netSats: number;
    items: RebalanceOutcome[];
  };
}

/** Inbound bought on Magma, set against the forwards it brought in (GET /analytics/bought-inbound). */
export interface BoughtInboundRoi {
  orderId: string;
  channelId: string | null;
  alias: string;
  sizeSats: number;
  costSats: number;
  paidAt: string;
  leaseDays: number;
  leaseEndsAt: string;
  running: boolean;
  inboundForwards: number;
  routedInSats: number;
  inboundFeesSats: number;
  /** null: no channel to follow, or the forwards read doesn't cover the lease. */
  roiPct: number | null;
  /** Why roiPct is null with a channel found (the "—" cell's title). */
  roiNote: string | null;
}

export interface BoughtInboundResponse {
  method: string;
  /** The window's share of what inbound bought cost, spread over each lease. */
  windowDays: number;
  amortizedSats: number;
  /** False when LND holds more forwards than were read (the newest missing). */
  forwardsComplete?: boolean;
  items: BoughtInboundRoi[];
}

export interface MagmaV2Report {
  nodeNeed: NodeNeed;
  nodeNeedReason: string;
  hasRoutingData: boolean;
  satsPerUsd: number | null;
  /** Reads that failed (your offers or orders on Amboss, LND's forwards) —
   *  also first among sell.warnings. */
  readProblems?: string[];
  sell: {
    state:
      | "good_to_sell"
      | "sell_only_above_profit_floor"
      | "market_too_cheap"
      | "insufficient_capital";
    deployableCapitalSat: number;
    recommendedSellSizeSat: number | null;
    routingOpportunityPpmPerYear: number | null;
    adjustedRoutingPpmPerYear: number;
    recommendedMinLeasePpmPerYear: number;
    pricingMode: "fast" | "balanced" | "premium" | "auto";
    adaptiveLevel: number;
    /** The lease an offer should promise (the standard one buyers use). */
    standardLeaseBlocks: number;
    /** The median size of real orders (90 days) — a fact, not a target. */
    medianOrderSat: number | null;
    recommendedMinSizeSat: number;
    recommendedMaxSizeSat: number;
    minViableSizeSat: number;
    minNetLeaseProfitSat: number;
    serviceFeeRate: number;
    effectiveMaxOrderSat: number;
    /** That ceiling is set by the coins on chain, not by the caps. */
    capitalLimited: boolean;
    projectedMonthlySat: number;
    onchainOpenCostSat: number;
    onchainCloseCostSat: number;
    onchainFeePerVbyte: number | null;
    pendingSellerOrders: number;
    /** Real completed Magma orders in our size band, straight from Amboss
     *  (for the standard lease). */
    clearing: ClearingStats | null;
    marketActivity: { orders: number; perDay: number; windowDays: number } | null;
    historyAgeHours: number | null;
    popularLeaseBlocks: number;
    reasons: string[];
    warnings: string[];
    recommendations: MagmaSellRecommendation[];
  };
  buy: {
    state: "recommended" | "optional" | "not_needed" | "no_good_offers";
    recommendedBuySizeSat: number | null;
    bestOfferId: string | null;
    reasons: string[];
    warnings: string[];
    ranked: MagmaBuyRecommendation[];
  };
  analytics: MagmaSellAnalytics;
}

// ── Channel backup (SCB) watchdog ──
export interface BackupStatus {
  available: boolean;
  /** Channels that must be in a backup: open + pending-open. */
  currentChannelCount: number;
  lastExportAt: string | null;
  lastExportChannelCount: number | null;
  /** Channels open (or opening) now that the last backup does not contain. */
  notInBackupCount: number;
  /** Channels in the last backup that have since fully closed. */
  closedSinceExportCount: number;
  stale: boolean;
  reason: string;
}

// ── lightningnetwork.plus ────────────────────────────────────────────────────

export interface LnPlusNode {
  pubkey: string;
  alias: string;
  rank: number;
  rankName: string;
  prime: boolean;
  pro: boolean;
  verified: boolean;
  positiveRatings: number;
  negativeRatings: number;
  positiveGiven: number;
  negativeGiven: number;
  badges: string[];
  openChannels: number;
  capacitySats: number;
  minChannelSizeSats: number;
  profileUrl: string;
}

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

export interface LnPlusPoolNode {
  pubkey: string;
  alias: string;
  creditsBalanceSats: number;
  minChannelSizeSats: number;
  capacitySats: number;
  openChannels: number;
  connection: string;
  clearnetAddress: string;
  torAddress: string;
  rank: number;
  rankName: string;
  positiveRatings: number;
  negativeRatings: number;
  profileUrl: string;
  reachableOverTor: boolean;
  alreadyPeered: boolean;
}

export interface LnPlusSwapParticipant {
  identifier: string;
  pubkey: string;
  alias: string;
  status: string;
  cancelled: boolean;
}

export interface LnPlusSwap {
  id: number;
  url: string;
  status: string;
  statusText: string;
  capacitySats: number;
  durationMonths: number;
  maxParticipants: number;
  appliedParticipants: number;
  openSeats: number;
  requiresPrime: boolean;
  requiresPro: boolean;
  minCapacitySats: number | null;
  minChannelsCount: number | null;
  clearnetAllowed: boolean;
  torAllowed: boolean;
  isPrivate: boolean;
  createdAt: string;
  startsAt: string | null;
  endsAt: string | null;
  participants: LnPlusSwapParticipant[];
  eligibility: { eligible: boolean; blockers: string[] };
}

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

export interface LnPlusPoolResponse {
  nodes: LnPlusPoolNode[];
}
