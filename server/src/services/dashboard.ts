import type { ForwardsReport } from "./forwards.js";
import type { LnActivity } from "./payments.js";
import type { OnchainTx } from "./onchain.js";

/**
 * Assembles the Overview dashboard from data already fetched by the route, so
 * forwards are pulled only once: KPI totals + sparklines, a unified recent
 * activity feed (forwards + Lightning + on-chain) and an autopilot summary.
 */

export type ActivityKind =
  | "forward"
  | "received"
  | "sent"
  /** A payment to this node itself: one row for the rebalance, its fee the cost. */
  | "rebalance"
  | "onchain_in"
  | "onchain_out"
  /** A funding transaction of one of this node's channels. */
  | "channel_open"
  /** A channel's closing transaction, or a sweep of a force close. */
  | "channel_close";

export interface ActivityItem {
  at: string;
  kind: ActivityKind;
  title: string;
  /** Signed sats: earned/received positive, sent negative. */
  amountSats: number;
  routedSats?: number;
  feeSats?: number;
}

/**
 * What leasing capital out on Magma would earn this node (D12) — live, never a
 * constant. The Overview showed "market lease ≈ 26k ppm/yr" for every node
 * (stale: buyers paid ~50k at the time) as what its capital "could earn
 * leased out instead" — for nodes that, like most small ones, don't sell at
 * all. Now: for a node whose comparable offers do sell, the median rate
 * buyers actually paid for leases of its size (gross — a seller nets less:
 * Amboss's fee is on top, the on-chain costs and the 1% service fee come
 * off); for any other node, plainly that selling isn't realistic for it yet.
 */
export interface LeaseBenchmark {
  status: "eligible" | "not_realistic" | "no_data" | "unknown";
  /** Median annual rate buyers paid for comparable leases (gross), in %. */
  grossAprPct: number | null;
  sales: number | null;
  windowDays: number | null;
  text: string;
}

export interface DashboardData {
  windowDays: number;
  earnedSats: number;
  forwardCount: number;
  routedSats: number;
  /** Forwards, fees and volume of the last 24 hours and 7 days — rolling,
   *  ending now (the sparklines' last bucket is a partial day). */
  rolling: ForwardsReport["rolling"];
  /** False when LND had more forwards in the window than were read: the
   *  most recent are the ones missing, so `rolling` reads too low — the
   *  Overview says so instead of "no forwards in 7 days". */
  forwardsComplete: boolean;
  feesSpark: number[];
  forwardsSpark: number[];
  routedSpark: number[];
  /** Rebalances over the window (windowDays), whichever tool made them. */
  rebalancedCount: number;
  rebalancedSats: number;
  /** Total channel capacity (sats), peers' sides and pending channels included. */
  totalCapacitySats: number;
  /** This node's own capital in its open channels: their local balance. */
  ownCapitalSats: number;
  /** Routing fees earned on that capital, annualised — gross (ppm/year). */
  yieldPpmYear: number;
  /** The same after the rebalancing fees paid in the window (ppm/year). */
  netYieldPpmYear: number;
  rebalanceFeesSats: number;
  /** Where the rebalancing figures come from (pnl.ts PnlSummary). */
  rebalanceSource: "lnd" | "log";
  leaseBenchmark: LeaseBenchmark;
  activity: ActivityItem[];
  autopilot: {
    fees: boolean;
    rebalance: boolean;
    channel: boolean;
    sell: boolean;
    lastRunAt: string | null;
    lastApplied: number;
    lastAttempted: number;
    /** Minutes between runs — lets the UI show "next run in ~X min". */
    intervalMinutes: number;
    /** Last run, summarised for the Overview digest. */
    lastFeeChanges: number;
    lastRebalances: number;
    lastSells: number;
    lastOpens: number;
    /** Magma orders the lane turned down in the last two days (not dismissed). */
    magmaRefusals: number;
    magmaRefusalReason: string | null;
  };
}

interface RebalanceSummary {
  count: number;
  totalAmountSats: number;
}

/** The transactions of this node's channels: funding ones, and closing ones
 *  with their sweeps — so the feed says what each on-chain line was. */
export interface ChannelTxids {
  opens: ReadonlySet<string>;
  closes: ReadonlySet<string>;
}

interface AutopilotState {
  config: {
    enabled: boolean;
    rebalanceEnabled: boolean;
    channelEnabled: boolean;
    sellEnabled: boolean;
    intervalMinutes: number;
  };
  lastRunAt: string | null;
  history: {
    applied: number;
    attempted: number;
    changes?: { ok: boolean }[];
    rebalances?: { ok: boolean }[];
    sells?: { ok: boolean }[];
    channels?: { ok: boolean }[];
  }[];
}

export function buildDashboard(
  report: ForwardsReport,
  ln: LnActivity,
  onchain: OnchainTx[],
  rebalance: RebalanceSummary,
  autopilot: AutopilotState,
  totalCapacitySats: number,
  extra: {
    ownCapitalSats: number;
    rebalanceFeesSats: number;
    rebalanceSource?: "lnd" | "log";
    leaseBenchmark: LeaseBenchmark;
    magmaRefusals: { reason: string }[];
    /** This node's key: a payment to it is a rebalance. */
    ownPubkey?: string;
    channelTxids?: ChannelTxids;
  } = { ownCapitalSats: totalCapacitySats, rebalanceFeesSats: 0, leaseBenchmark: { status: "unknown", grossAprPct: null, sales: null, windowDays: null, text: "" }, magmaRefusals: [] },
): DashboardData {
  const activity: ActivityItem[] = [];
  // A rebalance is a payment to this node's own invoice: before, the feed
  // showed it twice — "Received · Lightning invoice +N" and "Sent · <own
  // key>… −N" — and neither said it was a rebalance or what it cost. Now one
  // row, its fee the amount.
  const selfPaid = new Set(ln.payments.filter((p) => extra.ownPubkey && p.destination === extra.ownPubkey).map((p) => p.id));

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
    if (!i.isPaid || selfPaid.has(i.id)) continue;
    activity.push({
      at: i.createdAt,
      kind: "received",
      title: i.description || "Lightning invoice",
      amountSats: i.receivedSats || i.tokens,
    });
  }
  for (const p of ln.payments) {
    if (selfPaid.has(p.id)) {
      activity.push({ at: p.createdAt, kind: "rebalance", title: `${p.tokens.toLocaleString("en-US")} sat moved`, amountSats: -p.feeSats, feeSats: p.feeSats });
      continue;
    }
    activity.push({
      at: p.createdAt,
      kind: "sent",
      title: `${p.destination.slice(0, 16)}…`,
      amountSats: -p.tokens,
      feeSats: p.feeSats,
    });
  }
  for (const t of onchain) {
    // Funding and closing transactions say so: they were "On-chain send" and
    // "On-chain receive" like any payment.
    const kind: ActivityKind = extra.channelTxids?.opens.has(t.id)
      ? "channel_open"
      : extra.channelTxids?.closes.has(t.id)
        ? "channel_close"
        : t.isOutgoing
          ? "onchain_out"
          : "onchain_in";
    const title = kind === "channel_open" ? "Channel open" : kind === "channel_close" ? "Channel close" : t.isOutgoing ? "On-chain send" : "On-chain receive";
    activity.push({
      at: t.createdAt,
      kind,
      title,
      amountSats: t.amountSats,
      feeSats: t.feeSats || undefined,
    });
  }

  activity.sort((a, b) => b.at.localeCompare(a.at));

  const last = autopilot.history[0];
  const okCount = (xs?: { ok: boolean }[]) => (xs ?? []).filter((x) => x.ok).length;
  // On THIS node's capital (its side of the open channels): the peers'
  // balances and channels still opening earn this node nothing.
  const perYear = (sats: number) =>
    extra.ownCapitalSats > 0 ? Math.round((sats / extra.ownCapitalSats) * (365 / Math.max(1, report.windowDays)) * 1_000_000) : 0;
  return {
    windowDays: report.windowDays,
    earnedSats: report.totalFeesEarnedSats,
    forwardCount: report.totalForwards,
    routedSats: report.totalRoutedSats,
    rolling: report.rolling ?? { last24h: { forwards: 0, routedSats: 0, feesSats: 0 }, last7d: { forwards: 0, routedSats: 0, feesSats: 0 } },
    forwardsComplete: report.complete !== false,
    feesSpark: report.daily.map((d) => d.feesSats),
    forwardsSpark: report.daily.map((d) => d.forwards),
    routedSpark: report.daily.map((d) => d.routedSats),
    rebalancedCount: rebalance.count,
    rebalancedSats: rebalance.totalAmountSats,
    totalCapacitySats,
    ownCapitalSats: extra.ownCapitalSats,
    yieldPpmYear: perYear(report.totalFeesEarnedSats),
    netYieldPpmYear: perYear(report.totalFeesEarnedSats - extra.rebalanceFeesSats),
    rebalanceFeesSats: extra.rebalanceFeesSats,
    rebalanceSource: extra.rebalanceSource ?? "log",
    leaseBenchmark: extra.leaseBenchmark,
    activity: activity.slice(0, 14),
    autopilot: {
      fees: autopilot.config.enabled,
      rebalance: autopilot.config.rebalanceEnabled,
      channel: autopilot.config.channelEnabled,
      sell: autopilot.config.sellEnabled,
      lastRunAt: autopilot.lastRunAt,
      lastApplied: last?.applied ?? 0,
      lastAttempted: last?.attempted ?? 0,
      intervalMinutes: autopilot.config.intervalMinutes,
      lastFeeChanges: okCount(last?.changes),
      lastRebalances: okCount(last?.rebalances),
      lastSells: okCount(last?.sells),
      lastOpens: okCount(last?.channels),
      magmaRefusals: extra.magmaRefusals.length,
      magmaRefusalReason: extra.magmaRefusals[0]?.reason ?? null,
    },
  };
}
