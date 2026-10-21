/**
 * D8: can this node realistically SELL on Magma? Computed live from Amboss's
 * public book — comparable offers by Amboss fee tier (listed total) × seller
 * score (split at the tier's median), their fills per offer-month — never from
 * hard-coded thresholds. D10: the capital engine leaves sats for Magma only
 * when selling can take them and is expected to earn more than routing.
 *
 * Before: no such check existed. The Sell tab counted every order whose size
 * fit the window as "could be matched with you" (~38 a month) while offers
 * like this node's had sold 0 times in 225 offer-months; and the channel
 * autopilot deferred routing opens "for Magma" on a dispersion test of routing
 * yields that never looked at Magma.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assessEligibility, feeTiers, type BookOffer, type PublicBook } from "../src/services/magmaEligibility.js";
import { ambossFeePpmFor } from "../src/services/magmaBuy.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import { sellerSetup, suggestion, type AutopilotSeams } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMarket, ambossFeeFor } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { chanNumber } from "./helpers/feeNode.js";
import { quiet } from "./helpers/lifecycle.js";
import type { FakeMarket as Market } from "./helpers/market.js";

const NOW = Date.parse("2026-10-17T09:00:00Z");
const monthsAgo = (m: number) => new Date(NOW - m * 30 * 86_400_000).toISOString();
let n = 0;
const offer = (o: Partial<BookOffer> & { totalSats: number }): BookOffer => ({
  id: `o-${n++}`,
  sellerPubkey: "03" + (n % 256).toString(16).padStart(2, "0").repeat(32),
  filledOrders: 0,
  createdAt: monthsAgo(6),
  ambossFee: ambossFeeFor(o.totalSats),
  sellerScore: 0,
  ...o,
});
const book = (offers: BookOffer[], own: Partial<PublicBook["own"]> = {}): PublicBook => ({
  fetchedAt: new Date(NOW).toISOString(),
  offers,
  inboundSatsPerUsd: 415_774,
  own: { pubkey: "02" + "aa".repeat(32), sellerScore: 5.22, confirmedSells: 0, ...own },
});

/** A book shaped like the one measured on 2026-10-17: small, low-score offers never fill; big, high-score ones do. */
function measuredBook(): BookOffer[] {
  return [
    // 1.25–5M listings (Amboss fee 1000): low scores, no fills …
    ...Array.from({ length: 8 }, (_, i) => offer({ totalSats: 1_500_000 + i * 400_000, sellerScore: 1 + i, filledOrders: 0, createdAt: monthsAgo(7) })),
    // … and two high-score sellers that did sell.
    offer({ totalSats: 5_000_000, sellerScore: 82.2, filledOrders: 3, createdAt: monthsAgo(10) }),
    offer({ totalSats: 5_000_000, sellerScore: 55.7, filledOrders: 3, createdAt: monthsAgo(3) }),
    ...Array.from({ length: 4 }, (_, i) => offer({ totalSats: 4_000_000, sellerScore: 60 + i, filledOrders: 0, createdAt: monthsAgo(4) })),
    // Exactly 1M (Amboss fee 1500): none sold.
    ...Array.from({ length: 6 }, () => offer({ totalSats: 1_000_000, sellerScore: 2, filledOrders: 0 })),
    // 5–50M (500) and > 50M (350): the ones that sell.
    ...Array.from({ length: 6 }, (_, i) => offer({ totalSats: 20_000_000, sellerScore: 30 + i * 10, filledOrders: 5 + i })),
    ...Array.from({ length: 6 }, (_, i) => offer({ totalSats: 200_000_000, sellerScore: 70 + i * 4, filledOrders: 40 + i * 5, createdAt: monthsAgo(12) })),
  ];
}

test("the Amboss fee tiers are read off the live book — each reaching up to the largest total listed in it (≤1M → 1,500; above → 1,000)", () => {
  const tiers = feeTiers(measuredBook());
  assert.deepEqual(tiers.map((t) => t.ambossFee), [1500, 1000, 500, 350]);
  assert.equal(tiers[0].maxSat, 1_000_000);
  assert.deepEqual(tiers.map((t) => t.upTo), [1_000_000, 5_000_000, 20_000_000, null]);
  // Before: the boundary sat between 1M and the next tier's smallest listing
  // (~1.22M here), so a 1.1M order paid — and a 1.1M listing was compared
  // with — the 1,500 tier.
  assert.equal(ambossFeePpmFor(tiers, 1_000_000), 1500);
  assert.equal(ambossFeePpmFor(tiers, 1_100_000), 1000);
  const e = assessEligibility(book(measuredBook()), { listableSat: 1_100_000, maxChannelSat: 1_100_000 }, NOW);
  assert.equal(e.tier?.ambossFee, 1000);
  assert.equal(e.tier?.fromSat, 1_000_000);
});

test("a node like Chaos (≈1.25M listable, score 5.22, no sales) is told the truth: offers like it never sold — not realistic, with the live numbers", () => {
  const e = assessEligibility(book(measuredBook()), { listableSat: 1_250_000, maxChannelSat: 1_250_000 }, NOW);
  assert.equal(e.verdict, "not_realistic");
  assert.equal(e.indicative, true);
  assert.equal(e.tier?.ambossFee, 1000, "its listing falls in Amboss's 1,000 tier");
  assert.equal(e.scoreSplit?.side, "at_or_below");
  assert.equal(e.comparable?.sold, 0);
  assert.equal(e.comparable?.fills, 0);
  assert.ok((e.comparable?.offerMonths ?? 0) > 30);
  assert.ok(e.comparable?.upperBoundPerMonth !== null, "with no fill: an upper bound, not a fake rate");
  assert.equal(e.expectedSalesPerYear, 0);
  assert.match(e.reasons[0], /Offers like yours — Amboss fee tier 1,000 .*: \d+ live, 0 ever sold; 0 fills in [\d.]+ offer-months/);
  assert.match(e.reasons.join(" "), /same tier with higher seller scores: \d+ offers, 2 sold/);
  // liquidity.buy orders are sized in dollars: $5 ≈ 2.08M at the market rate.
  assert.equal(e.usdOrders?.minOrderSat, 2_078_870);
  assert.equal(e.usdOrders?.fits, false);
  assert.match(e.reasons.join(" "), /smallest \(\$5\) is about 2,078,870 sat of channel/);
});

test("dollar-sized buy orders must fit at the market rate AND at the node's own price: a 2.5M channel takes a $5 order at the market rate, not at a 66 ppm + 852 sat offer's", () => {
  const own = "02" + "aa".repeat(32);
  const offers = [...measuredBook(), offer({ sellerPubkey: own, totalSats: 2_500_000, sellerScore: 5.22, feeRatePpm: 66, baseFeeSats: 852 })];
  const priced = { ...book(offers), satsPerUsd: 415_774 / 339.36 };
  const e = assessEligibility(priced, { listableSat: 2_500_000, maxChannelSat: 2_500_000 }, NOW);
  assert.equal(e.usdOrders?.minOrderSat, 2_078_870);
  // $5 = 6,126 sat; 6,126 − 852 = 5,274 sat buys 5,274 / (1,066 / 1e6) ≈ 4.95M of channel.
  assert.ok(Math.abs((e.usdOrders?.atOwnPriceSat ?? 0) - 4_947_000) < 2_000, String(e.usdOrders?.atOwnPriceSat));
  assert.equal(e.usdOrders?.fits, false, "fits the market-rate size, not the own-price one");
  // No offer of its own in the book: the market rate alone decides.
  const unpriced = assessEligibility({ ...book(measuredBook()), satsPerUsd: 415_774 / 339.36 }, { listableSat: 2_500_000, maxChannelSat: 2_500_000 }, NOW);
  assert.deepEqual(unpriced.usdOrders, { minOrderSat: 2_078_870, atOwnPriceSat: null, fits: true });
});

test("deeper listings are judged against their own tier: 20M listable is 'realistic' where offers like it fill monthly, 'possible but slow' where they fill a few times a year", () => {
  const e = assessEligibility(book(measuredBook(), { sellerScore: 0 }), { listableSat: 20_000_000, maxChannelSat: 5_000_000 }, NOW);
  assert.equal(e.tier?.ambossFee, 500);
  assert.equal(e.verdict, "realistic", JSON.stringify(e.comparable));
  const slow = measuredBook().map((o) => (o.ambossFee === 500 ? { ...o, filledOrders: 1, createdAt: monthsAgo(3) } : o));
  assert.equal(assessEligibility(book(slow, { sellerScore: 0 }), { listableSat: 20_000_000, maxChannelSat: 5_000_000 }, NOW).verdict, "possible_but_slow");
});

test("the verdict follows the sales a year offers like this node's make: under one a year is 'not realistic' even where a few of them sold", () => {
  // Twelve 2–4M listings (Amboss fee 1000) listed a year; the low-score half
  // is this node's cell (its score: none yet).
  const cell = (sold: number, each: number) =>
    Array.from({ length: 12 }, (_, i) => offer({ totalSats: 2_000_000 + i * 150_000, sellerScore: i + 1, filledOrders: i < sold ? each : 0, createdAt: monthsAgo(12) }));
  const judge = (sold: number, each: number) =>
    assessEligibility(book(cell(sold, each), { sellerScore: null }), { listableSat: 2_500_000, maxChannelSat: 2_500_000 }, NOW);
  const rare = judge(3, 1); // 3 fills in ~72 offer-months: ~0.5 a year
  assert.equal(rare.comparable?.fills, 3);
  assert.ok(rare.expectedSalesPerYear! > 0 && rare.expectedSalesPerYear! < 1, String(rare.expectedSalesPerYear));
  assert.equal(rare.verdict, "not_realistic");
  const some = judge(6, 2); // 12 fills in ~72 offer-months: ~2 a year
  assert.ok(some.expectedSalesPerYear! > 1.5 && some.expectedSalesPerYear! < 12, String(some.expectedSalesPerYear));
  assert.equal(some.verdict, "possible_but_slow");
});

test("no public book, no verdict: 'unknown' — and a cell too small to say anything is compared with its whole tier", () => {
  assert.equal(assessEligibility(null, { listableSat: 1_000_000, maxChannelSat: 1_000_000 }, NOW).verdict, "unknown");
  const tiny = [offer({ totalSats: 3_000_000, sellerScore: 1 }), offer({ totalSats: 3_000_000, sellerScore: 90, filledOrders: 24 }), offer({ totalSats: 1_000_000 })];
  const e = assessEligibility(book(tiny), { listableSat: 2_000_000, maxChannelSat: 2_000_000 }, NOW);
  assert.equal(e.widened, true);
  assert.equal(e.comparable?.offers, 2);
});

test("this node's own offer is not counted among the offers it is compared with", () => {
  const own = "02" + "aa".repeat(32);
  const offers = [...measuredBook(), offer({ sellerPubkey: own, totalSats: 1_250_000, sellerScore: 5.22, filledOrders: 0 })];
  const a = assessEligibility(book(offers), { listableSat: 1_250_000, maxChannelSat: 1_250_000 }, NOW);
  const b = assessEligibility(book(measuredBook()), { listableSat: 1_250_000, maxChannelSat: 1_250_000 }, NOW);
  assert.equal(a.comparable?.offers, b.comparable?.offers);
});

function fillMarket(market: Market, fills: (score: number) => number): void {
  for (let i = 0; i < 8; i++) market.addOffer({ totalSats: 20_000_000, sellerScore: i * 5, filledOrders: fills(i * 5), monthsListed: 6 });
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 1_000_000, sellerScore: 1, filledOrders: 0 });
}

test("GET /amboss/eligibility answers from the public book — with no Amboss key at all", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const market = new FakeMarket(http, t);
  fillMarket(market, () => 0);
  market.ownScore = 5.22;
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 1_400_000 }) });
  const res = await api.request("GET", "/amboss/eligibility");
  assert.equal(res.status, 200);
  assert.equal(res.body.verdict, "not_realistic");
  assert.equal(res.body.own.sellerScore, 5.22);
  assert.ok(res.body.own.listableSat > 1_000_000 && res.body.own.listableSat < 1_400_000, `listable ${res.body.own.listableSat}`);
});

/** A selling node with one aged routing channel and an enabled offer on record. */
async function deferralSetup(t: Parameters<typeof sellerSetup>[0], fills: (score: number) => number) {
  const s = sellerSetup(t, { chainBalance: 20_000_000 });
  fillMarket(s.market, fills);
  // A month-old routing channel that earned nothing (no forwards).
  s.node.channels.push({ id: "850000x1x0", partnerPublicKey: "02" + "77".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "77".repeat(32), transactionVout: 0 });
  s.node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  // Real sales cleared at 5% a year (buyer-paid) in this size band.
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 3_000_000, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })),
  );
  t.after(() => __setHistoryForTests([]));
  s.magma.addOffer({ minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000 });
  await s.autopilot.runOnce(); // offer upkeep: the enabled offer is on record
  (s.autopilot as unknown as AutopilotSeams).channelSuggestions = async () => ({ suggestions: [suggestion] });
  s.node.peers.push(suggestion.pubkey); // connected: the open itself is what is tested
  s.autopilot.setConfig({ channelEnabled: true, channelSizeSats: 1_000_000 });
  return s;
}

test("D10: with Liquidity provision on, a routing open goes ahead when offers like this node's don't sell — no more 'left for Magma' on a routing-yield dispersion test", async (t) => {
  quiet(t);
  const s = await deferralSetup(t, () => 0);
  const run = await s.autopilot.runOnce();
  // Before: one channel → median < 1.2 × p25 → "deferred: leasing beats routing … left for Magma", every run.
  assert.equal(run.channels[0]?.ok, true, JSON.stringify(run.channels));
  assert.equal(s.node.callsTo("default.openChannel").length, 1);
});

test("D10: an open is never held back for Magma where selling is not realistic — even when offers like this node's sold once or twice and routing has earned nothing yet", async (t) => {
  quiet(t);
  // Two fills in ~48 offer-months: about half a sale a year.
  const s = await deferralSetup(t, (score) => (score === 35 ? 2 : 0));
  const run = await s.autopilot.runOnce();
  const e = s.autopilot.lastEligibility;
  assert.equal(e?.verdict, "not_realistic");
  assert.ok((e?.comparable?.fills ?? 0) > 0, "offers like it did sell — rarely");
  assert.equal(run.channels[0]?.ok, true, JSON.stringify(run.channels));
  assert.equal(s.node.callsTo("default.openChannel").length, 1);
});

test("D10: the open waits for Magma only where selling is realistic AND the expected lease income beats a new routing channel", async (t) => {
  quiet(t);
  const s = await deferralSetup(t, (score) => (score <= 15 ? 12 : 30));
  const run = await s.autopilot.runOnce();
  assert.equal(run.channels[0]?.ok, false);
  assert.match(run.channels[0]?.error ?? "", /^deferred: selling on Magma is expected to earn more on this capital \(~\d+ ppm\/yr: offers like yours fill ~[\d.]+ times a year\) than a new routing channel \(~0 ppm\/yr\)/);
  assert.equal(s.node.callsTo("default.openChannel").length, 0);
});

// Each condition of the deferral on its own: with selling realistic and the
// expected lease income above routing (the test above defers), take one
// condition away and the open goes ahead.
const sellsWell = (score: number) => (score <= 15 ? 12 : 30);

test("D10: no deferral without an offer of this node listed — selling realistic, a month-old channel, every offer disabled: the open goes ahead", async (t) => {
  quiet(t);
  const s = await deferralSetup(t, sellsWell);
  for (const o of s.magma.offers.values()) o.status = "DISABLED";
  s.autopilot.setConfig({ channelEnabled: false });
  await s.autopilot.runOnce(); // the upkeep records the offer disabled
  assert.ok(!s.autopilot.offerSyncStatus().offers.some((e) => e.amboss.status === "ENABLED"));
  s.autopilot.setConfig({ channelEnabled: true });
  const run = await s.autopilot.runOnce();
  assert.equal(run.channels[0]?.ok, true, JSON.stringify(run.channels));
  assert.equal(s.node.callsTo("default.openChannel").length, 1);
});

test("D10: a node without a month of routing history always opens its first channels — selling realistic and listed, but no channel older than 4,320 blocks", async (t) => {
  quiet(t);
  const s = await deferralSetup(t, sellsWell);
  // Its only routing channel is a week old.
  s.node.channels[0].id = `${s.node.blockHeight - 1_000}x1x0`;
  const run = await s.autopilot.runOnce();
  // Without the rule: no routing yield to compare with counts as 0 — every
  // open of a new node with realistic selling would wait "for Magma".
  assert.equal(run.channels[0]?.ok, true, JSON.stringify(run.channels));
  assert.equal(s.node.callsTo("default.openChannel").length, 1);
});

test("D10: no deferral while Amboss rejects the key (or there is none) — Magma can't take the capital: the open goes ahead", async (t) => {
  quiet(t);
  for (const keyGone of [false, true]) {
    const s = await deferralSetup(t, sellsWell);
    s.magma.keyValid = false;
    if (keyGone) s.amboss.clear();
    else s.amboss.markInvalid();
    const run = await s.autopilot.runOnce();
    assert.equal(run.channels[0]?.ok, true, `${keyGone ? "no key" : "key rejected"}: ${JSON.stringify(run.channels)}`);
    assert.equal(s.node.callsTo("default.openChannel").length, 1);
  }
});

/** 30 days of forwards out of `channelId`, `feeSats` earned in all (ten forwards). */
function forwardsEarning(node: FakeLnd, channelId: string, feeSats: number): void {
  const nowMs = Date.now();
  const events = Array.from({ length: 10 }, (_, i) => {
    const at = nowMs - (i + 1) * 2 * 86_400_000;
    const fee = feeSats / 10;
    return {
      amt_in: String(1_000_000 + fee),
      amt_in_msat: String((1_000_000 + fee) * 1000),
      amt_out: "1000000",
      amt_out_msat: "1000000000",
      chan_id_in: chanNumber("850000x9x0"),
      chan_id_out: chanNumber(channelId),
      fee: String(fee),
      fee_msat: String(fee * 1000),
      timestamp: String(Math.floor(at / 1000)),
      timestamp_ns: String(BigInt(at) * 1_000_000n),
    };
  });
  // One page: LND answers the next offset with nothing.
  node.override("default.forwardingHistory", (a, cb) =>
    Number(a.index_offset) > 0
      ? cb(null, { forwarding_events: [], last_offset_index: String(a.index_offset) })
      : cb(null, { forwarding_events: events, last_offset_index: String(events.length) }),
  );
}

test("D10: routing that out-earns the lease keeps the open going — selling realistic and listed, but the month-old channel earns more than Magma would", async (t) => {
  quiet(t);
  const s = await deferralSetup(t, sellsWell);
  // Offers like this node's fill ~42 times a year: ~22,800 ppm a year on the
  // listable capital (the deferral test above). A month-old 2M channel that
  // earned 2,000 sat in 30 days (~12,200 ppm/yr) earns less: the open waits.
  forwardsEarning(s.node, "850000x1x0", 2_000);
  const slow = await s.autopilot.runOnce();
  assert.match(slow.channels[0]?.error ?? "", /^deferred: .* than a new routing channel \(~12167 ppm\/yr\)/);
  assert.equal(s.node.callsTo("default.openChannel").length, 0);
  // One that earned 20,000 sat (~121,700 ppm/yr) beats the lease: routing
  // gets the capital. (Without the comparison — the core of D10 — it would
  // wait "for Magma" too.)
  forwardsEarning(s.node, "850000x1x0", 20_000);
  const run = await s.autopilot.runOnce();
  assert.equal(run.channels[0]?.ok, true, JSON.stringify(run.channels));
  assert.equal(s.node.callsTo("default.openChannel").length, 1);
});

test("D10: a sale that nets nothing at today's on-chain fees leaves nothing for Magma — and is not weighed against 30 days of forwards", async (t) => {
  quiet(t);
  const s = await deferralSetup(t, sellsWell);
  // Comparable leases cleared at 0.05% a year: a fill pays less than its open and close.
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 3_000_000, blocks: 4320, apr: 0.0005, leasePpm: 41, status: "FINISHED" })),
  );
  const forwardsBefore = s.node.callsTo("default.forwardingHistory").length;
  const run = await s.autopilot.runOnce();
  assert.equal(run.channels[0]?.ok, true, JSON.stringify(run.channels));
  assert.equal(s.node.callsTo("default.forwardingHistory").length, forwardsBefore, "no routing comparison for a sale that loses money");
});

test("auto-listing needs selling to be realistic: no offer is created for a node whose comparable offers don't sell — one with the standard lease and the fee promise where they do", async (t) => {
  quiet(t);
  for (const realistic of [false, true]) {
    const s = sellerSetup(t, { chainBalance: 20_000_000, config: { sellAutoReprice: true } });
    fillMarket(s.market, () => (realistic ? 30 : 0));
    await s.autopilot.runOnce();
    const creates = s.magma.calls.filter((c) => c.op === "CreateOffer");
    if (!realistic) {
      assert.equal(creates.length, 0, "no automatic listing on no evidence");
      assert.match(s.autopilot.getState().decisions.magma?.text ?? "", /no offer listed automatically: selling is not realistic for this node yet/);
    } else {
      assert.equal(creates.length, 1);
      const input = creates[0].variables.input as Record<string, unknown>;
      assert.equal(input.min_block_length, 4320);
      assert.equal(input.fee_rate_cap, 2200);
      assert.equal(input.base_fee_cap, 1);
    }
  }
});

test("a8: the Market page and the autopilot run the engine with the same capital inputs — at 1.2M on chain with a 50k reserve both see 1.15M deployable, and the autopilot lists where the page recommends", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 1_200_000, config: { sellAutoReprice: true, sellReserveSats: 50_000 } });
  // Offers like a ~1.15M listing (Amboss fee 1000) that do sell.
  for (let i = 0; i < 6; i++) s.market.addOffer({ totalSats: 1_500_000 + i * 500_000, sellerScore: i * 3, filledOrders: 24, monthsListed: 6 });
  const page = await s.autopilot.magmaReport();
  assert.equal(page.sell.deployableCapitalSat, 1_150_000, "the operator's 50k reserve, not the engine's 250k default");
  assert.equal(page.sell.state, "good_to_sell");
  await s.autopilot.runOnce();
  // Before: the autopilot's own call passed only the pricing level — it saw
  // 950k deployable, "insufficient capital", and listed nothing.
  assert.equal(s.magma.calls.filter((c) => c.op === "CreateOffer").length, 1);
});
