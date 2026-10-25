import { getChainBalance, getChainFeeRate, getChannels, getFeeRates, getPayment, getPeers, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { JsonStore, recordStoreIncident } from "../store.js";
import {
  checkPeerListing,
  connectForOpen,
  fundChannel,
  isPermissionDenied,
  isPreBroadcastRefusal,
  isUnreachable,
  nodeSideRefusal,
  opensBlocked,
  peerMaxChannelFromError,
  peerMinChannelFromError,
} from "./channelOps.js";
import { isAuthError } from "./amboss.js";
import { NO_EXTRA_TERMS, createOffer, getMyOffer, getMyOffers, termsOf, toggleOffer, updateOffer, type MyOffer, type OfferTerms } from "./magmaApi.js";
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
import { MagmaPurchases, type MagmaPurchase, type PaymentReport } from "./magmaPurchases.js";
import { ChannelUptime } from "./channelUptime.js";
import { CloseTxArchive } from "./closeTxArchive.js";
import type { LeaseSources } from "./leases.js";
import { getOrder } from "./amboss.js";
import { runMaxHtlcPass, type MaxHtlcChange } from "./maxHtlc.js";
import { saleFeeConfig, type ServiceFeeLedger } from "./serviceFee.js";
import type { AmbossStore } from "./ambossStore.js";
import { errorText } from "./errorText.js";
import { logLine } from "./log.js";
import { getOwnPubkey } from "./node.js";
import { torVia } from "./http.js";
import { getChannelSuggestionsV2, type SuggestionV2 } from "./suggestRecommend.js";
import {
  AUTO_SIZE_MIN_SATS,
  MAX_CAPITAL_SHARE_PER_OPEN,
  MAX_OPEN_TRIES_PER_RUN,
  OPEN_CONF_TARGET,
  OPEN_DIAL_BUDGET_MS,
  PEER_BACKOFF_DAYS,
  PEER_RECORDS_KEPT,
  magmaFillsPerYear,
  measuredYield,
  monthOldChannels,
  planOpen,
  unmeasuredYieldText,
  type OpenContext,
  type PeerOpenRecord,
  type YieldEvidence,
} from "./openPlan.js";
import type { LnPlusStore } from "./lnplusStore.js";
import { getMagmaRecommendations, preferredBaseFeeSats, saleAcceptFloorSats, saleCostFloorSats, type MagmaV2Report, type MagmaSellRecommendation } from "./magmaRecommend.js";
import { onchainCosts } from "./nodeEconomics.js";
import { getFeeElasticity } from "./outcomes.js";
import { DEFAULT_POLICY, applyFees, type FeeApplyItem, type FeeApplyResult } from "./fees.js";
import {
  FEE_REC_DEFAULTS,
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

/**
 * A manual refill run from a plan older than the target's last refill (or
 * attempt): refused before anything is sent — the API answers 409 and the
 * Rebalancing tab reloads its plan. The tab loads its plan once; after the
 * autopilot refilled that target, the row's Run button paid a second refill
 * into it at once, valued on the same 14-day outflow as the first (review
 * of P3). A plan made after the last refill still bypasses the cooldown on
 * purpose: an explicit run.
 */
export class StalePlanError extends Error {
  constructor(
    readonly targetId: string,
    /** When the target was last refilled (or tried). */
    readonly lastAt: string,
    /** When the plan the request came from was made. */
    readonly planAt: string,
  ) {
    super("This channel was refilled (or tried) after this plan was made: reload it");
    this.name = "StalePlanError";
  }
}

/** The hold a refill is booked with: the gate's value — never above the
 *  fee the target really charged when the refill was sent. A gate from a
 *  plan made before the fee dropped valued the sats above what they sell
 *  for now, and the fee engine would ramp the fee back up toward that hold
 *  (review of P3). The autopilot's own gate is never above the fee. */
function heldAt(gatePpm: number | null | undefined, targetPpm: number | undefined): number | null | undefined {
  if (gatePpm == null || targetPpm === undefined) return gatePpm;
  return Math.min(gatePpm, targetPpm);
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
  /** Failed the same way as the last attempt on this channel: counted in
   *  the pass's own result, left out of the run history (not news). */
  repeat?: boolean;
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
  /** Sent, and LND hasn't said how it ended yet: no failure (yet) — the run
   *  counts it as neither applied nor failed, and a later run books it. */
  inFlight?: boolean;
}

export interface AutopilotChannelOpen {
  alias: string;
  sizeSats: number;
  ok: boolean;
  transactionId?: string;
  error?: string;
  /** Failed the same way as the last open of its kind (to that peer, or
   *  this node's own trouble): counted in the pass's own result, left out
   *  of the run history (channelNews). */
  repeat?: boolean;
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
   *  engine) no longer skips the others, Magma offer upkeep included. The
   *  run runOnce returns lists every one; its line in the run history only
   *  those that are news (the same failure again is not). */
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
 *    operator chose. Switching Liquidity provision on is such a choice too:
 *    every offer disabled then is listed again once it has a price and can be
 *    funded (listOnAt) — the switch-off disables them, so before, switching
 *    back on left each to be enabled by hand. A status click never takes
 *    the terms over: before, a manual ENABLE made the offer "yours", so the
 *    autopilot stopped fixing its lease and promise — and never listed it
 *    again after a capital dip.
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
  /** The autopilot took it off the market because Amboss listed it for free
   *  (0 ppm + 0 sat) with no price of its own to put back: it stays disabled
   *  until the operator gives it a price and lists it again. */
  freeDisabledAt?: string;
  /** Liquidity provision was switched on (when) while the offer was disabled:
   *  the autopilot lists it once it has a price and its smallest channel can
   *  be funded — its terms stay with whoever has them. A click on it ends
   *  this (a disable sticks again), and so does switching selling off. */
  listOnAt?: string;
}

/** A base-fee clock (PersistedState.offerBaseMoves). */
interface BaseMove {
  /** The base the market charges (the comparable offers' median). */
  base: number;
  /** The offer's base when the clock started: one moved since is another difference. */
  offerBase: number;
  since: string;
}

/** The last write to an offer (autopilot or manual) and what came of it. */
export interface OfferWrite {
  at: string;
  by: "autopilot" | "manual";
  action: "create" | "update" | "enable" | "disable";
  /** The fields sent, as Amboss names them — for a terms write, all of them
   *  (updateOffer: Amboss resets what an update leaves out). */
  fields: Record<string, number | string>;
  /** Of those, the ones this write changed (a terms update by the autopilot). */
  changed?: string[];
  ok: boolean;
  error?: string;
  /** Re-read afterwards: does Amboss hold every term that was sent? */
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
  /** It is to be listed again but waits for the autopilot's price: none this
   *  run ("report"), or its lease is one the autopilot doesn't price — which
   *  only the operator can change ("lease", an alert). */
  listingWaits?: "report" | "lease";
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
  /** Fee updates that failed, per channel: not retried before `until` (the
   *  engine's guard, via feeCooldown), and the failure — the same one again
   *  is not news for the run history (writeFees). Saved: a restart (every
   *  Umbrel update) no longer sends an update LND keeps refusing once more
   *  at once (review 2026-10-25). */
  perChannelFeeRetry?: Record<string, { until: string; error: string }>;
  perTargetLastRebalanced: Record<string, string>;
  lastChannelOpenAt: string | null;
  /** Set when the open behind lastChannelOpenAt ended unclearly (the peer's
   *  alias): its funding may have been broadcast, so the cooldown runs as
   *  after an open — the note says which open it was. */
  lastChannelOpenUnclear?: string | null;
  /** An automatic open handed to LND and not answered yet (write-ahead, set
   *  right before the call): found at the next channel stage — the process
   *  went down mid-open — it counts as an open that ended unclearly
   *  (validOpening). */
  channelOpening?: OpeningRecord | null;
  /** The channel stage's last Magma comparison (leaveForMagma): reused for
   *  up to MAGMA_HOLD_KEEP_MS when Amboss's public book can't be read
   *  (validHold). */
  magmaHold?: MagmaHold | null;
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
  /** Failed refills per source → target pair ("src>tgt"): that pair backs
   *  off (cooldown × 2^fails, at most ×8); the target's other sources don't
   *  (review a2: one dead route blocked the target for days). */
  perPairRebalanceFails?: Record<string, { fails: number; at: string }>;
  /** Rebalance payments still in flight when we stopped waiting. */
  pendingRebalances?: PendingRebalance[];
  /** Offer sync status (engine's wishes vs Amboss), see OfferSyncStatus. */
  offerSync?: OfferSyncStatus;
  /** Each offer's last price that wasn't free (0 ppm + 0 sat), as read or
   *  written — what is put back when Amboss lists it for free (rememberPrice). */
  offerPrices?: Record<string, { feeRatePpm: number; baseFeeSats: number; at: string }>;
  /** Per offer: what a capital cut took, to give back (see OfferCut). */
  offerCuts?: Record<string, OfferCut>;
  /** Per offer: who owns its terms (see OfferControl). */
  offerControl?: Record<string, OfferControl>;
  /** Liquidity provision was switched on, and the offer upkeep hasn't read
   *  the offers since: when, and which offers LightningMate's last offer sync
   *  showed disabled at that moment (null: there was no sync to go by) — the
   *  ones to be listed again (OfferControl.listOnAt, applySwitchOn). */
  sellSwitchOn?: { at: string; disabled: string[] | null } | null;
  /** Per offer: the base the market charges while it differs from the
   *  offer's beyond the tolerance, since when it has stood at that level,
   *  and the offer's base it was started against (magmaRecommend
   *  baseFeeFollow, trackBaseMoves). */
  offerBaseMoves?: Record<string, BaseMove>;
  /** Per offer: when the autopilot last moved its base fee (a verified
   *  write) — at most one move per BASE_FEE_MOVE_GAP_MS. */
  offerBaseMovedAt?: Record<string, string>;
  /** Per area: its latest decision and why (decisionNote) — what it did, or
   *  why it did nothing (D16). */
  decisions?: Partial<Record<DecisionArea, AreaDecision>>;
  /** What the main run's last pass did — every pass, the ones that did
   *  nothing too (the run history keeps only those that did something). */
  lastRun?: RunSummary;
  /** "Pause all automation": when, and which switches were on then — what
   *  "Resume" switches back on (selling excepted, see resumeAll). Cleared by
   *  a resume, or once the operator switches anything on by hand. */
  paused?: { at: string; was: AutomationSwitch[] } | null;
  /** Peers that refused an automatic open, by pubkey: each waits out its
   *  back-off, and the size limits its refusal named are met next time
   *  (openPlan.ts). A successful open forgets the record. */
  peerOpenFailures?: Record<string, PeerOpenRecord>;
  /** Peers the operator never wants opened to automatically (Channels →
   *  suggestions), by pubkey. */
  neverOpen?: Record<string, { alias: string; at: string }>;
  history: AutopilotRun[];
}

/** The switches that make the autopilot act on its own — every one of them
 *  "Pause all automation" turns off. */
export const AUTOMATION_SWITCHES = ["enabled", "rebalanceEnabled", "channelEnabled", "maxHtlcEnabled", "sellEnabled"] as const;
export type AutomationSwitch = (typeof AUTOMATION_SWITCHES)[number];

/** Each switch in words, for "… was switched off during the run". */
const SWITCH_WORDS: Record<AutomationSwitch, string> = {
  enabled: "fee automation",
  rebalanceEnabled: "auto-rebalance",
  channelEnabled: "the channel autopilot",
  maxHtlcEnabled: "advertising routable size",
  sellEnabled: "Liquidity provision",
};

/**
 * A "Pause all automation" record as it was saved, made safe: only the
 * known switches, each once, and a time that parses — or null. "Resume"
 * switches on exactly what this lists, so a file edited by hand (or left
 * half-written by another version) must not name config keys of its own.
 */
export function sanitizePaused(raw: unknown): { at: string; was: AutomationSwitch[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { at?: unknown; was?: unknown };
  if (typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at))) return null;
  const listed = Array.isArray(r.was) ? r.was : [];
  const was = AUTOMATION_SWITCHES.filter((k) => listed.includes(k));
  return { at: r.at, was };
}

const validTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const validSats = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * A switch-on not yet applied, as it was saved, made safe: a time that
 * parses and a list of offer ids — or no list (null: no offer sync to go by,
 * so every offer disabled at the first read is listed). A list that isn't
 * one counts as none; without a time there is no switch-on to apply.
 */
export function sanitizeSellSwitchOn(raw: unknown): { at: string; disabled: string[] | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { at?: unknown; disabled?: unknown };
  if (!validTime(r.at)) return null;
  const disabled = Array.isArray(r.disabled) ? r.disabled.filter((id): id is string => typeof id === "string") : null;
  return { at: r.at, disabled };
}

/** The base-fee clocks as they were saved, made safe: only entries with a
 *  base, an offer base and a time that parses (the engine reads them). */
export function sanitizeBaseMoves(raw: unknown): Record<string, BaseMove> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, BaseMove> = {};
  for (const [id, m] of Object.entries(raw as Record<string, unknown>)) {
    if (!m || typeof m !== "object") continue;
    const e = m as { base?: unknown; offerBase?: unknown; since?: unknown };
    if (validSats(e.base) && validSats(e.offerBase) && validTime(e.since)) out[id] = { base: e.base, offerBase: e.offerBase, since: e.since };
  }
  return out;
}

/** An automatic open handed to LND (PersistedState.channelOpening). */
export interface OpeningRecord {
  pubkey: string;
  alias: string;
  sizeSats: number;
  at: string;
}

/** The channel stage's Magma comparison (PersistedState.magmaHold): when it
 *  was made, what it held for Magma (sat) and its note (null: nothing held). */
export interface MagmaHold {
  at: string;
  heldSat: number;
  text: string | null;
}

/** A saved Magma comparison stands this long when Amboss's public book can't
 *  be read; past it nothing is held for Magma (and the note says so). */
export const MAGMA_HOLD_KEEP_MS = 24 * 3_600_000;

/** The shared on-chain lock held this long raises an alert (onchainLockAlerts). */
export const ONCHAIN_LOCK_ALERT_MS = 10 * 60_000;

/** A saved write-ahead record, made safe (read where it is used: a damaged
 *  value is no open in flight). */
export function validOpening(raw: unknown): OpeningRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<Record<keyof OpeningRecord, unknown>>;
  if (typeof o.pubkey !== "string" || typeof o.alias !== "string" || !validTime(o.at)) return null;
  const sizeSats = typeof o.sizeSats === "number" && Number.isFinite(o.sizeSats) && o.sizeSats > 0 ? o.sizeSats : 0;
  return { pubkey: o.pubkey, alias: o.alias, sizeSats, at: o.at };
}

/** A saved Magma comparison, made safe (null: none usable). */
export function validHold(raw: unknown): MagmaHold | null {
  if (!raw || typeof raw !== "object") return null;
  const h = raw as Partial<Record<keyof MagmaHold, unknown>>;
  if (!validTime(h.at) || typeof h.heldSat !== "number" || !Number.isFinite(h.heldSat) || h.heldSat < 0) return null;
  if (h.text !== null && typeof h.text !== "string") return null;
  return { at: h.at, heldSat: Math.floor(h.heldSat), text: h.text ?? null };
}

/** Per-id times as they were saved, made safe: only those that parse. */
export function sanitizeTimes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter((e): e is [string, string] => validTime(e[1])));
}

/** The areas of the autopilot that keep a "last decision" (D16). */
export type DecisionArea = "fees" | "rebalance" | "channels" | "magma" | "maxHtlc";

/**
 * What an area did with its last chance to act:
 *  - acted: it changed something (a fee, a refill, an open, an offer);
 *  - idle: it looked, and nothing needed doing;
 *  - waiting: there is something to do, held back until a condition passes
 *    (a cooldown, the hours, the budget, the fee rate, the funds);
 *  - deferred: deliberately left for something else (capital left for Magma);
 *  - blocked: it can't act until the operator does something (no Amboss key;
 *    selling on with no offer and auto-pricing off — none will be listed);
 *  - error: it failed (the node or Amboss didn't answer, every attempt failed).
 * Waiting and deferred are information, never failures (D15).
 */
export type DecisionState = "acted" | "idle" | "waiting" | "deferred" | "blocked" | "error";

export interface AreaDecision {
  /** When it was made — the latest time, for a decision made again. */
  at: string;
  state: DecisionState;
  text: string;
  /** The same decision run after run (numbers aside): since when, and how
   *  many times — "waiting ×48 since 08:00", not 48 lines. */
  since?: string;
  repeats?: number;
  /** The area's latest error, kept after the next decision (24 h shown). */
  lastError?: { at: string; text: string };
}

/** What the UI shows for an area: its last decision — or that it is off, or
 *  blocked right now (write mode off, no Amboss key), whatever it last did. */
export interface AreaStatus {
  /** "not_run": switched on, and no decision made yet. */
  state: DecisionState | "off" | "not_run";
  text: string;
  /** null: no decision yet (never run since it was switched on). */
  at: string | null;
  since?: string;
  repeats?: number;
  lastError?: { at: string; text: string };
  /** An area that is off or blocked: what it decided while it last ran. */
  last?: AreaDecision;
}

/** One change of an area's decision (the decision log, for diagnostics). */
export interface DecisionLogEntry {
  at: string;
  area: DecisionArea;
  state: DecisionState;
  text: string;
}

/** How many decision changes the decision log keeps (newest first). */
export const DECISION_LOG_KEPT = 500;

/** The main run's last pass in numbers — kept for every pass (the Overview
 *  pairs the run's time with these, never with an older run's counts). */
export interface RunSummary {
  at: string;
  attempted: number;
  applied: number;
  /** Everything that failed in the pass — its fee writes, refills, opens,
   *  offer writes and max_htlc updates, and each stage that threw (errors),
   *  also when that failure is no news for the run history. */
  failed: number;
  feeChanges: { ok: number; failed: number };
  rebalances: { ok: number; failed: number; inFlight: number };
  opens: { ok: number; failed: number };
  sells: { ok: number; failed: number };
  maxHtlc: { ok: number; failed: number };
  /** Stages that threw, by name. */
  errors: string[];
}

/**
 * The fee stage's decision (D16): what it changed — or, when it changed
 * nothing, why, counted over every channel: already where the engine wants
 * it, or held by a guard (the cooldown, the once-a-day pacing of lowerings,
 * a change too small to send, the per-run limit, a pin or an exclusion, an
 * update LND refused). Before, a run that changed nothing left no trace.
 */
export function feeDecision(
  recs: readonly Pick<FeeRecommendation, "alias" | "currentPpm" | "targetPpm" | "wouldApply" | "blockedByGuards">[],
  changes: readonly Pick<AutopilotChange, "alias" | "fromPpm" | "toPpm" | "ok" | "error" | "repeat">[],
): { text: string; state: DecisionState } {
  const ok = changes.filter((c) => c.ok);
  const failed = changes.filter((c) => !c.ok);
  // Every write that failed in the pass — one LND refused the same way as
  // last time included (a `repeat`, left out of the run history only): its
  // own words, LND's reason (review of P7: a repeat read "the same refusal
  // as before", with no reason at all). "LND refused" only when it did (its
  // answer, updateRefusal): a channel skipped because its policy couldn't
  // be read, or a write LND never answered, was "not applied" (review
  // 2026-10-25: both read "LND refused").
  const refused = failed.length;
  const verb = failed.every((c) => /^LND refused/.test(c.error ?? "")) ? "LND refused" : "not applied";
  const refusedText = refused ? `${refused} update${refused === 1 ? "" : "s"} ${verb} (${failed[0].error ?? "failed"})` : "";
  if (ok.length) {
    const shown = ok.slice(0, 3).map((c) => `${c.alias} ${c.fromPpm}→${c.toPpm} ppm`);
    return {
      text:
        `${ok.length} fee update${ok.length === 1 ? "" : "s"} applied: ${shown.join(", ")}${ok.length > 3 ? `, and ${ok.length - 3} more` : ""}` +
        (refusedText ? ` · ${refusedText}` : ""),
      state: "acted",
    };
  }
  if (refused) return { text: refusedText, state: "error" };
  if (recs.length === 0) return { text: "no channel to price (no active channel)", state: "idle" };
  // Why each channel kept its fee: at its target, or the first guard.
  const counts = new Map<string, number>();
  const bump = (why: string) => counts.set(why, (counts.get(why) ?? 0) + 1);
  for (const r of recs) {
    const guard = r.blockedByGuards?.[0];
    if (guard) bump(guardWords(guard));
    else if (r.targetPpm === r.currentPpm) bump("already at their target");
    else bump("other");
  }
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n} ${why}`);
  return { text: `no fee needed changing — ${recs.length} channel${recs.length === 1 ? "" : "s"} checked: ${parts.join(", ")}`, state: "idle" };
}

/** A fee guard, as the fee decision counts it. */
function guardWords(guard: string): string {
  if (/cooldown|pacing/.test(guard)) return "held by the cooldown or the once-a-day pacing of lowerings";
  if (/below threshold/.test(guard)) return "a change too small to send";
  if (/max changes per run/.test(guard)) return "over the per-run limit (next run)";
  if (/excluded/.test(guard)) return "excluded by you";
  if (/inactive/.test(guard)) return "inactive";
  if (/last fee update failed/.test(guard)) return "waiting after an update that failed";
  return guard;
}

/** The max_htlc pass's decision (D16). `stopped`: why the pass ended early
 *  (the switch went off, all automation was paused) — what it moved before
 *  still counts; nothing after was sent. */
export function maxHtlcDecision(
  moved: readonly Pick<MaxHtlcChange, "alias" | "ok" | "error">[],
  stopped: string | null = null,
): { text: string; state: DecisionState } {
  const ok = moved.filter((m) => m.ok).length;
  const failed = moved.filter((m) => !m.ok);
  const halt = stopped ? `${stopped} — no further update was sent` : "";
  if (!moved.length) {
    return stopped ? { text: halt, state: "waiting" } : { text: "every channel's advertised size is current — nothing to gossip", state: "idle" };
  }
  // (An update LND took that didn't stick, or one it never answered, was
  // not refused.)
  const verb = failed.every((m) => /^LND refused/.test(m.error ?? "")) ? "refused by LND" : "not applied";
  const refused = failed.length ? `${failed.length} ${verb} (${failed[0].error ?? "failed"})` : "";
  if (!ok) return { text: [refused, halt].filter(Boolean).join(" · "), state: "error" };
  return { text: [`${ok} channel${ok === 1 ? "'s" : "s'"} advertised size moved`, refused, halt].filter(Boolean).join(" · "), state: "acted" };
}

/**
 * When the autopilot itself last changed something: the newest line of the
 * run history with an action that landed and was not the operator's — a fee
 * set or applied by hand on the Fees tab is recorded there too (via
 * "manual"), and the Overview's "Last change by the autopilot 2m ago" said so
 * of it (review of P7). So is a Magma accept or reject the order lane sends
 * for the operator, carrying out a decision they made by hand (via "manual":
 * their reject sent again, their accept completed) — not one of its own
 * (review of P9, final round: the resend of their reject, once Amboss
 * confirmed it, read as the autopilot's latest change). A line whose every
 * attempt failed changed nothing.
 */
export function lastAutopilotActionAt(
  history: readonly Pick<AutopilotRun, "at" | "changes" | "rebalances" | "channels" | "sells" | "maxHtlc">[],
): string | null {
  const landed = (xs: readonly { ok: boolean }[] | undefined) => (xs ?? []).some((x) => x.ok);
  const line = history.find(
    (r) =>
      (r.changes ?? []).some((c) => c.ok && c.via !== "manual") ||
      landed(r.rebalances) ||
      landed(r.channels) ||
      (r.sells ?? []).some((s) => s.ok && s.via !== "manual") ||
      landed(r.maxHtlc),
  );
  return line?.at ?? null;
}

/** What an offer write did, in the Magma decision ("repriced offer 1a2b…"). */
const OFFER_VERB: Partial<Record<SellActionKind, string>> = {
  reprice: "repriced",
  resize: "resized",
  relist: "topped up",
  terms: "set the standard lease and fee promise of",
  enable: "listed again",
  disable: "disabled",
};

/** Two decisions are the same when only their numbers differ ("1,949,000
 *  sat spendable" vs "1,948,000") — a wait, a deferral, a look that found
 *  nothing, an error. Never an action: each is news of its own (decisionNote). */
const decisionSig = (state: string, text: string): string => `${state}:${text.replace(/\d[\d,.]*/g, "#")}`;

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
/** How often the order lane reads the listed offers to catch one priced below
 *  what the autopilot set, or listed for free (guardOfferPrices). */
export const OFFER_GUARD_INTERVAL_MS = 2 * 60_000;
/** How long the order lane's accept floor (saleFeeFloorSats) is reused. */
const SALE_FLOOR_TTL_MS = 10 * 60_000;
/** How often the routing-fee promises of sold channels are checked (D7) —
 *  whatever the autopilot switches say (keepLeasePromisesNow). */
export const LEASE_PROMISE_CHECK_MS = 10 * 60_000;
/** After a fee update on a channel failed (LND refused it, or it couldn't be
 *  sent), the autopilot leaves that channel's fee alone this long — a broken
 *  lease promise excepted (writeFees). */
export const FEE_RETRY_BACKOFF_MS = 6 * 3_600_000;

/** The saved fee retry back-off, made safe: entries with a time that parses
 *  and a reason only (feeCooldown and writeFees read them). */
export function sanitizeFeeRetry(raw: unknown): Record<string, { until: string; error: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, { until: string; error: string }> = {};
  for (const [id, r] of Object.entries(raw as Record<string, unknown>)) {
    const e = (r ?? {}) as { until?: unknown; error?: unknown };
    if (typeof e.until === "string" && Number.isFinite(Date.parse(e.until)) && typeof e.error === "string") out[id] = { until: e.until, error: e.error };
  }
  return out;
}
/** How often rebalance payments still in flight are asked about between
 *  runs — also with every automation off (a manual one must end on record). */
export const INFLIGHT_REBALANCE_CHECK_MS = 2 * 60_000;
const floor10k = (n: number): number => Math.max(0, Math.floor(n / 10_000) * 10_000);
/** Readable for LND's array errors too: stage errors reach the run history. */
const errText = errorText;
/** How long the Overview's lease benchmark looks at a public-book fetch it
 *  had to start (nothing cached yet) before it answers "being read". */
export const BENCHMARK_WAIT_MS = 750;
/** How long the pages share one read of the Magma report (magmaReportShared). */
export const MAGMA_REPORT_SHARE_MS = 60_000;
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
   *  autopilot's next write). `why`: what the move is, when it isn't the
   *  market price moving (a base fee going to the market's). */
  target: (off: MyOffer) => { fee: number; base: number; moved: boolean; lease: number; why?: string } | null;
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
 * The channel note's word on the peers that refused an open this run: one
 * that refused for good reason waits out its back-off (1, 7, then 30 days);
 * one that only refused the SIZE — it named its minimum or maximum — is
 * tried again next run at a size within it. (Review of P4: the note said
 * "each waits before it is tried again" of both.)
 */
export function refusalNote(refused: readonly { alias: string; days: number; sizeLimit: boolean }[]): string {
  const list = (xs: readonly { alias: string }[]) => xs.map((x) => x.alias).join(", ");
  const waiting = refused.filter((r) => !r.sizeLimit);
  const resized = refused.filter((r) => r.sizeLimit);
  const parts: string[] = [];
  if (waiting.length) {
    const days = [...new Set(waiting.map((r) => r.days))];
    const wait = days.length === 1 ? `${days[0]} day${days[0] === 1 ? "" : "s"}` : "1, 7 or 30 days by how often it refused";
    parts.push(`${list(waiting)} refused an open (${waiting.length === 1 ? "it waits" : "each waits"} ${wait} before it is tried again)`);
  }
  if (resized.length) {
    parts.push(
      `${list(resized)} refused the size — ${resized.length === 1 ? "it is" : "they are"} tried again next run, at a size within the limit ${resized.length === 1 ? "it" : "each"} named`,
    );
  }
  return parts.join(" · ");
}

/** The channel stage's run-history key for failures of this node's own (its
 *  wallet, its chain, its connection) — one line while the cause stays the
 *  same, whichever peer the open was meant for (channelNews). */
const SELF_NEWS_KEY = "self";

/** The channel decision when the stage was told to stop (stopWhy). */
const openStopped = (why: string): string => `stopped: ${why} — no open was started`;

/**
 * The status capital safety wants for an offer now, or null for none:
 *  - disabled while its smallest channel can't be funded — whoever owns its
 *    terms (an order it couldn't serve would end in a reject, or worse, a
 *    failed open);
 *  - enabled again once it can be, only when the autopilot itself disabled it
 *    for that reason (it restores the listing the operator chose), or when
 *    the operator switched Liquidity provision on with it disabled (listOnAt)
 *    — never one the operator disabled since. (Before, every DISABLED offer
 *    was re-enabled within the half hour, a manual "disable" included.)
 * Never without a price: capitalToggle refuses to list an offer at 0 ppm +
 * 0 sat.
 */
function capitalStatus(status: string, fundable: boolean, control: OfferControl): "ENABLED" | "DISABLED" | null {
  if (status === "ENABLED" && !fundable) return "DISABLED";
  if (status === "DISABLED" && fundable && (!!control.autoDisabledAt || !!control.listOnAt) && !control.disabledByHandAt && !control.freeDisabledAt) {
    return "ENABLED";
  }
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

/** The same terms and status — what an edit changes (the listed liquidity
 *  also moves with every sale, so it is not compared). */
function sameTerms(a: MyOffer, b: MyOffer): boolean {
  const x = fieldsOf(a);
  const y = fieldsOf(b);
  return (Object.keys(x) as (keyof OfferFields)[]).every((k) => k === "availableSats" || x[k] === y[k]);
}

/** The terms that differ between what Amboss has and what is wanted, under
 *  Amboss's names (empty: nothing to change). Only for deciding whether to
 *  write and for saying what changed: a write always sends every term
 *  (fullTerms), as Amboss resets the ones an update leaves out. */
function termsChanges(have: MyOffer, want: OfferFields): string[] {
  const changed: string[] = [];
  if (want.feeRatePpm !== have.feeRatePpm) changed.push("fee_rate");
  if (want.baseFeeSats !== have.baseFeeSats) changed.push("base_fee");
  if (want.minSizeSats !== have.minSizeSats) changed.push("min_size");
  if (want.maxSizeSats !== have.maxSizeSats) changed.push("max_size");
  if (want.minBlockLength !== have.minBlockLength) changed.push("min_block_length");
  if (want.totalSizeSats !== have.totalSizeSats) changed.push("total_size");
  if (want.feeRateCapPpm !== null && want.feeRateCapPpm !== have.feeRateCapPpm) changed.push("fee_rate_cap");
  if (want.baseFeeCapSats !== null && want.baseFeeCapSats !== have.baseFeeCapSats) changed.push("base_fee_cap");
  return changed;
}

/** Every term to send for `want`. A promise the autopilot doesn't set (null)
 *  is the one Amboss has: left out, Amboss would clear it. */
function fullTerms(want: OfferFields, have: MyOffer): OfferTerms {
  return {
    totalSizeSats: want.totalSizeSats,
    minSizeSats: want.minSizeSats,
    maxSizeSats: want.maxSizeSats,
    feeRatePpm: want.feeRatePpm,
    baseFeeSats: want.baseFeeSats,
    minBlockLength: want.minBlockLength,
    feeRateCapPpm: want.feeRateCapPpm ?? have.feeRateCapPpm,
    baseFeeCapSats: want.baseFeeCapSats ?? have.baseFeeCapSats,
    // Not the autopilot's to set — sent back as Amboss has them.
    conditions: have.conditions,
    onchainPriority: have.onchainPriority,
    onchainMultiplier: have.onchainMultiplier,
  };
}

/** Does Amboss hold exactly these terms — every one, the price and the
 *  promise included? Before, only the fields a write had sent were compared:
 *  the write that sent only the caps read back "verified" while Amboss had
 *  reset the fee rate to 0. */
export function termsMatch(read: MyOffer, sent: OfferTerms): boolean {
  return termsMismatch(read, sent).length === 0;
}

/** The terms Amboss holds differently from `sent`, said plainly — the listed
 *  total against `totalRange`: what was sent, or less only where a sale
 *  completed in between (writeTerms says by how much at most). Above it, the
 *  offer advertises capital a cut took out; below it, a raise — a cut given
 *  back — didn't land. */
export function termsMismatch(
  read: MyOffer,
  sent: OfferTerms,
  totalRange: [number, number] = [sent.totalSizeSats, sent.totalSizeSats],
): string[] {
  const conditions = (c: OfferTerms["conditions"]) =>
    c.length ? c.map((x) => `${x.condition} ${x.operator} ${x.value}`).sort().join(", ") : "none";
  const pairs: [string, number | string | null, number | string | null][] = [
    ["fee rate (ppm)", read.feeRatePpm, sent.feeRatePpm],
    ["base fee (sat)", read.baseFeeSats, sent.baseFeeSats],
    ["min channel (sat)", read.minSizeSats, sent.minSizeSats],
    ["max channel (sat)", read.maxSizeSats, sent.maxSizeSats],
    ["min lease (blocks)", read.minBlockLength, sent.minBlockLength],
    ["routing fee-rate cap (ppm)", read.feeRateCapPpm, sent.feeRateCapPpm],
    ["routing base-fee cap (sat)", read.baseFeeCapSats, sent.baseFeeCapSats],
    ["buyer conditions", conditions(read.conditions), conditions(sent.conditions)],
    ["on-chain priority", read.onchainPriority, sent.onchainPriority],
    ["on-chain multiplier", read.onchainMultiplier, sent.onchainMultiplier],
  ];
  const out = pairs.filter(([, have, want]) => have !== want).map(([label, have, want]) => `${label}: Amboss has ${have}, sent ${want}`);
  if (read.totalSizeSats < totalRange[0] || read.totalSizeSats > totalRange[1]) {
    out.push(`listed total (sat): Amboss has ${read.totalSizeSats}, sent ${sent.totalSizeSats}`);
  }
  return out;
}

/** An offer's full terms under the names Amboss uses (for the write record). */
export function ambossFields(p: OfferTerms): Record<string, number | string> {
  const out: Record<string, number | string> = {
    total_size: p.totalSizeSats,
    min_size: p.minSizeSats,
    max_size: p.maxSizeSats,
    fee_rate: p.feeRatePpm,
    base_fee: p.baseFeeSats,
    min_block_length: p.minBlockLength,
  };
  if (p.feeRateCapPpm !== null) out.fee_rate_cap = p.feeRateCapPpm;
  if (p.baseFeeCapSats !== null) out.base_fee_cap = p.baseFeeCapSats;
  if (p.conditions.length) out.conditions = p.conditions.map((c) => `${c.condition} ${c.operator} ${c.value}`).join("; ");
  if (p.onchainPriority !== null) out.onchain_priority = p.onchainPriority;
  if (p.onchainMultiplier !== null) out.onchain_multiplier = p.onchainMultiplier;
  return out;
}

/** Listed for free: no fee rate and no base fee. Never what LightningMate
 *  lists (the engine prices at its profit floor at least; a manual offer
 *  needs a base fee above 0) — Amboss matched such an offer at 0 sats. */
const listedForFree = (o: Pick<MyOffer, "feeRatePpm" | "baseFeeSats">): boolean => o.feeRatePpm <= 0 && o.baseFeeSats <= 0;

/** Why an offer listed for free was taken off the market (disableFree). */
const FREE_DISABLE_REASON = "Amboss listed it for free (0 ppm + 0 sat), and there is no price of its own to put back";
const FREE_DISABLED_WHY =
  "disabled by the autopilot: Amboss listed it for free (0 ppm + 0 sat) — set its price on Market → Sell, then enable it";

type OfferPrices = NonNullable<PersistedState["offerPrices"]>;

/** A price as stored: two finite, non-negative numbers, not both 0. */
function soundPrice(p: unknown): { feeRatePpm: number; baseFeeSats: number } | null {
  if (!p || typeof p !== "object") return null;
  const { feeRatePpm, baseFeeSats } = p as Record<string, unknown>;
  if (typeof feeRatePpm !== "number" || typeof baseFeeSats !== "number") return null;
  if (!Number.isFinite(feeRatePpm) || !Number.isFinite(baseFeeSats) || feeRatePpm < 0 || baseFeeSats < 0) return null;
  return listedForFree({ feeRatePpm, baseFeeSats }) ? null : { feeRatePpm, baseFeeSats };
}

/**
 * The price memory as loaded: what it holds, if sound — and, for an offer it
 * has nothing for, the last price wanted for it, else the last one read,
 * while not free (0.8.0 kept no memory; its partial writes left offers at
 * 0 ppm + 0 sat half the time, and the run after the upgrade must give such
 * an offer its price back, not take it off the market).
 */
function seedOfferPrices(prices: unknown, sync: OfferSyncStatus | undefined): OfferPrices {
  const out: OfferPrices = {};
  for (const [id, p] of Object.entries(prices && typeof prices === "object" ? (prices as Record<string, unknown>) : {})) {
    const price = soundPrice(p);
    const at = (p as { at?: unknown }).at;
    if (price) out[id] = { ...price, at: typeof at === "string" ? at : new Date(0).toISOString() };
  }
  for (const e of Array.isArray(sync?.offers) ? sync.offers : []) {
    if (!e || typeof e.offerId !== "string" || out[e.offerId]) continue;
    const price = soundPrice(e.wanted) ?? soundPrice(e.amboss);
    if (price) out[e.offerId] = { ...price, at: typeof e.checkedAt === "string" ? e.checkedAt : new Date(0).toISOString() };
  }
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
  /** The last max_htlc update applied per channel: one that didn't take is
   *  not resent every run (runMaxHtlcPass). */
  private readonly maxHtlcLastWrites = new Map<string, { fromSat: number | null; toSat: number }>();
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
  /** Per stage, the failure last written to the run history — the same one
   *  again is not news (it counts up on the area's status instead). */
  private readonly stageLast = new Map<string, string>();
  /** Per peer, the last failed automatic open written to the run history —
   *  the same failure again is not news (channelNews). */
  private readonly channelLast = new Map<string, string>();
  private running = false;
  /** When the current main run took its lock (null when idle) — exposed so a
   *  run that takes unusually long is visible, not just a stale lastRunAt. */
  private runningSince: string | null = null;
  /** Liquidity provision was switched on while a run was under way (the run
   *  kicked for it found that one busy): it runs one more when it ends. */
  private sellSwitchedMidRun = false;
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
  /** How long each channel's peer has been offline (channelUptime.ts): the
   *  close list and the close dialog read it. Observed every 10 minutes from
   *  start() — a read, so also on a read-only node. */
  readonly uptime: ChannelUptime;
  /** LightningMate's copy of the transactions close costs are worked out
   *  from (closeTxArchive.ts): LND's wallet forgets a force close's
   *  commitment at its next restart. Kept current every hour from start() —
   *  a read, so also on a read-only node — and by every read of the books. */
  readonly closeTxs: CloseTxArchive;
  /** A purchase follow-up is under way (its own flag, not the lane's). */
  private followingPurchases = false;
  /** Per offer: the status change under way (withOffer). */
  private readonly offerChains = new Map<string, Promise<void>>();
  /**
   * When each area's decision CHANGED — newest first, at most
   * DECISION_LOG_KEPT (review a8: no record of when the autopilot started
   * waiting, or failing). A decision made again only counts up on the area
   * (decisionNote), so this holds months of a quiet node. Its own file, written
   * only on a change: the run state is saved far more often.
   */
  private readonly decisionLogStore: JsonStore<DecisionLogEntry[]>;
  private decisionLogEntries: DecisionLogEntry[];
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
      saleFloorSats: () => this.saleFeeFloorSats(),
      soldChannelClose: () => this.soldChannelClose(),
    });
    initMagmaHistory(dataDir);
    this.purchases = new MagmaPurchases(dataDir);
    this.uptime = new ChannelUptime(dataDir);
    this.closeTxs = new CloseTxArchive(dataDir);
    this.feeLog = new FeeChangeLog(dataDir);
    this.decisionLogStore = new JsonStore<DecisionLogEntry[]>(dataDir, "decision-log.json");
    const logged = this.decisionLogStore.read([]);
    this.decisionLogEntries = Array.isArray(logged) ? logged.slice(0, DECISION_LOG_KEPT) : [];
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
    // The price memory, sound — and seeded on the upgrade from 0.8.0 (which
    // kept none): each offer's last wanted price, else its last read, while
    // not free. Its partial writes left offers at 0 ppm + 0 sat half the time;
    // without this the first run would take such an offer off the market
    // instead of giving it its price back.
    this.state.offerPrices = seedOfferPrices(this.state.offerPrices, this.state.offerSync);
    this.state.history = Array.isArray(this.state.history) ? this.state.history : [];
    // What "Resume" may switch on: the known switches only (sanitizePaused).
    this.state.paused = sanitizePaused(this.state.paused);
    // The switch-on and the base-fee clocks too: read by the offer upkeep and
    // the engine, a value left half-written must not throw there.
    this.state.sellSwitchOn = sanitizeSellSwitchOn(this.state.sellSwitchOn);
    this.state.offerBaseMoves = sanitizeBaseMoves(this.state.offerBaseMoves);
    this.state.offerBaseMovedAt = sanitizeTimes(this.state.offerBaseMovedAt);
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
    this.state.perChannelFeeRetry = sanitizeFeeRetry(this.state.perChannelFeeRetry);
    this.state.perTargetLastRebalanced ??= {};
    // Today's rebalance spend is read from the rebalance log now
    // (rebalanceBudget) — the separate counter is gone.
    delete (this.state as { perDayRebalanceSpend?: unknown }).perDayRebalanceSpend;
    // So is the per-target fail count from before the back-off was kept per
    // source → target pair (0.7.x): never added to since, it was cleared only
    // by a success — a target with 3 old fails waited 8× its cooldown for
    // good (review 2026-10-25). The pairs back off now.
    delete (this.state as { perTargetRebalanceFails?: unknown }).perTargetRebalanceFails;
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
    for (const [id, r] of Object.entries(this.state.perChannelFeeRetry ?? {})) if (Date.parse(r.until) > now) retryAfter[id] = r.until;
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
    baseMoves: Record<string, { since?: string; offerBase?: number; movedAt?: string }>;
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
      // Since when each offer's base has differed from the market's, at the
      // market's present level, and when its base last moved (baseFeeFollow).
      baseMoves: Object.fromEntries(
        [...new Set([...Object.keys(this.state.offerBaseMoves ?? {}), ...Object.keys(this.state.offerBaseMovedAt ?? {})])].map((id) => {
          const m = this.state.offerBaseMoves?.[id];
          const movedAt = this.state.offerBaseMovedAt?.[id];
          return [id, { ...(m ? { since: m.since, offerBase: m.offerBase } : {}), ...(movedAt ? { movedAt } : {}) }];
        }),
      ),
    };
  }

  /** The routing-fee promise every offer of this node carries (D7, see
   *  leaseCaps.ts) — from the fee policy, so the fee autopilot never has to
   *  break it in normal operation. */
  offerFeeCaps(): OfferFeeCaps {
    return offerFeeCaps(this.state.config.policy);
  }

  /** The peers the operator never wants opened to automatically. */
  neverOpenPeers(): Record<string, { alias: string; at: string }> {
    return { ...(this.state.neverOpen ?? {}) };
  }

  /** Mark a peer "never open automatically" (or allow it again). The
   *  channel stage skips it; opening to it by hand is still the operator's. */
  setNeverOpen(pubkey: string, never: boolean, alias = ""): void {
    const list = (this.state.neverOpen ??= {});
    if (never) list[pubkey] = { alias, at: new Date().toISOString() };
    else delete list[pubkey];
    this.persist();
  }

  /** Where channel leases come from (leases.ts): every channel sold through
   *  Magma or LSPS1 (the capital ledger), the inbound bought on Magma, and
   *  the sales Amboss last listed with a running lease (kept on disk). */
  leaseSources(): LeaseSources {
    return {
      soldLeases: this.capital.soldLeases(),
      purchases: this.purchases.list(),
      ambossRunning: this.magma.runningLeasesOnAmboss(),
      ambossListedAt: this.magma.runningLeasesListedAt(),
    };
  }

  /** The same, with Amboss's listing asked again first when it is more than
   *  an hour old (an Amboss key set) — for the close list and a close, which
   *  must not offer or perform a close inside a lease Amboss knows of. Waits
   *  a few seconds for Amboss at most (MagmaDesk.runningLeasesFresh). */
  async leaseSourcesFresh(): Promise<LeaseSources> {
    await this.magma.runningLeasesFresh();
    return this.leaseSources();
  }

  /** Sell caps shared with LSP mode — one capital budget across both demand sources. */
  sellCaps(): { maxChannelSats: number; reserveSats: number; maxDeploySats: number } {
    return {
      maxChannelSats: this.state.config.sellMaxChannelSats,
      reserveSats: this.state.config.sellReserveSats,
      maxDeploySats: this.state.config.sellMaxDeploySats,
    };
  }

  /** The on-chain reserve the operator's settings keep — the larger of the
   *  channel-open and the sell reserve: what an on-chain send is warned
   *  about dipping into (onchain.ts previewSend). */
  onchainReserveSetting(): number {
    const c = this.state.config;
    return Math.max(c.channelReserveSats, c.sellReserveSats);
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
      this.logChange("elasticity", null);
      return new Map([...el].map(([id, e]) => [id, e.modifier]));
    } catch (err) {
      // The fee engine works without it (no channel gets a learned
      // modifier) — said in the log once, not every run (it was silent).
      this.logChange("elasticity", `[autopilot] fees: the elasticity learner couldn't read the forwards (${errText(err)}) — fees are set without it`);
      return new Map();
    }
  }

  /** What was last logged per key: a failure is logged when it starts or
   *  changes, not on every run while it lasts (null: none now). */
  private readonly loggedProblems = new Map<string, string>();
  private logChange(key: string, text: string | null): void {
    if (text === null) {
      this.loggedProblems.delete(key);
      return;
    }
    const sig = text.replace(/\d[\d,.]*/g, "#");
    if (this.loggedProblems.get(key) === sig) return;
    this.loggedProblems.set(key, sig);
    logLine("warn", text);
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
      /** Per area, the latest decision and why (raw, as stored). */
      decisions: this.state.decisions ?? {},
      /** Per area, what the UI shows: the last decision, or off / blocked. */
      status: this.areaStatus(),
      /** The main run's last pass in numbers, no-op passes too. */
      lastRun: this.state.lastRun ?? null,
      /** When the autopilot last changed something itself (lastActionAt):
       *  a run, the order lane, a sold channel's fee promise kept — never a
       *  fee set or applied by hand — null: nothing on record. */
      lastActionAt: lastAutopilotActionAt(this.state.history),
      /** "Pause all automation" in force: since when, and what was on. */
      paused: this.state.paused ?? null,
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
    // Whether LND lists its peers to the write client at all (peers:read):
    // without it no channel can be opened, and the channel and Magma areas
    // say so from the start — not first when an order is turned down for it.
    if (this.writeLnd && !this.shuttingDown) void checkPeerListing(this.writeLnd);
    // Offline durations accrue whatever the switches say (a read); so does
    // the copy of the close transactions the books need (a read too).
    if (!this.shuttingDown) {
      this.uptime.start(this.readLnd);
      this.closeTxs.start(this.readLnd);
    }
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
    this.uptime.stop();
    this.closeTxs.stop();
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
    while (this.running || this.refilling || this.magma.isBusy() || this.capital.mutex.busy || this.reconciling || this.guarding) {
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
    const wasSelling = this.state.config.sellEnabled;
    this.state.config = applyPatch(this.state.config, result.patch);
    if (!this.canWrite) {
      // Refuse to "enable" anything when we have no write macaroon.
      this.state.config.enabled = false;
      this.state.config.rebalanceEnabled = false;
      this.state.config.channelEnabled = false;
      this.state.config.maxHtlcEnabled = false;
    }
    // A switch turned on by hand ends a pause: the operator is choosing
    // switch by switch now, and "Resume" would switch on what they left off.
    if (AUTOMATION_SWITCHES.some((k) => result.patch[k] === true)) this.state.paused = null;
    this.noteSellSwitch(wasSelling);
    this.persist();
    this.reschedule();
  }

  /**
   * Liquidity provision switched on: the offers disabled at this moment are
   * listed again once each has a price and can be funded. Which ones those are
   * is taken now — the offers LightningMate's last offer sync showed disabled —
   * and the first offer read after this marks those still disabled
   * (applySwitchOn); the run reschedule() kicks makes that read within seconds.
   * An offer disabled after the switch — on amboss.tech while Amboss couldn't
   * be read, say — is not among them. Without any offer sync to go by (none
   * kept yet), every offer disabled at that first read is listed. Switched off
   * (by hand, or by "Pause all automation"): what an earlier switch-on had
   * still to list is not listed any more. (Before, the switch-off disabled
   * every listed offer "by hand" and the switch-on listed none: each had to be
   * enabled again on Market → Sell.)
   */
  private noteSellSwitch(wasSelling: boolean): void {
    const selling = this.state.config.sellEnabled;
    if (selling === wasSelling) return;
    if (selling) {
      const sync = this.state.offerSync;
      this.state.sellSwitchOn = {
        at: new Date().toISOString(),
        disabled: sync?.at ? sync.offers.filter((e) => e.amboss.status === "DISABLED").map((e) => e.offerId) : null,
      };
      // A main run under way skips the run reschedule() kicks: it runs one
      // more itself when it ends (runOnce).
      if (this.running) this.sellSwitchedMidRun = true;
      return;
    }
    this.state.sellSwitchOn = null;
    for (const [id, control] of Object.entries(this.state.offerControl ?? {})) {
      if (control.listOnAt) this.setOfferControl(id, { ...control, listOnAt: undefined });
    }
  }

  /**
   * "Pause all automation" (review a6-ux:presets-unconfirmed-capital: there
   * was no global off — stopping everything took five switches on four
   * sub-tabs). Every switch goes off at once, and which ones were on is kept
   * for "Resume". A run in progress starts no further step: each fee write,
   * refill payment, channel open, max_htlc update, offer write and order
   * accept asks the live switch right before it starts, with nothing awaited
   * between that check and the step (stopWhy; the order lane's accept asks
   * the same switch in MagmaDesk.acceptOrder). The step already under way —
   * a payment sent, an open being broadcast — finishes, and the Magma orders
   * already taken on are carried to their end; a sold channel's fee promise
   * is still kept. Listed Magma offers are the operator's call (the UI asks
   * before it pauses). LSP mode is a setting, not one of these switches: the
   * pause leaves it on, and the pages say so (api.ts lspModeOn).
   */
  pauseAll(): void {
    const c = this.state.config;
    const was = AUTOMATION_SWITCHES.filter((k) => c[k]);
    if (was.length === 0) return;
    this.state.paused = { at: new Date().toISOString(), was };
    const wasSelling = c.sellEnabled;
    for (const k of AUTOMATION_SWITCHES) c[k] = false;
    this.noteSellSwitch(wasSelling);
    this.persist();
    this.reschedule();
  }

  /**
   * "Resume": the switches that were on before the pause, on again — except
   * Liquidity provision: switching selling on is its own decision, made with
   * the live selling check in front of the operator (D9). Returns what was
   * switched on, and whether selling was on before the pause.
   */
  resumeAll(): { resumed: AutomationSwitch[]; sellingWasOn: boolean } {
    const p = this.state.paused;
    if (!p) return { resumed: [], sellingWasOn: false };
    const resumed = this.canWrite ? p.was.filter((k) => k !== "sellEnabled") : [];
    for (const k of resumed) this.state.config[k] = true;
    this.state.paused = null;
    this.persist();
    this.reschedule();
    return { resumed, sellingWasOn: p.was.includes("sellEnabled") };
  }

  /**
   * Why a stage must start no further step now — null: go on. Asked right
   * before every fee write, refill payment, channel open, max_htlc update and
   * offer write, from the LIVE settings — not only once, when the stage
   * begins (review of P7: "Pause all automation" clicked while a run was
   * under way still paid the next planned refill, opened to the next peer and
   * sent the fee writes already planned; the offer upkeep could still list an
   * offer). The step already under way finishes; none starts after the switch
   * went off, or after the shutdown signal.
   */
  private stopWhy(sw: AutomationSwitch): string | null {
    if (this.shuttingDown) return "shutting down";
    if (this.state.config[sw]) return null;
    return this.state.paused ? "all automation was paused during the run" : `${SWITCH_WORDS[sw]} was switched off during the run`;
  }

  /** The autopilot acts on offers now: Liquidity provision on, not paused,
   *  write access (what the offer alerts may promise). */
  actsOnOffers(): boolean {
    return this.canWrite && this.amboss.hasKey() && !this.stopWhy("sellEnabled");
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
   *  (no hammering a dead route); a pair whose refills failed backs off on
   *  its own (pairBackingOff). */
  private rebalanceCooldownOk(targetId: string, cooldownMin: number): boolean {
    const last = this.state.perTargetLastRebalanced[targetId];
    if (!last) return true;
    return (Date.now() - new Date(last).getTime()) / 60_000 >= cooldownMin;
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
   *  every failed pair backs off, the paying pair is cleared. */
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
    if (res.ok) delete pairs[`${res.sourceId}>${targetId}`];
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
    const unsent = (n: number, why: string) => `${why} — ${n} planned fee update${n === 1 ? " was" : "s were"} not sent`;
    // The plan took a while (the forwards, the graph): fee automation may
    // have been switched off — or everything paused — meanwhile. Then nothing
    // is written; inside the batch, each write asks again (writeFees).
    const off = eligible.length ? this.stopWhy("enabled") : null;
    if (off) {
      this.decisionNote("fees", unsent(eligible.length, off), "waiting");
      return [];
    }
    const { changes, notSent } = await this.writeFees(writeLnd, eligible.map((r) => recommendationWrite(r)), "autopilot", {
      quietRepeats: true,
      shouldStop: () => this.stopWhy("enabled") !== null,
    });
    this.explain("fees", () => {
      const d = feeDecision(report.recommendations, changes);
      if (notSent === 0) return d;
      const stopped = unsent(notSent, this.stopWhy("enabled") ?? "stopped during the run");
      // What was sent still counts (applied, or refused); none sent: a wait.
      return d.state === "acted" || d.state === "error" ? { text: `${d.text} · ${stopped}`, state: d.state } : { text: stopped, state: "waiting" };
    });
    return changes;
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
   * channel is marked `repeat`: it is in the pass's own result — what "Run
   * once now" and the Overview count, with LND's reason — and left out of
   * the run history only (runOnce): the first one is on record there, and
   * the Fees tab shows the channel held. (Review of P7: it was dropped from
   * the result itself, and the Overview read "nothing needed changing"
   * right above "Fee automation failed".)
   *
   * `shouldStop` (the fee autopilot's batch): asked before each write — the
   * writes after it says yes are not sent; `notSent` counts them. Nothing
   * is booked for them (no cooldown, no back-off): they were never written.
   *
   * Each write is booked — and saved — as LND answers it, before the next is
   * sent: a restart in the middle of a batch (an Umbrel update) lost the
   * cooldowns and log records of the writes LND had taken, and the restarted
   * process sent them again (review 2026-10-25).
   */
  private async writeFees(
    writeLnd: AuthenticatedLnd,
    writes: FeeWrite[],
    via: NonNullable<AutopilotChange["via"]>,
    opts: { quietRepeats?: boolean; shouldStop?: () => boolean } = {},
  ): Promise<{ changes: AutopilotChange[]; notSent: number }> {
    if (writes.length === 0) return { changes: [], notSent: 0 };
    const byId = new Map(writes.map((w) => [w.id, w]));
    const fa = (this.state.perChannelFlowAnchor ??= {});
    const retry = (this.state.perChannelFeeRetry ??= {});
    const changes: AutopilotChange[] = [];
    const booked = new Set<FeeApplyResult>();
    const book = (res: FeeApplyResult) => {
      if (booked.has(res)) return;
      booked.add(res);
      const w = byId.get(res.id);
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const toBaseMsat = res.baseFeeMsat ?? w?.baseFeeMsat;
      const why = w?.why;
      let error = res.error;
      let repeat = false;
      if (res.ok) {
        delete retry[res.id];
        this.state.perChannelLastApplied[res.id] = nowIso;
        // Applied a no-flow lowering → open (or refresh) the flow-won episode.
        if (w?.noFlowLowering) fa[res.id] = { ...fa[res.id], episodeAt: nowIso };
        this.feeLog.append([
          {
            at: nowIso,
            channelId: res.id,
            alias: w?.alias ?? res.id,
            fromPpm: w?.fromPpm ?? 0,
            toPpm: res.feeRatePpm,
            fromBaseMsat: w?.fromBaseMsat ?? null,
            toBaseMsat: toBaseMsat ?? null,
            via,
            ...(why || res.clampedBy ? { why: [why, res.clampedBy].filter(Boolean).join("; ") } : {}),
          },
        ]);
      } else {
        const raw = res.error ?? "failed";
        repeat = opts.quietRepeats === true && retry[res.id]?.error === raw;
        retry[res.id] = { until: new Date(nowMs + FEE_RETRY_BACKOFF_MS).toISOString(), error: raw };
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
        ...(repeat ? { repeat: true } : {}),
      });
      this.persist();
    };
    const results = await this.feeApply(
      writeLnd,
      writes.map(({ id, transactionId, transactionVout, feeRatePpm, baseFeeMsat }) => ({ id, transactionId, transactionVout, feeRatePpm, baseFeeMsat })),
      { ...(opts.shouldStop ? { shouldStop: opts.shouldStop } : {}), onResult: book },
    );
    // (Whatever was not booked as it came — none, with applyFees — now.)
    for (const res of results as FeeApplyResult[]) book(res);
    const answered = new Set((results as FeeApplyResult[]).map((r) => r.id));
    const notSent = writes.filter((w) => !answered.has(w.id)).length;
    return { changes, notSent };
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
    // Never stopped by a switch: a promise to a buyer holds whatever the
    // automation switches say (also while everything is paused).
    return (await this.writeFees(writeLnd, await this.leaseBreaches(), "lease", { quietRepeats: true })).changes;
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
      const { changes } = await this.writeFees(this.writeLnd, eligible.map((r) => recommendationWrite(r)), "manual");
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
      const { changes } = await this.writeFees(this.writeLnd, writes, "manual");
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
   *  manual applies). Not lastRunAt: that is the main run's. News only, as
   *  the main run's line: a write that failed the same way as the last one
   *  on its channel (`repeat`) is no new line. */
  private recordRun(part: Partial<Pick<AutopilotRun, "changes">>): void {
    const changes = (part.changes ?? []).filter((c) => !c.repeat);
    if (changes.length === 0) return;
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
      this.decisionNote("rebalance", `outside the rebalance hours (${rebalanceHourStart}–${rebalanceHourEnd} UTC) — no refills now`, "waiting");
      return [];
    }
    if (this.refilling) {
      this.decisionNote("rebalance", "a manual refill is under way — the autopilot's refills wait for the next run", "waiting");
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

    // Why the executor stopped a refill, when it did (its last ask).
    const halted: { why: string | null } = { why: null };
    for (const r of plan.run) {
      // Shutdown, or auto-rebalance switched off (all automation paused)
      // since the stage began: the payment already under way finishes (it is
      // being awaited right here); none of the moves planned after it starts.
      const stop = this.stopWhy("rebalanceEnabled");
      if (stop) {
        waiting.push(`${r.alias}: skipped, ${stop}`);
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
      let res: RebalanceExecResult;
      try {
        res = await this.refillBooks({ targetId: r.channelId, via: "autopilot", holdPpm: r.expectedRevenuePpm }).settle((hooks) =>
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
              // The plan's route cost, for the executor's fitted size
              // (fitBelowPlanned) — which this run hardly ever reaches: a move
              // whose estimated fee is more than the budget left waits for the
              // budget (the backstop above) before any size is tried, and the
              // plan's size already fits its other limits. It is a manual
              // run's (POST /rebalance/execute), whose cap — the budget left,
              // what the dialog promised — can be below the plan's.
              ...(r.estimatedRouteCostPpm != null ? { routeCostPpm: r.estimatedRouteCostPpm } : {}),
            },
            // Inside the refill too, no attempt starts after the shutdown
            // signal — or once auto-rebalance is off.
            { ...hooks, shouldStop: () => (halted.why = this.stopWhy("rebalanceEnabled")) ?? false },
          ),
        );
      } catch (err) {
        // LND failed the refill before anything was sent (the executor's
        // first reads: "waiting to start, RPC services not available"): that
        // refill's error, given its cooldown back (settle) — the stage goes
        // on with the next planned one (review 2026-10-25: one such answer
        // ended the stage, and the target sat out its cooldown unrefilled).
        out.push({ alias: r.alias, amountSats: r.recommendedAmount ?? 0, feeSats: null, costPpm: null, ok: false, error: `not started: ${errText(err)}` });
        continue;
      }
      if (res.stopped) {
        // A deliberate skip (D15), like the moves planned after it: a source
        // whose attempt failed before the signal backs off (refillBooks).
        const failed = res.failedSourceIds?.length ?? 0;
        waiting.push(
          `${r.alias}: skipped, ${halted.why ?? "shutting down"}${failed ? ` (after ${failed === 1 ? "a source" : `${failed} sources`} found no route)` : ""}`,
        );
        continue;
      }
      if (res.inFlight) {
        // We stopped waiting; the payment may still land. Its maximum fee
        // counts as spent (pendingRebalances), and the books are settled when
        // a later run learns how it ended.
        inFlight.add(res.targetId).add(res.sourceId);
        out.push({ alias: res.targetAlias, amountSats: res.amountSats, feeSats: null, costPpm: null, ok: false, inFlight: true, error: res.error });
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

    this.explain("rebalance", () => this.rebalanceDecision(report.recommendations, out, plan.later, budgetSkips, waiting));
    return out;
  }

  /** The rebalance stage's decision, said plainly (D16): what ran, what waits
   *  and why — or why nothing qualifies. Refills sent: acted (all of them
   *  failing: an error; one still in flight is no failure yet); moves left for
   *  the budget, the per-run limit or a busy channel: waiting; nothing that
   *  clears the profit check: idle. */
  private rebalanceDecision(
    recs: Pick<RebalanceRecommendation, "state">[],
    ran: AutopilotRebalance[],
    later: RebalanceRecommendation[],
    budgetSkips: string[],
    waiting: string[],
  ): { text: string; state: DecisionState } {
    const parts: string[] = [];
    const inFlight = ran.filter((r) => r.inFlight).length;
    if (ran.length) {
      parts.push(
        `${ran.filter((r) => r.ok).length} of ${ran.length} refill${ran.length === 1 ? "" : "s"} paid` + (inFlight ? ` (${inFlight} still in flight)` : ""),
      );
    }
    if (budgetSkips.length) {
      const b = this.rebalanceBudget();
      parts.push(
        `${budgetSkips.length} profitable refill${budgetSkips.length === 1 ? " waits" : "s wait"} for the daily budget — ` +
          `${b.spentSats.toLocaleString("en-US")} of ${(b.budgetSats ?? 0).toLocaleString("en-US")} sat spent today, resets 00:00 UTC: ${budgetSkips.join(", ")}`,
      );
    }
    if (later.length) parts.push(`${later.length} more wait${later.length === 1 ? "s" : ""} for the next run (at most ${this.state.config.maxRebalancesPerRun} per run)`);
    if (waiting.length) parts.push(waiting.join("; "));
    if (parts.length) {
      const state: DecisionState = ran.length
        ? ran.some((r) => r.ok || r.inFlight)
          ? "acted"
          : "error"
        : "waiting";
      return { text: parts.join(" · "), state };
    }
    const drained = recs.filter((r) => r.state !== "not_needed").length;
    return {
      text: drained
        ? `no refill clears the profit check right now (${drained} drained channel${drained === 1 ? "" : "s"} watched — see what each would need on the Rebalancing tab)`
        : "no channel needs a refill",
      state: "idle",
    };
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
   * It is booked at no more than the target's fee as the executor read it
   * when the refill was sent (heldAt): in the write-ahead record and in the
   * log record alike.
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
      targetPpm?: number;
    }): PendingRebalance => {
      const at = new Date().toISOString();
      const hold = heldAt(meta.holdPpm, p.targetPpm);
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
        ...(hold != null ? { holdPpm: hold } : {}),
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
          targetPpm: a.targetPpm,
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
    // Nothing was sent after all: no attempt, so no cooldown.
    const giveCooldownBack = () => {
      if (sent.size > 0) return;
      if (cooldownBefore === undefined) delete this.state.perTargetLastRebalanced[meta.targetId];
      else this.state.perTargetLastRebalanced[meta.targetId] = cooldownBefore;
    };
    const settle = async (exec: (hooks: RefillHooks) => Promise<RebalanceExecResult>): Promise<RebalanceExecResult> => {
      try {
        let res: RebalanceExecResult;
        try {
          res = await exec(hooks);
        } catch (err) {
          // The executor threw before its first attempt (LND didn't answer
          // its reads) — or after one, if ever: then the cooldown stays.
          giveCooldownBack();
          this.persist();
          throw err;
        }
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
                targetPpm: res.targetPpm,
              }),
            );
          }
        } else if (res.stopped) {
          // Stopped by the shutdown before its next attempt: a skip (D15),
          // nothing for the log — nothing was paid, and what failed before
          // it backs off (notePairs above). Nothing sent at all: no attempt,
          // no cooldown.
          giveCooldownBack();
        } else {
          // Its fee belongs to the budget day it was sent on, like a payment
          // that ends after a restart.
          const entry = res.paymentId ? sent.get(res.paymentId) : undefined;
          this.rebalanceLog.append({
            ...this.rebalanceRecord(res, meta.via, heldAt(meta.holdPpm, res.targetPpm)),
            ...(entry ? { startedAt: entry.at } : {}),
          });
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
   *
   * `planAt`: when the plan the request came from was made (the tab sends
   * its plan's generatedAt). A target refilled — or tried — since then is
   * refused (StalePlanError): the row was planned for a channel that is no
   * longer the one it describes (review of P3: a stale row paid a second
   * refill into a target the autopilot had just refilled). A request
   * without it (an API client of its own) is not checked.
   */
  async rebalanceByHand(params: RebalanceExecParams & { planAt?: string }): Promise<RebalanceExecResult | null> {
    const writeLnd = this.writeLnd;
    if (!writeLnd) throw new Error("writing is disabled");
    if (this.refilling || this.shuttingDown) return null;
    const busy = this.inFlightThrough([params.targetId, params.sourceId, ...(params.sources ?? []).map((s) => s.id)]);
    if (busy) throw new RefillInFlightError(busy.channelId, busy.payment);
    const { planAt, ...exec } = params;
    // The target's last refill (or try): when it started — the cooldown
    // stamp — and when it ended, as booked. A plan made while one was under
    // way read the channel drained and is as stale as one made before it:
    // the start alone let it through (review of P4: a plan stamped between
    // an autopilot refill's start and its landing paid a second refill).
    const lastAt = [this.state.perTargetLastRebalanced[params.targetId], this.rebalanceLog.lastInto(params.targetId)]
      .filter((at): at is string => typeof at === "string" && Number.isFinite(Date.parse(at)))
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    if (planAt !== undefined && lastAt !== undefined && Date.parse(lastAt) > Date.parse(planAt)) {
      throw new StalePlanError(params.targetId, lastAt, planAt);
    }
    const budget = this.rebalanceBudget();
    if (budget.leftSats !== null && budget.leftSats <= 0) throw new RebalanceBudgetError(budget);
    this.refilling = true;
    try {
      const maxFeeSats = Math.min(params.maxFeeSats ?? Infinity, budget.leftSats ?? Infinity);
      return await this.refillBooks({ targetId: params.targetId, via: "manual", holdPpm: params.gate?.revenuePpm ?? null }).settle((hooks) =>
        this.rebalanceExec(
          writeLnd,
          { ...exec, ...(Number.isFinite(maxFeeSats) ? { maxFeeSats } : {}) },
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

  /**
   * The channel stage: open a channel to the best suggestion that can really
   * be opened, when on-chain funds allow (review a3-channels — package P4).
   *
   * Before, it looked at suggestion #1 only. A peer that refused (its minimum
   * channel size, no address, offline) was asked again every 30 minutes,
   * forever, and nothing else was ever tried; a top pick bigger than the
   * wallet ended the stage silently. Every deferral was written as a failed
   * run — 48 a day in a 50-run history.
   *
   * Now it walks down the ranked suggestions (planOpen decides per peer:
   * usefulness, LN+ sentiment, a recent close, an earlier refusal's back-off,
   * an address to dial, the peer's known minimum and maximum, the funds, the
   * payback) and dials at most MAX_OPEN_TRIES_PER_RUN of them; a peer that
   * refuses before anything is broadcast is remembered with a back-off and
   * the next one is tried. Opens pay an economy fee rate (OPEN_CONF_TARGET)
   * at or below the operator's maximum, and only when opening and later
   * closing pay back within OPEN_PAYBACK_MONTHS of what a channel earns here.
   * Every open goes through the shared on-chain mutex and capital ledger.
   * Waits and deferrals are the stage's decision note (D15/D16), not failed
   * runs; a real attempt that failed is a run entry — once, not again while
   * it keeps failing the same way.
   */
  private async runChannels(writeLnd: AuthenticatedLnd): Promise<AutopilotChannelOpen[]> {
    const cfg = this.state.config;
    const note = (text: string, state: DecisionState) => this.decisionNote("channels", text, state);

    // LND refused the write client the peer listing every open needs (no
    // peers:read — at start, or in an earlier run's open): asked again, which
    // is cheap, and while it still refuses no plan is worked out (LN+ lookups
    // and all) for an open that can't go out. The run that ran into it has
    // the failed open on record; this is the area's standing state.
    if (opensBlocked(writeLnd)) {
      await checkPeerListing(writeLnd);
      const blocked = opensBlocked(writeLnd);
      if (blocked) {
        note(`no channel opened — ${blocked}`, "blocked");
        return [];
      }
    }

    // An open handed to LND that never got its answer: the process went down
    // mid-open (write-ahead, openTo). Its funding may be out — it counts as
    // an open that ended unclearly, so the cooldown runs from it (review
    // 2026-10-25: a restart while LND funded an open knew no cooldown, and
    // the next run opened a second channel at once).
    if (this.state.channelOpening !== undefined && this.state.channelOpening !== null) {
      const left = validOpening(this.state.channelOpening);
      this.state.channelOpening = null;
      if (left) {
        const prev = this.state.lastChannelOpenAt ? Date.parse(this.state.lastChannelOpenAt) : NaN;
        if (!(prev >= Date.parse(left.at))) this.state.lastChannelOpenAt = left.at;
        this.state.lastChannelOpenUnclear = left.alias;
        logLine("warn", `[autopilot] channels: the open to ${left.alias} (${fmtSat(left.sizeSats)} sat, ${left.at}) never got LND's answer — it counts as unclear, and the cooldown runs from it`);
      }
      this.persist();
    }

    // Respect the cooldown between auto-opens — after an open, and after one
    // that ended unclearly (it may have opened a channel).
    if (this.state.lastChannelOpenAt) {
      const elapsedMin = (Date.now() - new Date(this.state.lastChannelOpenAt).getTime()) / 60_000;
      if (elapsedMin < cfg.channelCooldownMinutes) {
        const unclear = this.state.lastChannelOpenUnclear;
        note(
          unclear
            ? `the open to ${unclear} ${Math.round(elapsedMin)} min ago ended unclearly — it may have opened a channel; the next open waits for the ${cfg.channelCooldownMinutes}-minute cooldown`
            : `a channel was opened ${Math.round(elapsedMin)} min ago — the next open waits for the ${cfg.channelCooldownMinutes}-minute cooldown`,
          "waiting",
        );
        return [];
      }
    }

    // A cheap look first: no point in the slow planning reads below without
    // coins to spend. What counts is the shared budget (capital.ts): balance
    // minus the effective reserve (LND's anchor reserve and the funding fee
    // included) minus every coin promised to a sold channel not yet opened —
    // Magma and LSPS1 alike, across runs and restarts.
    const pre = await spendableOnchain(this.readLnd, this.capital, cfg.channelReserveSats);
    if (pre.spendableSat <= 0) {
      note(
        `nothing to open with: ${fmtSat(pre.chainSat)} sat on chain, all of it needed for the reserve (${fmtSat(pre.reserve.totalSat)} sat)` +
          (pre.reservedSat > 0 ? ` and the ${fmtSat(pre.reservedSat)} sat promised to sold channels` : ""),
        "waiting",
      );
      return [];
    }

    // The on-chain fee an open pays: an economy rate — an open is not
    // urgent — and never above the operator's maximum. No estimate from LND:
    // no open (LND would have to guess the fee itself).
    const rate = await this.openFeeRate();
    if (rate === null) {
      note("LND gave no on-chain fee estimate — no channel is opened until it does", "waiting");
      return [];
    }
    if (rate > cfg.channelMaxFeeRate) {
      note(`on-chain fees are ${rate} sat/vB at the economy rate — above your ${cfg.channelMaxFeeRate} sat/vB maximum for opens; waiting for cheaper fees`, "waiting");
      return [];
    }

    // Capital engine (D10): with Liquidity provision on, the coins Magma can
    // list are held for it — only when Magma can actually take them and is
    // expected to earn more on them (leaveForMagma) — and the rest stays free
    // for routing opens. Before, the deferral read no lease data at all (a
    // dispersion test of routing yields), and later held back every coin,
    // also what the deploy cap keeps Magma from ever listing.
    let hold: { heldSat: number; text: string | null } = { heldSat: 0, text: null };
    if (cfg.sellEnabled) {
      try {
        hold = await this.leaveForMagma();
      } catch (err) {
        // No answer: nothing held — the open goes ahead. Said in the log (it
        // was silent): the comparison it skipped is the one that holds
        // capital back for Magma.
        logLine("warn", `[autopilot] channels: the Magma comparison couldn't be made (${errText(err)}) — nothing is held back for it`);
      }
    }
    const free = Math.max(0, pre.spendableSat - hold.heldSat);
    /** Every note of the stage carries what is held for Magma, and what is free. */
    const withHold = (text: string): string =>
      hold.text ? `${text} · ${hold.text}${hold.heldSat > 0 ? `; ${fmtSat(free)} sat left for routing opens` : ""}` : text;
    // What is left can't fund the smallest open this stage makes (your
    // channel size, else the auto-size floor): the open waits for Magma.
    const smallest = cfg.channelSizeSats > 0 ? cfg.channelSizeSats : AUTO_SIZE_MIN_SATS;
    if (hold.heldSat > 0 && free < smallest) {
      note(
        `deferred: ${hold.text} — ${free > 0 ? `the ${fmtSat(free)} sat left` : "nothing left"} for a routing open ` +
          `(${fmtSat(pre.spendableSat)} sat spendable; the smallest open is ${fmtSat(smallest)} sat)`,
        "deferred",
      );
      return [];
    }

    // The autopilot opens channels with real capital, so it gets the LN+ trust
    // signal too: a peer other operators rate badly is a bad place to lock funds.
    const [{ suggestions }, earning, connected] = await Promise.all([
      this.channelSuggestions(),
      this.openEconomics(),
      this.connectedPeers(),
    ]);
    // The reads above take a while: the shutdown signal, or the switch going
    // off (all automation paused), may have come meanwhile.
    const halt = this.stopWhy("channelEnabled");
    if (halt) {
      note(openStopped(halt), "waiting");
      return [];
    }
    // This node's own connection first: LND keeps a few peers connected for
    // gossip at all times, so none at all means Tor or the internet is down
    // here — every dial would fail, and each failure would be booked against
    // a good peer (a day's back-off, then a week's). Nobody is dialed, and
    // nobody held back, until LND is connected again.
    if (connected === null) {
      note("LND didn't list its connected peers — no peer is dialed this run (and none is held back for it)", "error");
      return [];
    }
    if (connected.size === 0) {
      note("this node is connected to no peer at all right now (Tor or the internet down?) — no peer is dialed, and none is held back for it, until it is", "error");
      return [];
    }
    if (suggestions.length === 0) {
      note("no peer to suggest right now (no candidate in the graph passes the filters)", "idle");
      return [];
    }
    const ctx: OpenContext = {
      fixedSize: cfg.channelSizeSats > 0 ? cfg.channelSizeSats : null,
      spendableSat: free,
      heldSat: hold.heldSat,
      feeRate: rate,
      yieldPpmYear: earning?.ppmYear ?? null,
      maxRaiseSat: Math.floor((earning?.capitalSat ?? pre.chainSat) * MAX_CAPITAL_SHARE_PER_OPEN),
      peers: this.state.peerOpenFailures ?? {},
      connected,
      neverOpen: new Set(Object.keys(this.state.neverOpen ?? {})),
      nowMs: Date.now(),
    };

    const skipped: string[] = [];
    const refused: { alias: string; days: number; sizeLimit: boolean }[] = [];
    const out: AutopilotChannelOpen[] = [];
    let tries = 0;
    const dialsFrom = Date.now();
    for (const s of suggestions) {
      if (tries >= MAX_OPEN_TRIES_PER_RUN || (tries > 0 && Date.now() - dialsFrom > OPEN_DIAL_BUDGET_MS)) break;
      // Before each peer: an open to the one before may have taken a minute
      // and a half (a slow dial over Tor) — time enough for a pause.
      const stop = this.stopWhy("channelEnabled");
      if (stop) {
        this.persist();
        note([refusalNote(refused), openStopped(stop)].filter(Boolean).join(" · "), "waiting");
        return out;
      }
      const plan = planOpen(s, ctx);
      if ("skip" in plan) {
        skipped.push(`${s.alias}: ${plan.skip}`);
        continue;
      }
      tries += 1;
      const res = await this.openTo(writeLnd, s, plan.sizeSats, rate, hold.heldSat);
      if (res.kind === "opened") {
        delete this.state.peerOpenFailures?.[s.pubkey];
        this.channelLast.delete(s.pubkey);
        this.channelLast.delete(SELF_NEWS_KEY);
        // Said when the payback could not be checked (only the fee cap applied).
        const unchecked =
          earning === null
            ? "what a channel earns here couldn't be read from LND"
            : earning.ppmYear === null
              ? unmeasuredYieldText(earning.evidence)
              : null;
        note(
          withHold(
            `opened ${fmtSat(plan.sizeSats)} sat to ${s.alias} at ${rate} sat/vB${plan.why ? ` (${plan.why})` : ""}` +
              (unchecked ? ` — no payback check: ${unchecked}` : ""),
          ),
          "acted",
        );
        this.persist();
        return [...out, { alias: s.alias, sizeSats: plan.sizeSats, ok: true, transactionId: res.transactionId }];
      }
      if (res.kind === "deferred") {
        // The final capital check (inside the mutex), the shutdown or the
        // switch going off: not the peer's doing — nothing to remember about
        // it. (Earlier peers' refusals this run are said too.)
        note(withHold([refusalNote(refused), res.reason].filter(Boolean).join(" · ")), "waiting");
        return out;
      }
      if (res.kind === "blocked") {
        // LND won't list its peers to the write macaroon (no peers:read): no
        // connection can be checked, so no open can go out — to this peer or
        // any other. This node's setup, not the peer's refusal: nobody is
        // held back for it, no further peer is tried, and the area says it
        // is blocked until the operator fixes the macaroon (before, it read
        // "the peer looks offline", and each healthy peer was backed off a
        // day, then a week, then a month). In the pass's result every time;
        // a line of history only while it is news.
        const repeat = !this.channelNews(SELF_NEWS_KEY, res.reason);
        out.push({ alias: s.alias, sizeSats: plan.sizeSats, ok: false, error: res.reason, ...(repeat ? { repeat } : {}) });
        note([refusalNote(refused), `no channel opened — ${res.reason}`].filter(Boolean).join(" · "), "blocked");
        this.persist();
        return out;
      }
      // This node's own doing — its wallet, its chain, its connection — is
      // not the peer's: nobody is held back for it, and no further peer is
      // tried (each would fail the same way). One line of history while the
      // cause stays the same.
      const own = nodeSideRefusal(res.error) ?? (isUnreachable(res.error) ? await this.connectivityLost() : null);
      if (own) {
        // In the pass's result every time; a line of history only while
        // it is news (runOnce leaves `repeat` out of the history).
        const repeat = !this.channelNews(SELF_NEWS_KEY, own);
        out.push({ alias: s.alias, sizeSats: plan.sizeSats, ok: false, error: `${own} — not the peer's doing (${res.error})`, ...(repeat ? { repeat } : {}) });
        // (LND's text in full: "need 0.05 BTC only have 0.045 BTC available"
        // says how far the wallet is from it.)
        // (A macaroon LND refuses the open: the operator's to fix — blocked.)
        note(
          `no channel opened — ${own}: the open to ${s.alias} failed (${res.error.replace(/^\w+: /, "")}), not by the peer's doing — ` +
            "no peer is held back for it, and the next run tries again",
          isPermissionDenied(res.error) ? "blocked" : "error",
        );
        this.persist();
        return out;
      }
      // The node itself was fine: its next trouble is news again.
      this.channelLast.delete(SELF_NEWS_KEY);
      refused.push({ alias: s.alias, ...this.notePeerRefusal(s, res.error, plan.sizeSats) });
      const repeat = !this.channelNews(s.pubkey, res.error);
      out.push({ alias: s.alias, sizeSats: plan.sizeSats, ok: false, error: res.error, ...(repeat ? { repeat } : {}) });
      if (!res.preBroadcast) {
        // The outcome is unclear (a dropped stream, a timeout): the funding
        // may have been broadcast. No other open now — the next run sees the
        // wallet as it really is — and the cooldown runs as after an open:
        // before, the next run (30 minutes later) opened another channel
        // beside the one that may exist, whatever the operator's cooldown.
        this.state.lastChannelOpenAt = new Date().toISOString();
        this.state.lastChannelOpenUnclear = s.alias;
        note(`the open to ${s.alias} ended unclearly (${res.error}) — it may have opened a channel: no other open this run, and the next waits for the cooldown`, "error");
        this.persist();
        return out;
      }
    }
    this.persist();
    // (Every refusal counts here, also one not repeated in the run history.)
    const why = skipped.slice(0, 3).join("; ") + (skipped.length > 3 ? `; and ${skipped.length - 3} more` : "");
    // A refusal or a peer waiting out its back-off or the funds: waiting;
    // only nothing to open at all is idle.
    note(
      withHold(`no channel opened — ${[refusalNote(refused), why].filter(Boolean).join(" · ") || "no suggestion qualified"}`),
      refused.length || skipped.length ? "waiting" : "idle",
    );
    return out;
  }

  /** The peers LND is connected to right now (null: LND didn't say). */
  private async connectedPeers(): Promise<Set<string> | null> {
    try {
      const { peers } = await getPeers({ lnd: this.readLnd });
      return new Set(peers.map((p) => p.public_key));
    } catch {
      return null;
    }
  }

  /** After a peer couldn't be reached: whether this node lost its own
   *  connection meanwhile — no peer connected at all (or LND can't say) —
   *  and then what to call it; null: other peers are connected, so the
   *  unreachable one is the peer's doing. */
  private async connectivityLost(): Promise<string | null> {
    const peers = await this.connectedPeers();
    if (peers === null) return "LND didn't list its connected peers";
    return peers.size === 0 ? "this node lost its connection to every peer (Tor or the internet down?)" : null;
  }

  /** The economy fee rate an automatic open pays (sat/vB, rounded, at least
   *  1), or null when LND can't estimate one. Rounded, not up: LND's floor of
   *  253 sat/kw is 1.012 sat/vB, which rounded up paid 2 — twice the fee, and
   *  a payback judged at twice the cost (review 2026-10-25; the manual Open
   *  form rounds the same estimate). LND lifts a rate below its floor itself. */
  private async openFeeRate(): Promise<number | null> {
    try {
      const { tokens_per_vbyte } = await getChainFeeRate({ lnd: this.readLnd, confirmation_target: OPEN_CONF_TARGET });
      return Number.isFinite(tokens_per_vbyte) && tokens_per_vbyte > 0 ? Math.max(1, Math.round(tokens_per_vbyte)) : null;
    } catch {
      return null;
    }
  }

  /**
   * What a sat in this node's month-old channels earned (ppm/yr, the last
   * 30 days, capacity-weighted) — what a new channel's open and close must
   * pay back — with what that stands on, and the node's capital (on chain +
   * its side of open channels). Yield null: no channel older than a month,
   * or too little routing through them to tell (measuredYield) — then there
   * is nothing to measure a payback against, and only the maximum fee rate
   * applies (a node can always open its first channels).
   *
   * (The Magma comparison, D10, quotes the same capacity-weighted figure
   * since 2026-10-25 — it asked what the MEDIAN month-old channel earned, 0
   * on a node where most channels route nothing, and deferred every open.)
   */
  async openEconomics(): Promise<{ ppmYear: number | null; capitalSat: number; evidence: YieldEvidence } | null> {
    try {
      const [chans, report, info, chain] = await Promise.all([
        getChannelsView(this.readLnd),
        getForwardsReport(this.readLnd, 30).catch(() => null),
        getWalletInfo({ lnd: this.readLnd }),
        getChainBalance({ lnd: this.readLnd }),
      ]);
      const capitalSat = chain.chain_balance + chans.filter((c) => c.status === "open").reduce((s, c) => s + c.localBalance, 0);
      const aged = monthOldChannels(chans, info.current_block_height);
      const stats = new Map((report?.perChannel ?? []).map((c) => [c.channelId, c]));
      const evidence: YieldEvidence = {
        channels: aged.length,
        capacitySat: aged.reduce((s, c) => s + c.capacity, 0),
        forwards: aged.reduce((s, c) => s + (stats.get(c.id)?.forwardCount ?? 0), 0),
        earnedSat: aged.reduce((s, c) => s + (stats.get(c.id)?.feesEarnedSats ?? 0), 0),
        forwardsRead: report !== null,
      };
      return { ppmYear: measuredYield(evidence), capitalSat, evidence };
    } catch {
      return null;
    }
  }

  /** An alert while the shared on-chain lock has been held for more than
   *  ONCHAIN_LOCK_ALERT_MS: an LND call that never answers (an open's
   *  funding has no deadline) holds every spend behind it — Magma accepts,
   *  LSP opens, manual opens. Derived: gone once the lock is free. */
  onchainLockAlerts(nowMs = Date.now()): { level: "warn"; message: string }[] {
    const stuck = this.capital.mutex.heldTooLong(ONCHAIN_LOCK_ALERT_MS, nowMs);
    if (!stuck) return [];
    return [
      {
        level: "warn",
        message:
          `The on-chain lock has been held by "${stuck.holder}" for ${stuck.minutes} minutes — channel opens, Magma accepts and LSP opens wait behind it. ` +
          "If LND doesn't answer, restarting Lightning Mate frees it (an open it was waiting for then counts as unclear: no second one is made during the cooldown).",
      },
    ];
  }

  /**
   * Where the capital a close frees could go, for the close list's line: the
   * opens the channel autopilot would make — its ranked suggestions, LN+
   * sentiment included, that pass its peer rules (usefulness, an LN+ rating,
   * a recent close, a refusal's back-off, an address to dial, "never open
   * automatically", a peer's size limits against your channel size and a
   * third of the node's capital) — funds and payback aside: the close frees
   * the funds (review 2026-10-25: it named the top suggestion without LN+ or
   * the skip rules, a 6–10M open the autopilot would never make).
   */
  async swapTargets(): Promise<{ alias: string; score: number; sizeSats: number }[]> {
    const cfg = this.state.config;
    const [{ suggestions }, connected, earning] = await Promise.all([this.channelSuggestions(), this.connectedPeers(), this.openEconomics()]);
    const ctx: OpenContext = {
      fixedSize: cfg.channelSizeSats > 0 ? cfg.channelSizeSats : null,
      spendableSat: Number.POSITIVE_INFINITY,
      feeRate: 1,
      yieldPpmYear: null,
      // (A close moves capital on chain; the node's capital stays what it is.)
      maxRaiseSat: earning ? Math.floor(earning.capitalSat * MAX_CAPITAL_SHARE_PER_OPEN) : Number.POSITIVE_INFINITY,
      peers: this.state.peerOpenFailures ?? {},
      connected: connected ?? new Set(),
      neverOpen: new Set(Object.keys(this.state.neverOpen ?? {})),
      nowMs: Date.now(),
    };
    return suggestions
      .flatMap((s) => {
        const plan = planOpen(s, ctx);
        return "skip" in plan ? [] : [{ alias: s.alias, score: s.score, sizeSats: plan.sizeSats }];
      })
      .slice(0, 3);
  }

  /** For the close of a finished lease's channel (MagmaDesk
   *  closeFinishedLeases): the economy fee rate a close pays now, the
   *  operator's maximum for on-chain fees, and whether a channel routes well
   *  enough to keep — it earned (30 days) at least what a sat of this node's
   *  month-old channels earned, capacity-weighted. */
  async soldChannelClose(): Promise<{ feeRate: number | null; maxFeeRate: number; routesWell: (channelId: string) => boolean }> {
    const [feeRate, earning, report, chans] = await Promise.all([
      this.openFeeRate(),
      this.openEconomics(),
      getForwardsReport(this.readLnd, 30).catch(() => null),
      getChannelsView(this.readLnd).catch(() => null),
    ]);
    const ev = earning?.evidence;
    const nodePpm = earning?.ppmYear ?? (ev && ev.capacitySat > 0 ? (ev.earnedSat / ev.capacitySat) * (365 / 30) * 1_000_000 : null);
    const earned = new Map((report?.perChannel ?? []).map((c) => [c.channelId, c.feesEarnedSats]));
    const capacity = new Map((chans ?? []).map((c) => [c.id, c.capacity]));
    return {
      feeRate,
      maxFeeRate: this.state.config.channelMaxFeeRate,
      routesWell: (channelId) => {
        const sat = earned.get(channelId) ?? 0;
        const cap = capacity.get(channelId) ?? 0;
        if (sat <= 0 || cap <= 0) return false;
        const ppm = (sat / cap) * (365 / 30) * 1_000_000;
        return nodePpm === null || ppm >= nodePpm;
      },
    };
  }

  /**
   * Dial the peer (outside the mutex: over Tor that can take a minute and a
   * half, and a slow routing peer must not hold up a Magma accept's capital
   * check), then check the capital again and open, inside the on-chain mutex
   * every commitment shares (Magma fulfilment, LSPS1, manual opens).
   */
  private async openTo(
    writeLnd: AuthenticatedLnd,
    s: Pick<SuggestionV2, "pubkey" | "alias" | "socket" | "sockets">,
    sizeSats: number,
    feeRate: number,
    /** Of the spendable coins, those held for Magma (leaveForMagma): not
     *  this open's either, checked again with the fresh balance. */
    heldSat = 0,
  ): Promise<
    | { kind: "opened"; transactionId?: string }
    | { kind: "deferred"; reason: string }
    | { kind: "blocked"; reason: string }
    | { kind: "refused"; error: string; preBroadcast: boolean }
  > {
    // Every address it advertises, in dialing order (then the graph's).
    const sockets = [...new Set([...(s.sockets ?? []), ...(s.socket ? [s.socket] : [])])];
    const connected = await connectForOpen(writeLnd, { pubkey: s.pubkey, sockets });
    if (!connected.ok) {
      return connected.blocked ? { kind: "blocked", reason: connected.error } : { kind: "refused", error: connected.error, preBroadcast: true };
    }
    return this.capital.mutex.run("autopilot open", async () => {
      // The reads, the dial and the wait for the mutex take a while. A
      // shutdown signal — or the switch going off — that came meanwhile must
      // not be followed by a funding broadcast.
      const halt = this.stopWhy("channelEnabled");
      if (halt) return { kind: "deferred" as const, reason: openStopped(halt) };
      // Authoritative check with a fresh balance: a Magma order accepted since
      // the look above has its coins reserved, and they are not ours to spend
      // — nor what its own open will need on top: its funding fee, its step
      // of LND's anchor reserve, and the SELL reserve its check applies (a
      // sell reserve above the channel reserve used to be spent here).
      const sp = await spendableOnchain(this.readLnd, this.capital, this.state.config.channelReserveSats);
      if (sp.spendableSat - heldSat < sizeSats) {
        return {
          kind: "deferred" as const,
          reason:
            `deferred: only ${fmtSat(Math.max(0, sp.spendableSat - heldSat))} sat spendable after the reserve` +
            (heldSat > 0
              ? `, the ${fmtSat(sp.reservedSat)} sat promised to sold channels and the ${fmtSat(heldSat)} sat held for Magma`
              : ` and the ${fmtSat(sp.reservedSat)} sat promised to sold channels`) +
            ` — ${s.alias} needs ${fmtSat(sizeSats)} sat`,
        };
      }
      const late = this.stopWhy("channelEnabled");
      if (late) return { kind: "deferred" as const, reason: openStopped(late) };
      const routing = this.initialRoutingFee();
      // Write-ahead: on record before LND has it — a process that goes down
      // while LND funds the open finds it at the next channel stage, as an
      // open that ended unclearly (its cooldown runs).
      this.state.channelOpening = { pubkey: s.pubkey, alias: s.alias, sizeSats, at: new Date().toISOString() };
      this.persist();
      const res = await fundChannel(writeLnd, {
        pubkey: s.pubkey,
        localTokens: sizeSats,
        feeRate,
        routingFeePpm: routing.feeRatePpm,
        routingBaseFeeMsat: routing.baseFeeMsat,
      });
      // Answered: the caller records how it ended (the cooldown for an open,
      // or an unclear one; nothing for a refusal before the broadcast).
      this.state.channelOpening = null;
      if (res.ok) {
        this.state.lastChannelOpenAt = new Date().toISOString();
        this.state.lastChannelOpenUnclear = null;
        // The open cooldown is the only thing between runs that stops another
        // open — it must survive a crash right after this one.
        this.persist();
        return { kind: "opened" as const, transactionId: res.transactionId };
      }
      this.persist();
      const error = res.error ?? "the open failed";
      return { kind: "refused" as const, error, preBroadcast: isPreBroadcastRefusal(error) };
    });
  }

  /**
   * The routing fee a new channel starts with — the protected fee the fee
   * engine gives a brand-new channel (FEE_REC_DEFAULTS.newChannelMinPpm),
   * within the policy's range, and the policy's base fee. Without it a new
   * channel kept LND's own default (stock: 1 sat + 1 ppm) until something set
   * a fee: forever, with fee automation off. Manual opens start the same way.
   */
  initialRoutingFee(): { feeRatePpm: number; baseFeeMsat: number } {
    const p = this.state.config.policy;
    return {
      feeRatePpm: Math.min(p.maxPpm, Math.max(p.minPpm, FEE_REC_DEFAULTS.newChannelMinPpm)),
      baseFeeMsat: p.baseFeeMsat,
    };
  }

  /** A peer refused an open (or couldn't be reached): remember it, with a
   *  back-off — none when it told its size limits: the next plan meets them
   *  (or skips the peer, saying why). Returns the wait, for the note. */
  private notePeerRefusal(s: Pick<SuggestionV2, "pubkey" | "alias">, error: string, sizeSats: number): { days: number; sizeLimit: boolean } {
    const peers = (this.state.peerOpenFailures ??= {});
    const prev = peers[s.pubkey];
    const fails = (prev?.fails ?? 0) + 1;
    const min = peerMinChannelFromError(error);
    const max = peerMaxChannelFromError(error);
    const sizeLimit = (min !== null && min > sizeSats) || (max !== null && max < sizeSats);
    const backoffDays = sizeLimit ? 0 : PEER_BACKOFF_DAYS[Math.min(fails, PEER_BACKOFF_DAYS.length) - 1];
    const nowMs = Date.now();
    peers[s.pubkey] = {
      alias: s.alias,
      fails,
      lastAt: new Date(nowMs).toISOString(),
      retryAt: new Date(nowMs + backoffDays * 86_400_000).toISOString(),
      error,
      ...(min !== null ? { minChannelSats: min } : prev?.minChannelSats !== undefined ? { minChannelSats: prev.minChannelSats } : {}),
      ...(max !== null ? { maxChannelSats: max } : prev?.maxChannelSats !== undefined ? { maxChannelSats: prev.maxChannelSats } : {}),
    };
    // Bounded: the oldest records go first.
    const keys = Object.keys(peers);
    if (keys.length > PEER_RECORDS_KEPT) {
      for (const k of keys.sort((a, b) => Date.parse(peers[a].lastAt) - Date.parse(peers[b].lastAt)).slice(0, keys.length - PEER_RECORDS_KEPT)) delete peers[k];
    }
    return { days: backoffDays, sizeLimit };
  }

  /** Whether a failed open is news for the run history: the first of a run
   *  of identical failures to one peer is; the same one again is not (it is
   *  counted on the peer's record and said in the decision note). Amounts
   *  don't make a failure different. */
  private channelNews(pubkey: string, error: string): boolean {
    const sig = error.replace(/\d[\d,.]*/g, "#");
    if (this.channelLast.get(pubkey) === sig) return false;
    this.channelLast.set(pubkey, sig);
    while (this.channelLast.size > 500) this.channelLast.delete(this.channelLast.keys().next().value as string);
    return true;
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
    if (!cfg.sellEnabled || this.shuttingDown) return [];
    if (!this.amboss.hasKey()) {
      this.decisionNote("magma", "no Amboss API key — connect one in Settings: no offer is kept and no order is taken", "blocked");
      return [];
    }
    const key = this.amboss.getKey();
    const out: AutopilotSell[] = [];
    // What the upkeep left as it is, and why (the offer notes).
    const notes: string[] = [];
    const sync = this.syncState();
    sync.managed = true;
    const failed = (message: string): AutopilotSell[] => {
      sync.lastError = { at: new Date().toISOString(), message };
      this.decisionNote("magma", `offer upkeep failed: ${message}`, "error");
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
    // Upkeep works again: its next failure is news (laneNews).
    this.laneLast.delete("offers");
    this.applySwitchOn(offers);

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
      return {
        fee: r.recommended.feeRatePpm,
        base: r.recommended.baseFeeSat,
        moved: r.shouldReprice,
        lease: r.recommended.minBlockLength,
        ...(r.baseOnly
          ? {
              why: `base fee set to ${fmtSat(r.recommended.baseFeeSat)} sat (was ${fmtSat(off.baseFeeSats)}) — what comparable offers charge; the rate makes up the rest, so the price at the representative size √(min·max) stays`,
            }
          : {}),
      };
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
        const cost = saleCostFloorSats(sell);
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
      // Shutting down: offer upkeep can wait for the next start (its Amboss
      // calls must not use up the shutdown grace the order lane may still
      // need). Liquidity provision switched off — or all automation paused —
      // since the stage began: the offers are the operator's again, left
      // exactly as they are (the pause asked them about listed offers).
      const stop = this.stopWhy("sellEnabled");
      if (stop) {
        entries.push(this.syncEntry(off, null, undefined, this.shuttingDown ? undefined : `left as it is: ${stop}`));
        continue;
      }
      entries.push(await this.upkeepOffer(key, off, ctx, out, readAt, notes));
    }
    // Cut memories of offers that are gone have nothing left to give back,
    // and their ownership records nothing left to own.
    for (const id of Object.keys(this.state.offerCuts ?? {})) {
      if (!offers.some((o) => o.id === id)) delete this.state.offerCuts?.[id];
    }
    for (const id of Object.keys(this.state.offerControl ?? {})) {
      if (!offers.some((o) => o.id === id)) delete this.state.offerControl?.[id];
    }
    for (const id of Object.keys(this.state.offerPrices ?? {})) {
      if (!offers.some((o) => o.id === id)) delete this.state.offerPrices?.[id];
    }
    for (const id of Object.keys(this.state.offerBaseMoves ?? {})) {
      if (!offers.some((o) => o.id === id)) delete this.state.offerBaseMoves?.[id];
    }
    for (const id of Object.keys(this.state.offerBaseMovedAt ?? {})) {
      if (!offers.some((o) => o.id === id)) delete this.state.offerBaseMovedAt?.[id];
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
    let noOffer: { text: string; state: DecisionState } | null = null;
    if (offers.length === 0) noOffer = this.whyNoOffer(rec, createRec !== undefined, realistic);
    if (canCreate && rec && createRec && realistic?.ok) {
      const viable = rec.sell.minViableSizeSat ?? 1_000_000;
      const minCh = Math.min(viable, ctx.maxOrder(viable));
      const maxCh = ctx.maxOrder(minCh);
      const listed = ctx.listable(minCh);
      if (!(minCh > 0 && listed >= minCh && maxCh >= minCh)) {
        noOffer = {
          text: `no offer listed: only ${fmtSat(listed)} sat could be listed after the reserve, promised orders and the deploy cap — below the smallest channel worth selling (${fmtSat(viable)} sat)`,
          state: "waiting",
        };
      }
      // The selling check above reads Amboss's public book (it can take a
      // while): the switch is asked again here — which spares the key read
      // below — and once more after that read, right before the create.
      const stop = this.stopWhy("sellEnabled");
      if (stop && minCh > 0 && listed >= minCh && maxCh >= minCh) {
        noOffer = { text: `no offer listed: ${stop}`, state: "waiting" };
      } else if (minCh > 0 && listed >= minCh && maxCh >= minCh) {
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
          ...NO_EXTRA_TERMS,
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
          // That read is awaited too: the switch, once more — with nothing
          // awaited between this check and the create (review of P7, round
          // 2: a pause that landed during the key read still listed the
          // offer, with nobody fulfilling its orders).
          const late = this.stopWhy("sellEnabled");
          if (late) {
            noOffer = { text: `no offer listed: ${late}`, state: "waiting" };
          } else {
            const id = await createOffer(key, pubkey, terms);
            write.ok = true;
            const created = await getMyOffer(key, id).catch(() => null);
            write.verified = created ? termsMatch(created, terms) : undefined;
            this.rememberPrice({ id, ...terms });
            // What is wanted for it is what was sent — not what Amboss shows.
            if (created) entries.push(this.syncEntry(created, { ...fieldsOf(created), ...terms }, write));
            out.push({ orderId: id, action: "create", sizeSats: terms.totalSizeSats, ok: true });
          }
        } catch (err) {
          write.error = errText(err);
          out.push({ orderId: "new-offer", action: "create", sizeSats: terms.totalSizeSats, ok: false, error: write.error });
          sync.lastError = { at: write.at, message: `creating an offer failed: ${write.error}` };
        }
      }
    }
    sync.offers = entries;
    sync.at = new Date().toISOString();
    // Switched off (or paused) during the run: whatever was written before
    // stands; nothing was written after — said, and a wait (not "nothing to
    // do") when nothing was written at all.
    const halted = this.shuttingDown ? null : this.stopWhy("sellEnabled");
    if (halted && !noOffer?.text.endsWith(halted)) notes.push(`${halted} — no further offer change was made`);
    this.explain("magma", () => {
      const d = this.upkeepDecision(offers, entries, out, notes, noOffer, cfg);
      return halted && d.state === "idle" ? { text: d.text, state: "waiting" } : d;
    });

    // Lease over (Amboss: CHANNEL_MONITORING_FINISHED): close to reclaim the
    // capital — not once the switch is off (stopWhy).
    if (cfg.sellAutoClose && !this.stopWhy("sellEnabled")) {
      try {
        out.push(...(await this.magma.closeFinishedLeases()));
      } catch (err) {
        out.push({ orderId: "leases", action: "error", sizeSats: 0, ok: false, error: `closing finished leases: ${errText(err)}` });
      }
    }
    return out;
  }

  /**
   * Why the autopilot lists no offer, with none on Amboss (D16: "Magma — no
   * offer listed: auto-pricing is off" was silent). Listing means choosing a
   * price, which only auto-pricing may do; then the market must pay above
   * this node's profit floor, there must be capital to list, and selling must
   * be realistic for this node (D8).
   */
  private whyNoOffer(
    rec: MagmaV2Report | null,
    canPrice: boolean,
    realistic: { ok: boolean; why: string } | null,
  ): { text: string; state: DecisionState } | null {
    const cfg = this.state.config;
    // Blocked, not idle: with selling on, nothing will ever be listed until
    // the operator acts — the Overview showed "Liquidity provision ON ·
    // nothing to do" (review of P7).
    if (!cfg.sellAutoReprice) {
      return { text: "no offer listed — auto-pricing is off, so the autopilot lists none: create one on Market → Sell, or turn auto-pricing on", state: "blocked" };
    }
    if (!rec) return { text: "no offer listed: the market recommendation could not be worked out this run (see Market → Sell)", state: "error" };
    const st = rec.sell.state;
    if (st === "insufficient_capital") {
      return { text: `no offer listed: ${rec.sell.reasons[0] ?? "not enough on-chain capital to list one"}`, state: "waiting" };
    }
    if (st !== "good_to_sell") {
      return { text: `no offer listed automatically: ${rec.sell.reasons[0] ?? "leasing doesn't beat routing at today's prices"}`, state: "idle" };
    }
    if (!canPrice) return { text: "no offer listed: the engine has no price to list one at", state: "idle" };
    if (realistic && !realistic.ok) return { text: `no offer listed automatically: ${realistic.why}`, state: "idle" };
    return null;
  }

  /**
   * The offer upkeep's decision (D16), said plainly: what it wrote to Amboss,
   * or why it left the offers as they are — or why there is none.
   */
  private upkeepDecision(
    offers: MyOffer[],
    entries: OfferSyncEntry[],
    out: AutopilotSell[],
    notes: string[],
    noOffer: { text: string; state: DecisionState } | null,
    cfg: AutopilotConfig,
  ): { text: string; state: DecisionState } {
    const writes = out.filter((a) => a.action !== "error" && a.action !== "skip" && a.action !== "close");
    const done = writes.filter((a) => a.ok);
    const bad = writes.filter((a) => !a.ok);
    const extra = notes.length ? ` · ${notes.join(" · ")}` : "";
    if (bad.length && !done.length) return { text: `an offer change Amboss didn't take: ${bad[0].error ?? "failed"}${extra}`, state: "error" };
    if (done.length) {
      const what = done.map((a) =>
        a.action === "create"
          ? "listed a new offer"
          : `${OFFER_VERB[a.action] ?? a.action} offer ${a.orderId.slice(0, 8)}…${a.action === "disable" && a.error ? ` (${a.error})` : ""}`,
      );
      return {
        text: `${what.join(", ")}${bad.length ? ` — ${bad.length} change${bad.length === 1 ? "" : "s"} failed (${bad[0].error ?? "failed"})` : ""}${extra}`,
        state: "acted",
      };
    }
    if (offers.length === 0) return noOffer ? { text: noOffer.text + extra, state: noOffer.state } : { text: `no offer listed${extra}`, state: "idle" };
    const listed = offers.filter((o) => o.status === "ENABLED");
    const enabled = listed.length;
    const disabled = offers.length - enabled;
    const terms = !cfg.sellAutoReprice && !cfg.sellAutoSize ? " — their terms are yours; the autopilot only keeps them fundable" : "";
    const inSync = entries.every((e) => e.wanted === null || e.inSync);
    // What is on Amboss, so "nothing to change" says what it left as it is.
    const shown = listed
      .slice(0, 2)
      .map((o) => `${o.id.slice(0, 8)}… ${fmtSat(o.minSizeSats)}–${fmtSat(o.maxSizeSats)} sat at ${fmtSat(o.feeRatePpm)} ppm + ${fmtSat(o.baseFeeSats)} sat`);
    return {
      text:
        `${enabled} offer${enabled === 1 ? "" : "s"} listed${shown.length ? ` (${shown.join("; ")}${enabled > 2 ? "; …" : ""})` : ""}` +
        `${disabled ? `, ${disabled} not (${offers.filter((o) => o.status !== "ENABLED").map((o) => o.status.toLowerCase()).join(", ")})` : ""}` +
        `${inSync ? ", nothing to change" : ""}${terms}${extra}`,
      state: "idle",
    };
  }

  /** One offer's upkeep: listed only while fundable, then its terms. */
  private async upkeepOffer(
    key: string,
    off: MyOffer,
    ctx: OfferCtx,
    out: AutopilotSell[],
    readAt: number,
    notes: string[] = [],
  ): Promise<OfferSyncEntry> {
    if (off.status === "ADMIN_DISABLED") {
      return this.syncEntry(off, null, undefined, "disabled by Amboss support — only Amboss can enable it again");
    }
    this.rememberPrice(off);
    let control = this.settleStatusRecords(off, readAt);
    const sellableNow = ctx.maxOrder(off.minSizeSats);
    const fundable = sellableNow >= Math.max(1, off.minSizeSats);
    const lackOfCapital = () =>
      `disabled by the autopilot for lack of capital: its smallest channel (${fmtSat(off.minSizeSats)} sat) can't be funded — ` +
      `${fmtSat(sellableNow)} sat sellable after the reserve, promised orders and the deploy cap; it is listed again once it can be`;
    const unanswered =
      "the autopilot disabled it for lack of capital, and Amboss's answer never came — the next read of the offer tells whether the disable landed";
    const priceSource = () =>
      !control.manual && this.state.config.sellAutoReprice
        ? "the autopilot prices it once it knows a price (the market recommendation, or one it had)"
        : "edit it on Market → Sell to give it one";
    const disabledWhy = (status: string): string =>
      control.listOnAt
        ? `Liquidity provision was switched on, so it is listed again ${
            listedForFree(off)
              ? `once it has a price — Amboss has it at 0 ppm + 0 sat: ${priceSource()}`
              : !fundable
                ? `once its smallest channel (${fmtSat(off.minSizeSats)} sat) can be funded — ${fmtSat(sellableNow)} sat sellable after the reserve, promised orders and the deploy cap`
                : "with the next run"
          }; "keep disabled" on Market → Sell keeps it off`
        : listedForFree(off) && !control.freeDisabledAt
        ? `offer is ${status} and has no price on Amboss (0 ppm + 0 sat) — ${
            !control.manual && this.state.config.sellAutoReprice
              ? "the autopilot prices it once it knows a price (the market recommendation, or one it had); or edit it on Market → Sell"
              : "edit it on Market → Sell to give it one"
          }, then enable it`
        : control.freeDisabledAt
        ? !control.manual && this.state.config.sellAutoReprice
          ? "disabled by the autopilot: Amboss listed it for free (0 ppm + 0 sat) — it is listed again at the autopilot's price for it once there is one (auto-pricing), or set one on Market → Sell"
          : FREE_DISABLED_WHY
        : control.disabledByHandAt
        ? "disabled by you — the autopilot leaves it disabled; enable it on Market → Sell to list it again"
        : control.autoDisabledAt
          ? lackOfCapital()
          : control.autoDisablingAt
            ? unanswered
            : `offer is ${status} — the autopilot doesn't enable an offer it didn't disable; enable it on Market → Sell to list it`;
    // A disabled offer the autopilot prices (auto-pricing on, terms not the
    // operator's) is never left at a price of nothing: its price is written —
    // whether it is listed stays the operator's click (or capital safety's,
    // just below: so one disabled for lack of capital, or disabled when
    // Liquidity provision was switched on, is listed in the same run once it
    // can be funded). Without this, an offer disabled at
    // 0 ppm + 0 sat — by hand after 0.8.0's partial writes, or for capital —
    // couldn't be listed again: enabling a free offer is refused, the price
    // buttons are the autopilot's, and the autopilot priced listed offers only.
    let pricedWhileOff: OfferWrite | undefined;
    if (off.status === "DISABLED" && listedForFree(off) && !control.manual && this.state.config.sellAutoReprice) {
      const r = await this.priceDisabledFree(key, off, ctx, out);
      if (r) {
        pricedWhileOff = r.write;
        if (r.offer) off = r.offer;
      }
    }
    // Capital safety, for every offer (the operator's own too): see
    // capitalStatus and capitalToggle.
    const wantStatus = capitalStatus(off.status, fundable, control);
    // The status change made this run, for the record when no terms write
    // follows (the Sell page says why the offer was listed again).
    let statusWrite: OfferWrite | undefined;
    if (wantStatus) {
      // Listed again only once the terms it is listed with are on Amboss —
      // written in full and read back (termsBeforeListing): its price, the size
      // that can be funded, the standard lease and promise. Before, the flip
      // came first: an offer disabled at 300 ppm + 100 sat was listed at that
      // price and repriced afterwards — or, that write not taken, stayed listed
      // at it, with a max channel it couldn't fund, until the next run.
      let firstWrite: OfferWrite | undefined;
      if (wantStatus === "ENABLED") {
        const prep = await this.termsBeforeListing(key, off, ctx, control, out);
        if ("stopped" in prep) return this.syncEntry(prep.offer, null, prep.write, `left as it is: ${prep.stopped}`);
        if ("failed" in prep) {
          if (prep.waits) return { ...this.syncEntry(prep.offer, prep.wanted, prep.write, prep.failed), listingWaits: prep.waits };
          return this.syncEntry(prep.offer, prep.wanted, prep.write, `not listed again: ${prep.failed}`);
        }
        off = prep.offer;
        firstWrite = prep.write;
      }
      const r = await this.capitalToggle(key, off, wantStatus, { fundable, sellableNow }, out);
      // Switched off before the flip (nothing sent), or while it was on its
      // way (taken off the market again: r.write says how that went).
      if (r.stopped) return this.syncEntry(r.offer, null, r.write ?? firstWrite, `left as it is: ${r.stopped}`);
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
      if (r.offer.status !== "ENABLED") return this.syncEntry(r.offer, wanted, r.write ?? firstWrite, disabledWhy(r.offer.status));
      off = r.offer;
      statusWrite =
        r.write && firstWrite ? { ...r.write, reason: `${r.write.reason} — after its terms were written: ${firstWrite.reason}` } : (r.write ?? firstWrite);
    }
    // Taken off the market for being free, its price the autopilot's
    // (auto-pricing on, terms not the operator's): its price goes back on and
    // it is listed again once there is one — as capital safety lists again
    // what it disabled. (On the upgrade from 0.8.0, an offer the first run
    // found at 0 ppm + 0 sat with the market report down would otherwise
    // have stayed off for good.)
    if (off.status === "DISABLED" && control.freeDisabledAt && !control.manual && this.state.config.sellAutoReprice && fundable) {
      const listed = await this.relistFree(key, off, ctx, out);
      if (listed) {
        off = listed;
        control = this.offerControlOf(off.id);
      }
    }
    if (off.status !== "ENABLED") return this.syncEntry(off, null, pricedWhileOff, disabledWhy(off.status));

    const want = this.wantedTerms(off, ctx, !!control.manual);
    if (listedForFree(want.fields)) {
      // Never a price of nothing — not kept as the wanted price, never sent.
      // (A run that keeps "what Amboss has" kept 0 ppm + 0 sat: 0.8.0's
      // partial writes left offers there.) The price the offer last had goes
      // back on; with none known — or one the operator owns — it is taken off
      // the market until it has a price.
      const last = control.manual ? null : this.priceForFree(off, ctx, want.fields.minBlockLength);
      if (!last) {
        const r = await this.disableFree(key, off, out);
        return this.syncEntry(
          r.offer,
          null,
          r.write ?? undefined,
          r.offer.status === "ENABLED" ? `listed for free (0 ppm + 0 sat) and not yet taken off the market: ${r.write?.error ?? "left for the next check"}` : FREE_DISABLED_WHY,
        );
      }
      want.fields.feeRatePpm = last.feeRatePpm;
      want.fields.baseFeeSats = last.baseFeeSats;
      want.reasons.push(
        `${last.engine ? "priced at the engine's" : "price put back to the last one it had,"} ${fmtSat(last.feeRatePpm)} ppm + ${fmtSat(last.baseFeeSats)} sat (Amboss listed it at 0 ppm + 0 sat)`,
      );
    }
    if (want.notes.length) notes.push(`offer ${off.id.slice(0, 8)}…: ${want.notes.join("; ")}`);
    const changed = termsChanges(off, want.fields);
    if (changed.length === 0) {
      // Amboss already has exactly this: the cut memory matches it as is.
      this.keepCut(off.id, want.cut);
      return this.syncEntry(off, want.fields, statusWrite, want.notes);
    }
    // Every term is sent, the unchanged ones too: Amboss resets what an update
    // leaves out (updateOffer) — sending only the new caps once listed this
    // node's offer at 0 ppm.
    const terms = fullTerms(want.fields, off);
    const write: OfferWrite = {
      at: new Date().toISOString(),
      by: "autopilot",
      action: "update",
      fields: ambossFields(terms),
      changed,
      ok: false,
      reason: want.reasons.join("; "),
    };
    let after = off;
    // One write per offer at a time (withOffer): an edit on Market → Sell
    // waits for this write and its read-back, and this one for the edit's.
    // Inside, the offer is read afresh: one whose terms changed since this
    // run read it — the operator's edit, or one on amboss.tech — is left as
    // it now is; the next run starts from it. (Review of P1b: the manual
    // write and this one crossed, the later one won, and the other's
    // read-back reported "not stored".)
    const outcome = await this.withOffer(off.id, async (): Promise<{ changed: MyOffer } | { stopped: string } | null> => {
      const fresh = await getMyOffer(key, off.id).catch(() => null);
      const takenOver = !control.manual && !!this.offerControlOf(off.id).manual;
      if (takenOver || (fresh && !sameTerms(fresh, off))) return { changed: fresh ?? off };
      // Right before the write, the switch — live (stopWhy): the reads before
      // it, and the wait for another write to this offer, take a while.
      const stop = this.stopWhy("sellEnabled");
      if (stop) return { stopped: stop };
      // What LightningMate doesn't set, as Amboss has it now: an edit of a
      // buyer condition on amboss.tech since this run read the offer stands.
      const now = fresh ? { ...terms, conditions: fresh.conditions, onchainPriority: fresh.onchainPriority, onchainMultiplier: fresh.onchainMultiplier } : terms;
      write.fields = ambossFields(now);
      const read = await this.writeTerms(key, off.id, now, write, fresh ?? off);
      if (read) after = read;
      return null;
    });
    if (outcome && "stopped" in outcome) return this.syncEntry(off, want.fields, statusWrite, [...want.notes, `not changed: ${outcome.stopped}`]);
    if (outcome) {
      return this.syncEntry(
        outcome.changed,
        null,
        undefined,
        "the offer changed while this run priced it (an edit on Market → Sell or on amboss.tech) — left as it is now; the next run starts from it",
      );
    }
    const ok = write.ok && write.verified !== false;
    out.push({ orderId: off.id, action: want.kind, sizeSats: want.fields.maxSizeSats, ok, ...(ok ? {} : { error: write.error }) });
    // The cut memory follows what Amboss has: updated only when the write
    // landed (a failed one left the offer — and the old memory — as it was).
    if (ok) this.keepCut(off.id, want.cut);
    if (ok) {
      console.log(`[autopilot] updated offer ${off.id}: ${changed.map((k) => `${k}=${write.fields[k]}`).join(", ")} (${write.reason})`);
    } else {
      console.warn(`[autopilot] offer ${off.id} update failed: ${write.error}`);
    }
    return this.syncEntry(after, want.fields, write, want.notes);
  }

  /**
   * Send an offer's full terms and read them back (inside withOffer). Amboss's
   * "success" is its word; the stored offer is the proof, compared on EVERY
   * term. Held differently, the same terms go out once more at once — not at
   * the next run half an hour later, while the offer may be listed at a price
   * nobody chose. Still different: the write is unverified, with the
   * differences named (the offer upkeep's alert, offerAlerts). Returns the
   * offer as read back last (null: it couldn't be read).
   */
  private async writeTerms(
    key: string,
    offerId: string,
    terms: OfferTerms,
    write: OfferWrite,
    before?: Pick<MyOffer, "lockedSats" | "filledOrders">,
  ): Promise<MyOffer | null> {
    if (listedForFree(terms)) {
      // Never sent, whoever asks: it would list the offer for free.
      write.ok = false;
      write.error = "not sent: a price of 0 ppm + 0 sat would list the offer for free";
      return null;
    }
    let read: MyOffer | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        write.ok = await updateOffer(key, offerId, terms);
        write.error = write.ok ? undefined : "Amboss did not apply the update (success: false)";
      } catch (err) {
        write.ok = false;
        write.error = errText(err);
      }
      if (!write.ok) return read;
      read = await getMyOffer(key, offerId).catch(() => null);
      if (!read) {
        write.verified = undefined;
        return null;
      }
      // The total comes back as sent — a new order's lock, or one released
      // without a sale, moves only what is available — unless a sale
      // completed in between (Amboss counts it filled): then it may be lower,
      // by up to what was locked before, and is never resent higher.
      const sale = before !== undefined && read.filledOrders > before.filledOrders;
      const lowest = sale && before ? Math.max(0, terms.totalSizeSats - before.lockedSats) : terms.totalSizeSats;
      const off = termsMismatch(read, terms, [lowest, terms.totalSizeSats]);
      write.verified = off.length === 0;
      if (write.verified) {
        this.rememberPrice(read);
        // The base moved: the clock that led to it is spent — the next report
        // must not follow the market's next move at once on its account — and
        // the next move waits BASE_FEE_MOVE_GAP_MS.
        const clock = this.state.offerBaseMoves?.[offerId];
        if (clock && clock.offerBase !== read.baseFeeSats) {
          delete this.state.offerBaseMoves?.[offerId];
          this.state.offerBaseMovedAt = { ...(this.state.offerBaseMovedAt ?? {}), [offerId]: new Date().toISOString() };
        }
        if (attempt > 1) write.reason = `${write.reason ? `${write.reason} — ` : ""}stored on the second try (the first read back different)`;
        return read;
      }
      write.error = `Amboss answered success, but the offer reads back different: ${off.join("; ")}`;
      // The switch, live, before the second send (the reads take a while).
      if (attempt === 1 && this.stopWhy("sellEnabled")) return read;
      // Once more: a cut that didn't land is sent again, and so is a cut given
      // back — but after a sale never more than Amboss lists now, so what
      // went into a channel is not listed back in.
      terms = { ...terms, totalSizeSats: sale ? Math.min(terms.totalSizeSats, read.totalSizeSats) : terms.totalSizeSats };
      before = { lockedSats: read.lockedSats, filledOrders: read.filledOrders };
    }
    console.warn(`[autopilot] offer ${offerId}: ${write.error}`);
    return read;
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
      if (older(next.freeDisabledAt)) next.freeDisabledAt = undefined;
      if (older(next.listOnAt)) next.listOnAt = undefined;
    }
    const changed =
      next.autoDisabledAt !== control.autoDisabledAt ||
      next.disabledByHandAt !== control.disabledByHandAt ||
      next.autoDisablingAt !== control.autoDisablingAt ||
      next.freeDisabledAt !== control.freeDisabledAt ||
      next.listOnAt !== control.listOnAt;
    if (changed) this.setOfferControl(off.id, next);
    return this.offerControlOf(off.id);
  }

  /**
   * The price an offer whose terms the autopilot sets (auto-pricing on) is
   * listed again at: the engine's current one for it, for the lease the offer
   * carries after the write — whether or not the engine calls it a move (a
   * disabled offer's report is "inactive") — and never an older one. Before,
   * with the report down that run, or a lease the engine's price doesn't fit
   * (auto-size off, a 5,000-block lease), it was listed at the price it had been
   * disabled at: 300 ppm + 100 sat, and never repriced. None this run: why,
   * and whether it waits for the operator ("lease") or for the next run.
   */
  private listingPrice(
    off: MyOffer,
    ctx: OfferCtx,
    leaseBlocks: number,
  ): { feeRatePpm: number; baseFeeSats: number } | { waits: "report" | "lease"; why: string } {
    const t = ctx.target(off);
    if (!t || listedForFree({ feeRatePpm: t.fee, baseFeeSats: t.base })) {
      return { waits: "report", why: "there is no market report for it this run — tried again next run" };
    }
    if (!priceFitsLease(t.lease, leaseBlocks)) {
      return {
        waits: "lease",
        why:
          `its ${fmtSat(leaseBlocks)}-block lease isn't one the autopilot prices (its price is for ${fmtSat(t.lease)} blocks, and with auto-size off ` +
          "the offer keeps its lease) — set its price or its lease on Market → Sell, or turn on auto-size",
      };
    }
    return { feeRatePpm: t.fee, baseFeeSats: t.base };
  }

  /**
   * The terms a disabled offer is listed again with — capital safety's relist
   * and the switch-on's — put on Amboss before the listing: what it wants as a
   * listed offer (wantedTerms: the size that can be funded, with auto-size the
   * standard lease and promise), priced — its terms the autopilot's, with
   * auto-pricing on — at the autopilot's current price for it (listingPrice;
   * without one this run it waits, `failed` with `waits`). The operator's own
   * offer, or any with auto-pricing off, keeps its price; only its size is cut
   * to what can be funded. Written in full and read back; a write that fails,
   * or reads back different, keeps the offer off and says why (`failed`).
   */
  private async termsBeforeListing(
    key: string,
    off: MyOffer,
    ctx: OfferCtx,
    control: OfferControl,
    out: AutopilotSell[],
  ): Promise<
    | { offer: MyOffer; write?: OfferWrite }
    | { offer: MyOffer; write?: OfferWrite; stopped: string }
    | { offer: MyOffer; write?: OfferWrite; failed: string; wanted: OfferFields; waits?: "report" | "lease" }
  > {
    const manual = !!control.manual;
    const want = this.wantedTerms(off, ctx, manual);
    if (!manual && this.state.config.sellAutoReprice) {
      const price = this.listingPrice(off, ctx, want.fields.minBlockLength);
      if ("waits" in price) {
        return { offer: off, failed: `waits for the autopilot's price before it is listed again: ${price.why}`, wanted: want.fields, waits: price.waits };
      }
      if (price.feeRatePpm !== want.fields.feeRatePpm || price.baseFeeSats !== want.fields.baseFeeSats) {
        want.reasons.push(`priced at the engine's ${fmtSat(price.feeRatePpm)} ppm + ${fmtSat(price.baseFeeSats)} sat`);
      }
      want.fields.feeRatePpm = price.feeRatePpm;
      want.fields.baseFeeSats = price.baseFeeSats;
    }
    // A price of nothing is never written: capital safety refuses to list it.
    if (listedForFree(want.fields)) return { offer: off };
    const changed = termsChanges(off, want.fields);
    if (changed.length === 0) return { offer: off };
    const write: OfferWrite = {
      at: new Date().toISOString(),
      by: "autopilot",
      action: "update",
      fields: ambossFields(fullTerms(want.fields, off)),
      changed,
      ok: false,
      reason: `before it is listed again: ${want.reasons.join("; ") || "its terms as they are to be listed"}`,
    };
    type Done = { read: MyOffer | null } | { stopped: string; fresh: MyOffer } | { changedMeanwhile: MyOffer | null } | { listedMeanwhile: MyOffer };
    const done = await this.withOffer(off.id, async (): Promise<Done> => {
      const fresh = await getMyOffer(key, off.id).catch(() => null);
      // Listed meanwhile (a click, amboss.tech): no flip follows — its terms
      // are kept as a listed offer's, by the upkeep below.
      if (fresh?.status === "ENABLED") return { listedMeanwhile: fresh };
      if (!fresh || !sameTerms(fresh, off) || !!this.offerControlOf(off.id).manual !== manual) return { changedMeanwhile: fresh };
      const stop = this.stopWhy("sellEnabled");
      if (stop) return { stopped: stop, fresh };
      // What LightningMate doesn't set goes back as Amboss has it now.
      const terms = fullTerms(want.fields, fresh);
      write.fields = ambossFields(terms);
      return { read: await this.writeTerms(key, off.id, terms, write, fresh) };
    });
    if ("listedMeanwhile" in done) return { offer: done.listedMeanwhile };
    if ("stopped" in done) return { offer: done.fresh, stopped: done.stopped };
    if ("changedMeanwhile" in done) {
      return {
        offer: done.changedMeanwhile ?? off,
        failed: done.changedMeanwhile
          ? "the offer changed while this run priced it (an edit on Market → Sell or on amboss.tech) — the next run starts from it"
          : "it couldn't be read from Amboss before its terms were written — tried again next run",
        wanted: want.fields,
      };
    }
    const ok = write.ok && write.verified === true;
    out.push({ orderId: off.id, action: want.kind, sizeSats: want.fields.maxSizeSats, ok, ...(ok ? {} : { error: write.error }) });
    if (!ok || !done.read) {
      return {
        offer: done.read ?? off,
        write,
        failed: `the terms it is to be listed with weren't taken — ${write.error ?? "Amboss's read-back doesn't show them"}; tried again next run`,
        wanted: want.fields,
      };
    }
    this.keepCut(off.id, want.cut);
    console.log(`[autopilot] offer ${off.id}: ${write.reason}`);
    return { offer: done.read, write };
  }

  /**
   * Liquidity provision went off — or all automation was paused — while a
   * flip that lists the offer was on its way: the switch-off (its dialog
   * disables what is listed) saw nothing listed, so nobody would decide this
   * offer's orders. Off again, by state: it was just listed. Recorded as the
   * switch-off's disable; one that doesn't land is raised as an alert
   * (offerPriceAlerts: listed with selling off).
   */
  private async unlistAfterSwitchOff(key: string, offerId: string, why: string, out: AutopilotSell[]): Promise<{ status: string | null; write: OfferWrite }> {
    const write: OfferWrite = {
      at: new Date().toISOString(),
      by: "autopilot",
      action: "disable",
      fields: { offer_id: offerId },
      ok: false,
      reason: `${why} while it was being listed — taken off the market again: with selling off nobody decides its orders`,
    };
    let status: string | null;
    try {
      status = await toggleOffer(key, offerId);
    } catch (err) {
      write.error = errText(err);
      status = (await getMyOffer(key, offerId).catch(() => null))?.status ?? null;
    }
    write.ok = status === "DISABLED";
    write.verified = status === null ? undefined : write.ok;
    if (write.ok) write.error = undefined;
    else if (!write.error) write.error = `Amboss reports the offer ${status ?? "unread"}, not DISABLED`;
    if (write.ok) {
      this.setOfferControl(offerId, { ...this.offerControlOf(offerId), autoDisabledAt: undefined, listOnAt: undefined, disabledByHandAt: write.at });
    } else {
      console.warn(`[autopilot] offer ${offerId} listed with selling off — could not take it off the market: ${write.error}`);
    }
    out.push({ orderId: offerId, action: "disable", sizeSats: 0, ok: write.ok, ...(write.ok ? {} : { error: write.error }) });
    return { status, write };
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
  ): Promise<{ offer: MyOffer; write: OfferWrite | null; unresolved?: boolean; stopped?: string }> {
    return this.withOffer(off.id, async () => {
      const action = want === "ENABLED" ? "enable" : "disable";
      const byCapital = !!this.offerControlOf(off.id).autoDisabledAt;
      const reason =
        want === "ENABLED"
          ? byCapital
            ? "its smallest channel can be funded again (the autopilot had disabled it for lack of capital)"
            : "Liquidity provision was switched on with it disabled — it has a price, and its smallest channel can be funded"
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
      // Never listed again without a price (listedForFree): it stays disabled
      // until it has one — the operator's to set on Market → Sell.
      if (want === "ENABLED" && listedForFree(fresh)) {
        return { offer: fresh, write: null, stopped: "it has no price on Amboss (0 ppm + 0 sat) — listed again once it has one" };
      }
      // Whose price it is listed at, said: the autopilot's (written just before,
      // termsBeforeListing), or the offer's own — the operator's terms, or
      // auto-pricing off.
      if (want === "ENABLED") {
        const whose = this.offerControlOf(off.id).manual
          ? "your price"
          : this.state.config.sellAutoReprice
            ? "the autopilot's price"
            : "its own price (auto-pricing is off)";
        write.reason = `${reason} — listed at ${whose}, ${fmtSat(fresh.feeRatePpm)} ppm + ${fmtSat(fresh.baseFeeSats)} sat`;
      }
      // Liquidity provision switched off (or all automation paused) since the
      // run began: no flip — the operator was asked what to do with listed
      // offers when they paused, and an offer is listed again only while
      // selling is on.
      const stop = this.stopWhy("sellEnabled");
      if (stop) return { offer: fresh, write: null, stopped: stop };
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
        // Listed: what the switch-on asked for is done.
        if (want === "ENABLED") next.listOnAt = undefined;
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
      // Listed — while Liquidity provision went off (or all automation was
      // paused) after the check above: off again (unlistAfterSwitchOff).
      const late = write.ok && want === "ENABLED" && !this.state.config.sellEnabled ? this.stopWhy("sellEnabled") : null;
      if (late) {
        const undo = await this.unlistAfterSwitchOff(key, off.id, late, out);
        return { offer: { ...fresh, status: undo.status ?? "ENABLED" }, write: undo.write, stopped: late };
      }
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
          const move = t.why ?? "market price moved";
          reasons.push(
            t.lease === leaseAfter
              ? move
              : `${move} (priced for the standard ${fmtSat(t.lease)}-block lease; with auto-size off the offer keeps its ${fmtSat(leaseAfter)} blocks)`,
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
      ...(control.freeDisabledAt ? { freeDisabledAt: control.freeDisabledAt } : {}),
      ...(control.listOnAt ? { listOnAt: control.listOnAt } : {}),
    };
    if (Object.keys(clean).length) (this.state.offerControl ??= {})[offerId] = clean;
    else if (this.state.offerControl) delete this.state.offerControl[offerId];
  }

  /**
   * The offers read first after Liquidity provision was switched on
   * (sellSwitchOn): each one that was disabled at the switch — as the last
   * offer sync showed it — and still is gets listed again once it has a price
   * and its smallest channel can be funded (listOnAt, capitalStatus), whoever
   * owns its terms. Not one disabled since: listed at the switch (or unknown
   * to that sync), or disabled by hand after it. With no sync to go by, every
   * offer disabled now. Once per switch-on: an offer disabled by hand
   * afterwards stays off.
   */
  private applySwitchOn(offers: MyOffer[]): void {
    const sw = this.state.sellSwitchOn;
    if (!sw) return;
    for (const o of offers) {
      if (o.status !== "DISABLED") continue;
      if (sw.disabled && !sw.disabled.includes(o.id)) continue;
      const control = this.offerControlOf(o.id);
      if (control.disabledByHandAt && Date.parse(control.disabledByHandAt) > Date.parse(sw.at)) continue;
      // The switch-on supersedes the disable it found — the operator's, or
      // the autopilot's for a price of nothing (still never listed free).
      this.setOfferControl(o.id, { ...control, disabledByHandAt: undefined, freeDisabledAt: undefined, listOnAt: sw.at });
    }
    this.state.sellSwitchOn = null;
    this.persist();
  }

  /**
   * The base-fee clocks (magmaRecommend baseFeeFollow): an offer whose base
   * differs from the market's beyond the tolerance gets one when a report
   * first says so, kept while reports go on saying it about the same base of
   * the offer's and the market's stays at the level it started at (within
   * the tolerance — a move beyond starts it afresh). Back within the
   * tolerance, it goes; the offer's base moved — by the autopilot's write
   * (writeTerms drops it at once and stamps the move) or any other — it
   * starts afresh. The engine reads them (magmaOverrides baseMoves): the base
   * follows at once when far off, else once the market's has held for 1.5 h
   * — a median one listing flips is never followed — and never sooner than
   * 6 h after the last base move.
   */
  private trackBaseMoves(recs: MagmaSellRecommendation[]): void {
    const now = new Date().toISOString();
    const before = this.state.offerBaseMoves ?? {};
    const moves = { ...before };
    for (const r of recs) {
      if (!r.offerId || r.baseFeeDiffers === undefined || !r.current) continue;
      const prev = moves[r.offerId];
      if (r.baseFeeDiffers && r.baseFeeMarketSat != null) {
        // The same difference while the market's base stays at the level the
        // clock started at; one that moved beyond the tolerance settles anew.
        const same = prev && prev.offerBase === r.current.baseFeeSat && preferredBaseFeeSats(prev.base, r.baseFeeMarketSat) === prev.base;
        moves[r.offerId] = same ? prev : { base: r.baseFeeMarketSat, offerBase: r.current.baseFeeSat, since: now };
      } else delete moves[r.offerId];
    }
    if (JSON.stringify(moves) === JSON.stringify(before)) return;
    this.state.offerBaseMoves = moves;
    this.persist();
  }

  /** The operator created or edited the offer by hand (or took it over): its
   *  terms are theirs until they hand it back (resumeOfferAutomation). Who
   *  disabled it, if anyone, is unchanged — an edit is not a status click. */
  pauseOfferAutomation(offerId: string, why: string): void {
    this.forgetPageReport();
    this.setOfferControl(offerId, { ...this.offerControlOf(offerId), manual: { since: new Date().toISOString(), why } });
    this.persist();
  }

  /** "Let the autopilot manage it": the offer's terms are the autopilot's
   *  again (with Liquidity provision on), from the next run. A disable by
   *  hand still stands. */
  resumeOfferAutomation(offerId: string): void {
    this.forgetPageReport();
    this.setOfferControl(offerId, { ...this.offerControlOf(offerId), manual: undefined });
    this.persist();
  }

  /** The operator enabled or disabled the offer by hand (Market → Sell, or
   *  turning Liquidity provision off): the listing is theirs — a disable
   *  sticks (until they enable it, or switch Liquidity provision on again:
   *  noteSellSwitch), an enable lists it — and the terms stay with whoever
   *  had them. */
  offerStatusSetByHand(offerId: string, status: string, read?: MyOffer): void {
    this.forgetPageReport();
    // What the click found (a click that changed nothing: the offer was so
    // already): the offer sync shows it — a switch-on goes by what that shows.
    if (read) this.noteOfferRead(read);
    const control = this.offerControlOf(offerId);
    this.setOfferControl(offerId, {
      ...control,
      // Whatever the autopilot had disabled (or was disabling, or was to list
      // after selling was switched on) is superseded by the click.
      autoDisabledAt: undefined,
      autoDisablingAt: undefined,
      freeDisabledAt: undefined,
      listOnAt: undefined,
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
    return getMagmaRecommendations(this.readLnd, key, this.magmaOverrides()).then((report) => {
      // Every report keeps the base-fee clocks — the upkeep's and the pages':
      // an offer the autopilot doesn't price has its recommendation too.
      this.trackBaseMoves(report.sell.recommendations);
      return report;
    });
  }

  /** The report the pages read — shared (see magmaReportShared). */
  private pageReport: { at: number; sig: string; report: Promise<MagmaV2Report> } | null = null;

  /**
   * The Magma report for the pages, read once and shared for
   * MAGMA_REPORT_SHARE_MS (review a6-ux:polling-and-stale-data: each read
   * is four Amboss calls plus LND's channels, chain and 30 days of flow, and
   * seven views asked for it — Market → Orders every 30 s: ~600 Amboss calls
   * an hour). Concurrent asks share one read; a different key or different
   * engine inputs (a settings change) read afresh, and so does the first ask
   * after an offer was written or taken over by hand (forgetPageReport). A
   * failed read is not kept. The autopilot's own offer upkeep always reads
   * fresh (magmaReport).
   */
  magmaReportShared(key: string = this.amboss.getKey()): Promise<MagmaV2Report> {
    const sig = JSON.stringify([key, this.magmaOverrides()]);
    const now = Date.now();
    const hit = this.pageReport;
    if (hit && hit.sig === sig && now - hit.at < MAGMA_REPORT_SHARE_MS) return hit.report;
    const report = this.magmaReport(key);
    const entry = { at: now, sig, report };
    this.pageReport = entry;
    report.catch(() => {
      if (this.pageReport === entry) this.pageReport = null;
    });
    return report;
  }

  /** Something the pages' report shows changed (an offer written or taken
   *  over by hand): the next ask reads afresh. */
  forgetPageReport(): void {
    this.pageReport = null;
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
   * How much of the spendable capital the channel stage leaves for Magma
   * (D10, a3-channels; 2026-10-25), with the note that says why — nothing
   * when any of these fails:
   *  - Magma can take it: a key Amboss accepts, and an offer of this node
   *    listed (enabled) as of the last upkeep;
   *  - selling is better than "not realistic" (the eligibility check, D8);
   *  - the lease income it can expect — offers like this node's fill ~N
   *    times a year (capped by its own offer's record once listed
   *    MAGMA_OWN_RECORD_DAYS: magmaFillsPerYear), each netting the clearing
   *    price of comparable leases minus the on-chain costs and the service
   *    fee — beats what a sat of this node's month-old channels earned
   *    (capacity-weighted: the figure the payback check quotes; before, the
   *    MEDIAN channel — 0 on a node where most channels route nothing, so any
   *    lease income deferred every open, for good).
   * What is held is only what Magma can list — the deploy cap's headroom
   * (sellCapital): before, a deferral held the whole wallet (20M on chain
   * against a 2M cap left ~18M neither routed nor leased); the rest is free
   * for routing opens. Each comparison is kept (magmaHold): when Amboss's
   * public book can't be read — it is cached in memory, so right after a
   * restart — the last one stands for MAGMA_HOLD_KEEP_MS and the note says
   * so; past that nothing is held. No routing history (no month-old
   * channel) or no clearing price: nothing held — a node can always open its
   * first channels.
   */
  private async leaveForMagma(): Promise<{ heldSat: number; text: string | null }> {
    const none = { heldSat: 0, text: null };
    if (!this.amboss.hasKey() || this.amboss.getValidity() === false) return none;
    const listed = (this.state.offerSync?.offers ?? []).some((e) => e.amboss.status === "ENABLED");
    if (!listed) return none;
    const realistic = await this.sellingRealistic();
    const e = realistic.eligibility;
    // No answer from Amboss's public book (unreadable, or nothing to judge
    // by): the last comparison stands, for a day.
    if (!e || e.verdict === "unknown") return this.lastMagmaHold(realistic.why);
    const keep = (hold: { heldSat: number; text: string | null }) => {
      this.state.magmaHold = { at: new Date().toISOString(), ...hold };
      this.persist(); // the comparison a restart's first runs fall back on
      return hold;
    };
    if (!realistic.ok || !e.comparable || e.own.listableSat <= 0) return keep(none);
    const own = await getOwnPubkey(this.readLnd).catch(() => null);
    const book = own ? cachedPublicBook(own)?.book : undefined;
    const mine = book && own ? book.offers.filter((o) => o.sellerPubkey === own) : [];
    const since = Math.min(...mine.map((o) => Date.parse(o.createdAt)).filter(Number.isFinite));
    const record = mine.length && Number.isFinite(since) ? { fills: mine.reduce((s, o) => s + o.filledOrders, 0), listedDays: (Date.now() - since) / 86_400_000 } : null;
    const comparablePerYear = e.comparable.fillsPerMonth * 12;
    const fills = magmaFillsPerYear(comparablePerYear, record);
    const clearing = clearingFor({ minSizeSat: 0, maxSizeSat: Math.max(1, e.own.maxChannelSat || e.own.listableSat) });
    if (!clearing || fills.perYear <= 0) return keep(none);
    const fillSize = Math.min(e.own.maxChannelSat || e.own.listableSat, clearing.medianSizeSat);
    const costs = await onchainCosts(this.readLnd);
    const netPerFill =
      clearing.medianApr * fillSize * (DEFAULT_LEASE_BLOCKS / BLOCKS_PER_YEAR) * (1 - saleFeeConfig().bps / 10_000) -
      costs.openCostSat -
      costs.closeCostSat;
    if (netPerFill <= 0) return keep(none);
    const leasePpmYear = Math.round(((fills.perYear * netPerFill) / e.own.listableSat) * 1_000_000);
    // What a sat of month-old channels earned, capacity-weighted (the payback
    // check's measure; with too little routing to trust it there, the figure
    // as it stands — little routing is what it says).
    const earning = await this.openEconomics();
    if (!earning || !earning.evidence.forwardsRead || earning.evidence.channels === 0) return keep(none);
    const ev = earning.evidence;
    const routing = earning.ppmYear ?? (ev.capacitySat > 0 ? Math.round((ev.earnedSat / ev.capacitySat) * (365 / 30) * 1_000_000) : 0);
    if (leasePpmYear <= routing) return keep(none);
    const heldSat = e.own.listableSat;
    const ownLine =
      record && fills.ownPerYear !== null && fills.perYear < comparablePerYear
        ? `; yours sold ${record.fills} in ${Math.max(1, Math.round(record.listedDays / 30))} months listed`
        : "";
    return keep({
      heldSat,
      text:
        `${fmtSat(heldSat)} sat held for Magma — what your offer can list (spendable, within your deploy cap): selling there is expected to earn more on it ` +
        `(~${leasePpmYear} ppm/yr: offers like yours fill ~${fills.perYear.toFixed(1)} times a year${ownLine}) than a routing channel ` +
        `(~${routing} ppm/yr: what a sat of month-old channels here earned, capacity-weighted)`,
    });
  }

  /** The last Magma comparison, when Amboss's public book can't be read now:
   *  it stands for MAGMA_HOLD_KEEP_MS (said so); past that, nothing held. */
  private lastMagmaHold(why: string): { heldSat: number; text: string | null } {
    const last = validHold(this.state.magmaHold);
    const asOf = last ? `${last.at.slice(0, 16).replace("T", " ")} UTC` : "";
    if (last && Date.now() - Date.parse(last.at) <= MAGMA_HOLD_KEEP_MS) {
      return last.heldSat > 0
        ? { heldSat: last.heldSat, text: `${last.text ?? `${fmtSat(last.heldSat)} sat held for Magma`} (the comparison of ${asOf}: ${why})` }
        : { heldSat: 0, text: null };
    }
    return {
      heldSat: 0,
      text: last
        ? `nothing held for Magma: ${why}, and its last comparison (${asOf}) is over a day old`
        : `nothing held for Magma: ${why}, and there is no earlier comparison`,
    };
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
        text: failed ? `the Magma market could not be read${torVia()} — asked again in a few minutes` : "the Magma market is being read",
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

  /**
   * The area's latest decision, with its reason (D16): what it did, or why it
   * did nothing — visible on the Autopilot tab and the Overview, and logged
   * once when it changes (the same decision again only counts up, never a
   * new line: a standing wait used to be logged, and shown, every 30 minutes).
   * An error is also kept as the area's last error.
   */
  private decisionNote(area: DecisionArea, text: string, state: DecisionState): void {
    const nowIso = new Date().toISOString();
    const prev = this.state.decisions?.[area];
    // An action is never "the same again": "opened 2,000,000 sat to X" today
    // and "… to Y" next week differ only in numbers and names the signature
    // can't tell apart — the second was neither logged nor in the decision
    // log (review of P7). Only standing states count up.
    const same = !!prev && state !== "acted" && decisionSig(prev.state ?? "waiting", prev.text) === decisionSig(state, text);
    const next: AreaDecision = {
      at: nowIso,
      state,
      text,
      since: same ? (prev.since ?? prev.at) : nowIso,
      repeats: same ? (prev.repeats ?? 1) + 1 : 1,
      ...(prev?.lastError ? { lastError: prev.lastError } : {}),
    };
    if (state === "error") next.lastError = { at: nowIso, text };
    (this.state.decisions ??= {})[area] = next;
    if (!same) {
      logLine(state === "error" ? "warn" : "info", `[autopilot] ${area}: ${state} — ${text}`);
      this.decisionLogEntries = [{ at: nowIso, area, state, text }, ...this.decisionLogEntries].slice(0, DECISION_LOG_KEPT);
      this.decisionLogStore.write(this.decisionLogEntries);
    }
  }

  /** When each area's decision changed, newest first (diagnostics). */
  decisionLog(): DecisionLogEntry[] {
    return [...this.decisionLogEntries];
  }

  /** The Magma report the pages last read, if it is at hand — never a new
   *  read (diagnostics must not wait for Amboss). */
  async cachedPageReport(): Promise<MagmaV2Report | null> {
    const hit = this.pageReport;
    if (!hit) return null;
    return hit.report.catch(() => null);
  }

  /** Record an area's decision worked out by `make` — never at the cost of
   *  the stage's own result: what it did is already done, and must reach the
   *  run history whatever goes wrong in saying why. */
  private explain(area: DecisionArea, make: () => { text: string; state: DecisionState }): void {
    try {
      const d = make();
      this.decisionNote(area, d.text, d.state);
    } catch (err) {
      logLine("warn", `[autopilot] ${area}: the decision could not be worded (${errText(err)})`);
    }
  }

  /**
   * Each area's status as the UI shows it (D16): its last decision — unless
   * it is off, or blocked right now whatever it last decided: write mode off
   * (nothing can run), or for selling no Amboss key / a key Amboss rejects.
   * A decision from before states were kept reads as "waiting" (they were
   * all notes on why nothing was done).
   */
  areaStatus(): Record<DecisionArea, AreaStatus> {
    const c = this.state.config;
    const stored = this.state.decisions ?? {};
    const last = (area: DecisionArea): AreaDecision | undefined => {
      const d = stored[area];
      return d ? { ...d, state: d.state ?? "waiting" } : undefined;
    };
    const status = (area: DecisionArea, on: boolean, offText: string): AreaStatus => {
      const d = last(area);
      if (!this.canWrite) {
        return { state: "blocked", text: "write mode is off (LM_ENABLE_WRITE) — the autopilot can't change anything on the node", at: null, ...(d ? { last: d } : {}) };
      }
      if (!on) return { state: "off", text: offText, at: null, ...(d ? { last: d } : {}) };
      // LND won't list its peers to the write macaroon (no peers:read): no
      // channel can be opened — an autopilot open's or a Magma order's —
      // whatever the area last decided, until a listing goes through again
      // (a restart with a macaroon that has it). Checked at start too
      // (checkPeerListing), so it shows before an order is turned down for it.
      const blocked = area === "channels" || area === "magma" ? opensBlocked(this.writeLnd) : null;
      if (blocked) {
        const what = area === "magma" ? "new orders are turned down, and a paid order's channel can't be opened" : "no channel can be opened";
        return { state: "blocked", text: `${what}: ${blocked}`, at: null, ...(d ? { last: d } : {}) };
      }
      if (area === "magma") {
        if (!this.amboss.hasKey()) {
          return { state: "blocked", text: "no Amboss API key — connect one in Settings: no offer is kept and no order is taken", at: null, ...(d ? { last: d } : {}) };
        }
        if (this.amboss.getValidity() === false) {
          return {
            state: "blocked",
            text: "Amboss rejects your API key (expired or revoked) — connect a fresh one in Settings; orders in flight are still carried to their end",
            at: null,
            ...(d ? { last: d } : {}),
          };
        }
      }
      // Switched on, not decided yet: its own state — "nothing to do" said
      // something nobody had checked (review of P7).
      if (!d) return { state: "not_run", text: "not run yet since it was switched on — the next run decides", at: null };
      return { ...d };
    };
    return {
      fees: status("fees", c.enabled, "fee automation is off — fees change only when you set them (a sold channel's promised fee cap is still kept)"),
      rebalance: status("rebalance", c.rebalanceEnabled, "auto-rebalance is off — refills run only when you start one"),
      channels: status("channels", c.channelEnabled, "the channel autopilot is off — channels open only when you open them"),
      magma: status("magma", c.sellEnabled, "Liquidity provision is off — no offer is kept and no new order is taken (orders already taken on are carried to their end)"),
      maxHtlc: status("maxHtlc", c.maxHtlcEnabled, "advertising routable size is off"),
    };
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
    this.forgetPageReport();
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
    await this.guardOfferPrices();
    await this.followPurchases();
  }

  /** The order lane's accept floor, cached (saleFeeFloorSats). */
  private saleFloor: { at: number; sats: number } | null = null;

  /**
   * The smallest fee the order lane accepts an order for: what opening and
   * closing its channel cost on chain right now, after the service fee — an
   * order that pays less loses money, however it came to be priced so. Not the
   * minimum profit on top: that is the engine's pricing floor, and refusing a
   * profitable order inside the offer's own window costs seller score. Live
   * from LND's fee estimate (cached ten minutes, whatever the switches say);
   * without one, at the minimum relay fee — a floor no real order is below.
   */
  async saleFeeFloorSats(): Promise<number> {
    if (this.saleFloor && Date.now() - this.saleFloor.at < SALE_FLOOR_TTL_MS) return this.saleFloor.sats;
    const oc = await onchainCosts(this.readLnd);
    const sats = saleAcceptFloorSats(oc.feePerVbyte, saleFeeConfig().bps / 10_000);
    if (oc.feePerVbyte !== null) this.saleFloor = { at: Date.now(), sats };
    return sats;
  }

  /** An offer's price, kept while it isn't free — what goes back on when
   *  Amboss lists it for free (the upkeep and the order lane's guard). */
  private rememberPrice(o: Pick<MyOffer, "id" | "feeRatePpm" | "baseFeeSats">): void {
    if (listedForFree(o)) return;
    const prev = this.state.offerPrices?.[o.id];
    if (prev && prev.feeRatePpm === o.feeRatePpm && prev.baseFeeSats === o.baseFeeSats) return;
    this.state.offerPrices = { ...(this.state.offerPrices ?? {}), [o.id]: { feeRatePpm: o.feeRatePpm, baseFeeSats: o.baseFeeSats, at: new Date().toISOString() } };
  }

  /**
   * The price for an offer Amboss lists for free, its terms not the
   * operator's: the engine's (auto-pricing on) whether or not it calls it a
   * move — it never does for an offer it judges unlisted or not worth moving —
   * when it is for the offer's lease; else the price the offer last had.
   * Null: none known (it is taken off the market then).
   */
  private priceForFree(off: MyOffer, ctx: OfferCtx, leaseBlocks: number): { feeRatePpm: number; baseFeeSats: number; engine: boolean } | null {
    const t = ctx.target(off);
    if (t && !listedForFree({ feeRatePpm: t.fee, baseFeeSats: t.base }) && priceFitsLease(t.lease, leaseBlocks)) {
      return { feeRatePpm: t.fee, baseFeeSats: t.base, engine: true };
    }
    const last = this.state.offerPrices?.[off.id];
    return last ? { feeRatePpm: last.feeRatePpm, baseFeeSats: last.baseFeeSats, engine: false } : null;
  }

  /**
   * A disabled offer at 0 ppm + 0 sat, priced by the autopilot: the price for
   * it (priceForFree) goes on — onto everything else as Amboss has it — and is
   * read back and checked. Its listing is left as it is. Null: no price known,
   * or nothing to do any more (listed, priced or taken over meanwhile).
   */
  private async priceDisabledFree(key: string, off: MyOffer, ctx: OfferCtx, out: AutopilotSell[]): Promise<{ offer: MyOffer | null; write: OfferWrite } | null> {
    return this.withOffer(off.id, async () => {
      const fresh = await getMyOffer(key, off.id).catch(() => null);
      if (!fresh || fresh.status !== "DISABLED" || !listedForFree(fresh) || this.offerControlOf(off.id).manual || this.stopWhy("sellEnabled")) return null;
      const price = this.priceForFree(fresh, ctx, fresh.minBlockLength);
      if (!price) return null;
      const terms: OfferTerms = { ...termsOf(fresh), feeRatePpm: price.feeRatePpm, baseFeeSats: price.baseFeeSats };
      const write: OfferWrite = {
        at: new Date().toISOString(),
        by: "autopilot",
        action: "update",
        fields: ambossFields(terms),
        changed: termsChanges(fresh, { ...fieldsOf(fresh), ...terms }),
        ok: false,
        reason: `priced at ${price.engine ? "the engine's" : "its last"} ${fmtSat(price.feeRatePpm)} ppm + ${fmtSat(price.baseFeeSats)} sat while disabled (Amboss had it at 0 ppm + 0 sat) — listing it stays your click`,
      };
      const read = await this.writeTerms(key, off.id, terms, write, fresh);
      const ok = write.ok && write.verified === true;
      out.push({ orderId: off.id, action: "reprice", sizeSats: terms.maxSizeSats, ok, ...(ok ? {} : { error: write.error }) });
      if (ok) console.log(`[autopilot] offer ${off.id}: ${write.reason}`);
      return { offer: read, write };
    });
  }

  /**
   * An offer the autopilot took off the market for being free, priced by the
   * autopilot: once the autopilot has its current price for it (listingPrice
   * — not the one it last had: that may be the price it was disabled at),
   * every term is written — read back, checked — and only then is it listed
   * again, its record cleared. Null: it stays off (no price this run, a write
   * Amboss didn't keep, the flip not landing, or the switch going off).
   */
  private async relistFree(key: string, off: MyOffer, ctx: OfferCtx, out: AutopilotSell[]): Promise<MyOffer | null> {
    const want = this.wantedTerms(off, ctx, false);
    const price = this.listingPrice(off, ctx, want.fields.minBlockLength);
    if ("waits" in price) return null;
    want.fields.feeRatePpm = price.feeRatePpm;
    want.fields.baseFeeSats = price.baseFeeSats;
    return this.withOffer(off.id, async () => {
      const fresh = await getMyOffer(key, off.id).catch(() => null);
      const control = this.offerControlOf(off.id);
      if (!fresh || fresh.status !== "DISABLED" || !control.freeDisabledAt || control.manual || this.stopWhy("sellEnabled")) return null;
      const terms = fullTerms(want.fields, fresh);
      const write: OfferWrite = {
        at: new Date().toISOString(),
        by: "autopilot",
        action: "update",
        fields: ambossFields(terms),
        changed: termsChanges(fresh, want.fields),
        ok: false,
        reason: `its price, ${fmtSat(terms.feeRatePpm)} ppm + ${fmtSat(terms.baseFeeSats)} sat, back on — it was taken off the market for being listed for free`,
      };
      const read = await this.writeTerms(key, off.id, terms, write, fresh);
      const priced = write.ok && write.verified === true;
      out.push({ orderId: off.id, action: "reprice", sizeSats: terms.maxSizeSats, ok: priced, ...(priced ? {} : { error: write.error }) });
      if (!priced || this.stopWhy("sellEnabled")) return null;
      // Listed meanwhile (a click, amboss.tech): the toggle would turn it off.
      if (read?.status === "ENABLED") {
        this.setOfferControl(off.id, { ...this.offerControlOf(off.id), freeDisabledAt: undefined });
        return read;
      }
      let status: string | null;
      try {
        status = await toggleOffer(key, off.id);
      } catch (err) {
        status = (await getMyOffer(key, off.id).catch(() => null))?.status ?? null;
        if (status !== "ENABLED") out.push({ orderId: off.id, action: "enable", sizeSats: terms.totalSizeSats, ok: false, error: errText(err) });
      }
      if (status !== "ENABLED") return null;
      this.setOfferControl(off.id, { ...this.offerControlOf(off.id), freeDisabledAt: undefined });
      out.push({ orderId: off.id, action: "enable", sizeSats: terms.totalSizeSats, ok: true });
      // Selling went off while the flip was on its way: off again.
      const late = !this.state.config.sellEnabled ? this.stopWhy("sellEnabled") : null;
      if (late) {
        const undo = await this.unlistAfterSwitchOff(key, off.id, late, out);
        if (undo.write.ok) return null;
        this.recordOfferWrite(null, off.id, undo.write);
      } else {
        console.log(`[autopilot] offer ${off.id} listed again: ${write.reason}`);
      }
      return { ...(read ?? fresh), status: "ENABLED" };
    });
  }

  /**
   * Take an offer Amboss lists for free off the market — whoever owns its
   * terms: like capital safety, a change of its status, never of its terms. It
   * is not listed again by the autopilot (freeDisabledAt); the operator gives
   * it a price and enables it (an enable of a free offer is refused). Amboss's
   * toggle flips whatever the status is, so it is sent only on a fresh read
   * inside the offer's lock that still shows it listed and free.
   */
  private disableFree(key: string, off: MyOffer, out: AutopilotSell[]): Promise<{ offer: MyOffer; write: OfferWrite | null }> {
    return this.withOffer(off.id, async () => {
      const fresh = await getMyOffer(key, off.id).catch(() => null);
      if (!fresh || fresh.status !== "ENABLED" || !listedForFree(fresh)) return { offer: fresh ?? off, write: null };
      if (this.stopWhy("sellEnabled")) return { offer: fresh, write: null };
      const write: OfferWrite = {
        at: new Date().toISOString(),
        by: "autopilot",
        action: "disable",
        fields: { offer_id: off.id },
        ok: false,
        reason: FREE_DISABLE_REASON,
      };
      // The intent first: should the answer — and the read after it — be
      // lost, the record still says why it is off; a later read that shows it
      // listed clears it (settleStatusRecords).
      this.setOfferControl(off.id, { ...this.offerControlOf(off.id), freeDisabledAt: write.at });
      this.persist();
      let status: string | null;
      try {
        status = await toggleOffer(key, off.id);
      } catch (err) {
        write.error = errText(err);
        status = (await getMyOffer(key, off.id).catch(() => null))?.status ?? null;
      }
      write.ok = status === "DISABLED";
      write.verified = status === null ? undefined : write.ok;
      if (status === "ENABLED") {
        // It didn't land: no record of a disable that didn't happen.
        this.setOfferControl(off.id, { ...this.offerControlOf(off.id), freeDisabledAt: undefined });
      }
      if (write.ok) {
        write.error = undefined;
        console.warn(`[autopilot] offer ${off.id} disabled: ${FREE_DISABLE_REASON}`);
      } else if (!write.error) {
        // Another flip crossed this one: nothing more is sent now — the next
        // check reads it again.
        write.error = `Amboss reports the offer ${status ?? "unknown"}, not DISABLED`;
      }
      out.push({ orderId: off.id, action: "disable", sizeSats: fresh.totalSizeSats, ok: write.ok, error: write.ok ? FREE_DISABLE_REASON : write.error });
      this.persist();
      return { offer: { ...fresh, status: status ?? fresh.status }, write };
    });
  }

  /** When guardOfferPrices last read the listed offers (ms). */
  private offerGuardAt = 0;
  /** guardOfferPrices is reading or writing an offer (waitIdle waits for it). */
  private guarding = false;

  /**
   * Between the half-hourly runs, every couple of minutes from the order lane:
   * a listed offer of this node that Amboss shows for FREE (0 ppm + 0 sat) is
   * dealt with at once, not at the next run. (On 2026-10-23 an offer Amboss
   * held at 0 ppm stayed listed for half an hour, and an order was matched to
   * it at 0 sats.) The price it last had goes back on — onto the sizes Amboss
   * has now — unless the operator owns its terms or no price is known: then it
   * is taken off the market (disableFree). Any other change of price is left
   * to the next run, which decides as it always does — the guard never
   * rewrites a price someone chose (an edit on amboss.tech included). Not
   * while a run is under way (it writes the offers itself), with selling off
   * or all automation paused (nothing is written then — the alert says it),
   * or without a key.
   */
  private async guardOfferPrices(): Promise<void> {
    if (this.guarding || this.shuttingDown || this.running || !this.writeLnd || !this.amboss.hasKey()) return;
    if (Date.now() - this.offerGuardAt < OFFER_GUARD_INTERVAL_MS) return;
    if (this.stopWhy("sellEnabled")) return;
    const listed = (this.state.offerSync?.offers ?? []).filter((e) => e.amboss.status === "ENABLED");
    if (listed.length === 0) return;
    this.offerGuardAt = Date.now();
    this.guarding = true;
    try {
      const key = this.amboss.getKey();
      for (const e of listed) {
        if (this.shuttingDown || this.running) return;
        try {
          await this.guardOfferPrice(key, e.offerId);
        } catch (err) {
          console.warn(`[autopilot] offer ${e.offerId}: price check failed: ${errText(err)}`);
        }
      }
    } finally {
      this.guarding = false;
    }
  }

  private async guardOfferPrice(key: string, offerId: string): Promise<void> {
    const live = await getMyOffer(key, offerId);
    this.rememberPrice(live);
    this.noteOfferRead(live);
    if (live.status !== "ENABLED" || !listedForFree(live)) return;
    // The price to put back: the one wanted for it, else the one it last had
    // — never for an offer whose terms the operator owns.
    const priceOf = (): { feeRatePpm: number; baseFeeSats: number } | null => {
      if (this.offerControlOf(offerId).manual) return null;
      // The price it last had — every read and verified write refresh it, so
      // a change made since the last run (on amboss.tech, say) is the one
      // put back; the run's wish only where none is known.
      const last = this.state.offerPrices?.[offerId];
      if (last) return last;
      const wanted = this.state.offerSync?.offers.find((x) => x.offerId === offerId)?.wanted ?? null;
      return wanted && !listedForFree(wanted) ? wanted : null;
    };
    const out: AutopilotSell[] = [];
    const price = priceOf();
    if (!price) {
      const r = await this.disableFree(key, live, out);
      this.noteOfferRead(r.offer, r.write ?? undefined);
      if (out.length) this.recordLanePass(out);
      return;
    }
    let putBack = false;
    await this.withOffer(offerId, async () => {
      // Afresh, inside the lock: an edit or another write may have landed.
      const fresh = await getMyOffer(key, offerId).catch(() => null);
      if (!fresh) return;
      if (fresh.status !== "ENABLED" || !listedForFree(fresh)) {
        this.noteOfferRead(fresh);
        return;
      }
      if (this.running || this.stopWhy("sellEnabled")) return;
      // The autopilot's promise too, when it gives one (Amboss drops it with the price).
      const wanted = this.state.offerSync?.offers.find((x) => x.offerId === offerId)?.wanted ?? null;
      const terms: OfferTerms = {
        ...termsOf(fresh),
        feeRatePpm: price.feeRatePpm,
        baseFeeSats: price.baseFeeSats,
        feeRateCapPpm: wanted?.feeRateCapPpm ?? fresh.feeRateCapPpm,
        baseFeeCapSats: wanted?.baseFeeCapSats ?? fresh.baseFeeCapSats,
      };
      const write: OfferWrite = {
        at: new Date().toISOString(),
        by: "autopilot",
        action: "update",
        fields: ambossFields(terms),
        changed: termsChanges(fresh, { ...fieldsOf(fresh), ...terms }),
        ok: false,
        reason: `Amboss listed it for free (0 ppm + 0 sat) — its price, ${fmtSat(price.feeRatePpm)} ppm + ${fmtSat(price.baseFeeSats)} sat, put back at once`,
      };
      const read = await this.writeTerms(key, offerId, terms, write, fresh);
      this.noteOfferRead(read ?? fresh, write);
      putBack = write.ok && write.verified === true;
      out.push({ orderId: offerId, action: "reprice", sizeSats: fresh.maxSizeSats, ok: putBack, ...(putBack ? {} : { error: write.error }) });
      if (putBack) console.log(`[autopilot] offer ${offerId}: ${write.reason}`);
    });
    if (!putBack) {
      // Couldn't be put back: off the market rather than listed for free.
      const now = await getMyOffer(key, offerId).catch(() => null);
      if (now && now.status === "ENABLED" && listedForFree(now) && !this.running && !this.stopWhy("sellEnabled")) {
        const r = await this.disableFree(key, now, out);
        this.noteOfferRead(r.offer, r.write ?? undefined);
      }
    }
    if (out.length) this.recordLanePass(out);
  }

  /** A fresh read of an offer (and the write that led to it) into its sync
   *  record — what the alerts and Market → Sell show — keeping what is wanted
   *  for it. Saved only when something changed. */
  private noteOfferRead(off: MyOffer, write?: OfferWrite): void {
    const sync = this.state.offerSync;
    const i = sync?.offers.findIndex((x) => x.offerId === off.id) ?? -1;
    if (!sync || i < 0) return;
    const before = sync.offers[i];
    const entry = this.syncEntry(off, before.wanted, write);
    if (!write && JSON.stringify(entry.amboss) === JSON.stringify(before.amboss)) return;
    sync.offers[i] = { ...entry, checkedAt: new Date().toISOString() };
    this.forgetPageReport();
    this.persist();
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

  /**
   * Ask LND now how one purchase's payment stands, and record it — before a
   * cancel or a new payment acts on a failure only the pay call reported (a
   * dropped stream, a restart): that payment may still be in flight. LND not
   * answering changes nothing (the record stays as unclear as it was).
   */
  async checkPurchasePayment(orderId: string): Promise<MagmaPurchase | undefined> {
    const p = this.purchases.get(orderId);
    // Paying, or failed by the pay call's word only: LND has the last word.
    if (!p || !(p.state === "paying" || (p.state === "pay_failed" && !p.failureConfirmed))) return p;
    try {
      return this.purchases.paymentOutcome(orderId, await this.purchasePaymentReport(p.paymentHash));
    } catch {
      return this.purchases.get(orderId);
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

  /**
   * "Run once now": a run — or null when one is under way already (or the
   * process is shutting down, or nothing can be written). runOnce answers an
   * empty run then, which the tab showed as "0 applied, 0 failed of 0
   * attempted" — as if a run had found nothing to do.
   */
  async runOnceNow(): Promise<AutopilotRun | null> {
    // (No await before runOnce takes its lock: nothing can slip in between.)
    if (this.running || this.shuttingDown || !this.writeLnd) return null;
    return this.runOnce();
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
    // This run's own offer upkeep applies a switch-on made before it.
    this.sellSwitchedMidRun = false;
    const writeLnd = this.writeLnd;
    // Every stage that threw in this pass — and which of those failures are
    // news for the run history (the same failure again is not).
    const errors: { stage: string; error: string }[] = [];
    const news = new Set<string>();

    // After a shutdown signal no further stage starts; inside a stage, every
    // fee write, payment, channel open, max_htlc update and offer write asks
    // again before it begins — the shutdown, and the stage's switch as it is
    // NOW (stopWhy: a pause mid-run starts nothing new).
    // Each stage stands alone: one that throws is recorded and the others
    // still run (before, a failing fee stage also skipped Magma offer upkeep).
    // A stage's failure is its area's decision (D16) — and a line of the run
    // history only when it is news: the same failure again (LND down for an
    // hour) counts up on the area's status instead of filling the history.
    const stage = async <T>(name: string, area: DecisionArea, on: boolean, run: () => Promise<T[]>): Promise<T[]> => {
      if (!on || this.shuttingDown) return [];
      try {
        const res = await run();
        this.stageLast.delete(name);
        return res;
      } catch (err) {
        const error = errText(err);
        logLine("error", `[autopilot] ${name} stage failed: ${error}`);
        this.decisionNote(area, `the ${name} stage failed: ${error}`, "error");
        const sig = error.replace(/\d[\d,.]*/g, "#");
        if (this.stageLast.get(name) !== sig) news.add(name);
        this.stageLast.set(name, sig);
        errors.push({ stage: name, error });
        return [];
      }
    };

    try {
      // Rebalance payments we stopped waiting for: learn how they ended — on
      // EVERY run, whatever the rebalance window or switch says. (Inside the
      // rebalance stage this ran only within the window, with rebalancing on:
      // a payment left in flight could stay unreconciled, its maximum fee
      // charged to the budget, for as long as rebalancing stayed off.)
      await stage("rebalance bookkeeping", "rebalance", (this.state.pendingRebalances ?? []).length > 0, async () => {
        await this.reconcilePendingRebalances();
        return [];
      });
      const changes = [
        ...(await stage("fees", "fees", this.state.config.enabled, () => this.runFees(writeLnd))),
        // D7 with fee automation off: the routing-fee promises of sold
        // channels are still kept — LND's default fee or a change made with
        // another tool can sit above a cap. Only a breach is touched, and only
        // lowered to the cap; every other fee stays the operator's.
        ...(await stage("lease promises", "fees", !this.state.config.enabled && this.capital.leaseCaps().length > 0, () =>
          this.keepLeasePromises(writeLnd),
        )),
      ];
      const rebalances = await stage("rebalancing", "rebalance", this.state.config.rebalanceEnabled, () => this.runRebalances(writeLnd));
      const channels = await stage("channels", "channels", this.state.config.channelEnabled, () => this.runChannels(writeLnd));
      const sells = await stage("magma", "magma", true, () => this.runSell());
      // Advertised-size upkeep: only gossips when a channel's bucket moved.
      // (Its failure used to be swallowed — `.catch(() => [])` — so LND not
      // answering it left no trace; now it is the area's error.)
      const maxHtlc = await stage("max_htlc", "maxHtlc", this.state.config.maxHtlcEnabled, async () => {
        // Each update asks the live switch first (stopWhy): the pass reads
        // every channel's policy from the graph, which takes a while.
        const halted: { why: string | null } = { why: null };
        const moved = await runMaxHtlcPass(this.readLnd, writeLnd, this.maxHtlcBackoff, {
          shouldStop: () => (halted.why = this.stopWhy("maxHtlcEnabled")) !== null,
          lastWrites: this.maxHtlcLastWrites,
        });
        this.explain("maxHtlc", () => maxHtlcDecision(moved, halted.why));
        return moved;
      });
      // "skip" entries are non-actions (cap/reserve) — don't count them as
      // attempts.
      const acted = sells.filter((s) => s.action !== "skip");

      // A refill still in flight is no failure (not yet): counted neither way.
      const refillsFailed = rebalances.filter((r) => !r.ok && !r.inFlight).length;
      const at = new Date().toISOString();
      type Items = { changes: AutopilotChange[]; channels: AutopilotChannelOpen[]; sells: AutopilotSell[] };
      const lineOf = (it: Items, stageErrors: { stage: string; error: string }[]): AutopilotRun => ({
        at,
        attempted: it.changes.length + rebalances.length + it.channels.length + it.sells.length + maxHtlc.length + stageErrors.length,
        applied:
          it.changes.filter((c) => c.ok).length +
          rebalances.filter((r) => r.ok).length +
          it.channels.filter((c) => c.ok).length +
          it.sells.filter((s) => s.ok).length +
          maxHtlc.filter((m) => m.ok).length,
        failed:
          it.changes.filter((c) => !c.ok).length +
          refillsFailed +
          it.channels.filter((c) => !c.ok).length +
          it.sells.filter((s) => !s.ok).length +
          maxHtlc.filter((m) => !m.ok).length +
          stageErrors.length,
        changes: it.changes,
        rebalances,
        channels: it.channels,
        sells: it.sells,
        maxHtlc,
        ...(stageErrors.length ? { errors: stageErrors } : {}),
      });
      // What THIS pass did — every item and every stage that failed in it
      // included: what "Run once now" answers and the Overview counts.
      // (Review of P7: a stage, then a fee write, an own open or an offer
      // write failing the same way again was left out of the pass's own
      // result, and the Overview read "nothing needed changing" right above
      // "Fee automation failed".) The run history gets a failure only when
      // it is news: LND down for an hour, a fee LND keeps refusing, a wallet
      // that can't fund an open, offer upkeep failing while Amboss is down —
      // each one line there, not one (or two) a run (review
      // a3-channels:history-flood; the area's status counts the repeats, and
      // the offer sync status keeps its last error either way).
      const run = lineOf({ changes, channels, sells: acted }, errors);
      const line = lineOf(
        { changes: changes.filter((c) => !c.repeat), channels: channels.filter((c) => !c.repeat), sells: this.laneNews(acted) },
        errors.filter((e) => news.has(e.stage)),
      );

      this.state.lastRunAt = run.at;
      // Every pass in numbers — the ones that did nothing too: the Overview
      // pairs this run's time with these counts (it paired it with the last
      // run that did something, days old maybe — review a6-ux:numbers-mislead).
      const tally = (xs: readonly { ok: boolean }[]) => ({ ok: xs.filter((x) => x.ok).length, failed: xs.filter((x) => !x.ok).length });
      this.state.lastRun = {
        at: run.at,
        attempted: run.attempted,
        applied: run.applied,
        failed: run.failed,
        feeChanges: tally(changes),
        rebalances: { ok: rebalances.filter((r) => r.ok).length, failed: refillsFailed, inFlight: rebalances.filter((r) => r.inFlight).length },
        opens: tally(channels),
        sells: tally(acted),
        maxHtlc: tally(maxHtlc),
        errors: errors.map((e) => e.stage),
      };
      // Only record runs that actually did something (applied or failed) — skip the
      // hourly no-op runs so the history shows changes, not "0 applied" every hour.
      if (line.attempted > 0) {
        this.state.history.unshift(line);
        this.state.history = this.state.history.slice(0, HISTORY_LIMIT);
      }
      return run;
    } finally {
      // Also on a failed stage: whatever earlier stages recorded (fee cooldowns,
      // rebalance spend, flow anchors) must reach the disk.
      this.persist();
      this.running = false;
      this.runningSince = null;
      // Liquidity provision was switched on while this run was under way, and
      // the switch-on is still to be applied: the run reschedule() kicked found
      // this one busy, and this one's offer upkeep came before the switch. One
      // more now, so the offers are listed within seconds — not at the next
      // run, half an hour later. Once: the next run starts without the flag (a
      // read that keeps failing is retried on the schedule, not back to back).
      const midRun = this.sellSwitchedMidRun;
      this.sellSwitchedMidRun = false;
      if (midRun && this.state.sellSwitchOn && this.state.config.sellEnabled && !this.shuttingDown) {
        this.kick(() => this.runOnce(), 2_000);
      }
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
      this.feeLog.all(),
    );
  }
  private feeApply(writeLnd: AuthenticatedLnd, items: FeeApplyItem[], opts: { shouldStop?: () => boolean; onResult?: (r: FeeApplyResult) => void } = {}) {
    // The last gate: a sold channel's fee never leaves its lease promise.
    return applyFees(this.readLnd, writeLnd, items, this.capital.leaseCaps(), opts);
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
        feeHistory: this.feeLog.all(),
      },
      {
        recOverrides: this.rebalanceRecOverrides(),
        soldLeases: this.capital.soldLeases(),
        // Only with fee automation on does the engine hold a refill's value.
        feeAutomation: this.state.config.enabled,
        // Bought on Magma: never a refill target while its lease runs.
        boughtLeases: this.purchases
          .list()
          .filter((p) => !!p.channelId)
          .map((p) => ({ channelId: p.channelId as string, leaseBlocks: p.leaseBlocks })),
      },
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
