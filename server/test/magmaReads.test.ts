/**
 * What the order lane does when Amboss won't show an order: one failed read is
 * that order's problem (never everyone's), "not found" and refusals are only
 * believed against Amboss's own listing, and orders whose reads keep failing
 * are walked last — least recently tried first — so they can't starve others.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forbidden, gqlError, internalError, orderNotFound, resolverFailed, throttled } from "./helpers/magma.js";
import { AmbossError } from "../src/services/amboss.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import {
  IN_AN_HOUR,
  entryOnDisk,
  feeEnv,
  historyFor,
  quiet,
  readsHang,
  salesOnDisk,
  walletBalance,
} from "./helpers/lifecycle.js";

test("an order Amboss no longer knows, with nothing of ours held for it, stops being polled — once Amboss has said so three passes in a row", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  // No fee reported yet and a distant deadline: the lane waits (skip).
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 3_600_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");
  magma.sales.delete(sale.id); // "Order not found" (NOT_FOUND)
  await autopilot.pollSellOrders();
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen", "twice is not yet 'for good'");
  // Amboss shows it again: the count starts over.
  magma.sales.set(sale.id, sale);
  await autopilot.pollSellOrders();
  magma.sales.delete(sale.id);
  await autopilot.pollSellOrders();
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "failed");
  assert.match(e?.reason ?? "", /Amboss no longer knows this order \(Order not found — 3 times in a row\)/);
  const reads = magma.count("Sale");
  await autopilot.pollSellOrders();
  assert.equal(magma.count("Sale"), reads, "not asked about again");
});

// ── what one failed read of an order may (not) conclude ──────────────────────

test("one hiccup on an order's read (a resolver error inside an HTTP 200) doesn't end it: the next pass accepts it — or rejects it, when it can't be served", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { chainBalance: 3_000_000 });
  const later = new Date(Date.now() + 3_600_000).toISOString();
  // Both wait for Amboss to report their fee: "seen", nothing of ours tied to them.
  const servable = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, feeSeller: "0", timeout: later });
  const tooBig = magma.addSale({ buyerPubkey: BUYER, sizeSats: 5_000_000, feeSeller: "0", timeout: later });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, servable.id)?.phase, "seen");
  assert.equal(entryOnDisk(dir, tooBig.id)?.phase, "seen");

  // Amboss's server fails once on each read: Apollo's "Unexpected error."
  magma.saleRead = (_id, n) => (n === 1 ? resolverFailed() : null);
  await autopilot.pollSellOrders();
  for (const sale of [servable, tooBig]) {
    const e = entryOnDisk(dir, sale.id);
    // Before: "failed — Amboss no longer knows this order (Unexpected
    // error.)", for good: never accepted, never rejected, and the order
    // timed out on us (SELLER_FAILED_TO_REACT) — the seller-score hit.
    assert.equal(e?.phase, "seen", "still to be decided");
    assert.equal(e?.reason, undefined);
    assert.match(e?.lastError ?? "", /could not read the order from Amboss: Unexpected error\./);
  }

  // Amboss reports the fees now, and answers again.
  magma.sales.get(servable.id)!.feeSeller = "4435"; // above what opening and closing its channel costs (minSaleFeeSats)
  magma.sales.get(tooBig.id)!.feeSeller = "5678";
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(servable.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted");
  assert.equal(magma.sales.get(tooBig.id)?.status, "SELLER_REJECTED", "rejected at once — not left to time out");
  assert.match(entryOnDisk(dir, tooBig.id)?.reason ?? "", /not enough on-chain capital/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 1);
});

test("a hiccup on the read right after LND blinked in the accept: the order is still accepted on the next pass", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  let blinks = 0;
  node.override("default.walletBalance", (_a, cb) => {
    if (capital.mutex.heldBy === "magma accept" && blinks === 0) {
      blinks += 1;
      return cb({ details: "transport is closing" });
    }
    cb(null, walletBalance(node));
  });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen", "not accepted while LND blinked — and not rejected");
  magma.saleRead = (_id, n) => (n === 1 ? resolverFailed() : null);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "accepted");
});

test("Amboss limiting requests (a 429 inside an HTTP 200 answer) is an outage: the order isn't ended, and is accepted once Amboss answers again", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 3_600_000).toISOString() });
  await autopilot.pollSellOrders();
  let limited = true;
  magma.saleRead = () => (limited ? throttled() : null);
  for (let i = 0; i < 4; i++) await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.equal(e?.reason, undefined);
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false);
  assert.match(lane.error ?? "", /^Amboss is limiting requests \(ThrottlerException: Too Many Requests\)/);
  assert.equal(lane.retrying, true, "an outage clears by itself");
  limited = false;
  magma.sales.get(sale.id)!.feeSeller = "12345";
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(autopilot.getState().magmaLane.ok, true);
});

test("with selling off (no listing to check against), Amboss failing on an order's read pass after pass ends nothing: you can still accept it by hand", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellEnabled: false }, chainBalance: 1_000_000 });
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 3_600_000).toISOString() });
  // A first click finds the wallet short: refused, nothing of ours tied to it.
  const refused = await autopilot.magma.accept(sale.id);
  assert.equal(refused.code, "capital");
  assert.equal(autopilot.magma.journal.get(sale.id)?.phase, "seen");
  node.chainBalance = 20_000_000;
  let failing = true;
  magma.saleRead = () => (failing ? resolverFailed() : null);
  for (let i = 0; i < 5; i++) await autopilot.pollSellOrders();
  // Before: "failed — Amboss no longer knows this order" after the first
  // pass; the Orders tab then hid Accept/Reject and the routes answered
  // "Order is already failed here."
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen", "'Unexpected error.' says nothing about the order");
  failing = false;
  const accepted = await autopilot.magma.accept(sale.id);
  assert.equal(accepted.ok, true, accepted.message);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
});

test("'not found' is never believed while Amboss's own listing shows the order waiting on us", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 3_600_000).toISOString() });
  await autopilot.pollSellOrders();
  // A glitch on Amboss's side: its read says NOT_FOUND, its listing still
  // has the order waiting for our approval.
  let glitch = true;
  magma.saleRead = () => (glitch ? orderNotFound() : null);
  for (let i = 0; i < 5; i++) {
    await autopilot.pollSellOrders();
    // Never ended, not even for a pass (a "failed" order Amboss lists waiting
    // would be taken up again a pass later — too late, near its deadline).
    assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen", `listed as waiting on us: it exists (pass ${i + 1})`);
  }
  assert.doesNotMatch(entryOnDisk(dir, sale.id)?.events.map((x) => x.what).join(" | ") ?? "", /no longer knows/);
  glitch = false;
  magma.sales.get(sale.id)!.feeSeller = "12345";
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
});

test("'not found' isn't believed without a listing to check it against either — the listing failing too, or selling off: the order stays to be decided", async (t) => {
  quiet(t);
  {
    const { autopilot, magma, dir } = sellerSetup(t);
    const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 3_600_000).toISOString() });
    await autopilot.pollSellOrders();
    // A glitch on Amboss's side: the listing fails, the read says NOT_FOUND.
    let glitch = true;
    magma.salesList = (f) => (glitch && f.action_needed ? internalError() : null);
    magma.saleRead = () => (glitch ? orderNotFound() : null);
    for (let i = 0; i < 4; i++) await autopilot.pollSellOrders();
    // Before: "failed — Amboss no longer knows this order" after the third
    // pass, though nothing said Amboss's listing had left it out.
    assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");
    assert.equal(entryOnDisk(dir, sale.id)?.notFound, undefined, "nothing counted");
    glitch = false;
    magma.sales.get(sale.id)!.feeSeller = "12345";
    await autopilot.pollSellOrders();
    assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  }
  {
    const { autopilot, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
    const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 3_600_000).toISOString() });
    magma.behave.AcceptOrder = "false"; // a click Amboss refused: "seen"
    assert.equal((await autopilot.magma.accept(sale.id)).ok, false);
    magma.saleRead = () => orderNotFound();
    for (let i = 0; i < 4; i++) await autopilot.pollSellOrders();
    assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen", "selling off: no listing — not ended on Amboss's word alone");
  }
});

test("an order with an invoice of ours is never ended on Amboss's word — 'not found' or any other error: its held payment is still watched and released in time", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const unpaid = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  const paid = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_100_000 });
  const opened = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_200_000 });
  await autopilot.pollSellOrders(); // all three accepted
  const openedHash = magma.buyerPays(opened.id, node);
  await autopilot.pollSellOrders(); // opened, reported
  assert.equal(entryOnDisk(dir, opened.id)?.phase, "reported");
  const paidHash = magma.buyerPays(paid.id, node);
  // From here on Amboss doesn't know any of them: not listed, and every read
  // answers "not found" — the first order's every other read fails instead.
  for (const s of [unpaid, paid, opened]) magma.sales.delete(s.id);
  magma.saleRead = (id, n) => (id === unpaid.id && n % 2 === 0 ? resolverFailed() : null);
  for (let i = 0; i < 6; i++) await autopilot.pollSellOrders();
  // Without the guard (the reviewer's mutation S2), "Amboss no longer knows
  // this order" ended any of them: the held payments were left to LND's own
  // expiry handling, unwatched, and their coins' reservations ended at once.
  assert.equal(entryOnDisk(dir, unpaid.id)?.phase, "accepted");
  assert.equal(entryOnDisk(dir, paid.id)?.phase, "held", "LND alone shows the payment held");
  assert.equal(entryOnDisk(dir, opened.id)?.phase, "reported");
  assert.equal(node.invoices.get(paidHash)?.state, "ACCEPTED");
  assert.equal(node.invoices.get(openedHash)?.state, "ACCEPTED");

  // The held HTLCs near their expiry: released by the lane, on LND alone.
  const until = node.invoices.get(paidHash)!.htlcs![0].expiryHeight;
  node.blockHeight = until - 20;
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(paidHash)?.state, "CANCELED", "the buyer gets the payment back");
  assert.equal(node.invoices.get(openedHash)?.state, "CANCELED");
  assert.equal(entryOnDisk(dir, paid.id)?.phase, "cancelled");
  assert.equal(entryOnDisk(dir, opened.id)?.phase, "cancelled");
  assert.equal(entryOnDisk(dir, unpaid.id)?.phase, "accepted", "an unpaid invoice ends when it expires, not on Amboss's word");
});

// ── one order Amboss won't show never holds up the others ────────────────────

test("one order whose read keeps failing with a 500 inside a GraphQL answer doesn't hold up the others: a paid order is opened and reported, a new one accepted — and the lane says which order it couldn't read", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const held = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, held.id)?.phase, "accepted");
  // A newer order, still waiting for its fee: "seen" — first in the journal.
  const poisoned = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_100_000, feeSeller: "0", timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, poisoned.id)?.phase, "seen");

  // From now on Amboss's resolver throws on that one order's read, every
  // time (NestJS reports the 500 inside an HTTP 200 answer); the listing and
  // every other read work. Meanwhile the buyer pays, and a new order comes in.
  magma.saleRead = (id) => (id === poisoned.id ? internalError() : null);
  magma.buyerPays(held.id, node);
  const fresh = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_200_000 });
  await autopilot.pollSellOrders();
  // Before: that 500 counted as "Amboss down", and every order after it in
  // the pass was left to LND alone, pass after pass — the paid order was
  // never opened (its payment released at its deadline), the new order
  // never decided (it timed out on us).
  assert.equal(node.callsTo("default.openChannel").length, 1, "the paid order's channel is opened");
  assert.equal(magma.sales.get(held.id)?.status, "SELLER_SENT_TRANSACTION", "and reported");
  assert.equal(magma.sales.get(fresh.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "the new order is accepted");
  const e = entryOnDisk(dir, poisoned.id);
  assert.equal(e?.phase, "seen", "still to be decided");
  assert.match(e?.lastError ?? "", /could not read the order from Amboss: Internal server error/);
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false, "not silent");
  assert.match(lane.error ?? "", /could not read 1 order from Amboss \(Internal server error\)/);
  assert.doesNotMatch(lane.error ?? "", /unreachable/, "Amboss answered — it is not down");
  assert.equal(lane.retrying, true);
  // On the run history once — not every 45 s.
  await autopilot.pollSellOrders();
  await autopilot.pollSellOrders();
  assert.deepEqual(historyFor(autopilot, poisoned.id).map((s) => [s.action, s.ok]), [["error", false]]);
});

test("an order Amboss won't show pass after pass, answering differently each time, takes one line of the run history — not one every 45 s", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  // Amboss's answer alternates: a failing resolver, then its 500, and so on.
  magma.saleRead = (id, n) => (id !== sale.id ? null : n % 2 === 0 ? resolverFailed() : internalError());
  for (let i = 0; i < 6; i++) await autopilot.pollSellOrders();
  // Were only identical repeats dropped (the autopilot's own rule), an answer
  // that changes every pass would take a line every 45 s — and push the fee
  // runs the elasticity learner reads out of the 50-run history.
  assert.deepEqual(historyFor(autopilot, sale.id).map((s) => [s.action, s.ok]), [["error", false]]);
  assert.match(entryOnDisk(dir, sale.id)?.lastError ?? "", /could not read the order from Amboss: (Unexpected error\.|Internal server error)/);
  assert.match(autopilot.getState().magmaLane.error ?? "", /could not read 1 order from Amboss/, "the lane says so on every pass");
  // Readable again, then not: that is news again.
  magma.saleRead = null;
  await autopilot.pollSellOrders();
  magma.saleRead = (id) => (id === sale.id ? gqlError("Order resolver failed", { code: "INTERNAL_SERVER_ERROR" }) : null);
  await autopilot.pollSellOrders();
  assert.equal(historyFor(autopilot, sale.id).filter((s) => s.action === "error").length, 2);
});

test("a channel Amboss has confirmed is settled and booked behind orders whose reads keep failing with a 500 — its payment is never released unclaimed", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, earnings, fees } = sellerSetup(t);
  const sold = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sold.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "reported");
  // Two newer orders: one accepted (its invoice out, not yet paid), one
  // waiting for its fee — and Amboss fails on both reads from now on.
  const accepted = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_100_000 });
  await autopilot.pollSellOrders();
  const waiting = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_200_000, feeSeller: "0", timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, accepted.id)?.phase, "accepted");
  assert.equal(entryOnDisk(dir, waiting.id)?.phase, "seen");
  magma.saleRead = (id) => (id === accepted.id || id === waiting.id ? internalError() : null);

  magma.setStatus(sold.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  // Before: the first of those failing reads cut the pass short, pass after
  // pass; the settle never came, and near expiry the held payment was
  // released — a channel delivered and confirmed, unpaid, nothing booked.
  assert.equal(node.invoices.get(hash)?.state, "SETTLED", "the delivered channel is paid for");
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "settled");
  assert.deepEqual(salesOnDisk(dir).map((r) => [r.orderId, r.leaseSats]), [[sold.id, 12_345]]);
  assert.deepEqual(fees.entries().map((f) => f.key), [`magma:${sold.id}`]);
  assert.equal(earnings.recent().length, 1);
  assert.equal(entryOnDisk(dir, accepted.id)?.phase, "accepted", "unreadable: left where it is");
  assert.equal(entryOnDisk(dir, waiting.id)?.phase, "seen");
  assert.match(autopilot.getState().magmaLane.error ?? "", /could not read 2 orders from Amboss \(Internal server error\)/);
});

test("Amboss's listing failing with a 500 inside a GraphQL answer is no outage either: the orders in flight go on, and the lane says what failed", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  magma.salesList = (filter) => (filter.action_needed ? internalError() : null);
  await autopilot.pollSellOrders();
  // Before: the pass went LND-only — no open, no report, no settle — for as
  // long as the listing's resolver kept failing.
  assert.equal(node.callsTo("default.openChannel").length, 1, "the paid order's channel is opened");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "reported");
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false);
  assert.match(lane.error ?? "", /could not list your sales on Amboss: Internal server error/);
  assert.equal(lane.retrying, true);
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "settled");
});

test("orders with money at stake are walked first: new orders whose reads time out — an outage by the second one, the rest of the pass LND-only — never make a confirmed channel's settle wait", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sold = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sold.id, node);
  await autopilot.pollSellOrders();
  const waiting = [1_100_000, 1_200_000].map((sizeSats) => magma.addSale({ buyerPubkey: BUYER, sizeSats, feeSeller: "0", timeout: IN_AN_HOUR() }));
  await autopilot.pollSellOrders();
  for (const w of waiting) assert.equal(entryOnDisk(dir, w.id)?.phase, "seen", "newer: first in the journal");
  // Amboss's answer for those orders' reads never comes (each deadline fires).
  readsHang(autopilot, (id) => waiting.some((w) => w.id === id));
  magma.setStatus(sold.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "SETTLED", "settled before the orders that timed out were asked about");
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "settled");
  // Two timeouts in a pass turn the rest of it LND-only — but the listing
  // answered: the lane says those reads failed, not that Amboss is down.
  const lane = autopilot.getState().magmaLane.error ?? "";
  assert.match(lane, /^could not read 2 orders from Amboss \(Amboss request to magma\.amboss\.tech timed out after 15s\) — the rest of this pass ran on LND alone/);
  assert.doesNotMatch(lane, /unreachable/);
});

// ── a read that hangs is that order's problem, not everyone's ────────────────

test("a newer order's read times out every pass: the older order's confirmed channel is still settled and booked — one hanging read is that order's error, not 'Amboss down'", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, fees } = sellerSetup(t);
  const sold = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sold.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "reported");
  // A newer order, accepted (an invoice of ours is out): at stake as well —
  // walked before the older one, newest first.
  const newer = magma.addSale({ buyerPubkey: "02" + "cd".repeat(32), sizeSats: 1_100_000 });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, newer.id)?.phase, "accepted");
  // Amboss's resolver is slow for that one order (say, the confirmations of a
  // funding transaction its chain backend doesn't know): every read of it
  // runs into the deadline; the listing and every other read answer.
  readsHang(autopilot, (id) => id === newer.id);
  magma.setStatus(sold.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  // Before: that timeout counted as "Amboss down", and every order after it
  // was left to LND alone, every pass — near expiry the held payment was
  // released: a channel delivered and confirmed, never paid for.
  assert.equal(node.invoices.get(hash)?.state, "SETTLED", "the delivered, confirmed channel is paid for — in this very pass");
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "settled");
  assert.deepEqual(salesOnDisk(dir).map((r) => [r.orderId, r.leaseSats]), [[sold.id, 12_345]]);
  assert.deepEqual(fees.entries().map((f) => f.key), [`magma:${sold.id}`]);
  const e = entryOnDisk(dir, newer.id);
  assert.equal(e?.phase, "accepted", "the order that can't be read stays where it is");
  assert.match(e?.lastError ?? "", /could not read the order from Amboss: Amboss request to magma\.amboss\.tech timed out after 15s/);
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false, "not silent");
  assert.match(lane.error ?? "", /could not read 1 order from Amboss \(Amboss request to magma\.amboss\.tech timed out after 15s\)/);
  assert.doesNotMatch(lane.error ?? "", /unreachable/, "everything else answered: Amboss is not down");
  assert.equal(lane.retrying, true);
  // On the run history once — not every 45 s.
  await autopilot.pollSellOrders();
  assert.deepEqual(historyFor(autopilot, newer.id).map((s) => [s.action, s.ok]), [["error", false], ["accept", true]]);
});

test("a newer accepted order's read times out every pass: an older paid order is still opened and reported, and a new order decided", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const paid = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, paid.id)?.phase, "accepted");
  const newer = magma.addSale({ buyerPubkey: "02" + "cd".repeat(32), sizeSats: 1_100_000 });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, newer.id)?.phase, "accepted");
  readsHang(autopilot, (id) => id === newer.id);
  magma.buyerPays(paid.id, node); // the older order's buyer pays: its channel is due
  const fresh = magma.addSale({ buyerPubkey: "02" + "ef".repeat(32), sizeSats: 1_200_000 });
  await autopilot.pollSellOrders();
  // Before: "Amboss unreachable", every pass — the paid order stayed "held"
  // with no channel until its open deadline (refunded, a seller-score hit),
  // and the new order timed out on us.
  assert.equal(node.callsTo("default.openChannel").length, 1, "the older paid order's channel is opened");
  assert.equal(magma.sales.get(paid.id)?.status, "SELLER_SENT_TRANSACTION", "and reported");
  assert.equal(entryOnDisk(dir, paid.id)?.phase, "reported");
  assert.equal(magma.sales.get(fresh.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "the new order is decided — accepted");
  assert.match(autopilot.getState().magmaLane.error ?? "", /could not read 1 order from Amboss \(Amboss request to magma\.amboss\.tech timed out after 15s\)/);
});

test("a newer order's read answered with an HTTP 502 every pass (that request only): the older order's confirmed channel is settled — not 'Amboss unreachable'", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sold = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sold.id, node);
  await autopilot.pollSellOrders();
  const newer = magma.addSale({ buyerPubkey: "02" + "cd".repeat(32), sizeSats: 1_100_000 });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, newer.id)?.phase, "accepted");
  // A proxy in front of Amboss fails that one request, every time.
  magma.saleRead = (id) => (id === newer.id ? new Response("bad gateway", { status: 502 }) : null);
  magma.setStatus(sold.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "settled");
  assert.match(autopilot.getState().magmaLane.error ?? "", /could not read 1 order from Amboss \(Amboss HTTP 502\)/);
});

test("two orders whose reads hang every pass: from the next pass on they are walked after every other order — a confirmed channel is settled, not left behind them", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sold = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sold.id, node);
  await autopilot.pollSellOrders();
  // Two newer accepted orders — at stake, and walked before the older one.
  const hanging = [1_100_000, 1_200_000].map((sizeSats) => magma.addSale({ buyerPubkey: "02" + "cd".repeat(32), sizeSats }));
  await autopilot.pollSellOrders();
  for (const h of hanging) assert.equal(entryOnDisk(dir, h.id)?.phase, "accepted");
  const read = readsHang(autopilot, (id) => hanging.some((h) => h.id === id));
  magma.setStatus(sold.id, "VALID_CHANNEL_OPENING");
  // This pass: both hang, one after the other — Amboss looks down, the rest
  // of the pass (the older order) is LND-only.
  await autopilot.pollSellOrders();
  assert.deepEqual(new Set(read), new Set(hanging.map((h) => h.id)));
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "reported", "LND alone can't settle");
  assert.match(autopilot.getState().magmaLane.error ?? "", /^could not read 2 orders from Amboss/);
  // The next pass walks them last: the older order goes first, and is settled.
  read.length = 0;
  await autopilot.pollSellOrders();
  assert.equal(read[0], sold.id, "the order whose read worked comes first");
  assert.equal(node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "settled");
});

test("every order's read timing out (its listing still answering): at most two reads in a pass, the rest on LND alone — a held payment near expiry is still released, and the lane says which reads failed, not 'Amboss unreachable'", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  // The oldest order: paid and opened — walked after the newer ones.
  const oldest = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(oldest.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, oldest.id)?.phase, "reported");
  const others = [1_100_000, 1_200_000, 1_300_000].map((sizeSats) => magma.addSale({ buyerPubkey: "02" + "cd".repeat(32), sizeSats }));
  await autopilot.pollSellOrders();
  for (const o of others) assert.equal(entryOnDisk(dir, o.id)?.phase, "accepted");
  const read = readsHang(autopilot, () => true);
  // Its held HTLC is about to expire.
  node.blockHeight = node.invoices.get(hash)!.htlcs![0].expiryHeight - 20;
  await autopilot.pollSellOrders();
  // Each read waits up to its deadline (15 s): the first may be one order's
  // problem, the second says Amboss is down — four orders, two reads.
  assert.equal(read.length, 2, "two reads, not one per order");
  assert.ok(!read.includes(oldest.id), "the oldest order was handled on LND alone");
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "its payment released in time, without a read");
  assert.equal(entryOnDisk(dir, oldest.id)?.phase, "cancelled");
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false);
  // The listing answered in this pass: two order reads timed out — that is
  // what the lane says. (Before: "Amboss unreachable", while Amboss answered.)
  assert.match(
    lane.error ?? "",
    /^could not read 2 orders from Amboss \(Amboss request to magma\.amboss\.tech timed out after 15s\) — the rest of this pass ran on LND alone; held payments are still watched in LND$/,
  );
  assert.equal(lane.retrying, true);
  read.length = 0;
  await autopilot.pollSellOrders();
  assert.equal(read.length, 2, "every pass: at most two reads");
  assert.equal(new Set(read).size, 2);
});

test("Amboss limiting requests at the HTTP level (429) on one order's read: the rest of the pass is LND-only at once — a limit holds for every call — and that order's held payment is still released in time", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const older = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_100_000 });
  await autopilot.pollSellOrders();
  // The newer order: paid, opened, reported — walked first.
  const newer = magma.addSale({ buyerPubkey: "02" + "cd".repeat(32), sizeSats: 1_200_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(newer.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, older.id)?.phase, "accepted");
  assert.equal(entryOnDisk(dir, newer.id)?.phase, "reported");
  const read = readsHang(autopilot, () => true, () => new AmbossError("http", "Amboss HTTP 429", 429));
  node.blockHeight = node.invoices.get(hash)!.htlcs![0].expiryHeight - 20; // its HTLC about to expire
  await autopilot.pollSellOrders();
  assert.deepEqual(read, [newer.id], "no second request into a rate limit");
  assert.match(autopilot.getState().magmaLane.error ?? "", /^Amboss is limiting requests \(Amboss HTTP 429\) — the rest of this pass ran on LND alone/);
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "Amboss unreadable is no reason to let a held HTLC expire");
  assert.equal(entryOnDisk(dir, newer.id)?.phase, "cancelled");
});

test("a key Amboss revokes while the lane checks an order's capital (the listing of your sold capital refused): the pass turns to LND alone at once, under 'Amboss rejects your key'", async (t) => {
  quiet(t);
  const { autopilot, magma, dir, amboss } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  // The key is revoked on amboss.tech just as the deploy cap's listing is asked.
  magma.salesList = (f) => {
    if (!f.status) return null;
    magma.keyValid = false;
    return forbidden("Sales");
  };
  await autopilot.pollSellOrders();
  assert.equal(amboss.getValidity(), false, "the key check confirmed the refusal");
  const lane = autopilot.getState().magmaLane;
  assert.match(lane.error ?? "", /^Amboss rejects your key/, "not 'could not decide': no decision can be made with a refused key");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.match(e?.lastError ?? "", /^Amboss refused the key \(Forbidden resource\)$/);
});

// Review of P10, round 2: a failed read or a refused key noted on an order's
// record stayed once Amboss showed the order again. With Liquidity provision
// switched off, a paused lane decides nothing that would replace it: Market →
// Orders and the recent orders said the key was refused — for a key that
// works — until the order timed out on the operator.
test("a key Amboss refused while the lane checked an order's capital, Liquidity provision switched off since: once the key works and Amboss shows the order again, its record no longer says the key is refused", async (t) => {
  quiet(t);
  const { autopilot, magma, dir, amboss } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  magma.salesList = (f) => {
    if (!f.status) return null;
    magma.keyValid = false;
    return forbidden("Sales");
  };
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.lastError, "Amboss refused the key (Forbidden resource)");
  // The operator switches selling off, and the key works again.
  autopilot.setConfig({ sellEnabled: false });
  magma.salesList = null;
  magma.keyValid = true;
  assert.equal(await amboss.checkValidity(true), true);
  await autopilot.pollSellOrders();
  assert.equal(autopilot.getState().magmaLane.ok, true, "a pass that read the order");
  const local = autopilot.magma.localView(sale.id);
  // Before: "Amboss refused the key (Forbidden resource)", on both.
  assert.deepEqual([local?.phase, local?.lastError], ["seen", null]);
  const recent = autopilot.magma.recentOrders().find((o) => o.orderId === sale.id);
  assert.deepEqual([recent?.action, recent?.reason], ["seen", null]);
  assert.deepEqual([magma.count("AcceptOrder"), magma.count("RejectOrder")], [0, 0], "a paused lane decides nothing");
});

test("a new order Amboss lists as waiting for approval but won't show: it is on record and its error is shown — and it is rejected before its deadline, not left to time out", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await autopilot.pollSellOrders();
  // Before: no record, no line in the run history, a lane reporting "ok" —
  // and nothing turned the order down: it timed out on us.
  let e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen", "on record, still to be decided");
  assert.equal(e?.sizeSats, 2_000_000, "from Amboss's listing");
  assert.match(e?.lastError ?? "", /could not read the order from Amboss: Unexpected error\./);
  let lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false);
  assert.match(lane.error ?? "", /could not read 1 order from Amboss \(Unexpected error\.\)/);
  assert.equal(lane.retrying, true);
  assert.deepEqual(historyFor(autopilot, sale.id).map((s) => [s.action, s.ok]), [["error", false]]);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "not turned down while there is time");
  assert.equal(magma.count("RejectOrder"), 0);

  // Its approval deadline draws near, and Amboss still won't show it.
  magma.sales.get(sale.id)!.timeout = new Date(Date.now() + 90_000).toISOString();
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "rejected — a reject needs only the order's id");
  e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "rejected");
  assert.match(e?.reason ?? "", /Amboss would not show this order \(Unexpected error\.\) — rejected rather than left to time out/);
  const reject = historyFor(autopilot, sale.id)[0];
  assert.deepEqual([reject?.action, reject?.ok], ["reject", true]);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "never an invoice for it");
  lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, true, "nothing left undone");
});

test("an order with an accept of ours in flight is never rejected on a failed read, near its deadline or not: our invoice may already be with the buyer", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 90_000).toISOString() });
  magma.behave.AcceptOrder = "throw"; // the accept's answer is lost (HTTP 502)
  await autopilot.pollSellOrders();
  const accepting = entryOnDisk(dir, sale.id);
  assert.equal(accepting?.phase, "accepting", "applied or not — nobody knows yet");
  const hash = accepting!.invoice!.id;
  magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await autopilot.pollSellOrders();
  assert.equal(magma.count("RejectOrder"), 0, "no reject while an invoice of ours is out");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "accepting", "carried on from LND alone");
  assert.equal(node.invoices.get(hash)?.state, "OPEN");
  assert.match(e?.lastError ?? "", /could not read the order from Amboss: Unexpected error\./);
});

test("an order Amboss won't show whose approval deadline has passed already is not rejected: Amboss has ended it — only its error is on record", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  // Amboss still lists it, a moment after its deadline (its status lags).
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() - 30_000).toISOString() });
  magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await autopilot.pollSellOrders();
  assert.equal(magma.count("RejectOrder"), 0, "no reject Amboss could only refuse");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.match(e?.lastError ?? "", /could not read the order from Amboss: Unexpected error\./);
});

test("an order Amboss won't show, near its deadline, whose reject Amboss won't take either: the order's record and the lane say so, and the next pass tries again", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 90_000).toISOString() });
  magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  // Amboss rejects LightningMate's reject request itself (its API changed).
  magma.behave.RejectOrder = (n) => (n === 0 ? "invalid" : "ok");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.match(e?.lastError ?? "", /Amboss would not show this order \(Unexpected error\.\), and rejecting it failed: Cannot query field/);
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false);
  assert.match(lane.error ?? "", /Amboss rejected LightningMate's request/);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "rejected");
});

test("the operator can turn down an order Amboss won't show: Amboss's listing says it awaits approval — all a reject needs", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  const paid = magma.addSale({ buyerPubkey: BUYER, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
  magma.saleRead = () => resolverFailed(); // every read fails
  const r = await autopilot.magma.reject(sale.id);
  // Before: "Could not read the order from Amboss: Unexpected error." — and no
  // reject was ever sent: the order timed out on the operator.
  assert.equal(r.ok, true, r.message);
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "rejected");
  assert.equal(e?.via, "manual");
  // The listing's status still decides: an order past approval is not rejected.
  const late = await autopilot.magma.reject(paid.id);
  assert.equal(late.ok, false);
  assert.equal(late.code, "bad_status");
  // And an order the listing doesn't show at all: the read's own error.
  const unknown = await autopilot.magma.reject("00000000-0000-4000-8000-0000000fffff");
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "amboss");
  assert.match(unknown.message, /Could not read the order from Amboss: Unexpected error\./);
  assert.equal(magma.count("RejectOrder"), 1, "one reject, for the order awaiting approval");
});

test("an order Amboss neither lists nor shows any more, long past its approval deadline, with nothing of ours tied to it, ends here — it isn't asked about for good", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");
  // It timed out on Amboss (no longer listed as waiting on us), and its read still fails.
  magma.setStatus(sale.id, "SELLER_FAILED_TO_REACT");
  const entry = autopilot.magma.journal.get(sale.id)!;
  entry.timeout = new Date(Date.now() - 5 * 60_000).toISOString();
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen", "just past the deadline: clocks may differ");
  entry.timeout = new Date(Date.now() - 11 * 60_000).toISOString();
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "failed");
  assert.match(e?.reason ?? "", /its approval deadline passed while Amboss would not show it \(Unexpected error\.\) — nothing of ours is tied to it/);
  const reads = magma.count("Sale");
  await autopilot.pollSellOrders();
  assert.equal(magma.count("Sale"), reads, "not asked about again");
  assert.equal(autopilot.getState().magmaLane.ok, true);
});

// ── the walked-last group: least recently tried first ────────────────────────

test("orders whose last read failed are walked least recently tried first: two orders whose reads hang every pass can't starve a third — its confirmed channel is settled and booked (R5-2)", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  // C: the oldest order, delivered and reported.
  const c = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(c.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, c.id)?.phase, "reported");
  // B and A: newer, accepted (an invoice of ours out) — at stake too.
  const b = magma.addSale({ buyerPubkey: "02" + "cd".repeat(32), sizeSats: 1_100_000 });
  await autopilot.pollSellOrders();
  const a = magma.addSale({ buyerPubkey: "02" + "ef".repeat(32), sizeSats: 1_200_000 });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, b.id)?.phase, "accepted");
  assert.equal(entryOnDisk(dir, a.id)?.phase, "accepted");
  // One hiccup on C's read (a 500 inside GraphQL) puts C in the group of
  // orders whose last read failed.
  magma.saleRead = (id) => (id === c.id ? internalError() : null);
  await autopilot.pollSellOrders();
  assert.match(entryOnDisk(dir, c.id)?.lastError ?? "", /could not read the order from Amboss/);
  magma.saleRead = null;
  // From now on A's and B's reads hang every pass; C's read would answer —
  // and Amboss has confirmed C's channel.
  const read = readsHang(autopilot, (id) => id === a.id || id === b.id);
  magma.setStatus(c.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders(); // A and B time out: the rest of the pass is LND-only
  await autopilot.pollSellOrders(); // C was tried least recently: read first
  // Before: the group was walked in a fixed order (newest first), A and B
  // took both read slots every pass, C was never read again — and near
  // expiry its held payment was released unclaimed.
  assert.ok(read.includes(c.id), "C is read again");
  assert.equal(node.invoices.get(hash)?.state, "SETTLED", "the delivered, confirmed channel is paid for");
  assert.equal(entryOnDisk(dir, c.id)?.phase, "settled");
  assert.deepEqual(salesOnDisk(dir).map((r) => r.orderId), [c.id]);
});

test("a delivered sale with its payment held, whose reads Amboss refuses pass after pass (key fine, listing leaves it out), is never ended on the refusals — its held payment is still released in time (R5-4)", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "reported");
  // Past action_needed: the listing leaves it out. Its reads are refused
  // while the key check passes.
  magma.setStatus(sale.id, "WAITING_FOR_ON_CHAIN_CONFIRMATION");
  magma.saleRead = (id) => (id === sale.id ? forbidden("Sale") : null);
  for (let i = 0; i < 4; i++) await autopilot.pollSellOrders();
  const mid = entryOnDisk(dir, sale.id);
  // Without the guard (only an order with nothing of ours tied to it may end
  // on refusals): "failed — nothing of ours is tied to it", its held payment
  // no longer watched, a later confirmation never settled.
  assert.equal(mid?.phase, "reported", "a delivered channel with its payment held is never ended on Amboss's refusal");
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "still held");
  node.blockHeight = node.invoices.get(hash)!.htlcs![0].expiryHeight - 20;
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "released by the lane before the HTLC expires");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
});

test("'Amboss unreachable' only when nothing answered in the pass: with selling off (no listing) and the first two reads timing out, the lane says so", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { config: { sellEnabled: false } });
  // Two orders taken on by hand (selling off: the lane carries them on).
  for (const sizeSats of [1_000_000, 1_100_000]) {
    const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats, timeout: IN_AN_HOUR() });
    assert.equal((await autopilot.magma.accept(sale.id)).ok, true);
  }
  readsHang(autopilot, () => true);
  await autopilot.pollSellOrders();
  const lane = autopilot.getState().magmaLane;
  assert.match(lane.error ?? "", /^Amboss unreachable \(Amboss request to magma\.amboss\.tech timed out after 15s\) — held payments are still watched in LND$/);
  assert.equal(lane.retrying, true);
});
