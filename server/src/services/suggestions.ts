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
  /** New destinations this channel opens (peers not already within your 2 hops). */
  newReach: number;
  score: number;
  recommendedSizeSats: number;
  reason: string;
  /** Best known address to connect to (clearnet preferred), or "" if none. */
  socket: string;
}

export interface NodeStat {
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
export interface NodeMeta {
  alias: string;
  hasClearnet: boolean;
  updatedAt: number;
  socket: string;
}

export interface GraphCache {
  at: number;
  stats: Map<string, NodeStat>;
  meta: Map<string, NodeMeta>;
  /** Per node P: what OTHER nodes charge to forward into P, as interleaved
   *  [fee ppm, channel capacity, …] pairs (this node's own policies left
   *  out) — the market price of reaching P (peerMarketFees). */
  into: Map<string, number[]>;
  /** Per channel of this node: the peer's own fee for forwarding to us over
   *  it (ppm) — the last hop of any refill of that channel. */
  peerFeeToUs: Map<string, number>;
}

/** A graph younger than this is served as it is. */
export const GRAPH_TTL_MS = 30 * 60_000;
/**
 * An older one is still served — at once — while a fresh read runs in the
 * background, up to this age (stale-while-revalidate). Before, a cache past
 * its 30 minutes was dropped and the caller waited for a new read: on a small
 * machine that takes longer than the fee engine's MARKET_WAIT_MS, and the
 * autopilot runs every 30 minutes — so every other run priced without the
 * market, and market-priced fees flapped (80→50→70→40…, 28 updates in 60
 * days). The graph moves slowly; a few hours old is still today's market.
 */
export const GRAPH_STALE_MAX_MS = 12 * 3_600_000;
/**
 * The longest one graph read is waited for (review 3). LND's DescribeGraph
 * has no deadline of its own, and every caller shares the read under way: a
 * call that never answered stayed "under way" for good — no fresh read was
 * ever started again, every caller after the 12 h of stale serving waited on
 * it, and the autopilot's channel stage (which waits for the graph with no
 * bound of its own) held the run's lock: no fee runs, the lease keeper
 * skipped, a manual Apply answered 409 until a restart. Past this, the read
 * is given up — its waiters get an error, the next caller starts a new one,
 * and a graph younger than GRAPH_STALE_MAX_MS keeps being served meanwhile.
 * (A read that answers after all still fills the cache.)
 */
export const GRAPH_READ_DEADLINE_MS = 10 * 60_000;
/** A policy nobody refreshed for this long says little about today's price. */
const MARKET_FRESH_MS = 30 * 86_400_000;
/** Per LND connection (tests run several fake nodes in one process). */
const caches = new WeakMap<AuthenticatedLnd, GraphCache>();
/** The graph read under way, per connection: the fee engine, the rebalance
 *  recommender and the peer suggestions ask at once — one read serves all. */
const building = new WeakMap<AuthenticatedLnd, Promise<GraphCache>>();

function isClearnet(socket: string): boolean {
  return !socket.includes(".onion");
}

/** The graph read under way for `lnd`, or a new one — given up after
 *  GRAPH_READ_DEADLINE_MS. */
function readOnce(lnd: AuthenticatedLnd): Promise<GraphCache> {
  const running = building.get(lnd);
  if (running) return running;
  const read: Promise<GraphCache> = new Promise<GraphCache>((resolve, reject) => {
    // No longer "under way" from the moment it settles or is given up — no
    // caller after that is handed it. (Only its own entry: a read given up
    // must not end the one started after it.)
    const done = () => {
      clearTimeout(timer);
      if (building.get(lnd) === read) building.delete(lnd);
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`the network graph read took longer than ${GRAPH_READ_DEADLINE_MS / 60_000} minutes`));
    }, GRAPH_READ_DEADLINE_MS);
    timer.unref?.();
    readGraph(lnd).then(
      (graph) => {
        done();
        resolve(graph);
      },
      (err: unknown) => {
        done();
        reject(err);
      },
    );
  });
  building.set(lnd, read);
  return read;
}

/**
 * Pull + aggregate the network graph (cached — it's a heavy call). Fresh
 * (under GRAPH_TTL_MS): served. Older, up to GRAPH_STALE_MAX_MS: served at
 * once while a new read runs in the background (a failed one leaves the old
 * graph in place). Older still, or none yet: the caller waits for the read.
 */
export async function buildGraphCache(lnd: AuthenticatedLnd): Promise<GraphCache> {
  const cache = caches.get(lnd);
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && age < GRAPH_TTL_MS) return cache;
  const read = readOnce(lnd);
  if (cache && age < GRAPH_STALE_MAX_MS) {
    // Nobody awaits this read: its failure must not surface as an unhandled
    // rejection (the next caller simply starts another one).
    read.catch(() => undefined);
    return cache;
  }
  return read;
}

async function readGraph(lnd: AuthenticatedLnd): Promise<GraphCache> {
  const [graph, own] = await Promise.all([getNetworkGraph({ lnd }), getOwnPubkey(lnd).catch(() => "")]);

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

  const into = new Map<string, number[]>();
  const peerFeeToUs = new Map<string, number>();
  const marketAfter = Date.now() - MARKET_FRESH_MS;
  for (const ch of graph.channels) {
    // The market into each endpoint: the OTHER endpoint's policy is what it
    // charges to forward into this one. Disabled and long-stale policies
    // aren't a price anyone pays; this node's own aren't "the market".
    if (ch.policies.length === 2) {
      for (const [from, to] of [ch.policies, [...ch.policies].reverse()]) {
        if (from.public_key === own) continue;
        if (to.public_key === own) {
          // The peer's fee toward us on our own channel.
          if (from.fee_rate !== undefined) peerFeeToUs.set(ch.id, from.fee_rate);
          continue;
        }
        if (from.fee_rate === undefined || from.is_disabled === true) continue;
        if (!from.updated_at || new Date(from.updated_at).getTime() < marketAfter) continue;
        let list = into.get(to.public_key);
        if (!list) into.set(to.public_key, (list = []));
        list.push(Math.min(from.fee_rate, 50_000), ch.capacity);
      }
    }
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

  const built: GraphCache = { at: Date.now(), stats, meta, into, peerFeeToUs };
  caches.set(lnd, built);
  return built;
}

/** What reaching a peer costs on the network (blind-price-discovery). */
export interface MarketRef {
  /** Capacity-weighted median fee other nodes charge to forward into the
   *  peer (ppm). */
  intoPeerPpm: number;
  /** How many channels into the peer that is the median of. */
  samples: number;
  /** The peer's own fee for forwarding back to us on this channel, ppm
   *  (null: not in the graph). */
  peerFeeToUsPpm: number | null;
}

/** Fewer channels into a peer than this: no market reference (too thin). */
export const MARKET_MIN_CHANNELS = 3;

/** Capacity-weighted median of interleaved [fee, capacity] pairs. */
export function weightedMedianFee(pairs: number[]): number | null {
  const rows: { fee: number; cap: number }[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) rows.push({ fee: pairs[i], cap: Math.max(1, pairs[i + 1]) });
  if (!rows.length) return null;
  rows.sort((a, b) => a.fee - b.fee);
  const half = rows.reduce((s, r) => s + r.cap, 0) / 2;
  let acc = 0;
  for (const r of rows) {
    acc += r.cap;
    if (acc >= half) return r.fee;
  }
  return rows[rows.length - 1].fee;
}

/**
 * The market reference for each of this node's channels, from the public
 * graph (no paid service, nothing sent anywhere): what other nodes charge to
 * forward into the same peer, and what the peer charges to forward back to
 * us. Empty when the graph can't be read — the fee engine then prices as it
 * did without one.
 */
export async function peerMarketFees(
  lnd: AuthenticatedLnd,
  channels: { id: string; peerPubkey: string }[],
): Promise<Map<string, MarketRef>> {
  const out = new Map<string, MarketRef>();
  let graph: GraphCache;
  try {
    graph = await buildGraphCache(lnd);
  } catch {
    return out;
  }
  for (const ch of channels) {
    const pairs = graph.into.get(ch.peerPubkey) ?? [];
    if (pairs.length / 2 < MARKET_MIN_CHANNELS) continue;
    const median = weightedMedianFee(pairs);
    if (median === null) continue;
    out.set(ch.id, { intoPeerPpm: median, samples: pairs.length / 2, peerFeeToUsPpm: graph.peerFeeToUs.get(ch.id) ?? null });
  }
  return out;
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
