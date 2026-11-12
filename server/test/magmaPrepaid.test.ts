// A sale Amboss holds the buyer's payment for (review 2026-11-10, LANE-9 to
// LANE-13; the brief is MAGMA-SALE-FLOW.md, written from the live order of
// 2026-11-11).
//
// Amboss's docs describe one way a sale runs: the seller accepts with a HODL
// invoice, the buyer pays it, the seller opens, Amboss confirms, the seller
// settles. The first order this node sold by itself ran another way: the
// buyer had paid Amboss up front, the accept went straight to "waiting for
// the channel" with our invoice unpaid, and Amboss pays that invoice only
// once the channel has its confirmations. The lane waited for a payment that
// comes after the open — until the operator opened by hand and reported the
// channel on Amboss's website, which the lane then did not take either.
//
// Now an order this node accepted is opened without waiting for a held
// payment; never a second channel for one order; a channel opened and
// reported by hand is taken as the order's; the payment is claimed only when
// Amboss confirms the channel AND our invoice holds it in full AND LND shows
// the channel; and an order Amboss ends after the channel is out leaves the
// channel alone and tells the operator.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { AWAITING_AMBOSS_PAYMENT, BUYER_DIALS, NOT_OUR_ACCEPT_WAIT, OPENING_GRACE_MS, PAYMENT_OVERDUE_MS } from "../src/services/magmaDesk.js";
import { magmaOverduePaymentAlerts, magmaRefundAlerts, magmaUnpaidChannelAlerts } from "../src/services/alerts.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { chanNumber } from "./helpers/feeNode.js";
import { crashAt, entryOnDisk, feeEnv, feesOnDisk, quiet, readsHang, salesOnDisk, sleep } from "./helpers/lifecycle.js";
import { acceptedInvoice, PREPAID_CHANNEL_WINDOW_MS } from "./helpers/magma.js";

type Setup = ReturnType<typeof sellerSetup>;
const HOUR = 3_600_000;

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await sleep(5);
  assert.ok(cond(), `never reached: ${what}`);
}

/** The opens LND was asked for. */
const opens = (s: Setup) => s.node.callsTo("default.openChannel");
/** …and the fee rate each named (sat/vB). */
const openRates = (s: Setup) => opens(s).map((a) => (a.sat_per_vbyte === undefined ? undefined : Number(a.sat_per_vbyte)));
/** What the order's record says, in order. */
const events = (s: Setup, id: string) => (entryOnDisk(s.dir, id)?.events ?? []).map((ev) => ev.what);
/** LND's fee estimate: `usual` sat/vB, and `urgent` for a confirmation within three blocks. */
const estimate = (s: Setup, usual: number, urgent = usual) =>
  s.node.override("wallet.estimateFee", (a, cb) => cb(null, { sat_per_kw: String(Math.round((Number(a.conf_target) === 3 ? urgent : usual) * 250)) }));

const HOLDS = "Amboss holds the buyer's payment: it waits for the channel, and pays our invoice once the channel is confirmed";

/**
 * A 2,000,000 sat order earning 12,345 sat whose buyer paid Amboss up front,
 * accepted by the lane: Amboss shows it waiting for its channel, our invoice
 * unpaid. `before`: what is there before the lane first sees the order.
 */
async function prepaidOrder(t: TestContext, opts: Parameters<typeof sellerSetup>[1] & { before?: (s: Setup) => void } = {}) {
  feeEnv(t);
  quiet(t);
  const { before, ...setup } = opts;
  const s = sellerSetup(t, setup);
  s.node.peers.push(BUYER);
  before?.(s);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  s.magma.buyerPaidAmboss(sale.id);
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_CHANNEL_OPEN", "Amboss took the accept and waits for the channel");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
  const hash = acceptedInvoice(s.magma.sales.get(sale.id)!).id;
  assert.equal(s.node.invoices.get(hash)?.state, "OPEN", "nothing has paid our invoice");
  return { s, sale, hash };
}

// ── LANE-9: the sale completes ─────────────────────────────────────────────

test("the buyer paid Amboss up front: the lane opens the channel with our invoice still unpaid, reports it, waits for Amboss's payment once the channel is confirmed, and settles — before, it waited for a payment that comes only after the open", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  await s.autopilot.pollSellOrders();
  // Before: no open — "Amboss says paid, but our invoice holds no payment
  // yet", pass after pass, until Amboss ended the order as our failure.
  assert.equal(opens(s).length, 1);
  let e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.equal(e?.lastError, undefined);
  assert.equal(s.magma.sales.get(sale.id)?.status, "SELLER_SENT_TRANSACTION");
  assert.equal(s.magma.sales.get(sale.id)?.transactionId, e?.fundingOutpoint, "Amboss has the outpoint");
  assert.equal(s.node.invoices.get(hash)?.state, "OPEN", "still unpaid: Amboss pays after the confirmation");
  assert.equal(events(s, sale.id).filter((w) => w === HOLDS).length, 1, "the record says why it opens unpaid");
  assert.equal(s.capital.reservedSat(), 0, "the coins are in the channel, no longer promised");
  // Passes while the channel confirms: nothing more happens.
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 1);
  assert.equal(s.magma.count("AddTransaction"), 1);
  // Amboss confirms the channel — and has not paid yet: no error, no settle.
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.equal(e?.lastError, undefined);
  assert.equal(e?.decision?.reason, AWAITING_AMBOSS_PAYMENT);
  assert.equal(s.node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(salesOnDisk(s.dir).length, 0, "Amboss's word alone is never income");
  const lane = s.autopilot.getState().magmaLane;
  assert.deepEqual([lane.ok, lane.error], [true, null]);
  // Amboss pays: settled, booked, charged the service fee — once.
  s.magma.ambossPays(sale.id, s.node);
  await s.autopilot.pollSellOrders();
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "settled");
  assert.equal(s.node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(s.node.callsTo("invoices.settleInvoice").length, 1);
  assert.deepEqual(
    salesOnDisk(s.dir).map((x) => [x.orderId, x.leaseSats]),
    [[sale.id, 12_345]],
  );
  assert.equal(feesOnDisk(s.dir).length, 1);
  assert.ok(events(s, sale.id).includes("Amboss's payment arrived (12345 sat) — held until Amboss confirms the channel"));
  assert.ok(events(s, sale.id).includes("payment settled — sale complete"));
  assert.equal(opens(s).length, 1);
});

test("Amboss pays hours after it confirmed the channel: the order waits without an error, the operator is told once it lasts, and the payment is settled and booked when it comes", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  await s.autopilot.pollSellOrders();
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await s.autopilot.pollSellOrders();
  const t0 = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: t0 + 2 * HOUR });
  await s.autopilot.pollSellOrders();
  let e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported", "two hours on: still waiting (it ended after one, the invoice cancelled so that Amboss could no longer pay)");
  assert.equal(s.node.invoices.get(hash)?.state, "OPEN");
  assert.deepEqual(magmaOverduePaymentAlerts(s.desk), []);
  t.mock.timers.setTime(t0 + PAYMENT_OVERDUE_MS + 60_000);
  await s.autopilot.pollSellOrders();
  const [overdue] = magmaOverduePaymentAlerts(s.desk);
  assert.match(overdue?.message ?? "", /^Amboss confirmed the channel of a 2,000,000 sat Magma order on .* UTC, but has not paid its 12,345 sat to this node yet\./);
  s.magma.ambossPays(sale.id, s.node);
  await s.autopilot.pollSellOrders();
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "settled");
  assert.equal(s.node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(salesOnDisk(s.dir).length, 1);
  assert.equal(feesOnDisk(s.dir).length, 1);
  assert.deepEqual(magmaOverduePaymentAlerts(s.desk), [], "the alert goes with the payment");
});

// ── LANE-10: never a second channel ────────────────────────────────────────

test("never a second channel: Amboss's payment arrives on our invoice while Amboss still shows the order waiting for its channel (the report of our open did not get through) — the one channel is reported again, and the payment settled for it", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  s.magma.behave.AddTransaction = "throw";
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 1);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "funded");
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_CHANNEL_OPEN", "Amboss has not heard of the channel");
  const outpoint = entryOnDisk(s.dir, sale.id)?.fundingOutpoint;
  // The payment arrives — "paid, and waiting for its channel": what opens a
  // channel for an order that has none.
  s.node.payHoldInvoice(hash);
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 1, "the order has its channel");
  let e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "funded");
  assert.equal(e?.fundingOutpoint, outpoint);
  assert.ok(events(s, sale.id).includes("Amboss's payment arrived (12345 sat) — held until Amboss confirms the channel"));
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED", "held, not claimed: Amboss has not confirmed the channel");
  // The report gets through; Amboss confirms; the payment is claimed.
  s.magma.behave.AddTransaction = "ok";
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(sale.id)?.transactionId, outpoint);
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "settled");
  assert.equal(opens(s).length, 1);
  assert.equal(salesOnDisk(s.dir).length, 1);
});

test("never a second channel: “Open channel” clicked while the lane's open of an unpaid order is under way opens nothing", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  // The lane's open reaches LND and takes its time there.
  const desk = s.desk as unknown as { lndOpen: (...a: unknown[]) => Promise<unknown> };
  const real = desk.lndOpen.bind(s.desk);
  let entered = false;
  let letGo!: () => void;
  const gate = new Promise<void>((resolve) => (letGo = resolve));
  desk.lndOpen = async (...a: unknown[]) => {
    entered = true;
    await gate;
    return real(...a);
  };
  const pass = s.autopilot.pollSellOrders();
  await until(() => entered, "the lane's open reached LND");
  const click = s.autopilot.magma.open(sale.id);
  await sleep(50);
  letGo();
  const [, clicked] = await Promise.all([pass, click]);
  assert.equal(opens(s).length, 1, "one order, one channel");
  const e = entryOnDisk(s.dir, sale.id);
  assert.ok(e?.phase === "reported" || e?.phase === "funded", `phase ${e?.phase}`);
  assert.equal(s.node.pending.filter((p) => p.partnerPublicKey === BUYER).length, 1);
  // The click reports the order's one channel, or says the open is under way — never a new one.
  assert.ok(clicked.ok || clicked.code === "open_failed", JSON.stringify(clicked));
});

for (const when of ["before", "after"] as const) {
  test(`never a second channel: the process dies ${when === "before" ? "with the open on record and LND not yet asked" : "after LND opened the channel, its outpoint not yet on record"} — the next start opens ${when === "before" ? "once, after LND has had its time to show a channel" : "nothing: the channel LND shows is the order's"}`, async (t) => {
    const { s, sale } = await prepaidOrder(t);
    const reached = crashAt(s.desk, "lndOpen", when);
    void s.autopilot.pollSellOrders();
    await until(reached, "the open");
    assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "opening");
    assert.equal(entryOnDisk(s.dir, sale.id)?.opening?.from, "accepted", "where an open that did not happen goes back to");
    const again = s.restart();
    await again.pollSellOrders();
    if (when === "after") {
      assert.equal(opens(s).length, 1);
      const e = entryOnDisk(s.dir, sale.id);
      assert.equal(e?.phase, "reported");
      const [channel] = s.node.pending.filter((p) => p.partnerPublicKey === BUYER);
      assert.equal(e?.fundingOutpoint, `${channel?.transactionId}:${channel?.transactionVout}`);
      return;
    }
    // LND was never asked: nothing is opened until it has had ample time to
    // show a channel, then the open is made — once.
    assert.equal(opens(s).length, 0);
    assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "opening");
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + OPENING_GRACE_MS + 60_000 });
    await again.pollSellOrders();
    await again.pollSellOrders();
    assert.equal(opens(s).length, 1);
    assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "reported");
    await again.pollSellOrders();
    assert.equal(opens(s).length, 1);
  });
}

test("a channel of the order's size to the buyer that was there when the order was accepted is not the order's: the lane opens the order's own", async (t) => {
  const old = `${"ab".repeat(32)}:1`;
  const { s, sale } = await prepaidOrder(t, {
    before: (x) => x.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 2_000_000, transactionId: "ab".repeat(32), transactionVout: 1 }),
  });
  assert.deepEqual(entryOnDisk(s.dir, sale.id)?.preExistingAtAccept, [old], "what the buyer had from us at the accept is on the record");
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 1);
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.notEqual(e?.fundingOutpoint, old);
  assert.ok(!events(s, sale.id).some((w) => /opened outside LightningMate/.test(w)));
});

// ── LANE-12: a channel opened by hand ──────────────────────────────────────

test("the operator opened the channel with another tool and reported it on Amboss's website while the lane waited for lower fees: the channel — still unconfirmed in LND — is taken as the order's, nothing is opened or reported, and Amboss's payment is settled for it", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  estimate(s, 400);
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 0);
  assert.match(
    entryOnDisk(s.dir, sale.id)?.lastError ?? "",
    /^on-chain fees are 400 sat\/vB: opening the channel would cost about 70,000 sat, more than the 12,221 sat this sale earns; Amboss holds the buyer's payment, so the channel is opened whatever the fee from \d{4}-\d\d-\d\d \d\d:\d\d UTC — waiting for lower fees \(“Open channel” on Market → Orders opens it anyway\) — will try again$/,
  );
  // By hand: a channel LND shows as opening, and its transaction on Amboss.
  const txid = "cd".repeat(32);
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
  const amboss = s.magma.sales.get(sale.id)!;
  amboss.transactionId = `${txid}:0`;
  amboss.status = "SELLER_SENT_TRANSACTION";
  estimate(s, 1);
  await s.autopilot.pollSellOrders();
  await s.autopilot.pollSellOrders();
  // Before (and with the lane's open no longer waiting for the payment): a
  // second channel, or an order stuck at "accepted" until it ran out.
  assert.equal(opens(s).length, 0);
  assert.equal(s.magma.count("AddTransaction"), 0, "Amboss has the transaction already");
  let e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.equal(e?.fundingOutpoint, `${txid}:0`);
  assert.equal(e?.lastError, undefined);
  assert.ok(events(s, sale.id).includes(`its channel ${txid}:0 was opened outside LightningMate — taken from Amboss and LND`));
  assert.equal(s.capital.reservedSat(), 0);
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await s.autopilot.pollSellOrders();
  s.magma.ambossPays(sale.id, s.node);
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "settled");
  assert.equal(s.node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(salesOnDisk(s.dir).length, 1);
  assert.equal(opens(s).length, 0);
});

test("the operator opened the channel with another tool and has not reported it: the lane finds it in LND before it opens anything, takes it as the order's and reports it to Amboss", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  const txid = "ef".repeat(32);
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 1 });
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 0, "the buyer bought one channel");
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.equal(e?.fundingOutpoint, `${txid}:1`);
  assert.ok(events(s, sale.id).includes(`a channel to the buyer was opened outside LightningMate (${txid}:1) — taken as this order's`));
  assert.equal(s.magma.sales.get(sale.id)?.transactionId, `${txid}:1`);
  assert.equal(s.magma.count("AddTransaction"), 1);
});

// ── LANE-9: the accept that timed out ──────────────────────────────────────

test("an accept that timed out twice and was applied on the third try without an answer: Amboss showing the order waiting for its channel is the confirmation — one invoice, no further accept, said once, and the channel is opened", async (t) => {
  feeEnv(t);
  quiet(t);
  const saved = HTTP_TIMEOUTS.ambossAcceptMs;
  HTTP_TIMEOUTS.ambossAcceptMs = 60;
  t.after(() => {
    HTTP_TIMEOUTS.ambossAcceptMs = saved;
  });
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 6 * HOUR).toISOString() });
  s.magma.buyerPaidAmboss(sale.id);
  s.magma.behave.AcceptOrder = (n) => (n < 2 ? "hang" : "apply-then-hang");
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("AcceptOrder"), 3);
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_CHANNEL_OPEN");
  let e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "accepting");
  assert.match(e?.lastError ?? "", /^accept not confirmed /);
  await s.autopilot.pollSellOrders();
  // Before: only "waiting for the buyer's payment" was read as the accept
  // having arrived — the order stayed "accepting", "accept not confirmed" on
  // its record, and nothing was opened.
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.equal(e?.lastError, undefined);
  assert.equal(opens(s).length, 1);
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("AcceptOrder"), 3, "no accept after Amboss showed it accepted");
  assert.equal(s.node.callsTo("invoices.addHoldInvoice").length, 1, "one invoice for the order, whatever the accepts' answers");
  assert.equal(events(s, sale.id).filter((w) => w === "Amboss shows the order accepted").length, 1);
  assert.equal(opens(s).length, 1);
});

test("an invoice of ours that no accept of ours carried to Amboss is not opened for: the order was accepted elsewhere, and nothing would ever pay that invoice", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  // The process dies with the invoice made and the accept not yet sent…
  const reached = crashAt(s.desk, "lndCreateHodl", "after");
  void s.autopilot.pollSellOrders();
  await until(reached, "the invoice");
  assert.equal(entryOnDisk(s.dir, sale.id)?.acceptSentAt, undefined);
  // …and the order is accepted on Amboss's website meanwhile, with another invoice.
  const amboss = s.magma.sales.get(sale.id)!;
  amboss.status = "WAITING_FOR_CHANNEL_OPEN";
  const again = s.restart();
  for (let i = 0; i < 3; i++) await again.pollSellOrders();
  assert.equal(opens(s).length, 0);
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.decision?.reason, NOT_OUR_ACCEPT_WAIT);
  assert.equal(events(s, sale.id).filter((w) => w === NOT_OUR_ACCEPT_WAIT).length, 1, "said once");
  assert.ok(!events(s, sale.id).includes(HOLDS), "nothing says Amboss pays an invoice it does not have");
  // Market → Orders says whose click it waits for, and counts it as waiting on you.
  assert.equal(again.magma.opensItself(sale.id), false, "before: 'Paid — the autopilot opens the channel' for an order it never opens");
  // The operator knows where the payment went: their click opens.
  const clicked = await again.magma.open(sale.id);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.equal(opens(s).length, 1);
});

// ── the open that cannot be made, and its fee ──────────────────────────────

test("the buyer's node cannot be reached for as long as an open would still be in time: tried until six hours before Amboss's deadline, then the order ends — our invoice cancelled, the coins free, and the operator told that Amboss refunds the buyer", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  // Online when the order was accepted, gone since.
  s.node.peers.splice(s.node.peers.indexOf(BUYER), 1);
  s.node.override("default.connectPeer", (_a, cb) => cb({ details: "dial tcp: i/o timeout" }));
  const t0 = Date.now();
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 0);
  let e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "accepted");
  assert.match(e?.lastError ?? "", / — will try again$/);
  assert.ok(s.capital.reservedSat() > 0);
  // A day and a half on, still trying.
  t.mock.timers.enable({ apis: ["Date"], now: t0 + 36 * HOUR });
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
  assert.equal(s.node.invoices.get(hash)?.state, "OPEN");
  assert.deepEqual(magmaRefundAlerts(s.desk), []);
  // Amboss's deadline is 48 hours after the accept; a channel needs its
  // confirmations before it: no open is started in the last six hours.
  t.mock.timers.setTime(t0 + PREPAID_CHANNEL_WINDOW_MS - 6 * HOUR + 60_000);
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.match(e?.reason ?? "", /^the channel could not be opened in time — last tried: /);
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED", "Amboss can no longer pay for a channel that is not there");
  assert.equal(s.capital.reservedSat(), 0);
  assert.equal(opens(s).length, 0);
  const [alert] = magmaRefundAlerts(s.desk);
  assert.match(alert?.message ?? "", /^A 2,000,000 sat Magma order Amboss had taken the buyer's payment for ended with no channel opened: the channel could not be opened in time/);
  assert.match(alert?.message ?? "", /Nothing was paid to this node; Amboss refunds the buyer and may count the order against your seller score\./);
});

test("on-chain fees above what the sale earns: the unpaid order's open waits for lower fees, and from twelve hours before Amboss's deadline the channel is opened whatever the fee, at LND's three-block estimate", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  estimate(s, 400, 520);
  const t0 = Date.now();
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), []);
  assert.match(entryOnDisk(s.dir, sale.id)?.lastError ?? "", /^on-chain fees are 400 sat\/vB: .*; Amboss holds the buyer's payment, so the channel is opened whatever the fee from /);
  // Just before the forced open: still waiting.
  t.mock.timers.enable({ apis: ["Date"], now: t0 + PREPAID_CHANNEL_WINDOW_MS - 12 * HOUR - 10 * 60_000 });
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), []);
  // From six hours before the last moment to open: whatever the fee — a
  // sale this node accepted is to complete.
  t.mock.timers.setTime(t0 + PREPAID_CHANNEL_WINDOW_MS - 12 * HOUR + 60_000);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), [520], "LND's estimate for about three blocks: it is the confirmation that counts now");
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.ok(events(s, sale.id).includes("open started at 520 sat/vB"));
});

test("an invoice of ours that is for another amount than the order earns is not opened for", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  s.node.invoices.get(hash)!.mtokens = "999000";
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 0);
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "accepted");
  assert.equal(e?.lastError, "our invoice for this order is for 999 sat, not the 12,345 sat the order earns — no channel is opened; check the order");
  assert.equal(events(s, sale.id).filter((w) => w.startsWith("our invoice for this order is for 999 sat")).length, 1, "said once");
});

// ── LANE-13: what is claimed ───────────────────────────────────────────────

test("a payment is claimed only in full: Amboss reports the channel confirmed and our invoice holds less than the order earns — not settled, not booked", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  await s.autopilot.pollSellOrders();
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  s.node.payHoldInvoice(hash, { mtokens: "1000000" });
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.equal(e?.lastError, "Amboss reports VALID_CHANNEL_OPENING, but our invoice holds 1000 sat of the 12345 sat this order earns — not settled; check the order");
  assert.equal(s.node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(salesOnDisk(s.dir).length, 0);
  assert.equal(feesOnDisk(s.dir).length, 0);
});

test("a payment is claimed only for a channel LND shows: Amboss reports the channel confirmed, the payment is held, and LND no longer shows the channel that is on the order's record (opened here, its funding transaction gone since) — not settled", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  await s.autopilot.pollSellOrders();
  const outpoint = entryOnDisk(s.dir, sale.id)?.fundingOutpoint;
  // The funding transaction never made it (replaced, say): LND shows nothing.
  s.node.pending.splice(0);
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  s.node.payHoldInvoice(hash);
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.equal(e?.lastError, `Amboss reports VALID_CHANNEL_OPENING, but LND shows no channel ${outpoint} — the payment is not claimed; check the order`);
  assert.equal(s.node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
  assert.equal(salesOnDisk(s.dir).length, 0);
});

// ── Amboss ends the order after our open ───────────────────────────────────

test("Amboss turns the channel down after our open (INVALID_CHANNEL_OPENING): our invoice is cancelled so nothing can be paid for it later, the channel is left alone, and the operator is told it is theirs to close or keep", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  await s.autopilot.pollSellOrders();
  const outpoint = entryOnDisk(s.dir, sale.id)?.fundingOutpoint;
  assert.ok(outpoint);
  s.magma.setStatus(sale.id, "INVALID_CHANNEL_OPENING");
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.equal(e?.reason, `Amboss ended the order: INVALID_CHANNEL_OPENING — the channel ${outpoint} stays open; close it if you don't want it`);
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED");
  assert.equal(s.node.pending.filter((p) => p.partnerPublicKey === BUYER).length, 1, "the channel is not touched");
  assert.equal(s.node.callsTo("default.closeChannel").length, 0);
  assert.equal(s.capital.reservedSat(), 0);
  const [alert] = magmaUnpaidChannelAlerts(s.desk);
  assert.equal(alert?.id, `magma:${sale.id}`);
  assert.match(alert?.message ?? "", /^A 2,000,000 sat Magma order ended without payment after its channel was opened: Amboss ended the order: INVALID_CHANNEL_OPENING/);
  assert.match(alert?.message ?? "", new RegExp(`The channel ${outpoint} stays open and is yours: close it to take the capital back, or keep it for routing\\.$`));
  assert.deepEqual(magmaRefundAlerts(s.desk), [], "one alert for the order, and the one that names the channel");
  assert.equal(salesOnDisk(s.dir).length, 0);
});

// ── the other way, and the operator's own orders ───────────────────────────

test("an order whose buyer has yet to pay our invoice is not opened for: nothing is opened while Amboss waits for the buyer's payment", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(opens(s).length, 0);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
  assert.ok(!events(s, sale.id).includes(HOLDS));
});

test("selling switched off, the operator accepted by hand and Amboss holds the buyer's payment: the lane opens nothing and says what the order waits for; “Open channel” opens it — before, the click answered that the payment was not held yet", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  s.node.peers.push(BUYER);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  s.magma.buyerPaidAmboss(sale.id);
  await s.autopilot.pollSellOrders();
  const accepted = await s.autopilot.magma.accept(sale.id);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  for (let i = 0; i < 2; i++) await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 0, "the operator's order: their open");
  assert.equal(entryOnDisk(s.dir, sale.id)?.decision?.reason, "Amboss holds the buyer's payment — waiting for you to open the channel");
  const clicked = await s.autopilot.magma.open(sale.id);
  assert.equal(clicked.ok, true, JSON.stringify(clicked));
  assert.equal(opens(s).length, 1);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "reported");
  const again = await s.autopilot.magma.open(sale.id);
  assert.equal(again.ok, true);
  assert.equal(opens(s).length, 1, "a second click opens nothing");
});

// ── review of P1b, R1: two orders of one buyer and one channel opened by hand ─

/** Two 2,000,000 sat orders of one buyer who paid Amboss up front, both
 *  accepted by the lane; from here on-chain fees are above what a sale earns,
 *  so the lane opens nothing by itself. */
async function twoPrepaidOrders(t: TestContext) {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  const o1 = s.magma.addSale({ buyerPubkey: BUYER });
  const o2 = s.magma.addSale({ buyerPubkey: BUYER });
  s.magma.buyerPaidAmboss(o1.id);
  s.magma.buyerPaidAmboss(o2.id);
  await s.autopilot.pollSellOrders();
  const a1 = s.magma.sales.get(o1.id)!;
  const a2 = s.magma.sales.get(o2.id)!;
  assert.deepEqual([a1.status, a2.status], ["WAITING_FOR_CHANNEL_OPEN", "WAITING_FOR_CHANNEL_OPEN"]);
  estimate(s, 400);
  return { s, o1, o2, a1, a2 };
}

/** The lane walks the order with the earlier deadline first: `first` is it. */
function walkedFirst(first: { timeout: string | null }, second: { timeout: string | null }): void {
  const base = Date.now() + 47 * HOUR;
  first.timeout = new Date(base).toISOString();
  second.timeout = new Date(base + HOUR).toISOString();
}

for (const [reportedIs, namedBy] of [
  ["later", "its transaction"],
  ["earlier", "its transaction"],
  ["later", "its channel id"],
] as const) {
  test(`two orders of one buyer wait for lower fees, the operator opens one channel by hand and reports it on Amboss for the order with the ${reportedIs} deadline (Amboss names it by ${namedBy}): the channel is that order's, the other order takes nothing and gets its own channel from the lane, and two sales are booked for two channels — before, the order the lane walked first took the channel Amboss names for the other`, async (t) => {
    const { s, o1, o2, a1, a2 } = await twoPrepaidOrders(t);
    if (reportedIs === "later") walkedFirst(a2, a1);
    else walkedFirst(a1, a2);
    for (let i = 0; i < 2; i++) await s.autopilot.pollSellOrders();
    assert.equal(opens(s).length, 0);
    // By hand: one channel, reported on Amboss's website for the first order.
    const txid = "cd".repeat(32);
    if (namedBy === "its transaction") {
      s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
      a1.transactionId = `${txid}:0`;
    } else {
      const channelId = `${s.node.blockHeight - 1}x7x0`;
      s.node.channels.push({ id: channelId, partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 2_000_000, transactionId: txid, transactionVout: 0 });
      a1.channelId = channelId;
    }
    a1.status = "SELLER_SENT_TRANSACTION";
    for (let i = 0; i < 2; i++) await s.autopilot.pollSellOrders();
    let e1 = entryOnDisk(s.dir, o1.id);
    let e2 = entryOnDisk(s.dir, o2.id);
    assert.deepEqual([e1?.phase, e1?.fundingOutpoint], ["reported", `${txid}:0`], "the order Amboss names the channel for has it");
    assert.deepEqual([e2?.phase, e2?.fundingOutpoint], ["accepted", undefined], "the other order took nothing");
    assert.ok(!events(s, o2.id).some((w) => /opened outside LightningMate/.test(w)));
    assert.equal(s.magma.count("AddTransaction"), 0, "nothing was reported to Amboss for the other order");
    assert.equal(a2.transactionId, null);
    assert.equal(opens(s).length, 0, "fees are still above what the sale earns");
    // Fees fall: the other order gets a channel of its own.
    estimate(s, 1);
    for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
    assert.equal(opens(s).length, 1, "one open: for the order that had no channel");
    e1 = entryOnDisk(s.dir, o1.id);
    e2 = entryOnDisk(s.dir, o2.id);
    assert.equal(e1?.fundingOutpoint, `${txid}:0`);
    assert.equal(e2?.phase, "reported");
    assert.ok(e2?.fundingOutpoint && e2.fundingOutpoint !== `${txid}:0`, "its own channel");
    assert.equal(a2.transactionId, e2?.fundingOutpoint);
    assert.equal(s.magma.count("AddTransaction"), 1);
    // Amboss confirms both and pays both: two sales, each with its channel.
    s.magma.setStatus(o1.id, "VALID_CHANNEL_OPENING");
    s.magma.setStatus(o2.id, "VALID_CHANNEL_OPENING");
    await s.autopilot.pollSellOrders();
    s.magma.ambossPays(o1.id, s.node);
    s.magma.ambossPays(o2.id, s.node);
    for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
    assert.deepEqual([entryOnDisk(s.dir, o1.id)?.phase, entryOnDisk(s.dir, o2.id)?.phase], ["settled", "settled"]);
    assert.deepEqual(
      salesOnDisk(s.dir)
        .map((x) => x.orderId)
        .sort(),
      [o1.id, o2.id].sort(),
    );
    assert.equal(feesOnDisk(s.dir).length, 2);
    assert.equal(s.node.callsTo("invoices.settleInvoice").length, 2);
    assert.equal(opens(s).length, 1);
  });
}

test("a channel opened by hand is not taken for an order while another order of the same buyer cannot be read from Amboss — it may be that order's: nothing is taken or opened, the record says why, and the next pass looks again", async (t) => {
  const { s, o1, o2, a1, a2 } = await twoPrepaidOrders(t);
  walkedFirst(a2, a1);
  await s.autopilot.pollSellOrders();
  const txid = "cd".repeat(32);
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
  a1.transactionId = `${txid}:0`;
  a1.status = "SELLER_SENT_TRANSACTION";
  // Fees are low again — and Amboss does not answer for the order the
  // channel was reported for.
  estimate(s, 1);
  let down = true;
  readsHang(s.autopilot, (id) => down && id === o1.id);
  await s.autopilot.pollSellOrders();
  let e2 = entryOnDisk(s.dir, o2.id);
  assert.equal(opens(s).length, 0, "no second channel beside one that may be the other order's");
  assert.deepEqual([e2?.phase, e2?.fundingOutpoint], ["accepted", undefined]);
  assert.equal(s.magma.count("AddTransaction"), 0);
  assert.equal(
    e2?.lastError,
    `a channel to the buyer was opened outside LightningMate (${txid}:0), and order ${o1.id} of the same buyer could not be read from Amboss ` +
      "(Amboss request to magma.amboss.tech timed out after 15s) — it may be that order's: nothing is taken or opened for this order now; looked at again on the next pass",
  );
  assert.ok(s.capital.reservedSat() > 0, "its coins stay promised");
  down = false;
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  const e1 = entryOnDisk(s.dir, o1.id);
  e2 = entryOnDisk(s.dir, o2.id);
  assert.deepEqual([e1?.phase, e1?.fundingOutpoint], ["reported", `${txid}:0`]);
  assert.equal(e2?.phase, "reported");
  assert.ok(e2?.fundingOutpoint && e2.fundingOutpoint !== `${txid}:0`);
  assert.equal(e2?.lastError, undefined);
  assert.equal(opens(s).length, 1);
});

test("the operator opens both orders' channels in one transaction and reports one output on Amboss for one of them: the other output is not that order's — the lane takes it for the second order and reports it, and nothing is opened", async (t) => {
  const { s, o1, o2, a1, a2 } = await twoPrepaidOrders(t);
  walkedFirst(a2, a1);
  const txid = "cd".repeat(32);
  for (const transactionVout of [0, 1]) s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout });
  a1.transactionId = `${txid}:0`;
  a1.status = "SELLER_SENT_TRANSACTION";
  await s.autopilot.pollSellOrders();
  // In the one pass, and walked before the order Amboss names an output for:
  // the first output is left to that order, the look goes on to the second —
  // the order does not wait a pass for it, and a transaction is not taken as
  // one channel.
  assert.equal(entryOnDisk(s.dir, o2.id)?.fundingOutpoint, `${txid}:1`, "taken in the pass that found the first output named for the other order");
  await s.autopilot.pollSellOrders();
  const e1 = entryOnDisk(s.dir, o1.id);
  const e2 = entryOnDisk(s.dir, o2.id);
  assert.deepEqual([e1?.phase, e1?.fundingOutpoint], ["reported", `${txid}:0`], "the output Amboss names for it");
  assert.deepEqual([e2?.phase, e2?.fundingOutpoint, e2?.lastError], ["reported", `${txid}:1`, undefined], "the other output: the look went on past the first order's");
  assert.equal(a2.transactionId, `${txid}:1`);
  assert.deepEqual([opens(s).length, s.magma.count("AddTransaction")], [0, 1]);
});

test("a channel opened by hand is taken for the one order it can be for: Amboss not answering for an order of the same buyer that has its channel, or for an order of another buyer, does not stand in the way", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  const other = `03${"5e".repeat(32)}`;
  const [o1, o2, o3] = [BUYER, BUYER, other].map((buyerPubkey) => s.magma.addSale({ buyerPubkey }));
  for (const o of [o1, o2, o3]) s.magma.buyerPaidAmboss(o.id);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(
    [o1, o2, o3].map((o) => entryOnDisk(s.dir, o.id)?.phase),
    ["accepted", "accepted", "accepted"],
  );
  estimate(s, 400);
  // The first order's channel: opened by hand and reported on Amboss.
  const a1 = s.magma.sales.get(o1.id)!;
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: "cd".repeat(32), transactionVout: 0 });
  a1.transactionId = `${"cd".repeat(32)}:0`;
  a1.status = "SELLER_SENT_TRANSACTION";
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, o1.id)?.fundingOutpoint, `${"cd".repeat(32)}:0`);
  // The second order's: opened by hand, not reported — while Amboss answers
  // for neither of the other two orders.
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: "ef".repeat(32), transactionVout: 0 });
  readsHang(s.autopilot, (id) => id !== o2.id);
  await s.autopilot.pollSellOrders();
  const e2 = entryOnDisk(s.dir, o2.id);
  assert.deepEqual([e2?.phase, e2?.fundingOutpoint, e2?.lastError], ["reported", `${"ef".repeat(32)}:0`, undefined]);
  assert.equal(s.magma.sales.get(o2.id)?.transactionId, `${"ef".repeat(32)}:0`);
  assert.equal(opens(s).length, 0);
});

test("Amboss names one channel for two orders of one buyer: the channel is the first order's; nothing is opened for the second and its payment is not claimed for a channel on another sale's record — before, both were settled and booked for the one channel", async (t) => {
  const { s, o1, o2, a1, a2 } = await twoPrepaidOrders(t);
  await s.autopilot.pollSellOrders();
  const txid = "ab".repeat(32);
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
  a1.transactionId = `${txid}:0`;
  a1.status = "SELLER_SENT_TRANSACTION";
  for (let i = 0; i < 2; i++) await s.autopilot.pollSellOrders();
  a2.transactionId = `${txid}:0`;
  a2.status = "SELLER_SENT_TRANSACTION";
  estimate(s, 1);
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  let e2 = entryOnDisk(s.dir, o2.id);
  assert.equal(entryOnDisk(s.dir, o1.id)?.fundingOutpoint, `${txid}:0`);
  assert.deepEqual([e2?.phase, e2?.fundingOutpoint], ["accepted", undefined]);
  const notOpened = `Amboss names ${txid}:0 for this order, a channel on record here as another sale's — nothing is opened for this order; check both orders on Amboss`;
  assert.equal(e2?.lastError, notOpened);
  assert.equal(events(s, o2.id).filter((w) => w === notOpened).length, 1, "said once");
  assert.equal(opens(s).length, 0, "Amboss has a transaction for the order: nothing is opened");
  // Amboss shows both confirmed and pays both invoices.
  a1.status = "VALID_CHANNEL_OPENING";
  a2.status = "VALID_CHANNEL_OPENING";
  s.magma.ambossPays(o1.id, s.node);
  const hash2 = s.magma.ambossPays(o2.id, s.node);
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, o1.id)?.phase, "settled");
  e2 = entryOnDisk(s.dir, o2.id);
  assert.deepEqual([e2?.phase, e2?.fundingOutpoint], ["accepted", undefined]);
  assert.equal(
    e2?.lastError,
    `Amboss reports VALID_CHANNEL_OPENING, but the channel Amboss names for this order (${txid}:0) is on record here as another sale's — the payment is not claimed; check both orders on Amboss`,
  );
  assert.equal(s.node.invoices.get(hash2)?.state, "ACCEPTED", "held, not claimed");
  assert.deepEqual(
    salesOnDisk(s.dir).map((x) => x.orderId),
    [o1.id],
    "one channel, one sale",
  );
  assert.equal(feesOnDisk(s.dir).length, 1);
  assert.equal(s.node.callsTo("invoices.settleInvoice").length, 1);
  assert.equal(opens(s).length, 0);
});

// ── review of P1b, R2: no channel on the order's record, no claim ──────────

test("a payment is claimed only for a channel on the order's record: Amboss reports the order confirmed and names a transaction LND knows nothing of, our invoice holds the fee, and nothing was opened here — not settled, not booked, said once; when LND shows the channel it is taken and the payment claimed — before, the sale was settled and booked with no channel at all", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  estimate(s, 400);
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 0);
  const txid = "77".repeat(32);
  const amboss = s.magma.sales.get(sale.id)!;
  amboss.transactionId = `${txid}:0`;
  amboss.status = "VALID_CHANNEL_OPENING";
  s.node.payHoldInvoice(hash);
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  let e = entryOnDisk(s.dir, sale.id);
  const notClaimed = `Amboss reports VALID_CHANNEL_OPENING, but LND shows no channel of this node to the buyer for what Amboss names (${txid}:0) — the payment is not claimed; check the order`;
  assert.deepEqual([e?.phase, e?.fundingOutpoint], ["accepted", undefined]);
  assert.equal(e?.lastError, notClaimed);
  assert.equal(events(s, sale.id).filter((w) => w === notClaimed).length, 1, "said once");
  assert.equal(events(s, sale.id).filter((w) => /no funding outpoint is on record/.test(w)).length, 0, "and not a line on every pass beside it");
  assert.equal(s.node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
  assert.equal(salesOnDisk(s.dir).length, 0);
  assert.equal(feesOnDisk(s.dir).length, 0);
  assert.equal(opens(s).length, 0);
  // The channel Amboss names shows up in LND (opened by hand, its
  // transaction seen late): taken, and the payment is claimed for it.
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["settled", `${txid}:0`, undefined]);
  assert.equal(s.node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(salesOnDisk(s.dir).length, 1);
  assert.equal(opens(s).length, 0);
});

/** LND fails the one read the look for the channel Amboss names makes
 *  (adoptReportedChannel) — the first time that look is made, and only then.
 *  Returns how often it failed. */
function firstLookFails(s: Setup): () => number {
  const node = s.node as unknown as { pendingRpc(): unknown };
  const desk = s.desk as unknown as { adoptReportedChannel: (...a: unknown[]) => Promise<unknown> };
  const real = desk.adoptReportedChannel.bind(s.desk);
  let looks = 0;
  let failing = false;
  let failed = 0;
  desk.adoptReportedChannel = async (...a) => {
    failing = looks++ === 0;
    try {
      return await real(...a);
    } finally {
      failing = false;
    }
  };
  s.node.override("default.pendingChannels", (_a, cb) => {
    if (!failing) return cb(null, node.pendingRpc());
    failed++;
    cb({ details: "unavailable", code: 14 });
  });
  return () => failed;
}

test("LND does not answer when the channel Amboss names is looked for: nothing is settled without it and nothing is said — the next pass finds the channel, takes it and claims the payment; before, the sale was settled with no channel on its record", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  // Opened by hand, reported, confirmed and paid before the lane's next pass.
  const txid = "cd".repeat(32);
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
  const amboss = s.magma.sales.get(sale.id)!;
  amboss.transactionId = `${txid}:0`;
  amboss.status = "VALID_CHANNEL_OPENING";
  s.node.payHoldInvoice(hash);
  const failed = firstLookFails(s);
  await s.autopilot.pollSellOrders();
  assert.equal(failed(), 1, "LND did not answer the look");
  let e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["accepted", undefined, undefined]);
  assert.ok(!events(s, sale.id).some((w) => /no funding outpoint|not claimed|does not show/.test(w)), "not found is not what happened");
  assert.equal(s.node.callsTo("invoices.settleInvoice").length, 0);
  assert.equal(salesOnDisk(s.dir).length, 0);
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.fundingOutpoint], ["settled", `${txid}:0`]);
  assert.equal(salesOnDisk(s.dir).length, 1);
  assert.equal(opens(s).length, 0);
});

test("LND does not answer when the channel Amboss shows as sent is looked for: that is not “LND does not show it” — nothing is said, nothing is opened, and the next pass takes the channel as the order's", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  const txid = "cd".repeat(32);
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
  const amboss = s.magma.sales.get(sale.id)!;
  amboss.transactionId = `${txid}:0`;
  amboss.status = "SELLER_SENT_TRANSACTION";
  const failed = firstLookFails(s);
  await s.autopilot.pollSellOrders();
  assert.equal(failed(), 1, "LND did not answer the look");
  let e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["accepted", undefined, undefined]);
  assert.ok(!events(s, sale.id).some((w) => /does not show|another sale/.test(w)), "not found is not what happened");
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["reported", `${txid}:0`, undefined]);
  assert.deepEqual([opens(s).length, s.magma.count("AddTransaction")], [0, 0]);
});

test("Amboss reports an order confirmed and names no channel for it, our invoice holds the fee, and nothing was opened here: the payment is not claimed for a sale without a channel, and the record says once that Amboss names none", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  estimate(s, 400);
  s.magma.sales.get(sale.id)!.status = "VALID_CHANNEL_OPENING";
  s.node.payHoldInvoice(hash);
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  const notClaimed = "Amboss reports VALID_CHANNEL_OPENING, but no channel is on record here for this order and Amboss names none — the payment is not claimed; check the order";
  assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["accepted", undefined, notClaimed]);
  assert.equal(events(s, sale.id).filter((w) => w === notClaimed).length, 1, "said once");
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED", "held, not claimed");
  assert.deepEqual([s.node.callsTo("invoices.settleInvoice").length, salesOnDisk(s.dir).length, feesOnDisk(s.dir).length, opens(s).length], [0, 0, 0, 0]);
});

/** LND's record of a closed channel to the buyer at `txid:0`. */
const closedChannel = (txid: string, over: Record<string, unknown> = {}) => ({
  alias_scids: [],
  capacity: "2000000",
  chan_id: chanNumber("850000x9x0"),
  channel_point: `${txid}:0`,
  close_height: 860_000,
  closing_tx_hash: "98".repeat(32),
  remote_pubkey: BUYER,
  settled_balance: "1990000",
  time_locked_balance: "0",
  close_type: "COOPERATIVE_CLOSE",
  open_initiator: "INITIATOR_LOCAL",
  close_initiator: "INITIATOR_REMOTE",
  resolutions: [],
  zero_conf_confirmed_scid: "0",
  ...over,
});

const CLOSED_TX = "cd".repeat(32);

for (const [what, over, taken, named] of [
  ["a channel of this node to the buyer that is closed by now", {}, true, `${CLOSED_TX}:0`],
  ["such a channel, which Amboss names by its channel id alone", {}, true, "850000x9x0"],
  ["a closed channel the buyer had opened", { open_initiator: "INITIATOR_REMOTE" }, false, `${CLOSED_TX}:0`],
  ["a funding that was cancelled and never became a channel", { close_type: "FUNDING_CANCELED" }, false, `${CLOSED_TX}:0`],
  ["a closed channel to another node", { remote_pubkey: `03${"5e".repeat(32)}` }, false, `${CLOSED_TX}:0`],
  ["a closed channel at another output of the transaction Amboss names", { channel_point: `${CLOSED_TX}:1` }, false, `${CLOSED_TX}:0`],
] as const) {
  test(`the channel Amboss names for a confirmed order is looked for among LND's closed channels too — ${what}: ${taken ? "taken as the order's, the payment claimed and the sale booked" : "not taken, the payment not claimed"}`, async (t) => {
    const { s, sale, hash } = await prepaidOrder(t);
    estimate(s, 400);
    const txid = CLOSED_TX;
    s.node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [closedChannel(txid, over)] }));
    const amboss = s.magma.sales.get(sale.id)!;
    if (named.includes(":")) amboss.transactionId = named;
    else amboss.channelId = named;
    amboss.status = "VALID_CHANNEL_OPENING";
    s.node.payHoldInvoice(hash);
    for (let i = 0; i < 2; i++) await s.autopilot.pollSellOrders();
    const e = entryOnDisk(s.dir, sale.id);
    assert.equal(opens(s).length, 0);
    if (taken) {
      assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["settled", `${txid}:0`, undefined]);
      assert.ok(events(s, sale.id).includes(`its channel ${txid}:0 was opened outside LightningMate and is closed by now — taken from Amboss and LND`));
      assert.equal(s.node.invoices.get(hash)?.state, "SETTLED");
      assert.equal(salesOnDisk(s.dir).length, 1);
      return;
    }
    assert.deepEqual([e?.phase, e?.fundingOutpoint], ["accepted", undefined]);
    assert.equal(
      e?.lastError,
      `Amboss reports VALID_CHANNEL_OPENING, but LND shows no channel of this node to the buyer for what Amboss names (${named}) — the payment is not claimed; check the order`,
    );
    assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
    assert.equal(s.node.callsTo("invoices.settleInvoice").length, 0);
    assert.equal(salesOnDisk(s.dir).length, 0);
  });
}

test("the channel Amboss names for a confirmed order is closed by now and on the record of an earlier sale to the same buyer: it stays that sale's — not taken for this order, its payment not claimed", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  await s.autopilot.pollSellOrders();
  const outpoint = entryOnDisk(s.dir, sale.id)?.fundingOutpoint;
  assert.ok(outpoint, "the lane opened the first order's channel");
  const second = s.magma.addSale({ buyerPubkey: BUYER });
  s.magma.buyerPaidAmboss(second.id);
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, second.id)?.phase, "accepted");
  estimate(s, 400);
  // The first sale's channel is closed; Amboss names it for the second order,
  // shows that order confirmed and pays its invoice.
  s.node.pending.splice(0);
  s.node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [closedChannel(CLOSED_TX, { channel_point: outpoint })] }));
  const amboss = s.magma.sales.get(second.id)!;
  amboss.transactionId = outpoint;
  amboss.status = "VALID_CHANNEL_OPENING";
  const hash = s.magma.ambossPays(second.id, s.node);
  for (let i = 0; i < 2; i++) await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, second.id);
  assert.deepEqual([e?.phase, e?.fundingOutpoint], ["accepted", undefined]);
  assert.match(e?.lastError ?? "", /^Amboss reports VALID_CHANNEL_OPENING, but .* — the payment is not claimed; check /);
  assert.equal(entryOnDisk(s.dir, sale.id)?.fundingOutpoint, outpoint, "the earlier sale keeps its channel");
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED", "held, not claimed");
  assert.deepEqual([s.node.callsTo("invoices.settleInvoice").length, salesOnDisk(s.dir).length, opens(s).length], [0, 0, 1]);
});

// ── review of P1b, R3 to R7: the guards of the unpaid open, each held by a test ─
//
// The review's mutation run left these in place with nothing failing: the
// look at Amboss and at LND before an open (never a second channel), which
// channel Amboss names is taken, the invoice an unpaid open goes by, and the
// open that is tried again. The code was right by the review's probes; from
// here on a change to it shows.

/** Runs `hook` each time the lane dials the buyer for an open — the moment
 *  between the pass's read of the order and the open itself, in which the
 *  operator may open by hand, report the channel on amboss.tech, or Amboss
 *  may end the order. */
function duringDial(s: Setup, hook: () => void): void {
  const desk = s.desk as unknown as { lndConnect: (...a: unknown[]) => Promise<boolean> };
  const real = desk.lndConnect.bind(s.desk);
  desk.lndConnect = async (...a) => {
    hook();
    return real(...a);
  };
}

const NOT_SHOWN = (named: string) =>
  `Amboss already has a funding transaction for this order (${named}) that LND does not show as a channel of this node to the buyer — nothing is opened; check the order`;

test("Amboss has a funding transaction for an order still waiting for its channel, and LND shows no such channel: nothing is opened pass after pass, the record says so once, and the buyer is not even dialed for an open", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  const named = `${"99".repeat(32)}:0`;
  s.magma.sales.get(sale.id)!.transactionId = named;
  let dials = 0;
  duringDial(s, () => void dials++);
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(opens(s).length, 0, "never a second channel beside one Amboss has a transaction for");
  assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["accepted", undefined, NOT_SHOWN(named)]);
  assert.equal(events(s, sale.id).filter((w) => w === NOT_SHOWN(named)).length, 1, "said once");
  // The look before the open stops it — not the order's second read, after
  // the fee check and the dial.
  assert.equal(dials, 0);
  assert.ok(!events(s, sale.id).some((w) => /^not opened: Amboss shows the order as/.test(w)));
  assert.equal(s.magma.count("AddTransaction"), 0);
  assert.ok(s.capital.reservedSat() > 0, "its coins stay promised");
});

for (const [what, change, said, after] of [
  [
    "the channel is reported on amboss.tech, which LND does not show yet",
    (amboss: { transactionId: string | null; status: string }) => void (amboss.transactionId = `${"98".repeat(32)}:0`),
    "not opened: Amboss shows the order as WAITING_FOR_CHANNEL_OPEN with a channel by now — looked at again on the next pass",
    "accepted",
  ],
  [
    "Amboss ends the order",
    (amboss: { transactionId: string | null; status: string }) => void (amboss.status = "ADMIN_CLOSED"),
    "not opened: Amboss shows the order as ADMIN_CLOSED by now — looked at again on the next pass",
    "cancelled",
  ],
] as const) {
  test(`while the lane dials the buyer for the open, ${what}: the order is read from Amboss again before the open, and nothing is opened — in that pass or a later one`, async (t) => {
    const { s, sale, hash } = await prepaidOrder(t);
    const amboss = s.magma.sales.get(sale.id)!;
    let dials = 0;
    duringDial(s, () => {
      if (dials++ === 0) change(amboss);
    });
    await s.autopilot.pollSellOrders();
    assert.equal(dials, 1, "the buyer was dialed: fee and capital allowed the open");
    assert.equal(opens(s).length, 0, "what the pass read at its start is no longer how Amboss has the order");
    assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
    assert.equal(events(s, sale.id).filter((w) => w === said).length, 1);
    for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
    assert.equal(opens(s).length, 0);
    assert.equal(dials, 1, "not dialed again either");
    const e = entryOnDisk(s.dir, sale.id);
    assert.equal(e?.phase, after);
    assert.equal(e?.fundingOutpoint, undefined);
    if (after === "accepted") {
      assert.equal(e?.lastError, NOT_SHOWN(amboss.transactionId!));
      assert.equal(s.node.invoices.get(hash)?.state, "OPEN");
    } else {
      assert.equal(s.node.invoices.get(hash)?.state, "CANCELED", "an order Amboss ended is not to be paid for");
      assert.equal(s.capital.reservedSat(), 0);
    }
  });
}

test("Amboss does not answer the read of the order that comes before the open: nothing is opened on an order this node cannot see, the record says it will be tried again, and the next pass opens", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  // Amboss answers the pass's first read of the order, and no longer once
  // the buyer is dialed.
  let failing = true;
  let down = false;
  let failed = 0;
  duringDial(s, () => void (down = failing));
  readsHang(s.autopilot, () => {
    if (down) failed++;
    return down;
  });
  await s.autopilot.pollSellOrders();
  assert.equal(failed, 1, "the one read between the dial and the open");
  assert.equal(opens(s).length, 0, "not opened on what the pass had read before the dial");
  let e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual(
    [e?.phase, e?.lastError],
    ["accepted", "could not read the order from Amboss again before the open (Amboss request to magma.amboss.tech timed out after 15s) — will try again"],
  );
  assert.ok(s.capital.reservedSat() > 0);
  failing = down = false;
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(opens(s).length, 1);
  assert.deepEqual([e?.phase, e?.lastError], ["reported", undefined]);
});

test("“Open channel” for an order whose buyer has not paid anyone yet (Amboss waits for the buyer's payment): refused as not ready — the buyer is not dialed, nothing is opened, nothing is written on the order's record", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  s.node.peers.push(BUYER);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
  let dials = 0;
  duringDial(s, () => void dials++);
  const before = events(s, sale.id);
  const clicked = await s.autopilot.magma.open(sale.id);
  assert.deepEqual([clicked.ok, clicked.code, clicked.message], [false, "bad_status", "Order is WAITING_FOR_BUYER_PAYMENT, not ready for a channel."]);
  assert.equal(dials, 0);
  assert.equal(opens(s).length, 0);
  assert.deepEqual(events(s, sale.id), before);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
});

test("the operator opens the channel by hand while the lane dials the buyer for the same open, and has not reported it yet: LND is looked at once more under the lock no other open runs in — the channel is taken as the order's and reported, no second one is opened", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  const txid = "ef".repeat(32);
  let dials = 0;
  duringDial(s, () => {
    if (dials++ === 0) s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
  });
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  assert.equal(dials, 1);
  assert.equal(opens(s).length, 0, "one channel for one order");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["reported", `${txid}:0`, undefined]);
  assert.ok(events(s, sale.id).includes(`a channel to the buyer was opened outside LightningMate (${txid}:0) — taken as this order's`));
  assert.equal(s.magma.count("AddTransaction"), 1);
  assert.equal(s.magma.sales.get(sale.id)?.transactionId, `${txid}:0`, "Amboss has the outpoint");
  assert.equal(s.capital.reservedSat(), 0, "the coins are in the channel");
});

test("an order waits for lower on-chain fees and the operator opens its channel by hand without reporting it: the lane takes the channel on its next pass and reports it — it does not wait for fees to fall before it looks at LND", async (t) => {
  const { s, sale } = await prepaidOrder(t);
  estimate(s, 400);
  await s.autopilot.pollSellOrders();
  assert.match(entryOnDisk(s.dir, sale.id)?.lastError ?? "", /waiting for lower fees/);
  let dials = 0;
  duringDial(s, () => void dials++);
  const txid = "ef".repeat(32);
  s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, transactionVout: 0 });
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["reported", `${txid}:0`, undefined]);
  assert.equal(s.magma.count("AddTransaction"), 1);
  assert.equal(s.magma.sales.get(sale.id)?.transactionId, `${txid}:0`);
  assert.deepEqual([opens(s).length, dials], [0, 0], "found before the fee check and the dial");
});

for (const [what, shown, namedBy] of [
  ["a channel the buyer opened to this node", { transactionVout: 0, partnerInitiated: true }, "its transaction"],
  ["another output of the transaction Amboss names", { transactionVout: 1 }, "its transaction"],
  ["an open channel the buyer opened to this node, which Amboss names by its channel id", { transactionVout: 0, partnerInitiated: true }, "its channel id"],
] as const) {
  test(`Amboss shows an order's channel as sent, and what LND shows for it is ${what}: not taken as the order's — nothing recorded, nothing opened, said once`, async (t) => {
    const { s, sale } = await prepaidOrder(t);
    estimate(s, 400);
    const txid = "cd".repeat(32);
    const amboss = s.magma.sales.get(sale.id)!;
    let named = `${txid}:0`;
    if (namedBy === "its transaction") {
      s.node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: txid, ...shown });
      amboss.transactionId = named;
    } else {
      named = `${s.node.blockHeight - 1}x7x0`;
      s.node.channels.push({ id: named, partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 0, transactionId: txid, ...shown });
      amboss.channelId = named;
    }
    amboss.status = "SELLER_SENT_TRANSACTION";
    for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
    const e = entryOnDisk(s.dir, sale.id);
    assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["accepted", undefined, NOT_SHOWN(named)]);
    assert.equal(events(s, sale.id).filter((w) => w === NOT_SHOWN(named)).length, 1, "said once");
    assert.equal(opens(s).length, 0);
    assert.equal(s.magma.count("AddTransaction"), 0);
  });
}

for (const namedBy of ["its transaction", "its channel id"] as const) {
  test(`Amboss shows an order's channel as sent and names — by ${namedBy} — the channel the lane opened for an earlier order of the same buyer: that channel stays the earlier sale's — nothing is recorded or opened for this order, and its record says whose the channel is`, async (t) => {
    const { s, sale } = await prepaidOrder(t);
    await s.autopilot.pollSellOrders();
    const first = entryOnDisk(s.dir, sale.id);
    assert.equal(first?.phase, "reported");
    const outpoint = first!.fundingOutpoint!;
    // A second order of the buyer, accepted; then fees rise above what it earns.
    const second = s.magma.addSale({ buyerPubkey: BUYER });
    s.magma.buyerPaidAmboss(second.id);
    await s.autopilot.pollSellOrders();
    assert.equal(entryOnDisk(s.dir, second.id)?.phase, "accepted");
    estimate(s, 400);
    const amboss = s.magma.sales.get(second.id)!;
    let named = outpoint;
    if (namedBy === "its transaction") amboss.transactionId = outpoint;
    else {
      // The earlier sale's channel is open by now, and Amboss names its id.
      const [txid, vout] = outpoint.split(":");
      named = `${s.node.blockHeight - 1}x7x0`;
      s.node.pending.splice(0);
      s.node.channels.push({ id: named, partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 2_000_000, transactionId: txid, transactionVout: Number(vout) });
      amboss.channelId = named;
    }
    amboss.status = "SELLER_SENT_TRANSACTION";
    for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
    const e = entryOnDisk(s.dir, second.id);
    const anothers = `Amboss names ${named} for this order, a channel on record here as another sale's — nothing is opened for this order; check both orders on Amboss`;
    assert.deepEqual([e?.phase, e?.fundingOutpoint, e?.lastError], ["accepted", undefined, anothers]);
    assert.equal(events(s, second.id).filter((w) => w === anothers).length, 1, "said once");
    assert.equal(entryOnDisk(s.dir, sale.id)?.fundingOutpoint, outpoint);
    assert.equal(opens(s).length, 1, "the first order's open, no other");
    assert.equal(s.magma.count("AddTransaction"), 1);
  });
}

for (const when of ["before the lane's pass", "while the lane dials the buyer for the open"] as const) {
  test(`our invoice for an order Amboss holds the payment of is cancelled ${when}: no channel is opened for an order that can no longer be paid — it ends, its coins are free, and the record says why`, async (t) => {
    const { s, sale, hash } = await prepaidOrder(t);
    const cancel = () => void (s.node.invoices.get(hash)!.state = "CANCELED");
    let dials = 0;
    duringDial(s, () => {
      if (dials++ === 0 && when !== "before the lane's pass") cancel();
    });
    if (when === "before the lane's pass") cancel();
    await s.autopilot.pollSellOrders();
    const e = entryOnDisk(s.dir, sale.id);
    assert.equal(opens(s).length, 0);
    assert.equal(dials, when === "before the lane's pass" ? 0 : 1);
    assert.deepEqual(
      [e?.phase, e?.reason],
      ["cancelled", when === "before the lane's pass" ? "the invoice expired or was cancelled before it was paid" : "our invoice can no longer be paid (canceled)"],
    );
    assert.equal(s.capital.reservedSat(), 0);
    await s.autopilot.pollSellOrders();
    assert.equal(opens(s).length, 0);
  });
}

test("our invoice for an order Amboss holds the payment of holds a part of the fee only: no channel is opened for a part payment, the payment is not taken for the order's, and the record says once what is held and what is owed", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  s.node.payHoldInvoice(hash, { mtokens: "1000000" });
  for (let i = 0; i < 3; i++) await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  const part = "our invoice holds 1,000 sat of the 12,345 sat this order earns — no channel is opened; check the order";
  assert.equal(opens(s).length, 0);
  assert.deepEqual([e?.phase, e?.heldAt, e?.lastError], ["accepted", undefined, part]);
  assert.equal(events(s, sale.id).filter((w) => w === part).length, 1, "said once");
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED", "neither claimed nor sent back by the lane");
  assert.equal(s.node.callsTo("invoices.settleInvoice").length, 0);
});

test("the buyer's node refuses the channel of an order Amboss holds the payment of (a size it does not take): the order is not ended for it — the open is tried again, not before the wait between two tries is over, until six hours before Amboss's deadline; then the order ends with what was last tried", async (t) => {
  const { s, sale, hash } = await prepaidOrder(t);
  s.node.openFailure = "remote peer rejected the channel: chan size of 0.02 BTC is below min chan size of 0.05 BTC";
  const t0 = Date.now();
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 1);
  let e = entryOnDisk(s.dir, sale.id);
  // A paid order ends here, the buyer refunded (magmaLifecycle: "the open
  // fails after the buyer paid"). Nothing of the buyer's is held here.
  assert.equal(e?.phase, "accepted");
  assert.match(e?.lastError ?? "", /chan size of 0\.02 BTC is below min chan size of 0\.05 BTC.* — will try again$/);
  const refused = e!.lastError!;
  assert.equal(s.node.invoices.get(hash)?.state, "OPEN");
  assert.ok(s.capital.reservedSat() > 0);
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 1, "not asked again 45 seconds later");
  t.mock.timers.enable({ apis: ["Date"], now: t0 + BUYER_DIALS.redialMs + 1_000 });
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s).length, 2, "tried again after the wait");
  e = entryOnDisk(s.dir, sale.id);
  // (On disk too: refused in the same words, the record stayed "opening"
  // there — what was saved before LND was asked — and a restart would have
  // waited for the channel of an open that LND had refused.)
  assert.deepEqual([e?.phase, e?.opening, e?.lastError], ["accepted", undefined, refused]);
  assert.equal(events(s, sale.id).filter((w) => w === refused).length, 1, "said once while it stays the same");
  t.mock.timers.setTime(t0 + PREPAID_CHANNEL_WINDOW_MS - 6 * HOUR + 60_000);
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.match(e?.reason ?? "", /^the channel could not be opened in time — last tried: .*chan size of 0\.02 BTC is below min chan size of 0\.05 BTC/);
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED");
  assert.equal(s.capital.reservedSat(), 0);
  assert.equal(opens(s).length, 2);
});
