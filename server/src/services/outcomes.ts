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
  const lookback = (opts.lookbackDays ?? 60) * DAY;

  const report = await getForwardsReport(lnd, 90);
  const dayTs = report.daily.map((d) => new Date(`${d.date}T00:00:00Z`).getTime());
  const sparkById = new Map(report.perChannel.map((c) => [c.channelId, c.spark]));
  const aliasById = new Map(report.perChannel.map((c) => [c.channelId, c.alias]));
  // Node-wide daily fee total (sum of every channel's spark per day) — the
  // baseline used to difference out market-wide swings from one channel's move.
  const nodeSpark: number[] = dayTs.map((_, i) =>
    report.perChannel.reduce((s, c) => s + (c.spark[i] ?? 0), 0),
  );

  // Sum a sparkline over [fromTs, toTs).
  const sumSpark = (spark: number[] | undefined, fromTs: number, toTs: number): number => {
    if (!spark) return 0;
    let s = 0;
    for (let i = 0; i < dayTs.length; i++) if (dayTs[i] >= fromTs && dayTs[i] < toTs) s += spark[i] ?? 0;
    return s;
  };
  const sumWindow = (channelId: string, fromTs: number, toTs: number): number =>
    sumSpark(sparkById.get(channelId), fromTs, toTs);

  const now = Date.now();

  // ── Fee-change impact ──
  const feeItems: FeeOutcome[] = [];
  for (const run of history) {
    const at = new Date(run.at).getTime();
    // Only measure once a FULL after-window exists (was `gap` < feeWin, which
    // truncated the after-window for recent changes and biased them negative).
    if (now - at < feeWin * DAY || now - at > lookback) continue;
    for (const c of run.changes ?? []) {
      if (!c.ok || c.fromPpm === c.toPpm) continue;
      const from = at - feeWin * DAY;
      const to = at + feeWin * DAY;
      const cBefore = sumWindow(c.id, from, at);
      const cAfter = sumWindow(c.id, at, to);
      // Difference-in-differences: subtract the node-wide (ex-this-channel)
      // revenue change over the same windows, so a market-wide swing isn't
      // mistaken for this channel's response to the fee change.
      const exBefore = sumSpark(nodeSpark, from, at) - cBefore;
      const exAfter = sumSpark(nodeSpark, at, to) - cAfter;
      const chanDelta = cBefore > 0 ? (cAfter - cBefore) / cBefore : null;
      const marketDelta = exBefore > 0 ? (exAfter - exBefore) / exBefore : 0;
      feeItems.push({
        channelId: c.id,
        alias: c.alias || aliasById.get(c.id) || c.id,
        at: run.at,
        fromPpm: c.fromPpm,
        toPpm: c.toPpm,
        raised: c.toPpm > c.fromPpm,
        beforeDailyAvgSat: Math.round(cBefore / feeWin),
        afterDailyAvgSat: Math.round(cAfter / feeWin),
        deltaPct: chanDelta == null ? null : Math.round((chanDelta - marketDelta) * 100) / 100,
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
    // Require a full after-window before judging (same truncation fix as fees).
    if (now - at < rebWin * DAY || now - at > lookback) continue;
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

export interface ChannelElasticity {
  /** Multiplier to nudge the fee target — >1 = inelastic (charge more), <1 = elastic. */
  modifier: number;
  /** -1..1: did charging more help revenue? */
  signal: number;
  samples: number;
}

const clampEl = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Need at least this many measured changes before trusting an elasticity nudge. */
const MIN_SAMPLES = 2;
/** Sample count at which the nudge reaches full strength (confidence shrink). */
const CONF_FULL = 4;

/**
 * Per-channel fee elasticity from measured outcomes — a demand-curve-lite move
 * toward the revenue peak. For each measured change we ask "did charging more
 * lift revenue here?" using the MAGNITUDE of the (difference-in-differences-
 * adjusted) revenue response, not just its sign. A consistent positive response
 * means the channel is inelastic → price up toward the peak; negative means we
 * went past it → ease down. The nudge is sample-gated and confidence-weighted, so
 * one noisy week can't swing a fee, and channels with too little history are left
 * out of the map entirely → the fee algo behaves exactly as before.
 */
export function feeElasticityFromOutcomes(items: FeeOutcome[]): Map<string, ChannelElasticity> {
  const byChan = new Map<string, FeeOutcome[]>();
  for (const f of items) {
    if (f.deltaPct == null || f.deltaPct === 0) continue; // skip no-flow / no-effect
    const list = byChan.get(f.channelId);
    if (list) list.push(f);
    else byChan.set(f.channelId, [f]);
  }
  const out = new Map<string, ChannelElasticity>();
  for (const [id, list] of byChan) {
    if (list.length < MIN_SAMPLES) continue; // not enough evidence — don't nudge
    // raiseScore > 0 ⇒ "charging more lifted revenue" (inelastic, price up);
    // < 0 ⇒ raising cost flow (elastic, ease down). A revenue-raising cut means
    // we were too high ⇒ negative score, and vice-versa.
    const raiseScores = list.map((f) => (f.raised ? (f.deltaPct as number) : -(f.deltaPct as number)));
    const avg = raiseScores.reduce((a, b) => a + b, 0) / raiseScores.length;
    const confidence = Math.min(1, list.length / CONF_FULL);
    const signal = clampEl(avg, -0.5, 0.5);
    // Bounded, confidence-weighted step toward the revenue peak.
    const modifier = Math.round(clampEl(1 + signal * 0.5 * confidence, 0.75, 1.3) * 100) / 100;
    out.set(id, { modifier, signal: Math.round(signal * 100) / 100, samples: list.length });
  }
  return out;
}

/** Convenience: compute per-channel fee elasticity directly from the node + history. */
export async function getFeeElasticity(
  lnd: AuthenticatedLnd,
  history: AutopilotRun[],
): Promise<Map<string, ChannelElasticity>> {
  const report = await getAutopilotOutcomes(lnd, history, []);
  return feeElasticityFromOutcomes(report.fees.items);
}
