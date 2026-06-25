import { useEffect, useState } from "react";
import { api } from "../api";
import type { ActivityItem, ChannelView, DashboardData, NodeSummary, PriceInfo } from "../types";
import { fiat, sats, satsCompact, timeAgo } from "../format";
import { SummaryBar } from "./SummaryBar";
import { HealthScore } from "./HealthScore";
import { PnlOverview } from "./PnlOverview";
import { LiquidityMap } from "./LiquidityMap";
import { Sparkline } from "./Sparkline";
import { TopChannelsTile } from "./TopChannelsTile";
import { SuggestedPeersTile } from "./SuggestedPeersTile";

const KIND_LABEL: Record<ActivityItem["kind"], string> = {
  forward: "Routed",
  received: "Received",
  sent: "Sent",
  onchain_in: "On-chain in",
  onchain_out: "On-chain out",
};

function signed(value: number): string {
  return `${value < 0 ? "−" : "+"}${sats(Math.abs(value))}`;
}

function KpiRow({ d, price }: { d: DashboardData; price?: PriceInfo | null }) {
  const earnedFiat = price ? fiat(d.earnedSats, price.btcPrice, price.currency) : null;
  return (
    <div className="kpi-row">
      <div className="kpi">
        <div className="kpi-label">Earned · {d.windowDays}d</div>
        <div className="kpi-value">{sats(d.earnedSats)} <span className="kpi-unit">sat</span></div>
        <div className="kpi-sub">{earnedFiat ?? " "}</div>
        <div className="kpi-spark"><Sparkline data={d.feesSpark} width={150} height={30} color="var(--green)" /></div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Forwards · {d.windowDays}d</div>
        <div className="kpi-value">{d.forwardCount}</div>
        <div className="kpi-sub">routing events</div>
        <div className="kpi-spark"><Sparkline data={d.forwardsSpark} width={150} height={30} /></div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Routed · {d.windowDays}d</div>
        <div className="kpi-value">{satsCompact(d.routedSats)} <span className="kpi-unit">sat</span></div>
        <div className="kpi-sub">volume forwarded</div>
        <div className="kpi-spark"><Sparkline data={d.routedSpark} width={150} height={30} /></div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Rebalanced</div>
        <div className="kpi-value">{d.rebalancedCount}<span className="kpi-unit"> runs</span></div>
        <div className="kpi-sub">{satsCompact(d.rebalancedSats)} sat moved</div>
        <div className="kpi-spark" />
      </div>
    </div>
  );
}

function subOf(a: ActivityItem): string {
  if (a.kind === "forward") return `${satsCompact(a.routedSats ?? 0)} sat routed`;
  if (a.kind === "sent") return a.feeSats ? `fee ${a.feeSats} sat` : "payment";
  if (a.kind === "onchain_in" || a.kind === "onchain_out") return a.feeSats ? `fee ${a.feeSats} sat` : "on-chain";
  return "invoice";
}

function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>Recent activity</h2></div>
      {items.length === 0 ? (
        <p className="muted empty">Nothing yet — forwards and payments will show here.</p>
      ) : (
        <div className="feed">
          {items.map((a, i) => (
            <div className="feed-row" key={`${a.at}-${i}`}>
              <span className={`feed-dot k-${a.kind}`} />
              <div className="feed-main">
                <span className="feed-title">{KIND_LABEL[a.kind]} · {a.title}</span>
                <span className="feed-sub">{subOf(a)}</span>
              </div>
              <span className={`feed-amt ${a.amountSats >= 0 ? "pos" : "neg"}`}>{signed(a.amountSats)}</span>
              <span className="feed-time">{timeAgo(a.at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ApBadge({ on }: { on: boolean }) {
  return <span className={`ap-badge ${on ? "on" : "off"}`}>{on ? "ON" : "OFF"}</span>;
}

function AutopilotStatus({ a }: { a: DashboardData["autopilot"] }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>Autopilot</h2></div>
      <div className="ap-rows">
        <div className="ap-row"><span>Fee automation</span><ApBadge on={a.fees} /></div>
        <div className="ap-row"><span>Auto-rebalance</span><ApBadge on={a.rebalance} /></div>
        <div className="ap-row"><span>Channel autopilot</span><ApBadge on={a.channel} /></div>
      </div>
      <div className="ap-foot">
        {a.lastRunAt
          ? `Last run ${timeAgo(a.lastRunAt)} · ${a.lastApplied}/${a.lastAttempted} applied`
          : "Has not run yet"}
      </div>
    </section>
  );
}

export function Overview({
  node,
  channels,
  price,
}: {
  node: NodeSummary;
  channels?: ChannelView[] | null;
  price?: PriceInfo | null;
}) {
  const [dash, setDash] = useState<DashboardData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.dashboard().then((d) => !cancelled && setDash(d)).catch(() => {});
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="overview">
      <SummaryBar node={node} price={price} />
      {dash ? <KpiRow d={dash} price={price} /> : null}
      <div className="hero-row">
        <HealthScore />
        <PnlOverview price={price} />
      </div>
      {channels ? <LiquidityMap channels={channels} /> : null}
      {dash ? (
        <div className="hero-row">
          <RecentActivity items={dash.activity} />
          <div className="stack-col">
            <TopChannelsTile />
            <SuggestedPeersTile />
            <AutopilotStatus a={dash.autopilot} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
