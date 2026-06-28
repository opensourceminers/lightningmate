import type {
  BackupHealthStatus,
  ChannelRiskStatus,
  LiquiditySafetyStatus,
  NodeHealthStatus,
  OnchainSafetyStatus,
  PaymentReadinessStatus,
  SecurityCategory,
  SecurityIssue,
  SecuritySeverity,
} from "./types.js";
import { severityRank } from "./util.js";

type StatusLike = {
  severity: SecuritySeverity;
  reasons?: string[];
  warnings?: string[];
};

function issueFor(
  category: SecurityCategory,
  status: StatusLike,
  titles: { warning: string; critical: string },
  createdAt: string,
  affectedChannels?: string[],
): SecurityIssue | null {
  if (status.severity === "healthy") return null;
  const all = [...(status.reasons ?? []), ...(status.warnings ?? [])];
  return {
    id: `issue-${category}`,
    category,
    severity: status.severity,
    title: status.severity === "critical" ? titles.critical : titles.warning,
    description: all[0] ?? titles[status.severity],
    affectedChannels: affectedChannels && affectedChannels.length ? affectedChannels : undefined,
    reasons: all,
    createdAt,
  };
}

export type GenerateIssuesInput = {
  nodeHealth: NodeHealthStatus;
  backupHealth: BackupHealthStatus;
  paymentReadiness: PaymentReadinessStatus;
  channelRisk: ChannelRiskStatus;
  onchainSafety: OnchainSafetyStatus;
  liquiditySafety: LiquiditySafetyStatus;
  now?: Date;
};

/**
 * Build the flat list of issues shown on the Security tab. One aggregate issue
 * per category that is not healthy, sorted most-severe first.
 */
export function generateIssues(input: GenerateIssuesInput): SecurityIssue[] {
  const createdAt = (input.now ?? new Date()).toISOString();

  const affectedChannels = input.channelRisk.riskyChannels.map((c) => c.channelId);

  const candidates: (SecurityIssue | null)[] = [
    issueFor(
      "node_health",
      input.nodeHealth,
      { warning: "Node health needs attention", critical: "Node is offline or not synced" },
      createdAt,
    ),
    issueFor(
      "backup_health",
      input.backupHealth,
      { warning: "Channel backup needs attention", critical: "Channel backup is at risk" },
      createdAt,
    ),
    issueFor(
      "payment_readiness",
      input.paymentReadiness,
      { warning: "Payment readiness is reduced", critical: "Node cannot transact" },
      createdAt,
    ),
    issueFor(
      "channel_risk",
      input.channelRisk,
      { warning: "Channel risk detected", critical: "Critical channel risk" },
      createdAt,
      affectedChannels,
    ),
    issueFor(
      "onchain_safety",
      input.onchainSafety,
      { warning: "On-chain reserve is low", critical: "On-chain reserve is critically low" },
      createdAt,
    ),
    issueFor(
      "liquidity_safety",
      input.liquiditySafety,
      { warning: "Liquidity needs attention", critical: "Liquidity is critically constrained" },
      createdAt,
    ),
  ];

  return candidates
    .filter((i): i is SecurityIssue => i !== null)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
}
