import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type { FeeMode, OverrideMap, RebalanceLogResponse, RebalanceRecReport, RebalanceRecState } from "../types";
import { sats, satsCompact, timeAgo } from "../format";
import { useUi } from "./Overlay";

const STATE_LABEL: Record<RebalanceRecState, string> = {
  not_needed: "ok",
  watching: "watching",
  fee_adjust_first: "raise fee first",
  profitable_rebalance_candidate: "candidate",
  route_found_profitable: "profitable",
  route_found_too_expensive: "too expensive",
  unprofitable_skip: "skip",
  close_candidate: "close candidate",
};
const STATE_CLASS: Record<RebalanceRecState, string> = {
  not_needed: "s-normal",
  watching: "s-normal",
  fee_adjust_first: "s-cost",
  profitable_rebalance_candidate: "s-explore",
  route_found_profitable: "s-good",
  route_found_too_expensive: "s-protect",
  unprofitable_skip: "s-normal",
  close_candidate: "s-close",
};
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function RebalanceRecommendations() {
  const ui = useUi();
  const [data, setData] = useState<RebalanceRecReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [log, setLog] = useState<RebalanceLogResponse | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<OverrideMap>({});
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
      .rebalanceRecommendations()
      .then((r) => (setData(r), setError(null)))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

  useEffect(() => {
    void load();
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
    api.rebalanceLog().then(setLog).catch(() => {});
    api.overrides().then(setOverrides).catch(() => {});
  }, []);

  const setOv = async (id: string, mode: FeeMode) => {
    try {
      await api.setOverride(id, mode);
      setOverrides(await api.overrides());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const execute = async (r: RebalanceRecReport["recommendations"][number]) => {
    if (!r.selectedSourceChannel || !r.recommendedAmount) return;
    const ok = await ui.confirm({
      title: "Run rebalance",
      message:
        `Move ${satsCompact(r.recommendedAmount)} into ${r.alias} from ${r.sourceCandidates[0]?.alias ?? "a source channel"}, ` +
        `paying at most ${r.maxCostPpm} ppm (~${sats(r.maxCostSatsByPayback ?? 0)} sat)? This sends a real payment.`,
      confirmLabel: "Run it",
    });
    if (!ok) return;
    setRunning(r.channelId);
    try {
      const res = await api.rebalanceExecute({
        targetId: r.channelId,
        sourceId: r.selectedSourceChannel,
        amountSats: r.recommendedAmount,
        econRatio: 0.8,
        maxFeePpm: r.maxCostPpm ?? undefined,
      });
      ui.toast(
        res.ok ? `Rebalanced ${satsCompact(res.amountSats)} for ${res.feeSats} sat` : `Failed: ${res.error}`,
        res.ok ? "success" : "error",
      );
      await Promise.all([load(), api.rebalanceLog().then(setLog).catch(() => {})]);
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setRunning(null);
    }
  };

  const rows = (data?.recommendations ?? [])
    .filter((r) => r.state !== "not_needed")
    .sort((a, b) => Number(b.wouldRebalance) - Number(a.wouldRebalance));
  const s = data?.summary;

  return (
    <section className="panel feerec">
      <div className="panel-head">
        <h2>
          Smart rebalance <span className="v2-badge">v1</span>
        </h2>
        {s ? <span className="change-badge">{s.profitableRecommendations} worth doing</span> : null}
      </div>

      <div className="dryrun-banner">
        Rebalance only when it pays back — and never refill liquidity Fee Autopilot says is being sold too cheaply
        (raise the fee first). The autopilot runs the profitable ones when <strong>Auto-rebalance</strong> is on;
        you can also run one now.{canWrite ? null : <> Running is disabled (read-only macaroon).</>}
      </div>

      {error ? <p className="banner error">{error}</p> : null}
      {!data && !error ? <p className="muted">Probing routes…</p> : null}

      {data?.inbound && data.inbound.cheapest !== "none" ? (
        <div className={`magma-crosslink ${data.inbound.cheapest === "magma" ? "" : ""}`}>
          💡 <strong>Cheapest inbound:</strong> {data.inbound.note}
          {data.inbound.rebalanceTypicalPpm != null || data.inbound.magmaCheapestPpm != null ? (
            <span className="muted">
              {" "}
              · raising the fee + waiting is always free (just slower).
            </span>
          ) : null}
        </div>
      ) : null}

      {s ? (
        <div className="feerec-chips">
          {s.profitableRecommendations ? <span className="feerec-chip s-good">{s.profitableRecommendations} profitable</span> : null}
          {s.feeAdjustFirstCount ? <span className="feerec-chip s-cost">{s.feeAdjustFirstCount} raise fee first</span> : null}
          {s.tooExpensiveCount ? <span className="feerec-chip s-protect">{s.tooExpensiveCount} too expensive</span> : null}
          {s.closeCandidateCount ? <span className="feerec-chip s-close">{s.closeCandidateCount} close candidate</span> : null}
          <span className="feerec-bench muted">
            {s.profitableRecommendations
              ? `+${sats(s.expectedTotalNetProfitSats)} sat expected net for ${sats(s.expectedTotalCostSats)} sat cost`
              : "nothing worth rebalancing right now"}
          </span>
        </div>
      ) : null}

      {data ? (
        <table className="fee-table feerec-table">
          <thead>
            <tr>
              <th></th>
              <th>Channel</th>
              <th className="num">Local</th>
              <th>State</th>
              <th className="num">Amount</th>
              <th className="num">Cost / max</th>
              <th className="num">Payback</th>
              <th className="num">Net</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted empty">
                  No drained channels need attention — nothing to rebalance.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isOpen = open.has(r.channelId);
                return (
                  <Fragment key={r.channelId}>
                    <tr className={`feerec-row ${r.wouldRebalance ? "changing" : ""}`} onClick={() => toggle(r.channelId)}>
                      <td className="feerec-caret">{isOpen ? "▾" : "▸"}</td>
                      <td>{r.alias}</td>
                      <td className="num">{pct(r.localRatio)}</td>
                      <td>
                        <span className={`feerec-state ${STATE_CLASS[r.state]}`}>{STATE_LABEL[r.state]}</span>
                      </td>
                      <td className="num">{r.recommendedAmount ? satsCompact(r.recommendedAmount) : "—"}</td>
                      <td className="num">
                        {r.estimatedRouteCostPpm != null ? `${r.estimatedRouteCostPpm}` : "—"}
                        {r.maxCostPpm != null ? <span className="muted"> / {r.maxCostPpm}</span> : null}
                      </td>
                      <td className="num">{r.expectedPaybackDays != null ? `${r.expectedPaybackDays}d` : "—"}</td>
                      <td className={`num ${r.expectedNetProfitSats != null ? (r.expectedNetProfitSats >= 0 ? "green" : "cost") : ""}`}>
                        {r.expectedNetProfitSats != null ? `${r.expectedNetProfitSats >= 0 ? "+" : ""}${r.expectedNetProfitSats}` : "—"}
                      </td>
                    </tr>
                    {isOpen ? (
                      <tr className="feerec-detail-row">
                        <td></td>
                        <td colSpan={7}>
                          <div className="feerec-detail">
                            <div className="feerec-reasons">
                              {r.reasons.map((x, i) => (
                                <div key={i}>• {x}</div>
                              ))}
                              {r.blockedBy.map((g, i) => (
                                <div key={`b${i}`} className="muted">
                                  ⊘ {g}
                                </div>
                              ))}
                            </div>
                            <div className="feerec-metrics">
                              <span>fee <b>{r.currentPpm} ppm</b>{r.feeV2TargetPpm != null ? ` → v2 target ${r.feeV2TargetPpm}` : ""}{r.profitFloorPpm != null ? ` · floor ${r.profitFloorPpm}` : ""}{r.feeV2State ? ` · ${r.feeV2State}` : ""}</span>
                              <span>14d flow <b>{satsCompact(r.routedOut14d)}↑ / {satsCompact(r.routedIn14d)}↓</b> · net drain {pct(r.netDrain14d)}</span>
                              <span>earned 30d <b>{satsCompact(r.revenue30d)} sat</b>{r.revenuePpm30d != null ? ` · ${r.revenuePpm30d} ppm` : ""}{r.expectedRevenuePpm != null ? ` · expected ${r.expectedRevenuePpm} ppm` : ""}</span>
                              <span>amount: demand-sized <b>{satsCompact(r.demandSizedAmount)}</b> · to target {satsCompact(r.amountToReachTargetLocalRatio)}</span>
                              {r.selectedSourceChannel ? (
                                <span>source <b>{r.sourceCandidates[0]?.alias ?? r.selectedSourceChannel}</b>{r.estimatedRouteFeeSats != null ? ` · route ${sats(r.estimatedRouteFeeSats)} sat` : ""}</span>
                              ) : null}
                              <span>max cost <b>{r.maxCostPpm != null ? `${r.maxCostPpm} ppm` : "—"}</b> · payback limit {r.maxPaybackDays}d</span>
                            </div>
                            <div className="ov-control">
                              <span className="ov-label">Autopilot:</span>
                              <button
                                className={`ov-btn ${(overrides[r.channelId]?.mode ?? "auto") !== "exclude" ? "active" : ""}`}
                                onClick={() => void setOv(r.channelId, "auto")}
                              >
                                auto
                              </button>
                              <button
                                className={`ov-btn ${overrides[r.channelId]?.mode === "exclude" ? "active" : ""}`}
                                onClick={() => void setOv(r.channelId, "exclude")}
                              >
                                exclude
                              </button>
                            </div>
                            {r.wouldRebalance && canWrite ? (
                              <div className="apply-row">
                                <button
                                  className="primary-btn"
                                  disabled={running === r.channelId}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void execute(r);
                                  }}
                                >
                                  {running === r.channelId
                                    ? "Running…"
                                    : `Run rebalance — move ${satsCompact(r.recommendedAmount ?? 0)}`}
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      ) : null}

      {log && log.records.length ? (
        <div className="rbr-log">
          <div className="panel-head">
            <h2>Recent rebalances</h2>
            <span className="muted">
              {log.summary.count} done · {sats(log.summary.totalFeeSats)} sat fees · avg {log.summary.avgCostPpm} ppm
            </span>
          </div>
          <div className="feed">
            {log.records.slice(0, 8).map((r, i) => (
              <div className="feed-row" key={`${r.at}-${i}`}>
                <span className={`feed-dot ${r.ok ? "k-forward" : "k-sent"}`} />
                <div className="feed-main">
                  <span className="feed-title">
                    {r.sourceAlias} → {r.targetAlias} · {satsCompact(r.amountSats)} sat
                  </span>
                  <span className="feed-sub">
                    {r.ok ? `${r.feeSats} sat · ${r.costPpm} ppm` : r.error ?? "failed"} · {r.via}
                  </span>
                </div>
                <span className="feed-time">{timeAgo(r.at)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
