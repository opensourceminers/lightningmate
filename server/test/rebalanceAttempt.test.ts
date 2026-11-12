/**
 * One attempt of a refill: its time and its self-invoice (review 2026-11-10,
 * the refill's two minor items).
 *
 * Before: the time left of the hard limit was taken before LND made and
 * decoded the attempt's invoice, and LND's pathfinding time and the wait for
 * the payment ran for that — past the limit by as long as those two calls
 * took. And every attempt that ended without a payment left its invoice open
 * in LND until it expired: up to three sizes of three sources per target and
 * cooldown.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { INVOICE_CANCEL, PAYMENT_CHECK, executeRebalance } from "../src/services/rebalance.js";
import { FakeLnd, sentPayment } from "./helpers/fakeLnd.js";
import { chanNumber } from "./helpers/feeNode.js";

const TARGET = "800001x1x0";
const SOURCE = "800002x1x0";
const REFILL = { targetId: TARGET, sourceId: SOURCE, amountSats: 400_000, econRatio: 0.8 };

/** A drained channel and a full one, both at 500 ppm. */
function refillNode(): FakeLnd {
  const node = new FakeLnd({
    channels: [
      { id: TARGET, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 200_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: SOURCE, partnerPublicKey: "02" + "b2".repeat(32), capacity: 2_000_000, localBalance: 1_800_000, transactionId: "b2".repeat(32), transactionVout: 0 },
    ],
  });
  node.override("default.feeReport", (_a, cb) =>
    cb(null, {
      channel_fees: [TARGET, SOURCE].map((id, i) => ({
        chan_id: chanNumber(id),
        channel_point: `${(i ? "b2" : "a1").repeat(32)}:0`,
        base_fee_msat: "1000",
        fee_per_mil: "500",
        inbound_base_fee_msat: 0,
        inbound_fee_per_mil: 0,
      })),
    }),
  );
  return node;
}

/** LND takes `ms` to make an invoice. */
function slowInvoices(node: FakeLnd, ms: number): void {
  const make = node.lnd.default.addInvoice;
  node.override("default.addInvoice", (a, cb) => void setTimeout(() => make(a, cb), ms));
}

const sent = (node: FakeLnd) => node.callsTo("router.sendPaymentV2");
const cancelled = (node: FakeLnd) => node.callsTo("invoices.cancelInvoice").map((c) => Buffer.from(c.payment_hash as Buffer).toString("hex"));
const invoiceStates = (node: FakeLnd) => [...node.invoices.values()].map((i) => i.state);

test("the wait for a payment ends at the hard limit, not later by the time LND took to make the invoice (before: 1.5 s late on a 3 s limit)", async () => {
  const node = refillNode();
  node.payOutcome = "hang";
  slowInvoices(node, 1_500);
  const started = Date.now();
  const res = await executeRebalance(node.lnd, node.lnd, REFILL, { hardTimeoutMs: 3_000 });
  const took = Date.now() - started;
  assert.ok(res.inFlight, res.error);
  assert.equal(sent(node).length, 1);
  // Before: 1.5 s for the invoice, then the whole 3 s again.
  assert.ok(took < 4_000, `returned after ${took} ms`);
  assert.ok(took >= 2_900, `waited for the payment until the limit (${took} ms)`);
});

test("with too little of the limit left once the invoice is made nothing is sent: the invoice is cancelled, the source is not reported as failed, and the refill ends 'time limit reached' (before: sent with LND's full pathfinding time and booked in flight past the limit)", async () => {
  const node = refillNode();
  node.payOutcome = "hang";
  slowInvoices(node, 900);
  const sends: string[] = [];
  const started = Date.now();
  // A quarter of the limit (250 ms) is the least an attempt starts with:
  // there at the start, gone when the invoice arrives.
  const res = await executeRebalance(node.lnd, node.lnd, REFILL, { hardTimeoutMs: 1_000, onSend: (p) => sends.push(p.paymentId) });
  const took = Date.now() - started;
  assert.equal(sent(node).length, 0, "no payment was handed to LND");
  assert.deepEqual(sends, [], "nor put on the books");
  assert.equal(res.ok, false);
  assert.equal(res.inFlight, undefined);
  assert.equal(res.error, "rebalance time limit reached");
  assert.deepEqual(res.failedSourceIds, [], "LND's slow answer is no failed route of this source");
  assert.equal(node.invoices.size, 1);
  assert.deepEqual(invoiceStates(node), ["CANCELED"]);
  assert.ok(took < 1_900, `returned after ${took} ms`);
});

test("an attempt LND reports failed leaves no open invoice behind: each size's invoice is cancelled once its payment has failed (before: all of them stayed open until they expired)", async () => {
  const node = refillNode();
  node.payOutcome = "fail";
  const ends: string[] = [];
  const res = await executeRebalance(node.lnd, node.lnd, REFILL, { onEnd: (id, outcome) => ends.push(`${outcome} ${id}`) });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /^no route within budget/);
  // It names the last attempt's own cap in sats (the review of P4, P14 and its second round).
  const lastCap = Number(sent(node).at(-1)?.fee_limit_sat);
  assert.match(res.error ?? "", new RegExp(`^no route within budget \\(${lastCap} sat at most, `), `${res.error} — last cap ${lastCap}`);
  const tried = sent(node).map((c) => sentPayment(c).id);
  assert.equal(tried.length, 3, "the planned size, its half and its quarter");
  assert.deepEqual(cancelled(node), tried, "one cancel per failed attempt, in their order");
  assert.deepEqual(ends, tried.map((id) => `failed ${id}`), "each on the books as failed");
  assert.deepEqual(invoiceStates(node), ["CANCELED", "CANCELED", "CANCELED"]);
  assert.deepEqual(res.failedSourceIds, [SOURCE]);
});

test("the invoice of a payment that may still land is never cancelled — in flight at the hard limit, or lost track of — and neither is a paid one", async (t) => {
  const hanging = refillNode();
  hanging.payOutcome = "hang";
  const stuck = await executeRebalance(hanging.lnd, hanging.lnd, REFILL, { hardTimeoutMs: 1_500 });
  assert.ok(stuck.inFlight, stuck.error);
  assert.deepEqual(cancelled(hanging), []);
  assert.deepEqual(invoiceStates(hanging), ["OPEN"], "LND would fail the payment's HTLCs on arrival otherwise");

  // The call broke off and LND doesn't say how the payment ended.
  const saved = { ...PAYMENT_CHECK };
  Object.assign(PAYMENT_CHECK, { recheckMs: 20, deadlineMs: 200 });
  t.after(() => Object.assign(PAYMENT_CHECK, saved));
  const lost = refillNode();
  lost.override("router.trackPaymentV2", () => Object.assign(new EventEmitter(), { cancel: () => undefined }));
  const unknown = await executeRebalance(lost.lnd, lost.withoutPermission("router.sendPaymentV2"), REFILL);
  assert.ok(unknown.inFlight, unknown.error);
  assert.match(unknown.error ?? "", /^LND hasn't said how the payment ended/);
  assert.deepEqual(cancelled(lost), []);
  assert.deepEqual(invoiceStates(lost), ["OPEN"]);

  const paying = refillNode();
  const paid = await executeRebalance(paying.lnd, paying.lnd, REFILL);
  assert.equal(paid.ok, true, paid.error);
  assert.deepEqual(cancelled(paying), []);
});

test("an invoice nothing was sent for is cancelled too: a payment that couldn't be put on the books, one LND refused outright, and one stopped while its invoice was made", async () => {
  // The books can't be written: not sent.
  const unrecorded = refillNode();
  const noBooks = await executeRebalance(unrecorded.lnd, unrecorded.lnd, REFILL, {
    onSend: () => {
      throw new Error("disk full");
    },
  });
  assert.match(noBooks.error ?? "", /^not sent: the payment couldn't be recorded before sending it \(disk full\)/);
  assert.equal(sent(unrecorded).length, 0);
  assert.deepEqual(invoiceStates(unrecorded), ["CANCELED"]);

  // LND refuses the payment (a macaroon without offchain:write) and has none by that id.
  const refusing = refillNode();
  const refused = await executeRebalance(refusing.lnd, refusing.withoutPermission("router.sendPaymentV2"), REFILL);
  assert.match(refused.error ?? "", /^LND refused the payment/);
  assert.deepEqual(invoiceStates(refusing), ["CANCELED"]);

  // Told to stop while the invoice was made: asked once before it, once after.
  const stopping = refillNode();
  let asked = 0;
  const stopped = await executeRebalance(stopping.lnd, stopping.lnd, REFILL, { shouldStop: () => (asked++ > 0 ? "rebalancing was switched off" : false) });
  assert.equal(stopped.stopped, true, stopped.error);
  assert.equal(sent(stopping).length, 0);
  assert.deepEqual(invoiceStates(stopping), ["CANCELED"]);
});

test("cancelling is best effort: an LND that refuses it, or never answers, changes nothing of the refill — the next size is tried and the result is the same", async (t) => {
  const saved = { ...INVOICE_CANCEL };
  Object.assign(INVOICE_CANCEL, { waitMs: 60 });
  t.after(() => Object.assign(INVOICE_CANCEL, saved));

  const refusing = refillNode();
  refusing.payOutcome = "fail";
  refusing.override("invoices.cancelInvoice", (_a, cb) => cb({ details: "permission denied" }));
  const one = await executeRebalance(refusing.lnd, refusing.lnd, REFILL);
  assert.match(one.error ?? "", /^no route within budget/);
  assert.equal(sent(refusing).length, 3);
  assert.deepEqual(one.failedSourceIds, [SOURCE]);
  assert.deepEqual(invoiceStates(refusing), ["OPEN", "OPEN", "OPEN"], "they expire, as they did");

  const silent = refillNode();
  silent.payOutcome = "fail";
  silent.override("invoices.cancelInvoice", () => undefined);
  const started = Date.now();
  const two = await executeRebalance(silent.lnd, silent.lnd, REFILL);
  assert.match(two.error ?? "", /^no route within budget/);
  assert.equal(sent(silent).length, 3);
  assert.ok(Date.now() - started < 3_000, `three waits of 60 ms, not LND's silence (${Date.now() - started} ms)`);
});
