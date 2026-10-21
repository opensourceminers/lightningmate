/**
 * "Why don't I sell?" answered automatically (m3-sellpath:diagnosis-checklist,
 * a6-ux:sell-diagnosis-hidden): GET /amboss/sell-diagnostics reports, from the
 * live state, every gate the review had to check by hand — version, write mode,
 * key, Liquidity provision and the automation, the order lane, the offer vs
 * the engine's target (price, window, lease, fee promise), the last offer
 * write, recent orders and how they ended, and the eligibility verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { BUYER } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";
import { withEnv } from "./helpers/env.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import type { AfterHook } from "./helpers/tmp.js";

async function setup(t: AfterHook, chainBalance = 1_400_000) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const market = new FakeMarket(http, t);
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 1_500_000 + i * 300_000, sellerScore: i, filledOrders: 0, monthsListed: 8 });
  market.ownScore = 5.22;
  const api = await startApi(t, { node: new FakeLnd({ chainBalance }) });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  return { api, magma, market };
}

const check = (body: { checks: { id: string; status: string; detail: string }[] }, id: string) => {
  const c = body.checks.find((x) => x.id === id);
  assert.ok(c, `no check ${id}: ${body.checks.map((x) => x.id).join(", ")}`);
  return c;
};

test("the live offer's case, diagnosed without a single manual step: an odd lease, no fee promise, an unrealistic cell — and selling off while the offer is listed", async (t) => {
  quiet(t);
  withEnv(t, { APP_VERSION: "v0.8.0" });
  const { api, magma, market } = await setup(t);
  magma.addOffer({ id: "ea9edb42-d005-46ce-b2a9-97d8e3811f59", minSats: 1_000_000, maxSats: 1_252_252, totalSats: 1_252_252, feeRatePpm: 66, baseFeeSats: 852, minBlockLength: 4032 });
  // The same offer as the public book shows it.
  market.addOffer({ id: "ea9edb42-d005-46ce-b2a9-97d8e3811f59", sellerPubkey: api.node.publicKey, sellerScore: 5.22, minSats: 1_000_000, maxSats: 1_252_252, totalSats: 1_252_252, feeRatePpm: 66, baseFeeSats: 852, minBlockLength: 4032 });
  const res = await api.request("GET", "/amboss/sell-diagnostics");
  assert.equal(res.status, 200);
  const body = res.body;
  assert.match(check(body, "version").detail, /v0\.8\.0/);
  assert.equal(check(body, "write").status, "ok");
  assert.equal(check(body, "key").status, "ok");
  const provision = check(body, "provision");
  assert.equal(provision.status, "problem");
  assert.match(provision.detail, /Off while an offer is listed: new orders wait for your decision/);
  const terms = check(body, "terms:ea9edb42-d005-46ce-b2a9-97d8e3811f59");
  assert.equal(terms.status, "problem");
  assert.match(terms.detail, /lease: Amboss has 4,032 blocks, the standard is 4,320/);
  assert.match(terms.detail, /fee promise: none on Amboss — the standard is 2,200 ppm \+ 1 sat base/);
  assert.match(terms.detail, /price: Amboss has 66 ppm \+ 852 sat .*the engine would list/);
  const elig = check(body, "eligibility");
  assert.equal(elig.status, "problem");
  assert.match(elig.detail, /^Not realistic yet — Offers like yours/);
  // $5 is ~2.08M of channel at the market rate — and ~4.95M at this offer's
  // own price (66 ppm + 852 sat, plus Amboss's 1,000 ppm): far above its 1.25M.
  // The connectivity side of Amboss's picking, from LND: no public channel yet.
  assert.match(check(body, "node").detail, /^0 public channels, 0 sat capacity\. Amboss weighs reliability and connectivity/);
  const usd = check(body, "usd-orders");
  assert.equal(usd.status, "problem");
  assert.match(usd.detail, /the smallest \(\$5\) is about 2,078,870 sat of channel at today's rate \(about 4,94\d,\d{3} sat at your offer's price, Amboss's fee included\)/);
  assert.equal(body.offers[0].owner, "nobody");
  assert.equal(body.offers[0].target.minBlockLength, 4320);
  // The window against the engine's, too (not only a max above what can be
  // funded): the offer's 1,000,000–1,252,252 sat vs the target, side by side.
  const target = body.offers[0].target;
  assert.ok(target.minSizeSats !== 1_000_000 || target.maxSizeSats !== 1_252_252, JSON.stringify(target));
  assert.match(
    terms.detail,
    new RegExp(`window: Amboss has 1,000,000–1,252,252 sat, the engine's target is ${target.minSizeSats.toLocaleString("en-US")}–${target.maxSizeSats.toLocaleString("en-US")} sat`),
  );
  assert.deepEqual([body.offers[0].amboss.minSizeSats, body.offers[0].amboss.maxSizeSats], [1_000_000, 1_252_252]);
});

test("a write Amboss didn't take, and an order the lane turned down, are on the checklist with their reasons", async (t) => {
  quiet(t);
  const { api, magma } = await setup(t, 10_000_000);
  api.autopilot.setConfig({ sellEnabled: true, sellMaxDeploySats: 2_000_000, sellMaxChannelSats: 5_000_000 });
  magma.addOffer({ minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000 });
  magma.behave.UpdateOffer = "false";
  await api.autopilot.runOnce();
  // A 3M order: above the 2M deploy cap — rejected at once, with the reason.
  magma.addSale({ buyerPubkey: BUYER, sizeSats: 3_000_000 });
  await api.autopilot.pollSellOrders();
  const body = (await api.request("GET", "/amboss/sell-diagnostics")).body;
  const write = check(body, "write-result");
  assert.equal(write.status, "problem");
  assert.match(write.detail, /did not land: Amboss did not apply the update \(success: false\)/);
  const orders = check(body, "orders");
  assert.match(orders.detail, /latest: .* rejected \(deploy cap reached/);
  assert.equal(body.orders.recent[0].action, "rejected");
  assert.equal(check(body, "provision").status, "ok");
});

test("parts that can't be read say so — never 'ok'", async (t) => {
  quiet(t);
  const { api, magma, market } = await setup(t);
  magma.readBehaviour = "throw";
  market.behaviour = "throw";
  const body = (await api.request("GET", "/amboss/sell-diagnostics")).body;
  assert.equal(check(body, "offer").status, "unknown");
  assert.match(check(body, "offer").detail, /Could not read your offers from Amboss/);
  assert.equal(check(body, "eligibility").status, "unknown");
  assert.match(check(body, "orders").detail, /sales list could not be read/);
});

test("each offer is held against the lease its price is for: a 90-day offer kept on purpose is no lease 'deviation' and gets the 90-day price; a price for a shorter lease than the offer promises is said not to be applied", async (t) => {
  quiet(t);
  const { api, magma } = await setup(t, 8_000_000);
  api.autopilot.setConfig({ sellEnabled: true, sellAutoReprice: true, sellAutoSize: false, sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000 });
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_500_000, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })),
  );
  t.after(() => __setHistoryForTests([]));
  const window = { minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRateCap: "2200", baseFeeCap: "1" };
  const ninety = magma.addOffer({ ...window, feeRatePpm: 2_000, baseFeeSats: 852, minBlockLength: 12_960 });
  const odd = magma.addOffer({ ...window, feeRatePpm: 66, baseFeeSats: 852, minBlockLength: 5_000 });
  const body = (await api.request("GET", "/amboss/sell-diagnostics")).body;
  const diag = (id: string) => body.offers.find((o: { offerId: string }) => o.offerId === id);
  // Before: the target was the standard 4,320 blocks at the 30-day price.
  assert.equal(diag(ninety.id).target.minBlockLength, 12_960);
  assert.ok(diag(ninety.id).target.feeRatePpm > 10_000, `the 90-day price: ${diag(ninety.id).target.feeRatePpm}`);
  const ninetyTerms = check(body, `terms:${ninety.id}`).detail;
  assert.doesNotMatch(ninetyTerms, /lease: Amboss has/);
  assert.match(ninetyTerms, /the engine would list [\d,]+ ppm \+ 852 sat \(12,329 ppm effective for 12,960 blocks\)/);
  assert.doesNotMatch(ninetyTerms, /not applied/, "a price for the lease it keeps is applied");
  const oddTerms = check(body, `terms:${odd.id}`).detail;
  assert.match(oddTerms, /lease: Amboss has 5,000 blocks, the standard is 4,320/);
  assert.match(oddTerms, /not applied: that price is for a 4,320-block lease, and with auto-size off this offer keeps its 5,000 blocks/);
  assert.match(oddTerms, /Auto-size is off: the autopilot leaves the lease and the fee promise as they are/);
});
