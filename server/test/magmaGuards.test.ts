/**
 * Two small guards of P1b without a test of their own (review of f6c56b2,
 * carried into P2): the public offer book is read again once it is a day old
 * (magmaEligibility.ts), and offers that fit the buyer's size rank before
 * cheaper ones that don't (rankBuyOffers, magmaBuy.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { __ageBookForTests, __resetEligibilityCache, publicBook } from "../src/services/magmaEligibility.js";
import { rankBuyOffers, type BuyerFacts } from "../src/services/magmaBuy.js";
import type { MagmaOffer } from "../src/services/amboss.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMarket } from "./helpers/market.js";

const OWN = "02" + "aa".repeat(32);

test("the public offer book is cached for a day — and read again once it is older", async (t) => {
  __resetEligibilityCache();
  t.after(() => __resetEligibilityCache());
  const http = installFetchMock(t);
  const market = new FakeMarket(http, t);
  market.addOffer({ totalSats: 20_000_000, sellerScore: 40, filledOrders: 2 });
  const first = await publicBook(OWN);
  assert.equal(first.offers.length, 1);
  const asked = market.requests;
  market.addOffer({ totalSats: 30_000_000, sellerScore: 50, filledOrders: 1 });
  // 23 hours old: still the cached copy, Amboss not asked.
  __ageBookForTests(OWN, 23 * 3_600_000);
  assert.equal((await publicBook(OWN)).offers.length, 1);
  assert.equal(market.requests, asked);
  // A day old: read again — the new offer shows.
  __ageBookForTests(OWN, 2 * 3_600_000);
  const fresh = await publicBook(OWN);
  assert.ok(market.requests > asked, "asked Amboss again");
  assert.equal(fresh.offers.length, 2);
});

test("an offer that fits the size the buyer wants ranks before a cheaper one that doesn't", () => {
  const me: BuyerFacts = { capacitySat: 10_000_000, channelCount: 8, sockets: new Set(["TOR"]), channelsWith: () => 0 };
  const offer = (o: Partial<MagmaOffer>): MagmaOffer => ({
    id: "x",
    sellerPubkey: "02" + "33".repeat(32),
    minSizeSats: 1_000_000,
    maxSizeSats: 10_000_000,
    baseFeeSats: 0,
    feeRatePpm: 3000,
    sellerScore: 50,
    availableSats: 50_000_000,
    totalSizeSats: 50_000_000,
    lockedSats: 0,
    minBlockLength: 4320,
    feeRateCapPpm: 2200,
    baseFeeCapSats: 1,
    conditions: [],
    ...o,
  });
  // The cheap one sells at most 1M — the buyer wants 3M.
  const cheapSmall = offer({ id: "cheap-small", feeRatePpm: 1000, maxSizeSats: 1_000_000 });
  const fitting = offer({ id: "fitting", feeRatePpm: 4000 });
  const ranked = rankBuyOffers([cheapSmall, fitting], [], me, 3_000_000);
  assert.deepEqual(ranked.map((o) => [o.offerId, o.fits]), [["fitting", true], ["cheap-small", false]]);
  // Without the size, price decides.
  assert.deepEqual(rankBuyOffers([fitting, cheapSmall], [], me, 1_000_000).map((o) => o.offerId), ["cheap-small", "fitting"]);
});
