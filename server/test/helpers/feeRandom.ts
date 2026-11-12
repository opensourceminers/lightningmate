/**
 * Buyers who come at random (the package's second review, R11): a sale of
 * `chunk` sats in an hour with probability perDay(fee) / 24, on the real
 * autopilot (feeSim.ts). What flows back follows the balance. Seeded, so a
 * run is the same every time.
 */
import { simulate, type SimResult } from "./feeSim.js";
import type { TestContext } from "node:test";

/** mulberry32: a small seeded generator. */
export const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export interface Buyers {
  chunk: number;
  /** Sales a day at a fee. */
  perDay: (fee: number) => number;
}
/** Buyers who pay any price (every raise earns more), and buyers who buy
 *  less with the square of the fee (the income falls as 1 / fee: every raise
 *  earns less). */
export const BUYERS: Record<"any4" | "any8" | "sq4" | "sq8", Buyers> = {
  any4: { chunk: 50_000, perDay: () => 4 },
  any8: { chunk: 25_000, perDay: () => 8 },
  sq4: { chunk: 50_000, perDay: (f) => 4 * (100 / f) ** 2 },
  sq8: { chunk: 25_000, perDay: (f) => 8 * (100 / f) ** 2 },
};
export const START_PPM = 100;
export const DAYS = 120;
const HOURS_PER_STEP = 1;

/** The run on the autopilot, from 100 ppm on a balanced 5M channel with a month of sales. */
export function randomRun(t: TestContext, b: Buyers, seed: number): Promise<SimResult> {
  const r = rng(seed);
  return simulate(t, {
    days: DAYS,
    warmDays: 30,
    extra: 5,
    chunk: b.chunk,
    localStart: 2_500_000,
    feeStart: START_PPM,
    outRate: (fee, day) => (day === 0 ? b.perDay(fee) * b.chunk : r() < b.perDay(fee) / 24 ? b.chunk * 24 : 0),
    inRate: (_d, ratio) => 200_000 * (ratio > 0.52 ? 0.3 : ratio < 0.48 ? 1.7 : 1),
  });
}

/** What the start fee held flat earns over `days` from the same draws (the
 *  channel never runs short of sats at it: what flows back follows the
 *  balance). One draw an hour after the first, as the run makes them. */
export function flatRevenue(b: Buyers, seed: number, days: number, fee = START_PPM): number {
  const r = rng(seed);
  let sales = 0;
  const steps = Math.round((days * 24) / HOURS_PER_STEP);
  for (let i = 1; i < steps + 1; i++) if (r() < b.perDay(fee) / 24) sales += 1;
  return (sales * b.chunk * fee) / 1e6;
}

/** Revenue, final fee, changes and days without a sale at `day` of a run. */
export function at(r: SimResult, day: number) {
  const rows = r.daily.filter((d) => d.day <= day);
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].soldSats === rows[i - 1].soldSats) gaps += 1;
  return { revenue: rows[rows.length - 1].revenueSats, fee: rows[rows.length - 1].fee, changes: r.changes.filter((c) => c.day < day).length, gaps };
}
