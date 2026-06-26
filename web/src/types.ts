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

export interface ChannelSuggestion {
  pubkey: string;
  alias: string;
  channels: number;
  capacitySats: number;
  avgFeePpm: number;
  hasClearnet: boolean;
  lastSeenDays: number;
  newReach: number;
  score: number;
  recommendedSizeSats: number;
  reason: string;
  socket: string;
}

export interface CloseCandidate {
  channelId: string;
  alias: string;
  capacitySats: number;
  localRatio: number;
  active: boolean;
  forwards: number;
  routedSats: number;
  feesEarnedSats: number;
  lifetimeRoutedSats: number;
  transactionId: string;
  transactionVout: number;
  reason: string;
}

export interface CloseCandidatesResponse {
  windowDays: number;
  candidates: CloseCandidate[];
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
  suggestions: ChannelSuggestion[];
  graphAgeSec: number;
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
  rebalanceCostSats: number;
  rebalanceCount: number;
  channelOpenCostSats: number;
  channelCloseCostSats: number;
  otherChainFeesSats: number;
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
