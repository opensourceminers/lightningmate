/**
 * The fee rules over weeks (review 2026-11-10, package P3; see
 * feeScenariosIdle.test.ts for the set): a channel with a month of sales at
 * its fee on the books, on a node with seven channels, routing 200k sat a day
 * in each direction at whatever fee. The fee that sells is kept (review
 * FEE-2) and, where the channel holds no more than its target, tried upward
 * at most every three days (decision E1). "before:" is the engine before the
 * package.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, loweringsOf, gapsOf } from "./helpers/feeSim.js";

const established = { warmDays: 30, extra: 5, outRate: () => 200_000, inRate: () => 200_000 };

test("a balanced channel with a month of sales at 300 ppm is never lowered (before: walked down to 90 ppm in seven moves, 842 sat in 40 days; now over 4,000)", async (t) => {
  const r = await simulate(t, { days: 40, localStart: 2_500_000, feeStart: 300, ...established });
  report("T1", "50 % local at 300 ppm, 30 d of sales at 300; 200k/day both ways, 40 d", r, 5);
  assert.equal(loweringsOf(r).length, 0, told(r));
  assert.ok(gapsOf(r.changes).every((g) => g >= 3), told(r));
  assert.ok(r.revenueSats >= 4_000, told(r));
});

test("one that sells at 40 ppm is tried upward instead of left at 40 for good (before: no change, 478 sat in 60 days; now over 1,400)", async (t) => {
  const r = await simulate(t, { days: 60, localStart: 2_500_000, feeStart: 40, ...established });
  report("T2", "50 % local at 40 ppm, 30 d of sales at 40; 200k/day both ways, 60 d", r, 10);
  assert.equal(loweringsOf(r).length, 0, told(r, 10));
  assert.ok(gapsOf(r.changes).every((g) => g >= 3), told(r, 10));
  assert.ok(r.finalPpm >= 150, told(r, 10));
  assert.ok(r.revenueSats >= 1_400, told(r, 10));
});

test("at 75 % local a channel that sells 200k sat a day at 300 ppm keeps 300 ppm (before: lowered to 60 ppm in eight moves, 645 sat in 40 days; now over 2,300)", async (t) => {
  const r = await simulate(t, { days: 40, localStart: 3_750_000, feeStart: 300, ...established });
  report("T3", "75 % local at 300 ppm, 30 d of sales at 300; 200k/day both ways, 40 d", r, 5);
  assert.equal(r.changes.length, 0, told(r));
  assert.equal(r.finalPpm, 300);
  assert.ok(r.revenueSats >= 2_300, told(r));
});
