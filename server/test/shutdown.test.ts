import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { createHttpApp } from "../src/app.js";
import { storeIncidents } from "../src/store.js";
import { RequestGate, SHUTDOWN_WAIT_MS, appShutdownSteps, createShutdown, type ShutdownParts } from "../src/shutdown.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import { JsonStore } from "../src/store.js";
import type { MagmaJournalEntry } from "../src/services/magmaJournal.js";
import { Autopilot, type AutopilotRun } from "../src/services/autopilot.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { SettingsStore } from "../src/services/settings.js";
import { Lsps1Service, type Lsps1Order } from "../src/services/lsps1.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { flushHtlcTelemetry, initHtlcTelemetry, recordForwardEvent, stopHtlcTelemetry } from "../src/services/htlcTelemetry.js";
import type { RebalanceRecommendation } from "../src/services/rebalanceRecommend.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { feeNode, type FeeChannel } from "./helpers/feeNode.js";
import { BUYER, autopilotWith, paidRebalance, plannedRebalance, sellerSetup, suggestion } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";

const quiet = () => undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
    await sleep(5);
  }
}

/** Work that holds until the test releases it — a request handler, a
 *  payment, LND still opening a channel. Released after the test whatever
 *  happens, so nothing is left hanging after a failed assertion. */
function heldUntilReleased(t: AfterHook) {
  let release = () => undefined as void;
  const released = new Promise<void>((r) => (release = r));
  t.after(() => release());
  return { released, release: () => release() };
}

test("runs every step in order, waits for async work, then exits 0", async () => {
  const order: string[] = [];
  const codes: number[] = [];
  const handler = createShutdown({
    graceMs: 2_000,
    exit: (c) => codes.push(c),
    log: quiet,
    steps: [
      { name: "stop", run: () => void order.push("stop") },
      { name: "wait", run: () => new Promise((r) => setTimeout(() => r(order.push("wait")), 50)) },
      { name: "flush", run: () => void order.push("flush") },
    ],
  });
  await handler("SIGTERM");
  assert.deepEqual(order, ["stop", "wait", "flush"]);
  assert.deepEqual(codes, [0]);
});

test("a hung wait cannot starve the flush, and a second signal exits at once", async () => {
  const done: string[] = [];
  const codes: number[] = [];
  const handler = createShutdown({
    graceMs: 150,
    exit: (c) => codes.push(c),
    log: quiet,
    steps: [
      { name: "wait forever", run: () => new Promise(() => undefined) },
      { name: "close", run: () => void done.push("close") },
      { name: "flush", always: true, run: () => void done.push("flush") },
    ],
  });
  const first = handler("SIGTERM");
  await handler("SIGTERM"); // impatient operator
  assert.deepEqual(codes, [1]);
  await first;
  assert.deepEqual(done, ["flush"], "the grace was used up, but state is still flushed");
  assert.deepEqual(codes, [1, 0]);
});

test("a step cut off by the grace leaves none for the next, even when the clock lags the timer", async (t) => {
  // setTimeout can fire a millisecond before Date.now() agrees the time is
  // up. The wall clock below lags the timer by exactly that millisecond.
  const graceMs = 100;
  const start = Date.now();
  let hung = false;
  t.mock.method(Date, "now", () => (hung ? start + graceMs - 1 : start));
  const done: string[] = [];
  await createShutdown({
    graceMs,
    exit: () => undefined,
    log: quiet,
    steps: [
      {
        name: "wait forever",
        run: () => {
          hung = true;
          return new Promise(() => undefined);
        },
      },
      { name: "close", run: () => void done.push("close") },
      { name: "flush", always: true, run: () => void done.push("flush") },
    ],
  })("SIGTERM");
  // Before: 1 ms "left" after the hung step, so "close" still ran — the
  // shutdown test above failed about once in a hundred runs.
  assert.deepEqual(done, ["flush"]);
});

/** The app's shutdown parts as fakes that note every call, in order. The
 *  waits finish after a while, like work still under way. */
function recordingParts(waits: { autopilotMs?: number; lspMs?: number; requestsMs?: number } = {}) {
  const calls: string[] = [];
  const note = (name: string) => () => void calls.push(name);
  const finishes = (name: string, ms: number | undefined) => async () => {
    if (ms === undefined) await new Promise(() => undefined); // never
    else await new Promise((r) => setTimeout(r, ms));
    calls.push(name);
    return true;
  };
  const parts: ShutdownParts = {
    requests: { close: note("requests.close"), waitIdle: finishes("requests.idle", waits.requestsMs) },
    autopilot: {
      shutdown: note("autopilot.shutdown"),
      waitIdle: finishes("autopilot.idle", waits.autopilotMs),
      flush: note("autopilot.flush"),
    },
    lsps1: { stop: note("lsps1.stop"), waitForOpens: finishes("lsps1.idle", waits.lspMs) },
    serviceFees: { stop: note("fees.stop") },
    telemetry: { stop: note("telemetry.stop"), flush: note("telemetry.flush") },
    closeServer: async () => void calls.push("server.close"),
  };
  return { calls, parts };
}

test("the app's shutdown stops everything first, waits for all work under way, then flushes and closes", async () => {
  // A manual channel open still answering, an autopilot pass in a payment,
  // an LSP channel open between broadcast and its record on disk.
  const { calls, parts } = recordingParts({ requestsMs: 30, autopilotMs: 50, lspMs: 40 });
  const codes: number[] = [];
  await createShutdown({ graceMs: 2_000, exit: (c) => codes.push(c), log: quiet, steps: appShutdownSteps(parts, 1_000) })(
    "SIGTERM",
  );
  assert.equal(calls[0], "requests.close", "the API takes no new write before anything else happens");
  const stops = ["requests.close", "autopilot.shutdown", "lsps1.stop", "fees.stop", "telemetry.stop"];
  // Every source of new work is stopped before the waiting starts: without
  // that, a timer could start a run, an LSP open or a fee payment meanwhile.
  assert.deepEqual(calls.slice(0, stops.length).sort(), [...stops].sort(), calls.join(", "));
  const at = (name: string) => {
    const i = calls.indexOf(name);
    assert.ok(i >= 0, `${name} never happened: ${calls.join(", ")}`);
    return i;
  };
  for (const work of ["requests.idle", "autopilot.idle", "lsps1.idle"]) {
    assert.ok(at(work) > stops.length - 1, `${work} is waited for after the stops`);
    assert.ok(at(work) < at("autopilot.flush"), `${work} before the autopilot's state is flushed`);
    assert.ok(at(work) < at("telemetry.flush"), `${work} before the telemetry is flushed`);
  }
  assert.ok(at("autopilot.flush") < at("server.close"));
  assert.ok(at("telemetry.flush") < at("server.close"));
  assert.equal(calls.at(-1), "server.close");
  assert.deepEqual(codes, [0]);
});

test("a hung autopilot pass can use up the grace, but never the flush", async () => {
  const { calls, parts } = recordingParts({ requestsMs: 0, lspMs: 0 }); // the autopilot never goes idle
  const codes: number[] = [];
  const started = Date.now();
  await createShutdown({ graceMs: 200, exit: (c) => codes.push(c), log: quiet, steps: appShutdownSteps(parts, 1_000) })(
    "SIGTERM",
  );
  assert.ok(Date.now() - started < 5_000, "the wait was cut off with the grace, not left to hang");
  assert.ok(calls.includes("autopilot.flush"), `state is still saved: ${calls.join(", ")}`);
  assert.ok(calls.includes("telemetry.flush"));
  assert.ok(!calls.includes("server.close"), "only what must run runs after the grace");
  assert.deepEqual(codes, [0]);
});

test("stop() also cancels the 'run soon after enabling' kicks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dir = makeTempDir(t);
  const node = new FakeLnd();
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    new AmbossStore(dir),
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  let runs = 0;
  t.mock.method(autopilot, "runOnce", async () => {
    runs += 1;
    return {} as AutopilotRun;
  });
  autopilot.setConfig({ enabled: true });
  autopilot.stop();
  t.mock.timers.tick(2 * 3_600_000);
  assert.equal(runs, 0, "nothing fires after stop()");
});

test("after shutdown() no new autopilot pass starts", async (t) => {
  const dir = makeTempDir(t);
  const node = new FakeLnd();
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    new AmbossStore(dir),
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  autopilot.shutdown();
  const run = await autopilot.runOnce();
  assert.equal(run.attempted, 0);
  assert.equal(autopilot.getState().lastRunAt, null);
  assert.equal(node.calls.length, 0, "the node was not touched");
  assert.equal(await autopilot.waitIdle(100), true);
});

test("a settings save that lands during the shutdown schedules nothing new", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dir = makeTempDir(t);
  const node = new FakeLnd();
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    new AmbossStore(dir),
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  const started: string[] = [];
  t.mock.method(autopilot, "runOnce", async () => {
    started.push("run");
    return {} as AutopilotRun;
  });
  t.mock.method(autopilot, "pollSellOrders", async () => void started.push("poll"));
  autopilot.shutdown();
  // A POST /autopilot already under way when SIGTERM came is let finish —
  // it saves, but must not re-arm the timers the shutdown just cleared.
  autopilot.setConfig({ enabled: true, sellEnabled: true });
  t.mock.timers.tick(2 * 3_600_000);
  assert.deepEqual(started, []);
  assert.equal(autopilot.getState().config.enabled, true, "the save itself went through");
});

test("the shutdown waits for an autopilot payment still in flight", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true });
  seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500)] });
  const { released, release } = heldUntilReleased(t);
  let paying = false;
  seams.rebalanceExec = async (_writeLnd, p) => {
    paying = true;
    await released; // the HTLC is out; LND hasn't said how it ended
    return paidRebalance(p);
  };
  const run = autopilot.runOnce();
  await waitFor(() => paying, "the payment is under way");
  autopilot.shutdown();
  let idle: boolean | undefined;
  const waited = autopilot.waitIdle(5_000).then((v) => (idle = v));
  await sleep(200);
  // Exiting now would forget what it spent: perDayRebalanceSpend, the
  // cooldown and the backoff are recorded only once the payment returns.
  assert.equal(idle, undefined, "still waiting while the payment is in flight");
  release();
  assert.equal((await run).rebalances[0]?.ok, true);
  await waited;
  assert.equal(idle, true, "idle once the payment came back and was recorded");
});

test("the shutdown waits for a manual refill's payment still in flight too — it no longer holds the main run's lock", async (t) => {
  const { autopilot, seams } = autopilotWith(t, {});
  const { released, release } = heldUntilReleased(t);
  let paying = false;
  seams.rebalanceExec = async (_writeLnd, p) => {
    paying = true;
    await released; // the HTLC is out; LND hasn't said how it ended
    return paidRebalance(p);
  };
  const manual = autopilot.rebalanceByHand({ targetId: "800001x1x0", sourceId: "800002x1x0", amountSats: 400_000, econRatio: 0.8 });
  await waitFor(() => paying, "the manual refill is paying");
  autopilot.shutdown();
  let idle: boolean | undefined;
  const waited = autopilot.waitIdle(5_000).then((v) => (idle = v));
  await sleep(200);
  assert.equal(idle, undefined, "still waiting while the payment is in flight");
  release();
  assert.equal((await manual)?.ok, true);
  await waited;
  assert.equal(idle, true, "idle once the refill came back and was booked");
});

test("the shutdown waits for an LSP channel open until its funding outpoint is on disk", async (t) => {
  const { dir, svc, seams, order } = lspWithHeldOrder(t);
  const { released, release } = heldUntilReleased(t);
  let opening = false;
  seams.lndOpen = async () => {
    opening = true;
    await released; // LND is broadcasting the funding transaction
    return { ok: true, transactionId: "cc".repeat(32), transactionVout: 1 };
  };
  const fulfilled = seams.fulfill(order);
  await waitFor(() => opening, "the open is under way");
  svc.stop(); // SIGTERM
  let idle: boolean | undefined;
  let onDiskWhenIdle: string | undefined;
  const waited = svc.waitForOpens(5_000).then((v) => {
    idle = v;
    const saved = JSON.parse(readFileSync(join(dir, "lsps1-orders.json"), "utf8")) as Lsps1Order[];
    onDiskWhenIdle = saved.find((o) => o.orderId === order.orderId)?.channel?.fundingOutpoint;
  });
  await sleep(200);
  // Exiting now: the channel may be funded with nothing on disk to say so,
  // and restart recovery would open a SECOND one for this paid order.
  assert.equal(idle, undefined, "still waiting while the open is in flight");
  release();
  await fulfilled;
  await waited;
  assert.equal(idle, true);
  assert.equal(onDiskWhenIdle, `${"cc".repeat(32)}:1`, "the outpoint was saved before the wait let go");
  assert.equal(order.channel?.fundingOutpoint, `${"cc".repeat(32)}:1`);
});

test("a shutdown mid-run: the rebalance in flight finishes, nothing planned after it starts", async (t) => {
  const { autopilot, node, seams } = autopilotWith(t, { rebalanceEnabled: true, channelEnabled: true });
  seams.rebalanceReport = async () => ({
    recommendations: [plannedRebalance("800001x1x0", 500), plannedRebalance("800002x1x0", 400)],
  });
  const paid: string[] = [];
  seams.rebalanceExec = async (_writeLnd, p) => {
    paid.push(p.targetId);
    autopilot.shutdown(); // SIGTERM arrives while this payment is in flight
    await new Promise((r) => setTimeout(r, 20));
    return paidRebalance(p);
  };
  seams.channelSuggestions = async () => ({ suggestions: [suggestion] });

  const run = await autopilot.runOnce();
  assert.deepEqual(paid, ["800001x1x0"], "only the payment already under way");
  // The move left undone is a deliberate skip, not a failed attempt (D15):
  // it is in the rebalance decision, not a red line in the run history.
  assert.equal(run.rebalances.length, 1);
  assert.equal(run.rebalances[0].ok, true, "it finished and is recorded");
  assert.equal(run.failed, 0);
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", /peer-800002x1x0: skipped, shutting down/);
  assert.deepEqual(run.channels, [], "the channel stage doesn't even start planning");
  assert.equal(node.callsTo("default.openChannel").length, 0, "no channel open after the signal");
  assert.equal(await autopilot.waitIdle(100), true);
});

// ── inside one refill: no new attempt after the signal ─────────────────────────

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const TARGET = "850000x1x0";
const SRC_A = "850000x3x0";
const SRC_B = "850000x5x0";

/** A drained 5M target at 400 ppm and two full 5M sources on a fake LND;
 *  a payment left hanging fails when the test ends. */
function refillNode(t: AfterHook) {
  const ch = (id: string, n: number, o: Partial<FeeChannel> = {}): FeeChannel => ({
    id, partnerPublicKey: PEER(n), capacity: 5_000_000, localBalance: 4_000_000, transactionId: TX(n), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0, ...o,
  });
  const node = feeNode({ channels: [ch(TARGET, 1, { localBalance: 750_000, feeRatePpm: 400 }), ch(SRC_A, 3), ch(SRC_B, 5)] });
  t.after(() => {
    for (const p of node.payments.values()) if (p.status === "IN_FLIGHT") node.resolvePayment(p.id, "fail");
  });
  return node;
}

/** The planner's move into the target, from source A then source B: 400k
 *  valued at 400 ppm — the gate leaves fee room only at the full size. */
const refillPlan = () =>
  ({
    channelId: TARGET, alias: "router", state: "route_found_profitable", wouldRebalance: true, recommendedAmount: 400_000, selectedSourceChannel: SRC_A,
    sourceCandidates: [SRC_A, SRC_B].map((id) => ({ channelId: id, alias: id, localRatio: 0.8, spareSats: 1_250_000, keepRatio: 0.55, reason: "" })),
    estimatedRouteFeeSats: 20, expectedNetProfitSats: 300, maxCostPpm: 320, maxCostSatsByPayback: 1_000, expectedRevenuePpm: 400, earningDemandSats: 1_200_000, minNetProfitSats: 100,
  }) as unknown as RebalanceRecommendation;

interface RefillState {
  perPairRebalanceFails?: Record<string, { fails: number }>;
  perTargetLastRebalanced: Record<string, string>;
  pendingRebalances?: unknown[];
}
const refillState = (autopilot: Autopilot) => (autopilot as unknown as { state: RefillState }).state;

test("a shutdown inside a refill: the attempt under way is awaited, and no smaller size or other source starts after the signal — only the source that really failed backs off, and the refill is a skip, not a failed run", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  node.payOutcome = "hang"; // the first attempt's HTLC is out
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refillPlan()] });
  const run = autopilot.runOnce();
  await waitFor(() => [...node.payments.values()].some((p) => p.status === "IN_FLIGHT"), "the first attempt is in flight");
  const [first] = [...node.payments.values()];
  autopilot.shutdown(); // SIGTERM (an update) while it is out
  node.payOutcome = "fail"; // (a regression's next payment fails at once instead of hanging)
  node.resolvePayment(first.id, "fail"); // … and it fails after the signal
  const done = await run;
  // Before: the fallback chain went on — source B's 400k was sent during
  // the update's shutdown window (up to 3 sources × 3 sizes per refill).
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "only the attempt under way");
  assert.equal(node.callsTo("default.addInvoice").length, 1, "not even an invoice for another attempt");
  const state = refillState(autopilot);
  assert.equal(state.perPairRebalanceFails?.[`${SRC_A}>${TARGET}`]?.fails, 1, "the source that failed backs off");
  assert.equal(state.perPairRebalanceFails?.[`${SRC_B}>${TARGET}`], undefined, "the one never tried does not");
  assert.ok(state.perTargetLastRebalanced[TARGET], "an attempt was made: the target's cooldown stands");
  // A deliberate skip (D15): no failed run, no failure in the log.
  assert.deepEqual([done.rebalances.length, done.failed], [0, 0]);
  assert.deepEqual(new RebalanceLog(dir).recent(), []);
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", /router: skipped, shutting down \(after a source found no route\)/);
  assert.deepEqual(state.pendingRebalances, []);
  assert.equal(await autopilot.waitIdle(1_000), true);
});

test("a shutdown inside a manual refill: no smaller size is sent after the signal — it reports a stop, not a failure", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  node.payOutcome = "hang";
  const { autopilot, dir } = autopilotWith(t, {}, {}, {}, node);
  // No gate: every size has fee room — 400k, then 200k, then 100k.
  const manual = autopilot.rebalanceByHand({ targetId: TARGET, sourceId: SRC_A, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 320 });
  await waitFor(() => [...node.payments.values()].some((p) => p.status === "IN_FLIGHT"), "the manual refill's first attempt is in flight");
  const [first] = [...node.payments.values()];
  autopilot.shutdown();
  node.payOutcome = "fail";
  node.resolvePayment(first.id, "fail");
  const res = await manual;
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "the 200k attempt was not sent");
  assert.deepEqual([res?.ok, res?.stopped, res?.failedSourceIds], [false, true, [SRC_A]]);
  assert.match(res?.error ?? "", /^skipped: shutting down/);
  assert.equal(refillState(autopilot).perPairRebalanceFails?.[`${SRC_A}>${TARGET}`]?.fails, 1);
  assert.deepEqual(new RebalanceLog(dir).recent(), [], "nothing for the log: it was stopped, not finished");
});

test("a refill the shutdown stops before its first attempt was no attempt: nothing sent, nothing backs off, and the target's cooldown is as it was", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refillPlan()] });
  // SIGTERM arrives while the executor reads the node (its fee rates), after
  // the stage's own check before the move.
  node.beforeCall = (method) => {
    if (method === "default.feeReport") autopilot.shutdown();
  };
  const done = await autopilot.runOnce();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0);
  const state = refillState(autopilot);
  assert.equal(state.perTargetLastRebalanced[TARGET], undefined, "no cooldown for a refill that never went out");
  assert.deepEqual(state.perPairRebalanceFails ?? {}, {});
  assert.deepEqual([done.rebalances.length, done.failed], [0, 0]);
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", /router: skipped, shutting down$/);
});

test("a signal that comes while an attempt's invoice is being made stops it before it is sent — nothing is paid or recorded, no source backs off", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refillPlan()] });
  node.beforeCall = (method) => {
    if (method === "default.addInvoice") autopilot.shutdown(); // after the check before the attempt
  };
  const done = await autopilot.runOnce();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0, "asked again right before it goes out");
  const state = refillState(autopilot);
  assert.deepEqual(state.perPairRebalanceFails ?? {}, {});
  assert.deepEqual(state.pendingRebalances ?? [], [], "nothing on the books: it was never sent");
  assert.equal(state.perTargetLastRebalanced[TARGET], undefined);
  assert.deepEqual([done.rebalances.length, done.failed], [0, 0]);
  assert.deepEqual(new RebalanceLog(dir).recent(), []);
});

test("a shutdown while a channel open is being planned: no funding transaction is broadcast", async (t) => {
  const { autopilot, node, seams } = autopilotWith(t, { channelEnabled: true });
  seams.openFeeRate = async () => 2; // LND's economy estimate (the fake has none)
  seams.channelSuggestions = async () => {
    autopilot.shutdown(); // SIGTERM arrives during the (slow) graph read
    return { suggestions: [suggestion] };
  };
  const run = await autopilot.runOnce();
  assert.equal(node.callsTo("default.openChannel").length, 0);
  // A deliberate stop, not a failed open (D15): the stage's decision says it.
  assert.deepEqual(run.channels, []);
  assert.match(autopilot.getState().decisions.channels?.text ?? "", /stopped: shutting down — no open was started/);
});

test("a shutdown during a Magma order step: that step completes, the next order's steps don't start", async (t) => {
  for (const [stage, mutation] of [
    ["awaiting approval", "AcceptOrder"],
    ["paid", "AddTransaction"],
  ] as const) {
    const { autopilot, node, magma } = sellerSetup(t);
    const orders = [magma.addSale({ buyerPubkey: BUYER }), magma.addSale({ buyerPubkey: "02" + "cd".repeat(32) })];
    if (stage === "paid") {
      await autopilot.magma.tick(); // accepted, both
      for (const o of orders) magma.buyerPays(o.id, node);
    }
    // SIGTERM arrives while Amboss is answering the first order's step.
    magma.onMutation = (op) => {
      if (op === mutation) autopilot.shutdown();
    };
    const before = magma.count(mutation);
    await autopilot.pollSellOrders();
    assert.equal(magma.count(mutation) - before, 1, `${stage}: one Amboss step, for one order only`);
    assert.equal(node.callsTo("default.openChannel").length, stage === "paid" ? 1 : 0, `${stage}: channel opens`);
    const phases = orders.map((o) => autopilot.magma.journal.get(o.id)?.phase ?? "untouched").sort();
    assert.deepEqual(
      phases,
      stage === "paid" ? ["accepted", "reported"] : ["accepted", "untouched"],
      `${stage}: the step under way completed and is on record; the next order waits for the next start`,
    );
    assert.equal(await autopilot.waitIdle(1_000), true);
    magma.onMutation = null;
  }
});

/**
 * An LSP service on a fake node holding one PAID order: the buyer's HTLC is
 * held, the channel is still to be opened. The LND seams of the order path
 * count what happens; a test replaces one to inject its scenario.
 */
function lspWithHeldOrder(t: AfterHook) {
  const dir = makeTempDir(t);
  // The buyer placed its order over BOLT8: it is a connected peer.
  const node = new FakeLnd({ chainBalance: 50_000_000, peers: ["02" + "ab".repeat(32)] });
  const svc = new Lsps1Service(
    dir,
    node.lnd,
    node.lnd,
    new SettingsStore(dir),
    () => ({ maxChannelSats: 10_000_000, reserveSats: 50_000, maxDeploySats: 50_000_000 }),
    () => ({ sellPricingMode: "balanced", adaptiveLevel: 0.5 }),
    () => "",
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  t.after(() => svc.stop());
  const seams = svc as unknown as {
    orders: Lsps1Order[];
    lndOpen: () => Promise<unknown>;
    lndInvoice: () => Promise<{ is_held: boolean }>;
    lndCancel: () => Promise<void>;
    lndSettle: () => Promise<void>;
    lndFeeRate: () => Promise<{ tokens_per_vbyte: number }>;
    fulfill: (o: Lsps1Order) => Promise<void>;
  };
  const counts = { opens: 0, cancels: 0 };
  seams.lndOpen = async () => {
    counts.opens += 1;
    return { ok: true, transactionId: "cc".repeat(32), transactionVout: 0 };
  };
  seams.lndInvoice = async () => ({ is_held: true });
  seams.lndCancel = async () => {
    counts.cancels += 1;
  };
  seams.lndSettle = async () => undefined;
  seams.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
  const order: Lsps1Order = {
    orderId: "o-stop",
    peer: "02" + "ab".repeat(32),
    createdAt: new Date().toISOString(),
    lspBalanceSat: 2_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4320,
    token: "",
    announceChannel: true,
    orderState: "CREATED",
    paymentState: "HOLD",
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: "lnbc-placeholder",
    invoiceId: "aa".repeat(32),
    invoiceSecret: "bb".repeat(32),
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
  };
  seams.orders.unshift(order);
  return { dir, node, svc, seams, order, counts };
}

test("a stopping LSP service starts no new channel open and leaves the payment held", async (t) => {
  const { svc, seams, order, counts } = lspWithHeldOrder(t);
  svc.stop();
  await seams.fulfill(order);
  assert.equal(counts.opens, 0, "no open after stop()");
  assert.equal(counts.cancels, 0, "and no refund either: restart recovery resumes the order");
  assert.equal(order.orderState, "CREATED");
  assert.equal(order.paymentState, "HOLD");
  assert.equal(await svc.waitForOpens(100), true);
});

test("SIGTERM while LND answers the invoice lookup: no channel open starts after the shutdown wait said idle", async (t) => {
  const { svc, seams, order, counts } = lspWithHeldOrder(t);
  let idle: Promise<boolean> | undefined;
  seams.lndInvoice = async () => {
    // The shutdown's first two steps (stop, then wait for opens) run while
    // LND is still answering. The wait sees no open in flight and resolves —
    // after that the process may exit at any moment.
    svc.stop();
    idle = svc.waitForOpens(5_000);
    await new Promise((r) => setTimeout(r, 20));
    return { is_held: true };
  };
  await seams.fulfill(order);
  assert.equal(await idle, true);
  // Before: the open started anyway. Killed before its outpoint was saved,
  // restart recovery would have opened a SECOND channel for this paid order.
  assert.equal(counts.opens, 0, "no open once the shutdown has begun");
  assert.equal(counts.cancels, 0, "no refund either: restart recovery resumes the order");
  assert.equal(order.orderState, "CREATED");
  assert.equal(order.paymentState, "HOLD");
  assert.equal(order.channel, null);
});

test("an LSP order that can't be saved before opening is refunded, never opened", async (t) => {
  const { dir, seams, order, counts } = lspWithHeldOrder(t);
  t.mock.method(console, "error", () => undefined); // the store reports each failing save
  t.mock.method(console, "warn", () => undefined);
  // Disk trouble: a directory where lsps1-orders.json belongs makes every save fail.
  mkdirSync(join(dir, "lsps1-orders.json"));
  await seams.fulfill(order);
  // Opening anyway would fund a channel whose outpoint could never be
  // recorded — and a restart would open a second one for this order.
  assert.equal(counts.opens, 0, "no channel open without the order on disk");
  assert.equal(counts.cancels, 1, "the held payment is released: the buyer is refunded");
  assert.equal(order.orderState, "FAILED");
  assert.equal(order.paymentState, "REFUNDED");
  assert.match(order.error ?? "", /^cannot save order state .* refunded instead of opening$/);
  assert.ok(
    storeIncidents(dir).some((i) => i.file === "lsps1-orders.json" && i.kind === "write_failed"),
    "and the failing save is raised as an alert",
  );
});

test("once shutdown has begun, the API refuses state-changing requests with 503; reads still answer", async (t) => {
  const api = await startApi(t);
  api.requestGate.close(); // SIGTERM: the first shutdown step
  for (const [method, path, body] of [
    ["POST", "/autopilot", { intervalMinutes: 60 }],
    ["POST", "/channels/open", { pubkey: "02" + "cd".repeat(32), localTokens: 100_000 }],
    ["POST", "/onchain/send", {}],
    ["POST", "/ln/pay", {}],
    ["POST", "/amboss/order/open", {}],
    ["DELETE", "/amboss/key", undefined],
  ] as const) {
    const res = await api.request(method, path, body);
    assert.equal(res.status, 503, `${method} ${path}`);
    assert.equal(res.body.error, "shutting_down");
  }
  assert.equal((await api.request("GET", "/health")).status, 200);
  const state = await api.request("GET", "/autopilot");
  assert.equal(state.status, 200, "the UI can still read");
  assert.equal(state.body.config.intervalMinutes, 30, "the refused update changed nothing");
  assert.equal(api.node.callsTo("default.openChannel").length, 0);
});

/** The real HTTP app serving `router` as its API behind a fresh request gate,
 *  on a loopback port. `post` sends a POST to /api<path> and hands back the
 *  request (so a test can drop the connection) and the status it gets. */
async function serveGated(t: AfterHook, router: Router) {
  const gate = new RequestGate();
  const server = createHttpApp({ apiRouter: router, allowedHosts: [], authRequired: false, requestGate: gate }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((r) => server.once("listening", () => r()));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });
  const { port } = server.address() as AddressInfo;
  const post = (path: string) => {
    let req!: http.ClientRequest;
    const status = new Promise<number>((resolve, reject) => {
      req = http.request(
        { host: "127.0.0.1", port, method: "POST", path: `/api${path}`, headers: { Host: `localhost:${port}` } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    status.catch(() => undefined); // a dropped connection is the point of some tests
    return { req, status };
  };
  return { gate, port, post };
}

test("the shutdown waits for a state-changing request that was already under way", async (t) => {
  const { released, release } = heldUntilReleased(t);
  const router = Router();
  router.post("/slow", async (_req, res) => {
    await released;
    res.json({ ok: true });
  });
  const { gate, post } = await serveGated(t, router);

  const underWay = post("/slow").status;
  await waitFor(() => gate.inFlight === 1, "the first request reaches its handler");
  gate.close();
  let idle: boolean | undefined;
  const waited = gate.waitIdle(5_000).then((v) => (idle = v));
  const second = await Promise.race([post("/slow").status, sleep(2_000).then(() => "still waiting")]);
  assert.equal(second, 503, "a new request is refused at once");
  await sleep(100);
  assert.equal(idle, undefined, "the wait holds while the earlier request runs");
  release();
  assert.equal(await underWay, 200, "the request under way completes");
  await waited;
  assert.equal(idle, true);
  assert.equal(gate.inFlight, 0);
});

test("the shutdown keeps waiting for a request under way after its client has gone", async (t) => {
  const { released, release } = heldUntilReleased(t);
  let clientGone = false;
  let handlerDone = false;
  const router = Router();
  router.post("/amboss/order/open", async (_req, res) => {
    res.once("close", () => (clientGone = true));
    await released; // the funding is out; Amboss doesn't know yet
    handlerDone = true;
    res.json({ ok: true });
  });
  const { gate, post } = await serveGated(t, router);

  const { req } = post("/amboss/order/open");
  await waitFor(() => gate.inFlight === 1, "the request reaches its handler");
  // `docker compose stop` on Umbrel: app_proxy has a 10 s grace, we have a
  // minute — it is gone first, and takes the proxied connection with it.
  req.destroy();
  await waitFor(() => clientGone, "the server sees the connection close");
  gate.close();
  let idle: boolean | undefined;
  const waited = gate.waitIdle(5_000).then((v) => (idle = v));
  await sleep(150);
  // Before: the gate counted the CONNECTION — 0 in flight the moment it
  // closed, so the shutdown flushed and exited while the handler was still
  // between the channel open and telling Amboss: a restart opened again.
  assert.equal(gate.inFlight, 1, "the handler still counts");
  assert.equal(idle, undefined, "and the shutdown keeps waiting for it");
  assert.equal(handlerDone, false);
  release();
  await waited;
  assert.equal(handlerDone, true);
  assert.equal(idle, true, "idle only once the handler has answered");
  assert.equal(gate.inFlight, 0);
});

test("a write request that fails, or never reaches its handler, doesn't hold up the shutdown", async (t) => {
  t.mock.method(console, "error", () => undefined); // express prints the handler's error
  const router = Router();
  router.post("/fail", (_req, _res, next) => next(new Error("LND unreachable")));
  const { gate, port, post } = await serveGated(t, router);

  assert.equal(await post("/fail").status, 500, "express's error handler answered");
  assert.equal(gate.inFlight, 0);
  assert.equal(await post("/no-such-route").status, 404);
  assert.equal(gate.inFlight, 0);

  // The client gives up while still sending the body: no handler ever runs.
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  await new Promise<void>((r) => socket.once("connect", () => r()));
  socket.write(
    `POST /api/fail HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"a":`,
  );
  await waitFor(() => gate.inFlight === 1, "the upload is under way");
  socket.destroy();
  await waitFor(() => gate.inFlight === 0, "an abandoned upload is no longer counted", 2_000);
  gate.close();
  assert.equal(await gate.waitIdle(1_000), true);
});

test("HTLC telemetry can be flushed on shutdown instead of losing up to a minute", (t) => {
  const dir = makeTempDir(t);
  initHtlcTelemetry(dir);
  t.after(() => stopHtlcTelemetry());
  recordForwardEvent({
    is_failed: true,
    is_receive: false,
    is_send: false,
    in_channel: "800000x1x0",
    out_channel: "800001x1x0",
    internal_failure: "INSUFFICIENT_BALANCE",
    tokens: 50_000,
  });
  stopHtlcTelemetry();
  flushHtlcTelemetry();
  const file = join(dir, "htlc-telemetry.json");
  assert.ok(existsSync(file));
  const saved = JSON.parse(readFileSync(file, "utf8")) as { buckets: { liquiditySats: number }[] };
  assert.equal(saved.buckets[0].liquiditySats, 50_000);
});

// ── deadlines and records across a shutdown (P1a) ─────────────────────────────

test("the shutdown wait outlasts any single Amboss call, so a step in flight ends — answered or timed out — before the exit", () => {
  // Before: a 37 s wait against a 45 s mutation deadline. A slow
  // add_transaction could be cut off by the exit with its outcome unknown.
  const margin = 5_000; // the journal saves around the call
  assert.ok(HTTP_TIMEOUTS.ambossMutationMs + margin <= SHUTDOWN_WAIT_MS, `${HTTP_TIMEOUTS.ambossMutationMs} vs ${SHUTDOWN_WAIT_MS}`);
  assert.ok(HTTP_TIMEOUTS.ambossQueryMs + margin <= SHUTDOWN_WAIT_MS);
});

test("SIGTERM during an order-lane mutation: the shutdown waits for it, the attempt is on record, and the next start finishes the order with one channel", async (t) => {
  const saved = HTTP_TIMEOUTS.ambossMutationMs;
  HTTP_TIMEOUTS.ambossMutationMs = 300;
  t.after(() => {
    HTTP_TIMEOUTS.ambossMutationMs = saved;
  });
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await s.autopilot.pollSellOrders();
  s.magma.buyerPays(sale.id, s.node);
  s.magma.behave.AddTransaction = (n) => (n === 0 ? "hang" : "ok"); // Amboss slow to answer
  s.magma.onMutation = (op) => {
    if (op === "AddTransaction") s.autopilot.shutdown(); // SIGTERM arrives now
  };
  const lane = s.autopilot.pollSellOrders();
  await waitFor(() => s.magma.count("AddTransaction") === 1, "the report is under way");
  assert.equal(await s.autopilot.waitIdle(20), false, "the shutdown waits for the step under way");
  assert.equal(await s.autopilot.waitIdle(5_000), true, "and it ends within its deadline");
  await lane;
  const onDisk = (JSON.parse(readFileSync(join(s.dir, "magma-orders.json"), "utf8")) as MagmaJournalEntry[]).find(
    (e) => e.orderId === sale.id,
  );
  assert.equal(onDisk?.phase, "funded", "the open is on record with its outpoint");
  assert.ok(onDisk?.fundingOutpoint);
  assert.ok(onDisk?.reportSentAt, "and so is the report that was in flight");
  assert.match(onDisk?.lastError ?? "", /not confirmed/);

  const next = s.restart();
  await next.pollSellOrders(); // reports the journalled outpoint again
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await next.pollSellOrders();
  assert.equal(s.node.callsTo("default.openChannel").length, 1);
  assert.equal(next.magma.journal.get(sale.id)?.phase, "settled");
});

test("an LSP channel whose outpoint can't be saved after the open (the disk filled meanwhile): alert, no second open — a restart finds it in LND", async (t) => {
  const { dir, node, svc, seams, order, counts } = lspWithHeldOrder(t);
  t.mock.method(console, "error", () => undefined);
  t.mock.method(console, "log", () => undefined);
  const outpoint = { transactionId: "cc".repeat(32), transactionVout: 1 };
  let full: { mock: { restore(): void } } | undefined;
  seams.lndOpen = async () => {
    counts.opens += 1;
    node.pending.push({ partnerPublicKey: order.peer, capacity: order.lspBalanceSat, ...outpoint });
    // The save before the open went through; now the disk is full.
    full = t.mock.method(JsonStore.prototype as unknown as { replaceFile(): void }, "replaceFile", () => {
      throw new Error("ENOSPC: no space left on device");
    });
    return { ok: true, ...outpoint };
  };
  seams.lndSettle = async () => {
    throw new Error("LND busy"); // the payment stays held: the restart must finish it
  };
  (seams as unknown as { settleRetryBaseMs: number }).settleRetryBaseMs = 1;
  await seams.fulfill(order);
  assert.ok(
    storeIncidents(dir).some((i) => i.kind === "unrecorded_open" && i.detail.includes(`${outpoint.transactionId}:1`)),
    "raised as an alert (it used to be a silent failed save)",
  );
  assert.equal(order.channel?.fundingOutpoint, `${outpoint.transactionId}:1`, "kept in memory");
  await seams.fulfill(order);
  assert.equal(counts.opens, 1, "this process never opens again for the order");
  svc.stop();
  full?.mock.restore();
  const onDisk = (JSON.parse(readFileSync(join(dir, "lsps1-orders.json"), "utf8")) as Lsps1Order[])[0];
  assert.equal(onDisk.channel, null, "on disk: no outpoint …");
  assert.ok(onDisk.opening, "… but the open that was started");

  // A new process, same disk and LND, the payment still held.
  const again = new Lsps1Service(
    dir,
    node.lnd,
    node.lnd,
    new SettingsStore(dir),
    () => ({ maxChannelSats: 10_000_000, reserveSats: 50_000, maxDeploySats: 50_000_000 }),
    () => ({ sellPricingMode: "balanced", adaptiveLevel: 0.5 }),
    () => "",
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  t.after(() => again.stop());
  const s2 = again as unknown as typeof seams & { recoverOrders(): Promise<void>; watchInvoice(): void };
  s2.watchInvoice = () => undefined;
  s2.lndInvoice = async () => ({ is_held: true });
  s2.lndSettle = async () => undefined;
  s2.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
  s2.lndOpen = async () => {
    counts.opens += 1;
    return { ok: true, transactionId: "dd".repeat(32), transactionVout: 0 };
  };
  await s2.recoverOrders();
  const recovered = again.orderViews()[0];
  assert.equal(counts.opens, 1, "the restart found the channel in LND instead of opening a second one");
  assert.equal(recovered.fundingOutpoint, `${outpoint.transactionId}:1`);
  assert.equal(recovered.orderState, "COMPLETED");
});

test("an LSP open interrupted before LND acted: after LND had ample time and shows no channel, it is opened — once", async (t) => {
  const { dir, node, seams, order, counts } = lspWithHeldOrder(t);
  t.mock.method(console, "log", () => undefined);
  // On disk: the open had started 11 minutes ago, no channel recorded.
  order.opening = { startedAt: new Date(Date.now() - 11 * 60_000).toISOString(), preExisting: [] };
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([order]));
  void node;
  await seams.fulfill(order);
  assert.equal(counts.opens, 1);
  assert.equal(order.orderState, "COMPLETED");
});

test("an LSP open whose outcome is unclear (the stream dropped): no refund and no second open until LND has shown — or not shown — the channel", async (t) => {
  const { node, svc, seams, order, counts } = lspWithHeldOrder(t);
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "warn", () => undefined);
  seams.lndOpen = async () => {
    counts.opens += 1;
    return { ok: false, error: "FailedToOpenChannel: Connection dropped" };
  };
  await seams.fulfill(order);
  // Before: the "opening" mark was cleared and the payment refunded at once —
  // and if LND had funded the channel after all, the buyer kept it for free.
  assert.equal(counts.cancels, 0, "not refunded: a channel may exist");
  assert.equal(order.orderState, "CREATED");
  assert.equal(order.paymentState, "HOLD");
  assert.match(order.opening?.unclear ?? "", /Connection dropped/);

  // LND shows the channel a moment later: adopted and settled, not reopened.
  node.pending.push({ partnerPublicKey: order.peer, capacity: order.lspBalanceSat, transactionId: "cd".repeat(32), transactionVout: 0 });
  await seams.fulfill(order);
  assert.equal(counts.opens, 1, "no second open");
  assert.equal(order.orderState, "COMPLETED");
  assert.equal(order.channel?.fundingOutpoint, `${"cd".repeat(32)}:0`);
  svc.stop();
});

test("an LSP buyer whose node takes one pending channel at a time is waited out, not refunded", async (t) => {
  const { seams, order, counts } = lspWithHeldOrder(t);
  t.mock.method(console, "log", () => undefined);
  (seams as unknown as { openRetryDelayMs: number }).openRetryDelayMs = 1;
  seams.lndOpen = async () => {
    counts.opens += 1;
    return counts.opens === 1
      ? { ok: false, error: "PeerPendingChannelsExceedMaximumAllowable" }
      : { ok: true, transactionId: "ee".repeat(32), transactionVout: 0 };
  };
  await seams.fulfill(order);
  assert.equal(counts.cancels, 0, "before: refunded at the first refusal");
  assert.equal(counts.opens, 2);
  assert.equal(order.orderState, "COMPLETED");
});
