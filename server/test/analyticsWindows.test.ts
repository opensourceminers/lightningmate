/**
 * Time windows, inbound credit and the activity feed (review
 * a5-analytics:utc-day-windows, a5-analytics:inbound-channels-invisible —
 * package P6).
 *
 * Before:
 *  - "in 24h" was the last bucket of a series of UTC calendar days ending
 *    with the current, partial one (at 02:30 CEST: half an hour of data),
 *    "No forwards in 7 days" was 6 days plus that partial day, the trend
 *    badge put the partial day in its second half, and the forwards of the
 *    window's first (partial) day counted in the totals but in no bucket;
 *  - a forward's fee was credited to its outgoing channel only: a channel
 *    that only ever brought flow in vanished from the profitability view,
 *    and a closed one read "draining · 0% left";
 *  - a rebalance showed in the feed as a receipt AND a payment, funding and
 *    closing transactions as plain on-chain sends and receipts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildForwardsReport, type ForwardEvent } from "../src/services/forwards.js";
import { buildDashboard } from "../src/services/dashboard.js";
import { rankCloseCandidates, type CloseInput } from "../src/services/suggestRecommend.js";
import { boughtInboundRoi } from "../src/services/inboundRoi.js";
import type { ChannelView } from "../src/services/channels.js";
import type { FeeRecommendation } from "../src/services/feeRecommend.js";
import type { MagmaPurchase } from "../src/services/magmaPurchases.js";
import type { RebalanceRecord } from "../src/services/rebalanceLog.js";
import { chanNumber, feeNode, type FakeForward } from "./helpers/feeNode.js";
import { startApi } from "./helpers/apiHarness.js";
import { installChain, installPayments, paymentRpc, rawTx, coin, walletTx } from "./helpers/chain.js";
import { makeTempDir } from "./helpers/tmp.js";
import { quiet } from "./helpers/lifecycle.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 00:30 UTC — 02:30 in Central European Summer Time. */
const NOW = Date.parse("2026-10-20T00:30:00Z");
const A = "850000x1x0";
const B = "850001x1x0";
const fwd = (atMs: number, o: Partial<ForwardEvent> = {}): ForwardEvent => ({
  createdAt: new Date(atMs).toISOString(),
  incomingChannel: B,
  outgoingChannel: A,
  tokens: 100_000,
  fee: 50,
  feeMsat: 50_000,
  ...o,
});
const views = [
  { id: A, peerAlias: "sink", localRatio: 0.4, capacity: 2_000_000, status: "open" as const },
  { id: B, peerAlias: "source", localRatio: 0.7, capacity: 2_000_000, status: "open" as const },
];

test("the last 24 hours and 7 days are rolling windows ending now — at 02:30 CEST 'in 24h' counted half an hour of the UTC day", () => {
  const events = [fwd(NOW - 2 * HOUR), fwd(NOW - 20 * HOUR), fwd(NOW - 30 * HOUR), fwd(NOW - 6.5 * DAY), fwd(NOW - 8 * DAY)];
  const r = buildForwardsReport(events, views, 30, { nowMs: NOW, tzOffsetMin: 0 });
  assert.deepEqual([r.rolling.last24h.forwards, r.rolling.last7d.forwards], [2, 4]);
  assert.equal(r.rolling.last24h.feesSats, 100);
  // The UTC calendar day of now holds only the half hour since midnight:
  // what "in 24h" used to show.
  assert.equal(r.daily[r.daily.length - 1].forwards, 0);
});

test("every forward of the window is in a bucket — the window's first, partial day too — and days are the viewer's", () => {
  // A 7-day window from 2026-10-13 00:30 UTC: a forward on its first, partial day.
  const events = [fwd(Date.parse("2026-10-13T10:00:00Z")), fwd(Date.parse("2026-10-19T23:00:00Z"))];
  const utc = buildForwardsReport(events, views, 7, { nowMs: NOW, tzOffsetMin: 0 });
  assert.equal(utc.daily.reduce((s, d) => s + d.forwards, 0), utc.totalForwards, "before: the first day's forward was in no bucket");
  assert.deepEqual([utc.daily[0].date, utc.daily[utc.daily.length - 1].date], ["2026-10-13", "2026-10-20"]);
  // In CEST (+120 min) 23:00 UTC is 01:00 the next day.
  const cest = buildForwardsReport(events, views, 7, { nowMs: NOW, tzOffsetMin: 120 });
  assert.equal(cest.daily.find((d) => d.date === "2026-10-20")?.forwards, 1);
  assert.equal(cest.daily.find((d) => d.date === "2026-10-19")?.forwards, 0);
  assert.equal(cest.tzOffsetMin, 120);
});

test("the trend compares equal spans ending now: a node routing the same every day reads 0%, not a fall made by the partial day", () => {
  const events = Array.from({ length: 30 }, (_, i) => fwd(Date.parse("2026-10-19T12:00:00Z") - i * DAY));
  const r = buildForwardsReport(events, views, 30, { nowMs: NOW, tzOffsetMin: 0 });
  assert.deepEqual([r.trend.halfDays, r.trend.recentFeesSats, r.trend.priorFeesSats, r.trend.growthPct], [15, 750, 750, 0]);
  // The halves of the old series — 30 UTC days ending with today's partial
  // one: 15 forwards against 14 (today has none yet), "▼ 7%".
  const oldDays = Array.from({ length: 30 }, (_, i) => new Date(NOW - (29 - i) * DAY).toISOString().slice(0, 10));
  const inDays = (days: string[]) => events.filter((e) => days.includes(e.createdAt.slice(0, 10))).length;
  assert.deepEqual([inDays(oldDays.slice(0, 15)), inDays(oldDays.slice(15))], [15, 14], "the calendar halves showed a fall that isn't there");
  // An odd window: 7 days, halves of 3 × 24 h — a forward 6.5 days back is
  // in neither half (both halves stay the same length).
  const odd = buildForwardsReport([fwd(NOW - 1 * DAY), fwd(NOW - 4 * DAY), fwd(NOW - 6.5 * DAY)], views, 7, { nowMs: NOW, tzOffsetMin: 0 });
  assert.deepEqual([odd.trend.halfDays, odd.trend.recentFeesSats, odd.trend.priorFeesSats, odd.trend.growthPct], [3, 50, 50, 0]);
});

test("a channel that only brings flow in is credited with the fees of the forwards it brought — and one no longer open is 'closed', never 'draining'", () => {
  const C = "849000x9x0"; // closed since
  const events = [fwd(NOW - DAY), fwd(NOW - 2 * DAY), fwd(NOW - 3 * DAY, { incomingChannel: B, outgoingChannel: C, feeMsat: 30_000, fee: 30 })];
  const r = buildForwardsReport(events, views, 30, { nowMs: NOW, tzOffsetMin: 0 });
  const by = Object.fromEntries(r.perChannel.map((c) => [c.channelId, c]));
  assert.deepEqual([by[B].feesEarnedSats, by[B].inboundFeesSats, by[B].inboundForwardCount], [0, 130, 3]);
  assert.deepEqual([by[A].feesEarnedSats, by[A].inboundFeesSats], [100, 0]);
  assert.deepEqual([by[C].status, by[C].flow], ["closed", "draining"]);
  assert.equal(r.perChannel[0].channelId, B, "ranked by what it earned plus what it brought in");
});

test("close suggestions count what a channel brought in: a source channel whose 60 days earned 500 sat on forwards it brought in and cost 100 in rebalancing is not 'losing'", () => {
  const HEIGHT = 860_000;
  const source: ChannelView = {
    id: `${HEIGHT - 9_000}x5x0`,
    peerPubkey: "02" + "55".repeat(32),
    peerAlias: "source",
    active: true,
    private: false,
    initiator: "local",
    capacity: 2_000_000,
    transactionId: "55".repeat(32),
    transactionVout: 0,
    localBalance: 1_500_000,
    remoteBalance: 500_000,
    localRatio: 0.75,
    totalSent: 0,
    totalReceived: 0,
    unsettled: 0,
    status: "open",
    role: "source",
  };
  const fee = { channelId: source.id, state: "normal", metrics: { routedOut30d: 0, routedIn30d: 0, revenue30d: 0, channelAgeDays: 60, isTopEarner: false, peerGate: "ok" } } as unknown as FeeRecommendation;
  const refill: RebalanceRecord = { at: new Date(Date.now() - 40 * DAY).toISOString(), via: "autopilot", targetId: source.id, targetAlias: "source", sourceId: "x", sourceAlias: "x", amountSats: 100_000, budgetPpm: 1000, feeSats: 100, costPpm: 1000, ok: true };
  const input = (inboundFeesEarned: number | undefined): CloseInput => ({
    channels: [source],
    feeById: new Map([[source.id, fee]]),
    flow60ById: new Map([[source.id, { routedOut: 0, routedIn: 4_000_000, forwardCount: 0, feesEarned: 0, ...(inboundFeesEarned !== undefined ? { inboundFeesEarned } : {}) }]]),
    uniqueReachByChan: new Map([[source.id, 0]]),
    opportunity: [],
    closeCostSat: 500,
    rebalanceRecords: [refill],
    channelOverrides: {},
    leases: new Map(),
    offline: () => null,
    nowMs: Date.now(),
  });
  // Outgoing fees only: −100 sat over 60 days, "Negative P&L" — a close candidate.
  const outOnly = rankCloseCandidates(input(undefined));
  assert.equal(outOnly.candidates.length, 1);
  assert.match(outOnly.candidates[0].reasons.join(" "), /Negative P&L: -100 sat over 60d/);
  const withInbound = rankCloseCandidates(input(500));
  assert.equal(withInbound.candidates.length, 0, "what it brought in counts for it");
});

test("the activity feed shows a rebalance once, as what it cost — and funding and closing transactions as channel opens and closes", () => {
  const own = "02" + "0e".repeat(32);
  const H = "ab".repeat(32);
  const emptyReport = { windowDays: 30, totalFeesEarnedSats: 0, totalForwards: 0, totalRoutedSats: 0, daily: [], recent: [], perChannel: [] } as unknown as Parameters<typeof buildDashboard>[0];
  const d = buildDashboard(
    emptyReport,
    {
      invoices: [{ id: H, tokens: 200_000, description: "", isPaid: true, receivedSats: 200_000, createdAt: new Date(NOW).toISOString() }],
      payments: [{ id: H, destination: own, tokens: 200_000, feeSats: 42, isConfirmed: true, createdAt: new Date(NOW).toISOString() }],
    },
    [
      { id: "f1".repeat(32), amountSats: -2_003_000, feeSats: 3_000, confirmations: 6, isConfirmed: true, isOutgoing: true, createdAt: new Date(NOW - HOUR).toISOString() },
      { id: "c1".repeat(32), amountSats: 1_198_600, feeSats: 0, confirmations: 6, isConfirmed: true, isOutgoing: false, createdAt: new Date(NOW - 2 * HOUR).toISOString() },
    ],
    { count: 1, totalAmountSats: 200_000 },
    { config: { enabled: false, rebalanceEnabled: false, channelEnabled: false, sellEnabled: false, intervalMinutes: 30 }, lastRunAt: null, history: [] },
    0,
    {
      ownCapitalSats: 0,
      rebalanceFeesSats: 42,
      leaseBenchmark: { status: "unknown", grossAprPct: null, sales: null, windowDays: null, text: "" },
      magmaRefusals: [],
      ownPubkey: own,
      channelTxids: { opens: new Set(["f1".repeat(32)]), closes: new Set(["c1".repeat(32)]) },
    },
  );
  assert.deepEqual(
    d.activity.map((a) => [a.kind, a.title, a.amountSats]),
    [
      ["rebalance", "200,000 sat moved", -42],
      ["channel_open", "Channel open", -2_003_000],
      ["channel_close", "Channel close", 1_198_600],
    ],
  );
});

test("GET /dashboard: rolling 24 h and 7 days, the viewer's days, one row per rebalance, a funding transaction as a channel open", async (t) => {
  quiet(t);
  const now = Date.now();
  const forwards: FakeForward[] = [
    { at: now - 3 * HOUR, inId: B, outId: A, tokens: 50_000, feeMsat: 40_000 },
    { at: now - 26 * HOUR, inId: B, outId: A, tokens: 50_000, feeMsat: 40_000 },
    { at: now - 10 * DAY, inId: B, outId: A, tokens: 50_000, feeMsat: 40_000 },
  ];
  const fund = rawTx({ inputs: [coin()], outputs: [{ value: 2_000_000 }, { value: 400_000 }] });
  const node = feeNode({
    channels: [
      { id: A, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 800_000, transactionId: fund.txid, transactionVout: 0 },
      { id: B, partnerPublicKey: "02" + "a2".repeat(32), capacity: 2_000_000, localBalance: 1_400_000, transactionId: "a2".repeat(32), transactionVout: 0 },
    ],
    forwards,
  });
  installChain(node, { txs: [walletTx(fund, { amount: -2_003_000, fee: 3_000, at: now - 2 * HOUR, local: true })] });
  installPayments(node, [paymentRpc({ at: now - HOUR, tokens: 300_000, feeMsat: 120_000, destination: node.publicKey, lastChannel: A })]);
  const api = await startApi(t, { node });
  const res = await api.request("GET", "/dashboard?tz=120");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body;
  assert.deepEqual([d.rolling.last24h.forwards, d.rolling.last7d.forwards], [1, 2]);
  assert.deepEqual([d.rebalanceFeesSats, d.rebalancedCount, d.rebalancedSats, d.rebalanceSource], [120, 1, 300_000, "lnd"]);
  const kinds = d.activity.map((a: { kind: string }) => a.kind);
  assert.equal(kinds.filter((k: string) => k === "rebalance").length, 1);
  assert.ok(!kinds.includes("sent"), "the rebalance is not also a payment");
  assert.ok(kinds.includes("channel_open"), JSON.stringify(kinds));
  assert.equal(d.feesSpark.length, 31, "30 days: 31 local days, the first and last partial");
});

const bought = (o: Partial<MagmaPurchase> & { orderId: string }): MagmaPurchase => ({
  createdAt: new Date(NOW - 41 * DAY).toISOString(),
  updatedAt: new Date(NOW - 40 * DAY).toISOString(),
  offerId: "o",
  sellerPubkey: "02" + "f6".repeat(32),
  sizeSats: 3_000_000,
  feeSats: 12_300,
  paymentRequest: "lnbc1",
  paymentHash: "aa".repeat(32),
  payee: "02" + "f6".repeat(32),
  expiresAt: new Date(NOW).toISOString(),
  leaseBlocks: 4_320,
  feeRateCapPpm: null,
  baseFeeCapSats: null,
  usdCents: null,
  state: "channel_open",
  routingFeeSats: 7,
  paidAt: new Date(NOW - 40 * DAY).toISOString(),
  orderStatus: "VALID_CHANNEL_OPENING",
  channelId: B,
  ...o,
});

test("bought inbound gets a simple return: the fees of the forwards that came in through it during its lease, against what it cost", () => {
  const events = [
    fwd(NOW - 35 * DAY, { feeMsat: 4_000_000, fee: 4_000 }), // in through B, in the lease
    fwd(NOW - 8 * DAY, { feeMsat: 2_000_000, fee: 2_000 }), // after its 30-day lease ended (paid 40 days ago)
    fwd(NOW - 20 * DAY, { incomingChannel: A, outgoingChannel: B, feeMsat: 9_000_000, fee: 9_000 }), // out through it: not what it brought in
  ];
  const [r] = boughtInboundRoi([bought({ orderId: "buy-1" })], (p) => (p.channelId ? { channelId: p.channelId, alias: "seller" } : null), events, NOW);
  assert.deepEqual([r.costSats, r.inboundForwards, r.inboundFeesSats, r.roiPct, r.running], [12_307, 1, 4_000, 33, false]);
});

test("GET /analytics/bought-inbound finds the bought channel through the lease registry", async (t) => {
  quiet(t);
  const now = Date.now();
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "magma-purchases.json"), JSON.stringify([bought({ orderId: "buy-2", paidAt: new Date(now - 5 * DAY).toISOString(), createdAt: new Date(now - 6 * DAY).toISOString() })]));
  const node = feeNode({
    channels: [
      { id: A, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 800_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: B, partnerPublicKey: "02" + "f6".repeat(32), capacity: 3_000_000, localBalance: 0, transactionId: "f6".repeat(32), transactionVout: 0, partnerInitiated: true },
    ],
    forwards: [{ at: now - 2 * DAY, inId: B, outId: A, tokens: 400_000, feeMsat: 1_500_000 }],
  });
  const api = await startApi(t, { node, dir });
  const res = await api.request("GET", "/analytics/bought-inbound");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(
    res.body.items.map((i: { orderId: string; channelId: string; inboundFeesSats: number; roiPct: number; running: boolean }) => [i.orderId, i.channelId, i.inboundFeesSats, i.roiPct, i.running]),
    [["buy-2", B, 1_500, 12, true]],
  );
  assert.match(res.body.method, /came in through the bought channel while its lease ran/);
});

test("more forwards in the window than are read: LND hands them over oldest first, so the NEWEST are missing — the dashboard says its rolling figures are incomplete, P&L says what is missing", async (t) => {
  quiet(t);
  const now = Date.now();
  const node = feeNode({
    channels: [
      { id: A, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 800_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: B, partnerPublicKey: "02" + "a2".repeat(32), capacity: 2_000_000, localBalance: 1_400_000, transactionId: "a2".repeat(32), transactionVout: 0 },
    ],
  });
  // A busy node: a forward every 15 seconds for the last 30 days (172,800)
  // — more than the 100 pages of 1,000 that are read.
  const STEP = 15_000;
  const first = now - 30 * DAY;
  const pages: number[] = [];
  node.override("default.forwardingHistory", (a, cb) => {
    const from = Math.max(first, Number(a.start_time) * 1000);
    const offset = Number(a.index_offset ?? 0);
    const max = Number(a.num_max_events ?? 100);
    const start = Math.ceil((from - first) / STEP) + offset;
    const end = Math.min(start + max, Math.floor((now - first) / STEP));
    pages.push(offset);
    const events = [];
    for (let i = start; i < end; i++) {
      const ms = first + i * STEP;
      events.push({
        amt_in: "50001",
        amt_in_msat: "50001000",
        amt_out: "50000",
        amt_out_msat: "50000000",
        chan_id_in: chanNumber(B),
        chan_id_out: chanNumber(A),
        fee: "1",
        fee_msat: "1000",
        timestamp: String(Math.floor(ms / 1000)),
        timestamp_ns: String(BigInt(ms) * 1_000_000n),
      });
    }
    cb(null, { forwarding_events: events, last_offset_index: String(offset + events.length) });
  });
  installChain(node);
  installPayments(node, []);
  const api = await startApi(t, { node });
  const d = (await api.request("GET", "/dashboard")).body;
  assert.equal(d.forwardsComplete, false);
  assert.equal(d.forwardCount, 100_000);
  // What was read ends about 12 days ago: the rolling counts read 0 — which
  // is why the Overview must not say "no forwards in 7 days".
  assert.deepEqual([d.rolling.last24h.forwards, d.rolling.last7d.forwards], [0, 0]);
  const p = (await api.request("GET", "/pnl?days=30")).body;
  assert.ok(p.notes.includes("Routing revenue: only the first 100,000 forwards of this window were read — the most recent are missing"), JSON.stringify(p.notes));
  assert.ok(pages.length >= 200, "two full reads, 100 pages each");
});
