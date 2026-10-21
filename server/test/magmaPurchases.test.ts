/**
 * The purchase ledger converges on what LND and Amboss report (a4-lsp-payments:
 * buy-flow-size-and-tracking; review P1b), and is followed apart from the
 * order lane's critical path. /amboss/buy/pay pays only the quote's own,
 * unexpired invoice, to its payee — never this node.
 *
 * Before: only the pay call's answer, in the same process, could record a
 * Magma purchase as paid — but a hold invoice keeps the payment in flight until
 * the seller's channel is confirmed. A restart in that window left it "paying"
 * for good (paid, delivered, yet missing from P&L); a dropped pay stream left
 * "payment failed" that nothing ever checked again; and a late answer could
 * move "channel open" back to "paid". The follow-up ran inside the lane's pass,
 * five sequential Amboss reads before its run history was written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MagmaPurchases } from "../src/services/magmaPurchases.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi, type ApiHarness } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { BUYER } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";

async function buyApi(t: AfterHook, opts: { dir?: string; node?: FakeLnd } = {}) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const market = new FakeMarket(http, t);
  market.addOffer({ id: "offer-a", minSats: 1_000_000, maxSats: 5_000_000, totalSats: 20_000_000, feeRatePpm: 3000, baseFeeSats: 568 });
  const node = opts.node ?? new FakeLnd({ chainBalance: 1_000_000 });
  const api = await startApi(t, { node, dir: opts.dir });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  return { api, magma, market, http };
}

const until = async (cond: () => boolean, what: string, ms = 2_000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A quote paid with the hold invoice's payment left in flight in LND. */
async function payHeld(api: ApiHarness) {
  const quote = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
  api.node.payOutcome = "hang";
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: quote.orderId, maxSats: quote.sats })).status, 200);
  const hash = api.autopilot.purchases.get(quote.orderId)!.paymentHash;
  await until(() => api.node.payments.get(hash)?.status === "IN_FLIGHT", "LND to take the payment");
  return { orderId: quote.orderId as string, hash, sats: quote.sats as number };
}

test("a restart while the hold-invoice payment is in flight: the purchase still ends paid and opened — in paidCosts() with LND's time and routing fee", async (t) => {
  quiet(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const first = await buyApi(t, { dir, node });
  const { orderId, hash } = await payHeld(first.api);
  assert.equal(first.api.autopilot.purchases.get(orderId)?.state, "paying");
  // The process restarts: the old one's pay call never answers.
  first.api.autopilot.purchases.paymentOutcome = () => undefined;
  const api = await startApi(t, { node, dir });
  api.amboss.setKey("test-key");
  const ledger = api.autopilot.purchases;
  assert.equal(ledger.get(orderId)?.state, "paying", "read back from disk");
  await api.autopilot.pollSellOrders();
  assert.equal(ledger.get(orderId)?.state, "paying", "LND: still in flight; Amboss: not open yet");
  // The seller's channel is confirmed — Amboss reports the order done before
  // the seller has settled our payment.
  const p = first.magma.purchases.get(orderId)!;
  p.status = "VALID_CHANNEL_OPENING";
  p.channelId = "870000x1x0";
  await api.autopilot.pollSellOrders();
  assert.equal(ledger.get(orderId)?.state, "channel_open");
  assert.ok(ledger.get(orderId)?.paidAt, "the channel opens only once paid: paid, whatever this process saw");
  // Before: no paidAt — the paid, delivered purchase was missing from P&L.
  assert.deepEqual(ledger.paidCosts().map((c) => [c.orderId, c.routingFeeSats]), [[orderId, 0]]);
  // The seller settles: LND has the payment's time and routing fee.
  node.resolvePayment(hash, "succeed");
  await api.autopilot.pollSellOrders();
  const rec = ledger.get(orderId)!;
  assert.equal(rec.state, "channel_open", "never back to 'paid'");
  assert.equal(rec.routingFeeSats, 2);
  assert.deepEqual(ledger.paidCosts().map((c) => [c.orderId, c.feeSats, c.routingFeeSats]), [[orderId, 5_068, 2]]);
  assert.deepEqual(ledger.followUps(), { payments: [], orders: [] }, "nothing left to ask");
});

test("a pay stream that dropped while LND kept the HTLC in flight: the purchase is followed until LND says how it ended — paid, and its channel open", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const { orderId, hash } = await payHeld(api);
  // LND's payment stream breaks (LND restarted, the connection dropped): the
  // pay call fails, but the HTLC is still in flight.
  api.node.dropPaymentStreams(hash);
  await until(() => api.autopilot.purchases.get(orderId)?.state === "pay_failed", "the pay call's failure");
  // Before: "payment failed", and never looked at again.
  assert.equal(api.autopilot.purchases.get(orderId)?.failureConfirmed, undefined, "only the stream's word");
  const view = await api.request("GET", `/amboss/order?id=${orderId}`);
  assert.equal(view.body.payment.state, "unclear", "the Buy tab doesn't call it failed yet");
  assert.deepEqual(api.autopilot.purchases.followUps().payments.map((p) => p.orderId), [orderId]);
  await api.autopilot.pollSellOrders();
  assert.equal(api.autopilot.purchases.get(orderId)?.state, "paying", "LND: still being paid");
  // The seller opens and settles.
  magma.purchases.get(orderId)!.status = "VALID_CHANNEL_OPENING";
  api.node.resolvePayment(hash, "succeed");
  await api.autopilot.pollSellOrders();
  const rec = api.autopilot.purchases.get(orderId)!;
  assert.equal(rec.state, "channel_open");
  assert.equal(rec.routingFeeSats, 2);
  assert.equal(api.autopilot.purchases.paidCosts().length, 1);
});

// Review of P1b: POST /amboss/buy/cancel took a "pay_failed" the pay call
// alone had reported — while LND still had the HTLC in flight. The order was
// cancelled on Amboss and recorded "declined"; had the payment then landed,
// inbound paid for would have read as declined.
test("a cancel waits for LND's word on a payment only the pay call said failed: refused while LND has it in flight, done once LND confirms the failure", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const { orderId, hash, sats } = await payHeld(api);
  api.node.dropPaymentStreams(hash);
  await until(() => api.autopilot.purchases.get(orderId)?.state === "pay_failed", "the pay call's failure");
  assert.equal(api.autopilot.purchases.get(orderId)?.failureConfirmed, undefined);
  const early = await api.request("POST", "/amboss/buy/cancel", { orderId });
  assert.deepEqual([early.status, early.body.error], [409, "bad_state"]);
  assert.equal(api.autopilot.purchases.get(orderId)?.state, "paying", "LND: still in flight");
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId, maxSats: sats })).status, 409, "nor paid a second time");
  assert.equal(magma.count("CancelOrder"), 0, "nothing sent to Amboss");

  api.node.resolvePayment(hash, "fail"); // LND's word: it failed
  const late = await api.request("POST", "/amboss/buy/cancel", { orderId });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(api.autopilot.purchases.get(orderId)?.state, "declined");
  assert.equal(magma.count("CancelOrder"), 1);
});

// Review of P5: the cancel test above also tried /amboss/buy/pay — but only
// after the cancel had already asked LND and moved the record to "paying",
// so the pay route's own question to LND went untested.
test("paying again, as the first call after the pay stream dropped while LND keeps the payment in flight, is refused — no second payment; once LND confirms the failure it may be paid again", async (t) => {
  quiet(t);
  const { api } = await buyApi(t);
  const { orderId, hash, sats } = await payHeld(api);
  api.node.dropPaymentStreams(hash);
  await until(() => api.autopilot.purchases.get(orderId)?.state === "pay_failed", "the pay call's failure");
  assert.equal(api.autopilot.purchases.get(orderId)?.failureConfirmed, undefined, "only the stream's word");
  // Before LND was asked here, the record's "pay_failed" let a second
  // payment of the same invoice start while the first was still in flight.
  const again = await api.request("POST", "/amboss/buy/pay", { orderId, maxSats: sats });
  assert.deepEqual([again.status, again.body.error], [409, "bad_state"]);
  assert.equal(again.body.message, "This order is paying — not paying it again.");
  assert.equal(api.node.callsTo("router.sendPaymentV2").length, 1, "no second payment");
  assert.equal(api.autopilot.purchases.get(orderId)?.state, "paying", "LND: still in flight");

  api.node.resolvePayment(hash, "fail"); // LND's word: it failed
  const retry = await api.request("POST", "/amboss/buy/pay", { orderId, maxSats: sats });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  await until(() => api.node.callsTo("router.sendPaymentV2").length === 2, "the second payment");
});

test("a cancel of a payment LND can't speak for yet (no record of it, minutes after the start) answers payment_unclear — nothing cancelled", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const quote = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
  const ledger = api.autopilot.purchases;
  ledger.startPayment(quote.orderId);
  ledger.paymentOutcome(quote.orderId, { status: "failed", error: "the stream dropped", confirmed: false });
  const res = await api.request("POST", "/amboss/buy/cancel", { orderId: quote.orderId });
  assert.deepEqual([res.status, res.body.error], [409, "payment_unclear"]);
  assert.match(res.body.message, /LND hasn't confirmed that the payment failed — it may still be in flight/);
  assert.equal(ledger.get(quote.orderId)?.state, "pay_failed");
  assert.equal(magma.count("CancelOrder"), 0);
});

test("a purchase first followed after its lease ran out (CHANNEL_MONITORING_FINISHED) is done — not 'paying' for good", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const { orderId, hash } = await payHeld(api);
  api.node.resolvePayment(hash, "succeed");
  await until(() => api.autopilot.purchases.get(orderId)?.state === "paid", "the payment");
  // The app was down for the whole lease: Amboss's order is already past
  // VALID_CHANNEL_OPENING.
  magma.purchases.get(orderId)!.status = "CHANNEL_MONITORING_FINISHED";
  await api.autopilot.pollSellOrders();
  assert.equal(api.autopilot.purchases.get(orderId)?.state, "channel_open");
  assert.equal(api.autopilot.purchases.paidCosts().length, 1);
});

test("a dollar buy (Amboss picks the seller) is completed in the ledger as its order goes: channel size, lease, seller and fee promise — in paidCosts() for the P&L", async (t) => {
  quiet(t);
  const { api, magma } = await buyApi(t);
  const quote = await api.request("POST", "/amboss/buy/quote", { usdCents: 500 });
  assert.equal(quote.status, 200, JSON.stringify(quote.body));
  const id = quote.body.orderId as string;
  const ledger = api.autopilot.purchases;
  const q = ledger.get(id)!;
  assert.deepEqual([q.sizeSats, q.leaseBlocks, q.sellerPubkey, q.feeRateCapPpm], [0, null, null, null], "liquidity.buy's answer names none of it");
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: id, maxSats: quote.body.sats })).status, 200);
  await until(() => ledger.get(id)?.state === "paid", "the payment");
  // Amboss matched a seller, who opened the channel.
  const p = magma.purchases.get(id)!;
  p.status = "VALID_CHANNEL_OPENING";
  p.channelId = "870000x1x0";
  await api.autopilot.pollSellOrders();
  const rec = ledger.get(id)!;
  assert.equal(rec.state, "channel_open");
  // Before: size 0 and no lease for good — the Purchases table showed "—",
  // and the P&L had nothing to spread the cost over.
  assert.deepEqual(
    [rec.sizeSats, rec.leaseBlocks, rec.sellerPubkey, rec.feeRateCapPpm, rec.baseFeeCapSats],
    [2_500_000, 4320, magma.matchedSeller, 2200, 1],
  );
  assert.deepEqual(ledger.paidCosts().map((c) => [c.orderId, c.sizeSats, c.leaseBlocks]), [[id, 2_500_000, 4320]]);
  // A seller who promised nothing locks a cap of 0: no promise, not "0 ppm".
  magma.buyPromises = { minBlockLength: 4320, feeRateCap: "0", baseFeeCap: "0" };
  const bare = (await api.request("POST", "/amboss/buy/quote", { usdCents: 500 })).body;
  magma.purchases.get(bare.orderId)!.status = "VALID_CHANNEL_OPENING";
  const view = await api.request("GET", `/amboss/order?id=${bare.orderId}`);
  assert.deepEqual([view.body.feeRateCapPpm, view.body.baseFeeCapSats, view.body.leaseBlocks], [null, null, 4320]);
  assert.deepEqual([ledger.get(bare.orderId)?.feeRateCapPpm, ledger.get(bare.orderId)?.baseFeeCapSats], [null, null]);
});

test("the order fills in only what the quote couldn't say — a targeted buy's quoted size, lease and promise stand; a promise of 0 is no promise", (t) => {
  const ledger = new MagmaPurchases(makeTempDir(t));
  ledger.recordQuote(quoteFields("o-targeted"));
  ledger.startPayment("o-targeted");
  const order = { status: "VALID_CHANNEL_OPENING", paymentStatus: null, channelId: "870000x1x0", channelSizeSats: 9_999_999, done: true, failed: false };
  ledger.fromOrder("o-targeted", { ...order, leaseBlocks: 8640, feeRateCapPpm: 5000, baseFeeCapSats: 9, sellerPubkey: "03" + "99".repeat(32) });
  const r = ledger.get("o-targeted")!;
  assert.deepEqual([r.sizeSats, r.leaseBlocks, r.feeRateCapPpm, r.baseFeeCapSats, r.sellerPubkey], [2_000_000, 4320, 2200, 1, "02" + "11".repeat(32)]);
  ledger.recordQuote({ ...quoteFields("o-usd"), offerId: null, sellerPubkey: null, sizeSats: 0, leaseBlocks: null, feeRateCapPpm: null, baseFeeCapSats: null, usdCents: 500 });
  ledger.startPayment("o-usd");
  ledger.fromOrder("o-usd", { ...order, channelSizeSats: 2_500_000, leaseBlocks: 4320, feeRateCapPpm: null, baseFeeCapSats: null, sellerPubkey: null });
  const u = ledger.get("o-usd")!;
  assert.deepEqual([u.sizeSats, u.leaseBlocks, u.feeRateCapPpm, u.sellerPubkey], [2_500_000, 4320, null, null]);
});

test("a payment LND confirms failed is followed no more; one LND never saw is failed only once it has had time to start", async (t) => {
  quiet(t);
  const { api } = await buyApi(t);
  const { orderId, hash } = await payHeld(api);
  api.node.resolvePayment(hash, "fail");
  await until(() => api.autopilot.purchases.get(orderId)?.state === "pay_failed", "the failure");
  await api.autopilot.pollSellOrders();
  assert.equal(api.autopilot.purchases.get(orderId)?.failureConfirmed, true);
  assert.deepEqual(api.autopilot.purchases.followUps().payments, []);
  // A record that says "paying" but whose payment LND doesn't know …
  const dir = makeTempDir(t);
  const ledger = new MagmaPurchases(dir);
  ledger.recordQuote({ ...quoteFields("o-2"), paymentHash: "ab".repeat(32) });
  ledger.startPayment("o-2");
  const now = Date.now();
  ledger.paymentOutcome("o-2", { status: "not_found" }, now + 60_000);
  assert.equal(ledger.get("o-2")?.state, "paying", "just started: LND may not have it yet");
  ledger.paymentOutcome("o-2", { status: "not_found" }, now + 11 * 60_000);
  assert.equal(ledger.get("o-2")?.state, "pay_failed");
  assert.equal(ledger.get("o-2")?.failureConfirmed, true, "it never left this node");
});

const quoteFields = (orderId: string) => ({
  orderId,
  offerId: "offer-a",
  sellerPubkey: "02" + "11".repeat(32),
  sizeSats: 2_000_000,
  feeSats: 5_068,
  paymentRequest: "lnbc1",
  paymentHash: "aa".repeat(32),
  payee: "02" + "11".repeat(32),
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  leaseBlocks: 4320,
  feeRateCapPpm: 2200,
  baseFeeCapSats: 1,
  usdCents: null,
});

test("no report moves a purchase backwards: a late 'paid' never undoes 'channel open', a late failure never undoes 'paid'", (t) => {
  const ledger = new MagmaPurchases(makeTempDir(t));
  ledger.recordQuote(quoteFields("o-1"));
  ledger.startPayment("o-1");
  ledger.fromOrder("o-1", { status: "VALID_CHANNEL_OPENING", paymentStatus: null, channelId: "870000x1x0", channelSizeSats: 2_000_000, done: true, failed: false });
  assert.equal(ledger.get("o-1")?.state, "channel_open");
  // The pay call's answer arrives late.
  ledger.paymentOutcome("o-1", { status: "succeeded", feeSats: 3 });
  assert.equal(ledger.get("o-1")?.state, "channel_open", "before: overwritten with 'paid'");
  assert.equal(ledger.get("o-1")?.routingFeeSats, 3, "its fee is still recorded");
  // And a failure report after a success changes nothing.
  ledger.recordQuote(quoteFields("o-3"));
  ledger.startPayment("o-3");
  ledger.paymentOutcome("o-3", { status: "succeeded", feeSats: 1 });
  ledger.paymentOutcome("o-3", { status: "failed", error: "stream removed", confirmed: false });
  assert.equal(ledger.get("o-3")?.state, "paid");
  // An order Amboss reports done after ending its lease (CHANNEL_MONITORING_FINISHED) is done too.
  ledger.recordQuote(quoteFields("o-4"));
  ledger.startPayment("o-4");
  ledger.fromOrder("o-4", { status: "CHANNEL_MONITORING_FINISHED", paymentStatus: null, channelId: "860000x1x0", channelSizeSats: 2_000_000, done: true, failed: false });
  assert.equal(ledger.get("o-4")?.state, "channel_open");
});

test("a channel that opened stays bought: a failure status Amboss reports afterwards never moves the purchase back to 'order failed' — nor out of the P&L feed", (t) => {
  const ledger = new MagmaPurchases(makeTempDir(t));
  ledger.recordQuote(quoteFields("o-open"));
  ledger.startPayment("o-open");
  ledger.paymentOutcome("o-open", { status: "succeeded", feeSats: 2 });
  ledger.fromOrder("o-open", { status: "VALID_CHANNEL_OPENING", paymentStatus: null, channelId: "870000x1x0", channelSizeSats: 2_000_000, done: true, failed: false });
  assert.equal(ledger.get("o-open")?.state, "channel_open");
  const costs = ledger.paidCosts();
  assert.deepEqual(costs.map((c) => c.orderId), ["o-open"]);
  // Later Amboss closes the order on its side: the channel is open on this
  // node, and the payment settled when Amboss confirmed it.
  ledger.fromOrder("o-open", { status: "ADMIN_CLOSED", paymentStatus: null, channelId: "870000x1x0", channelSizeSats: 2_000_000, done: false, failed: true });
  // Taken at its word, that would be "order failed" — the inbound bought
  // gone from paidCosts(), as if the payment had come back.
  assert.equal(ledger.get("o-open")?.state, "channel_open");
  assert.equal(ledger.get("o-open")?.orderStatus, "ADMIN_CLOSED", "Amboss's word is kept on record");
  assert.deepEqual(ledger.paidCosts(), costs);
});

test("the purchase follow-up runs apart from the order lane: the pass is on record first, reads run in parallel, a second follow-up doesn't stack, and none starts after shutdown", async (t) => {
  quiet(t);
  const saved = HTTP_TIMEOUTS.ambossQueryMs;
  HTTP_TIMEOUTS.ambossQueryMs = 3_000;
  t.after(() => {
    HTTP_TIMEOUTS.ambossQueryMs = saved;
  });
  const { api, magma } = await buyApi(t);
  api.node.chainBalance = 20_000_000;
  api.autopilot.setConfig({ sellEnabled: true, sellMaxDeploySats: 2_000_000, sellMaxChannelSats: 5_000_000 });
  // Something for the lane to record: an order it turns down (above the cap).
  magma.addSale({ buyerPubkey: BUYER, sizeSats: 3_000_000 });
  // Three paid purchases whose Amboss reads hang.
  for (const id of ["p-1", "p-2", "p-3"]) {
    api.autopilot.purchases.recordQuote(quoteFields(id));
    api.autopilot.purchases.update(id, { state: "paid", routingFeeSats: 2, paidAt: new Date().toISOString() });
  }
  magma.orderReadBehaviour = "hang";
  const polling = api.autopilot.pollSellOrders();
  // All three reads in flight at once — one after the other, the second
  // would only start after the first one's 3 s deadline.
  await until(() => magma.count("GetOrder") === 3, "the three reads at once", 2_500);
  // The lane's pass was on record before the follow-up started.
  assert.equal(api.autopilot.getState().history.length, 1, "the pass's history line, written before the follow-up");
  // A follow-up already running: a second one (the next 45 s tick) adds nothing.
  await api.autopilot.followPurchases();
  assert.equal(magma.count("GetOrder"), 3);
  await polling;
  // Shutdown: no follow-up read starts any more.
  api.autopilot.shutdown();
  await api.autopilot.followPurchases();
  assert.equal(magma.count("GetOrder"), 3);
});

// ── /amboss/buy/pay pays only the quote's own invoice ─────────────────────────

test("an expired quote is refused (409) and nothing is paid", async (t) => {
  quiet(t);
  const { api } = await buyApi(t);
  const quote = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
  api.autopilot.purchases.update(quote.orderId, { expiresAt: new Date(Date.now() - 1_000).toISOString() });
  const res = await api.request("POST", "/amboss/buy/pay", { orderId: quote.orderId, maxSats: quote.sats });
  assert.equal(res.status, 409);
  assert.equal(res.body.error, "expired");
  assert.equal(api.node.payments.size, 0);
});

test("a quote whose invoice is this node's own is refused — and a record that doesn't match its invoice (payee, amount) is never paid", async (t) => {
  quiet(t);
  const { api } = await buyApi(t);
  const own = api.node.publicKey;
  // An invoice of this node, recorded as a quote: paying it would pay ourselves.
  const self = api.node.makeOwnRequest(5_068);
  api.autopilot.purchases.recordQuote({ ...quoteFields("self-1"), paymentRequest: self, payee: own, feeSats: 5_068 });
  const res = await api.request("POST", "/amboss/buy/pay", { orderId: "self-1", maxSats: 5_068 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "wrong_payee");
  // A record whose payee or amount differs from its own invoice (a damaged
  // ledger): the invoice decoded now is what would be paid — refused.
  const quote = (await api.request("POST", "/amboss/buy/quote", { offerId: "offer-a", sizeSats: 2_000_000 })).body;
  const rec = api.autopilot.purchases.get(quote.orderId)!;
  api.autopilot.purchases.update(quote.orderId, { payee: "02" + "77".repeat(32) });
  assert.equal((await api.request("POST", "/amboss/buy/pay", { orderId: quote.orderId, maxSats: quote.sats })).body.error, "wrong_payee");
  api.autopilot.purchases.update(quote.orderId, { payee: rec.payee, feeSats: quote.sats - 1_000 });
  const amount = await api.request("POST", "/amboss/buy/pay", { orderId: quote.orderId, maxSats: quote.sats });
  assert.equal(amount.status, 400);
  assert.equal(amount.body.error, "amount_mismatch", "the confirmed amount covers it, but it isn't what was quoted");
  assert.equal(api.node.payments.size, 0);
});
