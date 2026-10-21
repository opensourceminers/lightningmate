import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type {
  FeeMode,
  OverrideMap,
  RebalanceLogResponse,
  RebalanceRecReport,
  RebalanceRecState,
  RebalanceRecommendation,
  RefillInFlight,
  UnservedDemandReport,
} from "../types";
import { sats, satsCompact, timeAgo } from "../format";
import { demandSummary } from "../feeView";
import {
  afterRefillText,
  budgetBlocked,
  budgetLine,
  confirmRefillText,
  inFlightLine,
  inFlightThrough,
  manualRefillRequest,
  refillOutcome,
  stalePlanRefusal,
} from "../rebalanceView";
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

/** A recommended row's run area: the Run button — or, while a payment
 *  through one of its channels may still land, why there is none (the
 *  server refuses a refill there until LND says how that payment ended). */
export function RefillAction(props: { r: RebalanceRecommendation; inFlight: RefillInFlight[] | undefined; running: boolean; onRun: () => void }) {
  const busy = inFlightThrough(props.r, props.inFlight);
  if (busy) return <p className="muted small">{inFlightLine(busy)}</p>;
  return (
    <div className="apply-row">
      <button
        className="primary-btn"
        disabled={props.running}
        onClick={(e) => {
          e.stopPropagation();
          props.onRun();
        }}
      >
        {props.running ? "Running…" : `Run rebalance — move ${satsCompact(props.r.recommendedAmount ?? 0)}`}
      </button>
    </div>
  );
}

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

  const [demand, setDemand] = useState<UnservedDemandReport | null>(null);

  useEffect(() => {
    void load();
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
    api.rebalanceLog().then(setLog).catch(() => {});
    api.overrides().then(setOverrides).catch(() => {});
    api.htlcDemand(7).then(setDemand).catch(() => {});
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
    // The fee caps the dialog promises and the gate go with it (the server
    // caps it at what is left of today's budget as well).
    // The plan's time goes with it: a row whose target was refilled since
    // the plan was made is refused (409 stale_plan) and the plan reloaded.
    const request = manualRefillRequest(r, data?.config?.profitShare, data?.generatedAt);
    if (!request) return;
    const ok = await ui.confirm({
      title: "Run rebalance",
      message: confirmRefillText(r, data?.budget),
      confirmLabel: "Run it",
    });
    if (!ok) return;
    setRunning(r.channelId);
    try {
      const res = await api.rebalanceExecute(request);
      const outcome = refillOutcome(res);
      ui.toast(outcome.text, outcome.kind);
      await Promise.all([load(), api.rebalanceLog().then(setLog).catch(() => {})]);
    } catch (e) {
      const stale = stalePlanRefusal(e);
      if (stale) {
        ui.toast(stale, "info");
        await load();
      } else {
        ui.toast(e instanceof Error ? e.message : String(e), "error");
      }
    } finally {
      setRunning(null);
    }
  };

  const rows = (data?.recommendations ?? [])
    .filter((r) => r.state !== "not_needed")
    .sort((a, b) => Number(b.wouldRebalance) - Number(a.wouldRebalance));
  const s = data?.summary;
  // The table only once refusals have been sorted long enough: before, its
  // "possible demand" column would read 0 for refusals not sorted yet.
  const demandSum = demandSummary(demand);

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
        (raise the fee first). A refill is valued at the fee the fee engine charges after it, which it then keeps until
        the refilled sats have routed out; its payment can't pay more than that check allows. The autopilot runs the
        profitable ones when <strong>Auto-rebalance</strong> is on; you can also run one now — checked and held the
        same way.
        {canWrite ? null : <> Running is disabled (read-only macaroon).</>}
      </div>
      {budgetLine(data?.budget) ? <p className="muted small">{budgetLine(data?.budget)}</p> : null}

      {demand && demandSum?.kind === "sorting" ? (
        <p className="muted small">
          Unserved demand: refused forwards are being sorted into probes, retries and possible demand
          {demandSum.classifiedSince ? ` (sorting began ${timeAgo(demandSum.classifiedSince)})` : ""} — shown after 3 days of it.
        </p>
      ) : demand && demandSum ? (
        <>
          <h3 className="sub">
            Unserved demand <span className="muted">· refused forwards, {demandSum.window}</span>
          </h3>
          <div className="dryrun-banner">
            Payments that wanted to route through these channels but were <strong>refused for lack of
            outbound liquidity</strong>. Most refused HTLCs are not demand: probes (≥ 90% of the channel), retries of
            the same amount and HTLCs bigger than half the channel are counted apart, and only the rest — attempts a
            refilled channel could have carried — is <em>possible</em> demand. A refill still has to pass the profit
            check below.
          </div>
          <table className="fee-table">
            <thead>
              <tr>
                <th>Out channel</th>
                <th className="num" title="distinct attempts a refilled channel could have carried">Possible demand</th>
                <th className="num">Volume (sat)</th>
                <th className="num" title="median size of those attempts">Median</th>
                <th className="num" title="at the channel's current fee">Fees missed</th>
                <th className="num muted" title={`every refusal LND reported in ${demandSum.rawWindow}, probes and retries included`}>
                  Raw refused
                </th>
                <th className="num muted">Probes · retries · too big</th>
              </tr>
            </thead>
            <tbody>
              {demand.channels
                .filter((d) => d.liquidityCount > 0)
                .slice(0, 8)
                .map((d) => (
                  <tr key={d.outChannel}>
                    <td>{d.alias}</td>
                    <td className="num">{d.demandCount}</td>
                    <td className="num">{d.demandCount ? sats(d.demandSats) : "—"}</td>
                    <td className="num">{d.demandMedianSats != null ? satsCompact(d.demandMedianSats) : "—"}</td>
                    <td className="num">{d.missedFeesSats ? `${sats(d.missedFeesSats)} sat` : "—"}</td>
                    <td className="num muted">{d.liquidityCount}</td>
                    <td className="num muted">
                      {d.probeCount} · {d.retryCount} · {d.oversizedCount}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      ) : null}

      {error ? <p className="banner error">{error}</p> : null}
      {!data && !error ? <p className="muted">Probing routes…</p> : null}

      {data?.refill ? (
        <div className="magma-crosslink">
          💡 <strong>Refilling outbound:</strong> {data.refill.note}
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
                        {budgetBlocked(r, data.budget) ? (
                          <span className="feerec-state s-cost" title="Today's fee budget can't pay for it now — it waits for the reset (00:00 UTC)">
                            {" "}budget-blocked
                          </span>
                        ) : null}
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
                              <span>fee <b>{r.currentPpm} ppm</b>{r.feeV2TargetPpm != null ? ` → next ${r.feeV2TargetPpm}` : ""}{r.feeV2AimPpm != null && r.feeV2AimPpm !== r.feeV2TargetPpm ? ` (heading to ${r.feeV2AimPpm})` : ""}{r.profitFloorPpm != null ? ` · floor ${r.profitFloorPpm}` : ""}{r.feeV2State ? ` · ${r.feeV2State}` : ""}</span>
                              <span>14d flow <b>{satsCompact(r.routedOut14d)}↑ / {satsCompact(r.routedIn14d)}↓</b> · net drain {pct(r.netDrain14d)}</span>
                              <span>earned 30d <b>{satsCompact(r.revenue30d)} sat</b>{r.revenuePpm30d != null ? ` · ${r.revenuePpm30d} ppm` : ""}{r.expectedRevenuePpm != null ? ` · expected ${r.expectedRevenuePpm} ppm` : ""}</span>
                              <span>amount: demand-sized <b>{satsCompact(r.demandSizedAmount)}</b> · to target {satsCompact(r.amountToReachTargetLocalRatio)}</span>
                              {r.selectedSourceChannel ? (
                                <span>source <b>{r.sourceCandidates[0]?.alias ?? r.selectedSourceChannel}</b>{r.estimatedRouteFeeSats != null ? ` · route ${sats(r.estimatedRouteFeeSats)} sat` : ""}{r.sourceCandidates[0]?.spareSats ? ` · ${satsCompact(r.sourceCandidates[0].spareSats)} to spare` : ""}</span>
                              ) : null}
                              {r.sourceCandidates.length > 1 ? (
                                <span>
                                  then:{" "}
                                  {r.sourceCandidates
                                    .slice(1)
                                    .map((c) => `${c.alias}${c.rejected ? ` (out: ${c.rejectedReason ?? "no route"})` : ""}`)
                                    .join(", ")}
                                </span>
                              ) : null}
                              <span>max cost <b>{r.maxCostPpm != null ? `${r.maxCostPpm} ppm` : "—"}</b>{r.maxFeeSats != null ? ` · pays at most ${sats(r.maxFeeSats)} sat` : ""} · payback limit {r.maxPaybackDays}d</span>
                              {afterRefillText(r) ? <span>{afterRefillText(r)}</span> : null}
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
                              <RefillAction r={r} inFlight={data.inFlight} running={running === r.channelId} onRun={() => void execute(r)} />
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
