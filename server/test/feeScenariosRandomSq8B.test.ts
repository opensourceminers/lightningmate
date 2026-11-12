/**
 * The fee rules over weeks with buyers who come at random (the package's
 * second review, R11; helpers/feeRandom.ts): buyers who buy less with the square of the fee, 8 sales of 25k a day at 100 ppm, from 100 ppm on a
 * balanced 5M channel with a month of sales, 120 days. Each seed is a
 * different run of the same buyers. Held against the start fee held flat on
 * the same draws. Every raise truly earns less (income ∝ 1 / fee): the rules must stay near 100 ppm. Before the second review: 1 to 17 % less than flat; now within a tenth.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUYERS, at, flatRevenue, randomRun } from "./helpers/feeRandom.js";
import { report, told } from "./helpers/feeSim.js";

for (const seed of [4, 5]) {
  test(`buyers who buy less the more it costs, 8 a day seed ${seed}: it earns at least nine tenths of the start fee held flat and ends near it`, async (t) => {
    const b = BUYERS.sq8;
    const r = await randomRun(t, b, seed);
    report(`sq8 ${seed}`, "buyers who buy less with the square of the fee, 8 sales of 25k a day at 100 ppm, seed ${seed}", r, 10);
    for (const day of [90, 120]) {
      const now = at(r, day);
      const flat = flatRevenue(b, seed, day);
      assert.ok(now.revenue >= 0.9 * flat, `day ${day}: ${now.revenue} against ${flat} flat\n${told(r, 10)}`);
      assert.ok(now.fee <= 120, told(r, 10));
      assert.equal(now.gaps, 0, told(r, 10));
      assert.ok(now.changes <= 24, told(r, 10));
    }
  });
}
