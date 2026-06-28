/**
 * Security ("node safety") domain types — ported from the Lightning Guardian
 * read-only safety checks. Everything the /security API speaks lives here.
 *
 * These describe a node-safety assessment derived entirely from READ-ONLY LND
 * data: backup health, channel risk, on-chain reserve, payment readiness and
 * node health. No fund-moving and no write calls are ever involved.
 */

export type SecuritySeverity = "healthy" | "warning" | "critical";

export type SecurityCategory =
  | "node_health"
  | "backup_health"
  | "payment_readiness"
  | "channel_risk"
  | "onchain_safety"
  | "liquidity_safety";

// ── Normalized read-only LND snapshot ────────────────────────────────────────

export type LndCallStatus = "ok" | "error" | "skipped";

export type LndCallName =
  | "getWalletInfo"
  | "getChainBalance"
  | "getPendingChainBalance"
  | "getChannelBalance"
  | "getChannels"
  | "getPendingChannels"
  | "getBackups"
  | "getChainFeeRate";

export type LndCallResult = {
  status: LndCallStatus;
  /** Human-readable error (never contains secrets). */
  error?: string;
  /** True when the macaroon lacks permission for this call. */
  permissionDenied?: boolean;
};

export type NormalizedChannel = {
  id: string;
  partnerPublicKey: string;
  alias?: string;
  capacitySat: number;
  localBalanceSat: number;
  remoteBalanceSat: number;
  isActive: boolean;
  isPrivate: boolean;
  isPartnerInitiated: boolean;
  pendingHtlcCount: number;
  unsettledBalanceSat: number;
  /** localBalance / capacity, clamped 0..1. */
  localRatio: number;
};

export type NormalizedPendingChannel = {
  partnerPublicKey: string;
  capacitySat: number;
  localBalanceSat: number;
  remoteBalanceSat: number;
  isOpening: boolean;
  isClosing: boolean;
  isTimelocked: boolean;
  /** A closing channel with funds in timelock looks like a force close. */
  isForceClose: boolean;
};

export type LndNodeInfo = {
  alias?: string;
  pubkey?: string;
  version?: string;
  blockHeight?: number;
  peersCount?: number;
  activeChannelsCount?: number;
  pendingChannelsCount?: number;
  isSyncedToChain?: boolean;
  isSyncedToGraph?: boolean;
};

export type LndBackupInfo = {
  /** The backup export call succeeded. */
  available: boolean;
  /** A static channel backup blob is present and exportable right now. */
  allChannelsScbAvailable: boolean;
  channelCount?: number;
};

export type SecuritySnapshot = {
  /** True when getWalletInfo succeeded — the node answered. */
  reachable: boolean;
  connectionError?: string;
  network: string;
  calls: Record<LndCallName, LndCallResult>;

  info?: LndNodeInfo;

  confirmedChainBalanceSat?: number;
  unconfirmedChainBalanceSat?: number;

  channelBalanceLocalSat?: number;
  channelBalanceRemoteSat?: number;

  channels?: NormalizedChannel[];
  pendingChannels?: NormalizedPendingChannel[];

  backup?: LndBackupInfo;

  feeRateSatPerVbyte?: number;

  collectedAt: string;
};

/** Result of attempting to export a static channel backup (read-only). */
export type ScbExportResult = {
  ok: boolean;
  backupHex?: string;
  channelCount?: number;
  exportedAt?: string;
  error?: string;
};

// ── Score ────────────────────────────────────────────────────────────────────

export type SecurityCategoryScore = {
  score: number;
  severity: SecuritySeverity;
  reasons: string[];
  warnings: string[];
};

export type SecurityScore = {
  score: number;
  severity: SecuritySeverity;
  summary: string;
  categories: {
    nodeHealth: SecurityCategoryScore;
    backupHealth: SecurityCategoryScore;
    paymentReadiness: SecurityCategoryScore;
    channelRisk: SecurityCategoryScore;
    onchainSafety: SecurityCategoryScore;
    liquiditySafety: SecurityCategoryScore;
  };
  criticalIssues: SecurityIssue[];
  warnings: SecurityIssue[];
  recommendations: SecurityRecommendation[];
  lastUpdatedAt: string;
};

// ── Node health ───────────────────────────────────────────────────────────────

export type NodeHealthStatus = {
  lndReachable: boolean;
  lndSyncedToChain?: boolean;
  lndSyncedToGraph?: boolean;
  bitcoinBackendReachable?: boolean;
  bitcoinSynced?: boolean;
  blockHeight?: number;
  peersCount?: number;
  alias?: string;
  pubkey?: string;
  version?: string;
  severity: SecuritySeverity;
  reasons: string[];
  warnings: string[];
};

// ── Backup watchdog ────────────────────────────────────────────────────────────

export type BackupHealthState =
  | "current"
  | "stale"
  | "missing"
  | "unknown"
  | "needs_export_after_channel_change";

export type BackupHealthStatus = {
  state: BackupHealthState;
  severity: SecuritySeverity;

  lastBackupAt?: string;
  lastKnownChannelCount?: number;
  currentChannelCount: number;

  channelChangesSinceLastBackup?: {
    opened: number;
    closed: number;
    pending: number;
  };

  canExportScb: boolean;
  exportedBackupAvailable?: boolean;

  reasons: string[];
  warnings: string[];
  recommendations: SecurityRecommendation[];
};

// ── Payment readiness ──────────────────────────────────────────────────────────

export type PaymentReadinessStatus = {
  canLikelySend: boolean;
  canLikelyReceive: boolean;

  maxSendEstimateSat: number;
  maxReceiveEstimateSat: number;

  totalLocalBalanceSat: number;
  totalRemoteBalanceSat: number;
  activeChannelCount: number;
  inactiveChannelCount: number;

  inboundLiquiditySat: number;
  outboundLiquiditySat: number;

  severity: SecuritySeverity;
  reasons: string[];
  warnings: string[];
};

// ── Channel risk ───────────────────────────────────────────────────────────────

export type ChannelRiskType =
  | "inactive"
  | "disabled"
  | "pending_htlc"
  | "pending_close"
  | "force_close"
  | "severe_imbalance"
  | "low_liquidity"
  | "dead_capital"
  | "negative_pnl"
  | "close_candidate";

export type ChannelRisk = {
  channelId: string;
  alias?: string;
  capacitySat: number;
  localRatio: number;

  riskLevel: SecuritySeverity;
  riskTypes: ChannelRiskType[];

  reasons: string[];
  recommendations: SecurityRecommendation[];
};

export type ChannelRiskStatus = {
  activeChannelCount: number;
  inactiveChannelCount: number;
  pendingOpenCount?: number;
  pendingCloseCount?: number;
  forceCloseCount?: number;

  riskyChannels: ChannelRisk[];
  severity: SecuritySeverity;
  reasons: string[];
  warnings: string[];
};

// ── On-chain safety ────────────────────────────────────────────────────────────

export type OnchainSafetyStatus = {
  confirmedBalanceSat: number;
  unconfirmedBalanceSat: number;
  recommendedReserveSat: number;
  reserveRatio: number;

  estimatedForceCloseCostSat?: number;
  feeRateSatPerVbyte?: number;

  severity: SecuritySeverity;
  reasons: string[];
  warnings: string[];
};

// ── Liquidity safety ───────────────────────────────────────────────────────────

export type LiquidityNodeNeed =
  | "need_inbound"
  | "need_outbound"
  | "need_routing_diversity"
  | "need_revenue"
  | "balanced";

export type LiquiditySafetyStatus = {
  inboundSat: number;
  outboundSat: number;
  inboundRatio: number;
  outboundRatio: number;

  maxReceiveEstimateSat: number;
  maxSendEstimateSat: number;

  concentration: {
    largestLocalChannelShare: number;
    largestRemoteChannelShare: number;
  };

  nodeNeed?: LiquidityNodeNeed;

  severity: SecuritySeverity;
  reasons: string[];
  warnings: string[];
  recommendations: SecurityRecommendation[];
};

// ── Issues & recommendations ────────────────────────────────────────────────────

export type SecurityIssue = {
  id: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  description: string;
  affectedChannels?: string[];
  reasons: string[];
  createdAt: string;
};

export type SecurityRecommendationPriority = "low" | "medium" | "high" | "urgent";

export type SecurityActionType =
  | "export_backup"
  | "review_channels"
  | "buy_inbound"
  | "open_channel"
  | "close_channel"
  | "rebalance"
  | "adjust_fees"
  | "increase_onchain_reserve"
  | "check_node"
  | "manual";

export type SecurityRecommendation = {
  id: string;
  category: SecurityCategory;
  priority: SecurityRecommendationPriority;
  title: string;
  description: string;
  actionType: SecurityActionType;

  relatedChannelIds?: string[];
  reasons: string[];
  warnings: string[];
};

// ── Aggregated API response ─────────────────────────────────────────────────────

export type SecuritySummary = {
  score: SecurityScore;

  nodeHealth: NodeHealthStatus;
  backupHealth: BackupHealthStatus;
  paymentReadiness: PaymentReadinessStatus;
  channelRisk: ChannelRiskStatus;
  onchainSafety: OnchainSafetyStatus;
  liquiditySafety: LiquiditySafetyStatus;

  issues: SecurityIssue[];
  recommendations: SecurityRecommendation[];

  /** Per-LND-call status, so the UI can flag missing read permissions. */
  dataAvailability: {
    lndReachable: boolean;
    connectionError?: string;
    network: string;
    calls: Record<string, { status: string; error?: string; permissionDenied?: boolean }>;
  };

  generatedAt: string;
};
