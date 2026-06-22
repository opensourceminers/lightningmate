import { getForwards, type AuthenticatedLnd } from "lightning";

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
