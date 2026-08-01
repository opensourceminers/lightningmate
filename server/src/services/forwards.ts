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
}

export interface FlowSummary {
  windowDays: number;
  totalForwards: number;
  totalRoutedSats: number;
  totalFeesEarnedSats: number;
  perChannel: ChannelFlow[];
  recent: ForwardEvent[];
}

const MAX_PAGES = 100;

/** Pull every forwarding event in the window, paging through the LND cursor. */
async function fetchForwards(
  lnd: AuthenticatedLnd,
  windowDays: number,
): Promise<ForwardEvent[]> {
  const after = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const before = new Date().toISOString();

  const events: ForwardEvent[] = [];
  let token: string | undefined;

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

    if (!res.next) break;
    token = res.next;
  }

  return events;
}

export async function getFlowSummary(
  lnd: AuthenticatedLnd,
  windowDays: number,
): Promise<FlowSummary> {
  const events = await fetchForwards(lnd, windowDays);

  const byChannel = new Map<string, ChannelFlow>();
  const ensure = (channelId: string): ChannelFlow => {
    let flow = byChannel.get(channelId);
    if (!flow) {
      flow = { channelId, routedOut: 0, routedIn: 0, feesEarned: 0, forwardCount: 0 };
      byChannel.set(channelId, flow);
    }
    return flow;
  };

  let totalRouted = 0;
  let totalFeeMsat = 0;
  const feeMsatByChannel = new Map<string, number>();

  for (const e of events) {
    const out = ensure(e.outgoingChannel);
    out.routedOut += e.tokens;
    out.forwardCount += 1;
    feeMsatByChannel.set(e.outgoingChannel, (feeMsatByChannel.get(e.outgoingChannel) ?? 0) + e.feeMsat);

    ensure(e.incomingChannel).routedIn += e.tokens;

    totalRouted += e.tokens;
    totalFeeMsat += e.feeMsat;
  }

  // Convert accumulated millisats → sats once, at the end.
  for (const [id, msat] of feeMsatByChannel) {
    const flow = byChannel.get(id);
    if (flow) flow.feesEarned = Math.round(msat / 1000);
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
  /** Current outbound share (local / (local+remote)), 0..1 — for urgency. */
  localRatio: number;
  capacity: number;
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
  daily: DailyBucket[];
  recent: ResolvedForward[];
}

export async function getForwardsReport(
  lnd: AuthenticatedLnd,
  windowDays: number,
): Promise<ForwardsReport> {
  const [events, channels] = await Promise.all([
    fetchForwards(lnd, windowDays),
    getChannelsView(lnd),
  ]);
  const aliasById = new Map(channels.map((c) => [c.id, c.peerAlias]));
  const chanInfo = new Map(channels.map((c) => [c.id, { localRatio: c.localRatio, capacity: c.capacity }]));
  const name = (id: string): string => aliasById.get(id) ?? id;

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
        localRatio: info?.localRatio ?? 0,
        capacity: info?.capacity ?? 0,
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
  const perChanDayMsat = new Map<string, Map<string, number>>(); // channel -> date -> fee msat
  let totalRouted = 0;
  let totalFeeMsat = 0;
  let maxForward = 0;

  for (const e of events) {
    const out = ensure(e.outgoingChannel);
    out.routedOutSats += e.tokens;
    out.forwardCount += 1;
    chanFeeMsat.set(e.outgoingChannel, (chanFeeMsat.get(e.outgoingChannel) ?? 0) + e.feeMsat);
    ensure(e.incomingChannel).routedInSats += e.tokens;

    totalRouted += e.tokens;
    totalFeeMsat += e.feeMsat;
    if (e.tokens > maxForward) maxForward = e.tokens;

    const date = e.createdAt.slice(0, 10);
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

  // Continuous daily series (fill gaps with zeros) for the chart.
  const daily: DailyBucket[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const b = dayMap.get(date);
    daily.push(
      b
        ? { ...b, feesSats: Math.round((dayFeeMsat.get(date) ?? 0) / 1000) }
        : { date, forwards: 0, routedSats: 0, feesSats: 0 },
    );
  }
  const busiestDay =
    daily.reduce<DailyBucket | null>((best, d) => (d.forwards > (best?.forwards ?? -1) ? d : best), null)
      ?.date ?? null;

  // Fill each channel's daily-fee sparkline (sats), aligned to the `daily` dates.
  for (const stat of byChannel.values()) {
    const days = perChanDayMsat.get(stat.channelId);
    stat.spark = daily.map((d) => Math.round((days?.get(d.date) ?? 0) / 1000));
  }

  const perChannel = [...byChannel.values()].sort((a, b) => b.feesEarnedSats - a.feesEarnedSats);

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
  };
}
