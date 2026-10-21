/**
 * One on-chain budget for Magma sales, LSPS1 sales and routing opens: one
 * mutex for every "check the balance, then open", and reservations for every
 * coin promised to a buyer — kept in the order records on disk, so they hold
 * across runs and restarts.
 *
 * Before: a per-run counter, reset at the start of every run and every
 * 3-minute poll. A Magma order accepted at 10:00 was forgotten by 10:03, a
 * routing open could spend the coins promised to that buyer, and the buyer's
 * paid order then failed at open time. The reserve also ignored LND's own
 * anchor reserve and the funding fee.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { OnchainMutex, effectiveReserve, listableSat, spendableFrom, type Reservation } from "../src/services/capital.js";
import type { Lsps1Order } from "../src/services/lsps1.js";
import { FakeLnd, type FakeChannel } from "./helpers/fakeLnd.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { BUYER, sellerSetup, suggestion, type AutopilotSeams } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { OPENING_GRACE_MS } from "../src/services/magmaDesk.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const OTHER_BUYER = "02" + "cd".repeat(32);

/** `n` open anchor channels to other peers (LND reserves 10k for each). */
const anchorChannels = (n: number): FakeChannel[] =>
  Array.from({ length: n }, (_, i) => ({
    partnerPublicKey: "03" + String(i).repeat(64).slice(0, 64),
    capacity: 1_000_000,
    localBalance: 500_000,
    transactionId: String(i + 1).repeat(64).slice(0, 64),
    transactionVout: 0,
  }));

async function within<T>(ms: number, p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
}

test("the mutex: one holder at a time, in arrival order, and it says when it is idle", async () => {
  const m = new OnchainMutex();
  const log: string[] = [];
  let inside = 0;
  const job = (name: string, ms: number) =>
    m.run(name, async () => {
      inside += 1;
      assert.equal(inside, 1, "never two at once");
      log.push(`start ${name}`);
      await sleep(ms);
      log.push(`end ${name}`);
      inside -= 1;
      return name;
    });
  const results = await Promise.all([job("a", 30), job("b", 5), job("c", 1)]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
  assert.equal(m.busy, false);
  assert.equal(await m.waitIdle(10), true);
  // A holder that throws releases the mutex.
  await assert.rejects(m.run("x", async () => Promise.reject(new Error("boom"))));
  assert.equal(await m.run("after", async () => "ran"), "ran");
});

test("the reserve (D5): the larger of the setting and LND's anchor reserve for one more channel, plus the funding fee", async () => {
  const node = new FakeLnd();
  const anchors = (n: number) => {
    node.channels = Array.from({ length: n }, (_, i) => ({
      partnerPublicKey: "03" + (i % 10).toString().repeat(64),
      capacity: 1_000_000,
      localBalance: 500_000,
      transactionId: (i + 1).toString(16).padStart(64, "0"),
      transactionVout: 0,
    }));
  };
  anchors(0);
  let r = await effectiveReserve(node.lnd, 50_000);
  assert.equal(r.anchorReserveSat, 10_000);
  assert.equal(r.fundingFeeSat, 1_000, "no fee estimate from LND: the default open cost");
  assert.equal(r.totalSat, 51_000);
  anchors(6);
  r = await effectiveReserve(node.lnd, 50_000);
  assert.equal(r.anchorReserveSat, 70_000, "10k × (6 + 1): LND would refuse anything that leaves less");
  assert.equal(r.totalSat, 71_000);
  anchors(14);
  r = await effectiveReserve(node.lnd, 50_000);
  assert.equal(r.anchorReserveSat, 100_000, "capped like LND's MaxAnchorChanReservedValue");
  r = await effectiveReserve(node.lnd, 250_000);
  assert.equal(r.totalSat, 251_000, "a larger setting wins");
});

test("coins promised to an accepted Magma order are not spent by a routing open — in a later run too", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t, { chainBalance: 2_600_000, config: { channelEnabled: true, channelSizeSats: 1_000_000 } });
  magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders(); // accepted: 2M promised to the buyer
  node.peers.push(suggestion.pubkey);
  (autopilot as unknown as AutopilotSeams).channelSuggestions = async () => ({ suggestions: [suggestion] });
  (autopilot as unknown as AutopilotSeams).openFeeRate = async () => 2; // LND's economy estimate (the fake has none)

  // Two runs later (the old counter was reset at the start of every run).
  await autopilot.runOnce();
  await autopilot.runOnce();
  assert.equal(node.callsTo("default.openChannel").length, 0, "the buyer's coins stay the buyer's");

  // The order ends (the buyer never paid): its coins are free again.
  magma.setStatus([...magma.sales.keys()][0], "BUYER_FAILED_TO_PAY");
  await autopilot.pollSellOrders();
  await autopilot.runOnce();
  assert.equal(node.callsTo("default.openChannel").length, 1);
});

test("a Magma accept counts what LSPS1 has promised, and LSPS1 counts what Magma has promised", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const node = new FakeLnd({ chainBalance: 3_000_000 });
  const api = await startApi(t, { node });
  magma.sellerPubkey = api.node.publicKey; // this node's sales and offers
  api.amboss.setKey("test-key");
  api.autopilot.setConfig({ sellEnabled: true, sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000 });
  const lsp = api.lsps1 as unknown as { orders: Lsps1Order[]; quotableSat(fresh: boolean): Promise<number> };
  const spendableBefore = await lsp.quotableSat(true);

  // An LSPS1 buyer has paid for 2M; the channel isn't open yet.
  lsp.orders.unshift({
    orderId: "lsp-1",
    peer: "02" + "ef".repeat(32),
    createdAt: new Date().toISOString(),
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
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
  });
  const order = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_500_000 });
  await api.autopilot.pollSellOrders();
  assert.equal(magma.sales.get(order.id)?.status, "SELLER_REJECTED", "3M − 51k reserve − 2M promised < 1.5M");

  lsp.orders.splice(0, 1);
  const small = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await api.autopilot.pollSellOrders();
  assert.equal(magma.sales.get(small.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  const spendableAfter = await lsp.quotableSat(true);
  assert.equal(
    spendableBefore - spendableAfter,
    1_001_000,
    "LSP mode no longer offers the coins promised on Magma — nor the funding fee that order's open will need",
  );
});

test("an LSPS1 open waits while a Magma open holds the on-chain mutex", async (t) => {
  quiet(t);
  // The buyer placed the order over BOLT8: it is a connected peer.
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 10_000_000, peers: ["02" + "ef".repeat(32)] }) });
  const lsp = api.lsps1 as unknown as {
    orders: Lsps1Order[];
    fulfill(o: Lsps1Order): Promise<void>;
    lndOpen: () => Promise<unknown>;
    lndInvoice: () => Promise<{ is_held: boolean }>;
    lndSettle: () => Promise<void>;
    lndFeeRate: () => Promise<{ tokens_per_vbyte: number }>;
  };
  let opens = 0;
  lsp.lndOpen = async () => {
    opens += 1;
    return { ok: true, transactionId: "cc".repeat(32), transactionVout: 0 };
  };
  lsp.lndInvoice = async () => ({ is_held: true });
  lsp.lndSettle = async () => undefined;
  lsp.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
  const order: Lsps1Order = {
    orderId: "lsp-2",
    peer: "02" + "ef".repeat(32),
    createdAt: new Date().toISOString(),
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
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
  };
  lsp.orders.unshift(order);

  let release = () => undefined as void;
  const held = api.capital.mutex.run("magma open (test)", () => new Promise<void>((r) => (release = r)));
  const fulfilled = lsp.fulfill(order);
  await sleep(100);
  assert.equal(opens, 0, "no LSPS1 open while another open holds the mutex");
  release();
  await held;
  await fulfilled;
  assert.equal(opens, 1);
  assert.equal(order.orderState, "COMPLETED");
});

// ── what a promised open needs on top of its size ─────────────────────────────

test("each promised open keeps its own funding fee and its step of LND's anchor reserve — and the reserve its own check applies", () => {
  const inputs = { anchorChannels: 6, fundingFeeSat: 1_000 };
  const promised = (sats: number, reserveSat = 50_000): Reservation => ({ key: `magma:${sats}`, sats, reserveSat });
  // No promise: one open — 10k × (6 + 1) = 70k anchor reserve (more than the
  // 50k setting) + its fee.
  assert.equal(spendableFrom(4_071_000, inputs, 50_000, []).spendableSat, 4_000_000);
  // One promised 1.985M open still to come: this open must leave its size,
  // its fee, and the anchor reserve after BOTH opens (80k).
  const one = spendableFrom(4_071_000, inputs, 50_000, [promised(1_985_000)]);
  assert.equal(one.reserve.pendingOpens, 1);
  assert.equal(one.reserve.anchorReserveSat, 80_000);
  assert.equal(one.spendableSat, 4_071_000 - 1_985_000 - 2 * 1_000 - 80_000);
  // A promised open checked against a 500k sell reserve: a routing open
  // (50k channel reserve) leaves that 500k too, or the promised one fails.
  assert.equal(spendableFrom(3_100_000, { anchorChannels: 0, fundingFeeSat: 1_000 }, 50_000, [promised(2_000_000, 500_000)]).spendableSat, 598_000);
  // Fail closed: a bad number never reads as capital.
  assert.equal(spendableFrom(Number.NaN, inputs, 50_000, []).spendableSat, 0);
  assert.equal(spendableFrom(4_071_000, { anchorChannels: 6, fundingFeeSat: Number.NaN }, 50_000, []).spendableSat, 0);
});

test("the listing leaves room for every open that could sell it out: k orders of at least the minimum need k fees and k anchor steps", () => {
  const sp = spendableFrom(4_071_000, { anchorChannels: 6, fundingFeeSat: 1_000 }, 50_000, []);
  // One open could take 4.0M; but 1M orders could sell a 4.0M listing out in
  // four opens (4 fees, anchor reserve 100k) — 3.978M is what three can fund,
  // and four orders of 1M no longer fit into it.
  assert.equal(listableSat(sp, 1_000_000), 3_978_000);
  // A 2M minimum: anything below 4M can only be bought by ONE order, so one
  // open's overhead is enough — two would need 4M + their overhead.
  assert.equal(listableSat(sp, 2_000_000), 3_999_999);
  // Not even one order of the minimum: nothing to list.
  assert.equal(listableSat(spendableFrom(1_000_000, { anchorChannels: 0, fundingFeeSat: 1_000 }, 50_000, []), 1_000_000), 0);
});

test("an offer sold out by two orders: both are accepted, and both channels open — with LND's anchor reserve the binding one", async (t) => {
  quiet(t);
  // Six anchor channels: LND keeps 10k × (6 + 1) = 70k, more than the 50k sell
  // reserve. Before, the listing (and each accept) counted ONE open's fee and
  // anchor step: two orders could sell the 4.0M listing out, the first open
  // used the second one's fee and anchor step, and the second open failed
  // after its buyer had paid (SELLER_FAILED_TO_OPEN_CHANNEL).
  const { autopilot, node, magma, capital } = sellerSetup(t, { chainBalance: 4_071_000 });
  node.channels.push(...anchorChannels(6));
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000 });
  await autopilot.runOnce();
  const listed = offer.totalSats - offer.lockedSats;
  assert.equal(listed, 3_970_000, "listed: what two (or three) opens can fund, not what one could");

  const a = magma.addSale({ buyerPubkey: BUYER, sizeSats: listed / 2 });
  const b = magma.addSale({ buyerPubkey: OTHER_BUYER, sizeSats: listed / 2 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(a.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(magma.sales.get(b.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(capital.reservedSat(), listed);

  magma.buyerPays(a.id, node);
  magma.buyerPays(b.id, node);
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 2, "the second open still had its fee and its anchor step");
  assert.equal(magma.sales.get(a.id)?.status, "SELLER_SENT_TRANSACTION");
  assert.equal(magma.sales.get(b.id)?.status, "SELLER_SENT_TRANSACTION");
  assert.equal(capital.reservedSat(), 0, "funded: the wallet balance shows the spend now");
});

test("a sell reserve above the channel reserve: a routing open leaves it in place for an accepted order, whose open then succeeds", async (t) => {
  quiet(t);
  // Before, a routing open checked only its own 50k channel reserve and spent
  // the 450k more that the promised Magma open's 500k sell reserve needed.
  const { autopilot, node, magma } = sellerSetup(t, {
    chainBalance: 3_100_000,
    config: { channelEnabled: true, channelSizeSats: 1_000_000, channelReserveSats: 50_000, sellReserveSats: 500_000 },
  });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "3.1M − 501k ≥ 2M: accepted");
  node.peers.push(suggestion.pubkey);
  (autopilot as unknown as AutopilotSeams).channelSuggestions = async () => ({ suggestions: [suggestion] });
  (autopilot as unknown as AutopilotSeams).openFeeRate = async () => 2; // LND's economy estimate (the fake has none)

  await autopilot.runOnce();
  assert.equal(node.callsTo("default.openChannel").length, 0, "no routing open: 598k left after what the buyer's open needs");

  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 1, "the buyer's channel");
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_SENT_TRANSACTION");
});

// ── LSPS1 quotes are LSPS1's own business ─────────────────────────────────────

const ORDER_PARAMS = {
  client_balance_sat: "0",
  required_channel_confirmations: 1,
  funding_confirms_within_blocks: 6,
  channel_expiry_blocks: 4320,
  announce_channel: true,
};

type LspCreate = {
  createOrder(rid: number, peer: string, p: Record<string, unknown>): Promise<{ result?: { order_id: string }; error?: { code: number; data?: { message?: string } } }>;
  quote: () => Promise<{ feeTotalSat: number; effectivePpm: number }>;
  watchInvoice: () => void;
  orders: Lsps1Order[];
};

async function lspSetup(t: TestContext, chainBalance: number) {
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const node = new FakeLnd({ chainBalance });
  const api = await startApi(t, { node });
  magma.sellerPubkey = api.node.publicKey; // this node's sales and offers
  api.amboss.setKey("test-key");
  api.autopilot.setConfig({ sellEnabled: true, sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000 });
  const lsp = api.lsps1 as unknown as LspCreate;
  lsp.quote = async () => ({ feeTotalSat: 20_000, effectivePpm: 5_000 }); // pricing is not under test
  lsp.watchInvoice = () => undefined;
  return { api, node, magma, lsp };
}

test("create_order is refused when the coins are promised elsewhere — get_info's clamped maximum vouches for nothing", async (t) => {
  quiet(t);
  const { api, node, magma, lsp } = await lspSetup(t, 3_000_000);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_900_000 });
  await api.autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "Magma promised 2.9M of the 3M");
  const invoicesBefore = node.callsTo("invoices.addHoldInvoice").length;

  // get_info still advertises the 1M minimum as its maximum (the spec wants
  // min ≤ max) — before, an order up to that clamped maximum was taken on with
  // 48k behind it, and as a reservation it then sank the paid Magma order.
  const res = await lsp.createOrder(1, "02" + "ef".repeat(32), { ...ORDER_PARAMS, lsp_balance_sat: "1000000" });
  assert.equal(res.error?.code, 1, JSON.stringify(res));
  assert.match(res.error?.data?.message ?? "", /no on-chain capital/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, invoicesBefore, "no invoice for an order that can't be served");

  magma.buyerPays(sale.id, node);
  await api.autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 1, "the paid Magma order opens");
});

test("an unpaid LSPS1 quote never stands in the way of a Magma accept or a paid Magma open — but LSPS1's own next quote counts it", async (t) => {
  quiet(t);
  const { api, node, magma, lsp } = await lspSetup(t, 3_000_000);
  api.autopilot.setConfig({ sellMaxDeploySats: 3_000_000 });
  const quote = await lsp.createOrder(1, "02" + "ef".repeat(32), { ...ORDER_PARAMS, lsp_balance_sat: "1500000" });
  assert.ok(quote.result?.order_id, JSON.stringify(quote));
  // Its own second quote: the first one's coins are spoken for (LSPS1-internal)
  // — refused, as above the maximum get_info now advertises.
  const second = await lsp.createOrder(2, "02" + "ee".repeat(32), { ...ORDER_PARAMS, lsp_balance_sat: "1500000" });
  assert.ok(second.error, "two buyers aren't quoted the same coins");
  assert.equal(lsp.orders.length, 1);
  assert.equal(api.capital.reservedSat(), 0, "an unpaid quote is no promise anyone else must honour");

  // Before, the unpaid quote counted in the shared ledger: 1.5M quoted + 2M
  // exceeded the 3M deploy cap, and 3M − 51k − 1.5M < 2M on chain — this
  // order was rejected, for a quote nobody may ever pay.
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await api.autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  magma.buyerPays(sale.id, node);
  await api.autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 1);
});

// ── dialing happens outside the mutex ─────────────────────────────────────────

test("a buyer slow to connect doesn't hold the on-chain mutex: the dial comes before it", async (t) => {
  quiet(t);
  const { autopilot, node, magma, capital } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  // The buyer dropped off; reaching it again stalls (a slow Tor circuit).
  node.peers = node.peers.filter((p) => p !== BUYER);
  let release = () => undefined as void;
  let dialing = false;
  node.override("default.connectPeer", (a, cb) => {
    dialing = true;
    let done = false;
    release = () => {
      if (done) return;
      done = true;
      node.peers.push((a.addr as { pubkey: string }).pubkey);
      cb(null, {});
    };
  });
  t.after(() => release());
  const lane = autopilot.pollSellOrders();
  for (let i = 0; i < 400 && !dialing; i++) await sleep(5);
  assert.ok(dialing, "the lane is dialing the buyer");
  assert.equal(capital.mutex.busy, false, "nobody holds the mutex during the dial");
  assert.equal(await within(1_000, capital.mutex.run("another open", async () => "done"), "another open"), "done");
  release();
  await lane;
  assert.equal(node.callsTo("default.openChannel").length, 1);
});

test("a routing peer slow to connect doesn't hold up a Magma accept", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t, { config: { channelEnabled: true, channelSizeSats: 1_000_000 } });
  const peer = { ...suggestion, socket: "9.9.9.9:9735" };
  (autopilot as unknown as AutopilotSeams).channelSuggestions = async () => ({ suggestions: [peer] });
  (autopilot as unknown as AutopilotSeams).openFeeRate = async () => 2; // LND's economy estimate (the fake has none)
  let release = () => undefined as void;
  let dialing = false;
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (pk !== peer.pubkey || dialing) {
      if (!node.peers.includes(pk)) node.peers.push(pk);
      return cb(null, {});
    }
    dialing = true;
    let done = false;
    release = () => {
      if (done) return;
      done = true;
      node.peers.push(pk);
      cb(null, {});
    };
  });
  t.after(() => release());
  const run = autopilot.runOnce();
  for (let i = 0; i < 400 && !dialing; i++) await sleep(5);
  assert.ok(dialing, "the main run is dialing the routing peer");

  // A buyer's order arrives: its accept needs the mutex (capital check).
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await within(2_000, autopilot.pollSellOrders(), "the order lane");
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted while the routing dial still hangs");

  release();
  const done = await run;
  assert.equal(done.channels[0]?.ok, true, "and the routing channel opened once its peer answered");
  assert.equal(
    node.callsTo("default.connectPeer").filter((c) => (c.addr as { pubkey: string }).pubkey === peer.pubkey).length,
    1,
    "dialed once, before the mutex — the open itself dials no more",
  );
});

test("an LSPS1 buyer slow to reconnect doesn't hold the on-chain mutex either", async (t) => {
  quiet(t);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 10_000_000 }) });
  const lsp = api.lsps1 as unknown as {
    orders: Lsps1Order[];
    fulfill(o: Lsps1Order): Promise<void>;
    lndConnect: () => Promise<boolean>;
    lndOpen: () => Promise<unknown>;
    lndInvoice: () => Promise<{ is_held: boolean }>;
    lndSettle: () => Promise<void>;
    lndFeeRate: () => Promise<{ tokens_per_vbyte: number }>;
  };
  let release = (_ok: boolean) => undefined as void;
  let dialing = false;
  lsp.lndConnect = () =>
    new Promise<boolean>((resolve) => {
      dialing = true;
      release = resolve;
    });
  let opens = 0;
  lsp.lndOpen = async () => {
    opens += 1;
    return { ok: true, transactionId: "cc".repeat(32), transactionVout: 0 };
  };
  lsp.lndInvoice = async () => ({ is_held: true });
  lsp.lndSettle = async () => undefined;
  lsp.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
  const order: Lsps1Order = {
    orderId: "lsp-slow",
    peer: "02" + "ef".repeat(32),
    createdAt: new Date().toISOString(),
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
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
  };
  lsp.orders.unshift(order);
  t.after(() => release(false));
  const fulfilled = lsp.fulfill(order);
  for (let i = 0; i < 400 && !dialing; i++) await sleep(5);
  assert.ok(dialing);
  assert.equal(api.capital.mutex.busy, false, "nobody holds the mutex while LSPS1 dials its buyer");
  release(true);
  await fulfilled;
  assert.equal(opens, 1);
  assert.equal(order.orderState, "COMPLETED");
});

// ── one channel, one sale: claims across Magma and LSPS1 ─────────────────────

/** A paid LSPS1 order (HOLD) without a channel yet, unless `o` says else. */
const lspOrder = (o: Partial<Lsps1Order> & Pick<Lsps1Order, "orderId" | "peer" | "lspBalanceSat">): Lsps1Order => ({
  createdAt: new Date().toISOString(),
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
  invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  channel: null,
  serviceFeePaidSat: 0,
  ...o,
});

async function sellingApi(t: TestContext, node: FakeLnd) {
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const api = await startApi(t, { node });
  magma.sellerPubkey = api.node.publicKey; // this node's sales and offers
  api.amboss.setKey("test-key");
  api.autopilot.setConfig({ sellEnabled: true, sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000 });
  return { api, magma };
}

test("a Magma open whose outcome is unclear never adopts the channel an LSPS1 sale opened to the same buyer", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  const { api, magma } = await sellingApi(t, node);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await api.autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  const desk = api.autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const realOpen = desk.lndOpen.bind(api.autopilot.magma);
  desk.lndOpen = async () => ({ ok: false, error: "FailedToOpenChannel: Connection dropped" });
  await api.autopilot.pollSellOrders();
  assert.equal(api.autopilot.magma.journal.get(sale.id)?.phase, "opening");

  // Meanwhile the same buyer bought a 1M channel over LSPS1, and LSPS1 opened it.
  const lspTx = "cd".repeat(32);
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  (api.lsps1 as unknown as { orders: Lsps1Order[] }).orders.unshift(
    lspOrder({
      orderId: "lsp-same-buyer",
      peer: BUYER,
      lspBalanceSat: 1_000_000,
      orderState: "COMPLETED",
      paymentState: "PAID",
      channel: { fundedAt: new Date().toISOString(), fundingOutpoint: `${lspTx}:0`, expiresAt },
    }),
  );
  node.pending.push({ partnerPublicKey: BUYER, capacity: 1_000_000, transactionId: lspTx, transactionVout: 0 });
  await api.autopilot.pollSellOrders();
  let e = api.autopilot.magma.journal.get(sale.id);
  // Before: Magma excluded only its own orders' channels — it adopted this
  // one, reported it to Amboss and was paid for it: one channel, paid twice.
  assert.notEqual(e?.fundingOutpoint, `${lspTx}:0`, "LSPS1's channel is LSPS1's");
  assert.equal(e?.phase, "opening", "still waiting for LND to show its own channel");
  assert.equal(magma.count("AddTransaction"), 0);

  // LND has had ample time and shows nothing of the Magma open: it never
  // happened, so the order gets its own channel now.
  desk.lndOpen = realOpen;
  e!.opening = { ...e!.opening!, startedAt: new Date(Date.now() - OPENING_GRACE_MS - 60_000).toISOString() };
  await api.autopilot.pollSellOrders();
  e = api.autopilot.magma.journal.get(sale.id);
  assert.equal(e?.phase, "reported");
  assert.ok(e?.fundingOutpoint && e.fundingOutpoint !== `${lspTx}:0`);
});

test("an LSPS1 open whose outcome is unclear never adopts the channel a Magma sale opened to the same buyer", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const { api, magma } = await sellingApi(t, node);
  const lsp = api.lsps1 as unknown as {
    orders: Lsps1Order[];
    fulfill(o: Lsps1Order): Promise<void>;
    lndOpen: () => Promise<unknown>;
    lndInvoice: () => Promise<{ is_held: boolean }>;
    lndSettle: () => Promise<void>;
    lndCancel: () => Promise<void>;
    lndFeeRate: () => Promise<{ tokens_per_vbyte: number }>;
  };
  let lspOpens = 0;
  let refunds = 0;
  lsp.lndOpen = async () => {
    lspOpens += 1;
    return { ok: false, error: "FailedToOpenChannel: Connection dropped" };
  };
  lsp.lndInvoice = async () => ({ is_held: true });
  lsp.lndSettle = async () => undefined;
  lsp.lndCancel = async () => {
    refunds += 1;
  };
  lsp.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
  const order = lspOrder({ orderId: "lsp-unclear", peer: BUYER, lspBalanceSat: 2_000_000 });
  lsp.orders.unshift(order);
  await lsp.fulfill(order);
  assert.match(order.opening?.unclear ?? "", /Connection dropped/);

  // Meanwhile the same node bought a 2M channel on Magma, and got it.
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await api.autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  await api.autopilot.pollSellOrders();
  const magmaOutpoint = api.autopilot.magma.journal.get(sale.id)?.fundingOutpoint;
  assert.ok(magmaOutpoint, "the Magma channel is open and on record");

  await lsp.fulfill(order); // LSPS1 looks for its own channel again
  // Before: LSPS1 excluded only its own orders' channels — it adopted the
  // Magma channel and settled the LSPS1 buyer's payment for it.
  assert.equal(order.channel, null, "the Magma buyer's channel is not LSPS1's");
  assert.equal(order.orderState, "CREATED");
  assert.equal(lspOpens, 1, "no second open while LND may still show its own");
  assert.equal(refunds, 0);
});

// ── manual spends and coins promised to buyers ───────────────────────────────

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

test("a manual open or on-chain send can't spend the coins promised to a paid Magma order: 409, naming the order", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 3_000_000 });
  const { api, magma } = await sellingApi(t, node);
  node.override("default.sendCoins", (_a, cb) => cb(null, { txid: "ef".repeat(32) }));
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  assert.equal((await api.request("POST", "/amboss/order/accept", { id: sale.id })).status, 200);
  magma.buyerPays(sale.id, node);

  // Before: 200 — the Channels tab spent 1.5M of the buyer's coins, and the
  // paid order then failed to open ("not enough on-chain capital") and was
  // refunded: SELLER_FAILED_TO_OPEN_CHANNEL on Amboss.
  const refused = await api.request("POST", "/channels/open", { pubkey: OTHER_BUYER, socket: "5.6.7.8:9735", localTokens: 1_500_000 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, "capital_promised");
  // 3M − 2M promised − the sell reserve (50k) − two funding fees (1k each).
  assert.equal(refused.body.spendableSat, 948_000);
  assert.deepEqual(refused.body.promised, [{ source: "magma", orderId: sale.id, sats: 2_000_000 }]);
  assert.match(
    refused.body.message,
    /^Only 948,000 sat can be spent without touching the coins promised to buyers whose channels aren't open yet: 1 accepted Magma order \(2,000,000 sat\)\./,
  );
  assert.match(refused.body.message, /Amboss counts a Magma order that isn't fulfilled against your seller score/);
  const send = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 1_000_000, feeRate: 5 });
  assert.equal(send.status, 409);
  assert.equal(send.body.error, "capital_promised");
  assert.equal(node.callsTo("default.openChannel").length, 0);
  assert.equal(node.callsTo("default.sendCoins").length, 0);
  const dialed = node.callsTo("default.connectPeer").filter((c) => (c.addr as { pubkey: string }).pubkey === OTHER_BUYER);
  assert.equal(dialed.length, 0, "a refused open dials no peer (over Tor that takes a minute and a half)");

  // What leaves the buyer's coins alone goes through.
  const small = await api.request("POST", "/channels/open", { pubkey: OTHER_BUYER, socket: "5.6.7.8:9735", localTokens: 900_000 });
  assert.equal(small.status, 200);
  assert.equal(small.body.ok, true);
  const open = await api.request("POST", "/amboss/order/open", { id: sale.id });
  assert.equal(open.status, 200, JSON.stringify(open.body));
  assert.equal(node.callsTo("default.openChannel").length, 2, "and the paid order still opens");
});

test("spending promised coins anyway takes an explicit spendPromised: true (the UI sends it only after a confirmation naming the orders)", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 3_000_000 });
  const { api, magma } = await sellingApi(t, node);
  node.override("default.sendCoins", (_a, cb) => cb(null, { txid: "ef".repeat(32) }));
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  assert.equal((await api.request("POST", "/amboss/order/accept", { id: sale.id })).status, 200);
  const bad = await api.request("POST", "/channels/open", { pubkey: OTHER_BUYER, socket: "5.6.7.8:9735", localTokens: 1_500_000, spendPromised: "yes" });
  assert.equal(bad.status, 400, "only a real boolean overrides");
  const forced = await api.request("POST", "/channels/open", { pubkey: OTHER_BUYER, socket: "5.6.7.8:9735", localTokens: 1_500_000, spendPromised: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.ok, true);
  const sent = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 100_000, feeRate: 5, spendPromised: true });
  assert.equal(sent.status, 200);
  assert.equal(node.callsTo("default.sendCoins").length, 1);
});

test("a manual accept the wallet can't fund is refused (409): no invoice, no accept", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const { api, magma } = await sellingApi(t, node);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  const r = await api.request("POST", "/amboss/order/accept", { id: sale.id });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "capital");
  assert.match(r.body.message, /not enough on-chain capital/);
  assert.equal(magma.count("AcceptOrder"), 0, "Amboss is not told yes for coins that aren't there");
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "the operator can still reject it");
});

// ── what the guards are for, pinned ───────────────────────────────────────────

test("the deploy cap counts an accepted order once — as promised — while Amboss lists it unpaid or waiting for its channel", async (t) => {
  quiet(t);
  for (const status of ["WAITING_FOR_BUYER_PAYMENT", "WAITING_FOR_CHANNEL_OPEN"] as const) {
    const { autopilot, magma, capital } = sellerSetup(t, { config: { sellMaxDeploySats: 5_000_000 } });
    const a = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
    await autopilot.pollSellOrders();
    // (WAITING_FOR_CHANNEL_OPEN: Amboss shows it paid; our invoice holds
    // nothing yet — the order is still promised, not funded.)
    magma.setStatus(a.id, status);
    (autopilot.magma as unknown as { deployed: { at: number } }).deployed.at = 0; // the listing's 30 s cache ran out
    const b = magma.addSale({ buyerPubkey: OTHER_BUYER, sizeSats: 2_500_000 });
    await autopilot.pollSellOrders();
    assert.equal(capital.reservedSat(), 4_500_000, `${status}: both promised`);
    assert.equal(capital.deployedSat(), 0, `${status}: Amboss lists A, but it is promised here already — not counted twice`);
    assert.equal(magma.sales.get(b.id)?.status, "WAITING_FOR_BUYER_PAYMENT", `${status}: 2M promised + 2.5M fits the 5M cap`);
  }
});

test("a paid LSPS1 order on a wallet that funds exactly it — the reserve and the funding fee included — opens; one sat less is refunded", async (t) => {
  quiet(t);
  for (const [chain, opens] of [
    [2_051_000, 1],
    [2_050_999, 0],
  ] as const) {
    // 2M + the 50k sell reserve + one funding fee (1k): its own reservation
    // is what pays for it — counted against itself, it was refunded.
    const api = await startApi(t, { node: new FakeLnd({ chainBalance: chain, peers: ["02" + "ef".repeat(32)] }) });
    const lsp = api.lsps1 as unknown as {
      orders: Lsps1Order[];
      fulfill(o: Lsps1Order): Promise<void>;
      lndInvoice: () => Promise<{ is_held: boolean }>;
      lndSettle: () => Promise<void>;
      lndCancel: () => Promise<void>;
      lndFeeRate: () => Promise<{ tokens_per_vbyte: number }>;
    };
    lsp.lndInvoice = async () => ({ is_held: true });
    lsp.lndSettle = async () => undefined;
    lsp.lndCancel = async () => undefined;
    lsp.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
    const order = lspOrder({ orderId: `lsp-exact-${chain}`, peer: "02" + "ef".repeat(32), lspBalanceSat: 2_000_000 });
    lsp.orders.unshift(order);
    await lsp.fulfill(order);
    assert.equal(api.node.callsTo("default.openChannel").length, opens, `${chain} sat on chain`);
    assert.equal(order.orderState, opens ? "COMPLETED" : "FAILED");
    if (!opens) assert.match(order.error ?? "", /insufficient on-chain capital/);
  }
});

test("a Magma accept that lands while a routing open dials its peer: the routing open's own check, inside the mutex, refuses", async (t) => {
  quiet(t);
  // 2.6M on chain: alone, a 1M routing open fits; after a 2M Magma accept,
  // only 548k are left that the buyer's open doesn't need.
  const { autopilot, node, magma } = sellerSetup(t, {
    chainBalance: 2_600_000,
    config: { channelEnabled: true, channelSizeSats: 1_000_000 },
  });
  const peer = { ...suggestion, socket: "9.9.9.9:9735" };
  (autopilot as unknown as AutopilotSeams).channelSuggestions = async () => ({ suggestions: [peer] });
  (autopilot as unknown as AutopilotSeams).openFeeRate = async () => 2; // LND's economy estimate (the fake has none)
  let release = () => undefined as void;
  let dialing = false;
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (pk !== peer.pubkey) {
      if (!node.peers.includes(pk)) node.peers.push(pk);
      return cb(null, {});
    }
    dialing = true;
    let done = false;
    release = () => {
      if (done) return;
      done = true;
      node.peers.push(pk);
      cb(null, {});
    };
  });
  t.after(() => release());
  const run = autopilot.runOnce();
  for (let i = 0; i < 400 && !dialing; i++) await sleep(5);
  assert.ok(dialing, "the routing open passed its first look and is dialing");

  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted while the dial hangs");

  release();
  const done = await run;
  // A deferral is the channel stage's decision, not a failed run (D15).
  assert.deepEqual(done.channels, []);
  assert.match(autopilot.getState().decisions.channels?.text ?? "", /^deferred: only 548000 sat spendable after the reserve and 2000000 sat promised/);
  assert.equal(node.callsTo("default.openChannel").length, 0, "the buyer's coins stayed the buyer's");
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 1, "and the buyer's channel opens");
});

test("an LSPS1 settle that retries (LND busy) doesn't hold the on-chain mutex: the outpoint is recorded inside, the payment claimed after", async (t) => {
  quiet(t);
  t.mock.method(console, "error", () => undefined);
  const buyer = "02" + "ef".repeat(32);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 10_000_000, peers: [buyer] }) });
  const lsp = api.lsps1 as unknown as {
    orders: Lsps1Order[];
    fulfill(o: Lsps1Order): Promise<void>;
    lndOpen: () => Promise<unknown>;
    lndInvoice: () => Promise<{ is_held: boolean }>;
    lndSettle: () => Promise<void>;
    lndFeeRate: () => Promise<{ tokens_per_vbyte: number }>;
    settleRetryBaseMs: number;
  };
  lsp.lndOpen = async () => ({ ok: true, transactionId: "cc".repeat(32), transactionVout: 0 });
  lsp.lndInvoice = async () => ({ is_held: true });
  lsp.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
  lsp.settleRetryBaseMs = 25;
  let attempts = 0;
  lsp.lndSettle = async () => {
    attempts += 1;
    throw new Error("LND busy");
  };
  const order = lspOrder({ orderId: "lsp-slow-settle", peer: buyer, lspBalanceSat: 2_000_000 });
  lsp.orders.unshift(order);
  const fulfilled = lsp.fulfill(order);
  for (let i = 0; i < 400 && attempts === 0; i++) await sleep(5);
  assert.ok(attempts > 0, "settling");
  assert.equal(order.channel?.fundingOutpoint, `${"cc".repeat(32)}:0`, "the outpoint was recorded first");
  // Before: five settle attempts with 2+4+6+8+10 s of waits ran inside the
  // mutex — every Magma accept and open waited up to half a minute.
  assert.equal(api.capital.mutex.busy, false, "nobody holds the mutex while the settle retries");
  assert.equal(await within(500, api.capital.mutex.run("magma accept (test)", async () => "done"), "a Magma accept"), "done");
  await fulfilled;
  assert.equal(attempts, 5);
  assert.equal(order.orderState, "CREATED", "the payment stays held — restart recovery settles it, never a second open");
  assert.match(order.error ?? "", /settle failed/);
});

test("an order accepted while a manual open dials its peer: the open's own check, inside the mutex, refuses — the buyer's coins stay the buyer's", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 2_600_000 });
  const { api, magma } = await sellingApi(t, node);
  let release = () => undefined as void;
  let dialing = false;
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (pk !== OTHER_BUYER) {
      if (!node.peers.includes(pk)) node.peers.push(pk);
      return cb(null, {});
    }
    dialing = true;
    let done = false;
    release = () => {
      if (done) return;
      done = true;
      node.peers.push(pk);
      cb(null, {});
    };
  });
  t.after(() => release());
  const opening = api.request("POST", "/channels/open", { pubkey: OTHER_BUYER, socket: "5.6.7.8:9735", localTokens: 1_000_000 });
  for (let i = 0; i < 400 && !dialing; i++) await sleep(5);
  assert.ok(dialing, "nothing was promised yet: the open passed its first look and is dialing");

  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await api.autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted while the dial hangs");

  release();
  const res = await opening;
  assert.equal(res.status, 409, "checked again inside the mutex, with the promise in place");
  assert.equal(res.body.spendableSat, 548_000);
  assert.equal(node.callsTo("default.openChannel").length, 0);
});

test("an order found with no record here doesn't take, as its own, the channel an LSPS1 sale opened to the same buyer", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  const { api, magma } = await sellingApi(t, node);
  const lspTx = "cd".repeat(32);
  const expiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString();
  (api.lsps1 as unknown as { orders: Lsps1Order[] }).orders.unshift(
    lspOrder({
      orderId: "lsp-same-size",
      peer: BUYER,
      lspBalanceSat: 2_000_000,
      orderState: "COMPLETED",
      paymentState: "PAID",
      channel: { fundedAt: new Date().toISOString(), fundingOutpoint: `${lspTx}:0`, expiresAt },
    }),
  );
  node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: lspTx, transactionVout: 0 });
  // Accepted by 0.7.x (paid through its plain invoice), and waiting for its channel.
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
  node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${sale.id}`, paid: true });
  await api.autopilot.pollSellOrders();
  const e = api.autopilot.magma.journal.get(sale.id);
  // Before: the search for "a channel the old code opened for it" excluded
  // only Magma's channels — it reported LSPS1's to Amboss as this order's.
  assert.notEqual(e?.fundingOutpoint, `${lspTx}:0`);
  assert.equal(node.callsTo("default.openChannel").length, 1, "its own channel");
  assert.equal(e?.phase, "reported");
});

// ── a channel broadcast but not yet recorded is nobody's to adopt ────────────

/**
 * LND lists a fresh channel as pending the moment it has broadcast its
 * funding; the opener learns its outpoint (chan_pending) a moment later and
 * only then records it as its sale's. This makes every open take `delayMs`
 * for that, each with its own funding transaction (txids[0], txids[1], …).
 */
function slowChanPending(node: FakeLnd, txids: string[], delayMs: number): void {
  let n = 0;
  node.override("default.openChannel", (a: Record<string, unknown>) => {
    const s = Object.assign(new EventEmitter(), { cancel: () => undefined });
    const txid = txids[n++];
    setImmediate(() => {
      const amount = Number(a.local_funding_amount);
      node.chainBalance -= amount;
      node.pending.push({ partnerPublicKey: Buffer.from(a.node_pubkey as Buffer).toString("hex"), capacity: amount, transactionId: txid, transactionVout: 0 });
      setTimeout(() => s.emit("data", { update: "chan_pending", chan_pending: { txid: Buffer.from(txid, "hex").reverse(), output_index: 0 } }), delayMs);
    });
    return s;
  });
}

/** LSPS1's LND seams that these tests don't exercise: the payment is held,
 *  settling and refunding just count. */
function lspWithHeldPayment(api: Awaited<ReturnType<typeof startApi>>) {
  const lsp = api.lsps1 as unknown as {
    orders: Lsps1Order[];
    fulfill(o: Lsps1Order): Promise<void>;
    lndInvoice: () => Promise<{ is_held: boolean }>;
    lndSettle: () => Promise<void>;
    lndCancel: () => Promise<void>;
    lndFeeRate: () => Promise<{ tokens_per_vbyte: number }>;
  };
  const counts = { settles: 0, refunds: 0 };
  lsp.lndInvoice = async () => ({ is_held: true });
  lsp.lndSettle = async () => {
    counts.settles += 1;
  };
  lsp.lndCancel = async () => {
    counts.refunds += 1;
  };
  lsp.lndFeeRate = async () => ({ tokens_per_vbyte: 5 });
  return { lsp, counts };
}

async function untilListed(node: FakeLnd, txid: string): Promise<void> {
  for (let i = 0; i < 400 && !node.pending.some((p) => p.transactionId === txid); i++) await sleep(2);
  assert.ok(node.pending.some((p) => p.transactionId === txid), "the funding transaction is out and listed");
}

test("a Magma order whose open was unclear never takes the channel an LSPS1 open has broadcast but not yet recorded: its lookup waits for the on-chain mutex", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const { api, magma } = await sellingApi(t, node);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await api.autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  const desk = api.autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const realOpen = desk.lndOpen.bind(api.autopilot.magma);
  desk.lndOpen = async () => ({ ok: false, error: "FailedToOpenChannel: Connection dropped" });
  await api.autopilot.pollSellOrders();
  assert.equal(api.autopilot.magma.journal.get(sale.id)?.phase, "opening");
  desk.lndOpen = realOpen;

  // The same buyer bought a 1M channel over LSPS1; its open is broadcast,
  // and LSPS1 learns the outpoint 300 ms later.
  const lspTx = "ef".repeat(32);
  slowChanPending(node, [lspTx], 300);
  const { lsp } = lspWithHeldPayment(api);
  const order = lspOrder({ orderId: "lsp-in-flight", peer: BUYER, lspBalanceSat: 1_000_000 });
  lsp.orders.unshift(order);
  const fulfilling = lsp.fulfill(order);
  await untilListed(node, lspTx);

  // The order lane passes right then (every 45 s, whatever else is going on).
  await api.autopilot.pollSellOrders();
  await fulfilling;
  const e = api.autopilot.magma.journal.get(sale.id);
  // Before: Magma's lookup ran outside the mutex, found the channel nobody
  // had claimed yet, and reported it to Amboss — while LSPS1 settled its own
  // buyer's payment for the very same channel.
  assert.equal(order.channel?.fundingOutpoint, `${lspTx}:0`);
  assert.equal(order.orderState, "COMPLETED");
  assert.notEqual(e?.fundingOutpoint, `${lspTx}:0`, "one channel, one sale");
  assert.equal(e?.phase, "opening", "still waiting for LND to show its own channel");
  assert.equal(magma.count("AddTransaction"), 0);
});

test("an order found with no record here never takes the channel an LSPS1 open has broadcast but not yet recorded", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const { api, magma } = await sellingApi(t, node);
  const lspTx = "ef".repeat(32);
  const magmaTx = "fe".repeat(32);
  slowChanPending(node, [lspTx, magmaTx], 300);
  const { lsp } = lspWithHeldPayment(api);
  const order = lspOrder({ orderId: "lsp-in-flight", peer: BUYER, lspBalanceSat: 2_000_000 });
  lsp.orders.unshift(order);
  // Accepted by 0.7.x and paid through its plain invoice: no record here.
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, status: "WAITING_FOR_CHANNEL_OPEN", paymentStatus: "SUCCESSFUL_PAYMENT" });
  node.addPlainInvoice({ tokens: 12_345, description: `Magma order ${sale.id}`, paid: true });

  const fulfilling = lsp.fulfill(order);
  await untilListed(node, lspTx);
  await api.autopilot.pollSellOrders();
  await fulfilling;
  const e = api.autopilot.magma.journal.get(sale.id);
  // Before: the search for "the channel the old code opened for it" ran
  // outside the mutex and took LSPS1's, reporting it to Amboss as this order's.
  assert.equal(order.channel?.fundingOutpoint, `${lspTx}:0`);
  assert.equal(e?.fundingOutpoint, `${magmaTx}:0`, "a channel of its own");
  assert.deepEqual(
    magma.calls.filter((c) => c.op === "AddTransaction").map((c) => (c.variables.input as { tx_id: string }).tx_id),
    [`${magmaTx}:0`],
  );
});

test("an LSPS1 order whose open was unclear never takes the channel a Magma open has broadcast but not yet recorded", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const { api, magma } = await sellingApi(t, node);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });
  await api.autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  const { lsp, counts } = lspWithHeldPayment(api);
  // An LSPS1 order of the same size to the same buyer, whose own open just
  // had an unclear outcome: it looks for its channel in LND.
  const order = lspOrder({
    orderId: "lsp-unclear",
    peer: BUYER,
    lspBalanceSat: 1_000_000,
    opening: { startedAt: new Date().toISOString(), preExisting: [], unclear: "FailedToOpenChannel: Connection dropped" },
  });
  lsp.orders.unshift(order);

  const magmaTx = "fe".repeat(32);
  slowChanPending(node, [magmaTx], 300);
  const lane = api.autopilot.pollSellOrders(); // the Magma open
  await untilListed(node, magmaTx);
  await lsp.fulfill(order);
  await lane;
  // Before: LSPS1's lookup ran outside the mutex, adopted the Magma buyer's
  // channel and settled its own buyer's payment for it.
  assert.equal(api.autopilot.magma.journal.get(sale.id)?.fundingOutpoint, `${magmaTx}:0`);
  assert.equal(order.channel, null, "the Magma buyer's channel is not LSPS1's");
  assert.equal(order.orderState, "CREATED", "it waits for LND to show its own channel");
  assert.equal(counts.settles, 0);
  assert.equal(counts.refunds, 0);
});

test("LSPS1: LND not answering while an unclear open is looked for is no answer — no second open; the channel is found once LND answers", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const api = await startApi(t, { node });
  const { lsp, counts } = lspWithHeldPayment(api);
  let opens = 0;
  (lsp as unknown as { lndOpen: () => Promise<unknown> }).lndOpen = async () => {
    opens += 1;
    return { ok: true, transactionId: "aa".repeat(32), transactionVout: 0 };
  };
  // The open happened (its channel is pending in LND), but the process
  // stopped before recording it — long enough ago that LND had ample time.
  const tx = "cd".repeat(32);
  node.pending.push({ partnerPublicKey: BUYER, capacity: 1_000_000, transactionId: tx, transactionVout: 0 });
  const order = lspOrder({
    orderId: "lsp-restart",
    peer: BUYER,
    lspBalanceSat: 1_000_000,
    opening: { startedAt: new Date(Date.now() - OPENING_GRACE_MS - 60_000).toISOString(), preExisting: [] },
  });
  lsp.orders.unshift(order);
  // LND is still starting up: its answer about pending channels, as the
  // order looks for its channel, fails.
  node.failNext("default.pendingChannels", "server is still in the process of starting", () => api.capital.mutex.heldBy === "lsps1 reconcile");
  const asked = () => node.callsTo("default.pendingChannels").length;
  const before = asked();
  await lsp.fulfill(order);
  // Before: the failed lookup read as "no channel" — and with the grace
  // over, a second channel was opened for an order that had one.
  assert.ok(asked() > before, "LND was asked");
  assert.equal(opens, 0, "no second open");
  assert.equal(order.channel, null);
  assert.ok(order.opening, "still looking for its channel");

  await lsp.fulfill(order); // LND answers now
  const channelOf = (o: Lsps1Order) => o.channel; // (read afresh: fulfill moved it on)
  assert.equal(channelOf(order)?.fundingOutpoint, `${tx}:0`, "the channel it opened is found");
  assert.equal(opens, 0);
  assert.equal(counts.settles, 1);
  assert.equal(order.orderState, "COMPLETED");
});
