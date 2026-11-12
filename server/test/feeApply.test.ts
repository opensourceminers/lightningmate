/**
 * What the app records as applied is what LND has (review a1/a6/a8, package
 * P2):
 *  - LND answers a policy update with per-channel `failures`, not an error:
 *    a refused update is now failed — no cooldown, no outcome, no "✓";
 *  - a max_htlc above the channel's max pending amount (which makes LND
 *    refuse the whole update) is no longer echoed back on fee writes, and
 *    the max_htlc pass never asks for one and backs off after a refusal;
 *  - every fee write — the autopilot's, a lease promise kept, a manual
 *    apply — goes through one set of books: cooldown, run history (with the
 *    reason), and the fee-change log;
 *  - manual "Apply" applies what the engine recommends, base fee included.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyFees } from "../src/services/fees.js";
import { MAX_HTLC_BACKOFF_MS, decideMaxHtlc, maxHtlcBucketSat, runMaxHtlcPass } from "../src/services/maxHtlc.js";
import { Autopilot, FEE_RETRY_BACKOFF_MS } from "../src/services/autopilot.js";
import { MARKET_RUN_WAIT_MS, getFeeRecommendations } from "../src/services/feeRecommend.js";
import { GRAPH_TTL_MS } from "../src/services/suggestions.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { FeeChangeLog } from "../src/services/feeChangeLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { storeIncidents } from "../src/store.js";
import { feeNode, forwardsOut, withMarket, type FakeForward, type FeeChannel } from "./helpers/feeNode.js";
import { suppressSchedulerKicks } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const HEIGHT = 860_000;
const MAX_PENDING_REFUSAL = "max htlc size of 1980000000 mSAT is above max pending amount of 990000000 mSAT";

const channel = (n: number, o: Partial<FeeChannel> = {}): FeeChannel => ({
  id: `850000x${n}x0`,
  partnerPublicKey: PEER(n),
  capacity: 2_000_000,
  localBalance: 1_000_000,
  transactionId: TX(n),
  transactionVout: 0,
  feeRatePpm: 300,
  baseFeeMsat: 0,
  ...o,
});

/** An autopilot on a fee node (its own data dir), Amboss answered offline. */
function autopilotOn(t: AfterHook, node: ReturnType<typeof feeNode>, config: Record<string, unknown> = {}) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "autopilot.json"), JSON.stringify({ config, history: [], sellAutoSizeMigrated: true }));
  const autopilot = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(autopilot);
  t.after(() => autopilot.shutdown());
  const saved = () => JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as { perChannelLastApplied: Record<string, string> };
  return { autopilot, dir, saved };
}

test("an update LND refuses (failed_updates) is a failure with LND's reason — it was recorded as applied", async () => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1), channel(2)] });
  node.refusals.set(`${TX(1)}:0`, MAX_PENDING_REFUSAL);
  const results = await applyFees(node.lnd, node.lnd, [
    { id: "850000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 250, baseFeeMsat: 0 },
    { id: "850000x2x0", transactionId: TX(2), transactionVout: 0, feeRatePpm: 250, baseFeeMsat: 0 },
  ]);
  assert.equal(results[0].ok, false);
  assert.match(results[0].error ?? "", /LND refused the update: max htlc size .* above max pending amount .* \(invalid policy\)/);
  assert.equal(results[1].ok, true);
  assert.equal(node.feeOf("850000x1x0")?.ppm, 300, "nothing changed in LND");
});

test("a fee write does not echo a max_htlc above the channel's max pending amount — LND would refuse the whole update", async () => {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [
      // max_htlc 1,980,000 sat (legacy, capacity-sized) > max pending 990,000.
      channel(1),
      // max_htlc 495,000 sat ≤ max pending 990,000: kept as it is.
      channel(2, { capacity: 500_000, localBalance: 250_000 }),
    ],
  });
  const results = await applyFees(node.lnd, node.lnd, [
    { id: "850000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 250, baseFeeMsat: 0 },
    { id: "850000x2x0", transactionId: TX(2), transactionVout: 0, feeRatePpm: 250, baseFeeMsat: 0 },
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true]);
  const [first, second] = node.policyRequests;
  assert.equal(first.max_htlc_msat, undefined, "left out: LND keeps or corrects it");
  assert.equal(second.max_htlc_msat, String(500_000 * 990));
});

test("the max_htlc pass never asks for more than the channel's max pending amount, records LND's refusal as a failure, and backs off", async () => {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [
      // 1.5M spendable, but LND lets a single HTLC be at most 500,000 sat.
      channel(1, { localBalance: 1_500_000, maxPendingMsat: 500_000_000 }),
      channel(2, { localBalance: 1_500_000 }),
    ],
  });
  node.refusals.set(`${TX(2)}:0`, MAX_PENDING_REFUSAL);
  const backoff = new Map<string, number>();
  const changes = await runMaxHtlcPass(node.lnd, node.lnd, backoff);
  const one = changes.find((c) => c.id === "850000x1x0")!;
  assert.equal(one.toSat, 262_144, "2^18: the largest bucket under 500,000 — not 2^20 from the spendable balance");
  assert.equal(one.ok, true);
  const two = changes.find((c) => c.id === "850000x2x0")!;
  assert.equal(two.ok, false, "before: recorded as applied, and retried every run");
  assert.match(two.error ?? "", /LND refused the update: max htlc size/);
  assert.ok(backoff.has("850000x2x0"));
  // The next run leaves the refused channel alone …
  const asked = node.policyRequests.length;
  const again = await runMaxHtlcPass(node.lnd, node.lnd, backoff);
  assert.equal(again.find((c) => c.id === "850000x2x0"), undefined);
  assert.equal(node.policyRequests.filter((r) => (r.chan_point as { funding_txid_str: string }).funding_txid_str === TX(2)).length, 1);
  assert.ok(node.policyRequests.length >= asked);
  // … until the back-off is over.
  backoff.set("850000x2x0", Date.now() - MAX_HTLC_BACKOFF_MS - 1);
  const later = await runMaxHtlcPass(node.lnd, node.lnd, backoff);
  assert.ok(later.find((c) => c.id === "850000x2x0"), "tried again after the back-off");
});

test("the fee autopilot books only what LND took: a refused update stamps no cooldown and logs no change — and says why in the run history", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 }), channel(2, { localBalance: 800_000 })] });
  node.refusals.set(`${TX(1)}:0`, MAX_PENDING_REFUSAL);
  const { autopilot, saved } = autopilotOn(t, node, { enabled: true });
  const run = await autopilot.runOnce();
  const refused = run.changes.find((c) => c.id === "850000x1x0")!;
  const taken = run.changes.find((c) => c.id === "850000x2x0")!;
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /LND refused the update/);
  assert.equal(taken.ok, true);
  // Every change says why (the engine's reason) and what happened to the base.
  assert.match(taken.why ?? "", /^no flow: /);
  assert.equal(taken.via, "autopilot");
  assert.equal(taken.toBaseMsat, 0);
  const stamps = saved().perChannelLastApplied;
  assert.equal(stamps["850000x1x0"], undefined, "no cooldown for an update that never happened");
  assert.ok(stamps["850000x2x0"]);
  assert.deepEqual(autopilot.feeChanges().map((c) => c.channelId), ["850000x2x0"]);
  assert.equal(autopilot.feeChanges()[0].why, taken.why);
});

test("manual Apply applies what the engine recommends — the base fee too — and keeps the autopilot's books: a base-fee-only row now changes", async (t) => {
  // At its balanced level, routing; only the 1 sat base fee is off target.
  const forwards: FakeForward[] = forwardsOut("850000x1x0", "850000x2x0", 5);
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [channel(1, { feeRatePpm: 80, baseFeeMsat: 1000 }), channel(2, { feeRatePpm: 80, baseFeeMsat: 0 })],
    forwards,
  });
  const api = await startApi(t, { node });
  const recs = (await api.request("GET", "/fees/recommendations")).body;
  const row = recs.recommendations.find((r: { channelId: string }) => r.channelId === "850000x1x0");
  assert.equal(row.targetPpm, 80);
  assert.deepEqual([row.currentBaseMsat, row.recommendedBaseMsat, row.wouldApply], [1000, 0, true]);
  // Before: the page sent the CURRENT base fee — a no-op write, "✓ 1 applied",
  // and the row stayed.
  const res = await api.request("POST", "/fees/apply-recommended", { channelIds: ["850000x1x0"] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.changes.map((c: { id: string; ok: boolean; toBaseMsat: number; via: string }) => [c.id, c.ok, c.toBaseMsat, c.via]), [["850000x1x0", true, 0, "manual"]]);
  assert.deepEqual(node.feeOf("850000x1x0"), { ppm: 80, base: 0 });
  assert.equal(node.policyWrites.length, 1, "only the row asked for");
  const state = (await api.request("GET", "/autopilot")).body;
  assert.equal(state.history[0].changes[0].via, "manual");
  // On record — but the price did not change, so the fee's clocks are not
  // started (review FEE-12; a change of the rate does stamp: the next test).
  assert.equal(api.autopilot.feeCooldown().lastApplied["850000x1x0"], undefined);
  assert.equal(api.autopilot.feeChanges()[0].via, "manual");
  const after = (await api.request("GET", "/fees/recommendations")).body;
  assert.equal(after.recommendations.find((r: { channelId: string }) => r.channelId === "850000x1x0").wouldApply, false, "the row is done");
});

test("a manual Apply stamps the cooldown: the autopilot's next run does not step the same channel again", async (t) => {
  // Idle at 40% local: the engine lowers it once a day.
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 })] });
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ enabled: true });
  const res = await api.request("POST", "/fees/apply-recommended", {});
  assert.equal(res.body.changes.length, 1);
  assert.equal(node.policyWrites.length, 1);
  // Before: nothing stamped — the next run lowered it again within minutes.
  const run = await api.autopilot.runOnce();
  assert.equal(run.changes.length, 0, JSON.stringify(run.changes));
  assert.equal(node.policyWrites.length, 1);
});

test("POST /fees/apply (a fee set by hand) goes through the same books: cooldown, run history, fee-change log", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1)] });
  const api = await startApi(t, { node });
  const res = await api.request("POST", "/fees/apply", {
    items: [{ id: "850000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 420, baseFeeMsat: 0 }],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r: { ok: boolean; feeRatePpm: number }) => [r.ok, r.feeRatePpm]), [[true, 420]]);
  assert.ok(api.autopilot.feeCooldown().lastApplied["850000x1x0"]);
  const [logged] = api.autopilot.feeChanges();
  assert.deepEqual([logged.fromPpm, logged.toPpm, logged.via, logged.why], [300, 420, "manual", "set by hand"]);
  const state = (await api.request("GET", "/autopilot")).body;
  assert.equal(state.history[0].changes[0].toPpm, 420);
});

test("GET /channels carries what each channel charges now", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { feeRatePpm: 640, baseFeeMsat: 1000 })] });
  const api = await startApi(t, { node });
  const res = await api.request("GET", "/channels");
  assert.equal(res.status, 200);
  assert.deepEqual([res.body[0].feeRatePpm, res.body[0].baseFeeMsat], [640, 1000]);
});

// ── review repair: back-off, the lock, the why, the episode, old pins ───────

/** The autopilot's in-memory retry book (writeFees). */
const retryBook = (autopilot: Autopilot) =>
  ((autopilot as unknown as { state: { perChannelFeeRetry?: Record<string, { until: string; error: string }> } }).state.perChannelFeeRetry ??= {});
const longAgo = () => new Date(Date.now() - 1).toISOString();
const failedLines = (autopilot: Autopilot) => autopilot.getState().history.flatMap((r) => r.changes).filter((c) => !c.ok);

test("an update LND keeps refusing is sent once, not every run — one request, one failed line in the run history, saying when it is tried again; the Fees tab shows the channel held", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 })] });
  node.refusals.set(`${TX(1)}:0`, "some persistent refusal");
  const { autopilot } = autopilotOn(t, node, { enabled: true });
  for (let i = 0; i < 3; i++) await autopilot.runOnce();
  // Before: a request and a failed history line every run (~48 a day).
  assert.equal(node.policyRequests.length, 1);
  const failed = failedLines(autopilot);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].error, `LND refused the update: some persistent refusal (invalid policy) — not retried for ${FEE_RETRY_BACKOFF_MS / 3_600_000} h`);
  const report = await getFeeRecommendations(node.lnd, [], autopilot.feeCooldown(), {}, {}, new Map(), new Map(), [], { demand: new Map(), market: new Map() });
  assert.deepEqual(report.recommendations[0].blockedByGuards, ["its last fee update failed — tried again in ~6 h"]);
  // After the back-off it is tried again — the same refusal again is not news.
  retryBook(autopilot)["850000x1x0"].until = longAgo();
  await autopilot.runOnce();
  assert.equal(node.policyRequests.length, 2);
  assert.equal(failedLines(autopilot).length, 1, "the same refusal is on record once");
  // Taken at last: written and booked, the back-off cleared.
  node.refusals.clear();
  retryBook(autopilot)["850000x1x0"].until = longAgo();
  const ok = await autopilot.runOnce();
  assert.deepEqual(ok.changes.map((c) => [c.ok, c.toPpm]), [[true, 270]]);
  assert.equal("850000x1x0" in retryBook(autopilot), false);
});

test("the retry back-off is saved: after a restart (every Umbrel update) an update LND refused is not sent again at once — the new process waits out the 6 h too (review 2026-10-25)", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 })] });
  node.refusals.set(`${TX(1)}:0`, "some persistent refusal");
  const { autopilot, dir } = autopilotOn(t, node, { enabled: true });
  await autopilot.runOnce();
  assert.equal(node.policyRequests.length, 1);
  await autopilot.shutdown();
  // A new process on the same disk.
  const after = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(after);
  t.after(() => after.shutdown());
  await after.runOnce();
  // Before: kept in memory only — the restarted process sent it again.
  assert.equal(node.policyRequests.length, 1, "not sent again");
  assert.deepEqual(Object.keys(after.feeCooldown().retryAfter ?? {}), ["850000x1x0"]);
});

test("each fee write is booked and saved as LND takes it — a restart in the middle of a batch keeps the cooldowns and fee-log records of the writes already made (review 2026-10-25)", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 }), channel(2, { localBalance: 800_000 })] });
  const { autopilot, dir, saved } = autopilotOn(t, node, { enabled: true });
  // The disk as the second write goes out — what a restart then would find.
  const seen: { stamps: string[]; logged: string[] }[] = [];
  let writes = 0;
  node.beforeCall = (method) => {
    if (method !== "default.updateChannelPolicy" || ++writes !== 2) return;
    seen.push({ stamps: Object.keys(saved().perChannelLastApplied), logged: new FeeChangeLog(dir).all().map((r) => r.channelId) });
  };
  const run = await autopilot.runOnce();
  const [first, second] = run.changes;
  assert.deepEqual([first?.ok, second?.ok], [true, true]);
  // Before: both were booked — and saved — only once the batch was done.
  assert.deepEqual(seen, [{ stamps: [first.id], logged: [first.id] }]);
  assert.deepEqual(Object.keys(saved().perChannelLastApplied).sort(), [first.id, second.id].sort());
});

test("a manual Apply never writes beside another fee write: while the fee lock is held, POST /fees/apply-recommended and POST /fees/apply answer 409, write nothing and leave the lock to its holder — a run's other stages don't hold them up", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 })] });
  const api = await startApi(t, { node });
  // The main run's fee stage (or the lease-promise check) holds the fee lock.
  const { feeLock } = api.autopilot as unknown as { feeLock: { run<T>(label: string, fn: () => Promise<T>): Promise<T>; busy: boolean } };
  let release!: () => void;
  const held = feeLock.run("fee stage", () => new Promise<void>((r) => (release = r)));
  const recommended = await api.request("POST", "/fees/apply-recommended", {});
  const byHand = await api.request("POST", "/fees/apply", {
    items: [{ id: "850000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 420, baseFeeMsat: 0 }],
  });
  assert.deepEqual([recommended.status, byHand.status], [409, 409]);
  assert.match(recommended.body.message, /^Fees are being written right now/);
  assert.equal(node.policyRequests.length, 0, "nothing written beside the fee stage");
  assert.equal(feeLock.busy, true, "a refused request does not release the holder's lock");
  release();
  await held;
  // A run refilling or opening — no fee write under way: the Apply goes
  // through (before, any run under way refused it).
  (api.autopilot as unknown as { running: boolean }).running = true;
  assert.equal((await api.request("POST", "/fees/apply-recommended", {})).status, 200);
  assert.equal(node.policyWrites.length, 1);
});

test("the run history says why each fee moved — the rule that set it: a raise toward the replacement cost reads 'replacement:', a lowering toward a cheaper market 'market:'", async (t) => {
  const DAY = 86_400_000;
  const channels = [
    // Draining (10 forwards of 50,000 out in 10 days), 80% local: at that
    // rate four weeks from drained — the ordinary raise, not the drain ramp.
    channel(1, { localBalance: 1_600_000, feeRatePpm: 80 }),
    // Routed this month, nothing in the last 14 days, 50% local.
    channel(2, { localBalance: 1_000_000, feeRatePpm: 80 }),
    // Where those forwards came in.
    channel(3, { localBalance: 1_000_000, feeRatePpm: 80 }),
  ];
  const forwards: FakeForward[] = [
    ...forwardsOut("850000x1x0", "850000x3x0", 10),
    ...[20, 22, 24].map((d) => ({ at: Date.now() - d * DAY, inId: "850000x3x0", outId: "850000x2x0", tokens: 10_000, feeMsat: 800 })),
  ];
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards });
  withMarket(node, channels, { "850000x1x0": { intoPpm: 300, backPpm: 100 }, "850000x2x0": { intoPpm: 40 } });
  const { autopilot } = autopilotOn(t, node, { enabled: true });
  const run = await autopilot.runOnce();
  const by = (id: string) => run.changes.find((c) => c.id === id);
  assert.deepEqual([by("850000x1x0")?.fromPpm, by("850000x1x0")?.toPpm], [80, 100], JSON.stringify(run.changes));
  // Before: "market: other nodes charge … — balanced level 80→… to compete" for this raise.
  assert.match(by("850000x1x0")?.why ?? "", /^replacement: draining, and a refill costs at least ~400 ppm/);
  assert.deepEqual([by("850000x2x0")?.fromPpm, by("850000x2x0")?.toPpm], [80, 50]);
  assert.match(by("850000x2x0")?.why ?? "", /^market: other nodes charge ~40 ppm into this peer/);
  assert.match(autopilot.feeChanges().find((c) => c.channelId === "850000x1x0")?.why ?? "", /^replacement:/, "the fee-change log keeps the same reason");
});

test("an applied no-flow lowering opens the flow-won episode — and the fee at which flow returns becomes the channel's anchor", async (t) => {
  const forwards: FakeForward[] = [];
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 }), channel(2)], forwards });
  const { autopilot, dir } = autopilotOn(t, node, { enabled: true });
  const run = await autopilot.runOnce();
  assert.deepEqual(run.changes.find((c) => c.id === "850000x1x0")?.toPpm, 270);
  const anchors = () => (JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as { perChannelFlowAnchor?: Record<string, { episodeAt?: string; anchorPpm?: number }> }).perChannelFlowAnchor ?? {};
  assert.ok(anchors()["850000x1x0"]?.episodeAt, JSON.stringify(anchors()));
  // Flow returns at 270 ppm: that price is remembered, the episode closed.
  forwards.push(...forwardsOut("850000x1x0", "850000x2x0", 2, { days: 1 }));
  await autopilot.runOnce();
  assert.equal(anchors()["850000x1x0"]?.anchorPpm, 270);
  assert.equal(anchors()["850000x1x0"]?.episodeAt, undefined);
  assert.equal(autopilot.flowAnchors().get("850000x1x0"), 270);
});

test("upgrading: a pin stored outside the policy range (the old pin inputs saved a blank field as 0) is rewritten to the fee it was given — never written as 0 ppm — and the operator is told", async (t) => {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [channel(1, { feeRatePpm: 25 }), channel(2, { feeRatePpm: 1000 }), channel(3, { feeRatePpm: 300 })],
  });
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const dir = makeTempDir(t);
  const justNow = new Date().toISOString();
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({
      config: { enabled: true },
      history: [],
      sellAutoSizeMigrated: true,
      // Changed just now: pins apply past the pacing anyway.
      perChannelLastApplied: { "850000x1x0": justNow, "850000x2x0": justNow, "850000x3x0": justNow },
    }),
  );
  writeFileSync(
    join(dir, "overrides.json"),
    JSON.stringify({
      "850000x1x0": { mode: "fixed", fixedPpm: 0 }, // the old engine applied the min, 25
      "850000x2x0": { mode: "fixed", fixedPpm: 5000 }, // … and the max, 1,000
      "850000x3x0": { mode: "fixed", fixedPpm: 295 }, // inside the range: the operator's value
    }),
  );
  const overrides = new OverridesStore(dir);
  const autopilot = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), overrides, new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(autopilot);
  t.after(() => autopilot.shutdown());
  await autopilot.runOnce();
  // Before: the stored 0 was written at once — the channel forwarded for free.
  assert.deepEqual(node.policyWrites, [{ outpoint: `${TX(3)}:0`, feeRatePpm: 295, baseFeeMsat: 0 }]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(overrides.all()).map(([id, o]) => [id, o.fixedPpm])),
    { "850000x1x0": 25, "850000x2x0": 1000, "850000x3x0": 295 },
  );
  const [incident] = storeIncidents(dir).filter((i) => i.file === "overrides.json");
  assert.equal(incident?.kind, "adjusted");
  assert.match(incident?.detail ?? "", /850000x1x0 pinned at 0 ppm is now pinned at 25 ppm/);
  assert.match(incident?.detail ?? "", /850000x2x0 pinned at 5000 ppm is now pinned at 1000 ppm/);
  // Once: a pin of 0 set after the upgrade is the operator's own choice.
  overrides.set("850000x1x0", { mode: "fixed", fixedPpm: 0 });
  await autopilot.runOnce();
  assert.deepEqual(node.policyWrites.at(-1), { outpoint: `${TX(1)}:0`, feeRatePpm: 0, baseFeeMsat: 0 });
});

test("two autopilot runs 31 minutes apart, the second's graph read slower than the fee engine waits: it still prices with the market and writes no fee on a market-priced channel", async (t) => {
  // Draining (10 forwards of 50,000 out in 20 days — a sale every other day,
  // not the daily seller a probe would try a higher fee on), priced at its
  // replacement cost already: 200 into the peer + 100 back = 300, × 1.15.
  const channels = [channel(1, { localBalance: 1_000_000, feeRatePpm: 340 }), channel(3, { localBalance: 1_000_000, feeRatePpm: 80 })];
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards: forwardsOut("850000x1x0", "850000x3x0", 10, { days: 20 }) });
  withMarket(node, channels, { "850000x1x0": { intoPpm: 200, backPpm: 100 } });
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const { autopilot } = autopilotOn(t, node, { enabled: true });
  const first = await autopilot.runOnce();
  assert.equal(first.changes.find((c) => c.id === "850000x1x0"), undefined, "at its market price: nothing to change");
  const writes = node.policyWrites.length;
  // 31 minutes later the graph read hangs (a big graph on a small machine).
  let reads = 0;
  node.override("default.describeGraph", () => {
    reads += 1;
  });
  t.mock.timers.tick(31 * 60_000);
  let done = false;
  const second = autopilot.runOnce().then((r) => {
    done = true;
    return r;
  });
  for (let i = 0; i < 400 && !done; i++) await new Promise((r) => setImmediate(r));
  const servedAtOnce = done;
  // Before: the 30-minute cache was gone; the run waited, then priced
  // without the market — and lowered the channel toward the balance curve
  // (340 → 310), only to raise it again on the next run that had the market.
  if (!done) t.mock.timers.tick(MARKET_RUN_WAIT_MS);
  const run = await second;
  assert.ok(servedAtOnce, "the run did not wait for the slow read");
  assert.deepEqual(run.changes, []);
  assert.equal(node.policyWrites.length, writes, "no fee written");
  assert.equal(reads, 1, "the fresh read goes on in the background");
});

test("after a restart the scheduled fee run waits for the first graph read — past a page's MARKET_WAIT_MS — instead of pricing without the market", async (t) => {
  // Idle at 40% local, 500 ppm; others charge 100 into its peer.
  const channels = [channel(1, { localBalance: 800_000, feeRatePpm: 500 })];
  const node = feeNode({ blockHeight: HEIGHT, channels });
  const graph = withMarket(node, channels, { "850000x1x0": { intoPpm: 100 } });
  // A big graph on a small machine: the first read takes 20 s.
  let reads = 0;
  node.override("default.describeGraph", (_a, cb) => {
    reads += 1;
    setTimeout(() => cb(null, graph), 20_000);
  });
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { autopilot } = autopilotOn(t, node, { enabled: true });
  const pending = autopilot.runOnce();
  for (let i = 0; i < 400 && reads === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1);
  t.mock.timers.tick(20_000);
  const run = await pending;
  // Before (a page's 15 s): "no flow: nothing routed here recently" — 500 → 470.
  assert.deepEqual(run.changes.map((c) => [c.fromPpm, c.toPpm]), [[500, 90]]);
  assert.match(run.changes[0].why ?? "", /^no flow: other nodes charge ~100 ppm into this peer — dropping to 90 ppm/);
  assert.ok(MARKET_RUN_WAIT_MS > 20_000);
});

// ── review 3: a peer back from an outage, a manual Apply that sees flow return ──

/** The graph right after the peer of `peer` was offline: the other nodes'
 *  channels into it carry the disabled bit (LND re-enables them only ~20
 *  minutes after the peer is back; gossip and this node's graph cache come
 *  on top), while our own channel to it is active again within seconds. */
function inboundDisabled(graph: { edges: Record<string, unknown>[] }, peer: string, own: string) {
  return {
    edges: graph.edges.map((e) =>
      e.node2_pub === peer && e.node1_pub !== own ? { ...e, node1_policy: { ...(e.node1_policy as object), disabled: true } } : e,
    ),
    nodes: [],
  };
}

test("a peer back from an outage — its inbound channels still disabled in the graph — no longer lowers a draining channel priced at its refill cost (340 → 310 toward the balance curve, then walked down for good)", async (t) => {
  // Draining (10 forwards of 50,000 out in 20 days — a sale every other day,
  // no daily seller for a probe) at 340: 200 into the peer + 100 back = a
  // refill costs ~300, × 1.15 = 345.
  const channels = [channel(1, { feeRatePpm: 340 }), channel(3, { feeRatePpm: 80 })];
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards: forwardsOut("850000x1x0", "850000x3x0", 10, { days: 20 }) });
  const graph = withMarket(node, channels, { "850000x1x0": { intoPpm: 200, backPpm: 100 } });
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const { autopilot } = autopilotOn(t, node, { enabled: true });
  await autopilot.runOnce();
  node.override("default.describeGraph", (_a, cb) => cb(null, inboundDisabled(graph, PEER(1), node.publicKey)));
  t.mock.timers.tick(GRAPH_TTL_MS + 60_000);
  await autopilot.runOnce(); // (the cached graph, while the fresh read lands)
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(25 * 3_600_000);
  await autopilot.runOnce();
  assert.deepEqual(node.policyWrites.filter((w) => w.outpoint === `${TX(1)}:0`), [], "no fee written on the draining channel");
});

test("through such a gap the autopilot keeps pricing a draining channel toward its refill cost from the reference it last saw — 200 → 220, then 220 → 240 with the reference gone", async (t) => {
  // (80% local: four weeks from drained at what it sells — ordinary raises, not the drain ramp.)
  const channels = [channel(1, { feeRatePpm: 200, localBalance: 1_600_000 }), channel(3, { feeRatePpm: 80 })];
  const forwards = forwardsOut("850000x1x0", "850000x3x0", 10);
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards });
  const graph = withMarket(node, channels, { "850000x1x0": { intoPpm: 200, backPpm: 100 } });
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const { autopilot } = autopilotOn(t, node, { enabled: true });
  const first = await autopilot.runOnce();
  assert.deepEqual(first.changes.filter((c) => c.id === "850000x1x0").map((c) => [c.fromPpm, c.toPpm]), [[200, 220]]);
  // Three days on (past the 72 h raise pause) the peer's inbound channels are disabled in the graph.
  node.override("default.describeGraph", (_a, cb) => cb(null, inboundDisabled(graph, PEER(1), node.publicKey)));
  t.mock.timers.tick(73 * 3_600_000);
  // It sold at 220 meanwhile: a raise needs a sale at the fee it raises from
  // (two sales — three in a day, and the drain ramp leads the raise).
  forwards.push(...forwardsOut("850000x1x0", "850000x3x0", 2, { days: 1 }));
  const second = await autopilot.runOnce();
  const ch1 = second.changes.find((c) => c.id === "850000x1x0");
  // Without the memory: no reference — held at 220, short of its refill cost.
  assert.deepEqual([ch1?.fromPpm, ch1?.toPpm], [220, 240], JSON.stringify(second.changes));
  assert.match(ch1?.why ?? "", /^replacement: draining, .* \(last seen 3 d ago\) — pricing toward 345 ppm/);
});

test("a manual Apply books returning flow first: the flow-won price is the fee at which flow came back — not the one the Apply then writes", async (t) => {
  const forwards: FakeForward[] = [];
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 }), channel(2)], forwards });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { autopilot } = autopilotOn(t, node, { enabled: true });
  await autopilot.runOnce(); // idle: the no-flow rule, 300 → 270 — the episode opens
  // Flow returns at 270 ppm; a day later the operator presses Apply on the
  // Fees tab before the next scheduled run — the curve now takes the fee
  // down a step (40% local).
  forwards.push(...forwardsOut("850000x1x0", "850000x2x0", 2, { days: 1 }));
  t.mock.timers.tick(25 * 3_600_000);
  const applied = await autopilot.applyRecommended(["850000x1x0"]);
  assert.deepEqual(applied?.map((c) => [c.fromPpm, c.toPpm]), [[270, 240]]);
  // Before: the Apply skipped the bookkeeping — the next run recorded 240.
  assert.equal(autopilot.flowAnchors().get("850000x1x0"), 270);
  await autopilot.runOnce();
  assert.equal(autopilot.flowAnchors().get("850000x1x0"), 270);
});

test("F09: a max_htlc update that fails outright (an error, not a refusal) is recorded as failed and backs off like a refusal", async () => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 1_500_000 })] });
  let asked = 0;
  node.override("default.updateChannelPolicy", (_a, cb) => {
    asked += 1;
    cb({ details: "LND is shutting down" });
  });
  const backoff = new Map<string, number>();
  const [first] = await runMaxHtlcPass(node.lnd, node.lnd, backoff);
  assert.equal(first?.ok, false);
  assert.ok(first?.error, "the failure is on record");
  assert.equal(asked, 1);
  // Within the back-off: no request at all.
  const again = await runMaxHtlcPass(node.lnd, node.lnd, backoff);
  assert.deepEqual(again, []);
  assert.equal(asked, 1, "not retried every run");
  // After it: tried again.
  backoff.set("850000x1x0", Date.now() - MAX_HTLC_BACKOFF_MS - 1);
  await runMaxHtlcPass(node.lnd, node.lnd, backoff);
  assert.equal(asked, 2);
});

test("a channel with under 1,024 sat to forward advertises its min_htlc, not 1,024 it can't carry — senders' failed small payments read as demand that kept it raising (review 2026-10-25)", async () => {
  assert.equal(maxHtlcBucketSat(0), 1);
  assert.equal(maxHtlcBucketSat(500, 3), 3, "the channel's min_htlc");
  assert.equal(maxHtlcBucketSat(1_024), 1_024);
  assert.equal(maxHtlcBucketSat(5_000), 4_096);
  assert.deepEqual(decideMaxHtlc(800, 1_024, 1), { change: true, toSat: 1 }, "lowered at once");
  // On a node: 500 sat to forward → max_htlc = its min_htlc (1,000 msat).
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 500 })] });
  const [moved] = await runMaxHtlcPass(node.lnd, node.lnd, new Map());
  assert.deepEqual([moved.toSat, moved.ok], [1, true]);
  assert.equal(node.policyRequests.at(-1)?.max_htlc_msat, "1000");
});

test("a max_htlc update LND takes but the channel doesn't advertise is not sent again every run — recorded once, then left alone 6 h (live: the same write every 30 min for 19 h)", async () => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 1_500_000 })] });
  // LND answers OK and changes nothing.
  node.override("default.updateChannelPolicy", (_a, cb) => cb(null, { failed_updates: [] }));
  const backoff = new Map<string, number>();
  const lastWrites = new Map<string, { fromSat: number | null; toSat: number }>();
  const first = await runMaxHtlcPass(node.lnd, node.lnd, backoff, { lastWrites });
  assert.equal(first.length, 1);
  assert.equal(first[0].ok, true);
  const second = await runMaxHtlcPass(node.lnd, node.lnd, backoff, { lastWrites });
  assert.equal(second.length, 1);
  assert.equal(second[0].ok, false);
  assert.equal(second[0].toSat, first[0].toSat, "the same write it would have sent again");
  assert.match(second[0].error ?? "", /^LND took the update, but the channel still advertises 1980000 max_htlc — not retried for 6 h$/);
  assert.equal((await runMaxHtlcPass(node.lnd, node.lnd, backoff, { lastWrites })).length, 0, "left alone");
  // After the back-off: tried once more.
  backoff.set("850000x1x0", Date.now() - MAX_HTLC_BACKOFF_MS - 1);
  assert.equal((await runMaxHtlcPass(node.lnd, node.lnd, backoff, { lastWrites })).length, 1);
});

test("a max_htlc update that took is written once — the next pass reads it back and leaves the channel alone", async () => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 1_500_000 })] });
  const lastWrites = new Map<string, { fromSat: number | null; toSat: number }>();
  assert.equal((await runMaxHtlcPass(node.lnd, node.lnd, new Map(), { lastWrites })).length, 1);
  assert.equal((await runMaxHtlcPass(node.lnd, node.lnd, new Map(), { lastWrites })).length, 0);
  assert.equal(lastWrites.size, 0, "settled: forgotten");
});


// ── review 2026-11-10, FEE-5 / FEE-6 / FEE-9 / FEE-10 / FEE-12 ──

const HOUR = 3_600_000;
const point = (r: Record<string, unknown>) => (r.chan_point as { funding_txid_str: string }).funding_txid_str;
/** The inbound fee a policy request names (LND's signs: negative is a discount) — null: none. */
const inboundNamed = (r: Record<string, unknown>) => {
  const i = r.inbound_fee as { base_fee_msat: number; fee_rate_ppm: number } | undefined;
  return i ? { base: Number(i.base_fee_msat) + 0, rate: Number(i.fee_rate_ppm) + 0 } : null;
};

test("an inbound discount set by hand survives the app's writes: a fee write and a max_htlc write both name it again exactly as LND has it, and a channel without one is sent none (review FEE-9: neither named it — an LND that resets what is not named lost the discount with every write)", async () => {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [
      channel(1, { localBalance: 1_500_000, inboundBaseMsat: -500, inboundRatePpm: -50 }),
      channel(2, { localBalance: 1_500_000 }),
      // The rate alone: both parts are named, the base as the 0 it is.
      channel(3, { localBalance: 1_500_000, inboundRatePpm: -20 }),
    ],
  });
  const results = await applyFees(
    node.lnd,
    node.lnd,
    [1, 2, 3].map((n) => ({ id: `850000x${n}x0`, transactionId: TX(n), transactionVout: 0, feeRatePpm: 250, baseFeeMsat: 0 })),
  );
  assert.deepEqual(results.map((r) => r.ok), [true, true, true]);
  const expected = [{ base: -500, rate: -50 }, null, { base: 0, rate: -20 }];
  assert.deepEqual(node.policyRequests.map(inboundNamed), expected);
  // The max_htlc pass (a single HTLC of 990,000 sat at most: 1,980,000 → 524,288 on each).
  const moved = await runMaxHtlcPass(node.lnd, node.lnd, new Map());
  assert.deepEqual(moved.map((m) => [m.id, m.toSat, m.ok]), [1, 2, 3].map((n) => [`850000x${n}x0`, 524_288, true]));
  assert.deepEqual(node.policyRequests.slice(3).map(inboundNamed), expected);
  assert.deepEqual([1, 2, 3].map((n) => node.inboundOf(`850000x${n}x0`)), [{ base: -500, rate: -50 }, { base: 0, rate: 0 }, { base: 0, rate: -20 }]);
});

test("the max_htlc pass leaves a channel the operator excluded alone — its policy is not rewritten (review FEE-5: 8 updates in 3 days for a channel 'the autopilot never touches'); a pinned channel's size stays managed", async (t) => {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [channel(1, { localBalance: 1_500_000 }), channel(2, { localBalance: 1_500_000 }), channel(3, { localBalance: 1_500_000 })],
  });
  const { autopilot } = autopilotOn(t, node, { maxHtlcEnabled: true });
  const { overrides } = autopilot as unknown as { overrides: OverridesStore };
  overrides.set("850000x1x0", { mode: "exclude" });
  overrides.set("850000x2x0", { mode: "fixed", fixedPpm: 300 });
  const run = await autopilot.runOnce();
  assert.deepEqual((run.maxHtlc ?? []).map((m) => [m.id, m.toSat, m.ok]), [
    ["850000x2x0", 524_288, true],
    ["850000x3x0", 524_288, true],
  ]);
  assert.deepEqual(node.policyRequests.map(point), [TX(2), TX(3)], "nothing sent for the excluded channel");
  // Taken back into automation, it is managed again.
  overrides.set("850000x1x0", { mode: "auto" });
  const next = await autopilot.runOnce();
  assert.deepEqual((next.maxHtlc ?? []).map((m) => m.id), ["850000x1x0"]);
});

test("one channel's max_htlc changes at most once in 6 h — a near-empty channel in use flipped 32,768 ↔ 65,536 with every payment, an update a run (review FEE-6); a change by two buckets or more, down or up, does not wait", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
  const RESERVE = 10_000;
  const ch = channel(1, { localBalance: RESERVE + 80_000 });
  const node = feeNode({ blockHeight: HEIGHT, channels: [ch] });
  const lastChanged = new Map<string, number>();
  const pass = async (spendable: number) => {
    node.channels[0].localBalance = RESERVE + spendable;
    return (await runMaxHtlcPass(node.lnd, node.lnd, new Map(), { lastChanged })).map((m) => [m.fromSat, m.toSat, m.ok]);
  };
  // The first change is made at once (nothing was changed before).
  assert.deepEqual(await pass(80_000), [[1_980_000, 65_536, true]]);
  // 50k leaves and comes back, every half hour: one bucket down, back up.
  for (let i = 0; i < 11; i++) {
    t.mock.timers.tick(HOUR / 2);
    assert.deepEqual(await pass(i % 2 === 0 ? 40_000 : 80_000), [], `run ${i + 1}: held`);
  }
  assert.equal(node.policyRequests.length, 1, "before: a write on each of these runs");
  // 6 h after the change the lower bucket is written …
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(40_000), [[65_536, 32_768, true]]);
  // … and the raise back waits its turn,
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(80_000), []);
  // but a channel that can forward a quarter of what it advertises says so now.
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(9_000), [[32_768, 8_192, true]]);
  // (One bucket down again: held, as the change before it was 30 minutes ago.
  // One bucket up, with its headroom: held as well.)
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(5_000), []);
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(18_100), []);
  // Three buckets up — it can forward eight times what it advertises: now.
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(80_000), [[8_192, 65_536, true]]);
  assert.equal(node.policyRequests.length, 4);
});

test("a channel that was emptied and is filled again advertises its size at once: 524,288 → 8,192 → 524,288 within the hour (review of the fee package, R4 — before: held at 8,192 for six hours with 600,000 sat to sell)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
  const RESERVE = 10_000;
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: RESERVE + 600_000 })] });
  const lastChanged = new Map<string, number>();
  const pass = async (spendable: number) => {
    node.channels[0].localBalance = RESERVE + spendable;
    return (await runMaxHtlcPass(node.lnd, node.lnd, new Map(), { lastChanged })).map((m) => [m.fromSat, m.toSat, m.ok]);
  };
  assert.deepEqual(await pass(600_000), [[1_980_000, 524_288, true]]);
  // A buyer empties it within the half hour …
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(9_000), [[524_288, 8_192, true]]);
  // … and the next run's refill brings the 600k back.
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(600_000), [[8_192, 524_288, true]]);
  // From there one bucket down waits its six hours again, counted from the raise.
  t.mock.timers.tick(5.5 * HOUR);
  assert.deepEqual(await pass(300_000), []);
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(300_000), [[524_288, 262_144, true]]);
});

test("a channel whose policy names no max_htlc (LND says 0) is given one, once — the interval holds the next write: a size the channel doesn't say is no 'two buckets off'", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-01T00:00:00Z") });
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 610_000 })] });
  // LND keeps answering with a policy that has no max_htlc.
  const info = node.lnd.default.getChanInfo;
  node.override("default.getChanInfo", (a, cb) =>
    info(a, (err: unknown, res: { node1_policy?: { max_htlc_msat?: string }; node2_policy?: { max_htlc_msat?: string } }) => {
      for (const p of [res?.node1_policy, res?.node2_policy]) if (p) p.max_htlc_msat = "0";
      cb(err, res);
    }),
  );
  assert.deepEqual(decideMaxHtlc(600_000, null), { change: true, toSat: 524_288 });
  const lastChanged = new Map<string, number>();
  const pass = async () => (await runMaxHtlcPass(node.lnd, node.lnd, new Map(), { lastChanged })).map((m) => [m.fromSat, m.toSat, m.ok]);
  assert.deepEqual(await pass(), [[0, 524_288, true]]);
  t.mock.timers.tick(HOUR / 2);
  assert.deepEqual(await pass(), [], "held for the interval");
  assert.equal(node.policyRequests.length, 1);
  t.mock.timers.tick(6 * HOUR);
  assert.deepEqual(await pass(), [[0, 524_288, true]]);
});

test("the autopilot keeps the six hours across its runs: the size it wrote in one run is not changed by the next (the stage hands every pass the same record of when each channel was changed)", async (t) => {
  const RESERVE = 10_000;
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: RESERVE + 80_000 })] });
  const { autopilot } = autopilotOn(t, node, { maxHtlcEnabled: true });
  const first = await autopilot.runOnce();
  assert.deepEqual((first.maxHtlc ?? []).map((m) => [m.fromSat, m.toSat, m.ok]), [[1_980_000, 65_536, true]]);
  // 40k leave before the next run: one bucket down — held.
  node.channels[0].localBalance = RESERVE + 40_000;
  const next = await autopilot.runOnce();
  assert.deepEqual(next.maxHtlc ?? [], []);
  assert.equal(node.policyRequests.length, 1);
});

test("a write that leaves the rate as it was — the base fee alone — does not restamp the fee's 'set at' time: what sold since the fee was set and the raise wait keep counting from the change of price (review FEE-12)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // Idle at 40% local: lowered 300 → 270 on the first run, base fee 0.
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 })] });
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ enabled: true });
  const run = await api.autopilot.runOnce();
  assert.deepEqual(run.changes.map((c) => [c.fromPpm, c.toPpm, c.ok]), [[300, 270, true]]);
  const setAt = api.autopilot.feeCooldown().lastApplied["850000x1x0"];
  assert.ok(setAt);
  // Three hours on, the base fee alone is written (by hand here).
  t.mock.timers.tick(3 * HOUR);
  const res = await api.request("POST", "/fees/apply", {
    items: [{ id: "850000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 270, baseFeeMsat: 1000 }],
  });
  assert.deepEqual(res.body.results.map((r: { ok: boolean; feeRatePpm: number }) => [r.ok, r.feeRatePpm]), [[true, 270]]);
  assert.deepEqual(node.feeOf("850000x1x0"), { ppm: 270, base: 1000 });
  // On record, as every write is …
  assert.deepEqual(api.autopilot.feeChanges().map((c) => [c.fromPpm, c.toPpm, c.toBaseMsat]), [[270, 270, 1000], [300, 270, 0]]);
  // … but the fee was set three hours ago, not now.
  assert.equal(api.autopilot.feeCooldown().lastApplied["850000x1x0"], setAt);
  // So a day after the price was set the idle channel's next lowering is due.
  // Before: the base-fee write restarted the day — the rate stood until 27 h.
  t.mock.timers.tick(21 * HOUR);
  const next = await api.autopilot.runOnce();
  assert.deepEqual(next.changes.map((c) => [c.fromPpm, c.toPpm, c.ok]), [[270, 240, true]]);
  // A change of the rate does restamp it.
  assert.equal(api.autopilot.feeCooldown().lastApplied["850000x1x0"], new Date().toISOString());
});

test("a fee LND has that the books don't — a write taken right before the process died, or a fee set with another tool — is put on record at the next run and its clocks start again: the engine does not step it a second time from the old stamp (review FEE-10)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  // Idle at 40% local: lowered once a day. Channel 2 is excluded.
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 }), channel(2, { localBalance: 800_000 })] });
  const { autopilot, saved } = autopilotOn(t, node, { enabled: true });
  const first = await autopilot.runOnce();
  assert.deepEqual(first.changes.map((c) => [c.id, c.fromPpm, c.toPpm, c.ok]), [
    ["850000x1x0", 300, 270, true],
    ["850000x2x0", 300, 270, true],
  ]);
  (autopilot as unknown as { overrides: OverridesStore }).overrides.set("850000x2x0", { mode: "exclude" });
  // A day later LND takes 270 → 240 and the books never hear of it.
  t.mock.timers.tick(24 * HOUR);
  const lost = await applyFees(node.lnd, node.lnd, [
    { id: "850000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 240, baseFeeMsat: 0 },
    { id: "850000x2x0", transactionId: TX(2), transactionVout: 0, feeRatePpm: 240, baseFeeMsat: 0 },
  ]);
  assert.deepEqual(lost.map((r) => r.ok), [true, true]);
  t.mock.timers.tick(HOUR / 2);
  const nowIso = new Date().toISOString();
  const run = await autopilot.runOnce();
  // Before: the stamp said "set 24.5 h ago" — 240 → 210 at once.
  assert.deepEqual(run.changes, [], "no second step");
  assert.equal(node.feeOf("850000x1x0")?.ppm, 240);
  assert.equal(saved().perChannelLastApplied["850000x1x0"], nowIso);
  const logged = autopilot.feeChanges();
  assert.deepEqual(
    logged.map((c) => [c.channelId, c.fromPpm, c.toPpm, c.via, c.why]),
    [
      ["850000x1x0", 270, 240, "manual", "found at this fee — set outside the app, or by it right before a restart"],
      ["850000x2x0", 300, 270, "autopilot", logged[1].why],
      ["850000x1x0", 300, 270, "autopilot", logged[2].why],
    ],
    "the excluded channel's fee is whoever manages it's business: no record",
  );
  // The next look finds the books in order: nothing more is recorded.
  t.mock.timers.tick(HOUR / 2);
  await autopilot.runOnce();
  assert.equal(autopilot.feeChanges().length, 3);
  // A day after it was found the channel is priced again, from 240.
  t.mock.timers.tick(24 * HOUR);
  const later = await autopilot.runOnce();
  assert.deepEqual(later.changes.map((c) => [c.id, c.fromPpm, c.ok]), [["850000x1x0", 240, true]]);
});
