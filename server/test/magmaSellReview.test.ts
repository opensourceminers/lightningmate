/**
 * The full review of 2026-10-25 (Magma selling), on the live offer's terms:
 * 00479f19, 250k–2M per order, 4.5M listed, 2.5M locked by three 2025 sales,
 * 4,445 ppm + 0 sat, a 30-day lease, the promise 2,200 ppm + 1 sat; auto-
 * pricing, auto-size and auto-relist on, a 2M deploy cap.
 *
 *  - M1: no offer invites orders the order lane turns down as below cost —
 *    with auto-size its min goes up to the smallest order that pays for its
 *    channel at today's fee rate, and when none it can fund does, it is
 *    taken off the market until fees drop; an offer whose window is the
 *    operator's says from which size orders are turned down.
 *  - M2: a listed offer under its profit floor is raised first.
 *  - M3: nothing is topped up or given back while an order holds part of an
 *    offer unsold, and two offers share what can be sold.
 *  - M4: an invoice billed from an order's fee parts (fees.seller 0) only
 *    when they are the offer's price for the size.
 *  - M5/M6: the deploy cap's share — a listing that fails, an order funded
 *    inside its cache; an Accept below cost only with a yes; a sale opened
 *    elsewhere still binds its promise; a sold channel's starting fee and
 *    tag; an order found without a record and fast blocks.
 *  - O5: a spend outside the main run checks the offers' capital at once.
 *  - The texts: the fundable figure, "waiting on you", "closable soon".
 *  - P10's leftovers: the lane's unconfirmed reject with selling off since;
 *    a stale accept released before a Reject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { IN_AN_HOUR, entryOnDisk, quiet } from "./helpers/lifecycle.js";
import { internalError } from "./helpers/magma.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import { minSizeCoveringSat, orderFeeSat, saleAcceptFloorSats } from "../src/services/magmaRecommend.js";
import { offerPriceAlerts } from "../src/services/alerts.js";
import { activeCap } from "../src/services/leaseCaps.js";
import { SELLING_OFF_SKIP } from "../src/services/magmaDesk.js";
import type { AfterHook } from "./helpers/tmp.js";

const LIVE_ID = "00479f19-540f-4ce5-83fa-9e13c85269e1";
const LIVE_OFFER = {
  id: LIVE_ID,
  status: "ENABLED",
  minSats: 250_000,
  maxSats: 2_000_000,
  totalSats: 4_500_000,
  lockedSats: 2_500_000,
  feeRatePpm: 4445,
  baseFeeSats: 0,
  minBlockLength: 4320,
  feeRateCap: "2200",
  baseFeeCap: "1",
  filledOrders: 3,
};
const LIVE_CONFIG = {
  sellEnabled: true,
  sellMaxDeploySats: 2_000_000,
  sellMaxChannelSats: 5_000_000,
  sellReserveSats: 50_000,
  sellAutoReprice: true,
  sellAutoSize: true,
  sellAutoRelist: true,
  sellAutoClose: true,
  sellPricingMode: "balanced",
};
const aprFor = (ppm: number) => (ppm / 1e6) * (52_560 / 4320);

function liveSetup(
  t: AfterHook,
  opts: { feeSatPerVb?: number; chainBalance?: number; clearingPpm?: number; config?: Record<string, unknown>; offer?: Record<string, unknown> } = {},
) {
  const s = sellerSetup(t, { chainBalance: opts.chainBalance ?? 4_000_000, config: { ...LIVE_CONFIG, ...opts.config } });
  for (let i = 0; i < 20; i++) {
    s.market.addOffer({ totalSats: 5_000_000, minSats: 250_000, maxSats: 5_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: 568, sellerScore: 50 });
  }
  const clear = opts.clearingPpm ?? 4445;
  __setHistoryForTests(
    Array.from({ length: 40 }, (_, i) => ({
      at: Date.now() - i * 2 * 86_400_000,
      sizeSat: [300_000, 500_000, 1_000_000, 1_500_000, 2_000_000][i % 5],
      blocks: 4320,
      apr: aprFor(clear),
      leasePpm: clear,
      status: "FINISHED",
    })),
  );
  t.after(() => __setHistoryForTests([]));
  if (opts.feeSatPerVb !== undefined) {
    const kw = String(opts.feeSatPerVb * 250);
    s.node.override("wallet.estimateFee", (_a, cb) => (cb as (e: unknown, r: unknown) => void)(null, { sat_per_kw: kw }));
  }
  const offer = s.magma.addOffer({ ...LIVE_OFFER, ...opts.offer });
  return { ...s, offer };
}
type Live = ReturnType<typeof liveSetup>;
const setFeeRate = (s: Live, satPerVb: number) => {
  s.node.override("wallet.estimateFee", (_a, cb) => (cb as (e: unknown, r: unknown) => void)(null, { sat_per_kw: String(satPerVb * 250) }));
  (s.autopilot as unknown as { saleFloor: unknown }).saleFloor = null; // the lane's 10-min cache of the floor
};
const entry = (s: Live, id = LIVE_ID) => s.autopilot.offerSyncStatus().offers.find((e) => e.offerId === id);
const control = (s: Live, id = LIVE_ID) => s.autopilot.offerControls()[id] ?? {};
const ops = (s: Live) => s.magma.calls.map((c) => c.op).filter((op) => op === "UpdateOffer" || op === "ToggleOffer");

// ── M1: never inviting orders the lane turns down as below cost ─────────────

test("M1: at 20 sat/vB the live offer's min goes up to the smallest order that pays for its channel — every order it invites is one the lane takes (before: 250k and 1M orders turned down, 'nothing to change')", async (t) => {
  quiet(t);
  const s = liveSetup(t, { feeSatPerVb: 20 });
  const floor = await s.autopilot.saleFeeFloorSats();
  // One number: the lane's floor is the engine's.
  assert.equal(floor, (await s.autopilot.magmaReport()).sell.acceptFloorSat);
  assert.equal(floor, saleAcceptFloorSats(20, 0));
  await s.autopilot.runOnce();
  const o = s.offer;
  assert.equal(o.status, "ENABLED");
  assert.ok(orderFeeSat(o.feeRatePpm, o.baseFeeSats, o.minSats) >= floor, `the smallest order pays ${orderFeeSat(o.feeRatePpm, o.baseFeeSats, o.minSats)} vs the lane's ${floor}`);
  assert.ok(o.minSats > 250_000);
  // An order at the new min is taken by the lane (the cost check passes).
  const fee = Math.ceil(orderFeeSat(o.feeRatePpm, o.baseFeeSats, o.minSats));
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: o.minSats, feeSeller: String(fee), timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", entryOnDisk(s.dir, sale.id)?.reason);
});

test("M1: the min raise comes from the price the offer is written with, and says why", async (t) => {
  quiet(t);
  // 5 sat/vB: 250k at 4,445 ppm pays 1,111 sat — under the 1,625 sat floor.
  const s = liveSetup(t, { feeSatPerVb: 5 });
  const floor = await s.autopilot.saleFeeFloorSats();
  assert.ok(orderFeeSat(4445, 0, 250_000) < floor, `${orderFeeSat(4445, 0, 250_000)} vs ${floor}`);
  await s.autopilot.runOnce();
  const o = s.offer;
  const want = minSizeCoveringSat(o.feeRatePpm, o.baseFeeSats, floor);
  assert.ok(o.minSats >= want, `${o.minSats} vs ${want}`);
  const reason = entry(s)?.lastWrite?.reason ?? "";
  assert.ok(
    reason.includes("a smaller order pays less than opening and closing its channel costs") || reason.includes("size window set from the smallest channel that pays for itself"),
    reason,
  );
});

test("M1: when not even the largest order it can fund pays for its channel, the offer is taken off the market — and listed again, its terms first, once fees drop", async (t) => {
  quiet(t);
  // A 600k deploy cap: at 25 sat/vB no order up to 600k covers the floor at the engine's price.
  const s = liveSetup(t, { feeSatPerVb: 25, config: { sellMaxDeploySats: 600_000 } });
  await s.autopilot.runOnce();
  assert.equal(s.offer.status, "DISABLED", JSON.stringify(entry(s)?.differences));
  assert.ok(control(s).costDisabledAt, "recorded as the autopilot's below-cost disable");
  assert.match(entry(s)?.lastWrite?.reason ?? "", /^below cost at today's on-chain fee rate/);
  assert.ok(entry(s)?.differences.some((d) => d.startsWith("taken off the market by the autopilot below cost")), JSON.stringify(entry(s)?.differences));
  // Still too dear: it stays off.
  await s.autopilot.runOnce();
  assert.equal(s.offer.status, "DISABLED");
  // Fees drop: its terms are written and checked, then it is listed.
  setFeeRate(s, 1);
  const opsBefore = ops(s).length;
  await s.autopilot.runOnce();
  assert.equal(s.offer.status, "ENABLED");
  assert.deepEqual(ops(s).slice(opsBefore, opsBefore + 2), ["UpdateOffer", "ToggleOffer"], "terms first");
  assert.equal(control(s).costDisabledAt, undefined);
  const floor = await s.autopilot.saleFeeFloorSats();
  assert.ok(orderFeeSat(s.offer.feeRatePpm, s.offer.baseFeeSats, s.offer.minSats) >= floor);
});

test("M1: an offer whose terms are the operator's (or with auto-size off) keeps its window — the sync record, an alert and Market → Sell say from which size orders are turned down", async (t) => {
  quiet(t);
  for (const variant of ["taken over", "auto-size off"] as const) {
    const s = liveSetup(t, { feeSatPerVb: 5, config: variant === "auto-size off" ? { sellAutoSize: false } : {} });
    if (variant === "taken over") s.autopilot.pauseOfferAutomation(LIVE_ID, "you edited this offer");
    await s.autopilot.runOnce();
    assert.equal(s.offer.minSats, 250_000, variant);
    const floor = await s.autopilot.saleFeeFloorSats();
    const e = entry(s);
    const under = minSizeCoveringSat(s.offer.feeRatePpm, s.offer.baseFeeSats, floor);
    assert.equal(e?.turnedDownUnderSat, under, variant);
    assert.ok(e?.differences.some((d) => d.startsWith(`orders under ${under.toLocaleString("en-US")} sat pay less than opening and closing their channel costs`)), JSON.stringify(e?.differences));
    const alerts = offerPriceAlerts(s.autopilot.offerSyncStatus(), true);
    assert.ok(alerts.some((a) => a.message.includes(`orders under ${under.toLocaleString("en-US")} sat`)), JSON.stringify(alerts));
  }
});

// ── M2: under the profit floor, raised first ────────────────────────────────

test("M2: a listed offer under its profit floor is raised first — before 'above what comparable offers ask' or 'doesn't beat routing', which never reprice (4,445 ppm against a 10k+ floor stayed there)", async (t) => {
  quiet(t);
  const s = liveSetup(t, { feeSatPerVb: 20 });
  const rec = (await s.autopilot.magmaReport()).sell.recommendations.find((r) => r.offerId === LIVE_ID)!;
  assert.ok(rec.economics.profitFloorEffectivePpm > 4445, `${rec.economics.profitFloorEffectivePpm}`);
  assert.deepEqual([rec.state, rec.shouldReprice, rec.repriceDirection], ["below_profit_floor", true, "up"]);
  await s.autopilot.runOnce();
  const eff = s.offer.feeRatePpm + (s.offer.baseFeeSats / Math.sqrt(s.offer.minSats * s.offer.maxSats)) * 1e6;
  const after = (await s.autopilot.magmaReport()).sell.recommendations.find((r) => r.offerId === LIVE_ID)!;
  assert.ok(eff >= after.economics.profitFloorEffectivePpm - 1, `${eff} vs ${after.economics.profitFloorEffectivePpm}`);
  assert.match(entry(s)?.lastWrite?.reason ?? "", /below its profit floor \([\d,]+ ppm effective\) — raised to the engine's/);
  // At its floor exactly (rounded up), it isn't "below" it.
  s.offer.feeRatePpm = after.economics.profitFloorEffectivePpm;
  s.offer.baseFeeSats = 0;
  const at = (await s.autopilot.magmaReport()).sell.recommendations.find((r) => r.offerId === LIVE_ID)!;
  assert.notEqual(at.state, "below_profit_floor");
});

// ── M3: nothing topped up or given back while an order holds part ──────────

test("M3: a run while an order waits for approval doesn't top the offer back up (before: 4.5M → 6.45M, and the next order was refused for capital)", async (t) => {
  quiet(t);
  const s = liveSetup(t, { feeSatPerVb: 1 });
  await s.autopilot.runOnce();
  const total = s.offer.totalSats;
  // Amboss matched a 1.95M order to the offer: it locks it while it waits for approval.
  s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_950_000, feeSeller: "8668", timeout: IN_AN_HOUR() });
  s.offer.lockedSats += 1_950_000;
  await s.autopilot.runOnce();
  assert.equal(s.offer.totalSats, total, "not topped up while it waits");
  assert.ok(entry(s)?.differences.some((d) => d.startsWith("not topped back up: 1 order waits for approval")), JSON.stringify(entry(s)?.differences));
});

test("M3: an order rejected while it waited leaves no over-listed offer behind — what is listed stays within what can be sold", async (t) => {
  quiet(t);
  const s = liveSetup(t, { feeSatPerVb: 1 });
  await s.autopilot.runOnce();
  const zero = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_950_000, feeSeller: "0", createdAt: new Date(Date.now() - 120_000).toISOString(), timeout: IN_AN_HOUR() });
  s.offer.lockedSats += 1_950_000;
  await s.autopilot.runOnce(); // while it waits: not topped up
  await s.autopilot.pollSellOrders(); // the lane rejects it
  assert.equal(s.magma.sales.get(zero.id)?.status, "SELLER_REJECTED");
  s.offer.lockedSats -= 1_950_000; // Amboss releases the lock
  await s.autopilot.runOnce();
  const sellable = (await s.autopilot.sellCapital()).listableSat;
  assert.ok(s.offer.totalSats - s.offer.lockedSats <= sellable, `${s.offer.totalSats - s.offer.lockedSats} listed vs ${sellable} sellable`);
});

test("M3: two offers share what can be sold — never each listing all of it", async (t) => {
  quiet(t);
  const s = liveSetup(t, { feeSatPerVb: 1 });
  const second = s.magma.addOffer({ minSats: 250_000, maxSats: 2_000_000, totalSats: 2_000_000, lockedSats: 0, feeRatePpm: 4445, baseFeeSats: 0, minBlockLength: 4320, feeRateCap: "2200", baseFeeCap: "1" });
  await s.autopilot.runOnce();
  const sellable = (await s.autopilot.sellCapital()).listableSat;
  const listed = s.offer.totalSats - s.offer.lockedSats + (second.totalSats - second.lockedSats);
  assert.ok(listed <= sellable, `${listed} listed by the two vs ${sellable} sellable`);
});

// ── M5/M6: the deploy cap's share ───────────────────────────────────────────

test("M5: Amboss's listing of sold capital failing doesn't turn a fundable order down — the last good listing (under an hour old) decides, with this journal's own sales since", async (t) => {
  quiet(t);
  const s = liveSetup(t, { feeSatPerVb: 1 });
  await s.autopilot.runOnce(); // a good listing: nothing deployed
  s.magma.salesList = (f) => (f.status ? internalError() : null); // only the status-filtered listing fails now
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, feeSeller: "4445", timeout: new Date(Date.now() + 90_000).toISOString() });
  (s.autopilot.magma as unknown as { deployed: { at: number } }).deployed.at = Date.now() - 10 * 60_000; // its 30 s cache ran out
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", entryOnDisk(s.dir, sale.id)?.reason ?? entryOnDisk(s.dir, sale.id)?.lastError);
  // An hour on, no listing to go by: the order waits (and near its deadline is rejected), as before.
  (s.autopilot.magma as unknown as { deployed: { at: number } }).deployed.at = Date.now() - 61 * 60_000;
  const later = s.magma.addSale({ buyerPubkey: "02" + "ac".repeat(32), sizeSats: 500_000, feeSeller: "2223", timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(later.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
});

test("M6: an order funded inside the listing's 30 s cache still counts against the deploy cap — a second order can't get past it", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxDeploySats: 3_000_000 } });
  const desk = s.autopilot.magma as unknown as { deployed: { at: number }; refreshDeployed(force?: boolean): Promise<number> };
  const x = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(x.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  s.magma.buyerPays(x.id, s.node);
  desk.deployed.at = 0;
  await desk.refreshDeployed(true); // a listing while X is still promised (held)
  const y = s.magma.addSale({ buyerPubkey: "02" + "cd".repeat(32), sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders(); // X is opened (funded), then Y decided
  assert.equal(s.autopilot.magma.journal.get(x.id)?.phase, "reported");
  assert.equal(s.magma.sales.get(y.id)?.status, "SELLER_REJECTED", "before: accepted — 4M promised against a 3M cap");
  assert.match(s.autopilot.magma.journal.get(y.id)?.reason ?? "", /deploy cap reached/);
  assert.equal(s.capital.deployedSat(), 2_000_000, "X counted as deployed until a listing shows it");
});

// ── M4: the fee parts billed only when they are the offer's price ───────────

test("M4: fees.seller reading 0 — the lane bills the fee parts when they are the offer's price for the size (±1 sat), and leaves any other amount to the operator, neither accepted nor rejected", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellAutoReprice: false, sellAutoSize: false } });
  s.magma.addOffer({ minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000, feeRatePpm: 3000, baseFeeSats: 852 });
  await s.autopilot.runOnce(); // the offer's price on record
  // 2M at 3,000 ppm + 852 sat = 6,852 sat: fixed 852 + variable 6,000.
  const priced = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, feeSeller: "0", feeFixed: "852", feeVariable: "6000", timeout: IN_AN_HOUR() });
  const odd = s.magma.addSale({ buyerPubkey: "02" + "ab".repeat(32), sizeSats: 2_000_000, feeSeller: "0", feeFixed: "852", feeVariable: "9000", timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(priced.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(entryOnDisk(s.dir, priced.id)?.feeMsat, "6852000", "the invoice bills the parts");
  assert.equal(s.magma.sales.get(odd.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "before: accepted, its invoice for 9,852 sat");
  const e = entryOnDisk(s.dir, odd.id);
  assert.equal(e?.decision?.action, "skip");
  assert.match(e?.decision?.reason ?? "", /^Amboss shows no amount for this order, and its fee parts — 9,852 sat — aren't your price for a 2,000,000 sat channel \(your price: 6,852 sat\): the lane doesn't accept it; accept or reject it on Market → Orders$/);
  assert.equal(s.magma.calls.filter((c) => c.op === "RejectOrder").length, 0, "not turned down either");
});

// ── M6: an Accept by hand below cost, a sale opened elsewhere, opens, fast blocks ──

test("M6: an Accept by hand of an order that pays less than its channel costs on chain is refused unless confirmed (before: 50 sat for a 2M channel, accepted without a word)", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const floor = await s.autopilot.saleFeeFloorSats();
  const cheap = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, feeSeller: "50", timeout: IN_AN_HOUR() });
  const first = await s.desk.accept(cheap.id);
  assert.deepEqual([first.ok, first.code, first.feeSats, first.floorSats], [false, "below_cost", 50, Math.ceil(floor)]);
  assert.match(first.message, /^Not accepted: this order pays 50 sat — less than opening and closing its channel costs on chain now \(/);
  assert.equal(s.magma.sales.get(cheap.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(s.magma.calls.filter((c) => c.op === "AcceptOrder").length, 0, "nothing sent");
  const yes = await s.desk.accept(cheap.id, { belowCost: true });
  assert.equal(yes.ok, true, yes.message);
  assert.equal(s.magma.sales.get(cheap.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
});

test("M6: a sale settled whose channel was opened outside LightningMate still binds its routing-fee promise and counts as a sold lease — its outpoint taken from Amboss and LND", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, feeSeller: "12345", promises: { minBlockLength: 4320, feeRateCap: "2200", baseFeeCap: "1" } });
  assert.equal((await s.desk.accept(sale.id)).ok, true);
  s.magma.buyerPays(sale.id, s.node);
  await s.autopilot.pollSellOrders();
  const txid = "cd".repeat(32);
  const channelId = `${s.node.blockHeight - 3}x7x0`;
  s.node.channels.push({ id: channelId, partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 2_000_000, transactionId: txid, transactionVout: 0 });
  const amboss = s.magma.sales.get(sale.id)!;
  amboss.transactionId = `${txid}:0`;
  amboss.channelId = channelId;
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "settled");
  assert.equal(e?.fundingOutpoint, `${txid}:0`, "before: none on record");
  assert.notEqual(activeCap(s.capital.leaseCaps(), { outpoint: `${txid}:0`, channelId }, s.node.blockHeight), null, "the 2,200 ppm promise binds the channel");
  assert.equal(s.capital.soldLeases().some((l) => l.orderId === sale.id), true, "and the rebalancer leaves it alone");
});

test("M6: a sold channel opens with a routing fee of its own — a new channel's, never above the lease's promise — and carries its order's tag", async (t) => {
  quiet(t);
  for (const cap of ["2200", "50"]) {
    const s = sellerSetup(t);
    const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, feeSeller: "5000", promises: { minBlockLength: 4320, feeRateCap: cap, baseFeeCap: "0" }, timeout: IN_AN_HOUR() });
    await s.autopilot.pollSellOrders();
    s.magma.buyerPays(sale.id, s.node);
    await s.autopilot.pollSellOrders();
    const [open] = s.node.callsTo("default.openChannel");
    const start = s.autopilot.initialRoutingFee();
    assert.ok(open, `cap ${cap}: opened`);
    assert.deepEqual([open.use_fee_rate, Number(open.fee_rate)], [true, Math.min(start.feeRatePpm, Number(cap))], `cap ${cap}: before, LND's default (1 sat + 1 ppm)`);
    assert.equal(String(open.base_fee), "0", `cap ${cap}: the promised base of 0 sat`);
    assert.equal(s.node.pending[0]?.memo, `magma:${sale.id}`, `cap ${cap}: the channel names its order`);
  }
});

test("M6: an order found with no record a day after it was placed, on a day of 158 blocks, takes the channel opened right after it — no second channel for one payment", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const placed = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const sale = magma.addSale({ buyerPubkey: BUYER, createdAt: placed, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT", timeout: IN_AN_HOUR() });
  node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${sale.id}`, paid: true });
  const existing = "0e".repeat(32);
  node.channels.push({ id: `${node.blockHeight - 158 + 3}x1x0`, partnerPublicKey: BUYER, capacity: sale.sizeSats, localBalance: sale.sizeSats, transactionId: existing, transactionVout: 0 });
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 0, "before: a second channel was opened");
  assert.equal(entryOnDisk(dir, sale.id)?.fundingOutpoint, `${existing}:0`);
});

// ── O5: a spend outside the main run ────────────────────────────────────────

test("O5: a spend outside the main run has the offers' capital checked within seconds — the listed total cut to what can still be funded, its price left alone", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 4_000_000, config: { sellAutoReprice: false, sellAutoSize: false, sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 5_000_000, sellReserveSats: 50_000 } });
  const offer = s.magma.addOffer({ minSats: 250_000, maxSats: 3_000_000, totalSats: 3_500_000, feeRatePpm: 3000, baseFeeSats: 852 });
  await s.autopilot.runOnce();
  assert.equal(offer.totalSats, 3_500_000);
  s.node.chainBalance = 1_000_000; // an on-chain send by hand
  const calls = s.magma.calls.length;
  s.autopilot.recheckOfferCapital();
  s.autopilot.recheckOfferCapital(); // one check for a burst of spends
  await new Promise((r) => setTimeout(r, 2_300));
  assert.ok(offer.totalSats <= 950_000 && offer.maxSats <= 950_000, `cut to what can be funded: ${offer.maxSats} / ${offer.totalSats}`);
  assert.deepEqual([offer.feeRatePpm, offer.baseFeeSats], [3000, 852], "price untouched");
  assert.equal(s.magma.calls.slice(calls).filter((c) => c.op === "UpdateOffer").length, 1, "one write");
  assert.equal(s.autopilot.getState().history[0]?.sells?.some((x) => x.orderId === offer.id), true, "on the run history");
});

test("O5: an LSPS1 sale's channel — opened from the same wallet — asks for the check", (t) => {
  quiet(t);
  const s = sellerSetup(t);
  let asked = 0;
  t.mock.method(s.autopilot, "recheckOfferCapital", () => void asked++);
  s.autopilot.recordExternalSell("lsp-1", 1_000_000, "ab".repeat(32));
  assert.equal(asked, 1);
});

// ── the texts: what the pages say is what the lane does ─────────────────────

test("texts: 'what can be sold now' is the order lane's figure — the deploy cap already used and the coins promised count (before: 2M said fundable, the lane turning a 1M order down)", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 4_000_000, config: { sellMaxDeploySats: 2_000_000, sellMaxChannelSats: 5_000_000, sellReserveSats: 50_000 } });
  s.magma.addSale({ buyerPubkey: BUYER, status: "VALID_CHANNEL_OPENING", sizeSats: 1_500_000, timeout: null, createdAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), channelId: "850000x1x0" });
  const rec = await s.autopilot.magmaReport();
  const cap = await s.autopilot.sellCapital();
  assert.equal(rec.sell.effectiveMaxOrderSat, cap.maxChannelSat);
  assert.ok(rec.sell.effectiveMaxOrderSat <= 500_000, String(rec.sell.effectiveMaxOrderSat));
  assert.equal(rec.sell.capitalLimited, true);
});

test("texts: 'waiting on you' leaves out a paid order the lane opens itself, and an order awaiting approval is told to accept or reject — not to open a channel", async (t) => {
  quiet(t);
  const off = sellerSetup(t, { config: { sellEnabled: false } });
  off.magma.addSale({ buyerPubkey: BUYER, status: "WAITING_FOR_SELLER_APPROVAL", timeout: IN_AN_HOUR() });
  const rec = await off.autopilot.magmaReport();
  assert.equal(rec.sell.pendingSellerOrders, 1);
  assert.ok(rec.sell.warnings.includes("1 order waiting for your decision — accept or reject it on Market → Orders in time, or your seller score drops"), JSON.stringify(rec.sell.warnings));
  const on = sellerSetup(t);
  const sale = on.magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, feeSeller: "5000", timeout: IN_AN_HOUR() });
  await on.autopilot.pollSellOrders();
  on.magma.buyerPays(sale.id, on.node);
  assert.equal(on.desk.opensItself(sale.id), true);
  assert.equal((await on.autopilot.magmaReport()).sell.pendingSellerOrders, 0, "before: 1 — 'accept or reject in time'");
});

test("texts: 'closable soon' counts leases ending soon whose channel is still open — not every lease that ever ended", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000 });
  for (let i = 0; i < 3; i++) {
    s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", createdAt: `2025-0${i + 3}-01T00:00:00.000Z`, timeout: null, sizeSats: 800_000, feeSeller: "3500", channelId: `80000${i}x1x0` });
  }
  assert.equal((await s.autopilot.magmaReport()).analytics.closableSoon, 0, "their channels are closed: before, 3 forever");
  s.node.channels.push({ id: "800001x1x0", partnerPublicKey: BUYER, capacity: 800_000, localBalance: 800_000, transactionId: "ef".repeat(32), transactionVout: 0 });
  assert.equal((await s.autopilot.magmaReport()).analytics.closableSoon, 1);
});

test("texts: a free offer taken off the market whose terms are the operator's — the alert says to set its price, not that LightningMate lists it again", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellAutoReprice: true } });
  const offer = s.magma.addOffer({ minSats: 250_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRatePpm: 0, baseFeeSats: 0 });
  s.autopilot.pauseOfferAutomation(offer.id, "you edited this offer");
  await s.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED");
  const [alert] = offerPriceAlerts(s.autopilot.offerSyncStatus(), s.autopilot.actsOnOffers(), true);
  assert.match(alert?.message ?? "", /Set its price on Market → Sell and enable it\.$/);
  assert.doesNotMatch(alert?.message ?? "", /lists it again itself/);
});

// ── P10's leftovers ─────────────────────────────────────────────────────────

test("P10 leftover: the lane's own reject Amboss didn't confirm, then selling switched off — the order is the operator's, and no 'will try again' stays on its record", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxChannelSats: 1_000_000 } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, timeout: IN_AN_HOUR() });
  s.magma.behave.RejectOrder = "throw";
  await s.autopilot.pollSellOrders();
  assert.match(entryOnDisk(s.dir, sale.id)?.lastError ?? "", /reject not confirmed .* will try again/);
  s.autopilot.setConfig({ sellEnabled: false });
  await s.autopilot.pollSellOrders();
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.decision?.action, e?.decision?.reason, e?.lastError], ["seen", "skip", SELLING_OFF_SKIP, undefined]);
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
});

test("P10 leftover: a Reject of an order whose accept hung until its invoice grew too old releases that accept first and rejects — before: refused ('being confirmed with Amboss'), then accepted afresh by the lane", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  s.magma.behave.AcceptOrder = "throw";
  assert.equal((await s.desk.accept(sale.id)).ok, false);
  const e = s.autopilot.magma.journal.get(sale.id)!;
  assert.equal(e.phase, "accepting");
  e.invoice!.expiresAt = new Date(Date.now() + 47 * 3_600_000).toISOString(); // under Amboss's 48 h: never sent again
  const r = await s.desk.reject(sale.id);
  assert.equal(r.ok, true, r.message);
  assert.equal(s.magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.equal(s.magma.calls.filter((c) => c.op === "AcceptOrder").length, 1, "the accept was not sent again");
  assert.equal([...s.node.invoices.values()].filter((i) => i.state === "OPEN").length, 0, "its invoice released");
});

test("M1: the min raise is the cover check's own — a pass with no market report (the capital check after a spend) still lifts the min to the smallest order that pays for its channel", async (t) => {
  quiet(t);
  const s = liveSetup(t, { feeSatPerVb: 1 });
  await s.autopilot.runOnce();
  const before = s.offer.minSats;
  setFeeRate(s, 20);
  const floor = await s.autopilot.saleFeeFloorSats();
  const cover = minSizeCoveringSat(s.offer.feeRatePpm, s.offer.baseFeeSats, floor);
  assert.ok(cover > before, `${cover} vs ${before}`);
  await s.autopilot.offerCapitalNow(); // no report: no reshape, no reprice
  assert.equal(s.offer.minSats, cover);
  assert.match(entry(s)?.lastWrite?.reason ?? "", /min channel raised to [\d,]+ sat: at today's fee rate a smaller order pays less than opening and closing its channel costs/);
});

test("texts: a free offer the autopilot took off the market, with auto-pricing off — the alert says to set its price, not that LightningMate lists it again", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellAutoReprice: false } });
  const offer = s.magma.addOffer({ minSats: 250_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRatePpm: 0, baseFeeSats: 0 });
  await s.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED");
  const [alert] = offerPriceAlerts(s.autopilot.offerSyncStatus(), s.autopilot.actsOnOffers(), s.autopilot.getState().config.sellAutoReprice);
  assert.match(alert?.message ?? "", /Set its price on Market → Sell and enable it\.$/);
});
