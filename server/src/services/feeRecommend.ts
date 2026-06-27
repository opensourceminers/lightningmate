import { getFeeRates, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { getChannelsView, type ChannelRole } from "./channels.js";
import { getForwardsReport } from "./forwards.js";
import type { RebalanceRecord } from "./rebalanceLog.js";
import type { ChannelOverride, OverrideMap } from "./overrides.js";

/**
 * Fee Autopilot v2 — recommendation engine (dry-run only; never writes fees).
 *
 * Product goal: stop the node from routing liquidity at a loss. Each channel's
 * recommended outbound fee is derived in a fixed order so the signals don't
 * fight (see buildRecommendation): a balance curve around a per-channel target
 * ratio, a velocity modifier from real demand, a conservative node-benchmark
 * nudge, then hard floors (profit / protect / new-channel) that always win,
 * clamp, round, and finally apply-guards that only decide *whether* it would be
 * applied — never the target itself. Every decision is explained in `reasons`.
 */

export interface FeeRecConfig {
  minPpm: number;
  maxPpm: number;
  neutralPpm: number;
  protectPpm: number;
  newChannelMinPpm: number;
  minChangePpm: number;
  relativeChangeThreshold: number;
  stepPpm: number;
  cooldownHours: number;
  safetyMargin: number;
  flowWindowDays: number;
  peerGateWindowDays: number;
  benchmarkWindowDays: number;
  deadband: number;
  newChannelProtectionDays: number;
  maxChangesPerRun: number;
  sourceTargetLocalRatio: number;
  sinkTargetLocalRatio: number;
  routerTargetLocalRatio: number;
  neutralTargetLocalRatio: number;
}

export const FEE_REC_DEFAULTS: FeeRecConfig = {
  minPpm: 50,
  maxPpm: 2500,
  neutralPpm: 250,
  protectPpm: 1500,
  newChannelMinPpm: 250,
  minChangePpm: 25,
  relativeChangeThreshold: 0.2,
  stepPpm: 25,
  cooldownHours: 72,
  safetyMargin: 1.15,
  flowWindowDays: 14,
  peerGateWindowDays: 30,
  benchmarkWindowDays: 30,
  deadband: 0.05,
  newChannelProtectionDays: 3,
  maxChangesPerRun: 6,
  sourceTargetLocalRatio: 0.45,
  sinkTargetLocalRatio: 0.55,
  routerTargetLocalRatio: 0.5,
  neutralTargetLocalRatio: 0.5,
};

export type FeeRecState =
  | "normal"
  | "exploring_lower_fee"
  | "protecting_liquidity"
  | "recovering_cost"
  | "close_candidate";

export interface FeeRecMetrics {
  localRatio: number;
  targetLocalRatio: number;
  channelAgeDays: number | null;
  routedOut14d: number;
  routedIn14d: number;
  routedOut30d: number;
  routedIn30d: number;
  grossFlow14d: number;
  netDrain14d: number;
  grossFlow30d: number;
  netDrain30d: number;
  revenue14d: number;
  revenue30d: number;
  revenuePpm14d: number | null;
  revenuePpm30d: number | null;
  costBasisPpm: number | null;
  costBasisSource: "rebalance_avg" | "unknown";
  profitFloorPpm: number | null;
  peerGate: "ok" | "weak";
  role: ChannelRole;
  isTopEarner: boolean;
  benchmarkComparison: "above" | "median" | "below";
}

export interface FeeRecommendation {
  channelId: string;
  alias: string;
  capacity: number;
  currentPpm: number;
  targetPpm: number;
  /** Funding outpoint + current base fee — needed to apply without clobbering base. */
  transactionId: string | null;
  transactionVout: number | null;
  currentBaseMsat: number;
  wouldApply: boolean;
  blockedByGuards: string[];
  state: FeeRecState;
  reasons: string[];
  metrics: FeeRecMetrics;
}

export interface NodeBenchmarks {
  activeChannelCount: number;
  topGrossFlow14d: number;
  medianGrossFlow14d: number;
  topRevenue30d: number;
  medianRevenue30d: number;
  topRevenuePpm30d: number;
  medianRevenuePpm30d: number;
}

export interface FeeRecReport {
  generatedAt: string;
  config: FeeRecConfig;
  nodeBenchmarks: NodeBenchmarks;
  recommendations: FeeRecommendation[];
}

// ── small helpers ─────────────────────────────────────────────────────────────
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Per-channel flow + revenue over a window, keyed by channel id. */
interface Flow {
  out: number;
  inn: number;
  revenue: number;
  forwards: number;
}
function flowMap(perChannel: { channelId: string; routedOutSats: number; routedInSats: number; feesEarnedSats: number; forwardCount: number }[]): Map<string, Flow> {
  const m = new Map<string, Flow>();
  for (const c of perChannel)
    m.set(c.channelId, { out: c.routedOutSats, inn: c.routedInSats, revenue: c.feesEarnedSats, forwards: c.forwardCount });
  return m;
}
const flowOf = (m: Map<string, Flow>, id: string): Flow => m.get(id) ?? { out: 0, inn: 0, revenue: 0, forwards: 0 };

// ── §2 role → target local ratio ──────────────────────────────────────────────
function targetLocalRatioFor(role: ChannelRole, cfg: FeeRecConfig): number {
  if (role === "source") return cfg.sourceTargetLocalRatio;
  if (role === "sink") return cfg.sinkTargetLocalRatio;
  if (role === "router") return cfg.routerTargetLocalRatio;
  return cfg.neutralTargetLocalRatio;
}

// ── §1 zone/deadband balance curve ────────────────────────────────────────────
function balanceTargetPpm(localRatio: number, targetRatio: number, cfg: FeeRecConfig): number {
  const d = localRatio - targetRatio;
  if (Math.abs(d) <= cfg.deadband) return cfg.neutralPpm;
  if (d > 0) {
    // more local than target → excess outbound → cheaper, toward minPpm
    const span = Math.max(0.01, 1 - targetRatio - cfg.deadband);
    const frac = clamp((d - cfg.deadband) / span, 0, 1);
    return cfg.neutralPpm - frac * (cfg.neutralPpm - cfg.minPpm);
  }
  // drained below target → pricier, toward maxPpm
  const span = Math.max(0.01, targetRatio - cfg.deadband);
  const frac = clamp((-d - cfg.deadband) / span, 0, 1);
  return cfg.neutralPpm + frac * (cfg.maxPpm - cfg.neutralPpm);
}

// ── §6 channel age from the short-channel-id block height ─────────────────────
function channelAgeDays(channelId: string, currentBlock: number): number | null {
  const block = Number(channelId.split("x")[0]);
  if (!Number.isFinite(block) || block <= 0 || !currentBlock || block > currentBlock) return null;
  return Math.round(((currentBlock - block) / 144) * 10) / 10; // ~144 blocks/day
}

// ── §7 profit floor from rebalance cost basis ─────────────────────────────────
function costBasisPpmFor(channelId: string, records: RebalanceRecord[]): number | null {
  let fee = 0;
  let amount = 0;
  for (const r of records) {
    if (r.ok && r.targetId === channelId && r.feeSats != null && r.amountSats > 0) {
      fee += r.feeSats;
      amount += r.amountSats;
    }
  }
  return amount > 0 ? Math.round((fee / amount) * 1_000_000) : null;
}

export interface CooldownInput {
  lastApplied: Record<string, string>;
  cooldownHours: number;
}

// ── main builder ──────────────────────────────────────────────────────────────
export async function getFeeRecommendations(
  lnd: AuthenticatedLnd,
  rebalanceRecords: RebalanceRecord[],
  cooldown: CooldownInput | null,
  configOverrides: Partial<FeeRecConfig> = {},
  channelOverrides: OverrideMap = {},
  /** Per-channel learned fee elasticity modifier (channelId → ~0.85..1.2). */
  elasticity: Map<string, number> = new Map(),
): Promise<FeeRecReport> {
  const cfg = { ...FEE_REC_DEFAULTS, ...configOverrides };
  const [channels, rates, fw14, fw30, wallet] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
    getForwardsReport(lnd, cfg.flowWindowDays),
    getForwardsReport(lnd, cfg.benchmarkWindowDays),
    getWalletInfo({ lnd }),
  ]);
  const rateById = new Map(rates.channels.map((c) => [c.id, c]));
  const f14 = flowMap(fw14.perChannel);
  const f30 = flowMap(fw30.perChannel);
  const currentBlock = wallet.current_block_height ?? 0;
  const active = channels.filter((c) => c.active);

  // §4 node benchmarks (from active channels)
  const gross14s = active.map((c) => (flowOf(f14, c.id).out + flowOf(f14, c.id).inn) / Math.max(1, c.capacity));
  const rev30s = active.map((c) => flowOf(f30, c.id).revenue);
  const revPpm30s = active
    .map((c) => {
      const f = flowOf(f30, c.id);
      return f.out > 0 ? (f.revenue / f.out) * 1_000_000 : null;
    })
    .filter((n): n is number => n != null);
  const nodeBenchmarks: NodeBenchmarks = {
    activeChannelCount: active.length,
    topGrossFlow14d: gross14s.length ? Math.max(...gross14s) : 0,
    medianGrossFlow14d: median(gross14s),
    topRevenue30d: rev30s.length ? Math.max(...rev30s) : 0,
    medianRevenue30d: median(rev30s),
    topRevenuePpm30d: revPpm30s.length ? Math.max(...revPpm30s) : 0,
    medianRevenuePpm30d: median(revPpm30s),
  };
  // top earners = top 20% (min 1) by 30d revenue
  const earnerCutoff = [...rev30s].sort((a, b) => b - a)[Math.max(0, Math.ceil(active.length * 0.2) - 1)] ?? 0;

  const enoughChannels = active.length >= 5;

  const recommendations = channels.map((ch) =>
    buildRecommendation(ch, {
      cfg,
      rate: rateById.get(ch.id),
      override: channelOverrides[ch.id],
      f14: flowOf(f14, ch.id),
      f30: flowOf(f30, ch.id),
      currentBlock,
      records: rebalanceRecords,
      bench: nodeBenchmarks,
      enoughChannels,
      earnerCutoff,
      cooldown,
      elasticityMod: elasticity.get(ch.id) ?? 1,
    }),
  );

  // §11 max-changes-per-run: only the biggest moves would actually apply
  const applyOrder = recommendations
    .filter((r) => r.wouldApply)
    .sort((a, b) => Math.abs(b.targetPpm - b.currentPpm) - Math.abs(a.targetPpm - a.currentPpm));
  applyOrder.slice(cfg.maxChangesPerRun).forEach((r) => {
    r.wouldApply = false;
    r.blockedByGuards.push("max changes per run reached");
  });

  return { generatedAt: new Date().toISOString(), config: cfg, nodeBenchmarks, recommendations };
}

interface RateInfo {
  fee_rate: number;
  base_fee_mtokens: string;
  transaction_id: string;
  transaction_vout: number;
}

interface BuildCtx {
  cfg: FeeRecConfig;
  rate: RateInfo | undefined;
  override: ChannelOverride | undefined;
  f14: Flow;
  f30: Flow;
  currentBlock: number;
  records: RebalanceRecord[];
  bench: NodeBenchmarks;
  enoughChannels: boolean;
  earnerCutoff: number;
  cooldown: CooldownInput | null;
  elasticityMod: number;
}

function buildRecommendation(
  ch: Awaited<ReturnType<typeof getChannelsView>>[number],
  ctx: BuildCtx,
): FeeRecommendation {
  const { cfg, rate, f14, f30, records, bench, enoughChannels, earnerCutoff } = ctx;
  const currentPpm = rate?.fee_rate ?? 0;
  const cap = Math.max(1, ch.capacity);
  const reasons: string[] = [];

  // 1. metrics
  const grossFlow14d = (f14.out + f14.inn) / cap;
  const netDrain14d = (f14.out - f14.inn) / cap;
  const grossFlow30d = (f30.out + f30.inn) / cap;
  const netDrain30d = (f30.out - f30.inn) / cap;
  const revenuePpm14d = f14.out > 0 ? Math.round((f14.revenue / f14.out) * 1_000_000) : null;
  const revenuePpm30d = f30.out > 0 ? Math.round((f30.revenue / f30.out) * 1_000_000) : null;
  const ageDays = channelAgeDays(ch.id, ctx.currentBlock);
  const costBasisPpm = costBasisPpmFor(ch.id, records);
  const profitFloorPpm = costBasisPpm != null ? Math.round(costBasisPpm * cfg.safetyMargin) : null;
  const isTopEarner = enoughChannels && f30.revenue > 0 && f30.revenue >= earnerCutoff;

  // §6 peer gate — has it routed out (or seen flow) in the gate window?
  // On active routing paths in either direction? A fully-drained channel can't
  // route out, so also count inbound flow (it's being naturally refilled) — else
  // we'd wrongly flag a busy, just-drained channel as a dead peer.
  const peerGate: "ok" | "weak" = f30.out > 0 || f30.inn > 0 || f30.forwards > 0 ? "ok" : "weak";

  // §2 target ratio + §1 balance base
  const targetLocalRatio = targetLocalRatioFor(ch.role, cfg);
  const base = balanceTargetPpm(ch.localRatio, targetLocalRatio, cfg);

  // §3 velocity modifier
  let velocityMod = 1;
  let exploring = false;
  if (grossFlow14d >= 0.2 && netDrain14d >= 0.1) {
    velocityMod = 1.25;
    reasons.push(`velocity: draining fast (${Math.round(netDrain14d * 100)}% net in ${cfg.flowWindowDays}d) — raising fee`);
  } else if (grossFlow14d >= 0.05 && netDrain14d >= 0.03) {
    velocityMod = 1.1;
    reasons.push("velocity: steady outbound demand — nudging fee up");
  } else if (grossFlow14d >= 0.2 && Math.abs(netDrain14d) < 0.05) {
    velocityMod = 1.05;
    reasons.push("velocity: active and balanced — holding firm");
  } else if (grossFlow14d < 0.01 && ch.localRatio > targetLocalRatio + 0.2 && peerGate === "ok") {
    velocityMod = 0.85;
    exploring = true;
    reasons.push("idle test: good peer with idle outbound liquidity — testing a lower fee");
  } else if (grossFlow14d < 0.01 && peerGate === "weak") {
    reasons.push("peer gate: no 30d flow — not lowering an idle, weak-peer channel");
  }

  // §4 conservative node-benchmark nudge
  let benchMod = 1;
  let benchmarkComparison: "above" | "median" | "below" = "median";
  if (enoughChannels && bench.medianGrossFlow14d > 0) {
    if (grossFlow14d >= bench.medianGrossFlow14d * 1.5) benchmarkComparison = "above";
    else if (grossFlow14d <= bench.medianGrossFlow14d * 0.5) benchmarkComparison = "below";
    if (benchmarkComparison === "above" && netDrain14d > 0.05) {
      benchMod = 1.05;
      reasons.push("benchmark: outperforms node average and draining — raising fee");
    } else if (isTopEarner) {
      benchMod = Math.max(benchMod, 1); // never let a top earner be pushed cheaper
      if (velocityMod < 1) velocityMod = 1;
      reasons.push("benchmark: top-earning channel — preserving fee level");
    } else if (benchmarkComparison === "below" && ch.localRatio > targetLocalRatio + 0.15 && peerGate === "ok") {
      benchMod = 0.95;
      exploring = exploring || velocityMod <= 1;
      reasons.push("benchmark: below node flow average — testing a lower fee");
    }
  }

  // §10 precedence: base × modifiers (combined modifier clamped so forces don't explode)
  const combinedMod = clamp(velocityMod * benchMod, 0.8, 1.4);
  let target = base * combinedMod;
  // Learned elasticity: nudge by how this channel's revenue responded to past fee
  // changes (neutral 1.0 when there's no measured history).
  if (ctx.elasticityMod !== 1) {
    target *= ctx.elasticityMod;
    reasons.push(
      ctx.elasticityMod > 1
        ? `elasticity: raising fees lifted revenue here before — charging ~${Math.round((ctx.elasticityMod - 1) * 100)}% more`
        : `elasticity: higher fees cost flow here before — easing ~${Math.round((1 - ctx.elasticityMod) * 100)}% lower`,
    );
  }

  // §10 hard floors (always win). The binding floor's reason is unshifted to the
  // front so the *dominant* reason is shown first. Floors are safety/economics
  // limits, so they may exceed maxPpm — otherwise a low maxPpm would defeat
  // protect mode and let the node route below its own refill cost.
  let floored: FeeRecState | null = null;
  let hardFloor = 0;
  if (ageDays != null && ageDays < cfg.newChannelProtectionDays && f30.forwards < 3) {
    if (cfg.newChannelMinPpm > target) {
      target = cfg.newChannelMinPpm;
      hardFloor = Math.max(hardFloor, cfg.newChannelMinPpm);
      reasons.unshift(`new channel: only ${ageDays}d old with little history — keeping a protected fee`);
    }
    exploring = false; // never explore-lower a brand-new channel
  }
  if (profitFloorPpm != null && profitFloorPpm > target) {
    target = profitFloorPpm;
    hardFloor = Math.max(hardFloor, profitFloorPpm);
    floored = "recovering_cost";
    reasons.unshift(`profit floor: raised above refill cost (basis ${costBasisPpm} ppm × ${cfg.safetyMargin})`);
  }
  if (ch.localRatio < 0.1) {
    if (cfg.protectPpm > target) target = cfg.protectPpm;
    hardFloor = Math.max(hardFloor, cfg.protectPpm);
    floored = "protecting_liquidity";
    reasons.unshift(`protect mode: channel nearly drained (${Math.round(ch.localRatio * 100)}% local) — raising fee`);
  }

  // §10 clamp + round — floors may push the ceiling above maxPpm
  target = clamp(target, cfg.minPpm, Math.max(cfg.maxPpm, hardFloor));
  let targetPpm = Math.round(target / cfg.stepPpm) * cfg.stepPpm;

  // manual per-channel overrides win over the algorithm
  const { override } = ctx;
  if (override?.mode === "exclude") {
    targetPpm = currentPpm;
    reasons.unshift("excluded (manual) — not managed by the autopilot");
  } else if (override?.mode === "fixed" && override.fixedPpm != null) {
    targetPpm = clamp(Math.round(override.fixedPpm / cfg.stepPpm) * cfg.stepPpm, cfg.minPpm, cfg.maxPpm);
    reasons.unshift(`pinned to ${targetPpm} ppm (manual)`);
  }

  // §1/§8 base balance reason if nothing more specific fired
  if (reasons.length === 0) {
    const d = ch.localRatio - targetLocalRatio;
    if (Math.abs(d) <= cfg.deadband) reasons.push("balance: near target ratio — holding");
    else if (d > 0) reasons.push(`balance: high local ratio (${Math.round(ch.localRatio * 100)}%) — lower fee invites flow`);
    else reasons.push(`balance: low local ratio (${Math.round(ch.localRatio * 100)}%) — higher fee slows the drain`);
  }

  // §12 state (priority order)
  let state: FeeRecState = "normal";
  if (ch.localRatio < 0.1) state = "protecting_liquidity";
  else if (floored === "recovering_cost") state = "recovering_cost";
  else if (grossFlow30d < 0.005 && peerGate === "weak") state = "close_candidate";
  else if (exploring) state = "exploring_lower_fee";
  if (state === "close_candidate") reasons.push("close candidate: idle with a weak peer — consider closing");

  // §11 apply guards (decide wouldApply only — never the target)
  const blockedByGuards: string[] = [];
  const minDelta = Math.max(cfg.minChangePpm, Math.round(currentPpm * cfg.relativeChangeThreshold));
  if (override?.mode === "exclude") blockedByGuards.push("excluded (manual)");
  if (!ch.active) blockedByGuards.push("channel inactive");
  if (Math.abs(targetPpm - currentPpm) < minDelta) blockedByGuards.push("change below threshold");
  if (ctx.cooldown) {
    const last = ctx.cooldown.lastApplied[ch.id];
    if (last) {
      const elapsedH = (Date.now() - new Date(last).getTime()) / 3_600_000;
      if (elapsedH < ctx.cooldown.cooldownHours) blockedByGuards.push("cooldown active");
    }
  }
  const wouldApply = blockedByGuards.length === 0;

  return {
    channelId: ch.id,
    alias: ch.peerAlias || ch.id,
    capacity: ch.capacity,
    currentPpm,
    targetPpm,
    transactionId: rate?.transaction_id ?? null,
    transactionVout: rate?.transaction_vout ?? null,
    currentBaseMsat: rate ? Number(rate.base_fee_mtokens) : 0,
    wouldApply,
    blockedByGuards,
    state,
    reasons,
    metrics: {
      localRatio: ch.localRatio,
      targetLocalRatio,
      channelAgeDays: ageDays,
      routedOut14d: f14.out,
      routedIn14d: f14.inn,
      routedOut30d: f30.out,
      routedIn30d: f30.inn,
      grossFlow14d,
      netDrain14d,
      grossFlow30d,
      netDrain30d,
      revenue14d: f14.revenue,
      revenue30d: f30.revenue,
      revenuePpm14d,
      revenuePpm30d,
      costBasisPpm,
      costBasisSource: costBasisPpm != null ? "rebalance_avg" : "unknown",
      profitFloorPpm,
      peerGate,
      role: ch.role,
      isTopEarner,
      benchmarkComparison,
    },
  };
}
