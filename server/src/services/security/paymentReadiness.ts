import type { SecurityConfig } from "./config.js";
import type {
  NormalizedChannel,
  PaymentReadinessStatus,
  SecuritySnapshot,
  SecuritySeverity,
} from "./types.js";
import { formatSat, safeRatio, worstSeverity } from "./util.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);

/**
 * Payment readiness — can the node likely send and receive right now, and how
 * much? Uses a simple per-channel liquidity approximation (max single-channel
 * balance bounds a single payment).
 */
export function evaluatePaymentReadiness(
  snapshot: SecuritySnapshot,
  config: SecurityConfig,
): PaymentReadinessStatus {
  const cfg = config.paymentReadiness;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const severities: SecuritySeverity[] = ["healthy"];

  const channels: NormalizedChannel[] | undefined = snapshot.channels;

  if (!Array.isArray(channels)) {
    return {
      canLikelySend: false,
      canLikelyReceive: false,
      maxSendEstimateSat: 0,
      maxReceiveEstimateSat: 0,
      totalLocalBalanceSat: 0,
      totalRemoteBalanceSat: 0,
      activeChannelCount: 0,
      inactiveChannelCount: 0,
      inboundLiquiditySat: 0,
      outboundLiquiditySat: 0,
      severity: snapshot.reachable ? "warning" : "critical",
      reasons: [],
      warnings: ["Channel data is unavailable, so payment readiness cannot be evaluated."],
    };
  }

  const active = channels.filter((c) => c.isActive);
  const inactive = channels.filter((c) => !c.isActive);

  const outboundLiquiditySat = sum(active.map((c) => c.localBalanceSat));
  const inboundLiquiditySat = sum(active.map((c) => c.remoteBalanceSat));
  const maxSendEstimateSat = max(active.map((c) => c.localBalanceSat));
  const maxReceiveEstimateSat = max(active.map((c) => c.remoteBalanceSat));
  const totalLocalBalanceSat = sum(channels.map((c) => c.localBalanceSat));
  const totalRemoteBalanceSat = sum(channels.map((c) => c.remoteBalanceSat));

  const canLikelySend = active.length > 0 && maxSendEstimateSat > 0;
  const canLikelyReceive = active.length > 0 && maxReceiveEstimateSat > 0;

  if (channels.length === 0) {
    reasons.push("No channels yet — open a channel to start sending and receiving payments.");
    return {
      canLikelySend,
      canLikelyReceive,
      maxSendEstimateSat,
      maxReceiveEstimateSat,
      totalLocalBalanceSat,
      totalRemoteBalanceSat,
      activeChannelCount: 0,
      inactiveChannelCount: 0,
      inboundLiquiditySat,
      outboundLiquiditySat,
      severity: "healthy",
      reasons,
      warnings,
    };
  }

  if (active.length === 0) {
    severities.push("warning");
    warnings.push("No active channels. The node cannot currently send or receive Lightning payments.");
  } else {
    if (canLikelySend && canLikelyReceive) {
      reasons.push("Node can likely send and receive payments.");
    } else if (canLikelySend) {
      reasons.push("Node can likely send, but inbound liquidity for receiving is limited.");
    } else if (canLikelyReceive) {
      reasons.push("Node can likely receive, but outbound liquidity for sending is limited.");
    }

    if (outboundLiquiditySat < cfg.lowOutboundThresholdSat) {
      severities.push("warning");
      warnings.push(`Low outbound liquidity (${formatSat(outboundLiquiditySat)}). Sending capacity is limited.`);
    }
    if (inboundLiquiditySat < cfg.lowInboundThresholdSat) {
      severities.push("warning");
      warnings.push(`Low inbound liquidity (${formatSat(inboundLiquiditySat)}). Receiving capacity is limited.`);
    }
    if (maxSendEstimateSat < cfg.lowMaxSendThresholdSat) {
      severities.push("warning");
      warnings.push(`Largest single payment you can send is small (${formatSat(maxSendEstimateSat)}).`);
    }
    if (maxReceiveEstimateSat < cfg.lowMaxReceiveThresholdSat) {
      severities.push("warning");
      warnings.push(`Largest single payment you can receive is small (${formatSat(maxReceiveEstimateSat)}).`);
    }

    if (active.length > 1 && outboundLiquiditySat > 0) {
      const largestLocalShare = safeRatio(maxSendEstimateSat, outboundLiquiditySat);
      if (largestLocalShare > cfg.concentrationWarningRatio) {
        severities.push("warning");
        warnings.push(
          `Outbound liquidity is concentrated: one channel holds ${(largestLocalShare * 100).toFixed(0)}% of your sending balance.`,
        );
      }
    }
  }

  return {
    canLikelySend,
    canLikelyReceive,
    maxSendEstimateSat,
    maxReceiveEstimateSat,
    totalLocalBalanceSat,
    totalRemoteBalanceSat,
    activeChannelCount: active.length,
    inactiveChannelCount: inactive.length,
    inboundLiquiditySat,
    outboundLiquiditySat,
    severity: worstSeverity(severities),
    reasons,
    warnings,
  };
}
