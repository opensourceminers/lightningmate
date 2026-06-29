import { useEffect, useState } from "react";
import { api } from "../api";
import type { CapitalActionKind, CapitalPlan } from "../types";
import { sats } from "../format";

const KIND: Record<CapitalActionKind, { label: string; cls: string }> = {
  keep: { label: "Keep", cls: "keep" },
  reserve: { label: "Reserve", cls: "reserve" },
  close: { label: "Close", cls: "close" },
  open: { label: "Open", cls: "open" },
  lease: { label: "Lease", cls: "lease" },
  hold: { label: "Hold", cls: "hold" },
};

const ppmYr = (n: number | null): string => (n == null ? "—" : `${n.toLocaleString()} ppm/yr`);

/**
 * Capital Allocation Engine — advisory view. Shows the one coordinated plan for
 * "where should my sats go?" ranked by expected yield. Read-only; nothing here
 * executes — it's a recommendation to review.
 */
export function CapitalPanel() {
  const [plan, setPlan] = useState<CapitalPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api
      .capitalPlan()
      .then((p) => {
        setPlan(p);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Capital allocation</h2>
        <button className="refresh" onClick={() => load()}>↻ refresh</button>
      </div>

      <div className="dryrun-banner">
        <strong>“Where should my sats go?”</strong> One coordinated plan across keeping, closing,
        opening, leasing and reserve, ranked by expected yield (ppm/year). The Autopilot already
        uses this engine's <strong>routing-vs-lease</strong> decision to place on-chain capital; the
        close and specific open suggestions below are <strong>advisory</strong> — review before acting.
      </div>

      {error ? <p className="banner error">{error}</p> : null}
      {loading && !plan ? <p className="muted">Computing plan…</p> : null}

      {plan ? (
        <>
          <div className="cap-summary">{plan.summary}</div>

          <div className="cap-stats">
            <div><span>Total capacity</span><b>{sats(plan.totalCapacitySats)}</b></div>
            <div><span>On-chain</span><b>{sats(plan.onchainConfirmedSats)}</b></div>
            <div><span>Deployable</span><b>{sats(plan.deployableSats)}</b></div>
            <div><span>Median yield</span><b>{plan.medianRoutingYieldPpmYear.toLocaleString()} ppm/yr</b></div>
            <div><span>Marginal yield</span><b>{plan.marginalRoutingYieldPpmYear.toLocaleString()} ppm/yr</b></div>
            <div><span>Lease above</span><b>{plan.leaseThresholdPpmYear.toLocaleString()} ppm/yr</b></div>
          </div>

          <ul className="cap-actions">
            {plan.actions.map((a, i) => (
              <li key={i} className="cap-action">
                <span className={`cap-badge ${KIND[a.kind].cls}`}>{KIND[a.kind].label}</span>
                <div className="cap-action-main">
                  <div className="cap-action-head">
                    <span className="cap-action-title">{a.title}</span>
                    <span className="cap-action-meta">
                      {sats(a.sats)} sat · {ppmYr(a.expectedYieldPpmYear)} · {a.confidence}
                    </span>
                  </div>
                  <div className="cap-action-why">{a.rationale}</div>
                </div>
              </li>
            ))}
          </ul>

          {plan.notes.length ? (
            <ul className="cap-notes">
              {plan.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
