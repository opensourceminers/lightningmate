import { getClosedChannels, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { getChannelsView, type ChannelView } from "./channels.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { getFeeRecommendations, type FeeRecConfig, type FeeRecState, type FeeRecommendation } from "./feeRecommend.js";
import { channelLeases, leaseProtection, type ChannelLease, type LeaseSources } from "./leases.js";
import { OFFLINE_CLOSE_SIGNAL_HOURS, UPTIME_WINDOW_MS, offlineText, type ChannelUptime, type OfflineInfo } from "./channelUptime.js";
import { onchainCosts } from "./nodeEconomics.js";
import type { RebalanceRecord } from "./rebalanceLog.js";
import type { OverrideMap } from "./overrides.js";
import {
  buildGraphCache,
  DEFAULT_SUGGESTION_POLICY,
  type NodeMeta,
  type NodeStat,
  type SuggestionPolicy,
} from "./suggestions.js";
import type { LnPlusNode } from "./lnplus.js";
import type { LnPlusStore } from "./lnplusStore.js";

/**
 * Channel Suggestions v2 — demand-aware, quality-weighted, portfolio-aware.
 *
 * Builds on the existing topological graph score but makes the call we actually
 * care about: "would a channel to this peer earn *your* node money?" — by
 * weighting candidates against where your own forwards already flow ("missing
 * links"), the quality (not just count) of the new reach they open, your node's
 * current need, and how much they diversify the portfolio you'd be building.
 *
 * 100% local: LND network graph + your own forwarding history. No external
 * service, no ML, no payment simulation. If you have no forwards yet, it
 * gracefully falls back to the pure graph score.
 */

export interface SuggestV2Config extends SuggestionPolicy {
  /** Window for the demand signal (your forwards). */
  demandWindowDays: number;
  /** How hard to penalise a candidate whose new reach overlaps already-picked ones. */
  diversityPenaltyWeight: number;
  /** Most LN+ profile fetches one suggestion run may spend (LN+ allows 100/24h). */
  lnplusFetchBudget: number;
}

export const SUGGEST_V2_DEFAULTS: SuggestV2Config = {
  ...DEFAULT_SUGGESTION_POLICY,
  demandWindowDays: 30,
  diversityPenaltyWeight: 0.35,
  lnplusFetchBudget: 12,
};

export type NodeNeed =
  | "need_inbound"
  | "need_outbound"
  | "need_routing_diversity"
  | "need_revenue"
  | "balanced";

/**
 * Our node's current need, inferred honestly from our own balance + revenue.
 *
 * A channel's localRatio is its OUTBOUND share (channels.ts). So a node with
 * ≤ 30 % of its liquidity local can send and route out little — it is short
 * of OUTBOUND, which is exactly what a channel it opens adds. A node with
 * ≥ 70 % local is short of INBOUND: channels it opens add only more outbound;
 * inbound comes from peers opening to it, Magma Buy or LN+ swaps. (Before,
 * the two were swapped: an inbound-rich node read "you need inbound — new
 * opens give outbound" on every suggestion, and Magma told it to buy inbound
 * and not to lease.)
 */
export function computeNodeNeed(
  channels: ChannelView[],
  revenueWindowSats: number,
  windowDays: number,
): { nodeNeed: NodeNeed; reason: string; localPct: number } {
  const totalCap = channels.reduce((s, c) => s + c.capacity, 0) || 1;
  const localSats = channels.reduce((s, c) => s + c.localRatio * c.capacity, 0);
  const myLocalRatio = localSats / totalCap;
  const localPct = Math.round(myLocalRatio * 100);
  const revenuePerChannel = channels.length ? revenueWindowSats / channels.length : 0;
  if (channels.length < 5)
    return { nodeNeed: "need_routing_diversity", localPct, reason: `only ${channels.length} channel${channels.length === 1 ? "" : "s"} — broaden into new clusters first` };
  if (myLocalRatio >= 0.7)
    return {
      nodeNeed: "need_inbound",
      localPct,
      reason:
        `${localPct}% of your liquidity is local (outbound) — the node is short of inbound: channels you open add outbound only; ` +
        "inbound comes from peers opening to you, Magma Buy or LN+ swaps",
    };
  if (myLocalRatio <= 0.3)
    return {
      nodeNeed: "need_outbound",
      localPct,
      reason: `only ${localPct}% of your liquidity is local — the node is short of outbound: channels you open add exactly that, so open toward peers that pull flow`,
    };
  if (revenuePerChannel < 50)
    return { nodeNeed: "need_revenue", localPct, reason: `low earnings per channel (${Math.round(revenuePerChannel)} sat/${windowDays}d) — chase real demand` };
  return { nodeNeed: "balanced", localPct, reason: "well balanced — grow where you already see demand and into fresh clusters" };
}

/** The caveat every suggestion carries for this need, or null. Only an
 *  outbound-heavy node gets one: what it lacks, an open can't give. */
export function needWarning(need: NodeNeed): string | null {
  return need === "need_inbound"
    ? "Your node is short of inbound — opening this adds outbound only (inbound comes from peers opening to you, Magma Buy or LN+ swaps)."
    : null;
}

export interface SuggestionV2 {
  pubkey: string;
  alias: string;
  /** The first address to dial ("" if the node advertises none). */
  socket: string;
  /** Every advertised address, in the order to dial them: .onion first on a
   *  node that announces no clearnet address of its own (Tor-only), clearnet
   *  first otherwise. Before, only one was ever dialed — clearnet whenever
   *  the peer had one. */
  sockets: string[];
  hasClearnet: boolean;
  channels: number;
  capacitySats: number;
  avgChannelSats: number;
  avgFeePpm: number;
  lastSeenDays: number;

  /** Final 0–100 score after demand, reach, role and diversity. */
  score: number;
  graphScore: number;
  demandScore: number;
  weightedReachScore: number;
  roleFitScore: number;
  economicsScore: number;

  newReach: number;
  weightedNewReach: number;
  qualityReachCount: number;

  demandOverlapCount: number;
  demandFlowSharePct: number;

  portfolioOverlap: number;

  recommendedSizeSats: number;
  sizeReason: string;

  usefulness: "high" | "medium" | "low";
  badges: string[];
  reasons: string[];
  warnings: string[];

  /** LN+ reputation when the peer has a profile there, else null. */
  lnplus: {
    rank: number;
    rankName: string;
    prime: boolean;
    verified: boolean;
    positiveRatings: number;
    negativeRatings: number;
    profileUrl: string;
    /** What the reputation did to the score, in percent (+8 = lifted by 8%). */
    scoreEffectPct: number;
  } | null;
  /** The smallest channel the peer says it accepts (its LN+ account
   *  setting), or null when unknown. Self-declared: LND's own refusal
   *  ("below min chan size of …") is the reliable source (autopilot). */
  peerMinChannelSats: number | null;
  /** This node closed a channel with the peer this many days ago (within
   *  RECENT_CLOSE_DAYS), or null. */
  closedDaysAgo: number | null;
}

/** A peer this node closed a channel with this recently is not proposed for
 *  an automatic open (it says so on the suggestion). */
export const RECENT_CLOSE_DAYS = 90;

/** Every advertised address in the order to dial them (see SuggestionV2.sockets). */
export function dialOrder(sockets: readonly string[], torOnly: boolean): string[] {
  const onion = sockets.filter((x) => x.includes(".onion"));
  const clear = sockets.filter((x) => !x.includes(".onion"));
  return torOnly ? [...onion, ...clear] : [...clear, ...onion];
}

export interface SuggestV2Report {
  policy: SuggestV2Config;
  nodeNeed: NodeNeed;
  nodeNeedReason: string;
  hasDemandData: boolean;
  suggestions: SuggestionV2[];
  graphAgeSec: number;
  /** How much the LN+ reputation pass contributed to this run. */
  lnplus: {
    enabled: boolean;
    /** Shortlisted candidates we have an LN+ answer for (profile or "none"). */
    checked: number;
    /** Of those, how many actually have an LN+ profile. */
    known: number;
    /** True while we are backing off after an LN+ error or rate limit. */
    paused: boolean;
    error: string | null;
  };
  portfolioSummary: {
    selectedCount: number;
    estimatedNewReach: number;
    estimatedWeightedNewReach: number;
    demandCoveragePct: number;
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const roundTo100k = (n: number) => Math.round(n / 100_000) * 100_000;
const avgChanOf = (s: NodeStat) => (s.degree ? s.totalCapacity / s.degree : 0);

/**
 * LN+ reputation as a bounded multiplier on the graph-derived score.
 *
 * Deliberately a MULTIPLIER, not a scoring component: most of the Lightning
 * graph has no LN+ profile, and "not on LN+" must never read as "bad peer". A
 * node without a profile scores exactly as it did before. A node WITH one can
 * move within ±20%, which re-ranks the shortlist without ever overriding the
 * topology and demand evidence that earned a candidate its place.
 *
 * The rating term is confidence-weighted: two positive ratings are an anecdote,
 * fifty are evidence. Below ~10 ratings the sentiment barely moves the number.
 */
export function lnplusTrustMultiplier(n: LnPlusNode | null): number {
  if (!n) return 1;
  const total = n.positiveRatings + n.negativeRatings;
  const approval = total > 0 ? n.positiveRatings / total : 0.5;
  const confidence = Math.min(1, total / 10);
  // -1 (all negative, well evidenced) … +1 (all positive, well evidenced)
  const sentiment = (approval - 0.5) * 2 * confidence;

  let bonus = 0.12 * clamp01(n.rank / 10) + 0.1 * sentiment;
  if (n.prime) bonus += 0.04;
  if (n.verified) bonus += 0.02;
  return 1 + Math.min(0.2, Math.max(-0.15, bonus));
}

/** Smooth fee-reasonableness: sweet spot 1–600 ppm, decaying past that. */
function feeReasonableness(avgFee: number): number {
  if (avgFee <= 0) return 0.6; // 0 ppm: could be a healthy hub, could be spam
  if (avgFee <= 600) return 1;
  if (avgFee <= 2000) return 1 - 0.5 * ((avgFee - 600) / 1400); // 1.0 → 0.5
  if (avgFee <= 3000) return 0.5 - 0.3 * ((avgFee - 2000) / 1000); // 0.5 → 0.2
  return 0.2;
}

export async function getChannelSuggestionsV2(
  lnd: AuthenticatedLnd,
  overrides: Partial<SuggestV2Config> = {},
  /** Optional LN+ reputation source. Omit it and scoring is exactly as before. */
  lnplus?: LnPlusStore,
): Promise<SuggestV2Report> {
  const policy = { ...SUGGEST_V2_DEFAULTS, ...overrides };

  const [graph, channels, ownKey, flow, info, closed] = await Promise.all([
    buildGraphCache(lnd),
    getChannelsView(lnd),
    getOwnPubkey(lnd),
    getFlowSummary(lnd, policy.demandWindowDays).catch(() => null),
    getWalletInfo({ lnd }).catch(() => null),
    getClosedChannels({ lnd })
      .then((r) => r.channels)
      .catch(() => []),
  ]);
  // A node that announces no clearnet address of its own dials over Tor:
  // a peer's .onion first (no exit node in between).
  const torOnly = !(info?.uris ?? []).some((u) => !u.includes(".onion"));
  // The most recent close with each peer (blocks ago → days). A close with
  // no confirmation height (a funding that never confirmed) can't be dated:
  // it doesn't count — or a years-old one would bar the peer for good.
  const height = info?.current_block_height ?? 0;
  const closedDays = new Map<string, number>();
  for (const c of closed) {
    if (!c.close_confirm_height || !height) continue;
    const days = Math.max(0, Math.floor((height - c.close_confirm_height) / 144));
    if (days <= RECENT_CLOSE_DAYS && days < (closedDays.get(c.partner_public_key) ?? Infinity)) closedDays.set(c.partner_public_key, days);
  }

  const now = Date.now();
  const peers = new Set(channels.map((c) => c.peerPubkey));
  const ourMedianChan = median(channels.map((c) => c.capacity)) || 2_000_000;

  // Everything we already reach within two hops — a new channel only buys reach
  // to nodes OUTSIDE this set.
  const reachable = new Set<string>([ownKey, ...peers]);
  for (const peer of peers) {
    const ps = graph.stats.get(peer);
    if (ps) for (const n of ps.neighbors) reachable.add(n);
  }

  // ── Our node's current need (honest, from our own data) ─────────────────────
  const revenue = flow?.totalFeesEarnedSats ?? 0;
  const { nodeNeed, reason: nodeNeedReason } = computeNodeNeed(channels, revenue, policy.demandWindowDays);

  // ── Demand map: where does our own outbound flow actually go? ────────────────
  // We can only see which of OUR channels a forward left through (LND gives the
  // outgoing channel, not the destination). So we weight each peer by the volume
  // we route toward it, then project that weight onto the peer's graph
  // neighbourhood — the cluster our flow serves. A candidate adjacent to those
  // nodes is a "missing link": a more direct path to where we already route.
  const pubByChannelId = new Map(channels.map((c) => [c.id, c.peerPubkey]));
  const peerWeights: { pubkey: string; weight: number }[] = [];
  let totalDemand = 0;
  for (const f of flow?.perChannel ?? []) {
    const pk = pubByChannelId.get(f.channelId);
    if (!pk) continue;
    // Volume routed OUT toward this peer, tilted by what it actually earned.
    const weight = f.routedOut + 6 * f.feesEarned;
    if (weight <= 0) continue;
    peerWeights.push({ pubkey: pk, weight });
    totalDemand += weight;
  }
  const hasDemandData = totalDemand > 0;

  // demandWeight[node] = total flow-weight of our peers whose neighbourhood (or
  // the peer itself) includes this node. peerTags[node] = which peer-indices.
  const demandWeight = new Map<string, number>();
  const peerTags = new Map<string, Set<number>>();
  peerWeights.forEach(({ pubkey, weight }, i) => {
    const tag = (node: string) => {
      demandWeight.set(node, (demandWeight.get(node) ?? 0) + weight);
      let s = peerTags.get(node);
      if (!s) peerTags.set(node, (s = new Set()));
      s.add(i);
    };
    tag(pubkey);
    const ps = graph.stats.get(pubkey);
    if (ps) for (const n of ps.neighbors) tag(n);
  });

  // ── Eligible candidates (same filters as v1) ────────────────────────────────
  const staleMs = policy.maxStaleDays * 86_400_000;
  const eligible: { pk: string; stat: NodeStat; meta: NodeMeta }[] = [];
  for (const [pk, stat] of graph.stats) {
    if (pk === ownKey || peers.has(pk)) continue;
    if (stat.degree < policy.minChannels) continue;
    if (stat.enabledCount === 0) continue;
    const meta = graph.meta.get(pk);
    if (!meta) continue;
    if (now - meta.updatedAt > staleMs) continue;
    if (policy.requireClearnet && !meta.hasClearnet) continue;
    eligible.push({ pk, stat, meta });
  }

  if (eligible.length === 0) {
    return {
      policy,
      nodeNeed,
      nodeNeedReason,
      hasDemandData,
      suggestions: [],
      graphAgeSec: Math.round((now - graph.at) / 1000),
      lnplus: { enabled: !!lnplus && lnplus.isEnabled(), checked: 0, known: 0, paused: lnplus?.isPaused() ?? false, error: null },
      portfolioSummary: { selectedCount: 0, estimatedNewReach: 0, estimatedWeightedNewReach: 0, demandCoveragePct: 0 },
    };
  }

  // Global liquidity-depth bound (over the whole graph, for node quality).
  let maxLogDepth = 0;
  for (const [, s] of graph.stats) {
    const d = Math.log(avgChanOf(s) + 1);
    if (d > maxLogDepth) maxLogDepth = d;
  }
  maxLogDepth = maxLogDepth || 1;

  // Node quality (0..1): used to weight reach so dead/stale nodes count less.
  const qualityCache = new Map<string, number>();
  const nodeQuality = (pk: string): number => {
    const cached = qualityCache.get(pk);
    if (cached !== undefined) return cached;
    const s = graph.stats.get(pk);
    const m = graph.meta.get(pk);
    let q = 0;
    if (s && s.degree > 0) {
      const enabledRatio = s.enabledCount / s.degree;
      const recentScore = clamp01(s.recentUpdates / s.degree / 0.5);
      const capScore = Math.log(avgChanOf(s) + 1) / maxLogDepth;
      const fresh = m && now - m.updatedAt <= staleMs ? 1 : 0.4;
      const feeOk = feeReasonableness(s.feeCount ? s.feeSum / s.feeCount : 0);
      q = (0.3 * enabledRatio + 0.25 * recentScore + 0.25 * capScore + 0.2 * feeOk) * fresh;
    }
    qualityCache.set(pk, q);
    return q;
  };

  interface Scored {
    e: { pk: string; stat: NodeStat; meta: NodeMeta };
    avgFee: number;
    newReachNodes: string[];
    weightedNewReach: number;
    qualityReachCount: number;
    graphScore: number;
    demandScore: number;
    weightedReachScore: number;
    roleFitScore: number;
    economicsScore: number;
    demandOverlapCount: number;
    demandFlowSharePct: number;
    rawScore: number;
    /** LN+ reputation, filled in later for the shortlist only (may stay null). */
    lnplus: LnPlusNode | null;
    /** Multiplier the LN+ reputation applies to rawScore (1 = no data). */
    trustMultiplier: number;
  }

  // First pass: per-candidate raw components.
  let maxDemandRaw = 0;
  const demandRawByPk = new Map<string, number>();
  const pre = eligible.map((e) => {
    const { stat } = e;
    const newReachNodes: string[] = [];
    for (const n of stat.neighbors) if (!reachable.has(n)) newReachNodes.push(n);

    let demandRaw = 0;
    let demandOverlapCount = 0;
    const involved = new Set<number>();
    for (const n of stat.neighbors) {
      const w = demandWeight.get(n);
      if (w) {
        demandRaw += w;
        demandOverlapCount += 1;
        const tags = peerTags.get(n);
        if (tags) for (const i of tags) involved.add(i);
      }
    }
    demandRawByPk.set(e.pk, demandRaw);
    if (demandRaw > maxDemandRaw) maxDemandRaw = demandRaw;

    let involvedWeight = 0;
    for (const i of involved) involvedWeight += peerWeights[i].weight;
    const demandFlowShare = totalDemand > 0 ? involvedWeight / totalDemand : 0;

    let weightedNewReach = 0;
    let qualityReachCount = 0;
    for (const n of newReachNodes) {
      const q = nodeQuality(n);
      weightedNewReach += q;
      if (q >= 0.5) qualityReachCount += 1;
    }

    return { e, newReachNodes, demandOverlapCount, demandFlowShare, weightedNewReach, qualityReachCount, involved };
  });

  const scored: Scored[] = pre.map((p) => {
    const { stat } = p.e;
    const avgFee = stat.feeCount ? stat.feeSum / stat.feeCount : 0;
    const newReach = p.newReachNodes.length;

    // ── graphScore (the v1 topology score, kept intact) ──
    const novelty = stat.degree ? newReach / stat.degree : 0;
    const magnitude = Math.min(1, newReach / 30);
    const reachScore = Math.sqrt(novelty * magnitude);
    const activityShare = stat.degree ? stat.recentUpdates / stat.degree : 0;
    const enabledShare = stat.degree ? stat.enabledCount / stat.degree : 0;
    const routerScore = 0.5 * Math.min(1, activityShare) + 0.5 * Math.min(1, enabledShare);
    const depthScore = Math.log(avgChanOf(stat) + 1) / maxLogDepth;
    const enough = Math.min(1, Math.log(stat.degree) / Math.log(30));
    const oversat = Math.max(0, (Math.log(stat.degree) - Math.log(250)) / (Math.log(4000) - Math.log(250)));
    const centralityScore = enough * (1 - 0.6 * Math.min(1, oversat));
    const feeScore = feeReasonableness(avgFee);
    const graphScore =
      0.3 * reachScore + 0.25 * routerScore + 0.15 * depthScore + 0.15 * centralityScore + 0.15 * feeScore;

    // ── demandScore (the heart) ──
    // Weighted magnitude (how much of our flow's neighbourhood it touches) tempered
    // by focus (what SHARE of the candidate's channels point at our demand). The
    // focus term is what stops a mega-hub — which neighbours everything, so touches
    // all our demand by sheer size — from winning on demand alone.
    const demandRaw = demandRawByPk.get(p.e.pk) ?? 0;
    const demandMag = maxDemandRaw > 0 ? demandRaw / maxDemandRaw : 0;
    const demandFocus = stat.degree ? clamp01(p.demandOverlapCount / stat.degree / 0.3) : 0;
    const demandScore = Math.sqrt(demandMag * demandFocus);

    // ── weightedReachScore (reach by quality, not raw count) ──
    const weightedNovelty = stat.degree ? p.weightedNewReach / stat.degree : 0;
    const weightedMagnitude = Math.min(1, p.weightedNewReach / 20);
    const weightedReachScore = Math.sqrt(weightedNovelty * weightedMagnitude);

    // ── economicsScore (thin: healthy, well-priced, non-dust, non-oversaturated) ──
    const economicsScore = clamp01(
      0.35 * feeScore + 0.25 * enabledShare + 0.2 * depthScore + 0.2 * (1 - Math.min(1, oversat)),
    );

    // ── roleFitScore (nudge by our node's need) ──
    let roleFitScore: number;
    switch (nodeNeed) {
      case "need_revenue":
        roleFitScore = 0.6 * demandScore + 0.4 * feeScore;
        break;
      case "need_routing_diversity":
        roleFitScore = weightedReachScore;
        break;
      case "need_outbound":
        // Short of outbound: an open is the fix — weight demand and depth.
        roleFitScore = 0.5 * demandScore + 0.5 * depthScore;
        break;
      case "need_inbound":
        // Short of inbound: an open adds outbound only — limited fit.
        roleFitScore = 0.5 * demandScore + 0.2 * routerScore;
        break;
      default:
        roleFitScore = 0.5 * demandScore + 0.5 * weightedReachScore;
    }

    // ── total ──
    const rawScore = hasDemandData
      ? 0.28 * graphScore +
        0.3 * demandScore +
        0.22 * weightedReachScore +
        0.12 * roleFitScore +
        0.08 * economicsScore
      : 0.5 * graphScore + 0.3 * weightedReachScore + 0.1 * roleFitScore + 0.1 * economicsScore;

    return {
      e: p.e,
      avgFee,
      newReachNodes: p.newReachNodes,
      weightedNewReach: p.weightedNewReach,
      qualityReachCount: p.qualityReachCount,
      graphScore,
      demandScore,
      weightedReachScore,
      roleFitScore,
      economicsScore,
      demandOverlapCount: p.demandOverlapCount,
      demandFlowSharePct: Math.round(p.demandFlowShare * 100),
      rawScore,
      lnplus: null,
      trustMultiplier: 1,
    };
  });

  // ── Greedy portfolio diversification ────────────────────────────────────────
  // Pick from the strongest pool, each round preferring the candidate whose new
  // reach overlaps least with what's already selected — so 12 picks don't all
  // cover the same cluster.
  scored.sort((a, b) => b.rawScore - a.rawScore);
  const pool = scored.slice(0, Math.max(policy.count * 4, 40));

  // ── LN+ reputation pass (optional, best-effort) ─────────────────────────────
  // Only the shortlist is enriched, never the thousands of candidates we scored:
  // LN+ allows 100 calls/24h, and the cache makes repeat runs nearly free. If
  // LN+ is down, rate-limiting or simply has no profile for a node, we keep the
  // pure-graph score — the feature degrades, it never fails.
  let lnplusChecked = 0;
  let lnplusKnown = 0;
  if (lnplus) {
    const profiles = await lnplus
      .enrich(pool.map((s) => s.e.pk), policy.lnplusFetchBudget)
      .catch(() => new Map<string, LnPlusNode>());
    for (const s of pool) {
      const cached = lnplus.peek(s.e.pk);
      const profile = profiles.get(s.e.pk) ?? (cached ?? null);
      if (cached !== undefined) lnplusChecked += 1;
      if (profile) {
        s.lnplus = profile;
        s.trustMultiplier = lnplusTrustMultiplier(profile);
        s.rawScore *= s.trustMultiplier;
        lnplusKnown += 1;
      }
    }
    // Re-rank: the reputation pass may have reshuffled the shortlist.
    pool.sort((a, b) => b.rawScore - a.rawScore);
  }

  const selected: { s: Scored; overlap: number; rank: number }[] = [];
  const reachSet = new Set<string>();
  while (selected.length < policy.count && selected.length < pool.length) {
    let best: Scored | null = null;
    let bestAdj = -1;
    let bestOverlap = 0;
    for (const s of pool) {
      if (selected.some((x) => x.s === s)) continue;
      let covered = 0;
      for (const n of s.newReachNodes) if (reachSet.has(n)) covered += 1;
      const overlap = s.newReachNodes.length ? covered / s.newReachNodes.length : 0;
      const adj = s.rawScore * (1 - policy.diversityPenaltyWeight * overlap);
      if (adj > bestAdj) {
        bestAdj = adj;
        best = s;
        bestOverlap = overlap;
      }
    }
    if (!best) break;
    selected.push({ s: best, overlap: bestOverlap, rank: selected.length });
    for (const n of best.newReachNodes) reachSet.add(n);
  }

  // ── Materialise the output ──────────────────────────────────────────────────
  const suggestions: SuggestionV2[] = selected.map(({ s, overlap, rank }) => {
    const { stat, meta, pk } = { ...s.e, pk: s.e.pk };
    const avgChan = avgChanOf(stat);

    // Size v2: geometric base, nudged by demand strength and candidate risk.
    const base = Math.sqrt(ourMedianChan * (avgChan || ourMedianChan));
    const demandMul = s.demandScore >= 0.6 ? 1.25 : s.demandScore <= 0.25 ? 0.75 : 1;
    const strong = s.demandScore >= 0.6 && s.weightedReachScore >= 0.4 && s.economicsScore >= 0.6;
    const riskMul = strong ? 1.1 : s.economicsScore < 0.4 ? 0.85 : 1;
    const recommendedSizeSats = Math.min(
      policy.maxSizeSats,
      Math.max(policy.minSizeSats, roundTo100k(base * demandMul * riskMul)),
    );
    const sizeReason =
      `geometric mean of your ${(ourMedianChan / 1e6).toFixed(1)}M median and the peer's ${(avgChan / 1e6).toFixed(1)}M avg channel` +
      (demandMul > 1 ? ", sized up for strong demand" : demandMul < 1 ? ", sized down for weak demand" : "");

    // Reasons (human, ranked by what actually drove the score).
    const reasons: string[] = [];
    if (hasDemandData && s.demandFlowSharePct >= 5) {
      reasons.push(
        `Demand fit: adjacent to peers involved in ${s.demandFlowSharePct}% of your ${policy.demandWindowDays}d outbound flow.`,
      );
    }
    if (s.qualityReachCount > 0) {
      reasons.push(
        `Quality reach: ${s.newReachNodes.length} new 2-hop nodes, ${s.qualityReachCount} of them active/high-quality routers.`,
      );
    } else if (s.newReachNodes.length > 0) {
      reasons.push(`Opens ${s.newReachNodes.length} new 2-hop destinations.`);
    }
    if (rank > 0 && overlap <= 0.34) {
      reasons.push("Diversifies your portfolio: covers a different cluster than the higher-ranked picks.");
    }
    const activityShare = stat.degree ? stat.recentUpdates / stat.degree : 0;
    if (activityShare >= 0.5 && s.avgFee <= 1200) {
      reasons.push("Moderate fees and fresh policies — an actively maintained router.");
    }
    if (reasons.length === 0) reasons.push(`${stat.degree} channels · ${(stat.totalCapacity / 1e8).toFixed(1)} BTC.`);

    // Warnings (honest caveats).
    const warnings: string[] = [];
    const oversat = Math.max(0, (Math.log(stat.degree) - Math.log(250)) / (Math.log(4000) - Math.log(250)));
    if (oversat > 0.5 && s.demandScore < 0.3) {
      warnings.push("Large hub: useful reach, but it overlaps heavily with peers you already connect to.");
    }
    if (s.avgFee > 2000) warnings.push("High average fees: handy for reach, less attractive for profitable routing.");
    const closedDaysAgo = closedDays.get(pk) ?? null;
    if (closedDaysAgo !== null) {
      warnings.push(`You closed a channel with this node ${closedDaysAgo === 0 ? "recently" : `${closedDaysAgo} days ago`} — the autopilot doesn't reopen to it within ${RECENT_CLOSE_DAYS} days.`);
    }
    if (meta.sockets.length === 0) warnings.push("It advertises no address — it can only be opened to while it is connected to you.");
    if (hasDemandData && s.demandScore < 0.15) {
      warnings.push("Low demand evidence: this pick rests mainly on graph topology.");
    }
    const needCaveat = needWarning(nodeNeed);
    if (needCaveat) warnings.push(needCaveat);

    // Badges (compact, for the row).
    const badges: string[] = [];
    if (hasDemandData && s.demandScore >= 0.5) badges.push("demand fit");
    if (rank > 0 && overlap <= 0.34) badges.push("new cluster");
    if (activityShare >= 0.5) badges.push("active router");
    if (s.avgFee > 0 && s.avgFee <= 600) badges.push("moderate fees");
    if (avgChan >= 5_000_000) badges.push("high liquidity");

    // LN+ reputation: the one signal the graph cannot carry — whether real
    // operators have dealt with this node and would do it again.
    const lp = s.lnplus;
    if (lp) {
      const ratings = lp.positiveRatings + lp.negativeRatings;
      if (lp.rank >= 7) badges.push(`LN+ ${lp.rankName || `rank ${lp.rank}`}`);
      if (lp.prime) badges.push("LN+ Prime");
      if (lp.negativeRatings > 0 && lp.negativeRatings >= lp.positiveRatings) {
        warnings.push(
          `LN+ peers rate this node poorly: ${lp.positiveRatings} positive vs ${lp.negativeRatings} negative.`,
        );
      } else if (ratings >= 5 && lp.positiveRatings > lp.negativeRatings) {
        reasons.push(
          `Vouched for on LN+: rank ${lp.rank}/10${lp.rankName ? ` (${lp.rankName})` : ""}, ${lp.positiveRatings} positive rating${lp.positiveRatings === 1 ? "" : "s"} from real operators.`,
        );
      }
    }

    const usefulness: SuggestionV2["usefulness"] =
      s.rawScore >= 0.55 ? "high" : s.rawScore >= 0.35 ? "medium" : "low";

    const sockets = dialOrder(meta.sockets, torOnly);
    return {
      pubkey: pk,
      alias: meta.alias,
      socket: sockets[0] ?? "",
      sockets,
      hasClearnet: meta.hasClearnet,
      channels: stat.degree,
      capacitySats: stat.totalCapacity,
      avgChannelSats: Math.round(avgChan),
      avgFeePpm: Math.round(s.avgFee),
      lastSeenDays: Math.round((now - meta.updatedAt) / 86_400_000),
      score: Math.round(s.rawScore * 100),
      graphScore: Math.round(s.graphScore * 100) / 100,
      demandScore: Math.round(s.demandScore * 100) / 100,
      weightedReachScore: Math.round(s.weightedReachScore * 100) / 100,
      roleFitScore: Math.round(s.roleFitScore * 100) / 100,
      economicsScore: Math.round(s.economicsScore * 100) / 100,
      newReach: s.newReachNodes.length,
      weightedNewReach: Math.round(s.weightedNewReach * 10) / 10,
      qualityReachCount: s.qualityReachCount,
      demandOverlapCount: s.demandOverlapCount,
      demandFlowSharePct: s.demandFlowSharePct,
      portfolioOverlap: Math.round(overlap * 100) / 100,
      recommendedSizeSats,
      sizeReason,
      usefulness,
      badges,
      reasons,
      warnings,
      lnplus: lp
        ? {
            rank: lp.rank,
            rankName: lp.rankName,
            prime: lp.prime,
            verified: lp.verified,
            positiveRatings: lp.positiveRatings,
            negativeRatings: lp.negativeRatings,
            profileUrl: lp.profileUrl,
            scoreEffectPct: Math.round((s.trustMultiplier - 1) * 100),
          }
        : null,
      peerMinChannelSats: lp && lp.minChannelSizeSats > 0 ? lp.minChannelSizeSats : null,
      closedDaysAgo,
    };
  });

  const estimatedNewReach = reachSet.size;
  let estimatedWeightedNewReach = 0;
  for (const n of reachSet) estimatedWeightedNewReach += nodeQuality(n);
  // Demand coverage: union of our flow-peers that any selected candidate connects to.
  const coverInvolved = new Set<number>();
  for (const sel of selected) {
    const p = pre.find((x) => x.e.pk === sel.s.e.pk);
    if (p) for (const i of p.involved) coverInvolved.add(i);
  }
  let coveredWeight = 0;
  for (const i of coverInvolved) coveredWeight += peerWeights[i].weight;
  const demandCoveragePct = totalDemand > 0 ? Math.round((coveredWeight / totalDemand) * 100) : 0;

  return {
    policy,
    nodeNeed,
    nodeNeedReason,
    hasDemandData,
    suggestions,
    graphAgeSec: Math.round((now - graph.at) / 1000),
    lnplus: {
      enabled: !!lnplus && lnplus.isEnabled(),
      checked: lnplusChecked,
      known: lnplusKnown,
      paused: lnplus?.isPaused() ?? false,
      error: lnplus?.getLastError() ?? null,
    },
    portfolioSummary: {
      selectedCount: suggestions.length,
      estimatedNewReach,
      estimatedWeightedNewReach: Math.round(estimatedWeightedNewReach),
      demandCoveragePct,
    },
  };
}

// ── Close Suggestions v2 ──────────────────────────────────────────────────────
// Which channels are dead weight worth closing — but honest about whether a close
// actually frees YOUR capital. You only ever reclaim your *local* balance on close;
// a channel the peer opened to you frees little (their capital, your small local)
// and gives up free inbound, so it's judged very differently from one you funded.
//
// Never a close candidate (review a3-channels / a4 / a6, package P4):
//  - a channel still opening or closing: it is listed apart, with no close button
//    (before, a just-funded channel — a Magma or LSPS1 sale's too — was listed
//    first as "Offline — peer unreachable", with only a force-close offered);
//  - a channel inside its lease — sold on Magma, sold over LSPS1, or bought on
//    Magma (leases.ts): closing it breaks what a buyer paid for, or throws away
//    what this node paid. The 30-day guard covered only the shortest lease.
// And a peer that is offline for a moment is not a close signal: only one away
// for days (or online less than half the time) counts (channelUptime.ts).

export interface CloseSuggestion {
  channelId: string;
  alias: string;
  peerPubkey: string;
  transactionId: string;
  transactionVout: number;
  active: boolean;
  /** We funded the channel (initiator) — closing returns our committed capital. */
  weOpened: boolean;
  capacitySats: number;
  localSats: number;
  /** What you'd actually reclaim on-chain on close = your current local balance. */
  capitalFreedSats: number;
  /** Live on-chain cost to close this channel (cooperatively). */
  closeCostSat: number;
  /** Inbound liquidity you'd give up (the remote side), free if the peer opened it. */
  inboundLiquidityLostSats: number;
  closeScore: number;
  pnl30dSats: number;
  /** 60 days: fees earned on it + fees of the forwards it brought in −
   *  rebalancing into it. */
  pnl60dSats: number;
  /** Of that, the fees of the forwards that came in through it (review
   *  a5-analytics:inbound-channels-invisible: a channel that only brings
   *  flow in earned "nothing", yet closing it kills every route through it). */
  assisted60dSats: number;
  flow60dSats: number;
  forwards60d: number;
  ageDays: number | null;
  reachContribution: number;
  uniqueReachLost: number;
  feeV2State: FeeRecState;
  opportunityCandidates: { alias: string; score: number; sizeSats: number }[];
  /** The peer is away: since when, and whether that counts toward a close
   *  (null: online). A short outage is shown, never scored. */
  offline: OfflineInfo | null;
  /** A lease the channel had and that is over (a channel inside one is
   *  never a candidate) — a bought one with what it cost. */
  lease: ChannelLease | null;
  /** What a force-close would mean, for the close dialog: our funds locked
   *  this many blocks, and the commitment fee LND last signed (sat). */
  csvDelayBlocks: number | null;
  commitFeeSats: number | null;
  reasons: string[];
  warnings: string[];
}

/** A channel the close list leaves alone, and why. */
export interface ProtectedChannel {
  channelId: string;
  alias: string;
  reason: string;
  /** Set when a running lease is the reason. */
  lease: ChannelLease | null;
}

/** A channel still opening or closing: shown apart, never closable here. */
export interface PendingChannel {
  channelId: string;
  alias: string;
  status: "pending_open" | "pending_close";
  capacitySats: number;
  localSats: number;
  /** A sale's or a purchase's lease (a pending one is inside it). */
  lease: ChannelLease | null;
  /** A force-close under way: blocks until the funds are spendable. */
  timelockBlocks: number | null;
}

export interface CloseV2Report {
  windowDays: number;
  candidates: CloseSuggestion[];
  protectedCount: number;
  /** Every protected channel with its reason (leases first). */
  protected: ProtectedChannel[];
  /** Channels still opening or closing. */
  pending: PendingChannel[];
  /** What closing every candidate would return (pending and leased channels
   *  are never in it). */
  totalCapitalFreedSats: number;
}

/** What the close list needs beyond LND (the API route passes it). */
export interface CloseContext {
  /** Where leases come from (the capital and purchase ledgers). */
  leaseSources?: LeaseSources;
  /** The offline-duration record — observed with this read, then asked. */
  uptime?: Pick<ChannelUptime, "observe" | "offlineInfo">;
}

/** Everything the close ranking works from — no I/O (rankCloseCandidates). */
export interface CloseInput {
  channels: ChannelView[];
  feeById: ReadonlyMap<string, FeeRecommendation>;
  /** 60 days of flow per channel: out (fees earned on it) and in (the fees
   *  forwards that came in through it earned on their way out). */
  flow60ById: ReadonlyMap<string, { routedOut: number; routedIn: number; forwardCount: number; feesEarned: number; inboundFeesEarned?: number }>;
  /** Per channel: the 2-hop nodes only its peer reaches. */
  uniqueReachByChan: ReadonlyMap<string, number>;
  opportunity: { alias: string; score: number; sizeSats: number }[];
  closeCostSat: number;
  rebalanceRecords: RebalanceRecord[];
  channelOverrides: OverrideMap;
  leases: ReadonlyMap<string, ChannelLease>;
  offline: (c: ChannelView) => OfflineInfo | null;
  nowMs: number;
}

/** Thousands-separated "k" amounts ("2,000k", not "2000k"). */
const kSep = (n: number) => `${Math.round(n / 1000).toLocaleString("en-US")}k`;

/** What a bought channel was, for its reasons and warnings. */
function boughtText(l: ChannelLease): string {
  const days = Math.round(l.leaseBlocks / 144);
  const ended = l.untilHeight !== null ? ` that ended at block ${l.untilHeight.toLocaleString("en-US")}` : "";
  return `Bought on Magma for ${Math.round(l.costSats ?? 0).toLocaleString("en-US")} sat (order ${l.orderId.slice(0, 8)}…, a ${days}-day lease${ended})`;
}

/**
 * The close list from its inputs — pure, so every protection and signal can
 * be tested without a node.
 */
export function rankCloseCandidates(input: CloseInput): CloseV2Report {
  const { channels, feeById, flow60ById, closeCostSat, rebalanceRecords, channelOverrides, nowMs } = input;
  const maxUniqueReach = Math.max(1, ...[...input.uniqueReachByChan.values()]);

  // 60d revenue percentile is not needed once fee-v2 gives us isTopEarner; we keep
  // the rebalance-cost lookups window-aware for the P&L.
  const within = (at: string, days: number) => nowMs - new Date(at).getTime() <= days * 86_400_000;
  const rebalCost = (channelId: string, days: number) =>
    rebalanceRecords
      .filter((r) => r.ok && r.targetId === channelId && within(r.at, days))
      .reduce((s, r) => s + (r.feeSats ?? 0), 0);

  const protectedList: ProtectedChannel[] = [];
  const pending: PendingChannel[] = [];
  const candidates: CloseSuggestion[] = [];

  for (const c of channels) {
    const lease = input.leases.get(c.id) ?? null;
    // Still opening or closing: no close button, never a candidate — and
    // none of the signals below (no flow yet, no age, "inactive") mean
    // anything for it.
    if (c.status !== "open") {
      pending.push({
        channelId: c.id,
        alias: c.peerAlias,
        status: c.status,
        capacitySats: c.capacity,
        localSats: c.localBalance,
        lease,
        timelockBlocks: c.timelockBlocks ?? null,
      });
      continue;
    }
    const fee = feeById.get(c.id);
    const f60 = flow60ById.get(c.id);
    const m = fee?.metrics;
    const routed30 = (m?.routedOut30d ?? 0) + (m?.routedIn30d ?? 0);
    const routed60 = (f60?.routedOut ?? 0) + (f60?.routedIn ?? 0);
    const forwards60 = f60?.forwardCount ?? 0;
    const lifetime = c.totalSent + c.totalReceived;
    const rev30 = m?.revenue30d ?? 0;
    const rev60 = f60?.feesEarned ?? 0;
    // What it brought in counts for it too: the fees of the forwards that
    // entered through it (earned on their outgoing channel). Never lowers a
    // channel's P&L — it can only keep a source channel off the list.
    const assisted60 = f60?.inboundFeesEarned ?? 0;
    const pnl30 = rev30 - rebalCost(c.id, 30);
    const pnl60 = rev60 + assisted60 - rebalCost(c.id, 60);
    const ageDays = m?.channelAgeDays ?? null;
    const uniqueReach = input.uniqueReachByChan.get(c.id) ?? 0;
    const reachContribution = uniqueReach / maxUniqueReach;
    const feeState = fee?.state ?? "normal";
    const weOpened = c.initiator === "local";

    // ── Protections: never suggest closing these ──
    // "Routed recently" and "unique reach" hold whether or not the peer is
    // connected this minute (before, both required c.active: a peer offline
    // for a moment lost them and the channel went to the top of the list).
    let protectedReason: string | null = null;
    if (lease?.running) protectedReason = leaseProtection(lease);
    else if (channelOverrides[c.id]?.mode === "exclude") protectedReason = "manually protected";
    else if (ageDays != null && ageDays < 30) protectedReason = "new channel — still in its test period";
    else if (routed30 > 0) protectedReason = "routed recently";
    else if (m?.isTopEarner) protectedReason = "top earner";
    else if (reachContribution >= 0.5) protectedReason = "provides significant unique reach";
    if (protectedReason) {
      protectedList.push({ channelId: c.id, alias: c.peerAlias, reason: protectedReason, lease: lease?.running ? lease : null });
      continue;
    }

    // ── Must have at least one real close signal ──
    const away = input.offline(c);
    // Away for days, or online less than half the time: a signal. A peer
    // offline for hours is not one — it is shown, and the dialog offers a
    // reconnect first (a force-close locks funds for the CSV delay).
    const longOffline = away?.long === true;
    const idle60 = routed60 === 0;
    const losing = pnl60 < 0;
    const weak = feeState === "close_candidate" || m?.peerGate === "weak";
    if (!longOffline && !idle60 && !losing && !weak) continue;

    // ── Score ──
    const idleScore = longOffline ? 1 : idle60 ? 0.8 : routed30 === 0 ? 0.4 : 0;
    const negPnlScore = pnl60 < 0 ? clamp01(-pnl60 / 5000) : 0;
    const weakPeerScore = feeState === "close_candidate" ? 1 : longOffline ? 0.6 : m?.peerGate === "weak" ? 0.5 : 0;
    const lowReachScore = 1 - reachContribution;
    // What closing actually returns on-chain to redeploy = our current local balance
    // minus the on-chain cost to close, regardless of who opened the channel.
    const capitalFreed = Math.max(0, c.localBalance);
    const netFreed = Math.max(0, capitalFreed - closeCostSat);
    const opportunityScore = clamp01(netFreed / 2_000_000);
    const staleScore = feeState === "close_candidate" || longOffline ? 0.7 : 0.3;
    let closeScore = Math.round(
      100 *
        (0.28 * idleScore +
          0.24 * negPnlScore +
          0.16 * weakPeerScore +
          0.12 * lowReachScore +
          0.12 * opportunityScore +
          0.08 * staleScore),
    );
    // Sacrificing far more free inbound than the capital it frees is a poor trade —
    // demote those (e.g. a peer-opened channel with big inbound but little local).
    const inboundLossRatio = capitalFreed > 0 ? c.remoteBalance / capitalFreed : c.remoteBalance > 0 ? 10 : 0;
    if (inboundLossRatio > 3) closeScore = Math.round(closeScore * 0.7);

    // ── Reasons ──
    const reasons: string[] = [];
    if (longOffline && away) {
      if (away.hours !== null && away.hours >= OFFLINE_CLOSE_SIGNAL_HOURS) {
        reasons.push(`Offline for ${offlineText(away).replace(/^offline for /, "")} — peer unreachable.`);
      } else if (away.uptimeShare !== null) {
        reasons.push(
          `Flaky peer — online only ${Math.round(away.uptimeShare * 100)}% of the time over LND's last ${Math.round(UPTIME_WINDOW_MS / 86_400_000)}+ days` +
            `${away.hours !== null ? ` (${offlineText(away)} now)` : ""}.`,
        );
      }
    }
    if (idle60 && lifetime === 0) reasons.push("Never routed.");
    else if (idle60) reasons.push("No forwards in 60d.");
    if (losing)
      reasons.push(
        `Negative P&L: -${Math.round(-pnl60)} sat over 60d (earned ${Math.round(rev60)}` +
          (assisted60 > 0 ? ` + ${Math.round(assisted60)} on forwards it brought in` : "") +
          ` - rebalancing ${Math.round(rebalCost(c.id, 60))}).`,
      );
    if (feeState === "close_candidate") reasons.push("Fee autopilot flags this peer as a close candidate.");
    if (reachContribution < 0.15) reasons.push("Adds little unique reach — other channels already cover the same nodes.");
    if (capitalFreed >= 500_000 && input.opportunity.length) {
      reasons.push(
        `Frees ${kSep(capitalFreed)} you could redeploy into ${input.opportunity[0].alias}${input.opportunity.length > 1 ? ` +${input.opportunity.length - 1} more` : ""}.`,
      );
    }
    if (reasons.length === 0) reasons.push("Weak, low-value channel.");

    // ── Warnings: be honest about what a close really costs ──
    const warnings: string[] = [];
    if (!c.active && !longOffline) {
      warnings.push(
        `The peer is ${away ? offlineText(away) : "offline right now"} — a short outage is no reason to close: reconnect, or wait for it to come back and close cooperatively. ` +
          `A force-close locks your funds for ${c.csvDelayBlocks ?? "the CSV delay of"} blocks.`,
      );
    }
    if (capitalFreed < 0.2 * c.capacity) {
      warnings.push(`Mostly drained — only ${kSep(capitalFreed)} returns on-chain (the rest already routed out).`);
    }
    if (c.remoteBalance >= 0.3 * c.capacity) {
      warnings.push(
        lease?.kind === "magma_purchase"
          ? `${boughtText(lease)} — closing gives up the ${kSep(c.remoteBalance)} of inbound it provided.`
          : weOpened
            ? `Closing gives up ${kSep(c.remoteBalance)} of inbound liquidity.`
            : `Peer opened this channel — closing gives up ${kSep(c.remoteBalance)} of free inbound liquidity it provided.`,
      );
    } else if (lease?.kind === "magma_purchase") {
      warnings.push(`${boughtText(lease)}.`);
    }
    if (closeCostSat > 0.3 * Math.max(capitalFreed, 1)) {
      warnings.push(
        `On-chain fees are high right now — closing costs ~${closeCostSat} sat, ${Math.round((closeCostSat / Math.max(capitalFreed, 1)) * 100)}% of what you'd reclaim. Wait for cheaper fees.`,
      );
    }

    candidates.push({
      channelId: c.id,
      alias: c.peerAlias,
      peerPubkey: c.peerPubkey,
      transactionId: c.transactionId,
      transactionVout: c.transactionVout,
      active: c.active,
      weOpened,
      capacitySats: c.capacity,
      localSats: c.localBalance,
      capitalFreedSats: capitalFreed,
      closeCostSat,
      inboundLiquidityLostSats: c.remoteBalance,
      closeScore,
      pnl30dSats: Math.round(pnl30),
      pnl60dSats: Math.round(pnl60),
      assisted60dSats: Math.round(assisted60),
      flow60dSats: routed60,
      forwards60d: forwards60,
      ageDays,
      reachContribution: Math.round(reachContribution * 100) / 100,
      uniqueReachLost: uniqueReach,
      feeV2State: feeState,
      // Only dangle redeploy candidates when a close actually frees usable capital.
      opportunityCandidates: capitalFreed >= 500_000 ? input.opportunity : [],
      offline: away,
      lease,
      csvDelayBlocks: c.csvDelayBlocks ?? null,
      commitFeeSats: c.commitFeeSats ?? null,
      reasons,
      warnings,
    });
  }

  // Highest close score first. (Before: "offline first" — a peer away for a
  // moment led the list.)
  candidates.sort((a, b) => b.closeScore - a.closeScore);
  // Leases first among the protected: the ones a close would break.
  protectedList.sort((a, b) => Number(!!b.lease) - Number(!!a.lease));
  const totalCapitalFreedSats = candidates.reduce((s, c) => s + c.capitalFreedSats, 0);

  return {
    windowDays: 60,
    candidates,
    protectedCount: protectedList.length,
    protected: protectedList,
    pending,
    totalCapitalFreedSats,
  };
}

export async function getCloseSuggestionsV2(
  lnd: AuthenticatedLnd,
  rebalanceRecords: RebalanceRecord[],
  feeConfig: Partial<FeeRecConfig> = {},
  channelOverrides: OverrideMap = {},
  ctx: CloseContext = {},
): Promise<CloseV2Report> {
  const [channels, ownKey, graph, flow60, feeRep, sugRep, oc, height] = await Promise.all([
    getChannelsView(lnd),
    getOwnPubkey(lnd),
    buildGraphCache(lnd),
    getFlowSummary(lnd, 60).catch(() => null),
    getFeeRecommendations(lnd, rebalanceRecords, null, feeConfig, channelOverrides),
    getChannelSuggestionsV2(lnd).catch(() => null),
    onchainCosts(lnd),
    getWalletInfo({ lnd })
      .then((w) => w.current_block_height)
      .catch(() => 0),
  ]);
  const nowMs = Date.now();
  // A fresh observation: the offline durations below include this moment.
  ctx.uptime?.observe(channels, nowMs);

  // Reach cover: how many of our peers reach each 2-hop node. uniqueReach for a
  // channel = nodes only its peer reaches → what we'd actually lose by closing it.
  const peersSet = new Set(channels.map((c) => c.peerPubkey));
  const cover = new Map<string, number>();
  for (const c of channels) {
    const ps = graph.stats.get(c.peerPubkey);
    if (ps) for (const n of ps.neighbors) cover.set(n, (cover.get(n) ?? 0) + 1);
  }
  const uniqueReachOf = (peerPubkey: string): number => {
    const ps = graph.stats.get(peerPubkey);
    if (!ps) return 0;
    let u = 0;
    for (const n of ps.neighbors) if (cover.get(n) === 1 && !peersSet.has(n) && n !== ownKey) u += 1;
    return u;
  };

  return rankCloseCandidates({
    channels,
    feeById: new Map(feeRep.recommendations.map((r) => [r.channelId, r])),
    flow60ById: new Map((flow60?.perChannel ?? []).map((f) => [f.channelId, f])),
    uniqueReachByChan: new Map(channels.map((c) => [c.id, uniqueReachOf(c.peerPubkey)])),
    opportunity: (sugRep?.suggestions ?? []).slice(0, 3).map((s) => ({
      alias: s.alias,
      score: s.score,
      sizeSats: s.recommendedSizeSats,
    })),
    closeCostSat: oc.closeCostSat,
    rebalanceRecords,
    channelOverrides,
    leases: ctx.leaseSources ? channelLeases(channels, ctx.leaseSources, height, nowMs) : new Map(),
    // Without the record (a caller of its own), no peer counts as away long.
    offline: (c) => (ctx.uptime ? ctx.uptime.offlineInfo(c, nowMs) : null),
    nowMs,
  });
}
