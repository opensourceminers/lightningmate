import { JsonStore } from "../store.js";
import { marketOrderHistory, type RawMarketOrder } from "./amboss.js";

/**
 * Magma market HISTORY — what actually sold, at what price.
 *
 * The old code said "market is a live snapshot — no historical fill-rate
 * available" and worked around it by diffing the order book every autopilot tick
 * (services/marketTelemetry.ts). That was wrong twice over: an offer's
 * `total_size` is the seller's LISTED capacity, which moves with their wallet
 * and their top-ups, not with sales. Diffing it recorded ~57 "sales" a day when
 * the whole market does about 7,5 — and that fiction was then fed back into
 * pricing.
 *
 * Amboss does publish the real thing:
 *
 *   getMarketMetrics { order_details(from: "YYYY-MM-DD") {
 *     date size block_duration lnr lny status } }
 *
 * One row per completed order: how big, how long, and the rate the buyer paid.
 * That is the clearing price, and it is the only honest thing to price against.
 * Listed asks are what sellers wish for; this is what buyers agreed to.
 *
 * `lnr` is an ANNUALISED rate (0.0442 = 4,42%/yr). The fee actually paid for a
 * lease of `size` over `blocks` is therefore:
 *
 *   fee_sat = size * lnr * blocks / BLOCKS_PER_YEAR
 *   lease_ppm = lnr * blocks / BLOCKS_PER_YEAR * 1e6
 */

export const BLOCKS_PER_YEAR = 52_560;

export interface MarketOrder {
  /** Epoch ms. */
  at: number;
  sizeSat: number;
  blocks: number;
  /** Annualised rate the buyer paid, e.g. 0.0442. */
  apr: number;
  /** Whole-lease fee in ppm of channel size. */
  leasePpm: number;
  status: string;
}

export interface ClearingStats {
  /** Orders that matched, and how wide a window they came from. */
  count: number;
  windowDays: number;
  ordersPerMonth: number;
  /** Whole-lease ppm actually paid. */
  p25Ppm: number;
  medianPpm: number;
  p75Ppm: number;
  /** Annualised rate at the median, for comparing against routing yield. */
  medianApr: number;
  medianSizeSat: number;
  /** Lease length the band is normalised to. */
  blocks: number;
}

export interface DemandFit {
  windowDays: number;
  /** Every order in the window, whatever its size. */
  totalOrders: number;
  /** Orders our offer's size window could actually have served. */
  matchingOrders: number;
  sharePct: number;
  reachableOrdersPerMonth: number;
  medianOrderSat: number;
  /** max_size needed to reach ~half of all orders. Null when already there. */
  maxSizeForHalfMarket: number | null;
  /** What each candidate max_size would unlock, for the UI slider. */
  ladder: { maxSizeSat: number; sharePct: number; ordersPerMonth: number }[];
}

/** Lease durations the market actually uses; anything else barely trades. */
export const COMMON_LEASE_BLOCKS = [4320, 8640, 12960, 25920];
/** 30 days. What ~3 of 4 orders ask for, and our sane default. */
export const DEFAULT_LEASE_BLOCKS = 4320;

/**
 * Guards against junk rows. A handful of historical orders carry an lnr of
 * several hundred percent (fat-fingered offers, or tiny sizes where a flat base
 * fee dominates). Percentiles already resist those, but letting them into the
 * pool skews the mean size and the ladder counts, so they are dropped outright.
 */
const MAX_SANE_APR = 1.0; // 100%/yr
const MIN_SANE_SIZE = 20_000;

interface HistoryState {
  fetchedAt: number;
  from: string;
  orders: MarketOrder[];
}

const DAY = 86_400_000;
/** The history barely moves within a day; refetch every 6h at most. */
const TTL_MS = 6 * 3_600_000;
/** How much history we keep. A year is plenty and still only ~400 kB raw. */
const FETCH_DAYS = 365;

let store: JsonStore<HistoryState> | null = null;
let state: HistoryState | null = null;
let inFlight: Promise<void> | null = null;

/** Idempotent; called once at startup. */
export function initMagmaHistory(dataDir: string): void {
  if (store) return;
  store = new JsonStore<HistoryState>(dataDir, "magma-history.json");
  state = store.read({ fetchedAt: 0, from: "", orders: [] });
}

function mapOrder(r: RawMarketOrder): MarketOrder | null {
  const at = new Date(r.date).getTime();
  const sizeSat = Number(r.size);
  const blocks = Number(r.block_duration);
  const apr = Number(r.lnr);
  if (!Number.isFinite(at) || !Number.isFinite(sizeSat) || !Number.isFinite(blocks)) return null;
  if (!Number.isFinite(apr) || apr <= 0 || apr > MAX_SANE_APR) return null;
  if (sizeSat < MIN_SANE_SIZE || blocks <= 0) return null;
  return {
    at,
    sizeSat,
    blocks,
    apr,
    leasePpm: Math.round((apr * blocks * 1_000_000) / BLOCKS_PER_YEAR),
    status: r.status ?? "",
  };
}

/**
 * Refresh the cached history if it is stale. Never throws: if Amboss is down we
 * keep serving whatever we last stored, and the caller falls back to listed
 * prices when there is nothing at all.
 */
export async function refreshMagmaHistory(force = false): Promise<void> {
  if (!store || !state) return;
  if (!force && Date.now() - state.fetchedAt < TTL_MS && state.orders.length) return;
  if (inFlight) return inFlight;
  const from = new Date(Date.now() - FETCH_DAYS * DAY).toISOString().slice(0, 10);
  inFlight = (async () => {
    try {
      const raw = await marketOrderHistory(from);
      const orders = raw.map(mapOrder).filter((o): o is MarketOrder => o !== null);
      // Only replace a populated cache with something that actually parsed.
      if (orders.length || !state!.orders.length) {
        state!.orders = orders.sort((a, b) => a.at - b.at);
        state!.from = from;
      }
      state!.fetchedAt = Date.now();
      store!.write(state!);
    } catch {
      // Keep the last good history; the age is surfaced to the caller.
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** True once we have any real history to price against. */
export function hasMagmaHistory(): boolean {
  return !!state?.orders.length;
}

export function magmaHistoryAgeHours(): number | null {
  if (!state?.fetchedAt) return null;
  return Math.round((Date.now() - state.fetchedAt) / 3_600_000);
}

const pct = (sorted: number[], q: number): number =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : 0;

function inWindow(days: number): MarketOrder[] {
  if (!state) return [];
  const cutoff = Date.now() - days * DAY;
  return state.orders.filter((o) => o.at >= cutoff);
}

export interface BandQuery {
  minSizeSat: number;
  maxSizeSat: number;
  /** Normalise prices to this lease length. */
  blocks?: number;
  days?: number;
}

/**
 * What the market actually paid for leases our offer could have served.
 *
 * Prices are normalised to ONE lease length before being compared: a 90-day
 * lease costs more in total ppm than a 30-day one at the same annual rate, so
 * mixing them would quietly bias the percentiles by whatever duration mix
 * happened to trade. We compare annual rates and re-express them at our own
 * lease length.
 *
 * Widens the window (30d, then 90d, then 365d) until there are enough orders to
 * say anything, so a quiet fortnight cannot produce a confident wrong number.
 */
export function clearingFor(q: BandQuery): ClearingStats | null {
  if (!state?.orders.length) return null;
  const blocks = q.blocks ?? DEFAULT_LEASE_BLOCKS;
  const windows = q.days ? [q.days] : [30, 90, 365];
  const MIN_SAMPLE = 12;

  for (const days of windows) {
    const pool = inWindow(days).filter((o) => o.sizeSat >= q.minSizeSat && o.sizeSat <= q.maxSizeSat);
    if (pool.length < MIN_SAMPLE && days !== windows[windows.length - 1]) continue;
    if (!pool.length) return null;

    const aprs = pool.map((o) => o.apr).sort((a, b) => a - b);
    const sizes = pool.map((o) => o.sizeSat).sort((a, b) => a - b);
    const atOurTerm = (apr: number) => Math.round((apr * blocks * 1_000_000) / BLOCKS_PER_YEAR);
    return {
      count: pool.length,
      windowDays: days,
      ordersPerMonth: Math.round((pool.length / days) * 30 * 10) / 10,
      p25Ppm: atOurTerm(pct(aprs, 0.25)),
      medianPpm: atOurTerm(pct(aprs, 0.5)),
      p75Ppm: atOurTerm(pct(aprs, 0.75)),
      medianApr: pct(aprs, 0.5),
      medianSizeSat: pct(sizes, 0.5),
      blocks,
    };
  }
  return null;
}

/**
 * How much of the real market our size window can serve. This is the number the
 * old code had no way to compute, and it is usually the binding constraint: a
 * 1,0M–1,25M offer can only take about a tenth of the orders that exist, so no
 * amount of price tuning will make it fill.
 */
export function demandFit(minSizeSat: number, maxSizeSat: number, days = 90): DemandFit | null {
  if (!state?.orders.length) return null;
  const pool = inWindow(days);
  if (!pool.length) return null;
  const matching = pool.filter((o) => o.sizeSat >= minSizeSat && o.sizeSat <= maxSizeSat);
  const sizes = pool.map((o) => o.sizeSat).sort((a, b) => a - b);
  const share = (max: number) =>
    pool.filter((o) => o.sizeSat >= minSizeSat && o.sizeSat <= max).length;

  const candidates = [2_000_000, 3_000_000, 5_000_000, 10_000_000, 20_000_000].filter((c) => c > maxSizeSat);
  const half = pool.length / 2;
  let maxSizeForHalf: number | null = null;
  if (matching.length < half) {
    // Smallest max_size that would reach half the market, to the nearest 0,5M.
    for (const o of sizes) {
      if (share(o) >= half) {
        maxSizeForHalf = Math.ceil(o / 500_000) * 500_000;
        break;
      }
    }
  }

  return {
    windowDays: days,
    totalOrders: pool.length,
    matchingOrders: matching.length,
    sharePct: Math.round((matching.length / pool.length) * 1000) / 10,
    reachableOrdersPerMonth: Math.round((matching.length / days) * 30 * 10) / 10,
    medianOrderSat: pct(sizes, 0.5),
    maxSizeForHalfMarket: maxSizeForHalf,
    ladder: candidates.map((c) => ({
      maxSizeSat: c,
      sharePct: Math.round((share(c) / pool.length) * 1000) / 10,
      ordersPerMonth: Math.round((share(c) / days) * 30 * 10) / 10,
    })),
  };
}

/** The lease length buyers actually ask for most often, for our min_block_length. */
export function popularLeaseBlocks(days = 90): number {
  const pool = inWindow(days);
  if (!pool.length) return DEFAULT_LEASE_BLOCKS;
  const counts = new Map<number, number>();
  for (const o of pool) counts.set(o.blocks, (counts.get(o.blocks) ?? 0) + 1);
  let best = DEFAULT_LEASE_BLOCKS;
  let bestN = -1;
  for (const [blocks, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = blocks;
    }
  }
  return best;
}

/** Market-wide activity, for the "is anything selling at all" line in the UI. */
export function marketActivity(days = 90): { orders: number; perDay: number; windowDays: number } | null {
  if (!state?.orders.length) return null;
  const pool = inWindow(days);
  return {
    orders: pool.length,
    perDay: Math.round((pool.length / days) * 10) / 10,
    windowDays: days,
  };
}

/** Test seam: load a known history instead of hitting the network. */
export function __setHistoryForTests(orders: MarketOrder[]): void {
  state = { fetchedAt: Date.now(), from: "test", orders: [...orders].sort((a, b) => a.at - b.at) };
}
