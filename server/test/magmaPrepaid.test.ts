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
import { AWAITING_AMBOSS_PAYMENT, NOT_OUR_ACCEPT_WAIT, OPENING_GRACE_MS, PAYMENT_OVERDUE_MS } from "../src/services/magmaDesk.js";
import { magmaOverduePaymentAlerts, magmaRefundAlerts, magmaUnpaidChannelAlerts } from "../src/services/alerts.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { crashAt, entryOnDisk, feeEnv, feesOnDisk, quiet, salesOnDisk, sleep } from "./helpers/lifecycle.js";
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

test("a payment is claimed only for a channel LND shows: Amboss reports the channel confirmed, the payment is held, and LND knows no channel at the order's outpoint — not settled", async (t) => {
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
