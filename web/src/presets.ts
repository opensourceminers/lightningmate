import type { AutopilotConfig, AutopilotConfigPatch } from "./types";

/**
 * The Strategy presets. One goal, cascaded: each sets the fee curve (floor,
 * balanced level, base fee), its behaviour (how fast idle channels get
 * cheaper, how hard drained ones are protected, the profit-floor margin), the
 * rebalance economics and which autopilots run — so nothing pulls against the
 * chosen goal. The per-subtab controls still override anything afterwards.
 *
 * Rebalancing (review a2): a preset sets how much of a refill's expected
 * earnings its route may cost (econRatio), the per-run limit and the daily fee
 * budget — the profit check itself decides whether anything runs. At the low
 * fees "Max routing" sets, a refill rarely clears it (a 100-sat net needs
 * hundreds of ppm of margin on a typical small-node channel), and its copy
 * says so instead of promising "loose rebalancing".
 *
 * No preset touches Magma selling (D9): selling stays off unless the operator
 * switches Liquidity provision on themselves, after seeing whether their node
 * can realistically sell. ("Balanced — Recommended" used to switch selling on,
 * and "Max profit" switched channel opens OFF to leave capital "for leasing" —
 * for nodes whose offers never sold.)
 */
export interface Preset {
  id: string;
  label: string;
  desc: string;
  cfg: AutopilotConfigPatch;
}

/** Keys a preset must never set: selling is the operator's own decision. */
export const SELLING_KEYS = ["sellEnabled", "sellAutoReprice", "sellAutoSize", "sellAutoRelist", "sellAutoClose", "sellPricingMode"] as const;

export function buildPresets(config: Pick<AutopilotConfig, "policy" | "rebalancePolicy">): Preset[] {
  return [
    {
      id: "routing",
      label: "Max routing",
      desc: "Cheapest fees, zero base — win the most forwards. Refills run only when the profit check passes, which is rare at fees this low.",
      cfg: {
        enabled: true,
        rebalanceEnabled: true,
        channelEnabled: true,
        policy: {
          ...config.policy,
          minPpm: 25,
          neutralPpm: 60,
          maxPpm: 1000,
          baseFeeMsat: 0,
          protectPpm: 250,
          safetyMargin: 1.05,
          noFlowRatchetSteps: 4,
          exploreLowerModifier: 0.75,
        },
        rebalancePolicy: { ...config.rebalancePolicy, econRatio: 0.9 },
        maxRebalancesPerRun: 4,
        rebalanceDailyBudgetSats: 25_000,
      },
    },
    {
      id: "balanced",
      label: "Balanced",
      desc: "Compete for flow at sensible fees, refill a drained channel when the profit check passes, open channels as funds allow. Recommended.",
      cfg: {
        enabled: true,
        rebalanceEnabled: true,
        channelEnabled: true,
        policy: {
          ...config.policy,
          minPpm: 25,
          neutralPpm: 80,
          maxPpm: 1000,
          baseFeeMsat: 0,
          protectPpm: 350,
          safetyMargin: 1.15,
          noFlowRatchetSteps: 3,
          exploreLowerModifier: 0.85,
        },
        rebalancePolicy: { ...config.rebalancePolicy, econRatio: 0.8 },
        maxRebalancesPerRun: 2,
        rebalanceDailyBudgetSats: 10_000,
      },
    },
    {
      id: "profit",
      label: "Max profit",
      desc: "Higher fees, a strict profit check on refills — fewer, richer forwards.",
      cfg: {
        enabled: true,
        rebalanceEnabled: true,
        policy: {
          ...config.policy,
          minPpm: 80,
          neutralPpm: 150,
          maxPpm: 1500,
          baseFeeMsat: 0,
          protectPpm: 600,
          safetyMargin: 1.35,
          noFlowRatchetSteps: 1,
          exploreLowerModifier: 0.9,
        },
        rebalancePolicy: { ...config.rebalancePolicy, econRatio: 0.6 },
        maxRebalancesPerRun: 1,
        rebalanceDailyBudgetSats: 5_000,
      },
    },
  ];
}

/** Does the current config match a preset? Nested objects (policy,
 *  rebalancePolicy) compared field by field. */
export function matchesPreset(config: AutopilotConfig, p: AutopilotConfigPatch): boolean {
  return (Object.keys(p) as (keyof AutopilotConfig)[]).every((k) => {
    const pv = p[k];
    if (pv && typeof pv === "object") {
      const dv = config[k] as unknown as Record<string, unknown>;
      return Object.entries(pv as unknown as Record<string, unknown>).every(([sk, sv]) => dv?.[sk] === sv);
    }
    return config[k] === pv;
  });
}
