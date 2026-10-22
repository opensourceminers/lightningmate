/**
 * The health score (review a5-analytics:health-score-pending-gross, package P6).
 *
 * Before: channels still opening or closing (a fresh Magma sale, a force close
 * in its two-week timelock) counted as offline, dead capacity — Connectivity,
 * Hygiene and Earnings fell for a channel doing exactly what it should; and
 * Earnings looked at gross activity only — a node spending more on
 * rebalancing and opens than it earned could get full marks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeNodeScore, leaseIncomeInLast30, MIN_HISTORY_DAYS, purchasesInLast30, type ScoreInput } from "../src/services/score.js";
import type { SaleRecord } from "../src/services/earningsLog.js";
import type { ServiceFeeEntry } from "../src/services/serviceFee.js";
import type { MagmaPurchase } from "../src/services/magmaPurchases.js";
import type { SoldLease } from "../src/services/leaseCaps.js";
import { feeNode } from "./helpers/feeNode.js";
import { startApi } from "./helpers/apiHarness.js";
import { coin, installChain, installPayments, paymentRpc, rawTx, walletTx } from "./helpers/chain.js";
import { makeTempDir } from "./helpers/tmp.js";
import { quiet } from "./helpers/lifecycle.js";

type Ch = ScoreInput["channels"][number];
const ch = (n: number, o: Partial<Ch> = {}): Ch => ({
  id: `84${n}000x1x0`,
  peerPubkey: "02" + n.toString(16).padStart(2, "0").repeat(32),
  peerAlias: `peer-${n}`,
  active: true,
  capacity: 2_000_000,
  status: "open",
  ...o,
});

function input(o: Partial<ScoreInput> = {}): ScoreInput {
  const channels = o.channels ?? [ch(1), ch(2), ch(3), ch(4)];
  return {
    channels,
    feePpmById: new Map(channels.map((c) => [c.id, 300])),
    forwards30: 60,
    routingRevenue30Sats: 4_000,
    onchainSats: 500_000,
    outboundSats: 4_000_000,
    inboundSats: 4_000_000,
    rank: null,
    rebalance30Sats: 0,
    chainCostsYearSats: 0,
    purchases30Sats: 0,
    leaseIncome30Sats: 0,
    historyDays: 120,
    ...o,
  };
}
const cat = (s: ReturnType<typeof computeNodeScore>, key: string) => s.categories.find((c) => c.key === key)!;

test("channels still opening or closing are not dead capacity: they change no share or denominator — and the detail line names them", () => {
  const base = computeNodeScore(input());
  const pending: Ch[] = [ch(1), ch(2), ch(3), ch(4), ch(5, { id: "aa".repeat(32) + ":0", active: false, capacity: 5_000_000, status: "pending_open" }), ch(6, { id: "bb".repeat(32) + ":0", active: false, capacity: 3_000_000, status: "pending_close" })];
  const withPending = computeNodeScore(input({ channels: pending }));
  for (const key of ["connectivity", "scale", "earnings", "hygiene"]) {
    assert.equal(cat(withPending, key).score, cat(base, key).score, key);
  }
  assert.equal(withPending.score, base.score);
  assert.match(cat(withPending, "hygiene").detail, /100% capacity online · 1 opening · 1 closing \(not counted\)$/);
  assert.match(cat(withPending, "connectivity").detail, /1 opening · 1 closing \(not counted\)$/);
});

test("Earnings are net of what the node spends: rebalancing, on-chain opens and closes spread over a year, inbound bought spread over its lease", () => {
  const gross = computeNodeScore(input());
  // 4,000 sat earned in 30 days; 3,000 on rebalancing and 24,000 a year on chain: net −1,000.
  const losing = computeNodeScore(input({ rebalance30Sats: 3_000, chainCostsYearSats: 24_000 }));
  assert.ok((cat(losing, "earnings").score as number) < (cat(gross, "earnings").score as number), "spending more than it earns costs marks");
  assert.equal(cat(losing, "earnings").score, 0.5, "activity only: the net yield is below zero");
  assert.match(cat(losing, "earnings").detail, /60 forwards · ~-125 ppm\/mo net of costs/);
  assert.match(cat(losing, "earnings").hint, /Costs outrun routing income: 3000 sat rebalancing and ~2000 sat\/month of on-chain opens and closes against 4000 sat earned/);
  const bought = computeNodeScore(input({ purchases30Sats: 4_000 }));
  assert.equal(cat(bought, "earnings").score, 0.5, "inbound bought counts as a cost too");
  // Costs unknown (LND unreadable): said, not hidden.
  assert.match(cat(computeNodeScore(input({ rebalance30Sats: null })), "earnings").detail, /gross \(costs unknown\)/);
});

test("a node too young to judge gets no Earnings grade — 'insufficient data', left out of the score, the grade marked provisional", () => {
  const young = computeNodeScore(input({ historyDays: 5, forwards30: 2, routingRevenue30Sats: 10 }));
  const e = cat(young, "earnings");
  assert.equal(e.score, null);
  assert.match(e.detail, new RegExp(`insufficient data — 5 days of history \\(needs ${MIN_HISTORY_DAYS}\\)`));
  assert.match(young.provisional ?? "", /Earnings not graded yet — 5 days of history/);
  const judged = young.categories.filter((c) => c.score !== null);
  const expected = Math.round((judged.reduce((s, c) => s + (c.score as number) * c.weight, 0) / judged.reduce((s, c) => s + c.weight, 0)) * 100);
  assert.equal(young.score, expected, "the other categories carry the score");
  // Old enough, but a handful of forwards: no yield read into them.
  const few = computeNodeScore(input({ forwards30: 6, routingRevenue30Sats: 9_000 }));
  assert.equal(cat(few, "earnings").score, 0.05, "activity only (6 / 60 × 0.5)");
  assert.match(cat(few, "earnings").detail, /6 forwards in 30 d — too few to judge a yield/);
  assert.equal(few.provisional, null);
});

test("inbound bought counts in the last 30 days for its share of the lease", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const p = (paidDaysAgo: number, leaseBlocks: number) => ({ orderId: "x", at: new Date(now - paidDaysAgo * 86_400_000).toISOString(), feeSats: 30_000, routingFeeSats: 0, sizeSats: 1, leaseBlocks });
  // A 30-day lease paid 10 days ago: 10 of its 30 days fall in the window; a
  // 60-day lease paid 50 days ago: all 30 of them (of its 60); one that ended
  // before the window: none.
  assert.equal(purchasesInLast30({ paidCosts: () => [p(10, 4_320), p(50, 8_640), p(80, 4_320)] }, now), 10_000 + 15_000);
});

test("GET /score: a channel still opening counts nowhere, and the node's rebalancing comes off its earnings", async (t) => {
  quiet(t);
  const node = feeNode({
    channels: [
      { id: "840000x1x0", partnerPublicKey: "02" + "01".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "01".repeat(32), transactionVout: 0, feeRatePpm: 300 },
      { id: "840001x1x0", partnerPublicKey: "02" + "02".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "02".repeat(32), transactionVout: 0, feeRatePpm: 300 },
    ],
    forwards: Array.from({ length: 20 }, (_, i) => ({ at: Date.now() - (i + 1) * 3_600_000, inId: "840001x1x0", outId: "840000x1x0", tokens: 50_000, feeMsat: 100_000 })),
  });
  node.pending.push({ partnerPublicKey: "02" + "03".repeat(32), capacity: 9_000_000, transactionId: "03".repeat(32), transactionVout: 0 });
  installChain(node);
  // 2,000 sat earned in 30 days; 3,000 sat of rebalancing (another tool's).
  installPayments(node, [paymentRpc({ at: Date.now() - 86_400_000, tokens: 500_000, feeMsat: 3_000_000, destination: node.publicKey, lastChannel: "840000x1x0" })]);
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const api = await startApi(t, { node });
  const res = await api.request("GET", "/score");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const by = Object.fromEntries((res.body.categories as { key: string; score: number | null; detail: string }[]).map((c) => [c.key, c]));
  assert.match(by.hygiene.detail, /100% capacity online · 1 opening \(not counted\)/);
  // (2,000 − 3,000) sat on the 4M of open capacity — the 9M still opening
  // is not counted.
  assert.match(by.earnings.detail, /20 forwards · ~-250 ppm\/mo net of costs/);
});

test("a node whose history can't be told is not graded on Earnings either — 'insufficient data', and says why", () => {
  // Open channels, but LND's chain height unreadable: their age unknown.
  const unknown = computeNodeScore(input({ historyDays: null }));
  assert.equal(cat(unknown, "earnings").score, null);
  assert.match(cat(unknown, "earnings").detail, new RegExp(`insufficient data — its history can't be read \\(needs ${MIN_HISTORY_DAYS}\\)`));
  assert.match(unknown.provisional ?? "", /Earnings not graded yet — its history can't be read/);
  // No open channel at all: said so.
  const none = computeNodeScore(input({ channels: [], historyDays: null }));
  assert.match(cat(none, "earnings").detail, /insufficient data — no open channel yet/);
});

// ── Review 2 of P6 ───────────────────────────────────────────────────────────

const DAY = 86_400_000;

test("a seller node's Earnings count what its sales earned, as P&L does: a node in profit never reads a negative yield or 'Costs outrun routing income' (before: its sale's open cost counted, its lease income not)", async (t) => {
  quiet(t);
  const now = Date.now();
  const dir = makeTempDir(t);
  // The sold channel: funded by this node 20 days ago, a 36,000 sat funding fee.
  const fund = rawTx({ inputs: [coin()], outputs: [{ value: 3_000_000 }, { value: 500_000 }] });
  const node = feeNode({
    channels: [
      { id: "840000x1x0", partnerPublicKey: "02" + "01".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "01".repeat(32), transactionVout: 0, feeRatePpm: 300 },
      { id: "840001x1x0", partnerPublicKey: "02" + "02".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "02".repeat(32), transactionVout: 0, feeRatePpm: 300 },
      { id: "859000x1x0", partnerPublicKey: "02" + "03".repeat(32), capacity: 3_000_000, localBalance: 3_000_000, transactionId: fund.txid, transactionVout: 0, feeRatePpm: 300 },
    ],
    // 2,000 sat of routing fees in 30 days.
    forwards: Array.from({ length: 20 }, (_, i) => ({ at: now - (i + 1) * 3_600_000, inId: "840001x1x0", outId: "840000x1x0", tokens: 50_000, feeMsat: 100_000 })),
  });
  installChain(node, { txs: [walletTx(fund, { amount: -3_036_000, fee: 36_000, at: now - 20 * DAY, local: true })] });
  installPayments(node, []);
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const soldAt = new Date(now - 20 * DAY).toISOString();
  // Its order: a 60-day lease (8,640 blocks), in the journal; the sale was
  // booked before sales carried their lease.
  writeFileSync(
    join(dir, "magma-orders.json"),
    JSON.stringify([
      {
        orderId: "sale-1", phase: "settled", via: "autopilot", createdAt: soldAt, updatedAt: soldAt, buyerPubkey: "02" + "03".repeat(32),
        sizeSats: 3_000_000, isPrivate: false, feeMsat: "40000000", leaseBlocks: 8_640, feeRateCapPpm: 2_200, baseFeeCapSats: 1,
        invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: `${fund.txid}:0`,
        fundedAt: soldAt, reportedAt: soldAt, settledAt: soldAt, bookedAt: soldAt, events: [],
      },
    ]),
  );
  // The 1% service fee on it, paid: 400 sat and a 2 sat routing fee.
  const fee: ServiceFeeEntry = {
    key: "magma:sale-1", source: "magma", orderId: "sale-1", earnedSats: 40_000, bps: 100, feeSats: 400,
    createdAt: soldAt, state: "paid", attempts: 1, nextAttemptAt: soldAt, paidAt: soldAt, paidSats: 400, routingFeeSats: 2,
  };
  writeFileSync(join(dir, "service-fees.json"), JSON.stringify([fee]));
  const api = await startApi(t, { node, dir });
  api.earnings.appendOnce({ at: soldAt, via: "autopilot", orderId: "sale-1", leaseSats: 40_000 });
  const pnl = (await api.request("GET", "/pnl?days=30")).body;
  assert.equal(pnl.netProfitSats, 2_000 + 40_000 - 36_000 - 402, "P&L: in profit");
  const res = await api.request("GET", "/score");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const e = (res.body.categories as { key: string; detail: string; hint: string }[]).find((c) => c.key === "earnings")!;
  // Lease income after the fee, 20 days of its 60: (40,000 − 402) / 3 =
  // 13,199; with 2,000 routed and 36,000 / 12 of opens: 12,199 sat on 7M.
  // Before: "~-143 ppm/mo net of costs" and "… — rebalance less".
  assert.match(e.detail, /^20 forwards · ~1743 ppm\/mo net of costs, lease income included$/);
  assert.doesNotMatch(e.hint, /Costs outrun/);
});

test("the hint names the cost that weighs most — 'rebalance less' only when rebalancing does (before: always, even with nothing spent on it)", () => {
  // A young routing node: nothing on rebalancing, 60,000 sat of opens this year, 2,000 sat earned.
  const opens = cat(computeNodeScore(input({ rebalance30Sats: 0, chainCostsYearSats: 60_000, routingRevenue30Sats: 2_000 })), "earnings");
  assert.doesNotMatch(opens.hint, /rebalanc/);
  assert.equal(
    opens.hint,
    "Costs outrun routing income: ~5000 sat/month of on-chain opens and closes against 2000 sat earned in 30 days — " +
      "opens and closes count here spread over a year and pay back only as those channels route: give new channels time to earn, and open or close only where it pays.",
  );
  const bought = cat(computeNodeScore(input({ rebalance30Sats: 1_000, chainCostsYearSats: 12_000, purchases30Sats: 5_000, routingRevenue30Sats: 2_000 })), "earnings");
  assert.match(bought.hint, /^Costs outrun routing income: 1000 sat rebalancing, ~1000 sat\/month of on-chain opens and closes and ~5000 sat of bought inbound against 2000 sat earned in 30 days — inbound bought on Magma weighs most/);
  assert.doesNotMatch(bought.hint, /rebalance less/);
  const rebalancing = cat(computeNodeScore(input({ rebalance30Sats: 6_000, chainCostsYearSats: 12_000, routingRevenue30Sats: 2_000 })), "earnings");
  assert.match(rebalancing.hint, /— rebalance less, and only where it pays back\.$/);
  // Lease income counts against the costs, and is named.
  const seller = cat(computeNodeScore(input({ rebalance30Sats: 0, chainCostsYearSats: 60_000, routingRevenue30Sats: 2_000, leaseIncome30Sats: 1_000 })), "earnings");
  assert.match(seller.hint, /^Costs outrun income: ~5000 sat\/month of on-chain opens and closes against 2000 sat of routing fees and ~1000 sat of lease income in 30 days/);
  assert.match(seller.detail, /~-250 ppm\/mo net of costs, lease income included/);
  // In profit with it: no costs hint.
  const paidFor = cat(computeNodeScore(input({ rebalance30Sats: 0, chainCostsYearSats: 60_000, routingRevenue30Sats: 2_000, leaseIncome30Sats: 4_000 })), "earnings");
  assert.equal(paidFor.hint, "Lower fees on idle channels or add inbound so they start routing.");
});

test("lease income is a yield in itself: with it, the yield is read even on a handful of forwards", () => {
  const e = cat(computeNodeScore(input({ forwards30: 3, routingRevenue30Sats: 300, leaseIncome30Sats: 20_000 })), "earnings");
  // (300 + 20,000) on 8M: ~2,538 ppm a month — full marks for the yield, 3/60 for activity.
  assert.equal(e.detail, "3 forwards · ~2538 ppm/mo net of costs, lease income included");
  assert.equal(e.score, 0.5 * (3 / 60) + 0.5);
  // Without lease income, the same forwards are too few to judge.
  assert.match(cat(computeNodeScore(input({ forwards30: 3, routingRevenue30Sats: 300 })), "earnings").detail, /too few to judge a yield/);
});

test("lease income counts in the last 30 days for its share of the lease, after the service fee paid on the sale — the lease the sale carries, else its order's, else 30 days", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const at = (daysAgo: number) => new Date(now - daysAgo * DAY).toISOString();
  const sales: SaleRecord[] = [
    // Its own 60-day lease, 10 days in: 10 of 60 days → 1/6 of 60,000.
    { at: at(10), via: "lsps1", orderId: "own", leaseSats: 60_000, leaseBlocks: 8_640 },
    // No lease on record, its order's is 90 days, 45 days in: 30 of 90 → 1/3 of 90,000 − 900 fee.
    { at: at(45), via: "autopilot", orderId: "order", leaseSats: 90_000 },
    // No lease anywhere: 30 days, 20 days in → 2/3 of 30,000, less the fee paid inline by 0.7.x.
    { at: at(20), via: "manual", orderId: "none", leaseSats: 30_000, feePaidSats: 300 },
    // A 30-day lease that ended before the window: nothing.
    { at: at(70), via: "autopilot", orderId: "over", leaseSats: 50_000 },
  ];
  const paid = (orderId: string, source: "magma" | "lsps1", sats: number, state: ServiceFeeEntry["state"] = "paid"): ServiceFeeEntry => ({
    key: `${source}:${orderId}`, source, orderId, earnedSats: 0, bps: 100, feeSats: sats, createdAt: at(1), state, attempts: 1, nextAttemptAt: at(1), paidAt: at(1), paidSats: sats - 10, routingFeeSats: 10,
  });
  const fees = [paid("order", "magma", 900), paid("own", "lsps1", 600, "pending"), paid("own", "magma", 999)];
  const leases: SoldLease[] = [{ fundingOutpoint: "aa".repeat(32) + ":0", source: "magma", orderId: "order", leaseBlocks: 12_960 }];
  const income = leaseIncomeInLast30({ earnings: { recent: () => sales }, serviceFees: { entries: () => fees }, soldLeases: () => leases }, now);
  // An unpaid fee isn't taken off, nor one of another kind of sale with the same order id.
  assert.equal(income, Math.round(60_000 / 6 + (90_000 - 900) / 3 + ((30_000 - 300) * 2) / 3));
  assert.equal(leaseIncomeInLast30({}, now), 0);
});

test("GET /score takes inbound bought (spread over its lease) and a year of on-chain costs off Earnings", async (t) => {
  quiet(t);
  const now = Date.now();
  const dir = makeTempDir(t);
  const fund = rawTx({ inputs: [coin()], outputs: [{ value: 2_000_000 }, { value: 400_000 }] });
  const node = feeNode({
    channels: [
      { id: "840000x1x0", partnerPublicKey: "02" + "01".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: fund.txid, transactionVout: 0, feeRatePpm: 300 },
      { id: "840001x1x0", partnerPublicKey: "02" + "02".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "02".repeat(32), transactionVout: 0, feeRatePpm: 300 },
    ],
    forwards: Array.from({ length: 20 }, (_, i) => ({ at: now - (i + 1) * 3_600_000, inId: "840001x1x0", outId: "840000x1x0", tokens: 50_000, feeMsat: 100_000 })),
  });
  // Funded 200 days ago: 12,000 sat → 1,000 sat a month.
  installChain(node, { txs: [walletTx(fund, { amount: -2_012_000, fee: 12_000, at: now - 200 * DAY, local: true })] });
  installPayments(node, []);
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  // 3,000 sat of inbound bought 10 days ago on a 30-day lease: 1,000 of it in the last 30 days.
  const p: MagmaPurchase = {
    orderId: "b", createdAt: new Date(now - 11 * DAY).toISOString(), updatedAt: new Date(now).toISOString(), offerId: null, sellerPubkey: null,
    sizeSats: 1_000_000, feeSats: 3_000, paymentRequest: "lnbc1", paymentHash: "aa".repeat(32), payee: "02" + "f6".repeat(32),
    expiresAt: new Date(now).toISOString(), leaseBlocks: 4_320, feeRateCapPpm: null, baseFeeCapSats: null, usdCents: null,
    state: "channel_open", routingFeeSats: 0, orderStatus: null, channelId: null, paidAt: new Date(now - 10 * DAY).toISOString(),
  };
  writeFileSync(join(dir, "magma-purchases.json"), JSON.stringify([p]));
  const api = await startApi(t, { node, dir });
  const e = ((await api.request("GET", "/score")).body.categories as { key: string; detail: string }[]).find((c) => c.key === "earnings")!;
  // 2,000 earned − 1,000 a month on chain − 1,000 of the purchase = 0.
  assert.match(e.detail, /^20 forwards · ~0 ppm\/mo net of costs$/);
});
