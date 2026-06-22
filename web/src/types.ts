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
  channelEnabled: boolean;
  channelReserveSats: number;
  channelSizeSats: number;
  channelCooldownMinutes: number;
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

export interface AutopilotRun {
  at: string;
  attempted: number;
  applied: number;
  failed: number;
  changes: AutopilotChange[];
  rebalances: AutopilotRebalance[];
  channels: AutopilotChannelOpen[];
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

export interface NetworkRank {
  position: number;
  total: number;
  percentile: number;
  degree: number;
}

export interface ScoreComponent {
  key: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface NodeScore {
  score: number;
  grade: string;
  components: ScoreComponent[];
  rank: NetworkRank | null;
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
