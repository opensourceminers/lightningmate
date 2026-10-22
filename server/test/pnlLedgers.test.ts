/**
 * Every P&L cost from a complete ledger (review a5-analytics:rebalance-cost-
 * truncated, a8-engineering:pnl-accounting-truncated, a5-analytics:magma-buy-
 * costs-missing — package P6).
 *
 * Before:
 *  - rebalancing came from LightningMate's own log: the Analytics tab read
 *    its newest 50 records (failures included) for 30 and 90 days, P&L a log
 *    that dropped every success older than 400 days — while P&L offers "All"
 *    and routing revenue covered the node's whole life; rebalances made with
 *    bos, RTL or ThunderHub were never counted at all;
 *  - lease income kept the newest 500 sales, the service-fee ledger its
 *    newest 500 settled entries (paid ones too), the purchase ledger its
 *    newest 300 records (paid ones too);
 *  - what inbound bought on Magma cost was in no P&L figure.
 *
 * Now rebalancing comes from LND's payments to this node itself (every tool's
 * rebalances), with LightningMate's log — which keeps every fee, older ones
 * summed per day — for what LND doesn't list; no ledger drops a cost; and
 * purchases are a P&L cost.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RebalanceLog, type RebalanceRecord } from "../src/services/rebalanceLog.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger, type ServiceFeeEntry } from "../src/services/serviceFee.js";
import { MagmaPurchases, type MagmaPurchase } from "../src/services/magmaPurchases.js";
import { forgetSelfPayments, rebalanceCosts } from "../src/services/rebalanceCosts.js";
import { JsonStore } from "../src/store.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { startApi } from "./helpers/apiHarness.js";
import { installChain, installPayments, paymentRpc } from "./helpers/chain.js";
import { makeTempDir } from "./helpers/tmp.js";
import { feeEnv, quiet } from "./helpers/lifecycle.js";

const DAY = 86_400_000;
const hash = (n: number) => n.toString(16).padStart(64, "0");
const T1 = "850000x1x0";
const T2 = "850002x1x0";

function record(daysAgo: number, feeSats: number | null, o: Partial<RebalanceRecord> = {}): RebalanceRecord {
  const at = new Date(Date.now() - daysAgo * DAY).toISOString();
  return {
    at,
    startedAt: at,
    via: "autopilot",
    targetId: T1,
    targetAlias: "t1",
    sourceId: "850001x1x0",
    sourceAlias: "s",
    amountSats: 200_000,
    budgetPpm: 1000,
    feeSats,
    costPpm: feeSats === null ? null : feeSats * 5,
    ok: feeSats !== null,
    ...(feeSats === null ? { error: "no route" } : {}),
    ...o,
  };
}

/** A node for P&L: no forwards, no chain activity; LND's payments as given
 *  (`null`: LND can't list them; `ignoreDates`: an LND before 0.16). */
async function ledgerApi(t: TestContext, opts: { payments?: ReturnType<typeof paymentRpc>[] | null; dir?: string; node?: FakeLnd; ignoreDates?: boolean } = {}) {
  quiet(t);
  const node = opts.node ?? new FakeLnd({ chainBalance: 1_000_000 });
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  if (opts.payments === null) node.override("default.listPayments", (_a, cb) => cb({ details: "permission denied: offchain:read" }));
  else installPayments(node, opts.payments ?? [], { ignoreDates: opts.ignoreDates });
  installChain(node);
  const api = await startApi(t, { node, dir: opts.dir });
  return { api, node };
}

const selfPay = (node: FakeLnd, daysAgo: number, feeSats: number, o: { id?: string; tokens?: number; channel?: string } = {}) =>
  paymentRpc({
    id: o.id,
    at: Date.now() - daysAgo * DAY,
    tokens: o.tokens ?? 200_000,
    feeMsat: feeSats * 1000,
    destination: node.publicKey,
    lastChannel: o.channel ?? T1,
  });

test("P&L 'All' keeps every rebalancing fee ever paid: successes past 400 days are summed per day, never dropped — from the log when LND can't be read, from LND when it can", async (t) => {
  const dir = makeTempDir(t);
  // A 0.7.x log as it stands on disk: four refills, two older than 400 days.
  const old = [record(10, 40, { paymentId: hash(1) }), record(300, 30, { paymentId: hash(2) }), record(450, 20, { paymentId: hash(3) }), record(600, 10, { paymentId: hash(4) })];
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify(old));
  // A new refill is logged: the log trims — the two oldest go into the daily sums.
  const log = new RebalanceLog(dir);
  log.append(record(0, 5, { paymentId: hash(5) }));
  assert.deepEqual(log.successes().map((r) => r.feeSats), [5, 40, 30], "kept one by one: the last 400 days");
  assert.equal(log.costsSince(-Infinity).feeSats, 105, "every fee, the summed ones too");
  assert.equal(log.trackedSince()?.slice(0, 10), new Date(Date.now() - 600 * DAY).toISOString().slice(0, 10));

  const { api, node } = await ledgerApi(t, { payments: null, dir });
  const all = (await api.request("GET", "/pnl?days=36500")).body;
  assert.deepEqual([all.rebalanceCostSats, all.rebalanceCount, all.rebalanceSource], [105, 5, "log"]);
  assert.ok(all.notes.some((n: string) => /LND's payment history could not be read .*LightningMate's own log \(it covers .* on\) — rebalances made with other tools are not in it/.test(n)), JSON.stringify(all.notes));
  const year = (await api.request("GET", "/pnl?days=365")).body;
  assert.equal(year.rebalanceCostSats, 75);

  // LND readable: its payments are the ledger.
  installPayments(node, [5, 10, 300, 450, 600].map((d, i) => selfPay(node, d, [5, 40, 30, 20, 10][i], { id: hash([5, 1, 2, 3, 4][i]) })));
  forgetSelfPayments(node.lnd);
  const lndAll = (await api.request("GET", "/pnl?days=36500")).body;
  assert.deepEqual([lndAll.rebalanceCostSats, lndAll.rebalanceCount, lndAll.rebalanceSource, lndAll.rebalanceNotLogged], [105, 5, "lnd", 0]);
});

test("rebalances made with another tool count: LND's payments to this node itself are the ledger — matched to the log by payment hash, nothing counted twice", async (t) => {
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  // Two refills by LightningMate (logged), three by bos (not).
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([record(2, 50, { paymentId: hash(11) }), record(5, 60, { paymentId: hash(12) })]));
  const payments = [
    selfPay(node, 2, 50, { id: hash(11) }),
    selfPay(node, 5, 60, { id: hash(12) }),
    selfPay(node, 1, 70, { channel: T2 }),
    selfPay(node, 3, 80, { channel: T2 }),
    selfPay(node, 8, 90, { channel: T1 }),
    // Not a rebalance: a payment to someone else.
    paymentRpc({ at: Date.now() - DAY, tokens: 5_000, feeMsat: 4_000, destination: "02" + "e5".repeat(32) }),
  ];
  const { api } = await ledgerApi(t, { payments, dir, node });
  const p = (await api.request("GET", "/pnl?days=30")).body;
  // Before: 110 sat — LightningMate's two only.
  assert.deepEqual([p.rebalanceCostSats, p.rebalanceCount, p.rebalanceNotLogged], [350, 5, 3]);
  const costs = (await api.request("GET", "/rebalance/costs?days=30")).body;
  assert.deepEqual(
    costs.perChannel.map((c: { channelId: string; feeSats: number; count: number }) => [c.channelId, c.feeSats, c.count]),
    [
      [T1, 200, 3],
      [T2, 150, 2],
    ],
  );
  assert.equal((await api.request("GET", "/rebalance/costs?days=0")).status, 400);
});

test("a refill LND no longer lists (its payment history pruned) still counts from the log; one logged before the hash was kept is paired with LND's payment by channel, amount and time — once", async (t) => {
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const legacy = record(4, 33, { amountSats: 250_000 });
  delete legacy.paymentId;
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([record(3, 21, { paymentId: hash(21) }), legacy]));
  const payments = [selfPay(node, 4 + 1 / 1440, 33, { tokens: 250_000 })]; // sent a minute before the record's end
  const { api } = await ledgerApi(t, { payments, dir, node });
  const p = (await api.request("GET", "/pnl?days=30")).body;
  assert.deepEqual([p.rebalanceCostSats, p.rebalanceCount, p.rebalanceNotLogged], [54, 2, 0]);
  assert.ok(p.notes.some((n: string) => /1 rebalance LND no longer lists .* counted from LightningMate's log/.test(n)), JSON.stringify(p.notes));
});

test("320 refills and 400 failed attempts interleaved over 300 days: the year's rebalancing is exactly the sum of every successful fee in it", async (t) => {
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const log = new RebalanceLog(dir);
  const payments: ReturnType<typeof paymentRpc>[] = [];
  let expected = 0;
  for (let i = 0; i < 720; i++) {
    const daysAgo = 300 - (i * 300) / 720;
    if (i % 9 < 4) {
      const fee = 10 + (i % 17);
      expected += fee;
      log.append(record(daysAgo, fee, { paymentId: hash(1000 + i) }));
      payments.push(selfPay(node, daysAgo, fee, { id: hash(1000 + i) }));
    } else {
      log.append(record(daysAgo, null));
    }
  }
  assert.equal(log.successes().length, 320);
  const { api } = await ledgerApi(t, { payments, dir, node });
  const p = (await api.request("GET", "/pnl?days=365")).body;
  assert.deepEqual([p.rebalanceCostSats, p.rebalanceCount], [expected, 320]);
  node.override("default.listPayments", (_a, cb) => cb({ details: "unavailable" }));
  forgetSelfPayments(node.lnd);
  const fromLog = (await api.request("GET", "/pnl?days=365")).body;
  assert.deepEqual([fromLog.rebalanceCostSats, fromLog.rebalanceCount, fromLog.rebalanceSource], [expected, 320, "log"]);
});

test("the daily sums are saved before the records that went into them leave the log — a stop in between never counts a fee twice", (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([record(450, 20, { paymentId: hash(31) })]));
  const log = new RebalanceLog(dir);
  log.append(record(1, 7, { paymentId: hash(32) }));
  assert.equal(log.costsSince(-Infinity).feeSats, 27);
  // The process stopped after the sums were saved but before the log was:
  // the summed record is still on file.
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([record(1, 7, { paymentId: hash(32) }), record(450, 20, { paymentId: hash(31) })]));
  const again = new RebalanceLog(dir);
  assert.equal(again.costsSince(-Infinity).feeSats, 27, "the stale record is not counted beside its sum");
  again.append(record(0, 1, { paymentId: hash(33) }));
  assert.equal(again.costsSince(-Infinity).feeSats, 28);
  const onDisk = JSON.parse(readFileSync(join(dir, "rebalances.json"), "utf8")) as RebalanceRecord[];
  assert.ok(!onDisk.some((r) => r.paymentId === hash(31)), "and it leaves the file at the next save");
});

test("the Rebalance tab's totals say the window they cover (they summed an unlabelled 200 attempts)", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([record(2, 10), record(40, 99), record(3, null)]));
  const { api } = await ledgerApi(t, { dir });
  const res = (await api.request("GET", "/rebalance/log")).body;
  assert.deepEqual(
    [res.summary.windowDays, res.summary.count, res.summary.failed, res.summary.totalFeeSats],
    [30, 1, 1, 10],
  );
});

test("lease income: every sale stays in the books — 600 sales, all of them in 'All' (the log kept the newest 500)", async (t) => {
  const dir = makeTempDir(t);
  const earnings = new EarningsLog(dir);
  for (let i = 0; i < 600; i++) earnings.appendOnce({ at: new Date(Date.now() - (600 - i) * DAY).toISOString(), via: "autopilot", orderId: `o-${i}`, leaseSats: 1_000 });
  assert.equal(new EarningsLog(dir).recent().length, 600);
  const { api } = await ledgerApi(t, { dir });
  const all = (await api.request("GET", "/pnl?days=36500")).body;
  assert.deepEqual([all.magmaRevenueSats, all.magmaSaleCount], [600_000, 600]);
});

test("the service-fee ledger never trims a paid fee — only skipped and given-up entries past its bound", (t) => {
  feeEnv(t);
  const dir = makeTempDir(t);
  const paid = (i: number): ServiceFeeEntry => ({
    key: `magma:p-${i}`,
    source: "magma",
    orderId: `p-${i}`,
    earnedSats: 10_000,
    bps: 100,
    feeSats: 100,
    createdAt: new Date(Date.now() - (700 - i) * DAY).toISOString(),
    state: "paid",
    attempts: 1,
    nextAttemptAt: new Date().toISOString(),
    paidAt: new Date(Date.now() - (700 - i) * DAY).toISOString(),
    paidSats: 100,
    routingFeeSats: 1,
  });
  const skipped = (i: number): ServiceFeeEntry => ({ ...paid(i), key: `magma:s-${i}`, orderId: `s-${i}`, state: "skipped", paidAt: undefined, paidSats: undefined, routingFeeSats: undefined });
  writeFileSync(join(dir, "service-fees.json"), JSON.stringify([...Array.from({ length: 50 }, (_, i) => skipped(i)), ...Array.from({ length: 600 }, (_, i) => paid(i)).reverse()]));
  const ledger = new ServiceFeeLedger(dir, null);
  ledger.enqueue({ source: "magma", orderId: "new", earnedSats: 50_000 }); // saves
  const after = new ServiceFeeLedger(dir, null);
  assert.equal(after.paidSince(-Infinity).length, 600, "every paid fee, however many");
  assert.equal(after.entries().filter((e) => e.state === "skipped").length, 0, "trimmed: what carried no cost (newest kept within the bound)");
  assert.equal(after.entries().length, 601);
});

function purchase(o: Partial<MagmaPurchase> & { orderId: string }): MagmaPurchase {
  return {
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    offerId: "offer-1",
    sellerPubkey: "02" + "f6".repeat(32),
    sizeSats: 3_000_000,
    feeSats: 12_300,
    paymentRequest: "lnbc1",
    paymentHash: "aa".repeat(32),
    payee: "02" + "f6".repeat(32),
    expiresAt: new Date().toISOString(),
    leaseBlocks: 4_320,
    feeRateCapPpm: null,
    baseFeeCapSats: null,
    usdCents: null,
    state: "quoted",
    routingFeeSats: null,
    orderStatus: null,
    channelId: null,
    ...o,
  };
}

test("inbound bought on Magma is a P&L cost — the invoice and its Lightning routing fee, in the window it was paid (it was in no P&L figure)", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "magma-purchases.json"),
    JSON.stringify([
      purchase({ orderId: "recent", state: "channel_open", paidAt: new Date(Date.now() - 5 * DAY).toISOString(), routingFeeSats: 7 }),
      purchase({ orderId: "older", state: "channel_open", feeSats: 9_000, paidAt: new Date(Date.now() - 40 * DAY).toISOString(), routingFeeSats: 3 }),
      purchase({ orderId: "refunded", state: "order_failed", paidAt: undefined }),
    ]),
  );
  const { api } = await ledgerApi(t, { dir });
  const d30 = (await api.request("GET", "/pnl?days=30")).body;
  assert.deepEqual([d30.inboundPurchaseCostSats, d30.inboundPurchaseCount, d30.totalCostSats, d30.netProfitSats], [12_307, 1, 12_307, -12_307]);
  const d90 = (await api.request("GET", "/pnl?days=90")).body;
  assert.deepEqual([d90.inboundPurchaseCostSats, d90.inboundPurchaseCount], [21_310, 2]);
  // Analytics spreads each over its 30-day lease: of the recent one, the 5
  // days run so far; of the older one, 30 − 10 = the 20 days of its lease in
  // the last 30.
  const spread = (await api.request("GET", "/analytics/bought-inbound?days=30")).body;
  assert.equal(spread.amortizedSats, Math.round((12_307 * 5) / 30 + (9_003 * 20) / 30));
  assert.equal((await api.request("GET", "/analytics/bought-inbound?days=-1")).status, 400);
});

test("the purchase ledger never drops a paid purchase: 320 quotes after it, it is still in the books (records past the newest 300 went, paid ones too)", (t) => {
  const dir = makeTempDir(t);
  const ledger = new MagmaPurchases(dir);
  ledger.recordQuote(purchase({ orderId: "bought" }));
  ledger.update("bought", { state: "channel_open", paidAt: new Date().toISOString(), routingFeeSats: 4 });
  for (let i = 0; i < 320; i++) ledger.recordQuote(purchase({ orderId: `q-${i}` }));
  const reread = new MagmaPurchases(dir);
  assert.deepEqual(reread.paidCosts().map((c) => [c.orderId, c.feeSats + c.routingFeeSats]), [["bought", 12_304]]);
  assert.equal(reread.list().filter((p) => p.state === "quoted").length, 300, "quotes that cost nothing stay bounded");
});

test("…nor one whose payment is held or may still be moving: paid with its channel not open yet, being paid, or failed by the pay call's word only — each survives 320 later quotes", (t) => {
  const dir = makeTempDir(t);
  const ledger = new MagmaPurchases(dir);
  // A Magma purchase pays a hold invoice: it stays in flight until the
  // seller's channel is confirmed.
  ledger.recordQuote(purchase({ orderId: "held" }));
  ledger.update("held", { state: "paid" });
  ledger.recordQuote(purchase({ orderId: "paying" }));
  ledger.startPayment("paying");
  ledger.recordQuote(purchase({ orderId: "unclear" }));
  ledger.startPayment("unclear");
  ledger.paymentOutcome("unclear", { status: "failed", error: "the pay stream dropped", confirmed: false });
  for (let i = 0; i < 320; i++) ledger.recordQuote(purchase({ orderId: `q-${i}` }));
  const kept = new Map(new MagmaPurchases(dir).list().map((p) => [p.orderId, p.state]));
  assert.deepEqual(
    ["held", "paying", "unclear"].map((id) => kept.get(id)),
    ["paid", "paying", "pay_failed"],
  );
});

// ── Review of P6 ─────────────────────────────────────────────────────────────

test("LND readable but its payment history pruned: the log's daily sums count for the days before it — and a summed day LND still lists counts once", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([record(450, 20, { paymentId: hash(41) }), record(600, 10, { paymentId: hash(42), targetId: T2 })]));
  const log = new RebalanceLog(dir);
  log.append(record(1, 5, { paymentId: hash(43) })); // trims: the two old ones go into the daily sums
  assert.equal(log.costsSince(-Infinity).feeSats, 35);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  // `lncli deletepayments`: LND lists only the recent one.
  const { api } = await ledgerApi(t, { payments: [selfPay(node, 1, 5, { id: hash(43) })], dir, node });
  const all = (await api.request("GET", "/pnl?days=36500")).body;
  // Before: 5 — the sums were added only when LND couldn't be read at all.
  assert.deepEqual([all.rebalanceCostSats, all.rebalanceCount, all.rebalanceSource], [35, 3, "lnd"]);
  assert.ok(all.notes.some((n: string) => /2 rebalances older than LND's payment history counted from LightningMate's daily sums/.test(n)), JSON.stringify(all.notes));
  const costs = (await api.request("GET", "/rebalance/costs?days=36500")).body;
  assert.deepEqual(
    costs.perChannel.map((c: { channelId: string; feeSats: number; count: number }) => [c.channelId, c.feeSats, c.count]),
    [
      [T1, 25, 2],
      [T2, 10, 1],
    ],
  );
  assert.equal(costs.amountSats, 600_000);
  assert.equal((await api.request("GET", "/pnl?days=365")).body.rebalanceCostSats, 5, "a year: the summed days are older");
  // LND lists the old ones after all: they count from LND, once.
  installPayments(node, [selfPay(node, 1, 5, { id: hash(43) }), selfPay(node, 450, 20, { id: hash(41) }), selfPay(node, 600, 10, { id: hash(42), channel: T2 })]);
  forgetSelfPayments(node.lnd);
  const again = (await api.request("GET", "/pnl?days=36500")).body;
  assert.deepEqual([again.rebalanceCostSats, again.rebalanceCount], [35, 3]);
  // Only the oldest pruned: its day from the sums, the other from LND.
  installPayments(node, [selfPay(node, 1, 5, { id: hash(43) }), selfPay(node, 450, 20, { id: hash(41) })]);
  forgetSelfPayments(node.lnd);
  const part = (await api.request("GET", "/pnl?days=36500")).body;
  assert.deepEqual([part.rebalanceCostSats, part.rebalanceCount], [35, 3]);
});

test("daily sums that can't be saved keep their records on file — nothing summed, nothing lost: after a restart every fee counts once", (t) => {
  t.mock.method(console, "error", () => undefined);
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([record(450, 20, { paymentId: hash(51) })]));
  const log = new RebalanceLog(dir);
  // The disk refuses the sums file (full, read-only …) while a new refill
  // is logged — the append that would sum the old record.
  const proto = JsonStore.prototype as unknown as { replaceFile: (this: { name: string }, ...args: unknown[]) => void };
  const real = proto.replaceFile;
  const refuse = t.mock.method(proto, "replaceFile", function (this: { name: string }, ...args: unknown[]) {
    if (this.name === "rebalance-totals.json") throw new Error("ENOSPC: no space left on device");
    return real.apply(this, args);
  });
  log.append(record(1, 7, { paymentId: hash(52) }));
  refuse.mock.restore();
  const onDisk = JSON.parse(readFileSync(join(dir, "rebalances.json"), "utf8")) as RebalanceRecord[];
  assert.ok(onDisk.some((r) => r.paymentId === hash(51)), "the old record stays on file");
  assert.equal(log.costsSince(-Infinity).feeSats, 27);
  assert.equal(new RebalanceLog(dir).costsSince(-Infinity).feeSats, 27, "after a restart: every fee, once");
});

test("a refill booked for a day already summed goes straight into the sums — never dropped with the old records", (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "rebalances.json"), JSON.stringify([record(450, 20, { paymentId: hash(61) })]));
  const log = new RebalanceLog(dir);
  log.append(record(1, 7, { paymentId: hash(62) })); // the sums now reach 400 days back
  log.append(record(420, 3, { paymentId: hash(63) })); // a payment that ended 420 days ago, booked only now
  assert.equal(log.costsSince(-Infinity).feeSats, 30);
  assert.equal(new RebalanceLog(dir).costsSince(-Infinity).feeSats, 30, "and after a restart");
});

test("an LND that ignores the payments' date filter (before 0.16): the window is applied here — older rebalances stay out of 30 days", async (t) => {
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const { api } = await ledgerApi(t, { node, payments: [selfPay(node, 2, 10), selfPay(node, 40, 99), selfPay(node, 100, 77)], ignoreDates: true });
  const p = (await api.request("GET", "/pnl?days=30")).body;
  assert.deepEqual([p.rebalanceCostSats, p.rebalanceCount], [10, 1]);
  assert.equal((await api.request("GET", "/pnl?days=365")).body.rebalanceCostSats, 186);
});

test("LND's payments are read again once a minute has passed — a rebalance made since then counts", async (t) => {
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const log = new RebalanceLog(dir);
  const now = Date.now();
  installPayments(node, [selfPay(node, 1, 10)]);
  assert.equal((await rebalanceCosts(node.lnd, log, now - 30 * DAY, now)).feeSats, 10);
  installPayments(node, [selfPay(node, 1, 10), selfPay(node, 0, 5)]);
  assert.equal((await rebalanceCosts(node.lnd, log, now - 30 * DAY, now + 30_000)).feeSats, 10, "within the minute: the read serves");
  assert.equal((await rebalanceCosts(node.lnd, log, now - 30 * DAY, now + 61_000)).feeSats, 15);
});

test("a rebalance split over two paths: each part's fee goes to the channel it came back through", async (t) => {
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const mpp = paymentRpc({
    at: Date.now() - DAY,
    tokens: 300_000,
    feeMsat: 90_000,
    destination: node.publicKey,
    parts: [
      { lastChannel: T1, tokens: 200_000, feeMsat: 60_000 },
      { lastChannel: T2, tokens: 100_000, feeMsat: 30_000 },
    ],
  });
  const { api } = await ledgerApi(t, { node, payments: [mpp] });
  const costs = (await api.request("GET", "/rebalance/costs?days=30")).body;
  assert.equal(costs.feeSats, 90);
  assert.deepEqual(
    costs.perChannel.map((c: { channelId: string; feeSats: number }) => [c.channelId, c.feeSats]),
    [
      [T1, 60],
      [T2, 30],
    ],
  );
});
