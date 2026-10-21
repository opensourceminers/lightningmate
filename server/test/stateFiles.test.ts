/**
 * The review reproduced it: a power cut mid-write left autopilot.json torn, and
 * the next start silently came up with everything switched off — overwriting
 * the evidence — while a torn lsps1-orders.json lost a held order's preimage.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Autopilot } from "../src/services/autopilot.js";
import { RebalanceLog, type RebalanceRecord } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { SettingsStore } from "../src/services/settings.js";
import { Lsps1Service, type Lsps1Order } from "../src/services/lsps1.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { stateAlerts } from "../src/services/alerts.js";
import type { FeeApplyItem } from "../src/services/fees.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { startApi } from "./helpers/apiHarness.js";
import {
  autopilotWith,
  failedRebalance,
  paidRebalance,
  plannedFeeChange,
  plannedRebalance,
  suggestion,
  type AutopilotSeams,
} from "./helpers/autopilot.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";

function autopilotOn(t: AfterHook, dir: string, node = new FakeLnd()): Autopilot {
  const ap = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    new AmbossStore(dir),
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  t.after(() => ap.shutdown());
  return ap;
}

/** What a power cut during the old truncate-then-write left on disk. */
function tear(path: string): string {
  const full = readFileSync(path, "utf8");
  const torn = full.slice(0, Math.floor(full.length * 0.4));
  writeFileSync(path, torn);
  return torn;
}

test("a torn autopilot.json comes back from its previous version, not as 'everything off'", (t) => {
  const dir = makeTempDir(t);
  const first = autopilotOn(t, dir);
  first.setConfig({ enabled: true, rebalanceEnabled: true, sellEnabled: true, sellMaxDeploySats: 9_000_000 });
  first.setConfig({ intervalMinutes: 45 }); // the save that gets torn
  first.shutdown();
  tear(join(dir, "autopilot.json"));

  const c = autopilotOn(t, dir).getState().config;
  assert.equal(c.enabled, true);
  assert.equal(c.rebalanceEnabled, true);
  assert.equal(c.sellEnabled, true);
  assert.equal(c.sellMaxDeploySats, 9_000_000);
  assert.equal(c.intervalMinutes, 30, "only the very last (torn) change is lost");
});

test("a torn file with no usable backup is reported until acknowledged, and kept for inspection", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "autopilot.json"), '{"config": {"enabled": true, "rebalanceEna');
  const api = await startApi(t, { dir });
  assert.equal(api.autopilot.getState().config.enabled, false, "defaults — but not silently:");

  const alerts = (await api.request("GET", "/alerts")).body as { id?: string; message: string }[];
  const alert = alerts.find((a) => a.message.includes("autopilot.json"));
  assert.ok(alert?.id, JSON.stringify(alerts));
  assert.match(alert.message, /automation is OFF/);
  const kept = alert.message.match(/saved as (\S+)\./)?.[1];
  assert.ok(kept && existsSync(join(dir, kept)), "the damaged copy is kept");

  assert.equal((await api.request("POST", "/alerts/ack", { id: alert.id })).status, 200);
  const after = (await api.request("GET", "/alerts")).body as { message: string }[];
  assert.equal(after.filter((a) => a.message.includes("autopilot.json")).length, 0);
});

/** An LSP service that saved one HELD order (its preimage included) twice,
 *  then had `damage` happen to lsps1-orders.json; returns a fresh service
 *  started over the same data dir, as after a restart. */
function heldOrderAfter(t: AfterHook, damage: (file: string) => void) {
  const dir = makeTempDir(t);
  const node = new FakeLnd();
  const make = () =>
    new Lsps1Service(
      dir,
      node.lnd,
      node.lnd,
      new SettingsStore(dir),
      () => ({ maxChannelSats: 5_000_000, reserveSats: 50_000, maxDeploySats: 20_000_000 }),
      () => ({ sellPricingMode: "balanced", adaptiveLevel: 0.5 }),
      () => "",
      new EarningsLog(dir),
      new ServiceFeeLedger(dir, null),
    );
  const svc = make();
  const seams = svc as unknown as { orders: Lsps1Order[]; persistOrders: () => void };
  const order = {
    orderId: "o-held",
    peer: "02" + "ab".repeat(32),
    createdAt: new Date().toISOString(),
    lspBalanceSat: 3_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4320,
    token: "",
    announceChannel: true,
    orderState: "CREATED",
    paymentState: "HOLD",
    feeTotalSat: 9_000,
    orderTotalSat: 9_000,
    invoice: "lnbc-placeholder",
    invoiceId: "aa".repeat(32),
    invoiceSecret: "bb".repeat(32),
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
  } satisfies Lsps1Order;
  seams.orders.unshift(order);
  seams.persistOrders();
  seams.orders[0].error = "a later save";
  seams.persistOrders(); // the save that gets damaged
  damage(join(dir, "lsps1-orders.json"));
  return { dir, recovered: make() };
}

test("a torn lsps1-orders.json keeps the held order and its preimage", (t) => {
  const { recovered } = heldOrderAfter(t, (file) => void tear(file));
  assert.equal(recovered.committedSat(), 3_000_000, "the capital it holds is still accounted for");
  const kept = (recovered as unknown as { orders: Lsps1Order[] }).orders[0];
  assert.equal(kept.invoiceSecret, "bb".repeat(32), "and the preimage needed to settle it");
});

// ── the autopilot's bookkeeping reaches the disk right after each action ─────
// Fee cooldowns, rebalance spend and backoff, and the channel-open cooldown
// used to be saved only at the end of a run. A later stage that threw — or a
// restart in between — forgot them, and the next run acted again: another
// open, more rebalance spend than the daily budget, fee gossip spam.

interface SavedState {
  lastChannelOpenAt: string | null;
  perChannelLastApplied: Record<string, string>;
  perTargetLastRebalanced: Record<string, string>;
  perTargetRebalanceFails?: Record<string, number>;
  perPairRebalanceFails?: Record<string, { fails: number; at: string }>;
  perChannelFlowAnchor?: Record<string, { episodeAt?: string; anchorPpm?: number }>;
}

const savedState = (dir: string): SavedState => JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as SavedState;

/** The stage after the fee, rebalance and channel stages (Magma) looks at the
 *  disk — what a restart at that moment would find — and then fails. */
function laterStageFails(t: TestContext, seams: AutopilotSeams, dir: string) {
  t.mock.method(console, "error", () => undefined); // "[autopilot] run failed: …"
  let seen: SavedState | undefined;
  seams.runSell = async () => {
    seen = savedState(dir);
    throw new Error("Amboss answered garbage");
  };
  return () => {
    assert.ok(seen, "the later stage ran");
    return seen;
  };
}

test("a channel open's cooldown is on disk before the run goes on", async (t) => {
  const { autopilot, node, seams, dir } = autopilotWith(t, { channelEnabled: true });
  node.peers.push(suggestion.pubkey); // connected: the open goes straight through
  seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  seams.openFeeRate = async () => 2; // LND's economy estimate (the fake has none)
  const onDiskMidRun = laterStageFails(t, seams, dir);

  await autopilot.runOnce();
  assert.equal(node.callsTo("default.openChannel").length, 1);
  // The cooldown is all that keeps the next run from opening again.
  assert.ok(onDiskMidRun().lastChannelOpenAt, "saved right after the open");
});

test("each rebalance payment's spend, cooldown and backoff are on disk before the run goes on", async (t) => {
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true });
  seams.rebalanceReport = async () => ({
    recommendations: [plannedRebalance("800001x1x0", 500), plannedRebalance("800002x1x0", 400)],
  });
  seams.rebalanceExec = async (_writeLnd, p) => (p.targetId === "800001x1x0" ? paidRebalance(p, 7) : failedRebalance(p));
  const onDiskMidRun = laterStageFails(t, seams, dir);
  // Today's spend is read from the rebalance log (rebalanceBudget): what a
  // restart at that moment would find there.
  let logMidRun: RebalanceRecord[] = [];
  const later = seams.runSell;
  seams.runSell = async () => {
    logMidRun = JSON.parse(readFileSync(join(dir, "rebalances.json"), "utf8")) as RebalanceRecord[];
    return later();
  };

  await autopilot.runOnce();
  const saved = onDiskMidRun();
  assert.deepEqual(
    logMidRun.filter((r) => r.ok).map((r) => [r.targetId, r.feeSats]),
    [["800001x1x0", 7]],
    "today's spend counts against the daily budget after a restart",
  );
  assert.ok(saved.perTargetLastRebalanced["800001x1x0"] && saved.perTargetLastRebalanced["800002x1x0"]);
  assert.equal(saved.perPairRebalanceFails?.["800000x1x0>800002x1x0"]?.fails, 1, "and the failing source → target pair backs off");
});

test("a fee batch's cooldowns are on disk before the run goes on", async (t) => {
  const { autopilot, seams, dir } = autopilotWith(t, { enabled: true });
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800001x1x0", 500, 420)] });
  const applied: FeeApplyItem[] = [];
  seams.feeApply = async (_writeLnd, items) => {
    applied.push(...items);
    return items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm }));
  };
  const onDiskMidRun = laterStageFails(t, seams, dir);

  await autopilot.runOnce();
  assert.deepEqual(
    applied.map((i) => [i.id, i.feeRatePpm]),
    [["800001x1x0", 420]],
  );
  assert.ok(onDiskMidRun().perChannelLastApplied["800001x1x0"], "the channel's fee cooldown is saved");
});

test("a run that fails still saves what its earlier stages learned", async (t) => {
  // An open no-flow episode: the fee was lowered, and routing came back since.
  const { autopilot, seams, dir } = autopilotWith(
    t,
    { enabled: true },
    { perChannelFlowAnchor: { "800001x1x0": { episodeAt: new Date(Date.now() - 86_400_000).toISOString() } } },
  );
  seams.feeReport = async () => ({
    recommendations: [plannedFeeChange("800001x1x0", 321, 321, { wouldApply: false, routedOut14d: 50_000 })],
  });
  laterStageFails(t, seams, dir);

  const run = await autopilot.runOnce();
  // A stage that throws no longer aborts the run (each stage is isolated, so
  // a failing stage can't starve the others): it is recorded as the run's error.
  assert.deepEqual(run.errors?.map((e) => e.stage), ["magma"], "the failing stage is on record");
  assert.equal(run.applied, 0);
  // No fee changed, so the fee stage saved nothing itself — the price at which
  // routing returned is only on disk because the run saves on its way out.
  const anchor = savedState(dir).perChannelFlowAnchor?.["800001x1x0"];
  assert.equal(anchor?.anchorPpm, 321);
  assert.equal(anchor?.episodeAt, undefined, "the episode is closed");
});

test("lsps1-orders.json missing after a recovery cut short: the held order and its preimage come back", (t) => {
  t.mock.method(console, "error", () => undefined);
  // The damaged file was moved aside, then the restore from .bak never landed
  // (a crash in between, or a full disk) — the next start finds no main file.
  const { dir, recovered } = heldOrderAfter(t, (file) => renameSync(file, `${file}.corrupt-2026-10-20T00-00-00-000Z`));
  // Before: no main file read as a first start — zero orders, zero committed
  // capital, the preimage gone: a paid channel that could never be settled.
  assert.equal(recovered.committedSat(), 3_000_000);
  const kept = (recovered as unknown as { orders: Lsps1Order[] }).orders[0];
  assert.equal(kept?.invoiceSecret, "bb".repeat(32));
  assert.ok(
    stateAlerts(dir).some((a) => a.message.startsWith("lsps1-orders.json was missing and has been restored")),
    "and the operator is told",
  );
});
