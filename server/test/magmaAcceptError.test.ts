/**
 * An accept that Amboss answers with an error (review 2026-11-10, LANE-1).
 *
 * Before, every answer to an accept other than `success: true|false` — an
 * HTTP 502, a GraphQL error about the accept itself, a query Amboss rejects —
 * counted as "maybe applied": the order stayed "accepting", the same accept
 * went out again on every pass (every 45 s), unbounded, and nothing ever
 * rejected the order — however close its approval deadline. It timed out on
 * the seller (SELLER_FAILED_TO_REACT, the seller-score hit a reject exists to
 * prevent), with its size reserved against the cap the whole time, and the
 * operator's own Reject was refused ("…is being confirmed with Amboss, so it
 * can't be withdrawn").
 *
 * Now:
 *  - with the approval deadline inside the reject margin, the lane rejects
 *    its own order whose accept Amboss never confirmed — the reject first,
 *    the accept's invoice released only once Amboss confirms the reject;
 *  - an error Amboss answers about the accept itself (a business rule, a 4xx,
 *    a rejected query) counts as a refusal once the next read still shows the
 *    order awaiting approval: invoice released, attempt counted, rejected
 *    after three — as `success: false` always was;
 *  - the operator's Reject of such an order goes out and stands;
 *  - what Amboss answered is kept on the order's record.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANSWERS_KEPT, ANSWER_MAX_CHARS, MagmaJournal } from "../src/services/magmaJournal.js";
import { ACCEPT_BEAT_REJECT, MANUAL_ACCEPT_SKIP, REJECT_STANDS_ACCEPT_SENT, SELLING_OFF_SKIP } from "../src/services/magmaDesk.js";
import { magmaRefusalAlerts } from "../src/services/alerts.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { REFUSED_MESSAGE, type Behaviour } from "./helpers/magma.js";
import { IN_AN_HOUR, entryOnDisk, feeEnv, quiet } from "./helpers/lifecycle.js";

type Setup = ReturnType<typeof sellerSetup>;

const OTHER = "03" + "cd".repeat(32);
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

/** The states of the HODL invoices made so far, in order. */
const invoiceStates = (s: Setup): (string | undefined)[] =>
  s.node.callsTo("invoices.addHoldInvoice").map((made) => s.node.invoices.get(Buffer.from(made.hash as Buffer).toString("hex"))?.state);

const UNCONFIRMED = "Amboss did not confirm the accept before the approval deadline — rejected rather than left to time out";

const ERRORS: { name: string; behaviour: Behaviour }[] = [
  { name: "an HTTP 502", behaviour: "throw" },
  { name: "an error about the accept itself (BAD_REQUEST)", behaviour: "refuse" },
  { name: "a rejected query (GRAPHQL_VALIDATION_FAILED)", behaviour: "invalid" },
];

for (const { name, behaviour } of ERRORS) {
  test(`the lane's accept is answered with ${name}: near the approval deadline the order is rejected, not left to time out — and its size is free for the next order`, async (t) => {
    feeEnv(t);
    quiet(t);
    const s = sellerSetup(t, { config: { sellMaxDeploySats: 3_000_000 } });
    s.node.peers.push(BUYER, OTHER);
    s.magma.behave.AcceptOrder = behaviour;
    const a = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, timeout: inMs(10 * 60_000) });
    await s.autopilot.pollSellOrders();
    assert.equal(entryOnDisk(s.dir, a.id)?.phase, "accepting");
    assert.equal(s.capital.reservedSat(), 2_000_000, "reserved while the accept is unconfirmed");
    assert.deepEqual(invoiceStates(s), ["OPEN"]);

    // The approval deadline is a minute away: inside the reject margin.
    s.magma.sales.get(a.id)!.timeout = inMs(60_000);
    await s.autopilot.pollSellOrders();
    assert.equal(s.magma.count("RejectOrder"), 1, "rejected");
    assert.equal(s.magma.count("AcceptOrder"), 1, "the accept is not sent again");
    assert.equal(s.magma.sales.get(a.id)?.status, "SELLER_REJECTED");
    const e = entryOnDisk(s.dir, a.id);
    assert.deepEqual([e?.phase, e?.via, e?.reason, e?.invoice], ["rejected", "autopilot", UNCONFIRMED, null]);
    assert.deepEqual(invoiceStates(s), ["CANCELED"], "the accept's invoice is released");
    assert.equal(s.capital.reservedSat(), 0, "nothing reserved for it any more");
    assert.equal(magmaRefusalAlerts(s.autopilot.magma).length, 1, "the operator is told the order was turned down");

    // A second order of the same size fits the 3M cap now.
    s.magma.behave.AcceptOrder = "ok";
    const b = s.magma.addSale({ buyerPubkey: OTHER, sizeSats: 2_000_000, timeout: inMs(10 * 60_000) });
    await s.autopilot.pollSellOrders();
    assert.equal(s.magma.sales.get(b.id)?.status, "WAITING_FOR_BUYER_PAYMENT", entryOnDisk(s.dir, b.id)?.reason);
  });
}

for (const { name, behaviour } of ERRORS.filter((e) => e.behaviour !== "throw")) {
  test(`the lane's accept is answered with ${name}, the deadline far off: counted as a refusal — a fresh invoice each time, rejected after three`, async (t) => {
    feeEnv(t);
    quiet(t);
    const s = sellerSetup(t);
    s.node.peers.push(BUYER);
    s.magma.behave.AcceptOrder = behaviour;
    const a = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, timeout: IN_AN_HOUR() });
    await s.autopilot.pollSellOrders();
    const first = entryOnDisk(s.dir, a.id);
    assert.deepEqual([first?.phase, first?.acceptAttempts], ["accepting", 1]);
    assert.ok(first?.acceptRefused, "what Amboss answered is on the record");
    if (behaviour === "invalid") {
      const lane = s.autopilot.getState().magmaLane;
      assert.deepEqual([lane.ok, lane.retrying], [false, false], "a rejected query is reported as such");
    }
    // The next read shows the order still awaiting approval: refused. The
    // invoice is released — not the same accept again.
    await s.autopilot.pollSellOrders();
    const second = entryOnDisk(s.dir, a.id);
    assert.deepEqual([second?.phase, second?.invoice, second?.acceptRefused], ["seen", null, undefined]);
    assert.match(second?.lastError ?? "", /^Amboss refused the accept \(/);
    assert.deepEqual(invoiceStates(s), ["CANCELED"]);
    assert.equal(s.capital.reservedSat(), 0);
    assert.equal(s.magma.count("AcceptOrder"), 1);

    for (let i = 0; i < 8 && entryOnDisk(s.dir, a.id)?.phase !== "rejected"; i++) await s.autopilot.pollSellOrders();
    const e = entryOnDisk(s.dir, a.id);
    assert.deepEqual([e?.phase, e?.reason], ["rejected", "Amboss refused the accept 3 times"]);
    assert.equal(s.magma.count("AcceptOrder"), 3, "three attempts, no more");
    assert.equal(s.magma.count("RejectOrder"), 1);
    assert.equal(s.magma.sales.get(a.id)?.status, "SELLER_REJECTED");
    assert.deepEqual(invoiceStates(s), ["CANCELED", "CANCELED", "CANCELED"], "a fresh invoice per attempt, each released");
    assert.equal(s.capital.reservedSat(), 0);
    // Nothing more happens to it.
    await s.autopilot.pollSellOrders();
    assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [3, 1]);
  });
}

test("an HTTP 502 on the lane's accept, the deadline far off: the same accept is sent again (it may have reached Amboss) — and goes through", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = (n) => (n < 2 ? "throw" : "ok");
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("AcceptOrder"), 3);
  assert.equal(s.node.callsTo("invoices.addHoldInvoice").length, 1, "one invoice, sent three times");
  assert.equal(s.magma.sales.get(a.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(entryOnDisk(s.dir, a.id)?.phase, "accepted");
  assert.deepEqual(invoiceStates(s), ["OPEN"]);
});

for (const sellEnabled of [true, false]) {
  test(`selling ${sellEnabled ? "on" : "off"}: the operator rejects an order whose accept Amboss never confirmed — the reject goes out, the invoice is released`, async (t) => {
    feeEnv(t);
    quiet(t);
    const s = sellerSetup(t, { config: { sellEnabled } });
    s.node.peers.push(BUYER);
    s.magma.behave.AcceptOrder = "throw";
    const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
    // The lane's accept with selling on; the operator's own with it off.
    if (sellEnabled) await s.autopilot.pollSellOrders();
    else assert.equal((await s.desk.accept(a.id)).ok, false);
    assert.equal(entryOnDisk(s.dir, a.id)?.phase, "accepting");
    assert.deepEqual(invoiceStates(s), ["OPEN"]);

    const click = await s.desk.reject(a.id);
    assert.deepEqual([click.ok, click.phase, click.message], [true, "rejected", "Order rejected."]);
    assert.equal(s.magma.count("RejectOrder"), 1);
    assert.equal(s.magma.sales.get(a.id)?.status, "SELLER_REJECTED");
    const e = entryOnDisk(s.dir, a.id);
    assert.deepEqual([e?.phase, e?.via, e?.reason, e?.invoice], ["rejected", "manual", "rejected by you", null]);
    assert.deepEqual(invoiceStates(s), ["CANCELED"]);
    assert.equal(s.capital.reservedSat(), 0);
    assert.deepEqual(magmaRefusalAlerts(s.autopilot.magma), [], 'their own decision: no "turned down" alert');
    await s.autopilot.pollSellOrders();
    assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 1], "nothing more is sent");
  });
}

test("the operator's reject of such an order isn't confirmed either: it stands — after a restart the lane sends the reject again, and the accept no more", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = "throw";
  s.magma.behave.RejectOrder = (n) => (n === 0 ? "throw" : "ok");
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  const click = await s.desk.reject(a.id);
  assert.deepEqual([click.ok, click.code, click.phase], [false, "amboss", "accepting"], click.message);
  assert.ok(click.message.endsWith(REJECT_STANDS_ACCEPT_SENT), click.message);
  const asked = entryOnDisk(s.dir, a.id);
  assert.deepEqual([asked?.phase, asked?.via, asked?.decision?.action], ["accepting", "manual", "reject"]);
  // Not confirmed: the accept's invoice stays until Amboss says which it is.
  assert.deepEqual(invoiceStates(s), ["OPEN"]);

  const p2 = s.restart();
  await p2.pollSellOrders();
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 2]);
  assert.equal(s.magma.sales.get(a.id)?.status, "SELLER_REJECTED");
  const e = entryOnDisk(s.dir, a.id);
  assert.deepEqual([e?.phase, e?.via, e?.reason], ["rejected", "manual", "rejected by you"]);
  assert.deepEqual(invoiceStates(s), ["CANCELED"]);
  assert.equal(p2.capital.reservedSat(), 0);
  assert.deepEqual(magmaRefusalAlerts(p2.magma), []);
});

test("the operator's reject came too late — Amboss had applied the accept: the order is accepted, its invoice untouched, and the record says so", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = "throw";
  s.magma.behave.RejectOrder = "throw";
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal((await s.desk.reject(a.id)).ok, false);
  // Amboss shows the accept applied after all.
  s.magma.setStatus(a.id, "WAITING_FOR_BUYER_PAYMENT");
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("RejectOrder"), 1, "no further reject");
  const e = entryOnDisk(s.dir, a.id);
  assert.deepEqual([e?.phase, e?.decision?.action, e?.decision?.reason, e?.lastError], ["accepted", "accept", ACCEPT_BEAT_REJECT, undefined]);
  assert.ok(e?.events.some((ev) => ev.what === ACCEPT_BEAT_REJECT));
  assert.deepEqual(invoiceStates(s), ["OPEN"], "the buyer can pay it");
  assert.equal(s.capital.reservedSat(), a.sizeSats);
});

test("a Reject that wasn't confirmed, then an Accept: the latest click stands — the accept goes out again, the reject no more", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
  s.magma.behave.RejectOrder = "throw";
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal((await s.desk.reject(a.id)).ok, false);
  const click = await s.desk.accept(a.id);
  assert.deepEqual([click.ok, click.phase], [true, "accepted"], click.message);
  const e = entryOnDisk(s.dir, a.id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.action, e?.decision?.reason], ["accepted", "manual", "accept", "accepted by you"]);
  await s.autopilot.pollSellOrders();
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [2, 1]);
  assert.equal(s.magma.sales.get(a.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.deepEqual(invoiceStates(s), ["OPEN"]);
});

test("near the deadline Amboss confirms neither the accept nor the lane's reject: the invoice stays, the lane says so, and the next pass rejects", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = "throw";
  s.magma.behave.RejectOrder = (n) => (n === 0 ? "throw" : "ok");
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: inMs(10 * 60_000) });
  await s.autopilot.pollSellOrders();
  s.magma.sales.get(a.id)!.timeout = inMs(90_000);
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, a.id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.action], ["accepting", "autopilot", "accept"], "nothing is decided on the record until Amboss confirms");
  assert.match(e?.lastError ?? "", /^reject not confirmed \(Amboss HTTP 502\) — will try again$/);
  assert.deepEqual(invoiceStates(s), ["OPEN"]);
  const lane = s.autopilot.getState().magmaLane;
  assert.equal(lane.ok, false);
  assert.match(lane.error ?? "", /Amboss confirmed neither the accept nor the reject/);

  await s.autopilot.pollSellOrders();
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 2]);
  assert.equal(entryOnDisk(s.dir, a.id)?.phase, "rejected");
  assert.deepEqual(invoiceStates(s), ["CANCELED"]);
  assert.equal(s.autopilot.getState().magmaLane.ok, true);
});

test("near the deadline Amboss refuses the lane's reject because the accept had reached it: the order goes on as a sale with its invoice intact", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = "throw";
  s.magma.behave.RejectOrder = "false";
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: inMs(10 * 60_000) });
  await s.autopilot.pollSellOrders();
  s.magma.sales.get(a.id)!.timeout = inMs(90_000);
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("RejectOrder"), 1);
  assert.equal(entryOnDisk(s.dir, a.id)?.phase, "accepting");
  assert.deepEqual(invoiceStates(s), ["OPEN"], "never cancelled before Amboss confirms the reject");
  // Amboss's next read shows what it had done with the accept.
  s.magma.setStatus(a.id, "WAITING_FOR_BUYER_PAYMENT");
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, a.id);
  assert.deepEqual([e?.phase, e?.via, e?.lastError], ["accepted", "autopilot", undefined]);
  assert.deepEqual(invoiceStates(s), ["OPEN"]);
  assert.equal(s.magma.count("RejectOrder"), 1);
});

test("the operator's own accept is never rejected by the lane near the deadline — it is sent again", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: inMs(10 * 60_000) });
  assert.equal((await s.desk.accept(a.id)).ok, false);
  s.magma.sales.get(a.id)!.timeout = inMs(60_000);
  await s.autopilot.pollSellOrders();
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [2, 0]);
  const e = entryOnDisk(s.dir, a.id);
  assert.deepEqual([e?.phase, e?.via], ["accepted", "manual"]);
});

test("selling is switched off after Amboss refused the lane's accept with an error: the order is handed back to the operator, nothing reserved, nothing rejected", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = "refuse";
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, a.id)?.phase, "accepting");
  s.autopilot.setConfig({ sellEnabled: false });
  await s.autopilot.pollSellOrders();
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, a.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.decision?.reason], ["seen", null, SELLING_OFF_SKIP]);
  assert.deepEqual(invoiceStates(s), ["CANCELED"]);
  assert.equal(s.capital.reservedSat(), 0);
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 0]);
  assert.equal(s.magma.sales.get(a.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "the operator's to decide");
});

test("the operator's accept is refused with an error: the next pass leaves the order to them — neither sent again nor turned down", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = "refuse";
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  assert.equal((await s.desk.accept(a.id)).ok, false);
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, a.id);
  assert.deepEqual([e?.phase, e?.via, e?.invoice, e?.decision?.reason], ["seen", "manual", null, MANUAL_ACCEPT_SKIP]);
  assert.deepEqual(invoiceStates(s), ["CANCELED"]);
  assert.equal(s.capital.reservedSat(), 0);
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 0]);
  assert.deepEqual(magmaRefusalAlerts(s.autopilot.magma), []);
});

test("the operator's accept is refused with an error: a second Accept starts afresh with a new invoice", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "refuse" : "ok");
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  const first = await s.desk.accept(a.id);
  assert.deepEqual([first.ok, first.phase], [false, "accepting"]);
  assert.match(first.message, new RegExp(REFUSED_MESSAGE));
  // A second click before the lane's pass: the refused accept is released
  // and a new one — with a new invoice — goes out.
  const again = await s.desk.accept(a.id);
  assert.deepEqual([again.ok, again.phase], [true, "accepted"], again.message);
  assert.deepEqual(invoiceStates(s), ["CANCELED", "OPEN"]);
  assert.equal(s.magma.count("AcceptOrder"), 2);
  assert.equal(entryOnDisk(s.dir, a.id)?.via, "manual");
});

test("what Amboss answered is kept on the order's record: reads that changed, the accept's and the reject's answers — never the key or an invoice", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "refuse" : n === 1 ? "throw" : "false");
  const a = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  for (let i = 0; i < 8 && entryOnDisk(s.dir, a.id)?.phase !== "rejected"; i++) await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, a.id);
  assert.equal(e?.phase, "rejected");
  const kept = e?.amboss ?? [];
  assert.deepEqual(
    kept.filter((k) => k.op !== "read").map((k) => [k.op, k.answer]),
    [
      ["accept", `error (graphql BAD_REQUEST): ${REFUSED_MESSAGE}`],
      ["accept", "error (http 502): Amboss HTTP 502"],
      ["accept", "success: false"],
      ["accept", "success: false"],
      ["reject", "success: true"],
    ],
  );
  // The first read is on record before the accept it led to; the same answer
  // again is not kept twice.
  assert.equal(kept[0].op, "read");
  const reads = kept.filter((k) => k.op === "read").map((k) => JSON.parse(k.answer) as { status: string; timeout: string | null });
  assert.equal(reads.length, 1, "every later read answered the same");
  assert.deepEqual([reads[0].status, reads[0].timeout], ["WAITING_FOR_SELLER_APPROVAL", a.timeout]);
  const raw = JSON.stringify(kept);
  assert.ok(!raw.includes("test-key"), "never the key");
  assert.ok(!/ln(bc|tb|bcrt)1/.test(raw), "never an invoice");
});

test("the approval deadline has passed while Amboss still lists the order as awaiting approval: the lane sends no reject after it", async (t) => {
  // Review of the package: nothing held the near-deadline reject to "before
  // the deadline" in a test — a reject after it is no decision in time, and
  // an order Amboss is about to expire is not ours to turn down.
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  s.magma.behave.AcceptOrder = "throw";
  const a = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, timeout: inMs(10 * 60_000) });
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, a.id)?.phase, "accepting");
  s.magma.sales.get(a.id)!.timeout = inMs(-30_000);
  await s.autopilot.pollSellOrders();
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("RejectOrder"), 0, "no reject after the deadline");
  // The accept is what goes on, for as long as Amboss lists the order so.
  assert.deepEqual([entryOnDisk(s.dir, a.id)?.phase, s.magma.count("AcceptOrder")], ["accepting", 3]);
  assert.deepEqual(invoiceStates(s), ["OPEN"]);
  assert.deepEqual(magmaRefusalAlerts(s.autopilot.magma), []);
});

test("Amboss's answers on an order's record are bounded: the last 24, each cut at 400 characters, and a read goes before an accept's or a reject's answer", () => {
  // Review of the package: none of the three bounds was held by a test.
  const dir = mkdtempSync(join(tmpdir(), "lm-journal-"));
  try {
    const journal = new MagmaJournal(dir);
    const entry = journal.create({ orderId: "o1", via: "autopilot", buyerPubkey: BUYER, sizeSats: 2_000_000, isPrivate: false, feeMsat: "1000" });
    journal.answered(entry, "accept", "success: false");
    journal.answered(entry, "reject", "x".repeat(ANSWER_MAX_CHARS + 50));
    // An Amboss that answers every read differently: 60 of them.
    for (let i = 0; i < 60; i++) journal.answered(entry, "read", `{"status":"S${i}"}`);
    const kept = entry.amboss ?? [];
    assert.equal(ANSWERS_KEPT, 24);
    assert.equal(kept.length, ANSWERS_KEPT, "bounded");
    assert.deepEqual(kept.slice(0, 2).map((k) => k.op), ["accept", "reject"], "the reads went, oldest first — not the accept's and the reject's answers");
    assert.equal(kept[1].answer, `${"x".repeat(ANSWER_MAX_CHARS)}…`, "cut at 400 characters");
    assert.deepEqual(
      kept.slice(2).map((k) => k.answer),
      Array.from({ length: ANSWERS_KEPT - 2 }, (_, i) => `{"status":"S${60 - (ANSWERS_KEPT - 2) + i}"}`),
      "the latest reads",
    );
    // Only accepts left to drop: the oldest goes.
    const other = journal.create({ orderId: "o2", via: "autopilot", buyerPubkey: BUYER, sizeSats: 2_000_000, isPrivate: false, feeMsat: "1000" });
    for (let i = 0; i < ANSWERS_KEPT + 3; i++) journal.answered(other, "accept", `answer ${i}`);
    assert.deepEqual([other.amboss?.length, other.amboss?.[0].answer], [ANSWERS_KEPT, "answer 3"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
