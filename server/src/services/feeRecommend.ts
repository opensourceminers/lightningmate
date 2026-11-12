import { getFeeRates, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { getChannelsView, type ChannelRole, type ChannelView } from "./channels.js";
import { buildForwardsReport, readForwardEvents, type ForwardEvent } from "./forwards.js";
import type { RebalanceRecord } from "./rebalanceLog.js";
import type { FeeChangeRecord } from "./feeChangeLog.js";
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
  // (Not a setting. A new channel keeps its protected fee, and is not lowered
  // as idle, for two weeks or until its third forward — review FEE-7: with
  // three days a channel that had no time to be found was at Min ppm on day
  // four.)
  newChannelProtectionDays: 14,
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
/** "Not refilled faster than it sells" tolerates this much more in than out
 *  over 14 days: max(this share of capacity, REFILL_INFLOW_TOLERANCE_SATS)
 *  — a 2-sat inflow switched a drained channel's demand off (review). */
export const REFILL_INFLOW_TOLERANCE_SHARE = 0.01;
export const REFILL_INFLOW_TOLERANCE_SATS = 50_000;
/** The drain ramp (review FEE-3): a channel that still has liquidity but, at
 *  what it sells net a day AT THE FEE IT CHARGES NOW, is down to the demand
 *  ramp's "drained" (DEMAND_RAMP_LOCAL) within this many days… */
export const DRAIN_RAMP_WITHIN_DAYS = 21;
/** …is priced for the balance it will have this many days from now at that
 *  rate (the balance curve read that far ahead), and raised toward it like
 *  the demand ramp: a quarter of the fee per move, every DEMAND_RAMP_HOURS. */
export const DRAIN_RAMP_AHEAD_DAYS = 7;
/** A stretch of time counts toward that rate with DRAIN_MIN_FORWARDS sales
 *  and this share of the channel's capacity net out in it. */
export const DRAIN_RAMP_NET_SHARE = 0.05;
/** Toward a KNOWN refill cost one move covers this share of the way, where
 *  that is more than the quarter of the fee — and never more than the fee
 *  itself: a move at most doubles it. */
export const DRAIN_RAMP_GAP_SHARE = 1 / 3;
/** The step-back: a fee raised to a price nothing sold at for this long —
 *  counted from the raise, or from when the channel last got sats to sell
 *  if that is later — with at least STEP_BACK_MIN_SELLABLE (or 1 % of
 *  capacity, if more) it could have sold, goes back to the higher of the
 *  last price that sold and the fee before the raise. */
export const STEP_BACK_AFTER_HOURS = 48;
export const STEP_BACK_MIN_SELLABLE = 50_000;
/** LND's default channel reserve: what of a channel's local balance can't
 *  be sold. */
export const CHANNEL_RESERVE_SHARE = 0.01;
/** What of a channel's local balance it can sell: what is above LND's
 *  reserve. */
export const sellableSats = (capacity: number, localRatio: number): number => {
  const cap = Math.max(1, capacity);
  return Math.max(0, Math.round(localRatio * cap - CHANNEL_RESERVE_SHARE * cap));
};
/** The least a channel must have to sell for the step-back's hours to run:
 *  STEP_BACK_MIN_SELLABLE, or 1 % of its capacity if more. */
export const stepBackSellableMin = (capacity: number): number => Math.max(STEP_BACK_MIN_SELLABLE, CHANNEL_RESERVE_SHARE * Math.max(1, capacity));
/** After a step-back, the fee it stepped back from is not raised to again
 *  for this long — the first time. */
export const STEP_BACK_MEMORY_DAYS = 7;
/** A step-back that ends no higher than the one before it is a repeat: the
 *  memory doubles with each, up to this many (7, 14, 28 days). Review FEE-11:
 *  a channel cycled 140 → 160 → 140 every nine days for months — each raise
 *  two days without a sale — because the memory was the same seven days
 *  however often the same price had failed. */
export const STEP_BACK_MAX_REPEATS = 3;
export const stepBackMemoryDays = (count: number | undefined): number =>
  STEP_BACK_MEMORY_DAYS * 2 ** (Math.min(STEP_BACK_MAX_REPEATS, Math.max(1, Math.floor(count ?? 1))) - 1);
/** How long a step-back's record is kept: long enough for the next one to be
 *  told a repeat after the longest memory has run out. */
export const STEP_BACK_KEEP_DAYS = 56;
/** One channel's last step-back: the fee it left, the fee it went back to
 *  (absent on records written before it was kept), when, and how many times
 *  in a row a step-back ended at or below the same fee. */
export interface StepBackRecord {
  fromPpm: number;
  at: string;
  toPpm?: number;
  count?: number;
}
/** The highest fee a step-back's memory lets a raise reach from `currentPpm`
 *  (review FEE-11): the grid price below the fee that failed — or, while the
 *  fee stands in the lower half between the price it went back to and that
 *  one, the middle: each failed try halves the stretch that is tried again. */
function memoryCapOf(rec: StepBackRecord, currentPpm: number, step: number): number {
  const below = Math.ceil(rec.fromPpm / step) * step - step;
  const mid = rec.toPpm !== undefined ? Math.floor((rec.toPpm + rec.fromPpm) / 2 / step) * step : below;
  return Math.max(currentPpm, currentPpm < mid ? Math.min(mid, below) : below);
}
/** A fee that sells is not lowered (review FEE-2): this many sales at it
 *  since it was set, one of them in the last 7 days — or this many in the
 *  last 7 days while the fee stood at this one or higher: a write does not
 *  undo what the channel has shown (the package's own review, R1). */
export const SELLS_HERE_SALES = DEMAND_RAMP_SALES;
/** …unless the channel holds more than its target and either takes in more
 *  than it sells, or at what it sells a day would need longer than this to
 *  sell what it holds over its target: a lower fee is then worth a try. */
export const SPARE_SELL_DAYS = 90;
/** A fee the autopilot raised to is not lowered by the balance curve for this
 *  long: what sells at it decides (the step-back takes it back). */
export const RAISE_TRIAL_DAYS = 7;
/** The upward probe: a channel that sells daily at its fee (this many sales
 *  in the last week, PROBE_RECENT_SALES of them in the last
 *  PROBE_JUDGE_AFTER_HOURS, which the fee has stood) and holds no more than
 *  its target tries a fee this share higher (at least one grid step), at the
 *  ordinary raise's pace. */
export const PROBE_WEEK_SALES = 7;
export const PROBE_RECENT_SALES = 6;
export const PROBE_SHARE = 0.1;
/** A probe that still sells is judged once, on two stretches of this many
 *  hours: what the channel earned in the probe's first hours against the
 *  same hours before it, at the fee before. Less, and it goes back; as much
 *  or more, and it stays. Both stretches are fixed when the hours are over —
 *  a sale an hour later changes nothing (judged on a running average, a
 *  probe was taken back on "7.5 sat a day against 8.0", five sales where the
 *  sixth came an hour later, and kept or taken back by the hour it was looked
 *  at). */
export const PROBE_JUDGE_AFTER_HOURS = 72;
/** One step of a tenth cannot be told from chance on a few sales (at twelve
 *  sales in 72 hours the spread of what they earn is three times the step),
 *  so kept probes are checked again as a climb: every CLIMB_CHECK_DAYS days
 *  since its first probe, what the channel earned in the last days — up to
 *  CLIMB_WINDOW_DAYS — is set against as many days before the climb began.
 *  Less, and the fee goes back to where the climb began, in one move. A
 *  week's check is in force for CLIMB_CHECK_HOURS after the week ended (a
 *  lowering waits a day after the last change) and is made on stretches that
 *  stay on record whole for as long: what it says does not change with the
 *  hour it is read in. */
export const CLIMB_CHECK_DAYS = 7;
export const CLIMB_WINDOW_DAYS = 14;
export const CLIMB_CHECK_HOURS = 48;
/** Elasticity may widen a raise step by at most this factor. */
const MAX_ELASTIC_STEP = 1.5;
/** The profit floor comes from the autopilot's own refills of this window. */
export const FLOOR_WINDOW_DAYS = 30;
/** Where the refills the profit floor can stand on start (ms). */
export const floorWindowStart = (nowMs = Date.now()): number => nowMs - FLOOR_WINDOW_DAYS * 86_400_000;
/** A channel younger than this is never a close candidate: it hasn't had
 *  the 30 days its flow is judged over (the close list protects it too). */
export const CLOSE_CANDIDATE_MIN_DAYS = 30;
/** De-noised refusals (D20) that make a channel "in demand": at least this
 *  many distinct attempts, on at least this many days, in the window. */
export const DEMAND_MIN_ATTEMPTS = 3;
export const DEMAND_MIN_DAYS = 2;
/** …and at least this much refused in all (sat): a channel at its reserve
 *  that advertised a tiny max_htlc drew 14 refused HTLCs of 1,694 sat in all,
 *  which kept it "in demand" and raising (review 2026-10-25) — the smallest
 *  refill is 50k. */
export const DEMAND_MIN_SATS = 50_000;
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
  /** The highest fee level it sold PROVEN_LEVEL_SALES times at within
   *  PROVEN_WINDOW_DAYS (null: none, or no forwarding history read) — what
   *  the refill gate values a refill at, whatever the fee did since. */
  provenLevel: ProvenLevel | null;
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
  /** This move is a step-back (the autopilot remembers the fee it stepped
   *  back from: not raised to again for STEP_BACK_MEMORY_DAYS). */
  stepBack?: boolean;
  /** …and what it takes back is a probe: remembered apart (`probeBacks`). */
  probeBack?: boolean;
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
/** An idle channel at its target is lowered below the balanced level one
 *  grid step at a time, this far apart (review FEE-7: at the ratchet's pace
 *  it reached Min ppm in days and the first buyer took half of it there). */
export const SLOW_LOWER_PACING_HOURS = 7 * 24;
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

/** A forward that counts as a SALE — the evidence a raise, the demand ramp
 *  and the refill gate's proof act on (2026-10-25 review): at least
 *  SALE_MIN_SATS out, and forwards out of the channel within SALE_BURST_MS
 *  of the one before count once — one sender's burst of eleven 6–3,200-sat
 *  forwards in a minute is one buyer, not eleven, and one payment's shards
 *  entering through three channels one sale, not three (final review: the
 *  burst was counted per incoming → outgoing pair). */
export const SALE_MIN_SATS = 1_000;
export const SALE_BURST_MS = 60_000;

/** What `channelId` sold in [fromMs, toMs): sales out (SALE_MIN_SATS and
 *  bursts once — `forwards` counts sales, `out` and `revenue` are their sats
 *  and fees), and everything that came in. */
export function salesOf(events: readonly ForwardEvent[], channelId: string, fromMs: number, toMs = Infinity): Flow {
  const flow: Flow = { out: 0, inn: 0, revenue: 0, forwards: 0 };
  let revenueMsat = 0;
  let last: number | undefined;
  const inWindow = events
    .map((e) => ({ e, t: Date.parse(e.createdAt) }))
    .filter(({ t }) => t > fromMs && t < toMs)
    .sort((a, b) => a.t - b.t);
  for (const { e, t } of inWindow) {
    if (e.incomingChannel === channelId) flow.inn += e.tokens;
    if (e.outgoingChannel !== channelId || e.tokens < SALE_MIN_SATS) continue;
    flow.out += e.tokens;
    revenueMsat += e.feeMsat;
    if (last === undefined || t - last > SALE_BURST_MS) flow.forwards += 1;
    last = t;
  }
  flow.revenue = revenueMsat / 1000;
  return flow;
}

/** When `channelId` last sold in (fromMs, toMs) — -Infinity: never. */
function lastSaleMs(events: readonly ForwardEvent[], channelId: string, fromMs: number, toMs: number): number {
  let last = -Infinity;
  for (const e of events) {
    if (e.outgoingChannel !== channelId || e.tokens < SALE_MIN_SATS) continue;
    const t = Date.parse(e.createdAt);
    if (t > fromMs && t < toMs && t > last) last = t;
  }
  return last;
}

/** What `channelId` sold after `sinceMs` (its fee's last change) — at the
 *  fee it charges now. */
export function soldSince(events: readonly ForwardEvent[], channelId: string, sinceMs: number): Flow {
  return salesOf(events, channelId, sinceMs);
}

/** Sales at one fee level that make it a proven price (and the demand
 *  ramp's evidence at the current one). */
export const PROVEN_LEVEL_SALES = DEMAND_RAMP_SALES;
/** How far back a proven level counts. */
export const PROVEN_WINDOW_DAYS = 14;
/** A proven level values a refill above what the channel earned in 30 days
 *  only while its last sale is at most this old: a week-old proof says
 *  little about what sells now (final review 2026-10-25). */
export const PROVEN_RECENT_DAYS = 7;

/** The highest fee level a channel sold PROVEN_LEVEL_SALES times at within
 *  PROVEN_WINDOW_DAYS (what the refill gate values a refill at). */
export interface ProvenLevel {
  /** The fee the channel charged (ppm). */
  ppm: number;
  /** What those sales paid, all in (ppm of their sats). */
  paidPpm: number;
  sales: number;
  out: number;
  revenue: number;
  /** When the level began and ended (null: it is the current fee). */
  from: string;
  to: string | null;
  /** Its last sale, and how many days before the level was read. */
  lastSaleAt: string;
  lastSaleDaysAgo: number;
}

/**
 * The fee levels of the last PROVEN_WINDOW_DAYS from the fee-change log (each
 * change's new fee, from its time to the next; before the first in the
 * window, the fee that change replaced) and what sold at each: the highest
 * level with PROVEN_LEVEL_SALES sales (review 2026-10-25: every raise reset
 * "sold since the fee was set", so the refill gate never saw the proof a
 * ramp level had just made — the same run's ramp had moved on).
 */
export function provenLevel(
  events: readonly ForwardEvent[],
  channelId: string,
  history: readonly Pick<FeeChangeRecord, "at" | "fromPpm" | "toPpm">[],
  currentPpm: number,
  nowMs: number,
): ProvenLevel | null {
  const start = nowMs - PROVEN_WINDOW_DAYS * DAY_MS;
  const changes = history
    .map((h) => ({ ...h, t: Date.parse(h.at) }))
    .filter((h) => Number.isFinite(h.t) && h.t <= nowMs)
    .sort((a, b) => a.t - b.t);
  const before = [...changes].reverse().find((h) => h.t <= start);
  const inside = changes.filter((h) => h.t > start);
  const levels: { ppm: number; from: number; to: number | null }[] = [];
  // (A change whose "from" wasn't known — null — is not guessed at: what
  // sold before it counts at no level.)
  let fee: number | null = before ? before.toPpm : inside.length ? inside[0].fromPpm : currentPpm;
  let from = start;
  for (const h of inside) {
    if (fee !== null) levels.push({ ppm: fee, from, to: h.t });
    fee = h.toPpm;
    from = h.t;
  }
  if (fee !== null) levels.push({ ppm: fee, from, to: null });
  let best: ProvenLevel | null = null;
  for (const l of levels) {
    const sold = salesOf(events, channelId, l.from, l.to ?? Infinity);
    if (sold.forwards < PROVEN_LEVEL_SALES || sold.out <= 0) continue;
    if (best && best.ppm >= l.ppm) continue;
    const lastMs = lastSaleMs(events, channelId, l.from, l.to ?? Infinity);
    best = {
      ppm: l.ppm,
      paidPpm: Math.round((sold.revenue / sold.out) * 1_000_000),
      sales: sold.forwards,
      out: sold.out,
      revenue: sold.revenue,
      from: new Date(l.from).toISOString(),
      to: l.to === null ? null : new Date(l.to).toISOString(),
      lastSaleAt: new Date(lastMs).toISOString(),
      lastSaleDaysAgo: Math.round(((nowMs - lastMs) / DAY_MS) * 10) / 10,
    };
  }
  return best;
}

/** A fee change someone made by hand or a pin applied: never the autopilot's
 *  own trial of a higher price. */
const madeByHand = (h: Pick<FeeChangeRecord, "via" | "why" | "pinned">): boolean =>
  h.via === "manual" || h.pinned === true || /^pinned to /.test(h.why ?? "");

/** The autopilot's climb to the current fee: its consecutive raises, each
 *  starting where the one before ended. */
export interface RaiseChain {
  /** The fee before the first of these raises. */
  basePpm: number;
  /** The highest fee of the climb below the current one that sold at least
   *  once while it stood — null: none of them did. */
  soldPpm: number | null;
  /** How many raises the climb has. */
  steps: number;
  startedAt: string;
}

type ChangeRow = Pick<FeeChangeRecord, "at" | "fromPpm" | "toPpm" | "via" | "why" | "pinned">;
const sortedChanges = (history: readonly ChangeRow[], nowMs: number): (ChangeRow & { t: number })[] =>
  history
    .map((h) => ({ ...h, t: Date.parse(h.at) }))
    .filter((h) => Number.isFinite(h.t) && h.t <= nowMs)
    .sort((a, b) => a.t - b.t);

/**
 * The run of raises that ended at the current fee, from the fee-change log,
 * and what sold on the way (review FEE-1: a ramp climbed 80 → 350 ppm in 42
 * hours past buyers who paid up to 150; the step-back knew only the last
 * change, went back one step to 340 and stayed there for months). A raise by
 * hand, a pin or a lease promise is not part of a climb, nor is one older
 * than the forwards read (`fromMs`): what sold before it isn't known.
 */
export function raiseChainOf(
  events: readonly ForwardEvent[],
  channelId: string,
  history: readonly ChangeRow[],
  currentPpm: number,
  fromMs: number,
  nowMs: number,
): RaiseChain | null {
  const changes = sortedChanges(history, nowMs);
  const chain: (ChangeRow & { t: number })[] = [];
  for (let i = changes.length - 1; i >= 0; i--) {
    const h = changes[i];
    const next = chain[0];
    const raise = !madeByHand(h) && h.via !== "lease" && h.fromPpm !== null && h.fromPpm > 0 && h.toPpm > h.fromPpm && h.t > fromMs;
    if (!raise || h.toPpm !== (next ? next.fromPpm : currentPpm)) break;
    chain.unshift(h);
  }
  if (!chain.length) return null;
  let soldPpm: number | null = null;
  for (let k = chain.length - 2; k >= 0; k--) {
    if (salesOf(events, channelId, chain[k].t, chain[k + 1].t).forwards >= 1) {
      soldPpm = chain[k].toPpm;
      break;
    }
  }
  return { basePpm: chain[0].fromPpm as number, soldPpm, steps: chain.length, startedAt: chain[0].at };
}

/** The fees a channel charged in (fromMs, nowMs], from the fee-change log:
 *  each change's new fee from its time to the next; before the first change
 *  in the stretch, the fee that change replaced. Null where the log doesn't
 *  say — a change whose "from" wasn't known, or a last change that did not
 *  end at the fee the channel charges now (set outside the app since). */
function feeLevels(history: readonly ChangeRow[], currentPpm: number, fromMs: number, nowMs: number): { ppm: number | null; from: number; to: number }[] {
  const changes = sortedChanges(history, nowMs);
  const before = [...changes].reverse().find((h) => h.t <= fromMs);
  const inside = changes.filter((h) => h.t > fromMs);
  const levels: { ppm: number | null; from: number; to: number }[] = [];
  let fee: number | null = before ? before.toPpm : inside.length ? inside[0].fromPpm : currentPpm;
  let from = fromMs;
  for (const h of inside) {
    levels.push({ ppm: fee, from, to: h.t });
    fee = h.toPpm;
    from = h.t;
  }
  levels.push({ ppm: fee === currentPpm ? fee : null, from, to: nowMs });
  return levels;
}

/** A channel's sales and inflow over part of a stretch, and how long that
 *  part was (ms). */
export type FlowOver = Flow & { ms: number };

/**
 * What `channelId` sold and took in after `fromMs` while its fee passed
 * `keep` — and for how long that was. The hold reads it two ways (the
 * package's own review, R1 and R3): the sales of the last 7 days at the
 * present fee or a higher one (a write starts "sold since it was set" at none
 * again; what buyers paid before it is still known), and what came in against
 * what went out over the days at the present fee or a lower one (the days of
 * a higher fee — a price test — say nothing about whether this fee lets the
 * channel fill up).
 */
export function flowAtFees(
  events: readonly ForwardEvent[],
  channelId: string,
  history: readonly ChangeRow[],
  currentPpm: number,
  fromMs: number,
  nowMs: number,
  keep: (ppm: number) => boolean,
): FlowOver {
  const sum: FlowOver = { out: 0, inn: 0, revenue: 0, forwards: 0, ms: 0 };
  for (const l of feeLevels(history, currentPpm, fromMs, nowMs)) {
    if (l.ppm === null || !keep(l.ppm)) continue;
    const f = salesOf(events, channelId, l.from, l.to);
    sum.out += f.out;
    sum.inn += f.inn;
    sum.revenue += f.revenue;
    sum.forwards += f.forwards;
    sum.ms += l.to - l.from;
  }
  return sum;
}

/** A raise the autopilot made as a price test, and a step-back it made: the
 *  two moves a climb of price tests consists of (told by the reason the
 *  change was logged with). */
const isPriceTest = (h: ChangeRow): boolean =>
  !madeByHand(h) && h.via !== "lease" && h.fromPpm !== null && h.fromPpm > 0 && h.toPpm > h.fromPpm && /^price test: /.test(h.why ?? "");
const isStepBack = (h: ChangeRow): boolean => !madeByHand(h) && h.fromPpm !== null && h.toPpm < h.fromPpm && /^step back: /.test(h.why ?? "");

/** The price test that set the current fee, and the two stretches it is
 *  judged on: what the channel sold in the PROBE_JUDGE_AFTER_HOURS before it,
 *  at the fee before, and in its first PROBE_JUDGE_AFTER_HOURS. */
export interface PriceTest {
  fromPpm: number;
  at: string;
  before: Flow;
  first: Flow;
}

/** Null: the last change is no price test, or the stretch before it is not
 *  on record whole — the fee before stood for less, or the forwards read
 *  (`fromMs`) starts later. Such a test is not judged on what it earned. */
export function priceTestOf(
  events: readonly ForwardEvent[],
  channelId: string,
  history: readonly ChangeRow[],
  currentPpm: number,
  fromMs: number,
  nowMs: number,
): PriceTest | null {
  const changes = sortedChanges(history, nowMs);
  const last = changes[changes.length - 1];
  if (!last || !isPriceTest(last) || last.toPpm !== currentPpm) return null;
  const span = PROBE_JUDGE_AFTER_HOURS * 3_600_000;
  const prev = changes[changes.length - 2];
  if (last.t - Math.max(fromMs, prev ? prev.t : fromMs) < span) return null;
  return {
    fromPpm: last.fromPpm as number,
    at: last.at,
    before: salesOf(events, channelId, last.t - span, last.t),
    first: salesOf(events, channelId, last.t, last.t + span),
  };
}

/** A climb of price tests: where it began, and its latest weekly check. */
export interface ClimbAnchor {
  /** The fee the climb began at. */
  ppm: number;
  /** When its first price test raised the fee. */
  startedAt: string;
  /** The price tests since, kept or taken back. */
  tests: number;
  /** The check at the climb's latest full week: what the channel sold in the
   *  `hours` it is judged on, of the `window` hours before that week ended
   *  (from `from`, ms), and in the `hours` before the climb began. Left out
   *  of the window: a price test that was taken back since, and one not yet
   *  judged when the week ended — the days nothing sold at a fee above what
   *  buyers pay are not what the fee below it earns (a climb from 300 to the
   *  330 ppm buyers paid was taken back whole for the two dead days of the
   *  try at 360). Null: no full week yet, or less than
   *  PROBE_JUDGE_AFTER_HOURS of either stretch are on record. */
  week: { n: number; hours: number; window: number; from: number; now: Flow; before: Flow } | null;
}

/**
 * The climb the current fee belongs to (the package's own review, R2): the
 * changes that ended at it, back in time for as long as they are price tests
 * and step-backs, each starting where the one before ended — and of those the
 * earliest price test since which the fee has stayed above the fee it began
 * at, with PROBE_JUDGE_AFTER_HOURS on record before it at that fee. That fee
 * is what the climb is checked against, every CLIMB_CHECK_DAYS days, on two
 * stretches of the same length: the last days before the week ended (as many
 * as the climb is old, CLIMB_WINDOW_DAYS at most, and no more than are on
 * record before the climb) against as many days before the climb began. The
 * check of a week is fixed when the week ends and in force for
 * CLIMB_CHECK_HOURS: its stretches are cut to what the forwards read still
 * holds at the end of those hours, so that every run in them reads the same
 * sales. (With a read of 30 days: 7 days after the first week, 14 after the
 * second, 7 after the third, and none after that — the climb's next price
 * test is then what it is checked from.)
 */
export function climbAnchorOf(
  events: readonly ForwardEvent[],
  channelId: string,
  history: readonly ChangeRow[],
  currentPpm: number,
  fromMs: number,
  nowMs: number,
): ClimbAnchor | null {
  const changes = sortedChanges(history, nowMs);
  const span = PROBE_JUDGE_AFTER_HOURS * 3_600_000;
  /** How long the fee before change `i` is on record. */
  const stoodBefore = (i: number): number => changes[i].t - Math.max(fromMs, i > 0 ? changes[i - 1].t : fromMs);
  let at = -1;
  let tests = 0;
  let walked = 0;
  // The lowest fee since the change looked at.
  let low = currentPpm;
  for (let i = changes.length - 1; i >= 0; i--) {
    const h = changes[i];
    const next = changes[i + 1];
    if ((!isPriceTest(h) && !isStepBack(h)) || h.toPpm !== (next ? next.fromPpm : currentPpm) || h.t <= fromMs) break;
    low = Math.min(low, h.toPpm);
    if (!isPriceTest(h)) continue;
    walked += 1;
    if (low > (h.fromPpm as number) && stoodBefore(i) >= span) {
      at = i;
      tests = walked;
    }
  }
  if (at < 0) return null;
  const first = changes[at];
  const week = CLIMB_CHECK_DAYS * DAY_MS;
  const n = Math.floor((nowMs - first.t) / week);
  const mark = first.t + n * week;
  const inForce = CLIMB_CHECK_HOURS * 3_600_000;
  // What is on record before the climb, at its fee, when the check's hours end.
  const readFrom = mark + inForce - (nowMs - fromMs);
  const onRecord = first.t - Math.max(readFrom, at > 0 ? changes[at - 1].t : readFrom);
  const window = Math.floor(Math.min(CLIMB_WINDOW_DAYS * DAY_MS, n * week, onRecord) / 3_600_000);
  const from = mark - window * 3_600_000;
  // The climb's fees in those hours, each from its change to the next —
  // without a price test taken back since or not yet judged at the week's end.
  const now: Flow = { out: 0, inn: 0, revenue: 0, forwards: 0 };
  let revenueMsat = 0;
  let keptMs = 0;
  for (let i = at; i < changes.length; i++) {
    const h = changes[i];
    const next = changes[i + 1];
    const a = Math.max(h.t, from);
    const b = Math.min(next ? next.t : mark, mark);
    if (b <= a) continue;
    if (isPriceTest(h) && ((next && isStepBack(next)) || mark - h.t < span)) continue;
    const f = salesOf(events, channelId, a, b);
    now.out += f.out;
    now.inn += f.inn;
    now.forwards += f.forwards;
    revenueMsat += Math.round(f.revenue * 1000);
    keptMs += b - a;
  }
  now.revenue = revenueMsat / 1000;
  const hours = Math.floor(keptMs / 3_600_000);
  return {
    ppm: first.fromPpm as number,
    startedAt: first.at,
    tests,
    week:
      n >= 1 && nowMs - mark <= inForce && hours >= PROBE_JUDGE_AFTER_HOURS
        ? { n, hours, window, from, now, before: salesOf(events, channelId, first.t - keptMs, first.t) }
        : null,
  };
}

/** What a channel sold in its last 1, 3, 7 and 14 days, whatever fee it had. */
export interface RecentSales {
  d1: Flow;
  d3: Flow;
  d7: Flow;
  d14: Flow;
}
export const recentSales = (events: readonly ForwardEvent[], channelId: string, nowMs: number): RecentSales => ({
  d1: salesOf(events, channelId, nowMs - DAY_MS),
  d3: salesOf(events, channelId, nowMs - 3 * DAY_MS),
  d7: salesOf(events, channelId, nowMs - 7 * DAY_MS),
  d14: salesOf(events, channelId, nowMs - 14 * DAY_MS),
});

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
  /** Since when each channel has had sats to sell without a break
   *  (stepBackSellableMin; no entry: it hasn't now) — the step-back's hours
   *  count from it too. Absent: not kept, the hours count from the raise. */
  sellableSince?: Record<string, string>;
  /** Each channel's last step-back: the fee it stepped back from, and when
   *  — not raised to again for STEP_BACK_MEMORY_DAYS. */
  stepBacks?: Record<string, StepBackRecord>;
  /** Each channel's last probe that was taken back: no probe to that fee
   *  again for as long (the same record and growing memory as a step-back).
   *  Kept apart from `stepBacks`: a probe is a guess, and its failure does
   *  not bound a raise a rule has evidence for. */
  probeBacks?: Record<string, StepBackRecord>;
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
  /** The fee changes LightningMate made (FeeChangeLog.all()): each channel's
   *  fee levels, for its proven price and its last raise. */
  feeHistory: readonly FeeChangeRecord[] = [],
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
    feeHistory,
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
  /** The fee changes LightningMate made (FeeChangeLog.all()) — each
   *  channel's fee levels, for its proven price and its last raise. */
  feeHistory?: readonly FeeChangeRecord[];
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
  // The forwarding history is read once, for the longest window, and every
  // figure comes from it (it was read three times a run).
  const readDays = Math.max(cfg.flowWindowDays, cfg.benchmarkWindowDays, PROVEN_WINDOW_DAYS);
  const [channels, rates, wallet, history] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
    getWalletInfo({ lnd }),
    readForwardEvents(lnd, readDays),
  ]);
  const readAt = Date.now();
  const within = (days: number) => history.events.filter((e) => Date.parse(e.createdAt) >= readAt - days * DAY_MS);
  const report = (days: number) => buildForwardsReport(within(days), channels, days, { nowMs: readAt, tzOffsetMin: 0, complete: history.complete });
  const fw14 = report(cfg.flowWindowDays);
  const fw30 = report(cfg.benchmarkWindowDays);
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
  // A read cut short misses the newest forwards (LND pages oldest first):
  // what sold is then unknown — never read as "nothing sold".
  const salesKnown = history.complete;
  // (A write that left the rate as it was — the base fee alone — is no change
  // of price: it is not the change that set the fee, nor a step of a raise
  // chain; the cooldown is not stamped for it either. Review FEE-12.)
  const changesOf = new Map<string, FeeChangeRecord[]>();
  for (const r of inputs.feeHistory ?? []) {
    if (r.fromPpm !== null && r.fromPpm === r.toPpm) continue;
    changesOf.set(r.channelId, [...(changesOf.get(r.channelId) ?? []), r]);
  }
  const lastChangeOf = (id: string): BuildCtx["lastChange"] => {
    const last = [...(changesOf.get(id) ?? [])].sort((a, b) => b.at.localeCompare(a.at))[0];
    return last
      ? { at: last.at, fromPpm: last.fromPpm, toPpm: last.toPpm, via: last.via, ...(last.why ? { why: last.why } : {}), ...(last.pinned ? { pinned: true } : {}) }
      : undefined;
  };
  // Each channel's own forwards, in and out (what sold is read a dozen ways
  // per channel below: over its own events, not the node's every time).
  const eventsOf = new Map<string, ForwardEvent[]>();
  for (const e of history.events) {
    for (const id of e.incomingChannel === e.outgoingChannel ? [e.outgoingChannel] : [e.incomingChannel, e.outgoingChannel]) {
      const list = eventsOf.get(id);
      if (list) list.push(e);
      else eventsOf.set(id, [e]);
    }
  }
  /** What was sold at which fee, from the forwards and the fee-change log. */
  const salesContext = (id: string): Partial<BuildCtx> => {
    const events = eventsOf.get(id) ?? [];
    const changes = changesOf.get(id) ?? [];
    const fee = rateById.get(id)?.fee_rate ?? 0;
    const readFrom = nowMs - readDays * DAY_MS;
    return {
      soldSinceChange: soldSince(events, id, changedAt(id)),
      provenLevel: provenLevel(events, id, changes, fee, nowMs),
      raiseChain: raiseChainOf(events, id, changes, fee, readFrom, nowMs),
      priceTest: priceTestOf(events, id, changes, fee, readFrom, nowMs),
      climbAnchor: climbAnchorOf(events, id, changes, fee, readFrom, nowMs),
      recent: recentSales(events, id, nowMs),
      soldAtOrAbove7d: flowAtFees(events, id, changes, fee, nowMs - 7 * DAY_MS, nowMs, (ppm) => ppm >= fee),
      atOrBelow: {
        d7: flowAtFees(events, id, changes, fee, nowMs - 7 * DAY_MS, nowMs, (ppm) => ppm <= fee),
        d14: flowAtFees(events, id, changes, fee, nowMs - 14 * DAY_MS, nowMs, (ppm) => ppm <= fee),
      },
    };
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
        ...(salesKnown ? salesContext(ch.id) : {}),
        lastChange: lastChangeOf(ch.id),
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
  /** Its highest proven fee level (provenLevel) — absent: none known. */
  provenLevel?: ProvenLevel | null;
  /** The run of autopilot raises that ended at the current fee, and the
   *  highest fee of it that sold (raiseChainOf) — absent: not built (the
   *  step-back then knows only the last change). */
  raiseChain?: RaiseChain | null;
  /** The price test that set the current fee, with the two stretches it is
   *  judged on (priceTestOf) — null or absent: none, or not to be judged. */
  priceTest?: PriceTest | null;
  /** The climb of price tests the current fee belongs to, and its latest
   *  weekly check (climbAnchorOf). */
  climbAnchor?: ClimbAnchor | null;
  /** What the channel sold in the last 1, 3, 7 and 14 days, whatever its fee
   *  was (recentSales) — absent: not known. */
  recent?: RecentSales;
  /** What it sold in the last 7 days while its fee stood at the present one
   *  or higher (flowAtFees) — absent: not known. */
  soldAtOrAbove7d?: FlowOver;
  /** What it sold and took in over the part of the last 7 and 14 days in
   *  which its fee stood at the present one or lower (flowAtFees) — absent:
   *  not built, the days count whole. */
  atOrBelow?: { d7: FlowOver; d14: FlowOver };
  /** Its last fee change LightningMate made (the fee-change log): who made
   *  it (absent: the autopilot), its reason, whether it applied a pin — and
   *  its "from", null when that wasn't known. */
  lastChange?: { at: string; fromPpm: number | null; toPpm: number; via?: FeeChangeRecord["via"]; why?: string; pinned?: boolean };
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
 *  is brought into them in one move). "demand": the demand ramp raised it,
 *  or the drain ramp.
 *  "step_back": a raise nothing sold at went back. */
type MoveKind = "free" | "raise_step" | "lower_step" | "ramp" | "ratchet" | "jump" | "floor" | "hold" | "range" | "demand" | "step_back" | "probe";

/** The velocity fact of a channel that routes both ways in balance. */
const VELOCITY_BALANCED = "velocity: active and balanced";

/** One channel's recommendation — pure (exported for the engine's own
 *  simulation tests). */
export function buildRecommendation(ch: FeeChannel, ctx: BuildCtx): FeeRecommendation {
  const { cfg, rate, f14, f30, records, bench, enoughChannels, earnerCutoff } = ctx;
  const currentPpm = rate?.fee_rate ?? 0;
  const cap = Math.max(1, ch.capacity);
  const step = Math.max(1, cfg.stepPpm);
  // The two floors the operator sets as fees — Protect ppm and the new
  // channel's protected fee — hold inside Min..Max like every other fee
  // (review FEE-4: with Max 200 and Protect 350 a drained channel was ramped
  // to 300; with Max 50 a new channel was lifted to 80 and the range rule
  // then walked it back down, two changes for nothing). Where Min stands
  // above Max, Max wins, as in the range rule.
  const protectPpm = clamp(cfg.protectPpm, cfg.minPpm, cfg.maxPpm);
  const newChannelMinPpm = clamp(cfg.newChannelMinPpm, cfg.minPpm, cfg.maxPpm);
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
  const inDemand = !!demand && demand.attempts >= DEMAND_MIN_ATTEMPTS && demand.days >= DEMAND_MIN_DAYS && demand.sats >= DEMAND_MIN_SATS;
  // Nobody routed through it in 30 days and it isn't turning payments away
  // (`quiet`): drained, it is never raised, and no profit floor lifts it —
  // whatever its age. Quiet and no longer new, it is `idle`: lowered by the
  // no-flow rule. (A new channel has had no time to route; review FEE-7: one
  // 2.9 days old sat at its protected fee and was at Min ppm a day later.)
  const quiet = f30.forwards === 0 && !inDemand;
  const idle = quiet && !isNewChan;

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

  // What sold at the fee it charges now, and the change that set it.
  const sold = ctx.soldSinceChange;
  const salesKnown = sold !== undefined;
  const recent = ctx.recent;
  const changedMs = Date.parse(ctx.cooldown?.lastApplied?.[ch.id] ?? ctx.lastChange?.at ?? "");
  const setAgo = Number.isFinite(changedMs) ? ` (set ${since(changedMs, ctx.nowMs)})` : "";
  // ("12 sales since it was set 3 d ago" — or, with no change in the window
  // the sales are counted over, "in 30 d".)
  const soldSpan =
    Number.isFinite(changedMs) && changedMs > ctx.nowMs - cfg.benchmarkWindowDays * DAY_MS
      ? `since it was set ${since(changedMs, ctx.nowMs)}`
      : `in ${cfg.benchmarkWindowDays} d`;
  const inflowTolerance = Math.max(REFILL_INFLOW_TOLERANCE_SHARE * cap, REFILL_INFLOW_TOLERANCE_SATS);

  // The drain ramp's signal (review FEE-3). The faster raises — protect, the
  // demand ramp — start under 10 % local, when the liquidity is gone: a
  // channel at 80 % local whose buyers took 300k a day and paid up to 400 ppm
  // was raised 20 ppm every 72 h, sold 3.95M at 96 ppm on average and reached
  // 350 ppm empty. The signal here is the time left: at what the channel
  // sells net a day at the fee it charges NOW, it is down to 10 % local
  // within DRAIN_RAMP_WITHIN_DAYS days. That rate is the largest of: the time
  // since the fee was set (counted as DEMAND_RAMP_HOURS at least), and the
  // last 1, 3, 7 and 14 days where the fee has stood that long — what sold at
  // an older, lower fee says nothing about this one (a ramp reading it climbs
  // past the price that had already slowed the drain). Each stretch counts
  // with DRAIN_MIN_FORWARDS sales and DRAIN_RAMP_NET_SHARE of the capacity
  // net out — what came in is taken off — and none counts unless the flow
  // window (14 days) shows that much net out too: a channel that routes both
  // ways has days on which it only sells, and gets the sats back the day
  // after; one such day is not a drain. Not where a measurement says higher
  // fees cost flow here (as for every drain reflex).
  const windowDays = cfg.benchmarkWindowDays;
  const stampMs = Date.parse(ctx.cooldown?.lastApplied?.[ch.id] ?? "");
  // (What `sold` is counted over: since the fee's stamp, the window at most.)
  const soldDays = Number.isFinite(stampMs) ? Math.min(windowDays, (ctx.nowMs - stampMs) / DAY_MS) : windowDays;
  const heldDays = Number.isFinite(changedMs) ? Math.min(windowDays, (ctx.nowMs - changedMs) / DAY_MS) : windowDays;
  let netOutPerDay = 0;
  const drainRate = (f: Flow | undefined, days: number): void => {
    if (!f || f.forwards < DRAIN_MIN_FORWARDS) return;
    const net = f.out - f.inn;
    if (net >= DRAIN_RAMP_NET_SHARE * cap) netOutPerDay = Math.max(netOutPerDay, net / days);
  };
  drainRate(sold, Math.max(soldDays, DEMAND_RAMP_HOURS / 24));
  if (recent) {
    if (heldDays >= 1) drainRate(recent.d1, 1);
    if (heldDays >= 3) drainRate(recent.d3, 3);
    if (heldDays >= 7) drainRate(recent.d7, 7);
    if (heldDays >= 14) drainRate(recent.d14, 14);
  }
  const daysToDrained = netOutPerDay > 0 ? ((ch.localRatio - DEMAND_RAMP_LOCAL) * cap) / netOutPerDay : Infinity;
  const fastDrain =
    ch.localRatio >= DEMAND_RAMP_LOCAL &&
    daysToDrained <= DRAIN_RAMP_WITHIN_DAYS &&
    netDrain14d >= DRAIN_RAMP_NET_SHARE &&
    ctx.elasticityMod >= 1;
  /** "it sells ~300k a day net at 50 ppm — at that rate it is down to 10% local in ~11 d" */
  const drainFact = (): string =>
    `it sells ~${satsShort(Math.round(netOutPerDay))} a day net at ${currentPpm} ppm — at that rate it is down to ${Math.round(DEMAND_RAMP_LOCAL * 100)}% local in ${
      daysToDrained < 1.5 ? "about a day" : `~${Math.round(daysToDrained)} d`
    }`;

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
    const fact = `velocity: draining fast (${Math.round(netDrain14d * 100)}% net in ${cfg.flowWindowDays}d)`;
    velocityLine = claim(`${fact} — small nudge up`, fact, 1);
  } else if (grossFlow14d >= 0.05 && netDrain14d >= 0.03) {
    velocityMod = 1.05;
    winsFlow = true;
    velocityLine = claim("velocity: steady outbound demand — small nudge up", "velocity: steady outbound demand", 1);
  } else if (grossFlow14d >= 0.2 && Math.abs(netDrain14d) < 0.05) {
    winsFlow = true;
    velocityLine = `${VELOCITY_BALANCED} — holding`;
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
      benchLine = claim("benchmark: outperforms node average and draining — raising fee", "benchmark: outperforms node average and draining", 1);
    } else if (isTopEarner) {
      // never let a top earner be pushed cheaper (by this rule, the explore
      // test or the market below) — nor say it is being tested lower (review:
      // okx read "idle test: … testing a lower fee", "exploring ↓", held).
      if (velocityMod < 1) {
        velocityMod = 1;
        if (exploring) {
          exploring = false;
          velocityLine = null;
        }
      }
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
  // drain velocity too — and so does a fast drain, above.)
  const noDrainSignal = ch.localRatio >= targetLocalRatio - cfg.deadband && velocityMod <= 1 && (!draining || ctx.elasticityMod < 1);
  // (A fee below the policy's min is lifted to the min by the range rule.)
  let heldLine: string | null = null;
  const curveAt = (): string => `the balance curve's ~${Math.min(cfg.maxPpm, Math.round(aim / step) * step)} ppm`;
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
  // The refill cost the aim was raised to (null: it wasn't) — what the drain
  // ramp's wider step is measured against.
  let refillAim: number | null = null;
  // (A channel on its way to drained within weeks is draining too, before
  // the 30-day net says so: review FEE-3, S4a — the refill cost was known and
  // shown for 24 days while 2.95M sold at a seventh of it.)
  if ((draining || fastDrain) && replacementCostPpm != null && market) {
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
        refillAim = refill;
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

  // Priced for the balance it will have (review FEE-3). The balance curve
  // prices the balance a channel has: one that sells 6 % of its capacity a
  // day is over its target today and under 10 % in eleven days, and the
  // curve's raise comes when it is there. A channel that drains fast is
  // priced where the curve puts the balance it will have in
  // DRAIN_RAMP_AHEAD_DAYS days at its present net rate — still a low fee
  // while it is full, the higher the nearer it comes to empty. Never a lower
  // aim than the rules above set.
  let drainAimLine: string | null = null;
  if (fastDrain) {
    const ahead = Math.max(0, ch.localRatio - (netOutPerDay * DRAIN_RAMP_AHEAD_DAYS) / cap);
    const priced = balanceTargetPpm(ahead, targetLocalRatio, { ...cfg, neutralPpm: neutral }) * combinedMod;
    if (priced > aim) {
      aim = priced;
      // (The refill cost is then not where the fee is going — "pricing toward
      // 460 ppm" stood beside "on the way to 1000 ppm": its fact stays.)
      if (replacementLine) {
        const at = reasons.indexOf(replacementLine);
        const known = claims.get(replacementLine)?.fact;
        if (at >= 0 && known) reasons[at] = known;
        replacementLine = null;
      }
      const fact = `drain: ${drainFact()}`;
      const then = ahead < 0.005 ? "the empty channel it would be" : `the ~${Math.round(ahead * 100)}% local it will have`;
      drainAimLine = claim(
        `${fact} — priced for ${then} in ${DRAIN_RAMP_AHEAD_DAYS} days: ~${Math.min(cfg.maxPpm, Math.round(priced / step) * step)} ppm`,
        fact,
        1,
      );
      reasons.push(drainAimLine);
    }
  }

  // Its last change, when that is a raise the autopilot made to the fee it
  // has now: not one set by hand (a manual apply, a pin) or one whose "from"
  // wasn't known (recorded as 0, it read as a raise from 0), nor while a pin
  // or an exclusion holds the fee.
  const lc = ctx.lastChange;
  const byHand = !!lc && (lc.via === "manual" || lc.pinned === true || /^pinned to /.test(lc.why ?? ""));
  const manualNow = ctx.override?.mode === "exclude" || (ctx.override?.mode === "fixed" && Number.isFinite(ctx.override.fixedPpm));
  const raisedFrom = lc && !byHand && lc.fromPpm !== null && lc.fromPpm > 0 && lc.toPpm > lc.fromPpm && lc.toPpm === currentPpm ? lc.fromPpm : null;
  const raisedMs = lc && raisedFrom !== null ? Date.parse(lc.at) : NaN;

  // A fee that sells is not lowered (review FEE-2). The curve lowered 30 ppm
  // a day whatever sold: a channel at its target that sold four times a day
  // at 300 ppm was walked down to 90 in a week and earned a third of what
  // 300 ppm earns on the same volume — "never below a fee that sold" was true
  // of the step-back only, and the balanced level, an operator's guess, was
  // the only price ever tried there. With SELLS_HERE_SALES sales at the fee
  // since it was set and one in the last 7 days it is held
  // against every lower aim: the curve's, the market's, a measured
  // elasticity, a refill cost below it.
  //
  // A write does not undo what the channel has shown (the package's own
  // review, R1: every change of the fee started "sold since it was set" at
  // none, and with it the hold — a fee that had sold daily for a month was
  // lowered the day after the autopilot wrote it, back from a climb, or the
  // operator set it: 19 changes in 90 days on a channel whose buyers paid
  // 110). So it is held, too, with SELLS_HERE_SALES sales in the last 7 days
  // while the fee stood at this one or higher (who paid more pays this), and
  // while it is not yet known whether it sells: it sold here since it was
  // set, fewer than SELLS_HERE_SALES times, on a channel that sold that often
  // in the last 7 days at whatever fee — until its own sales hold it, or the
  // week has run out without them.
  //
  // Not where the channel holds more than its target and a lower fee has
  // something to win: it takes in more than it sells (in 14 days, and still
  // in the last 7 — over the days the fee stood at this one or lower: on the
  // days of a higher fee, a price test's, it sold less because of that fee),
  // or at what it sells a day it would need more than SPARE_SELL_DAYS days to
  // sell what it holds over its target.
  //
  // Nor is a fee the autopilot raised to lowered by the curve in its first
  // RAISE_TRIAL_DAYS days: what sells at it decides — the step-back takes it
  // back after two days without a sale, a probe also when it earns less —
  // where the curve undid a raise a day later, whatever it sold. That week
  // stands whatever the channel holds: a test takes in more than it sells
  // while its buyers find the new price, and lowered for that it was never
  // judged.
  //
  // The range, a pin and a lease promise still lower such a fee; so does the
  // no-flow rule (what sold nothing in 30 days is not selling).
  const soldHere = sold?.forwards ?? 0;
  const soldWeek = recent?.d7.forwards ?? 0;
  const soldWeekAtLeast = ctx.soldAtOrAbove7d?.forwards ?? 0;
  const sellsAtFee = salesKnown && soldHere >= SELLS_HERE_SALES && soldWeek >= 1;
  const soldAtLeast = salesKnown && !sellsAtFee && soldWeekAtLeast >= SELLS_HERE_SALES;
  const notYetKnown = salesKnown && !sellsAtFee && !soldAtLeast && soldHere >= 1 && soldWeek >= SELLS_HERE_SALES;
  const sellsHere = sellsAtFee || soldAtLeast || notYetKnown;
  const onTrial = raisedFrom !== null && !manualNow && ctx.nowMs - raisedMs < RAISE_TRIAL_DAYS * DAY_MS;
  // …nor, for as long, the fee a step-back went back to: it is the fee that
  // sold before the raise, and its sales "since it was set" start at none
  // again — the curve took a 300 ppm that had sold 75 times in a month down a
  // step the day after a test's step-back, before three new sales could hold
  // it. (Every step-back: the one that ends a climb of several raises says
  // "raised", not "tried", and was not covered.)
  const testedFrom =
    lc && !byHand && lc.fromPpm !== null && lc.toPpm < lc.fromPpm && lc.toPpm === currentPpm && /^step back: /.test(lc.why ?? "") ? lc.fromPpm : null;
  const testedMs = lc && testedFrom !== null ? Date.parse(lc.at) : NaN;
  const backOnTrial = testedFrom !== null && !manualNow && ctx.nowMs - testedMs < RAISE_TRIAL_DAYS * DAY_MS;
  const overTarget = ch.localRatio - targetLocalRatio > cfg.deadband;
  const spareSats = Math.max(0, (ch.localRatio - targetLocalRatio) * cap);
  // (A context without the fee levels counts the days whole.)
  const atFee = ctx.atOrBelow ?? (recent ? { d7: { ...recent.d7, ms: 7 * DAY_MS }, d14: { ...recent.d14, ms: 14 * DAY_MS } } : undefined);
  const takesInMore = !!atFee && atFee.d14.inn - atFee.d14.out > inflowTolerance && atFee.d7.inn > atFee.d7.out;
  const soldPerDay = recent ? recent.d14.out / 14 : 0;
  const slowSeller = !!recent && spareSats > soldPerDay * SPARE_SELL_DAYS;
  const spareToSell = overTarget && (takesInMore || slowSeller);
  // Set when this hold kept the fee (a lowering another line claimed is then
  // taken back to its fact).
  let heldSelling = false;
  if (aim < currentPpm && (sellsHere || onTrial || backOnTrial)) {
    const lowerAim = Math.max(cfg.minPpm, Math.min(cfg.maxPpm, Math.round(aim / step) * step));
    const sales = (n: number): string => (n === 1 ? "1 sale" : `${n} sales`);
    if (onTrial || backOnTrial || !spareToSell) {
      heldLine =
        sellsAtFee && !spareToSell
          ? `hold: it sells at ${currentPpm} ppm (${sales(soldHere)} ${soldSpan}) — a fee that sells is not lowered toward ${lowerAim} ppm`
          : soldAtLeast && !spareToSell
            ? `hold: it sold ${soldWeekAtLeast} times in the last 7 days at ${currentPpm} ppm or more — a fee that sells is not lowered toward ${lowerAim} ppm`
            : notYetKnown && !spareToSell
              ? `hold: ${sales(soldHere)} at ${currentPpm} ppm ${soldSpan}, on a channel that sold ${soldWeek} times in the last 7 days — too early to say it does not sell here: it is not lowered toward ${lowerAim} ppm`
              : onTrial
                ? `hold: raised ${raisedFrom}→${currentPpm} ppm ${since(raisedMs, ctx.nowMs)} — what sells at it decides for ${RAISE_TRIAL_DAYS} days, it is not lowered toward ${lowerAim} ppm`
                : `hold: back at ${currentPpm} ppm ${since(testedMs, ctx.nowMs)}, after ${/^step back: tried /.test(lc?.why ?? "") ? "a test of" : "a raise to"} ${testedFrom} ppm — it sold here before: what sells at it decides for ${RAISE_TRIAL_DAYS} days, it is not lowered toward ${lowerAim} ppm`;
      aim = currentPpm;
      heldSelling = true;
      // (Nor is it "testing a lower fee".)
      if (exploring) {
        exploring = false;
        dropLine(velocityLine);
      }
      if (benchMod < 1) dropLine(benchLine);
      dropLine(marketLine);
      reasons.push(heldLine);
    } else if (sellsHere && recent && atFee) {
      // (Over the days at this fee or a lower one, where some were left out.)
      const atFeeDays = Math.round((atFee.d14.ms / DAY_MS) * 10) / 10;
      const over = atFeeDays >= 14 ? "in 14 d" : `in the ${atFeeDays} of the last 14 days at this fee or a lower one`;
      reasons.push(
        takesInMore
          ? `spare: it sells at ${currentPpm} ppm, but holds more than its target and takes in more than it sells (${satsShort(atFee.d14.inn)} in, ${satsShort(atFee.d14.out)} out ${over}) — the fee is not held for those sales`
          : `spare: it sells at ${currentPpm} ppm, but at ~${satsShort(Math.round(soldPerDay))} a day it would take more than ${SPARE_SELL_DAYS} days to sell the ${satsShort(Math.round(spareSats))} it holds over its target — the fee is not held for those sales`,
      );
    }
  }

  // With the forwarding history incomplete, what the fee sold is unknown and
  // none of the holds above can speak. The run says so (the package's own
  // review, R8: a selling fee went down a step with no line why the hold was
  // off). The fee is still lowered: a node whose history never fits the read
  // would otherwise only ever raise.
  if (!salesKnown && aim < currentPpm)
    reasons.push("sales unknown: the forwarding history could not be read whole — the hold for a fee that sells does not apply on this run");

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
  const drainedWithBuyers =
    ch.localRatio < DEMAND_RAMP_LOCAL && f30.forwards >= DRAIN_MIN_FORWARDS && f14.inn - f14.out <= inflowTolerance;
  const demandRamp = drainedWithBuyers && (sold?.forwards ?? 0) >= DEMAND_RAMP_SALES && ctx.elasticityMod >= 1;
  // The drain ramp (review FEE-3): the same moves BEFORE the channel is
  // drained, on the signal above — at what it sells net a day at this fee it
  // is down to 10 % local within DRAIN_RAMP_WITHIN_DAYS days — and the same
  // proof, DEMAND_RAMP_SALES sales at the fee it raises from. Each move
  // starts the count again: where the higher fee slows the sales enough, the
  // ramp ends by itself, at the fee that holds the balance; where nothing
  // sells at it, the step-back takes it back to the last fee that sold.
  // Toward a refill cost the market shows it covers a third of the way per
  // move where that is more (never more than doubling the fee): 70 → 140 →
  // 280 → 520 toward ~1,000 where a quarter needs twelve moves.
  const drainRamp = fastDrain && (sold?.forwards ?? 0) >= DEMAND_RAMP_SALES;
  const ramping = demandRamp || drainRamp;
  const ordinaryStep = RAISE_STEPS * step * elasticStep;
  // (Rounded down onto the grid: "up to a quarter" holds — 25 % of 100 is a
  // 20-ppm move on a 10-ppm grid, never 30.)
  const quarterStep = Math.floor((from * DEMAND_RAMP_SHARE) / step) * step;
  const gapStep =
    drainRamp && refillAim !== null && refillAim > from
      ? Math.min(Math.floor(((refillAim - from) * DRAIN_RAMP_GAP_SHARE) / step) * step, Math.floor(from / step) * step)
      : 0;
  const raiseStep = ramping ? Math.max(ordinaryStep, quarterStep, gapStep) : ordinaryStep;
  // The most any channel is lowered in one move: its ratchet's steps (at
  // least one).
  const lowerStep = Math.max(1, cfg.noFlowRatchetSteps) * step;
  if (target > from + raiseStep) {
    target = from + raiseStep;
    kind = ramping ? "demand" : "raise_step";
    hiLimit = from + raiseStep;
  } else if (ramping && target > from) {
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
    const protectAhead = ch.localRatio < 0.1 && (f30.forwards > 0 || inDemand) ? protectPpm : 0;
    const profitAhead = profitFloorPpm != null && refill && !quiet ? profitFloorPpm : 0;
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
  // The upward probe (review FEE-2; othervice's decision E1). A fee that
  // sells is kept — and nothing ever tried whether its buyers pay more: the
  // curve aims at the balanced level whatever sells, and a channel that isn't
  // below its target and doesn't drain is never raised. Where it sells daily
  // (PROBE_WEEK_SALES sales in the last week, SELLS_HERE_SALES of them at this
  // fee), holds no more than its target, no measurement says higher fees cost
  // flow here, and no rule raises it (the aim is at the fee, or nearer than
  // the anti-churn threshold lets a move be), it tries a fee PROBE_SHARE
  // higher — at least one grid step, at the ordinary raise's pace. The
  // step-back below takes it back: after STEP_BACK_AFTER_HOURS without a
  // sale, or when it earned less than the fee before it did. With fewer
  // sales a week a probe would mostly be taken back by chance (two days
  // without a sale are then the rule, not a sign), so it isn't made — nor
  // before the fee has stood PROBE_JUDGE_AFTER_HOURS and sold
  // PROBE_RECENT_SALES times in them: those hours are what the probe is set
  // against. (The lines call it a "price test": "probes" are refused
  // payments elsewhere in the app.)
  //
  // What a probe earned is judged once (the package's own review, R2): its
  // first PROBE_JUDGE_AFTER_HOURS against the PROBE_JUDGE_AFTER_HOURS before
  // it, at the fee before — two stretches of one length, both over when the
  // first run looks at them, so that no later sale changes what they say.
  // Less, and it goes back (while its RAISE_TRIAL_DAYS days run); as much or
  // more, and it is kept and the next probe may follow. Before, it was a
  // running average a day over two stretches of unlike length, read at every
  // run from 72 hours on with one sale's margin: the hour the autopilot ran
  // in decided whether the same probe stayed, and what chance kept was never
  // looked at again — buyers who buy a sixth less at each tenth more left a
  // channel 1,500 to 2,000 sat in 120 days where the fee it began at earned
  // 2,400.
  const probed = raisedFrom !== null && /^price test: /.test(lc?.why ?? "");
  const raisedH = (ctx.nowMs - raisedMs) / 3_600_000;
  const test = probed && ctx.priceTest && ctx.priceTest.fromPpm === raisedFrom ? ctx.priceTest : null;
  /** "early": not judged yet. "less": to be taken back. "kept". Null: no
   *  price test, one that is not judged on what it earned (the stretch before
   *  it is not on record whole), or one that earned less and could not be
   *  taken back in its trial days — an ordinary fee by now. */
  const verdict: "early" | "less" | "kept" | null = !test
    ? null
    : raisedH < PROBE_JUDGE_AFTER_HOURS
      ? "early"
      : test.first.revenue >= test.before.revenue
        ? "kept"
        : raisedH < RAISE_TRIAL_DAYS * 24
          ? "less"
          : null;
  const sat = (n: number): string => (n < 100 ? String(Math.round(n * 10) / 10) : Math.round(n).toLocaleString("en-US"));
  // One step of a tenth cannot be told from chance on three days' sales
  // (twelve sales vary by a quarter and more on their own), and a probe kept
  // by chance is the base of the next. So the climb is checked against the
  // fee it began at — the fee before the earliest of its price tests since
  // which the fee never came back to it: at the end of each of its weeks,
  // what it earned in its last days against as many days before the climb
  // (climbAnchorOf). Less, and the whole climb goes back (below). Only where
  // the channel had sats to sell through those days — the time the autopilot
  // keeps for the step-back.
  const sellableSince = ctx.cooldown?.sellableSince;
  const sellableSinceMs = sellableSince === undefined ? -Infinity : Date.parse(sellableSince[ch.id] ?? "");
  const anchor = ctx.climbAnchor && ctx.climbAnchor.ppm < currentPpm ? ctx.climbAnchor : null;
  const anchorWeek = anchor?.week ?? null;
  const anchorJudged = !!anchorWeek && sellableSinceMs <= anchorWeek.from;
  // Less by more than one sale: two stretches of one length of the same even
  // flow differ by a sale (a channel selling twice a day sold 9 times in five
  // days and 10 times in the five before — at a tenth more a sale, that read
  // "earned less" and took back the fee its buyers paid).
  const anchorSale = anchorWeek && anchorWeek.now.forwards > 0 ? anchorWeek.now.revenue / anchorWeek.now.forwards : 0;
  const anchorLess = !!anchorWeek && anchorJudged && anchorWeek.now.revenue + anchorSale < anchorWeek.before.revenue;
  const spanOf = (hours: number): string => (hours % 24 === 0 ? `${hours / 24} d` : `${hours} h`);
  /** The hours a week's check is judged on, as its line names them. */
  const lastSpan = (w: { hours: number; window: number }): string =>
    w.hours < w.window ? `${spanOf(w.hours)} of its last ${spanOf(w.window)} (without a price test taken back or not yet judged)` : `its last ${spanOf(w.hours)}`;
  if (anchor && anchorWeek && anchorJudged && !anchorLess)
    reasons.push(
      `price test: at ${currentPpm} ppm, up from ${anchor.ppm} ppm ${since(Date.parse(anchor.startedAt), ctx.nowMs)} — it earned ${sat(anchorWeek.now.revenue)} sat in ${lastSpan(anchorWeek)} against ${sat(anchorWeek.before.revenue)} in the ${spanOf(anchorWeek.hours)} before, at ${anchor.ppm} ppm: kept${
        anchorWeek.now.revenue < anchorWeek.before.revenue ? " (less by no more than one sale)" : ""
      }`,
    );
  // A probe that was taken back is not made again for a while that grows
  // with each failure (7, 14, 28 days) — the step-back's record, kept apart
  // for probes: as one memory, a failed probe held a drained channel's
  // protect ramp down for a week, and a burst of demand sold at the old fee.
  // No middle of the stretch is tried in between, as after a step-back: a
  // probe is one small step already, and half of it says nothing new (a
  // channel went 280 → 300 → 280 → 290 → 280 every two weeks).
  const probeBack = ctx.cooldown?.probeBacks?.[ch.id];
  const probeBackAtMs = probeBack ? Date.parse(probeBack.at) : NaN;
  const probeBackDays = stepBackMemoryDays(probeBack?.count);
  const probeBackLive =
    !!probeBack && Number.isFinite(probeBackAtMs) && ctx.nowMs - probeBackAtMs < probeBackDays * DAY_MS && currentPpm < probeBack.fromPpm;
  let probeMemorySaid = false;
  const minDelta = Math.max(cfg.minChangePpm, Math.round(currentPpm * cfg.relativeChangeThreshold));
  const weekSales = recent?.d7.forwards ?? 0;
  // (recent.d3: the PROBE_JUDGE_AFTER_HOURS before now.)
  const recentSold = recent?.d3.forwards ?? 0;
  if (
    sellsAtFee &&
    weekSales >= PROBE_WEEK_SALES &&
    !overTarget &&
    ctx.elasticityMod >= 1 &&
    !manualNow &&
    currentPpm >= cfg.minPpm &&
    currentPpm < cfg.maxPpm &&
    // (No rule lowers it — a hold has set the aim to the fee by now — and
    // none raises it by a move the threshold lets through.)
    aim >= currentPpm &&
    aim - currentPpm < minDelta
  ) {
    const probeStep = Math.max(step, Math.floor((currentPpm * PROBE_SHARE) / step) * step);
    const to = Math.min(cfg.maxPpm, currentPpm + probeStep);
    if (verdict === "early" && test) {
      reasons.push(
        `price test: raised ${raisedFrom}→${currentPpm} ppm ${since(raisedMs, ctx.nowMs)} — judged once, ${PROBE_JUDGE_AFTER_HOURS} h after the raise: what it earned in them against the ${PROBE_JUDGE_AFTER_HOURS} h before, at ${raisedFrom} ppm (${sat(test.before.revenue)} sat)`,
      );
    } else if (verdict === "less" || anchorLess) {
      // (Earning less: the step-backs below say so.)
    } else if (probeBack && probeBackLive) {
      const until = new Date(probeBackAtMs + probeBackDays * DAY_MS).toISOString().slice(0, 10);
      probeMemorySaid = true;
      reasons.push(
        `price test: ${probeBack.fromPpm} ppm was tried and taken back ${since(probeBackAtMs, ctx.nowMs)}${
          (probeBack.count ?? 1) > 1 ? ` (the ${probeBack.count === 2 ? "second" : "third"} time in a row)` : ""
        } — no higher fee is tried before ${until}`,
      );
    } else if (heldDays * 24 < PROBE_JUDGE_AFTER_HOURS || recentSold < PROBE_RECENT_SALES) {
      if (verdict === "kept" && test)
        reasons.push(
          `price test: ${currentPpm} ppm earned ${sat(test.first.revenue)} sat in its first ${PROBE_JUDGE_AFTER_HOURS} h against ${sat(test.before.revenue)} in the ${PROBE_JUDGE_AFTER_HOURS} h before, at ${raisedFrom} ppm — kept; a higher fee is tried once it sold ${PROBE_RECENT_SALES} times in ${PROBE_JUDGE_AFTER_HOURS} h (${recentSold} in the last ${PROBE_JUDGE_AFTER_HOURS} h)`,
        );
    } else {
      target = to;
      aim = target;
      hiLimit = target;
      kind = "probe";
      // (Not "testing a lower fee" beside a raise.)
      if (exploring) {
        exploring = false;
        dropLine(velocityLine);
      }
    }
  }
  // The price a test failed at is not reached by an ordinary raise either
  // while the test's memory lasts (the package's own review, R6: three days
  // after 110 ppm was judged to earn less than 100, "steady outbound demand —
  // small nudge up" went 100 → 120 in one move, past it). Such a raise stops
  // on the highest grid price below the one that failed. The demand and drain
  // ramps, the protect ramp and the floors stay free: a failed test must not
  // hold a draining channel down (a burst of demand sold at the old fee).
  if (probeBack && probeBackLive && !ramping && kind !== "probe" && target > currentPpm) {
    const below = Math.max(currentPpm, Math.ceil(probeBack.fromPpm / step) * step - step);
    if (target > below) {
      target = below;
      hiLimit = Math.min(hiLimit, below);
      aim = Math.min(aim, below);
      const until = new Date(probeBackAtMs + probeBackDays * DAY_MS).toISOString().slice(0, 10);
      const fact = `${probeBack.fromPpm} ppm was tried and taken back ${since(probeBackAtMs, ctx.nowMs)} — it earned less there`;
      if (below <= currentPpm) {
        kind = "hold";
        if (!probeMemorySaid) dominant(`hold: ${fact}; not raised to it before ${until} unless the channel drains`);
      } else {
        reasons.push(claim(`guard: ${fact}; raised no higher than ${below} ppm before ${until} unless the channel drains`, null, 1));
      }
    }
  }

  // A raise needs a buyer at the fee it raises from (2026-10-25 review):
  // the curve, a drain signal, the replacement cost and the ramp all read 14-
  // and 30-day windows that may hold no sale at all — node8153 was raised
  // 50 → 190 ppm in three weeks with its last sale behind it, then cut to 25
  // once that left the window; a channel at its reserve that can't forward
  // rose 20 ppm every 72 h. With nothing sold at the fee since it was set,
  // it is held (the floors, the policy's min, a pin and a lease promise
  // still move it). Without the forwarding history (a read cut short) what
  // sold is unknown, and the rule doesn't apply.
  // A payment turned away for lack of outbound since the fee was set is a
  // buyer at this fee the sales can't show (a drained channel sells nothing).
  // Where the time of the last one isn't known (a record written before it
  // was kept), protect takes the demand as current — the step-back does not.
  const refusedAt = demand?.lastAt;
  const refusedSinceSet = inDemand && (refusedAt == null || !Number.isFinite(changedMs) || refusedAt > changedMs);
  const refusedSinceSetForSure = inDemand && refusedAt != null && Number.isFinite(changedMs) && refusedAt > changedMs;
  // A drained channel nobody routes through is never raised (below) — its
  // own hold says so, with its fee as the aim, not "before a sale" (final
  // review: it read "not raised toward 350 ppm before a sale").
  const drainedIdle = quiet && ch.localRatio < 0.1;
  let unsoldLine: string | null = null;
  if (salesKnown && sold.forwards === 0 && target > currentPpm && !drainedIdle) {
    // (The aim as the policy's max bounds it: the line named aims above it.)
    unsoldLine = `hold: nothing sold at ${currentPpm} ppm since it was set${setAgo} — not raised toward ${Math.min(cfg.maxPpm, Math.round(aim / step) * step)} ppm before a sale`;
    target = currentPpm;
    hiLimit = currentPpm;
    kind = "hold";
    dominant(unsoldLine);
  }

  // After a step-back, the fee it stepped back from is not raised to again
  // for STEP_BACK_MEMORY_DAYS (final review 2026-10-25): one sale at the
  // price it went back to, and the ramp climbed straight back into the price
  // nobody had bought at. A raise goes at most to the highest grid price
  // below it; a floor, the policy's min, a pin and a lease promise still
  // move the fee (and a fee a floor took past it is not held back by it).
  //
  // The memory grows and narrows (review FEE-11): a step-back that ended no
  // higher than the one before doubles it (7, 14, 28 days), and while the fee
  // stands in the lower half between the price it went back to and the one
  // that failed, a raise goes at most to the middle — each failed try halves
  // the stretch that is tried again, instead of the whole climb every week.
  const lastBack = ctx.cooldown?.stepBacks?.[ch.id];
  const backAtMs = lastBack ? Date.parse(lastBack.at) : NaN;
  const backDays = stepBackMemoryDays(lastBack?.count);
  const backLive = !!lastBack && Number.isFinite(backAtMs) && ctx.nowMs - backAtMs < backDays * DAY_MS && currentPpm < lastBack.fromPpm;
  /** The highest fee the memory lets a raise reach (Infinity: no memory). */
  let memoryCap = Infinity;
  if (lastBack && backLive) memoryCap = memoryCapOf(lastBack, currentPpm, step);
  let backCapLine: string | null = null;
  let backCapAt = Infinity;
  // The aim the memory stopped short (null: it didn't). The anti-churn
  // threshold judges a raise the memory bounds against it: the middle of the
  // stretch may be 10 ppm away while what the rules aim at is hundreds —
  // with the bounded aim as the gap, a fee that sold sat a step under the
  // middle for the memory's whole length ("change below threshold").
  let aimPastMemory: number | null = null;
  /** The memory's bound, said once — by the rule it stopped first: a hold
   *  where it leaves no room at all, else a guard. */
  const sayMemory = (): void => {
    if (!lastBack || backCapLine) return;
    backCapAt = memoryCap;
    const until = new Date(backAtMs + backDays * DAY_MS).toISOString().slice(0, 10);
    const fact = `stepped back from ${lastBack.fromPpm} ppm ${since(backAtMs, ctx.nowMs)}${
      (lastBack.count ?? 1) > 1 ? ` (the ${lastBack.count === 2 ? "second" : "third"} time in a row)` : ""
    }`;
    if (backCapAt <= currentPpm) {
      backCapLine = `hold: ${fact} — not raised back to it before ${until}`;
      dominant(backCapLine);
    } else {
      backCapLine = claim(`guard: ${fact} — raised no higher than ${backCapAt} ppm before ${until}`, null, 1);
      reasons.push(backCapLine);
    }
  };
  // (Also where this move stays under the bound and the aim lies past it: "on
  // the way to 830 ppm" was said of a climb the memory ends at 390.)
  if (lastBack && backLive && (target > memoryCap || (aim > memoryCap && target > currentPpm))) {
    target = Math.min(target, memoryCap);
    hiLimit = Math.min(hiLimit, memoryCap);
    if (aim > memoryCap) aimPastMemory = aim;
    aim = Math.min(aim, memoryCap);
    if (memoryCap <= currentPpm) kind = "hold";
    sayMemory();
  }

  // The step-back (2026-10-25 review): a fee LightningMate raised that sold
  // nothing for STEP_BACK_AFTER_HOURS while the channel had sats to sell goes
  // back in one move, paced like a lowering (the ramp stopped one step above
  // what buyers paid, and a drained channel had no way back down: the no-flow
  // rule needs 10 % local and 30 idle days). It goes to the last fee that
  // sold: the highest price of the climb that ended here at which something
  // sold — or, if none of them sold, the fee before the climb's first raise
  // (review FEE-1: a ramp went 80 → 350 ppm in 42 hours past buyers who paid
  // up to 150; one step back, to 340, left it above them for months) — and
  // never below the last price that sold three times (its proven level). A
  // floor that holds the fee anyway — the profit floor, a new channel's
  // protected fee, the policy's min — is where it stops, and with none of
  // that below the fee there is no step-back (review FEE-8: "step back … to
  // 80 ppm" was said over a fee a floor kept). Not while payments were turned
  // away since the fee was set: those are buyers at this price. The hours
  // count from the raise — or, if later, from when the channel last got sats
  // to sell (the autopilot keeps that time): a channel drained through them
  // could sell nothing, and was stepped back on the first run its liquidity
  // came back.
  // (Only a raise the autopilot made — `raisedFrom`, above.)
  const sellable = sellableSats(cap, ch.localRatio);
  const proven = ctx.provenLevel ?? null;
  // (Without the climb — a context that has only the last change, a raise
  // older than the forwards read — it is the fee before that raise.)
  const climb = raisedFrom !== null ? (ctx.raiseChain ?? null) : null;
  const climbTo = climb ? (climb.soldPpm ?? climb.basePpm) : raisedFrom;
  const holdNew = ageDays != null && ageDays < cfg.newChannelProtectionDays && f30.forwards < 3 ? newChannelMinPpm : 0;
  const holdProfit = profitFloorPpm != null && refill && !quiet ? profitFloorPpm : 0;
  const heldAt = Math.max(cfg.minPpm, holdNew, holdProfit);
  // (At or above this fee, the proven level or a floor leaves nothing below
  // it: none.)
  const backTo = climbTo !== null ? Math.max(climbTo, proven?.ppm ?? 0, heldAt) : null;
  const clockMs = Math.max(raisedMs, sellableSinceMs);
  let stepBackLine: string | null = null;
  if (
    raisedFrom !== null &&
    backTo !== null &&
    backTo < currentPpm &&
    !manualNow &&
    salesKnown &&
    sold.forwards === 0 &&
    !refusedSinceSetForSure &&
    Number.isFinite(clockMs) &&
    ctx.nowMs - clockMs >= STEP_BACK_AFTER_HOURS * 3_600_000 &&
    sellable >= stepBackSellableMin(cap)
  ) {
    const steps = climb?.steps ?? 1;
    const fact =
      climb && steps > 1
        ? `step back: raised ${climb.basePpm}→${currentPpm} ppm in ${steps} moves, the last ${since(raisedMs, ctx.nowMs)}, and nothing sold at it since`
        : `step back: ${probed ? "tried" : "raised"} ${raisedFrom}→${currentPpm} ppm ${since(raisedMs, ctx.nowMs)} and nothing sold at it since`;
    const selling = clockMs > raisedMs ? ` (with sats to sell for ${since(clockMs, ctx.nowMs).replace(/ ago$/, "")})` : "";
    const where =
      proven && backTo === proven.ppm
        ? `the last price that sold ${proven.sales} times`
        : backTo === holdProfit
          ? "its profit floor, what its refills cost"
          : backTo === holdNew
            ? "a new channel's protected fee"
            : climb && climb.soldPpm !== null && backTo === climb.soldPpm
              ? "the highest price of this climb that sold"
              : backTo === climbTo
                ? steps > 1
                  ? `its fee before these ${steps} raises`
                  : "its fee before that raise"
                : "the policy's min";
    stepBackLine = claim(`${fact}${selling}, with ${satsShort(sellable)} to sell — back to ${backTo} ppm, ${where}`, fact, -1);
    if (unsoldLine) dropLine(unsoldLine);
    unsoldLine = null;
    if (backCapLine) dropLine(backCapLine);
    backCapLine = null;
    target = backTo;
    aim = Math.min(aim, backTo);
    loLimit = backTo;
    hiLimit = backTo;
    kind = "step_back";
    dominant(stepBackLine);
  }

  // A climb of price tests that earned less than the fee it began at goes
  // back to that fee (the check above), all of it: each of its tests was
  // kept on three days' sales, and together they are what the weeks show.
  // Not below a floor that holds the fee anyway, and — as the step-back
  // above — not after payments were turned away since the fee was set. It
  // goes further down than a step-back for a last test nothing sold at, and
  // takes its place.
  const climbBackTo = anchor ? Math.max(anchor.ppm, heldAt) : null;
  let climbBack = false;
  if (
    anchor &&
    anchorWeek &&
    anchorLess &&
    climbBackTo !== null &&
    climbBackTo < (kind === "step_back" ? target : currentPpm) &&
    !manualNow &&
    !refusedSinceSetForSure &&
    sellable >= stepBackSellableMin(cap)
  ) {
    const span = spanOf(anchorWeek.hours);
    const started = since(Date.parse(anchor.startedAt), ctx.nowMs);
    const fact = `step back: ${
      anchor.tests > 1 ? `raised ${anchor.ppm}→${currentPpm} ppm in ${anchor.tests} price tests since ${started}` : `tried ${anchor.ppm}→${currentPpm} ppm ${started}`
    }, and it earned less there, by more than one sale (${sat(anchorWeek.now.revenue)} sat in ${lastSpan(anchorWeek)} against ${sat(anchorWeek.before.revenue)} in the ${span} before, at ${anchor.ppm} ppm)`;
    const where =
      climbBackTo === anchor.ppm
        ? anchor.tests > 1
          ? "its fee before these tests"
          : "its fee before the test"
        : climbBackTo === holdProfit
          ? "its profit floor, what its refills cost"
          : climbBackTo === holdNew
            ? "a new channel's protected fee"
            : "the policy's min";
    if (stepBackLine) dropLine(stepBackLine);
    stepBackLine = claim(`${fact} — back to ${climbBackTo} ppm, ${where}`, fact, -1);
    if (unsoldLine) dropLine(unsoldLine);
    unsoldLine = null;
    if (backCapLine) dropLine(backCapLine);
    backCapLine = null;
    target = climbBackTo;
    aim = Math.min(aim, climbBackTo);
    loLimit = climbBackTo;
    hiLimit = climbBackTo;
    kind = "step_back";
    climbBack = true;
    dominant(stepBackLine);
  }

  // A probe that still sells and earned less in its first
  // PROBE_JUDGE_AFTER_HOURS than the fee before it did in as many (above)
  // goes back to that fee — where the 48 hours above only ask whether
  // anything sold at all. Only while the channel had sats to sell since the
  // probe and turned no payment away. Back to the fee before the probe, not
  // to the last price that sold three times — the probed fee may be that
  // price by now.
  const lessBackTo = raisedFrom !== null ? Math.max(raisedFrom, heldAt) : null;
  if (
    kind !== "step_back" &&
    verdict === "less" &&
    test &&
    raisedFrom !== null &&
    lessBackTo !== null &&
    lessBackTo < currentPpm &&
    !manualNow &&
    sold !== undefined &&
    sold.forwards >= 1 &&
    !refusedSinceSetForSure &&
    Number.isFinite(clockMs) &&
    clockMs <= raisedMs &&
    sellable >= stepBackSellableMin(cap)
  ) {
    const fact = `step back: tried ${raisedFrom}→${currentPpm} ppm ${since(raisedMs, ctx.nowMs)} and it earned less in its first ${PROBE_JUDGE_AFTER_HOURS} h (${sat(test.first.revenue)} sat against ${sat(test.before.revenue)} in the ${PROBE_JUDGE_AFTER_HOURS} h before, at ${raisedFrom} ppm)`;
    const where =
      lessBackTo === raisedFrom
        ? "its fee before the test"
        : lessBackTo === holdProfit
          ? "its profit floor, what its refills cost"
          : lessBackTo === holdNew
            ? "a new channel's protected fee"
            : "the policy's min";
    stepBackLine = claim(`${fact} — back to ${lessBackTo} ppm, ${where}`, fact, -1);
    if (backCapLine) dropLine(backCapLine);
    backCapLine = null;
    target = lessBackTo;
    aim = Math.min(aim, lessBackTo);
    loLimit = lessBackTo;
    hiLimit = lessBackTo;
    kind = "step_back";
    dominant(stepBackLine);
  }

  // A drained channel nobody routes through is never raised: there is no
  // flow to slow, and it would sit at a high fee once it refills (review a1:
  // 80 → 900 ppm in one update, then stuck at 590 after a refill).
  let drainedIdleLine: string | null = null;
  if (drainedIdle && target > currentPpm) {
    target = currentPpm;
    aim = Math.min(aim, currentPpm);
    kind = "hold";
    drainedIdleLine = `hold: drained (${Math.round(ch.localRatio * 100)}% local) and idle ${
      ageDays != null && ageDays < 30 ? `since it opened ${ageDays} d ago` : "for 30 days"
    } — an idle channel is never raised`;
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
    aimFloor = Math.max(aimFloor, newChannelMinPpm);
    hardFloor = Math.max(hardFloor, newChannelMinPpm);
    if (newChannelMinPpm > target) {
      const fact = `new channel: only ${ageDays}d old with little history — its protected fee is ${newChannelMinPpm} ppm`;
      const line = `new channel: only ${ageDays}d old with little history — keeping a protected fee`;
      target = newChannelMinPpm;
      aim = Math.max(aim, newChannelMinPpm);
      aimCeiling = Math.max(aimCeiling, newChannelMinPpm);
      if (newChannelMinPpm > currentPpm) {
        // It lifts the fee: at once, and it is why.
        kind = "floor";
        hiLimit = Infinity;
        dominant(claim(line, fact));
      } else {
        // A fee above it is only stopped short of it (lowered by steps).
        reasons.push(claim(`${line} (not below ${newChannelMinPpm} ppm)`, fact));
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
  if (profitFloorPpm != null && refill && profitFloorPpm > target && !quiet) {
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
  if (floorReleased && refill && !quiet) {
    reasons.push(
      `profit floor released: ${satsShort(refill.remainingSats)} of refills still here, but under ${LOW_FLOW_FORWARDS} forwards out in ` +
        `${cfg.flowWindowDays} d at ${Math.round(ch.localRatio * 100)}% local — holding their price (${refill.ppm} ppm) isn't moving them`,
    );
  }
  // Protect only a drained channel that is STILL in demand — a modest bump to
  // slow the bleed, never a flat ceiling. In demand: it forwarded in the
  // window, or it keeps turning payments away for lack of outbound.
  const protectFact = `protect: drained (${Math.round(ch.localRatio * 100)}% local) but still in demand`;
  // (Not over a step-back: nothing sold at this fee and nobody was turned
  // away at it.)
  const protects = kind !== "step_back" && ch.localRatio < 0.1 && (f30.forwards > 0 || inDemand);
  // The ramp toward Protect ppm needs a buyer at the fee it raises from, like
  // every raise: a sale at it since it was set, or a payment turned away for
  // lack of outbound since then (review FEE-1: the ramp read 30 days of
  // forwards, so one burst took a channel to 350 ppm in 42 hours with nothing
  // sold on the way). Without one the fee is neither lifted nor held; a fee
  // already at Protect ppm or more is still not lowered under it.
  const protectEvidence = !salesKnown || sold.forwards >= 1 || refusedSinceSet;
  // Below Protect ppm the ramp also stops at the step-back's memory: the
  // price nobody bought at is not ramped back to under another name.
  const memoryBinds = protects && protectEvidence && currentPpm < protectPpm && memoryCap < protectPpm;
  if (protects && currentPpm < protectPpm && !protectEvidence) {
    if (!unsoldLine)
      reasons.push(
        `protect: drained (${Math.round(ch.localRatio * 100)}% local), but nothing sold at ${currentPpm} ppm since it was set${setAgo} — not ramped toward ${protectPpm} ppm before a sale`,
      );
  } else if (memoryBinds) {
    const ramped = liftTo(memoryCap);
    if (ramped > currentPpm) floorRampTo = Math.max(floorRampTo, memoryCap);
    const lifts = ramped > target && ramped > currentPpm;
    if (ramped > target) {
      target = ramped;
      if (lifts) {
        kind = "ramp";
        hiLimit = ramped;
      }
    }
    aimPastMemory = Math.max(aimPastMemory ?? 0, aim, protectPpm);
    aim = Math.max(Math.min(aim, memoryCap), ramped);
    aimFloor = Math.max(aimFloor, ramped);
    hardFloor = Math.max(hardFloor, ramped);
    floored = "protecting_liquidity";
    sayMemory();
    if (lifts) dominant(claim(`${protectFact} — ramping toward ${memoryCap} ppm`, protectFact, 1));
    else reasons.push(protectFact);
  } else if (protects) {
    // Ramp, don't slam: step toward protectPpm by at most RAMP_STEPS steps
    // per change (the old one-shot jump to protectPpm was the outage
    // mechanic in miniature).
    const ramped = liftTo(protectPpm);
    if (ramped > currentPpm) floorRampTo = Math.max(floorRampTo, protectPpm);
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
    aim = Math.max(aim, protectPpm);
    aimFloor = Math.max(aimFloor, protectPpm);
    hardFloor = Math.max(hardFloor, ramped);
    aimCeiling = Math.max(aimCeiling, protectPpm);
    floored = "protecting_liquidity";
    const fact = protectFact;
    // (Short of protectPpm this move, it is "ramping toward" it — also when
    // another floor's lift set the move: "kept at 350 ppm or more" was false
    // there.)
    const toward = `${fact} — ramping toward ${protectPpm} ppm`;
    if (lifts) dominant(claim(ramped < protectPpm ? toward : `${fact} — modest bump`, fact, 1));
    else reasons.push(ramped < protectPpm ? claim(toward, fact, 1) : claim(`${fact} — kept at ${protectPpm} ppm or more`, fact));
  }

  // No routing → lower (the core volume-first safety): a channel that hasn't
  // routed in the benchmark window gets cheaper, toward minPpm, to win flow
  // back. Overrides the curve + floors (except new-channel protection) — the
  // opposite of a drain reflex. We never price-kill an idle channel. A channel
  // that keeps turning payments away is not idle (D20): no lowering.
  //
  // A drained one that still has sats to sell is lowered too (review FEE-1:
  // under 10 % local an idle channel was never raised — and never lowered
  // either: 350k sat stayed at 340 ppm for good beside buyers who paid 150).
  // Not in the move the step-back makes: that is this move's lowering, the
  // rule goes on from where it lands.
  //
  // How far down, and how fast, follows the balance (review FEE-7): at the
  // ratchet's pace to Min ppm only where the channel holds more than its
  // target — sats to spare, which a lower price may move. One at its target
  // or under it is lowered to the balanced level at that pace: at Min ppm the
  // first buyer took half a channel for a third of its price (2.45M at 25–40
  // ppm). Below the balanced level a channel at its target goes on one grid
  // step a week (buyers who pay less than the balanced level must still be
  // found — held there for good, a balanced channel whose buyers pay 35 never
  // sold again; a week a step, the first sale stops it within a step of
  // their price), and one under its target stays: what little it holds is
  // not discounted. A price with evidence behind it — the one that last won
  // routing back, the market's — is still taken at once, whatever the
  // balance.
  let noFlowLowering = false;
  let noFlowLine: string | null = null;
  let noFlowHoldLine: string | null = null;
  // The one-step-a-week lowering below the balanced level (its own pacing).
  let slowStep = false;
  const exploringBeforeNoFlow = exploring;
  const offTarget = ch.localRatio - targetLocalRatio;
  const spare = offTarget > cfg.deadband;
  const scarce = offTarget < -cfg.deadband;
  const balancedDest = Math.max(cfg.minPpm, Math.round(neutral / step) * step);
  const idleWithSats = idle && (ch.localRatio >= 0.1 || sellable >= stepBackSellableMin(cap)) && kind !== "step_back";
  const anchorAbove = ctx.flowAnchor != null && currentPpm > ctx.flowAnchor;
  const marketAbove = ctx.flowAnchor == null && competitivePpm != null && currentPpm > Math.max(cfg.minPpm, Math.round(competitivePpm / step) * step);
  if (idleWithSats && scarce && !anchorAbove && !marketAbove && currentPpm <= balancedDest) {
    // At the balanced level or under it, and under its target: neither
    // lowered (the curve's price for this balance is no lower) nor raised
    // (nothing sold here). One line, unless a hold already says why.
    if (target !== currentPpm) {
      const pct = Math.round(ch.localRatio * 100);
      noFlowHoldLine =
        target < currentPpm
          ? `hold: nothing routed here recently, and at ${pct}% local it holds less than its target — not lowered below the balanced level (${balancedDest} ppm)`
          : `hold: nothing routed here recently — an idle channel is not raised`;
      target = currentPpm;
      kind = "hold";
      dominant(noFlowHoldLine);
    }
    aim = currentPpm;
  } else if (idleWithSats) {
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
    } else if (spare) {
      // Below the anchor or the market (or no reference): slow stepping —
      // demand may have moved. (A fee below the min — 0, say — is brought up
      // to the min by the range rule, not to the balanced level.)
      lowered = currentPpm - lowerStep;
      dest = cfg.minPpm;
      kind = "ratchet";
      why = "no flow: nothing routed here recently — lowering toward min to win routing back";
    } else if (currentPpm > balancedDest) {
      // The same stepping, to the balanced level.
      lowered = Math.max(balancedDest, currentPpm - lowerStep);
      dest = balancedDest;
      kind = "ratchet";
      why = `no flow: nothing routed here recently — lowering toward the balanced level (${balancedDest} ppm): it holds no more than its target, so not down to min at this pace`;
    } else {
      // At its target, at the balanced level or under it: one grid step, a
      // week apart (the pacing guard below).
      lowered = Math.max(cfg.minPpm, currentPpm - step);
      dest = cfg.minPpm;
      kind = "ratchet";
      slowStep = true;
      why = `no flow: nothing routed here recently — it holds no more than its target, so below the balanced level (${balancedDest} ppm) it is lowered one step a week only`;
    }
    // Exactly the evidence's price, or exactly one ratchet step: the curve or
    // an explore price no longer cut an idle channel further in one move
    // (review: 1,500 → 900 ppm at 20% local; and a "dropping to 200 ppm" jump
    // that landed on the curve's 40).
    target = Math.max(cfg.minPpm, lowered);
    // At the min there is nothing to lower ("lowering toward min" was said
    // of a fee that stays; one below the min is the range rule's).
    if (currentPpm === cfg.minPpm) why = `no flow: nothing routed here recently — at your min of ${cfg.minPpm} ppm already, not lowered further`;
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
  // (Not the step-back: one move back to a price that sold.)
  if (!noFlowLowering && kind !== "step_back" && target < currentPpm - lowerStep) {
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
  // A move its step or its aim bounds stays inside that bound ON the grid
  // (review 2026-10-25: 820 → 989, 30 → 37 — fees off the "Round to" grid):
  // rounded down under a ceiling, up over a floor (a bound at the policy's
  // min or max is exact). What lands on a price of its own stays exact: a
  // jump to the price that won flow, a floor and its ramp, the range, the
  // step-back to a price that sold.
  const gridBound =
    kind === "raise_step" || kind === "free" || kind === "demand" || kind === "probe" || kind === "lower_step" || kind === "ratchet";
  const downOnGrid = (p: number) => (p >= cfg.maxPpm ? cfg.maxPpm : p <= cfg.minPpm ? cfg.minPpm : Math.floor(p / step) * step);
  // (A lowering down to a floor lands on the floor: 100 → 80, a new
  // channel's, on a 25-ppm grid — not back up to 100.)
  const floorAt = Math.max(hardFloor, aimFloor);
  const upOnGrid = (p: number) =>
    p <= cfg.minPpm ? cfg.minPpm : floorAt > 0 && p <= floorAt ? floorAt : p >= ceiling ? ceiling : Math.ceil(p / step) * step;
  if (targetPpm > hiLimit) targetPpm = gridBound ? downOnGrid(Math.floor(hiLimit)) : Math.floor(hiLimit);
  if (targetPpm < loLimit) targetPpm = gridBound ? upOnGrid(Math.ceil(loLimit)) : Math.ceil(loLimit);
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
    const hours = targetPpm <= floorRampTo ? (ctx.cooldown?.cooldownHours ?? 0) : Math.max(DEMAND_RAMP_HOURS, ctx.cooldown?.cooldownHours ?? 0);
    const onFloor = floorAhead > 0 && targetPpm === floorAhead ? ` (onto its ${floorAhead} ppm floor first)` : "";
    const move = targetPpm < aimPpm ? `${currentPpm}→${targetPpm}${onFloor} on the way to ${aimPpm} ppm` : `${currentPpm}→${targetPpm} ppm, its aim`;
    if (drainRamp) {
      // (Its own line says what the aim's note said: one of the two.)
      dropLine(drainAimLine);
      drainAimLine = null;
      const fact = `drain: ${drainFact()} (${n} sales ${soldSpan})`;
      const how =
        gapStep > Math.max(ordinaryStep, quarterStep)
          ? "a third of the way to its refill cost per move (never more than doubling the fee)"
          : "a quarter of the fee per move (at least two steps)";
      dominant(claim(`${fact} — raising ${how}, at most every ${hours} h: ${move}`, fact, 1));
    } else {
      const fact = `demand: drained (${localPct}% local) and sold ${n} time${n === 1 ? "" : "s"} at ${currentPpm} ppm since it was set`;
      dominant(claim(`${fact} — raising a quarter of the fee per move (at least two steps), at most every ${hours} h: ${move}`, fact, 1));
    }
  } else if (kind === "probe" && targetPpm > currentPpm) {
    const n = sold?.forwards ?? 0;
    const fact = `price test: it sells at ${currentPpm} ppm (${n} sales ${soldSpan}, ${weekSales} in the last 7 days) and holds no more than its target`;
    dominant(
      claim(
        `${fact} — trying ${targetPpm} ppm: taken back if nothing sells at it in ${STEP_BACK_AFTER_HOURS} h, or if it earns less in its first ${PROBE_JUDGE_AFTER_HOURS} h than the ${PROBE_JUDGE_AFTER_HOURS} h before it earned at ${currentPpm} ppm`,
        fact,
        1,
      ),
    );
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
          drainAimLine ??
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
    dropLine(unsoldLine);
    dropLine(noFlowHoldLine);
  }
  // (The step-back's memory: its hold, when the fee moved after all; its
  // cap, when a floor or the min took the fee past it.)
  if (backCapLine && (backCapAt <= currentPpm ? targetPpm !== currentPpm : targetPpm > backCapAt)) dropLine(backCapLine);
  if (targetPpm > currentPpm) dropLine(noFlowLine);
  // ("— holding" over a fee that moves: review FEE-8. The fact stays.)
  if (targetPpm !== currentPpm) {
    const at = reasons.indexOf(`${VELOCITY_BALANCED} — holding`);
    if (at >= 0) reasons[at] = VELOCITY_BALANCED;
  }
  // What the engine's rules claimed for their move no longer holds when a
  // pin, an exclusion or a lease promise set another one — nor a claimed
  // direction the fee doesn't take: only the facts stay.
  const moved = Math.sign(targetPpm - currentPpm);
  const replaced = targetPpm !== engineTargetPpm;
  for (let i = reasons.length - 1; i >= 0; i--) {
    const c = claims.get(reasons[i]);
    // (Held — for want of a sale, or by a hold of its own — a raise the rules
    // claimed didn't happen: no "small nudge up" beside a hold.)
    const withheld = (unsoldLine !== null || kind === "hold") && moved === 0 && c?.dir === 1;
    // (Nor a lowering, where a fee that sells was kept.)
    const kept = heldSelling && moved === 0 && c?.dir === -1;
    if (!c || !(replaced || withheld || kept || (c.dir !== 0 && moved === -c.dir))) continue;
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
  // Only once it has had its 30 days (review: six blocks after an open it
  // read "close candidate: idle with a weak peer — consider closing").
  else if (grossFlow30d < 0.005 && peerGate === "weak" && (ageDays == null || ageDays >= CLOSE_CANDIDATE_MIN_DAYS)) state = "close_candidate";
  else if (exploring) state = "exploring_lower_fee";
  if (state === "close_candidate") reasons.push("close candidate: idle with a weak peer — consider closing");

  // §11 apply guards (decide wouldApply only — never the target)
  const blockedByGuards: string[] = [];
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
  // (The step-back too: one move back to a price that sold, on evidence —
  // and the probe, a tenth of the fee by design.)
  const designedMove = noFlowLowering || outsideRange || kind === "step_back" || kind === "probe";
  // (A raise the step-back's memory bounds: the gap to the aim behind it.)
  const gapToAim = Math.max(
    Math.abs(aimPpm - currentPpm),
    isRaise && aimPastMemory !== null && targetPpm === engineTargetPpm ? Math.min(ceiling, aimPastMemory) - currentPpm : 0,
  );
  if (gapToAim < minDelta && !baseFeeChanged && !leaseCapBreach && !pinned && !designedMove) {
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
        : Math.max(slowStep ? SLOW_LOWER_PACING_HOURS : LOWER_PACING_HOURS, ctx.cooldown.cooldownHours);
      if (elapsedH < limitH)
        blockedByGuards.push(
          isRaise
            ? "raise cooldown active"
            : slowStep && limitH === SLOW_LOWER_PACING_HOURS
              ? "lower pacing (1/week below the balanced level)"
              : limitH > LOWER_PACING_HOURS
                ? `lower pacing (every ${Math.round(limitH)} h)`
                : "lower pacing (1/day)",
        );
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
    ...(kind === "step_back" && targetPpm < currentPpm && targetPpm === engineTargetPpm ? { stepBack: true, ...(probed || climbBack ? { probeBack: true } : {}) } : {}),
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
      provenLevel: ctx.provenLevel ?? null,
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
