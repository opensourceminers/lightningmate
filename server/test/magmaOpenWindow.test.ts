// How long a paid order's channel may still be opened (review 2026-11-10,
// LANE-2 and LANE-6).
//
// LANE-2: the lane read the order's `timeout` as "the deadline for opening
// the channel". The schema says only `timeout: String`; live it was seen on
// orders awaiting approval and on ended ones (null), never in between — and
// the fake Amboss cleared it at the accept, so every test ran with "no
// deadline". With the approval deadline left in the field, a buyer who paid
// after that moment (the invoice is good for 49 h) was refunded at once and
// the order ended as the seller's failure to open. A `timeout` that had
// passed before the payment was held is not the open deadline; the held
// payment's own height is the hard limit either way.
//
// LANE-6: with no deadline from Amboss, a buyer offline right after paying
// was dialed for 30 minutes and then refunded — though the payment can be
// held for about 38 hours and still leave the open its 60 blocks.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { OPEN_MIN_BLOCKS_LEFT, OPEN_RETRY_WINDOW_MS } from "../src/services/magmaDesk.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { entryOnDisk, feeEnv, quiet } from "./helpers/lifecycle.js";

type Dial = (pubkey: string, sockets: string[], onDialError?: (socket: string, error: string) => void, budgetMs?: number) => Promise<boolean>;
/** Each dial's time budget is kept; with `offline`, the buyer's node does
 *  not answer a dial until `back()`. */
function dials(desk: object, offline: boolean): { budgets: (number | undefined)[]; back: () => void } {
  const d = desk as unknown as { lndConnect: Dial };
  const real = d.lndConnect.bind(desk);
  const budgets: (number | undefined)[] = [];
  let away = offline;
  d.lndConnect = async (pubkey, sockets, onDialError, budgetMs) => {
    budgets.push(budgetMs);
    if (!away) return real(pubkey, sockets, onDialError, budgetMs);
    onDialError?.("203.0.113.7:9735", "connection timed out");
    return false;
  };
  return { budgets, back: () => (away = false) };
}
const buyerOffline = (desk: object) => dials(desk, true);
const opens = (s: ReturnType<typeof sellerSetup>) => s.node.callsTo("default.openChannel").length;
const setup = (t: TestContext) => {
  feeEnv(t);
  quiet(t);
  return sellerSetup(t);
};

test("the approval deadline left in `timeout` after the accept, and the buyer pays after it: the channel is opened — before, the buyer was refunded at once", async (t) => {
  const s = setup(t);
  s.magma.timeoutAfterAccept = "kept";
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
  assert.ok(s.magma.sales.get(sale.id)!.timeout, "the fake keeps the approval deadline");
  // The buyer pays once that time has passed.
  s.magma.sales.get(sale.id)!.timeout = new Date(Date.now() - 60_000).toISOString();
  const hash = s.magma.buyerPays(sale.id, s.node);
  const dial = dials(s.desk, false);
  await s.autopilot.pollSellOrders();
  // The dial of the buyer got its full time, not the single second a
  // deadline already past left it.
  assert.deepEqual(dial.budgets, [undefined]);
  assert.equal(opens(s), 1);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "reported");
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
});

test("the approval deadline left in `timeout`, not yet passed when the buyer pays: the channel is opened as ever", async (t) => {
  const s = setup(t);
  s.magma.timeoutAfterAccept = "kept";
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  s.magma.buyerPays(sale.id, s.node);
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s), 1);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "reported");
});

// Review of the package: with the approval deadline left in `timeout` and
// the buyer paying BEFORE it, that time lay after the payment and was read as
// the deadline for the open — a wait for the buyer's node (or for lower
// fees) ended ten minutes before it, the buyer refunded with a day and a
// half of the held payment unused.
test("the approval deadline left in `timeout`, the buyer pays before it and is then offline: that time is not the deadline for the open — the payment stays held past it, and the channel opens when the buyer is back", async (t) => {
  const s = setup(t);
  s.magma.timeoutAfterAccept = "kept";
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  const approvalDeadline = Date.parse(s.magma.sales.get(sale.id)!.timeout!);
  assert.equal(entryOnDisk(s.dir, sale.id)?.approvalDeadline, s.magma.sales.get(sale.id)!.timeout, "kept on the record");
  const hash = s.magma.buyerPays(sale.id, s.node);
  const dial = buyerOffline(s.desk);
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "held");
  assert.deepEqual(dial.budgets, [undefined], "the dial is not cut to that time either");
  // Nine minutes before it — before: refunded here.
  t.mock.timers.enable({ apis: ["Date"], now: approvalDeadline - 9 * 60_000 });
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "held");
  // Past it.
  t.mock.timers.setTime(approvalDeadline + 60_000);
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "held");
  dial.back();
  t.mock.timers.setTime(approvalDeadline + 10 * 60_000);
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s), 1);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "reported");
});

test("a `timeout` that lies after the payment is the open deadline: once it has passed the payment is released and no channel opened", async (t) => {
  const s = setup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  const hash = s.magma.buyerPays(sale.id, s.node);
  const dial = buyerOffline(s.desk);
  await s.autopilot.pollSellOrders(); // held; the buyer is away
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "held");
  // Amboss sets a deadline for the open, and it passes.
  const deadline = Date.now() + 20 * 60_000;
  s.magma.sales.get(sale.id)!.timeout = new Date(deadline).toISOString();
  t.mock.timers.enable({ apis: ["Date"], now: deadline + 1_000 });
  dial.back();
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s), 0, "a channel opened now would be a free one");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.reason], ["cancelled", "the channel could not be opened in time"]);
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED");
});

test("a buyer offline after paying, no deadline from Amboss: dialed for as long as the held payment allows an open — hours, not 30 minutes — and the channel opens when they are back", async (t) => {
  const s = setup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  const hash = s.magma.buyerPays(sale.id, s.node);
  const dial = buyerOffline(s.desk);
  await s.autopilot.pollSellOrders();
  assert.match(entryOnDisk(s.dir, sale.id)?.lastError ?? "", /connection timed out.* — will try again$/);
  // Twelve hours on (72 blocks): still held, still dialed.
  const t0 = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: t0 + 12 * 3_600_000 });
  s.node.blockHeight += 72;
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED", "before: refunded after 30 minutes");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "held");
  assert.ok(dial.budgets.length >= 2, "dialed again");
  // The buyer's node is back.
  dial.back();
  t.mock.timers.setTime(t0 + 12 * 3_600_000 + 20 * 60_000);
  await s.autopilot.pollSellOrders();
  assert.equal(opens(s), 1);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "reported");
  assert.equal(s.autopilot.getState().magmaLane.ok, true);
});

test("a buyer who stays away: the payment is released once it could no longer be held until the channel is confirmed — the record says what was tried", async (t) => {
  const s = setup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  const hash = s.magma.buyerPays(sale.id, s.node);
  const until = entryHeld(s, hash);
  buyerOffline(s.desk);
  await s.autopilot.pollSellOrders();
  // One block short of the limit: still waited for.
  const t0 = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: t0 + 37 * 3_600_000 });
  s.node.blockHeight = until - OPEN_MIN_BLOCKS_LEFT;
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED");
  // The limit: an open now could not be confirmed and validated in time.
  t.mock.timers.setTime(t0 + 37 * 3_600_000 + 10 * 60_000);
  s.node.blockHeight = until - OPEN_MIN_BLOCKS_LEFT + 1;
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED", "the buyer is refunded");
  assert.equal(opens(s), 0);
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.match(
    e?.reason ?? "",
    new RegExp(`^the held payment would expire before the channel could be confirmed \\(${OPEN_MIN_BLOCKS_LEFT - 1} blocks left, ${OPEN_MIN_BLOCKS_LEFT} needed\\) — last tried: couldn't connect to .*connection timed out`),
  );
  assert.equal(s.autopilot.capital.reservedSat(), 0, "its coins are free again");
});

/** The height until which the buyer's payment is held. */
function entryHeld(s: ReturnType<typeof sellerSetup>, hash: string): number {
  const height = s.node.invoices.get(hash)?.htlcs?.[0]?.expiryHeight;
  assert.ok(height, "the held payment's expiry height");
  return height;
}

test("LND names no height for the held payment: with nothing to count blocks against, the buyer is dialed for half an hour and then refunded — as before", async (t) => {
  // Review of the package: the fallback had no test. The hours of LANE-6
  // rest on the held payment's height; without one the lane cannot tell when
  // an open would come too late, and keeps the short window.
  const s = setup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  const hash = s.magma.buyerPays(sale.id, s.node);
  // (LND states one for every held HTLC; the lane does not rest on that.)
  const d = s.desk as unknown as { lndHodlStatus: (id: string) => Promise<{ heldUntilHeight: number | null }> };
  const real = d.lndHodlStatus.bind(s.desk);
  d.lndHodlStatus = async (id) => ({ ...(await real(id)), heldUntilHeight: null });
  buyerOffline(s.desk);
  await s.autopilot.pollSellOrders();
  let e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.heldUntilHeight ?? null], ["held", null]);
  const t0 = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: t0 + OPEN_RETRY_WINDOW_MS - 2 * 60_000 });
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "ACCEPTED", "28 minutes on: still held");
  t.mock.timers.setTime(t0 + OPEN_RETRY_WINDOW_MS + 2 * 60_000);
  await s.autopilot.pollSellOrders();
  assert.equal(s.node.invoices.get(hash)?.state, "CANCELED", "past half an hour: the buyer is refunded");
  e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "cancelled");
  assert.match(e?.reason ?? "", /^channel open failed: couldn't connect/);
  assert.equal(opens(s), 0);
});
