/**
 * The fee rules over weeks (review 2026-11-10, package P3; see
 * feeScenariosIdle.test.ts for the set): one buyer takes most of a channel in
 * a few hours, then it is quiet. Before the package the channel went to
 * Protect ppm on its balance alone and stayed there — the sats left in it, and
 * the ones that came back, stood at a price its regular buyers never paid
 * (review FEE-1: 350k sat at 340 ppm for good). "before:" is that engine.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, feeOn } from "./helpers/feeSim.js";

test("a burst that empties a channel is priced while it buys, and the empty channel is not raised afterwards: nothing sold says what the next sats are worth (before: raised to 350 ppm over the following days)", async (t) => {
  const r = await simulate(t, {
    days: 60,
    localStart: 2_500_000,
    feeStart: 80,
    outRate: (fee, day) => (day >= 5 && day < 6 && fee <= 600 ? 5_000_000 : 0),
  });
  report("S2a", "50 % local at 80 ppm; day 5 burst takes everything; then silence, 60 d", r);
  assert.equal(r.soldSats, 2_450_000, told(r));
  assert.ok(r.revenueSats >= 200, told(r)); // before: 111
  assert.ok(r.changes.every((c) => c.day < 6), told(r));
  assert.ok(r.finalPpm <= 200, told(r));
});

test("a burst that leaves 8 % local and then silence: the raise made after it is taken back when nobody buys, and the 350k sat left are offered at the fee that sold (before: 340 ppm to the end of the 90 days)", async (t) => {
  let sold = 0;
  const r = await simulate(t, {
    days: 90,
    warmDays: 30,
    localStart: 2_500_000,
    feeStart: 80,
    outRate: (_fee, day) => {
      if (day < 0.01) return 100_000; // its history: 100k sat a day
      if (day >= 5 && sold < 2_100_000) {
        sold += 2_100_000 / 6; // over six hourly runs
        return 2_100_000 * 4;
      }
      return 0;
    },
  });
  report("T4", "50 % local at 80 ppm, sold 100k/day before; day 5 a burst takes 2.1M (8 % left); then silence, 90 d", r, 10);
  assert.ok(feeOn(r, 20) <= 100, told(r, 10));
  assert.ok(r.finalPpm <= 100, told(r, 10));
  assert.ok(r.changes.length <= 8, told(r, 10));
});

// Regular buyers pay up to 150 ppm for 100k sat a day; on day 2 one buyer who
// pays anything takes 2.1M sat.
const lock = (burst = { taken: 0 }) => (fee: number, day: number) => {
  if (day < 0.01) return 100_000;
  if (day >= 2 && burst.taken < 2_100_000) {
    burst.taken += 2_100_000 / 6;
    return 2_100_000 * 4;
  }
  return day < 2 ? 0 : fee <= 150 ? 100_000 : 0;
};

test("after such a burst the regular buyers still get what is left: the fee comes back under their 150 ppm and the channel sells out (before: locked at 340 ppm with 350k sat unsold for 117 days)", async (t) => {
  const r = await simulate(t, { days: 120, warmDays: 30, localStart: 2_500_000, feeStart: 80, outRate: lock() });
  report("U2", "buyers pay <= 150 ppm (100k/day); day 2 a burst takes 2.1M (8 % left), 120 d", r, 10);
  assert.equal(r.soldSats, 2_450_000, told(r, 10)); // before: 2,100,000
  assert.ok(r.revenueSats >= 280, told(r, 10)); // before: 203
});

test("and with 10k sat a day flowing back, what comes back is sold on at their price (before: 103 of 120 days without a sale, now under 30)", async (t) => {
  const r = await simulate(t, { days: 120, warmDays: 30, localStart: 2_500_000, feeStart: 80, chunk: 10_000, inRate: () => 10_000, outRate: lock() });
  report("U3", "as U2 with 10k/day inflow, 120 d", r, 10);
  assert.ok(r.soldSats >= 3_500_000, told(r, 10)); // before: 3,110,000
  assert.ok(r.daysWithoutSale <= 30, told(r, 10));
  assert.ok(r.revenueSats >= 430, told(r, 10)); // before: 336
});
