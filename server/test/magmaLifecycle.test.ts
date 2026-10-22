/**
 * Magma selling end to end, on the Magma API (fake) and a fake LND: the order
 * lane accepts with a HODL invoice, opens only once the buyer's payment is
 * held, reports the funding outpoint, settles only when Amboss confirms the
 * channel — and every failure releases the held payment instead.
 *
 * Before: orders were accepted with a REGULAR invoice (the buyer's payment
 * settled before any channel existed), a lost add_transaction answer led to a
 * second channel for the same order, unservable orders were left to time out,
 * and nothing about an order was recorded locally.
 *
 * (Split by theme: deciding new orders — magmaDecisions; reading orders from
 * Amboss — magmaReads; opening channels — magmaOpens; orders found with no
 * record here — magmaLegacy.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MagmaJournalEntry } from "../src/services/magmaJournal.js";
import { JsonStore, storeIncidents } from "../src/store.js";
import { paymentHashOf } from "./helpers/fakeLnd.js";
import { acceptedInvoice } from "./helpers/magma.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import {
  entryOnDisk,
  feeEnv,
  feesOnDisk,
  quiet,
  salesOnDisk,
  sleep,
} from "./helpers/lifecycle.js";

test("full lifecycle: HODL accept → payment held → open → add_transaction → VALID_CHANNEL_OPENING → settle → fee enqueued exactly once", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, earnings, fees } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "12345", sizeSats: 2_000_000 });
  // At the very moment LND is asked for the invoice, the preimage must
  // already be on disk — so a crash at any later point can settle or cancel.
  let onDiskAtInvoice: MagmaJournalEntry | undefined;
  node.beforeCall = (method) => {
    if (method === "invoices.addHoldInvoice") onDiskAtInvoice = entryOnDisk(dir, sale.id);
  };

  await autopilot.pollSellOrders();
  const amboss = magma.sales.get(sale.id)!;
  assert.equal(amboss.status, "WAITING_FOR_BUYER_PAYMENT", "accepted");
  const inv = acceptedInvoice(amboss);
  assert.equal(inv.mtokens, "12345000", "the invoice is for exactly fees.seller");
  assert.ok(Date.parse(inv.expires_at) - Date.now() >= 48 * 3_600_000, "it expires at least 48 h out");
  assert.equal(inv.cltv_delta, 288, "a held HTLC has room for the open and its confirmations");
  assert.equal(node.invoices.get(inv.id)?.hold, true, "a HODL invoice …");
  assert.equal(node.callsTo("default.addInvoice").length, 0, "… never a regular one, which settles on payment");
  assert.ok(onDiskAtInvoice?.invoice?.secret, "the preimage was saved before the invoice existed");
  assert.equal(paymentHashOf(onDiskAtInvoice.invoice.secret), inv.id);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "accepted");

  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 1, "opened once the payment was held");
  const ch = node.pending.find((p) => p.partnerPublicKey === BUYER)!;
  const outpoint = `${ch.transactionId}:${ch.transactionVout}`;
  assert.deepEqual(
    magma.calls.filter((c) => c.op === "AddTransaction").map((c) => (c.variables.input as { tx_id: string }).tx_id),
    [outpoint],
    "reported as TXID:OUTPUT_INDEX",
  );
  assert.equal(entryOnDisk(dir, sale.id)?.fundingOutpoint, outpoint);
  assert.equal(node.invoices.get(inv.id)?.state, "ACCEPTED", "the payment stays held until Amboss confirms the channel");
  assert.equal(fees.entries().length, 0, "no fee before the sale is complete");

  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(inv.id)?.state, "SETTLED", "settled on VALID_CHANNEL_OPENING");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "settled");
  // The sale carries the order's lease: the health score spreads its income over it.
  assert.deepEqual(earnings.recent().map((r) => [r.orderId, r.leaseSats, r.leaseBlocks]), [[sale.id, 12_345, 4_320]]);
  assert.deepEqual(fees.entries().map((e) => [e.key, e.feeSats]), [[`magma:${sale.id}`, 123]]);

  // Amboss keeps reporting the order (and later CHANNEL_MONITORING_FINISHED).
  await autopilot.pollSellOrders();
  magma.setStatus(sale.id, "CHANNEL_MONITORING_FINISHED");
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("invoices.settleInvoice").length, 1, "settled once");
  assert.equal(fees.entries().length, 1, "one fee");
  assert.equal(earnings.recent().length, 1, "one sale");
  const actions = [...autopilot.getState().history].reverse().flatMap((r) => r.sells.map((s) => `${s.action}:${s.ok}`));
  assert.deepEqual(actions, ["accept:true", "open:true", "report:true", "settle:true"]);
});

test("the open fails after the buyer paid: the HODL invoice is cancelled — the buyer is refunded, nothing is settled or charged", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, fees, earnings } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  node.openFailure = "remote peer rejected the channel: chan size of 0.02 BTC is below min chan size of 0.05 BTC";
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "the held payment is released");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.match(e?.reason ?? "", /^channel open failed: /);
  assert.equal(node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(fees.entries().length, 0);
  assert.equal(earnings.recent().length, 0);
});

test("INVALID_CHANNEL_OPENING: the HODL invoice is cancelled, no fee, no sale", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, fees } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "reported");
  magma.setStatus(sale.id, "INVALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "CANCELED");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
  assert.equal(node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(fees.entries().length, 0);
});

test("Amboss reporting the channel confirmed is never income on its own: an invoice of ours that holds no payment is not settled, booked or charged", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, earnings, fees } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = acceptedInvoice(magma.sales.get(sale.id)!).id;
  // The buyer never paid — yet Amboss reports the channel valid.
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  for (let i = 0; i < 2; i++) await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  // Without the guard (the reviewer's mutation S1): settled, booked as a
  // 12,345 sat sale and charged the 1% — for a payment never received.
  assert.notEqual(e?.phase, "settled");
  assert.equal(e?.phase, "accepted");
  assert.match(e?.lastError ?? "", /Amboss reports VALID_CHANNEL_OPENING, but our invoice is open — nothing to settle/);
  assert.equal(node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(node.invoices.get(hash)?.state, "OPEN");
  assert.equal(earnings.recent().length, 0, "no sale booked");
  assert.equal(fees.entries().length, 0, "no service fee");
  assert.equal(salesOnDisk(dir).length, 0);
  assert.equal(feesOnDisk(dir).length, 0);
});

test("Amboss reporting the channel confirmed while our invoice is gone from LND: nothing settled or booked — the order ends instead of waiting forever", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, earnings, fees, capital } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  node.invoices.delete(acceptedInvoice(magma.sales.get(sale.id)!).id); // LND lost it
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.match(e?.reason ?? "", /Amboss reports VALID_CHANNEL_OPENING, but our invoice is gone from LND — nothing to settle, nothing booked/);
  assert.equal(node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(earnings.recent().length, 0, "no sale booked");
  assert.equal(fees.entries().length, 0, "no service fee");
  assert.equal(salesOnDisk(dir).length, 0);
  assert.equal(feesOnDisk(dir).length, 0);
  assert.equal(capital.reservedSat(), 0, "its coins aren't kept reserved for an order that can't complete");
});

test("LND fails the settle of a confirmed sale: nothing is booked or charged until the payment is really claimed — the next pass settles it, once", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "reported");
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  node.failNext("invoices.settleInvoice", "transport is closing");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  // Without the check after a failed settle: recorded "settled", booked, and
  // its 1% enqueued — while the payment stayed held until LND cancelled it
  // near expiry (a channel delivered unpaid, income never received, a fee
  // on it).
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "the payment is still held, not claimed");
  assert.notEqual(e?.phase, "settled");
  assert.match(e?.lastError ?? "", /settle failed \(.*transport is closing\) — will try again/);
  assert.equal(salesOnDisk(dir).length, 0, "no sale booked for a payment not claimed");
  assert.equal(feesOnDisk(dir).length, 0, "no service fee on it");
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "settled");
  assert.equal(salesOnDisk(dir).length, 1);
  assert.equal(feesOnDisk(dir).length, 1);
});

test("LND fails the cancel of a held payment: the order is not recorded 'cancelled · buyer refunded' while the payment is still held — the next pass cancels it", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  magma.setStatus(sale.id, "INVALID_CHANNEL_OPENING");
  node.failNext("invoices.cancelInvoice", "transport is closing");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  // Without the check after a failed cancel: "cancelled", terminal — the
  // payment stayed held for up to two days, and nothing tried again.
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "still held");
  assert.notEqual(e?.phase, "cancelled", "not on record as refunded while it isn't");
  assert.match(e?.lastError ?? "", /could not cancel the HODL invoice \(.*transport is closing\) — will try again/);
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "released on the next pass");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
});

test("add_transaction answers success:false — it is retried, and the order never gets a second channel", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  magma.behave.AddTransaction = (n) => (n < 2 ? "false" : "ok");
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  for (let i = 0; i < 3; i++) await autopilot.pollSellOrders();
  assert.equal(magma.count("AddTransaction"), 3);
  assert.equal(node.callsTo("default.openChannel").length, 1);
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.equal(e?.reportAttempts, 3, "every attempt is on the order's record");
  // The run history shows the failure once (the same failure again is no
  // news — it would only flush the history), then the report that worked.
  const reports = [...autopilot.getState().history].reverse().flatMap((r) => r.sells.filter((s) => s.action === "report").map((s) => s.ok));
  assert.deepEqual(reports, [false, true], "the failed report is on record, not a sale");
});

test("the held payment is released before its HTLC would expire — and never used to open a channel", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const inv = acceptedInvoice(magma.sales.get(sale.id)!);
  // The buyer's HTLC expires in 20 blocks: too soon to open and confirm.
  node.payHoldInvoice(inv.id, { expiryHeight: node.blockHeight + 20 });
  magma.setStatus(sale.id, "WAITING_FOR_CHANNEL_OPEN");
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 0, "no channel for a payment about to vanish");
  assert.equal(node.invoices.get(inv.id)?.state, "CANCELED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /expire/);
});

test("LND released the held payment on its own: the order is recorded cancelled, no channel, no settle", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  node.expireHoldInvoice(hash); // LND cancels a held HTLC near its expiry
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 0);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
});

test("two lanes polling at once, and a click on 'Open channel' at the same time: one channel", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  // A slow open, so the others arrive while it is under way.
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const real = desk.lndOpen.bind(autopilot.magma);
  desk.lndOpen = async (p) => {
    await sleep(100);
    return real(p);
  };
  await Promise.all([
    autopilot.pollSellOrders(),
    autopilot.magma.tick(),
    autopilot.magma.open(sale.id),
    autopilot.pollSellOrders(),
  ]);
  assert.equal(node.callsTo("default.openChannel").length, 1);
  assert.equal(magma.count("AddTransaction") >= 1, true);
  const again = await autopilot.magma.open(sale.id);
  assert.equal(again.ok, true, "a later click finds the channel on record");
  assert.equal(node.callsTo("default.openChannel").length, 1);
});

test("a click on 'Accept' racing the lane: one accept, one invoice", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  const [, manual] = await Promise.all([autopilot.pollSellOrders(), autopilot.magma.accept(sale.id)]);
  assert.equal(magma.count("AcceptOrder"), 1);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 1);
  assert.equal(manual.phase, "accepted");
});

test("with selling off, an order taken on by hand waits for your click — and still settles through the lane", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(magma.count("Sales"), 0, "selling off: the lane doesn't even look for new orders");
  const accepted = await autopilot.magma.accept(sale.id);
  assert.equal(accepted.ok, true, accepted.message);
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 0, "no channel without your click");
  assert.match(entryOnDisk(dir, sale.id)?.decision?.reason ?? "", /waiting for you/);
  const opened = await autopilot.magma.open(sale.id);
  assert.equal(opened.ok, true, opened.message);
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "settled");
});

// ── restarts ──────────────────────────────────────────────────────────────────

type Seam = "lndCreateHodl" | "ambossAccept" | "lndOpen" | "ambossAddTx" | "lndSettle";

/** Make one external step "kill the process": the step's side effect happens
 *  (when `after`), then nothing of ours ever runs again in that process. */
function crashAt(desk: object, seam: Seam, when: "before" | "after"): () => boolean {
  const d = desk as Record<Seam, (...a: unknown[]) => Promise<unknown>>;
  const real = d[seam].bind(desk);
  let reached = false;
  d[seam] = async (...args: unknown[]) => {
    if (when === "after") await real(...args);
    reached = true;
    return new Promise(() => undefined); // the process is gone
  };
  return () => reached;
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await sleep(5);
  assert.ok(cond(), `never reached: ${what}`);
}

const CRASHES: { name: string; seam: Seam; when: "before" | "after"; stage: "accept" | "open" | "settle" }[] = [
  { name: "preimage saved, invoice not yet created", seam: "lndCreateHodl", when: "before", stage: "accept" },
  { name: "invoice created, not yet recorded", seam: "lndCreateHodl", when: "after", stage: "accept" },
  { name: "accept applied by Amboss, answer lost", seam: "ambossAccept", when: "after", stage: "accept" },
  { name: "open recorded, LND not yet asked", seam: "lndOpen", when: "before", stage: "open" },
  { name: "channel opened, outpoint not yet recorded", seam: "lndOpen", when: "after", stage: "open" },
  { name: "add_transaction applied, answer lost", seam: "ambossAddTx", when: "after", stage: "open" },
  { name: "payment settled in LND, not yet recorded", seam: "lndSettle", when: "after", stage: "settle" },
];

for (const c of CRASHES) {
  test(`restart after a crash (${c.name}): exactly one channel, one settle, one fee`, async (t) => {
    feeEnv(t);
    quiet(t);
    const s = sellerSetup(t);
    const sale = s.magma.addSale({ buyerPubkey: BUYER });
    const p1 = s.autopilot;
    if (c.stage !== "accept") {
      await p1.pollSellOrders();
      s.magma.buyerPays(sale.id, s.node);
    }
    if (c.stage === "settle") {
      await p1.pollSellOrders();
      s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
    }
    const crashed = crashAt(p1.magma, c.seam, c.when);
    void p1.pollSellOrders();
    await until(crashed, c.name);

    if (c.seam === "lndOpen" && c.when === "before") {
      // The restart comes later than LND would need to show an open that
      // had started: the journal's "opening" is old by then.
      const file = join(s.dir, "magma-orders.json");
      const entries = JSON.parse(readFileSync(file, "utf8")) as MagmaJournalEntry[];
      const e = entries.find((x) => x.orderId === sale.id)!;
      assert.equal(e.phase, "opening", "the open was on record before LND was asked");
      e.opening = { ...e.opening!, startedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
      writeFileSync(file, JSON.stringify(entries));
    }

    // A new process: same disk, same LND, same Amboss — nothing from memory.
    const p2 = s.restart();
    for (let i = 0; i < 8; i++) {
      await p2.pollSellOrders();
      const st = s.magma.sales.get(sale.id)!;
      const inv = st.paymentRequest ? s.node.invoices.get(acceptedInvoice(st).id) : undefined;
      if (st.status === "WAITING_FOR_BUYER_PAYMENT" && inv?.state === "OPEN") s.magma.buyerPays(sale.id, s.node);
      if (st.status === "SELLER_SENT_TRANSACTION") s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
      if (entryOnDisk(s.dir, sale.id)?.phase === "settled") break;
    }

    assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "settled", "the order completed after the restart");
    assert.equal(s.node.callsTo("default.openChannel").length, 1, "one channel");
    assert.equal(s.node.callsTo("invoices.addHoldInvoice").length, 1, "one invoice");
    assert.equal(s.node.callsTo("invoices.settleInvoice").length, 1, "one settle");
    assert.equal([...s.node.invoices.values()].filter((i) => i.state === "SETTLED").length, 1);
    assert.equal(feesOnDisk(s.dir).length, 1, "one fee");
    assert.equal(salesOnDisk(s.dir).filter((r) => r.orderId === sale.id).length, 1, "one sale");
  });
}

test("the funding outpoint can't be saved after the open (disk full): fail closed — alert, no second open, the restart finds the channel in LND", async (t) => {
  feeEnv(t);
  quiet(t);
  t.mock.method(console, "error", () => undefined);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await s.autopilot.pollSellOrders();
  s.magma.buyerPays(sale.id, s.node);
  // The disk fills up while LND is opening the channel.
  const desk = s.autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const real = desk.lndOpen.bind(s.autopilot.magma);
  let full: { mock: { restore(): void } } | undefined;
  desk.lndOpen = async (p) => {
    const res = await real(p);
    full = t.mock.method(JsonStore.prototype as unknown as { replaceFile(): void }, "replaceFile", () => {
      throw new Error("ENOSPC: no space left on device");
    });
    return res;
  };
  await s.autopilot.pollSellOrders();
  assert.ok(
    storeIncidents(s.dir).some((i) => i.kind === "unrecorded_open" && /could not be saved/.test(i.detail)),
    "raised as an alert",
  );
  await s.autopilot.pollSellOrders(); // same process: the outpoint is in memory
  assert.equal(s.node.callsTo("default.openChannel").length, 1, "never a second open");
  full?.mock.restore();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "opening", "on disk: the open, but not its outpoint");

  const p2 = s.restart();
  await p2.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.ok(e?.fundingOutpoint, "found in LND and recorded");
  assert.equal(s.node.callsTo("default.openChannel").length, 1);
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await p2.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "settled");
});

test("no Amboss call is ever made while the on-chain mutex is held (it guards opens, not network waits)", async (t) => {
  quiet(t);
  const { autopilot, node, magma, capital } = sellerSetup(t);
  const desk = autopilot.magma as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const heldDuring: string[] = [];
  for (const seam of ["ambossSales", "ambossSale", "ambossAccept", "ambossAddTx", "ambossReject"]) {
    const real = desk[seam].bind(autopilot.magma);
    desk[seam] = async (...args: unknown[]) => {
      if (capital.mutex.heldBy) heldDuring.push(`${seam} under "${capital.mutex.heldBy}"`);
      return real(...args);
    };
  }
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(autopilot.magma.journal.get(sale.id)?.phase, "settled");
  assert.deepEqual(heldDuring, []);
});

// ── what an order earns: the realistic fee path ───────────────────────────────

test("fees.seller reads 0 until settlement: the HODL invoice is fees.fixed + fees.variable (fractional too), and that is what's booked", async (t) => {
  feeEnv(t);
  quiet(t);
  const { autopilot, node, magma, dir, earnings, fees } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", feeFixed: "852", feeVariable: "6000.5" });
  await autopilot.pollSellOrders();
  const inv = acceptedInvoice(magma.sales.get(sale.id)!);
  assert.equal(inv.mtokens, "6852500", "852 + 6000.5 sat, to the millisat");
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  magma.sales.get(sale.id)!.feeSeller = "6852"; // Amboss fills it in at settlement
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "settled");
  assert.deepEqual(earnings.recent().map((r) => r.leaseSats), [6_852], "what the held invoice brought in");
  assert.deepEqual(fees.entries().map((e) => e.feeSats), [68]);
});

// ── the run history ───────────────────────────────────────────────────────────

test("an order retrying every 45 s doesn't flood the run history — and the lane leaves the main run's lastRunAt alone", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { chainBalance: 3_000_000 });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  node.chainBalance = 1_000_000; // the coins went elsewhere (a manual open)
  for (let i = 0; i < 60; i++) await autopilot.pollSellOrders();
  const history = (autopilot as unknown as { state: { history: { sells: { orderId: string; action: string }[] }[] } }).state.history;
  const opens = history.flatMap((r) => r.sells).filter((s) => s.orderId === sale.id && s.action === "open");
  // Before: 60 identical "open … will try again" runs — the whole 50-run
  // history, pushing out the fee runs the elasticity learner reads.
  assert.equal(opens.length, 1, "the failure once; its retries are on the order's own record");
  assert.match(entryOnDisk(dir, sale.id)?.lastError ?? "", /not enough on-chain capital/);
  assert.equal(autopilot.getState().lastRunAt ?? null, null, "the lane has its own lastTickAt");
  assert.ok(autopilot.getState().magmaLane.lastTickAt);

  node.chainBalance = 3_000_000; // capital is back
  await autopilot.pollSellOrders();
  const after = (autopilot as unknown as { state: { history: { sells: { orderId: string; action: string; ok: boolean }[] }[] } }).state.history;
  assert.deepEqual(after[0]?.sells.map((s) => [s.action, s.ok]), [["open", true], ["report", true]], "what moved the order on is recorded");
});
