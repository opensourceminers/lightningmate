/**
 * A manual refill run from a stale row of the Rebalancing tab (P3's final
 * review, carried into package P4).
 *
 * Before: the tab loads its plan once. After the autopilot refilled a
 * target, the row's Run button still paid a second refill into it at once —
 * valued on the same 14-day outflow as the first, booked with the same hold.
 * And the hold was taken as sent: where the channel's fee had dropped below
 * the row's value since the plan, the fee engine ramped the fee back up
 * toward it (300 → 340 'profit floor … ramping').
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRebalanceRecommendations, type RebalanceRecommendation } from "../src/services/rebalanceRecommend.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { autopilotWith, type AutopilotSeams } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { feeNode, forwardsOut, withMarket, type FeeChannel } from "./helpers/feeNode.js";

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const HEIGHT = 860_000;
const TARGET = "850000x1x0";
const SOURCE = "850000x2x0";

/** A drained 5M target (fee `ppm`, LND's sent counter at 3,333,333) routing
 *  1.2M out in 10 days, a full 5M source, and a market into the target's peer. */
function routingNode(ppm = 400) {
  const channels: FeeChannel[] = [
    { id: TARGET, partnerPublicKey: PEER(1), capacity: 5_000_000, localBalance: 750_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: ppm, baseFeeMsat: 0, totalSent: 3_333_333 },
    { id: SOURCE, partnerPublicKey: PEER(2), capacity: 5_000_000, localBalance: 4_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
  ];
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards: forwardsOut(TARGET, SOURCE, 20, { tokens: 60_000, feeMsat: 24_000, days: 10 }) });
  withMarket(node, channels, { [TARGET]: { intoPpm: 100, backPpm: 50 } });
  return node;
}

/** The autopilot's plan for the target (only the fields it reads). */
const plannedRefill = {
  channelId: TARGET,
  alias: "router",
  wouldRebalance: true,
  recommendedAmount: 400_000,
  selectedSourceChannel: SOURCE,
  sourceCandidates: [{ channelId: SOURCE, alias: "src", localRatio: 0.8, spareSats: 1_250_000, keepRatio: 0.55, reason: "" }],
  estimatedRouteFeeSats: 20,
  expectedNetProfitSats: 300,
  maxCostPpm: 320,
  maxCostSatsByPayback: 1_000,
  expectedRevenuePpm: 400,
  earningDemandSats: 1_200_000,
  minNetProfitSats: 100,
} as unknown as RebalanceRecommendation;

/** What the tab sends for that row (manualRefillRequest), from a plan made at `planAt`. */
const tabRequest = (planAt?: string) => ({
  targetId: TARGET,
  sourceId: SOURCE,
  amountSats: 400_000,
  econRatio: 0.8,
  maxFeePpm: 320,
  maxFeeSats: 380,
  gate: { revenuePpm: 400, demandSats: 1_200_000, minNetSats: 100 },
  ...(planAt ? { planAt } : {}),
});

test("a row planned before the autopilot refilled its target is refused (409 stale_plan) and nothing is sent; a fresh plan still runs inside the cooldown", async (t) => {
  t.mock.method(console, "log", () => undefined);
  installFetchMock(t).onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const node = routingNode();
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  (api.autopilot as unknown as AutopilotSeams).rebalanceReport = async () => ({ recommendations: [plannedRefill] });

  // The tab loaded its plan; then the autopilot's run refilled the target
  // through the real executor.
  const planAt = new Date(Date.now() - 1_000).toISOString();
  await api.autopilot.runOnce();
  const paid = () => node.callsTo("router.sendPaymentV2").length;
  assert.equal(paid(), 1, "the autopilot's refill");
  node.channels[0].localBalance += 400_000;
  node.channels[1].localBalance -= 400_000;

  const stale = await api.request("POST", "/rebalance/execute", tabRequest(planAt));
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, "stale_plan");
  assert.equal(stale.body.message, "This channel was refilled (or tried) after this plan was made: reload it");
  assert.equal(stale.body.targetId, TARGET);
  assert.equal(paid(), 1, "nothing was sent");
  assert.deepEqual(
    new RebalanceLog(api.dir).successes().map((r) => r.via),
    ["autopilot"],
    "only the autopilot's refill is booked",
  );

  // A plan made after that refill: an explicit run, not held back by the
  // target's cooldown (the deliberate bypass).
  const fresh = await api.request("POST", "/rebalance/execute", tabRequest(new Date().toISOString()));
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.ok, true, fresh.body.error);
  assert.equal(paid(), 2);
  // A request without a plan time (an API client of its own) is not checked.
  const unchecked = await api.request("POST", "/rebalance/execute", tabRequest());
  assert.equal(unchecked.status, 200, JSON.stringify(unchecked.body));
  // A malformed plan time is a bad request, not a run.
  const bad = await api.request("POST", "/rebalance/execute", { ...tabRequest(), planAt: "yesterday" });
  assert.equal(bad.status, 400);
  assert.equal(paid(), 3);
});

test("a manual run's hold is booked at the target's fee when the gate it carries is above it — in the write-ahead record and in the log — so the fee engine doesn't ramp the fee back up", async (t) => {
  t.mock.method(console, "log", () => undefined);
  // The row valued the refill at 400 ppm; the channel charges 300 now.
  const node = routingNode(300);
  const { autopilot, dir } = autopilotWith(t, { rebalanceDailyBudgetSats: 10_000 }, {}, {}, node);
  const seen: { pending: { holdPpm?: number }[] | null } = { pending: null };
  node.beforeCall = (method) => {
    if (method !== "router.sendPaymentV2") return;
    // What a restart would find on disk while the payment is under way.
    seen.pending = JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")).pendingRebalances;
  };
  const res = await autopilot.rebalanceByHand(tabRequest(new Date().toISOString()));
  assert.equal(res?.ok, true, res?.error);
  assert.equal(res?.targetPpm, 300, "the executor reports the fee it read");
  assert.deepEqual(seen.pending?.map((p) => p.holdPpm), [300], "the write-ahead record holds the current fee, not the gate's 400");
  const [booked] = new RebalanceLog(dir).successes();
  assert.deepEqual([booked?.via, booked?.holdPpm], ["manual", 300]);
  node.channels[0].localBalance += 400_000;
  const seam = autopilot as unknown as { feeReport(e: Map<string, number>): Promise<{ recommendations: { channelId: string; targetPpm: number; reasons: string[]; metrics: { profitFloorPpm: number | null } }[] }> };
  const fee = (await seam.feeReport(new Map())).recommendations.find((r) => r.channelId === TARGET)!;
  // Before: floor 400 — "profit floor … ramping 300→340".
  assert.equal(fee.metrics.profitFloorPpm, 300);
  assert.ok(!fee.reasons.some((x) => /ramping/.test(x)), fee.reasons.join(" | "));
  // A gate at or below the fee is booked as it is (the autopilot's case).
  const node2 = routingNode(500);
  const second = autopilotWith(t, { rebalanceDailyBudgetSats: 10_000 }, {}, {}, node2);
  const res2 = await second.autopilot.rebalanceByHand(tabRequest(new Date().toISOString()));
  assert.equal(res2?.ok, true, res2?.error);
  assert.equal(new RebalanceLog(second.dir).successes()[0]?.holdPpm, 400);
});

// ── review of P4: the refill's END counts too ─────────────────────────────────

test("a plan made while the autopilot's refill of the target was under way — after its start, before it landed — is refused too: its row read the channel drained", async (t) => {
  t.mock.method(console, "log", () => undefined);
  installFetchMock(t).onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const node = routingNode();
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  (api.autopilot as unknown as AutopilotSeams).rebalanceReport = async () => ({ recommendations: [plannedRefill] });
  // The tab's plan is stamped while the autopilot's payment is on its way:
  // after the refill started (its cooldown stamp), before it is booked.
  let planAt = "";
  node.beforeCall = (method) => {
    if (method !== "router.sendPaymentV2" || planAt) return;
    planAt = new Date().toISOString();
    const until = Date.now() + 5;
    while (Date.now() < until) {
      // the payment takes a moment: it lands (and is booked) after the plan
    }
  };
  await api.autopilot.runOnce();
  const paid = () => node.callsTo("router.sendPaymentV2").length;
  assert.equal(paid(), 1, "the autopilot's refill");
  const [booked] = new RebalanceLog(api.dir).successes();
  assert.ok(Date.parse(booked.startedAt ?? "") <= Date.parse(planAt) && Date.parse(planAt) < Date.parse(booked.at), "the plan falls inside the refill");

  const res = await api.request("POST", "/rebalance/execute", tabRequest(planAt));
  assert.deepEqual([res.status, res.body.error], [409, "stale_plan"], JSON.stringify(res.body));
  assert.equal(res.body.lastAt, booked.at, "named by when the refill landed");
  assert.equal(paid(), 1, "nothing was sent");
  assert.deepEqual(new RebalanceLog(api.dir).successes().map((r) => r.via), ["autopilot"]);
});

test("a plan is stamped BEFORE its inputs are read: a refill that started while the channels were read is newer than the plan", async () => {
  const node = routingNode();
  let firstReadAt = 0;
  node.beforeCall = () => {
    if (firstReadAt) return;
    firstReadAt = Date.now();
    const until = firstReadAt + 5;
    while (Date.now() < until) {
      // the reads take a while
    }
  };
  const plan = await getRebalanceRecommendations(node.lnd, { rebalanceRecords: [], cooldown: null });
  assert.ok(firstReadAt > 0, "the plan read the node");
  assert.ok(Date.parse(plan.generatedAt) <= firstReadAt, `stamped ${plan.generatedAt}, first read at ${new Date(firstReadAt).toISOString()}`);
});
