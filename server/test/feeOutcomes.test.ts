/**
 * Fee outcomes and the elasticity learner (D15; review a1/a5, package P2).
 *
 * Before: both read the run history — 50 runs shared with rebalances, channel
 * opens, Magma and max_htlc, of which Analytics saw only the newest 20 — and
 * a change counted only with no other change on the channel within ±7 days
 * (that only the truncated list could see). On a small node nothing was ever
 * measured, what was "clean" often wasn't, the headline was an unweighted
 * mean of ratios (1 → 20 sat a week = +1900 %), per-day sums were rounded to
 * whole sats, and the learner moved fees on two noisy samples.
 *
 * Now every applied fee change is kept in its own log for a year; a change is
 * measured until the next change on its channel (≥ 3 days a side, ≤ 14), in
 * msat; the headline is revenue-weighted over at least 5 changes; and the
 * learner needs 4 consistent, significant samples with 10 forwards a side.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEARN_MIN_SAMPLES,
  feeElasticityFromOutcomes,
  measureFeeChanges,
  type FeeOutcome,
} from "../src/services/outcomes.js";
import type { ForwardEvent } from "../src/services/forwards.js";
import { FEE_LOG_KEEP_DAYS, FEE_LOG_MAX_RECORDS, FeeChangeLog, type FeeChangeRecord } from "../src/services/feeChangeLog.js";
import { Autopilot, type AutopilotRun } from "../src/services/autopilot.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { feeNode, type FakeForward } from "./helpers/feeNode.js";
import { suppressSchedulerKicks } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir } from "./helpers/tmp.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const change = (channelId: string, daysAgo: number, fromPpm: number, toPpm: number, o: Partial<FeeChangeRecord> = {}): FeeChangeRecord => ({
  at: iso(NOW - daysAgo * DAY),
  channelId,
  alias: channelId,
  fromPpm,
  toPpm,
  fromBaseMsat: 0,
  toBaseMsat: 0,
  via: "autopilot",
  ...o,
});

/** `perDay` forwards a day out of `out` between two times (ms), each earning `feeMsat`. */
function forwards(out: string, fromMs: number, toMs: number, perDay: number, feeMsat: number): ForwardEvent[] {
  const n = Math.round(((toMs - fromMs) / DAY) * perDay);
  return Array.from({ length: n }, (_, i) => ({
    createdAt: iso(fromMs + ((i + 0.5) / n) * (toMs - fromMs)),
    incomingChannel: "other",
    outgoingChannel: out,
    tokens: 100_000,
    fee: Math.round(feeMsat / 1000),
    feeMsat,
  }));
}

test("a change is measured until the next change on its channel — three changes 4–6 days apart are all measured (the ±7-day vacuum measured none)", () => {
  const changes = [change("A", 20, 100, 120), change("A", 16, 120, 140), change("A", 10, 140, 160)];
  const events = forwards("A", NOW - 40 * DAY, NOW, 4, 5_000);
  const f = measureFeeChanges(changes, events, NOW);
  assert.equal(f.measured, 3);
  const [c3, c2, c1] = f.items; // newest first
  assert.deepEqual([c1.beforeDays, c1.afterDays], [14, 4]);
  assert.deepEqual([c2.beforeDays, c2.afterDays], [4, 6]);
  assert.deepEqual([c3.beforeDays, c3.afterDays], [6, 10]);
  assert.equal(c1.forwardsBefore, 56);
  assert.equal(c1.forwardsAfter, 16);
});

test("too recent, or another change too close: not measured — and counted as such", () => {
  const f = measureFeeChanges([change("A", 1, 100, 120), change("B", 10, 100, 120), change("B", 9.5, 120, 140)], [], NOW);
  assert.equal(f.measured, 0);
  assert.equal(f.pending, 1, "A: a day old");
  assert.equal(f.tooClose, 2, "B: 12 hours apart, neither has 3 days on the shared side");
});

test("revenue is summed in msat: a channel earning 0.3 sat a forward is not 'nothing' (per-day sums were rounded to whole sats)", () => {
  const events = [...forwards("A", NOW - 24 * DAY, NOW - 10 * DAY, 3, 300), ...forwards("A", NOW - 10 * DAY, NOW, 3, 600)];
  const [item] = measureFeeChanges([change("A", 10, 100, 200)], events, NOW).items;
  assert.equal(item.beforeDailyAvgSat, 0.9);
  assert.equal(item.afterDailyAvgSat, 1.8);
  assert.equal(item.deltaPct, 1);
});

test("the headline is revenue-weighted, needs 5 changes that earned something before, and says what it rests on — one 1 → 20 sat/week channel no longer reads +1900 %", () => {
  const events: ForwardEvent[] = [];
  const changes: FeeChangeRecord[] = [];
  // A big channel whose fee never changed: the rest of the node, flat — so
  // the market adjustment leaves the changed channels' own moves visible.
  events.push(...forwards("M", NOW - 30 * DAY, NOW, 20, 5_000_000));
  // Four channels earning 2,000 sat a week, each 10% down after its change.
  for (const id of ["A", "B", "C", "D"]) {
    events.push(...forwards(id, NOW - 30 * DAY, NOW - 15 * DAY, 10, 28_572), ...forwards(id, NOW - 15 * DAY, NOW, 10, 25_715));
    changes.push(change(id, 15, 100, 130));
  }
  // One channel that went from ~1 to ~20 sat a week (below the 50 sat/week bar before).
  events.push(...forwards("E", NOW - 30 * DAY, NOW - 15 * DAY, 1, 143), ...forwards("E", NOW - 15 * DAY, NOW, 1, 2_857));
  changes.push(change("E", 15, 100, 50));
  const four = measureFeeChanges(changes, events, NOW);
  assert.equal(four.measured, 5);
  assert.equal(four.measurable, 4, "E earned under 50 sat a week before: not counted");
  assert.equal(four.avgRevenueDeltaPct, null, "4 < 5: no number");
  assert.match(four.note, /4 of 5 measured changes had enough revenue before to judge .* at least 5 are needed/);
  assert.equal(four.items.find((i) => i.channelId === "E")?.measurable, false);
  // A fifth real one: a number — weighted by revenue: about −10 %.
  events.push(...forwards("F", NOW - 30 * DAY, NOW - 15 * DAY, 10, 28_572), ...forwards("F", NOW - 15 * DAY, NOW, 10, 25_715));
  changes.push(change("F", 15, 100, 130));
  const five = measureFeeChanges(changes, events, NOW);
  assert.equal(five.measurable, 5);
  assert.ok(five.avgRevenueDeltaPct !== null && Math.abs(five.avgRevenueDeltaPct - -0.1) < 0.02, String(five.avgRevenueDeltaPct));
  assert.equal(five.confidence, "low");
});

test("a change is measured net of the rest of the node: when every channel's revenue doubles at the same time, the change itself gets no credit — each item and the headline", () => {
  const events: ForwardEvent[] = [];
  const changes: FeeChangeRecord[] = [];
  // The rest of the node (M, never changed) doubles its revenue too.
  events.push(...forwards("M", NOW - 30 * DAY, NOW - 15 * DAY, 20, 50_000), ...forwards("M", NOW - 15 * DAY, NOW, 20, 100_000));
  for (const id of ["A", "B", "C", "D", "E"]) {
    events.push(...forwards(id, NOW - 30 * DAY, NOW - 15 * DAY, 10, 20_000), ...forwards(id, NOW - 15 * DAY, NOW, 10, 40_000));
    changes.push(change(id, 15, 100, 130));
  }
  const f = measureFeeChanges(changes, events, NOW);
  assert.equal(f.measurable, 5);
  // Unadjusted, each would read +100 %.
  for (const item of f.items) assert.ok(Math.abs(item.deltaPct ?? 1) < 0.02, `${item.channelId}: ${item.deltaPct}`);
  assert.ok(f.avgRevenueDeltaPct !== null && Math.abs(f.avgRevenueDeltaPct) < 0.02, String(f.avgRevenueDeltaPct));
});

// ── the learner ─────────────────────────────────────────────────────────────

const sample = (channelId: string, raised: boolean, deltaPct: number, fwd = 20): FeeOutcome => ({
  channelId,
  alias: channelId,
  at: iso(NOW),
  fromPpm: 100,
  toPpm: raised ? 120 : 80,
  raised,
  via: "autopilot",
  beforeDays: 14,
  afterDays: 14,
  beforeDailyAvgSat: 10,
  afterDailyAvgSat: 10 * (1 + deltaPct),
  forwardsBefore: fwd,
  forwardsAfter: fwd,
  deltaPct,
  measurable: true,
});

test("the learner needs 4 samples that agree, each with 10 forwards a side — 2 noisy samples no longer move a fee", () => {
  assert.equal(feeElasticityFromOutcomes([sample("A", true, 0.4), sample("A", true, 0.3)]).size, 0, "2 samples: nothing");
  const four = feeElasticityFromOutcomes([0.4, 0.3, 0.35, 0.5].map((d) => sample("A", true, d)));
  assert.ok((four.get("A")?.modifier ?? 1) > 1, JSON.stringify([...four]));
  assert.equal(four.get("A")?.samples, LEARN_MIN_SAMPLES);
  assert.equal(feeElasticityFromOutcomes([0.4, -0.3, 0.35, 0.5].map((d) => sample("A", true, d))).size, 0, "they disagree: nothing");
  // A strong mean (well past two standard errors) with one sample the other
  // way is still not consistent evidence.
  assert.equal(feeElasticityFromOutcomes([0.9, 0.8, 0.85, -0.05].map((d) => sample("A", true, d))).size, 0, "one disagrees: nothing");
  assert.equal(feeElasticityFromOutcomes([0.4, 0.3, 0.35, 0.5].map((d) => sample("A", true, d, 9))).size, 0, "9 forwards a side: not samples");
  // A cut that lifted revenue says "we were too high": below 1.
  assert.ok((feeElasticityFromOutcomes([0.4, 0.3, 0.35, 0.5].map((d) => sample("A", false, d))).get("A")?.modifier ?? 1) < 1);
});

test("with no true effect, the learner almost never moves a fee (noise gave the old one a modifier of 10% or more on 7 in 10 channels)", () => {
  // A seeded normal noise: revenue responses with zero mean.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const normal = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
  const items: FeeOutcome[] = [];
  const channels = 500;
  for (let c = 0; c < channels; c++) {
    for (let k = 0; k < 4 + (c % 3); k++) items.push(sample(`C${c}`, rand() < 0.5, Math.max(-1, 0.35 * normal()), 20));
  }
  const learned = feeElasticityFromOutcomes(items);
  const moved = [...learned.values()].filter((e) => Math.abs(e.modifier - 1) >= 0.1).length;
  assert.ok(learned.size / channels < 0.12, `${learned.size} of ${channels} channels got a modifier`);
  assert.ok(moved / channels < 0.05, `${moved} of ${channels} by 10% or more`);
});

// ── the fee-change log: the learner's and Analytics' source ─────────────────

test("upgrading: the fee changes still in the run history move into the new log once (failed ones not)", (t) => {
  const dir = makeTempDir(t);
  const run = (at: string, changes: AutopilotRun["changes"]): AutopilotRun => ({ at, attempted: changes.length, applied: 0, failed: 0, changes, rebalances: [], channels: [], sells: [] });
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({
      config: {},
      sellAutoSizeMigrated: true,
      history: [
        run(iso(NOW - DAY), [{ id: "850000x1x0", alias: "a", fromPpm: 300, toPpm: 270, ok: true }]),
        run(iso(NOW - 2 * DAY), [
          { id: "850000x2x0", alias: "b", fromPpm: 100, toPpm: 120, ok: true },
          { id: "850000x3x0", alias: "c", fromPpm: 100, toPpm: 120, ok: false, error: "refused" },
        ]),
      ],
    }),
  );
  const make = () => {
    const ap = new Autopilot(dir, feeNode({ channels: [] }).lnd, undefined, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
    suppressSchedulerKicks(ap);
    t.after(() => ap.shutdown());
    return ap;
  };
  const first = make();
  assert.deepEqual(first.feeChanges().map((c) => [c.channelId, c.fromPpm, c.toPpm]), [["850000x1x0", 300, 270], ["850000x2x0", 100, 120]]);
  const second = make();
  assert.equal(second.feeChanges().length, 2, "imported once");
  assert.ok(JSON.parse(readFileSync(join(dir, "fee-changes.json"), "utf8")).length === 2);
});

test("GET /autopilot/outcomes measures from the fee-change log — 60 deferral and skip runs that flushed the run history change nothing", async (t) => {
  const ten = Date.now() - 10 * DAY;
  const fw: FakeForward[] = [];
  for (let d = 0; d < 24; d++) {
    for (let k = 0; k < 3; k++) {
      // (Half an hour off the change: LND reports forwards to the second.)
      const at = Date.now() - (24 - d) * DAY + k * 3_600_000 + 1_800_000;
      fw.push({ at, inId: "850000x2x0", outId: "850000x1x0", tokens: 100_000, feeMsat: at < ten ? 20_000 : 30_000 });
    }
  }
  const node = feeNode({
    channels: [
      { id: "850000x1x0", partnerPublicKey: "02" + "11".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "11".repeat(32), transactionVout: 0 },
      { id: "850000x2x0", partnerPublicKey: "02" + "22".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "22".repeat(32), transactionVout: 0 },
    ],
    forwards: fw,
  });
  const api = await startApi(t, { node });
  api.autopilot.feeLog.append([{ ...change("850000x1x0", 0, 100, 150), at: iso(ten) }]);
  // The run history fills with things that are not fee changes.
  const history = (api.autopilot as unknown as { state: { history: AutopilotRun[] } }).state.history;
  for (let i = 0; i < 60; i++) {
    history.unshift({ at: iso(Date.now() - i * 60_000), attempted: 1, applied: 0, failed: 1, changes: [], rebalances: [], channels: [{ alias: "x", sizeSats: 1, ok: false, error: "deferred: on-chain fees too high" }], sells: [] });
  }
  const res = await api.request("GET", "/autopilot/outcomes");
  assert.equal(res.status, 200);
  assert.equal(res.body.fees.measured, 1);
  const [item] = res.body.fees.items;
  assert.equal(item.channelId, "850000x1x0");
  assert.ok(Math.abs(item.deltaPct - 0.5) < 0.05, `+50%: ${item.deltaPct} ${JSON.stringify(item)}`);
  assert.deepEqual([item.forwardsBefore, item.forwardsAfter], [42, 30]);
});

test("the learner reads the fee-change log: four raises that each lifted revenue give the channel a modifier (the run history never had them)", async (t) => {
  // Five 14-day intervals; revenue per forward grows after each raise; 12
  // forwards per interval — every change has 10+ forwards a side.
  const start = Date.now() - 70 * DAY;
  const fw: FakeForward[] = [];
  for (let i = 0; i < 5; i++) {
    for (let k = 0; k < 12; k++) {
      fw.push({ at: start + i * 14 * DAY + (k + 0.5) * (14 / 12) * DAY, inId: "850000x2x0", outId: "850000x1x0", tokens: 100_000, feeMsat: 10_000 * (i + 1) });
    }
  }
  const node = feeNode({
    channels: [
      { id: "850000x1x0", partnerPublicKey: "02" + "11".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "11".repeat(32), transactionVout: 0 },
      { id: "850000x2x0", partnerPublicKey: "02" + "22".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "22".repeat(32), transactionVout: 0 },
    ],
    forwards: fw,
  });
  const dir = makeTempDir(t);
  const log = new FeeChangeLog(dir);
  log.append(
    [1, 2, 3, 4].map((i) => ({
      at: iso(start + i * 14 * DAY),
      channelId: "850000x1x0",
      alias: "a",
      fromPpm: 100 + i * 20,
      toPpm: 120 + i * 20,
      fromBaseMsat: 0,
      toBaseMsat: 0,
      via: "autopilot" as const,
    })),
  );
  const ap = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(ap);
  t.after(() => ap.shutdown());
  const mods = await ap.feeElasticityModifiers();
  assert.ok((mods.get("850000x1x0") ?? 1) > 1, JSON.stringify([...mods]));
});

// ── review 2: the log's and the measurement's own guards ────────────────────

test("a base-fee-only change is no fee move to measure — no item, nothing for the learner — but it still ends the interval of the change before it", () => {
  const changes = [
    change("A", 20, 100, 120),
    // Twelve days ago only the base fee changed (1 sat → 0).
    change("A", 12, 120, 120, { fromBaseMsat: 1000, toBaseMsat: 0 }),
  ];
  const f = measureFeeChanges(changes, forwards("A", NOW - 40 * DAY, NOW, 4, 5_000), NOW);
  assert.deepEqual(f.items.map((i) => [i.fromPpm, i.toPpm]), [[100, 120]], "measured as a 'cut' 120 → 120 before");
  // Measured up to the base-fee write, not 14 days on: revenue after it is
  // that write's effect too.
  assert.equal(f.items[0].afterDays, 8);
  assert.equal(f.measured, 1);
});

test("the fee-change log keeps FEE_LOG_KEEP_DAYS: older records are dropped on append and on the upgrade import", (t) => {
  const old = change("A", FEE_LOG_KEEP_DAYS + 5, 100, 120, { at: iso(Date.now() - (FEE_LOG_KEEP_DAYS + 5) * DAY) });
  const recent = change("A", 3, 120, 140, { at: iso(Date.now() - 3 * DAY) });
  const dir = makeTempDir(t);
  const log = new FeeChangeLog(dir);
  log.append([old, recent]);
  assert.deepEqual(log.all().map((r) => r.toPpm), [140]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "fee-changes.json"), "utf8")).map((r: FeeChangeRecord) => r.toPpm), [140], "on disk too");
  const seeded = new FeeChangeLog(makeTempDir(t));
  seeded.seed([old, recent]);
  assert.deepEqual(seeded.all().map((r) => r.toPpm), [140]);
});

test("the upgrade import runs once: a log that exists — even an empty one — is never filled again from the run history", (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "fee-changes.json"), "[]");
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({
      config: {},
      sellAutoSizeMigrated: true,
      history: [{ at: iso(Date.now() - DAY), attempted: 1, applied: 1, failed: 0, changes: [{ id: "850000x1x0", alias: "a", fromPpm: 300, toPpm: 270, ok: true }], rebalances: [], channels: [], sells: [] }],
    }),
  );
  const ap = new Autopilot(dir, feeNode({ channels: [] }).lnd, undefined, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(ap);
  t.after(() => ap.shutdown());
  assert.deepEqual(ap.feeChanges(), []);
});

// ── review 3: the learner's and the log's remaining guards ──────────────────

test("the significance gate: four raises that all lifted revenue — one by far the most — are no evidence while their mean is under two standard errors", () => {
  // Mean 0.26, standard error 0.21: one lucky week and three flat ones.
  assert.equal(feeElasticityFromOutcomes([0.9, 0.05, 0.05, 0.05].map((d) => sample("A", true, d))).size, 0);
  // Four that agree closely clear it (the same mean, a small error).
  assert.ok((feeElasticityFromOutcomes([0.3, 0.25, 0.25, 0.25].map((d) => sample("A", true, d))).get("A")?.modifier ?? 1) > 1);
});

test("a channel's own signal is shrunk toward the node-wide one: with 8 samples elsewhere saying the opposite, its modifier is closer to 1", () => {
  const own = [0.4, 0.3, 0.35, 0.5].map((d) => sample("A", true, d));
  const alone = feeElasticityFromOutcomes(own).get("A")?.modifier ?? 1;
  assert.equal(alone, 1.1);
  // Eight raises on two other channels that each lost 60 % of the revenue.
  const elsewhere = Array.from({ length: 8 }, (_, i) => sample(`B${i % 2}`, true, -0.6));
  const pooled = feeElasticityFromOutcomes([...own, ...elsewhere]).get("A")?.modifier ?? 1;
  assert.ok(pooled > 1 && pooled < alone, `${pooled} (alone ${alone})`);
  // Fewer than 8 samples on the node: no node-wide signal to shrink toward.
  assert.equal(feeElasticityFromOutcomes([...own, ...elsewhere.slice(0, 3)]).get("A")?.modifier, alone);
});

test("the fee-change log keeps at most FEE_LOG_MAX_RECORDS records — the newest", (t) => {
  const log = new FeeChangeLog(makeTempDir(t));
  const n = FEE_LOG_MAX_RECORDS + 5;
  const start = Date.now() - 10 * DAY;
  // Oldest first, as the autopilot appends them.
  log.append(Array.from({ length: n }, (_, i) => change("A", 0, i, i + 1, { at: iso(start + i * 60_000) })));
  const kept = log.all();
  assert.equal(kept.length, FEE_LOG_MAX_RECORDS);
  assert.equal(kept[0].toPpm, n, "the newest first");
  assert.equal(kept.at(-1)?.toPpm, 6, "the five oldest dropped");
});
