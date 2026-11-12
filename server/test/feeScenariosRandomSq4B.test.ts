/**
 * The fee rules over weeks with buyers who come at random (the package's
 * second review, R11; helpers/feeRandom.ts): buyers who buy less with the square of the fee, 4 sales of 50k a day at 100 ppm, from 100 ppm on a
 * balanced 5M channel with a month of sales, 120 days. Each seed is a
 * different run of the same buyers. Held against the start fee held flat on
 * the same draws. Every raise truly earns less. With twelve sales in 72 h a single judgement is mostly chance: before the second review 10 to 29 % less than flat, now 5 to 21 % — what is left is for the owner to weigh (P3b report). The bound holds what the rules do now; it is no target.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUYERS, at, flatRevenue, randomRun } from "./helpers/feeRandom.js";
import { report, told } from "./helpers/feeSim.js";

for (const seed of [4, 5]) {
  test(`buyers who buy less the more it costs, 4 a day seed ${seed}: it earns at least three quarters of the start fee held flat and does not climb away`, async (t) => {
    const b = BUYERS.sq4;
    const r = await randomRun(t, b, seed);
    report(`sq4 ${seed}`, "buyers who buy less with the square of the fee, 4 sales of 50k a day at 100 ppm, seed ${seed}", r, 10);
    for (const day of [90, 120]) {
      const now = at(r, day);
      const flat = flatRevenue(b, seed, day);
      assert.ok(now.revenue >= 0.75 * flat, `day ${day}: ${now.revenue} against ${flat} flat\n${told(r, 10)}`);
      assert.ok(now.fee <= 160, told(r, 10));
      assert.ok(now.gaps <= 14, told(r, 10));
      assert.ok(now.changes <= 32, told(r, 10));
    }
  });
}
