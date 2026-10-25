/**
 * A drained channel people route through is refilled once a price that
 * pays for it is PROVEN (2026-10-24, from a live node's numbers).
 *
 * Before: the top earner sat at 1 % local for weeks. Refills cost ~502 ppm
 * (the routes from the node's full, idle channels), and the gate valued the
 * refilled sats at the 230 ppm the channel had earned over 30 days and
 * capped the earnings at its last 14 days' outflow, 0.23M — all a drained
 * channel could still sell (2.4M in 30 days). No refill could pass, whatever
 * the fee engine raised the fee to; and the 30-day average would have lagged
 * a higher price that sold for a month.
 *
 * Now: for a drained channel not refilling itself, the demand counted is
 * the larger of the 14-day outflow and half the 30-day one; and what it sold
 * at the fee it charges now (since that fee was set — at least PROVEN_SALES
 * forwards) counts as earned. Never a price nobody paid: a first version
 * valued one refill at the untested fee, and the refill's hold then kept
 * that fee for up to 30 days where nobody bought (review).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVEN_REFILL_MULTIPLE, PROVEN_SALES, REBAL_REC_DEFAULTS, boughtAndLeased, classify, planRebalances, wouldTake, type RouteProbe } from "../src/services/rebalanceRecommend.js";
import { FEE_REC_DEFAULTS, buildRecommendation, type BuildCtx, type Flow, type ProvenLevel } from "../src/services/feeRecommend.js";
import type { ChannelView } from "../src/services/channels.js";

const NOW = Date.parse("2026-10-24T12:00:00.000Z");
const HEIGHT = 860_000;
const flow = (out: number, inn: number, forwards: number, revenue: number): Flow => ({ out, inn, forwards, revenue });
const NONE = flow(0, 0, 0, 0);

const view = (o: Partial<ChannelView> & { id: string; localBalance: number }): ChannelView => {
  const capacity = o.capacity ?? 3_000_000;
  return {
    peerPubkey: "02" + o.id.split("x")[1].padStart(2, "0").repeat(32),
    peerAlias: o.peerAlias ?? "peer",
    active: true,
    private: false,
    initiator: "local",
    capacity,
    transactionId: "ab".repeat(32),
    transactionVout: 0,
    remoteBalance: capacity - o.localBalance,
    localRatio: o.localBalance / capacity,
    totalSent: 0,
    totalReceived: 0,
    unsettled: 0,
    status: "open",
    role: "router",
    ...o,
  };
};

/** The level `sold` makes at `ppm` — proven with PROVEN_SALES sales. */
const levelOf = (ppm: number, sold: Flow): ProvenLevel | null =>
  sold.forwards >= PROVEN_SALES && sold.out > 0
    ? { ppm, paidPpm: Math.round((sold.revenue / sold.out) * 1_000_000), sales: sold.forwards, out: sold.out, revenue: sold.revenue, from: new Date(NOW - 86_400_000).toISOString(), to: null }
    : null;
const ctxOf = (ch: ChannelView, ppm: number, f14: Flow, f30: Flow, sold: Flow = NONE, o: Partial<BuildCtx> = {}): BuildCtx => ({
  cfg: { ...FEE_REC_DEFAULTS, stepPpm: 10, minChangePpm: 25 },
  rate: { fee_rate: ppm, base_fee_mtokens: "0", transaction_id: ch.transactionId, transaction_vout: ch.transactionVout },
  override: undefined,
  f14,
  f30,
  soldSinceChange: sold,
  provenLevel: levelOf(ppm, sold),
  currentBlock: HEIGHT,
  records: [],
  bench: { activeChannelCount: 2, topGrossFlow14d: 0, medianGrossFlow14d: 0, topRevenue30d: 0, medianRevenue30d: 0, topRevenuePpm30d: 0, medianRevenuePpm30d: 0 },
  enoughChannels: false,
  earnerCutoff: 0,
  cooldown: null,
  elasticityMod: 1,
  flowAnchor: undefined,
  leaseCap: null,
  demand: undefined,
  // What the live graph said of the peer: others charge ~1 ppm into it.
  market: { intoPeerPpm: 1, samples: 5, peerFeeToUsPpm: 0 },
  nowMs: NOW,
  ...o,
});

// The live top earner: 3M, 1 % local; 2.4M out and 1.81M in over 30 days in
// 151 forwards that earned 553 sat (230 ppm), 0.23M out in the last 14.
const drained = view({ id: "850000x1x0", peerAlias: "top earner", localBalance: 30_000 });
const f14 = flow(230_000, 0, 54, 53);
const f30 = flow(2_400_000, 1_810_000, 151, 553);
/** Sold `n` times at `ppm` since the fee was set (`each` sats a forward: 16k, the live average). */
const soldAt = (ppm: number, n = PROVEN_SALES, each = 16_000): Flow => flow(n * each, 0, n, (n * each * ppm) / 1_000_000);
// A full channel nobody routes through: the source.
const idle = view({ id: "850000x2x0", peerAlias: "idle", localBalance: 2_970_000 });
const routeAt = (ppm: number): RouteProbe => async (_s, _t, amount) => ({ costPpm: ppm, feeSats: Math.ceil((amount * ppm) / 1_000_000) });

/** The plan for `target` at `ppm`, refilled from the idle channel over a ~502 ppm route. */
async function planAt(ppm: number, sold: Flow = NONE, o: { target?: ChannelView; f14?: Flow; f30?: Flow; ctx?: Partial<BuildCtx> } = {}) {
  const target = o.target ?? drained;
  const targetCtx = ctxOf(target, ppm, o.f14 ?? f14, o.f30 ?? f30, sold, o.ctx);
  const sourceCtx = ctxOf(idle, 25, NONE, NONE);
  const fees = [buildRecommendation(target, targetCtx), buildRecommendation(idle, sourceCtx)];
  const report = await planRebalances(
    {
      channels: [target, idle],
      fees,
      contextOf: (id) => (id === target.id ? targetCtx : id === idle.id ? sourceCtx : undefined),
      cfg: REBAL_REC_DEFAULTS,
      overrides: {},
      soldLeases: [],
      currentBlock: HEIGHT,
    },
    routeAt(502),
  );
  const rec = report.recommendations.find((r) => r.channelId === target.id);
  assert.ok(rec, "the drained channel has a row");
  return { rec, fee: fees[0] };
}

test("a drained channel's demand is what it sold with liquidity: half its 30-day outflow when the last 14 days show less (0.23M → 1.2M) — not for a channel with liquidity, nor one inflows are refilling", () => {
  const rec = classify(drained, buildRecommendation(drained, ctxOf(drained, 350, f14, f30)), REBAL_REC_DEFAULTS, {});
  assert.equal(rec.earningDemandSats, 1_200_000);
  // Net drain: max(0.23M in 14 d, (2.4M − 1.81M) / 2), × 1.5 for the refill.
  assert.equal(rec.demandNetDrainSats, (2_400_000 - 1_810_000) / 2);
  assert.equal(rec.demandSizedAmount, Math.round(((2_400_000 - 1_810_000) / 2) * REBAL_REC_DEFAULTS.demandCoverageMultiplier));
  // With liquidity (28 % local): its 14 days, as before.
  const stocked = view({ id: "850000x1x0", localBalance: 840_000 });
  const s = classify(stocked, buildRecommendation(stocked, ctxOf(stocked, 350, flow(50_000, 0, 5, 10), f30)), REBAL_REC_DEFAULTS, {});
  assert.deepEqual([s.earningDemandSats, s.demandNetDrainSats], [50_000, 50_000]);
  // Drained, but inflows refill it (more in than out over 14 days): no demand from the 30 days.
  const refilling = classify(drained, buildRecommendation(drained, ctxOf(drained, 350, flow(200_000, 1_500_000, 20, 40), f30)), REBAL_REC_DEFAULTS, {});
  assert.deepEqual([refilling.earningDemandSats, refilling.demandNetDrainSats], [200_000, 0]);
});

test("the live case: no refill at the 230 ppm it earned, nor at a raised fee nobody has paid yet — one once it sold at that fee (it never could: valued at 230 ppm whatever the fee)", async () => {
  const at350 = await planAt(350);
  assert.equal(at350.rec.state, "route_found_too_expensive", at350.rec.reasons.join(" | "));
  // Raised to 820, nothing sold at it since: valued at the 230 ppm it earned — no refill.
  const untested = await planAt(820);
  assert.equal(untested.rec.expectedRevenuePpm, 230, untested.rec.reasons.join(" | "));
  assert.equal(untested.rec.wouldRebalance, false);
  // Sold three times at 820 since it was set: proven, and refilled.
  const { rec } = await planAt(820, soldAt(820));
  assert.equal(rec.expectedRevenuePpm, 820, rec.reasons.join(" | "));
  assert.equal(rec.state, "route_found_profitable", rec.reasons.join(" | "));
  assert.equal(rec.wouldRebalance, true);
  assert.equal(rec.estimatedRouteCostPpm, 502);
  assert.ok((rec.expectedNetProfitSats ?? 0) >= REBAL_REC_DEFAULTS.minExpectedNetProfitSats, `net ${rec.expectedNetProfitSats}`);
  assert.equal(rec.selectedSourceChannel, idle.id);
  assert.ok(
    rec.reasons.includes("valued at 820 ppm: it sold 3 times at 820 ppm since it was set (820 ppm paid; 230 ppm over 30 d) — a refill of at most 480k, 10× what sold at it"),
    rec.reasons.join(" | "),
  );
  // Two sales aren't proof yet — and the row says what would count.
  const two = await planAt(820, soldAt(820, PROVEN_SALES - 1));
  assert.equal(two.rec.wouldRebalance, false);
  assert.ok(
    two.rec.reasons.includes("its fee now (820 ppm) counts once it sold 3 times at it within 14 d (now 2 since it was set) — until then the 230 ppm it earned in 30 d decides"),
    two.rec.reasons.join(" | "),
  );
});

test("a proven price carries a refill only as big as what sold at it — at most 10× those sats (review 2: three 1k forwards valued a 443k refill at 820, whose hold then kept the fee there)", async () => {
  // Three 1k forwards at 820: at most the 50k minimum refill — which doesn't net the minimum profit.
  const tiny = await planAt(820, soldAt(820, PROVEN_SALES, 1_000));
  assert.equal(tiny.rec.expectedRevenuePpm, 820, tiny.rec.reasons.join(" | "));
  assert.ok((tiny.rec.recommendedAmount ?? 0) <= REBAL_REC_DEFAULTS.minRebalanceAmount, `${tiny.rec.recommendedAmount}`);
  assert.equal(tiny.rec.wouldRebalance, false);
  // Three 16k forwards: up to 480k — the demand-sized 443k fits.
  const real = await planAt(820, soldAt(820));
  assert.ok((real.rec.recommendedAmount ?? 0) <= PROVEN_REFILL_MULTIPLE * 3 * 16_000, `${real.rec.recommendedAmount}`);
  assert.equal(real.rec.recommendedAmount, real.rec.demandSizedAmount);
  // A proven price within rounding of the 30-day one says nothing ("at lower fees" was false there).
  const same = await planAt(240, soldAt(232));
  assert.ok(!same.rec.reasons.some((x) => x.startsWith("valued at") || x.startsWith("its fee now")), same.rec.reasons.join(" | "));
});

test("a fee nobody paid is never a refill's value — a pin, or the protect ramp's lift, values it at what it earned, as before (review: a pin at 1,500 that earned 230 passed a 900 ppm route)", async () => {
  const pinned = await planAt(1_500, NONE, { ctx: { override: { mode: "fixed", fixedPpm: 1_500 } } });
  assert.ok((pinned.rec.expectedRevenuePpm ?? 0) <= 230, pinned.rec.reasons.join(" | "));
  // A 5M channel at 5 % local that earned 80 ppm, lifted to 350 by the protect ramp.
  const lifted = view({ id: "850000x1x0", capacity: 5_000_000, localBalance: 250_000 });
  const p = await planAt(350, NONE, { target: lifted, f14: flow(300_000, 0, 10, 24), f30: flow(700_000, 100_000, 20, 56) });
  assert.equal(p.rec.expectedRevenuePpm, 80, p.rec.reasons.join(" | "));
});

test("the fee now never values a refill above where the fee engine is taking the fee, and a proven price is bounded by it too", () => {
  // Sold at 1,200 since it was set, but the engine brings it down to its max (1,000): valued at most there.
  const high = buildRecommendation(drained, ctxOf(drained, 1_200, f14, f30, soldAt(1_200)));
  const capped = classify(drained, high, REBAL_REC_DEFAULTS, {});
  assert.equal(capped.expectedRevenuePpm, Math.min(1_200, high.targetPpm, high.aimPpm));
  assert.ok(capped.expectedRevenuePpm! <= 1_000);
  // Earned 600 ppm at higher fees, charges 400 now: valued at 400, as before.
  const cheaper = buildRecommendation(drained, ctxOf(drained, 400, f14, flow(2_400_000, 1_810_000, 151, 1_440)));
  const rec = classify(drained, cheaper, REBAL_REC_DEFAULTS, {});
  assert.equal(rec.expectedRevenuePpm, Math.min(400, cheaper.targetPpm, cheaper.aimPpm));
  assert.ok(!rec.reasons.some((x) => x.startsWith("valued at")), rec.reasons.join(" | "));
});

test("'what it would take' asks for the demand the gate counted — not the raw 14 days (review: \"≥ 314k of 14-day outflow (now 230k)\" where the gate had counted 1.2M)", async () => {
  // Proven at 820 but little revenue (200 sat in 30 days): the payback limit binds.
  const weak = await planAt(820, soldAt(820), { f30: flow(2_400_000, 1_810_000, 151, 200) });
  const line = wouldTake(weak.rec, REBAL_REC_DEFAULTS, 502) ?? "";
  assert.match(line, /pay back/, line);
  assert.ok(!/outflow|net drain/.test(line), `the 1.2M it counted covers the refill: ${line}`);
  // Where the counted demand falls short, the line says what it counted.
  const thin = await planAt(820, soldAt(820), { f14: flow(50_000, 0, 6, 10), f30: flow(400_000, 100_000, 20, 200) });
  const short = wouldTake(thin.rec, REBAL_REC_DEFAULTS, 502) ?? "";
  assert.match(short, /of outflow \(half its 30 days, as it is drained\) \(now 200k\)/, short);
});

test("the proof survives the raise it led to: proven at 820, the same run's fee stage moved it on (nothing sold since) — the refill is still valued at the 820 that sold (three reviewers: never a refill while a ramp climbs)", async () => {
  // The fee is 980 now, nothing sold at it; the level before (820) sold 3 times.
  const proven: ProvenLevel = { ppm: 820, paidPpm: 820, sales: 3, out: 48_000, revenue: 39.36, from: new Date(NOW - 3 * 86_400_000).toISOString(), to: new Date(NOW - 3_600_000).toISOString() };
  const { rec } = await planAt(980, NONE, { ctx: { provenLevel: proven } });
  assert.equal(rec.expectedRevenuePpm, 820, rec.reasons.join(" | "));
  assert.equal(rec.wouldRebalance, true, rec.reasons.join(" | "));
  assert.ok(
    rec.reasons.some((x) => x.startsWith(`valued at 820 ppm: it sold 3 times at 820 ppm until ${proven.to!.slice(0, 10)}`)),
    rec.reasons.join(" | "),
  );
});

test("a channel bought on Magma for its inbound is never a refill target while its lease runs — its low local balance is what was bought", async () => {
  const bought = view({ id: "859000x1x0", peerAlias: "seller", localBalance: 30_000 });
  const report = await planRebalances(
    {
      channels: [bought, idle],
      fees: [buildRecommendation(bought, ctxOf(bought, 820, f14, f30, NONE, { provenLevel: levelOf(820, flow(48_000, 0, 3, 39.36)) })), buildRecommendation(idle, ctxOf(idle, 25, NONE, NONE))],
      contextOf: (id) => (id === bought.id ? ctxOf(bought, 820, f14, f30) : ctxOf(idle, 25, NONE, NONE)),
      cfg: REBAL_REC_DEFAULTS,
      overrides: {},
      soldLeases: [],
      currentBlock: HEIGHT,
      boughtLeases: [{ channelId: "859000x1x0", leaseBlocks: 4320 }],
    },
    routeAt(502),
  );
  const rec = report.recommendations.find((r) => r.channelId === bought.id)!;
  assert.deepEqual([rec.state, rec.wouldRebalance], ["watching", false], rec.reasons.join(" | "));
  assert.match(rec.reasons[0], /^bought on Magma for its inbound, its lease still running — never refilled/);
  // After the lease (opened at 859,000 + 4,320 blocks): like any channel.
  assert.equal(boughtAndLeased("859000x1x0", [{ channelId: "859000x1x0", leaseBlocks: 4320 }], 863_321), false);
  const numeric = String((859000n << 40n) | (1n << 16n)); // the same channel as a short channel id
  assert.equal(boughtAndLeased("859000x1x0", [{ channelId: numeric, leaseBlocks: null }], 860_000), true, "a numeric id, the default lease");
});

test("a young channel with no flow yet is not a close candidate in the rebalancer either — the new-channel check comes first, and a weak peer is judged after 30 days", () => {
  const young = view({ id: `${HEIGHT - 144 * 2}x1x0`, localBalance: 30_000 }); // ~2 days
  const r = classify(young, buildRecommendation(young, ctxOf(young, 80, NONE, NONE)), REBAL_REC_DEFAULTS, {});
  assert.notEqual(r.state, "close_candidate", r.reasons.join(" | "));
  assert.match(r.reasons[0], /^new channel \(2d\)/);
  const tenDays = view({ id: `${HEIGHT - 144 * 10}x1x0`, localBalance: 30_000 });
  const t = classify(tenDays, buildRecommendation(tenDays, ctxOf(tenDays, 80, NONE, NONE)), REBAL_REC_DEFAULTS, {});
  assert.notEqual(t.state, "close_candidate", t.reasons.join(" | "));
  assert.match(t.reasons[0], /^young channel \(10d\) with no flow yet/);
});

test("a drained channel's demand basis tolerates inflows up to max(1 % of capacity, 50k) in 14 days — bitcoinwell's 2 sat in switched it off ('demand too small (0k)')", () => {
  const drainedBw = view({ id: "850000x1x0", capacity: 1_000_000, localBalance: 12_000 });
  const bw = (inn: number) =>
    classify(drainedBw, buildRecommendation(drainedBw, ctxOf(drainedBw, 350, flow(0, inn, 0, 0), flow(1_780_000, 1_500_000, 15, 186))), REBAL_REC_DEFAULTS, {});
  assert.equal(bw(2).earningDemandSats, 890_000, "2 sat in: still drained, half its 30-day outflow");
  assert.equal(bw(50_000).earningDemandSats, 890_000, "50k in: within the tolerance");
  assert.equal(bw(60_000).earningDemandSats, 0, "60k in, nothing out: refilling itself");
});

