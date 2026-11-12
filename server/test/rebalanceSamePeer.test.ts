/**
 * Two channels with one peer (review 2026-11-10, REB-2).
 *
 * LND forwards to a peer over any of its channels with enough balance, so the
 * outbound a sender can use toward a peer is the sum over them — and a payment
 * back to this node names the peer it comes through, never the channel: the
 * peer alone chooses which of its channels with us carries it.
 *
 * Before, the refill plan judged each channel by itself. A channel at 15 %
 * local was refilled for a fee while the same peer's other channel held 4M of
 * outbound; that other channel could be the very source (a paid loop out to
 * the peer and straight back); and wherever the sats arrived, cooldown, log
 * record, "sent" counter and fee hold were booked on the channel planned for —
 * which, when they arrived on its sibling, stayed drained and was refilled
 * again one cooldown later.
 *
 * A node gets a second channel with a peer when that peer buys one (Magma,
 * LSPS1) while it already has one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { REBAL_REC_DEFAULTS, buildSourcePool, type RebalanceRecommendation, type RouteProbe } from "../src/services/rebalanceRecommend.js";
import { SAME_PEER_SOURCE, executeRebalance, landedOn, type PeerChannelBefore } from "../src/services/rebalance.js";
import { drainedSpec, planFlow, planNode, planOf, PLAN_HEIGHT, type PlanNode } from "./helpers/refillPlan.js";
import { feeNode, type FeeChannel } from "./helpers/feeNode.js";
import { autopilotAt, autopilotWith } from "./helpers/autopilot.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";
import { until } from "./helpers/wait.js";

// ───────────────────────────── the plan ─────────────────────────────

/** A probe that answers every question with one price, and notes who asked. */
const probeAt = (ppm: number, asked: string[] = []): RouteProbe => async (source, target, amount) => {
  asked.push(`${source.id}>${target.id}`);
  return { costPpm: ppm, feeSats: Math.round((amount * ppm) / 1_000_000) };
};
const row = (plan: Awaited<ReturnType<typeof planOf>>, id: string) => plan.recommendations.find((r) => r.channelId === id) as RebalanceRecommendation;
const poolOf = (n: PlanNode) =>
  buildSourcePool(n.channels, new Map(n.fees.map((f) => [f.channelId, f])), {}, REBAL_REC_DEFAULTS, { soldLeases: [], currentBlock: PLAN_HEIGHT });
const A = "850000x1x0";
const B = "850000x2x0";
const C = "850000x3x0";
const D = "850000x4x0";

test("a channel at 15 % local whose peer's other channel holds 4M of outbound is not refilled: the peer can be reached with 4.75M of 10M (before: 1.25M was moved out of that very channel, for a fee)", async () => {
  // Peer 1 has two channels with us: A at 15 % local, B at 80 %.
  const node = planNode([drainedSpec(1), { n: 2, peer: 1, local: 4_000_000 }]);
  const asked: string[] = [];
  const plan = await planOf(node, probeAt(50, asked));
  const a = row(plan, A);
  assert.equal(a.state, "watching");
  assert.equal(a.wouldRebalance, false);
  assert.equal(a.recommendedAmount, null);
  assert.deepEqual(a.blockedBy, ["peer has outbound in another channel"]);
  assert.match(a.reasons[0], /^its peer is not drained: 4\.75M of 10M \(48%\) is local over its 2 channels with us — payments reach the peer over any of them/);
  assert.equal(a.selectedSourceChannel, null);
  assert.deepEqual(asked, [], "no route was asked for");
  assert.ok(!a.reasons.some((r) => /would take|to clear the gate/.test(r)), a.reasons.join(" | "));
  // Both rows name the peer's other channel (what the stage's guards go by).
  assert.deepEqual(a.peerChannels, [B]);
  assert.deepEqual(row(plan, B).peerChannels, [A]);
  // And B is no source at all: A and B together hold less than their shares.
  assert.deepEqual(poolOf(node), []);
  assert.equal(plan.summary.profitableRecommendations, 0);
});

test("nor is it refilled from a third channel: the outbound toward its peer is there, in the other channel (before: 1.25M bought from an idle channel, 'net +292 sat')", async () => {
  // B routes out a little — it would be no source anyway; its 4M still serve peer 1.
  const node = planNode([
    drainedSpec(1),
    { n: 2, peer: 1, local: 4_000_000, f14: planFlow(300_000, 0, 5, 30), f30: planFlow(300_000, 0, 5, 30) },
    { n: 3, local: 4_000_000 },
  ]);
  const asked: string[] = [];
  const plan = await planOf(node, probeAt(150, asked));
  const a = row(plan, A);
  assert.equal(a.wouldRebalance, false);
  assert.equal(a.state, "watching");
  assert.deepEqual(a.blockedBy, ["peer has outbound in another channel"]);
  assert.deepEqual(asked, []);
  // The idle channel of another peer keeps its whole spare for a channel that needs it.
  assert.deepEqual(poolOf(node).map((s) => [s.ch.id, s.spareSats, s.peer]), [[C, 1_250_000, undefined]]);
});

test("a peer drained over both its channels is refilled — once per plan: the second channel waits, its refill would be sized to the same lack and may arrive on either", async () => {
  const node = planNode([drainedSpec(1), drainedSpec(2, { peer: 1 }), { n: 3, local: 4_000_000 }, { n: 4, local: 4_000_000 }]);
  const asked: string[] = [];
  const plan = await planOf(node, probeAt(150, asked));
  const [a, b] = [row(plan, A), row(plan, B)];
  assert.equal(a.state, "route_found_profitable", a.reasons.join(" | "));
  assert.equal(a.wouldRebalance, true);
  assert.equal(a.selectedSourceChannel, C);
  assert.equal(a.recommendedAmount, 1_250_000, "the peer lacks 3.5M over both: the channel's own size stands");
  assert.equal(b.state, "watching");
  assert.equal(b.wouldRebalance, false);
  assert.equal(b.recommendedAmount, null);
  assert.deepEqual(b.blockedBy, ["one refill per peer"]);
  assert.match(b.reasons.at(-1) ?? "", new RegExp(`^its peer's other channel ${A} is refilled in this plan — one refill per peer at a time`));
  assert.ok(asked.length > 0 && asked.every((q) => q.endsWith(`>${A}`)), `routes asked for the first only: ${asked.join(", ")}`);
  assert.equal(plan.summary.profitableRecommendations, 1);
  // Where the first finds no route within its cap, the second is tried.
  const dear = await planOf(node, async (source, target, amount) => {
    const ppm = target.id === A ? 900 : 150;
    void source;
    return { costPpm: ppm, feeSats: Math.round((amount * ppm) / 1_000_000) };
  });
  assert.equal(row(dear, A).wouldRebalance, false);
  assert.equal(row(dear, B).state, "route_found_profitable", row(dear, B).reasons.join(" | "));
});

test("a refill is no larger than what the peer lacks over its channels together", async () => {
  // A lacks 1.75M to its half; with B's 3.2M the peer lacks 1.05M of 10M.
  const node = planNode([drainedSpec(1), { n: 2, peer: 1, local: 3_200_000 }, { n: 3, local: 4_000_000 }]);
  const plan = await planOf(node, probeAt(150), { cfg: { targetDeficitThreshold: 0.1 } });
  const a = row(plan, A);
  assert.equal(a.state, "route_found_profitable", a.reasons.join(" | "));
  assert.equal(a.recommendedAmount, 1_050_000);
  assert.ok(a.reasons.includes("sized to the 1.05M its peer lacks over its 2 channels with us (this channel alone would take 1.25M)"), a.reasons.join(" | "));
  // What the row shows as "to target" stays the channel's own.
  assert.equal(a.amountToReachTargetLocalRatio, 1_750_000);
});

test("a peer that lacks less than the smallest refill is left alone", async () => {
  const node = planNode([drainedSpec(1), { n: 2, peer: 1, local: 4_220_000 }, { n: 3, local: 4_000_000 }]);
  const asked: string[] = [];
  const plan = await planOf(node, probeAt(150, asked), { cfg: { targetDeficitThreshold: 0.001 } });
  const a = row(plan, A);
  assert.equal(a.state, "watching");
  assert.equal(a.wouldRebalance, false);
  assert.equal(a.recommendedAmount, null);
  assert.deepEqual(a.blockedBy, ["peer lacks too little"]);
  assert.ok(a.reasons.includes("its peer lacks only 30k over its 2 channels with us — too small for an economical rebalance"), a.reasons.join(" | "));
  assert.deepEqual(asked, []);
});

test("a channel of the target's own peer is never the source, however full it is: its balance is the peer's outbound already (before: picked — 'move 500k from peer-1')", async () => {
  // A (5M) at 5 % and B (2M) at 80 %: 1.85M of 7M — the peer is drained; B alone holds 500k above its share.
  const two = planNode([drainedSpec(1, { local: 250_000 }), { n: 2, peer: 1, capacity: 2_000_000, local: 1_600_000 }]);
  assert.deepEqual(poolOf(two), [], "the peer's channels together are under their shares: none of them gives");
  const asked: string[] = [];
  const alone = await planOf(two, probeAt(50, asked));
  assert.equal(row(alone, A).wouldRebalance, false);
  assert.equal(row(alone, A).state, "unprofitable_skip");
  assert.deepEqual(row(alone, A).blockedBy, ["no safe source channel"]);
  assert.match(row(alone, A).reasons.at(-1) ?? "", /^no channel can give liquidity: .* — and its peer's channels together above theirs$/);
  assert.deepEqual(asked, []);
  // With a channel of another peer it is refilled — from that one.
  const three = planNode([drainedSpec(1, { local: 250_000 }), { n: 2, peer: 1, capacity: 2_000_000, local: 1_600_000 }, { n: 3, local: 4_000_000 }]);
  const plan = await planOf(three, probeAt(150));
  assert.equal(row(plan, A).state, "route_found_profitable", row(plan, A).reasons.join(" | "));
  assert.equal(row(plan, A).selectedSourceChannel, C);
  assert.deepEqual(row(plan, A).sourceCandidates.map((s) => s.channelId), [C]);
});

test("a full channel beside an emptier one of the same peer gives only what the two hold above their shares together (before: its whole own spare — and the peer then read drained)", async () => {
  // Peer 1: 4.5M and 1.5M of 5M each — 6M of 10M; above their shares (55 % each) together: 500k.
  const node = planNode([{ n: 1, local: 4_500_000 }, { n: 2, peer: 1, local: 1_500_000 }, drainedSpec(3)]);
  assert.deepEqual(poolOf(node).map((s) => [s.ch.id, s.spareSats, s.peer]), [[A, 500_000, { channels: 2, spareSats: 500_000 }]]);
  const plan = await planOf(node, probeAt(150));
  const c = row(plan, C);
  assert.equal(c.state, "route_found_profitable", c.reasons.join(" | "));
  assert.equal(c.selectedSourceChannel, A);
  assert.equal(c.recommendedAmount, 500_000, "not the 1.25M the channel alone could spare");
  assert.equal(c.sourceCandidates[0].spareSats, 500_000);
  assert.equal(c.sourceCandidates[0].reason, "90% local, 500k to spare — what its peer's 2 channels with us hold above their shares together, not draining");
});

test("what one plan takes from a peer's channels is counted against what they spare together: the second refill finds nothing left (before: each channel gave the shared spare again)", async () => {
  // Peer 1: 4.5M, 3.6M and 0.65M of 5M each — 8.75M of 15M, 500k above their shares together.
  const node = planNode([{ n: 1, local: 4_500_000 }, { n: 2, peer: 1, local: 3_600_000 }, { n: 5, peer: 1, local: 650_000 }, drainedSpec(3), drainedSpec(4)]);
  assert.deepEqual(poolOf(node).map((s) => [s.ch.id, s.spareSats]), [[A, 500_000], [B, 500_000]]);
  const plan = await planOf(node, probeAt(150));
  const [c, d] = [row(plan, C), row(plan, D)];
  assert.equal(c.state, "route_found_profitable", c.reasons.join(" | "));
  assert.deepEqual([c.selectedSourceChannel, c.recommendedAmount], [A, 500_000]);
  assert.equal(d.wouldRebalance, false);
  assert.deepEqual(d.blockedBy, ["no safe source channel"]);
  assert.match(d.reasons.at(-1) ?? "", /^no source channel has enough to spare — the others' spare balance is already planned/);
});

test("a peer's two full channels each give their own spare when together they hold more: nothing changes for them", async () => {
  // Peer 1: 4.5M twice — 3.5M above their shares together, 1.75M each on its own.
  const node = planNode([{ n: 1, local: 4_500_000 }, { n: 2, peer: 1, local: 4_500_000 }, drainedSpec(3), drainedSpec(4)]);
  assert.deepEqual(poolOf(node).map((s) => [s.ch.id, s.spareSats, s.peer?.spareSats]), [[A, 1_750_000, 3_500_000], [B, 1_750_000, 3_500_000]]);
  const plan = await planOf(node, probeAt(150));
  assert.deepEqual([row(plan, C).selectedSourceChannel, row(plan, C).recommendedAmount], [A, 1_250_000]);
  assert.deepEqual([row(plan, D).selectedSourceChannel, row(plan, D).recommendedAmount], [B, 1_250_000]);
  assert.match(row(plan, D).sourceCandidates[0].reason, /above its 55% share, not draining$/);
});

// ───────────────────────────── the executor ─────────────────────────────

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const TARGET = "850000x1x0";
/** The target's peer's other channel with us. */
const SIBLING = "850000x2x0";
const SOURCE = "850000x3x0";

const ch = (id: string, n: number, peer: number, o: Partial<FeeChannel> = {}): FeeChannel => ({
  id,
  partnerPublicKey: PEER(peer),
  capacity: 5_000_000,
  localBalance: 2_500_000,
  transactionId: TX(n),
  transactionVout: 0,
  feeRatePpm: 100,
  baseFeeMsat: 0,
  ...o,
});

/** Peer 1 with two drained channels (400 and 300 ppm) and a full channel of
 *  peer 3. A payment a test leaves hanging fails when the test ends. */
function twoChannelPeer(t: AfterHook, sibling: Partial<FeeChannel> = {}, more: FeeChannel[] = []) {
  const node = feeNode({
    channels: [
      ch(TARGET, 1, 1, { localBalance: 750_000, feeRatePpm: 400, totalSent: 3_333_333 }),
      ch(SIBLING, 2, 1, { localBalance: 600_000, feeRatePpm: 300, totalSent: 1_111_111, ...sibling }),
      ch(SOURCE, 3, 3, { localBalance: 4_000_000 }),
      ...more,
    ],
  });
  t.after(() => {
    for (const p of node.payments.values()) if (p.status === "IN_FLIGHT") node.resolvePayment(p.id, "fail");
  });
  return node;
}
const siblingBefore: PeerChannelBefore = { id: SIBLING, sentBefore: 1_111_111, ppm: 300 };

test("the executor refuses a source that is a channel of the target's own peer: no invoice, no route question, no payment (before: paid — out to the peer and straight back)", async (t) => {
  const node = twoChannelPeer(t, { localBalance: 4_000_000 });
  const res = await executeRebalance(node.lnd, node.lnd, { targetId: TARGET, sourceId: SIBLING, amountSats: 400_000, econRatio: 0.8 });
  assert.equal(res.ok, false);
  assert.equal(res.error, SAME_PEER_SOURCE);
  assert.deepEqual(res.failedSourceIds, [], "no attempt, so no back-off of the pair");
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0);
  assert.equal(node.callsTo("default.addInvoice").length, 0);
});

test("listed among other sources it is passed over and the next one pays", async (t) => {
  const node = twoChannelPeer(t, { localBalance: 4_000_000 });
  const res = await executeRebalance(node.lnd, node.lnd, {
    targetId: TARGET,
    sourceId: SIBLING,
    sources: [{ id: SIBLING }, { id: SOURCE, keepRatio: 0.55 }],
    amountSats: 400_000,
    econRatio: 0.8,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.sourceId, SOURCE);
  assert.deepEqual(res.failedSourceIds, []);
  const sent = node.callsTo("router.sendPaymentV2");
  assert.equal(sent.length, 1);
});

test("a paid refill says which channel it arrived on when that is the peer's other one — with that channel's 'sent' counter and fee from before", async (t) => {
  const node = twoChannelPeer(t);
  node.payArrivesOn = SIBLING;
  const landed = await executeRebalance(node.lnd, node.lnd, { targetId: TARGET, sourceId: SOURCE, amountSats: 400_000, econRatio: 0.8 });
  assert.equal(landed.ok, true, landed.error);
  assert.deepEqual(landed.peerChannels, [siblingBefore]);
  assert.deepEqual(landed.landed, siblingBefore);
  assert.equal(landed.targetId, TARGET, "the result stays the planned target's");
  assert.equal(landed.targetSentBefore, 3_333_333);
  // Arrived on the target, or LND names a channel that is neither: nothing to say.
  node.payArrivesOn = TARGET;
  const onTarget = await executeRebalance(node.lnd, node.lnd, { targetId: TARGET, sourceId: SOURCE, amountSats: 400_000, econRatio: 0.8 });
  assert.equal(onTarget.ok, true, onTarget.error);
  assert.equal(onTarget.landed, undefined);
  assert.deepEqual(onTarget.peerChannels, [siblingBefore]);
  node.payArrivesOn = undefined;
  const elsewhere = await executeRebalance(node.lnd, node.lnd, { targetId: TARGET, sourceId: SOURCE, amountSats: 400_000, econRatio: 0.8 });
  assert.equal(elsewhere.ok, true, elsewhere.error);
  assert.equal(elsewhere.landed, undefined);
  // A peer with one channel: the result carries no list.
  const single = await executeRebalance(node.lnd, node.lnd, { targetId: SOURCE, sourceId: SIBLING, amountSats: 100_000, econRatio: 0.8, maxFeePpm: 50 });
  assert.equal(single.peerChannels, undefined);
});

test("where a refill arrived: the channel most of it came in on — the target on a tie, and when LND names no channel of the peer", () => {
  const path = (channel: string | undefined, sats: number) => ({ hops: [{ channel: "700000x1x0", forward: sats }, { channel, forward: sats }], tokens: sats });
  const others = [siblingBefore, { id: "850000x9x0", sentBefore: 5 }];
  assert.equal(landedOn([path(TARGET, 400_000)], TARGET, others), null);
  assert.deepEqual(landedOn([path(SIBLING, 400_000)], TARGET, others), siblingBefore);
  assert.deepEqual(landedOn([path(SIBLING, 250_000), path(TARGET, 150_000)], TARGET, others), siblingBefore);
  assert.equal(landedOn([path(SIBLING, 150_000), path(TARGET, 250_000)], TARGET, others), null);
  assert.equal(landedOn([path(SIBLING, 200_000), path(TARGET, 200_000)], TARGET, others), null);
  assert.deepEqual(landedOn([path(SIBLING, 100_000), path("850000x9x0", 200_000), path(TARGET, 150_000)], TARGET, others), { id: "850000x9x0", sentBefore: 5 });
  assert.equal(landedOn([path("123x1x0", 400_000)], TARGET, others), null);
  assert.equal(landedOn([path(undefined, 400_000)], TARGET, others), null);
  assert.equal(landedOn([{ hops: [] }, {}], TARGET, others), null);
  assert.equal(landedOn(undefined, TARGET, others), null);
  assert.equal(landedOn([path(SIBLING, 400_000)], TARGET, []), null, "a peer with one channel");
  // A path without amounts still counts as one.
  assert.deepEqual(landedOn([{ hops: [{ channel: SIBLING }] }], TARGET, others), siblingBefore);
});

// ───────────────────────────── the books ─────────────────────────────

/** The planner's move into `target` (only what the rebalance stage reads):
 *  400k from SOURCE, valued at 400 ppm. */
const refill = (target: string, peerChannels?: string[]) =>
  ({
    channelId: target,
    alias: `peer-${target}`,
    state: "route_found_profitable",
    wouldRebalance: true,
    recommendedAmount: 400_000,
    selectedSourceChannel: SOURCE,
    sourceCandidates: [{ channelId: SOURCE, alias: `src-${SOURCE}`, localRatio: 0.8, spareSats: 1_250_000, keepRatio: 0.55, reason: "" }],
    estimatedRouteFeeSats: 20,
    expectedNetProfitSats: 300,
    maxCostPpm: 320,
    maxCostSatsByPayback: 1_000,
    expectedRevenuePpm: 400,
    earningDemandSats: 1_200_000,
    minNetProfitSats: 100,
    ...(peerChannels ? { peerChannels } : {}),
  }) as unknown as RebalanceRecommendation;

const cooldowns = (autopilot: unknown) => (autopilot as { state: { perTargetLastRebalanced?: Record<string, string> } }).state.perTargetLastRebalanced ?? {};

test("a refill that arrived on the peer's other channel is booked there: the log record, its 'sent' counter and the hold are that channel's — the hold no higher than its fee — and the channel it was planned for is kept beside it", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = twoChannelPeer(t);
  node.payArrivesOn = SIBLING;
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET, [SIBLING])] });
  const run = await autopilot.runOnce();
  assert.equal(run.rebalances[0]?.ok, true, run.rebalances[0]?.error);
  const log = new RebalanceLog(dir);
  const [rec, ...more] = log.recent();
  assert.deepEqual(more, []);
  // Before: targetId TARGET, targetSentBefore 3,333,333, hold 400 — on a channel the sats never reached.
  assert.deepEqual([rec?.ok, rec?.targetId, rec?.plannedTargetId, rec?.targetSentBefore, rec?.holdPpm, rec?.amountSats], [true, SIBLING, TARGET, 1_111_111, 300, 400_000]);
  // The stale-plan check of a manual run finds it from either channel.
  assert.equal(log.lastInto(SIBLING), rec?.at);
  assert.equal(log.lastInto(TARGET), rec?.at);
  assert.equal(log.lastInto(SOURCE), null);

  // The planned channel is still drained, and the next plan lists a refill of
  // it or of its sibling: neither is sent within the cooldown.
  assert.ok(cooldowns(autopilot)[TARGET], "the cooldown is the planned target's");
  for (const next of [refill(SIBLING, [TARGET]), refill(TARGET, [SIBLING])]) {
    seams.rebalanceReport = async () => ({ recommendations: [next] });
    await autopilot.runOnce();
  }
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "no second refill toward the peer");
  seams.rebalanceReport = async () => ({ recommendations: [refill(SIBLING, [TARGET])] });
  await autopilot.runOnce();
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", new RegExp(`peer-${SIBLING}: its peer's other channel was refilled or tried within its cooldown`));
});

test("a refill that arrived on the channel it was planned for is booked as before", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = twoChannelPeer(t);
  node.payArrivesOn = TARGET;
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET, [SIBLING])] });
  await autopilot.runOnce();
  const [rec] = new RebalanceLog(dir).recent();
  assert.deepEqual([rec?.ok, rec?.targetId, rec?.plannedTargetId, rec?.targetSentBefore, rec?.holdPpm], [true, TARGET, undefined, 3_333_333, 400]);
});

test("one run sends one refill toward a peer, whatever the plan lists: the second channel's waits out the first's cooldown", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const second = "850000x5x0";
  const node = twoChannelPeer(t, {}, [ch(second, 5, 5, { localBalance: 4_000_000 })]);
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000, maxRebalancesPerRun: 3 }, {}, {}, node);
  const other = { ...refill(SIBLING, [TARGET]), selectedSourceChannel: second, sourceCandidates: [{ channelId: second, alias: "src", localRatio: 0.8, spareSats: 1_250_000, keepRatio: 0.55, reason: "" }] };
  seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET, [SIBLING]), other as RebalanceRecommendation] });
  const run = await autopilot.runOnce();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1);
  assert.deepEqual(run.rebalances.map((r) => [r.alias.slice(0, 12), r.ok]), [[PEER(1).slice(0, 12), true]]);
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", new RegExp(`peer-${SIBLING}: its peer's other channel was refilled or tried within its cooldown`));
});

/** Until LND holds one payment in flight — and its id. */
async function inFlightAtLnd(node: ReturnType<typeof feeNode>, what: string): Promise<string> {
  const ids = () => [...node.payments.values()].filter((p) => p.status === "IN_FLIGHT").map((p) => p.id);
  await until(() => ids().length === 1, what);
  return ids()[0];
}

test("while a refill toward a peer is in flight none goes into its other channel, and when it lands there — learned after a restart — it is booked there, with that channel's counter and a hold no higher than its fee", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = twoChannelPeer(t);
  node.payOutcome = "hang";
  const one = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  one.seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET, [SIBLING])] });
  const first = one.autopilot.runOnce();
  const id = await inFlightAtLnd(node, "the refill's payment is in flight");
  // The process stops; the next one has what is on disk.
  const disk = makeTempDir(t);
  cpSync(one.dir, disk, { recursive: true });
  const two = autopilotAt(t, disk, node);
  node.payOutcome = (p) => (p.id === id ? "hang" : "succeed");
  two.seams.rebalanceReport = async () => ({ recommendations: [refill(SIBLING, [TARGET])] });
  await two.autopilot.runOnce();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "nothing sent into the sibling meanwhile");
  assert.match(two.autopilot.getState().decisions.rebalance?.text ?? "", new RegExp(`peer-${SIBLING}: a payment into its peer's other channel is still in flight`));

  // It lands — on the sibling.
  node.payArrivesOn = SIBLING;
  node.resolvePayment(id, "succeed");
  await two.autopilot.checkInFlightRebalances();
  const [rec, ...more] = new RebalanceLog(disk).recent();
  assert.deepEqual(more, []);
  assert.deepEqual([rec?.ok, rec?.targetId, rec?.plannedTargetId, rec?.targetSentBefore, rec?.holdPpm, rec?.paymentId], [true, SIBLING, TARGET, 1_111_111, 300, id]);
  await first;
});
