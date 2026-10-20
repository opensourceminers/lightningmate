/**
 * Every place a sale completes (autopilot Magma fulfilment, the manual "open
 * channel" route, an LSPS1 settle and its restart recovery) must book the sale
 * once and ENQUEUE the service fee — never await the fee payment. The fake node
 * is set to leave payments hanging, as a stuck HTLC would: before the fix each
 * of these paths awaited that payment and never returned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Autopilot } from "../src/services/autopilot.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { SettingsStore } from "../src/services/settings.js";
import { Lsps1Service, type Lsps1Order } from "../src/services/lsps1.js";
import { ServiceFeeLedger, lndFeeLightning } from "../src/services/serviceFee.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { mockLnurlPayServer } from "./helpers/lnurl.js";
import { mockAmbossSeller, sellerOrder } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";
import { withEnv } from "./helpers/env.js";

const ADDRESS = "fees@fees.example";
const BUYER = "02" + "ab".repeat(32);

function feeEnv(t: AfterHook): void {
  withEnv(t, { LM_SELL_FEE_BPS: "100", LM_SELL_FEE_ADDRESS: ADDRESS, LM_SELL_FEE_PUBKEY: undefined });
}

/** Resolve within `ms` or fail — a path that awaits a stuck payment hangs. */
async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not return within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("autopilot Magma fulfilment books the sale and enqueues the fee without waiting for it", async (t) => {
  feeEnv(t);
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({
      config: { sellEnabled: true, sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000 },
      history: [],
      sellAutoSizeMigrated: true,
    }),
  );
  const http = installFetchMock(t);
  mockAmbossSeller(http, { orders: [sellerOrder({ id: "ord-1", destination: `${BUYER}@1.2.3.4:9735` })] });
  mockLnurlPayServer(http, { address: ADDRESS });
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  node.payOutcome = "hang"; // a stuck HTLC

  const amboss = new AmbossStore(dir);
  amboss.setKey("test-key");
  const earnings = new EarningsLog(dir);
  const fees = new ServiceFeeLedger(dir, lndFeeLightning(node.lnd), { payTimeoutMs: 100 });
  const autopilot = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), new OverridesStore(dir), amboss, earnings, fees);
  t.after(() => {
    autopilot.shutdown();
    fees.stop();
  });

  await within(10_000, autopilot.pollSellOrders(), "pollSellOrders");

  const open = autopilot.getState().history[0]?.sells.find((s) => s.action === "open");
  assert.equal(open?.ok, true);
  assert.deepEqual(
    earnings.recent().map((r) => [r.orderId, r.leaseSats]),
    [["ord-1", 12_345]],
  );
  const [entry] = fees.entries();
  assert.equal(entry.key, "magma:ord-1");
  assert.equal(entry.feeSats, 123);

  // The fee is paid in the background (and here stays in flight).
  await fees.processDue();
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1);
  assert.equal(fees.entries()[0].state, "inflight");
});

test("the same Magma sale completed twice is booked and charged once", async (t) => {
  feeEnv(t);
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config: { sellEnabled: true, sellMaxDeploySats: 50_000_000 }, history: [], sellAutoSizeMigrated: true }),
  );
  const http = installFetchMock(t);
  mockAmbossSeller(http, { orders: [sellerOrder({ id: "ord-2", destination: `${BUYER}@1.2.3.4:9735` })] });
  mockLnurlPayServer(http, { address: ADDRESS });
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  const amboss = new AmbossStore(dir);
  amboss.setKey("test-key");
  const earnings = new EarningsLog(dir);
  // This fee payment goes through: give it time (on a busy machine the fake
  // payment can take longer than a short timeout, and "paid" would read
  // "still in flight").
  const fees = new ServiceFeeLedger(dir, lndFeeLightning(node.lnd), { payTimeoutMs: 10_000 });
  const autopilot = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), new OverridesStore(dir), amboss, earnings, fees);
  t.after(() => {
    autopilot.shutdown();
    fees.stop();
  });

  await autopilot.pollSellOrders();
  await autopilot.pollSellOrders(); // Amboss still reports WAITING_FOR_CHANNEL_OPEN
  await fees.processDue();
  assert.equal(earnings.recent().filter((r) => r.orderId === "ord-2").length, 1);
  assert.equal(fees.entries().length, 1);
  assert.equal(fees.entries()[0].state, "paid");
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "one fee payment");
});

test("a channel Amboss did not confirm is not booked as a sale and owes no fee", async (t) => {
  feeEnv(t);
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config: { sellEnabled: true, sellMaxDeploySats: 50_000_000 }, history: [], sellAutoSizeMigrated: true }),
  );
  const http = installFetchMock(t);
  mockAmbossSeller(http, {
    orders: [sellerOrder({ id: "ord-x", destination: `${BUYER}@1.2.3.4:9735` })],
    addTransactionResult: false,
  });
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  const amboss = new AmbossStore(dir);
  amboss.setKey("test-key");
  const earnings = new EarningsLog(dir);
  const fees = new ServiceFeeLedger(dir, lndFeeLightning(node.lnd), { payTimeoutMs: 100 });
  const autopilot = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), new OverridesStore(dir), amboss, earnings, fees);
  t.after(() => {
    autopilot.shutdown();
    fees.stop();
  });

  await autopilot.pollSellOrders();
  const open = autopilot.getState().history[0]?.sells.find((s) => s.action === "open");
  assert.equal(open?.ok, false, "reported as a failure, not a sale");
  assert.match(open?.error ?? "", /did not confirm/);
  assert.equal(earnings.recent().length, 0);
  assert.equal(fees.entries().length, 0);
});

// ── Hand-off: the per-order Magma journal ─────────────────────────────────────
// Amboss mutations now have a deadline (http.ts). A mutation that timed out may
// still have been applied, and only a persisted per-order record of the funding
// outpoint can tell the two cases apart. That journal comes with the move of
// the seller flow to Amboss's Magma API (the legacy seller mutations used here
// are deprecated). These are its acceptance cases — listed by `npm test`, not
// failing it — so they cannot get lost on the way.
test.todo(
  "order journal: add_transaction timed out but Amboss applied it — the sale is booked and its fee enqueued exactly once, when Amboss shows the order past WAITING_FOR_CHANNEL_OPEN with the journalled outpoint",
);
test.todo(
  "order journal: add_transaction timed out and was not applied — the next poll re-sends the journalled outpoint and never opens a second channel for that order",
);

test("the manual 'open channel' route enqueues the fee and answers without waiting for it", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  mockAmbossSeller(http, { orders: [sellerOrder({ id: "ord-3", destination: `${BUYER}@1.2.3.4:9735` })] });
  mockLnurlPayServer(http, { address: ADDRESS });
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  node.payOutcome = "hang";
  const api = await startApi(t, { node });
  api.amboss.setKey("test-key");

  const res = await within(10_000, api.request("POST", "/amboss/order/open", { id: "ord-3" }), "POST /amboss/order/open");
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(api.earnings.recent().length, 1);
  assert.equal(api.serviceFees.entries()[0]?.key, "magma:ord-3");
  await api.serviceFees.processDue();
});

test("the manual 'open channel' route books no sale and owes no fee when Amboss doesn't confirm the channel", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  mockAmbossSeller(http, {
    orders: [sellerOrder({ id: "ord-4", destination: `${BUYER}@1.2.3.4:9735` })],
    addTransactionResult: false,
  });
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  const api = await startApi(t, { node });
  api.amboss.setKey("test-key");

  const res = await api.request("POST", "/amboss/order/open", { id: "ord-4" });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, false, "the UI is told the order isn't complete");
  assert.ok(res.body.outpoint, "and which channel was opened, to report it again");
  assert.equal(node.callsTo("default.openChannel").length, 1);
  // Amboss didn't take the funding transaction: no sale yet, so nothing is
  // earned and no service fee is owed.
  assert.equal(api.earnings.recent().length, 0);
  assert.equal(api.serviceFees.entries().length, 0);
});

function heldOrder(id: string, withChannel: boolean): Lsps1Order {
  const now = new Date();
  return {
    orderId: id,
    peer: BUYER,
    createdAt: now.toISOString(),
    lspBalanceSat: 2_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4320,
    token: "",
    announceChannel: true,
    orderState: "CREATED",
    paymentState: "HOLD",
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: "lnbc-placeholder",
    invoiceId: "aa".repeat(32),
    invoiceSecret: "bb".repeat(32),
    invoiceExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    channel: withChannel
      ? { fundedAt: now.toISOString(), fundingOutpoint: `${"cc".repeat(32)}:0`, expiresAt: new Date(now.getTime() + 30 * 86_400_000).toISOString() }
      : null,
    serviceFeePaidSat: 0,
  };
}

/** LSPS1 service on a fake node, with its LND seams under test control. */
function lsps1(t: AfterHook, dir: string, node: FakeLnd) {
  const earnings = new EarningsLog(dir);
  const fees = new ServiceFeeLedger(dir, lndFeeLightning(node.lnd), { payTimeoutMs: 100 });
  const svc = new Lsps1Service(
    dir,
    node.lnd,
    node.lnd,
    new SettingsStore(dir),
    () => ({ maxChannelSats: 10_000_000, reserveSats: 50_000, maxDeploySats: 50_000_000 }),
    () => ({ sellPricingMode: "balanced", adaptiveLevel: 0.5 }),
    () => "",
    earnings,
    fees,
  );
  t.after(() => {
    svc.stop();
    fees.stop();
  });
  const seams = svc as unknown as {
    orders: Lsps1Order[];
    lndSettle: (secret: string) => Promise<void>;
    lndInvoice: (id: string) => Promise<{ is_confirmed: boolean; is_held?: boolean; is_canceled?: boolean }>;
    settleAndRecord: (o: Lsps1Order) => Promise<void>;
    recoverOrders: () => Promise<void>;
  };
  return { svc, seams, earnings, fees };
}

test("an LSPS1 settle books the sale and enqueues the fee without waiting for it", async (t) => {
  feeEnv(t);
  const dir = makeTempDir(t);
  const http = installFetchMock(t);
  mockLnurlPayServer(http, { address: ADDRESS });
  const node = new FakeLnd();
  node.payOutcome = "hang";
  const { seams, earnings, fees } = lsps1(t, dir, node);
  const settled: string[] = [];
  seams.lndSettle = async (secret) => {
    settled.push(secret);
  };
  const order = heldOrder("o-1", true);
  seams.orders.unshift(order);

  await within(10_000, seams.settleAndRecord(order), "settleAndRecord");
  assert.deepEqual(settled, [order.invoiceSecret]);
  assert.equal(order.orderState, "COMPLETED");
  assert.equal(earnings.recent().length, 1);
  assert.equal(fees.entries()[0]?.key, "lsps1:o-1");
  assert.equal(fees.entries()[0]?.feeSats, 200);
  await fees.processDue();
});

test("LSPS1 recovery books a sale that was settled just before a crash", async (t) => {
  feeEnv(t);
  const dir = makeTempDir(t);
  // The crash window: settled in LND, but the order file still says HOLD.
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([heldOrder("o-2", true)]));
  const http = installFetchMock(t);
  mockLnurlPayServer(http, { address: ADDRESS });
  const node = new FakeLnd();
  const { svc, seams, earnings, fees } = lsps1(t, dir, node);
  seams.lndInvoice = async () => ({ is_confirmed: true });

  await seams.recoverOrders();
  assert.equal(svc.orderViews()[0].orderState, "COMPLETED");
  assert.deepEqual(
    earnings.recent().map((r) => [r.orderId, r.leaseSats]),
    [["o-2", 20_000]],
    "the sale is in P&L",
  );
  assert.equal(fees.entries()[0]?.key, "lsps1:o-2");
  await fees.processDue();
});
