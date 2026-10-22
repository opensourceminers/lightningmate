/**
 * One Amboss account can sell for several nodes: its sales listing and its
 * offer list show all of them, with the same API key. LightningMate only acts
 * on THIS node's orders and offers — it never accepts, rejects or opens for
 * another node's order, and never reprices, resizes, enables or disables
 * another node's offer. Before, neither the listing nor the offers were told
 * apart by node: the lane accepted another node's order with this node's
 * invoice and opened a channel from this node for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma, internalError, resolverFailed } from "./helpers/magma.js";
import { startApi } from "./helpers/apiHarness.js";
import { IN_AN_HOUR, entryOnDisk, quiet } from "./helpers/lifecycle.js";

/** Another node of the same Amboss account. */
const OTHER_NODE = "03" + "77".repeat(32);

const ordersTouched = (magma: FakeMagma, op: string): string[] =>
  magma.calls.filter((c) => c.op === op).map((c) => String((c.variables.input as { order_id: string }).order_id));

test("the lane never accepts or rejects an order of another node of the account — and keeps no record of it", async (t) => {
  quiet(t);
  const { autopilot, magma, node, dir } = sellerSetup(t);
  const theirs = magma.addSale({ buyerPubkey: BUYER, sellerPubkey: OTHER_NODE, timeout: IN_AN_HOUR() });
  // One this node could not serve: were it ours, it would be rejected at once.
  const theirsTooBig = magma.addSale({ buyerPubkey: BUYER, sellerPubkey: OTHER_NODE, sizeSats: 900_000_000, timeout: IN_AN_HOUR() });
  const ours = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.deepEqual(ordersTouched(magma, "AcceptOrder"), [ours.id], "only this node's order is accepted");
  assert.deepEqual(ordersTouched(magma, "RejectOrder"), [], "another node's order is never turned down from here");
  assert.equal(magma.sales.get(theirs.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(magma.sales.get(theirsTooBig.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(entryOnDisk(dir, theirs.id), undefined);
  assert.equal(entryOnDisk(dir, theirsTooBig.id), undefined);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 1, "one HODL invoice: for this node's order");
});

test("an order of another node that this node had taken on (before orders were told apart) is released, not opened: our invoice is cancelled, the buyer refunded", async (t) => {
  quiet(t);
  const { autopilot, magma, node, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  // As an older version saw it: the account's listing showed it, and the
  // lane took it on. It is the other node's (Amboss: source.pubkey).
  magma.sales.get(sale.id)!.sellerPubkey = OTHER_NODE;
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 0, "no channel from this node for another node's order");
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "the payment our invoice held goes back to the buyer");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.equal(e?.external, "other_node");
  assert.match(e?.reason ?? "", /another node of your Amboss account/);
});

test("another node's order whose held payment couldn't be released yet is not 'opened by the autopilot' — it is no order of this node's to open (review of P8)", async (t) => {
  quiet(t);
  const { autopilot, magma, node, dir, desk } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  magma.sales.get(sale.id)!.sellerPubkey = OTHER_NODE;
  node.failNext("invoices.cancelInvoice", "transport is closing");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  // Not ended yet (the release is tried again), but marked another node's.
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "still held — released on a later pass");
  assert.notEqual(e?.phase, "cancelled");
  assert.equal(e?.external, "other_node");
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_CHANNEL_OPEN");
  assert.equal(node.callsTo("default.openChannel").length, 0);
  // Before: true — this node's lane, selling on.
  assert.equal(desk.opensItself(sale.id), false);
});

test("Accept, Open channel and Reject refuse another node's order — nothing is sent to Amboss", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { config: { sellEnabled: false } });
  const waiting = magma.addSale({ buyerPubkey: BUYER, sellerPubkey: OTHER_NODE, timeout: IN_AN_HOUR() });
  const paid = magma.addSale({ buyerPubkey: BUYER, sellerPubkey: OTHER_NODE, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
  for (const [what, r] of [
    ["accept", await autopilot.magma.accept(waiting.id)],
    ["reject", await autopilot.magma.reject(waiting.id)],
    ["open", await autopilot.magma.open(paid.id)],
  ] as const) {
    assert.equal(r.ok, false, what);
    assert.equal(r.code, "bad_status", what);
    assert.match(r.message, /another node of your Amboss account/, what);
  }
  assert.equal(magma.calls.length, 0, "no mutation at all");
});

// Review of P9, round 2: a click that can't read an order the lane has on
// record takes the order into the operator's hands, and the lane sends their
// reject without reading the order first (unreadClick). Amboss answering
// that the order is another node's is no failed read: such a click takes
// nothing over. Nothing pinned that: without the check, every test stayed
// green.
test("Reject on an order this node recorded before orders were told apart, which Amboss now shows as another node's: refused — the click takes nothing over, and the lane never sends a reject for it", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  // Amboss hasn't reported its fee: the lane records the order and waits.
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.deepEqual([entryOnDisk(dir, sale.id)?.phase, entryOnDisk(dir, sale.id)?.via], ["seen", "autopilot"]);
  // As an older version saw it: it is the other node's (Amboss: source.pubkey).
  magma.sales.get(sale.id)!.sellerPubkey = OTHER_NODE;
  autopilot.setConfig({ sellEnabled: false });
  const r = await autopilot.magma.reject(sale.id);
  assert.deepEqual([r.ok, r.code], [false, "bad_status"], r.message);
  assert.match(r.message, /another node of your Amboss account .*this node's orders\.$/);
  const e = entryOnDisk(dir, sale.id);
  assert.deepEqual([e?.via, e?.decision?.action], ["autopilot", "skip"], "not marked as the operator's reject");
  // Amboss won't show it to the lane now, and with selling off there is no
  // listing to tell: a reject on record would be sent on its id alone.
  magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await autopilot.pollSellOrders();
  assert.equal(magma.count("RejectOrder"), 0, "another node's order is never turned down from here");
});

test("over HTTP: a click on another node's order is a 409, and the Orders view lists only this node's sales", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const api = await startApi(t);
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  const theirs = magma.addSale({ buyerPubkey: BUYER, sellerPubkey: OTHER_NODE, timeout: IN_AN_HOUR() });
  const ours = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  const res = await api.request("POST", "/amboss/order/reject", { id: theirs.id });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /another node/);
  const view = await api.request("GET", "/amboss/my-orders");
  assert.deepEqual(view.body.orders.map((o: { id: string }) => o.id), [ours.id]);
  assert.equal(view.body.pendingSeller, 1, "another node's waiting order is not 'waiting on you'");
});

test("offer upkeep and the offer routes only touch this node's offers", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 3_000_000 });
  const ours = magma.addOffer({ minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000 });
  const theirs = magma.addOffer({ pubkey: OTHER_NODE, minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000 });
  await autopilot.runOnce();
  assert.equal(ours.maxSats, 2_940_000, "this node's offer is kept fundable");
  assert.equal(theirs.maxSats, 5_000_000, "another node's offer is not ours to resize");
  assert.equal(theirs.status, "ENABLED");
  const touched = magma.calls.filter((c) => /Offer$/.test(c.op)).map((c) => (c.variables.input as { offer_id?: string }).offer_id);
  assert.deepEqual(touched, [ours.id]);
  assert.deepEqual(autopilot.offerSyncStatus().offers.map((o) => o.offerId), [ours.id]);
});

test("over HTTP: updating or disabling another node's offer is refused (409) — nothing is written", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const api = await startApi(t);
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  const ours = magma.addOffer();
  const theirs = magma.addOffer({ pubkey: OTHER_NODE });
  const terms = { totalSizeSats: 4_000_000, minSizeSats: 1_000_000, maxSizeSats: 4_000_000, feeRatePpm: 2971, baseFeeSats: 852, minBlockLength: 4320 };
  const update = await api.request("POST", "/amboss/offer/update", { id: theirs.id, ...terms });
  assert.equal(update.status, 409);
  assert.equal(update.body.error, "other_node");
  const toggle = await api.request("POST", "/amboss/offer/toggle", { id: theirs.id });
  assert.equal(toggle.status, 409);
  assert.equal(magma.calls.length, 0, "nothing written to another node's offer");
  assert.equal(theirs.status, "ENABLED");
  const listed = await api.request("GET", "/amboss/my-offers");
  assert.deepEqual(listed.body.offers.map((o: { id: string }) => o.id), [ours.id]);
});

test("the deploy cap counts only this node's sold capital — another node's running lease does not turn this node's buyers away", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t, { config: { sellMaxDeploySats: 3_000_000, sellMaxChannelSats: 3_000_000 } });
  // A 5M lease another node of the account sold, still running.
  magma.addSale({ buyerPubkey: BUYER, sellerPubkey: OTHER_NODE, sizeSats: 5_000_000, status: "VALID_CHANNEL_OPENING" });
  const ours = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  // Counted as ours, it would be "deploy cap reached (5,000,000 sat already sold …)".
  assert.equal(entryOnDisk(dir, ours.id)?.phase, "accepted");
  assert.equal(magma.sales.get(ours.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
});

test("another node's order Amboss lists but won't show, close to its deadline, is never rejected from here — nor recorded", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const theirs = magma.addSale({
    buyerPubkey: BUYER,
    sellerPubkey: OTHER_NODE,
    timeout: new Date(Date.now() + 60_000).toISOString(), // inside the reject margin
  });
  magma.saleRead = (id) => (id === theirs.id ? internalError() : null);
  await autopilot.pollSellOrders();
  // Counted as ours, it would be "rejected rather than left to time out".
  assert.deepEqual(ordersTouched(magma, "RejectOrder"), []);
  assert.equal(magma.sales.get(theirs.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(entryOnDisk(dir, theirs.id), undefined);
  assert.equal(autopilot.getState().magmaLane.ok, true, "another node's orders are not this lane's problem");
});

test("auto-close only closes this node's finished leases — another node's is neither read nor closed, even when a channel here carries its funding txid", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t, { config: { sellAutoClose: true } });
  const txid = "cf".repeat(32);
  node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  const theirs = magma.addSale({ buyerPubkey: BUYER, sellerPubkey: OTHER_NODE, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  node.override("default.closeChannel", () => {
    const s = Object.assign(new EventEmitter(), { cancel: () => undefined });
    setImmediate(() => s.emit("data", { update: "close_pending", close_pending: { txid: randomBytes(32), output_index: 0 } }));
    return s;
  });
  const reads: string[] = [];
  magma.saleRead = (id) => {
    reads.push(id);
    return null;
  };
  const run = await autopilot.runOnce();
  assert.equal(run.sells.filter((s) => s.action === "close").length, 0);
  assert.equal(node.callsTo("default.closeChannel").length, 0, "not this node's lease to end");
  assert.ok(!reads.includes(theirs.id), "its order is not even read");
});
