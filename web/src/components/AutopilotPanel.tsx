import { useEffect, useState } from "react";
import { api } from "../api";
import type { AutopilotConfig, AutopilotRun, AutopilotState } from "../types";
import { satsCompact, timeAgo } from "../format";
import { RunState, Switch } from "./Switch";
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
  { key: "maxPpm", label: "Max ppm (drained)" },
  { key: "baseFeeMsat", label: "Base fee (msat)" },
  { key: "step", label: "Round to" },
  { key: "minChangePpm", label: "Min change" },
];
const REB_NUM_FIELDS: { key: NumKey; label: string }[] = [
  { key: "maxRebalancesPerRun", label: "Max rebalances / run" },
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

export function AutopilotPanel({ initialSub }: { initialSub?: string }) {
  const [server, setServer] = useState<AutopilotState | null>(null);
  const [draft, setDraft] = useState<AutopilotConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<Sub>(
    initialSub && (SUBS as string[]).includes(initialSub) ? (initialSub as Sub) : "fees",
  );
  const [lastRun, setLastRun] = useState<AutopilotRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openItems, setOpenItems] = useState<Set<string>>(new Set());
  const toggleItem = (key: string) =>
    setOpenItems((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  useEffect(() => {
    let cancelled = false;
    const load = (seedDraft: boolean) =>
      api
        .autopilotGet()
        .then((s) => {
          if (cancelled) return;
          setServer(s);
          if (seedDraft) setDraft(s.config);
        })
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    load(true);
    const id = setInterval(() => load(false), 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!server || !draft) {
    return <section className="panel"><p className="muted empty">Loading autopilot…</p></section>;
  }
  const writeOff = !server.canWrite;

  const setNum = (key: NumKey, value: number) =>
    setDraft((d) => (d ? { ...d, [key]: Math.max(0, value || 0) } : d));
  const setPolicyNum = (key: keyof AutopilotConfig["policy"], value: number) =>
    setDraft((d) => (d ? { ...d, policy: { ...d.policy, [key]: Math.max(0, value || 0) } } : d));
  const setRebPolicyNum = (key: RebKey, value: number) =>
    setDraft((d) => (d ? { ...d, rebalancePolicy: { ...d.rebalancePolicy, [key]: Math.max(0, value || 0) } } : d));
  const setBool = (key: keyof AutopilotConfig, value: boolean) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = async (overrides: Partial<AutopilotConfig> = {}) => {
    setBusy(true);
    setError(null);
    try {
      const s = await api.autopilotSet({ ...draft, ...overrides });
      setServer(s);
      setDraft(s.config);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

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

  type BoolKey = "enabled" | "rebalanceEnabled" | "channelEnabled" | "sellEnabled";
  const toggleRow = (field: BoolKey, title: string, subtitle: string) => (
    <div className="ap-master">
      <Switch
        checked={draft[field]}
        disabled={busy || writeOff}
        onChange={(v) => save({ [field]: v })}
        label={title}
      />
      <div className="ap-master-text">
        <div className="ap-master-title">{title}</div>
        <div className="ap-master-sub">{subtitle}</div>
      </div>
      <RunState on={server.config[field]} />
    </div>
  );

  const numFields = (fields: { key: NumKey; label: string }[]) =>
    fields.map((f) => (
      <label key={f.key} className="policy-field">
        <span>{f.label}</span>
        <input type="number" min={0} value={draft[f.key] as number} onChange={(e) => setNum(f.key, Number(e.target.value))} />
      </label>
    ));

  const TABS: { id: Sub; label: string }[] = [
    { id: "fees", label: "Fees" },
    { id: "rebalancing", label: "Rebalancing" },
    { id: "channels", label: "Channels" },
    { id: "magma", label: "Magma" },
    { id: "history", label: "History" },
  ];

  // Every preset is profit-first; they differ only in WHERE the capital earns.
  // Selling presets use "auto" pricing (adapts to find the income-maximising lease
  // price). Rebalancing is off-chain and only ever runs profitable moves, so it
  // stays on wherever it adds revenue without competing for on-chain capital.
  const PRESETS: { id: string; label: string; desc: string; cfg: Partial<AutopilotConfig> }[] = [
    {
      id: "routing",
      label: "Maximize routing",
      desc: "Earn from forwarding. Magma off.",
      cfg: { enabled: true, rebalanceEnabled: true, channelEnabled: true, sellEnabled: false },
    },
    {
      id: "magma",
      label: "Magma leasing",
      desc: "Lease capital at the best price. No new routing channels.",
      cfg: { enabled: true, sellEnabled: true, sellAutoReprice: true, sellPricingMode: "auto", rebalanceEnabled: true, channelEnabled: false },
    },
    {
      id: "balanced",
      label: "Balanced",
      desc: "Route, lease & grow — all profit-max.",
      cfg: { enabled: true, rebalanceEnabled: true, channelEnabled: true, sellEnabled: true, sellAutoReprice: true, sellPricingMode: "auto" },
    },
  ];
  const matchesPreset = (p: Partial<AutopilotConfig>) =>
    (Object.keys(p) as (keyof AutopilotConfig)[]).every((k) => draft[k] === p[k]);

  return (
    <div>
      <div className="ap-strategy">
        <div className="ap-strategy-head">
          <span className="ap-strategy-title">Strategy</span>
          <span className="muted">one click — each maximises profit its own way</span>
        </div>
        <div className="ap-preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset-opt ${matchesPreset(p.cfg) ? "active" : ""}`}
              disabled={busy || writeOff}
              onClick={() => save(p.cfg)}
            >
              <span className="preset-opt-label">{p.label}</span>
              <span className="preset-opt-desc">{p.desc}</span>
            </button>
          ))}
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

      {sub === "fees" ? (
        <>
          {toggleRow("enabled", "Fee automation", "Apply the recommended fees below automatically, on a schedule")}
          <details className="ap-customize">
            <summary>Customize fee policy</summary>
            <div className="policy-controls">
              {numFields(FEE_NUM_FIELDS)}
              {POLICY_FIELDS.map((f) => (
                <label key={f.key} className="policy-field">
                  <span>{f.label}</span>
                  <input type="number" min={0} value={draft.policy[f.key]} onChange={(e) => setPolicyNum(f.key, Number(e.target.value))} />
                </label>
              ))}
            </div>
            <div className="apply-row">
              <button className="primary-btn" disabled={busy} onClick={() => save()}>Save settings</button>
            </div>
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
              {REB_POLICY_FIELDS.map((f) => (
                <label key={f.key} className="policy-field">
                  <span>{f.label}</span>
                  <input type="number" min={0} step={f.step} value={draft.rebalancePolicy[f.key]} onChange={(e) => setRebPolicyNum(f.key, Number(e.target.value))} />
                </label>
              ))}
            </div>
            <div className="apply-row">
              <button className="primary-btn" disabled={busy} onClick={() => save()}>Save settings</button>
            </div>
          </details>
          <RebalanceRecommendations />
        </>
      ) : sub === "channels" ? (
        <>
          {toggleRow("channelEnabled", "Channel autopilot", "Opens a channel to the top suggestion below when on-chain funds allow")}
          <details className="ap-customize">
            <summary>Customize channel policy</summary>
            <div className="policy-controls">{numFields(CHANNEL_NUM_FIELDS)}</div>
            <div className="apply-row">
              <button className="primary-btn" disabled={busy} onClick={() => save()}>Save settings</button>
            </div>
          </details>
          <SuggestionsPanel />
        </>
      ) : sub === "magma" ? (
        <section className="panel">
          {toggleRow("sellEnabled", "Liquidity provision (Magma)", "Auto-fulfils your sell orders — opens channels to buyers, earns lease fees, within caps")}

          <h3 className="sub">Offer pricing</h3>
          <p className="muted ap-hint">
            With auto-pricing on, your enabled offer is kept continuously priced to the live market at this level —
            never below your profit floor.
          </p>
          <div className="mode-select">
            {(
              [
                ["auto", "Auto", "adapts to demand — raises when it sells, lowers when it doesn't"],
                ["fast", "Low", "undercut — sell fast"],
                ["balanced", "Median", "match the market middle"],
                ["premium", "Premium", "top of the market — earn more"],
              ] as ["auto" | "fast" | "balanced" | "premium", string, string][]
            ).map(([id, label, desc]) => (
              <button
                key={id}
                className={`mode-opt ${draft.sellPricingMode === id ? "active" : ""}`}
                disabled={busy || writeOff}
                onClick={() => save({ sellPricingMode: id })}
              >
                <span className="mode-opt-label">{label}</span>
                <span className="mode-opt-desc">{desc}</span>
              </button>
            ))}
          </div>

          <h3 className="sub">Automation</h3>
          <div className="ap-checks">
            <label className="check ap-check">
              <input type="checkbox" checked={draft.sellAutoReprice} onChange={(e) => setBool("sellAutoReprice", e.target.checked)} />
              Auto-price the enabled offer to the live market (at the level above, floor-protected)
            </label>
            <label className="check ap-check">
              <input type="checkbox" checked={draft.sellAutoRelist} onChange={(e) => setBool("sellAutoRelist", e.target.checked)} />
              Auto-relist a depleted offer (top it back up within your caps so it keeps selling)
            </label>
            <label className="check ap-check">
              <input type="checkbox" checked={draft.sellAutoClose} onChange={(e) => setBool("sellAutoClose", e.target.checked)} />
              Auto-close channels after the lease ends (reclaim the capital on-chain)
            </label>
          </div>

          <h3 className="sub">Caps</h3>
          <div className="policy-controls">{numFields(SELL_NUM_FIELDS)}</div>
          <div className="apply-row">
            <button className="primary-btn" disabled={busy} onClick={() => save()}>Save settings</button>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="apply-row">
            <button className="reset" disabled={busy} onClick={runNow}>Run once now</button>
            <span className="muted">{server.lastRunAt ? `last run ${timeAgo(server.lastRunAt)}` : "never run"}</span>
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
