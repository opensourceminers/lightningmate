import { useEffect, useState } from "react";
import { api } from "../api";
import type { AreaStatus, AutopilotConfigPatch, AutopilotRun, AutopilotState, DecisionArea, MagmaV2Report, SellDiagnostics } from "../types";
import { satsCompact, timeAgo } from "../format";
import { rangeText } from "../numField";
import { lateStageNote, repeatsNote, runProgress } from "../statusNotes";
import { buildPresets, matchesPreset as presetMatches, type Preset } from "../presets";
import { NEUTRAL_PPM_HINT, historyFeeLine } from "../feeView";
import { OFFER_AUTOMATION_HINT, PRICING_MODES } from "../magmaView";
import { REBALANCE_POLICY_FIELDS, REMOVED_SETTINGS_NOTE, budgetLine } from "../rebalanceView";
import {
  AREA_LABEL,
  allAutomationOff,
  areaStatusView,
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
  boundsFor,
  checkDraft,
  draftIsEmpty,
  draftStore,
  savedNum,
  switchOnConfirm,
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
  "long too, and longer by its own rule: a raise 72 h after the last update, the demand ramp 6 h, a lowering 24 h.";
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
  { key: "rebalanceDailyBudgetSats", label: "Daily fee budget (sat, manual runs included)" },
  { key: "rebalanceCooldownMinutes", label: "Rebalance cooldown (min)" },
  { key: "rebalanceHourStart", label: "Run from hour (UTC, 0–24)", hint: REBALANCE_WINDOW_HINT },
  { key: "rebalanceHourEnd", label: "Run to hour (UTC, 0–24)", hint: REBALANCE_WINDOW_HINT },
];
// Every rebalance setting shown binds the profit gate (rebalanceView.ts).
const REB_POLICY_FIELDS = REBALANCE_POLICY_FIELDS;
const CHANNEL_NUM_FIELDS: { key: NumKey; label: string }[] = [
  { key: "channelSizeSats", label: "Channel size (sat, 0=auto)" },
  { key: "channelReserveSats", label: "Keep on-chain reserve (sat)" },
  { key: "channelCooldownMinutes", label: "Open cooldown (min)" },
  { key: "channelMaxFeeRate", label: "Max on-chain fee for opens (sat/vB)" },
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
  "With Liquidity provision on, the coins your Magma offer can list (within your deploy cap) wait for Magma while selling " +
  "them is expected to earn more than a routing channel; the rest stays free for routing opens, and the note says how much " +
  "is held. The reserve is what an open leaves on chain — LND's own anchor reserve (10,000 sat per anchor channel, up to " +
  "100,000) wins when it is larger, and the open's fee comes on top. " +
  "When the open fails on this node's side — LND's wallet not synced or short of confirmed coins, or no connection to any " +
  "peer — no peer is held back for it, and the next run tries again. A peer's refusal before anything is broadcast moves " +
  "on to the next suggestion; an open that ends unclearly (also one cut off by a restart) starts the cooldown, as an open does.";

const SELL_NUM_FIELDS: { key: NumKey; label: string }[] = [
  { key: "sellMaxDeploySats", label: "Max capital deployed (sat)" },
  { key: "sellMaxChannelSats", label: "Max channel size / order (sat)" },
  { key: "sellReserveSats", label: "Keep on-chain reserve (sat)" },
];

const SUBS: Sub[] = ["fees", "rebalancing", "channels", "magma", "history"];

/** Field labels by edit path, for validation messages. */
const LABELS: Partial<Record<string, string>> = Object.fromEntries([
  ...[...FEE_NUM_FIELDS, ...REB_NUM_FIELDS, ...CHANNEL_NUM_FIELDS, ...SELL_NUM_FIELDS].map((f) => [f.key, f.label]),
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
      <p className="modal-msg muted">Liquidity provision (Magma selling) is never changed by a preset.</p>
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
  const [sub, setSub] = useState<Sub>(initialSub && (SUBS as string[]).includes(initialSub) ? (initialSub as Sub) : "fees");
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
   * Liquidity provision is an explicit decision (D9): switching it on shows
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
  const flagShown = (key: FlagKey) => draft.flags[key] ?? config[key];

  /** A number field: its range under it (or what is wrong with it), and its
   *  explanation behind an (i) that works on a tap — not a hover tooltip. */
  const numInput = (path: NumPath, label: string, opts: { step?: number; hint?: string } = {}) => {
    const b = boundsFor(server.bounds, path);
    const text = draft.nums[path];
    const err = check.fieldErrors[path];
    return (
      <div key={path} className={`policy-field ${text !== undefined ? "changed" : ""}`}>
        <label>
          <span>{label}</span>
          <input
            type="number"
            min={b?.min}
            max={b?.max}
            step={opts.step ?? (b && !b.integer ? "any" : 1)}
            value={text ?? (savedNum(config, path) ?? "")}
            aria-invalid={err ? true : undefined}
            disabled={writeOff}
            onChange={(e) => setNum(path, e.target.value)}
          />
        </label>
        {opts.hint ? <InfoTip text={opts.hint} label={`About ${label}`} /> : null}
        {err ? <span className="field-error">{err}</span> : b ? <span className="field-hint">{rangeText(b)}</span> : null}
      </div>
    );
  };

  const budgetNoLimit = draft.noBudgetLimit ?? config.rebalanceDailyBudgetSats === null;
  const numFields = (fields: { key: NumKey; label: string; hint?: string }[]) =>
    fields.map((f) =>
      f.key === "rebalanceDailyBudgetSats" && budgetNoLimit ? (
        <div key={f.key} className="policy-field">
          <label>
            <span>{f.label}</span>
            <input type="text" value="No limit" disabled />
          </label>
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
      No daily limit on rebalance fees (each move must still pass the profit check)
    </label>
  );

  const flagBox = (key: FlagKey, text: string) => (
    <label className="check ap-check">
      <input type="checkbox" checked={flagShown(key)} disabled={busy || writeOff} onChange={(e) => setFlag(key, e.target.checked)} />
      {text}
    </label>
  );

  /** What is unsaved — on every sub-tab, so nothing is lost or saved unseen. */
  const unsavedBar = unsaved ? (
    <div className="ap-unsaved" role="region" aria-label="Unsaved settings">
      <span className="ap-unsaved-what">
        <strong>Unsaved changes:</strong> {check.changes.length ? check.changes.join(", ") : "none left"}
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

  const TABS: { id: Sub; label: string }[] = [
    { id: "fees", label: "Fees" },
    { id: "rebalancing", label: "Rebalancing" },
    { id: "channels", label: "Channels" },
    { id: "magma", label: "Magma" },
    { id: "history", label: "History" },
  ];

  // The Strategy presets (presets.ts) — none of them touches Magma selling.
  const PRESETS = buildPresets(config);
  const matchesPreset = (p: AutopilotConfigPatch) => presetMatches(config, p);
  const allOff = allAutomationOff(config);
  const shownMax = (path: NumPath) => {
    const text = draft.nums[path];
    return text !== undefined && text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : (savedNum(config, path) ?? 0);
  };
  const feeDraftOpen = FEE_NUM_FIELDS.some((f) => draft.nums[f.key] !== undefined) || POLICY_FIELDS.some((f) => draft.nums[`policy.${f.key}`] !== undefined);

  return (
    <div>
      <div className="ap-strategy">
        <div className="ap-strategy-head">
          <span className="ap-strategy-title">Strategy</span>
          <span className="muted">applies after you confirm what it changes</span>
          {paused ? null : allOff ? (
            <span className="preset-off-chip">Autopilot off — no automation is switched on</span>
          ) : !PRESETS.some((p) => matchesPreset(p.cfg)) ? (
            <span className="preset-custom-chip">Custom settings</span>
          ) : null}
        </div>
        <div className="ap-preset-grid">
          {PRESETS.map((p) => {
            const active = matchesPreset(p.cfg);
            return (
              <button key={p.id} className={`preset-opt ${active ? "active" : ""}`} disabled={busy || writeOff} onClick={() => void applyPreset(p)}>
                <span className="preset-opt-label">
                  {p.label}
                  {active ? <span className="preset-opt-badge">✓ active</span> : null}
                </span>
                <span className="preset-opt-desc">{p.desc}</span>
              </button>
            );
          })}
        </div>
        {paused ? (
          <div className="ap-paused">
            ⏸ All automation paused {timeAgo(paused.at)} — {pausedText(lspModeOn)}. Magma orders already taken on are still
            carried to their end.{" "}
            <button className="primary-btn" disabled={busy || writeOff} onClick={() => void resume()}>
              Resume
            </button>
          </div>
        ) : !allOff ? (
          <div className="ap-pause-row">
            <button className="reset" disabled={busy || writeOff} onClick={() => void pauseAll()}>
              ⏸ Pause all automation
            </button>
            <span className="muted">{pauseHint(lspModeOn)}</span>
          </div>
        ) : null}
      </div>

      <div className="subnav">
        {TABS.map((t) => (
          <button key={t.id} className={`subtab ${sub === t.id ? "active" : ""}`} onClick={() => setSub(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {writeOff ? (
        <div className="dryrun-banner">
          The autopilot needs <strong>write access</strong> to apply anything (it's off by default). Set
          <code> LM_ENABLE_WRITE=true</code> with an admin macaroon — on Umbrel it's auto-discovered. The
          recommendations below are read-only until then.
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

      {sub === "fees" ? (
        <>
          <StatusLine area="fees" status={status?.fees} />
          {config.maxHtlcEnabled ? <StatusLine area="maxHtlc" status={status?.maxHtlc} /> : null}
          {toggleRow("enabled", "Fee automation", "Apply the recommended fees below automatically, on a schedule")}
          {toggleRow(
            "maxHtlcEnabled",
            "Advertise routable size",
            "Keep each channel's max HTLC just under its spendable balance (rounded to powers of two) — senders skip depleted channels, so fewer forwards fail through you",
          )}
          <details className="ap-customize" open={feeDraftOpen || undefined}>
            <summary>Customize fee policy</summary>
            <div className="policy-controls">
              {numFields(FEE_NUM_FIELDS)}
              {POLICY_FIELDS.map((f) => numInput(`policy.${f.key}`, f.label, { hint: f.hint }))}
            </div>
            <p className="muted ap-hint">
              Each update moves a fee by at most two “Round to” steps up (up to three where a learned elasticity says
              raising pays; four while protecting a drained channel or recovering a refill’s cost; a quarter of the fee,
              at most every 6 h, for a drained channel that sold three times at its fee — the demand ramp) and at most the
              idle-ratchet’s steps down. A fee is raised only when the channel drains below its target, its flow says
              it drains, or a floor or Min ppm needs it — a channel that routes at its price keeps it — and an ordinary
              raise waits for a sale at the fee it charges now; a raise nothing sold at for 48 h goes back to the last
              price that sold. In one update
              only: an idle channel dropping to the price that last won it flow or to the market’s price into its
              peer, a pinned fee, a new channel’s protected fee, a broken lease promise, and a fee outside Min/Max ppm
              (a fee below Min goes to Min first, then steps). “Min change” only skips fees already that close to
              where the engine is heading — never an idle channel’s step or jump down, nor a fee brought into Min/Max.
            </p>
            <div className="ap-checks">
              {flagBox("feeFloorAboveMax", "Let a channel’s refill cost (profit floor) lift its fee above Max ppm — off: the floor stops at Max ppm")}
            </div>
          </details>
          {unsavedBar}
          <FeeRecommendations />
        </>
      ) : sub === "rebalancing" ? (
        <>
          <StatusLine area="rebalance" status={status?.rebalance} />
          {toggleRow(
            "rebalanceEnabled",
            "Auto-rebalance",
            "Run the refills below that pass the profit check, within the daily fee budget — on a small node with low fees, that is rarely",
          )}
          {budgetLine(server.rebalanceBudget) ? <p className="muted ap-hint">{budgetLine(server.rebalanceBudget)}</p> : null}
          <details className="ap-customize">
            <summary>Customize rebalance policy</summary>
            <div className="policy-controls">
              {numFields(REB_NUM_FIELDS)}
              {REB_POLICY_FIELDS.map((f) => numInput(`rebalancePolicy.${f.key}`, f.label, { step: f.step, hint: f.hint }))}
            </div>
            <div className="ap-checks">{noBudgetLimit}</div>
            <p className="muted ap-hint">
              A refill runs only when its route costs at most your share of what the refilled sats are expected to earn,
              it nets at least the minimum, and pays back in time — its payment can't pay more than that, nor more than is
              left of today's budget. The hours and the budget's day are UTC. {REMOVED_SETTINGS_NOTE}
            </p>
          </details>
          {unsavedBar}
          <RebalanceRecommendations />
        </>
      ) : sub === "channels" ? (
        <>
          <StatusLine area="channels" status={status?.channels} />
          {toggleRow(
            "channelEnabled",
            "Channel autopilot",
            "Opens a channel to the best suggestion it can actually open — the peer's minimum size, earlier refusals, a recent close and on-chain fees checked — when on-chain funds allow",
          )}
          <details className="ap-customize">
            <summary>Customize channel policy</summary>
            <div className="policy-controls">{numFields(CHANNEL_NUM_FIELDS)}</div>
            <p className="muted ap-hint">{CHANNEL_OPEN_HINT}</p>
          </details>
          {unsavedBar}
          <p className="muted ap-hint">
            The peers it would open to — and opening one by hand — are on{" "}
            <button className="linklike" onClick={() => goTo("channels", "open")}>
              Channels → To open
            </button>
            , next to closing.
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
          {toggleRow(
            "sellEnabled",
            "Liquidity provision (Magma)",
            "Advanced: sells inbound on Amboss Magma — accepts orders with a hold invoice, opens channels to buyers, rejects what it can't serve, within your caps. Amboss decides who gets orders.",
            (v) => void setSelling(v),
          )}

          <h3 className="sub">Offer pricing</h3>
          <p className="muted ap-hint">
            With auto-pricing on, your enabled offer is priced from what buyers actually paid for comparable leases, at the level
            below — never below your profit floor. (Price is not what gets a seller picked; it decides what a sale earns.)
          </p>
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
            {flagBox("sellAutoReprice", "Auto-price the enabled offer from what buyers actually paid (at the level above, floor-protected)")}
            {flagBox(
              "sellAutoSize",
              "Auto-size the offer: the standard 30-day lease, the routing-fee promise, and a window from the smallest channel that pays for itself up to what can be funded",
            )}
            {flagBox("sellAutoRelist", "Auto-relist a depleted offer (top it back up within your caps)")}
            {flagBox("sellAutoClose", "Auto-close channels after the lease ends (reclaim the capital on-chain)")}
          </div>
          <p className="muted ap-hint">{OFFER_AUTOMATION_HINT}</p>

          <h3 className="sub">Caps</h3>
          <p className="muted ap-hint">
            The most capital the autopilot may sell, the largest channel per order, and the on-chain reserve it never touches.
            Orders above these are rejected at once, with the reason on Market → Orders — never left to time out. Raising them
            doesn't make Amboss send orders: it only lets the node serve bigger ones.
          </p>
          <div className="policy-controls">{numFields(SELL_NUM_FIELDS)}</div>
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
      ) : (
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
                const items: { ok: boolean; pending?: boolean; label: string; why?: string; error?: string }[] = [
                  ...(run.changes ?? []).map((c) => ({
                    ok: c.ok,
                    // Every change says why (the engine's reason, a lease
                    // promise kept, or by hand).
                    label: historyFeeLine(c),
                    why: [c.why, c.clampedBy].filter(Boolean).join(" · ") || undefined,
                    error: c.error,
                  })),
                  ...(run.rebalances ?? []).map((r) => ({
                    ok: r.ok,
                    // Still in flight: not a failure (yet) — amber, not a red ✗.
                    pending: r.inFlight,
                    label: `Rebalance · ${r.alias}${r.ok ? ` — ${r.feeSats} sat` : r.inFlight ? " — still in flight" : ""}`,
                    error: r.error,
                  })),
                  ...(run.channels ?? []).map((c) => ({ ok: c.ok, label: `Open · ${c.alias}${c.ok ? ` — ${satsCompact(c.sizeSats)}` : ""}`, error: c.error })),
                  ...(run.sells ?? []).map((s) => ({ ok: s.ok, label: `Magma ${s.action} · ${satsCompact(s.sizeSats)}`, error: s.error })),
                  ...(run.maxHtlc ?? []).map((m) => ({
                    ok: m.ok,
                    label: `Max HTLC · ${m.alias}: ${m.fromSat != null ? satsCompact(m.fromSat) : "—"}→${satsCompact(m.toSat)}`,
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
                                  {mark} {it.label}
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
      )}
    </div>
  );
}
