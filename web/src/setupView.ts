import type { AutopilotConfig, AutopilotConfigPatch } from "./types";
import { buildPresets } from "./presets";
import { satsCompact } from "./format";
import { ppmText } from "./nodeView";

/**
 * The first-start questions, apart from the component so they can be tested.
 * One answer in plain words becomes a set of settings the Autopilot page shows
 * afterwards, where each can still be changed. Selling is never in the patch:
 * switching it on is its own decision with its own dialog (D9).
 */
export type SetupGoal = "routing" | "selling" | "watch";

export const SETUP_GOALS: { id: SetupGoal; label: string; desc: string }[] = [
  { id: "routing", label: "Earn from routing", desc: "The app sets your fees, refills channels when that pays, and can open new ones." },
  { id: "selling", label: "Sell liquidity too", desc: "All of that, and it sells channels on Amboss Magma. Amboss decides who gets orders." },
  { id: "watch", label: "Just look around", desc: "Nothing runs on its own. You can switch everything on later." },
];

export interface SetupChoice {
  goal: SetupGoal;
  /** Open new channels with on-chain funds, unasked. */
  openChannels: boolean;
  /** Always left on chain (sat). */
  reserveSats: number;
  /** Selling: list everything free, or at most `sellCapSats`. */
  sellEverything: boolean;
  sellCapSats: number;
}

/** Largest order at most this, whatever may be listed: bigger orders are rare,
 *  and it is one setting away. */
const LARGEST_ORDER_SATS = 5_000_000;

/** The answer without selling's settings: selling declined, or no key yet. */
export function withoutSelling(patch: AutopilotConfigPatch): AutopilotConfigPatch {
  return Object.fromEntries(Object.entries(patch).filter(([k]) => !k.startsWith("sell"))) as AutopilotConfigPatch;
}

/** The settings an answer means ("Balanced" underneath). */
export function setupPatch(c: SetupChoice, config: Pick<AutopilotConfig, "policy" | "rebalancePolicy">, sellCapTop: number): AutopilotConfigPatch {
  if (c.goal === "watch") return {};
  const balanced = buildPresets(config).find((p) => p.id === "balanced")?.cfg ?? {};
  const patch: AutopilotConfigPatch = { ...balanced, channelEnabled: c.openChannels, channelReserveSats: c.reserveSats };
  if (c.goal === "selling") {
    const cap = c.sellEverything ? sellCapTop : c.sellCapSats;
    patch.sellMaxDeploySats = cap;
    patch.sellReserveSats = c.reserveSats;
    patch.sellMaxChannelSats = Math.min(cap, LARGEST_ORDER_SATS);
    patch.sellAutoReprice = true;
    patch.sellAutoSize = true;
    patch.sellAutoRelist = true;
    patch.sellAutoClose = true;
  }
  return patch;
}

/** What it will do, said before it starts: the figures are the strategy's. */
export function setupLines(c: SetupChoice, config: Pick<AutopilotConfig, "policy" | "rebalancePolicy" | "channelMaxFeeRate">, hasKey: boolean): string[] {
  if (c.goal === "watch") return ["Nothing runs on its own."];
  const balanced = buildPresets(config).find((p) => p.id === "balanced")?.cfg;
  const min = balanced?.policy?.minPpm ?? config.policy.minPpm;
  const max = balanced?.policy?.maxPpm ?? config.policy.maxPpm;
  const budget = balanced?.rebalanceDailyBudgetSats ?? 0;
  const lines = [
    `Fees: set automatically, from ${ppmText(min)} to ${ppmText(max)}.`,
    `Refills: only when the profit check passes, at most ${budget.toLocaleString("en-US")} sat in fees a day.`,
    c.openChannels
      ? `New channels: opened by itself with your on-chain funds, keeping ${satsCompact(c.reserveSats)} sat on chain and paying at most ${config.channelMaxFeeRate} sat/vB. Until this node has routing history that fee limit is the only check, no payback. A channel ties its coins up until it is closed.`
      : "New channels: only when you open them, under Channels → To open.",
  ];
  if (c.goal === "selling") {
    lines.push(
      hasKey
        ? `Selling: ${c.sellEverything ? "everything free" : `at most ${satsCompact(c.sellCapSats)} sat`} is listed once you confirm in the next step. The autopilot manages your offer: price, size and listing, and it closes a sold channel after its lease, for an on-chain fee.`
        : "Selling: off for now. Connect an Amboss key in Settings, then switch it on under Autopilot → Selling.",
    );
  }
  return lines;
}

/** What is wrong with the answers, in words (null: nothing). */
export function setupProblem(c: SetupChoice, bounds: { reserve?: { min: number; max: number }; cap?: { min: number; max: number } }): string | null {
  if (c.goal === "watch") return null;
  const r = bounds.reserve;
  if (!Number.isInteger(c.reserveSats) || (r && (c.reserveSats < r.min || c.reserveSats > r.max))) {
    return r ? `Keep on chain: a whole number from ${r.min.toLocaleString("en-US")} to ${r.max.toLocaleString("en-US")} sat.` : "Keep on chain: a whole number of sats.";
  }
  if (c.goal === "selling" && !c.sellEverything) {
    const min = Math.max(bounds.cap?.min ?? 0, 20_000);
    const max = bounds.cap?.max ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(c.sellCapSats) || c.sellCapSats < min || c.sellCapSats > max) return `Capital to sell: a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")} sat.`;
  }
  return null;
}
