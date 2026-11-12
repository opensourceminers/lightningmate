/**
 * The fee rules over weeks (review 2026-11-10, package P3), on the real
 * autopilot with a fake node and a small market model (helpers/feeSim.ts):
 * channels nobody routes over, or hardly anybody. "before:" is what the
 * engine did with the same channel before the package.
 *
 * The other scenario files: feeScenariosDrain (one-way demand),
 * feeScenariosBurst (one buyer takes it all), feeScenariosTwoWay and
 * feeScenariosEstablished (a channel that sells both ways),
 * feeScenariosElastic (buyers who buy less the more it costs) and
 * feeScenariosLive (three cases seen on a live node, replayed forward by
 * forward). One rule on one channel at one moment is in feeRules.test.ts.
 * FEE_SIM_TRACE=1 prints each run's fee changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, movesOf, raisesOf, loweringsOf, stepBacksOf, gapsOf } from "./helpers/feeSim.js";

/** A channel 10 blocks old at the start. */
const NEW = "859990x1x0";

test("a new channel we opened that nobody routes over keeps its protected fee for two weeks and then goes to Min ppm in one move (before: lowered as idle on its third day)", async (t) => {
  const r = await simulate(t, { days: 40, id: NEW, localStart: 4_940_000, feeStart: 1, outRate: () => 0 });
  report("S1a", "new channel (ours, 99 % local, 1 ppm), no forwards, 40 d", r);
  assert.deepEqual(movesOf(r), [[1, 80], [80, 25]], told(r));
  assert.ok(r.changes[1].day >= 13.9, told(r));
});

test("a new channel the peer opened has nothing to sell: it is lifted to the protected fee and left there", async (t) => {
  const r = await simulate(t, { days: 40, id: NEW, localStart: 60_000, feeStart: 1, outRate: () => 0 });
  report("S1b", "new channel (theirs, 1 % local, 1 ppm), no forwards, 40 d", r);
  assert.deepEqual(movesOf(r), [[1, 80]], told(r));
});

test("a full new channel priced far too high comes down a day at a time, to its protected fee in its first two weeks and to Min ppm after them", async (t) => {
  const r = await simulate(t, { days: 40, id: NEW, localStart: 4_940_000, feeStart: 500, outRate: () => 0 });
  report("S1c", "new channel (ours, 99 % local, 500 ppm), no forwards, 40 d", r);
  assert.equal(loweringsOf(r).length, r.changes.length, told(r));
  assert.ok(gapsOf(r.changes).every((g) => g >= 1), told(r));
  assert.ok(r.changes.filter((c) => c.day < 13.9).every((c) => c.to >= 80), told(r));
  assert.equal(r.finalPpm, 25, told(r));
});

test("an idle channel priced above what other nodes charge into its peer drops to just under that price in one move, then a day at a time", async (t) => {
  const r = await simulate(t, { days: 40, localStart: 3_000_000, feeStart: 400, market: { intoPpm: 300, backPpm: 900 }, outRate: () => 0 });
  report("S4b", "market into 300 / back 900; 60 % local at 400 ppm; nobody routes, 40 d", r);
  assert.deepEqual(movesOf(r)[0], [400, 270], told(r));
  assert.match(r.changes[0].why, /other nodes charge ~300 ppm into this peer/, told(r));
  assert.equal(loweringsOf(r).length, r.changes.length, told(r));
  assert.equal(r.finalPpm, 25, told(r));
});

test("with Max ppm 50 a new channel at 30 ppm is left alone: its protected fee is Max, not 80, and it is not walked down to Min ppm in its first days (before: 10 ppm after four moves in six days)", async (t) => {
  const r = await simulate(t, {
    days: 6,
    id: NEW,
    localStart: 4_900_000,
    feeStart: 30,
    config: { policy: { minPpm: 10, maxPpm: 50, neutralPpm: 30, baseFeeMsat: 0, protectPpm: 50, safetyMargin: 1.15, noFlowRatchetSteps: 3, exploreLowerModifier: 0.85, step: 10, minChangePpm: 25 } },
    outRate: () => 0,
  });
  report("T6", "policy maxPpm 50: a new channel at 30 ppm", r, 1);
  assert.deepEqual(movesOf(r), [], told(r, 1));
  assert.equal(r.finalPpm, 30);
});

// Two forwards of 20k sat a week over a channel at 30 % local, 80 ppm.
test("a channel that sells twice a week at any price climbs, and a climb that ends on a fee nobody bought at goes back that one move — not to where it started (before: 150 sat earned in 120 days, now over 190)", async (t) => {
  const r = await simulate(t, { days: 120, localStart: 1_500_000, feeStart: 80, chunk: 20_000, outRate: () => 40_000 / 7 });
  report("S6a", "30 % local at 80 ppm; two 20k forwards a week at any price, 120 d", r, 10);
  assert.equal(r.soldSats, 680_000, told(r, 10));
  assert.ok(r.revenueSats >= 190, told(r, 10));
  assert.ok(stepBacksOf(r).length >= 3 && stepBacksOf(r).every((c) => c.from - c.to <= 20), told(r, 10));
});

test("where those buyers leave above 150 ppm the fee settles under it and the tries above it thin out (before: 30 fee changes in 120 days, now at most 22)", async (t) => {
  const r = await simulate(t, { days: 120, localStart: 1_500_000, feeStart: 80, chunk: 20_000, outRate: (fee) => (fee <= 150 ? 40_000 / 7 : 0) });
  report("S6b", "30 % local at 80 ppm; two 20k forwards a week while fee <= 150, 120 d", r, 10);
  assert.ok(r.changes.length <= 22, told(r, 10));
  assert.ok(r.soldSats >= 600_000, told(r, 10));
  assert.ok(r.finalPpm <= 150, told(r, 10));
  // A try the buyers turned down is remembered longer each time.
  assert.ok(raisesOf(r).filter((c) => c.day >= 60).length <= 3, told(r, 10));
});

test("a full channel that sells twice a week is lowered to the fee that wins more routing and held there", async (t) => {
  const r = await simulate(t, { days: 60, localStart: 4_500_000, feeStart: 200, chunk: 20_000, outRate: () => 40_000 / 7 });
  report("S6c", "90 % local at 200 ppm; two 20k forwards a week at any price, 60 d", r, 10);
  assert.deepEqual(movesOf(r), [[200, 170], [170, 140], [140, 110], [110, 80], [80, 50]], told(r, 10));
});
