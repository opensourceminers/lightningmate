import type { SecurityConfig } from "./config.js";
import { evaluateNodeHealth } from "./nodeHealth.js";
import { evaluateBackupHealth } from "./backupHealth.js";
import { evaluatePaymentReadiness } from "./paymentReadiness.js";
import { evaluateChannelRisk } from "./channelRisk.js";
import { evaluateOnchainSafety } from "./onchainSafety.js";
import { evaluateLiquiditySafety } from "./liquiditySafety.js";
import { generateIssues } from "./issues.js";
import { generateRecommendations } from "./recommendations.js";
import { computeSecurityScore } from "./score.js";
import type { SecuritySnapshot, SecuritySummary } from "./types.js";

export type ComputeSummaryInput = {
  snapshot: SecuritySnapshot;
  persisted: {
    lastBackupAt?: string;
    lastKnownChannelCount?: number;
  };
  config: SecurityConfig;
  now?: Date;
};

/**
 * Pure summary computation — no I/O. Given a snapshot, persisted state and
 * config, run every evaluator and assemble the full Security-tab response.
 */
export function computeSecuritySummary(input: ComputeSummaryInput): SecuritySummary {
  const { snapshot, persisted, config } = input;
  const now = input.now ?? new Date();

  const nodeHealth = evaluateNodeHealth(snapshot);
  const backupHealth = evaluateBackupHealth(
    snapshot,
    config,
    {
      lastBackupAt: persisted.lastBackupAt,
      lastKnownChannelCount: persisted.lastKnownChannelCount,
    },
    now,
  );
  const paymentReadiness = evaluatePaymentReadiness(snapshot, config);
  const channelRisk = evaluateChannelRisk(snapshot, config);
  const onchainSafety = evaluateOnchainSafety(snapshot, config);
  const liquiditySafety = evaluateLiquiditySafety(snapshot, config);

  const issues = generateIssues({
    nodeHealth,
    backupHealth,
    paymentReadiness,
    channelRisk,
    onchainSafety,
    liquiditySafety,
    now,
  });

  const recommendations = generateRecommendations({
    nodeHealth,
    backupHealth,
    paymentReadiness,
    channelRisk,
    onchainSafety,
    liquiditySafety,
  });

  const score = computeSecurityScore({
    nodeHealth,
    backupHealth,
    paymentReadiness,
    channelRisk,
    onchainSafety,
    liquiditySafety,
    issues,
    recommendations,
    config,
    now,
  });

  return {
    score,
    nodeHealth,
    backupHealth,
    paymentReadiness,
    channelRisk,
    onchainSafety,
    liquiditySafety,
    issues,
    recommendations,
    dataAvailability: {
      lndReachable: snapshot.reachable,
      connectionError: snapshot.connectionError,
      network: snapshot.network,
      calls: snapshot.calls,
    },
    generatedAt: now.toISOString(),
  };
}
