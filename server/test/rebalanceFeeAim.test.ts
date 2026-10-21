/**
 * The rebalancer reads the fee engine's AIM, not just its next step (review
 * 2 of package P2). Since P2 the engine's target is one bounded move toward
 * the aim; the refill budget's conservative revenue bound took that first
 * step (870 on the way from 900 to ~510 ppm) as if it were where the fee
 * was heading — refills were budgeted on a fee the channel was leaving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { REBAL_REC_DEFAULTS, classify } from "../src/services/rebalanceRecommend.js";
import { FEE_REC_DEFAULTS, buildRecommendation, type Flow } from "../src/services/feeRecommend.js";
import type { ChannelView } from "../src/services/channels.js";

const flow = (out: number, inn: number, forwards: number, revenue: number): Flow => ({ out, inn, forwards, revenue });

test("the refill budget is bounded by where the fee engine is taking the fee — not by its first step there — and the row shows both", () => {
  const ch: ChannelView = {
    id: "850000x1x0",
    peerPubkey: "02" + "11".repeat(32),
    peerAlias: "peer",
    active: true,
    private: false,
    initiator: "local",
    capacity: 2_000_000,
    transactionId: "aa".repeat(32),
    transactionVout: 0,
    localBalance: 500_000,
    remoteBalance: 1_500_000,
    localRatio: 0.25,
    totalSent: 0,
    totalReceived: 0,
    unsettled: 0,
    status: "open",
    role: "router",
  };
  // Drained to 25% at 900 ppm, routing out at ~800 ppm: the balance curve
  // wants ~510, so the engine lowers it a ratchet's worth per move. (A
  // cheap market into the peer — a refill costs ~150 ppm — says it is
  // priced above its refill cost: without any reference a draining channel
  // is held, review 3.)
  const fee = buildRecommendation(ch, {
    cfg: { ...FEE_REC_DEFAULTS, stepPpm: 10, minChangePpm: 25 },
    rate: { fee_rate: 900, base_fee_mtokens: "0", transaction_id: "aa".repeat(32), transaction_vout: 0 },
    override: undefined,
    f14: flow(300_000, 50_000, 6, 240),
    f30: flow(600_000, 100_000, 12, 480),
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
    market: { intoPeerPpm: 100, samples: 5, peerFeeToUsPpm: 50 },
    nowMs: Date.parse("2026-10-21T12:00:00.000Z"),
  });
  assert.deepEqual([fee.targetPpm, fee.aimPpm], [870, 510], fee.reasons.join(" | "));
  const rec = classify(ch, fee, REBAL_REC_DEFAULTS, {});
  // Before: min(800 earned, 900 now, 870 next) = 800 ppm.
  assert.equal(rec.expectedRevenuePpm, 510);
  assert.equal(rec.maxCostPpm, Math.round(510 * REBAL_REC_DEFAULTS.profitShare));
  assert.deepEqual([rec.feeV2TargetPpm, rec.feeV2AimPpm], [870, 510]);
});
