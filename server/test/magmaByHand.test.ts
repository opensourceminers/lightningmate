/**
 * A decision the operator makes by hand on a Magma order wins over the order
 * lane (review of P8, final round) — for an order the lane isn't working on
 * when the click comes: one action per order at a time, so a click that comes
 * while the lane is deciding or acting on that order waits for that step, and
 * is refused if the order was accepted or rejected meanwhile (review of P9,
 * round 3: the docs said "always"; the last tests pin the limit they state).
 *
 * Before, a click whose call failed on a transient error left the order
 * "seen", marked as the operator's ("manual") — and the lane took it for its
 * own on its next pass:
 *  - the operator rejects, Amboss's RejectOrder fails (HTTP 502, a timeout):
 *    the record said "reject not confirmed … will try again", but nothing sent
 *    it again. With Liquidity provision on (or once it was switched on) the
 *    next pass ACCEPTED the order the operator had refused — HODL invoice,
 *    coins reserved, AcceptOrder — and once paid, the lane opened its channel;
 *  - the operator accepts an order above the lane's caps (a manual pick isn't
 *    bound by them), and the accept fails on an LND blink: the next pass
 *    turned it down for those caps — silently, as a manual reject raises no
 *    alert.
 * Now the lane carries out the operator's reject — sent again on every pass,
 * whatever the selling switch says, until Amboss confirms it or the order
 * ends — and leaves an order whose accept by hand didn't go through to the
 * operator: the lane neither accepts nor rejects it. The operator's latest
 * click is what stands — also a click that can't read the order (Amboss or
 * LND not answering), once the lane has it on record (review of P9, round 2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANUAL_ACCEPT_SKIP, type DeskResult } from "../src/services/magmaDesk.js";
import type { MagmaJournalEntry } from "../src/services/magmaJournal.js";
import { magmaRefusalAlerts } from "../src/services/alerts.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { resolverFailed } from "./helpers/magma.js";
import { IN_AN_HOUR, crashAt, entryOnDisk, journalOnDisk, quiet, sleep } from "./helpers/lifecycle.js";
import { until } from "./helpers/wait.js";

type Setup = ReturnType<typeof sellerSetup>;
/** The process whose desk and capital ledger a check reads (after a restart,
 *  the new one). */
type Process = Setup["autopilot"];

/** The operator's reject, carried out: rejected on Amboss, recorded as theirs
 *  (no "turned down" alert, no refusal on the Overview), never accepted. */
function rejectedByThem(s: Setup, id: string, what: string, ap: Process = s.autopilot): void {
  assert.equal(s.magma.count("AcceptOrder"), 0, `${what}: the lane never accepts an order the operator rejected`);
  assert.equal(s.node.callsTo("invoices.addHoldInvoice").length, 0, `${what}: no invoice made for it`);
  assert.equal(ap.capital.reservedSat(), 0, `${what}: no coins promised`);
  assert.equal(s.magma.sales.get(id)?.status, "SELLER_REJECTED", `${what}: rejected on Amboss`);
  const e = entryOnDisk(s.dir, id);
  assert.deepEqual([e?.phase, e?.via, e?.reason], ["rejected", "manual", "rejected by you"], what);
  assert.deepEqual(magmaRefusalAlerts(ap.magma), [], `${what}: no "turned down" alert`);
  assert.deepEqual(ap.magma.refusals(), [], `${what}: no refusal on the Overview`);
}

/** The click's reject fails the way a transient error does (HTTP 502): the
 *  order is left "seen", the reject the operator's — and the click says the
 *  reject stands. */
async function rejectFails(s: Setup, id: string): Promise<void> {
  const calls = s.magma.count("RejectOrder");
  s.magma.behave.RejectOrder = (n) => (n === calls ? "throw" : "ok");
  const click = await s.desk.reject(id);
  assert.deepEqual([click.ok, click.code], [false, "amboss"], click.message);
  assert.match(click.message, /Your reject stands: the order lane sends it again until Amboss confirms it, and won't accept this order\.$/);
  const e = entryOnDisk(s.dir, id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.action], ["seen", "manual", "reject"]);
  assert.match(e?.lastError ?? "", /^reject not confirmed \(Amboss HTTP 502\) — will try again$/);
}

/** An order the operator is deciding (an accept of theirs that didn't go
 *  through): neither accepted nor rejected by the lane — and its record says
 *  so. `accepts`: the AcceptOrder calls their own accept made (its clicks,
 *  and the lane's resend of one whose answer was lost); `rejects`: the
 *  RejectOrder calls their own earlier reject made (its click); `ap`: the
 *  process whose ledger and alerts are checked (after a restart, the new
 *  one). */
function leftToThem(
  s: Setup,
  id: string,
  what: string,
  { accepts = 0, rejects = 0, ap = s.autopilot }: { accepts?: number; rejects?: number; ap?: Process } = {},
): void {
  assert.equal(s.magma.count("AcceptOrder"), accepts, `${what}: not accepted by the lane`);
  assert.equal(s.magma.count("RejectOrder"), rejects, `${what}: not turned down by the lane`);
  assert.equal(s.magma.sales.get(id)?.status, "WAITING_FOR_SELLER_APPROVAL", what);
  const e = entryOnDisk(s.dir, id);
  assert.deepEqual([e?.phase, e?.via, e?.invoice], ["seen", "manual", null], what);
  assert.equal(e?.decision?.reason, MANUAL_ACCEPT_SKIP, what);
  assert.equal([...s.node.invoices.values()].filter((i) => i.state === "OPEN").length, 0, `${what}: no invoice of ours payable`);
  assert.equal(ap.capital.reservedSat(), 0, `${what}: no coins promised`);
  assert.deepEqual(magmaRefusalAlerts(ap.magma), [], what);
}

// ── a reject the operator clicked that Amboss didn't confirm ─────────────────

test("selling on: the operator's reject Amboss didn't confirm is sent again by the next pass — the lane never accepts the order", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await rejectFails(s, sale.id);
  await s.autopilot.pollSellOrders();
  // Before: AcceptOrder 1 — HODL invoice, coins reserved, "within your caps
  // and capital" — and the order WAITING_FOR_BUYER_PAYMENT.
  assert.equal(s.magma.count("RejectOrder"), 2, "the click's, and the pass's");
  rejectedByThem(s, sale.id, "selling on");
});

test("selling off at the click, switched on before the next pass: the operator's reject is carried out, not overridden by the lane's accept", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await s.autopilot.pollSellOrders();
  await rejectFails(s, sale.id);
  s.autopilot.setConfig({ sellEnabled: true });
  await s.autopilot.pollSellOrders();
  rejectedByThem(s, sale.id, "switched on");
});

test("selling off throughout: the operator's reject Amboss didn't confirm is still sent again — it is their decision, not the paused lane's", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await rejectFails(s, sale.id);
  // A reject Amboss refuses is sent again too — every pass, until it takes it.
  s.magma.behave.RejectOrder = (n) => (n === 1 ? "false" : "ok");
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(entryOnDisk(s.dir, sale.id)?.lastError, "Amboss refused the reject");
  // Before: nothing sent it again — "will try again" wasn't true, and the
  // order timed out on the operator (SELLER_FAILED_TO_REACT).
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("RejectOrder"), 3);
  rejectedByThem(s, sale.id, "selling off");
  // Ended: nothing more is sent.
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("RejectOrder"), 3);
});

test("the operator's reject still unconfirmed when the process restarts: the new process's first pass sends it again — selling on, it never accepts the order", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await rejectFails(s, sale.id);
  const p2 = s.restart();
  await p2.pollSellOrders();
  rejectedByThem(s, sale.id, "after a restart", p2);
});

test("the operator's reject still unconfirmed when the process restarts with selling off: sent again on the first pass", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await rejectFails(s, sale.id);
  const p2 = s.restart();
  await p2.pollSellOrders();
  rejectedByThem(s, sale.id, "after a restart, selling off", p2);
});

test("Amboss won't show the order the operator rejected, but lists it awaiting approval: the reject is sent again at once — theirs, with their reason — not only near the deadline", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await rejectFails(s, sale.id);
  s.magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await s.autopilot.pollSellOrders();
  // Before: left alone until two minutes before the deadline, then rejected
  // with the lane's own reason ("Amboss would not show this order …").
  rejectedByThem(s, sale.id, "read failing");
});

// Review of P9: with no listing to tell — selling off (or all automation
// paused: the listing isn't asked for then), or the listing failing too — the
// operator's reject was sent again only once the order's own read worked.
// While that read failed, nothing sent it, though the click was told "the
// order lane sends it again until Amboss confirms it", and the order timed
// out on them (SELLER_FAILED_TO_REACT, the seller-score hit D6 exists to
// prevent). A reject needs only the order's id.
for (const c of [
  { name: "selling off", config: { sellEnabled: false }, listingFails: false },
  { name: "selling on, Amboss's listing failing too", config: {}, listingFails: true },
]) {
  test(`${c.name}: the operator's reject Amboss didn't confirm is sent again while Amboss won't show the order — no listing needed`, async (t) => {
    quiet(t);
    const s = sellerSetup(t, { config: c.config });
    const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
    // The order's read fails throughout; the click finds the order in the
    // listing, and its reject fails.
    s.magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
    await rejectFails(s, sale.id);
    if (c.listingFails) s.magma.salesList = (f) => (f.action_needed ? resolverFailed() : null);
    await s.autopilot.pollSellOrders();
    assert.equal(s.magma.count("RejectOrder"), 2, "the click's, and the pass's");
    rejectedByThem(s, sale.id, c.name);
  });
}

test("the operator's reject Amboss didn't confirm, the order since closed on Amboss — its read failing, the listing leaving it out: no reject is sent for an order Amboss no longer lists as awaiting approval", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await rejectFails(s, sale.id);
  s.magma.setStatus(sale.id, "ADMIN_CLOSED");
  s.magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await s.autopilot.pollSellOrders();
  // The listing is what tells, the order's read failing: a reject Amboss
  // could only refuse is not sent.
  assert.equal(s.magma.count("RejectOrder"), 1, "only the click's");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.action], ["seen", "manual", "reject"]);
  assert.match(e?.lastError ?? "", /^could not read the order from Amboss: Unexpected error\.$/);
});

test("the operator's reject Amboss didn't confirm, the order unreadable ever since: the click kept the order's deadline — once that is long past, the resends stop and the order ends here, not a day later", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  s.magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await rejectFails(s, sale.id);
  // Without it (a click used to record none — only a read of the lane did),
  // the resends would go on every pass for a day after the click — each
  // refused, the order long ended.
  assert.equal(entryOnDisk(s.dir, sale.id)?.timeout, sale.timeout, "the order's approval deadline is on record");
  // It timed out on Amboss, its read still failing — as the deadline passes:
  s.magma.setStatus(sale.id, "SELLER_FAILED_TO_REACT");
  const entry = s.desk.journal.get(sale.id)!;
  entry.timeout = new Date(Date.now() - 5 * 60_000).toISOString();
  await s.autopilot.pollSellOrders();
  // Just past it (clocks may differ): sent again, and Amboss refuses it.
  assert.equal(s.magma.count("RejectOrder"), 2);
  assert.deepEqual([entryOnDisk(s.dir, sale.id)?.phase, entryOnDisk(s.dir, sale.id)?.lastError], ["seen", "Amboss refused the reject"]);
  entry.timeout = new Date(Date.now() - 11 * 60_000).toISOString();
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via], ["failed", "manual"]);
  assert.match(e?.reason ?? "", /^its approval deadline passed while Amboss would not show it \(Unexpected error\.\) — nothing of ours is tied to it$/);
  assert.equal(s.magma.count("RejectOrder"), 2, "not sent again");
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("RejectOrder"), 2, "ended here: nothing more is sent");
  assert.deepEqual(magmaRefusalAlerts(s.desk), []);
});

// ── an accept the operator clicked that didn't go through ────────────────────

test("an accept clicked for an order above the lane's caps, failing on an LND blink: the next pass neither turns it down for those caps nor accepts it — and the operator's next click accepts it", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxChannelSats: 5_000_000 } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 8_000_000 });
  s.node.failNext("default.walletBalance", "transport is closing");
  const click = await s.desk.accept(sale.id);
  assert.deepEqual([click.ok, click.code], [false, "node"], click.message);
  // Said on the order at once, not only after the lane's next pass.
  assert.equal(entryOnDisk(s.dir, sale.id)?.decision?.reason, MANUAL_ACCEPT_SKIP);
  await s.autopilot.pollSellOrders();
  // Before: RejectOrder 1, "above your max channel size (8,000,000 >
  // 5,000,000 sat)" — and no alert, the record being the operator's.
  leftToThem(s, sale.id, "selling on");
  // Still theirs to accept: the lane's caps don't bind a manual pick.
  const again = await s.desk.accept(sale.id);
  assert.equal(again.ok, true, again.message);
  assert.equal(s.magma.count("AcceptOrder"), 1);
  const accepted = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([accepted?.phase, accepted?.decision?.action, accepted?.decision?.reason], ["accepted", "accept", "accepted by you"]);
});

test("an order the lane recorded first, then accepted by hand with the accept failing on an LND blink: it is the operator's from the click on — the next pass doesn't turn it down for the lane's caps", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxChannelSats: 5_000_000 } });
  // Amboss reports no fee for it yet: the lane records it and waits.
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 8_000_000, feeSeller: "0" });
  await s.autopilot.pollSellOrders();
  const first = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([first?.via, first?.decision?.reason], ["autopilot", "waiting for Amboss to report the order's fee"]);
  s.magma.sales.get(sale.id)!.feeSeller = "12345";
  s.node.failNext("default.walletBalance", "transport is closing");
  assert.equal((await s.desk.accept(sale.id)).ok, false);
  await s.autopilot.pollSellOrders();
  // Before: the record stayed the lane's ("autopilot") — the pass turned the
  // order down for its caps, with a "turned down" alert.
  leftToThem(s, sale.id, "recorded by the lane first");
});

test("the operator's latest click stands: a reject that didn't go through, then an accept that didn't either — the lane sends neither, and their next reject is carried out", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await rejectFails(s, sale.id);
  s.node.failNext("default.walletBalance", "transport is closing");
  assert.equal((await s.desk.accept(sale.id)).ok, false);
  const marked = entryOnDisk(s.dir, sale.id);
  // The reject's "will try again" is no longer true: it goes with the reject.
  assert.deepEqual([marked?.via, marked?.decision?.reason, marked?.lastError], ["manual", MANUAL_ACCEPT_SKIP, undefined]);
  await s.autopilot.pollSellOrders();
  // Before: AcceptOrder 1 (the lane took the order for its own). With only
  // the reject sent again, RejectOrder 2: the earlier click overriding the
  // latest one.
  assert.equal(s.magma.count("RejectOrder"), 1, "the earlier reject is not sent again");
  assert.equal(s.magma.count("AcceptOrder"), 0);
  assert.equal(entryOnDisk(s.dir, sale.id)?.decision?.reason, MANUAL_ACCEPT_SKIP);
  // They reject it after all; Amboss fails that one too — carried out.
  await rejectFails(s, sale.id);
  await s.autopilot.pollSellOrders();
  rejectedByThem(s, sale.id, "the latest click");
});

test("an accept by hand that didn't go through, the order's read failing near its approval deadline: the lane doesn't turn it down — the operator is deciding it", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 90_000).toISOString() });
  s.node.failNext("default.walletBalance", "transport is closing");
  assert.equal((await s.desk.accept(sale.id)).ok, false);
  s.magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await s.autopilot.pollSellOrders();
  // Before: rejected as "Amboss would not show this order … rejected rather
  // than left to time out" — the lane's reject of the operator's order.
  assert.equal(s.magma.count("RejectOrder"), 0);
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.reason], ["seen", "manual", MANUAL_ACCEPT_SKIP]);
  assert.match(e?.lastError ?? "", /could not read the order from Amboss: Unexpected error\./);
});

/** An accept clicked for an order above the lane's caps, sent but never
 *  confirmed (Amboss's answer an HTTP error: it didn't take it), and still
 *  unconfirmed — after a restart — once its invoice has less than Amboss's
 *  48 h left: the new process's first pass (resumeAccept) releases it
 *  instead of sending it again. */
async function staleManualAccept(s: Setup): Promise<{ id: string; p2: Process }> {
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 8_000_000 });
  s.magma.behave.AcceptOrder = "throw";
  const click = await s.desk.accept(sale.id);
  assert.equal(click.ok, false, click.message);
  const sent = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([sent?.phase, sent?.via], ["accepting", "manual"]);
  const entries = journalOnDisk(s.dir).map((e: MagmaJournalEntry) =>
    e.orderId === sale.id ? { ...e, invoice: { ...e.invoice!, expiresAt: new Date(Date.now() + 47 * 3_600_000).toISOString() } } : e,
  );
  writeFileSync(join(s.dir, "magma-orders.json"), JSON.stringify(entries));
  const p2 = s.restart();
  await p2.pollSellOrders();
  return { id: sale.id, p2 };
}

function releasedAndLeftToThem(s: Setup, id: string, p2: Process, what: string): void {
  assert.equal(s.magma.count("AcceptOrder"), 1, `${what}: only the click's`);
  assert.equal(s.magma.count("RejectOrder"), 0, `${what}: not turned down by the lane`);
  const e = entryOnDisk(s.dir, id);
  assert.deepEqual([e?.phase, e?.via, e?.invoice, e?.decision?.reason], ["seen", "manual", null, MANUAL_ACCEPT_SKIP], what);
  assert.equal([...s.node.invoices.values()].filter((i) => i.state === "OPEN").length, 0, `${what}: its invoice released`);
  assert.equal(p2.capital.reservedSat(), 0, `${what}: no coins promised`);
}

test("selling on: an accept by hand Amboss never confirmed, its invoice grown too old to resend — released, and the order left to the operator in the same pass, not decided by the lane", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxChannelSats: 5_000_000 } });
  const { id, p2 } = await staleManualAccept(s);
  releasedAndLeftToThem(s, id, p2, "selling on, the releasing pass");
  // Before: the next pass turned it down for the lane's caps.
  await p2.pollSellOrders();
  releasedAndLeftToThem(s, id, p2, "selling on, the pass after");
});

test("selling off: an accept by hand Amboss never confirmed, its invoice grown too old to resend — released, and the order says at once that the accept didn't go through", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false, sellMaxChannelSats: 5_000_000 } });
  const { id, p2 } = await staleManualAccept(s);
  // Before: the record kept "accepted by you" for an order back at "seen".
  releasedAndLeftToThem(s, id, p2, "selling off");
});

// Review of P9: sendAccept's guard — the lane's bound on accepts Amboss
// refuses is for its own accepts only — had no test: without it, every test
// stayed green.
test("Amboss refuses the operator's accept twice, the third goes out unconfirmed, and the lane's resend of it is refused too: the order is not turned down — the bound on refused accepts is the lane's own", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  s.magma.behave.AcceptOrder = (n) => (n < 2 ? "false" : n === 2 ? "throw" : "false");
  for (let i = 1; i <= 3; i++) assert.equal((await s.desk.accept(sale.id)).ok, false, `click ${i}`);
  const sent = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([sent?.phase, sent?.via, sent?.acceptAttempts], ["accepting", "manual", 3]);
  await s.autopilot.pollSellOrders();
  // Without the guard: rejected — "Amboss refused the accept 3 times". And
  // the record said "accepted by you", for an order back at "seen", until
  // the next pass.
  leftToThem(s, sale.id, "the resend refused", { accepts: 4 });
  assert.equal(entryOnDisk(s.dir, sale.id)?.lastError, "Amboss refused the accept");
});

test("selling off: an accept by hand whose resend Amboss refuses is back with the operator — the next pass says so on its record, and neither accepts nor rejects it", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  // Sent, its answer lost (an HTTP error): the next pass sends it again
  // (resumeAccept) — and Amboss refuses that one.
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "false");
  assert.equal((await s.desk.accept(sale.id)).ok, false);
  await s.autopilot.pollSellOrders();
  const refused = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([refused?.phase, refused?.lastError, s.magma.count("AcceptOrder")], ["seen", "Amboss refused the accept", 2]);
  await s.autopilot.pollSellOrders();
  // Before: a paused lane took no order up — the record kept "accepted by
  // you" for an order back at "seen".
  assert.equal(entryOnDisk(s.dir, sale.id)?.decision?.reason, MANUAL_ACCEPT_SKIP);
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [2, 0]);
});

// Review of P9, round 2: an accept that stops at one of the click's own early
// checks — no fee reported yet, the buyer unreachable — before any invoice or
// coins, still makes the order the operator's (the click takes it up first:
// byHand). Nothing pinned that: with either check handing the order back to
// the lane, every test stayed green.
test("selling on: an accept clicked before Amboss reports the order's fee — once the fee shows, the lane neither accepts nor rejects the order: it is the operator's", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
  const click = await s.desk.accept(sale.id);
  assert.deepEqual([click.ok, click.message], [false, "Amboss reports no fee for this order yet — try again in a minute."]);
  s.magma.sales.get(sale.id)!.feeSeller = "12345";
  await s.autopilot.pollSellOrders();
  // Handed back to the lane: the lane accepted it once the fee showed —
  // "within your caps and capital" — taking the operator's order over.
  leftToThem(s, sale.id, "the fee showing after the click");
});

test("selling on: an accept clicked for an order whose buyer is unreachable — the lane doesn't turn it down: it is the operator's to decide", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const unreachable = "02" + "ee".repeat(32);
  // This buyer never answers a connection attempt.
  s.node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (pk === unreachable) return cb({ details: "dial tcp: i/o timeout" });
    if (!s.node.peers.includes(pk)) s.node.peers.push(pk);
    cb(null, {});
  });
  const sale = s.magma.addSale({ buyerPubkey: unreachable, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  const click = await s.desk.accept(sale.id);
  assert.deepEqual([click.ok, click.code], [false, "unreachable"], click.message);
  await s.autopilot.pollSellOrders();
  // Handed back to the lane: turned down — "the buyer's node is unreachable"
  // — overriding the operator, whose order it was to decide.
  leftToThem(s, sale.id, "the buyer still unreachable");
});

// ── a click that can't read the order ────────────────────────────────────────

// Review of P9, round 2: a click whose READ of the order failed — Amboss not
// answering, before anything was sent — recorded nothing, and the lane's next
// pass decided the order as its own. With selling on it accepted an order the
// operator had rejected: one it had held back, waiting for Amboss to report
// the fee, or undecided when its capital check failed. An order the lane has
// on record ("seen") was read or listed as this node's, awaiting approval,
// and a reject needs only its id: the click makes it the operator's all the
// same (unreadClick).
for (const c of [
  {
    name: "waiting for Amboss to report its fee",
    hold: (s: Setup) => s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() }),
    release: (s: Setup, id: string) => {
      s.magma.sales.get(id)!.feeSeller = "12345";
    },
    // Amboss down: an HTTP error for the order's read and for the listing a
    // reject falls back on.
    unreadable: (s: Setup) => {
      s.magma.readBehaviour = "throw";
    },
    readable: (s: Setup) => {
      s.magma.readBehaviour = "ok";
    },
    said: "Could not read the order from Amboss: Amboss HTTP 502.",
  },
  {
    name: "undecided, its capital check failing on an LND blink",
    hold: (s: Setup) => {
      s.node.failNext("default.walletBalance", "transport is closing");
      return s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
    },
    release: () => undefined,
    // A resolver failing inside both answers: Amboss's error text ends its
    // own sentence — the click's answer doesn't double the period.
    unreadable: (s: Setup) => {
      s.magma.saleRead = () => resolverFailed();
      s.magma.salesList = () => resolverFailed();
    },
    readable: (s: Setup) => {
      s.magma.saleRead = null;
      s.magma.salesList = null;
    },
    said: "Could not read the order from Amboss: Unexpected error.",
  },
]) {
  test(`selling on, an order the lane holds back (${c.name}): the operator's Reject can't read it from Amboss — the reject stands, and the lane carries it out instead of accepting the order`, async (t) => {
    quiet(t);
    const s = sellerSetup(t);
    const sale = c.hold(s);
    await s.autopilot.pollSellOrders();
    const held = entryOnDisk(s.dir, sale.id);
    assert.deepEqual([held?.phase, held?.via], ["seen", "autopilot"], "on record, the lane's");
    c.unreadable(s);
    const click = await s.desk.reject(sale.id);
    assert.deepEqual([click.ok, click.code], [false, "amboss"], click.message);
    assert.equal(
      click.message,
      `${c.said} Your reject stands: the order lane sends it again until Amboss confirms it, and won't accept this order.`,
    );
    const marked = entryOnDisk(s.dir, sale.id);
    assert.deepEqual(
      [marked?.phase, marked?.via, marked?.decision?.action, marked?.decision?.reason, marked?.lastError],
      ["seen", "manual", "reject", "rejected by you", undefined],
    );
    c.readable(s);
    c.release(s, sale.id);
    await s.autopilot.pollSellOrders();
    // Before: AcceptOrder 1 — HODL invoice, coins reserved, "within your caps
    // and capital" — and the order WAITING_FOR_BUYER_PAYMENT.
    assert.equal(s.magma.count("RejectOrder"), 1, "the pass's: the click could send none");
    rejectedByThem(s, sale.id, c.name);
  });
}

test("the operator's reject didn't go through; their Accept then can't read the order from Amboss — the latest click stands: the lane neither sends that reject nor accepts the order", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await rejectFails(s, sale.id);
  s.magma.readBehaviour = "throw";
  const click = await s.desk.accept(sale.id);
  assert.deepEqual([click.ok, click.code, click.message], [false, "amboss", "Could not read the order from Amboss: Amboss HTTP 502"]);
  const marked = entryOnDisk(s.dir, sale.id);
  // The reject's "will try again" no longer holds: it goes with the reject.
  assert.deepEqual([marked?.via, marked?.decision?.reason, marked?.lastError], ["manual", MANUAL_ACCEPT_SKIP, undefined]);
  s.magma.readBehaviour = "ok";
  await s.autopilot.pollSellOrders();
  // Before: RejectOrder 2 — the lane sent the reject the accept had replaced.
  leftToThem(s, sale.id, "an accept that couldn't read the order", { rejects: 1 });
});

test("LND can't say which node this is when the operator's Reject reads an order the lane has on record (LightningMate just restarted, say): the reject stands — carried out once LND answers, the order never accepted", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  // What an earlier process's lane left on record: the order seen, undecided.
  const seen = s.desk.journal.create({
    orderId: sale.id,
    via: "autopilot",
    buyerPubkey: BUYER,
    sizeSats: sale.sizeSats,
    isPrivate: false,
    feeMsat: "12345000",
    timeout: sale.timeout,
  });
  s.desk.journal.note(seen);
  // This process hasn't had this node's key from LND yet, and LND doesn't
  // answer while the operator clicks: neither the click's read nor its
  // listing fallback can tell whose order it is. LND is back for the pass.
  let lndDown = true;
  for (let i = 0; i < 2; i++) s.node.failNext("default.getInfo", "transport is closing", () => lndDown);
  const click = await s.desk.reject(sale.id);
  lndDown = false;
  assert.deepEqual([click.ok, click.code], [false, "node"], click.message);
  assert.match(click.message, /^Could not read this node's key from LND: .*transport is closing.*\. Your reject stands: /);
  assert.deepEqual([entryOnDisk(s.dir, sale.id)?.via, entryOnDisk(s.dir, sale.id)?.decision?.action], ["manual", "reject"]);
  await s.autopilot.pollSellOrders();
  // Before: LND's error ended the click with nothing recorded, and the pass
  // accepted the order — HODL invoice, coins reserved, AcceptOrder.
  assert.equal(s.magma.count("RejectOrder"), 1, "the pass's");
  rejectedByThem(s, sale.id, "LND not answering the click");
});

test("a click that can't read an order the lane is already accepting changes nothing: the accept under way is completed, and the order stays the lane's", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  // The lane's accept went out; its answer was lost (an HTTP error).
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
  await s.autopilot.pollSellOrders();
  const sent = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([sent?.phase, sent?.via], ["accepting", "autopilot"]);
  s.magma.readBehaviour = "throw";
  const click = await s.desk.reject(sale.id);
  // Only the read's failure — no "your reject stands": past "seen", the order
  // is decided, and an accept that may have reached Amboss can't be taken
  // back.
  assert.deepEqual([click.ok, click.message], [false, "Could not read the order from Amboss: Amboss HTTP 502"]);
  const after = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([after?.phase, after?.via, after?.decision?.action], ["accepting", "autopilot", "accept"]);
  s.magma.readBehaviour = "ok";
  await s.autopilot.pollSellOrders();
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [2, 0]);
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  const done = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([done?.phase, done?.via, done?.decision?.reason], ["accepted", "autopilot", "within your caps and capital"]);
});

// ── a click under way when the process dies ──────────────────────────────────

test("the process dies while the operator's reject is out (Amboss never answers): the restart finds the order theirs — the reject is sent again, the lane never accepts it", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  const died = crashAt(s.desk, "ambossReject", "before");
  void s.desk.reject(sale.id);
  await until(died, "the reject was on its way");
  const p2 = s.restart();
  await p2.pollSellOrders();
  // Before: nothing of the click was on disk — the new process's lane took
  // the order for its own and accepted it.
  assert.equal(s.magma.count("RejectOrder"), 1, "the new process's");
  rejectedByThem(s, sale.id, "after the crash", p2);
});

test("the process dies while the operator's accept dials the buyer, after their reject didn't go through: the restart doesn't send that reject — the latest click stands", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await rejectFails(s, sale.id);
  const died = crashAt(s.desk, "lndConnect", "before");
  void s.desk.accept(sale.id);
  await until(died, "the buyer was being dialed");
  const p2 = s.restart();
  await p2.pollSellOrders();
  // Before: the new process's lane took the order for its own and accepted
  // it. With only the reject sent again, the reject on disk — the accept
  // clicked after it had left no mark — would have been sent instead.
  assert.equal(s.magma.count("RejectOrder"), 1, "only the click's: the reject the accept replaced is not sent");
  assert.equal(s.magma.count("AcceptOrder"), 0);
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.reason], ["seen", "manual", MANUAL_ACCEPT_SKIP]);
});

test("selling off: the process dies while the operator's accept dials the buyer — the restarted paused lane takes the order up only to say the accept didn't go through, and neither accepts nor rejects it", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  const died = crashAt(s.desk, "lndConnect", "before");
  void s.desk.accept(sale.id);
  await until(died, "the buyer was being dialed");
  const marked = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([marked?.phase, marked?.via, marked?.decision?.reason], ["seen", "manual", "accepted by you"]);
  const p2 = s.restart();
  await p2.pollSellOrders();
  // A paused lane leaves new orders alone; one the operator is deciding it
  // takes up only so that its record doesn't say "accepted by you" for an
  // order nothing was promised for.
  leftToThem(s, sale.id, "after the crash, selling off", { ap: p2 });
});

// Review of P9: invoiceFailed's guard — the lane's near-deadline reject of an
// order whose invoice can't be made is for its own accepts only — had no
// test: without it, every test stayed green.
test("the process dies while the operator's accept makes its invoice; after the restart LND fails to make it, the approval deadline close: the lane doesn't turn the order down — and its record says the accept didn't go through", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 90_000).toISOString() });
  const died = crashAt(s.desk, "lndCreateHodl", "before");
  void s.desk.accept(sale.id);
  await until(died, "the invoice was being made");
  const before = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([before?.phase, before?.via, before?.acceptSentAt], ["accepting", "manual", undefined], "never sent");
  const p2 = s.restart();
  s.node.failNext("invoices.addHoldInvoice", "transport is closing");
  await p2.pollSellOrders();
  // Without the guard: rejected by the new process's pass — "could not decide
  // on it in time: could not create the HODL invoice …". And the record said
  // "accepted by you", for an order back at "seen", until the next pass.
  leftToThem(s, sale.id, "the invoice failing near the deadline", { ap: p2 });
  assert.match(entryOnDisk(s.dir, sale.id)?.lastError ?? "", /^could not create the HODL invoice: /);
});

// ── the lane's own decisions stay the lane's ─────────────────────────────────

test("the lane's own reject that Amboss didn't confirm is not sent again once selling is off: a paused lane turns nothing down on its own — only the operator's reject is carried out whatever the switch", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxChannelSats: 5_000_000 } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 8_000_000 });
  s.magma.behave.RejectOrder = (n) => (n === 0 ? "throw" : "ok");
  await s.autopilot.pollSellOrders();
  const lanes = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([lanes?.phase, lanes?.via, lanes?.decision?.action], ["seen", "autopilot", "reject"]);
  s.autopilot.setConfig({ sellEnabled: false });
  await s.autopilot.pollSellOrders();
  // Nor while Amboss won't show the order: only the operator's reject is
  // sent again with no listing to tell.
  s.magma.saleRead = (id) => (id === sale.id ? resolverFailed() : null);
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("RejectOrder"), 1);
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(entryOnDisk(s.dir, sale.id)?.via, "autopilot");
});

// ── a click while the lane is working on that order ──────────────────────────

// Review of P9, round 3: the docs said a decision made by hand "always wins"
// over the lane. It wins for an order the lane isn't working on when the
// click comes. One action per order at a time (withOrder): a click that comes
// while the lane is deciding or acting on that order waits for that step to
// finish, and is refused, saying so, if the order was accepted or rejected
// meanwhile — the order stays as the lane left it. The docs now state that
// limit (docsMatchCode.test.ts); these tests pin it.

/** The lane's pass is held part-way through a step on an order — `hold` arms
 *  the hold on `gate` and says when the step is reached — and the operator
 *  clicks then: the click waits for the order's turn while the step is held
 *  (nothing is sent for it), and is answered once the step is done. */
async function clickMidStep(s: Setup, hold: (gate: Promise<void>) => () => boolean, click: () => Promise<DeskResult>): Promise<DeskResult> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const reached = hold(gate);
  const pass = s.autopilot.pollSellOrders();
  await until(reached, "the lane's step on the order");
  let answered = false;
  const clicked = click().finally(() => {
    answered = true;
  });
  const sent = s.magma.calls.length;
  await sleep(20);
  assert.equal(answered, false, "the click waits for the lane's step on that order");
  assert.equal(s.magma.calls.length, sent, "nothing is sent for the click meanwhile");
  open();
  await pass;
  return clicked;
}

/** Amboss holds the lane's RejectOrder — not answering — until the gate opens. */
const rejectHeld = (s: Setup) => (gate: Promise<void>) => {
  let held = false;
  s.magma.holdMutation = (op) => {
    if (op !== "RejectOrder") return null;
    held = true;
    return gate;
  };
  return () => held;
};

test("selling on: a Reject clicked while the lane dials the buyer waits for that step — the lane's accept goes out first, and the click is refused, saying so", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  const click = await clickMidStep(
    s,
    // The lane's dial of the buyer (over Tor, up to about a minute and a half).
    (gate) => {
      let dialing = false;
      s.node.override("default.connectPeer", (a, cb) => {
        dialing = true;
        void gate.then(() => {
          const pk = (a.addr as { pubkey: string }).pubkey;
          if (!s.node.peers.includes(pk)) s.node.peers.push(pk);
          cb(null, {});
        });
      });
      return () => dialing;
    },
    () => s.desk.reject(sale.id),
  );
  assert.deepEqual(click, {
    ok: false,
    code: "bad_status",
    message: "Order is WAITING_FOR_BUYER_PAYMENT — only orders awaiting approval can be rejected.",
  });
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 0]);
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.reason], ["accepted", "autopilot", "within your caps and capital"], "the click changed nothing");
});

test("selling on: an Accept clicked while the lane turns the order down for its caps waits for that step — the lane's reject goes out, its alert raised, and the click is refused, saying so", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxChannelSats: 5_000_000 } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 8_000_000, timeout: IN_AN_HOUR() });
  const click = await clickMidStep(s, rejectHeld(s), () => s.desk.accept(sale.id));
  assert.deepEqual(click, { ok: false, code: "bad_status", message: "Order is SELLER_REJECTED, not awaiting approval." });
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [0, 1]);
  assert.equal(s.magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via], ["rejected", "autopilot"], "the lane's reject: the click changed nothing");
  assert.match(e?.reason ?? "", /^above your max channel size/);
  assert.equal(magmaRefusalAlerts(s.desk).length, 1, 'its "turned down" alert');
});

test("the operator's reject didn't go through; their Accept, clicked while the lane sends that reject again, waits for that step — the reject goes out, and the click is refused, saying so", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await rejectFails(s, sale.id);
  const click = await clickMidStep(s, rejectHeld(s), () => s.desk.accept(sale.id));
  assert.deepEqual(click, { ok: false, code: "bad_status", message: "Order is SELLER_REJECTED, not awaiting approval." });
  assert.equal(s.magma.count("RejectOrder"), 2, "the click's, and the pass's");
  rejectedByThem(s, sale.id, "the resend under way");
});
