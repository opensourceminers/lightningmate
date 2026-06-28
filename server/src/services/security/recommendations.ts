import type {
  BackupHealthStatus,
  ChannelRiskStatus,
  LiquiditySafetyStatus,
  NodeHealthStatus,
  OnchainSafetyStatus,
  PaymentReadinessStatus,
  SecurityRecommendation,
  SecurityRecommendationPriority,
} from "./types.js";
import { formatSat, makeRecommendation } from "./util.js";

const PRIORITY_RANK: Record<SecurityRecommendationPriority, number> = {
  urgent: 3,
  high: 2,
  medium: 1,
  low: 0,
};

export type GenerateRecommendationsInput = {
  nodeHealth: NodeHealthStatus;
  backupHealth: BackupHealthStatus;
  paymentReadiness: PaymentReadinessStatus;
  channelRisk: ChannelRiskStatus;
  onchainSafety: OnchainSafetyStatus;
  liquiditySafety: LiquiditySafetyStatus;
};

/**
 * Aggregate recommendations from every category, de-duplicate by id, and sort
 * by priority (most urgent first).
 */
export function generateRecommendations(
  input: GenerateRecommendationsInput,
): SecurityRecommendation[] {
  const collected: SecurityRecommendation[] = [];

  if (!input.nodeHealth.lndReachable) {
    collected.push(
      makeRecommendation({
        id: "rec-check-node",
        category: "node_health",
        priority: "urgent",
        title: "Check your LND node",
        description:
          "LND cannot be reached. Verify the node is running, the gRPC host is correct, and the TLS cert and read-only macaroon are readable.",
        actionType: "check_node",
      }),
    );
  } else if (input.nodeHealth.lndSyncedToChain === false) {
    collected.push(
      makeRecommendation({
        id: "rec-check-node-sync",
        category: "node_health",
        priority: "high",
        title: "Wait for chain sync",
        description: "LND is not synced to the blockchain. Check the Bitcoin backend and let the node catch up.",
        actionType: "check_node",
      }),
    );
  }

  collected.push(...input.backupHealth.recommendations);
  collected.push(...input.liquiditySafety.recommendations);

  for (const c of input.channelRisk.riskyChannels) {
    collected.push(...c.recommendations);
  }

  if (input.onchainSafety.severity !== "healthy") {
    collected.push(
      makeRecommendation({
        id: "rec-increase-onchain-reserve",
        category: "onchain_safety",
        priority: input.onchainSafety.severity === "critical" ? "high" : "medium",
        title: "Increase on-chain reserve",
        description: `Keep at least ${formatSat(input.onchainSafety.recommendedReserveSat)} confirmed on-chain so you can pay fees, including to sweep funds after a force close.`,
        actionType: "increase_onchain_reserve",
      }),
    );
  }

  const seen = new Set<string>();
  const deduped = collected.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  deduped.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
  return deduped;
}
