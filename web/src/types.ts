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
  role: ChannelRole;
}

export interface ChannelFlow {
  channelId: string;
  routedOut: number;
  routedIn: number;
  feesEarned: number;
  forwardCount: number;
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
}

export interface ChannelForwardStat {
  channelId: string;
  alias: string;
  forwardCount: number;
  routedOutSats: number;
  routedInSats: number;
  feesEarnedSats: number;
  spark: number[];
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

export interface ForwardsReport {
  windowDays: number;
  totalForwards: number;
  totalRoutedSats: number;
  totalFeesEarnedSats: number;
  avgFeePpm: number;
  maxForwardSats: number;
  busiestDay: string | null;
  perChannel: ChannelForwardStat[];
  daily: DailyBucket[];
  recent: ResolvedForward[];
}

export interface FeePolicy {
  minPpm: number;
  maxPpm: number;
  baseFeeMsat: number;
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
  feeRatePpm: number;
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
  channelEnabled: boolean;
  channelReserveSats: number;
  channelSizeSats: number;
  channelCooldownMinutes: number;
  sellEnabled: boolean;
  sellMaxDeploySats: number;
  sellReserveSats: number;
  sellMaxChannelSats: number;
  sellAutoClose: boolean;
  sellAutoRelist: boolean;
  sellAutoReprice: boolean;
  sellPricingMode: "fast" | "balanced" | "premium" | "auto";
}

export interface AutopilotChange {
  id: string;
  alias: string;
  fromPpm: number;
  toPpm: number;
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
  action: "accept" | "open" | "close" | "skip";
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
}

export interface AutopilotState {
  canWrite: boolean;
  config: AutopilotConfig;
  lastRunAt: string | null;
  history: AutopilotRun[];
}

export interface RebalancePolicy {
  econRatio: number;
  maxLocalRatioTarget: number;
  minLocalRatioSource: number;
  amountSats: number;
  minDemandSats: number;
  flowWindowDays: number;
  maxCandidates: number;
}

export interface RebalanceCandidate {
  targetId: string;
  targetAlias: string;
  targetLocalRatio: number;
  targetOutboundPpm: number;
  demandSats: number;
  sourceId: string;
  sourceAlias: string;
  sourceLocalRatio: number;
  amountSats: number;
  maxFeePpm: number;
  estCostPpm: number | null;
  estFeeSats: number | null;
  netMarginPpm: number | null;
  expectedProfitSats: number | null;
  routeFound: boolean;
  profitable: boolean;
  verdict: string;
}

export interface RebalanceAnalysis {
  policy: RebalancePolicy;
  candidates: RebalanceCandidate[];
}

export interface RebalanceExecResult {
  ok: boolean;
  targetId: string;
  targetAlias: string;
  sourceId: string;
  sourceAlias: string;
  amountSats: number;
  budgetPpm: number;
  feeSats: number | null;
  costPpm: number | null;
  error?: string;
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
}

export interface RebalanceLogSummary {
  count: number;
  failed: number;
  totalFeeSats: number;
  totalAmountSats: number;
  avgCostPpm: number;
}

export interface RebalanceLogResponse {
  summary: RebalanceLogSummary;
  records: RebalanceRecord[];
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
  pnl60dSats: number;
  flow60dSats: number;
  forwards60d: number;
  ageDays: number | null;
  reachContribution: number;
  uniqueReachLost: number;
  feeV2State: string;
  opportunityCandidates: { alias: string; score: number; sizeSats: number }[];
  reasons: string[];
  warnings: string[];
}

export interface CloseCandidatesResponse {
  windowDays: number;
  candidates: CloseCandidate[];
  protectedCount: number;
  totalCapitalFreedSats: number;
}

export interface OpenChannelResult {
  ok: boolean;
  pubkey: string;
  localTokens: number;
  transactionId?: string;
  transactionVout?: number;
  error?: string;
}

export interface SuggestionsResponse {
  policy: SuggestionPolicy;
  nodeNeed: NodeNeed;
  nodeNeedReason: string;
  hasDemandData: boolean;
  suggestions: ChannelSuggestion[];
  graphAgeSec: number;
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
}

export interface CloseChannelResult {
  ok: boolean;
  transactionId?: string;
  error?: string;
}

export type FiatCurrency = "off" | "USD" | "EUR" | "GBP" | "CHF";

export interface AppSettings {
  fiatCurrency: FiatCurrency;
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
}

export interface OnchainTx {
  id: string;
  amountSats: number;
  feeSats: number;
  confirmations: number;
  isConfirmed: boolean;
  isOutgoing: boolean;
  createdAt: string;
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
export type ActivityKind = "forward" | "received" | "sent" | "onchain_in" | "onchain_out";

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
  feesSpark: number[];
  forwardsSpark: number[];
  routedSpark: number[];
  rebalancedCount: number;
  rebalancedSats: number;
  activity: ActivityItem[];
  autopilot: {
    fees: boolean;
    rebalance: boolean;
    channel: boolean;
    sell: boolean;
    lastRunAt: string | null;
    lastApplied: number;
    lastAttempted: number;
  };
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
  score: number;
  weight: number;
  detail: string;
  hint: string;
}

export interface NodeScore {
  score: number;
  grade: string;
  categories: ScoreCategory[];
  rank: NetworkRank | null;
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
  costBasisPpm: number | null;
  costBasisSource: "rebalance_avg" | "unknown";
  profitFloorPpm: number | null;
  peerGate: "ok" | "weak";
  role: string;
  isTopEarner: boolean;
  benchmarkComparison: "above" | "median" | "below";
}

export interface FeeRecommendation {
  channelId: string;
  alias: string;
  capacity: number;
  currentPpm: number;
  targetPpm: number;
  transactionId: string | null;
  transactionVout: number | null;
  currentBaseMsat: number;
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
  reason: string;
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
  feeV2TargetPpm: number | null;
  feeV2State: string | null;
  profitFloorPpm: number | null;
  routedOut14d: number;
  routedIn14d: number;
  routedOut30d: number;
  routedIn30d: number;
  netDrain14d: number;
  grossFlow14d: number;
  revenue14d: number;
  revenue30d: number;
  revenuePpm14d: number | null;
  revenuePpm30d: number | null;
  expectedRevenuePpm: number | null;
  avgDailyRevenueSats: number;
  maxCostPpm: number | null;
  maxCostSatsByPayback: number | null;
  maxPaybackDays: number;
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

export interface InboundOptions {
  magmaCheapestPpm: number | null;
  rebalanceTypicalPpm: number | null;
  cheapest: "rebalance" | "magma" | "fee_first" | "none";
  note: string;
}

export interface RebalanceRecReport {
  generatedAt: string;
  summary: RebalanceRecSummary;
  inbound: InboundOptions;
  recommendations: RebalanceRecommendation[];
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
  magmaRevenueSats: number;
  magmaSaleCount: number;
  rebalanceCostSats: number;
  rebalanceCount: number;
  channelOpenCostSats: number;
  channelCloseCostSats: number;
  otherChainFeesSats: number;
  serviceFeePaidSats: number;
  totalCostSats: number;
  netProfitSats: number;
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
}

export interface MarketView {
  offers: MagmaOffer[];
  satsPerUsd: number | null;
}

export interface BuyQuote {
  orderId: string;
  paymentRequest: string;
  sats: number;
  channelSizeSats: number;
}

export interface OrderState {
  status: string;
  paymentStatus: string | null;
  channelId: string | null;
  channelSizeSats: number;
  done: boolean;
  failed: boolean;
  payment: { state: "paying" | "paid" | "failed"; error?: string; feeSats?: number } | null;
}

export interface MyOffer {
  id: string;
  status: string;
  minSizeSats: number;
  maxSizeSats: number;
  totalSizeSats: number;
  baseFeeSats: number;
  feeRatePpm: number;
  minBlockLength: number;
}

export interface MyOrder {
  id: string;
  status: string;
  side: string;
  sizeSats: number;
  feeSats: number;
  destination: string;
  paymentStatus: string | null;
  channelId: string | null;
  createdAt: string;
}

export interface MyOrdersView {
  orders: MyOrder[];
  pendingSeller: number;
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

export interface MagmaSellRecommendation {
  offerId: string | null;
  mode: "create" | "update" | "hold";
  state: MagmaSellOfferState;
  shouldReprice: boolean;
  repriceDirection: "up" | "down" | "none";
  current: { feeRatePpm: number; baseFeeSat: number; effectiveFeePpm: number } | null;
  recommended: PricePoint & { minBlockLength: number; sizeSat: number };
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
    scorePremium: number;
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
  beforeDailyAvgSat: number;
  afterDailyAvgSat: number;
  deltaPct: number | null;
}
export interface RebalanceOutcome {
  targetId: string;
  alias: string;
  at: string;
  costSats: number;
  revenueAfterSats: number;
  earnedBackPct: number;
  netSats: number;
  paidBack: boolean;
}
export interface OutcomesReport {
  measureWindowDays: number;
  fees: { measured: number; raises: number; cuts: number; avgRevenueDeltaPct: number | null; items: FeeOutcome[] };
  rebalances: {
    measured: number;
    totalCostSats: number;
    totalEarnedBackSats: number;
    avgEarnedBackPct: number | null;
    paidBackCount: number;
    netSats: number;
    items: RebalanceOutcome[];
  };
}

export interface MagmaV2Report {
  nodeNeed: NodeNeed;
  nodeNeedReason: string;
  hasRoutingData: boolean;
  satsPerUsd: number | null;
  sell: {
    state:
      | "good_to_sell"
      | "sell_only_above_profit_floor"
      | "market_too_cheap"
      | "insufficient_capital"
      | "not_recommended_node_needs_inbound";
    deployableCapitalSat: number;
    recommendedSellSizeSat: number | null;
    routingOpportunityPpmPerYear: number | null;
    adjustedRoutingPpmPerYear: number;
    recommendedMinLeasePpmPerYear: number;
    pricingMode: "fast" | "balanced" | "premium" | "auto";
    adaptiveLevel: number;
    optimalSizeSat: number;
    optimalLeaseBlocks: number;
    projectedMonthlySat: number;
    onchainOpenCostSat: number;
    onchainCloseCostSat: number;
    onchainFeePerVbyte: number | null;
    pendingSellerOrders: number;
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
  currentChannelCount: number;
  lastExportAt: string | null;
  lastExportChannelCount: number | null;
  stale: boolean;
  reason: string;
}
