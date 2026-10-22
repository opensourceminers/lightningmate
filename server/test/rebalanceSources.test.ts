/**
 * Where a refill pulls from (review a2, naive-source-selection, package P3).
 *
 * Before: every target took the same source — the fullest channel — with no
 * age, private or sold-channel check, so a channel opened yesterday (≈100 %
 * local, no flow) ranked first and a private wallet channel made every target
 * read "no route found at any size". Amounts were sized from the target
 * alone, the run's moves all drained that one stale pick, a source that
 * found no route was never replaced by the next one, and the failure backoff
 * blocked the target whatever source had failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FEE_REC_DEFAULTS, buildRecommendation, type BuildCtx, type FeeRecConfig, type Flow } from "../src/services/feeRecommend.js";
import {
  REBAL_REC_DEFAULTS,
  buildSourcePool,
  planRebalances,
  type RebalanceRecommendation,
  type RouteProbe,
} from "../src/services/rebalanceRecommend.js";
import type { ChannelView } from "../src/services/channels.js";
import type { SoldLease } from "../src/services/leaseCaps.js";
import { autopilotWith, paidRebalance, plannedRebalance } from "./helpers/autopilot.js";
import type { RebalanceExecParams } from "../src/services/rebalance.js";
import { feeNode, forwardsOut, type FeeChannel } from "./helpers/feeNode.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir } from "./helpers/tmp.js";

const HEIGHT = 860_000;
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const cfg: FeeRecConfig = { ...FEE_REC_DEFAULTS, stepPpm: 10, minChangePpm: 25 };
const NO_FLOW: Flow = { out: 0, inn: 0, forwards: 0, revenue: 0 };
const flow = (out: number, inn: number, forwards: number, revenue: number): Flow => ({ out, inn, forwards, revenue });

interface Spec {
  n: number;
  /** Block the channel was funded in (default 850,000: ~69 days old). */
  block?: number;
  capacity?: number;
  local: number;
  feePpm?: number;
  f14?: Flow;
  f30?: Flow;
  isPrivate?: boolean;
}

/** Channels and the fee engine's view of them, as one run would build it. */
function nodeOf(specs: Spec[], engineCfg: FeeRecConfig = cfg) {
  const channels: ChannelView[] = specs.map((s) => {
    const capacity = s.capacity ?? 5_000_000;
    return {
      id: `${s.block ?? 850_000}x${s.n}x0`,
      peerPubkey: PEER(s.n),
      peerAlias: `peer-${s.n}`,
      active: true,
      private: s.isPrivate ?? false,
      initiator: "local",
      capacity,
      transactionId: TX(s.n),
      transactionVout: 0,
      localBalance: s.local,
      remoteBalance: capacity - s.local,
      localRatio: s.local / capacity,
      totalSent: 0,
      totalReceived: 0,
      unsettled: 0,
      status: "open",
      role: "router",
    };
  });
  const contexts = new Map<string, BuildCtx>(
    specs.map((s, i) => [
      channels[i].id,
      {
        cfg: engineCfg,
        rate: { fee_rate: s.feePpm ?? 100, base_fee_mtokens: "0", transaction_id: TX(s.n), transaction_vout: 0 },
        override: undefined,
        f14: s.f14 ?? NO_FLOW,
        f30: s.f30 ?? flow(0, 50_000, 1, 0),
        currentBlock: HEIGHT,
        records: [],
        bench: { activeChannelCount: specs.length, topGrossFlow14d: 0, medianGrossFlow14d: 0, topRevenue30d: 0, medianRevenue30d: 0, topRevenuePpm30d: 0, medianRevenuePpm30d: 0 },
        enoughChannels: false,
        earnerCutoff: 0,
        cooldown: null,
        elasticityMod: 1,
        flowAnchor: undefined,
        leaseCap: null,
        demand: undefined,
        market: { intoPeerPpm: 100, samples: 5, peerFeeToUsPpm: 50 },
        nowMs: NOW,
      },
    ]),
  );
  const fees = channels.map((c) => buildRecommendation(c, contexts.get(c.id) as BuildCtx));
  return { channels, contexts, fees, feeById: new Map(fees.map((f) => [f.channelId, f])) };
}

/** A drained 5M channel at 15 % local earning 400 ppm (1.2M out in 14 days). */
const drained = (n: number, o: Partial<Spec> = {}): Spec => ({
  n,
  local: 750_000,
  feePpm: 400,
  f14: flow(1_200_000, 200_000, 20, 480),
  f30: flow(2_400_000, 400_000, 40, 960),
  ...o,
});
const routeAt = (ppm: number, opts: { noRouteFrom?: string[] } = {}): RouteProbe => async (s, _t, amount) =>
  opts.noRouteFrom?.includes(s.id) ? { costPpm: null, feeSats: null } : { costPpm: ppm, feeSats: Math.round((amount * ppm) / 1_000_000) };

async function plan(n: ReturnType<typeof nodeOf>, probe: RouteProbe, soldLeases: SoldLease[] = []) {
  return planRebalances(
    { channels: n.channels, fees: n.fees, contextOf: (id) => n.contexts.get(id), cfg: REBAL_REC_DEFAULTS, overrides: {}, soldLeases, currentBlock: HEIGHT },
    probe,
  );
}

test("a source is never a fresh, private, sold, draining or best-earning channel — the one opened yesterday at ~100 % local ranked first", () => {
  const n = nodeOf([
    drained(1),
    { n: 2, local: 4_000_000 }, // idle, 80 % local, 69 days old: the one real donor
    { n: 3, local: 4_975_000, block: HEIGHT - 144 }, // opened yesterday, 99.5 % local
    { n: 4, local: 4_750_000, isPrivate: true }, // a wallet's private channel
    { n: 5, local: 4_750_000, block: 857_000 }, // sold on Magma, lease running (~21 days old)
    { n: 6, local: 4_750_000, f14: flow(100_000, 0, 2, 10) }, // draining a little
    { n: 7, local: 4_500_000, f14: flow(0, 100_000, 3, 0), f30: flow(600_000, 700_000, 30, 3_000) }, // the best earner
  ]);
  const sold: SoldLease[] = [{ fundingOutpoint: `${TX(5)}:0`, source: "magma", orderId: "m-5", leaseBlocks: 4320 }];
  const pool = buildSourcePool(n.channels, n.feeById, {}, REBAL_REC_DEFAULTS, { soldLeases: sold, currentBlock: HEIGHT });
  assert.deepEqual(pool.map((s) => s.ch.id), ["850000x2x0"]);
  // It gives at most what it holds above its own share (target 50 % + 5 %).
  assert.equal(pool[0].spareSats, 4_000_000 - 2_750_000);
  assert.equal(pool[0].keepRatio, 0.55);
  // Its lease over, the sold channel is an ordinary channel again.
  const later = buildSourcePool(n.channels, n.feeById, {}, REBAL_REC_DEFAULTS, { soldLeases: sold, currentBlock: 857_000 + 4320 + 144 });
  assert.ok(later.some((s) => s.ch.id === "857000x5x0"));
});

// Review of P4: Amboss's "still running" listing extended only the close
// protections; the sold-lease guard ended a Magma lease on the journal's own
// count. A channel Amboss confirmed late — or one sold before the journal
// existed — was drained as a source while Amboss still monitored the lease.
test("a sold channel past its lease by the journal's count is still no source while Amboss lists the lease running — nor is a sale only Amboss knows of", () => {
  const n = nodeOf([
    drained(1),
    { n: 2, local: 4_000_000 }, // the one real donor
    { n: 5, local: 4_750_000, block: 850_000 }, // sold, lease 4,320 + 144: over at 854,464 by the journal
    { n: 8, local: 4_750_000, block: 850_000 }, // sold before the journal existed: only Amboss knows
  ]);
  const journalOnly: SoldLease[] = [{ fundingOutpoint: `${TX(5)}:0`, source: "magma", orderId: "m-5", leaseBlocks: 4320 }];
  const ids = (sold: SoldLease[]) => buildSourcePool(n.channels, n.feeById, {}, REBAL_REC_DEFAULTS, { soldLeases: sold, currentBlock: HEIGHT }).map((s) => s.ch.id).sort();
  assert.deepEqual(ids(journalOnly), ["850000x2x0", "850000x5x0", "850000x8x0"], "the journal alone: both read as ordinary channels");
  const withAmboss: SoldLease[] = [
    { ...journalOnly[0], ambossRunning: true },
    { fundingOutpoint: "", source: "magma", orderId: "m-8", leaseBlocks: 0, ambossRunning: true, channelId: "850000x8x0" },
  ];
  assert.deepEqual(ids(withAmboss), ["850000x2x0"], "Amboss's word keeps both out (fail closed)");
  // Amboss names a channel by its number too.
  const asNumber = String((850_000n << 40n) | (8n << 16n));
  assert.deepEqual(ids([{ ...withAmboss[1], channelId: asNumber }]), ["850000x2x0", "850000x5x0"]);
});

test("each move is capped at the source's spare balance, and a source's planned moves shrink what it can give the next target", async () => {
  const n = nodeOf([
    // The more valuable target (1M demand-sized) is planned first …
    drained(1),
    // … then a smaller one (600k: 400k net drain × 1.5).
    drained(2, { f14: flow(600_000, 200_000, 20, 240), f30: flow(1_200_000, 400_000, 40, 480) }),
    { n: 3, local: 4_000_000 }, // 1.25M to spare
    { n: 4, capacity: 2_000_000, local: 1_500_000 }, // 400k to spare
  ]);
  const { recommendations } = await plan(n, routeAt(100));
  const one = recommendations.find((r) => r.channelId === "850000x1x0")!;
  const two = recommendations.find((r) => r.channelId === "850000x2x0")!;
  assert.equal(one.selectedSourceChannel, "850000x3x0", one.reasons.join(" | "));
  assert.equal(one.recommendedAmount, 1_250_000, "the 1.25M refill fits the first source's 1.25M spare");
  // Before: the same fullest source for both, 1.25M + 600k out of 1.25M spare.
  assert.equal(two.selectedSourceChannel, "850000x4x0", two.reasons.join(" | "));
  assert.equal(two.recommendedAmount, 400_000, "capped at the other source's spare");
  assert.equal(two.sourceCandidates[0].spareSats, 400_000);
});

test("no route from the first source: the next one is probed and chosen; the first is marked out for the executor", async () => {
  const n = nodeOf([drained(1), { n: 2, local: 4_500_000 }, { n: 3, local: 4_000_000 }]);
  const { recommendations } = await plan(n, routeAt(100, { noRouteFrom: ["850000x2x0"] }));
  const rec = recommendations.find((r) => r.channelId === "850000x1x0")!;
  assert.equal(rec.state, "route_found_profitable", rec.reasons.join(" | "));
  assert.equal(rec.selectedSourceChannel, "850000x3x0");
  const first = rec.sourceCandidates.find((c) => c.channelId === "850000x2x0");
  assert.equal(first?.rejected, true);
  assert.equal(first?.rejectedReason, "no route at any size within the probe ceiling");
  assert.equal(rec.sourceCandidates[0].channelId, "850000x3x0", "the passing source leads the list");
});

test("no source can spare anything: the row says why, without a misleading 'what it would take'", async () => {
  const n = nodeOf([drained(1), { n: 2, local: 4_975_000, block: HEIGHT - 144 }]);
  const { recommendations } = await plan(n, routeAt(100));
  const rec = recommendations.find((r) => r.channelId === "850000x1x0")!;
  assert.equal(rec.state, "unprofitable_skip");
  assert.deepEqual(rec.blockedBy, ["no safe source channel"]);
  assert.match(rec.reasons.at(-1) ?? "", /a source must be ≥ 14 days old, public, not sold on Magma\/LSP, not draining, not the best earner/);
});

test("a source that failed for a target backs off for THAT target only — the autopilot's next attempt goes to the target's next source", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000, rebalanceCooldownMinutes: 60 });
  const plan2 = {
    ...plannedRebalance("800001x1x0", 500),
    sourceCandidates: [
      { channelId: "800000x1x0", alias: "a", localRatio: 0.9, spareSats: 1_000_000, keepRatio: 0.55, reason: "" },
      { channelId: "800002x1x0", alias: "b", localRatio: 0.9, spareSats: 1_000_000, keepRatio: 0.55, reason: "" },
    ],
  };
  seams.rebalanceReport = async () => ({ recommendations: [plan2] });
  const calls: RebalanceExecParams[] = [];
  let fail = true;
  seams.rebalanceExec = async (_w, p) => {
    calls.push(p);
    // The first source finds no route; the second is out of time this run.
    return fail
      ? { ...paidRebalance(p), ok: false, feeSats: null, costPpm: null, error: "no route", failedSourceIds: ["800000x1x0"] }
      : paidRebalance(p);
  };
  await autopilot.runOnce();
  assert.deepEqual(calls[0].sources?.map((s) => s.id), ["800000x1x0", "800002x1x0"]);
  assert.equal(calls[0].sources?.[0].keepRatio, 0.55, "the executor gets each source's share to keep");
  // The target's cooldown is over; the failed pair's back-off (2× it) is not.
  const state = (autopilot as unknown as { state: { perTargetLastRebalanced: Record<string, string> } }).state;
  state.perTargetLastRebalanced["800001x1x0"] = new Date(Date.now() - 61 * 60_000).toISOString();
  fail = false;
  await autopilot.runOnce();
  assert.deepEqual(calls[1].sources?.map((s) => s.id), ["800002x1x0"], "the failed pair waits; the target's other source is tried");
  // Before: one counter per target — the target waited out the back-off,
  // whatever source had failed.
});

test("the payback limit binds the gate: the full refill's fee isn't earned back within 21 days of the channel's revenue — the largest size whose fee is, is planned", async () => {
  // 1,000 ppm on 1M out (1,000 sat in 30 days: ~33 sat a day → 693 sat of
  // payback). A 600 ppm route: 1.25M costs 750 sat — within the cost cap
  // (800 ppm), but not earned back in time. Up to 1.15M (690 sat) is; 625k,
  // the half, nets less (250 sat against 310).
  const n = nodeOf(
    [drained(1, { feePpm: 1000, f14: flow(1_000_000, 0, 20, 1000), f30: flow(1_000_000, 0, 20, 1000) }), { n: 2, local: 4_000_000 }],
    { ...cfg, maxPpm: 3000 },
  );
  const { recommendations } = await plan(n, routeAt(600));
  const rec = recommendations.find((r) => r.channelId === "850000x1x0")!;
  assert.equal(rec.maxCostSatsByPayback, 693);
  assert.equal(rec.state, "route_found_profitable", rec.reasons.join(" | "));
  // Before (review of P7): 625k — only the planned size and its halves were tried.
  assert.equal(rec.recommendedAmount, 1_150_000, "the largest size whose fee pays back in time");
  assert.equal(rec.estimatedRouteFeeSats, 690);
  assert.equal(rec.maxFeeSats, 693, "the payment's cap at that size: the payback limit");
  assert.equal(rec.expectedNetProfitSats, 310);
});

// ── the plumbing, end to end ──────────────────────────────────────────────────

const ch = (id: string, n: number, o: Partial<FeeChannel> = {}): FeeChannel => ({
  id,
  partnerPublicKey: PEER(n),
  capacity: 5_000_000,
  localBalance: 2_500_000,
  transactionId: TX(n),
  transactionVout: 0,
  feeRatePpm: 100,
  baseFeeMsat: 0,
  ...o,
});

/** On a fake LND: a drained 5M target earning 400 ppm (1.2M routed out in 10
 *  days), a full idle channel funded at block 857,000 (~21 days ago: a
 *  4,320-block lease still runs) and a full one nobody bought. */
const soldNode = () =>
  feeNode({
    blockHeight: HEIGHT,
    channels: [
      ch("850000x1x0", 1, { localBalance: 750_000, feeRatePpm: 400 }),
      ch("857000x2x0", 2, { localBalance: 4_500_000 }),
      ch("850000x3x0", 3, { localBalance: 4_000_000 }),
    ],
    forwards: forwardsOut("850000x1x0", "850000x3x0", 20, { tokens: 60_000, feeMsat: 24_000, days: 10 }),
  });

/** The sources the autopilot's own report offers the drained target. */
const sourcesIn = (report: { recommendations: RebalanceRecommendation[] }) =>
  report.recommendations.find((r) => r.channelId === "850000x1x0")?.sourceCandidates.map((c) => c.channelId) ?? [];

test("end to end: a channel sold on Magma — its order journal says so — is never a source in the autopilot's own rebalance report; the same channel unsold is one", async (t) => {
  const now = new Date().toISOString();
  const sale = {
    orderId: "magma-2", phase: "settled", via: "autopilot", createdAt: now, updatedAt: now, buyerPubkey: PEER(9),
    sizeSats: 5_000_000, isPrivate: false, feeMsat: "12345000", leaseBlocks: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1,
    invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: `${TX(2)}:0`, settledAt: now, events: [],
  };
  const sold = autopilotWith(t, { rebalanceEnabled: true }, {}, { "magma-orders.json": [sale] }, soldNode());
  // Before the wiring: the buyer's channel (the fullest) led the list — the
  // rebalancer handed the buyer's paid inbound back.
  assert.deepEqual(sourcesIn(await sold.autopilot.rebalanceRecommendations()), ["850000x3x0"]);
  const unsold = autopilotWith(t, { rebalanceEnabled: true }, {}, {}, soldNode());
  assert.deepEqual(sourcesIn(await unsold.autopilot.rebalanceRecommendations()), ["857000x2x0", "850000x3x0"]);
});

test("end to end: a channel sold through LSPS1 — its order store says so — is never a source either (the service shares the app's capital ledger)", async (t) => {
  const dir = makeTempDir(t);
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, "lsps1-orders.json"),
    JSON.stringify([
      {
        orderId: "lsps-2", peer: PEER(2), createdAt: now, lspBalanceSat: 4_500_000, clientBalanceSat: 0,
        requiredChannelConfirmations: 1, fundingConfirmsWithinBlocks: 6, channelExpiryBlocks: 4_320, token: "",
        announceChannel: true, orderState: "COMPLETED", paymentState: "PAID", feeTotalSat: 20_000, orderTotalSat: 20_000,
        invoice: "", invoiceId: "ab".repeat(32), invoiceSecret: "cd".repeat(32), invoiceExpiresAt: now,
        channel: { fundedAt: now, fundingOutpoint: `${TX(2)}:0`, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() },
        serviceFeePaidSat: 0, feeRateCapPpm: 2200, baseFeeCapSats: 1,
      },
    ]),
  );
  const api = await startApi(t, { node: soldNode(), dir });
  assert.deepEqual(sourcesIn(await api.autopilot.rebalanceRecommendations()), ["850000x3x0"]);
});

test("a source the planner probed without a passing route is not handed to the executor — only the passing one and those not probed", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  const cand = (channelId: string, o: Record<string, unknown> = {}) => ({ channelId, alias: channelId, localRatio: 0.9, spareSats: 1_000_000, keepRatio: 0.55, reason: "", ...o });
  seams.rebalanceReport = async () => ({
    recommendations: [
      {
        ...plannedRebalance("800001x1x0", 500),
        selectedSourceChannel: "800002x1x0",
        // As planRebalances leaves them: the passing source first, then the
        // one probed before it (no route passed), then one not probed.
        sourceCandidates: [cand("800002x1x0"), cand("800000x1x0", { rejected: true, rejectedReason: "cheapest route 900 ppm, max 320" }), cand("800003x1x0")],
      },
    ],
  });
  const calls: RebalanceExecParams[] = [];
  seams.rebalanceExec = async (_w, p) => {
    calls.push(p);
    return paidRebalance(p);
  };
  await autopilot.runOnce();
  assert.deepEqual(calls[0]?.sources?.map((s) => s.id), ["800002x1x0", "800003x1x0"]);
});

test("possible demand is shown, never counted as earnings: refused HTLCs leave the gate's earnings, its fee cap and the expected net exactly as they are", async () => {
  // The same drained channel twice: without refusals, and with 5M of
  // de-noised refused HTLCs on 5 days (in demand).
  const quiet = nodeOf([drained(1), { n: 2, local: 4_000_000 }]);
  const refusing = nodeOf([drained(1), { n: 2, local: 4_000_000 }]);
  const ctx = refusing.contexts.get("850000x1x0") as BuildCtx;
  refusing.contexts.set("850000x1x0", { ...ctx, demand: { attempts: 20, days: 5, sats: 5_000_000, medianSats: 250_000 } });
  refusing.fees.splice(0, 1, buildRecommendation(refusing.channels[0], refusing.contexts.get("850000x1x0") as BuildCtx));
  assert.equal(refusing.fees[0].metrics.inDemand, true);
  assert.equal(refusing.fees[0].metrics.refusedSats14d, 5_000_000);
  assert.equal(refusing.fees[0].aimPpm, quiet.fees[0].aimPpm, "the same fee either way — only the refusals differ");
  const a = (await plan(quiet, routeAt(100))).recommendations.find((r) => r.channelId === "850000x1x0")!;
  const b = (await plan(refusing, routeAt(100))).recommendations.find((r) => r.channelId === "850000x1x0")!;
  assert.equal(b.refusedSats14d, 5_000_000, "shown on the row");
  assert.ok(b.reasons.some((x) => /^possible demand: 5M of refused HTLCs in 14 d .* — shown, not counted as earnings$/.test(x)), b.reasons.join(" | "));
  assert.deepEqual(
    [b.earningDemandSats, b.maxFeeSats, b.expectedNetProfitSats, b.recommendedAmount],
    [a.earningDemandSats, a.maxFeeSats, a.expectedNetProfitSats, a.recommendedAmount],
  );
  assert.equal(b.earningDemandSats, 1_200_000, "what it really routed out in 14 days");
});

test("a source whose spare balance is all planned for refills before this one is no candidate — the row says so, rather than 'no route'", async () => {
  // Two equally valuable drained channels and one source with 1.25M to
  // spare: the first takes all of it.
  const n = nodeOf([drained(1), drained(2), { n: 3, local: 4_000_000 }]);
  const { recommendations } = await plan(n, routeAt(100));
  const one = recommendations.find((r) => r.channelId === "850000x1x0")!;
  const two = recommendations.find((r) => r.channelId === "850000x2x0")!;
  assert.deepEqual([one.selectedSourceChannel, one.recommendedAmount], ["850000x3x0", 1_250_000]);
  assert.equal(two.state, "unprofitable_skip", two.reasons.join(" | "));
  assert.deepEqual(two.blockedBy, ["no safe source channel"]);
  assert.deepEqual(two.sourceCandidates, []);
  assert.ok(
    two.reasons.includes("no source channel has enough to spare — the others' spare balance is already planned for refills before this one"),
    two.reasons.join(" | "),
  );
});

test("a channel holding a refill's price (recovering its cost) is no source — pulling the refilled sats back out would undo the refill it is pricing", () => {
  // Full, idle-ish (inbound only — not draining), not the best earner.
  const specs: Spec[] = [drained(1), { n: 2, local: 4_500_000, feePpm: 400, f14: flow(0, 100_000, 2, 0), f30: flow(0, 200_000, 4, 0) }];
  const pool = (n: ReturnType<typeof nodeOf>) =>
    buildSourcePool(n.channels, n.feeById, {}, REBAL_REC_DEFAULTS, { soldLeases: [], currentBlock: HEIGHT }).map((s) => s.ch.id);
  assert.deepEqual(pool(nodeOf(specs)), ["850000x2x0"], "without a refill in it, it is a source");
  // The same channel with an autopilot refill two days ago still in it.
  const refilled = nodeOf(specs);
  const id = "850000x2x0";
  const lot = {
    at: new Date(NOW - 2 * 86_400_000).toISOString(),
    via: "autopilot" as const,
    targetId: id,
    targetAlias: "peer-2",
    sourceId: "850000x9x0",
    sourceAlias: "x",
    amountSats: 1_000_000,
    budgetPpm: 320,
    feeSats: 150,
    costPpm: 150,
    ok: true,
    targetSentBefore: 0,
    holdPpm: 400,
  };
  refilled.contexts.set(id, { ...(refilled.contexts.get(id) as BuildCtx), records: [lot] });
  const fee = buildRecommendation(refilled.channels[1], refilled.contexts.get(id) as BuildCtx);
  assert.equal(fee.state, "recovering_cost", fee.reasons.join(" | "));
  refilled.feeById.set(id, fee);
  assert.deepEqual(pool(refilled), []);
});

// ── what a turned-down refill would take (review of P3, issue 2) ─────────────
// The line asked for outflow and net drain the channel already had: it
// ignored the payback limit and how far the channel was from its target
// share. The two cases are the review's probes, A and A2.

test("probe A (review of P7): a refill the payback limit turned down at its planned size is planned at the largest size that pays back — 1.12M, not nothing", async () => {
  // A 5M channel at 15 % local, 1.2M out in 14 days at 400 ppm (480 sat in 30
  // days: ~16 sat a day, so at most 336 sat of payback), a 300 ppm route.
  // 1.25M planned costs ~375 sat; 625k and 312k don't net the 100 sat
  // minimum; 1.0M–1.12M clear both.
  const n = nodeOf([
    { n: 1, local: 750_000, feePpm: 400, f14: flow(1_200_000, 0, 20, 480), f30: flow(1_200_000, 0, 20, 480) },
    { n: 2, local: 4_500_000, feePpm: 100, f14: NO_FLOW, f30: flow(0, 50_000, 1, 0) },
  ]);
  const probed: number[] = [];
  const route = routeAt(300);
  const plan = await planRebalances(
    { channels: n.channels, fees: n.fees, contextOf: (id) => n.contexts.get(id), cfg: REBAL_REC_DEFAULTS, overrides: {}, soldLeases: [], currentBlock: HEIGHT },
    async (s, t, amount) => {
      probed.push(amount);
      return route(s, t, amount);
    },
  );
  const r = plan.recommendations.find((x) => x.channelId === "850000x1x0") as RebalanceRecommendation;
  // Before: route_found_too_expensive — no refill at all.
  assert.equal(r.state, "route_found_profitable", r.reasons.join(" | "));
  assert.deepEqual([r.recommendedAmount, r.estimatedRouteFeeSats, r.maxFeeSats, r.maxCostSatsByPayback, r.expectedNetProfitSats], [1_120_000, 336, 336, 336, 112]);
  assert.deepEqual(probed.sort((a, b) => b - a), [1_250_000, 1_120_000, 625_000, 312_500], "the fitted size is probed — once — beside the planned one and its halves");
  assert.match(r.reasons.join(" | "), /profitable: move 1\.12M from peer-2 at 300 ppm ≤ max 320, payback ~21d, net \+112 sat \(pays at most 336 sat\)/);
});

test("a refill the payback limit turns down at every size says so — the revenue a day or the route it would take — not outflow the channel already has (probe A, with an 18-day payback limit)", async () => {
  // As probe A, with fees to be earned back within 18 days (~16 sat a day:
  // at most 288 sat): a refill that pays back (≤ 960k at 300 ppm) nets the
  // 100 sat minimum only from 1M up — no size clears both.
  const n = nodeOf([
    { n: 1, local: 750_000, feePpm: 400, f14: flow(1_200_000, 0, 20, 480), f30: flow(1_200_000, 0, 20, 480) },
    { n: 2, local: 4_500_000, feePpm: 100, f14: NO_FLOW, f30: flow(0, 50_000, 1, 0) },
  ]);
  const plan = await planRebalances(
    {
      channels: n.channels,
      fees: n.fees,
      contextOf: (id) => n.contexts.get(id),
      cfg: { ...REBAL_REC_DEFAULTS, maxPaybackDays: 18 },
      overrides: {},
      soldLeases: [],
      currentBlock: HEIGHT,
    },
    routeAt(300),
  );
  const r = plan.recommendations.find((x) => x.channelId === "850000x1x0") as RebalanceRecommendation;
  assert.equal(r.state, "route_found_too_expensive");
  assert.deepEqual([r.recommendedAmount, r.estimatedRouteFeeSats, r.maxCostSatsByPayback], [1_250_000, 375, 288]);
  const line = r.reasons[r.reasons.length - 1];
  // Before (review of P3): "… it needs a refill of ≥ 1M: ≥ 1M of 14-day
  // outflow (now 1.2M) and ≥ 667k of 14-day net drain (now 1.2M)" — both met.
  assert.equal(
    line,
    "to clear the 100 sat minimum at 400 ppm earnings and a ~300 ppm route a refill nets it from 1M up; the 1.25M refill planned costs ~375 sat, " +
      "more than 18 days of this channel's revenue pay back (~16 sat a day now, so at most 288 sat) — that takes ≥ 21 sat a day of revenue, or a route of ≤ 230 ppm",
  );
  assert.doesNotMatch(line, /outflow|net drain/);
});

test("a channel only a little short of its target share says so — and what a refill that size would have to earn — not outflow it already has (probe A2)", async () => {
  // A 2M channel at 28 % local: 440k short of its 50 % share. 1M out, 0 in, a
  // 200 ppm route: a refill nets 100 sat only from 500k up.
  const n = nodeOf([
    { n: 1, capacity: 2_000_000, local: 560_000, feePpm: 400, f14: flow(1_000_000, 0, 20, 400), f30: flow(2_000_000, 0, 40, 800) },
    { n: 2, local: 4_500_000, feePpm: 100 },
  ]);
  const plan = await planRebalances(
    { channels: n.channels, fees: n.fees, contextOf: (id) => n.contexts.get(id), cfg: REBAL_REC_DEFAULTS, overrides: {}, soldLeases: [], currentBlock: HEIGHT },
    routeAt(200),
  );
  const r = plan.recommendations.find((x) => x.channelId === "850000x1x0") as RebalanceRecommendation;
  assert.equal(r.state, "unprofitable_skip");
  assert.equal(r.amountToReachTargetLocalRatio, 440_000);
  const line = r.reasons[r.reasons.length - 1];
  // Before: "… it needs a refill of ≥ 500k: ≥ 500k of 14-day outflow (now 1M)
  // and ≥ 333k of 14-day net drain (now 1M)" — a refill the channel can't take.
  assert.equal(
    line,
    "to clear the 100 sat minimum at a ~200 ppm route: the channel is only 440k short of its target share (50%), " +
      "and a refill that size nets 100 sat only with earnings of ≥ 428 ppm (now 400 ppm) or a route of ≤ 172 ppm",
  );
  assert.doesNotMatch(line, /outflow|net drain/);
});
