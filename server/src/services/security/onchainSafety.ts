import type { SecurityConfig } from "./config.js";
import type { OnchainSafetyStatus, SecuritySnapshot, SecuritySeverity } from "./types.js";
import { formatSat, safeRatio, worstSeverity } from "./util.js";

/** Rough vbyte cost to force-close and sweep a single channel. */
const FORCE_CLOSE_VBYTES_PER_CHANNEL = 700;

function activeChannelCount(snapshot: SecuritySnapshot): number {
  if (Array.isArray(snapshot.channels)) {
    return snapshot.channels.filter((c) => c.isActive).length;
  }
  return snapshot.info?.activeChannelsCount ?? 0;
}

/**
 * On-chain reserve & fee risk — does the node hold enough confirmed on-chain
 * balance to pay fees, especially to sweep funds after a force close?
 */
export function evaluateOnchainSafety(
  snapshot: SecuritySnapshot,
  config: SecurityConfig,
): OnchainSafetyStatus {
  const cfg = config.onchainSafety;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const severities: SecuritySeverity[] = ["healthy"];

  const channelsActive = activeChannelCount(snapshot);
  const recommendedReserveSat = Math.max(
    cfg.minOnchainReserveSat,
    channelsActive * cfg.reservePerChannelSat,
  );

  const feeRate = snapshot.feeRateSatPerVbyte;
  const estimatedForceCloseCostSat =
    feeRate !== undefined
      ? Math.round(feeRate * FORCE_CLOSE_VBYTES_PER_CHANNEL * Math.max(channelsActive, 1))
      : undefined;

  if (snapshot.confirmedChainBalanceSat === undefined) {
    return {
      confirmedBalanceSat: 0,
      unconfirmedBalanceSat: snapshot.unconfirmedChainBalanceSat ?? 0,
      recommendedReserveSat,
      reserveRatio: 0,
      estimatedForceCloseCostSat,
      feeRateSatPerVbyte: feeRate,
      severity: snapshot.reachable ? "warning" : "critical",
      reasons: [],
      warnings: ["On-chain balance is unavailable, so reserve safety cannot be evaluated."],
    };
  }

  const confirmedBalanceSat = snapshot.confirmedChainBalanceSat;
  const unconfirmedBalanceSat = snapshot.unconfirmedChainBalanceSat ?? 0;
  const reserveRatio = safeRatio(confirmedBalanceSat, recommendedReserveSat);

  if (channelsActive === 0) {
    reasons.push("No active channels yet — an on-chain reserve is not critical right now.");
    if (confirmedBalanceSat < cfg.minOnchainReserveSat) {
      warnings.push("Keep some on-chain funds available to pay fees when you open channels.");
    }
  } else {
    if (confirmedBalanceSat < cfg.criticalReserveSat) {
      severities.push("critical");
      reasons.push(
        `Confirmed on-chain reserve (${formatSat(confirmedBalanceSat)}) is below the critical floor (${formatSat(cfg.criticalReserveSat)}). You may be unable to pay fees to sweep funds after a force close.`,
      );
    } else if (confirmedBalanceSat < recommendedReserveSat) {
      severities.push("warning");
      warnings.push(
        `Confirmed on-chain reserve (${formatSat(confirmedBalanceSat)}) is below the recommended ${formatSat(recommendedReserveSat)} for ${channelsActive} channel(s).`,
      );
    } else {
      reasons.push(`On-chain reserve is sufficient (${formatSat(confirmedBalanceSat)} confirmed).`);
    }

    if (confirmedBalanceSat === 0 && unconfirmedBalanceSat > 0) {
      severities.push("warning");
      warnings.push("On-chain balance is only unconfirmed. It cannot be spent until it confirms.");
    }

    if (estimatedForceCloseCostSat !== undefined && confirmedBalanceSat < estimatedForceCloseCostSat) {
      severities.push("warning");
      warnings.push(
        `Estimated cost to sweep all channels after force close (~${formatSat(estimatedForceCloseCostSat)} at ${feeRate} sat/vB) exceeds your confirmed reserve.`,
      );
    }
  }

  return {
    confirmedBalanceSat,
    unconfirmedBalanceSat,
    recommendedReserveSat,
    reserveRatio,
    estimatedForceCloseCostSat,
    feeRateSatPerVbyte: feeRate,
    severity: worstSeverity(severities),
    reasons,
    warnings,
  };
}
