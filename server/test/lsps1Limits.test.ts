// LSP mode: what a peer can tie the node up with, cheaply (review
// 2026-11-10, LSP-1..LSP-12). Each test is a probe of that review, turned
// round: it held the fault, it now holds the fix.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HELD_WAIT_MS, LSPS0_MESSAGE_TYPE, Lsps1Service, type Lsps1Order } from "../src/services/lsps1.js";
import { SettingsStore } from "../src/services/settings.js";
import { CapitalLedger } from "../src/services/capital.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { createHodl, newHodlSecret } from "../src/services/hodl.js";
import { fundChannel } from "../src/services/channelOps.js";
import { storeIncidents } from "../src/store.js";
import { makeTempDir } from "./helpers/tmp.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { parsePaymentRequest } from "./helpers/bolt11.js";
import { BUYER, lspNode, lspsWallet, zeusOrder, type LspNode } from "./helpers/lsps.js";
import { until } from "./helpers/wait.js";

const hashOf = (order: { payment: { bolt11: { invoice: string } } }): string => parsePaymentRequest(order.payment.bolt11.invoice).id;
const buyerN = (n: number) => "03" + n.toString(16).padStart(2, "0").repeat(32);
const view = (lsp: LspNode, id: string) => lsp.svc.orderViews().find((o) => o.orderId === id);
/** The app's default sell caps (autopilotConfig.ts). */
const APP_DEFAULT_CAPS = { maxChannelSats: 2_000_000, reserveSats: 50_000, maxDeploySats: 2_000_000 };

function silence(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
}

test("LSP-1: a buyer that pays and stays offline holds the shared capital six hours at most, however far off its HTLC's expiry — then the payment goes back and the capital is free for Magma and other buyers", async (t) => {
  silence(t);
  const lsp = lspNode(t, { caps: APP_DEFAULT_CAPS, node: new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER, buyerN(1)] }) });
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const o1 = (await w.call("lsps1.create_order", zeusOrder())).result;
  const o2 = (await w.call("lsps1.create_order", zeusOrder({ announce_channel: true }))).result;
  let dials = 0;
  lsp.seams.lndConnect = async () => {
    dials += 1;
    return false; // the buyer is offline
  };
  lsp.seams.openRetryDelayMs = 2;
  const tip = lsp.node.blockHeight;
  // The payer sets the HTLC's expiry: far beyond the invoice's 144 blocks.
  lsp.node.payHoldInvoice(hashOf(o1), { expiryHeight: tip + 2016 });
  lsp.node.payHoldInvoice(hashOf(o2), { expiryHeight: tip + 2016 });
  await until(() => dials >= 6, "both opens wait for the buyer");
  assert.equal(lsp.capital.reservedSat(), 2_000_000, "while it may still come: reserved");
  // Six hours after the payment (by the clock): released, whatever the
  // height would allow (before: three days in, both still held).
  for (const o of lsp.seams.orders) {
    o.heldAt = new Date(Date.now() - HELD_WAIT_MS - 60_000).toISOString();
    o.waitingForBuyerSince = o.heldAt;
  }
  await until(() => [o1, o2].every((o) => view(lsp, o.order_id)?.orderState === "FAILED"), "both released");
  for (const o of [o1, o2]) {
    const v = view(lsp, o.order_id);
    assert.deepEqual([v?.orderState, v?.paymentState], ["FAILED", "REFUNDED"]);
    assert.match(v?.error ?? "", /^the buyer did not come back online before its held payment was released 6 h after it was paid/);
    assert.equal(lsp.node.invoices.get(hashOf(o))?.state, "CANCELED");
  }
  assert.equal(lsp.capital.reservedSat(), 0);
  assert.equal(lsp.node.callsTo("default.openChannel").length, 0);
});

test("LSP-2: one peer's unpaid quotes turn no other buyer away — at the default 2M budget the other buyer is quoted and served; and should more be paid than can be opened, the open that finds the budget gone is refunded", async (t) => {
  silence(t);
  const squatter = buyerN(2);
  const lsp = lspNode(t, { caps: APP_DEFAULT_CAPS, node: new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER, squatter] }) });
  lsp.svc.start();
  const s = lspsWallet(lsp.node, squatter);
  const q1 = (await s.call("lsps1.create_order", zeusOrder())).result;
  const q2 = (await s.call("lsps1.create_order", zeusOrder({ announce_channel: true }))).result;
  assert.ok(q1?.order_id && q2?.order_id);
  // Before: code 1, "this LSP is at its capital deployment cap".
  const real = await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder());
  assert.ok(real.result?.order_id, JSON.stringify(real.error));
  assert.equal(lsp.capital.reservedSat(), 0, "unpaid quotes take nothing from Magma or the autopilot");
  // The real buyer pays and gets its channel.
  lsp.node.payHoldInvoice(hashOf(real.result));
  await until(() => view(lsp, real.result.order_id)?.orderState === "COMPLETED", "the real buyer's channel");
  // The squatter pays both: one fits the budget beside it, the other is refunded.
  lsp.node.payHoldInvoice(hashOf(q1));
  await until(() => view(lsp, q1.order_id)?.orderState === "COMPLETED", "the first fits");
  lsp.node.payHoldInvoice(hashOf(q2));
  await until(() => view(lsp, q2.order_id)?.orderState === "FAILED", "the second is refunded");
  assert.equal(view(lsp, q2.order_id)?.paymentState, "REFUNDED");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 2);
});

test("LSP-3: an open LND does not finish (the buyer never answers open_channel) gives the on-chain mutex back after its time limit: a Magma accept queued behind it runs, and the order waits as an unclear open — no refund, no second open", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  lsp.seams.openCallTimeoutMs = 200;
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  let opens = 0;
  lsp.seams.lndOpen = async () => {
    opens += 1;
    return new Promise(() => undefined); // never answers
  };
  lsp.node.payHoldInvoice(hashOf(order));
  await until(() => opens === 1, "the open is with LND");
  let ran = false;
  await lsp.capital.mutex.run("magma accept (test)", async () => {
    ran = true;
  });
  assert.equal(ran, true, "before: it waited until LND answered");
  await until(() => !!lsp.seams.orders.find((o) => o.orderId === order.order_id)?.opening?.unclear, "an unclear open");
  const o = lsp.seams.orders.find((x) => x.orderId === order.order_id)!;
  assert.match(o.opening?.unclear ?? "", /^LND did not finish the open within 0 s/);
  assert.deepEqual([o.orderState, o.paymentState], ["CREATED", "HOLD"], "not refunded: LND may still fund it");
  assert.equal(lsp.node.invoices.get(hashOf(order))?.state, "ACCEPTED");
  assert.equal(opens, 1);
});

/** LND's fee estimator answers `rate()` sat/vB for every target. */
function feeEstimator(node: FakeLnd, rate: () => number): void {
  node.override("wallet.estimateFee", ((_a: unknown, cb: (e: unknown, r?: unknown) => void) => cb(null, { sat_per_kw: String(rate() * 250) })) as never);
}

test("LSP-4: at 300 sat/vB a 1M channel costs more to open and close (97,500 sat) than this LSP's highest price (50,000 ppm): it is refused (code 1), not quoted below its cost — and a channel whose cost fits is quoted as ever", async (t) => {
  silence(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  let rate = 300;
  feeEstimator(node, () => rate);
  const lsp = lspNode(t, { node });
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const refused = await w.call("lsps1.create_order", zeusOrder());
  assert.equal(refused.error?.code, 1, JSON.stringify(refused));
  assert.equal(refused.error?.data?.message, "the least this LSP can sell a 1000000 sat channel for (opening and closing it, and what it must earn) is above the most it ever asks for one right now — usually high on-chain fees; try a larger channel, or later");
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "no invoice for it");
  // (A 2M channel: 97,500 sat of 100,000 at the cap — its floor with the
  // minimum profit is above it too; at 30 sat/vB a 1M one is quoted.)
  rate = 30;
  lsp.seams.pricingCache = undefined;
  const fine = await w.call("lsps1.create_order", zeusOrder());
  assert.ok(fine.result?.order_id, JSON.stringify(fine.error));
});

test("LSP-5: the funding rate is read when the channel is opened, not when it was paid: a buyer back online hours later is opened at the rate of then — and when opening and closing would then cost more than the order brings, the open waits for lower fees instead", async (t) => {
  silence(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  let rate = 4;
  feeEstimator(node, () => rate);
  const lsp = lspNode(t, { node });
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const order = (await w.call("lsps1.create_order", zeusOrder())).result;
  const fee = Number(order.payment.bolt11.fee_total_sat);
  let online = false;
  let dials = 0;
  lsp.seams.lndConnect = async () => {
    dials += 1;
    return online;
  };
  lsp.seams.openRetryDelayMs = 2;
  lsp.node.payHoldInvoice(hashOf(order));
  await until(() => dials >= 3, "waiting for the buyer");
  // Back online with the mempool full: 325 vB at this rate cost more than the order brings.
  rate = Math.ceil(fee / 325) + 10;
  online = true;
  await until(() => /^on-chain fees rose since the quote: at \d+ sat\/vB opening and closing this channel would cost about \d+ sat, more than the \d+ sat the order brings — waiting for lower fees$/.test(view(lsp, order.order_id)?.error ?? ""), "waits for lower fees, and says so");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 0, "not opened above what it brings");
  assert.equal(view(lsp, order.order_id)?.paymentState, "HOLD", "the payment stays held while it has time");
  // Fees come down to 5: opened at 5, not at the 4 of the payment's time.
  rate = 5;
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "opened");
  const [open] = lsp.node.callsTo("default.openChannel");
  assert.equal(Number(open.sat_per_vbyte), 5);
  assert.equal(view(lsp, order.order_id)?.error, undefined, "the wait's words go with it");
});

test("LSP-6: LSP mode switched off withdraws the quotes handed out and not paid — their invoices cancelled, the orders ended with the reason, nothing opened; a payment held before the switch-off is still served", async (t) => {
  silence(t);
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER, buyerN(3)] }) });
  lsp.svc.start();
  const quote = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const paid = (await lspsWallet(lsp.node, buyerN(3)).call("lsps1.create_order", zeusOrder())).result;
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const realConnect = lsp.seams.lndConnect.bind(lsp.svc);
  lsp.seams.lndConnect = async (pubkey) => {
    await gate; // the paid order waits for its buyer while the switch goes off
    return realConnect(pubkey);
  };
  lsp.node.payHoldInvoice(hashOf(paid));
  await until(() => view(lsp, paid.order_id)?.paymentState === "HOLD", "paid");
  lsp.settings.set({ lspModeEnabled: false });
  lsp.svc.applySettings();
  await until(() => view(lsp, quote.order_id)?.orderState === "FAILED", "the unpaid quote withdrawn");
  assert.equal(view(lsp, quote.order_id)?.error, "LSP mode was switched off before this order was paid — its invoice is cancelled");
  assert.equal(lsp.node.invoices.get(hashOf(quote))?.state, "CANCELED", "before: payable for its hour, and paying it opened a channel");
  release();
  await until(() => view(lsp, paid.order_id)?.orderState === "COMPLETED", "the order paid before is served");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 1);
});

test("LSP-7: the invoice is cancelled in LND while the open is with LND, and the channel opens: the order says the buyer has the channel without paying, a CRITICAL line and an alert tell the operator", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const realOpen = lsp.seams.lndOpen.bind(lsp.svc);
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let opening = false;
  lsp.seams.lndOpen = async (o, f) => {
    opening = true;
    await gate;
    return realOpen(o, f);
  };
  const hash = hashOf(order);
  lsp.node.payHoldInvoice(hash);
  await until(() => opening, "the open is with LND");
  lsp.node.expireHoldInvoice(hash);
  await until(() => view(lsp, order.order_id)?.orderState === "FAILED", "the watch ends the order");
  release();
  await until(() => storeIncidents(lsp.dir).some((i) => i.kind === "unpaid_channel"), "the alert");
  const v = view(lsp, order.order_id);
  assert.equal(v?.error, "the channel was opened, but its payment was released while the channel was being opened — the buyer has the channel without paying for it");
  assert.ok(v?.fundingOutpoint);
});

test("LSP-7: after a crash mid-open and an outage in which LND released the payment, recovery looks for the channel the order's 'opening' mark points to — found, it is on the order's record and the operator is told", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const { id, secret } = newHodlSecret();
  const orderId = "crashed-mid-open";
  const { request } = await createHodl(node.lnd, { id, tokens: 20_000, description: `LSPS1 ${orderId}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cltvDelta: 144 });
  node.payHoldInvoice(id);
  const opened = await fundChannel(node.lnd, { pubkey: BUYER, localTokens: 2_000_000, isPrivate: true, description: `lsps1:${orderId}` });
  assert.ok(opened.ok);
  node.expireHoldInvoice(id);
  const order = {
    orderId,
    peer: BUYER,
    createdAt: new Date(Date.now() - 24 * 3_600_000).toISOString(),
    lspBalanceSat: 2_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4_320,
    token: "",
    announceChannel: false,
    orderState: "CREATED",
    paymentState: "HOLD",
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: request,
    invoiceId: id,
    invoiceSecret: secret,
    invoiceExpiresAt: new Date(Date.now() - 23 * 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
    opening: { startedAt: new Date(Date.now() - 23.5 * 3_600_000).toISOString(), preExisting: [] },
  } as Lsps1Order;
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([order]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  await lsp.seams.recoverOrders();
  const v = view(lsp, orderId);
  assert.deepEqual([v?.orderState, v?.paymentState], ["FAILED", "REFUNDED"]);
  assert.ok(v?.fundingOutpoint, "before: 'expired across restart', no outpoint");
  assert.match(v?.error ?? "", /^the channel was opened, but LND released the buyer's held payment while the app was down/);
  assert.equal(storeIncidents(dir).filter((i) => i.kind === "unpaid_channel").length, 1);
});

test("LSP-8: an order the disk cannot take is refused before its invoice exists — no invoice for the buyer to pay, nothing left held after a restart, and the failed save is on the alerts", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  chmodSync(lsp.dir, 0o500); // the data directory can't be written (disk full, read-only remount)
  let res: Awaited<ReturnType<ReturnType<typeof lspsWallet>["call"]>>;
  try {
    res = await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder());
  } finally {
    chmodSync(lsp.dir, 0o700);
  }
  assert.equal(res.error?.code, -32603, JSON.stringify(res));
  assert.equal(res.error?.data?.message, "this LSP could not record the order — try again shortly");
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 0, "before: the buyer got an invoice nobody would know of after a restart");
  assert.deepEqual(lsp.svc.orderViews(), []);
  assert.ok(storeIncidents(lsp.dir).some((i) => i.kind === "write_failed" && i.file === "lsps1-orders.json"));
  // The disk is back: the next order is made as ever.
  const again = await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder());
  assert.ok(again.result?.payment?.bolt11?.invoice);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("LSP-9: the per-peer budget counts only the messages it answers: a flood leaves 30 entries, not one per message — and a wallet polling once a second is answered 30 times a minute, not 30 times and then never again", async (t) => {
  silence(t);
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER, buyerN(7)] }) });
  lsp.svc.start();
  const window = (lsp.svc as unknown as { rateWindow: Map<string, number[]> }).rateWindow;
  const msg = JSON.stringify({ jsonrpc: "2.0", id: "f", method: "lsps1.get_order", params: { order_id: "none" } });
  for (let i = 0; i < 20_000; i++) lsp.node.peerMessage(lsp.buyer, LSPS0_MESSAGE_TYPE, msg);
  await sleep(300);
  assert.equal(window.get(lsp.buyer)?.length, 30, "capped at the budget");
  assert.equal(lsp.node.sentMessages.length, 30);
  // A wallet polling once a second for three minutes (another peer).
  const poller = buyerN(7);
  const before = lsp.node.sentMessages.length;
  for (let i = 0; i < 180; i++) {
    const times = window.get(poller);
    if (times) window.set(poller, times.map((at) => at - 1_000)); // a second passes
    lsp.node.peerMessage(poller, LSPS0_MESSAGE_TYPE, msg);
    await sleep(2);
  }
  await sleep(200);
  // Three minutes, 30 a minute — the first second's answers fall out as the window slides.
  const answered = lsp.node.sentMessages.length - before;
  assert.ok(answered >= 88 && answered <= 92, `${answered} answered (before: 30, then silence for good)`);
});

test("LSP-10: a token this LSP never issued is refused with bLIP-51's error 102 — no order, no invoice; an empty token (ZEUS's) is none", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const res = await w.call("lsps1.create_order", zeusOrder({ token: "PROMO-HALF-PRICE" }));
  assert.deepEqual([res.error?.code, res.error?.message, res.error?.data?.message], [102, "Unrecognized or stale token", "this LSP issues no tokens — order without one"], JSON.stringify(res));
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 0);
  const plain = await w.call("lsps1.create_order", zeusOrder({ token: "" }));
  assert.equal(plain.result?.token, "");
});

test("LSP-11: write mode off with an order paid before: nothing here can open or refund it — the start says so, in the log and on the LSP card, with what becomes of the payment", async (t) => {
  const warned: string[] = [];
  t.mock.method(console, "warn", (m: string) => void warned.push(String(m)));
  t.mock.method(console, "log", () => undefined);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const { id, secret } = newHodlSecret();
  const { request } = await createHodl(node.lnd, { id, tokens: 20_000, description: "LSPS1 held", expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cltvDelta: 144 });
  node.payHoldInvoice(id);
  const order = {
    orderId: "held",
    peer: BUYER,
    createdAt: new Date().toISOString(),
    lspBalanceSat: 1_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4_320,
    token: "",
    announceChannel: false,
    orderState: "CREATED",
    paymentState: "HOLD",
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: request,
    invoiceId: id,
    invoiceSecret: secret,
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
  };
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([order]));
  const settings = new SettingsStore(dir);
  settings.set({ lspModeEnabled: true });
  const svc = new Lsps1Service(
    dir,
    node.lnd,
    undefined, // no write client: LM_ENABLE_WRITE=false
    settings,
    () => ({ maxChannelSats: 10_000_000, reserveSats: 50_000, maxDeploySats: 50_000_000 }),
    () => ({ sellPricingMode: "balanced", adaptiveLevel: 0.5, offerFeeCaps: null }) as never,
    () => "",
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
    undefined,
    new CapitalLedger(),
  );
  t.after(() => svc.stop());
  svc.start();
  await until(() => warned.some((w) => /write mode is off/.test(w)), "said at start");
  const status = await svc.status();
  assert.equal(status.running, false);
  assert.equal(
    status.lastError,
    "write mode is off: 1 paid LSP order can be neither opened nor refunded here — LND returns each payment itself near its HTLC's expiry (where a channel is already open, its payment is then lost); turn write mode on to have them finished",
  );
  assert.ok(warned.some((w) => w.includes("(held)")), "the log names the order");
  assert.equal(node.invoices.get(id)?.state, "ACCEPTED", "nothing written to LND: the gate holds");
});

// ── review of P9, round 1 ───────────────────────────────────────────────────

test("M-1: an open that ran past its time limit is waited for, not abandoned: past the 10-minute grace no second open goes out while LND's answer is still to come — and when LND funds it after all, that channel is the order's and its payment is claimed; the buyer is disconnected at the limit", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  lsp.seams.openCallTimeoutMs = 100;
  lsp.node.override("default.disconnectPeer", (_a, cb) => cb(null, {}));
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const realOpen = lsp.seams.lndOpen.bind(lsp.svc);
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let opens = 0;
  lsp.seams.lndOpen = async (o, f) => {
    opens += 1;
    if (opens === 1) return gate.then(() => realOpen(o, f)); // LND finishes this one late
    return realOpen(o, f);
  };
  lsp.node.payHoldInvoice(hashOf(order));
  const rec = () => lsp.seams.orders.find((x) => x.orderId === order.order_id)!;
  await until(() => !!rec().opening?.unclear, "the open ran past its limit");
  assert.equal(lsp.node.callsTo("default.disconnectPeer").length, 1, "the buyer disconnected: LND drops its pending reservation");
  // Eleven minutes on: past OPENING_GRACE_MS.
  rec().opening!.startedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  await lsp.seams.fulfill(rec());
  assert.equal(opens, 1, "before: a second open for the same order");
  assert.equal(rec().orderState, "CREATED");
  release(); // LND's open finishes after all
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "the late channel is the order's, its payment claimed");
  assert.ok(view(lsp, order.order_id)?.fundingOutpoint);
  assert.equal(lsp.node.callsTo("default.openChannel").length, 1, "one channel");
});

test("M-1: an open that ran past its time limit, and the order filed failed meanwhile (LND released the payment): when LND funds the channel after all it is on the order's record and the operator is told", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  lsp.seams.openCallTimeoutMs = 100;
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const realOpen = lsp.seams.lndOpen.bind(lsp.svc);
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  lsp.seams.lndOpen = async (o, f) => gate.then(() => realOpen(o, f));
  const hash = hashOf(order);
  lsp.node.payHoldInvoice(hash);
  const rec = () => lsp.seams.orders.find((x) => x.orderId === order.order_id)!;
  await until(() => !!rec().opening?.unclear, "timed out");
  lsp.node.expireHoldInvoice(hash);
  await until(() => view(lsp, order.order_id)?.orderState === "FAILED", "filed failed");
  release();
  await until(() => storeIncidents(lsp.dir).some((i) => i.kind === "unpaid_channel"), "the alert");
  assert.ok(view(lsp, order.order_id)?.fundingOutpoint, "before: on no record");
  assert.match(view(lsp, order.order_id)?.error ?? "", /^the channel was opened, but its payment was released before LND finished the open that had run past its time limit/);
});

test("M-2: five pubkeys with two unpaid quotes each fill the total cap of ten — fresh, the next buyer is told the LSP is full; once they have stood ten minutes unpaid, the next buyer's order takes the place of the oldest, whose invoice is cancelled and whose order says why", async (t) => {
  silence(t);
  const peers = [1, 2, 3, 4, 5].map(buyerN);
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 50_000_000, peers: [BUYER, ...peers] }) });
  lsp.svc.start();
  for (const p of peers) {
    const w = lspsWallet(lsp.node, p);
    assert.ok((await w.call("lsps1.create_order", zeusOrder())).result?.order_id);
    assert.ok((await w.call("lsps1.create_order", zeusOrder({ announce_channel: true }))).result?.order_id);
  }
  const real = lspsWallet(lsp.node, lsp.buyer);
  const fresh = await real.call("lsps1.create_order", zeusOrder());
  assert.equal(fresh.error?.data?.message, "this LSP has too many open orders right now — try again later");
  // Eleven minutes on, none of them paid.
  for (const o of lsp.seams.orders) o.createdAt = new Date(Date.parse(o.createdAt) - 11 * 60_000).toISOString();
  const oldest = [...lsp.seams.orders].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]!;
  const later = await real.call("lsps1.create_order", zeusOrder());
  assert.ok(later.result?.order_id, `before: still refused — ${JSON.stringify(later.error)}`);
  const gone = lsp.seams.orders.find((o) => o.orderId === oldest.orderId)!;
  assert.equal(gone.orderState, "FAILED");
  assert.equal(gone.error, "withdrawn unpaid: this LSP was at its limit of open orders, and another buyer's order took the place of this quote, unpaid for ten minutes");
  assert.equal(lsp.node.invoices.get(gone.invoiceId)?.state, "CANCELED");
  assert.equal(lsp.seams.orders.filter((o) => o.orderState === "CREATED").length, 10, "the cap holds");
});

test("LSP-2: get_info tells each buyer what it can order: another buyer's unpaid quotes don't shrink its maximum, its own do", async (t) => {
  silence(t);
  const other = buyerN(4);
  // 3M on chain: 2.9M to spend after the reserve and a funding fee.
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 3_000_000, peers: [BUYER, other] }) });
  lsp.svc.start();
  const theirs = lspsWallet(lsp.node, other);
  assert.ok((await theirs.call("lsps1.create_order", zeusOrder({ lsp_balance_sat: "2000000" }))).result?.order_id);
  const mine = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.get_info")).result;
  const own = (await theirs.call("lsps1.get_info")).result;
  assert.ok(Number(mine.max_initial_lsp_balance_sat) > 2_000_000, `another buyer's quote left this one ${mine.max_initial_lsp_balance_sat}`);
  assert.ok(Number(own.max_initial_lsp_balance_sat) < 2_000_000, `its own quote counts: ${own.max_initial_lsp_balance_sat}`);
});

test("LSP-8: an invoice LND refuses to make leaves no order behind — nothing for sameQuote to hand out, no pending slot taken", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  lsp.node.failNext("invoices.addHoldInvoice", "the invoices subserver is not ready");
  const w = lspsWallet(lsp.node, lsp.buyer);
  const res = await w.call("lsps1.create_order", zeusOrder());
  assert.equal(res.error?.code, -32603, JSON.stringify(res));
  assert.deepEqual(lsp.svc.orderViews(), []);
  const again = await w.call("lsps1.create_order", zeusOrder());
  assert.ok(again.result?.payment?.bolt11?.invoice, "the next try makes its own order, with an invoice");
});

test("LSP-6: a quote paid in the moment LSP mode is switched off is not withdrawn — its payment is held, and it is served", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const quote = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  // Paid; the switch goes off before the invoice watch has moved the order on.
  const realInvoice = lsp.seams.lndInvoice.bind(lsp.svc);
  let paid = false;
  lsp.seams.lndInvoice = async (id: string) => {
    if (!paid) lsp.node.payHoldInvoice(hashOf(quote));
    paid = true;
    return realInvoice(id);
  };
  const o = lsp.seams.orders.find((x) => x.orderId === quote.order_id)!;
  o.paymentState = "EXPECT_PAYMENT";
  lsp.settings.set({ lspModeEnabled: false });
  lsp.svc.applySettings();
  await until(() => view(lsp, quote.order_id)?.orderState === "COMPLETED", "served");
  assert.equal(lsp.node.invoices.get(hashOf(quote))?.state, "SETTLED");
});

test("m-1: an open still with LND (past its time limit) counts against the deploy cap: a second buyer's paid order that would overrun it is refunded, not opened beside — and the first is the order's once LND finishes it", async (t) => {
  silence(t);
  const b = buyerN(8);
  const lsp = lspNode(t, { caps: APP_DEFAULT_CAPS, node: new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER, b] }) });
  lsp.svc.start();
  lsp.seams.openCallTimeoutMs = 100;
  lsp.node.override("default.disconnectPeer", (_a, cb) => cb(null, {}));
  const qa = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder({ lsp_balance_sat: "2000000" }))).result;
  const qb = (await lspsWallet(lsp.node, b).call("lsps1.create_order", zeusOrder({ lsp_balance_sat: "2000000" }))).result;
  assert.ok(qa?.order_id && qb?.order_id, "both quoted (LSP-2)");
  const realOpen = lsp.seams.lndOpen.bind(lsp.svc);
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  lsp.seams.lndOpen = async (o, f) => (o.orderId === qa.order_id ? gate.then(() => realOpen(o, f)) : realOpen(o, f));
  lsp.node.payHoldInvoice(hashOf(qa));
  await until(() => !!lsp.seams.orders.find((o) => o.orderId === qa.order_id)?.opening?.unclear, "A's open ran past its limit");
  lsp.node.payHoldInvoice(hashOf(qb));
  await until(() => view(lsp, qb.order_id)?.orderState === "FAILED", "B refunded");
  assert.equal(view(lsp, qb.order_id)?.error, "capital deployment cap reached", "before: opened beside A — 4M against a 2M cap");
  release();
  await until(() => view(lsp, qa.order_id)?.orderState === "COMPLETED", "A's channel, once LND finishes it");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 1);
});

test("m-2: a wallet's retry while the first request's invoice is still being made is answered with that order once its invoice exists — never with an empty invoice", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const inv = (lsp.node.lnd as unknown as { invoices: { addHoldInvoice: (a: unknown, cb: (e: unknown, r?: unknown) => void) => void } }).invoices;
  const real = inv.addHoldInvoice.bind(inv);
  lsp.node.override("invoices.addHoldInvoice", ((a: unknown, cb: (e: unknown, r?: unknown) => void) => void setTimeout(() => real(a, cb), 300)) as never);
  const w = lspsWallet(lsp.node, lsp.buyer);
  const first = w.call("lsps1.create_order", zeusOrder());
  await sleep(100); // the first is inside, its invoice not made yet
  const retry = await w.call("lsps1.create_order", zeusOrder());
  const made = await first;
  assert.ok(retry.result?.payment?.bolt11?.invoice, `before: an empty invoice — ${JSON.stringify(retry.result?.payment ?? retry.error)}`);
  assert.equal(retry.result.order_id, made.result.order_id, "the same order");
});

test("M-1: an order filed as failed with an open's mark still on record (the process stopped while that open was out): recovery looks for its channel by the order's tag — found, it is on record and the operator is told", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const { id, secret } = newHodlSecret();
  const orderId = "failed-mid-open";
  const { request } = await createHodl(node.lnd, { id, tokens: 20_000, description: `LSPS1 ${orderId}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cltvDelta: 144 });
  node.expireHoldInvoice(id);
  const opened = await fundChannel(node.lnd, { pubkey: BUYER, localTokens: 2_000_000, isPrivate: true, description: `lsps1:${orderId}` });
  assert.ok(opened.ok);
  const order = {
    orderId,
    peer: BUYER,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    lspBalanceSat: 2_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4_320,
    token: "",
    announceChannel: false,
    orderState: "FAILED",
    paymentState: "REFUNDED",
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: request,
    invoiceId: id,
    invoiceSecret: secret,
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
    error: "payment refunded",
    opening: { startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), preExisting: [], unclear: "LND did not finish the open within 120 s" },
  } as Lsps1Order;
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([order]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  await lsp.seams.recoverOrders();
  assert.ok(view(lsp, orderId)?.fundingOutpoint, "before: on no record");
  assert.equal(storeIncidents(dir).filter((i) => i.kind === "unpaid_channel").length, 1);
});

test("m-3: LSP mode switched off while an order's invoice is being made: the order is withdrawn at once — the buyer is told, the invoice cancelled, nothing payable is handed out", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const inv = (lsp.node.lnd as unknown as { invoices: { addHoldInvoice: (a: unknown, cb: (e: unknown, r?: unknown) => void) => void } }).invoices;
  const real = inv.addHoldInvoice.bind(inv);
  lsp.node.override("invoices.addHoldInvoice", ((a: unknown, cb: (e: unknown, r?: unknown) => void) => {
    lsp.settings.set({ lspModeEnabled: false }); // the operator switches off right now
    real(a, cb);
  }) as never);
  const res = await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder());
  assert.equal(res.error?.data?.message, "LSP mode was switched off — this LSP takes no orders now", JSON.stringify(res));
  const [o] = lsp.seams.orders;
  assert.equal(o?.orderState, "FAILED");
  assert.equal(lsp.node.invoices.get(o!.invoiceId)?.state, "CANCELED");
});

test("n-5: a payment that lands as LSP mode's withdrawal cancels its quote is refunded by the cancel — and the order says REFUNDED, not HOLD", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const quote = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder()))
    .result;
  const realCancel = lsp.seams.lndCancel.bind(lsp.svc);
  lsp.seams.lndCancel = async (id: string) => {
    // The watch has just seen the payment arrive — and its word of the
    // cancel comes after LND's answer (here: never).
    const o = lsp.seams.orders.find((x) => x.orderId === quote.order_id)!;
    o.paymentState = "HOLD";
    (lsp.seams.invoiceSubs.get(id) as { removeAllListeners(): void } | undefined)?.removeAllListeners();
    return realCancel(id);
  };
  lsp.settings.set({ lspModeEnabled: false });
  lsp.svc.applySettings();
  await until(() => view(lsp, quote.order_id)?.orderState === "FAILED", "withdrawn");
  assert.equal(view(lsp, quote.order_id)?.paymentState, "REFUNDED");
});

test("n-7: while an open waits for lower fees, the buyer's polling does not start an attempt per message — the next one comes at the retry delay", async (t) => {
  silence(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  let rate = 4;
  feeEstimator(node, () => rate);
  const lsp = lspNode(t, { node });
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const order = (await w.call("lsps1.create_order", zeusOrder())).result;
  rate = 400;
  lsp.seams.openRetryDelayMs = 60_000;
  lsp.node.payHoldInvoice(hashOf(order));
  await until(() => /^on-chain fees rose since the quote/.test(view(lsp, order.order_id)?.error ?? ""), "waiting for lower fees");
  const reads = () => lsp.node.callsTo("wallet.estimateFee").length;
  const before = reads();
  for (let i = 0; i < 10; i++) await w.call("lsps1.get_order", { order_id: order.order_id });
  await sleep(100);
  assert.equal(reads(), before, "no attempt woken by the buyer's messages");
});

// ── review of P9, round 2 ───────────────────────────────────────────────────

test("N-1: a late open's channel recorded while a resumed fulfill waits in reconcileOpening behind it: that fulfill finds it — no second channel for the order, its payment claimed once", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  lsp.seams.openCallTimeoutMs = 100;
  lsp.node.override("default.disconnectPeer", (_a, cb) => cb(null, {}));
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const realOpen = lsp.seams.lndOpen.bind(lsp.svc);
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let opens = 0;
  lsp.seams.lndOpen = async (o, f) => {
    opens += 1;
    if (opens === 1) return gate.then(() => realOpen(o, f));
    return realOpen(o, f);
  };
  lsp.node.payHoldInvoice(hashOf(order));
  const rec = () => lsp.seams.orders.find((x) => x.orderId === order.order_id)!;
  await until(() => !!rec().opening?.unclear, "the open ran past its limit");
  await sleep(50);
  // The on-chain mutex is busy when LND finally answers the late open.
  let freeMutex = (): void => undefined;
  const busy = lsp.capital.mutex.run("busy (test)", () => new Promise<void>((r) => (freeMutex = r)));
  release();
  await until(() => lsp.node.callsTo("default.openChannel").length === 1, "LND answers the late open");
  await sleep(50); // its answer waits for the mutex
  const resumed = lsp.seams.fulfill(rec()); // a resumeLater tick, queued behind it
  await sleep(20);
  freeMutex();
  await busy;
  await resumed;
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "completed");
  assert.equal(opens, 1, "before: a second open, the first channel on no record");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 1);
  assert.equal(lsp.node.callsTo("invoices.settleInvoice").length, 1, "claimed once");
});

test("N-2: a start with LSP mode off, a quote left from before, and LND refusing its cancel: the quote is still followed — paid, it is served", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const { id, secret } = newHodlSecret();
  const orderId = "left-from-before";
  const { request } = await createHodl(node.lnd, { id, tokens: 20_000, description: `LSPS1 ${orderId}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cltvDelta: 144 });
  const order = {
    orderId,
    peer: BUYER,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lspBalanceSat: 1_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4_320,
    token: "",
    announceChannel: false,
    orderState: "CREATED",
    paymentState: "EXPECT_PAYMENT",
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: request,
    invoiceId: id,
    invoiceSecret: secret,
    invoiceExpiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
  } as Lsps1Order;
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([order]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  lsp.seams.lndCancel = async () => {
    throw new Error("LND is busy");
  };
  await lsp.seams.recoverOrders();
  assert.equal(lsp.seams.invoiceSubs.has(id), true, "before: unwatched");
  node.payHoldInvoice(id);
  await until(() => view(lsp, orderId)?.orderState === "COMPLETED", "a payment held is served");
});

test("N-4: a channel the buyer has without paying counts against the deploy cap while its lease would run", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  lsp.seams.openCallTimeoutMs = 100;
  lsp.node.override("default.disconnectPeer", (_a, cb) => cb(null, {}));
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const realOpen = lsp.seams.lndOpen.bind(lsp.svc);
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  lsp.seams.lndOpen = async (o, f) => gate.then(() => realOpen(o, f));
  const hash = hashOf(order);
  lsp.node.payHoldInvoice(hash);
  const rec = () => lsp.seams.orders.find((x) => x.orderId === order.order_id)!;
  await until(() => !!rec().opening?.unclear, "timed out");
  lsp.node.expireHoldInvoice(hash);
  await until(() => view(lsp, order.order_id)?.orderState === "FAILED", "filed failed");
  release();
  await until(() => storeIncidents(lsp.dir).some((i) => i.kind === "unpaid_channel"), "the alert");
  assert.equal(lsp.svc.deployedSat(), 1_000_000, "before: 0 — the full cap could be sold beside it");
});

test("N-5: an open of an earlier process found at recovery (its mark on disk, no answer to wait for): the buyer is disconnected once, so that LND drops a reservation a slow buyer may still hold", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  node.override("default.disconnectPeer", (_a, cb) => cb(null, {}));
  const { id, secret } = newHodlSecret();
  const orderId = "open-of-before";
  const { request } = await createHodl(node.lnd, { id, tokens: 20_000, description: `LSPS1 ${orderId}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), cltvDelta: 144 });
  node.payHoldInvoice(id);
  const order = {
    orderId,
    peer: BUYER,
    createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    lspBalanceSat: 1_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4_320,
    token: "",
    announceChannel: false,
    orderState: "CREATED",
    paymentState: "HOLD",
    heldAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: request,
    invoiceId: id,
    invoiceSecret: secret,
    invoiceExpiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
    // As left by a process that stopped while its open was out.
    opening: { startedAt: new Date(Date.now() - 60_000).toISOString(), preExisting: [], unclear: "the process stopped" },
  } as Lsps1Order;
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([order]));
  const lsp = lspNode(t, { dir, node });
  await lsp.seams.recoverOrders();
  await until(() => node.callsTo("default.disconnectPeer").length === 1, "the buyer disconnected");
  const o = lsp.seams.orders.find((x) => x.orderId === orderId)!;
  await lsp.seams.fulfill(o);
  await sleep(50);
  assert.equal(node.callsTo("default.disconnectPeer").length, 1, "once");
});

test("R13: at the total cap, another buyer's stale quote that turns out paid as it is to give way stands — and the new buyer is told the LSP is full, not that its own order was paid", async (t) => {
  silence(t);
  const peers = Array.from({ length: 10 }, (_, i) => buyerN(i + 10));
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 60_000_000, peers: [BUYER, ...peers] }) });
  lsp.svc.start();
  const quotes: { order_id: string; payment: { bolt11: { invoice: string } } }[] = [];
  for (const p of peers) quotes.push((await lspsWallet(lsp.node, p).call("lsps1.create_order", zeusOrder())).result);
  for (const o of lsp.seams.orders) o.createdAt = new Date(Date.parse(o.createdAt) - 11 * 60_000).toISOString();
  const oldest = [...lsp.seams.orders].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0]!;
  const q = quotes.find((x) => x.order_id === oldest.orderId)!;
  const realInvoice = lsp.seams.lndInvoice.bind(lsp.svc);
  let paid = false;
  lsp.seams.lndInvoice = async (id: string) => {
    if (id === oldest.invoiceId && !paid) {
      paid = true;
      lsp.node.payHoldInvoice(hashOf(q)); // paid right as it is looked at
    }
    return realInvoice(id);
  };
  const res = await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder());
  assert.equal(res.error?.data?.message, "this LSP has too many open orders right now — try again later", JSON.stringify(res));
  assert.notEqual(view(lsp, oldest.orderId)?.orderState, "FAILED", "the paid quote stands");
});

test("R27: an estimator that does not answer before an open gives no rate after its time limit — the open goes ahead at LND's own pick, the on-chain mutex not held for it", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  lsp.seams.feeReadTimeoutMs = 50;
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  // The funding rate's read never answers (the estimator hangs).
  (lsp.svc as unknown as { lndFeeRate: () => Promise<never> }).lndFeeRate = () => new Promise<never>(() => undefined);
  lsp.node.payHoldInvoice(hashOf(order));
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "opened");
  const [open] = lsp.node.callsTo("default.openChannel");
  assert.equal(open?.sat_per_vbyte, undefined, "no rate named: LND picks");
});

test("N-n5: LND's late answer to an open past its time limit is a refusal before any funding (the buyer disconnected): the order tries again at once — not after the ten-minute grace", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  lsp.seams.openCallTimeoutMs = 100;
  lsp.node.override("default.disconnectPeer", (_a, cb) => cb(null, {}));
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const realOpen = lsp.seams.lndOpen.bind(lsp.svc);
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let opens = 0;
  lsp.seams.lndOpen = async (o, f) => {
    opens += 1;
    if (opens === 1) return gate.then(() => ({ ok: false, error: "RemotePeerDisconnected" }));
    return realOpen(o, f);
  };
  lsp.node.payHoldInvoice(hashOf(order));
  const rec = () => lsp.seams.orders.find((x) => x.orderId === order.order_id)!;
  await until(() => !!rec().opening?.unclear, "the open ran past its limit");
  release();
  await sleep(50);
  await lsp.seams.fulfill(rec());
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "opened on the next try");
  assert.equal(opens, 2, "before: it waited out the grace");
});
