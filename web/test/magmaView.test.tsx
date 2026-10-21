/** @jsxRuntime automatic */
/** @jsxImportSource react */
// (tsx applies web/tsconfig.json's JSX settings to src/ only — the pragma
// selects the same automatic runtime for this test file.)
/**
 * The Magma views say what is known — live numbers, or labelled as what they
 * are — and nothing switches selling on behind the operator's back (D9, D11,
 * D12, D19, m3-sellpath:misleading-ui, a5, a6).
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SELLING_KEYS, buildPresets, matchesPreset } from "../src/presets";
import {
  OFFER_AUTOMATION_HINT,
  PRICING_MODES,
  SELLER_SCORE_COPY,
  STANDARD_LEASE_BLOCKS,
  buyConfirmMessage,
  disableSellingMessage,
  enableSellingMessage,
  freedCapitalMagmaHint,
  leaseBenchmarkLine,
  leaseWarning,
  localLabel,
  offerDraftDefaults,
  offerOwner,
  offerSizeWarning,
  priceDraft,
  pricedLeaseWarning,
  purchaseLabel,
  refusalDigest,
  sellSummary,
} from "../src/magmaView";
import { routingYield } from "../src/yieldView";
import { EligibilityCard, HowAmbossPicks, OfferPromiseNote, SellDiagnosticsCard } from "../src/components/MagmaSellInfo";
import { MarketPanel } from "../src/components/MarketPanel";
import { OverlayProvider } from "../src/components/Overlay";
import { RunState } from "../src/components/Switch";
import type { AutopilotConfig, Eligibility, MagmaV2Report, SellDiagnostics } from "../src/types";

const policy = { minPpm: 1, neutralPpm: 50, maxPpm: 500, protectPpm: 300, baseFeeMsat: 1000, step: 5, minChangePpm: 5 } as unknown as AutopilotConfig["policy"];
const rebalancePolicy = { econRatio: 0.5, amountSats: 100_000, maxLocalRatioTarget: 0.3, minLocalRatioSource: 0.6 } as unknown as AutopilotConfig["rebalancePolicy"];

test("D9: no Strategy preset switches selling on — or touches any selling setting; 'Max profit' no longer stops channel opens", () => {
  const presets = buildPresets({ policy, rebalancePolicy });
  assert.ok(presets.length >= 3);
  for (const p of presets) {
    for (const k of SELLING_KEYS) assert.equal(k in p.cfg, false, `${p.label} sets ${k}`);
  }
  const profit = presets.find((p) => p.id === "profit")!;
  assert.notEqual(profit.cfg.channelEnabled, false, "leaving capital idle 'for leasing' is not a profit strategy for a node that doesn't sell");
  // Selling on or off, the same preset still reads as active.
  const balanced = presets.find((p) => p.id === "balanced")!;
  const applied = { ...balanced.cfg, policy: { ...policy, ...balanced.cfg.policy }, rebalancePolicy: { ...rebalancePolicy, ...balanced.cfg.rebalancePolicy } } as unknown as AutopilotConfig;
  assert.equal(matchesPreset({ ...applied, sellEnabled: true }, balanced.cfg), true);
  assert.equal(matchesPreset({ ...applied, sellEnabled: false }, balanced.cfg), true);
});

const eligibility = (o: Partial<Eligibility> = {}): Eligibility => ({
  verdict: "not_realistic",
  indicative: true,
  computedAt: "2026-10-20T10:00:00.000Z",
  bookFetchedAt: "2026-10-20T09:59:00.000Z",
  own: { sellerScore: 5.2, confirmedSells: 0, listableSat: 1_250_000, maxChannelSat: 1_250_000 },
  tier: { ambossFee: 1000, fromSat: 1_000_001, toSat: 5_000_000 },
  feeTiers: [],
  scoreSplit: { median: 20, side: "at_or_below" },
  comparable: { offers: 31, sold: 0, fills: 0, offerMonths: 224.6, fillsPerMonth: 0, upperBoundPerMonth: 0.0134 },
  widened: false,
  otherSide: null,
  expectedSalesPerYear: 0.16,
  usdOrders: { minOrderSat: 2_080_000, atOwnPriceSat: null, fits: false },
  reasons: ["31 comparable offers (score at or below 20, listed up to 5M) — 0 ever sold in 224.6 offer-months"],
  ...o,
});

test("D9: the confirmation before switching selling on carries the live verdict and its evidence, and says who picks sellers", () => {
  const msg = enableSellingMessage(eligibility());
  assert.match(msg, /Not realistic yet/);
  assert.match(msg, /31 comparable offers .* 0 ever sold/);
  assert.match(msg, /less than once a year/);
  assert.match(msg, /Amboss decides which seller gets an order/);
  const unknown = enableSellingMessage(null);
  assert.match(unknown, /Unknown/);
  assert.match(unknown, /could not be made/);
  assert.match(disableSellingMessage(2), /2 offers are still listed/);
});

test("the Orders tab never calls an order paid that LightningMate didn't hold the payment for", () => {
  assert.equal(localLabel({ phase: "settled", booked: true }), "completed · payment settled");
  assert.match(localLabel({ phase: "settled", booked: false }), /not booked/);
  assert.equal(localLabel({ phase: "failed", external: "accepted_elsewhere" }), "accepted outside LightningMate");
  assert.equal(localLabel({ phase: "rejected", external: "other_node" }), "another node's order");
});

test("offer ownership as the Sell tab shows it: yours after a manual edit, the autopilot's otherwise, nobody's with selling off", () => {
  assert.equal(offerOwner({ manual: { since: "2026-10-20T10:00:00Z", why: "you edited this offer" } }, true).label, "yours");
  assert.equal(offerOwner({}, true).label, "autopilot");
  assert.equal(offerOwner(undefined, false).label, "not managed");
});

const report = (sell: Partial<MagmaV2Report["sell"]>): MagmaV2Report => ({ sell: { recommendations: [], ...sell } }) as unknown as MagmaV2Report;

test("D7/a6: the Sell form starts on the standard 30-day lease and a window the autopilot would serve — not 4,032 blocks and 1M–5M under a 2M cap", () => {
  const caps = { sellMaxChannelSats: 2_000_000, sellMaxDeploySats: 2_000_000 };
  const bare = offerDraftDefaults(null, caps);
  assert.equal(bare.minBlockLength, STANDARD_LEASE_BLOCKS);
  assert.equal(STANDARD_LEASE_BLOCKS, 4320);
  assert.ok(bare.maxSizeSats <= 2_000_000 && bare.totalSizeSats <= 2_000_000, JSON.stringify(bare));
  // The engine's window, clamped to what can be funded now.
  const d = offerDraftDefaults(report({ recommendedMinSizeSat: 400_000, recommendedMaxSizeSat: 3_000_000, effectiveMaxOrderSat: 1_200_000, standardLeaseBlocks: 4320 }), caps);
  assert.deepEqual([d.minSizeSats, d.maxSizeSats, d.totalSizeSats, d.minBlockLength], [400_000, 1_200_000, 1_200_000, 4320]);
  // A max above what the autopilot will serve is called out before listing.
  const config = { sellEnabled: true, ...caps };
  assert.match(offerSizeWarning({ maxSizeSats: 5_000_000 }, config, 3_000_000) ?? "", /Channels above 2,000,000 sat \(your max channel size\) would be turned down/);
  assert.match(offerSizeWarning({ maxSizeSats: 1_900_000 }, config, 1_500_000) ?? "", /what your wallet can fund now/);
  assert.equal(offerSizeWarning({ maxSizeSats: 1_000_000 }, config, 1_500_000), null);
  assert.equal(offerSizeWarning({ maxSizeSats: 5_000_000 }, { ...config, sellEnabled: false }, 0), null, "selling off: you decide each order");
});

test("a4: the buy confirmation states lease, the seller's fee promise and Amboss's fee — and that declining cancels the order", () => {
  const q = { orderId: "o1", paymentRequest: "lnbc1", sats: 6_568, channelSizeSats: 2_000_000, leaseBlocks: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1, ambossFeeSats: 1500 };
  const msg = buyConfirmMessage(q, { sellerPubkey: "02" + "ab".repeat(32), leaseDays: 30, feeRateCapPpm: 2200, baseFeeCapSats: 1 });
  assert.match(msg, /6,568 sat fee \(incl\. 1,500 sat Amboss fee\)/);
  assert.match(msg, /2,000,000 sat inbound channel for at least 30 days/);
  assert.match(msg, /at or below 2,200 ppm \+ 1 sat/);
  assert.match(msg, /If you decline, the order is cancelled on Amboss/);
  const noCap = buyConfirmMessage({ ...q, feeRateCapPpm: null, baseFeeCapSats: null }, { sellerPubkey: "02" + "ab".repeat(32), leaseDays: 30, feeRateCapPpm: null, baseFeeCapSats: null });
  assert.match(noCap, /promises no routing-fee cap/);
});

test("D12: the Overview's lease benchmark is live or says selling isn't realistic — never the old constant", () => {
  assert.equal(leaseBenchmarkLine({ status: "eligible", grossAprPct: 4.97, sales: 51, windowDays: 30, text: "" }), "Magma lease ≈ 4.97%/yr (gross, buyer-paid)");
  assert.match(leaseBenchmarkLine({ status: "not_realistic", grossAprPct: null, sales: null, windowDays: null, text: "" }) ?? "", /not realistic for this node yet/);
  assert.equal(leaseBenchmarkLine({ status: "unknown", grossAprPct: null, sales: null, windowDays: null, text: "" }), null);
  assert.equal(leaseBenchmarkLine(undefined), null);
});

test("a5: routing yield is on the node's own capital in open channels, gross and after rebalancing", () => {
  const y = routingYield(
    [
      { status: "open", localBalance: 1_000_000 },
      { status: "open", localBalance: 500_000 },
      { status: "pending_open", localBalance: 2_000_000 },
    ],
    1_500,
    500,
    30,
  );
  assert.equal(y.ownCapitalSats, 1_500_000);
  assert.equal(y.grossPctYear!.toFixed(3), ((1_500 / 1_500_000) * (365 / 30) * 100).toFixed(3));
  assert.equal(y.netPctYear!.toFixed(3), ((1_000 / 1_500_000) * (365 / 30) * 100).toFixed(3));
  assert.deepEqual(routingYield([], 100, 0, 30), { ownCapitalSats: 0, grossPctYear: null, netPctYear: null });
});

test("m3-sellpath:misleading-ui: the pricing modes say what they do — Low doesn't undercut; Auto steps up after sales and follows the market down, so it never claims 'never lowers'", () => {
  const text = PRICING_MODES.map((m) => `${m.label}: ${m.desc}`).join("\n");
  assert.doesNotMatch(text, /undercut|lowers when/i);
  const auto = PRICING_MODES.find((m) => m.id === "auto")!.desc;
  // Auto reprices an offer above what buyers paid DOWN (review P1b, probe D):
  // "it never lowers the price on its own" was false.
  assert.doesNotMatch(auto, /never lowers/);
  assert.match(auto, /between the 25th and 75th percentile of what buyers actually paid/);
  assert.match(auto, /steps up after each sale/);
  assert.match(auto, /when buyers pay less, your price comes down with it/);
  assert.match(PRICING_MODES.find((m) => m.id === "fast")!.desc, /25th percentile/);
});

test("a6: refused orders reach the Overview digest", () => {
  assert.equal(refusalDigest(0, null), null);
  assert.equal(refusalDigest(2, "above your max channel size"), "2 Magma orders turned down in the last 2 days — above your max channel size");
});

test("D8/D11: the eligibility card shows the verdict with its live numbers, labelled indicative, with the seller-score truth", () => {
  const html = renderToStaticMarkup(<EligibilityCard e={eligibility()} />);
  assert.match(html, /Not realistic yet/);
  assert.match(html, /31 comparable offers/);
  assert.match(html, /Indicative/);
  assert.ok(html.includes("settings cannot raise it"), html);
  assert.equal(SELLER_SCORE_COPY, "Amboss computes the seller score from reliability, speed and track record of completed Magma orders; settings cannot raise it.");
  assert.match(renderToStaticMarkup(<EligibilityCard e={null} busy />), /checking Amboss/);
});

test("a6/m3: the diagnostics card lists every check with its mark, opens on problems, and offers each fix", () => {
  const d = {
    generatedAt: "2026-10-20T10:00:00.000Z",
    checks: [
      { id: "key", status: "ok", label: "Amboss key", detail: "valid" },
      { id: "provision", status: "problem", label: "Liquidity provision", detail: "off — orders wait for you", fix: { tab: "autopilot", sub: "magma", label: "Turn on" } },
      { id: "eligibility", status: "info", label: "Can this node sell?", detail: "Not realistic yet" },
    ],
    offers: [],
    orders: { recent: [{ orderId: "o1", sizeSats: 3_000_000, phase: "rejected", seenAt: "2026-10-20T09:00:00.000Z", at: "2026-10-20T09:00:05.000Z", action: "rejected", reason: "above your max channel size" }], failedOnAmboss: null },
    lane: { ok: true },
    eligibility: null,
  } as unknown as SellDiagnostics;
  const html = renderToStaticMarkup(<SellDiagnosticsCard d={d} onFix={() => undefined} />);
  assert.match(html, /1 problem/);
  assert.match(html, /<details[^>]*open/);
  assert.match(html, /✗/);
  assert.match(html, /Turn on/);
  assert.match(html, /above your max channel size/);
  assert.equal(renderToStaticMarkup(<SellDiagnosticsCard d={null} />), "");
});

test("m3/diagnosis: the diagnostics card shows each offer's terms on Amboss next to the engine's target — the differing ones marked", () => {
  const terms = { feeRatePpm: 66, baseFeeSats: 852, minSizeSats: 1_000_000, maxSizeSats: 1_252_252, minBlockLength: 4032, feeRateCapPpm: null, baseFeeCapSats: null };
  const d = {
    generatedAt: "2026-10-20T10:00:00.000Z",
    checks: [],
    offers: [
      {
        offerId: "ea9edb42-d005-46ce-b2a9-97d8e3811f59",
        owner: "nobody",
        amboss: { status: "ENABLED", ...terms },
        target: { ...terms, feeRatePpm: 2880, baseFeeSats: 568, minSizeSats: 400_000, maxSizeSats: 1_200_000, minBlockLength: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1 },
        differences: [],
        lastWrite: null,
      },
    ],
    orders: { recent: [], failedOnAmboss: null },
    lane: { ok: true },
    eligibility: null,
  } as unknown as SellDiagnostics;
  const html = renderToStaticMarkup(<SellDiagnosticsCard d={d} />);
  assert.match(html, /Offer ea9edb42… · enabled · not managed/);
  assert.match(html, /<td>66 ppm \+ 852 sat<\/td><td>2,880 ppm \+ 568 sat ≠<\/td>/);
  assert.match(html, /<td>1,000,000–1,252,252 sat<\/td><td>400,000–1,200,000 sat ≠<\/td>/);
  assert.match(html, /<td>4,032 blocks<\/td><td>4,320 blocks ≠<\/td>/);
  assert.match(html, /<td>none<\/td><td>≤ 2,200 ppm \+ 1 sat ≠<\/td>/);
});

test("D19: 'How Amboss picks sellers' explains the matching — no 'size, not price' or reach promise; observations dated, inferences labelled, fee tiers live", () => {
  const html = renderToStaticMarkup(
    <HowAmbossPicks
      usdOrderSat={2_079_000}
      feeTiers={[
        { ambossFeePpm: 1500, upToSats: 1_000_000 },
        { ambossFeePpm: 1000, upToSats: 5_000_000 },
        { ambossFeePpm: 350, upToSats: null },
      ]}
    />,
  );
  assert.match(html, /Fast Fulfillment/);
  assert.match(html, /\$5 minimum/);
  assert.match(html, /2,079,000 sat/);
  assert.match(html, /paid by the buyer/);
  assert.doesNotMatch(html, /size, not price|could be matched with you|builds score/i);
  // Tor: true for every user of this app, not the owner's own decision.
  assert.match(html, /Tor-only nodes can sell<\/b> — Tor is not what blocks matching/);
  assert.doesNotMatch(html, /Your node stays Tor-only/);
  // The Rails/LSP statements are dated observations, the hosting an inference.
  assert.match(html, /an observation of October 2026, not a documented rule/);
  assert.match(html, /inferred to be Amboss/);
  assert.doesNotMatch(html, /each resolve to a node Amboss hosts/);
  // The Amboss fee tiers: live from the book …
  assert.match(html, /live from Amboss(&#x27;|')s public offer book: 1,500 ppm up to 1,000,000 sat, 1,000 up to 5,000,000 sat, 350 above/);
  // … or, without them, dated — never undated "recent fills".
  const dated = renderToStaticMarkup(<HowAmbossPicks usdOrderSat={null} />);
  assert.match(dated, /on fills of October 2026: 1,500 ppm up to 1M/);
  assert.doesNotMatch(dated, /on recent fills/);
});

test("D9: Market opens on Buy, and Sell is labelled advanced; a deep link opens the asked sub-tab", () => {
  const html = renderToStaticMarkup(
    <OverlayProvider>
      <MarketPanel />
    </OverlayProvider>,
  );
  assert.match(html, /class="subtab active"[^>]*>Buy</);
  assert.match(html, />Sell \(advanced\)</);
  const orders = renderToStaticMarkup(
    <OverlayProvider>
      <MarketPanel initialSub="orders" />
    </OverlayProvider>,
  );
  assert.match(orders, /class="subtab active"[^>]*>Orders</);
});

test("m3-sellpath:misleading-ui: a switch that is on but can't run (write mode off) says so — not a cheerful ON", () => {
  assert.match(renderToStaticMarkup(<RunState on={true} blocked="write mode is off — nothing can run" />), /CAN(&#x27;|')T RUN/);
  assert.match(renderToStaticMarkup(<RunState on={true} />), />ON</);
  assert.match(renderToStaticMarkup(<RunState on={false} blocked="write mode is off" />), />OFF</);
});

test("the Close tab suggests listing freed capital on Magma only where this node can realistically sell", () => {
  const rec = {
    sell: {
      state: "good_to_sell",
      adjustedRoutingPpmPerYear: 10_000,
      recommendations: [{ economics: { beatsRouting: true, leaseApy: 4.8 } }],
    },
  } as unknown as MagmaV2Report;
  assert.equal(freedCapitalMagmaHint(rec, eligibility(), 1_500_000), null, "not realistic: no lease rate advertised");
  assert.equal(freedCapitalMagmaHint(rec, null, 1_500_000), null, "no verdict: no hint");
  const hint = freedCapitalMagmaHint(rec, eligibility({ verdict: "possible_but_slow", expectedSalesPerYear: 2.4 }), 1_500_000) ?? "";
  // The engine's leaseApy is net of on-chain costs and the service fee — never labelled "gross".
  assert.match(hint, /One Magma sale at today's price nets ~4\.8%\/yr \(after on-chain costs and the service fee\), against ~1\.00% routing; offers like yours sell about 2\.4 times a year/);
  assert.doesNotMatch(hint, /gross/);
});

test("offer ownership: a disable by hand is shown as such, whoever sets the terms — and an offer the autopilot disabled for lack of capital comes back", () => {
  const disabled = offerOwner({ disabledByHandAt: "2026-10-20T10:00:00Z" }, true);
  assert.equal(disabled.label, "autopilot", "a status click doesn't take the terms over");
  assert.match(disabled.title, /You disabled it: it stays disabled until you enable it/);
  const mine = offerOwner({ manual: { since: "2026-10-20T10:00:00Z", why: "you edited this offer" }, autoDisabledAt: "2026-10-20T11:00:00Z" }, true);
  assert.equal(mine.label, "yours");
  assert.match(mine.title, /lists it again once it can be funded/);
  assert.doesNotMatch(mine.title, /never enables/);
});

test("rec 5: 'Apply recommended' puts the engine's window into the edit, and every price button the lease its price is for — an odd lease becomes the standard; saving an odd one is warned about", () => {
  const caps = { sellMaxChannelSats: 2_000_000, sellMaxDeploySats: 2_000_000 };
  const rec = report({ recommendedMinSizeSat: 400_000, recommendedMaxSizeSat: 3_000_000, effectiveMaxOrderSat: 1_200_000, standardLeaseBlocks: 4320 });
  const live = { totalSizeSats: 1_252_252, minSizeSats: 1_000_000, maxSizeSats: 1_252_252, minBlockLength: 4032 };
  const price = { feeRatePpm: 2880, baseFeeSat: 568 };
  // Before: only the fee was copied — saving froze the 4,032-block lease (the
  // offer becomes the operator's, so auto-size never corrects it). The engine
  // prices that offer for the standard 4,320 blocks: the draft carries them.
  const full = priceDraft(live, price, 4320, rec, caps, true);
  assert.deepEqual(full, { minSizeSats: 400_000, maxSizeSats: 1_200_000, totalSizeSats: 1_252_252, feeRatePpm: 2880, baseFeeSats: 568, minBlockLength: 4320 });
  const priceOnly = priceDraft(live, price, 4320, rec, caps, false);
  assert.deepEqual([priceOnly.minSizeSats, priceOnly.maxSizeSats, priceOnly.minBlockLength, priceOnly.feeRatePpm], [1_000_000, 1_252_252, 4320, 2880]);
  assert.match(leaseWarning(4032) ?? "", /lease of 4,032 blocks is not one buyers use — the standard is 4,320 blocks/);
  assert.equal(leaseWarning(4320), null);
  assert.equal(leaseWarning(12_960), null);
});

test("a 90-day offer's price buttons fill in its 90-day price with its 90-day lease — never the 30-day price on a 90-day lease", () => {
  const caps = { sellMaxChannelSats: 2_000_000, sellMaxDeploySats: 2_000_000 };
  const rec = report({ recommendedMinSizeSat: 400_000, recommendedMaxSizeSat: 3_000_000, effectiveMaxOrderSat: 1_200_000, standardLeaseBlocks: 4320 });
  const ninety = { totalSizeSats: 2_000_000, minSizeSats: 1_000_000, maxSizeSats: 2_000_000, minBlockLength: 12_960 };
  // The engine prices a 90-day lease the offer keeps for 90 days (auto-size
  // off): about three times the 30-day price.
  const price90 = { feeRatePpm: 11_500, baseFeeSat: 852 };
  for (const full of [false, true]) {
    const d = priceDraft(ninety, price90, 12_960, rec, caps, full);
    // Before: the lease stayed 12,960 while the price was the engine's
    // 30-day one (3,508 ppm) — or "Apply recommended" set 4,320 blocks on
    // the 90-day price.
    assert.deepEqual([d.minBlockLength, d.feeRatePpm, d.baseFeeSats], [12_960, 11_500, 852], `full: ${full}`);
  }
  // With auto-size on, the autopilot gives the offer the standard lease: the
  // engine prices it for 30 days, and the draft carries the 30-day lease.
  assert.equal(priceDraft(ninety, { feeRatePpm: 3508, baseFeeSat: 852 }, 4320, rec, caps, false).minBlockLength, 4320);
  // A new offer's form starts on the lease its default price is for.
  const create = { mode: "create", recommended: { feeRatePpm: 3508, baseFeeSat: 852, minBlockLength: 4320 } };
  assert.equal(offerDraftDefaults(report({ standardLeaseBlocks: 4320, recommendations: [create] } as never), caps).minBlockLength, 4320);
  const only90 = { mode: "update", recommended: { feeRatePpm: 11_500, baseFeeSat: 852, minBlockLength: 12_960 } };
  const another = offerDraftDefaults(report({ standardLeaseBlocks: 4320, recommendations: [only90] } as never), caps);
  assert.deepEqual([another.feeRatePpm, another.minBlockLength], [11_500, 12_960], "a price and its lease go together");
  // The lease lengthened by hand after a price button: said before saving.
  assert.match(pricedLeaseWarning(12_960, 4320) ?? "", /price was worked out for a 4,320-block lease, and it promises 12,960 blocks/);
  assert.equal(pricedLeaseWarning(4320, 4320), null);
  assert.equal(pricedLeaseWarning(4032, 4320), null, "a shorter lease at a longer one's price undercharges nothing");
  assert.equal(pricedLeaseWarning(12_960, null), null, "no price button: the operator's own price");
});

test("Autopilot → Magma's ownership note says what the upkeep does: a disable by hand only unlists, the promise comes with auto-size, and with every switch off only fundability is kept", () => {
  // Before: "An offer you edit, create or disable by hand … is yours" (a
  // status click no longer takes the terms over) and "Every offer promises
  // buyers a routing-fee cap" (written even with every switch off).
  assert.doesNotMatch(OFFER_AUTOMATION_HINT, /or disable by hand/);
  assert.doesNotMatch(OFFER_AUTOMATION_HINT, /^Every offer promises/m);
  assert.match(OFFER_AUTOMATION_HINT, /Enabling or disabling an offer by hand decides only whether it is listed/);
  assert.match(OFFER_AUTOMATION_HINT, /With auto-size on, every offer the autopilot manages promises buyers a routing-fee cap/);
  assert.match(OFFER_AUTOMATION_HINT, /with every switch above off, the autopilot only keeps your offers fundable/);
});

test("Market → Sell's promise note and the seller explainer claim only what the upkeep does: the routing-fee promise and the standard lease come with auto-size (or a create/save on Market → Sell)", () => {
  // Before: "Every offer promises buyers a routing fee of at most …" — above
  // an offers table showing "Fee promise: none" for an offer made on
  // amboss.tech and upkept with auto-size off.
  const note = renderToStaticMarkup(<OfferPromiseNote caps={{ feeRateCapPpm: 2200, baseFeeCapSats: 1 }} leaseBlocks={4032} standardLeaseBlocks={4320} />);
  assert.doesNotMatch(note, /Every offer promises/);
  assert.match(note, /An offer you create or save on this page — or one the autopilot lists — promises buyers a routing fee of at most <b>2200 ppm \+ 1 sat<\/b> for the lease/);
  assert.match(note, /with auto-size on, the autopilot gives the other offers it manages the same promise/);
  assert.match(note, /Otherwise an offer \(one made on amboss\.tech, say\) keeps whatever promise it has — (&quot;|")none(&quot;|") below if it has none/);
  assert.match(note, /The fee autopilot keeps each sold channel within the cap its order locked/);
  assert.match(note, /The standard lease is 4320 blocks \(30 days\)\./);
  assert.doesNotMatch(renderToStaticMarkup(<OfferPromiseNote caps={{ feeRateCapPpm: 2200, baseFeeCapSats: 1 }} leaseBlocks={4320} standardLeaseBlocks={4320} />), /standard lease/);
  // Before: "LightningMate keeps the offer well-formed (the standard 30-day
  // lease, routing-fee caps it keeps, …)" — with auto-size off it changes
  // neither.
  const how = renderToStaticMarkup(<HowAmbossPicks usdOrderSat={null} />);
  assert.doesNotMatch(how, /keeps the offer well-formed/);
  assert.match(how, /with auto-size on, it also gives the offers it manages the standard 30-day lease, a routing-fee promise/);
  assert.match(how, /With Liquidity provision on, LightningMate fulfils orders fast and safely and keeps every offer within what it can fund/);
});

test("a purchase whose failure only the pay call reported is not called failed — LND is asked how it ended", () => {
  assert.equal(purchaseLabel({ state: "pay_failed" }), "payment unclear · checking with LND");
  assert.equal(purchaseLabel({ state: "pay_failed", failureConfirmed: true }), "payment failed");
  assert.equal(purchaseLabel({ state: "channel_open" }), "channel open");
});

test("Market → Sell's verdict line is per sale — and where offers like this node's don't sell, it says that is no reason to list", () => {
  const rec = report({ state: "good_to_sell", reasons: ["per sale, a lease at around 2880 ppm effective beats routing this capital"] });
  const notRealistic = sellSummary(rec, eligibility());
  assert.equal(notRealistic.label, "Per sale only");
  assert.equal(notRealistic.good, false);
  assert.match(notRealistic.line, /^per sale, a lease at around 2880 ppm effective beats routing this capital — but offers like yours don't sell/);
  assert.match(notRealistic.line, /no reason to list/);
  assert.match(sellSummary(rec, null).line, /whether orders come at all is unknown/);
  const slow = sellSummary(rec, eligibility({ verdict: "possible_but_slow", expectedSalesPerYear: 2.4 }));
  assert.deepEqual([slow.label, slow.good], ["Priced to beat routing", true]);
  assert.doesNotMatch(slow.line, /list around/);
});
