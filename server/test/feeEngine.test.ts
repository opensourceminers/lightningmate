/**
 * The fee engine's own moves (review a1, package P2): small bounded steps
 * toward an aim, and an anti-churn threshold that no longer vetoes them.
 *
 * Before: the threshold (≥ 25 ppm and ≥ 20 % of the fee) judged the size of
 * one move, and the engine's designed moves were smaller — +20 raise, −30
 * ratchet, +40 protect at the policy's step of 10. Draining channels never
 * rose, idle channels ≥ 160 ppm never fell, protect stalled at 240 ppm. Any
 * learned elasticity above 1 removed the raise cap (80 → 450 ppm in one
 * update); a drained idle channel jumped to ~900 ppm; one refill set a
 * lifetime profit floor above maxPpm in one jump; a pin of 290 on a 300 ppm
 * channel never applied, one of 0 became 25 and one of 2,000 the policy max.
 *
 * Each preset is simulated here on the autopilot's 30-minute loop for 30 days
 * (the dev check the review asked for: on idle, draining and drained
 * channels the fee must actually move).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEE_REC_DEFAULTS,
  RAISE_STEPS,
  RAMP_STEPS,
  buildRecommendation,
  getFeeRecommendations,
  type BuildCtx,
  type FeeChannel,
  type FeeRecConfig,
  type FeeRecommendation,
  type Flow,
} from "../src/services/feeRecommend.js";
import type { RebalanceRecord } from "../src/services/rebalanceLog.js";
import type { LeaseCap } from "../src/services/leaseCaps.js";
import { feeNode, forwardsOut } from "./helpers/feeNode.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const HEIGHT = 860_000;
const STEP = 10; // the policy's "Round to" (DEFAULT_POLICY.step), as the autopilot maps it

/** The three Strategy presets' fee behaviour (web/src/presets.ts), on the
 *  default policy's step 10 / min change 25 — as the autopilot runs them. */
const PRESETS: Record<string, Partial<FeeRecConfig>> = {
  "Max routing": { minPpm: 25, neutralPpm: 60, maxPpm: 1000, protectPpm: 250, safetyMargin: 1.05, noFlowRatchetSteps: 4, exploreLowerModifier: 0.75 },
  Balanced: { minPpm: 25, neutralPpm: 80, maxPpm: 1000, protectPpm: 350, safetyMargin: 1.15, noFlowRatchetSteps: 3, exploreLowerModifier: 0.85 },
  "Max profit": { minPpm: 80, neutralPpm: 150, maxPpm: 1500, protectPpm: 600, safetyMargin: 1.35, noFlowRatchetSteps: 1, exploreLowerModifier: 0.9 },
};
const cfgOf = (p: Partial<FeeRecConfig>, o: Partial<FeeRecConfig> = {}): FeeRecConfig => ({
  ...FEE_REC_DEFAULTS,
  ...p,
  stepPpm: STEP,
  minChangePpm: 25,
  maxChangesPerRun: 5,
  ...o,
});

const NO_FLOW: Flow = { out: 0, inn: 0, revenue: 0, forwards: 0 };
const flow = (out: number, inn: number, forwards: number, revenue = 0): Flow => ({ out, inn, forwards, revenue });

const chan = (o: Partial<FeeChannel> = {}): FeeChannel => ({
  id: "850000x1x0", // ~69 days old at HEIGHT
  peerAlias: "peer",
  capacity: 2_000_000,
  localRatio: 0.5,
  role: "router",
  active: true,
  ...o,
});

const ctx = (o: Partial<BuildCtx> & { ppm?: number; baseMsat?: number } = {}): BuildCtx => {
  const { ppm, baseMsat, ...rest } = o;
  return {
    cfg: cfgOf(PRESETS.Balanced),
    rate: { fee_rate: ppm ?? 80, base_fee_mtokens: String(baseMsat ?? 0), transaction_id: "aa".repeat(32), transaction_vout: 0 },
    override: undefined,
    f14: NO_FLOW,
    f30: NO_FLOW,
    currentBlock: HEIGHT,
    records: [],
    bench: { activeChannelCount: 1, topGrossFlow14d: 0, medianGrossFlow14d: 0, topRevenue30d: 0, medianRevenue30d: 0, topRevenuePpm30d: 0, medianRevenuePpm30d: 0 },
    enoughChannels: false,
    earnerCutoff: 0,
    cooldown: { lastApplied: {}, cooldownHours: 6 },
    elasticityMod: 1,
    flowAnchor: undefined,
    leaseCap: null,
    demand: undefined,
    market: undefined,
    nowMs: NOW,
    ...rest,
  };
};

/** The engine on the autopilot's 30-minute loop for `days`: every update it
 *  would apply is applied (the fee moves, the cooldown is stamped). */
function simulate(ch: FeeChannel, c: BuildCtx, days: number): { fees: number[]; moves: number[]; last: ReturnType<typeof buildRecommendation> } {
  let fee = c.rate!.fee_rate;
  let base = c.rate!.base_fee_mtokens;
  const lastApplied: Record<string, string> = {};
  const fees = [fee];
  const moves: number[] = [];
  let last = buildRecommendation(ch, c);
  for (let i = 0; i < days * 48; i++) {
    const nowMs = NOW + i * 30 * 60_000;
    last = buildRecommendation(ch, {
      ...c,
      rate: { ...c.rate!, fee_rate: fee, base_fee_mtokens: base },
      cooldown: { lastApplied, cooldownHours: c.cooldown?.cooldownHours ?? 6 },
      nowMs,
    });
    if (last.wouldApply) {
      moves.push(last.targetPpm - fee);
      fee = last.targetPpm;
      base = String(last.recommendedBaseMsat);
      lastApplied[ch.id] = new Date(nowMs).toISOString();
      fees.push(fee);
    }
  }
  return { fees, moves, last };
}

// ── the threshold no longer vetoes the engine's own steps ───────────────────

test("every preset: a draining routing channel (30% local) at 80 ppm rises — in steps of at most two 'Round to' steps", () => {
  const ch = chan({ localRatio: 0.3 });
  for (const [name, p] of Object.entries(PRESETS)) {
    const start = Math.max(80, p.minPpm ?? 0);
    const sim = simulate(ch, ctx({ cfg: cfgOf(p), ppm: start, f14: flow(300_000, 50_000, 10, 24), f30: flow(600_000, 100_000, 20, 48) }), 30);
    const end = sim.fees.at(-1)!;
    // Before: 80 → 100 at most (only the base-fee drop got past the
    // threshold), and on a node already at base 0 not even that.
    assert.ok(end >= start + 6 * RAISE_STEPS * STEP, `${name}: ${sim.fees.join("→")}`);
    for (const m of sim.moves) assert.ok(m > 0 && m <= RAISE_STEPS * STEP, `${name}: a move of ${m} ppm`);
  }
});

test("every preset: an idle channel keeps stepping down — at 25% local from 500 ppm, at 40% from 300, after a refill from 590 — instead of freezing after one step", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    for (const [ratio, from] of [[0.25, 500], [0.4, 300], [0.2, 590]] as const) {
      const sim = simulate(chan({ localRatio: ratio }), ctx({ cfg: cfgOf(p), ppm: from }), 30);
      const step = (p.noFlowRatchetSteps ?? 3) * STEP;
      const floor = p.minPpm ?? 25;
      const end = sim.fees.at(-1)!;
      // Before: one ratchet step (500 → 470), then "change below threshold"
      // for good — the step was under 20% of the fee. Now it walks down until
      // it is within the threshold (25 ppm) of the floor, or 20 steps lower.
      assert.ok(sim.moves.length >= 2, `${name} @${ratio}: ${sim.fees.join("→")}`);
      assert.ok(end <= Math.max(floor + 25, from - 20 * step), `${name} @${ratio}: ${sim.fees.join("→")}`);
      for (const m of sim.moves) assert.ok(m < 0, `${name} @${ratio}: idle, yet raised by ${m}`);
    }
  }
});

test("every preset: a drained channel still in demand ramps all the way to protectPpm (it stalled at 240 below 350 / 600)", () => {
  const ch = chan({ localRatio: 0.05 });
  for (const [name, p] of Object.entries(PRESETS)) {
    const sim = simulate(ch, ctx({ cfg: cfgOf(p), ppm: 80, f14: flow(150_000, 0, 5, 12), f30: flow(300_000, 0, 10, 24) }), 30);
    assert.ok(sim.fees.at(-1)! >= p.protectPpm!, `${name}: ${sim.fees.join("→")}`);
    for (const m of sim.moves) assert.ok(m <= RAMP_STEPS * STEP, `${name}: a move of ${m} ppm`);
  }
});

// ── drained and idle: never raised ──────────────────────────────────────────

test("every preset: a drained channel nobody routes through is never raised — it held 80 ppm where it jumped to 900 (1,350 on Max profit) in one update", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const start = Math.max(80, p.minPpm ?? 0);
    const sim = simulate(chan({ localRatio: 0.05 }), ctx({ cfg: cfgOf(p), ppm: start }), 30);
    assert.deepEqual(sim.fees, [start], `${name}: ${sim.fees.join("→")}`);
    assert.equal(sim.last.targetPpm, start);
    assert.equal(sim.last.wouldApply, false);
    assert.match(sim.last.reasons[0], /^hold: drained \(5% local\) and idle/);
  }
});

test("a raise on a channel that has not routed is capped as well — the gentle cap no longer depends on forwards", () => {
  // A day-old channel the peer opened (20% ours), no forwards yet: the
  // new-channel rules keep it out of the no-flow lowering, and the curve
  // wants ~590 ppm. Before: the cap needed forwards — 100 → 590 in one move.
  const r = buildRecommendation(chan({ id: `${HEIGHT - 144}x1x0`, localRatio: 0.2 }), ctx({ ppm: 100 }));
  assert.equal(r.targetPpm, 100 + RAISE_STEPS * STEP);
  assert.ok(r.aimPpm >= 500, `the aim stays where the curve wants it: ${r.aimPpm}`);
  assert.match(r.reasons.join(" | "), /guard: raising at most 20 ppm per move — 100→120 on the way to \d+ ppm/);
});

// ── elasticity scales the step, never removes the cap ───────────────────────

test("elasticity above 1 never removes the raise cap: 1.05 moved 80 → 450 ppm in one update, now at most 2 steps × the modifier — and the reason states the move", () => {
  const base = { f14: flow(300_000, 50_000, 10, 24), f30: flow(600_000, 100_000, 20, 48), ppm: 80 } as const;
  for (const el of [1.01, 1.05, 1.2, 1.25]) {
    const r = buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ...base, elasticityMod: el }));
    assert.ok(r.targetPpm - 80 <= Math.ceil(RAISE_STEPS * STEP * el), `elasticity ${el}: 80 → ${r.targetPpm}`);
    assert.ok(r.targetPpm > 80);
    const guard = r.reasons.find((x) => x.startsWith("guard: raising"));
    assert.match(guard ?? "", new RegExp(`80→${r.targetPpm} on the way to \\d+ ppm`), r.reasons.join(" | "));
    assert.ok(!r.reasons.some((x) => /pricing ~\d+% higher/.test(x)), "no '+5%' — the move in ppm");
  }
  // The widening itself is bounded (×1.5).
  const big = buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ...base, elasticityMod: 3 }));
  assert.ok(big.targetPpm - 80 <= 1.5 * RAISE_STEPS * STEP);
});

// ── the profit floor: recent autopilot refills, ramped, capped ──────────────

const refill = (o: Partial<RebalanceRecord>): RebalanceRecord => ({
  at: new Date(NOW - DAY).toISOString(),
  via: "autopilot",
  targetId: "850000x1x0",
  targetAlias: "peer",
  sourceId: "850000x2x0",
  sourceAlias: "src",
  amountSats: 500_000,
  budgetPpm: 1000,
  feeSats: 450, // 900 ppm
  costPpm: 900,
  ok: true,
  ...o,
});
const routingAt70 = { f14: flow(100_000, 80_000, 6, 8), f30: flow(200_000, 160_000, 12, 16) } as const;

test("the profit floor counts only the autopilot's refills of the last 30 days — a refill 40 days old, or one run by hand at any price, sets none", () => {
  const ch = chan({ localRatio: 0.7 });
  const old = buildRecommendation(ch, ctx({ ...routingAt70, records: [refill({ at: new Date(NOW - 40 * DAY).toISOString() })] }));
  assert.equal(old.metrics.profitFloorPpm, null, "a 40-day-old refill no longer floors the fee for good");
  const manual = buildRecommendation(ch, ctx({ ...routingAt70, records: [refill({ via: "manual", feeSats: 25_000 })] }));
  assert.equal(manual.metrics.profitFloorPpm, null, "a manual 50,000 ppm refill sets no floor");
  const recent = buildRecommendation(ch, ctx({ ...routingAt70, records: [refill({})] }));
  assert.equal(recent.metrics.costBasisPpm, 900);
  assert.equal(recent.metrics.costBasisRefills, 1);
  assert.equal(recent.metrics.costBasisLatestAt, refill({}).at);
});

test("a profit floor ramps (+4 steps a move) and stops at maxPpm unless the operator opted in — one 900 ppm refill moved 80 → 1,040 in a single update", () => {
  const ch = chan({ localRatio: 0.7 });
  const r = buildRecommendation(ch, ctx({ ...routingAt70, records: [refill({})] }));
  assert.equal(r.metrics.profitFloorPpm, 1000, "900 × 1.15 = 1,035, capped at maxPpm");
  assert.equal(r.metrics.profitFloorCapped, true);
  assert.equal(r.targetPpm, 80 + RAMP_STEPS * STEP);
  assert.equal(r.aimPpm, 1000);
  assert.equal(r.state, "recovering_cost");
  assert.match(r.reasons[0], /profit floor: the autopilot's refills into it cost 900 ppm \(1 in 30 d, latest 1 d ago\) × 1\.15 = 1035 ppm — capped at your max 1000 ppm — ramping 80→120/);
  assert.equal(r.wouldApply, true);
  // Opted in: the floor may exceed maxPpm — still in ramp steps.
  const optIn = buildRecommendation(ch, ctx({ ...routingAt70, records: [refill({})], cfg: cfgOf(PRESETS.Balanced, { floorAboveMax: true }) }));
  assert.equal(optIn.metrics.profitFloorPpm, 1035);
  assert.equal(optIn.aimPpm, 1035, "the floor itself — a fee at a bound lands on it, off the grid");
  assert.equal(optIn.targetPpm, 120);
});

test("an idle channel carrying a profit floor is lowered again — it sat at 710 ppm (70% local) for good, the 30 ppm step vetoed", () => {
  const sim = simulate(chan({ localRatio: 0.7 }), ctx({ ppm: 710, records: [refill({ feeSats: 307, amountSats: 500_000 })] }), 10);
  assert.ok(sim.fees.at(-1)! < 710 - 5 * 30, sim.fees.join("→"));
});

// ── pins: exactly as set, once ──────────────────────────────────────────────

test("a pin applies exactly as set — past the threshold, the policy range, the rounding and the pacing — once, then holds", () => {
  const justChanged = { lastApplied: { "850000x1x0": new Date(NOW).toISOString() }, cooldownHours: 6 };
  const pin = (fixedPpm: number, ppm: number) =>
    buildRecommendation(chan(), ctx({ ppm, override: { mode: "fixed", fixedPpm }, cooldown: justChanged }));
  const cases: [number, number][] = [
    [290, 300], // a 10 ppm move under the 60 ppm (20%) threshold — never applied
    [60, 40], // a raise under the raise cooldown
    [0, 80], // became 25 (minPpm)
    [2000, 80], // became 1,000 (maxPpm)
    [295, 80], // rounding to the step would make it 300
  ];
  for (const [fixed, current] of cases) {
    const r = pin(fixed, current);
    assert.equal(r.targetPpm, fixed, `pin ${fixed} on ${current}`);
    assert.equal(r.wouldApply, true, `pin ${fixed} on ${current}: ${r.blockedByGuards.join()}`);
    assert.equal(r.pinned, true);
  }
  // Applied: nothing more to write.
  assert.equal(pin(290, 290).wouldApply, false);
});

// ── unserved demand (de-noised) ─────────────────────────────────────────────

const demand = (attempts: number, days: number) => ({ attempts, days, sats: attempts * 150_000, medianSats: 150_000 });

test("a channel that keeps turning real payments away is not 'idle': not lowered, not a close candidate — and the Why column says so", () => {
  const ch = chan({ localRatio: 0.2 });
  const idle = buildRecommendation(ch, ctx({ ppm: 300 }));
  assert.equal(idle.noFlowLowering, true, "without the signal: lowered as idle");
  assert.equal(idle.state, "close_candidate", "… and a close candidate (idle, weak peer)");
  const refusing = buildRecommendation(ch, ctx({ ppm: 300, demand: demand(4, 3) }));
  assert.equal(refusing.noFlowLowering, false);
  assert.ok(refusing.targetPpm >= 300, `not lowered: ${refusing.targetPpm}`);
  assert.notEqual(refusing.state, "close_candidate");
  assert.equal(refusing.metrics.peerGate, "ok");
  // 20% local: the curve raises it (it drains below its target ratio) — that
  // rule leads; the demand line says why it isn't lowered as idle (review 3:
  // it led the raise).
  assert.ok(refusing.targetPpm > 300);
  assert.match(refusing.reasons[0], /^balance: low local ratio \(20%\) — higher fee slows the drain/, refusing.reasons.join(" | "));
  assert.ok(
    refusing.reasons.includes("demand: turned away 4 payments (600,000 sat, 3 days) in 14 d for lack of outbound — probes and retries excluded; not treated as idle"),
    refusing.reasons.join(" | "),
  );
  // At its target ratio, under the balanced level, it is held — the demand is
  // what kept it from the idle channel's step down.
  const kept = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 50, demand: demand(4, 3) }));
  assert.deepEqual([kept.targetPpm, kept.noFlowLowering], [50, false]);
  assert.match(kept.reasons[0], /^demand: turned away 4 payments \(600,000 sat, 3 days\) in 14 d for lack of outbound — probes and retries excluded; not treated as idle/);
  // One refusal (a probe that got through the filter) changes nothing.
  assert.equal(buildRecommendation(ch, ctx({ ppm: 300, demand: demand(1, 1) })).noFlowLowering, true);
  // Nor do three on one day.
  assert.equal(buildRecommendation(ch, ctx({ ppm: 300, demand: demand(3, 1) })).noFlowLowering, true);
  // Drained and refusing: protected (it used to need a successful forward).
  const drained = buildRecommendation(chan({ localRatio: 0.03 }), ctx({ ppm: 80, demand: demand(5, 4) }));
  assert.equal(drained.state, "protecting_liquidity");
  assert.equal(drained.targetPpm, 80 + RAMP_STEPS * STEP);
});

test("the demand signal reaches the engine from the de-noised telemetry (getFeeRecommendations) — an idle channel turning payments away is held", async () => {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [{ id: "850000x1x0", partnerPublicKey: "02" + "11".repeat(32), capacity: 2_000_000, localBalance: 400_000, transactionId: "aa".repeat(32), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0 }],
  });
  const without = await getFeeRecommendations(node.lnd, [], null, {}, {}, new Map(), new Map(), [], { demand: new Map(), market: new Map() });
  assert.equal(without.recommendations[0].noFlowLowering, true);
  const withDemand = await getFeeRecommendations(node.lnd, [], null, {}, {}, new Map(), new Map(), [], {
    demand: new Map([["850000x1x0", demand(4, 2)]]),
    market: new Map(),
  });
  assert.equal(withDemand.recommendations[0].noFlowLowering, false);
  assert.equal(withDemand.recommendations[0].metrics.refusedAttempts14d, 4);
});

// ── the market reference (public graph) ─────────────────────────────────────

const market = (intoPeerPpm: number, peerFeeToUsPpm: number | null = null) => ({ intoPeerPpm, samples: 12, peerFeeToUsPpm });

test("an idle channel with no flow-won price jumps to what the market charges into its peer instead of stepping down blind", () => {
  const r = buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 500, market: market(100) }));
  assert.equal(r.targetPpm, 90, "0.9 × the market's 100 ppm");
  assert.match(r.reasons[0], /no flow: other nodes charge ~100 ppm into this peer — dropping to 90 ppm instead of stepping down blind/);
  assert.equal(r.metrics.marketComparison, "above");
  // A flow-won price is better evidence than the market.
  assert.equal(buildRecommendation(chan({ localRatio: 0.25 }), ctx({ ppm: 500, market: market(100), flowAnchor: 200 })).targetPpm, 200);
  // Already below the market: the ratchet steps on.
  assert.equal(buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 80, market: market(100) })).targetPpm, 80 - 3 * STEP);
});

/** Routed this month, but nothing in the last 14 days: not winning flow at its price. */
const lately = { f14: NO_FLOW, f30: flow(200_000, 160_000, 12, 16) } as const;

test("a cheaper market lowers the balanced level of a channel that isn't winning flow (nothing forwarded in 14 days) — by bounded steps, and the Why says 'market:'", () => {
  const r = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 80, market: market(40), ...lately }));
  assert.equal(r.aimPpm, 40, "0.9 × 40 = 36, on the 10-ppm grid");
  assert.equal(r.targetPpm, 80 - 3 * STEP, "one ratchet's worth per move: it still routed this month");
  assert.match(r.reasons[0], /^market: other nodes charge ~40 ppm into this peer — balanced level 80→36 ppm to compete/);
  const dearMarket = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 80, market: market(900), ...lately }));
  assert.equal(dearMarket.aimPpm, 80, "an expensive market leaves the operator's level alone");
  // Well below the node's flow (and testing a lower fee): not winning either.
  const laggard = buildRecommendation(
    chan({ localRatio: 0.7 }),
    ctx({ ppm: 80, market: market(40), ...routingAt70, enoughChannels: true, earnerCutoff: 1_000, bench: { activeChannelCount: 8, topGrossFlow14d: 1, medianGrossFlow14d: 0.3, topRevenue30d: 2_000, medianRevenue30d: 50, topRevenuePpm30d: 200, medianRevenuePpm30d: 80 } }),
  );
  assert.equal(laggard.metrics.benchmarkComparison, "below");
  assert.match(laggard.reasons[0], /^market: /);
  assert.ok(laggard.aimPpm < 40, `aim ${laggard.aimPpm}`);
});

test("a channel winning flow at its price keeps it against a cheaper market — the top earner, steady outbound demand, a channel routing in the flow window (the top earner was cut 80 → 50 while its reasons said 'holding')", () => {
  const cheap = market(30, 50);
  // (a) The node's top earner: busy and balanced — 2.4M out and in a month at 80 ppm.
  const top = buildRecommendation(
    chan(),
    ctx({
      ppm: 80,
      market: cheap,
      f14: flow(1_200_000, 1_200_000, 60, 96),
      f30: flow(2_400_000, 2_400_000, 120, 192),
      enoughChannels: true,
      earnerCutoff: 150,
      bench: { activeChannelCount: 8, topGrossFlow14d: 1.2, medianGrossFlow14d: 0.3, topRevenue30d: 192, medianRevenue30d: 20, topRevenuePpm30d: 80, medianRevenuePpm30d: 60 },
    }),
  );
  assert.equal(top.metrics.isTopEarner, true);
  assert.deepEqual([top.targetPpm, top.aimPpm, top.wouldApply], [80, 80, false], top.reasons.join(" | "));
  assert.ok(!top.reasons.some((x) => x.startsWith("market:")), top.reasons.join(" | "));
  assert.equal(top.metrics.marketComparison, "above", "the comparison is still shown");
  // (b) Steady outbound demand.
  const steady = buildRecommendation(chan(), ctx({ ppm: 80, market: cheap, f14: flow(200_000, 100_000, 8, 16), f30: flow(400_000, 300_000, 16, 32) }));
  assert.match(steady.reasons.join(" | "), /velocity: steady outbound demand/);
  assert.ok(steady.targetPpm >= 80 && steady.aimPpm >= 80, `${steady.targetPpm} (aim ${steady.aimPpm})`);
  // Simply routing in the flow window at its price.
  const routing = buildRecommendation(chan(), ctx({ ppm: 80, market: cheap, ...routingAt70 }));
  assert.deepEqual([routing.targetPpm, routing.aimPpm], [80, 80]);
  // Active and balanced, yet below a busy node's median flow: still winning at its price.
  const balancedLaggard = buildRecommendation(
    chan(),
    ctx({
      ppm: 80,
      market: cheap,
      f14: flow(250_000, 250_000, 20, 20),
      f30: flow(500_000, 500_000, 40, 40),
      enoughChannels: true,
      earnerCutoff: 1_000,
      bench: { activeChannelCount: 8, topGrossFlow14d: 1.5, medianGrossFlow14d: 0.6, topRevenue30d: 2_000, medianRevenue30d: 100, topRevenuePpm30d: 200, medianRevenuePpm30d: 80 },
    }),
  );
  assert.equal(balancedLaggard.metrics.benchmarkComparison, "below");
  assert.match(balancedLaggard.reasons.join(" | "), /velocity: active and balanced/);
  assert.equal(balancedLaggard.aimPpm, 80, balancedLaggard.reasons.join(" | "));
  // (c) An idle channel still jumps to 0.9 × the market: it wins nothing at its price.
  assert.equal(buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 500, market: market(100) })).targetPpm, 90);
  // Quiet for two weeks, yet the node's top earner this month: keeps its price.
  const quietTop = buildRecommendation(
    chan(),
    ctx({ ppm: 80, market: cheap, f30: flow(2_400_000, 2_400_000, 120, 192), enoughChannels: true, earnerCutoff: 150, bench: { activeChannelCount: 8, topGrossFlow14d: 1.2, medianGrossFlow14d: 0.3, topRevenue30d: 192, medianRevenue30d: 20, topRevenuePpm30d: 80, medianRevenuePpm30d: 60 } }),
  );
  assert.equal(quietTop.metrics.isTopEarner, true);
  assert.equal(quietTop.aimPpm, 80, quietTop.reasons.join(" | "));
  // Draining this month (its replacement cost decides), quiet for two weeks: no market cut either.
  const drained = buildRecommendation(chan(), ctx({ ppm: 80, market: cheap, f30: flow(800_000, 0, 20, 64) }));
  assert.equal(drained.metrics.draining, true);
  assert.ok(!drained.reasons.some((x) => x.startsWith("market:")), drained.reasons.join(" | "));
  assert.ok(drained.aimPpm >= 80);
});

test("(d) a draining channel whose raises measurably cost flow is not raised toward its replacement cost — held, not sold cheaper either (its reasons said 'not raising on drain' while 80 → 100, aim 350)", () => {
  const draining = { f14: flow(600_000, 100_000, 20, 48), f30: flow(1_000_000, 200_000, 40, 80) } as const;
  const r = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 80, elasticityMod: 0.85, market: market(200, 100), ...draining }));
  assert.equal(r.metrics.draining, true);
  assert.equal(r.metrics.belowReplacement, true);
  assert.deepEqual([r.targetPpm, r.aimPpm, r.wouldApply], [80, 80, false], r.reasons.join(" | "));
  assert.match(r.reasons.join(" | "), /replacement: draining, and a refill costs at least ~300 ppm .* not raising toward 345 ppm, nor selling cheaper/);
  // Without the measured elasticity: priced toward the replacement cost, gently.
  const plain = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 80, market: market(200, 100), ...draining }));
  assert.deepEqual([plain.targetPpm, plain.aimPpm], [80 + RAISE_STEPS * STEP, 350]);
  // Priced above the replacement cost already: lowered toward it, not past it.
  const dear = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 500, elasticityMod: 0.85, market: market(200, 100), ...draining }));
  assert.deepEqual([dear.targetPpm, dear.aimPpm], [500 - 3 * STEP, 350]);
  assert.match(dear.reasons[0], /^elasticity ×0\.85: /);
  assert.match(dear.reasons.join(" | "), /not sold below 345 ppm/);
});

test("the leading reason is the rule that set the move — 'replacement:' for a raise toward the replacement cost (it read 'market: … to compete'), 'balance:' for the curve alone, 'base fee:' for a base-only write", () => {
  // Draining; 40 ppm into the peer, 300 back to us: a refill costs ~340.
  const r = buildRecommendation(chan({ localRatio: 0.55 }), ctx({ ppm: 80, market: market(40, 300), f14: flow(300_000, 50_000, 10, 24), f30: flow(600_000, 100_000, 20, 48) }));
  assert.deepEqual([r.targetPpm, r.aimPpm], [100, 390]);
  assert.match(r.reasons[0], /^replacement: draining, and a refill costs at least ~340 ppm \(others charge ~40 into the peer, it charges 300 back to you\) — pricing toward 391 ppm/);
  assert.ok(!r.reasons.some((x) => x.startsWith("market:")), "a channel winning flow: no market lowering at all");
  assert.ok(r.reasons.some((x) => x.startsWith("guard: raising at most 20 ppm per move — 80→100 on the way to 390 ppm")));
  // The balance curve alone, down and up, on channels that route.
  assert.match(buildRecommendation(chan({ localRatio: 0.9 }), ctx({ ppm: 300, ...routingAt70 })).reasons[0], /^balance: high local ratio \(90%\) — lower fee invites flow/);
  assert.match(buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ppm: 80, ...routingAt70 })).reasons[0], /^balance: low local ratio \(30%\) — higher fee slows the drain/);
  // Only the base fee changes: that is what the write is about (not the velocity note).
  const base = buildRecommendation(chan(), ctx({ ppm: 80, baseMsat: 1000, f14: flow(200_000, 100_000, 8, 16), f30: flow(400_000, 300_000, 16, 32) }));
  assert.deepEqual([base.targetPpm, base.wouldApply], [80, true]);
  assert.match(base.reasons[0], /^base fee: lowering 1000→0 msat to win routes/);
  assert.ok(base.reasons.some((x) => x.startsWith("velocity: steady outbound demand")), base.reasons.join(" | "));
  // A drained channel above protectPpm walking down the curve (~900) is not
  // being "bumped": the curve leads, protect is a note.
  const walking = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 990, ...routingAt70 }));
  assert.equal(walking.targetPpm, 990 - 3 * STEP);
  assert.equal(walking.state, "protecting_liquidity");
  assert.match(walking.reasons[0], /^balance: 5% local \(target 50%\) — the balance curve puts it at ~900 ppm/, walking.reasons.join(" | "));
  assert.ok(walking.reasons.some((x) => x.startsWith("protect: drained (5% local) but still in demand — kept at 350 ppm or more")));
  // A floor below the current fee only stops a lowering short of it: the
  // lowering's own rule leads ("profit floor" / "protect: … modest bump" led
  // moves down).
  const stoppedAtFloor = buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ppm: 1200, cfg: cfgOf(PRESETS.Balanced, { maxPpm: 1500 }), ...routingAt70, records: [refill({})] }));
  assert.equal(stoppedAtFloor.targetPpm, 1200 - 3 * STEP);
  assert.match(stoppedAtFloor.reasons[0], /^balance: high local ratio \(70%\)/, stoppedAtFloor.reasons.join(" | "));
  assert.ok(stoppedAtFloor.reasons.some((x) => /^profit floor: .* = 1035 ppm — not lowered below it$/.test(x)), stoppedAtFloor.reasons.join(" | "));
  const stoppedAtProtect = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 700, elasticityMod: 0.75, cfg: cfgOf(PRESETS.Balanced, { protectPpm: 690 }), ...routingAt70 }));
  assert.equal(stoppedAtProtect.targetPpm, 690);
  assert.match(stoppedAtProtect.reasons[0], /^elasticity ×0\.75: /, stoppedAtProtect.reasons.join(" | "));
  assert.ok(stoppedAtProtect.reasons.some((x) => x.startsWith("protect: drained (5% local) but still in demand — kept at 690 ppm or more")));
  // A fee above the policy's max: the range is the reason, not a step guard.
  const above = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 990, cfg: cfgOf(PRESETS.Balanced, { maxPpm: 600 }), ...routingAt70 }));
  assert.equal(above.targetPpm, 600);
  assert.match(above.reasons[0], /^range: 990 ppm is above your max of 600 ppm — brought down to it at once/);
  assert.ok(!above.reasons.some((x) => x.startsWith("guard: lowering")), above.reasons.join(" | "));
});

// ── every lowering is bounded, bar evidence ─────────────────────────────────

test("every preset: an idle channel steps down at most one ratchet per move — the curve or the explore price no longer cut it 1,500 → 900 (or 500 → 30) in one update", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const lower = (p.noFlowRatchetSteps ?? 3) * STEP;
    for (const [ratio, from] of [[0.2, 1500], [0.12, 1500], [0.9, 500], [0.6, 400]] as const) {
      const sim = simulate(chan({ localRatio: ratio }), ctx({ cfg: cfgOf(p, { maxPpm: 1500 }), ppm: from }), 30);
      assert.ok(sim.moves.length >= 2, `${name} @${ratio} from ${from}: ${sim.fees.join("→")}`);
      for (const m of sim.moves) assert.ok(m < 0 && -m <= lower, `${name} @${ratio} from ${from}: a move of ${m} — ${sim.fees.slice(0, 6).join("→")}`);
    }
  }
  // A brand-new channel (no forwards yet, 90% ours) is lowered by steps too —
  // for the curve's reason (the new-channel floor only stops it at 80).
  const fresh = buildRecommendation(chan({ id: `${HEIGHT - 144}x1x0`, localRatio: 0.9 }), ctx({ ppm: 1000 }));
  assert.equal(fresh.targetPpm, 1000 - 3 * STEP);
  assert.match(fresh.reasons[0], /^balance: high local ratio \(90%\) — lower fee invites flow/, fresh.reasons.join(" | "));
  // What does move at once: the jump to the price that won flow back, or to
  // the market's — exactly that price, not whatever the curve says below it.
  const anchored = buildRecommendation(chan({ localRatio: 0.9 }), ctx({ ppm: 500, flowAnchor: 200 }));
  assert.equal(anchored.targetPpm, 200, "the curve wants ~30 at 90% local: before, the 'dropping to 200 ppm' jump landed there");
  assert.match(anchored.reasons[0], /^no flow: dropping to 200 ppm — the last price that won routing back here/);
  assert.equal(buildRecommendation(chan({ localRatio: 0.9 }), ctx({ ppm: 500, market: market(100) })).targetPpm, 90);
  // A fee above the policy's max is brought into it at once — idle or not.
  assert.equal(buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 3000, ...routingAt70 })).targetPpm, 1000);
  const idleAbove = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 3000 }));
  assert.equal(idleAbove.targetPpm, 1000);
  assert.match(idleAbove.reasons[0], /^range: 3000 ppm is above your max of 1000 ppm/);
});

test("a drained idle channel is lowered by steps too (the curve × a measured elasticity cut 1,500 → 800 in one update), and rounding never stretches, reverses or invents a move", () => {
  const drainedIdle = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 900, elasticityMod: 0.8 }));
  assert.equal(drainedIdle.targetPpm, 900 - 3 * STEP, drainedIdle.reasons.join(" | "));
  // A ratchet step off the grid (333 ppm, Max profit: one step of 10) stays one step.
  assert.equal(buildRecommendation(chan({ localRatio: 0.5 }), ctx({ cfg: cfgOf(PRESETS["Max profit"]), ppm: 333 })).targetPpm, 323);
  const coarse = cfgOf(PRESETS.Balanced, { stepPpm: 25 });
  // A hold holds: 333 is not "rounded" to 325.
  const held = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ cfg: coarse, ppm: 333 }));
  assert.deepEqual([held.targetPpm, held.wouldApply], [333, false]);
  // "Dropping to 90 ppm" from 95 on a 25-ppm grid is not written as 100.
  const drop = buildRecommendation(chan({ localRatio: 0.75 }), ctx({ cfg: coarse, ppm: 95, market: market(100) }));
  assert.ok(drop.targetPpm <= 95, `${drop.targetPpm}: ${drop.reasons.join(" | ")}`);
  // At the min (25) on a 10-ppm grid: no move made up by rounding.
  assert.equal(buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 25 })).targetPpm, 25);
  // A fee below the min (0 ppm) is brought up to it — not to the balanced level, and not as "lowering".
  const free = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 0 }));
  assert.equal(free.targetPpm, 25, "exactly the min: rounding 25 to the 10-ppm grid (30) stopped every walk down 5 ppm short of it");
  assert.match(free.reasons[0], /^range: 0 ppm is below your min of 25 ppm — brought up to it at once/);
});

test("below its flow-won price an idle channel steps down slowly again — the market is no reason to jump (demand may have moved)", () => {
  const r = buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 150, market: market(100), flowAnchor: 200 }));
  assert.equal(r.targetPpm, 150 - 3 * STEP, "not the market's 90");
  assert.match(r.reasons[0], /^no flow: nothing routed here recently — lowering toward min/);
});

test("a channel turning real payments away with no forward in 30 days is lowered only by bounded steps of the curve — never the idle jump or the explore cut — and the curve says why", () => {
  // 60% local at 400 ppm: the curve wants ~70 ppm.
  const r = buildRecommendation(chan({ localRatio: 0.6 }), ctx({ ppm: 400, demand: demand(4, 3), market: market(40) }));
  assert.equal(r.targetPpm, 400 - 3 * STEP, `a bounded step, not the curve's 70 or the market's 36: ${r.reasons.join(" | ")}`);
  assert.equal(r.aimPpm, 70, "the operator's balanced level, not the market's");
  assert.equal(r.noFlowLowering, false);
  assert.notEqual(r.state, "exploring_lower_fee");
  assert.match(r.reasons[0], /^balance: high local ratio \(60%\) — lower fee invites flow/);
  assert.ok(r.reasons.some((x) => /^demand: turned away 4 payments .*; not treated as idle$/.test(x)), r.reasons.join(" | "));
  assert.ok(!r.reasons.some((x) => x.startsWith("market:")), "a channel turning payments away keeps the operator's balanced level");
  // 80% local: an idle channel there gets the explore test (×0.85); one
  // turning payments away does not — the curve's own aim, ~49 → 50.
  const over = buildRecommendation(chan({ localRatio: 0.8 }), ctx({ ppm: 400, demand: demand(4, 3) }));
  assert.ok(!over.reasons.some((x) => x.startsWith("idle test:")), over.reasons.join(" | "));
  assert.equal(over.aimPpm, 50);
  assert.equal(over.state, "normal");
});

test("a draining channel is priced toward what replacing its outbound costs — gently — and flagged while it is sold below that", () => {
  const draining = { f14: flow(300_000, 50_000, 10, 24), f30: flow(600_000, 100_000, 20, 48) } as const;
  const r = buildRecommendation(chan({ localRatio: 0.55 }), ctx({ ppm: 80, market: market(300, 100), ...draining }));
  assert.equal(r.metrics.replacementCostPpm, 400, "one hop into the peer + its hop back to us");
  assert.equal(r.metrics.belowReplacement, true);
  assert.equal(r.metrics.draining, true);
  assert.equal(r.aimPpm, 460, "400 × 1.15");
  assert.equal(r.targetPpm, 80 + RAISE_STEPS * STEP, "one gentle step at a time");
  assert.ok(r.reasons.some((x) => /^replacement: draining, and a refill costs at least ~400 ppm \(others charge ~300 into the peer, it charges 100 back to you\) — pricing toward 460 ppm/.test(x)));
  // A two-way channel keeps its volume-first price.
  const twoWay = buildRecommendation(chan({ localRatio: 0.5 }), ctx({ ppm: 80, market: market(300, 100), ...routingAt70 }));
  assert.equal(twoWay.metrics.draining, false);
  assert.equal(twoWay.aimPpm, 80);
});

// ── the lease promise (D7) still wins over every rule that can raise a fee ──

const leaseCap = (feeRateCapPpm = 2200): LeaseCap & { untilHeight: number | null } => ({
  fundingOutpoint: `${"aa".repeat(32)}:0`,
  source: "magma",
  orderId: "order-1",
  feeRateCapPpm,
  baseFeeCapMsat: 1000,
  leaseBlocks: 4320,
  untilHeight: HEIGHT + 1000,
});

test("K2 (P1b carry-over): a pinned channel above its promise — cap 2,200, at 2,210, pinned at 3,000 — is lowered to 2,200 at once", () => {
  const r = buildRecommendation(chan(), ctx({ ppm: 2210, override: { mode: "fixed", fixedPpm: 3000 }, leaseCap: leaseCap(), cfg: cfgOf(PRESETS.Balanced, { maxPpm: 6000 }) }));
  assert.equal(r.leaseCapBreach, true);
  assert.equal(r.targetPpm, 2200);
  assert.equal(r.wouldApply, true, r.blockedByGuards.join());
});

test("K2b: a 10 ppm breach on a channel the engine manages is fixed past the anti-churn threshold (the '&& !leaseCapBreach' guard)", () => {
  // Drained and idle (held at its fee), at 2,210 against a 2,200 promise:
  // the move is 10 ppm, far under the threshold (max(25, 20% of 2,210)).
  const r = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 2210, leaseCap: leaseCap(), cfg: cfgOf(PRESETS.Balanced, { maxPpm: 6000 }) }));
  assert.equal(r.leaseCapBreach, true);
  assert.equal(r.targetPpm, 2200);
  assert.equal(r.wouldApply, true, r.blockedByGuards.join());
});

test("every rule this package added or changed that can raise a fee loses to the lease promise", () => {
  const cap = leaseCap(2200);
  const near = 2190; // one more step of any rule crosses the cap
  const wide = cfgOf(PRESETS.Balanced, { maxPpm: 6000, protectPpm: 4000, floorAboveMax: true });
  const draining = { f14: flow(300_000, 50_000, 10, 24), f30: flow(600_000, 100_000, 20, 48) } as const;
  const cases: [string, Partial<BuildCtx> & { ppm?: number }, FeeChannel][] = [
    ["raise step widened by elasticity", { ppm: near, cfg: wide, elasticityMod: 1.25, ...draining }, chan({ localRatio: 0.3 })],
    ["protect ramp", { ppm: near, cfg: wide, f30: flow(300_000, 0, 10) }, chan({ localRatio: 0.05 })],
    ["protect ramp of a channel turning payments away", { ppm: near, cfg: wide, demand: demand(5, 3) }, chan({ localRatio: 0.05 })],
    ["profit floor ramp (opted in above max)", { ppm: near, cfg: wide, records: [refill({ feeSats: 2_500 })], ...routingAt70 }, chan({ localRatio: 0.7 })],
    ["replacement cost of a draining channel", { ppm: near, cfg: wide, market: market(5000, 500), ...draining }, chan({ localRatio: 0.55 })],
    ["pin", { ppm: near, cfg: wide, override: { mode: "fixed", fixedPpm: 5000 } }, chan()],
    // A fee below the policy's min is brought up to it (review 2: up to the
    // min first, then by steps) — a min above the promise loses to it too.
    ["the range lifting a fee below the min", { ppm: near, cfg: cfgOf(PRESETS.Balanced, { maxPpm: 6000, minPpm: 2300, neutralPpm: 2400 }), ...routingAt70 }, chan()],
  ];
  for (const [what, c, ch] of cases) {
    const without = buildRecommendation(ch, ctx(c));
    assert.ok(without.targetPpm > 2200, `${what}: the rule alone lifts the fee past the cap (${without.targetPpm})`);
    const kept = buildRecommendation(ch, ctx({ ...c, leaseCap: cap }));
    assert.ok(kept.targetPpm <= 2200 && kept.aimPpm <= 2200, `${what}: ${kept.targetPpm} (aim ${kept.aimPpm})`);
  }
});

test("getFeeRecommendations orders the per-run limit: broken promises, then pins, then the biggest moves", async () => {
  const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
  const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [
      // A big engine move: idle at 40% local, 900 ppm → the market jump to 90.
      { id: "850000x1x0", partnerPublicKey: PEER(1), capacity: 2_000_000, localBalance: 800_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 900, baseFeeMsat: 0 },
      // A pin of a small move.
      { id: "850000x2x0", partnerPublicKey: PEER(2), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
    ],
    forwards: forwardsOut("850000x2x0", "850000x1x0", 5),
  });
  const report = await getFeeRecommendations(
    node.lnd,
    [],
    null,
    { maxChangesPerRun: 1 },
    { "850000x2x0": { mode: "fixed", fixedPpm: 110 } },
    new Map(),
    new Map(),
    [],
    { demand: new Map(), market: new Map([["850000x1x0", market(100)]]) },
  );
  const by = (id: string) => report.recommendations.find((r) => r.channelId === id)!;
  assert.equal(by("850000x2x0").wouldApply, true, "the operator's pin first");
  assert.deepEqual(by("850000x1x0").blockedByGuards, ["max changes per run reached"]);
});

test("the report says how many channels the elasticity learner has evidence for — none on most nodes, and the page says so instead of implying per-channel learning", async () => {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [{ id: "850000x1x0", partnerPublicKey: "02" + "11".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "aa".repeat(32), transactionVout: 0, feeRatePpm: 100 }],
  });
  const none = await getFeeRecommendations(node.lnd, [], null, {}, {}, new Map(), new Map(), [], { demand: new Map(), market: new Map() });
  assert.equal(none.elasticityLearned, 0);
  const one = await getFeeRecommendations(node.lnd, [], null, {}, {}, new Map([["850000x1x0", 1.1]]), new Map(), [], { demand: new Map(), market: new Map() });
  assert.equal(one.elasticityLearned, 1);
});

// ── a price that wins flow is kept; the engine's own moves are not vetoed (review 2) ──

test("the no-flow rule's own moves are not vetoed by the threshold: idle at 70 with a flow-won price of 50 drops to 50, at 60 with a market of 40 to 40, at 50 with nothing known to the min (25)", () => {
  // Before: each was 'change below threshold' (within 25 ppm of where it was
  // heading) while the Why said "dropping to 50 ppm".
  const anchored = buildRecommendation(chan(), ctx({ ppm: 70, flowAnchor: 50 }));
  assert.deepEqual([anchored.targetPpm, anchored.wouldApply, anchored.blockedByGuards], [50, true, []]);
  assert.match(anchored.reasons[0], /^no flow: dropping to 50 ppm — the last price that won routing back here/);
  const market40 = buildRecommendation(chan(), ctx({ ppm: 60, market: market(40) }));
  assert.deepEqual([market40.targetPpm, market40.wouldApply], [40, true], "0.9 × 40 = 36, on the 10-ppm grid");
  const blind = buildRecommendation(chan(), ctx({ ppm: 50 }));
  assert.deepEqual([blind.targetPpm, blind.wouldApply], [25, true], "one ratchet step, landing on the min itself");
  // Paced all the same: a lowering at most once a day.
  const justLowered = { lastApplied: { "850000x1x0": new Date(NOW - 3_600_000).toISOString() }, cooldownHours: 6 };
  assert.deepEqual(buildRecommendation(chan(), ctx({ ppm: 70, flowAnchor: 50, cooldown: justLowered })).blockedByGuards, ["lower pacing (1/day)"]);
  // An idle channel already AT the market's price (40 against 0.9 × 40 = 36 →
  // 40 on the grid) steps on below it — before, the jump to 36 rounded back
  // to 40 every day and it never moved again.
  const atMarket = buildRecommendation(chan(), ctx({ ppm: 40, market: market(40) }));
  assert.deepEqual([atMarket.targetPpm, atMarket.wouldApply], [25, true]);
  assert.match(atMarket.reasons[0], /^no flow: nothing routed here recently/);
});

test("a channel routing at its price is held there — the balance curve no longer raises it out of the price that won it flow; only a drain signal raises it", () => {
  // Two-way at 50 ppm, 50% local: the curve's balanced level is 80.
  const twoWay = { f14: flow(700_000, 700_000, 14, 35), f30: flow(1_400_000, 1_400_000, 28, 70) } as const;
  const held = buildRecommendation(chan(), ctx({ ppm: 50, ...twoWay }));
  // Before: 50 → 70 ("balance: … the balance curve puts it at ~80 ppm") —
  // priced out, then lowered again once nothing had routed for two weeks.
  assert.deepEqual([held.targetPpm, held.aimPpm, held.wouldApply], [50, 50, false]);
  assert.match(held.reasons[0], /^hold: it routes at 50 ppm \(14 forwards in 14 d\) and nothing says it drains — not raised toward the balance curve's ~80 ppm/);
  // Above its target ratio too (70% local: the curve says ~60).
  assert.equal(buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ppm: 40, ...twoWay })).targetPpm, 40);
  // Drain signals still raise it: below its target ratio (the curve slowing
  // a drain) …
  const drained = buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ppm: 50, ...twoWay }));
  assert.equal(drained.targetPpm, 50 + RAISE_STEPS * STEP);
  assert.match(drained.reasons[0], /^balance: low local ratio \(30%\) — higher fee slows the drain/);
  // … steady outbound demand …
  const steady = buildRecommendation(chan(), ctx({ ppm: 50, f14: flow(200_000, 100_000, 8, 10), f30: flow(400_000, 300_000, 16, 20) }));
  assert.equal(steady.targetPpm, 50 + RAISE_STEPS * STEP, steady.reasons.join(" | "));
  assert.match(steady.reasons[0], /^velocity: steady outbound demand/);
  // … a channel draining this month (its replacement cost decides), though
  // its last two weeks were two-way …
  const month = { f14: flow(300_000, 300_000, 12, 15), f30: flow(900_000, 300_000, 24, 45) } as const;
  const drainingMonth = buildRecommendation(chan(), ctx({ ppm: 50, market: market(200, 100), ...month }));
  assert.equal(drainingMonth.metrics.draining, true);
  assert.equal(drainingMonth.targetPpm, 50 + RAISE_STEPS * STEP, drainingMonth.reasons.join(" | "));
  assert.match(drainingMonth.reasons[0], /^replacement: draining/);
  // (without a market reference too: then the curve raises it)
  const drainingBlind = buildRecommendation(chan(), ctx({ ppm: 50, ...month }));
  assert.deepEqual([drainingBlind.targetPpm, drainingBlind.aimPpm], [50 + RAISE_STEPS * STEP, 80], drainingBlind.reasons.join(" | "));
  // … unless raising measurably cost flow here: then draining raises nothing
  // — the replacement cost doesn't, and neither does the curve (its reasons
  // said "not raising toward 345 ppm" while the curve took it 50 → 70).
  const measured = buildRecommendation(chan(), ctx({ ppm: 50, elasticityMod: 0.85, market: market(200, 100), ...month }));
  assert.deepEqual([measured.targetPpm, measured.aimPpm, measured.wouldApply], [50, 50, false], measured.reasons.join(" | "));
  assert.ok(measured.reasons.some((x) => /^replacement: draining, .* not raising toward 345 ppm, nor selling cheaper/.test(x)), measured.reasons.join(" | "));
  assert.match(measured.reasons[0], /^hold: draining, but higher fees cost flow here before — not raised toward the balance curve's ~70 ppm/);
  // … and a floor (protect a drained channel still in demand).
  assert.equal(buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 50, ...twoWay })).targetPpm, 50 + RAMP_STEPS * STEP);
  // Where raising measurably cost flow, the drain reflex is off ("not raising
  // on drain") — the benchmark's draining nudge doesn't raise it either.
  const busyNode = { enoughChannels: true, earnerCutoff: 10_000, bench: { activeChannelCount: 8, topGrossFlow14d: 0.5, medianGrossFlow14d: 0.1, topRevenue30d: 20_000, medianRevenue30d: 50, topRevenuePpm30d: 200, medianRevenuePpm30d: 80 } } as const;
  const gated = buildRecommendation(chan(), ctx({ ppm: 50, elasticityMod: 0.85, f14: flow(600_000, 100_000, 20, 30), f30: flow(700_000, 600_000, 30, 35), ...busyNode }));
  assert.ok(gated.reasons.some((x) => x.startsWith("benchmark: outperforms node average and draining")), gated.reasons.join(" | "));
  assert.ok(gated.reasons.some((x) => x.startsWith("elasticity: raising lost revenue here before — not raising on drain")));
  assert.deepEqual([gated.targetPpm, gated.wouldApply], [50, false], gated.reasons.join(" | "));
  // A lower aim still applies: over its target ratio the curve lowers a fee above it.
  assert.equal(buildRecommendation(chan({ localRatio: 0.9 }), ctx({ ppm: 300, ...twoWay })).targetPpm, 300 - 3 * STEP);
});

test("a market-priced channel that routes nothing is not raised back toward the balanced level when a report lacks the market (it flapped 80→50→70→40… on alternate runs)", () => {
  // Routed this month, nothing in 14 days, priced at 0.9 × the market (30 → 27, ~30).
  const withMarket = buildRecommendation(chan(), ctx({ ppm: 30, market: market(30), ...lately }));
  assert.equal(withMarket.wouldApply, false);
  const without = buildRecommendation(chan(), ctx({ ppm: 30, ...lately }));
  assert.deepEqual([without.targetPpm, without.aimPpm, without.wouldApply], [30, 30, false], without.reasons.join(" | "));
  assert.match(without.reasons[0], /^hold: not below its target ratio and nothing says it drains — not raised toward the balance curve's ~80 ppm \(a higher fee wins no flow back\)/);
});

/**
 * The engine on its 30-minute loop against fee-dependent demand (review 2):
 * one forward pair a day (50,000 out, 50,000 in — a balanced channel) while
 * the fee is at most `winPpm`, none above it. The last forward at the old
 * price was `quietDays` ago. The autopilot's flow-won bookkeeping is mirrored
 * (noteFlowReturns): a no-flow lowering opens an episode, and the fee at
 * which flow returns becomes the anchor.
 */
function closedLoop(cfg: FeeRecConfig, localRatio: number, o: { winPpm: number; market: number | null; startPpm: number; quietDays: number; days: number }) {
  const ch = chan({ localRatio });
  const routed: number[] = [];
  for (let d = 29; d >= o.quietDays; d--) routed.push(NOW - d * DAY);
  const lastApplied: Record<string, string> = {};
  let fee = o.startPpm;
  let anchor: number | undefined;
  let episodeAt: number | null = null;
  let firstWinDay: number | null = null;
  const moves: { day: number; from: number; to: number }[] = [];
  let pricedOutAfterWin = 0;
  for (let i = 0, day = -1; i < o.days * 48; i++) {
    const nowMs = NOW + i * 30 * 60_000;
    if (Math.floor(i / 48) !== day) {
      day = Math.floor(i / 48);
      if (fee <= o.winPpm) {
        routed.push(nowMs);
        firstWinDay ??= day;
      }
    }
    if (firstWinDay !== null && fee > o.winPpm) pricedOutAfterWin += 1;
    const window = (days: number): Flow => {
      const n = routed.filter((t) => t > nowMs - days * DAY && t <= nowMs).length;
      return flow(n * 50_000, n * 50_000, n, Math.round((n * 50_000 * fee) / 1e6));
    };
    const f14 = window(14);
    if (episodeAt !== null && f14.out > 0 && routed.some((t) => t >= episodeAt!)) {
      anchor = fee;
      episodeAt = null;
    }
    const r = buildRecommendation(ch, {
      ...ctx({ cfg, ppm: fee, f14, f30: window(30), flowAnchor: anchor, market: o.market == null ? undefined : market(o.market) }),
      cooldown: { lastApplied, cooldownHours: 6 },
      nowMs,
    });
    if (r.wouldApply) {
      moves.push({ day: i / 48, from: fee, to: r.targetPpm });
      fee = r.targetPpm;
      lastApplied[ch.id] = new Date(nowMs).toISOString();
      if (r.noFlowLowering) episodeAt = nowMs;
    }
  }
  return { moves, firstWinDay, pricedOutAfterWin };
}

test("closed loop, every preset, 120 days of demand that depends on the fee: once a channel routes at a price, the curve never raises it past that price, and the fee stops moving (before: raised out of it in 168 of 288 runs, priced out 83–86 % of the time)", () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const cfg = cfgOf(p);
    const lower = (p.noFlowRatchetSteps ?? 3) * STEP;
    for (const localRatio of [0.45, 0.55, 0.7]) {
      for (const winPpm of [p.minPpm! + 10, Math.round((p.minPpm! + p.neutralPpm!) / 2)]) {
        for (const mk of [null, winPpm]) {
          for (const startPpm of [p.neutralPpm!, 2 * p.neutralPpm!]) {
            for (const quietDays of [15, 31]) {
              const what = `${name} @${localRatio}, wins at ≤${winPpm}, market ${mk}, from ${startPpm}, quiet ${quietDays} d`;
              const { moves, firstWinDay, pricedOutAfterWin } = closedLoop(cfg, localRatio, { winPpm, market: mk, startPpm, quietDays, days: 120 });
              const trace = moves.map((m) => `d${m.day.toFixed(1)} ${m.from}→${m.to}`).join(", ");
              assert.ok(firstWinDay !== null, `${what}: never found the price — ${trace}`);
              const after = moves.filter((m) => m.day >= firstWinDay!);
              assert.ok(after.every((m) => m.to <= winPpm), `${what}: raised past the price that won flow — ${trace}`);
              assert.equal(pricedOutAfterWin, 0, `${what}: priced out after winning — ${trace}`);
              assert.ok(after.length <= 1, `${what}: ${after.length} changes after it routed — ${trace}`);
              // Getting there: bounded steps down, nothing back and forth.
              assert.ok(moves.length <= Math.ceil(Math.max(0, startPpm - winPpm) / lower) + 3, `${what}: ${moves.length} changes — ${trace}`);
            }
          }
        }
      }
    }
  }
});

test("a channel in the explore test is not winning flow at its price — the market lowers its balanced level although it forwarded in the flow window", () => {
  // 80% local, two small forwards in 14 days (under 1% of its capacity):
  // idle outbound liquidity, testing a lower fee.
  const trickle = { f14: flow(5_000, 5_000, 2, 1), f30: flow(5_000, 5_000, 2, 1) } as const;
  const r = buildRecommendation(chan({ localRatio: 0.8 }), ctx({ ppm: 80, market: market(40), ...trickle }));
  assert.equal(r.state, "exploring_lower_fee");
  assert.match(r.reasons[0], /^market: other nodes charge ~40 ppm into this peer — balanced level 80→36 ppm to compete/, r.reasons.join(" | "));
  // The curve from the operator's 80 would aim at ~40 (× 0.85); from the market's 36, at ~30.
  assert.equal(r.aimPpm, 30);
  assert.equal(buildRecommendation(chan({ localRatio: 0.8 }), ctx({ ppm: 80, ...trickle })).aimPpm, 40);
});

test("the policy range: a fee outside min/max is brought into it even when that is a small move (no anti-churn veto), lands on the bound itself, and a fee below the min goes only to the min — raises step on from there", () => {
  const twoWay = { f14: flow(700_000, 700_000, 14, 35), f30: flow(1_400_000, 1_400_000, 28, 70) } as const;
  // 6 ppm above a max of 1,004 (off the 10-ppm grid), a profit floor (capped
  // at the max) holding it there: a 6 ppm move, far under the threshold (20%
  // of 1,010) — the range is the operator's, it applies, onto the max itself.
  const tight = cfgOf(PRESETS.Balanced, { maxPpm: 1004 });
  const above = buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ppm: 1010, cfg: tight, ...routingAt70, records: [refill({})] }));
  assert.deepEqual([above.targetPpm, above.wouldApply], [1004, true], above.blockedByGuards.join());
  assert.match(above.reasons[0], /^range: 1010 ppm is above your max of 1004 ppm — brought down to it at once/);
  // A rule that takes it further down (the curve's step, 1,010 → 980) applies
  // too — out of the range, no move back into it is "below threshold".
  const lower = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 1010, cfg: tight, ...twoWay }));
  assert.deepEqual([lower.targetPpm, lower.wouldApply], [980, true], lower.blockedByGuards.join());
  // 5 ppm below the min: up to it, past the threshold too.
  const below = buildRecommendation(chan(), ctx({ ppm: 20, ...twoWay }));
  assert.deepEqual([below.targetPpm, below.wouldApply], [25, true], below.blockedByGuards.join());
  assert.match(below.reasons[0], /^range: 20 ppm is below your min of 25 ppm — brought up to it at once, raised from there by steps/);
  assert.ok(!below.reasons.some((x) => x.startsWith("hold:")), `going up, it isn't "not raised": ${below.reasons.join(" | ")}`);
  // A drained channel the curve raises: to the min first (not 10 + 20 = 30) …
  const drainedLow = buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ppm: 10, ...twoWay }));
  assert.equal(drainedLow.targetPpm, 25);
  // … and a fee of 0 under a floor: to the min, the floor's ramp says so.
  const floored = buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ppm: 0, ...routingAt70, records: [refill({})] }));
  assert.equal(floored.targetPpm, 25);
  assert.match(floored.reasons[0], /^range: 0 ppm is below your min/);
  assert.ok(floored.reasons.some((x) => /^profit floor: .* — ramping 0→25$/.test(x)), floored.reasons.join(" | "));
  // Only the new-channel floor lifts a fee past the min at once — also on a
  // channel the peer just opened (20% ours: the curve wants ~600), where a
  // raise counted from the balanced level (80 + 20) outran the floor and the
  // fee went to the min instead.
  for (const localRatio of [0.9, 0.2]) {
    const fresh = buildRecommendation(chan({ id: `${HEIGHT - 144}x1x0`, localRatio }), ctx({ ppm: 0 }));
    assert.equal(fresh.targetPpm, 80, `${localRatio}: ${fresh.reasons.join(" | ")}`);
    assert.match(fresh.reasons[0], /^new channel: /);
  }
});

test("a jump to the flow-won price lands exactly on it, off the 'Round to' grid or not", () => {
  for (const anchor of [274, 275]) {
    const r = buildRecommendation(chan({ localRatio: 0.6 }), ctx({ ppm: 500, flowAnchor: anchor }));
    assert.deepEqual([r.targetPpm, r.wouldApply], [anchor, true], `anchor ${anchor}`);
  }
});

test("a profit floor leads only when its ramp is the move — a new channel lifted to its protected fee says so, not 'profit floor … ramping 45→49'", () => {
  // Two hours old, one forward, an expensive refill on record (900 ppm).
  const id = `${HEIGHT - 12}x1x0`;
  const r = buildRecommendation(
    chan({ id, localRatio: 0.55 }),
    ctx({ cfg: cfgOf(PRESETS["Max routing"], { stepPpm: 1 }), ppm: 45, f14: flow(10_000, 0, 1, 1), f30: flow(10_000, 0, 1, 1), records: [refill({ targetId: id })] }),
  );
  assert.equal(r.targetPpm, 80);
  assert.match(r.reasons[0], /^new channel: /, r.reasons.join(" | "));
  const floor = r.reasons.find((x) => x.startsWith("profit floor:")) ?? "";
  assert.match(floor, /= 945 ppm$/, "a note: neither 'ramping' nor 'not lowered below it'");
});

// ── review 3: a missing market reference never lowers a draining channel ──

/** A draining sink at 50% local (10 forwards out in 14 days, 30% of its
 *  capacity net out in 30): 200 ppm into its peer + 100 back = a refill costs
 *  ~300, × 1.15 = 345 — the probe of review 3. */
const sinkDraining = { f14: flow(300_000, 50_000, 10, 60), f30: flow(700_000, 100_000, 22, 140) } as const;
const sink = (o: Partial<FeeChannel> = {}) => chan({ role: "sink", ...o });

test("a draining channel priced at its refill cost is not lowered by a report without the market reference — held, and the Why says so (one such run lowered it 340 → 310 toward the balanced level)", () => {
  const withRef = buildRecommendation(sink(), ctx({ ppm: 340, market: market(200, 100), ...sinkDraining }));
  assert.equal(withRef.wouldApply, false, withRef.reasons.join(" | "));
  const without = buildRecommendation(sink(), ctx({ ppm: 340, ...sinkDraining }));
  assert.deepEqual([without.targetPpm, without.aimPpm, without.wouldApply], [340, 340, false], without.reasons.join(" | "));
  assert.match(without.reasons[0], /^hold: draining — no market reference for its refill cost this run, so it is not lowered toward the balance curve's ~80 ppm/);
  // Below its target ratio and priced above the curve's level too (900 at
  // 25% local: the curve says ~510).
  const drainedDear = buildRecommendation(chan({ localRatio: 0.25 }), ctx({ ppm: 900, f14: flow(300_000, 50_000, 6, 240), f30: flow(600_000, 100_000, 12, 480) }));
  assert.deepEqual([drainedDear.targetPpm, drainedDear.wouldApply], [900, false], drainedDear.reasons.join(" | "));
  // A higher aim still raises it (the curve below its target ratio) …
  const low = buildRecommendation(chan({ localRatio: 0.25 }), ctx({ ppm: 100, f14: flow(300_000, 50_000, 6, 30), f30: flow(600_000, 100_000, 12, 60) }));
  assert.equal(low.targetPpm, 100 + RAISE_STEPS * STEP);
  // … and the range rule and a lease promise still lower it.
  const aboveMax = buildRecommendation(sink(), ctx({ ppm: 1200, ...sinkDraining }));
  assert.equal(aboveMax.targetPpm, 1000);
  assert.match(aboveMax.reasons[0], /^range: 1200 ppm is above your max of 1000 ppm/);
  assert.ok(!aboveMax.reasons.some((x) => x.startsWith("hold:")), aboveMax.reasons.join(" | "));
  const sold = buildRecommendation(sink(), ctx({ ppm: 900, leaseCap: leaseCap(500), ...sinkDraining }));
  assert.deepEqual([sold.targetPpm, sold.leaseCapBreach], [500, true]);
  assert.ok(!sold.reasons.some((x) => x.startsWith("hold:")), sold.reasons.join(" | "));
});

test("90 days on the 30-minute loop with the market reference missing now and then: a draining channel at its refill cost is never lowered, and one below it only ever rises (gaps every 1–4 days walked it 340 → ~100 in 30–43 changes)", () => {
  const patterns: [string, (i: number, day: number) => boolean][] = [
    ["one run a day", (i) => i % 48 === 20],
    ["one run every 2 days", (i, day) => i % 48 === 20 && day % 2 === 0],
    ["one run every 4 days", (i, day) => i % 48 === 20 && day % 4 === 0],
    ["3 days of every 13", (_i, day) => day % 13 >= 10],
  ];
  for (const [what, missing] of patterns) {
    for (const start of [340, 200]) {
      let fee = start;
      const lastApplied: Record<string, string> = {};
      const moves: string[] = [];
      for (let i = 0; i < 90 * 48; i++) {
        const nowMs = NOW + i * 30 * 60_000;
        const day = Math.floor(i / 48);
        const r = buildRecommendation(sink(), {
          ...ctx({ ppm: fee, ...sinkDraining, market: missing(i, day) ? undefined : market(200, 100) }),
          cooldown: { lastApplied, cooldownHours: 6 },
          nowMs,
        });
        if (r.wouldApply) {
          moves.push(`d${day} ${fee}→${r.targetPpm}`);
          assert.ok(r.targetPpm > fee, `${what}, from ${start}: lowered — ${moves.join(", ")}`);
          fee = r.targetPpm;
          lastApplied["850000x1x0"] = new Date(nowMs).toISOString();
        }
      }
      if (start === 340) assert.ok(moves.length <= 1 && fee >= 340, `${what}: ${moves.join(", ")}`);
      // (Up to the anti-churn threshold's 20 % of its aim of 345.)
      else assert.ok(fee >= 300, `${what}, from 200: still short of its refill cost — ${moves.join(", ")}`);
    }
  }
});

test("a remembered market reference prices like this report's own — and says when it was last seen", () => {
  const seenAt = NOW - 3 * 3_600_000;
  const r = buildRecommendation(sink(), ctx({ ppm: 80, market: market(200, 100), marketSeenAt: seenAt, ...sinkDraining }));
  const fresh = buildRecommendation(sink(), ctx({ ppm: 80, market: market(200, 100), ...sinkDraining }));
  assert.deepEqual([r.targetPpm, r.aimPpm], [fresh.targetPpm, fresh.aimPpm]);
  assert.match(r.reasons[0], /^replacement: draining, and a refill costs at least ~300 ppm \(others charge ~200 into the peer, it charges 100 back to you\) \(last seen 3 h ago\) — pricing toward 345 ppm/);
  assert.equal(r.metrics.marketSeenAt, new Date(seenAt).toISOString());
  assert.equal(fresh.metrics.marketSeenAt, null);
  // The idle channel's market jump says so too.
  const idle = buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 500, market: market(100), marketSeenAt: NOW - 2 * DAY }));
  assert.equal(idle.targetPpm, 90);
  assert.match(idle.reasons[0], /^no flow: other nodes charge ~100 ppm into this peer \(last seen 2 d ago\) — dropping to 90 ppm/);
});

// ── review 3: the Why is the rule that set the move, and no line denies it ──

/** No reason line denies the move: a raise carries no hold, "never raised",
 *  no-flow or lowering line; a lowering no hold or raising line; a fee that
 *  stays no step guard. */
function assertNoContradiction(r: FeeRecommendation, what: string): void {
  const up = r.targetPpm > r.currentPpm;
  const down = r.targetPpm < r.currentPpm;
  const denies = up
    ? [/^hold:/, /never raised|not raised toward/, /^no flow:/, /^guard: lowering/, /lower fee invites flow/]
    : down
      ? [/^hold:/, /not lowered toward/, /^guard: raising/, /— modest bump$/, /— ramping \d+→\d+$/, /higher fee slows the drain/, /^draining: .*raised toward/]
      : [/^guard: (raising|lowering)/];
  for (const re of denies) {
    const line = r.reasons.find((l) => re.test(l));
    assert.equal(line, undefined, `${what}: ${r.currentPpm} → ${r.targetPpm}, yet "${line}" — ${r.reasons.join(" | ")}`);
  }
}

test("(a) a new channel turning payments away, lifted by its protected fee: the new-channel floor leads — not 'demand: … not treated as idle' (a new channel is never idle)", () => {
  const r = buildRecommendation(chan({ id: `${HEIGHT - 12}x1x0`, localRatio: 0.55 }), ctx({ ppm: 45, demand: { attempts: 3, days: 2, sats: 300_000, medianSats: 100_000 } }));
  assert.equal(r.targetPpm, 80);
  assert.match(r.reasons[0], /^new channel: only 0\.1d old with little history — keeping a protected fee/, r.reasons.join(" | "));
  const line = r.reasons.find((x) => x.startsWith("demand:"));
  assert.ok(line && !line.includes("not treated as idle"), r.reasons.join(" | "));
  assertNoContradiction(r, "new + demand");
});

test("(b) a channel turning payments away, raised by the curve below its target ratio: the curve leads — the demand line is a note", () => {
  const r = buildRecommendation(chan({ localRatio: 0.3 }), ctx({ ppm: 80, demand: demand(4, 3) }));
  assert.equal(r.targetPpm, 80 + RAISE_STEPS * STEP);
  assert.match(r.reasons[0], /^balance: low local ratio \(30%\) — higher fee slows the drain/, r.reasons.join(" | "));
  assert.ok(r.reasons.some((x) => /^demand: .*; not treated as idle$/.test(x)));
  assertNoContradiction(r, "demand, raised by the curve");
});

test("(c) a draining channel raised at or above its target ratio says it drains — not 'balance: 50% local (target 50%) — the balance curve puts it at ~80 ppm', the raise the Fees tab says never happens", () => {
  const draining = { f14: flow(50_000, 0, 2, 2), f30: flow(600_000, 50_000, 20, 30) } as const;
  const blind = buildRecommendation(chan(), ctx({ ppm: 45, ...draining }));
  assert.deepEqual([blind.targetPpm, blind.aimPpm], [65, 80]);
  assert.match(blind.reasons[0], /^draining: 28% of its capacity net out in 30 d \(no market reference for its refill cost\) — raised toward ~80 ppm/, blind.reasons.join(" | "));
  assertNoContradiction(blind, "draining, no market");
  // With a market whose refill cost is under the curve's level: the same, with the cost.
  const cheap = buildRecommendation(chan(), ctx({ ppm: 45, market: market(30, 10), ...draining }));
  assert.equal(cheap.targetPpm, 65);
  assert.match(cheap.reasons[0], /^draining: 28% of its capacity net out in 30 d — raised toward ~80 ppm \(a refill costs ~40 ppm\)/, cheap.reasons.join(" | "));
  assertNoContradiction(cheap, "draining, cheap market");
});

test("(d) a fee below the min lifted by the range rule: the range leads, and neither 'an idle channel is never raised' nor 'no flow: … lowering toward min' stays — nor is it a no-flow lowering", () => {
  const drainedIdle = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 0 }));
  assert.equal(drainedIdle.targetPpm, 25);
  assert.match(drainedIdle.reasons[0], /^range: 0 ppm is below your min of 25 ppm/);
  assertNoContradiction(drainedIdle, "drained idle at 0");
  const idle = buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 0 }));
  assert.equal(idle.targetPpm, 25);
  assert.match(idle.reasons[0], /^range: 0 ppm is below your min of 25 ppm/);
  assert.equal(idle.noFlowLowering, false, "a raise opened a flow-won episode");
  assert.notEqual(idle.state, "exploring_lower_fee");
  assertNoContradiction(idle, "idle at 0");
  // Idle, but refilled by inbound flow (no close candidate): lifted to the
  // min, it is not "exploring a lower fee" either.
  const refilled = buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 0, f14: flow(0, 100_000, 0), f30: flow(0, 100_000, 0) }));
  assert.deepEqual([refilled.targetPpm, refilled.noFlowLowering, refilled.state], [25, false, "normal"], refilled.reasons.join(" | "));
  // An idle channel just above the min is still lowered as idle (to it).
  const atMin = buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 40 }));
  assert.deepEqual([atMin.targetPpm, atMin.noFlowLowering, atMin.state], [25, true, "close_candidate"]);
});

test("a pin or a lease promise that sets another move takes back the lines that deny it — the step guard's 'a→b', 'never raised', a no-flow lowering under a fee that goes up", () => {
  // Idle at 40% local, pinned higher: not "no flow: … lowering toward min", not a no-flow lowering.
  const pinnedUp = buildRecommendation(chan({ localRatio: 0.4 }), ctx({ ppm: 80, override: { mode: "fixed", fixedPpm: 200 } }));
  assert.deepEqual([pinnedUp.targetPpm, pinnedUp.noFlowLowering], [200, false]);
  assert.match(pinnedUp.reasons[0], /^pinned to 200 ppm \(manual\)/);
  assertNoContradiction(pinnedUp, "idle, pinned up");
  // Drained and idle, pinned higher: not "never raised".
  const drainedPinned = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 80, override: { mode: "fixed", fixedPpm: 300 } }));
  assert.equal(drainedPinned.targetPpm, 300);
  assertNoContradiction(drainedPinned, "drained idle, pinned up");
  // A raise step the lease promise cuts short (20% local: the curve wants
  // ~3,500): no "guard: raising … 2190→2210".
  const drainingFast = { f14: flow(300_000, 50_000, 10, 24), f30: flow(600_000, 100_000, 20, 48) } as const;
  const capped = buildRecommendation(chan({ localRatio: 0.2 }), ctx({ ppm: 2190, leaseCap: leaseCap(2200), cfg: cfgOf(PRESETS.Balanced, { maxPpm: 6000 }), ...drainingFast }));
  assert.equal(capped.targetPpm, 2200);
  assert.ok(!capped.reasons.some((x) => x.startsWith("guard: raising")), capped.reasons.join(" | "));
  assert.equal(buildRecommendation(chan({ localRatio: 0.2 }), ctx({ ppm: 2190, cfg: cfgOf(PRESETS.Balanced, { maxPpm: 6000 }), ...drainingFast })).targetPpm, 2210, "the step alone");
  // A breach lowered at once, where the engine would have raised.
  const breach = buildRecommendation(chan({ localRatio: 0.2 }), ctx({ ppm: 2500, leaseCap: leaseCap(2200), cfg: cfgOf(PRESETS.Balanced, { maxPpm: 6000 }), ...drainingFast }));
  assert.equal(breach.targetPpm, 2200);
  assert.match(breach.reasons[0], /^lease promise: /);
  assert.ok(!breach.reasons.some((x) => x.startsWith("guard: raising")), breach.reasons.join(" | "));
});

test("a draining channel priced above its refill cost is lowered toward that cost — and the Why says so, not the balance curve's lower level", () => {
  // 1,000 ppm, a refill costs ~400 (× 1.15 = 460): heading to 460, not the curve's 80.
  const r = buildRecommendation(sink(), ctx({ ppm: 1000, market: market(300, 100), ...sinkDraining }));
  assert.deepEqual([r.targetPpm, r.aimPpm], [1000 - 3 * STEP, 460]);
  assert.match(r.reasons[0], /^replacement: draining, and a refill costs at least ~400 ppm .* — priced above that: lowering toward 460 ppm, not below/, r.reasons.join(" | "));
  assertNoContradiction(r, "above its refill cost");
});

test("a step guard only where the step stops the move short of its aim — a fee held at the max read 'raising at most 25 ppm per move — 1000→1000 on the way to 1000 ppm'", () => {
  // Drained to 3% and still routing: the curve × a measured 1.25 wants ~1,170.
  const atMax = buildRecommendation(chan({ localRatio: 0.03 }), ctx({ ppm: 1000, elasticityMod: 1.25, f30: flow(10_000, 0, 1, 1) }));
  assert.equal(atMax.targetPpm, 1000);
  assert.ok(!atMax.reasons.some((x) => x.startsWith("guard:")), atMax.reasons.join(" | "));
  // 990: one step would pass the max — the move reaches its aim (the max), no step stops it.
  const nearMax = buildRecommendation(chan({ localRatio: 0.03 }), ctx({ ppm: 990, elasticityMod: 1.25, f30: flow(10_000, 0, 1, 1) }));
  assert.deepEqual([nearMax.targetPpm, nearMax.aimPpm], [1000, 1000]);
  assert.ok(!nearMax.reasons.some((x) => x.startsWith("guard:")), nearMax.reasons.join(" | "));
});

test("a pin, an exclusion or a lease promise that sets another move leaves the engine's rules their facts, not their claims — a pin of 25 read 'profit floor: … — ramping 80→120' beside it", () => {
  const floorFact = "profit floor: the autopilot's refills into it cost 900 ppm (1 in 30 d, latest 1 d ago) × 1.15 = 1035 ppm — capped at your max 1000 ppm";
  const pinned = buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ...routingAt70, records: [refill({})], override: { mode: "fixed", fixedPpm: 25 } }));
  assert.equal(pinned.targetPpm, 25);
  assert.deepEqual(pinned.reasons.slice(0, 2), ["pinned to 25 ppm (manual)", floorFact], pinned.reasons.join(" | "));
  assertNoContradiction(pinned, "pinned under a floor");
  const excluded = buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ...routingAt70, records: [refill({})], override: { mode: "exclude" } }));
  assert.deepEqual(excluded.reasons.slice(0, 2), ["excluded (manual) — not managed by the autopilot", floorFact], excluded.reasons.join(" | "));
  // A protect ramp a pin overrides: not "ramping toward 350 ppm".
  const pinnedProtect = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 80, ...routingAt70, override: { mode: "fixed", fixedPpm: 25 } }));
  assert.deepEqual(pinnedProtect.reasons.slice(0, 2), ["pinned to 25 ppm (manual)", "protect: drained (5% local) but still in demand"], pinnedProtect.reasons.join(" | "));
  assert.match(buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 80, ...routingAt70 })).reasons[0], /— ramping toward 350 ppm$/, "unpinned, the ramp is the move");
  // A lease promise under the protect level: not "kept at 350 ppm or more".
  const sold = buildRecommendation(chan({ localRatio: 0.05 }), ctx({ ppm: 400, leaseCap: leaseCap(300), ...routingAt70 }));
  assert.equal(sold.targetPpm, 300);
  assert.ok(sold.reasons.includes("protect: drained (5% local) but still in demand"), sold.reasons.join(" | "));
  assert.ok(!sold.reasons.some((x) => /kept at \d+ ppm or more/.test(x)), sold.reasons.join(" | "));
  // Without them, the claims stand.
  assert.match(buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ...routingAt70, records: [refill({})] })).reasons[0], /— ramping 80→120$/);
});

test("a claim of a direction the fee doesn't take is reduced to its fact — 'lowering toward 95 ppm' under a profit floor's raise", () => {
  // Draining, priced above a cheap refill (40 into the peer + 50 back, × 1.05
  // = 95), with a 900 ppm refill on record: the floor's ramp sets the move.
  const r = buildRecommendation(
    chan({ localRatio: 0.7 }),
    ctx({ cfg: cfgOf(PRESETS["Max routing"]), ppm: 150, market: market(40, 50), records: [refill({})], f14: flow(300_000, 50_000, 10, 24), f30: flow(600_000, 100_000, 20, 48) }),
  );
  assert.equal(r.targetPpm, 150 + RAMP_STEPS * STEP);
  assert.match(r.reasons[0], /^profit floor: .* — ramping 150→190$/);
  assert.ok(r.reasons.includes("replacement: draining, and a refill costs at least ~90 ppm (others charge ~40 into the peer, it charges 50 back to you)"), r.reasons.join(" | "));
  assertNoContradiction(r, "floor over replacement");
});

test("a broken lease promise says what breaks it — a base fee alone read 'its fee (150 ppm, 1000 msat base) is above that; lowering at once' while a floor took the rate up", () => {
  const baseOnly = buildRecommendation(chan({ localRatio: 0.7 }), ctx({ ppm: 150, baseMsat: 1000, leaseCap: { ...leaseCap(2200), baseFeeCapMsat: 0 }, ...routingAt70, records: [refill({})] }));
  assert.deepEqual([baseOnly.leaseCapBreach, baseOnly.targetPpm, baseOnly.recommendedBaseMsat], [true, 190, 0]);
  assert.match(baseOnly.reasons[0], /^lease promise: .* — its base fee \(1000 msat\) is above that; lowered at once$/);
  const rate = buildRecommendation(chan(), ctx({ ppm: 2500, leaseCap: leaseCap(2200), cfg: cfgOf(PRESETS.Balanced, { maxPpm: 6000 }) }));
  assert.match(rate.reasons[0], /^lease promise: .* — its fee \(2500 ppm\) is above that; lowered at once$/);
});

test("a fee at a floor lands on it exactly — on a 25-ppm grid a new channel's protected 80 rounded to 75, under its own 'not below 80 ppm'", () => {
  const coarse = cfgOf(PRESETS.Balanced, { stepPpm: 25 });
  const fresh = chan({ id: `${HEIGHT - 12}x1x0` });
  // Lifted to it: 78 → 80 (it stayed at 78: the rounded 75 turned the move around).
  const lifted = buildRecommendation(fresh, ctx({ cfg: coarse, ppm: 78 }));
  assert.deepEqual([lifted.targetPpm, lifted.aimPpm], [80, 80], lifted.reasons.join(" | "));
  assert.match(lifted.reasons[0], /^new channel: /);
  // Walking down to it, the curve aiming at exactly 80: 100 → 80, not 75.
  const walked = buildRecommendation(fresh, ctx({ cfg: coarse, ppm: 100 }));
  assert.deepEqual([walked.targetPpm, walked.aimPpm], [80, 80], walked.reasons.join(" | "));
  // The max too, with no floor at it: a drained channel the curve wants
  // above the max, at 1,010 against a max of 1,004, goes to 1,004 — not 1,000.
  const atMax = buildRecommendation(chan({ localRatio: 0.03 }), ctx({ cfg: cfgOf(PRESETS.Balanced, { maxPpm: 1004 }), ppm: 1010, elasticityMod: 1.25, f30: flow(10_000, 0, 1, 1) }));
  assert.deepEqual([atMax.targetPpm, atMax.wouldApply], [1004, true], atMax.reasons.join(" | "));
  assert.match(atMax.reasons[0], /^range: 1010 ppm is above your max of 1004 ppm — brought down to it at once/);
  // A ramp's own lift lands exactly too, off the grid (a profit floor of 1,035 opted in above the max).
  const ramp = buildRecommendation(chan({ localRatio: 0.7 }), ctx({ cfg: cfgOf(PRESETS.Balanced, { stepPpm: 25, floorAboveMax: true, maxPpm: 900 }), ppm: 1000, ...routingAt70, records: [refill({})] }));
  assert.deepEqual([ramp.targetPpm, ramp.aimPpm], [1035, 1035], ramp.reasons.join(" | "));
});
