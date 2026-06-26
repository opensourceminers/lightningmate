import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type { FeeApplyItem, FeeRecReport, FeeRecState } from "../types";
import { satsCompact } from "../format";

const STATE_LABEL: Record<FeeRecState, string> = {
  normal: "normal",
  exploring_lower_fee: "exploring ↓",
  protecting_liquidity: "protecting",
  recovering_cost: "recovering cost",
  close_candidate: "close candidate",
};
const STATE_CLASS: Record<FeeRecState, string> = {
  normal: "s-normal",
  exploring_lower_fee: "s-explore",
  protecting_liquidity: "s-protect",
  recovering_cost: "s-cost",
  close_candidate: "s-close",
};

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function FeeRecommendations() {
  const [data, setData] = useState<FeeRecReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<number | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const load = () =>
    api
      .feesRecommendations()
      .then((r) => (setData(r), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
  }, []);

  const wouldApply = data?.recommendations.filter((r) => r.wouldApply) ?? [];
  const apply = async () => {
    const items: FeeApplyItem[] = wouldApply
      .filter((r) => r.transactionId !== null && r.transactionVout !== null)
      .map((r) => ({
        id: r.channelId,
        transactionId: r.transactionId as string,
        transactionVout: r.transactionVout as number,
        feeRatePpm: r.targetPpm,
        baseFeeMsat: r.currentBaseMsat,
      }));
    if (!items.length) return;
    setApplying(true);
    setApplied(null);
    try {
      const res = await api.feesApply(items);
      setApplied(res.results.filter((r) => r.ok).length);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="panel feerec">
      <div className="panel-head">
        <h2>
          Smart fees <span className="v2-badge">v2</span>
        </h2>
        <div className="head-actions">
          {data ? <span className="change-badge">{wouldApply.length} to change</span> : null}
          {canWrite && wouldApply.length > 0 ? (
            <button className="primary-btn" disabled={applying} onClick={() => void apply()}>
              {applying ? "Applying…" : `Apply ${wouldApply.length}`}
            </button>
          ) : null}
          {applied != null ? <span className="apply-result">✓ {applied} applied</span> : null}
        </div>
      </div>

      <div className="dryrun-banner">
        The fees the autopilot applies when <strong>Fee automation</strong> is on — protect nearly-drained
        channels, never route below your refill cost, react to real demand. Apply them now, or let the autopilot
        manage them.{canWrite ? null : <> Applying is disabled (read-only macaroon).</>}
      </div>

      {error ? <p className="banner error">{error}</p> : null}
      {!data && !error ? <p className="muted">Computing recommendations…</p> : null}

      {data ? (
        <>
          <div className="feerec-chips">
            {(["protecting_liquidity", "recovering_cost", "exploring_lower_fee", "close_candidate"] as FeeRecState[]).map((s) => {
              const n = data.recommendations.filter((r) => r.state === s).length;
              return n ? (
                <span key={s} className={`feerec-chip ${STATE_CLASS[s]}`}>
                  {n} {STATE_LABEL[s]}
                </span>
              ) : null;
            })}
            <span className="feerec-bench muted">
              node median {data.nodeBenchmarks.medianGrossFlow14d.toFixed(2)}× flow/14d ·{" "}
              {Math.round(data.nodeBenchmarks.medianRevenuePpm30d)} ppm earned (median)
            </span>
          </div>

          <table className="fee-table feerec-table">
            <thead>
              <tr>
                <th></th>
                <th>Channel</th>
                <th className="num">Local</th>
                <th className="num">Current → Target</th>
                <th>State</th>
                <th>Apply</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {[...data.recommendations]
                .sort(
                  (a, b) =>
                    Number(b.wouldApply) - Number(a.wouldApply) ||
                    Math.abs(b.targetPpm - b.currentPpm) - Math.abs(a.targetPpm - a.currentPpm),
                )
                .map((r) => {
                  const isOpen = open.has(r.channelId);
                  const cls = r.targetPpm > r.currentPpm ? "delta-up" : r.targetPpm < r.currentPpm ? "delta-down" : "";
                  const m = r.metrics;
                  return (
                    <Fragment key={r.channelId}>
                      <tr className={`feerec-row ${r.wouldApply ? "changing" : ""}`} onClick={() => toggle(r.channelId)}>
                        <td className="feerec-caret">{isOpen ? "▾" : "▸"}</td>
                        <td>
                          {r.alias}
                          {m.isTopEarner ? <span className="top-earner" title="top earner"> ★</span> : null}
                        </td>
                        <td className="num">{pct(m.localRatio)}</td>
                        <td className="num">
                          <span className="muted">{r.currentPpm}</span> → <strong className={cls}>{r.targetPpm}</strong>
                        </td>
                        <td>
                          <span className={`feerec-state ${STATE_CLASS[r.state]}`}>{STATE_LABEL[r.state]}</span>
                        </td>
                        <td>
                          {r.wouldApply ? (
                            <span className="apply-yes">✓</span>
                          ) : (
                            <span className="apply-no" title={r.blockedByGuards.join(", ")}>—</span>
                          )}
                        </td>
                        <td className="muted reason">{r.reasons[0]}</td>
                      </tr>
                      {isOpen ? (
                        <tr className="feerec-detail-row">
                          <td></td>
                          <td colSpan={6}>
                            <div className="feerec-detail">
                              <div className="feerec-reasons">
                                {r.reasons.map((x, i) => (
                                  <div key={i}>• {x}</div>
                                ))}
                                {r.blockedByGuards.map((g, i) => (
                                  <div key={`g${i}`} className="muted">
                                    ⊘ guard: {g}
                                  </div>
                                ))}
                              </div>
                              <div className="feerec-metrics">
                                <span>14d flow <b>{satsCompact(m.routedOut14d)}↑ / {satsCompact(m.routedIn14d)}↓</b></span>
                                <span>gross <b>{m.grossFlow14d.toFixed(2)}×</b> · net drain <b>{pct(m.netDrain14d)}</b></span>
                                <span>earned 30d <b>{satsCompact(m.revenue30d)} sat</b>{m.revenuePpm30d != null ? ` · ${m.revenuePpm30d} ppm` : ""}</span>
                                <span>cost basis <b>{m.costBasisPpm != null ? `${m.costBasisPpm} ppm` : "—"}</b>{m.profitFloorPpm != null ? ` · floor ${m.profitFloorPpm}` : ""}</span>
                                <span>peer <b className={m.peerGate === "ok" ? "ok" : "warn"}>{m.peerGate}</b> · {m.role} · target {pct(m.targetLocalRatio)}{m.channelAgeDays != null ? ` · ${m.channelAgeDays}d old` : ""}</span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
