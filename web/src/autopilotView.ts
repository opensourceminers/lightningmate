import type {
  AreaStatus,
  AutomationSwitch,
  AutopilotConfig,
  AutopilotConfigPatch,
  AutopilotRun,
  DashboardData,
  DecisionArea,
} from "./types";
import { sats } from "./format";

/**
 * The words behind the Autopilot tab's status lines, the Strategy presets'
 * preview, "Pause all automation" and the Overview's autopilot items — pure,
 * so each statement is tested (review a6-ux:no-why-not-status, a8-engineering:
 * autopilot-decisions-invisible, a6-ux:presets-unconfirmed-capital,
 * a6-ux:numbers-mislead — package P7).
 */

const ago = (iso: string, nowMs: number): string => {
  const secs = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};
const clock = (iso: string): string => new Date(iso).toISOString().slice(11, 16);

export const AREA_LABEL: Record<DecisionArea, string> = {
  fees: "Fee automation",
  rebalance: "Auto-rebalance",
  channels: "Channel autopilot",
  magma: "Liquidity provision",
  maxHtlc: "Routable size",
};

/** Which sub-tab each area lives on (the Overview's links). */
export const AREA_SUB: Record<DecisionArea, string> = {
  fees: "fees",
  rebalance: "rebalancing",
  channels: "channels",
  magma: "magma",
  maxHtlc: "fees",
};

export type StatusTone = "ok" | "info" | "wait" | "warn" | "error" | "off";

/** A state's chip: waiting and deferred are amber information, never red
 *  failures (D15); only an error is red. An area switched on that hasn't
 *  decided anything yet says so — not "nothing to do", which nobody checked. */
export const STATE_CHIP: Record<AreaStatus["state"], { label: string; tone: StatusTone }> = {
  acted: { label: "acted", tone: "ok" },
  idle: { label: "nothing to do", tone: "info" },
  not_run: { label: "not run yet", tone: "info" },
  waiting: { label: "waiting", tone: "wait" },
  deferred: { label: "deferred", tone: "wait" },
  blocked: { label: "blocked", tone: "warn" },
  error: { label: "error", tone: "error" },
  off: { label: "off", tone: "off" },
};

export interface StatusView {
  tone: StatusTone;
  chip: string;
  text: string;
  /** "3m ago" — and for a decision made again and again, "×48 since 08:00". */
  when: string | null;
  /** The area's last error, when it isn't the current state (24 h). */
  lastError: string | null;
}

/** One area's status line (D16). */
export function areaStatusView(s: AreaStatus | undefined, nowMs = Date.now()): StatusView | null {
  if (!s) return null;
  const chip = STATE_CHIP[s.state] ?? STATE_CHIP.idle;
  const repeats = s.repeats && s.repeats > 1 && s.since ? ` · ×${s.repeats} since ${clock(s.since)} UTC` : "";
  const lastError =
    s.lastError && s.state !== "error" && nowMs - Date.parse(s.lastError.at) < 24 * 3_600_000
      ? `last error ${ago(s.lastError.at, nowMs)}: ${s.lastError.text}`
      : null;
  return { tone: chip.tone, chip: chip.label, text: s.text, when: s.at ? `${ago(s.at, nowMs)}${repeats}` : null, lastError };
}

// ── Strategy presets: what a click changes ──────────────────────────────────

export interface PresetChange {
  label: string;
  from: string;
  to: string;
  /** What the change does with the node's money, when it moves any. */
  capital?: string;
}

const onOff = (v: unknown) => (v ? "on" : "off");
const num = (v: unknown) => (v === null ? "no limit" : typeof v === "number" ? sats(v) : String(v));

const SWITCH_LABEL: Record<AutomationSwitch, string> = {
  enabled: "Fee automation",
  rebalanceEnabled: "Auto-rebalance",
  channelEnabled: "Channel autopilot",
  maxHtlcEnabled: "Advertise routable size",
  sellEnabled: "Liquidity provision (Magma)",
};

const POLICY_LABEL: Partial<Record<keyof AutopilotConfig["policy"], string>> = {
  minPpm: "Min ppm",
  neutralPpm: "Neutral ppm",
  maxPpm: "Max ppm",
  protectPpm: "Protect ppm",
  baseFeeMsat: "Base fee (msat)",
  safetyMargin: "Refill-cost margin",
  noFlowRatchetSteps: "Idle ratchet steps",
  exploreLowerModifier: "Explore-lower factor",
};

/**
 * Exactly what applying a preset changes, field by field — and, for each
 * change that moves capital (channel opens from on-chain funds, refills paid
 * in routing fees, bigger refill budgets), what it does with the money.
 * Fields the preset sets to what they already are are left out.
 */
export function presetChanges(config: AutopilotConfig, preset: AutopilotConfigPatch): PresetChange[] {
  const out: PresetChange[] = [];
  const budget = (preset.rebalanceDailyBudgetSats !== undefined ? preset.rebalanceDailyBudgetSats : config.rebalanceDailyBudgetSats) ?? null;
  for (const k of ["enabled", "rebalanceEnabled", "channelEnabled", "maxHtlcEnabled", "sellEnabled"] as AutomationSwitch[]) {
    const to = preset[k];
    if (to === undefined || to === config[k]) continue;
    const capital =
      to && k === "channelEnabled"
        ? "opens channels with your on-chain funds, when an open pays back"
        : to && k === "rebalanceEnabled"
          ? `pays routing fees for refills — up to ${budget === null ? "no daily limit" : `${sats(budget)} sat a day`}`
          : to && k === "sellEnabled"
            ? "sells your on-chain funds as channels to Magma buyers"
            : undefined;
    out.push({ label: SWITCH_LABEL[k], from: onOff(config[k]), to: onOff(to), ...(capital ? { capital } : {}) });
  }
  if (preset.rebalanceDailyBudgetSats !== undefined && preset.rebalanceDailyBudgetSats !== config.rebalanceDailyBudgetSats) {
    const more = preset.rebalanceDailyBudgetSats === null || (config.rebalanceDailyBudgetSats !== null && preset.rebalanceDailyBudgetSats > config.rebalanceDailyBudgetSats);
    out.push({
      label: "Daily rebalance fee budget (sat)",
      from: num(config.rebalanceDailyBudgetSats),
      to: num(preset.rebalanceDailyBudgetSats),
      ...(more ? { capital: "more routing fees a day may go to refills" } : {}),
    });
  }
  if (preset.maxRebalancesPerRun !== undefined && preset.maxRebalancesPerRun !== config.maxRebalancesPerRun) {
    out.push({
      label: "Max rebalances / run",
      from: num(config.maxRebalancesPerRun),
      to: num(preset.maxRebalancesPerRun),
      ...(preset.maxRebalancesPerRun > config.maxRebalancesPerRun ? { capital: "more refills a run" } : {}),
    });
  }
  const econ = preset.rebalancePolicy?.econRatio;
  if (econ !== undefined && econ !== config.rebalancePolicy.econRatio) {
    out.push({
      label: "Max share of expected earnings spent on a refill",
      from: String(config.rebalancePolicy.econRatio),
      to: String(econ),
      ...(econ > config.rebalancePolicy.econRatio ? { capital: "a refill may cost more of what it earns" } : {}),
    });
  }
  for (const [k, label] of Object.entries(POLICY_LABEL) as [keyof AutopilotConfig["policy"], string][]) {
    const to = preset.policy?.[k];
    if (to === undefined || to === config.policy[k]) continue;
    out.push({ label, from: num(config.policy[k]), to: num(to) });
  }
  const OTHER: [keyof AutopilotConfig & keyof AutopilotConfigPatch, string][] = [
    ["intervalMinutes", "Run every (min)"],
    ["cooldownMinutes", "Fee cooldown (min)"],
    ["maxChangesPerRun", "Max fee changes / run"],
    ["channelSizeSats", "Channel size (sat)"],
    ["channelReserveSats", "Keep on-chain reserve (sat)"],
  ];
  for (const [k, label] of OTHER) {
    const to = preset[k];
    if (to === undefined || to === config[k]) continue;
    out.push({ label, from: num(config[k]), to: num(to) });
  }
  return out;
}

/** The confirmation for a preset: its changes, those that move capital
 *  first — or null when it changes nothing. */
export function presetConfirmLines(config: AutopilotConfig, preset: AutopilotConfigPatch): string[] | null {
  const changes = presetChanges(config, preset);
  if (changes.length === 0) return null;
  const line = (c: PresetChange) => `${c.label}: ${c.from} → ${c.to}${c.capital ? ` — ${c.capital}` : ""}`;
  return [...changes.filter((c) => c.capital).map(line), ...changes.filter((c) => !c.capital).map(line)];
}

/** No automation switched on: the Strategy header says "Autopilot off" — a
 *  fresh install read "Custom settings active" (no preset turns all off). */
export function allAutomationOff(config: Pick<AutopilotConfig, AutomationSwitch>): boolean {
  return !config.enabled && !config.rebalanceEnabled && !config.channelEnabled && !config.maxHtlcEnabled && !config.sellEnabled;
}

// ── Pause all / resume ───────────────────────────────────────────────────────

/** What "Pause all automation" stops, one line each. Exact about a run in
 *  progress: each step asks the switch right before it starts, so nothing
 *  new starts after the pause — but a payment, an open or a write already
 *  sent finishes (review of P7). */
export function pauseLines(config: Pick<AutopilotConfig, AutomationSwitch>): string[] {
  const lines: string[] = [];
  if (config.enabled) lines.push("Fee automation — no further fee is written (a sold channel's promised fee cap is still kept)");
  if (config.rebalanceEnabled) lines.push("Auto-rebalance — no further refill is paid (a payment already under way ends on record)");
  if (config.channelEnabled) lines.push("Channel autopilot — no further channel is opened (an open already being broadcast completes)");
  if (config.maxHtlcEnabled) lines.push("Advertise routable size — max HTLC stays as it is");
  if (config.sellEnabled) lines.push("Liquidity provision — no new Magma order is accepted and no offer is changed (orders already taken on are carried to their end)");
  return lines;
}

/**
 * LSP mode (Settings) is no switch of the autopilot's: "Pause all
 * automation" leaves it on, and it keeps answering wallet orders and opening
 * their channels from on-chain funds. While it is on, every place that tells
 * of the pause says so (review of P7, round 2: "every automation off at
 * once" and "nothing new starts on its own" were untrue with it on).
 */
export const LSP_NOT_PAUSED =
  "LSP mode (Settings) is not paused: it keeps answering wallet orders and opens their channels from your on-chain funds once they are paid — switch it off in Settings to stop that too.";

/** The pause, said where it is shown (the Strategy header, the Overview). */
export function pausedText(lspModeOn = false): string {
  return lspModeOn
    ? "the autopilot starts nothing new, but LSP mode (Settings) is still on: it keeps answering wallet orders and opening their channels"
    : "nothing new starts on its own";
}

/** Beside "Pause all automation": what it does — and what Resume doesn't
 *  bring back (D9). */
export function pauseHint(lspModeOn = false): string {
  return lspModeOn
    ? "every autopilot automation off at once (LSP mode, in Settings, stays on) — Resume brings back what was on, selling excepted"
    : "every automation off at once — Resume brings back what was on, selling excepted";
}

/** The note once paused. */
export function pausedToast(lspModeOn = false): string {
  return `All automation paused — Resume brings back what was on, selling excepted${lspModeOn ? ". LSP mode (Settings) is still on" : ""}`;
}

/** What "Resume" switches back on — and that selling stays off (D9: its
 *  switch-on is its own decision, with the selling check in front of you). */
export function resumeLines(was: readonly AutomationSwitch[]): { lines: string[]; sellingNote: string | null } {
  const lines = was.filter((k) => k !== "sellEnabled").map((k) => SWITCH_LABEL[k]);
  return {
    lines,
    sellingNote: was.includes("sellEnabled")
      ? "Liquidity provision was on too: it stays off — switch it on again on Autopilot → Magma, which shows whether this node can sell."
      : null,
  };
}

// ── the Overview ─────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What failed in a pass, in words: the items that failed ("2 failed") and
 * each stage that threw ("the fees stage failed") — a stage failing the same
 * way run after run is a failure of every one of those runs, never "nothing
 * needed changing" (review of P7). Empty: nothing failed.
 */
export function runFailures(r: Pick<NonNullable<DashboardData["autopilot"]["lastRun"]>, "failed" | "errors">): string[] {
  const stages = r.errors ?? [];
  // `failed` counts the stages too; an older summary may not have.
  const items = Math.max(0, r.failed - stages.length);
  return [...(items ? [`${items} failed`] : []), ...stages.map((s) => `the ${s} stage failed`)];
}

/**
 * The Overview digest's autopilot items: the last run, with what THAT run did
 * — failures included — and, as its own item, when the autopilot last changed
 * anything (review a6-ux:numbers-mislead: a fresh run time stood beside the
 * last run that did something, days old maybe; a run whose every update
 * failed read "nothing needed changing"). Areas in error or blocked are said
 * too (a compact D16).
 */
export function autopilotDigest(a: DashboardData["autopilot"], nowMs = Date.now()): { key: string; text: string; warn?: boolean; sub?: string }[] {
  const items: { key: string; text: string; warn?: boolean; sub?: string }[] = [];
  if (a.pausedAt) items.push({ key: "ap-paused", text: `All automation paused ${ago(a.pausedAt, nowMs)} — ${pausedText(a.lspModeOn)}` });
  const anyOn = a.fees || a.rebalance || a.channel || a.sell;
  if (anyOn && a.lastRunAt) {
    const r = a.lastRun;
    const parts = r
      ? [
          r.feeChanges ? `${plural(r.feeChanges, "fee")} adjusted` : null,
          r.rebalances ? plural(r.rebalances, "rebalance") : null,
          r.sells ? plural(r.sells, "Magma action") : null,
          r.opens ? `${plural(r.opens, "channel")} opened` : null,
          r.maxHtlc ? plural(r.maxHtlc, "max-HTLC update") : null,
        ].filter((p): p is string => p !== null)
      : [];
    const failures = r ? runFailures(r) : [];
    const failed = failures.length ? ` · ${failures.join(" · ")}` : "";
    const did = r ? (parts.length ? parts.join(" · ") : failures.length ? "nothing applied" : "nothing needed changing") : "ran";
    const nextMin = Math.max(0, Math.round((Date.parse(a.lastRunAt) + a.intervalMinutes * 60_000 - nowMs) / 60_000));
    items.push({ key: "ap", text: `Autopilot ${ago(a.lastRunAt, nowMs)}: ${did}${failed} — next run in ~${nextMin} min`, warn: failures.length > 0, sub: "history" });
    // The last change, when the last run made none.
    if (a.lastActionAt && (!r || r.applied === 0) && a.lastActionAt !== a.lastRunAt) {
      items.push({ key: "ap-last", text: `Last change by the autopilot ${ago(a.lastActionAt, nowMs)}`, sub: "history" });
    }
  }
  // Only areas that are switched on: one that is off has nothing to fail at
  // (on a read-only node every area reads "blocked: write mode is off").
  const on: Partial<Record<DecisionArea, boolean>> = { fees: a.fees, rebalance: a.rebalance, channels: a.channel, magma: a.sell };
  for (const [area, s] of Object.entries(a.status ?? {}) as [DecisionArea, { state: string; text: string }][]) {
    if (!on[area] || (s.state !== "error" && s.state !== "blocked")) continue;
    items.push({ key: `ap-${area}`, text: `${AREA_LABEL[area]} ${s.state === "error" ? "failed" : "blocked"}: ${s.text}`, warn: true, sub: AREA_SUB[area] });
  }
  return items;
}

/** The Overview tile's foot: when the last run was, and what it did —
 *  its failed stages included ("0 applied" alone read as a quiet run). */
export function autopilotTileFoot(a: Pick<DashboardData["autopilot"], "lastRunAt" | "lastRun">, nowMs = Date.now()): string {
  if (!a.lastRunAt) return "Has not run yet";
  const r = a.lastRun;
  if (!r) return `Last run ${ago(a.lastRunAt, nowMs)}`;
  const failures = runFailures(r);
  return `Last run ${ago(a.lastRunAt, nowMs)} · ${r.applied} applied${failures.length ? `, ${failures.join(", ")}` : ""}`;
}

// ── "Run once now" ───────────────────────────────────────────────────────────

/** What a run did, in one line — "nothing applied, see each area's decision"
 *  instead of a bare "0 applied, 0 failed of 0 attempted"; and a stage that
 *  threw is said, also when it failed the same way the run before. */
export function runResultLine(run: Pick<AutopilotRun, "applied" | "failed" | "attempted" | "errors">): string {
  const stages = run.errors ?? [];
  const said = stages.map((e) => `${e.stage} stage failed: ${e.error}`).join("; ");
  if (run.attempted === 0 && stages.length === 0) return "Run finished: nothing needed doing — each area's decision is below.";
  // Nothing tried but stages that threw: say those, not "0 applied of 1".
  if (run.applied === 0 && run.attempted <= stages.length) return `Run finished: nothing applied — the ${said}.`;
  const failed = run.failed ? `, ${run.failed} failed` : "";
  return `Run finished: ${run.applied} applied${failed} of ${run.attempted}${said ? ` (${said})` : ""}.`;
}
