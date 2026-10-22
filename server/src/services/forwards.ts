import { getForwards, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";

export interface ForwardEvent {
  createdAt: string;
  incomingChannel: string;
  outgoingChannel: string;
  tokens: number;
  /** Fee earned on this forward, in sats (rounded — display only). */
  fee: number;
  /** Fee in millisatoshis — the precise value we accumulate on. */
  feeMsat: number;
}

export interface ChannelFlow {
  channelId: string;
  /** Sats forwarded OUT through this channel (it was the outgoing hop). */
  routedOut: number;
  /** Sats forwarded IN through this channel (it was the incoming hop). */
  routedIn: number;
  /** Fees we earned on forwards leaving via this channel, in sats. */
  feesEarned: number;
  forwardCount: number;
  /** Fees of the forwards that ENTERED through this channel (earned on
   *  their outgoing channel): what it brought in — review a5-analytics:
   *  inbound-channels-invisible. */
  inboundFeesEarned: number;
  inboundForwardCount: number;
}

export interface FlowSummary {
  windowDays: number;
  totalForwards: number;
  totalRoutedSats: number;
  totalFeesEarnedSats: number;
  perChannel: ChannelFlow[];
  recent: ForwardEvent[];
  /** False when LND had more forwards than were read (MAX_PAGES): LND hands
   *  them over oldest first, so the MOST RECENT of the window are missing. */
  complete: boolean;
}

/** At most this many pages of 1,000 forwards are read (100,000). */
const MAX_PAGES = 100;
const DAY_MS = 86_400_000;

/** Every forward of the last `windowDays`, with its exact fee in msat — for
 *  measurements over arbitrary intervals (fee outcomes), where per-day sums
 *  rounded to whole sats would drown a small channel's revenue. */
export async function getForwardEvents(lnd: AuthenticatedLnd, windowDays: number): Promise<ForwardEvent[]> {
  return (await fetchForwards(lnd, windowDays)).events;
}

/** Pull every forwarding event in the window, paging through the LND cursor
 *  — from the window's start onwards (ForwardingHistory pages by index,
 *  oldest first): a read cut short at MAX_PAGES misses the newest. */
async function fetchForwards(
  lnd: AuthenticatedLnd,
  windowDays: number,
  nowMs = Date.now(),
): Promise<{ events: ForwardEvent[]; complete: boolean }> {
  const after = new Date(nowMs - windowDays * DAY_MS).toISOString();
  const before = new Date(nowMs).toISOString();

  const events: ForwardEvent[] = [];
  let token: string | undefined;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    // First page seeds the query; later pages must use the cursor token alone.
    const args = token
      ? { lnd, token }
      : { lnd, after, before, limit: 1000 };
    const res = await getForwards(args);

    for (const f of res.forwards) {
      // Sum on millisatoshis (fee_mtokens) — using the rounded `fee` (whole sats)
      // drops sub-sat earnings and systematically understates routing revenue.
      const feeMsat = f.fee_mtokens != null ? Number(f.fee_mtokens) : Math.round((f.fee ?? 0) * 1000);
      events.push({
        createdAt: f.created_at,
        incomingChannel: f.incoming_channel,
        outgoingChannel: f.outgoing_channel,
        tokens: f.tokens,
        fee: Math.round(feeMsat / 1000),
        feeMsat,
      });
    }

    if (!res.next) {
      complete = true;
      break;
    }
    token = res.next;
  }

  return { events, complete };
}

export async function getFlowSummary(
  lnd: AuthenticatedLnd,
  windowDays: number,
): Promise<FlowSummary> {
  const { events, complete } = await fetchForwards(lnd, windowDays);

  const byChannel = new Map<string, ChannelFlow>();
  const ensure = (channelId: string): ChannelFlow => {
    let flow = byChannel.get(channelId);
    if (!flow) {
      flow = { channelId, routedOut: 0, routedIn: 0, feesEarned: 0, forwardCount: 0, inboundFeesEarned: 0, inboundForwardCount: 0 };
      byChannel.set(channelId, flow);
    }
    return flow;
  };

  let totalRouted = 0;
  let totalFeeMsat = 0;
  const feeMsatByChannel = new Map<string, number>();
  const inboundMsatByChannel = new Map<string, number>();

  for (const e of events) {
    const out = ensure(e.outgoingChannel);
    out.routedOut += e.tokens;
    out.forwardCount += 1;
    feeMsatByChannel.set(e.outgoingChannel, (feeMsatByChannel.get(e.outgoingChannel) ?? 0) + e.feeMsat);

    const inbound = ensure(e.incomingChannel);
    inbound.routedIn += e.tokens;
    inbound.inboundForwardCount += 1;
    inboundMsatByChannel.set(e.incomingChannel, (inboundMsatByChannel.get(e.incomingChannel) ?? 0) + e.feeMsat);

    totalRouted += e.tokens;
    totalFeeMsat += e.feeMsat;
  }

  // Convert accumulated millisats → sats once, at the end.
  for (const flow of byChannel.values()) {
    flow.feesEarned = Math.round((feeMsatByChannel.get(flow.channelId) ?? 0) / 1000);
    flow.inboundFeesEarned = Math.round((inboundMsatByChannel.get(flow.channelId) ?? 0) / 1000);
  }

  const perChannel = [...byChannel.values()].sort(
    (a, b) => b.routedOut + b.routedIn - (a.routedOut + a.routedIn),
  );

  // Most recent first, capped so the payload stays small.
  const recent = [...events]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50);

  return {
    windowDays,
    totalForwards: events.length,
    totalRoutedSats: totalRouted,
    totalFeesEarnedSats: Math.round(totalFeeMsat / 1000),
    perChannel,
    recent,
    complete,
  };
}

// ── Forwards report (Thunderhub-style overview) ───────────────────────────────

/** Which way liquidity actually moved through a channel over the window.
 *  draining = mostly routed OUT (local balance falls → will deplete);
 *  filling  = mostly routed IN (local balance rises → a natural rebalance source);
 *  balanced = two-way flow. */
export type ChannelFlowDirection = "draining" | "filling" | "balanced";

export interface ChannelForwardStat {
  channelId: string;
  alias: string;
  forwardCount: number;
  routedOutSats: number;
  routedInSats: number;
  feesEarnedSats: number;
  /** Forwards that ENTERED through this channel, and the fees they earned
   *  (on their outgoing channel): its part as the source of a route. A
   *  channel that only ever brought flow in earned nothing itself, yet
   *  closing it kills every route through it. */
  inboundForwardCount: number;
  inboundFeesSats: number;
  /** Current outbound share (local / (local+remote)), 0..1 — for urgency
   *  (0 for a channel no longer open: see `status`). */
  localRatio: number;
  capacity: number;
  /** "closed": not among the node's channels any more — its flow is history,
   *  never "draining · 0% left". */
  status: "open" | "pending" | "closed";
  flow: ChannelFlowDirection;
  /** Daily fees earned, aligned to the report's `daily` dates (for sparklines). */
  spark: number[];
}

/** A routing corridor: an incoming→outgoing channel pair that actually carried
 *  flow. Reveals which channel pairs are complementary — a profitable route
 *  needs a good source AND a good sink; killing either end kills the corridor. */
export interface RoutingCorridor {
  inChannel: string;
  outChannel: string;
  inAlias: string;
  outAlias: string;
  forwards: number;
  routedSats: number;
  feesSats: number;
}

export interface DailyBucket {
  date: string;
  forwards: number;
  routedSats: number;
  feesSats: number;
}

export interface ResolvedForward {
  createdAt: string;
  incoming: string;
  outgoing: string;
  tokens: number;
  fee: number;
}

export interface RollingTotals {
  forwards: number;
  routedSats: number;
  feesSats: number;
}

export interface ForwardsReport {
  windowDays: number;
  totalForwards: number;
  totalRoutedSats: number;
  totalFeesEarnedSats: number;
  avgFeePpm: number;
  maxForwardSats: number;
  busiestDay: string | null;
  perChannel: ChannelForwardStat[];
  corridors: RoutingCorridor[];
  /** One bucket per local day the window touches — its first and last day
   *  partial — so every forward in the totals is in a bucket. */
  daily: DailyBucket[];
  recent: ResolvedForward[];
  /** The last 24 hours and 7 days, ending now — rolling, never calendar
   *  days (review a5-analytics:utc-day-windows: "in 24h" read the current
   *  UTC day's bucket, half an hour of data at 00:30 UTC). */
  rolling: { last24h: RollingTotals; last7d: RollingTotals };
  /** Fees of the most recent half of the window against the half before
   *  it: equal spans ending now, so a partial day never tilts the trend. */
  trend: { halfDays: number; recentFeesSats: number; priorFeesSats: number; growthPct: number | null };
  /** The days are this many minutes east of UTC (the viewer's time zone). */
  tzOffsetMin: number;
  /** False when LND had more forwards than were read: the most recent of
   *  the window are missing — the rolling 24 h and 7 d figures with them. */
  complete: boolean;
}

/** A time zone offset the API accepts: whole minutes, −14 h … +14 h. */
export function parseTzOffset(raw: unknown): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= -840 && n <= 840 ? n : 0;
}

export async function getForwardsReport(
  lnd: AuthenticatedLnd,
  windowDays: number,
  opts: { tzOffsetMin?: number; nowMs?: number } = {},
): Promise<ForwardsReport> {
  const nowMs = opts.nowMs ?? Date.now();
  const tz = opts.tzOffsetMin ?? 0;
  const [{ events, complete }, channels] = await Promise.all([
    fetchForwards(lnd, windowDays, nowMs),
    getChannelsView(lnd),
  ]);
  return buildForwardsReport(events, channels, windowDays, { nowMs, tzOffsetMin: tz, complete });
}

/** The report from the forwards and the channels — pure, for tests. */
export function buildForwardsReport(
  events: ForwardEvent[],
  channels: { id: string; peerAlias: string; localRatio: number; capacity: number; status: "open" | "pending_open" | "pending_close" }[],
  windowDays: number,
  opts: { nowMs: number; tzOffsetMin: number; complete?: boolean },
): ForwardsReport {
  const { nowMs } = opts;
  const tz = opts.tzOffsetMin;
  const aliasById = new Map(channels.map((c) => [c.id, c.peerAlias]));
  const chanInfo = new Map(channels.map((c) => [c.id, { localRatio: c.localRatio, capacity: c.capacity, status: c.status }]));
  const name = (id: string): string => aliasById.get(id) ?? id;
  /** The viewer's local calendar day of a moment. */
  const localDay = (ms: number): string => new Date(ms + tz * 60_000).toISOString().slice(0, 10);

  const byChannel = new Map<string, ChannelForwardStat>();
  const ensure = (id: string): ChannelForwardStat => {
    let s = byChannel.get(id);
    if (!s) {
      const info = chanInfo.get(id);
      s = {
        channelId: id,
        alias: name(id),
        forwardCount: 0,
        routedOutSats: 0,
        routedInSats: 0,
        feesEarnedSats: 0,
        inboundForwardCount: 0,
        inboundFeesSats: 0,
        localRatio: info?.localRatio ?? 0,
        capacity: info?.capacity ?? 0,
        status: !info ? "closed" : info.status === "open" ? "open" : "pending",
        flow: "balanced",
        spark: [],
      };
      byChannel.set(id, s);
    }
    return s;
  };

  // Routing corridors: incoming→outgoing channel pairs that carried flow.
  const pairs = new Map<string, { forwards: number; routed: number; feeMsat: number }>();

  const dayMap = new Map<string, DailyBucket>();
  const dayFeeMsat = new Map<string, number>(); // date -> fee msat
  const chanFeeMsat = new Map<string, number>(); // channel -> fee msat
  const chanInboundMsat = new Map<string, number>(); // channel (as incoming) -> fee msat
  const perChanDayMsat = new Map<string, Map<string, number>>(); // channel -> date -> fee msat
  let totalRouted = 0;
  let totalFeeMsat = 0;
  let maxForward = 0;
  const roll = (fromMs: number) => {
    const r = { forwards: 0, routedSats: 0, feeMsat: 0 };
    return { r, fromMs };
  };
  const last24h = roll(nowMs - DAY_MS);
  const last7d = roll(nowMs - 7 * DAY_MS);
  const halfDays = Math.max(1, Math.floor(windowDays / 2));
  let recentMsat = 0;
  let priorMsat = 0;

  for (const e of events) {
    const t = Date.parse(e.createdAt);
    const out = ensure(e.outgoingChannel);
    out.routedOutSats += e.tokens;
    out.forwardCount += 1;
    chanFeeMsat.set(e.outgoingChannel, (chanFeeMsat.get(e.outgoingChannel) ?? 0) + e.feeMsat);
    const inbound = ensure(e.incomingChannel);
    inbound.routedInSats += e.tokens;
    inbound.inboundForwardCount += 1;
    chanInboundMsat.set(e.incomingChannel, (chanInboundMsat.get(e.incomingChannel) ?? 0) + e.feeMsat);

    totalRouted += e.tokens;
    totalFeeMsat += e.feeMsat;
    if (e.tokens > maxForward) maxForward = e.tokens;

    for (const w of [last24h, last7d]) {
      if (t > w.fromMs && t <= nowMs) {
        w.r.forwards += 1;
        w.r.routedSats += e.tokens;
        w.r.feeMsat += e.feeMsat;
      }
    }
    if (t > nowMs - halfDays * DAY_MS) recentMsat += e.feeMsat;
    else if (t > nowMs - 2 * halfDays * DAY_MS) priorMsat += e.feeMsat;

    const date = Number.isFinite(t) ? localDay(t) : e.createdAt.slice(0, 10);
    const bucket = dayMap.get(date) ?? { date, forwards: 0, routedSats: 0, feesSats: 0 };
    bucket.forwards += 1;
    bucket.routedSats += e.tokens;
    dayMap.set(date, bucket);
    dayFeeMsat.set(date, (dayFeeMsat.get(date) ?? 0) + e.feeMsat);

    let chanDays = perChanDayMsat.get(e.outgoingChannel);
    if (!chanDays) {
      chanDays = new Map();
      perChanDayMsat.set(e.outgoingChannel, chanDays);
    }
    chanDays.set(date, (chanDays.get(date) ?? 0) + e.feeMsat);

    const pairKey = `${e.incomingChannel}>${e.outgoingChannel}`;
    const p = pairs.get(pairKey) ?? { forwards: 0, routed: 0, feeMsat: 0 };
    p.forwards += 1;
    p.routed += e.tokens;
    p.feeMsat += e.feeMsat;
    pairs.set(pairKey, p);
  }

  // Convert accumulated millisats → sats once, and classify the flow direction.
  for (const s of byChannel.values()) {
    const msat = chanFeeMsat.get(s.channelId);
    if (msat) s.feesEarnedSats = Math.round(msat / 1000);
    const inMsat = chanInboundMsat.get(s.channelId);
    if (inMsat) s.inboundFeesSats = Math.round(inMsat / 1000);
    const total = s.routedOutSats + s.routedInSats;
    s.flow =
      total === 0
        ? "balanced"
        : s.routedOutSats / total >= 0.75
          ? "draining"
          : s.routedOutSats / total <= 0.25
            ? "filling"
            : "balanced";
  }

  const corridors: RoutingCorridor[] = [...pairs.entries()]
    .map(([key, p]) => {
      const [inC, outC] = key.split(">");
      return {
        inChannel: inC,
        outChannel: outC,
        inAlias: name(inC),
        outAlias: name(outC),
        forwards: p.forwards,
        routedSats: p.routed,
        feesSats: Math.round(p.feeMsat / 1000),
      };
    })
    .sort((a, b) => b.feesSats - a.feesSats)
    .slice(0, 8);

  // A continuous daily series (gaps filled with zeros), one bucket for every
  // local day the window touches: the first and the last are partial. Before,
  // the series ended with today's partial UTC day and skipped the window's
  // first day — whose forwards counted in the totals but in no bucket.
  const daily: DailyBucket[] = [];
  const lastDay = localDay(nowMs);
  for (let d = Date.parse(`${localDay(nowMs - windowDays * DAY_MS)}T00:00:00Z`); ; d += DAY_MS) {
    const date = new Date(d).toISOString().slice(0, 10);
    const b = dayMap.get(date);
    daily.push(b ? { ...b, feesSats: Math.round((dayFeeMsat.get(date) ?? 0) / 1000) } : { date, forwards: 0, routedSats: 0, feesSats: 0 });
    if (date >= lastDay || daily.length > windowDays + 2) break;
  }
  const busiestDay =
    daily.reduce<DailyBucket | null>((best, d) => (d.forwards > (best?.forwards ?? -1) ? d : best), null)
      ?.date ?? null;

  // Fill each channel's daily-fee sparkline (sats), aligned to the `daily` dates.
  for (const stat of byChannel.values()) {
    const days = perChanDayMsat.get(stat.channelId);
    stat.spark = daily.map((d) => Math.round((days?.get(d.date) ?? 0) / 1000));
  }

  const perChannel = [...byChannel.values()].sort((a, b) => b.feesEarnedSats + b.inboundFeesSats - (a.feesEarnedSats + a.inboundFeesSats));

  const recent: ResolvedForward[] = [...events]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 15)
    .map((e) => ({
      createdAt: e.createdAt,
      incoming: name(e.incomingChannel),
      outgoing: name(e.outgoingChannel),
      tokens: e.tokens,
      fee: e.fee,
    }));

  const totals = (w: typeof last24h): RollingTotals => ({ forwards: w.r.forwards, routedSats: w.r.routedSats, feesSats: Math.round(w.r.feeMsat / 1000) });
  const recentFeesSats = Math.round(recentMsat / 1000);
  const priorFeesSats = Math.round(priorMsat / 1000);
  return {
    windowDays,
    totalForwards: events.length,
    totalRoutedSats: totalRouted,
    totalFeesEarnedSats: Math.round(totalFeeMsat / 1000),
    avgFeePpm: totalRouted > 0 ? Math.round((totalFeeMsat / totalRouted) * 1000) : 0,
    maxForwardSats: maxForward,
    busiestDay,
    perChannel,
    corridors,
    daily,
    recent,
    rolling: { last24h: totals(last24h), last7d: totals(last7d) },
    trend: {
      halfDays,
      recentFeesSats,
      priorFeesSats,
      growthPct: priorMsat > 0 ? Math.round(((recentMsat - priorMsat) / priorMsat) * 100) : null,
    },
    tzOffsetMin: tz,
    complete: opts.complete ?? true,
  };
}
