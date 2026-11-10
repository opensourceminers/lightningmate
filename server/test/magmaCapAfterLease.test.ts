// "Capital to sell" and sold channels left open after their lease (review
// 2026-11-10, LANE-7).
//
// The cap counted running leases only: once Amboss listed a lease as over,
// its channel stopped counting — with its coins still in it — and the lane
// sold the next channel on top. With auto-close off (or a channel kept by
// its rules) the coins in once-sold channels grew past the cap, term by
// term. Such a channel now counts with what is still on this node's side
// until it is closed, and where the cap turns an order down the reason says
// so.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { afterLeaseNote } from "../src/services/magmaDesk.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { entryOnDisk, feeEnv, quiet } from "./helpers/lifecycle.js";

const OTHER = "03" + "cd".repeat(32);
const TXID = "ce".repeat(32);

/** A cap of 3,000,000 and one 2,000,000 sat channel sold to OTHER — open,
 *  `local` of it on this node's side — that Amboss lists with `status`. */
function soldBefore(t: TestContext, status: string, local: number) {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxDeploySats: 3_000_000 } });
  s.node.peers.push(BUYER, OTHER);
  s.node.channels.push({ id: "850000x7x0", partnerPublicKey: OTHER, capacity: 2_000_000, localBalance: local, transactionId: TXID, transactionVout: 0 });
  const old = s.magma.addSale({ buyerPubkey: OTHER, status, channelId: "850000x7x0", transactionId: `${TXID}:0`, sizeSats: 2_000_000 });
  return { s, old };
}
const order = (s: ReturnType<typeof sellerSetup>) => s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });

test("a sold channel still open after its lease counts against the cap with the coins left in it — before, the next order was sold on top", async (t) => {
  const { s } = soldBefore(t, "CHANNEL_MONITORING_FINISHED", 1_990_000);
  const sale = order(s);
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "rejected", "before: accepted — 4,000,000 sat in sold channels under a cap of 3,000,000");
  assert.equal(
    e?.reason,
    "deploy cap reached (1,990,000 sat already sold or promised, cap 3,000,000 sat; 1,990,000 sat of the cap is in 1 sold channel still open after its lease" +
      " — closing it (Channels) or raising “Capital to sell” makes room)",
  );
  assert.deepEqual(s.autopilot.getState().sellAfterLease, { channels: 1, sats: 1_990_000 });
  assert.equal(s.autopilot.getState().sellDeployRoomSat, 1_010_000);
  // Closed: its coins are back on chain, and the cap has room again.
  s.node.channels.length = 0;
  const next = order(s);
  await s.autopilot.magma.refreshDeployed(true);
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, next.id)?.phase, "accepted");
  assert.deepEqual(s.autopilot.getState().sellAfterLease, { channels: 0, sats: 0 });
});

test("what counts is what is still on this node's side: a channel the buyer has used up leaves the cap its room", async (t) => {
  const { s } = soldBefore(t, "CHANNEL_MONITORING_FINISHED", 150_000);
  const sale = order(s);
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
  assert.deepEqual(s.autopilot.getState().sellAfterLease, { channels: 1, sats: 150_000 });
});

test("while the lease runs the channel counts with its sold size, as ever — and not a second time as a channel after its lease", async (t) => {
  const { s } = soldBefore(t, "VALID_CHANNEL_OPENING", 1_990_000);
  const sale = order(s);
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.reason, "deploy cap reached (2,000,000 sat already sold or promised, cap 3,000,000 sat)");
  assert.deepEqual(s.autopilot.getState().sellAfterLease, { channels: 0, sats: 0 });
});

test("a channel two finished sales name counts once", async (t) => {
  const { s } = soldBefore(t, "CHANNEL_MONITORING_FINISHED", 1_990_000);
  // The same channel, named by a second finished order (a renewed lease).
  s.magma.addSale({ buyerPubkey: OTHER, status: "CHANNEL_MONITORING_FINISHED", channelId: "850000x7x0", sizeSats: 1_000_000 });
  await s.autopilot.magma.refreshDeployed(true);
  assert.deepEqual(s.autopilot.getState().sellAfterLease, { channels: 1, sats: 1_990_000 });
});

test("the note names how many channels and what makes room; with none, it says nothing", () => {
  assert.equal(afterLeaseNote({ channels: 0, sats: 0 }), "");
  assert.equal(
    afterLeaseNote({ channels: 3, sats: 4_500_000 }),
    "; 4,500,000 sat of the cap is in 3 sold channels still open after their lease — closing them (Channels) or raising “Capital to sell” makes room",
  );
});

// Offer upkeep says the same where the cap leaves an offer no room (review
// of the package: the two notes had no test).
const NOTE = (sat: string) => `; ${sat} sat of the cap is in 1 sold channel still open after its lease — closing it (Channels) or raising “Capital to sell” makes room`;

test("an offer disabled because the cap leaves its smallest channel no room: the reason names the sold channel still open after its lease", async (t) => {
  const { s } = soldBefore(t, "CHANNEL_MONITORING_FINISHED", 1_990_000);
  // 3,000,000 cap, 1,990,000 of it in the old channel: 1,010,000 left.
  const offer = s.magma.addOffer({ minSats: 1_500_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await s.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED");
  assert.equal(
    s.autopilot.offerSyncStatus().offers.find((o) => o.offerId === offer.id)?.differences.join(),
    "disabled by the autopilot for lack of capital: its smallest channel (1,500,000 sat) can't be funded — 1,010,000 sat sellable after the reserve, promised orders and the deploy cap; it is listed again once it can be" +
      NOTE("1,990,000"),
  );
});

test("…and without such a channel the reason says nothing of one", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxDeploySats: 1_000_000 } });
  const offer = s.magma.addOffer({ minSats: 1_500_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await s.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED");
  assert.doesNotMatch(s.autopilot.offerSyncStatus().offers.find((o) => o.offerId === offer.id)?.differences.join() ?? "", /still open after/);
});

test("no offer listed because the cap is used up by a sold channel still open after its lease: the decision says so", async (t) => {
  feeEnv(t);
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxDeploySats: 3_000_000, sellAutoReprice: true } });
  s.node.peers.push(OTHER);
  s.node.channels.push({ id: "850000x7x0", partnerPublicKey: OTHER, capacity: 3_200_000, localBalance: 3_100_000, transactionId: TXID, transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: OTHER, status: "CHANNEL_MONITORING_FINISHED", channelId: "850000x7x0", transactionId: `${TXID}:0`, sizeSats: 3_200_000 });
  // Comparable offers that sell: listing would be worth it.
  for (let i = 0; i < 6; i++) s.market.addOffer({ totalSats: 1_500_000 + i * 500_000, sellerScore: i * 3, filledOrders: 24, monthsListed: 6 });
  await s.autopilot.runOnce();
  assert.equal(s.magma.calls.filter((c) => c.op === "CreateOffer").length, 0);
  assert.equal(
    s.autopilot.getState().decisions.magma?.text,
    "no offer listed: only 0 sat could be listed after the reserve, promised orders and the deploy cap — below the smallest channel worth selling (1,000,000 sat)" + NOTE("3,100,000"),
  );
});

test("a channel whose lease was renewed — one finished sale and one running sale name it — counts once, with the running sale's size", async (t) => {
  const { s } = soldBefore(t, "CHANNEL_MONITORING_FINISHED", 1_990_000);
  s.magma.addSale({ buyerPubkey: OTHER, status: "VALID_CHANNEL_OPENING", channelId: "850000x7x0", sizeSats: 2_000_000 });
  assert.equal(await s.autopilot.magma.refreshDeployed(true), 2_000_000, "not 3,990,000");
  assert.deepEqual(s.autopilot.getState().sellAfterLease, { channels: 0, sats: 0 });
});

test("a listing too old to decide on says nothing of channels after their lease either", async (t) => {
  const { s } = soldBefore(t, "CHANNEL_MONITORING_FINISHED", 1_990_000);
  await s.autopilot.magma.refreshDeployed(true);
  assert.deepEqual(s.autopilot.magma.afterLease(), { channels: 1, sats: 1_990_000 });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 3_600_000 });
  assert.deepEqual(s.autopilot.magma.afterLease(), { channels: 0, sats: 0 });
});
