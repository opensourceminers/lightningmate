import { getClosedChannels, getNode, getPeers, getWalletInfo, type AuthenticatedLnd, type GetNodeResult } from "lightning";
import { readForwardEvents, type ForwardEvent } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { dialOrder, scidAgeDays } from "./suggestRecommend.js";
import type { GraphCache } from "./suggestions.js";
import type { FeeChangeRecord } from "./feeChangeLog.js";
import type { RebalanceRecord } from "./rebalanceLog.js";

/**
 * One node, everything this app knows about it, in one read: for the node
 * details the UI opens from wherever a node is named. From LND and this app's
 * own records only, so nothing here leaves the machine (the public record and
 * LN+ are a read of their own: nodeLookup.ts).
 */

const DAY_MS = 86_400_000;
type ChannelPolicy = NonNullable<GetNodeResult["channels"]>[number]["policies"][number];
/** The window every per-channel figure covers. */
export const NODE_WINDOW_DAYS = 30;
/** The newest this many fee changes and refills are listed. */
const EVENTS_MAX = 30;

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** What the network graph says about a node. */
export interface NodeNetwork {
  channels: number;
  capacitySats: number;
  avgChannelSats: number;
  /** The median fee of its enabled channels (ppm); an average would follow
   *  one channel priced to stay empty. Null: none known. */
  typicalFeePpm: number | null;
  enabledChannels: number;
  /** Every address it announces, in the order this node dials them. */
  addresses: string[];
  hasClearnet: boolean;
  hasOnion: boolean;
  lastAnnouncedAt: string | null;
}

/** The open connection to it, when there is one. */
export interface NodeConnection {
  socket: string;
  /** It dialed us. */
  inbound: boolean;
  pingMs: number;
  /** Since when it has been connected without a break (null: LND didn't say). */
  connectedSince: string | null;
  sentBytes: number;
  receivedBytes: number;
}

/** One channel's figures over the window, and what the peer charges on it. */
export interface NodeChannelFacts {
  channelId: string;
  ageDays: number | null;
  /** Forwards that left through it, and the fees they earned. */
  forwardsOut: number;
  routedOutSats: number;
  earnedSats: number;
  /** Forwards that came in through it, and the fees they earned elsewhere. */
  forwardsIn: number;
  routedInSats: number;
  broughtInSats: number;
  /** Refills into it. */
  refills: number;
  refillSats: number;
  refillFeeSats: number;
  /** What the peer charges to send over it toward this node (null: not in the graph). */
  theirFeePpm: number | null;
  theirBaseFeeMsat: number | null;
  theirDisabled: boolean | null;
  theirTimeLock: number | null;
}

export type NodeEvent =
  | { kind: "fee"; at: string; channelId: string; fromPpm: number | null; toPpm: number; via: FeeChangeRecord["via"]; why: string | null }
  | { kind: "refill"; at: string; channelId: string; direction: "in" | "out"; amountSats: number; feeSats: number | null; via: RebalanceRecord["via"] };

/** A channel with this node that is gone. */
export interface NodeClosedChannel {
  id: string | null;
  capacitySats: number;
  closedDaysAgo: number | null;
  how: "cooperative" | "you_forced" | "they_forced" | "breach" | "other";
  /** What came back to this node's side at the close (null: not known). */
  finalLocalSats: number | null;
}

export interface NodeFacts {
  pubkey: string;
  alias: string;
  isSelf: boolean;
  /** Null: LND's graph doesn't have it (a private peer, a node never seen). */
  network: NodeNetwork | null;
  connection: NodeConnection | null;
  channelFacts: NodeChannelFacts[];
  /** The figures cover the whole window (false: LND had more forwards than
   *  were read, or none could be read — the earnings shown may be short). */
  forwardsKnown: boolean;
  events: NodeEvent[];
  /** How many there are beyond the ones listed. */
  eventsMore: number;
  closedChannels: NodeClosedChannel[];
  windowDays: number;
}

/** What this reads besides LND. */
export interface NodeFactsSources {
  /** This node's channels with the peer (ids only needed). */
  channelIds: readonly string[];
  /** Every fee change on record, newest first. */
  feeChanges: readonly FeeChangeRecord[];
  /** Every successful refill on record, newest first. */
  refills: readonly RebalanceRecord[];
  /** A channel with it is closing, under this alias (shared with no other
   *  peer). While it closes it goes by its funding outpoint, and LND doesn't
   *  list it among the closed ones: the logs, keyed by short channel id, can
   *  only be matched by name. Up to two weeks on a force-close. */
  closingAlias?: string;
}

function closedHow(c: {
  is_cooperative_close?: boolean;
  is_local_force_close?: boolean;
  is_remote_force_close?: boolean;
  is_breach_close?: boolean;
}): NodeClosedChannel["how"] {
  if (c.is_breach_close) return "breach";
  if (c.is_local_force_close) return "you_forced";
  if (c.is_remote_force_close) return "they_forced";
  if (c.is_cooperative_close) return "cooperative";
  return "other";
}

/** The window's forwards through each channel. */
function perChannel(events: readonly ForwardEvent[], ids: ReadonlySet<string>) {
  const out = new Map<string, { forwardsOut: number; routedOutSats: number; earnedMsat: number; forwardsIn: number; routedInSats: number; broughtInMsat: number }>();
  const of = (id: string) => {
    let f = out.get(id);
    if (!f) out.set(id, (f = { forwardsOut: 0, routedOutSats: 0, earnedMsat: 0, forwardsIn: 0, routedInSats: 0, broughtInMsat: 0 }));
    return f;
  };
  for (const e of events) {
    if (ids.has(e.outgoingChannel)) {
      const f = of(e.outgoingChannel);
      f.forwardsOut += 1;
      f.routedOutSats += e.tokens;
      f.earnedMsat += e.feeMsat;
    }
    if (ids.has(e.incomingChannel)) {
      const f = of(e.incomingChannel);
      f.forwardsIn += 1;
      f.routedInSats += e.tokens;
      f.broughtInMsat += e.feeMsat;
    }
  }
  return out;
}

export async function getNodeFacts(lnd: AuthenticatedLnd, pubkey: string, src: NodeFactsSources, nowMs = Date.now()): Promise<NodeFacts> {
  const [node, peers, forwards, closed, info, own] = await Promise.all([
    // With its channels: one call on any LND of the last years. If that
    // fails, without them (no fees then). Unknown to the graph: no network
    // section, the rest still stands.
    getNode({ lnd, public_key: pubkey })
      .catch(() => getNode({ lnd, public_key: pubkey, is_omitting_channels: true }))
      .catch(() => null),
    getPeers({ lnd }).then((r) => r.peers).catch(() => []),
    readForwardEvents(lnd, NODE_WINDOW_DAYS, nowMs).catch(() => null),
    getClosedChannels({ lnd }).then((r) => r.channels).catch(() => []),
    getWalletInfo({ lnd }).catch(() => null),
    getOwnPubkey(lnd).catch(() => ""),
  ]);

  const height = info?.current_block_height ?? 0;
  const torOnly = !(info?.uris ?? []).some((u) => !u.includes(".onion"));

  let network: NodeNetwork | null = null;
  const theirPolicy = new Map<string, ChannelPolicy>();
  if (node && (node.alias || node.sockets.length > 0 || node.channel_count > 0)) {
    const nodeChannels = node.channels ?? [];
    const itsPolicies = nodeChannels.flatMap((c) => c.policies.filter((p) => p.public_key === pubkey));
    const enabled = itsPolicies.filter((p) => p.is_disabled === false);
    const sockets = node.sockets.map((s) => s.socket);
    const ids = new Set(src.channelIds);
    for (const c of nodeChannels) {
      if (!ids.has(c.id)) continue;
      const p = c.policies.find((x) => x.public_key === pubkey);
      if (p) theirPolicy.set(c.id, p);
    }
    network = {
      channels: node.channel_count,
      capacitySats: node.capacity,
      avgChannelSats: node.channel_count > 0 ? Math.round(node.capacity / node.channel_count) : 0,
      typicalFeePpm: median(enabled.flatMap((p) => (p.fee_rate === undefined ? [] : [p.fee_rate]))),
      enabledChannels: enabled.length,
      addresses: dialOrder(sockets, torOnly),
      hasClearnet: sockets.some((s) => !s.includes(".onion")),
      hasOnion: sockets.some((s) => s.includes(".onion")),
      lastAnnouncedAt: node.updated_at ?? null,
    };
  }

  const peer = peers.find((p) => p.public_key === pubkey);
  const connection: NodeConnection | null = peer
    ? {
        socket: peer.socket,
        inbound: peer.is_inbound,
        pingMs: peer.ping_time,
        connectedSince: peer.last_reconnection ?? null,
        sentBytes: peer.bytes_sent,
        receivedBytes: peer.bytes_received,
      }
    : null;

  const ids = new Set(src.channelIds);
  const flows = perChannel(forwards?.events ?? [], ids);
  const since = nowMs - NODE_WINDOW_DAYS * DAY_MS;
  const channelFacts = src.channelIds.map((channelId): NodeChannelFacts => {
    const f = flows.get(channelId);
    const refills = src.refills.filter((r) => r.targetId === channelId && !(Date.parse(r.at) < since));
    const p = theirPolicy.get(channelId);
    return {
      channelId,
      ageDays: scidAgeDays(channelId, height),
      forwardsOut: f?.forwardsOut ?? 0,
      routedOutSats: f?.routedOutSats ?? 0,
      earnedSats: Math.round((f?.earnedMsat ?? 0) / 1000),
      forwardsIn: f?.forwardsIn ?? 0,
      routedInSats: f?.routedInSats ?? 0,
      broughtInSats: Math.round((f?.broughtInMsat ?? 0) / 1000),
      refills: refills.length,
      refillSats: refills.reduce((sum, r) => sum + r.amountSats, 0),
      refillFeeSats: refills.reduce((sum, r) => sum + (r.feeSats ?? 0), 0),
      theirFeePpm: p?.fee_rate ?? null,
      theirBaseFeeMsat: p?.base_fee_mtokens !== undefined ? Number(p.base_fee_mtokens) : null,
      theirDisabled: p?.is_disabled ?? null,
      theirTimeLock: p?.cltv_delta ?? null,
    };
  });

  const closedWithIt = closed.filter((c) => c.partner_public_key === pubkey && !c.is_funding_cancel);
  // The channels gone too: what happened on them is still this node's story.
  const everIds = new Set([...ids, ...closedWithIt.flatMap((c) => (c.id ? [c.id] : []))]);
  const named = (alias: string | undefined) => !!src.closingAlias && alias === src.closingAlias;
  const events: NodeEvent[] = [
    ...src.feeChanges
      .filter((r) => everIds.has(r.channelId) || named(r.alias))
      .map((r): NodeEvent => ({ kind: "fee", at: r.at, channelId: r.channelId, fromPpm: r.fromPpm, toPpm: r.toPpm, via: r.via, why: r.why ?? null })),
    ...src.refills.flatMap((r): NodeEvent[] => {
      const into = everIds.has(r.targetId) || named(r.targetAlias);
      if (!into && !everIds.has(r.sourceId) && !named(r.sourceAlias)) return [];
      return [
        {
          kind: "refill",
          at: r.at,
          channelId: into ? r.targetId : r.sourceId,
          direction: into ? "in" : "out",
          amountSats: r.amountSats,
          feeSats: r.feeSats,
          via: r.via,
        },
      ];
    }),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const closedChannels = closedWithIt
    .map(
      (c): NodeClosedChannel => ({
        id: c.id ?? null,
        capacitySats: c.capacity,
        closedDaysAgo: c.close_confirm_height && height ? Math.max(0, Math.floor((height - c.close_confirm_height) / 144)) : null,
        how: closedHow(c),
        finalLocalSats: Number.isFinite(c.final_local_balance) ? c.final_local_balance : null,
      }),
    )
    .sort((a, b) => (a.closedDaysAgo ?? Infinity) - (b.closedDaysAgo ?? Infinity));

  return {
    pubkey,
    alias: node?.alias?.trim() || `${pubkey.slice(0, 12)}…`,
    isSelf: pubkey === own,
    network,
    connection,
    channelFacts,
    forwardsKnown: forwards !== null && forwards.complete,
    events: events.slice(0, EVENTS_MAX),
    eventsMore: Math.max(0, events.length - EVENTS_MAX),
    closedChannels,
    windowDays: NODE_WINDOW_DAYS,
  };
}

/** One node found in the graph. */
export interface NodeSearchHit {
  pubkey: string;
  alias: string;
  channels: number;
  capacitySats: number;
  hasClearnet: boolean;
  /** You have a channel with it. */
  isPeer: boolean;
}

/** At most this many hits come back: the best first. */
export const NODE_SEARCH_MAX = 20;

/**
 * Nodes matching what was typed: part of an alias (case ignored), or the
 * start of a public key (`key@host:port` counts as its key). An exact match
 * first, then the start of an alias, then the rest; the biggest first within
 * each. A full key the graph doesn't have is still a hit: it can be looked at,
 * and opened to.
 */
export function searchGraph(graph: Pick<GraphCache, "meta" | "stats">, peers: ReadonlySet<string>, typed: string): NodeSearchHit[] {
  const q = typed.trim().toLowerCase().split("@")[0];
  if (q.length === 0) return [];
  const isKeyStart = q.length >= 6 && /^[0-9a-f]+$/.test(q);
  const scored: { hit: NodeSearchHit; rank: number }[] = [];
  for (const [pubkey, meta] of graph.meta) {
    const alias = meta.alias.toLowerCase();
    const rank = pubkey === q || alias === q ? 0 : isKeyStart && pubkey.startsWith(q) ? 1 : alias.startsWith(q) ? 1 : alias.includes(q) ? 2 : -1;
    if (rank < 0) continue;
    const stat = graph.stats.get(pubkey);
    scored.push({
      rank,
      hit: {
        pubkey,
        alias: meta.alias,
        channels: stat?.degree ?? 0,
        capacitySats: stat?.totalCapacity ?? 0,
        hasClearnet: meta.hasClearnet,
        isPeer: peers.has(pubkey),
      },
    });
  }
  const hits = scored
    .sort((a, b) => a.rank - b.rank || b.hit.capacitySats - a.hit.capacitySats || a.hit.pubkey.localeCompare(b.hit.pubkey))
    .slice(0, NODE_SEARCH_MAX)
    .map((s) => s.hit);
  if (hits.length === 0 && /^[0-9a-f]{66}$/.test(q)) {
    hits.push({ pubkey: q, alias: `${q.slice(0, 12)}…`, channels: 0, capacitySats: 0, hasClearnet: false, isPeer: peers.has(q) });
  }
  return hits;
}
