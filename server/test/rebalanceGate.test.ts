/**
 * The refill's payment is capped by the profit gate itself, and the gate
 * values the refilled sats at the fee the fee engine charges AFTER the refill
 * (review a2, package P3).
 *
 * Before: the probe passed a move only if its estimated cost left at least
 * 100 sat of expected net, but the payment was capped at amount × the gate's
 * ppm alone — a 750k refill expected to earn 200 sat could pay 240 and lose
 * money "within budget" (at the halved fallback sizes too). And the gate
 * valued the refilled sats at the drained channel's fee while the fee engine
 * cut that fee at its next update: "+167 sat expected" netted about +35.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MULTI_PATH_MAX_PATHS,
  executeRebalance,
  feeCapAt,
} from "../src/services/rebalance.js";
import {
  FEE_REC_DEFAULTS,
  buildRecommendation,
  feeAfterRefill,
  type BuildCtx,
  type FeeRecConfig,
  type Flow,
} from "../src/services/feeRecommend.js";
import { REBAL_REC_DEFAULTS, planRebalances, type RebalanceRecommendation, type RouteProbe } from "../src/services/rebalanceRecommend.js";
import { RebalanceLog, type RebalanceRecord } from "../src/services/rebalanceLog.js";
import type { ChannelView } from "../src/services/channels.js";
import { chanNumber, feeNode, forwardsOut, withMarket, type FakeForward, type FeeChannel } from "./helpers/feeNode.js";
import { INVOICE_FEATURE } from "./helpers/fakeLnd.js";
import { autopilotWith } from "./helpers/autopilot.js";

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const HEIGHT = 860_000;
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 86_400_000;
/** What the tests read of the fee stage's report. */
interface FeeRecommendationView {
  channelId: string;
  targetPpm: number;
  aimPpm: number;
  reasons: string[];
  metrics: { profitFloorPpm: number | null };
}

// ── the payment's cap is the gate's ───────────────────────────────────────────

test("the gate's fee cap at a size: min(amount × max ppm, payback cap, what it earns − the minimum net) — the verifier's 750k refill earning 200 sat may pay 100, not 240", () => {
  const gate = { maxCostPpm: 320, maxFeeSats: 10_000, earnings: { revenuePpm: 400, demandSats: 500_000, minNetSats: 100 } };
  // 750k at 400 ppm, earnings capped at the 500k of 14-day outflow: 200 sat.
  assert.equal(feeCapAt(gate, 750_000), 100);
  // Halved: 375k earns 150 → 50; quartered: 187.5k earns 75 → nothing.
  assert.equal(feeCapAt(gate, 375_000), 50);
  assert.equal(feeCapAt(gate, 187_500), 0);
  // The payback cap and the budget left bind too.
  assert.equal(feeCapAt({ ...gate, maxFeeSats: 30 }, 750_000), 30);
  // Without the earnings side it is the ppm cap alone (what the payment had).
  assert.equal(feeCapAt({ maxCostPpm: 320 }, 750_000), 240);
});

/** A drained 3M target at 400 ppm and a full 3M source, on a fake LND. */
function refillNode() {
  return feeNode({
    blockHeight: HEIGHT,
    channels: [
      { id: "850000x1x0", partnerPublicKey: PEER(1), capacity: 3_000_000, localBalance: 450_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 400, baseFeeMsat: 0 },
      { id: "850000x2x0", partnerPublicKey: PEER(2), capacity: 3_000_000, localBalance: 2_700_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
      { id: "850000x3x0", partnerPublicKey: PEER(3), capacity: 3_000_000, localBalance: 1_800_000, transactionId: TX(3), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
    ],
  });
}
const sentPayments = (node: ReturnType<typeof refillNode>) =>
  node.callsTo("router.sendPaymentV2").map((a) => ({
    sats: Number(a.amt),
    maxFee: Number(a.fee_limit_sat),
    parts: Number(a.max_parts),
    out: String(a.outgoing_chan_id),
  }));

test("every attempt of a refill — the halved fallbacks too — carries the gate's own cap as its max fee; a size the gate leaves no fee for is not sent", async () => {
  const node = refillNode();
  node.payOutcome = "fail"; // no route: every size is tried
  const res = await executeRebalance(node.lnd, node.lnd, {
    targetId: "850000x1x0",
    sourceId: "850000x2x0",
    amountSats: 750_000,
    econRatio: 0.8,
    maxFeePpm: 320,
    gate: { revenuePpm: 400, demandSats: 500_000, minNetSats: 100 },
  });
  assert.equal(res.ok, false);
  // Before: 240, 120 and 60 sat — the worst case lost 40 sat at full size.
  assert.deepEqual(
    sentPayments(node).map((p) => [p.sats, p.maxFee]),
    [
      [750_000, 100],
      [375_000, 50],
    ],
  );
  assert.deepEqual(res.failedSourceIds, ["850000x2x0"]);
});

test("a refill's fee never exceeds what is left of the daily budget (maxFeeSats), whatever the gate would allow", async () => {
  const node = refillNode();
  node.payOutcome = "fail";
  await executeRebalance(node.lnd, node.lnd, {
    targetId: "850000x1x0",
    sourceId: "850000x2x0",
    amountSats: 750_000,
    econRatio: 0.8,
    maxFeePpm: 320,
    maxFeeSats: 35,
    gate: { revenuePpm: 400, demandSats: 500_000, minNetSats: 100 },
  });
  assert.deepEqual(sentPayments(node).map((p) => p.maxFee), [35, 35]);
});

test("a refill of 500k or more may split over several paths (MPP) — and carries the invoice's feature bits, without which LND never splits; a smaller one stays single-path", async () => {
  const node = refillNode();
  node.payOutcome = "fail";
  await executeRebalance(node.lnd, node.lnd, { targetId: "850000x1x0", sourceId: "850000x2x0", amountSats: 1_000_000, econRatio: 0.8, maxFeePpm: 320 });
  assert.deepEqual(
    sentPayments(node).map((p) => [p.sats, p.parts]),
    [
      [1_000_000, MULTI_PATH_MAX_PATHS],
      [500_000, MULTI_PATH_MAX_PATHS],
      [250_000, 1],
    ],
  );
  // Before: no features — ln-service sent no dest_features, and LND's payment
  // session doesn't split for a destination without them ("DestFeatures is
  // nil"): max_parts 3 changed nothing. The self-invoice declares MPP.
  for (const call of node.callsTo("router.sendPaymentV2")) {
    const features = (call.dest_features ?? []) as number[];
    assert.ok(features.includes(INVOICE_FEATURE.multiPathOptional), `dest_features ${JSON.stringify(call.dest_features)}`);
    assert.ok(features.includes(INVOICE_FEATURE.paymentAddrRequired));
  }
});

test("a refill records the target's lifetime 'sent' counter from LND — what the fee engine retires the refilled sats against", async () => {
  const node = refillNode();
  node.channels[0].totalSent = 7_777_777;
  const res = await executeRebalance(node.lnd, node.lnd, { targetId: "850000x1x0", sourceId: "850000x2x0", amountSats: 400_000, econRatio: 0.8, maxFeePpm: 320 });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.targetSentBefore, 7_777_777);
});

test("no route from the first source: the next source is tried before giving up — and a move never takes a source below the share it keeps", async () => {
  const node = refillNode();
  const first = chanNumber("850000x2x0");
  node.payOutcome = (p) => (String(p.params.outgoing_chan_id) === first ? "fail" : "succeed");
  const res = await executeRebalance(node.lnd, node.lnd, {
    targetId: "850000x1x0",
    sourceId: "850000x2x0",
    sources: [
      { id: "850000x2x0", keepRatio: 0.55 },
      // 1.8M of 3M local, keeping 55%: 150k to spare.
      { id: "850000x3x0", keepRatio: 0.55 },
    ],
    amountSats: 750_000,
    econRatio: 0.8,
    maxFeePpm: 320,
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.sourceId, "850000x3x0");
  assert.deepEqual(res.failedSourceIds, ["850000x2x0"]);
  assert.equal(res.amountSats, 150_000, "capped at the second source's spare balance");
  const sent = sentPayments(node);
  assert.deepEqual(
    sent.map((p) => [p.out === first ? "first" : "second", p.sats]),
    [
      ["first", 750_000],
      ["first", 375_000],
      ["first", 187_500],
      ["second", 150_000],
    ],
  );
});

test("a source that was never tried — too little to spare, or no fee room at any size it can give — is not reported as failed: its pair doesn't back off, and the next source pays", async (t) => {
  // A drained target, a source with nothing to spare above the share it
  // keeps, one whose 150k spare earns too little for any fee (the gate), and
  // a full one.
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [
      { id: "850000x1x0", partnerPublicKey: PEER(1), capacity: 3_000_000, localBalance: 450_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 400, baseFeeMsat: 0 },
      { id: "850000x2x0", partnerPublicKey: PEER(2), capacity: 3_000_000, localBalance: 2_700_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
      { id: "850000x3x0", partnerPublicKey: PEER(3), capacity: 3_000_000, localBalance: 1_800_000, transactionId: TX(3), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
      { id: "850000x4x0", partnerPublicKey: PEER(4), capacity: 3_000_000, localBalance: 1_800_000, transactionId: TX(4), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
    ],
  });
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 }, {}, {}, node);
  const cand = (channelId: string, keepRatio: number) => ({ channelId, alias: channelId, localRatio: 0.6, spareSats: 150_000, keepRatio, reason: "" });
  seams.rebalanceReport = async () => ({
    recommendations: [
      {
        channelId: "850000x1x0",
        alias: "router",
        wouldRebalance: true,
        recommendedAmount: 750_000,
        selectedSourceChannel: "850000x4x0",
        sourceCandidates: [
          cand("850000x4x0", 0.6), // 1.8M of 3M, keeping 60 %: nothing to spare
          cand("850000x3x0", 0.55), // keeping 55 %: 150k, which earns 60 sat < the 100 sat minimum
          cand("850000x2x0", 0.55), // 1.05M to spare
        ],
        estimatedRouteFeeSats: 20,
        expectedNetProfitSats: 100,
        maxCostPpm: 320,
        maxCostSatsByPayback: 1_000,
        expectedRevenuePpm: 400,
        earningDemandSats: 500_000,
        minNetProfitSats: 100,
      } as unknown as RebalanceRecommendation,
    ],
  });
  const run = await autopilot.runOnce();
  assert.equal(run.rebalances[0]?.ok, true, run.rebalances[0]?.error);
  assert.deepEqual(
    sentPayments(node).map((p) => [p.out, p.sats]),
    [[chanNumber("850000x2x0"), 750_000]],
    "nothing was sent from the first two",
  );
  // Before: every source the loop passed was reported as failed — a source
  // that was never tried backed its pair off for hours.
  const state = (autopilot as unknown as { state: { perPairRebalanceFails?: Record<string, unknown> } }).state;
  assert.deepEqual(state.perPairRebalanceFails ?? {}, {});
});

test("an executor told the process is shutting down sends nothing more: a skip, not a failure — no source reported as failed", async () => {
  const node = refillNode();
  const res = await executeRebalance(
    node.lnd,
    node.lnd,
    { targetId: "850000x1x0", sourceId: "850000x2x0", sources: [{ id: "850000x2x0" }, { id: "850000x3x0" }], amountSats: 750_000, econRatio: 0.8, maxFeePpm: 320 },
    { shouldStop: () => true },
  );
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0);
  assert.deepEqual([res.ok, res.stopped, res.failedSourceIds], [false, true, []]);
  assert.match(res.error ?? "", /^skipped: shutting down/);
});

// ── after the refill: the engine keeps what the gate valued it at ─────────────

const flow = (out: number, inn: number, forwards: number, revenue: number): Flow => ({ out, inn, forwards, revenue });
const cfg: FeeRecConfig = { ...FEE_REC_DEFAULTS, stepPpm: 10, minChangePpm: 25 };

/** The verifier's case: a 5M router channel at 15 % local earning 400 ppm,
 *  draining (1.2M out / 0.2M in over 14 days), a market reference into its
 *  peer (a refill costs ~150 ppm there). */
const drained5M = (o: Partial<ChannelView> = {}): ChannelView => ({
  id: "850000x1x0",
  peerPubkey: PEER(1),
  peerAlias: "router",
  active: true,
  private: false,
  initiator: "local",
  capacity: 5_000_000,
  transactionId: TX(1),
  transactionVout: 0,
  localBalance: 750_000,
  remoteBalance: 4_250_000,
  localRatio: 0.15,
  totalSent: 10_000_000,
  totalReceived: 0,
  unsettled: 0,
  status: "open",
  role: "router",
  ...o,
});
const ctxOf = (o: Partial<BuildCtx> = {}): BuildCtx => ({
  cfg,
  rate: { fee_rate: 400, base_fee_mtokens: "0", transaction_id: TX(1), transaction_vout: 0 },
  override: undefined,
  f14: flow(1_200_000, 200_000, 20, 480),
  f30: flow(2_400_000, 400_000, 40, 960),
  currentBlock: HEIGHT,
  records: [],
  bench: { activeChannelCount: 1, topGrossFlow14d: 0, medianGrossFlow14d: 0, topRevenue30d: 0, medianRevenue30d: 0, topRevenuePpm30d: 0, medianRevenuePpm30d: 0 },
  enoughChannels: false,
  earnerCutoff: 0,
  cooldown: null,
  elasticityMod: 1,
  flowAnchor: undefined,
  leaseCap: null,
  demand: undefined,
  market: { intoPeerPpm: 100, samples: 5, peerFeeToUsPpm: 50 },
  nowMs: NOW,
  ...o,
});
/** The refill as the autopilot books it. */
const refillRecord = (o: Partial<RebalanceRecord> = {}): RebalanceRecord => ({
  at: new Date(NOW - 3_600_000).toISOString(),
  via: "autopilot",
  targetId: "850000x1x0",
  targetAlias: "router",
  sourceId: "850000x2x0",
  sourceAlias: "src",
  amountSats: 1_250_000,
  budgetPpm: 320,
  feeSats: 313, // 250 ppm
  costPpm: 250,
  ok: true,
  targetSentBefore: 10_000_000,
  holdPpm: 400,
  ...o,
});
/** The channel after a 1.25M refill: 40 % local. */
const refilled = (o: Partial<ChannelView> = {}) => drained5M({ localBalance: 2_000_000, remoteBalance: 3_000_000, localRatio: 0.4, ...o });

test("after a refill the fee engine keeps the fee the gate valued it at — the verifier's 400 ppm channel was cut toward ~290 ppm at its next update", () => {
  const after = buildRecommendation(refilled(), ctxOf({ records: [refillRecord()] }));
  // Before: the floor was the refill's cost × 1.15 = 288 ppm, and the curve
  // at 40 % local lowered the fee 400 → 370 on the way to ~290.
  assert.ok(after.targetPpm >= 400 && after.aimPpm >= 400, `${after.targetPpm} (aim ${after.aimPpm}) | ${after.reasons.join(" | ")}`);
  assert.equal(after.metrics.profitFloorPpm, 400);
  assert.equal(after.metrics.refillHoldPpm, 400);
  assert.equal(after.metrics.refillRemainingSats, 1_250_000);
  assert.ok(
    after.reasons.some((x) => /^profit floor: a refill today \(2026-10-21\) was worth paying for at 400 ppm \(it cost 250 ppm\) = 400 ppm; 1\.25M of its 1\.25M still here/.test(x)),
    after.reasons.join(" | "),
  );
});

test("the hold ends as the refilled sats route out (first in, first out on LND's sent counter) — and after 30 days at the latest", () => {
  // 1M of the 1.25M routed out since: 250k still here — still held.
  const partly = buildRecommendation(refilled({ totalSent: 11_000_000 }), ctxOf({ records: [refillRecord()] }));
  assert.equal(partly.metrics.refillRemainingSats, 250_000);
  assert.equal(partly.metrics.profitFloorPpm, 400);
  // All of it routed out: nothing of the refill is left to price — no floor.
  const gone = buildRecommendation(refilled({ totalSent: 11_250_000 }), ctxOf({ records: [refillRecord()] }));
  assert.equal(gone.metrics.profitFloorPpm, null);
  assert.ok(gone.targetPpm < 400, `lowered again: ${gone.targetPpm}`);
  // A month old and still not routed out: no floor either.
  const old = buildRecommendation(refilled(), ctxOf({ records: [refillRecord({ at: new Date(NOW - 31 * DAY).toISOString() })] }));
  assert.equal(old.metrics.profitFloorPpm, null);
});

/** A full, idle 5M source next to the target (69 days old, earns nothing). */
const source = (): ChannelView => ({
  ...drained5M({ id: "850000x2x0", peerPubkey: PEER(2), peerAlias: "src", transactionId: TX(2) }),
  // 4.5M of 5M local, keeping 55 %: 1.75M to spare.
  localBalance: 4_500_000,
  remoteBalance: 500_000,
  localRatio: 0.9,
});
const sourceCtx = () =>
  ctxOf({ rate: { fee_rate: 100, base_fee_mtokens: "0", transaction_id: TX(2), transaction_vout: 0 }, f14: flow(0, 0, 0, 0), f30: flow(0, 50_000, 1, 0), market: undefined });

/** planRebalances over these channels, with routes at `routePpm`. */
async function plan(target: ChannelView, targetCtx: BuildCtx, routePpm: number) {
  const contexts = new Map<string, BuildCtx>([
    [target.id, targetCtx],
    ["850000x2x0", sourceCtx()],
  ]);
  const channels = [target, source()];
  const probe: RouteProbe = async (_s, _t, amount) => ({ costPpm: routePpm, feeSats: Math.round((amount * routePpm) / 1_000_000) });
  return planRebalances(
    {
      channels,
      fees: channels.map((c) => buildRecommendation(c, contexts.get(c.id) as BuildCtx)),
      contextOf: (id) => contexts.get(id),
      cfg: REBAL_REC_DEFAULTS,
      overrides: {},
      soldLeases: [],
      currentBlock: HEIGHT,
    },
    probe,
  );
}

test("the gate values the moved sats at the fee the engine charges after the refill — and booked as the autopilot books it, the engine keeps exactly that", async () => {
  const { recommendations } = await plan(drained5M(), ctxOf(), 250);
  const rec = recommendations.find((r) => r.channelId === "850000x1x0")!;
  assert.equal(rec.state, "route_found_profitable", rec.reasons.join(" | "));
  assert.equal(rec.recommendedAmount, 1_250_000);
  assert.equal(rec.expectedRevenuePpm, 400);
  assert.equal(rec.postRefillPpm, feeAfterRefill(drained5M(), ctxOf(), { amountSats: 1_250_000, feeSats: 313, holdPpm: 400 }).aimPpm);
  assert.ok(rec.reasons.some((x) => /after the refill the fee engine keeps it at ≥ 400 ppm until the refilled sats have routed out/.test(x)), rec.reasons.join(" | "));
  // The payment's cap is the gate's: 1.2M of outflow × 400 ppm = 480 sat
  // earned, minus the 100 sat minimum.
  assert.equal(rec.maxFeeSats, 380);
  assert.equal(rec.expectedNetProfitSats, 480 - 313);
  // Book it with the hold the gate valued it at: the engine's next update
  // keeps the fee there.
  const next = buildRecommendation(refilled(), ctxOf({ records: [refillRecord({ holdPpm: rec.expectedRevenuePpm as number })] }));
  assert.ok(next.aimPpm >= (rec.expectedRevenuePpm as number) && next.targetPpm >= (rec.expectedRevenuePpm as number), next.reasons.join(" | "));
});

test("a refill's hold never overrides the operator or a lease promise: a pin set later, an exclusion and a sold channel's cap still win", () => {
  const lot = { records: [refillRecord()] };
  const pinned = buildRecommendation(refilled(), ctxOf({ ...lot, override: { mode: "fixed", fixedPpm: 200 } }));
  assert.equal(pinned.targetPpm, 200);
  const excluded = buildRecommendation(refilled(), ctxOf({ ...lot, rate: { fee_rate: 150, base_fee_mtokens: "0", transaction_id: TX(1), transaction_vout: 0 }, override: { mode: "exclude" } }));
  assert.equal(excluded.targetPpm, 150, "an excluded channel's fee is not touched, hold or not");
  const sold = buildRecommendation(
    refilled(),
    ctxOf({
      ...lot,
      leaseCap: { fundingOutpoint: `${TX(1)}:0`, source: "magma", orderId: "o-1", feeRateCapPpm: 300, baseFeeCapMsat: 1000, leaseBlocks: 4320, untilHeight: HEIGHT + 1000 },
    }),
  );
  assert.ok(sold.targetPpm <= 300 && sold.aimPpm <= 300, `${sold.targetPpm} / ${sold.aimPpm}`);
});

test("the row shows where the fee engine takes the fee after the refill — here up toward what refilling costs on the market — and values the moved sats at no more than the gate's estimate", async () => {
  // Others charge 300 into the peer and it charges 100 back: a refill costs
  // ~400 ppm on the market, × 1.15 = 460 after the refill (draining).
  const pricey = ctxOf({ market: { intoPeerPpm: 300, samples: 5, peerFeeToUsPpm: 100 } });
  const { recommendations } = await plan(drained5M(), pricey, 250);
  const rec = recommendations.find((r) => r.channelId === "850000x1x0")!;
  assert.equal(rec.postRefillPpm, 460, rec.reasons.join(" | "));
  assert.equal(rec.expectedRevenuePpm, 400, "valued at the lower of the two");
  assert.equal(rec.postRefillPpm, feeAfterRefill(drained5M(), pricey, { amountSats: 1_250_000, feeSats: 313, holdPpm: 400 }).aimPpm);
});

test("where the engine charges less after the refill than the estimate before it (a pin at 300 ppm), the row says so — and the moved sats are valued at that", async () => {
  // The estimate from this run's fees: 400 ppm. The engine's context for
  // the target carries a pin at 300 ppm: after the refill it charges that.
  const contexts = new Map<string, BuildCtx>([
    ["850000x1x0", ctxOf({ override: { mode: "fixed", fixedPpm: 300 } })],
    ["850000x2x0", sourceCtx()],
  ]);
  const channels = [drained5M(), source()];
  const probe: RouteProbe = async (_s, _t, amount) => ({ costPpm: 100, feeSats: Math.round((amount * 100) / 1_000_000) });
  const { recommendations } = await planRebalances(
    {
      channels,
      fees: [buildRecommendation(drained5M(), ctxOf()), buildRecommendation(source(), sourceCtx())],
      contextOf: (id) => contexts.get(id),
      cfg: REBAL_REC_DEFAULTS,
      overrides: {},
      soldLeases: [],
      currentBlock: HEIGHT,
    },
    probe,
  );
  const rec = recommendations.find((r) => r.channelId === "850000x1x0")!;
  assert.deepEqual([rec.preRefillPpm, rec.postRefillPpm, rec.expectedRevenuePpm], [400, 300, 300]);
  assert.equal(rec.state, "route_found_profitable", rec.reasons.join(" | "));
  // Before: compared with the value already lowered to 300, so the row read
  // "keeps it at ≥ 300 ppm until the refilled sats have routed out".
  assert.ok(rec.reasons.some((x) => /after the refill the fee engine takes it to ~300 ppm — the moved sats are valued at that$/.test(x)), rec.reasons.join(" | "));
  assert.ok(!rec.reasons.some((x) => /keeps it at ≥/.test(x)), rec.reasons.join(" | "));
});

test("a free route (0 ppm) on a move that earns less than the minimum net is not 'profitable': the payment's cap would leave it no fee room — the executor would refuse it, a failed run", async () => {
  // 200k routed out in 14 days at 400 ppm: the 300k refill earns at most
  // 80 sat — below the 100 sat minimum, whatever its route costs.
  const thin = ctxOf({ f14: flow(200_000, 0, 10, 80), f30: flow(400_000, 0, 20, 160) });
  const { recommendations } = await plan(drained5M(), thin, 0);
  const rec = recommendations.find((r) => r.channelId === "850000x1x0")!;
  assert.deepEqual([rec.estimatedRouteFeeSats, rec.maxFeeSats], [0, 0], rec.reasons.join(" | "));
  assert.deepEqual([rec.wouldRebalance, rec.state], [false, "unprofitable_skip"], rec.reasons.join(" | "));
  assert.ok(rec.reasons.some((x) => /^best net profit \d+ sat is below the 100 sat minimum/.test(x)), rec.reasons.join(" | "));
});

/** A drained 5M target at 400 ppm (LND's sent counter at 3,333,333) and a
 *  full 5M source, on a fake LND (with `forwards` as its history). */
const holdChannels = (): FeeChannel[] => [
  { id: "850000x1x0", partnerPublicKey: PEER(1), capacity: 5_000_000, localBalance: 750_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 400, baseFeeMsat: 0, totalSent: 3_333_333 },
  { id: "850000x2x0", partnerPublicKey: PEER(2), capacity: 5_000_000, localBalance: 4_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
];
const holdNode = (channels = holdChannels(), forwards: FakeForward[] = []) => feeNode({ blockHeight: HEIGHT, channels, forwards });

/** The profit floor the autopilot's own fee stage puts on the target. */
async function floorOf(autopilot: object): Promise<number | null | undefined> {
  const seam = autopilot as { feeReport(e: Map<string, number>): Promise<{ recommendations: { channelId: string; metrics: { profitFloorPpm: number | null } }[] }> };
  return (await seam.feeReport(new Map())).recommendations.find((r) => r.channelId === "850000x1x0")?.metrics.profitFloorPpm;
}

test("end to end: an autopilot refill through the real executor is booked with the gate's value and the target's LND sent counter — the engine holds that price while the sats are there, and lets go once they have routed out", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = holdNode();
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 }, {}, {}, node);
  // Only the plan is stubbed: the executor is the real one.
  seams.rebalanceReport = async () => ({
    recommendations: [
      {
        channelId: "850000x1x0",
        alias: "router",
        wouldRebalance: true,
        recommendedAmount: 400_000,
        selectedSourceChannel: "850000x2x0",
        sourceCandidates: [{ channelId: "850000x2x0", alias: "src", localRatio: 0.8, spareSats: 1_250_000, keepRatio: 0.55, reason: "" }],
        estimatedRouteFeeSats: 20,
        expectedNetProfitSats: 300,
        maxCostPpm: 320,
        maxCostSatsByPayback: 1_000,
        expectedRevenuePpm: 400,
        earningDemandSats: 1_200_000,
        minNetProfitSats: 100,
      } as unknown as RebalanceRecommendation,
    ],
  });
  await autopilot.runOnce();
  const [rec] = new RebalanceLog(dir).successes();
  assert.deepEqual([rec?.via, rec?.holdPpm, rec?.targetSentBefore, rec?.amountSats], ["autopilot", 400, 3_333_333, 400_000]);
  // The fee stage's own report holds the refill's price while its sats are here …
  assert.equal(await floorOf(autopilot), 400);
  // … and lets go once LND's sent counter has moved past them.
  node.channels[0].totalSent = 3_333_333 + 400_000;
  assert.equal(await floorOf(autopilot), null, "a refill whose sats have routed out sets no floor");
});

/** A routing version of it: the target drained by 1.2M of forwards out in
 *  10 days at 400 ppm, and a market reference into its peer (others charge
 *  100 ppm, the peer 50 back) — so after a big refill the engine's own
 *  rules would take the fee down toward the balance curve. */
function routingNode() {
  const channels = holdChannels();
  const node = holdNode(channels, forwardsOut("850000x1x0", "850000x2x0", 20, { tokens: 60_000, feeMsat: 24_000, days: 10 }));
  withMarket(node, channels, { "850000x1x0": { intoPpm: 100, backPpm: 50 } });
  return node;
}

test("a refill run by hand from a recommended row carries the gate — and its price is held like an autopilot refill's, as the Rebalancing tab says; one run by hand without the gate sets no floor, and the engine cuts the fee right after it", async (t) => {
  t.mock.method(console, "log", () => undefined);
  /** The fee stage's next move for the target once a 1.25M refill landed. */
  const afterRefill = async (manual: Record<string, unknown>) => {
    const node = routingNode();
    const { autopilot, dir } = autopilotWith(t, { rebalanceDailyBudgetSats: 10_000 }, {}, {}, node);
    const res = await autopilot.rebalanceByHand({ targetId: "850000x1x0", sourceId: "850000x2x0", amountSats: 1_250_000, econRatio: 0.8, maxFeePpm: 320, ...manual });
    assert.equal(res?.ok, true, res?.error);
    node.channels[0].localBalance += 1_250_000; // LND's balances after it: 40 % local
    const seam = autopilot as unknown as { feeReport(e: Map<string, number>): Promise<{ recommendations: FeeRecommendationView[] }> };
    const fee = (await seam.feeReport(new Map())).recommendations.find((r) => r.channelId === "850000x1x0")!;
    return { fee, rec: new RebalanceLog(dir).successes()[0] };
  };
  // Exactly what the tab sends for a recommended row (manualRefillRequest).
  const gated = await afterRefill({ maxFeeSats: 380, gate: { revenuePpm: 400, demandSats: 1_200_000, minNetSats: 100 } });
  assert.deepEqual([gated.rec?.via, gated.rec?.holdPpm, gated.rec?.targetSentBefore], ["manual", 400, 3_333_333]);
  assert.equal(gated.fee.metrics.profitFloorPpm, 400);
  assert.ok(gated.fee.targetPpm >= 400 && gated.fee.aimPpm >= 400, `${gated.fee.targetPpm} (aim ${gated.fee.aimPpm}) | ${gated.fee.reasons.join(" | ")}`);
  assert.ok(gated.fee.reasons.some((x) => /^profit floor: a refill today \(.*\) was worth paying for at 400 ppm/.test(x)), gated.fee.reasons.join(" | "));
  // Without the gate the operator chose the price: no floor — and the very
  // next update heads for the balance curve's ~290 ppm. Before, that was a
  // refill run from a recommended row too: "+167 expected, ~+35 realised".
  const own = await afterRefill({});
  assert.deepEqual([own.rec?.via, own.rec?.holdPpm], ["manual", undefined]);
  assert.equal(own.fee.metrics.profitFloorPpm, null);
  assert.ok(own.fee.aimPpm < 400 && own.fee.targetPpm < 400, `${own.fee.targetPpm} (aim ${own.fee.aimPpm}) | ${own.fee.reasons.join(" | ")}`);
});
