/**
 * The Magma order lane when Amboss can't be asked: no key (Disconnect /
 * Remove key), a key Amboss refuses, or one order Amboss won't show.
 *
 * Before: without a key the lane returned at once, and with a refused key
 * every pass stopped at the first refusal. Nothing that needs only LND
 * happened any more — a held payment ran into its HTLC expiry, and orders in
 * flight kept their coins reserved (blocking routing opens, LSPS1 and the
 * offer) until a key came back. One order Amboss answered FORBIDDEN for
 * stopped the lane for every other order, for good.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MagmaJournalEntry } from "../src/services/magmaJournal.js";
import { AmbossError } from "../src/services/amboss.js";
import { acceptedInvoice, forbidden } from "./helpers/magma.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { startApi } from "./helpers/apiHarness.js";

const OTHER_BUYER = "02" + "cd".repeat(32);

const entryOnDisk = (dir: string, id: string): MagmaJournalEntry | undefined =>
  (JSON.parse(readFileSync(join(dir, "magma-orders.json"), "utf8")) as MagmaJournalEntry[]).find((e) => e.orderId === id);

function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
}

/** Every request the fake Magma API has answered so far. */
const ambossCalls = (magma: FakeMagma) =>
  ["Sales", "Sale", "AcceptOrder", "AddTransaction", "RejectOrder", "KeyCheck"].reduce((n, op) => n + magma.count(op), 0);

test("key removed: the lane still releases a held payment before its HTLC expires, and an invoice that expired unpaid frees its coins", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, amboss, capital } = sellerSetup(t);
  const paid = magma.addSale({ buyerPubkey: BUYER });
  const unpaid = magma.addSale({ buyerPubkey: OTHER_BUYER });
  await autopilot.pollSellOrders();
  assert.equal(capital.reservedSat(), 4_000_000, "both accepted: their coins are reserved");

  amboss.clear(); // Settings → Remove key, with both orders in flight
  assert.equal(autopilot.magma.ordersInFlight(), 2);
  const inv = acceptedInvoice(magma.sales.get(paid.id)!);
  node.payHoldInvoice(inv.id, { expiryHeight: node.blockHeight + 100 });
  const calls = ambossCalls(magma);

  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, paid.id)?.phase, "held", "the payment is on record — and still held: there is time");
  assert.equal(node.invoices.get(inv.id)?.state, "ACCEPTED");
  assert.match(autopilot.getState().magmaLane.error ?? "", /no Amboss key/);

  // 80 blocks later the HTLC is about to expire, and the unpaid order's
  // invoice has passed its expiry.
  node.blockHeight += 80;
  autopilot.magma.journal.get(unpaid.id)!.invoice!.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(inv.id)?.state, "CANCELED", "released to the buyer before the HTLC expired");
  assert.equal(entryOnDisk(dir, paid.id)?.phase, "cancelled");
  const unpaidInvoice = acceptedInvoice(magma.sales.get(unpaid.id)!);
  assert.equal(node.invoices.get(unpaidInvoice.id)?.state, "CANCELED");
  assert.equal(entryOnDisk(dir, unpaid.id)?.phase, "cancelled");
  assert.equal(capital.reservedSat(), 0, "no coins stay reserved for orders that can't complete");
  assert.equal(ambossCalls(magma), calls, "without a key, not a single call to Amboss");
  assert.equal(node.callsTo("default.openChannel").length, 0, "no channel without Amboss to report it to");
});

test("a key Amboss refuses: the pass doesn't stop at the refusal — what LND can do still happens", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, amboss } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const inv = acceptedInvoice(magma.sales.get(sale.id)!);
  node.payHoldInvoice(inv.id, { expiryHeight: node.blockHeight + 20 }); // about to expire
  magma.keyValid = false; // the key was revoked on amboss.tech

  await autopilot.pollSellOrders();
  assert.equal(amboss.getValidity(), false, "the key check confirmed the refusal");
  assert.equal(node.invoices.get(inv.id)?.state, "CANCELED", "the held payment was still released in time");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
  assert.match(autopilot.getState().magmaLane.error ?? "", /rejects your key/);
});

test("one order Amboss refuses to show doesn't hold up the others — and with nothing of ours tied to it, it is dropped", async (t) => {
  quiet(t);
  const { autopilot, magma, dir, amboss } = sellerSetup(t);
  // Waiting for Amboss to report its fee (the lane looks again each pass).
  const stuck = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 3_600_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, stuck.id)?.phase, "seen");

  // From now on Amboss answers FORBIDDEN for this one order (taken on under
  // another account's key, say) — the key itself is fine. Such an order isn't
  // in THIS account's listing of the orders waiting on it either (one that is
  // listed is never dropped on a refusal: see the next test).
  magma.sales.delete(stuck.id);
  const desk = autopilot.magma as unknown as { ambossSale: (key: string, id: string) => Promise<unknown> };
  const real = desk.ambossSale.bind(autopilot.magma);
  let refused = 0;
  desk.ambossSale = async (key, id) => {
    if (id === stuck.id) {
      refused += 1;
      throw new AmbossError("auth", "Forbidden resource", 403, "FORBIDDEN");
    }
    return real(key, id);
  };
  const fresh = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(fresh.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "the other order was served in the same pass");
  assert.equal(amboss.getValidity(), true, "the key check said the key is fine");
  assert.match(entryOnDisk(dir, stuck.id)?.lastError ?? "", /refused to show this order/);

  await autopilot.pollSellOrders();
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, stuck.id);
  assert.equal(e?.phase, "failed", "three refusals in a row, nothing of ours tied to it: dropped");
  assert.match(e?.reason ?? "", /refuses to show this order to your key/);
  const asked = refused;
  await autopilot.pollSellOrders();
  assert.equal(refused, asked, "and no longer asked about");
});

test("an order Amboss lists as waiting on us is never dropped on a refused read (an edge's 403, a hiccup in its guard): it is accepted once Amboss shows it again", async (t) => {
  quiet(t);
  const { autopilot, magma, dir, amboss } = sellerSetup(t);
  // Waiting for Amboss to report its fee: "seen", nothing of ours tied to it.
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 3_600_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");

  // Its read is refused four passes in a row. The key check says the key is
  // fine, and Amboss's listing still shows the order waiting on us.
  let refusing = true;
  magma.saleRead = (id) => (refusing && id === sale.id ? forbidden("Sale") : null);
  for (let i = 0; i < 4; i++) {
    await autopilot.pollSellOrders();
    // Not ended for a moment either (a "failed" order Amboss lists waiting
    // is taken up again a pass later — too late, near its deadline).
    assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen", `pass ${i + 1}`);
  }
  assert.doesNotMatch(entryOnDisk(dir, sale.id)?.events.map((x) => x.what).join(" | ") ?? "", /refuses to show this order to your key/);
  assert.equal(amboss.getValidity(), true);
  const e = entryOnDisk(dir, sale.id);
  // Before: "failed — Amboss refuses to show this order to your key" after the
  // third pass, for good. The lane never decided on it again, the Orders tab
  // hid Accept and Reject, and the order timed out on us.
  assert.equal(e?.phase, "seen", "listed as waiting on us: it is ours, and it exists");
  assert.equal(e?.reason, undefined);
  assert.match(e?.lastError ?? "", /refused to show this order \(Forbidden resource\)/);
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false, "not silent");
  assert.match(lane.error ?? "", /could not read 1 order from Amboss \(Forbidden resource\)/);

  refusing = false;
  magma.sales.get(sale.id)!.feeSeller = "12345";
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted once Amboss shows it");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "accepted");
  assert.equal(autopilot.getState().magmaLane.ok, true);
});

const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();

test("Amboss's guard refusing the listing AND the order's read (the key itself fine) ends nothing: with no listing to check against, a refusal isn't counted — the order is accepted once Amboss answers", async (t) => {
  quiet(t);
  const { autopilot, magma, dir, amboss } = sellerSetup(t);
  // Waiting for Amboss to report its fee: "seen", nothing of ours tied to it.
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");

  // A hiccup in the guard in front of Amboss's market resolvers: the listing
  // and the order's read are refused alike, four passes in a row.
  let refusing = true;
  magma.salesList = (f) => (refusing && f.action_needed ? forbidden("Sales") : null);
  magma.saleRead = () => (refusing ? forbidden("Sale") : null);
  for (let i = 0; i < 4; i++) await autopilot.pollSellOrders();
  assert.equal(amboss.getValidity(), true, "the key check says the key is fine");
  const e = entryOnDisk(dir, sale.id);
  // Before: "failed — Amboss refuses to show this order to your key" after the
  // third pass, though Amboss may well have listed it: never accepted nor
  // rejected, it timed out on us.
  assert.equal(e?.phase, "seen", "still to be decided");
  assert.equal(e?.refusals, undefined, "nothing counted without a listing to check against");
  assert.match(e?.lastError ?? "", /refused to show this order \(Forbidden resource\)/);
  assert.match(autopilot.getState().magmaLane.error ?? "", /could not list your sales on Amboss: Forbidden resource/);

  refusing = false;
  magma.sales.get(sale.id)!.feeSeller = "12345";
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted once Amboss answers");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "accepted");
});

test("selling off (no listing at all): an order you tried to accept by hand, whose reads Amboss then refuses pass after pass, is still yours to accept", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  magma.behave.AcceptOrder = (n) => (n === 0 ? "false" : "ok");
  const first = await autopilot.magma.accept(sale.id);
  assert.equal(first.ok, false, "Amboss refused the first accept");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");
  let refusing = true;
  magma.saleRead = () => (refusing ? forbidden("Sale") : null);
  for (let i = 0; i < 4; i++) await autopilot.pollSellOrders();
  // Before: "failed" after the third pass; the Orders tab hid Accept, and the
  // second click got "Order is already failed here." — while Amboss still
  // waited for an answer.
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");
  refusing = false;
  const again = await autopilot.magma.accept(sale.id);
  assert.equal(again.ok, true, again.message);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
});

test("a 'seen' order with no approval deadline on record that Amboss keeps refusing to show ends a day after it was recorded — and should Amboss show it waiting for your approval after all, it is yours to accept or reject", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
  // Two clicks Amboss refuses (success:false): on record as "seen", with no
  // deadline — no read of the lane has got through yet.
  magma.behave.AcceptOrder = (n) => (n < 2 ? "false" : "ok");
  const a = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  const b = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  for (const s of [a, b]) assert.equal((await autopilot.magma.accept(s.id)).ok, false);
  let refusing = true;
  magma.saleRead = () => (refusing ? forbidden("Sale") : null);
  await autopilot.pollSellOrders();
  for (const s of [a, b]) {
    assert.equal(entryOnDisk(dir, s.id)?.phase, "seen");
    assert.equal(entryOnDisk(dir, s.id)?.timeout ?? null, null, "no deadline on record");
  }
  const recordedAgo = (hours: number) => {
    for (const s of [a, b]) autopilot.magma.journal.get(s.id)!.createdAt = new Date(Date.now() - hours * 3_600_000).toISOString();
  };
  recordedAgo(23);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, a.id)?.phase, "seen", "under a day: still asked about");
  recordedAgo(25);
  await autopilot.pollSellOrders();
  for (const s of [a, b]) {
    const e = entryOnDisk(dir, s.id);
    assert.equal(e?.phase, "failed");
    assert.match(e?.reason ?? "", /^recorded over a day ago with no approval deadline, and Amboss would not show it \(Forbidden resource\)/);
  }
  const asked = magma.count("Sale") + magma.count("KeyCheck");
  await autopilot.pollSellOrders();
  assert.equal(magma.count("Sale") + magma.count("KeyCheck"), asked, "no longer asked about — nor the key re-checked for it every pass");

  // Amboss shows both waiting for your approval after all: yours to decide.
  refusing = false;
  const accepted = await autopilot.magma.accept(a.id);
  assert.equal(accepted.ok, true, accepted.message);
  assert.equal(magma.sales.get(a.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  const rejected = await autopilot.magma.reject(b.id);
  assert.equal(rejected.ok, true, rejected.message);
  assert.equal(magma.sales.get(b.id)?.status, "SELLER_REJECTED");
  assert.equal(entryOnDisk(dir, b.id)?.phase, "rejected");
  assert.match(entryOnDisk(dir, a.id)?.events.map((x) => x.what).join(" | ") ?? "", /waiting for your approval after all/);
});

test("an order ended here as 'failed' with nothing of ours tied to it, that Amboss lists waiting for approval after all, is decided again — not left to time out", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const stuck = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  // Not in this account's listing, its read refused (the key fine): dropped
  // after three passes, as an order of another account would be.
  magma.sales.delete(stuck.id);
  let refusing = true;
  magma.saleRead = (id) => (refusing && id === stuck.id ? forbidden("Sale") : null);
  for (let i = 0; i < 3; i++) await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, stuck.id)?.phase, "failed");

  // Amboss lists it waiting for our approval after all, and shows it.
  refusing = false;
  stuck.feeSeller = "12345";
  magma.sales.set(stuck.id, stuck);
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, stuck.id);
  assert.equal(magma.sales.get(stuck.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "decided — accepted");
  assert.equal(e?.phase, "accepted");
  assert.equal(e?.reason, undefined);
  assert.match(e?.events.map((x) => x.what).join(" | ") ?? "", /waiting for your approval after all/);
});

test("Settings is told how many Magma orders are in flight before the key is removed", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 20_000_000 }) });
  magma.sellerPubkey = api.node.publicKey; // this node's sales and offers
  api.amboss.setKey("test-key");
  const sale = magma.addSale({ buyerPubkey: BUYER });
  let status = await api.request("GET", "/amboss/status");
  assert.equal(status.body.ordersInFlight, 0);
  const accepted = await api.request("POST", "/amboss/order/accept", { id: sale.id });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  status = await api.request("GET", "/amboss/status");
  assert.equal(status.body.ordersInFlight, 1, "one order accepted and not finished");
  const rechecked = await api.request("POST", "/amboss/key/check");
  assert.equal(rechecked.body.ordersInFlight, 1);
});

test("key removed: an order accepted before the journal (no hold invoice of ours) gives its coins back once its open deadline has passed", async (t) => {
  quiet(t);
  const { autopilot, magma, dir, amboss, capital } = sellerSetup(t, { chainBalance: 1_500_000 });
  // Paid through 0.7.x's plain invoice; the open can't be funded right now.
  const sale = magma.addSale({
    buyerPubkey: BUYER,
    status: "WAITING_FOR_CHANNEL_OPEN",
    paymentStatus: "SUCCESSFUL_PAYMENT",
    timeout: new Date(Date.now() + 3_600_000).toISOString(),
  });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "held");
  assert.equal(capital.reservedSat(), 2_000_000);

  amboss.clear();
  await autopilot.pollSellOrders();
  assert.equal(capital.reservedSat(), 2_000_000, "its deadline hasn't passed: the coins stay promised");
  autopilot.magma.journal.get(sale.id)!.timeout = new Date(Date.now() - 60_000).toISOString();
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "failed");
  assert.match(e?.reason ?? "", /deadline passed while Amboss could not be asked/);
  assert.equal(capital.reservedSat(), 0);
});

test("the lane's status doesn't outlive what it describes: after an outage, a lane with nothing to do says so — no 'unreachable … retrying'", async (t) => {
  quiet(t);
  const { autopilot, magma, amboss } = sellerSetup(t);
  magma.readBehaviour = "throw"; // Amboss down
  await autopilot.pollSellOrders();
  let lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false);
  assert.match(lane.error ?? "", /Amboss unreachable/);
  assert.equal(lane.retrying, true, "an outage: the next pass tries again");

  // Selling switched off; nothing in flight; Amboss is back.
  autopilot.setConfig({ sellEnabled: false });
  magma.readBehaviour = "ok";
  await autopilot.pollSellOrders();
  lane = autopilot.getState().magmaLane;
  // Before: the pass returned before touching the status, and Market → Orders
  // kept showing "Order lane: Amboss unreachable (Amboss HTTP 502) — retrying."
  assert.equal(lane.ok, null, "neither failing nor working: idle");
  assert.equal(lane.error, null);
  assert.equal(lane.retrying, false);
  assert.match(lane.idle ?? "", /Liquidity provision is off/);
  assert.ok(lane.lastTickAt);

  // The same without a key.
  autopilot.setConfig({ sellEnabled: true });
  magma.readBehaviour = "throw";
  await autopilot.pollSellOrders();
  assert.equal(autopilot.getState().magmaLane.ok, false);
  amboss.clear();
  await autopilot.pollSellOrders();
  lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, null);
  assert.equal(lane.error, null);
  assert.match(lane.idle ?? "", /no Amboss key/);
});
