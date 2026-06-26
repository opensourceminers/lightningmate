import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ForwardsReport, RebalanceRecord } from "../types";
import { sats, satsCompact } from "../format";
import { SkeletonPanel } from "./Skeleton";
import { ForwardsPanel } from "./ForwardsPanel";

type Sub = "trends" | "pnl" | "forwards";

const WINDOWS = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

interface ChannelPnl {
  channelId: string;
  alias: string;
  feesEarnedSats: number;
  forwardCount: number;
  rebalanceCostSats: number;
  netSats: number;
}

function buildPnl(fr: ForwardsReport, records: RebalanceRecord[], days: number): ChannelPnl[] {
  const rows = new Map<string, ChannelPnl>();
  for (const c of fr.perChannel) {
    rows.set(c.channelId, {
      channelId: c.channelId,
      alias: c.alias || c.channelId,
      feesEarnedSats: c.feesEarnedSats,
      forwardCount: c.forwardCount,
      rebalanceCostSats: 0,
      netSats: 0,
    });
  }
  const cutoff = Date.now() - days * 86_400_000;
  for (const r of records) {
    if (!r.ok || !r.feeSats || new Date(r.at).getTime() < cutoff) continue;
    const ex =
      rows.get(r.targetId) ??
      ({ channelId: r.targetId, alias: r.targetAlias || r.targetId, feesEarnedSats: 0, forwardCount: 0, rebalanceCostSats: 0, netSats: 0 } as ChannelPnl);
    ex.rebalanceCostSats += r.feeSats;
    rows.set(r.targetId, ex);
  }
  return [...rows.values()]
    .filter((r) => r.forwardCount > 0 || r.rebalanceCostSats > 0)
    .map((r) => ({ ...r, netSats: r.feesEarnedSats - r.rebalanceCostSats }))
    .sort((a, b) => b.netSats - a.netSats);
}

function TrendChart({ fr }: { fr: ForwardsReport }) {
  const daily = fr.daily;
  const max = Math.max(1, ...daily.map((d) => d.feesSats));
  // Growth: second half vs first half of the window.
  const mid = Math.floor(daily.length / 2);
  const firstHalf = daily.slice(0, mid).reduce((s, d) => s + d.feesSats, 0);
  const secondHalf = daily.slice(mid).reduce((s, d) => s + d.feesSats, 0);
  const growth = firstHalf > 0 ? Math.round(((secondHalf - firstHalf) / firstHalf) * 100) : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Earnings trend</h2>
        {growth !== null ? (
          <span className={`trend-badge ${growth >= 0 ? "up" : "down"}`}>
            {growth >= 0 ? "▲" : "▼"} {Math.abs(growth)}% vs first half
          </span>
        ) : null}
      </div>
      <div className="an-kpis">
        <div className="an-kpi">
          <span className="an-kpi-label">Fees earned</span>
          <span className="an-kpi-val green">{sats(fr.totalFeesEarnedSats)} <span className="an-unit">sat</span></span>
        </div>
        <div className="an-kpi">
          <span className="an-kpi-label">Forwards</span>
          <span className="an-kpi-val">{fr.totalForwards}</span>
        </div>
        <div className="an-kpi">
          <span className="an-kpi-label">Routed volume</span>
          <span className="an-kpi-val">{satsCompact(fr.totalRoutedSats)} <span className="an-unit">sat</span></span>
        </div>
        <div className="an-kpi">
          <span className="an-kpi-label">Avg fee</span>
          <span className="an-kpi-val">{fr.avgFeePpm} <span className="an-unit">ppm</span></span>
        </div>
      </div>
      <div className="an-chart" title="Fees earned per day">
        {daily.map((d) => (
          <div className="an-bar-wrap" key={d.date} title={`${d.date}: ${sats(d.feesSats)} sat · ${d.forwards} fwd`}>
            <div className="an-bar" style={{ height: `${Math.max(2, (d.feesSats / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="an-chart-axis">
        <span>{daily[0]?.date.slice(5) ?? ""}</span>
        <span className="muted">fees earned / day</span>
        <span>{daily[daily.length - 1]?.date.slice(5) ?? ""}</span>
      </div>
    </section>
  );
}

export function AnalyticsPanel() {
  const [sub, setSub] = useState<Sub>("trends");
  const [days, setDays] = useState(30);
  const [fr, setFr] = useState<ForwardsReport | null>(null);
  const [records, setRecords] = useState<RebalanceRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFr(null);
    Promise.all([api.forwardsReport(days), api.rebalanceLog()])
      .then(([f, l]) => {
        if (cancelled) return;
        setFr(f);
        setRecords(l.records);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [days]);

  const pnl = useMemo(() => (fr ? buildPnl(fr, records, days) : []), [fr, records, days]);

  return (
    <div>
      <div className="subnav an-head">
        <div className="an-subnav">
          {([["trends", "Trends"], ["pnl", "Channel P&L"], ["forwards", "Forwards"]] as [Sub, string][]).map(([id, label]) => (
            <button key={id} className={`subtab ${sub === id ? "active" : ""}`} onClick={() => setSub(id)}>
              {label}
            </button>
          ))}
        </div>
        {sub !== "forwards" ? (
          <div className="pnl-windows">
            {WINDOWS.map((w) => (
              <button key={w.days} className={`pnl-win ${days === w.days ? "active" : ""}`} onClick={() => setDays(w.days)}>
                {w.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {sub === "forwards" ? (
        <ForwardsPanel />
      ) : error ? (
        <p className="banner error">{error}</p>
      ) : !fr ? (
        <SkeletonPanel rows={6} />
      ) : sub === "trends" ? (
        <TrendChart fr={fr} />
      ) : (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>Channel profitability <span className="muted">· fees earned − rebalancing cost</span></h2>
            </div>
            {pnl.length === 0 ? (
              <p className="muted empty">No routing or rebalancing in this window yet.</p>
            ) : (
              <table className="fee-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th className="num">Forwards</th>
                    <th className="num">Earned</th>
                    <th className="num">Rebal. cost</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.map((r) => (
                    <tr key={r.channelId} className={r.netSats < 0 ? "pnl-loser" : ""}>
                      <td className="an-alias">{r.alias}</td>
                      <td className="num">{r.forwardCount}</td>
                      <td className="num green">{r.feesEarnedSats ? sats(r.feesEarnedSats) : "—"}</td>
                      <td className="num cost">{r.rebalanceCostSats ? `−${sats(r.rebalanceCostSats)}` : "—"}</td>
                      <td className={`num net ${r.netSats >= 0 ? "green" : "cost"}`}>
                        {r.netSats >= 0 ? "+" : "−"}
                        {sats(Math.abs(r.netSats))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
