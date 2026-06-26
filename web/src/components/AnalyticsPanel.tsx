import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ChannelView, ForwardsReport, MagmaV2Report, RebalanceRecord } from "../types";
import { sats, satsCompact } from "../format";
import { SkeletonPanel } from "./Skeleton";
import { ForwardsPanel } from "./ForwardsPanel";

type Sub = "performance" | "forwards";

const WINDOWS = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

interface ChannelPnl {
  channelId: string;
  alias: string;
  feesEarnedSats: number;
  forwardCount: number;
  routedOutSats: number;
  rebalanceCostSats: number;
  netSats: number;
  spark: number[];
}

function Sparkline({ data }: { data: number[] }) {
  if (!data?.length || data.every((v) => v === 0)) return <span className="muted">—</span>;
  const max = Math.max(1, ...data);
  return (
    <span className="spark" aria-hidden>
      {data.map((v, i) => (
        <i key={i} style={{ height: `${Math.max(6, (v / max) * 100)}%` }} />
      ))}
    </span>
  );
}

function buildPnl(fr: ForwardsReport, records: RebalanceRecord[], days: number): ChannelPnl[] {
  const rows = new Map<string, ChannelPnl>();
  for (const c of fr.perChannel) {
    rows.set(c.channelId, {
      channelId: c.channelId,
      alias: c.alias || c.channelId,
      feesEarnedSats: c.feesEarnedSats,
      forwardCount: c.forwardCount,
      routedOutSats: c.routedOutSats,
      rebalanceCostSats: 0,
      netSats: 0,
      spark: c.spark ?? [],
    });
  }
  const cutoff = Date.now() - days * 86_400_000;
  for (const r of records) {
    if (!r.ok || !r.feeSats || new Date(r.at).getTime() < cutoff) continue;
    const ex =
      rows.get(r.targetId) ??
      ({ channelId: r.targetId, alias: r.targetAlias || r.targetId, feesEarnedSats: 0, forwardCount: 0, routedOutSats: 0, rebalanceCostSats: 0, netSats: 0, spark: [] } as ChannelPnl);
    ex.rebalanceCostSats += r.feeSats;
    rows.set(r.targetId, ex);
  }
  return [...rows.values()]
    .filter((r) => r.forwardCount > 0 || r.rebalanceCostSats > 0)
    .map((r) => ({ ...r, netSats: r.feesEarnedSats - r.rebalanceCostSats }))
    .sort((a, b) => b.netSats - a.netSats);
}

function Kpi({
  label,
  value,
  unit,
  tone,
  sub,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "green" | "cost";
  sub?: string;
}) {
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

function TrendChart({ fr }: { fr: ForwardsReport }) {
  const daily = fr.daily;
  const max = Math.max(1, ...daily.map((d) => d.feesSats));
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

export function AnalyticsPanel({ initialSub }: { initialSub?: string }) {
  const [sub, setSub] = useState<Sub>(initialSub === "forwards" ? "forwards" : "performance");
  const [days, setDays] = useState(30);
  const [fr, setFr] = useState<ForwardsReport | null>(null);
  const [records, setRecords] = useState<RebalanceRecord[]>([]);
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [magma, setMagma] = useState<MagmaV2Report | null>(null);
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

  useEffect(() => {
    api.channels().then((c) => setChannels(c)).catch(() => {});
    api.magmaRecommendations().then(setMagma).catch(() => {});
  }, []);

  const pnl = useMemo(() => (fr ? buildPnl(fr, records, days) : []), [fr, records, days]);

  const kpis = useMemo(() => {
    if (!fr) return null;
    const cutoff = Date.now() - days * 86_400_000;
    const inWindow = records.filter((r) => r.ok && r.feeSats && new Date(r.at).getTime() >= cutoff);
    const rebalCost = inWindow.reduce((s, r) => s + (r.feeSats ?? 0), 0);
    const revenue = fr.totalFeesEarnedSats;
    const net = revenue - rebalCost;
    const totalCap = channels.reduce((s, c) => s + c.capacity, 0);
    const nodeYield = totalCap > 0 ? (revenue / totalCap) * (365 / days) * 100 : 0;
    const magmaNet = magma?.analytics.netProfitSat ?? 0;
    const magmaSold = magma?.analytics.filledOrdersAllTime ?? 0;
    return { revenue, rebalCost, net, rebalCount: inWindow.length, nodeYield, magmaNet, magmaSold };
  }, [fr, records, channels, magma, days]);

  return (
    <div>
      <div className="subnav an-head">
        <div className="an-subnav">
          {([["performance", "Performance"], ["forwards", "Forwards"]] as [Sub, string][]).map(([id, label]) => (
            <button key={id} className={`subtab ${sub === id ? "active" : ""}`} onClick={() => setSub(id)}>
              {label}
            </button>
          ))}
        </div>
        {sub === "performance" ? (
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
      ) : !fr || !kpis ? (
        <SkeletonPanel rows={6} />
      ) : (
        <>
          <div className="an-card-grid">
            <Kpi
              label={`Net profit · ${days}d`}
              value={`${kpis.net >= 0 ? "+" : "−"}${sats(Math.abs(kpis.net))}`}
              unit="sat"
              tone={kpis.net >= 0 ? "green" : "cost"}
              sub="routing revenue − rebalancing"
            />
            <Kpi
              label="Node yield"
              value={kpis.nodeYield.toFixed(2)}
              unit="% APY"
              sub="fees earned on deployed capital"
            />
            <Kpi label="Routing revenue" value={sats(kpis.revenue)} unit="sat" tone="green" sub={`${fr.totalForwards} forwards`} />
            <Kpi label="Routed volume" value={satsCompact(fr.totalRoutedSats)} unit="sat" sub={`avg ${fr.avgFeePpm} ppm earned`} />
            <Kpi
              label="Rebalancing"
              value={kpis.rebalCost ? `−${sats(kpis.rebalCost)}` : "0"}
              unit="sat"
              tone={kpis.rebalCost ? "cost" : undefined}
              sub={`${kpis.rebalCount} run${kpis.rebalCount === 1 ? "" : "s"}`}
            />
            {magma && (kpis.magmaSold > 0 || kpis.magmaNet !== 0) ? (
              <Kpi label="Magma leases" value={`${kpis.magmaNet >= 0 ? "+" : "−"}${sats(Math.abs(kpis.magmaNet))}`} unit="sat" tone="green" sub={`${kpis.magmaSold} sold · net`} />
            ) : null}
          </div>

          <TrendChart fr={fr} />

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
                    <th>Trend</th>
                    <th className="num">Forwards</th>
                    <th className="num">Routed</th>
                    <th className="num">Earned</th>
                    <th className="num">Rebal. cost</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {pnl.map((r) => (
                    <tr key={r.channelId} className={r.netSats < 0 ? "pnl-loser" : ""}>
                      <td className="an-alias">{r.alias}</td>
                      <td><Sparkline data={r.spark} /></td>
                      <td className="num">{r.forwardCount}</td>
                      <td className="num">{r.routedOutSats ? satsCompact(r.routedOutSats) : "—"}</td>
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
