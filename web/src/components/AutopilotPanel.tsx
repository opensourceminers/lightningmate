import { useEffect, useState } from "react";
import { api } from "../api";
import type { AutopilotConfig, AutopilotRun, AutopilotState } from "../types";
import { timeAgo } from "../format";

type NumKey = "intervalMinutes" | "cooldownMinutes" | "maxChangesPerRun";

const NUMBER_FIELDS: { key: NumKey; label: string; hint: string }[] = [
  { key: "intervalMinutes", label: "Run every (min)", hint: "how often the autopilot runs" },
  { key: "cooldownMinutes", label: "Per-channel cooldown (min)", hint: "min time between changes to the same channel" },
  { key: "maxChangesPerRun", label: "Max changes / run", hint: "caps how many channels change at once" },
];

const POLICY_FIELDS: { key: keyof AutopilotConfig["policy"]; label: string }[] = [
  { key: "minPpm", label: "Min ppm (full)" },
  { key: "maxPpm", label: "Max ppm (drained)" },
  { key: "baseFeeMsat", label: "Base fee (msat)" },
  { key: "step", label: "Round to" },
  { key: "minChangePpm", label: "Min change" },
];

export function AutopilotPanel() {
  const [server, setServer] = useState<AutopilotState | null>(null);
  const [draft, setDraft] = useState<AutopilotConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<AutopilotRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load once, then poll status/history (without clobbering the edit draft).
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
          Autopilot needs <strong>write access</strong>, which is off by default.
          To enable it, give LightningMate an <code>offchain:write</code> macaroon:
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

  const save = async (overrides: Partial<AutopilotConfig> = {}) => {
    setBusy(true);
    setError(null);
    try {
      const next = { ...draft, ...overrides };
      const s = await api.autopilotSet(next);
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

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Autopilot</h2>
        <span className={`ap-status ${server.config.enabled ? "on" : "off"}`}>
          {server.config.enabled ? "● running" : "○ off"}
        </span>
      </div>

      <div className="dryrun-banner">
        The autopilot periodically applies your policy to channels whose fee should
        change — respecting the per-channel cooldown and the max-changes cap. It only
        touches active channels, and never changes more than the cap per run.
      </div>

      <label className="ap-toggle">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={busy}
          onChange={(e) => save({ enabled: e.target.checked })}
        />
        <span>{draft.enabled ? "Autopilot enabled" : "Autopilot disabled"}</span>
      </label>

      <div className="policy-controls">
        {NUMBER_FIELDS.map((f) => (
          <label key={f.key} className="policy-field" title={f.hint}>
            <span>{f.label}</span>
            <input
              type="number"
              min={0}
              value={draft[f.key]}
              onChange={(e) => setNum(f.key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>

      <h3 className="sub">Policy curve</h3>
      <div className="policy-controls">
        {POLICY_FIELDS.map((f) => (
          <label key={f.key} className="policy-field">
            <span>{f.label}</span>
            <input
              type="number"
              min={0}
              value={draft.policy[f.key]}
              onChange={(e) => setPolicyNum(f.key, Number(e.target.value))}
            />
          </label>
        ))}
      </div>

      {error ? <p className="banner error">{error}</p> : null}

      <div className="apply-row">
        <button className="primary-btn" disabled={busy} onClick={() => save()}>
          Save settings
        </button>
        <button className="reset" disabled={busy} onClick={runNow}>
          Run once now
        </button>
        <span className="muted">
          {server.lastRunAt ? `last run ${timeAgo(server.lastRunAt)}` : "never run"}
        </span>
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
          {server.history.map((run, i) => (
            <li key={`${run.at}-${i}`}>
              <div className="ap-run-head">
                <span>{timeAgo(run.at)}</span>
                <span className="muted">
                  {run.applied} applied{run.failed ? `, ${run.failed} failed` : ""}
                </span>
              </div>
              {run.changes.length ? (
                <div className="ap-changes">
                  {run.changes.map((c) => (
                    <span key={c.id} className={c.ok ? "ap-ok" : "ap-fail"} title={c.error ?? ""}>
                      {c.alias}: {c.fromPpm}→{c.toPpm}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
