import { useEffect, useState } from "react";
import { api } from "../api";
import type { FeeApplyItem, FeeApplyResult, FeePolicy, FeePreview, FeeProposal } from "../types";
import { percent } from "../format";

const DEFAULT_POLICY: FeePolicy = {
  minPpm: 50,
  maxPpm: 1000,
  baseFeeMsat: 1000,
  step: 10,
  minChangePpm: 25,
};

const CONTROLS: { key: keyof FeePolicy; label: string; hint: string }[] = [
  { key: "minPpm", label: "Min ppm (full)", hint: "fee when channel is full" },
  { key: "maxPpm", label: "Max ppm (drained)", hint: "fee when channel is empty" },
  { key: "baseFeeMsat", label: "Base fee (msat)", hint: "flat base fee" },
  { key: "step", label: "Round to", hint: "round ppm to nearest" },
  { key: "minChangePpm", label: "Min change", hint: "ignore smaller deltas" },
];

function Delta({ p }: { p: FeeProposal }) {
  if (p.deltaPpm === 0) return <span className="muted">—</span>;
  const up = p.deltaPpm > 0;
  return (
    <span className={up ? "delta-up" : "delta-down"}>
      {up ? "▲" : "▼"} {Math.abs(p.deltaPpm)}
    </span>
  );
}

function itemsToApply(preview: FeePreview | null): FeeApplyItem[] {
  return (preview?.proposals ?? [])
    .filter((p) => p.active && p.willChange && p.transactionId !== null && p.transactionVout !== null)
    .map((p) => ({
      id: p.id,
      transactionId: p.transactionId as string,
      transactionVout: p.transactionVout as number,
      feeRatePpm: p.proposedPpm,
      baseFeeMsat: p.proposedBaseMsat,
    }));
}

export function FeesPanel() {
  const [policy, setPolicy] = useState<FeePolicy>(DEFAULT_POLICY);
  const [preview, setPreview] = useState<FeePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<FeeApplyResult[] | null>(null);

  useEffect(() => {
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .feesPreview(policy)
      .then((p) => !cancelled && (setPreview(p), setError(null)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [policy]);

  const setField = (key: keyof FeePolicy, value: number) =>
    setPolicy((prev) => ({ ...prev, [key]: value }));

  const apply = async () => {
    const items = itemsToApply(preview);
    if (!items.length) return;
    setApplying(true);
    setResults(null);
    try {
      const res = await api.feesApply(items);
      setResults(res.results);
      const refreshed = await api.feesPreview(policy);
      setPreview(refreshed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  const rows = preview?.proposals ?? [];
  const pending = itemsToApply(preview).length;
  const applied = results?.filter((r) => r.ok).length ?? 0;
  const failed = results?.filter((r) => !r.ok) ?? [];

  return (
    <section className="panel fees">
      <div className="panel-head">
        <h2>Fee policy</h2>
        {preview ? <span className="change-badge">{preview.changeCount} would change</span> : null}
      </div>

      <div className="dryrun-banner">
        Tune the policy — the table previews proposed fees live (read-only).
        {canWrite ? (
          <> Click <strong>Apply</strong> to write the highlighted changes to your node.</>
        ) : (
          <> Applying is <strong>disabled</strong> (read-only macaroon). Enable writes to apply.</>
        )}
      </div>

      <div className="policy-controls">
        {CONTROLS.map((c) => (
          <label key={c.key} className="policy-field" title={c.hint}>
            <span>{c.label}</span>
            <input
              type="number"
              min={0}
              value={policy[c.key]}
              onChange={(e) => setField(c.key, Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
        ))}
        <button className="reset" onClick={() => setPolicy(DEFAULT_POLICY)}>
          reset
        </button>
      </div>

      {error ? <p className="banner error">{error}</p> : null}

      <table className="fee-table">
        <thead>
          <tr>
            <th>Peer</th>
            <th className="num">Local</th>
            <th className="num">Current</th>
            <th className="num">Proposed</th>
            <th className="num">Δ ppm</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr
              key={p.id}
              className={`${p.active ? "" : "inactive"} ${p.willChange ? "changing" : ""}`}
            >
              <td>{p.peerAlias}</td>
              <td className="num">{percent(p.localRatio)}</td>
              <td className="num">{p.currentPpm}</td>
              <td className="num strong">{p.proposedPpm}</td>
              <td className="num"><Delta p={p} /></td>
              <td className="muted reason">{p.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !error ? (
        <p className="muted empty">{preview ? "No channels to set fees on yet." : "Loading proposals…"}</p>
      ) : null}

      <div className="apply-row">
        <button
          className="primary-btn"
          disabled={!canWrite || pending === 0 || applying}
          onClick={apply}
          title={canWrite ? "" : "Enable writes to apply"}
        >
          {applying ? "Applying…" : `Apply ${pending} change${pending === 1 ? "" : "s"} now`}
        </button>
        {results ? (
          <span className="apply-result">
            ✓ {applied} applied{failed.length ? `, ${failed.length} failed` : ""}
          </span>
        ) : null}
      </div>
      {failed.length ? (
        <ul className="fail-list">
          {failed.map((f) => (
            <li key={f.id} className="muted">{f.id}: {f.error}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
