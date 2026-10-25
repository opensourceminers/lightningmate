import { getChainBalance, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { CLOSE_TX_VBYTES, OPEN_TX_VBYTES, nodeCapitalYield, onchainCosts } from "./nodeEconomics.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { computeNodeNeed, type NodeNeed } from "./suggestRecommend.js";
import { saleFeeConfig } from "./serviceFee.js";
import { getMarket, type MagmaOffer } from "./amboss.js";
import { getMyOffers, getMyOrders, waitingOnYou, type MyOffer, type MyOrder } from "./magmaApi.js";
import { standardChannelId } from "./leases.js";
import { errorText as errorMessage } from "./errorText.js";
import {
  clearingFor,
  demandFit,
  magmaHistoryAgeHours,
  marketActivity,
  popularLeaseBlocks,
  refreshMagmaHistory,
  standardLeaseBlocks,
  keptLeaseBlocks,
  COMMON_LEASE_BLOCKS,
  DEFAULT_LEASE_BLOCKS,
  type ClearingStats,
} from "./magmaHistory.js";
import type { OfferFeeCaps } from "./leaseCaps.js";

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
  /** For "auto": 0 = the low end of what buyers paid (p25), 0.5 = the
   *  median, 1 = the top (p75) — never below the profit floor. */
  adaptiveLevel: number;
  minFeeRatePpm: number;
  maxFeeRatePpm: number;
  minRepriceDeltaPpm: number;
  relativeRepriceThreshold: number;
  buyDesiredSizeSat: number;
  /** The routing-fee promise this node's offers carry (D7, leaseCaps.ts) —
   *  part of every recommended offer. Null: none (the engine alone). */
  offerFeeCaps: OfferFeeCaps | null;
  /** Who sets each offer's lease next (autopilot.ts): with auto-size on (and
   *  Liquidity provision), the autopilot gives every offer whose terms aren't
   *  the operator's the standard lease in its next write — such an offer is
   *  priced for the standard lease. Every other offer is priced for the lease
   *  it keeps (keptLeaseBlocks). */
  autoSizeLease: boolean;
  /** Offers whose terms the operator took over (OfferControl.manual): the
   *  autopilot leaves their lease alone, whatever auto-size says. */
  operatorOfferIds: string[];
  /** Per offer: since when the market's base fee has stood at its level and
   *  differed from the offer's beyond BASE_FEE_TOLERANCE (the autopilot keeps
   *  the clock, baseFeeDiffers), the offer's base it was started against — a
   *  clock of another base of the offer's (one moved since) doesn't count —
   *  and when the autopilot last moved the offer's base (baseFeeFollow). */
  baseMoves: Record<string, { since?: string; offerBase?: number; movedAt?: string }>;
  /** What the order lane can sell in one channel right now
   *  (Autopilot.sellCapital: the wallet after the reserve and the coins
   *  promised to orders, within what the deploy cap has left). Null: not
   *  known — the wallet after the reserve stands in. */
  sellableNowSat: number | null;
  /** Does the order lane open this paid order's channel itself
   *  (MagmaDesk.opensItself)? Such an order isn't waiting on you. */
  laneOpens: (orderId: string) => boolean;
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
  // (No seller-score premium or discount any more. The score is a result of
  // completed, on-time orders — Amboss computes it, settings can't raise it —
  // and below the score/depth gate price was never the lever: pricing it in
  // only dressed a legacy metric up as a pricing input.)
  buyDesiredSizeSat: 2_000_000,
  offerFeeCaps: null,
  autoSizeLease: false,
  operatorOfferIds: [],
  baseMoves: {},
  sellableNowSat: null,
  laneOpens: () => false,
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
  /** The reprice is for the base fee alone: the offer's price at the
   *  representative size √(min·max) stays (a price the reprice threshold
   *  leaves alone), split anew with the market's base — `recommended` is that
   *  split. */
  baseOnly?: boolean;
  /** The base the comparable offers charge (their median; null: no pool). */
  baseFeeMarketSat?: number | null;
  /** That base differs from the offer's beyond BASE_FEE_TOLERANCE — the
   *  autopilot keeps its clock (MagmaV2Config.baseMoves, baseFeeFollow). */
  baseFeeDiffers?: boolean;
  /** It differs and the offer's base follows at this time (ISO) — not yet:
   *  the market's base is settling, or a base move was made < 6 h ago. */
  baseFeeFollowsAt?: string;
  /** It differs, and the offer keeps its own: with the market's base its
   *  smallest order would pay less than its channel costs today — the base
   *  doesn't follow (Market → Sell says "kept", never "→ X next run"). */
  baseFeeKept?: boolean;
  current: { feeRatePpm: number; baseFeeSat: number; effectiveFeePpm: number } | null;
  /** The terms the offer should carry: the price, the lease that price is for
   *  (the one the offer carries after the next write: the standard 4320 —
   *  a minimum, so it serves longer leases too — or a longer one buyers use,
   *  kept on purpose), and the routing-fee promise (D7). Every price here
   *  (`pricing` too) is for `minBlockLength`. */
  recommended: PricePoint & {
    minBlockLength: number;
    sizeSat: number;
    feeRateCapPpm: number | null;
    baseFeeCapSats: number | null;
  };
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
  /** Concrete price points for the UI buttons — for `recommended.minBlockLength`. */
  pricing: { fast: PricePoint; balanced: PricePoint; premium: PricePoint; profitFloor: PricePoint };
  /** What buyers paid for comparable leases, expressed for this offer's
   *  lease (null: no sale history). */
  clearing: ClearingStats | null;
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
  /** When the reads behind it came in (ISO). Pages share one read — the
   *  server keeps it a minute (magmaReportShared), each view a minute more —
   *  so "as of" is this, never when a view got its copy (review of P7: up
   *  to ~2 min off). */
  generatedAt: string;
  nodeNeed: NodeNeed;
  nodeNeedReason: string;
  hasRoutingData: boolean;
  satsPerUsd: number | null;
  /** Reads that failed (Amboss: your offers or orders; LND: forwards) — said
   *  first among sell.warnings too. The figures they feed are partial. */
  readProblems: string[];
  sell: {
    state:
      | "good_to_sell"
      | "sell_only_above_profit_floor"
      | "market_too_cheap"
      | "insufficient_capital";
    deployableCapitalSat: number;
    recommendedSellSizeSat: number | null;
    routingOpportunityPpmPerYear: number | null;
    adjustedRoutingPpmPerYear: number;
    recommendedMinLeasePpmPerYear: number;
    pricingMode: "fast" | "balanced" | "premium" | "auto";
    adaptiveLevel: number;
    /** The lease an offer should promise: the standard one buyers ask for
     *  most (min_block_length is a minimum, so it serves longer ones too). */
    standardLeaseBlocks: number;
    /** The median size of real orders (90 days) — a fact, not a target. */
    medianOrderSat: number | null;
    /** A sane size window for an offer: from the smallest channel that pays
     *  for itself at the market price, up to what can be funded. (Window
     *  hygiene only: size is not what gets a small seller matched.) */
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
    /** That ceiling is set by the coins on chain, not by the caps. */
    capitalLimited: boolean;
    /** Earnings per month from this node's OWN fills of the last 30 days. */
    projectedMonthlySat: number;
    onchainOpenCostSat: number;
    onchainCloseCostSat: number;
    onchainFeePerVbyte: number | null;
    /** The order lane's accept floor at that rate (saleAcceptFloorSats): an
     *  order paying less is turned down as below cost. */
    acceptFloorSat: number;
    pendingSellerOrders: number;
    /** Of those, the paid ones waiting for the operator to open their
     *  channel (the lane doesn't open them): their Open click, not a decision. */
    pendingSellerOpens: number;
    /** Real completed Magma orders from Amboss, for our own size band. */
    clearing: ClearingStats | null;
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

/** How far an offer's own base fee may sit from the market's before the
 *  engine prices it with the market's: more than 50 sat AND more than 20 % of
 *  the market's base. Inside that band the offer keeps its base, so a median
 *  that moves a little (one offer listed or gone) never rewrites it. */
export const BASE_FEE_TOLERANCE = { minSats: 50, share: 0.2 } as const;

/** How the offer's base follows the market's (2026-10-25: a day's hold kept
 *  the 0 that 0.8.0 left on the live offer for 24 h, and every ordinary move
 *  waited as long):
 *  - far off — the offer's base under half the market's, or over twice it
 *    (0 among them) — it follows at once;
 *  - else once the market's base has stayed where it is (within
 *    BASE_FEE_TOLERANCE of the level it moved to) for BASE_FEE_STABLE_MS:
 *    a small segment's median, flipped back and forth by one listing, is
 *    never followed;
 *  - either way at most one base move per BASE_FEE_MOVE_GAP_MS. */
export const BASE_FEE_STABLE_MS = 90 * 60_000;
export const BASE_FEE_MOVE_GAP_MS = 6 * 3_600_000;
export const BASE_FEE_FAR_FACTOR = 2;

/** When an offer's base follows the market's (null: now), or why not yet. */
export function baseFeeFollow(
  own: number,
  market: number,
  clock: { since?: string; movedAt?: string } | undefined,
  nowMs: number,
): { at: number | null; why: "far" | "stable" | "gap" | "settling" } {
  const far = own * BASE_FEE_FAR_FACTOR < market || own > market * BASE_FEE_FAR_FACTOR;
  const movedMs = clock?.movedAt ? Date.parse(clock.movedAt) : NaN;
  const gapEnd = Number.isFinite(movedMs) ? movedMs + BASE_FEE_MOVE_GAP_MS : -Infinity;
  const sinceMs = clock?.since ? Date.parse(clock.since) : NaN;
  // Without a clock the market's base is seen for the first time now.
  const stableEnd = (Number.isFinite(sinceMs) ? sinceMs : nowMs) + BASE_FEE_STABLE_MS;
  const due = far ? gapEnd : Math.max(gapEnd, stableEnd);
  if (due <= nowMs) return { at: null, why: far ? "far" : "stable" };
  // Held by the gap after its last base move, or while the market's settles.
  return { at: due, why: far || gapEnd >= stableEnd ? "gap" : "settling" };
}

/**
 * The base fee an offer is priced with: the market's — the median base of the
 * comparable offers (the segment) — not whatever the offer happens to hold.
 * 0.8.0's size-only writes reset offers' bases to 0 (Amboss resets what an
 * update leaves out), and the engine kept the base an offer had: the live
 * offer stayed at 4,445 ppm + 0 sat while 95 of 97 listed offers charged a
 * base (median 568 sat). An offer's own base stands while it is within
 * BASE_FEE_TOLERANCE of the market's. With no comparable offer: the offer's
 * own base, or 1,000 sat for a new one.
 */
export function preferredBaseFeeSats(current: number | null, market: number | null): number {
  if (market === null) return current ?? 1000;
  if (current === null) return market;
  const tolerance = Math.max(BASE_FEE_TOLERANCE.minSats, market * BASE_FEE_TOLERANCE.share);
  return Math.abs(current - market) <= tolerance ? current : market;
}
// One decimal unless the number is genuinely round, so a 1,0M–1,25M window can
// never print as the meaningless "1M–1M".
const sizeLabel = (n: number): string => {
  const m = n / 1e6;
  return `${Number.isInteger(m) ? m.toFixed(0) : m.toFixed(m < 10 ? 2 : 1).replace(/0+$/, "").replace(/\.$/, "")}M`;
};
const sizeBandLabel = (min: number, max: number) => `${sizeLabel(min)}–${sizeLabel(max)}`;

const COMMON_LEASES = new Set(COMMON_LEASE_BLOCKS);

/**
 * How much a routing channel is worth here, relative to the node's measured
 * yield — the bar a lease must clear. A node short of OUTBOUND (≤ 30 % local)
 * gains exactly what a routing open adds: routing is worth more, and the
 * same coins tied up in a buyer's channel must earn more to beat it. A node
 * short of INBOUND (≥ 70 % local) gains little from more outbound: routing is
 * worth less. Leasing itself is never blocked by the node's balance — it
 * spends on-chain coins and changes neither side of the node's own channels
 * (computeNodeNeed; before, the need was inverted and blocked selling).
 */
const NEED_MULTIPLIER: Record<NodeNeed, number> = {
  need_revenue: 1.25,
  need_routing_diversity: 1.1,
  need_inbound: 0.8,
  need_outbound: 1.2,
  balanced: 1,
};

/** The smallest lease fee a sale pays for itself with: opening and closing the
 *  channel plus the minimum profit, after the service fee. The size floor at a
 *  given price and the order lane's accept floor both come from it. */
export function saleCostFloorSats(c: {
  onchainOpenCostSat: number;
  onchainCloseCostSat: number;
  minNetLeaseProfitSat: number;
  serviceFeeRate: number;
}): number {
  return Math.ceil((c.onchainOpenCostSat + c.onchainCloseCostSat + c.minNetLeaseProfitSat) / Math.max(0.01, 1 - c.serviceFeeRate));
}

/** The order lane's accept floor at an on-chain fee rate: opening and closing
 *  the channel (OPEN_TX_VBYTES + CLOSE_TX_VBYTES) after the service fee, no
 *  profit minimum. A rate that isn't known counts as 1 sat/vB. The lane
 *  (autopilot.ts saleFeeFloorSats) and the base-fee check below use this one. */
export function saleAcceptFloorSats(feePerVbyte: number | null, serviceFeeRate: number): number {
  const perVbyte = feePerVbyte !== null && Number.isFinite(feePerVbyte) && feePerVbyte > 0 ? feePerVbyte : 1;
  return saleCostFloorSats({
    onchainOpenCostSat: Math.ceil(perVbyte * OPEN_TX_VBYTES),
    onchainCloseCostSat: Math.ceil(perVbyte * CLOSE_TX_VBYTES),
    minNetLeaseProfitSat: 0,
    serviceFeeRate,
  });
}

/** What an order of `sizeSat` pays at a price: rate × size + base (sat). The
 *  order lane compares this with its accept floor; the upkeep and the base
 *  fee's check below use the same sum. */
export function orderFeeSat(feeRatePpm: number, baseFeeSats: number, sizeSat: number): number {
  return (feeRatePpm * sizeSat) / 1_000_000 + baseFeeSats;
}

/** The smallest order (rounded up to 10k sat) whose fee at a price covers
 *  `floorSat` — the order lane's accept floor (saleAcceptFloorSats): every
 *  smaller one it turns down as below cost. 0 when the base alone covers it;
 *  Infinity when nothing does (no rate, a base under the floor). */
export function minSizeCoveringSat(feeRatePpm: number, baseFeeSats: number, floorSat: number): number {
  if (!(floorSat > 0) || baseFeeSats >= floorSat) return 0;
  if (!(feeRatePpm > 0)) return Number.POSITIVE_INFINITY;
  return Math.ceil(((floorSat - baseFeeSats) * 1_000_000) / feeRatePpm / 10_000) * 10_000;
}

/**
 * The window auto-size gives an offer (the autopilot's reshape): its floor
 * moves to the smallest channel that pays for itself (`wantMin`) when that
 * is well above or below the offer's (±20 %), its max widens to what can be
 * funded (`wantMax`) when that is well above it (20 %). Null: the offer's
 * own window stands. The engine prices an auto-sized offer for this window
 * — the one it is written with — and the upkeep writes it (final review
 * 2026-10-25: priced for the old 250k–2M while the min went to 1.6M, the
 * offer went out at ~2.2× the market and came back down a run later).
 */
export function autoSizedWindow(
  off: { minSizeSats: number; maxSizeSats: number },
  wantMin: number,
  wantMax: number,
): { minSizeSats: number; maxSizeSats: number } | null {
  if (!(wantMin > 0) || wantMax < wantMin) return null;
  const widens = wantMax > off.maxSizeSats * 1.2;
  const lowersFloor = wantMin < off.minSizeSats * 0.8;
  const raisesFloor = wantMin > off.minSizeSats * 1.2;
  if (!widens && !lowersFloor && !raisesFloor) return null;
  return {
    minSizeSats: raisesFloor ? wantMin : Math.min(wantMin, off.minSizeSats),
    maxSizeSats: Math.max(wantMax, off.maxSizeSats),
  };
}

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
  // Only this node's offers and sales (one Amboss account can sell for several nodes).
  const ownKey = await getOwnPubkey(lnd);
  // A read that fails is said (readProblems, first among the warnings), never
  // turned into plausible data (review a8: an Amboss error read as "no offers,
  // no orders" — the page then recommended creating a second offer — and an
  // LND error as 0 sat on chain: "not enough idle capital"). Without a key
  // there is nothing of yours to read: no problem. LND's on-chain balance is
  // what every capital figure stands on: without it there is no report.
  const readProblems: string[] = [];
  const failedRead = <T>(what: string, fallback: T) => (err: unknown): T => {
    readProblems.push(`${what} (${errorMessage(err)})`);
    return fallback;
  };
  const [market, myOffers, myOrdersView, channels, chain, flow, oc] = await Promise.all([
    getMarket(),
    getMyOffers(apiKey, ownKey).catch(
      apiKey ? failedRead("your offers couldn't be read from Amboss — the page can't tell whether you have one", [] as MyOffer[]) : () => [] as MyOffer[],
    ),
    getMyOrders(apiKey, ownKey).catch(
      apiKey
        ? failedRead("your orders couldn't be read from Amboss — pending orders and your sales aren't counted", { orders: [] as MyOrder[], pendingSeller: 0 })
        : () => ({ orders: [] as MyOrder[], pendingSeller: 0 }),
    ),
    getChannelsView(lnd),
    getChainBalance({ lnd }).catch((err: unknown) => {
      throw new Error(`LND's on-chain balance couldn't be read (${errorMessage(err)}) — the capital this node could sell is unknown`);
    }),
    getFlowSummary(lnd, 30).catch(failedRead("LND's forwards couldn't be read — the routing benchmark is the default one", null)),
    onchainCosts(lnd, cfg.openTxVbytes, cfg.closeTxVbytes),
    refreshMagmaHistory(),
  ]);
  // When the reads came in: what a view's "as of" means (generatedAt).
  const readAt = new Date().toISOString();

  const offers = market.offers;
  const myOrders = myOrdersView.orders.filter((o) => o.side === "SELL");

  // Live on-chain cost: a fee spike can make opening a channel cost more than the
  // lease earns, so the profit floor must react to it (shared node-economics model).
  const onchainFeePerVbyte = oc.feePerVbyte;
  cfg.defaultOpenCostSat = oc.openCostSat;
  cfg.defaultCloseCostSat = oc.closeCostSat;
  // The order lane's accept floor at today's fee rate: a base change never lets
  // an offer's smallest order pay less than that (buildSell).
  const acceptFloorSat = saleAcceptFloorSats(onchainFeePerVbyte, cfg.serviceFeeRate);
  const nowMs = Date.now();

  // ── Routing opportunity cost — yield ON CAPITAL (shared node-economics model).
  const fees30 = flow?.totalFeesEarnedSats ?? 0;
  const cy = nodeCapitalYield(channels, fees30, 30);
  const routingOpportunityPpmPerYear = cy.routingYieldPpmPerYear;
  const hasRoutingData = routingOpportunityPpmPerYear != null;
  const baseRouting = routingOpportunityPpmPerYear ?? cfg.defaultRoutingOpportunityPpmPerYear;

  const { nodeNeed, reason: nodeNeedReason, localPct } = computeNodeNeed(channels, fees30, 30);
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

  // Comparable-offer segment + percentiles (effective ppm at our representative
  // size), each ask expressed for `leaseBlocks` — the lease the offer being
  // priced carries — as the clearing history is: an ask is the price of its
  // own minimum lease, so a 30-day ask of 3,000 ppm is the rate of a 9,000 ppm
  // 90-day one. (Unscaled, a 90-day offer's floor was held against 30-day
  // asks: "above the market" — "may not fill" — at a third of its market.)
  const segmentFor = (repSize: number, myMin: number, myMax: number, leaseBlocks: number) => {
    const overlaps = (o: MagmaOffer) => o.maxSizeSats >= myMin && o.minSizeSats <= myMax;
    let pool = offers.filter((o) => o.feeRatePpm > 0 || o.baseFeeSats > 0).filter(overlaps);
    let fallbackLevel: "size_band" | "all_offers" = "size_band";
    if (pool.length < 5) {
      pool = offers.filter((o) => o.feeRatePpm > 0 || o.baseFeeSats > 0);
      fallbackLevel = "all_offers";
    }
    const askAt = (o: MagmaOffer) =>
      effectiveAt(o.feeRatePpm, o.baseFeeSats, repSize) * (o.minBlockLength > 0 ? leaseBlocks / o.minBlockLength : 1);
    const effs = pool.map(askAt).sort((a, b) => a - b);
    const scores = pool.map((o) => o.sellerScore);
    const competitorEffs = pool
      .filter((o) => o.sellerPubkey !== ownKey)
      .map(askAt)
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
  // The lease every offer should promise (D7), and the routing-fee promise.
  const standardLease = standardLeaseBlocks();
  const caps = cfg.offerFeeCaps;
  /** The lease an offer is priced for: the one it carries after the next
   *  write. A new offer gets the standard; with auto-size the autopilot gives
   *  every offer it manages the standard; any other offer keeps a lease
   *  buyers use (keptLeaseBlocks — the Sell tab's price buttons keep the
   *  same one). */
  const autoLease = (offer: MyOffer): boolean => cfg.autoSizeLease && !cfg.operatorOfferIds.includes(offer.id);
  const pricingLease = (offer: MyOffer | null): number => {
    if (!offer || autoLease(offer)) return standardLease;
    return keptLeaseBlocks(offer.minBlockLength, standardLease);
  };
  const leaseDays = (blocks: number) => Math.round(blocks / 144);

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
    // An offer auto-size manages is priced for the window it is about to get
    // (autoSizedWindow — the upkeep's reshape writes the same), not for the
    // one it has: the representative size, and with it the profit floor,
    // moves with it.
    const sized = offer && autoLease(offer) ? autoSizedWindow(offer, sellWindow.min, sellWindow.max) : null;
    const minSize = sized?.minSizeSats ?? offer?.minSizeSats ?? sellWindow.min;
    const maxSize = sized?.maxSizeSats ?? offer?.maxSizeSats ?? sellWindow.max;
    // Priced for the lease the offer carries after the next write: a 90-day
    // lease ties the capital up three times as long as a 30-day one, so its
    // profit floor and the clearing price at the same rate a year are about
    // three times as high. (For a while every offer was priced for the
    // standard 30 days: a 90-day offer kept on purpose was auto-priced — and
    // its price buttons filled — at the 30-day price, below the profit floor
    // of the lease it actually promises.)
    const minBlock = pricingLease(offer);
    const repSize = Math.round(Math.sqrt(Math.max(minSize, 1) * Math.max(maxSize, minSize)));
    const seg = segmentFor(repSize, minSize, maxSize, minBlock);
    // Rounded up: a price exactly at the floor is at it, never "below" or
    // "doesn't beat routing" by a rounding (review 2026-10-25).
    const floorEff = Math.ceil(profitFloorEffectivePpm(repSize, minBlock));

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
          ? ladder.high
          : cfg.sellPricingMode === "auto"
            ? Math.round(interp(ladder.low, ladder.high, cfg.adaptiveLevel))
            : ladder.mid;

    const targetEff = Math.max(floorEff, clearingFloor, modeTarget);

    const current = offer
      ? {
          feeRatePpm: offer.feeRatePpm,
          baseFeeSat: offer.baseFeeSats,
          effectiveFeePpm: Math.round(effectiveAt(offer.feeRatePpm, offer.baseFeeSats, repSize)),
        }
      : null;

    // ── Base fee ──────────────────────────────────────────────────────────────
    // The market's: the median base of the comparable offers (none without
    // any). An offer keeps its own while that is within BASE_FEE_TOLERANCE of
    // it — and until baseFeeFollow says it follows: at once when far off,
    // else once the market's base has held for BASE_FEE_STABLE_MS (a median
    // one listing moves back and forth is never followed), at most one move
    // per BASE_FEE_MOVE_GAP_MS. Nor where
    // the market's base would let the offer's smallest order pay less than
    // opening and closing its channel costs at today's fee rate (the order
    // lane's accept floor, which would turn such orders down) while its own
    // base doesn't: the base is spread over the whole size range — the price
    // stays put only at the representative size √(min·max), and a lower base
    // charges small orders less.
    const marketBase = seg.count > 0 ? seg.baseMed : null;
    const baseDiffers = !!offer && marketBase !== null && preferredBaseFeeSats(offer.baseFeeSats, marketBase) !== offer.baseFeeSats;
    // The clock of this difference only: one started against another base of
    // the offer's — before a base move, or an edit — is not.
    const clock = offer ? cfg.baseMoves[offer.id] : undefined;
    const baseSince = clock && clock.offerBase === offer?.baseFeeSats ? clock.since : undefined;
    const follow =
      baseDiffers && offer && marketBase !== null
        ? baseFeeFollow(offer.baseFeeSats, marketBase, { since: baseSince, movedAt: clock?.movedAt }, nowMs)
        : null;
    const baseHeld = baseDiffers && follow !== null && follow.at !== null;
    let baseFee = !offer ? preferredBaseFeeSats(null, marketBase) : baseDiffers && !baseHeld && marketBase !== null ? marketBase : offer.baseFeeSats;
    const feeAtMinSat = (p: PricePoint) => orderFeeSat(p.feeRatePpm, p.baseFeeSat, minSize);
    let baseRefusedSat: number | null = null;
    if (offer && baseFee !== offer.baseFeeSats) {
      for (const eff of current ? [targetEff, current.effectiveFeePpm] : [targetEff]) {
        const moved = feeAtMinSat(pricePointFrom(eff, repSize, baseFee, minBlock));
        const kept = feeAtMinSat(pricePointFrom(eff, repSize, offer.baseFeeSats, minBlock));
        if (moved < acceptFloorSat && moved < kept) baseRefusedSat = Math.floor(moved);
      }
      if (baseRefusedSat !== null) baseFee = offer.baseFeeSats;
    }

    let recommended = pricePointFrom(targetEff, repSize, baseFee, minBlock);
    let recEcon = economics(repSize, minBlock, recommended.effectiveFeePpm);
    let beatsRouting = recEcon.leasePpmPerYear >= recommendedMinLeasePpmPerYear;

    const atLeastFloor = (n: number) => Math.max(floorEff, clearingFloor, n);
    const pricing = {
      fast: pricePointFrom(atLeastFloor(ladder.low), repSize, baseFee, minBlock),
      balanced: pricePointFrom(atLeastFloor(ladder.mid), repSize, baseFee, minBlock),
      premium: pricePointFrom(atLeastFloor(ladder.high), repSize, baseFee, minBlock),
      profitFloor: pricePointFrom(Math.max(floorEff, clearingFloor), repSize, baseFee, minBlock),
    };

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
    // (No "size, not price, is what keeps this offer idle" any more: measured
    // on the live book, offers of small, low-score sellers did not sell
    // whatever their window or price — see the eligibility check. Size and
    // price are offer hygiene; Amboss picks sellers by track record.)
    if (offer && minBlock !== offer.minBlockLength) {
      reasons.push(
        `priced for a ${minBlock}-block (${leaseDays(minBlock)}-day) lease — the one ${
          autoLease(offer) ? "auto-size gives this offer with its next write" : "a price button or 'Apply recommended' gives it"
        } (it promises ${offer.minBlockLength} blocks now)`,
      );
    }
    if (offer && offer.minBlockLength !== standardLease) {
      warnings.push(
        offer.minBlockLength < standardLease || !COMMON_LEASES.has(offer.minBlockLength)
          ? `your offer promises a ${offer.minBlockLength}-block lease — a length almost no order uses; the standard is ${standardLease} blocks (min_block_length is a minimum, so ${standardLease} serves longer leases too)`
          : `your offer demands at least ${offer.minBlockLength} blocks; most buyers ask for ${standardLease}`,
      );
    }
    if (offer && caps && (offer.feeRateCapPpm === null || offer.feeRateCapPpm <= 0)) {
      warnings.push(
        `your offer promises buyers no routing-fee cap — nearly every offer that sells does; the standard promise is ${caps.feeRateCapPpm} ppm + ${caps.baseFeeCapSats} sat base, kept by the fee autopilot for the lease`,
      );
    }
    if (seg.fallbackLevel === "all_offers" && !clearing)
      warnings.push("few offers in your exact size band — compared against the whole market");
    if (mySellerScore == null) warnings.push("your seller score isn't visible yet (it appears once this node lists an offer)");
    // Per sale: what one lease at this price nets a year on its capital
    // (after on-chain costs and the service fee) — whether a sale comes at
    // all is the eligibility check's question, not this one's. Written below,
    // once the price is final (a base-only split is a price of its own).
    const perSaleAt = reasons.push("") - 1;
    if (offer && baseDiffers && baseHeld && marketBase !== null && follow?.at != null) {
      const at = new Date(follow.at).toISOString().slice(11, 16);
      reasons.push(
        follow.why === "gap"
          ? `comparable offers charge ${marketBase} sat base (it has ${offer.baseFeeSats}) — its base follows at ${at} UTC, 6 h after its last base change`
          : `comparable offers charge ${marketBase} sat base (it has ${offer.baseFeeSats}) — its base follows at ${at} UTC, once that has held for 1.5 h`,
      );
    }
    if (offer && baseRefusedSat !== null && marketBase !== null) {
      reasons.push(
        `keeps its base of ${offer.baseFeeSats} sat: with the market's ${marketBase} sat its smallest order (${minSize} sat) would pay ${baseRefusedSat} sat — less than opening and closing its channel costs today (${acceptFloorSat} sat)`,
      );
    }
    if (!hasRoutingData && flow !== null) warnings.push("no routing history yet — using a default routing benchmark; treat the %/yr comparison loosely");
    warnings.push("on-chain open/close cost is estimated; high mempool fees can erase lease profit");

    // State machine.
    let state: MagmaSellOfferState;
    let mode: "create" | "update" | "hold" = offer ? "update" : "create";
    let shouldReprice = false;
    let repriceDirection: "up" | "down" | "none" = "none";

    if (offer && offer.status !== "ENABLED") {
      state = "inactive";
      mode = "hold";
    } else if (current && current.effectiveFeePpm < floorEff) {
      // A listed offer under its profit floor is raised first — whatever the
      // market or the routing comparison says (review 2026-10-25: checked
      // after "uncompetitive" and "unprofitable", neither of which reprices,
      // an offer at 4,445 ppm against a 10,277 ppm floor stayed there).
      state = "below_profit_floor";
      shouldReprice = true;
      repriceDirection = "up";
      reasons.push(`current price is below your profit floor (${floorEff} ppm effective) — raise it`);
    } else if (floorEff > seg.p75) {
      // The price that pays for the lease is above what comparable offers ask.
      // (Not "won't fill": Amboss picks sellers by score and depth, not price.)
      state = "do_not_list_uncompetitive";
      reasons.push(`the price that pays for this lease (${floorEff} ppm effective) is above what comparable offers ask — not listed automatically`);
    } else if (!beatsRouting && cfg.sellPricingMode !== "premium") {
      state = "do_not_list_unprofitable";
      reasons.push("even the recommended price barely beats routing — better to keep this capital routing");
    } else if (offer && offer.availableSats < offer.maxSizeSats) {
      state = "exhausted";
      reasons.push("offer is depleted — relist at today's recommended price, not the old one");
      shouldReprice = current ? recommended.effectiveFeePpm > current.effectiveFeePpm : false;
      repriceDirection = "up";
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
        // Above what buyers paid for leases like this — repriced toward it
        // with auto-pricing on. Not "lower to fill faster": below Amboss's
        // score/depth gate a lower price doesn't bring orders (D19).
        reasons.push(
          `priced above what buyers paid for comparable leases (${current.effectiveFeePpm} ppm effective vs a recommended ${recommended.effectiveFeePpm})`,
        );
      } else {
        state = "well_priced";
        mode = "hold";
      }
    } else {
      state = "well_priced";
    }

    // A base that goes to the market's is a reprice of its own. At a price the
    // threshold above leaves alone (well priced, or a depleted offer not to be
    // raised), the base used to stay whatever it was — the 0 that 0.8.0's
    // writes left. Now that price is kept and split anew: the market's base,
    // the rate making up the rest — the price doesn't move (never cheapened,
    // never raised under a base change). An unlistable offer isn't repriced.
    let baseOnly = false;
    if (!shouldReprice && offer?.status === "ENABLED" && current && (state === "well_priced" || state === "exhausted")) {
      const resplit = pricePointFrom(current.effectiveFeePpm, repSize, baseFee, minBlock);
      // A move within the tolerance isn't one: a market base too big for the
      // price is cut to fit (pricePointFrom), and the next run's cut differs
      // from this one's by a rounding remainder — never rewritten for that.
      if (preferredBaseFeeSats(current.baseFeeSat, resplit.baseFeeSat) !== current.baseFeeSat) {
        recommended = resplit;
        recEcon = economics(repSize, minBlock, recommended.effectiveFeePpm);
        beatsRouting = recEcon.leasePpmPerYear >= recommendedMinLeasePpmPerYear;
        shouldReprice = true;
        baseOnly = true;
        mode = "update";
        reasons.push(
          `base fee to ${recommended.baseFeeSat} sat (it has ${current.baseFeeSat}) — what comparable offers charge, as far as it fits the price; the rate makes up the rest, so the price at the representative size (${repSize} sat, √(min·max)) stays`,
        );
      }
    }
    reasons[perSaleAt] = beatsRouting
      ? `per sale, a lease at this price nets ~${recommended.leaseApy}%/yr (after on-chain costs and the service fee) — above your routing benchmark of ${(adjustedRouting / 10000).toFixed(2)}%/yr`
      : `per sale, a lease at this price nets ~${recommended.leaseApy}%/yr (after on-chain costs and the service fee) — below your routing benchmark: routing this capital may earn more`;

    return {
      offerId: offer?.id ?? null,
      mode,
      state,
      shouldReprice,
      repriceDirection,
      ...(baseOnly ? { baseOnly } : {}),
      ...(offer ? { baseFeeMarketSat: marketBase, baseFeeDiffers: baseDiffers } : {}),
      ...(offer && baseHeld && follow?.at != null ? { baseFeeFollowsAt: new Date(follow.at).toISOString() } : {}),
      ...(offer && baseRefusedSat !== null ? { baseFeeKept: true } : {}),
      current,
      recommended: {
        ...recommended,
        minBlockLength: minBlock,
        sizeSat: repSize,
        feeRateCapPpm: caps?.feeRateCapPpm ?? null,
        baseFeeCapSats: caps?.baseFeeCapSats ?? null,
      },
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
      clearing,
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
  if (deployableCapitalSat < cfg.minSellSizeSat) {
    sellState = "insufficient_capital";
    sellReasons.push(`only ${Math.round(deployableCapitalSat / 1000)}k deployable on-chain after reserve — below the ${cfg.minSellSizeSat / 1e6}M minimum`);
  } else {
    const refSize = recommendedSellSizeSat ?? cfg.minSellSizeSat;
    const floorEff = profitFloorEffectivePpm(refSize, cfg.defaultMinBlockLength);
    const seg = segmentFor(refSize, refSize, refSize, cfg.defaultMinBlockLength);
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
      const recLease = recommendations[0]?.recommended.minBlockLength ?? standardLease;
      // Per sale only: one lease at this price beats routing the capital.
      // Whether orders come is the eligibility check's answer (shown above it
      // on Market → Sell) — this line never says "list" by itself. The lease
      // is named: a 90-day one costs about three times a 30-day one.
      sellReasons.push(`per sale, a ${leaseDays(recLease)}-day lease at around ${recEff} ppm effective beats routing this capital`);
    }
  }

  // Short of outbound: a routing channel adds what the node lacks, so the
  // lease must beat routing valued higher (NEED_MULTIPLIER) — said, not
  // hidden. (Leasing is never blocked by the node's balance: it spends
  // on-chain coins, not the node's own inbound or outbound.)
  if (nodeNeed === "need_outbound") {
    sellReasons.push(
      `your node is short of outbound (only ${localPct}% of its liquidity is local) — a routing channel adds exactly that, so a lease must beat routing valued ${NEED_MULTIPLIER.need_outbound}×`,
    );
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
    // Outbound-heavy: inbound is what it lacks, and a purchase adds exactly that.
    buyState = "recommended";
    buyReasons.push(`your node is short of inbound (${localPct}% of its liquidity is local) — buying inbound adds exactly that`);
  } else if (nodeNeed === "need_outbound") {
    // Inbound-rich: more inbound won't help — before, this node was told to buy it.
    buyState = "not_needed";
    buyReasons.push(
      `your node already has plenty of inbound (only ${localPct}% of its liquidity is local) — buying more won't help; it lacks outbound, which opening channels adds`,
    );
  } else {
    buyState = "optional";
    buyReasons.push("inbound isn't your bottleneck right now — buy only for a specific route");
  }

  // ── Analytics ──
  const now = Date.now();
  const within30 = (at: string) => now - new Date(at).getTime() <= 30 * 86_400_000;
  // Sold = the channel was funded and Amboss has it (the Magma API carries no
  // funding txid in its order list; the status says it).
  const filled = myOrders.filter((o) => o.sold);
  const filled30 = filled.filter((o) => within30(o.createdAt));
  const grossEarningsSat = filled.reduce((s, o) => s + o.feeSats, 0);
  const serviceFeesSat = Math.round(grossEarningsSat * cfg.serviceFeeRate);
  const onchainCostsSat = filled.length * (cfg.defaultOpenCostSat + (cfg.includeCloseCost ? cfg.defaultCloseCostSat : 0));
  const leasePpms = filled.filter((o) => o.sizeSats > 0).map((o) => (o.feeSats / o.sizeSats) * 1_000_000);
  // Listed liquidity a new buyer can still order is total − locked (Amboss).
  const offersActive = myOffers.filter((o) => o.status === "ENABLED" && o.availableSats >= o.maxSizeSats).length;
  const offersExhausted = myOffers.filter((o) => o.status === "ENABLED" && o.availableSats < o.maxSizeSats).length;
  const offersInactive = myOffers.filter((o) => o.status !== "ENABLED").length;
  const analytics: MagmaSellAnalytics = {
    mySellerScore,
    offersActive,
    offersInactive,
    offersExhausted,
    totalListedSat: myOffers.reduce((s, o) => s + o.totalSizeSats, 0),
    availableSat: myOffers.filter((o) => o.status === "ENABLED").reduce((s, o) => s + o.availableSats, 0),
    deployedSat: myOrders.filter((o) => o.leaseActive).reduce((s, o) => s + o.sizeSats, 0),
    filledOrders30d: filled30.length,
    filledOrdersAllTime: filled.length,
    grossEarningsSat,
    serviceFeesSat,
    onchainCostsSat,
    netProfitSat: grossEarningsSat - serviceFeesSat - onchainCostsSat,
    avgLeaseFeePpm: leasePpms.length ? Math.round(median(leasePpms)) : null,
    fillRate: myOrders.length ? Math.round((filled.length / myOrders.length) * 100) / 100 : null,
    // The Magma API's list says only when a lease is over (0 blocks left).
    // Leases ending within two days whose channel is still open (review
    // 2026-10-25: every lease that ever ended counted, its channel closed
    // long ago or not).
    closableSoon: myOrders.filter((o) => {
      if (o.blocksUntilClosable === null || o.blocksUntilClosable > 288) return false;
      const id = standardChannelId(o.channelId);
      return id !== null && channels.some((c) => c.id === id);
    }).length,
  };

  // ── On-chain cost surfaced + spike warning (#4) ──
  const onchainOpenCostSat = cfg.defaultOpenCostSat;
  const onchainCloseCostSat = cfg.includeCloseCost ? cfg.defaultCloseCostSat : 0;
  if (onchainFeePerVbyte != null && onchainOpenCostSat + onchainCloseCostSat > 2500)
    sellWarnings.push(
      `on-chain fees are elevated (~${onchainOpenCostSat + onchainCloseCostSat} sat to open+close) — the profit floor is raised so you won't lease at a loss`,
    );

  // ── Seller-score / pending-order risk (#5) ──
  // What each kind waits on you for (review 2026-10-25: an order awaiting
  // approval was told to "open the channel", and a paid order the lane opens
  // itself counted as waiting on you).
  const awaitingDecision = myOrders.filter((o) => o.status === "WAITING_FOR_SELLER_APPROVAL").length;
  const awaitingOpen = waitingOnYou(myOrders, cfg.laneOpens) - awaitingDecision;
  const pendingSeller = awaitingDecision + awaitingOpen;
  const one = (n: number, it: string, them: string) => (n === 1 ? it : them);
  if (awaitingDecision > 0)
    sellWarnings.push(
      `${awaitingDecision} order${one(awaitingDecision, "", "s")} waiting for your decision — accept or reject ${one(awaitingDecision, "it", "them")} on Market → Orders in time, or your seller score drops`,
    );
  if (awaitingOpen > 0)
    sellWarnings.push(
      `${awaitingOpen} paid order${one(awaitingOpen, "", "s")} waiting for you to open ${one(awaitingOpen, "its channel", "their channels")} — open ${one(awaitingOpen, "it", "them")} in time, or your seller score drops`,
    );

  // Report and price card must describe the SAME band, or the page contradicts
  // itself: the banner would quote one clearing price and the card another.
  const primary = myOffers[0];
  const bandMin = primary?.minSizeSats ?? sellWindow.min;
  const bandMax = primary?.maxSizeSats ?? sellWindow.max;
  const popularLease = popularLeaseBlocks();
  const reportClearing = clearingFor({ minSizeSat: bandMin, maxSizeSat: bandMax, blocks: standardLease });
  // The median real order: a fact about the market, shown as one — not a
  // target that would make a small seller's offer fill.
  const medianOrderSat = demandFit(0, Number.MAX_SAFE_INTEGER)?.medianOrderSat ?? null;

  // ── Size window ───────────────────────────────────────────────────────────
  // The floor is economic, not arbitrary. Below this size the lease fee at the
  // market price no longer covers opening and closing the channel plus the
  // minimum profit, so taking the order would lose money — and it moves with the
  // mempool, which is why it cannot be the hardcoded 1M it used to be.
  // What can actually be served today, and whether the binding limit is the
  // user's cap or simply the coins on chain. Those need different answers: one is
  // a setting, the other is a funding problem, and conflating them is how an
  // offer stays idle while the operator tunes the wrong knob.
  // The order lane's own figure where it is known (review 2026-10-25: the
  // wallet after the reserve alone — the deploy cap already used and the
  // coins promised to accepted orders still counted as fundable, and the lane
  // turned down orders of the size the page said could be funded).
  const effectiveMaxOrderSat = Math.min(cfg.maxSellSizeSat, Math.max(0, deployableCapitalSat), Math.max(0, cfg.sellableNowSat ?? Number.POSITIVE_INFINITY));
  const capitalLimited = effectiveMaxOrderSat < cfg.maxSellSizeSat;
  if (capitalLimited)
    sellWarnings.push(
      `your cap allows ${sizeLabel(cfg.maxSellSizeSat)} orders but only ${sizeLabel(effectiveMaxOrderSat)} can be sold now (the wallet after the reserve and the coins promised to orders, within what the deploy cap has left) — orders above that are turned down`,
    );

  const recommendedMaxSizeSat = sellWindow.max;
  const recommendedMinSizeSat = sellWindow.min;
  const minViableSizeSat = sellWindow.minViable;

  // (An odd lease — 4032 blocks was our old default, the market trades 4320 /
  // 8640 / 12960 / 25920 — is flagged on each offer's own recommendation, the
  // card Market → Sell shows for it. It was flagged here too, for the first
  // offer: the page showed the same warning twice — review of P1b.)

  if (reportClearing && marketActivity()) {
    const act = marketActivity()!;
    sellReasons.push(
      `the market is trading ${act.perDay} orders a day; leases in your band clear around ${reportClearing.medianPpm} ppm for ${leaseDays(standardLease)} days`,
    );
  }

  // ── Projected monthly earnings from your own fill history (#7) ──
  const avgFeePerFill = filled.length ? grossEarningsSat / filled.length : 0;
  const projectedMonthlySat = Math.round(filled30.length * avgFeePerFill);

  return {
    generatedAt: readAt,
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
      standardLeaseBlocks: standardLease,
      medianOrderSat,
      recommendedMinSizeSat,
      recommendedMaxSizeSat,
      minViableSizeSat,
      minNetLeaseProfitSat: cfg.minNetLeaseProfitSat,
      serviceFeeRate: cfg.serviceFeeRate,
      effectiveMaxOrderSat,
      capitalLimited,
      projectedMonthlySat,
      onchainOpenCostSat,
      onchainCloseCostSat,
      onchainFeePerVbyte,
      acceptFloorSat,
      pendingSellerOrders: pendingSeller,
      pendingSellerOpens: awaitingOpen,
      clearing: reportClearing,
      marketActivity: marketActivity(),
      historyAgeHours: magmaHistoryAgeHours(),
      popularLeaseBlocks: popularLease,
      reasons: sellReasons,
      // What couldn't be read comes first: every figure below stands on it.
      warnings: [...readProblems, ...sellWarnings],
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
    readProblems,
  };
}
