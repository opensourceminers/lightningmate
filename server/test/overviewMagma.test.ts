/**
 * The Overview's Magma figures, honest (D12, a5-analytics:stale-lease-benchmark)
 * and refused orders that reach the operator (a6-ux:skipped-orders-invisible).
 *
 * Before: "market lease ≈ 26k ppm/yr" for every node — a constant two months
 * stale, offered as what the capital "could earn leased out instead" even for
 * nodes whose comparable offers had never sold; the routing yield divided by
 * every channel's whole capacity, peers' balances and pending channels
 * included; and an order the autopilot refused left no trace at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDashboard } from "../src/services/dashboard.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import {
  BOOK_RETRY_AFTER_FAILURE_MS,
  __ageBookFailureForTests,
  __ageBookForTests,
  publicBookFailure,
} from "../src/services/magmaEligibility.js";
import { BENCHMARK_WAIT_MS } from "../src/services/autopilot.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { BUYER } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";
import type { AfterHook } from "./helpers/tmp.js";

const emptyReport = (feesSats: number) =>
  ({
    windowDays: 30,
    totalFeesEarnedSats: feesSats,
    totalForwards: 0,
    totalRoutedSats: 0,
    daily: [],
    recent: [],
    perChannel: [],
  }) as unknown as Parameters<typeof buildDashboard>[0];
const autopilotState = { config: { enabled: false, rebalanceEnabled: false, channelEnabled: false, sellEnabled: false, maxHtlcEnabled: false, intervalMinutes: 30 }, lastRunAt: null, history: [] };

test("routing yield is on this node's own channel balance, gross and net of rebalancing — not on peers' balances or channels still opening", () => {
  const d = buildDashboard(emptyReport(1_000), { invoices: [], payments: [] } as never, [], { count: 0, totalAmountSats: 0 }, autopilotState, 10_000_000, {
    ownCapitalSats: 2_000_000,
    rebalanceFeesSats: 200,
    leaseBenchmark: { status: "unknown", grossAprPct: null, sales: null, windowDays: null, text: "" },
    magmaRefusals: [],
  });
  // 1,000 sat in 30 days on 2M of own capital: 6,083 ppm/yr (on the 10M
  // total capacity it read 1,217 — five times too low).
  assert.equal(d.yieldPpmYear, 6083);
  assert.equal(d.netYieldPpmYear, 4867);
  assert.equal(d.ownCapitalSats, 2_000_000);
});

/** GET /dashboard until its lease benchmark is known: a cold cache gets only
 *  a short look at the public book's fetch (BENCHMARK_WAIT_MS), and a slow
 *  test runner may need a second load — as the Overview's next poll would. */
async function dashboardKnown(api: Awaited<ReturnType<typeof dashApi>>["api"]) {
  for (let i = 0; ; i++) {
    const res = await api.request("GET", "/dashboard");
    if (res.body?.leaseBenchmark?.status !== "unknown" || i >= 50) return res;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function dashApi(t: AfterHook) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const market = new FakeMarket(http, t);
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  node.override("default.listPayments", (_a, cb) => cb(null, { payments: [], first_index_offset: "0", last_index_offset: "0" }));
  node.override("default.getTransactions", (_a, cb) => cb(null, { transactions: [], first_index: "0", last_index: "0" }));
  const api = await startApi(t, { node });
  magma.sellerPubkey = api.node.publicKey;
  return { api, magma, market };
}

test("D12: a node whose comparable offers don't sell is told so on the Overview — no lease rate is offered as an alternative", async (t) => {
  quiet(t);
  const { api, market } = await dashApi(t);
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 20_000_000, sellerScore: i, filledOrders: 0 });
  const res = await dashboardKnown(api);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.leaseBenchmark.status, "not_realistic");
  assert.equal(res.body.leaseBenchmark.grossAprPct, null);
  assert.match(res.body.leaseBenchmark.text, /not realistic for this node yet/);
});

test("D12: where selling is realistic, the Overview shows what buyers actually paid for comparable leases — live, labelled gross", async (t) => {
  quiet(t);
  const { api, market } = await dashApi(t);
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 20_000_000, sellerScore: i, filledOrders: 30 });
  __setHistoryForTests(Array.from({ length: 20 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_500_000, blocks: 4320, apr: 0.0497, leasePpm: 4085, status: "FINISHED" })));
  const res = await dashboardKnown(api);
  assert.equal(res.body.leaseBenchmark.status, "eligible");
  assert.equal(res.body.leaseBenchmark.grossAprPct, 4.97);
  assert.match(res.body.leaseBenchmark.text, /gross, what buyers paid — 20 sales in 30 days/);
});

/** Amboss's query deadline, shortened for a test (restored after it). */
function queryDeadline(t: AfterHook, ms: number): void {
  const saved = HTTP_TIMEOUTS.ambossQueryMs;
  HTTP_TIMEOUTS.ambossQueryMs = ms;
  t.after(() => {
    HTTP_TIMEOUTS.ambossQueryMs = saved;
  });
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = Date.now();
  const value = await fn();
  return { ms: Date.now() - started, value };
}

test("the Overview never waits for Amboss: with Amboss's public endpoints hanging, /dashboard answers at once — and a failed read is not repeated on every load", async (t) => {
  quiet(t);
  queryDeadline(t, 4_000);
  const { api, market } = await dashApi(t);
  market.behaviour = "hang";
  // Before: each load waited out the query deadline (15 s in production)
  // before the KPIs, activity and autopilot tiles appeared.
  const first = await timed(() => api.request("GET", "/dashboard"));
  assert.equal(first.value.status, 200);
  assert.ok(first.ms < BENCHMARK_WAIT_MS + 1_250, `the first load waited ${first.ms} ms`);
  assert.equal(first.value.body.leaseBenchmark.status, "unknown");
  assert.match(first.value.body.leaseBenchmark.text, /being read/);
  const second = await timed(() => api.request("GET", "/dashboard"));
  assert.ok(second.ms < BENCHMARK_WAIT_MS + 1_250, `the second load waited ${second.ms} ms`);
  // The one fetch the loads share runs into its deadline in the background …
  const own = api.node.publicKey;
  for (let i = 0; i < 200 && !publicBookFailure(own); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(publicBookFailure(own), "the failed read is remembered");
  const asked = market.requests;
  // … and is not repeated by the next loads: they answer at once.
  const third = await timed(() => api.request("GET", "/dashboard"));
  assert.ok(third.ms < 1_500, `after the failure a load still waited ${third.ms} ms`);
  assert.match(third.value.body.leaseBenchmark.text, /could not be read/);
  assert.equal(market.requests, asked, "Amboss is not asked again on every load");
  // Amboss answers again: once the failure is 15 minutes old, the next load
  // starts a new read — and its verdict is shown (on that load, or the next).
  market.behaviour = "ok";
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 20_000_000, sellerScore: i, filledOrders: 0 });
  __ageBookFailureForTests(BOOK_RETRY_AFTER_FAILURE_MS);
  const fresh = (await dashboardKnown(api)).body;
  assert.equal(fresh.leaseBenchmark.status, "not_realistic", JSON.stringify(fresh.leaseBenchmark));
});

test("the Overview never waits for Amboss with a key either: its sold-capital listing hanging (cache expired) and the public book stale, /dashboard answers at once from what is cached", async (t) => {
  quiet(t);
  queryDeadline(t, 4_000);
  const { api, magma, market } = await dashApi(t);
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 20_000_000, sellerScore: i, filledOrders: 0 });
  api.amboss.setKey("test-key");
  const warm = await dashboardKnown(api);
  assert.equal(warm.body.leaseBenchmark.status, "not_realistic");
  // Now every Amboss request hangs: Magma's seller API (the sales listing
  // behind the deploy cap, its 30 s cache long expired) and the public book
  // (cached, but a day old).
  magma.readBehaviour = "hang";
  market.behaviour = "hang";
  (api.autopilot.magma as unknown as { deployed: { at: number } }).deployed.at = 0;
  const own = api.node.publicKey;
  __ageBookForTests(own, 25 * 3_600_000);
  const sales = magma.count("Sales");
  const res = await timed(() => api.request("GET", "/dashboard"));
  assert.equal(res.value.status, 200);
  assert.ok(res.ms < 1_500, `waited ${res.ms} ms for Amboss`);
  assert.equal(res.value.body.leaseBenchmark.status, "not_realistic", "the stale copy, at once");
  assert.equal(magma.count("Sales"), sales, "no sold-capital listing is asked for on an Overview load");
  // The background refresh of the stale book runs into its deadline; let it
  // end before the test does.
  for (let i = 0; i < 200 && !publicBookFailure(own); i++) await new Promise((r) => setTimeout(r, 50));
});

test("the enable confirmation's eligibility check answers at once while a failed read is waited out — no second wait for Amboss", async (t) => {
  quiet(t);
  queryDeadline(t, 3_000);
  const { api, market } = await dashApi(t);
  market.behaviour = "hang";
  const first = await timed(() => api.request("GET", "/amboss/eligibility"));
  assert.equal(first.value.status, 200);
  assert.equal(first.value.body.verdict, "unknown");
  const second = await timed(() => api.request("GET", "/amboss/eligibility"));
  assert.ok(second.ms < 1_000, `the second check waited ${second.ms} ms (the read's deadline is 3 s)`);
  assert.equal(second.value.body.verdict, "unknown");
  // "Check again" (refresh=1) does ask Amboss again.
  market.behaviour = "ok";
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 20_000_000, sellerScore: i, filledOrders: 0 });
  assert.equal((await api.request("GET", "/amboss/eligibility?refresh=1")).body.verdict, "not_realistic");
  // As the web asks it now — the flag as "true", the query built from its
  // contract type (review of P8, run 2) — it asks Amboss again too; without
  // the flag the day's copy is served, Amboss not asked.
  const asked = market.requests;
  assert.equal((await api.request("GET", "/amboss/eligibility")).body.verdict, "not_realistic");
  assert.equal(market.requests, asked, "the copy: Amboss not asked");
  assert.equal((await api.request("GET", "/amboss/eligibility?refresh=true")).body.verdict, "not_realistic");
  assert.ok(market.requests > asked, "refresh=true asks Amboss again");
});

test("an order the lane turned down raises an alert with the reason and a digest count — until dismissed", async (t) => {
  quiet(t);
  const { api, magma } = await dashApi(t);
  api.amboss.setKey("test-key");
  api.autopilot.setConfig({ sellEnabled: true, sellMaxDeploySats: 2_000_000, sellMaxChannelSats: 5_000_000 });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 3_000_000 });
  await api.autopilot.pollSellOrders();
  const alerts = (await api.request("GET", "/alerts")).body as { id?: string; message: string }[];
  const alert = alerts.find((a) => a.id === `magma:${sale.id}`);
  assert.ok(alert, JSON.stringify(alerts));
  assert.match(alert.message, /3,000,000 sat Magma order was turned down: deploy cap reached/);
  const dash = (await api.request("GET", "/dashboard")).body;
  assert.equal(dash.autopilot.magmaRefusals, 1);
  assert.match(dash.autopilot.magmaRefusalReason, /deploy cap reached/);
  assert.equal((await api.request("POST", "/alerts/ack", { id: `magma:${sale.id}` })).status, 200);
  const after = (await api.request("GET", "/alerts")).body as { id?: string }[];
  assert.ok(!after.some((a) => a.id === `magma:${sale.id}`), "dismissed");
});

test("a turned-down order raises its alert for two days only — an older one is history, not an alert", async (t) => {
  quiet(t);
  const { api, magma } = await dashApi(t);
  api.amboss.setKey("test-key");
  api.autopilot.setConfig({ sellEnabled: true, sellMaxDeploySats: 2_000_000, sellMaxChannelSats: 5_000_000 });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 3_000_000 });
  await api.autopilot.pollSellOrders();
  const entry = api.autopilot.magma.journal.get(sale.id)!;
  assert.equal(entry.decision?.action, "reject");
  // Turned down 49 hours ago.
  entry.decision!.at = new Date(Date.now() - 49 * 3_600_000).toISOString();
  const alerts = (await api.request("GET", "/alerts")).body as { id?: string }[];
  assert.ok(!alerts.some((a) => a.id === `magma:${sale.id}`), JSON.stringify(alerts));
  const dash = (await api.request("GET", "/dashboard")).body;
  assert.equal(dash.autopilot.magmaRefusals, 0);
});

test("an order the operator turned down by hand raises no 'turned down' alert — only the lane's refusals do", async (t) => {
  quiet(t);
  const { api, magma } = await dashApi(t);
  api.amboss.setKey("test-key");
  const sale = magma.addSale({ buyerPubkey: BUYER });
  const res = await api.request("POST", "/amboss/order/reject", { id: sale.id });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const entry = api.autopilot.magma.journal.get(sale.id)!;
  assert.deepEqual([entry.phase, entry.via, entry.decision?.action], ["rejected", "manual", "reject"]);
  // Before (manual rejects counted): "Magma order turned down" — for the
  // operator's own click, minutes after making it.
  assert.deepEqual(api.autopilot.magma.refusals(), []);
  const alerts = (await api.request("GET", "/alerts")).body as { id?: string }[];
  assert.ok(!alerts.some((a) => a.id === `magma:${sale.id}`), JSON.stringify(alerts));
  assert.equal((await api.request("GET", "/dashboard")).body.autopilot.magmaRefusals, 0);
});

test("GET /dashboard: the routing yield is on this node's side of its OPEN channels — not their capacity, not channels still opening", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  new FakeMarket(http, t);
  const node = new FakeLnd({
    chainBalance: 1_000_000,
    channels: [
      { partnerPublicKey: "02" + "31".repeat(32), capacity: 5_000_000, localBalance: 1_000_000, transactionId: "31".repeat(32), transactionVout: 0 },
      { partnerPublicKey: "02" + "32".repeat(32), capacity: 3_000_000, localBalance: 2_500_000, transactionId: "32".repeat(32), transactionVout: 0 },
    ],
    pending: [{ partnerPublicKey: "02" + "33".repeat(32), capacity: 2_000_000, transactionId: "33".repeat(32), transactionVout: 0 }],
  });
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  node.override("default.listPayments", (_a, cb) => cb(null, { payments: [], first_index_offset: "0", last_index_offset: "0" }));
  node.override("default.getTransactions", (_a, cb) => cb(null, { transactions: [], first_index: "0", last_index: "0" }));
  const api = await startApi(t, { node });
  const res = await api.request("GET", "/dashboard");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.totalCapacitySats, 10_000_000);
  assert.equal(res.body.ownCapitalSats, 3_500_000, "1M + 2.5M of local balance in the open channels");
});
