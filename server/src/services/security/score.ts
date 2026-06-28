import type { SecurityConfig } from "./config.js";
import type {
  BackupHealthStatus,
  ChannelRiskStatus,
  LiquiditySafetyStatus,
  NodeHealthStatus,
  OnchainSafetyStatus,
  PaymentReadinessStatus,
  SecurityCategoryScore,
  SecurityIssue,
  SecurityRecommendation,
  SecurityScore,
  SecuritySeverity,
} from "./types.js";
import { clampScore, severityFromScore, severityRank, worstSeverity } from "./util.js";

type StatusLike = {
  severity: SecuritySeverity;
  reasons?: string[];
  warnings?: string[];
};

/** Map a category status to a 0..100 score using its severity + warning count. */
function categoryScore(status: StatusLike): SecurityCategoryScore {
  const warnings = status.warnings ?? [];
  const reasons = status.reasons ?? [];
  const w = warnings.length;

  let score: number;
  if (status.severity === "critical") {
    score = clampScore(40 - Math.min(w, 3) * 2);
  } else if (status.severity === "warning") {
    score = clampScore(72 - Math.min(w, 4) * 4);
  } else {
    score = clampScore(100 - Math.min(w, 3) * 2);
  }

  return { score, severity: status.severity, reasons, warnings };
}

const CATEGORY_LABELS = {
  nodeHealth: "node health",
  backupHealth: "backup verification",
  paymentReadiness: "payment readiness",
  channelRisk: "channel risk",
  onchainSafety: "on-chain reserve",
  liquiditySafety: "liquidity",
} as const;

type CategoryKey = keyof typeof CATEGORY_LABELS;

export type ComputeScoreInput = {
  nodeHealth: NodeHealthStatus;
  backupHealth: BackupHealthStatus;
  paymentReadiness: PaymentReadinessStatus;
  channelRisk: ChannelRiskStatus;
  onchainSafety: OnchainSafetyStatus;
  liquiditySafety: LiquiditySafetyStatus;
  issues: SecurityIssue[];
  recommendations: SecurityRecommendation[];
  config: SecurityConfig;
  now?: Date;
};

/**
 * Compute the overall Security Score (0–100) and severity.
 *
 * Overall severity follows the score thresholds, but is bumped to at least
 * `warning` when any warning exists and to `critical` when any critical issue
 * exists — a green number never hides a red problem.
 */
export function computeSecurityScore(input: ComputeScoreInput): SecurityScore {
  const { config } = input;
  const now = input.now ?? new Date();

  const categories = {
    nodeHealth: categoryScore(input.nodeHealth),
    backupHealth: categoryScore(input.backupHealth),
    paymentReadiness: categoryScore(input.paymentReadiness),
    channelRisk: categoryScore(input.channelRisk),
    onchainSafety: categoryScore(input.onchainSafety),
    liquiditySafety: categoryScore(input.liquiditySafety),
  };

  const weights = config.scoreWeights;
  const overallRaw =
    categories.nodeHealth.score * weights.nodeHealth +
    categories.backupHealth.score * weights.backupHealth +
    categories.paymentReadiness.score * weights.paymentReadiness +
    categories.channelRisk.score * weights.channelRisk +
    categories.onchainSafety.score * weights.onchainSafety +
    categories.liquiditySafety.score * weights.liquiditySafety;

  const score = clampScore(overallRaw);
  const thresholdSeverity = severityFromScore(score, config.severityThresholds);

  const criticalIssues = input.issues.filter((i) => i.severity === "critical");
  const warningIssues = input.issues.filter((i) => i.severity === "warning");

  const categorySeverities = (Object.keys(categories) as CategoryKey[]).map(
    (k) => categories[k].severity,
  );
  const hasCritical = criticalIssues.length > 0 || categorySeverities.includes("critical");
  const hasWarning = warningIssues.length > 0 || categorySeverities.includes("warning");

  const issueSeverity: SecuritySeverity = hasCritical
    ? "critical"
    : hasWarning
      ? "warning"
      : "healthy";

  const severity = worstSeverity([thresholdSeverity, issueSeverity]);

  const worstCategory = (Object.keys(categories) as CategoryKey[])
    .map((k) => ({ key: k, ...categories[k] }))
    .sort((a, b) => {
      const sev = severityRank(b.severity) - severityRank(a.severity);
      return sev !== 0 ? sev : a.score - b.score;
    })[0];

  let summary: string;
  if (severity === "healthy") {
    summary = "Your node looks healthy, online and ready to send and receive payments.";
  } else if (severity === "warning") {
    summary = `Your node looks healthy overall, but ${CATEGORY_LABELS[worstCategory.key]} needs attention.`;
  } else {
    summary = `Action needed — ${CATEGORY_LABELS[worstCategory.key]} is at risk. Review the critical issues below.`;
  }

  return {
    score,
    severity,
    summary,
    categories,
    criticalIssues,
    warnings: warningIssues,
    recommendations: input.recommendations,
    lastUpdatedAt: now.toISOString(),
  };
}
