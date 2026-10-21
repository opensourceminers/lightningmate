/**
 * Every place a sale completes (a Magma order settling after Amboss confirmed
 * its channel — taken on by the autopilot or by hand — an LSPS1 settle and its
 * restart recovery) must book the sale once and ENQUEUE the service fee —
 * never await the fee payment. The fake node is set to leave payments
 * hanging, as a stuck HTLC would: before the fix each of these paths awaited
 * that payment and never returned.
 *
 * A Magma sale is complete when Amboss reports VALID_CHANNEL_OPENING and the
 * buyer's held payment is settled — not when the channel is merely opened.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EarningsLog } from "../src/services/earningsLog.js";
import { SettingsStore } from "../src/services/settings.js";
import { Lsps1Service, type Lsps1Order } from "../src/services/lsps1.js";
import { ServiceFeeLedger, lndFeeLightning } from "../src/services/serviceFee.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { mockLnurlPayServer } from "./helpers/lnurl.js";
import { FakeMagma } from "./helpers/magma.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";
import { withEnv } from "./helpers/env.js";

const ADDRESS = "fees@fees.example";

function feeEnv(t: AfterHook): void {
  withEnv(t, { LM_SELL_FEE_BPS: "100", LM_SELL_FEE_ADDRESS: ADDRESS, LM_SELL_FEE_PUBKEY: undefined });
}

/** Resolve within `ms` or fail — a path that awaits a stuck payment hangs. */
async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not return within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Temporarily shrink one deadline. */
function shrink(t: AfterHook, key: keyof typeof HTTP_TIMEOUTS, ms: number): void {
  const saved = HTTP_TIMEOUTS[key];
  HTTP_TIMEOUTS[key] = ms;
  t.after(() => {
    HTTP_TIMEOUTS[key] = saved;
  });
}

/** An autopilot selling on Magma, one order accepted and paid by the buyer. */
async function paidOrder(t: AfterHook, opts: Parameters<typeof sellerSetup>[1] = {}) {
  const s = sellerSetup(t, opts);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await s.autopilot.pollSellOrders(); // accept with a HODL invoice
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  s.magma.buyerPays(sale.id, s.node);
  return { ...s, sale };
}

test("a Magma sale is booked and its fee enqueued when it completes — without waiting for the fee payment", async (t) => {
  feeEnv(t);
  const { autopilot, node, magma, sale, earnings, fees, http } = await paidOrder(t, { payFees: true, payTimeoutMs: 100 });
  mockLnurlPayServer(http, { address: ADDRESS });
  node.payOutcome = "hang"; // a stuck HTLC

  await autopilot.pollSellOrders(); // open + report
  assert.equal(earnings.recent().length, 0, "an opened channel is not a sale yet");
  assert.equal(fees.entries().length, 0, "and owes no fee yet");

  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await within(10_000, autopilot.pollSellOrders(), "the order lane");

  assert.deepEqual(
    earnings.recent().map((r) => [r.orderId, r.leaseSats]),
    [[sale.id, 12_345]],
  );
  const [entry] = fees.entries();
  assert.equal(entry.key, `magma:${sale.id}`);
  assert.equal(entry.feeSats, 123);
  const settle = autopilot.getState().history[0]?.sells.find((s) => s.action === "settle");
  assert.equal(settle?.ok, true);

  // The fee is paid in the background (and here stays in flight).
  await fees.processDue();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1);
  assert.equal(fees.entries()[0].state, "inflight");
});

test("the same Magma sale seen complete twice is booked and charged once", async (t) => {
  feeEnv(t);
  const { autopilot, node, magma, sale, earnings, fees, http } = await paidOrder(t, { payFees: true });
  mockLnurlPayServer(http, { address: ADDRESS });
  await autopilot.pollSellOrders();
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  magma.setStatus(sale.id, "CHANNEL_MONITORING_FINISHED"); // Amboss reports it again, later
  await autopilot.pollSellOrders();
  await autopilot.magma.tick();
  await fees.processDue();
  assert.equal(earnings.recent().filter((r) => r.orderId === sale.id).length, 1);
  assert.equal(fees.entries().length, 1);
  assert.equal(fees.entries()[0].state, "paid");
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "one fee payment");
  assert.equal(node.callsTo("invoices.settleInvoice").length, 1, "one settle");
});

test("a channel Amboss did not confirm is not booked as a sale and owes no fee — the buyer is refunded", async (t) => {
  feeEnv(t);
  const { autopilot, node, magma, sale, earnings, fees } = await paidOrder(t);
  magma.behave.AddTransaction = "false"; // Amboss doesn't take the funding transaction
  await autopilot.pollSellOrders();
  const report = autopilot.getState().history[0]?.sells.find((s) => s.action === "report");
  assert.equal(report?.ok, false, "reported as a failure, not a sale");
  assert.match(report?.error ?? "", /did not accept the funding transaction/);
  magma.setStatus(sale.id, "INVALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(earnings.recent().length, 0);
  assert.equal(fees.entries().length, 0);
  assert.equal(node.callsTo("invoices.settleInvoice").length, 0, "never settled");
  assert.equal(node.callsTo("invoices.cancelInvoice").length, 1, "the held payment was released");
});

// ── The per-order Magma journal (P0's hand-off) ────────────────────────────────
// Amboss mutations have a deadline (http.ts). A mutation that timed out may
// still have been applied; only the persisted per-order record of the funding
// outpoint tells the two cases apart.

test("order journal: add_transaction timed out but Amboss applied it — the sale is booked and its fee enqueued exactly once, when Amboss shows the order past WAITING_FOR_CHANNEL_OPEN with the journalled outpoint", async (t) => {
  feeEnv(t);
  shrink(t, "ambossMutationMs", 150);
  const { autopilot, node, magma, sale, earnings, fees } = await paidOrder(t);
  magma.behave.AddTransaction = "apply-then-hang"; // applied, but the answer never comes

  await autopilot.pollSellOrders();
  const report = autopilot.getState().history[0]?.sells.find((s) => s.action === "report");
  assert.equal(report?.ok, false);
  assert.match(report?.error ?? "", /report not confirmed/);
  const journalled = autopilot.magma.journal.get(sale.id)?.fundingOutpoint;
  assert.ok(journalled, "the outpoint is on record");
  assert.equal(magma.sales.get(sale.id)?.transactionId, journalled, "Amboss has exactly that outpoint");

  await autopilot.pollSellOrders(); // Amboss: SELLER_SENT_TRANSACTION
  assert.equal(autopilot.magma.journal.get(sale.id)?.phase, "reported");
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  await autopilot.pollSellOrders();

  assert.equal(node.callsTo("default.openChannel").length, 1, "one channel");
  assert.equal(magma.count("AddTransaction"), 1, "no need to report it again");
  assert.equal(earnings.recent().length, 1, "booked once");
  assert.deepEqual(fees.entries().map((e) => e.key), [`magma:${sale.id}`], "one fee");
});

test("order journal: add_transaction timed out and was not applied — the next poll re-sends the journalled outpoint and never opens a second channel for that order", async (t) => {
  feeEnv(t);
  shrink(t, "ambossMutationMs", 150);
  const { autopilot, node, magma, sale, fees } = await paidOrder(t);
  magma.behave.AddTransaction = (n) => (n === 0 ? "hang" : "ok"); // the first one is lost

  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_CHANNEL_OPEN", "Amboss never got it");
  const journalled = autopilot.magma.journal.get(sale.id)?.fundingOutpoint;
  assert.ok(journalled);

  await autopilot.pollSellOrders();
  const sent = magma.calls.filter((c) => c.op === "AddTransaction").map((c) => (c.variables.input as { tx_id: string }).tx_id);
  assert.deepEqual(sent, [journalled, journalled], "the same outpoint, sent again");
  assert.equal(node.callsTo("default.openChannel").length, 1, "never a second channel");
  assert.equal(autopilot.magma.journal.get(sale.id)?.phase, "reported");
  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await autopilot.pollSellOrders();
  assert.equal(fees.entries().length, 1);
});

test("the manual 'open channel' route answers without waiting for a fee; the sale is booked when Amboss confirms it", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  mockLnurlPayServer(http, { address: ADDRESS });
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  node.payOutcome = "hang";
  const api = await startApi(t, { node });
  magma.sellerPubkey = api.node.publicKey; // this node's sales and offers
  api.amboss.setKey("test-key");
  const sale = magma.addSale({ buyerPubkey: BUYER });

  const accepted = await api.request("POST", "/amboss/order/accept", { id: sale.id });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  magma.buyerPays(sale.id, node);
  const res = await within(10_000, api.request("POST", "/amboss/order/open", { id: sale.id }), "POST /amboss/order/open");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.reported, true);
  assert.equal(api.earnings.recent().length, 0, "not a sale until Amboss confirms the channel");

  magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await within(10_000, api.autopilot.pollSellOrders(), "the order lane"); // runs for orders taken on by hand too
  assert.equal(api.earnings.recent().length, 1);
  assert.equal(api.serviceFees.entries()[0]?.key, `magma:${sale.id}`);
  await api.serviceFees.processDue();
});

test("the manual 'open channel' route books no sale and owes no fee while Amboss hasn't taken the channel", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  magma.behave.AddTransaction = "false";
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  const api = await startApi(t, { node });
  magma.sellerPubkey = api.node.publicKey; // this node's sales and offers
  api.amboss.setKey("test-key");
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await api.request("POST", "/amboss/order/accept", { id: sale.id });
  magma.buyerPays(sale.id, node);

  const res = await api.request("POST", "/amboss/order/open", { id: sale.id });
  assert.equal(res.status, 200, "the channel was opened");
  assert.equal(res.body.reported, false, "the UI is told Amboss doesn't have it yet");
  assert.ok(res.body.outpoint, "and which channel was opened");
  assert.equal(node.callsTo("default.openChannel").length, 1);
  const again = await api.request("POST", "/amboss/order/open", { id: sale.id });
  assert.equal(again.status, 200);
  assert.equal(node.callsTo("default.openChannel").length, 1, "a second click reports again, never opens again");
  // Amboss didn't take the funding transaction: no sale yet, so nothing is
  // earned and no service fee is owed.
  assert.equal(api.earnings.recent().length, 0);
  assert.equal(api.serviceFees.entries().length, 0);
});

function heldOrder(id: string, withChannel: boolean): Lsps1Order {
  const now = new Date();
  return {
    orderId: id,
    peer: BUYER,
    createdAt: now.toISOString(),
    lspBalanceSat: 2_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4320,
    token: "",
    announceChannel: true,
    orderState: "CREATED",
    paymentState: "HOLD",
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: "lnbc-placeholder",
    invoiceId: "aa".repeat(32),
    invoiceSecret: "bb".repeat(32),
    invoiceExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    channel: withChannel
      ? { fundedAt: now.toISOString(), fundingOutpoint: `${"cc".repeat(32)}:0`, expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString() }
      : null,
    serviceFeePaidSat: 0,
  };
}

/** LSPS1 service on a fake node, with its LND seams under test control. */
function lsps1(t: AfterHook, dir: string, node: FakeLnd) {
  const earnings = new EarningsLog(dir);
  const fees = new ServiceFeeLedger(dir, lndFeeLightning(node.lnd), { payTimeoutMs: 100 });
  const svc = new Lsps1Service(
    dir,
    node.lnd,
    node.lnd,
    new SettingsStore(dir),
    () => ({ maxChannelSats: 10_000_000, reserveSats: 50_000, maxDeploySats: 50_000_000 }),
    () => ({ sellPricingMode: "balanced", adaptiveLevel: 0.5 }),
    () => "",
    earnings,
    fees,
  );
  t.after(() => {
    svc.stop();
    fees.stop();
  });
  const seams = svc as unknown as {
    orders: Lsps1Order[];
    lndSettle: (secret: string) => Promise<void>;
    lndInvoice: (id: string) => Promise<{ is_confirmed: boolean; is_held?: boolean; is_canceled?: boolean }>;
    settleAndRecord: (o: Lsps1Order) => Promise<void>;
    recoverOrders: () => Promise<void>;
  };
  return { svc, seams, earnings, fees };
}

test("an LSPS1 settle books the sale and enqueues the fee without waiting for it", async (t) => {
  feeEnv(t);
  const dir = makeTempDir(t);
  const http = installFetchMock(t);
  mockLnurlPayServer(http, { address: ADDRESS });
  const node = new FakeLnd();
  node.payOutcome = "hang";
  const { seams, earnings, fees } = lsps1(t, dir, node);
  const settled: string[] = [];
  seams.lndSettle = async (secret) => {
    settled.push(secret);
  };
  const order = heldOrder("o-1", true);
  seams.orders.unshift(order);

  await within(10_000, seams.settleAndRecord(order), "settleAndRecord");
  assert.deepEqual(settled, [order.invoiceSecret]);
  assert.equal(order.orderState, "COMPLETED");
  assert.equal(earnings.recent().length, 1);
  assert.equal(fees.entries()[0]?.key, "lsps1:o-1");
  assert.equal(fees.entries()[0]?.feeSats, 200);
  await fees.processDue();
});

test("LSPS1 recovery books a sale that was settled just before a crash", async (t) => {
  feeEnv(t);
  const dir = makeTempDir(t);
  // The crash window: settled in LND, but the order file still says HOLD.
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([heldOrder("o-2", true)]));
  const http = installFetchMock(t);
  mockLnurlPayServer(http, { address: ADDRESS });
  const node = new FakeLnd();
  const { svc, seams, earnings, fees } = lsps1(t, dir, node);
  seams.lndInvoice = async () => ({ is_confirmed: true });

  await seams.recoverOrders();
  assert.equal(svc.orderViews()[0].orderState, "COMPLETED");
  assert.deepEqual(
    earnings.recent().map((r) => [r.orderId, r.leaseSats]),
    [["o-2", 20_000]],
    "the sale is in P&L",
  );
  assert.equal(fees.entries()[0]?.key, "lsps1:o-2");
  await fees.processDue();
});
