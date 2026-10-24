/**
 * The incident of 2026-10-23, and what keeps it from happening again.
 *
 * The autopilot gave the live offer (4,435 ppm + 0 sat, no routing-fee
 * promise) its promise by sending ONLY the two caps. Amboss's update is not
 * partial: it set the fee rate to 0. The read-back compared only the fields
 * sent, so the write was "verified"; the run noticed "Amboss has 0, wanted
 * 4435" and left it for the next run, half an hour later. In that window
 * Amboss matched a 1.95M sat order to the offer at 0 sats. The next run sent
 * the fee rate alone — which cleared the caps — and the run after it the caps
 * alone again: the offer went back to 0 ppm every hour. With auto-pricing off
 * it was worse: the next run kept "what Amboss has" as the wanted price, 0.
 * The fake Magma API kept fields an update left out, so no test could see it;
 * it now resets them the way Amboss does (helpers/magma.ts), which also turns
 * the older terms tests (magmaTerms.test.ts) into checks of this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { offerPriceAlerts } from "../src/services/alerts.js";
import { termsMatch, termsMismatch } from "../src/services/autopilot.js";
import { getMyOffer, termsOf, type MyOffer } from "../src/services/magmaApi.js";
import { saleCostFloorSats } from "../src/services/magmaRecommend.js";
import { saleFeeConfig } from "../src/services/serviceFee.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma as FakeMagmaApi } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { IN_AN_HOUR, entryOnDisk, quiet } from "./helpers/lifecycle.js";
import type { FakeMagma } from "./helpers/magma.js";

/** The live offer that day: 250k–2M per order, 5M listed, 4,435 ppm + 0 sat,
 *  the standard lease, no routing-fee promise. */
const LIVE = { minSats: 250_000, maxSats: 2_000_000, totalSats: 5_000_000, feeRatePpm: 4435, baseFeeSats: 0, minBlockLength: 4320 };

const inputsOf = (magma: FakeMagma, op: string) =>
  magma.calls.filter((c) => c.op === op).map((c) => c.variables.input as Record<string, unknown>);

const ALL_TERMS = ["total_size", "min_size", "max_size", "fee_rate", "base_fee", "min_block_length", "fee_rate_cap", "base_fee_cap"];

/** No update ever sent a price of nothing. */
const neverSentFree = (magma: FakeMagma) =>
  assert.ok(
    inputsOf(magma, "UpdateOffer").every((i) => Number(i.fee_rate ?? 0) > 0 || Number(i.base_fee ?? 0) > 0),
    JSON.stringify(inputsOf(magma, "UpdateOffer")),
  );

const entryOf = (autopilot: ReturnType<typeof sellerSetup>["autopilot"], id: string) =>
  autopilot.offerSyncStatus().offers.find((e) => e.offerId === id);

test("2026-10-23: giving an offer its routing-fee promise keeps its price — every term is sent, read back in full, and the next run has nothing to change", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
  const offer = magma.addOffer(LIVE);
  await autopilot.runOnce();
  assert.deepEqual(
    [offer.feeRatePpm, offer.baseFeeSats, offer.feeRateCap, offer.baseFeeCap],
    [4435, 0, "2200", "1"],
    "the promise is on, and the price is still the one it had — not 0",
  );
  const sent = inputsOf(magma, "UpdateOffer");
  assert.ok(sent.length >= 1);
  for (const input of sent) for (const k of ALL_TERMS) assert.ok(k in input, `every update sends ${k}`);
  const entry = entryOf(autopilot, offer.id);
  assert.equal(entry?.lastWrite?.verified, true);
  assert.ok(entry?.inSync, entry?.differences.join("; "));
  // The record says what changed (fields holds all that was sent): the promise —
  // the price is not among it. (Auto-size may widen the window to the capital too.)
  assert.ok(entry?.lastWrite?.changed?.includes("fee_rate_cap") && entry.lastWrite.changed.includes("base_fee_cap"), JSON.stringify(entry?.lastWrite));
  assert.ok(!entry?.lastWrite?.changed?.includes("fee_rate") && !entry?.lastWrite?.changed?.includes("base_fee"), "the price was not changed");
  const writes = magma.count("UpdateOffer");
  await autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), writes, "in sync: no further write (before: the caps and the fee rate took turns, every half hour)");
  assert.equal(offer.feeRatePpm, 4435);
});

test("the read-back compares every term: an offer Amboss holds at 0 ppm is not 'verified' because the caps that were sent are there", () => {
  const sent = { ...termsOf({ ...readOf(LIVE), feeRateCapPpm: 2200, baseFeeCapSats: 1 }) };
  const read = { ...readOf(LIVE), feeRatePpm: 0, feeRateCapPpm: 2200, baseFeeCapSats: 1 };
  assert.equal(termsMatch(read, sent), false);
  assert.deepEqual(termsMismatch(read, sent), ["fee rate (ppm): Amboss has 0, sent 4435"]);
  assert.equal(termsMatch({ ...read, feeRatePpm: 4435 }, sent), true);
  // A promise of none is part of the terms too: a cap Amboss dropped is a difference.
  assert.deepEqual(termsMismatch({ ...read, feeRatePpm: 4435, feeRateCapPpm: null }, sent), ["routing fee-rate cap (ppm): Amboss has null, sent 2200"]);
  // So are the buyer conditions and the on-chain settings it doesn't set.
  const withExtras = { ...sent, conditions: [{ condition: "NODE_CAPACITY", operator: "GREATER_THAN", value: "1000000" }], onchainPriority: "HIGH" };
  assert.deepEqual(termsMismatch({ ...read, feeRatePpm: 4435 }, withExtras), [
    "buyer conditions: Amboss has none, sent NODE_CAPACITY GREATER_THAN 1000000",
    "on-chain priority: Amboss has null, sent HIGH",
  ]);
  // The listed total too — exactly, less what a sale completed in between took
  // out (writeTerms works that out from the locked amount).
  assert.deepEqual(termsMismatch({ ...read, feeRatePpm: 4435, totalSizeSats: 3_000_000 }, sent), ["listed total (sat): Amboss has 3000000, sent 5000000"]);
  assert.deepEqual(termsMismatch({ ...read, feeRatePpm: 4435, totalSizeSats: 3_000_000 }, sent, [3_000_000, 5_000_000]), []);
});

test("a write Amboss answers success for but doesn't keep goes out once more at once — kept then, it says so; never kept, it is unverified, its differences named, and raised as an alert until it is in sync", async (t) => {
  quiet(t);
  {
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer(LIVE);
    magma.behave.UpdateOffer = (n) => (n === 0 ? "lie" : "ok");
    await autopilot.runOnce();
    assert.equal(magma.count("UpdateOffer"), 2, "sent again in the same run — not half an hour later");
    const e = entryOf(autopilot, offer.id);
    assert.equal(e?.lastWrite?.verified, true);
    assert.match(e?.lastWrite?.reason ?? "", /stored on the second try/);
    assert.deepEqual([offer.feeRatePpm, offer.feeRateCap], [4435, "2200"]);
  }
  {
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer(LIVE);
    magma.behave.UpdateOffer = "lie";
    await autopilot.runOnce();
    assert.equal(magma.count("UpdateOffer"), 2, "once more, then no further — the next run tries again");
    const e = entryOf(autopilot, offer.id);
    assert.equal(e?.lastWrite?.verified, false);
    assert.match(e?.lastWrite?.error ?? "", /^Amboss answered success, but the offer reads back different: .*routing fee-rate cap \(ppm\): Amboss has null, sent 2200/);
    const alerts = offerPriceAlerts(autopilot.offerSyncStatus(), true);
    assert.ok(alerts.some((a) => /doesn't hold the terms LightningMate set/.test(a.message)), JSON.stringify(alerts));
    // Amboss shows the terms after all (applied late): in sync — and the alert goes.
    offer.feeRateCap = "2200";
    offer.baseFeeCap = "1";
    magma.behave.UpdateOffer = "ok";
    await autopilot.runOnce();
    assert.ok(entryOf(autopilot, offer.id)?.inSync);
    assert.equal(offerPriceAlerts(autopilot.offerSyncStatus(), true).length, 0, "no stale alert");
  }
});

test("the 0.8.0 state — an offer listed at 0 ppm + 0 sat, no price of its own known: never kept as the wanted price, never sent, taken off the market, saying why", async (t) => {
  quiet(t);
  for (const autoPrice of [false, true]) {
    // With auto-pricing on and the market report down, the engine has no price either.
    const { autopilot, magma, market } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true, sellAutoReprice: autoPrice } });
    if (autoPrice) market.behaviour = "throw";
    const offer = magma.addOffer({ ...LIVE, feeRatePpm: 0, feeRateCap: "2200", baseFeeCap: "1" });
    await autopilot.runOnce();
    assert.equal(offer.status, "DISABLED", `auto-pricing ${autoPrice}: off the market`);
    neverSentFree(magma);
    const e = entryOf(autopilot, offer.id);
    assert.match(e?.differences.join("; ") ?? "", /disabled by the autopilot: Amboss listed it for free \(0 ppm \+ 0 sat\) — set its price on Market → Sell, then enable it/);
    assert.ok(e?.control?.freeDisabledAt);
    const alerts = offerPriceAlerts(autopilot.offerSyncStatus(), autopilot.actsOnOffers());
    assert.ok(alerts.some((a) => /was taken off the market: Amboss listed it for free/.test(a.message)), JSON.stringify(alerts));
    // Not listed again by the autopilot, run after run.
    await autopilot.runOnce();
    assert.equal(offer.status, "DISABLED");
    assert.equal(magma.count("ToggleOffer"), 1);
  }
});

test("an offer whose price LightningMate knows goes back to that price when Amboss lists it for free — in the next run, or from the order lane within minutes", async (t) => {
  quiet(t);
  {
    // Seen at 4,435 ppm + 0 sat by a run; then Amboss shows it free. Auto-pricing
    // off: the price is the one it had, not the engine's.
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer(LIVE);
    await autopilot.runOnce();
    offer.feeRatePpm = 0;
    await autopilot.runOnce();
    assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["ENABLED", 4435, 0]);
    assert.match(entryOf(autopilot, offer.id)?.lastWrite?.reason ?? "", /price put back to the last one it had, 4,435 ppm \+ 0 sat/);
    neverSentFree(magma);
  }
  {
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer(LIVE);
    await autopilot.runOnce();
    const sizes = [offer.minSats, offer.maxSats, offer.totalSats];
    // Between runs: free, the promise gone with it.
    offer.feeRatePpm = 0;
    offer.feeRateCap = null;
    offer.baseFeeCap = null;
    await autopilot.pollSellOrders();
    assert.deepEqual([offer.feeRatePpm, offer.baseFeeSats, offer.feeRateCap, offer.baseFeeCap], [4435, 0, "2200", "1"], "put back — not at the next run");
    assert.deepEqual([offer.minSats, offer.maxSats, offer.totalSats], sizes, "the sizes are Amboss's");
    const e = entryOf(autopilot, offer.id);
    assert.equal(e?.lastWrite?.reason, "Amboss listed it for free (0 ppm + 0 sat) — its price, 4,435 ppm + 0 sat, put back at once");
    assert.equal(e?.lastWrite?.verified, true);
    for (const k of ALL_TERMS) assert.ok(k in (inputsOf(magma, "UpdateOffer").at(-1) ?? {}), `the repair sends ${k} too`);
    assert.equal(offerPriceAlerts(autopilot.offerSyncStatus(), true).length, 0);
    assert.ok(autopilot.getState().history.some((run) => run.sells?.some((x) => x.orderId === offer.id && x.action === "reprice" && x.ok)), "on record in the run history");
    // A couple of minutes between the lane's reads of the offers, not every 45 s pass.
    const writes = magma.count("UpdateOffer");
    offer.feeRatePpm = 0;
    await autopilot.pollSellOrders();
    assert.equal(magma.count("UpdateOffer"), writes, "not read again on the very next pass");
  }
});

test("the price put back is the one the offer last had — a change made since the last run (on amboss.tech) wins over the run's wish", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
  const offer = magma.addOffer(LIVE);
  await autopilot.runOnce(); // wanted: 4,435
  offer.feeRatePpm = 6000; // the operator raises it on amboss.tech
  await autopilot.pollSellOrders(); // the lane reads it — and leaves it
  assert.equal(offer.feeRatePpm, 6000);
  offer.feeRatePpm = 0; // then Amboss lists it for free
  (autopilot as unknown as { offerGuardAt: number }).offerGuardAt = 0; // two minutes later
  await autopilot.pollSellOrders();
  assert.equal(offer.feeRatePpm, 6000, "6,000 — not the run's older 4,435");
});

test("the order lane never rewrites a price someone chose — a cut on amboss.tech, a higher rate with a lower base — it only acts on a free listing", async (t) => {
  quiet(t);
  for (const [fee, base] of [
    [3000, 0],
    [8000, 0],
  ] as const) {
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer({ ...LIVE, baseFeeSats: 852 });
    await autopilot.runOnce();
    const writes = magma.count("UpdateOffer");
    offer.feeRatePpm = fee;
    offer.baseFeeSats = base;
    await autopilot.pollSellOrders();
    assert.equal(magma.count("UpdateOffer"), writes, `${fee} ppm + ${base} sat: left to the next run`);
    assert.deepEqual([offer.feeRatePpm, offer.baseFeeSats], [fee, base]);
  }
});

test("the order lane takes a free offer whose terms the operator owns off the market rather than rewrite them; with all automation paused — or a run under way — it touches nothing", async (t) => {
  quiet(t);
  {
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer(LIVE);
    await autopilot.runOnce();
    autopilot.pauseOfferAutomation(offer.id, "you edited this offer");
    offer.feeRatePpm = 0;
    const writes = magma.count("UpdateOffer");
    await autopilot.pollSellOrders();
    assert.equal(magma.count("UpdateOffer"), writes, "the operator's terms are not rewritten");
    assert.equal(offer.status, "DISABLED", "but it is not left listed for free");
    assert.equal(offer.feeRatePpm, 0);
    const alerts = offerPriceAlerts(autopilot.offerSyncStatus(), true);
    assert.ok(alerts.some((a) => /was taken off the market/.test(a.message)), JSON.stringify(alerts));
  }
  {
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer(LIVE);
    await autopilot.runOnce();
    autopilot.pauseAll();
    offer.feeRatePpm = 0;
    await autopilot.pollSellOrders();
    assert.deepEqual([offer.status, offer.feeRatePpm, magma.count("ToggleOffer")], ["ENABLED", 0, 0], "paused: nothing is written");
    const alerts = offerPriceAlerts(autopilot.offerSyncStatus(), autopilot.actsOnOffers());
    // (The lane didn't read it — paused — so the record still shows the run's read.)
    assert.ok(alerts.every((a) => !/puts its last price back/.test(a.message)), "never promises what it won't do");
  }
  {
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer(LIVE);
    await autopilot.runOnce();
    offer.feeRatePpm = 0;
    (autopilot as unknown as { running: boolean }).running = true; // a run is writing the offers
    await autopilot.pollSellOrders();
    assert.deepEqual([offer.feeRatePpm, magma.count("ToggleOffer")], [0, 0], "left to the run under way");
    (autopilot as unknown as { running: boolean }).running = false;
  }
});

test("what an offer has that LightningMate doesn't set — buyer conditions, on-chain fee settings — goes back with every write, the autopilot's and the operator's", async (t) => {
  quiet(t);
  const extras = {
    conditions: [{ condition: "NODE_CAPACITY", operator: "GREATER_THAN", value: "10000000" }],
    onchainPriority: "HIGH",
    onchainMultiplier: 1.5,
  };
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
  const offer = magma.addOffer({ ...LIVE, ...extras });
  await autopilot.runOnce();
  assert.equal(offer.feeRateCap, "2200", "the promise was written");
  assert.deepEqual([offer.conditions, offer.onchainPriority, offer.onchainMultiplier], [extras.conditions, "HIGH", 1.5], "and nothing else was lost");
  const input = inputsOf(magma, "UpdateOffer").at(-1);
  assert.deepEqual(input?.conditions, extras.conditions);
  assert.equal(input?.onchain_priority, "HIGH");
  assert.equal(input?.onchain_multiplier, 1.5);
  assert.equal(entryOf(autopilot, offer.id)?.lastWrite?.verified, true);
});

test("an offer without a price is never listed: the operator's Enable is refused, saying why — and the autopilot doesn't list it again after a capital dip", async (t) => {
  quiet(t);
  {
    const http = installFetchMock(t);
    http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
    const magma = new FakeMagmaApi(http, t);
    new FakeMarket(http, t);
    const api = await startApi(t, { node: new FakeLnd({ chainBalance: 5_000_000 }) });
    magma.sellerPubkey = api.node.publicKey;
    api.amboss.setKey("test-key");
    // How the live offer stood after the incident: disabled, at 0 ppm + 0 sat.
    const offer = magma.addOffer({ status: "DISABLED", ...LIVE, feeRatePpm: 0, baseFeeSats: 0, feeRateCap: "2200", baseFeeCap: "1" });
    for (const body of [{ id: offer.id, want: "ENABLED" }, { id: offer.id }]) {
      const res = await api.request("POST", "/amboss/offer/toggle", body);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error, "no_price");
      assert.match(res.body.message, /no price \(0 ppm \+ 0 sat\): set its price before you list it/);
    }
    assert.equal(magma.count("ToggleOffer"), 0, "nothing sent to Amboss");
    assert.equal(offer.status, "DISABLED");
    // Disabling one is fine whatever its price.
    offer.status = "ENABLED";
    const off = await api.request("POST", "/amboss/offer/toggle", { id: offer.id, want: "DISABLED" });
    assert.equal(off.status, 200);
    assert.equal(offer.status, "DISABLED");
  }
  {
    const { autopilot, magma, node } = sellerSetup(t, { chainBalance: 500_000 });
    const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRatePpm: 0, baseFeeSats: 0 });
    await autopilot.runOnce();
    assert.equal(offer.status, "DISABLED", "disabled for lack of capital");
    node.chainBalance = 8_000_000;
    await autopilot.runOnce();
    assert.equal(offer.status, "DISABLED", "capital is back, but there is no price: not listed again");
    assert.match(entryOf(autopilot, offer.id)?.differences.join("; ") ?? "", /it has no price on Amboss \(0 ppm \+ 0 sat\) — listed again once it has one/);
  }
});

test("the order lane never sells at a loss: an order that doesn't cover opening and closing its channel at today's fee rate is rejected at once — the floor follows LND's estimate", async (t) => {
  quiet(t);
  const { autopilot, magma, node, dir } = sellerSetup(t);
  const keep = 1 - saleFeeConfig().bps / 10_000; // after the service fee (none configured here)
  // No estimate from LND: the minimum relay fee, 1 sat/vB — (175 + 150) vB.
  const floorAtMinimum = await autopilot.saleFeeFloorSats();
  assert.equal(floorAtMinimum, Math.ceil(325 / keep));
  // 10 sat/vB (2,500 sat per kw): ten times that.
  node.override("wallet.estimateFee", (_a, cb) => (cb as (e: unknown, r: unknown) => void)(null, { sat_per_kw: "2500" }));
  (autopilot as unknown as { saleFloor: unknown }).saleFloor = null;
  const floor = await autopilot.saleFeeFloorSats();
  assert.equal(floor, Math.ceil((1_750 + 1_500) / keep));
  const cheap = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, feeSeller: String(floor - 1), timeout: IN_AN_HOUR() });
  const fair = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, feeSeller: String(floor), timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(cheap.id)?.status, "SELLER_REJECTED", "at once — not left to time out");
  assert.match(
    entryOnDisk(dir, cheap.id)?.reason ?? "",
    new RegExp(`^it pays ${(floor - 1).toLocaleString("en-US")} sat — less than opening and closing its channel costs on chain now \\(${floor.toLocaleString("en-US")} sat\\)$`),
  );
  assert.equal(magma.sales.get(fair.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "one that pays its way is accepted — no profit margin demanded on top");
});

test("an order Amboss priced at 0 sats is turned down a minute after it was placed — not held until its deadline; the operator's Accept says what holds", async (t) => {
  quiet(t);
  const { autopilot, magma, node, dir } = sellerSetup(t);
  const placedEarlier = magma.addSale({
    buyerPubkey: BUYER,
    sizeSats: 1_948_190,
    feeSeller: "0",
    createdAt: new Date(Date.now() - 90_000).toISOString(),
    timeout: IN_AN_HOUR(),
  });
  const justPlaced = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_948_190, feeSeller: "0", timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(placedEarlier.id)?.status, "SELLER_REJECTED", "an hour before its deadline");
  assert.match(entryOnDisk(dir, placedEarlier.id)?.reason ?? "", /^Amboss priced it at 0 sats for this node — there is nothing to earn$/);
  assert.equal(magma.sales.get(justPlaced.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "one more look first");
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "never an invoice for 0 sat");
  const click = await autopilot.magma.accept(justPlaced.id);
  assert.deepEqual([click.ok, click.message], [false, "Amboss reports no fee for this order yet — try again in a minute."]);
  magma.sales.get(justPlaced.id)!.createdAt = new Date(Date.now() - 90_000).toISOString();
  const later = await autopilot.magma.accept(justPlaced.id);
  assert.deepEqual([later.ok, later.message], [false, "Amboss priced this order at 0 sats for this node — there is nothing to earn. Reject it rather than let it time out."]);
});

test("a capital cut Amboss doesn't keep is not 'verified': a listed total above what was sent is a difference, and the retry never sends more than either side has", async (t) => {
  quiet(t);
  // ~3.4M fundable: the 5M listed is cut.
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 3_500_000 });
  const offer = magma.addOffer(LIVE);
  magma.behave.UpdateOffer = "lie";
  await autopilot.runOnce();
  const sent = inputsOf(magma, "UpdateOffer");
  assert.equal(sent.length, 2, "sent once more at once");
  const cut = Number(sent[0].total_size);
  assert.ok(cut < 5_000_000, `cut to ${cut}`);
  assert.equal(Number(sent[1].total_size), cut, "the retry sends the cut again — not Amboss's 5M back");
  const e = entryOf(autopilot, offer.id);
  assert.equal(e?.lastWrite?.verified, false);
  assert.match(e?.lastWrite?.error ?? "", new RegExp(`listed total \\(sat\\): Amboss has 5000000, sent ${cut}`));
  assert.equal(offer.totalSats, 5_000_000);
});

test("a cut given back that Amboss doesn't keep is not 'verified' either — the cut is remembered, and the next run gives it back", async (t) => {
  quiet(t);
  const { autopilot, magma, node } = sellerSetup(t, { chainBalance: 3_500_000 });
  const offer = magma.addOffer(LIVE);
  await autopilot.runOnce();
  const cut = offer.totalSats;
  assert.ok(cut < 5_000_000, "cut to what can be funded");
  node.chainBalance = 30_000_000; // capital is back
  magma.behave.UpdateOffer = "lie";
  await autopilot.runOnce();
  const sent = inputsOf(magma, "UpdateOffer").slice(-2).map((i) => Number(i.total_size));
  assert.deepEqual(sent, [5_000_000, 5_000_000], "the give-back, and once more the same — not the cut");
  const e = entryOf(autopilot, offer.id);
  assert.equal(e?.lastWrite?.verified, false);
  assert.match(e?.lastWrite?.error ?? "", new RegExp(`listed total \\(sat\\): Amboss has ${cut}, sent 5000000`));
  magma.behave.UpdateOffer = "ok";
  await autopilot.runOnce();
  assert.equal(offer.totalSats, 5_000_000, "given back at the next run — not lost");
});

test("what orders do between a write and its read-back is no difference: a sale (not listed back in), an order released without one, a new lock — even a sale and a lock together", async (t) => {
  quiet(t);
  const cases: [string, (o: { totalSats: number; lockedSats: number; filledOrders: number }) => void, number][] = [
    // [what happens, the change, how much lower the total ends than sent]
    ["a sale completes", (o) => ((o.totalSats -= 1_000_000), (o.lockedSats -= 1_000_000), (o.filledOrders += 1)), 1_000_000],
    ["an order is released without a sale", (o) => (o.lockedSats -= 1_000_000), 0],
    ["a new order locks capacity", (o) => (o.lockedSats += 1_500_000), 0],
    ["a sale and a new lock", (o) => ((o.totalSats -= 1_000_000), (o.lockedSats += 500_000), (o.filledOrders += 1)), 1_000_000],
  ];
  for (const [what, happen, lower] of cases) {
    const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
    const offer = magma.addOffer({ ...LIVE, lockedSats: 1_000_000 }); // an order under way
    let done = false;
    magma.onRead = (op) => {
      if (op === "MyOffer" && magma.count("UpdateOffer") > 0 && !done) {
        done = true;
        happen(offer);
      }
    };
    await autopilot.runOnce();
    assert.ok(done, what);
    const e = entryOf(autopilot, offer.id);
    assert.equal(e?.lastWrite?.verified, true, `${what}: ${e?.lastWrite?.error}`);
    assert.equal(magma.count("UpdateOffer"), 1, `${what}: no retry`);
    const sent = Number(inputsOf(magma, "UpdateOffer")[0].total_size);
    assert.equal(offer.totalSats, sent - lower, `${what}: nothing cut, nothing sold listed back in`);
  }
});

test("on the upgrade from 0.8.0, an offer at 0 ppm + 0 sat gets the price 0.8.0 had recorded for it back — not taken off the market", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true } });
  const offer = s.magma.addOffer({ ...LIVE, feeRatePpm: 0, feeRateCap: "2200", baseFeeCap: "1" });
  // What 0.8.0 left on disk: the run before had read the offer at its price.
  const file = join(s.dir, "autopilot.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  const fields = { status: "ENABLED", minSizeSats: LIVE.minSats, maxSizeSats: LIVE.maxSats, totalSizeSats: LIVE.totalSats, availableSats: LIVE.totalSats, feeRatePpm: 4435, baseFeeSats: 0, minBlockLength: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1 };
  state.offerSync = { at: "2026-10-23T12:58:15.112Z", managed: true, lastError: null, offers: [{ offerId: offer.id, checkedAt: "2026-10-23T12:58:15.112Z", amboss: fields, wanted: fields, inSync: true, differences: [], lastWrite: null }] };
  writeFileSync(file, JSON.stringify(state));
  const upgraded = s.restart();
  await upgraded.runOnce();
  assert.deepEqual([offer.status, offer.feeRatePpm, offer.feeRateCap], ["ENABLED", 4435, "2200"]);
  neverSentFree(s.magma);
  assert.equal(s.magma.count("ToggleOffer"), 0);
});

test("with auto-pricing on and a market report, an offer Amboss lists for free gets the engine's price at once — even where the engine calls it no move", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true, sellAutoReprice: true } });
  const offer = magma.addOffer({ ...LIVE, feeRatePpm: 0 });
  await autopilot.runOnce();
  assert.equal(offer.status, "ENABLED", "priced, never taken off the market");
  assert.ok(offer.feeRatePpm > 0 || offer.baseFeeSats > 0);
  assert.match(entryOf(autopilot, offer.id)?.lastWrite?.reason ?? "", /priced at the engine's/);
  neverSentFree(magma);
});

test("an offer taken off the market for being free, priced by the autopilot, is listed again — written and checked first — once there is a price for it", async (t) => {
  quiet(t);
  const { autopilot, magma, market } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true, sellAutoReprice: true } });
  market.behaviour = "throw"; // no market report: no price at first
  const offer = magma.addOffer({ ...LIVE, feeRatePpm: 0 });
  await autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "no price known: off the market");
  await autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "still none: stays off");
  // A price turns up (the engine's, in life; set here as the one it last had).
  (autopilot as unknown as { state: { offerPrices: Record<string, unknown> } }).state.offerPrices = {
    [offer.id]: { feeRatePpm: 4435, baseFeeSats: 0, at: new Date().toISOString() },
  };
  await autopilot.runOnce();
  assert.deepEqual([offer.status, offer.feeRatePpm], ["ENABLED", 4435], "priced, then listed");
  assert.equal(entryOf(autopilot, offer.id)?.control?.freeDisabledAt, undefined);
  neverSentFree(magma);
  // The operator's own offer is never listed again by the autopilot.
  const mine = magma.addOffer({ ...LIVE, feeRatePpm: 0 });
  autopilot.pauseOfferAutomation(mine.id, "you edited this offer");
  await autopilot.runOnce();
  assert.equal(mine.status, "DISABLED");
  (autopilot as unknown as { state: { offerPrices: Record<string, unknown> } }).state.offerPrices[mine.id] = { feeRatePpm: 4435, baseFeeSats: 0, at: new Date().toISOString() };
  await autopilot.runOnce();
  assert.equal(mine.status, "DISABLED", "the operator's: stays off until they list it");
});

test("listing a free-disabled offer again takes the engine's price even when it doesn't call it a move, and never flips an offer that got listed meanwhile", async (t) => {
  quiet(t);
  const { autopilot, magma, market } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true, sellAutoReprice: true } });
  market.behaviour = "throw"; // no report in the runs: the offers go off the market first
  const relistFree = (autopilot as unknown as { relistFree: (k: string, o: MyOffer, c: unknown, out: unknown[]) => Promise<MyOffer | null> }).relistFree.bind(autopilot);
  const ctx = {
    maxOrder: () => 2_000_000,
    listable: () => 5_000_000,
    target: () => ({ fee: 5_000, base: 0, moved: false, lease: 4320 }), // "inactive": not a move
    reshape: () => null,
    lease: () => 4320,
    caps: { feeRateCapPpm: 2200, baseFeeCapSats: 1 },
  };
  for (const listedMeanwhile of [false, true]) {
    const offer = magma.addOffer({ ...LIVE, feeRatePpm: 0 });
    await autopilot.runOnce(); // free, no price known: off the market
    assert.equal(offer.status, "DISABLED");
    if (listedMeanwhile) {
      magma.onMutation = (op) => {
        if (op === "UpdateOffer") offer.status = "ENABLED"; // the operator lists it on amboss.tech
      };
    }
    const toggles = magma.count("ToggleOffer");
    const listed = await relistFree("test-key", await getMyOffer("test-key", offer.id), ctx, []);
    magma.onMutation = null;
    assert.equal(offer.feeRatePpm, 5_000, "the engine's price");
    assert.equal(offer.status, "ENABLED");
    assert.equal(listed?.status, "ENABLED");
    assert.equal(magma.count("ToggleOffer"), toggles + (listedMeanwhile ? 0 : 1), listedMeanwhile ? "no flip: it would have turned it off" : "listed");
    assert.equal(entryOf(autopilot, offer.id)?.control?.freeDisabledAt, undefined);
  }
});

test("an offer disabled by hand at 0 ppm + 0 sat gets its price while it stays disabled — so the operator's Enable can list it; never the operator's own terms, never without auto-pricing", async (t) => {
  quiet(t);
  for (const [variant, cfg, manual, expectPrice] of [
    ["auto-pricing on, the last price known", { sellAutoReprice: true }, false, 4435],
    ["auto-pricing on, terms taken over", { sellAutoReprice: true }, true, 0],
    ["auto-pricing off", { sellAutoReprice: false }, false, 0],
  ] as const) {
    const { autopilot, magma, market } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true, ...cfg } });
    market.behaviour = "throw"; // no engine price: the one it last had is what there is
    const offer = magma.addOffer(LIVE);
    await autopilot.runOnce(); // seen at 4,435
    // 2026-10-23: the operator disabled it by hand; Amboss holds it at 0.
    offer.status = "DISABLED";
    autopilot.offerStatusSetByHand(offer.id, "DISABLED");
    if (manual) autopilot.pauseOfferAutomation(offer.id, "you edited this offer");
    offer.feeRatePpm = 0;
    const toggles = magma.count("ToggleOffer");
    await autopilot.runOnce();
    assert.equal(offer.feeRatePpm, expectPrice, variant);
    assert.equal(offer.status, "DISABLED", `${variant}: listing it stays the operator's click`);
    assert.equal(magma.count("ToggleOffer"), toggles, variant);
    const e = entryOf(autopilot, offer.id);
    assert.match(
      e?.differences.join("; ") ?? "",
      expectPrice ? /disabled by you — the autopilot leaves it disabled/ : /has no price on Amboss \(0 ppm \+ 0 sat\) — edit it on Market → Sell to give it one, then enable it/,
      variant,
    );
    if (expectPrice) {
      assert.match(e?.lastWrite?.reason ?? "", /^priced at its last 4,435 ppm \+ 0 sat while disabled \(Amboss had it at 0 ppm \+ 0 sat\) — listing it stays your click$/);
      assert.equal(e?.lastWrite?.verified, true);
    }
    neverSentFree(magma);
  }
});

test("an offer the autopilot disabled for lack of capital, at 0 ppm + 0 sat, is priced and listed again in the same run once capital is back — and says what holds while no price is known", async (t) => {
  quiet(t);
  const { autopilot, magma, node, market } = sellerSetup(t, { chainBalance: 500_000, config: { sellAutoSize: true, sellAutoReprice: true } });
  market.behaviour = "throw"; // no engine price
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRatePpm: 0, baseFeeSats: 0 });
  await autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "disabled for lack of capital");
  node.chainBalance = 8_000_000;
  await autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "capital is back, no price known: not listed");
  assert.match(entryOf(autopilot, offer.id)?.differences.join("; ") ?? "", /left as it is: it has no price on Amboss/);
  // A price becomes known (the engine's, in life; the one it last had here).
  (autopilot as unknown as { state: { offerPrices: Record<string, unknown> } }).state.offerPrices = {
    [offer.id]: { feeRatePpm: 3000, baseFeeSats: 852, at: new Date().toISOString() },
  };
  await autopilot.runOnce();
  assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["ENABLED", 3000, 852], "priced, then listed by capital safety in the same run");
  neverSentFree(magma);
});

test("with the market report up, a disabled offer at 0 ppm + 0 sat gets the engine's price — as the live node's did need (recommended 4,445 ppm, offer at 0)", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoSize: true, sellAutoReprice: true } });
  const offer = magma.addOffer({ ...LIVE, status: "DISABLED", feeRatePpm: 0 });
  autopilot.offerStatusSetByHand(offer.id, "DISABLED");
  await autopilot.runOnce();
  assert.ok(offer.feeRatePpm > 0, `priced: ${offer.feeRatePpm} ppm`);
  assert.equal(offer.status, "DISABLED");
  assert.match(entryOf(autopilot, offer.id)?.lastWrite?.reason ?? "", /^priced at the engine's .* while disabled/);
});

test("the last line: a price of 0 ppm + 0 sat is never sent to Amboss, whoever asks for it", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 8_000_000 });
  const offer = magma.addOffer(LIVE);
  const write = { at: new Date().toISOString(), by: "autopilot" as const, action: "update" as const, fields: {}, ok: true };
  const writeTerms = (autopilot as unknown as { writeTerms: (k: string, id: string, t: unknown, w: typeof write) => Promise<unknown> }).writeTerms.bind(autopilot);
  const read = await writeTerms("test-key", offer.id, { ...termsOf(readOf(LIVE)), feeRatePpm: 0, baseFeeSats: 0 }, write);
  assert.equal(read, null);
  assert.equal(magma.count("UpdateOffer"), 0, "nothing sent");
  assert.deepEqual([write.ok, (write as { error?: string }).error], [false, "not sent: a price of 0 ppm + 0 sat would list the offer for free"]);
  assert.equal(offer.feeRatePpm, 4435);
});

test("the accept floor's formula: the channel's open and close on chain, after the service fee (no profit minimum)", () => {
  assert.equal(saleCostFloorSats({ onchainOpenCostSat: 1_000, onchainCloseCostSat: 500, minNetLeaseProfitSat: 0, serviceFeeRate: 0.01 }), 1_516);
  assert.equal(saleCostFloorSats({ onchainOpenCostSat: 175, onchainCloseCostSat: 150, minNetLeaseProfitSat: 500, serviceFeeRate: 0 }), 825);
});

/** An offer as getMyOffer reads it, from the fake's terms. */
function readOf(o: typeof LIVE): MyOffer {
  return {
    id: "00479f19-540f-4ce5-83fa-9e13c85269e1",
    nodePubkey: "02" + "11".repeat(32),
    status: "ENABLED",
    minSizeSats: o.minSats,
    maxSizeSats: o.maxSats,
    totalSizeSats: o.totalSats,
    lockedSats: 0,
    availableSats: o.totalSats,
    baseFeeSats: o.baseFeeSats,
    feeRatePpm: o.feeRatePpm,
    minBlockLength: o.minBlockLength,
    feeRateCapPpm: null,
    baseFeeCapSats: null,
    conditions: [],
    onchainPriority: null,
    onchainMultiplier: null,
    filledOrders: 0,
    createdAt: "2025-08-20T07:59:02.573Z",
  };
}
