import { type AuthenticatedLnd } from "lightning";
import { type ChannelRole, type ChannelView } from "./channels.js";
import { getOwnPubkey } from "./node.js";
import { DEFAULT_REBALANCE_POLICY, adaptiveAmounts, estimateCost, feeCapAt } from "./rebalance.js";
import {
  feeAfterRefill,
  runFeeEngine,
  type BuildCtx,
  type FeeEngineInputs,
  type FeeRecommendation,
  type FeeRecState,
} from "./feeRecommend.js";
import { leaseRunning, type SoldLease } from "./leaseCaps.js";
import { standardChannelId } from "./leases.js";
import type { OverrideMap } from "./overrides.js";

/**
 * Rebalance Autopilot — recommendation engine (dry-run only; no payments).
 *
 * Core rule: refill a drained channel only when it pays back, and never refill
 * liquidity the fee engine says is being sold too cheaply (fee-adjust-first).
 * The gate values the refilled sats at the fee the fee engine will actually
 * charge after the refill — asked of the engine itself (feeAfterRefill) —
 * and the engine keeps that fee while the refilled sats are in the channel
 * (the refill's hold, feeRecommend.ts refillLots), so the two agree (review
 * a2: the gate valued refills at the drained channel's fee and the engine
 * cut it right after). Sources are channels with idle excess the node can
 * spare: never new, private, sold or draining ones, never the best earner,
 * and never more than they hold above their own share. Every decision is
 * explained, including what a drained channel would need to clear the gate.
 */

export interface RebalanceRecConfig {
  /** The most a refill's route may cost, as a share of what the refilled
   *  liquidity is expected to earn (the autopilot's econRatio). */
  profitShare: number;
  maxPaybackDays: number;
  minExpectedNetProfitSats: number;
  demandCoverageMultiplier: number;
  maxCapacityRefillRatio: number;
  minRebalanceAmount: number;
  maxRebalanceAmountPerChannel: number;
  targetDeficitThreshold: number;
  sourceExcessThreshold: number;
  minRevenuePpm: number;
  newChannelProtectionDays: number;
  /** A channel younger than this is never a source (it hasn't shown how it
   *  routes yet — a fresh channel at ~100 % local ranked first). */
  sourceMinAgeDays: number;
  /** A source keeps its own target share plus this much of its balance. */
  sourceKeepMargin: number;
  /** Sources tried per target, in order (the next only when no route pays). */
  maxSourcesPerTarget: number;
  /** Cap on how many candidates we actually probe a route for. */
  maxCandidates: number;
  /** Generous ceiling for the probe so we can report cost even when too pricey. */
  probeCeilingPpm: number;
}

export const REBAL_REC_DEFAULTS: RebalanceRecConfig = {
  profitShare: DEFAULT_REBALANCE_POLICY.econRatio,
  maxPaybackDays: DEFAULT_REBALANCE_POLICY.maxPaybackDays,
  minExpectedNetProfitSats: DEFAULT_REBALANCE_POLICY.minNetProfitSats,
  demandCoverageMultiplier: 1.5,
  maxCapacityRefillRatio: 0.25,
  minRebalanceAmount: 50_000,
  maxRebalanceAmountPerChannel: DEFAULT_REBALANCE_POLICY.maxAmountSats,
  targetDeficitThreshold: 0.2,
  sourceExcessThreshold: 0.2,
  // Only require SOME proven outbound earnings (≥ the fee floor). A flat 100 ppm
  // here structurally excluded volume-first channels (priced 25–80 to win flow)
  // from ever being refilled, even when a cheap route made the refill profitable.
  // The real profitability check is the per-route economic gate (maxCostPpm /
  // payback / net profit) in probe(), which correctly rejects channels too cheap
  // to refill — so this pre-filter only needs to prove the channel earns at all.
  minRevenuePpm: 25,
  newChannelProtectionDays: 3,
  sourceMinAgeDays: 14,
  sourceKeepMargin: 0.05,
  maxSourcesPerTarget: 3,
  maxCandidates: 8,
  probeCeilingPpm: 3000,
};

export interface RebalancePlan {
  /** The moves to make now, best first. */
  run: RebalanceRecommendation[];
  /** Left for the daily budget: what is left is below their estimated fee.
   *  Informational (D15) — not failed runs. */
  skipped: { rec: RebalanceRecommendation; reason: string }[];
  /** Profitable, but beyond this run's per-run limit: a later run's. */
  later: RebalanceRecommendation[];
}

/**
 * Pure planning step for the autopilot's rebalance execution. Orders the
 * already-eligible recommendations by expected net profit (so the run's slots
 * and the daily budget go to the BEST moves first), then walks the WHOLE list
 * until `maxPerRun` moves fit the budget left: a move whose estimated fee
 * doesn't fit is skipped, and a cheaper one behind it still runs (review a2:
 * the list was cut to maxPerRun before the budget check — with one slot and
 * 1,000 sat left, a 1,500-sat best move blocked a 200-sat one that fit). The
 * executor still caps each payment at the budget actually left.
 */
export function selectRebalanceRuns(
  eligible: RebalanceRecommendation[],
  opts: { dailyBudgetSats: number; alreadySpentSats: number; maxPerRun: number },
): RebalancePlan {
  const ordered = [...eligible].sort((a, b) => (b.expectedNetProfitSats ?? 0) - (a.expectedNetProfitSats ?? 0));
  const run: RebalanceRecommendation[] = [];
  const skipped: { rec: RebalanceRecommendation; reason: string }[] = [];
  const later: RebalanceRecommendation[] = [];
  const slots = Math.max(0, opts.maxPerRun);
  let projectedSpend = opts.alreadySpentSats;
  for (const rec of ordered) {
    if (run.length >= slots) {
      later.push(rec);
      continue;
    }
    const remaining = opts.dailyBudgetSats > 0 ? opts.dailyBudgetSats - projectedSpend : Infinity;
    const estFee = rec.estimatedRouteFeeSats ?? 0;
    if (remaining < estFee) {
      skipped.push({
        rec,
        reason: `${Math.max(0, remaining)} sat left of the ${opts.dailyBudgetSats} sat daily budget — too little for this move (~${estFee} sat)`,
      });
      continue; // a cheaper later move may still fit
    }
    run.push(rec);
    projectedSpend += estFee; // project with the estimate so later moves see it shrink
  }
  return { run, skipped, later };
}

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
  /** What it can give and still keep its own share (sat), after the moves
   *  planned before this one from it. */
  spareSats: number;
  /** The local ratio it keeps (its target share + a margin). */
  keepRatio: number;
  reason: string;
  /** Probed and no route passed the gate from it (the executor skips it). */
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
  /** The fee engine's next move for this channel … */
  feeV2TargetPpm: number | null;
  /** … and where it is heading (the target is one bounded step toward it). */
  feeV2AimPpm: number | null;
  feeV2State: FeeRecState | null;
  profitFloorPpm: number | null;

  routedOut14d: number;
  routedIn14d: number;
  routedOut30d: number;
  routedIn30d: number;
  netDrain14d: number;
  grossFlow14d: number;
  /** De-noised refused HTLCs (possible demand, D20), 14 days. */
  refusedSats14d: number;
  inDemand: boolean;

  revenue14d: number;
  revenue30d: number;
  revenuePpm14d: number | null;
  revenuePpm30d: number | null;
  /** The estimate before the refill (ppm): the lowest of what the channel
   *  earned, charges and is heading to. */
  preRefillPpm: number | null;
  /** What the gate values the refilled sats at (ppm): the estimate before
   *  the refill — or, where the fee engine charges less after it (a pin, a
   *  lease promise), that fee (postRefillPpm). */
  expectedRevenuePpm: number | null;
  /** Where the fee engine takes the fee after this refill (its aim), the
   *  refill's hold included. Null until a route was probed. */
  postRefillPpm: number | null;

  avgDailyRevenueSats: number;
  maxCostPpm: number | null;
  maxCostSatsByPayback: number | null;
  maxPaybackDays: number;
  /** The gate's earnings are capped at this outflow (14 days, sat). */
  earningDemandSats: number;
  /** The gate's minimum expected net profit (sat). */
  minNetProfitSats: number;
  /** The most this move may pay in routing fees and still pass the gate
   *  (sat) — the payment's cap (feeCapAt). */
  maxFeeSats: number | null;

  recommendedAmount: number | null;
  amountToReachTargetLocalRatio: number;
  demandSizedAmount: number;

  /** Sources to try, in order (the selected one first). */
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

/**
 * Refilling OUTBOUND on a drained channel: a rebalance (what routes cost right
 * now) or raising the fee and letting flow refill it (free, slower). (It used
 * to compare a rebalance's cost with a Magma lease price — inbound on a NEW
 * channel, a different thing altogether.)
 */
export interface RefillNote {
  /** Median route cost of the refills probed now (ppm). */
  routeTypicalPpm: number | null;
  /** Drained channels the fee engine is raising first. */
  feeFirstCount: number;
  note: string;
}

export interface RebalanceRecReport {
  /** When the plan was made — before its inputs were read. A manual run
   *  from it sends this back (planAt) and is refused once its target was
   *  refilled since. */
  generatedAt: string;
  config: RebalanceRecConfig;
  summary: RebalanceRecSummary;
  refill: RefillNote;
  recommendations: RebalanceRecommendation[];
}

const clamp0 = (n: number) => Math.max(0, Math.round(n));
const k = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 10_000) / 100}M` : `${Math.round(n / 1000)}k`);
const pct = (n: number) => `${Math.round(n * 100)}%`;

/** A channel that may give liquidity, and how much. */
export interface SourceInfo {
  ch: ChannelView;
  /** What it holds above its own share (target ratio + margin), sat. */
  spareSats: number;
  keepRatio: number;
  grossFlow14d: number;
}

/**
 * Channels we may safely pull liquidity FROM: idle excess the node can spare.
 * Never (review a2, naive-source-selection):
 *  - one younger than sourceMinAgeDays — a fresh channel sits at ~100 % local
 *    with no flow and ranked FIRST, though it hasn't shown how it routes;
 *  - a private one — a wallet's channel routes nothing back, so every target
 *    read "no route found at any size";
 *  - one sold through Magma or LSPS1 in its lease — its balance is the
 *    buyer's inbound;
 *  - one that drains at all (net outflow in 14 days) — today's source is
 *    next week's paid refill;
 *  - a top earner, and the single best earner on any node (the top-earner
 *    flag needs five channels; small nodes had none);
 *  - one protecting its liquidity or recovering a refill's cost.
 * Each gives at most its spare: its balance above its own target ratio plus
 * a margin.
 */
export function buildSourcePool(
  active: ChannelView[],
  feeById: Map<string, FeeRecommendation>,
  overrides: OverrideMap,
  cfg: RebalanceRecConfig,
  ctx: { soldLeases: readonly SoldLease[]; currentBlock: number },
): SourceInfo[] {
  const revenue = (c: ChannelView) => feeById.get(c.id)?.metrics.revenue30d ?? 0;
  const best = active.reduce<ChannelView | null>((top, c) => (revenue(c) > (top ? revenue(top) : 0) ? c : top), null);
  // By outpoint, or — for a sale only Amboss knows of — by the channel it names.
  const sold = (c: ChannelView) =>
    ctx.soldLeases.some(
      (l) =>
        (l.fundingOutpoint === `${c.transactionId}:${c.transactionVout}` || (!!l.channelId && standardChannelId(l.channelId) === c.id)) &&
        leaseRunning(l, c.id, ctx.currentBlock),
    );
  return active
    .flatMap((c): SourceInfo[] => {
      if (overrides[c.id]?.mode === "exclude") return [];
      const fee = feeById.get(c.id);
      if (!fee) return [];
      const m = fee.metrics;
      const target = m.targetLocalRatio ?? 0.5;
      if (c.private) return [];
      if (m.channelAgeDays == null || m.channelAgeDays < cfg.sourceMinAgeDays) return [];
      if (sold(c)) return [];
      if (c.localRatio < target + cfg.sourceExcessThreshold) return []; // not enough excess
      if (fee.state === "protecting_liquidity" || fee.state === "recovering_cost") return [];
      if (m.isTopEarner || c.id === best?.id) return [];
      if (m.netDrain14d > 0) return []; // draining — leave it
      const keepRatio = target + cfg.sourceKeepMargin;
      const spareSats = c.localBalance - Math.round(keepRatio * (c.localBalance + c.remoteBalance));
      if (spareSats < cfg.minRebalanceAmount) return [];
      return [{ ch: c, spareSats, keepRatio, grossFlow14d: m.grossFlow14d }];
    })
    // the most to spare, then the most idle (best donors)
    .sort((a, b) => b.spareSats - a.spareSats || a.grossFlow14d - b.grossFlow14d);
}

/** One channel's refill decision up to the source and route — pure
 *  (exported for tests). */
export function classify(ch: ChannelView, fee: FeeRecommendation | undefined, cfg: RebalanceRecConfig, overrides: OverrideMap): RebalanceRecommendation {
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
    feeV2AimPpm: fee?.aimPpm ?? null,
    feeV2State: fee?.state ?? null,
    profitFloorPpm: m?.profitFloorPpm ?? null,
    routedOut14d,
    routedIn14d,
    routedOut30d: m?.routedOut30d ?? 0,
    routedIn30d: m?.routedIn30d ?? 0,
    netDrain14d: m?.netDrain14d ?? 0,
    grossFlow14d: m?.grossFlow14d ?? 0,
    refusedSats14d: m?.refusedSats14d ?? 0,
    inDemand: m?.inDemand ?? false,
    revenue14d: m?.revenue14d ?? 0,
    revenue30d,
    revenuePpm14d: m?.revenuePpm14d ?? null,
    revenuePpm30d: m?.revenuePpm30d ?? null,
    preRefillPpm: null,
    expectedRevenuePpm: null,
    postRefillPpm: null,
    avgDailyRevenueSats,
    maxCostPpm: null,
    maxCostSatsByPayback: null,
    maxPaybackDays: cfg.maxPaybackDays,
    // Earnings are capped at what the channel really routed out: refused
    // HTLCs (possible demand, D20) are shown, never counted as income.
    earningDemandSats: routedOut14d,
    minNetProfitSats: cfg.minExpectedNetProfitSats,
    maxFeeSats: null,
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
    rec.reasons.push(`local ${pct(ch.localRatio)} is within ${pct(cfg.targetDeficitThreshold)} of target — no refill needed`);
    return rec;
  }

  // excluded from the autopilot (manual) → visible but never auto-rebalanced
  if (overrides[ch.id]?.mode === "exclude") {
    rec.state = "watching";
    rec.blockedBy.push("excluded (manual)");
    rec.reasons.push("excluded from the autopilot — not auto-rebalancing this channel");
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

  // §1 fee-adjust-first — but ONLY when refilling would be UNPROFITABLE at the
  // current price, i.e. the outbound fee is below this channel's own floor
  // (what the refills still in it cost × the margin, or the price a refill
  // was paid for). Then raising the fee must come first — buying liquidity
  // back to route it out below cost just loses money each cycle. We
  // deliberately do NOT block here merely because the channel is draining,
  // is in "protect" mode, or the fee engine wants a higher price: a
  // PROFITABLE refill that keeps serving demand beats choking it with a
  // higher fee. Whether it's actually profitable is decided by the per-route
  // economic gate below; the fee engine still raises the fee in parallel on
  // its own track.
  const belowRefillCost = rec.profitFloorPpm != null && rec.currentPpm < rec.profitFloorPpm;
  if (belowRefillCost) {
    rec.state = "fee_adjust_first";
    rec.blockedBy.push("fee below refill-cost floor");
    rec.reasons.push(
      `draining, but the current fee (${rec.currentPpm} ppm) is below this channel's refill-cost floor` +
        ` (${rec.profitFloorPpm} ppm) — raising the fee must come first, else you'd route it back out below cost`,
    );
    return rec;
  }

  // §2 conservative expected revenue
  if (!rec.revenuePpm30d || revenue30d <= 0 || rec.revenuePpm30d < cfg.minRevenuePpm) {
    rec.state = "watching";
    rec.reasons.push("missing / low revenue history — can't prove a profitable rebalance yet");
    return rec;
  }
  // Conservative: the lowest of what it earned, what it charges, and where
  // the fee engine is taking it. The engine's target is only this update's
  // bounded step (P2): on the way from 900 to 400 ppm it reads 870 — the
  // refill would be budgeted on a fee the channel is leaving. The aim is
  // where it ends up. (The probe then asks the engine where the fee goes
  // AFTER the refill, and values the moved sats at no more than that.)
  const expectedRevenuePpm = Math.round(
    Math.min(rec.revenuePpm30d, rec.currentPpm || rec.revenuePpm30d, fee?.targetPpm ?? Infinity, fee?.aimPpm ?? Infinity),
  );
  rec.preRefillPpm = expectedRevenuePpm;
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
  rec.state = "profitable_rebalance_candidate";
  rec.reasons.push(`drained ${pct(ch.localRatio)} with proven demand and ${expectedRevenuePpm} ppm earnings — looking for a source and a route`);
  return rec;
}

/** A route's cost from `source` into `target` for `amountSats`, as the graph
 *  says (no payment). */
export type RouteProbe = (source: ChannelView, target: ChannelView, amountSats: number) => Promise<{ costPpm: number | null; feeSats: number | null }>;

/** One amount's route and what the gate makes of it. */
interface Probed {
  amount: number;
  costPpm: number;
  feeSats: number;
  /** The fee engine's aim after this refill. */
  postPpm: number;
  /** What the gate values the moved sats at (ppm). */
  value: number;
  maxCostPpm: number;
  /** The gate's fee cap at this amount (sat). */
  maxFeeSats: number;
  net: number;
  paybackDays: number | null;
  passes: boolean;
}

/**
 * Route costs from one source at the planned amount and two smaller ones, and
 * the gate for each: the moved sats are valued at the lower of the drained
 * channel's earnings estimate and the fee the engine takes it to after the
 * refill (its own rules, the refill's hold included) — and a route passes
 * only when its fee is within feeCapAt, the same cap the payment carries.
 */
async function probeSource(
  rec: RebalanceRecommendation,
  target: ChannelView,
  source: ChannelView,
  amount: number,
  ctx: BuildCtx | undefined,
  cfg: RebalanceRecConfig,
  probeRoute: RouteProbe,
): Promise<Probed[]> {
  const h0 = rec.preRefillPpm ?? 0;
  const amounts = adaptiveAmounts(amount).filter((a) => a >= cfg.minRebalanceAmount);
  const probes = await Promise.all(
    amounts.map(async (a): Promise<Probed | null> => {
      const { costPpm, feeSats } = await probeRoute(source, target, a);
      if (costPpm == null || feeSats == null) return null;
      const postPpm = ctx ? feeAfterRefill(target, ctx, { amountSats: a, feeSats, holdPpm: h0 }).aimPpm : h0;
      const value = Math.min(h0, postPpm);
      const maxCostPpm = Math.round(value * cfg.profitShare);
      const earnings = (Math.min(a, rec.earningDemandSats) * value) / 1_000_000;
      const maxFeeSats = feeCapAt(
        {
          maxCostPpm,
          maxFeeSats: rec.maxCostSatsByPayback,
          earnings: { revenuePpm: value, demandSats: rec.earningDemandSats, minNetSats: cfg.minExpectedNetProfitSats },
        },
        a,
      );
      return {
        amount: a,
        costPpm,
        feeSats,
        postPpm,
        value,
        maxCostPpm,
        maxFeeSats,
        net: Math.floor(earnings - feeSats),
        paybackDays: rec.avgDailyRevenueSats > 0 ? Math.round((feeSats / rec.avgDailyRevenueSats) * 10) / 10 : null,
        passes: maxFeeSats >= 1 && feeSats <= maxFeeSats,
      };
    }),
  );
  return probes.filter((p): p is Probed => p !== null);
}

/** Why the cheapest route from a source didn't pass. */
function rejection(p: Probed, rec: RebalanceRecommendation): string {
  if (p.costPpm > p.maxCostPpm) return `cheapest route ${p.costPpm} ppm, max ${p.maxCostPpm}`;
  if (rec.maxCostSatsByPayback != null && p.feeSats > rec.maxCostSatsByPayback) return `route fee ${p.feeSats} sat, payback limit ${rec.maxCostSatsByPayback} sat`;
  return `best net ${p.net} sat, below the ${rec.minNetProfitSats} sat minimum`;
}

/**
 * What a drained channel would need for a refill to clear the gate (review
 * a2, inert-settings-and-presets: "auto-rebalance on, nothing happens" must be
 * explained, not look broken). From its earnings (r), a route cost (c — the
 * probed one, else the market's replacement cost), the largest refill the
 * caps allow and the minimum net profit.
 */
export function wouldTake(
  rec: RebalanceRecommendation,
  cfg: RebalanceRecConfig,
  replacementCostPpm: number | null,
): string | null {
  const r = rec.expectedRevenuePpm ?? rec.revenuePpm30d;
  const minNet = cfg.minExpectedNetProfitSats;
  const largest = Math.round(Math.min(rec.capacity * cfg.maxCapacityRefillRatio, cfg.maxRebalanceAmountPerChannel));
  if (!r || r <= 0) return `to clear the gate it first needs routed revenue (no outflow priced in 30 d)`;
  const c = rec.estimatedRouteCostPpm ?? replacementCostPpm;
  const head = `to clear the ${minNet} sat minimum`;
  if (c == null) {
    const margin = Math.ceil((minNet * 1_000_000) / largest);
    return `${head}, even a ${k(largest)} refill (the most this channel takes) needs a route at least ${margin} ppm below its ${r} ppm earnings, and at most ${Math.round(r * cfg.profitShare)} ppm`;
  }
  const needPpm = Math.max(Math.ceil(c / cfg.profitShare), Math.ceil(c + (minNet * 1_000_000) / largest));
  if (c > r * cfg.profitShare || r - c <= 0 || Math.ceil((minNet * 1_000_000) / (r - c)) > largest) {
    return `${head} at a ~${c} ppm route it needs earnings of ≥ ${needPpm} ppm (now ${r} ppm) on a refill of up to ${k(largest)}`;
  }
  const smallest = Math.ceil((minNet * 1_000_000) / (r - c));
  const drain = Math.max(0, rec.routedOut14d - rec.routedIn14d);
  return (
    `${head} at ${r} ppm earnings and a ~${c} ppm route it needs a refill of ≥ ${k(smallest)}: ` +
    `≥ ${k(smallest)} of 14-day outflow (now ${k(rec.routedOut14d)}) and ≥ ${k(Math.ceil(smallest / cfg.demandCoverageMultiplier))} of 14-day net drain (now ${k(drain)})`
  );
}

/** What planRebalances works from: one fee engine run, and the node. */
export interface PlanInput {
  channels: ChannelView[];
  fees: FeeRecommendation[];
  /** The engine's context per channel (feeAfterRefill). */
  contextOf: (channelId: string) => BuildCtx | undefined;
  cfg: RebalanceRecConfig;
  overrides: OverrideMap;
  soldLeases: readonly SoldLease[];
  currentBlock: number;
}

/**
 * The plan: every active channel classified; the drained ones that cleared
 * the pre-checks get sources in order of what a refill would earn — each
 * source's spare shrinks by the moves planned from it before (a run's moves
 * no longer all drained one stale pick) — and routes are probed source by
 * source until one passes the gate.
 */
export async function planRebalances(input: PlanInput, probeRoute: RouteProbe): Promise<Omit<RebalanceRecReport, "generatedAt" | "config">> {
  const { cfg, overrides } = input;
  const feeById = new Map(input.fees.map((r) => [r.channelId, r]));
  const chById = new Map(input.channels.map((c) => [c.id, c]));
  const active = input.channels.filter((c) => c.active);
  const pool = buildSourcePool(active, feeById, overrides, cfg, input);
  const recs = active.map((ch) => classify(ch, feeById.get(ch.id), cfg, overrides));

  // What each target's refill could earn: the most valuable get the sources
  // (and the probes) first; possible demand breaks a tie.
  const worth = (r: RebalanceRecommendation) => (r.expectedRevenuePpm ?? 0) * Math.min(r.recommendedAmount ?? 0, r.earningDemandSats);
  const order = recs
    .filter((r) => r.state === "profitable_rebalance_candidate")
    .sort((a, b) => worth(b) - worth(a) || Number(b.inDemand) - Number(a.inDemand));
  const planned = new Map<string, number>();
  let probed = 0;
  for (const rec of order) {
    const target = chById.get(rec.channelId) as ChannelView;
    const candidates = pool
      .filter((s) => s.ch.id !== rec.channelId)
      .map((s) => ({ s, spare: s.spareSats - (planned.get(s.ch.id) ?? 0) }))
      .filter((x) => x.spare >= cfg.minRebalanceAmount)
      .sort((a, b) => b.spare - a.spare || a.s.grossFlow14d - b.s.grossFlow14d)
      .slice(0, Math.max(1, cfg.maxSourcesPerTarget));
    if (candidates.length === 0) {
      rec.state = "unprofitable_skip";
      rec.blockedBy.push("no safe source channel");
      rec.reasons.push(
        pool.length
          ? "no source channel has enough to spare — the others' spare balance is already planned for refills before this one"
          : "no channel can give liquidity: a source must be ≥ 14 days old, public, not sold on Magma/LSP, not draining, not the best earner, with idle balance above its own share",
      );
      continue;
    }
    if (probed >= cfg.maxCandidates) {
      rec.reasons.push(`not probed this time — only the ${cfg.maxCandidates} most valuable drained channels are`);
      continue;
    }
    probed += 1;
    rec.sourceCandidates = candidates.map(({ s, spare }) => ({
      channelId: s.ch.id,
      alias: s.ch.peerAlias || s.ch.id,
      localRatio: s.ch.localRatio,
      spareSats: spare,
      keepRatio: s.keepRatio,
      reason: `${pct(s.ch.localRatio)} local, ${k(spare)} to spare above its ${pct(s.keepRatio)} share, not draining`,
    }));
    const ctx = input.contextOf(rec.channelId);
    let best: { p: Probed; i: number } | null = null;
    for (const [i, c] of candidates.entries()) {
      const found = await probeSource(rec, target, c.s.ch, Math.min(rec.recommendedAmount as number, c.spare), ctx, cfg, probeRoute);
      const cand = rec.sourceCandidates[i];
      if (found.length === 0) {
        cand.rejected = true;
        cand.rejectedReason = "no route at any size within the probe ceiling";
        continue;
      }
      // best passing route by net profit; otherwise the cheapest, for transparency
      const passing = found.filter((p) => p.passes).sort((a, b) => b.net - a.net);
      if (passing.length) {
        best = { p: passing[0], i };
        break;
      }
      const cheapest = [...found].sort((a, b) => a.costPpm - b.costPpm)[0];
      cand.rejected = true;
      cand.rejectedReason = rejection(cheapest, rec);
      if (!best || cheapest.costPpm < best.p.costPpm) best = { p: cheapest, i };
    }
    if (!best) {
      rec.state = "route_found_too_expensive";
      rec.blockedBy.push("no route within budget");
      rec.reasons.push(`no route found at any size from ${candidates.length === 1 ? "the one source" : `any of ${candidates.length} sources`} within the probe ceiling — try running it manually`);
      continue;
    }
    const { p } = best;
    const source = candidates[best.i].s.ch;
    rec.selectedSourceChannel = source.id;
    rec.recommendedAmount = p.amount;
    rec.estimatedRouteCostPpm = p.costPpm;
    rec.estimatedRouteFeeSats = p.feeSats;
    rec.expectedPaybackDays = p.paybackDays;
    rec.expectedNetProfitSats = p.net;
    rec.postRefillPpm = p.postPpm;
    rec.maxCostPpm = p.maxCostPpm;
    rec.maxFeeSats = p.maxFeeSats;
    rec.expectedRevenuePpm = p.value;
    // The executor tries the passing source first, then the ones not
    // probed after it; a source probed without a passing route is out.
    rec.sourceCandidates = [rec.sourceCandidates[best.i], ...rec.sourceCandidates.filter((_, j) => j !== best.i)];
    // What the moved sats are worth after the refill: held at the estimate
    // from before it — or, where the engine can't hold that (a lease
    // promise, a pin), the lower fee it will charge, which is then what they
    // are valued at. (Compared with the estimate from BEFORE the probe:
    // expectedRevenuePpm is already the lower of the two.)
    const repriced = p.postPpm < (rec.preRefillPpm ?? p.value);
    const after = repriced
      ? `after the refill the fee engine takes it to ~${p.postPpm} ppm — the moved sats are valued at that`
      : `after the refill the fee engine keeps it at ≥ ${p.value} ppm until the refilled sats have routed out (at most 30 d)`;
    if (p.passes) {
      rec.state = "route_found_profitable";
      rec.wouldRebalance = true;
      rec.reasons.push(
        `profitable: move ${k(p.amount)} from ${source.peerAlias || source.id} at ${p.costPpm} ppm ≤ max ${p.maxCostPpm}, payback ~${p.paybackDays}d, ` +
          `net +${p.net} sat (pays at most ${p.maxFeeSats} sat) — ${after}`,
      );
      planned.set(source.id, (planned.get(source.id) ?? 0) + p.amount);
      continue;
    }
    const tooPricey = p.costPpm > p.maxCostPpm || (rec.maxCostSatsByPayback != null && p.feeSats > rec.maxCostSatsByPayback);
    const valued = repriced ? ` (${after})` : "";
    if (tooPricey) {
      rec.state = "route_found_too_expensive";
      rec.blockedBy.push("route above max cost / payback limit");
      rec.reasons.push(
        `cheapest route ${p.costPpm} ppm (max ${p.maxCostPpm})` +
          (p.paybackDays != null ? `, payback ~${p.paybackDays}d (limit ${cfg.maxPaybackDays}d)` : "") +
          ` — too expensive even at smaller sizes${valued}`,
      );
    } else {
      rec.state = "unprofitable_skip";
      rec.blockedBy.push("net profit below minimum");
      rec.reasons.push(`best net profit ${p.net} sat is below the ${cfg.minExpectedNetProfitSats} sat minimum${valued}`);
    }
  }

  // What it would take, for every drained channel the gate turned down.
  for (const rec of recs) {
    const turnedDown =
      rec.state === "route_found_too_expensive" ||
      (rec.state === "unprofitable_skip" && !rec.blockedBy.includes("no safe source channel")) ||
      (rec.state === "watching" && !rec.blockedBy.length && rec.reasons.some((x) => /revenue|demand too small/.test(x)));
    if (turnedDown) {
      const line = wouldTake(rec, cfg, feeById.get(rec.channelId)?.metrics.replacementCostPpm ?? null);
      if (line) rec.reasons.push(line);
    }
    if (rec.inDemand && rec.state !== "not_needed") {
      rec.reasons.push(
        `possible demand: ${k(rec.refusedSats14d)} of refused HTLCs in 14 d a refilled channel could have carried (de-noised) — shown, not counted as earnings`,
      );
    }
  }

  const summary: RebalanceRecSummary = {
    totalCandidates: recs.filter((r) => r.state !== "not_needed").length,
    profitableRecommendations: recs.filter((r) => r.state === "route_found_profitable").length,
    feeAdjustFirstCount: recs.filter((r) => r.state === "fee_adjust_first").length,
    tooExpensiveCount: recs.filter((r) => r.state === "route_found_too_expensive").length,
    closeCandidateCount: recs.filter((r) => r.state === "close_candidate").length,
    expectedTotalCostSats: recs.reduce((s, r) => s + (r.wouldRebalance ? r.estimatedRouteFeeSats ?? 0 : 0), 0),
    expectedTotalNetProfitSats: recs.reduce((s, r) => s + (r.wouldRebalance ? r.expectedNetProfitSats ?? 0 : 0), 0),
  };

  // Refilling outbound: a rebalance at today's route costs, or the fee.
  const routeCosts = recs
    .map((r) => r.estimatedRouteCostPpm)
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  const routeTypicalPpm = routeCosts.length ? routeCosts[Math.floor(routeCosts.length / 2)] : null;
  const drained = recs.filter((r) => r.state !== "not_needed").length;
  const note =
    routeTypicalPpm != null
      ? `Refilling outbound by rebalancing costs ~${routeTypicalPpm} ppm right now (median of the routes probed). Raising the fee and letting flow refill a channel costs nothing — it is just slower.`
      : drained > 0
        ? "No refill route probed right now — raising the fee and letting flow refill a channel costs nothing, it is just slower."
        : "Nothing needs a refill right now.";
  return { summary, refill: { routeTypicalPpm, feeFirstCount: summary.feeAdjustFirstCount, note }, recommendations: recs };
}

export interface RebalanceRecOptions {
  recOverrides?: Partial<RebalanceRecConfig>;
  /** Channels sold through Magma or LSPS1 (capital.soldLeases()). */
  soldLeases?: readonly SoldLease[];
}

/**
 * The rebalance report: one fee engine run (the same inputs the autopilot's
 * fee stage uses — elasticity, flow anchors, lease promises — so the gate's
 * post-refill fee is the one the autopilot will really charge), then the
 * plan, with route costs from LND's graph.
 */
export async function getRebalanceRecommendations(
  lnd: AuthenticatedLnd,
  engine: FeeEngineInputs,
  opts: RebalanceRecOptions = {},
): Promise<RebalanceRecReport> {
  const cfg = { ...REBAL_REC_DEFAULTS, ...(opts.recOverrides ?? {}) };
  // Stamped BEFORE its inputs are read: a refill that started while the
  // channels were read and the routes probed is newer than this plan, and a
  // manual run from it is refused as stale (autopilot.ts rebalanceByHand).
  const generatedAt = new Date().toISOString();
  const [run, ownKey] = await Promise.all([runFeeEngine(lnd, engine), getOwnPubkey(lnd)]);
  const plan = await planRebalances(
    {
      channels: run.channels,
      fees: run.report.recommendations,
      contextOf: run.contextOf,
      cfg,
      overrides: engine.channelOverrides ?? {},
      soldLeases: opts.soldLeases ?? [],
      currentBlock: run.currentBlock,
    },
    (source, target, amount) => estimateCost(lnd, ownKey, source, target, amount, cfg.probeCeilingPpm),
  );
  return { generatedAt, config: cfg, ...plan };
}
