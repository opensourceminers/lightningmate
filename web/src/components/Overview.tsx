import { api } from "../api";
import type { ActivityItem, ChannelView, DashboardData, DecisionArea, NodeSummary, PriceInfo } from "../types";
import { fiat, sats, satsCompact, timeAgo } from "../format";
import { usePolledData } from "../usePolledData";
import { AREA_LABEL, STATE_CHIP, autopilotTileFoot } from "../autopilotView";
import { openNode } from "../nodeNav";
import { todoItems } from "../todoView";
import { Fold } from "./Fold";
import { InfoTip } from "./InfoTip";
import { SetupWizard } from "./SetupWizard";
import { SummaryBar } from "./SummaryBar";
import { HealthScore } from "./HealthScore";
import { PnlOverview } from "./PnlOverview";
import { LiquidityMap } from "./LiquidityMap";
import { Sparkline } from "./Sparkline";
import { TopChannelsTile } from "./TopChannelsTile";
import { leaseBenchmarkLine } from "../magmaView";
import { pctFromPpm } from "../yieldView";
import { activitySub, activityTitle, foldActivity, noForwardsIn7d, rollingForwardsLine } from "../analyticsView";
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


/** Rows the activity feed shows: two columns of five on a wide screen. */
const ACTIVITY_ROWS = 10;

function RecentActivity({ items }: { items: ActivityItem[] }) {
  const rows = foldActivity(items, ACTIVITY_ROWS);
  return (
    <section className="panel">
      {rows.length === 0 ? (
        <p className="muted empty">Nothing yet — forwards and payments will show here.</p>
      ) : (
        // Newest first, down the left column, then the right one.
        <div className="feed cols" style={{ gridTemplateRows: `repeat(${Math.ceil(rows.length / 2)}, auto)` }}>
          {rows.map((a, i) => (
            <div className="feed-row" key={`${a.at}-${i}`}>
              <span className={`feed-dot k-${a.kind}`} />
              <div className="feed-main">
                <span className="feed-title">
                  {activityTitle(a)}
                  {a.count > 1 ? <span className="feed-count"> ×{a.count}</span> : null}
                </span>
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

/**
 * What needs you today, each line leading to where it is dealt with. With
 * nothing to do it says so: the page's first question has an answer either way.
 */
function WhatNeedsYou({
  d,
  channels,
  onNavigate,
}: {
  d: DashboardData;
  channels?: ChannelView[] | null;
  onNavigate?: (tab: string, sub?: string) => void;
}) {
  const { todo, footnote } = todoItems(d, channels);
  // An alert stands above the page (AlertsBar): no all-clear beneath it.
  const alerts = usePolledData(api.alerts, 60_000).data ?? [];
  return (
    <section className="panel todo">
      {todo.length === 0 ? (
        <p className="todo-none">
          <span className="todo-ok" aria-hidden>
            ✓
          </span>{" "}
          {alerts.length > 0 ? "Nothing else needs you right now." : "Nothing needs you right now."}
        </p>
      ) : (
        <>
          <h2>What needs you</h2>
          <ul className="todo-list">
            {todo.map((it) => (
              <li key={it.key}>
                <button
                  type="button"
                  className={`todo-item ${it.warn ? "warn" : ""}`}
                  onClick={() => {
                    if (it.node) openNode(it.node);
                    else if (it.tab) onNavigate?.(it.tab, it.sub);
                  }}
                >
                  <span>{it.text}</span>
                  <span className="go" aria-hidden>
                    ↗
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {footnote ? <p className="muted small todo-foot">{footnote}</p> : null}
    </section>
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
      <SetupWizard onChanged={polled.refresh} />
      <SummaryBar node={node} price={price} />
      {polled.error ? (
        <p className="banner error">
          {dashStaleText(polled.error, polled.updatedAt)}{" "}
          <button className="linklike" onClick={polled.refresh}>
            Try again
          </button>
        </p>
      ) : null}
      <div className="hero-row">
        <HealthScore />
        <PnlOverview price={price} />
      </div>
      {dash ? <WhatNeedsYou d={dash} channels={channels} onNavigate={onNavigate} /> : null}
      {dash ? <KpiRow d={dash} price={price} /> : null}
      {dash ? (
        <>
          {/* Three tiles side by side, the same height — the autopilot's status
              first; the activity feed below, across the full width. (Before, a
              tall feed of +1 sat forwards ran beside the three tiles stacked
              in one column, the autopilot's at the bottom.) */}
          <div className="tile-row">
            <AutopilotStatus a={dash.autopilot} onOpen={() => onNavigate?.("autopilot")} />
            <TopChannelsTile onOpen={() => onNavigate?.("analytics", "pnl")} />
            <SuggestedPeersTile onOpen={() => onNavigate?.("channels", "open")} />
          </div>
          <Fold id="ov-activity" title="Recent activity" defaultOpen>
            <RecentActivity items={dash.activity} />
          </Fold>
        </>
      ) : null}
      {channels ? (
        <Fold id="ov-map" title="Liquidity map">
          <LiquidityMap channels={channels} />
        </Fold>
      ) : null}
    </div>
  );
}
