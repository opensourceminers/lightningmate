import { parseNumField } from "./numField";
import type { AutopilotBounds, AutopilotConfig, AutopilotConfigPatch, FeePolicy, NumberBounds, RebalancePolicy } from "./types";

/**
 * The Autopilot settings form (review a6-ux:autopilot-form-traps): ONE save
 * model. The five automation switches (and the presets, and pause) act at
 * once — they are actions, each with its own confirmation where capital
 * moves. Every setting below them — numbers, check boxes, the pricing level
 * — is a draft until "Save changes": a sticky bar on every sub-tab says what
 * is unsaved, Save and Discard act on all of it, and a draft survives leaving
 * the tab (the panel unmounts: it was lost without a word) and warns before
 * the page is left. Before, switches and some check boxes saved at once,
 * other fields only with a Save button inside a collapsed section, with no
 * sign of what was unsaved.
 *
 * Every value is checked here first, against the bounds the server publishes
 * and the rules that span fields (D17) — a blank or out-of-range field is
 * reported at the field and never sent, never as 0.
 */

export type NumKey =
  | "intervalMinutes"
  | "cooldownMinutes"
  | "maxChangesPerRun"
  | "maxRebalancesPerRun"
  | "rebalanceCooldownMinutes"
  | "rebalanceDailyBudgetSats"
  | "rebalanceHourStart"
  | "rebalanceHourEnd"
  | "channelReserveSats"
  | "channelSizeSats"
  | "channelCooldownMinutes"
  | "channelMaxFeeRate"
  | "sellMaxDeploySats"
  | "sellReserveSats"
  | "sellMaxChannelSats";
export type RebKey = keyof RebalancePolicy;
/** Numeric edits are keyed by path: "intervalMinutes", "policy.minPpm", … */
export type NumPath = NumKey | `policy.${keyof FeePolicy}` | `rebalancePolicy.${RebKey}`;
export type FlagKey = "feeFloorAboveMax" | "sellAutoReprice" | "sellAutoSize" | "sellAutoRelist" | "sellAutoClose";
export type PricingMode = AutopilotConfig["sellPricingMode"];

export interface Draft {
  /** Numbers as typed. */
  nums: Partial<Record<NumPath, string>>;
  flags: Partial<Record<FlagKey, boolean>>;
  pricingMode?: PricingMode;
  /** "No daily limit on rebalance fees", ticked or unticked (absent: as saved). */
  noBudgetLimit?: boolean;
}

export const EMPTY_DRAFT: Draft = { nums: {}, flags: {} };

export const draftIsEmpty = (d: Draft): boolean =>
  Object.keys(d.nums).length === 0 && Object.keys(d.flags).length === 0 && d.pricingMode === undefined && d.noBudgetLimit === undefined;

export function boundsFor(bounds: AutopilotBounds | undefined, path: NumPath): NumberBounds | undefined {
  const [section, key] = path.split(".") as [string, string | undefined];
  if (key === undefined) return bounds?.config[section as NumKey];
  if (section === "policy") return bounds?.policy[key as keyof FeePolicy];
  return bounds?.rebalancePolicy[key as RebKey];
}

export function savedNum(config: AutopilotConfig, path: NumPath): number | null {
  const [section, key] = path.split(".") as [string, string | undefined];
  if (key === undefined) return config[section as NumKey];
  if (section === "policy") return config.policy[key as keyof FeePolicy];
  return config.rebalancePolicy[key as RebKey];
}

export interface DraftCheck {
  /** What Save sends: only what differs from what is saved. */
  patch: AutopilotConfigPatch;
  /** Problems shown at their field … */
  fieldErrors: Partial<Record<NumPath, string>>;
  /** … and every problem, rules across fields included (the bar lists them). */
  errors: string[];
  /** What is unsaved, by label (the bar) — empty: nothing to save. */
  changes: string[];
}

const FLAG_LABEL: Record<FlagKey, string> = {
  feeFloorAboveMax: "Profit floor above Max ppm",
  sellAutoReprice: "Auto-price",
  sellAutoSize: "Auto-size",
  sellAutoRelist: "Auto-relist",
  sellAutoClose: "Auto-close",
};

/** The draft against what is saved: the patch Save would send, what each
 *  field is wrong about, and what is unsaved. */
export function checkDraft(draft: Draft, config: AutopilotConfig, bounds: AutopilotBounds | undefined, labels: Partial<Record<string, string>>): DraftCheck {
  const patch: AutopilotConfigPatch = {};
  const fieldErrors: Partial<Record<NumPath, string>> = {};
  const errors: string[] = [];
  const changes: string[] = [];
  const label = (path: string) => labels[path] ?? path;
  const set = (path: NumPath, value: number | null) => {
    const [section, key] = path.split(".") as [string, string | undefined];
    if (key === undefined) Object.assign(patch, { [section]: value });
    else if (section === "policy") patch.policy = { ...patch.policy, [key]: value };
    else patch.rebalancePolicy = { ...patch.rebalancePolicy, [key]: value };
  };

  const noLimit = draft.noBudgetLimit === true;
  for (const [path, text] of Object.entries(draft.nums) as [NumPath, string][]) {
    if (path === "rebalanceDailyBudgetSats" && noLimit) continue;
    const parsed = parseNumField(text, boundsFor(bounds, path), label(path));
    if (!parsed.ok) {
      fieldErrors[path] = parsed.error;
      errors.push(parsed.error);
      changes.push(label(path));
      continue;
    }
    if (parsed.value === savedNum(config, path)) continue;
    set(path, parsed.value);
    changes.push(label(path));
  }
  if (draft.noBudgetLimit === true && config.rebalanceDailyBudgetSats !== null) {
    patch.rebalanceDailyBudgetSats = null;
    changes.push(`${label("rebalanceDailyBudgetSats")}: no limit`);
  }
  if (draft.noBudgetLimit === false && config.rebalanceDailyBudgetSats === null && patch.rebalanceDailyBudgetSats === undefined && !fieldErrors.rebalanceDailyBudgetSats) {
    const e = `${label("rebalanceDailyBudgetSats")}: enter a daily limit, or tick "No daily limit"`;
    fieldErrors.rebalanceDailyBudgetSats = e;
    errors.push(e);
  }
  for (const [k, v] of Object.entries(draft.flags) as [FlagKey, boolean][]) {
    if (v === config[k]) continue;
    patch[k] = v;
    changes.push(`${FLAG_LABEL[k]} ${v ? "on" : "off"}`);
  }
  if (draft.pricingMode !== undefined && draft.pricingMode !== config.sellPricingMode) {
    patch.sellPricingMode = draft.pricingMode;
    changes.push(`Pricing level: ${draft.pricingMode}`);
  }

  // The rules across fields, as the server checks them (autopilotConfig.ts
  // crossFieldErrors) — only those this draft touches, against what it
  // leaves as saved.
  const p = { ...config.policy, ...(patch.policy ?? {}) };
  const touchesRange = (["minPpm", "maxPpm", "neutralPpm"] as const).some((k) => patch.policy?.[k] !== undefined);
  if (touchesRange) {
    if (p.minPpm > p.maxPpm) {
      const e = `${label("policy.minPpm")} (${p.minPpm}) must not be above ${label("policy.maxPpm")} (${p.maxPpm})`;
      fieldErrors[patch.policy?.minPpm !== undefined ? "policy.minPpm" : "policy.maxPpm"] ??= e;
      errors.push(e);
    } else if (p.neutralPpm < p.minPpm || p.neutralPpm > p.maxPpm) {
      const e = `${label("policy.neutralPpm")} (${p.neutralPpm}) must lie between ${label("policy.minPpm")} (${p.minPpm}) and ${label("policy.maxPpm")} (${p.maxPpm})`;
      fieldErrors["policy.neutralPpm"] ??= e;
      errors.push(e);
    }
  }
  const minSize = bounds?.rules?.channelSizeMinSats ?? 20_000;
  if (patch.channelSizeSats !== undefined && patch.channelSizeSats !== 0 && patch.channelSizeSats < minSize) {
    const e = `${label("channelSizeSats")}: 0 (auto) or at least ${minSize.toLocaleString("en-US")} sat`;
    fieldErrors.channelSizeSats ??= e;
    errors.push(e);
  }
  return { patch, fieldErrors, errors, changes };
}

// ── the draft outlives the panel ─────────────────────────────────────────────

let kept: Draft = EMPTY_DRAFT;
const listeners = new Set<(d: Draft) => void>();
const warnBeforeLeaving = (e: BeforeUnloadEvent) => {
  e.preventDefault();
  e.returnValue = "";
};

/**
 * The unsaved draft, kept outside the panel: switching to another tab
 * unmounts the Autopilot panel, and its unsaved edits used to vanish with it.
 * While a draft has changes, leaving the page asks first (beforeunload), and
 * the Autopilot tab is marked (App, subscribe).
 */
export const draftStore = {
  get: (): Draft => kept,
  set(d: Draft): void {
    const wasEmpty = draftIsEmpty(kept);
    kept = d;
    const isEmpty = draftIsEmpty(d);
    if (typeof window !== "undefined" && wasEmpty !== isEmpty) {
      if (isEmpty) window.removeEventListener("beforeunload", warnBeforeLeaving);
      else window.addEventListener("beforeunload", warnBeforeLeaving);
    }
    for (const fn of listeners) fn(d);
  },
  subscribe(fn: (d: Draft) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
