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
import { MAX_HTLC_BACKOFF_MS, runMaxHtlcPass } from "../src/services/maxHtlc.js";
import { Autopilot, FEE_RETRY_BACKOFF_MS } from "../src/services/autopilot.js";
import { MARKET_RUN_WAIT_MS, getFeeRecommendations } from "../src/services/feeRecommend.js";
import { GRAPH_TTL_MS } from "../src/services/suggestions.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
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
  assert.ok(api.autopilot.feeCooldown().lastApplied["850000x1x0"], "the cooldown is stamped");
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
const retryBook = (autopilot: Autopilot) => (autopilot as unknown as { feeRetry: Map<string, { until: number; error: string }> }).feeRetry;
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
  retryBook(autopilot).get("850000x1x0")!.until = Date.now() - 1;
  await autopilot.runOnce();
  assert.equal(node.policyRequests.length, 2);
  assert.equal(failedLines(autopilot).length, 1, "the same refusal is on record once");
  // Taken at last: written and booked, the back-off cleared.
  node.refusals.clear();
  retryBook(autopilot).get("850000x1x0")!.until = Date.now() - 1;
  const ok = await autopilot.runOnce();
  assert.deepEqual(ok.changes.map((c) => [c.ok, c.toPpm]), [[true, 270]]);
  assert.equal(retryBook(autopilot).has("850000x1x0"), false);
});

test("a manual Apply never runs into the autopilot: while a run holds the lock, POST /fees/apply-recommended and POST /fees/apply answer 409, write nothing and leave the lock to its holder", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1, { localBalance: 800_000 })] });
  const api = await startApi(t, { node });
  const lock = api.autopilot as unknown as { running: boolean };
  lock.running = true;
  const recommended = await api.request("POST", "/fees/apply-recommended", {});
  const byHand = await api.request("POST", "/fees/apply", {
    items: [{ id: "850000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 420, baseFeeMsat: 0 }],
  });
  assert.deepEqual([recommended.status, byHand.status], [409, 409]);
  assert.equal(node.policyRequests.length, 0, "nothing written beside the run");
  assert.equal(lock.running, true, "a refused request does not release the run's lock");
  lock.running = false;
  assert.equal((await api.request("POST", "/fees/apply-recommended", {})).status, 200);
  assert.equal(node.policyWrites.length, 1);
});

test("the run history says why each fee moved — the rule that set it: a raise toward the replacement cost reads 'replacement:', a lowering toward a cheaper market 'market:'", async (t) => {
  const DAY = 86_400_000;
  const channels = [
    // Draining (10 forwards of 50,000 out in 10 days), 55% local.
    channel(1, { localBalance: 1_100_000, feeRatePpm: 80 }),
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
  // Draining (10 forwards of 50,000 out in 10 days), priced at its
  // replacement cost already: 200 into the peer + 100 back = 300, × 1.15.
  const channels = [channel(1, { localBalance: 1_000_000, feeRatePpm: 340 }), channel(3, { localBalance: 1_000_000, feeRatePpm: 80 })];
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards: forwardsOut("850000x1x0", "850000x3x0", 10) });
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
  // Draining (10 forwards of 50,000 out in 10 days) at 340: 200 into the
  // peer + 100 back = a refill costs ~300, × 1.15 = 345.
  const channels = [channel(1, { feeRatePpm: 340 }), channel(3, { feeRatePpm: 80 })];
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards: forwardsOut("850000x1x0", "850000x3x0", 10) });
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
  const channels = [channel(1, { feeRatePpm: 200 }), channel(3, { feeRatePpm: 80 })];
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards: forwardsOut("850000x1x0", "850000x3x0", 10) });
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
