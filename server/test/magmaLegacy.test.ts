/**
 * Orders found with no record here (accepted by 0.7.x with a plain invoice,
 * with another tool, or with the journal lost): LND says what was paid before
 * anything is opened or booked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateAlerts } from "../src/services/alerts.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import {
  IN_AN_HOUR,
  entryOnDisk,
  feeEnv,
  feesOnDisk,
  quiet,
  salesOnDisk,
} from "./helpers/lifecycle.js";

test("an order accepted before this version (no journal, payment already settled) is fulfilled — and an existing channel for it is reported, not doubled", async (t) => {
  quiet(t);
  for (const existing of [false, true]) {
    const { autopilot, node, magma, dir } = sellerSetup(t);
    const sale = magma.addSale({ buyerPubkey: BUYER, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
    // 0.7.x accepted it with a plain invoice, which settled on payment.
    const paid = node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${sale.id}`, paid: true });
    // The old code opened this channel and then failed to report it.
    if (existing) {
      node.pending.push({ partnerPublicKey: BUYER, capacity: sale.sizeSats, transactionId: "ab".repeat(32), transactionVout: 1 });
    }
    await autopilot.pollSellOrders();
    assert.equal(node.callsTo("default.openChannel").length, existing ? 0 : 1, `existing=${existing}`);
    const e = entryOnDisk(dir, sale.id);
    assert.equal(e?.via, "legacy");
    assert.equal(e?.phase, "reported");
    assert.equal(e?.paidInvoiceId, paid, "LND showed what paid for it");
    if (existing) assert.equal(e?.fundingOutpoint, `${"ab".repeat(32)}:1`);
  }
});

test("an order found with no record here never takes, as its own, an older channel of ours to the same buyer of the same size — only one funded since the order was placed", async (t) => {
  quiet(t);
  const old = "0d".repeat(32);
  const recent = "0e".repeat(32);
  for (const fundedAt of ["before", "after"] as const) {
    const { autopilot, node, magma, dir } = sellerSetup(t);
    // Placed three hours (~18 blocks) ago; accepted by 0.7.x and paid.
    const placed = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const sale = magma.addSale({ buyerPubkey: BUYER, createdAt: placed, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
    node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${sale.id}`, paid: true });
    // A confirmed channel of ours to this buyer, of exactly the order's size,
    // that no sale claims: a routing channel opened two weeks ago — or the
    // one the old code opened for this order and then failed to report.
    const height = fundedAt === "before" ? node.blockHeight - 2_016 : node.blockHeight - 5;
    node.channels.push({
      id: `${height}x1x0`,
      partnerPublicKey: BUYER,
      capacity: sale.sizeSats,
      localBalance: sale.sizeSats - 20_000,
      transactionId: fundedAt === "before" ? old : recent,
      transactionVout: 0,
    });
    await autopilot.pollSellOrders();
    const e = entryOnDisk(dir, sale.id);
    const reported = magma.calls.filter((c) => c.op === "AddTransaction").map((c) => (c.variables.input as { tx_id: string }).tx_id);
    if (fundedAt === "before") {
      // Without the height filter (the reviewer's mutation S3): the old
      // channel was taken as this order's and reported to Amboss — the buyer
      // never got the channel they paid for.
      assert.equal(node.callsTo("default.openChannel").length, 1, "the buyer gets a channel of its own");
      assert.notEqual(e?.fundingOutpoint, `${old}:0`);
      assert.deepEqual(reported, [e?.fundingOutpoint]);
    } else {
      assert.equal(node.callsTo("default.openChannel").length, 0, "the channel opened for it is reported, not doubled");
      assert.equal(e?.fundingOutpoint, `${recent}:0`);
      assert.deepEqual(reported, [`${recent}:0`]);
    }
    assert.equal(e?.phase, "reported");
  }
});

test("an order 0.7.x took on with a plain invoice, found with no record here, is booked with what that invoice brought in — fees.seller reading 0 doesn't matter", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, earnings, fees } = sellerSetup(t);
  const sale = magma.addSale({
    buyerPubkey: BUYER,
    status: "WAITING_FOR_CHANNEL_OPEN",
    paymentStatus: "SUCCESSFUL_PAYMENT",
    feeSeller: "0",
    feeFixed: "852",
    feeVariable: "6000",
  });
  node.addPlainInvoice({ tokens: 6_852, description: `Magma order ${sale.id}`, paid: true });
  await autopilot.pollSellOrders(); // adopted, opened, reported
  assert.equal(entryOnDisk(dir, sale.id)?.feeMsat, "6852000");
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "settled");
  assert.deepEqual(earnings.recent().map((r) => r.leaseSats), [6_852]);
  assert.deepEqual(fees.entries().map((e) => e.feeSats), [68]);

  // Amboss shows no fee at all, and still none at settlement: what the
  // settled invoice brought in is what it earned — not 0.
  const late = magma.addSale({ buyerPubkey: BUYER, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT", feeSeller: "0" });
  node.addPlainInvoice({ tokens: 5_000, description: `Magma order ${late.id}`, paid: true });
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, late.id)?.feeMsat, "5000000");
  magma.setStatus(late.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, late.id)?.phase, "settled");
  assert.deepEqual(earnings.recent().map((r) => r.leaseSats), [5_000, 6_852]);
});

test("an order 0.7.7 opened and charged its fee for inline: completed now without charging the fee a second time", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
  // 0.7.7 opened the channel, ignored add_transaction's `false`, paid the 1%
  // inline and booked the sale (feePaidSats) — the order still waits for its
  // channel. The upgraded process finds that on disk.
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: sale.sizeSats, transactionId: "ab".repeat(32), transactionVout: 0 });
  s.node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${sale.id}`, paid: true });
  writeFileSync(
    join(s.dir, "earnings.json"),
    JSON.stringify([{ at: new Date().toISOString(), via: "autopilot", orderId: sale.id, leaseSats: 12_345, feePaidSats: 123 }]),
  );
  const upgraded = s.restart();
  await upgraded.pollSellOrders();
  assert.equal(s.node.callsTo("default.openChannel").length, 0, "the channel 0.7.7 opened is reported, not doubled");
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await upgraded.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "settled");
  assert.equal(feesOnDisk(s.dir).length, 0, "its fee was paid inline by 0.7.7 — the ledger doesn't charge it again");
  assert.equal(salesOnDisk(s.dir).filter((r) => r.orderId === sale.id).length, 1, "one sale");
  assert.match(
    entryOnDisk(s.dir, sale.id)?.events.map((e) => e.what).join(" | ") ?? "",
    /service fee already paid by an earlier version \(123 sat\)/,
  );
});

// ── an order found with no record here ────────────────────────────────────────

test("the order journal is lost while a buyer's payment is held: no channel, nothing booked — the payment goes back to the buyer", async (t) => {
  feeEnv(t);
  quiet(t);
  t.mock.method(console, "error", () => undefined);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await s.autopilot.pollSellOrders();
  const hash = s.magma.buyerPays(sale.id, s.node); // held by our HODL invoice
  // A disk fault damages the journal and its backup: the preimage is gone.
  writeFileSync(join(s.dir, "magma-orders.json"), "{ not json");
  writeFileSync(join(s.dir, "magma-orders.json.bak"), "{ not json");

  const p2 = s.restart();
  await p2.pollSellOrders();
  // Before: the order was adopted as "legacy" — opened, and at
  // VALID_CHANNEL_OPENING marked settled, booked, its 1% fee enqueued — while
  // the payment it booked could never be claimed: LND cancelled it, the
  // buyer was refunded, and the channel was a gift.
  assert.equal(s.node.callsTo("default.openChannel").length, 0, "no channel for a payment that can never be claimed");
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED", "the held payment went back to the buyer at once");
  const e = p2.magma.journal.get(sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.match(e?.reason ?? "", /record here was lost/);
  const released = p2.getState().history[0]?.sells.find((s) => s.orderId === sale.id);
  assert.deepEqual([released?.action, released?.ok], ["cancel", true], "the run history says so too");

  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING"); // whatever Amboss says next
  await p2.pollSellOrders();
  assert.equal(p2.magma.journal.get(sale.id)?.phase, "cancelled");
  assert.equal(salesOnDisk(s.dir).length, 0, "no sale booked");
  assert.equal(feesOnDisk(s.dir).length, 0, "no service fee on money never received");
  const alert = stateAlerts(s.dir).find((a) => a.message.startsWith("magma-orders.json"));
  assert.match(alert?.message ?? "", /released back to the buyer/, "the alert says what happens to such an order");
  assert.doesNotMatch(alert?.message ?? "", /can no longer be tracked here/);
});

test("an order with no invoice of ours in LND (accepted with another tool) is fulfilled — but not booked as a sale", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, earnings, fees } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 1, "fulfilled, as before");
  assert.equal(entryOnDisk(dir, sale.id)?.paidInvoiceId, null);
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "settled");
  assert.equal(earnings.recent().length, 0, "LND shows no payment to book");
  assert.equal(fees.entries().length, 0, "and no service fee is charged on it");
  assert.match(e?.events.map((x) => x.what).join(" | ") ?? "", /not booked as a sale/);
  // The Orders tab is told it was not booked — never "payment settled".
  assert.equal(autopilot.magma.localView(sale.id)?.booked, false);
  assert.doesNotMatch(e?.events.at(-1)?.what ?? "", /payment settled/);
});

test("an order whose invoice of ours was cancelled, or is a plain one never paid: no channel — and the unpaid one can't take a payment any more", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const waiting = { status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" };
  const refunded = magma.addSale({ buyerPubkey: BUYER, ...waiting });
  node.invoices.get(node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${refunded.id}` }))!.state = "CANCELED";
  const unpaid = magma.addSale({ buyerPubkey: BUYER, ...waiting });
  const plain = node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${unpaid.id}` });
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 0);
  assert.equal(entryOnDisk(dir, refunded.id)?.phase, "failed");
  assert.match(entryOnDisk(dir, refunded.id)?.reason ?? "", /invoice in LND is cancelled/);
  assert.equal(entryOnDisk(dir, unpaid.id)?.phase, "failed");
  assert.match(entryOnDisk(dir, unpaid.id)?.reason ?? "", /its invoice in LND is unpaid/);
  // Before: the plain invoice stayed payable for up to 49 h. A plain invoice
  // settles the moment an HTLC arrives — a payment in flight, or a late one,
  // would have been kept with no channel, no booking, and the order over.
  assert.equal(node.invoices.get(plain)?.state, "CANCELED", "no payment can land on it now");
  assert.match(entryOnDisk(dir, unpaid.id)?.reason ?? "", /cancelled now, so no payment can land on it later/);
  // Amboss keeps listing both as waiting for their channel: they stay ended
  // here (only an order awaiting approval is ever taken up again).
  await autopilot.pollSellOrders();
  for (const s of [refunded, unpaid]) assert.equal(entryOnDisk(dir, s.id)?.phase, "failed");
  assert.equal(node.callsTo("default.openChannel").length, 0);
});

test("the unpaid plain invoice of an order found with no record here settles just as it is cancelled: nothing recorded — the next pass fulfils and books the order", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, earnings } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
  const plain = node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${sale.id}` });
  // The buyer's payment lands right as the lane cancels: LND refuses the cancel.
  node.override("invoices.cancelInvoice", (_a, cb) => {
    const inv = node.invoices.get(plain)!;
    inv.state = "SETTLED";
    inv.receivedSats = 12_345;
    cb({ details: "invoice already settled" });
  });
  await autopilot.pollSellOrders();
  assert.equal(autopilot.magma.journal.get(sale.id), undefined, "nothing recorded on a cancel that failed");
  assert.equal(node.callsTo("default.openChannel").length, 0);
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.paidInvoiceId, plain, "paid to this node after all");
  assert.equal(e?.phase, "reported");
  assert.equal(node.callsTo("default.openChannel").length, 1, "the buyer gets the channel paid for");
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.deepEqual(earnings.recent().map((r) => [r.orderId, r.leaseSats]), [[sale.id, 12_345]]);
});

// ── an order only SEEN here, accepted elsewhere ──────────────────────────────

/** Amboss moves an order through the states an accept outside LightningMate
 *  produces, one lane pass each. */
async function acceptedOutside(s: ReturnType<typeof sellerSetup>, id: string, until = "VALID_CHANNEL_OPENING"): Promise<void> {
  for (const st of ["WAITING_FOR_BUYER_PAYMENT", "WAITING_FOR_CHANNEL_OPEN", "SELLER_SENT_TRANSACTION", "VALID_CHANNEL_OPENING"]) {
    s.magma.setStatus(id, st);
    await s.autopilot.pollSellOrders();
    if (st === until) break;
  }
}

test("an order this node only saw (its accept was refused), accepted and fulfilled outside LightningMate: Amboss reporting it confirmed is not booked, not charged, never 'payment settled' (R5-1)", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  s.magma.behave.AcceptOrder = "false";
  const refused = await s.autopilot.magma.accept(sale.id);
  assert.equal(refused.ok, false);
  const seen = entryOnDisk(s.dir, sale.id);
  assert.equal(seen?.phase, "seen");
  assert.equal(seen?.invoice, null, "nothing of ours is tied to it");
  // Accepted and fulfilled by someone else (amboss.tech with another wallet's
  // invoice, another tool): Amboss walks it to VALID_CHANNEL_OPENING.
  await acceptedOutside(s, sale.id);
  // Before: phase "settled", earnings [{ leaseSats: 12345 }], a 1% fee
  // enqueued — income on Amboss's word alone, for money never received.
  assert.equal(s.earnings.recent().length, 0, "no payment of ours exists for this order: nothing to book");
  assert.equal(s.fees.entries().length, 0, "and no service fee on money this node can't show it received");
  assert.equal(salesOnDisk(s.dir).length, 0);
  assert.equal(feesOnDisk(s.dir).length, 0);
  assert.equal(s.node.callsTo("default.openChannel").length, 0, "no channel of ours for it");
  const e = entryOnDisk(s.dir, sale.id);
  assert.notEqual(e?.phase, "settled", "never labelled 'completed · payment settled'");
  assert.equal(e?.external, "accepted_elsewhere");
  assert.match(e?.reason ?? "", /accepted outside LightningMate/);
  assert.equal(s.autopilot.magma.localView(sale.id)?.external, "accepted_elsewhere");
});

test("an order skipped while Amboss reported no fee ('seen'), then accepted outside LightningMate with selling on: nothing booked or charged, and the lane opens no channel for it (R5-1b)", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "seen");
  s.magma.sales.get(sale.id)!.feeSeller = "12345";
  await acceptedOutside(s, sale.id);
  assert.equal(s.earnings.recent().length, 0, "nothing of ours was accepted or paid: nothing to book");
  assert.equal(s.fees.entries().length, 0, "no service fee");
  assert.equal(s.node.callsTo("default.openChannel").length, 0, "the lane gave no capital away for a payment it can't see");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "failed");
});

test("an order only seen here, waiting for its channel and paid to an invoice of ours (an older LightningMate accepted it): it is fulfilled, and booked once confirmed", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "seen");
  // A downgrade to 0.7.x accepted it with a plain invoice of this node, which
  // settled on payment; back on this version, Amboss waits for the channel.
  const paid = s.node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${sale.id}`, paid: true });
  s.magma.setStatus(sale.id, "WAITING_FOR_CHANNEL_OPEN");
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.callsTo("default.openChannel").length, 1, "this node was paid: its channel is opened");
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.paidInvoiceId, paid);
  assert.equal(e?.phase, "reported");
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "settled");
  assert.deepEqual(salesOnDisk(s.dir).map((r) => [r.orderId, r.leaseSats]), [[sale.id, 12_345]]);
  assert.deepEqual(feesOnDisk(s.dir).map((f) => f.key), [`magma:${sale.id}`]);
  assert.equal(s.autopilot.magma.localView(sale.id)?.booked, true);
});

test("'Open channel' on an order only seen here and accepted elsewhere never answers ok without a channel (R5-3)", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "seen");
  s.magma.sales.get(sale.id)!.feeSeller = "12345";
  // Accepted elsewhere; the lane hasn't looked at it since.
  s.magma.setStatus(sale.id, "WAITING_FOR_CHANNEL_OPEN");
  const r = await s.autopilot.magma.open(sale.id);
  // Before: ok: true, "Order seen." — and the Orders tab toasted "Channel opening".
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_status");
  assert.match(r.message, /No channel opened: accepted outside LightningMate/);
  assert.equal(s.node.callsTo("default.openChannel").length, 0);
  // Over HTTP that is an error status, never 200.
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "failed");
});

test("an order on record without any invoice of ours — whatever path left it so — is never booked or charged when Amboss confirms its channel", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "VALID_CHANNEL_OPENING" });
  // A record that says "opened and reported by the autopilot" but carries no
  // invoice of ours and no paid invoice found in LND.
  const now = new Date().toISOString();
  writeFileSync(
    join(s.dir, "magma-orders.json"),
    JSON.stringify([
      {
        orderId: sale.id,
        phase: "reported",
        via: "autopilot",
        createdAt: now,
        updatedAt: now,
        buyerPubkey: BUYER,
        sizeSats: sale.sizeSats,
        isPrivate: false,
        feeMsat: "12345000",
        leaseBlocks: 4320,
        feeRateCapPpm: 2200,
        baseFeeCapSats: 1,
        invoice: null,
        acceptAttempts: 1,
        openAttempts: 1,
        reportAttempts: 1,
        fundingOutpoint: `${"cd".repeat(32)}:0`,
        events: [],
      },
    ]),
  );
  const p2 = s.restart();
  await p2.pollSellOrders();
  // Before: only via "legacy" was held to "a payment of ours"; this one was
  // booked (12,345 sat) and charged the 1% on Amboss's word alone.
  assert.equal(salesOnDisk(s.dir).length, 0, "nothing booked");
  assert.equal(feesOnDisk(s.dir).length, 0, "nothing charged");
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "settled");
  assert.equal(e?.unbooked, true);
  assert.equal(p2.magma.localView(sale.id)?.booked, false);
});
