/**
 * The refill plan's route question (review 2026-11-10, REB-1).
 *
 * Before: every size was asked for under a 3,000 ppm fee limit, and the fee
 * of the route LND answered with was called "the cheapest route". LND does
 * not answer with the cheapest route: it answers with the one its own
 * weighting prefers — fee, time lock, chance of success — among those within
 * the fee limit, and with a cheaper one only when the limit rules the
 * preferred one out. A drained channel whose refill may cost 320 ppm read
 * "cheapest route 500 ppm (max 320) — too expensive even at smaller sizes"
 * run after run, and a route within its limit was never asked for and never
 * tried.
 *
 * The fake LND here answers as LND does: with the first of the routes it
 * knows — the preferred one first — whose fee is within the limit asked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { REBAL_REC_DEFAULTS, type RouteProbe } from "../src/services/rebalanceRecommend.js";
import { estimateCost } from "../src/services/rebalance.js";
import { drainedSpec, lndPreferring, planNode, planOf, type RouteQuestion } from "./helpers/refillPlan.js";

/** The probe exactly as getRebalanceRecommendations builds it. */
const probeOf = (node: ReturnType<typeof lndPreferring>): RouteProbe => (source, target, amount, maxFeeSats) =>
  estimateCost(node.lnd, node.publicKey, source, target, amount, REBAL_REC_DEFAULTS.probeCeilingPpm, maxFeeSats);
/** A drained channel earning 400 ppm (the gate: at most 320 ppm) and an idle donor. */
const drainedAndDonor = () => planNode([drainedSpec(1), { n: 2, local: 4_000_000 }]);

test("a refill is asked for under its own cap: where LND prefers a 500 ppm route and knows one at 200 ppm, the drained channel that may pay 320 ppm is refilled at 200 (before: 'cheapest route 500 ppm (max 320)', no refill)", async () => {
  const asked: RouteQuestion[] = [];
  const plan = await planOf(drainedAndDonor(), probeOf(lndPreferring([500, 200], asked)));
  const row = plan.recommendations.find((r) => r.channelId === "850000x1x0");
  assert.equal(row?.state, "route_found_profitable", row?.reasons.join(" | "));
  assert.equal(row?.wouldRebalance, true);
  assert.equal(row?.estimatedRouteCostPpm, 200);
  assert.equal(row?.maxCostPpm, 320);
  assert.equal(row?.recommendedAmount, 1_250_000);
  // The planned size and its half: one question each, under that size's own
  // cap (the lower of 320 ppm and what the size earns less the 100 sat
  // minimum: 380 and 150 sat) — answered with the 200 ppm route.
  const of = (size: number) => asked.filter((q) => q.amountSats === size);
  assert.deepEqual(of(1_250_000).map((q) => [q.limitSats, q.answerPpm]), [[380, 200]]);
  assert.deepEqual(of(625_000).map((q) => [q.limitSats, q.answerPpm]), [[150, 200]]);
  // The quarter may cost 25 sat (125 earned less the minimum): nothing within
  // it, so the ceiling's question follows for a price.
  assert.deepEqual(of(312_500).map((q) => [q.limitSats, q.answerPpm]), [[25, null], [938, 500]]);
  assert.equal(asked.length, 4);
  // The planned size's question carried the very cap its payment will: the row's own.
  assert.equal(row?.maxFeeSats, 380);
  assert.ok((row?.estimatedRouteFeeSats ?? Infinity) <= (row?.maxFeeSats ?? 0));
  assert.match(plan.refill.note, /cost ~200 ppm right now/);
});

test("with no route within the cap LND is asked once more under the ceiling, for a price to show — and the row says no route was found within its max, not that the cheapest one costs more", async () => {
  const asked: RouteQuestion[] = [];
  const plan = await planOf(drainedAndDonor(), probeOf(lndPreferring([500], asked)));
  const row = plan.recommendations.find((r) => r.channelId === "850000x1x0");
  assert.equal(row?.state, "route_found_too_expensive");
  assert.equal(row?.wouldRebalance, false);
  assert.equal(row?.estimatedRouteCostPpm, 500);
  const said = row?.reasons.join(" | ") ?? "";
  assert.match(said, /no route found within its max of 320 ppm — the route LND offers costs 500 ppm/);
  assert.doesNotMatch(said, /cheapest/);
  assert.match(row?.sourceCandidates?.[0]?.rejectedReason ?? "", /^no route within 320 ppm — the one LND offers costs 500 ppm$/);
  assert.doesNotMatch(plan.refill.note, /cheapest route|costs ~500 ppm right now \(median/);
  assert.match(plan.refill.note, /not the cheapest there is/);
  // Per size: first under its cap (no answer), then under the 3,000 ppm ceiling.
  for (const size of [1_250_000, 625_000, 312_500]) {
    const of = asked.filter((q) => q.amountSats === size);
    assert.equal(of.length, 2, `two questions for ${size}`);
    const [under, ceiling] = [...of].sort((a, b) => a.limitSats - b.limitSats);
    assert.ok(under.limitPpm <= 320 && under.answerPpm === null, `${size}: under its cap, no route`);
    assert.ok(ceiling.limitPpm >= 3000 && ceiling.limitPpm <= 3001 && ceiling.answerPpm === 500, `${size}: under the ceiling, the 500 ppm route`);
  }
});

test("a size whose cap is under one sat is not asked for under it: the one question is the ceiling's", async () => {
  const asked: RouteQuestion[] = [];
  // 60 sat of revenue in 14 days on 1.2M out: 50 ppm — a 100 sat net minimum leaves no cap at any size.
  const node = planNode([drainedSpec(1, { feePpm: 50, f14: { out: 1_200_000, inn: 200_000, forwards: 20, revenue: 60 }, f30: { out: 2_400_000, inn: 400_000, forwards: 40, revenue: 120 } }), { n: 2, local: 4_000_000 }]);
  const plan = await planOf(node, probeOf(lndPreferring([500, 200], asked)));
  const row = plan.recommendations.find((r) => r.channelId === "850000x1x0");
  assert.equal(row?.wouldRebalance, false);
  assert.ok(asked.length >= 1, row?.reasons.join(" | "));
  for (const q of asked) assert.ok(q.limitPpm >= 3000, `asked ${q.amountSats} under ${q.limitPpm} ppm`);
});

test("estimateCost asks LND for a route within the sats given, and within the ppm ceiling when none are given", async () => {
  const asked: RouteQuestion[] = [];
  const lnd = lndPreferring([500, 200], asked);
  const n = drainedAndDonor();
  const [target, donor] = n.channels;
  assert.deepEqual(await estimateCost(lnd.lnd, lnd.publicKey, donor, target, 1_000_000, 3000, 320), { costPpm: 200, feeSats: 200 });
  assert.deepEqual(await estimateCost(lnd.lnd, lnd.publicKey, donor, target, 1_000_000, 3000), { costPpm: 500, feeSats: 500 });
  assert.deepEqual(await estimateCost(lnd.lnd, lnd.publicKey, donor, target, 1_000_000, 3000, 199), { costPpm: null, feeSats: null });
  assert.deepEqual(asked.map((q) => q.limitSats), [320, 3000, 199]);
});
