import { getPayment, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { JsonStore, recordStoreIncident } from "../store.js";
import { connectForOpen, fundChannel } from "./channelOps.js";
import { isAuthError } from "./amboss.js";
import { createOffer, getMyOffer, getMyOffers, toggleOffer, updateOffer, type MyOffer, type OfferTerms } from "./magmaApi.js";
import { MagmaDesk, type MagmaSellAction } from "./magmaDesk.js";
import { CapitalLedger, listableSat, spendableOnchain, type Spendable } from "./capital.js";
import { initMagmaHistory, refreshMagmaHistory } from "./magmaHistory.js";
import { runMaxHtlcPass, type MaxHtlcChange } from "./maxHtlc.js";
import type { ServiceFeeLedger } from "./serviceFee.js";
import type { AmbossStore } from "./ambossStore.js";
import { errorText } from "./errorText.js";
import { getChannelSuggestionsV2 } from "./suggestRecommend.js";
import type { LnPlusStore } from "./lnplusStore.js";
import { getMagmaRecommendations, type MagmaV2Report } from "./magmaRecommend.js";
import { onchainCosts } from "./nodeEconomics.js";
import { getFeeElasticity } from "./outcomes.js";
import { DEFAULT_POLICY, applyFees, type FeeApplyItem } from "./fees.js";
import { getFeeRecommendations, type FeeRecConfig } from "./feeRecommend.js";
import { executeRebalance, type RebalanceExecParams, type RebalanceExecResult } from "./rebalance.js";
import { getRebalanceRecommendations, selectRebalanceRuns } from "./rebalanceRecommend.js";
import type { RebalanceLog } from "./rebalanceLog.js";
import type { OverridesStore } from "./overrides.js";
import type { EarningsLog } from "./earningsLog.js";
import { getChannelsView } from "./channels.js";
import { getForwardsReport } from "./forwards.js";
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

export interface AutopilotChange {
  id: string;
  alias: string;
  fromPpm: number;
  toPpm: number;
  ok: boolean;
  error?: string;
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

/** A rebalance payment we stopped waiting for: it may still land. */
interface PendingRebalance {
  id: string;
  targetId: string;
  /** The channel it drains (absent on records from before this was kept). */
  sourceId?: string;
  alias: string;
  amountSats: number;
  maxFeeSats: number;
  /** The budget day its maximum fee was charged to (autopilot payments). */
  day: string;
  at: string;
  /** Who started it. A manual one (Rebalance tab) is tracked the same way,
   *  so the log shows how it really ended — but never charged to the
   *  autopilot's daily budget. Absent = autopilot (older records). */
  via?: "autopilot" | "manual";
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
  /** Rebalance fees spent today (resets on date change) — enforces the daily cap. */
  perDayRebalanceSpend?: { day: string; sats: number };
  /** Flow-won price memory per channel: an open no-flow lowering episode
   *  (episodeAt) and/or the ppm at which routing last returned (anchor). */
  perChannelFlowAnchor?: Record<string, { episodeAt?: string; anchorPpm?: number; anchorAt?: string }>;
  /** Consecutive failed rebalance attempts per target — drives the backoff. */
  perTargetRebalanceFails?: Record<string, number>;
  /** Rebalance payments still in flight when we stopped waiting. */
  pendingRebalances?: PendingRebalance[];
  /** Offer sync status (engine's wishes vs Amboss), see OfferSyncStatus. */
  offerSync?: OfferSyncStatus;
  /** Per offer: what a capital cut took, to give back (see OfferCut). */
  offerCuts?: Record<string, OfferCut>;
  history: AutopilotRun[];
}

const HISTORY_LIMIT = 50;
/** The Magma order lane's cadence (D4): independent of the main run. */
export const ORDER_LANE_INTERVAL_MS = 45_000;
/** How often rebalance payments still in flight are asked about between
 *  runs — also with every automation off (a manual one must end on record). */
export const INFLIGHT_REBALANCE_CHECK_MS = 2 * 60_000;
const floor10k = (n: number): number => Math.max(0, Math.floor(n / 10_000) * 10_000);
/** Readable for LND's array errors too: stage errors reach the run history. */
const errText = errorText;

/** What one offer-upkeep pass may advertise, and the engine's wishes. */
interface OfferCtx {
  /** Largest single channel that can be funded now (and within the caps),
   *  for an offer whose smallest channel is `minSizeSats`. */
  maxOrder: (minSizeSats: number) => number;
  /** Most liquidity such an offer may list at once: whatever orders buy it
   *  out, each one's open (with its own fee and anchor-reserve step) can be
   *  funded (capital.ts listableSat), within the deploy cap's headroom. */
  listable: (minSizeSats: number) => number;
  target: (off: MyOffer) => { fee: number; base: number; moved: boolean } | null;
  reshape: (off: MyOffer) => { minSizeSats: number; maxSizeSats: number; minBlockLength: number } | null;
}

/** The capital side of OfferCtx, from one spendable reading. */
function sellable(sp: Spendable, headroomSat: number, maxChannelSats: number): Pick<OfferCtx, "maxOrder" | "listable"> {
  const listable = (minSizeSats: number) => floor10k(Math.min(listableSat(sp, minSizeSats), headroomSat));
  return { listable, maxOrder: (minSizeSats: number) => floor10k(Math.min(listable(minSizeSats), maxChannelSats)) };
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
});

const FIELD_LABEL: Record<Exclude<keyof OfferFields, "totalSizeSats">, string> = {
  status: "status",
  minSizeSats: "min channel (sat)",
  maxSizeSats: "max channel (sat)",
  availableSats: "listed liquidity (sat)",
  feeRatePpm: "fee rate (ppm)",
  baseFeeSats: "base fee (sat)",
  minBlockLength: "min lease (blocks)",
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
  return Object.keys(p).length > 0 ? p : null;
}

/** Did Amboss store every field that was sent? */
function termsMatch(read: MyOffer, sent: Partial<OfferTerms>): boolean {
  return (
    (sent.feeRatePpm === undefined || read.feeRatePpm === sent.feeRatePpm) &&
    (sent.baseFeeSats === undefined || read.baseFeeSats === sent.baseFeeSats) &&
    (sent.minSizeSats === undefined || read.minSizeSats === sent.minSizeSats) &&
    (sent.maxSizeSats === undefined || read.maxSizeSats === sent.maxSizeSats) &&
    (sent.minBlockLength === undefined || read.minBlockLength === sent.minBlockLength) &&
    (sent.totalSizeSats === undefined || read.totalSizeSats === sent.totalSizeSats)
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
  /** The reconciliation of in-flight rebalances under way, if any: the timer
   *  and a main run share it instead of booking the same payment twice. */
  private reconciling: Promise<void> | null = null;
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
    this.state.perChannelLastApplied ??= {};
    this.state.perTargetLastRebalanced ??= {};
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

  /** Cooldown view for the fee-recommendation dry-run (read-only). */
  feeCooldown(): { lastApplied: Record<string, string>; cooldownHours: number } {
    return {
      lastApplied: this.state.perChannelLastApplied,
      cooldownHours: this.state.config.cooldownMinutes / 60,
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

  /** Map the user's rebalance economics onto the v2 recommender. The user-facing
   *  knob is econRatio ("spend up to this share of what refilled liquidity earns");
   *  the recommender implements exactly that as profitShare — wire it through so
   *  the Strategy presets actually loosen/tighten the GATE, not just the
   *  execution-budget fallback. */
  rebalanceRecOverrides(): { profitShare: number } {
    return { profitShare: this.state.config.rebalancePolicy.econRatio };
  }

  /** Magma pricing the recommendations should reflect — the configured mode + the
   *  live adaptive level — so the UI shows what the autopilot is actually doing. */
  /** What the engine needs to mirror the autopilot's actual behaviour: the price
   *  level AND the capital caps, so the recommended size window can never exceed
   *  what the autopilot would really be willing to serve. Without the caps the
   *  Market page would advertise a size the autopilot then silently refuses. */
  magmaOverrides(): {
    sellPricingMode: "fast" | "balanced" | "premium" | "auto";
    adaptiveLevel: number;
    maxSellSizeSat: number;
    onchainReserveSat: number;
  } {
    const c = this.state.config;
    return {
      sellPricingMode: c.sellPricingMode,
      adaptiveLevel: this.state.sellAdaptiveLevel,
      // A channel bigger than the whole deploy budget can never be served, so the
      // effective ceiling is the smaller of the two.
      maxSellSizeSat: Math.max(0, Math.min(c.sellMaxChannelSats, c.sellMaxDeploySats)),
      onchainReserveSat: c.sellReserveSats,
    };
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

  /** Per-channel learned fee elasticity modifiers (from measured outcomes). */
  async feeElasticityModifiers(): Promise<Map<string, number>> {
    try {
      const el = await getFeeElasticity(this.readLnd, this.state.history);
      return new Map([...el].map(([id, e]) => [id, e.modifier]));
    } catch {
      return new Map();
    }
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
    this.stop();
  }

  /** True while the main run holds its lock. */
  isRunning(): boolean {
    return this.running;
  }

  /** Resolves once nothing is in progress — no main run, no order-lane pass or
   *  manual Magma action, nobody holding the on-chain mutex — or after
   *  `timeoutMs` (false). Every step under way has a recorded state by then. */
  async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running || this.magma.isBusy() || this.capital.mutex.busy || this.reconciling) {
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

  private rebalanceCooldownOk(targetId: string, cooldownMin: number): boolean {
    const last = this.state.perTargetLastRebalanced[targetId];
    if (!last) return true;
    // Exponential backoff on consecutive failures (1× → 2× → 4× → 8× the
    // cooldown): a target with no viable route isn't re-probed forever on the
    // base cadence. A success resets the counter.
    const fails = this.state.perTargetRebalanceFails?.[targetId] ?? 0;
    const mult = Math.min(8, 2 ** fails);
    return (Date.now() - new Date(last).getTime()) / 60_000 >= cooldownMin * mult;
  }

  /** Compute and apply eligible fee changes. */
  private async runFees(writeLnd: AuthenticatedLnd): Promise<AutopilotChange[]> {
    // v2 engine — wouldApply already folds in the relative/absolute threshold,
    // cooldown and max-changes-per-run, so we just apply the eligible ones.
    const elasticity = await this.feeElasticityModifiers();
    const report = await this.feeReport(elasticity);

    // Flow-anchor bookkeeping: a channel in an open no-flow episode that routed
    // out again did so at its CURRENT fee — remember that price as its anchor
    // (the next no-flow episode jumps straight there instead of blind stepping).
    // Episodes with no outbound flow for 45 days are abandoned (peer is dead —
    // the close-candidate path handles it, an anchor would be meaningless).
    const fa = (this.state.perChannelFlowAnchor ??= {});
    const nowIso = new Date().toISOString();
    for (const r of report.recommendations) {
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

    const eligible = report.recommendations.filter(
      (r) => r.wouldApply && r.transactionId !== null && r.transactionVout !== null,
    );

    const items: FeeApplyItem[] = eligible.map((r) => ({
      id: r.channelId,
      transactionId: r.transactionId as string,
      transactionVout: r.transactionVout as number,
      feeRatePpm: r.targetPpm,
      baseFeeMsat: r.recommendedBaseMsat, // volume-first: drop base fee to win routes
    }));

    const results = items.length ? await this.feeApply(writeLnd, items) : [];
    const byId = new Map(eligible.map((r) => [r.channelId, r]));
    const changes = results.map((res) => {
      const r = byId.get(res.id);
      if (res.ok) {
        this.state.perChannelLastApplied[res.id] = new Date().toISOString();
        // Applied a no-flow lowering → open (or refresh) the flow-won episode.
        if (r?.noFlowLowering) fa[res.id] = { ...fa[res.id], episodeAt: new Date().toISOString() };
      }
      return {
        id: res.id,
        alias: r?.alias ?? res.id,
        fromPpm: r?.currentPpm ?? 0,
        toPpm: res.feeRatePpm,
        ok: res.ok,
        error: res.error,
      };
    });
    // Cooldowns protect against gossip spam only if they survive a crash in a
    // later stage of this run — record them now, not at the end.
    if (changes.length) this.persist();
    return changes;
  }

  /** Within the configured rebalance hour window (node local time)? */
  private inRebalanceWindow(): boolean {
    const { rebalanceHourStart: s, rebalanceHourEnd: e } = this.state.config;
    return rebalanceWindowOpen(s, e, new Date().getHours());
  }

  /** Execute eligible (profitable, off-cooldown) rebalances. */
  private async runRebalances(writeLnd: AuthenticatedLnd): Promise<AutopilotRebalance[]> {
    if (!this.inRebalanceWindow()) return [];
    const { rebalancePolicy, maxRebalancesPerRun, rebalanceCooldownMinutes, rebalanceDailyBudgetSats } =
      this.state.config;
    // Daily rebalance-fee budget — reset the counter when the day rolls over.
    const today = new Date().toISOString().slice(0, 10);
    if (!this.state.perDayRebalanceSpend || this.state.perDayRebalanceSpend.day !== today) {
      this.state.perDayRebalanceSpend = { day: today, sats: 0 };
    }
    // null = the operator explicitly chose "no limit" (validated settings can
    // no longer reach 0 by accident). Infinity keeps every budget check inert.
    const dailyBudget = rebalanceDailyBudgetSats === null ? Number.POSITIVE_INFINITY : rebalanceDailyBudgetSats;
    // (Payments we stopped waiting for were reconciled at the start of the
    // run, so the budget below already counts what they really cost.)
    // A channel with a payment still in flight is left alone, target or
    // source: once its cooldown is over, a second rebalance of it could start
    // while the first may still land — moving twice what was planned.
    const inFlight = new Set((this.state.pendingRebalances ?? []).flatMap((p) => [p.targetId, ...(p.sourceId ? [p.sourceId] : [])]));
    // v1 recommender — only acts on route_found_profitable (wouldRebalance), with
    // the fee-adjust-first / payback / profit gating already applied.
    const report = await this.rebalanceReport();
    const eligible = report.recommendations.filter(
      (r) =>
        r.wouldRebalance &&
        r.selectedSourceChannel &&
        r.recommendedAmount &&
        !inFlight.has(r.channelId) &&
        !inFlight.has(r.selectedSourceChannel) &&
        this.rebalanceCooldownOk(r.channelId, rebalanceCooldownMinutes),
    );
    // Pure planner: order by profitability, cap to maxPerRun, and pre-skip moves
    // that can't fit the remaining daily budget (without abandoning cheaper ones).
    const plan = selectRebalanceRuns(eligible, {
      dailyBudgetSats: dailyBudget,
      alreadySpentSats: this.state.perDayRebalanceSpend.sats,
      maxPerRun: maxRebalancesPerRun,
    });

    const out: AutopilotRebalance[] = plan.skipped.map((s) => ({
      alias: s.rec.alias,
      amountSats: s.rec.recommendedAmount as number,
      feeSats: null,
      costPpm: null,
      ok: false,
      error: s.reason,
    }));

    for (const r of plan.run) {
      // Shutdown: the payment already under way finishes (it is being awaited
      // right here); none of the moves planned after it starts.
      if (this.shuttingDown) {
        out.push({
          alias: r.alias,
          amountSats: r.recommendedAmount as number,
          feeSats: null,
          costPpm: null,
          ok: false,
          error: "skipped: shutting down",
        });
        continue;
      }
      // Actual-spend backstop: an earlier move's real fee may exceed its estimate,
      // so re-check the live budget before each execution — never overshoot.
      if (dailyBudget > 0 && this.state.perDayRebalanceSpend.sats >= dailyBudget) {
        out.push({
          alias: r.alias,
          amountSats: r.recommendedAmount as number,
          feeSats: null,
          costPpm: null,
          ok: false,
          error: `skipped: daily rebalance budget reached (${this.state.perDayRebalanceSpend.sats}/${dailyBudget} sat)`,
        });
        continue;
      }
      const res = await this.rebalanceExec(writeLnd, {
        targetId: r.channelId,
        sourceId: r.selectedSourceChannel as string,
        amountSats: r.recommendedAmount as number,
        econRatio: rebalancePolicy.econRatio,
        maxFeePpm: r.maxCostPpm ?? undefined, // the v1 economic ceiling
      });
      // Mark the target on every attempt (success or fail) so the cooldown also
      // backs off failing targets — no more hammering the same dead route.
      this.state.perTargetLastRebalanced[r.channelId] = new Date().toISOString();
      if (res.inFlight) {
        // We stopped waiting; the payment may still land. Count its maximum
        // fee as spent now (the budget can never be overshot) and settle the
        // books when a later run learns how it ended.
        this.state.perDayRebalanceSpend.sats += res.inFlight.maxFeeSats;
        (this.state.pendingRebalances ??= []).push({
          id: res.inFlight.paymentId,
          targetId: res.targetId,
          sourceId: res.sourceId,
          alias: res.targetAlias,
          amountSats: res.amountSats,
          maxFeeSats: res.inFlight.maxFeeSats,
          day: today,
          at: new Date().toISOString(),
        });
        this.persist();
        out.push({ alias: res.targetAlias, amountSats: res.amountSats, feeSats: null, costPpm: null, ok: false, error: res.error });
        continue;
      }
      const fails = (this.state.perTargetRebalanceFails ??= {});
      if (res.ok) delete fails[r.channelId];
      else fails[r.channelId] = Math.min(3, (fails[r.channelId] ?? 0) + 1);
      this.rebalanceLog.append({
        at: new Date().toISOString(),
        via: "autopilot",
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
      });
      if (res.ok && res.feeSats) this.state.perDayRebalanceSpend.sats += res.feeSats;
      // Spent sats and the backoff must not be forgotten if a later stage of
      // this run throws or the process restarts: save after every payment.
      this.persist();
      out.push({
        alias: res.targetAlias,
        amountSats: res.amountSats,
        feeSats: res.feeSats,
        costPpm: res.costPpm,
        ok: res.ok,
        error: res.error,
      });
    }
    return out;
  }

  /** Rebalance payments that were still in flight when we stopped waiting —
   *  the autopilot's and manual ones: ask LND how each ended, and correct
   *  today's spend (autopilot payments only) and the log. One at a time: a
   *  main run and the timer share the reconciliation under way. */
  private reconcilePendingRebalances(): Promise<void> {
    this.reconciling ??= this.reconcileNow().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  /** The timer's share (every INFLIGHT_REBALANCE_CHECK_MS): only when a
   *  payment is pending, and never next to a main run (it reconciles first). */
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
      let st: { state: "confirmed"; feeSats: number } | { state: "failed" | "pending" };
      try {
        st = await this.rebalancePaymentStatus(p.id);
      } catch {
        continue; // LND can't say right now — ask again later
      }
      if (st.state === "pending") continue;
      const manual = p.via === "manual";
      const spend = this.state.perDayRebalanceSpend;
      // A manual payment was never charged to the autopilot's budget.
      const sameDay = !manual && spend?.day === p.day;
      if (st.state === "confirmed") {
        if (sameDay && spend) spend.sats = Math.max(0, spend.sats - p.maxFeeSats + st.feeSats);
        if (!manual) delete this.state.perTargetRebalanceFails?.[p.targetId];
      } else if (sameDay && spend) {
        spend.sats = Math.max(0, spend.sats - p.maxFeeSats);
      }
      this.rebalanceLog.append({
        at: new Date().toISOString(),
        via: manual ? "manual" : "autopilot",
        targetId: p.targetId,
        targetAlias: p.alias,
        sourceId: p.sourceId ?? "",
        sourceAlias: "",
        amountSats: p.amountSats,
        budgetPpm: 0,
        feeSats: st.state === "confirmed" ? st.feeSats : null,
        costPpm: st.state === "confirmed" && p.amountSats > 0 ? Math.round((st.feeSats / p.amountSats) * 1_000_000) : null,
        ok: st.state === "confirmed",
        error: st.state === "confirmed" ? undefined : "the payment that was still in flight failed",
      });
      done.add(p);
      console.log(`[autopilot] in-flight rebalance ${p.id.slice(0, 12)}… ended ${st.state}${st.state === "confirmed" ? ` (fee ${st.feeSats} sat)` : ""}`);
    }
    // Payments tracked while this ran (a manual one) stay pending.
    this.state.pendingRebalances = (this.state.pendingRebalances ?? []).filter((p) => !done.has(p));
    this.persist();
  }

  /**
   * A rebalance by hand (Rebalance tab): run, and logged as manual. A payment
   * still in flight at the hard limit is not a failure — it may land later.
   * It is tracked like the autopilot's own (pendingRebalances, which also
   * keeps the autopilot off its two channels meanwhile), but not charged to
   * the autopilot's daily budget, and the log gets its real outcome once LND
   * knows it. Before, it was logged as failed and never looked at again: a
   * payment that landed later stayed "failed", its fee missing from P&L.
   */
  async rebalanceByHand(params: RebalanceExecParams): Promise<RebalanceExecResult> {
    if (!this.writeLnd) throw new Error("writing is disabled");
    const res = await this.rebalanceExec(this.writeLnd, params);
    if (res.inFlight) {
      (this.state.pendingRebalances ??= []).push({
        id: res.inFlight.paymentId,
        targetId: res.targetId,
        sourceId: res.sourceId,
        alias: res.targetAlias,
        amountSats: res.amountSats,
        maxFeeSats: res.inFlight.maxFeeSats,
        day: new Date().toISOString().slice(0, 10),
        at: new Date().toISOString(),
        via: "manual",
      });
      this.persist();
      return res;
    }
    this.rebalanceLog.append({
      at: new Date().toISOString(),
      via: "manual",
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
    });
    return res;
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

    // Capital engine: when Magma selling is also on, only open a routing channel
    // if a new channel is expected to out-earn leasing this capital (routing
    // median yield vs the lease floor). Otherwise leave the sats for Magma. This
    // is the unified capital decision driving the autopilot — not just a panel.
    if (cfg.sellEnabled) {
      try {
        const [chans, report] = await Promise.all([
          getChannelsView(this.readLnd),
          getForwardsReport(this.readLnd, 30),
        ]);
        const revByChan = new Map(report.perChannel.map((c) => [c.channelId, c.feesEarnedSats]));
        const stats = routingYieldStats(chans.filter((c) => c.active), revByChan);
        if (stats.medianPpmYear < stats.leaseThresholdPpmYear) {
          return [
            {
              alias: top.alias,
              sizeSats: size,
              ok: false,
              error: `deferred: leasing beats routing for this capital (routing ~${stats.medianPpmYear} vs lease floor ${stats.leaseThresholdPpmYear} ppm/yr) — left for Magma`,
            },
          ];
        }
      } catch {
        // couldn't compute the capital decision — fall through and open as before
      }
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
      ctx = { ...sellable(sp, headroom, cfg.sellMaxChannelSats), target: () => null, reshape: () => null };
    } catch (err) {
      if (isAuthError(err)) await this.amboss.recheckAfterRefusal();
      return failed(`could not work out the sellable capital: ${errText(err)}`);
    }

    let offers: MyOffer[];
    try {
      offers = await getMyOffers(key);
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
        rec = await getMagmaRecommendations(this.readLnd, key, {
          sellPricingMode: cfg.sellPricingMode,
          adaptiveLevel: this.state.sellAdaptiveLevel,
        });
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
      return { fee: r.recommended.feeRatePpm, base: r.recommended.baseFeeSat, moved: r.shouldReprice };
    };

    // What the offer's SHAPE should be — size window and lease length — when
    // the current one is materially worse than what the market asks for.
    // Returns null when the offer is already fine, so we don't churn updates.
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
      const wantBlocks = Math.min(off.minBlockLength || sell.popularLeaseBlocks, sell.popularLeaseBlocks);
      if (wantMax < wantMin || room < wantMin) return null;
      // Only act on a MEANINGFUL difference: >20% more reach, a lease length
      // that locks buyers out, or a floor above what is economic.
      const widens = wantMax > off.maxSizeSats * 1.2;
      const lowersFloor = wantMin < off.minSizeSats * 0.8;
      const fixesTerm = off.minBlockLength > wantBlocks;
      if (!widens && !lowersFloor && !fixesTerm) return null;
      return {
        minSizeSats: Math.min(wantMin, off.minSizeSats),
        maxSizeSats: Math.max(wantMax, off.maxSizeSats),
        minBlockLength: wantBlocks,
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
      entries.push(await this.upkeepOffer(key, off, ctx, out));
    }
    // Cut memories of offers that are gone have nothing left to give back.
    for (const id of Object.keys(this.state.offerCuts ?? {})) {
      if (!offers.some((o) => o.id === id)) delete this.state.offerCuts?.[id];
    }

    // Auto-list idle capital: no offer at all, leasing beats routing, and
    // auto-pricing on (listing means choosing a price, which only that switch
    // may do). Sized to what can be funded now — never the old flat 1M floor.
    const createRec = rec?.sell.recommendations.find((r) => r.mode === "create");
    if (!this.shuttingDown && cfg.sellAutoReprice && offers.length === 0 && rec?.sell.state === "good_to_sell" && createRec) {
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
          minBlockLength: createRec.recommended.minBlockLength,
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
  private async upkeepOffer(key: string, off: MyOffer, ctx: OfferCtx, out: AutopilotSell[]): Promise<OfferSyncEntry> {
    if (off.status === "ADMIN_DISABLED") {
      return this.syncEntry(off, null, undefined, "disabled by Amboss support — only Amboss can enable it again");
    }
    const sellableNow = ctx.maxOrder(off.minSizeSats);
    const fundable = sellableNow >= Math.max(1, off.minSizeSats);
    if ((off.status === "DISABLED" && fundable) || (off.status === "ENABLED" && !fundable)) {
      const want = fundable ? "ENABLED" : "DISABLED";
      const reason = fundable
        ? "Liquidity provision is on and the offer can be funded"
        : `its smallest channel (${off.minSizeSats} sat) can't be funded: ${sellableNow} sat sellable after the reserve, promised orders and the deploy cap`;
      const write: OfferWrite = {
        at: new Date().toISOString(),
        by: "autopilot",
        action: fundable ? "enable" : "disable",
        fields: { offer_id: off.id },
        ok: false,
        reason,
      };
      let status = off.status;
      try {
        status = await toggleOffer(key, off.id);
        write.ok = status === want;
        write.verified = write.ok;
        if (!write.ok) write.error = `Amboss reports the offer ${status}, not ${want}`;
      } catch (err) {
        write.error = errText(err);
      }
      out.push({
        orderId: off.id,
        action: fundable ? "enable" : "disable",
        sizeSats: off.totalSizeSats,
        ok: write.ok,
        error: write.ok ? (fundable ? undefined : reason) : write.error,
      });
      const now = { ...off, status };
      if (status !== "ENABLED") return this.syncEntry(now, { ...fieldsOf(now), status: want }, write);
      off = now;
    }
    if (off.status !== "ENABLED") return this.syncEntry(off, null, undefined, `offer is ${off.status}`);

    const want = this.wantedTerms(off, ctx);
    const update = termsUpdate(off, want.fields);
    if (!update) {
      // Amboss already has exactly this: the cut memory matches it as is.
      this.keepCut(off.id, want.cut);
      return this.syncEntry(off, want.fields);
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
    return this.syncEntry(after, want.fields, write);
  }

  /** The terms the autopilot wants for an enabled offer, and what a capital
   *  cut among them would have to give back later (OfferCut). */
  private wantedTerms(
    off: MyOffer,
    ctx: OfferCtx,
  ): { fields: OfferFields; kind: "reprice" | "resize" | "relist"; reasons: string[]; cut: OfferCut | null } {
    const cfg = this.state.config;
    const w = fieldsOf(off);
    const reasons: string[] = [];
    let kind: "reprice" | "resize" | "relist" = "reprice";
    const t = ctx.target(off);
    if (t?.moved) {
      w.feeRatePpm = t.fee;
      w.baseFeeSats = t.base;
      reasons.push("market price moved");
    }
    const shape = ctx.reshape(off);
    if (shape) {
      w.minSizeSats = shape.minSizeSats;
      w.maxSizeSats = shape.maxSizeSats;
      w.minBlockLength = shape.minBlockLength;
      w.availableSats = Math.max(w.availableSats, shape.maxSizeSats);
      kind = "resize";
      reasons.push("size window or lease length out of step with the market");
    }
    // What an earlier capital cut took goes back in — up to what it was, and
    // no further than what can be funded now (the clamp below). Auto-sizing
    // decided the window afresh this run: then its max is the wish.
    const earlier = this.liveCut(off);
    if (earlier?.max && !shape && earlier.max.wish > w.maxSizeSats) w.maxSizeSats = earlier.max.wish;
    if (earlier?.listed) w.availableSats += earlier.listed.cutSats;
    const listable = ctx.listable(w.minSizeSats);
    if (cfg.sellAutoRelist && w.availableSats < w.maxSizeSats && w.maxSizeSats <= listable) {
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
    return { fields: w, kind, reasons, cut: cut.max || cut.listed ? cut : null };
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

  private syncState(): OfferSyncStatus {
    this.state.offerSync ??= { at: null, managed: this.state.config.sellEnabled, offers: [], lastError: null };
    return this.state.offerSync;
  }

  /** One offer's sync record: what Amboss has, what is wanted, the last write. */
  private syncEntry(off: MyOffer, wanted: OfferFields | null, write?: OfferWrite, note?: string): OfferSyncEntry {
    const have = fieldsOf(off);
    const prev = this.state.offerSync?.offers.find((e) => e.offerId === off.id);
    const differences = offerDifferences(have, wanted);
    if (note) differences.push(note);
    return {
      offerId: off.id,
      checkedAt: new Date().toISOString(),
      amboss: have,
      wanted,
      inSync: wanted !== null && differences.length === 0,
      differences,
      lastWrite: write ?? prev?.lastWrite ?? null,
    };
  }

  /** What the autopilot wants for each offer vs what Amboss has (for the UI). */
  offerSyncStatus(): OfferSyncStatus {
    const s = this.state.offerSync ?? { at: null, managed: false, offers: [], lastError: null };
    return { ...s, managed: this.state.config.sellEnabled && this.amboss.hasKey() };
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
   *  through the main run's lock. */
  async pollSellOrders(): Promise<void> {
    if (this.shuttingDown || !this.writeLnd) return;
    let sells: AutopilotSell[];
    try {
      sells = await this.magma.tick();
    } catch (err) {
      console.error("[autopilot] order lane failed:", err);
      return;
    }
    // Skips are explained on each order (journal), not in the run history —
    // and so is a failure that only repeats (see laneNews).
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
      const changes = await stage("fees", this.state.config.enabled, () => this.runFees(writeLnd));
      const rebalances = await stage("rebalancing", this.state.config.rebalanceEnabled, () => this.runRebalances(writeLnd));
      const channels = await stage("channels", this.state.config.channelEnabled, () => this.runChannels(writeLnd));
      const sells = await stage("magma", true, () => this.runSell());
      // Advertised-size upkeep: only gossips when a channel's bucket moved.
      const maxHtlc = await stage("max_htlc", this.state.config.maxHtlcEnabled, () =>
        runMaxHtlcPass(this.readLnd, writeLnd).catch(() => [] as MaxHtlcChange[]),
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

  private feeReport(elasticity: Map<string, number>) {
    return getFeeRecommendations(
      this.readLnd,
      this.rebalanceLog.recent(200),
      this.feeCooldown(),
      this.feeV2Overrides(),
      this.overrides.all(),
      elasticity,
      this.flowAnchors(),
    );
  }
  private feeApply(writeLnd: AuthenticatedLnd, items: FeeApplyItem[]) {
    return applyFees(this.readLnd, writeLnd, items);
  }
  private rebalanceReport() {
    return getRebalanceRecommendations(
      this.readLnd,
      this.rebalanceLog.recent(200),
      this.feeCooldown(),
      this.feeV2Overrides(),
      this.overrides.all(),
      this.rebalanceRecOverrides(),
    );
  }
  private rebalanceExec(writeLnd: AuthenticatedLnd, params: RebalanceExecParams) {
    return executeRebalance(this.readLnd, writeLnd, params);
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
