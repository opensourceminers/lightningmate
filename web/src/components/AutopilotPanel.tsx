import { useEffect, useState } from "react";
import { api } from "../api";
import type {
  AutopilotConfig,
  AutopilotConfigPatch,
  AutopilotRun,
  AutopilotState,
  FeePolicy,
  MagmaV2Report,
  NumberBounds,
  SellDiagnostics,
} from "../types";
import { satsCompact, timeAgo } from "../format";
import { parseNumField } from "../numField";
import { runProgress } from "../statusNotes";
import { buildPresets, matchesPreset as presetMatches } from "../presets";
import { OFFER_AUTOMATION_HINT, PRICING_MODES } from "../magmaView";
import { RunState, Switch } from "./Switch";
import { useUi } from "./Overlay";
import { goTo } from "../nav";
import { SellDiagnosticsCard } from "./MagmaSellInfo";
import { turnSellingOff, turnSellingOn } from "./SellingSwitch";
import { FeeRecommendations } from "./FeeRecommendations";
import { RebalanceRecommendations } from "./RebalanceRecommendations";
import { SuggestionsPanel } from "./SuggestionsPanel";

type Sub = "fees" | "rebalancing" | "channels" | "magma" | "history";
type NumKey =
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
  | "sellMaxDeploySats"
  | "sellReserveSats"
  | "sellMaxChannelSats";
type RebKey = "econRatio" | "amountSats" | "maxLocalRatioTarget" | "minLocalRatioSource";

const FEE_NUM_FIELDS: { key: NumKey; label: string }[] = [
  { key: "intervalMinutes", label: "Run every (min)" },
  { key: "cooldownMinutes", label: "Fee cooldown (min)" },
  { key: "maxChangesPerRun", label: "Max fee changes / run" },
];
const POLICY_FIELDS: { key: keyof AutopilotConfig["policy"]; label: string }[] = [
  { key: "minPpm", label: "Min ppm (full)" },
  { key: "neutralPpm", label: "Neutral ppm (balanced)" },
  { key: "maxPpm", label: "Max ppm (drained)" },
  { key: "protectPpm", label: "Protect ppm (drained+wanted)" },
  { key: "baseFeeMsat", label: "Base fee (msat)" },
  { key: "step", label: "Round to" },
  { key: "minChangePpm", label: "Min change" },
];
const REB_NUM_FIELDS: { key: NumKey; label: string }[] = [
  { key: "maxRebalancesPerRun", label: "Max rebalances / run" },
  { key: "rebalanceDailyBudgetSats", label: "Daily fee budget (sat)" },
  { key: "rebalanceCooldownMinutes", label: "Rebalance cooldown (min)" },
  { key: "rebalanceHourStart", label: "Run from hour (0–24)" },
  { key: "rebalanceHourEnd", label: "Run to hour (0–24)" },
];
const REB_POLICY_FIELDS: { key: RebKey; label: string; step: number }[] = [
  { key: "econRatio", label: "Econ ratio", step: 0.05 },
  { key: "amountSats", label: "Amount (sat)", step: 10_000 },
  { key: "maxLocalRatioTarget", label: "Target ≤ local", step: 0.05 },
  { key: "minLocalRatioSource", label: "Source ≥ local", step: 0.05 },
];
const CHANNEL_NUM_FIELDS: { key: NumKey; label: string }[] = [
  { key: "channelSizeSats", label: "Channel size (sat, 0=auto)" },
  { key: "channelReserveSats", label: "Keep on-chain reserve (sat)" },
  { key: "channelCooldownMinutes", label: "Open cooldown (min)" },
];
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

/** Numeric edits are keyed by path: "intervalMinutes", "policy.minPpm", … */
type NumPath = NumKey | `policy.${keyof FeePolicy}` | `rebalancePolicy.${RebKey}`;

function boundsFor(state: AutopilotState, path: NumPath): NumberBounds | undefined {
  const [section, key] = path.split(".") as [string, string | undefined];
  if (key === undefined) return state.bounds?.config[section as NumKey];
  if (section === "policy") return state.bounds?.policy[key as keyof FeePolicy];
  return state.bounds?.rebalancePolicy[key as RebKey];
}

function savedValue(config: AutopilotConfig, path: NumPath): number | null {
  const [section, key] = path.split(".") as [string, string | undefined];
  if (key === undefined) return config[section as NumKey];
  if (section === "policy") return config.policy[key as keyof FeePolicy];
  return config.rebalancePolicy[key as RebKey];
}

export function AutopilotPanel({ initialSub }: { initialSub?: string }) {
  const [server, setServer] = useState<AutopilotState | null>(null);
  // Unsaved numeric edits, as typed. Everything else (switches, tiles,
  // checkboxes, presets) saves at once and sends ONLY its own field — a toggle
  // can no longer save, or wipe, a half-typed number somewhere else.
  const [edits, setEdits] = useState<Partial<Record<NumPath, string>>>({});
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<Sub>(
    initialSub && (SUBS as string[]).includes(initialSub) ? (initialSub as Sub) : "fees",
  );
  const [lastRun, setLastRun] = useState<AutopilotRun | null>(null);
  // Market reality for the caps section. Needs no Amboss key.
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

  useEffect(() => {
    api.magmaRecommendations().then(setMagma).catch(() => setMagma(null));
  }, []);

  // The same "why don't I sell?" checklist as Market → Sell, on the Magma
  // settings — read when that sub-tab is opened.
  const [diag, setDiag] = useState<SellDiagnostics | null>(null);
  useEffect(() => {
    if (sub !== "magma") return;
    api.sellDiagnostics().then(setDiag).catch(() => setDiag(null));
  }, [sub]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .autopilotGet()
        .then((s) => {
          if (!cancelled) setServer(s);
        })
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    load();
    const id = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!server) {
    return <section className="panel"><p className="muted empty">Loading autopilot…</p></section>;
  }
  const writeOff = !server.canWrite;
  const config = server.config;

  /** What a numeric field shows: the unsaved text, else the saved value. */
  const shownNum = (path: NumPath): number | null => {
    const text = edits[path];
    if (text !== undefined && text.trim() !== "" && Number.isFinite(Number(text))) return Number(text);
    return savedValue(config, path);
  };

  const save = async (patch: AutopilotConfigPatch, successMsg?: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      setServer(await api.autopilotSet(patch));
      if (successMsg) toast(successMsg, "success");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** "Save settings": validate every edited number first — a blank or
   *  out-of-range field is reported, never sent (and never sent as 0). */
  const saveNumbers = async () => {
    const patch: AutopilotConfigPatch = {};
    const errors: string[] = [];
    for (const [path, text] of Object.entries(edits) as [NumPath, string][]) {
      const parsed = parseNumField(text, boundsFor(server, path), LABELS[path] ?? path);
      if (!parsed.ok) {
        errors.push(parsed.error);
        continue;
      }
      const [section, key] = path.split(".") as [string, string | undefined];
      if (key === undefined) Object.assign(patch, { [section]: parsed.value });
      else if (section === "policy") patch.policy = { ...patch.policy, [key]: parsed.value };
      else patch.rebalancePolicy = { ...patch.rebalancePolicy, [key]: parsed.value };
    }
    if (errors.length) {
      setError(errors.join(" · "));
      return;
    }
    if (Object.keys(patch).length === 0) return;
    if (await save(patch, "Settings saved")) setEdits({});
  };
  const unsaved = Object.keys(edits).length > 0;

  const runNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const { run, state } = await api.autopilotRun();
      setLastRun(run);
      setServer(state);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  type BoolKey = "enabled" | "rebalanceEnabled" | "channelEnabled" | "sellEnabled" | "maxHtlcEnabled";
  const toggleRow = (field: BoolKey, title: string, subtitle: string, onChange?: (v: boolean) => void) => (
    <div className="ap-master">
      <Switch
        checked={config[field]}
        disabled={busy || writeOff}
        onChange={(v) => (onChange ? onChange(v) : void save({ [field]: v }))}
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
      disableOffer: (id: string) => api.ambossToggleOffer(id, "DISABLED"),
      save,
      toast,
    };
    await (on ? turnSellingOn(deps) : turnSellingOff(deps));
  };

  const numInput = (path: NumPath, label: string, step?: number) => {
    const b = boundsFor(server, path);
    const saved = savedValue(config, path);
    return (
      <label key={path} className="policy-field">
        <span>{label}</span>
        <input
          type="number"
          min={b?.min}
          max={b?.max}
          step={step ?? (b && !b.integer ? "any" : 1)}
          title={b ? `${b.min}–${b.max}` : undefined}
          value={edits[path] ?? (saved ?? "")}
          onChange={(e) => {
            const text = e.target.value;
            setEdits((ed) => ({ ...ed, [path]: text }));
          }}
        />
      </label>
    );
  };

  const numFields = (fields: { key: NumKey; label: string }[]) =>
    fields.map((f) =>
      f.key === "rebalanceDailyBudgetSats" && config.rebalanceDailyBudgetSats === null && edits[f.key] === undefined ? (
        <label key={f.key} className="policy-field">
          <span>{f.label}</span>
          <input type="text" value="No limit" disabled />
        </label>
      ) : (
        numInput(f.key, f.label)
      ),
    );

  /** Explicit "no cap" for the rebalance budget — 0 no longer means that. */
  const noBudgetLimit = (
    <label className="check ap-check">
      <input
        type="checkbox"
        checked={config.rebalanceDailyBudgetSats === null}
        disabled={busy || writeOff}
        onChange={(e) => {
          setEdits((ed) => {
            const next = { ...ed };
            delete next.rebalanceDailyBudgetSats;
            return next;
          });
          void save({ rebalanceDailyBudgetSats: e.target.checked ? null : 10_000 });
        }}
      />
      No daily limit on rebalance fees (each move must still pass the profit check)
    </label>
  );

  const saveRow = (
    <div className="apply-row">
      <button className="primary-btn" disabled={busy || !unsaved} onClick={() => void saveNumbers()}>
        Save settings
      </button>
      {unsaved ? <span className="muted">Unsaved changes</span> : null}
    </div>
  );

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

  return (
    <div>
      <div className="ap-strategy">
        <div className="ap-strategy-head">
          <span className="ap-strategy-title">Strategy</span>
          <span className="muted">one click — applied instantly, no Save needed</span>
          {!PRESETS.some((p) => matchesPreset(p.cfg)) ? (
            <span className="preset-custom-chip" title="Your settings differ from every preset — pick one to snap everything back to a coherent goal">
              Custom settings active
            </span>
          ) : null}
        </div>
        <div className="ap-preset-grid">
          {PRESETS.map((p) => {
            const active = matchesPreset(p.cfg);
            return (
              <button
                key={p.id}
                className={`preset-opt ${active ? "active" : ""}`}
                disabled={busy || writeOff}
                onClick={() => void save(p.cfg, `Strategy applied: ${p.label}`)}
              >
                <span className="preset-opt-label">
                  {p.label}
                  {active ? <span className="preset-opt-badge">✓ active</span> : null}
                </span>
                <span className="preset-opt-desc">{p.desc}</span>
              </button>
            );
          })}
        </div>
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
      {(() => {
        // A main run that takes far longer than usual is stuck on something
        // (a payment, a call to the node): say so, on every tab.
        const run = runProgress(server.runningSince, Date.now());
        return run?.stuck ? <p className="banner error">{run.text}</p> : null;
      })()}

      {sub === "fees" ? (
        <>
          {toggleRow("enabled", "Fee automation", "Apply the recommended fees below automatically, on a schedule")}
          {toggleRow(
            "maxHtlcEnabled",
            "Advertise routable size",
            "Keep each channel's max HTLC just under its spendable balance (rounded to powers of two) — senders skip depleted channels, so fewer forwards fail through you",
          )}
          <details className="ap-customize">
            <summary>Customize fee policy</summary>
            <div className="policy-controls">
              {numFields(FEE_NUM_FIELDS)}
              {POLICY_FIELDS.map((f) => numInput(`policy.${f.key}`, f.label))}
            </div>
            {saveRow}
          </details>
          <FeeRecommendations />
        </>
      ) : sub === "rebalancing" ? (
        <>
          {toggleRow("rebalanceEnabled", "Auto-rebalance", "Run the profitable rebalances below automatically (cost ≤ budget)")}
          <details className="ap-customize">
            <summary>Customize rebalance policy</summary>
            <div className="policy-controls">
              {numFields(REB_NUM_FIELDS)}
              {REB_POLICY_FIELDS.map((f) => numInput(`rebalancePolicy.${f.key}`, f.label, f.step))}
            </div>
            <div className="ap-checks">{noBudgetLimit}</div>
            {saveRow}
          </details>
          <RebalanceRecommendations />
        </>
      ) : sub === "channels" ? (
        <>
          {toggleRow("channelEnabled", "Channel autopilot", "Opens a channel to the top suggestion below when on-chain funds allow")}
          <details className="ap-customize">
            <summary>Customize channel policy</summary>
            <div className="policy-controls">{numFields(CHANNEL_NUM_FIELDS)}</div>
            {saveRow}
          </details>
          <SuggestionsPanel />
        </>
      ) : sub === "magma" ? (
        <section className="panel">
          <SellDiagnosticsCard d={diag} onFix={(tab, s) => goTo(tab, s)} />
          {toggleRow(
            "sellEnabled",
            "Liquidity provision (Magma)",
            "Advanced: sells inbound on Amboss Magma — accepts orders with a hold invoice, opens channels to buyers, rejects what it can't serve, within your caps. Amboss decides who gets orders.",
            (v) => void setSelling(v),
          )}
          {server.decisions?.magma ? (
            <p className="muted ap-hint">
              Last decision ({timeAgo(server.decisions.magma.at)}): {server.decisions.magma.text}
            </p>
          ) : null}

          <h3 className="sub">Offer pricing</h3>
          <p className="muted ap-hint">
            With auto-pricing on, your enabled offer is priced from what buyers actually paid for comparable leases, at the level
            below — never below your profit floor. (Price is not what gets a seller picked; it decides what a sale earns.)
          </p>
          <div className="mode-select">
            {PRICING_MODES.map(({ id, label, desc }) => (
              <button
                key={id}
                className={`mode-opt ${config.sellPricingMode === id ? "active" : ""}`}
                disabled={busy || writeOff}
                onClick={() => void save({ sellPricingMode: id })}
              >
                <span className="mode-opt-label">{label}</span>
                <span className="mode-opt-desc">{desc}</span>
              </button>
            ))}
          </div>

          <h3 className="sub">Automation</h3>
          <div className="ap-checks">
            <label className="check ap-check">
              <input type="checkbox" checked={config.sellAutoReprice} disabled={busy || writeOff} onChange={(e) => void save({ sellAutoReprice: e.target.checked })} />
              Auto-price the enabled offer from what buyers actually paid (at the level above, floor-protected)
            </label>
            <label className="check ap-check">
              <input type="checkbox" checked={config.sellAutoSize} disabled={busy || writeOff} onChange={(e) => void save({ sellAutoSize: e.target.checked })} />
              Auto-size the offer: the standard 30-day lease, the routing-fee promise, and a window from the smallest channel that pays for itself up to what can be funded
            </label>
            <label className="check ap-check">
              <input type="checkbox" checked={config.sellAutoRelist} disabled={busy || writeOff} onChange={(e) => void save({ sellAutoRelist: e.target.checked })} />
              Auto-relist a depleted offer (top it back up within your caps)
            </label>
            <label className="check ap-check">
              <input type="checkbox" checked={config.sellAutoClose} disabled={busy || writeOff} onChange={(e) => void save({ sellAutoClose: e.target.checked })} />
              Auto-close channels after the lease ends (reclaim the capital on-chain)
            </label>
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
          {(shownNum("sellMaxChannelSats") ?? 0) > (shownNum("sellMaxDeploySats") ?? 0) ? (
            <div className="sug-warn">
              ⚠ Max channel size ({satsCompact(shownNum("sellMaxChannelSats") ?? 0)}) is above your capital cap (
              {satsCompact(shownNum("sellMaxDeploySats") ?? 0)}), so an order that big can never be served. The smaller
              number is what actually applies.
            </div>
          ) : null}
          {saveRow}
        </section>
      ) : (
        <section className="panel">
          <div className="apply-row">
            <button className="reset" disabled={busy || !!server.runningSince} onClick={runNow}>Run once now</button>
            <span className="muted">{server.lastRunAt ? `last run ${timeAgo(server.lastRunAt)}` : "never run"}</span>
            {(() => {
              const run = runProgress(server.runningSince, Date.now());
              return run && !run.stuck ? <span className="muted">· {run.text}</span> : null;
            })()}
          </div>
          {lastRun ? (
            <p className="muted">
              Last run: {lastRun.applied} applied, {lastRun.failed} failed of {lastRun.attempted} attempted.
            </p>
          ) : null}

          <h3 className="sub">History</h3>
          {server.history.length === 0 ? (
            <p className="muted empty">No runs yet.</p>
          ) : (
            <ul className="ap-history">
              {server.history.map((run, i) => {
                const items: { ok: boolean; label: string; error?: string }[] = [
                  ...(run.changes ?? []).map((c) => ({ ok: c.ok, label: `Fee · ${c.alias}: ${c.fromPpm}→${c.toPpm} ppm`, error: c.error })),
                  ...(run.rebalances ?? []).map((r) => ({ ok: r.ok, label: `Rebalance · ${r.alias}${r.ok ? ` — ${r.feeSats} sat` : ""}`, error: r.error })),
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
                return (
                  <li key={`${run.at}-${i}`}>
                    <div className="ap-run-head">
                      <span>{timeAgo(run.at)}</span>
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
                          return (
                            <div key={j} className="ap-line">
                              {expandable ? (
                                <button className="ap-line-btn" onClick={() => toggleItem(key)}>
                                  <span className="ap-caret">{isOpen ? "▾" : "▸"}</span>✗ {it.label}
                                </button>
                              ) : (
                                <span className={it.ok ? "ap-line-ok" : "ap-line-fail"}>{it.ok ? "✓" : "✗"} {it.label}</span>
                              )}
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
