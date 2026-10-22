import type {
  ActivityItem,
  ChannelForwardStat,
  ChannelView,
  DashboardData,
  ForwardsReport,
  MagmaV2Report,
  OutcomesReport,
  PnlSummary,
  RebalanceCostsResponse,
  RebalanceLogSummary,
  ScoreCategory,
} from "./types";
import { percent, sats } from "./format";

/**
 * What the Overview and Analytics pages say about money — pure, so each
 * statement is tested (package P6: real close costs, rebalance ROI without
 * double counting, complete cost ledgers, purchase costs, inbound credit,
 * an honest health score, clear time windows).
 */

// ── Channel profitability ────────────────────────────────────────────────────

export interface ChannelPnlRow {
  channelId: string;
  alias: string;
  status: ChannelForwardStat["status"];
  forwardCount: number;
  routedOutSats: number;
  /** Fees earned on forwards that left through it. */
  feesEarnedSats: number;
  /** Fees of the forwards that came IN through it (earned on their way out). */
  assistedSats: number;
  inboundForwardCount: number;
  rebalanceCostSats: number;
  /** earned − rebalancing: its own P&L. */
  netSats: number;
  /** earned + assisted − rebalancing: what it contributes, both ways. */
  contributionSats: number;
  spark: number[];
}

/**
 * Who a channel that only shows up with a rebalancing cost is, and whether it
 * is still there (review of P6: every such channel read "closed" under its
 * bare id — the forwards report lists only channels seen in a forward, so an
 * open channel refilled in the window but idle since was taken for closed):
 * one in the node's channel list is open, or pending while it opens or
 * closes; only one missing from it is closed, named as the server knows it.
 * Without a channel list yet (null), the server's own word stands.
 */
function costOnlyChannel(
  c: RebalanceCostsResponse["perChannel"][number],
  channels: readonly Pick<ChannelView, "id" | "peerAlias" | "status">[] | null,
): Pick<ChannelPnlRow, "alias" | "status"> {
  const listed = channels?.find((ch) => ch.id === c.channelId);
  if (listed) return { alias: listed.peerAlias || c.alias || c.channelId, status: listed.status === "open" ? "open" : "pending" };
  return { alias: c.alias || c.channelId, status: channels ? "closed" : (c.status ?? "closed") };
}

/**
 * Per-channel profitability for a window: the forwards report and what
 * rebalancing cost (GET /rebalance/costs — every refill of the window, not
 * the newest 50 records). A channel that only ever brought flow in is listed
 * with what it assisted (review a5: such channels vanished from the list,
 * looking worthless), and channels rank by their contribution both ways.
 * `channels`: the node's channel list (null while it hasn't loaded).
 */
export function channelPnlRows(
  fr: ForwardsReport,
  costs: RebalanceCostsResponse | null,
  channels: readonly Pick<ChannelView, "id" | "peerAlias" | "status">[] | null = null,
): ChannelPnlRow[] {
  const rows = new Map<string, ChannelPnlRow>();
  for (const c of fr.perChannel) {
    rows.set(c.channelId, {
      channelId: c.channelId,
      alias: c.alias || c.channelId,
      status: c.status ?? "open",
      forwardCount: c.forwardCount,
      routedOutSats: c.routedOutSats,
      feesEarnedSats: c.feesEarnedSats,
      assistedSats: c.inboundFeesSats ?? 0,
      inboundForwardCount: c.inboundForwardCount ?? 0,
      rebalanceCostSats: 0,
      netSats: 0,
      contributionSats: 0,
      spark: c.spark ?? [],
    });
  }
  for (const c of costs?.perChannel ?? []) {
    if (!c.channelId || !c.feeSats) continue;
    const row =
      rows.get(c.channelId) ??
      ({
        channelId: c.channelId,
        ...costOnlyChannel(c, channels),
        forwardCount: 0,
        routedOutSats: 0,
        feesEarnedSats: 0,
        assistedSats: 0,
        inboundForwardCount: 0,
        rebalanceCostSats: 0,
        netSats: 0,
        contributionSats: 0,
        spark: [],
      } satisfies ChannelPnlRow);
    row.rebalanceCostSats += c.feeSats;
    rows.set(c.channelId, row);
  }
  return [...rows.values()]
    .filter((r) => r.forwardCount > 0 || r.inboundForwardCount > 0 || r.rebalanceCostSats > 0)
    .map((r) => ({
      ...r,
      netSats: r.feesEarnedSats - r.rebalanceCostSats,
      contributionSats: r.feesEarnedSats + r.assistedSats - r.rebalanceCostSats,
    }))
    .sort((a, b) => b.contributionSats - a.contributionSats);
}

/** What the Channel profitability table's figures are (its Net column is a
 *  channel's own: what it brought in stands beside it — review of P6: the
 *  heading said "fees earned + fees of the forwards it brought in −
 *  rebalancing cost", while Net left those out). */
export const CHANNEL_PNL_CAPTION = "Net = fees earned − rebalancing cost · “Brought in” beside it · ranked by both";

/** The Overview's top channels: by what they earned out plus what they
 *  brought in — a channel that is the source of the best route ranks too. */
export function topChannels(perChannel: ChannelForwardStat[], n = 5): ChannelForwardStat[] {
  const worth = (c: ChannelForwardStat) => c.feesEarnedSats + (c.inboundFeesSats ?? 0);
  return perChannel
    .filter((c) => worth(c) > 0)
    .sort((a, b) => worth(b) - worth(a))
    .slice(0, n);
}

/** One top-channel line's figure: "1,200 sat · +300 in". */
export function topChannelValue(c: ChannelForwardStat): { earned: string; assisted: string | null } {
  return { earned: sats(c.feesEarnedSats), assisted: c.inboundFeesSats ? `+${sats(c.inboundFeesSats)} brought in` : null };
}

/**
 * What the Overview's Top channels tile shows for its polled routing report
 * (review of P7: a failed read became an empty list — "No routing fees
 * yet." — a failure shown as data, and a failed refresh over older figures
 * said nothing about their age). Loading; the error, when there is nothing
 * to show; the rows (none: no routing fees yet) — with, after a failed
 * refresh, the error and the time the rows are from, as HealthScore says it.
 */
export type TopChannelsState =
  | { kind: "loading" }
  | { kind: "error"; text: string }
  | { kind: "rows"; rows: ChannelForwardStat[]; stale: string | null };

export function topChannelsState(
  polled: { data: { perChannel: ChannelForwardStat[] } | null; error: string | null; updatedAt: number | null },
  n = 5,
): TopChannelsState {
  if (!polled.data) {
    return polled.error ? { kind: "error", text: `The routing report couldn't be read (${polled.error}).` } : { kind: "loading" };
  }
  const at = polled.updatedAt !== null ? new Date(polled.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  const stale = polled.error ? `Couldn't refresh (${polled.error})${at ? ` — as of ${at}` : ""}.` : null;
  return { kind: "rows", rows: topChannels(polled.data.perChannel, n), stale };
}

/** Flow label + the action it implies. "draining" with little local balance
 *  left is the urgent case — the channel will soon stop routing. A channel no
 *  longer open is "closed": its 0% local ratio is no warning (it read
 *  "draining · 0% left", in red). */
export function flowHint(c: Pick<ChannelForwardStat, "flow" | "localRatio" | "status">): { label: string; cls: string; urgent: boolean } {
  if (c.status === "closed") return { label: "closed", cls: "flow-balanced", urgent: false };
  if (c.status === "pending") return { label: "opening / closing", cls: "flow-balanced", urgent: false };
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

// ── Time windows ─────────────────────────────────────────────────────────────

type RollingView = Pick<DashboardData, "rolling" | "forwardsComplete" | "windowDays" | "forwardCount">;

/** "12 in 24h · 80 in 7d" — rolling counts, never the partial calendar day.
 *  With more forwards in the window than LND's history was read for, the
 *  newest are the ones missing (it hands them over oldest first): the counts
 *  would read low, or zero — said instead of shown. */
export function rollingForwardsLine(d: RollingView): string {
  if (d.forwardsComplete === false) return `24h · 7d not counted — over ${d.forwardCount.toLocaleString("en-US")} forwards in ${d.windowDays} d, the latest not read`;
  return `${d.rolling.last24h.forwards} in 24h · ${d.rolling.last7d.forwards} in 7d`;
}

/** No forward in the last 7 × 24 h — never claimed when the latest forwards
 *  weren't read at all. */
export const noForwardsIn7d = (d: RollingView): boolean => d.forwardsComplete !== false && d.rolling.last7d.forwards === 0;

/** What a forwards read that stopped short is missing: LND hands forwards
 *  over oldest first, so the most recent are the ones not read (null: the
 *  read was complete). */
export function forwardsReadNote(fr: Pick<ForwardsReport, "complete" | "totalForwards" | "windowDays">): string | null {
  if (fr.complete !== false) return null;
  return (
    `LND holds more forwards in these ${fr.windowDays} days than are read (${fr.totalForwards.toLocaleString("en-US")}): ` +
    "it hands them over oldest first, so the most recent are missing — the totals, the trend and the last days read low."
  );
}

/** The trend badge: the most recent half of the window against the half
 *  before it, equal spans ending now (null: nothing earned before — or the
 *  read stopped short, its most recent half the part missing). */
export function trendBadge(fr: Pick<ForwardsReport, "trend"> & Partial<Pick<ForwardsReport, "complete">>): { up: boolean; text: string; title: string } | null {
  const t = fr.trend;
  if (!t || t.growthPct === null || fr.complete === false) return null;
  return {
    up: t.growthPct >= 0,
    text: `${t.growthPct >= 0 ? "▲" : "▼"} ${Math.abs(t.growthPct)}% · last ${t.halfDays} d vs the ${t.halfDays} d before`,
    title: `${sats(t.recentFeesSats)} sat in the last ${t.halfDays} × 24 h against ${sats(t.priorFeesSats)} sat in the ${t.halfDays} × 24 h before`,
  };
}

// ── Activity feed ────────────────────────────────────────────────────────────

export const ACTIVITY_LABEL: Record<ActivityItem["kind"], string> = {
  forward: "Routed",
  received: "Received",
  sent: "Sent",
  rebalance: "Rebalance",
  onchain_in: "On-chain in",
  onchain_out: "On-chain out",
  channel_open: "Channel open",
  channel_close: "Channel close",
};

export function activitySub(a: ActivityItem, compact: (n: number) => string): string {
  if (a.kind === "forward") return `${compact(a.routedSats ?? 0)} sat routed`;
  if (a.kind === "rebalance") return `fee ${a.feeSats ?? 0} sat`;
  if (a.kind === "sent") return a.feeSats ? `fee ${a.feeSats} sat` : "payment";
  if (a.kind === "onchain_in" || a.kind === "onchain_out" || a.kind === "channel_open" || a.kind === "channel_close") {
    return a.feeSats ? `fee ${a.feeSats} sat` : "on-chain";
  }
  return "invoice";
}

/** The Analytics "Magma leases" tile's sub-line: what its figure is — every
 *  sale so far (not the window's), net of the service fee and of on-chain
 *  costs estimated at today's fee rate (magmaRecommend.ts analytics). */
export function magmaLeasesSub(sold: number): string {
  return sold > 0 ? `${sold} sold since the start · net, on-chain costs estimated — the window's lease income is in P&L` : "none sold yet";
}

/**
 * The "Magma leases · all time" tile — or that it isn't known: `report` is
 * null while the Magma report loads, or when its read failed (`error`).
 * Review of P7: the tile read "none sold yet" for a report that never came.
 */
export function magmaLeasesKpi(
  report: Pick<MagmaV2Report, "analytics"> | null,
  error: string | null,
): { value: string; unit?: string; tone?: "green"; sub: string } {
  if (!report) return { value: "—", sub: error ? `unknown — the Magma report couldn't be read (${error})` : "loading…" };
  const { filledOrdersAllTime: sold, netProfitSat: net } = report.analytics;
  if (sold === 0 && net === 0) return { value: "—", sub: magmaLeasesSub(0) };
  return { value: `${net >= 0 ? "+" : "−"}${sats(Math.abs(net))}`, unit: "sat", tone: "green", sub: magmaLeasesSub(sold) };
}

// ── Rebalancing ──────────────────────────────────────────────────────────────

/** "4 done in 30 d · 120 sat fees · avg 300 ppm" — the window said, and
 *  when LightningMate's log only began within it, since when. */
export function rebalanceSummaryLine(s: RebalanceLogSummary, trackedSince?: string | null, nowMs = Date.now()): string {
  const days = s.windowDays ?? 30;
  const since = trackedSince ? Date.parse(trackedSince) : NaN;
  const window = Number.isFinite(since) && since > nowMs - days * 86_400_000 ? `since ${trackedSince!.slice(0, 10)}` : `in ${days} d`;
  return `${s.count} done ${window} · ${sats(s.totalFeeSats)} sat fees · avg ${s.avgCostPpm} ppm`;
}

/**
 * Whose the rebalances were, as far as LightningMate's log can tell: those
 * from when it covers rebalances on with no record in it were made with
 * another tool; those from before it began can't be told apart — on a node
 * upgraded from 0.7.x, its own older refills are among them (0.7.x kept its
 * newest 200 records), and they read "made outside LightningMate" (review
 * of P6). Null: nothing to say.
 */
export function rebalanceWhoseNote(notLogged: number, beforeLog: number | undefined, logSince: string | null | undefined): string | null {
  const parts = [
    notLogged > 0 ? `${notLogged} made outside LightningMate` : null,
    beforeLog ? `${beforeLog} from before its log began${logSince ? ` (${logSince.slice(0, 10)})` : ""} — LightningMate's or another tool's` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : null;
}

/** The Analytics "Rebalancing" figure's sub-line: how many, and whose. */
export function rebalanceCostSub(c: RebalanceCostsResponse | null): string {
  if (!c) return "";
  const runs = `${c.count} run${c.count === 1 ? "" : "s"}`;
  if (c.source === "log") return `${runs} · LightningMate's own log (LND unreadable)`;
  const whose = rebalanceWhoseNote(c.notLogged, c.beforeLog, c.logTrackedSince);
  return whose ? `${runs} · ${whose}` : runs;
}

/** The "Rebalance ROI" figure: each refill credited only with the forwards
 *  that carried its own sats out (first in, first out). */
export function rebalanceRoiKpi(o: OutcomesReport | null): { value: string; unit?: string; tone?: "green" | "cost"; sub: string; title: string } {
  const r = o?.rebalances;
  const title = r?.method ?? "";
  if (!r || r.avgEarnedBackPct === null || r.measured === 0) {
    const waiting = r && r.measuring > 0 ? `${r.measuring} refill${r.measuring === 1 ? "" : "s"} still measuring` : "no data yet";
    return { value: "—", sub: waiting, title };
  }
  return {
    value: String(r.avgEarnedBackPct),
    unit: "% back",
    tone: r.avgEarnedBackPct >= 100 ? "green" : "cost",
    sub: `${r.paidBackCount}/${r.measured} paid back · own sats, first in first out${r.measuring ? ` · ${r.measuring} measuring` : ""}`,
    title,
  };
}

// ── P&L ──────────────────────────────────────────────────────────────────────

export interface PnlCostPart {
  key: string;
  label: string;
  sats: number;
  cls: string;
  /** What the legend says beside the amount (counts, unknowns). */
  note?: string;
}

/** The P&L's cost parts, in the bar's order. Closes say how many and how
 *  many of them had a part that couldn't be worked out — never a bare 0. */
export function pnlCostParts(p: PnlSummary): PnlCostPart[] {
  const parts: PnlCostPart[] = [
    { key: "open", label: "Opens", sats: p.channelOpenCostSats, cls: "c-open" },
    {
      key: "rebal",
      label: "Rebalance",
      sats: p.rebalanceCostSats,
      cls: "c-rebal",
      note: (() => {
        const whose = rebalanceWhoseNote(p.rebalanceNotLogged, p.rebalanceBeforeLog, p.rebalanceLogSince);
        return whose ? `incl. ${whose}` : undefined;
      })(),
    },
    { key: "close", label: "Closes", sats: p.channelCloseCostSats, cls: "c-close", note: closeNote(p) },
  ];
  if (p.inboundPurchaseCostSats > 0 || p.inboundPurchaseCount > 0) {
    parts.push({
      key: "inbound",
      label: "Inbound bought",
      sats: p.inboundPurchaseCostSats,
      cls: "c-inbound",
      note: `${p.inboundPurchaseCount} purchase${p.inboundPurchaseCount === 1 ? "" : "s"} (invoice + routing fee)`,
    });
  }
  if (p.serviceFeePaidSats > 0) parts.push({ key: "fee", label: "Fee", sats: p.serviceFeePaidSats, cls: "c-fee" });
  return parts;
}

/**
 * The P&L's lines under the bars: what the node spent that is not a cost of
 * running it — on-chain sends' fees, and the routing fees of the Lightning
 * payments it sent (review of P6: those were shown nowhere) — each apart,
 * and not counted in net.
 */
export function pnlSpendLines(p: Pick<PnlSummary, "otherChainFeesSats" | "lightningPaymentFeesSats" | "lightningPaymentCount">): string[] {
  const lines: string[] = [];
  if (p.otherChainFeesSats > 0) lines.push(`+ ${sats(p.otherChainFeesSats)} sat other on-chain fees (sends), not counted in net`);
  if ((p.lightningPaymentFeesSats ?? 0) > 0) {
    const n = p.lightningPaymentCount ?? 0;
    lines.push(
      `+ ${sats(p.lightningPaymentFeesSats)} sat routing fees of ${n} Lightning payment${n === 1 ? "" : "s"} you sent ` +
        "(not rebalancing, Magma purchases or the service fee), not counted in net",
    );
  }
  return lines;
}

/** "2 closes · cost unknown for 1" / "1 close" / "no closes" — and, for a
 *  window with fees but no close in it, what the fees were: each close fee
 *  is booked when it was paid, so a sweep in the window can belong to a close
 *  from before it (it read "Closes 800 · no closes"). */
export function closeNote(p: Pick<PnlSummary, "channelCloseCount" | "channelCloseUnknownCount" | "channelCloseCostSats">): string {
  const n = p.channelCloseCount ?? 0;
  if (n === 0) return (p.channelCloseCostSats ?? 0) > 0 ? "sweeps of earlier closes" : "no closes";
  const base = `${n} close${n === 1 ? "" : "s"}`;
  return p.channelCloseUnknownCount ? `${base} · cost unknown for ${p.channelCloseUnknownCount}` : base;
}

// ── Health score ─────────────────────────────────────────────────────────────

/** A category bar: its width, or that it isn't graded (insufficient data). */
export function scoreBar(c: Pick<ScoreCategory, "score">): { graded: true; widthPct: number } | { graded: false; label: string } {
  if (c.score === null || c.score === undefined) return { graded: false, label: "insufficient data" };
  return { graded: true, widthPct: Math.round(c.score * 100) };
}
