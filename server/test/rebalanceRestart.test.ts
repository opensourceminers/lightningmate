/**
 * A refill payment that may still land is never forgotten — not by a restart,
 * a crash or a broken stream to LND (review of package P3).
 *
 * Before: a refill was recorded only after its payment returned, or at the
 * 150 s hard limit. A shutdown waits at most 37 s (every Umbrel update), a
 * crash not at all: the restarted process found no record of the payment
 * under way — today's budget didn't count it, nothing kept the autopilot off
 * its two channels (it refilled the same channel again while the first
 * payment could still land), and if the first one landed its fee never
 * reached the log (budget, P&L) and the gate's hold was never booked. Each
 * attempt is now on disk BEFORE it is sent (write-ahead, as the Magma journal
 * does it).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonStore } from "../src/store.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import type { RebalanceRecommendation } from "../src/services/rebalanceRecommend.js";
import { feeNode, type FeeChannel } from "./helpers/feeNode.js";
import { autopilotAt, autopilotWith } from "./helpers/autopilot.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";
import { until } from "./helpers/wait.js";

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const TARGET = "850000x1x0";
const SOURCE = "850000x3x0";
/** Another drained channel — refilled from the same source. */
const OTHER = "850000x4x0";
/** A second full source. */
const SECOND = "850000x5x0";

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

/** Two drained 5M channels at 400 ppm and two full sources, on a fake LND.
 *  A payment a test leaves hanging (an assertion failed before it was
 *  resolved) fails when the test ends — no 150 s wait behind it. */
function refillNode(t: AfterHook) {
  const node = feeNode({
    channels: [
      ch(TARGET, 1, { localBalance: 750_000, feeRatePpm: 400, totalSent: 3_333_333 }),
      ch(SOURCE, 3, { localBalance: 4_000_000 }),
      ch(OTHER, 4, { localBalance: 500_000, feeRatePpm: 400 }),
      ch(SECOND, 5, { localBalance: 4_000_000 }),
    ],
  });
  t.after(() => {
    for (const p of node.payments.values()) if (p.status === "IN_FLIGHT") node.resolvePayment(p.id, "fail");
  });
  return node;
}

/** The planner's move into `target` (only what the rebalance stage reads):
 *  400k from `sources`, valued at 400 ppm. */
const refill = (target: string, sources: string[] = [SOURCE]) =>
  ({
    channelId: target,
    alias: `peer-${target}`,
    state: "route_found_profitable",
    wouldRebalance: true,
    recommendedAmount: 400_000,
    selectedSourceChannel: sources[0],
    sourceCandidates: sources.map((id) => ({ channelId: id, alias: `src-${id}`, localRatio: 0.8, spareSats: 1_250_000, keepRatio: 0.55, reason: "" })),
    estimatedRouteFeeSats: 20,
    expectedNetProfitSats: 300,
    maxCostPpm: 320,
    maxCostSatsByPayback: 1_000,
    expectedRevenuePpm: 400,
    earningDemandSats: 1_200_000,
    minNetProfitSats: 100,
  }) as unknown as RebalanceRecommendation;

const hashOf = (call: Record<string, unknown>) => Buffer.from(call.payment_hash as Buffer).toString("hex");

/** Until LND holds `n` of the refill's payments in flight — and their ids.
 *  (The SendPaymentV2 call is recorded a tick before the fake LND registers
 *  the payment: acting on the call alone raced it.) */
async function inFlightAtLnd(node: ReturnType<typeof feeNode>, what: string, n = 1): Promise<string[]> {
  const ids = () => [...node.payments.values()].filter((p) => p.status === "IN_FLIGHT").map((p) => p.id);
  await until(() => ids().length === n, what);
  return ids();
}

interface Saved {
  pendingRebalances?: { id: string; at: string; day: string; maxFeeSats: number; holdPpm?: number; targetSentBefore?: number }[];
  perPairRebalanceFails?: Record<string, { fails: number }>;
  perTargetLastRebalanced?: Record<string, string>;
}
const saved = (dir: string) => JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as Saved;

test("a refill still being paid when the process stops was on disk before it was sent: the restarted process counts its maximum fee, leaves both its channels alone, and books it — real fee, hold, sent counter, the day it was sent — once LND says it landed", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  node.payOutcome = "hang"; // the HTLC is out; LND hasn't said how it ends
  const one = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  // Only the plan is stubbed: the executor and its books are the real ones.
  one.seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET)] });
  const first = one.autopilot.runOnce();
  const [id] = await inFlightAtLnd(node, "the refill's payment is in flight");
  const [sent] = node.callsTo("router.sendPaymentV2");
  assert.equal(hashOf(sent), id);
  const maxFee = Number(sent.fee_limit_sat);

  // The process stops here — a crash, or an update's shutdown whose 37 s
  // wait ran out: what it left on disk is all the next one has (nothing was
  // flushed).
  const disk = makeTempDir(t);
  cpSync(one.dir, disk, { recursive: true });
  const record = saved(disk).pendingRebalances?.find((p) => p.id === id);
  assert.ok(record, "the payment was on disk before it was sent");
  const two = autopilotAt(t, disk, node);
  const budget = two.autopilot.rebalanceBudget();
  assert.deepEqual([budget.inFlightSats, budget.spentSats], [maxFee, maxFee], "its maximum fee counts until LND says how it ended");

  // The restarted autopilot plans the same refill again, and one into
  // another channel from the same source: neither is sent while the first
  // payment may still land.
  node.payOutcome = (p) => (p.id === id ? "hang" : "succeed");
  two.seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET), refill(OTHER)] });
  await two.autopilot.runOnce();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "nothing more sent into either channel");
  const decision = two.autopilot.getState().decisions.rebalance?.text ?? "";
  assert.match(decision, new RegExp(`peer-${TARGET}: a payment into it is still in flight`));
  assert.match(decision, new RegExp(`peer-${OTHER}: every source is busy`));

  // LND: it landed. The next run books it as the first process would have.
  node.resolvePayment(id, "succeed");
  two.seams.rebalanceReport = async () => ({ recommendations: [] });
  await two.autopilot.runOnce();
  const [rec, ...more] = new RebalanceLog(disk).recent();
  assert.deepEqual(more, []);
  assert.deepEqual(
    [rec?.ok, rec?.via, rec?.feeSats, rec?.startedAt, rec?.holdPpm, rec?.targetSentBefore, rec?.paymentId, rec?.amountSats],
    [true, "autopilot", 2, record.at, 400, 3_333_333, id, 400_000],
  );
  assert.deepEqual([two.autopilot.rebalanceBudget().spentSats, two.autopilot.rebalanceBudget().inFlightSats], [2, 0], "the real fee, not the maximum");
  assert.deepEqual(saved(disk).pendingRebalances, []);
  // (The first process, still waiting, got its answer too — in its own dir.)
  await first;
});

test("a refill run by hand with the gate, still being paid when the process stops, is booked by the next one with its hold — like the autopilot's", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  node.payOutcome = "hang";
  const one = autopilotWith(t, { rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  // What the Rebalancing tab sends for a recommended row.
  const manual = one.autopilot.rebalanceByHand({
    targetId: TARGET,
    sourceId: SOURCE,
    amountSats: 400_000,
    econRatio: 0.8,
    maxFeePpm: 320,
    maxFeeSats: 380,
    gate: { revenuePpm: 400, demandSats: 1_200_000, minNetSats: 100 },
  });
  const [id] = await inFlightAtLnd(node, "the manual refill's payment is in flight");
  const disk = makeTempDir(t);
  cpSync(one.dir, disk, { recursive: true });
  assert.deepEqual(
    saved(disk).pendingRebalances?.map((p) => [p.id, p.holdPpm, p.targetSentBefore]),
    [[id, 400, 3_333_333]],
    "on disk before it was sent, with what its booking needs",
  );
  const two = autopilotAt(t, disk, node);
  node.resolvePayment(id, "succeed");
  await two.autopilot.checkInFlightRebalances();
  const [rec, ...more] = new RebalanceLog(disk).recent();
  assert.deepEqual(more, []);
  // Before: a manual refill's record carried no hold, and the reconciliation
  // dropped any for "manual".
  assert.deepEqual([rec?.ok, rec?.via, rec?.holdPpm, rec?.targetSentBefore, rec?.paymentId], [true, "manual", 400, 3_333_333, id]);
  // (The fake graph has no aliases: the label is the key's start.)
  assert.equal(rec?.sourceAlias, `${PEER(3).slice(0, 12)}…`, "and with its source's alias — a reconciled record's was blank");
  assert.equal((await manual)?.ok, true, "the first process got its answer too (in its own dir)");
});

test("an attempt that can't be saved before it is sent is not sent: nothing is paid, nothing else of the refill is tried", async (t) => {
  t.mock.method(console, "error", () => undefined); // the store reports the failing save
  const node = refillNode(t);
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET, [SOURCE, SECOND])] });
  // The disk is full the moment the attempt's record is written.
  const proto = JsonStore.prototype as unknown as { replaceFile(data: string, keepBackup: boolean): void };
  const real = proto.replaceFile;
  t.mock.method(proto, "replaceFile", function (this: { name: string }, data: string, keepBackup: boolean) {
    const pending = this.name === "autopilot.json" ? (JSON.parse(data) as Saved).pendingRebalances : undefined;
    if (pending?.length) throw new Error("ENOSPC: no space left on device");
    return real.call(this, data, keepBackup);
  });
  const run = await autopilot.runOnce();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0, "never sent — no smaller size, no other source");
  assert.match(run.rebalances[0]?.error ?? "", /^not sent: the payment couldn't be recorded before sending it \(ENOSPC: no space left on device\) — nothing was paid/);
  assert.deepEqual(saved(dir).pendingRebalances ?? [], [], "no record of a payment that was never sent");
  assert.equal(autopilot.rebalanceBudget().spentSats, 0);
  assert.deepEqual(saved(dir).perPairRebalanceFails ?? {}, {}, "a full disk is no route failure: no pair backs off");
});

test("an attempt whose wait broke off without LND saying how it ended (the stream dropped) stays in flight — no smaller size or other source is tried meanwhile — and is booked once LND says", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  // The first payment stays in flight; any other would fail at once (a
  // regression shows as a second payment, not as a test that hangs).
  let firstId: string | null = null;
  node.payOutcome = (p) => {
    firstId ??= p.id;
    return p.id === firstId ? "hang" : "fail";
  };
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET, [SOURCE, SECOND])] });
  const run = autopilot.runOnce();
  const [id] = await inFlightAtLnd(node, "the refill's payment is in flight");
  node.dropPaymentStreams(id); // LND restarted, or the connection to it dropped
  const done = await run;
  // Before: treated as a failure — the next smaller amount (or source) was
  // sent while the first payment could still land: twice the planned move.
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "nothing else sent");
  assert.match(done.rebalances[0]?.error ?? "", /^LND hasn't said how the payment ended \(UnexpectedPaymentError: Connection dropped\) — it may still land/);
  assert.deepEqual(saved(dir).pendingRebalances?.map((p) => p.id), [id], "kept as in flight");
  assert.deepEqual(saved(dir).perPairRebalanceFails ?? {}, {}, "not a failure (yet)");

  node.resolvePayment(id, "succeed");
  await autopilot.checkInFlightRebalances();
  assert.deepEqual(
    new RebalanceLog(dir).recent().map((r) => [r.ok, r.paymentId, r.feeSats]),
    [[true, id, 2]],
  );
  assert.deepEqual(saved(dir).pendingRebalances, []);
});

test("the in-flight check never books a payment this process is still waiting on — LND may not know it yet — and the refill is booked once, as it really ended", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  node.payOutcome = "hang";
  const { autopilot, dir } = autopilotWith(t, {}, {}, {}, node);
  const manual = autopilot.rebalanceByHand({ targetId: TARGET, sourceId: SOURCE, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 300 });
  const [id] = await inFlightAtLnd(node, "the manual refill's payment is in flight");
  assert.deepEqual(saved(dir).pendingRebalances?.map((p) => p.id), [id], "on disk before it was sent");

  // The timer's check comes round meanwhile (a manual refill holds no main
  // run lock) — and LND, asked a moment too early, has no such payment yet.
  const seam = autopilot as unknown as { rebalancePaymentStatus: (id: string) => Promise<unknown> };
  const real = seam.rebalancePaymentStatus;
  seam.rebalancePaymentStatus = async () => ({ state: "failed" });
  await autopilot.checkInFlightRebalances();
  assert.deepEqual(new RebalanceLog(dir).recent(), [], "not booked as failed while its refill still waits on it");
  assert.deepEqual(saved(dir).pendingRebalances?.map((p) => p.id), [id]);
  seam.rebalancePaymentStatus = real;

  node.resolvePayment(id, "succeed");
  const res = await manual;
  assert.equal(res?.ok, true);
  assert.deepEqual(
    new RebalanceLog(dir).recent().map((r) => [r.ok, r.via, r.paymentId]),
    [[true, "manual", id]],
    "booked once, as it ended",
  );
  assert.deepEqual(saved(dir).pendingRebalances, []);
  assert.deepEqual(saved(dir).perPairRebalanceFails ?? {}, {}, "no pair backs off for a payment that paid");
});

test("a payment booked just before the process stopped — its log record written, the state not yet saved — is not booked twice", async (t) => {
  const id = "ab".repeat(32);
  const at = new Date().toISOString();
  const { autopilot, dir } = autopilotWith(
    t,
    { rebalanceDailyBudgetSats: 1_000 },
    {
      pendingRebalances: [
        { id, targetId: TARGET, sourceId: SOURCE, alias: "t", amountSats: 400_000, maxFeeSats: 60, day: at.slice(0, 10), at, via: "autopilot", holdPpm: 400 },
      ],
    },
    {
      "rebalances.json": [
        {
          at,
          startedAt: at,
          via: "autopilot",
          targetId: TARGET,
          targetAlias: "t",
          sourceId: SOURCE,
          sourceAlias: "s",
          amountSats: 400_000,
          budgetPpm: 320,
          feeSats: 12,
          costPpm: 30,
          ok: true,
          paymentId: id,
          holdPpm: 400,
        },
      ],
    },
  );
  (autopilot as unknown as { rebalancePaymentStatus: () => Promise<unknown> }).rebalancePaymentStatus = async () => ({ state: "confirmed", feeSats: 12 });
  await autopilot.checkInFlightRebalances();
  assert.equal(new RebalanceLog(dir).successes().length, 1, "booked once");
  assert.equal(autopilot.rebalanceBudget().spentSats, 12, "its fee counts once — not twice, nor with its 60 sat maximum on top");
  assert.deepEqual(saved(dir).pendingRebalances, []);
});

test("each attempt is on disk the moment LND receives it; a refill that pays is booked once — with the time it was sent — and its record cleared", async (t) => {
  const node = refillNode(t);
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET)] });
  let onDisk: Saved["pendingRebalances"];
  let cooldownOnDisk: string | undefined;
  node.beforeCall = (method) => {
    if (method !== "router.sendPaymentV2") return;
    onDisk = saved(dir).pendingRebalances;
    cooldownOnDisk = saved(dir).perTargetLastRebalanced?.[TARGET];
  };
  await autopilot.runOnce();
  const [sent] = node.callsTo("router.sendPaymentV2");
  const id = hashOf(sent);
  assert.deepEqual(
    onDisk?.map((p) => [p.id, p.maxFeeSats, p.holdPpm, p.targetSentBefore]),
    [[id, Number(sent.fee_limit_sat), 400, 3_333_333]],
    "on disk when LND got it",
  );
  assert.ok(cooldownOnDisk, "and the target's cooldown with it");
  const [rec, ...more] = new RebalanceLog(dir).recent();
  assert.deepEqual(more, []);
  // Its fee counts on the day it was sent (a payment sent at 23:59 and paid
  // after midnight is that day's, as one that ends after a restart is).
  assert.deepEqual([rec?.ok, rec?.paymentId, rec?.startedAt, rec?.feeSats], [true, id, onDisk?.[0]?.at, 2]);
  assert.deepEqual(saved(dir).pendingRebalances, []);
  assert.deepEqual([autopilot.rebalanceBudget().spentSats, autopilot.rebalanceBudget().inFlightSats], [2, 0]);
});

test("a refill whose every attempt fails leaves nothing pending: its fee room comes back at once and the failing pair backs off", async (t) => {
  const node = refillNode(t);
  node.payOutcome = "fail"; // no route
  const { autopilot, seams, dir } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({ recommendations: [refill(TARGET)] });
  const run = await autopilot.runOnce();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "the gate leaves no fee room at the smaller sizes");
  assert.equal(run.rebalances[0]?.ok, false);
  assert.deepEqual(saved(dir).pendingRebalances, [], "a payment LND failed is no payment in flight");
  assert.deepEqual([autopilot.rebalanceBudget().spentSats, autopilot.rebalanceBudget().inFlightSats], [0, 0]);
  assert.equal(saved(dir).perPairRebalanceFails?.[`${SOURCE}>${TARGET}`]?.fails, 1);
});

test("the reconciliation leaves alone a payment its own refill settled while it was asking LND about an earlier one — no second record, no second back-off", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode(t);
  const old = "ab".repeat(32);
  const at = new Date().toISOString();
  const { autopilot, dir } = autopilotWith(
    t,
    {},
    { pendingRebalances: [{ id: old, targetId: OTHER, sourceId: SECOND, alias: "o", amountSats: 400_000, maxFeeSats: 40, day: at.slice(0, 10), at, via: "autopilot" }] },
    {},
    node,
  );
  let manualId = "";
  node.payOutcome = (p) => (p.id === manualId || !manualId ? "hang" : "fail");
  const manual = autopilot.rebalanceByHand({ targetId: TARGET, sourceId: SOURCE, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 300 });
  [manualId] = await inFlightAtLnd(node, "the manual refill's first payment is in flight");
  // The in-flight check starts with the older entry; LND takes its time.
  const lnd = { answer: null as ((status: unknown) => void) | null };
  const seam = autopilot as unknown as { rebalancePaymentStatus: (id: string) => Promise<unknown> };
  const real = seam.rebalancePaymentStatus.bind(autopilot);
  seam.rebalancePaymentStatus = (id) => (id === old ? new Promise((r) => (lnd.answer = r)) : real(id));
  const check = autopilot.checkInFlightRebalances();
  await until(() => lnd.answer !== null, "the check asks LND about the older payment");
  // Meanwhile the manual refill's payment fails, and so do its smaller ones.
  node.resolvePayment(manualId, "fail");
  const res = await manual;
  assert.equal(res?.ok, false);
  lnd.answer?.({ state: "pending" });
  await check;
  const records = new RebalanceLog(dir).recent();
  assert.deepEqual(records.map((r) => [r.via, r.ok, r.paymentId]), [["manual", false, undefined]], "the refill's own record only");
  assert.equal(saved(dir).perPairRebalanceFails?.[`${SOURCE}>${TARGET}`]?.fails, 1, "backed off once");
  assert.deepEqual(saved(dir).pendingRebalances?.map((p) => p.id), [old], "the older payment is still pending");
});
