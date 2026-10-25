/**
 * Rebalance guards P3 wrote down but no test pinned (P3's final review,
 * carried into package P4): with any one of them broken, the whole suite
 * stayed green.
 *
 *  - FIFO retirement of refill lots in the order production passes them:
 *    RebalanceLog.successes() is newest first.
 *  - The legacy per-target fail count: honoured, and cleared by a paid refill.
 *  - The per-pair back-off: cooldown × 2^fails, at most × 8.
 *  - The fee_adjust_first state: a channel priced below its refill-cost floor
 *    raises its fee first and is never probed for a refill.
 *  - The planner's projected spend with more than one slot.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEE_REC_DEFAULTS,
  buildRecommendation,
  refillFloor,
  refillLots,
  type BuildCtx,
  type FeeRecConfig,
  type Flow,
} from "../src/services/feeRecommend.js";
import {
  REBAL_REC_DEFAULTS,
  classify,
  planRebalances,
  selectRebalanceRuns,
  type RebalanceRecommendation,
  type RouteProbe,
} from "../src/services/rebalanceRecommend.js";
import { RebalanceLog, type RebalanceRecord } from "../src/services/rebalanceLog.js";
import type { ChannelView } from "../src/services/channels.js";
import type { RebalanceExecParams } from "../src/services/rebalance.js";
import { autopilotWith, paidRebalance, plannedRebalance } from "./helpers/autopilot.js";
import { makeTempDir } from "./helpers/tmp.js";

const DAY = 86_400_000;
const HEIGHT = 860_000;
const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

// ── FIFO in production order ──────────────────────────────────────────────────

test("refill lots retire first in, first out when they come the way production passes them — RebalanceLog.successes(), newest first: the older lot goes first and the floor stands on the newer one", (t) => {
  const now = Date.now();
  const ago = (days: number) => new Date(now - days * DAY).toISOString();
  const refill = (o: Partial<RebalanceRecord>): RebalanceRecord => ({
    at: ago(1),
    via: "autopilot",
    targetId: "850000x1x0",
    targetAlias: "peer",
    sourceId: "850000x2x0",
    sourceAlias: "src",
    amountSats: 500_000,
    budgetPpm: 1000,
    feeSats: 100,
    costPpm: 200,
    ok: true,
    ...o,
  });
  const log = new RebalanceLog(makeTempDir(t));
  // The older refill (300k, held at 400 ppm) when LND's sent counter read
  // 1.0M, the newer one (400k, held at 500 ppm) at 1.2M.
  log.append(refill({ at: ago(5), amountSats: 300_000, feeSats: 60, targetSentBefore: 1_000_000, holdPpm: 400 }));
  log.append(refill({ at: ago(2), amountSats: 400_000, feeSats: 120, targetSentBefore: 1_200_000, holdPpm: 500 }));
  const records = log.successes();
  assert.deepEqual(records.map((r) => r.holdPpm), [500, 400], "newest first, as the fee engine receives them");
  // 1.45M now: 200k left between the refills and 250k since — the older
  // lot's 300k first, then 150k of the newer.
  const lots = refillLots("850000x1x0", records, 1_450_000, now);
  assert.deepEqual(lots.map((l) => [l.amountSats, l.remainingSats]), [
    [300_000, 0],
    [400_000, 250_000],
  ]);
  const floor = refillFloor(lots, 1.15);
  assert.equal(floor?.ppm, 500, "the newer lot sets the floor (before: the newest retired first, the floor stayed at 400)");
  assert.equal(floor?.remainingSats, 250_000);
});

// ── the per-target and per-pair back-offs ─────────────────────────────────────

const T = "800001x1x0";
const S = "800000x1x0";
const COOLDOWN_MIN = 60;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const planFor = (target: string) => ({ ...plannedRebalance(target, 500), estimatedRouteFeeSats: 10 }) as RebalanceRecommendation;
type Books = {
  state: {
    perTargetLastRebalanced: Record<string, string>;
    perPairRebalanceFails?: Record<string, { fails: number; at: string }>;
  };
};

test("a target's fail count from before the per-pair back-off (0.7.x) is dropped on upgrade — never added to since, only a success cleared it: with 3 old fails a target waited 8× its cooldown for good — so it waits its cooldown alone (review 2026-10-25)", async (t) => {
  const { autopilot, seams, dir } = autopilotWith(
    t,
    { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000, rebalanceCooldownMinutes: COOLDOWN_MIN },
    { perTargetRebalanceFails: { [T]: 3 }, perTargetLastRebalanced: { [T]: minutesAgo(2 * COOLDOWN_MIN) } },
  );
  const sent: string[] = [];
  seams.rebalanceReport = async () => ({ recommendations: [planFor(T)] });
  seams.rebalanceExec = async (_w, p: RebalanceExecParams) => {
    sent.push(p.targetId);
    return paidRebalance(p);
  };
  await autopilot.runOnce();
  assert.deepEqual(sent, [T], "two cooldowns after its last try: refilled (before: 8× — it waited)");
  const saved = JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as Record<string, unknown>;
  assert.equal(saved.perTargetRebalanceFails, undefined, "gone from the disk too");
});

test("a source → target pair whose refills failed backs off cooldown × 2^fails — two fails: still waiting after 2×, tried after 5× — and never longer than 8×", async (t) => {
  const pair = `${S}>${T}`;
  const { autopilot, seams } = autopilotWith(
    t,
    { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000, rebalanceCooldownMinutes: COOLDOWN_MIN },
    { perPairRebalanceFails: { [pair]: { fails: 2, at: minutesAgo(2 * COOLDOWN_MIN) } } },
  );
  const sent: string[] = [];
  seams.rebalanceReport = async () => ({ recommendations: [planFor(T)] });
  seams.rebalanceExec = async (_w, p: RebalanceExecParams) => {
    sent.push(`${p.sourceId}>${p.targetId}`);
    return paidRebalance(p);
  };
  const books = (autopilot as unknown as Books).state;
  await autopilot.runOnce();
  assert.deepEqual(sent, [], "2 fails: 4× the cooldown, only 2× has passed");
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", /every source is busy or backing off/);
  (books.perPairRebalanceFails as Record<string, { fails: number; at: string }>)[pair].at = minutesAgo(5 * COOLDOWN_MIN);
  await autopilot.runOnce();
  assert.deepEqual(sent, [pair], "past 4×: the pair is tried again");
  assert.equal(books.perPairRebalanceFails?.[pair], undefined, "and its paid refill clears the back-off");

  // A count beyond what the books write (an older file): still at most 8×.
  books.perPairRebalanceFails = { [pair]: { fails: 5, at: minutesAgo(9 * COOLDOWN_MIN) } };
  delete books.perTargetLastRebalanced[T];
  await autopilot.runOnce();
  assert.deepEqual(sent, [pair, pair], "9× after the last failure: the ×8 cap has passed");
});

test("a refill LND fails before anything is sent (its first reads: 'waiting to start') is that refill's error, not the stage's — the target gets its cooldown back, nothing is logged, and the next planned refill still runs (review 2026-10-25)", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const U = "800002x1x0";
  const { autopilot, seams, dir } = autopilotWith(t, {
    rebalanceEnabled: true,
    rebalanceDailyBudgetSats: 10_000,
    maxRebalancesPerRun: 2,
    rebalanceCooldownMinutes: COOLDOWN_MIN,
  });
  seams.rebalanceReport = async () => ({ recommendations: [planFor(T), { ...planFor(U), selectedSourceChannel: "800003x1x0" }] });
  const calls: string[] = [];
  seams.rebalanceExec = async (_w, p: RebalanceExecParams) => {
    calls.push(p.targetId);
    if (p.targetId === T) throw [503, "UnexpectedGetChannelsError", { err: { details: "waiting to start, RPC services not available" } }];
    return paidRebalance(p);
  };
  const run = await autopilot.runOnce();
  // Before: the throw ended the stage — U never ran — and T sat out its cooldown.
  assert.deepEqual(calls, [T, U], "the next refill still ran");
  assert.deepEqual(
    run.rebalances.map((r) => [r.ok, r.error ?? null]),
    [
      [false, "not started: 503 UnexpectedGetChannelsError: waiting to start, RPC services not available"],
      [true, null],
    ],
  );
  const saved = JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as { perTargetLastRebalanced: Record<string, string> };
  assert.equal(saved.perTargetLastRebalanced[T], undefined, "no attempt: no cooldown — tried again next run");
  assert.ok(saved.perTargetLastRebalanced[U]);
  assert.equal(new RebalanceLog(dir).recent(5).length, 1, "only the paid refill is in the log");
});

// ── fee_adjust_first ─────────────────────────────────────────────────────────

const cfg: FeeRecConfig = { ...FEE_REC_DEFAULTS, stepPpm: 10, minChangePpm: 25 };
const NO_FLOW: Flow = { out: 0, inn: 0, forwards: 0, revenue: 0 };
const flow = (out: number, inn: number, forwards: number, revenue: number): Flow => ({ out, inn, forwards, revenue });

/** A drained target at `ppm` with demand and earnings, and an idle full source. */
function drainedNode(ppm: number, records: RebalanceRecord[]) {
  const ch = (n: number, local: number): ChannelView => ({
    id: `850000x${n}x0`,
    peerPubkey: PEER(n),
    peerAlias: `peer-${n}`,
    active: true,
    private: false,
    initiator: "local",
    capacity: 5_000_000,
    transactionId: TX(n),
    transactionVout: 0,
    localBalance: local,
    remoteBalance: 5_000_000 - local,
    localRatio: local / 5_000_000,
    totalSent: 3_000_000,
    totalReceived: 0,
    unsettled: 0,
    status: "open",
    role: "router",
  });
  const channels = [ch(1, 750_000), ch(2, 4_500_000)];
  const ctx = (n: number, o: Partial<BuildCtx>): BuildCtx =>
    ({
      cfg,
      rate: { fee_rate: 100, base_fee_mtokens: "0", transaction_id: TX(n), transaction_vout: 0 },
      override: undefined,
      f14: NO_FLOW,
      f30: flow(0, 50_000, 1, 0),
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
      market: { intoPeerPpm: 100, samples: 5, peerFeeToUsPpm: 50 },
      nowMs: Date.now(),
      ...o,
    }) as BuildCtx;
  const contexts = new Map<string, BuildCtx>([
    // 1.2M out in 14 days at `ppm`: proven demand and earnings.
    [channels[0].id, ctx(1, { rate: { fee_rate: ppm, base_fee_mtokens: "0", transaction_id: TX(1), transaction_vout: 0 }, f14: flow(1_200_000, 0, 20, 480), f30: flow(1_200_000, 0, 20, 480), records })],
    [channels[1].id, ctx(2, {})],
  ]);
  const fees = channels.map((c) => buildRecommendation(c, contexts.get(c.id) as BuildCtx));
  return { channels, contexts, fees };
}

/** A refill still in the target (none of it routed out), held at `holdPpm`. */
const heldRefill = (holdPpm: number): RebalanceRecord => ({
  at: new Date(Date.now() - DAY).toISOString(),
  via: "autopilot",
  targetId: "850000x1x0",
  targetAlias: "peer-1",
  sourceId: "850000x2x0",
  sourceAlias: "peer-2",
  amountSats: 400_000,
  budgetPpm: 400,
  feeSats: 40,
  costPpm: 100,
  ok: true,
  targetSentBefore: 3_000_000,
  holdPpm,
});

test("a drained channel priced below its refill-cost floor (400 ppm under a 500 ppm floor) is 'fee_adjust_first': no refill, and the planner never probes a route for it", async () => {
  const below = drainedNode(400, [heldRefill(500)]);
  const targetFee = below.fees[0];
  assert.deepEqual([targetFee.currentPpm, targetFee.metrics.profitFloorPpm], [400, 500]);
  const rec = classify(below.channels[0], targetFee, REBAL_REC_DEFAULTS, {});
  assert.equal(rec.state, "fee_adjust_first", rec.reasons.join(" | "));
  assert.equal(rec.wouldRebalance, false);
  assert.ok(rec.reasons.some((x) => /below this channel's refill-cost floor \(500 ppm\) — raising the fee must come first/.test(x)), rec.reasons.join(" | "));

  const probed: string[] = [];
  const probe: RouteProbe = async (_s, target, amount) => {
    probed.push(target.id);
    return { costPpm: 50, feeSats: Math.round((amount * 50) / 1_000_000) };
  };
  const plan = (n: ReturnType<typeof drainedNode>) =>
    planRebalances(
      { channels: n.channels, fees: n.fees, contextOf: (id) => n.contexts.get(id), cfg: REBAL_REC_DEFAULTS, overrides: {}, soldLeases: [], currentBlock: HEIGHT },
      probe,
    );
  const planned = await plan(below);
  assert.equal(planned.recommendations.find((r) => r.channelId === "850000x1x0")?.state, "fee_adjust_first");
  assert.equal(probed.length, 0, "never probed");
  assert.equal(planned.summary.feeAdjustFirstCount, 1);

  // The same channel with its fee above the floor is a refill candidate, and probed.
  const above = drainedNode(400, [heldRefill(300)]);
  const ok = await plan(above);
  assert.notEqual(ok.recommendations.find((r) => r.channelId === "850000x1x0")?.state, "fee_adjust_first");
  assert.ok(probed.includes("850000x1x0"), "probed once its fee covers the floor");
});

// ── the planner's projected spend ────────────────────────────────────────────

test("the planner projects each move's estimated fee against the budget with more than one slot: [A 600, B 600, C 300] with 1,000 sat and 2 per run runs A and C — B is left for the budget", () => {
  const mk = (id: string, est: number, net: number) =>
    ({ channelId: id, alias: id, estimatedRouteFeeSats: est, expectedNetProfitSats: net }) as unknown as RebalanceRecommendation;
  const plan = selectRebalanceRuns([mk("A", 600, 500), mk("B", 600, 400), mk("C", 300, 300)], {
    dailyBudgetSats: 1_000,
    alreadySpentSats: 0,
    maxPerRun: 2,
  });
  assert.deepEqual(plan.run.map((r) => r.channelId), ["A", "C"]);
  assert.deepEqual(plan.skipped.map((s) => s.rec.channelId), ["B"]);
  assert.match(plan.skipped[0].reason, /400 sat left of the 1000 sat daily budget — too little for this move \(~600 sat\)/);
  assert.deepEqual(plan.later, []);
});
