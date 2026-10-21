/**
 * D7: standard offer terms. Every offer promises the standard 4320-block lease
 * buyers use (min_block_length is a minimum, so it serves longer leases too)
 * and the routing-fee caps the fee autopilot then keeps for each sold channel.
 *
 * Before: auto-size only ever SHORTENED a lease — min(4032, 4320) = 4032, so
 * the live 4032-block offer (a length no order had used since 2022) was never
 * corrected, and that fix sat behind the sizing logic's "no recommendation" and
 * "not enough room" exits, so a capital-limited node never got it. Offers
 * carried no fee caps at all; the manual form defaulted to 4032.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sellerSetup } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { quiet } from "./helpers/lifecycle.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";

/** The node's live offer as it was: created by 0.7.0, 66 ppm + 852, 4032 blocks, no caps. */
const LIVE = { id: "ea9edb42-d005-46ce-b2a9-97d8e3811f59", minSats: 1_000_000, maxSats: 1_252_252, totalSats: 1_252_252, feeRatePpm: 66, baseFeeSats: 852, minBlockLength: 4032 };

const inputOf = (magma: FakeMagma, op: string) =>
  magma.calls.filter((c) => c.op === op).map((c) => c.variables.input as Record<string, unknown>);

test("auto-size raises a 4032-block lease to the standard 4320 — on a node whose capital can't widen the window too, and with no market recommendation at all", async (t) => {
  quiet(t);
  for (const marketDown of [false, true]) {
    // ~1.4M on chain: the window can't grow (no room) — the old exit.
    const { autopilot, magma, market } = sellerSetup(t, { chainBalance: 1_400_000, config: { sellAutoSize: true } });
    if (marketDown) market.behaviour = "throw"; // no recommendation this run
    const offer = magma.addOffer(LIVE);
    await autopilot.runOnce();
    assert.equal(offer.minBlockLength, 4320, `market down: ${marketDown}`);
    assert.equal(offer.feeRatePpm, 66, "auto-pricing is off: the price is the operator's");
    const update = inputOf(magma, "UpdateOffer")[0];
    assert.equal(update?.min_block_length, 4320);
    const sells = autopilot.getState().history[0]?.sells ?? [];
    assert.ok(sells.some((s) => s.ok && (s.action === "terms" || s.action === "resize")), JSON.stringify(sells));
  }
});

test("with auto-size off, the lease is the operator's — the autopilot does not touch it", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 3_000_000 });
  const offer = magma.addOffer({ ...LIVE, maxSats: 2_000_000, totalSats: 2_000_000 });
  await autopilot.runOnce();
  assert.equal(offer.minBlockLength, 4032);
});

test("with auto-size on, every offer the autopilot manages carries the routing-fee promise — max(2,200 ppm, the fee policy's max), max(1 sat, its base fee) — written, read back, in sync", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, {
    chainBalance: 3_000_000,
    config: {
      sellAutoSize: true,
      policy: { minPpm: 25, neutralPpm: 80, maxPpm: 3000, protectPpm: 350, baseFeeMsat: 1500, step: 10, minChangePpm: 25, safetyMargin: 1.15, noFlowRatchetSteps: 3, exploreLowerModifier: 0.85 },
    },
  });
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await autopilot.runOnce();
  const update = inputOf(magma, "UpdateOffer")[0];
  assert.equal(update?.fee_rate_cap, 3000);
  assert.equal(update?.base_fee_cap, 2);
  assert.equal(offer.feeRateCap, "3000");
  assert.equal(offer.baseFeeCap, "2");
  const entry = autopilot.offerSyncStatus().offers.find((e) => e.offerId === offer.id);
  assert.equal(entry?.lastWrite?.verified, true, "read back: Amboss stored the promise");
  assert.equal(entry?.amboss.feeRateCapPpm, 3000);
  // In sync now: the next run writes nothing.
  const before = magma.count("UpdateOffer");
  await autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), before);
});

test("with every offer-automation switch off, the autopilot changes none of an offer's terms — not even the routing-fee promise (one set on amboss.tech stays) — and the diagnostics say so; auto-size gives it the standard lease and promise", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  new FakeMarket(http, t);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 3_000_000 }) });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  api.autopilot.setConfig({
    sellEnabled: true,
    sellAutoReprice: false,
    sellAutoSize: false,
    sellAutoRelist: false,
    sellMaxDeploySats: 50_000_000,
    sellMaxChannelSats: 10_000_000,
  });
  // A promise the operator set on amboss.tech (looser than the app's standard), and an old lease.
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRateCap: "5000", baseFeeCap: "3", minBlockLength: 4032 });
  await api.autopilot.runOnce();
  // Before: fee_rate_cap 2,200 and base_fee_cap 1 written over the operator's
  // promise — while the diagnostics said "only the capital limits apply".
  assert.equal(magma.count("UpdateOffer"), 0, "nothing written");
  assert.deepEqual([offer.feeRateCap, offer.baseFeeCap, offer.minBlockLength], ["5000", "3", 4032]);
  const checks = async () => (await api.request("GET", "/amboss/sell-diagnostics")).body.checks as { id: string; detail: string }[];
  const off = await checks();
  assert.equal(off.find((c) => c.id === "automation")?.detail, "All off — the offer's terms are yours; only the capital limits apply.");
  assert.match(off.find((c) => c.id === `terms:${offer.id}`)?.detail ?? "", /Auto-size is off: the autopilot leaves the lease and the fee promise as they are/);
  // Auto-size on: the standard terms, lease and promise — and the diagnostics name both.
  api.autopilot.setConfig({ sellAutoSize: true });
  await api.autopilot.runOnce();
  assert.deepEqual([offer.feeRateCap, offer.baseFeeCap, offer.minBlockLength], ["2200", "1", 4320]);
  assert.match((await checks()).find((c) => c.id === "automation")?.detail ?? "", /auto-size \(standard lease and routing-fee promise, sane window\)/);
});

test("a manual create or edit on Market → Sell sends the promise too, with the operator's lease", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  new FakeMarket(http, t);
  const api = await startApi(t);
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  const terms = { totalSizeSats: 4_000_000, minSizeSats: 1_000_000, maxSizeSats: 4_000_000, feeRatePpm: 2971, baseFeeSats: 852, minBlockLength: 4320 };
  const created = await api.request("POST", "/amboss/offer", terms);
  assert.equal(created.status, 200);
  const create = inputOf(magma, "CreateOffer")[0];
  assert.equal(create.fee_rate_cap, 2200);
  assert.equal(create.base_fee_cap, 1);
  assert.equal(create.min_block_length, 4320);
  const updated = await api.request("POST", "/amboss/offer/update", { id: created.body.offerId, ...terms, minBlockLength: 8640 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.verified, true);
  const update = inputOf(magma, "UpdateOffer")[0];
  assert.equal(update.fee_rate_cap, 2200);
  assert.equal(update.min_block_length, 8640, "the operator's own lease");
});

test("the engine recommends the standard lease and the promise, and says when an offer's lease is off — shorter as well as longer", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 3_000_000 });
  magma.addOffer(LIVE);
  const rec = await autopilot.magmaReport();
  const r0 = rec.sell.recommendations[0];
  assert.equal(r0.recommended.minBlockLength, 4320, "not the offer's 4032");
  assert.equal(r0.recommended.feeRateCapPpm, 2200);
  assert.equal(r0.recommended.baseFeeCapSats, 1);
  assert.equal(rec.sell.standardLeaseBlocks, 4320);
  // Before: warned only about a LONGER lease.
  assert.ok(rec.sell.warnings.some((w) => /4032-block lease — a length almost no order uses; the standard is 4320/.test(w)), rec.sell.warnings.join(" | "));
  assert.ok(r0.warnings.some((w) => /no routing-fee cap/.test(w)), r0.warnings.join(" | "));
  // Nothing claims size is what keeps the offer idle any more (D19).
  assert.ok(![...rec.sell.warnings, ...rec.sell.reasons, ...r0.warnings, ...r0.reasons].some((w) => /size, not price/.test(w)));
});

test("the engine's words on price: an offer above what buyers paid is 'priced above', not 'lower to fill faster'; the per-sale comparison says per sale, in %/yr — never 'APY' or 'list around'", async (t) => {
  quiet(t);
  const { autopilot, magma, market } = sellerSetup(t, { chainBalance: 5_000_000, config: { sellAutoReprice: true, sellPricingMode: "auto" } });
  for (let i = 0; i < 8; i++) market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: 568, sellerScore: 50 });
  // Real fills in the offer's band cleared at ~5% a year (~4,100 ppm per 4,320-block lease).
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_500_000, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })),
  );
  t.after(() => __setHistoryForTests([]));
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRatePpm: 20_000, baseFeeSats: 852, minBlockLength: 4320 });
  const rec = await autopilot.magmaReport();
  const r0 = rec.sell.recommendations.find((r) => r.offerId === offer.id)!;
  assert.equal(r0.state, "overpriced");
  const words = [...r0.reasons, ...r0.warnings, ...rec.sell.reasons, ...rec.sell.warnings].join("\n");
  assert.match(words, /priced above what buyers paid for comparable leases \(\d+ ppm effective vs a recommended \d+\)/);
  assert.match(words, /per sale, a lease at this price nets ~[\d.]+%\/yr \(after on-chain costs and the service fee\)/);
  assert.doesNotMatch(words, /fill faster|APY|list around/);
  // The summary under "Priced to beat routing" is per sale — whether orders
  // come is the eligibility check's answer, paired with it on Market → Sell.
  assert.equal(rec.sell.state, "good_to_sell");
  assert.match(rec.sell.reasons[0], /^per sale, a 30-day lease at around \d+ ppm effective beats routing this capital$/);
  // And Auto does follow the market down — which is why its description no
  // longer says it "never lowers the price on its own".
  await autopilot.runOnce();
  assert.ok(offer.feeRatePpm < 20_000, `repriced toward what buyers paid: ${offer.feeRatePpm}`);
});
