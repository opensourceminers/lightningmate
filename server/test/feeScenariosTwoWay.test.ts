/**
 * The fee rules over weeks (review 2026-11-10, package P3; see
 * feeScenariosIdle.test.ts for the set): a channel that routes 200k sat a day
 * in each direction from the day the autopilot first sees it, at whatever fee
 * (its buyers are not price-sensitive). Before the package a fee that sold
 * was lowered toward the balanced level or Min ppm all the same (review
 * FEE-2); now it is kept, and where the channel holds no more than its target
 * a higher fee is tried in small steps (decision E1). "before:" is the engine
 * before the package.
 *
 * The one lowering on day 0 is the first run's: the autopilot has no sale on
 * its books yet and takes the channel for idle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, movesOf, loweringsOf } from "./helpers/feeSim.js";

const bothWays = { outRate: () => 200_000, inRate: () => 200_000 };

test("a balanced channel that sells at 40 ppm is not lowered to Min ppm: its fee is tried upward a step at a time (before: 25 ppm for the 60 days, 299 sat; now over 1,300)", async (t) => {
  const r = await simulate(t, { days: 60, localStart: 2_500_000, feeStart: 40, ...bothWays });
  report("S5a", "50 % local at 40 ppm; 200k/day both ways (any price), 60 d", r, 10);
  assert.ok(loweringsOf(r).every((c) => c.day === 0), told(r, 10));
  assert.ok(r.revenueSats >= 1_300, told(r, 10));
  assert.ok(r.finalPpm >= 150, told(r, 10));
  assert.equal(r.daysWithoutSale, 0);
});

test("a balanced channel that sells at 300 ppm is not walked down to the balanced level (before: 90 ppm, 1,202 sat in 60 days; now over 6,500)", async (t) => {
  const r = await simulate(t, { days: 60, localStart: 2_500_000, feeStart: 300, ...bothWays });
  report("S5b", "50 % local at 300 ppm; 200k/day both ways (any price), 60 d", r, 10);
  assert.ok(loweringsOf(r).every((c) => c.day === 0), told(r, 10));
  assert.ok(r.revenueSats >= 6_500, told(r, 10));
  // Buyers who pay anything: the tries end at Max ppm, not above it.
  assert.ok(r.finalPpm >= 900 && r.daily.every((d) => d.fee <= 1_000), told(r, 10));
});

test("at 70 % local the same channel keeps the fee it sells at — it is neither lowered for its balance nor tried upward (before: 90 ppm after seven moves, 1,202 sat; now over 3,000)", async (t) => {
  const r = await simulate(t, { days: 60, localStart: 3_500_000, feeStart: 300, ...bothWays });
  report("S5c", "70 % local at 300 ppm; 200k/day both ways (any price), 60 d", r, 10);
  assert.deepEqual(movesOf(r), [[300, 270]], told(r, 10));
  assert.ok(r.revenueSats >= 3_000, told(r, 10));
});
