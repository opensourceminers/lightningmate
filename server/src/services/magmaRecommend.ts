import { getChainBalance, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { nodeCapitalYield, onchainCosts } from "./nodeEconomics.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { computeNodeNeed, type NodeNeed } from "./suggestRecommend.js";
import { saleFeeConfig } from "./serviceFee.js";
import { getMarket, getMyOffers, getMyOrders, type MagmaOffer, type MyOffer, type MyOrder } from "./amboss.js";

/**
 * Magma v2 — a profit-aware recommendation layer on top of the existing Magma
 * marketplace code. It does NOT execute anything: no updateOffer, no auto open/
 * close. It answers the questions that actually make (or lose) money when you
 * lease out liquidity:
 *
 *   Should I sell liquidity at all, given my node's need?
 *   At what price — competitive for my size band AND seller score?
 *   Does the lease yield actually beat what that capital earns me routing?
 *   Is my live offer underpriced (leaving money on the table) or so dear it
 *   won't fill? Should an exhausted offer relist at today's price, not yesterday's?
 *
 * 100% local + Amboss: live market snapshot, my offers/orders, my seller score,
 * my LND balances/forwards. No historical market data, no ML, no execution.
 */

export interface MagmaV2Config {
  blocksPerYear: number;
  serviceFeeRate: number;
  defaultOpenCostSat: number;
  defaultCloseCostSat: number;
  includeCloseCost: boolean;
  /** Approx on-chain tx size to cost the open/close from the live fee rate. */
  openTxVbytes: number;
  closeTxVbytes: number;
  /** Lease must out-yield routing by at least this ratio to be worth selling. */
  minLeaseVsRoutingRatio: number;
  defaultRoutingOpportunityPpmPerYear: number;
  minNetLeaseProfitSat: number;
  minSellSizeSat: number;
  maxSellSizeSat: number;
  onchainReserveSat: number;
  defaultMinBlockLength: number;
  sellPricingMode: "fast" | "balanced" | "premium" | "auto";
  /** For "auto": 0 = aggressive (undercut/low), 0.5 = median, 1 = premium. */
  adaptiveLevel: number;
  minFeeRatePpm: number;
  maxFeeRatePpm: number;
  minRepriceDeltaPpm: number;
  relativeRepriceThreshold: number;
  scorePremiumMin: number;
  scorePremiumMax: number;
  buyDesiredSizeSat: number;
}

export const MAGMA_V2_DEFAULTS: MagmaV2Config = {
  blocksPerYear: 52_560,
  serviceFeeRate: 0.01, // fallback; overridden by the live LM_SELL_FEE_BPS config
  defaultOpenCostSat: 1_000,
  defaultCloseCostSat: 500,
  includeCloseCost: true,
  openTxVbytes: 175,
  closeTxVbytes: 150,
  minLeaseVsRoutingRatio: 1.2,
  defaultRoutingOpportunityPpmPerYear: 10_000,
  minNetLeaseProfitSat: 500,
  minSellSizeSat: 1_000_000,
  maxSellSizeSat: 10_000_000,
  onchainReserveSat: 250_000,
  defaultMinBlockLength: 4032,
  sellPricingMode: "balanced",
  adaptiveLevel: 0.5,
  minFeeRatePpm: 1,
  maxFeeRatePpm: 50_000,
  minRepriceDeltaPpm: 25,
  relativeRepriceThreshold: 0.1,
  scorePremiumMin: -0.2,
  scorePremiumMax: 0.25,
  buyDesiredSizeSat: 2_000_000,
};

export type MagmaSellOfferState =
  | "well_priced"
  | "underpriced"
  | "overpriced"
  | "below_profit_floor"
  | "do_not_list_unprofitable"
  | "do_not_list_uncompetitive"
  | "exhausted"
  | "inactive";

export type MagmaBuyState =
  | "best_value"
  | "cheap_but_low_score"
  | "reliable_but_expensive"
  | "good_fit"
  | "size_mismatch";

export interface PricePoint {
  feeRatePpm: number;
  baseFeeSat: number;
  effectiveFeePpm: number;
  leaseApy: number;
}

export interface MagmaSellRecommendation {
  offerId: string | null;
  mode: "create" | "update" | "hold";
  state: MagmaSellOfferState;
  shouldReprice: boolean;
  repriceDirection: "up" | "down" | "none";
  current: { feeRatePpm: number; baseFeeSat: number; effectiveFeePpm: number } | null;
  recommended: PricePoint & { minBlockLength: number; sizeSat: number };
  market: {
    sizeBand: string;
    segmentCount: number;
    fallbackLevel: "size_band" | "all_offers";
    p10: number;
    p25: number;
    median: number;
    p75: number;
    mySellerScore: number | null;
    segmentMedianScore: number;
    scorePremium: number;
    myRank: number | null;
  };
  economics: {
    sizeSat: number;
    leaseYears: number;
    leaseFeeSat: number;
    serviceFeeSat: number;
    openCostSat: number;
    closeCostSat: number;
    netLeaseProfitSat: number;
    leasePpmPerYear: number;
    leaseApy: number;
    routingOpportunityPpmPerYear: number | null;
    adjustedRoutingPpmPerYear: number;
    profitFloorEffectivePpm: number;
    beatsRouting: boolean;
  };
  /** Concrete price points for the UI buttons. */
  pricing: { fast: PricePoint; balanced: PricePoint; premium: PricePoint; profitFloor: PricePoint };
  reasons: string[];
  warnings: string[];
}

export interface MagmaBuyRecommendation {
  offerId: string;
  sellerPubkey: string;
  state: MagmaBuyState;
  valueScore: number;
  effectiveCostPpm: number;
  sellerScore: number;
  minSizeSat: number;
  maxSizeSat: number;
  availableSat: number;
  reasons: string[];
}

export interface MagmaSellAnalytics {
  mySellerScore: number | null;
  offersActive: number;
  offersInactive: number;
  offersExhausted: number;
  totalListedSat: number;
  availableSat: number;
  deployedSat: number;
  filledOrders30d: number;
  filledOrdersAllTime: number;
  grossEarningsSat: number;
  serviceFeesSat: number;
  onchainCostsSat: number;
  netProfitSat: number;
  avgLeaseFeePpm: number | null;
  fillRate: number | null;
  closableSoon: number;
}

export interface MagmaV2Report {
  nodeNeed: NodeNeed;
  nodeNeedReason: string;
  hasRoutingData: boolean;
  satsPerUsd: number | null;
  sell: {
    state:
      | "good_to_sell"
      | "sell_only_above_profit_floor"
      | "market_too_cheap"
      | "insufficient_capital"
      | "not_recommended_node_needs_inbound";
    deployableCapitalSat: number;
    recommendedSellSizeSat: number | null;
    routingOpportunityPpmPerYear: number | null;
    adjustedRoutingPpmPerYear: number;
    recommendedMinLeasePpmPerYear: number;
    pricingMode: "fast" | "balanced" | "premium" | "auto";
    adaptiveLevel: number;
    optimalSizeSat: number;
    optimalLeaseBlocks: number;
    projectedMonthlySat: number;
    onchainOpenCostSat: number;
    onchainCloseCostSat: number;
    onchainFeePerVbyte: number | null;
    pendingSellerOrders: number;
    reasons: string[];
    warnings: string[];
    recommendations: MagmaSellRecommendation[];
  };
  buy: {
    state: "recommended" | "optional" | "not_needed" | "no_good_offers";
    recommendedBuySizeSat: number | null;
    bestOfferId: string | null;
    reasons: string[];
    warnings: string[];
    ranked: MagmaBuyRecommendation[];
  };
  analytics: MagmaSellAnalytics;
}

// ── math helpers ──────────────────────────────────────────────────────────────
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const effectiveAt = (feeRatePpm: number, baseFeeSat: number, sizeSat: number) =>
  feeRatePpm + (sizeSat > 0 ? (baseFeeSat / sizeSat) * 1_000_000 : 0);
function pct(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}
const median = (arr: number[]) => pct([...arr].sort((a, b) => a - b), 0.5);
const sizeBandLabel = (min: number, max: number) =>
  `${(min / 1e6).toFixed(min >= 1e6 ? 0 : 1)}M–${(max / 1e6).toFixed(max >= 1e6 ? 0 : 1)}M`;

const NEED_MULTIPLIER: Record<NodeNeed, number> = {
  need_revenue: 1.25,
  need_routing_diversity: 1.1,
  need_inbound: 0.8,
  need_outbound: 1,
  balanced: 1,
};

export async function getMagmaRecommendations(
  lnd: AuthenticatedLnd,
  apiKey: string,
  overrides: Partial<MagmaV2Config> = {},
): Promise<MagmaV2Report> {
  const cfg = { ...MAGMA_V2_DEFAULTS, ...overrides };
  // Keep the lease economics honest: use whatever service fee is actually charged
  // (LM_SELL_FEE_BPS), so the APY / profit-floor math never drifts from reality.
  if (overrides.serviceFeeRate === undefined) cfg.serviceFeeRate = saleFeeConfig().bps / 10_000;

  const [market, myOffers, myOrdersView, channels, chain, ownKey, flow, oc] = await Promise.all([
    getMarket(),
    getMyOffers(apiKey).catch(() => [] as MyOffer[]),
    getMyOrders(apiKey).catch(() => ({ orders: [] as MyOrder[], pendingSeller: 0 })),
    getChannelsView(lnd),
    getChainBalance({ lnd }).catch(() => ({ chain_balance: 0 })),
    getOwnPubkey(lnd),
    getFlowSummary(lnd, 30).catch(() => null),
    onchainCosts(lnd, cfg.openTxVbytes, cfg.closeTxVbytes),
  ]);

  const offers = market.offers;
  const myOrders = myOrdersView.orders.filter((o) => o.side === "SELL");

  // Live on-chain cost: a fee spike can make opening a channel cost more than the
  // lease earns, so the profit floor must react to it (shared node-economics model).
  const onchainFeePerVbyte = oc.feePerVbyte;
  cfg.defaultOpenCostSat = oc.openCostSat;
  cfg.defaultCloseCostSat = oc.closeCostSat;

  // ── Routing opportunity cost — yield ON CAPITAL (shared node-economics model).
  const fees30 = flow?.totalFeesEarnedSats ?? 0;
  const cy = nodeCapitalYield(channels, fees30, 30);
  const routingOpportunityPpmPerYear = cy.routingYieldPpmPerYear;
  const hasRoutingData = routingOpportunityPpmPerYear != null;
  const baseRouting = routingOpportunityPpmPerYear ?? cfg.defaultRoutingOpportunityPpmPerYear;

  const { nodeNeed, reason: nodeNeedReason } = computeNodeNeed(channels, fees30, 30);
  const adjustedRouting = Math.round(baseRouting * NEED_MULTIPLIER[nodeNeed]);
  const recommendedMinLeasePpmPerYear = Math.round(adjustedRouting * cfg.minLeaseVsRoutingRatio);

  const mySellerScore = offers.find((o) => o.sellerPubkey === ownKey)?.sellerScore ?? null;
  const deployableCapitalSat = Math.max(0, chain.chain_balance - cfg.onchainReserveSat);

  // ── economics for a given price ──
  const economics = (sizeSat: number, minBlockLength: number, effectiveFeePpm: number) => {
    const leaseYears = minBlockLength / cfg.blocksPerYear;
    const leaseFeeSat = (effectiveFeePpm / 1_000_000) * sizeSat;
    const serviceFeeSat = leaseFeeSat * cfg.serviceFeeRate;
    const openCostSat = cfg.defaultOpenCostSat;
    const closeCostSat = cfg.includeCloseCost ? cfg.defaultCloseCostSat : 0;
    const netLeaseProfitSat = leaseFeeSat - serviceFeeSat - openCostSat - closeCostSat;
    const leasePpm = (netLeaseProfitSat / sizeSat) * 1_000_000;
    const leasePpmPerYear = leaseYears > 0 ? leasePpm / leaseYears : leasePpm;
    return {
      sizeSat,
      leaseYears: Math.round(leaseYears * 100) / 100,
      leaseFeeSat: Math.round(leaseFeeSat),
      serviceFeeSat: Math.round(serviceFeeSat),
      openCostSat,
      closeCostSat,
      netLeaseProfitSat: Math.round(netLeaseProfitSat),
      leasePpmPerYear: Math.round(leasePpmPerYear),
      leaseApy: Math.round((leasePpmPerYear / 10_000) * 100) / 100,
    };
  };

  // Minimum effective ppm that clears both the routing bar and a min net profit.
  const profitFloorEffectivePpm = (sizeSat: number, minBlockLength: number) => {
    const leaseYears = minBlockLength / cfg.blocksPerYear;
    const openCostSat = cfg.defaultOpenCostSat;
    const closeCostSat = cfg.includeCloseCost ? cfg.defaultCloseCostSat : 0;
    const costPpm = ((openCostSat + closeCostSat) / sizeSat) * 1_000_000;
    const floorRouting = (recommendedMinLeasePpmPerYear * leaseYears + costPpm) / (1 - cfg.serviceFeeRate);
    const floorMinProfit =
      ((cfg.minNetLeaseProfitSat + openCostSat + closeCostSat) / (sizeSat * (1 - cfg.serviceFeeRate))) * 1_000_000;
    return Math.max(floorRouting, floorMinProfit, cfg.minFeeRatePpm);
  };

  // Comparable-offer segment + percentiles (effective ppm at our representative size).
  const segmentFor = (repSize: number, myMin: number, myMax: number) => {
    const overlaps = (o: MagmaOffer) => o.maxSizeSats >= myMin && o.minSizeSats <= myMax;
    let pool = offers.filter((o) => o.feeRatePpm > 0 || o.baseFeeSats > 0).filter(overlaps);
    let fallbackLevel: "size_band" | "all_offers" = "size_band";
    if (pool.length < 5) {
      pool = offers.filter((o) => o.feeRatePpm > 0 || o.baseFeeSats > 0);
      fallbackLevel = "all_offers";
    }
    const effs = pool.map((o) => effectiveAt(o.feeRatePpm, o.baseFeeSats, repSize)).sort((a, b) => a - b);
    const scores = pool.map((o) => o.sellerScore);
    const competitorEffs = pool
      .filter((o) => o.sellerPubkey !== ownKey)
      .map((o) => effectiveAt(o.feeRatePpm, o.baseFeeSats, repSize))
      .sort((a, b) => a - b);
    return {
      count: pool.length,
      fallbackLevel,
      p10: Math.round(pct(effs, 0.1)),
      p25: Math.round(pct(effs, 0.25)),
      median: Math.round(pct(effs, 0.5)),
      p75: Math.round(pct(effs, 0.75)),
      minCompetitor: competitorEffs.length ? Math.round(competitorEffs[0]) : 0,
      segmentMedianScore: median(scores),
      baseMed: Math.round(median(pool.map((o) => o.baseFeeSats))),
      effs,
    };
  };
  const interp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

  const scorePremium = (segMedScore: number): number => {
    if (mySellerScore == null) return 0;
    const rel = (mySellerScore - segMedScore) / Math.max(segMedScore, 1);
    return clamp(rel * 0.5, cfg.scorePremiumMin, cfg.scorePremiumMax);
  };

  // Turn a target effective ppm into a concrete fee_rate + base price point.
  const pricePointFrom = (
    effTarget: number,
    repSize: number,
    baseFeeSat: number,
    minBlockLength: number,
  ): PricePoint => {
    const feeRatePpm = clamp(
      Math.round(effTarget - (baseFeeSat / repSize) * 1_000_000),
      cfg.minFeeRatePpm,
      cfg.maxFeeRatePpm,
    );
    const effectiveFeePpm = Math.round(effectiveAt(feeRatePpm, baseFeeSat, repSize));
    const econ = economics(repSize, minBlockLength, effectiveFeePpm);
    return { feeRatePpm, baseFeeSat, effectiveFeePpm, leaseApy: econ.leaseApy };
  };

  // ── Build a sell recommendation for an existing offer (or a hypothetical create) ──
  const buildSell = (offer: MyOffer | null): MagmaSellRecommendation => {
    const minSize = offer?.minSizeSats ?? cfg.minSellSizeSat;
    const maxSize = offer?.maxSizeSats ?? Math.min(cfg.maxSellSizeSat, Math.max(cfg.minSellSizeSat, deployableCapitalSat));
    const minBlock = offer?.minBlockLength ?? cfg.defaultMinBlockLength;
    const repSize = Math.round(Math.sqrt(Math.max(minSize, 1) * Math.max(maxSize, minSize)));
    const seg = segmentFor(repSize, minSize, maxSize);
    const baseFee = offer?.baseFeeSats ?? seg.baseMed ?? 1000;
    const premium = scorePremium(seg.segmentMedianScore);
    const floorEff = Math.round(profitFloorEffectivePpm(repSize, minBlock));

    // Target effective price for the configured mode. "fast" undercuts the cheapest
    // competitor by 1 ppm (no score premium — the point is to win the next order);
    // "auto" interpolates p10→p75 by the adaptive level the autopilot maintains.
    const undercut = seg.minCompetitor > 0 ? seg.minCompetitor - 1 : seg.p10;
    const targetEff = Math.max(
      floorEff,
      cfg.sellPricingMode === "fast"
        ? undercut
        : cfg.sellPricingMode === "premium"
          ? Math.round(seg.p75 * (1 + premium))
          : cfg.sellPricingMode === "auto"
            ? Math.round(interp(seg.p10, seg.p75, cfg.adaptiveLevel) * (1 + premium))
            : Math.round(seg.median * (1 + premium)),
    );
    const recommended = pricePointFrom(targetEff, repSize, baseFee, minBlock);
    const recEcon = economics(repSize, minBlock, recommended.effectiveFeePpm);
    const beatsRouting = recEcon.leasePpmPerYear >= recommendedMinLeasePpmPerYear;

    const pricing = {
      fast: pricePointFrom(Math.max(floorEff, undercut), repSize, baseFee, minBlock),
      balanced: pricePointFrom(Math.max(floorEff, Math.round(seg.median * (1 + premium))), repSize, baseFee, minBlock),
      premium: pricePointFrom(Math.max(floorEff, Math.round(seg.p75 * (1 + premium))), repSize, baseFee, minBlock),
      profitFloor: pricePointFrom(floorEff, repSize, baseFee, minBlock),
    };

    const current = offer
      ? {
          feeRatePpm: offer.feeRatePpm,
          baseFeeSat: offer.baseFeeSats,
          effectiveFeePpm: Math.round(effectiveAt(offer.feeRatePpm, offer.baseFeeSats, repSize)),
        }
      : null;

    // Where would my current price rank among comparable offers?
    const myRank = current ? seg.effs.filter((e) => e < current.effectiveFeePpm).length + 1 : null;

    const reasons: string[] = [];
    const warnings: string[] = [];
    reasons.push(`priced against ${seg.count} comparable offers in your ${sizeBandLabel(minSize, maxSize)} band`);
    if (seg.fallbackLevel === "all_offers")
      warnings.push("few offers in your exact size band — compared against the whole market");
    if (premium > 0.02) reasons.push(`your seller score is above the segment median — applying a ${Math.round(premium * 100)}% premium`);
    else if (premium < -0.02) reasons.push(`your seller score is below the segment median — applying a ${Math.round(-premium * 100)}% discount`);
    if (mySellerScore == null) warnings.push("your seller score isn't visible yet (list an offer to appear in the market)");
    reasons.push(
      beatsRouting
        ? `lease APY ${recommended.leaseApy}% beats your routing benchmark ${(adjustedRouting / 10000).toFixed(2)}%`
        : `lease APY ${recommended.leaseApy}% is below your routing benchmark — leasing may not beat routing this capital`,
    );
    if (!hasRoutingData) warnings.push("no routing history yet — using a default routing benchmark; treat the APY comparison loosely");
    warnings.push("on-chain open/close cost is estimated; high mempool fees can erase lease profit");
    warnings.push("market is a live snapshot — no historical fill-rate available");

    // State machine.
    let state: MagmaSellOfferState;
    let mode: "create" | "update" | "hold" = offer ? "update" : "create";
    let shouldReprice = false;
    let repriceDirection: "up" | "down" | "none" = "none";

    if (offer && offer.status !== "ENABLED") {
      state = "inactive";
      mode = "hold";
    } else if (floorEff > seg.p75) {
      // Our profitable price is above the top of the market — listing won't fill.
      state = "do_not_list_uncompetitive";
      reasons.push("profitable price is above current market — an offer here may not fill quickly");
    } else if (!beatsRouting && cfg.sellPricingMode !== "premium") {
      state = "do_not_list_unprofitable";
      reasons.push("even the recommended price barely beats routing — better to keep this capital routing");
    } else if (offer && offer.totalSizeSats < offer.maxSizeSats) {
      state = "exhausted";
      reasons.push("offer is depleted — relist at today's recommended price, not the old one");
      shouldReprice = current ? recommended.effectiveFeePpm > current.effectiveFeePpm : false;
      repriceDirection = "up";
    } else if (current && current.effectiveFeePpm < floorEff) {
      state = "below_profit_floor";
      shouldReprice = true;
      repriceDirection = "up";
      reasons.push(`current price is below your profit floor (${floorEff} ppm effective) — raise it`);
    } else if (current) {
      const delta = recommended.effectiveFeePpm - current.effectiveFeePpm;
      const threshold = Math.max(cfg.minRepriceDeltaPpm, recommended.effectiveFeePpm * cfg.relativeRepriceThreshold);
      if (delta > threshold) {
        state = "underpriced";
        shouldReprice = true;
        repriceDirection = "up";
        reasons.push(`underpriced — you could charge ${Math.round((delta / Math.max(current.effectiveFeePpm, 1)) * 100)}% more`);
      } else if (delta < -threshold) {
        state = "overpriced";
        shouldReprice = true;
        repriceDirection = "down";
        reasons.push("overpriced versus the segment — lower to fill faster");
      } else {
        state = "well_priced";
        mode = "hold";
      }
    } else {
      state = "well_priced";
    }

    return {
      offerId: offer?.id ?? null,
      mode,
      state,
      shouldReprice,
      repriceDirection,
      current,
      recommended: { ...recommended, minBlockLength: minBlock, sizeSat: repSize },
      market: {
        sizeBand: sizeBandLabel(minSize, maxSize),
        segmentCount: seg.count,
        fallbackLevel: seg.fallbackLevel,
        p10: seg.p10,
        p25: seg.p25,
        median: seg.median,
        p75: seg.p75,
        mySellerScore,
        segmentMedianScore: Math.round(seg.segmentMedianScore * 10) / 10,
        scorePremium: Math.round(premium * 100) / 100,
        myRank,
      },
      economics: {
        ...recEcon,
        routingOpportunityPpmPerYear,
        adjustedRoutingPpmPerYear: adjustedRouting,
        profitFloorEffectivePpm: floorEff,
        beatsRouting,
      },
      pricing,
      reasons,
      warnings,
    };
  };

  const recommendations = myOffers.length
    ? myOffers.map((o) => buildSell(o))
    : deployableCapitalSat >= cfg.minSellSizeSat
      ? [buildSell(null)]
      : [];

  // ── Sell summary ──
  const recommendedSellSizeSat =
    deployableCapitalSat >= cfg.minSellSizeSat
      ? clamp(deployableCapitalSat, cfg.minSellSizeSat, cfg.maxSellSizeSat)
      : null;
  const sellReasons: string[] = [];
  const sellWarnings: string[] = [];
  let sellState: MagmaV2Report["sell"]["state"];
  if (nodeNeed === "need_inbound") {
    sellState = "not_recommended_node_needs_inbound";
    sellWarnings.push("your node currently needs inbound liquidity — selling more outbound may not improve receive capacity");
  } else if (deployableCapitalSat < cfg.minSellSizeSat) {
    sellState = "insufficient_capital";
    sellReasons.push(`only ${Math.round(deployableCapitalSat / 1000)}k deployable on-chain after reserve — below the ${cfg.minSellSizeSat / 1e6}M minimum`);
  } else {
    const refSize = recommendedSellSizeSat ?? cfg.minSellSizeSat;
    const floorEff = profitFloorEffectivePpm(refSize, cfg.defaultMinBlockLength);
    const seg = segmentFor(refSize, refSize, refSize);
    if (floorEff > seg.p75) {
      sellState = "market_too_cheap";
      sellReasons.push("the market is currently cheaper than your profitable price — wait or keep routing");
    } else if (floorEff > seg.median) {
      sellState = "sell_only_above_profit_floor";
      sellReasons.push("only list above your profit floor — the market median is below what makes leasing worthwhile");
    } else {
      sellState = "good_to_sell";
      sellReasons.push(`leasing beats routing here — list around ${seg.median} ppm effective`);
    }
  }

  // ── Buy v2 — true-cost ranking ──
  const desired = cfg.buyDesiredSizeSat;
  const buyEffs = offers.map((o) => effectiveAt(o.feeRatePpm, o.baseFeeSats, desired));
  const minEff = Math.min(...(buyEffs.length ? buyEffs : [0]));
  const maxEff = Math.max(...(buyEffs.length ? buyEffs : [1]));
  const maxScore = Math.max(1, ...offers.map((o) => o.sellerScore));
  const ranked: MagmaBuyRecommendation[] = offers
    .map((o) => {
      const effectiveCostPpm = Math.round(effectiveAt(o.feeRatePpm, o.baseFeeSats, desired));
      const inverseCost = maxEff > minEff ? 1 - (effectiveCostPpm - minEff) / (maxEff - minEff) : 1;
      const reliability = o.sellerScore / maxScore;
      const fits = desired >= o.minSizeSats && desired <= o.maxSizeSats;
      const sizeFit = fits ? 1 : 0.2;
      const valueScore = Math.round((0.55 * inverseCost + 0.3 * reliability + 0.15 * sizeFit) * 100);
      let state: MagmaBuyState;
      if (!fits) state = "size_mismatch";
      else if (inverseCost >= 0.7 && reliability < 0.6) state = "cheap_but_low_score";
      else if (reliability >= 0.8 && inverseCost < 0.4) state = "reliable_but_expensive";
      else state = "good_fit";
      return {
        offerId: o.id,
        sellerPubkey: o.sellerPubkey,
        state,
        valueScore,
        effectiveCostPpm,
        sellerScore: o.sellerScore,
        minSizeSat: o.minSizeSats,
        maxSizeSat: o.maxSizeSats,
        availableSat: o.availableSats,
        reasons: [
          `${effectiveCostPpm} ppm effective at ${(desired / 1e6).toFixed(1)}M`,
          fits ? `fits your ${(desired / 1e6).toFixed(1)}M target` : "size doesn't fit your target",
        ],
      };
    })
    .sort((a, b) => b.valueScore - a.valueScore);
  const fitting = ranked.filter((r) => r.state !== "size_mismatch");
  if (fitting[0]) fitting[0].state = "best_value";

  const buyReasons: string[] = [];
  const buyWarnings: string[] = [];
  let buyState: MagmaV2Report["buy"]["state"];
  if (!fitting.length) {
    buyState = "no_good_offers";
    buyWarnings.push(`no offers fit your ${(desired / 1e6).toFixed(1)}M target right now`);
  } else if (nodeNeed === "need_inbound") {
    buyState = "recommended";
    buyReasons.push("your node needs inbound — buying inbound liquidity would help directly");
  } else {
    buyState = nodeNeed === "need_outbound" ? "not_needed" : "optional";
    buyReasons.push("inbound isn't your bottleneck right now — buy only for a specific route");
  }

  // ── Analytics ──
  const now = Date.now();
  const within30 = (at: string) => now - new Date(at).getTime() <= 30 * 86_400_000;
  const filled = myOrders.filter((o) => o.transactionId);
  const filled30 = filled.filter((o) => within30(o.createdAt));
  const grossEarningsSat = filled.reduce((s, o) => s + o.feeSats, 0);
  const serviceFeesSat = Math.round(grossEarningsSat * cfg.serviceFeeRate);
  const onchainCostsSat = filled.length * (cfg.defaultOpenCostSat + (cfg.includeCloseCost ? cfg.defaultCloseCostSat : 0));
  const leasePpms = filled.filter((o) => o.sizeSats > 0).map((o) => (o.feeSats / o.sizeSats) * 1_000_000);
  const offersActive = myOffers.filter((o) => o.status === "ENABLED" && o.totalSizeSats >= o.maxSizeSats).length;
  const offersExhausted = myOffers.filter((o) => o.status === "ENABLED" && o.totalSizeSats < o.maxSizeSats).length;
  const offersInactive = myOffers.filter((o) => o.status !== "ENABLED").length;
  const analytics: MagmaSellAnalytics = {
    mySellerScore,
    offersActive,
    offersInactive,
    offersExhausted,
    totalListedSat: myOffers.reduce((s, o) => s + o.totalSizeSats, 0),
    availableSat: myOffers.filter((o) => o.status === "ENABLED").reduce((s, o) => s + o.totalSizeSats, 0),
    deployedSat: myOrders.filter((o) => o.channelId && o.blocksUntilClosable > 0).reduce((s, o) => s + o.sizeSats, 0),
    filledOrders30d: filled30.length,
    filledOrdersAllTime: filled.length,
    grossEarningsSat,
    serviceFeesSat,
    onchainCostsSat,
    netProfitSat: grossEarningsSat - serviceFeesSat - onchainCostsSat,
    avgLeaseFeePpm: leasePpms.length ? Math.round(median(leasePpms)) : null,
    fillRate: myOrders.length ? Math.round((filled.length / myOrders.length) * 100) / 100 : null,
    closableSoon: myOrders.filter((o) => o.channelId && o.blocksUntilClosable > 0 && o.blocksUntilClosable <= 288).length,
  };

  // ── On-chain cost surfaced + spike warning (#4) ──
  const onchainOpenCostSat = cfg.defaultOpenCostSat;
  const onchainCloseCostSat = cfg.includeCloseCost ? cfg.defaultCloseCostSat : 0;
  if (onchainFeePerVbyte != null && onchainOpenCostSat + onchainCloseCostSat > 2500)
    sellWarnings.push(
      `on-chain fees are elevated (~${onchainOpenCostSat + onchainCloseCostSat} sat to open+close) — the profit floor is raised so you won't lease at a loss`,
    );

  // ── Seller-score / pending-order risk (#5) ──
  if (myOrdersView.pendingSeller > 0)
    sellWarnings.push(
      `${myOrdersView.pendingSeller} order${myOrdersView.pendingSeller === 1 ? "" : "s"} waiting on you — open the channel${myOrdersView.pendingSeller === 1 ? "" : "s"} in time or your seller score drops`,
    );

  // ── Optimal size from the market (#3) ──
  const marketMins = offers.map((o) => o.minSizeSats).filter((n) => n > 0);
  const optimalSizeSat = marketMins.length
    ? clamp(Math.round(median(marketMins) / 500_000) * 500_000, cfg.minSellSizeSat, cfg.maxSellSizeSat)
    : cfg.minSellSizeSat;
  const optimalLeaseBlocks = myOffers[0]?.minBlockLength ?? cfg.defaultMinBlockLength;

  // ── Projected monthly earnings from your own fill history (#7) ──
  const avgFeePerFill = filled.length ? grossEarningsSat / filled.length : 0;
  const projectedMonthlySat = Math.round(filled30.length * avgFeePerFill);

  return {
    nodeNeed,
    nodeNeedReason,
    hasRoutingData,
    satsPerUsd: market.satsPerUsd,
    sell: {
      state: sellState,
      deployableCapitalSat,
      recommendedSellSizeSat,
      routingOpportunityPpmPerYear,
      adjustedRoutingPpmPerYear: adjustedRouting,
      recommendedMinLeasePpmPerYear,
      pricingMode: cfg.sellPricingMode,
      adaptiveLevel: cfg.adaptiveLevel,
      optimalSizeSat,
      optimalLeaseBlocks,
      projectedMonthlySat,
      onchainOpenCostSat,
      onchainCloseCostSat,
      onchainFeePerVbyte,
      pendingSellerOrders: myOrdersView.pendingSeller,
      reasons: sellReasons,
      warnings: sellWarnings,
      recommendations,
    },
    buy: {
      state: buyState,
      recommendedBuySizeSat: buyState === "recommended" ? desired : null,
      bestOfferId: fitting[0]?.offerId ?? null,
      reasons: buyReasons,
      warnings: buyWarnings,
      ranked: ranked.slice(0, 50),
    },
    analytics,
  };
}
