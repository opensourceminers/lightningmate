import { useEffect, useState, type ReactNode } from "react";
import { ConnectAmbossButton, SettingsLink } from "./SettingsLink";
import { Fold } from "./Fold";
import { NodeLink } from "./NodeLink";
import { api } from "../api";
import type { AreaStatus, AutopilotConfigPatch, AutopilotRun, AutopilotState, DecisionArea, MagmaV2Report, SellDiagnostics } from "../types";
import { satsCompact, timeAgo } from "../format";
import { rangeText } from "../numField";
import { lateStageNote, repeatsNote, runProgress } from "../statusNotes";
import { buildPresets, matchesPreset as presetMatches, type Preset } from "../presets";
import { NEUTRAL_PPM_HINT, historyFeeLine } from "../feeView";
import { AUTO_CLOSE_HINT, OFFER_AUTOMATION_HINT, PRICING_MODES } from "../magmaView";
import { REBALANCE_POLICY_FIELDS, REMOVED_SETTINGS_NOTE, budgetLine } from "../rebalanceView";
import {
  AREA_LABEL,
  allAutomationOff,
  areaStatusView,
  shortStatus,
  pauseHint,
  pausedText,
  pausedToast,
  presetChanges,
  resumeLines,
  runResultLine,
} from "../autopilotView";
import {
  EMPTY_DRAFT,
  PER_RUN_HINTS,
  REBALANCE_WINDOW_HINT,
  advancedChanged,
  baselineConfig,
  boundsFor,
  checkDraft,
  draftIsEmpty,
  draftStore,
  OFFER_FLAGS,
  offerManagedView,
  resetToBaseline,
  savedNum,
  switchOnConfirm,
  toggleOfferManaged,
  type AdvancedSet,
  type Draft,
  type FlagKey,
  type NumKey,
  type NumPath,
} from "../autopilotForm";
import { forgetMagmaReport, sharedMagmaReport } from "../magmaReport";
import { useVisibleInterval } from "../usePolledData";
import { ApiError } from "../apiError";
import { RunState, Switch } from "./Switch";
import { useUi } from "./Overlay";
import { goTo } from "../nav";
import { SellDiagnosticsCard } from "./MagmaSellInfo";
import { pauseAllAutomation, turnSellingOff, turnSellingOn } from "./SellingSwitch";
import { FeeRecommendations } from "./FeeRecommendations";
import { RebalanceRecommendations } from "./RebalanceRecommendations";
import { InfoTip } from "./InfoTip";

type Sub = "fees" | "rebalancing" | "channels" | "magma" | "history";

/** What the fee cooldown paces (review 2026-10-25: it read as the wait
 *  between any two updates). */
export const FEE_COOLDOWN_HINT =
  "How often a ramp steps a fee — protecting a drained channel, or recovering a refill's cost. Every other move waits at least this " +
  "long too, and longer by its own rule: a raise or a price test 72 h after the last update, the demand and drain ramps 6 h, a " +
  "lowering 24 h (an idle channel at its target, once it is down to Neutral ppm, a week).";
/** What "Min change" skips — and what it never does. */
export const MIN_CHANGE_HINT =
  "A fee this close to where the engine is heading — or within 20 % of the fee, whichever is more — is left as it is. Never an idle " +
  "channel's step or jump down, nor a fee brought into Min/Max.";
const FEE_NUM_FIELDS: { key: NumKey; label: string; hint?: string }[] = [
  { key: "intervalMinutes", label: "Run every (min)" },
  { key: "cooldownMinutes", label: "Fee cooldown (min)", hint: FEE_COOLDOWN_HINT },
  { key: "maxChangesPerRun", label: "Max fee changes / run", hint: PER_RUN_HINTS.maxChangesPerRun },
];
const POLICY_FIELDS: { key: keyof AutopilotState["config"]["policy"]; label: string; hint?: string }[] = [
  { key: "minPpm", label: "Min ppm (full)" },
  { key: "neutralPpm", label: "Neutral ppm (balanced)", hint: NEUTRAL_PPM_HINT },
  { key: "maxPpm", label: "Max ppm (drained)" },
  { key: "protectPpm", label: "Protect ppm (drained+wanted)" },
  { key: "baseFeeMsat", label: "Base fee (msat)" },
  { key: "step", label: "Round to" },
  { key: "minChangePpm", label: "Min change", hint: MIN_CHANGE_HINT },
];
const REB_NUM_FIELDS: { key: NumKey; label: string; hint?: string }[] = [
  { key: "maxRebalancesPerRun", label: "Max rebalances / run", hint: PER_RUN_HINTS.maxRebalancesPerRun },
  { key: "rebalanceDailyBudgetSats", label: "Rebalancing budget per day (sat)", hint: "The most refills may pay in fees per day, manual runs included." },
  { key: "rebalanceCooldownMinutes", label: "Rebalance cooldown (min)" },
  { key: "rebalanceHourStart", label: "Run from hour (UTC, 0–24)", hint: REBALANCE_WINDOW_HINT },
  { key: "rebalanceHourEnd", label: "Run to hour (UTC, 0–24)", hint: REBALANCE_WINDOW_HINT },
];
// Every rebalance setting shown binds the profit gate (rebalanceView.ts).
const REB_POLICY_FIELDS = REBALANCE_POLICY_FIELDS;
/** Which opens "Max on-chain fee for opens" binds (review 2026-11-10,
 *  LANE-4): the label reads as if it covered every open, and a sold
 *  channel's never looked at it — or at any limit. */
export const CHANNEL_MAX_FEE_HINT =
  "The most the autopilot pays to open a channel of its own, and the most it asks to close a sold channel after its lease at (if " +
  "the buyer's node insists on more, LND may finish that close above it). A channel sold on " +
  "Magma is not held to it — its buyer has paid: it opens at LND's regular fee rate while that costs no more than the sale " +
  "earns. Above that the order waits for lower fees (Market → Orders says so; “Open channel” there opens it only once it costs " +
  "no more). No open costs more than the order brings: if fees stay there, an order whose payment Amboss holds is ended at " +
  "its last moment to open (six hours before Amboss's deadline), and one whose payment this node holds once that payment " +
  "runs out — the buyer is refunded and an alert tells you, with both numbers.";
const CHANNEL_NUM_FIELDS: { key: NumKey; label: string; hint?: string }[] = [
  { key: "channelSizeSats", label: "Channel size (sat, 0=auto)" },
  { key: "channelReserveSats", label: "Keep on-chain reserve (sat)" },
  { key: "channelCooldownMinutes", label: "Open cooldown (min)" },
  { key: "channelMaxFeeRate", label: "Max on-chain fee for opens (sat/vB)", hint: CHANNEL_MAX_FEE_HINT },
];
/** How the channel autopilot decides (shown under its settings). */
export const CHANNEL_OPEN_HINT =
  "Opens wait for an economy fee rate (about half a day to confirm) at or below your maximum, and only when opening and later " +
  "closing the channel would be paid back within a year of what a channel of that size earns on this node (channels older " +
  "than a month, with at least 10 forwards or 1,000 sat earned in 30 days; with less, only the maximum applies). It walks " +
  "down the suggestions: a peer that refused an open waits 1 day, then 7, then 30; one that takes bigger channels than your " +
  "fixed size is skipped (auto size meets its minimum, up to a third of the node's capital); a peer closed within 90 days, " +
  "rated poorly on LN+, of low usefulness or marked “never auto” is never opened to automatically, nor one that advertises " +
  "no address to dial unless it is connected already. Auto size shrinks to what can be spent (rounded down to 100,000 sat, " +
  "never below 1,000,000 sat nor the peer's minimum); a fixed size is never shrunk. " +
  "With selling on, the coins your Magma offer can list (within your deploy cap) wait for Magma while selling " +
  "them is expected to earn more than a routing channel; the rest stays free for routing opens, and the note says how much " +
  "is held. The reserve is what an open leaves on chain — LND's own anchor reserve (10,000 sat per anchor channel, up to " +
  "100,000) wins when it is larger, and the open's fee comes on top. " +
  "When the open fails on this node's side — LND's wallet not synced or short of confirmed coins, or no connection to any " +
  "peer — no peer is held back for it, and the next run tries again. A peer's refusal before anything is broadcast moves " +
  "on to the next suggestion; an open that ends unclearly (also one cut off by a restart) starts the cooldown, as an open does.";

/** What the capital cap does to the listed offer. */
export const DEPLOY_CAP_HINT =
  "What may be sold and listed at once. With the autopilot managing your offer, the offer follows it at every run: it lists what is free on chain after what you keep, up to this limit. Coins that come back from a close are listed at the next run; a spend cuts the listing within seconds. " +
  "A sold channel counts with its size while its lease runs, and with what is still on your side of it after the lease — until it is closed.";

/** Under "Capital to sell": the part of the limit that sits in sold channels
 *  still open after their lease (review 2026-11-10, LANE-7) — null with
 *  none, or with no limit set ("Everything free"). */
export function afterLeaseLine(after: { channels: number; sats: number } | undefined, everything: boolean): string | null {
  if (everything || !after || after.sats <= 0) return null;
  const one = after.channels === 1;
  return (
    `${after.sats.toLocaleString("en-US")} sat of it ${one ? "is" : "are"} in ${after.channels} sold channel${one ? "" : "s"} still open after ` +
    `${one ? "its" : "their"} lease — ${one ? "it counts" : "they count"} until closed (Channels).`
  );
}
/** How far one update moves a fee. */
export const FEE_MOVE_HINT =
  "Each update moves a fee by at most two “Round to” steps up (up to three where a learned elasticity says raising pays; four while " +
  "protecting a drained channel or recovering a refill’s cost; a quarter of the fee, at most every 6 h, for a drained channel that " +
  "sold three times at its fee — the demand ramp — and for one that sells itself empty within three weeks — the drain ramp, up to a " +
  "third of the way to what a refill costs) and at most the idle-ratchet’s steps down. Apart from the price test below, a fee is raised only when the channel " +
  "drains below its target, its flow says it drains, or a floor or Min ppm needs it, and an ordinary raise waits for a sale at the " +
  "fee it charges now — protecting a drained channel too (there an HTLC it had to refuse counts as well). A fee that sells is kept: " +
  "it is not lowered while the channel sells at it, unless the channel holds more than its target and takes in more than it sells " +
  "or would need over three months to sell the surplus; where a channel sells every day and holds no more than its target, a fee " +
  "one step (or a tenth) higher is tried, and taken back if it earns less — the price that earned less is then not raised to for a week either " +
  "(two weeks, four weeks when it fails again), unless the channel drains. A raise the drain rules made — the drain, demand and protect ramps, the " +
  "balance curve, the velocity nudge — is checked the same way at the end of its weeks, once the channel is back in its target band, " +
  "no longer sells itself empty and did not drain at the fee before: what it earned against as many days before it, taken back if " +
  "less by more than one sale (a raise toward a refill cost is not). A raise nothing sold at for 48 h while the channel had " +
  "sats to sell goes back to the last fee that sold — and isn’t raised back to that level for a week, two weeks the second time in " +
  "a row, four the third. " +
  "In one update only: a step back, an idle channel dropping to the price that last won it flow or to the market’s price into its " +
  "peer, a pinned fee, a new channel’s protected fee, a broken lease promise, and a fee outside Min/Max ppm (a fee below Min goes to " +
  "Min first, then steps). An idle channel steps down to Min ppm only where it holds more than its target: at its target it steps " +
  "to Neutral ppm and from there one step a week, and under its target it is not stepped down below Neutral ppm (the drop to the price that last won it flow, or to the market’s, is made there too). “Min change” only skips " +
  "fees already that close to where the engine is heading — never an idle channel’s step or jump down, nor a fee brought into Min/Max. " +
  "“Apply” on the Fees tab applies the engine’s own moves, which the engine then judges as its own; the step-back and the judgement " +
  "need Fee automation’s runs (they keep the clocks), so with it off no price test is offered and a raise applied by hand is not taken back.";
const SELL_NUM_FIELDS: { key: NumKey; label: string; hint?: string }[] = [{ key: "sellMaxChannelSats", label: "Max channel size / order (sat)" }];
/** Fields on the Limits, labelled there (validation messages name them). */
const LIMIT_LABELS = { sellMaxDeploySats: "Capital to sell (sat)", sellReserveSats: "Keep on chain (sat)" } as const;

const SUBS: Sub[] = ["fees", "rebalancing", "channels", "magma", "history"];

/** Field labels by edit path, for validation messages. */
const LABELS: Partial<Record<string, string>> = Object.fromEntries([
  ...[...FEE_NUM_FIELDS, ...REB_NUM_FIELDS, ...CHANNEL_NUM_FIELDS, ...SELL_NUM_FIELDS].map((f) => [f.key, f.label]),
  ...Object.entries(LIMIT_LABELS),
  ...POLICY_FIELDS.map((f) => [`policy.${f.key}`, f.label]),
  ...REB_POLICY_FIELDS.map((f) => [`rebalancePolicy.${f.key}`, f.label]),
]);

/** The Magma settings whose save changes what the Magma report shows. */
const SELL_KEYS = ["sellMaxDeploySats", "sellMaxChannelSats", "sellReserveSats", "sellAutoReprice", "sellAutoSize", "sellPricingMode"] as const;

/** An area's last decision, at the top of its sub-tab (D16): what it did, or
 *  why it did nothing — amber for a wait or a deferral, red only for an
 *  error (D15). */
export function StatusLine({ area, status }: { area: DecisionArea; status: AreaStatus | undefined }) {
  const v = areaStatusView(status);
  if (!v) return null;
  return (
    <div className="ap-status">
      <span className="ap-status-area">{AREA_LABEL[area]}</span>
      <span className={`ap-state t-${v.tone}`}>{v.chip}</span>
      <span className="ap-status-text">{v.text}</span>
      {v.when ? <span className="ap-status-when">{v.when}</span> : null}
      {v.lastError ? <span className="ap-status-err">{v.lastError}</span> : null}
      {/* What it needs is the Amboss key: the way there, right here (SET-4). */}
      {status?.needs === "amboss_key" ? <ConnectAmbossButton small /> : null}
    </div>
  );
}

/** A preset's confirmation: every change it makes, those that move capital
 *  first — and that selling is never touched (D9). */
export function PresetPreview({ preset, config }: { preset: Preset; config: AutopilotState["config"] }) {
  const changes = presetChanges(config, preset.cfg);
  const ordered = [...changes.filter((c) => c.capital), ...changes.filter((c) => !c.capital)];
  return (
    <>
      <p className="modal-msg">{preset.desc}</p>
      <ul className="preset-changes">
        {ordered.map((c) => (
          <li key={c.label} className={c.capital ? "capital" : undefined}>
            {c.label}: {c.from} → <strong>{c.to}</strong>
            {c.capital ? ` — ${c.capital}` : ""}
          </li>
        ))}
      </ul>
      <p className="modal-msg muted">Selling is never changed by a preset.</p>
    </>
  );
}

export function AutopilotPanel({ initialSub }: { initialSub?: string }) {
  const [server, setServer] = useState<AutopilotState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The unsaved settings: kept outside the panel, so leaving the tab no
  // longer drops them (autopilotForm.ts).
  const [draft, setDraftState] = useState<Draft>(() => draftStore.get());
  const setDraft = (d: Draft) => {
    draftStore.set(d);
    setDraftState(d);
  };
  const [busy, setBusy] = useState(false);
  // The area whose details are open under the list (none at first).
  const [sub, setSub] = useState<Sub | null>(initialSub && (SUBS as string[]).includes(initialSub) ? (initialSub as Sub) : null);
  const [lastRun, setLastRun] = useState<AutopilotRun | null>(null);
  // Market reality for the caps section — the shared report (magmaReport.ts).
  const [magma, setMagma] = useState<MagmaV2Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ui = useUi();
  const { toast } = ui;
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const toggleItem = (key: string) =>
    setOpenItems((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const loadMagma = () => {
    void sharedMagmaReport()
      .then(setMagma)
      .catch(() => setMagma(null));
  };
  useEffect(loadMagma, []);

  // The same "why don't I sell?" checklist as Market → Sell, on the Magma
  // settings — read when that sub-tab is opened, and after a save there.
  const [diag, setDiag] = useState<SellDiagnostics | null>(null);
  const loadDiag = () => {
    void api.sellDiagnostics().then(setDiag).catch(() => setDiag(null));
  };
  useEffect(() => {
    if (sub === "magma") loadDiag();
  }, [sub]);

  // Every 15 s while the page is visible. A failed first load is said, with a
  // retry — it used to leave "Loading autopilot…" up for good.
  const load = () =>
    api
      .autopilotGet()
      .then((s) => {
        setServer(s);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)));
  useEffect(() => {
    void load();
  }, []);
  useVisibleInterval(() => void load(), 15_000);

  if (!server) {
    return (
      <section className="panel">
        {loadError ? (
          <p className="banner error">
            Couldn't load the autopilot: {loadError}{" "}
            <button className="linklike" onClick={() => void load()}>
              Try again
            </button>
          </p>
        ) : (
          <p className="muted empty">Loading autopilot…</p>
        )}
      </section>
    );
  }
  const writeOff = !server.canWrite;
  const config = server.config;
  const status = server.status;
  const paused = server.paused ?? null;
  // LSP mode (Settings) is not paused with the rest: said wherever the pause is.
  const lspModeOn = server.lspModeOn ?? false;
  const check = checkDraft(draft, config, server.bounds, LABELS);
  const unsaved = !draftIsEmpty(draft);

  const save = async (patch: AutopilotConfigPatch, successMsg?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setServer(await api.autopilotSet(patch));
      if (successMsg) toast(successMsg, "success");
      // The caps, the pricing level, auto-price or auto-size changed: the
      // Magma report shows them — read it afresh (it went stale).
      if (SELL_KEYS.some((k) => k in patch)) {
        forgetMagmaReport();
        loadMagma();
        if (sub === "magma") loadDiag();
      }
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** "Save changes": every setting in the draft, checked first — nothing
   *  is sent while a field is wrong (and nothing is ever sent as 0). */
  const saveDraft = async () => {
    if (check.errors.length) {
      setError(check.errors.join(" · "));
      return;
    }
    if (Object.keys(check.patch).length === 0) {
      setDraft(EMPTY_DRAFT);
      return;
    }
    if (await save(check.patch, "Settings saved")) setDraft(EMPTY_DRAFT);
  };

  const runNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const { run, state } = await api.autopilotRun();
      setLastRun(run);
      setServer(state);
    } catch (e) {
      // 409: a run is already in progress — its result shows when it ends.
      if (e instanceof ApiError && e.status === 409) toast(e.message, "info");
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** A preset applies only after its preview: what it changes, and what of
   *  that moves capital (review a6-ux:presets-unconfirmed-capital). */
  const applyPreset = async (p: Preset) => {
    if (presetChanges(config, p.cfg).length === 0) {
      toast(`“${p.label}” is what you have already`, "info");
      return;
    }
    const ok = await ui.confirm({ title: `Apply “${p.label}”?`, body: <PresetPreview preset={p} config={config} />, confirmLabel: "Apply" });
    if (ok) await save(p.cfg, `Strategy applied: ${p.label}`);
  };

  const pauseAll = async () => {
    await pauseAllAutomation({
      config,
      lspModeOn,
      confirm: ui.confirm,
      offers: () => api.ambossMyOffers().then((r) => r.offers),
      disableOffer: (id: string) => api.ambossToggleOffer(id, "DISABLED"),
      toast,
      pause: async () => {
        try {
          const next = await api.autopilotPause();
          setServer(next);
          toast(pausedToast(next.lspModeOn ?? false), "success");
          return true;
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return false;
        }
      },
    });
  };

  const resume = async () => {
    if (!paused) return;
    const { lines, sellingNote } = resumeLines(paused.was);
    const capital = paused.was.some((k) => k === "channelEnabled" || k === "rebalanceEnabled")
      ? " The channel autopilot and auto-rebalance spend on-chain funds and routing fees again, within their settings."
      : "";
    const ok = await ui.confirm({
      title: "Resume automation?",
      message: `${lines.length ? `Switches back on: ${lines.join(", ")}.` : "Nothing to switch back on."}${capital}${sellingNote ? ` ${sellingNote}` : ""}`,
      confirmLabel: "Resume",
    });
    if (!ok) return;
    try {
      const res = await api.autopilotResume();
      setServer(res.state);
      toast(res.resumed.length ? "Automation resumed" : "Pause ended", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  type BoolKey = "enabled" | "rebalanceEnabled" | "channelEnabled" | "sellEnabled" | "maxHtlcEnabled";
  /** A switch flipped: one that moves capital asks first when switched on
   *  (switchOnConfirm); off never asks. */
  const flip = async (field: BoolKey, v: boolean) => {
    const ask = v ? switchOnConfirm(field, config) : null;
    if (ask && !(await ui.confirm(ask))) return;
    void save({ [field]: v });
  };
  const toggleRow = (field: BoolKey, title: string, subtitle: string, onChange?: (v: boolean) => void) => (
    <div className="ap-master">
      <Switch
        checked={config[field]}
        disabled={busy || writeOff}
        onChange={(v) => (onChange ? onChange(v) : void flip(field, v))}
        label={title}
      />
      <div className="ap-master-text">
        <div className="ap-master-title">{title}</div>
        <div className="ap-master-sub">{subtitle}</div>
      </div>
      <RunState on={config[field]} blocked={writeOff ? "write mode is off — nothing can run" : undefined} />
    </div>
  );

  /**
   * selling is an explicit decision (D9): switching it on shows
   * whether this node can realistically sell (live, from Amboss's public
   * book — the dialog opens at once and the verdict follows); switching it
   * off while offers are still listed offers to disable them too — otherwise
   * their orders wait for a decision nobody makes, and time out against the
   * seller score. The decisions live in SellingSwitch.tsx.
   */
  const setSelling = async (on: boolean) => {
    const deps = {
      confirm: ui.confirm,
      eligibility: () => api.magmaEligibility(),
      offers: () => api.ambossMyOffers().then((r) => r.offers),
      offerSync: () => api.ambossOfferSync(),
      disableOffer: (id: string) => api.ambossToggleOffer(id, "DISABLED"),
      save,
      toast,
    };
    await (on ? turnSellingOn(deps) : turnSellingOff(deps));
  };

  // ── the draft's controls ──────────────────────────────────────────────────

  const setNum = (path: NumPath, text: string) => {
    const nums = { ...draft.nums };
    // Typed back to what is saved: nothing unsaved there any more.
    if (text.trim() !== "" && Number(text) === savedNum(config, path)) delete nums[path];
    else nums[path] = text;
    setDraft({ ...draft, nums });
  };
  const setFlag = (key: FlagKey, v: boolean) => {
    const flags = { ...draft.flags };
    if (v === config[key]) delete flags[key];
    else flags[key] = v;
    setDraft({ ...draft, flags });
  };
  const flagShown = (key: FlagKey): boolean => draft.flags[key] ?? config[key];

  /** A number field: its range under it (or what is wrong with it), and its
   *  explanation behind an (i) that works on a tap — not a hover tooltip. */
  const numInput = (path: NumPath, label: string, opts: { step?: number; hint?: string } = {}) => {
    const b = boundsFor(server.bounds, path);
    const text = draft.nums[path];
    const err = check.fieldErrors[path];
    const id = `ap-field-${path}`;
    return (
      <div key={path} className={`policy-field ${text !== undefined ? "changed" : ""}`}>
        <div className="pf-head">
          <label htmlFor={id}>{label}</label>
          {opts.hint ? <InfoTip text={opts.hint} label={`About ${label}`} /> : null}
        </div>
        <input
          id={id}
          type="number"
          min={b?.min}
          max={b?.max}
          step={opts.step ?? (b && !b.integer ? "any" : 1)}
          value={text ?? (savedNum(config, path) ?? "")}
          aria-invalid={err ? true : undefined}
          disabled={writeOff}
          onChange={(e) => setNum(path, e.target.value)}
        />
        {err ? <span className="field-error">{err}</span> : b ? <span className="field-hint">{rangeText(b)}</span> : null}
      </div>
    );
  };

  const budgetNoLimit = draft.noBudgetLimit ?? config.rebalanceDailyBudgetSats === null;
  const numFields = (fields: { key: NumKey; label: string; hint?: string }[]) =>
    fields.map((f) =>
      f.key === "rebalanceDailyBudgetSats" && budgetNoLimit ? (
        <div key={f.key} className="policy-field">
          <div className="pf-head">
            <label htmlFor={`ap-field-${f.key}`}>{f.label}</label>
          </div>
          <input id={`ap-field-${f.key}`} type="text" value="No limit" disabled />
        </div>
      ) : (
        numInput(f.key, f.label, { hint: f.hint })
      ),
    );

  /** Explicit "no cap" for the rebalance budget — 0 no longer means that. */
  const noBudgetLimit = (
    <label className="check ap-check">
      <input
        type="checkbox"
        checked={budgetNoLimit}
        disabled={busy || writeOff}
        onChange={(e) => {
          const on = e.target.checked;
          const nums = { ...draft.nums };
          const savedNoLimit = config.rebalanceDailyBudgetSats === null;
          if (on) delete nums.rebalanceDailyBudgetSats;
          // Unticked from "no limit": a limit to start from, to edit.
          else if (savedNoLimit && nums.rebalanceDailyBudgetSats === undefined) nums.rebalanceDailyBudgetSats = "10000";
          setDraft({ ...draft, nums, noBudgetLimit: on === savedNoLimit ? undefined : on });
        }}
      />
      No daily limit on rebalance fees
      <InfoTip label="About no daily limit" text="Each move must still pass the profit check." />
    </label>
  );

  const flagBox = (key: FlagKey, text: string, hint?: { label: string; text: string }) => (
    <label className="check ap-check">
      <input type="checkbox" checked={flagShown(key)} disabled={busy || writeOff} onChange={(e) => setFlag(key, e.target.checked)} />
      {text}
      {hint ? <InfoTip label={hint.label} text={hint.text} /> : null}
    </label>
  );

  // Selling's capital: everything free, or at most so much (the cap's top of
  // its range means no limit, as far as the setting goes).
  const capTop = boundsFor(server.bounds, "sellMaxDeploySats")?.max ?? 1_000_000_000;
  const shownCap = (() => {
    const text = draft.nums.sellMaxDeploySats;
    return text !== undefined && text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : (savedNum(config, "sellMaxDeploySats") ?? 0);
  })();
  const sellEverything = shownCap >= capTop;

  /** What is unsaved — on every sub-tab, so nothing is lost or saved unseen. */
  const unsavedBar = unsaved ? (
    <div className="ap-unsaved" role="region" aria-label="Unsaved settings">
      <span className="ap-unsaved-what">
        <strong>Unsaved changes:</strong>{" "}
        {check.changes.length ? check.changes.map((c) => (sellEverything && c.startsWith(LIMIT_LABELS.sellMaxDeploySats) ? "Capital to sell: everything free" : c)).join(", ") : "none left"}
      </span>
      <button className="primary-btn" disabled={busy || writeOff || check.errors.length > 0} onClick={() => void saveDraft()}>
        Save changes
      </button>
      <button className="reset" disabled={busy} onClick={() => setDraft(EMPTY_DRAFT)}>
        Discard
      </button>
      {check.errors.length ? (
        <ul className="ap-unsaved-errors">
          {check.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
    </div>
  ) : null;

  // The Strategy presets (presets.ts) — none of them touches Magma selling.
  const PRESETS = buildPresets(config);
  const matchesPreset = (p: AutopilotConfigPatch) => presetMatches(config, p);
  const allOff = allAutomationOff(config);
  const shownMax = (path: NumPath) => {
    const text = draft.nums[path];
    return text !== undefined && text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : (savedNum(config, path) ?? 0);
  };
  const feeDraftOpen = FEE_NUM_FIELDS.some((f) => draft.nums[f.key] !== undefined) || POLICY_FIELDS.some((f) => draft.nums[`policy.${f.key}`] !== undefined);

  // Each area's Advanced says how many of its settings differ from what the
  // strategy in force sets (or the factory's, with none), and can put them
  // back: as unsaved changes, so nothing moves before "Save changes".
  const activePreset = PRESETS.find((p) => matchesPreset(p.cfg));
  const baseline = baselineConfig(server.defaults, activePreset ? (buildPresets(server.defaults).find((p) => p.id === activePreset.id)?.cfg ?? null) : null);
  const ADVANCED: Record<"fees" | "rebalancing" | "channels" | "magma", AdvancedSet> = {
    fees: { paths: [...FEE_NUM_FIELDS.map((f) => f.key), ...POLICY_FIELDS.map((f): NumPath => `policy.${f.key}`)], flags: ["feeFloorAboveMax"] },
    rebalancing: {
      paths: [...REB_NUM_FIELDS.filter((f) => f.key !== "rebalanceDailyBudgetSats").map((f) => f.key), ...REB_POLICY_FIELDS.map((f): NumPath => `rebalancePolicy.${f.key}`)],
    },
    channels: { paths: CHANNEL_NUM_FIELDS.map((f) => f.key) },
    // The offer's four switches are in this fold: they count, and Reset puts
    // them back (ENG-4 — a mixed state showed nowhere but inside the fold).
    magma: { paths: SELL_NUM_FIELDS.map((f) => f.key), flags: OFFER_FLAGS, pricingMode: true },
  };
  /** An area's Advanced section: remembered open or closed, its changes counted. */
  const advanced = (area: keyof typeof ADVANCED, children: ReactNode, forceOpen = false) => {
    const set = ADVANCED[area];
    const changed = advancedChanged(set, draft, config, baseline);
    return (
      <Fold id={`ap-${area}`} title="Advanced" note={changed > 0 ? `${changed} changed` : undefined} className="ap-customize" forceOpen={forceOpen}>
        {children}
        {changed > 0 ? (
          <div className="ap-reset">
            <button className="reset" disabled={busy || writeOff} onClick={() => setDraft(resetToBaseline(set, draft, config, baseline))}>
              Reset to {activePreset ? `“${activePreset.label}”` : "defaults"}
            </button>
            <span className="muted small">Nothing changes until you save.</span>
          </div>
        ) : null}
      </Fold>
    );
  };

  // The areas: a switch, what it did last, and its details under the list.
  const AREAS: { id: Exclude<Sub, "history">; title: string; field: BoolKey; area: DecisionArea; help: string; onSwitch?: (v: boolean) => void }[] = [
    { id: "fees", title: "Fees", field: "enabled", area: "fees", help: "Applies the recommended fees automatically, on a schedule." },
    {
      id: "rebalancing",
      title: "Rebalancing",
      field: "rebalanceEnabled",
      area: "rebalance",
      help: "Runs the refills that pass the profit check, within the daily fee budget — on a small node with low fees, that is rarely.",
    },
    {
      id: "channels",
      title: "New channels",
      field: "channelEnabled",
      area: "channels",
      help: "Opens a channel to the best suggestion it can actually open — the peer's minimum size, earlier refusals, a recent close and on-chain fees checked — when on-chain funds allow.",
    },
    {
      id: "magma",
      title: "Selling (Magma)",
      field: "sellEnabled",
      area: "magma",
      help: "Sells inbound on Amboss Magma: accepts orders with a hold invoice, opens channels to buyers, rejects what it can't serve, within your limits. Amboss decides who gets orders.",
      onSwitch: (v) => void setSelling(v),
    },
  ];
  const areaRow = (a: (typeof AREAS)[number]) => {
    const view = areaStatusView(status?.[a.area]);
    const isOpen = sub === a.id;
    return (
      <div key={a.id} className={`ap-area ${isOpen ? "open" : ""}`}>
        <Switch checked={config[a.field]} disabled={busy || writeOff} onChange={(v) => (a.onSwitch ? a.onSwitch(v) : void flip(a.field, v))} label={a.title} />
        <button className="ap-area-name" aria-expanded={isOpen} onClick={() => setSub(isOpen ? null : a.id)}>
          <span className="ap-area-title">{a.title}</span>
          <span className={`ap-area-status t-${config[a.field] ? (view?.tone ?? "info") : "off"}`}>
            {config[a.field] ? (view ? shortStatus(view.text) : "Not run yet") : "Off"}
          </span>
        </button>
        <InfoTip text={a.help} label={`About ${a.title}`} />
        {/* (Open, the row's status line below has the button: one is enough.) */}
        {config[a.field] && !isOpen && status?.[a.area]?.needs === "amboss_key" ? <ConnectAmbossButton small /> : null}
        {writeOff && config[a.field] ? <RunState on blocked="write mode is off — nothing can run" /> : null}
        <span className="ap-area-caret" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
      </div>
    );
  };

  const freeSat = magma?.sell.deployableCapitalSat ?? null;
  /** The offer's four automations, as one choice — shown as it is (all,
   *  none, or some of them: autopilotForm.ts). */
  const offerManaged = offerManagedView(flagShown);

  return (
    <div className="ap-page">
      <div className="ap-strategy">
        <div className="ap-strategy-head">
          <span className="ap-strategy-title">Strategy</span>
          <InfoTip label="What the strategies do">
            {PRESETS.map((p) => (
              <span key={p.id} className="info-line">
                <strong>{p.label}:</strong> {p.desc}{" "}
              </span>
            ))}
            A strategy applies after you confirm what it changes.
          </InfoTip>
          {paused ? null : allOff ? (
            <span className="preset-off-chip">Autopilot off — no automation is switched on</span>
          ) : !PRESETS.some((p) => matchesPreset(p.cfg)) ? (
            <span className="preset-custom-chip">Custom settings</span>
          ) : null}
        </div>
        <div className="ap-preset-row">
          {PRESETS.map((p) => {
            const active = matchesPreset(p.cfg);
            return (
              <button key={p.id} className={`preset-opt ${active ? "active" : ""}`} disabled={busy || writeOff} onClick={() => void applyPreset(p)}>
                <span className="preset-opt-label">
                  {p.label}
                  {active ? <span className="preset-opt-badge">✓</span> : null}
                </span>
              </button>
            );
          })}
        </div>
        {paused ? (
          <div className="ap-paused">
            ⏸ All automation paused {timeAgo(paused.at)} — {pausedText(lspModeOn)}. Magma orders already taken on are still
            carried to their end.{" "}
            {lspModeOn ? (
              <>
                <SettingsLink section="lsp">LSP mode in Settings</SettingsLink>{" "}
              </>
            ) : null}
            <button className="primary-btn" disabled={busy || writeOff} onClick={() => void resume()}>
              Resume
            </button>
          </div>
        ) : null}
      </div>

      {writeOff ? (
        <div className="dryrun-banner">
          Read-only: the autopilot needs <strong>write access</strong> to apply anything. Set
          <code> LM_ENABLE_WRITE=true</code> with an admin macaroon — on Umbrel it's auto-discovered.
        </div>
      ) : null}
      {error ? <p className="banner error">{error}</p> : null}
      {loadError ? <p className="banner error">Couldn't refresh the autopilot's state ({loadError}) — what you see may be out of date.</p> : null}
      {(() => {
        // A main run that takes far longer than usual is stuck on something
        // (a payment, a call to the node): say so, on every tab.
        const run = runProgress(server.runningSince, Date.now());
        return run?.stuck ? <p className="banner error">{run.text}</p> : null;
      })()}

      <div className="ap-areas">
        {AREAS.map(areaRow)}
        <div className={`ap-area ${sub === "history" ? "open" : ""}`}>
          <button className="ap-area-name" aria-expanded={sub === "history"} onClick={() => setSub(sub === "history" ? null : "history")}>
            <span className="ap-area-title">History</span>
            <span className="ap-area-status">{server.lastRunAt ? `Last run ${timeAgo(server.lastRunAt)}` : "Never run"}</span>
          </button>
          <span className="ap-area-caret" aria-hidden="true">{sub === "history" ? "▾" : "▸"}</span>
        </div>
      </div>
      {paused || allOff ? null : (
        <div className="ap-pause-inline">
          <button className="reset" disabled={busy || writeOff} onClick={() => void pauseAll()}>
            ⏸ Pause all
          </button>
          <InfoTip text={pauseHint(lspModeOn)} label="About pausing" />
        </div>
      )}

      {sub !== null && sub !== "magma" && sub !== "rebalancing" ? null : (
      <section className="panel ap-limits">
        <h3 className="sub">Limits</h3>
        <div className="policy-controls">
          <div className="ap-capital">
            <span className="ap-capital-title">
              Capital to sell
              <InfoTip label="About the capital to sell">{DEPLOY_CAP_HINT}</InfoTip>
            </span>
            <label>
              <input
                type="radio"
                name="ap-capital"
                checked={sellEverything}
                disabled={busy || writeOff}
                onChange={() => setNum("sellMaxDeploySats", String(capTop))}
              />
              Everything free{freeSat !== null ? ` (${satsCompact(freeSat)} now)` : ""}
            </label>
            <label>
              <input
                type="radio"
                name="ap-capital"
                checked={!sellEverything}
                disabled={busy || writeOff}
                onChange={() => setNum("sellMaxDeploySats", "10000000")}
              />
              At most
            </label>
            {sellEverything ? null : numInput("sellMaxDeploySats", "sat", {})}
            {afterLeaseLine(server.sellAfterLease, sellEverything) ? <p className="muted ap-hint">{afterLeaseLine(server.sellAfterLease, sellEverything)}</p> : null}
          </div>
          {numInput("sellReserveSats", "Keep on chain (sat)")}
          {numFields(REB_NUM_FIELDS.filter((f) => f.key === "rebalanceDailyBudgetSats"))}
        </div>
        <div className="ap-checks">{noBudgetLimit}</div>
        {sub === null ? unsavedBar : null}
      </section>
      )}

      {sub === "fees" ? (
        <>
          <StatusLine area="fees" status={status?.fees} />
          {config.maxHtlcEnabled ? <StatusLine area="maxHtlc" status={status?.maxHtlc} /> : null}
          {advanced(
            "fees",
            <>
              {toggleRow(
                "maxHtlcEnabled",
                "Advertise routable size",
                "Keeps each channel's max HTLC just under its spendable balance, so fewer forwards fail through you.",
              )}
              <div className="policy-controls">
                {numFields(FEE_NUM_FIELDS)}
                {POLICY_FIELDS.map((f) => numInput(`policy.${f.key}`, f.label, { hint: f.hint }))}
              </div>
              <p className="muted ap-hint">
                How far one update moves a fee
                <InfoTip label="How far one update moves a fee">{FEE_MOVE_HINT}</InfoTip>
              </p>
              <div className="ap-checks">
                {flagBox("feeFloorAboveMax", "Let a channel’s refill cost (profit floor) lift its fee above Max ppm — off: the floor stops at Max ppm")}
              </div>
            </>,
            feeDraftOpen,
          )}
          {unsavedBar}
          <FeeRecommendations />
        </>
      ) : sub === "rebalancing" ? (
        <>
          <StatusLine area="rebalance" status={status?.rebalance} />
          {budgetLine(server.rebalanceBudget) ? <p className="muted ap-hint">{budgetLine(server.rebalanceBudget)}</p> : null}
          {advanced(
            "rebalancing",
            <>
              <div className="policy-controls">
                {numFields(REB_NUM_FIELDS.filter((f) => f.key !== "rebalanceDailyBudgetSats"))}
                {REB_POLICY_FIELDS.map((f) => numInput(`rebalancePolicy.${f.key}`, f.label, { step: f.step, hint: f.hint }))}
              </div>
              <p className="muted ap-hint">
                When a refill runs
                <InfoTip label="When a refill runs">
                  A refill runs only when its route costs at most your share of what the refilled sats are expected to earn,
                  it nets at least the minimum, and pays back in time — its payment can't pay more than that, nor more than is
                  left of today's budget. The hours and the budget's day are UTC. {REMOVED_SETTINGS_NOTE}
                </InfoTip>
              </p>
            </>,
          )}
          {unsavedBar}
          <RebalanceRecommendations />
        </>
      ) : sub === "channels" ? (
        <>
          <StatusLine area="channels" status={status?.channels} />
          {advanced(
            "channels",
            <>
              <div className="policy-controls">{numFields(CHANNEL_NUM_FIELDS)}</div>
              <p className="muted ap-hint">
                How it decides
                <InfoTip label="How the channel autopilot decides" text={CHANNEL_OPEN_HINT} />
              </p>
            </>,
          )}
          {unsavedBar}
          <p className="muted ap-hint">
            The peers it would open to, and opening one by hand:{" "}
            <button className="linklike" onClick={() => goTo("channels", "open")}>
              Channels → To open
            </button>
          </p>
        </>
      ) : sub === "magma" ? (
        <section className="panel">
          <StatusLine area="magma" status={status?.magma} />
          {server.magmaLane?.lastTickAt ? (
            <p className="muted ap-hint">
              Order lane: checked {timeAgo(server.magmaLane.lastTickAt)}
              {server.magmaLane.ok === false ? ` — ${server.magmaLane.error ?? "failed"}` : server.magmaLane.idle ? ` — ${server.magmaLane.idle}` : ""}
            </p>
          ) : null}
          <SellDiagnosticsCard d={diag} onFix={(tab, s) => goTo(tab, s)} />
          <p className="muted ap-hint">
            Your offer, its price and your orders:{" "}
            <button className="linklike" onClick={() => goTo("market", "sell")}>
              Market → Sell
            </button>
          </p>
          <div className="ap-checks">
            <label className="check ap-check">
              <input
                type="checkbox"
                checked={offerManaged.state === "all"}
                aria-checked={offerManaged.state === "partly" ? "mixed" : offerManaged.state === "all"}
                ref={(el) => {
                  if (el) el.indeterminate = offerManaged.state === "partly";
                }}
                disabled={busy || writeOff}
                onChange={() => setDraft(toggleOfferManaged(draft, config))}
              />
              The autopilot manages my offer: price, size and listing, and closes a sold channel after its lease
              <InfoTip label="What managing the offer means" text={OFFER_AUTOMATION_HINT} />
            </label>
            {offerManaged.text ? <p className="muted ap-hint ap-offer-partly">{offerManaged.text}</p> : null}
          </div>
          {advanced(
            "magma",
            <div className="ap-customize-body">
              <h3 className="sub">
                Offer pricing
                <InfoTip label="About offer pricing">
                  With auto-pricing on, your enabled offer is priced from what buyers actually paid for comparable leases, at the level
                  below — not below your profit floor, which is worked out for a typical order of your offer; with auto-size on, the smallest
                  order the offer takes is kept large enough to pay for its channel as well. (Price is not what gets a seller picked; it
                  decides what a sale earns.)
                </InfoTip>
              </h3>
              <div className="mode-select">
                {PRICING_MODES.map(({ id, label, desc }) => {
                  const shown = (draft.pricingMode ?? config.sellPricingMode) === id;
                  return (
                    <button
                      key={id}
                      className={`mode-opt ${shown ? "active" : ""}`}
                      aria-pressed={shown}
                      disabled={busy || writeOff}
                      onClick={() => setDraft({ ...draft, pricingMode: id === config.sellPricingMode ? undefined : id })}
                    >
                      <span className="mode-opt-label">{label}</span>
                      <span className="mode-opt-desc">{desc}</span>
                    </button>
                  );
                })}
              </div>
              <h3 className="sub">Automation</h3>
              <div className="ap-checks">
                {flagBox("sellAutoReprice", "Auto-price the enabled offer from what buyers actually paid (at the level above, not below your profit floor for a typical order)")}
                {flagBox(
                  "sellAutoSize",
                  "Auto-size the offer: a lease buyers use (30 days, or the 60, 90 or 180 days you set), the routing-fee promise, and a window from the smallest channel that pays for itself up to what can be funded",
                )}
                {flagBox("sellAutoRelist", "Auto-relist: list what is free, up to your capital to sell, and top up after a sale")}
                {flagBox("sellAutoClose", "Auto-close channels after the lease ends (reclaim the capital on-chain)", {
                  label: "When a sold channel is closed, and when it is kept",
                  text: AUTO_CLOSE_HINT,
                })}
              </div>
              <h3 className="sub">
                Largest order
                <InfoTip label="About the limits">
                  Orders above your limits are rejected at once, with the reason on Market → Orders — never left to time out. Raising them
                  doesn't make Amboss send orders: it only lets the node serve bigger ones.
                </InfoTip>
              </h3>
              <div className="policy-controls">{numFields(SELL_NUM_FIELDS)}</div>
            </div>,
          )}
          {magma?.sell.capitalLimited ? (
            <div className="ap-reach">
              Right now only {satsCompact(magma.sell.effectiveMaxOrderSat)} can be funded on-chain (after the reserve and the coins
              promised to other orders) — a capital limit, not a settings one.
            </div>
          ) : null}
          {shownMax("sellMaxChannelSats") > shownMax("sellMaxDeploySats") ? (
            <div className="sug-warn">
              ⚠ Max channel size ({satsCompact(shownMax("sellMaxChannelSats"))}) is above your capital cap (
              {satsCompact(shownMax("sellMaxDeploySats"))}), so an order that big can never be served. The smaller number is what
              actually applies.
            </div>
          ) : null}
          {unsavedBar}
        </section>
      ) : sub === "history" ? (
        <section className="panel">
          <div className="apply-row">
            <button className="reset" disabled={busy || !!server.runningSince || writeOff} onClick={runNow}>
              Run once now
            </button>
            <span className="muted">{server.lastRunAt ? `last run ${timeAgo(server.lastRunAt)}` : "never run"}</span>
            {(() => {
              const run = runProgress(server.runningSince, Date.now());
              return run && !run.stuck ? <span className="muted">· {run.text}</span> : null;
            })()}
          </div>
          {lastRun ? <p className="muted">{runResultLine(lastRun)}</p> : null}

          <h3 className="sub">What each area decided last</h3>
          <div className="ap-status-list">
            {(["fees", "rebalance", "channels", "magma", "maxHtlc"] as DecisionArea[]).map((a) => (
              <StatusLine key={a} area={a} status={status?.[a]} />
            ))}
          </div>
          {unsavedBar}

          <h3 className="sub">History</h3>
          <p className="muted ap-hint">What the autopilot changed — waits and deferrals are in each area's decision above, not here.</p>
          {server.history.length === 0 ? (
            <p className="muted empty">No changes yet.</p>
          ) : (
            <ul className="ap-history">
              {server.history.map((run, i) => {
                const items: { ok: boolean; pending?: boolean; label: string; why?: string; error?: string; channelId?: string; alias?: string }[] = [
                  ...(run.changes ?? []).map((c) => ({
                    ok: c.ok,
                    channelId: c.id,
                    alias: c.alias,
                    // Every change says why (the engine's reason, a lease
                    // promise kept, or by hand).
                    label: historyFeeLine(c),
                    why: [c.why, c.clampedBy].filter(Boolean).join(" · ") || undefined,
                    error: c.error,
                  })),
                  ...(run.rebalances ?? []).map((r) => ({
                    ok: r.ok,
                    alias: r.alias,
                    // Still in flight: not a failure (yet) — amber, not a red ✗.
                    pending: r.inFlight,
                    label: `Rebalance · ${r.alias}${r.ok ? ` — ${r.feeSats} sat` : r.inFlight ? " — still in flight" : ""}`,
                    error: r.error,
                  })),
                  ...(run.channels ?? []).map((c) => ({ ok: c.ok, alias: c.alias, label: `Open · ${c.alias}${c.ok ? ` — ${satsCompact(c.sizeSats)}` : ""}`, error: c.error })),
                  ...(run.sells ?? []).map((s) => ({ ok: s.ok, label: `Magma ${s.action} · ${satsCompact(s.sizeSats)}`, error: s.error })),
                  ...(run.maxHtlc ?? []).map((m) => ({
                    ok: m.ok,
                    channelId: m.id,
                    alias: m.alias,
                    label: `Routable size · ${m.alias}: ${m.fromSat != null ? satsCompact(m.fromSat) : "—"}→${satsCompact(m.toSat)}`,
                    error: m.error,
                  })),
                  // A stage that threw (the others still ran).
                  ...(run.errors ?? []).map((e) => ({ ok: false, label: `${e.stage} stage failed`, error: e.error })),
                ];
                // The same changes run after run: one line, counted.
                const repeated = repeatsNote(run.repeats, run.firstAt ? timeAgo(run.firstAt) : null);
                const late = lateStageNote(run.lateStage);
                return (
                  <li key={`${run.at}-${i}`}>
                    <div className="ap-run-head">
                      <span>
                        {timeAgo(run.at)}
                        {repeated ? <span className="muted"> · {repeated}</span> : null}
                        {late ? <span className="muted"> · {late}</span> : null}
                      </span>
                      <span className="muted">
                        {run.applied} applied
                        {run.failed ? <span className="ap-fail-count"> · {run.failed} failed</span> : null}
                      </span>
                    </div>
                    {items.length ? (
                      <div className="ap-run-items">
                        {items.map((it, j) => {
                          const key = `${run.at}:${j}`;
                          const expandable = !it.ok && !!it.error;
                          const isOpen = openItems.has(key);
                          const mark = it.ok ? "✓" : it.pending ? "⋯" : "✗";
                          return (
                            <div key={j} className="ap-line">
                              {expandable ? (
                                <button className="ap-line-btn" aria-expanded={isOpen} onClick={() => toggleItem(key)}>
                                  <span className="ap-caret">{isOpen ? "▾" : "▸"}</span>
                                  {mark} {it.label}
                                </button>
                              ) : (
                                <span className={it.ok ? "ap-line-ok" : it.pending ? "ap-line-wait" : "ap-line-fail"}>
                                  {mark} <NodeLink channelId={it.channelId} alias={it.alias}>{it.label}</NodeLink>
                                </span>
                              )}
                              {it.why ? <div className="muted small ap-why">{it.why}</div> : null}
                              {expandable && isOpen ? <div className="ap-err-msg">{it.error}</div> : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
