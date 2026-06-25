import { useEffect, useState } from "react";
import { api } from "../api";
import type { AutopilotConfig, AutopilotRun, AutopilotState } from "../types";
import { satsCompact, timeAgo } from "../format";
import { RunState, Switch } from "./Switch";

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

// The recommended (optimal) defaults — used as the baseline and for "reset".
const RECOMMENDED: Pick<
  AutopilotConfig,
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
  | "policy"
  | "rebalancePolicy"
> = {
  intervalMinutes: 60,
  cooldownMinutes: 360,
  maxChangesPerRun: 5,
  maxRebalancesPerRun: 2,
  rebalanceCooldownMinutes: 720,
  rebalanceHourStart: 0,
  rebalanceHourEnd: 24,
  channelReserveSats: 50_000,
  channelSizeSats: 0,
  channelCooldownMinutes: 1_440,
  policy: { minPpm: 50, maxPpm: 1000, baseFeeMsat: 1000, step: 10, minChangePpm: 25 },
  rebalancePolicy: {
    econRatio: 0.8,
    maxLocalRatioTarget: 0.35,
    minLocalRatioSource: 0.65,
    amountSats: 1_000_000,
    minDemandSats: 1,
    flowWindowDays: 30,
    maxCandidates: 8,
  },
};

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

export function AutopilotPanel() {
  const [server, setServer] = useState<AutopilotState | null>(null);
  const [draft, setDraft] = useState<AutopilotConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [lastRun, setLastRun] = useState<AutopilotRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Expanded failed actions, keyed by `runAt:index` (stable across the 15s refresh).
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

  if (!server.canWrite) {
    return (
      <section className="panel">
        <div className="panel-head"><h2>Autopilot</h2></div>
        <div className="dryrun-banner">
          Autopilot needs <strong>write access</strong>, which is off by default. To enable it,
          give LightningMate an <code>offchain:write</code> macaroon:
          <ul className="enable-steps">
            <li>set <code>LM_ENABLE_WRITE=true</code></li>
            <li>set <code>LND_WRITE_MACAROON</code> (base64) or <code>LND_WRITE_MACAROON_PATH</code> to your admin macaroon</li>
            <li>restart the backend</li>
          </ul>
          On Umbrel the admin macaroon is auto-discovered from the mounted data dir.
        </div>
      </section>
    );
  }

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

  const isRecommended =
    JSON.stringify({
      intervalMinutes: draft.intervalMinutes,
      cooldownMinutes: draft.cooldownMinutes,
      maxChangesPerRun: draft.maxChangesPerRun,
      maxRebalancesPerRun: draft.maxRebalancesPerRun,
      rebalanceCooldownMinutes: draft.rebalanceCooldownMinutes,
      rebalanceHourStart: draft.rebalanceHourStart,
      rebalanceHourEnd: draft.rebalanceHourEnd,
      channelReserveSats: draft.channelReserveSats,
      channelSizeSats: draft.channelSizeSats,
      channelCooldownMinutes: draft.channelCooldownMinutes,
      policy: draft.policy,
      rebalancePolicy: draft.rebalancePolicy,
    }) === JSON.stringify(RECOMMENDED);

  return (
    <section className="panel">
      <div className="panel-head"><h2>Autopilot</h2></div>
      <div className="dryrun-banner">
        Let your node manage itself. Flip a switch on and it runs on the
        <strong> recommended settings</strong> — only ever making safe, sensible changes.
      </div>

      {/* Master toggles */}
      <div className="ap-master">
        <Switch checked={draft.enabled} disabled={busy} onChange={(v) => save({ enabled: v })} label="Fee autopilot" />
        <div className="ap-master-text">
          <div className="ap-master-title">Fee autopilot</div>
          <div className="ap-master-sub">Automatically tunes channel fees to balance liquidity</div>
        </div>
        <RunState on={server.config.enabled} />
      </div>

      <div className="ap-master">
        <Switch checked={draft.rebalanceEnabled} disabled={busy} onChange={(v) => save({ rebalanceEnabled: v })} label="Auto-rebalance" />
        <div className="ap-master-text">
          <div className="ap-master-title">Auto-rebalance</div>
          <div className="ap-master-sub">Runs profitable rebalances only (cost ≤ budget)</div>
        </div>
        <RunState on={server.config.rebalanceEnabled} />
      </div>

      <div className="ap-master">
        <Switch checked={draft.channelEnabled} disabled={busy} onChange={(v) => save({ channelEnabled: v })} label="Channel autopilot" />
        <div className="ap-master-text">
          <div className="ap-master-title">Channel autopilot</div>
          <div className="ap-master-sub">Opens a channel to the top suggestion when on-chain funds allow</div>
        </div>
        <RunState on={server.config.channelEnabled} />
      </div>

      <div className="ap-master">
        <Switch checked={draft.sellEnabled} disabled={busy} onChange={(v) => save({ sellEnabled: v })} label="Liquidity provision" />
        <div className="ap-master-text">
          <div className="ap-master-title">Liquidity provision (Magma)</div>
          <div className="ap-master-sub">Auto-fulfills your sell orders — opens channels to buyers, earns lease fees, within caps</div>
        </div>
        <RunState on={server.config.sellEnabled} />
      </div>

      {/* Recommended / advanced */}
      <div className="ap-settings-bar">
        <span className="muted">
          {isRecommended ? "✓ Using recommended settings" : "Using custom settings"}
        </span>
        <div className="ap-settings-actions">
          {!isRecommended ? (
            <button className="reset" disabled={busy} onClick={() => save(RECOMMENDED)}>
              Reset to recommended
            </button>
          ) : null}
          <button className="link-btn" onClick={() => setAdvanced((a) => !a)}>
            {advanced ? "Hide advanced" : "Customize"}
          </button>
        </div>
      </div>

      {advanced ? (
        <div className="ap-advanced">
          <h3 className="sub">Fee schedule</h3>
          <div className="policy-controls">
            {FEE_NUM_FIELDS.map((f) => (
              <label key={f.key} className="policy-field">
                <span>{f.label}</span>
                <input type="number" min={0} value={draft[f.key] as number} onChange={(e) => setNum(f.key, Number(e.target.value))} />
              </label>
            ))}
          </div>
          <h3 className="sub">Fee curve</h3>
          <div className="policy-controls">
            {POLICY_FIELDS.map((f) => (
              <label key={f.key} className="policy-field">
                <span>{f.label}</span>
                <input type="number" min={0} value={draft.policy[f.key]} onChange={(e) => setPolicyNum(f.key, Number(e.target.value))} />
              </label>
            ))}
          </div>
          <h3 className="sub">Rebalance settings</h3>
          <div className="policy-controls">
            {REB_NUM_FIELDS.map((f) => (
              <label key={f.key} className="policy-field">
                <span>{f.label}</span>
                <input type="number" min={0} value={draft[f.key] as number} onChange={(e) => setNum(f.key, Number(e.target.value))} />
              </label>
            ))}
            {REB_POLICY_FIELDS.map((f) => (
              <label key={f.key} className="policy-field">
                <span>{f.label}</span>
                <input type="number" min={0} step={f.step} value={draft.rebalancePolicy[f.key]} onChange={(e) => setRebPolicyNum(f.key, Number(e.target.value))} />
              </label>
            ))}
          </div>
          <h3 className="sub">Channel autopilot</h3>
          <div className="policy-controls">
            {CHANNEL_NUM_FIELDS.map((f) => (
              <label key={f.key} className="policy-field">
                <span>{f.label}</span>
                <input type="number" min={0} value={draft[f.key] as number} onChange={(e) => setNum(f.key, Number(e.target.value))} />
              </label>
            ))}
          </div>
          <h3 className="sub">Liquidity provision (Magma)</h3>
          <div className="policy-controls">
            {SELL_NUM_FIELDS.map((f) => (
              <label key={f.key} className="policy-field">
                <span>{f.label}</span>
                <input type="number" min={0} value={draft[f.key] as number} onChange={(e) => setNum(f.key, Number(e.target.value))} />
              </label>
            ))}
          </div>
          <label className="check ap-check">
            <input type="checkbox" checked={draft.sellAutoClose} onChange={(e) => setBool("sellAutoClose", e.target.checked)} />
            Auto-close channels after the lease ends (reclaim the capital on-chain)
          </label>
          <label className="check ap-check">
            <input type="checkbox" checked={draft.sellAutoRelist} onChange={(e) => setBool("sellAutoRelist", e.target.checked)} />
            Auto-relist a depleted offer (top it back up within your caps so it keeps selling)
          </label>
          <div className="apply-row">
            <button className="primary-btn" disabled={busy} onClick={() => save()}>Save settings</button>
          </div>
        </div>
      ) : null}

      {error ? <p className="banner error">{error}</p> : null}

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
              ...(run.changes ?? []).map((c) => ({
                ok: c.ok,
                label: `Fee · ${c.alias}: ${c.fromPpm}→${c.toPpm} ppm`,
                error: c.error,
              })),
              ...(run.rebalances ?? []).map((r) => ({
                ok: r.ok,
                label: `Rebalance · ${r.alias}${r.ok ? ` — ${r.feeSats} sat` : ""}`,
                error: r.error,
              })),
              ...(run.channels ?? []).map((c) => ({
                ok: c.ok,
                label: `Open · ${c.alias}${c.ok ? ` — ${satsCompact(c.sizeSats)}` : ""}`,
                error: c.error,
              })),
              ...(run.sells ?? []).map((s) => ({
                ok: s.ok,
                label: `Magma ${s.action} · ${satsCompact(s.sizeSats)}`,
                error: s.error,
              })),
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
                            <span className={it.ok ? "ap-line-ok" : "ap-line-fail"}>
                              {it.ok ? "✓" : "✗"} {it.label}
                            </span>
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
  );
}
