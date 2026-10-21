import type { ChannelView } from "./types";

/**
 * Routing yield as the Overview and Analytics show it: on this node's OWN
 * capital in its channels (the local balance of open channels — not the
 * capacity, half of which is usually the peers' money, and not pending
 * channels, which earn nothing yet), gross and after rebalancing fees, in
 * %/yr. A5: the old figure divided by every channel's capacity and called
 * the result "APY".
 */
export interface RoutingYield {
  ownCapitalSats: number;
  /** null: no capital in open channels — nothing to divide by. */
  grossPctYear: number | null;
  netPctYear: number | null;
}

export function routingYield(
  channels: Pick<ChannelView, "status" | "localBalance">[],
  revenueSats: number,
  rebalanceFeesSats: number,
  days: number,
): RoutingYield {
  const ownCapitalSats = channels.filter((c) => c.status === "open").reduce((s, c) => s + c.localBalance, 0);
  if (ownCapitalSats <= 0 || days <= 0) return { ownCapitalSats, grossPctYear: null, netPctYear: null };
  const pct = (sats: number) => (sats / ownCapitalSats) * (365 / days) * 100;
  return { ownCapitalSats, grossPctYear: pct(revenueSats), netPctYear: pct(revenueSats - rebalanceFeesSats) };
}

/** ppm/yr as %/yr, two decimals. */
export const pctFromPpm = (ppm: number): string => (ppm / 10_000).toFixed(2);
