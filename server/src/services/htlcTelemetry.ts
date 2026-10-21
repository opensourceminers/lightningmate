import { getChannels, subscribeToForwards, type AuthenticatedLnd } from "lightning";
import type { EventEmitter } from "node:events";
import { JsonStore } from "../store.js";

/**
 * Failed-HTLC telemetry — measures UNSERVED DEMAND.
 *
 * LND's forward-event stream includes the failures. Every HTLC we couldn't
 * forward because the outgoing channel lacked liquidity is a payment someone
 * wanted to route through us and we turned away — invisible in the forwards
 * ledger (which only shows successes).
 *
 * Most of those refusals are not demand (D20, review a2/a5): on the dev node
 * 92% of the refused volume was probe-shaped — HTLCs of 95–99% of a channel's
 * capacity, and one round amount tried on seven channels within minutes. The
 * raw sum exceeded the node's whole capacity. So every refusal is classified
 * as it arrives:
 *   - retry:     the same amount was refused within RETRY_WINDOW_MS (on any
 *                channel) — one attempt, counted once;
 *   - probe:     ≥ PROBE_SHARE of the channel's capacity (capacity probing —
 *                no channel ever forwards that);
 *   - oversized: ≥ SERVABLE_SHARE of the capacity — plausible, but no refill
 *                to a healthy balance would carry it;
 *   - demand:    the rest: distinct attempts a refilled channel could serve.
 * The raw counts are kept (and labelled as such); the fee engine and the
 * rebalancer read only `demand` (servableDemand).
 *
 * Aggregated per outgoing channel per day, kept 30 days.
 */

export interface HtlcDayBucket {
  day: string; // YYYY-MM-DD (UTC)
  outChannel: string;
  /** Every forward we failed for lack of outbound liquidity on that channel —
   *  probes and retries included. */
  liquidityCount: number;
  liquiditySats: number;
  /** Other forward failures via that channel (fee/HTLC limits, downstream…). */
  otherCount: number;
  // Classified (D20). Absent on buckets written before classification existed.
  probeCount?: number;
  probeSats?: number;
  retryCount?: number;
  retrySats?: number;
  oversizedCount?: number;
  oversizedSats?: number;
  /** The channel's size was not known when it arrived (not classified). */
  unknownCount?: number;
  unknownSats?: number;
  demandCount?: number;
  demandSats?: number;
  /** Sizes of the demand attempts (bounded), for the median. */
  demandAmounts?: number[];
}

interface HtlcTelemetryState {
  startedAt: string | null;
  /** Since when refusals are classified (older buckets only have raw counts). */
  classifiedSince?: string | null;
  buckets: HtlcDayBucket[];
}

export interface UnservedDemand {
  outChannel: string;
  /** Raw: every refusal for lack of liquidity, as LND reported it. */
  liquidityCount: number;
  liquiditySats: number;
  otherCount: number;
  probeCount: number;
  probeSats: number;
  retryCount: number;
  retrySats: number;
  oversizedCount: number;
  oversizedSats: number;
  /** Refusals that could not be classified (channel size unknown, or from
   *  before classification existed). */
  unclassifiedCount: number;
  unclassifiedSats: number;
  /** De-noised: distinct attempts a refilled channel could have carried. */
  demandCount: number;
  demandSats: number;
  /** Days with at least one such attempt. */
  demandDays: number;
  demandMedianSats: number | null;
}

/** What the engines read (servableDemand): de-noised refusals per channel. */
export interface DemandSignal {
  attempts: number;
  sats: number;
  days: number;
  medianSats: number | null;
}

const KEEP_DAYS = 30;
const FLUSH_MS = 60_000;
const RETRY_BASE_MS = 10_000;
/** The same amount refused again within this long is a retry of one attempt. */
export const RETRY_WINDOW_MS = 10 * 60_000;
/** At or above this share of the channel's capacity: a probe. */
export const PROBE_SHARE = 0.9;
/** At or above this share: no refill to a healthy balance would carry it. */
export const SERVABLE_SHARE = 0.5;
const AMOUNTS_KEPT = 100;
const CAPACITY_REFRESH_MS = 10 * 60_000;

let store: JsonStore<HtlcTelemetryState> | null = null;
let state: HtlcTelemetryState | null = null;
let dirty = false;
let sub: EventEmitter | undefined;
let retryMs = RETRY_BASE_MS;
let flushTimer: NodeJS.Timeout | undefined;
let retryTimer: NodeJS.Timeout | undefined;
let capacityTimer: NodeJS.Timeout | undefined;
let stopped = false;
/** Channel id → capacity (sat), from LND (setChannelCapacities). */
let capacities = new Map<string, number>();
/** Refusals of the last RETRY_WINDOW_MS (memory only: a restart forgets ten
 *  minutes of retries at most). */
let recent: { at: number; sats: number }[] = [];
/** Asks LND for the channel sizes again (set while the stream runs). */
let refreshCapacities: (() => void) | null = null;

export function initHtlcTelemetry(dataDir: string): void {
  if (flushTimer) clearInterval(flushTimer);
  stopped = false;
  recent = [];
  store = new JsonStore<HtlcTelemetryState>(dataDir, "htlc-telemetry.json");
  state = store.read({ startedAt: null, buckets: [] });
  if (!Array.isArray(state.buckets)) state.buckets = [];
  state.startedAt ??= new Date().toISOString();
  state.classifiedSince ??= new Date().toISOString();
  flushTimer = setInterval(flushHtlcTelemetry, FLUSH_MS);
  flushTimer.unref?.();
}

/** Write pending counters now (also called on shutdown, so up to a minute of
 *  events isn't lost on every restart). */
export function flushHtlcTelemetry(): void {
  if (dirty && store && state) {
    if (store.write(state)) dirty = false;
  }
}

/** Shutdown: stop listening and stop the flush timer (call flush afterwards). */
export function stopHtlcTelemetry(): void {
  stopped = true;
  if (flushTimer) clearInterval(flushTimer);
  if (retryTimer) clearTimeout(retryTimer);
  if (capacityTimer) clearInterval(capacityTimer);
  flushTimer = undefined;
  retryTimer = undefined;
  capacityTimer = undefined;
  refreshCapacities = null;
  sub?.removeAllListeners();
  sub = undefined;
}

/** The channel sizes refusals are classified against (channel id → sat). */
export function setChannelCapacities(entries: Iterable<[string, number]>): void {
  capacities = new Map(entries);
}

/** LND's failure detail when the outgoing channel lacked balance. */
const isLiquidityFailure = (internal?: string): boolean =>
  !!internal && /INSUFFICIENT_BALANCE/i.test(internal);

type Kind = "retry" | "probe" | "oversized" | "unknown" | "demand";

/** What a refusal of `sats` on `outChannel` most likely was (see the header). */
function classify(sats: number, outChannel: string, nowMs: number): Kind {
  recent = recent.filter((r) => nowMs - r.at < RETRY_WINDOW_MS);
  const seen = recent.some((r) => r.sats === sats);
  recent.push({ at: nowMs, sats });
  if (recent.length > 5_000) recent.splice(0, recent.length - 5_000);
  if (seen) return "retry";
  const cap = capacities.get(outChannel);
  if (!cap || cap <= 0) {
    refreshCapacities?.();
    return "unknown";
  }
  if (sats >= cap * PROBE_SHARE) return "probe";
  if (sats >= cap * SERVABLE_SHARE) return "oversized";
  return "demand";
}

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

  const nowMs = Date.now();
  const day = new Date(nowMs).toISOString().slice(0, 10);
  let bucket = state.buckets.find((b) => b.day === day && b.outChannel === event.out_channel);
  if (!bucket) {
    bucket = { day, outChannel: event.out_channel, liquidityCount: 0, liquiditySats: 0, otherCount: 0 };
    state.buckets.push(bucket);
    // Prune while we're here — one pass a day is plenty.
    const cutoff = new Date(nowMs - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
    state.buckets = state.buckets.filter((b) => b.day >= cutoff);
  }
  const sats = event.tokens ?? (event.mtokens ? Math.floor(Number(event.mtokens) / 1000) : 0);
  if (isLiquidityFailure(event.internal_failure)) {
    bucket.liquidityCount += 1;
    bucket.liquiditySats += sats;
    const kind = classify(sats, event.out_channel, nowMs);
    bucket[`${kind}Count`] = (bucket[`${kind}Count`] ?? 0) + 1;
    bucket[`${kind}Sats`] = (bucket[`${kind}Sats`] ?? 0) + sats;
    if (kind === "demand") {
      const amounts = (bucket.demandAmounts ??= []);
      if (amounts.length < AMOUNTS_KEPT) amounts.push(sats);
    }
  } else {
    bucket.otherCount += 1;
  }
  dirty = true;
}

/** Subscribe to LND's HTLC events (read-only) and keep the counters current.
 *  Reconnects with backoff — LND restarts drop the stream. The channel sizes
 *  the classification needs are read now and every 10 minutes (and soon
 *  after a refusal on a channel not known yet). */
export function startHtlcTelemetry(lnd: AuthenticatedLnd): void {
  if (sub || stopped) return;
  if (!refreshCapacities) {
    let running = false;
    let last = 0;
    refreshCapacities = () => {
      // At most one read at a time, and not more than once a minute when
      // asked by unknown channels.
      if (running || Date.now() - last < 60_000) return;
      running = true;
      last = Date.now();
      getChannels({ lnd })
        .then(({ channels }) => setChannelCapacities(channels.map((c) => [c.id, c.capacity])))
        .catch(() => undefined)
        .finally(() => (running = false));
    };
    refreshCapacities();
    capacityTimer = setInterval(() => {
      last = 0;
      refreshCapacities?.();
    }, CAPACITY_REFRESH_MS);
    capacityTimer.unref?.();
  }
  try {
    sub = subscribeToForwards({ lnd });
    sub.on("forward", (event: Parameters<typeof recordForwardEvent>[0]) => recordForwardEvent(event));
    sub.on("error", () => {
      sub?.removeAllListeners();
      sub = undefined;
      const delay = retryMs;
      retryMs = Math.min(retryMs * 2, 300_000);
      retryTimer = setTimeout(() => startHtlcTelemetry(lnd), delay);
      retryTimer.unref?.();
    });
    retryMs = RETRY_BASE_MS;
  } catch {
    sub = undefined;
  }
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Aggregated unserved demand per outgoing channel over the window: the raw
 *  refusals and what classification makes of them. */
export function getUnservedDemand(days = 7): UnservedDemand[] {
  if (!state) return [];
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const byChannel = new Map<string, UnservedDemand & { amounts: number[]; dayset: Set<string> }>();
  for (const b of state.buckets) {
    if (b.day < cutoff) continue;
    let agg = byChannel.get(b.outChannel);
    if (!agg) {
      agg = {
        outChannel: b.outChannel,
        liquidityCount: 0,
        liquiditySats: 0,
        otherCount: 0,
        probeCount: 0,
        probeSats: 0,
        retryCount: 0,
        retrySats: 0,
        oversizedCount: 0,
        oversizedSats: 0,
        unclassifiedCount: 0,
        unclassifiedSats: 0,
        demandCount: 0,
        demandSats: 0,
        demandDays: 0,
        demandMedianSats: null,
        amounts: [],
        dayset: new Set(),
      };
      byChannel.set(b.outChannel, agg);
    }
    agg.liquidityCount += b.liquidityCount;
    agg.liquiditySats += b.liquiditySats;
    agg.otherCount += b.otherCount;
    agg.probeCount += b.probeCount ?? 0;
    agg.probeSats += b.probeSats ?? 0;
    agg.retryCount += b.retryCount ?? 0;
    agg.retrySats += b.retrySats ?? 0;
    agg.oversizedCount += b.oversizedCount ?? 0;
    agg.oversizedSats += b.oversizedSats ?? 0;
    agg.demandCount += b.demandCount ?? 0;
    agg.demandSats += b.demandSats ?? 0;
    if ((b.demandCount ?? 0) > 0) agg.dayset.add(b.day);
    agg.amounts.push(...(b.demandAmounts ?? []));
    // Whatever wasn't classified (unknown size, or an older bucket).
    const classified =
      (b.probeCount ?? 0) + (b.retryCount ?? 0) + (b.oversizedCount ?? 0) + (b.demandCount ?? 0);
    const classifiedSats = (b.probeSats ?? 0) + (b.retrySats ?? 0) + (b.oversizedSats ?? 0) + (b.demandSats ?? 0);
    agg.unclassifiedCount += Math.max(0, b.liquidityCount - classified);
    agg.unclassifiedSats += Math.max(0, b.liquiditySats - classifiedSats);
  }
  return [...byChannel.values()]
    .map(({ amounts, dayset, ...d }) => ({ ...d, demandDays: dayset.size, demandMedianSats: median(amounts) }))
    .filter((d) => d.liquidityCount > 0 || d.otherCount > 0)
    .sort((a, b) => b.demandSats - a.demandSats || b.liquiditySats - a.liquiditySats);
}

/**
 * De-noised unserved demand per channel (D20) — the only form the engines
 * may use: distinct attempts a refilled channel could have carried, without
 * probes, retries and HTLCs too big for any healthy balance. (The fee engine
 * keeps a channel that turns such payments away from being lowered as
 * "idle"; the rebalancer can size refills by it.)
 */
export function servableDemand(days: number): Map<string, DemandSignal> {
  const out = new Map<string, DemandSignal>();
  for (const d of getUnservedDemand(days)) {
    if (d.demandCount > 0) {
      out.set(d.outChannel, { attempts: d.demandCount, sats: d.demandSats, days: d.demandDays, medianSats: d.demandMedianSats });
    }
  }
  return out;
}

/** How long events have been collected, in days (one decimal — the first
 *  day reads 0.x, not 0). */
export function telemetryAgeDays(): number {
  if (!state?.startedAt) return 0;
  const days = (Date.now() - new Date(state.startedAt).getTime()) / 86_400_000;
  return Math.min(KEEP_DAYS, Math.max(0, Math.floor(days * 10) / 10));
}

/** Since when refusals are classified (null: telemetry not running). */
export function classifiedSince(): string | null {
  return state?.classifiedSince ?? null;
}
