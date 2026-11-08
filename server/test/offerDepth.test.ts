/**
 * Listing more capital (the 10M offer, 2026-11-08), and the alert for a peer
 * that is gone. The capital cap decides what is listed, the wallet whether it
 * can be: what Amboss still counts as locked from earlier sales stays out of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAlerts, OFFLINE_ALERT_HOURS } from "../src/services/alerts.js";
import { autoSizedWindow } from "../src/services/magmaRecommend.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import { sellerSetup } from "./helpers/autopilot.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { quiet } from "./helpers/lifecycle.js";

const AUTO = { sellAutoSize: true, sellAutoReprice: false, sellAutoRelist: true, sellMaxDeploySats: 10_000_000, sellMaxChannelSats: 5_000_000 };
const LIVE_OFFER = { minSats: 250_000, maxSats: 2_000_000, totalSats: 4_500_000, lockedSats: 2_500_000, feeRatePpm: 4280, baseFeeSats: 284, feeRateCap: "2200", baseFeeCap: "1" };

test("a cap of 10M with the coins there: 10M listed beside what is locked from earlier sales, channels up to the max channel size", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  const offer = s.magma.addOffer(LIVE_OFFER);
  await s.autopilot.runOnce();
  assert.equal(offer.totalSats - offer.lockedSats, 10_000_000, JSON.stringify(s.autopilot.offerSyncStatus().offers[0]?.lastWrite));
  assert.equal(offer.totalSats, 12_500_000);
  assert.equal(offer.maxSats, 5_000_000, "orders up to the max channel size");
  assert.equal(offer.status, "ENABLED");
});

test("a cap of 10M with fewer coins: what the wallet can fund, in whole steps — its small moves don't rewrite the offer — and more once the coins are back", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 4_600_000, config: AUTO });
  const offer = s.magma.addOffer(LIVE_OFFER);
  await s.autopilot.runOnce();
  const first = offer.totalSats - offer.lockedSats;
  assert.ok(first >= 4_000_000 && first <= 4_500_000, `listed ${first}: ${JSON.stringify(s.autopilot.offerSyncStatus().offers[0]?.lastWrite)}`);
  const writes = s.magma.count("UpdateOffer");
  for (const balance of [4_590_000, 4_610_000, 4_595_000, 4_620_000, 4_600_000, 4_585_000, 4_615_000]) {
    s.node.chainBalance = balance;
    await s.autopilot.runOnce();
    const listed = offer.totalSats - offer.lockedSats;
    assert.ok(listed >= first && listed <= 4_500_000, `listed ${listed}`);
  }
  assert.ok(s.magma.count("UpdateOffer") - writes <= 1, `the wallet's small moves: ${s.magma.count("UpdateOffer") - writes} writes (one: it cleared the step, and it stays there)`);
  // A close comes back on chain: listed up to the cap on the next run.
  s.node.chainBalance = 18_000_000;
  await s.autopilot.runOnce();
  assert.equal(offer.totalSats - offer.lockedSats, 10_000_000, JSON.stringify(s.autopilot.offerSyncStatus().offers[0]?.lastWrite));
});

test("a size floor the mempool raised stays up for hours: fees hovering around a step don't rewrite the offer every run", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  // A market that pays: the smallest channel that pays for itself is well under 1M.
  __setHistoryForTests(Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_000_000, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })));
  t.after(() => __setHistoryForTests([]));
  for (let i = 0; i < 8; i++) s.market.addOffer({ totalSats: 5_000_000, minSats: 250_000, maxSats: 5_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: 284, sellerScore: 50 });
  const offer = s.magma.addOffer({ ...LIVE_OFFER, minSats: 1_000_000 });
  const raised = (s.autopilot as unknown as { offerFloorRaisedAt: Map<string, number> }).offerFloorRaisedAt;
  raised.set(offer.id, Date.now() - 60_000);
  offer.totalSats = 12_500_000;
  offer.maxSats = 5_000_000;
  await s.autopilot.runOnce();
  assert.equal(offer.minSats, 1_000_000, "raised a minute ago: stays");
  raised.set(offer.id, Date.now() - 7 * 3_600_000);
  await s.autopilot.runOnce();
  assert.ok(offer.minSats < 1_000_000, `hours later it comes down: ${offer.minSats}`);
});

test("two listed offers share the capital as they are set: neither takes it all", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  const a = s.magma.addOffer({ ...LIVE_OFFER, lockedSats: 0, totalSats: 2_000_000 });
  const b = s.magma.addOffer({ ...LIVE_OFFER, lockedSats: 0, totalSats: 2_000_000 });
  await s.autopilot.runOnce();
  assert.ok(a.totalSats < 10_000_000 && b.totalSats > 0, `${a.totalSats} / ${b.totalSats}`);
});

test("with an order pending nothing more is listed: what it holds isn't sold yet", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  const offer = s.magma.addOffer(LIVE_OFFER);
  s.magma.addSale({ buyerPubkey: "02" + "ab".repeat(32), sizeSats: 1_000_000, status: "WAITING_FOR_SELLER_APPROVAL", timeout: new Date(Date.now() + 3_600_000).toISOString() });
  (s.autopilot.magma as unknown as { ordersPending: () => number }).ordersPending = () => 1;
  await s.autopilot.runOnce();
  assert.equal(offer.totalSats - offer.lockedSats, 2_000_000, "listed as it was");
  assert.equal(offer.maxSats, 2_000_000, "nor a wider window, which would list it too");
  // Decided: the next run goes on.
  (s.autopilot.magma as unknown as { ordersPending: () => number }).ordersPending = () => 0;
  await s.autopilot.runOnce();
  assert.equal(offer.totalSats - offer.lockedSats, 10_000_000);
  assert.equal(offer.maxSats, 5_000_000);
});

test("what a capital cut took of the max goes back once there is room, however little it was (an order of exactly the old max fits again)", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: { ...AUTO, sellMaxChannelSats: 2_000_000 } });
  const offer = s.magma.addOffer(LIVE_OFFER);
  await s.autopilot.runOnce();
  assert.equal(offer.maxSats, 2_000_000);
  s.node.chainBalance = 2_030_000;
  await s.autopilot.runOnce();
  assert.ok(offer.maxSats < 2_000_000 && offer.maxSats > 1_950_000, `cut a little: ${offer.maxSats}`);
  s.node.chainBalance = 18_000_000;
  await s.autopilot.runOnce();
  assert.equal(offer.maxSats, 2_000_000);
});

test("the capital check after a spend only cuts: it lists no more, whatever the cap would allow", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  const offer = s.magma.addOffer(LIVE_OFFER);
  await s.autopilot.offerCapitalNow();
  assert.equal(offer.totalSats - offer.lockedSats, 2_000_000, "not raised");
  s.node.chainBalance = 1_200_000;
  await s.autopilot.offerCapitalNow();
  assert.ok(offer.totalSats - offer.lockedSats < 1_200_000, `cut: ${offer.totalSats - offer.lockedSats}`);
});

test("LND still starting isn't Amboss's fault: the upkeep says it couldn't work out the capital", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  s.magma.addOffer(LIVE_OFFER);
  await s.autopilot.runOnce(); // (the key is cached per connection, like the offer's)
  const fresh = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  fresh.magma.addOffer(LIVE_OFFER);
  fresh.node.override("default.getInfo", (_a, cb) => cb({ details: "waiting to start, RPC services not available" }));
  await fresh.autopilot.runOnce();
  const text = fresh.autopilot.getState().decisions.magma?.text ?? "";
  assert.doesNotMatch(text, /could not read your offers from Amboss/, text);
});

test("a shortage cuts to the step below, never under the largest order it takes: 'exhausted' it would stop repricing, and nothing bigger would sell", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 4_600_000, config: AUTO });
  const offer = s.magma.addOffer(LIVE_OFFER);
  await s.autopilot.runOnce();
  s.node.chainBalance = 3_600_000; // a 1M send
  await s.autopilot.runOnce();
  const listed = offer.totalSats - offer.lockedSats;
  assert.ok(listed >= offer.maxSats, `listed ${listed}, max ${offer.maxSats}`);
  assert.ok(listed <= 3_600_000, `listed ${listed}: fundable`);
  // A small wallet: what is left is still for sale.
  const small = sellerSetup(t, { chainBalance: 1_100_000, config: AUTO });
  const low = small.magma.addOffer({ ...LIVE_OFFER, lockedSats: 0, totalSats: 1_000_000, minSats: 950_000, maxSats: 1_000_000 });
  await small.autopilot.runOnce();
  assert.ok(low.totalSats - low.lockedSats >= low.minSats, `listed ${low.totalSats - low.lockedSats}, min ${low.minSats}`);
});

test("auto-relist off: what a sale took stays out, and nothing is listed up to the cap on upgrade", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: { ...AUTO, sellAutoRelist: false } });
  const offer = s.magma.addOffer({ ...LIVE_OFFER, lockedSats: 2_500_000, totalSats: 5_500_000, maxSats: 3_000_000 });
  await s.autopilot.runOnce();
  assert.ok(offer.totalSats - offer.lockedSats < 10_000_000, `listed ${offer.totalSats - offer.lockedSats}`);
});

test("an offer disabled beside a listed one isn't starved: with two offers neither is listed up to the cap", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  const a = s.magma.addOffer({ ...LIVE_OFFER, lockedSats: 0, totalSats: 2_000_000 });
  s.magma.addOffer({ ...LIVE_OFFER, lockedSats: 0, totalSats: 2_000_000, status: "DISABLED" });
  await s.autopilot.runOnce();
  assert.ok(a.totalSats - a.lockedSats < 10_000_000, `listed ${a.totalSats - a.lockedSats}`);
});

test("the size floor's hold reaches the engine: it prices the window the upkeep writes, and comes down only with the hold", () => {
  const off = { minSizeSats: 400_000, maxSizeSats: 2_000_000 };
  assert.deepEqual(autoSizedWindow(off, 250_000, 2_000_000), { minSizeSats: 250_000, maxSizeSats: 2_000_000 });
  assert.equal(autoSizedWindow(off, 250_000, 2_000_000, true), null, "held: as it is");
  assert.deepEqual(autoSizedWindow(off, 250_000, 5_000_000, true), { minSizeSats: 400_000, maxSizeSats: 5_000_000 }, "a wider max doesn't bring the floor down");
  assert.deepEqual(autoSizedWindow(off, 600_000, 2_000_000, true), { minSizeSats: 600_000, maxSizeSats: 2_000_000 }, "up: at once");
});

test("the Magma decision says why an offer was written", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 18_000_000, config: AUTO });
  s.magma.addOffer(LIVE_OFFER);
  await s.autopilot.runOnce();
  const text = s.autopilot.getState().decisions.magma?.text ?? "";
  assert.match(text, /^resized offer .*…: /, text);
});

test("a peer gone for a week or more: the alert names it and what is stuck there; a short outage doesn't", async () => {
  const node = new FakeLnd({ peers: [] });
  node.channels.push({ id: "850000x1x0", partnerPublicKey: "02" + "aa".repeat(32), capacity: 10_000_000, localBalance: 4_691_007, transactionId: "ab".repeat(32), transactionVout: 0, isActive: false });
  node.channels.push({ id: "850000x2x0", partnerPublicKey: "02" + "bb".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "ac".repeat(32), transactionVout: 0, isActive: false });
  node.channels.push({ id: "850000x3x0", partnerPublicKey: "02" + "cc".repeat(32), capacity: 2_000_000, localBalance: 0, transactionId: "ad".repeat(32), transactionVout: 0, isActive: false });
  const hours: Record<string, number> = { "850000x1x0": 16 * 24, "850000x2x0": OFFLINE_ALERT_HOURS - 1, "850000x3x0": 30 * 24 };
  const alerts = await getAlerts(node.lnd, [], (c) => hours[c.id] ?? null);
  const stuck = alerts.filter((a) => /has been offline/.test(a.message));
  assert.equal(stuck.length, 1, JSON.stringify(alerts));
  assert.match(stuck[0].message, /has been offline for 16 days — 4,691,007 sat of yours are stuck in that channel, earning nothing\. If it isn't coming back, Channels → Close gets them back\.$/);
  assert.equal(stuck[0].level, "warn");
  assert.ok(alerts.some((a) => a.message === "3 channels offline"), "the count stays");
  assert.deepEqual((await getAlerts(node.lnd, [])).filter((a) => /has been offline/.test(a.message)), [], "without the app's count: none");
});
