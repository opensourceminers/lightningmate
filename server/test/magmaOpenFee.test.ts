// What a sold channel's open pays on chain (review 2026-11-10, LANE-4;
// othervice's decision E2).
//
// Before, the open named no fee rate: LND picked one when the buyer had paid
// — hours after the accept floor was checked — and nothing looked at it. With
// the mempool up in between, the channel was opened for more than the sale
// earned; "Max on-chain fee for opens" covers the autopilot's routing opens
// alone. Now the open states its rate (LND's 6-block estimate, whole), the
// lane's own open waits while that would cost more than the sale earns —
// for as long as the held payment allows an open — and then the buyer is
// refunded and the operator told. The operator's click opens anyway.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { OPEN_MIN_BLOCKS_LEFT } from "../src/services/magmaDesk.js";
import { magmaRefundAlerts } from "../src/services/alerts.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { entryOnDisk, feeEnv, quiet } from "./helpers/lifecycle.js";

type Setup = ReturnType<typeof sellerSetup>;
/** LND's fee estimate, sat/vB (250 sat/kw each). */
const estimate = (s: Setup, satPerVbyte: number) => s.node.override("wallet.estimateFee", (_a, cb) => cb(null, { sat_per_kw: String(Math.round(satPerVbyte * 250)) }));
const noEstimate = (s: Setup) => s.node.override("wallet.estimateFee", (_a, cb) => cb({ details: "fee estimation failed" }));
/** The fee rate each open asked of LND (sat/vB; undefined: none named). */
const openRates = (s: Setup) => s.node.callsTo("default.openChannel").map((a) => (a.sat_per_vbyte === undefined ? undefined : Number(a.sat_per_vbyte)));

/** What the run history says the lane's opens for an order failed with. */
const historyErrors = (s: Setup, orderId: string) => [
  ...new Set(
    s.autopilot
      .getState()
      .history.flatMap((run) => run.sells ?? [])
      .filter((x) => x.orderId === orderId && x.action === "open" && !x.ok)
      .map((x) => x.error),
  ),
];

/** A 2,000,000 sat order paying 2,436 sat — 2,411 after the 1 % service fee
 *  — accepted at 2 sat/vB and paid; "Max on-chain fee for opens" is 5. */
async function paidOrder(t: TestContext, opts: Parameters<typeof sellerSetup>[1] = {}) {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t, { ...opts, config: { channelMaxFeeRate: 5, ...opts.config } });
  s.node.peers.push(BUYER);
  estimate(s, 2);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "2436", sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
  const hash = s.magma.buyerPays(sale.id, s.node);
  return { s, sale, hash };
}

const WHY_400 = "on-chain fees are 400 sat/vB: opening the channel would cost about 70,000 sat, more than the 2,411 sat this sale earns";
const WAIT_400 = `${WHY_400} — waiting for lower fees (“Open channel” opens it only once it costs no more than the order brings)`;

test("fees rose between the accept and the payment: the lane's open waits while it would cost more than the sale earns, and goes out at a stated rate once it doesn't — before, at whatever LND picked", async (t) => {
  const { s, sale, hash } = await paidOrder(t);
  estimate(s, 400);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), [], "before: one open, at 400 sat/vB — 70,000 sat for a sale of 2,436");
  let e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "held");
  assert.equal(e?.lastError, `${WAIT_400} — will try again`);
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED", "the buyer's payment stays held");
  const lane = s.autopilot.getState().magmaLane;
  assert.deepEqual([lane.ok, lane.retrying], [false, true]);
  assert.match(lane.error ?? "", /^1 paid order waits for lower on-chain fees \(on-chain fees are 400 sat\/vB/);
  assert.deepEqual(historyErrors(s, sale.id), ["a sold channel waits for lower on-chain fees — trying again"]);
  // Found again on every pass, said once on the order's record.
  await s.autopilot.pollSellOrders();
  await s.autopilot.pollSellOrders();
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.events.filter((ev) => ev.what.startsWith("on-chain fees are 400")).length, 1);
  // Down to 10 sat/vB — above the 5 of "Max on-chain fee for opens", which is
  // the routing opens' limit: 1,750 sat for a sale of 2,411 opens.
  estimate(s, 10);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), [10]);
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "reported");
  assert.ok(e?.events.some((ev) => ev.what === "open started at 10 sat/vB"), "the record says the rate");
  assert.equal(s.autopilot.getState().magmaLane.ok, true);
});

test("the limit is what the sale earns after the service fee: at 2,411 sat, 13 sat/vB opens and 14 waits", async (t) => {
  // 2,411 sat net / 175 vB = 13.78: 13 sat/vB (2,275 sat) opens, 14 (2,450) waits.
  const { s, sale } = await paidOrder(t);
  estimate(s, 14);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), []);
  assert.match(entryOnDisk(s.dir, sale.id)?.lastError ?? "", /^on-chain fees are 14 sat\/vB: opening the channel would cost about 2,450 sat, more than the 2,411 sat this sale earns/);
  estimate(s, 13);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), [13]);
});

test("an open that costs exactly what the sale earns goes out: 2,450 sat net at 14 sat/vB", async (t) => {
  // 2,475 sat less 1 % is 2,450 sat — 14 sat/vB × 175 vB to the sat.
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t, { config: { channelMaxFeeRate: 5 } });
  s.node.peers.push(BUYER);
  estimate(s, 2);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "2475", sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  s.magma.buyerPays(sale.id, s.node);
  estimate(s, 14);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), [14]);
});

test("the rate is LND's estimate for its default target of 6 blocks — the one the accept floor is priced with — not a slower one", async (t) => {
  const { s } = await paidOrder(t);
  // 10 sat/vB to confirm within 6 blocks; 1 sat/vB for anything slower.
  s.node.override("wallet.estimateFee", (a, cb) => cb(null, { sat_per_kw: Number(a.conf_target) <= 6 ? "2500" : "250" }));
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), [10]);
});

test("LND's estimate is paid as a whole rate, up only past a tenth over one: its floor of 253 sat/kw (1.012 sat/vB) pays 1", async (t) => {
  const { s } = await paidOrder(t);
  s.node.override("wallet.estimateFee", (_a, cb) => cb(null, { sat_per_kw: "253" }));
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), [1]);
});

test("fees stay above what the sale earns: once the held payment could no longer cover an open the buyer is refunded, the record says what was waited for, and the operator is told until they dismiss it", async (t) => {
  const { s, sale, hash } = await paidOrder(t);
  estimate(s, 400);
  await s.autopilot.pollSellOrders();
  const until = s.node.invoices.get(hash)?.htlcs?.[0]?.expiryHeight;
  assert.ok(until);
  assert.deepEqual(s.desk.refunds(), []);
  // The last block in which an open could still be confirmed in time: waits.
  s.node.blockHeight = until - OPEN_MIN_BLOCKS_LEFT;
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
  s.node.blockHeight += 1;
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED", "the buyer has the payment back");
  assert.deepEqual(openRates(s), []);
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  // (What was waited for — without the "waiting … opens it anyway" of the
  // wait itself, which is over: review of the package.)
  assert.equal(
    e?.reason,
    `the held payment would expire before the channel could be confirmed (${OPEN_MIN_BLOCKS_LEFT - 1} blocks left, ${OPEN_MIN_BLOCKS_LEFT} needed) — it waited for lower fees until then: ${WHY_400}`,
  );
  assert.equal(s.autopilot.capital.reservedSat(), 0, "its coins are free again");
  // The operator is told — before, only the order's own row said so.
  const alerts = magmaRefundAlerts(s.desk);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, `magma:${sale.id}`);
  assert.match(alerts[0].message, /^A paid 2,000,000 sat Magma order was refunded and no channel opened: the held payment would expire .* on-chain fees are 400 sat\/vB.*\. The buyer has their 2,436 sat back; Amboss may count the order against your seller score\. See Market → Orders for the order\.$/);
  assert.doesNotMatch(alerts[0].message, /waiting for lower fees|opens it anyway/);
  // Two days on it is gone by itself; dismissed, at once — and it stays so.
  assert.deepEqual(s.desk.refunds(Date.now() + 49 * 3_600_000), []);
  assert.equal(s.desk.acknowledgeRefusal(sale.id), true);
  assert.deepEqual(magmaRefundAlerts(s.desk), []);
  assert.deepEqual(magmaRefundAlerts(s.restart().magma), []);
});

test("an order that ended before the buyer paid is no refund: nothing to tell", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  s.magma.setStatus(sale.id, "BUYER_FAILED_TO_PAY");
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "cancelled");
  assert.deepEqual(s.desk.refunds(), []);
  assert.equal(s.desk.acknowledgeRefusal(sale.id), false);
});

test("the operator's “Open channel” click opens under the same ceiling: dearer than the order brings, it is refused with both numbers and the order goes on waiting; once it costs no more, it opens at the stated rate — before, it opened whatever the fee (othervice, 2026-11-12)", async (t) => {
  const { s, sale, hash } = await paidOrder(t);
  estimate(s, 400);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), []);
  const refused = await s.desk.open(sale.id);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.match(
    refused.message ?? "",
    /^not opened: on-chain fees are 400 sat\/vB: opening the channel would cost about 70,000 sat, more than the 2,411 sat this sale earns — LightningMate opens no channel that costs more than the order brings; it waits for lower fees while the held payment has time$/,
  );
  assert.deepEqual(openRates(s), [], "nothing opened");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "held", "the order goes on waiting");
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED", "the payment is still held");
  estimate(s, 13);
  const res = await s.desk.open(sale.id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(openRates(s), [13]);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "reported");
});

test("LND gives no fee estimate: the lane does not open at a cost it doesn't know — it waits, and says so; a click opens nothing blind either", async (t) => {
  const { s, sale, hash } = await paidOrder(t, { openFeeUnknown: true });
  noEstimate(s);
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), []);
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "held");
  assert.match(e?.lastError ?? "", /^LND gives no on-chain fee estimate, so what opening the channel would cost is unknown — waiting for one .* — will try again$/);
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
  // The lane's status says what it waits for: an estimate, not "lower fees".
  assert.match(s.autopilot.getState().magmaLane.error ?? "", /^1 paid order waits for an on-chain fee estimate \(LND gives no on-chain fee estimate/);
  // …and so does the run history: before, no test told the two lines apart.
  assert.deepEqual(historyErrors(s, sale.id), ["a sold channel waits for an on-chain fee estimate — trying again"]);
  // Before: the click opened at the rate LND picked (othervice's ceiling, 2026-11-12).
  const res = await s.desk.open(sale.id);
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(res.message ?? "", /^not opened: LND gives no on-chain fee estimate, so what opening the channel would cost is unknown — LightningMate opens no channel that costs more than the order brings/);
  assert.deepEqual(openRates(s), []);
});

test("no estimate for as long as the payment can be held: the buyer is refunded, and the record says an estimate was waited for", async (t) => {
  const { s, sale, hash } = await paidOrder(t, { openFeeUnknown: true });
  noEstimate(s);
  await s.autopilot.pollSellOrders();
  const until = s.node.invoices.get(hash)?.htlcs?.[0]?.expiryHeight;
  assert.ok(until);
  s.node.blockHeight = until - OPEN_MIN_BLOCKS_LEFT + 1;
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED");
  assert.equal(
    entryOnDisk(s.dir, sale.id)?.reason,
    `the held payment would expire before the channel could be confirmed (${OPEN_MIN_BLOCKS_LEFT - 1} blocks left, ${OPEN_MIN_BLOCKS_LEFT} needed) — it waited for a fee estimate until then: ` +
      "LND gives no on-chain fee estimate, so what opening the channel would cost is unknown",
  );
});

test("Amboss sets a deadline for the open and it comes close while fees are too high: the payment goes back, and the reason is the fee — not an open that 'failed'", async (t) => {
  const { s, sale, hash } = await paidOrder(t);
  estimate(s, 400);
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "held");
  // A deadline five minutes away: no time to wait in.
  s.magma.sales.get(sale.id)!.timeout = new Date(Date.now() + 5 * 60_000).toISOString();
  await s.autopilot.pollSellOrders();
  assert.deepEqual(openRates(s), []);
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.reason], ["cancelled", `the channel could not be opened in time: ${WHY_400}`]);
  assert.equal(magmaRefundAlerts(s.desk).length, 1);
});
