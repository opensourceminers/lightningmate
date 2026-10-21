import { type AuthenticatedLnd } from "lightning";
import { getForwardEvents, type ForwardEvent } from "./forwards.js";
import type { RebalanceRecord } from "./rebalanceLog.js";
import type { FeeChangeRecord } from "./feeChangeLog.js";

/**
 * Autopilot outcomes — the closed loop: did the fee changes and rebalances
 * pay off? Computed READ-ONLY from the fee-change log (feeChangeLog.ts) and the
 * rebalance log, against the forwards themselves (exact fees, in msat).
 *
 * Fee changes (D15, review a5/a1): each change is measured over the interval
 * until the NEXT change on that channel (at most FEE_WINDOW_DAYS), against
 * the interval since the previous one (likewise), both per day — instead of
 * requiring a ±7-day vacuum around it, which the 30-minute loop's daily
 * lowering and 72-hour raising almost never left. An interval shorter than
 * MIN_INTERVAL_DAYS is too short to say anything. The headline is weighted by
 * revenue (Σ(after − before − market move) / Σ before), shown only over at
 * least MIN_MEASURED changes that earned something before — one channel going
 * from 1 to 20 sat a week no longer reads as "+1900 %".
 */

export const FEE_WINDOW_DAYS = 14;
export const MIN_INTERVAL_DAYS = 3;
/** A change counts toward the headline only if its channel earned at least
 *  this much (sat a week) before it: below that, a ratio is noise. */
export const MIN_BEFORE_SAT_PER_WEEK = 50;
/** Changes needed before the headline shows a number at all. */
export const MIN_MEASURED = 5;
/** How far back changes are measured. */
const LOOKBACK_DAYS = 60;

export interface FeeOutcome {
  channelId: string;
  alias: string;
  at: string;
  fromPpm: number;
  toPpm: number;
  raised: boolean;
  via: FeeChangeRecord["via"];
  /** Length of the two intervals compared, days. */
  beforeDays: number;
  afterDays: number;
  /** Revenue per day before and after (sat, one decimal). */
  beforeDailyAvgSat: number;
  afterDailyAvgSat: number;
  forwardsBefore: number;
  forwardsAfter: number;
  /** Revenue change against the interval before, net of the node-wide move
   *  over the same intervals, as a ratio (null: nothing earned before). */
  deltaPct: number | null;
  /** Enough revenue before to count toward the headline. */
  measurable: boolean;
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
    /** The longest interval each side of a change is measured over. */
    windowDays: number;
    /** Changes measured (both intervals long enough). */
    measured: number;
    /** Of those, the ones counted in the headline (enough revenue before). */
    measurable: number;
    /** Changes too recent to measure yet. */
    pending: number;
    /** Changes with another change on the channel too close before or after. */
    tooClose: number;
    raises: number;
    cuts: number;
    /** Revenue-weighted, market-adjusted change; null below MIN_MEASURED. */
    avgRevenueDeltaPct: number | null;
    minMeasured: number;
    confidence: "none" | "low" | "medium";
    note: string;
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
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Forwards in time order, summed with a running total so any interval's
 *  revenue and count is two binary searches away (a busy node has 100k
 *  forwards in the window and thousands of changes to measure). */
class Series {
  private readonly times: number[] = [];
  private readonly cumMsat: number[] = [0];

  add(t: number, feeMsat: number): void {
    this.times.push(t);
    this.cumMsat.push(this.cumMsat[this.cumMsat.length - 1] + feeMsat);
  }

  /** Index of the first forward at or after `t`. */
  private lower(t: number): number {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Fees (msat) and forwards over [from, to). */
  over(from: number, to: number): { msat: number; count: number } {
    if (to <= from) return { msat: 0, count: 0 };
    const a = this.lower(from);
    const b = this.lower(to);
    return { msat: this.cumMsat[b] - this.cumMsat[a], count: b - a };
  }
}

function seriesOf(events: ForwardEvent[]): { byChannel: Map<string, Series>; node: Series } {
  const sorted = events
    .map((e) => ({ t: Date.parse(e.createdAt), out: e.outgoingChannel, msat: e.feeMsat }))
    .filter((e) => Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);
  const byChannel = new Map<string, Series>();
  const node = new Series();
  for (const e of sorted) {
    let s = byChannel.get(e.out);
    if (!s) byChannel.set(e.out, (s = new Series()));
    s.add(e.t, e.msat);
    node.add(e.t, e.msat);
  }
  return { byChannel, node };
}

/** The fee-change half of the report — pure, for tests. */
export function measureFeeChanges(
  changes: FeeChangeRecord[],
  events: ForwardEvent[],
  nowMs = Date.now(),
): OutcomesReport["fees"] {
  const { byChannel, node } = seriesOf(events);
  const empty = new Series();
  const W = FEE_WINDOW_DAYS * DAY;
  const MIN = MIN_INTERVAL_DAYS * DAY;

  // Every write on a channel bounds its neighbours' intervals (a base-fee-only
  // change too); only ppm changes are measured.
  const byChan = new Map<string, FeeChangeRecord[]>();
  for (const c of changes) {
    if (!Number.isFinite(Date.parse(c.at))) continue;
    const list = byChan.get(c.channelId);
    if (list) list.push(c);
    else byChan.set(c.channelId, [c]);
  }

  const items: (FeeOutcome & { beforeRate: number; afterRate: number; marketDelta: number })[] = [];
  let pending = 0;
  let tooClose = 0;
  for (const [id, list] of byChan) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const series = byChannel.get(id) ?? empty;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.fromPpm === c.toPpm) continue;
      const t = Date.parse(c.at);
      if (nowMs - t > LOOKBACK_DAYS * DAY) continue;
      const prev = i > 0 ? Date.parse(list[i - 1].at) : -Infinity;
      const next = i + 1 < list.length ? Date.parse(list[i + 1].at) : Infinity;
      const from = Math.max(prev, t - W);
      const to = Math.min(next, t + W, nowMs);
      if (to - t < MIN) {
        // Cut short by the next change, or simply too recent (yet).
        if (next - t < MIN) tooClose += 1;
        else pending += 1;
        continue;
      }
      if (t - from < MIN) {
        tooClose += 1;
        continue;
      }
      const before = series.over(from, t);
      const after = series.over(t, to);
      const nodeBefore = node.over(from, t);
      const nodeAfter = node.over(t, to);
      const beforeDays = (t - from) / DAY;
      const afterDays = (to - t) / DAY;
      const beforeRate = before.msat / beforeDays;
      const afterRate = after.msat / afterDays;
      // Difference-in-differences: the rest of the node over the same two
      // intervals, so a market-wide swing isn't credited to this change.
      const exBeforeRate = (nodeBefore.msat - before.msat) / beforeDays;
      const exAfterRate = (nodeAfter.msat - after.msat) / afterDays;
      const marketDelta = exBeforeRate > 0 ? exAfterRate / exBeforeRate - 1 : 0;
      items.push({
        channelId: id,
        alias: c.alias || id,
        at: c.at,
        fromPpm: c.fromPpm,
        toPpm: c.toPpm,
        raised: c.toPpm > c.fromPpm,
        via: c.via,
        beforeDays: round1(beforeDays),
        afterDays: round1(afterDays),
        beforeDailyAvgSat: round1(beforeRate / 1000),
        afterDailyAvgSat: round1(afterRate / 1000),
        forwardsBefore: before.count,
        forwardsAfter: after.count,
        deltaPct: beforeRate > 0 ? round2(afterRate / beforeRate - 1 - marketDelta) : null,
        measurable: (beforeRate / 1000) * 7 >= MIN_BEFORE_SAT_PER_WEEK,
        beforeRate,
        afterRate,
        marketDelta,
      });
    }
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  const counted = items.filter((f) => f.measurable && f.deltaPct !== null);
  const sumBefore = counted.reduce((s, f) => s + f.beforeRate, 0);
  const sumGain = counted.reduce((s, f) => s + (f.afterRate - f.beforeRate * (1 + f.marketDelta)), 0);
  const n = counted.length;
  const avg = n >= MIN_MEASURED && sumBefore > 0 ? round2(sumGain / sumBefore) : null;
  const confidence: OutcomesReport["fees"]["confidence"] = n >= 3 * MIN_MEASURED ? "medium" : n >= MIN_MEASURED ? "low" : "none";
  const note =
    n < MIN_MEASURED
      ? `${n} of ${items.length} measured change${items.length === 1 ? "" : "s"} had enough revenue before to judge ` +
        `(≥ ${MIN_BEFORE_SAT_PER_WEEK} sat/week) — at least ${MIN_MEASURED} are needed for a result`
      : `weighted by revenue over ${n} changes, net of the rest of the node's move — ` +
        (confidence === "low" ? "few changes, low confidence" : "indicative only; single changes are noisy");
  return {
    windowDays: FEE_WINDOW_DAYS,
    measured: items.length,
    measurable: n,
    pending,
    tooClose,
    raises: items.filter((f) => f.raised).length,
    cuts: items.filter((f) => !f.raised).length,
    avgRevenueDeltaPct: avg,
    minMeasured: MIN_MEASURED,
    confidence,
    note,
    // All of them: the learner needs every sample (the report trims its copy).
    items: items.map(({ beforeRate: _b, afterRate: _a, marketDelta: _m, ...f }) => f),
  };
}

export async function getAutopilotOutcomes(
  lnd: AuthenticatedLnd,
  feeChanges: FeeChangeRecord[],
  rebalanceRecords: RebalanceRecord[],
  opts: { rebalanceWindowDays?: number; lookbackDays?: number } = {},
): Promise<OutcomesReport> {
  const rebWin = opts.rebalanceWindowDays ?? 14;
  const lookback = (opts.lookbackDays ?? LOOKBACK_DAYS) * DAY;
  // 60 days of changes, each measured against up to 14 days before it.
  const events = await getForwardEvents(lnd, LOOKBACK_DAYS + FEE_WINDOW_DAYS + 1);
  const now = Date.now();
  const measuredFees = measureFeeChanges(feeChanges, events, now);
  const fees = { ...measuredFees, items: measuredFees.items.slice(0, 50) };

  // ── Rebalance realized ROI ──
  const { byChannel } = seriesOf(events);
  const rebItems: RebalanceOutcome[] = [];
  for (const r of rebalanceRecords) {
    if (!r.ok || !r.feeSats || r.feeSats <= 0) continue;
    const at = new Date(r.at).getTime();
    // Require a full after-window before judging.
    if (now - at < rebWin * DAY || now - at > lookback) continue;
    const revenueAfter = (byChannel.get(r.targetId)?.over(at, at + rebWin * DAY).msat ?? 0) / 1000;
    rebItems.push({
      targetId: r.targetId,
      alias: r.targetAlias || r.targetId,
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

// ── Elasticity learner ────────────────────────────────────────────────────────

export interface ChannelElasticity {
  /** Multiplier on the fee aim and the raise step — >1 = inelastic (charge
   *  more), <1 = elastic. Only present when the evidence passes the gate. */
  modifier: number;
  /** -0.5..0.5: did charging more help revenue (after shrinkage)? */
  signal: number;
  samples: number;
}

const clampEl = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Changes on a channel before its own evidence counts at all. */
export const LEARN_MIN_SAMPLES = 4;
/** Forwards needed in BOTH intervals for a change to be a sample. */
export const LEARN_MIN_FORWARDS = 10;
/** Pull toward the node-wide signal: a channel's own mean gets weight
 *  n / (n + SHRINK). */
const SHRINK = 4;

/**
 * Per-channel fee elasticity from measured outcomes — gated so noise cannot
 * move a fee (review a1: with 2 samples, zero true effect gave a modifier of
 * 10% or more on 7 in 10 channels).
 *
 * A change is a sample only with LEARN_MIN_FORWARDS forwards before AND after
 * it and enough revenue before. A channel gets a modifier only with at least
 * LEARN_MIN_SAMPLES samples that all point the same way, and a mean at least
 * twice its standard error. Its signal is shrunk toward the node-wide mean of
 * all samples (one node-level elasticity, per-channel deviations). Channels
 * without such evidence get nothing — the engine prices them exactly as if
 * there were no learner. A modifier above 1 never removes the raise cap: it
 * only widens each raise step a little (feeRecommend.ts).
 */
export function feeElasticityFromOutcomes(items: FeeOutcome[]): Map<string, ChannelElasticity> {
  const scoresBy = new Map<string, number[]>();
  const all: number[] = [];
  for (const f of items) {
    if (f.deltaPct == null || !f.measurable) continue;
    if (f.forwardsBefore < LEARN_MIN_FORWARDS || f.forwardsAfter < LEARN_MIN_FORWARDS) continue;
    // > 0: charging more lifted revenue (or charging less lost it).
    const score = clampEl(f.raised ? f.deltaPct : -f.deltaPct, -1, 1);
    all.push(score);
    const list = scoresBy.get(f.channelId);
    if (list) list.push(score);
    else scoresBy.set(f.channelId, [score]);
  }
  const prior = all.length >= 2 * LEARN_MIN_SAMPLES ? all.reduce((a, b) => a + b, 0) / all.length : 0;
  const out = new Map<string, ChannelElasticity>();
  for (const [id, scores] of scoresBy) {
    const n = scores.length;
    if (n < LEARN_MIN_SAMPLES) continue;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    if (mean === 0 || !scores.every((s) => Math.sign(s) === Math.sign(mean))) continue;
    const sd = Math.sqrt(scores.reduce((a, s) => a + (s - mean) ** 2, 0) / (n - 1));
    if (Math.abs(mean) < 2 * (sd / Math.sqrt(n))) continue;
    const w = n / (n + SHRINK);
    const signal = clampEl(w * mean + (1 - w) * prior, -0.5, 0.5);
    const modifier = Math.round(clampEl(1 + signal * 0.5, 0.8, 1.25) * 100) / 100;
    if (modifier === 1) continue;
    out.set(id, { modifier, signal: Math.round(signal * 100) / 100, samples: n });
  }
  return out;
}

/** Per-channel fee elasticity from the node's forwards and the fee-change log. */
export async function getFeeElasticity(
  lnd: AuthenticatedLnd,
  feeChanges: FeeChangeRecord[],
): Promise<Map<string, ChannelElasticity>> {
  const events = await getForwardEvents(lnd, LOOKBACK_DAYS + FEE_WINDOW_DAYS + 1);
  return feeElasticityFromOutcomes(measureFeeChanges(feeChanges, events).items);
}
