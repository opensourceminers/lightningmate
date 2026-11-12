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
import { REBAL_REC_DEFAULTS, getRebalanceRecommendations, type RouteProbe } from "../src/services/rebalanceRecommend.js";
import { estimateCost } from "../src/services/rebalance.js";
import { drainedSpec, lndPreferring, planNode, planOf, type RouteQuestion } from "./helpers/refillPlan.js";
import { feeNode, forwardsOut, withMarket, type FeeChannel } from "./helpers/feeNode.js";

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

test("the route out of the source is asked for with every other peer shut out as a first hop — LND 0.21 ignores QueryRoutes' outgoing channel, and on regtest the 'route out of the source' went out over the target peer's own other channel and back for 2 sat (P4b regtest)", async () => {
  const asked: Record<string, unknown>[] = [];
  const lnd = lndPreferring([200], []);
  const inner = lnd.callsTo.bind(lnd);
  const n = drainedAndDonor();
  const [target, donor] = n.channels;
  const others = [target.peerPubkey, "02" + "77".repeat(32), donor.peerPubkey];
  await estimateCost(lnd.lnd, lnd.publicKey, donor, target, 1_000_000, 3000, 320, others);
  asked.push(...inner("default.queryRoutes"));
  const pairs = ((asked[0]?.ignored_pairs ?? []) as { from: Buffer; to: Buffer }[]).map((p) => [Buffer.from(p.from).toString("hex"), Buffer.from(p.to).toString("hex")]);
  assert.deepEqual(
    pairs.sort(),
    [
      [lnd.publicKey, target.peerPubkey],
      [lnd.publicKey, "02" + "77".repeat(32)],
    ].sort(),
    "every peer but the source's, the target's own included",
  );
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

test("the plan asks each route with the first hop to every peer but the source's shut out — the target's own peer and every other (the regtest fix, the review of P4, R13b)", async () => {
  const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
  const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
  const channels: FeeChannel[] = [
    { id: "850000x1x0", partnerPublicKey: PEER(1), capacity: 5_000_000, localBalance: 750_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 400, baseFeeMsat: 0 },
    { id: "850000x2x0", partnerPublicKey: PEER(2), capacity: 5_000_000, localBalance: 4_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
    { id: "850000x3x0", partnerPublicKey: PEER(3), capacity: 5_000_000, localBalance: 2_500_000, transactionId: TX(3), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
  ];
  const node = feeNode({ blockHeight: 860_000, channels, forwards: forwardsOut("850000x1x0", "850000x2x0", 20, { tokens: 60_000, feeMsat: 24_000, days: 10 }) });
  withMarket(node, channels, { "850000x1x0": { intoPpm: 100, backPpm: 50 } });
  // (Every route question is answered "no route"; what it carried is what counts.)
  node.override("default.queryRoutes", (_a: unknown, cb: (e: unknown) => void) => cb({ details: "unable to find a path to destination" }));
  const plan = await getRebalanceRecommendations(node.lnd, { rebalanceRecords: [], cooldown: null });
  const asked = node.callsTo("default.queryRoutes");
  assert.ok(asked.length > 0, `the plan asked for a route: ${JSON.stringify(plan.recommendations.map((r) => [r.channelId, r.state, r.reasons[0]]))}`);
  for (const q of asked) {
    const pairs = ((q.ignored_pairs ?? []) as { from: Buffer; to: Buffer }[]).map((p) => Buffer.from(p.to).toString("hex"));
    assert.ok(pairs.includes(PEER(1)), "the target's own peer is no first hop");
    // (One of the other two is the source; its peer is left open.)
    assert.ok(!(pairs.includes(PEER(2)) && pairs.includes(PEER(3))), "the source's peer is left open");
    assert.equal(pairs.length, 2, JSON.stringify(pairs));
  }
});
