/**
 * The base fee an offer is priced with is the market's (2026-10-24).
 *
 * The engine kept whatever base an offer had and moved only the rate. 0.8.0's
 * size-only writes had reset the live offer's base to 0 (Amboss resets what an
 * update leaves out), so it stayed at 4,445 ppm + 0 sat while 95 of 97 listed
 * offers charged a base — median 568 sat. And at an unchanged price a new base
 * was never even sent: the reprice threshold judges the effective price, which
 * a base that the rate makes up for doesn't move. Now the engine prices with
 * the median base of comparable offers — the offer's own one while within
 * max(50 sat, 20 %) of it, and until the market's has differed for a day — and
 * a base move is a reprice of its own, keeping the price at the representative
 * size √(min·max). A base move that would let the smallest order pay less than
 * opening and closing its channel costs is refused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeBaseMoves } from "../src/services/autopilot.js";
import {
  BASE_FEE_FAR_FACTOR,
  BASE_FEE_MOVE_GAP_MS,
  BASE_FEE_STABLE_MS,
  BASE_FEE_TOLERANCE,
  baseFeeFollow,
  preferredBaseFeeSats,
  saleAcceptFloorSats,
} from "../src/services/magmaRecommend.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import { sellerSetup } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { quiet } from "./helpers/lifecycle.js";
import type { AfterHook } from "./helpers/tmp.js";

type Window = { minSats: number; maxSats: number };
const BAND: Window = { minSats: 1_000_000, maxSats: 2_000_000 };

/** Comparable leases cleared at 5% a year; the listed book charges `bases` (default: 568 sat each). */
function pricedMarket(t: AfterHook, opts: { config?: Record<string, unknown>; bases?: number[]; window?: Window } = {}) {
  const w = opts.window ?? BAND;
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { sellAutoReprice: true, sellPricingMode: "balanced", ...opts.config } });
  (opts.bases ?? Array(8).fill(568)).forEach((b, i) =>
    s.market.addOffer({ totalSats: w.maxSats, minSats: w.minSats, maxSats: w.maxSats, feeRatePpm: 3000 + i * 300, baseFeeSats: b, sellerScore: 50 }),
  );
  const rep = Math.round(Math.sqrt(w.minSats * w.maxSats));
  __setHistoryForTests(Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: rep, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })));
  t.after(() => __setHistoryForTests([]));
  return s;
}

const WINDOW = { ...BAND, totalSats: 2_000_000, minBlockLength: 4320 };
/** Effective ppm at the representative size √(min·max). */
const effective = (o: { feeRatePpm: number; baseFeeSats: number }, w: Window = BAND) => o.feeRatePpm + (o.baseFeeSats / Math.sqrt(w.minSats * w.maxSats)) * 1e6;
type S = ReturnType<typeof pricedMarket>;
const recOf = async (s: S, id: string) => (await s.autopilot.magmaReport()).sell.recommendations.find((r) => r.offerId === id)!;
/** The market's base has differed from the offer's, at its level, for `hours` (the clock). */
function differedFor(s: S, id: string, hours: number): void {
  const moves = (s.autopilot as unknown as { state: { offerBaseMoves?: Record<string, { base: number; since: string }> } }).state.offerBaseMoves ?? {};
  assert.ok(moves[id], "the clock runs");
  moves[id].since = new Date(Date.now() - hours * 3_600_000).toISOString();
}
/** The autopilot last moved the offer's base `hours` ago. */
function movedAgo(s: S, id: string, hours: number): void {
  const state = (s.autopilot as unknown as { state: { offerBaseMovedAt?: Record<string, string> } }).state;
  assert.ok(state.offerBaseMovedAt?.[id], "a move was stamped");
  state.offerBaseMovedAt[id] = new Date(Date.now() - hours * 3_600_000).toISOString();
}

test("an offer the autopilot prices gets the base comparable offers charge — at once when its own is far off (the 0 that 0.8.0 left waited a day); the rate makes up the rest, so the price at √(min·max) stays", async (t) => {
  quiet(t);
  const s = pricedMarket(t);
  const { autopilot, magma } = s;
  const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 0, feeRateCap: "2200", baseFeeCap: "1" });
  // Its rate alone set to the engine's price: well priced, as the live offer was.
  offer.feeRatePpm = (await recOf(s, offer.id)).recommended.effectiveFeePpm;
  // 0 against 568: far off — no wait (before: a day's hold).
  const rec = await recOf(s, offer.id);
  assert.deepEqual([rec.state, rec.baseFeeMarketSat, rec.baseFeeDiffers, rec.baseFeeFollowsAt], ["well_priced", 568, true, undefined]);
  assert.deepEqual([rec.shouldReprice, rec.baseOnly, rec.recommended.baseFeeSat], [true, true, 568], "before: no reprice, the base the offer had (0)");
  const before = effective(offer);
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 568);
  assert.ok(Math.abs(effective(offer) - before) <= 2, `the price at √(min·max) stays: ${effective(offer)} vs ${before} ppm effective`);
  const e = autopilot.offerSyncStatus().offers.find((x) => x.offerId === offer.id);
  assert.equal(
    e?.lastWrite?.reason,
    "base fee set to 568 sat (was 0) — what comparable offers charge; the rate makes up the rest, so the price at the representative size √(min·max) stays",
  );
  assert.equal(e?.lastWrite?.verified, true);
  assert.deepEqual([...(e?.lastWrite?.changed ?? [])].sort(), ["base_fee", "fee_rate"]);
  // Settled: the next run writes nothing, and the clock is gone.
  const writes = magma.count("UpdateOffer");
  await autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), writes);
  assert.equal((autopilot as unknown as { state: { offerBaseMoves?: Record<string, unknown> } }).state.offerBaseMoves?.[offer.id], undefined);
});

test("a base move never moves the price at √(min·max): a well-priced offer off the engine's exact price keeps its own, and a depleted one priced above it is not cheapened", async (t) => {
  quiet(t);
  const s = pricedMarket(t);
  const { autopilot, magma } = s;
  const near = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 0 });
  const sold = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 0, lockedSats: 1_500_000 }); // depleted: 0.5M of 2M left
  const target = (await recOf(s, near.id)).recommended.effectiveFeePpm;
  near.feeRatePpm = Math.round(target * 1.05); // within the reprice threshold: well priced
  sold.feeRatePpm = Math.round(target * 1.3); // above the engine's price: a depleted offer is only ever raised
  assert.equal((await recOf(s, near.id)).state, "well_priced");
  assert.equal((await recOf(s, sold.id)).state, "exhausted");
  differedFor(s, near.id, 25);
  differedFor(s, sold.id, 25);
  const before = [effective(near), effective(sold)];
  await autopilot.runOnce();
  assert.deepEqual([near.baseFeeSats, sold.baseFeeSats], [568, 568]);
  const after = [effective(near), effective(sold)];
  for (const i of [0, 1]) assert.ok(Math.abs(after[i] - before[i]) <= 2, `price ${before[i]} → ${after[i]} ppm effective`);
});

test("a base-only recommendation is one price: `recommended`, beats-routing and the per-sale %/yr line all describe the split it writes", async (t) => {
  quiet(t);
  const s = pricedMarket(t);
  const offer = s.magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 0 });
  const target = (await recOf(s, offer.id)).recommended.effectiveFeePpm;
  offer.feeRatePpm = Math.round(target * 0.93); // well priced, below the target
  await recOf(s, offer.id);
  differedFor(s, offer.id, 25);
  const rec = await recOf(s, offer.id);
  assert.equal(rec.baseOnly, true);
  assert.ok(Math.abs(rec.recommended.effectiveFeePpm - effective(offer)) <= 1, "the offer's own price, split anew — not the target");
  assert.equal(rec.economics.leaseApy, rec.recommended.leaseApy);
  assert.ok(rec.reasons.some((r) => r.startsWith(`per sale, a lease at this price nets ~${rec.recommended.leaseApy}%/yr`)), rec.reasons.join(" | "));
  assert.equal(rec.economics.beatsRouting, rec.reasons.some((r) => r.includes("above your routing benchmark")));
});

test("no flip-flop: a small segment whose median base one listing moves back and forth never rewrites the base — it follows only once the market's has held for 1.5 h", async (t) => {
  quiet(t);
  // 5 in band: median (index 2) 568; a sixth at 900 moves it to 900.
  const s = pricedMarket(t, { bases: [300, 300, 568, 900, 900] });
  const { autopilot, magma, market } = s;
  const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 568, feeRateCap: "2200", baseFeeCap: "1" });
  offer.feeRatePpm = (await recOf(s, offer.id)).recommended.feeRatePpm; // well priced at 568
  await autopilot.runOnce();
  const w0 = magma.count("UpdateOffer");
  const bases: number[] = [offer.baseFeeSats];
  for (let i = 0; i < 4; i++) {
    if (i % 2 === 0) market.addOffer({ id: "flipper", totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 4000, baseFeeSats: 900, sellerScore: 50 });
    else market.offers.splice(market.offers.findIndex((o) => o.id === "flipper"), 1);
    await autopilot.runOnce();
    bases.push(offer.baseFeeSats);
  }
  assert.deepEqual(bases, [568, 568, 568, 568, 568], "before: 568 → 900 → 568 → 900 → 568, a write each run");
  assert.equal(magma.count("UpdateOffer") - w0, 0);
  const clocks = () => (autopilot as unknown as { state: { offerBaseMoves?: Record<string, unknown> } }).state.offerBaseMoves ?? {};
  assert.equal(clocks()[offer.id], undefined, "back within the tolerance: the clock stops — it starts afresh");
  // The median stays at 900 (longer than 1.5 h): one base write, then quiet.
  market.addOffer({ id: "flipper", totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 4000, baseFeeSats: 900, sellerScore: 50 });
  await autopilot.runOnce();
  differedFor(s, offer.id, 25);
  await autopilot.runOnce();
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 900);
  assert.equal(magma.count("UpdateOffer") - w0, 1);
  // An offer that is gone takes its clock with it.
  market.offers.splice(market.offers.findIndex((o) => o.id === "flipper"), 1); // 568 again: the clock runs
  await autopilot.runOnce();
  assert.ok(clocks()[offer.id]);
  magma.offers.delete(offer.id);
  await autopilot.runOnce();
  assert.equal(clocks()[offer.id], undefined);
});

test("the clock is spent by the move it led to: after a held difference the base moves once — a median that then flips every run, or moves right after, is not followed at once", async (t) => {
  quiet(t);
  // 6 in band: median (index round(2.5) = 3) 900; one 900 fewer: 568.
  const s = pricedMarket(t, { bases: [300, 300, 568, 900, 900, 900] });
  const { autopilot, magma, market } = s;
  const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 568, feeRateCap: "2200", baseFeeCap: "1" });
  offer.feeRatePpm = (await recOf(s, offer.id)).recommended.feeRatePpm; // well priced at its 568
  await autopilot.runOnce(); // median 900: the clock starts
  differedFor(s, offer.id, 25); // …and the median stayed at 900 for a day
  const w0 = magma.count("UpdateOffer");
  const bases: number[] = [offer.baseFeeSats];
  const clocks = () => (autopilot as unknown as { state: { offerBaseMoves?: Record<string, unknown> } }).state.offerBaseMoves ?? {};
  for (let i = 0; i < 6; i++) {
    await autopilot.runOnce();
    bases.push(offer.baseFeeSats);
    if (i === 0) assert.equal(clocks()[offer.id], undefined, "the write that moved the base dropped its clock");
    const at = market.offers.findIndex((o) => o.baseFeeSats === 900);
    if (i % 2 === 0) market.offers.splice(at, 1);
    else market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 4200, baseFeeSats: 900, sellerScore: 50 });
  }
  assert.deepEqual(bases, [568, 900, 900, 900, 900, 900, 900], "before: 568 → 900 → 568 → 900 …, a write every run");
  assert.equal(magma.count("UpdateOffer") - w0, 1, "one write for the one held difference");
});

test("a difference that isn't far off waits for the market's base to hold 1.5 h — and says until when, also on the recommendation the Sell page reads", async (t) => {
  quiet(t);
  const s = pricedMarket(t);
  const { autopilot, magma } = s;
  // 450 against 568: beyond the tolerance (113.6), not far off (under 2 ×, over ½ ×).
  const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 450, feeRateCap: "2200", baseFeeCap: "1" });
  offer.feeRatePpm = (await recOf(s, offer.id)).recommended.feeRatePpm;
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 450, "settling: not yet");
  const held = await recOf(s, offer.id);
  const clock = (autopilot as unknown as { state: { offerBaseMoves?: Record<string, { since: string }> } }).state.offerBaseMoves?.[offer.id];
  assert.ok(clock);
  assert.equal(held.baseFeeFollowsAt, new Date(Date.parse(clock.since) + BASE_FEE_STABLE_MS).toISOString());
  const at = held.baseFeeFollowsAt!.slice(11, 16);
  assert.ok(
    held.reasons.includes(`comparable offers charge 568 sat base (it has 450) — its base follows at ${at} UTC, once that has held for 1.5 h`),
    held.reasons.join(" | "),
  );
  differedFor(s, offer.id, 1.4);
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 450, "1.4 h: still settling");
  differedFor(s, offer.id, 1.6);
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 568, "held for 1.5 h: followed");
  assert.equal((await recOf(s, offer.id)).baseFeeFollowsAt, undefined);
});

test("a market base that moves to another level while it differs starts the 1.5 h afresh — the offer follows a level that held, not one just reached", async (t) => {
  quiet(t);
  const s = pricedMarket(t, { bases: Array(8).fill(284) });
  const { autopilot, magma, market } = s;
  // 200 against 284: beyond the tolerance (56.8), not far off.
  const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 200, feeRateCap: "2200", baseFeeCap: "1" });
  offer.feeRatePpm = (await recOf(s, offer.id)).recommended.feeRatePpm;
  await autopilot.runOnce();
  differedFor(s, offer.id, 1); // at 284 for an hour…
  // …then the market's base moves to 380 (still not far from 200: under 2 ×).
  for (let i = 0; i < 12; i++) market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 3000, baseFeeSats: 380, sellerScore: 50 });
  await autopilot.runOnce();
  const clock = (autopilot as unknown as { state: { offerBaseMoves?: Record<string, { base: number; since: string }> } }).state.offerBaseMoves?.[offer.id];
  assert.equal(clock?.base, 380);
  assert.ok(Date.now() - Date.parse(clock?.since ?? "") < 60_000, "the clock started afresh at the new level");
  assert.equal(offer.baseFeeSats, 200, "1 h at 284 doesn't make 380 a level that held");
  differedFor(s, offer.id, 1.6);
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 380);
});

test("at most one base move per 6 h: after one, the next difference — even a far one — waits until 6 h after it, and the reason says so", async (t) => {
  quiet(t);
  const s = pricedMarket(t);
  const { autopilot, magma, market } = s;
  const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 0, feeRateCap: "2200", baseFeeCap: "1" });
  offer.feeRatePpm = (await recOf(s, offer.id)).recommended.feeRatePpm;
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 568, "far off: at once");
  const movedAt = (autopilot as unknown as { state: { offerBaseMovedAt?: Record<string, string> } }).state.offerBaseMovedAt?.[offer.id];
  assert.ok(movedAt && Date.now() - Date.parse(movedAt) < 60_000, "the move is stamped");
  // The market moves far (to 1,500 sat: over 2 × 568).
  for (let i = 0; i < 20; i++) market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 3000, baseFeeSats: 1500, sellerScore: 50 });
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 568, "within 6 h of the last move: waits");
  const rec = await recOf(s, offer.id);
  assert.equal(rec.baseFeeFollowsAt, new Date(Date.parse(movedAt) + BASE_FEE_MOVE_GAP_MS).toISOString());
  assert.ok(rec.reasons.some((r) => r.endsWith("UTC, 6 h after its last base change") && r.startsWith("comparable offers charge 1500 sat base (it has 568)")), rec.reasons.join(" | "));
  movedAgo(s, offer.id, 6.1);
  await autopilot.runOnce();
  assert.equal(offer.baseFeeSats, 1500, "6 h later: followed");
});

test("baseFeeFollow, the rule itself: far off (under ½ × or over 2 ×, 0 among them) at once; else after 1.5 h at the market's level; never sooner than 6 h after the last move", () => {
  const now = Date.parse("2026-10-25T12:00:00.000Z");
  const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
  assert.equal(BASE_FEE_FAR_FACTOR, 2);
  assert.deepEqual(baseFeeFollow(0, 284, undefined, now), { at: null, why: "far" });
  assert.deepEqual(baseFeeFollow(700, 284, undefined, now), { at: null, why: "far" });
  assert.deepEqual(baseFeeFollow(200, 284, undefined, now), { at: now + BASE_FEE_STABLE_MS, why: "settling" }, "first seen now");
  assert.deepEqual(baseFeeFollow(200, 284, { since: ago(1) }, now), { at: now + 0.5 * 3_600_000, why: "settling" });
  assert.deepEqual(baseFeeFollow(200, 284, { since: ago(2) }, now), { at: null, why: "stable" });
  assert.deepEqual(baseFeeFollow(200, 284, { since: ago(2), movedAt: ago(5) }, now), { at: now + 3_600_000, why: "gap" });
  assert.deepEqual(baseFeeFollow(0, 284, { movedAt: ago(1) }, now), { at: now + 5 * 3_600_000, why: "gap" }, "far, but within 6 h of a move");
  assert.deepEqual(baseFeeFollow(200, 284, { since: ago(0.5), movedAt: ago(5.9) }, now), { at: now + 3_600_000, why: "settling" }, "the later of the two");
});

test("a clock started against another base of the offer's doesn't count: an edit on amboss.tech after a day-long difference is not followed at once — the clock starts afresh", async (t) => {
  quiet(t);
  const s = pricedMarket(t, { bases: Array(8).fill(900) });
  const { autopilot, magma } = s;
  const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 568, feeRateCap: "2200", baseFeeCap: "1" });
  offer.feeRatePpm = (await recOf(s, offer.id)).recommended.feeRatePpm;
  await recOf(s, offer.id);
  differedFor(s, offer.id, 25);
  // The operator sets another base on amboss.tech (still beyond the market's 900), the rate making up for it.
  const rate = offer.feeRatePpm;
  [offer.baseFeeSats, offer.feeRatePpm] = [700, Math.round(rate - (132 / Math.sqrt(2e12)) * 1e6)];
  const rec = await recOf(s, offer.id);
  assert.deepEqual([rec.baseFeeDiffers, rec.baseOnly, rec.recommended.baseFeeSat], [true, undefined, 700], "held: the old clock was about 568");
  const clock = (autopilot as unknown as { state: { offerBaseMoves?: Record<string, { offerBase: number; since: string }> } }).state.offerBaseMoves?.[offer.id];
  assert.equal(clock?.offerBase, 700, "started afresh against 700");
  assert.ok(Date.now() - Date.parse(clock?.since ?? "") < 60_000);
});

test("base-fee clocks read back from a damaged state file are made safe — the engine and the upkeep don't throw on them", async (t) => {
  quiet(t);
  const s = pricedMarket(t);
  const offer = s.magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 0 });
  const file = join(s.dir, "autopilot.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.offerBaseMoves = { a: null, b: { base: "568" }, c: 5, [offer.id]: { base: 568, offerBase: 0, since: "not a time" }, kept: { base: 568, offerBase: 0, since: new Date().toISOString() } };
  state.offerBaseMovedAt = { x: null, y: "never", [offer.id]: 7, kept: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(state));
  const ap = s.restart();
  assert.deepEqual(Object.keys((ap as unknown as { state: { offerBaseMoves: Record<string, unknown> } }).state.offerBaseMoves), ["kept"]);
  assert.deepEqual(Object.keys((ap as unknown as { state: { offerBaseMovedAt: Record<string, unknown> } }).state.offerBaseMovedAt), ["kept"]);
  await ap.magmaReport(); // before: threw on the null entry
  const run = await ap.runOnce();
  assert.deepEqual(run.sells.filter((x) => x.action === "error"), []);
  assert.deepEqual(sanitizeBaseMoves([1, 2]), {});
  assert.deepEqual(sanitizeBaseMoves("x"), {});
});

test("a market base too big for the price is cut to fit — written once: the next run's cut, a rounding remainder away, is no move", async (t) => {
  quiet(t);
  // √(min·max) = 400k, priced at the profit floor at 1 sat/vB (2,063 ppm effective):
  // the market's 5,000 sat (12,500 ppm there) is far more than the whole price —
  // the cut stays beyond the tolerance of it, so each run cuts it again.
  const w: Window = { minSats: 200_000, maxSats: 800_000 };
  const s = pricedMarket(t, { window: w, bases: Array(8).fill(5000) });
  const { autopilot, magma, node } = s;
  node.override("wallet.estimateFee", (_a, cb) => (cb as (e: unknown, r: unknown) => void)(null, { sat_per_kw: "250" }));
  __setHistoryForTests(Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 400_000, blocks: 4320, apr: 0.01, leasePpm: 500, status: "FINISHED" })));
  const offer = magma.addOffer({ ...w, totalSats: 800_000, minBlockLength: 4320, feeRatePpm: 2070, baseFeeSats: 0, feeRateCap: "2200", baseFeeCap: "1" });
  const target = await recOf(s, offer.id);
  // The case: 2,070 ppm + 0 is well priced (the engine's price is ~2,063–2,071 ppm effective there).
  assert.equal(target.state, "well_priced", `${target.recommended.effectiveFeePpm}`);
  assert.ok(Math.abs(target.recommended.effectiveFeePpm - 2070) <= 10, `${target.recommended.effectiveFeePpm}`);
  differedFor(s, offer.id, 25);
  await autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), 1);
  assert.deepEqual([offer.feeRatePpm, offer.baseFeeSats], [3, 827], "cut to fit");
  await autopilot.runOnce(); // 827 is still far from 5,000: the clock starts again, against 827
  differedFor(s, offer.id, 25); // …and a day passes, past the 6 h after the move
  movedAgo(s, offer.id, 25);
  await autopilot.runOnce();
  await autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), 1, "before: a second write a day later, 3 + 827 → 1 + 828, for one sat");
});

test("a base going down to the market's is refused where the smallest order would then pay less than opening and closing its channel costs today — the lane would turn it down", async (t) => {
  quiet(t);
  const w: Window = { minSats: 250_000, maxSats: 4_000_000 }; // √(min·max) = 1M
  for (const [satPerVbyte, kept, own] of [[6, true, 1500], [5, true, 1500], [2, false, 1500], [8, false, 0]] as const) {
    const s = pricedMarket(t, { window: w });
    const { autopilot, magma, node } = s;
    node.override("wallet.estimateFee", (_a, cb) => (cb as (e: unknown, r: unknown) => void)(null, { sat_per_kw: String(satPerVbyte * 250) }));
    const offer = magma.addOffer({ ...w, totalSats: 4_000_000, minBlockLength: 4320, feeRatePpm: 3000, baseFeeSats: own, feeRateCap: "2200", baseFeeCap: "1" });
    // At the engine's price with its own base: well priced.
    offer.feeRatePpm = Math.round((await recOf(s, offer.id)).recommended.effectiveFeePpm - own);
    await recOf(s, offer.id);
    differedFor(s, offer.id, 25);
    const rec = await recOf(s, offer.id);
    const floor = saleAcceptFloorSats(satPerVbyte, 0);
    const smallest = (o: { feeRatePpm: number; baseFeeSats: number }) => (o.feeRatePpm * w.minSats) / 1e6 + o.baseFeeSats;
    await autopilot.runOnce();
    if (kept) {
      assert.equal(rec.recommended.baseFeeSat, 1500, `${satPerVbyte} sat/vB: the base stays`);
      assert.ok(rec.reasons.some((r) => r.startsWith("keeps its base of 1500 sat: with the market's 568 sat its smallest order (250000 sat) would pay")), rec.reasons.join(" | "));
      assert.equal(offer.baseFeeSats, 1500);
      assert.ok(smallest(offer) >= floor, `${smallest(offer)} vs the floor ${floor}`);
      // Market → Sell says "kept" — never "→ 568 next run" for a move that won't come.
      assert.equal(rec.baseFeeKept, true);
    } else if (own === 0) {
      // Going UP: the smallest order pays more with the market's base — even
      // where that is still short of the floor, it is never kept from going up.
      assert.equal(offer.baseFeeSats, 568, `${satPerVbyte} sat/vB: a base going up is never refused`);
    } else {
      assert.equal(offer.baseFeeSats, 568, `${satPerVbyte} sat/vB: the smallest order still pays its way — the base follows`);
      assert.ok(smallest(offer) >= floor);
    }
    if (!kept) assert.equal(rec.baseFeeKept, undefined);
  }
});

test("anti-churn: a base within max(50 sat, 20 % of the market's) stays the offer's — a median that wobbles never rewrites it; one further off goes to the market's", async (t) => {
  assert.deepEqual(BASE_FEE_TOLERANCE, { minSats: 50, share: 0.2 });
  assert.deepEqual([BASE_FEE_STABLE_MS, BASE_FEE_MOVE_GAP_MS], [90 * 60_000, 6 * 3_600_000]);
  assert.equal(preferredBaseFeeSats(540, 568), 540);
  assert.equal(preferredBaseFeeSats(681, 568), 681, "113 sat off: within 20 % of 568 (113.6)");
  assert.equal(preferredBaseFeeSats(682, 568), 568);
  assert.equal(preferredBaseFeeSats(450, 568), 568);
  assert.equal(preferredBaseFeeSats(0, 568), 568, "the live offer's 0");
  assert.equal(preferredBaseFeeSats(40, 0), 40, "within 50 sat of a market that charges none");
  assert.equal(preferredBaseFeeSats(100, 0), 0);
  assert.equal(preferredBaseFeeSats(null, 568), 568, "a new offer: the market's");
  assert.equal(preferredBaseFeeSats(500, null), 500, "no comparable offer: its own");
  assert.equal(preferredBaseFeeSats(null, null), 1000);

  quiet(t);
  const s = pricedMarket(t);
  const { autopilot, magma, market } = s;
  const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4000, baseFeeSats: 540 });
  offer.feeRatePpm = (await recOf(s, offer.id)).recommended.feeRatePpm; // well priced with its own 540
  await autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), 0, "540 against the market's 568: kept");
  // The median moves to 620 (more offers at it): 540 is still within 124 sat.
  for (let i = 0; i < 9; i++) market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 3500, baseFeeSats: 620, sellerScore: 50 });
  await autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), 0, "no rewrite as the median wobbles");
  assert.equal(offer.baseFeeSats, 540);
});

test("an offer whose terms are the operator's, or any offer with auto-pricing off, keeps its base — the recommendation, and so 'Apply recommended', carries the market's (at once, its own being far off)", async (t) => {
  quiet(t);
  for (const variant of ["terms taken over", "auto-pricing off"] as const) {
    const s = pricedMarket(t, { config: variant === "auto-pricing off" ? { sellAutoReprice: false } : {} });
    const { autopilot, magma } = s;
    const offer = magma.addOffer({ ...WINDOW, feeRatePpm: 4100, baseFeeSats: 0 });
    if (variant === "terms taken over") autopilot.pauseOfferAutomation(offer.id, "you edited this offer");
    await autopilot.runOnce();
    await recOf(s, offer.id); // a page view: the clock runs whoever prices the offer
    await autopilot.runOnce();
    assert.equal(magma.count("UpdateOffer"), 0, variant);
    assert.deepEqual([offer.feeRatePpm, offer.baseFeeSats], [4100, 0], variant);
    const rec = await recOf(s, offer.id);
    assert.equal(rec.recommended.baseFeeSat, 568, `${variant}: the recommendation carries the market's base`);
    for (const p of Object.values(rec.pricing)) assert.equal(p.baseFeeSat, 568, `${variant}: so do the price buttons`);
  }
});

test("a base of 0 is a price the Sell form and its route take — comparable offers may charge none — and 0 ppm + 0 sat is not", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  new FakeMarket(http, t);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 8_000_000 }) });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  const terms = { totalSizeSats: 2_000_000, minSizeSats: 1_000_000, maxSizeSats: 2_000_000, feeRatePpm: 3000, baseFeeSats: 0, minBlockLength: 4320 };
  const created = await api.request("POST", "/amboss/offer", terms);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const offer = [...magma.offers.values()][0];
  assert.deepEqual([offer.feeRatePpm, offer.baseFeeSats], [3000, 0]);
  const free = await api.request("POST", "/amboss/offer/update", { ...terms, id: offer.id, feeRatePpm: 0 });
  assert.deepEqual([free.status, free.body.error], [400, "bad_fee"]);
  assert.match(free.body.message, /at 0 ppm \+ 0 sat buyers would get a channel for free/);
  assert.equal(offer.feeRatePpm, 3000, "nothing sent");
});
