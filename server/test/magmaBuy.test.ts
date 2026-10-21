/**
 * Buying inbound on Magma (a4-lsp-payments:buy-ranking-misleading,
 * buy-flow-size-and-tracking): offers ranked by what they really cost this
 * node per year of lease — Amboss's fee by order size included, buyer
 * conditions checked, the seller's fee promise weighed — bought at the size the
 * buyer chose, cancelled on Amboss when the buyer declines, paid only through
 * the invoice recorded with the quote, and followed to the end in a ledger.
 *
 * Before: "best value" compared fees per lease whatever the lease length, left
 * out Amboss's fee and the buyer conditions (its #1 pick needed a 10M node), a
 * pick always bought the offer's minimum size, a declined quote stayed a live
 * order, and a purchase lived only in the browser tab.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankBuyOffers, ambossFeePpmFor, type BuyerFacts } from "../src/services/magmaBuy.js";
import type { MagmaOffer } from "../src/services/amboss.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { quiet } from "./helpers/lifecycle.js";
import type { AfterHook } from "./helpers/tmp.js";

/** The live book's tiers (feeTiers): each up to the largest total listed in it. */
const TIERS = [
  { ambossFee: 1500, upTo: 1_000_000 },
  { ambossFee: 1000, upTo: 5_000_000 },
  { ambossFee: 500, upTo: 50_000_000 },
  { ambossFee: 350, upTo: null },
];
const me: BuyerFacts = {
  capacitySat: 6_983_146,
  channelCount: 6,
  sockets: new Set(["TOR"]),
  channelsWith: (pk) => (pk === "02" + "33".repeat(32) ? 1 : 0),
};
let n = 0;
const book = (o: Partial<MagmaOffer>): MagmaOffer => ({
  id: `b-${n++}`,
  sellerPubkey: "02" + (n % 256).toString(16).padStart(2, "0").repeat(32),
  minSizeSats: 1_000_000,
  maxSizeSats: 10_000_000,
  baseFeeSats: 568,
  feeRatePpm: 3000,
  sellerScore: 90,
  availableSats: 50_000_000,
  totalSizeSats: 50_000_000,
  lockedSats: 0,
  minBlockLength: 4320,
  feeRateCapPpm: 2200,
  baseFeeCapSats: 1,
  conditions: [],
  ...o,
});

test("Amboss's fee is charged by ORDER size, from the live tiers: exactly 1M → 1,500 ppm, 2M → 1,000 ppm", () => {
  assert.equal(ambossFeePpmFor(TIERS, 1_000_000), 1500);
  assert.equal(ambossFeePpmFor(TIERS, 2_000_000), 1000);
  assert.equal(ambossFeePpmFor(TIERS, 200_000_000), 350);
  assert.equal(ambossFeePpmFor([], 2_000_000), null);
});

test("offers are ranked by cost per year of lease — Amboss's fee included — after the ones this node can actually buy and that promise fee caps", () => {
  const cheapPerLease = book({ id: "30d", feeRatePpm: 2642, baseFeeSats: 0 });
  const longLease = book({ id: "180d", feeRatePpm: 9000, baseFeeSats: 1000, minBlockLength: 25_920 });
  const bigNodesOnly = book({ id: "10M-only", feeRatePpm: 1000, conditions: [{ condition: "NODE_CAPACITY", operator: "GREATER_THAN_OR_EQUAL_TO", value: "10000000" }] });
  const clearnetOnly = book({ id: "clearnet", feeRatePpm: 1200, conditions: [{ condition: "NODE_SOCKETS", operator: "CONTAINS", value: "CLEARNET" }] });
  const noParallel = book({ id: "no-parallel", sellerPubkey: "02" + "33".repeat(32), feeRatePpm: 1100, conditions: [{ condition: "PARALLEL_CHANNELS", operator: "EQUAL_TO", value: "0" }] });
  const terminal = book({ id: "terminal", feeRatePpm: 1300, conditions: [{ condition: "TERMINAL_WEB_RANK", operator: "LESS_THAN_OR_EQUAL_TO", value: "1000" }] });
  const noCap = book({ id: "no-cap", feeRatePpm: 2000, feeRateCapPpm: null, baseFeeCapSats: null });
  const ranked = rankBuyOffers([cheapPerLease, longLease, bigNodesOnly, clearnetOnly, noParallel, terminal, noCap], TIERS, me, 2_000_000);
  const ids = ranked.map((o) => o.offerId);
  // 180 days at 9,000 ppm + 1,000 sat + Amboss's 1,000 ppm costs ~21k ppm a
  // year; 30 days at 2,642 ppm + 1,000 ppm costs ~44k ppm a year.
  assert.deepEqual(ids.slice(0, 3), ["180d", "30d", "no-cap"], ids.join());
  const long = ranked[0];
  assert.equal(long.leaseDays, 180);
  assert.equal(long.ambossFeeSats, 2_000);
  assert.equal(long.totalFeeSats, 18_000 + 1_000 + 2_000);
  assert.ok(long.totalFeeSats > ranked[1].totalFeeSats, "more sats up front — the table shows both");
  assert.equal(ranked.find((o) => o.offerId === "terminal")?.eligible, null, "can't be checked here: said so");
  for (const id of ["10M-only", "clearnet", "no-parallel"]) {
    const o = ranked.find((x) => x.offerId === id)!;
    assert.equal(o.eligible, false, id);
    assert.ok(ids.indexOf(id) > ids.indexOf("terminal"), `${id} ranks after every offer that may be buyable`);
  }
  assert.match(ranked.find((o) => o.offerId === "10M-only")!.conditions[0].text, /node capacity at least 10,000,000 sat \(yours: 6,983,146\)/);
  assert.match(ranked.find((o) => o.offerId === "clearnet")!.conditions[0].text, /including clearnet \(yours: tor\)/);
});

test("an offer is evaluated at the buyer's size, clamped into what it sells — not always at its minimum", () => {
  const o = book({ minSizeSats: 1_000_000, maxSizeSats: 5_000_000, availableSats: 4_000_000 });
  const [at3m] = rankBuyOffers([o], TIERS, me, 3_000_000);
  assert.equal(at3m.sizeSats, 3_000_000);
  assert.equal(at3m.fits, true);
  const [too] = rankBuyOffers([o], TIERS, me, 4_500_000);
  assert.equal(too.sizeSats, 4_000_000, "no more than is available");
  assert.equal(too.fits, false);
});

async function buyApi(t: AfterHook) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const market = new FakeMarket(http, t);
  const offer = market.addOffer({ id: "offer-a", minSats: 1_000_000, maxSats: 5_000_000, totalSats: 20_000_000, feeRatePpm: 3000, baseFeeSats: 568 });
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 1_000_000 }) });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  return { api, magma, market, offer };
}

test("GET /amboss/buy-offers ranks the book for this node at the size asked for", async (t) => {
  quiet(t);
  const { api, market } = await buyApi(t);
  market.addOffer({ id: "clearnet-only", conditions: [{ condition: "NODE_SOCKETS", operator: "CONTAINS", value: "CLEARNET" }], feeRatePpm: 100 });
  // This node's own offer, the cheapest of all: a node can't buy from itself.
  market.addOffer({ id: "own-offer", sellerPubkey: api.node.publicKey, feeRatePpm: 1, baseFeeSats: 1 });
  const res = await api.request("GET", "/amboss/buy-offers?size=3000000");
  assert.equal(res.status, 200);
  assert.equal(res.body.sizeSats, 3_000_000);
  const ids = res.body.offers.map((o: { offerId: string }) => o.offerId);
  assert.deepEqual(ids, ["offer-a", "clearnet-only"], "the Tor-only node can't buy the clearnet-only offer, however cheap — nor its own offer");
  assert.equal(res.body.offers[0].sizeSats, 3_000_000);
  assert.equal(res.body.inboundSatsPerUsd, 415_774);
});

test("a pick buys the size the buyer chose (within the offer); the quote is recorded with its lease and fee promise; declining cancels the order on Amboss", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const bad = await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 6_000_000 });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /1,000,000–5,000,000 sat/);
  const quote = await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 3_000_000 });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const create = magma.calls.find((c) => c.op === "Order")?.variables.input as Record<string, unknown>;
  assert.equal(create.size, "3000000", "not the offer's minimum");
  assert.equal(quote.body.sats, 5_068);
  assert.equal(quote.body.leaseBlocks, 4320);
  assert.equal(quote.body.feeRateCapPpm, 2200);
  const recorded = api.autopilot.purchases.get(quote.body.orderId);
  assert.equal(recorded?.state, "quoted");
  assert.equal(recorded?.sizeSats, 3_000_000);
  // The buyer declines.
  const declined = await api.request("POST", "/amboss/buy/cancel", { orderId: quote.body.orderId });
  assert.equal(declined.status, 200);
  assert.equal(declined.body.cancelled, true);
  const cancel = magma.calls.find((c) => c.op === "CancelOrder")?.variables.input as Record<string, unknown>;
  assert.deepEqual(cancel, { order_id: quote.body.orderId, cancellation_reason: "UNABLE_TO_PAY" });
  assert.equal(api.autopilot.purchases.get(quote.body.orderId)?.state, "declined");
  // A declined quote can't be paid afterwards.
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: quote.body.orderId, maxSats: 5_068 })).status, 409);
});

test("a cancel Amboss doesn't confirm is not recorded as 'declined' — answered false or failing, the purchase reads 'cancel_failed' and the answer says so", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  for (const behaviour of ["false", "throw"] as const) {
    magma.behave.CancelOrder = behaviour;
    const quote = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
    const res = await api.request("POST", "/amboss/buy/cancel", { orderId: quote.orderId });
    assert.equal(res.status, 200, behaviour);
    assert.equal(res.body.cancelled, false, behaviour);
    assert.match(res.body.message, /^Not paid; Amboss didn't confirm the cancel \(.+\) — the unpaid order expires on its own\.$/, behaviour);
    // Recorded as "declined" regardless, the ledger would say Amboss had
    // cancelled an order that is still live there.
    const rec = api.autopilot.purchases.get(quote.orderId);
    assert.equal(rec?.state, "cancel_failed", behaviour);
    assert.match(rec?.error ?? "", behaviour === "false" ? /^Amboss did not confirm the cancel$/ : /502/, behaviour);
    assert.equal(magma.purchases.get(quote.orderId)?.cancelled, undefined, "still live on Amboss");
  }
});

test("a purchase being paid, paid, or with its channel open can't be 'declined': POST /amboss/buy/cancel answers 409 — record, follow-up and P&L feed unchanged, nothing sent to Amboss", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const ledger = api.autopilot.purchases;
  for (const state of ["paying", "paid", "channel_open"] as const) {
    const quote = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
    const paid = state === "paying" ? {} : { paidAt: new Date().toISOString(), routingFeeSats: 2 };
    ledger.update(quote.orderId, { state, ...paid });
    const before = { ...ledger.get(quote.orderId)! };
    const costs = ledger.paidCosts();
    const followed = ledger.followUps();
    const res = await api.request("POST", "/amboss/buy/cancel", { orderId: quote.orderId });
    // Before (no state check): "declined" — a paid purchase dropped from the
    // follow-up and from paidCosts(), a cancel sent for an order being paid.
    assert.equal(res.status, 409, state);
    assert.equal(res.body.error, "bad_state");
    assert.deepEqual(ledger.get(quote.orderId), before, state);
    assert.deepEqual(ledger.paidCosts(), costs, state);
    assert.deepEqual(ledger.followUps(), followed, state);
  }
  assert.equal(magma.count("CancelOrder"), 0);
});

test("paying pays only the quote's own invoice, for the amount confirmed — and the purchase is followed to its channel in the ledger", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const quote = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
  const other = api.node.makeOwnRequest(100);
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: quote.orderId, maxSats: 5_068, paymentRequest: other })).status, 400, "another invoice");
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: quote.orderId, maxSats: 5_000 })).status, 400, "more than confirmed");
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: "nope", maxSats: 5_068 })).status, 404, "no quote, no payment");
  assert.equal(api.node.payments.size, 0);
  const paid = await api.request("POST", "/amboss/buy/pay", { orderId: quote.orderId, maxSats: 5_068 });
  assert.equal(paid.status, 200);
  for (let i = 0; i < 50 && api.autopilot.purchases.get(quote.orderId)?.state !== "paid"; i++) await new Promise((r) => setTimeout(r, 10));
  const rec = api.autopilot.purchases.get(quote.orderId);
  assert.equal(rec?.state, "paid");
  assert.equal(rec?.routingFeeSats, 2);
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: quote.orderId, maxSats: 5_068 })).status, 409, "never paid twice");
  // The seller opens the channel; the order lane follows the purchase even
  // with no tab polling it.
  const p = magma.purchases.get(quote.orderId)!;
  p.status = "VALID_CHANNEL_OPENING";
  p.channelId = "870000x1x0";
  await api.autopilot.pollSellOrders();
  assert.equal(api.autopilot.purchases.get(quote.orderId)?.state, "channel_open");
  assert.deepEqual(api.autopilot.purchases.paidCosts().map((c) => [c.orderId, c.feeSats, c.routingFeeSats]), [[quote.orderId, 5_068, 2]]);
  const listed = await api.request("GET", "/amboss/purchases");
  assert.equal(listed.body.purchases[0].channelId, "870000x1x0");
});

test("only inbound that arrived counts as a cost: a declined quote, and a paid order that failed on Amboss (refunded), are not in the P&L feed", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const declined = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
  await api.request("POST", "/amboss/buy/cancel", { orderId: declined.orderId });
  const failed = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: failed.orderId, maxSats: failed.sats })).status, 200);
  for (let i = 0; i < 50 && api.autopilot.purchases.get(failed.orderId)?.state !== "paid"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(api.autopilot.purchases.get(failed.orderId)?.state, "paid");
  magma.purchases.get(failed.orderId)!.status = "SELLER_FAILED_TO_OPEN_CHANNEL";
  await api.autopilot.pollSellOrders();
  assert.equal(api.autopilot.purchases.get(failed.orderId)?.state, "order_failed");
  assert.deepEqual(api.autopilot.purchases.paidCosts(), []);
});
