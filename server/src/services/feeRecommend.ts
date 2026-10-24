import { getFeeRates, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { getChannelsView, type ChannelRole, type ChannelView } from "./channels.js";
import { getForwardsReport, readForwardEvents, type ForwardEvent } from "./forwards.js";
import type { RebalanceRecord } from "./rebalanceLog.js";
import type { ChannelOverride, OverrideMap } from "./overrides.js";
import { activeCap, capText, clampToCap, type LeaseCap } from "./leaseCaps.js";
import { servableDemand, type DemandSignal } from "./htlcTelemetry.js";
import { peerMarketFees, type MarketRef } from "./suggestions.js";

/**
 * Fee Autopilot v2 — recommendation engine (dry-run only; never writes fees).
 *
 * Product goal: stop the node from routing liquidity at a loss. Each channel's
 * recommended outbound fee is derived in a fixed order so the signals don't
 * fight (see buildRecommendation): a balance curve around a per-channel target
 * ratio (its balanced level lowered toward a cheaper market), a velocity
 * modifier from real demand, a conservative node-benchmark nudge, the cost of
 * replacing the outbound of a draining channel, then floors (profit / protect
 * / new-channel), clamp, round, and finally apply-guards that only decide
 * *whether* it would be applied — never the target itself. Every decision is
 * explained in `reasons`.
 *
 * Two numbers per channel: the AIM (where the engine wants the fee to end up)
 * and the TARGET (this update's move toward it). Moves are small and bounded
 * (review a1, "stay conservative for small nodes"):
 *   - a raise moves at most RAISE_STEPS steps (elasticity can widen the step a
 *     little, never remove the bound) — on every channel, routing or not; a
 *     fee below the policy's min is brought up to the min first (the range
 *     rule), and raised from there by steps;
 *   - except the demand ramp: a drained channel (under DEMAND_RAMP_LOCAL)
 *     with buyers — forwards in 30 days, not refilled faster than it sells —
 *     that sold DEMAND_RAMP_SALES times at the fee it charges now is raised
 *     by a quarter of its fee per move (DEMAND_RAMP_SHARE, at least
 *     RAISE_STEPS steps), at most every DEMAND_RAMP_HOURS — not by two steps
 *     every 72 h, which took a drained top earner six weeks from 350 to the
 *     price a refill needs; each move waits for those sales at the price
 *     before it; never past its aim, nor past a floor whose own ramp lifts
 *     the fee, and not where higher fees measurably cost flow;
 *   - the protect and profit-floor ramps move at most RAMP_STEPS steps;
 *   - a lowering moves at most the idle ratchet's steps — on every channel,
 *     idle or routing (the balance curve or an explore price no longer cut an
 *     idle channel from 1,500 to 900 ppm in one update);
 *   - a drained channel nobody routes through is never raised at all;
 *   - raise only on a drain signal: a channel that isn't below its target
 *     ratio and that nothing says drains is not raised by the balance curve —
 *     routing at its fee, that is the price that wins flow (a price that had
 *     just won two-way flow was raised straight back out of it, 50 → 70
 *     toward the balanced level of 80, and sat there, priced out). Only drain
 *     velocity, a draining channel's replacement cost, a floor or the policy's
 *     min raise it;
 *   - a missing market reference never lowers a draining channel: a report
 *     whose graph lacks one uses the channel's last (MARKET_MEMORY_MS), and
 *     with none at all the channel is held where the curve would lower it
 *     (its refill cost is unknown — review 3: a peer back from an outage
 *     still had its inbound channels disabled in the graph, and that one run
 *     lowered a channel priced at its refill cost; gaps every few days walked
 *     it down for good).
 * What moves at once, each for a reason of its own: an idle channel dropping
 * to the price that last won flow back or to what the market charges into
 * its peer (evidence, not a guess — and nothing is at stake on a channel
 * nobody routes through), a pin (the operator's value), the new-channel
 * floor, a broken lease promise, and a fee outside the policy's min/max.
 * The anti-churn threshold judges the gap between the current fee and the
 * AIM, not the size of one deliberate step: it used to veto the engine's own
 * steps (+20 raise, −30 ratchet, +40 protect at step 10 were all below its
 * 25 ppm / 20 % bar), freezing draining channels low and idle ones high. The
 * no-flow rule's own moves (a ratchet step, a jump to the flow-won or the
 * market price) and any move from a fee outside the policy range are not
 * judged by it at all: they are bounded and paced already, and at the low
 * fees small nodes charge the threshold vetoed them within 25 ppm of their
 * destination.
 */

export interface FeeRecConfig {
  minPpm: number;
  maxPpm: number;
  neutralPpm: number;
  protectPpm: number;
  newChannelMinPpm: number;
  /** Flat base fee (msat) to set on managed channels. 0 = volume-first: base fee
   *  deters LND path-finding (esp. small + multi-hop), so drop it to win forwards. */
  baseFeeMsat: number;
  /** How many `stepPpm` steps the no-flow rule drops an idle channel per run
   *  — the most any channel is lowered in one move (at least one step), bar
   *  an idle channel's jump to its flow-won or market price.
   *  Higher = wins routing back faster (volume); lower = eases down gently (profit). */
  noFlowRatchetSteps: number;
  /** Velocity "explore lower" multiplier for idle, over-local channels (<1).
   *  Lower = more aggressive fee cuts to attract flow. */
  exploreLowerModifier: number;
  minChangePpm: number;
  relativeChangeThreshold: number;
  stepPpm: number;
  cooldownHours: number;
  safetyMargin: number;
  /** The operator's opt-in: a profit floor may lift a fee above maxPpm.
   *  Off by default — the floor is then capped at maxPpm. */
  floorAboveMax: boolean;
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
  minPpm: 25,
  maxPpm: 1000,
  neutralPpm: 80,
  protectPpm: 350,
  newChannelMinPpm: 80,
  baseFeeMsat: 0,
  noFlowRatchetSteps: 3,
  exploreLowerModifier: 0.85,
  minChangePpm: 25,
  relativeChangeThreshold: 0.2,
  stepPpm: 25,
  cooldownHours: 72,
  safetyMargin: 1.15,
  floorAboveMax: false,
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

/** An ordinary raise moves at most this many steps (×elasticity, bounded). */
export const RAISE_STEPS = 2;
/** The protect and profit-floor ramps move at most this many steps. */
export const RAMP_STEPS = 4;
/** The demand ramp: a drained channel — under this local ratio, the protect
 *  rule's "drained" — that routed DRAIN_MIN_FORWARDS times in 30 days, sold
 *  at least DEMAND_RAMP_SALES times at the fee it charges now (since that
 *  fee was set) and isn't being refilled faster than it sells (14 days). */
export const DEMAND_RAMP_LOCAL = 0.1;
/** Three, like the refill gate's proof (rebalanceRecommend PROVEN_SALES):
 *  one sale per level ramped a price-sensitive channel to 880 ppm on thin
 *  evidence, and each move reset the count before a refill's proof could
 *  form (review 2). */
export const DEMAND_RAMP_SALES = 3;
/** Its raise per move: this share of the current fee (at least RAISE_STEPS
 *  steps) — 350 → 430 → 530 → 660 on a 10-ppm grid, geometric like any
 *  price discovery; each move waits for a sale at the price before it. */
export const DEMAND_RAMP_SHARE = 0.25;
/** …at most once per this many hours, or the operator's cadence if longer:
 *  its moves are open-ended up to the aim, unlike the hard-capped ramps. */
export const DEMAND_RAMP_HOURS = 6;
/** Elasticity may widen a raise step by at most this factor. */
const MAX_ELASTIC_STEP = 1.5;
/** The profit floor comes from the autopilot's own refills of this window. */
export const FLOOR_WINDOW_DAYS = 30;
/** Where the refills the profit floor can stand on start (ms). */
export const floorWindowStart = (nowMs = Date.now()): number => nowMs - FLOOR_WINDOW_DAYS * 86_400_000;
/** De-noised refusals (D20) that make a channel "in demand": at least this
 *  many distinct attempts, on at least this many days, in the window. */
export const DEMAND_MIN_ATTEMPTS = 3;
export const DEMAND_MIN_DAYS = 2;
export const DEMAND_WINDOW_DAYS = 14;
/** Draining: net outflow of at least this share of capacity in 30 days,
 *  with at least DRAIN_MIN_FORWARDS forwards. */
const DRAIN_NET_SHARE = 0.1;
const DRAIN_MIN_FORWARDS = 3;
/** Priced against the market at this share of what others charge into the
 *  same peer — just under, to compete. */
const MARKET_SHARE = 0.9;
/** The longest the fee engine waits for the network graph (a big graph on a
 *  small machine takes a while to read): past it, this report prices without
 *  the market — the read goes on and is cached for the next one. Only a cold
 *  start waits at all: once read, the graph is served at once, a stale one
 *  while a fresh read runs (suggestions.ts, buildGraphCache). */
export const MARKET_WAIT_MS = 15_000;
/** The autopilot's scheduled fee stage waits longer for the FIRST read after
 *  a restart: priced without the market, that one run lowered a draining
 *  channel the replacement cost had priced up, and the raise back then waited
 *  the 72 h raise cooldown. (A page waits MARKET_WAIT_MS.) */
export const MARKET_RUN_WAIT_MS = 120_000;
/**
 * How long a channel's market reference is remembered (review 3). A report
 * whose graph has no reference for a channel's peer uses the last one seen,
 * up to this old. Routine gaps: a peer that was offline for a while comes
 * back with the other nodes' channels into it still disabled (LND re-enables
 * them ~20 minutes after it is back, then gossip, then this node's graph
 * cache), so it drops under MARKET_MIN_CHANNELS; a thin peer straddles that
 * count; a cold start's graph read outlasts the wait. Priced without it, a
 * draining channel at its refill cost was lowered toward the balance curve
 * (340 → 310), the cooldown restarted, and the raise back waited 72 h — a gap
 * every few days walked it down to ~100 ppm for good. What others charge
 * into a peer doesn't change because the peer was offline for an hour.
 */
export const MARKET_MEMORY_MS = 7 * 86_400_000;

/** Per LND connection (tests run several fake nodes in one process): each
 *  channel's last market reference, and when a report last had it — shared
 *  by every report (the Fees tab, the autopilot, the rebalancer), as the
 *  graph cache is. */
const marketMemory = new WeakMap<AuthenticatedLnd, Map<string, { ref: MarketRef; seenAt: number }>>();

/** A channel's market reference for this report: `seenAt` is set when it is
 *  a remembered one (this report's graph had none for the peer). */
interface MarketFor {
  ref: MarketRef;
  seenAt: number | null;
}

/**
 * This report's market references, completed from memory: a channel the
 * graph has no reference for now keeps its last one for MARKET_MEMORY_MS.
 */
function recallMarket(lnd: AuthenticatedLnd, fresh: Map<string, MarketRef>, nowMs: number): Map<string, MarketFor> {
  let memory = marketMemory.get(lnd);
  if (!memory) marketMemory.set(lnd, (memory = new Map()));
  for (const [id, ref] of fresh) memory.set(id, { ref, seenAt: nowMs });
  const out = new Map<string, MarketFor>();
  for (const [id, m] of memory) {
    if (nowMs - m.seenAt > MARKET_MEMORY_MS) {
      memory.delete(id);
      continue;
    }
    out.set(id, { ref: m.ref, seenAt: fresh.has(id) ? null : m.seenAt });
  }
  return out;
}

/** The market references, or none if the graph isn't read within `ms`. */
function marketWithin(lnd: AuthenticatedLnd, channels: ChannelView[], ms: number): Promise<Map<string, MarketRef>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(new Map()), ms);
    timer.unref?.();
    peerMarketFees(lnd, channels).then(
      (m) => {
        clearTimeout(timer);
        resolve(m);
      },
      () => {
        clearTimeout(timer);
        resolve(new Map());
      },
    );
  });
}

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
  /** What the autopilot's refills into this channel cost (FLOOR_WINDOW_DAYS). */
  costBasisPpm: number | null;
  costBasisSource: "rebalance_avg" | "unknown";
  /** How many refills that is, and when the latest was. */
  costBasisRefills: number;
  costBasisLatestAt: string | null;
  /** Refilled sats still in the channel (not routed out yet). */
  refillRemainingSats: number;
  /** The price a refill's floor holds — what the profit gate valued it at
   *  (null: no hold in force). */
  refillHoldPpm: number | null;
  /** The floor was released: the refilled sats sat a week on a channel
   *  routing next to nothing (LOW_FLOW_*). */
  profitFloorReleased: boolean;
  /** The floor in force (capped at maxPpm unless the operator opted in). */
  profitFloorPpm: number | null;
  profitFloorCapped: boolean;
  peerGate: "ok" | "weak";
  role: ChannelRole;
  isTopEarner: boolean;
  benchmarkComparison: "above" | "median" | "below";
  /** What other nodes charge to forward into this peer (graph median, ppm). */
  marketPpm: number | null;
  marketSamples: number;
  /** The reference is a remembered one — this report's graph had none for
   *  the peer (MARKET_MEMORY_MS): when it was last seen. Null: this
   *  report's own, or none. */
  marketSeenAt: string | null;
  /** The peer's own fee back to us on this channel (ppm). */
  peerFeeToUsPpm: number | null;
  /** The least a refill of this channel costs on the market: one hop into
   *  the peer plus the peer's hop back to us (ppm). */
  replacementCostPpm: number | null;
  /** What it routed out since its fee last changed (LightningMate's own
   *  stamp; without one, the 30-day window) — every one of these sold at
   *  the fee it charges now: the evidence the demand ramp and the refill
   *  gate act on. */
  soldSinceChange: { forwards: number; out: number; revenue: number };
  /** Draining, and its fee is below what replacing its outbound costs. */
  belowReplacement: boolean;
  /** This fee next to the market into the peer. */
  marketComparison: "above" | "in_line" | "below" | null;
  draining: boolean;
  /** Possible demand (D20), 14 days: HTLCs refused for lack of outbound that
   *  a refilled channel could have carried — de-noised (no probes, same-amount
   *  retries or HTLCs over half the channel). Not proven payments. */
  refusedAttempts14d: number;
  refusedSats14d: number;
  refusedDays14d: number;
  inDemand: boolean;
  /** The learned elasticity modifier applied (1 = none). */
  elasticityMod: number;
}

export interface FeeRecommendation {
  channelId: string;
  alias: string;
  capacity: number;
  currentPpm: number;
  /** This update's fee: the next bounded move toward `aimPpm`. */
  targetPpm: number;
  /** Where the engine wants the fee to end up. */
  aimPpm: number;
  /** Funding outpoint + current base fee — needed to apply without clobbering base. */
  transactionId: string | null;
  transactionVout: number | null;
  currentBaseMsat: number;
  /** Base fee (msat) the autopilot should set — volume-first default is 0. */
  recommendedBaseMsat: number;
  /** True when the no-flow rule set this target — the autopilot uses it to track
   *  the episode and record the price at which flow eventually returns. */
  noFlowLowering: boolean;
  /** Pinned by hand (override "fixed"): applied as set, once. */
  pinned: boolean;
  /** A channel this node sold (Magma, LSPS1) whose order locked a routing-fee
   *  promise for the lease: the target never exceeds it (leaseCaps.ts). */
  leaseCap: { source: LeaseCap["source"]; orderId: string; feeRateCapPpm: number; baseFeeCapMsat: number; untilHeight: number | null } | null;
  /** Its current fee breaks that promise: lowered at once, past the anti-churn
   *  guards (and ahead of other changes in the per-run limit). */
  leaseCapBreach: boolean;
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
  /** How many channels have a market reference from the public graph. */
  marketReferenced: number;
  /** How many channels the elasticity learner has enough evidence for (its
   *  gate is strict: most small nodes have none — said so, not implied). */
  elasticityLearned: number;
  recommendations: FeeRecommendation[];
}

/** Market and demand signals; read from the graph and the HTLC telemetry
 *  when not given (tests pass their own). */
export interface FeeSignals {
  demand?: Map<string, DemandSignal>;
  /** Used exactly as given — a channel missing from it has no reference
   *  (only a market the engine reads itself is completed from memory). */
  market?: Map<string, MarketRef>;
  /** How long to wait for the graph when it has to be read (default
   *  MARKET_WAIT_MS). */
  marketWaitMs?: number;
}

/** Lowers step at most once a day — price discovery, not a race to the floor.
 *  (The autopilot loop runs every ~30 min; without pacing an idle channel would
 *  ratchet from any fee to minPpm within hours, before the market can react.) */
const LOWER_PACING_HOURS = 24;
const DAY_MS = 86_400_000;

// ── small helpers ─────────────────────────────────────────────────────────────
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ago = (iso: string, nowMs: number): string => {
  const d = Math.max(0, Math.round((nowMs - Date.parse(iso)) / DAY_MS));
  return d === 0 ? "today" : `${d} d ago`;
};
/** "40 min ago", "3 h ago", "2 d ago". */
const since = (ms: number, nowMs: number): string => {
  const min = Math.max(0, Math.round((nowMs - ms) / 60_000));
  return min < 90 ? `${min} min ago` : min < 36 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
};

/** Per-channel flow + revenue over a window, keyed by channel id. */
export interface Flow {
  out: number;
  inn: number;
  revenue: number;
  forwards: number;
}

/** What `channelId` routed after `sinceMs` (its fee's last change): forwards
 *  out at the fee it charges now, and what came in. */
export function soldSince(events: readonly ForwardEvent[], channelId: string, sinceMs: number): Flow {
  const flow: Flow = { out: 0, inn: 0, revenue: 0, forwards: 0 };
  let revenueMsat = 0;
  for (const e of events) {
    if (!(Date.parse(e.createdAt) > sinceMs)) continue;
    if (e.outgoingChannel === channelId) {
      flow.out += e.tokens;
      flow.forwards += 1;
      revenueMsat += e.feeMsat;
    }
    if (e.incomingChannel === channelId) flow.inn += e.tokens;
  }
  flow.revenue = revenueMsat / 1000;
  return flow;
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

// ── §7 profit floor from the refills still in the channel ────────────────────
/**
 * One refill into a channel that passed the profit gate (refillLots), as far
 * as its sats are still there.
 *
 * The floor is about liquidity that was PAID for and has not routed out yet
 * (review a2, sunk-cost-profit-floor): once a refill's sats have left the
 * channel, what they cost is spent and history — it must not price the
 * channel's other liquidity out. Before, every refill of the window counted
 * in full until it aged out, so one pricey refill whose sats were long gone
 * kept the channel above its market for a month.
 */
export interface RefillLot {
  /** When the refill was sent. */
  at: string;
  amountSats: number;
  feeSats: number;
  costPpm: number;
  /** What the profit gate valued it at (refills before P3 carry none). */
  holdPpm: number | null;
  /** Its sats not yet routed out (first in, first out) — the whole amount
   *  for a refill recorded without the channel's sent counter. */
  remainingSats: number;
}

/** A refill whose sats haven't moved for this long … */
export const LOW_FLOW_GRACE_DAYS = 7;
/** … on a channel with fewer forwards out than this in 14 days … */
export const LOW_FLOW_FORWARDS = 3;
/** … at this local ratio or more no longer floors the fee: its price is not
 *  what moves the liquidity (review a2: one forward a month kept a floor). */
export const LOW_FLOW_LOCAL_RATIO = 0.4;

/**
 * The successful refills into a channel that passed the profit gate, in the
 * last FLOOR_WINDOW_DAYS (review a1: a lifetime average, manual refills at
 * any price included, pinned a channel's fee for months after one 614 ppm
 * refill), oldest first, each with the sats of it still in the channel: the
 * autopilot's, and those run by hand from a recommended row — the gate went
 * with them (their payment was capped by it at every size), and they carry
 * its value (holdPpm). The Rebalancing tab promises the refilled fee is kept
 * until the sats have routed out, whoever pressed Run (review of P3: a
 * manual run from the tab got no hold, and the engine could cut the fee
 * right after it). A refill run by hand without the gate chose its own price
 * and skipped the check: it sets no floor.
 *
 * Retirement is first in, first out on LND's lifetime "sent" counter of the
 * channel: each refill records the counter just before it was paid
 * (targetSentBefore), so what left the channel between two refills — and
 * since the last one — is exact, whatever carried it out (a forward, a
 * payment). A refill recorded without the counter (before P3) retires only
 * by age, or by outflow measured from a later refill.
 */
export function refillLots(channelId: string, records: RebalanceRecord[], sentNow: number | null | undefined, nowMs: number): RefillLot[] {
  const cutoff = nowMs - FLOOR_WINDOW_DAYS * DAY_MS;
  const gated = (r: RebalanceRecord) => r.via !== "manual" || (typeof r.holdPpm === "number" && r.holdPpm > 0);
  const refills = records
    .filter((r) => r.ok && gated(r) && r.targetId === channelId && r.feeSats != null && r.amountSats > 0)
    .map((r) => ({ r, t: Date.parse(r.startedAt ?? r.at) }))
    .filter(({ t }) => Number.isFinite(t) && t >= cutoff)
    .sort((a, b) => a.t - b.t);
  const lots: RefillLot[] = refills.map(({ r }) => ({
    at: r.startedAt ?? r.at,
    amountSats: r.amountSats,
    feeSats: r.feeSats as number,
    costPpm: Math.round(((r.feeSats as number) / r.amountSats) * 1_000_000),
    holdPpm: typeof r.holdPpm === "number" && r.holdPpm > 0 ? Math.round(r.holdPpm) : null,
    remainingSats: r.amountSats,
  }));
  if (typeof sentNow !== "number" || !Number.isFinite(sentNow)) return lots;
  const baseline = (i: number): number | null => {
    const b = refills[i].r.targetSentBefore;
    return typeof b === "number" && Number.isFinite(b) ? b : null;
  };
  for (let i = 0; i < lots.length; i++) {
    const from = baseline(i);
    if (from === null) continue;
    // What left the channel from this refill until the next measured one
    // (or now) is taken from the refills it had by then, oldest first.
    let until = sentNow;
    for (let j = i + 1; j < lots.length; j++) {
      const b = baseline(j);
      if (b !== null) {
        until = b;
        break;
      }
    }
    let out = Math.max(0, until - from);
    for (let k = 0; k <= i && out > 0; k++) {
      const take = Math.min(lots[k].remainingSats, out);
      lots[k].remainingSats -= take;
      out -= take;
    }
  }
  return lots;
}

/** The floor the refills still in a channel set (null: none left). */
export interface RefillFloor {
  /** max of: what the pre-P3 refills cost on average × safetyMargin, and
   *  each newer refill's max(gate value, cost × safetyMargin). */
  ppm: number;
  /** The refill that sets it. */
  binding: RefillLot;
  /** Its floor comes from the profit gate's value (a hold), not its cost. */
  held: boolean;
  /** The refills still (partly) in the channel, and their sats. */
  lots: RefillLot[];
  remainingSats: number;
  /** What the sats still here cost, on average (ppm). */
  costPpm: number;
  /** The refills from before the gate recorded its value, still here: how
   *  many, their average cost (ppm) and the latest (null: none). */
  legacy: { refills: number; costPpm: number; latestAt: string } | null;
}

export function refillFloor(lots: RefillLot[], safetyMargin: number): RefillFloor | null {
  const left = lots.filter((l) => l.remainingSats > 0);
  if (left.length === 0) return null;
  const share = (l: RefillLot) => l.remainingSats / l.amountSats;
  const remainingSats = left.reduce((s, l) => s + l.remainingSats, 0);
  const costPpm = Math.round((left.reduce((s, l) => s + l.feeSats * share(l), 0) / remainingSats) * 1_000_000);
  // Refills from before the profit gate recorded its value: their average
  // cost × the margin (P2's floor, unchanged for them).
  const old = left.filter((l) => l.holdPpm === null);
  let ppm = 0;
  let binding = left[left.length - 1];
  let held = false;
  let legacy: RefillFloor["legacy"] = null;
  if (old.length) {
    const sats = old.reduce((s, l) => s + l.remainingSats, 0);
    const avg = Math.round((old.reduce((s, l) => s + l.feeSats * share(l), 0) / sats) * 1_000_000);
    legacy = { refills: old.length, costPpm: avg, latestAt: old[old.length - 1].at };
    ppm = Math.round(avg * safetyMargin);
    binding = old[old.length - 1];
  }
  // A newer refill holds the price the gate valued it at while its sats are
  // here — and never less than its cost × the margin.
  for (const l of left) {
    if (l.holdPpm === null) continue;
    const byCost = Math.round(l.costPpm * safetyMargin);
    const own = Math.max(l.holdPpm, byCost);
    if (own > ppm) {
      ppm = own;
      binding = l;
      held = l.holdPpm >= byCost;
    }
  }
  return { ppm, binding, held, lots: left, remainingSats, costPpm, legacy };
}

/** "750k", "1.25M" — a refill's size in a reason line. */
const satsShort = (n: number): string =>
  n >= 1_000_000 ? `${Math.round(n / 10_000) / 100}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : `${n} sat`;

/**
 * What the profit floor stands on, as the reason line states it (without a
 * cap or ramp). Refills from before the gate recorded its value read as
 * before: their average cost × the margin. A newer one says when it was
 * paid, what the profit gate valued it at (the price it is held at) or what
 * it cost, and how much of it is still in the channel — the floor ends when
 * that has routed out.
 */
function floorFact(f: RefillFloor, cfg: Pick<FeeRecConfig, "safetyMargin">, nowMs: number): string {
  const l = f.binding;
  if (l.holdPpm === null && f.legacy) {
    return (
      `profit floor: the autopilot's refills into it cost ${f.legacy.costPpm} ppm (${f.legacy.refills} in ${FLOOR_WINDOW_DAYS} d, latest ${ago(f.legacy.latestAt, nowMs)})` +
      ` × ${cfg.safetyMargin} = ${f.ppm} ppm`
    );
  }
  const when = `a refill ${ago(l.at, nowMs)} (${l.at.slice(0, 10)})`;
  const still = `${satsShort(l.remainingSats)} of its ${satsShort(l.amountSats)} still here — the floor ends when that has routed out (at most ${FLOOR_WINDOW_DAYS} d)`;
  return f.held
    ? `profit floor: ${when} was worth paying for at ${l.holdPpm} ppm (it cost ${l.costPpm} ppm) = ${f.ppm} ppm; ${still}`
    : `profit floor: ${when} cost ${l.costPpm} ppm × ${cfg.safetyMargin} = ${f.ppm} ppm; ${still}`;
}

export interface CooldownInput {
  lastApplied: Record<string, string>;
  cooldownHours: number;
  /** Channels whose last fee update failed (LND refused it, or it couldn't
   *  be sent): not updated again before this time (ISO) — a broken lease
   *  promise excepted. Without it, an update LND keeps refusing was resent
   *  every run, each a failed line in the run history. */
  retryAfter?: Record<string, string>;
}

// ── main builder ──────────────────────────────────────────────────────────────
export async function getFeeRecommendations(
  lnd: AuthenticatedLnd,
  rebalanceRecords: RebalanceRecord[],
  cooldown: CooldownInput | null,
  configOverrides: Partial<FeeRecConfig> = {},
  channelOverrides: OverrideMap = {},
  /** Per-channel learned fee elasticity modifier (channelId → ~0.8..1.25). */
  elasticity: Map<string, number> = new Map(),
  /** Per-channel "flow-won price" (channelId → ppm at which routing last returned
   *  after a no-flow lowering) — jump straight there instead of blind stepping. */
  flowAnchors: Map<string, number> = new Map(),
  /** Routing-fee promises of sold channels (capital.leaseCaps()). */
  leaseCaps: readonly LeaseCap[] = [],
  /** Market references and de-noised refused demand (read here when absent). */
  signals: FeeSignals = {},
): Promise<FeeRecReport> {
  const run = await runFeeEngine(lnd, {
    rebalanceRecords,
    cooldown,
    configOverrides,
    channelOverrides,
    elasticity,
    flowAnchors,
    leaseCaps,
    signals,
  });
  return run.report;
}

/** Everything the fee engine runs on (getFeeRecommendations' arguments). */
export interface FeeEngineInputs {
  rebalanceRecords: RebalanceRecord[];
  cooldown: CooldownInput | null;
  configOverrides?: Partial<FeeRecConfig>;
  channelOverrides?: OverrideMap;
  elasticity?: Map<string, number>;
  flowAnchors?: Map<string, number>;
  leaseCaps?: readonly LeaseCap[];
  signals?: FeeSignals;
}

/**
 * One run of the fee engine, with what it saw: the report, the channels, and
 * each channel's build context — so the rebalancer can ask the SAME engine
 * what it would do with a channel after a refill (feeAfterRefill) instead of
 * guessing at it with a copy of its rules (review a2: the profit gate valued
 * a refill at the drained channel's fee, then the engine cut the fee).
 */
export interface FeeEngineRun {
  report: FeeRecReport;
  channels: ChannelView[];
  /** The chain tip the run read (leases are measured by it). */
  currentBlock: number;
  /** The channel's context as this run built its recommendation. */
  contextOf(channelId: string): BuildCtx | undefined;
}

export async function runFeeEngine(lnd: AuthenticatedLnd, inputs: FeeEngineInputs): Promise<FeeEngineRun> {
  const { rebalanceRecords, cooldown } = inputs;
  const channelOverrides = inputs.channelOverrides ?? {};
  const elasticity = inputs.elasticity ?? new Map<string, number>();
  const flowAnchors = inputs.flowAnchors ?? new Map<string, number>();
  const leaseCaps = inputs.leaseCaps ?? [];
  const signals = inputs.signals ?? {};
  const cfg = { ...FEE_REC_DEFAULTS, ...(inputs.configOverrides ?? {}) };
  const [channels, rates, fw14, fw30, wallet, recentEvents] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
    getForwardsReport(lnd, cfg.flowWindowDays),
    getForwardsReport(lnd, cfg.benchmarkWindowDays),
    getWalletInfo({ lnd }),
    readForwardEvents(lnd, cfg.benchmarkWindowDays),
  ]);
  const demand = signals.demand ?? servableDemand(DEMAND_WINDOW_DAYS);
  const fresh = signals.market ?? (await marketWithin(lnd, channels, signals.marketWaitMs ?? MARKET_WAIT_MS));
  const nowMs = Date.now();
  // A reference this report's graph lacks is the channel's last one, for a
  // while (MARKET_MEMORY_MS) — for the market the engine reads itself.
  const market: Map<string, MarketFor> = signals.market
    ? new Map([...fresh].map(([id, ref]) => [id, { ref, seenAt: null }]))
    : recallMarket(lnd, fresh, nowMs);
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

  // Since each channel's fee last changed (the cooldown's stamp; none: the
  // window) — what sold at the fee it charges now.
  const windowStart = nowMs - cfg.benchmarkWindowDays * DAY_MS;
  const changedAt = (id: string): number => {
    const t = Date.parse(cooldown?.lastApplied?.[id] ?? "");
    return Number.isFinite(t) ? Math.max(t, windowStart) : windowStart;
  };
  const contexts = new Map<string, BuildCtx>(
    channels.map((ch) => [
      ch.id,
      {
        cfg,
        rate: rateById.get(ch.id),
        override: channelOverrides[ch.id],
        f14: flowOf(f14, ch.id),
        f30: flowOf(f30, ch.id),
        soldSinceChange: soldSince(recentEvents.events, ch.id, changedAt(ch.id)),
        currentBlock,
        records: rebalanceRecords,
        bench: nodeBenchmarks,
        enoughChannels,
        earnerCutoff,
        cooldown,
        elasticityMod: elasticity.get(ch.id) ?? 1,
        flowAnchor: flowAnchors.get(ch.id),
        leaseCap: activeCap(leaseCaps, { outpoint: `${ch.transactionId}:${ch.transactionVout}`, channelId: ch.id }, currentBlock),
        demand: demand.get(ch.id),
        market: market.get(ch.id)?.ref,
        marketSeenAt: market.get(ch.id)?.seenAt ?? null,
        nowMs,
      },
    ]),
  );
  const recommendations = channels.map((ch) => buildRecommendation(ch, contexts.get(ch.id) as BuildCtx));

  // §11 max-changes-per-run: every fee that breaks a lease promise first
  // (those are fixed first), then the operator's own pins, then the
  // biggest moves.
  const applyOrder = recommendations
    .filter((r) => r.wouldApply)
    .sort(
      (a, b) =>
        Number(b.leaseCapBreach) - Number(a.leaseCapBreach) ||
        Number(b.pinned) - Number(a.pinned) ||
        Math.abs(b.targetPpm - b.currentPpm) - Math.abs(a.targetPpm - a.currentPpm),
    );
  applyOrder.slice(cfg.maxChangesPerRun).forEach((r) => {
    r.wouldApply = false;
    r.blockedByGuards.push("max changes per run reached");
  });

  return {
    report: {
      generatedAt: new Date(nowMs).toISOString(),
      config: cfg,
      nodeBenchmarks,
      marketReferenced: recommendations.filter((r) => r.metrics.marketPpm !== null).length,
      elasticityLearned: recommendations.filter((r) => r.metrics.elasticityMod !== 1).length,
      recommendations,
    },
    channels,
    currentBlock,
    contextOf: (channelId) => contexts.get(channelId),
  };
}

/**
 * What the fee engine does with a channel after a refill — its own rules, on
 * the refilled balance, with the refill on its books as the autopilot will
 * record it: a lot of `amountSats` that cost `feeSats`, held at `holdPpm`
 * while its sats are in the channel (refillLots). The profit gate values a
 * refill at the fee this says the channel will charge (review a2: it valued
 * it at the drained channel's fee, and the engine then cut the fee at the
 * next update — "+167 sat expected" netted ~+35).
 */
export function feeAfterRefill(
  ch: ChannelView,
  ctx: BuildCtx,
  refill: { amountSats: number; feeSats: number; holdPpm: number | null },
): FeeRecommendation {
  const settled = ch.localBalance + ch.remoteBalance;
  const local = Math.min(settled, ch.localBalance + refill.amountSats);
  const after: ChannelView = {
    ...ch,
    localBalance: local,
    remoteBalance: settled - local,
    localRatio: settled > 0 ? local / settled : 0,
  };
  const lot: RebalanceRecord = {
    at: new Date(ctx.nowMs).toISOString(),
    via: "autopilot",
    targetId: ch.id,
    targetAlias: ch.peerAlias,
    sourceId: "",
    sourceAlias: "",
    amountSats: refill.amountSats,
    budgetPpm: 0,
    feeSats: refill.feeSats,
    costPpm: refill.amountSats > 0 ? Math.round((refill.feeSats / refill.amountSats) * 1_000_000) : null,
    ok: true,
    targetSentBefore: ch.totalSent,
    ...(refill.holdPpm !== null ? { holdPpm: refill.holdPpm } : {}),
  };
  // (No cooldown: where the fee goes, not whether this update may move it.)
  return buildRecommendation(after, { ...ctx, records: [lot, ...ctx.records], cooldown: null });
}

export interface RateInfo {
  fee_rate: number;
  base_fee_mtokens: string;
  transaction_id: string;
  transaction_vout: number;
}

/** What buildRecommendation needs of a channel. */
export type FeeChannel = Pick<ChannelView, "id" | "peerAlias" | "capacity" | "localRatio" | "role" | "active"> & {
  /** LND's lifetime "sent" counter of the channel — retires refilled sats as
   *  they route out (refillLots). Unknown: refills retire only by age. */
  totalSent?: number;
};

export interface BuildCtx {
  cfg: FeeRecConfig;
  rate: RateInfo | undefined;
  override: ChannelOverride | undefined;
  f14: Flow;
  f30: Flow;
  /** Routed since its fee last changed (soldSince) — absent: none known. */
  soldSinceChange?: Flow;
  currentBlock: number;
  records: RebalanceRecord[];
  bench: NodeBenchmarks;
  enoughChannels: boolean;
  earnerCutoff: number;
  cooldown: CooldownInput | null;
  elasticityMod: number;
  flowAnchor: number | undefined;
  leaseCap: (LeaseCap & { untilHeight: number | null }) | null;
  /** De-noised refusals on this channel (D20), DEMAND_WINDOW_DAYS. */
  demand: DemandSignal | undefined;
  /** What the market charges into this channel's peer. */
  market: MarketRef | undefined;
  /** `market` is a remembered reference (this report's graph had none for
   *  the peer): when it was last seen, ms. Null or absent: this report's. */
  marketSeenAt?: number | null;
  nowMs: number;
}

/** Which rule set this update's move — it decides the pacing and which
 *  reason leads. "range": the policy's min/max moved it (a fee outside them
 *  is brought into them in one move). "demand": the demand ramp raised it. */
type MoveKind = "free" | "raise_step" | "lower_step" | "ramp" | "ratchet" | "jump" | "floor" | "hold" | "range" | "demand";

/** One channel's recommendation — pure (exported for the engine's own
 *  simulation tests). */
export function buildRecommendation(ch: FeeChannel, ctx: BuildCtx): FeeRecommendation {
  const { cfg, rate, f14, f30, records, bench, enoughChannels, earnerCutoff } = ctx;
  const currentPpm = rate?.fee_rate ?? 0;
  const cap = Math.max(1, ch.capacity);
  const step = Math.max(1, cfg.stepPpm);
  // The reason that leads is the one shown in the Why column and recorded
  // as the run history's "why" (reasons[0]), so it must be the rule that set
  // the move — review: a raise toward the replacement cost read "market: …
  // balanced level 80→36 ppm to compete". Rules that set the target outright
  // (a hold, a floor, the no-flow rule, a pin, a lease promise) go in front
  // as they apply (`dominant`); the other lines are notes, and the note that
  // set the aim is moved up behind them once the move is known (`lead`).
  const reasons: string[] = [];
  let dominantCount = 0;
  const dominant = (line: string): void => {
    reasons.unshift(line);
    dominantCount += 1;
  };
  /** Take back a line whose rule did not set the move after all. */
  const dropLine = (line: string | null): void => {
    const at = line == null ? -1 : reasons.indexOf(line);
    if (at < 0) return;
    reasons.splice(at, 1);
    if (at < dominantCount) dominantCount -= 1;
  };
  // Lines that say what the engine's own move does ("ramping 80→120", "kept
  // at 350 ppm or more", "brought down to it at once"), each with the fact it
  // states without that claim (null: nothing left to say) and the direction
  // it claims (0: none, a bound). When a pin, an exclusion or a lease promise
  // sets another move, only the facts stay — a pinned 25 ppm read "profit
  // floor: … — ramping 80→84" beside it; so do they when the fee moves the
  // other way all the same ("lowering toward 95 ppm" under a floor's raise).
  const claims = new Map<string, { fact: string | null; dir: -1 | 0 | 1 }>();
  const claim = (line: string, fact: string | null, dir: -1 | 0 | 1 = 0): string => {
    claims.set(line, { fact, dir });
    return line;
  };

  // 1. metrics
  const grossFlow14d = (f14.out + f14.inn) / cap;
  const netDrain14d = (f14.out - f14.inn) / cap;
  const grossFlow30d = (f30.out + f30.inn) / cap;
  const netDrain30d = (f30.out - f30.inn) / cap;
  const revenuePpm14d = f14.out > 0 ? Math.round((f14.revenue / f14.out) * 1_000_000) : null;
  const revenuePpm30d = f30.out > 0 ? Math.round((f30.revenue / f30.out) * 1_000_000) : null;
  const ageDays = channelAgeDays(ch.id, ctx.currentBlock);
  const isNewChan = ageDays != null && ageDays < cfg.newChannelProtectionDays;
  // The refills still in the channel set the profit floor (refillLots).
  const refill = refillFloor(refillLots(ch.id, records, ch.totalSent, ctx.nowMs), cfg.safetyMargin);
  const costBasisPpm = refill?.costPpm ?? null;
  // Released under low flow (review a2): refilled sats that sat a week on a
  // channel routing next to nothing, at a healthy local ratio, are not moved
  // by holding their price — before, one forward a month kept a floor.
  const newestRefillMs = refill ? Math.max(...refill.lots.map((l) => Date.parse(l.at))) : NaN;
  const floorReleased =
    !!refill &&
    ctx.nowMs - newestRefillMs >= LOW_FLOW_GRACE_DAYS * DAY_MS &&
    f14.forwards < LOW_FLOW_FORWARDS &&
    ch.localRatio >= LOW_FLOW_LOCAL_RATIO;
  const rawFloor = refill && !floorReleased ? refill.ppm : null;
  // A floor above the operator's own ceiling only with their opt-in: one
  // pricey refill used to lift a channel past maxPpm in a single move.
  const profitFloorCapped = rawFloor != null && !cfg.floorAboveMax && rawFloor > cfg.maxPpm;
  const profitFloorPpm = rawFloor == null ? null : profitFloorCapped ? cfg.maxPpm : rawFloor;
  const isTopEarner = enoughChannels && f30.revenue > 0 && f30.revenue >= earnerCutoff;

  // D20 — possible demand: HTLCs refused for lack of outbound, de-noised (no
  // probes, retries or HTLCs no refill could carry). Repeated ones mean the
  // channel likely has demand even without a successful forward: it is not
  // "idle".
  const demand = ctx.demand;
  const inDemand = !!demand && demand.attempts >= DEMAND_MIN_ATTEMPTS && demand.days >= DEMAND_MIN_DAYS;
  // Nobody routed through it in 30 days (and it isn't new, and it isn't
  // turning payments away): drained, it is held; otherwise lowered by the
  // no-flow rule.
  const idle = f30.forwards === 0 && !isNewChan && !inDemand;

  // §6 peer gate — has it routed out (or seen flow) in the gate window?
  // On active routing paths in either direction? A fully-drained channel can't
  // route out, so also count inbound flow (it's being naturally refilled) and
  // payments it turned away — else we'd wrongly flag a busy, just-drained
  // channel as a dead peer.
  const peerGate: "ok" | "weak" = f30.out > 0 || f30.inn > 0 || f30.forwards > 0 || inDemand ? "ok" : "weak";

  // Market reference (public graph): what others charge into the same peer
  // — this report's, or the last one seen (MARKET_MEMORY_MS), which says so.
  const market = ctx.market;
  const seen = market && ctx.marketSeenAt != null ? ` (last seen ${since(ctx.marketSeenAt, ctx.nowMs)})` : "";
  const marketPpm = market?.intoPeerPpm ?? null;
  const replacementCostPpm = market ? market.intoPeerPpm + (market.peerFeeToUsPpm ?? 0) : null;
  const draining = f30.forwards >= DRAIN_MIN_FORWARDS && netDrain30d >= DRAIN_NET_SHARE;
  const competitivePpm = marketPpm != null ? Math.max(cfg.minPpm, Math.round(marketPpm * MARKET_SHARE)) : null;

  // §2 target ratio
  const targetLocalRatio = targetLocalRatioFor(ch.role, cfg);

  // §3 velocity modifier — volume-first: gentle on raises (never slam a working
  // channel up), and lower idle outbound liquidity to win flow. The first
  // three branches say the channel wins flow at its price (`winsFlow`).
  let velocityMod = 1;
  let exploring = false;
  let winsFlow = false;
  let velocityLine: string | null = null;
  if (grossFlow14d >= 0.2 && netDrain14d >= 0.1) {
    velocityMod = 1.1;
    winsFlow = true;
    velocityLine = `velocity: draining fast (${Math.round(netDrain14d * 100)}% net in ${cfg.flowWindowDays}d) — small nudge up`;
  } else if (grossFlow14d >= 0.05 && netDrain14d >= 0.03) {
    velocityMod = 1.05;
    winsFlow = true;
    velocityLine = "velocity: steady outbound demand — small nudge up";
  } else if (grossFlow14d >= 0.2 && Math.abs(netDrain14d) < 0.05) {
    winsFlow = true;
    velocityLine = "velocity: active and balanced — holding";
  } else if (grossFlow14d < 0.01 && ch.localRatio > targetLocalRatio + 0.2 && !inDemand && !isNewChan) {
    // (Never on a brand-new channel: it has had no time to route.)
    velocityMod = cfg.exploreLowerModifier;
    exploring = true;
    velocityLine = "idle test: idle outbound liquidity — testing a lower fee";
  }

  // §4 conservative node-benchmark nudge
  let benchMod = 1;
  let benchmarkComparison: "above" | "median" | "below" = "median";
  let benchLine: string | null = null;
  if (enoughChannels && bench.medianGrossFlow14d > 0) {
    if (grossFlow14d >= bench.medianGrossFlow14d * 1.5) benchmarkComparison = "above";
    else if (grossFlow14d <= bench.medianGrossFlow14d * 0.5) benchmarkComparison = "below";
    if (benchmarkComparison === "above" && netDrain14d > 0.05) {
      benchMod = 1.05;
      benchLine = "benchmark: outperforms node average and draining — raising fee";
    } else if (isTopEarner) {
      // never let a top earner be pushed cheaper (by this rule, the explore
      // test or the market below)
      if (velocityMod < 1) velocityMod = 1;
      benchLine = "benchmark: top-earning channel — preserving fee level";
    } else if (benchmarkComparison === "below" && ch.localRatio > targetLocalRatio + 0.15 && peerGate === "ok" && !inDemand) {
      benchMod = 0.95;
      exploring = exploring || velocityMod <= 1;
      benchLine = "benchmark: below node flow average — testing a lower fee";
    }
  }

  // The balanced level: the operator's — lowered toward a cheaper market only
  // on a channel that is NOT winning flow at its own price: nothing forwarded
  // in the flow window, testing a lower fee, or well below the node's flow.
  // A channel that routes at its price keeps it: a top earner, one whose
  // velocity says draining, steady outbound demand or active and balanced, a
  // draining channel (its replacement cost decides) and one turning payments
  // away (review: a top earner routing 2.4M a month at 80 ppm was cut toward
  // 27 ppm while its own reasons said "holding"). The operator's level stays
  // the ceiling — raising toward the market is what the replacement cost
  // below does, and only for draining channels.
  const notWinningFlow = f14.forwards === 0 || exploring || benchmarkComparison === "below";
  const keepsItsPrice = winsFlow || isTopEarner || draining || inDemand;
  let neutral = cfg.neutralPpm;
  let marketLine: string | null = null;
  if (competitivePpm != null && competitivePpm < neutral && notWinningFlow && !keepsItsPrice) {
    neutral = competitivePpm;
    marketLine = `market: other nodes charge ~${marketPpm} ppm into this peer${seen} — balanced level ${cfg.neutralPpm}→${neutral} ppm to compete`;
    reasons.push(marketLine);
  }
  if (velocityLine) reasons.push(velocityLine);
  if (benchLine) reasons.push(benchLine);

  // §1 balance base on the (possibly market-lowered) balanced level
  const base = balanceTargetPpm(ch.localRatio, targetLocalRatio, { ...cfg, neutralPpm: neutral });

  // §3.5 elasticity gate: don't raise on drain if raising measurably lost flow
  // here before. Only bites when there's real evidence (elasticityMod < 1);
  // neutral history (1.0) leaves the drain reflex untouched.
  if (velocityMod > 1 && ctx.elasticityMod < 1) {
    velocityMod = 1;
    reasons.push("elasticity: raising lost revenue here before — not raising on drain");
  }

  // §10 precedence: base × modifiers. Elasticity is folded INTO the clamp so a
  // learned signal can steer the price toward the revenue peak but never blow
  // past the combined envelope.
  const combinedMod = clamp(velocityMod * benchMod * ctx.elasticityMod, 0.7, 1.5);
  let aim = base * combinedMod;
  let elasticityLine: string | null = null;
  if (ctx.elasticityMod !== 1) {
    const without = Math.round(base * clamp(velocityMod * benchMod, 0.7, 1.5));
    elasticityLine =
      ctx.elasticityMod > 1
        ? `elasticity ×${ctx.elasticityMod}: measured changes here say charging more lifted revenue — aim ${without}→${Math.round(aim)} ppm, raise step widened`
        : `elasticity ×${ctx.elasticityMod}: measured changes here say higher fees cost flow — aim ${without}→${Math.round(aim)} ppm`;
    reasons.push(elasticityLine);
  }

  // Raise only on a drain signal (review 2). Once a lower fee (the market's,
  // or one the no-flow rule found) won a channel two-way flow, the balance
  // curve raised it straight back out of that price — 50 → 70 on the way to
  // the balanced level of 80 — and with nothing routed for two weeks the
  // market lowered it again, and so on: over 120 simulated days such a
  // channel sat priced out 80–90 % of the time. A channel that isn't below
  // its target ratio (the curve raising a drained channel IS a drain signal)
  // and that nothing says drains — no drain velocity, not draining (its
  // replacement cost decides) — is held at its fee: routing at it, it is the
  // price that wins flow; routing nothing, a higher fee wins nothing back
  // either (and a run that missed the market reference raised a market-priced
  // channel back toward the operator's level). Only a floor (protect, profit
  // floor, new channel, below) or the policy's min lifts it then. A lower
  // aim — the curve over the target ratio, the market, a measured elasticity
  // below 1 — still applies. Where a measured elasticity below 1 has switched
  // the drain reflex off ("not raising on drain"), draining raises nothing
  // either: the channel is held — before, its reasons said "not raising
  // toward the replacement cost" while the curve raised it all the same. (The
  // benchmark's draining nudge needs a 14-day net drain over 5 %, which is
  // drain velocity too.)
  const noDrainSignal =
    ch.localRatio >= targetLocalRatio - cfg.deadband && velocityMod <= 1 && (!draining || ctx.elasticityMod < 1);
  // (A fee below the policy's min is lifted to the min by the range rule.)
  let heldLine: string | null = null;
  const curveAt = (): string => `the balance curve's ~${Math.round(aim / step) * step} ppm`;
  if (noDrainSignal && aim > currentPpm) {
    heldLine = draining
      ? `hold: draining, but higher fees cost flow here before — not raised toward ${curveAt()}`
      : f14.forwards > 0
        ? `hold: it routes at ${currentPpm} ppm (${f14.forwards} forward${f14.forwards === 1 ? "" : "s"} in ${cfg.flowWindowDays} d) and nothing says it drains — not raised toward ${curveAt()}`
        : `hold: not below its target ratio and nothing says it drains — not raised toward ${curveAt()} (a higher fee wins no flow back)`;
    aim = currentPpm;
    reasons.push(heldLine);
  } else if (draining && !market && aim < currentPpm) {
    // A draining channel with no market reference — none in this report and
    // none remembered (a thin peer, a cold start, a graph that can't be
    // read): what refilling it costs is unknown, so its outbound is not sold
    // cheaper on the balance curve's word either — held (review 3: one run
    // without the reference lowered a channel priced at its refill cost
    // 340 → 310 toward the balanced level; with every lowering restarting the
    // 72 h raise wait, gaps every few days walked it down to ~100 for good).
    // A higher aim still raises it; the range rule and a lease promise still
    // lower it.
    heldLine = `hold: draining — no market reference for its refill cost this run, so it is not lowered toward ${curveAt()}`;
    aim = currentPpm;
    reasons.push(heldLine);
  }

  // Replacement cost (review a1): a draining channel's outbound is sold once —
  // getting it back costs at least one hop into the peer and the peer's hop
  // back to us. Price toward that (gently, through the raise step below)
  // instead of selling it below what it costs to replace. Two-way channels
  // keep their volume-first price.
  const belowReplacement = draining && replacementCostPpm != null && currentPpm < replacementCostPpm;
  // Set only when it raised the aim (it then leads the reasons).
  let replacementLine: string | null = null;
  if (draining && replacementCostPpm != null && market) {
    const refill = Math.min(cfg.maxPpm, Math.round(replacementCostPpm * cfg.safetyMargin));
    if (refill > aim) {
      const cost =
        `a refill costs at least ~${replacementCostPpm} ppm (others charge ~${market.intoPeerPpm} into the peer` +
        `${market.peerFeeToUsPpm != null ? `, it charges ${market.peerFeeToUsPpm} back to you` : ""})${seen}`;
      if (ctx.elasticityMod < 1) {
        // Measured here: higher fees cost flow. The replacement cost doesn't
        // raise the fee then (review: "raising lost revenue here before — not
        // raising on drain", and the aim still went 80 → 350) — but the
        // outbound isn't sold cheaper still either: held at the current fee
        // (or the curve's aim, if that is higher — only on a channel below its
        // target ratio; anywhere else the hold above already kept the fee).
        aim = Math.max(aim, Math.min(refill, currentPpm));
        reasons.push(
          currentPpm < refill
            ? `replacement: draining, and ${cost} — but higher fees cost flow here before: not raising toward ${refill} ppm, nor selling cheaper`
            : `replacement: draining, and ${cost} — not sold below ${refill} ppm`,
        );
      } else {
        aim = refill;
        // (Priced above it, the channel is lowered toward it — and no
        // further: the curve's level below it is not where it is going.)
        replacementLine =
          currentPpm > refill
            ? claim(`replacement: draining, and ${cost} — priced above that: lowering toward ${refill} ppm, not below`, `replacement: draining, and ${cost}`, -1)
            : claim(`replacement: draining, and ${cost} — pricing toward ${refill} ppm`, `replacement: draining, and ${cost}`, 1);
        reasons.push(replacementLine);
      }
    }
  }

  // ── the move: bounded steps toward the aim ─────────────────────────────
  let target = aim;
  let kind: MoveKind = "free";
  // The move's bounds (for rounding below, which must not stretch them).
  let hiLimit = Infinity;
  let loLimit = -Infinity;
  // Every raise that isn't a floor moves at most RAISE_STEPS steps, routing
  // or not — the gentle-raise philosophy (never slam a channel up: that is
  // what once priced the node out of the market) on every channel. Measured
  // elasticity may widen the step, never remove the bound. Counted from the
  // fee itself (it was counted from the balanced level for a fee of 0: "0 →
  // 100" in one update); a fee below the policy's min is brought up to the
  // min first, by the range rule below.
  const from = currentPpm;
  const elasticStep = ctx.elasticityMod > 1 ? Math.min(MAX_ELASTIC_STEP, ctx.elasticityMod) : 1;
  // The demand ramp (2026-10-24): drained, with buyers — it routed in 30
  // days AND sold at the fee it charges now, since that fee was set — not
  // refilled faster than it sells, and no measurement saying higher fees
  // cost flow here. Two steps every 72 h took a drained top earner (1 %
  // local, 151 forwards a month) six weeks from 350 ppm to the ~640 a
  // refill at the market's ~500 ppm route cost needs, selling every sat that
  // came back below what it costs to replace. A quarter of the fee per move,
  // every DEMAND_RAMP_HOURS, gets it there in a day — but each move only
  // after a sale at the price before it: where nobody buys at the new price,
  // it stops one step above the last one that sold (the ordinary steps go
  // on). Never past the aim; a channel with liquidity keeps the gentle steps.
  const sold = ctx.soldSinceChange;
  const drainedWithBuyers = ch.localRatio < DEMAND_RAMP_LOCAL && f30.forwards >= DRAIN_MIN_FORWARDS && f14.out >= f14.inn;
  const demandRamp = drainedWithBuyers && (sold?.forwards ?? 0) >= DEMAND_RAMP_SALES && ctx.elasticityMod >= 1;
  const ordinaryStep = RAISE_STEPS * step * elasticStep;
  // (Rounded down onto the grid: "up to a quarter" holds — 25 % of 100 is a
  // 20-ppm move on a 10-ppm grid, never 30.)
  const raiseStep = demandRamp ? Math.max(ordinaryStep, Math.floor((from * DEMAND_RAMP_SHARE) / step) * step) : ordinaryStep;
  // The most any channel is lowered in one move: its ratchet's steps (at
  // least one).
  const lowerStep = Math.max(1, cfg.noFlowRatchetSteps) * step;
  if (target > from + raiseStep) {
    target = from + raiseStep;
    kind = demandRamp ? "demand" : "raise_step";
    hiLimit = from + raiseStep;
  } else if (demandRamp && target > from) {
    // Its last move, onto the aim, keeps the ramp's pacing too (as "free" it
    // would wait the 72 h raise pause behind the ramp's own previous move).
    kind = "demand";
  }
  // Nor does it jump a floor whose own ramp lifts the fee this move (protect,
  // the profit floor): it stops on it — at that ramp's cadence, the
  // operator's — and goes on from there (review 2: with a 1 h cadence,
  // 310 → 380 waited 6 h where 310 → 350 takes one).
  let floorAhead = 0;
  if (kind === "demand") {
    const protectAhead = ch.localRatio < 0.1 && (f30.forwards > 0 || inDemand) ? cfg.protectPpm : 0;
    const profitAhead = profitFloorPpm != null && refill && !idle ? profitFloorPpm : 0;
    const ahead = Math.max(protectAhead, profitAhead);
    if (ahead > from && target > ahead) {
      floorAhead = ahead;
      target = ahead;
      hiLimit = Math.min(hiLimit, ahead);
    }
  }
  // A move the step rules set never ends past its own bound or its aim —
  // also one within a single step ("free"), which the rounding below could
  // otherwise stretch by up to half a step (P2 final review: 95 → 120 under
  // "pricing toward 115 ppm", 246 → 175 under "lowering toward 178 ppm, not
  // below"). The floors, the no-flow rule and the range rule below set their
  // own limits where they take over.
  if (target > currentPpm) hiLimit = Math.min(hiLimit, from + raiseStep, aim);
  else if (target < currentPpm) loLimit = Math.max(loLimit, currentPpm - lowerStep, aim);
  // A drained channel nobody routes through is never raised: there is no
  // flow to slow, and it would sit at a high fee once it refills (review a1:
  // 80 → 900 ppm in one update, then stuck at 590 after a refill).
  const drainedIdle = idle && ch.localRatio < 0.1;
  let drainedIdleLine: string | null = null;
  if (drainedIdle && target > currentPpm) {
    target = currentPpm;
    aim = Math.min(aim, currentPpm);
    kind = "hold";
    drainedIdleLine = `hold: drained (${Math.round(ch.localRatio * 100)}% local) and idle for 30 days — an idle channel is never raised`;
    dominant(drainedIdleLine);
  }

  // §10 floors. The binding floor's reason is unshifted to the front so the
  // *dominant* reason is shown first. The protect and profit-floor ramps move
  // at most RAMP_STEPS steps per update; only the new-channel floor jumps.
  let floored: FeeRecState | null = null;
  let hardFloor = 0;
  // The highest floor the aim keeps (rounding never takes the aim under it).
  let aimFloor = 0;
  let aimCeiling = cfg.maxPpm;
  if (ageDays != null && ageDays < cfg.newChannelProtectionDays && f30.forwards < 3) {
    // Its protected fee holds whether or not it binds this move: rounding
    // never takes a new channel under it (an aim of exactly 80 rounded to 75
    // on a 25-ppm grid).
    aimFloor = Math.max(aimFloor, cfg.newChannelMinPpm);
    hardFloor = Math.max(hardFloor, cfg.newChannelMinPpm);
    if (cfg.newChannelMinPpm > target) {
      const fact = `new channel: only ${ageDays}d old with little history — its protected fee is ${cfg.newChannelMinPpm} ppm`;
      const line = `new channel: only ${ageDays}d old with little history — keeping a protected fee`;
      target = cfg.newChannelMinPpm;
      aim = Math.max(aim, cfg.newChannelMinPpm);
      aimCeiling = Math.max(aimCeiling, cfg.newChannelMinPpm);
      if (cfg.newChannelMinPpm > currentPpm) {
        // It lifts the fee: at once, and it is why.
        kind = "floor";
        hiLimit = Infinity;
        dominant(claim(line, fact));
      } else {
        // A fee above it is only stopped short of it (lowered by steps).
        reasons.push(claim(`${line} (not below ${cfg.newChannelMinPpm} ppm)`, fact));
      }
    }
    exploring = false; // never explore-lower a brand-new channel
  }
  // How far a floor lifts this move: upward by at most RAMP_STEPS steps (a
  // floor below the current fee only stops a lowering short of it). A fee
  // below the policy's min goes to the min first (the range rule below).
  const liftTo = (floor: number): number =>
    floor > currentPpm ? Math.min(floor, currentPpm < cfg.minPpm ? cfg.minPpm : currentPpm + RAMP_STEPS * step) : floor;
  // The highest floor (profit, protect) whose own ramp lifts the fee this
  // move: a demand move up to it keeps the floor ramp's cadence — the
  // operator's, which may be shorter than the demand ramp's 6 h.
  let floorRampTo = 0;
  // (An idle channel's floor would be overridden by the no-flow rule below.)
  if (profitFloorPpm != null && refill && profitFloorPpm > target && !idle) {
    const ramped = liftTo(profitFloorPpm);
    if (ramped > currentPpm) floorRampTo = Math.max(floorRampTo, profitFloorPpm);
    // It leads when its ramp IS this move. One below the current fee only
    // stops a lowering short of it — that lowering's own rule leads; one that
    // a bigger lift outdoes (the new-channel floor) is a note (it led with
    // "ramping 45→49" while the new-channel floor took the fee 45 → 80).
    const lifts = ramped > currentPpm && ramped > target;
    if (ramped > target) {
      target = ramped;
      if (lifts) {
        kind = "ramp";
        hiLimit = ramped;
      }
    }
    aim = Math.max(aim, profitFloorPpm);
    aimFloor = Math.max(aimFloor, profitFloorPpm);
    hardFloor = Math.max(hardFloor, ramped);
    aimCeiling = Math.max(aimCeiling, profitFloorPpm);
    floored = "recovering_cost";
    const fact = floorFact(refill, cfg, ctx.nowMs) + (profitFloorCapped ? ` — capped at your max ${cfg.maxPpm} ppm` : "");
    const line = fact + (lifts && ramped < profitFloorPpm ? ` — ramping ${currentPpm}→${ramped}` : "");
    if (lifts) dominant(claim(line, fact, line === fact ? 0 : 1));
    else reasons.push(profitFloorPpm <= currentPpm ? claim(`${line} — not lowered below it`, fact) : line);
  }
  if (floorReleased && refill && !idle) {
    reasons.push(
      `profit floor released: ${satsShort(refill.remainingSats)} of refills still here, but under ${LOW_FLOW_FORWARDS} forwards out in ` +
        `${cfg.flowWindowDays} d at ${Math.round(ch.localRatio * 100)}% local — holding their price (${refill.ppm} ppm) isn't moving them`,
    );
  }
  // Protect only a drained channel that is STILL in demand — a modest bump to
  // slow the bleed, never a flat ceiling. In demand: it forwarded in the
  // window, or it keeps turning payments away for lack of outbound.
  if (ch.localRatio < 0.1 && (f30.forwards > 0 || inDemand)) {
    // Ramp, don't slam: step toward protectPpm by at most RAMP_STEPS steps
    // per change (the old one-shot jump to protectPpm was the outage
    // mechanic in miniature).
    const ramped = liftTo(cfg.protectPpm);
    if (ramped > currentPpm) floorRampTo = Math.max(floorRampTo, cfg.protectPpm);
    // It leads only when it lifts the fee (a fee above protectPpm walking
    // down the curve, or stopped at protectPpm on the way, is not "bumped").
    const lifts = ramped > target && ramped > currentPpm;
    if (ramped > target) {
      target = ramped;
      if (lifts) {
        kind = "ramp";
        hiLimit = ramped;
      }
    }
    aim = Math.max(aim, cfg.protectPpm);
    aimFloor = Math.max(aimFloor, cfg.protectPpm);
    hardFloor = Math.max(hardFloor, ramped);
    aimCeiling = Math.max(aimCeiling, cfg.protectPpm);
    floored = "protecting_liquidity";
    const fact = `protect: drained (${Math.round(ch.localRatio * 100)}% local) but still in demand`;
    // (Short of protectPpm this move, it is "ramping toward" it — also when
    // another floor's lift set the move: "kept at 350 ppm or more" was false
    // there.)
    const toward = `${fact} — ramping toward ${cfg.protectPpm} ppm`;
    if (lifts) dominant(claim(ramped < cfg.protectPpm ? toward : `${fact} — modest bump`, fact, 1));
    else reasons.push(ramped < cfg.protectPpm ? claim(toward, fact, 1) : claim(`${fact} — kept at ${cfg.protectPpm} ppm or more`, fact));
  }

  // No routing → lower (the core volume-first safety): a channel that hasn't
  // routed in the benchmark window gets cheaper, toward minPpm, to win flow
  // back. Overrides the curve + floors (except new-channel protection) — the
  // opposite of a drain reflex. We never price-kill an idle channel. A channel
  // that keeps turning payments away is not idle (D20): no lowering.
  let noFlowLowering = false;
  let noFlowLine: string | null = null;
  const exploringBeforeNoFlow = exploring;
  if (idle && ch.localRatio >= 0.1) {
    const anchor = ctx.flowAnchor;
    // The market's price on the "Round to" grid: an idle channel already
    // there (40 ppm against 0.9 × 40 = 36) is AT the market — before, the
    // jump to 36 rounded back to 40 every day, and the channel never stepped
    // on below it.
    const marketDest = competitivePpm != null ? Math.max(cfg.minPpm, Math.round(competitivePpm / step) * step) : null;
    let lowered: number;
    let dest: number;
    let why: string;
    if (anchor != null && currentPpm > anchor) {
      // Flow-won anchor: routing last returned here at a known price — jump
      // straight to it (best evidence beats blind stepping; a lower can't
      // hurt a channel that routed nothing for 30 d).
      lowered = anchor;
      dest = anchor;
      kind = "jump";
      why = `no flow: dropping to ${Math.max(cfg.minPpm, anchor)} ppm — the last price that won routing back here`;
    } else if (anchor == null && marketDest != null && currentPpm > marketDest) {
      // No anchor yet: the market's price into this peer is the next best
      // evidence — a Tor-only small node can't afford a month per blind
      // price test (review a1: blind-price-discovery).
      lowered = marketDest;
      dest = marketDest;
      kind = "jump";
      why = `no flow: other nodes charge ~${marketPpm} ppm into this peer${seen} — dropping to ${marketDest} ppm instead of stepping down blind`;
    } else {
      // Below the anchor or the market (or no reference): slow stepping —
      // demand may have moved. (A fee below the min — 0, say — is brought up
      // to the min by the range rule, not to the balanced level.)
      lowered = currentPpm - lowerStep;
      dest = cfg.minPpm;
      kind = "ratchet";
      why = "no flow: nothing routed here recently — lowering toward min to win routing back";
    }
    // Exactly the evidence's price, or exactly one ratchet step: the curve or
    // an explore price no longer cut an idle channel further in one move
    // (review: 1,500 → 900 ppm at 20% local; and a "dropping to 200 ppm" jump
    // that landed on the curve's 40).
    target = Math.max(cfg.minPpm, lowered);
    aim = Math.max(cfg.minPpm, Math.min(aim, dest));
    // Rounding must not stretch the one step, nor move a jump off the price
    // it jumps to.
    loLimit = target;
    hiLimit = kind === "jump" ? target : Infinity;
    hardFloor = 0;
    aimFloor = 0;
    aimCeiling = cfg.maxPpm;
    floored = null;
    exploring = true;
    noFlowLowering = true;
    noFlowLine = claim(why, "no flow: nothing routed here recently", -1);
    dominant(why);
  }

  // Every other lowering moves at most the ratchet's steps, too — routing,
  // turning payments away, brand new or drained: a refill or a curve swing
  // must not cut a channel's price to a fraction overnight. (Only the policy
  // range below can move it further.)
  if (!noFlowLowering && target < currentPpm - lowerStep) {
    target = currentPpm - lowerStep;
    kind = "lower_step";
    loLimit = currentPpm - lowerStep;
  }

  // §10 clamp + round — floors may push the ceiling above maxPpm. Rounding
  // never stretches a bounded move past its bound.
  const ceiling = Math.max(cfg.maxPpm, hardFloor);
  target = clamp(target, cfg.minPpm, ceiling);
  aim = clamp(aim, cfg.minPpm, aimCeiling);
  // The policy range wins over a step bound (an operator who lowers maxPpm
  // means it now): a fee above the max is brought down to it in one move. A
  // fee below the min is brought up to the min — and only to it, raises step
  // on from there (before, a fee of 0 went "0 → 100" in one update, under a
  // "raising at most 20 ppm per move" guard); only the new-channel floor
  // lifts it further at once. Either way the range is the reason.
  // (Above the max: whether the clamp brought it to the max or another rule
  // already had — a profit floor stopping a lowering at the max; a rule that
  // takes it lower still decides, and leads.)
  const aboveMax = currentPpm > ceiling && target >= ceiling;
  const belowMin = currentPpm < cfg.minPpm && target > currentPpm && kind !== "floor";
  if (belowMin) {
    target = cfg.minPpm;
    // The range lifts it — not the rule that held or lowered it: an idle
    // channel at 0 read "no flow: … lowering toward min" under "brought up to
    // it", counted as a no-flow lowering (opening a flow-won episode for a
    // raise) and as testing a lower fee; a drained idle one kept "an idle
    // channel is never raised". (Their lines go at the end, with every line
    // that denies the final move; the episode flag is a lowering's only.)
    if (noFlowLowering) exploring = exploringBeforeNoFlow;
  }
  if (aboveMax || belowMin) {
    kind = "range";
    // (A pin or an exclusion below decides instead — and says so.)
    const manual = ctx.override?.mode === "exclude" || (ctx.override?.mode === "fixed" && Number.isFinite(ctx.override.fixedPpm));
    if (!manual) {
      const max = target > cfg.maxPpm ? `${Math.round(target)} ppm (your max, lifted to its floor)` : `your max of ${cfg.maxPpm} ppm`;
      const fact = aboveMax ? `range: ${currentPpm} ppm is above ${max}` : `range: ${currentPpm} ppm is below your min of ${cfg.minPpm} ppm`;
      dominant(
        aboveMax ? claim(`${fact} — brought down to it at once`, fact, -1) : claim(`${fact} — brought up to it at once, raised from there by steps`, fact, 1),
      );
    }
  }
  if (target < loLimit) loLimit = -Infinity;
  if (target > hiLimit) hiLimit = Infinity;
  // On the "Round to" grid — but a fee at the policy's min or max lands
  // there exactly: rounding 25 up to 30 (Math.round(2.5)) stopped every walk
  // down 5 ppm short of a min of 25, and rounding could cross either bound.
  const onGrid = (p: number, hi: number): number =>
    p <= cfg.minPpm ? cfg.minPpm : p >= hi ? hi : clamp(Math.round(p / step) * step, cfg.minPpm, hi);
  let targetPpm = onGrid(target, ceiling);
  if (targetPpm > hiLimit) targetPpm = Math.floor(hiLimit);
  if (targetPpm < loLimit) targetPpm = Math.ceil(loLimit);
  // Nor under a floor this move keeps (the new channel's fee, a protect or
  // profit-floor ramp): it lands on it exactly — on a 25-ppm grid a new
  // channel's 80 rounded to 75 while its line said "not below 80 ppm".
  if (targetPpm < hardFloor && target >= hardFloor) targetPpm = hardFloor;
  // A hold holds, and rounding never turns a move around or makes one up: a
  // fee off the step's grid (set by hand, or before the step changed) is not
  // "dropped to 90 ppm" by a write of 100, nor raised 25 → 30 by rounding.
  if (kind === "hold" || Math.sign(targetPpm - currentPpm) !== Math.sign(target - currentPpm)) targetPpm = currentPpm;
  let aimPpm = onGrid(aim, aimCeiling);
  if (aimPpm < aimFloor && aim >= aimFloor) aimPpm = aimFloor;
  // A bounded move says so — with the move itself, in ppm (review a1: the
  // reason said "pricing ~5% higher" while the fee went 80 → 450).
  // Only when the step is what stops the move short of the aim: a fee held
  // at the max read "raising at most 22 ppm per move — 1000→1000 on the way
  // to 1000 ppm". (Taken back if a pin or a lease promise sets another move.)
  // The demand ramp sets the size of the move, so it leads — the run
  // history and the fee-change log keep the first reason (review: a +25 %
  // move logged as "velocity: … small nudge up").
  const localPct = Math.round(ch.localRatio * 100);
  if (kind === "demand" && targetPpm > currentPpm) {
    const n = sold?.forwards ?? 0;
    const fact = `demand: drained (${localPct}% local) and sold ${n} time${n === 1 ? "" : "s"} at ${currentPpm} ppm since it was set`;
    const hours = targetPpm <= floorRampTo ? (ctx.cooldown?.cooldownHours ?? 0) : Math.max(DEMAND_RAMP_HOURS, ctx.cooldown?.cooldownHours ?? 0);
    const onFloor = floorAhead > 0 && targetPpm === floorAhead ? ` (onto its ${floorAhead} ppm floor first)` : "";
    const move = targetPpm < aimPpm ? `${currentPpm}→${targetPpm}${onFloor} on the way to ${aimPpm} ppm` : `${currentPpm}→${targetPpm} ppm, its aim`;
    dominant(claim(`${fact} — raising a quarter of the fee per move (at least two steps), at most every ${hours} h: ${move}`, fact, 1));
  } else if (drainedWithBuyers && !demandRamp && ctx.elasticityMod >= 1 && targetPpm > currentPpm && aimPpm > currentPpm) {
    // Drained with buyers, but nothing sold at this fee yet: the next ramp
    // move waits for a sale; the ordinary step (or a floor's ramp) goes on.
    reasons.push(claim(`demand: drained (${localPct}% local), but nothing sold at ${currentPpm} ppm since it was set — the faster raise waits for a sale`, null, 1));
  }
  if (kind === "raise_step" && targetPpm > currentPpm && targetPpm < aimPpm) {
    reasons.push(claim(`guard: raising at most ${Math.round(raiseStep)} ppm per move — ${currentPpm}→${targetPpm} on the way to ${aimPpm} ppm`, null, 1));
  } else if (kind === "lower_step" && targetPpm < currentPpm && targetPpm > aimPpm) {
    reasons.push(claim(`guard: lowering at most ${lowerStep} ppm per move — ${currentPpm}→${targetPpm} on the way to ${aimPpm} ppm`, null, -1));
  }

  if (inDemand && demand) {
    // Possible demand, not proven payments (D20; P3 review): refused HTLCs a
    // refilled channel could have carried, after the de-noising.
    const line =
      `possible demand: ${demand.attempts} refused HTLCs (${demand.sats.toLocaleString("en-US")} sat, ${demand.days} days) in ${DEMAND_WINDOW_DAYS} d ` +
      `a refilled channel could have carried — probes, same-amount retries and HTLCs over half the channel excluded`;
    // First only when it is what kept the fee where it is — it kept the
    // channel from being lowered as idle. A fee that moves all the same moves
    // for its own rule, which leads (a bounded step down the curve; the curve
    // raising a channel below its target ratio — review 3: that read
    // "demand: … not treated as idle"), and a binding floor (protect) stays
    // the dominant reason. A new channel is never idle (its floor leads).
    const keptFromIdle = f30.forwards === 0 && !isNewChan && floored === null;
    if (keptFromIdle && targetPpm === currentPpm) dominant(`${line}; not treated as idle`);
    else reasons.push(keptFromIdle ? `${line}; not treated as idle` : line);
  }

  // The note that set the aim leads — right behind the rules that set the
  // target outright: a move toward the replacement cost reads
  // "replacement: …" (up, or down from above it), a lowering toward a
  // cheaper market "market: …", a draining channel at or above its target
  // ratio raised "draining: …", a move by the balance curve alone says so; a
  // fee that stays, the hold that kept it.
  if (kind === "free" || kind === "raise_step" || kind === "lower_step" || kind === "demand") {
    const dir = Math.sign(targetPpm - currentPpm);
    const pct = Math.round(ch.localRatio * 100);
    const over = ch.localRatio - targetLocalRatio > cfg.deadband;
    const under = targetLocalRatio - ch.localRatio > cfg.deadband;
    const curveLine =
      dir < 0 && over
        ? `balance: high local ratio (${pct}%) — lower fee invites flow`
        : dir > 0 && under
          ? `balance: low local ratio (${pct}%) — higher fee slows the drain`
          : `balance: ${pct}% local (target ${Math.round(targetLocalRatio * 100)}%) — the balance curve puts it at ~${Math.round(base / step) * step} ppm`;
    // A draining channel that isn't below its target ratio goes up because
    // it drains — the curve's level alone raises nothing there — and the
    // lead says so (review 3: it read "balance: 50% local (target 50%) — the
    // balance curve puts it at ~80 ppm", the raise the Fees tab says never
    // happens, with its actual reason unnamed).
    const drained = `draining: ${Math.round(netDrain30d * 100)}% of its capacity net out in 30 d`;
    const drainingLine =
      dir > 0 && draining && !under
        ? replacementCostPpm == null
          ? claim(`${drained} (no market reference for its refill cost) — raised toward ~${aimPpm} ppm`, drained, 1)
          : claim(`${drained} — raised toward ~${aimPpm} ppm (a refill costs ~${replacementCostPpm} ppm${seen})`, drained, 1)
        : null;
    const lead =
      dir > 0
        ? (replacementLine ??
          (velocityMod > 1 ? velocityLine : null) ??
          (benchMod > 1 ? benchLine : null) ??
          drainingLine ??
          (ctx.elasticityMod > 1 ? elasticityLine : null) ??
          curveLine)
        : dir < 0
          ? // (Priced above its refill cost, a draining channel is lowered
            // toward that cost — not toward the curve's level below it.)
            (replacementLine ??
            marketLine ??
            (velocityMod < 1 ? velocityLine : null) ??
            (benchMod < 1 ? benchLine : null) ??
            (ctx.elasticityMod < 1 ? elasticityLine : null) ??
            curveLine)
          : heldLine;
    if (lead) {
      const at = reasons.indexOf(lead);
      if (at >= 0) reasons.splice(at, 1);
      reasons.splice(dominantCount, 0, lead);
    }
  }
  // manual per-channel overrides win over the algorithm
  const engineTargetPpm = targetPpm;
  const { override } = ctx;
  const pinned = override?.mode === "fixed" && override.fixedPpm != null && Number.isFinite(override.fixedPpm);
  if (override?.mode === "exclude") {
    targetPpm = currentPpm;
    aimPpm = currentPpm;
    dominant("excluded (manual) — not managed by the autopilot");
  } else if (pinned) {
    // Exactly as set — outside the policy range, the rounding, the threshold
    // and the pacing (review a1: a pin of 290 on a 300 ppm channel never
    // applied, a pin of 0 became 25, one of 2,000 became the policy max),
    // applied once and then held. Only a lease promise (below) binds it.
    targetPpm = clamp(Math.round(override.fixedPpm as number), 0, 50_000);
    aimPpm = targetPpm;
    dominant(`pinned to ${targetPpm} ppm (manual)`);
  }

  // Base fee: volume-first drops it to cfg.baseFeeMsat (0) to win routes; an
  // excluded channel keeps whatever it has.
  const currentBaseMsat = rate ? Number(rate.base_fee_mtokens) : 0;
  let recommendedBaseMsat = override?.mode === "exclude" ? currentBaseMsat : cfg.baseFeeMsat;
  if (recommendedBaseMsat !== currentBaseMsat) {
    const baseLine =
      recommendedBaseMsat < currentBaseMsat
        ? `base fee: lowering ${currentBaseMsat}→${recommendedBaseMsat} msat to win routes`
        : `base fee: ${currentBaseMsat}→${recommendedBaseMsat} msat — your policy's base fee`;
    // When only the base fee moves, it is what the write is about.
    if (targetPpm === currentPpm) reasons.unshift(baseLine);
    else reasons.push(baseLine);
  }

  // Lease promise (D7) — LAST, after every rule that can raise a fee: the
  // profit floor, the protect ramp, elasticity, a fixed override. A channel
  // this node sold stays within the caps its order locked, for the lease.
  // Lowering is always allowed. An excluded channel is left alone — unless
  // the fee it carries breaks the promise.
  const lease = ctx.leaseCap;
  const leaseCapBreach = !!lease && (currentPpm > lease.feeRateCapPpm || currentBaseMsat > lease.baseFeeCapMsat);
  if (lease && (override?.mode !== "exclude" || leaseCapBreach)) {
    const kept = clampToCap({ feeRatePpm: targetPpm, baseFeeMsat: recommendedBaseMsat }, lease);
    aimPpm = Math.min(aimPpm, lease.feeRateCapPpm);
    if (kept.clamped || leaseCapBreach) {
      targetPpm = kept.feeRatePpm;
      recommendedBaseMsat = kept.baseFeeMsat;
      // (What breaks it, exactly: a base fee alone above the promise read
      // "its fee (150 ppm, 1000 msat base) is above that; lowering at once"
      // while a floor took the rate up.)
      const above =
        currentPpm > lease.feeRateCapPpm && currentBaseMsat > lease.baseFeeCapMsat
          ? `its fee (${currentPpm} ppm, ${currentBaseMsat} msat base) is above that`
          : currentPpm > lease.feeRateCapPpm
            ? `its fee (${currentPpm} ppm) is above that`
            : `its base fee (${currentBaseMsat} msat) is above that`;
      reasons.unshift(
        leaseCapBreach ? `lease promise: ${capText(lease)} — ${above}; lowered at once` : `lease promise: ${capText(lease)} — fee kept at or below it`,
      );
    }
  }

  // A line that denies the final move is taken back — a floor, the range, a
  // pin or a lease promise moved the fee after all: a hold that didn't hold,
  // a no-flow lowering under a fee that goes up.
  if (targetPpm !== currentPpm) {
    dropLine(heldLine);
    dropLine(drainedIdleLine);
  }
  if (targetPpm > currentPpm) dropLine(noFlowLine);
  // What the engine's rules claimed for their move no longer holds when a
  // pin, an exclusion or a lease promise set another one — nor a claimed
  // direction the fee doesn't take: only the facts stay.
  const moved = Math.sign(targetPpm - currentPpm);
  const replaced = targetPpm !== engineTargetPpm;
  for (let i = reasons.length - 1; i >= 0; i--) {
    const c = claims.get(reasons[i]);
    if (!c || !(replaced || (c.dir !== 0 && moved === -c.dir))) continue;
    if (c.fact === null) reasons.splice(i, 1);
    else reasons[i] = c.fact;
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
  if (floored === "protecting_liquidity") state = "protecting_liquidity";
  else if (floored === "recovering_cost") state = "recovering_cost";
  else if (grossFlow30d < 0.005 && peerGate === "weak") state = "close_candidate";
  else if (exploring) state = "exploring_lower_fee";
  if (state === "close_candidate") reasons.push("close candidate: idle with a weak peer — consider closing");

  // §11 apply guards (decide wouldApply only — never the target)
  const blockedByGuards: string[] = [];
  const minDelta = Math.max(cfg.minChangePpm, Math.round(currentPpm * cfg.relativeChangeThreshold));
  const baseFeeChanged = recommendedBaseMsat !== currentBaseMsat;
  const isRaise = targetPpm > currentPpm;
  if (override?.mode === "exclude" && !leaseCapBreach) blockedByGuards.push("excluded (manual)");
  if (!ch.active) blockedByGuards.push("channel inactive");
  // The anti-churn threshold judges the gap to the AIM — a channel close to
  // where it should be is left alone — not the size of one bounded step.
  // A base-fee drop is worth applying even when the ppm gap is tiny; a pin
  // is the operator's explicit value; a broken lease promise is fixed
  // whatever the size of the move. Neither are the no-flow rule's own moves
  // (one ratchet step, or a jump to the price that won flow back or to the
  // market's): they are deliberate, bounded and paced already (a lowering at
  // most once a day), and at the low fees small nodes charge the threshold
  // vetoed them within 25 ppm of their destination — review 2: idle at 70 ppm
  // with a flow-won price of 50, the Why said "dropping to 50 ppm" and
  // nothing was ever applied. Nor is any move from a fee outside the policy
  // range (1,010 ppm against a max of 1,004 sat there, 6 ppm "below
  // threshold").
  const outsideRange = currentPpm < cfg.minPpm || currentPpm > ceiling;
  const designedMove = noFlowLowering || outsideRange;
  if (Math.abs(aimPpm - currentPpm) < minDelta && !baseFeeChanged && !leaseCapBreach && !pinned && !designedMove) {
    blockedByGuards.push("change below threshold");
  }
  // An update LND refused (or that failed) waits before it is tried again —
  // resent every run, each refusal was another failed line in the run history
  // (~48 a day at the default interval). A broken lease promise is retried
  // regardless.
  const retryAfter = ctx.cooldown?.retryAfter?.[ch.id];
  const retryAtMs = retryAfter ? Date.parse(retryAfter) : NaN;
  if (Number.isFinite(retryAtMs) && retryAtMs > ctx.nowMs && !leaseCapBreach) {
    const hours = Math.max(1, Math.ceil((retryAtMs - ctx.nowMs) / 3_600_000));
    blockedByGuards.push(`its last fee update failed — tried again in ~${hours} h`);
  }
  // Asymmetric pacing so the market can respond and outcomes stay measurable:
  // raises wait the LONG raise-cooldown (never thrash a working channel up — the
  // user's generic cooldown is often just hours, which would allow big daily
  // creep), lowers step at most once a day. A channel with no prior change
  // applies immediately either way. A pin applies as soon as it is set.
  if (ctx.cooldown && !leaseCapBreach && !pinned) {
    const last = ctx.cooldown.lastApplied[ch.id];
    if (last) {
      const elapsedH = (ctx.nowMs - new Date(last).getTime()) / 3_600_000;
      // The protect and profit-floor ramps may step at the user's cadence —
      // they are hard-capped (protectPpm, the floor), unlike open-ended
      // raises, which wait the long pause. Only while a ramp sets the move.
      // The demand ramp steps every DEMAND_RAMP_HOURS at most (or the user's
      // cadence, if longer): the evidence it acts on — a sale at the price
      // just set, off a drained channel — is there now, not in three days.
      // Up to a floor whose own ramp lifts the fee this move, it keeps that
      // ramp's cadence (the operator's, when shorter: review — a 1 h cadence
      // took 3 h to protectPpm before, 12 h with the ramp in the way).
      const limitH = isRaise
        ? kind === "ramp"
          ? ctx.cooldown.cooldownHours
          : kind === "demand"
            ? targetPpm <= floorRampTo
              ? ctx.cooldown.cooldownHours
              : Math.max(ctx.cooldown.cooldownHours, DEMAND_RAMP_HOURS)
            : Math.max(ctx.cooldown.cooldownHours, cfg.cooldownHours)
        : LOWER_PACING_HOURS;
      if (elapsedH < limitH) blockedByGuards.push(isRaise ? "raise cooldown active" : "lower pacing (1/day)");
    }
  }
  // Nothing to write when neither the rate nor the base fee moves.
  const wouldApply = blockedByGuards.length === 0 && (targetPpm !== currentPpm || baseFeeChanged);

  const marketComparison: FeeRecMetrics["marketComparison"] =
    marketPpm == null ? null : currentPpm > marketPpm * 1.5 ? "above" : currentPpm < marketPpm * 0.5 ? "below" : "in_line";

  return {
    channelId: ch.id,
    alias: ch.peerAlias || ch.id,
    capacity: ch.capacity,
    currentPpm,
    targetPpm,
    aimPpm,
    transactionId: rate?.transaction_id ?? null,
    transactionVout: rate?.transaction_vout ?? null,
    currentBaseMsat,
    recommendedBaseMsat,
    // Only a lowering opens the flow-won episode — not a fee a pin took up.
    noFlowLowering: noFlowLowering && targetPpm < currentPpm,
    pinned,
    leaseCap: lease
      ? { source: lease.source, orderId: lease.orderId, feeRateCapPpm: lease.feeRateCapPpm, baseFeeCapMsat: lease.baseFeeCapMsat, untilHeight: lease.untilHeight }
      : null,
    leaseCapBreach,
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
      costBasisRefills: refill?.lots.length ?? 0,
      costBasisLatestAt: refill ? refill.lots[refill.lots.length - 1].at : null,
      refillRemainingSats: refill?.remainingSats ?? 0,
      refillHoldPpm: refill && refill.held && !floorReleased ? refill.binding.holdPpm : null,
      profitFloorReleased: floorReleased,
      profitFloorPpm,
      profitFloorCapped,
      peerGate,
      role: ch.role,
      isTopEarner,
      benchmarkComparison,
      marketPpm,
      marketSamples: market?.samples ?? 0,
      marketSeenAt: market && ctx.marketSeenAt != null ? new Date(ctx.marketSeenAt).toISOString() : null,
      peerFeeToUsPpm: market?.peerFeeToUsPpm ?? null,
      replacementCostPpm,
      soldSinceChange: { forwards: sold?.forwards ?? 0, out: sold?.out ?? 0, revenue: sold?.revenue ?? 0 },
      belowReplacement,
      marketComparison,
      draining,
      refusedAttempts14d: demand?.attempts ?? 0,
      refusedSats14d: demand?.sats ?? 0,
      refusedDays14d: demand?.days ?? 0,
      inDemand,
      elasticityMod: ctx.elasticityMod,
    },
  };
}
