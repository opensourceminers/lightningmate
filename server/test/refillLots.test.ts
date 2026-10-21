/**
 * The profit floor stands only on refilled sats still in the channel (review
 * a2, sunk-cost-profit-floor, package P3).
 *
 * Before: every autopilot refill of the window counted in full until it aged
 * out — one 614 ppm refill whose sats had long routed out kept the
 * channel's fee at 706 ppm (Balanced) for the whole window, and only a month
 * of zero forwards released it: one forward a month kept the floor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEE_REC_DEFAULTS,
  LOW_FLOW_GRACE_DAYS,
  buildRecommendation,
  refillFloor,
  refillLots,
  type BuildCtx,
  type FeeChannel,
  type Flow,
} from "../src/services/feeRecommend.js";
import type { RebalanceRecord } from "../src/services/rebalanceLog.js";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const flow = (out: number, inn: number, forwards: number, revenue: number): Flow => ({ out, inn, forwards, revenue });

const refill = (o: Partial<RebalanceRecord>): RebalanceRecord => ({
  at: ago(1),
  via: "autopilot",
  targetId: "850000x1x0",
  targetAlias: "peer",
  sourceId: "850000x2x0",
  sourceAlias: "src",
  amountSats: 500_000,
  budgetPpm: 1000,
  feeSats: 307, // 614 ppm — the dev node's one success
  costPpm: 614,
  ok: true,
  ...o,
});

test("refilled sats retire first in, first out on LND's sent counter: what left between two refills is taken from the older one", () => {
  const records = [
    refill({ at: ago(5), amountSats: 300_000, feeSats: 60, targetSentBefore: 1_000_000 }),
    // 200k left the channel between the two refills.
    refill({ at: ago(2), amountSats: 400_000, feeSats: 120, targetSentBefore: 1_200_000 }),
  ];
  // Since the second one, 250k more: the older refill's last 100k, then 150k of the newer.
  const lots = refillLots("850000x1x0", records, 1_450_000, NOW);
  assert.deepEqual(lots.map((l) => l.remainingSats), [0, 250_000]);
  const floor = refillFloor(lots, 1.15);
  assert.equal(floor?.remainingSats, 250_000);
  assert.equal(floor?.costPpm, 300, "what the sats still here cost (the newer refill's 300 ppm)");
  // Without the counter (a refill recorded before P3): only age retires it.
  assert.deepEqual(refillLots("850000x1x0", [refill({})], 9_999_999, NOW).map((l) => l.remainingSats), [500_000]);
});

const chan = (o: Partial<FeeChannel> = {}): FeeChannel => ({ id: "850000x1x0", peerAlias: "peer", capacity: 2_000_000, localRatio: 0.7, role: "router", active: true, ...o });
const ctx = (o: Partial<BuildCtx> & { ppm?: number } = {}): BuildCtx => {
  const { ppm, ...rest } = o;
  return {
    cfg: { ...FEE_REC_DEFAULTS, stepPpm: 10, minChangePpm: 25 },
    rate: { fee_rate: ppm ?? 710, base_fee_mtokens: "0", transaction_id: "aa".repeat(32), transaction_vout: 0 },
    override: undefined,
    f14: flow(100_000, 80_000, 6, 8),
    f30: flow(200_000, 160_000, 12, 16),
    currentBlock: 860_000,
    records: [],
    bench: { activeChannelCount: 1, topGrossFlow14d: 0, medianGrossFlow14d: 0, topRevenue30d: 0, medianRevenue30d: 0, topRevenuePpm30d: 0, medianRevenuePpm30d: 0 },
    enoughChannels: false,
    earnerCutoff: 0,
    cooldown: null,
    elasticityMod: 1,
    flowAnchor: undefined,
    leaseCap: null,
    demand: undefined,
    market: undefined,
    nowMs: NOW,
    ...rest,
  };
};

test("a refill whose sats have routed out sets no floor — the 614 ppm refill pinned its channel at 706 ppm long after its sats were gone", () => {
  const record = refill({ targetSentBefore: 2_000_000 });
  const still = buildRecommendation(chan({ totalSent: 2_100_000 }), ctx({ records: [record] }));
  assert.equal(still.metrics.profitFloorPpm, 706, "400k of it still here: 614 × 1.15");
  assert.equal(still.metrics.refillRemainingSats, 400_000);
  assert.ok(still.targetPpm >= 706);
  const gone = buildRecommendation(chan({ totalSent: 2_500_000 }), ctx({ records: [record] }));
  assert.equal(gone.metrics.profitFloorPpm, null, "all 500k routed out: nothing of it left to price");
  assert.equal(gone.metrics.costBasisPpm, null);
  assert.ok(gone.targetPpm < 710, `lowered: ${gone.targetPpm}`);
});

test("a floor is released under low flow — a week after the refill, under 3 forwards out in 14 days at ≥ 40 % local — and the row says so", () => {
  const lowFlow = { f14: flow(20_000, 0, 1, 2), f30: flow(150_000, 0, 4, 15) };
  const released = buildRecommendation(chan(), ctx({ ...lowFlow, records: [refill({ at: ago(LOW_FLOW_GRACE_DAYS + 3) })] }));
  assert.equal(released.metrics.profitFloorReleased, true);
  assert.equal(released.metrics.profitFloorPpm, null);
  assert.ok(
    released.reasons.some((x) => /^profit floor released: 500k of refills still here, but under 3 forwards out in 14 d at 70% local — holding their price \(706 ppm\) isn't moving them$/.test(x)),
    released.reasons.join(" | "),
  );
  assert.ok(released.targetPpm < 710);
  // Within the week after the refill: still held (it gets its chance).
  assert.equal(buildRecommendation(chan(), ctx({ ...lowFlow, records: [refill({ at: ago(3) })] })).metrics.profitFloorPpm, 706);
  // Routing (3+ forwards): held.
  assert.equal(buildRecommendation(chan(), ctx({ records: [refill({ at: ago(10) })] })).metrics.profitFloorPpm, 706);
  // Drained again (under 40 % local): its sats are moving — held.
  assert.equal(buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ...lowFlow, records: [refill({ at: ago(10) })] })).metrics.profitFloorPpm, 706);
});

test("the floor's line says which refill it stands on: when, what it was worth paying for, and how much of it is still in the channel", () => {
  const r = buildRecommendation(
    chan({ totalSent: 1_100_000 }),
    ctx({ ppm: 500, records: [refill({ at: ago(2), amountSats: 750_000, feeSats: 188, holdPpm: 480, targetSentBefore: 1_000_000 })] }),
  );
  assert.equal(r.metrics.profitFloorPpm, 480);
  assert.equal(r.metrics.refillHoldPpm, 480);
  assert.ok(
    r.reasons.some((x) => x.startsWith("profit floor: a refill 2 d ago (2026-10-19) was worth paying for at 480 ppm (it cost 251 ppm) = 480 ppm; 650k of its 750k still here — the floor ends when that has routed out (at most 30 d)")),
    r.reasons.join(" | "),
  );
  // A refill run by hand without the gate — its own price, past the profit
  // gate — sets none …
  const manual = buildRecommendation(chan(), ctx({ records: [refill({ via: "manual" })] }));
  assert.equal(manual.metrics.profitFloorPpm, null);
  // … one run with it (from a recommended row: the gate capped its payment,
  // and its value is booked as the hold) is held like the autopilot's.
  const gated = buildRecommendation(chan(), ctx({ records: [refill({ via: "manual", holdPpm: 900 })] }));
  assert.deepEqual([gated.metrics.profitFloorPpm, gated.metrics.refillHoldPpm], [900, 900]);
});

test("a refill that cost more than its value × the margin allows (econRatio near 1) is floored at its cost × the margin — and says that, not 'worth paying for at'", () => {
  // Valued at 400 ppm; the route took 380 ppm of it (econRatio 1): × 1.15
  // = 437 ppm, above the value it was held at.
  const record = refill({ amountSats: 500_000, feeSats: 190, holdPpm: 400, targetSentBefore: 1_000_000 });
  const floor = refillFloor(refillLots("850000x1x0", [record], 1_000_000, NOW), 1.15);
  assert.deepEqual([floor?.ppm, floor?.held], [437, false]);
  const r = buildRecommendation(chan({ totalSent: 1_000_000 }), ctx({ ppm: 500, records: [record] }));
  assert.equal(r.metrics.profitFloorPpm, 437);
  assert.equal(r.metrics.refillHoldPpm, null, "not held at its value: floored at its cost");
  assert.ok(
    r.reasons.some((x) => x.startsWith("profit floor: a refill 1 d ago (2026-10-20) cost 380 ppm × 1.15 = 437 ppm; 500k of its 500k still here")),
    r.reasons.join(" | "),
  );
});
