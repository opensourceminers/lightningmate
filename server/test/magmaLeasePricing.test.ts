/**
 * Every offer is priced for the lease it carries after the autopilot's next
 * write (magmaRecommend.ts pricingLease): the standard lease for a new offer
 * and, with auto-size, for every offer the autopilot manages; otherwise the
 * lease the offer keeps — a longer one buyers use, chosen on purpose (60, 90,
 * 180 days), is priced as such.
 *
 * Before (review P1b): the engine priced every offer for the standard 30 days.
 * A 90-day offer kept on purpose (auto-size off) was auto-priced at the 30-day
 * price — about a third of what buyers pay for 90 days, below the profit floor
 * of the lease it promises — its correctly priced 90-day price was called
 * "overpriced", and Market → Sell's price buttons filled in the 30-day price on
 * the 90-day lease.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerSetup } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";
import { __setHistoryForTests, keptLeaseBlocks, priceFitsLease } from "../src/services/magmaHistory.js";
import type { AfterHook } from "./helpers/tmp.js";

/** A selling node whose comparable leases cleared at 5% a year, with a listed book around 3,000–5,000 ppm. */
function pricedMarket(t: AfterHook, config: Record<string, unknown>) {
  const s = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoReprice: true, sellPricingMode: "balanced", ...config } });
  for (let i = 0; i < 8; i++) {
    s.market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: 568, sellerScore: 50 });
  }
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_500_000, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })),
  );
  t.after(() => __setHistoryForTests([]));
  return s;
}

const WINDOW = { minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 };
/** Effective ppm of an offer at the engine's representative size (√(min·max)). */
const effective = (o: { feeRatePpm: number; baseFeeSats: number }) => o.feeRatePpm + (o.baseFeeSats / Math.sqrt(1_000_000 * 2_000_000)) * 1e6;

test("a 90-day offer (auto-size off) is priced for 90 days: its clearing price, floor, %/yr and price buttons are the 90-day ones — and a correct 90-day price is not called 'overpriced'", async (t) => {
  quiet(t);
  const { autopilot, magma } = pricedMarket(t, { sellAutoSize: false });
  const ninety = magma.addOffer({ ...WINDOW, feeRatePpm: 11_500, baseFeeSats: 852, minBlockLength: 12_960 });
  const thirty = magma.addOffer({ ...WINDOW, feeRatePpm: 3_500, baseFeeSats: 852, minBlockLength: 4320 });
  const rec = await autopilot.magmaReport();
  const r90 = rec.sell.recommendations.find((r) => r.offerId === ninety.id)!;
  const r30 = rec.sell.recommendations.find((r) => r.offerId === thirty.id)!;
  assert.equal(r90.recommended.minBlockLength, 12_960, "priced for the lease it keeps");
  assert.equal(r30.recommended.minBlockLength, 4320);
  assert.equal(r90.economics.leaseYears, 0.25);
  // The same 5% a year, over three times as long: three times the ppm.
  assert.ok(Math.abs(r90.clearing!.medianPpm - 3 * r30.clearing!.medianPpm) <= 2, `${r90.clearing?.medianPpm} vs ${r30.clearing?.medianPpm}`);
  assert.ok(r90.recommended.effectiveFeePpm >= 2.9 * r30.recommended.effectiveFeePpm, `${r90.recommended.effectiveFeePpm} vs ${r30.recommended.effectiveFeePpm}`);
  // The capital is tied up three times as long: a higher floor.
  assert.ok(r90.economics.profitFloorEffectivePpm > 1.5 * r30.economics.profitFloorEffectivePpm, `${r90.economics.profitFloorEffectivePpm} vs ${r30.economics.profitFloorEffectivePpm}`);
  for (const p of Object.values(r90.pricing)) {
    assert.ok(p.effectiveFeePpm >= r90.economics.profitFloorEffectivePpm, `a price button below the 90-day floor: ${JSON.stringify(p)}`);
  }
  // Before: the 30-day price (~4,110 ppm) — "overpriced", lower it.
  assert.equal(r90.state, "well_priced", `${r90.state}: ${r90.reasons.join(" | ")}`);
  // The fixed on-chain costs spread over three times as long: a 90-day lease
  // at the same rate a year nets more a year (before: both were the 30-day sale).
  assert.ok(r90.recommended.leaseApy > r30.recommended.leaseApy, `${r90.recommended.leaseApy} vs ${r30.recommended.leaseApy}`);

  await autopilot.runOnce();
  // Before: repriced to 3,508 ppm + 852 — the 30-day price on a 90-day lease.
  assert.deepEqual([ninety.feeRatePpm, ninety.minBlockLength], [11_500, 12_960], "well priced for its 90 days: left as it is");
});

test("a 90-day offer priced too low is repriced to its 90-day price — never to the 30-day one, below the 90-day profit floor", async (t) => {
  quiet(t);
  const { autopilot, magma } = pricedMarket(t, { sellAutoSize: false });
  const cheap = magma.addOffer({ ...WINDOW, feeRatePpm: 2_000, baseFeeSats: 852, minBlockLength: 12_960 });
  const r = (await autopilot.magmaReport()).sell.recommendations.find((x) => x.offerId === cheap.id)!;
  await autopilot.runOnce();
  assert.equal(cheap.minBlockLength, 12_960, "auto-size is off: the lease is the operator's");
  assert.ok(effective(cheap) >= r.economics.profitFloorEffectivePpm, `${effective(cheap)} ppm, floor ${r.economics.profitFloorEffectivePpm}`);
  // 5% a year for 12,960 blocks is ~12,329 ppm of the channel per lease.
  assert.ok(Math.abs(effective(cheap) - 12_329) <= 2, `repriced to ${Math.round(effective(cheap))} ppm effective`);
});

test("with auto-size on, an offer the autopilot manages gets the standard lease — and, in the same write, the price for it; the operator's own 90-day offer keeps its lease and its 90-day price", async (t) => {
  quiet(t);
  const { autopilot, magma } = pricedMarket(t, { sellAutoSize: true });
  const managed = magma.addOffer({ ...WINDOW, feeRatePpm: 11_500, baseFeeSats: 852, minBlockLength: 12_960 });
  const theirs = magma.addOffer({ ...WINDOW, feeRatePpm: 11_500, baseFeeSats: 852, minBlockLength: 12_960 });
  autopilot.pauseOfferAutomation(theirs.id, "you edited this offer");
  const rec = await autopilot.magmaReport();
  const byId = (id: string) => rec.sell.recommendations.find((r) => r.offerId === id)!;
  assert.equal(byId(managed.id).recommended.minBlockLength, 4320, "auto-size gives it the standard lease: priced for it");
  assert.match(byId(managed.id).reasons.join(" "), /priced for a 4320-block \(30-day\) lease — the one auto-size gives this offer with its next write \(it promises 12960 blocks now\)/);
  assert.equal(byId(theirs.id).recommended.minBlockLength, 12_960, "the operator's terms: its lease stays, priced as such");
  await autopilot.runOnce();
  assert.equal(managed.minBlockLength, 4320);
  // 5% a year for 4,320 blocks is ~4,110 ppm per lease — at the size window
  // auto-size gives it in the same write (the engine prices it for that one;
  // its max is the deployable capital, the write's what one channel can fund
  // after the open's own fee: a few ppm apart).
  const eff = managed.feeRatePpm + (managed.baseFeeSats / Math.sqrt(managed.minSats * managed.maxSats)) * 1e6;
  assert.ok(
    Math.abs(eff - 4110) <= 5,
    `the 30-day price with the 30-day lease: ${Math.round(eff)} (${managed.feeRatePpm} + ${managed.baseFeeSats}, ${managed.minSats}–${managed.maxSats}; ${Math.round(effective(managed))} at 1M–2M)`,
  );
  assert.deepEqual([theirs.feeRatePpm, theirs.minBlockLength], [11_500, 12_960], "not the autopilot's to change");
});

test("a lease the offer keeps that is longer than the price it was given: not repriced, and the sync status and diagnostics say why — a shorter one gets the longer standard lease's price", async (t) => {
  quiet(t);
  const { autopilot, magma } = pricedMarket(t, { sellAutoSize: false });
  // An odd lease longer than the standard (no order uses 5,000 blocks): the
  // engine prices it for the standard 4,320 — a price that would undercharge
  // the 5,000 blocks it promises.
  const odd = magma.addOffer({ ...WINDOW, feeRatePpm: 66, baseFeeSats: 852, minBlockLength: 5_000 });
  // The old 4,032-block default, priced far below the floor: the standard
  // lease's price clears its shorter lease's floor too.
  const old = magma.addOffer({ ...WINDOW, feeRatePpm: 66, baseFeeSats: 852, minBlockLength: 4032 });
  await autopilot.runOnce();
  assert.deepEqual([odd.feeRatePpm, odd.minBlockLength], [66, 5_000], "never the 30-day price on a longer lease");
  const entry = autopilot.offerSyncStatus().offers.find((e) => e.offerId === odd.id);
  assert.match(
    entry?.differences.join(" | ") ?? "",
    /not repriced: the market price is for a 4,320-block lease, and this offer promises 5,000 blocks — that price would undercharge for its own, longer lease/,
  );
  assert.match(autopilot.getState().decisions.magma?.text ?? "", /not repriced/);
  assert.equal(old.minBlockLength, 4032, "auto-size is off: the lease stays");
  assert.ok(Math.abs(effective(old) - 4110) <= 2, `repriced to the 4,320-block price: ${Math.round(effective(old))}`);
  const write = autopilot.offerSyncStatus().offers.find((e) => e.offerId === old.id)?.lastWrite;
  assert.match(write?.reason ?? "", /priced for the standard 4,320-block lease; with auto-size off the offer keeps its 4,032 blocks/);
});

test("listed asks are compared at the offer's own lease: a 90-day offer is not 'above the market' because its 90-day floor tops 30-day asks", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoReprice: true, sellAutoSize: false, sellPricingMode: "balanced" } });
  // Cheap 30-day asks (~1,900–2,950 ppm effective): above a 30-day floor, below a 90-day one.
  for (let i = 0; i < 8; i++) {
    s.market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 1500 + i * 150, baseFeeSats: 568, sellerScore: 50, minBlockLength: 4320 });
  }
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_500_000, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })),
  );
  t.after(() => __setHistoryForTests([]));
  const ninety = s.magma.addOffer({ ...WINDOW, feeRatePpm: 11_500, baseFeeSats: 852, minBlockLength: 12_960 });
  const r = (await s.autopilot.magmaReport()).sell.recommendations.find((x) => x.offerId === ninety.id)!;
  assert.ok(r.economics.profitFloorEffectivePpm > 2_952, `the 90-day floor tops every 30-day ask: ${r.economics.profitFloorEffectivePpm}`);
  // Before: "do_not_list_uncompetitive" — "profitable price is above current market".
  assert.equal(r.state, "well_priced", r.reasons.join(" | "));
  // The asks as 90-day prices: three times the 30-day ones.
  assert.ok(r.market.p75 > 3 * 2_600 && r.market.p75 < 3 * 3_000, `p75 at 90 days: ${r.market.p75}`);
});

test("a price goes only onto a lease it fits: the same one, or a slightly longer standard one for an odd lease — never a shorter one, nor a much longer one", () => {
  assert.equal(priceFitsLease(12_960, 12_960), true);
  assert.equal(priceFitsLease(4320, 4032), true, "the old 4,032-block offer at the 4,320-block price: 7% dearer, above its floor");
  assert.equal(priceFitsLease(4320, 5_000), false, "it would undercharge the longer lease");
  assert.equal(priceFitsLease(4320, 12_960), false, "the 30-day price on a 90-day lease");
  assert.equal(priceFitsLease(8640, 4320), false, "twice what a 30-day lease is worth");
  // The lease an offer keeps when priced as it stands: one buyers use, at least the standard.
  assert.deepEqual([12_960, 25_920, 4032, 5_000, 2_016].map((b) => keptLeaseBlocks(b, 4320)), [12_960, 25_920, 4320, 4320, 4320]);
  assert.equal(keptLeaseBlocks(4320, 8640), 8640);
});

test("when buyers mostly take 60-day leases (the standard is 8,640 blocks), a 30-day offer with auto-size off keeps its price — never the 60-day one on its 30 days", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoReprice: true, sellAutoSize: false, sellPricingMode: "balanced" } });
  for (let i = 0; i < 8; i++) s.market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: 568, sellerScore: 50 });
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_500_000, blocks: 8640, apr: 0.05, leasePpm: 8219, status: "FINISHED" })),
  );
  t.after(() => __setHistoryForTests([]));
  const thirty = s.magma.addOffer({ ...WINDOW, feeRatePpm: 66, baseFeeSats: 852, minBlockLength: 4320 });
  const rec = await s.autopilot.magmaReport();
  assert.equal(rec.sell.standardLeaseBlocks, 8640);
  assert.equal(rec.sell.recommendations.find((r) => r.offerId === thirty.id)?.recommended.minBlockLength, 8640, "a price button would set the 60-day standard");
  await s.autopilot.runOnce();
  assert.deepEqual([thirty.feeRatePpm, thirty.minBlockLength], [66, 4320]);
  const entry = s.autopilot.offerSyncStatus().offers.find((e) => e.offerId === thirty.id);
  assert.match(entry?.differences.join(" | ") ?? "", /not repriced: the market price is for a 8,640-block lease, and this offer promises 4,320 blocks — that price is for a much longer lease than its own/);
});
