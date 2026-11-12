/**
 * The fee rules over weeks (review 2026-11-10, package P3; see
 * feeScenariosIdle.test.ts for the set): a channel buyers empty one way. The
 * fee is raised while the channel still has its sats — on what sold at the
 * fee in force, not once it is drained — and a raise nobody buys at is taken
 * back to the last fee that sold. "before:" is the engine before the package.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate, report, told, stepBacksOf, gapsOf, feeOn, A } from "./helpers/feeSim.js";

test("steady one-way demand is priced while the channel is still full: buyers who pay up to 400 ppm take 300k sat a day and the fee is at their limit within nine days (before: 381 sat for the 3.95M sat, now over 900)", async (t) => {
  const r = await simulate(t, { days: 60, localStart: 4_000_000, feeStart: 80, outRate: (fee) => (fee <= 400 ? 300_000 : 0) });
  report("S2b", "80 % local at 80 ppm; 300k/day out while fee <= 400; no inflow, 60 d", r, 3);
  assert.equal(r.soldSats, 3_950_000, told(r, 3));
  assert.ok(r.revenueSats >= 900, told(r, 3));
  assert.ok(feeOn(r, 9) >= 300, told(r, 3));
  // Above what the buyers pay nothing sells: each such raise goes back to a price that sold.
  assert.ok(stepBacksOf(r).length >= 1 && stepBacksOf(r).every((c) => c.to >= 380 && c.to <= 400), told(r, 3));
});

test("the same with 100k sat a day flowing back: the fee finds the buyers' limit and stays on it (before: 3,096 sat in 90 days and the fee left at 430 ppm, above every buyer)", async (t) => {
  const r = await simulate(t, { days: 90, localStart: 4_000_000, feeStart: 80, outRate: (fee) => (fee <= 400 ? 300_000 : 0), inRate: () => 100_000 });
  report("S2c", "80 % local at 80 ppm; 300k/day out while fee <= 400; 100k/day in, 90 d", r, 5);
  assert.ok(r.revenueSats >= 4_000, told(r));
  assert.ok(r.soldSats >= 12_800_000, told(r));
  assert.ok(r.finalPpm >= 380 && r.finalPpm <= 400, told(r));
});

test("a peer that charges 900 ppm back makes refilling dear: a channel that drains 100k sat a day toward it is raised a third of the way to that cost per move (before: 481 sat for the 2.95M sat, now over 900)", async (t) => {
  const r = await simulate(t, {
    days: 60,
    localStart: 3_000_000,
    feeStart: 80,
    market: { intoPpm: 300, backPpm: 900 },
    outRate: (fee) => (fee <= 500 ? 100_000 : 0),
  });
  report("S4a", "market into 300 / back 900; 60 % local at 80 ppm; 100k/day out while fee <= 500, 60 d", r, 5);
  assert.equal(r.soldSats, 2_950_000, told(r));
  assert.ok(r.revenueSats >= 900, told(r));
});

test("with Max ppm 200 and Protect ppm left at 350 in the stored settings a channel drained by demand is never priced above 200 (before: 300 ppm)", async (t) => {
  const r = await simulate(t, {
    days: 20,
    warmDays: 30,
    localStart: 2_500_000,
    feeStart: 80,
    config: { policy: { minPpm: 25, maxPpm: 200, neutralPpm: 80, baseFeeMsat: 0, protectPpm: 350, safetyMargin: 1.15, noFlowRatchetSteps: 3, exploreLowerModifier: 0.85, step: 10, minChangePpm: 25 } },
    outRate: (_f, day) => (day < 5 ? 100_000 : 2_000_000),
  });
  report("T5", "policy maxPpm 200 (protectPpm 350): channel drained by demand", r, 5);
  assert.ok(r.changes.every((c) => c.to <= 200) && r.daily.every((d) => d.fee <= 200), told(r));
  assert.ok(r.revenueSats >= 350, told(r));
});

test("with the fee cooldown at its 30 minutes a drained channel in demand is raised one move per sale at the new fee, not as fast as the cooldown allows (before: eight moves in three days, to 430 ppm)", async (t) => {
  const r = await simulate(t, {
    days: 3,
    warmDays: 30,
    stepHours: 0.5,
    localStart: 400_000,
    feeStart: 80,
    config: { cooldownMinutes: 30, intervalMinutes: 30 },
    outRate: () => 100_000,
  });
  report("T7", "8 % local in demand, fee cooldown 30 min", r, 1);
  // 100k sat a day in forwards of 50k: one sale every 12 hours.
  assert.ok(r.changes.length >= 3 && gapsOf(r.changes).every((g) => g >= 0.5), told(r, 1));
  assert.ok(r.finalPpm <= 350, told(r, 1));
});

test("the max_htlc pass sends no policy update for a channel the operator excluded, however its balance moves (before: one for every bucket its balance crossed)", async (t) => {
  const r = await simulate(t, {
    days: 3,
    warmDays: 30,
    localStart: 2_500_000,
    feeStart: 300,
    config: { maxHtlcEnabled: true },
    outRate: (_f, day) => (day > 1 ? 3_000_000 : 100_000),
    inRate: () => 100_000,
    each: ({ day, overrides }) => {
      if (day === 0) overrides.set(A, { mode: "exclude" });
    },
  });
  report("U1", "subject EXCLUDED, max_htlc on", r, 1);
  // It did drain: 50 % local to 1 %.
  assert.equal(r.daily.at(-1)!.local, 1, told(r, 1));
  assert.deepEqual(r.node.policyRequests, []);
  assert.equal(r.finalPpm, 300);
});
