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
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MagmaJournalEntry } from "../src/services/magmaJournal.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { JsonStore, storeIncidents } from "../src/store.js";
import { stateAlerts } from "../src/services/alerts.js";
import { paymentHashOf, type FakeLnd } from "./helpers/fakeLnd.js";
import { acceptedInvoice, forbidden, gqlError, internalError, orderNotFound, resolverFailed, throttled } from "./helpers/magma.js";
import { AmbossError } from "../src/services/amboss.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { OPEN_MIN_BLOCKS_LEFT, OPENING_GRACE_MS } from "../src/services/magmaDesk.js";
import { withEnv } from "./helpers/env.js";
import type { AfterHook } from "./helpers/tmp.js";

const ADDRESS = "fees@fees.example";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function feeEnv(t: AfterHook): void {
  withEnv(t, { LM_SELL_FEE_BPS: "100", LM_SELL_FEE_ADDRESS: ADDRESS, LM_SELL_FEE_PUBKEY: undefined });
}

const journalOnDisk = (dir: string): MagmaJournalEntry[] =>
  JSON.parse(readFileSync(join(dir, "magma-orders.json"), "utf8")) as MagmaJournalEntry[];
const entryOnDisk = (dir: string, id: string) => journalOnDisk(dir).find((e) => e.orderId === id);
/** What a restarted process would read: fee ledger and earnings from disk. */
const feesOnDisk = (dir: string) => new ServiceFeeLedger(dir, null).entries();
const salesOnDisk = (dir: string) => new EarningsLog(dir).recent();

function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
}

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
  assert.deepEqual(earnings.recent().map((r) => [r.orderId, r.leaseSats]), [[sale.id, 12_345]]);
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

test("an order this node can't fund is rejected at once, before its deadline, with the reason on record", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { chainBalance: 1_000_000 });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "rejected via seller.reject, not left to time out");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "rejected");
  assert.match(e?.reason ?? "", /not enough on-chain capital/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "no invoice for an order we can't serve");
  const reject = autopilot.getState().history[0]?.sells[0];
  assert.equal(reject?.action, "reject");
  assert.match(reject?.error ?? "", /not enough on-chain capital/, "the history says why");
});

/** LND's WalletBalance answer for the fake node's chain balance. */
const walletBalance = (node: FakeLnd) => ({
  confirmed_balance: String(node.chainBalance),
  unconfirmed_balance: "0",
  total_balance: String(node.chainBalance),
  locked_balance: "0",
  reserved_balance_anchor_chan: "10000",
  account_balance: {},
});

test("LND not answering during the accept's capital check is no reason to turn the buyer away: no reject, the next pass accepts", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  let blinks = 0;
  node.override("default.walletBalance", (_a, cb) => {
    // Once, exactly inside the accept's on-chain mutex (the check before it,
    // outside, went through).
    if (capital.mutex.heldBy === "magma accept" && blinks === 0) {
      blinks += 1;
      return cb({ details: "transport is closing" });
    }
    cb(null, walletBalance(node));
  });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(blinks, 1, "LND blinked inside the accept");
  // Before: "cannot save the order journal (503,UnexpectedErrorWhenGettingChainBalance,[object Object]) — not accepting",
  // and the order was rejected on Amboss — a sale and seller reputation lost to one blink.
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "not rejected");
  assert.equal(magma.count("RejectOrder"), 0);
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen", "nothing reserved, nothing created");
  assert.match(e?.lastError ?? "", /UnexpectedErrorWhenGettingChainBalance: transport is closing/, "LND's own words, readable");
  assert.doesNotMatch(e?.lastError ?? "", /\[object Object\]|journal/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);
  const error = autopilot.getState().history[0]?.sells.find((s) => s.orderId === sale.id);
  assert.equal(error?.action, "error", "on record as this order's error for now");

  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted on the next pass");
});

test("an accept whose preimage can't be saved fails closed: the order is rejected — no invoice, no accept", async (t) => {
  quiet(t);
  t.mock.method(console, "error", () => undefined);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  // The disk fails exactly when the accept saves its preimage.
  const proto = JsonStore.prototype as unknown as { replaceFile(...a: unknown[]): unknown };
  const realReplace = proto.replaceFile;
  t.mock.method(proto, "replaceFile", function (this: unknown, ...a: unknown[]) {
    if (capital.mutex.heldBy === "magma accept") throw new Error("ENOSPC: no space left on device");
    return realReplace.apply(this, a);
  });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "an accept that could never be settled is not sent");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /^cannot save the order journal \(ENOSPC: no space left on device\) — not accepting$/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);
  assert.equal(magma.count("AcceptOrder"), 0);
  assert.equal(capital.reservedSat(), 0, "nothing stays reserved");
});

test("orders outside the caps, or to an unreachable buyer, are rejected too — each with its reason", async (t) => {
  quiet(t);
  const unreachable = "02" + "ee".repeat(32);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  // This buyer never answers a connection attempt.
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (pk === unreachable) return cb({ details: "dial tcp: i/o timeout" });
    if (!node.peers.includes(pk)) node.peers.push(pk);
    cb(null, {});
  });
  const big = magma.addSale({ buyerPubkey: BUYER, sizeSats: 4_500_000 });
  const far = magma.addSale({ buyerPubkey: unreachable, sizeSats: 1_000_000 });
  const fits = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(fits.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "the order that fits is accepted");
  // 2M promised to `fits`: a further 3.5M would exceed the 5M deploy cap.
  const over = magma.addSale({ buyerPubkey: BUYER, sizeSats: 3_500_000 });
  await autopilot.pollSellOrders();
  const reason = (id: string) => entryOnDisk(dir, id)?.reason ?? "";
  for (const id of [big.id, far.id, over.id]) assert.equal(magma.sales.get(id)?.status, "SELLER_REJECTED", id);
  assert.match(reason(big.id), /above your max channel size/);
  assert.match(reason(far.id), /unreachable/);
  assert.match(reason(over.id), /deploy cap reached/);
});

test("an order for a Taproot Assets channel is rejected at once — no HODL invoice, no accept", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, assetType: "TAPROOT_ASSET" });
  await autopilot.pollSellOrders();
  // Without the check: accepted with a bitcoin HODL invoice, and a bitcoin
  // channel opened for an order that asked for an asset channel.
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /^not a bitcoin channel \(TAPROOT_ASSET\)$/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);
  assert.equal(magma.count("AcceptOrder"), 0);
});

test("LND's anchor reserve and the funding fee count: an order sized 'balance − 50k' is rejected, not accepted and then refused by LND", async (t) => {
  quiet(t);
  // Six anchor channels: LND keeps 10k × (6 + 1) = 70k for fee bumping and
  // refuses to fund a channel that would leave less.
  const channels = Array.from({ length: 6 }, (_, i) => ({
    partnerPublicKey: "03" + String(i).repeat(64).slice(0, 64),
    capacity: 1_000_000,
    localBalance: 500_000,
    transactionId: String(i + 1).repeat(64).slice(0, 64),
    transactionVout: 0,
  }));
  const { autopilot, magma, dir, node } = sellerSetup(t, { chainBalance: 2_050_000 });
  node.channels.push(...channels);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /reserve \(incl\. LND's anchor reserve and the funding fee\)/);
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
  magma.sales.get(servable.id)!.feeSeller = "1234";
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
  assert.match(lane.error ?? "", /Amboss unreachable \(ThrottlerException: Too Many Requests\)/);
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

const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();
/** The sells the run history shows for one order. */
const historyFor = (autopilot: ReturnType<typeof sellerSetup>["autopilot"], id: string) =>
  autopilot.getState().history.flatMap((r) => r.sells).filter((s) => s.orderId === id);

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

/** Amboss's answer for these orders' reads never comes: each read runs into
 *  its deadline (`fail` answers instead, e.g. an HTTP-level error). Returns
 *  the ids read, in order. */
function readsHang(
  autopilot: ReturnType<typeof sellerSetup>["autopilot"],
  hanging: (id: string) => boolean,
  fail: () => Error = () => new AmbossError("timeout", "Amboss request to magma.amboss.tech timed out after 15s"),
): string[] {
  const desk = autopilot.magma as unknown as { ambossSale: (key: string, id: string) => Promise<unknown> };
  const real = desk.ambossSale.bind(autopilot.magma);
  const read: string[] = [];
  desk.ambossSale = async (key, id) => {
    read.push(id);
    if (hanging(id)) throw fail();
    return real(key, id);
  };
  return read;
}

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
  assert.match(autopilot.getState().magmaLane.error ?? "", /Amboss unreachable \(Amboss request to magma\.amboss\.tech timed out/, "two timeouts in a pass: an outage");
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
  const read = readsHang(autopilot, (id) => id === newer.id);
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
  assert.match(autopilot.getState().magmaLane.error ?? "", /Amboss unreachable/);
  // The next pass walks them last: the older order goes first, and is settled.
  read.length = 0;
  await autopilot.pollSellOrders();
  assert.equal(read[0], sold.id, "the order whose read worked comes first");
  assert.equal(node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(entryOnDisk(dir, sold.id)?.phase, "settled");
});

test("Amboss down, every order's read timing out (its listing still answering): at most two reads in a pass, the rest on LND alone — a held payment near expiry is still released, and the lane says Amboss is unreachable", async (t) => {
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
  assert.match(lane.error ?? "", /^Amboss unreachable \(Amboss request to magma\.amboss\.tech timed out after 15s\) — held payments are still watched in LND$/);
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
  assert.match(autopilot.getState().magmaLane.error ?? "", /^Amboss unreachable \(Amboss HTTP 429\)/);
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

// ── a new order the lane can read but can't decide on ─────────────────────────

test("a new order whose decision can't be made (Amboss's listing of your sold capital fails): never silent — its record and the lane say what failed; near its deadline it is rejected, not left to time out", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 5 * 60_000).toISOString() });
  // One broken order among the running leases breaks every listing that
  // contains it: the deploy cap's listing answers a 500 inside GraphQL, pass
  // after pass. The listing of orders waiting on us, and the order's read, work.
  let broken = true;
  magma.salesList = (f) => (broken && f.status ? internalError() : null);
  await autopilot.pollSellOrders();
  let e = entryOnDisk(dir, sale.id);
  // Before: "seen", lastError "Internal server error" (no word of what
  // failed), and a lane reporting ok — until the order timed out on us.
  assert.equal(e?.phase, "seen", "nothing promised, nothing created");
  assert.equal(e?.lastError, "could not read your sold capital from Amboss: Internal server error");
  let lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false, "not 'ok'");
  assert.equal(lane.error, "could not decide 1 order (could not read your sold capital from Amboss: Internal server error)");
  assert.equal(lane.retrying, true);
  assert.deepEqual(historyFor(autopilot, sale.id).map((s) => [s.action, s.ok]), [["error", false]]);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "not turned down while there is time");
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);

  // Its approval deadline draws near, and the listing still fails.
  magma.sales.get(sale.id)!.timeout = new Date(Date.now() + 90_000).toISOString();
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "rejected — a reject needs only the order's id");
  e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "rejected");
  assert.equal(
    e?.reason,
    "could not decide on it in time: could not read your sold capital from Amboss: Internal server error — rejected rather than left to time out",
  );
  lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, true, "nothing left undecided");

  // The listing works again: a new order is accepted.
  broken = false;
  const next = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(next.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(autopilot.getState().magmaLane.ok, true);
});

test("Amboss's listing of your sold capital is asked once per pass: with it failing, several new orders don't each wait for it again", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const sales = [1_000_000, 1_100_000, 1_200_000].map((sizeSats) => magma.addSale({ buyerPubkey: BUYER, sizeSats, timeout: IN_AN_HOUR() }));
  let deployReads = 0;
  magma.salesList = (f) => {
    if (!f.status) return null;
    deployReads += 1;
    return internalError();
  };
  await autopilot.pollSellOrders();
  // Before: one request per new order — on a timeout, 15 s each.
  assert.equal(deployReads, 1, "asked once in the pass");
  for (const s of sales) {
    assert.equal(entryOnDisk(dir, s.id)?.phase, "seen");
    assert.match(entryOnDisk(dir, s.id)?.lastError ?? "", /^could not read your sold capital from Amboss: Internal server error$/);
  }
  assert.match(autopilot.getState().magmaLane.error ?? "", /^could not decide 3 orders \(could not read your sold capital from Amboss: /);
  await autopilot.pollSellOrders();
  assert.equal(deployReads, 2, "and asked again on the next pass");
});

test("an order the wallet can't fund is rejected at once, even while Amboss's listing of your sold capital fails — the wallet is checked first", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t, { chainBalance: 1_000_000 });
  let deployReads = 0;
  magma.salesList = (f) => {
    if (!f.status) return null;
    deployReads += 1;
    return internalError();
  };
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "turned down at once, not near its deadline");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /^not enough on-chain capital/);
  assert.equal(deployReads, 0, "no need to ask Amboss for that");
});

test("LND not answering the accept's own capital check close to the approval deadline: the order is rejected, not left to time out", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  // LND fails every balance read inside the accept's on-chain mutex (the
  // check before it, outside, went through).
  node.override("default.walletBalance", (_a, cb) => {
    if (capital.mutex.heldBy === "magma accept") return cb({ details: "transport is closing" });
    cb(null, walletBalance(node));
  });
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 90_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "rejected");
  assert.match(
    e?.reason ?? "",
    /^could not decide on it in time: LND did not answer the capital check: .*UnexpectedErrorWhenGettingChainBalance: transport is closing — rejected rather than left to time out$/,
  );
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "nothing offered");
  assert.equal(capital.reservedSat(), 0);
});

test("LND failing to create the HODL invoice: nothing is offered, the lane says so and accepts on the next pass — or, near the approval deadline, rejects the order", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  node.failNext("invoices.addHoldInvoice", "transport is closing");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.equal(e?.invoice, null);
  assert.match(e?.lastError ?? "", /^could not create the HODL invoice: /);
  assert.equal(capital.reservedSat(), 0, "nothing stays reserved");
  assert.equal(magma.count("AcceptOrder"), 0);
  assert.match(autopilot.getState().magmaLane.error ?? "", /^could not decide 1 order \(could not create the HODL invoice: /);
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted on the next pass");

  const late = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 90_000).toISOString() });
  node.failNext("invoices.addHoldInvoice", "transport is closing");
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(late.id)?.status, "SELLER_REJECTED", "near its deadline: rejected");
  assert.match(entryOnDisk(dir, late.id)?.reason ?? "", /^could not decide on it in time: could not create the HODL invoice: .* — rejected rather than left to time out$/);
});

test("SELLER_SENT_TRANSACTION with a funding transaction LND no longer knows: flagged for a human — never opened again", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_SENT_TRANSACTION");
  node.pending = []; // dropped from the mempool, and LND forgot it
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.match(e?.lastError ?? "", /no longer knows the funding transaction/);
  assert.equal(e?.phase, "reported");
  assert.equal(node.callsTo("default.openChannel").length, 1, "no automatic second open");
});

test("the payment was held, then LND released it before the open: the open-time check catches it — no channel", async (t) => {
  quiet(t);
  // Selling off: the lane carries the order taken on by hand up to "held",
  // then waits for the click — meanwhile LND releases the HTLC.
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  assert.equal((await autopilot.magma.accept(sale.id)).ok, true);
  const hash = magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "held");
  node.expireHoldInvoice(hash);
  const res = await autopilot.magma.open(sale.id);
  assert.equal(node.callsTo("default.openChannel").length, 0, "never a channel for a payment that is gone");
  assert.equal(res.ok, false);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
});

test("the buyer's options are honoured: a private channel when asked, and every listed address is tried before giving up", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const tried: string[] = [];
  node.override("default.connectPeer", (a, cb) => {
    const addr = a.addr as { pubkey: string; host: string };
    tried.push(addr.host);
    if (addr.host !== "5.6.7.8:9735") return cb({ details: "dial tcp: connection refused" });
    if (!node.peers.includes(addr.pubkey)) node.peers.push(addr.pubkey);
    cb(null, {});
  });
  const sale = magma.addSale({ buyerPubkey: BUYER, isPrivate: true, sockets: ["1.2.3.4:9735", "5.6.7.8:9735"] });
  await autopilot.pollSellOrders();
  assert.deepEqual([...new Set(tried)], ["1.2.3.4:9735", "5.6.7.8:9735"], "the second address after the first failed");
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  const [open] = node.callsTo("default.openChannel");
  assert.equal(open?.private, true, "a private channel, as the buyer ordered (a public one ends INVALID_CHANNEL_OPENING)");
});

test("an order whose fee Amboss never reports is rejected before its approval deadline, not left to time out", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 60_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /no fee/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "never an invoice for 0 sat");
});

// ── the open needs time, and an unclear open is looked for first ──────────────

test("an open needs the held payment to outlive the cancel margin by the confirmation time — or the payment is released, not used", async (t) => {
  quiet(t);
  for (const left of [25, OPEN_MIN_BLOCKS_LEFT - 1, OPEN_MIN_BLOCKS_LEFT]) {
    const { autopilot, node, magma, dir } = sellerSetup(t);
    const sale = magma.addSale({ buyerPubkey: BUYER });
    await autopilot.pollSellOrders();
    const inv = acceptedInvoice(magma.sales.get(sale.id)!);
    node.payHoldInvoice(inv.id, { expiryHeight: node.blockHeight + left });
    magma.setStatus(sale.id, "WAITING_FOR_CHANNEL_OPEN");
    await autopilot.pollSellOrders();
    const opens = node.callsTo("default.openChannel").length;
    if (left < OPEN_MIN_BLOCKS_LEFT) {
      // Before: 25 blocks passed the open-time check (it only wanted the
      // 24-block cancel margin) — the channel opened, and one block later the
      // buyer's payment was released: a channel delivered for nothing.
      assert.equal(opens, 0, `${left} blocks left: no channel`);
      assert.equal(node.invoices.get(inv.id)?.state, "CANCELED", `${left} blocks left: released at once`);
      assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /expire before the channel could be confirmed/);
    } else {
      assert.equal(opens, 1, `${left} blocks left: room for confirmations and Amboss's check`);
      node.blockHeight += 1;
      await autopilot.pollSellOrders();
      assert.equal(node.invoices.get(inv.id)?.state, "ACCEPTED", "and still held a block later");
    }
  }
});

test("an open whose outcome is unclear (the stream dropped) waits for LND: the channel that shows up is adopted — no second open, no refund", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  // LND took the open, but the gRPC stream dropped before it said so: the
  // channel shows up in LND only a little later.
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  let opens = 0;
  desk.lndOpen = async () => {
    opens += 1;
    return { ok: false, error: "FailedToOpenChannel: Connection dropped" };
  };
  await autopilot.pollSellOrders();
  let e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "opening", "not 'held' — that would allow a second open");
  assert.match(e?.opening?.unclear ?? "", /Connection dropped/);
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "and not released: a channel may exist");

  await autopilot.pollSellOrders();
  assert.equal(opens, 1, "within the grace period: no second open");

  const txid = "ab".repeat(32);
  node.pending.push({ partnerPublicKey: BUYER, capacity: sale.sizeSats, transactionId: txid, transactionVout: 0 });
  await autopilot.pollSellOrders();
  e = entryOnDisk(dir, sale.id);
  assert.equal(e?.fundingOutpoint, `${txid}:0`, "the channel LND shows was adopted");
  assert.equal(e?.phase, "reported");
  assert.equal(opens, 1);
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED");
});

test("an unclear open that LND never shows is tried again once LND has had ample time — but only then", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const real = desk.lndOpen.bind(autopilot.magma);
  let opens = 0;
  desk.lndOpen = async (p) => {
    opens += 1;
    return opens === 1 ? { ok: false, error: "UnknownChannelOpenStatus" } : real(p);
  };
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "opening");
  const entry = autopilot.magma.journal.get(sale.id)!;
  entry.opening = { ...entry.opening!, startedAt: new Date(Date.now() - OPENING_GRACE_MS - 60_000).toISOString() };
  await autopilot.pollSellOrders();
  assert.equal(opens, 2, "no channel after the grace: it never happened, so it is opened now");
  assert.equal(node.callsTo("default.openChannel").length, 1);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "reported");
});

test("two orders of one size from one buyer: the one whose open was unclear never adopts the other's channel", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const a = magma.addSale({ buyerPubkey: BUYER });
  const b = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(a.id, node);
  magma.buyerPays(b.id, node);
  // The first open's stream drops (nothing reached LND); the second opens.
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const real = desk.lndOpen.bind(autopilot.magma);
  let opens = 0;
  desk.lndOpen = async (p) => {
    opens += 1;
    return opens === 1 ? { ok: false, error: "FailedToOpenChannel: Connection dropped" } : real(p);
  };
  await autopilot.pollSellOrders();
  const [ea, eb] = [autopilot.magma.journal.get(a.id)!, autopilot.magma.journal.get(b.id)!];
  const [unclear, funded] = ea.phase === "opening" ? [ea, eb] : [eb, ea];
  assert.equal(unclear.phase, "opening");
  assert.ok(funded.fundingOutpoint, "the other order's channel is open and on record");

  await autopilot.pollSellOrders(); // the unclear one looks for its channel — the other's is the only one there
  assert.equal(unclear.fundingOutpoint, undefined, "not the other order's channel: both buyers' payments would settle on one channel");
  assert.equal(unclear.phase, "opening", "it waits for its own");

  unclear.opening = { ...unclear.opening!, startedAt: new Date(Date.now() - OPENING_GRACE_MS - 60_000).toISOString() };
  await autopilot.pollSellOrders();
  assert.equal(unclear.phase, "reported", "LND never showed it: opened now, its own channel");
  assert.notEqual(unclear.fundingOutpoint, funded.fundingOutpoint);
  assert.equal(node.callsTo("default.openChannel").length, 2);
});

/** The first open's stream drops (nothing reached LND): the order waits in
 *  "opening" for LND to show a channel. Later opens go through. */
function firstOpenUnclear(autopilot: ReturnType<typeof sellerSetup>["autopilot"]): void {
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const real = desk.lndOpen.bind(autopilot.magma);
  let opens = 0;
  desk.lndOpen = async (p) => {
    opens += 1;
    return opens === 1 ? { ok: false, error: "FailedToOpenChannel: Connection dropped" } : real(p);
  };
}

test("an unclear open never adopts a channel of ours to the buyer of another size — one that appeared after the open started", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  firstOpenUnclear(autopilot);
  await autopilot.pollSellOrders();
  const e = autopilot.magma.journal.get(sale.id)!;
  assert.equal(e.phase, "opening");
  // Meanwhile the operator opened a 1.5M routing channel to the same node.
  node.pending.push({ partnerPublicKey: BUYER, capacity: 1_500_000, transactionId: "cd".repeat(32), transactionVout: 0 });
  await autopilot.pollSellOrders();
  // Without the size check: that channel was adopted and reported to Amboss
  // as the 2M channel the buyer paid for.
  assert.equal(e.fundingOutpoint, undefined, "the 1.5M channel is not this 2M order's channel");
  assert.equal(e.phase, "opening");
  assert.equal(magma.count("AddTransaction"), 0, "nothing reported to Amboss");
  e.opening = { ...e.opening!, startedAt: new Date(Date.now() - OPENING_GRACE_MS - 60_000).toISOString() };
  await autopilot.pollSellOrders();
  assert.equal(e.phase, "reported", "its own channel, opened once LND had ample time to show one");
  assert.notEqual(e.fundingOutpoint, `${"cd".repeat(32)}:0`);
});

test("an unclear open never adopts a channel the buyer opened to us, even of the order's size", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  firstOpenUnclear(autopilot);
  await autopilot.pollSellOrders();
  const e = autopilot.magma.journal.get(sale.id)!;
  assert.equal(e.phase, "opening");
  // Meanwhile the buyer opened a 2M channel of their own to us: their coins,
  // not the inbound liquidity they paid this node for.
  node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: "ce".repeat(32), transactionVout: 0, partnerInitiated: true });
  await autopilot.pollSellOrders();
  assert.equal(e.fundingOutpoint, undefined, "a channel this node didn't fund is not the order's");
  assert.equal(magma.count("AddTransaction"), 0, "nothing reported to Amboss");
});

test("Amboss refuses the accept (success:false): the HODL invoice is cancelled at once — nothing of ours stays payable", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  magma.behave.AcceptOrder = "false";
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const created = node.callsTo("invoices.addHoldInvoice");
  assert.equal(created.length, 1);
  const hash = Buffer.from(created[0].hash as Buffer).toString("hex");
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "an invoice Amboss didn't take is released");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.equal(e?.invoice, null);
  assert.match(e?.lastError ?? "", /Amboss refused the accept/);
});

test("the buyer's node takes one pending channel at a time: that refusal is waited out, not refunded", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  // LND's default maxpendingchannels=1: the buyer has another channel pending.
  node.openFailure = "remote node pending channels exceed maximum allowed";
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "still held — before, refunded at once");
  assert.match(entryOnDisk(dir, sale.id)?.lastError ?? "", /will try again/);
  node.openFailure = null; // the earlier channel confirmed
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "reported");
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
