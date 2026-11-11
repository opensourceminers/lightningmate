/**
 * The Magma offer against the market: what the autopilot prices, sizes, lists
 * and creates when the market data is thin, cheap, empty or made up, and when
 * the mempool moves (review 2026-11-10, OFFER-1 to OFFER-8 and OFFER-10 to
 * OFFER-13).
 *
 * Each test is one of the review's probes turned round. The probe passed
 * while the fault was there; the test passes now that it is gone:
 *
 *  - one sale in the offer's size band set the whole price (OFFER-3);
 *  - cheap listings, or an empty book, stopped repricing and auto-listing
 *    although real sales cleared well above the floor (OFFER-1);
 *  - with no sale history a few odd or made-up listings set the price
 *    (OFFER-7);
 *  - a partly sold offer never came down with the market and went up by a
 *    hair (OFFER-6);
 *  - the most frequent lease became the offer's minimum lease (OFFER-5);
 *  - "auto-relist" off was not honoured when the window was reshaped
 *    (OFFER-2);
 *  - the smallest listed order paid no more than the lane's floor, so a
 *    small rise of the fee estimate turned it down (OFFER-4, OFFER-10), and
 *    the offer the autopilot created invited orders the lane refused
 *    (OFFER-8);
 *  - a price bound by the floor was rewritten on every uptick of the
 *    mempool (OFFER-11);
 *  - the history did not look at an order's status (OFFER-12);
 *  - with no fee estimate the engine costed a channel at built-in defaults
 *    while the lane used the last known rate (OFFER-13).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerSetup, BUYER, lndEstimatesFee } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { makeTempDir } from "./helpers/tmp.js";
import {
  __setHistoryForTests,
  clearingFor,
  initMagmaHistory,
  MIN_CLEARING_SAMPLE,
  refreshMagmaHistory,
} from "../src/services/magmaHistory.js";
import {
  COVER_KEEP_MARGIN,
  COVER_RELAX_MARGIN,
  COVER_WRITE_MARGIN,
  LISTED_MOVE_HOLD_MS,
  saleAcceptFloorSats,
  smallestOrderPaysSat,
  standingMinimumStays,
} from "../src/services/magmaRecommend.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";

const DAY = 86_400_000;
/** A lease sold `daysAgo` at `apr` a year. */
const sale = (daysAgo: number, sizeSat: number, apr: number, blocks = 4320) => ({
  at: Date.now() - daysAgo * DAY,
  sizeSat,
  blocks,
  apr,
  leasePpm: Math.round((apr * blocks * 1e6) / 52_560),
  status: "FINISHED",
});
/** This node's offer: 250k–2M per order, 4M listed, 4,110 ppm + 284 sat for 30 days. */
const OFFER = {
  minSats: 250_000,
  maxSats: 2_000_000,
  totalSats: 4_000_000,
  lockedSats: 0,
  feeRatePpm: 4110,
  baseFeeSats: 284,
  minBlockLength: 4320,
  feeRateCap: "2200",
  baseFeeCap: "1",
};
type S = ReturnType<typeof sellerSetup>;
/** `n` listings of sellers that sell (score 50, 30 orders filled), priced by `ppm`. */
const asks = (s: S, ppm: (i: number) => number, n = 8, extra: Record<string, unknown> = {}) => {
  for (let i = 0; i < n; i++)
    s.market.addOffer({
      totalSats: 5_000_000,
      minSats: 250_000,
      maxSats: 5_000_000,
      feeRatePpm: ppm(i),
      baseFeeSats: 284,
      sellerScore: 50,
      filledOrders: 30,
      monthsListed: 6,
      ...extra,
    });
};
/** Sets LND's fee estimate (250 sat/kw = 1 sat/vB) and returns the lane's floor at it. */
const feeRate = async (s: S, satPerKw: number) => {
  s.node.override("wallet.estimateFee", (_a: unknown, cb: unknown) =>
    (cb as (e: unknown, r: unknown) => void)(null, { sat_per_kw: String(satPerKw) }),
  );
  (s.autopilot as unknown as { saleFloor: unknown }).saleFloor = null;
  return s.autopilot.saleFeeFloorSats();
};
const recOf = async (s: S, id: string) => {
  const rep = await s.autopilot.magmaReport();
  return { rep, r: rep.sell.recommendations.find((x) => x.offerId === id)! };
};
const history = (t: { after(fn: () => void): void }, orders: ReturnType<typeof sale>[]) => {
  __setHistoryForTests(orders);
  t.after(() => __setHistoryForTests([]));
};
const creates = (s: S) => s.magma.calls.filter((c) => c.op === "CreateOffer");
/** What an order of the offer's smallest size pays the seller. */
const paysAtMin = (o: { feeRatePpm: number; minSats: number; baseFeeSats: number }) =>
  Math.floor((o.feeRatePpm * o.minSats) / 1e6 + o.baseFeeSats);
/** An offer's price in ppm at the size the engine prices it at, √(min·max): the rate plus the base fee's share. */
const effective = (o: { feeRatePpm: number; minSats: number; maxSats: number; baseFeeSats: number }) =>
  o.feeRatePpm + (o.baseFeeSats / Math.sqrt(o.minSats * o.maxSats)) * 1e6;
const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();
const SELLER_CFG = { sellAutoReprice: true, sellMaxChannelSats: 2_000_000 };

// ── OFFER-3: one sale is not a market ────────────────────────────────────────

for (const [name, lone] of [
  ["low (0.2 %/yr, 200 days old)", sale(200, 1_000_000, 0.002)],
  ["high (90 %/yr, 200 days old)", sale(200, 300_000, 0.9)],
] as const) {
  test(`OFFER-3: ONE sale in the offer's size band, ${name}, does not set the price — the 40 recent sales of every size do`, async (t) => {
    quiet(t);
    const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
    history(t, [...Array.from({ length: 40 }, (_, i) => sale(i % 29, 3_000_000, 0.05)), lone]);
    asks(s, (i) => 3000 + i * 300);
    const offer = s.magma.addOffer(OFFER);
    const { r } = await recOf(s, offer.id);
    // The band holds one sale — fewer than a clearing price is read from —
    // so the price is that of the sales of every size, and the report says so.
    assert.ok(1 < MIN_CLEARING_SAMPLE);
    assert.equal(r.clearing?.count, 40);
    assert.equal(r.clearing?.allSizes, true);
    assert.equal(r.clearing?.medianPpm, 4110);
    assert.equal(r.recommended.effectiveFeePpm, 4110);
    assert.ok(
      r.warnings.some((w) => /fewer than 12 leases sold in your 0\.25M–2M band in a year — the clearing price comes from the sales of every size/.test(w)),
      r.warnings.join(" | "),
    );
    await s.autopilot.runOnce();
    assert.equal(offer.feeRatePpm, 4110, "the price stays with what buyers paid");
    assert.equal(s.magma.count("UpdateOffer"), 0);
  });
}

// ── OFFER-1: real sales, not listings, decide whether a price is competitive ─

test("OFFER-1: sales clear well above the floor and the listings are far cheaper — the offer is repriced to what buyers paid, not frozen as 'uncompetitive'", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  asks(s, (i) => 400 + i * 100, 12); // listed at 400–1,500 ppm: under this node's floor
  const offer = s.magma.addOffer({ ...OFFER, feeRatePpm: 2950 });
  const { rep, r } = await recOf(s, offer.id);
  assert.ok((r.clearing?.medianPpm ?? 0) > r.economics.profitFloorEffectivePpm, "sales clear above the floor");
  assert.equal(r.state, "underpriced");
  assert.equal(r.shouldReprice, true);
  assert.equal(rep.sell.state, "good_to_sell");
  await s.autopilot.runOnce();
  assert.equal(offer.feeRatePpm, 3708, "3,708 ppm + 284 sat is the 4,110 ppm buyers paid");
});

test("OFFER-1: Amboss's public book is empty — the offer is still repriced to the sales", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  const offer = s.magma.addOffer({ ...OFFER, feeRatePpm: 2950 });
  const { rep, r } = await recOf(s, offer.id);
  assert.equal(r.market.segmentCount, 0);
  assert.equal(r.state, "underpriced");
  assert.equal(rep.sell.state, "good_to_sell");
  await s.autopilot.runOnce();
  assert.equal(offer.feeRatePpm, 3708);
});

test("OFFER-1: no offer yet, cheap listings, sales above the floor — the autopilot lists one at the price buyers paid", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  lndEstimatesFee(s.node);
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  asks(s, (i) => 400 + i * 100, 12);
  const rep = await s.autopilot.magmaReport();
  assert.equal(rep.sell.state, "good_to_sell");
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 1, s.autopilot.getState().decisions.magma?.text);
  const input = creates(s)[0]!.variables.input as Record<string, number>;
  const eff = input.fee_rate! + (input.base_fee! / Math.sqrt(input.min_size! * input.max_size!)) * 1e6;
  assert.ok(Math.abs(eff - 4110) <= 2, `listed at ${Math.round(eff)} ppm effective`);
});

// ── OFFER-7: with no sale history, listings are trusted only when comparable ─

test("an offer the autopilot created that Amboss's list doesn't show yet is not created a second time — the run says what it waits for, and goes on once the list has it", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  lndEstimatesFee(s.node);
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  asks(s, (i) => 400 + i * 100, 12);
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 1, "the first run lists an offer");
  // Amboss's list of this node's offers is a run behind: it shows none.
  const listed = [...s.magma.offers.entries()];
  s.magma.offers.clear();
  await s.autopilot.runOnce();
  // (Before: a second CreateOffer — the same capital listed twice.)
  assert.equal(creates(s).length, 1, "no second offer beside the one just created");
  assert.match(
    String(s.autopilot.getState().decisions.magma?.text),
    /no further offer created: the one created at \d\d:\d\d UTC isn't in Amboss's list of your offers yet — looked at again next run/,
  );
  for (const [id, o] of listed) s.magma.offers.set(id, o);
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 1);
  assert.equal(s.magma.offers.size, 1);
  // The offer is gone for good (deleted on amboss.tech): after the wait a new one is listed.
  s.magma.offers.clear();
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 2, "an offer that was seen and is gone is not waited for");
});

test("OFFER-7: no sale history and three comparable listings — three 1-block listings do not push the price to the clamp; the market is 'unknown' and the price stays", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  asks(s, () => 4000, 3);
  asks(s, () => 3000, 3, { minBlockLength: 1, sellerScore: 0, filledOrders: 0, totalSats: 300_000, maxSats: 300_000 });
  const offer = s.magma.addOffer(OFFER);
  const { r } = await recOf(s, offer.id);
  assert.equal(r.state, "market_unknown");
  assert.equal(r.shouldReprice, false);
  assert.equal(r.recommended.feeRatePpm, 4110, "the recommendation is the price it has");
  await s.autopilot.runOnce();
  assert.equal(offer.feeRatePpm, 4110);
  assert.equal(s.magma.count("UpdateOffer"), 0);
});

test("OFFER-7: no sale history — five made-up listings at 1 ppm do not pull the price down", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  asks(s, () => 4000, 3);
  asks(s, () => 1, 5, { baseFeeSats: 0, sellerScore: 0, filledOrders: 0, totalSats: 300_000, maxSats: 300_000 });
  const offer = s.magma.addOffer(OFFER);
  const { r } = await recOf(s, offer.id);
  assert.equal(r.state, "market_unknown");
  await s.autopilot.runOnce();
  assert.equal(offer.feeRatePpm, 4110);
  assert.equal(s.magma.count("UpdateOffer"), 0);
});

test("OFFER-7: no sale history and no offer — an unknown market lists nothing on its own", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  asks(s, () => 4000, 3);
  const rep = await s.autopilot.magmaReport();
  assert.equal(rep.sell.state, "market_unknown");
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 0);
});

test("OFFER-7: no sale history, eight comparable listings far above the offer — the price follows them a quarter at a time, one step every six hours, not in one jump and not a step a run (R2-4)", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  asks(s, (i) => 9000 + i * 100);
  const offer = s.magma.addOffer(OFFER);
  const eff = () => effective(offer);
  const start = eff();
  await s.autopilot.runOnce();
  const first = eff();
  assert.ok(first > start, `raised: ${Math.round(start)} -> ${Math.round(first)}`);
  assert.ok(first <= start * 1.25 + 1, `by no more than a quarter: ${Math.round(start)} -> ${Math.round(first)}`);
  // The runs of the next hours: the engine still wants more, nothing is written.
  // (Before: 2,966 -> 9,400 ppm in six runs, three hours, on listings alone.)
  for (let i = 0; i < 5; i++) await s.autopilot.runOnce();
  assert.equal(eff(), first, "no second step within six hours");
  assert.equal(s.magma.count("UpdateOffer"), 1);
  const { r } = await recOf(s, offer.id);
  assert.equal(r.shouldReprice, true);
  assert.ok(
    r.reasons.includes("read from listed offers, the price moves 25% at a time at most — the rest follows in further steps, one every 6 hours"),
    r.reasons.join(" | "),
  );
  const [note] = s.autopilot.offerSyncStatus().offers[0]!.differences;
  assert.match(
    note ?? "",
    /^not repriced yet: there is no sale history to price from, and the price follows listed offers one step every 6 hours \(a quarter at most\) — the next one is due \d\d:\d\d UTC$/,
  );
  // Six hours on: the next step, a quarter again.
  const movedAt = (s.autopilot as unknown as { listedMoveAt: Map<string, number> }).listedMoveAt;
  movedAt.set(offer.id, Date.now() - LISTED_MOVE_HOLD_MS - 1000);
  await s.autopilot.runOnce();
  const second = eff();
  assert.ok(second > first && second <= first * 1.25 + 1, `and again: ${Math.round(first)} -> ${Math.round(second)}`);
  await s.autopilot.runOnce();
  assert.equal(eff(), second, "and the hold starts anew");
});

test("R2-4: the six-hour hold is for a price read from listings only — with sale history a price that moved follows at once, also right after a listing-based step", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  asks(s, (i) => 9000 + i * 100);
  const offer = s.magma.addOffer(OFFER);
  await s.autopilot.runOnce();
  assert.equal(s.magma.count("UpdateOffer"), 1, "one listing-based step");
  const movedAt = (s.autopilot as unknown as { listedMoveAt: Map<string, number> }).listedMoveAt;
  const stepAt = movedAt.get(offer.id);
  assert.ok(stepAt, "which starts the hold");
  movedAt.set(offer.id, stepAt - 1000);
  // Sales arrive: buyers pay 4,110 ppm, far under where the listings pull.
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  await s.autopilot.runOnce();
  assert.equal(s.magma.count("UpdateOffer"), 2, "priced from the sales in the next run");
  assert.equal(movedAt.get(offer.id), stepAt - 1000, "and a price from sales starts no hold of its own");
  assert.ok(Math.abs(effective(offer) - 4110) <= 2, `at what buyers pay: ${Math.round(effective(offer))}`);
});

test("R2-4: the six-hour hold never keeps a price under the profit floor — on-chain fees rise right after a listing-based step and the price is lifted at once", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  asks(s, (i) => 9000 + i * 100);
  const offer = s.magma.addOffer(OFFER);
  await feeRate(s, 250);
  await s.autopilot.runOnce();
  const first = effective(offer);
  assert.equal(s.magma.count("UpdateOffer"), 1, "one listing-based step");
  await s.autopilot.runOnce();
  assert.equal(effective(offer), first, "held");
  // 16 sat/vB: a channel now costs more than the offer's typical order pays.
  await feeRate(s, 4000);
  await s.autopilot.runOnce();
  const lifted = effective(offer);
  assert.match(String(s.autopilot.offerSyncStatus().offers[0]?.lastWrite?.reason), /^below its profit floor \(8,439 ppm effective\) — raised to/);
  assert.ok(lifted > first * 1.25 + 1, `lifted past a quarter, to the floor: ${Math.round(first)} -> ${Math.round(lifted)}`);
});

test("R2-4: an offer taken off the market while the wallet is empty and listed again inside the six hours comes back at the price it has — a relist is not one more step", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SELLER_CFG, sellAutoRelist: true } });
  asks(s, (i) => 9000 + i * 100);
  const offer = s.magma.addOffer(OFFER);
  await s.autopilot.runOnce();
  const first = effective(offer);
  assert.equal(s.magma.count("UpdateOffer"), 1, "one listing-based step, which starts the hold");
  // Three dips of the wallet. (Before: each relist was one more quarter step —
  // 4,512 to 9,802 ppm in four of them, inside one hold.)
  for (let dip = 1; dip <= 3; dip++) {
    s.node.chainBalance = 0;
    await s.autopilot.runOnce();
    assert.equal(offer.status, "DISABLED", `dip ${dip}: nothing to fund a channel with — off the market`);
    s.node.chainBalance = 20_000_000;
    await s.autopilot.runOnce();
    assert.equal(offer.status, "ENABLED", `dip ${dip}: listed again`);
    assert.equal(effective(offer), first, `dip ${dip}: at the price it had`);
  }
  // Six hours after the step the relist takes the next one, and that one holds too.
  const movedAt = (s.autopilot as unknown as { listedMoveAt: Map<string, number> }).listedMoveAt;
  movedAt.set(offer.id, Date.now() - LISTED_MOVE_HOLD_MS - 1000);
  s.node.chainBalance = 0;
  await s.autopilot.runOnce();
  s.node.chainBalance = 20_000_000;
  await s.autopilot.runOnce();
  const second = effective(offer);
  assert.equal(offer.status, "ENABLED");
  assert.ok(second > first && second <= first * 1.25 + 1, `the next step: ${Math.round(first)} -> ${Math.round(second)}`);
  await s.autopilot.runOnce();
  assert.equal(effective(offer), second, "and the hold starts anew");
});

test("R2-4: a listing-based step Amboss refuses starts no hold and is tried again; one Amboss applies without answering starts it all the same — no second step the run after", async (t) => {
  quiet(t);
  const saved = HTTP_TIMEOUTS.ambossMutationMs;
  HTTP_TIMEOUTS.ambossMutationMs = 300;
  t.after(() => {
    HTTP_TIMEOUTS.ambossMutationMs = saved;
  });
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  asks(s, (i) => 9000 + i * 100);
  const offer = s.magma.addOffer(OFFER);
  const start = effective(offer);
  s.magma.behave.UpdateOffer = "false";
  await s.autopilot.runOnce();
  assert.equal(effective(offer), start, "refused: the price is as it was");
  const sent = s.magma.count("UpdateOffer");
  assert.ok(sent >= 1, "the step was sent");
  // The same step again — this time Amboss applies it and never answers.
  s.magma.behave.UpdateOffer = "apply-then-hang";
  await s.autopilot.runOnce();
  assert.ok(s.magma.count("UpdateOffer") > sent, "a refused step starts no hold: it is tried again the next run");
  const first = effective(offer);
  assert.ok(first > start && first <= start * 1.25 + 1, `applied: ${Math.round(start)} -> ${Math.round(first)}`);
  // (Before: no hold, and the next run took a second quarter step.)
  s.magma.behave.UpdateOffer = "ok";
  const before = s.magma.count("UpdateOffer");
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.equal(effective(offer), first, "no second step within six hours");
  assert.equal(s.magma.count("UpdateOffer"), before);
  assert.match(String(s.autopilot.offerSyncStatus().offers[0]?.differences.join(" | ")), /not repriced yet: there is no sale history to price from/);
});

test("OFFER-4: what the smallest order has to pay — the floor with the margin's room, or the floor plus the minimum profit and the service fee on it where that is more", () => {
  // A low floor: 325 sat × 1.25 = 406 sat is less than 325 + 500 sat profit, and the 1 % service fee comes on top.
  assert.equal(smallestOrderPaysSat(325, 1.25, 0.01), 831);
  assert.equal(smallestOrderPaysSat(325, 1.25, 0), 825);
  // A high floor: the margin is the larger term.
  assert.equal(smallestOrderPaysSat(4000, 1.25, 0), 5000);
});

// ── OFFER-6: a partly sold offer is priced like any other ────────────────────

for (const autoSize of [false, true]) {
  test(`OFFER-6: an offer part of whose listing is sold comes down with the market (auto-size ${autoSize ? "on" : "off"}, auto-relist off)`, async (t) => {
    quiet(t);
    const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SELLER_CFG, sellAutoSize: autoSize, sellAutoRelist: false } });
    history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
    asks(s, (i) => 3000 + i * 300);
    // 3M listed, 2M of it sold: 1M is still for sale and orders of 250k–1M fit.
    const offer = s.magma.addOffer({ ...OFFER, totalSats: 3_000_000, lockedSats: 2_000_000, feeRatePpm: 6000 });
    const { r } = await recOf(s, offer.id);
    assert.equal(r.state, "overpriced", "not 'exhausted': it still takes orders");
    assert.equal(r.shouldReprice, true);
    await s.autopilot.runOnce();
    assert.equal(offer.status, "ENABLED");
    assert.ok(Math.abs(effective(offer) - 4110) <= 2, `down from 6,402 ppm effective to the 4,110 buyers pay: ${offer.feeRatePpm} ppm + ${offer.baseFeeSats} sat`);
    assert.equal(offer.totalSats - offer.lockedSats, 1_000_000, "and nothing is listed again");
  });
}

test("OFFER-6: a partly sold offer is not rewritten for a move of a hair — the market 1.4 % above its price changes nothing", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SELLER_CFG, sellAutoRelist: false } });
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.079))); // 6,493 ppm for 30 days
  asks(s, (i) => 3000 + i * 300);
  const offer = s.magma.addOffer({ ...OFFER, totalSats: 3_000_000, lockedSats: 2_000_000, feeRatePpm: 6000 }); // 6,402 ppm effective
  const { r } = await recOf(s, offer.id);
  assert.equal(r.state, "well_priced");
  await s.autopilot.runOnce();
  assert.equal(offer.feeRatePpm, 6000);
  assert.equal(s.magma.count("UpdateOffer"), 0);
});

// ── OFFER-5: the minimum lease is the operator's ─────────────────────────────

test("OFFER-5: most sales are 60-day leases — auto-size leaves the offer's minimum lease at 30 days and prices it for 30", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SELLER_CFG, sellAutoSize: true } });
  history(t, [...Array.from({ length: 20 }, (_, i) => sale(i, 1_000_000, 0.05, 8640)), ...Array.from({ length: 15 }, (_, i) => sale(i, 1_000_000, 0.05, 4320))]);
  asks(s, (i) => 3000 + i * 300);
  const offer = s.magma.addOffer(OFFER);
  await s.autopilot.runOnce();
  assert.equal(offer.minBlockLength, 4320);
  assert.equal(offer.feeRatePpm, 4110, "5 %/yr for 30 days, not for 60");
  const write = s.autopilot.offerSyncStatus().offers[0]?.lastWrite;
  assert.ok(!write?.changed?.includes("min_block_length"), JSON.stringify(write));
});

// ── OFFER-2: auto-relist off means off ───────────────────────────────────────

test("OFFER-2: auto-relist off — a reshape of the size window does not list again what a sale took, now or after the mempool moves", async (t) => {
  quiet(t);
  const cfg = { sellAutoReprice: true, sellAutoSize: true, sellAutoRelist: false, sellMaxDeploySats: 10_000_000, sellMaxChannelSats: 2_000_000 };
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  // (a) The window is out of shape (min 250k, the engine wants more): it is reshaped — and the 1M left stays 1M.
  const a = sellerSetup(t, { chainBalance: 20_000_000, config: cfg });
  asks(a, (i) => 3000 + i * 300);
  const offA = a.magma.addOffer({ ...OFFER, totalSats: 3_000_000, lockedSats: 2_000_000 });
  await a.autopilot.runOnce();
  const write = a.autopilot.offerSyncStatus().offers[0]?.lastWrite;
  assert.ok(write?.changed?.includes("min_size"), `the window was reshaped: ${JSON.stringify(write)}`);
  assert.match(String(write?.reason), /auto-relist is off: what was sold is not listed again/);
  assert.equal(offA.totalSats, 3_000_000);
  assert.equal(offA.totalSats - offA.lockedSats, 1_000_000, "still 1M for sale");

  // (b) The same offer with the window in shape, then a fee move that reshapes it.
  const b = sellerSetup(t, { chainBalance: 20_000_000, config: cfg });
  asks(b, (i) => 3000 + i * 300);
  const offB = b.magma.addOffer({ ...OFFER, minSats: 500_000, feeRatePpm: 3826, totalSats: 3_000_000, lockedSats: 2_000_000 });
  await b.autopilot.runOnce();
  assert.equal(offB.totalSats - offB.lockedSats, 1_000_000);
  await feeRate(b, 2500); // 10 sat/vB: the smallest channel that pays grows
  await b.autopilot.runOnce();
  assert.ok(offB.minSats > 500_000, `the window was reshaped (min ${offB.minSats})`);
  assert.equal(offB.totalSats - offB.lockedSats, 1_000_000, "a fee move lists nothing again either");
});

// ── OFFER-4, OFFER-10: the smallest listed order clears the lane's floor with room ──

test("OFFER-10: the fee estimate rises 20 % after the run — an order at exactly the listed minimum is still accepted", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SELLER_CFG, sellAutoSize: true } });
  const floor = await feeRate(s, 2500); // 10 sat/vB
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  asks(s, (i) => 3000 + i * 300);
  const offer = s.magma.addOffer(OFFER);
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  const pays = paysAtMin(offer);
  assert.ok(pays >= Math.ceil(floor * COVER_WRITE_MARGIN), `the listed minimum pays ${pays}, a quarter over the lane's floor ${floor}`);
  const floor2 = await feeRate(s, 3000); // 12 sat/vB ten minutes later
  assert.ok(floor2 > floor);
  const order = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: offer.minSats, feeSeller: String(pays), timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(order.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted");
});

test("OFFER-10: a 40 % rise is more than the margin — the order is turned down, and the next run lifts the minimum to cover the new floor", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SELLER_CFG, sellAutoSize: true } });
  await feeRate(s, 2500);
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  asks(s, (i) => 3000 + i * 300);
  const offer = s.magma.addOffer(OFFER);
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  const pays = paysAtMin(offer);
  const minBefore = offer.minSats;
  const floor2 = await feeRate(s, 3500); // 14 sat/vB
  const order = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: offer.minSats, feeSeller: String(pays), timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(order.id)?.status, "SELLER_REJECTED", "below the lane's floor: never opened at a loss");
  await s.autopilot.runOnce();
  assert.ok(offer.minSats > minBefore, `minimum ${minBefore} -> ${offer.minSats}`);
  assert.ok(paysAtMin(offer) >= Math.ceil(floor2 * COVER_KEEP_MARGIN), `the minimum pays ${paysAtMin(offer)} against a floor of ${floor2}`);
});

for (const satPerKw of [250, 2500, 12_500]) {
  test(`OFFER-4: a floor-bound price at ${satPerKw / 250} sat/vB — the smallest order the offer takes pays the lane's floor with room, not break-even`, async (t) => {
    quiet(t);
    const s = sellerSetup(t, { chainBalance: 20_000_000, config: { sellAutoReprice: true, sellAutoSize: true, sellPricingMode: "fast", sellMaxChannelSats: 10_000_000 } });
    const floor = await feeRate(s, satPerKw);
    // Sales clear low, so the price is bound by the profit floor.
    history(t, Array.from({ length: 30 }, (_, i) => sale(i, 2_000_000, i < 10 ? 0.012 : 0.03)));
    asks(s, (i) => 3000 + i * 300);
    const offer = s.magma.addOffer({ ...OFFER, maxSats: 10_000_000, totalSats: 10_000_000 });
    await s.autopilot.runOnce();
    await s.autopilot.runOnce();
    assert.equal(offer.status, "ENABLED");
    const pays = paysAtMin(offer);
    assert.ok(pays >= Math.ceil(floor * COVER_KEEP_MARGIN), `min ${offer.minSats} pays ${pays} against the lane's floor ${floor}`);
    // And the lane takes it.
    const order = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: offer.minSats, feeSeller: String(pays), timeout: IN_AN_HOUR() });
    await s.autopilot.pollSellOrders();
    assert.equal(s.magma.sales.get(order.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  });
}

test("R2-5: auto-relist off and less left than any order that pays for its channel — the minimum goes above the listing once, with the reason; after that the offer is left alone: no price that follows the market, no second raise, not taken off the market", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SELLER_CFG, sellAutoSize: true, sellAutoRelist: false } });
  market(t, s);
  await feeRate(s, 2500);
  // 2.3M listed, 2M of it sold: 300k is left, and at 10 sat/vB an order has to
  // be 540k to pay for its channel at the price the offer goes to.
  const offer = s.magma.addOffer({ ...OFFER, totalSats: 2_300_000, lockedSats: 2_000_000 });
  await s.autopilot.runOnce();
  assert.equal(s.magma.count("UpdateOffer"), 1);
  const first = s.autopilot.offerSyncStatus().offers[0]!.lastWrite!;
  assert.match(
    String(first.reason),
    /min channel raised to 540,000 sat: at today's fee rate a smaller order pays less than opening and closing its channel costs \(3,250 sat\) — the order lane would turn it down\. Less than that is still listed and auto-relist is off: the offer sells nothing until you list more$/,
  );
  assert.deepEqual([offer.minSats, offer.totalSats - offer.lockedSats, offer.status], [540_000, 300_000, "ENABLED"], "the minimum is above what is listed, and nothing is listed again");
  const priced = [offer.feeRatePpm, offer.baseFeeSats];
  // The window the engine prices for is another one now, and it would take the
  // price down again (and the minimum up a second time). Nothing can be
  // ordered from the offer, so it stays as it is.
  const { r } = await recOf(s, offer.id);
  assert.equal(r.shouldReprice, true, "the engine would move the price");
  for (let i = 0; i < 4; i++) await s.autopilot.runOnce();
  assert.equal(s.magma.count("UpdateOffer"), 1, "one write, then none");
  assert.deepEqual([offer.feeRatePpm, offer.baseFeeSats, offer.minSats, offer.status], [...priced, 540_000, "ENABLED"]);
  assert.deepEqual(s.autopilot.offerSyncStatus().offers[0]!.differences, [
    "not repriced: less is listed (300,000 sat) than its smallest order (540,000 sat) and auto-relist is off — it sells nothing until you list more, and is priced again then",
  ]);
  // On-chain fees rise by a third: an order would have to be bigger still.
  // There is nothing to order, so the minimum isn't raised a second time.
  const floor = await feeRate(s, 3300);
  assert.ok(paysAtMin(offer) < floor, `its smallest order (${paysAtMin(offer)} sat) no longer pays for a channel (${floor} sat)`);
  await s.autopilot.runOnce();
  assert.equal(s.magma.count("UpdateOffer"), 1, "no second raise");
  assert.deepEqual([offer.minSats, offer.status], [540_000, "ENABLED"]);
  await feeRate(s, 2500);
  // The operator lists more: it is an offer like any other again.
  offer.totalSats = 4_000_000;
  await s.autopilot.runOnce();
  assert.equal(s.magma.count("UpdateOffer"), 2, "priced and sized again once there is something to order");
  assert.ok(offer.minSats <= offer.totalSats - offer.lockedSats, `its smallest order (${offer.minSats}) fits what is listed`);
});

// ── OFFER-8: the offer the autopilot creates is one the lane accepts ─────────

for (const autoSize of [false, true]) {
  test(`OFFER-8: the offer the autopilot creates invites no order the lane turns down (fast mode, 10 sat/vB, auto-size ${autoSize ? "on" : "off"})`, async (t) => {
    quiet(t);
    const s = sellerSetup(t, { chainBalance: 20_000_000, config: { sellAutoReprice: true, sellAutoSize: autoSize, sellPricingMode: "fast", sellMaxChannelSats: 10_000_000 } });
    const floor = await feeRate(s, 2500);
    history(t, [...Array.from({ length: 18 }, (_, i) => sale(i, 2_000_000, 0.05)), ...Array.from({ length: 12 }, (_, i) => sale(i, 3_000_000, 0.028))]);
    for (let i = 0; i < 8; i++)
      s.market.addOffer({ totalSats: 20_000_000, minSats: 250_000, maxSats: 10_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: 284, sellerScore: i * 5, filledOrders: 30, monthsListed: 6 });
    for (let i = 0; i < 6; i++) s.market.addOffer({ totalSats: 1_000_000, minSats: 250_000, maxSats: 1_000_000, feeRatePpm: 3500, baseFeeSats: 284, sellerScore: 1, filledOrders: 0 });
    await s.autopilot.runOnce();
    assert.equal(creates(s).length, 1, s.autopilot.getState().decisions.magma?.text);
    const input = creates(s)[0]!.variables.input as Record<string, number>;
    const pays = Math.floor((input.fee_rate! * input.min_size!) / 1e6 + input.base_fee!);
    assert.ok(pays >= Math.ceil(floor * COVER_WRITE_MARGIN), `the smallest listed order pays ${pays} against the lane's floor ${floor}`);
    // The next run finds nothing to mend on the offer it made.
    const created = [...s.magma.offers.values()][0]!;
    await s.autopilot.runOnce();
    assert.equal(created.minSats, input.min_size);
    assert.equal(s.magma.count("UpdateOffer"), 0, JSON.stringify(s.autopilot.offerSyncStatus().offers[0]?.lastWrite));
    // And the lane takes the smallest order it invites.
    const order = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: input.min_size!, feeSeller: String(pays), timeout: IN_AN_HOUR() });
    await s.autopilot.pollSellOrders();
    assert.equal(s.magma.sales.get(order.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted");
  });
}

// ── Two margins and a ceiling: a minimum written, a minimum that stands ──────
//
// (Review of the package, R2-1 and R2-2.) A minimum written now gets the
// write margin's room over the lane's floor; one the offer already has stands
// while its smallest order pays the keep margin, and — where auto-size would
// take it lower — while it pays no more than the relax margin.

/** One autopilot run per fee estimate (sat/kw): the lane's floor, the offer's minimum, what its smallest order pays against the floor, and whether the run wrote. */
const drive = async (
  s: S,
  offer: { minSats: number; feeRatePpm: number; baseFeeSats: number },
  kws: number[],
  o: { hoursBetweenRuns?: boolean } = {},
) => {
  const runs: { kw: number; floor: number; min: number; ratio: number; wrote: number }[] = [];
  for (const kw of kws) {
    // (A floor the mempool raised is held for six hours; with hours between
    // the runs that hold is over each time.)
    if (o.hoursBetweenRuns) (s.autopilot as unknown as { offerFloorRaisedAt: Map<string, number> }).offerFloorRaisedAt.clear();
    const floor = await feeRate(s, kw);
    const before = s.magma.count("UpdateOffer");
    await s.autopilot.runOnce();
    runs.push({ kw, floor, min: offer.minSats, ratio: paysAtMin(offer) / floor, wrote: s.magma.count("UpdateOffer") - before });
  }
  return runs;
};
const show = (runs: { kw: number; min: number; ratio: number; wrote: number }[]) =>
  runs.map((r) => `${r.kw}: min ${r.min} ×${r.ratio.toFixed(3)}${r.wrote ? " WROTE" : ""}`).join(" | ");
const SIZED_CFG = { sellAutoReprice: true, sellAutoSize: true, sellMaxChannelSats: 10_000_000 };
const WIDE_OFFER = { ...OFFER, maxSats: 10_000_000, totalSats: 10_000_000 };
const market = (t: { after(fn: () => void): void }, s: S, apr = 0.05, askExtra: Record<string, unknown> = {}) => {
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, apr)));
  asks(s, (i) => 3000 + i * 300, 8, askExtra);
};

test("R2-1: a small wallet — the offer the autopilot creates still gives its smallest order the write margin's room, and a fee estimate 2 % higher rewrites nothing", async (t) => {
  quiet(t);
  // 1.7M on chain: the size that pays the write margin can be funded, only just.
  const s = sellerSetup(t, { chainBalance: 1_700_000, config: { ...SIZED_CFG, sellPricingMode: "fast" } });
  market(t, s);
  const floor = await feeRate(s, 2500);
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 1, s.autopilot.getState().decisions.magma?.text);
  const created = [...s.magma.offers.values()][0]!;
  assert.ok(paysAtMin(created) >= Math.ceil(floor * COVER_WRITE_MARGIN), `min ${created.minSats} pays ${paysAtMin(created)} against the lane's floor ${floor}`);
  const runs = await drive(s, created, [2550, 2550]);
  assert.equal(s.magma.count("UpdateOffer"), 0, show(runs));
});

test("R2-1: auto-size moves the offer's minimum — the minimum it writes pays the write margin, not the keep margin, and the next 2 % rewrite nothing", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SIZED_CFG });
  // Sales clear at 2.54 %/yr and nobody charges a base fee: the smallest
  // channel worth selling is far above the offer's 250k, so the reshape
  // raises the minimum — into the band between the two margins.
  const apr = 0.0254;
  market(t, s, apr, { baseFeeSats: 0 });
  await feeRate(s, 2500);
  const offer = s.magma.addOffer({ ...WIDE_OFFER, feeRatePpm: Math.round((apr * 4320 * 1e6) / 52_560), baseFeeSats: 0 });
  const runs = await drive(s, offer, [2500, 2550, 2550]);
  assert.ok(runs[0]!.min > 250_000 && runs[0]!.wrote === 1, show(runs));
  assert.ok(runs[0]!.ratio >= COVER_WRITE_MARGIN, show(runs));
  assert.equal(runs[1]!.wrote + runs[2]!.wrote, 0, show(runs));
});

for (const [name, kw, offer] of [
  ["10 sat/vB", 2500, OFFER],
  ["40 sat/vB", 10_000, WIDE_OFFER],
] as const) {
  test(`R2-2: thirteen runs while the fee estimate creeps up 5 % and back (${name}) — the minimum is written once and stands`, async (t) => {
    quiet(t);
    const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SIZED_CFG, sellMaxChannelSats: offer.maxSats } });
    market(t, s);
    await feeRate(s, kw);
    const o = s.magma.addOffer(offer);
    const runs = await drive(s, o, [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0, -1, -2].map((p) => Math.round(kw * (1 + p / 100))));
    assert.equal(s.magma.count("UpdateOffer"), 1, show(runs));
    assert.ok(runs[0]!.ratio >= COVER_WRITE_MARGIN, show(runs));
    assert.ok(runs.every((r) => r.min === runs[0]!.min && r.ratio >= COVER_KEEP_MARGIN), show(runs));
  });
}

test("R2-2: the fee estimate rises 1.5 % a run for fourteen runs — the minimum is rewritten when its smallest order no longer pays the keep margin, once, back to the write margin", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SIZED_CFG });
  market(t, s);
  await feeRate(s, 10_000);
  const offer = s.magma.addOffer(WIDE_OFFER);
  const runs = await drive(s, offer, Array.from({ length: 14 }, (_, i) => Math.round(10_000 * 1.015 ** i)));
  // 21 % in all: the first run's minimum, and one more once the room is used up.
  assert.equal(s.magma.count("UpdateOffer"), 2, show(runs));
  assert.ok(runs.every((r) => r.ratio >= COVER_KEEP_MARGIN), `never under the keep margin after a run: ${show(runs)}`);
  const second = [...runs].reverse().find((r) => r.wrote)!;
  assert.ok(second.min > runs[0]!.min && second.ratio >= COVER_WRITE_MARGIN, show(runs));
  assert.match(String(s.autopilot.offerSyncStatus().offers[0]?.lastWrite?.reason), /min channel raised to/);
});

test("R2-1: the fee estimate falls 1.5 % a run for twenty runs, hours apart — the minimum comes down with it in a few steps, each back to the write margin, not in every run", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SIZED_CFG });
  market(t, s);
  await feeRate(s, 10_000);
  const offer = s.magma.addOffer(WIDE_OFFER);
  const runs = await drive(s, offer, Array.from({ length: 20 }, (_, i) => Math.round(10_000 * 0.985 ** i)), { hoursBetweenRuns: true });
  // 25 % down in all. The first run writes the minimum; after it the minimum
  // stands until its smallest order pays more than the relax margin.
  const writes = runs.filter((r) => r.wrote);
  assert.ok(writes.length >= 2 && writes.length <= 3, show(runs));
  assert.ok(runs.at(-1)!.min < runs[0]!.min, `the minimum came down: ${show(runs)}`);
  assert.ok(runs.every((r) => r.ratio >= COVER_KEEP_MARGIN && r.ratio <= COVER_RELAX_MARGIN + 0.02), show(runs));
  for (const w of writes) assert.ok(w.ratio >= COVER_WRITE_MARGIN && w.ratio < COVER_WRITE_MARGIN + 0.05, `each write lands at the write margin: ${show(runs)}`);
  assert.match(String(s.autopilot.offerSyncStatus().offers[0]?.lastWrite?.reason), /min channel lowered to/);
});

test("R2-1: a minimum the offer has stands only between the keep size and the relax size, and only where the capital funds a margin", () => {
  const want = { level: "margin" as const, keepSizeSat: 900_000, writeSizeSat: 1_000_000 };
  const relax = 1_150_000;
  assert.equal(standingMinimumStays(890_000, want, relax), false, "its smallest order pays less than the keep margin: set afresh");
  assert.equal(standingMinimumStays(900_000, want, relax), true);
  assert.equal(standingMinimumStays(1_150_000, want, relax), true);
  assert.equal(standingMinimumStays(1_160_000, want, relax), false, "more room than it needs: it comes down");
  assert.equal(standingMinimumStays(1_000_000, { ...want, level: "floor" }, relax), false, "no margin can be funded: the bare cover is written");
  // (Where the minimum profit, not the margin, sets all three sizes, they are one size.)
  assert.equal(standingMinimumStays(1_000_000, want, 950_000), true);
});

test("R2-9: an offer taken off the market below cost isn't listed again on a fee estimate a few percent lower — only once its largest order pays for its channel with room; fees moving 4 % around that point toggle nothing", async (t) => {
  quiet(t);
  // A wallet that funds an order of 1.44M at most; the offer's price is its own.
  const s = sellerSetup(t, { chainBalance: 1_500_000, config: { sellAutoReprice: false, sellAutoSize: true, sellMaxChannelSats: 10_000_000 } });
  market(t, s);
  const offer = s.magma.addOffer(OFFER);
  const at = async (kw: number) => {
    const floor = await feeRate(s, kw);
    await s.autopilot.runOnce();
    return floor;
  };
  await at(2500);
  await at(4600);
  assert.deepEqual([offer.status, s.magma.count("ToggleOffer")], ["ENABLED", 0], "18.4 sat/vB: its largest order still pays for its channel");
  // 19.2 sat/vB: no order it can fund pays for its channel.
  await at(4800);
  assert.deepEqual([offer.status, s.magma.count("ToggleOffer")], ["DISABLED", 1]);
  // Back and forth around that point (before: listed, taken off, listed, … a toggle a run).
  for (const kw of [4600, 4800, 4600, 4800, 4300]) {
    const floor = await at(kw);
    assert.deepEqual([offer.status, s.magma.count("ToggleOffer")], ["DISABLED", 1], `stays off the market at a floor of ${floor} sat`);
  }
  const why = s.autopilot.offerSyncStatus().offers[0]!.differences.join(" | ");
  assert.match(why, /^taken off the market by the autopilot below cost: at today's on-chain fee rate opening and closing a channel costs 5,590 sat, and not even its largest order pays that with room to spare \(12 % over it\)/);
  // Clearly lower: its largest order pays the keep margin over the floor — listed again.
  const floor = await at(4200);
  assert.deepEqual([offer.status, s.magma.count("ToggleOffer")], ["ENABLED", 2]);
  assert.ok(paysAtMin({ ...offer, minSats: offer.maxSats }) >= floor * COVER_KEEP_MARGIN, `its largest order pays ${paysAtMin({ ...offer, minSats: offer.maxSats })} for a floor of ${floor}`);
  await at(4300);
  await at(4600);
  assert.deepEqual([offer.status, s.magma.count("ToggleOffer")], ["ENABLED", 2], "and it stays listed on the way back up, as long as an order pays the bare floor");
});

// ── When the autopilot lists no offer of its own ────────────────────────────
//
// (Review of the package, R2-3 and R2-6.) The summary ("good to sell") spoke
// for the market; whether THIS wallet's offer is worth listing is what the
// engine says of the offer it would create — and without a fee estimate from
// LND nobody knows what a channel costs today.

const NO_ESTIMATE = (s: S) => {
  s.node.override("wallet.estimateFee", (_a: unknown, cb: unknown) => (cb as (e: unknown) => void)([503, "UnexpectedEstimateFeeError"]));
  (s.autopilot as unknown as { saleFloor: unknown }).saleFloor = null;
};

test("R2-3: the market is good to sell in, but at the channel size this wallet can fund the engine's advice for a new offer is 'do not list' — the autopilot lists none and says why", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 1_200_000, config: { ...SIZED_CFG, sellPricingMode: "fast" } });
  market(t, s);
  await feeRate(s, 2500);
  const rep = await s.autopilot.magmaReport();
  assert.equal(rep.sell.state, "good_to_sell", "the summary alone let it list");
  assert.equal(rep.sell.recommendations.find((r) => r.mode === "create")?.state, "do_not_list_uncompetitive");
  await s.autopilot.runOnce();
  // Before: an offer at 4,273 ppm + 284 sat, above what buyers pay.
  assert.equal(creates(s).length, 0);
  assert.equal(
    s.autopilot.getState().decisions.magma?.text,
    "no offer listed automatically: at the channel size this wallet can fund, the price that pays for a lease is above what buyers pay for comparable leases",
  );
  assert.equal(s.autopilot.getState().decisions.magma?.state, "idle");
});

test("R2-6: LND has never given a fee estimate (a first start) — the built-in costs are a guess: no offer is created on them, the decision says what is waited for, and the first estimate lists it", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  market(t, s);
  const rep = await s.autopilot.magmaReport();
  assert.deepEqual([rep.sell.onchainFeePerVbyte, rep.sell.lastKnownFeePerVbyte, rep.sell.feeEstimateMissing], [null, null, false], "no estimate, and none known");
  assert.equal(rep.sell.state, "good_to_sell");
  await s.autopilot.runOnce();
  // Before: created, costed at the built-in defaults whatever the mempool asks.
  assert.equal(creates(s).length, 0);
  assert.equal(
    s.autopilot.getState().decisions.magma?.text,
    "no offer listed for now: LND gives no on-chain fee estimate, so what a channel costs today isn't known — one is listed once the estimate is back",
  );
  assert.equal(s.autopilot.getState().decisions.magma?.state, "waiting");
  const floor = await feeRate(s, 2500); // 10 sat/vB
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 1, s.autopilot.getState().decisions.magma?.text);
  const created = [...s.magma.offers.values()][0]!;
  assert.ok(paysAtMin(created) >= Math.ceil(floor * COVER_WRITE_MARGIN), `sized for 10 sat/vB: min ${created.minSats} pays ${paysAtMin(created)} against the lane's floor ${floor}`);
});

test("R2-6: the estimate goes away after an offer was listed and comes back — nothing is created beside it, and nothing while it is away for a node with none", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  market(t, s);
  await feeRate(s, 2500);
  NO_ESTIMATE(s);
  for (let i = 0; i < 3; i++) await s.autopilot.runOnce();
  assert.equal(creates(s).length, 0, "a last known rate is no estimate");
  assert.match(String(s.autopilot.getState().decisions.magma?.text), /^no offer listed for now: LND gives no on-chain fee estimate/);
  await feeRate(s, 2500);
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 1, "one offer, once");
});

// ── OFFER-11: a floor-bound price does not follow every tick of the mempool ──

test("OFFER-11: twelve runs while the fee estimate creeps up 5 % and back — the floor-bound price is written once, and a real rise still lifts it", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { ...SELLER_CFG, sellAutoSize: false } });
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.01))); // sales clear low: the floor binds
  asks(s, (i) => 8000 + i * 300);
  const offer = s.magma.addOffer({ ...OFFER, minSats: 1_000_000, feeRatePpm: 3000 });
  const prices: number[] = [];
  for (const kw of [2500, 2525, 2550, 2575, 2600, 2625, 2600, 2575, 2550, 2525, 2500, 2400]) {
    await feeRate(s, kw);
    await s.autopilot.runOnce();
    prices.push(offer.feeRatePpm);
  }
  assert.equal(s.magma.count("UpdateOffer"), 1, `prices per run: ${prices.join(", ")}`);
  assert.ok(prices[0]! > 3000, "the one write lifts the price over the floor, with a margin");
  assert.ok(prices.every((p) => p === prices[0]), prices.join(", "));
  // 16 sat/vB: the floor is now above the price — it is raised.
  await feeRate(s, 4000);
  await s.autopilot.runOnce();
  assert.ok(offer.feeRatePpm > prices[0]!, `raised from ${prices[0]} to ${offer.feeRatePpm}`);
  assert.equal(s.magma.count("UpdateOffer"), 2);
});

// ── OFFER-12: only a lease that was sold is a sale ───────────────────────────

test("OFFER-12: an order Amboss returns as rejected, cancelled or unpaid is not a sale — it never enters the clearing price", async (t) => {
  quiet(t);
  initMagmaHistory(makeTempDir(t));
  const http = installFetchMock(t);
  const row = (daysAgo: number, lnr: string, status: string | null) => ({
    date: new Date(Date.now() - daysAgo * DAY).toISOString(),
    size: "1000000",
    block_duration: 4320,
    lnr,
    lny: lnr,
    status,
  });
  const sold = ["FINISHED", "FINISHED_EARLY", "ACTIVE", "NOT_MONITORED", null];
  const notSold = ["SELLER_REJECTED", "BUYER_REJECTED", "CANCELLED", "WAITING_FOR_BUYER_PAYMENT", "WAITING_FOR_SELLER_APPROVAL", "EXPIRED", "CHANNEL_OPENING_FAILED"];
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({
    data: {
      getMarketMetrics: {
        order_details: [
          // 15 leases sold at 5 %/yr, of every status a sold lease has (and one that names none) …
          ...Array.from({ length: 15 }, (_, i) => row(i, "0.05", sold[i % sold.length]!)),
          // … and 21 orders nobody paid for, at 60 %/yr.
          ...Array.from({ length: 21 }, (_, i) => row(i, "0.6", notSold[i % notSold.length]!)),
        ],
      },
    },
  }));
  t.after(() => __setHistoryForTests([]));
  await refreshMagmaHistory(true);
  const c = clearingFor({ minSizeSat: 250_000, maxSizeSat: 2_000_000, blocks: 4320 });
  assert.equal(c?.count, 15, "the 15 sold leases and no other row");
  assert.equal(c?.medianPpm, 4110);
  assert.equal(c?.p75Ppm, 4110, "no price nobody paid");
});

// ── OFFER-13: with no fee estimate, the engine and the lane use one cost ─────

test("OFFER-13: LND gives no fee estimate — a channel is costed at the last known rate as the lane does, the report says so, and no price is written and no offer created until it is back", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: SELLER_CFG });
  history(t, Array.from({ length: 30 }, (_, i) => sale(i, 1_000_000, 0.05)));
  asks(s, (i) => 3000 + i * 300);
  const floor = await feeRate(s, 2500); // 10 sat/vB, known once
  const withEstimate = await s.autopilot.magmaReport();
  assert.equal(withEstimate.sell.feeEstimateMissing, false);
  // The estimate goes away.
  s.node.override("wallet.estimateFee", (_a: unknown, cb: unknown) => (cb as (e: unknown) => void)([503, "UnexpectedEstimateFeeError"]));
  (s.autopilot as unknown as { saleFloor: unknown }).saleFloor = null;
  assert.equal(await s.autopilot.saleFeeFloorSats(), floor, "the lane holds its last known floor");
  const rep = await s.autopilot.magmaReport();
  assert.equal(rep.sell.feeEstimateMissing, true);
  assert.equal(rep.sell.lastKnownFeePerVbyte, 10);
  assert.equal(rep.sell.minViableSizeSat, withEstimate.sell.minViableSizeSat, "the same costs as with the estimate — not the built-in defaults");
  assert.equal(rep.sell.acceptFloorSat, floor, "and the smallest order is sized against the floor the lane holds, not the default one");
  assert.ok(floor > saleAcceptFloorSats(null, 0.01), "(the two differ at 10 sat/vB)");
  assert.ok(rep.sell.reasons.concat(rep.sell.warnings ?? []).some((x) => /LND gives no on-chain fee estimate right now/.test(x)));
  // No offer is created on a cost that is a guess …
  await s.autopilot.runOnce();
  assert.equal(creates(s).length, 0);
  assert.match(String(s.autopilot.getState().decisions.magma?.text), /no offer listed for now: LND gives no on-chain fee estimate/);
  // … and an offer that would be repriced keeps its price.
  const offer = s.magma.addOffer({ ...OFFER, minSats: 1_000_000, feeRatePpm: 9000 });
  const { r } = await recOf(s, offer.id);
  assert.equal(r.shouldReprice, false);
  assert.ok(r.reasons.concat(r.warnings).some((x) => /the price stays until it is back \(a channel is costed at the last known 10 sat\/vB\)/.test(x)), r.reasons.concat(r.warnings).join(" | "));
  await s.autopilot.runOnce();
  assert.equal(offer.feeRatePpm, 9000);
  // The estimate is back: the price moves.
  await feeRate(s, 2500);
  await s.autopilot.runOnce();
  assert.ok(offer.feeRatePpm < 9000, `repriced to ${offer.feeRatePpm}`);
});
