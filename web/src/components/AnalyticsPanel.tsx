import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { BoughtInboundResponse, ChannelView, ForwardsReport, MagmaV2Report, OutcomesReport, RebalanceCostsResponse } from "../types";
import { sats, satsCompact, timeAgo } from "../format";
import { routingYield } from "../yieldView";
import { feeTuningKpi } from "../feeView";
import { CHANNEL_PNL_CAPTION, channelPnlRows, forwardsReadNote, rebalanceCostSub, rebalanceRoiKpi, trendBadge, type ChannelPnlRow } from "../analyticsView";
import { SkeletonPanel } from "./Skeleton";
import { ForwardsPanel } from "./ForwardsPanel";
import { Sparkline } from "./Sparkline";

type Sub = "performance" | "forwards";

const WINDOWS = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
];

function Kpi({
  label,
  value,
  unit,
  tone,
  sub,
  title,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "green" | "cost";
  sub?: string;
  title?: string;
}) {
  return (
    <div className="an-card" title={title}>
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
  // Equal spans ending now (server-side): the partial day no longer tilts it.
  const badge = trendBadge(fr);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Earnings trend</h2>
        {badge ? (
          <span className={`trend-badge ${badge.up ? "up" : "down"}`} title={badge.title}>
            {badge.text}
          </span>
        ) : null}
      </div>
      <div className="an-chart" title="Fees earned per day (your local days; the first and last are partial)">
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

/** Per-channel profitability. Its Net column is the channel's own (fees
 *  earned − rebalancing); what it brought in stands beside it, and the rows
 *  rank by both — the heading says exactly that (CHANNEL_PNL_CAPTION). */
export function ChannelProfitability({ rows }: { rows: ChannelPnlRow[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Channel profitability <span className="muted">· {CHANNEL_PNL_CAPTION}</span>
        </h2>
      </div>
      {rows.length === 0 ? (
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
              <th className="num" title="Fees of the forwards that came IN through this channel — earned on the channel they left by">
                Brought in
              </th>
              <th className="num">Rebal. cost</th>
              <th className="num" title="Fees earned − rebalancing cost (what it brought in is not in it)">
                Net
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.channelId} className={r.contributionSats < 0 ? "pnl-loser" : ""}>
                <td className="an-alias">
                  {r.alias}
                  {r.status === "closed" ? <span className="muted"> · closed</span> : null}
                </td>
                <td>
                  {r.spark.length >= 2 && r.spark.some((v) => v > 0) ? (
                    <Sparkline data={r.spark} width={84} height={22} color="var(--green)" />
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="num">
                  {r.forwardCount}
                  {r.inboundForwardCount ? <span className="muted"> / {r.inboundForwardCount} in</span> : null}
                </td>
                <td className="num">{r.routedOutSats ? satsCompact(r.routedOutSats) : "—"}</td>
                <td className="num green">{r.feesEarnedSats ? sats(r.feesEarnedSats) : "—"}</td>
                <td className="num muted">{r.assistedSats ? `+${sats(r.assistedSats)}` : "—"}</td>
                <td className="num cost">{r.rebalanceCostSats ? `−${sats(r.rebalanceCostSats)}` : "—"}</td>
                <td
                  className={`num net ${r.netSats >= 0 ? "green" : "cost"}`}
                  title={`earned − rebalancing; with what it brought in: ${r.contributionSats >= 0 ? "+" : "−"}${sats(Math.abs(r.contributionSats))}`}
                >
                  {r.netSats >= 0 ? "+" : "−"}
                  {sats(Math.abs(r.netSats))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RefillsTable({ outcomes }: { outcomes: OutcomesReport }) {
  const r = outcomes.rebalances;
  if (r.items.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Refills <span className="muted">· what each earned back</span>
        </h2>
      </div>
      <p className="muted small">{r.method}</p>
      <table className="fee-table">
        <thead>
          <tr>
            <th>Channel</th>
            <th className="num">Refilled</th>
            <th className="num">Cost</th>
            <th className="num" title="Its own sats that routed out since, first in first out">Routed out</th>
            <th className="num">Earned</th>
            <th className="num">Back</th>
          </tr>
        </thead>
        <tbody>
          {r.items.slice(0, 12).map((i) => (
            <tr key={`${i.targetId}-${i.at}`} className={i.status === "measuring" ? "muted" : ""}>
              <td className="an-alias" title={`sent ${timeAgo(i.at)}`}>
                {i.alias}
              </td>
              <td className="num">{satsCompact(i.amountSats)}</td>
              <td className="num cost">−{sats(i.costSats)}</td>
              <td className="num" title={i.otherOutSats ? `${satsCompact(i.otherOutSats)} left by payments (no fee)` : undefined}>
                {satsCompact(i.routedOutSats)}
                {i.remainingSats > 0 ? <span className="muted"> · {satsCompact(i.remainingSats)} still in</span> : null}
              </td>
              <td className="num green">{sats(i.earnedSats)}</td>
              <td className={`num net ${i.status === "measuring" ? "muted" : i.paidBack ? "green" : "cost"}`}>
                {i.status === "measuring" ? "measuring" : `${i.earnedBackPct}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function BoughtInbound({ data }: { data: BoughtInboundResponse }) {
  if (data.items.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Bought inbound <span className="muted">· what it brought in</span>
        </h2>
      </div>
      <p className="muted small">{data.method}</p>
      <table className="fee-table">
        <thead>
          <tr>
            <th>Channel</th>
            <th className="num">Size</th>
            <th className="num">Cost</th>
            <th className="num">Forwards in</th>
            <th className="num">Fees brought in</th>
            <th className="num">Return</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((p) => (
            <tr key={p.orderId}>
              <td className="an-alias" title={`order ${p.orderId} · ${p.leaseDays}-day lease ${p.running ? `until ${p.leaseEndsAt.slice(0, 10)} (so far)` : "ended"}`}>
                {p.alias || p.channelId || "channel not found"}
              </td>
              <td className="num">{satsCompact(p.sizeSats)}</td>
              <td className="num cost">−{sats(p.costSats)}</td>
              <td className="num">{p.inboundForwards}</td>
              <td className="num green">{sats(p.inboundFeesSats)}</td>
              <td className={`num net ${p.roiPct === null ? "muted" : p.roiPct >= 100 ? "green" : "cost"}`}>
                {p.roiPct === null ? "—" : `${p.roiPct}%${p.running ? " so far" : ""}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function AnalyticsPanel({ initialSub }: { initialSub?: string }) {
  const [sub, setSub] = useState<Sub>(initialSub === "forwards" ? "forwards" : "performance");
  const [days, setDays] = useState(30);
  const [fr, setFr] = useState<ForwardsReport | null>(null);
  const [costs, setCosts] = useState<RebalanceCostsResponse | null>(null);
  const [channels, setChannels] = useState<ChannelView[]>([]);
  const [magma, setMagma] = useState<MagmaV2Report | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomesReport | null>(null);
  const [bought, setBought] = useState<BoughtInboundResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFr(null);
    // The window's rebalancing from every refill in it (LND's payments,
    // every tool's) — the newest 50 log records covered about two weeks.
    Promise.all([api.forwardsReport(days), api.rebalanceCosts(days)])
      .then(([f, c]) => {
        if (cancelled) return;
        setFr(f);
        setCosts(c);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    api
      .boughtInbound(days)
      .then((b) => !cancelled && setBought(b))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [days]);

  useEffect(() => {
    api.channels().then((c) => setChannels(c)).catch(() => {});
    api.magmaRecommendations().then(setMagma).catch(() => {});
    api.autopilotOutcomes().then(setOutcomes).catch(() => {});
  }, []);

  const pnl = useMemo(() => (fr ? channelPnlRows(fr, costs) : []), [fr, costs]);

  const kpis = useMemo(() => {
    if (!fr) return null;
    const rebalCost = costs?.feeSats ?? 0;
    const revenue = fr.totalFeesEarnedSats;
    const net = revenue - rebalCost;
    // On the node's own capital in open channels, gross and net (a5).
    const nodeYield = routingYield(channels, revenue, rebalCost, days);
    const magmaNet = magma?.analytics.netProfitSat ?? 0;
    const magmaSold = magma?.analytics.filledOrdersAllTime ?? 0;
    return { revenue, rebalCost, net, nodeYield, magmaNet, magmaSold };
  }, [fr, costs, channels, magma, days]);

  const roi = rebalanceRoiKpi(outcomes);

  return (
    <div>
      <div className="subnav an-head">
        <div className="an-subnav">
          {([["performance", "Performance"], ["forwards", "Routing"]] as [Sub, string][]).map(([id, label]) => (
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
              label={`Routing profit · ${days}d`}
              value={`${kpis.net >= 0 ? "+" : "−"}${sats(Math.abs(kpis.net))}`}
              unit="sat"
              tone={kpis.net >= 0 ? "green" : "cost"}
              sub="routing revenue − rebalancing"
            />
            <Kpi label="Routing revenue" value={sats(kpis.revenue)} unit="sat" tone="green" sub={`${fr.totalForwards} forwards`} />
            <Kpi label="Routed volume" value={satsCompact(fr.totalRoutedSats)} unit="sat" sub={`avg ${fr.avgFeePpm} ppm earned`} />
            <Kpi
              label="Node yield"
              value={kpis.nodeYield.grossPctYear !== null ? kpis.nodeYield.grossPctYear.toFixed(2) : "—"}
              unit="%/yr (gross)"
              sub={
                kpis.nodeYield.netPctYear !== null
                  ? `on your ${satsCompact(kpis.nodeYield.ownCapitalSats)} sat in channels · ${kpis.nodeYield.netPctYear.toFixed(2)}%/yr after rebalancing`
                  : "no capital in open channels"
              }
            />
            <Kpi
              label="Rebalancing"
              value={kpis.rebalCost ? `−${sats(kpis.rebalCost)}` : "0"}
              unit="sat"
              tone={kpis.rebalCost ? "cost" : undefined}
              sub={rebalanceCostSub(costs)}
              title={costs?.note ?? undefined}
            />
            <Kpi label="Rebalance ROI" value={roi.value} unit={roi.unit} tone={roi.tone} sub={roi.sub} title={roi.title} />
            {(() => {
              // Revenue-weighted, and only over enough changes (review a5).
              const k = feeTuningKpi(outcomes);
              return <Kpi label="Fee tuning" value={k.value} unit={k.unit} tone={k.tone} sub={k.sub} />;
            })()}
            {bought && (bought.amortizedSats > 0 || bought.items.length > 0) ? (
              <Kpi
                label={`Inbound bought · ${days}d`}
                value={bought.amortizedSats ? `−${sats(bought.amortizedSats)}` : "0"}
                unit="sat"
                tone={bought.amortizedSats ? "cost" : undefined}
                sub="its cost spread over each lease"
                title="What inbound bought on Magma cost, the part of each lease that falls in this window. P&L books the whole purchase when it was paid."
              />
            ) : null}
            <Kpi
              label="Magma leases"
              value={kpis.magmaSold > 0 || kpis.magmaNet !== 0 ? `${kpis.magmaNet >= 0 ? "+" : "−"}${sats(Math.abs(kpis.magmaNet))}` : "—"}
              unit={kpis.magmaSold > 0 || kpis.magmaNet !== 0 ? "sat" : undefined}
              tone={kpis.magmaSold > 0 || kpis.magmaNet !== 0 ? "green" : undefined}
              sub={kpis.magmaSold > 0 ? `${kpis.magmaSold} sold · net` : "none sold yet"}
            />
          </div>
          {costs?.note ? <p className="muted small">{costs.note}</p> : null}
          {forwardsReadNote(fr) ? <p className="muted small">{forwardsReadNote(fr)}</p> : null}

          <TrendChart fr={fr} />

          <ChannelProfitability rows={pnl} />

          {outcomes ? <RefillsTable outcomes={outcomes} /> : null}
          {bought ? <BoughtInbound data={bought} /> : null}

          {outcomes && outcomes.fees.items.length > 0 ? (
            <section className="panel">
              <div className="panel-head">
                <h2>
                  Fee changes{" "}
                  <span className="muted">
                    · revenue per day until the next change (≤ {outcomes.fees.windowDays} d) vs before it, net of the rest of the node
                  </span>
                </h2>
              </div>
              <p className="muted small">{outcomes.fees.note}</p>
              <table className="fee-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th className="num">Fee</th>
                    <th className="num">Daily rev before → after</th>
                    <th className="num">Forwards</th>
                    <th className="num">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {outcomes.fees.items.slice(0, 12).map((f, i) => (
                    <tr key={`${f.channelId}-${i}`}>
                      <td className="an-alias">{f.alias}</td>
                      <td className="num">
                        {f.fromPpm} <span className={f.raised ? "delta-up" : "delta-down"}>→ {f.toPpm}</span>
                      </td>
                      <td className="num muted" title={`${f.beforeDays} d before, ${f.afterDays} d after`}>
                        {f.beforeDailyAvgSat} → {f.afterDailyAvgSat} sat
                      </td>
                      <td className="num muted">
                        {f.forwardsBefore} → {f.forwardsAfter}
                      </td>
                      <td
                        className={`num net ${f.deltaPct == null || !f.measurable ? "muted" : f.deltaPct >= 0 ? "green" : "cost"}`}
                        title={f.measurable ? undefined : "too little revenue before the change to judge it"}
                      >
                        {f.deltaPct == null ? "—" : `${f.deltaPct >= 0 ? "+" : ""}${Math.round(f.deltaPct * 100)}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
