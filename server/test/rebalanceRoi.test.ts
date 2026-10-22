/**
 * Analytics' "Rebalance ROI" (review a5-analytics:rebalance-roi-overcredit,
 * a2-rebalance:roi-overcredited — package P6).
 *
 * Before: each refill was credited with ALL the fees its target earned in
 * the 14 days after it — not capped at what the refill moved, and refills a
 * day apart each claimed the same days. Two 300-sat refills of a channel
 * earning 100 sat a day read "467% back · 2/2 paid back" while the channel
 * earned 2,000 sat in all.
 *
 * Now the refilled sats are followed out of the channel first in, first out
 * — the measure the profit floor retires refills by (refillLots): each
 * forward out draws on the oldest refill still there, its fee split by the
 * sats it took; LND's sent counter (kept with each refill) shows what left
 * by payments instead, which uses refills up with no fee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { measureRebalances, REFILL_ROI_METHOD, type RebalanceOutcome } from "../src/services/outcomes.js";
import type { ForwardEvent } from "../src/services/forwards.js";
import type { RebalanceRecord } from "../src/services/rebalanceLog.js";
import { feeNode, type FakeForward } from "./helpers/feeNode.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir } from "./helpers/tmp.js";
import { quiet } from "./helpers/lifecycle.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const T = "850000x1x0";
const S = "850001x1x0";

const refill = (daysAgo: number, amountSats: number, feeSats: number, extra: Partial<RebalanceRecord> = {}): RebalanceRecord => ({
  at: at(daysAgo),
  startedAt: at(daysAgo),
  via: "autopilot",
  targetId: T,
  targetAlias: "drained",
  sourceId: S,
  sourceAlias: "donor",
  amountSats,
  budgetPpm: 1000,
  feeSats,
  costPpm: Math.round((feeSats / amountSats) * 1e6),
  ok: true,
  ...extra,
});

/** One forward out of the target a day, `days` days back to (not incl.) now. */
function dailyForwards(fromDaysAgo: number, toDaysAgo: number, tokens: number, feeMsat: number, out = T): ForwardEvent[] {
  const list: ForwardEvent[] = [];
  for (let d = fromDaysAgo; d > toDaysAgo; d--) {
    list.push({ createdAt: at(d - 0.5), incomingChannel: S, outgoingChannel: out, tokens, fee: Math.round(feeMsat / 1000), feeMsat });
  }
  return list;
}

test("the review's example: two 300-sat refills a day apart on a channel earning 100 sat a day no longer read 467% — each is credited only with the forwards that carried its own sats out", () => {
  // 300,000 sat each; the channel routes 30,000 sat a day out at 100 sat fee.
  const records = [refill(20, 300_000, 300), refill(19, 300_000, 300)];
  const events = dailyForwards(20, 0, 30_000, 100_000);
  // A forward before the first refill is no refill's: it carried sats the
  // channel already had.
  const before: ForwardEvent = { createdAt: at(25), incomingChannel: S, outgoingChannel: T, tokens: 30_000, fee: 5_000, feeMsat: 5_000_000 };
  const r = measureRebalances(records, [before, ...events], new Map(), NOW);
  const byDay = Object.fromEntries(r.items.map((i) => [i.at.slice(0, 10), [i.routedOutSats, i.earnedSats, i.remainingSats]]));
  // The first refill's sats leave with the first ten forwards, the second's
  // with the next ten: 1,000 sat each — never the same forward twice.
  assert.deepEqual(byDay[at(20).slice(0, 10)], [300_000, 1_000, 0]);
  assert.deepEqual(byDay[at(19).slice(0, 10)], [300_000, 1_000, 0]);
  const revenueSinceFirst = events.reduce((s, e) => s + e.feeMsat, 0) / 1000; // the forward before the refills not in it
  assert.equal(r.totalEarnedBackSats, 2_000);
  assert.ok(r.totalEarnedBackSats <= revenueSinceFirst, "never more than the channel earned");
  // Before: 1,400 + 1,400 = 2,800 against 600 — "467% back".
  assert.equal(r.avgEarnedBackPct, 333);
  assert.deepEqual([r.paidBackCount, r.measured], [2, 2]);
  assert.equal(r.method, REFILL_ROI_METHOD);
});

test("a refill is credited no more than the sats it moved: a 1M refill of a channel that routed 100k out earns only those forwards' fees — the rest still in the channel", () => {
  const records = [refill(20, 1_000_000, 500)];
  const events = dailyForwards(20, 10, 10_000, 30_000); // 10 × 10,000 sat out, 30 sat each
  const [item] = measureRebalances(records, events, new Map(), NOW).items;
  assert.deepEqual([item.routedOutSats, item.earnedSats, item.remainingSats], [100_000, 300, 900_000]);
  assert.deepEqual([item.paidBack, item.status], [false, "measured"], "judged after 14 days with what it earned by then");
});

test("a forward that spans two refills is split by the sats it took from each", () => {
  const records = [refill(10, 50_000, 10), refill(9, 50_000, 10)];
  // One forward of 80,000 out at 800 sat: 50,000 from the first, 30,000 from the second.
  const events: ForwardEvent[] = [{ createdAt: at(8), incomingChannel: S, outgoingChannel: T, tokens: 80_000, fee: 800, feeMsat: 800_000 }];
  const items = measureRebalances(records, events, new Map(), NOW).items.sort((a, b) => a.at.localeCompare(b.at));
  assert.deepEqual(items.map((i) => [i.routedOutSats, i.earnedSats, i.remainingSats]), [
    [50_000, 500, 0],
    [30_000, 300, 20_000],
  ]);
});

test("sats that left by a payment, not a forward, use a refill up with no fee — by LND's sent counter kept with each refill", () => {
  // Refill A, then 200,000 sat paid out of the channel (no forward), then
  // refill B; then forwards. Without the counter, A would take them.
  const records = [refill(12, 200_000, 100, { targetSentBefore: 5_000_000 }), refill(10, 200_000, 100, { targetSentBefore: 5_200_000 })];
  const events = dailyForwards(9, 0, 20_000, 40_000); // 9 × 20,000 out
  const items = measureRebalances(records, events, new Map([[T, 5_380_000]]), NOW).items.sort((a, b) => a.at.localeCompare(b.at));
  assert.deepEqual(items.map((i) => [i.otherOutSats, i.routedOutSats, i.earnedSats]), [
    [200_000, 0, 0],
    [0, 180_000, 360],
  ]);
});

test("a refill too recent to judge (its sats not all out, under 14 days old) is listed as measuring and kept out of the headline", () => {
  const records = [refill(30, 100_000, 100), refill(3, 500_000, 400)];
  const events = dailyForwards(30, 20, 10_000, 20_000); // 100,000 out before the second refill
  const r = measureRebalances(records, events, new Map(), NOW);
  assert.deepEqual([r.measured, r.measuring], [1, 1]);
  assert.equal(r.totalCostSats, 100, "only the measured refill");
  assert.equal(r.avgEarnedBackPct, 200);
});

test("GET /autopilot/outcomes follows every refill of the window — 250 failed attempts after it no longer push it out (it read the newest 200 records of both kinds)", async (t) => {
  quiet(t);
  const dir = makeTempDir(t);
  const ok = refill(0, 0, 0); // shape only
  const now = Date.now();
  const paid: RebalanceRecord = { ...ok, at: new Date(now - 20 * DAY).toISOString(), startedAt: new Date(now - 20 * DAY).toISOString(), amountSats: 300_000, feeSats: 300, costPpm: 1000 };
  const failures: RebalanceRecord[] = Array.from({ length: 250 }, (_, i) => ({
    ...paid,
    at: new Date(now - DAY + i * 1000).toISOString(),
    startedAt: undefined,
    ok: false,
    feeSats: null,
    costPpm: null,
    error: "no route",
  }));
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([...failures.reverse(), paid]));
  const forwards: FakeForward[] = Array.from({ length: 10 }, (_, i) => ({ at: now - (19 - i) * DAY, inId: S, outId: T, tokens: 30_000, feeMsat: 100_000 }));
  const node = feeNode({
    channels: [
      { id: T, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 500_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: S, partnerPublicKey: "02" + "a2".repeat(32), capacity: 2_000_000, localBalance: 1_500_000, transactionId: "a2".repeat(32), transactionVout: 0 },
    ],
    forwards,
  });
  const api = await startApi(t, { node, dir });
  const res = await api.request("GET", "/autopilot/outcomes");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const r = res.body.rebalances;
  assert.deepEqual([r.measured, r.totalCostSats, r.totalEarnedBackSats, r.avgEarnedBackPct], [1, 300, 1_000, 333]);
  assert.equal(r.items[0].routedOutSats, 300_000);
});

// ── Review of P6 ─────────────────────────────────────────────────────────────

const day = (daysAgo: number) => at(daysAgo).slice(0, 10);
const out = (daysAgo: number, tokens: number, feeMsat: number): ForwardEvent => ({ createdAt: at(daysAgo), incomingChannel: S, outgoingChannel: T, tokens, fee: Math.round(feeMsat / 1000), feeMsat });
const byDay = (items: RebalanceOutcome[], pick: (i: RebalanceOutcome) => number[]) => Object.fromEntries(items.map((i) => [i.at.slice(0, 10), pick(i)]));

test("a forward never draws on a refill made after it — first in, first out in time, as the profit floor retires refills", () => {
  // A: 100k on day 20; 5 × 40k routed out on days 19…15 (the channel had
  // sats of its own too); B: 100k on day 10; nothing out since.
  const r = measureRebalances([refill(20, 100_000, 100), refill(10, 100_000, 100)], [19, 18, 17, 16, 15].map((d) => out(d, 40_000, 40_000)), new Map(), NOW);
  const by = byDay(r.items, (i) => [i.routedOutSats, i.earnedSats, i.remainingSats]);
  assert.deepEqual(by[day(20)], [100_000, 100, 0]);
  assert.deepEqual(by[day(10)], [0, 0, 100_000], "B came after those forwards: none of them carried its sats");
});

test("what left by payment between two refills is counted once: each stretch ends at the next refill's sent counter", () => {
  // A 200k (counter 1,000,000); a 50k forward on day 15; B 100k (counter
  // 1,100,000): 50k left by payment meanwhile. Counter now 1,150,000: 50k
  // more left by payment since B.
  const r = measureRebalances(
    [refill(20, 200_000, 100, { targetSentBefore: 1_000_000 }), refill(10, 100_000, 100, { targetSentBefore: 1_100_000 })],
    [out(15, 50_000, 50_000)],
    new Map([[T, 1_150_000]]),
    NOW,
  );
  const by = byDay(r.items, (i) => [i.routedOutSats, i.otherOutSats, i.remainingSats]);
  // The first stretch's payment, then the second's — both from A, the oldest.
  assert.deepEqual(by[day(20)], [50_000, 100_000, 50_000]);
  assert.deepEqual(by[day(10)], [0, 0, 100_000]);
});

test("only the last 60 days' refills are listed — an older one still holds its place first in line", () => {
  // 100k 70 days ago, 100k 20 days ago; 150k routed out since the second.
  const r = measureRebalances([refill(70, 100_000, 100), refill(20, 100_000, 100)], [19, 18, 17].map((d) => out(d, 50_000, 50_000)), new Map(), NOW);
  assert.deepEqual(
    r.items.map((i) => [i.at.slice(0, 10), i.routedOutSats]),
    [[day(20), 50_000]],
    "the older refill's sats left first; it is not listed",
  );
});

test("GET /autopilot/outcomes leaves out refills older than the forwards it reads — one from 100 days ago never takes the forwards of a refill from 20 days ago", async (t) => {
  quiet(t);
  const dir = makeTempDir(t);
  const now = Date.now();
  const paid = (daysAgo: number): RebalanceRecord => ({ ...refill(0, 300_000, 300), at: new Date(now - daysAgo * DAY).toISOString(), startedAt: new Date(now - daysAgo * DAY).toISOString() });
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([paid(20), paid(100)]));
  const forwards: FakeForward[] = Array.from({ length: 10 }, (_, i) => ({ at: now - (19 - i) * DAY, inId: S, outId: T, tokens: 30_000, feeMsat: 100_000 }));
  const node = feeNode({
    channels: [
      { id: T, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 500_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: S, partnerPublicKey: "02" + "a2".repeat(32), capacity: 2_000_000, localBalance: 1_500_000, transactionId: "a2".repeat(32), transactionVout: 0 },
    ],
    forwards,
  });
  const api = await startApi(t, { node, dir });
  const r = (await api.request("GET", "/autopilot/outcomes")).body.rebalances;
  assert.deepEqual(
    r.items.map((i: { routedOutSats: number; earnedSats: number }) => [i.routedOutSats, i.earnedSats]),
    [[300_000, 1_000]],
    "its sats went out with those ten forwards",
  );
});

// ── Review 2 of P6 ───────────────────────────────────────────────────────────

test("sats paid out before a refill never use that refill up — the payment-side twin of a forward never drawing on a later refill", () => {
  // A 50k (counter 0); 80k paid out before B — A's 50k and 30k the channel
  // had of its own; B 100k (counter 80k); one 100k forward since; counter now 180k.
  const r = measureRebalances(
    [refill(20, 50_000, 50, { targetSentBefore: 0 }), refill(10, 100_000, 50, { targetSentBefore: 80_000 })],
    [out(5, 100_000, 100_000)],
    new Map([[T, 180_000]]),
    NOW,
  );
  const by = byDay(r.items, (i) => [i.routedOutSats, i.otherOutSats, i.remainingSats]);
  assert.deepEqual(by[day(20)], [0, 50_000, 0], "A's sats left by those payments");
  assert.deepEqual(by[day(10)], [100_000, 0, 0], "B's left with the forward after it — none by the payments made before it");
});

test("GET /autopilot/outcomes reads each channel's sent counter now: what left by payment since the last refill uses it up, with no fee", async (t) => {
  quiet(t);
  const dir = makeTempDir(t);
  const now = Date.now();
  const startedAt = new Date(now - 20 * DAY).toISOString();
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([{ ...refill(0, 300_000, 300), at: startedAt, startedAt, targetSentBefore: 1_000_000 }]));
  const node = feeNode({
    channels: [
      // Sent 1,000,000 before the refill; 100k forwarded and 150k paid out since.
      { id: T, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 500_000, transactionId: "a1".repeat(32), transactionVout: 0, totalSent: 1_250_000 },
      { id: S, partnerPublicKey: "02" + "a2".repeat(32), capacity: 2_000_000, localBalance: 1_500_000, transactionId: "a2".repeat(32), transactionVout: 0 },
    ],
    forwards: [{ at: now - 10 * DAY, inId: S, outId: T, tokens: 100_000, feeMsat: 100_000 }],
  });
  const api = await startApi(t, { node, dir });
  const [item] = (await api.request("GET", "/autopilot/outcomes")).body.rebalances.items;
  assert.deepEqual([item.routedOutSats, item.earnedSats, item.otherOutSats, item.remainingSats], [100_000, 100, 150_000, 50_000]);
});

// Final review of P6 (F1): measureRefills sorts the refills oldest first —
// load-bearing in production, where RebalanceLog.successes() hands them over
// NEWEST first. Every pure test passed them oldest first and the API tests had
// at most one refill in reach, so without the sort first-in-first-out ran
// backwards unnoticed.
test("PROBE-FIFO-ORDER: refills as the log lists them (newest first) are still retired oldest first — through GET /autopilot/outcomes", async (t) => {
  quiet(t);
  const now = Date.now();
  const dir = makeTempDir(t);
  const rec = (daysAgo: number): RebalanceRecord => {
    const when = new Date(now - daysAgo * DAY).toISOString();
    return { at: when, startedAt: when, via: "autopilot", targetId: T, targetAlias: "t", sourceId: S, sourceAlias: "s", amountSats: 100_000, budgetPpm: 1000, feeSats: 100, costPpm: 1000, ok: true };
  };
  // Newest first, as RebalanceLog.successes() returns them.
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([rec(10), rec(20)]));
  const forwards: FakeForward[] = [
    { at: now - 15 * DAY, inId: S, outId: T, tokens: 60_000, feeMsat: 60_000 },
    { at: now - 5 * DAY, inId: S, outId: T, tokens: 80_000, feeMsat: 80_000 },
  ];
  const node = feeNode({
    channels: [
      { id: T, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 500_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: S, partnerPublicKey: "02" + "a2".repeat(32), capacity: 2_000_000, localBalance: 1_500_000, transactionId: "a2".repeat(32), transactionVout: 0 },
    ],
    forwards,
  });
  const api = await startApi(t, { node, dir });
  const items = (await api.request("GET", "/autopilot/outcomes")).body.rebalances.items as { at: string; routedOutSats: number; earnedSats: number }[];
  const by = Object.fromEntries(items.map((i) => [Math.round((now - Date.parse(i.at)) / DAY), [i.routedOutSats, i.earnedSats]]));
  // The older one (20 d) first: the 60k of day 15, then 40k of the 80k of
  // day 5; the newer one (10 d) the other 40k. Without the sort: reversed.
  assert.deepEqual(by[20], [100_000, 100]);
  assert.deepEqual(by[10], [40_000, 40]);
});
