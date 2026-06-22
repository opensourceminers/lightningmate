import { getForwards, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";

export interface ForwardEvent {
  createdAt: string;
  incomingChannel: string;
  outgoingChannel: string;
  tokens: number;
  fee: number;
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
      events.push({
        createdAt: f.created_at,
        incomingChannel: f.incoming_channel,
        outgoingChannel: f.outgoing_channel,
        tokens: f.tokens,
        fee: f.fee,
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
  let totalFees = 0;

  for (const e of events) {
    const out = ensure(e.outgoingChannel);
    out.routedOut += e.tokens;
    out.feesEarned += e.fee;
    out.forwardCount += 1;

    ensure(e.incomingChannel).routedIn += e.tokens;

    totalRouted += e.tokens;
    totalFees += e.fee;
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
    totalFeesEarnedSats: totalFees,
    perChannel,
    recent,
  };
}

// ── Forwards report (Thunderhub-style overview) ───────────────────────────────

export interface ChannelForwardStat {
  channelId: string;
  alias: string;
  forwardCount: number;
  routedOutSats: number;
  routedInSats: number;
  feesEarnedSats: number;
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
  const name = (id: string): string => aliasById.get(id) ?? id;

  const byChannel = new Map<string, ChannelForwardStat>();
  const ensure = (id: string): ChannelForwardStat => {
    let s = byChannel.get(id);
    if (!s) {
      s = { channelId: id, alias: name(id), forwardCount: 0, routedOutSats: 0, routedInSats: 0, feesEarnedSats: 0 };
      byChannel.set(id, s);
    }
    return s;
  };

  const dayMap = new Map<string, DailyBucket>();
  let totalRouted = 0;
  let totalFees = 0;
  let maxForward = 0;

  for (const e of events) {
    const out = ensure(e.outgoingChannel);
    out.routedOutSats += e.tokens;
    out.feesEarnedSats += e.fee;
    out.forwardCount += 1;
    ensure(e.incomingChannel).routedInSats += e.tokens;

    totalRouted += e.tokens;
    totalFees += e.fee;
    if (e.tokens > maxForward) maxForward = e.tokens;

    const date = e.createdAt.slice(0, 10);
    const bucket = dayMap.get(date) ?? { date, forwards: 0, routedSats: 0, feesSats: 0 };
    bucket.forwards += 1;
    bucket.routedSats += e.tokens;
    bucket.feesSats += e.fee;
    dayMap.set(date, bucket);
  }

  // Continuous daily series (fill gaps with zeros) for the chart.
  const daily: DailyBucket[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    daily.push(dayMap.get(date) ?? { date, forwards: 0, routedSats: 0, feesSats: 0 });
  }
  const busiestDay =
    daily.reduce<DailyBucket | null>((best, d) => (d.forwards > (best?.forwards ?? -1) ? d : best), null)
      ?.date ?? null;

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
    totalFeesEarnedSats: totalFees,
    avgFeePpm: totalRouted > 0 ? Math.round((totalFees / totalRouted) * 1_000_000) : 0,
    maxForwardSats: maxForward,
    busiestDay,
    perChannel,
    daily,
    recent,
  };
}
