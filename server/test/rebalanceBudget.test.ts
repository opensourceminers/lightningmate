/**
 * The daily rebalance budget, skips that are not failures, and settings that
 * work (review a2: budget-counter-fragile, skip-entries-flood-history,
 * inert-settings-and-presets — package P3).
 *
 * Before: today's spend was a separate counter a restart could lose, manual
 * runs bypassed it, one payment could overshoot it by its whole cap, and the
 * planner cut the list to maxPerRun before the budget check. Every
 * budget-skipped move was a failed run (a red "✗" every 30 minutes until the
 * UTC day rolled over) in the 50-run history. Three of the tab's rebalance
 * settings reached nothing, and the hour window was the container's clock
 * while the budget's day was UTC.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectRebalanceRuns, wouldTake, REBAL_REC_DEFAULTS, type RebalanceRecommendation } from "../src/services/rebalanceRecommend.js";
import { RebalanceLog, type RebalanceRecord } from "../src/services/rebalanceLog.js";
import type { RebalanceExecParams } from "../src/services/rebalance.js";
import { AUTOPILOT_CONFIG_BOUNDS, sanitizePersistedConfig } from "../src/services/autopilotConfig.js";
import { ConfigValidationError } from "../src/services/autopilot.js";
import { autopilotWith, failedRebalance, paidRebalance, plannedFeeChange, plannedRebalance, type AutopilotSeams } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { makeTempDir } from "./helpers/tmp.js";
import { until } from "./helpers/wait.js";

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
/** A finished rebalance as the log keeps it. */
const logged = (o: Partial<RebalanceRecord>): RebalanceRecord => ({
  at: new Date().toISOString(),
  via: "autopilot",
  targetId: "800009x1x0",
  targetAlias: "t",
  sourceId: "800000x1x0",
  sourceAlias: "s",
  amountSats: 100_000,
  budgetPpm: 500,
  feeSats: 10,
  costPpm: 100,
  ok: true,
  ...o,
});
const move = (id: string, net: number, estFee: number) => ({ ...plannedRebalance(id, net), estimatedRouteFeeSats: estFee }) as RebalanceRecommendation;

// ── the planner ──────────────────────────────────────────────────────────────

test("the planner walks the whole list until the per-run limit is filled with moves that fit — a 1,500-sat best move no longer blocks a 200-sat one with 1,000 sat left", () => {
  const big = move("800001x1x0", 900, 1_500);
  const small = move("800002x1x0", 100, 200);
  const plan = selectRebalanceRuns([big, small], { dailyBudgetSats: 1_000, alreadySpentSats: 0, maxPerRun: 1 });
  assert.deepEqual(plan.run.map((r) => r.channelId), ["800002x1x0"]);
  assert.deepEqual(plan.skipped.map((s) => s.rec.channelId), ["800001x1x0"]);
  assert.match(plan.skipped[0].reason, /1000 sat left of the 1000 sat daily budget — too little for this move \(~1500 sat\)/);
  // A profitable move beyond the per-run limit waits for the next run.
  const third = move("800003x1x0", 50, 10);
  const two = selectRebalanceRuns([big, small, third], { dailyBudgetSats: 1_000, alreadySpentSats: 0, maxPerRun: 1 });
  assert.deepEqual(two.later.map((r) => r.channelId), ["800003x1x0"]);
});

// ── the budget is read from the books ─────────────────────────────────────────

test("today's spend is read from the rebalance log — it survives a restart, counts manual refills and payments in flight, and starts afresh at 00:00 UTC", (t) => {
  // What a previous process left on disk: no spend counter at all.
  const { autopilot } = autopilotWith(
    t,
    { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 },
    { pendingRebalances: [{ id: "ab".repeat(32), targetId: "800005x1x0", alias: "x", amountSats: 1, maxFeeSats: 40, day: today(), at: new Date().toISOString() }] },
    {
      "rebalances.json": [
        logged({ feeSats: 300 }),
        logged({ via: "manual", feeSats: 70 }),
        logged({ ok: false, feeSats: null, error: "no route" }),
        // Yesterday's: yesterday's budget.
        logged({ at: new Date(Date.now() - DAY).toISOString(), feeSats: 500 }),
        // Sent yesterday, landed today (it was in flight): yesterday's too.
        logged({ startedAt: new Date(Date.now() - DAY).toISOString(), feeSats: 250 }),
      ],
    },
  );
  const b = autopilot.rebalanceBudget();
  assert.deepEqual([b.spentSats, b.inFlightSats, b.leftSats], [300 + 70 + 40, 40, 1_000 - 410]);
  assert.equal(b.resetsAt, new Date(Date.parse(`${today()}T00:00:00.000Z`) + DAY).toISOString());
  assert.deepEqual(autopilot.getState().rebalanceBudget, b, "the UI sees it");
  // Tomorrow, nothing of today's counts.
  assert.equal(autopilot.rebalanceBudget(Date.now() + DAY).spentSats, 0);
});

test("a payment's max fee never exceeds what is left of today's budget — before, one payment could overshoot it by its whole cap", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, { "rebalances.json": [logged({ feeSats: 950 })] });
  seams.rebalanceReport = async () => ({
    recommendations: [{ ...move("800001x1x0", 500, 30), maxCostSatsByPayback: 400, expectedRevenuePpm: 600, earningDemandSats: 300_000, minNetProfitSats: 100 }],
  });
  const sent: RebalanceExecParams[] = [];
  seams.rebalanceExec = async (_w, p) => {
    sent.push(p);
    return paidRebalance(p, 25);
  };
  await autopilot.runOnce();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].maxFeeSats, 50, "the 50 sat left, not the 400 sat payback cap");
  assert.deepEqual(sent[0].gate, { revenuePpm: 600, demandSats: 300_000, minNetSats: 100 }, "and the gate's earnings side at every size");
  assert.equal(sent[0].maxFeePpm, 500);
  assert.equal(autopilot.rebalanceBudget().spentSats, 975);
});

// ── skips are not failures (D15) ───────────────────────────────────────────────

test("a move the budget leaves for tomorrow is not a failed run: no history line, no 'failed' count — the rebalance decision says it, run after run", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 100 }, {}, { "rebalances.json": [logged({ feeSats: 100 })] });
  seams.rebalanceReport = async () => ({ recommendations: [move("800001x1x0", 500, 10)] });
  let paid = 0;
  seams.rebalanceExec = async (_w, p) => {
    paid += 1;
    return paidRebalance(p);
  };
  for (let i = 0; i < 3; i++) {
    const run = await autopilot.runOnce();
    assert.deepEqual([run.rebalances.length, run.attempted, run.failed], [0, 0, 0]);
  }
  assert.equal(paid, 0);
  // Before: three ok:false entries — and ~28–46 a day flushed the history.
  assert.deepEqual(autopilot.getState().history, []);
  assert.match(
    autopilot.getState().decisions.rebalance?.text ?? "",
    /1 profitable refill waits for the daily budget — 100 of 100 sat spent today, resets 00:00 UTC: peer-800001x1x0 \(~10 sat\)/,
  );
});

test("a failed refill is still a failed run — only deliberate skips are kept out", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 });
  seams.rebalanceReport = async () => ({ recommendations: [move("800001x1x0", 500, 10)] });
  seams.rebalanceExec = async (_w, p) => failedRebalance(p);
  const run = await autopilot.runOnce();
  assert.deepEqual([run.rebalances.length, run.failed], [1, 1]);
  assert.equal(autopilot.getState().history.length, 1);
});

// ── manual runs ─────────────────────────────────────────────────────────────

test("a manual rebalance counts toward the same daily budget: capped at what is left, refused when nothing is, and it starts the target's cooldown", async (t) => {
  t.mock.method(console, "log", () => undefined);
  installFetchMock(t).onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const api = await startApi(t, { node: new FakeLnd() });
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 200, rebalanceEnabled: true });
  const ap = api.autopilot as unknown as AutopilotSeams;
  const sent: RebalanceExecParams[] = [];
  ap.rebalanceExec = async (_w, p) => {
    sent.push(p);
    return paidRebalance(p, Math.min(150, p.maxFeeSats ?? 150));
  };
  // The confirm dialog promised at most 180 sat — and 200 are left: 180;
  // the gate's earnings side goes with it (every fallback size is checked).
  const gate = { revenuePpm: 400, demandSats: 600_000, minNetSats: 100 };
  const first = await api.request("POST", "/rebalance/execute", { targetId: "800001x1x0", sourceId: "800002x1x0", amountSats: 400_000, maxFeePpm: 500, maxFeeSats: 180, gate });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(sent[0].maxFeeSats, 180);
  assert.deepEqual(sent[0].gate, gate);
  const bad = await api.request("POST", "/rebalance/execute", { targetId: "800001x1x0", sourceId: "800002x1x0", amountSats: 400_000, gate: { revenuePpm: -1 } });
  assert.equal(bad.status, 400);
  assert.equal(api.autopilot.rebalanceBudget().spentSats, 150, "a manual refill's fee is today's spend too");
  const log = (api.autopilot as unknown as { rebalanceLog: { successes(): RebalanceRecord[] } }).rebalanceLog;
  const [manual] = log.successes();
  assert.deepEqual([manual.via, manual.holdPpm], ["manual", 400], "booked as manual — run with the gate, it holds the gate's value");
  // 50 left: a manual run may pay at most that, whatever it asks for.
  await api.request("POST", "/rebalance/execute", { targetId: "800003x1x0", sourceId: "800002x1x0", amountSats: 400_000, maxFeePpm: 500 });
  assert.equal(sent[1].maxFeeSats, 50);
  assert.deepEqual([log.successes()[0].targetId, log.successes()[0].holdPpm], ["800003x1x0", undefined], "without the gate: its own price, no hold");
  // Nothing left: refused before anything is paid.
  const refused = await api.request("POST", "/rebalance/execute", { targetId: "800004x1x0", sourceId: "800002x1x0", amountSats: 400_000 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "budget_exhausted");
  assert.match(refused.body.message, /today's rebalance fee budget is used up \(200 of 200 sat, manual runs included\)/);
  assert.equal(sent.length, 2);
  // The manual refill started the target's cooldown: the autopilot doesn't
  // refill the same channel again right after.
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 10_000 });
  ap.rebalanceReport = async () => ({ recommendations: [move("800001x1x0", 500, 10)] });
  await api.autopilot.runOnce();
  assert.equal(sent.length, 2, "on cooldown after the manual refill");
});

/** A promise the test resolves: a payment whose HTLC is out until then. */
function held(t: { after(fn: () => void): void }) {
  let release = () => undefined as void;
  const released = new Promise<void>((r) => (release = r));
  t.after(() => release());
  return { released, release };
}

test("a manual refill never pays beside the autopilot's rebalance stage — nor beside another manual one (409, saying a refill is under way) — so two payments can't both pass the budget check", async (t) => {
  t.mock.method(console, "log", () => undefined);
  installFetchMock(t).onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const api = await startApi(t, { node: new FakeLnd() });
  api.autopilot.setConfig({ rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  const ap = api.autopilot as unknown as AutopilotSeams;
  ap.rebalanceReport = async () => ({ recommendations: [move("800005x1x0", 500, 10)] });
  const paying: string[] = [];
  // Only the payment under way hangs (its HTLC is out); one sent beside it —
  // the regression — would come straight back, so the 409 check fails at
  // once instead of waiting forever.
  let hold = held(t);
  let holding = "800005x1x0";
  ap.rebalanceExec = async (_w, p) => {
    paying.push(p.targetId);
    if (p.targetId === holding) await hold.released;
    return paidRebalance(p);
  };
  const run = api.autopilot.runOnce();
  await until(() => paying.length === 1, "the autopilot's refill is paying");
  const manual = { targetId: "800001x1x0", sourceId: "800002x1x0", amountSats: 400_000 };
  const refused = await api.request("POST", "/rebalance/execute", manual);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "busy");
  assert.match(refused.body.message, /^A refill is already under way \(the autopilot's or another manual one\) — try again in a few minutes\./);
  assert.deepEqual(paying, ["800005x1x0"]);
  hold.release();
  await run;
  // Then it goes — and a second manual refill while it pays is refused too.
  hold = held(t);
  holding = "800001x1x0";
  const first = api.request("POST", "/rebalance/execute", manual);
  await until(() => paying.length === 2, "the manual refill is paying");
  const second = await api.request("POST", "/rebalance/execute", { ...manual, targetId: "800003x1x0" });
  assert.equal(second.status, 409);
  hold.release();
  assert.equal((await first).status, 200);
  assert.deepEqual(paying, ["800005x1x0", "800001x1x0"]);
});

test("a manual refill holds only the refill lock: a main run meanwhile still applies fees — its own refills wait for the next run, and the decision says why", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { enabled: true, rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800001x1x0", 500, 420)] });
  const applied: string[] = [];
  seams.feeApply = async (_w, items) => {
    applied.push(...items.map((i) => `${i.id}@${i.feeRatePpm}`));
    return items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm }));
  };
  seams.rebalanceReport = async () => ({ recommendations: [move("800005x1x0", 500, 10)] });
  const hold = held(t);
  const paying: string[] = [];
  seams.rebalanceExec = async (_w, p) => {
    paying.push(p.targetId);
    if (p.targetId === "800009x1x0") await hold.released; // the manual refill's HTLC is out
    return paidRebalance(p);
  };
  const manual = autopilot.rebalanceByHand({ targetId: "800009x1x0", sourceId: "800002x1x0", amountSats: 400_000, econRatio: 0.8 });
  await until(() => paying.length === 1, "the manual refill is paying");
  // Before: the manual refill held the main run's lock for up to 150 s — the
  // scheduled run was skipped whole (fees, lease promises, channel opens and
  // Magma upkeep waited 30 minutes), and Apply on the Fees tab got a 409.
  const run = await autopilot.runOnce();
  assert.deepEqual(applied, ["800001x1x0@420"], "the run applied its fee change while the manual refill paid");
  assert.equal(run.changes.length, 1);
  assert.deepEqual(paying, ["800009x1x0"], "its own refill doesn't pay beside the manual one");
  assert.equal(autopilot.getState().decisions.rebalance?.text, "a manual refill is under way — the autopilot's refills wait for the next run");
  assert.notEqual(await autopilot.applyRecommended(), null, "nor is Apply on the Fees tab refused meanwhile");
  hold.release();
  assert.equal((await manual)?.ok, true);
  await autopilot.runOnce();
  assert.deepEqual(paying, ["800009x1x0", "800005x1x0"], "the next run refills");
});

test("a manual refill into or out of a channel whose earlier payment may still land is refused (409, in flight) before anything is sent — the autopilot never sends one there either; the tab's plan carries the payment, to show it instead of a Run button", async (t) => {
  t.mock.method(console, "log", () => undefined);
  installFetchMock(t).onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  // An autopilot refill from 800000x1x0 into 800001x1x0 is still in flight.
  const at = new Date().toISOString();
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({
      config: { rebalanceDailyBudgetSats: 10_000 },
      history: [],
      sellAutoSizeMigrated: true,
      pendingRebalances: [
        { id: "ab".repeat(32), targetId: "800001x1x0", sourceId: "800000x1x0", alias: "drained", sourceAlias: "donor", amountSats: 400_000, maxFeeSats: 60, day: at.slice(0, 10), at, via: "autopilot", holdPpm: 400 },
      ],
    }),
  );
  const api = await startApi(t, { node: new FakeLnd(), dir });
  const ap = api.autopilot as unknown as AutopilotSeams;
  const sent: RebalanceExecParams[] = [];
  ap.rebalanceExec = async (_w, p) => {
    sent.push(p);
    return paidRebalance(p);
  };
  // Into the channel it refills, out of it, into the channel it drains, out of that one.
  const cases: [string, string, RegExp][] = [
    ["800001x1x0", "800002x1x0", /^A payment into drained is still in flight/],
    ["800003x1x0", "800001x1x0", /^A payment into drained is still in flight/],
    ["800000x1x0", "800002x1x0", /^A payment out of donor is still in flight/],
    ["800003x1x0", "800000x1x0", /^A payment out of donor is still in flight/],
  ];
  for (const [targetId, sourceId, what] of cases) {
    const res = await api.request("POST", "/rebalance/execute", { targetId, sourceId, amountSats: 400_000 });
    assert.equal(res.status, 409, `${targetId} ← ${sourceId}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "in_flight");
    assert.match(res.body.message, what);
    assert.match(res.body.message, /LightningMate is waiting to learn how it ended \(checked every 2 minutes\)/);
  }
  // Before: sent — a second move through a channel whose first may still land.
  assert.equal(sent.length, 0);
  // Through other channels it goes.
  const elsewhere = await api.request("POST", "/rebalance/execute", { targetId: "800003x1x0", sourceId: "800002x1x0", amountSats: 400_000 });
  assert.equal(elsewhere.status, 200, JSON.stringify(elsewhere.body));
  assert.equal(sent.length, 1);
  // The tab learns of the payment with the plan.
  ap.rebalanceReport = async () => ({ recommendations: [] });
  const plan = await api.request("GET", "/rebalance/recommendations");
  assert.deepEqual(
    (plan.body.inFlight as { targetId: string; sourceId: string; alias: string; sourceAlias: string; via: string }[]).map((p) => [p.targetId, p.sourceId, p.alias, p.sourceAlias, p.via]),
    [["800001x1x0", "800000x1x0", "drained", "donor", "autopilot"]],
  );
});

test("the Rebalancing tab's plan comes with today's budget — the confirm dialog's cap and 'budget-blocked' read it; without it the dialog said there was no daily limit", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([logged({ feeSats: 300 })]));
  const api = await startApi(t, { node: new FakeLnd(), dir });
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 1_000 });
  (api.autopilot as unknown as AutopilotSeams).rebalanceReport = async () => ({ recommendations: [move("800001x1x0", 500, 10)] });
  const res = await api.request("GET", "/rebalance/recommendations");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.budget, api.autopilot.rebalanceBudget());
  assert.deepEqual([res.body.budget.budgetSats, res.body.budget.spentSats, res.body.budget.leftSats], [1_000, 300, 700]);
  assert.deepEqual(res.body.inFlight, []);
});

test("a manual refill whose route fails backs off that source → target pair, like the autopilot's own attempts", async (t) => {
  const { autopilot, seams } = autopilotWith(t, {});
  seams.rebalanceExec = async (_w, p) => ({ ...failedRebalance(p), failedSourceIds: [p.sourceId] });
  const res = await autopilot.rebalanceByHand({ targetId: "800001x1x0", sourceId: "800002x1x0", amountSats: 400_000, econRatio: 0.8 });
  assert.equal(res?.ok, false);
  const state = (autopilot as unknown as { state: { perPairRebalanceFails?: Record<string, { fails: number }> } }).state;
  assert.equal(state.perPairRebalanceFails?.["800002x1x0>800001x1x0"]?.fails, 1);
});

test("the payback limit goes with the payment: a move whose fee must be earned back within 30 sat pays at most 30, whatever the budget left", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 });
  seams.rebalanceReport = async () => ({
    recommendations: [{ ...move("800001x1x0", 500, 10), maxCostSatsByPayback: 30, expectedRevenuePpm: 600, earningDemandSats: 300_000, minNetProfitSats: 100 }],
  });
  const sent: RebalanceExecParams[] = [];
  seams.rebalanceExec = async (_w, p) => {
    sent.push(p);
    return paidRebalance(p, 9);
  };
  await autopilot.runOnce();
  assert.equal(sent[0]?.maxFeeSats, 30, "the 30 sat payback limit, not the 1,000 sat left");
});

// ── the hour window is UTC, like the budget's day ─────────────────────────────

test("the rebalance hours are UTC, whatever the container's time zone — the budget's day is UTC too", async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = "Asia/Kolkata"; // UTC+5:30: its hour is never the UTC hour
  t.after(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });
  const h = new Date().getUTCHours();
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceHourStart: h, rebalanceHourEnd: (h + 1) % 24 });
  seams.rebalanceReport = async () => ({ recommendations: [move("800001x1x0", 500, 10)] });
  let paid = 0;
  seams.rebalanceExec = async (_w, p) => {
    paid += 1;
    return paidRebalance(p);
  };
  await autopilot.runOnce();
  assert.equal(paid, 1, "inside the UTC window");
  // Outside it: no refill, and the decision says why.
  const other = autopilotWith(t, { rebalanceEnabled: true, rebalanceHourStart: (h + 2) % 24, rebalanceHourEnd: (h + 3) % 24 });
  other.seams.rebalanceReport = seams.rebalanceReport;
  other.seams.rebalanceExec = seams.rebalanceExec;
  await other.autopilot.runOnce();
  assert.equal(paid, 1);
  assert.match(other.autopilot.getState().decisions.rebalance?.text ?? "", /outside the rebalance hours \(\d+–\d+ UTC\)/);
});

// ── settings that work ─────────────────────────────────────────────────────────

test("every rebalance setting binds the gate — the three that reached nothing are gone, the ones that bind are settable and checked", (t) => {
  const { autopilot } = autopilotWith(t, {});
  autopilot.setConfig({ rebalancePolicy: { econRatio: 0.5, minNetProfitSats: 500, maxPaybackDays: 10, maxAmountSats: 300_000 } });
  assert.deepEqual(autopilot.rebalanceRecOverrides(), {
    profitShare: 0.5,
    minExpectedNetProfitSats: 500,
    maxPaybackDays: 10,
    maxRebalanceAmountPerChannel: 300_000,
  });
  for (const bad of [{ minNetProfitSats: 0 }, { maxPaybackDays: 0 }, { maxAmountSats: 10_000 }, { econRatio: 80 }]) {
    assert.throws(() => autopilot.setConfig({ rebalancePolicy: bad }), ConfigValidationError, JSON.stringify(bad));
  }
  assert.deepEqual(Object.keys(AUTOPILOT_CONFIG_BOUNDS.rebalancePolicy).sort(), ["econRatio", "maxAmountSats", "maxPaybackDays", "minNetProfitSats"]);
  // An old config's dead fields are dropped on load; the gate's own defaults stand.
  const { config } = sanitizePersistedConfig({ rebalancePolicy: { econRatio: 0.7, amountSats: 300_000, maxLocalRatioTarget: 0.3, minLocalRatioSource: 0.6 } });
  assert.deepEqual(config.rebalancePolicy, { econRatio: 0.7, minNetProfitSats: 100, maxPaybackDays: 21, maxAmountSats: 2_000_000 });
});

test("the old candidates engine is gone: GET /rebalance/candidates is not a route any more", async (t) => {
  const api = await startApi(t, { node: new FakeLnd() });
  const res = await api.request("GET", "/rebalance/candidates");
  assert.equal(res.status, 404);
});

test("a drained channel the gate turns down says what a refill would need — 'auto-rebalance on, nothing happens' is explained", () => {
  const rec = {
    capacity: 2_000_000,
    expectedRevenuePpm: 80,
    revenuePpm30d: 80,
    estimatedRouteCostPpm: 50,
    routedOut14d: 300_000,
    routedIn14d: 100_000,
  } as RebalanceRecommendation;
  // 80 ppm earned, a 50 ppm route: above the 0.8 × 80 = 64 ppm cost cap? No
  // — but 30 ppm of margin needs 3.3M to net 100 sat, and 500k is the most
  // this 2M channel takes: it needs earnings of ≥ 250 ppm on that route.
  assert.equal(
    wouldTake(rec, REBAL_REC_DEFAULTS, null),
    "to clear the 100 sat minimum at a ~50 ppm route it needs earnings of ≥ 250 ppm (now 80 ppm) on a refill of up to 500k",
  );
  // Earning enough per sat, but not enough outflow yet.
  const rich = { ...rec, expectedRevenuePpm: 400, revenuePpm30d: 400, estimatedRouteCostPpm: 150 } as RebalanceRecommendation;
  assert.equal(
    wouldTake(rich, REBAL_REC_DEFAULTS, null),
    "to clear the 100 sat minimum at 400 ppm earnings and a ~150 ppm route it needs a refill of ≥ 400k: ≥ 400k of 14-day outflow (now 300k) and ≥ 267k of 14-day net drain (now 200k)",
  );
  // No route probed: the market's replacement cost stands in.
  assert.match(wouldTake({ ...rec, estimatedRouteCostPpm: null } as RebalanceRecommendation, REBAL_REC_DEFAULTS, 60) ?? "", /at a ~60 ppm route/);
});

// ── how a refill is booked ────────────────────────────────────────────────────

test("an autopilot refill is booked with the price the gate valued it at and the target's sent counter — what the fee engine holds and retires", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  seams.rebalanceReport = async () => ({
    recommendations: [{ ...move("800001x1x0", 500, 10), expectedRevenuePpm: 400, earningDemandSats: 300_000, minNetProfitSats: 100 }],
  });
  seams.rebalanceExec = async (_w, p) => ({ ...paidRebalance(p, 12), targetSentBefore: 5_000_000 });
  await autopilot.runOnce();
  const log = (autopilot as unknown as { rebalanceLog: { successes(): RebalanceRecord[] } }).rebalanceLog;
  const [rec] = log.successes();
  assert.deepEqual([rec.via, rec.holdPpm, rec.targetSentBefore], ["autopilot", 400, 5_000_000]);
});

test("a refill still in flight keeps what its booking needs, and lands with it — on the day it was sent, even when that was yesterday", async (t) => {
  const yesterday = new Date(Date.now() - DAY).toISOString();
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 });
  seams.rebalanceReport = async () => ({
    recommendations: [{ ...move("800001x1x0", 500, 10), expectedRevenuePpm: 400, earningDemandSats: 300_000, minNetProfitSats: 100 }],
  });
  seams.rebalanceExec = async (_w, p) => ({ ...failedRebalance(p), targetSentBefore: 7_000_000, inFlight: { paymentId: "ab".repeat(32), maxFeeSats: 40 } });
  await autopilot.runOnce();
  const state = (autopilot as unknown as { state: { pendingRebalances: { holdPpm?: number; targetSentBefore?: number; day: string; at: string }[] } }).state;
  assert.deepEqual([state.pendingRebalances[0].holdPpm, state.pendingRebalances[0].targetSentBefore], [400, 7_000_000]);
  // Say it was sent just before midnight: it lands today.
  state.pendingRebalances[0].day = yesterday.slice(0, 10);
  state.pendingRebalances[0].at = yesterday;
  (autopilot as unknown as { rebalancePaymentStatus: () => Promise<unknown> }).rebalancePaymentStatus = async () => ({ state: "confirmed", feeSats: 12 });
  seams.rebalanceReport = async () => ({ recommendations: [] });
  await autopilot.runOnce();
  const log = (autopilot as unknown as { rebalanceLog: { successes(): RebalanceRecord[] } }).rebalanceLog;
  const [rec] = log.successes();
  assert.deepEqual([rec.startedAt, rec.holdPpm, rec.targetSentBefore, rec.feeSats], [yesterday, 400, 7_000_000, 12]);
  assert.equal(autopilot.rebalanceBudget().spentSats, 0, "yesterday's budget paid for it, not today's");
  assert.equal(autopilot.rebalanceBudget(Date.now() - DAY).spentSats, 12);
});

test("a payment of this run left in flight takes its channels out of the run's later moves — a second refill from the same source could double the move", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000, maxRebalancesPerRun: 2 });
  seams.rebalanceReport = async () => ({ recommendations: [move("800001x1x0", 500, 10), move("800002x1x0", 400, 10)] });
  const paid: string[] = [];
  seams.rebalanceExec = async (_w, p) => {
    paid.push(p.targetId);
    return { ...failedRebalance(p), inFlight: { paymentId: "cd".repeat(32), maxFeeSats: 40 } };
  };
  await autopilot.runOnce();
  assert.deepEqual(paid, ["800001x1x0"], "both drain 800000x1x0: the second waits while the first may still land");
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", /peer-800002x1x0: its channels are busy with a payment still in flight/);
});

test("profitable moves beyond the per-run limit wait for the next run — and the decision says so", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000, maxRebalancesPerRun: 1 });
  seams.rebalanceReport = async () => ({
    recommendations: [move("800001x1x0", 500, 10), { ...move("800002x1x0", 400, 10), selectedSourceChannel: "800003x1x0" }],
  });
  const paid: string[] = [];
  seams.rebalanceExec = async (_w, p) => {
    paid.push(p.targetId);
    return paidRebalance(p);
  };
  await autopilot.runOnce();
  assert.deepEqual(paid, ["800001x1x0"]);
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", /^1 of 1 refill paid · 1 more waits for the next run \(at most 1 per run\)$/);
});

test("a move the run's earlier payments leave no budget for waits too — not a failed run (the backstop inside the run)", async (t) => {
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 100, maxRebalancesPerRun: 2 });
  // Both estimated at 10 sat: the planner admits both. The first costs 95.
  seams.rebalanceReport = async () => ({
    recommendations: [move("800001x1x0", 500, 10), { ...move("800002x1x0", 400, 10), selectedSourceChannel: "800003x1x0" }],
  });
  const paid: string[] = [];
  seams.rebalanceExec = async (_w, p) => {
    paid.push(p.targetId);
    return paidRebalance(p, 95);
  };
  const run = await autopilot.runOnce();
  assert.deepEqual(paid, ["800001x1x0"]);
  assert.deepEqual([run.rebalances.length, run.failed], [1, 0]);
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", /1 profitable refill waits for the daily budget — 95 of 100 sat spent today.*peer-800002x1x0 \(~10 sat\)/);
});

test("the rebalance log keeps successes apart from failures: a burst of failed attempts no longer pushes paid fees out of the books", (t) => {
  const dir = makeTempDir(t);
  const log = new RebalanceLog(dir);
  log.append(logged({ at: new Date(Date.now() - 300 * DAY).toISOString(), feeSats: 77 }));
  log.append(logged({ at: new Date(Date.now() - 500 * DAY).toISOString(), feeSats: 99 })); // past the 400 days kept
  for (let i = 0; i < 300; i++) log.append(logged({ ok: false, feeSats: null, error: "no route" }));
  log.append(logged({ feeSats: 5 }));
  // Before: 200 records of both kinds — the failures had pushed every fee out.
  assert.deepEqual(log.successes().map((r) => r.feeSats), [5, 77]);
  assert.equal(log.recent(1000).filter((r) => !r.ok).length, 200, "only the latest 200 failures are kept");
  assert.deepEqual(log.successes(Date.now() - DAY).map((r) => r.feeSats), [5]);
  assert.equal(new RebalanceLog(dir).successes().length, 2, "and that is what is on disk");
});
