/**
 * Work that never ends no longer holds the autopilot up, and fee writes no
 * longer skip its runs (review 2026-10-25, PROBE-HANG and PROBE-LOCK-*).
 *
 * LND's gRPC calls carry no deadline (the lightning library builds its
 * clients without one, and offers no hook to add one). One call that never
 * answered held the main run's lock until a restart: no further run, no "Run
 * once now", no manual fee write, no lease-promise check. Now every main-run
 * stage, the lease-promise check, a manual fee write, the in-flight refill
 * check, the offer price check, the purchase follow-up and each order-lane
 * pass run within a deadline — given up past it, writing nothing when the
 * call answers late — and fee writes have a lock of their own: the
 * lease-promise check or an Apply under way no longer makes a scheduled run
 * (or the run Liquidity provision's switch-on kicks) a silent no-op.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WORK_DEADLINES_MS, WorkDeadlineError, givenUp, withDeadline, type Autopilot } from "../src/services/autopilot.js";
import { LANE_PASS_DEADLINE } from "../src/services/magmaDesk.js";
import type { FeeApplyItem } from "../src/services/fees.js";
import type { FeeRecReport } from "../src/services/feeRecommend.js";
import { autopilotWith, plannedFeeChange, sellerSetup, type AutopilotSeams } from "./helpers/autopilot.js";
import { quiet, keepFileAlive } from "./helpers/lifecycle.js";

// Deadlines in these tests fire on timers nothing else keeps alive (see keepFileAlive).
keepFileAlive();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deadlines short enough for a test (150 ms), restored after it. */
function shortDeadlines(t: TestContext): void {
  const saved = { ...WORK_DEADLINES_MS };
  const lane = LANE_PASS_DEADLINE.ms;
  Object.assign(WORK_DEADLINES_MS, { stage: 150, perRefill: 150, feeWork: 150, inflightCheck: 150, laneWork: 150 });
  LANE_PASS_DEADLINE.ms = 150;
  t.after(() => {
    Object.assign(WORK_DEADLINES_MS, saved);
    LANE_PASS_DEADLINE.ms = lane;
  });
  // A stage given up is logged as an error.
  t.mock.method(console, "error", () => undefined);
}

/** A promise the test settles. */
function gate<T>() {
  let answer!: (v: T) => void;
  const promise = new Promise<T>((r) => (answer = r));
  return { promise, answer };
}

type Report = Pick<FeeRecReport, "recommendations">;

function withLeaseCap(autopilot: Autopilot): void {
  autopilot.capital.register("test", {
    reservations: () => [],
    deployedSat: () => 0,
    claimedOutpoints: () => [],
    leaseCaps: () => [
      { fundingOutpoint: "ee".repeat(32) + ":0", source: "magma", orderId: "o1", feeRateCapPpm: 2200, baseFeeCapMsat: 1000, leaseBlocks: 4320 },
    ],
  });
}

const setLeaseBreaches = (autopilot: Autopilot, fn: () => Promise<unknown[]>) => {
  (autopilot as unknown as { leaseBreaches: () => Promise<unknown[]> }).leaseBreaches = fn;
};

const okApply = (applied: FeeApplyItem[]): AutopilotSeams["feeApply"] => async (_w, items) => {
  applied.push(...items);
  return items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm, baseFeeMsat: i.baseFeeMsat }));
};

const feeLockOf = (autopilot: Autopilot) =>
  (autopilot as unknown as { feeLock: { run<T>(label: string, fn: () => Promise<T>): Promise<T>; busy: boolean } }).feeLock;

test("a stage whose LND call never answers is given up at its deadline: the run records it, goes on and ends — the next run, an Apply and the lease check go ahead, and the late answer writes nothing", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  withLeaseCap(autopilot);
  let leaseChecks = 0;
  setLeaseBreaches(autopilot, async () => {
    leaseChecks++;
    return [];
  });
  const late = gate<Report>();
  let reports = 0;
  seams.feeReport = () => (++reports === 1 ? late.promise : Promise.resolve({ recommendations: [] }));
  const applied: FeeApplyItem[] = [];
  seams.feeApply = okApply(applied);
  let sells = 0;
  seams.runSell = async () => {
    sells++;
    return [];
  };
  const run = await autopilot.runOnce();
  const error = "the fees stage did not finish in 150 ms — LND or Amboss didn't answer; it was given up";
  assert.deepEqual(run.errors, [{ stage: "fees", error }]);
  assert.equal(sells, 1, "the stages after it still ran");
  assert.equal(autopilot.getState().runningSince, null, "the run ended, its lock freed");
  assert.equal(autopilot.getState().status.fees.state, "error");
  assert.match(autopilot.getState().status.fees.text, /the fees stage did not finish in 150 ms/);
  // Nothing waits on it any more — the fee lock included, though the
  // given-up stage still waits on its call.
  assert.equal(feeLockOf(autopilot).busy, false);
  assert.deepEqual(await autopilot.applyRecommended(), [], "an Apply goes through");
  // The report answers late: the given-up stage writes nothing, and the
  // area's decision stays the deadline's.
  late.answer({ recommendations: [plannedFeeChange("800000x1x0", 100, 80)] });
  await sleep(20);
  assert.deepEqual(applied, [], "nothing written by the given-up stage");
  assert.match(autopilot.getState().status.fees.text, /did not finish in 150 ms/);
  assert.notEqual(await autopilot.runOnceNow(), null, "Run once now runs");
  await autopilot.keepLeasePromisesNow();
  assert.equal(leaseChecks, 1, "the lease-promise check runs");
  assert.equal(await autopilot.waitIdle(1_000), true);
});

test("work given up stays given up in the work it started inside it — and code outside any work is never given up", async () => {
  assert.equal(givenUp(), null);
  const late = gate<void>();
  let inner: string | null = "not asked";
  const outer = withDeadline("the outer work", 30, () =>
    withDeadline("the inner work", 60_000, async () => {
      await late.promise;
      inner = givenUp();
    }),
  );
  await assert.rejects(outer, WorkDeadlineError);
  late.answer();
  await sleep(10);
  assert.equal(inner, "the outer work was given up (it did not finish in time)");
});

test("a run kicked from inside work that is given up later does not inherit it: its writes go ahead", async (t) => {
  const { autopilot } = autopilotWith(t, {});
  // The real kick (the helper suppresses it for every other test).
  const kick = (Object.getPrototypeOf(autopilot) as { kick: (fn: () => Promise<unknown>, ms: number) => void }).kick.bind(autopilot);
  const fired = gate<string | null>();
  const work = withDeadline("the kicking work", 20, async () => {
    kick(async () => fired.answer(givenUp()), 60);
    await new Promise(() => undefined);
  });
  await assert.rejects(work, WorkDeadlineError);
  assert.equal(await fired.promise, null);
});

test("the lease-promise check holds the fee lock only: Run once now runs meanwhile — its fee stage after the check — and while a run IS under way it says so, with the run's time", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  withLeaseCap(autopilot);
  const events: string[] = [];
  const check = gate<unknown[]>();
  setLeaseBreaches(autopilot, async () => {
    events.push("lease check");
    const breaches = await check.promise;
    events.push("lease check done");
    return breaches;
  });
  seams.feeReport = async () => {
    events.push("fee report");
    return { recommendations: [plannedFeeChange("800000x1x0", 100, 80)] };
  };
  seams.feeApply = okApply([]);
  const lease = autopilot.keepLeasePromisesNow();
  // Before: "busy" — with no run under way (runningSince null, the 409 named
  // no time) — and the scheduled run was skipped without a trace.
  const clicked = autopilot.runOnceNow();
  await sleep(20);
  assert.ok(autopilot.getState().runningSince, "the run is under way");
  assert.equal(await autopilot.runOnceNow(), null, "a run IS under way: the click starts none");
  check.answer([]);
  const run = await clicked;
  await lease;
  assert.equal(run?.applied, 1);
  assert.deepEqual(events, ["lease check", "lease check done", "fee report"], "the fee stage waited for the check");
  assert.ok(autopilot.getState().lastRunAt);
});

test("a manual Apply holds the fee lock only: the scheduled run that fires meanwhile runs, its fee stage after the Apply", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  const events: string[] = [];
  const slow = gate<Report>();
  let reports = 0;
  seams.feeReport = () => {
    events.push(`fee report ${++reports}`);
    return reports === 1 ? slow.promise : Promise.resolve({ recommendations: [] });
  };
  seams.feeApply = okApply([]);
  seams.runSell = async () => {
    events.push("magma");
    return [];
  };
  const apply = autopilot.applyRecommended();
  const scheduled = autopilot.runOnce(); // what the interval's tick calls
  await sleep(20);
  assert.ok(autopilot.getState().runningSince, "the run is under way (before: skipped)");
  assert.equal(reports, 1, "its fee stage waits for the Apply");
  slow.answer({ recommendations: [] });
  await apply;
  await scheduled;
  assert.deepEqual(events, ["fee report 1", "fee report 2", "magma"]);
  assert.ok(autopilot.getState().lastRunAt);
});

test("the max_htlc stage writes under the fee lock: it waits for a fee write under way — each writes back the other's half of the policy as it read it", async (t) => {
  quiet(t);
  const { autopilot, node, seams } = autopilotWith(t, { maxHtlcEnabled: true });
  seams.runSell = async () => [];
  const write = gate<void>();
  const held = feeLockOf(autopilot).run("fee set by hand", () => write.promise);
  const run = autopilot.runOnce();
  await sleep(30);
  assert.equal(node.callsTo("default.listChannels").length, 0, "no policy read beside the fee write");
  write.answer();
  await held;
  await run;
  assert.ok(node.callsTo("default.listChannels").length > 0, "read once the fee write was done");
});

test("with fee automation off, the run's lease-promise stage writes under the fee lock too — and a fee write under way is waited for at shutdown", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: false });
  withLeaseCap(autopilot);
  seams.runSell = async () => [];
  let checks = 0;
  setLeaseBreaches(autopilot, async () => {
    checks++;
    return [];
  });
  const write = gate<void>();
  const held = feeLockOf(autopilot).run("fee set by hand", () => write.promise);
  assert.equal(await autopilot.waitIdle(60), false, "not idle while a fee write is under way");
  const run = autopilot.runOnce();
  await sleep(30);
  assert.equal(checks, 0, "no lease-promise read beside the fee write");
  write.answer();
  await held;
  await run;
  assert.equal(checks, 1);
});

test("a lease-promise check, an Apply or a fee set by hand whose LND read never answers is given up at its deadline — the fee lock is free again", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot, node, seams } = autopilotWith(t, { enabled: true });
  withLeaseCap(autopilot);
  const breaches = gate<unknown[]>();
  setLeaseBreaches(autopilot, () => breaches.promise);
  // As LND's own write path does: each write asks first.
  const applied: FeeApplyItem[] = [];
  seams.feeApply = async (_w, items, opts?: { shouldStop?: () => boolean }) => {
    const out = [];
    for (const i of items) {
      if (opts?.shouldStop?.()) break;
      applied.push(i);
      out.push({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm, baseFeeMsat: i.baseFeeMsat });
    }
    return out;
  };
  assert.deepEqual(await autopilot.keepLeasePromisesNow(), []);
  assert.equal(feeLockOf(autopilot).busy, false);
  // Its read answers late, with a breach: the given-up check writes nothing
  // (it asks no switch — a promise holds whatever they say — but its scope).
  breaches.answer([
    { id: "800000x1x0", transactionId: "ee".repeat(32), transactionVout: 0, feeRatePpm: 2200, baseFeeMsat: 1000, alias: "buyer", fromPpm: 5000, fromBaseMsat: 1000, why: "lease promise: …", leaseBreach: true },
  ]);
  await sleep(20);
  assert.deepEqual(applied, []);
  seams.feeReport = () => new Promise(() => undefined);
  await assert.rejects(autopilot.applyRecommended(), (e: unknown) => e instanceof WorkDeadlineError && /^the fee apply did not finish in 150 ms/.test(e.message));
  assert.equal(feeLockOf(autopilot).busy, false);
  node.override("default.listChannels", () => undefined);
  await assert.rejects(
    autopilot.applyByHand([{ id: "800000x1x0", transactionId: "ee".repeat(32), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 }]),
    /the fee set by hand did not finish in 150 ms/,
  );
  assert.equal(feeLockOf(autopilot).busy, false);
});

test("Liquidity provision switched on while the lease-promise check runs: the run kicked for it does the offer upkeep — before, it was skipped and none followed", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: false });
  withLeaseCap(autopilot);
  const kicks: (() => Promise<unknown>)[] = [];
  (autopilot as unknown as { kick: (fn: () => Promise<unknown>, ms: number) => void }).kick = (fn) => void kicks.push(fn);
  let sells = 0;
  seams.runSell = async () => {
    sells++;
    return [];
  };
  const check = gate<unknown[]>();
  setLeaseBreaches(autopilot, () => check.promise);
  const lease = autopilot.keepLeasePromisesNow();
  autopilot.setConfig({ sellEnabled: true });
  const kicked = kicks[0]();
  check.answer([]);
  await kicked;
  await lease;
  assert.equal(sells, 1, "the switch-on's offer upkeep ran");
});

/** A sale of this node's in the journal, its channel open and reported:
 *  the lane walks it every pass. */
function orderInFlight(autopilot: Autopilot, orderId: string): void {
  const { journal } = autopilot.magma;
  journal.commit(
    journal.create({
      orderId,
      via: "autopilot",
      buyerPubkey: "02" + "99".repeat(32),
      sizeSats: 2_000_000,
      isPrivate: false,
      feeMsat: "12345000",
      phase: "reported",
      leaseBlocks: 4320,
      fundingOutpoint: `${"aa".repeat(32)}:0`,
    }),
  );
}

/** The lane's own LND read (this node's key), answered by the test. */
function hangOwnPubkey(autopilot: Autopilot, answerAfter: number, pubkey: string) {
  const hung: ReturnType<typeof gate<string>>[] = [];
  (autopilot.magma as unknown as { ownPubkey: () => Promise<string> }).ownPubkey = () => {
    if (hung.length >= answerAfter) return Promise.resolve(pubkey);
    const g = gate<string>();
    hung.push(g);
    return g.promise;
  };
  return hung;
}

const countSteps = (autopilot: Autopilot) => {
  const steps = { n: 0 };
  (autopilot.magma as unknown as { advance: () => Promise<unknown[]> }).advance = async () => {
    steps.n++;
    return [];
  };
  return steps;
};

test("an order-lane pass whose call never answers is given up at its deadline: the lane is free again and says so — and when the call answers late, that pass starts no order step and never frees the lane of a newer one", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot, node } = sellerSetup(t);
  orderInFlight(autopilot, "magma-1");
  const steps = countSteps(autopilot);
  const hung = hangOwnPubkey(autopilot, 2, node.publicKey);
  assert.deepEqual(await autopilot.magma.tick(), []);
  const lane = autopilot.magma.laneStatus();
  assert.equal(lane.running, false, "the lane is free again");
  assert.equal(lane.ok, false);
  assert.match(lane.error ?? "", /^the order lane's pass did not finish in 150 ms — LND or Amboss didn't answer, or a buyer couldn't be reached in time; it was given up/);
  // A newer pass under way (its read hangs too) when the first answers late.
  const newer = autopilot.magma.tick();
  await sleep(10);
  hung[0].answer(node.publicKey);
  await sleep(20);
  assert.equal(steps.n, 0, "the given-up pass started no order step");
  assert.equal(autopilot.magma.laneStatus().running, true, "the newer pass still holds the lane");
  await newer;
  hung[1].answer(node.publicKey);
  await sleep(20);
  // Both ended: the next pass runs as usual.
  await autopilot.magma.tick();
  assert.equal(steps.n, 1);
  assert.equal(autopilot.magma.laneStatus().ok, true, JSON.stringify(autopilot.magma.laneStatus()));
});

test("at most two given-up order-lane passes wait on their call: then no pass starts until one of them ends", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot, node } = sellerSetup(t);
  const hung = hangOwnPubkey(autopilot, 2, node.publicKey);
  await autopilot.magma.tick();
  await autopilot.magma.tick();
  assert.equal(hung.length, 2);
  await autopilot.magma.tick();
  assert.equal(hung.length, 2, "no third pass waits on the same node");
  assert.match(autopilot.magma.laneStatus().error ?? "", /^2 passes of the order lane did not finish — LND or Amboss isn't answering; no new pass starts until one of them ends/);
  hung[0].answer(node.publicKey);
  await sleep(20);
  await autopilot.magma.tick();
  assert.equal(autopilot.magma.laneStatus().ok, true, JSON.stringify(autopilot.magma.laneStatus()));
  hung[1].answer(node.publicKey);
});

test("an order whose step a given-up pass still waits on is left to a later pass — the next pass goes on with the others and says so", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot } = sellerSetup(t);
  orderInFlight(autopilot, "magma-1");
  const step = gate<[]>();
  let steps = 0;
  (autopilot.magma as unknown as { advance: () => Promise<unknown[]> }).advance = () => {
    steps++;
    return step.promise;
  };
  await autopilot.magma.tick(); // its step on magma-1 never answers: given up
  assert.equal(steps, 1);
  await autopilot.magma.tick();
  assert.equal(steps, 1, "the order's steps stay one at a time");
  const lane = autopilot.magma.laneStatus();
  assert.equal(lane.running, false);
  assert.match(lane.error ?? "", /^1 order waits on a step LND or Amboss hasn't answered \(magma-1\) — left for a later pass/);
  step.answer([]);
});

test("the offer price check is given up at its deadline: the next check runs, and the given-up one writes nothing when its read answers late", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot } = sellerSetup(t);
  const guts = autopilot as unknown as {
    state: { offerSync: unknown };
    guarding: boolean;
    offerGuardAt: number;
    guardOfferPrices: () => Promise<void>;
    guardOfferPrice: (key: string, id: string) => Promise<void>;
    stopWhy: (k: string) => string | null;
  };
  guts.state.offerSync = { at: new Date().toISOString(), offers: ["o1", "o2"].map((offerId) => ({ offerId, inSync: true, amboss: { status: "ENABLED" } })) };
  const seen: string[] = [];
  const blocked: (string | null)[] = [];
  const read = gate<void>();
  guts.guardOfferPrice = async (_key, id) => {
    seen.push(id);
    if (seen.length > 1) return;
    await read.promise;
    blocked.push(guts.stopWhy("sellEnabled")); // what its write asks first
  };
  await guts.guardOfferPrices(); // o1's read never answers
  assert.deepEqual(seen, ["o1"]);
  assert.equal(guts.guarding, false, "free for the next check");
  guts.offerGuardAt = 0;
  await guts.guardOfferPrices();
  assert.deepEqual(seen, ["o1", "o1", "o2"]);
  read.answer();
  await sleep(10);
  assert.deepEqual(blocked, ["the offer price check was given up (it did not finish in time)"]);
  assert.deepEqual(seen, ["o1", "o1", "o2"], "the given-up check reads no further offer");
});

test("the purchase follow-up is given up at its deadline: the next one runs, and an answer that comes late is not recorded", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const { autopilot } = autopilotWith(t, {});
  const recorded: string[] = [];
  const guts = autopilot as unknown as {
    purchases: unknown;
    purchasePaymentReport: (hash: string) => Promise<unknown>;
    followingPurchases: boolean;
  };
  guts.purchases = {
    followUps: () => ({ payments: [{ orderId: "p1", paymentHash: "aa".repeat(32) }], orders: [] }),
    paymentOutcome: (orderId: string) => void recorded.push(orderId),
  };
  const late = gate<unknown>();
  let asked = 0;
  guts.purchasePaymentReport = () => (++asked === 1 ? late.promise : Promise.resolve({ status: "in_flight" }));
  await autopilot.followPurchases();
  assert.equal(guts.followingPurchases, false, "free for the next one");
  await autopilot.followPurchases();
  assert.deepEqual([asked, recorded], [2, ["p1"]]);
  late.answer({ status: "succeeded", feeSats: 1, at: new Date().toISOString() });
  await sleep(10);
  assert.deepEqual(recorded, ["p1"], "the late answer is not recorded");
});

test("the in-flight refill check is given up at its deadline: the next one books the payment — and the late answer never books it twice", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const id = "ab".repeat(32);
  const pending = { id, targetId: "800005x1x0", alias: "x", amountSats: 100_000, maxFeeSats: 40, day: new Date().toISOString().slice(0, 10), at: new Date().toISOString() };
  const { autopilot, dir } = autopilotWith(t, {}, { pendingRebalances: [pending] });
  const late = gate<{ state: "confirmed"; feeSats: number }>();
  let asked = 0;
  (autopilot as unknown as { rebalancePaymentStatus: () => Promise<unknown> }).rebalancePaymentStatus = () =>
    ++asked === 1 ? late.promise : Promise.resolve({ state: "confirmed", feeSats: 12 });
  await autopilot.checkInFlightRebalances(); // never answers: given up
  await autopilot.checkInFlightRebalances(); // books it
  late.answer({ state: "confirmed", feeSats: 12 });
  await sleep(20);
  const log = JSON.parse(readFileSync(join(dir, "rebalances.json"), "utf8")) as { paymentId?: string }[] | { records: { paymentId?: string }[] };
  const records = Array.isArray(log) ? log : log.records;
  assert.equal(records.filter((r) => r.paymentId === id).length, 1, "booked once");
  assert.deepEqual((autopilot as unknown as { state: { pendingRebalances?: unknown[] } }).state.pendingRebalances ?? [], []);
});
