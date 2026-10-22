import { useEffect, useState } from "react";
import { api } from "../api";
import type { DailyBucket, ForwardsReport, UnservedDemandReport } from "../types";
import { sats, satsCompact, timeAgo } from "../format";
import { MIN_DEMAND_DAYS, demandHeadline, demandSummary } from "../feeView";
import { flowHint, forwardsReadNote } from "../analyticsView";
import { Sparkline } from "./Sparkline";

const WINDOWS = [7, 30, 90];
type Metric = "fees" | "volume" | "count";
const METRICS: { key: Metric; label: string }[] = [
  { key: "fees", label: "Fees" },
  { key: "volume", label: "Volume" },
  { key: "count", label: "Count" },
];

function metricValue(d: DailyBucket, m: Metric): number {
  return m === "fees" ? d.feesSats : m === "volume" ? d.routedSats : d.forwards;
}

function Stat({ label, value, unit, sub, tone }: { label: string; value: string; unit?: string; sub?: string; tone?: "green" }) {
  return (
    <div className="an-card">
      <span className="an-card-label">{label}</span>
      <span className={`an-card-val ${tone ?? ""}`}>
        {value}
        {unit ? <span className="an-unit"> {unit}</span> : null}
      </span>
      {sub ? <span className="an-card-sub">{sub}</span> : null}
    </div>
  );
}

export function ForwardsPanel() {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<Metric>("fees");
  const [data, setData] = useState<ForwardsReport | null>(null);
  const [demand, setDemand] = useState<UnservedDemandReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .forwardsReport(days)
      .then((d) => !cancelled && (setData(d), setError(null)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    api
      .htlcDemand(Math.min(days, 30))
      .then((d) => !cancelled && setDemand(d))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [days]);

  const daily = data?.daily ?? [];
  const maxVal = Math.max(1, ...daily.map((d) => metricValue(d, metric)));
  const maxRouted = Math.max(1, ...(data?.perChannel ?? []).map((c) => c.routedOutSats + c.routedInSats));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Routing <span className="muted">· last {days}d</span></h2>
        <div className="pnl-windows">
          {WINDOWS.map((w) => (
            <button key={w} className={`pnl-win ${days === w ? "active" : ""}`} onClick={() => setDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="banner error">{error}</p> : null}
      {data && forwardsReadNote(data) ? <p className="muted small">{forwardsReadNote(data)}</p> : null}

      <div className="an-card-grid">
        <Stat label="Forwards" value={String(data?.totalForwards ?? 0)} sub={data?.busiestDay ? `busiest ${data.busiestDay.slice(5)}` : " "} />
        <Stat label="Routed volume" value={satsCompact(data?.totalRoutedSats ?? 0)} unit="sat" sub={data ? `max ${satsCompact(data.maxForwardSats)} sat` : " "} />
        <Stat label="Fees earned" value={sats(data?.totalFeesEarnedSats ?? 0)} unit="sat" tone="green" sub=" " />
        <Stat label="Avg fee" value={`${data?.avgFeePpm ?? 0}`} unit="ppm" sub="earned per sat routed" />
      </div>

      {(() => {
        // Honest (D20): only the de-noised attempts count as possible demand,
        // what was taken out is said, nothing shows before 3 days of data —
        // and no claim either way before refusals have been sorted that long.
        const d = demandSummary(demand);
        if (!d) return null;
        if (d.kind === "sorting") {
          return (
            <div className="dryrun-banner">
              {d.raw} HTLC{d.raw === 1 ? " was" : "s were"} refused for lack of outbound in {d.rawWindow} — not sorted yet into
              probes, retries and possible demand: sorting began {d.classifiedSince ? timeAgo(d.classifiedSince) : "recently"} (with
              the update), and the breakdown shows after {MIN_DEMAND_DAYS} days of it.
            </div>
          );
        }
        if (d.kind === "none" || d.kind === "none_unsorted") {
          const sorted = (
            <>
              probes ({d.probes}), retries of the same amount ({d.retries})
              {d.oversized ? `, HTLCs bigger than half the channel (${d.oversized})` : ""}
            </>
          );
          return d.kind === "none" ? (
            <div className="dryrun-banner">
              No payment a refilled channel could have carried was turned away in {d.window}: the {d.raw} refused HTLCs were{" "}
              {sorted}.
            </div>
          ) : (
            <div className="dryrun-banner">
              None of the refused HTLCs sorted in {d.window} was a payment a refilled channel could have carried — {sorted}.{" "}
              {d.unclassified} more refused in {d.rawWindow} could not be sorted (from before sorting began, or on a channel of
              unknown size).
            </div>
          );
        }
        return (
          <div className="dryrun-banner warn">
            <strong>{demandHeadline(d)}</strong> — possible demand of {satsCompact(d.sats)} sat
            {d.missedFeesSats ? <> (~{sats(d.missedFeesSats)} sat in fees at your current rates)</> : null}.{" "}
            <span className="muted">
              Of {d.raw} refused HTLCs in {d.rawWindow}, {d.probes} looked like probes (≥ 90% of the channel), {d.retries} were
              retries of the same amount
              {d.oversized ? `, ${d.oversized} were bigger than half the channel` : ""}
              {d.unclassified ? `, ${d.unclassified} could not be sorted` : ""} — not counted.
            </span>
          </div>
        );
      })()}

      <div className="chart-head">
        <span className="sub" style={{ margin: 0 }}>Daily {metric}</span>
        <div className="metric-toggle">
          {METRICS.map((m) => (
            <button key={m.key} className={`metric-btn ${metric === m.key ? "active" : ""}`} onClick={() => setMetric(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="chart">
        {daily.map((d) => {
          const v = metricValue(d, metric);
          return (
            <div
              className="chart-col"
              key={d.date}
              title={`${d.date} · ${d.forwards} fwds · ${satsCompact(d.routedSats)} sat · ${sats(d.feesSats)} sat fees`}
            >
              <div className="chart-bar" style={{ height: `${(v / maxVal) * 100}%` }} />
            </div>
          );
        })}
      </div>
      {daily.length ? (
        <div className="chart-axis">
          <span>{daily[0].date.slice(5)}</span>
          <span>{daily[daily.length - 1].date.slice(5)}</span>
        </div>
      ) : null}

      <h3 className="sub">
        Per channel{data?.perChannel.length ? <span className="muted"> · {data.perChannel.length}</span> : null}
      </h3>
      <table className="fee-table">
        <thead>
          <tr>
            <th>Peer</th>
            <th>Flow</th>
            <th className="num">Forwards</th>
            <th className="num">Routed out</th>
            <th className="num">Routed in</th>
            <th className="num">Fees</th>
            <th className="num" title="Fees of the forwards that came IN through this channel (earned on their outgoing channel)">Brought in</th>
            <th className="spark-col">Trend</th>
            <th className="share-col">Share</th>
          </tr>
        </thead>
        <tbody>
          {(data?.perChannel ?? []).slice(0, 25).map((c) => {
            const hint = flowHint(c);
            return (
              <tr key={c.channelId} className={hint.urgent ? "row-urgent" : ""}>
                <td className="an-alias" title={c.alias}>{c.alias}</td>
                <td><span className={`flow-tag ${hint.cls}`}>{hint.label}</span></td>
                <td className="num">{c.forwardCount}</td>
                <td className="num">{satsCompact(c.routedOutSats)}</td>
                <td className="num">{satsCompact(c.routedInSats)}</td>
                <td className="num earned">{sats(c.feesEarnedSats)}</td>
                <td className="num muted">{c.inboundFeesSats ? sats(c.inboundFeesSats) : "—"}</td>
                <td className="spark-col"><Sparkline data={c.spark} color="var(--green)" /></td>
                <td className="share-col">
                  <div className="share-bar">
                    <div className="share-fill" style={{ width: `${((c.routedOutSats + c.routedInSats) / maxRouted) * 100}%` }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!loading && data && data.perChannel.length === 0 ? (
        <p className="muted empty">No forwards in this window yet.</p>
      ) : null}

      {data && data.corridors.length > 0 ? (
        <>
          <h3 className="sub">Routing corridors <span className="muted">· where flow actually goes</span></h3>
          <p className="hint" style={{ marginTop: 0 }}>
            The channel pairs carrying your flow — liquidity comes IN one side and goes OUT the other. A
            corridor needs both ends; closing either the source or the sink kills the route.
          </p>
          <table className="fee-table">
            <thead>
              <tr>
                <th>Route <span className="muted">· in → out</span></th>
                <th className="num">Forwards</th>
                <th className="num">Routed</th>
                <th className="num">Fees</th>
              </tr>
            </thead>
            <tbody>
              {data.corridors.map((c) => (
                <tr key={`${c.inChannel}>${c.outChannel}`}>
                  <td className="corridor-route">
                    <span className="corridor-in" title={c.inAlias}>{c.inAlias}</span>
                    <span className="corridor-arrow">→</span>
                    <span className="corridor-out" title={c.outAlias}>{c.outAlias}</span>
                  </td>
                  <td className="num">{c.forwards}</td>
                  <td className="num">{satsCompact(c.routedSats)}</td>
                  <td className="num earned">{sats(c.feesSats)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}

      {data && data.recent.length > 0 ? (
        <>
          <h3 className="sub">Recent forwards</h3>
          <table className="fee-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Route (in → out)</th>
                <th className="num">Routed</th>
                <th className="num">Fee earned</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((e, i) => (
                <tr key={`${e.createdAt}-${i}`}>
                  <td className="muted">{timeAgo(e.createdAt)}</td>
                  <td>{e.incoming} → {e.outgoing}</td>
                  <td className="num">{satsCompact(e.tokens)} sat</td>
                  <td className="num earned">+{e.fee} sat</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}
