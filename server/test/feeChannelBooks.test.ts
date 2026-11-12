/**
 * The autopilot's books for the fee engine and the channel stage (final
 * review 2026-10-25, package E):
 *  - the step-back's clocks (since when each channel has had sats to sell)
 *    and its memory (the fee it stepped back from, a week), kept by the fee
 *    stage and handed to the engine;
 *  - a fee set by hand while LND's fees can't be read: its "from" unknown
 *    (null), never 0 — which read as a raise from 0;
 *  - the fee retry back-off pruned (closed channels, a week past its time);
 *  - the open fee rate, the open's write-ahead record (saved, or no open),
 *    an open this process still waits on (not "cut off by a restart"), and
 *    the close list's swap line (ranked at most every 30 minutes).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  FEE_RETRY_KEEP_MS,
  SWAP_SUGGESTIONS_KEEP_MS,
  WORK_DEADLINES_MS,
  nextStepBack,
  sanitizeFeeRetry,
  sanitizeStepBacks,
} from "../src/services/autopilot.js";
import { stepBackMemoryDays } from "../src/services/feeRecommend.js";
import { LANE_PASS_DEADLINE } from "../src/services/magmaDesk.js";
import { FeeChangeLog } from "../src/services/feeChangeLog.js";
import { openFeeRateOf } from "../src/services/openPlan.js";
import type { FeeRecommendation } from "../src/services/feeRecommend.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { GOSSIP_PEER, autopilotAt, autopilotWith, plannedFeeChange, suggestion } from "./helpers/autopilot.js";
import { quiet, keepFileAlive } from "./helpers/lifecycle.js";

// Deadlines in these tests fire on timers nothing else keeps alive (see keepFileAlive).
keepFileAlive();

const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FeeBooks {
  feeSellableSince?: Record<string, string>;
  feeSellableCheckedAt?: string | null;
  feeStepBacks?: Record<string, { fromPpm: number; toPpm?: number; count?: number; at: string }>;
  feeProbeBacks?: Record<string, { fromPpm: number; toPpm?: number; count?: number; at: string }>;
  perChannelFeeRetry?: Record<string, { until: string; error: string }>;
  channelOpening?: { at: string } | null;
  lastChannelOpenAt: string | null;
  lastChannelOpenUnclear?: string | null;
}
const books = (a: unknown) => a as { state: FeeBooks; noteFeeChannels(recs: readonly unknown[]): void };

test("A1: the fee stage keeps since when each channel has had sats to sell — drained, its clock starts again when the liquidity is back; looks too far apart start every clock again; closed channels drop out of the clocks and the retry back-off", (t) => {
  const { autopilot } = autopilotWith(t, {});
  const ap = books(autopilot);
  const rec = (id: string, localRatio: number) => ({ channelId: id, capacity: 2_000_000, metrics: { localRatio } });
  const since = () => autopilot.feeCooldown().sellableSince ?? {};
  ap.noteFeeChannels([rec("800001x1x0", 0.5), rec("800002x1x0", 0.01)]);
  assert.ok(since()["800001x1x0"], "sats to sell: a clock");
  assert.equal(since()["800002x1x0"], undefined, "at its reserve: none");
  // An earlier look's clock stays; the other channel's starts now.
  const old = new Date(Date.now() - 50 * HOUR).toISOString();
  ap.state.feeSellableSince = { "800001x1x0": old };
  ap.noteFeeChannels([rec("800001x1x0", 0.5), rec("800002x1x0", 0.4)]);
  assert.equal(since()["800001x1x0"], old);
  assert.ok(Date.now() - Date.parse(since()["800002x1x0"] ?? "") < 60_000);
  // Drained: its clock goes.
  ap.noteFeeChannels([rec("800001x1x0", 0.01), rec("800002x1x0", 0.4)]);
  assert.equal(since()["800001x1x0"], undefined);
  // Two looks two days apart (fee automation off in between): no clock
  // counts, and the next look starts them again.
  ap.state.feeSellableSince = { "800002x1x0": old };
  ap.state.feeSellableCheckedAt = new Date(Date.now() - 48 * HOUR).toISOString();
  assert.deepEqual(autopilot.feeCooldown().sellableSince, {});
  ap.noteFeeChannels([rec("800002x1x0", 0.4)]);
  assert.ok(Date.now() - Date.parse(since()["800002x1x0"] ?? "") < 60_000, "started again");
  // The fee retry back-off: a closed channel's entry goes…
  ap.state.perChannelFeeRetry = {
    "800002x1x0": { until: new Date(Date.now() + HOUR).toISOString(), error: "refused" },
    "800009x1x0": { until: new Date(Date.now() + HOUR).toISOString(), error: "refused" },
  };
  ap.noteFeeChannels([rec("800002x1x0", 0.4)]);
  assert.deepEqual(Object.keys(ap.state.perChannelFeeRetry ?? {}), ["800002x1x0"]);
  // …and one a week past its time (also on load).
  const now = Date.now();
  const retry = { a: { until: new Date(now - FEE_RETRY_KEEP_MS - 1).toISOString(), error: "x" }, b: { until: new Date(now - HOUR).toISOString(), error: "x" } };
  assert.deepEqual(Object.keys(sanitizeFeeRetry(retry, now)), ["b"]);
});

test("A3: a step-back LND took is remembered — the fee it left and the fee it went back to, on disk, read back by a restart, handed to the fee engine; a lowering that is no step-back, or a damaged or eight-week-old record, is not", async (t) => {
  const { autopilot, seams, dir, node } = autopilotWith(t, { enabled: true });
  const rec = (id: string, from: number, to: number, stepBack: boolean) =>
    ({ ...plannedFeeChange(id, from, to), ...(stepBack ? { stepBack } : {}), capacity: 2_000_000, metrics: { routedOut14d: 0, localRatio: 0.3 } }) as unknown as FeeRecommendation;
  seams.feeReport = async () => ({ recommendations: [rec("800001x1x0", 820, 660, true), rec("800002x1x0", 500, 470, false)] });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm }));
  await autopilot.runOnce();
  assert.deepEqual(Object.keys(autopilot.feeCooldown().stepBacks ?? {}), ["800001x1x0"]);
  assert.equal(autopilot.feeCooldown().stepBacks?.["800001x1x0"]?.fromPpm, 820);
  assert.equal(autopilot.feeCooldown().stepBacks?.["800001x1x0"]?.toPpm, 660);
  assert.equal(autopilot.feeCooldown().stepBacks?.["800001x1x0"]?.count, 1);
  // The same price fails again (the fee was raised to 700 and stepped back to
  // 660 once more): a repeat — the engine's memory grows with the count.
  seams.feeReport = async () => ({ recommendations: [rec("800001x1x0", 700, 660, true)] });
  await autopilot.runOnce();
  assert.deepEqual(
    [autopilot.feeCooldown().stepBacks?.["800001x1x0"]?.fromPpm, autopilot.feeCooldown().stepBacks?.["800001x1x0"]?.count],
    [700, 2],
  );
  const again = autopilotAt(t, dir, node).autopilot;
  assert.equal(again.feeCooldown().stepBacks?.["800001x1x0"]?.count, 2, "a restart reads the count back");
  again.stop();
  // A step-back that ends higher than the last one is a new price, not a repeat.
  assert.equal(nextStepBack({ fromPpm: 700, toPpm: 660, at: "x", count: 2 }, 760, 700, "y").count, 1);
  assert.equal(nextStepBack({ fromPpm: 700, toPpm: 660, at: "x", count: 3 }, 690, 650, "y").count, 3, "at most three");
  assert.equal(nextStepBack({ fromPpm: 700, at: "x" }, 690, 650, "y").count, 1, "a record without its 'to' (written before it was kept) starts the count");
  assert.equal(nextStepBack({ fromPpm: 360, toPpm: 330, at: "x", count: 1 }, 110, 100, "y").count, 1, "a failure far below the last one is the first there, not the second in a row");
  assert.deepEqual([1, 2, 3, 9, undefined].map(stepBackMemoryDays), [7, 14, 28, 28, 7]);
  const reread = autopilotAt(t, dir, node).autopilot;
  assert.equal(reread.feeCooldown().stepBacks?.["800001x1x0"]?.fromPpm, 700, "a restart reads it back");
  const now = Date.now();
  const recent = new Date(now - HOUR).toISOString();
  assert.deepEqual(
    sanitizeStepBacks(
      {
        a: { fromPpm: "820", at: recent },
        b: { fromPpm: 820, at: "never" },
        c: { fromPpm: 820, at: new Date(now - 56 * 24 * HOUR - 1).toISOString() },
        d: { fromPpm: 820, at: recent },
        // (Kept past its week: the next step-back is told a repeat by it.)
        e: { fromPpm: 820, toPpm: 660, count: 2, at: new Date(now - 30 * 24 * HOUR).toISOString() },
        // A "to" at or above the "from", or a count that is no whole number, is dropped — the record stays.
        f: { fromPpm: 820, toPpm: 900, count: 1.5, at: recent },
      },
      now,
    ),
    {
      d: { fromPpm: 820, at: recent },
      e: { fromPpm: 820, toPpm: 660, count: 2, at: new Date(now - 30 * 24 * HOUR).toISOString() },
      f: { fromPpm: 820, at: recent },
    },
  );
});

test("a price test LND took back is remembered apart from a step-back a rule made — it bounds the next test only — and is counted, saved and dropped with its channel like the other (review 2026-11-10, FEE-2)", async (t) => {
  const { autopilot, seams, dir, node } = autopilotWith(t, { enabled: true });
  const rec = (id: string, from: number, to: number, probeBack: boolean) =>
    ({ ...plannedFeeChange(id, from, to), stepBack: true, ...(probeBack ? { probeBack } : {}), capacity: 2_000_000, metrics: { routedOut14d: 0, localRatio: 0.5 } }) as unknown as FeeRecommendation;
  seams.feeReport = async () => ({ recommendations: [rec("800001x1x0", 330, 300, true), rec("800002x1x0", 500, 470, false)] });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm }));
  await autopilot.runOnce();
  const tests = () => autopilot.feeCooldown().probeBacks ?? {};
  assert.deepEqual(Object.keys(tests()), ["800001x1x0"]);
  assert.deepEqual([tests()["800001x1x0"]?.fromPpm, tests()["800001x1x0"]?.toPpm, tests()["800001x1x0"]?.count], [330, 300, 1]);
  assert.deepEqual(Object.keys(autopilot.feeCooldown().stepBacks ?? {}), ["800002x1x0"], "the rule's step-back is in the other book");
  // The same test fails again: a repeat, remembered twice as long.
  seams.feeReport = async () => ({ recommendations: [rec("800001x1x0", 330, 300, true)] });
  await autopilot.runOnce();
  assert.equal(tests()["800001x1x0"]?.count, 2);
  assert.equal(autopilot.feeCooldown().stepBacks?.["800001x1x0"], undefined);
  // A restart reads it back; a record that is damaged is dropped.
  const again = autopilotAt(t, dir, node).autopilot;
  assert.equal(again.feeCooldown().probeBacks?.["800001x1x0"]?.count, 2);
  books(again).state.feeProbeBacks = { "800001x1x0": { fromPpm: 330, toPpm: 300, count: 2, at: "never" } };
  assert.deepEqual(again.feeCooldown().probeBacks, {});
  again.stop();
  // Its channel closed: the record goes with it.
  seams.feeReport = async () => ({ recommendations: [rec("800003x1x0", 500, 470, false)] });
  await autopilot.runOnce();
  assert.deepEqual(Object.keys(tests()), []);
});

test("A4: a fee set by hand while LND's fees can't be read is on record with its 'from' unknown — null, never 0 — and the log reads such a record back", async (t) => {
  const node = new FakeLnd({
    chainBalance: 20_000_000,
    peers: [GOSSIP_PEER],
    channels: [{ id: "800001x1x0", partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "a1".repeat(32), transactionVout: 0 }],
  });
  node.override("default.feeReport", (_a, cb) => cb({ details: "unavailable" }));
  const { autopilot, seams, dir } = autopilotWith(t, {}, {}, {}, node);
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm }));
  const res = await autopilot.applyByHand([{ id: "800001x1x0", transactionId: "a1".repeat(32), transactionVout: 0, feeRatePpm: 600, baseFeeMsat: 0 }]);
  assert.equal(res?.results[0]?.ok, true);
  const [rec] = autopilot.feeChanges();
  assert.deepEqual([rec?.fromPpm, rec?.toPpm, rec?.via], [null, 600, "manual"]);
  assert.equal(new FeeChangeLog(dir).all()[0]?.fromPpm, null, "read back from disk");
});

test("N8: an automatic open pays LND's estimate rounded up only past a tenth over a whole rate — 1.012 → 1, 1.1 → 1, 1.4 → 2, 2.05 → 2 — at least 1", () => {
  assert.deepEqual([1.012, 1.1, 1.4, 2.05, 2.11, 0.3, 25].map(openFeeRateOf), [1, 1, 2, 2, 3, 1, 25]);
});

/** A channel stage ready to open to `suggestion` (1M, no cooldown). */
function opener(t: TestContext) {
  const env = autopilotWith(t, { channelEnabled: true, channelCooldownMinutes: 0, channelSizeSats: 1_000_000 });
  env.seams.openFeeRate = async () => 2;
  env.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  env.node.peers.push(suggestion.pubkey);
  env.node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  return env;
}

test("N8: an open whose write-ahead record can't be saved is not sent — the stage is blocked, and says why", async (t) => {
  quiet(t);
  const { autopilot, node } = opener(t);
  const store = (autopilot as unknown as { store: { writeOrThrow: (v: unknown) => void } }).store;
  const real = store.writeOrThrow.bind(store);
  store.writeOrThrow = (v) => {
    if ((v as FeeBooks).channelOpening) throw new Error("ENOSPC: no space left on device");
    real(v);
  };
  await autopilot.runOnce();
  assert.equal(node.callsTo("default.openChannel").length, 0, "before: sent with the record in memory only");
  assert.match(autopilot.getState().decisions.channels?.text ?? "", /couldn't be put on record before it is sent \(ENOSPC/);
  assert.equal(autopilot.getState().status.channels.state, "blocked");
  assert.equal(books(autopilot).state.channelOpening, null);
});

test("an open this process still waits on — its stage given up while LND funds it — is not booked as cut off by a restart: a run meanwhile leaves its record alone and opens nothing; LND's late answer books it", async (t) => {
  quiet(t);
  const saved = { ...WORK_DEADLINES_MS };
  const lane = LANE_PASS_DEADLINE.ms;
  Object.assign(WORK_DEADLINES_MS, { stage: 150, perRefill: 150, feeWork: 150, inflightCheck: 150, laneWork: 150 });
  LANE_PASS_DEADLINE.ms = 150;
  t.after(() => {
    Object.assign(WORK_DEADLINES_MS, saved);
    LANE_PASS_DEADLINE.ms = lane;
  });
  t.mock.method(console, "error", () => undefined);
  const { autopilot, node } = opener(t);
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  node.override("default.openChannel", () => {
    const s = Object.assign(new EventEmitter(), { cancel: () => undefined });
    void released.then(() => s.emit("data", { update: "chan_pending", chan_pending: { txid: Buffer.from("ab".repeat(32), "hex").reverse(), output_index: 0 } }));
    return s;
  });
  const b = books(autopilot).state;
  await autopilot.runOnce();
  assert.ok(b.channelOpening, "on record while LND answers");
  await autopilot.runOnce();
  assert.ok(b.channelOpening, "left alone");
  assert.equal(b.lastChannelOpenUnclear ?? null, null, "before: counted as cut off by a restart");
  assert.match(autopilot.getState().decisions.channels?.text ?? "", /^the open to next-peer \(1,000,000 sat, sent \d\d:\d\d UTC\) is still waiting for LND's answer — no other open until it has one$/);
  assert.equal(node.callsTo("default.openChannel").length, 1);
  release();
  await sleep(50);
  assert.equal(b.channelOpening, null);
  assert.ok(b.lastChannelOpenAt, "the late answer booked the open (its cooldown runs)");
  assert.equal(b.lastChannelOpenUnclear ?? null, null);
});

test("the close list's swap line ranks suggestions at most every 30 minutes — no new LN+ lookups on every load; a ranking that failed is not kept", async (t) => {
  const { autopilot, seams } = autopilotWith(t, {});
  let asked = 0;
  seams.channelSuggestions = async () => {
    asked += 1;
    return { suggestions: [suggestion] };
  };
  assert.equal((await autopilot.swapTargets())[0]?.alias, "next-peer");
  await autopilot.swapTargets();
  assert.equal(asked, 1);
  const cache = autopilot as unknown as { swapSuggestions: { at: number } | null };
  cache.swapSuggestions!.at -= SWAP_SUGGESTIONS_KEEP_MS + 1;
  await autopilot.swapTargets();
  assert.equal(asked, 2, "ranked again after 30 minutes");
  cache.swapSuggestions = null;
  seams.channelSuggestions = async () => {
    asked += 1;
    throw new Error("graph unreadable");
  };
  await assert.rejects(autopilot.swapTargets());
  seams.channelSuggestions = async () => {
    asked += 1;
    return { suggestions: [suggestion] };
  };
  await autopilot.swapTargets();
  assert.equal(asked, 4, "the failed ranking was not kept");
});

test("the close list's Magma room is what the deploy cap leaves after the running leases AND the accepted orders — the offer upkeep's headroom (the panel took the cap less the leases)", (t) => {
  const { autopilot } = autopilotWith(t, { sellMaxDeploySats: 5_000_000 });
  const capital = (autopilot as unknown as { capital: { deployedSat: () => number; reservedSat: () => number } }).capital;
  capital.deployedSat = () => 2_000_000;
  capital.reservedSat = () => 1_500_000;
  assert.equal(autopilot.getState().sellDeployRoomSat, 1_500_000);
  capital.reservedSat = () => 4_000_000;
  assert.equal(autopilot.getState().sellDeployRoomSat, 0);
});
