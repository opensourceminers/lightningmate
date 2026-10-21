import { getChannels, getFeeRates, getPayment, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { JsonStore, recordStoreIncident } from "../store.js";
import { connectForOpen, fundChannel } from "./channelOps.js";
import { isAuthError } from "./amboss.js";
import { createOffer, getMyOffer, getMyOffers, toggleOffer, updateOffer, type MyOffer, type OfferTerms } from "./magmaApi.js";
import { MagmaDesk, type MagmaSellAction, type SellActionKind } from "./magmaDesk.js";
import { CapitalLedger, listableSat, spendableOnchain, type Spendable } from "./capital.js";
import {
  BLOCKS_PER_YEAR,
  DEFAULT_LEASE_BLOCKS,
  clearingFor,
  initMagmaHistory,
  priceFitsLease,
  refreshMagmaHistory,
  standardLeaseBlocks,
} from "./magmaHistory.js";
import { assessEligibility, cachedPublicBook, publicBook, publicBookFailure, type Eligibility } from "./magmaEligibility.js";
import type { LeaseBenchmark } from "./dashboard.js";
import { MagmaPurchases, type PaymentReport } from "./magmaPurchases.js";
import { getOrder } from "./amboss.js";
import { runMaxHtlcPass, type MaxHtlcChange } from "./maxHtlc.js";
import { saleFeeConfig, type ServiceFeeLedger } from "./serviceFee.js";
import type { AmbossStore } from "./ambossStore.js";
import { errorText } from "./errorText.js";
import { getOwnPubkey } from "./node.js";
import { getChannelSuggestionsV2 } from "./suggestRecommend.js";
import type { LnPlusStore } from "./lnplusStore.js";
import { getMagmaRecommendations, type MagmaV2Report } from "./magmaRecommend.js";
import { onchainCosts } from "./nodeEconomics.js";
import { getFeeElasticity } from "./outcomes.js";
import { DEFAULT_POLICY, applyFees, type FeeApplyItem, type FeeApplyResult } from "./fees.js";
import {
  MARKET_RUN_WAIT_MS,
  floorWindowStart,
  getFeeRecommendations,
  type CooldownInput,
  type FeeRecConfig,
  type FeeRecommendation,
} from "./feeRecommend.js";
import { FeeChangeLog, type FeeChangeRecord } from "./feeChangeLog.js";
import { getAlias } from "./aliases.js";
import { executeRebalance, type RebalanceExecOptions, type RebalanceExecParams, type RebalanceExecResult, type RefillHooks } from "./rebalance.js";
import {
  getRebalanceRecommendations,
  selectRebalanceRuns,
  type RebalanceRecConfig,
  type RebalanceRecReport,
  type RebalanceRecommendation,
} from "./rebalanceRecommend.js";
import { budgetDayOf, type RebalanceLog, type RebalanceRecord } from "./rebalanceLog.js";
import type { OverridesStore } from "./overrides.js";
import type { EarningsLog } from "./earningsLog.js";
import { getChannelsView } from "./channels.js";
import { getForwardsReport } from "./forwards.js";
import { activeCap, capText, offerFeeCaps, type OfferFeeCaps } from "./leaseCaps.js";
import { routingYieldStats } from "./capitalAllocator.js";
import {
  AUTOPILOT_CONFIG_BOUNDS,
  ConfigValidationError,
  DEFAULT_CONFIG,
  applyPatch,
  rebalanceWindowOpen,
  repairCrossFields,
  sanitizePersistedConfig,
  schedulerIntervalMs,
  validateAutopilotPatch,
  type AutopilotConfig,
} from "./autopilotConfig.js";

export type { AutopilotConfig } from "./autopilotConfig.js";
export { ConfigValidationError } from "./autopilotConfig.js";

/** A manual rebalance with nothing left of today's fee budget: refused
 *  before anything is paid (the API answers 409). */
export class RebalanceBudgetError extends Error {
  constructor(readonly budget: RebalanceBudget) {
    super(
      `today's rebalance fee budget is used up (${budget.spentSats.toLocaleString("en-US")} of ${(budget.budgetSats ?? 0).toLocaleString("en-US")} sat, ` +
        `manual runs included) — raise the daily budget on Autopilot → Rebalancing, or wait until 00:00 UTC`,
    );
    this.name = "RebalanceBudgetError";
  }
}

/** A rebalance payment that may still land, as the Rebalancing tab shows it:
 *  its two channels are left alone until LND says how it ended. */
export interface RefillInFlight {
  targetId: string;
  /** The target's peer alias. */
  alias: string;
  /** The channel it drains (absent on records from before this was kept). */
  sourceId?: string;
  sourceAlias?: string;
  amountSats: number;
  /** Charged to the budget of the day it was sent until it ends. */
  maxFeeSats: number;
  /** When it was sent. */
  at: string;
  via: "autopilot" | "manual";
}

/** A manual refill into or out of a channel whose earlier payment may still
 *  land: refused before anything is sent — the API answers 409. A second
 *  refill through that channel could move twice what was planned; the
 *  rebalance stage never sends one (payRefills), and a click on "Run it" no
 *  longer does either (review of P3). */
export class RefillInFlightError extends Error {
  constructor(
    readonly channelId: string,
    readonly payment: RefillInFlight,
  ) {
    const what =
      channelId === payment.targetId ? `A payment into ${payment.alias || channelId}` : `A payment out of ${payment.sourceAlias || channelId}`;
    super(
      `${what} is still in flight — LightningMate is waiting to learn how it ended (checked every ${INFLIGHT_REBALANCE_CHECK_MS / 60_000} minutes). ` +
        `Until then no other refill moves through that channel.`,
    );
    this.name = "RefillInFlightError";
  }
}

/** A fee item for a channel LND doesn't have at that outpoint (applyByHand):
 *  refused before anything is written — the API answers 400. */
export class FeeItemError extends Error {
  constructor(readonly problems: string[]) {
    super(`fee items don't match the node's channels: ${problems.join("; ")}`);
    this.name = "FeeItemError";
  }
}

export interface AutopilotChange {
  id: string;
  alias: string;
  fromPpm: number;
  toPpm: number;
  /** Base fee before and after (msat), when the write set it. */
  fromBaseMsat?: number;
  toBaseMsat?: number;
  /** Why: the engine's main reason (every change is explained in the run
   *  history), or the lease promise kept, or "set by hand". */
  why?: string;
  /** Who wrote it (absent: the fee autopilot, on older runs too). */
  via?: "autopilot" | "lease" | "manual";
  /** A sold channel's lease promise lowered what was asked for. */
  clampedBy?: string;
  ok: boolean;
  error?: string;
}

/** A fee write with what the books need about it (writeFees). */
type FeeWrite = FeeApplyItem & {
  alias: string;
  fromPpm: number;
  fromBaseMsat: number | null;
  why?: string;
  /** A no-flow lowering: opens the flow-won episode (flowAnchors). */
  noFlowLowering?: boolean;
  /** It fixes a broken lease promise: retried at every chance, whatever
   *  failed before. */
  leaseBreach?: boolean;
};

/** What the engine recommends for a channel, as a write. Its "why" is the
 *  engine's leading reason — the rule that set the move. */
function recommendationWrite(r: FeeRecommendation): FeeWrite {
  return {
    id: r.channelId,
    transactionId: r.transactionId as string,
    transactionVout: r.transactionVout as number,
    feeRatePpm: r.targetPpm,
    // The engine's base fee (volume-first: 0), never the current one.
    baseFeeMsat: r.recommendedBaseMsat,
    alias: r.alias,
    fromPpm: r.currentPpm,
    fromBaseMsat: typeof r.currentBaseMsat === "number" ? r.currentBaseMsat : null,
    ...(r.reasons?.[0] ? { why: r.reasons[0] } : {}),
    noFlowLowering: r.noFlowLowering,
    leaseBreach: r.leaseCapBreach === true,
  };
}

export interface AutopilotRebalance {
  alias: string;
  amountSats: number;
  feeSats: number | null;
  costPpm: number | null;
  ok: boolean;
  error?: string;
}

export interface AutopilotChannelOpen {
  alias: string;
  sizeSats: number;
  ok: boolean;
  transactionId?: string;
  error?: string;
}

/** One Magma action (order lane or offer upkeep) as the run history shows it. */
export type AutopilotSell = MagmaSellAction;

export interface AutopilotRun {
  at: string;
  attempted: number;
  applied: number;
  failed: number;
  changes: AutopilotChange[];
  rebalances: AutopilotRebalance[];
  channels: AutopilotChannelOpen[];
  sells: AutopilotSell[];
  /** Advertised-max_htlc bucket moves (present on newer runs only). */
  maxHtlc?: MaxHtlcChange[];
  /** Stages that threw. Each stage is isolated: one failing (say the fee
   *  engine) no longer skips the others, Magma offer upkeep included. */
  errors?: { stage: string; error: string }[];
}

/** An offer's terms as Amboss has them, or as the engine wants them. */
export interface OfferFields {
  status: string;
  minSizeSats: number;
  maxSizeSats: number;
  totalSizeSats: number;
  availableSats: number;
  feeRatePpm: number;
  baseFeeSats: number;
  minBlockLength: number;
  /** The routing-fee promise for the lease (null: none). */
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
}

/**
 * Who decides what about an offer (a6-ux: manual controls were silently
 * undone — a manual "disable" re-enabled within half an hour, a manual edit
 * repriced or resized at the next run). Two separate things:
 *  - its TERMS: an offer the operator created or edited on Market → Sell (or
 *    took over) is theirs — the autopilot changes none of its terms until the
 *    operator hands it back ("Let the autopilot manage it");
 *  - whether it is LISTED: the operator's last click decides. One they
 *    disabled stays disabled; one they enabled is listed. The only status
 *    the autopilot changes is capital safety's: an offer whose smallest
 *    channel can't be funded is disabled — whoever owns its terms — and
 *    listed again once it can be, since listing it was the last thing the
 *    operator chose. A status click never takes the terms over: before, a
 *    manual ENABLE made the offer "yours", so the autopilot stopped fixing its
 *    lease and promise — and never listed it again after a capital dip.
 * The cut capital safety makes is given back up to the owner's own terms.
 */
export interface OfferControl {
  /** The operator took the offer's terms over: when, and by doing what. */
  manual?: { since: string; why: string };
  /** The autopilot disabled it because its smallest channel couldn't be
   *  funded — the only disabled offer it enables again once it can be. */
  autoDisabledAt?: string;
  /** The autopilot sent that disable, and Amboss's answer hasn't told yet
   *  whether it landed (written before the flip): the next read of the
   *  offer decides — DISABLED, and it was the autopilot's (autoDisabledAt). */
  autoDisablingAt?: string;
  /** The operator disabled it by hand: it stays disabled until they enable it. */
  disabledByHandAt?: string;
}

/** The last write to an offer (autopilot or manual) and what came of it. */
export interface OfferWrite {
  at: string;
  by: "autopilot" | "manual";
  action: "create" | "update" | "enable" | "disable";
  /** The fields sent, as Amboss names them. */
  fields: Record<string, number | string>;
  ok: boolean;
  error?: string;
  /** Re-read afterwards: did Amboss really store what was sent? */
  verified?: boolean;
  reason?: string;
}

/** What the engine wants for an offer vs what Amboss has (m3: no silent offer
 *  management — a failing write must be visible, not "managed"). */
export interface OfferSyncEntry {
  offerId: string;
  checkedAt: string;
  amboss: OfferFields;
  /** Null when the autopilot does not manage this offer's terms. */
  wanted: OfferFields | null;
  inSync: boolean;
  differences: string[];
  lastWrite: OfferWrite | null;
  /** Who owns the offer's terms (OfferControl): the operator took it over
   *  (manual), and/or the autopilot disabled it for lack of capital. */
  control?: OfferControl;
}

export interface OfferSyncStatus {
  /** Last time the autopilot compared its wishes with Amboss. */
  at: string | null;
  /** Liquidity provision on: the autopilot manages the offers. */
  managed: boolean;
  offers: OfferSyncEntry[];
  /** The last time offer upkeep itself failed (Amboss unreachable, …). */
  lastError: { at: string; message: string } | null;
}

/**
 * What a capital cut took from an offer, so it is given back once capital
 * returns. Before, the clamp only ever shrank: one dip (an accepted order's
 * reservation, an LSPS1 order, a pending open) rewrote the operator's max and
 * total for good. `set` is what the cut wrote; when Amboss shows anything
 * else, the offer was changed since (by the operator, or a sale shrank the
 * total) and that part is no longer ours to give back.
 */
interface OfferCut {
  /** The max channel before the cut, and the max the cut wrote. */
  max?: { wish: number; set: number };
  /** The listed liquidity the cut took away, and the total it wrote. */
  listed?: { cutSats: number; setTotal: number };
  at: string;
}

/**
 * A rebalance payment that may still land: recorded (and saved) BEFORE it is
 * sent — so a restart or a crash while it is under way can't lose it — and
 * kept until LND says how it ended (reconcilePendingRebalances), or until it
 * ends while this process is still waiting on it.
 */
interface PendingRebalance {
  id: string;
  targetId: string;
  /** The channel it drains (absent on records from before this was kept). */
  sourceId?: string;
  /** The target's peer alias … */
  alias: string;
  /** … and the source's (absent on records from before this was kept). */
  sourceAlias?: string;
  amountSats: number;
  maxFeeSats: number;
  /** The budget day its maximum fee was charged to: the day it was sent. */
  day: string;
  /** When it was sent (its log record's startedAt). */
  at: string;
  /** Who started it. A manual one (Rebalance tab) is tracked the same way,
   *  so the log shows how it really ended; both count toward the daily
   *  budget at their maximum fee until then. Absent = autopilot (older
   *  records). */
  via?: "autopilot" | "manual";
  /** The target's "sent" counter before it, and what the gate valued it at
   *  (a refill that passed the gate — the autopilot's, or one run by hand
   *  with it): the log record gets them once it lands. */
  targetSentBefore?: number;
  holdPpm?: number;
}

interface PersistedState {
  config: AutopilotConfig;
  lastRunAt: string | null;
  perChannelLastApplied: Record<string, string>;
  perTargetLastRebalanced: Record<string, string>;
  lastChannelOpenAt: string | null;
  lastSellRepriceAt: string | null;
  /** Adaptive Magma pricing state (mode "auto"): the current 0..1 price level and
   *  the fill bookkeeping that ratchets it up (sells fast) or down (sits unsold). */
  sellAdaptiveLevel: number;
  lastSellFilledCount: number;
  lastSellFillAt: string | null;
  /** One-shot repair of levels the removed downward ratchet drove to the floor. */
  adaptiveRatchetMigrated?: boolean;
  /** One-shot: derived sellAutoSize for upgraded installs (see constructor). */
  sellAutoSizeMigrated?: boolean;
  lastSellAdaptiveAdjustAt: string | null;
  /** One-time flag: bumped installs from the old 60-min default to 30 min. */
  intervalMigrated?: boolean;
  /** One-time flag: lowered the old aggressive fee ceiling (2000 → 1000 ppm). */
  feePolicyMigrated?: boolean;
  /** One-time flag: volume-first nudge — competitive floor + zero base fee. */
  feeVolumeMigrated?: boolean;
  /** One-time flag: pins stored outside the policy's min/max were rewritten
   *  to the fee the engine really gave them (see migrateOutOfRangePins). */
  pinRangeMigrated?: boolean;
  /** Flow-won price memory per channel: an open no-flow lowering episode
   *  (episodeAt) and/or the ppm at which routing last returned (anchor). */
  perChannelFlowAnchor?: Record<string, { episodeAt?: string; anchorPpm?: number; anchorAt?: string }>;
  /** Consecutive failed rebalances per target, from before the back-off was
   *  kept per source and target (P3): still honoured until the target's next
   *  success, never added to. */
  perTargetRebalanceFails?: Record<string, number>;
  /** Failed refills per source → target pair ("src>tgt"): that pair backs
   *  off (cooldown × 2^fails, at most ×8); the target's other sources don't
   *  (review a2: one dead route blocked the target for days). */
  perPairRebalanceFails?: Record<string, { fails: number; at: string }>;
  /** Rebalance payments still in flight when we stopped waiting. */
  pendingRebalances?: PendingRebalance[];
  /** Offer sync status (engine's wishes vs Amboss), see OfferSyncStatus. */
  offerSync?: OfferSyncStatus;
  /** Per offer: what a capital cut took, to give back (see OfferCut). */
  offerCuts?: Record<string, OfferCut>;
  /** Per offer: who owns its terms (see OfferControl). */
  offerControl?: Record<string, OfferControl>;
  /** Per area: the latest decision not to act, and why (decisionNote). */
  decisions?: Partial<Record<DecisionArea, { at: string; text: string }>>;
  history: AutopilotRun[];
}

/** The areas with a "last decision" status (D16; the full status is P7's). */
type DecisionArea = "magma" | "channels" | "rebalance";

/** Today's rebalance fee budget (UTC day): what was spent — every fee paid,
 *  the autopilot's and manual refills alike, and the maximum fee of every
 *  payment still in flight — and what is left. */
export interface RebalanceBudget {
  day: string;
  /** null: the operator chose no daily limit. */
  budgetSats: number | null;
  spentSats: number;
  /** The part of spentSats that is payments still in flight (at their max fee). */
  inFlightSats: number;
  leftSats: number | null;
  /** When the next day's budget starts (00:00 UTC). */
  resetsAt: string;
}

const HISTORY_LIMIT = 50;
/** The Magma order lane's cadence (D4): independent of the main run. */
export const ORDER_LANE_INTERVAL_MS = 45_000;
/** How often the routing-fee promises of sold channels are checked (D7) —
 *  whatever the autopilot switches say (keepLeasePromisesNow). */
export const LEASE_PROMISE_CHECK_MS = 10 * 60_000;
/** After a fee update on a channel failed (LND refused it, or it couldn't be
 *  sent), the autopilot leaves that channel's fee alone this long — a broken
 *  lease promise excepted (writeFees). */
export const FEE_RETRY_BACKOFF_MS = 6 * 3_600_000;
/** How often rebalance payments still in flight are asked about between
 *  runs — also with every automation off (a manual one must end on record). */
export const INFLIGHT_REBALANCE_CHECK_MS = 2 * 60_000;
const floor10k = (n: number): number => Math.max(0, Math.floor(n / 10_000) * 10_000);
/** Readable for LND's array errors too: stage errors reach the run history. */
const errText = errorText;
/** How long the Overview's lease benchmark looks at a public-book fetch it
 *  had to start (nothing cached yet) before it answers "being read". */
export const BENCHMARK_WAIT_MS = 750;
/** How many purchase reads run at once. (No cap per pass: every purchase
 *  still followed converges to an end — LND confirms or never knew the
 *  payment, Amboss ends the order — so the set empties; a cap only starved
 *  the oldest ones.) */
const PURCHASE_FOLLOW_PARALLEL = 3;

/** `fn` over `items`, at most `parallel` at a time; one that throws is
 *  skipped (asked again next pass), and none starts once `stop()` says so. */
async function eachBounded<T>(items: T[], parallel: number, stop: () => boolean, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !stop()) {
      const item = items[next++];
      try {
        await fn(item);
      } catch {
        // can't say right now: the next pass asks again
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker));
}

/** `p`'s value if it settles within `ms`, else null (p keeps running). The
 *  timer is unref'd: waiting never keeps the process alive on its own. */
function withinMs<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** What one offer-upkeep pass may advertise, and the engine's wishes. */
interface OfferCtx {
  /** Largest single channel that can be funded now (and within the caps),
   *  for an offer whose smallest channel is `minSizeSats`. */
  maxOrder: (minSizeSats: number) => number;
  /** Most liquidity such an offer may list at once: whatever orders buy it
   *  out, each one's open (with its own fee and anchor-reserve step) can be
   *  funded (capital.ts listableSat), within the deploy cap's headroom. */
  listable: (minSizeSats: number) => number;
  /** The engine's price for the offer, and the lease that price is for
   *  (magmaRecommend.ts prices each offer for the lease it carries after the
   *  autopilot's next write). */
  target: (off: MyOffer) => { fee: number; base: number; moved: boolean; lease: number } | null;
  /** A sane size window (auto-size): null when the current one is fine. */
  reshape: (off: MyOffer) => { minSizeSats: number; maxSizeSats: number } | null;
  /** The standard lease the offer should promise (auto-size), or null. */
  lease: (off: MyOffer) => number | null;
  /** The routing-fee promise (D7): every offer the autopilot creates carries
   *  it, and auto-size gives it to every offer it manages. */
  caps: { feeRateCapPpm: number; baseFeeCapSats: number };
}

/** The capital side of OfferCtx, from one spendable reading. */
function sellable(sp: Spendable, headroomSat: number, maxChannelSats: number): Pick<OfferCtx, "maxOrder" | "listable"> {
  const listable = (minSizeSats: number) => floor10k(Math.min(listableSat(sp, minSizeSats), headroomSat));
  return { listable, maxOrder: (minSizeSats: number) => floor10k(Math.min(listable(minSizeSats), maxChannelSats)) };
}

const fmtSat = (n: number): string => Math.round(n).toLocaleString("en-US");

/**
 * The status capital safety wants for an offer now, or null for none:
 *  - disabled while its smallest channel can't be funded — whoever owns its
 *    terms (an order it couldn't serve would end in a reject, or worse, a
 *    failed open);
 *  - enabled again once it can be, only when the autopilot itself disabled it
 *    for that reason (it restores the listing the operator chose) — never one
 *    the operator disabled. (Before, every DISABLED offer was re-enabled within
 *    the half hour, a manual "disable" included.)
 */
function capitalStatus(status: string, fundable: boolean, control: OfferControl): "ENABLED" | "DISABLED" | null {
  if (status === "ENABLED" && !fundable) return "DISABLED";
  if (status === "DISABLED" && fundable && !!control.autoDisabledAt && !control.disabledByHandAt) return "ENABLED";
  return null;
}

const fieldsOf = (o: MyOffer): OfferFields => ({
  status: o.status,
  minSizeSats: o.minSizeSats,
  maxSizeSats: o.maxSizeSats,
  totalSizeSats: o.totalSizeSats,
  availableSats: o.availableSats,
  feeRatePpm: o.feeRatePpm,
  baseFeeSats: o.baseFeeSats,
  minBlockLength: o.minBlockLength,
  feeRateCapPpm: o.feeRateCapPpm,
  baseFeeCapSats: o.baseFeeCapSats,
});

const emptyFields = (): OfferFields => ({
  status: "UNKNOWN",
  minSizeSats: 0,
  maxSizeSats: 0,
  totalSizeSats: 0,
  availableSats: 0,
  feeRatePpm: 0,
  baseFeeSats: 0,
  minBlockLength: 0,
  feeRateCapPpm: null,
  baseFeeCapSats: null,
});

const FIELD_LABEL: Record<Exclude<keyof OfferFields, "totalSizeSats">, string> = {
  status: "status",
  minSizeSats: "min channel (sat)",
  maxSizeSats: "max channel (sat)",
  availableSats: "listed liquidity (sat)",
  feeRatePpm: "fee rate (ppm)",
  baseFeeSats: "base fee (sat)",
  minBlockLength: "min lease (blocks)",
  feeRateCapPpm: "routing fee-rate cap (ppm)",
  baseFeeCapSats: "routing base-fee cap (sat)",
};

/** Human-readable mismatches between what Amboss has and what is wanted.
 *  (The total follows from listed + locked, so it is not compared itself.) */
function offerDifferences(have: OfferFields, want: OfferFields | null): string[] {
  if (!want) return [];
  return (Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[])
    .filter((k) => have[k] !== want[k])
    .map((k) => `${FIELD_LABEL[k]}: Amboss has ${have[k]}, wanted ${want[k]}`);
}

/** The fields to send to bring `have` to `want` (null = nothing to change). */
function termsUpdate(have: MyOffer, want: OfferFields): Partial<OfferTerms> | null {
  const p: Partial<OfferTerms> = {};
  if (want.feeRatePpm !== have.feeRatePpm) p.feeRatePpm = want.feeRatePpm;
  if (want.baseFeeSats !== have.baseFeeSats) p.baseFeeSats = want.baseFeeSats;
  if (want.minSizeSats !== have.minSizeSats) p.minSizeSats = want.minSizeSats;
  if (want.maxSizeSats !== have.maxSizeSats) p.maxSizeSats = want.maxSizeSats;
  if (want.minBlockLength !== have.minBlockLength) p.minBlockLength = want.minBlockLength;
  if (want.totalSizeSats !== have.totalSizeSats) p.totalSizeSats = want.totalSizeSats;
  if (want.feeRateCapPpm !== null && want.feeRateCapPpm !== have.feeRateCapPpm) p.feeRateCapPpm = want.feeRateCapPpm;
  if (want.baseFeeCapSats !== null && want.baseFeeCapSats !== have.baseFeeCapSats) p.baseFeeCapSats = want.baseFeeCapSats;
  return Object.keys(p).length > 0 ? p : null;
}

/** Did Amboss store every field that was sent? */
export function termsMatch(read: MyOffer, sent: Partial<OfferTerms>): boolean {
  return (
    (sent.feeRatePpm === undefined || read.feeRatePpm === sent.feeRatePpm) &&
    (sent.baseFeeSats === undefined || read.baseFeeSats === sent.baseFeeSats) &&
    (sent.minSizeSats === undefined || read.minSizeSats === sent.minSizeSats) &&
    (sent.maxSizeSats === undefined || read.maxSizeSats === sent.maxSizeSats) &&
    (sent.minBlockLength === undefined || read.minBlockLength === sent.minBlockLength) &&
    (sent.totalSizeSats === undefined || read.totalSizeSats === sent.totalSizeSats) &&
    (sent.feeRateCapPpm === undefined || read.feeRateCapPpm === sent.feeRateCapPpm) &&
    (sent.baseFeeCapSats === undefined || read.baseFeeCapSats === sent.baseFeeCapSats)
  );
}

/** Offer fields under the names Amboss uses (for the write record). */
export function ambossFields(p: Partial<OfferTerms>): Record<string, number> {
  const out: Record<string, number> = {};
  if (p.totalSizeSats !== undefined) out.total_size = p.totalSizeSats;
  if (p.minSizeSats !== undefined) out.min_size = p.minSizeSats;
  if (p.maxSizeSats !== undefined) out.max_size = p.maxSizeSats;
  if (p.feeRatePpm !== undefined) out.fee_rate = p.feeRatePpm;
  if (p.baseFeeSats !== undefined) out.base_fee = p.baseFeeSats;
  if (p.minBlockLength !== undefined) out.min_block_length = p.minBlockLength;
  if (p.feeRateCapPpm !== undefined) out.fee_rate_cap = p.feeRateCapPpm;
  if (p.baseFeeCapSats !== undefined) out.base_fee_cap = p.baseFeeCapSats;
  return out;
}

export class Autopilot {
  private readonly dataDir: string;
  private readonly store: JsonStore<PersistedState>;
  private state: PersistedState;
  private timer: NodeJS.Timeout | undefined;
  /** The Magma order lane (every 45 s) — its own timer and its own busy flag,
   *  never the main run's: a slow rebalance payment or Amboss call in the
   *  main run must not delay a buyer's order (D4). */
  private laneTimer: NodeJS.Timeout | undefined;
  /** Asks about rebalance payments still in flight between runs (see
   *  checkInFlightRebalances) — runs whenever writing is possible. */
  private inflightTimer: NodeJS.Timeout | undefined;
  /** Keeps sold channels within their routing-fee promise (D7) every
   *  LEASE_PROMISE_CHECK_MS, whatever the switches say. */
  private leaseTimer: NodeJS.Timeout | undefined;
  /** max_htlc updates LND refused, per channel (runMaxHtlcPass backs off). */
  private readonly maxHtlcBackoff = new Map<string, number>();
  /** Fee updates that failed, per channel: not retried before `until` (the
   *  engine's guard, via feeCooldown), and the failure — the same one again
   *  is not news for the run history (writeFees). In memory: a restart
   *  tries once more. */
  private readonly feeRetry = new Map<string, { until: number; error: string }>();
  /** Every applied fee change (D15) — what fee outcomes and the elasticity
   *  learner measure; never the run history. */
  readonly feeLog: FeeChangeLog;
  /** The reconciliation of in-flight rebalances under way, if any: the timer
   *  and a main run share it instead of booking the same payment twice. */
  private reconciling: Promise<void> | null = null;
  /** A refill's payments are under way — the rebalance stage's or a manual
   *  one. Its own lock, not the main run's: a manual refill (up to the
   *  150 s hard limit) no longer holds back fees, lease promises, channel
   *  opens or Magma upkeep, and the two can't both pass the budget check. */
  private refilling = false;
  /** Refill payments this process is waiting on right now (their
   *  pendingRebalances entries are write-ahead records, not yet the
   *  reconciliation's to book). */
  private readonly sendingRefills = new Set<string>();
  /** One-shot "run soon after enabling" kicks — tracked so stop() clears them. */
  private readonly kickTimers = new Set<NodeJS.Timeout>();
  /** Per order, the last failed lane action written to the run history —
   *  the same failure again is not news (laneNews). */
  private readonly laneLast = new Map<string, string>();
  private running = false;
  /** When the current main run took its lock (null when idle) — exposed so a
   *  run that takes unusually long is visible, not just a stale lastRunAt. */
  private runningSince: string | null = null;
  /** Set by shutdown(): no new run may start, the process is going away. */
  private shuttingDown = false;
  /** The on-chain budget shared with Magma fulfilment and LSPS1 (capital.ts):
   *  one mutex for every open, persisted reservations for promised orders. */
  readonly capital: CapitalLedger;
  /** Magma selling: order journal, lane and manual actions (magmaDesk.ts). */
  readonly magma: MagmaDesk;
  /** Inbound bought on Magma (magmaPurchases.ts): followed after each order
   *  lane pass (followPurchases). */
  readonly purchases: MagmaPurchases;
  /** A purchase follow-up is under way (its own flag, not the lane's). */
  private followingPurchases = false;
  /** Per offer: the status change under way (withOffer). */
  private readonly offerChains = new Map<string, Promise<void>>();
  /** Whether the stored fee policy carried a balanced level of its own. Policies
   *  saved before that setting existed get the default from the volume
   *  migration in start() — after sanitizing, a filled-in default can no longer
   *  be told apart from a stored value, hence the flag. */
  private readonly policyHadNeutral: boolean;

  constructor(
    dataDir: string,
    private readonly readLnd: AuthenticatedLnd,
    private readonly writeLnd: AuthenticatedLnd | undefined,
    private readonly rebalanceLog: RebalanceLog,
    private readonly overrides: OverridesStore,
    private readonly amboss: AmbossStore,
    /** Completed Magma sales are booked here and their service fee enqueued
     *  (paid in the background) — by the order desk, once a sale settles. */
    earnings: EarningsLog,
    serviceFees: ServiceFeeLedger,
    /** LN+ reputation cache — optional; without it peer picking is graph-only. */
    private readonly lnplus?: LnPlusStore,
    /** Shared with LSPS1 (index.ts). A private one when not given (tests). */
    capital?: CapitalLedger,
  ) {
    this.dataDir = dataDir;
    this.store = new JsonStore<PersistedState>(dataDir, "autopilot.json");
    this.capital = capital ?? new CapitalLedger();
    this.magma = new MagmaDesk({
      dataDir,
      readLnd,
      writeLnd,
      amboss,
      capital: this.capital,
      earnings,
      serviceFees,
      config: () => {
        const c = this.state.config;
        return {
          sellEnabled: c.sellEnabled,
          sellMaxChannelSats: c.sellMaxChannelSats,
          sellMaxDeploySats: c.sellMaxDeploySats,
          sellReserveSats: c.sellReserveSats,
        };
      },
    });
    initMagmaHistory(dataDir);
    this.purchases = new MagmaPurchases(dataDir);
    this.feeLog = new FeeChangeLog(dataDir);
    this.state = this.store.read({
      config: DEFAULT_CONFIG,
      lastRunAt: null,
      perChannelLastApplied: {},
      perTargetLastRebalanced: {},
      lastChannelOpenAt: null,
      lastSellRepriceAt: null,
      sellAdaptiveLevel: 0.5,
      lastSellFilledCount: 0,
      lastSellFillAt: null,
      lastSellAdaptiveAdjustAt: null,
      history: [],
    });
    // Must be read BEFORE the defaults are merged in below. Otherwise every
    // upgraded install looks as if it had already chosen a value — which is
    // exactly the bug 0.7.6 shipped: the default `true` landed first, the
    // migration further down never fired, and upgrading switched auto-sizing on
    // for operators who had deliberately left auto-pricing off.
    const persistedHadAutoSize = Object.prototype.hasOwnProperty.call(
      this.state.config ?? {},
      "sellAutoSize",
    );
    const storedPolicy = (this.state.config as { policy?: { neutralPpm?: unknown } | null } | undefined)?.policy;
    this.policyHadNeutral = storedPolicy?.neutralPpm != null;
    // Merge in newly added defaults AND bring every stored value into range:
    // older versions saved whatever the API was sent (a 40,000-min interval,
    // "false" as a string, policy: null). Clamp what can be clamped, default
    // what can't, and say so in the log.
    const { config, repairs } = sanitizePersistedConfig(this.state.config);
    this.state.config = config;
    this.reportRepairs(repairs);
    this.state.history = Array.isArray(this.state.history) ? this.state.history : [];
    // Upgrading to the fee-change log: the fee changes still in the run
    // history move into it (once), so what was measurable stays measurable.
    this.feeLog.seed(
      this.state.history.flatMap((run) =>
        (run.changes ?? [])
          .filter((c) => c.ok && typeof c.fromPpm === "number" && typeof c.toPpm === "number")
          .map(
            (c): FeeChangeRecord => ({
              at: run.at,
              channelId: c.id,
              alias: c.alias,
              fromPpm: c.fromPpm,
              toPpm: c.toPpm,
              fromBaseMsat: c.fromBaseMsat ?? null,
              toBaseMsat: c.toBaseMsat ?? null,
              via: c.via ?? "autopilot",
              ...(c.why ? { why: c.why } : {}),
            }),
          ),
      ),
    );
    this.state.perChannelLastApplied ??= {};
    this.state.perTargetLastRebalanced ??= {};
    // Today's rebalance spend is read from the rebalance log now
    // (rebalanceBudget) — the separate counter is gone.
    delete (this.state as { perDayRebalanceSpend?: unknown }).perDayRebalanceSpend;
    // Sizing used to ride along with auto-pricing. Upgrading must keep exactly
    // the behaviour an install had, so one-shot:
    //   - config from before the switch existed: inherit auto-pricing's value;
    //   - config written by 0.7.6, whose broken migration forced sizing ON even
    //     with pricing OFF: undo that, and ONLY in that direction. The repair may
    //     switch automation off, never on, so it cannot overturn an operator who
    //     deliberately turned sizing off.
    // Persisted immediately so a restart cannot re-derive it after the operator
    // has since made an explicit choice.
    if (!this.state.sellAutoSizeMigrated) {
      const c = this.state.config;
      if (!persistedHadAutoSize) c.sellAutoSize = c.sellAutoReprice;
      else if (c.sellAutoSize && !c.sellAutoReprice) c.sellAutoSize = false;
      this.state.sellAutoSizeMigrated = true;
      this.store.write(this.state);
    } else if (repairs.length > 0) {
      this.store.write(this.state);
    }
    this.state.sellAdaptiveLevel ??= 0.5;
    // One-time repair: the removed downward ratchet left long-running installs at
    // a level near 0, i.e. priced at the very bottom of the ladder. Nothing about
    // that level was earned by evidence, so lift anything below the midpoint back
    // to it and let real fills move it up from there.
    if (!this.state.adaptiveRatchetMigrated) {
      if (this.state.sellAdaptiveLevel < 0.5) this.state.sellAdaptiveLevel = 0.5;
      this.state.adaptiveRatchetMigrated = true;
    }
    this.state.lastSellFilledCount ??= 0;
    this.state.lastSellFillAt ??= null;
    this.state.lastSellAdaptiveAdjustAt ??= null;
  }

  /** Whether writing to the node is possible at all. */
  get canWrite(): boolean {
    return !!this.writeLnd;
  }

  /** Cooldown view for the fee-recommendation dry-run (read-only) — with the
   *  channels whose last fee update failed and when they are tried again. */
  feeCooldown(): CooldownInput {
    const now = Date.now();
    const retryAfter: Record<string, string> = {};
    for (const [id, r] of this.feeRetry) if (r.until > now) retryAfter[id] = new Date(r.until).toISOString();
    return {
      lastApplied: this.state.perChannelLastApplied,
      cooldownHours: this.state.config.cooldownMinutes / 60,
      retryAfter,
    };
  }

  /** Map the autopilot's existing policy onto the v2 engine, so v2 honours the
   *  user's own min/max/step/anti-churn caps instead of its wider defaults. */
  feeV2Overrides(): Partial<FeeRecConfig> {
    const p = this.state.config.policy;
    return {
      minPpm: p.minPpm,
      maxPpm: p.maxPpm,
      // Only override when set — an old persisted policy lacks these newer fields
      // and we must not clobber the engine defaults with undefined.
      ...(p.neutralPpm != null ? { neutralPpm: p.neutralPpm } : {}),
      ...(p.protectPpm != null ? { protectPpm: p.protectPpm } : {}),
      ...(p.safetyMargin != null ? { safetyMargin: p.safetyMargin } : {}),
      ...(p.noFlowRatchetSteps != null ? { noFlowRatchetSteps: p.noFlowRatchetSteps } : {}),
      ...(p.exploreLowerModifier != null ? { exploreLowerModifier: p.exploreLowerModifier } : {}),
      baseFeeMsat: p.baseFeeMsat,
      stepPpm: p.step,
      minChangePpm: p.minChangePpm,
      maxChangesPerRun: this.state.config.maxChangesPerRun,
      floorAboveMax: this.state.config.feeFloorAboveMax === true,
    };
  }

  /** Non-stale flow-won prices (channelId → ppm at which routing last returned
   *  after a no-flow lowering) for the fee engine. Demand shifts, so anchors
   *  older than 60 days are ignored. */
  flowAnchors(): Map<string, number> {
    const out = new Map<string, number>();
    const cutoff = Date.now() - 60 * 86_400_000;
    for (const [id, s] of Object.entries(this.state.perChannelFlowAnchor ?? {})) {
      if (s.anchorPpm != null && s.anchorAt && new Date(s.anchorAt).getTime() >= cutoff) {
        out.set(id, s.anchorPpm);
      }
    }
    return out;
  }

  /** Map the user's rebalance settings onto the recommender's gate: every
   *  one of them binds (review a2: three settings on the tab reached
   *  nothing). econRatio is "spend up to this share of what refilled
   *  liquidity earns" — the gate's profitShare. */
  rebalanceRecOverrides(): Pick<RebalanceRecConfig, "profitShare" | "minExpectedNetProfitSats" | "maxPaybackDays" | "maxRebalanceAmountPerChannel"> {
    const p = this.state.config.rebalancePolicy;
    return {
      profitShare: p.econRatio,
      minExpectedNetProfitSats: p.minNetProfitSats,
      maxPaybackDays: p.maxPaybackDays,
      maxRebalanceAmountPerChannel: p.maxAmountSats,
    };
  }

  /** Magma pricing the recommendations should reflect — the configured mode + the
   *  live adaptive level — so the UI shows what the autopilot is actually doing. */
  /** What the engine needs to mirror the autopilot's actual behaviour: the price
   *  level AND the capital caps, so the recommended size window can never exceed
   *  what the autopilot would really be willing to serve. Without the caps the
   *  Market page would advertise a size the autopilot then silently refuses. */
  /**
   * The ONE place the Magma engine's inputs are built — the Market page, the
   * autopilot's own offer upkeep and LSPS1 pricing all call the engine with
   * exactly these. (The autopilot used to pass only the pricing level: it
   * priced and sized with the engine's defaults — a 250k reserve, a 10M max —
   * while the page used the operator's caps, so it could refuse to list an
   * offer the page recommended.)
   */
  magmaOverrides(): {
    sellPricingMode: "fast" | "balanced" | "premium" | "auto";
    adaptiveLevel: number;
    maxSellSizeSat: number;
    onchainReserveSat: number;
    offerFeeCaps: OfferFeeCaps;
    autoSizeLease: boolean;
    operatorOfferIds: string[];
  } {
    const c = this.state.config;
    return {
      sellPricingMode: c.sellPricingMode,
      adaptiveLevel: this.state.sellAdaptiveLevel,
      // A channel bigger than the whole deploy budget can never be served, so the
      // effective ceiling is the smaller of the two.
      maxSellSizeSat: Math.max(0, Math.min(c.sellMaxChannelSats, c.sellMaxDeploySats)),
      onchainReserveSat: c.sellReserveSats,
      offerFeeCaps: this.offerFeeCaps(),
      // Which lease each offer is priced for: the one it carries after the
      // offer upkeep's next write. With auto-size (and Liquidity provision)
      // that is the standard lease for every offer whose terms aren't the
      // operator's; otherwise the lease the offer keeps.
      autoSizeLease: c.sellEnabled && c.sellAutoSize,
      operatorOfferIds: Object.entries(this.state.offerControl ?? {})
        .filter(([, control]) => !!control.manual)
        .map(([id]) => id),
    };
  }

  /** The routing-fee promise every offer of this node carries (D7, see
   *  leaseCaps.ts) — from the fee policy, so the fee autopilot never has to
   *  break it in normal operation. */
  offerFeeCaps(): OfferFeeCaps {
    return offerFeeCaps(this.state.config.policy);
  }

  /** Sell caps shared with LSP mode — one capital budget across both demand sources. */
  sellCaps(): { maxChannelSats: number; reserveSats: number; maxDeploySats: number } {
    return {
      maxChannelSats: this.state.config.sellMaxChannelSats,
      reserveSats: this.state.config.sellReserveSats,
      maxDeploySats: this.state.config.sellMaxDeploySats,
    };
  }

  /** A completed LSPS1 sale, surfaced as a run-history entry so it shows up in
   *  the history and the Overview digest like any other capital action. */
  recordExternalSell(orderId: string, sizeSats: number, transactionId: string): void {
    this.state.history.unshift({
      at: new Date().toISOString(),
      attempted: 1,
      applied: 1,
      failed: 0,
      changes: [],
      rebalances: [],
      channels: [],
      sells: [{ orderId: `lsps1:${orderId}`, action: "open", sizeSats, ok: true, transactionId }],
    });
    this.state.history = this.state.history.slice(0, HISTORY_LIMIT);
    this.persist();
  }

  /** Per-channel learned fee elasticity modifiers — measured from the
   *  fee-change log (D15), never the run history; only channels whose
   *  evidence passes the learner's gate (outcomes.ts) get one. */
  async feeElasticityModifiers(): Promise<Map<string, number>> {
    try {
      const el = await getFeeElasticity(this.readLnd, this.feeLog.all());
      return new Map([...el].map(([id, e]) => [id, e.modifier]));
    } catch {
      return new Map();
    }
  }

  /** Every applied fee change (for the outcomes report). */
  feeChanges(): FeeChangeRecord[] {
    return this.feeLog.all();
  }

  /** Public, serializable view for the API. */
  getState() {
    return {
      canWrite: this.canWrite,
      config: this.state.config,
      /** Allowed range of every numeric setting — the UI mirrors these. */
      bounds: AUTOPILOT_CONFIG_BOUNDS,
      lastRunAt: this.state.lastRunAt,
      /** The main run in progress, if any: since when. */
      runningSince: this.runningSince,
      /** The Magma order lane: when it last ran, and whether that worked. */
      magmaLane: this.magma.laneStatus(),
      /** Per area, the latest decision not to act and why. */
      decisions: this.state.decisions ?? {},
      /** Today's rebalance fee budget — autopilot and manual runs together. */
      rebalanceBudget: this.rebalanceBudget(),
      // Only surface runs that did something; hide any older "0 applied" no-ops.
      // Normalise older persisted runs that predate newer arrays.
      history: this.state.history
        .filter((r) => (r.attempted ?? 0) > 0)
        .slice(0, 20)
        .map((r) => ({
          ...r,
          changes: r.changes ?? [],
          rebalances: r.rebalances ?? [],
          channels: r.channels ?? [],
          sells: r.sells ?? [],
          maxHtlc: r.maxHtlc ?? [],
        })),
    };
  }

  /** Begin scheduling if enabled and writing is possible. */
  start(): void {
    // One-time: move installs still on the old 60-min default onto the new 30-min
    // default. Deliberate non-default intervals are left untouched.
    if (!this.state.intervalMigrated) {
      if (this.state.config.intervalMinutes === 60) this.state.config.intervalMinutes = 30;
      this.state.intervalMigrated = true;
      this.persist();
    }
    // One-time: lower the old aggressive fee ceiling so the volume-first engine
    // isn't capped by a stale 2000 ppm policy from before the rework.
    if (!this.state.feePolicyMigrated) {
      if (this.state.config.policy.maxPpm >= 2000) this.state.config.policy.maxPpm = 1000;
      this.state.feePolicyMigrated = true;
      this.persist();
    }
    // One-time: bias existing installs toward volume — a competitive fee floor and
    // a zero base fee (base fee deters LND path-finding the most). Only nudges
    // stale high defaults down; a user who set something lower is left alone.
    if (!this.state.feeVolumeMigrated) {
      const p = this.state.config.policy;
      if (p.minPpm >= 50) p.minPpm = 25;
      if (p.baseFeeMsat >= 1000) p.baseFeeMsat = 0;
      // A policy from before the balanced level existed gets the default one,
      // as it always did. Sanitizing already filled it in, but clamped to the
      // OLD floor (the default may sit below a floor this migration just lowered).
      if (!this.policyHadNeutral) p.neutralPpm = DEFAULT_POLICY.neutralPpm;
      // (The newer behaviour knobs and a missing daily budget are filled with
      // their defaults by sanitizePersistedConfig; a null budget now means an
      // explicit "no limit".)
      this.state.feeVolumeMigrated = true;
      this.persist();
    }
    // The migrations above move the fee range on their own and can leave the
    // balanced level outside it — which would make every later save that
    // touches the fee range fail. Repair, say so, and keep it.
    const repairs = repairCrossFields(this.state.config);
    this.reportRepairs(repairs);
    if (repairs.length > 0) this.persist();
    // After the policy's own migrations: a pin is checked against the range
    // the engine would have clamped it to.
    this.migrateOutOfRangePins();
    this.reschedule();
    this.startOrderLane();
  }

  /**
   * The Magma order lane runs whenever writing is possible — not only while
   * selling is on: an order this node already took on (a held payment) must
   * always end settled or refunded. Idle passes cost nothing (no key, or
   * selling off and nothing in flight: no network call at all).
   */
  private startOrderLane(): void {
    if (this.laneTimer || this.shuttingDown || !this.canWrite) return;
    this.laneTimer = setInterval(() => void this.pollSellOrders(), ORDER_LANE_INTERVAL_MS);
    // A restart picks up orders in flight right away.
    this.kick(() => this.pollSellOrders(), 5_000);
    // Rebalance payments still in flight end on record even with every
    // automation off — a manual one would otherwise wait for a main run that
    // never comes. Idle checks cost nothing (no payment pending: no call).
    this.inflightTimer = setInterval(() => void this.checkInFlightRebalances(), INFLIGHT_REBALANCE_CHECK_MS);
    this.inflightTimer.unref?.();
    // The routing-fee promises of sold channels (D7) are kept whatever the
    // switches say: with every automation off no main run is scheduled at
    // all, and a sale's channel (LSPS1, a Magma order accepted by hand or
    // before selling was switched off) kept a fee above its promise for the
    // whole lease. Idle checks cost nothing (no promise: no call).
    this.leaseTimer = setInterval(() => void this.keepLeasePromisesNow(), LEASE_PROMISE_CHECK_MS);
    this.leaseTimer.unref?.();
  }

  /** Settings adjusted on load are logged AND raised as an alert that stays
   *  until acknowledged: a repair can switch a feature off, and the operator
   *  must learn why from the UI, not from container logs. */
  private reportRepairs(repairs: string[]): void {
    if (repairs.length === 0) return;
    for (const r of repairs) console.warn(`[autopilot] settings repaired — ${r}`);
    recordStoreIncident(this.dataDir, { file: "autopilot.json", kind: "adjusted", detail: repairs.join("; ") });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.kickTimers) clearTimeout(t);
    this.kickTimers.clear();
    this.timer = undefined;
  }

  /** Process shutdown: stop scheduling for good. A run or order-lane pass
   *  already in progress starts no further payment, channel open or Magma
   *  order step — the one under way finishes (see waitIdle) — and nothing new
   *  starts. */
  shutdown(): void {
    this.shuttingDown = true;
    this.magma.stop();
    if (this.laneTimer) clearInterval(this.laneTimer);
    this.laneTimer = undefined;
    if (this.inflightTimer) clearInterval(this.inflightTimer);
    this.inflightTimer = undefined;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    this.stop();
  }

  /** True while the main run holds its lock. */
  isRunning(): boolean {
    return this.running;
  }

  /** Resolves once nothing is in progress — no main run, no refill (a manual
   *  one included), no order-lane pass or manual Magma action, nobody holding
   *  the on-chain mutex — or after `timeoutMs` (false). Every step under way
   *  has a recorded state by then (a refill payment from before it was sent). */
  async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running || this.refilling || this.magma.isBusy() || this.capital.mutex.busy || this.reconciling) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  }

  /** Write the current state now (shutdown flush). */
  flush(): void {
    this.persist();
  }

  /**
   * Apply a settings update. The patch is validated against the bounds in
   * autopilotConfig.ts; an invalid value throws ConfigValidationError (the API
   * answers 400) and NOTHING is changed.
   */
  setConfig(raw: unknown): void {
    const result = validateAutopilotPatch(raw, this.state.config);
    if (!result.ok) throw new ConfigValidationError(result.errors);
    this.state.config = applyPatch(this.state.config, result.patch);
    if (!this.canWrite) {
      // Refuse to "enable" anything when we have no write macaroon.
      this.state.config.enabled = false;
      this.state.config.rebalanceEnabled = false;
      this.state.config.channelEnabled = false;
      this.state.config.maxHtlcEnabled = false;
    }
    this.persist();
    this.reschedule();
  }

  private kick(fn: () => Promise<unknown>, delayMs: number): void {
    const t = setTimeout(() => {
      this.kickTimers.delete(t);
      void fn();
    }, delayMs);
    this.kickTimers.add(t);
  }

  private reschedule(): void {
    this.stop();
    if (this.shuttingDown) return;
    const { enabled, rebalanceEnabled, channelEnabled, sellEnabled, maxHtlcEnabled } = this.state.config;
    if ((!enabled && !rebalanceEnabled && !channelEnabled && !sellEnabled && !maxHtlcEnabled) || !this.canWrite) return;
    // Clamped again here, whatever reached the config: Node turns any delay
    // above 2^31-1 ms into 1 ms, i.e. a back-to-back loop.
    this.timer = setInterval(() => void this.runOnce(), schedulerIntervalMs(this.state.config.intervalMinutes));
    // Kick off one run shortly after enabling, without blocking.
    this.kick(() => this.runOnce(), 2_000);
    // Selling just switched on: the order lane looks for orders right away
    // (its own 45 s timer runs from start(), see startOrderLane).
    if (sellEnabled) this.kick(() => this.pollSellOrders(), 5_000);
  }

  /** A target is refilled at most once per cooldown, whatever the outcome
   *  (no hammering a dead route) — longer while a count from before the
   *  per-pair back-off still stands. */
  private rebalanceCooldownOk(targetId: string, cooldownMin: number): boolean {
    const last = this.state.perTargetLastRebalanced[targetId];
    if (!last) return true;
    const fails = this.state.perTargetRebalanceFails?.[targetId] ?? 0;
    const mult = Math.min(8, 2 ** fails);
    return (Date.now() - new Date(last).getTime()) / 60_000 >= cooldownMin * mult;
  }

  /** A source → target pair whose refills failed waits cooldown × 2^fails
   *  (1× → 2× → 4× → 8×) — that pair only: the target's other sources are
   *  tried meanwhile. A success clears it. */
  private pairBackingOff(sourceId: string, targetId: string, cooldownMin: number): boolean {
    const p = this.state.perPairRebalanceFails?.[`${sourceId}>${targetId}`];
    if (!p) return false;
    const mult = Math.min(8, 2 ** p.fails);
    return (Date.now() - Date.parse(p.at)) / 60_000 < cooldownMin * mult;
  }

  /** The books after a refill attempt (the autopilot's or a manual one):
   *  every failed pair backs off, the paying pair (and the target's old
   *  count) is cleared. */
  private notePairs(targetId: string, res: Pick<RebalanceExecResult, "ok" | "sourceId" | "failedSourceIds" | "inFlight">): void {
    const pairs = (this.state.perPairRebalanceFails ??= {});
    const nowIso = new Date().toISOString();
    // (A failure that names no source failed from the one it reports; a
    // payment still in flight is no failure — not yet. A refill the shutdown
    // stopped names the sources that failed before it: only those.)
    for (const src of res.failedSourceIds ?? (res.ok || res.inFlight ? [] : [res.sourceId])) {
      const key = `${src}>${targetId}`;
      pairs[key] = { fails: Math.min(3, (pairs[key]?.fails ?? 0) + 1), at: nowIso };
    }
    if (res.ok) {
      delete pairs[`${res.sourceId}>${targetId}`];
      delete this.state.perTargetRebalanceFails?.[targetId];
    }
  }

  /**
   * Today's rebalance fee budget, read from the books themselves: every fee
   * the rebalance log holds for today (UTC — the autopilot's refills and
   * manual ones), plus the maximum fee of every payment still in flight that
   * was sent today. Before, a separate counter carried it: it was lost when
   * a later stage threw or the process restarted before the next save, and a
   * manual run never counted (review a2).
   */
  rebalanceBudget(nowMs = Date.now()): RebalanceBudget {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const paid = this.rebalanceLog
      .successes(dayStart)
      .filter((r) => budgetDayOf(r) === day)
      .reduce((sum, r) => sum + (r.feeSats ?? 0), 0);
    const inFlightSats = (this.state.pendingRebalances ?? []).filter((p) => p.day === day).reduce((sum, p) => sum + p.maxFeeSats, 0);
    const spentSats = paid + inFlightSats;
    const budgetSats = this.state.config.rebalanceDailyBudgetSats;
    return {
      day,
      budgetSats,
      spentSats,
      inFlightSats,
      leftSats: budgetSats === null ? null : Math.max(0, budgetSats - spentSats),
      resetsAt: new Date(dayStart + 86_400_000).toISOString(),
    };
  }

  /** Compute and apply eligible fee changes. */
  private async runFees(writeLnd: AuthenticatedLnd): Promise<AutopilotChange[]> {
    this.migrateOutOfRangePins();
    // v2 engine — wouldApply already folds in the relative/absolute threshold,
    // cooldown, the retry back-off and max-changes-per-run, so we just apply
    // the eligible ones.
    const elasticity = await this.feeElasticityModifiers();
    // (The scheduled run may wait for the first graph read after a restart;
    // a manual Apply waits no longer than a page does.)
    const report = await this.feeReport(elasticity, MARKET_RUN_WAIT_MS);
    this.noteFlowReturns(report.recommendations);
    const eligible = report.recommendations.filter(
      (r) => r.wouldApply && r.transactionId !== null && r.transactionVout !== null,
    );
    return this.writeFees(writeLnd, eligible.map((r) => recommendationWrite(r)), "autopilot", { quietRepeats: true });
  }

  /**
   * One-shot, on upgrading to pins that apply exactly as set (P2). Before,
   * the engine rounded a pin to the policy's step and clamped it to its
   * min/max — and the old pin inputs saved a blank field as 0. A pin stored
   * outside that range would now be written as stored, at once: a 0-ppm pin
   * would let the channel forward for free, one of 2,000 jump past the max.
   * Each such pin is rewritten to the fee the engine really gave it, and the
   * operator is told (an alert that stays until acknowledged). Pins inside
   * the range, and every pin saved after the upgrade, are left exactly as set.
   */
  private migrateOutOfRangePins(): void {
    if (this.state.pinRangeMigrated) return;
    const p = this.state.config.policy;
    const step = Math.max(1, p.step);
    const adjusted: string[] = [];
    for (const [id, ov] of Object.entries(this.overrides.all())) {
      if (ov.mode !== "fixed" || typeof ov.fixedPpm !== "number" || !Number.isFinite(ov.fixedPpm)) continue;
      if (ov.fixedPpm >= p.minPpm && ov.fixedPpm <= p.maxPpm) continue;
      // Exactly what the engine applied for it so far.
      const applied = Math.min(p.maxPpm, Math.max(p.minPpm, Math.round(ov.fixedPpm / step) * step));
      this.overrides.set(id, { mode: "fixed", fixedPpm: applied });
      adjusted.push(`${id} pinned at ${ov.fixedPpm} ppm is now pinned at ${applied} ppm, the fee it was given so far (pins now apply exactly as set)`);
    }
    this.state.pinRangeMigrated = true;
    this.persist();
    if (adjusted.length === 0) return;
    for (const a of adjusted) console.warn(`[autopilot] fee pin adjusted — ${a}`);
    recordStoreIncident(this.dataDir, { file: "overrides.json", kind: "adjusted", detail: adjusted.join("; ") });
  }

  /**
   * Flow-anchor bookkeeping: a channel in an open no-flow episode that routed
   * out again did so at its CURRENT fee — remember that price as its anchor
   * (the next no-flow episode jumps straight there instead of blind stepping).
   * Episodes with no outbound flow for 45 days are abandoned (peer is dead —
   * the close-candidate path handles it, an anchor would be meaningless).
   */
  private noteFlowReturns(recs: Pick<FeeRecommendation, "channelId" | "currentPpm" | "metrics">[]): void {
    const fa = (this.state.perChannelFlowAnchor ??= {});
    const nowIso = new Date().toISOString();
    for (const r of recs) {
      const s = fa[r.channelId];
      if (!s?.episodeAt) continue;
      if (r.metrics.routedOut14d > 0) {
        s.anchorPpm = r.currentPpm;
        s.anchorAt = nowIso;
        delete s.episodeAt;
      } else if (Date.now() - new Date(s.episodeAt).getTime() > 45 * 86_400_000) {
        delete s.episodeAt;
      }
    }
  }

  /**
   * Every fee write goes through here — the autopilot's, the lease-promise
   * keeper's and a manual apply alike — so the books always match what LND
   * has (review a1: a manual Apply stamped no cooldown and wrote no history,
   * so the autopilot stepped the same channel again on its next run and the
   * outcome tracker never saw the change). Clamped to sold channels' lease
   * promises at the last gate (feeApply). Only what LND took counts: the
   * cooldown, the no-flow episode, the fee-change log. Saved at once:
   * cooldowns protect against gossip spam only if a crash in a later stage
   * can't lose them.
   *
   * A write that failed (LND refused it, or it couldn't be sent) is not
   * retried for FEE_RETRY_BACKOFF_MS — the engine's guard holds the channel —
   * and says so; a broken lease promise is retried at every chance. Before,
   * an update LND kept refusing was resent every run, each a failed line in
   * the run history (~48 a day: the 50-line history held one day). With
   * `quietRepeats` (the autopilot's own passes) the same failure again on a
   * channel is left out of the result, i.e. the run history: the first one
   * is on record, and the Fees tab shows the channel held.
   */
  private async writeFees(
    writeLnd: AuthenticatedLnd,
    writes: FeeWrite[],
    via: NonNullable<AutopilotChange["via"]>,
    opts: { quietRepeats?: boolean } = {},
  ): Promise<AutopilotChange[]> {
    if (writes.length === 0) return [];
    const results = await this.feeApply(
      writeLnd,
      writes.map(({ id, transactionId, transactionVout, feeRatePpm, baseFeeMsat }) => ({ id, transactionId, transactionVout, feeRatePpm, baseFeeMsat })),
    );
    const byId = new Map(writes.map((w) => [w.id, w]));
    const fa = (this.state.perChannelFlowAnchor ??= {});
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const logged: FeeChangeRecord[] = [];
    const changes: AutopilotChange[] = [];
    for (const res of results as FeeApplyResult[]) {
      const w = byId.get(res.id);
      const toBaseMsat = res.baseFeeMsat ?? w?.baseFeeMsat;
      const why = w?.why;
      let error = res.error;
      if (res.ok) {
        this.feeRetry.delete(res.id);
        this.state.perChannelLastApplied[res.id] = nowIso;
        // Applied a no-flow lowering → open (or refresh) the flow-won episode.
        if (w?.noFlowLowering) fa[res.id] = { ...fa[res.id], episodeAt: nowIso };
        logged.push({
          at: nowIso,
          channelId: res.id,
          alias: w?.alias ?? res.id,
          fromPpm: w?.fromPpm ?? 0,
          toPpm: res.feeRatePpm,
          fromBaseMsat: w?.fromBaseMsat ?? null,
          toBaseMsat: toBaseMsat ?? null,
          via,
          ...(why || res.clampedBy ? { why: [why, res.clampedBy].filter(Boolean).join("; ") } : {}),
        });
      } else {
        const raw = res.error ?? "failed";
        const repeat = this.feeRetry.get(res.id)?.error === raw;
        this.feeRetry.set(res.id, { until: nowMs + FEE_RETRY_BACKOFF_MS, error: raw });
        if (repeat && opts.quietRepeats) continue;
        if (!w?.leaseBreach) error = `${raw} — not retried for ${Math.round(FEE_RETRY_BACKOFF_MS / 3_600_000)} h`;
      }
      changes.push({
        id: res.id,
        alias: w?.alias ?? res.id,
        fromPpm: w?.fromPpm ?? 0,
        toPpm: res.feeRatePpm,
        ...(w?.fromBaseMsat != null ? { fromBaseMsat: w.fromBaseMsat } : {}),
        ...(toBaseMsat != null ? { toBaseMsat } : {}),
        ...(why ? { why } : {}),
        via,
        ...(res.clampedBy ? { clampedBy: res.clampedBy } : {}),
        ok: res.ok,
        ...(res.ok ? {} : { error }),
      });
    }
    this.feeLog.append(logged);
    this.persist();
    return changes;
  }

  /**
   * The fees that break a sold channel's routing-fee promise (D7), read
   * straight from LND — what to write to keep it: each lowered to the cap its
   * order locked, nothing else. Cheap (no forwards, no graph), so it can run
   * every LEASE_PROMISE_CHECK_MS.
   */
  private async leaseBreaches(): Promise<FeeWrite[]> {
    const caps = this.capital.leaseCaps();
    if (caps.length === 0) return [];
    const [{ channels }, rates, wallet] = await Promise.all([
      getChannels({ lnd: this.readLnd }),
      getFeeRates({ lnd: this.readLnd }),
      getWalletInfo({ lnd: this.readLnd }),
    ]);
    const peerOf = new Map(channels.map((c) => [c.id, c.partner_public_key]));
    const out: FeeWrite[] = [];
    for (const r of rates.channels) {
      const cap = activeCap(caps, { outpoint: `${r.transaction_id}:${r.transaction_vout}`, channelId: r.id }, wallet.current_block_height);
      if (!cap) continue;
      const base = Number(r.base_fee_mtokens);
      if (r.fee_rate <= cap.feeRateCapPpm && base <= cap.baseFeeCapMsat) continue;
      const peer = peerOf.get(r.id);
      out.push({
        id: r.id,
        transactionId: r.transaction_id,
        transactionVout: r.transaction_vout,
        // Only ever lowered: a channel whose base fee alone breaks the
        // promise keeps its rate (min), it is not raised to the cap.
        feeRatePpm: Math.min(r.fee_rate, cap.feeRateCapPpm),
        baseFeeMsat: Math.min(base, cap.baseFeeCapMsat),
        alias: peer ? await getAlias(this.readLnd, peer) : r.id,
        fromPpm: r.fee_rate,
        fromBaseMsat: base,
        why: `lease promise: ${capText(cap)} — its fee (${r.fee_rate} ppm, ${base} msat base) was above that`,
        leaseBreach: true,
      });
    }
    return out;
  }

  /**
   * Fee automation off (or every switch off): lower the fees that break a
   * sold channel's promise to the cap its order locked — nothing else.
   */
  private async keepLeasePromises(writeLnd: AuthenticatedLnd): Promise<AutopilotChange[]> {
    return this.writeFees(writeLnd, await this.leaseBreaches(), "lease", { quietRepeats: true });
  }

  /**
   * The lease-promise check of the timer (every LEASE_PROMISE_CHECK_MS, from
   * start-up, whatever the switches say): skipped while the main run holds
   * its lock (its own stages keep the promises), and holding it while it
   * writes. Only ever lowers a breaching fee to its cap; a write is recorded
   * in the run history like any other.
   */
  async keepLeasePromisesNow(): Promise<AutopilotChange[]> {
    if (this.shuttingDown || this.running || !this.writeLnd) return [];
    if (this.capital.leaseCaps().length === 0) return [];
    this.running = true;
    try {
      const changes = await this.keepLeasePromises(this.writeLnd);
      if (changes.length) this.recordRun({ changes });
      return changes;
    } catch (err) {
      console.warn(`[autopilot] keeping lease promises: ${errText(err)}`);
      return [];
    } finally {
      this.running = false;
    }
  }

  /**
   * "Apply" on the Fees tab: what the engine recommends, through the same
   * path as the autopilot's own changes — the recommended target AND base
   * fee (the page sent the CURRENT base fee, so a base-fee-only row never
   * changed), the cooldown stamped, the run history and the fee-change log
   * written. Recomputed here, so a stale page applies nothing the engine no
   * longer wants. `channelIds`: the rows the operator saw (all when absent).
   * Null when the main run holds the lock (the caller says "try again").
   */
  async applyRecommended(channelIds?: string[]): Promise<AutopilotChange[] | null> {
    if (!this.writeLnd) throw new Error("writing is disabled");
    if (this.running || this.shuttingDown) return null;
    this.running = true;
    try {
      this.migrateOutOfRangePins();
      const report = await this.feeReport(await this.feeElasticityModifiers());
      this.noteFlowReturns(report.recommendations);
      const wanted = channelIds ? new Set(channelIds) : null;
      const eligible = report.recommendations.filter(
        (r) => r.wouldApply && r.transactionId !== null && r.transactionVout !== null && (!wanted || wanted.has(r.channelId)),
      );
      const changes = await this.writeFees(this.writeLnd, eligible.map((r) => recommendationWrite(r)), "manual");
      if (changes.length) this.recordRun({ changes });
      return changes;
    } finally {
      this.running = false;
      this.persist();
    }
  }

  /**
   * A fee set by hand (POST /fees/apply): written as asked — clamped to a
   * sold channel's promise — and kept on the books like every other write.
   * Null when the main run holds the lock.
   *
   * Every item's channel is resolved from LND by its funding outpoint first,
   * and an item whose id is not the channel at that outpoint is refused
   * (FeeItemError, the API answers 400) before anything is written. The
   * client's id is what the books key on — the lease clamp's funding height,
   * the cooldown, the fee-change log, the retry back-off — so a sold
   * channel's outpoint sent with an older channel's id was written past its
   * lease promise and booked on the wrong channel (P2 final review).
   */
  async applyByHand(items: FeeApplyItem[]): Promise<{ changes: AutopilotChange[]; results: FeeApplyResult[] } | null> {
    if (!this.writeLnd) throw new Error("writing is disabled");
    if (this.running || this.shuttingDown) return null;
    this.running = true;
    try {
      // What each channel charges now (the "from" of the record) and whose
      // it is — read once. The channel list must be read: it is how each
      // item is checked (no list, no write).
      const [rates, chans] = await Promise.all([
        getFeeRates({ lnd: this.readLnd }).catch(() => ({ channels: [] as { id: string; fee_rate: number; base_fee_mtokens: string }[] })),
        getChannels({ lnd: this.readLnd }),
      ]);
      const atOutpoint = new Map(chans.channels.map((c) => [`${c.transaction_id}:${c.transaction_vout}`, c.id]));
      const mismatched = items.flatMap((it) => {
        const outpoint = `${it.transactionId}:${it.transactionVout}`;
        const id = atOutpoint.get(outpoint);
        if (id === undefined) return [`${outpoint}: no open channel has this funding outpoint`];
        return id === it.id ? [] : [`${it.id}: the channel at ${outpoint} is ${id}`];
      });
      if (mismatched.length) throw new FeeItemError(mismatched);
      const now = new Map(rates.channels.map((c) => [c.id, c]));
      const peerOf = new Map(chans.channels.map((c) => [c.id, c.partner_public_key]));
      const writes: FeeWrite[] = [];
      for (const it of items) {
        const peer = peerOf.get(it.id);
        const rate = now.get(it.id);
        writes.push({
          ...it,
          alias: peer ? await getAlias(this.readLnd, peer) : it.id,
          fromPpm: rate?.fee_rate ?? 0,
          fromBaseMsat: rate ? Number(rate.base_fee_mtokens) : null,
          why: "set by hand",
        });
      }
      const changes = await this.writeFees(this.writeLnd, writes, "manual");
      if (changes.length) this.recordRun({ changes });
      const results: FeeApplyResult[] = changes.map((c) => ({
        id: c.id,
        ok: c.ok,
        feeRatePpm: c.toPpm,
        ...(c.toBaseMsat != null ? { baseFeeMsat: c.toBaseMsat } : {}),
        ...(c.clampedBy ? { clampedBy: c.clampedBy } : {}),
        ...(c.error ? { error: c.error } : {}),
      }));
      return { changes, results };
    } finally {
      this.running = false;
    }
  }

  /** A run-history line for work done outside the main run (lease keeper,
   *  manual applies). Not lastRunAt: that is the main run's. */
  private recordRun(part: Partial<Pick<AutopilotRun, "changes">>): void {
    const changes = part.changes ?? [];
    this.state.history.unshift({
      at: new Date().toISOString(),
      attempted: changes.length,
      applied: changes.filter((c) => c.ok).length,
      failed: changes.filter((c) => !c.ok).length,
      changes,
      rebalances: [],
      channels: [],
      sells: [],
    });
    this.state.history = this.state.history.slice(0, HISTORY_LIMIT);
    this.persist();
  }

  /** Within the configured rebalance hour window (UTC — the budget's day is
   *  UTC too; the container's clock is UTC unless TZ is set)? */
  private inRebalanceWindow(): boolean {
    const { rebalanceHourStart: s, rebalanceHourEnd: e } = this.state.config;
    return rebalanceWindowOpen(s, e, new Date().getUTCHours());
  }

  /** The sources a planned refill may pull from, in order: those whose route
   *  didn't fail the probe, not busy with a payment in flight, and whose pair
   *  with this target isn't backing off. */
  private refillSources(r: RebalanceRecommendation, inFlight: Set<string>, cooldownMin: number): { id: string; keepRatio?: number }[] {
    const listed = r.sourceCandidates?.length
      ? r.sourceCandidates.filter((c) => !c.rejected).map((c) => ({ id: c.channelId, keepRatio: c.keepRatio }))
      : r.selectedSourceChannel
        ? [{ id: r.selectedSourceChannel }]
        : [];
    return listed.filter((s) => !inFlight.has(s.id) && !this.pairBackingOff(s.id, r.channelId, cooldownMin));
  }

  /**
   * Execute eligible (profitable, off-cooldown) refills, best first, within
   * today's fee budget. Each payment's max fee is the profit gate's own cap
   * at its size and never more than the budget left (review a2: the payment
   * could pay more than the gate allowed and overshoot the budget by its
   * whole cap). Moves the budget or the per-run limit leave for later are
   * NOT failed runs (D15): they go into the rebalance decision note, not the
   * run history — before, each was a red "✗" every 30 minutes until the day
   * rolled over, flushing the 50-run history. It holds the refill lock: a
   * manual refill and this stage never pay side by side (both would pass the
   * budget check); while a manual one is under way, the stage waits for the
   * next run and the rest of the run goes on.
   */
  private async runRebalances(writeLnd: AuthenticatedLnd): Promise<AutopilotRebalance[]> {
    const { rebalanceHourStart, rebalanceHourEnd } = this.state.config;
    if (!this.inRebalanceWindow()) {
      this.decisionNote("rebalance", `outside the rebalance hours (${rebalanceHourStart}–${rebalanceHourEnd} UTC) — no refills now`);
      return [];
    }
    if (this.refilling) {
      this.decisionNote("rebalance", "a manual refill is under way — the autopilot's refills wait for the next run");
      return [];
    }
    this.refilling = true;
    try {
      return await this.payRefills(writeLnd);
    } finally {
      this.refilling = false;
    }
  }

  /** The rebalance stage's planning and payments (runRebalances holds the
   *  refill lock around it). */
  private async payRefills(writeLnd: AuthenticatedLnd): Promise<AutopilotRebalance[]> {
    const { rebalancePolicy, maxRebalancesPerRun, rebalanceCooldownMinutes } = this.state.config;
    // (Payments we stopped waiting for were reconciled at the start of the
    // run, so the budget below already counts what they really cost.)
    const budget = this.rebalanceBudget();
    const dailyBudget = budget.budgetSats === null ? Number.POSITIVE_INFINITY : budget.budgetSats;
    // A channel with a payment still in flight is left alone, target or
    // source: once its cooldown is over, a second rebalance of it could start
    // while the first may still land — moving twice what was planned.
    const inFlight = new Set((this.state.pendingRebalances ?? []).flatMap((p) => [p.targetId, ...(p.sourceId ? [p.sourceId] : [])]));
    const report = await this.rebalanceReport();
    const profitable = report.recommendations.filter((r) => r.wouldRebalance && r.recommendedAmount);
    const waiting: string[] = [];
    const eligible: { r: RebalanceRecommendation; sources: { id: string; keepRatio?: number }[] }[] = [];
    for (const r of profitable) {
      if (inFlight.has(r.channelId)) {
        waiting.push(`${r.alias}: a payment into it is still in flight`);
        continue;
      }
      if (!this.rebalanceCooldownOk(r.channelId, rebalanceCooldownMinutes)) {
        waiting.push(`${r.alias}: refilled or tried within its cooldown`);
        continue;
      }
      const sources = this.refillSources(r, inFlight, rebalanceCooldownMinutes);
      if (sources.length === 0) {
        waiting.push(`${r.alias}: every source is busy or backing off after failed attempts`);
        continue;
      }
      eligible.push({ r, sources });
    }
    const sourcesOf = new Map(eligible.map((e) => [e.r, e.sources]));
    // Pure planner: order by profitability, then walk the list until the
    // per-run limit is filled with moves that fit the budget left.
    const plan = selectRebalanceRuns(
      eligible.map((e) => e.r),
      { dailyBudgetSats: dailyBudget, alreadySpentSats: budget.spentSats, maxPerRun: maxRebalancesPerRun },
    );
    const budgetSkips = plan.skipped.map((s) => `${s.rec.alias} (~${s.rec.estimatedRouteFeeSats ?? 0} sat)`);
    const out: AutopilotRebalance[] = [];

    for (const r of plan.run) {
      // Shutdown: the payment already under way finishes (it is being awaited
      // right here); none of the moves planned after it starts.
      if (this.shuttingDown) {
        waiting.push(`${r.alias}: skipped, shutting down`);
        continue;
      }
      // Actual-spend backstop: an earlier move's real fee may exceed its
      // estimate. A move whose estimate no longer fits what is left waits
      // for tomorrow — it is not sent with a starved fee cap (which would
      // fail, and back the pair off for a budget reason).
      const live = this.rebalanceBudget();
      if (live.leftSats !== null && (live.leftSats <= 0 || live.leftSats < (r.estimatedRouteFeeSats ?? 0))) {
        budgetSkips.push(`${r.alias} (~${r.estimatedRouteFeeSats ?? 0} sat)`);
        continue;
      }
      // (A payment of this run left in flight takes its channels out too.)
      const sources = (sourcesOf.get(r) ?? []).filter((s) => !inFlight.has(s.id));
      if (inFlight.has(r.channelId) || sources.length === 0) {
        waiting.push(`${r.alias}: its channels are busy with a payment still in flight`);
        continue;
      }
      // (The books start the target's cooldown — refillBooks.)
      const res = await this.refillBooks({ targetId: r.channelId, via: "autopilot", holdPpm: r.expectedRevenuePpm }).settle((hooks) =>
        this.rebalanceExec(
          writeLnd,
          {
            targetId: r.channelId,
            sourceId: sources[0].id,
            sources,
            amountSats: r.recommendedAmount as number,
            econRatio: rebalancePolicy.econRatio,
            maxFeePpm: r.maxCostPpm ?? undefined,
            // The gate's limits at every size — and never more than is left today.
            maxFeeSats: Math.min(r.maxCostSatsByPayback ?? Infinity, live.leftSats ?? Infinity),
            ...(r.expectedRevenuePpm != null
              ? { gate: { revenuePpm: r.expectedRevenuePpm, demandSats: r.earningDemandSats, minNetSats: r.minNetProfitSats } }
              : {}),
          },
          // Inside the refill too, no attempt starts after the shutdown signal.
          { ...hooks, shouldStop: () => this.shuttingDown },
        ),
      );
      if (res.stopped) {
        // A deliberate skip (D15), like the moves planned after it: a source
        // whose attempt failed before the signal backs off (refillBooks).
        const failed = res.failedSourceIds?.length ?? 0;
        waiting.push(`${r.alias}: skipped, shutting down${failed ? ` (after ${failed === 1 ? "a source" : `${failed} sources`} found no route)` : ""}`);
        continue;
      }
      if (res.inFlight) {
        // We stopped waiting; the payment may still land. Its maximum fee
        // counts as spent (pendingRebalances), and the books are settled when
        // a later run learns how it ended.
        inFlight.add(res.targetId).add(res.sourceId);
        out.push({ alias: res.targetAlias, amountSats: res.amountSats, feeSats: null, costPpm: null, ok: false, error: res.error });
        continue;
      }
      out.push({
        alias: res.targetAlias,
        amountSats: res.amountSats,
        feeSats: res.feeSats,
        costPpm: res.costPpm,
        ok: res.ok,
        error: res.error,
      });
    }

    this.decisionNote("rebalance", this.rebalanceDecision(report.recommendations, out, plan.later, budgetSkips, waiting));
    return out;
  }

  /** The rebalance stage's decision, said plainly (D16): what ran, what waits
   *  and why — or why nothing qualifies. */
  private rebalanceDecision(
    recs: Pick<RebalanceRecommendation, "state">[],
    ran: AutopilotRebalance[],
    later: RebalanceRecommendation[],
    budgetSkips: string[],
    waiting: string[],
  ): string {
    const parts: string[] = [];
    if (ran.length) parts.push(`${ran.filter((r) => r.ok).length} of ${ran.length} refill${ran.length === 1 ? "" : "s"} paid`);
    if (budgetSkips.length) {
      const b = this.rebalanceBudget();
      parts.push(
        `${budgetSkips.length} profitable refill${budgetSkips.length === 1 ? " waits" : "s wait"} for the daily budget — ` +
          `${b.spentSats.toLocaleString("en-US")} of ${(b.budgetSats ?? 0).toLocaleString("en-US")} sat spent today, resets 00:00 UTC: ${budgetSkips.join(", ")}`,
      );
    }
    if (later.length) parts.push(`${later.length} more wait${later.length === 1 ? "s" : ""} for the next run (at most ${this.state.config.maxRebalancesPerRun} per run)`);
    if (waiting.length) parts.push(waiting.join("; "));
    if (parts.length) return parts.join(" · ");
    const drained = recs.filter((r) => r.state !== "not_needed").length;
    return drained
      ? `no refill clears the profit check right now (${drained} drained channel${drained === 1 ? "" : "s"} watched — see what each would need on the Rebalancing tab)`
      : "no channel needs a refill";
  }

  /** A finished rebalance as the log keeps it. A refill that passed the
   *  profit gate — the autopilot's, or one run by hand from a recommended row
   *  (the gate went with it) — carries the price the gate valued it at: the
   *  fee engine holds it while the refilled sats are in the channel. One run
   *  by hand without the gate chose its own price and sets no floor. */
  private rebalanceRecord(res: RebalanceExecResult, via: "autopilot" | "manual", holdPpm?: number | null): RebalanceRecord {
    return {
      at: new Date().toISOString(),
      via,
      targetId: res.targetId,
      targetAlias: res.targetAlias,
      sourceId: res.sourceId,
      sourceAlias: res.sourceAlias,
      amountSats: res.amountSats,
      budgetPpm: res.budgetPpm,
      feeSats: res.feeSats,
      costPpm: res.costPpm,
      ok: res.ok,
      error: res.error,
      ...(res.paymentId ? { paymentId: res.paymentId } : {}),
      ...(res.targetSentBefore !== undefined ? { targetSentBefore: res.targetSentBefore } : {}),
      ...(res.ok && holdPpm != null ? { holdPpm } : {}),
    };
  }

  /**
   * The books of one refill — the autopilot's or a manual one — attempt by
   * attempt, write-ahead (review P3): each payment attempt is a
   * pendingRebalances entry ON DISK before it is sent. A shutdown waits at
   * most 37 s (shutdown.ts) and a crash not at all, while a payment can take
   * up to the 150 s hard limit; before, the record was written only once the
   * payment returned or hit that limit, so a restart mid-payment left nothing:
   * today's budget didn't count it, the restarted autopilot refilled the same
   * channel again while the first payment could still land, and if it landed
   * its fee and the gate's hold were never booked. Now the restarted process
   * counts it at its maximum fee, leaves its two channels alone, and books it
   * — fee, hold, sent counter, the day it was sent — once LND says how it
   * ended (reconcilePendingRebalances). An attempt that can't be saved first
   * is not sent.
   *
   * settle() runs the executor with these hooks and books what it returns —
   * the pair back-off, the log record, the record of a payment left in
   * flight — before the attempts are released to the reconciliation, in one
   * synchronous step (the reconciliation can't book a payment twice).
   *
   * `holdPpm`: what the profit gate valued the refill at — given for one
   * that passed the gate (the autopilot's, or one run by hand with it); the
   * fee engine holds that price while the refilled sats are in the channel.
   */
  private refillBooks(meta: { targetId: string; via: "autopilot" | "manual"; holdPpm?: number | null }) {
    const sent = new Map<string, PendingRebalance>();
    // The target's cooldown starts with the refill, whatever its outcome —
    // no hammering a dead route. Set before anything is sent: the first
    // attempt's record saves it. (A refill the shutdown stopped before it
    // sent anything was no attempt: settle() puts the cooldown back.)
    const cooldownBefore = this.state.perTargetLastRebalanced[meta.targetId];
    this.state.perTargetLastRebalanced[meta.targetId] = new Date().toISOString();
    // The record of an attempt, sent now: its fee is today's budget's.
    const record = (p: {
      id: string;
      sourceId: string;
      sourceAlias?: string;
      alias: string;
      amountSats: number;
      maxFeeSats: number;
      targetSentBefore?: number;
    }): PendingRebalance => {
      const at = new Date().toISOString();
      return {
        id: p.id,
        targetId: meta.targetId,
        sourceId: p.sourceId,
        alias: p.alias,
        ...(p.sourceAlias ? { sourceAlias: p.sourceAlias } : {}),
        amountSats: p.amountSats,
        maxFeeSats: p.maxFeeSats,
        day: at.slice(0, 10),
        at,
        via: meta.via,
        ...(p.targetSentBefore !== undefined ? { targetSentBefore: p.targetSentBefore } : {}),
        ...(meta.holdPpm != null ? { holdPpm: meta.holdPpm } : {}),
      };
    };
    const hooks: RefillHooks = {
      onSend: (a) => {
        const entry = record({
          id: a.paymentId,
          sourceId: a.sourceId,
          sourceAlias: a.sourceAlias,
          alias: a.targetAlias,
          amountSats: a.amountSats,
          maxFeeSats: a.maxFeeSats,
          targetSentBefore: a.targetSentBefore,
        });
        (this.state.pendingRebalances ??= []).push(entry);
        try {
          this.store.writeOrThrow(this.state);
        } catch (err) {
          this.dropPending(entry.id);
          throw err;
        }
        sent.set(entry.id, entry);
        this.sendingRefills.add(entry.id);
      },
      onEnd: (paymentId, outcome) => {
        // Paid: settle() books it the moment the executor returns. Still in
        // flight: it stays pending — the reconciliation learns how it ends.
        if (outcome !== "failed") return;
        this.dropPending(paymentId);
        this.sendingRefills.delete(paymentId);
        this.persist();
      },
    };
    const settle = async (exec: (hooks: RefillHooks) => Promise<RebalanceExecResult>): Promise<RebalanceExecResult> => {
      try {
        const res = await exec(hooks);
        this.notePairs(meta.targetId, res);
        if (res.inFlight) {
          const { paymentId, maxFeeSats } = res.inFlight;
          // (An executor that announced nothing: recorded now.)
          if (!(this.state.pendingRebalances ?? []).some((p) => p.id === paymentId)) {
            (this.state.pendingRebalances ??= []).push(
              record({
                id: paymentId,
                sourceId: res.sourceId,
                sourceAlias: res.sourceAlias,
                alias: res.targetAlias,
                amountSats: res.amountSats,
                maxFeeSats,
                targetSentBefore: res.targetSentBefore,
              }),
            );
          }
        } else if (res.stopped) {
          // Stopped by the shutdown before its next attempt: a skip (D15),
          // nothing for the log — nothing was paid, and what failed before
          // it backs off (notePairs above). Nothing sent at all: no attempt,
          // no cooldown.
          if (sent.size === 0) {
            if (cooldownBefore === undefined) delete this.state.perTargetLastRebalanced[meta.targetId];
            else this.state.perTargetLastRebalanced[meta.targetId] = cooldownBefore;
          }
        } else {
          // Its fee belongs to the budget day it was sent on, like a payment
          // that ends after a restart.
          const entry = res.paymentId ? sent.get(res.paymentId) : undefined;
          this.rebalanceLog.append({ ...this.rebalanceRecord(res, meta.via, meta.holdPpm), ...(entry ? { startedAt: entry.at } : {}) });
          if (entry) this.dropPending(entry.id);
        }
        // Spent sats and the back-off must not be forgotten if a later stage
        // of the run throws or the process restarts: saved after every refill.
        this.persist();
        return res;
      } finally {
        for (const id of sent.keys()) this.sendingRefills.delete(id);
      }
    };
    return { hooks, settle };
  }

  /** Forget a pending rebalance (it ended, or was booked). */
  private dropPending(id: string): void {
    this.state.pendingRebalances = (this.state.pendingRebalances ?? []).filter((p) => p.id !== id);
  }

  /** Rebalance payments that were still in flight when we stopped waiting —
   *  the autopilot's and manual ones, from this process or one before it: ask
   *  LND how each ended, and write the log (today's spend follows from it).
   *  One at a time: a main run and the timer share the reconciliation under
   *  way. */
  private reconcilePendingRebalances(): Promise<void> {
    this.reconciling ??= this.reconcileNow().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /** The timer's share (every INFLIGHT_REBALANCE_CHECK_MS): only when a
   *  payment is pending, and never next to a main run (it reconciles first).
   *  Beside a manual refill it leaves that refill's own payments alone. */
  async checkInFlightRebalances(): Promise<void> {
    if (this.shuttingDown || this.running || (this.state.pendingRebalances ?? []).length === 0) return;
    try {
      await this.reconcilePendingRebalances();
    } catch (err) {
      console.warn(`[autopilot] checking in-flight rebalances: ${errText(err)}`);
    }
  }

  private async reconcileNow(): Promise<void> {
    const pending = this.state.pendingRebalances ?? [];
    if (pending.length === 0) return;
    const done = new Set<PendingRebalance>();
    for (const p of pending) {
      // Still this one's to book? Not while this process waits on it (a
      // manual refill under way: its entry is a write-ahead record, and LND
      // may not even know the payment yet), nor once its own refill dropped
      // it while this one asked LND about an earlier entry. (An entry no
      // refill waits on any more is left to this reconciliation alone.)
      if (this.sendingRefills.has(p.id) || !(this.state.pendingRebalances ?? []).includes(p)) continue;
      // Booked already — the process stopped between the log record and
      // saving its state: nothing to book twice.
      if (this.rebalanceLog.hasPayment(p.id)) {
        done.add(p);
        continue;
      }
      let st: { state: "confirmed"; feeSats: number } | { state: "failed" | "pending" };
      try {
        st = await this.rebalancePaymentStatus(p.id);
      } catch {
        continue; // LND can't say right now — ask again later
      }
      if (st.state === "pending") continue;
      const manual = p.via === "manual";
      const ok = st.state === "confirmed";
      if (p.sourceId) this.notePairs(p.targetId, { ok, sourceId: p.sourceId, failedSourceIds: ok ? [] : [p.sourceId] });
      // Written with the time it was sent: its fee belongs to that day's
      // budget (the maximum fee was charged there meanwhile).
      this.rebalanceLog.append({
        at: new Date().toISOString(),
        startedAt: p.at,
        via: manual ? "manual" : "autopilot",
        targetId: p.targetId,
        targetAlias: p.alias,
        sourceId: p.sourceId ?? "",
        sourceAlias: p.sourceAlias ?? "",
        amountSats: p.amountSats,
        budgetPpm: 0,
        feeSats: ok ? (st as { feeSats: number }).feeSats : null,
        costPpm: ok && p.amountSats > 0 ? Math.round(((st as { feeSats: number }).feeSats / p.amountSats) * 1_000_000) : null,
        ok,
        error: ok ? undefined : "the payment that was still in flight failed",
        paymentId: p.id,
        ...(p.targetSentBefore !== undefined ? { targetSentBefore: p.targetSentBefore } : {}),
        // (Only a refill that passed the gate carries a hold — a manual one
        // run with it too; see refillBooks.)
        ...(ok && p.holdPpm != null ? { holdPpm: p.holdPpm } : {}),
      });
      done.add(p);
      console.log(`[autopilot] in-flight rebalance ${p.id.slice(0, 12)}… ended ${st.state}${ok ? ` (fee ${(st as { feeSats: number }).feeSats} sat)` : ""}`);
    }
    // Payments tracked while this ran (a manual one) stay pending.
    this.state.pendingRebalances = (this.state.pendingRebalances ?? []).filter((p) => !done.has(p));
    this.persist();
  }

  /**
   * A rebalance by hand (Rebalance tab). It counts toward the same daily fee
   * budget as the autopilot's refills (review a2: manual runs bypassed it):
   * its fee is capped at what is left — and at `maxFeeSats`, what the confirm
   * dialog promised — and with nothing left it is refused before anything is
   * paid (RebalanceBudgetError). It starts the target's cooldown and books the
   * source → target pair like the autopilot's own attempts; it is not held
   * back by them — an explicit run, and the dialog says so. It never pays
   * beside the autopilot's rebalance stage or another manual refill (null:
   * busy — the refill lock), so two payments can't both pass the budget
   * check; the rest of a main run (fees, lease promises, channel opens,
   * Magma) goes on meanwhile. Each attempt is on disk before it is sent
   * (refillBooks); a payment still in flight at the hard limit is not a
   * failure — it may land later: it is tracked like the autopilot's own
   * (pendingRebalances, which also keeps the autopilot off its two channels
   * meanwhile), and the log gets its real outcome once LND knows it.
   *
   * Like the rebalance stage, it never moves liquidity into or out of a
   * channel whose earlier payment may still land (RefillInFlightError) — a
   * second move could double what was planned — and no attempt starts after
   * the shutdown signal. A refill run from a recommended row carries the
   * gate: it passed the same check as the autopilot's refills (its payment
   * capped by it at every size), so it holds the price the gate valued it at
   * the same way (refillLots), as the Rebalancing tab says (review of P3: it
   * got no hold, and the engine could cut the fee right after it). One run
   * without the gate chose its own price and sets no floor.
   */
  async rebalanceByHand(params: RebalanceExecParams): Promise<RebalanceExecResult | null> {
    const writeLnd = this.writeLnd;
    if (!writeLnd) throw new Error("writing is disabled");
    if (this.refilling || this.shuttingDown) return null;
    const busy = this.inFlightThrough([params.targetId, params.sourceId, ...(params.sources ?? []).map((s) => s.id)]);
    if (busy) throw new RefillInFlightError(busy.channelId, busy.payment);
    const budget = this.rebalanceBudget();
    if (budget.leftSats !== null && budget.leftSats <= 0) throw new RebalanceBudgetError(budget);
    this.refilling = true;
    try {
      const maxFeeSats = Math.min(params.maxFeeSats ?? Infinity, budget.leftSats ?? Infinity);
      return await this.refillBooks({ targetId: params.targetId, via: "manual", holdPpm: params.gate?.revenuePpm ?? null }).settle((hooks) =>
        this.rebalanceExec(
          writeLnd,
          { ...params, ...(Number.isFinite(maxFeeSats) ? { maxFeeSats } : {}) },
          { ...hooks, shouldStop: () => this.shuttingDown },
        ),
      );
    } finally {
      this.refilling = false;
      this.persist();
    }
  }

  /** Rebalance payments that may still land (pendingRebalances), as the
   *  Rebalancing tab shows them. */
  refillsInFlight(): RefillInFlight[] {
    return (this.state.pendingRebalances ?? []).map((p) => ({
      targetId: p.targetId,
      alias: p.alias,
      ...(p.sourceId ? { sourceId: p.sourceId } : {}),
      ...(p.sourceAlias ? { sourceAlias: p.sourceAlias } : {}),
      amountSats: p.amountSats,
      maxFeeSats: p.maxFeeSats,
      at: p.at,
      via: p.via ?? "autopilot",
    }));
  }

  /** The first payment still in flight into or out of any of `channelIds`,
   *  and which of them it goes through. */
  private inFlightThrough(channelIds: string[]): { channelId: string; payment: RefillInFlight } | null {
    for (const payment of this.refillsInFlight()) {
      const channelId = channelIds.find((id) => id === payment.targetId || id === payment.sourceId);
      if (channelId) return { channelId, payment };
    }
    return null;
  }

  /**
   * The rebalance report the Rebalancing tab shows — exactly the plan the
   * rebalance stage works from (rebalanceReport), with today's fee budget
   * and the payments still in flight: a row whose channels one goes through
   * shows that instead of a Run button (a manual refill there is refused).
   */
  async rebalanceRecommendations(): Promise<RebalanceRecReport & { budget: RebalanceBudget; inFlight: RefillInFlight[] }> {
    const report = (await this.rebalanceReport()) as RebalanceRecReport;
    return { ...report, budget: this.rebalanceBudget(), inFlight: this.refillsInFlight() };
  }

  /** Open a channel to the top suggestion when on-chain funds allow. */
  private async runChannels(writeLnd: AuthenticatedLnd): Promise<AutopilotChannelOpen[]> {
    const cfg = this.state.config;

    // Respect the cooldown between auto-opens.
    if (this.state.lastChannelOpenAt) {
      const elapsedMin = (Date.now() - new Date(this.state.lastChannelOpenAt).getTime()) / 60_000;
      if (elapsedMin < cfg.channelCooldownMinutes) return [];
    }

    // A cheap look first: no point in the slow planning reads below without
    // coins to spend. What counts is the shared budget (capital.ts): balance
    // minus the effective reserve (LND's anchor reserve and the funding fee
    // included) minus every coin promised to a sold channel not yet opened —
    // Magma and LSPS1 alike, across runs and restarts.
    const pre = await spendableOnchain(this.readLnd, this.capital, cfg.channelReserveSats);
    if (pre.spendableSat <= 0) return [];

    // The autopilot opens channels with real capital, so it gets the LN+ trust
    // signal too: a peer other operators rate badly is a bad place to lock funds.
    const { suggestions } = await this.channelSuggestions();
    const top = suggestions[0];
    if (!top) return [];

    const size = cfg.channelSizeSats > 0 ? cfg.channelSizeSats : top.recommendedSizeSats;
    if (pre.spendableSat < size) return []; // not enough on-chain to fund it + keep the reserve

    // Capital engine (D10): with Liquidity provision on, a routing open waits
    // — the coins left for Magma — only when Magma can actually take them and
    // is expected to earn more on them (leaveForMagma). Before, the deferral
    // read no lease data at all: it compared the median routing yield with
    // 1.2 × the lower-quartile one — a dispersion test that deferred whenever
    // channels earned alike (a node with ONE channel could never open a
    // second) — and parked capital for an offer that wasn't selling.
    if (cfg.sellEnabled) {
      let deferral: string | null = null;
      try {
        deferral = await this.leaveForMagma();
      } catch {
        // No answer: no deferral — the open goes ahead.
      }
      if (deferral) return [{ alias: top.alias, sizeSats: size, ok: false, error: deferral }];
    }

    // On-chain fee awareness: don't open when the funding fee eats >1% of the
    // channel — opening into a mempool spike is throwing money away; wait it out.
    const oc = await onchainCosts(this.readLnd);
    if (oc.feePerVbyte != null && oc.openCostSat > size * 0.01) {
      return [
        { alias: top.alias, sizeSats: size, ok: false, error: `on-chain fees too high (~${oc.openCostSat} sat to open) — deferred` },
      ];
    }

    // Dial the peer BEFORE taking the mutex: over Tor that can take a minute
    // and a half, and a slow routing peer must not hold up a Magma accept's
    // capital check or anyone else's open meanwhile.
    if (this.shuttingDown) return [{ alias: top.alias, sizeSats: size, ok: false, error: "skipped: shutting down" }];
    const connected = await connectForOpen(writeLnd, { pubkey: top.pubkey, socket: top.socket || undefined });
    if (!connected.ok) return [{ alias: top.alias, sizeSats: size, ok: false, error: connected.error }];

    // One on-chain commitment at a time (Magma fulfilment, LSPS1, manual
    // opens): the check and the open happen together, inside the mutex.
    return this.capital.mutex.run("autopilot open", async (): Promise<AutopilotChannelOpen[]> => {
      // The reads above take a while (graph, forwards, fee estimate). A
      // shutdown signal that arrived meanwhile must not be followed by a
      // funding broadcast.
      if (this.shuttingDown) {
        return [{ alias: top.alias, sizeSats: size, ok: false, error: "skipped: shutting down" }];
      }
      // Authoritative check with a fresh balance: a Magma order accepted since
      // the look above has its coins reserved, and they are not ours to spend
      // — nor what its own open will need on top: its funding fee, its step
      // of LND's anchor reserve, and the SELL reserve its check applies (a
      // sell reserve above the channel reserve used to be spent here).
      const sp = await spendableOnchain(this.readLnd, this.capital, cfg.channelReserveSats);
      if (sp.spendableSat < size) {
        return [
          {
            alias: top.alias,
            sizeSats: size,
            ok: false,
            error: `deferred: only ${sp.spendableSat} sat spendable after the reserve and ${sp.reservedSat} sat promised to sold channels`,
          },
        ];
      }
      if (this.shuttingDown) {
        return [{ alias: top.alias, sizeSats: size, ok: false, error: "skipped: shutting down" }];
      }
      const res = await fundChannel(writeLnd, {
        pubkey: top.pubkey,
        socket: top.socket || undefined,
        localTokens: size,
      });
      if (res.ok) {
        this.state.lastChannelOpenAt = new Date().toISOString();
        // The open cooldown is the only thing between runs that stops another
        // open — it must survive a crash right after this one.
        this.persist();
      }
      return [
        {
          alias: top.alias,
          sizeSats: size,
          ok: res.ok,
          transactionId: res.transactionId,
          error: res.error,
        },
      ];
    });
  }

  /**
   * Magma offer upkeep — the main run's share of selling (orders are the
   * order lane's, see pollSellOrders). With Liquidity provision on, every
   * offer is kept:
   *  - fundable: it never advertises a channel the wallet can't fund after the
   *    reserve and the coins promised to other buyers, within the deploy cap.
   *    It is shrunk to what can be funded, disabled when not even its smallest
   *    channel can, and enabled again once it can. (An order the offer could
   *    not serve would otherwise end in a reject — or worse, a failed open.)
   *  - priced and shaped as configured (auto-pricing, auto-sizing, relisting).
   * Every write checks Amboss's answer, is read back to verify, and lands in
   * the run history and in the offer sync status (offerSyncStatus): a write
   * that fails is never silent, and the UI never calls an offer "managed"
   * when the writes don't land.
   */
  private async runSell(): Promise<AutopilotSell[]> {
    const cfg = this.state.config;
    if (!cfg.sellEnabled || !this.amboss.hasKey() || this.shuttingDown) return [];
    const key = this.amboss.getKey();
    const out: AutopilotSell[] = [];
    const sync = this.syncState();
    sync.managed = true;
    const failed = (message: string): AutopilotSell[] => {
      sync.lastError = { at: new Date().toISOString(), message };
      console.warn(`[autopilot] Magma offers: ${message}`);
      return [...out, { orderId: "offers", action: "error", sizeSats: 0, ok: false, error: message }];
    };

    // What can be sold right now: the coins (D5 reserve, minus what other
    // buyers were promised and what their opens will need) and the deploy
    // cap's headroom.
    let ctx: OfferCtx;
    try {
      await this.magma.refreshDeployed(true);
      const sp = await spendableOnchain(this.readLnd, this.capital, cfg.sellReserveSats);
      const headroom = Math.max(0, cfg.sellMaxDeploySats - this.capital.deployedSat() - this.capital.reservedSat());
      ctx = {
        ...sellable(sp, headroom, cfg.sellMaxChannelSats),
        target: () => null,
        reshape: () => null,
        lease: () => null,
        caps: this.offerFeeCaps(),
      };
    } catch (err) {
      if (isAuthError(err)) await this.amboss.recheckAfterRefusal();
      return failed(`could not work out the sellable capital: ${errText(err)}`);
    }

    let offers: MyOffer[];
    // When the listing below was asked for: an operator's click recorded
    // since then is newer than what it shows (see settleStatusRecords).
    let readAt = Date.now();
    try {
      // This node's offers only: one Amboss account can list offers for
      // several nodes, and another node's are not ours to reprice, resize,
      // enable or disable.
      const own = await getOwnPubkey(this.readLnd);
      readAt = Date.now();
      offers = await getMyOffers(key, own);
      this.amboss.markValid();
    } catch (err) {
      if (isAuthError(err)) await this.amboss.recheckAfterRefusal();
      return failed(`could not read your offers from Amboss: ${errText(err)}`);
    }
    sync.lastError = null;

    // Adaptive pricing (mode "auto"): ratchet the level UP when an order fills —
    // you could have charged more — and hold it otherwise.
    //
    // There is deliberately NO downward ratchet any more. The old version cut the
    // level by 0.1 for every day without a fill, which sounds like price discovery
    // and is not: Magma's buy call carries no offer id, so Amboss picks the
    // seller and being cheaper does not make you more likely to be picked. On this
    // node that loop ran for months, walked the level to 0, and left the offer at
    // roughly a fifth of the real clearing price — still unsold, now unprofitable
    // too.
    if (cfg.sellPricingMode === "auto" && cfg.sellAutoReprice) {
      const filledNow = offers.reduce((s, o) => s + o.filledOrders, 0);
      if (filledNow > this.state.lastSellFilledCount) {
        this.state.sellAdaptiveLevel = Math.min(1, this.state.sellAdaptiveLevel + 0.15);
        this.state.lastSellFillAt = new Date().toISOString();
        this.state.lastSellAdaptiveAdjustAt = new Date().toISOString();
      }
      this.state.lastSellFilledCount = filledNow;
    }

    let rec: MagmaV2Report | null = null;
    if (cfg.sellAutoReprice || cfg.sellAutoSize) {
      try {
        // The same inputs the Market page uses (one builder, magmaOverrides).
        rec = await this.magmaReport(key);
      } catch (err) {
        // No recommendation: prices and shapes stay; the capital limits below
        // still apply. Not silent: the sync status says why.
        sync.lastError = { at: new Date().toISOString(), message: `no market recommendation this run: ${errText(err)}` };
      }
    }
    const recByOffer = new Map(
      (rec?.sell.recommendations ?? []).filter((r) => r.offerId).map((r) => [r.offerId as string, r] as const),
    );

    // The price the engine would like — handed out ONLY when the operator has
    // delegated pricing. The recommendation is also fetched for auto-sizing,
    // and in 0.7.6 every consumer treated "we have a recommendation" as "we may
    // reprice". Gating it here, at the single source, covers every path.
    ctx.target = (off) => {
      if (!cfg.sellAutoReprice) return null;
      const r = recByOffer.get(off.id);
      if (!r) return null;
      return { fee: r.recommended.feeRatePpm, base: r.recommended.baseFeeSat, moved: r.shouldReprice, lease: r.recommended.minBlockLength };
    };

    // Auto-size is offer-shape hygiene (D19): a standard lease and a sane
    // size window — not a lever that makes an offer fill (it isn't one below
    // Amboss's score/depth gate).
    //
    // The lease first, on its own: it needs no market recommendation and no
    // capital, so it is corrected on a capital-limited node too. Before, it
    // sat inside the window logic below — behind its "no recommendation" and
    // "not enough room" exits — and only ever moved a lease DOWN: the live
    // 4032-block offer (a length no order had used since 2022) was never
    // raised to the standard 4320.
    ctx.lease = () => (cfg.sellAutoSize ? standardLeaseBlocks() : null);

    // The size window: from the smallest channel that still pays for itself
    // up to what can be funded. Null when the current one is fine, so we
    // don't churn updates.
    ctx.reshape = (off) => {
      if (!rec || !cfg.sellAutoSize) return null;
      const sell = rec.sell;
      // The size floor only holds at the price it was computed for. With
      // auto-pricing off the offer keeps the operator's own price, so the floor
      // has to come from that price — otherwise sizing could open the window to
      // orders that lose money at the price actually listed.
      const floorAtOwnPrice = (): number => {
        const cost =
          (sell.onchainOpenCostSat + sell.onchainCloseCostSat + sell.minNetLeaseProfitSat) /
          Math.max(0.01, 1 - sell.serviceFeeRate);
        const stillNeeded = cost - off.baseFeeSats; // what the rate must earn on top of the base
        if (stillNeeded <= 0) return 0; // the base fee alone covers any size
        if (off.feeRatePpm <= 0) return Number.POSITIVE_INFINITY;
        return Math.ceil((stillNeeded * 1_000_000) / off.feeRatePpm / 50_000) * 50_000;
      };
      const wantMin = cfg.sellAutoReprice
        ? sell.recommendedMinSizeSat
        : Math.max(sell.recommendedMinSizeSat, floorAtOwnPrice());
      const room = ctx.maxOrder(Math.min(wantMin, off.minSizeSats));
      const wantMax = Math.max(wantMin, Math.min(sell.recommendedMaxSizeSat, room));
      if (wantMax < wantMin || room < wantMin) return null;
      // Only act on a MEANINGFUL difference: a window much narrower than
      // what can be funded, or a floor above what is economic.
      const widens = wantMax > off.maxSizeSats * 1.2;
      const lowersFloor = wantMin < off.minSizeSats * 0.8;
      if (!widens && !lowersFloor) return null;
      return {
        minSizeSats: Math.min(wantMin, off.minSizeSats),
        maxSizeSats: Math.max(wantMax, off.maxSizeSats),
      };
    };

    const entries: OfferSyncEntry[] = [];
    for (const off of offers) {
      if (this.shuttingDown) {
        // Offer upkeep can wait for the next start; its Amboss calls must not
        // use up the shutdown grace that the order lane may still need.
        entries.push(this.syncEntry(off, null));
        continue;
      }
      entries.push(await this.upkeepOffer(key, off, ctx, out, readAt));
    }
    // Cut memories of offers that are gone have nothing left to give back,
    // and their ownership records nothing left to own.
    for (const id of Object.keys(this.state.offerCuts ?? {})) {
      if (!offers.some((o) => o.id === id)) delete this.state.offerCuts?.[id];
    }
    for (const id of Object.keys(this.state.offerControl ?? {})) {
      if (!offers.some((o) => o.id === id)) delete this.state.offerControl?.[id];
    }

    // Auto-list idle capital: no offer at all, leasing beats routing, and
    // auto-pricing on (listing means choosing a price, which only that switch
    // may do). Sized to what can be funded now — never the old flat 1M floor.
    // And only where selling is realistic at all (D8/m4: no automatic offer
    // for a node whose comparable offers don't sell — it would only park
    // capital and invite orders it may then have to turn down).
    const createRec = rec?.sell.recommendations.find((r) => r.mode === "create");
    const canCreate =
      !this.shuttingDown && cfg.sellAutoReprice && offers.length === 0 && rec?.sell.state === "good_to_sell" && !!createRec;
    const realistic = canCreate ? await this.sellingRealistic() : null;
    if (canCreate && realistic && !realistic.ok) {
      this.decisionNote("magma", `no offer listed automatically: ${realistic.why}`);
    }
    if (canCreate && rec && createRec && realistic?.ok) {
      const viable = rec.sell.minViableSizeSat ?? 1_000_000;
      const minCh = Math.min(viable, ctx.maxOrder(viable));
      const maxCh = ctx.maxOrder(minCh);
      const listed = ctx.listable(minCh);
      if (minCh > 0 && listed >= minCh && maxCh >= minCh) {
        const terms: OfferTerms = {
          totalSizeSats: listed,
          minSizeSats: minCh,
          maxSizeSats: maxCh,
          feeRatePpm: createRec.recommended.feeRatePpm,
          baseFeeSats: createRec.recommended.baseFeeSat,
          minBlockLength: standardLeaseBlocks(),
          // The routing-fee promise, always (D7) — kept by the fee autopilot.
          feeRateCapPpm: ctx.caps.feeRateCapPpm,
          baseFeeCapSats: ctx.caps.baseFeeCapSats,
        };
        const write: OfferWrite = {
          at: new Date().toISOString(),
          by: "autopilot",
          action: "create",
          fields: ambossFields(terms),
          ok: false,
          reason: "no offer listed, and leasing beats routing",
        };
        try {
          const pubkey = (await getWalletInfo({ lnd: this.readLnd })).public_key;
          const id = await createOffer(key, pubkey, terms);
          write.ok = true;
          const created = await getMyOffer(key, id).catch(() => null);
          write.verified = created ? termsMatch(created, terms) : undefined;
          if (created) entries.push(this.syncEntry(created, fieldsOf(created), write));
          out.push({ orderId: id, action: "create", sizeSats: terms.totalSizeSats, ok: true });
        } catch (err) {
          write.error = errText(err);
          out.push({ orderId: "new-offer", action: "create", sizeSats: terms.totalSizeSats, ok: false, error: write.error });
          sync.lastError = { at: write.at, message: `creating an offer failed: ${write.error}` };
        }
      }
    }
    sync.offers = entries;
    sync.at = new Date().toISOString();

    // Lease over (Amboss: CHANNEL_MONITORING_FINISHED): close to reclaim the capital.
    if (cfg.sellAutoClose && !this.shuttingDown) {
      try {
        out.push(...(await this.magma.closeFinishedLeases()));
      } catch (err) {
        out.push({ orderId: "leases", action: "error", sizeSats: 0, ok: false, error: `closing finished leases: ${errText(err)}` });
      }
    }
    return out;
  }

  /** One offer's upkeep: listed only while fundable, then its terms. */
  private async upkeepOffer(key: string, off: MyOffer, ctx: OfferCtx, out: AutopilotSell[], readAt: number): Promise<OfferSyncEntry> {
    if (off.status === "ADMIN_DISABLED") {
      return this.syncEntry(off, null, undefined, "disabled by Amboss support — only Amboss can enable it again");
    }
    let control = this.settleStatusRecords(off, readAt);
    const sellableNow = ctx.maxOrder(off.minSizeSats);
    const fundable = sellableNow >= Math.max(1, off.minSizeSats);
    const lackOfCapital = () =>
      `disabled by the autopilot for lack of capital: its smallest channel (${fmtSat(off.minSizeSats)} sat) can't be funded — ` +
      `${fmtSat(sellableNow)} sat sellable after the reserve, promised orders and the deploy cap; it is listed again once it can be`;
    const unanswered =
      "the autopilot disabled it for lack of capital, and Amboss's answer never came — the next read of the offer tells whether the disable landed";
    const disabledWhy = (status: string): string =>
      control.disabledByHandAt
        ? "disabled by you — the autopilot leaves it disabled; enable it on Market → Sell to list it again"
        : control.autoDisabledAt
          ? lackOfCapital()
          : control.autoDisablingAt
            ? unanswered
            : `offer is ${status} — the autopilot doesn't enable an offer it didn't disable; enable it on Market → Sell to list it`;
    // Capital safety, for every offer (the operator's own too): see
    // capitalStatus and capitalToggle.
    const wantStatus = capitalStatus(off.status, fundable, control);
    if (wantStatus) {
      const r = await this.capitalToggle(key, off, wantStatus, { fundable, sellableNow }, out);
      control = this.offerControlOf(off.id);
      const wanted = r.write ? { ...fieldsOf(r.offer), status: wantStatus } : null;
      if (r.unresolved) {
        // How the status change ended isn't known: nothing else is changed on
        // this offer until a read says what Amboss has.
        const why =
          wantStatus === "DISABLED" && control.autoDisablingAt
            ? unanswered
            : `${wantStatus === "DISABLED" ? "not disabled" : "not listed again"} yet: ${r.write?.error ?? "Amboss did not answer"} — tried again next run`;
        return this.syncEntry(r.offer, wanted, r.write ?? undefined, why);
      }
      if (r.offer.status !== "ENABLED") return this.syncEntry(r.offer, wanted, r.write ?? undefined, disabledWhy(r.offer.status));
      off = r.offer;
    }
    if (off.status !== "ENABLED") return this.syncEntry(off, null, undefined, disabledWhy(off.status));

    const want = this.wantedTerms(off, ctx, !!control.manual);
    if (want.notes.length) this.decisionNote("magma", `offer ${off.id.slice(0, 8)}…: ${want.notes.join("; ")}`);
    const update = termsUpdate(off, want.fields);
    if (!update) {
      // Amboss already has exactly this: the cut memory matches it as is.
      this.keepCut(off.id, want.cut);
      return this.syncEntry(off, want.fields, undefined, want.notes);
    }
    const write: OfferWrite = {
      at: new Date().toISOString(),
      by: "autopilot",
      action: "update",
      fields: ambossFields(update),
      ok: false,
      reason: want.reasons.join("; "),
    };
    let after = off;
    try {
      write.ok = await updateOffer(key, off.id, update);
      if (!write.ok) write.error = "Amboss did not apply the update (success: false)";
    } catch (err) {
      write.error = errText(err);
    }
    if (write.ok) {
      // Read it back: "success" is Amboss's word; the stored offer is the proof.
      const read = await getMyOffer(key, off.id).catch(() => null);
      if (read) {
        after = read;
        write.verified = termsMatch(read, update);
        if (!write.verified) write.error = "Amboss answered success, but the offer reads back different";
      }
    }
    const ok = write.ok && write.verified !== false;
    out.push({ orderId: off.id, action: want.kind, sizeSats: want.fields.maxSizeSats, ok, ...(ok ? {} : { error: write.error }) });
    // The cut memory follows what Amboss has: updated only when the write
    // landed (a failed one left the offer — and the old memory — as it was).
    if (ok) this.keepCut(off.id, want.cut);
    if (ok) {
      console.log(`[autopilot] updated offer ${off.id}: ${Object.entries(write.fields).map(([k, v]) => `${k}=${v}`).join(", ")} (${write.reason})`);
    } else {
      console.warn(`[autopilot] offer ${off.id} update failed: ${write.error}`);
    }
    return this.syncEntry(after, want.fields, write, want.notes);
  }

  /**
   * The offer's status records, settled against the listing this run read
   * (`readAt`: when it was asked for):
   *  - a disable the autopilot sent whose answer never came: the offer reads
   *    DISABLED now, so it landed — the autopilot's (listed again once
   *    capital returns), unless the operator has disabled it by hand since;
   *  - a record describes a DISABLED offer: once the listing shows it listed
   *    again (a click here or on amboss.tech), it is history — but only a
   *    record from BEFORE that read. A click recorded since (the operator
   *    disabled it while this run priced other offers) is newer than what the
   *    listing shows; it used to be cleared on the strength of the older
   *    read, and the click was lost.
   */
  private settleStatusRecords(off: MyOffer, readAt: number): OfferControl {
    const control = this.offerControlOf(off.id);
    const older = (at: string | undefined) => !!at && Date.parse(at) < readAt;
    const next: OfferControl = { ...control };
    if (older(control.autoDisablingAt)) {
      if (off.status === "DISABLED" && !control.disabledByHandAt) next.autoDisabledAt = control.autoDisablingAt;
      next.autoDisablingAt = undefined;
    }
    if (off.status === "ENABLED") {
      if (older(next.autoDisabledAt)) next.autoDisabledAt = undefined;
      if (older(next.disabledByHandAt)) next.disabledByHandAt = undefined;
    }
    const changed =
      next.autoDisabledAt !== control.autoDisabledAt ||
      next.disabledByHandAt !== control.disabledByHandAt ||
      next.autoDisablingAt !== control.autoDisablingAt;
    if (changed) this.setOfferControl(off.id, next);
    return this.offerControlOf(off.id);
  }

  /**
   * Capital safety's status change, safe against everyone else who changes
   * the status. Amboss's toggle FLIPS whatever the status is, so a flip sent
   * on a status that changed since it was read does the opposite of what was
   * decided. Before, the flip went by the listing read at the start of the
   * run (the engine call and other offers' upkeep came in between): an
   * operator's disable landing in that window was ENABLED again by the
   * autopilot's "disable" — an unfundable offer listed, the click lost — and
   * a disable Amboss applied without answering in time left no record that
   * the autopilot had made it, so the offer was never listed again. Now:
   *  - one status change per offer at a time (withOffer): a click on Market
   *    → Sell waits for this one, and reads the offer afresh;
   *  - the offer and its record are read afresh, and the flip is sent only
   *    while they still call for it;
   *  - a disable is recorded as the autopilot's intent before it is sent: an
   *    answer that never comes is settled by the next read of the offer;
   *  - an answer that isn't the wanted status means another flip crossed this
   *    one (on amboss.tech, another tool) — wanting the same status, as there
   *    are only two: read again, and flipped once more while Amboss still
   *    shows the other;
   *  - the result is merged into the record as it is NOW: a click recorded
   *    meanwhile stands (the operator's disable wins over the autopilot's).
   */
  private capitalToggle(
    key: string,
    off: MyOffer,
    want: "ENABLED" | "DISABLED",
    cap: { fundable: boolean; sellableNow: number },
    out: AutopilotSell[],
  ): Promise<{ offer: MyOffer; write: OfferWrite | null; unresolved?: boolean }> {
    return this.withOffer(off.id, async () => {
      const action = want === "ENABLED" ? "enable" : "disable";
      const reason =
        want === "ENABLED"
          ? "its smallest channel can be funded again (the autopilot had disabled it for lack of capital)"
          : `its smallest channel (${off.minSizeSats} sat) can't be funded: ${cap.sellableNow} sat sellable after the reserve, promised orders and the deploy cap`;
      const write: OfferWrite = { at: new Date().toISOString(), by: "autopilot", action, fields: { offer_id: off.id }, ok: false, reason };
      const report = (ok: boolean) =>
        out.push({ orderId: off.id, action, sizeSats: off.totalSizeSats, ok, error: ok ? (want === "ENABLED" ? undefined : reason) : write.error });
      const read = (): Promise<MyOffer | null> => getMyOffer(key, off.id).catch(() => null);
      const fresh = await read();
      if (!fresh) {
        write.error = "could not read the offer from Amboss before changing its status — tried again next run";
        report(false);
        return { offer: off, write, unresolved: true };
      }
      // Changed since the listing was read (a click, amboss.tech): decided
      // afresh at the next run, on what Amboss shows then.
      if (capitalStatus(fresh.status, cap.fundable, this.offerControlOf(off.id)) !== want) return { offer: fresh, write: null };
      if (want === "DISABLED") {
        this.setOfferControl(off.id, { ...this.offerControlOf(off.id), autoDisablingAt: write.at });
        this.persist();
      }
      const flip = async (): Promise<string | null> => {
        try {
          const answered = await toggleOffer(key, off.id);
          if (answered === want) return answered;
          // Another flip crossed this one: what does Amboss show now?
          const now = await read();
          if (!now || now.status === want) return now?.status ?? null;
          write.reason = `${reason} — the offer was flipped by someone else meanwhile, so it was flipped once more`;
          return await toggleOffer(key, off.id);
        } catch (err) {
          write.error = errText(err);
          // It may have landed without its answer: the offer says.
          return (await read())?.status ?? null;
        }
      };
      const status = await flip();
      // Merged into the record as it is now: a click recorded meanwhile — the
      // operator's disable — wins over the autopilot's.
      const current = this.offerControlOf(off.id);
      const next: OfferControl = { ...current };
      if (status === want) {
        next.autoDisabledAt = want === "DISABLED" && !current.disabledByHandAt ? write.at : undefined;
        next.autoDisablingAt = undefined;
      } else if (status !== null) {
        next.autoDisablingAt = undefined; // it didn't land
      }
      // (Status unknown — no answer, and the offer can't be read: the intent
      // stays, and the next read of the offer settles it.)
      this.setOfferControl(off.id, next);
      write.ok = status === want;
      write.verified = status === null ? undefined : write.ok;
      if (write.ok) write.error = undefined;
      else if (!write.error) write.error = `Amboss reports the offer ${status}, not ${want}`;
      report(write.ok);
      return status === null ? { offer: fresh, write, unresolved: true } : { offer: { ...fresh, status }, write };
    });
  }

  /**
   * The terms the autopilot wants for an enabled offer, and what a capital
   * cut among them would have to give back later (OfferCut). An offer the
   * operator took over (`manual`) keeps every term of theirs — only the
   * capital cut (and giving it back) applies to it. `notes`: what it would
   * have changed but didn't, and why (for the sync status).
   */
  private wantedTerms(
    off: MyOffer,
    ctx: OfferCtx,
    manual: boolean,
  ): { fields: OfferFields; kind: SellActionKind; reasons: string[]; notes: string[]; cut: OfferCut | null } {
    const cfg = this.state.config;
    const w = fieldsOf(off);
    const reasons: string[] = [];
    const notes: string[] = [];
    let kind: SellActionKind = "reprice";
    let repriced = false;
    const shape = manual ? null : ctx.reshape(off);
    if (!manual) {
      // The lease first: a price holds only for the lease it is for. The
      // engine prices each offer for the lease it carries after this write
      // (magmaRecommend.ts) — the standard one with auto-size, else the one
      // it keeps; a price meant for another lease goes on only where it
      // can't undercharge (priceFitsLease: the old 4,032-block offer takes
      // the 4,320-block price; a 5,000-block one never the 4,320 one).
      const lease = ctx.lease(off);
      const leaseAfter = lease ?? w.minBlockLength;
      const t = ctx.target(off);
      if (t?.moved) {
        if (priceFitsLease(t.lease, leaseAfter)) {
          w.feeRatePpm = t.fee;
          w.baseFeeSats = t.base;
          repriced = true;
          reasons.push(
            t.lease === leaseAfter
              ? "market price moved"
              : `market price moved (priced for the standard ${fmtSat(t.lease)}-block lease; with auto-size off the offer keeps its ${fmtSat(leaseAfter)} blocks)`,
          );
        } else {
          notes.push(
            `not repriced: the market price is for a ${fmtSat(t.lease)}-block lease, and this offer promises ${fmtSat(leaseAfter)} blocks — ` +
              (t.lease < leaseAfter ? "that price would undercharge for its own, longer lease" : "that price is for a much longer lease than its own") +
              ". With auto-size off its lease stays: turn on auto-size (it gives the offer the standard lease, priced for it), or edit the offer on Market → Sell",
          );
        }
      }
      if (shape) {
        w.minSizeSats = shape.minSizeSats;
        w.maxSizeSats = shape.maxSizeSats;
        w.availableSats = Math.max(w.availableSats, shape.maxSizeSats);
        kind = "resize";
        reasons.push("size window set from the smallest channel that pays for itself up to what can be funded");
      }
      // Standard offer terms (D7, with auto-size): the lease buyers use, and
      // the routing-fee promise the fee autopilot keeps for every sold
      // channel. With every offer-automation switch off, an offer's terms are
      // the operator's — its promise too (one set on amboss.tech stays) — and
      // only the capital limits below apply. (Before, the promise was written
      // with every switch off, while the diagnostics said "only the capital
      // limits apply".)
      if (lease !== null && lease !== w.minBlockLength) {
        reasons.push(`lease set to the standard ${lease} blocks (was ${w.minBlockLength})`);
        w.minBlockLength = lease;
        if (kind === "reprice" && !repriced) kind = "terms";
      }
      if (cfg.sellAutoSize && (w.feeRateCapPpm !== ctx.caps.feeRateCapPpm || w.baseFeeCapSats !== ctx.caps.baseFeeCapSats)) {
        reasons.push(`routing-fee promise set to ${ctx.caps.feeRateCapPpm} ppm + ${ctx.caps.baseFeeCapSats} sat base for the lease`);
        w.feeRateCapPpm = ctx.caps.feeRateCapPpm;
        w.baseFeeCapSats = ctx.caps.baseFeeCapSats;
        if (kind === "reprice" && !repriced) kind = "terms";
      }
    }
    // What an earlier capital cut took goes back in — up to what it was, and
    // no further than what can be funded now (the clamp below). Auto-sizing
    // decided the window afresh this run: then its max is the wish.
    const earlier = this.liveCut(off);
    if (earlier?.max && !shape && earlier.max.wish > w.maxSizeSats) w.maxSizeSats = earlier.max.wish;
    if (earlier?.listed) w.availableSats += earlier.listed.cutSats;
    const listable = ctx.listable(w.minSizeSats);
    if (!manual && cfg.sellAutoRelist && w.availableSats < w.maxSizeSats && w.maxSizeSats <= listable) {
      w.availableSats = w.maxSizeSats;
      kind = "relist";
      reasons.push("sold out — topped back up");
    }
    // Never advertise what can't be funded (shared capital, D4/D5).
    const wantMax = w.maxSizeSats;
    const wantListed = w.availableSats;
    w.maxSizeSats = Math.min(w.maxSizeSats, Math.max(w.minSizeSats, ctx.maxOrder(w.minSizeSats)));
    w.availableSats = Math.min(w.availableSats, listable);
    w.totalSizeSats = off.lockedSats + w.availableSats;
    if (w.maxSizeSats < off.maxSizeSats) {
      kind = "resize";
      reasons.push(`max channel cut to the ${w.maxSizeSats} sat that can be funded`);
    }
    if (w.availableSats < off.availableSats) {
      kind = "resize";
      reasons.push(`listed liquidity cut to the ${w.availableSats} sat that can be funded`);
    }
    if (earlier && (w.maxSizeSats > off.maxSizeSats || w.availableSats > off.availableSats)) {
      kind = "resize";
      reasons.push(
        `capital is back — giving back what a capital cut took (max channel ${off.maxSizeSats} → ${w.maxSizeSats}, listed ${off.availableSats} → ${w.availableSats} sat)`,
      );
    }
    const cut: OfferCut = { at: new Date().toISOString() };
    if (w.maxSizeSats < wantMax) cut.max = { wish: wantMax, set: w.maxSizeSats };
    if (w.availableSats < wantListed) cut.listed = { cutSats: wantListed - w.availableSats, setTotal: w.totalSizeSats };
    return { fields: w, kind, reasons, notes, cut: cut.max || cut.listed ? cut : null };
  }

  /** The memory of an earlier capital cut on this offer — only the parts
   *  Amboss still shows as the cut left them. A value changed since (by the
   *  operator on amboss.tech, or a sale that shrank the total) is no longer
   *  the autopilot's to give back. */
  private liveCut(off: MyOffer): OfferCut | null {
    const c = this.state.offerCuts?.[off.id];
    if (!c) return null;
    const live: OfferCut = { at: c.at };
    if (c.max && c.max.set === off.maxSizeSats) live.max = c.max;
    if (c.listed && c.listed.setTotal === off.totalSizeSats) live.listed = c.listed;
    return live.max || live.listed ? live : null;
  }

  private keepCut(offerId: string, cut: OfferCut | null): void {
    if (cut) (this.state.offerCuts ??= {})[offerId] = cut;
    else if (this.state.offerCuts) delete this.state.offerCuts[offerId];
  }

  // ── who owns an offer's terms (OfferControl) ────────────────────────────────

  private offerControlOf(offerId: string): OfferControl {
    return this.state.offerControl?.[offerId] ?? {};
  }

  private setOfferControl(offerId: string, control: OfferControl): void {
    const clean: OfferControl = {
      ...(control.manual ? { manual: control.manual } : {}),
      ...(control.autoDisabledAt ? { autoDisabledAt: control.autoDisabledAt } : {}),
      ...(control.autoDisablingAt ? { autoDisablingAt: control.autoDisablingAt } : {}),
      ...(control.disabledByHandAt ? { disabledByHandAt: control.disabledByHandAt } : {}),
    };
    if (Object.keys(clean).length) (this.state.offerControl ??= {})[offerId] = clean;
    else if (this.state.offerControl) delete this.state.offerControl[offerId];
  }

  /** The operator created or edited the offer by hand (or took it over): its
   *  terms are theirs until they hand it back (resumeOfferAutomation). Who
   *  disabled it, if anyone, is unchanged — an edit is not a status click. */
  pauseOfferAutomation(offerId: string, why: string): void {
    this.setOfferControl(offerId, { ...this.offerControlOf(offerId), manual: { since: new Date().toISOString(), why } });
    this.persist();
  }

  /** "Let the autopilot manage it": the offer's terms are the autopilot's
   *  again (with Liquidity provision on), from the next run. A disable by
   *  hand still stands. */
  resumeOfferAutomation(offerId: string): void {
    this.setOfferControl(offerId, { ...this.offerControlOf(offerId), manual: undefined });
    this.persist();
  }

  /** The operator enabled or disabled the offer by hand (Market → Sell, or
   *  turning Liquidity provision off): the listing is theirs — a disable
   *  sticks, an enable lists it — and the terms stay with whoever had them. */
  offerStatusSetByHand(offerId: string, status: string): void {
    const control = this.offerControlOf(offerId);
    this.setOfferControl(offerId, {
      ...control,
      // Whatever the autopilot had disabled (or was disabling) is superseded
      // by the click.
      autoDisabledAt: undefined,
      autoDisablingAt: undefined,
      disabledByHandAt: status === "DISABLED" ? new Date().toISOString() : undefined,
    });
    this.persist();
  }

  /**
   * One status change per offer at a time, whoever makes it — the offer
   * upkeep's capital safety, or a click on Market → Sell (the toggle route).
   * Amboss's toggle flips whatever the status is, so two flips that cross
   * undo each other; each reads the offer afresh inside this, never by a
   * status the other just changed.
   */
  async withOffer<T>(offerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.offerChains.get(offerId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = prev.then(() => mine);
    this.offerChains.set(offerId, chain);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.offerChains.get(offerId) === chain) this.offerChains.delete(offerId);
    }
  }

  // ── the Magma engine, eligibility and sellable capital ──────────────────────

  /** The Magma engine's report with THIS autopilot's inputs — the one call the
   *  Market page and the offer upkeep share (a8: they used to differ). */
  magmaReport(key: string = this.amboss.getKey()): Promise<MagmaV2Report> {
    return getMagmaRecommendations(this.readLnd, key, this.magmaOverrides());
  }

  /** What this node could list on Magma now: the coins after the effective
   *  reserve (D5) and every promised order, within the deploy cap's headroom;
   *  and the largest single channel of that (the max-channel cap).
   *  `refreshDeployed: false` takes the deploy cap's share as the ledger last
   *  knew it (the order lane and the main run keep it current) instead of
   *  asking Amboss — for callers that must not wait on Amboss (the Overview). */
  async sellCapital(opts: { refreshDeployed?: boolean } = {}): Promise<{ listableSat: number; maxChannelSat: number }> {
    const cfg = this.state.config;
    // The deploy cap's share of channels sold and still leased (Amboss).
    if (opts.refreshDeployed !== false && this.amboss.hasKey()) await this.magma.refreshDeployed().catch(() => undefined);
    const sp = await spendableOnchain(this.readLnd, this.capital, cfg.sellReserveSats);
    const headroom = Math.max(0, cfg.sellMaxDeploySats - this.capital.deployedSat() - this.capital.reservedSat());
    const listableSat = floor10k(Math.min(sp.spendableSat, headroom));
    return { listableSat, maxChannelSat: floor10k(Math.min(listableSat, cfg.sellMaxChannelSats)) };
  }

  /** Can this node realistically sell on Magma (D8)? From Amboss's public
   *  book (cached a day) and the capital it could list now. */
  async magmaEligibility(force = false): Promise<Eligibility> {
    const own = await getOwnPubkey(this.readLnd);
    const [capital, book] = await Promise.all([this.sellCapital(), publicBook(own, force).catch(() => null)]);
    const result = assessEligibility(book, capital);
    this.lastEligibility = result;
    return result;
  }

  /** Better than "not realistic"? (D8/D10) Unknown counts as no: nothing is
   *  listed, and no capital held back, on evidence that isn't there. */
  private async sellingRealistic(): Promise<{ ok: boolean; why: string; eligibility: Eligibility | null }> {
    let e: Eligibility | null = null;
    try {
      e = await this.magmaEligibility();
    } catch (err) {
      return { ok: false, why: `the selling check could not be made (${errText(err)})`, eligibility: null };
    }
    if (e.verdict === "possible_but_slow" || e.verdict === "realistic") return { ok: true, why: e.reasons[0] ?? "", eligibility: e };
    return {
      ok: false,
      why:
        e.verdict === "unknown"
          ? `the selling check has no answer (${e.reasons[0] ?? "no public data"})`
          : `selling is not realistic for this node yet — ${e.reasons[0] ?? ""}`,
      eligibility: e,
    };
  }

  /**
   * Leave this capital for Magma instead of a routing open? A reason when
   * yes, null when no (D10, a3-channels). Only when ALL hold:
   *  - Magma can take it: a key Amboss accepts, and an offer of this node
   *    listed (enabled) as of the last upkeep;
   *  - selling is better than "not realistic" (the eligibility check, D8);
   *  - the lease income this capital can expect — offers like this node's
   *    fill ~N times a year, each netting the clearing price of comparable
   *    leases minus the on-chain costs and the service fee — beats what a new
   *    routing channel is expected to earn (the median yield of this node's
   *    channels older than 30 days).
   * No data, no deferral: without a routing history (no channel older than
   * 30 days) or a clearing price, the open goes ahead — a node can always
   * open its first channels.
   */
  private async leaveForMagma(): Promise<string | null> {
    if (!this.amboss.hasKey() || this.amboss.getValidity() === false) return null;
    const listed = (this.state.offerSync?.offers ?? []).some((e) => e.amboss.status === "ENABLED");
    if (!listed) return null;
    const realistic = await this.sellingRealistic();
    const e = realistic.eligibility;
    if (!realistic.ok || !e?.comparable || e.own.listableSat <= 0) return null;
    const fillsPerYear = e.comparable.fillsPerMonth * 12;
    const clearing = clearingFor({ minSizeSat: 0, maxSizeSat: Math.max(1, e.own.maxChannelSat || e.own.listableSat) });
    if (!clearing || fillsPerYear <= 0) return null;
    const fillSize = Math.min(e.own.maxChannelSat || e.own.listableSat, clearing.medianSizeSat);
    const costs = await onchainCosts(this.readLnd);
    const netPerFill =
      clearing.medianApr * fillSize * (DEFAULT_LEASE_BLOCKS / BLOCKS_PER_YEAR) * (1 - saleFeeConfig().bps / 10_000) -
      costs.openCostSat -
      costs.closeCostSat;
    if (netPerFill <= 0) return null;
    const leasePpmYear = Math.round(((fillsPerYear * netPerFill) / e.own.listableSat) * 1_000_000);
    const [chans, report, info] = await Promise.all([
      getChannelsView(this.readLnd),
      getForwardsReport(this.readLnd, 30),
      getWalletInfo({ lnd: this.readLnd }),
    ]);
    // Channels with a month of history (≈ 4320 blocks) say what a channel earns.
    const aged = chans.filter((c) => {
      const funded = Number(c.id.split("x")[0]);
      return c.active && c.status === "open" && Number.isFinite(funded) && funded > 0 && info.current_block_height - funded >= 4_320;
    });
    if (aged.length === 0) return null;
    const revByChan = new Map(report.perChannel.map((c) => [c.channelId, c.feesEarnedSats]));
    const routing = routingYieldStats(aged, revByChan).medianPpmYear;
    if (leasePpmYear <= routing) return null;
    return (
      `deferred: selling on Magma is expected to earn more on this capital (~${leasePpmYear} ppm/yr: offers like yours ` +
      `fill ~${fillsPerYear.toFixed(1)} times a year) than a new routing channel (~${routing} ppm/yr) — left for Magma`
    );
  }

  /**
   * The Overview's lease benchmark (D12): the clearing rate of comparable
   * sales where this node can sell, else that it can't yet. Never throws —
   * and never waits for Amboss: the Overview loads on LND alone. Before, every
   * Overview load (each minute, for every user, Magma user or not) asked
   * Amboss for this node's sold capital and, with no answer cached, for the
   * public book — so while Amboss was slow or down the KPIs, activity and
   * autopilot tiles waited out its query deadline (15 s) on every load.
   *
   * Now it is judged from what is cached: the public book (a day; a missing or
   * old copy is fetched in the background for the next load, and a failed
   * fetch is not repeated for 15 minutes) and the capital as the ledger knows
   * it (no sold-capital listing is fetched here). Only a cold cache gets a
   * short look — BENCHMARK_WAIT_MS — at the fetch it starts.
   */
  async leaseBenchmark(): Promise<LeaseBenchmark> {
    let e: Eligibility | null = null;
    let failed = false;
    try {
      const own = await getOwnPubkey(this.readLnd);
      const cached = cachedPublicBook(own);
      let book = cached?.book ?? null;
      if (!cached?.fresh) {
        // Deduplicated with any fetch under way; never rejects.
        const fetching = publicBook(own).catch(() => null);
        if (!book) book = await withinMs(fetching, BENCHMARK_WAIT_MS);
      }
      failed = !book && publicBookFailure(own) !== null;
      if (book) e = assessEligibility(book, await this.sellCapital({ refreshDeployed: false }));
    } catch {
      e = null; // LND could not say (the rest of the Overview shows that)
    }
    if (!e || e.verdict === "unknown") {
      return {
        status: "unknown",
        grossAprPct: null,
        sales: null,
        windowDays: null,
        text: failed ? "the Magma market could not be read — asked again in a few minutes" : "the Magma market is being read",
      };
    }
    if (e.verdict === "not_realistic") {
      return {
        status: "not_realistic",
        grossAprPct: null,
        sales: null,
        windowDays: null,
        text: "Magma selling is not realistic for this node yet — offers like yours don't sell",
      };
    }
    const clearing = clearingFor({ minSizeSat: 0, maxSizeSat: Math.max(1, e.own.maxChannelSat || e.own.listableSat) });
    if (!clearing) return { status: "no_data", grossAprPct: null, sales: null, windowDays: null, text: "no completed Magma leases of your size to compare with" };
    const pct = Math.round(clearing.medianApr * 10_000) / 100;
    return {
      status: "eligible",
      grossAprPct: pct,
      sales: clearing.count,
      windowDays: clearing.windowDays,
      text: `comparable Magma leases cleared at ~${pct}%/yr (gross, what buyers paid — ${clearing.count} sales in ${clearing.windowDays} days)`,
    };
  }

  /** The latest eligibility the autopilot computed (null until it has). */
  lastEligibility: Eligibility | null = null;

  /** The latest decision NOT to act, per area, with its reason (D16; the
   *  full per-area status is a later package's — this is its seed). */
  private decisionNote(area: DecisionArea, text: string): void {
    (this.state.decisions ??= {})[area] = { at: new Date().toISOString(), text };
  }

  private syncState(): OfferSyncStatus {
    this.state.offerSync ??= { at: null, managed: this.state.config.sellEnabled, offers: [], lastError: null };
    return this.state.offerSync;
  }

  /** One offer's sync record: what Amboss has, what is wanted, the last write
   *  — and notes on what the autopilot left as it is, and why. */
  private syncEntry(off: MyOffer, wanted: OfferFields | null, write?: OfferWrite, note?: string | string[]): OfferSyncEntry {
    const have = fieldsOf(off);
    const prev = this.state.offerSync?.offers.find((e) => e.offerId === off.id);
    const differences = offerDifferences(have, wanted);
    if (note) differences.push(...[note].flat());
    const control = this.offerControlOf(off.id);
    return {
      offerId: off.id,
      checkedAt: new Date().toISOString(),
      amboss: have,
      wanted,
      inSync: wanted !== null && differences.length === 0,
      differences,
      lastWrite: write ?? prev?.lastWrite ?? null,
      ...(Object.keys(control).length ? { control } : {}),
    };
  }

  /** What the autopilot wants for each offer vs what Amboss has (for the UI),
   *  with who owns each offer's terms as of now. */
  offerSyncStatus(): OfferSyncStatus {
    const s = this.state.offerSync ?? { at: null, managed: false, offers: [], lastError: null };
    const offers = s.offers.map((e) => {
      const control = this.offerControlOf(e.offerId);
      const { control: _old, ...rest } = e;
      return Object.keys(control).length ? { ...rest, control } : rest;
    });
    return { ...s, offers, managed: this.state.config.sellEnabled && this.amboss.hasKey() };
  }

  /** Who owns each offer's terms (for offers the sync status hasn't seen yet). */
  offerControls(): Record<string, OfferControl> {
    return { ...(this.state.offerControl ?? {}) };
  }

  /** A manual offer write (Market → Sell): kept with the sync status, so the
   *  last result of every write is visible, whoever made it. */
  recordOfferWrite(off: MyOffer | null, offerId: string, write: OfferWrite): void {
    // The operator chose new terms: those are the offer's intent now. If they
    // exceed what can be funded, the next upkeep cuts them — and remembers
    // them as what to give back.
    if (write.ok && write.action !== "enable" && write.action !== "disable") this.keepCut(offerId, null);
    const sync = this.syncState();
    const i = sync.offers.findIndex((e) => e.offerId === offerId);
    const entry: OfferSyncEntry = off
      ? { ...this.syncEntry(off, sync.offers[i]?.wanted ?? null, write) }
      : { ...(sync.offers[i] ?? { offerId, checkedAt: write.at, amboss: emptyFields(), wanted: null, inSync: false, differences: [] }), lastWrite: write };
    if (i >= 0) sync.offers[i] = entry;
    else sync.offers.push(entry);
    this.persist();
  }

  /** The Magma order lane (every 45 s, see startOrderLane): accept, open,
   *  report, settle, cancel and reject — through the order journal, never
   *  through the main run's lock. Then, apart from it, the purchases. */
  async pollSellOrders(): Promise<void> {
    if (this.shuttingDown || !this.writeLnd) return;
    let sells: AutopilotSell[] | null = null;
    try {
      sells = await this.magma.tick();
    } catch (err) {
      console.error("[autopilot] order lane failed:", err);
    }
    if (sells) this.recordLanePass(sells);
    // After the pass is on record, never inside it (see followPurchases).
    await this.followPurchases();
  }

  /** The lane pass's line in the run history. Skips are explained on each
   *  order (journal), not in the run history — and so is a failure that only
   *  repeats (see laneNews). */
  private recordLanePass(sells: AutopilotSell[]): void {
    const acted = this.laneNews(sells.filter((s) => s.action !== "skip"));
    if (!acted.length) return;
    const run: AutopilotRun = {
      at: new Date().toISOString(),
      attempted: acted.length,
      applied: acted.filter((s) => s.ok).length,
      failed: acted.filter((s) => !s.ok).length,
      changes: [],
      rebalances: [],
      channels: [],
      sells: acted,
    };
    // Not lastRunAt: that is the main run's, and a lane that acts every 45 s
    // would hide a main run that stopped (the lane has magmaLane.lastTickAt).
    this.state.history.unshift(run);
    this.state.history = this.state.history.slice(0, HISTORY_LIMIT);
    this.persist();
  }

  /**
   * Inbound bought here, followed to its end even with the Buy tab closed or
   * after a restart: LND is asked by payment hash how each payment that
   * hasn't told its end stands (no Amboss key needed), and Amboss how each
   * paid order stands — until the record matches what both report.
   *
   * Apart from the order lane's critical path (P1b review): it runs after the
   * lane's pass is on record, has its own busy flag (a slow Amboss can't
   * stack follow-ups on the 45 s timer), reads a few at a time in parallel,
   * starts no read once shutdown began and drops answers that arrive after
   * it (nothing is lost: the next start asks again). Before, up to five
   * sequential Amboss reads ran inside the lane's pass — up to 75 s with
   * Amboss slow — before its run history was written, outside any busy flag.
   */
  async followPurchases(): Promise<void> {
    if (this.followingPurchases || this.shuttingDown) return;
    this.followingPurchases = true;
    try {
      const { payments } = this.purchases.followUps();
      await eachBounded(payments, PURCHASE_FOLLOW_PARALLEL, () => this.shuttingDown, async (p) => {
        const report = await this.purchasePaymentReport(p.paymentHash);
        if (!this.shuttingDown) this.purchases.paymentOutcome(p.orderId, report);
      });
      if (!this.amboss.hasKey()) return;
      const key = this.amboss.getKey();
      const { orders } = this.purchases.followUps();
      await eachBounded(orders, PURCHASE_FOLLOW_PARALLEL, () => this.shuttingDown, async (p) => {
        const order = await getOrder(key, p.orderId);
        if (!this.shuttingDown) this.purchases.fromOrder(p.orderId, order);
      });
    } finally {
      this.followingPurchases = false;
    }
  }

  /** How a purchase's payment stands in LND (by payment hash). */
  private async purchasePaymentReport(id: string): Promise<PaymentReport> {
    try {
      const p = await getPayment({ lnd: this.writeLnd ?? this.readLnd, id });
      if (p.is_confirmed && p.payment) return { status: "succeeded", feeSats: p.payment.safe_fee ?? p.payment.fee, at: p.payment.confirmed_at };
      if (p.is_failed) return { status: "failed", error: "LND reports the payment failed", confirmed: true };
      return { status: "in_flight" };
    } catch (err) {
      // 404 SentPaymentNotFound: LND has no payment with this hash.
      if (Array.isArray(err) && err[0] === 404) return { status: "not_found" };
      throw err;
    }
  }

  /**
   * The lane's actions worth a line in the run history: whatever moved an
   * order on, and the FIRST of a run of identical failures. A held order
   * waiting for capital, or an Amboss outage, fails the same way every 45 s;
   * before, those retries filled the 50-run history within the hour and
   * pushed out the fee runs the elasticity learner reads. Each retry stays on
   * the order's own record (the journal). Amounts in the text don't count as
   * a change ("1,949,000 sat spendable" vs "1,948,000").
   */
  private laneNews(actions: AutopilotSell[]): AutopilotSell[] {
    const news: AutopilotSell[] = [];
    for (const a of actions) {
      const sig = `${a.action}:${a.ok}:${(a.error ?? "").replace(/\d[\d,.]*/g, "#")}`;
      if (a.ok) this.laneLast.delete(a.orderId);
      else if (this.laneLast.get(a.orderId) === sig) continue;
      else this.laneLast.set(a.orderId, sig);
      news.push(a);
    }
    // Bounded: orders long finished drop out first.
    while (this.laneLast.size > 500) this.laneLast.delete(this.laneLast.keys().next().value as string);
    return news;
  }

  /** Run the autopilot once: fees, then rebalances, then channel opens, then
   *  Magma offer upkeep (each if enabled). */
  async runOnce(): Promise<AutopilotRun> {
    const emptyRun: AutopilotRun = {
      at: new Date().toISOString(),
      attempted: 0,
      applied: 0,
      failed: 0,
      changes: [],
      rebalances: [],
      channels: [],
      sells: [],
    };
    // Keep Amboss's real sale history warm on every tick, even read-only, so the
    // Market page and the pricing engine always have something to price against.
    // Self-throttled to a few hours inside the service; never throws.
    if (this.shuttingDown) return emptyRun;
    void refreshMagmaHistory();
    if (this.running || !this.writeLnd) return emptyRun;
    this.running = true;
    this.runningSince = new Date().toISOString();
    const writeLnd = this.writeLnd;
    const errors: { stage: string; error: string }[] = [];

    // After a shutdown signal no further stage starts; inside a stage, every
    // payment, channel open and offer write checks again before it begins.
    // Each stage stands alone: one that throws is recorded and the others
    // still run (before, a failing fee stage also skipped Magma offer upkeep).
    const stage = async <T>(name: string, on: boolean, run: () => Promise<T[]>): Promise<T[]> => {
      if (!on || this.shuttingDown) return [];
      try {
        return await run();
      } catch (err) {
        console.error(`[autopilot] ${name} stage failed:`, err);
        errors.push({ stage: name, error: errText(err) });
        return [];
      }
    };

    try {
      // Rebalance payments we stopped waiting for: learn how they ended — on
      // EVERY run, whatever the rebalance window or switch says. (Inside the
      // rebalance stage this ran only within the window, with rebalancing on:
      // a payment left in flight could stay unreconciled, its maximum fee
      // charged to the budget, for as long as rebalancing stayed off.)
      await stage("rebalance bookkeeping", (this.state.pendingRebalances ?? []).length > 0, async () => {
        await this.reconcilePendingRebalances();
        return [];
      });
      const changes = [
        ...(await stage("fees", this.state.config.enabled, () => this.runFees(writeLnd))),
        // D7 with fee automation off: the routing-fee promises of sold
        // channels are still kept — LND's default fee or a change made with
        // another tool can sit above a cap. Only a breach is touched, and only
        // lowered to the cap; every other fee stays the operator's.
        ...(await stage("lease promises", !this.state.config.enabled && this.capital.leaseCaps().length > 0, () =>
          this.keepLeasePromises(writeLnd),
        )),
      ];
      const rebalances = await stage("rebalancing", this.state.config.rebalanceEnabled, () => this.runRebalances(writeLnd));
      const channels = await stage("channels", this.state.config.channelEnabled, () => this.runChannels(writeLnd));
      const sells = await stage("magma", true, () => this.runSell());
      // Advertised-size upkeep: only gossips when a channel's bucket moved.
      const maxHtlc = await stage("max_htlc", this.state.config.maxHtlcEnabled, () =>
        runMaxHtlcPass(this.readLnd, writeLnd, this.maxHtlcBackoff).catch(() => [] as MaxHtlcChange[]),
      );
      // "skip" entries are non-actions (cap/reserve) — don't count them as attempts.
      const acted = sells.filter((s) => s.action !== "skip");

      const run: AutopilotRun = {
        at: new Date().toISOString(),
        attempted: changes.length + rebalances.length + channels.length + acted.length + maxHtlc.length + errors.length,
        applied:
          changes.filter((c) => c.ok).length +
          rebalances.filter((r) => r.ok).length +
          channels.filter((c) => c.ok).length +
          acted.filter((s) => s.ok).length +
          maxHtlc.filter((m) => m.ok).length,
        failed:
          changes.filter((c) => !c.ok).length +
          rebalances.filter((r) => !r.ok).length +
          channels.filter((c) => !c.ok).length +
          acted.filter((s) => !s.ok).length +
          maxHtlc.filter((m) => !m.ok).length +
          errors.length,
        changes,
        rebalances,
        channels,
        sells,
        maxHtlc,
        ...(errors.length ? { errors } : {}),
      };

      this.state.lastRunAt = run.at;
      // Only record runs that actually did something (applied or failed) — skip the
      // hourly no-op runs so the history shows changes, not "0 applied" every hour.
      if (run.attempted > 0) {
        this.state.history.unshift(run);
        this.state.history = this.state.history.slice(0, HISTORY_LIMIT);
      }
      return run;
    } finally {
      // Also on a failed stage: whatever earlier stages recorded (fee cooldowns,
      // rebalance spend, flow anchors) must reach the disk.
      this.persist();
      this.running = false;
      this.runningSince = null;
    }
  }

  // ── node seams ─────────────────────────────────────────────────────────────
  // The planning reads and the node writes of the money-moving stages go
  // through these one-liners (as LSPS1's LND seams do), so a test can drive a
  // whole run without building a routing node with history and a network graph.

  private feeReport(elasticity: Map<string, number>, marketWaitMs?: number) {
    return getFeeRecommendations(
      this.readLnd,
      // The refills the profit floor can stand on — all of them, however
      // many failed attempts the log holds.
      this.rebalanceLog.successes(floorWindowStart()),
      this.feeCooldown(),
      this.feeV2Overrides(),
      this.overrides.all(),
      elasticity,
      this.flowAnchors(),
      this.capital.leaseCaps(),
      marketWaitMs !== undefined ? { marketWaitMs } : {},
    );
  }
  private feeApply(writeLnd: AuthenticatedLnd, items: FeeApplyItem[]) {
    // The last gate: a sold channel's fee never leaves its lease promise.
    return applyFees(this.readLnd, writeLnd, items, this.capital.leaseCaps());
  }
  /** The rebalance plan, from the same fee-engine inputs the fee stage
   *  uses — so the fee the gate expects after a refill is the one the
   *  autopilot will charge — and from every channel sold through Magma or
   *  LSPS1 (never a source). The one place its inputs are built: the
   *  Rebalancing tab (rebalanceRecommendations) and the stage share it. */
  private async rebalanceReport(): Promise<Pick<RebalanceRecReport, "recommendations"> & Partial<RebalanceRecReport>> {
    return getRebalanceRecommendations(
      this.readLnd,
      {
        rebalanceRecords: this.rebalanceLog.successes(floorWindowStart()),
        cooldown: this.feeCooldown(),
        configOverrides: this.feeV2Overrides(),
        channelOverrides: this.overrides.all(),
        elasticity: await this.feeElasticityModifiers(),
        flowAnchors: this.flowAnchors(),
        leaseCaps: this.capital.leaseCaps(),
      },
      { recOverrides: this.rebalanceRecOverrides(), soldLeases: this.capital.soldLeases() },
    );
  }
  private rebalanceExec(writeLnd: AuthenticatedLnd, params: RebalanceExecParams, opts: RebalanceExecOptions = {}) {
    return executeRebalance(this.readLnd, writeLnd, params, opts);
  }
  /** How a rebalance payment we stopped waiting for has ended. */
  private async rebalancePaymentStatus(
    id: string,
  ): Promise<{ state: "confirmed"; feeSats: number } | { state: "failed" | "pending" }> {
    try {
      const p = await getPayment({ lnd: this.writeLnd ?? this.readLnd, id });
      if (p.is_confirmed && p.payment) return { state: "confirmed", feeSats: p.payment.safe_fee ?? p.payment.fee };
      return { state: p.is_failed ? "failed" : "pending" };
    } catch (err) {
      // 404 SentPaymentNotFound: it never reached LND.
      if (Array.isArray(err) && err[0] === 404) return { state: "failed" };
      throw err;
    }
  }
  private channelSuggestions() {
    return getChannelSuggestionsV2(this.readLnd, {}, this.lnplus);
  }

  private persist(): void {
    this.store.write(this.state);
  }
}
