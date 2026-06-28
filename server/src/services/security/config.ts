/**
 * Central node-safety configuration. All thresholds live here so behaviour is
 * easy to audit and tune. None of these are secrets. Ported from Lightning
 * Guardian (the disk/operational thresholds were dropped — LightningMate's
 * read-only macaroon cannot observe host disk usage).
 */

export const securityDefaults = {
  scoreWeights: {
    nodeHealth: 0.2,
    backupHealth: 0.25,
    paymentReadiness: 0.2,
    channelRisk: 0.15,
    onchainSafety: 0.1,
    liquiditySafety: 0.1,
  },

  severityThresholds: {
    healthy: 85,
    warning: 65,
  },

  backup: {
    staleBackupHours: 24,
    criticalBackupHours: 168,
    warnIfChannelCountChanged: true,
  },

  paymentReadiness: {
    lowInboundThresholdSat: 250_000,
    lowOutboundThresholdSat: 250_000,
    lowMaxReceiveThresholdSat: 100_000,
    lowMaxSendThresholdSat: 100_000,
    concentrationWarningRatio: 0.7,
  },

  onchainSafety: {
    minOnchainReserveSat: 250_000,
    reservePerChannelSat: 25_000,
    criticalReserveSat: 50_000,
  },

  channelRisk: {
    inactiveChannelWarningRatio: 0.2,
    inactiveCapacityWarningRatio: 0.25,
    deadCapitalDays: 60,
  },

  liquiditySafety: {
    lowInboundThresholdSat: 250_000,
    lowOutboundThresholdSat: 250_000,
    minDiverseChannelCount: 3,
  },
} as const;

export type SecurityConfig = typeof securityDefaults;

/** Resolve the runtime configuration. Returns the defaults today. */
export function getSecurityConfig(): SecurityConfig {
  return securityDefaults;
}
