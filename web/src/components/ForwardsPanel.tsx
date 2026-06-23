import { useEffect, useState } from "react";
import { api } from "../api";
import type { DailyBucket, ForwardsReport } from "../types";
import { sats, satsCompact, timeAgo } from "../format";
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

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function ForwardsPanel() {
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<Metric>("fees");
  const [data, setData] = useState<ForwardsReport | null>(null);
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
        <h2>Forwards <span className="muted">· routing report</span></h2>
        <div className="pnl-windows">
          {WINDOWS.map((w) => (
            <button key={w} className={`pnl-win ${days === w ? "active" : ""}`} onClick={() => setDays(w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="banner error">{error}</p> : null}

      <div className="report-stats">
        <Stat label="Forwards" value={String(data?.totalForwards ?? 0)} sub={data?.busiestDay ? `busiest ${data.busiestDay.slice(5)}` : undefined} />
        <Stat label="Routed" value={`${satsCompact(data?.totalRoutedSats ?? 0)} sat`} />
        <Stat label="Fees earned" value={`${sats(data?.totalFeesEarnedSats ?? 0)} sat`} />
        <Stat label="Avg fee" value={`${data?.avgFeePpm ?? 0} ppm`} sub={data ? `max ${satsCompact(data.maxForwardSats)} sat` : undefined} />
      </div>

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

      <h3 className="sub">Per channel</h3>
      <table className="fee-table">
        <thead>
          <tr>
            <th>Peer</th>
            <th className="num">Forwards</th>
            <th className="num">Routed out</th>
            <th className="num">Routed in</th>
            <th className="num">Fees</th>
            <th className="spark-col">Trend</th>
            <th className="share-col">Share</th>
          </tr>
        </thead>
        <tbody>
          {(data?.perChannel ?? []).slice(0, 25).map((c) => (
            <tr key={c.channelId}>
              <td>{c.alias}</td>
              <td className="num">{c.forwardCount}</td>
              <td className="num">{satsCompact(c.routedOutSats)}</td>
              <td className="num">{satsCompact(c.routedInSats)}</td>
              <td className="num earned">{sats(c.feesEarnedSats)}</td>
              <td className="spark-col"><Sparkline data={c.spark} color="var(--green)" /></td>
              <td className="share-col">
                <div className="share-bar">
                  <div className="share-fill" style={{ width: `${((c.routedOutSats + c.routedInSats) / maxRouted) * 100}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!loading && data && data.perChannel.length === 0 ? (
        <p className="muted empty">No forwards in this window yet.</p>
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
