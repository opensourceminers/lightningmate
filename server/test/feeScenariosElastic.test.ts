/**
 * The fee rules over weeks (review 2026-11-10, package P3; see
 * feeScenariosIdle.test.ts for the set): buyers who buy less the more it
 * costs — 400k sat a day at 0 ppm, half of that for every 100 ppm more, so
 * the fee that earns most is about 144 ppm (~21 sat a day) — on a balanced
 * channel with a month of sales at its start fee. What flows back is what it
 * sold a day at the start fee.
 *
 * Decision E1 (othervice, 2026-11-10): a channel that sells at its fee keeps
 * it; a higher fee is tried in small steps and taken back when it earns less.
 * No lower fee is tried on a channel that sells — so from 300 ppm the engine
 * does not find the 144. "before:" is the engine before the package.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, raisesOf, loweringsOf, stepBacksOf, gapsOf, feeOn } from "./helpers/feeSim.js";

const vol = (fee: number) => 400_000 * Math.pow(0.5, fee / 100);
const elastic = (start: number) => ({ days: 60, warmDays: 30, chunk: 20_000, localStart: 2_500_000, feeStart: start, outRate: (fee: number) => vol(fee), inRate: () => vol(start) });

test("from 300 ppm a higher fee is tried, earns less in its first 72 h and is taken back to 300 — and tried again later each time (before: 18 fee changes in 60 days, ending at 360 ppm)", async (t) => {
  const r = await simulate(t, elastic(300));
  report("U4 start 300", "elastic demand 400k*0.5^(fee/100) per day, start 300 ppm", r, 10);
  // Never under 300, and at 330 only for the three days of a test.
  assert.ok(r.daily.every((d) => d.fee >= 300) && r.finalPpm <= 330, told(r, 10));
  assert.ok(r.changes.length <= 8, told(r, 10));
  assert.ok(stepBacksOf(r).length >= 3 && stepBacksOf(r).every((c) => c.to === 300 && /it earned less in its first 72 h/.test(c.why)), told(r, 10));
  assert.equal(loweringsOf(r).length, stepBacksOf(r).length, told(r, 10));
  // Each test is judged once, three days after it began.
  assert.ok(stepBacksOf(r).every((c) => raisesOf(r).some((up) => Math.abs(c.day - up.day - 3) < 0.1)), told(r, 10));
  // The memory of a failed try grows: 7 days, then 14, then 28.
  const waits = gapsOf(raisesOf(r));
  assert.ok(waits.length >= 3 && waits[0] >= 7 && waits[1] >= 14 && waits[2] >= 28, told(r, 10));
  // What the tests cost: 300 ppm held for the 60 days earns 900 sat.
  assert.ok(r.revenueSats >= 860 && r.revenueSats <= 900, told(r, 10));
});

test("from 40 ppm the fee is tried upward to 80 in ten days and comes down again only once the channel has filled up (before: left at 40 ppm, 726 sat in 60 days; now over 850)", async (t) => {
  const r = await simulate(t, elastic(40));
  report("U4 start 40", "elastic demand 400k*0.5^(fee/100) per day, start 40 ppm", r, 10);
  assert.equal(feeOn(r, 10), 80, told(r, 10));
  assert.ok(loweringsOf(r).length >= 1 && loweringsOf(r).every((c) => c.local >= 75), told(r, 10));
  assert.ok(r.revenueSats >= 850, told(r, 10));
  assert.equal(r.daysWithoutSale, 0);
});
