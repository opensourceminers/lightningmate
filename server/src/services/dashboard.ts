import type { ForwardsReport } from "./forwards.js";
import type { LnActivity } from "./payments.js";
import type { OnchainTx } from "./onchain.js";

/**
 * Assembles the Overview dashboard from data already fetched by the route, so
 * forwards are pulled only once: KPI totals + sparklines, a unified recent
 * activity feed (forwards + Lightning + on-chain) and an autopilot summary.
 */

export type ActivityKind = "forward" | "received" | "sent" | "onchain_in" | "onchain_out";

export interface ActivityItem {
  at: string;
  kind: ActivityKind;
  title: string;
  /** Signed sats: earned/received positive, sent negative. */
  amountSats: number;
  routedSats?: number;
  feeSats?: number;
}

export interface DashboardData {
  windowDays: number;
  earnedSats: number;
  forwardCount: number;
  routedSats: number;
  feesSpark: number[];
  forwardsSpark: number[];
  routedSpark: number[];
  rebalancedCount: number;
  rebalancedSats: number;
  activity: ActivityItem[];
  autopilot: {
    fees: boolean;
    rebalance: boolean;
    channel: boolean;
    sell: boolean;
    lastRunAt: string | null;
    lastApplied: number;
    lastAttempted: number;
  };
}

interface RebalanceSummary {
  count: number;
  totalAmountSats: number;
}

interface AutopilotState {
  config: { enabled: boolean; rebalanceEnabled: boolean; channelEnabled: boolean; sellEnabled: boolean };
  lastRunAt: string | null;
  history: { applied: number; attempted: number }[];
}

export function buildDashboard(
  report: ForwardsReport,
  ln: LnActivity,
  onchain: OnchainTx[],
  rebalance: RebalanceSummary,
  autopilot: AutopilotState,
): DashboardData {
  const activity: ActivityItem[] = [];

  for (const f of report.recent) {
    activity.push({
      at: f.createdAt,
      kind: "forward",
      title: `${f.incoming} → ${f.outgoing}`,
      amountSats: f.fee,
      routedSats: f.tokens,
    });
  }
  for (const i of ln.invoices) {
    if (!i.isPaid) continue;
    activity.push({
      at: i.createdAt,
      kind: "received",
      title: i.description || "Lightning invoice",
      amountSats: i.receivedSats || i.tokens,
    });
  }
  for (const p of ln.payments) {
    activity.push({
      at: p.createdAt,
      kind: "sent",
      title: `${p.destination.slice(0, 16)}…`,
      amountSats: -p.tokens,
      feeSats: p.feeSats,
    });
  }
  for (const t of onchain) {
    activity.push({
      at: t.createdAt,
      kind: t.isOutgoing ? "onchain_out" : "onchain_in",
      title: t.isOutgoing ? "On-chain send" : "On-chain receive",
      amountSats: t.amountSats,
      feeSats: t.feeSats || undefined,
    });
  }

  activity.sort((a, b) => b.at.localeCompare(a.at));

  const last = autopilot.history[0];
  return {
    windowDays: report.windowDays,
    earnedSats: report.totalFeesEarnedSats,
    forwardCount: report.totalForwards,
    routedSats: report.totalRoutedSats,
    feesSpark: report.daily.map((d) => d.feesSats),
    forwardsSpark: report.daily.map((d) => d.forwards),
    routedSpark: report.daily.map((d) => d.routedSats),
    rebalancedCount: rebalance.count,
    rebalancedSats: rebalance.totalAmountSats,
    activity: activity.slice(0, 14),
    autopilot: {
      fees: autopilot.config.enabled,
      rebalance: autopilot.config.rebalanceEnabled,
      channel: autopilot.config.channelEnabled,
      sell: autopilot.config.sellEnabled,
      lastRunAt: autopilot.lastRunAt,
      lastApplied: last?.applied ?? 0,
      lastAttempted: last?.attempted ?? 0,
    },
  };
}
