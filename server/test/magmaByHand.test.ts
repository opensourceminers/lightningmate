/**
 * A decision the operator makes by hand on a Magma order wins over the order
 * lane (review of P8, final round) — for an order the lane isn't working on
 * when the click comes: one action per order at a time, so a click that comes
 * while the lane is deciding or acting on that order waits for that step, and
 * is refused if the order was accepted or rejected meanwhile against what it
 * asked for — told it is done if that is what it asked for (review of P9,
 * round 3: the docs said "always"; the last tests pin the limit they state;
 * final round: a click finding its own wish done was refused too).
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
 * LND not answering), once the lane has it on record (review of P9, round 2)
 * — except for an accept already sent whose answer was lost ("accepting"):
 * an accept that may have reached Amboss is completed first, and a Reject
 * meanwhile is refused, saying why (review of P9, final round).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANUAL_ACCEPT_SKIP, SELLING_OFF_SKIP, type DeskResult, type MagmaOrderLocal } from "../src/services/magmaDesk.js";
import type { MagmaJournalEntry } from "../src/services/magmaJournal.js";
import { magmaRefusalAlerts } from "../src/services/alerts.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { forbidden, resolverFailed } from "./helpers/magma.js";
import { IN_AN_HOUR, crashAt, entryOnDisk, historyFor, journalOnDisk, quiet, sleep } from "./helpers/lifecycle.js";
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
  assert.match(click.message, /Your reject stands: the order lane sends it again until Amboss confirms it or the order ends, and won't accept this order\.$/);
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

/** The line Market → Orders shows under an order, computed as the web
 *  computes it (MarketOrders.tsx, localDetail — pinned below): its last
 *  error, else its reason, else its decision's reason. */
const ordersDetail = (l: MagmaOrderLocal | null): string | undefined => (l ? (l.lastError ?? l.reason ?? l.decision?.reason ?? undefined) : undefined);

test("the Orders detail these tests read is the one Market → Orders shows: the last error first", () => {
  const web = readFileSync(new URL("../../web/src/components/MarketOrders.tsx", import.meta.url), "utf8");
  assert.match(web, /function localDetail\(o: MyOrder\): string \| undefined \{\s*const l = o\.local;\s*if \(!l\) return undefined;\s*return l\.lastError \?\? l\.reason \?\? l\.decision\?\.reason \?\? undefined;\s*\}/);
});

/** An order whose accept was handed back to the operator, as its record
 *  shows it: no error on record that no longer holds — the accept's
 *  "checking with Amboss on the next pass" (nothing checks that accept
 *  again), or a failed read of an order Amboss has shown since — and Market →
 *  Orders and the recent orders (recentOrders: the selling diagnostics, the
 *  diagnostics download) say the order is theirs to decide, and why (`why`):
 *  an accept of theirs that didn't go through (MANUAL_ACCEPT_SKIP), or the
 *  lane's own with selling off (SELLING_OFF_SKIP). Review of P9, final round:
 *  that line stayed, shown before MANUAL_ACCEPT_SKIP, while the order could
 *  time out on the operator; review of P10, round 2: so did a failed read. */
function saysTheirs(ap: Process, id: string, what: string, why: string = MANUAL_ACCEPT_SKIP): void {
  const local = ap.magma.localView(id);
  assert.equal(local?.lastError, null, `${what}: no stale error on record`);
  assert.equal(ordersDetail(local), why, `${what}: Market → Orders`);
  const recent = ap.magma.recentOrders().find((o) => o.orderId === id);
  assert.deepEqual([recent?.action, recent?.reason], ["skip", why], `${what}: the recent orders`);
}

/** The order's accept on disk with less than Amboss's 48 h left on its
 *  invoice (47 h): too old to be sent again — the next process's pass
 *  (resumeAccept) releases it. */
function ageInvoice(s: Setup, id: string): void {
  const entries = journalOnDisk(s.dir).map((e: MagmaJournalEntry) =>
    e.orderId === id ? { ...e, invoice: { ...e.invoice!, expiresAt: new Date(Date.now() + 47 * 3_600_000).toISOString() } } : e,
  );
  writeFileSync(join(s.dir, "magma-orders.json"), JSON.stringify(entries));
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
  ageInvoice(s, sale.id);
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
  // Before: "accept not confirmed (Amboss HTTP 502) — checking with Amboss on
  // the next pass", on both — nothing checked it again.
  saysTheirs(p2, id, what);
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

// Review of P9, final round: the other hand-back of an accept — LND has
// cancelled (or lost) the invoice of an accept whose answer was lost, while
// the lane can't ask Amboss (maintainFromLnd) — kept the accept's "checking
// with Amboss on the next pass" too: after that pass, and after every pass
// that could read Amboss again, shown before "your accept didn't go
// through".
test("the operator's accept, its answer lost, its invoice cancelled in LND during a pass that can't ask Amboss: handed back without the accept's 'checking with Amboss' — and the next pass that reads Amboss says the order is theirs", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  // Sent, its answer lost (an HTTP error): Amboss didn't take it.
  s.magma.behave.AcceptOrder = "throw";
  assert.equal((await s.desk.accept(sale.id)).ok, false);
  const sent = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([sent?.phase, sent?.via], ["accepting", "manual"]);
  assert.equal(sent?.lastError, "accept not confirmed (Amboss HTTP 502) — checking with Amboss on the next pass");
  // LND cancels the order's invoice while Amboss is down: the pass runs on LND alone.
  s.node.expireHoldInvoice(sent!.invoice!.id);
  s.magma.readBehaviour = "throw";
  await s.autopilot.pollSellOrders();
  assert.match(s.autopilot.getState().magmaLane.error ?? "", /^Amboss unreachable/, "a pass on LND alone");
  const back = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([back?.phase, back?.invoice, back?.lastError], ["seen", null, undefined], "handed back, its error gone with the accept");
  s.magma.readBehaviour = "ok";
  await s.autopilot.pollSellOrders();
  leftToThem(s, sale.id, "the pass that reads Amboss again", { accepts: 1 });
  saysTheirs(s.autopilot, sale.id, "the pass that reads Amboss again");
});

// Review of P10: the same two hand-backs of an accept of the LANE's own, with
// Liquidity provision switched off since — its answer lost, its invoice grown
// too old to send again (resumeAccept), or cancelled in LND during a pass that
// couldn't read the order (maintainFromLnd). The paused lane left the record
// alone: Market → Orders said "Waiting for you to accept · seen" with "within
// your caps and capital" under it, and the recent orders "accept" — for an
// order nothing of ours was tied to, until it timed out on the operator.

/** The lane's own accept, sent with selling on, its answer lost (an HTTP
 *  error: Amboss didn't take it) — then Liquidity provision is switched off. */
async function laneAcceptLost(s: Setup): Promise<string> {
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  s.magma.behave.AcceptOrder = "throw";
  await s.autopilot.pollSellOrders();
  const sent = entryOnDisk(s.dir, sale.id);
  assert.deepEqual(
    [sent?.phase, sent?.via, sent?.lastError],
    ["accepting", "autopilot", "accept not confirmed (Amboss HTTP 502) — checking with Amboss on the next pass"],
  );
  s.autopilot.setConfig({ sellEnabled: false });
  return sale.id;
}

/** The lane's own accept, released with selling off: nothing of ours is tied
 *  to the order any more, nothing is sent for it, and its record says that
 *  the order is the operator's (SELLING_OFF_SKIP). */
function releasedToOperator(s: Setup, id: string, ap: Process, what: string): void {
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 0], `${what}: nothing sent since the lane's accept`);
  assert.equal(s.magma.sales.get(id)?.status, "WAITING_FOR_SELLER_APPROVAL", what);
  const e = entryOnDisk(s.dir, id);
  assert.deepEqual([e?.phase, e?.via, e?.invoice], ["seen", "autopilot", null], what);
  assert.equal([...s.node.invoices.values()].filter((i) => i.state === "OPEN").length, 0, `${what}: its invoice released`);
  assert.equal(ap.capital.reservedSat(), 0, `${what}: no coins promised`);
  assert.deepEqual(magmaRefusalAlerts(ap.magma), [], `${what}: nothing turned down`);
  // Before: "within your caps and capital" on both — and "accept" in the
  // recent orders.
  saysTheirs(ap, id, what, SELLING_OFF_SKIP);
}

test("selling switched off since: the lane's own accept Amboss never confirmed, its invoice grown too old to send again — released, and its record says the order is the operator's now", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const id = await laneAcceptLost(s);
  ageInvoice(s, id);
  const p2 = s.restart();
  await p2.pollSellOrders();
  releasedToOperator(s, id, p2, "the releasing pass");
  await p2.pollSellOrders();
  releasedToOperator(s, id, p2, "the pass after");
});

test("selling switched off since: the lane's own accept, its answer lost, its invoice cancelled in LND during a pass that can't read the order — the next pass that reads it says the order is the operator's now; switched on again, the lane decides it afresh", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const id = await laneAcceptLost(s);
  s.node.expireHoldInvoice(entryOnDisk(s.dir, id)!.invoice!.id);
  s.magma.readBehaviour = "throw";
  await s.autopilot.pollSellOrders();
  const back = entryOnDisk(s.dir, id);
  assert.deepEqual([back?.phase, back?.invoice, back?.lastError], ["seen", null, undefined], "handed back, its error gone with the accept");
  s.magma.readBehaviour = "ok";
  await s.autopilot.pollSellOrders();
  releasedToOperator(s, id, s.autopilot, "the pass that reads Amboss again");
  // Only said on its record: with selling on again, the order is the lane's
  // to decide once more.
  s.magma.behave.AcceptOrder = "ok";
  s.autopilot.setConfig({ sellEnabled: true });
  await s.autopilot.pollSellOrders();
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.sales.get(id)?.status], [2, "WAITING_FOR_BUYER_PAYMENT"]);
  const again = entryOnDisk(s.dir, id);
  assert.deepEqual([again?.phase, again?.via, again?.decision?.reason], ["accepted", "autopilot", "within your caps and capital"]);
});

// The other side of the same step (resumeAccept → decide): with selling on,
// the released order is the lane's to decide again, in the same pass.
test("selling on: the lane's own accept Amboss never confirmed, its invoice grown too old to send again — released, and decided afresh in the same pass: a fresh invoice, a fresh accept", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
  await s.autopilot.pollSellOrders();
  const first = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([first?.phase, first?.via], ["accepting", "autopilot"]);
  ageInvoice(s, sale.id);
  const p2 = s.restart();
  await p2.pollSellOrders();
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [2, 0]);
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.reason], ["accepted", "autopilot", "within your caps and capital"]);
  assert.notEqual(e?.invoice?.id, first?.invoice?.id, "a fresh invoice");
  assert.equal(s.node.invoices.get(first!.invoice!.id)?.state, "CANCELED", "the old one released");
});

// Review of P10, round 2: Amboss down for more than one pass. With selling off
// there is no listing — each pass reads every order on record on its own, and
// a read that fails is noted on the order's record, on one handed back to the
// operator too. Nothing cleared that note once the order read again, and the
// pass that then said the order was theirs (decide, skip) kept it: Market →
// Orders and the recent orders said "could not read the order from Amboss"
// over MANUAL_ACCEPT_SKIP or SELLING_OFF_SKIP, pass after pass, until the
// order timed out on the operator.

/** Amboss down for three passes, LND cancelling the order's invoice after the
 *  first: the second hands the accept back (maintainFromLnd), the third notes
 *  its failed read on the "seen" record. Then Amboss answers again, for one
 *  pass. */
async function handedBackDuringOutage(s: Setup, id: string): Promise<void> {
  s.magma.readBehaviour = "throw";
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, id)?.phase, "accepting", "nothing to hand back yet: its invoice is open");
  s.node.expireHoldInvoice(entryOnDisk(s.dir, id)!.invoice!.id);
  await s.autopilot.pollSellOrders();
  const back = entryOnDisk(s.dir, id);
  assert.deepEqual([back?.phase, back?.invoice, back?.lastError], ["seen", null, undefined], "handed back");
  await s.autopilot.pollSellOrders();
  assert.equal(s.desk.localView(id)?.lastError, "could not read the order from Amboss: Amboss HTTP 502", "true while Amboss is down");
  s.magma.readBehaviour = "ok";
  await s.autopilot.pollSellOrders();
}

test("selling off: the operator's accept, its answer lost, handed back while Amboss is down for several passes — the first pass that reads the order again says it is theirs, not that it can't be read", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  s.magma.behave.AcceptOrder = "throw";
  assert.equal((await s.desk.accept(sale.id)).ok, false);
  await handedBackDuringOutage(s, sale.id);
  // Before: "could not read the order from Amboss: Amboss HTTP 502" on both.
  leftToThem(s, sale.id, "the pass that reads Amboss again", { accepts: 1 });
  saysTheirs(s.autopilot, sale.id, "the pass that reads Amboss again");
});

test("selling switched off since: the lane's own accept, its answer lost, handed back while Amboss is down for several passes — the first pass that reads the order again says it is the operator's now", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const id = await laneAcceptLost(s);
  await handedBackDuringOutage(s, id);
  // Before: "could not read the order from Amboss: Amboss HTTP 502" on both.
  releasedToOperator(s, id, s.autopilot, "the pass that reads Amboss again");
});

// The same for an order the operator is deciding whose read fails for a pass —
// Amboss down, or refusing to show that one order with the key fine — and then
// works again. Only what the failed read noted goes: an error of their accept
// itself stays, as a read doesn't make it stale.
for (const c of [
  {
    name: "Amboss down",
    unreadable: (s: Setup) => {
      s.magma.readBehaviour = "throw";
    },
    readable: (s: Setup) => {
      s.magma.readBehaviour = "ok";
    },
    noted: "could not read the order from Amboss: Amboss HTTP 502",
  },
  {
    name: "Amboss refusing to show the order, the key fine",
    unreadable: (s: Setup) => {
      s.magma.saleRead = () => forbidden("Sale");
    },
    readable: (s: Setup) => {
      s.magma.saleRead = null;
    },
    noted: "Amboss refused to show this order (Forbidden resource)",
  },
]) {
  test(`selling off: an order the operator is deciding whose read fails for a pass (${c.name}) — once it reads again, its record says it is theirs, not that it can't be read`, async (t) => {
    quiet(t);
    const s = sellerSetup(t, { config: { sellEnabled: false } });
    const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
    s.magma.behave.AcceptOrder = "false";
    const click = await s.desk.accept(sale.id);
    assert.deepEqual([click.ok, click.message], [false, "Amboss refused the accept"]);
    await s.autopilot.pollSellOrders();
    assert.equal(s.desk.localView(sale.id)?.lastError, "Amboss refused the accept", "about their accept, not the read: a read keeps it");
    c.unreadable(s);
    await s.autopilot.pollSellOrders();
    assert.equal(s.desk.localView(sale.id)?.lastError, c.noted, "true while the order can't be read");
    c.readable(s);
    await s.autopilot.pollSellOrders();
    // Before: the failed read's note on both, pass after pass.
    leftToThem(s, sale.id, c.name, { accepts: 1 });
    saysTheirs(s.autopilot, sale.id, c.name);
  });
}

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
      `${c.said} Your reject stands: the order lane sends it again until Amboss confirms it or the order ends, and won't accept this order.`,
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

// ── an accept already sent: completed first ──────────────────────────────────

// Review of P9, final round: the docs said a click "makes the order yours,
// whatever becomes of the click", and that "their latest click stands". Not
// for an order with an accept already sent whose answer was lost: an accept
// that may have reached Amboss is completed first (resumeAccept — whatever the
// switch says), and a Reject meanwhile is refused — said "Order is already
// accepting here.", though Amboss still showed the order awaiting approval.
// The behaviour stays; the docs say so now, and the refusal says why.
for (const sellEnabled of [true, false]) {
  test(`selling ${sellEnabled ? "on" : "off"}: the operator's accept went out and its answer was lost — their Reject is refused, saying why, and the next pass completes the accept`, async (t) => {
    quiet(t);
    const s = sellerSetup(t, { config: { sellEnabled } });
    const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
    s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
    const accepted = await s.desk.accept(sale.id);
    assert.deepEqual([accepted.ok, accepted.phase], [false, "accepting"], accepted.message);
    assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "Amboss shows it awaiting approval still");
    const click = await s.desk.reject(sale.id);
    assert.deepEqual(click, {
      ok: false,
      code: "bad_status",
      phase: "accepting",
      message: "Not rejected: the earlier accept of this order was already sent and is being confirmed with Amboss, so it can't be withdrawn.",
    });
    await s.autopilot.pollSellOrders();
    assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [2, 0]);
    assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
    const e = entryOnDisk(s.dir, sale.id);
    assert.deepEqual([e?.phase, e?.via, e?.decision?.reason], ["accepted", "manual", "accepted by you"]);
  });
}

test("the operator's accept cut short by a stop before it was sent: a Reject clicked before the restarted lane's first pass is refused, saying so — and that pass completes the accept", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  const died = crashAt(s.desk, "lndCreateHodl", "before");
  void s.desk.accept(sale.id);
  await until(died, "the invoice was being made");
  assert.deepEqual([entryOnDisk(s.dir, sale.id)?.phase, entryOnDisk(s.dir, sale.id)?.acceptSentAt], ["accepting", undefined], "never sent");
  const p2 = s.restart();
  const click = await p2.magma.reject(sale.id);
  // Not "already sent": it never left.
  assert.deepEqual(click, {
    ok: false,
    code: "bad_status",
    phase: "accepting",
    message: "Not rejected: an accept of this order was under way when LightningMate stopped — the order lane completes or withdraws it on its next pass.",
  });
  await p2.pollSellOrders();
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 0]);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
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
// meanwhile against what it asked for — the order stays as the lane left it.
// The docs now state that limit (docsMatchCode.test.ts); these tests pin it.
// Final round: a click that finds the order as it asked — rejected by the
// lane's resend of the operator's own reject, accepted by the lane — is told
// it is done, not refused.

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

/** Amboss holds the lane's `mutation` — not answering — until the gate opens. */
const mutationHeld = (s: Setup, mutation: "RejectOrder" | "AcceptOrder") => (gate: Promise<void>) => {
  let held = false;
  s.magma.holdMutation = (op) => {
    if (op !== mutation) return null;
    held = true;
    return gate;
  };
  return () => held;
};
const rejectHeld = (s: Setup) => mutationHeld(s, "RejectOrder");

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

test("the operator's reject didn't go through; their Reject, clicked again while the lane sends it again, waits for that step — and is told the order is rejected: done, not refused", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await rejectFails(s, sale.id);
  const click = await clickMidStep(s, rejectHeld(s), () => s.desk.reject(sale.id));
  // Before: refused (409), "Order is SELLER_REJECTED — only orders awaiting
  // approval can be rejected." — for an order rejected as the click asked.
  assert.deepEqual(click, { ok: true, message: "Order is already rejected." });
  assert.equal(s.magma.count("RejectOrder"), 2, "the first click's, and the pass's: the second click sends none");
  rejectedByThem(s, sale.id, "the resend under way");
});

test("selling on: an Accept clicked while the lane accepts the same order waits for that step — and is told the order is accepted: done, not refused; one accepted outside LightningMate is still refused", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  const click = await clickMidStep(s, mutationHeld(s, "AcceptOrder"), () => s.desk.accept(sale.id));
  // Before: "Order is WAITING_FOR_BUYER_PAYMENT, not awaiting approval." —
  // for an order accepted as the click asked.
  assert.deepEqual(click, { ok: true, phase: "accepted", message: "Order is already accepted." });
  assert.deepEqual([s.magma.count("AcceptOrder"), s.magma.count("RejectOrder")], [1, 0], "the lane's accept: the click sends none");
  assert.equal(s.node.callsTo("invoices.addHoldInvoice").length, 1, "one invoice");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via, e?.decision?.reason], ["accepted", "autopilot", "within your caps and capital"], "the click changed nothing");
  // An order accepted outside LightningMate has no accept of ours behind it:
  // no channel of this app's follows (acceptedElsewhere) — not "done".
  const elsewhere = s.magma.addSale({ buyerPubkey: BUYER, status: "WAITING_FOR_BUYER_PAYMENT" });
  assert.deepEqual(await s.desk.accept(elsewhere.id), { ok: false, code: "bad_status", message: "Order is WAITING_FOR_BUYER_PAYMENT, not awaiting approval." });
});

// Review of P10: the guards of those "done" answers had no test — with any one
// of them dropped, every test stayed green, and a click asking for what the
// order is NOT was told it was done (the web then says "Order rejected." or
// "Order accepted — …"). A click that asks for something else is refused, as
// before.
test("'done' only for what the order is: a Reject on an order that timed out, and an Accept on one Amboss ended, on one only seen here or on one ended here, are refused as before", async (t) => {
  quiet(t);
  {
    // Timed out on Amboss: failed, not rejected.
    const s = sellerSetup(t, { config: { sellEnabled: false } });
    const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
    s.magma.setStatus(sale.id, "SELLER_FAILED_TO_REACT");
    assert.deepEqual(
      await s.desk.reject(sale.id),
      { ok: false, code: "bad_status", message: "Order is SELLER_FAILED_TO_REACT — only orders awaiting approval can be rejected." },
      "a Reject on an order that timed out",
    );
  }
  {
    // An accept of ours went out, its answer lost — and Amboss ended the
    // order: not accepted, whatever is under way here.
    const s = sellerSetup(t, { config: { sellEnabled: false } });
    const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
    s.magma.behave.AcceptOrder = "throw";
    assert.equal((await s.desk.accept(sale.id)).ok, false);
    assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepting");
    s.magma.setStatus(sale.id, "SELLER_FAILED_TO_REACT");
    assert.deepEqual(
      await s.desk.accept(sale.id),
      { ok: false, code: "bad_status", message: "Order is SELLER_FAILED_TO_REACT, not awaiting approval." },
      "an Accept on an order with an accept of ours under way, ended by Amboss",
    );
  }
  {
    // Only seen here — the lane waits for Amboss to report its fee — and
    // accepted on amboss.tech: no accept of ours behind it.
    const s = sellerSetup(t);
    const sale = s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: IN_AN_HOUR() });
    await s.autopilot.pollSellOrders();
    const seen = entryOnDisk(s.dir, sale.id);
    assert.deepEqual([seen?.phase, seen?.decision?.reason], ["seen", "waiting for Amboss to report the order's fee"]);
    s.magma.setStatus(sale.id, "WAITING_FOR_BUYER_PAYMENT");
    assert.deepEqual(
      await s.desk.accept(sale.id),
      { ok: false, code: "bad_status", message: "Order is WAITING_FOR_BUYER_PAYMENT, not awaiting approval." },
      "an Accept on an order only seen here, accepted elsewhere",
    );
  }
  {
    // Ended here — its invoice cancelled before the buyer paid — while Amboss
    // shows it paid: nothing of ours carries it on.
    const s = sellerSetup(t, { config: { sellEnabled: false } });
    const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
    const accepted = await s.desk.accept(sale.id);
    assert.equal(accepted.ok, true, accepted.message);
    s.node.expireHoldInvoice(entryOnDisk(s.dir, sale.id)!.invoice!.id);
    await s.autopilot.pollSellOrders();
    assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "cancelled");
    s.magma.setStatus(sale.id, "WAITING_FOR_CHANNEL_OPEN");
    assert.deepEqual(
      await s.desk.accept(sale.id),
      { ok: false, code: "bad_status", message: "Order is WAITING_FOR_CHANNEL_OPEN, not awaiting approval." },
      "an Accept on an order ended here",
    );
  }
});

// ── the run history: whose change it was ─────────────────────────────────────

// Review of P9, final round: the lane's resend of the operator's own reject,
// once Amboss confirmed it, read as "Last change by the autopilot" on the
// Overview — lastAutopilotActionAt counted every sell action that landed.
// The lane carrying out a decision made by hand is the operator's change.
test("the lane carrying out the operator's decision is not 'Last change by the autopilot' — their reject sent again, their accept completed; the lane's own reject is", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxChannelSats: 5_000_000 } });
  const verdicts = (id: string) => historyFor(s.autopilot, id).map((a) => [a.action, a.ok, a.via]);
  // Their reject, its click failing: the next pass sends it again, and Amboss takes it.
  const theirReject = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  await rejectFails(s, theirReject.id);
  await s.autopilot.pollSellOrders();
  rejectedByThem(s, theirReject.id, "their reject, sent again");
  assert.deepEqual(verdicts(theirReject.id), [["reject", true, "manual"]]);
  // Before: the time of that pass.
  assert.equal(s.autopilot.getState().lastActionAt, null, "their reject sent again");
  // Their accept, its answer lost: the next pass sends it again, and Amboss takes it.
  const theirAccept = s.magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
  assert.equal((await s.desk.accept(theirAccept.id)).ok, false);
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, theirAccept.id)?.phase, "accepted");
  assert.deepEqual(verdicts(theirAccept.id), [["accept", true, "manual"]]);
  assert.equal(s.autopilot.getState().lastActionAt, null, "their accept completed");
  // The lane's own decision — an order above its caps, turned down — is its change.
  const lanes = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 8_000_000, timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.deepEqual(verdicts(lanes.id), [["reject", true, undefined]]);
  const line = s.autopilot.getState().history.find((r) => r.sells.some((a) => a.orderId === lanes.id));
  assert.ok(line, "the lane's reject is in the run history");
  assert.equal(s.autopilot.getState().lastActionAt, line.at);
});
