/**
 * A stuck rebalance payment must neither hold the autopilot run for hours nor
 * delay a Magma buyer.
 *
 * Before: executeRebalance awaited up to three payments, each resolving only
 * when its HTLCs resolved — an HTLC stuck downstream held the run (and with it
 * the shared lock the 3-minute Magma lane needed) for hours, with no CLTV
 * limit below LND's two weeks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REBALANCE_MAX_TIMEOUT_BLOCKS, executeRebalance } from "../src/services/rebalance.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { BUYER, autopilotWith, failedRebalance, paidRebalance, plannedRebalance, sellerSetup, type AutopilotSeams } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { AMBOSS_API } from "./helpers/amboss.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Short channel id "block x tx x out" as LND's numeric chan_id. */
const chanNumber = (id: string): string => {
  const [block, tx, out] = id.split("x").map((n) => BigInt(n));
  return ((block << 40n) | (tx << 16n) | out).toString();
};

function rebalanceNode(): FakeLnd {
  const node = new FakeLnd({
    channels: [
      { id: "800001x1x0", partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 200_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: "800002x1x0", partnerPublicKey: "02" + "b2".repeat(32), capacity: 2_000_000, localBalance: 1_800_000, transactionId: "b2".repeat(32), transactionVout: 0 },
    ],
  });
  node.override("default.feeReport", (_a, cb) =>
    cb(null, {
      channel_fees: ["800001x1x0", "800002x1x0"].map((id, i) => ({
        chan_id: chanNumber(id),
        channel_point: `${(i ? "b2" : "a1").repeat(32)}:0`,
        base_fee_msat: "1000",
        fee_per_mil: "500",
        inbound_base_fee_msat: 0,
        inbound_fee_per_mil: 0,
      })),
    }),
  );
  return node;
}

test("a rebalance payment that never resolves is reported in flight at the hard limit — no smaller amount is tried meanwhile, and its CLTV is capped", async () => {
  const node = rebalanceNode();
  node.payOutcome = "hang"; // an HTLC stuck at a downstream hop
  const started = Date.now();
  const res = await executeRebalance(
    node.lnd,
    node.lnd,
    { targetId: "800001x1x0", sourceId: "800002x1x0", amountSats: 400_000, econRatio: 0.8 },
    // The limit counts from the start of the rebalance, so it must leave room
    // for the reads and the invoice before the payment is sent: at 300 ms a
    // loaded machine (six suites at once) sometimes reached it before paying.
    { hardTimeoutMs: 1_500 },
  );
  assert.ok(Date.now() - started < 5_000, `returned after ${Date.now() - started} ms`);
  assert.equal(res.ok, false);
  assert.ok(res.inFlight, "reported as in flight, not as failed");
  assert.equal(res.inFlight.maxFeeSats, 160, "400k at the 400 ppm budget");
  assert.match(res.error ?? "", /still in flight/);
  const sent = node.callsTo("router.sendPaymentV2");
  assert.equal(sent.length, 1, "the next, smaller amount could pay twice if the first lands later");
  const limit = Number(sent[0].cltv_limit);
  assert.ok(limit > 0 && limit <= REBALANCE_MAX_TIMEOUT_BLOCKS, `cltv_limit ${sent[0].cltv_limit}`);
});

test("an in-flight rebalance counts its maximum fee against today's budget at once; a later run books what it really cost", async (t) => {
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 });
  seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500)] });
  seams.rebalanceExec = async (_w, p) => ({
    ...failedRebalance(p),
    error: "payment still in flight after 150s — it may still land; LightningMate keeps checking and logs how it ends",
    inFlight: { paymentId: "ab".repeat(32), maxFeeSats: 40 },
  });
  const saved = () =>
    JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as {
      pendingRebalances?: unknown[];
      perTargetRebalanceFails?: Record<string, number>;
      perPairRebalanceFails?: Record<string, unknown>;
    };
  const run = await autopilot.runOnce();
  assert.match(run.rebalances[0]?.error ?? "", /in flight/);
  assert.equal(autopilot.rebalanceBudget().spentSats, 40, "the most it can cost is spent until we know better");
  assert.equal(autopilot.rebalanceBudget().inFlightSats, 40);
  assert.equal(saved().pendingRebalances?.length, 1);
  assert.equal(saved().perTargetRebalanceFails?.["800001x1x0"], undefined, "not a failure (yet)");
  assert.deepEqual(saved().perPairRebalanceFails ?? {}, {}, "no pair backs off for it either");

  const status = autopilot as unknown as { rebalancePaymentStatus: (id: string) => Promise<unknown> };
  status.rebalancePaymentStatus = async () => ({ state: "pending" });
  seams.rebalanceReport = async () => ({ recommendations: [] });
  await autopilot.runOnce();
  assert.equal(saved().pendingRebalances?.length, 1, "still in flight: still counted");

  status.rebalancePaymentStatus = async () => ({ state: "confirmed", feeSats: 12 });
  await autopilot.runOnce();
  assert.equal(autopilot.rebalanceBudget().spentSats, 12, "corrected to the real fee");
  assert.equal(saved().pendingRebalances?.length, 0);
});

test("a failed in-flight rebalance gives its fee back to today's budget — and backs off its source → target pair, as a failure there does", async (t) => {
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 });
  seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500)] });
  seams.rebalanceExec = async (_w, p) => ({ ...failedRebalance(p), inFlight: { paymentId: "cd".repeat(32), maxFeeSats: 40 } });
  await autopilot.runOnce();
  (autopilot as unknown as { rebalancePaymentStatus: () => Promise<unknown> }).rebalancePaymentStatus = async () => ({ state: "failed" });
  seams.rebalanceReport = async () => ({ recommendations: [] });
  await autopilot.runOnce();
  assert.equal(autopilot.rebalanceBudget().spentSats, 0);
  const s = JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as {
    pendingRebalances?: unknown[];
    perPairRebalanceFails?: Record<string, { fails: number }>;
  };
  assert.deepEqual(s.pendingRebalances, []);
  assert.equal(s.perPairRebalanceFails?.["800000x1x0>800001x1x0"]?.fails, 1, "the pair whose payment failed backs off");
});

test("a slow rebalance payment doesn't hold up the Magma order lane", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const { autopilot, magma } = sellerSetup(t, { config: { rebalanceEnabled: true } });
  const seams = autopilot as unknown as AutopilotSeams;
  seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500)] });
  let release = () => undefined as void;
  const released = new Promise<void>((r) => (release = r));
  t.after(() => release());
  let paying = false;
  seams.rebalanceExec = async (_w, p) => {
    paying = true;
    await released; // the HTLC is out; LND hasn't said how it ended
    return paidRebalance(p);
  };
  const run = autopilot.runOnce();
  for (let i = 0; i < 200 && !paying; i++) await sleep(5);
  assert.ok(paying, "the main run is in its payment");

  // A buyer's order arrives meanwhile: the lane serves it now, not after the payment.
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted while the run still waits");
  assert.equal(autopilot.isRunning(), true);
  assert.ok(autopilot.getState().runningSince, "the run in progress is visible, with its start");

  release();
  await run;
  assert.equal(autopilot.isRunning(), false);
  assert.equal(autopilot.getState().runningSince, null);
});

test("a payment left in flight is reconciled on the next run even with rebalancing switched off (or outside its window)", async (t) => {
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, enabled: true, rebalanceDailyBudgetSats: 1_000 });
  seams.feeReport = async () => ({ recommendations: [] });
  seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500)] });
  seams.rebalanceExec = async (_w, p) => ({ ...failedRebalance(p), inFlight: { paymentId: "ef".repeat(32), maxFeeSats: 40 } });
  await autopilot.runOnce();
  autopilot.setConfig({ rebalanceEnabled: false });
  (autopilot as unknown as { rebalancePaymentStatus: () => Promise<unknown> }).rebalancePaymentStatus = async () => ({ state: "confirmed", feeSats: 9 });
  await autopilot.runOnce(); // a fee run; rebalancing is off
  const s = JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as { pendingRebalances?: unknown[] };
  // Before: reconciled only inside the rebalance stage — with rebalancing
  // off, the 40 sat stayed charged and the payment pending, indefinitely.
  assert.equal(s.pendingRebalances?.length, 0);
  assert.equal(autopilot.rebalanceBudget().spentSats, 9, "the real fee, not the maximum");
});

test("a channel with a payment still in flight is not rebalanced again — target or source — even after its cooldown", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  const plan = plannedRebalance("800001x1x0", 500); // drains 800000x1x0
  seams.rebalanceReport = async () => ({ recommendations: [plan] });
  const paid: string[] = [];
  seams.rebalanceExec = async (_w, p) => {
    paid.push(`${p.sourceId}→${p.targetId}`);
    return { ...failedRebalance(p), sourceId: p.sourceId, inFlight: { paymentId: "fa".repeat(32), maxFeeSats: 40 } };
  };
  await autopilot.runOnce();
  assert.equal(paid.length, 1);

  // The cooldown is over; LND still has the first payment in flight.
  const state = (autopilot as unknown as { state: { perTargetLastRebalanced: Record<string, string> } }).state;
  state.perTargetLastRebalanced["800001x1x0"] = new Date(Date.now() - 7 * 86_400_000).toISOString();
  (autopilot as unknown as { rebalancePaymentStatus: () => Promise<unknown> }).rebalancePaymentStatus = async () => ({ state: "pending" });
  await autopilot.runOnce();
  assert.equal(paid.length, 1, "the same target: not again while the first may still land");

  // Another target, but drawing from the channel the in-flight payment drains.
  seams.rebalanceReport = async () => ({ recommendations: [{ ...plannedRebalance("800003x1x0", 500), selectedSourceChannel: plan.selectedSourceChannel }] });
  await autopilot.runOnce();
  assert.equal(paid.length, 1, "nor its source");

  // It ended: the channel is free again.
  (autopilot as unknown as { rebalancePaymentStatus: () => Promise<unknown> }).rebalancePaymentStatus = async () => ({ state: "failed" });
  await autopilot.runOnce();
  assert.equal(paid.length, 2);
});

test("a manual rebalance still in flight is tracked: logged as it really ended (not as a failure), and counted in the daily budget at its maximum fee until then", async (t) => {
  t.mock.method(console, "log", () => undefined);
  // A main run refreshes Amboss's public sale history in the background.
  installFetchMock(t).onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const api = await startApi(t, { node: new FakeLnd() });
  const ap = api.autopilot as unknown as AutopilotSeams & {
    rebalancePaymentStatus: (id: string) => Promise<unknown>;
    checkInFlightRebalances(): Promise<void>;
    inflightTimer: unknown;
  };
  ap.rebalanceExec = async (_w, p) => ({
    ...failedRebalance(p),
    error: "payment still in flight after 150s — it may still land; LightningMate keeps checking and logs how it ends",
    inFlight: { paymentId: "ab".repeat(32), maxFeeSats: 40 },
  });
  const res = await api.request("POST", "/rebalance/execute", { targetId: "800001x1x0", sourceId: "800002x1x0", amountSats: 400_000 });
  assert.equal(res.status, 200);
  assert.equal(res.body.inFlight?.paymentId, "ab".repeat(32));
  const records = async () =>
    ((await api.request("GET", "/rebalance/log")).body.records as { via: string; ok: boolean; feeSats: number | null; sourceId: string }[]).filter(
      (r) => r.via === "manual",
    );
  const saved = () =>
    JSON.parse(readFileSync(join(api.dir, "autopilot.json"), "utf8")) as {
      pendingRebalances?: { via?: string }[];
    };
  // Before: logged ok:false at once and never looked at again — a payment
  // that landed later stayed "failed", its fee missing from P&L.
  assert.deepEqual(await records(), [], "not logged as failed: it may still land");
  assert.deepEqual(saved().pendingRebalances?.map((p) => p.via), ["manual"]);
  // One daily budget for every refill (review a2: manual runs bypassed it).
  assert.equal(api.autopilot.rebalanceBudget().spentSats, 40, "its maximum fee counts until LND knows");

  // Meanwhile the autopilot leaves both of its channels alone — and pays
  // for a move elsewhere (7 sat) out of the same daily budget.
  api.autopilot.setConfig({ rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 });
  ap.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500), plannedRebalance("800003x1x0", 400)] });
  const autopilotPayments: string[] = [];
  ap.rebalanceExec = async (_w, p) => {
    autopilotPayments.push(p.targetId);
    return paidRebalance(p, 7);
  };
  ap.rebalancePaymentStatus = async () => ({ state: "pending" });
  await api.autopilot.runOnce();
  assert.deepEqual(autopilotPayments, ["800003x1x0"], "no second move on a channel whose payment may still land");
  assert.equal(api.autopilot.rebalanceBudget().spentSats, 47);

  // With every automation off there is no main run: the in-flight check
  // (every few minutes, whenever writing is possible) asks LND instead.
  api.autopilot.setConfig({ rebalanceEnabled: false });
  api.autopilot.start();
  assert.ok(ap.inflightTimer, "the check runs whenever writing is possible");
  await ap.checkInFlightRebalances();
  assert.deepEqual(await records(), [], "still in flight: still nothing to log");
  ap.rebalancePaymentStatus = async () => ({ state: "confirmed", feeSats: 12 });
  await ap.checkInFlightRebalances();
  const [rec] = await records();
  assert.equal(rec?.via, "manual");
  assert.equal(rec?.ok, true, "it landed — and the log says so");
  assert.equal(rec?.feeSats, 12, "with its real fee (P&L)");
  assert.equal(rec?.sourceId, "800002x1x0");
  assert.deepEqual(saved().pendingRebalances, []);
  assert.equal(api.autopilot.rebalanceBudget().spentSats, 19, "the manual refill's real 12 sat and the autopilot's 7");
});
