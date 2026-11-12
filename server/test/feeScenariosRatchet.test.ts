/**
 * The fee rules over weeks (the package's second review, Q1; see
 * feeScenariosIdle.test.ts for the set): buyers who buy less the more it
 * costs — 200k sat a day at 100 ppm, (100/fee)² of that at another fee, so
 * 100 ppm earns the most — on a balanced 5M channel at 100 ppm; what flows
 * back follows the balance. One buyer takes 400k or 800k on day 5. The drain
 * rules raise the fee for it (the drain ramp); the channel is back at half
 * local within days. Before, "a fee that sells is kept" held the raised fee
 * for the remaining 55 days: 120 or 150 ppm, and the regular buyers paid a
 * sixth and three tenths less. A raise the drain rules made is now judged at
 * the end of its first week as part of a climb, once the drain is over.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, type SimOpts, type SimResult } from "./helpers/feeSim.js";

const buyers = (replay: SimOpts["replay"]): SimOpts => ({
  days: 60,
  warmDays: 30,
  extra: 5,
  chunk: 50_000,
  localStart: 2_500_000,
  feeStart: 100,
  outRate: (fee) => 200_000 * (100 / fee) ** 2,
  inRate: (_d, ratio) => 200_000 * (ratio > 0.52 ? 0.3 : ratio < 0.48 ? 1.7 : 1),
  replay,
});
/** What the burst paid (sold at the fee it met), taken off what the run earned. */
const regular = (r: SimResult, burst: number, at: number): number => r.revenueSats - (burst * at) / 1e6;

test("with no burst the fee stays at the price its buyers pay most at: each try above it earns less and is taken back", async (t) => {
  const r = await simulate(t, buyers([]));
  report("R0", "elastic buyers at their best price, no burst, 60 d", r, 10);
  assert.ok(r.daily.filter((d) => d.day >= 10).every((d) => d.fee <= 110), told(r, 10));
  assert.ok(r.revenueSats >= 1_150, told(r, 10));
});

for (const [name, burst, start] of [
  ["400k", 400_000, [{ atHour: 120, out: 400_000 }]],
  ["800k", 800_000, [{ atHour: 120, out: 400_000 }, { atHour: 121, out: 400_000 }]],
] as const) {
  test(`one buyer takes ${name} on day 5: the drain ramp's raise is taken back once the channel is balanced again and the raise earned less — not held for good (before: held at 120 or 150 ppm to the end, the regular buyers paying a sixth and three tenths less)`, async (t) => {
    const r = await simulate(t, buyers([...start]));
    report(`R${name}`, `elastic buyers at their best price, one buyer takes ${name} on day 5, 60 d`, r, 10);
    // Raised for the burst…
    assert.ok(r.changes.some((c) => c.day >= 5 && c.day < 6 && c.to > c.from && /^drain: /.test(c.why)), told(r, 10));
    // …and back at the buyers' price within two weeks, by the climb's check.
    assert.ok(r.changes.some((c) => c.day < 20 && c.to === 100 && /by the drain rules/.test(c.why)), told(r, 10));
    assert.ok(r.daily.filter((d) => d.day >= 20).every((d) => d.fee <= 110), told(r, 10));
    assert.equal(r.finalPpm <= 110, true, told(r, 10));
    // What the regular buyers paid: at least nine tenths of the run without a burst.
    assert.ok(regular(r, burst, 100) >= 1_050, told(r, 10));
  });
}

test("one buyer empties the channel on day 5 (2.2M, to under 10 % local): the raises on the way — the drain ramp, the protect ramp, the velocity nudges — are one climb, taken back once the channel is balanced again (the review's second round, N1 — before: 200 ppm for 38 days, the regular buyers paying 40 % less)", async (t) => {
  const r = await simulate(t, buyers([{ atHour: 120, out: 1_100_000 }, { atHour: 121, out: 1_100_000 }]));
  report("Rempty", "elastic buyers at their best price, one buyer takes 2.2M on day 5, 60 d", r, 10);
  assert.ok(r.changes.some((c) => c.day >= 5 && c.day < 7 && /^protect: /.test(c.why)), told(r, 10));
  assert.ok(r.changes.some((c) => c.day < 35 && c.to === 100 && /by the drain rules/.test(c.why)), told(r, 10));
  assert.ok(r.daily.filter((d) => d.day >= 35).every((d) => d.fee <= 110), told(r, 10));
  assert.ok(regular(r, 2_200_000, 100) >= 950, told(r, 10));
});
