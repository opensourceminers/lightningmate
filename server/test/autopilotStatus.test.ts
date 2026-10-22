/**
 * What the autopilot decided, per area, and why (D16; review a6-ux:no-why-
 * not-status, a8-engineering:autopilot-decisions-invisible, a6-ux:numbers-
 * mislead and a6-ux:presets-unconfirmed-capital — package P7).
 *
 * Before:
 *  - a run that changed nothing left no trace: the fee stage said nothing at
 *    all, the max_htlc pass swallowed its failures (`.catch(() => [])`), and
 *    "Run once now" during a run answered "0 applied, 0 failed of 0
 *    attempted" — as if a run had found nothing to do;
 *  - a standing wait was a new note (and a new log line) every 30 minutes;
 *  - the Overview paired the latest run's time with the counts of the last
 *    run that did something, days old maybe, and counted only successes;
 *  - there was no way to stop everything at once.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { buildDashboard } from "../src/services/dashboard.js";
import { Autopilot, MAGMA_REPORT_SHARE_MS, feeDecision, lastAutopilotActionAt, sanitizePaused, type AreaDecision } from "../src/services/autopilot.js";
import { stateFileList } from "../src/routes/api.js";
import { labelCostChannels } from "../src/services/rebalanceCosts.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { timestampConsole } from "../src/services/log.js";
import { autopilotWith, failedRebalance, plannedFeeChange, plannedRebalance, sellerSetup, suggestion, suppressSchedulerKicks } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { installChain, installPayments } from "./helpers/chain.js";
import { feeNode } from "./helpers/feeNode.js";
import { withEnv } from "./helpers/env.js";
import { makeTempDir } from "./helpers/tmp.js";
import { quiet } from "./helpers/lifecycle.js";
import type { FeeRecommendation } from "../src/services/feeRecommend.js";

const held = (id: string, guard: string) => ({ ...plannedFeeChange(id, 300, 300, { wouldApply: false }), blockedByGuards: [guard] }) as unknown as FeeRecommendation;
const atTarget = (id: string) => ({ ...plannedFeeChange(id, 300, 300, { wouldApply: false }), blockedByGuards: [] }) as unknown as FeeRecommendation;

test("a fee run that changes nothing says why, counted over every channel — before, it left no trace", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  seams.feeReport = async () => ({
    recommendations: [atTarget("800001x1x0"), atTarget("800002x1x0"), held("800003x1x0", "raise cooldown active"), held("800004x1x0", "change below threshold")],
  });
  await autopilot.runOnce();
  const fees = autopilot.getState().status.fees;
  assert.equal(fees.state, "idle");
  assert.equal(
    fees.text,
    "no fee needed changing — 4 channels checked: 2 already at their target, 1 held by the cooldown or the once-a-day pacing of lowerings, 1 a change too small to send",
  );
  assert.equal(autopilot.getState().history.length, 0, "still no history line for a run that did nothing");
});

test("a fee run that changes fees says which — and one whose every update LND refused is an error", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800001x1x0", 300, 280), plannedFeeChange("800002x1x0", 100, 120)] });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm }));
  await autopilot.runOnce();
  const fees = autopilot.getState().status.fees;
  assert.deepEqual([fees.state, fees.text], ["acted", "2 fee updates applied: peer-800001x1x0 300→280 ppm, peer-800002x1x0 100→120 ppm"]);
  // Every update refused: red, with LND's words.
  const r = feeDecision([plannedFeeChange("a", 1, 2)], [{ alias: "a", fromPpm: 1, toPpm: 2, ok: false, error: "LND refused: invalid policy — not retried for 6 h" }]);
  assert.deepEqual(r, { text: "1 update LND refused (LND refused: invalid policy — not retried for 6 h)", state: "error" });
});

test("an area switched off says it is off — whatever it last decided — and with write mode off every area is blocked", async (t) => {
  quiet(t);
  const { autopilot } = autopilotWith(t, { enabled: false, rebalanceEnabled: false });
  const st = autopilot.getState().status;
  assert.deepEqual([st.fees.state, st.rebalance.state, st.channels.state, st.magma.state, st.maxHtlc.state], ["off", "off", "off", "off", "off"]);
  assert.match(st.rebalance.text, /^auto-rebalance is off — refills run only when you start one$/);
  // Switched on, not run yet: said so (no stale or empty line) — its own
  // state, not "nothing to do", which nobody checked (review of P7).
  autopilot.setConfig({ enabled: true });
  assert.deepEqual([autopilot.getState().status.fees.state, autopilot.getState().status.fees.at], ["not_run", null]);
  assert.match(autopilot.getState().status.fees.text, /^not run yet since it was switched on/);

  const api = await startApi(t, { readOnly: true });
  const ro = (await api.request("GET", "/autopilot")).body;
  for (const area of ["fees", "rebalance", "channels", "magma", "maxHtlc"]) {
    assert.equal(ro.status[area].state, "blocked", area);
    assert.match(ro.status[area].text, /write mode is off \(LM_ENABLE_WRITE\)/);
  }
});

test("a standing wait is ONE decision counted up — 'waiting ×3 since …' — not a new note and a new log line every run", async (t) => {
  const logged: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logged.push(String(line)));
  t.mock.method(console, "warn", () => undefined);
  // The window is two hours that never include the current one.
  const h = new Date().getUTCHours();
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceHourStart: (h + 2) % 24, rebalanceHourEnd: (h + 4) % 24 });
  seams.rebalanceReport = async () => ({ recommendations: [] });
  for (let i = 0; i < 3; i++) await autopilot.runOnce();
  const d = autopilot.getState().status.rebalance;
  assert.equal(d.state, "waiting");
  assert.equal(d.repeats, 3);
  assert.ok(d.since && d.at && Date.parse(d.since) <= Date.parse(d.at));
  // Logged once, with its time.
  const lines = logged.filter((l) => l.includes("[autopilot] rebalance: waiting — outside the rebalance hours"));
  assert.equal(lines.length, 1, JSON.stringify(logged));
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[autopilot\] /);
});

test("the max_htlc pass failing is that area's error — no longer swallowed — and the same failure again is no new line of history", async (t) => {
  quiet(t);
  t.mock.method(console, "error", () => undefined);
  const { autopilot, node } = autopilotWith(t, { maxHtlcEnabled: true });
  node.override("default.listChannels", (_a, cb) => cb({ details: "transport is closing" }));
  const first = await autopilot.runOnce();
  // Before: `.catch(() => [])` — nothing in the run, nothing anywhere.
  assert.deepEqual(first.errors?.map((e) => e.stage), ["max_htlc"]);
  const st = autopilot.getState().status.maxHtlc;
  assert.equal(st.state, "error");
  assert.match(st.text, /^the max_htlc stage failed: .*transport is closing/);
  assert.match(st.lastError?.text ?? "", /transport is closing/);
  const second = await autopilot.runOnce();
  assert.equal(autopilot.getState().history.length, 1, "the same failure again: one line of history for two identical failures");
  assert.equal(autopilot.getState().status.maxHtlc.repeats, 2, "counted up on the area instead");
  // The pass itself failed all the same: its own result and summary say so
  // (review of P7 — "Run once now" read "nothing needed doing", the Overview
  // "nothing needed changing", from the second identical failure on).
  assert.deepEqual(second.errors?.map((e) => e.stage), ["max_htlc"]);
  assert.deepEqual([second.attempted, second.failed], [1, 1]);
  assert.deepEqual(autopilot.getState().lastRun?.errors, ["max_htlc"]);
  assert.equal(autopilot.getState().lastRun?.failed, 1);
});

test("Magma: no offer and auto-pricing off says why none is listed; no Amboss key is 'blocked' — before, both were silent", async (t) => {
  quiet(t);
  const { autopilot, amboss } = sellerSetup(t);
  await autopilot.runOnce();
  const m = autopilot.getState().status.magma;
  // Blocked: with selling on, no offer will ever be listed until the
  // operator acts — "nothing to do" hid that (review of P7).
  assert.equal(m.state, "blocked");
  assert.equal(m.text, "no offer listed — auto-pricing is off, so the autopilot lists none: create one on Market → Sell, or turn auto-pricing on");
  amboss.clear();
  const blocked = autopilot.getState().status.magma;
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.text, /^no Amboss API key — connect one in Settings/);
  assert.equal((blocked.last as AreaDecision | undefined)?.text, m.text, "what it last decided stays at hand");
});

test("Magma with an offer listed and nothing to change says what is listed — the offer's window and price — not just 'managed'", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 20_000_000 });
  magma.addOffer({ id: "offer-abcdef12", minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRatePpm: 1200, baseFeeSats: 852 });
  await autopilot.runOnce();
  const m = autopilot.getState().status.magma;
  assert.equal(m.state, "idle");
  assert.match(m.text, /^1 offer listed \(offer-ab… 1,000,000–2,000,000 sat at 1,200 ppm \+ 852 sat\), nothing to change — their terms are yours; the autopilot only keeps them fundable$/);
});

test("a refill still in flight is no failure (yet): not counted as failed, and the rebalance decision says it is in flight", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 });
  seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500)] });
  seams.rebalanceExec = async (_w, p) => ({
    ...failedRebalance(p),
    error: "payment still in flight after 150s — it may still land",
    inFlight: { paymentId: "ab".repeat(32), maxFeeSats: 40 },
  });
  const run = await autopilot.runOnce();
  assert.equal(run.rebalances[0]?.inFlight, true);
  assert.deepEqual([run.attempted, run.applied, run.failed], [1, 0, 0], "before: 1 failed — a red ✗ for a payment that may still land");
  assert.deepEqual(autopilot.getState().status.rebalance, { ...autopilot.getState().status.rebalance, state: "acted" });
  assert.match(autopilot.getState().status.rebalance.text, /^0 of 1 refill paid \(1 still in flight\)/);
  assert.deepEqual(autopilot.getState().lastRun?.rebalances, { ok: 0, failed: 0, inFlight: 1 });
});

test("the Overview pairs the last run's time with THAT run's counts — a fresh no-op run never shows an old run's '2 fees adjusted' — and failures count", async (t) => {
  quiet(t);
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const oldRun = {
    at: threeDaysAgo, attempted: 2, applied: 2, failed: 0,
    changes: [{ id: "a", alias: "a", fromPpm: 1, toPpm: 2, ok: true }, { id: "b", alias: "b", fromPpm: 1, toPpm: 2, ok: true }],
    rebalances: [], channels: [], sells: [],
  };
  const { autopilot, seams } = autopilotWith(t, { enabled: true }, { history: [oldRun], lastRunAt: threeDaysAgo });
  seams.feeReport = async () => ({ recommendations: [atTarget("800001x1x0")] });
  await autopilot.runOnce();
  const state = autopilot.getState();
  const report = { windowDays: 30, totalFeesEarnedSats: 0, totalForwards: 0, totalRoutedSats: 0, daily: [], recent: [], perChannel: [] } as unknown as Parameters<typeof buildDashboard>[0];
  const d = buildDashboard(report, { invoices: [], payments: [] }, [], { count: 0, totalAmountSats: 0 }, state, 0);
  assert.equal(d.autopilot.lastRunAt, state.lastRunAt);
  // Before: lastFeeChanges 2 (the run from three days ago), under "Autopilot 0m ago".
  assert.deepEqual(d.autopilot.lastRun, { applied: 0, attempted: 0, failed: 0, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0, errors: [] });
  assert.equal(d.autopilot.lastActionAt, threeDaysAgo, "the last change is its own item");
  assert.equal(d.autopilot.pausedAt, null);
  assert.equal(d.autopilot.status.fees?.state, "idle");

  // A run whose every fee update fails: its failures are counted.
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800001x1x0", 300, 280)] });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: false, feeRatePpm: i.feeRatePpm, error: "refused" }));
  await autopilot.runOnce();
  const failedDash = buildDashboard(report, { invoices: [], payments: [] }, [], { count: 0, totalAmountSats: 0 }, autopilot.getState(), 0).autopilot;
  assert.deepEqual([failedDash.lastRun?.applied, failedDash.lastRun?.failed, failedDash.lastRun?.feeChanges], [0, 1, 0]);
  // A run whose every attempt failed changed nothing: the last change is still the old one.
  assert.equal(failedDash.lastActionAt, threeDaysAgo);
});

test("a summary from before the upgrade (none for the latest run) is never paired with the latest run's time", () => {
  const report = { windowDays: 30, totalFeesEarnedSats: 0, totalForwards: 0, totalRoutedSats: 0, daily: [], recent: [], perChannel: [] } as unknown as Parameters<typeof buildDashboard>[0];
  const d = buildDashboard(
    report,
    { invoices: [], payments: [] },
    [],
    { count: 0, totalAmountSats: 0 },
    {
      config: { enabled: true, rebalanceEnabled: false, channelEnabled: false, sellEnabled: false, maxHtlcEnabled: false, intervalMinutes: 30 },
      lastRunAt: new Date().toISOString(),
      // A summary of an older pass (the latest one threw before it was kept).
      lastRun: {
        at: new Date(Date.now() - 3_600_000).toISOString(), attempted: 2, applied: 2, failed: 0,
        feeChanges: { ok: 2 }, rebalances: { ok: 0 }, opens: { ok: 0 }, sells: { ok: 0 }, maxHtlc: { ok: 0 }, errors: [],
      },
      history: [],
    },
    0,
  );
  assert.equal(d.autopilot.lastRun, null, "no counts of another pass beside this pass's time");
});

test("'Run once now' while a run is in progress answers 409 'busy' — not an empty run that reads '0 applied of 0 attempted'", async (t) => {
  quiet(t);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 1_000_000 }) });
  api.autopilot.setConfig({ enabled: true });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  (api.autopilot as unknown as { feeReport: () => Promise<unknown> }).feeReport = async () => {
    await gate;
    return { recommendations: [] };
  };
  const running = api.autopilot.runOnce();
  const res = await api.request("POST", "/autopilot/run", {});
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, "busy");
  assert.match(res.body.message, /^A run is already in progress \(since \d{2}:\d{2} UTC\) — its result shows here when it ends\.$/);
  release();
  await running;
  const done = await api.request("POST", "/autopilot/run", {});
  assert.equal(done.status, 200);
  assert.equal(done.body.state.lastRun.at, done.body.run.at, "the answer carries the run's own summary");
});

test("'Pause all automation' switches everything off at once and remembers what was on; 'Resume' switches it back — never selling, whose switch-on is its own decision (D9)", async (t) => {
  quiet(t);
  const { autopilot } = autopilotWith(t, { enabled: true, rebalanceEnabled: true, channelEnabled: true, sellEnabled: true, maxHtlcEnabled: false });
  autopilot.pauseAll();
  const c = autopilot.getState().config;
  assert.deepEqual([c.enabled, c.rebalanceEnabled, c.channelEnabled, c.sellEnabled, c.maxHtlcEnabled], [false, false, false, false, false]);
  assert.deepEqual(autopilot.getState().paused?.was, ["enabled", "rebalanceEnabled", "channelEnabled", "sellEnabled"]);
  assert.equal(autopilot.getState().status.channels.state, "off");
  const { resumed, sellingWasOn } = autopilot.resumeAll();
  assert.deepEqual(resumed, ["enabled", "rebalanceEnabled", "channelEnabled"]);
  assert.equal(sellingWasOn, true);
  const r = autopilot.getState().config;
  assert.deepEqual([r.enabled, r.rebalanceEnabled, r.channelEnabled, r.sellEnabled, r.maxHtlcEnabled], [true, true, true, false, false]);
  assert.equal(autopilot.getState().paused, null);
  // A pause with nothing on is no pause.
  autopilot.setConfig({ enabled: false, rebalanceEnabled: false, channelEnabled: false });
  autopilot.pauseAll();
  assert.equal(autopilot.getState().paused, null);
  // A switch turned on by hand ends a pause: "Resume" must not switch on
  // what the operator left off since.
  autopilot.setConfig({ enabled: true, rebalanceEnabled: true });
  autopilot.pauseAll();
  autopilot.setConfig({ enabled: true });
  assert.equal(autopilot.getState().paused, null);
  assert.deepEqual(autopilot.resumeAll(), { resumed: [], sellingWasOn: false });
  assert.equal(autopilot.getState().config.rebalanceEnabled, false);
});

test("POST /autopilot/pause and /resume", async (t) => {
  quiet(t);
  const api = await startApi(t);
  api.autopilot.setConfig({ enabled: true, channelEnabled: true });
  const paused = await api.request("POST", "/autopilot/pause", {});
  assert.equal(paused.status, 200);
  assert.deepEqual([paused.body.config.enabled, paused.body.config.channelEnabled], [false, false]);
  assert.deepEqual(paused.body.paused.was, ["enabled", "channelEnabled"]);
  const resumed = await api.request("POST", "/autopilot/resume", {});
  assert.deepEqual(resumed.body.resumed, ["enabled", "channelEnabled"]);
  assert.deepEqual([resumed.body.state.config.enabled, resumed.body.state.config.channelEnabled, resumed.body.state.paused], [true, true, null]);
});

// Review of P7, round 2: LSP mode (Settings) is no switch of the
// autopilot's — "Pause all automation" leaves it on, and it keeps answering
// wallet orders and opening their channels from on-chain funds. The pages
// said "every automation off at once" and "nothing new starts on its own"
// regardless. Now they are told whether it is on, and say so.
test("LSP mode is no switch of the autopilot's: a pause leaves it on — and the autopilot's state, the Overview and the diagnostics say whether it is on", async (t) => {
  quiet(t);
  const { api, node } = await marketApi(t);
  installChain(node);
  installPayments(node, []);
  api.autopilot.setConfig({ enabled: true });
  assert.equal((await api.request("GET", "/autopilot")).body.lspModeOn, false);
  api.settings.set({ lspModeEnabled: true });
  const paused = await api.request("POST", "/autopilot/pause", {});
  assert.equal(paused.status, 200);
  assert.equal(paused.body.lspModeOn, true, "the pause's own answer: LSP mode is still on");
  assert.equal(api.settings.get().lspModeEnabled, true, "the pause leaves it on");
  assert.equal((await api.request("GET", "/autopilot")).body.lspModeOn, true);
  const dash = await api.request("GET", "/dashboard");
  assert.equal(dash.status, 200, JSON.stringify(dash.body));
  assert.equal(typeof dash.body.autopilot.pausedAt, "string");
  assert.equal(dash.body.autopilot.lspModeOn, true, "the Overview's digest can say it");
  assert.equal((await api.request("GET", "/diagnostics")).body.autopilot.lspModeOn, true);
  assert.equal((await api.request("POST", "/autopilot/resume", {})).body.state.lspModeOn, true);
  api.settings.set({ lspModeEnabled: false });
  assert.equal((await api.request("GET", "/autopilot")).body.lspModeOn, false);
  assert.equal((await api.request("GET", "/dashboard")).body.autopilot.lspModeOn, false);
});

test("LSP mode switched on without write access answers nobody: not said to be running", async (t) => {
  quiet(t);
  const api = await startApi(t, { readOnly: true });
  api.settings.set({ lspModeEnabled: true });
  assert.equal((await api.request("GET", "/autopilot")).body.lspModeOn, false);
});

// ── the Magma report the pages read (review a6-ux:polling-and-stale-data, a8) ──

async function marketApi(t: Parameters<typeof startApi>[0]) {
  const { installFetchMock } = await import("./helpers/fetchMock.js");
  const { FakeMagma } = await import("./helpers/magma.js");
  const { FakeMarket } = await import("./helpers/market.js");
  const { AMBOSS_API } = await import("./helpers/amboss.js");
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const market = new FakeMarket(http, t);
  const node = new FakeLnd({ chainBalance: 3_000_000 });
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  const api = await startApi(t, { node });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  return { api, magma, market, node };
}

test("the pages share one read of the Magma report for a minute — a settings change or an offer written by hand reads afresh", async (t) => {
  quiet(t);
  const { api } = await marketApi(t);
  // Count the engine's reads (each is four Amboss calls and three LND reads).
  let reads = 0;
  const real = api.autopilot.magmaReport.bind(api.autopilot);
  api.autopilot.magmaReport = (key?: string) => {
    reads += 1;
    return real(key);
  };
  const first = await api.request("GET", "/amboss/recommendations");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // Seven views asked for it — Market → Orders every 30 s. Now the next
  // views' asks are served from the first read.
  await api.request("GET", "/amboss/recommendations");
  await api.request("GET", "/amboss/sell-diagnostics");
  assert.equal(reads, 1, "one read within the minute");
  // New engine inputs (the caps): read afresh.
  api.autopilot.setConfig({ sellMaxChannelSats: 1_000_000 });
  await api.request("GET", "/amboss/recommendations");
  assert.equal(reads, 2, "a settings change reads afresh");
  api.autopilot.recordOfferWrite(null, "offer-1", { at: new Date().toISOString(), by: "manual", action: "update", fields: {}, ok: true });
  await api.request("GET", "/amboss/recommendations");
  assert.equal(reads, 3, "an offer written by hand reads afresh");
  // The autopilot's own offer upkeep never takes the shared copy.
  await api.autopilot.magmaReport();
  assert.equal(reads, 4);
});

test("the pages' shared Magma report lives a minute (MAGMA_REPORT_SHARE_MS): the next ask after it reads afresh — Market → Sell's minute refresh gets a new picture", async (t) => {
  quiet(t);
  const { api } = await marketApi(t);
  let reads = 0;
  const real = api.autopilot.magmaReport.bind(api.autopilot);
  api.autopilot.magmaReport = (key?: string) => {
    reads += 1;
    return real(key);
  };
  const realNow = Date.now;
  let skew = 0;
  t.mock.method(Date, "now", () => realNow() + skew);
  assert.equal((await api.request("GET", "/amboss/recommendations")).status, 200);
  skew = MAGMA_REPORT_SHARE_MS - 5_000;
  await api.request("GET", "/amboss/recommendations");
  assert.equal(reads, 1, "shared within the minute");
  skew = MAGMA_REPORT_SHARE_MS + 1_000;
  const later = await api.request("GET", "/amboss/recommendations");
  assert.equal(later.status, 200, JSON.stringify(later.body));
  // A copy that never expired passed every other test — and the pages then
  // showed the first read for good (review of P7, round 2).
  assert.equal(reads, 2, "read afresh once the shared copy is a minute old");
  assert.equal(MAGMA_REPORT_SHARE_MS, 60_000);
});

test("a Magma report whose reads failed says so first — never 'no offer' or '0 sat on chain' as if read; LND's balance failing fails the report", async (t) => {
  quiet(t);
  const { api, magma, node } = await marketApi(t);
  magma.readBehaviour = "throw";
  const res = await api.request("GET", "/amboss/recommendations");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.readProblems[0] ?? "", /^your offers couldn't be read from Amboss — the page can't tell whether you have one \(/);
  assert.match(res.body.sell.warnings[0], /^your offers couldn't be read from Amboss/);
  magma.readBehaviour = "ok";
  api.autopilot.forgetPageReport();
  node.override("default.walletBalance", (_a, cb) => cb({ details: "transport is closing" }));
  const failed = await api.request("GET", "/amboss/recommendations");
  // Before: chain_balance 0 — "not enough idle capital" on the Market page.
  assert.notEqual(failed.status, 200);
  assert.match(failed.body.message, /LND's on-chain balance couldn't be read .* — the capital this node could sell is unknown/);
});

// ── diagnostics (review a8: "Download diagnostics") ──────────────────────────

test("the decision log keeps when each area's decision CHANGED — a decision made again only counts up — and survives a restart", async (t) => {
  quiet(t);
  const h = new Date().getUTCHours();
  const { autopilot, seams, dir, node } = autopilotWith(t, { rebalanceEnabled: true, rebalanceHourStart: (h + 2) % 24, rebalanceHourEnd: (h + 4) % 24 });
  seams.rebalanceReport = async () => ({ recommendations: [] });
  for (let i = 0; i < 3; i++) await autopilot.runOnce();
  autopilot.setConfig({ rebalanceHourStart: 0, rebalanceHourEnd: 24 });
  await autopilot.runOnce();
  const log = autopilot.decisionLog().filter((e) => e.area === "rebalance");
  assert.deepEqual(log.map((e) => [e.state, e.text.slice(0, 27)]), [
    ["idle", "no channel needs a refill"],
    ["waiting", "outside the rebalance hours"],
  ]);
  const { autopilotAt } = await import("./helpers/autopilot.js");
  const again = autopilotAt(t, dir, node);
  assert.equal(again.autopilot.decisionLog().filter((e) => e.area === "rebalance").length, 2, "kept on disk");
});

test("GET /diagnostics: version, settings, each area's status and decision changes, the run history and the state files' sizes and ages — never the Amboss key", async (t) => {
  quiet(t);
  const api = await startApi(t);
  api.amboss.setKey("lm-secret-amboss-key-123");
  api.autopilot.setConfig({ enabled: true });
  (api.autopilot as unknown as { feeReport: () => Promise<unknown> }).feeReport = async () => ({ recommendations: [] });
  await api.autopilot.runOnce();
  const res = await api.request("GET", "/diagnostics");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(String(res.headers?.["content-disposition"] ?? ""), /^attachment; filename="lightningmate-diagnostics-.*\.json"$/);
  const d = res.body;
  assert.equal(d.app.writeEnabled, true);
  assert.equal(d.autopilot.config.enabled, true);
  assert.equal(d.autopilot.status.fees?.state, "idle");
  assert.ok(d.autopilot.decisionLog.some((e: { area: string }) => e.area === "fees"));
  assert.equal(d.autopilot.lastRun.at, d.autopilot.lastRunAt);
  assert.equal(d.magma.key.connected, true);
  const files = d.stateFiles.map((f: { file: string }) => f.file);
  assert.ok(files.includes("autopilot.json") && files.includes("decision-log.json"), JSON.stringify(files));
  assert.ok(d.stateFiles.every((f: { bytes: number; modifiedAt: string }) => f.bytes >= 0 && !Number.isNaN(Date.parse(f.modifiedAt))));
  assert.doesNotMatch(JSON.stringify(d), /lm-secret-amboss-key-123/, "the key is never in it");
});

/** Replace node:fs functions for one test — the named imports of the code
 *  under test follow them (syncBuiltinESMExports) — and put them back after. */
function patchFs(t: TestContext, impls: Partial<Record<"readdirSync" | "statSync", (...args: never[]) => unknown>>): void {
  const mod = fs as unknown as Record<string, unknown>;
  const saved = Object.fromEntries(Object.keys(impls).map((k) => [k, mod[k]]));
  Object.assign(mod, impls);
  syncBuiltinESMExports();
  t.after(() => {
    Object.assign(mod, saved);
    syncBuiltinESMExports();
  });
}

// Review of P7, round 2: every save writes "<name>.tmp-<pid>-<n>" and renames
// it over the file a moment later (store.ts) — and the autopilot saves on
// every run and every decision change. A rename between the directory
// listing and the look at the file failed the whole download with 502
// "node_request_failed", which reads as an LND failure.
test("GET /diagnostics while state is being saved: a save's temp file renamed between the listing and its look fails nothing — temp files aren't listed", async (t) => {
  quiet(t);
  const api = await startApi(t);
  const realReaddir = fs.readdirSync as (p: fs.PathLike, o?: unknown) => unknown;
  let armed = true;
  patchFs(t, {
    readdirSync: ((p: fs.PathLike, o?: unknown) => {
      if (!armed || String(p) !== api.dir) return realReaddir(p, o);
      armed = false;
      // A save in progress: its temp file is there while the directory is
      // listed, and renamed over its file right after.
      const tmp = join(api.dir, "autopilot.json.tmp-1-1");
      writeFileSync(tmp, "{}");
      const listed = realReaddir(p, o);
      rmSync(tmp);
      return listed;
    }) as never,
  });
  const res = await api.request("GET", "/diagnostics");
  assert.equal(armed, false, "the save landed in the listing");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const files: string[] = res.body.stateFiles.map((f: { file: string }) => f.file);
  assert.ok(files.includes("autopilot.json"), JSON.stringify(files));
  assert.ok(!files.some((f) => f.includes(".tmp-")), "a temp file is no state of its own");
});

test("the diagnostics' state files: one gone between the listing and its look is skipped, one that can't be looked at is listed with the reason", (t) => {
  const dir = makeTempDir(t);
  for (const f of ["autopilot.json", "gone.json", "locked.json", "decision-log.json.tmp-9-2"]) writeFileSync(join(dir, f), "{}");
  const realReaddir = fs.readdirSync as (p: fs.PathLike, o?: unknown) => unknown;
  const realStat = fs.statSync as (p: fs.PathLike, o?: unknown) => unknown;
  patchFs(t, {
    readdirSync: ((p: fs.PathLike, o?: unknown) => {
      const listed = realReaddir(p, o);
      if (String(p) === dir) rmSync(join(dir, "gone.json")); // removed right after the listing
      return listed;
    }) as never,
    statSync: ((p: fs.PathLike, o?: unknown) => {
      if (String(p).endsWith("locked.json")) throw Object.assign(new Error("EACCES: permission denied, stat 'locked.json'"), { code: "EACCES" });
      return realStat(p, o);
    }) as never,
  });
  const list = stateFileList(dir);
  assert.deepEqual(list.map((f) => f.file), ["autopilot.json", "locked.json"]);
  assert.equal(list[0].bytes, 2);
  assert.ok(!Number.isNaN(Date.parse(list[0].modifiedAt ?? "")));
  assert.deepEqual(list[1], { file: "locked.json", error: "EACCES: permission denied, stat 'locked.json'" });
});

test("every log line carries its time — and a line that already has one is not stamped twice", () => {
  const lines: unknown[][] = [];
  const fake = { log: (...a: unknown[]) => void lines.push(a), warn: (...a: unknown[]) => void lines.push(a), error: (...a: unknown[]) => void lines.push(a) };
  timestampConsole(fake);
  fake.log("[magma] rejected order x");
  fake.warn("2026-10-22T03:00:00.000Z [autopilot] fees: idle — nothing");
  fake.error(new Error("boom"));
  assert.match(String(lines[0][0]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[magma\] rejected order x$/);
  assert.equal(lines[1][0], "2026-10-22T03:00:00.000Z [autopilot] fees: idle — nothing");
  assert.match(String(lines[2][0]), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(lines[2][1] instanceof Error);
});

// ── review of P7, round 1: what the package relied on without a test ─────────

test("a key Amboss rejects is 'blocked' for Liquidity provision — whatever the lane last decided", async (t) => {
  quiet(t);
  const { autopilot, amboss } = sellerSetup(t);
  assert.notEqual(autopilot.getState().status.magma.state, "blocked");
  amboss.markInvalid();
  const m = autopilot.getState().status.magma;
  assert.equal(m.state, "blocked");
  assert.match(m.text, /^Amboss rejects your API key \(expired or revoked\) — connect a fresh one in Settings/);
});

test("'Resume' with write mode off switches nothing on — the pause just ends", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config: {}, paused: { at: new Date().toISOString(), was: ["enabled", "channelEnabled"] }, history: [], sellAutoSizeMigrated: true }),
  );
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  // No write macaroon: nothing can run.
  const ap = new Autopilot(dir, node.lnd, undefined, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(ap);
  t.after(() => ap.shutdown());
  assert.deepEqual(ap.getState().paused?.was, ["enabled", "channelEnabled"]);
  assert.deepEqual(ap.resumeAll(), { resumed: [], sellingWasOn: false });
  const c = ap.getState().config;
  assert.deepEqual([c.enabled, c.channelEnabled], [false, false]);
  assert.equal(ap.getState().paused, null);
});

test("a stage that fails, works again, then fails the same way is news again: a second line of history", async (t) => {
  quiet(t);
  t.mock.method(console, "error", () => undefined);
  const { autopilot, node } = autopilotWith(t, { maxHtlcEnabled: true });
  let failing = true;
  node.override("default.listChannels", (_a, cb) => (failing ? cb({ details: "transport is closing" }) : cb(null, { channels: [] })));
  await autopilot.runOnce();
  await autopilot.runOnce(); // the same failure: no news
  assert.equal(autopilot.getState().history.length, 1);
  failing = false;
  await autopilot.runOnce(); // it works: the next failure is news
  failing = true;
  const again = await autopilot.runOnce();
  assert.equal(autopilot.getState().history.length, 2, "the failure after a recovery is a new line");
  assert.deepEqual(autopilot.getState().history[0].errors?.map((e) => e.stage), ["max_htlc"]);
  assert.deepEqual(again.errors?.map((e) => e.stage), ["max_htlc"]);
});

test("a refilled channel's label with no channel list (LND didn't answer): its status is unknown — never 'closed'", () => {
  const perChannel = [{ channelId: "800001x1x0", feeSats: 5, count: 1 }];
  const fromLog = (id: string) => (id === "800001x1x0" ? "ACINQ" : undefined);
  assert.deepEqual(labelCostChannels(perChannel, null, fromLog), [{ channelId: "800001x1x0", feeSats: 5, count: 1, alias: "ACINQ" }]);
  // With the list, one not in it was closed since.
  assert.deepEqual(labelCostChannels(perChannel, [], fromLog), [{ channelId: "800001x1x0", feeSats: 5, count: 1, alias: "ACINQ", status: "closed" }]);
});

test("a shared Magma report whose read failed is not kept: the next ask reads afresh", async (t) => {
  quiet(t);
  const { autopilot } = autopilotWith(t, {});
  let reads = 0;
  autopilot.magmaReport = async () => {
    reads += 1;
    if (reads === 1) throw new Error("LND's on-chain balance couldn't be read");
    return { sell: { state: "good_to_sell" } } as unknown as Awaited<ReturnType<typeof autopilot.magmaReport>>;
  };
  await assert.rejects(autopilot.magmaReportShared("key"), /on-chain balance/);
  const next = await autopilot.magmaReportShared("key");
  assert.equal(reads, 2, "read afresh — not the failure again for a minute");
  assert.equal(next.sell.state, "good_to_sell");
  await autopilot.magmaReportShared("key");
  assert.equal(reads, 2, "a good read is shared");
});

test("fee updates LND refuses again — left out of the run history as repeats — still count as refusals in the fee decision, with LND's words", () => {
  const recs = [plannedFeeChange("a", 300, 280), plannedFeeChange("b", 300, 280)];
  // Two updates were sent; LND refused both, the first the same way as
  // before (a repeat: in the pass's result, flagged).
  const r = feeDecision(recs, [
    { alias: "a", fromPpm: 300, toPpm: 280, ok: false, error: "LND refused the update: invalid policy — not retried for 6 h", repeat: true },
    { alias: "b", fromPpm: 300, toPpm: 280, ok: false, error: "LND refused the update: invalid policy — not retried for 6 h" },
  ]);
  assert.deepEqual(r, { text: "2 updates LND refused (LND refused the update: invalid policy — not retried for 6 h)", state: "error" });
});

test("Magma with no offer and too little capital to list one is waiting — amber, not a red failure (D15)", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 500_000, config: { sellAutoReprice: true } });
  await s.autopilot.runOnce();
  const m = s.autopilot.getState().status.magma;
  assert.equal(m.state, "waiting");
  assert.match(m.text, /^no offer listed: only \d+k deployable on-chain after reserve/);
});

test("a rebalance run whose refills all wait — for the daily budget, or for the next run — is waiting, never an error (D15)", async (t) => {
  quiet(t);
  const budget = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 5 });
  budget.seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500)] }); // ~10 sat
  budget.seams.rebalanceExec = async () => assert.fail("nothing is paid over the budget");
  await budget.autopilot.runOnce();
  const b = budget.autopilot.getState().status.rebalance;
  assert.equal(b.state, "waiting");
  assert.match(b.text, /^1 profitable refill waits for the daily budget/);
  const later = autopilotWith(t, { rebalanceEnabled: true, maxRebalancesPerRun: 0 });
  later.seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500)] });
  later.seams.rebalanceExec = async () => assert.fail("none this run");
  await later.autopilot.runOnce();
  const l = later.autopilot.getState().status.rebalance;
  assert.equal(l.state, "waiting");
  assert.match(l.text, /^1 more waits for the next run/);
});

test("'Last change by the autopilot' is the autopilot's: a fee set by hand since is not — before, the Overview said the autopilot changed it 2m ago", async (t) => {
  quiet(t);
  const PEER = "02" + "71".repeat(32);
  const node = feeNode({
    channels: [{ id: "850000x1x0", partnerPublicKey: PEER, capacity: 2_000_000, localBalance: 1_000_000, transactionId: "71".repeat(32), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0 }],
  });
  const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const autopilotRun = {
    at: threeDaysAgo, attempted: 1, applied: 1, failed: 0,
    changes: [{ id: "850000x1x0", alias: "x", fromPpm: 280, toPpm: 300, ok: true }], rebalances: [], channels: [], sells: [],
  };
  const { autopilot } = autopilotWith(t, {}, { history: [autopilotRun] }, {}, node);
  const res = await autopilot.applyByHand([{ id: "850000x1x0", transactionId: "71".repeat(32), transactionVout: 0, feeRatePpm: 400, baseFeeMsat: 0 }]);
  assert.equal(res?.changes[0]?.ok, true);
  assert.equal(autopilot.getState().history[0]?.changes[0]?.via, "manual", "the hand-set fee is the newest line");
  assert.equal(autopilot.getState().lastActionAt, threeDaysAgo);
  // A failed attempt changed nothing; a lease promise kept is the autopilot's.
  const at = new Date().toISOString();
  assert.equal(lastAutopilotActionAt([{ at, changes: [{ id: "a", alias: "a", fromPpm: 1, toPpm: 2, ok: false }], rebalances: [], channels: [], sells: [] }]), null);
  assert.equal(lastAutopilotActionAt([{ at, changes: [{ id: "a", alias: "a", fromPpm: 9, toPpm: 2, ok: true, via: "lease" }], rebalances: [], channels: [], sells: [] }]), at);
  assert.equal(lastAutopilotActionAt([{ at, changes: [], rebalances: [], channels: [], sells: [{ orderId: "o", action: "accept", sizeSats: 1, ok: true }] }]), at);
});

test("each action is a decision of its own — two fee runs that act are two entries of the decision log, never 'acted ×2'", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm }));
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800001x1x0", 300, 280)] });
  await autopilot.runOnce();
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800001x1x0", 280, 260)] });
  await autopilot.runOnce();
  const fees = autopilot.decisionLog().filter((e) => e.area === "fees");
  // Before: one entry — "…300→280 ppm" and "…280→260 ppm" differ only in
  // numbers, and the second was taken for the first made again.
  assert.deepEqual(fees.map((e) => [e.state, e.text]), [
    ["acted", "1 fee update applied: peer-800001x1x0 280→260 ppm"],
    ["acted", "1 fee update applied: peer-800001x1x0 300→280 ppm"],
  ]);
  assert.equal(autopilot.getState().status.fees.repeats, 1);
  // A standing state still counts up.
  seams.feeReport = async () => ({ recommendations: [atTarget("800001x1x0")] });
  await autopilot.runOnce();
  await autopilot.runOnce();
  assert.equal(autopilot.getState().status.fees.repeats, 2);
  assert.equal(autopilot.decisionLog().filter((e) => e.area === "fees").length, 3);
});

test("a saved pause names only known switches, each once — Resume can't be made to set a key of its own; a malformed one is dropped", async (t) => {
  quiet(t);
  const at = new Date().toISOString();
  const { autopilot } = autopilotWith(t, {}, { paused: { at, was: ["enabled", "__proto__", "intervalMinutes", "enabled", "sellEnabled"] } });
  assert.deepEqual(autopilot.getState().paused, { at, was: ["enabled", "sellEnabled"] });
  assert.deepEqual(autopilot.resumeAll(), { resumed: ["enabled"], sellingWasOn: true });
  assert.equal(autopilot.getState().config.intervalMinutes, 30, "never set to true");
  assert.deepEqual(sanitizePaused({ at: "not a time", was: ["enabled"] }), null);
  assert.deepEqual(sanitizePaused({ at, was: "enabled" }), { at, was: [] });
  assert.deepEqual(sanitizePaused(null), null);
});

test("diagnostics name the commit the image was built from — the Dockerfile and the image build pass it in", async (t) => {
  quiet(t);
  withEnv(t, { APP_REVISION: "0123abc" });
  const api = await startApi(t);
  assert.equal((await api.request("GET", "/diagnostics")).body.app.revision, "0123abc");
  process.env.APP_REVISION = ""; // a local build: the ARG's empty default
  assert.equal((await api.request("GET", "/diagnostics")).body.app.revision, null);
  // Before: nothing set it — always null.
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^ARG APP_REVISION=$/m);
  assert.match(dockerfile, /APP_REVISION=\$APP_REVISION/);
  const workflow = readFileSync(new URL("../../.github/workflows/build-image.yml", import.meta.url), "utf8");
  assert.match(workflow, /build-args: \|\n\s+APP_VERSION=.*\n\s+APP_REVISION=\$\{\{ github\.sha \}\}/);
});

// ── review of P7 (final): an item that fails the same way again ─────────────
//
// The repair counted every stage error in the pass's own result, but an
// ITEM that failed the same way as in the last run — a fee write LND refused
// again (quietRepeats), this node's own open failing again (channelNews), an
// offer write failing again (laneNews) — was dropped before the pass's
// result was built. The Overview then read "Autopilot 0s ago: nothing needed
// changing" right above "Fee automation failed: …", the tile "0 applied",
// "Run once now" "nothing needed doing" — and the fee status lost LND's
// reason ("the same refusal as before"). The words for these numbers are
// pinned in web/test/autopilotView.test.tsx (PROBE-DIGEST-QUIET-REPEAT).

/** The Overview's autopilot block for this autopilot's state, as the
 *  dashboard builds it (no forwards, no payments). */
function overviewOf(autopilot: Autopilot) {
  const report = { windowDays: 30, totalFeesEarnedSats: 0, totalForwards: 0, totalRoutedSats: 0, daily: [], recent: [], perChannel: [] } as unknown as Parameters<typeof buildDashboard>[0];
  return buildDashboard(report, { invoices: [], payments: [] }, [], { count: 0, totalAmountSats: 0 }, autopilot.getState(), 0).autopilot;
}

test("PROBE-DIGEST-QUIET-REPEAT: a fee update LND refuses again the same way is a failure of that run too — in the run, lastRun and the Overview's numbers, with LND's reason on the fee status; the history keeps one line", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800001x1x0", 300, 280)] });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: false, feeRatePpm: i.feeRatePpm, error: "LND refused the update: invalid policy" }));
  const run1 = await autopilot.runOnce();
  const run2 = await autopilot.runOnce(); // (the back-off is the engine's guard; this stub plans the write regardless)
  // Before: the second run was 0 attempted, 0 failed.
  assert.deepEqual([run1.attempted, run1.failed], [1, 1]);
  assert.deepEqual([run2.attempted, run2.applied, run2.failed], [1, 0, 1]);
  assert.equal(run2.changes[0]?.repeat, true, "flagged as the same failure again");
  assert.equal(run1.changes[0]?.repeat, undefined, "the first one is news");
  const st = autopilot.getState();
  assert.deepEqual([st.lastRun?.attempted, st.lastRun?.applied, st.lastRun?.failed], [1, 0, 1]);
  assert.deepEqual(st.lastRun?.feeChanges, { ok: 0, failed: 1 });
  const o = overviewOf(autopilot).lastRun;
  assert.deepEqual([o?.applied, o?.attempted, o?.failed, o?.feeChanges, o?.errors], [0, 1, 1, 0, []]);
  // LND's own reason — not "the same refusal as before".
  assert.equal(st.status.fees.text, "1 update LND refused (LND refused the update: invalid policy — not retried for 6 h)");
  assert.equal(st.status.fees.state, "error");
  // The run history: one line for the two identical failures (not news).
  assert.equal(st.history.flatMap((r) => r.changes).length, 1);
});

// Only the autopilot's own passes keep a repeated failure out of the history
// (quietRepeats). A click is the operator's: each "Apply" LND refuses is on
// the record, the same refusal as the click before included — flagged as a
// repeat, recordRun would drop it without a word.
test("an Apply by hand that LND refuses the same way as the click before is on the record both times — never flagged as a repeat", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: false });
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800001x1x0", 300, 280)] });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: false, feeRatePpm: i.feeRatePpm, error: "LND refused the update: invalid policy" }));
  const first = await autopilot.applyRecommended();
  const second = await autopilot.applyRecommended();
  assert.deepEqual([first?.length, second?.length], [1, 1]);
  assert.deepEqual([first?.[0]?.ok, first?.[0]?.repeat, second?.[0]?.ok, second?.[0]?.repeat], [false, undefined, false, undefined]);
  const lines = autopilot.getState().history.flatMap((r) => r.changes);
  assert.deepEqual(lines.map((c) => [c.id, c.via, c.ok]), [["800001x1x0", "manual", false], ["800001x1x0", "manual", false]], "both clicks are on the record");
});

test("PROBE-DIGEST-QUIET-REPEAT-OPEN: the wallet can't fund an open, run after run — every run says it failed; the history keeps one line", async (t) => {
  quiet(t);
  const env = autopilotWith(t, { channelEnabled: true, channelCooldownMinutes: 360 });
  env.seams.openFeeRate = async () => 2;
  env.node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  env.seams.channelSuggestions = async () => ({ suggestions: [{ ...suggestion, pubkey: "02" + "11".repeat(32), alias: "peer" }] });
  env.node.beforeCall = (method) => {
    if (method === "default.openChannel") env.node.openFailure = "insufficient funds available to construct transaction";
  };
  const run1 = await env.autopilot.runOnce();
  const run2 = await env.autopilot.runOnce();
  // Before: the second run reported nothing at all.
  assert.deepEqual([run1.failed, run2.failed], [1, 1]);
  assert.deepEqual(run2.channels.map((c) => [c.alias, c.ok, c.repeat]), [["peer", false, true]]);
  assert.match(run2.channels[0]?.error ?? "", /not the peer's doing/);
  const st = env.autopilot.getState();
  assert.deepEqual(st.lastRun?.opens, { ok: 0, failed: 1 });
  assert.deepEqual([overviewOf(env.autopilot).lastRun?.applied, overviewOf(env.autopilot).lastRun?.failed], [0, 1]);
  assert.equal(st.history.flatMap((r) => r.channels).length, 1, "one line of history for the two");
});

test("offer upkeep failing the same way again (Amboss down) is a failure of every run that hit it — one line of history all the same", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t);
  magma.addOffer({});
  magma.readBehaviour = "throw";
  const failed: number[] = [];
  for (let i = 0; i < 3; i++) failed.push((await autopilot.runOnce()).failed);
  assert.deepEqual(failed, [1, 1, 1], "before: 1, 0, 0 — the Overview read 'nothing needed changing'");
  assert.deepEqual(autopilot.getState().lastRun?.sells, { ok: 0, failed: 1 });
  assert.equal(autopilot.getState().history.flatMap((r) => r.sells).length, 1);
});

test("the Overview's autopilot block says whether Advertise routable size is on — the digest counts it as an automation (review of P7: it was left out)", (t) => {
  quiet(t);
  const on = autopilotWith(t, { enabled: false, maxHtlcEnabled: true });
  assert.equal(overviewOf(on.autopilot).maxHtlc, true);
  const off = autopilotWith(t, { enabled: false, maxHtlcEnabled: false });
  assert.equal(overviewOf(off.autopilot).maxHtlc, false);
});

test("the Magma report says when its reads came in — a copy the pages share later still says that, not when it was handed out (review of P7: Market → Sell's 'as of')", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const before = Date.now();
  const report = await s.autopilot.magmaReportShared();
  const readAt = Date.parse(report.generatedAt);
  assert.ok(readAt >= before && readAt <= Date.now(), report.generatedAt);
  await new Promise((r) => setTimeout(r, 20));
  const shared = await s.autopilot.magmaReportShared();
  assert.equal(shared.generatedAt, report.generatedAt, "the shared copy: as of its read");
});
