import { subscribeToForwards, type AuthenticatedLnd } from "lightning";
import type { EventEmitter } from "node:events";
import { JsonStore } from "../store.js";

/**
 * Failed-HTLC telemetry — measures UNSERVED DEMAND.
 *
 * LND's forward-event stream includes the failures. Every HTLC we couldn't
 * forward because the outgoing channel lacked liquidity is a payment someone
 * wanted to route through us and we turned away — invisible in the forwards
 * ledger (which only shows successes), yet it's the strongest signal we have
 * for where demand exceeds deployed capital.
 *
 * Aggregated per outgoing channel per day, kept 30 days. This phase measures
 * and displays only (project rule: measure first, act on data) — the numbers
 * feed rebalance sizing / fee decisions once a few weeks of data exist.
 */

export interface HtlcDayBucket {
  day: string; // YYYY-MM-DD (UTC)
  outChannel: string;
  /** Forwards we failed for lack of outbound liquidity on that channel. */
  liquidityCount: number;
  liquiditySats: number;
  /** Other forward failures via that channel (fee/HTLC limits, downstream…). */
  otherCount: number;
}

interface HtlcTelemetryState {
  startedAt: string | null;
  buckets: HtlcDayBucket[];
}

export interface UnservedDemand {
  outChannel: string;
  liquidityCount: number;
  liquiditySats: number;
  otherCount: number;
}

const KEEP_DAYS = 30;
const FLUSH_MS = 60_000;
const RETRY_BASE_MS = 10_000;

let store: JsonStore<HtlcTelemetryState> | null = null;
let state: HtlcTelemetryState | null = null;
let dirty = false;
let sub: EventEmitter | undefined;
let retryMs = RETRY_BASE_MS;

export function initHtlcTelemetry(dataDir: string): void {
  store = new JsonStore<HtlcTelemetryState>(dataDir, "htlc-telemetry.json");
  state = store.read({ startedAt: null, buckets: [] });
  state.startedAt ??= new Date().toISOString();
  const flush = setInterval(() => {
    if (dirty && store && state) {
      store.write(state);
      dirty = false;
    }
  }, FLUSH_MS);
  flush.unref?.();
}

/** LND's failure detail when the outgoing channel lacked balance. */
const isLiquidityFailure = (internal?: string): boolean =>
  !!internal && /INSUFFICIENT_BALANCE/i.test(internal);

export function recordForwardEvent(event: {
  is_failed: boolean;
  is_receive: boolean;
  is_send: boolean;
  out_channel?: string;
  in_channel?: string;
  internal_failure?: string;
  tokens?: number;
  mtokens?: string;
}): void {
  if (!state) return;
  // Pure forward failures only — our own sends/receives aren't demand.
  if (!event.is_failed || event.is_receive || event.is_send) return;
  if (!event.out_channel || !event.in_channel) return;

  const day = new Date().toISOString().slice(0, 10);
  let bucket = state.buckets.find((b) => b.day === day && b.outChannel === event.out_channel);
  if (!bucket) {
    bucket = { day, outChannel: event.out_channel, liquidityCount: 0, liquiditySats: 0, otherCount: 0 };
    state.buckets.push(bucket);
    // Prune while we're here — one pass a day is plenty.
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    state.buckets = state.buckets.filter((b) => b.day >= cutoff);
  }
  const sats = event.tokens ?? (event.mtokens ? Math.floor(Number(event.mtokens) / 1000) : 0);
  if (isLiquidityFailure(event.internal_failure)) {
    bucket.liquidityCount += 1;
    bucket.liquiditySats += sats;
  } else {
    bucket.otherCount += 1;
  }
  dirty = true;
}

/** Subscribe to LND's HTLC events (read-only) and keep the counters current.
 *  Reconnects with backoff — LND restarts drop the stream. */
export function startHtlcTelemetry(lnd: AuthenticatedLnd): void {
  if (sub) return;
  try {
    sub = subscribeToForwards({ lnd });
    sub.on("forward", (event: Parameters<typeof recordForwardEvent>[0]) => recordForwardEvent(event));
    sub.on("error", () => {
      sub?.removeAllListeners();
      sub = undefined;
      const delay = retryMs;
      retryMs = Math.min(retryMs * 2, 300_000);
      const t = setTimeout(() => startHtlcTelemetry(lnd), delay);
      t.unref?.();
    });
    retryMs = RETRY_BASE_MS;
  } catch {
    sub = undefined;
  }
}

/** Aggregated unserved demand per outgoing channel over the window. */
export function getUnservedDemand(days = 7): UnservedDemand[] {
  if (!state) return [];
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const byChannel = new Map<string, UnservedDemand>();
  for (const b of state.buckets) {
    if (b.day < cutoff) continue;
    const agg = byChannel.get(b.outChannel) ?? {
      outChannel: b.outChannel,
      liquidityCount: 0,
      liquiditySats: 0,
      otherCount: 0,
    };
    agg.liquidityCount += b.liquidityCount;
    agg.liquiditySats += b.liquiditySats;
    agg.otherCount += b.otherCount;
    byChannel.set(b.outChannel, agg);
  }
  return [...byChannel.values()]
    .filter((d) => d.liquidityCount > 0 || d.otherCount > 0)
    .sort((a, b) => b.liquiditySats - a.liquiditySats);
}

/** How many days of events we've actually collected (caps the window label). */
export function telemetryAgeDays(): number {
  if (!state?.startedAt) return 0;
  return Math.min(KEEP_DAYS, Math.floor((Date.now() - new Date(state.startedAt).getTime()) / 86_400_000));
}
