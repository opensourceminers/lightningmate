/**
 * D7: every channel sold through Magma or LSPS1 stays within the routing-fee
 * caps its order locked, for the lease — after every rule that can raise a
 * fee (profit floor, protect ramp, a fixed pin), and on manual applies too.
 *
 * Before: offers promised no caps at all, and nothing knew which channels
 * were sold: the protect ramp or a profit floor could lift a buyer's channel
 * to thousands of ppm, making the inbound they paid for unusable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeCap, clampToCap, leaseCapFrom, offerFeeCaps, type LeaseCap } from "../src/services/leaseCaps.js";
import { getFeeRecommendations } from "../src/services/feeRecommend.js";
import { applyFees } from "../src/services/fees.js";
import { Autopilot } from "../src/services/autopilot.js";
import { RebalanceLog, type RebalanceRecord } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { MagmaJournal } from "../src/services/magmaJournal.js";
import { feeNode } from "./helpers/feeNode.js";
import { startApi } from "./helpers/apiHarness.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { suppressSchedulerKicks, BUYER, sellerSetup } from "./helpers/autopilot.js";
import { makeTempDir } from "./helpers/tmp.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { quiet } from "./helpers/lifecycle.js";

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const HEIGHT = 860_000;

/** A sold channel's promise, as an order locks it. */
const cap = (outpoint: string, o: Partial<LeaseCap> = {}): LeaseCap => ({
  fundingOutpoint: outpoint,
  source: "magma",
  orderId: "order-1",
  feeRateCapPpm: 2200,
  baseFeeCapMsat: 1000,
  leaseBlocks: 4320,
  ...o,
});

test("an offer's promise: max(2,200 ppm, the fee policy's max) and max(1 sat, the policy's base fee)", () => {
  assert.deepEqual(offerFeeCaps({ maxPpm: 1000, baseFeeMsat: 0 }), { feeRateCapPpm: 2200, baseFeeCapSats: 1 });
  assert.deepEqual(offerFeeCaps({ maxPpm: 3000, baseFeeMsat: 1500 }), { feeRateCapPpm: 3000, baseFeeCapSats: 2 });
});

test("a promise binds from the order's locked terms for the lease: none when nothing was locked, none after the lease", () => {
  assert.equal(leaseCapFrom({ fundingOutpoint: "aa:0", source: "magma", orderId: "o", feeRateCapPpm: 0, baseFeeCapSats: 0, leaseBlocks: 4320 }), null, "0 ppm locked = no promise (never route for free)");
  assert.equal(leaseCapFrom({ fundingOutpoint: "aa:0", source: "magma", orderId: "o", feeRateCapPpm: null, baseFeeCapSats: null, leaseBlocks: 4320 }), null);
  assert.equal(leaseCapFrom({ fundingOutpoint: null, source: "lsps1", orderId: "o", feeRateCapPpm: 2200, baseFeeCapSats: 1, leaseBlocks: 4320 }), null, "no channel, no promise");
  const c = leaseCapFrom({ fundingOutpoint: "aa:0", source: "lsps1", orderId: "o", feeRateCapPpm: 2200, baseFeeCapSats: 1, leaseBlocks: 4320 });
  assert.deepEqual(c, { fundingOutpoint: "aa:0", source: "lsps1", orderId: "o", feeRateCapPpm: 2200, baseFeeCapMsat: 1000, leaseBlocks: 4320 });
  // Confirmed at 855,000 with a 4,320-block lease: binding until 859,320.
  assert.ok(activeCap([c!], { outpoint: "aa:0", channelId: "855000x1x0" }, 859_319));
  assert.equal(activeCap([c!], { outpoint: "aa:0", channelId: "855000x1x0" }, 859_320), null, "lease over");
  assert.ok(activeCap([c!], { outpoint: "aa:0", channelId: "aa:0" }, 900_000), "not confirmed yet: inside its lease");
  assert.equal(activeCap([c!], { outpoint: "bb:0", channelId: "855000x1x0" }, 859_000), null, "another channel");
  // Two promises on one channel: the strictest.
  assert.equal(activeCap([c!, { ...c!, feeRateCapPpm: 1000 }], { outpoint: "aa:0" }, 0)?.feeRateCapPpm, 1000);
  assert.deepEqual(clampToCap({ feeRatePpm: 5000, baseFeeMsat: 0 }, c!), { feeRatePpm: 2200, baseFeeMsat: 0, clamped: true });
  assert.deepEqual(clampToCap({ feeRatePpm: 100, baseFeeMsat: 500 }, c!), { feeRatePpm: 100, baseFeeMsat: 500, clamped: false });
});

/** Channels for the engine: each with a different rule pushing its fee up. */
function engineSetup() {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [
      // Drained, with an expensive refill on record: the profit floor (basis
      // 5,000 ppm × 1.15) lifts its fee far above the policy's max.
      { id: "859000x1x0", partnerPublicKey: PEER(1), capacity: 2_000_000, localBalance: 100_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 900 },
      // Pinned by hand at 5,000 ppm.
      { id: "859000x2x0", partnerPublicKey: PEER(2), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 900 },
      // Excluded from the autopilot — carrying 3,000 ppm.
      { id: "859000x3x0", partnerPublicKey: PEER(3), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(3), transactionVout: 0, feeRatePpm: 3000 },
      // Same as the first, but its lease is over.
      { id: "850000x4x0", partnerPublicKey: PEER(4), capacity: 2_000_000, localBalance: 100_000, transactionId: TX(4), transactionVout: 0, feeRatePpm: 900 },
    ],
  });
  const refill = (targetId: string): RebalanceRecord => ({
    at: new Date().toISOString(),
    via: "autopilot",
    targetId,
    targetAlias: "t",
    sourceId: "x",
    sourceAlias: "s",
    amountSats: 100_000,
    budgetPpm: 6000,
    feeSats: 500,
    costPpm: 5000,
    ok: true,
  });
  const caps = [cap(`${TX(1)}:0`), cap(`${TX(2)}:0`), cap(`${TX(3)}:0`, { orderId: "lsps-3", source: "lsps1" }), cap(`${TX(4)}:0`)];
  return { node, records: [refill("859000x1x0"), refill("850000x4x0")], caps };
}

test("the fee engine keeps a sold channel within its promise — over the profit floor and a fixed pin; lowering a broken promise skips the anti-churn guards", async () => {
  const { node, records, caps } = engineSetup();
  const overrides = { "859000x2x0": { mode: "fixed" as const, fixedPpm: 5000 }, "859000x3x0": { mode: "exclude" as const } };
  // Fees were changed on every channel just now: the cooldowns are on.
  const cooldown = { lastApplied: Object.fromEntries(["859000x1x0", "859000x2x0", "859000x3x0", "850000x4x0"].map((id) => [id, new Date().toISOString()])), cooldownHours: 6 };
  const without = await getFeeRecommendations(node.lnd, records, cooldown, { maxPpm: 1000 }, overrides);
  const floor = without.recommendations.find((r) => r.channelId === "859000x1x0")!;
  assert.ok(floor.targetPpm > 2200, `the profit floor alone: ${floor.targetPpm} ppm`);
  assert.equal(without.recommendations.find((r) => r.channelId === "859000x2x0")?.targetPpm, 1000, "pinned (clamped to the policy max only)");

  const report = await getFeeRecommendations(node.lnd, records, cooldown, { maxPpm: 1000 }, overrides, new Map(), new Map(), caps);
  const by = (id: string) => report.recommendations.find((r) => r.channelId === id)!;
  assert.ok(by("859000x1x0").targetPpm <= 2200, `profit floor clamped: ${by("859000x1x0").targetPpm}`);
  assert.match(by("859000x1x0").reasons[0], /lease promise: Magma order order-1… promised at most 2200 ppm/);
  assert.equal(by("859000x1x0").leaseCap?.feeRateCapPpm, 2200);
  // The excluded channel's 3,000 ppm breaks its promise: lowered at once —
  // past "excluded (manual)" and the raise/lower cooldowns.
  const excluded = by("859000x3x0");
  assert.equal(excluded.leaseCapBreach, true);
  assert.equal(excluded.targetPpm, 2200);
  assert.equal(excluded.wouldApply, true, excluded.blockedByGuards.join());
  // A lease that is over binds nothing.
  assert.ok(by("850000x4x0").targetPpm > 2200, "lease over: the profit floor applies again");
  assert.equal(by("850000x4x0").leaseCap, null);
});

test("a broken promise is fixed first under the per-run change limit — even one that only the base fee breaks (a ppm move of 0), ahead of a bigger ordinary move", async () => {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [
      // Pinned by hand from 100 to 900 ppm: an 800 ppm move.
      { id: "859000x5x0", partnerPublicKey: PEER(5), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(5), transactionVout: 0, feeRatePpm: 100 },
      // Sold, excluded from the autopilot, and carrying a 5 sat base fee
      // against a 1 sat promise: its ppm stays, only the base comes down.
      { id: "859000x6x0", partnerPublicKey: PEER(6), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(6), transactionVout: 0, feeRatePpm: 500, baseFeeMsat: 5000 },
    ],
  });
  const overrides = { "859000x5x0": { mode: "fixed" as const, fixedPpm: 900 }, "859000x6x0": { mode: "exclude" as const } };
  const report = await getFeeRecommendations(node.lnd, [], null, { maxChangesPerRun: 1 }, overrides, new Map(), new Map(), [cap(`${TX(6)}:0`)]);
  const by = (id: string) => report.recommendations.find((r) => r.channelId === id)!;
  const sold = by("859000x6x0");
  assert.equal(sold.leaseCapBreach, true);
  assert.deepEqual([sold.currentPpm, sold.targetPpm, sold.currentBaseMsat, sold.recommendedBaseMsat], [500, 500, 5000, 1000]);
  // Ordered by the ppm move alone, the 800 ppm pin would take the one change
  // a run allows, and the base-fee breach — a move of 0 — would be pushed out
  // run after run, the promise broken for good.
  assert.equal(sold.wouldApply, true, sold.blockedByGuards.join());
  const pinned = by("859000x5x0");
  assert.equal(pinned.targetPpm, 900);
  assert.equal(pinned.wouldApply, false);
  assert.deepEqual(pinned.blockedByGuards, ["max changes per run reached"]);
});

test("a manual fee apply on a sold channel is clamped to its promise at the last gate — and the result says so", async () => {
  const { node, caps } = engineSetup();
  const items = [{ id: "859000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 5000, baseFeeMsat: 3000 }];
  const [res] = await applyFees(node.lnd, node.lnd, items, caps);
  assert.equal(res.ok, true);
  assert.equal(res.feeRatePpm, 2200);
  assert.equal(res.baseFeeMsat, 1000);
  assert.match(res.clampedBy ?? "", /promised at most 2200 ppm \+ 1 sat base for its lease — applied 2200 ppm, not 5000/);
  assert.deepEqual(node.policyWrites, [{ outpoint: `${TX(1)}:0`, feeRatePpm: 2200, baseFeeMsat: 1000 }]);
  // A channel no promise binds is applied as asked.
  const [free] = await applyFees(node.lnd, node.lnd, [{ ...items[0], id: "850000x4x0", transactionId: TX(4) }], caps);
  assert.equal(free.feeRatePpm, 5000);
  assert.equal(free.clampedBy, undefined);
});

test("over HTTP: POST /fees/apply clamps a channel sold through Magma or LSPS1 to the caps its order locked", async (t) => {
  const { node } = engineSetup();
  const dir = makeTempDir(t);
  const now = new Date().toISOString();
  // A Magma sale (journal) and an LSPS1 sale (its order store), each with a channel.
  writeFileSync(
    join(dir, "magma-orders.json"),
    JSON.stringify([
      {
        orderId: "magma-1", phase: "settled", via: "autopilot", createdAt: now, updatedAt: now, buyerPubkey: PEER(1),
        sizeSats: 2_000_000, isPrivate: false, feeMsat: "12345000", leaseBlocks: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1,
        invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: `${TX(1)}:0`, events: [],
      },
    ]),
  );
  writeFileSync(
    join(dir, "lsps1-orders.json"),
    JSON.stringify([
      {
        orderId: "lsps-2", peer: PEER(2), createdAt: now, lspBalanceSat: 2_000_000, clientBalanceSat: 0,
        requiredChannelConfirmations: 1, fundingConfirmsWithinBlocks: 6, channelExpiryBlocks: 12_960, token: "",
        announceChannel: true, orderState: "COMPLETED", paymentState: "PAID", feeTotalSat: 20_000, orderTotalSat: 20_000,
        invoice: "", invoiceId: "ab".repeat(32), invoiceSecret: "cd".repeat(32), invoiceExpiresAt: now,
        channel: { fundedAt: now, fundingOutpoint: `${TX(2)}:0`, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() },
        serviceFeePaidSat: 0, feeRateCapPpm: 1500, baseFeeCapSats: 0,
      },
    ]),
  );
  const api = await startApi(t, { node, dir });
  const res = await api.request("POST", "/fees/apply", {
    items: [
      { id: "859000x1x0", transactionId: TX(1), transactionVout: 0, feeRatePpm: 5000, baseFeeMsat: 0 },
      { id: "859000x2x0", transactionId: TX(2), transactionVout: 0, feeRatePpm: 4000, baseFeeMsat: 2000 },
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r: { feeRatePpm: number }) => r.feeRatePpm), [2200, 1500]);
  assert.deepEqual(node.policyWrites.map((w) => [w.feeRatePpm, w.baseFeeMsat]), [[2200, 0], [1500, 0]]);
  assert.match(res.body.results[1].clampedBy, /LSP order lsps-2… promised at most 1500 ppm \+ 0 sat base/);
});

test("the fee autopilot itself never lifts a sold channel past its promise — a channel pinned at 5,000 ppm by hand gets 2,200", async (t) => {
  const { node } = engineSetup();
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const dir = makeTempDir(t);
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, "magma-orders.json"),
    JSON.stringify([
      {
        orderId: "magma-2", phase: "reported", via: "autopilot", createdAt: now, updatedAt: now, buyerPubkey: PEER(2),
        sizeSats: 2_000_000, isPrivate: false, feeMsat: "12345000", leaseBlocks: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1,
        invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: `${TX(2)}:0`, events: [],
      },
    ]),
  );
  writeFileSync(join(dir, "autopilot.json"), JSON.stringify({ config: { enabled: true, policy: { maxPpm: 6000 } }, history: [], sellAutoSizeMigrated: true }));
  const overrides = new OverridesStore(dir);
  overrides.set("859000x2x0", { mode: "fixed", fixedPpm: 5000 });
  const autopilot = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), overrides, new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(autopilot);
  t.after(() => autopilot.shutdown());
  const run = await autopilot.runOnce();
  const change = run.changes.find((c) => c.id === "859000x2x0");
  assert.equal(change?.toPpm, 2200, JSON.stringify(run.changes));
  assert.deepEqual(node.policyWrites.find((w) => w.outpoint === `${TX(2)}:0`)?.feeRatePpm, 2200);
});

test("fee automation off: a sold channel whose fee breaks its promise is lowered to the cap — no other fee is touched", async (t) => {
  const { node } = engineSetup();
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const dir = makeTempDir(t);
  const now = new Date().toISOString();
  const sale = (orderId: string, tx: string) => ({
    orderId, phase: "reported", via: "autopilot", createdAt: now, updatedAt: now, buyerPubkey: PEER(3),
    sizeSats: 2_000_000, isPrivate: false, feeMsat: "12345000", leaseBlocks: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1,
    invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: `${tx}:0`, events: [],
  });
  // Channel 3 carries 3,000 ppm (set elsewhere) against a 2,200 ppm promise;
  // channel 1 is sold too but within its promise.
  writeFileSync(join(dir, "magma-orders.json"), JSON.stringify([sale("magma-3", TX(3)), sale("magma-1", TX(1))]));
  writeFileSync(join(dir, "autopilot.json"), JSON.stringify({ config: { enabled: false }, history: [], sellAutoSizeMigrated: true }));
  const autopilot = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(autopilot);
  t.after(() => autopilot.shutdown());
  const run = await autopilot.runOnce();
  assert.deepEqual(node.policyWrites, [{ outpoint: `${TX(3)}:0`, feeRatePpm: 2200, baseFeeMsat: 1000 }]);
  assert.deepEqual(run.changes.map((c) => [c.id, c.fromPpm, c.toPpm, c.ok]), [["859000x3x0", 3000, 2200, true]]);
  // Kept: a second run has nothing to do.
  await autopilot.runOnce();
  assert.equal(node.policyWrites.length, 1);
});

test("a sale that ended without a lease binds nothing: a channel whose order failed or was cancelled (the buyer refunded) carries no promise", async (t) => {
  const dir = makeTempDir(t);
  const now = new Date().toISOString();
  const entry = (orderId: string, phase: string, tx: string) => ({
    orderId, phase, via: "autopilot", createdAt: now, updatedAt: now, buyerPubkey: PEER(5),
    sizeSats: 2_000_000, isPrivate: false, feeMsat: "12345000", leaseBlocks: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1,
    invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: `${tx}:0`, events: [],
  });
  writeFileSync(
    join(dir, "magma-orders.json"),
    JSON.stringify([entry("failed-1", "failed", TX(5)), entry("cancelled-1", "cancelled", TX(6)), entry("settled-1", "settled", TX(7))]),
  );
  const autopilot = new Autopilot(dir, new FakeLnd().lnd, undefined, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(autopilot);
  t.after(() => autopilot.shutdown());
  assert.deepEqual(autopilot.capital.leaseCaps().map((c) => c.orderId), ["settled-1"]);
});

test("a real Magma sale's locked promise is what binds its channel: accept → paid → opened → reported, then the cap is in the ledger", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, promises: { minBlockLength: 4320, feeRateCap: "1800", baseFeeCap: "2" } });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  const outpoint = `${node.pending[0].transactionId}:0`;
  assert.deepEqual(
    autopilot.capital.leaseCaps().map((c) => [c.fundingOutpoint, c.feeRateCapPpm, c.baseFeeCapMsat, c.leaseBlocks]),
    [[outpoint, 1800, 2000, 4320]],
  );
});

test("an LSPS1 order locks the same routing-fee promise as the node's Magma offers when it is created — and once its channel exists, that promise binds it", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 5_000_000 }) });
  api.autopilot.setConfig({ sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000, policy: { maxPpm: 2500 } });
  const lsp = api.lsps1 as unknown as {
    createOrder(rid: number, peer: string, p: Record<string, unknown>): Promise<{ result?: { order_id: string }; error?: unknown }>;
    quote: () => Promise<{ feeTotalSat: number; effectivePpm: number }>;
    watchInvoice: () => void;
    orders: { orderId: string; feeRateCapPpm?: number; baseFeeCapSats?: number; channel: unknown; orderState: string }[];
  };
  lsp.quote = async () => ({ feeTotalSat: 20_000, effectivePpm: 5_000 });
  lsp.watchInvoice = () => undefined;
  const res = await lsp.createOrder(1, "02" + "ef".repeat(32), {
    client_balance_sat: "0",
    required_channel_confirmations: 1,
    funding_confirms_within_blocks: 6,
    channel_expiry_blocks: 4320,
    announce_channel: true,
    lsp_balance_sat: "1000000",
  });
  assert.ok(res.result, JSON.stringify(res));
  const order = lsp.orders.find((o) => o.orderId === res.result!.order_id)!;
  assert.equal(order.feeRateCapPpm, 2500, "max(2,200, the policy's 2,500)");
  assert.equal(order.baseFeeCapSats, 1);
  assert.deepEqual(api.lsps1.leaseCaps(), [], "no channel yet: nothing to keep");
  order.channel = { fundedAt: new Date().toISOString(), fundingOutpoint: `${"ab".repeat(32)}:0`, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() };
  assert.deepEqual(
    api.capital.leaseCaps().map((c) => [c.source, c.fundingOutpoint, c.feeRateCapPpm, c.leaseBlocks]),
    [["lsps1", `${"ab".repeat(32)}:0`, 2500, 4320]],
  );
  // An order that FAILED sold nothing — even with a channel on record (the
  // buyer was refunded): it binds no promise.
  order.orderState = "FAILED";
  assert.deepEqual(api.lsps1.leaseCaps(), []);
  assert.deepEqual(api.capital.leaseCaps(), []);
});

test("a sold channel's promise outlives the journal's trim: 600 newer ended orders never push out a sale whose lease is still running — one long over can go", (t) => {
  const dir = makeTempDir(t);
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
  const sale = (orderId: string, outpoint: string, settledDaysAgo: number) => ({
    orderId, phase: "settled", via: "autopilot", createdAt: at(settledDaysAgo + 1), updatedAt: at(settledDaysAgo), buyerPubkey: PEER(1),
    sizeSats: 2_000_000, isPrivate: false, feeMsat: "12345000", leaseBlocks: 4320, feeRateCapPpm: 2200, baseFeeCapSats: 1,
    invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: outpoint, settledAt: at(settledDaysAgo), events: [],
  });
  // Oldest first on disk is last: the journal keeps newest first.
  const rejected = Array.from({ length: 600 }, (_, i) => ({
    orderId: `rej-${i}`, phase: "rejected", via: "autopilot", createdAt: at(1), updatedAt: at(1), buyerPubkey: PEER(2),
    sizeSats: 3_000_000, isPrivate: false, feeMsat: "0", leaseBlocks: null, feeRateCapPpm: null, baseFeeCapSats: null,
    invoice: null, acceptAttempts: 0, openAttempts: 0, reportAttempts: 0, events: [],
  }));
  writeFileSync(
    join(dir, "magma-orders.json"),
    JSON.stringify([...rejected, sale("running", `${TX(5)}:0`, 20), sale("long-over", `${TX(6)}:0`, 120)]),
  );
  const journal = new MagmaJournal(dir);
  journal.note(); // any save trims
  const kept = new Set(journal.all().map((e) => e.orderId));
  assert.ok(kept.has("running"), "a lease 20 days into its 30: kept");
  assert.equal(kept.has("long-over"), false, "a lease long over: trimmed like any ended order");
  assert.deepEqual(journal.leaseCaps().map((c) => [c.orderId, c.feeRateCapPpm]), [["running", 2200]]);
  assert.ok(journal.claimedOutpoints().has(`${TX(5)}:0`));
  assert.equal(journal.all().filter((e) => e.phase === "rejected").length, 500, "the ended orders are trimmed as before");
});

test("an LSPS1 sale's promise outlives the order list's trim: 250 newer abandoned orders never push out a sold channel whose lease is running — POST /fees/apply still clamps it", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const node = feeNode({
    blockHeight: HEIGHT,
    chainBalance: 5_000_000,
    channels: [{ id: "859000x2x0", partnerPublicKey: PEER(2), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 900 }],
  });
  const dir = makeTempDir(t);
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
  const order = (orderId: string, o: Record<string, unknown>) => ({
    orderId, peer: PEER(9), createdAt: at(1), lspBalanceSat: 2_000_000, clientBalanceSat: 0,
    requiredChannelConfirmations: 1, fundingConfirmsWithinBlocks: 6, channelExpiryBlocks: 4320, token: "",
    announceChannel: true, orderState: "FAILED", paymentState: "EXPECT_PAYMENT", feeTotalSat: 20_000, orderTotalSat: 20_000,
    invoice: "", invoiceId: orderId.padEnd(64, "0").slice(0, 64), invoiceSecret: "cd".repeat(32), invoiceExpiresAt: at(1),
    channel: null, serviceFeePaidSat: 0, feeRateCapPpm: 2200, baseFeeCapSats: 1, ...o,
  });
  // Newest first, as the service keeps them: quotes nobody paid (any peer can
  // leave ~10 an hour), then a 90-day sale 20 days into its lease, then a sale
  // whose lease ended long ago.
  const abandoned = Array.from({ length: 250 }, (_, i) => order(`abandoned-${i}`, { error: "expired unpaid" }));
  const sold = order("lsps-sold", {
    createdAt: at(21), channelExpiryBlocks: 12_960, orderState: "COMPLETED", paymentState: "PAID",
    channel: { fundedAt: at(20), fundingOutpoint: `${TX(2)}:0`, expiresAt: at(-70) }, feeRateCapPpm: 1500, baseFeeCapSats: 0,
  });
  const over = order("lsps-over", {
    createdAt: at(201), orderState: "COMPLETED", paymentState: "PAID",
    channel: { fundedAt: at(200), fundingOutpoint: `${TX(3)}:0`, expiresAt: at(170) },
  });
  // An order in progress (its payment held, its channel still to open) — far
  // back in a list read after a restart: its reservation lives in this list.
  const held = order("lsps-held", { orderState: "CREATED", paymentState: "HOLD", lspBalanceSat: 1_000_000 });
  // A channel opened whose order failed after all (the payment went back):
  // nothing sold, no promise — but the channel is still claimed by it.
  const refunded = order("lsps-refunded", {
    createdAt: at(5), paymentState: "REFUNDED", error: "payment refunded",
    channel: { fundedAt: at(5), fundingOutpoint: `${TX(4)}:0`, expiresAt: at(-25) },
  });
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([...abandoned, sold, over, held, refunded]));
  const api = await startApi(t, { node, dir });
  api.autopilot.setConfig({ sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000 });
  const lsp = api.lsps1 as unknown as {
    createOrder(rid: number, peer: string, p: Record<string, unknown>): Promise<{ result?: { order_id: string }; error?: unknown }>;
    quote: () => Promise<{ feeTotalSat: number; effectivePpm: number }>;
    watchInvoice: () => void;
    fulfill(o: unknown): Promise<void>;
    lndOpen: () => Promise<unknown>;
    lndInvoice: () => Promise<{ is_held: boolean }>;
    lndSettle: () => Promise<void>;
    lndFeeRate: () => Promise<{ tokens_per_vbyte: number }>;
    orders: { orderId: string; paymentState: string; orderState: string }[];
  };
  lsp.quote = async () => ({ feeTotalSat: 20_000, effectivePpm: 5_000 });
  lsp.watchInvoice = () => undefined;
  // One more order arrives: the list is saved — and trimmed.
  const res = await lsp.createOrder(1, PEER(8), {
    client_balance_sat: "0",
    required_channel_confirmations: 1,
    funding_confirms_within_blocks: 6,
    channel_expiry_blocks: 4320,
    announce_channel: true,
    lsp_balance_sat: "1000000",
  });
  assert.ok(res.result, JSON.stringify(res));
  const kept = new Set(lsp.orders.map((o) => o.orderId));
  // Before: a plain slice to 200 — the sale, 250 orders back, was gone.
  assert.ok(kept.has("lsps-sold"), "a lease still running: kept");
  assert.ok(kept.has(res.result!.order_id), "the new order: kept");
  assert.ok(kept.has("lsps-held"), "an order in progress, however far back: kept");
  assert.ok(kept.has("lsps-refunded"), "its channel stays claimed — no other order's open adopts it");
  assert.ok(api.capital.claimedOutpoints().has(`${TX(4)}:0`));
  assert.equal(kept.has("lsps-over"), false, "a lease long over is trimmed like any ended order");
  assert.equal(lsp.orders.filter((o) => o.orderId.startsWith("abandoned-")).length, 200, "the newest 200 ended orders, as before");
  assert.deepEqual(api.capital.leaseCaps().map((c) => [c.orderId, c.feeRateCapPpm]), [["lsps-sold", 1500]]);
  // The buyer pays and the channel opens: recording it saves (and trims) the list again.
  const fresh = lsp.orders.find((o) => o.orderId === res.result!.order_id)!;
  fresh.paymentState = "HOLD";
  node.peers.push(PEER(8));
  lsp.lndInvoice = async () => ({ is_held: true });
  lsp.lndOpen = async () => ({ ok: true, transactionId: TX(7), transactionVout: 0 });
  lsp.lndSettle = async () => undefined;
  lsp.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
  await lsp.fulfill(fresh);
  assert.equal(fresh.orderState, "COMPLETED");
  const after = new Set(lsp.orders.map((o) => o.orderId));
  assert.ok(after.has("lsps-sold") && after.has("lsps-held") && after.has("lsps-refunded"), "still kept after the new channel is recorded");
  assert.deepEqual(new Set(api.capital.leaseCaps().map((c) => c.orderId)), new Set(["lsps-sold", fresh.orderId]));
  const fee = await api.request("POST", "/fees/apply", {
    items: [{ id: "859000x2x0", transactionId: TX(2), transactionVout: 0, feeRatePpm: 4000, baseFeeMsat: 2000 }],
  });
  assert.equal(fee.status, 200);
  assert.deepEqual(fee.body.results.map((r: { feeRatePpm: number }) => r.feeRatePpm), [1500]);
  assert.deepEqual(node.policyWrites, [{ outpoint: `${TX(2)}:0`, feeRatePpm: 1500, baseFeeMsat: 0 }]);
});
