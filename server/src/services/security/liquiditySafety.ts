import type { SecurityConfig } from "./config.js";
import type {
  LiquidityNodeNeed,
  LiquiditySafetyStatus,
  NormalizedChannel,
  SecuritySnapshot,
  SecurityRecommendation,
  SecuritySeverity,
} from "./types.js";
import { formatSat, makeRecommendation, safeRatio, worstSeverity } from "./util.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : 0);

/**
 * Liquidity safety — an aggregated inbound/outbound view with a simple
 * "what does this node need" heuristic.
 */
export function evaluateLiquiditySafety(
  snapshot: SecuritySnapshot,
  config: SecurityConfig,
): LiquiditySafetyStatus {
  const cfg = config.liquiditySafety;
  const concentrationRatio = config.paymentReadiness.concentrationWarningRatio;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const recommendations: SecurityRecommendation[] = [];
  const severities: SecuritySeverity[] = ["healthy"];

  const channels: NormalizedChannel[] | undefined = snapshot.channels;

  if (!Array.isArray(channels)) {
    return {
      inboundSat: 0,
      outboundSat: 0,
      inboundRatio: 0,
      outboundRatio: 0,
      maxReceiveEstimateSat: 0,
      maxSendEstimateSat: 0,
      concentration: { largestLocalChannelShare: 0, largestRemoteChannelShare: 0 },
      severity: snapshot.reachable ? "warning" : "critical",
      reasons: [],
      warnings: ["Channel data is unavailable, so liquidity safety cannot be evaluated."],
      recommendations: [],
    };
  }

  const active = channels.filter((c) => c.isActive);
  const inboundSat = sum(active.map((c) => c.remoteBalanceSat));
  const outboundSat = sum(active.map((c) => c.localBalanceSat));
  const total = inboundSat + outboundSat;
  const inboundRatio = safeRatio(inboundSat, total);
  const outboundRatio = safeRatio(outboundSat, total);
  const maxReceiveEstimateSat = max(active.map((c) => c.remoteBalanceSat));
  const maxSendEstimateSat = max(active.map((c) => c.localBalanceSat));

  const concentration = {
    largestLocalChannelShare: safeRatio(maxSendEstimateSat, outboundSat),
    largestRemoteChannelShare: safeRatio(maxReceiveEstimateSat, inboundSat),
  };

  if (channels.length === 0) {
    reasons.push("No channels yet — open channels to build inbound and outbound liquidity.");
    recommendations.push(
      makeRecommendation({
        id: "rec-open-first-channel",
        category: "liquidity_safety",
        priority: "low",
        title: "Open your first channel",
        description: "Open a channel to a well-connected peer to start sending and receiving payments.",
        actionType: "open_channel",
      }),
    );
    return {
      inboundSat,
      outboundSat,
      inboundRatio,
      outboundRatio,
      maxReceiveEstimateSat,
      maxSendEstimateSat,
      concentration,
      nodeNeed: "need_routing_diversity",
      severity: "healthy",
      reasons,
      warnings,
      recommendations,
    };
  }

  if (active.length === 0) {
    severities.push("warning");
    warnings.push("No active channels — liquidity is currently unusable.");
  }

  const lowInbound = inboundSat < cfg.lowInboundThresholdSat;
  const lowOutbound = outboundSat < cfg.lowOutboundThresholdSat;

  let nodeNeed: LiquidityNodeNeed = "balanced";
  if (lowInbound) nodeNeed = "need_inbound";
  else if (lowOutbound) nodeNeed = "need_outbound";
  else if (active.length < cfg.minDiverseChannelCount) nodeNeed = "need_routing_diversity";

  if (lowInbound && active.length > 0) {
    severities.push("warning");
    warnings.push(`Low inbound liquidity (${formatSat(inboundSat)}). Receiving larger payments may fail.`);
    recommendations.push(
      makeRecommendation({
        id: "rec-buy-inbound",
        category: "liquidity_safety",
        priority: "medium",
        title: "Acquire inbound liquidity",
        description: "Buy inbound liquidity or open a channel where the peer pushes funds, so you can receive payments.",
        actionType: "buy_inbound",
      }),
    );
  }
  if (lowOutbound && active.length > 0) {
    severities.push("warning");
    warnings.push(`Low outbound liquidity (${formatSat(outboundSat)}). Sending larger payments may fail.`);
    recommendations.push(
      makeRecommendation({
        id: "rec-add-outbound",
        category: "liquidity_safety",
        priority: "medium",
        title: "Add outbound liquidity",
        description: "Fund a new channel or rebalance to increase your sending capacity.",
        actionType: "open_channel",
      }),
    );
  }

  if (active.length > 1) {
    if (concentration.largestLocalChannelShare > concentrationRatio) {
      severities.push("warning");
      warnings.push(
        `Outbound liquidity is concentrated in one channel (${(concentration.largestLocalChannelShare * 100).toFixed(0)}%).`,
      );
    }
    if (concentration.largestRemoteChannelShare > concentrationRatio) {
      severities.push("warning");
      warnings.push(
        `Inbound liquidity is concentrated in one channel (${(concentration.largestRemoteChannelShare * 100).toFixed(0)}%).`,
      );
    }
  }

  if (nodeNeed === "need_routing_diversity" && active.length > 0) {
    recommendations.push(
      makeRecommendation({
        id: "rec-routing-diversity",
        category: "liquidity_safety",
        priority: "low",
        title: "Increase channel diversity",
        description: `You have ${active.length} active channel(s). More well-chosen peers improve reliability and routing.`,
        actionType: "open_channel",
      }),
    );
  }

  if (severities.every((s) => s === "healthy")) {
    reasons.push("Inbound and outbound liquidity look balanced.");
  }

  return {
    inboundSat,
    outboundSat,
    inboundRatio,
    outboundRatio,
    maxReceiveEstimateSat,
    maxSendEstimateSat,
    concentration,
    nodeNeed,
    severity: worstSeverity(severities),
    reasons,
    warnings,
    recommendations,
  };
}
