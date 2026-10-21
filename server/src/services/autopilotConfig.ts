import { DEFAULT_POLICY, type FeePolicy } from "./fees.js";
import { DEFAULT_REBALANCE_POLICY, type RebalancePolicy } from "./rebalance.js";
import { MIN_CHANNEL_SATS } from "./channelOps.js";

/**
 * Autopilot settings: the shape, the defaults, and the BOUNDS of every value.
 *
 * Every number the autopilot acts on has a range, and anything outside it is
 * rejected with a message naming the field — never coerced. The old endpoint
 * stored whatever it was sent: an interval of 40,000 min overflowed Node's
 * timer into a 1 ms loop, a blank field became 0 (= unlimited rebalance budget,
 * no reserve, 1-minute runs), `"false"` (a string) switched automation ON, and
 * `policy: null` crashed every later run. "Unlimited" now has to be said
 * explicitly (null), it can no longer happen by accident.
 */

export interface AutopilotConfig {
  enabled: boolean;
  intervalMinutes: number;
  /** Per-channel minimum time between fee changes — prevents gossip spam. */
  cooldownMinutes: number;
  /** Max channels changed in a single run — caps blast radius. */
  maxChangesPerRun: number;
  policy: FeePolicy;
  /** Let a channel's profit floor (its refill cost × safety margin) lift its
   *  fee above policy.maxPpm. Off: the floor stops at maxPpm (review a1: one
   *  pricey refill lifted a fee past the ceiling in a single move). */
  feeFloorAboveMax: boolean;
  /** Auto-rebalancing — independent of fee automation, also default off. */
  rebalanceEnabled: boolean;
  rebalancePolicy: RebalancePolicy;
  maxRebalancesPerRun: number;
  /** Per-target minimum time between rebalances. */
  rebalanceCooldownMinutes: number;
  /** Only auto-rebalance within this hour window (container clock, 0–24). Equal
   *  start/end = any time. e.g. 0→6 = only overnight, when routes are cheaper. */
  rebalanceHourStart: number;
  rebalanceHourEnd: number;
  /** Cap on total rebalance fees spent per day (sats). null = explicitly no
   *  cap; there is no implicit "0 means unlimited" any more. */
  rebalanceDailyBudgetSats: number | null;
  /** Channel autopilot: open a channel to the top suggestion when funds allow. */
  channelEnabled: boolean;
  /** Keep at least this much on-chain (sats) untouched. */
  channelReserveSats: number;
  /** Channel size to open; 0 = use the suggestion's recommended size. */
  channelSizeSats: number;
  /** Minimum time between auto-opens. */
  channelCooldownMinutes: number;
  /** Magma liquidity provision: auto-fulfill sell orders (accept + open channel). */
  sellEnabled: boolean;
  /** Max total capital deployed into sold channels (sats). */
  sellMaxDeploySats: number;
  /** On-chain balance to always keep when fulfilling (sats). */
  sellReserveSats: number;
  /** Max channel size to fulfill per order (sats). */
  sellMaxChannelSats: number;
  /** Auto-close sold channels once the lease is over, to reclaim capital. */
  sellAutoClose: boolean;
  /** Top a depleted offer back up (within the caps) so it keeps taking orders. */
  sellAutoRelist: boolean;
  /** Keep an enabled offer continuously priced to the current market (never below
   *  the profit floor), instead of leaving it static. */
  sellAutoReprice: boolean;
  /** Keep the offer's size window and lease length in a sane, standard shape,
   *  up to sellMaxChannelSats. Separate from pricing on purpose. */
  sellAutoSize: boolean;
  /** Pricing level when auto-pricing, on what buyers actually paid: fast (their
   *  25th percentile — the "Low" mode; never below the profit floor), balanced
   *  (the median), premium (the 75th percentile), or auto (between their 25th
   *  and 75th percentile: starts in the middle and steps up that range after
   *  each sale; it never steps down on its own, but it follows the market —
   *  when buyers pay less, the price comes down with it). */
  sellPricingMode: "fast" | "balanced" | "premium" | "auto";
  /** Advertise routable size: keep each channel's max_htlc just under its
   *  spendable balance (power-of-2 buckets) so senders skip depleted channels. */
  maxHtlcEnabled: boolean;
}

export const DEFAULT_CONFIG: AutopilotConfig = {
  enabled: false,
  intervalMinutes: 30,
  cooldownMinutes: 360,
  maxChangesPerRun: 5,
  policy: DEFAULT_POLICY,
  feeFloorAboveMax: false,
  rebalanceEnabled: false,
  rebalancePolicy: DEFAULT_REBALANCE_POLICY,
  maxRebalancesPerRun: 2,
  rebalanceCooldownMinutes: 720,
  rebalanceHourStart: 0,
  rebalanceHourEnd: 24,
  rebalanceDailyBudgetSats: 10_000,
  channelEnabled: false,
  channelReserveSats: 50_000,
  channelSizeSats: 0,
  channelCooldownMinutes: 1_440,
  sellEnabled: false,
  sellMaxDeploySats: 2_000_000,
  sellReserveSats: 50_000,
  // No bigger than the deploy cap: a 5M channel cap above a 2M deploy cap
  // advertised (on the manual form's 1M–5M default) orders the autopilot then
  // turned down as "deploy cap reached". Lowering a default only ever lets
  // the autopilot do less.
  sellMaxChannelSats: 2_000_000,
  sellAutoClose: false,
  sellAutoRelist: false,
  sellAutoReprice: true,
  sellAutoSize: true,
  sellPricingMode: "balanced",
  maxHtlcEnabled: false,
};

// ── the schema ────────────────────────────────────────────────────────────────

export interface NumberBounds {
  min: number;
  max: number;
  integer: boolean;
  /** null is a meaningful value (e.g. "no cap"). */
  nullable?: boolean;
}

type TopKey = Exclude<keyof AutopilotConfig, "policy" | "rebalancePolicy">;
/** The top-level settings whose value is a number (or number | null). */
type NumericTopKey = { [K in TopKey]: AutopilotConfig[K] extends number | null ? K : never }[TopKey];

const int = (min: number, max: number, extra: Partial<NumberBounds> = {}): NumberBounds => ({
  min,
  max,
  integer: true,
  ...extra,
});
const real = (min: number, max: number): NumberBounds => ({ min, max, integer: false });

const MAX_SATS = 1_000_000_000; // 10 BTC
/** Every bitcoin there will ever be (21M BTC). The ceiling for values where a
 *  bigger number is only ever SAFER — an on-chain reserve. The bound then just
 *  rejects garbage, and an upgrade can never shrink a reserve an operator chose. */
const MAX_MONEY_SATS = 2_100_000_000_000_000;
/** Ten years. A longer cooldown is likewise only ever safer (fewer automatic
 *  actions), so its ceiling only rejects garbage too: clamping a stored
 *  90-day cooldown down to a tidy maximum would let the autopilot act sooner
 *  after an upgrade than the operator allowed. Cooldowns are compared, never
 *  handed to a timer, so a big value can't overflow anything. */
const MAX_COOLDOWN_MINUTES = 10 * 365 * 24 * 60;
/** The longest run interval a Node timer can hold: setInterval turns any delay
 *  above 2^31−1 ms into 1 ms — a back-to-back loop. 35,791 min ≈ 24.9 days. */
const MAX_TIMER_MINUTES = Math.floor((2 ** 31 - 1) / 60_000);

/** Ranges for every numeric setting. Exported for the UI (min/max hints). */
export const CONFIG_BOUNDS: Record<NumericTopKey, NumberBounds> = {
  // ≥ 5 min: each run scans forwards and calls Amboss. The ceiling is the
  // timer's limit, not a tidy "one day": 0.7.7 honoured every interval up to
  // it, and an operator who slowed the autopilot to a weekly run must not get
  // daily runs (7× the rebalance spend under the same daily budget) from an
  // upgrade. A slower autopilot is only ever safer.
  intervalMinutes: int(5, MAX_TIMER_MINUTES),
  cooldownMinutes: int(30, MAX_COOLDOWN_MINUTES),
  // 0 = apply no fee changes. That is how the engine has always read 0, and a
  // blank field in the 0.7.7 UI saved exactly 0 — those installs must not
  // start changing fees on upgrade. (0 is the safe end here, never "unlimited".)
  maxChangesPerRun: int(0, 50),
  maxRebalancesPerRun: int(0, 10),
  // > 0: the failure backoff multiplies this, so 0 would also disable backoff.
  rebalanceCooldownMinutes: int(30, MAX_COOLDOWN_MINUTES),
  rebalanceHourStart: int(0, 24),
  rebalanceHourEnd: int(0, 24),
  rebalanceDailyBudgetSats: int(1, 10_000_000, { nullable: true }),
  // Floors keep fees for a close/sweep available even when a value is fat-fingered.
  channelReserveSats: int(25_000, MAX_MONEY_SATS),
  channelSizeSats: int(0, MAX_SATS),
  channelCooldownMinutes: int(360, MAX_COOLDOWN_MINUTES),
  sellMaxDeploySats: int(0, MAX_SATS),
  sellReserveSats: int(25_000, MAX_MONEY_SATS),
  sellMaxChannelSats: int(0, MAX_SATS),
};

export const POLICY_BOUNDS: Record<keyof FeePolicy, NumberBounds> = {
  minPpm: int(0, 50_000),
  maxPpm: int(1, 50_000),
  neutralPpm: int(0, 50_000),
  protectPpm: int(0, 50_000),
  baseFeeMsat: int(0, 10_000_000),
  safetyMargin: real(1, 3),
  noFlowRatchetSteps: int(0, 10),
  exploreLowerModifier: real(0.5, 1),
  // ≥ 1: the engine rounds with x/step*step — 0 makes every target NaN.
  step: int(1, 1_000),
  minChangePpm: int(0, 10_000),
};

export const REBALANCE_POLICY_BOUNDS: Record<keyof RebalancePolicy, NumberBounds> = {
  econRatio: real(0.05, 1),
  maxLocalRatioTarget: real(0, 1),
  minLocalRatioSource: real(0, 1),
  amountSats: int(1_000, 100_000_000),
  minDemandSats: int(0, MAX_SATS),
  flowWindowDays: int(1, 90),
  maxCandidates: int(1, 50),
};

const BOOLEAN_KEYS = [
  "enabled",
  "feeFloorAboveMax",
  "rebalanceEnabled",
  "channelEnabled",
  "sellEnabled",
  "sellAutoClose",
  "sellAutoRelist",
  "sellAutoReprice",
  "sellAutoSize",
  "maxHtlcEnabled",
] as const satisfies readonly TopKey[];

const PRICING_MODES = ["fast", "balanced", "premium", "auto"] as const;

/** What GET /api/autopilot sends the UI so its inputs carry the same limits. */
export const AUTOPILOT_CONFIG_BOUNDS = {
  config: CONFIG_BOUNDS,
  policy: POLICY_BOUNDS,
  rebalancePolicy: REBALANCE_POLICY_BOUNDS,
};

export type AutopilotConfigPatch = Partial<Omit<AutopilotConfig, "policy" | "rebalancePolicy">> & {
  policy?: Partial<FeePolicy>;
  rebalancePolicy?: Partial<RebalancePolicy>;
};

export class ConfigValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join("; "));
    this.name = "ConfigValidationError";
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Own keys only. `key in obj` and `obj[key]` also see Object.prototype, so a
 *  body key such as "constructor" or "toString" would find a "bound" there and
 *  be accepted, merged and saved into the live config. */
const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

function describeRange(b: NumberBounds): string {
  const kind = b.integer ? "a whole number" : "a number";
  return `${kind} between ${b.min} and ${b.max}${b.nullable ? " (or null for no limit)" : ""}`;
}

/** null when valid, else the error text for `field`. */
function checkNumber(field: string, value: unknown, b: NumberBounds): string | null {
  if (value === null && b.nullable) return null;
  const shown = typeof value === "string" ? `"${value}"` : JSON.stringify(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return `${field} must be ${describeRange(b)} (got ${shown})`;
  if (b.integer && !Number.isInteger(value)) return `${field} must be ${describeRange(b)} (got ${value})`;
  if (value < b.min || value > b.max) return `${field} must be ${describeRange(b)} (got ${value})`;
  return null;
}

function checkSection<T extends object>(
  name: string,
  raw: unknown,
  bounds: Record<keyof T, NumberBounds>,
  errors: string[],
): Partial<T> | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    errors.push(`${name} must be an object`);
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    // Unknown keys are dropped, not stored — prototype names included.
    if (!has(bounds, k)) continue;
    const b = (bounds as Record<string, NumberBounds>)[k];
    const err = checkNumber(`${name}.${k}`, v, b);
    if (err) errors.push(err);
    else out[k] = v as number;
  }
  return out as Partial<T>;
}

/** The fee-range fields the ppm rules below tie together. */
const FEE_RANGE_KEYS = ["minPpm", "maxPpm", "neutralPpm"] as const;

/**
 * Rules that span fields, checked on the config as it would be saved — but
 * only the rules this update touches. A rule is the business of whoever
 * changes one of its fields: an update that only flips a switch must go
 * through whatever is stored, or a config an older version saved inconsistent
 * would make the kill switch itself unusable.
 */
function crossFieldErrors(c: AutopilotConfig, patch: AutopilotConfigPatch): string[] {
  const errors: string[] = [];
  const p = c.policy;
  if (FEE_RANGE_KEYS.some((k) => patch.policy?.[k] !== undefined)) {
    if (p.minPpm > p.maxPpm) {
      errors.push(`policy.minPpm (${p.minPpm}) must not exceed policy.maxPpm (${p.maxPpm})`);
    } else if (p.neutralPpm < p.minPpm || p.neutralPpm > p.maxPpm) {
      errors.push(
        `policy.neutralPpm (${p.neutralPpm}) must lie between policy.minPpm (${p.minPpm}) and policy.maxPpm (${p.maxPpm})`,
      );
    }
  }
  if (patch.channelSizeSats !== undefined && c.channelSizeSats !== 0 && c.channelSizeSats < MIN_CHANNEL_SATS) {
    errors.push(`channelSizeSats must be 0 (auto) or at least ${MIN_CHANNEL_SATS} sat (got ${c.channelSizeSats})`);
  }
  return errors;
}

/**
 * Make a config satisfy the rules that span fields, in place; one message per
 * repair. Runs on whatever is read from disk (older versions saved anything)
 * and again after the one-shot upgrade migrations, which move the fee range
 * themselves (a 2,500 ppm ceiling becomes 1,000).
 *
 * Every repair moves to the valid value CLOSEST to what the engine actually
 * did with the stored one.
 */
export function repairCrossFields(config: AutopilotConfig): string[] {
  const repairs: string[] = [];
  const p = config.policy;
  // An inverted range (the 0.7.7 UI saved one without complaint): the engine
  // clamps with min(max, max(min, x)), which is the ceiling for every x — so
  // fees were already held at maxPpm (or a channel's profit floor, which may
  // lift the ceiling). Keep exactly that; resetting to the default range
  // would drop the effective floor to 25 ppm on upgrade.
  if (p.minPpm > p.maxPpm) {
    repairs.push(
      `policy.minPpm: ${p.minPpm} is above maxPpm ${p.maxPpm} — using ${p.maxPpm} (the engine already held every fee at the ceiling)`,
    );
    p.minPpm = p.maxPpm;
  }
  // The 0.7.7 UI could save the balanced level outside the range (min raised
  // past it, max lowered below it, a blank field saved as 0). The engine
  // clamped the balanced fee into the range anyway, so the nearest end is what
  // balanced channels were already charged.
  if (p.neutralPpm < p.minPpm || p.neutralPpm > p.maxPpm) {
    const v = Math.min(p.maxPpm, Math.max(p.minPpm, p.neutralPpm));
    repairs.push(`policy.neutralPpm: ${p.neutralPpm} is outside the fee range ${p.minPpm}–${p.maxPpm} — using ${v}`);
    p.neutralPpm = v;
  }
  return repairs;
}

/** A stored channel size that could never open anything: positive, but below
 *  the minimum the open itself enforces. (0 is valid: it means "auto".) */
const isSubMinimumSize = (v: unknown): v is number => typeof v === "number" && v > 0 && v < MIN_CHANNEL_SATS;

/** A stored channel size above today's ceiling. Clamped down to it, the
 *  autopilot could open a channel the stored size never opened: 0.7.7 opened
 *  only once the on-chain balance covered the whole stored size. */
const isAboveMaximumSize = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > CONFIG_BOUNDS.channelSizeSats.max;

/**
 * Whether the rebalance hour window is open at `hour` (0–23, container
 * clock). Equal ends mean any time; start > end wraps past midnight (22→6).
 * The one rule both the autopilot and the load-time repair apply.
 */
export function rebalanceWindowOpen(start: number, end: number, hour: number): boolean {
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

const openHours = (start: number, end: number): number =>
  Array.from({ length: 24 }, (_, h) => h).filter((h) => rebalanceWindowOpen(start, end, h)).length;

/** Shallow merge, with the two nested policies merged field by field. */
export function applyPatch(current: AutopilotConfig, patch: AutopilotConfigPatch): AutopilotConfig {
  return {
    ...current,
    ...patch,
    policy: { ...current.policy, ...(patch.policy ?? {}) },
    rebalancePolicy: { ...current.rebalancePolicy, ...(patch.rebalancePolicy ?? {}) },
  };
}

/**
 * Validate a (partial) settings update against `current`. Unknown keys are
 * dropped — a stale UI draft must not be able to break saving — but every
 * known key must carry a valid value. Returns the clean patch, or every error.
 */
export function validateAutopilotPatch(
  body: unknown,
  current: AutopilotConfig,
): { ok: true; patch: AutopilotConfigPatch } | { ok: false; errors: string[] } {
  if (!isPlainObject(body)) return { ok: false, errors: ["settings must be a JSON object"] };
  const errors: string[] = [];
  const patch: Record<string, unknown> = {};

  for (const key of BOOLEAN_KEYS) {
    if (!has(body, key)) continue;
    if (typeof body[key] !== "boolean") errors.push(`${key} must be true or false (got ${JSON.stringify(body[key])})`);
    else patch[key] = body[key];
  }
  if (has(body, "sellPricingMode")) {
    if (!PRICING_MODES.includes(body.sellPricingMode as (typeof PRICING_MODES)[number])) {
      errors.push(`sellPricingMode must be one of ${PRICING_MODES.join(", ")}`);
    } else {
      patch.sellPricingMode = body.sellPricingMode;
    }
  }
  for (const [key, b] of Object.entries(CONFIG_BOUNDS)) {
    if (!has(body, key)) continue;
    const err = checkNumber(key, body[key], b);
    if (err) errors.push(err);
    else patch[key] = body[key];
  }
  const policy = checkSection<FeePolicy>("policy", body.policy, POLICY_BOUNDS, errors);
  if (policy) patch.policy = policy;
  const rebalancePolicy = checkSection<RebalancePolicy>(
    "rebalancePolicy",
    body.rebalancePolicy,
    REBALANCE_POLICY_BOUNDS,
    errors,
  );
  if (rebalancePolicy) patch.rebalancePolicy = rebalancePolicy;

  const clean = patch as AutopilotConfigPatch;
  if (errors.length === 0) errors.push(...crossFieldErrors(applyPatch(current, clean), clean));
  return errors.length ? { ok: false, errors } : { ok: true, patch: clean };
}

type Rounding = (n: number) => number;

const clamp = (n: number, b: NumberBounds, round: Rounding = Math.round): number => {
  const v = Math.min(b.max, Math.max(b.min, n));
  return b.integer ? round(v) : v;
};

/**
 * How a stored fraction in a whole-number setting is rounded on load, where
 * the nearest whole number could let the autopilot do MORE than the stored
 * value did (the 0.7.7 UI saved whatever was typed, "2.6" included):
 *  - the run interval and the cooldowns round up: rounding down shortens the
 *    time between automatic actions;
 *  - the per-run counts round down, which is exactly what 0.7.7 did with them
 *    (it sliced the plan with them: slice(0, 2.6) keeps 2);
 *  - the rebalance hours round up, again exactly what 0.7.7 did: it compared
 *    whole clock hours with them, so `hour >= 5.4` first held at 6.
 * Every other field rounds to the nearest whole number — under one sat or ppm.
 * (Only stored values: the API takes whole numbers only.)
 */
const LOAD_ROUNDING: Partial<Record<string, Rounding>> = {
  intervalMinutes: Math.ceil,
  cooldownMinutes: Math.ceil,
  rebalanceCooldownMinutes: Math.ceil,
  channelCooldownMinutes: Math.ceil,
  maxChangesPerRun: Math.floor,
  maxRebalancesPerRun: Math.floor,
  rebalanceHourStart: Math.ceil,
  rebalanceHourEnd: Math.ceil,
};
const loadRounding = (field: string): Rounding | undefined => (has(LOAD_ROUNDING, field) ? LOAD_ROUNDING[field] : undefined);

/**
 * Bring a config read from disk into range. Older versions accepted anything,
 * so a persisted file can hold out-of-range or mistyped values. Numbers are
 * clamped (closest to what the operator chose), a mistyped switch goes OFF,
 * other wrong types fall back to the default. Where even the closest valid
 * value would let the autopilot do MORE than the stored one did (a value that
 * kept it idle), that automation is switched off instead: an upgrade never
 * starts spending on its own. Every repair is reported so it can be logged and
 * shown to the operator.
 */
export function sanitizePersistedConfig(raw: unknown): { config: AutopilotConfig; repairs: string[] } {
  const src = isPlainObject(raw) ? raw : {};
  const repairs: string[] = [];
  const config: AutopilotConfig = {
    ...DEFAULT_CONFIG,
    policy: { ...DEFAULT_POLICY },
    rebalancePolicy: { ...DEFAULT_REBALANCE_POLICY },
  };
  const target = config as unknown as Record<string, unknown>;

  for (const key of BOOLEAN_KEYS) {
    if (!has(src, key)) continue;
    // A mistyped switch goes OFF, whatever its default: what 0.7.7 made of
    // "false" (truthy, so on) or 0 (off) can't be trusted either way, and off
    // is the side an upgrade may err on.
    if (typeof src[key] === "boolean") target[key] = src[key];
    else {
      target[key] = false;
      repairs.push(`${key}: ${JSON.stringify(src[key])} is not true/false — switched off`);
    }
  }
  if (has(src, "sellPricingMode")) {
    if (PRICING_MODES.includes(src.sellPricingMode as (typeof PRICING_MODES)[number])) {
      config.sellPricingMode = src.sellPricingMode as AutopilotConfig["sellPricingMode"];
    } else {
      repairs.push(`sellPricingMode: ${JSON.stringify(src.sellPricingMode)} is unknown — using ${DEFAULT_CONFIG.sellPricingMode}`);
    }
  }

  const repairNumber = (field: string, value: unknown, b: NumberBounds, fallback: number | null): number | null => {
    if (value === null && b.nullable) return null;
    if (typeof value === "number" && Number.isFinite(value)) {
      const v = clamp(value, b, loadRounding(field));
      if (v !== value) {
        const why = value < b.min || value > b.max ? `is outside ${b.min}–${b.max}` : "is not a whole number";
        repairs.push(`${field}: ${value} ${why} — using ${v}`);
      }
      return v;
    }
    repairs.push(`${field}: ${JSON.stringify(value)} is not a number — using ${fallback}`);
    return fallback;
  };

  for (const [key, b] of Object.entries(CONFIG_BOUNDS)) {
    if (!has(src, key)) continue;
    const value = src[key];
    // Before 0.7.8, 0 meant "no daily cap". Keep what that operator chose,
    // but say it explicitly now.
    if (key === "rebalanceDailyBudgetSats" && value === 0) {
      config.rebalanceDailyBudgetSats = null;
      repairs.push("rebalanceDailyBudgetSats: legacy 0 (= no cap) is now stored as an explicit 'no limit'");
      continue;
    }
    // A size below the minimum: the closest valid size is the minimum, never
    // 0 — that means "auto", the suggestion's full size, often millions of
    // sats. Checked before rounding: 0.4 sat would otherwise round to 0.
    // (Whether the channel autopilot may open at all: keepIdleAutomationIdle.)
    if (key === "channelSizeSats" && isSubMinimumSize(value)) {
      config.channelSizeSats = MIN_CHANNEL_SATS;
      repairs.push(`channelSizeSats: ${value} is below ${MIN_CHANNEL_SATS} — using ${MIN_CHANNEL_SATS}`);
      continue;
    }
    target[key] = repairNumber(key, value, b, DEFAULT_CONFIG[key as NumericTopKey]);
  }

  const section = <T extends object>(name: string, value: unknown, bounds: Record<keyof T, NumberBounds>, into: T) => {
    if (value === undefined) return;
    if (!isPlainObject(value)) {
      repairs.push(`${name}: ${JSON.stringify(value)} is not an object — using the defaults`);
      return;
    }
    const dest = into as unknown as Record<string, unknown>;
    for (const [k, b] of Object.entries(bounds) as [string, NumberBounds][]) {
      if (!has(value, k)) continue;
      dest[k] = repairNumber(`${name}.${k}`, value[k], b, dest[k] as number);
    }
  };
  section<FeePolicy>("policy", src.policy, POLICY_BOUNDS, config.policy);
  section<RebalancePolicy>("rebalancePolicy", src.rebalancePolicy, REBALANCE_POLICY_BOUNDS, config.rebalancePolicy);

  repairs.push(...keepIdleAutomationIdle(src, config));
  // Spanning rules that can't be satisfied field by field.
  repairs.push(...repairCrossFields(config));
  return { config, repairs };
}

/**
 * Stored values that held an automation back in a way no valid value can
 * express. Repaired to the closest valid value, they would quietly START (or
 * widen) spending on upgrade — so the automation is switched off instead,
 * with the reason; the operator reviews the repaired values and switches it
 * back on.
 *  - channelSizeSats below the minimum: the open itself is refused under
 *    MIN_CHANNEL_SATS, so the channel autopilot never opened anything.
 *  - channelSizeSats above the 10 BTC ceiling: 0.7.7 waited until the
 *    on-chain balance covered the whole stored size; clamped to 10 BTC, a node
 *    with at least 10 BTC but less than the stored size to spare would open a
 *    10 BTC channel where 0.7.7 opened nothing.
 *  - rebalancePolicy.econRatio caps what one rebalance may cost, as a share
 *    of what the refilled liquidity earns. 0 — what a blank field saved in
 *    0.7.7 — made that cap 0, so no rebalance could pass it; any value below
 *    the minimum, raised to the minimum, is a bigger budget than stored.
 *  - an hour window that never opens (e.g. 25→26: the 0.7.7 UI took any
 *    hour) would, clamped to 24→24, mean "any time".
 */
function keepIdleAutomationIdle(src: Record<string, unknown>, config: AutopilotConfig): string[] {
  const repairs: string[] = [];
  if (config.channelEnabled && isSubMinimumSize(src.channelSizeSats)) {
    config.channelEnabled = false;
    repairs.push(
      `channelEnabled: switched off — the stored channel size of ${src.channelSizeSats} sat never opened a channel ` +
        `(the minimum is ${MIN_CHANNEL_SATS}); review the size and switch it back on`,
    );
  } else if (config.channelEnabled && isAboveMaximumSize(src.channelSizeSats)) {
    config.channelEnabled = false;
    repairs.push(
      `channelEnabled: switched off — the stored channel size of ${src.channelSizeSats} sat is above the ` +
        `${CONFIG_BOUNDS.channelSizeSats.max} sat maximum, and opening the maximum instead could open a channel ` +
        `the stored size did not; review the size and switch it back on`,
    );
  }
  repairs.push(...keepIdleRebalancingIdle(src, config));
  return repairs;
}

/** The rebalancing part of keepIdleAutomationIdle. */
function keepIdleRebalancingIdle(src: Record<string, unknown>, config: AutopilotConfig): string[] {
  if (!config.rebalanceEnabled) return [];
  const reasons: string[] = [];

  const policy = isPlainObject(src.rebalancePolicy) ? src.rebalancePolicy : {};
  if (has(policy, "econRatio")) {
    const stored = policy.econRatio;
    const min = REBALANCE_POLICY_BOUNDS.econRatio.min;
    if (typeof stored !== "number" || !Number.isFinite(stored)) {
      reasons.push(`the stored econ ratio ${JSON.stringify(stored)} is not a valid number`);
    } else if (stored < min) {
      reasons.push(
        `the stored econ ratio ${stored} is below the ${min} minimum, and raising it would let rebalances cost more than it allowed`,
      );
    }
  }

  // The window as 0.7.7 evaluated it, from the stored numbers (a missing or
  // non-numeric end is the default the repair uses anyway).
  const storedHour = (v: unknown, repaired: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : repaired;
  const start = storedHour(src.rebalanceHourStart, config.rebalanceHourStart);
  const end = storedHour(src.rebalanceHourEnd, config.rebalanceHourEnd);
  if (openHours(start, end) === 0 && openHours(config.rebalanceHourStart, config.rebalanceHourEnd) > 0) {
    reasons.push(`the stored hour window ${start}→${end} never opened`);
  }

  if (reasons.length === 0) return [];
  config.rebalanceEnabled = false;
  return [`rebalanceEnabled: switched off — ${reasons.join(", and ")}; review the rebalance settings and switch it back on`];
}

/** Defence in depth for the scheduler, whatever reached the config: never
 *  shorter than 5 min, never longer than a Node timer can hold (beyond that
 *  setInterval fires every millisecond). */
export function schedulerIntervalMs(minutes: unknown): number {
  const b = CONFIG_BOUNDS.intervalMinutes;
  const n = typeof minutes === "number" && Number.isFinite(minutes) ? minutes : DEFAULT_CONFIG.intervalMinutes;
  return clamp(n, b, loadRounding("intervalMinutes")) * 60_000;
}
