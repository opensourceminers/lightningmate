/**
 * The order lane deciding on new orders (D6): accept with a HODL invoice when
 * the order can be served, reject at once — with the reason on record — when
 * it can't, and never leave an order to time out because a check before the
 * accept could not be made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonStore } from "../src/store.js";
import { internalError } from "./helpers/magma.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import {
  IN_AN_HOUR,
  entryOnDisk,
  historyFor,
  quiet,
  walletBalance,
} from "./helpers/lifecycle.js";

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

test("an order whose fee Amboss never reports is rejected before its approval deadline, not left to time out", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 60_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /no fee/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "never an invoice for 0 sat");
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
