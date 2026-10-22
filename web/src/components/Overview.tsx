import { api } from "../api";
import type { ActivityItem, ChannelView, DashboardData, DecisionArea, NodeSummary, PriceInfo } from "../types";
import { fiat, sats, satsCompact, timeAgo } from "../format";
import { usePolledData } from "../usePolledData";
import { AREA_LABEL, STATE_CHIP, autopilotDigest, autopilotTileFoot } from "../autopilotView";
import { InfoTip } from "./InfoTip";
import { SummaryBar } from "./SummaryBar";
import { HealthScore } from "./HealthScore";
import { PnlOverview } from "./PnlOverview";
import { LiquidityMap } from "./LiquidityMap";
import { Sparkline } from "./Sparkline";
import { TopChannelsTile } from "./TopChannelsTile";
import { leaseBenchmarkLine, refusalDigest } from "../magmaView";
import { pctFromPpm } from "../yieldView";
import { ACTIVITY_LABEL, activitySub, noForwardsIn7d, rollingForwardsLine } from "../analyticsView";
import { SuggestedPeersTile } from "./SuggestedPeersTile";

function signed(value: number): string {
  return `${value < 0 ? "−" : "+"}${sats(Math.abs(value))}`;
}

function KpiRow({ d, price }: { d: DashboardData; price?: PriceInfo | null }) {
  const earnedFiat = price ? fiat(d.earnedSats, price.btcPrice, price.currency) : null;
  // D12: what leasing on Magma would earn THIS node, live — or that it can't
  // sell there yet. Never a constant.
  const bench = leaseBenchmarkLine(d.leaseBenchmark);
  // Routing-alive signal: a collapse shows up immediately as 24h/7d going to
  // zero — rolling windows from the server, not the sparkline's last
  // (partial, calendar) days: at 02:30 "in 24h" was half an hour.
  const quiet = noForwardsIn7d(d);
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
        <div className="kpi-value">
          {d.forwardCount}
          {d.forwardsComplete === false ? "+" : ""}
        </div>
        <div
          className={`kpi-sub ${quiet ? "kpi-alert" : ""}`}
          title={
            d.forwardsComplete === false
              ? `LND holds more forwards in this window than are read (${d.forwardCount.toLocaleString("en-US")}). It hands them over oldest first, so the newest are the ones missing — the window's totals read low too.`
              : undefined
          }
        >
          {rollingForwardsLine(d)}
        </div>
        <div className="kpi-spark"><Sparkline data={d.forwardsSpark} width={150} height={30} /></div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Routed · {d.windowDays}d</div>
        <div className="kpi-value">{satsCompact(d.routedSats)} <span className="kpi-unit">sat</span></div>
        <div className="kpi-sub">volume forwarded</div>
        <div className="kpi-spark"><Sparkline data={d.routedSpark} width={150} height={30} /></div>
      </div>
      <div className="kpi">
        <div className="kpi-label">Yield · {d.windowDays}d</div>
        <div className="kpi-value" title={`${d.yieldPpmYear.toLocaleString()} ppm/yr`}>
          {pctFromPpm(d.yieldPpmYear)} <span className="kpi-unit">%/yr (gross)</span>
        </div>
        <div className="kpi-sub">
          {d.ownCapitalSats !== undefined ? `on your ${satsCompact(d.ownCapitalSats)} sat in channels` : "on capital"}
          {d.netYieldPpmYear !== undefined && d.rebalanceFeesSats ? ` · ${pctFromPpm(d.netYieldPpmYear)}% after rebalancing` : ""}
        </div>
        {bench ? (
          <div className="kpi-sub kpi-bench">
            {bench}
            {d.leaseBenchmark?.text && d.leaseBenchmark.text !== bench ? <InfoTip text={d.leaseBenchmark.text} label="About this comparison" /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}


function RecentActivity({ items }: { items: ActivityItem[] }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2>Recent activity</h2></div>
      {items.length === 0 ? (
        <p className="muted empty">Nothing yet — forwards and payments will show here.</p>
      ) : (
        <div className="feed">
          {items.slice(0, 11).map((a, i) => (
            <div className="feed-row" key={`${a.at}-${i}`}>
              <span className={`feed-dot k-${a.kind}`} />
              <div className="feed-main">
                <span className="feed-title">{ACTIVITY_LABEL[a.kind] ?? a.kind} · {a.title}</span>
                <span className="feed-sub">{activitySub(a, satsCompact)}</span>
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

/** "Today" digest — one glanceable strip answering "what happened / what needs
 *  me?", built purely from data the Overview already loads. Each item jumps to
 *  the right tab. */
function DigestStrip({
  d,
  channels,
  onNavigate,
}: {
  d: DashboardData;
  channels?: ChannelView[] | null;
  onNavigate?: (tab: string, sub?: string) => void;
}) {
  const a = d.autopilot;
  const pendingOpen = channels?.filter((c) => c.status === "pending_open").length ?? 0;
  const pendingClose = channels?.filter((c) => c.status === "pending_close").length ?? 0;

  const items: { key: string; text: string; warn?: boolean; tab: string; sub?: string }[] = [];
  // The last run with what THAT run did (failures too), the last change as
  // its own item, and any area in error or blocked (autopilotView.ts).
  for (const it of autopilotDigest(a)) items.push({ ...it, tab: "autopilot" });
  if (noForwardsIn7d(d)) {
    items.push({
      key: "noflow",
      text: "No forwards in 7 days — check fees & liquidity",
      warn: true,
      tab: "autopilot",
      sub: "fees",
    });
  }
  // Magma orders the lane turned down (caps, capital, unreachable buyer):
  // each is a lease fee not earned — say so where it is seen first.
  const refusals = refusalDigest(a.magmaRefusals, a.magmaRefusalReason);
  if (refusals) items.push({ key: "magma-refusals", text: refusals, warn: true, tab: "market", sub: "orders" });
  if (pendingOpen > 0) {
    items.push({
      key: "popen",
      text: `${pendingOpen} channel${pendingOpen > 1 ? "s" : ""} opening — waiting for confirmation`,
      tab: "channels",
    });
  }
  if (pendingClose > 0) {
    items.push({
      key: "pclose",
      text: `${pendingClose} channel${pendingClose > 1 ? "s" : ""} closing`,
      tab: "channels",
    });
  }
  if (items.length === 0) return null;

  return (
    <div className="digest">
      {items.map((it) => (
        <button key={it.key} className={`digest-item ${it.warn ? "warn" : ""}`} onClick={() => onNavigate?.(it.tab, it.sub)}>
          {it.text} <span className="go" aria-hidden>↗</span>
        </button>
      ))}
    </div>
  );
}

/** What the Overview says when its data couldn't be loaded — with what it
 *  still shows, and from when. */
export function dashStaleText(error: string, updatedAt: number | null): string {
  return updatedAt
    ? `Couldn't refresh the overview (${error}) — the figures below are from ${new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
    : `Couldn't load the overview's figures (${error}).`;
}

function ApBadge({ on }: { on: boolean }) {
  return <span className={`ap-badge ${on ? "on" : "off"}`}>{on ? "ON" : "OFF"}</span>;
}

/** The Autopilot tile: each area on or off and, compactly, what it last
 *  decided (D16) — "waiting", "deferred", "blocked" in words, not only a
 *  badge; the full reason is one click away on the Autopilot tab. */
function AutopilotStatus({ a, onOpen }: { a: DashboardData["autopilot"]; onOpen?: () => void }) {
  const rows: [DecisionArea, boolean][] = [
    ["fees", a.fees],
    ["rebalance", a.rebalance],
    ["channels", a.channel],
    ["magma", a.sell],
  ];
  return (
    <section
      className="panel mini clickable"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen?.()}
      title="Open Autopilot"
    >
      <div className="panel-head"><h2>Autopilot</h2><span className="tile-go" aria-hidden>↗</span></div>
      <div className="ap-rows">
        {rows.map(([area, on]) => {
          // What it decided — for an area that is on (an area that is off
          // just says OFF).
          const s = on ? a.status?.[area] : undefined;
          const chip = s && s.state !== "off" ? STATE_CHIP[s.state] : null;
          return (
            <div className="ap-row" key={area}>
              <span>{AREA_LABEL[area]}</span>
              <span className="ap-row-state">
                {chip ? <span className={`ap-state t-${chip.tone}`}>{chip.label}</span> : null}
                <ApBadge on={on} />
              </span>
              {s && s.state !== "off" && s.state !== "idle" && s.state !== "not_run" ? <span className="ap-row-why">{s.text}</span> : null}
            </div>
          );
        })}
      </div>
      <div className="ap-foot">{autopilotTileFoot(a)}</div>
    </section>
  );
}

export function Overview({
  node,
  channels,
  price,
  onNavigate,
}: {
  node: NodeSummary;
  channels?: ChannelView[] | null;
  price?: PriceInfo | null;
  onNavigate?: (tab: string, sub?: string) => void;
}) {
  // Every minute while the page is visible. A failed load is said — the
  // KPIs, digest and activity no longer vanish without a word.
  const polled = usePolledData(api.dashboard, 60_000);
  const dash = polled.data;

  return (
    <div className="overview">
      <SummaryBar node={node} price={price} />
      {polled.error ? (
        <p className="banner error">
          {dashStaleText(polled.error, polled.updatedAt)}{" "}
          <button className="linklike" onClick={polled.refresh}>
            Try again
          </button>
        </p>
      ) : null}
      {dash ? <KpiRow d={dash} price={price} /> : null}
      {dash ? <DigestStrip d={dash} channels={channels} onNavigate={onNavigate} /> : null}
      <div className="hero-row">
        <HealthScore />
        <PnlOverview price={price} />
      </div>
      {channels ? <LiquidityMap channels={channels} /> : null}
      {dash ? (
        <div className="hero-row">
          <RecentActivity items={dash.activity} />
          <div className="stack-col">
            <TopChannelsTile onOpen={() => onNavigate?.("analytics", "pnl")} />
            <SuggestedPeersTile onOpen={() => onNavigate?.("channels", "open")} />
            <AutopilotStatus a={dash.autopilot} onOpen={() => onNavigate?.("autopilot")} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
