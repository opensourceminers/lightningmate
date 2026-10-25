/**
 * Work that answers after its stage was given up, who holds the refill lock,
 * and a sold channel's broken fee promise once its lease ends (final review
 * 2026-10-25: PROBE-FEE-WRITE-LATE, PROBE-OPEN-GIVEN-UP,
 * PROBE-REFILL-LATE-BOOKED, PROBE-REFILL-LOCK-TEXT, PROBE-LEASE-ALERT-STALE).
 *
 * Before: a fee write, an open or a refill LND took after its stage's
 * deadline went through, but no run-history line had it and the area kept
 * saying "did not finish"; a given-up rebalancing stage still holding the
 * refill lock read "a manual refill is under way" run after run, and nothing
 * said the lock was stuck; the last lease ending left its fee-promise alert
 * and the fee status up for good.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { REFILL_LOCK_ALERT_MS, WORK_DEADLINES_MS, withHistoryLine, type AutopilotChange, type AutopilotRun } from "../src/services/autopilot.js";
import { LANE_PASS_DEADLINE } from "../src/services/magmaDesk.js";
import { leasePromiseAlerts } from "../src/services/alerts.js";
import type { LeaseCap } from "../src/services/leaseCaps.js";
import type { FeeApplyItem, FeeApplyResult } from "../src/services/fees.js";
import type { RebalanceRecReport } from "../src/services/rebalanceRecommend.js";
import { autopilotWith, paidRebalance, plannedFeeChange, plannedRebalance, suggestion, type AutopilotSeams } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { quiet, sleep, keepFileAlive } from "./helpers/lifecycle.js";
import { until } from "./helpers/wait.js";

// Deadlines in these tests fire on timers nothing else keeps alive (see keepFileAlive).
keepFileAlive();

/** Every deadline this short (ms); restored after the test. */
function shortDeadlines(t: TestContext, stage = 150, perRefill = 150): void {
  const saved = { ...WORK_DEADLINES_MS };
  const lane = LANE_PASS_DEADLINE.ms;
  Object.assign(WORK_DEADLINES_MS, { stage, perRefill, feeWork: 150, inflightCheck: 150, laneWork: 150 });
  LANE_PASS_DEADLINE.ms = 150;
  t.after(() => {
    Object.assign(WORK_DEADLINES_MS, saved);
    LANE_PASS_DEADLINE.ms = lane;
  });
  t.mock.method(console, "error", () => undefined);
}

type FeeSeams = {
  feeReport: () => Promise<unknown>;
  feeApply: (w: unknown, items: FeeApplyItem[], opts: { shouldStop?: () => boolean; onResult?: (r: FeeApplyResult) => void }) => Promise<FeeApplyResult[]>;
};

/** Two fee changes; LND takes `ms` for each write, and each asks first
 *  whether its work was given up. Returns the writes sent. */
function slowFeeWrites(autopilot: unknown, ms: number): string[] {
  const seams = autopilot as FeeSeams;
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800000x1x0", 100, 80), plannedFeeChange("800000x2x0", 100, 120)] });
  const sent: string[] = [];
  seams.feeApply = async (_w, items, opts) => {
    const results: FeeApplyResult[] = [];
    for (const it of items) {
      if (opts.shouldStop?.()) break;
      sent.push(it.id);
      await sleep(ms);
      const r: FeeApplyResult = { id: it.id, ok: true, feeRatePpm: it.feeRatePpm, baseFeeMsat: it.baseFeeMsat };
      results.push(r);
      opts.onResult?.(r);
    }
    return results;
  };
  return sent;
}

const lateLine = (history: AutopilotRun[]) => history.find((h) => h.lateStage);

test("a fee write LND answers after the fee stage was given up gets a run-history line of its own, and the fee decision says it went through — not 'did not finish'", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot } = autopilotWith(t, { enabled: true });
  const sent = slowFeeWrites(autopilot, 300);
  const run = await autopilot.runOnce();
  assert.match(run.errors?.find((e) => e.stage === "fees")?.error ?? "", /^the fees stage did not finish in 150 ms/);
  assert.match(autopilot.getState().decisions.fees?.text ?? "", /^the fees stage did not finish in 150 ms/);
  assert.equal(lateLine(autopilot.getState().history), undefined, "nothing went through yet");
  await until(() => lateLine(autopilot.getState().history) !== undefined, "the late write's line");
  const st = autopilot.getState();
  const late = lateLine(st.history)!;
  assert.equal(late.lateStage, "the fees stage");
  assert.deepEqual(
    late.changes.map((c) => [c.id, c.toPpm, c.ok]),
    [["800000x1x0", 80, true]],
  );
  assert.deepEqual([late.attempted, late.applied, late.failed], [1, 1, 0]);
  assert.deepEqual(sent, ["800000x1x0"], "the next write is never sent");
  assert.match(st.decisions.fees?.text ?? "", /^the fees stage finished \d+ m?s after it was given up: 1 fee change went through — see the run history$/);
  assert.equal(st.decisions.fees?.state, "acted");
});

test("late work never replaces a decision a later run made meanwhile — its history line is written all the same", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot } = autopilotWith(t, { enabled: true });
  slowFeeWrites(autopilot, 300);
  await autopilot.runOnce();
  // A later run decided something else before LND answered.
  const decisions = (autopilot as unknown as { state: { decisions: Record<string, unknown> } }).state.decisions;
  const at = new Date(Date.now() + 1).toISOString();
  decisions.fees = { at, state: "idle", text: "a later run's decision", since: at, repeats: 1 };
  await until(() => lateLine(autopilot.getState().history) !== undefined, "the late write's line");
  await sleep(20);
  assert.equal(autopilot.getState().decisions.fees?.text, "a later run's decision");
});

test("a channel open LND funds after the channel stage was given up is on the record: a run-history line of its own, and the channel decision says it went through", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot, node } = autopilotWith(t, { channelEnabled: true, channelCooldownMinutes: 0, channelSizeSats: 1_000_000 });
  const seams = autopilot as unknown as AutopilotSeams;
  seams.openFeeRate = async () => 2;
  seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  node.peers.push(suggestion.pubkey);
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  // LND takes the open and answers only when the test says so.
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  t.after(() => release());
  node.override("default.openChannel", () => {
    const s = Object.assign(new EventEmitter(), { cancel: () => undefined });
    void released.then(() =>
      s.emit("data", { update: "chan_pending", chan_pending: { txid: Buffer.from("ab".repeat(32), "hex").reverse(), output_index: 0 } }),
    );
    return s;
  });
  const run = await autopilot.runOnce();
  assert.match(run.errors?.find((e) => e.stage === "channels")?.error ?? "", /^the channels stage did not finish in 150 ms/);
  assert.equal(lateLine(autopilot.getState().history), undefined);
  release();
  await until(() => lateLine(autopilot.getState().history) !== undefined, "the late open's line");
  const st = autopilot.getState();
  const late = lateLine(st.history)!;
  assert.equal(late.lateStage, "the channels stage");
  assert.deepEqual(late.channels.map((c) => c.ok), [true]);
  assert.deepEqual([late.attempted, late.applied, late.failed], [1, 1, 0]);
  assert.match(st.decisions.channels?.text ?? "", /^the channels stage finished \d+ m?s after it was given up: 1 channel open went through — see the run history$/);
  assert.equal(st.decisions.channels?.state, "acted");
  assert.equal(node.callsTo("default.openChannel").length, 1);
});

test("a refill LND settles after the rebalancing stage was given up is on the record: a run-history line of its own, and the rebalancing decision says it went through", async (t) => {
  quiet(t);
  shortDeadlines(t, 50, 50); // the stage's deadline: 50 + 3 × 50 ms
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, maxRebalancesPerRun: 3, rebalanceDailyBudgetSats: 1_000 });
  seams.rebalanceReport = async () => ({
    recommendations: ["800000x1x0", "800000x3x0", "800000x4x0"].map((id, i) => ({
      ...plannedRebalance(id, 100 - 10 * i),
      selectedSourceChannel: "800000x2x0",
      sources: [{ id: "800000x2x0" }],
    })) as never,
  });
  const execs: string[] = [];
  seams.rebalanceExec = async (_w, p, opts) => {
    execs.push(p.targetId);
    opts?.onSend?.({ paymentId: "aa".repeat(32), sourceId: p.sourceId, targetAlias: `peer-${p.targetId}`, amountSats: p.amountSats, maxFeeSats: 50 });
    await sleep(400); // longer than the stage's whole deadline
    opts?.onEnd?.("aa".repeat(32), "paid");
    return { ...paidRebalance(p, 12), paymentId: "aa".repeat(32) };
  };
  const run = await autopilot.runOnce();
  assert.match(run.errors?.find((e) => e.stage === "rebalancing")?.error ?? "", /^the rebalancing stage did not finish in 200 ms/);
  await until(() => lateLine(autopilot.getState().history) !== undefined, "the late refill's line");
  const st = autopilot.getState();
  const late = lateLine(st.history)!;
  assert.equal(late.lateStage, "the rebalancing stage");
  assert.deepEqual(late.rebalances.map((r) => [r.ok, r.feeSats]), [[true, 12]]);
  assert.deepEqual(execs, ["800000x1x0"], "no refill after the give-up");
  assert.match(st.decisions.rebalance?.text ?? "", /^the rebalancing stage finished \d+ m?s after it was given up: 1 refill went through — see the run history$/);
});

test("a late stage's line is never merged into the line before it, even with the very same changes", () => {
  const change: AutopilotChange = { id: "800000x1x0", alias: "p", fromPpm: 100, toPpm: 80, ok: true };
  const line = (o: Partial<AutopilotRun> = {}): AutopilotRun => ({
    at: new Date().toISOString(),
    attempted: 1,
    applied: 1,
    failed: 0,
    changes: [change],
    rebalances: [],
    channels: [],
    sells: [],
    ...o,
  });
  assert.equal(withHistoryLine([line()], line(), 50).length, 1, "the same success again counts up");
  const once = withHistoryLine([line()], line({ lateStage: "the fees stage" }), 50);
  assert.equal(once.length, 2);
  assert.equal(withHistoryLine(once, line({ lateStage: "the fees stage" }), 50).length, 3);
  assert.equal(withHistoryLine(once, line(), 50).length, 3, "nor is a line after it merged into it");
});

test("a rebalancing stage given up while LND doesn't answer keeps the refill lock — later runs and a manual refill say so, not 'a manual refill is under way'; held 10 minutes, it is an alert; once LND answers, the lock is free and the decision says how it ended", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true });
  let answer!: (r: Pick<RebalanceRecReport, "recommendations">) => void;
  let reports = 0;
  seams.rebalanceReport = () => (++reports === 1 ? new Promise((r) => (answer = r)) : Promise.resolve({ recommendations: [] }));
  const run1 = await autopilot.runOnce();
  assert.match(run1.errors?.find((e) => e.stage === "rebalancing")?.error ?? "", /^the rebalancing stage did not finish in/);
  await autopilot.runOnce();
  const words = "a refill of the given-up rebalancing stage is still running — LND hasn't answered";
  assert.equal(autopilot.getState().decisions.rebalance?.text, `${words}; the autopilot's refills wait for the next run`);
  assert.equal(reports, 1, "the later run planned nothing beside it");
  assert.equal(await autopilot.rebalanceByHand({ targetId: "800000x1x0", sourceId: "800000x2x0", amountSats: 100_000, econRatio: 0.5 }), null);
  assert.match(autopilot.refillBusyMessage(), /^A refill of the given-up rebalancing stage is still running — LND hasn't answered its payment yet\. Try again once it does/);
  assert.deepEqual(autopilot.refillLockAlerts(), [], "held for moments: nothing to say");
  const later = Date.now() + REFILL_LOCK_ALERT_MS;
  assert.match(
    autopilot.refillLockAlerts(later)[0]?.message ?? "",
    /^The refill lock has been held for 10 minutes by the given-up rebalancing stage — LND hasn't answered its payment, and the autopilot's and manual refills wait behind it\. If LND doesn't answer, restarting Lightning Mate frees it/,
  );
  answer({ recommendations: [] });
  await until(() => autopilot.refillBusyWhy() === null, "the lock is free");
  await until(() => !(autopilot.getState().decisions.rebalance?.text ?? "").startsWith(words), "the decision moves on");
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", /^the rebalancing stage finished \d+ m?s after it was given up — nothing more was changed$/);
  assert.deepEqual(autopilot.refillLockAlerts(later), [], "gone once it is free");
  assert.equal(lateLine(autopilot.getState().history), undefined, "nothing done late: no line");
});

test("the rebalancing stage paying within its deadline is no alarm, however long it holds the refill lock — and a manual refill meanwhile hears it is the autopilot's", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800005x1x0", 500)] });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  t.after(() => release());
  const paying: string[] = [];
  seams.rebalanceExec = async (_w, p) => {
    paying.push(p.targetId);
    await held;
    return paidRebalance(p);
  };
  const run = autopilot.runOnce();
  await until(() => paying.length === 1, "the stage's refill is paying");
  assert.equal(autopilot.refillBusyWhy(), "the autopilot's rebalancing stage is paying a refill");
  assert.equal(autopilot.refillBusyMessage(), "A refill is already under way (the autopilot's) — try again in a few minutes.");
  assert.deepEqual(autopilot.refillLockAlerts(Date.now() + 60 * 60_000), []);
  release();
  await run;
  assert.equal(autopilot.refillBusyWhy(), null);
  await sleep(20);
  assert.equal(lateLine(autopilot.getState().history), undefined, "work done in time is no late line");
  assert.equal(autopilot.getState().history[0]?.rebalances.length, 1, "it is the run's own");
});

test("a manual refill holding the refill lock: another one is refused saying so, and held 10 minutes GET /alerts says the lock is held, by whom — gone once it is free", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const api = await startApi(t, { node: new FakeLnd() });
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 10_000 });
  const ap = api.autopilot as unknown as AutopilotSeams;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  t.after(() => release());
  const paying: string[] = [];
  ap.rebalanceExec = async (_w, p) => {
    paying.push(p.targetId);
    await held;
    return paidRebalance(p);
  };
  const manual = { targetId: "800001x1x0", sourceId: "800002x1x0", amountSats: 400_000 };
  const first = api.request("POST", "/rebalance/execute", manual);
  await until(() => paying.length === 1, "the manual refill is paying");
  const second = await api.request("POST", "/rebalance/execute", { ...manual, targetId: "800003x1x0" });
  assert.equal(second.status, 409);
  assert.equal(second.body.message, "A refill is already under way (another manual one) — try again in a few minutes.");
  const messages = async () => ((await api.request("GET", "/alerts")).body as { message: string }[]).map((a) => a.message);
  assert.ok(!(await messages()).some((m) => /refill lock/.test(m)), "held for moments: nothing to say");
  (api.autopilot as unknown as { refilling: { since: number } }).refilling.since = Date.now() - 11 * 60_000;
  assert.ok(
    (await messages()).some((m) =>
      /^The refill lock has been held for 11 minutes by a manual refill — LND hasn't answered its payment, and the autopilot's and manual refills wait behind it\./.test(m),
    ),
  );
  release();
  assert.equal((await first).status, 200);
  assert.ok(!(await messages()).some((m) => /refill lock/.test(m)), "gone once it is free");
});

test("a sold channel's broken fee promise is no alert once its lease has ended: a lease no longer registered isn't reported, and the last one ending clears the list — the alert and the fee status go", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: false });
  const cap = (txByte: string, vout: number): LeaseCap =>
    ({ fundingOutpoint: `${txByte.repeat(32)}:${vout}`, source: "magma", orderId: `o-${txByte}`, feeRateCapPpm: 2200, baseFeeCapMsat: 1000, leaseBlocks: 4320 }) as LeaseCap;
  const a = cap("ee", 0);
  const b = cap("dd", 1);
  let caps: LeaseCap[] = [a, b];
  autopilot.capital.register("leases", { reservations: () => [], deployedSat: () => 0, claimedOutpoints: () => [], leaseCaps: () => caps });
  const channelOf = new Map([
    [a.fundingOutpoint, "800000x1x0"],
    [b.fundingOutpoint, "800000x2x0"],
  ]);
  (autopilot as unknown as { leaseBreaches: () => Promise<unknown[]> }).leaseBreaches = async () =>
    caps.map((c) => {
      const [transactionId, vout] = c.fundingOutpoint.split(":");
      return {
        id: channelOf.get(c.fundingOutpoint),
        transactionId,
        transactionVout: Number(vout),
        feeRatePpm: 2200,
        baseFeeMsat: 1000,
        alias: `buyer-${channelOf.get(c.fundingOutpoint)}`,
        fromPpm: 5000,
        fromBaseMsat: 1000,
        why: "lease promise: at most 2,200 ppm + 1 sat base — its fee (5000 ppm, 1000 msat base) was above that",
        leaseBreach: true,
      };
    });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: false, feeRatePpm: i.feeRatePpm, error: "UpdateRoutingFeesFailed: refused" }));
  await autopilot.keepLeasePromisesNow();
  const failing = () => autopilot.leasePromiseFailures().map((f) => f.channelId).sort();
  assert.deepEqual(failing(), ["800000x1x0", "800000x2x0"]);
  // A's lease ends: its promise is no longer registered — not reported, before the next check.
  caps = [b];
  assert.deepEqual(failing(), ["800000x2x0"]);
  assert.equal(leasePromiseAlerts(autopilot.leasePromiseFailures()).length, 1);
  // The last one ends: the next check clears the list.
  caps = [];
  await autopilot.keepLeasePromisesNow();
  assert.deepEqual(failing(), []);
  await autopilot.runOnce();
  assert.doesNotMatch(autopilot.getState().status.fees.text, /could not be restored/);
  // Cleared, not just hidden: an outpoint registered again (a new sale) starts afresh.
  caps = [b];
  assert.deepEqual(failing(), []);
});

test("the alert for a sold channel's fee promise LND keeps refusing says what helps — LND's log, the channel's state — not to lower it by hand", () => {
  const [alert] = leasePromiseAlerts([
    {
      channelId: "800000x1x0",
      alias: "buyer",
      since: "2026-10-25T10:00:00.000Z",
      error: "UpdateRoutingFeesFailed: refused",
      why: "lease promise: at most 2,200 ppm + 1 sat base — its fee (5000 ppm, 1000 msat base) was above that",
    },
  ]);
  assert.match(
    alert?.message ?? "",
    /since 2026-10-25 10:00 UTC: UpdateRoutingFeesFailed: refused\. LightningMate tries again every 10 minutes\. If it keeps failing, check LND's log for why it refuses the update, and the channel's state \(for example whether it is closing\)\.$/,
  );
  assert.doesNotMatch(alert?.message ?? "", /by hand|Channels tab/);
});
