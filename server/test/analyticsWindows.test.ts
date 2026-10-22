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
import { closedChannel, installChain, installPayments, paymentRpc, rawTx, coin, walletTx } from "./helpers/chain.js";
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
    { config: { enabled: false, rebalanceEnabled: false, channelEnabled: false, sellEnabled: false, maxHtlcEnabled: false, intervalMinutes: 30 }, lastRunAt: null, history: [] },
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

// Review of P6: a channel still closing — its commitment and the anchor CPFP
// that pays for it — read "On-chain send/receive" until LND listed it closed.
test("a channel still closing: its closing transaction and the fee bump spending it are named as that channel's close", () => {
  const emptyReport = { windowDays: 30, totalFeesEarnedSats: 0, totalForwards: 0, totalRoutedSats: 0, daily: [], recent: [], perChannel: [] } as unknown as Parameters<typeof buildDashboard>[0];
  const commit = "d1".repeat(32);
  const d = buildDashboard(
    emptyReport,
    { invoices: [], payments: [] },
    [
      { id: commit, amountSats: -2_810, feeSats: 2_810, confirmations: 0, isConfirmed: false, isOutgoing: true, createdAt: new Date(NOW - 2 * HOUR).toISOString() },
      // The CPFP: spends the commitment's anchor (no wallet coin) and a
      // wallet coin. (btcwallet reports no fee for it: one input isn't the
      // wallet's — its amount is the anchor minus the fee paid.)
      {
        id: "d2".repeat(32), amountSats: -1_170, feeSats: 0, confirmations: 0, isConfirmed: false, isOutgoing: true, createdAt: new Date(NOW - HOUR).toISOString(),
        spends: [commit, "e9".repeat(32)], spendsNonWallet: [commit],
      },
      // A payment out of the wallet stays a send.
      { id: "d3".repeat(32), amountSats: -50_000, feeSats: 300, confirmations: 1, isConfirmed: true, isOutgoing: true, createdAt: new Date(NOW - 3 * HOUR).toISOString(), spends: ["e9".repeat(32)] },
    ],
    { count: 0, totalAmountSats: 0 },
    { config: { enabled: false, rebalanceEnabled: false, channelEnabled: false, sellEnabled: false, maxHtlcEnabled: false, intervalMinutes: 30 }, lastRunAt: null, history: [] },
    0,
    {
      ownCapitalSats: 0,
      rebalanceFeesSats: 0,
      leaseBenchmark: { status: "unknown", grossAprPct: null, sales: null, windowDays: null, text: "" },
      magmaRefusals: [],
      channelTxids: { opens: new Set(), closes: new Set([commit]), closingNow: new Set([commit]), closeTitles: new Map([[commit, "ACINQ"]]) },
    },
  );
  assert.deepEqual(
    d.activity.map((a) => [a.kind, a.title]),
    [
      ["channel_close", "ACINQ — fee bump or sweep"],
      ["channel_close", "ACINQ"],
      ["onchain_out", "On-chain send"],
    ],
  );
});

// Review of P7: the rule above named EVERY transaction spending any close's
// output part of that close — a cooperative close pays our balance to an
// ordinary wallet coin, and a later send funded by it read "ACINQ — fee bump
// or sweep" with the whole amount sent.
test("a send funded by a close's payout stays a send — a long-closed cooperative close, and one still closing whose payout is already a wallet coin", () => {
  const emptyReport = { windowDays: 30, totalFeesEarnedSats: 0, totalForwards: 0, totalRoutedSats: 0, daily: [], recent: [], perChannel: [] } as unknown as Parameters<typeof buildDashboard>[0];
  const coopClose = "a1".repeat(32); // closed days ago: its payout is a wallet coin
  const closing = "a3".repeat(32); // a cooperative close not confirmed yet
  const d = buildDashboard(
    emptyReport,
    { invoices: [], payments: [] },
    [
      { id: coopClose, amountSats: 1_200_000, feeSats: 0, confirmations: 500, isConfirmed: true, isOutgoing: false, createdAt: new Date(NOW - 72 * HOUR).toISOString() },
      // A week later the operator sends 800k to an exchange; LND funds it
      // with the coin that close paid out — a wallet coin.
      {
        id: "b2".repeat(32), amountSats: -800_300, feeSats: 300, confirmations: 1, isConfirmed: true, isOutgoing: true, createdAt: new Date(NOW - HOUR).toISOString(),
        spends: [coopClose],
      },
      // A send funded by the payout of a close still pending (a wallet coin
      // too): a send, not that close's fee bump.
      {
        id: "b3".repeat(32), amountSats: -90_250, feeSats: 250, confirmations: 0, isConfirmed: false, isOutgoing: true, createdAt: new Date(NOW - 2 * HOUR).toISOString(),
        spends: [closing],
      },
    ],
    { count: 0, totalAmountSats: 0 },
    { config: { enabled: false, rebalanceEnabled: false, channelEnabled: false, sellEnabled: false, maxHtlcEnabled: false, intervalMinutes: 30 }, lastRunAt: null, history: [] },
    0,
    {
      ownCapitalSats: 0,
      rebalanceFeesSats: 0,
      leaseBenchmark: { status: "unknown", grossAprPct: null, sales: null, windowDays: null, text: "" },
      magmaRefusals: [],
      channelTxids: {
        opens: new Set(),
        closes: new Set([coopClose, closing]),
        closingNow: new Set([closing]),
        closeTitles: new Map([[coopClose, "ACINQ"], [closing, "Kraken"]]),
      },
    },
  );
  assert.deepEqual(
    d.activity.map((a) => [a.kind, a.title, a.amountSats]),
    [
      ["onchain_out", "On-chain send", -800_300],
      ["onchain_out", "On-chain send", -90_250],
      ["channel_close", "ACINQ", 1_200_000],
    ],
  );
});

test("GET /dashboard: a force close still pending — its commitment from LND's pending channels, the CPFP by what it spends — reads as that channel's close", async (t) => {
  quiet(t);
  const now = Date.now();
  const commit = rawTx({ inputs: [{ txid: "c7".repeat(32), vout: 0 }], outputs: [{ value: 330 }, { value: 330 }, { value: 1_195_000 }] });
  const cpfp = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }, coin()], outputs: [{ value: 40_000 }] });
  const node = feeNode({ channels: [], forwards: [] });
  node.pending.push({ partnerPublicKey: "02" + "c7".repeat(32), capacity: 2_000_000, transactionId: "c7".repeat(32), transactionVout: 0, state: "force_closing", closingTxid: commit.txid });
  installChain(node, {
    txs: [
      walletTx(commit, { amount: -2_810, fee: 2_810, at: now - 2 * HOUR, confirmations: 0 }),
      walletTx(cpfp, { amount: -1_500, fee: 1_500, at: now - HOUR, confirmations: 0, local: [false, true] }),
    ],
  });
  installPayments(node, []);
  const api = await startApi(t, { node });
  const channels = (await api.request("GET", "/channels")).body as { status: string; peerAlias: string; closeTransactionId?: string }[];
  const closing = channels.find((c) => c.status === "pending_close");
  assert.equal(closing?.closeTransactionId, commit.txid);
  const res = await api.request("GET", "/dashboard");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body;
  const lines = d.activity.filter((a: { kind: string }) => a.kind !== "forward").map((a: { kind: string; title: string }) => [a.kind, a.title]);
  // Before: "On-chain send" twice, until LND listed the channel as closed.
  assert.deepEqual(lines, [
    ["channel_close", `${closing?.peerAlias} — fee bump or sweep`],
    ["channel_close", closing?.peerAlias],
  ]);
});

test("GET /dashboard: an on-chain send funded by a cooperative close's payout is a send — not that close's 'fee bump or sweep' (review of P7)", async (t) => {
  quiet(t);
  const now = Date.now();
  const funding = { txid: "c8".repeat(32), vout: 0 };
  // The close paid our 1.195M to a wallet address: an ordinary wallet coin.
  const coop = rawTx({ inputs: [funding], outputs: [{ value: 1_195_000 }, { value: 800_000 }] });
  const send = rawTx({ inputs: [{ txid: coop.txid, vout: 0 }], outputs: [{ value: 800_000 }, { value: 394_700 }] });
  // A cooperative close LND still lists as closing (not confirmed yet) —
  // and a send funded by its payout, also a wallet coin.
  const closingFunding = { txid: "c9".repeat(32), vout: 0 };
  const closing = rawTx({ inputs: [closingFunding], outputs: [{ value: 500_000 }, { value: 1_495_000 }] });
  const send2 = rawTx({ inputs: [{ txid: closing.txid, vout: 0 }], outputs: [{ value: 400_000 }, { value: 99_750 }] });
  const node = feeNode({ channels: [], forwards: [] });
  node.pending.push({
    partnerPublicKey: "02" + "c9".repeat(32), capacity: 2_000_000, transactionId: closingFunding.txid, transactionVout: 0, state: "waiting_close", closingTxid: closing.txid,
  });
  installChain(node, {
    txs: [
      walletTx(coop, { amount: 1_195_000, at: now - 3 * DAY, confirmations: 400 }),
      // LND funds the send with that coin — a wallet input (is_our_output).
      walletTx(send, { amount: -800_300, fee: 300, at: now - HOUR, confirmations: 1, local: true }),
      walletTx(closing, { amount: 500_000, at: now - 3 * HOUR, confirmations: 0 }),
      walletTx(send2, { amount: -400_250, fee: 250, at: now - 2 * HOUR, confirmations: 0, local: true }),
    ],
    closed: [closedChannel({ id: "840000x1x0", capacity: 2_000_000, funding, closeTxid: coop.txid, type: "COOPERATIVE_CLOSE", weOpened: true })],
  });
  installPayments(node, []);
  const api = await startApi(t, { node });
  const res = await api.request("GET", "/dashboard");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const lines = res.body.activity
    .filter((a: { kind: string }) => a.kind !== "forward")
    .map((a: { kind: string; title: string; amountSats: number }) => [a.kind, a.amountSats < 0 ? a.title : "close", a.amountSats]);
  // Before: ["channel_close", "<alias> — fee bump or sweep", -800300] — and
  // the same for the send out of the closing channel's payout.
  assert.deepEqual(lines, [
    ["onchain_out", "On-chain send", -800_300],
    ["onchain_out", "On-chain send", -400_250],
    ["channel_close", "close", 500_000],
    ["channel_close", "close", 1_195_000],
  ]);
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

// Review of P6 (PROBE-BOUGHT-HORIZON): a purchase whose lease lies before the
// forwards read (at most 400 days) read a measured 0 % — "not measured" now.
test("PROBE-BOUGHT-HORIZON: a purchase whose lease lies before the 400-day forwards read is not measured — roiPct null, with the reason", async (t) => {
  quiet(t);
  const now = Date.now();
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "magma-purchases.json"),
    JSON.stringify([
      bought({ orderId: "old-buy", channelId: "850001x1x0", createdAt: new Date(now - 451 * DAY).toISOString(), updatedAt: new Date(now - 450 * DAY).toISOString(), paidAt: new Date(now - 450 * DAY).toISOString() }),
    ]),
  );
  const node = feeNode({
    channels: [
      { id: "850000x1x0", partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 800_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: "850001x1x0", partnerPublicKey: "02" + "f6".repeat(32), capacity: 3_000_000, localBalance: 0, transactionId: "f6".repeat(32), transactionVout: 0, partnerInitiated: true },
    ],
    // 20,000 sat of fees came in through the bought channel during its lease (440 days ago).
    forwards: [{ at: now - 440 * DAY, inId: "850001x1x0", outId: "850000x1x0", tokens: 4_000_000, feeMsat: 20_000_000 }],
  });
  const api = await startApi(t, { node, dir });
  const res = await api.request("GET", "/analytics/bought-inbound?days=30");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [item] = res.body.items;
  // Before: [0, 0, 0] — a measured 0 % return, in red.
  assert.equal(item.roiPct, null);
  assert.match(item.roiNote, /^not measured: the lease began \d{4}-\d{2}-\d{2}, before the forwards read \(they are read from \d{4}-\d{2}-\d{2}\)$/);
  assert.equal(res.body.forwardsComplete, true);
});

test("a forwards read cut short (the newest missing): a running lease is not measured — one that ended before the newest forward read still is", () => {
  const events = [
    fwd(NOW - 35 * DAY, { feeMsat: 4_000_000, fee: 4_000 }), // the newest forward read: 35 days ago
  ];
  const ended = bought({ orderId: "ended", paidAt: new Date(NOW - 70 * DAY).toISOString() }); // lease over 40 days ago
  const running = bought({ orderId: "running", paidAt: new Date(NOW - 10 * DAY).toISOString() });
  const rows = boughtInboundRoi([ended, running], (p) => (p.channelId ? { channelId: p.channelId, alias: "seller" } : null), events, NOW, { fromMs: NOW - 100 * DAY, complete: false });
  const by = Object.fromEntries(rows.map((r) => [r.orderId, r]));
  assert.equal(by.ended.roiNote, null);
  assert.equal(typeof by.ended.roiPct, "number");
  assert.equal(by.running.roiPct, null);
  assert.match(by.running.roiNote ?? "", /LND holds more forwards than are read, and the newest — this lease's latest — are the ones missing/);
  // A complete read measures both.
  const full = boughtInboundRoi([running], (p) => (p.channelId ? { channelId: p.channelId, alias: "seller" } : null), events, NOW, { fromMs: NOW - 100 * DAY, complete: true });
  assert.deepEqual([full[0].roiPct, full[0].roiNote], [0, null]);
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
