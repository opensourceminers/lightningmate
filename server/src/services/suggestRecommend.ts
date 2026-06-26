import { type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { getFeeRecommendations, type FeeRecConfig, type FeeRecState } from "./feeRecommend.js";
import type { RebalanceRecord } from "./rebalanceLog.js";
import type { OverrideMap } from "./overrides.js";
import {
  buildGraphCache,
  DEFAULT_SUGGESTION_POLICY,
  type NodeMeta,
  type NodeStat,
  type SuggestionPolicy,
} from "./suggestions.js";

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
}

export const SUGGEST_V2_DEFAULTS: SuggestV2Config = {
  ...DEFAULT_SUGGESTION_POLICY,
  demandWindowDays: 30,
  diversityPenaltyWeight: 0.35,
};

export type NodeNeed =
  | "need_inbound"
  | "need_outbound"
  | "need_routing_diversity"
  | "need_revenue"
  | "balanced";

export interface SuggestionV2 {
  pubkey: string;
  alias: string;
  socket: string;
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
}

export interface SuggestV2Report {
  policy: SuggestV2Config;
  nodeNeed: NodeNeed;
  nodeNeedReason: string;
  hasDemandData: boolean;
  suggestions: SuggestionV2[];
  graphAgeSec: number;
  portfolioSummary: {
    selectedCount: number;
    estimatedNewReach: number;
    estimatedWeightedNewReach: number;
    demandCoveragePct: number;
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const k = (n: number) => `${Math.round(n / 1000)}k`;
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const roundTo100k = (n: number) => Math.round(n / 100_000) * 100_000;
const avgChanOf = (s: NodeStat) => (s.degree ? s.totalCapacity / s.degree : 0);

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
): Promise<SuggestV2Report> {
  const policy = { ...SUGGEST_V2_DEFAULTS, ...overrides };

  const [graph, channels, ownKey, flow] = await Promise.all([
    buildGraphCache(lnd),
    getChannelsView(lnd),
    getOwnPubkey(lnd),
    getFlowSummary(lnd, policy.demandWindowDays).catch(() => null),
  ]);

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
  const totalCap = channels.reduce((s, c) => s + c.capacity, 0) || 1;
  const localSats = channels.reduce((s, c) => s + c.localRatio * c.capacity, 0);
  const myLocalRatio = localSats / totalCap;
  const revenue = flow?.totalFeesEarnedSats ?? 0;
  const revenuePerChannel = channels.length ? revenue / channels.length : 0;

  let nodeNeed: NodeNeed;
  let nodeNeedReason: string;
  if (channels.length < 5) {
    nodeNeed = "need_routing_diversity";
    nodeNeedReason = `only ${channels.length} channel${channels.length === 1 ? "" : "s"} — broaden into new clusters first`;
  } else if (myLocalRatio >= 0.7) {
    nodeNeed = "need_outbound";
    nodeNeedReason = `${Math.round(myLocalRatio * 100)}% of your liquidity is local — deploy it toward peers that pull flow`;
  } else if (myLocalRatio <= 0.3) {
    nodeNeed = "need_inbound";
    nodeNeedReason = `only ${Math.round(myLocalRatio * 100)}% local — you need inbound; new opens give outbound, so prefer peers likely to send back`;
  } else if (revenuePerChannel < 50) {
    nodeNeed = "need_revenue";
    nodeNeedReason = `low earnings per channel (${Math.round(revenuePerChannel)} sat/${policy.demandWindowDays}d) — chase real demand`;
  } else {
    nodeNeed = "balanced";
    nodeNeedReason = "well balanced — grow where you already see demand and into fresh clusters";
  }

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
    const { stat, meta } = p.e;
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
        roleFitScore = 0.5 * demandScore + 0.5 * depthScore;
        break;
      case "need_inbound":
        roleFitScore = 0.5 * demandScore + 0.2 * routerScore; // limited — opens give outbound
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
    };
  });

  // ── Greedy portfolio diversification ────────────────────────────────────────
  // Pick from the strongest pool, each round preferring the candidate whose new
  // reach overlaps least with what's already selected — so 12 picks don't all
  // cover the same cluster.
  scored.sort((a, b) => b.rawScore - a.rawScore);
  const pool = scored.slice(0, Math.max(policy.count * 4, 40));
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
    if (hasDemandData && s.demandScore < 0.15) {
      warnings.push("Low demand evidence: this pick rests mainly on graph topology.");
    }
    if (nodeNeed === "need_inbound") {
      warnings.push("You need inbound — opening this gives outbound liquidity, not inbound.");
    }

    // Badges (compact, for the row).
    const badges: string[] = [];
    if (hasDemandData && s.demandScore >= 0.5) badges.push("demand fit");
    if (rank > 0 && overlap <= 0.34) badges.push("new cluster");
    if (activityShare >= 0.5) badges.push("active router");
    if (s.avgFee > 0 && s.avgFee <= 600) badges.push("moderate fees");
    if (avgChan >= 5_000_000) badges.push("high liquidity");

    const usefulness: SuggestionV2["usefulness"] =
      s.rawScore >= 0.55 ? "high" : s.rawScore >= 0.35 ? "medium" : "low";

    return {
      pubkey: pk,
      alias: meta.alias,
      socket: meta.socket,
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
  /** Inbound liquidity you'd give up (the remote side), free if the peer opened it. */
  inboundLiquidityLostSats: number;
  closeScore: number;
  pnl30dSats: number;
  pnl60dSats: number;
  flow60dSats: number;
  forwards60d: number;
  ageDays: number | null;
  reachContribution: number;
  uniqueReachLost: number;
  feeV2State: FeeRecState;
  opportunityCandidates: { alias: string; score: number; sizeSats: number }[];
  reasons: string[];
  warnings: string[];
}

export interface CloseV2Report {
  windowDays: number;
  candidates: CloseSuggestion[];
  protectedCount: number;
  totalCapitalFreedSats: number;
}

export async function getCloseSuggestionsV2(
  lnd: AuthenticatedLnd,
  rebalanceRecords: RebalanceRecord[],
  feeConfig: Partial<FeeRecConfig> = {},
  channelOverrides: OverrideMap = {},
): Promise<CloseV2Report> {
  const [channels, ownKey, graph, flow60, feeRep, sugRep] = await Promise.all([
    getChannelsView(lnd),
    getOwnPubkey(lnd),
    buildGraphCache(lnd),
    getFlowSummary(lnd, 60).catch(() => null),
    getFeeRecommendations(lnd, rebalanceRecords, null, feeConfig, channelOverrides),
    getChannelSuggestionsV2(lnd).catch(() => null),
  ]);

  const now = Date.now();
  const feeById = new Map(feeRep.recommendations.map((r) => [r.channelId, r]));
  const flow60ById = new Map((flow60?.perChannel ?? []).map((f) => [f.channelId, f]));
  const peersSet = new Set(channels.map((c) => c.peerPubkey));

  // 60d revenue percentile is not needed once fee-v2 gives us isTopEarner; we keep
  // the rebalance-cost lookups window-aware for the P&L.
  const within = (at: string, days: number) => now - new Date(at).getTime() <= days * 86_400_000;
  const rebalCost = (channelId: string, days: number) =>
    rebalanceRecords
      .filter((r) => r.ok && r.targetId === channelId && within(r.at, days))
      .reduce((s, r) => s + (r.feeSats ?? 0), 0);

  // Reach cover: how many of our peers reach each 2-hop node. uniqueReach for a
  // channel = nodes only its peer reaches → what we'd actually lose by closing it.
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
  const uniqueReachByChan = new Map(channels.map((c) => [c.id, uniqueReachOf(c.peerPubkey)]));
  const maxUniqueReach = Math.max(1, ...[...uniqueReachByChan.values()]);

  const opportunity = (sugRep?.suggestions ?? []).slice(0, 3).map((s) => ({
    alias: s.alias,
    score: s.score,
    sizeSats: s.recommendedSizeSats,
  }));

  let protectedCount = 0;
  const candidates: CloseSuggestion[] = [];

  for (const c of channels) {
    const fee = feeById.get(c.id);
    const f60 = flow60ById.get(c.id);
    const m = fee?.metrics;
    const routed30 = (m?.routedOut30d ?? 0) + (m?.routedIn30d ?? 0);
    const routed60 = (f60?.routedOut ?? 0) + (f60?.routedIn ?? 0);
    const forwards60 = f60?.forwardCount ?? 0;
    const lifetime = c.totalSent + c.totalReceived;
    const rev30 = m?.revenue30d ?? 0;
    const rev60 = f60?.feesEarned ?? 0;
    const pnl30 = rev30 - rebalCost(c.id, 30);
    const pnl60 = rev60 - rebalCost(c.id, 60);
    const ageDays = m?.channelAgeDays ?? null;
    const uniqueReach = uniqueReachByChan.get(c.id) ?? 0;
    const reachContribution = uniqueReach / maxUniqueReach;
    const feeState = fee?.state ?? "normal";
    const weOpened = c.initiator === "local";

    // ── Protections: never suggest closing these ──
    let protectedReason: string | null = null;
    if (channelOverrides[c.id]?.mode === "exclude") protectedReason = "manually protected";
    else if (ageDays != null && ageDays < 30) protectedReason = "new channel — still in its test period";
    else if (c.active && routed30 > 0) protectedReason = "routed recently";
    else if (m?.isTopEarner) protectedReason = "top earner";
    else if (c.active && reachContribution >= 0.5) protectedReason = "provides significant unique reach";
    if (protectedReason) {
      protectedCount += 1;
      continue;
    }

    // ── Must have at least one real close signal ──
    const offline = !c.active;
    const idle60 = routed60 === 0;
    const losing = pnl60 < 0;
    const weak = feeState === "close_candidate" || m?.peerGate === "weak";
    if (!offline && !idle60 && !losing && !weak) continue;

    // ── Score ──
    const idleScore = offline ? 1 : idle60 ? 0.8 : routed30 === 0 ? 0.4 : 0;
    const negPnlScore = pnl60 < 0 ? clamp01(-pnl60 / 5000) : 0;
    const weakPeerScore = feeState === "close_candidate" ? 1 : offline ? 0.6 : m?.peerGate === "weak" ? 0.5 : 0;
    const lowReachScore = 1 - reachContribution;
    // What closing actually returns on-chain to redeploy = our current local balance,
    // regardless of who opened the channel.
    const capitalFreed = Math.max(0, c.localBalance);
    const opportunityScore = clamp01(capitalFreed / 2_000_000);
    const staleScore = feeState === "close_candidate" || offline ? 0.7 : 0.3;
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
    if (offline) reasons.push("Offline — peer unreachable.");
    if (idle60 && lifetime === 0) reasons.push("Never routed.");
    else if (idle60) reasons.push("No forwards in 60d.");
    if (losing)
      reasons.push(
        `Negative P&L: -${Math.round(-pnl60)} sat over 60d (earned ${Math.round(rev60)} - rebalancing ${Math.round(rebalCost(c.id, 60))}).`,
      );
    if (feeState === "close_candidate") reasons.push("Fee autopilot flags this peer as a close candidate.");
    if (reachContribution < 0.15) reasons.push("Adds little unique reach — other channels already cover the same nodes.");
    if (capitalFreed >= 500_000 && opportunity.length) {
      reasons.push(
        `Frees ${k(capitalFreed)} you could redeploy into ${opportunity[0].alias}${opportunity.length > 1 ? ` +${opportunity.length - 1} more` : ""}.`,
      );
    }
    if (reasons.length === 0) reasons.push("Weak, low-value channel.");

    // ── Warnings: be honest about what a close really costs ──
    const warnings: string[] = [];
    if (capitalFreed < 0.2 * c.capacity) {
      warnings.push(`Mostly drained — only ${k(capitalFreed)} returns on-chain (the rest already routed out).`);
    }
    if (c.remoteBalance >= 0.3 * c.capacity) {
      warnings.push(
        weOpened
          ? `Closing gives up ${k(c.remoteBalance)} of inbound liquidity.`
          : `Peer opened this channel — closing gives up ${k(c.remoteBalance)} of free inbound liquidity it provided.`,
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
      inboundLiquidityLostSats: c.remoteBalance,
      closeScore,
      pnl30dSats: Math.round(pnl30),
      pnl60dSats: Math.round(pnl60),
      flow60dSats: routed60,
      forwards60d: forwards60,
      ageDays,
      reachContribution: Math.round(reachContribution * 100) / 100,
      uniqueReachLost: uniqueReach,
      feeV2State: feeState,
      // Only dangle redeploy candidates when a close actually frees usable capital.
      opportunityCandidates: capitalFreed >= 500_000 ? opportunity : [],
      reasons,
      warnings,
    });
  }

  // Offline first, then highest close score.
  candidates.sort((a, b) => Number(a.active) - Number(b.active) || b.closeScore - a.closeScore);
  const totalCapitalFreedSats = candidates.reduce((s, c) => s + c.capitalFreedSats, 0);

  return { windowDays: 60, candidates, protectedCount, totalCapitalFreedSats };
}
