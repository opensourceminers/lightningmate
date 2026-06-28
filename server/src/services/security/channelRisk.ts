import type { SecurityConfig } from "./config.js";
import type {
  ChannelRisk,
  ChannelRiskStatus,
  ChannelRiskType,
  NormalizedChannel,
  SecuritySnapshot,
  SecuritySeverity,
} from "./types.js";
import { formatSat, makeRecommendation, safeRatio, severityRank, shortPubkey, worstSeverity } from "./util.js";

/** Inactive channels holding at least this much local balance count as dead capital. */
const DEAD_CAPITAL_MIN_SAT = 100_000;

// Channel imbalance is deliberately NOT treated as a risk here: a channel with
// liquidity on only one side (freshly opened, just leased, or a routing sink/
// source) is normal and not a safety concern. Balance distribution is a
// routing/liquidity matter — handled by the rebalance + liquidity features —
// not security. Security channel risk is strictly about funds at risk:
// inactive/dead-capital channels, stuck HTLCs, and force/pending closes.
function assessOpenChannel(c: NormalizedChannel): ChannelRisk | null {
  const riskTypes: ChannelRiskType[] = [];
  const reasons: string[] = [];
  let level: SecuritySeverity = "healthy";

  const peer = shortPubkey(c.partnerPublicKey);

  if (!c.isActive) {
    riskTypes.push("inactive");
    level = worstSeverity([level, "warning"]);
    reasons.push(`Channel with ${peer} is inactive (peer offline or channel disabled).`);

    if (c.localBalanceSat >= DEAD_CAPITAL_MIN_SAT) {
      riskTypes.push("dead_capital");
      riskTypes.push("close_candidate");
      reasons.push(`${formatSat(c.localBalanceSat)} of your funds are locked in this inactive channel.`);
    }

    if (c.pendingHtlcCount > 0) {
      riskTypes.push("pending_htlc");
      level = worstSeverity([level, "critical"]);
      reasons.push(`${c.pendingHtlcCount} in-flight HTLC(s) on an inactive channel — funds may be stuck.`);
    }
  }

  if (riskTypes.length === 0) return null;

  const recommendations =
    riskTypes.includes("dead_capital") || riskTypes.includes("inactive")
      ? [
          makeRecommendation({
            id: `rec-review-channel-${c.id}`,
            category: "channel_risk",
            priority: riskTypes.includes("pending_htlc") ? "high" : "medium",
            title: "Review inactive channel",
            description: `Check connectivity with peer ${peer}. If the peer is gone for good, consider closing to free up capital.`,
            actionType: "review_channels",
            relatedChannelIds: [c.id],
          }),
        ]
      : [];

  return {
    channelId: c.id,
    alias: undefined,
    capacitySat: c.capacitySat,
    localRatio: c.localRatio,
    riskLevel: level,
    riskTypes,
    reasons,
    recommendations,
  };
}

/**
 * Channel risk monitor — flags inactive, force-closing and dead-capital
 * channels (channels with funds at risk). Balance imbalance is intentionally
 * excluded: one-sided liquidity is normal and a routing/liquidity matter, not
 * a security concern.
 */
export function evaluateChannelRisk(
  snapshot: SecuritySnapshot,
  config: SecurityConfig,
): ChannelRiskStatus {
  const cfg = config.channelRisk;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const severities: SecuritySeverity[] = ["healthy"];
  const riskyChannels: ChannelRisk[] = [];

  const channels = snapshot.channels;
  const pending = snapshot.pendingChannels ?? [];

  if (!Array.isArray(channels)) {
    return {
      activeChannelCount: 0,
      inactiveChannelCount: 0,
      riskyChannels: [],
      severity: snapshot.reachable ? "warning" : "critical",
      reasons: [],
      warnings: ["Channel data is unavailable, so channel risk cannot be evaluated."],
    };
  }

  const active = channels.filter((c) => c.isActive);
  const inactive = channels.filter((c) => !c.isActive);
  const totalCapacity = channels.reduce((a, c) => a + c.capacitySat, 0);
  const inactiveCapacity = inactive.reduce((a, c) => a + c.capacitySat, 0);

  for (const c of channels) {
    const risk = assessOpenChannel(c);
    if (risk) riskyChannels.push(risk);
  }

  const pendingOpenCount = pending.filter((p) => p.isOpening).length;
  const pendingCloseChannels = pending.filter((p) => p.isClosing);
  const forceCloseChannels = pending.filter((p) => p.isForceClose);
  const pendingCloseCount = pendingCloseChannels.length;
  const forceCloseCount = forceCloseChannels.length;

  for (const p of pendingCloseChannels) {
    const isForce = p.isForceClose;
    riskyChannels.push({
      channelId: `pending:${shortPubkey(p.partnerPublicKey)}`,
      alias: undefined,
      capacitySat: p.capacitySat,
      localRatio: safeRatio(p.localBalanceSat, p.capacitySat),
      riskLevel: isForce ? "critical" : "warning",
      riskTypes: isForce ? ["force_close"] : ["pending_close"],
      reasons: [
        isForce
          ? `Channel with ${shortPubkey(p.partnerPublicKey)} is FORCE closing. Funds are timelocked until the closing transaction confirms.`
          : `Channel with ${shortPubkey(p.partnerPublicKey)} is cooperatively closing.`,
      ],
      recommendations: isForce
        ? [
            makeRecommendation({
              id: `rec-force-close-${shortPubkey(p.partnerPublicKey)}`,
              category: "channel_risk",
              priority: "urgent",
              title: "Monitor force-closing channel",
              description:
                "A force close is in progress. Keep the node online and ensure enough on-chain fees to sweep the funds when the timelock expires.",
              actionType: "check_node",
            }),
          ]
        : [],
    });
  }

  if (forceCloseCount > 0) {
    severities.push("critical");
    reasons.push(`${forceCloseCount} channel(s) are force closing.`);
  }
  if (pendingCloseCount - forceCloseCount > 0) {
    severities.push("warning");
    warnings.push(`${pendingCloseCount - forceCloseCount} channel(s) are cooperatively closing.`);
  }

  const inactiveRatio = safeRatio(inactive.length, channels.length);
  const inactiveCapacityRatio = safeRatio(inactiveCapacity, totalCapacity);

  if (channels.length > 0) {
    if (inactiveRatio >= 0.5) {
      severities.push("critical");
      reasons.push(`${inactive.length} of ${channels.length} channels are inactive.`);
    } else if (inactiveRatio >= cfg.inactiveChannelWarningRatio) {
      severities.push("warning");
      warnings.push(`${inactive.length} of ${channels.length} channels are inactive.`);
    }

    if (inactiveCapacityRatio >= cfg.inactiveCapacityWarningRatio * 2) {
      severities.push("critical");
      reasons.push(`${(inactiveCapacityRatio * 100).toFixed(0)}% of channel capacity is locked in inactive channels.`);
    } else if (inactiveCapacityRatio >= cfg.inactiveCapacityWarningRatio) {
      severities.push("warning");
      warnings.push(`${(inactiveCapacityRatio * 100).toFixed(0)}% of channel capacity is locked in inactive channels.`);
    }
  }

  if (severities.every((s) => s === "healthy") && channels.length > 0) {
    reasons.push("No risky channels detected.");
  }

  riskyChannels.sort((a, b) => {
    const sev = severityRank(b.riskLevel) - severityRank(a.riskLevel);
    return sev !== 0 ? sev : b.capacitySat - a.capacitySat;
  });

  return {
    activeChannelCount: active.length,
    inactiveChannelCount: inactive.length,
    pendingOpenCount,
    pendingCloseCount,
    forceCloseCount,
    riskyChannels,
    severity: worstSeverity(severities),
    reasons,
    warnings,
  };
}
