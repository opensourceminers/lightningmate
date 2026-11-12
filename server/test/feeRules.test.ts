/**
 * The fee engine's rules after the review of 2026-11-10 (findings FEE-1 to
 * FEE-12, `buildRecommendation` on one channel): a raise needs evidence, a
 * failed raise goes back to the last fee that sold, a fee that sells is kept
 * and probed upward, a fast drain is priced ahead, and the floors stay inside
 * the operator's Min..Max. The same rules over weeks, on the real autopilot,
 * are in the `feeScenarios*.test.ts` files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRecommendation,
  climbAnchorOf,
  flowAtFees,
  priceTestOf,
  raiseChainOf,
  recentSales,
  type BuildCtx,
  type FeeChannel,
} from "../src/services/feeRecommend.js";
import type { RebalanceRecord } from "../src/services/rebalanceLog.js";
import { DAY, HOUR, NO_FLOW, NOW, cfgOf, chan, ctx, flow, hoursAgo, openedDaysAgo } from "./helpers/feeCtx.js";

const why = (r: { reasons: string[] }): string => r.reasons.join(" | ");

// ── FEE-4: the floors hold inside Min..Max ──────────────────────────────────

test("Protect ppm above Max ppm protects at Max: a drained channel in demand is not ramped past the operator's highest fee (Max 200, Protect 350 → 300)", () => {
  const cfg = cfgOf({ maxPpm: 200, protectPpm: 350 });
  const drained = chan({ localRatio: 0.05 });
  const selling = { f14: flow(230_000, 0, 54, 53), f30: flow(2_400_000, 1_810_000, 151, 553), soldSinceChange: flow(48_000, 0, 3, 17) };
  const below = buildRecommendation(drained, ctx({ cfg, ppm: 180, ...selling }));
  assert.equal(below.targetPpm, 200, why(below));
  const at = buildRecommendation(drained, ctx({ cfg, ppm: 200, ...selling }));
  assert.equal(at.targetPpm, 200, why(at));
  assert.ok(!at.reasons.some((x) => /350 ppm/.test(x)), why(at));
});

test("a new channel's protected fee above Max ppm is Max: it is not lifted to 80 and walked back by the range (Min 10, Neutral 30, Max 50)", () => {
  const cfg = cfgOf({ minPpm: 10, neutralPpm: 30, maxPpm: 50, protectPpm: 40, newChannelMinPpm: 80 });
  const fresh = chan({ id: openedDaysAgo(1) });
  const r = buildRecommendation(fresh, ctx({ cfg, ppm: 30 }));
  assert.equal(r.targetPpm, 50, why(r));
  assert.match(r.reasons[0], /^new channel: only 1d old with little history — keeping a protected fee/, why(r));
  assert.ok(!r.reasons.some((x) => /80 ppm/.test(x)), why(r));
  // At Max it stays: nothing brings it "back into the range".
  const at = buildRecommendation(fresh, ctx({ cfg, ppm: 50 }));
  assert.equal(at.targetPpm, 50, why(at));
});

// ── FEE-7: a new channel is given two weeks ─────────────────────────────────

test("a channel that never routed is not lowered as idle in its first two weeks (at 2.9 days it sat at its protected fee, a day later at Min ppm)", () => {
  const young = buildRecommendation(chan({ id: openedDaysAgo(5), localRatio: 0.6 }), ctx({ ppm: 80 }));
  assert.equal(young.targetPpm, 80, why(young));
  assert.equal(young.noFlowLowering, false);
  assert.ok(young.reasons.some((x) => /^new channel: only 5d old/.test(x)), why(young));
  // After the two weeks the no-flow rule has it.
  const older = buildRecommendation(chan({ id: openedDaysAgo(15), localRatio: 0.6 }), ctx({ ppm: 80 }));
  assert.equal(older.noFlowLowering, true, why(older));
  assert.ok(older.targetPpm < 80);
  // Its third forward ends the protected fee, as before.
  const routed = buildRecommendation(chan({ id: openedDaysAgo(5), localRatio: 0.6 }), ctx({ ppm: 60, f14: flow(30_000, 0, 3, 2), f30: flow(30_000, 0, 3, 2) }));
  assert.ok(!routed.reasons.some((x) => /^new channel:/.test(x)), why(routed));
});

test("a drained new channel nobody routed through is not raised either (the two weeks must not open the door the idle rule closed)", () => {
  const r = buildRecommendation(chan({ id: openedDaysAgo(10), localRatio: 0.05 }), ctx({ ppm: 80 }));
  assert.equal(r.targetPpm, 80, why(r));
  assert.ok(r.reasons.some((x) => /an idle channel is never raised/.test(x)), why(r));
});

// ── FEE-1, FEE-7: an idle channel is lowered as far and as fast as its balance says ──

const market = (intoPeerPpm: number) => ({ intoPeerPpm, samples: 12, peerFeeToUsPpm: null });
const lastChange = (hours: number, cooldownHours = 6) => ({ lastApplied: { [chan().id]: hoursAgo(hours) }, cooldownHours });

test("an idle channel under 10 % local that still has sats to sell is lowered too — 350k sat of a 5M channel stayed at 340 ppm for good, never raised and never lowered — and with nothing left to sell it stays", () => {
  const drained = chan({ capacity: 5_000_000, localRatio: 0.07 });
  const r = buildRecommendation(drained, ctx({ ppm: 340 }));
  assert.deepEqual([r.targetPpm, r.wouldApply, r.noFlowLowering], [310, true, true], why(r));
  assert.match(r.reasons[0], /^no flow: nothing routed here recently — lowering toward the balanced level \(80 ppm\): it holds no more than its target, so not down to min at this pace/);
  assert.ok(!r.reasons.some((x) => /never raised/.test(x)), why(r));
  // At the balanced level it stays: what little it holds is not discounted.
  const at = buildRecommendation(drained, ctx({ ppm: 80 }));
  assert.deepEqual([at.targetPpm, at.wouldApply, at.noFlowLowering], [80, false, false], why(at));
  // Under its reserve plus 50k sat there is nothing a lower price could sell.
  const empty = buildRecommendation(chan({ capacity: 5_000_000, localRatio: 0.015 }), ctx({ ppm: 340 }));
  assert.deepEqual([empty.targetPpm, empty.noFlowLowering], [340, false], why(empty));
  assert.match(empty.reasons[0], /^hold: drained \(2% local\) and idle/);
});

test("how far down an idle channel goes follows its balance: to Min ppm with sats to spare, to the balanced level at its target or under it (at Min ppm the first buyer took 2.45M sat at 25–40 ppm)", () => {
  // 70 % local against a target of 50 %: sats to spare — toward Min, a ratchet (30) a day.
  const spare = buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ppm: 80 }));
  assert.deepEqual([spare.targetPpm, spare.aimPpm, spare.wouldApply], [50, 25, true], why(spare));
  assert.match(spare.reasons[0], /^no flow: nothing routed here recently — lowering toward min to win routing back/);
  // At its target, above the balanced level: the same steps, onto the level and not past it.
  for (const local of [0.5, 0.3]) {
    const above = buildRecommendation(chan({ localRatio: local }), ctx({ ppm: 200 }));
    assert.deepEqual([above.targetPpm, above.aimPpm, above.wouldApply], [170, 80, true], why(above));
    const near = buildRecommendation(chan({ localRatio: local }), ctx({ ppm: 100 }));
    assert.deepEqual([near.targetPpm, near.wouldApply], [80, true], why(near));
  }
  // Inside the deadband over its target (53 % against 50 %, the band 5 %) it
  // has no sats to spare: the balanced level, then one step a week — not
  // toward Min ppm at the ratchet's 30 a day.
  const inBand = buildRecommendation(chan({ localRatio: 0.53 }), ctx({ ppm: 80 }));
  assert.deepEqual([inBand.targetPpm, inBand.wouldApply], [70, true], why(inBand));
  assert.match(inBand.reasons[0], /^no flow: nothing routed here recently — it holds no more than its target, so below the balanced level \(80 ppm\) it is lowered one step a week only/);
  // Under its target, at the level or below it: it stays — neither discounted nor raised.
  for (const ppm of [80, 60]) {
    const under = buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ppm }));
    assert.deepEqual([under.targetPpm, under.wouldApply, under.noFlowLowering], [ppm, false, false], why(under));
    assert.match(under.reasons[0], /^hold: nothing routed here recently — an idle channel is not raised/);
  }
  // (Where a rule would lower it there, the hold says why it is not.)
  const cut = buildRecommendation(chan({ localRatio: 0.44 }), ctx({ ppm: 80, elasticityMod: 0.6 }));
  assert.deepEqual([cut.targetPpm, cut.wouldApply], [80, false], why(cut));
  assert.match(cut.reasons[0], /^hold: nothing routed here recently, and at 44% local it holds less than its target — not lowered below the balanced level \(80 ppm\)/);
  // The hold stops the steps down, not the drop to a price there is evidence
  // for: where other nodes charge 20 ppm into this peer, the idle channel at
  // 80 ppm sells nothing however scarce its sats are (the package's own
  // review, R10 — the rule's order was pinned by no test).
  const priced = buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ppm: 80, market: market(20) }));
  assert.deepEqual([priced.targetPpm, priced.wouldApply], [30, true], why(priced));
  assert.match(priced.reasons[0], /^no flow: other nodes charge ~20 ppm into this peer — dropping to 30 ppm instead of stepping down blind/);
});

test("at its target an idle channel goes on below the balanced level one grid step a week — held there for good, a balanced channel whose buyers pay less never sold again", () => {
  const balanced = chan({ localRatio: 0.5 });
  const first = buildRecommendation(balanced, ctx({ ppm: 80 }));
  assert.deepEqual([first.targetPpm, first.aimPpm, first.wouldApply, first.noFlowLowering], [70, 25, true, true], why(first));
  assert.match(first.reasons[0], /^no flow: nothing routed here recently — it holds no more than its target, so below the balanced level \(80 ppm\) it is lowered one step a week only/);
  // Not the ratchet's 30 a day: six days after the last change it waits.
  const waiting = buildRecommendation(balanced, ctx({ ppm: 70, cooldown: lastChange(6 * 24) }));
  assert.deepEqual([waiting.targetPpm, waiting.wouldApply, waiting.blockedByGuards], [60, false, ["lower pacing (1/week below the balanced level)"]], why(waiting));
  const due = buildRecommendation(balanced, ctx({ ppm: 70, cooldown: lastChange(7 * 24) }));
  assert.deepEqual([due.targetPpm, due.wouldApply], [60, true], why(due));
  // An operator's longer cadence holds here too.
  const longer = buildRecommendation(balanced, ctx({ ppm: 70, cooldown: lastChange(8 * 24, 240) }));
  assert.deepEqual(longer.blockedByGuards, ["lower pacing (every 240 h)"]);
  // Above the level it is the ratchet's pace, a day apart.
  const above = buildRecommendation(balanced, ctx({ ppm: 200, cooldown: lastChange(25) }));
  assert.deepEqual([above.targetPpm, above.wouldApply], [170, true], why(above));
  // At Min ppm nothing is lowered, and the line says so.
  const atMin = buildRecommendation(balanced, ctx({ ppm: 25 }));
  assert.deepEqual([atMin.targetPpm, atMin.wouldApply, atMin.noFlowLowering], [25, false, false], why(atMin));
  assert.match(atMin.reasons[0], /^no flow: nothing routed here recently — at your min of 25 ppm already, not lowered further/);
});

test("a price with evidence behind it is taken at once whatever the balance: the one that last won routing back, or the market's — also by a drained channel with sats to sell", () => {
  const under = chan({ localRatio: 0.3 });
  const anchored = buildRecommendation(under, ctx({ ppm: 200, flowAnchor: 120 }));
  assert.deepEqual([anchored.targetPpm, anchored.wouldApply], [120, true], why(anchored));
  const atMarket = buildRecommendation(under, ctx({ ppm: 200, market: market(100) }));
  assert.deepEqual([atMarket.targetPpm, atMarket.wouldApply], [90, true], why(atMarket));
  // Below the balanced level too: the market's 40 against a level of 80.
  const cheapMarket = buildRecommendation(under, ctx({ ppm: 80, market: market(40) }));
  assert.deepEqual([cheapMarket.targetPpm, cheapMarket.wouldApply], [40, true], why(cheapMarket));
  // And the price that last won routing back, below the balanced level, on a
  // channel under its target: taken, not held at the level.
  const cheapAnchor = buildRecommendation(under, ctx({ ppm: 80, flowAnchor: 50 }));
  assert.deepEqual([cheapAnchor.targetPpm, cheapAnchor.wouldApply], [50, true], why(cheapAnchor));
  const drained = buildRecommendation(chan({ capacity: 5_000_000, localRatio: 0.07 }), ctx({ ppm: 340, market: market(150) }));
  assert.deepEqual([drained.targetPpm, drained.wouldApply], [140, true], why(drained));
  assert.match(drained.reasons[0], /^no flow: other nodes charge ~150 ppm into this peer — dropping to 140 ppm instead of stepping down blind/);
});

// ── FEE-8: the reasons say what happens ─────────────────────────────────────

test("'active and balanced — holding' is not said over a fee that moves", () => {
  const busy = { f14: flow(300_000, 300_000, 40, 30), f30: flow(600_000, 600_000, 80, 60) };
  const moved = buildRecommendation(chan(), ctx({ ppm: 300, ...busy }));
  assert.ok(moved.targetPpm < 300, why(moved));
  assert.ok(moved.reasons.includes("velocity: active and balanced"), why(moved));
  assert.ok(!moved.reasons.some((x) => /active and balanced — holding/.test(x)), why(moved));
  const held = buildRecommendation(chan(), ctx({ ppm: 80, ...busy }));
  assert.equal(held.targetPpm, 80);
  assert.ok(held.reasons.includes("velocity: active and balanced — holding"), why(held));
});

// ── FEE-1: a raise needs evidence, a failed climb goes back to what sold ────

/** A drained top earner's month: it routed, and still does. */
const selling = { f14: flow(230_000, 0, 54, 53), f30: flow(2_400_000, 1_810_000, 151, 553) } as const;
const soldThrice = flow(48_000, 0, 3, 17);
const ID = "850000x1x0";
/** The books after a step-back 350 → 150 ppm a day ago. */
const steppedBack = (o: Partial<{ fromPpm: number; toPpm: number | undefined; at: string; count: number }> = {}) => ({
  lastApplied: {},
  cooldownHours: 6,
  stepBacks: { [ID]: { fromPpm: 350, toPpm: 150, at: hoursAgo(24), ...o } },
});

test("the protect ramp stops at the step-back's memory: the price nobody bought at is not ramped back to under another name (it went 150 → 190 → … → 350 again within days)", () => {
  const at = (ppm: number, sold = soldThrice) =>
    buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm, ...selling, soldSinceChange: sold, cooldown: steppedBack() }));
  // In the lower half of 150..350 it ramps toward the middle, 250…
  const low = at(150, flow(20_000, 0, 1, 3));
  assert.equal(low.targetPpm, 190, why(low));
  assert.equal(low.aimPpm, 250);
  assert.equal(low.reasons[0], "protect: drained (5% local) but still in demand — ramping toward 250 ppm");
  assert.ok(low.reasons.includes("guard: stepped back from 350 ppm 24 h ago — raised no higher than 250 ppm before 2026-10-27"), why(low));
  // …from there toward the last price below the one that failed…
  const mid = at(250);
  assert.ok(mid.targetPpm > 250 && mid.targetPpm <= 340, why(mid));
  assert.equal(mid.aimPpm, 340);
  // …and there it stays for the memory's days, protected but not raised.
  const top = at(340);
  assert.equal(top.targetPpm, 340, why(top));
  assert.equal(top.reasons[0], "hold: stepped back from 350 ppm 24 h ago — not raised back to it before 2026-10-27");
  assert.equal(top.state, "protecting_liquidity");
  assert.ok(!top.reasons.some((x) => /350 ppm or more|toward 350/.test(x)), why(top));
});

test("the step-back goes to the last fee that sold: the highest price of the climb at which something sold, or the fee before its first raise — not one step back (80 → 350 in seven moves went back to 340 and stayed)", () => {
  const raised = { at: hoursAgo(49), fromPpm: 330, toPpm: 350 };
  const c = (o: Partial<BuildCtx> = {}, ch: Partial<FeeChannel> = {}) =>
    buildRecommendation(
      chan({ localRatio: 0.08, ...ch }),
      ctx({ ppm: 350, ...selling, soldSinceChange: NO_FLOW, lastChange: raised, cooldown: { lastApplied: { [ID]: raised.at }, cooldownHours: 6 }, ...o }),
    );
  const climb = { basePpm: 80, soldPpm: 150 as number | null, steps: 7, startedAt: hoursAgo(91) };
  // Something sold at 150 on the way up: back to 150.
  const sold = c({ raiseChain: climb });
  assert.deepEqual([sold.targetPpm, sold.wouldApply, sold.stepBack], [150, true, true], why(sold));
  assert.equal(
    sold.reasons[0],
    "step back: raised 80→350 ppm in 7 moves, the last 2 d ago, and nothing sold at it since, with 140k to sell — back to 150 ppm, the highest price of this climb that sold",
  );
  // Nothing sold on the way: back to where the climb began.
  const none = c({ raiseChain: { ...climb, soldPpm: null } });
  assert.equal(none.targetPpm, 80, why(none));
  assert.match(none.reasons[0], /— back to 80 ppm, its fee before these 7 raises$/);
  // The last price that sold three times is still the least it goes to.
  const proven = { ppm: 200, paidPpm: 200, sales: 3, out: 48_000, revenue: 9.6, from: hoursAgo(120), to: hoursAgo(96), lastSaleAt: hoursAgo(100), lastSaleDaysAgo: 4 };
  const toProven = c({ raiseChain: climb, provenLevel: proven });
  assert.equal(toProven.targetPpm, 200, why(toProven));
  assert.match(toProven.reasons[0], /— back to 200 ppm, the last price that sold 3 times$/);
  // Without the climb (only the last change is known) it is the fee before that raise, as before.
  const single = c();
  assert.equal(single.targetPpm, 330, why(single));
  assert.match(single.reasons[0], /^step back: raised 330→350 ppm 2 d ago and nothing sold at it since, with 140k to sell — back to 330 ppm, its fee before that raise$/);
});

test("no step-back while payments were turned away since the fee was set: those are buyers at this price a drained channel could not serve", () => {
  const raised = { at: hoursAgo(49), fromPpm: 330, toPpm: 350 };
  const refused = (lastAt: number | undefined) =>
    buildRecommendation(
      chan({ localRatio: 0.08 }),
      ctx({
        ppm: 350,
        ...selling,
        soldSinceChange: NO_FLOW,
        lastChange: raised,
        raiseChain: { basePpm: 80, soldPpm: null, steps: 7, startedAt: hoursAgo(91) },
        cooldown: { lastApplied: { [ID]: raised.at }, cooldownHours: 6 },
        demand: { attempts: 4, days: 3, sats: 600_000, medianSats: 150_000, ...(lastAt === undefined ? {} : { lastAt }) },
      }),
    );
  // One an hour ago: the fee stays (and is not raised either — nothing sold).
  const since = refused(NOW - HOUR);
  assert.deepEqual([since.targetPpm, since.stepBack], [350, undefined], why(since));
  assert.ok(!since.reasons.some((x) => /^step back/.test(x)), why(since));
  // The last one before the raise, or at a time nobody kept: stepped back.
  assert.equal(refused(NOW - 60 * HOUR).targetPpm, 80);
  assert.equal(refused(undefined).targetPpm, 80);
});

// ── FEE-8: a step-back stops at a floor that holds the fee, and is not said over a fee that stays ──

test("a step-back stops at the floor that holds the fee anyway — and with the floor at the fee there is none ('step back … to 60 ppm' was said over a fee the new channel's protected fee kept)", () => {
  const young = openedDaysAgo(6);
  const at = (ppm: number) =>
    buildRecommendation(
      chan({ id: young }),
      ctx({
        ppm,
        f14: flow(30_000, 0, 2, 2),
        f30: flow(30_000, 0, 2, 2),
        soldSinceChange: NO_FLOW,
        lastChange: { at: hoursAgo(49), fromPpm: 60, toPpm: ppm },
        cooldown: { lastApplied: { [young]: hoursAgo(49) }, cooldownHours: 6 },
      }),
    );
  const above = at(100);
  assert.deepEqual([above.targetPpm, above.stepBack], [80, true], why(above));
  assert.match(above.reasons[0], /^step back: raised 60→100 ppm 2 d ago and nothing sold at it since, with 980k to sell — back to 80 ppm, a new channel's protected fee$/);
  const onIt = at(80);
  assert.deepEqual([onIt.targetPpm, onIt.stepBack], [80, undefined], why(onIt));
  assert.ok(!onIt.reasons.some((x) => /step back/.test(x)), why(onIt));
});

test("the same at the profit floor: a step-back ends on what the refills still in the channel cost, not below it — the floor would lift the fee again the run after", () => {
  // Refilled a day ago at 300 ppm: × 1.15 = 345 ppm, under which it is not sold.
  const refilled: RebalanceRecord = {
    at: hoursAgo(24),
    via: "autopilot",
    targetId: ID,
    targetAlias: "peer",
    sourceId: "850000x2x0",
    sourceAlias: "src",
    amountSats: 500_000,
    budgetPpm: 1000,
    feeSats: 150,
    costPpm: 300,
    ok: true,
  };
  const at = (ppm: number) =>
    buildRecommendation(
      chan(),
      ctx({
        ppm,
        f14: flow(30_000, 0, 2, 2),
        f30: flow(30_000, 0, 2, 2),
        soldSinceChange: NO_FLOW,
        lastChange: { at: hoursAgo(49), fromPpm: 300, toPpm: ppm },
        cooldown: { lastApplied: { [ID]: hoursAgo(49) }, cooldownHours: 6 },
        records: [refilled],
      }),
    );
  const above = at(400);
  assert.deepEqual([above.targetPpm, above.wouldApply, above.stepBack], [345, true, true], why(above));
  assert.equal(
    above.reasons[0],
    "step back: raised 300→400 ppm 2 d ago and nothing sold at it since, with 980k to sell — back to 345 ppm, its profit floor, what its refills cost",
  );
  const onIt = at(345);
  assert.deepEqual([onIt.targetPpm, onIt.wouldApply, onIt.stepBack], [345, false, undefined], why(onIt));
  assert.ok(!onIt.reasons.some((x) => /step back/.test(x)), why(onIt));
});

// ── FEE-11: the step-back's memory grows and narrows ────────────────────────

test("after a step-back the next climb goes at most to the middle of the stretch that failed, then to the last price below it — each failed try halves what is tried again", () => {
  const at = (ppm: number, cooldown = steppedBack()) =>
    buildRecommendation(chan({ localRatio: 0.12 }), ctx({ ppm, ...selling, soldSinceChange: soldThrice, cooldown }));
  // 150..350: the middle is 250.
  const toMid = at(240);
  assert.equal(toMid.targetPpm, 250, why(toMid));
  assert.ok(toMid.reasons.includes("guard: stepped back from 350 ppm 24 h ago — raised no higher than 250 ppm before 2026-10-27"), why(toMid));
  // At the middle it sold again (this fee's own sales let it move): on, at most to 340.
  assert.equal(at(250).targetPpm, 270);
  const toTop = at(330);
  assert.equal(toTop.targetPpm, 340, why(toTop));
  assert.ok(toTop.reasons.some((x) => /raised no higher than 340 ppm before 2026-10-27$/.test(x)), why(toTop));
  assert.equal(at(340).reasons[0], "hold: stepped back from 350 ppm 24 h ago — not raised back to it before 2026-10-27");
  // A record from before the fee it went back to was kept: the last price below the one that failed, as before.
  assert.equal(at(240, steppedBack({ toPpm: undefined })).targetPpm, 260);
  // A fee at the price that failed or above it (set by hand since, or lifted
  // by a floor) is not held by the memory: the memory bounds the way back up,
  // not a fee that is past it already.
  const past = (ppm: number) =>
    buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm, ...selling, soldSinceChange: soldThrice, cooldown: steppedBack(), cfg: cfgOf({ protectPpm: 600 }) }));
  for (const [ppm, to] of [[350, 430], [400, 500]]) {
    const r = past(ppm);
    assert.equal(r.targetPpm, to, why(r));
    assert.ok(!r.reasons.some((x) => /stepped back from 350 ppm/.test(x)), why(r));
  }
});

test("a raise the step-back's memory bounds is judged against the aim behind the memory, not the short way to its bound (a fee that sold 20 times sat at 350 for the memory's seven days: the middle, 390, was 'a change below threshold')", () => {
  const busy = { f14: flow(2_300_000, 1_400_000, 54, 530), f30: flow(6_400_000, 2_810_000, 151, 1553) };
  const cooldown = (o: { fromPpm: number; toPpm: number }) => ({ lastApplied: { [ID]: hoursAgo(72) }, cooldownHours: 6, stepBacks: { [ID]: { ...o, at: hoursAgo(72) } } });
  const at = (ppm: number, localRatio: number, back: { fromPpm: number; toPpm: number }, sold = flow(1_000_000, 0, 20, 350)) =>
    buildRecommendation(chan({ localRatio, capacity: 5_000_000 }), ctx({ ppm, ...busy, soldSinceChange: sold, cooldown: cooldown(back) }));
  // Stepped back 430 → 350 three days ago: 40 ppm to the middle, under the 12 % a fee of 350 must move by.
  const drained = at(350, 0.03, { fromPpm: 430, toPpm: 350 });
  assert.equal(drained.targetPpm, 390, why(drained));
  assert.equal(drained.wouldApply, true, why(drained));
  assert.deepEqual(drained.blockedByGuards, []);
  assert.ok(drained.reasons.includes("guard: stepped back from 430 ppm 3 d ago — raised no higher than 390 ppm before 2026-10-25"), why(drained));
  // The last step under the price that failed too (420 is 10 ppm from 410).
  const last = at(410, 0.03, { fromPpm: 430, toPpm: 350 });
  assert.equal(last.targetPpm, 420, why(last));
  assert.equal(last.wouldApply, true, why(last));
  // A move that stays under the bound names the bound as where it is going, not what the curve says past it.
  // (Two sales at the fee: an ordinary raise — three, and the drain ramp takes the bound in one move.)
  const onTheWay = at(350, 0.12, { fromPpm: 430, toPpm: 350 }, flow(100_000, 0, 2, 35));
  assert.equal(onTheWay.targetPpm, 370, why(onTheWay));
  assert.equal(onTheWay.aimPpm, 390, why(onTheWay));
  assert.ok(onTheWay.reasons.includes("guard: raising at most 20 ppm per move — 350→370 on the way to 390 ppm"), why(onTheWay));
  // With the memory at the fee there is nothing to apply, whatever lies behind it.
  const held = at(420, 0.03, { fromPpm: 430, toPpm: 350 });
  assert.equal(held.targetPpm, 420);
  assert.equal(held.wouldApply, false);
});

test("a step-back that ended no higher than the one before is remembered twice as long (7, 14, 28 days) — the same climb was tried again every week", () => {
  const at = (cooldown: ReturnType<typeof steppedBack>) =>
    buildRecommendation(chan({ localRatio: 0.12 }), ctx({ ppm: 330, ...selling, soldSinceChange: soldThrice, cooldown }));
  // Ten days after a first step-back the memory is over…
  assert.equal(at(steppedBack({ at: hoursAgo(240) })).targetPpm, 350);
  // …after the second in a row it holds for fourteen…
  const second = at(steppedBack({ at: hoursAgo(240), count: 2 }));
  assert.equal(second.targetPpm, 340, why(second));
  assert.ok(second.reasons.includes("guard: stepped back from 350 ppm 10 d ago (the second time in a row) — raised no higher than 340 ppm before 2026-10-25"), why(second));
  assert.equal(at(steppedBack({ at: hoursAgo(15 * 24), count: 2 })).targetPpm, 350);
  // …after the third for twenty-eight, and no longer than that.
  assert.equal(at(steppedBack({ at: hoursAgo(27 * 24), count: 3 })).targetPpm, 340);
  assert.equal(at(steppedBack({ at: hoursAgo(29 * 24), count: 3 })).targetPpm, 350);
});

// ── FEE-2: a fee that sells is kept, and tested upward ──────────────────────

/** A channel that routes both ways and stays where it is: no drain to price, no idle rule. */
const twoWay = { f14: flow(700_000, 650_000, 28, 56), f30: flow(1_500_000, 1_400_000, 60, 120) } as const;
/** What sold in the last 1, 3, 7 and 14 days: `n7` sales of 50k in the last week (three of them in the last 72 h, or `n3`), as many the week before, nearly as much coming in. */
const week = (n7: number, o: Partial<{ inn14: number; out14: number; inn7: number; n3: number }> = {}) => {
  const n1 = Math.min(1, n7);
  const n3 = o.n3 ?? Math.min(3, n7);
  return {
    d1: flow(n1 * 50_000, 0, n1, n1 * 4),
    d3: flow(n3 * 50_000, 0, n3, n3 * 4),
    d7: flow(n7 * 50_000, o.inn7 ?? n7 * 47_000, n7, n7 * 4),
    d14: flow(o.out14 ?? n7 * 100_000, o.inn14 ?? n7 * 95_000, n7 * 2, n7 * 8),
  };
};
const rule = (ch: Partial<FeeChannel>, o: Partial<BuildCtx> & { ppm?: number }) => buildRecommendation(chan(ch), ctx({ ...twoWay, ...o }));
const fiveSales = flow(250_000, 0, 5, 75);
const tenSales = flow(500_000, 0, 10, 40);

test("a fee that sells is not lowered: a balanced channel selling at 300 ppm was walked down to the balanced level's 80 — three sales at the fee since it was set, one of them in the last week, keep it", () => {
  const held = rule({}, { ppm: 300, soldSinceChange: fiveSales, recent: week(2), cooldown: lastChange(240) });
  assert.equal(held.targetPpm, 300, why(held));
  assert.equal(held.wouldApply, false);
  assert.equal(held.reasons[0], "hold: it sells at 300 ppm (5 sales since it was set 10 d ago) — a fee that sells is not lowered toward 80 ppm");
  // Nothing sold in the last week, or fewer than three sales at this fee on a
  // channel that sold fewer than three times in the week: lowered as before.
  for (const o of [
    { soldSinceChange: fiveSales, recent: week(0) },
    { soldSinceChange: flow(100_000, 0, 2, 30), recent: week(2) },
  ]) {
    const r = rule({}, { ppm: 300, cooldown: lastChange(240), ...o });
    assert.equal(r.targetPpm, 270, why(r));
    assert.ok(!r.reasons.some((x) => /^hold:/.test(x)), why(r));
  }
  // A cheaper market and a learned "higher fees cost flow" don't lower it
  // either, and no line beside the hold says they do.
  const cheaper = rule({}, { ppm: 300, soldSinceChange: fiveSales, recent: week(2), cooldown: lastChange(240), market: market(40) });
  assert.equal(cheaper.targetPpm, 300, why(cheaper));
  assert.ok(!cheaper.reasons.some((x) => /^market|to compete|idle test/.test(x)), why(cheaper));
  const elastic = rule({}, { ppm: 300, soldSinceChange: fiveSales, recent: week(2), cooldown: lastChange(240), elasticityMod: 0.8 });
  assert.equal(elastic.targetPpm, 300, why(elastic));
});

test("a change of the fee does not undo what the channel has shown: with its sales 'since it was set' back at none, it is held by three sales in the last 7 days at this fee or a higher one, and — once it sold here — while it is too early to say it does not (a fee that sold daily for a month was lowered the day after the autopilot wrote it: 19 changes in 90 days on a channel whose buyers paid 110)", () => {
  const paid = (n: number) => ({ ...flow(n * 50_000, 0, n, n * 15), ms: 7 * DAY });
  // Lowered 330 → 300 a day ago, nothing sold since: four sales in the week at 300 or more.
  const after = rule({}, { ppm: 300, soldSinceChange: NO_FLOW, recent: week(5), soldAtOrAbove7d: paid(4), cooldown: lastChange(24) });
  assert.equal(after.targetPpm, 300, why(after));
  assert.equal(after.reasons[0], "hold: it sold 4 times in the last 7 days at 300 ppm or more — a fee that sells is not lowered toward 80 ppm");
  // Three are enough, two are not.
  assert.equal(rule({}, { ppm: 300, soldSinceChange: NO_FLOW, recent: week(5), soldAtOrAbove7d: paid(3), cooldown: lastChange(24) }).targetPpm, 300);
  const twice = rule({}, { ppm: 300, soldSinceChange: NO_FLOW, recent: week(5), soldAtOrAbove7d: paid(2), cooldown: lastChange(24) });
  assert.equal(twice.targetPpm, 270, why(twice));
  assert.ok(!twice.reasons.some((x) => /^hold:/.test(x)), why(twice));
  // Its own three sales come first in what is said.
  const both = rule({}, { ppm: 300, soldSinceChange: fiveSales, recent: week(5), soldAtOrAbove7d: paid(9), cooldown: lastChange(72) });
  assert.equal(both.reasons[0], "hold: it sells at 300 ppm (5 sales since it was set 3 d ago) — a fee that sells is not lowered toward 80 ppm");

  // Set a day ago to a fee it never had (by hand, or found set outside the
  // app): two sales since, on a channel that sold five times in the week.
  const byHand = { at: hoursAgo(24), fromPpm: 250, toPpm: 300, via: "manual" as const, why: "set by hand" };
  const early = rule({}, { ppm: 300, soldSinceChange: flow(100_000, 0, 2, 30), recent: week(5), lastChange: byHand, cooldown: lastChange(24) });
  assert.equal(early.targetPpm, 300, why(early));
  assert.equal(
    early.reasons[0],
    "hold: 2 sales at 300 ppm since it was set 24 h ago, on a channel that sold 5 times in the last 7 days — too early to say it does not sell here: it is not lowered toward 80 ppm",
  );
  const one = rule({}, { ppm: 300, soldSinceChange: flow(50_000, 0, 1, 15), recent: week(3), lastChange: byHand, cooldown: lastChange(24) });
  assert.equal(
    one.reasons[0],
    "hold: 1 sale at 300 ppm since it was set 24 h ago, on a channel that sold 3 times in the last 7 days — too early to say it does not sell here: it is not lowered toward 80 ppm",
  );
  // No sale at the fee yet, or a channel that sold twice in the week: lowered.
  for (const o of [
    { soldSinceChange: NO_FLOW, recent: week(5) },
    { soldSinceChange: flow(50_000, 0, 1, 15), recent: week(2) },
  ]) {
    const r = rule({}, { ppm: 300, lastChange: byHand, cooldown: lastChange(24), ...o });
    assert.equal(r.targetPpm, 270, why(r));
    assert.ok(!r.reasons.some((x) => /^hold:/.test(x)), why(r));
  }
  // Neither holds the fee of a channel that fills up (below).
  const fills = rule(
    { localRatio: 0.8 },
    { ppm: 300, soldSinceChange: NO_FLOW, recent: week(5, { inn14: 900_000, out14: 500_000, inn7: 450_000 }), soldAtOrAbove7d: paid(4), cooldown: lastChange(24) },
  );
  assert.equal(fills.targetPpm, 270, why(fills));
  assert.ok(fills.reasons.includes("spare: it sells at 300 ppm, but holds more than its target and takes in more than it sells (900k in, 500k out in 14 d) — the fee is not held for those sales"), why(fills));
});

test("its sales don't hold the fee of a channel with sats to spare and no buyers for them: over its target it is lowered when it takes in more than it sells — in 14 days and still in the last 7, over the days at this fee or a lower one — or would need more than 90 days to sell what it holds over the target", () => {
  const full = (o: Partial<BuildCtx>) => rule({ localRatio: 0.8 }, { ppm: 300, soldSinceChange: fiveSales, cooldown: lastChange(240), ...o });
  const takesIn = full({ recent: week(2, { inn14: 600_000, out14: 200_000, inn7: 300_000 }) });
  assert.equal(takesIn.targetPpm, 270, why(takesIn));
  assert.ok(takesIn.reasons.includes("spare: it sells at 300 ppm, but holds more than its target and takes in more than it sells (600k in, 200k out in 14 d) — the fee is not held for those sales"), why(takesIn));
  const slow = full({ recent: week(1, { out14: 50_000, inn14: 40_000, inn7: 20_000 }) });
  assert.equal(slow.targetPpm, 270, why(slow));
  assert.ok(slow.reasons.some((x) => /^spare: it sells at 300 ppm, but at ~4k a day it would take more than 90 days to sell the 600k it holds over its target/.test(x)), why(slow));
  // Over its target but selling it down, and no more coming in than going out: held.
  const fast = full({ soldSinceChange: flow(1_000_000, 0, 20, 300), recent: week(10) });
  assert.equal(fast.targetPpm, 300, why(fast));
  assert.match(fast.reasons[0], /^hold: it sells at 300 ppm \(20 sales since it was set 10 d ago\)/);
  // Each half of "takes in more" alone is not enough: 400k more in over 14
  // days but more out than in over the last 7 (it turned), and more in over
  // the last 7 days with the 14 days inside what counts as even (50k).
  const turned = full({ recent: week(2, { inn14: 600_000, out14: 200_000, inn7: 50_000 }) });
  assert.equal(turned.targetPpm, 300, why(turned));
  const even = full({ recent: week(2, { inn14: 240_000, out14: 200_000, inn7: 150_000 }) });
  assert.equal(even.targetPpm, 300, why(even));
  // 80k more in than out over 14 days in sales of 50k: over the tolerance
  // (50k), but not by one sale — the sale a step-back's first hours missed
  // is no inflow (the package's second review, Q4).
  const lag = full({ recent: week(2, { inn14: 280_000, out14: 200_000, inn7: 300_000 }) });
  assert.equal(lag.targetPpm, 300, why(lag));
  const more = full({ recent: week(2, { inn14: 310_000, out14: 200_000, inn7: 300_000 }) });
  assert.equal(more.targetPpm, 270, why(more));

  // The days of a higher fee — a price test's — say nothing about this one:
  // 600k in and 200k out in 14 days, but even over the 9.5 of them at 300 ppm
  // or less (a test took in more than it sold, and the fee it went back to
  // was lowered for it)…
  const whole = week(2, { inn14: 600_000, out14: 200_000, inn7: 300_000 });
  const atFee = (inn14: number, out14: number, inn7: number, out7: number) => ({
    d7: { ...flow(out7, inn7, 2, 30), ms: 4 * DAY },
    d14: { ...flow(out14, inn14, 4, 60), ms: 9.5 * DAY },
  });
  const tested = full({ recent: whole, atOrBelow: atFee(190_000, 200_000, 90_000, 100_000), cooldown: lastChange(72) });
  assert.equal(tested.targetPpm, 300, why(tested));
  assert.match(tested.reasons[0], /^hold: it sells at 300 ppm \(5 sales since it was set 3 d ago\)/);
  // …and where those days do show it filling up, they are what is said.
  const filling = full({ recent: whole, atOrBelow: atFee(400_000, 100_000, 200_000, 50_000), cooldown: lastChange(72) });
  assert.equal(filling.targetPpm, 270, why(filling));
  assert.ok(
    filling.reasons.includes(
      "spare: it sells at 300 ppm, but holds more than its target and takes in more than it sells (400k in, 100k out in the 9.5 of the last 14 days at this fee or a lower one) — the fee is not held for those sales",
    ),
    why(filling),
  );
});

test("a raise is given a week: what sells at the new fee decides — the balance curve does not take it back the run after (raised, lowered again hours later, raised again), whatever the channel holds meanwhile", () => {
  const raised = (hours: number, via: "autopilot" | "manual" = "autopilot") => ({ at: hoursAgo(hours), fromPpm: 100, toPpm: 150, via, why: "balance: low local ratio" });
  const oneSale = flow(50_000, 0, 1, 8);
  const young = rule({}, { ppm: 150, soldSinceChange: oneSale, recent: week(1), lastChange: raised(48), cooldown: lastChange(48) });
  assert.equal(young.targetPpm, 150, why(young));
  assert.equal(young.reasons[0], "hold: raised 100→150 ppm 2 d ago — what sells at it decides for 7 days, it is not lowered toward 80 ppm");
  // After the week it needs its three sales like any fee.
  const old = rule({}, { ppm: 150, soldSinceChange: oneSale, recent: week(1), lastChange: raised(192), cooldown: lastChange(192) });
  assert.equal(old.targetPpm, 120, why(old));
  // A raise made by hand is not the autopilot's to try out.
  const byHand = rule({}, { ppm: 150, soldSinceChange: oneSale, recent: week(1), lastChange: raised(48, "manual"), cooldown: lastChange(48) });
  assert.equal(byHand.targetPpm, 120, why(byHand));
  // A channel that takes in more than it sells meanwhile keeps the week too:
  // a test's buyers are still finding the new price, and lowered for that it
  // was never judged (a tested fee was taken back by the curve within a day).
  const filling = week(1, { inn14: 600_000, out14: 100_000, inn7: 300_000 });
  const fills = rule({ localRatio: 0.8 }, { ppm: 150, soldSinceChange: oneSale, recent: filling, lastChange: raised(48), cooldown: lastChange(48) });
  assert.equal(fills.targetPpm, 150, why(fills));
  assert.match(fills.reasons[0], /^hold: raised 100→150 ppm 2 d ago — what sells at it decides for 7 days, it is not lowered toward \d+ ppm$/);
  assert.ok(!fills.reasons.some((x) => /^spare:/.test(x)), why(fills));
  // After it, a channel that fills up is lowered.
  const later = rule({ localRatio: 0.8 }, { ppm: 150, soldSinceChange: oneSale, recent: filling, lastChange: raised(192), cooldown: lastChange(192) });
  assert.equal(later.targetPpm, 120, why(later));
});

test("the fee a step-back went back to is given the same week: it sold there before the raise, and its sales 'since it was set' start again at zero (300 → 330 → 300, then 270 the day after) — after a test, a single raise or a climb of several", () => {
  const back = (hours: number, reason: string, fromPpm = 330) => ({ at: hoursAgo(hours), fromPpm, toPpm: 300, via: "autopilot" as const, why: reason });
  const at300 = (o: Partial<BuildCtx>, ch: Partial<FeeChannel> = {}) => rule(ch, { ppm: 300, soldSinceChange: NO_FLOW, recent: week(5), cooldown: lastChange(24), ...o });
  const tested = "step back: tried 300→330 ppm 3 d ago and it earned less in its first 72 h (39 sat against 45 in the 72 h before, at 300 ppm) — back to 300 ppm, its fee before the test";
  const held = at300({ lastChange: back(24, tested) });
  assert.equal(held.targetPpm, 300, why(held));
  assert.equal(
    held.reasons[0],
    "hold: back at 300 ppm 24 h ago, after a test of 330 ppm — it sold here before: what sells at it decides for 7 days, it is not lowered toward 80 ppm",
  );
  const later = rule({}, { ppm: 300, soldSinceChange: flow(50_000, 0, 1, 15), recent: week(0), lastChange: back(192, tested), cooldown: lastChange(192) });
  assert.equal(later.targetPpm, 270, why(later));
  // A raise a rule made and nothing sold at: the fee it went back to sold before it, too.
  const ordinary = at300({ lastChange: back(24, "step back: raised 300→330 ppm 2 d ago and nothing sold at it since, with 980k to sell — back to 300 ppm, its fee before that raise") });
  assert.equal(ordinary.targetPpm, 300, why(ordinary));
  assert.equal(
    ordinary.reasons[0],
    "hold: back at 300 ppm 24 h ago, after a raise to 330 ppm — it sold here before: what sells at it decides for 7 days, it is not lowered toward 80 ppm",
  );
  // The step-back that ends a climb of several raises says "raised … in 2
  // moves", not "tried": it was not covered, and the fee was lowered a day later.
  const chain = at300({
    lastChange: back(24, "step back: raised 270→360 ppm in 2 moves, the last 2 d ago, and nothing sold at it since, with 980k to sell — back to 300 ppm, the highest price of this climb that sold", 360),
  });
  assert.equal(chain.targetPpm, 300, why(chain));
  assert.match(chain.reasons[0], /^hold: back at 300 ppm 24 h ago, after a raise to 360 ppm — it sold here before/);
  // The week stands while the channel fills up, as a raise's does.
  const fills = at300({ lastChange: back(24, tested), recent: week(5, { inn14: 900_000, out14: 500_000, inn7: 450_000 }) }, { localRatio: 0.8 });
  assert.equal(fills.targetPpm, 300, why(fills));
  assert.match(fills.reasons[0], /^hold: back at 300 ppm 24 h ago, after a test of 330 ppm/);
  // Not after a lowering that was no step-back, nor one made by hand — what
  // holds such a fee is what it sold in the week at this fee or more (above).
  for (const lc of [
    back(24, "balance: 50% local (target 50%) — the balance curve puts it at ~80 ppm"),
    { ...back(24, tested), via: "manual" as const },
  ]) {
    const r = at300({ lastChange: lc });
    assert.equal(r.targetPpm, 270, why(r));
  }
});

test("price test: a channel that sells every day at its fee, at its target, is tried a tenth higher — a fee that sells was held for good and never found out what its buyers pay", () => {
  const sells = { soldSinceChange: tenSales, recent: week(7, { n3: 6 }), cooldown: lastChange(240) };
  const at80 = rule({}, { ppm: 80, ...sells });
  assert.equal(at80.targetPpm, 90, why(at80));
  // A tenth of the fee is under the anti-churn threshold by design: it applies all the same.
  assert.equal(at80.wouldApply, true, why(at80));
  assert.deepEqual(at80.blockedByGuards, []);
  assert.equal(at80.reasons[0], TEST_WHY);
  assert.equal(rule({}, { ppm: 300, ...sells }).targetPpm, 330);
  // Only where the autopilot's runs watch the channel (its clock of sats to
  // sell): with fee automation off "Apply" could not judge a test, so none is
  // offered (the package's second review, Q2).
  const unwatched = rule({}, { ppm: 80, ...sells, cooldown: { ...lastChange(240), sellableSince: {} } });
  assert.equal(unwatched.targetPpm, 80, why(unwatched));
  assert.ok(!unwatched.reasons.some((x) => /^price test: /.test(x)), why(unwatched));
  assert.equal(rule({}, { ppm: 80, ...sells, cooldown: { ...lastChange(240), sellableSince: { [ID]: hoursAgo(300) } } }).targetPpm, 90);
  // Never past Max ppm (nor said to be), a lease promise or the fee a rule's step-back remembers.
  const nearMax = rule({}, { ppm: 950, ...sells });
  assert.equal(nearMax.targetPpm, 1000, why(nearMax));
  assert.match(nearMax.reasons[0], / — trying 1000 ppm: /);
  assert.equal(rule({}, { ppm: 80, ...sells, cfg: cfgOf({ maxPpm: 80 }) }).targetPpm, 80);
  const promised = rule({}, { ppm: 80, ...sells, leaseCap: { fundingOutpoint: `${"ab".repeat(32)}:0`, source: "magma", orderId: "o1", feeRateCapPpm: 85, baseFeeCapMsat: 0, leaseBlocks: 4_320, untilHeight: 900_000 } });
  assert.equal(promised.targetPpm, 85, why(promised));
  const remembered = rule({}, { ppm: 80, ...sells, cooldown: { ...lastChange(240), stepBacks: { [ID]: { fromPpm: 90, toPpm: 80, at: hoursAgo(24) } } } });
  assert.equal(remembered.targetPpm, 80, why(remembered));
  // Not with under a sale a day, with sats over its target to sell first, where
  // raising lost revenue before, or on a channel the operator keeps to
  // themselves — and not before the fee has stood 72 h and sold six times in
  // them: those hours are what the test is set against.
  for (const [name, r] of [
    ["six sales in the week", rule({}, { ppm: 80, ...sells, recent: week(6, { n3: 6 }) })],
    ["five sales in the last 72 h", rule({}, { ppm: 80, ...sells, recent: week(7, { n3: 5 }) })],
    ["at this fee for 71 h", rule({}, { ppm: 80, ...sells, cooldown: lastChange(71) })],
    ["over its target", rule({ localRatio: 0.8 }, { ppm: 80, ...sells })],
    ["elasticity", rule({}, { ppm: 80, ...sells, elasticityMod: 0.9 })],
    ["excluded", rule({}, { ppm: 80, ...sells, override: { mode: "exclude" } })],
    ["pinned", rule({}, { ppm: 80, ...sells, override: { mode: "fixed", fixedPpm: 80 } })],
  ] as const) {
    assert.equal(r.targetPpm, 80, `${name}: ${why(r)}`);
    assert.ok(!r.reasons.some((x) => /^price test:/.test(x)), `${name}: ${why(r)}`);
  }
  // From 72 h on it goes ahead, paced like any raise.
  const due = rule({}, { ppm: 80, ...sells, cooldown: lastChange(72) });
  assert.deepEqual([due.targetPpm, due.wouldApply], [90, true], why(due));
});

const TEST_WHY =
  "price test: it sells at 80 ppm (10 sales since it was set 10 d ago, 7 in the last 7 days) and holds no more than its target — trying 90 ppm: taken back if nothing sells at it in 48 h, or if it earns less in its first 72 h than the 72 h before it earned at 80 ppm";
/** At 90 ppm since `hours`, raised from 80 by a price test: 80 ppm earned 40 sat in the 72 h before it, 90 ppm `first` sat in its first 72 h (4.5 sat a sale). */
const testedFor = (hours: number, first: number, o: Partial<BuildCtx> = {}) => {
  const sales = Math.round(first / 4.5);
  const sold = flow(sales * 50_000, 0, sales, first);
  return rule(
    {},
    {
      ppm: 90,
      soldSinceChange: sold,
      recent: week(7),
      lastChange: { at: hoursAgo(hours), fromPpm: 80, toPpm: 90, via: "autopilot", why: TEST_WHY },
      priceTest: { fromPpm: 80, at: hoursAgo(hours), before: flow(500_000, 0, 10, 40), first: sold },
      cooldown: { ...lastChange(hours), sellableSince: { [ID]: hoursAgo(500) } },
      ...o,
    },
  );
};
/** Refilled a day ago at 300 ppm: × 1.15 = 345 ppm, under which it is not sold. */
const refilledAt300: RebalanceRecord = {
  at: hoursAgo(24),
  via: "autopilot",
  targetId: ID,
  targetAlias: "peer",
  sourceId: "850000x2x0",
  sourceAlias: "src",
  amountSats: 500_000,
  budgetPpm: 1000,
  feeSats: 150,
  costPpm: 300,
  ok: true,
};

test("a price test is judged once, 72 h after the raise: what it earned in them against the 72 h before, at the fee before — less, and it goes back; as much or more, and it is kept (a running average over two stretches of unlike length, read at every run, made the hour the autopilot ran in decide)", () => {
  // 8 sales, 36 sat, against 40.
  const less = testedFor(80, 36);
  assert.equal(less.targetPpm, 80, why(less));
  assert.equal(less.wouldApply, true, why(less));
  assert.deepEqual([less.stepBack, less.probeBack], [true, true]);
  assert.equal(
    less.reasons[0],
    "step back: tried 80→90 ppm 3 d ago and it earned less in its first 72 h (36 sat against 40 in the 72 h before, at 80 ppm) — back to 80 ppm, its fee before the test",
  );
  // Before the 72 h are over nothing is judged, and the line says what will be.
  const early = testedFor(50, 13.5);
  assert.deepEqual([early.targetPpm, early.stepBack], [90, undefined], why(early));
  assert.ok(
    early.reasons.includes("price test: raised 80→90 ppm 2 d ago — judged once, 72 h after the raise: what it earned in them against the 72 h before, at 80 ppm (40 sat)"),
    why(early),
  );
  assert.equal(testedFor(71, 36).targetPpm, 90);
  assert.equal(testedFor(72, 36).targetPpm, 80);
  // As much as before is kept; the next test waits for six sales in 72 h…
  const same = testedFor(80, 40);
  assert.deepEqual([same.targetPpm, same.stepBack], [90, undefined], why(same));
  assert.ok(
    same.reasons.includes(
      "price test: 90 ppm earned 40 sat in its first 72 h against 40 in the 72 h before, at 80 ppm — kept; a higher fee is tried once it sold 6 times in 72 h (3 in the last 72 h)",
    ),
    why(same),
  );
  // …and follows with them.
  const more = testedFor(80, 45, { recent: week(7, { n3: 6 }) });
  assert.equal(more.targetPpm, 100, why(more));
  assert.equal(
    more.reasons[0],
    "price test: it sells at 90 ppm (10 sales since it was set 3 d ago, 7 in the last 7 days) and holds no more than its target — trying 100 ppm: taken back if nothing sells at it in 48 h, or if it earns less in its first 72 h than the 72 h before it earned at 90 ppm",
  );
  // No sale after the 72 h changes the verdict: with ten more since, it still goes back.
  const since = testedFor(100, 36, { soldSinceChange: flow(900_000, 0, 18, 81) });
  assert.equal(since.targetPpm, 80, why(since));
  // A test that earned less and could not be taken back in its 7 days is the
  // channel's fee after them — not taken back any more, and tested from again.
  assert.equal(testedFor(167, 36).targetPpm, 80);
  const stale = testedFor(168, 36, { recent: week(7, { n3: 6 }) });
  assert.deepEqual([stale.targetPpm, stale.stepBack], [100, undefined], why(stale));
  // Not judged where the 72 h before the test are not on record whole (no
  // comparison is read), or are another fee's than the one the test began at.
  const unread = testedFor(80, 36, { priceTest: undefined });
  assert.deepEqual([unread.targetPpm, unread.stepBack], [90, undefined], why(unread));
  const other = testedFor(80, 36, { priceTest: { fromPpm: 70, at: hoursAgo(80), before: flow(500_000, 0, 10, 40), first: flow(400_000, 0, 8, 36) } });
  assert.deepEqual([other.targetPpm, other.stepBack], [90, undefined], why(other));
  // Not taken back while payments were turned away at it (buyers the channel
  // could not serve), nor when it has had sats to sell for hours only — and
  // no higher fee is tried on top of it either.
  const refused = testedFor(80, 36, { recent: week(7, { n3: 6 }), demand: { attempts: 4, days: 3, sats: 600_000, medianSats: 150_000, lastAt: NOW - HOUR } });
  assert.deepEqual([refused.targetPpm, refused.stepBack], [90, undefined], why(refused));
  const refilled = testedFor(80, 36, { recent: week(7, { n3: 6 }), cooldown: { ...lastChange(80), sellableSince: { [ID]: hoursAgo(10) } } });
  assert.deepEqual([refilled.targetPpm, refilled.stepBack], [90, undefined], why(refilled));
});

test("a price test that earned less goes back to the fee before it, and no further than a floor that holds the fee anyway — the floor would lift it again the run after", () => {
  // 340 → 370 three days ago; refilled since at 300 ppm: the profit floor is 345.
  const r = rule(
    {},
    {
      ppm: 370,
      soldSinceChange: flow(400_000, 0, 8, 148),
      recent: week(7),
      lastChange: { at: hoursAgo(80), fromPpm: 340, toPpm: 370, via: "autopilot", why: "price test: it sells at 340 ppm (10 sales since it was set 10 d ago, 7 in the last 7 days) and holds no more than its target — trying 370 ppm" },
      priceTest: { fromPpm: 340, at: hoursAgo(80), before: flow(500_000, 0, 10, 170), first: flow(400_000, 0, 8, 148) },
      cooldown: { ...lastChange(80), sellableSince: { [ID]: hoursAgo(500) } },
      records: [refilledAt300],
    },
  );
  assert.deepEqual([r.targetPpm, r.wouldApply, r.stepBack, r.probeBack], [345, true, true, true], why(r));
  assert.equal(
    r.reasons[0],
    "step back: tried 340→370 ppm 3 d ago and it earned less in its first 72 h (148 sat against 170 in the 72 h before, at 340 ppm) — back to 345 ppm, its profit floor, what its refills cost",
  );
});

test("a price test nothing sold at is taken back after 48 h like any raise — and is remembered as a test, which a rule's raise is not; a step-back a lease promise takes further down is not remembered as one", () => {
  const none = testedFor(50, 0);
  assert.equal(none.targetPpm, 80, why(none));
  assert.deepEqual([none.stepBack, none.probeBack], [true, true]);
  assert.match(none.reasons[0], /^step back: tried 80→90 ppm 2 d ago and nothing sold at it since, with 980k to sell — back to 80 ppm, its fee before that raise$/);
  const byRule = testedFor(50, 0, { lastChange: { at: hoursAgo(50), fromPpm: 80, toPpm: 90, via: "autopilot", why: "replacement: refilling costs 95 ppm" } });
  assert.equal(byRule.targetPpm, 80, why(byRule));
  assert.deepEqual([byRule.stepBack, byRule.probeBack], [true, undefined]);
  assert.match(byRule.reasons[0], /^step back: raised 80→90 ppm 2 d ago and nothing sold at it since/);
  // The promise's 70 ppm is where the fee goes: that move went back to no fee
  // of the channel's, and writes no memory of a failed raise.
  const promised = testedFor(50, 0, { leaseCap: { fundingOutpoint: `${"ab".repeat(32)}:0`, source: "magma", orderId: "o1", feeRateCapPpm: 70, baseFeeCapMsat: 0, leaseBlocks: 4_320, untilHeight: 900_000 } });
  assert.deepEqual([promised.targetPpm, promised.stepBack, promised.probeBack], [70, undefined, undefined], why(promised));
});

test("a price test applied with 'Apply' on the Fees tab is still the engine's: nothing sold at it in 48 h and it goes back, it earned less in its first 72 h and it goes back, both remembered as a failed test — a fee set by hand stays the operator's (the package's second review, Q2)", () => {
  const applied = { at: hoursAgo(50), fromPpm: 80, toPpm: 90, via: "manual" as const, engine: true, why: TEST_WHY };
  const none = testedFor(50, 0, { lastChange: applied });
  assert.deepEqual([none.targetPpm, none.stepBack, none.probeBack], [80, true, true], why(none));
  assert.match(none.reasons[0], /^step back: tried 80→90 ppm 2 d ago and nothing sold at it since/);
  const less = testedFor(80, 30, { lastChange: { ...applied, at: hoursAgo(80) } });
  assert.deepEqual([less.targetPpm, less.stepBack, less.probeBack], [80, true, true], why(less));
  assert.match(less.reasons[0], /^step back: tried 80→90 ppm 3 d ago and it earned less in its first 72 h/);
  // With Fee automation off (no clock of the channel's sats on record) an
  // applied raise is not held on trial: nothing could take it back, and the
  // trial only kept a fee nobody bought at for a week (the review's second
  // round, N4). The balance curve lowers it as it would any fee.
  const trialed = (sellableSince: Record<string, string>) =>
    rule({}, { ppm: 90, soldSinceChange: NO_FLOW, recent: week(0), lastChange: { ...applied, at: hoursAgo(20), why: "velocity: steady outbound demand — small nudge up" }, cooldown: { ...lastChange(20), sellableSince } });
  assert.equal(trialed({ [ID]: hoursAgo(500) }).targetPpm, 90, why(trialed({ [ID]: hoursAgo(500) })));
  assert.ok(trialed({}).targetPpm < 90, why(trialed({})));
  // Set by hand (POST /fees/apply): no step-back (the balance curve may
  // still move it, as it moves any fee that does not sell).
  const byHand = testedFor(50, 0, { lastChange: { ...applied, engine: undefined } });
  assert.ok(!byHand.reasons.some((x) => /^step back: /.test(x)), why(byHand));
  assert.equal(byHand.stepBack, undefined);
});

/**
 * At 110 ppm after two price tests, 90 → 100 → 110: the first 171 h ago, the
 * second 90 h ago and kept on its first 72 h. The climb's first week ended
 * 3 h ago: it earned `now` sat in those 7 days, against `before` in the 7
 * days before it began, at 90 ppm.
 */
const climbed = (now: number, before: number, o: Partial<BuildCtx> & { ppm?: number } = {}) =>
  rule(
    {},
    {
      ppm: 110,
      soldSinceChange: flow(500_000, 0, 10, 55),
      recent: week(7, { n3: 6 }),
      lastChange: { at: hoursAgo(90), fromPpm: 100, toPpm: 110, via: "autopilot", why: "price test: it sells at 100 ppm (10 sales since it was set 3 d ago, 7 in the last 7 days) and holds no more than its target — trying 110 ppm" },
      priceTest: { fromPpm: 100, at: hoursAgo(90), before: flow(500_000, 0, 10, 50), first: flow(500_000, 0, 10, 55) },
      climbAnchor: {
        ppm: 90,
        startedAt: hoursAgo(171),
        tests: 2,
        ruleRaises: 0,
        beforeNetOut: 0,
        beforeHours: 0,
        week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, now), before: flow(1_100_000, 0, 22, before) },
      },
      cooldown: { ...lastChange(90), sellableSince: { [ID]: hoursAgo(500) } },
      ...o,
    },
  );

test("a climb a drain rule began is checked the same way once the drain is over: inside its target band and not selling itself empty, a raise that earned less goes back to the fee before it — while the channel is still under its band it is kept, and the line says why (the package's second review, Q1)", () => {
  const ruled = () =>
    climbed(60, 70, {
      climbAnchor: { ppm: 90, startedAt: hoursAgo(171), tests: 1, ruleRaises: 1, beforeNetOut: 0, beforeHours: 0, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 60), before: flow(1_100_000, 0, 22, 70) } },
    });
  const over = ruled();
  assert.deepEqual([over.targetPpm, over.wouldApply, over.stepBack, over.probeBack], [90, true, true, true], why(over));
  assert.equal(
    over.reasons[0],
    "step back: raised 90→110 ppm by the drain rules 7 d ago, with 1 price test since, the drain is over, and it earned less there, by more than one sale (60 sat in its last 7 d against 70 in the 7 d before, at 90 ppm) — back to 90 ppm, its fee before that raise",
  );
  // Under its band (40 % against 50 %, the band 5 %): the raise rations what is left.
  const under = rule(
    { localRatio: 0.4 },
    {
      ppm: 110,
      soldSinceChange: flow(500_000, 0, 10, 55),
      recent: week(7, { n3: 6 }),
      lastChange: { at: hoursAgo(171), fromPpm: 90, toPpm: 110, via: "autopilot", why: "drain: it sells ~300k a day net at 90 ppm" },
      climbAnchor: { ppm: 90, startedAt: hoursAgo(171), tests: 0, ruleRaises: 1, beforeNetOut: 0, beforeHours: 0, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 60), before: flow(1_100_000, 0, 22, 70) } },
      cooldown: { ...lastChange(171), sellableSince: { [ID]: hoursAgo(500) } },
    },
  );
  assert.ok(under.targetPpm >= 110, why(under));
  assert.equal(under.stepBack, undefined, why(under));
  // At half local, but selling itself empty again (600k net in the 3.75
  // days since the fee was set, 35 % net out over 14 days): kept as well.
  const emptying = climbed(60, 70, {
    f14: flow(700_000, 0, 28, 77),
    soldSinceChange: flow(600_000, 0, 12, 66),
    climbAnchor: { ppm: 90, startedAt: hoursAgo(171), tests: 1, ruleRaises: 1, beforeNetOut: 0, beforeHours: 0, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 60), before: flow(1_100_000, 0, 22, 70) } },
  });
  assert.equal(emptying.stepBack, undefined, why(emptying));
  // And where the days it is set against were a drain at the fee before
  // (150k net out of the 2M channel, without the last day before the raise):
  // those days were never what that fee earns while balanced (the review's
  // second round, N3).
  const drainedBefore = climbed(60, 70, {
    climbAnchor: { ppm: 90, startedAt: hoursAgo(171), tests: 1, ruleRaises: 1, beforeNetOut: 600_000, beforeHours: 144, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 60), before: flow(1_100_000, 0, 22, 70) } },
  });
  assert.equal(drainedBefore.stepBack, undefined, why(drainedBefore));
  // (600k net out in 6 days: 100k a day, 10 % local in 8 days from half of
  // 2M. 150k in those days — 25k a day, 32 days — is a two-way channel's
  // days of more out than in: taken back.)
  const twoWayBefore = climbed(60, 70, {
    climbAnchor: { ppm: 90, startedAt: hoursAgo(171), tests: 1, ruleRaises: 1, beforeNetOut: 150_000, beforeHours: 144, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 60), before: flow(1_100_000, 0, 22, 70) } },
  });
  assert.equal(twoWayBefore.stepBack, true, why(twoWayBefore));
  assert.ok(drainedBefore.reasons.some((x) => /less — kept while the channel drains/.test(x)), why(drainedBefore));
  // A climb of price tests alone is taken back whatever the days before were.
  const testsOnly = climbed(60, 70, {
    climbAnchor: { ppm: 90, startedAt: hoursAgo(171), tests: 2, ruleRaises: 0, beforeNetOut: 600_000, beforeHours: 144, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 60), before: flow(1_100_000, 0, 22, 70) } },
  });
  assert.equal(testsOnly.stepBack, true, why(testsOnly));
  // As much or more: the climb is kept, and its line names it a raise, not a price test.
  const keptRule = climbed(80, 70, { climbAnchor: { ppm: 90, startedAt: hoursAgo(171), tests: 1, ruleRaises: 1, beforeNetOut: 0, beforeHours: 0, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 80), before: flow(1_100_000, 0, 22, 70) } } });
  assert.ok(keptRule.reasons.some((x) => x.startsWith("raised: at 110 ppm, up from 90 ppm 7 d ago — it earned 80 sat in its last 7 d against 70 in the 7 d before, at 90 ppm: kept")), why(keptRule));
  assert.ok(emptying.reasons.some((x) => /less — kept while the channel drains/.test(x)), why(emptying));
  assert.ok(
    under.reasons.includes(
      "raised: at 110 ppm, up from 90 ppm 7 d ago — it earned 60 sat in its last 7 d against 70 in the 7 d before, at 90 ppm, less — kept while the channel drains (under its target band, selling itself empty, or drained at the fee before)",
    ),
    why(under),
  );
});

test("a climb of price tests is checked against the fee it began at, at the end of each of its weeks: it earned less in its last days than in as many before the climb, and all of it goes back — each test was kept on three days' sales, and buyers who buy a sixth less at each tenth more left 1,500 to 2,000 sat in 120 days where the fee it began at earned 2,400", () => {
  const less = climbed(60, 70);
  assert.deepEqual([less.targetPpm, less.wouldApply, less.stepBack, less.probeBack], [90, true, true, true], why(less));
  assert.equal(
    less.reasons[0],
    "step back: raised 90→110 ppm in 2 price tests since 7 d ago, and it earned less there, by more than one sale (60 sat in its last 7 d against 70 in the 7 d before, at 90 ppm) — back to 90 ppm, its fee before these tests",
  );
  // As much or more: kept, said, and the next test goes ahead.
  // Less by no more than one sale is kept as well (20 sales: 67 sat and one
  // sale more is 70.35) — two like stretches of an even flow differ by one.
  for (const now of [67, 70, 80]) {
    const kept = climbed(now, 70);
    assert.deepEqual([kept.targetPpm, kept.stepBack], [120, undefined], why(kept));
    const line = `price test: at 110 ppm, up from 90 ppm 7 d ago — it earned ${now} sat in its last 7 d against 70 in the 7 d before, at 90 ppm: kept${now < 70 ? " (less by no more than one sale)" : ""}`;
    assert.ok(kept.reasons.includes(line), why(kept));
  }
  // "kept" is not said over a fee that goes down after all (a pin here).
  const pinnedDown = climbed(80, 70, { override: { mode: "fixed", fixedPpm: 90 } });
  assert.equal(pinnedDown.targetPpm, 90, why(pinnedDown));
  assert.ok(!pinnedDown.reasons.some((x) => /: kept/.test(x)), why(pinnedDown));
  assert.deepEqual([climbed(66, 70).targetPpm, climbed(66, 70).stepBack], [90, true]);
  // The second week's check reads 14 days, one cut short what is on record.
  const anchor = { ppm: 90, startedAt: hoursAgo(339), tests: 2, ruleRaises: 0, beforeNetOut: 0, beforeHours: 0 };
  const stretch = (n: number, hours: number) => ({ n, hours, window: hours, from: NOW - (hours + 3) * HOUR, now: flow(1_000_000, 0, 20, 120), before: flow(1_100_000, 0, 22, 140) });
  assert.match(climbed(0, 0, { climbAnchor: { ...anchor, week: stretch(2, 336) } }).reasons[0], /in 2 price tests since 14 d ago, and it earned less there, by more than one sale \(120 sat in its last 14 d against 140 in the 14 d before, at 90 ppm\)/);
  assert.match(climbed(0, 0, { climbAnchor: { ...anchor, week: stretch(2, 100) } }).reasons[0], /\(120 sat in its last 100 h against 140 in the 100 h before, at 90 ppm\)/);
  // Hours of the week that were left out — a test taken back — are named.
  assert.match(
    climbed(0, 0, { climbAnchor: { ...anchor, week: { ...stretch(1, 120), window: 168 } } }).reasons[0],
    /\(120 sat in 5 d of its last 7 d \(without a price test taken back or not yet judged\) against 140 in the 5 d before, at 90 ppm\)/,
  );
  // One test only: "tried".
  const once = climbed(60, 70, {
    ppm: 100,
    lastChange: { at: hoursAgo(171), fromPpm: 90, toPpm: 100, via: "autopilot", why: "price test: it sells at 90 ppm" },
    priceTest: { fromPpm: 90, at: hoursAgo(171), before: flow(500_000, 0, 10, 45), first: flow(500_000, 0, 10, 50) },
    climbAnchor: { ppm: 90, startedAt: hoursAgo(171), tests: 1, ruleRaises: 0, beforeNetOut: 0, beforeHours: 0, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 60), before: flow(1_100_000, 0, 22, 70) } },
    cooldown: { ...lastChange(171), sellableSince: { [ID]: hoursAgo(500) } },
  });
  assert.equal(once.targetPpm, 90, why(once));
  assert.equal(
    once.reasons[0],
    "step back: tried 90→100 ppm 7 d ago, and it earned less there, by more than one sale (60 sat in its last 7 d against 70 in the 7 d before, at 90 ppm) — back to 90 ppm, its fee before the test",
  );
  // No further down than a floor that holds the fee anyway.
  const floored = climbed(60, 70, { cfg: cfgOf({ minPpm: 100 }) });
  assert.equal(floored.targetPpm, 100, why(floored));
  assert.match(floored.reasons[0], /— back to 100 ppm, the policy's min$/);
  // It takes the place of the step-back for a last test nothing sold at, which goes less far.
  const unsold = climbed(60, 70, {
    soldSinceChange: NO_FLOW,
    lastChange: { at: hoursAgo(50), fromPpm: 100, toPpm: 110, via: "autopilot", why: "price test: it sells at 100 ppm" },
    priceTest: { fromPpm: 100, at: hoursAgo(50), before: flow(500_000, 0, 10, 50), first: NO_FLOW },
    cooldown: { ...lastChange(50), sellableSince: { [ID]: hoursAgo(500) } },
  });
  assert.equal(unsold.targetPpm, 90, why(unsold));
  assert.match(unsold.reasons[0], /^step back: raised 90→110 ppm in 2 price tests since 7 d ago, and it earned less there/);
  assert.ok(!unsold.reasons.some((x) => /nothing sold at it since/.test(x)), why(unsold));
  // Not judged where the channel had no sats to sell through all of those
  // days; not taken back while payments were turned away since the fee was
  // set, by hand-held channels, or when the fee is no longer above the
  // climb's start — and while it earns less, no higher fee is tried.
  const refilled = climbed(60, 70, { cooldown: { ...lastChange(90), sellableSince: { [ID]: hoursAgo(100) } } });
  assert.equal(refilled.stepBack, undefined, why(refilled));
  assert.ok(!refilled.reasons.some((x) => /earned less there|up from 90 ppm/.test(x)), why(refilled));
  const refused = climbed(60, 70, { demand: { attempts: 4, days: 3, sats: 600_000, medianSats: 150_000, lastAt: NOW - HOUR } });
  assert.deepEqual([refused.targetPpm, refused.stepBack], [110, undefined], why(refused));
  const excluded = climbed(60, 70, { override: { mode: "exclude" } });
  assert.deepEqual([excluded.targetPpm, excluded.stepBack], [110, undefined], why(excluded));
  const lower = climbed(60, 70, { climbAnchor: { ppm: 110, startedAt: hoursAgo(171), tests: 2, ruleRaises: 0, beforeNetOut: 0, beforeHours: 0, week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(1_000_000, 0, 20, 60), before: flow(1_100_000, 0, 22, 70) } } });
  assert.equal(lower.stepBack, undefined, why(lower));
  assert.ok(!lower.reasons.some((x) => /earned less there/.test(x)), why(lower));
});

test("a price test that was taken back is not repeated for a week (two weeks, four weeks when it fails again), and an ordinary raise stops below the price that failed for as long — the ramps of a drained channel go ahead", () => {
  const sells = { ppm: 80, soldSinceChange: tenSales, recent: week(7, { n3: 6 }) };
  const failed = (hours: number, count = 1) => ({ ...lastChange(240), probeBacks: { [ID]: { fromPpm: 90, toPpm: 80, at: hoursAgo(hours), count } } });
  const day = rule({}, { ...sells, cooldown: failed(24) });
  assert.equal(day.targetPpm, 80, why(day));
  assert.ok(day.reasons.includes("price test: 90 ppm was tried and taken back 24 h ago — no higher fee is tried before 2026-10-27"), why(day));
  assert.equal(rule({}, { ...sells, cooldown: failed(8 * 24) }).targetPpm, 90);
  const twice = rule({}, { ...sells, cooldown: failed(8 * 24, 2) });
  assert.equal(twice.targetPpm, 80, why(twice));
  assert.ok(twice.reasons.includes("price test: 90 ppm was tried and taken back 8 d ago (the second time in a row) — no higher fee is tried before 2026-10-27"), why(twice));
  assert.equal(rule({}, { ...sells, cooldown: failed(15 * 24, 2) }).targetPpm, 90);
  // A fee at the level that failed, or above it (set by hand since), is not what the memory is about.
  assert.equal(rule({}, { ...sells, ppm: 90, cooldown: failed(24) }).targetPpm, 100);
  // The curve of a channel under its target would raise 80 → 100, past the
  // 90 ppm that earned less a day ago: held, and raised again once the
  // memory is over.
  const curve = rule({ localRatio: 0.3 }, { ...sells, cooldown: failed(24) });
  assert.deepEqual([curve.targetPpm, curve.wouldApply], [80, false], why(curve));
  assert.equal(curve.reasons[0], "hold: 90 ppm was tried and taken back 24 h ago — it earned less there; not raised to it before 2026-10-27 unless the channel drains");
  assert.equal(rule({ localRatio: 0.3 }, { ...sells, cooldown: failed(8 * 24) }).targetPpm, 100);
  // Where a grid price lies between the fee and the one that failed, the raise stops on it.
  const below = rule({ localRatio: 0.3 }, { ...sells, cooldown: { ...lastChange(240), probeBacks: { [ID]: { fromPpm: 100, toPpm: 80, at: hoursAgo(24), count: 1 } } } });
  assert.equal(below.targetPpm, 90, why(below));
  assert.ok(below.reasons.includes("guard: 100 ppm was tried and taken back 24 h ago — it earned less there; raised no higher than 90 ppm before 2026-10-27 unless the channel drains"), why(below));
  // Drained and still in demand: the protect ramp is not bound by a test's memory…
  const drained = rule({ localRatio: 0.05 }, { ...sells, cooldown: failed(24) });
  assert.ok(drained.targetPpm > 90, why(drained));
  assert.match(drained.reasons[0], /^protect: drained \(5% local\) but still in demand/);
  // …as it is by the memory of a raise that failed.
  const bound = rule({ localRatio: 0.05 }, { ...sells, cooldown: { ...lastChange(240), stepBacks: { [ID]: { fromPpm: 90, toPpm: 80, at: hoursAgo(24) } } } });
  assert.equal(bound.targetPpm, 80, why(bound));
  // A channel that sells itself empty is raised past it too: the drain ramp
  // (80 → 100, past the 90 that failed a day ago) prices the sats it has
  // left, whatever a test said about a balanced channel.
  const draining = buildRecommendation(chan(), ctx({ f14: flow(700_000, 0, 28, 56), f30: flow(900_000, 750_000, 40, 72), ppm: 80, soldSinceChange: flow(150_000, 0, 3, 12), cooldown: { ...lastChange(12), probeBacks: { [ID]: { fromPpm: 90, toPpm: 80, at: hoursAgo(24), count: 1 } } } }));
  assert.equal(draining.targetPpm, 100, why(draining));
  assert.match(draining.reasons[0], /^drain: /);
});

// ── FEE-3: a fast drain is priced ahead ─────────────────────────────────────

/** Two weeks of selling one way (35 % of the capacity net out) in a month that is nearly even: not "draining" by the 30-day rule. */
const oneWay = { f14: flow(700_000, 0, 28, 56), f30: flow(900_000, 750_000, 40, 72) } as const;
const drains = (ch: Partial<FeeChannel>, o: Partial<BuildCtx> & { ppm?: number }) => buildRecommendation(chan(ch), ctx({ ...oneWay, ...o }));
/** 150k in three sales: 7.5 % of the 2M channel. */
const threeSales = flow(150_000, 0, 3, 12);
/** What sold in the last 1, 3, 7 and 14 days, in sales of 50k, nothing coming in. */
const lastDays = (n1: number, n3: number, n7: number, n14: number) => ({
  d1: flow(n1 * 50_000, 0, n1, n1 * 4),
  d3: flow(n3 * 50_000, 0, n3, n3 * 4),
  d7: flow(n7 * 50_000, 0, n7, n7 * 4),
  d14: flow(n14 * 50_000, 0, n14, n14 * 4),
});
const noDrainLine = (r: { reasons: string[] }): boolean => !r.reasons.some((x) => /^drain:/.test(x));

test("drain ramp: a channel that is down to 10 % local within three weeks at what it sells a day is raised a quarter of the fee per move, every 6 h — at 80 % local with buyers taking 300k a day it went up 20 ppm every 72 h and reached its price empty", () => {
  // Half of 2M local, 150k sold in the 12 h since the fee was set: 300k a day, 800k to go.
  const at80 = drains({}, { ppm: 80, soldSinceChange: threeSales, cooldown: lastChange(12) });
  assert.equal(at80.targetPpm, 100, why(at80));
  assert.equal(at80.wouldApply, true, why(at80));
  assert.equal(
    at80.reasons[0],
    "drain: it sells ~300k a day net at 80 ppm — at that rate it is down to 10% local in ~3 d (3 sales since it was set 12 h ago) — raising a quarter of the fee per move (at least two steps), at most every 6 h: 80→100 on the way to 1000 ppm",
  );
  const at200 = drains({}, { ppm: 200, soldSinceChange: threeSales, cooldown: lastChange(12) });
  assert.equal(at200.targetPpm, 250, why(at200));
  // Paced like the demand ramp: 6 h between two moves, where a raise waits 72 h.
  const soon = drains({}, { ppm: 200, soldSinceChange: threeSales, cooldown: lastChange(3) });
  assert.deepEqual([soon.targetPpm, soon.wouldApply, soon.blockedByGuards], [250, false, ["raise cooldown active"]], why(soon));
  assert.equal(drains({}, { ppm: 200, soldSinceChange: threeSales, cooldown: lastChange(7) }).wouldApply, true);
  // Never past Max ppm.
  const capped = drains({}, { ppm: 90, soldSinceChange: threeSales, cooldown: lastChange(12), cfg: cfgOf({ maxPpm: 100 }) });
  assert.deepEqual([capped.targetPpm, capped.aimPpm], [100, 100], why(capped));
  // A pin holds the fee; what the channel does is still said, without the raise.
  const pinned = drains({}, { ppm: 80, soldSinceChange: threeSales, cooldown: lastChange(12), override: { mode: "fixed", fixedPpm: 80 } });
  assert.equal(pinned.targetPpm, 80);
  assert.ok(pinned.reasons.includes("drain: it sells ~300k a day net at 80 ppm — at that rate it is down to 10% local in ~3 d (3 sales since it was set 12 h ago)"), why(pinned));
});

test("the drain is measured at the fee in force: since it was set, and over the last 1, 3, 7 and 14 days only where the fee has stood that long — what sold at an older, lower fee does not carry the ramp past the price that slowed the drain", () => {
  // 600k sold in three days, the fee set 12 h ago and one sale since: nothing known about this fee.
  const fresh = drains({}, { ppm: 80, soldSinceChange: flow(40_000, 0, 1, 3), recent: lastDays(1, 12, 12, 14), cooldown: lastChange(12) });
  assert.equal(fresh.targetPpm, 80, why(fresh));
  assert.ok(noDrainLine(fresh), why(fresh));
  // The same three days at a fee that stood for four: 200k a day.
  const stood = drains({}, { ppm: 80, soldSinceChange: flow(600_000, 0, 12, 48), recent: lastDays(1, 12, 12, 14), cooldown: lastChange(96) });
  assert.equal(stood.targetPpm, 100, why(stood));
  assert.match(stood.reasons[0], /^drain: it sells ~200k a day net at 80 ppm — at that rate it is down to 10% local in ~4 d \(12 sales since it was set 4 d ago\)/);
  // With no change on record the sales are the window's: 150k net in 30 days is 5k a day — the last week says 600k.
  const noStamp = drains({}, { ppm: 80, soldSinceChange: flow(900_000, 750_000, 40, 72), recent: lastDays(2, 6, 12, 14) });
  assert.equal(noStamp.targetPpm, 100, why(noStamp));
  assert.match(noStamp.reasons[0], /^drain: it sells ~100k a day net at 80 ppm — at that rate it is down to 10% local in ~8 d \(40 sales in 30 d\)/);
});

test("what sold before the fee was set does not drive the drain ramp through the last day either, and sales in the first minutes after a change are read over six hours at least, not as a day's rate many times higher", () => {
  // Fee set 12 h ago, one sale since; four sales (200k) in the last day, most
  // of them at the fee before: the day is not this fee's.
  const dayOld = drains({}, { ppm: 80, soldSinceChange: flow(40_000, 0, 1, 3), recent: lastDays(4, 12, 12, 14), cooldown: lastChange(12) });
  assert.equal(dayOld.targetPpm, 80, why(dayOld));
  assert.ok(noDrainLine(dayOld), why(dayOld));
  // The cooldown's stamp says when the fee was set, where the log's last
  // record is older (a fee found set outside the app is stamped when found,
  // review FEE-10): 12 h, not the 100 h since the record.
  const found = drains({}, { ppm: 80, soldSinceChange: flow(40_000, 0, 1, 3), recent: lastDays(4, 12, 12, 14), cooldown: lastChange(12), lastChange: { at: hoursAgo(100), fromPpm: 60, toPpm: 80, via: "autopilot" } });
  assert.ok(noDrainLine(found), why(found));
  // Three sales of 50k in the 20 minutes since the fee was set: 150k over the
  // six hours is 600k a day — not 150k in 20 minutes, 10.8M a day.
  const minutes = drains({}, { ppm: 80, soldSinceChange: threeSales, cooldown: lastChange(1 / 3) });
  assert.ok(
    minutes.reasons.some((x) => x.startsWith("drain: it sells ~600k a day net at 80 ppm — at that rate it is down to 10% local in about a day")),
    why(minutes),
  );
});

test("sats a channel that routes both ways sold on some days and got back on others are no drain: four days with 1M more out than in, and 250k net out in the 14 days, do not ramp a 5M channel at half local (random buyers: raised 110 → 130 ppm, held, a fifth less earned than at the fee held flat)", () => {
  const big = chan({ capacity: 5_000_000, localRatio: 0.48 });
  const at = (net14: number) =>
    buildRecommendation(
      big,
      ctx({ ppm: 110, f14: flow(3_250_000, 3_250_000 - net14, 70, 357), f30: flow(6_500_000, 6_250_000, 140, 715), soldSinceChange: flow(1_850_000, 850_000, 17, 203), cooldown: lastChange(96) }),
    );
  const twoWay = at(250_000);
  assert.ok(noDrainLine(twoWay), why(twoWay));
  assert.ok(twoWay.targetPpm <= 110, why(twoWay));
  // Where the 14 days keep half of it (500k of the stretch's 1M), it is a drain.
  const kept = at(500_000);
  assert.match(kept.reasons[0], /^drain: it sells ~250k a day net at 110 ppm — at that rate it is down to 10% local in ~8 d/, why(kept));
  assert.equal(kept.targetPpm, 130, why(kept));
});

test("a drain measured since the fee was set more than two weeks ago is held against 14 days of net outflow, not its whole stretch: 50k a day net for 30 days is a drain the 14 days keep", () => {
  // 1.5M net out in the 30 days at 80 ppm; 700k of it in the last 14.
  const steady = drains({}, { ppm: 80, f14: flow(700_000, 0, 28, 56), soldSinceChange: flow(1_500_000, 0, 60, 120), cooldown: lastChange(30 * 24) });
  assert.match(steady.reasons[0], /^drain: it sells ~50k a day net at 80 ppm/, why(steady));
});

test("no drain ramp on thin evidence: under three sales or 5 % of the capacity net out in a stretch, what came in taken off; two weeks that are even; more than three weeks from drained; where raising lost revenue before", () => {
  const set = { ppm: 80, cooldown: lastChange(12) };
  for (const [name, r] of [
    ["90k, 4.5 % of the capacity", drains({}, { ...set, soldSinceChange: flow(90_000, 0, 3, 7) })],
    ["two sales", drains({}, { ...set, soldSinceChange: flow(150_000, 0, 2, 12) })],
    ["150k out and 60k in", drains({}, { ...set, soldSinceChange: flow(150_000, 60_000, 4, 12) })],
    // A channel that routes both ways has days on which it only sells.
    ["two even weeks", drains({}, { ...set, ...twoWay, soldSinceChange: threeSales })],
    ["elasticity", drains({}, { ...set, soldSinceChange: threeSales, elasticityMod: 0.9 })],
    // 80 % local selling 60k a day: 23 days to 10 %.
    ["23 days from drained", drains({ localRatio: 0.8 }, { ppm: 50, soldSinceChange: flow(180_000, 0, 6, 9), recent: lastDays(1, 4, 4, 4), cooldown: lastChange(72) })],
  ] as const) {
    assert.equal(r.targetPpm, r.currentPpm, `${name}: ${why(r)}`);
    assert.ok(noDrainLine(r), `${name}: ${why(r)}`);
  }
  // Under 10 % local the liquidity is gone: protect and the demand ramp have it.
  const drained = drains({ localRatio: 0.08 }, { ...set, soldSinceChange: threeSales });
  assert.ok(noDrainLine(drained), why(drained));
  assert.match(drained.reasons[0], /^protect: drained \(8% local\) but still in demand/);
});

test("a fast drain is priced for the balance it will have in 7 days at its rate: a channel over its target that sells 5 % of its capacity a day was priced as full until it was empty", () => {
  // 80 % local, 100k a day: 45 % in a week — under its target, where the curve says 90 ppm.
  const sells = { ppm: 50, recent: lastDays(2, 6, 6, 6), cooldown: lastChange(72) };
  const ramped = drains({ localRatio: 0.8 }, { ...sells, soldSinceChange: flow(300_000, 0, 6, 15) });
  assert.deepEqual([ramped.targetPpm, ramped.aimPpm], [70, 90], why(ramped));
  assert.equal(
    ramped.reasons[0],
    "drain: it sells ~100k a day net at 50 ppm — at that rate it is down to 10% local in ~14 d (6 sales since it was set 3 d ago) — raising a quarter of the fee per move (at least two steps), at most every 6 h: 50→70 on the way to 90 ppm",
  );
  // With the sales at the fee not read, the aim holds and the raise is the ordinary step.
  const unread = drains({ localRatio: 0.8 }, sells);
  assert.deepEqual([unread.targetPpm, unread.aimPpm], [70, 90], why(unread));
  assert.equal(
    unread.reasons[0],
    "drain: it sells ~100k a day net at 50 ppm — at that rate it is down to 10% local in ~14 d — priced for the ~45% local it will have in 7 days: ~90 ppm",
  );
  assert.ok(unread.reasons.includes("guard: raising at most 20 ppm per move — 50→70 on the way to 90 ppm"), why(unread));
  // Selling faster than it holds for a week: priced as empty.
  const empty = drains({}, { ppm: 80, recent: lastDays(1, 12, 12, 14), cooldown: lastChange(96) });
  assert.equal(empty.reasons[0], "drain: it sells ~200k a day net at 80 ppm — at that rate it is down to 10% local in ~4 d — priced for the empty channel it would be in 7 days: ~1000 ppm");
  // Without the drain the same channel stays where it is.
  const slow = drains({ localRatio: 0.8 }, { ppm: 50, soldSinceChange: flow(40_000, 0, 1, 2), recent: lastDays(0, 1, 1, 1), cooldown: lastChange(72) });
  assert.equal(slow.targetPpm, 50, why(slow));
});

test("with a refill cost known the drain ramp goes a third of the way to it per move, never more than doubling the fee — and a fast drain is priced toward that cost before 30 days of net outflow say 'draining' (2.95M sold at a seventh of the refill cost shown beside it)", () => {
  const set = { soldSinceChange: threeSales, cooldown: lastChange(12), market: market(400) };
  // A refill costs 400 ppm, 460 with the margin: a third of 80→460 is 120, doubling is 80.
  const at80 = drains({}, { ppm: 80, ...set });
  assert.equal(at80.targetPpm, 160, why(at80));
  assert.equal(
    at80.reasons[0],
    "drain: it sells ~300k a day net at 80 ppm — at that rate it is down to 10% local in ~3 d (3 sales since it was set 12 h ago) — raising a third of the way to its refill cost per move (never more than doubling the fee), at most every 6 h: 80→160 on the way to 1000 ppm",
  );
  // (Its aim is the drain's, past the refill cost: the cost is said, not "pricing toward 460 ppm".)
  assert.ok(at80.reasons.includes("replacement: draining, and a refill costs at least ~400 ppm (others charge ~400 into the peer)"), why(at80));
  assert.equal(drains({}, { ppm: 200, ...set }).targetPpm, 280);
  // Near the refill cost the quarter of the fee is the wider step again.
  const near = drains({}, { ppm: 380, ...set });
  assert.equal(near.targetPpm, 470, why(near));
  assert.match(near.reasons[0], /raising a quarter of the fee per move \(at least two steps\)/);
  // A slower drain on a full channel: the refill cost is the aim, and says so.
  const full = drains({ localRatio: 0.8 }, { ppm: 50, soldSinceChange: flow(300_000, 0, 6, 15), recent: lastDays(2, 6, 6, 6), cooldown: lastChange(72), market: market(400) });
  assert.deepEqual([full.targetPpm, full.aimPpm], [100, 460], why(full));
  assert.ok(full.reasons.includes("replacement: draining, and a refill costs at least ~400 ppm (others charge ~400 into the peer) — pricing toward 460 ppm"), why(full));
  // No fast drain, and 7.5 % net out in 30 days: the refill cost is not its price.
  const even = drains({}, { ppm: 80, soldSinceChange: flow(40_000, 0, 1, 3), cooldown: lastChange(12), market: market(400) });
  assert.equal(even.targetPpm, 80, why(even));
  assert.ok(!even.reasons.some((x) => /^replacement:/.test(x)), why(even));
});

// ── what the engine reads from the fee-change log and the forwards ──────────

const fwd = (hoursBefore: number, tokens = 20_000, feeMsat = 3_000) => ({
  createdAt: hoursAgo(hoursBefore),
  incomingChannel: "in",
  outgoingChannel: ID,
  tokens,
  fee: Math.round(feeMsat / 1000),
  feeMsat,
});
const change = (
  hoursBefore: number,
  fromPpm: number | null,
  toPpm: number,
  o: Partial<{ via: "autopilot" | "manual" | "lease"; why: string; pinned: boolean }> = {},
) => ({
  at: hoursAgo(hoursBefore),
  fromPpm,
  toPpm,
  via: "autopilot" as "autopilot" | "manual" | "lease",
  ...o,
});

test("the climb to the current fee is read from the fee-change log: its consecutive raises, where it began and the highest price on the way that sold", () => {
  const FROM = NOW - 30 * DAY;
  const log = [change(200, 300, 80), change(90, 80, 100), change(80, 100, 150), change(70, 150, 200), change(60, 200, 350)];
  // Sales while it stood at 100 (hours 90–80) and at 150 (80–70), none at 200.
  const events = [fwd(85), fwd(75), fwd(74)];
  assert.deepEqual(raiseChainOf(events, ID, log, 350, FROM, NOW), { basePpm: 80, soldPpm: 150, steps: 4, startedAt: hoursAgo(90) });
  // Nothing sold on the way: no price to go back to but the start.
  assert.deepEqual(raiseChainOf([], ID, log, 350, FROM, NOW), { basePpm: 80, soldPpm: null, steps: 4, startedAt: hoursAgo(90) });
  // A sale under 1,000 sat is no sale, and one at the current fee is not "on the way".
  assert.equal(raiseChainOf([fwd(75, 900), fwd(10)], ID, log, 350, FROM, NOW)?.soldPpm, null);
  // A raise by hand, a pin or a lease promise ends the climb: what came before is not the autopilot's.
  const byHand = [change(90, 80, 100), change(80, 100, 150, { via: "manual" }), change(70, 150, 200), change(60, 200, 350)];
  assert.deepEqual(raiseChainOf(events, ID, byHand, 350, FROM, NOW), { basePpm: 150, soldPpm: null, steps: 2, startedAt: hoursAgo(70) });
  assert.equal(raiseChainOf(events, ID, [change(70, 150, 200), change(60, 200, 350, { via: "lease" })], 350, FROM, NOW), null);
  assert.equal(raiseChainOf(events, ID, [change(60, 200, 350, { why: "pinned to 350 ppm" })], 350, FROM, NOW), null);
  // A lowering in between, a gap in the log, an unknown "from" and a fee LND no longer has end it too.
  assert.equal(raiseChainOf(events, ID, [change(90, 80, 150), change(70, 300, 200), change(60, 200, 350)], 350, FROM, NOW)?.basePpm, 200);
  assert.equal(raiseChainOf(events, ID, [change(90, 80, 150), change(60, 200, 350)], 350, FROM, NOW)?.basePpm, 200);
  assert.equal(raiseChainOf(events, ID, [change(60, null, 350)], 350, FROM, NOW), null);
  assert.equal(raiseChainOf(events, ID, log, 400, FROM, NOW), null);
  // A raise older than the forwards read is not part of it: what sold before isn't known.
  assert.equal(raiseChainOf(events, ID, log, 350, NOW - 75 * HOUR, NOW)?.basePpm, 150);
});

test("what sold while the fee stood at this one or higher, or at this one or lower, is read from the fee-change log and the forwards — with how long that was; and what sold in the last 1, 3, 7 and 14 days", () => {
  const FROM = NOW - 14 * DAY;
  // 300 ppm, a test at 330 from 200 h to 100 h ago, 300 again since.
  const log = [change(200, 300, 330), change(100, 330, 300)];
  const cameIn = (hoursBefore: number, tokens: number) => ({ ...fwd(hoursBefore, tokens, 0), incomingChannel: ID, outgoingChannel: "out" });
  const events = [fwd(250, 50_000, 15_000), fwd(150, 40_000, 13_000), cameIn(120, 70_000), cameIn(60, 20_000), fwd(50, 30_000, 9_000)];
  const at = (keep: (ppm: number) => boolean, currentPpm = 300, history = log) => flowAtFees(events, ID, history, currentPpm, FROM, NOW, keep);
  assert.deepEqual(at((ppm) => ppm <= 300), { out: 80_000, inn: 20_000, revenue: 24, forwards: 2, ms: 236 * HOUR });
  assert.deepEqual(at((ppm) => ppm >= 300), { out: 120_000, inn: 90_000, revenue: 37, forwards: 3, ms: 14 * DAY });
  assert.deepEqual(at((ppm) => ppm >= 330), { out: 40_000, inn: 70_000, revenue: 13, forwards: 1, ms: 100 * HOUR });
  // No change in the stretch: the fee it has, all of it.
  assert.deepEqual(at(() => true, 300, []), { out: 120_000, inn: 90_000, revenue: 37, forwards: 3, ms: 14 * DAY });
  // A change before the stretch says what the fee was when it began.
  assert.equal(at((ppm) => ppm === 330, 330, [change(400, 300, 330)]).ms, 14 * DAY);
  // What the log doesn't say is left out: the time since a last change that
  // did not end at the fee LND has (set outside the app since), and the time
  // before a change whose "from" wasn't known.
  assert.deepEqual(at(() => true, 310), { out: 90_000, inn: 70_000, revenue: 28, forwards: 2, ms: 236 * HOUR });
  assert.equal(at(() => true, 300, [change(200, null, 330), change(100, 330, 300)]).ms, 200 * HOUR);

  const recent = recentSales([fwd(150, 50_000, 10_000), fwd(120, 30_000, 6_000), fwd(50, 40_000, 8_800), fwd(2, 10_000, 2_200)], ID, NOW);
  assert.deepEqual([recent.d1.forwards, recent.d3.forwards, recent.d7.forwards, recent.d14.forwards], [1, 2, 4, 4]);
  assert.equal(recent.d3.out, 50_000);
});

const TESTED = { why: "price test: it sells at 80 ppm (10 sales since it was set 4 d ago, 7 in the last 7 days) and holds no more than its target — trying 90 ppm" };
const WENT_BACK = { why: "step back: tried 100→110 ppm 3 d ago and it earned less in its first 72 h" };

test("the price test that set the current fee and the two stretches it is judged on: the 72 h before it, at the fee before, and its first 72 h — none where the last change is no price test or the 72 h before it are not on record whole", () => {
  const FROM = NOW - 30 * DAY;
  // 80 ppm since 172 h ago, tested at 90 ppm 80 h ago.
  const log = [change(172, 100, 80), change(80, 80, 90, TESTED)];
  // One sale before the 72 h, two in them (8 sat), two in the test's first 72 h (9 sat), one after them.
  const events = [fwd(160, 50_000, 4_000), fwd(150, 50_000, 4_000), fwd(100, 50_000, 4_000), fwd(79, 50_000, 4_500), fwd(10, 50_000, 4_500), fwd(5, 50_000, 4_500)];
  assert.deepEqual(priceTestOf(events, ID, log, 90, FROM, NOW), { fromPpm: 80, at: hoursAgo(80), before: flow(100_000, 0, 2, 8), first: flow(100_000, 0, 2, 9) });
  // In its first hours the stretch after it holds what sold so far.
  assert.deepEqual(priceTestOf(events, ID, [change(172, 100, 80), change(8, 80, 90, TESTED)], 90, FROM, NOW)?.first, flow(50_000, 0, 1, 4.5));
  // A raise a rule made, one by hand, a lowering; a fee LND no longer has.
  assert.equal(priceTestOf(events, ID, [change(172, 100, 80), change(80, 80, 90, { why: "balance: low local ratio" })], 90, FROM, NOW), null);
  assert.equal(priceTestOf(events, ID, [change(172, 100, 80), change(80, 80, 90, { ...TESTED, via: "manual" })], 90, FROM, NOW), null);
  assert.equal(priceTestOf(events, ID, [change(80, 80, 90, TESTED), change(40, 90, 80, WENT_BACK)], 80, FROM, NOW), null);
  assert.equal(priceTestOf(events, ID, log, 100, FROM, NOW), null);
  assert.equal(priceTestOf(events, ID, [], 90, FROM, NOW), null);
  // The fee before stood 71 h only, or the forwards read begins 71 h before the test: nothing to set it against.
  assert.equal(priceTestOf(events, ID, [change(151, 100, 80), change(80, 80, 90, TESTED)], 90, FROM, NOW), null);
  assert.notEqual(priceTestOf(events, ID, [change(152, 100, 80), change(80, 80, 90, TESTED)], 90, FROM, NOW), null);
  assert.equal(priceTestOf(events, ID, [change(80, 80, 90, TESTED)], 90, NOW - 151 * HOUR, NOW), null);
  assert.notEqual(priceTestOf(events, ID, [change(80, 80, 90, TESTED)], 90, NOW - 152 * HOUR, NOW), null);
});

test("the climb of price tests the current fee belongs to: the fee before the earliest test since which it never came back to that fee, how many tests since, and the check at the end of each of its weeks — 7 days against 7 after the first, 14 against 14 after the second, 7 after the third, in force for 48 h", () => {
  const FROM = NOW - 30 * DAY;
  const two = (first: number, second = 90) => [change(first, 90, 100, TESTED), change(second, 100, 110, TESTED)];
  // 90 → 100 a week and 3 h ago, → 110 since: 18 sat in the 7 days before the climb, 21 in its first week.
  const events = [fwd(400), fwd(300, 100_000, 9_000), fwd(200, 100_000, 9_000), fwd(150, 100_000, 10_000), fwd(50, 100_000, 11_000), fwd(2)];
  assert.deepEqual(climbAnchorOf(events, ID, two(171), 110, FROM, NOW), {
    ppm: 90,
    startedAt: hoursAgo(171),
    tests: 2,
    ruleRaises: 0,
    beforeNetOut: 200_000,
    beforeHours: 144,
    week: { n: 1, hours: 168, window: 168, from: NOW - 171 * HOUR, now: flow(200_000, 0, 2, 21), before: flow(200_000, 0, 2, 18) },
  });
  // No check before the first week is over, nor from 48 h after its end until the next.
  assert.deepEqual(climbAnchorOf(events, ID, two(167), 110, FROM, NOW), { ppm: 90, startedAt: hoursAgo(167), tests: 2, ruleRaises: 0, beforeNetOut: 0, beforeHours: 0, week: null });
  assert.equal(climbAnchorOf(events, ID, two(168 + 48), 110, FROM, NOW)?.week?.n, 1);
  assert.equal(climbAnchorOf(events, ID, two(168 + 49), 110, FROM, NOW)?.week, null);
  // The stretches: 14 days after the second week; 7 again after the third (a
  // 30-day read holds no more before the climb); none after the fourth.
  const weekOf = (first: number) => {
    const w = climbAnchorOf(events, ID, two(first), 110, FROM, NOW)?.week;
    return w ? [w.n, w.hours, (NOW - w.from) / HOUR] : null;
  };
  assert.deepEqual(weekOf(2 * 168 + 3), [2, 336, 339]);
  assert.deepEqual(weekOf(3 * 168 + 3), [3, 168, 171]);
  assert.equal(weekOf(4 * 168 + 3), null);
  // Every run in the 48 h reads the same two stretches (what is on record at their end).
  assert.deepEqual(weekOf(3 * 168 + 47), [3, 125, 215]); // (without the second test, 43 h old when the week ended)
  // The fee before the climb stood 100 h before it: the stretches are 100 h…
  assert.deepEqual(climbAnchorOf(events, ID, [change(271, 120, 90), ...two(171)], 110, FROM, NOW)?.week?.hours, 100);
  // …and under 72 h it is not what a climb is checked against: the climb is the next test's.
  assert.deepEqual(climbAnchorOf(events, ID, [change(231, 120, 90), ...two(171)], 110, FROM, NOW), { ppm: 100, startedAt: hoursAgo(90), tests: 1, ruleRaises: 0, beforeNetOut: 0, beforeHours: 0, week: null });

  // A test taken back to a fee above the climb's start is part of it…
  const withBack = [change(400, 90, 100, TESTED), change(300, 100, 110, TESTED), change(250, 110, 100, WENT_BACK), change(171, 100, 110, TESTED)];
  assert.deepEqual(climbAnchorOf(events, ID, withBack, 110, FROM, NOW), { ppm: 90, startedAt: hoursAgo(400), tests: 3, ruleRaises: 0, beforeNetOut: 0, beforeHours: 0, week: null });
  // The hours of a test that was taken back are no part of the week's check
  // (nothing sells at a fee above what buyers pay — that is not what the fee
  // below it earns), nor those of a test not yet judged when the week ended;
  // as many hours less are read before the climb. Under 72 h left: no check.
  const judgedOn = (log: ReturnType<typeof change>[], ppm: number) => {
    const w = climbAnchorOf(events, ID, log, ppm, FROM, NOW)?.week;
    return w ? [w.hours, w.window, w.now.revenue, w.before.revenue] : null;
  };
  assert.deepEqual(judgedOn([change(171, 90, 100, TESTED), change(120, 100, 110, TESTED), change(72, 110, 100, WENT_BACK)], 100), [120, 168, 21, 9]);
  assert.deepEqual(judgedOn([change(171, 90, 100, TESTED), change(70, 100, 110, TESTED)], 110), [101, 168, 10, 9]);
  assert.equal(judgedOn([change(171, 90, 100, TESTED), change(150, 100, 110, TESTED), change(50, 110, 100, WENT_BACK)], 100), null);
  // …one taken back to the start ends it: the next test begins a new climb.
  const fromStart = [change(400, 90, 100, TESTED), change(300, 100, 90, WENT_BACK), change(171, 90, 100, TESTED)];
  const again = climbAnchorOf(events, ID, fromStart, 100, FROM, NOW);
  // Its check reads the fee it began at over the 129 h after the step-back
  // and, the test taken back left out, the hours before that test: 168 h,
  // as many as the climb has stood (the package's second review, Q1).
  assert.deepEqual([again?.ppm, again?.startedAt, again?.tests, again?.week?.hours], [90, hoursAgo(171), 1, 168]);
  // A raise one of the drain rules made is part of the climb, and counted
  // apart (the package's second review, Q1: it was never judged, and the
  // hold kept it for good)…
  assert.deepEqual(climbAnchorOf(events, ID, [change(400, 90, 100, TESTED), change(171, 100, 110, { why: "balance: low local ratio" })], 110, FROM, NOW), {
    ppm: 90,
    startedAt: hoursAgo(400),
    tests: 1,
    ruleRaises: 1,
    beforeNetOut: 0,
    beforeHours: 0,
    week: null,
  });
  // …and a raise toward a refill cost, a change by hand and a gap in the log end it.
  assert.equal(climbAnchorOf(events, ID, [change(400, 90, 100, TESTED), change(171, 100, 110, { why: "replacement: refilling costs 120 ppm" })], 110, FROM, NOW), null);
  assert.equal(climbAnchorOf(events, ID, [change(400, 80, 90, TESTED), change(300, 90, 100, { ...TESTED, via: "manual" }), change(171, 100, 110, TESTED)], 110, FROM, NOW)?.ppm, 100);
  assert.equal(climbAnchorOf(events, ID, [change(400, 80, 90, TESTED), change(171, 100, 110, TESTED)], 110, FROM, NOW)?.ppm, 100);
  // None: no change, a last change that did not end at the fee LND has, a test older than the forwards read.
  assert.equal(climbAnchorOf(events, ID, [], 110, FROM, NOW), null);
  assert.equal(climbAnchorOf(events, ID, two(171), 120, FROM, NOW), null);
  assert.equal(climbAnchorOf(events, ID, [change(171, 90, 100, TESTED)], 100, NOW - 100 * HOUR, NOW), null);
});

test("the fee a climb began at is read across a climb taken back to it — a test's, or the drain rules' — its hours left out and what sold in them too, not across one that began at another fee; a demand ramp's raise is part of a climb (the review's second round, N2, N6)", () => {
  const FROM = NOW - 30 * DAY;
  const events = [fwd(400), fwd(350, 100_000, 9_000), fwd(300, 100_000, 9_000), fwd(200, 100_000, 9_000), fwd(150, 100_000, 10_000), fwd(50, 100_000, 11_000), fwd(2)];
  // A test from 90 taken back to it: its 100 h (one sale at 350 h) are not read; the 168 h before the climb are the 129 h after the
  // step-back (the sale at 200 h) and the 39 h before the test (none).
  const fromStart = [change(400, 90, 100, TESTED), change(300, 100, 90, WENT_BACK), change(171, 90, 100, TESTED)];
  const w = climbAnchorOf(events, ID, fromStart, 100, FROM, NOW)?.week;
  assert.deepEqual([w?.hours, w?.before.forwards, w?.before.revenue], [168, 1, 9]);
  // The same across a raise of the drain rules that was taken back.
  const drainBack = [change(400, 90, 100, { why: "drain: it sells ~300k a day net at 90 ppm" }), change(300, 100, 90, { why: "step back: raised 90→100 ppm by the drain rules 4 d ago, the drain is over, and it earned less there" }), change(171, 90, 100, TESTED)];
  assert.equal(climbAnchorOf(events, ID, drainBack, 100, FROM, NOW)?.week?.hours, 168);
  // A climb that began at another fee (80) and was taken back only to 90 is
  // still the climb from 80: it is checked against 80, never against a 90
  // that stood 129 h.
  const elsewhere = [change(400, 80, 100, TESTED), change(300, 100, 90, WENT_BACK), change(171, 90, 100, TESTED)];
  assert.deepEqual([climbAnchorOf(events, ID, elsewhere, 100, FROM, NOW)?.ppm, climbAnchorOf(events, ID, elsewhere, 100, FROM, NOW)?.tests], [80, 2]);
  // What went out net at the fee before, for "it drained there": the
  // week's stretch without its last day — a burst of 1M an hour before the
  // climb began is what set it off, not a drain the fee before allowed.
  const burst = [...events, fwd(172, 1_000_000, 90_000)];
  const before = climbAnchorOf(burst, ID, fromStart, 100, FROM, NOW);
  assert.deepEqual([before?.beforeNetOut, before?.beforeHours], [100_000, 144]);
  // A change by hand before the step-back's climb ends the reading there:
  // the fee before it was another (120), not 90 — 129 h.
  const byHand = [change(400, 120, 100, { via: "manual" }), change(300, 100, 90, WENT_BACK), change(171, 90, 100, TESTED)];
  assert.equal(climbAnchorOf(events, ID, byHand, 100, FROM, NOW)?.week?.hours, 129);
  // The demand ramp's raise of a drained channel begins a climb.
  const demand = climbAnchorOf(events, ID, [change(171, 90, 110, { why: "demand: drained (5% local) and sold 3 times at 90 ppm since it was set" })], 110, FROM, NOW);
  assert.deepEqual([demand?.ppm, demand?.ruleRaises, demand?.tests], [90, 1, 0]);
});

test("with the forwarding history incomplete the holds for a fee that sells cannot speak — the run says so in a line of its own, and the fee is still lowered", () => {
  const unknown = rule({}, { ppm: 300, recent: undefined, soldSinceChange: undefined, cooldown: lastChange(240) });
  assert.equal(unknown.targetPpm, 270, why(unknown));
  assert.ok(unknown.reasons.includes("sales unknown: the forwarding history could not be read whole — the hold for a fee that sells does not apply on this run"), why(unknown));
  // Known sales: no such line.
  const known = rule({}, { ppm: 300, soldSinceChange: flow(100_000, 0, 2, 30), recent: week(2), cooldown: lastChange(240) });
  assert.equal(known.targetPpm, 270, why(known));
  assert.ok(!known.reasons.some((x) => /^sales unknown/.test(x)), why(known));
});
