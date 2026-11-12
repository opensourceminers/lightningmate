/**
 * The fee rules over weeks (review 2026-11-10, package P3; see
 * feeScenariosIdle.test.ts for the set): three cases seen on a live node,
 * replayed forward by forward — every forward at its own time and size, the
 * autopilot at the live node's settings (a run every 30 minutes, six hours
 * between two changes of one fee). The sizes are rounded and the times are
 * relative to the start: a node's forwarding history is not public, this
 * file is.
 *
 * "before:" is the engine before the package, on the same replay — close to
 * what the live node did: 157 sat for the 4.3M sat of the first case and the
 * fee raised to 340 ppm on the emptied channel; in the second the fee lowered
 * to 50 ppm a quarter of an hour after the inflow, and 60 sat for the 1.2M
 * sat. The third case is the same before and after: what that channel lacks
 * is sats, not a price (the rebalancer's side, package P4) — it is here so
 * that it stays so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, loweringsOf, raisesOf, stepBacksOf, type SimForward } from "./helpers/feeSim.js";

const hour = (day: number, clock: string): number => {
  const [h, m] = clock.split(":").map(Number);
  return day * 24 + h + m / 60;
};
/** Forwards of the given sizes (in thousand sats), `everySec` seconds apart: the parts of one payment, as they arrive. */
const parts = (day: number, clock: string, kSats: number[], dir: "out" | "in" = "out", everySec = 8): SimForward[] =>
  kSats.map((k, i) => ({ atHour: hour(day, clock) + (i * everySec) / 3600, [dir]: Math.round(k * 1_000) }));
const live = { intervalMinutes: 30, cooldownMinutes: 360 };

// A 5M channel we opened, nearly full at 30 ppm, to a peer that charges 200
// ppm back while others charge about 500 into it: a refill costs about 700.
// One buyer takes 4.3M sat of it in two evenings, in payments of many parts
// minutes apart.
const soldOut: SimForward[] = [
  ...parts(-6, "11:00", [50, 100]),
  ...parts(2, "08:29", [20, 30, 60, 90]),
  ...parts(9, "17:21", [90, 260, 50]),
  ...parts(9, "17:25", [25]),
  ...parts(9, "17:52", [75]),
  ...parts(9, "20:30", [110, 100]),
  ...parts(9, "20:33", [260]),
  ...parts(9, "20:35", [80, 310, 810, 500, 260], "out", 10),
  ...parts(9, "22:14", [25]),
  ...parts(10, "17:45", [360, 730, 180, 90]),
];

test("a full channel one buyer empties in two evenings: the fee is raised between his payments on what sold at it, and the raise made on the emptied channel is taken back when nothing sells at it (before: the last 1.36M sat went at 50 ppm — 213 sat for the 4.5M sat — and then eight raises to 350 ppm with nothing left to sell)", async (t) => {
  const r = await simulate(t, { days: 16, stepHours: 0.5, config: live, localStart: 4_800_000, feeStart: 30, market: { intoPpm: 499, backPpm: 200 }, replay: soldOut });
  report("L1", "5M channel, 96 % local at 30 ppm, a refill costs ~700; one buyer takes 4.3M in two evenings", r, 2);
  assert.equal(r.turnedAwaySats, 0, told(r, 2));
  assert.equal(r.soldSats, 4_515_000, told(r, 2));
  assert.ok(r.revenueSats >= 270, told(r, 2));
  // The second evening's last payment is sold at the fee raised after the first ones.
  assert.ok(raisesOf(r).filter((c) => c.day > 9 && c.day < 10.7).length >= 2, told(r, 2));
  assert.ok(r.changes.length <= 6, told(r, 2));
  assert.ok(stepBacksOf(r).length >= 1 && r.finalPpm <= 120, told(r, 2));
});

// A 4.7M channel a peer opened to us, empty on our side. Five days later
// 1.36M sat arrive over it; a day after that 1.2M sat are bought out of it.
const refilled: SimForward[] = [
  ...parts(5, "02:46", [360, 730, 180, 90], "in"),
  ...parts(5, "23:47", [470]),
  ...parts(6, "00:25", [290, 430], "out", 6),
  ...parts(6, "00:57", [95], "in"),
];

test("a new channel that fills over an inflow keeps its fee until it has been offered at it: what arrived is sold at 80 ppm and more, not at 50 (before: lowered to 50 ppm within the hour of the inflow, 60 sat for the 1.2M sat, then eight raises to 350 ppm on the emptied channel)", async (t) => {
  const r = await simulate(t, { days: 14, stepHours: 0.5, config: live, id: "859990x1x0", capacity: 4_700_000, localStart: 0, feeStart: 1, replay: refilled });
  report("L2", "new 4.7M channel (theirs), empty; day 5 1.36M comes in, a day later 1.2M goes out", r, 2);
  assert.equal(r.soldSats, 1_190_000, told(r, 2));
  assert.deepEqual(r.changes[0] && [r.changes[0].from, r.changes[0].to], [1, 80], told(r, 2));
  assert.ok(loweringsOf(r).every((c) => c.day > 6), told(r, 2));
  assert.ok(r.revenueSats >= 100, told(r, 2));
  assert.ok(r.finalPpm <= 150, told(r, 2));
});

// A drained 3M channel on its way to Protect ppm (350) that sold a little
// two weeks ago and turns a few small payments away each day. 925k sat
// arrive over it and are bought out again within minutes, in 29 parts; in
// the ten minutes after, 99 more parts — 6M sat — are asked for and turned
// away for lack of sats. Nothing comes in after that.
const boughtEmpty: SimForward[] = [
  ...parts(-12, "14:00", [30, 60, 40, 50, 40], "out", 20),
  ...parts(0, "12:10", [2, 3], "out", 400),
  ...parts(1, "15:40", [4]),
  ...parts(2, "04:08", [480], "in"),
  ...parts(2, "04:24", [445], "in"),
  ...parts(2, "04:36", [20, 33, 20, 45, 56, 20, 33, 20, 33, 20, 45, 56, 20, 33, 20, 33, 20, 45, 56, 20, 33, 20, 33, 20, 45, 56, 20, 33], "out", 1),
  ...parts(2, "04:39", [10]),
  ...parts(2, "04:40", Array.from({ length: 99 }, (_, k) => 55 + k / 10), "out", 6),
];

test("a refill bought out of a drained channel within a minute, with 6M sat more turned away: the fee is not lowered when the sats arrive, and it is raised one move on the sale — not for every part of it, and no further while nothing sells at the new fee (the live node, two versions earlier, counted the parts as 29 sales: 350 to 430 ppm in one move)", async (t) => {
  const r = await simulate(t, { days: 16, stepHours: 0.5, config: live, capacity: 3_000_000, localStart: 30_000, feeStart: 310, replay: boughtEmpty });
  report("L3", "drained 3M channel at 310 ppm, on its way to 350; 925k comes in and is bought out within minutes, 6M more is asked for", r, 2);
  assert.equal(r.soldSats, 918_000, told(r, 2));
  assert.ok(r.turnedAwaySats >= 5_900_000, told(r, 2));
  assert.equal(loweringsOf(r).length, 0, told(r, 2));
  // The first run takes it onto Protect ppm; the one raise after the sale is two steps.
  assert.deepEqual(raisesOf(r).map((c) => [c.from, c.to]), [[310, 350], [350, 370]], told(r, 2));
  assert.ok(r.revenueSats >= 320, told(r, 2));
});
