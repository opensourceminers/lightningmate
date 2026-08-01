import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChannelForwardStat, DailyBucket, ForwardsReport, UnservedDemandReport } from "../types";
import { sats, satsCompact, timeAgo, percent } from "../format";
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

/** Flow label + the action it implies. "draining" with little local balance
 *  left is the urgent case — the channel will soon stop routing. */
function flowHint(c: ChannelForwardStat): { label: string; cls: string; urgent: boolean } {
  if (c.flow === "draining") {
    const urgent = c.localRatio <= 0.15;
    return {
      label: urgent ? `draining · ${percent(c.localRatio)} left` : "draining",
      cls: urgent ? "flow-drain-urgent" : "flow-drain",
      urgent,
    };
  }
  if (c.flow === "filling") return { label: "filling", cls: "flow-fill", urgent: false };
  return { label: "balanced", cls: "flow-balanced", urgent: false };
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

      {demand && demand.channels.some((c) => c.liquidityCount > 0) ? (
        <div className="dryrun-banner warn">
          <strong>
            {demand.channels.reduce((s, c) => s + c.liquidityCount, 0)} forwards refused for lack of liquidity
          </strong>{" "}
          in the last {Math.max(1, Math.min(demand.days, demand.trackedDays || demand.days))}d —
          demand worth {satsCompact(demand.channels.reduce((s, c) => s + c.liquiditySats, 0))} sat you didn&apos;t
          earn on. Refill the draining channels below (or size them up) to capture it.
        </div>
      ) : null}

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
            <th>Flow</th>
            <th className="num">Forwards</th>
            <th className="num">Routed out</th>
            <th className="num">Routed in</th>
            <th className="num">Fees</th>
            <th className="spark-col">Trend</th>
            <th className="share-col">Share</th>
          </tr>
        </thead>
        <tbody>
          {(data?.perChannel ?? []).slice(0, 25).map((c) => {
            const hint = flowHint(c);
            return (
              <tr key={c.channelId} className={hint.urgent ? "row-urgent" : ""}>
                <td>{c.alias}</td>
                <td><span className={`flow-tag ${hint.cls}`}>{hint.label}</span></td>
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
            The channel pairs carrying your flow. A corridor needs both ends — a source that fills and a
            sink that drains; closing either kills the route.
          </p>
          <table className="fee-table">
            <thead>
              <tr>
                <th>In (source)</th>
                <th>Out (sink)</th>
                <th className="num">Forwards</th>
                <th className="num">Routed</th>
                <th className="num">Fees</th>
              </tr>
            </thead>
            <tbody>
              {data.corridors.map((c) => (
                <tr key={`${c.inChannel}>${c.outChannel}`}>
                  <td>{c.inAlias}</td>
                  <td>{c.outAlias}</td>
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
