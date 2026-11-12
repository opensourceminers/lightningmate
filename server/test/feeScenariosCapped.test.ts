/**
 * The fee rules over weeks (review 2026-11-10, package P3; see
 * feeScenariosIdle.test.ts for the set): buyers who pay up to a price and
 * nothing above it, on a balanced channel with a month of sales at its start
 * fee, as much flowing back as it sells. Two sales a day, four, or one — the
 * rules must not depend on how the same sats are cut into payments.
 *
 * What is asked of them (decision E1): the fee is tried upward to the price
 * the buyers pay, the try above it is taken back and made again after 7, 14
 * and 28 days, and the fee is never walked down from a price that sells. The
 * numbers to hold against are what a flat fee earns.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, raisesOf, loweringsOf, stepBacksOf, type SimOpts } from "./helpers/feeSim.js";

/** Buyers who take `perDay` sats a day at up to `cap` ppm, in payments of
 *  `chunk`. What flows back follows what sold (less into a channel above its
 *  middle, more into one below): the days of a try nobody buys at don't fill
 *  the channel up. */
const capped = (cap: number, perDay: number, chunk: number, feeStart: number, days: number): SimOpts => ({
  days,
  warmDays: 30,
  extra: 5,
  chunk,
  localStart: 2_500_000,
  feeStart,
  outRate: (fee) => (fee <= cap ? perDay : 0),
  inRate: (_day, ratio) => perDay * (ratio > 0.52 ? 0.3 : ratio < 0.48 ? 1.7 : 1),
});

/** The fee stays at `cap` or at the try one step above it, every lowering is
 *  a step-back, and the try above is made `tries` times at most. */
const staysAt = (r: Awaited<ReturnType<typeof simulate>>, cap: number, above: number, fromDay: number, tries: number): boolean =>
  r.daily.filter((d) => d.day >= fromDay).every((d) => d.fee === cap || d.fee === above) &&
  loweringsOf(r).length === stepBacksOf(r).length &&
  raisesOf(r).filter((c) => c.to === above).length <= tries;

for (const [name, chunk] of [
  ["two sales a day", 50_000],
  ["four sales a day", 25_000],
] as const) {
  // (Before: 19 fee changes and 805 sat, back at 80 ppm again and again. A
  // flat 80 ppm earns 720 sat, a flat 110 ppm 990.)
  test(`buyers who pay up to 110 ppm, ${name}, from 80 ppm: the fee is tried up to 110 and stays there — the try above it is taken back and made again later each time, and the fee that sells is not walked down`, async (t) => {
    const r = await simulate(t, capped(110, 100_000, chunk, 80, 90));
    report(`K1 cap 110, ${name}`, "buyers pay up to 110 ppm, 100k a day, start 80 ppm", r, 10);
    assert.ok(staysAt(r, 110, 120, 20, 4), told(r, 10));
    assert.equal(r.finalPpm, 110, told(r, 10));
    assert.ok(r.changes.length <= 13 && r.revenueSats >= 830, told(r, 10));
  });

  // (Before: 1,691 sat — the climb to 330 was taken back whole for the dead
  // days of the try at 360. A flat 300 ppm earns 3,600 sat in these 60 days:
  // each try nobody buys at costs two days' sales, three of them here.)
  test(`buyers who pay up to 330 ppm, ${name}, from 300 ppm: 330 is found and kept — 360 is tried, taken back after two days without a sale, and tried again later each time`, async (t) => {
    const r = await simulate(t, capped(330, 200_000, chunk * 2, 300, 60));
    report(`K2 cap 330, ${name}`, "buyers pay up to 330 ppm, 200k a day, start 300 ppm", r, 10);
    assert.ok(staysAt(r, 330, 360, 16, 4), told(r, 10));
    assert.ok(r.changes.length <= 9 && r.revenueSats >= 3_350, told(r, 10));
  });
}

test("buyers who pay up to 300 ppm, one sale a day, from 300 ppm: under six sales in three days no higher fee is tried — the fee stays and every day sells", async (t) => {
  const r = await simulate(t, capped(300, 50_000, 50_000, 300, 90));
  report("K3 cap 300, one sale a day", "buyers pay up to 300 ppm, 50k a day, start 300 ppm", r, 10);
  assert.ok(r.changes.length === 0 && r.daysWithoutSale === 0 && r.revenueSats >= 1_330, told(r, 10));
});
