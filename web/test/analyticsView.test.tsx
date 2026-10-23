/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * What the Overview and Analytics pages say about money (package P6): every
 * P&L cost shown — closes with their count and what is unknown, inbound
 * bought, rebalancing by other tools; channels credited for the flow they
 * bring in; a closed channel never "draining"; rolling 24 h / 7 d windows;
 * a trend over equal spans; the refill ROI with its method; a category with
 * too little data shown as such, never as an empty bar.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ACTIVITY_LABEL,
  activitySub,
  channelPnlRows,
  closeNote,
  flowHint,
  forwardsReadNote,
  magmaLeasesKpi,
  magmaLeasesSub,
  noForwardsIn7d,
  pnlCostParts,
  pnlSpendLines,
  rebalanceCostSub,
  rebalanceRoiKpi,
  rebalanceSummaryLine,
  rollingForwardsLine,
  scoreBar,
  topChannels,
  topChannelsState,
  trendBadge,
} from "../src/analyticsView";
import { satsCompact } from "../src/format";
import { ChannelProfitability } from "../src/components/AnalyticsPanel";
import { tzOffsetMin } from "../src/api";
import type { ChannelForwardStat, ForwardsReport, MagmaV2Report, OutcomesReport, PnlSummary, RebalanceCostsResponse } from "../src/types";

const stat = (id: string, o: Partial<ChannelForwardStat> = {}): ChannelForwardStat => ({
  channelId: id,
  alias: id,
  forwardCount: 0,
  routedOutSats: 0,
  routedInSats: 0,
  feesEarnedSats: 0,
  inboundForwardCount: 0,
  inboundFeesSats: 0,
  localRatio: 0.5,
  capacity: 2_000_000,
  status: "open",
  flow: "balanced",
  spark: [],
  ...o,
});

const report = (perChannel: ChannelForwardStat[]): ForwardsReport => ({
  windowDays: 30,
  totalForwards: 0,
  totalRoutedSats: 0,
  totalFeesEarnedSats: 0,
  avgFeePpm: 0,
  maxForwardSats: 0,
  busiestDay: null,
  perChannel,
  corridors: [],
  daily: [],
  recent: [],
  rolling: { last24h: { forwards: 0, routedSats: 0, feesSats: 0 }, last7d: { forwards: 0, routedSats: 0, feesSats: 0 } },
  trend: { halfDays: 15, recentFeesSats: 0, priorFeesSats: 0, growthPct: null },
  tzOffsetMin: 0,
  complete: true,
});

const costs = (perChannel: RebalanceCostsResponse["perChannel"], o: Partial<RebalanceCostsResponse> = {}): RebalanceCostsResponse => ({
  windowDays: 30,
  source: "lnd",
  feeSats: perChannel.reduce((s, c) => s + c.feeSats, 0),
  count: perChannel.reduce((s, c) => s + c.count, 0),
  amountSats: 0,
  perChannel,
  notLogged: 0,
  beforeLog: 0,
  logOnly: 0,
  logTrackedSince: null,
  note: null,
  ...o,
});

test("channel profitability lists a channel that only brought flow in, credits it, ranks by contribution both ways — and takes rebalancing from the whole window", () => {
  const rows = channelPnlRows(
    report([
      stat("sink", { forwardCount: 10, feesEarnedSats: 1_000, routedOutSats: 1_000_000 }),
      stat("source", { inboundForwardCount: 10, inboundFeesSats: 1_000 }), // earned nothing itself
      stat("idle"),
    ]),
    costs([
      { channelId: "sink", feeSats: 300, count: 2 },
      { channelId: "gone", feeSats: 50, count: 1 }, // a channel closed since: its cost still shows
      { channelId: "", feeSats: 5, count: 1 }, // LND didn't name it: no row
    ]),
  );
  assert.deepEqual(
    rows.map((r) => [r.channelId, r.feesEarnedSats, r.assistedSats, r.rebalanceCostSats, r.netSats, r.contributionSats]),
    [
      ["source", 0, 1_000, 0, 0, 1_000],
      ["sink", 1_000, 0, 300, 700, 700],
      ["gone", 0, 0, 50, -50, -50],
    ],
  );
  assert.equal(rows.find((r) => r.channelId === "gone")?.status, "closed");
});

// Review of P6: a channel refilled in the window with no forward in it was
// labelled "closed" under its bare id — the forwards report lists only
// channels seen in a forward (PROBE-CLOSED-LABEL).
test("a channel with only a rebalancing cost takes its alias and status from the channel list — 'closed' only when it is not in it", () => {
  const list = [
    { id: "850000x1x0", peerAlias: "ACINQ", status: "open" as const },
    { id: "850001x1x0", peerAlias: "opening-peer", status: "pending_open" as const },
  ];
  const rows = channelPnlRows(
    report([]),
    costs([
      { channelId: "850000x1x0", feeSats: 300, count: 1 },
      { channelId: "850001x1x0", feeSats: 20, count: 1 },
      { channelId: "850009x1x0", feeSats: 50, count: 1, alias: "old-peer", status: "closed" },
      { channelId: "850010x1x0", feeSats: 10, count: 1 },
    ]),
    list,
  );
  const by = Object.fromEntries(rows.map((r) => [r.channelId, [r.alias, r.status]]));
  assert.deepEqual(by["850000x1x0"], ["ACINQ", "open"]);
  assert.deepEqual(by["850001x1x0"], ["opening-peer", "pending"]);
  assert.deepEqual(by["850009x1x0"], ["old-peer", "closed"], "closed: named as the server knows it");
  assert.deepEqual(by["850010x1x0"], ["850010x1x0", "closed"]);
  const html = renderToStaticMarkup(<ChannelProfitability rows={rows} />);
  assert.match(html, /<td class="an-alias">ACINQ<\/td>/);
  assert.doesNotMatch(html, /850000x1x0<span class="muted"> · closed/);
  assert.match(html, /old-peer<span class="muted"> · closed<\/span>/);
  // No channel list yet: the server's word stands — an open channel is not
  // taken for closed while the list loads.
  const early = channelPnlRows(report([]), costs([{ channelId: "850000x1x0", feeSats: 300, count: 1, alias: "ACINQ", status: "open" }]), null);
  assert.deepEqual([early[0].alias, early[0].status], ["ACINQ", "open"]);
});

// Review of P6: on a node upgraded from 0.7.x, LightningMate's own older
// refills (dropped by the old 200-record cap) read "made outside LightningMate".
test("rebalances from before LightningMate's log began are said apart — never 'made outside LightningMate'", () => {
  assert.equal(rebalanceCostSub(costs([], { count: 3, notLogged: 0, beforeLog: 1, logTrackedSince: "2026-10-12T08:00:00.000Z" })), "3 runs · 1 from before its log began (2026-10-12) — LightningMate's or another tool's");
  assert.equal(rebalanceCostSub(costs([], { count: 3, notLogged: 2, beforeLog: 0 })), "3 runs · 2 made outside LightningMate");
  const rebal = pnlCostParts(pnl({ rebalanceCostSats: 120, rebalanceNotLogged: 0, rebalanceBeforeLog: 1, rebalanceLogSince: "2026-10-12T08:00:00.000Z" })).find((c) => c.key === "rebal");
  assert.equal(rebal?.note, "incl. 1 from before its log began (2026-10-12) — LightningMate's or another tool's");
  assert.doesNotMatch(rebal?.note ?? "", /made outside/);
});

test("P&L lists the routing fees of the Lightning payments sent beside the on-chain sends' fees — each apart, not in net", () => {
  assert.deepEqual(pnlSpendLines(pnl({ otherChainFeesSats: 400, lightningPaymentFeesSats: 12, lightningPaymentCount: 2 })), [
    "+ 400 sat other on-chain fees (sends), not counted in net",
    "+ 12 sat routing fees of 2 Lightning payments you sent (not rebalancing, Magma purchases or the service fee), not counted in net",
  ]);
  assert.deepEqual(pnlSpendLines(pnl({})), []);
});

test("the Overview's top channels rank what they earned plus what they brought in", () => {
  const top = topChannels([stat("a", { feesEarnedSats: 500 }), stat("b", { inboundFeesSats: 900 }), stat("c")]);
  assert.deepEqual(top.map((c) => c.channelId), ["b", "a"]);
});

// Review of P7 (final): the tile turned a failed forwards read into an empty
// list — "No routing fees yet." — and a failed refresh over older figures
// said nothing about when they were from.
test("Top channels says when the routing report couldn't be read — never 'No routing fees yet' — and from when older rows are", () => {
  const at = Date.parse("2026-10-22T09:15:00Z");
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  assert.deepEqual(topChannelsState({ data: null, error: null, updatedAt: null }), { kind: "loading" });
  // Before: [] — rendered as "No routing fees yet."
  assert.deepEqual(topChannelsState({ data: null, error: "Bad Gateway", updatedAt: null }), {
    kind: "error",
    text: "The routing report couldn't be read (Bad Gateway).",
  });
  const report = { perChannel: [stat("a", { feesEarnedSats: 500 }), stat("b")] };
  assert.deepEqual(topChannelsState({ data: report, error: null, updatedAt: at }), { kind: "rows", rows: [report.perChannel[0]], stale: null });
  // A failed refresh keeps the rows, with the error and their time.
  const stale = topChannelsState({ data: report, error: "Bad Gateway", updatedAt: at });
  assert.equal(stale.kind, "rows");
  assert.equal(stale.kind === "rows" ? stale.stale : null, `Couldn't refresh (Bad Gateway) — as of ${time}.`);
  // Read fine, nothing earned: that is "No routing fees yet" (the tile's words).
  assert.deepEqual(topChannelsState({ data: { perChannel: [stat("c")] }, error: null, updatedAt: at }), { kind: "rows", rows: [], stale: null });
  const tile = readFileSync(new URL("../src/components/TopChannelsTile.tsx", import.meta.url), "utf8");
  assert.match(tile, /const view = topChannelsState\(report\);/);
  assert.doesNotMatch(tile, /report\.error \? \[\]/);
});

test("a closed channel reads 'closed' — never 'draining · 0% left' in red", () => {
  assert.deepEqual(flowHint({ flow: "draining", localRatio: 0, status: "closed" }), { label: "closed", cls: "flow-balanced", urgent: false });
  assert.deepEqual(flowHint({ flow: "draining", localRatio: 0.1, status: "open" }), { label: "draining · 10% left", cls: "flow-drain-urgent", urgent: true });
});

test("24 h and 7 d are the server's rolling counts — not the sparkline's last, partial calendar days", () => {
  const d = { windowDays: 30, forwardCount: 300, forwardsComplete: true, rolling: { last24h: { forwards: 12, routedSats: 0, feesSats: 0 }, last7d: { forwards: 80, routedSats: 0, feesSats: 0 } }, forwardsSpark: [9, 9, 9, 9, 9, 9, 0] };
  assert.equal(rollingForwardsLine(d), "12 in 24h · 80 in 7d");
  assert.equal(noForwardsIn7d(d), false);
  assert.equal(noForwardsIn7d({ ...d, rolling: { ...d.rolling, last7d: { forwards: 0, routedSats: 0, feesSats: 0 } } }), true);
});

test("more forwards than were read: the newest are the ones missing — 24 h · 7 d say so, and 'no forwards in 7 days' is never raised on a read that stopped short", () => {
  const cut = { windowDays: 30, forwardCount: 100_000, forwardsComplete: false, rolling: { last24h: { forwards: 0, routedSats: 0, feesSats: 0 }, last7d: { forwards: 0, routedSats: 0, feesSats: 0 } } };
  assert.equal(noForwardsIn7d(cut), false);
  assert.equal(rollingForwardsLine(cut), "24h · 7d not counted — over 100,000 forwards in 30 d, the latest not read");
  // The Analytics and Routing views: said, and no trend over a half that is missing.
  const fr = { ...report([]), totalForwards: 100_000, complete: false, trend: { halfDays: 15, recentFeesSats: 0, priorFeesSats: 5_000, growthPct: -100 } };
  assert.equal(trendBadge(fr), null);
  assert.equal(
    forwardsReadNote(fr),
    "LND holds more forwards in these 30 days than are read (100,000): it hands them over oldest first, so the most recent are missing — the totals, the trend and the last days read low.",
  );
  assert.equal(forwardsReadNote(report([])), null);
});

test("the trend badge compares equal spans ending now, and says so", () => {
  assert.equal(trendBadge({ trend: { halfDays: 15, recentFeesSats: 0, priorFeesSats: 0, growthPct: null } }), null);
  assert.deepEqual(trendBadge({ trend: { halfDays: 15, recentFeesSats: 900, priorFeesSats: 1_000, growthPct: -10 } }), {
    up: false,
    text: "▼ 10% · last 15 d vs the 15 d before",
    title: "900 sat in the last 15 × 24 h against 1,000 sat in the 15 × 24 h before",
  });
});

const pnl = (o: Partial<PnlSummary> = {}): PnlSummary => ({
  windowDays: 30,
  routingRevenueSats: 0,
  forwardCount: 0,
  magmaRevenueSats: 0,
  magmaSaleCount: 0,
  rebalanceCostSats: 0,
  rebalanceCount: 0,
  rebalanceSource: "lnd",
  rebalanceNotLogged: 0,
  rebalanceBeforeLog: 0,
  rebalanceLogSince: null,
  channelOpenCostSats: 0,
  channelCloseCostSats: 0,
  channelCloseCount: 0,
  channelCloseUnknownCount: 0,
  inboundPurchaseCostSats: 0,
  inboundPurchaseCount: 0,
  otherChainFeesSats: 0,
  lightningPaymentFeesSats: 0,
  lightningPaymentCount: 0,
  serviceFeePaidSats: 0,
  totalCostSats: 0,
  netProfitSats: 0,
  notes: [],
  ...o,
});

test("P&L shows every cost the window had: closes with how many and what is unknown, inbound bought, rebalances made outside LightningMate", () => {
  const parts = pnlCostParts(pnl({ channelCloseCostSats: 1_400, channelCloseCount: 2, channelCloseUnknownCount: 1, inboundPurchaseCostSats: 12_307, inboundPurchaseCount: 1, rebalanceCostSats: 350, rebalanceNotLogged: 3, serviceFeePaidSats: 10 }));
  assert.deepEqual(
    parts.map((p) => [p.key, p.sats, p.note ?? null]),
    [
      ["open", 0, null],
      ["rebal", 350, "incl. 3 made outside LightningMate"],
      ["close", 1_400, "2 closes · cost unknown for 1"],
      ["inbound", 12_307, "1 purchase (invoice + routing fee)"],
      ["fee", 10, null],
    ],
  );
  assert.equal(closeNote(pnl()), "no closes");
  assert.ok(!pnlCostParts(pnl()).some((p) => p.key === "inbound"), "no purchase, no segment");
});

test("close fees in a window without a close are what they are: sweeps of closes from before it — never 'Closes 800 · no closes'", () => {
  const close = pnlCostParts(pnl({ channelCloseCostSats: 800, channelCloseCount: 0 })).find((c) => c.key === "close");
  assert.deepEqual([close?.sats, close?.note], [800, "sweeps of earlier closes"]);
});

test("Channel profitability says what its Net is: fees earned − rebalancing, with what a channel brought in beside it — the heading claimed Net included it", () => {
  const rows = channelPnlRows(
    report([stat("hub", { forwardCount: 10, feesEarnedSats: 1_000, routedOutSats: 500_000, inboundForwardCount: 4, inboundFeesSats: 500 })]),
    costs([{ channelId: "hub", feeSats: 300, count: 1 }]),
  );
  const html = renderToStaticMarkup(<ChannelProfitability rows={rows} />);
  assert.ok(html.includes("Net = fees earned − rebalancing cost · “Brought in” beside it · ranked by both"), html);
  assert.ok(!html.includes("fees of the forwards it brought in − rebalancing"), "not the old heading");
  // The Net cell is 1,000 − 300; the 500 brought in shows in its own column.
  assert.match(html, /<td class="num net green"[^>]*>\+700<\/td>/);
  assert.match(html, /<td class="num muted">\+500<\/td>/);
});

test("the Rebalancing figure says how many runs and whose; the ROI figure says how it credits, and waits while refills are measuring", () => {
  assert.equal(rebalanceCostSub(costs([{ channelId: "a", feeSats: 10, count: 5 }], { notLogged: 2 })), "5 runs · 2 made outside LightningMate");
  assert.equal(rebalanceCostSub(costs([{ channelId: "a", feeSats: 10, count: 1 }], { source: "log" })), "1 run · LightningMate's own log (LND unreadable)");
  const base: OutcomesReport["rebalances"] = { method: "first in, first out", measureDays: 14, measured: 0, measuring: 2, totalCostSats: 0, totalEarnedBackSats: 0, avgEarnedBackPct: null, paidBackCount: 0, netSats: 0, items: [] };
  const o = (r: Partial<OutcomesReport["rebalances"]>) => ({ rebalances: { ...base, ...r } }) as OutcomesReport;
  assert.deepEqual(rebalanceRoiKpi(o({})), { value: "—", sub: "2 refills still measuring", title: "first in, first out" });
  assert.deepEqual(rebalanceRoiKpi(o({ measured: 3, avgEarnedBackPct: 120, paidBackCount: 2, measuring: 1 })), {
    value: "120",
    unit: "% back",
    tone: "green",
    sub: "2/3 paid back · own sats, first in first out · 1 measuring",
    title: "first in, first out",
  });
  const summary = { windowDays: 30, count: 4, failed: 1, totalFeeSats: 1_200, totalAmountSats: 0, avgCostPpm: 300 };
  const now = Date.parse("2026-10-20T00:00:00Z");
  assert.equal(rebalanceSummaryLine(summary, "2026-01-01T00:00:00Z", now), "4 done in 30 d · 1,200 sat fees · avg 300 ppm");
  assert.equal(rebalanceSummaryLine(summary, "2026-10-12T08:00:00Z", now), "4 done since 2026-10-12 · 1,200 sat fees · avg 300 ppm", "the log began inside the window: said");
});

test("a category with too little data has no bar — 'insufficient data', never an empty bar that reads as zero", () => {
  assert.deepEqual(scoreBar({ score: null }), { graded: false, label: "insufficient data" });
  assert.deepEqual(scoreBar({ score: 0.426 }), { graded: true, widthPct: 43 });
});

test("the feed names a rebalance, a channel open and a close — and every kind the server sends has a label", () => {
  for (const kind of ["forward", "received", "sent", "rebalance", "onchain_in", "onchain_out", "channel_open", "channel_close"] as const) {
    assert.ok(ACTIVITY_LABEL[kind], kind);
  }
  assert.equal(activitySub({ at: "", kind: "rebalance", title: "", amountSats: -42, feeSats: 42 }, satsCompact), "fee 42 sat");
  assert.equal(activitySub({ at: "", kind: "channel_close", title: "", amountSats: 1, feeSats: 0 }, satsCompact), "on-chain");
  // Rendered, the label is what the row says.
  assert.match(renderToStaticMarkup(<span>{ACTIVITY_LABEL.channel_open}</span>), /Channel open/);
});

test("the viewer's time zone goes with the daily series' requests (minutes east of UTC)", () => {
  assert.equal(tzOffsetMin(), -new Date().getTimezoneOffset());
});

// Review a6-ux:numbers-mislead: the Magma tile showed all-time net profit
// (on-chain costs estimated at today's rate) under the 30d/90d selector.
test("the Analytics Magma tile says it is all time, net with estimated on-chain costs — not the window's", () => {
  assert.equal(magmaLeasesSub(3), "3 sold since the start · net, on-chain costs estimated — the window's lease income is in P&L");
  assert.equal(magmaLeasesSub(0), "none sold yet");
  const panel = readFileSync(new URL("../src/components/AnalyticsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /label="Magma leases · all time"/);
});

// Review of P7: with the Magma report not loaded — or its read failed — the
// tile read "none sold yet", as if the node had never sold.
test("the Analytics Magma tile says 'unknown' when the Magma report couldn't be read — never 'none sold yet' for a report that never came", () => {
  const report = (sold: number, net: number) => ({ analytics: { filledOrdersAllTime: sold, netProfitSat: net } }) as Pick<MagmaV2Report, "analytics">;
  assert.deepEqual(magmaLeasesKpi(null, "Bad Gateway"), { value: "—", sub: "unknown — the Magma report couldn't be read (Bad Gateway)" });
  assert.deepEqual(magmaLeasesKpi(null, null), { value: "—", sub: "loading…" });
  assert.deepEqual(magmaLeasesKpi(report(0, 0), null), { value: "—", sub: "none sold yet" });
  assert.deepEqual(magmaLeasesKpi(report(2, 12_345), null), {
    value: "+12,345",
    unit: "sat",
    tone: "green",
    sub: "2 sold since the start · net, on-chain costs estimated — the window's lease income is in P&L",
  });
  const panel = readFileSync(new URL("../src/components/AnalyticsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /magmaTile: magmaLeasesKpi\(magma, magmaError\)/);
  assert.match(panel, /\.catch\(\(e\) => setMagmaError\(/);
});

test("the Overview's activity folds a run of forwards over one route into a row — eleven '+1 sat' lines hid everything else", async () => {
  const { foldActivity, activitySub } = await import("../src/analyticsView");
  const fwd = (at: string, title: string, fee: number, routed: number) => ({ at, kind: "forward" as const, title, amountSats: fee, routedSats: routed });
  const items = [
    { at: "2026-10-23T01:00:00Z", kind: "received" as const, title: "Paid to Bitaxe.de", amountSats: 216_117 },
    fwd("2026-10-20T10:00:00Z", "okx → flashsats.xyz", 0, 1),
    fwd("2026-10-18T10:00:00Z", "node8153 → rspbltz", 1, 27_800),
    fwd("2026-10-18T09:00:00Z", "node8153 → rspbltz", 1, 33_400),
    fwd("2026-10-18T08:00:00Z", "node8153 → rspbltz", 1, 20_000),
    fwd("2026-10-17T08:00:00Z", "Sally Acorn → rspbltz", 4, 128_700),
    fwd("2026-10-17T07:00:00Z", "Sally Acorn → rspbltz", 5, 154_500),
  ];
  const rows = foldActivity(items, 10);
  assert.deepEqual(
    rows.map((r) => [r.title, r.count, r.amountSats, r.routedSats ?? null, r.at]),
    [
      ["Paid to Bitaxe.de", 1, 216_117, null, "2026-10-23T01:00:00Z"],
      ["okx → flashsats.xyz", 1, 0, 1, "2026-10-20T10:00:00Z"],
      ["node8153 → rspbltz", 3, 3, 81_200, "2026-10-18T10:00:00Z"],
      ["Sally Acorn → rspbltz", 2, 9, 283_200, "2026-10-17T08:00:00Z"],
    ],
  );
  assert.equal(activitySub(rows[2], satsCompact), "81.2k sat routed in 3 forwards");
  assert.equal(activitySub(rows[1], satsCompact), "1 sat routed");
  assert.equal(foldActivity(items, 2).length, 2, "at most `max` rows");
  // Only consecutive forwards over the same route fold: the order stays the feed's.
  const split = foldActivity([fwd("3", "a → b", 1, 1), fwd("2", "c → d", 1, 1), fwd("1", "a → b", 1, 1)], 10);
  assert.deepEqual(split.map((r) => [r.title, r.count]), [["a → b", 1], ["c → d", 1], ["a → b", 1]]);
});
