import { useEffect, useState } from "react";
import { api } from "../api";
import type {
  RebalanceAnalysis,
  RebalanceCandidate,
  RebalanceLogResponse,
  RebalancePolicy,
} from "../types";
import { percent, sats, satsCompact, timeAgo } from "../format";

type DraftKey =
  | "amountSats"
  | "econRatio"
  | "maxLocalRatioTarget"
  | "minLocalRatioSource"
  | "flowWindowDays";

const DEFAULTS: Pick<RebalancePolicy, DraftKey> = {
  amountSats: 100_000,
  econRatio: 0.8,
  maxLocalRatioTarget: 0.35,
  minLocalRatioSource: 0.65,
  flowWindowDays: 30,
};

const CONTROLS: { key: DraftKey; label: string; step: number; hint: string }[] = [
  { key: "amountSats", label: "Amount (sat)", step: 10_000, hint: "how much to move per rebalance" },
  { key: "econRatio", label: "Econ ratio", step: 0.05, hint: "budget = target fee × this (<1 = margin)" },
  { key: "maxLocalRatioTarget", label: "Target ≤ local", step: 0.05, hint: "only refill channels below this local ratio" },
  { key: "minLocalRatioSource", label: "Source ≥ local", step: 0.05, hint: "only pull from channels above this local ratio" },
  { key: "flowWindowDays", label: "Demand window (d)", step: 1, hint: "lookback for proven outbound demand" },
];

function Verdict({ c }: { c: RebalanceCandidate }) {
  if (c.profitable) return <span className="ap-ok">✓ profitable</span>;
  if (!c.routeFound) return <span className="muted">no route</span>;
  return <span className="ap-fail">✗ too costly</span>;
}

export function RebalancePanel() {
  const [draft, setDraft] = useState<Pick<RebalancePolicy, DraftKey>>(DEFAULTS);
  const [analysis, setAnalysis] = useState<RebalanceAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [log, setLog] = useState<RebalanceLogResponse | null>(null);

  const analyze = async (policy: Pick<RebalancePolicy, DraftKey>) => {
    setLoading(true);
    setError(null);
    try {
      setAnalysis(await api.rebalanceCandidates(policy));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const loadLog = () => api.rebalanceLog().then(setLog).catch(() => {});

  useEffect(() => {
    void analyze(DEFAULTS);
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
    void loadLog();
  }, []);

  const setField = (key: DraftKey, value: number) =>
    setDraft((d) => ({ ...d, [key]: Math.max(0, value || 0) }));

  const rebalance = async (c: RebalanceCandidate) => {
    setRunningId(c.targetId);
    setError(null);
    try {
      const res = await api.rebalanceExecute({
        targetId: c.targetId,
        sourceId: c.sourceId,
        amountSats: c.amountSats,
        econRatio: draft.econRatio,
      });
      if (!res.ok) setError(`${res.targetAlias}: ${res.error}`);
      await Promise.all([loadLog(), analyze(draft)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningId(null);
    }
  };

  const rows = analysis?.candidates ?? [];
  const profitable = rows.filter((c) => c.profitable).length;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Rebalancing <span className="muted">· profit-gated</span></h2>
        {analysis ? <span className="change-badge">{profitable} profitable</span> : null}
      </div>

      <div className="dryrun-banner">
        Finds depleted channels with <strong>proven outbound demand</strong> and checks
        whether refilling them <strong>pays off</strong>: budget = target's outbound fee ×
        econ ratio, vs. the probed route cost.
        {canWrite ? (
          <> Click <strong>Rebalance</strong> to run a profitable one — the budget caps the spend.</>
        ) : (
          <> Executing is <strong>disabled</strong> (read-only). Enable writes in the Autopilot tab.</>
        )}
      </div>

      <div className="policy-controls">
        {CONTROLS.map((c) => (
          <label key={c.key} className="policy-field" title={c.hint}>
            <span>{c.label}</span>
            <input
              type="number"
              min={0}
              step={c.step}
              value={draft[c.key]}
              onChange={(e) => setField(c.key, Number(e.target.value))}
            />
          </label>
        ))}
        <button className="primary-btn" disabled={loading} onClick={() => analyze(draft)}>
          {loading ? "Probing…" : "Analyze"}
        </button>
      </div>

      {error ? <p className="banner error">{error}</p> : null}

      <table className="fee-table">
        <thead>
          <tr>
            <th>Refill (target)</th>
            <th className="num">Local</th>
            <th className="num">Earns</th>
            <th className="num">Demand</th>
            <th>From (source)</th>
            <th className="num">Budget</th>
            <th className="num">Est. cost</th>
            <th>Verdict</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.targetId} className={c.profitable ? "changing" : ""}>
              <td>{c.targetAlias}</td>
              <td className="num">{percent(c.targetLocalRatio)}</td>
              <td className="num">{c.targetOutboundPpm} ppm</td>
              <td className="num">{satsCompact(c.demandSats)}</td>
              <td className="muted">{c.sourceAlias} ({percent(c.sourceLocalRatio)})</td>
              <td className="num">{c.maxFeePpm} ppm</td>
              <td className="num strong">{c.estCostPpm === null ? "—" : `${c.estCostPpm} ppm`}</td>
              <td><Verdict c={c} /></td>
              <td>
                <button
                  className="row-btn"
                  disabled={!canWrite || !c.profitable || runningId !== null}
                  onClick={() => rebalance(c)}
                  title={canWrite ? "" : "Enable writes to execute"}
                >
                  {runningId === c.targetId ? "…" : "Rebalance"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !loading && !error ? (
        <p className="muted empty">
          No rebalance candidates — need depleted channels with recent outbound demand and a
          full source channel to pull from.
        </p>
      ) : null}

      {log && log.records.length > 0 ? (
        <>
          <h3 className="sub">Accounting · executed rebalances</h3>
          <div className="flow-totals">
            <div><strong>{log.summary.count}</strong> done{log.summary.failed ? ` (${log.summary.failed} failed)` : ""}</div>
            <div><strong>{sats(log.summary.totalFeeSats)}</strong> sat spent</div>
            <div><strong>{satsCompact(log.summary.totalAmountSats)}</strong> sat moved</div>
            <div>avg <strong>{log.summary.avgCostPpm}</strong> ppm</div>
          </div>
          <table className="forwards">
            <tbody>
              {log.records.slice(0, 12).map((r, i) => (
                <tr key={`${r.at}-${i}`}>
                  <td className="muted">{timeAgo(r.at)}</td>
                  <td>{r.sourceAlias} → {r.targetAlias}</td>
                  <td className="num">{satsCompact(r.amountSats)}</td>
                  <td className="num">{r.ok ? <span className="earned">{r.feeSats} sat</span> : <span className="ap-fail">fail</span>}</td>
                  <td className="muted">{r.via}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
