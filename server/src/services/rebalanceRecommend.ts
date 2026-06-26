import { type AuthenticatedLnd } from "lightning";
import { getChannelsView, type ChannelRole, type ChannelView } from "./channels.js";
import { getOwnPubkey } from "./node.js";
import { estimateCost } from "./rebalance.js";
import {
  getFeeRecommendations,
  type CooldownInput,
  type FeeRecConfig,
  type FeeRecommendation,
  type FeeRecState,
} from "./feeRecommend.js";
import type { RebalanceRecord } from "./rebalanceLog.js";
import type { OverrideMap } from "./overrides.js";

/**
 * Rebalance Autopilot v1 — recommendation engine (dry-run only; no payments).
 *
 * Builds on the existing profit-gated engine (it reuses `estimateCost`) and the
 * Fee Autopilot v2 output per channel. Core rule: rebalance only when it pays
 * back, and never refill liquidity that Fee v2 says is being sold too cheaply —
 * the fee-adjust-first guard. Every decision is explained.
 */

export interface RebalanceRecConfig {
  econRatio: number;
  profitShare: number;
  maxPaybackDays: number;
  minExpectedNetProfitSats: number;
  demandCoverageMultiplier: number;
  maxCapacityRefillRatio: number;
  minRebalanceAmount: number;
  maxRebalanceAmountPerChannel: number;
  targetDeficitThreshold: number;
  sourceExcessThreshold: number;
  feeAdjustFirstRelativeThreshold: number;
  minRevenuePpm: number;
  newChannelProtectionDays: number;
  /** Cap on how many candidates we actually probe a route for. */
  maxCandidates: number;
  /** Generous ceiling for the probe so we can report cost even when too pricey. */
  probeCeilingPpm: number;
}

export const REBAL_REC_DEFAULTS: RebalanceRecConfig = {
  econRatio: 0.8,
  profitShare: 0.5,
  maxPaybackDays: 21,
  minExpectedNetProfitSats: 100,
  demandCoverageMultiplier: 1.5,
  maxCapacityRefillRatio: 0.25,
  minRebalanceAmount: 50_000,
  maxRebalanceAmountPerChannel: 2_000_000,
  targetDeficitThreshold: 0.2,
  sourceExcessThreshold: 0.2,
  feeAdjustFirstRelativeThreshold: 0.2,
  minRevenuePpm: 100,
  newChannelProtectionDays: 3,
  maxCandidates: 8,
  probeCeilingPpm: 3000,
};

export type RebalanceRecState =
  | "not_needed"
  | "watching"
  | "fee_adjust_first"
  | "profitable_rebalance_candidate"
  | "route_found_profitable"
  | "route_found_too_expensive"
  | "unprofitable_skip"
  | "close_candidate";

export interface SourceCandidate {
  channelId: string;
  alias: string;
  localRatio: number;
  reason: string;
  rejected?: boolean;
  rejectedReason?: string;
}

export interface RebalanceRecommendation {
  channelId: string;
  alias: string;
  role: ChannelRole;
  state: RebalanceRecState;
  wouldRebalance: boolean;
  blockedBy: string[];
  reasons: string[];

  localRatio: number;
  targetLocalRatio: number;
  capacity: number;
  currentPpm: number;
  feeV2TargetPpm: number | null;
  feeV2State: FeeRecState | null;
  profitFloorPpm: number | null;

  routedOut14d: number;
  routedIn14d: number;
  routedOut30d: number;
  routedIn30d: number;
  netDrain14d: number;
  grossFlow14d: number;

  revenue14d: number;
  revenue30d: number;
  revenuePpm14d: number | null;
  revenuePpm30d: number | null;
  expectedRevenuePpm: number | null;

  avgDailyRevenueSats: number;
  maxCostPpm: number | null;
  maxCostSatsByPayback: number | null;
  maxPaybackDays: number;

  recommendedAmount: number | null;
  amountToReachTargetLocalRatio: number;
  demandSizedAmount: number;

  sourceCandidates: SourceCandidate[];
  selectedSourceChannel: string | null;

  estimatedRouteFeeSats: number | null;
  estimatedRouteCostPpm: number | null;
  expectedPaybackDays: number | null;
  expectedNetProfitSats: number | null;
}

export interface RebalanceRecSummary {
  totalCandidates: number;
  profitableRecommendations: number;
  feeAdjustFirstCount: number;
  tooExpensiveCount: number;
  closeCandidateCount: number;
  expectedTotalCostSats: number;
  expectedTotalNetProfitSats: number;
}

export interface RebalanceRecReport {
  generatedAt: string;
  config: RebalanceRecConfig;
  summary: RebalanceRecSummary;
  recommendations: RebalanceRecommendation[];
}

const clamp0 = (n: number) => Math.max(0, Math.round(n));

/** Channels we may safely pull liquidity FROM (idle excess, not a good earner). */
function buildSourcePool(
  active: ChannelView[],
  feeById: Map<string, FeeRecommendation>,
  overrides: OverrideMap,
  cfg: RebalanceRecConfig,
): ChannelView[] {
  return active
    .filter((c) => {
      if (overrides[c.id]?.mode === "exclude") return false;
      const fee = feeById.get(c.id);
      const target = fee?.metrics.targetLocalRatio ?? 0.5;
      if (c.localRatio < target + cfg.sourceExcessThreshold) return false; // not enough excess
      if (fee?.state === "protecting_liquidity" || fee?.state === "recovering_cost") return false;
      if (fee?.metrics.isTopEarner) return false;
      if ((fee?.metrics.netDrain14d ?? 0) > 0.1) return false; // actively draining — leave it
      return true;
    })
    // fullest + most idle first (best donors)
    .sort((a, b) => {
      const fa = feeById.get(a.id)?.metrics.grossFlow14d ?? 0;
      const fb = feeById.get(b.id)?.metrics.grossFlow14d ?? 0;
      return b.localRatio - a.localRatio || fa - fb;
    });
}

export async function getRebalanceRecommendations(
  lnd: AuthenticatedLnd,
  rebalanceRecords: RebalanceRecord[],
  cooldown: CooldownInput | null,
  feeConfigOverrides: Partial<FeeRecConfig> = {},
  channelOverrides: OverrideMap = {},
  recOverrides: Partial<RebalanceRecConfig> = {},
): Promise<RebalanceRecReport> {
  const cfg = { ...REBAL_REC_DEFAULTS, ...recOverrides };
  const [feeRep, channels, ownKey] = await Promise.all([
    getFeeRecommendations(lnd, rebalanceRecords, cooldown, feeConfigOverrides, channelOverrides),
    getChannelsView(lnd),
    getOwnPubkey(lnd),
  ]);
  const feeById = new Map(feeRep.recommendations.map((r) => [r.channelId, r]));
  const chById = new Map(channels.map((c) => [c.id, c]));
  const active = channels.filter((c) => c.active);
  const sourcePool = buildSourcePool(active, feeById, channelOverrides, cfg);

  const recs = active.map((ch) => classify(ch, feeById.get(ch.id), sourcePool, chById, cfg, channelOverrides));

  // Probe routes only for the channels that cleared every economic gate.
  const toProbe = recs
    .filter((r) => r.state === "profitable_rebalance_candidate" && r.selectedSourceChannel && r.recommendedAmount)
    .slice(0, cfg.maxCandidates);
  await Promise.all(toProbe.map((r) => probe(r, lnd, ownKey, chById, cfg)));

  const summary: RebalanceRecSummary = {
    totalCandidates: recs.filter((r) => r.state !== "not_needed").length,
    profitableRecommendations: recs.filter((r) => r.state === "route_found_profitable").length,
    feeAdjustFirstCount: recs.filter((r) => r.state === "fee_adjust_first").length,
    tooExpensiveCount: recs.filter((r) => r.state === "route_found_too_expensive").length,
    closeCandidateCount: recs.filter((r) => r.state === "close_candidate").length,
    expectedTotalCostSats: recs.reduce((s, r) => s + (r.wouldRebalance ? r.estimatedRouteFeeSats ?? 0 : 0), 0),
    expectedTotalNetProfitSats: recs.reduce((s, r) => s + (r.wouldRebalance ? r.expectedNetProfitSats ?? 0 : 0), 0),
  };

  return { generatedAt: new Date().toISOString(), config: cfg, summary, recommendations: recs };
}

function classify(
  ch: ChannelView,
  fee: FeeRecommendation | undefined,
  sourcePool: ChannelView[],
  chById: Map<string, ChannelView>,
  cfg: RebalanceRecConfig,
  overrides: OverrideMap,
): RebalanceRecommendation {
  const m = fee?.metrics;
  const targetLocalRatio = m?.targetLocalRatio ?? 0.5;
  const settled = ch.localBalance + ch.remoteBalance;
  const amountToTarget = clamp0(targetLocalRatio * settled - ch.localBalance);
  const routedOut14d = m?.routedOut14d ?? 0;
  const routedIn14d = m?.routedIn14d ?? 0;
  const expectedNetDrain14d = Math.max(0, routedOut14d - routedIn14d);
  const demandSizedAmount = clamp0(
    Math.min(
      expectedNetDrain14d * cfg.demandCoverageMultiplier,
      ch.capacity * cfg.maxCapacityRefillRatio,
      cfg.maxRebalanceAmountPerChannel,
    ),
  );
  const revenue30d = m?.revenue30d ?? 0;
  const avgDailyRevenueSats = Math.round(revenue30d / 30);

  const rec: RebalanceRecommendation = {
    channelId: ch.id,
    alias: ch.peerAlias || ch.id,
    role: ch.role,
    state: "not_needed",
    wouldRebalance: false,
    blockedBy: [],
    reasons: [],
    localRatio: ch.localRatio,
    targetLocalRatio,
    capacity: ch.capacity,
    currentPpm: fee?.currentPpm ?? 0,
    feeV2TargetPpm: fee?.targetPpm ?? null,
    feeV2State: fee?.state ?? null,
    profitFloorPpm: m?.profitFloorPpm ?? null,
    routedOut14d,
    routedIn14d,
    routedOut30d: m?.routedOut30d ?? 0,
    routedIn30d: m?.routedIn30d ?? 0,
    netDrain14d: m?.netDrain14d ?? 0,
    grossFlow14d: m?.grossFlow14d ?? 0,
    revenue14d: m?.revenue14d ?? 0,
    revenue30d,
    revenuePpm14d: m?.revenuePpm14d ?? null,
    revenuePpm30d: m?.revenuePpm30d ?? null,
    expectedRevenuePpm: null,
    avgDailyRevenueSats,
    maxCostPpm: null,
    maxCostSatsByPayback: null,
    maxPaybackDays: cfg.maxPaybackDays,
    recommendedAmount: null,
    amountToReachTargetLocalRatio: amountToTarget,
    demandSizedAmount,
    sourceCandidates: [],
    selectedSourceChannel: null,
    estimatedRouteFeeSats: null,
    estimatedRouteCostPpm: null,
    expectedPaybackDays: null,
    expectedNetProfitSats: null,
  };

  // not drained enough → nothing to do
  if (targetLocalRatio - ch.localRatio < cfg.targetDeficitThreshold) {
    rec.state = "not_needed";
    rec.reasons.push(`local ${Math.round(ch.localRatio * 100)}% is within ${Math.round(cfg.targetDeficitThreshold * 100)}% of target — no refill needed`);
    return rec;
  }

  // §6 dead / weak-peer target → close candidate, never rebalance
  if (fee?.state === "close_candidate" || m?.peerGate === "weak") {
    rec.state = "close_candidate";
    rec.blockedBy.push("weak peer / no 30d flow");
    rec.reasons.push("drained but weak peer / no proven 30d flow — not refilling a dead channel; consider closing");
    return rec;
  }

  // new channel without history
  if (m?.channelAgeDays != null && m.channelAgeDays < cfg.newChannelProtectionDays) {
    rec.state = "watching";
    rec.reasons.push(`new channel (${m.channelAgeDays}d) — not enough history to prove a profitable refill`);
    return rec;
  }

  // §1 fee-adjust-first — the heart
  const feeIncreaseNeeded =
    fee?.targetPpm != null && rec.currentPpm > 0 && fee.targetPpm > rec.currentPpm * (1 + cfg.feeAdjustFirstRelativeThreshold);
  const belowProfitFloor = rec.profitFloorPpm != null && rec.currentPpm < rec.profitFloorPpm;
  if (feeIncreaseNeeded || belowProfitFloor || fee?.state === "recovering_cost" || fee?.state === "protecting_liquidity") {
    rec.state = "fee_adjust_first";
    rec.blockedBy.push("fee below target / profit floor");
    rec.reasons.push(
      `channel is draining, but its fee is below target/profit floor (now ${rec.currentPpm} ppm` +
        `${fee?.targetPpm != null ? `, target ${fee.targetPpm}` : ""}${rec.profitFloorPpm != null ? `, floor ${rec.profitFloorPpm}` : ""}` +
        `) — raise the fee before buying liquidity back`,
    );
    return rec;
  }

  // §2 conservative expected revenue
  if (!rec.revenuePpm30d || revenue30d <= 0 || rec.revenuePpm30d < cfg.minRevenuePpm) {
    rec.state = "watching";
    rec.reasons.push("missing / low revenue history — can't prove a profitable rebalance yet");
    return rec;
  }
  const expectedRevenuePpm = Math.round(
    Math.min(rec.revenuePpm30d, rec.currentPpm || rec.revenuePpm30d, fee?.targetPpm ?? Infinity),
  );
  rec.expectedRevenuePpm = expectedRevenuePpm;
  rec.maxCostPpm = Math.round(expectedRevenuePpm * cfg.profitShare);
  rec.maxCostSatsByPayback = Math.round(avgDailyRevenueSats * cfg.maxPaybackDays);

  if (avgDailyRevenueSats <= 0) {
    rec.state = "watching";
    rec.reasons.push("no measurable daily revenue — can't estimate payback");
    return rec;
  }

  // §5 demand-sized amount
  const recommendedAmount = clamp0(Math.min(amountToTarget || demandSizedAmount, demandSizedAmount));
  if (recommendedAmount < cfg.minRebalanceAmount) {
    rec.state = "watching";
    rec.reasons.push(`demand too small (${Math.round(recommendedAmount / 1000)}k) for an economical rebalance`);
    return rec;
  }
  rec.recommendedAmount = recommendedAmount;

  // §7 pick a source (and record a few candidates / rejections)
  const picks = sourcePool.filter((s) => s.id !== ch.id);
  rec.sourceCandidates = picks.slice(0, 3).map((s) => ({
    channelId: s.id,
    alias: s.peerAlias,
    localRatio: s.localRatio,
    reason: "idle excess liquidity, below benchmark",
  }));
  // surface a rejected top earner if one was excluded, for transparency
  if (!picks.length) {
    rec.state = "unprofitable_skip";
    rec.blockedBy.push("no safe source channel");
    rec.reasons.push("no idle source channel to pull from (won't drain top earners / protected channels)");
    return rec;
  }
  rec.selectedSourceChannel = picks[0].id;
  rec.state = "profitable_rebalance_candidate";
  rec.reasons.push(
    `drained ${Math.round(ch.localRatio * 100)}% with proven demand and ${expectedRevenuePpm} ppm earnings — checking a route from ${picks[0].peerAlias}`,
  );
  return rec;
}

async function probe(
  rec: RebalanceRecommendation,
  lnd: AuthenticatedLnd,
  ownKey: string,
  chById: Map<string, ChannelView>,
  cfg: RebalanceRecConfig,
): Promise<void> {
  const source = rec.selectedSourceChannel ? chById.get(rec.selectedSourceChannel) : undefined;
  const target = chById.get(rec.channelId);
  const amount = rec.recommendedAmount;
  if (!source || !target || !amount) return;

  // probe at a generous ceiling so we report an honest cost even when too pricey
  const { costPpm, feeSats } = await estimateCost(lnd, ownKey, source, target, amount, cfg.probeCeilingPpm);
  rec.estimatedRouteCostPpm = costPpm;
  rec.estimatedRouteFeeSats = feeSats;

  if (costPpm == null || feeSats == null) {
    rec.state = "route_found_too_expensive";
    rec.blockedBy.push("no route within budget");
    rec.reasons.push("no route found within the probe ceiling — try a smaller amount or run it manually");
    return;
  }

  rec.expectedPaybackDays = rec.avgDailyRevenueSats > 0 ? Math.round((feeSats / rec.avgDailyRevenueSats) * 10) / 10 : null;
  const earnings = Math.round((Math.min(amount, Math.max(0, rec.routedOut14d - rec.routedIn14d) || amount) * (rec.expectedRevenuePpm ?? 0)) / 1_000_000);
  rec.expectedNetProfitSats = earnings - feeSats;

  const tooPricey = (rec.maxCostPpm != null && costPpm > rec.maxCostPpm) || (rec.maxCostSatsByPayback != null && feeSats > rec.maxCostSatsByPayback);
  if (tooPricey) {
    rec.state = "route_found_too_expensive";
    rec.blockedBy.push("route above max cost / payback limit");
    rec.reasons.push(
      `route costs ${costPpm} ppm (max ${rec.maxCostPpm})` +
        (rec.expectedPaybackDays != null ? `, payback ~${rec.expectedPaybackDays}d (limit ${cfg.maxPaybackDays}d)` : "") +
        " — too expensive to be worth it",
    );
    return;
  }
  if ((rec.expectedNetProfitSats ?? 0) < cfg.minExpectedNetProfitSats) {
    rec.state = "unprofitable_skip";
    rec.blockedBy.push("net profit below minimum");
    rec.reasons.push(`expected net profit ${rec.expectedNetProfitSats} sat is below the ${cfg.minExpectedNetProfitSats} sat minimum`);
    return;
  }

  rec.state = "route_found_profitable";
  rec.wouldRebalance = true;
  rec.reasons.push(
    `profitable: route ${costPpm} ppm ≤ max ${rec.maxCostPpm}, payback ~${rec.expectedPaybackDays}d, expected net +${rec.expectedNetProfitSats} sat`,
  );
}
