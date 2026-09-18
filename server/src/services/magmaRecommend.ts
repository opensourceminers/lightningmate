import { getChainBalance, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { nodeCapitalYield, onchainCosts } from "./nodeEconomics.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { computeNodeNeed, type NodeNeed } from "./suggestRecommend.js";
import { saleFeeConfig } from "./serviceFee.js";
import { getMarket, getMyOffers, getMyOrders, type MagmaOffer, type MyOffer, type MyOrder } from "./amboss.js";
import {
  clearingFor,
  demandFit,
  magmaHistoryAgeHours,
  marketActivity,
  popularLeaseBlocks,
  refreshMagmaHistory,
  DEFAULT_LEASE_BLOCKS,
  type ClearingStats,
  type DemandFit,
} from "./magmaHistory.js";

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
 * 100% local + Amboss: my offers/orders, my seller score, my LND balances and
 * forwards, the live order book — and, since the Magma rework, Amboss's real
 * completed-order history (services/magmaHistory.ts). Prices are set against
 * what buyers ACTUALLY PAID, not against what other sellers are asking, because
 * Magma's buy call carries no offer id: Amboss picks the seller, so undercutting
 * the order book wins nothing and only gives away margin. No ML, no execution.
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
  defaultMinBlockLength: DEFAULT_LEASE_BLOCKS,
  sellPricingMode: "balanced",
  adaptiveLevel: 0.5,
  minFeeRatePpm: 1,
  maxFeeRatePpm: 50_000,
  minRepriceDeltaPpm: 25,
  relativeRepriceThreshold: 0.1,
  // The downside is deliberately small. A weak seller score does NOT get fixed by
  // undercutting: Magma's buy call carries no offer id, Amboss matches the seller,
  // so price is not the selection mechanism. Discounting into oblivion was exactly
  // how the live offer ended up at a fifth of the clearing price and still never
  // sold. Score is earned by filling orders, not by being cheap.
  scorePremiumMin: -0.05,
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
    /** Size window we recommend listing, so the offer can actually be matched. */
    recommendedMinSizeSat: number;
    recommendedMaxSizeSat: number;
    /** Smallest channel that still pays for its own open+close at market price. */
    minViableSizeSat: number;
    /** Inputs to that floor, so a caller pricing at a DIFFERENT price (the
     *  operator's own, with auto-pricing off) can recompute it honestly. */
    minNetLeaseProfitSat: number;
    serviceFeeRate: number;
    /** Biggest order the caps + on-chain balance actually allow right now. */
    effectiveMaxOrderSat: number;
    /** What that ceiling reaches, and what raising it would reach. */
    capReach: {
      sharePctNow: number;
      /** Share if the cap were the only limit (capital ignored). */
      sharePctAtCap: number;
      capSat: number;
      capitalLimited: boolean;
    } | null;
    projectedMonthlySat: number;
    onchainOpenCostSat: number;
    onchainCloseCostSat: number;
    onchainFeePerVbyte: number | null;
    pendingSellerOrders: number;
    /** Real completed Magma orders from Amboss, for our own size band. */
    clearing: ClearingStats | null;
    /** How much of the real order flow our size window can serve. */
    demandFit: DemandFit | null;
    /** Market-wide activity, so "nothing sells" can be told from "we don't sell". */
    marketActivity: { orders: number; perDay: number; windowDays: number } | null;
    /** Hours since we last refreshed the Amboss sale history. */
    historyAgeHours: number | null;
    /** Lease length buyers most often ask for. */
    popularLeaseBlocks: number;
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
// One decimal unless the number is genuinely round, so a 1,0M–1,25M window can
// never print as the meaningless "1M–1M".
const sizeLabel = (n: number): string => {
  const m = n / 1e6;
  return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(m < 10 ? 2 : 1).replace(/0+$/, "").replace(/\.$/, "")}M`;
};
const sizeBandLabel = (min: number, max: number) => `${sizeLabel(min)}–${sizeLabel(max)}`;

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

  // Real Magma sale history, cached for hours and refreshed in the same round
  // trip as everything else. It never throws: no history just means we price
  // against listed asks and say so.
  const [market, myOffers, myOrdersView, channels, chain, ownKey, flow, oc] = await Promise.all([
    getMarket(),
    getMyOffers(apiKey).catch(() => [] as MyOffer[]),
    getMyOrders(apiKey).catch(() => ({ orders: [] as MyOrder[], pendingSeller: 0 })),
    getChannelsView(lnd),
    getChainBalance({ lnd }).catch(() => ({ chain_balance: 0 })),
    getOwnPubkey(lnd),
    getFlowSummary(lnd, 30).catch(() => null),
    onchainCosts(lnd, cfg.openTxVbytes, cfg.closeTxVbytes),
    refreshMagmaHistory(),
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

  // ── Size window ───────────────────────────────────────────────────────────
  // Computed up front because the "create a new offer" recommendation needs it:
  // it used to open with a flat 1M floor, which is how a brand-new offer was born
  // into the same too-narrow window that keeps the current one idle.
  const preClearing = clearingFor({
    minSizeSat: 0,
    maxSizeSat: Number.MAX_SAFE_INTEGER,
    blocks: cfg.defaultMinBlockLength,
  });

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

  // Smallest channel whose lease fee, at the price the market actually pays, still
  // covers opening and closing it plus the minimum profit. It moves with the
  // mempool, which is exactly why it cannot be the hardcoded 1M it used to be:
  // at 1 sat/vB that is 200k, at 50 sat/vB it is several million.
  const sellWindow = (() => {
    const clearPpm = preClearing?.medianPpm ?? 0;
    const costToServe =
      cfg.defaultOpenCostSat + (cfg.includeCloseCost ? cfg.defaultCloseCostSat : 0) + cfg.minNetLeaseProfitSat;
    const minViable =
      clearPpm > 0
        ? Math.ceil(costToServe / ((clearPpm / 1_000_000) * (1 - cfg.serviceFeeRate)) / 50_000) * 50_000
        : cfg.minSellSizeSat;
    // The ceiling is whatever capital allows. Every sat of headroom buys reach:
    // the median real order is several times what a 1M–1,25M window can take.
    const ceiling = clamp(deployableCapitalSat, 0, cfg.maxSellSizeSat);
    const max = Math.max(minViable, Math.floor(ceiling / 50_000) * 50_000);
    return { min: Math.min(minViable, max), max, minViable };
  })();

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
  //
  // The base fee has to give way when it does not fit. Amboss charges base +
  // rate, so the base alone already costs (base / size) ppm. If that exceeds the
  // target, subtracting it leaves a negative fee_rate, which used to clamp to
  // minFeeRatePpm — and the REALIZED price then silently became the base fee
  // instead of the target. That is exactly how the live offer ended up pinned at
  // 1 ppm + 852 sat base, roughly a fifth of the clearing price, while the engine
  // believed it had priced to its floor. Shrink the base instead of lying.
  const pricePointFrom = (
    effTarget: number,
    repSize: number,
    preferredBaseSat: number,
    minBlockLength: number,
  ): PricePoint => {
    const basePpm = (b: number) => (repSize > 0 ? (b / repSize) * 1_000_000 : 0);
    let baseFeeSat = Math.max(0, Math.round(preferredBaseSat));
    const headroom = effTarget - cfg.minFeeRatePpm;
    if (basePpm(baseFeeSat) > headroom) {
      baseFeeSat = Math.max(0, Math.floor((headroom * repSize) / 1_000_000));
    }
    const feeRatePpm = clamp(
      Math.round(effTarget - basePpm(baseFeeSat)),
      cfg.minFeeRatePpm,
      cfg.maxFeeRatePpm,
    );
    const effectiveFeePpm = Math.round(effectiveAt(feeRatePpm, baseFeeSat, repSize));
    const econ = economics(repSize, minBlockLength, effectiveFeePpm);
    return { feeRatePpm, baseFeeSat, effectiveFeePpm, leaseApy: econ.leaseApy };
  };

  // ── Build a sell recommendation for an existing offer (or a hypothetical create) ──
  const buildSell = (offer: MyOffer | null): MagmaSellRecommendation => {
    const minSize = offer?.minSizeSats ?? sellWindow.min;
    const maxSize = offer?.maxSizeSats ?? sellWindow.max;
    const minBlock = offer?.minBlockLength || cfg.defaultMinBlockLength;
    const repSize = Math.round(Math.sqrt(Math.max(minSize, 1) * Math.max(maxSize, minSize)));
    const seg = segmentFor(repSize, minSize, maxSize);
    const baseFee = offer?.baseFeeSats ?? seg.baseMed ?? 1000;
    const premium = scorePremium(seg.segmentMedianScore);
    const floorEff = Math.round(profitFloorEffectivePpm(repSize, minBlock));

    // ── Target price ──────────────────────────────────────────────────────────
    // Priced against what the market actually PAYS, not what sellers ask.
    //
    // The old logic read percentiles off the live order book and, in "fast"
    // mode, undercut the cheapest listing by 1 ppm. Two things make that wrong:
    // listings are asks that nobody has to accept, and — decisively — Magma's
    // buy call carries no offer id at all. Amboss matches the seller. Being the
    // cheapest listing wins nothing; it only gives away the margin on the order
    // you do get matched with.
    //
    // So the price ladder now comes from the real fill history when we have it,
    // and the listed percentiles are only a fallback for when Amboss's history
    // endpoint is unreachable.
    const clearing = clearingFor({ minSizeSat: minSize, maxSizeSat: maxSize, blocks: minBlock });
    const fit = demandFit(minSize, maxSize);
    const ladder = clearing
      ? { low: clearing.p25Ppm, mid: clearing.medianPpm, high: clearing.p75Ppm }
      : { low: seg.p25, mid: seg.median, high: seg.p75 };

    // A hard floor at the 25th percentile of REAL fills. Even the most aggressive
    // setting may not price below what a quarter of the market comfortably gets,
    // because cheapness is not what wins the match.
    const clearingFloor = clearing ? clearing.p25Ppm : 0;

    const modeTarget =
      cfg.sellPricingMode === "fast"
        ? ladder.low
        : cfg.sellPricingMode === "premium"
          ? Math.round(ladder.high * (1 + premium))
          : cfg.sellPricingMode === "auto"
            ? Math.round(interp(ladder.low, ladder.high, cfg.adaptiveLevel) * (1 + premium))
            : Math.round(ladder.mid * (1 + premium));

    const targetEff = Math.max(floorEff, clearingFloor, modeTarget);

    const recommended = pricePointFrom(targetEff, repSize, baseFee, minBlock);
    const recEcon = economics(repSize, minBlock, recommended.effectiveFeePpm);
    const beatsRouting = recEcon.leasePpmPerYear >= recommendedMinLeasePpmPerYear;

    const atLeastFloor = (n: number) => Math.max(floorEff, clearingFloor, n);
    const pricing = {
      fast: pricePointFrom(atLeastFloor(ladder.low), repSize, baseFee, minBlock),
      balanced: pricePointFrom(atLeastFloor(Math.round(ladder.mid * (1 + premium))), repSize, baseFee, minBlock),
      premium: pricePointFrom(atLeastFloor(Math.round(ladder.high * (1 + premium))), repSize, baseFee, minBlock),
      profitFloor: pricePointFrom(Math.max(floorEff, clearingFloor), repSize, baseFee, minBlock),
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
    if (clearing) {
      reasons.push(
        `priced to ${clearing.count} real sales in your ${sizeBandLabel(minSize, maxSize)} band over ${clearing.windowDays}d — buyers actually paid ${clearing.p25Ppm}–${clearing.p75Ppm} ppm, median ${clearing.medianPpm}`,
      );
      if (clearing.windowDays > 30)
        warnings.push(
          `few sales in your size band lately — the clearing price comes from a ${clearing.windowDays}-day window`,
        );
    } else {
      reasons.push(`priced against ${seg.count} listed offers in your ${sizeBandLabel(minSize, maxSize)} band`);
      warnings.push(
        "no Amboss sale history available — falling back to LISTED prices, which are asks and tend to sit below what actually clears",
      );
    }
    if (fit) {
      const line = `your ${sizeBandLabel(minSize, maxSize)} window can serve ${fit.sharePct}% of real orders, about ${fit.reachableOrdersPerMonth} a month`;
      if (fit.sharePct < 25) warnings.push(`${line} — size, not price, is what is keeping this offer idle`);
      else reasons.push(line);
      if (fit.maxSizeForHalfMarket)
        reasons.push(
          `raising max size to ${(fit.maxSizeForHalfMarket / 1e6).toFixed(1)}M would put you in front of half the market (median order is ${(fit.medianOrderSat / 1e6).toFixed(1)}M)`,
        );
    }
    if (seg.fallbackLevel === "all_offers" && !clearing)
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
      // Use the SAME number the price card + slider show (the actual per-offer or
      // create recommendation), not a separate refSize-segment median — so the
      // banner never contradicts the card.
      const recEff = recommendations[0]?.recommended.effectiveFeePpm ?? seg.median;
      sellReasons.push(`leasing beats routing here — list around ${recEff} ppm effective`);
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

  // ── Optimal size + lease length, from orders that actually happened ──
  // The old version took the median MIN SIZE of listed offers, which says what
  // sellers are willing to do, not what buyers ask for. Real order sizes are the
  // useful signal: a window that misses the median order cannot fill, whatever
  // it costs.
  // Report and price card must describe the SAME band, or the page contradicts
  // itself: the banner would quote one clearing price and the card another.
  const primary = myOffers[0];
  const bandMin = primary?.minSizeSats ?? sellWindow.min;
  const bandMax = primary?.maxSizeSats ?? sellWindow.max;
  const popularLease = popularLeaseBlocks();
  const reportClearing = clearingFor({
    minSizeSat: bandMin,
    maxSizeSat: bandMax,
    blocks: primary?.minBlockLength || cfg.defaultMinBlockLength,
  });
  const reportFit = demandFit(bandMin, bandMax);
  const marketMins = offers.map((o) => o.minSizeSats).filter((n) => n > 0);
  const optimalSizeSat = reportFit
    ? clamp(Math.round(reportFit.medianOrderSat / 500_000) * 500_000, cfg.minSellSizeSat, cfg.maxSellSizeSat)
    : marketMins.length
      ? clamp(Math.round(median(marketMins) / 500_000) * 500_000, cfg.minSellSizeSat, cfg.maxSellSizeSat)
      : cfg.minSellSizeSat;
  const optimalLeaseBlocks = primary?.minBlockLength || popularLease;

  // ── Size window ───────────────────────────────────────────────────────────
  // The floor is economic, not arbitrary. Below this size the lease fee at the
  // market price no longer covers opening and closing the channel plus the
  // minimum profit, so taking the order would lose money — and it moves with the
  // mempool, which is why it cannot be the hardcoded 1M it used to be.
  // What can actually be served today, and whether the binding limit is the
  // user's cap or simply the coins on chain. Those need different answers: one is
  // a setting, the other is a funding problem, and conflating them is how an
  // offer stays idle while the operator tunes the wrong knob.
  const effectiveMaxOrderSat = Math.min(cfg.maxSellSizeSat, Math.max(0, deployableCapitalSat));
  const fitAtCap = demandFit(sellWindow.min, cfg.maxSellSizeSat);
  const fitNow = demandFit(sellWindow.min, effectiveMaxOrderSat);
  const capReach =
    fitAtCap && fitNow
      ? {
          sharePctNow: fitNow.sharePct,
          sharePctAtCap: fitAtCap.sharePct,
          capSat: cfg.maxSellSizeSat,
          capitalLimited: effectiveMaxOrderSat < cfg.maxSellSizeSat,
        }
      : null;
  if (capReach?.capitalLimited)
    sellWarnings.push(
      `your cap allows ${sizeLabel(cfg.maxSellSizeSat)} orders but only ${sizeLabel(effectiveMaxOrderSat)} is funded on-chain — this is a capital limit, not a settings one`,
    );

  const recommendedMaxSizeSat = sellWindow.max;
  const recommendedMinSizeSat = sellWindow.min;
  const minViableSizeSat = sellWindow.minViable;

  // The lease length we advertise has to be one buyers actually use: 4032 blocks
  // was our old default and appears on exactly one of ~99 live offers, while the
  // market trades 4320 / 8640 / 12960 / 25920.
  if (primary && primary.minBlockLength > popularLease)
    sellWarnings.push(
      `your offer demands at least ${primary.minBlockLength} blocks; most buyers ask for ${popularLease} — lower it or they cannot match you`,
    );

  // A deploy cap below the median order silently rejects most of the market.
  if (reportFit && cfg.maxSellSizeSat < reportFit.medianOrderSat)
    sellWarnings.push(
      `the median real order is ${(reportFit.medianOrderSat / 1e6).toFixed(1)}M sat, above your ${(cfg.maxSellSizeSat / 1e6).toFixed(1)}M channel cap — over half the market cannot be served`,
    );

  if (reportClearing && marketActivity()) {
    const act = marketActivity()!;
    sellReasons.push(
      `the market is trading ${act.perDay} orders a day; leases in your band clear around ${reportClearing.medianPpm} ppm`,
    );
  }

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
      recommendedMinSizeSat,
      recommendedMaxSizeSat,
      minViableSizeSat,
      minNetLeaseProfitSat: cfg.minNetLeaseProfitSat,
      serviceFeeRate: cfg.serviceFeeRate,
      effectiveMaxOrderSat,
      capReach,
      projectedMonthlySat,
      onchainOpenCostSat,
      onchainCloseCostSat,
      onchainFeePerVbyte,
      pendingSellerOrders: myOrdersView.pendingSeller,
      clearing: reportClearing,
      demandFit: reportFit,
      marketActivity: marketActivity(),
      historyAgeHours: magmaHistoryAgeHours(),
      popularLeaseBlocks: popularLease,
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
