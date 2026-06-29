import type { ChannelView } from "./channels.js";

/**
 * Capital decision engine — the shared primitive the AUTOPILOT uses to decide
 * where on-chain capital should go (open a routing channel vs lease on Magma).
 * One definition of "what does a sat earn routing here?", consumed by
 * Autopilot.runChannels (services/autopilot.ts). No UI, no separate page — the
 * autopilot calls this directly during its run.
 */

/** Lease only above this × your marginal routing yield (else routing wins). */
const LEASE_VS_ROUTE_RATIO = 1.2;
const YEAR_OVER_30D = 365 / 30;

export interface RoutingYieldStats {
  /** Median per-channel routing yield (ppm/year) — the expected yield of a new channel. */
  medianPpmYear: number;
  /** Lower-quartile yield — the opportunity cost of the capital you'd redeploy. */
  marginalPpmYear: number;
  /** Lease only above this; below it, routing the capital earns more. */
  leaseThresholdPpmYear: number;
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * sortedAsc.length)));
  return sortedAsc[i];
}

/**
 * Per-channel routing yield stats from active channels + their 30-day fee
 * revenue: the median (≈ a new channel's expected yield) and the lower-quartile
 * "marginal" yield (the opportunity cost of capital), plus the lease threshold
 * below which routing the capital out-earns leasing it.
 */
export function routingYieldStats(active: ChannelView[], revByChan: Map<string, number>): RoutingYieldStats {
  const yieldOf = (id: string, capacity: number): number => {
    const rev = revByChan.get(id) ?? 0;
    return capacity > 0 ? Math.round((rev / capacity) * YEAR_OVER_30D * 1_000_000) : 0;
  };
  const yields = active.map((c) => yieldOf(c.id, c.capacity)).sort((a, b) => a - b);
  const marginalPpmYear = percentile(yields, 25);
  return {
    medianPpmYear: percentile(yields, 50),
    marginalPpmYear,
    leaseThresholdPpmYear: Math.round(Math.max(marginalPpmYear, 1) * LEASE_VS_ROUTE_RATIO),
  };
}
