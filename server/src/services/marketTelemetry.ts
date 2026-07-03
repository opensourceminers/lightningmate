import { JsonStore } from "../store.js";
import type { MagmaOffer } from "./amboss.js";

/**
 * Magma fill-rate telemetry — turns the live order book into HISTORY. The market
 * endpoint is only ever a snapshot ("no historical fill-rate available"), so we
 * sample it on the autopilot cadence and diff consecutive snapshots:
 *
 *   an offer's availableSats DROPPED  → someone bought that liquidity (confirmed
 *                                       fill at the seller's price, sized by the
 *                                       actual delta)
 *   an offer VANISHED with size left  → possibly sold out / delisted (recorded,
 *                                       but never used for pricing)
 *
 * This is the difference between pricing against what's LISTED and pricing
 * against what actually SELLS.
 */

export interface FillEvent {
  at: string;
  offerId: string;
  sellerPubkey: string;
  soldSats: number;
  /** Effective ppm of the fill (base fee amortised over the actual sold size). */
  effPpm: number;
  minSizeSats: number;
  maxSizeSats: number;
  /** true = observed size decrease; false = offer vanished (ambiguous). */
  confirmed: boolean;
}

interface OfferSeen {
  feeRatePpm: number;
  baseFeeSats: number;
  availableSats: number;
  minSizeSats: number;
  maxSizeSats: number;
}

interface TelemetryState {
  startedAt: string | null;
  lastSampleAt: string | null;
  lastSeen: Record<string, OfferSeen>;
  fills: FillEvent[];
}

export interface MarketPulse {
  /** Confirmed fills in the window. */
  confirmed: number;
  soldSats: number;
  medianFilledPpm: number | null;
  p25FilledPpm: number | null;
  p75FilledPpm: number | null;
  /** Vanished-with-size-left events (ambiguous — context only). */
  vanished: number;
  /** How many days of order-book history we actually have (caps the window). */
  trackedDays: number;
}

const DAY = 86_400_000;
/** Ignore availability jitter below this (dust / rounding), sats. */
const MIN_FILL_SATS = 250_000;
const KEEP_DAYS = 90;
const MAX_EVENTS = 1000;

const pctOf = (sorted: number[], q: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : null;

let store: JsonStore<TelemetryState> | null = null;
let state: TelemetryState | null = null;

/** Idempotent — called from the Autopilot constructor (always constructed). */
export function initMarketTelemetry(dataDir: string): void {
  if (store) return;
  store = new JsonStore<TelemetryState>(dataDir, "market-telemetry.json");
  state = store.read({ startedAt: null, lastSampleAt: null, lastSeen: {}, fills: [] });
}

/** Diff a fresh order-book snapshot against the last one and record fills. */
export function recordMarketSnapshot(offers: MagmaOffer[]): void {
  if (!store || !state) return;
  const now = new Date().toISOString();
  const seenNow: Record<string, OfferSeen> = {};
  for (const o of offers) {
    seenNow[o.id] = {
      feeRatePpm: o.feeRatePpm,
      baseFeeSats: o.baseFeeSats,
      availableSats: o.availableSats,
      minSizeSats: o.minSizeSats,
      maxSizeSats: o.maxSizeSats,
    };
  }

  // Only diff when we HAVE a previous snapshot (first run just seeds).
  if (state.lastSampleAt) {
    for (const [id, prev] of Object.entries(state.lastSeen)) {
      const cur = seenNow[id];
      const offer = offers.find((o) => o.id === id);
      if (cur) {
        const sold = prev.availableSats - cur.availableSats;
        if (sold >= MIN_FILL_SATS) {
          // Price the fill at the PREVIOUS price — that's what the buyer accepted.
          state.fills.push({
            at: now,
            offerId: id,
            sellerPubkey: offer?.sellerPubkey ?? "",
            soldSats: sold,
            effPpm: Math.round(prev.feeRatePpm + (prev.baseFeeSats / sold) * 1_000_000),
            minSizeSats: prev.minSizeSats,
            maxSizeSats: prev.maxSizeSats,
            confirmed: true,
          });
        }
      } else if (prev.availableSats >= MIN_FILL_SATS) {
        state.fills.push({
          at: now,
          offerId: id,
          sellerPubkey: "",
          soldSats: prev.availableSats,
          effPpm: Math.round(prev.feeRatePpm + (prev.baseFeeSats / prev.availableSats) * 1_000_000),
          minSizeSats: prev.minSizeSats,
          maxSizeSats: prev.maxSizeSats,
          confirmed: false,
        });
      }
    }
  }

  const cutoff = Date.now() - KEEP_DAYS * DAY;
  state.fills = state.fills.filter((f) => new Date(f.at).getTime() >= cutoff).slice(-MAX_EVENTS);
  state.lastSeen = seenNow;
  state.lastSampleAt = now;
  if (!state.startedAt) state.startedAt = now;
  store.write(state);
}

/**
 * Fill statistics over the window, optionally restricted to offers overlapping a
 * size band. Falls back to null when telemetry hasn't been running.
 */
export function getMarketPulse(days = 30, bandMin?: number, bandMax?: number): MarketPulse | null {
  if (!state?.startedAt) return null;
  const cutoff = Date.now() - days * DAY;
  const inBand = (f: FillEvent) =>
    bandMin == null || bandMax == null || (f.maxSizeSats >= bandMin && f.minSizeSats <= bandMax);
  const recent = state.fills.filter((f) => new Date(f.at).getTime() >= cutoff && inBand(f));
  const confirmed = recent.filter((f) => f.confirmed);
  const effs = confirmed.map((f) => f.effPpm).sort((a, b) => a - b);
  return {
    confirmed: confirmed.length,
    soldSats: confirmed.reduce((s, f) => s + f.soldSats, 0),
    medianFilledPpm: pctOf(effs, 0.5),
    p25FilledPpm: pctOf(effs, 0.25),
    p75FilledPpm: pctOf(effs, 0.75),
    vanished: recent.length - confirmed.length,
    trackedDays: Math.min(days, Math.ceil((Date.now() - new Date(state.startedAt).getTime()) / DAY)),
  };
}
