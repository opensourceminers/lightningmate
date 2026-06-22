import { getNetworkGraph, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";

/**
 * Channel peer suggestions, computed locally from the LND network graph (no
 * external service). For each candidate node we score connectivity, capacity,
 * activity, reachability and fees, exclude our existing peers, and recommend a
 * channel size scaled to both our node and the candidate.
 */
export interface SuggestionPolicy {
  count: number;
  minChannels: number;
  maxStaleDays: number;
  minSizeSats: number;
  maxSizeSats: number;
  requireClearnet: boolean;
}

export const DEFAULT_SUGGESTION_POLICY: SuggestionPolicy = {
  count: 12,
  minChannels: 8,
  maxStaleDays: 21,
  minSizeSats: 1_000_000,
  maxSizeSats: 10_000_000,
  requireClearnet: false,
};

export interface ChannelSuggestion {
  pubkey: string;
  alias: string;
  channels: number;
  capacitySats: number;
  avgFeePpm: number;
  hasClearnet: boolean;
  lastSeenDays: number;
  /** New destinations this channel opens (peers not already within your 2 hops). */
  newReach: number;
  score: number;
  recommendedSizeSats: number;
  reason: string;
  /** Best known address to connect to (clearnet preferred), or "" if none. */
  socket: string;
}

interface NodeStat {
  degree: number;
  totalCapacity: number;
  feeSum: number;
  feeCount: number;
  /** Channels whose policy this node refreshed recently (active router). */
  recentUpdates: number;
  /** Channels where this node's policy is enabled (not disabled). */
  enabledCount: number;
  /** Pubkeys this node has a channel with (adjacency, for reach scoring). */
  neighbors: Set<string>;
}
interface NodeMeta {
  alias: string;
  hasClearnet: boolean;
  updatedAt: number;
  socket: string;
}

interface GraphCache {
  at: number;
  stats: Map<string, NodeStat>;
  meta: Map<string, NodeMeta>;
}

const GRAPH_TTL_MS = 30 * 60_000;
let cache: GraphCache | undefined;

function isClearnet(socket: string): boolean {
  return !socket.includes(".onion");
}

/** Pull + aggregate the network graph (cached — it's a heavy call). */
async function buildGraphCache(lnd: AuthenticatedLnd): Promise<GraphCache> {
  if (cache && Date.now() - cache.at < GRAPH_TTL_MS) return cache;

  const graph = await getNetworkGraph({ lnd });

  const stats = new Map<string, NodeStat>();
  const freshAfter = Date.now() - 14 * 86_400_000; // "actively maintained" window
  const ensureStat = (pk: string): NodeStat => {
    let s = stats.get(pk);
    if (!s) {
      s = { degree: 0, totalCapacity: 0, feeSum: 0, feeCount: 0, recentUpdates: 0, enabledCount: 0, neighbors: new Set() };
      stats.set(pk, s);
    }
    return s;
  };

  for (const ch of graph.channels) {
    const endpoints = [...new Set(ch.policies.map((p) => p.public_key))];
    for (const pk of endpoints) {
      const s = ensureStat(pk);
      s.degree += 1;
      s.totalCapacity += ch.capacity;
      const pol = ch.policies.find((p) => p.public_key === pk);
      if (pol) {
        if (pol.fee_rate !== undefined) {
          s.feeSum += pol.fee_rate;
          s.feeCount += 1;
        }
        if (pol.is_disabled === false) s.enabledCount += 1;
        if (pol.updated_at && new Date(pol.updated_at).getTime() >= freshAfter) s.recentUpdates += 1;
      }
      // Adjacency: record the channel's other endpoint(s) as neighbors.
      for (const other of endpoints) if (other !== pk) s.neighbors.add(other);
    }
  }

  const meta = new Map<string, NodeMeta>();
  for (const n of graph.nodes) {
    const clearnet = n.sockets.find(isClearnet);
    meta.set(n.public_key, {
      alias: n.alias?.trim() || `${n.public_key.slice(0, 12)}…`,
      hasClearnet: n.sockets.some(isClearnet),
      updatedAt: n.updated_at ? new Date(n.updated_at).getTime() : 0,
      socket: clearnet ?? n.sockets[0] ?? "",
    });
  }

  cache = { at: Date.now(), stats, meta };
  return cache;
}

// ── Close candidates (channels that aren't pulling their weight) ──────────────

export interface CloseCandidate {
  channelId: string;
  alias: string;
  capacitySats: number;
  localRatio: number;
  active: boolean;
  /** Window stats. */
  forwards: number;
  routedSats: number;
  feesEarnedSats: number;
  lifetimeRoutedSats: number;
  transactionId: string;
  transactionVout: number;
  reason: string;
}

/**
 * Channels worth considering for closing: offline peers, channels that never
 * routed, or ones idle for the whole window. Uses routed in+out (not just fees)
 * so inbound "source" channels aren't wrongly flagged. Ranked by idle capital.
 */
export async function getCloseCandidates(
  lnd: AuthenticatedLnd,
  windowDays = 90,
): Promise<{ windowDays: number; candidates: CloseCandidate[] }> {
  const [channels, flows] = await Promise.all([
    getChannelsView(lnd),
    getFlowSummary(lnd, windowDays),
  ]);
  const flowById = new Map(flows.perChannel.map((f) => [f.channelId, f]));

  const candidates: CloseCandidate[] = [];
  for (const c of channels) {
    const f = flowById.get(c.id);
    const routed = (f?.routedOut ?? 0) + (f?.routedIn ?? 0);
    const lifetime = c.totalSent + c.totalReceived;

    let reason: string | null = null;
    if (!c.active) reason = "offline — peer unreachable";
    else if (routed === 0 && lifetime === 0) reason = `never routed · idle ${windowDays}d`;
    else if (routed === 0) reason = `no routing in ${windowDays}d`;
    if (!reason) continue;

    candidates.push({
      channelId: c.id,
      alias: c.peerAlias,
      capacitySats: c.capacity,
      localRatio: c.localRatio,
      active: c.active,
      forwards: f?.forwardCount ?? 0,
      routedSats: routed,
      feesEarnedSats: f?.feesEarned ?? 0,
      lifetimeRoutedSats: lifetime,
      transactionId: c.transactionId,
      transactionVout: c.transactionVout,
      reason,
    });
  }

  // Offline first, then the most idle capital.
  candidates.sort(
    (a, b) => Number(a.active) - Number(b.active) || b.capacitySats - a.capacitySats,
  );
  return { windowDays, candidates };
}

export interface NetworkRank {
  position: number;
  total: number;
  /** 0..1, share of nodes we rank above (by channel count). */
  percentile: number;
  degree: number;
}

/** Our node's rank among all graph nodes by channel count (connectivity). */
export async function getNetworkRank(
  lnd: AuthenticatedLnd,
  ownPubkey: string,
): Promise<NetworkRank | null> {
  const graph = await buildGraphCache(lnd);
  const mine = graph.stats.get(ownPubkey);
  if (!mine) return null;

  let higher = 0;
  for (const [, s] of graph.stats) if (s.degree > mine.degree) higher += 1;

  const total = graph.stats.size;
  const position = higher + 1;
  return {
    position,
    total,
    percentile: total > 0 ? 1 - position / total : 0,
    degree: mine.degree,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function roundTo100k(n: number): number {
  return Math.round(n / 100_000) * 100_000;
}

export async function getChannelSuggestions(
  lnd: AuthenticatedLnd,
  overrides: Partial<SuggestionPolicy> = {},
): Promise<{ policy: SuggestionPolicy; suggestions: ChannelSuggestion[]; graphAgeSec: number }> {
  const policy = { ...DEFAULT_SUGGESTION_POLICY, ...overrides };

  const [graph, channels, ownKey] = await Promise.all([
    buildGraphCache(lnd),
    getChannelsView(lnd),
    getOwnPubkey(lnd),
  ]);

  // Our situation: who we're already connected to, and our typical channel size.
  const peers = new Set(channels.map((c) => c.peerPubkey));
  const ourMedianChan = median(channels.map((c) => c.capacity)) || 2_000_000;

  // Everything we can already reach within two hops — a new channel only buys
  // us connectivity to nodes OUTSIDE this set.
  const reachable = new Set<string>([ownKey, ...peers]);
  for (const peer of peers) {
    const ps = graph.stats.get(peer);
    if (ps) for (const n of ps.neighbors) reachable.add(n);
  }

  const now = Date.now();
  const staleMs = policy.maxStaleDays * 86_400_000;

  // Build the eligible candidate set.
  const eligible: { pk: string; stat: NodeStat; meta: NodeMeta }[] = [];
  for (const [pk, stat] of graph.stats) {
    if (pk === ownKey || peers.has(pk)) continue;
    if (stat.degree < policy.minChannels) continue;
    if (stat.enabledCount === 0) continue; // fully disabled — nothing routes through it
    const meta = graph.meta.get(pk);
    if (!meta) continue;
    if (now - meta.updatedAt > staleMs) continue;
    if (policy.requireClearnet && !meta.hasClearnet) continue;
    eligible.push({ pk, stat, meta });
  }

  if (eligible.length === 0) {
    return { policy, suggestions: [], graphAgeSec: Math.round((now - graph.at) / 1000) };
  }

  // New-reach: how many of each candidate's neighbours we can't already reach.
  const reachByPk = new Map<string, number>();
  for (const e of eligible) {
    let c = 0;
    for (const n of e.stat.neighbors) if (!reachable.has(n)) c += 1;
    reachByPk.set(e.pk, c);
  }

  // Normalisation bound for liquidity depth (log-scaled — heavy-tailed).
  const avgChanOf = (s: NodeStat) => (s.degree ? s.totalCapacity / s.degree : 0);
  const maxLogDepth = Math.max(...eligible.map((e) => Math.log(avgChanOf(e.stat) + 1)));

  const suggestions: ChannelSuggestion[] = eligible.map(({ pk, stat, meta }) => {
    const avgFee = stat.feeCount ? stat.feeSum / stat.feeCount : 0;
    const newReach = reachByPk.get(pk) ?? 0;

    // Reach into NEW territory — rewards both non-redundancy (the share of the
    // peer's neighbours that are new to us) and a meaningful absolute count, so a
    // giant hub that mostly duplicates our existing reach can't win on size alone.
    const novelty = stat.degree ? newReach / stat.degree : 0;
    const magnitude = Math.min(1, newReach / 30);
    const reachScore = Math.sqrt(novelty * magnitude);

    // A live, maintained router: fresh policies + channels that are enabled.
    const activityShare = stat.degree ? stat.recentUpdates / stat.degree : 0;
    const enabledShare = stat.degree ? stat.enabledCount / stat.degree : 0;
    const routerScore = 0.5 * Math.min(1, activityShare) + 0.5 * Math.min(1, enabledShare);

    // Liquidity depth per channel — real routing capacity, not dust.
    const depthScore = Math.log(avgChanOf(stat) + 1) / maxLogDepth;

    // Connectivity sweet-spot: enough channels to route, but dampen the
    // over-saturated mega-hubs everyone already connects to.
    const enough = Math.min(1, Math.log(stat.degree) / Math.log(30));
    const oversat = Math.max(
      0,
      (Math.log(stat.degree) - Math.log(250)) / (Math.log(4000) - Math.log(250)),
    );
    const centralityScore = enough * (1 - 0.6 * Math.min(1, oversat));

    // Fee economics: moderate fees route and leave room to earn; 0 ppm is a hub
    // dumping flow, and >2000 ppm barely routes.
    const feeScore =
      avgFee <= 0 ? 0.4 : avgFee < 10 ? 0.65 : avgFee <= 600 ? 1 : avgFee <= 2000 ? 0.6 : 0.2;

    const score =
      0.3 * reachScore +
      0.25 * routerScore +
      0.15 * depthScore +
      0.15 * centralityScore +
      0.15 * feeScore;

    // Size: geometric mean of our typical channel and the candidate's average,
    // clamped to the configured bounds.
    const candidateAvgChan = avgChanOf(stat) || ourMedianChan;
    const size = roundTo100k(Math.sqrt(ourMedianChan * candidateAvgChan));
    const recommendedSizeSats = Math.min(policy.maxSizeSats, Math.max(policy.minSizeSats, size));

    return {
      pubkey: pk,
      alias: meta.alias,
      channels: stat.degree,
      capacitySats: stat.totalCapacity,
      avgFeePpm: Math.round(avgFee),
      hasClearnet: meta.hasClearnet,
      lastSeenDays: Math.round((now - meta.updatedAt) / 86_400_000),
      newReach,
      score: Math.round(score * 100),
      recommendedSizeSats,
      reason: reasonFor(stat, meta, avgFee, newReach),
      socket: meta.socket,
    };
  });

  suggestions.sort((a, b) => b.score - a.score);

  return {
    policy,
    suggestions: suggestions.slice(0, policy.count),
    graphAgeSec: Math.round((now - graph.at) / 1000),
  };
}

function reasonFor(stat: NodeStat, meta: NodeMeta, avgFee: number, newReach: number): string {
  const btc = (stat.totalCapacity / 100_000_000).toFixed(1);
  const parts: string[] = [];
  if (newReach > 0) parts.push(`opens ${newReach} new destination${newReach === 1 ? "" : "s"}`);
  parts.push(`${stat.degree} channels`, `${btc} BTC`);
  if (stat.degree && stat.recentUpdates / stat.degree >= 0.5) parts.push("actively routing");
  if (meta.hasClearnet) parts.push("clearnet");
  if (avgFee <= 100) parts.push("low fees");
  return parts.join(" · ");
}
