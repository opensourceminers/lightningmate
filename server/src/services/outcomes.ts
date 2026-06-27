import { type AuthenticatedLnd } from "lightning";
import { getForwardsReport } from "./forwards.js";
import type { RebalanceRecord } from "./rebalanceLog.js";
import type { AutopilotRun } from "./autopilot.js";

/**
 * Autopilot outcomes — the closed loop. We never measured whether the autopilot's
 * actions actually paid off; this computes that READ-ONLY from data we already
 * keep (the autopilot history of fee changes, the rebalance log) against the
 * per-channel daily fee history (forwards report). It answers:
 *   - did raising/cutting a fee move that channel's revenue?
 *   - did a rebalance earn its cost back?
 * No new write path, no risk to the live autopilot — and it's the data the fee
 * elasticity learner (next) feeds on.
 */

export interface FeeOutcome {
  channelId: string;
  alias: string;
  at: string;
  fromPpm: number;
  toPpm: number;
  raised: boolean;
  beforeDailyAvgSat: number;
  afterDailyAvgSat: number;
  /** Revenue change vs the pre-change week, as a ratio (null if no prior flow). */
  deltaPct: number | null;
}

export interface RebalanceOutcome {
  targetId: string;
  alias: string;
  at: string;
  costSats: number;
  revenueAfterSats: number;
  earnedBackPct: number;
  netSats: number;
  paidBack: boolean;
}

export interface OutcomesReport {
  measureWindowDays: number;
  fees: {
    measured: number;
    raises: number;
    cuts: number;
    avgRevenueDeltaPct: number | null;
    items: FeeOutcome[];
  };
  rebalances: {
    measured: number;
    totalCostSats: number;
    totalEarnedBackSats: number;
    avgEarnedBackPct: number | null;
    paidBackCount: number;
    netSats: number;
    items: RebalanceOutcome[];
  };
}

const DAY = 86_400_000;

export async function getAutopilotOutcomes(
  lnd: AuthenticatedLnd,
  history: AutopilotRun[],
  rebalanceRecords: RebalanceRecord[],
  opts: { feeWindowDays?: number; rebalanceWindowDays?: number; measureGapDays?: number; lookbackDays?: number } = {},
): Promise<OutcomesReport> {
  const feeWin = opts.feeWindowDays ?? 7;
  const rebWin = opts.rebalanceWindowDays ?? 14;
  const gap = (opts.measureGapDays ?? 5) * DAY; // need a few days after the action to judge it
  const lookback = (opts.lookbackDays ?? 60) * DAY;

  const report = await getForwardsReport(lnd, 90);
  const dayTs = report.daily.map((d) => new Date(`${d.date}T00:00:00Z`).getTime());
  const sparkById = new Map(report.perChannel.map((c) => [c.channelId, c.spark]));
  const aliasById = new Map(report.perChannel.map((c) => [c.channelId, c.alias]));

  // Sum a channel's fees earned over [fromTs, toTs) from its daily sparkline.
  const sumWindow = (channelId: string, fromTs: number, toTs: number): number => {
    const spark = sparkById.get(channelId);
    if (!spark) return 0;
    let s = 0;
    for (let i = 0; i < dayTs.length; i++) if (dayTs[i] >= fromTs && dayTs[i] < toTs) s += spark[i] ?? 0;
    return s;
  };

  const now = Date.now();

  // ── Fee-change impact ──
  const feeItems: FeeOutcome[] = [];
  for (const run of history) {
    const at = new Date(run.at).getTime();
    if (now - at < gap || now - at > lookback) continue;
    for (const c of run.changes ?? []) {
      if (!c.ok || c.fromPpm === c.toPpm) continue;
      const before = sumWindow(c.id, at - feeWin * DAY, at) / feeWin;
      const after = sumWindow(c.id, at, at + feeWin * DAY) / feeWin;
      feeItems.push({
        channelId: c.id,
        alias: c.alias || aliasById.get(c.id) || c.id,
        at: run.at,
        fromPpm: c.fromPpm,
        toPpm: c.toPpm,
        raised: c.toPpm > c.fromPpm,
        beforeDailyAvgSat: Math.round(before),
        afterDailyAvgSat: Math.round(after),
        deltaPct: before > 0 ? Math.round(((after - before) / before) * 100) / 100 : null,
      });
    }
  }
  feeItems.sort((a, b) => b.at.localeCompare(a.at));
  const measurable = feeItems.filter((f) => f.deltaPct != null);
  const fees = {
    measured: feeItems.length,
    raises: feeItems.filter((f) => f.raised).length,
    cuts: feeItems.filter((f) => !f.raised).length,
    avgRevenueDeltaPct: measurable.length
      ? Math.round((measurable.reduce((s, f) => s + (f.deltaPct ?? 0), 0) / measurable.length) * 100) / 100
      : null,
    items: feeItems.slice(0, 30),
  };

  // ── Rebalance realized ROI ──
  const rebItems: RebalanceOutcome[] = [];
  for (const r of rebalanceRecords) {
    if (!r.ok || !r.feeSats || r.feeSats <= 0) continue;
    const at = new Date(r.at).getTime();
    if (now - at < gap || now - at > lookback) continue;
    const revenueAfter = sumWindow(r.targetId, at, at + rebWin * DAY);
    rebItems.push({
      targetId: r.targetId,
      alias: r.targetAlias || aliasById.get(r.targetId) || r.targetId,
      at: r.at,
      costSats: r.feeSats,
      revenueAfterSats: Math.round(revenueAfter),
      earnedBackPct: Math.round((revenueAfter / r.feeSats) * 100),
      netSats: Math.round(revenueAfter - r.feeSats),
      paidBack: revenueAfter >= r.feeSats,
    });
  }
  rebItems.sort((a, b) => b.at.localeCompare(a.at));
  const totalCostSats = rebItems.reduce((s, r) => s + r.costSats, 0);
  const totalEarnedBackSats = rebItems.reduce((s, r) => s + r.revenueAfterSats, 0);
  const rebalances = {
    measured: rebItems.length,
    totalCostSats,
    totalEarnedBackSats,
    avgEarnedBackPct: totalCostSats > 0 ? Math.round((totalEarnedBackSats / totalCostSats) * 100) : null,
    paidBackCount: rebItems.filter((r) => r.paidBack).length,
    netSats: totalEarnedBackSats - totalCostSats,
    items: rebItems.slice(0, 30),
  };

  return { measureWindowDays: rebWin, fees, rebalances };
}
