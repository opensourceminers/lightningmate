import { getNetworkGraph, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
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
  for (const ch of graph.channels) {
    const endpoints = new Set(ch.policies.map((p) => p.public_key));
    for (const pk of endpoints) {
      let s = stats.get(pk);
      if (!s) {
        s = { degree: 0, totalCapacity: 0, feeSum: 0, feeCount: 0 };
        stats.set(pk, s);
      }
      s.degree += 1;
      s.totalCapacity += ch.capacity;
      const pol = ch.policies.find((p) => p.public_key === pk);
      if (pol?.fee_rate !== undefined) {
        s.feeSum += pol.fee_rate;
        s.feeCount += 1;
      }
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

  const now = Date.now();
  const staleMs = policy.maxStaleDays * 86_400_000;

  // Build the eligible candidate set.
  const eligible: { pk: string; stat: NodeStat; meta: NodeMeta }[] = [];
  for (const [pk, stat] of graph.stats) {
    if (pk === ownKey || peers.has(pk)) continue;
    if (stat.degree < policy.minChannels) continue;
    const meta = graph.meta.get(pk);
    if (!meta) continue;
    if (now - meta.updatedAt > staleMs) continue;
    if (policy.requireClearnet && !meta.hasClearnet) continue;
    eligible.push({ pk, stat, meta });
  }

  if (eligible.length === 0) {
    return { policy, suggestions: [], graphAgeSec: Math.round((now - graph.at) / 1000) };
  }

  // Normalisation bounds (log-scaled — degree & capacity are heavy-tailed).
  const maxLogDeg = Math.max(...eligible.map((e) => Math.log(e.stat.degree + 1)));
  const maxLogCap = Math.max(...eligible.map((e) => Math.log(e.stat.totalCapacity + 1)));
  const maxFee = Math.max(...eligible.map((e) => (e.stat.feeCount ? e.stat.feeSum / e.stat.feeCount : 0)), 1);

  const suggestions: ChannelSuggestion[] = eligible.map(({ pk, stat, meta }) => {
    const avgFee = stat.feeCount ? stat.feeSum / stat.feeCount : 0;
    const degScore = Math.log(stat.degree + 1) / maxLogDeg;
    const capScore = Math.log(stat.totalCapacity + 1) / maxLogCap;
    const ageDays = (now - meta.updatedAt) / 86_400_000;
    const recencyScore = Math.max(0, 1 - ageDays / policy.maxStaleDays);
    const reachScore = meta.hasClearnet ? 1 : 0.5;
    const feeScore = 1 - Math.min(1, avgFee / maxFee);

    const score =
      0.4 * degScore + 0.3 * capScore + 0.15 * recencyScore + 0.1 * reachScore + 0.05 * feeScore;

    // Size: geometric mean of our typical channel and the candidate's average,
    // clamped to the configured bounds.
    const candidateAvgChan = stat.degree ? stat.totalCapacity / stat.degree : ourMedianChan;
    const size = roundTo100k(Math.sqrt(ourMedianChan * candidateAvgChan));
    const recommendedSizeSats = Math.min(policy.maxSizeSats, Math.max(policy.minSizeSats, size));

    return {
      pubkey: pk,
      alias: meta.alias,
      channels: stat.degree,
      capacitySats: stat.totalCapacity,
      avgFeePpm: Math.round(avgFee),
      hasClearnet: meta.hasClearnet,
      lastSeenDays: Math.round(ageDays),
      score: Math.round(score * 100),
      recommendedSizeSats,
      reason: reasonFor(stat, meta, avgFee),
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

function reasonFor(stat: NodeStat, meta: NodeMeta, avgFee: number): string {
  const btc = (stat.totalCapacity / 100_000_000).toFixed(1);
  const parts = [`${stat.degree} channels`, `${btc} BTC capacity`];
  if (meta.hasClearnet) parts.push("clearnet");
  if (avgFee <= 100) parts.push("low fees");
  return `well-connected hub — ${parts.join(", ")}`;
}
