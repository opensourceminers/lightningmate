/**
 * The fee rules over weeks with buyers who come at random (the package's
 * second review, R11; helpers/feeRandom.ts): buyers who pay any price, 4 sales of 50k a day, from 100 ppm on a
 * balanced 5M channel with a month of sales, 120 days. Each seed is a
 * different run of the same buyers. Held against the start fee held flat on
 * the same draws. Every price test truly earns a tenth more: the rules must climb, and earn more than the start fee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUYERS, at, flatRevenue, randomRun } from "./helpers/feeRandom.js";
import { report, told } from "./helpers/feeSim.js";

for (const seed of [4, 5]) {
  test(`buyers who pay any price, 4 a day seed ${seed}: it earns more than the start fee held flat, on every day 90 and 120, with few days without a sale`, async (t) => {
    const b = BUYERS.any4;
    const r = await randomRun(t, b, seed);
    report(`any4 ${seed}`, "buyers who pay any price, 4 sales of 50k a day, seed ${seed}", r, 10);
    for (const day of [90, 120]) {
      const now = at(r, day);
      const flat = flatRevenue(b, seed, day);
      assert.ok(now.revenue >= 1.05 * flat, `day ${day}: ${now.revenue} against ${flat} flat\n${told(r, 10)}`);
      assert.ok(now.fee > 100, told(r, 10));
      assert.ok(now.gaps <= 3, told(r, 10));
      assert.ok(now.changes <= (day === 90 ? 28 : 32), told(r, 10));
    }
  });
}
