/**
 * Amboss's Magma lists don't page. Asked read-only on 2026-10-21, the public
 * offer list (market.offer.offers) answered all 98 offers, with total 98, for
 * offsets 0, 50, 100 and 150, and for limit 10 at offsets 20 and 50 — in an
 * order that can change between requests. Every reader walked pages until
 * (page + 1) × 50 ≥ total, so a list of 51–100 entries was read twice and one
 * of 101–150 three times.
 *
 * Before: the eligibility check (D8) showed every count doubled and its 95%
 * bound halved — for the owner's node "14 live, 0 ever sold; 0 fills in 68.4
 * offer-months (… at most ~0.044 at 95% confidence)" where the book held 7
 * offers, 34.2 offer-months and ≤ 0.088 — and a cell of 3 real offers counted
 * as 6, so it was never widened to its tier. An Amboss account with more than
 * 50 offers would have had each read, listed and upkept twice a run, had its
 * own (keyed) listing ignored the page the same way — which can't be checked
 * without a key. The book also counted two Taproot-asset (USDT) offers' 53
 * fills as bitcoin sales.
 * The fakes sliced pages, so no test could see any of it: now they answer the
 * whole list for every page, as the live endpoint does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { collectPages, getOffers, getPublicOffers } from "../src/services/amboss.js";
import { getMyOffers, listSales } from "../src/services/magmaApi.js";
import { assessEligibility, isBitcoinOffer, joinBook } from "../src/services/magmaEligibility.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMarket } from "./helpers/market.js";
import { FakeMagma } from "./helpers/magma.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";

const OTHER_NODE = "03" + "4e".repeat(32);
const unique = (ids: string[]) => new Set(ids).size;

test("the paging walk keeps each id once and stops when a page brings nothing new, once `total` ids are in, or at the page limit", async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: `i-${i}` }));
  // A list that ignores the page and under-delivers its total (98 claimed, 30 sent).
  let asked = 0;
  const short = await collectPages(async () => (asked++, { list: items, total: 98 }), (o) => o.id, { pageSize: 50, maxPages: 20 });
  assert.equal(short.items.length, 30);
  assert.equal(asked, 2, "the second page brought no new id: stop, not 20 requests");
  // A list that pages properly: 120 items over 3 pages, each once.
  const all = Array.from({ length: 120 }, (_, i) => ({ id: `p-${i}` }));
  const offsets: number[] = [];
  const paged = await collectPages(
    async (p) => (offsets.push(p.offset), { list: all.slice(p.offset, p.offset + p.limit), total: all.length }),
    (o) => o.id,
    { pageSize: 50, maxPages: 20 },
  );
  assert.deepEqual(offsets, [0, 50, 100]);
  assert.deepEqual(paged.items.map((o) => o.id), all.map((o) => o.id));
  // Bounded: a list that keeps bringing new ids stops at maxPages.
  let n = 0;
  const endless = await collectPages(async () => ({ list: [{ id: `e-${n++}` }], total: 1_000 }), (o) => o.id, { pageSize: 1, maxPages: 5 });
  assert.equal(endless.items.length, 5);
});

test("the public offer list is read once per offer when Amboss answers the whole list for every page — 60 offers: 60 entries, one request", async (t) => {
  const http = installFetchMock(t);
  const market = new FakeMarket(http, t);
  for (let i = 0; i < 60; i++) market.addOffer({ totalSats: 2_000_000 + i * 10_000, filledOrders: i < 3 ? 2 : 0 });
  const offers = await getPublicOffers();
  // Before: 120 entries (page 0 and page 1 both held all 60).
  assert.equal(offers.length, 60);
  assert.equal(unique(offers.map((o) => o.id)), 60);
  assert.equal(market.pagesAsked.length, 1, "60 distinct ids in = the total: done");
  // 130 offers (three pages' worth): each once too — before, three times.
  for (let i = 0; i < 70; i++) market.addOffer({ totalSats: 3_000_000 });
  const more = await getPublicOffers();
  assert.equal(more.length, 130);
  assert.equal(unique(more.map((o) => o.id)), 130);
  // Should Amboss start honouring the page, the walk pages through.
  market.paging = "pages";
  market.pagesAsked.length = 0;
  const paged = await getPublicOffers();
  assert.equal(paged.length, 130);
  assert.deepEqual(market.pagesAsked.map((p) => p.offset), [0, 50, 100]);
});

test("GET /amboss/eligibility reports the book's exact counts with more than 50 offers listed — offers, sold, fills, offer-months and the 95% bound", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const market = new FakeMarket(http, t);
  // This node's tier (Amboss fee 1,000: listings above 1M): six offers at
  // seller score 2 that never sold, and six at score 40 — three of which
  // filled two orders each. All listed six months ago.
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 2_000_000 + i * 100_000, sellerScore: 2, filledOrders: 0, monthsListed: 6 });
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 3_000_000, sellerScore: 40, filledOrders: i < 3 ? 2 : 0, monthsListed: 6 });
  // Other tiers, enough to need a second page: 57 offers in all.
  for (let i = 0; i < 25; i++) market.addOffer({ totalSats: 1_000_000, sellerScore: 1 });
  for (let i = 0; i < 20; i++) market.addOffer({ totalSats: 20_000_000, sellerScore: 50, filledOrders: 4 });
  market.ownScore = 5.22;
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 1_400_000 }) });
  const res = await api.request("GET", "/amboss/eligibility");
  assert.equal(res.status, 200);
  const e = res.body;
  assert.equal(e.tier.ambossFee, 1000);
  assert.deepEqual(e.scoreSplit, { median: 21, side: "at_or_below" });
  // Before: 12 offers, 72 offer-months, at most ~0.042 — every offer twice.
  assert.deepEqual(e.comparable, { offers: 6, sold: 0, fills: 0, offerMonths: 36, fillsPerMonth: 0, upperBoundPerMonth: 0.083 });
  assert.deepEqual(e.otherSide, { offers: 6, sold: 3, fills: 6, offerMonths: 36, fillsPerMonth: 0.167, upperBoundPerMonth: null });
  assert.equal(e.widened, false);
  assert.equal(e.verdict, "not_realistic");
  assert.match(e.reasons[0], /: 6 live, 0 ever sold; 0 fills in 36 offer-months \(~0\.000 a month per offer, at most ~0\.083 at 95% confidence\)\.$/);
  assert.match(e.reasons[1], /the same tier with higher seller scores: 6 offers, 3 sold, ~0\.17 fills a month per offer\.$/);
});

test("a cell of three offers is too small to say anything — widened to its whole tier, however many pages the list takes", async (t) => {
  const http = installFetchMock(t);
  const market = new FakeMarket(http, t);
  // This node's tier (fee 1,000): seller scores 1, 3 and 10 — at or below
  // the median (10), none sold — and 40 and 50, which sold.
  for (const score of [1, 3, 10]) market.addOffer({ totalSats: 2_000_000, sellerScore: score, filledOrders: 0 });
  for (const score of [40, 50]) market.addOffer({ totalSats: 3_000_000, sellerScore: score, filledOrders: 1 });
  // 1M listings (fee 1,500), enough for a second page.
  for (let i = 0; i < 46; i++) market.addOffer({ totalSats: 1_000_000, sellerScore: 1 });
  const [legacy, live] = await Promise.all([getOffers(), getPublicOffers()]);
  const book = {
    fetchedAt: new Date().toISOString(),
    offers: joinBook(legacy, live),
    inboundSatsPerUsd: null,
    own: { pubkey: "02" + "aa".repeat(32), sellerScore: 5.22, confirmedSells: 0 },
  };
  const e = assessEligibility(book, { listableSat: 1_500_000, maxChannelSat: 1_500_000 });
  assert.deepEqual(e.scoreSplit, { median: 10, side: "at_or_below" });
  // Before: the three counted as six — not widened, "0 of 6 sold".
  assert.equal(e.widened, true);
  assert.deepEqual([e.comparable?.offers, e.comparable?.sold, e.comparable?.fills], [5, 2, 2]);
});

test("the book counts an offer once, whatever a list repeated — the counts shown don't hang on the reader alone", () => {
  const live = { id: "x", status: "ENABLED", sellerPubkey: OTHER_NODE, createdAt: new Date().toISOString(), filledOrders: 2, totalSizeSats: 2_000_000, ambossFee: 1000, assetType: "BASE_ASSET" };
  const offers = joinBook([], [live, { ...live }, { ...live, id: "y" }]);
  assert.deepEqual(offers.map((o) => o.id), ["x", "y"]);
});

test("offers of other assets are not part of the book — two Taproot-asset (USDT) offers' 53 fills are no bitcoin sales, in no cell and no fee tier", async (t) => {
  const http = installFetchMock(t);
  const market = new FakeMarket(http, t);
  // The 350 tier (listings above 50M): four bitcoin offers that never sold …
  for (let i = 0; i < 4; i++) market.addOffer({ totalSats: 60_000_000 + i * 1_000_000, sellerScore: 10 + i, filledOrders: 0 });
  // … and, as on the live list, two USDT channel offers: no satoshi total,
  // Amboss fee 350, many fills (39 and 14).
  market.addOffer({ asset: "TAPROOT_ASSET", ambossFee: 350, filledOrders: 39, monthsListed: 6, sellerScore: 0 });
  market.addOffer({ asset: "TAPROOT_ASSET", ambossFee: 350, filledOrders: 14, monthsListed: 2, sellerScore: 0 });
  const [legacy, live] = await Promise.all([getOffers(), getPublicOffers()]);
  assert.equal(live.length, 6, "the reader passes every offer on, with its asset");
  assert.equal(live.filter((o) => o.assetType === "TAPROOT_ASSET").length, 2);
  const offers = joinBook(legacy, live);
  assert.equal(offers.length, 4, "bitcoin offers only");
  const e = assessEligibility(
    { fetchedAt: new Date().toISOString(), offers, inboundSatsPerUsd: null, own: { pubkey: "02" + "aa".repeat(32), sellerScore: 5, confirmedSells: 0 } },
    { listableSat: 60_000_000, maxChannelSat: 10_000_000 },
  );
  // Before: the widened 350 cell held six offers, two "sold", 53 fills — a
  // seller like this one looked 'realistic'.
  assert.equal(e.widened, true);
  assert.deepEqual([e.comparable?.offers, e.comparable?.sold, e.comparable?.fills], [4, 0, 0]);
  assert.equal(e.verdict, "not_realistic");
  assert.deepEqual(e.feeTiers, [{ ambossFeePpm: 350, upToSats: null }]);
  // The rule: a bitcoin offer is BASE_ASSET with a satoshi total; no asset
  // named counts as bitcoin when there is one.
  assert.equal(isBitcoinOffer({ assetType: "TAPROOT_ASSET", totalSizeSats: 2_000_000 }), false, "another asset, even with a sats figure");
  assert.equal(isBitcoinOffer({ assetType: "BASE_ASSET", totalSizeSats: 0 }), false, "no satoshi total: nothing to compare");
  assert.equal(isBitcoinOffer({ assetType: null, totalSizeSats: 2_000_000 }), true);
  assert.equal(isBitcoinOffer({ assetType: "BASE_ASSET", totalSizeSats: 2_000_000 }), true);
});

test("an account with more than 50 offers: each of this node's offers is read once, listed once on Market → Sell and upkept once a run", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  for (let i = 0; i < 60; i++) s.magma.addOffer({ id: `own-${i}`, totalSats: 1_000_000, minSats: 1_000_000, maxSats: 1_000_000 });
  // Another node of the same account: not ours to read or manage.
  for (let i = 0; i < 5; i++) s.magma.addOffer({ id: `other-${i}`, pubkey: OTHER_NODE });
  const mine = await getMyOffers("test-key", s.node.publicKey);
  // Before: 120 — the listing read twice, every offer read in full twice.
  assert.equal(mine.length, 60);
  assert.equal(unique(mine.map((o) => o.id)), 60);
  assert.equal(s.magma.count("MyOfferIds"), 1);
  assert.equal(s.magma.count("MyOffer"), 60, "only this node's offers are read in full, each once");
  // The run's upkeep walks each offer once: one sync entry per offer.
  await s.autopilot.runOnce();
  const entries = s.autopilot.offerSyncStatus().offers;
  assert.equal(entries.length, 60);
  assert.equal(unique(entries.map((e) => e.offerId)), 60);
  assert.ok(entries.every((e) => e.offerId.startsWith("own-")));
  // A listing that pages properly reads the same offers.
  s.magma.paging = "pages";
  const paged = await getMyOffers("test-key", s.node.publicKey);
  assert.deepEqual(paged.map((o) => o.id).sort(), mine.map((o) => o.id).sort());
});

test("GET /amboss/my-offers lists each of 60 offers once", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 1_000_000 }) });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  for (let i = 0; i < 60; i++) magma.addOffer({ id: `own-${i}` });
  const res = await api.request("GET", "/amboss/my-offers");
  assert.equal(res.status, 200);
  assert.equal(res.body.offers.length, 60);
  assert.equal(unique(res.body.offers.map((o: { id: string }) => o.id)), 60);
});

test("the sales listing is read once per order too — 60 sales, whole list or pages", async (t) => {
  const s = sellerSetup(t);
  for (let i = 0; i < 60; i++) s.magma.addSale({ buyerPubkey: BUYER, status: "VALID_CHANNEL_OPENING" });
  const whole = await listSales("test-key");
  assert.equal(whole.orders.length, 60);
  assert.equal(unique(whole.orders.map((o) => o.id)), 60);
  assert.equal(whole.total, 60);
  s.magma.paging = "pages";
  const paged = await listSales("test-key");
  assert.deepEqual(paged.orders.map((o) => o.id), whole.orders.map((o) => o.id), "same orders, same order (newest first)");
  // An order arriving between two page reads shifts a newest-first list by
  // one: the second page starts with the last order of the first. Before,
  // that order was listed twice (and the walk stopped, "61 of 61").
  let reads = 0;
  s.magma.salesList = () => {
    if (reads++ === 1) s.magma.addSale({ buyerPubkey: BUYER });
    return null;
  };
  const shifted = await listSales("test-key");
  assert.equal(unique(shifted.orders.map((o) => o.id)), shifted.orders.length, "no order twice");
  assert.deepEqual(shifted.orders.map((o) => o.id), whole.orders.map((o) => o.id), "the newcomer comes with the next listing");
});
