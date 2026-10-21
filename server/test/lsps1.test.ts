/**
 * LSP mode as a wallet meets it (review a4-lsp-payments:lsps1-rejects-zeus-
 * client-info, a4-lsp-payments:lsps1-order-robustness, a7-security:lsps1-
 * recovery-one-shot — package P5).
 *
 * Before:
 *  - ZEUS sends an informational `client_info` with every create_order. It
 *    was refused with -32602 and no `data.message` — ZEUS shows only that
 *    field, so the buyer saw a spinner stop, while the Settings card counted
 *    get_info requests and looked healthy. Not one ZEUS order could complete;
 *  - ZEUS's "3 months" (13,140 blocks) was above the 12,960-block maximum;
 *  - two abandoned quotes (ZEUS gives up after 7 s; pricing ran in the
 *    request path) refused the buyer for an hour;
 *  - a buyer offline after paying had ten tries a minute apart, then a refund
 *    — while its payment could stay held for hours (bLIP-51: wait for it);
 *  - restart recovery ran once: an order LND couldn't answer for at boot was
 *    never looked at again (a held payment neither opened nor refunded, its
 *    coins kept from the budget), logged as "[object Object]";
 *  - a settle LND refused five times was tried again only after a restart:
 *    a process that ran on until LND released the held payment gave the
 *    channel away — filed as "payment refunded";
 *  - orders that crossed passed the per-buyer and total caps; a payment that
 *    landed while its quote was replaced could start an open;
 *  - with less on chain than the smallest channel, every request for one
 *    (get_info's maximum is clamped up to the minimum) took a turn of the
 *    on-chain mutex and an LND read before it was refused — uncounted by the
 *    pace, since it made no order;
 *  - an open whose outcome was unclear could adopt another order's channel to
 *    the same buyer, of the same size.
 *
 * The wallet here speaks JSON-RPC over BOLT8 custom messages through the
 * real `lightning` library, against the fake LND (helpers/lsps.ts).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHodl, newHodlSecret, cancelHodl } from "../src/services/hodl.js";
import type { Lsps1Order } from "../src/services/lsps1.js";
import { stateAlerts } from "../src/services/alerts.js";
import { storeIncidents } from "../src/store.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { parsePaymentRequest } from "./helpers/bolt11.js";
import { BUYER, lspNode, lspsWallet, zeusOrder, type LspNode } from "./helpers/lsps.js";
import { feeEnv, quiet } from "./helpers/lifecycle.js";
import { makeTempDir } from "./helpers/tmp.js";
import { until } from "./helpers/wait.js";

const hashOf = (order: { payment: { bolt11: { invoice: string } } }): string => parsePaymentRequest(order.payment.bolt11.invoice).id;
const buyerN = (n: number) => "03" + n.toString(16).padStart(2, "0").repeat(32);
const view = (lsp: LspNode, id: string) => lsp.svc.orderViews().find((o) => o.orderId === id);

/** A buyer asking for something else than before — another channel size —
 *  so it is never answered with the quote it already has (n = 0 … 89). */
const sized = (n: number) => zeusOrder({ lsp_balance_sat: String(1_000_000 + n * 100_000) });

/** `ms` pass: every order on file that much older — the pace of asking
 *  again (a replaced quote at most once a minute, six orders an hour) goes
 *  by the orders' creation times — and the per-peer message budget (30 a
 *  minute) with them. */
function age(lsp: LspNode, ms: number): void {
  for (const o of lsp.seams.orders) o.createdAt = new Date(Date.parse(o.createdAt) - ms).toISOString();
  const budget = (lsp.svc as unknown as { rateWindow: Map<string, number[]> }).rateWindow;
  for (const [peer, times] of budget) budget.set(peer, times.map((at) => at - ms));
}

/** Turns of the on-chain mutex taken to make an order ("lsps1 order") —
 *  every Magma accept and open waits behind each one. */
function orderTurns(lsp: LspNode): () => number {
  let turns = 0;
  const mutex = lsp.capital.mutex;
  const run = mutex.run.bind(mutex);
  mutex.run = (<T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (label === "lsps1 order") turns += 1;
    return run(label, fn);
  }) as typeof mutex.run;
  return () => turns;
}

/** A paid order from a previous life of the process: its hold invoice made
 *  in LND (and, `paid`, its HTLC held there). */
async function storedOrder(node: FakeLnd, o: Partial<Lsps1Order> & { paid: boolean; sizeSat?: number }): Promise<Lsps1Order> {
  const { id, secret } = newHodlSecret();
  const orderId = o.orderId ?? `order-${id.slice(0, 8)}`;
  const { request } = await createHodl(node.lnd, {
    id,
    tokens: 20_000,
    description: `LSPS1 ${orderId}`,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    cltvDelta: 144,
  });
  if (o.paid) node.payHoldInvoice(id);
  const { paid: _paid, sizeSat, ...rest } = o;
  return {
    orderId,
    peer: BUYER,
    createdAt: new Date().toISOString(),
    lspBalanceSat: sizeSat ?? 2_000_000,
    clientBalanceSat: 0,
    requiredChannelConfirmations: 1,
    fundingConfirmsWithinBlocks: 6,
    channelExpiryBlocks: 4_320,
    token: "",
    announceChannel: false,
    orderState: "CREATED",
    paymentState: o.paid ? "HOLD" : "EXPECT_PAYMENT",
    feeTotalSat: 20_000,
    orderTotalSat: 20_000,
    invoice: request,
    invoiceId: id,
    invoiceSecret: secret,
    invoiceExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    channel: null,
    serviceFeePaidSat: 0,
    ...rest,
  };
}

function silence(t: TestContext): void {
  quiet(t);
  t.mock.method(console, "error", () => undefined);
}

// ── ZEUS, end to end ─────────────────────────────────────────────────────────

test("a ZEUS order goes through end to end over BOLT8: client_info accepted and ignored, the 3-month lease taken, the payment held until the channel is open, the 1% fee enqueued", async (t) => {
  feeEnv(t);
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const zeus = lspsWallet(lsp.node, lsp.buyer);

  const info = await zeus.call("lsps1.get_info", {});
  assert.equal(info.result?.max_channel_expiry_blocks, 13_140, "ZEUS's 3-month preset — and its default, the advertised maximum");

  const created = await zeus.call("lsps1.create_order", zeusOrder());
  // Before: {"code":-32602,"message":"unrecognized parameter","data":{"unrecognized":["client_info"]}}
  // — no data.message, and ZEUS shows nothing else.
  assert.equal(created.error, undefined, JSON.stringify(created.error));
  const order = created.result;
  assert.deepEqual([order.channel_expiry_blocks, order.lsp_balance_sat, order.payment.bolt11.state], [13_140, "1000000", "EXPECT_PAYMENT"]);
  const hash = hashOf(order);
  assert.equal(lsp.node.invoices.get(hash)?.cltvDelta, 144, "a paid HTLC may stay held about a day (LND's default before: 80 blocks on stock LND)");

  lsp.node.payHoldInvoice(hash);
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "the order completes");
  const [channel] = lsp.node.pending;
  assert.equal(channel.memo, `lsps1:${order.order_id}`, "the channel names its order in LND");
  assert.equal(channel.partnerPublicKey, lsp.buyer);
  assert.equal(lsp.node.invoices.get(hash)?.state, "SETTLED", "settled once the channel was funded");
  const polled = await zeus.call("lsps1.get_order", { order_id: order.order_id });
  assert.equal(polled.result.order_state, "COMPLETED");
  assert.equal(polled.result.payment.bolt11.state, "PAID");
  assert.equal(polled.result.channel.funding_outpoint, `${channel.transactionId}:0`);
  assert.deepEqual(
    lsp.fees.entries().map((e) => [e.key, e.source]),
    [[`lsps1:${order.order_id}`, "lsps1"]],
    "the disclosed 1% goes through the service-fee ledger",
  );

  // The Settings card: what each method was asked, and who asked.
  const status = await lsp.svc.status();
  assert.deepEqual(status.clients.map((c) => [c.app, c.version]), [["ZEUS", "v13.2.3"]]);
  assert.deepEqual(status.ignoredParams, [{ name: "client_info", count: 1 }]);
  assert.deepEqual(
    Object.fromEntries(status.requests.map((r) => [r.method, [r.served, r.errors.length]])),
    { "lsps1.get_info": [1, 0], "lsps1.create_order": [1, 0], "lsps1.get_order": [1, 0] },
  );
});

test("unknown parameters are accepted and ignored — named in the log once, counted — while the known ones are still checked strictly; every error says what is wrong in data.message", async (t) => {
  silence(t);
  const logged = t.mock.method(console, "log", () => undefined);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);

  assert.ok((await w.call("lsps1.get_info", { future_hint: true })).result, "get_info with an extra parameter");
  const ok = await w.call("lsps1.create_order", zeusOrder({ future_option: "x" }));
  assert.ok(ok.result?.order_id, JSON.stringify(ok));
  await w.call("lsps1.create_order", zeusOrder({ future_option: "y" }));
  const named = logged.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("ignoring parameter"));
  assert.deepEqual(named, [
    "[lsps1] lsps1.get_info: ignoring parameter(s) this LSP doesn't use: future_hint",
    "[lsps1] lsps1.create_order: ignoring parameter(s) this LSP doesn't use: client_info, future_option",
  ]);

  // Known parameters keep their checks — with the reason in data.message.
  const typed = await w.call("lsps1.create_order", zeusOrder({ channel_expiry_blocks: "13140" }));
  assert.equal(typed.error.code, -32602);
  assert.equal(typed.error.data.property, "channel_expiry_blocks");
  assert.equal(typed.error.data.message, "channel_expiry_blocks must be an unsigned integer");
  const announce = await w.call("lsps1.create_order", zeusOrder({ announce_channel: "no" }));
  assert.equal(announce.error.data.message, "announce_channel must be a boolean");

  const errors = [
    await w.raw("not json", null),
    await w.raw(JSON.stringify({ jsonrpc: "1.0", id: "r1", method: "lsps1.get_info" }), "r1"),
    await w.call("lsps1.get_order", ["by position"]),
    await w.call("lsps1.get_order", { order_id: "no-such-order" }),
    await w.call("lsps9.anything", {}),
  ];
  // Before: none of these carried data.message (ZEUS showed an empty error).
  assert.deepEqual(errors.map((e) => e.error.code), [-32700, -32600, -32602, 101, -32601]);
  for (const e of errors) assert.ok(typeof e.error.data?.message === "string" && e.error.data.message.length > 10, JSON.stringify(e));

  const status = await lsp.svc.status();
  assert.deepEqual(
    status.ignoredParams.map((p) => [p.name, p.count]).sort(),
    [["client_info", 4], ["future_hint", 1], ["future_option", 2]],
  );
  const co = status.requests.find((r) => r.method === "lsps1.create_order");
  assert.equal(co?.served, 2);
  assert.deepEqual(co?.errors.map((e) => [e.code, e.count, e.lastMessage]), [[-32602, 2, "announce_channel must be a boolean"]]);
  assert.deepEqual(status.requests.find((r) => r.method === "lsps1.get_order")?.errors.map((e) => [e.code, e.count]), [[-32602, 1], [101, 1]]);
  assert.deepEqual(status.requests.find((r) => r.method === "other")?.errors.map((e) => e.code).sort(), [-32700, -32601, -32600].sort());
  assert.equal(status.requestsServed, 3, "served: get_info and two orders");
});

/** What a name from a peer may look like once kept: no control characters,
 *  no escape sequences, no quotes (peerText). */
const SAFE_NAME = /^[\w .+:/?-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

test("ignored parameter names from a peer are bounded and made safe: twenty kept, each short, with no line breaks or escape sequences in the log", async (t) => {
  silence(t);
  const logged = t.mock.method(console, "log", () => undefined);
  const lsp = lspNode(t);
  lsp.svc.start();
  const odd = ["line\nbreak", "\u001b[31mred\u001b[0m", 'say "hi"', "x".repeat(200), "tab\there", "nul\u0000byte", "emoji 🙂", "back\\slash"];
  const extra = Object.fromEntries([...odd, ...Array.from({ length: 17 }, (_, i) => `extra_${i}`)].map((name) => [name, 1]));
  const res = await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", { ...zeusOrder(), ...extra });
  assert.ok(res.result?.order_id, JSON.stringify(res.error));
  // 26 names the LSP doesn't know (client_info and 25 more): any peer can
  // send any number of any names — kept in memory and shown in Settings.
  const { ignoredParams } = await lsp.svc.status();
  assert.equal(ignoredParams.length, 20, "bounded");
  for (const p of ignoredParams) {
    assert.ok(p.name.length <= 64, `${p.name.length} characters`);
    assert.match(p.name, SAFE_NAME);
  }
  assert.ok(ignoredParams.some((p) => p.name === "line?break") && ignoredParams.some((p) => p.name === "??31mred??0m"));
  const lines = logged.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("ignoring parameter"));
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], CONTROL, "a peer can't break or colour the log");
  assert.ok(lines[0].length < 20 * 66 + 100, `${lines[0].length} characters`);
});

test("the wallets that name themselves in client_info: ten kept, the latest first, each name short and made safe", async (t) => {
  silence(t);
  const logged = t.mock.method(console, "log", () => undefined);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const apps = Array.from({ length: 12 }, (_, i) => (i === 5 ? "Evil\u001b[2J\r\nWallet" : i === 7 ? "W".repeat(100) : `Wallet ${i}`));
  for (const [i, app] of apps.entries()) {
    const res = await w.call("lsps1.create_order", zeusOrder({ client_info: { app, app_version: `v1.${i}\n` } }));
    assert.ok(res.result?.order_id, JSON.stringify(res.error));
  }
  const { clients } = await lsp.svc.status();
  assert.equal(clients.length, 10, "bounded");
  assert.equal(clients[0].app, "Wallet 11", "the latest first");
  for (const c of clients) {
    assert.ok(c.app.length <= 40 && c.version.length <= 40, JSON.stringify(c));
    assert.match(c.app, SAFE_NAME);
    assert.doesNotMatch(c.version, CONTROL);
  }
  assert.ok(clients.some((c) => c.app === "Evil??2J??Wallet"));
  assert.ok(clients.some((c) => c.app === "W".repeat(40)));
  const named = logged.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("a wallet named itself"));
  assert.equal(named.length, 12);
  for (const l of named) assert.doesNotMatch(l, CONTROL);
});

test("lease length: ZEUS's 1- and 3-month presets are taken, 6 months is refused with option_mismatch saying the range", async (t) => {
  silence(t);
  const buyers = [buyerN(1), buyerN(2), buyerN(3)];
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 20_000_000, peers: buyers }) });
  lsp.svc.start();
  const [one, three, six] = await Promise.all(
    [4_380, 13_140, 26_280].map((blocks, i) => lspsWallet(lsp.node, buyers[i]).call("lsps1.create_order", zeusOrder({ channel_expiry_blocks: blocks }))),
  );
  assert.equal(one.result?.channel_expiry_blocks, 4_380);
  // Before: 100 option_mismatch "must be 1..12960" for ZEUS's "3 months".
  assert.equal(three.result?.channel_expiry_blocks, 13_140, JSON.stringify(three.error));
  assert.equal(six.error?.code, 100);
  assert.equal(six.error.data.message, "channel_expiry_blocks: this LSP leases channels for 1 to 13140 blocks (about 3 months)");
});

// An empty wallet, and one with less than the smallest channel (1M) to
// spend: 500,000 − 51,000 (the 50,000 sell reserve and a funding fee).
for (const [chainBalance, availableSat] of [
  [0, 0],
  [500_000, 449_000],
] as const) {
  test(`${chainBalance.toLocaleString("en")} sat on chain: get_info still answers (min = max, as the spec wants), but every create_order is refused at once with the reason — no invoice the buyer could pay, no turn of the on-chain mutex, one LND read for all of them`, async (t) => {
    silence(t);
    const buyers = [BUYER, buyerN(31), buyerN(32), buyerN(33)];
    const lsp = lspNode(t, { node: new FakeLnd({ chainBalance, peers: buyers }) });
    lsp.svc.start();
    const turns = orderTurns(lsp);
    const reads = lsp.node.callsTo("default.walletBalance").length;
    // Four connected peers ask for the 1M channel get_info allows, seven
    // times each, all at once.
    const answers = (
      await Promise.all(
        buyers.map(async (b) => {
          const w = lspsWallet(lsp.node, b);
          const mine = [];
          for (let i = 0; i < 7; i++) mine.push(await w.call("lsps1.create_order", zeusOrder()));
          return mine;
        }),
      )
    ).flat();
    assert.equal(answers.length, 28);
    for (const a of answers) {
      assert.deepEqual(
        [a.error?.code, a.error?.data.message],
        [1, `this LSP has no on-chain capital for a channel this size right now (${availableSat} sat available) — try a smaller channel or later`],
      );
    }
    assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 0, "no invoice the buyer could pay");
    // Before: get_info's maximum, clamped up to the 1M minimum, let each of
    // them through to a turn of the on-chain mutex — every Magma accept and
    // open waits behind it — and a fresh LND read, only to be refused in
    // there; making no order, they never counted against the pace (review:
    // 8 peers × 28 requests, 224 turns and 225 wallet reads in 180 ms).
    assert.equal(turns(), 0, "no turn of the on-chain mutex");
    assert.equal(lsp.node.callsTo("default.walletBalance").length - reads, 1, "one LND read for all of them: the first request's");
    const info = await lspsWallet(lsp.node, BUYER).call("lsps1.get_info", {});
    assert.deepEqual([info.result.min_initial_lsp_balance_sat, info.result.max_initial_lsp_balance_sat], ["1000000", "1000000"]);
  });
}

test("the first look refuses only what the check that decides would: exactly the coins a channel needs make an order; coins spent since the last read are refused inside the on-chain mutex, by a fresh read — which then refuses the next request at once", async (t) => {
  silence(t);
  // 1,051,000 on chain: 1,000,000 to spend once the 50,000 sell reserve and
  // the channel's funding fee are kept — exactly the channel.
  const exact = lspNode(t, { node: new FakeLnd({ chainBalance: 1_051_000, peers: [BUYER] }) });
  exact.svc.start();
  const made = await lspsWallet(exact.node, BUYER).call("lsps1.create_order", zeusOrder());
  assert.ok(made.result?.order_id, JSON.stringify(made.error));

  // 3,000,000 on chain when get_info read it; most of it then went to a
  // Magma open (or a send) before the buyer ordered.
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 3_000_000, peers: [BUYER, buyerN(35)] }) });
  lsp.svc.start();
  const turns = orderTurns(lsp);
  const w = lspsWallet(lsp.node, BUYER);
  assert.equal((await w.call("lsps1.get_info", {})).result.max_channel_balance_sat, "2949000");
  lsp.node.chainBalance = 500_000;
  const late = await w.call("lsps1.create_order", zeusOrder());
  assert.deepEqual(
    [late.error?.code, late.error?.data.message],
    [1, "this LSP has no on-chain capital for a channel this size right now (449000 sat available) — try a smaller channel or later"],
  );
  assert.equal(turns(), 1, "the last read let it on to the check inside the mutex");
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 0, "no quote on coins that are gone");
  // That check's read is the last read now.
  const next = await lspsWallet(lsp.node, buyerN(35)).call("lsps1.create_order", zeusOrder());
  assert.match(next.error?.data.message ?? "", /\(449000 sat available\)/);
  assert.equal(turns(), 1, "refused before the mutex");
});

test("orders that cross are counted again inside the on-chain mutex: two buyers at once, each asking for a channel that fits alone but not beside the other — one is made, the other refused for the coins, or for the deploy cap", async (t) => {
  silence(t);
  const buyers = [buyerN(36), buyerN(37)];
  const outcome = (answers: any[]) => answers.map((a) => a.error?.data.message ?? "made").sort();

  // 3,000,000 on chain: 1,500,000 fits once (2,949,000 to spend), not twice
  // (1,448,000 left beside the first: its coins, a second funding fee).
  const coins = lspNode(t, { node: new FakeLnd({ chainBalance: 3_000_000, peers: buyers }) });
  coins.svc.start();
  const coinTurns = orderTurns(coins);
  // Both pass the first look before either order is made.
  const byCoins = await Promise.all(buyers.map((b) => lspsWallet(coins.node, b).call("lsps1.create_order", sized(5))));
  assert.deepEqual(outcome(byCoins), [
    "made",
    "this LSP has no on-chain capital for a channel this size right now (1448000 sat available) — try a smaller channel or later",
  ]);
  assert.equal(coinTurns(), 2);
  assert.equal(coins.node.callsTo("invoices.addHoldInvoice").length, 1);

  // A 2,000,000 deploy cap, on a node with coins to spare: the same two.
  const cap = lspNode(t, {
    node: new FakeLnd({ chainBalance: 20_000_000, peers: buyers }),
    caps: { maxChannelSats: 10_000_000, reserveSats: 50_000, maxDeploySats: 2_000_000 },
  });
  cap.svc.start();
  const capTurns = orderTurns(cap);
  const byCap = await Promise.all(buyers.map((b) => lspsWallet(cap.node, b).call("lsps1.create_order", sized(5))));
  assert.deepEqual(outcome(byCap), ["made", "this LSP is at its capital deployment cap — try again later"]);
  assert.equal(capTurns(), 2);
  assert.equal(cap.node.callsTo("invoices.addHoldInvoice").length, 1);
});

// ── a buyer asking again ─────────────────────────────────────────────────────

test("a buyer at its two-order cap who asks for another channel a minute later gets a new order: its oldest unpaid quote is cancelled — and a buyer whose orders are paid is told to wait", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const a = (await w.call("lsps1.create_order", sized(0))).result;
  const b = (await w.call("lsps1.create_order", sized(1))).result;
  age(lsp, 61_000);
  const c = await w.call("lsps1.create_order", sized(2));
  // Before: 1 "too many open orders — pay or let them expire first", for the
  // invoices' hour — with ZEUS giving up on a slow answer, the usual case.
  assert.equal(c.error, undefined, JSON.stringify(c.error));
  assert.equal(view(lsp, a.order_id)?.orderState, "FAILED");
  assert.equal(view(lsp, a.order_id)?.superseded, true);
  assert.equal(lsp.node.invoices.get(hashOf(a))?.state, "CANCELED", "nothing can be paid to the replaced quote any more");
  assert.equal(lsp.node.invoices.get(hashOf(b))?.state, "OPEN", "the newer quote stays");
  const polled = await w.call("lsps1.get_order", { order_id: a.order_id });
  assert.equal(polled.result.order_state, "FAILED");

  // Both open orders paid (the buyer then went offline): a fourth request
  // replaces nothing.
  lsp.seams.lndConnect = async () => false;
  lsp.seams.openRetryDelayMs = 60_000;
  lsp.node.payHoldInvoice(hashOf(b));
  lsp.node.payHoldInvoice(hashOf(c.result));
  await until(() => lsp.svc.orderViews().filter((o) => o.paymentState === "HOLD").length === 2, "both held");
  age(lsp, 61_000);
  const d = await w.call("lsps1.create_order", sized(3));
  assert.equal(d.error?.code, 1);
  assert.equal(d.error.data.message, "you have paid orders here whose channels are still being opened — wait for them before ordering again");
  assert.equal(lsp.node.invoices.get(hashOf(b))?.state, "ACCEPTED", "a paid order is never cancelled to make room");
});

test("the quote a new order replaces doesn't count against it: with room for the new channel only once the old quote is gone, the order is made", async (t) => {
  silence(t);
  // 3,000,000 on chain: two 1M quotes leave 947,000 (reserve and funding
  // fees counted) — without the oldest one, 1,948,000.
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 3_000_000, peers: [BUYER] }) });
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const a = (await w.call("lsps1.create_order", sized(0))).result;
  await w.call("lsps1.create_order", zeusOrder({ channel_expiry_blocks: 4_380 }));
  age(lsp, 61_000);
  const reads = lsp.node.callsTo("default.walletBalance").length;
  const bigger = await w.call("lsps1.create_order", sized(5));
  assert.equal(bigger.error, undefined, JSON.stringify(bigger.error));
  assert.equal(bigger.result.lsp_balance_sat, "1500000");
  assert.equal(view(lsp, a.order_id)?.superseded, true);
  // Its first look took LND's balance as last read: one read, in the mutex.
  // (Before, every request replacing a quote read LND afresh outside it too.)
  assert.equal(lsp.node.callsTo("default.walletBalance").length - reads, 1);
});

test("ZEUS asking again with the same terms gets the quote it already has — the same order and invoice: no new invoice, no LND read, no turn of the on-chain mutex", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const turns = orderTurns(lsp);
  const w = lspsWallet(lsp.node, lsp.buyer);
  const first = (await w.call("lsps1.create_order", zeusOrder())).result;
  const reads = lsp.node.callsTo("default.walletBalance").length;
  // ZEUS gives up on an answer after 7 s; the buyer taps again — and again
  // (20 times: the peer's message budget is 30 a minute).
  const again = [];
  for (let i = 0; i < 20; i++) again.push(await w.call("lsps1.create_order", zeusOrder({ refund_onchain_address: "" })));
  for (const x of again) {
    assert.equal(x.result?.order_id, first.order_id, JSON.stringify(x.error));
    assert.equal(x.result.payment.bolt11.invoice, first.payment.bolt11.invoice);
  }
  // Before: a new hold invoice for each — and from the third on, the oldest
  // quote's invoice cancelled, a turn of the mutex and two wallet reads each
  // (PROBE-SPAM, 29 such requests in 165 ms: 29 invoices, 27 cancelled, 29
  // turns, 58 wallet-balance reads).
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 1);
  assert.equal(lsp.node.callsTo("invoices.cancelInvoice").length, 0);
  assert.equal(turns(), 1);
  assert.equal(lsp.node.callsTo("default.walletBalance").length, reads, "no LND read for a quote already made");
  assert.equal((await lsp.svc.status()).requests.find((r) => r.method === "lsps1.create_order")?.served, 21);

  // Other terms are another request: the buyer has room for one more order.
  const month = (await w.call("lsps1.create_order", zeusOrder({ channel_expiry_blocks: 4_380 }))).result;
  assert.notEqual(month.order_id, first.order_id);
  // Only the newest quote is handed out again: asking for the first one's
  // terms now is a new request — and a moment after the last one, refused.
  const back = await w.call("lsps1.create_order", zeusOrder());
  assert.deepEqual([back.error?.code, back.error?.data.message], [1, "you asked for a new quote a moment ago — pay it or try again in a minute"]);
  assert.equal((await w.call("lsps1.create_order", zeusOrder({ channel_expiry_blocks: 4_380 }))).result?.order_id, month.order_id);
  // A quote ten minutes old isn't handed out again: the request makes a new
  // order (replacing the oldest quote) — the invoice it gets has its hour.
  age(lsp, 10 * 60_000);
  const fresh = (await w.call("lsps1.create_order", zeusOrder({ channel_expiry_blocks: 4_380 }))).result;
  assert.ok(fresh && fresh.order_id !== month.order_id);
  assert.equal(view(lsp, first.order_id)?.superseded, true);
  // A paid quote is no quote to hand out: the same terms again are a new
  // request (a minute on: it replaces the oldest unpaid quote).
  lsp.seams.lndConnect = async () => false;
  lsp.seams.openRetryDelayMs = 60_000;
  lsp.node.payHoldInvoice(hashOf(fresh));
  await until(() => view(lsp, fresh.order_id)?.paymentState === "HOLD", "paid");
  age(lsp, 61_000);
  const paidAgain = (await w.call("lsps1.create_order", zeusOrder({ channel_expiry_blocks: 4_380 }))).result;
  assert.ok(paidAgain && paidAgain.order_id !== fresh.order_id);
  assert.equal(view(lsp, month.order_id)?.superseded, true);
  assert.equal(view(lsp, fresh.order_id)?.paymentState, "HOLD", "the paid one stays");
});

test("asking again with one term changed is another request: announcing the channel, other confirmations, another funding target or another token gets a new order with that term — never the quote made for the old terms; a client balance is still refused", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  // Each request changes one term of the one before, so the quote it must
  // not get back is the buyer's newest, a minute old (well inside the ten
  // minutes a same-terms request is answered with it).
  const changes: [string, Record<string, unknown>][] = [
    ["announce_channel", { announce_channel: true }],
    ["required_channel_confirmations", { required_channel_confirmations: 2 }],
    ["funding_confirms_within_blocks", { funding_confirms_within_blocks: 12 }],
    ["token", { token: "spring" }],
  ];
  let terms = zeusOrder();
  let last = (await w.call("lsps1.create_order", terms)).result;
  for (const [name, change] of changes) {
    terms = { ...terms, ...change };
    age(lsp, 61_000); // at its cap, the buyer replaces a quote once a minute
    const next = await w.call("lsps1.create_order", terms);
    assert.ok(next.result?.order_id, `${name}: ${JSON.stringify(next.error)}`);
    // Answered with the old quote, the buyer would pay for what it didn't ask
    // for: a private channel when it asked to announce one, say.
    assert.notEqual(next.result.order_id, last.order_id, `${name}: a new order, not the quote for the old terms`);
    assert.notEqual(next.result.payment.bolt11.invoice, last.payment.bolt11.invoice, `${name}: a new invoice`);
    assert.equal(next.result[name], change[name], `${name}: the order has the term asked for`);
    last = next.result;
  }
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 5);
  assert.equal(lsp.seams.orders.filter((o) => o.supersededBy).length, 3, "at its cap, each one replaced the oldest quote");

  // A client balance is no term this LSP offers: option_mismatch, as before
  // — not the quote made without one.
  age(lsp, 61_000);
  const pushed = await w.call("lsps1.create_order", { ...terms, client_balance_sat: "5000" });
  assert.deepEqual(
    [pushed.error?.code, pushed.error?.data.message],
    [100, "client_balance_sat: a client balance is not supported (max 0)"],
    JSON.stringify(pushed.result?.order_id),
  );
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 5);
  assert.equal(lsp.seams.orders.filter((o) => o.supersededBy).length, 3, "nothing replaced for a refused request");
});

test("a quote being replaced is never handed out: asked for again while another request of its buyer replaces it, its invoice — about to be cancelled — is not the answer", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  // A paid order whose open waits for its buyer to come back online, and
  // the buyer's one unpaid quote beside it: at its cap, the buyer's next
  // request for something else replaces that quote, its newest.
  lsp.seams.lndConnect = async () => false;
  lsp.seams.openRetryDelayMs = 60_000;
  const paid = (await w.call("lsps1.create_order", sized(0))).result;
  lsp.node.payHoldInvoice(hashOf(paid));
  await until(() => view(lsp, paid.order_id)?.paymentState === "HOLD", "paid");
  const quote = (await w.call("lsps1.create_order", sized(1))).result;
  age(lsp, 61_000);

  // Replacing it, LND is asked how the quote's invoice stands — and takes
  // its time to answer.
  const lookup = lsp.seams.lndInvoice.bind(lsp.svc);
  let answer!: () => void;
  const answered = new Promise<void>((r) => (answer = r));
  t.after(() => answer());
  let asked!: () => void;
  const lookedAt = new Promise<void>((r) => (asked = r));
  lsp.seams.lndInvoice = async (id: string) => {
    if (id === hashOf(quote)) {
      asked();
      await answered;
    }
    return lookup(id);
  };
  const replacing = w.call("lsps1.create_order", sized(2));
  await Promise.race([
    lookedAt,
    replacing.then((r) => assert.fail(`answered before the quote was looked at: ${JSON.stringify(r)}`)),
  ]);
  // Meanwhile the wallet asks for the quote's terms again (it gave up
  // waiting for its first answer).
  const again = await w.call("lsps1.create_order", sized(1));
  assert.notEqual(again.result?.order_id, quote.order_id, "not the quote that is being cancelled");
  assert.deepEqual(
    [again.error?.code, again.error?.data.message],
    [1, "you have paid orders here whose channels are still being opened — wait for them before ordering again"],
  );

  answer();
  const made = (await replacing).result;
  assert.ok(made?.order_id);
  assert.equal(view(lsp, quote.order_id)?.superseded, true);
  // Handed out, this invoice would have taken a payment it can't any more.
  assert.equal(lsp.node.invoices.get(hashOf(quote))?.state, "CANCELED");
  assert.equal(view(lsp, paid.order_id)?.paymentState, "HOLD", "the paid order stays");
});

test("the same terms as a paid order — even one no open is under way for, as after a restart before recovery — get a new quote, never the paid order", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const paid = await storedOrder(node, { orderId: "paid-1", paid: true, sizeSat: 1_000_000, channelExpiryBlocks: 13_140 });
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([paid]));
  const lsp = lspNode(t, { dir, node, lspMode: false }); // not started: no recovery has picked it up
  const create = (lsp.svc as unknown as { createOrder(rid: number, peer: string, p: Record<string, unknown>): Promise<{ result?: { order_id: string } }> }).createOrder.bind(lsp.svc);
  const res = await create(1, BUYER, zeusOrder());
  assert.ok(res.result?.order_id, JSON.stringify(res));
  assert.notEqual(res.result.order_id, "paid-1", "a paid order is no quote to pay");
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 2, "a new invoice beside the paid one");
});

test("a buyer at its cap asking for other channels again and again: one replaced quote a minute, six orders an hour — every other request refused at once, with no invoice, no LND read and no turn of the on-chain mutex", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const turns = orderTurns(lsp);
  const w = lspsWallet(lsp.node, lsp.buyer);
  const answers = [];
  for (let n = 0; n < 2; n++) answers.push(await w.call("lsps1.create_order", sized(n)));
  const reads = lsp.node.callsTo("default.walletBalance").length;
  for (let n = 2; n < 29; n++) answers.push(await w.call("lsps1.create_order", sized(n)));
  // Before (PROBE-SPAM, 29 requests in 165 ms): all 29 answered — 29 hold
  // invoices made and 27 cancelled, 29 turns of the mutex, 58 wallet reads.
  assert.equal(answers.filter((a) => a.result).length, 2);
  for (const a of answers.slice(2)) {
    assert.deepEqual([a.error?.code, a.error?.data.message], [1, "you asked for a new quote a moment ago — pay it or try again in a minute"]);
  }
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 2);
  assert.equal(lsp.node.callsTo("invoices.cancelInvoice").length, 0);
  assert.equal(turns(), 2);
  assert.equal(lsp.node.callsTo("default.walletBalance").length, reads, "a refused request reads nothing from LND");

  // A minute on, the next request replaces the oldest unpaid quote — the
  // one-hour lockout stays fixed — and so on, up to six orders in the hour.
  for (let n = 30; n < 34; n++) {
    age(lsp, 61_000);
    const x = await w.call("lsps1.create_order", sized(n));
    assert.equal(x.error, undefined, JSON.stringify(x.error));
  }
  assert.equal(lsp.seams.orders.filter((o) => o.supersededBy).length, 4);
  assert.equal(lsp.seams.orders.filter((o) => o.orderState === "CREATED").length, 2);
  age(lsp, 61_000);
  const seventh = await w.call("lsps1.create_order", sized(40));
  assert.deepEqual(
    [seventh.error?.code, seventh.error?.data.message],
    [1, "you asked for 6 new quotes within the hour — pay the one you have, or try again later"],
  );
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 6);
  // The quote it has is still handed out.
  assert.ok((await w.call("lsps1.create_order", sized(33))).result?.order_id);
  // An hour on, it may ask again.
  age(lsp, 3_600_000);
  assert.ok((await w.call("lsps1.create_order", sized(41))).result?.order_id);
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 7);
});

test("a quote that turns out paid at the moment it would be replaced stays — and the new order is refused", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const a = (await w.call("lsps1.create_order", sized(0))).result;
  await w.call("lsps1.create_order", sized(1));
  age(lsp, 61_000);
  // The payment reached LND, but the invoice watch hasn't said so yet.
  const order = lsp.seams.orders.find((o) => o.orderId === a.order_id) as Lsps1Order;
  lsp.seams.lndConnect = async () => false;
  lsp.seams.openRetryDelayMs = 60_000;
  const watch = (lsp.svc as unknown as { invoiceSubs: Map<string, { removeAllListeners(): void }> }).invoiceSubs;
  watch.get(order.invoiceId)?.removeAllListeners();
  lsp.node.payHoldInvoice(hashOf(a));
  assert.equal(order.paymentState, "EXPECT_PAYMENT", "the record still says unpaid");
  const c = await w.call("lsps1.create_order", sized(2));
  assert.equal(c.error?.code, 1);
  assert.match(c.error.data.message, /your earlier order was just paid/);
  assert.equal(lsp.node.invoices.get(hashOf(a))?.state, "ACCEPTED", "the buyer's payment is not cancelled");
  assert.equal(order.orderState, "CREATED");
});

test("a quote LND won't cancel right now is not replaced: the buyer is told to try again — no second invoice beside it", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const a = (await w.call("lsps1.create_order", sized(0))).result;
  await w.call("lsps1.create_order", sized(1));
  age(lsp, 61_000);
  lsp.seams.lndCancel = async () => {
    throw [503, "UnexpectedErrorCancelingHodlInvoice", { err: { details: "Connection dropped" } }];
  };
  const invoices = lsp.node.callsTo("invoices.addHoldInvoice").length;
  const c = await w.call("lsps1.create_order", sized(2));
  assert.equal(c.error?.code, 1);
  assert.equal(c.error.data.message, "this LSP could not cancel your earlier unpaid order right now — try again in a minute");
  assert.equal(view(lsp, a.order_id)?.orderState, "CREATED", "the quote stays as it is");
  assert.equal(lsp.node.invoices.get(hashOf(a))?.state, "OPEN");
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, invoices, "no new invoice");
});

test("orders that cross keep the caps and the pace: a buyer at its cap asking for four other channels at once gets one — its oldest unpaid quote replaced — and is told to wait for the rest; new buyers at once never pass the total", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const a = (await w.call("lsps1.create_order", sized(0))).result;
  const b = (await w.call("lsps1.create_order", sized(1))).result;
  age(lsp, 2 * 60_000);
  // All four pass the first look, outside the mutex (each picks the same
  // oldest quote); inside it, one after the other, the count is made again.
  const answers = await Promise.all([2, 3, 4, 5].map((n) => w.call("lsps1.create_order", sized(n))));
  const made = answers.filter((x) => x.result);
  assert.equal(made.length, 1, JSON.stringify(answers.map((x) => x.error?.data?.message ?? "made")));
  for (const x of answers.filter((y) => y.error)) {
    assert.deepEqual([x.error.code, x.error.data.message], [1, "you asked for a new quote a moment ago — pay it or try again in a minute"]);
  }
  // Before the count inside the mutex: the first replaced the oldest quote
  // and the other three made orders beside it — five open orders for one
  // buyer (cap: two).
  const mine = lsp.seams.orders.filter((o) => o.peer === BUYER);
  assert.deepEqual(
    mine.filter((o) => o.orderState === "CREATED").map((o) => o.orderId).sort(),
    [b.order_id, made[0].result.order_id].sort(),
  );
  assert.deepEqual(mine.filter((o) => o.orderState === "FAILED").map((o) => [o.orderId, o.supersededBy]), [[a.order_id, made[0].result.order_id]]);
  assert.equal(lsp.node.invoices.get(hashOf(a))?.state, "CANCELED", "a replaced quote can't be paid any more");
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 3);

  // Ten open orders in all at most: eight, then four new buyers at once.
  const buyers = Array.from({ length: 12 }, (_, i) => buyerN(40 + i));
  const many = lspNode(t, { node: new FakeLnd({ chainBalance: 30_000_000, peers: buyers }) });
  many.svc.start();
  for (const b of buyers.slice(0, 8)) assert.ok((await lspsWallet(many.node, b).call("lsps1.create_order", zeusOrder())).result);
  const crossing = await Promise.all(buyers.slice(8).map((b) => lspsWallet(many.node, b).call("lsps1.create_order", zeusOrder())));
  assert.equal(crossing.filter((a) => a.result).length, 2);
  for (const a of crossing.filter((x) => x.error)) {
    assert.deepEqual([a.error.code, a.error.data.message], [1, "this LSP has too many open orders right now — try again later"]);
  }
  assert.equal(many.seams.orders.filter((o) => o.orderState === "CREATED").length, 10);
});

test("the same request crossing itself makes one quote: two at once from a buyer with none get the same order", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const turns = orderTurns(lsp);
  const w = lspsWallet(lsp.node, lsp.buyer);
  const [x, y] = await Promise.all([w.call("lsps1.create_order", zeusOrder()), w.call("lsps1.create_order", zeusOrder())]);
  assert.ok(x.result?.order_id, JSON.stringify(x.error));
  // Both passed the first look before either was made; inside the mutex the
  // second found the first one's quote.
  assert.equal(turns(), 2);
  assert.equal(y.result?.order_id, x.result.order_id);
  assert.equal(lsp.node.callsTo("invoices.addHoldInvoice").length, 1);
  assert.equal(lsp.seams.orders.length, 1);
});

test("a payment that lands while its quote is being replaced opens no channel: the quote is cancelled — the payment goes back — and its buyer isn't even dialed", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const a = (await w.call("lsps1.create_order", sized(0))).result;
  await w.call("lsps1.create_order", sized(1));
  age(lsp, 61_000);
  const aHash = hashOf(a);
  let dials = 0;
  lsp.seams.lndConnect = async () => {
    dials += 1;
    return true;
  };
  const lookup = lsp.seams.lndInvoice.bind(lsp.svc);
  let armed = true;
  lsp.seams.lndInvoice = async (id: string) => {
    const inv = await lookup(id);
    if (armed && id === aHash) {
      armed = false;
      // Replacing the quote, LND said "unpaid" — and right then the
      // buyer's payment of it arrives and is held.
      lsp.node.payHoldInvoice(aHash);
      await new Promise((r) => setTimeout(r, 100)); // the invoice watch sees it held
    }
    return inv;
  };
  const c = await w.call("lsps1.create_order", sized(2));
  assert.ok(c.result?.order_id, JSON.stringify(c.error));
  await new Promise((r) => setTimeout(r, 200));
  const old = lsp.seams.orders.find((o) => o.orderId === a.order_id) as Lsps1Order;
  assert.deepEqual([old.orderState, old.paymentState, old.supersededBy, old.channel], ["FAILED", "REFUNDED", c.result.order_id, null]);
  assert.equal(lsp.node.invoices.get(aHash)?.state, "CANCELED", "the payment went back to the buyer");
  // Without the quote kept off the open path while it is replaced, the open
  // started at once: its buyer dialed, and a channel opened for a payment
  // the cancel then sent back.
  assert.equal(dials, 0, "the quote being replaced is kept off the open path");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 0, "no channel for a payment that went back");
});

test("get_info works from LND's balance as last read — and reads it again after an open of its own: it never offers the coins a channel just took", async (t) => {
  silence(t);
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 3_000_000, peers: [BUYER] }) });
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  // 3,000,000 − 51,000 (the 50,000 sell reserve and a funding fee).
  assert.equal((await w.call("lsps1.get_info", {})).result.max_channel_balance_sat, "2949000");
  const reads = lsp.node.callsTo("default.walletBalance").length;
  assert.equal((await w.call("lsps1.get_info", {})).result.max_channel_balance_sat, "2949000");
  assert.equal(lsp.node.callsTo("default.walletBalance").length, reads, "the second from the read before");
  const order = (await w.call("lsps1.create_order", zeusOrder())).result;
  lsp.node.payHoldInvoice(hashOf(order));
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "opened");
  // The order's reservation ended with the open; the balance read before it
  // still held the 1,000,000 the channel took.
  assert.equal((await w.call("lsps1.get_info", {})).result.max_channel_balance_sat, "1949000");
});

// ── pricing off the request path ─────────────────────────────────────────────

test("create_order doesn't wait for the market: with no price yet it quotes the local profit floor after a short wait; a price up to 15 minutes old answers at once while it is refreshed behind", async (t) => {
  silence(t);
  const buyers = [buyerN(11), buyerN(12), buyerN(13)];
  const lsp = lspNode(t, { node: new FakeLnd({ chainBalance: 20_000_000, peers: buyers }) });
  let reads = 0;
  let answer = (): void => undefined;
  const report = {
    sell: {
      recommendations: [{ recommended: { effectiveFeePpm: 40_000, minBlockLength: 4_320 } }],
      recommendedMinLeasePpmPerYear: 10_000,
      onchainOpenCostSat: 1_000,
      onchainCloseCostSat: 1_000,
    },
  };
  // A market read that takes as long as the test says (Amboss over Tor, slow).
  lsp.seams.marketReport = () => {
    reads += 1;
    return new Promise((resolve) => (answer = () => resolve(report)));
  };
  lsp.seams.pricingWaitMs = 150;
  lsp.svc.start(); // LSP mode on: the price is read in the background at once

  const started = Date.now();
  const first = await lspsWallet(lsp.node, buyers[0]).call("lsps1.create_order", zeusOrder(), 5_000);
  // Before: the request waited for the engine's Amboss reads (ZEUS gives up at 7 s).
  assert.ok(Date.now() - started < 2_000, `answered in ${Date.now() - started} ms`);
  assert.ok(first.result?.order_id, JSON.stringify(first));
  const floorFee = Number(first.result.payment.bolt11.fee_total_sat);
  assert.equal(reads, 1, "one market read, shared — started when LSP mode came on");

  answer(); // the market answers: the next order is priced at it
  await until(() => !!lsp.seams.pricingCache && reads === 1, "the price is in");
  const second = await lspsWallet(lsp.node, buyers[1]).call("lsps1.create_order", zeusOrder());
  const marketFee = Number(second.result.payment.bolt11.fee_total_sat);
  assert.ok(marketFee > floorFee, `market ${marketFee} > floor ${floorFee}`);

  // Five minutes old: used as it is, refreshed behind the answer.
  (lsp.seams.pricingCache as { at: number }).at -= 5 * 60_000;
  const t0 = Date.now();
  const third = await lspsWallet(lsp.node, buyers[2]).call("lsps1.create_order", zeusOrder(), 5_000);
  assert.ok(Date.now() - t0 < 1_000);
  assert.equal(Number(third.result.payment.bolt11.fee_total_sat), marketFee);
  assert.equal(reads, 2, "and a refresh started behind it");
  answer();
});

test("get_info readies the price for the order that follows it", async (t) => {
  silence(t);
  const lsp = lspNode(t, { lspMode: false });
  let reads = 0;
  lsp.seams.marketReport = async () => {
    reads += 1;
    throw new Error("Amboss unreachable");
  };
  lsp.settings.set({ lspModeEnabled: true });
  (lsp.svc as unknown as { applySettings(): void }).applySettings();
  await until(() => reads === 1 && !!lsp.seams.pricingCache, "the read at switch-on (the market failed: the local floor)");
  (lsp.seams.pricingCache as { at: number }).at -= 2 * 60_000; // no longer fresh
  await lspsWallet(lsp.node, lsp.buyer).call("lsps1.get_info", {});
  await until(() => reads === 2, "get_info refreshed it");
  await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder());
  assert.equal(reads, 2, "the order used the price get_info had read");
});

// ── a buyer offline after paying ─────────────────────────────────────────────

test("a paid order whose buyer went offline waits for it — past the old ten tries — and opens as soon as the buyer is back (its next message), within the held payment's deadline", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const order = (await w.call("lsps1.create_order", zeusOrder())).result;
  let online = false;
  let dials = 0;
  lsp.seams.lndConnect = async () => {
    dials += 1;
    return online;
  };
  lsp.seams.openRetryDelayMs = 2;
  lsp.node.payHoldInvoice(hashOf(order));
  await until(() => dials >= 15, "15 tries");
  // Before: refunded after the 10th ("couldn't connect").
  const waiting = view(lsp, order.order_id);
  assert.deepEqual([waiting?.orderState, waiting?.paymentState], ["CREATED", "HOLD"]);
  assert.ok(waiting?.waitingForBuyerSince, "on record: waiting for the buyer");
  assert.match(waiting?.error ?? "", /^the buyer is offline — its payment stays held/);
  assert.equal(lsp.node.invoices.get(hashOf(order))?.state, "ACCEPTED", "not refunded");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 0);

  // Next check in a minute — but the buyer's wallet asks for its order first.
  lsp.seams.openRetryDelayMs = 60_000;
  const tried = dials;
  await until(() => dials > tried, "one more try, after which the open waits a minute");
  await new Promise((r) => setTimeout(r, 50));
  const waiters = (lsp.svc as unknown as { peerWaiters: Map<string, unknown> }).peerWaiters;
  assert.ok(waiters.has(lsp.buyer), "the open is waiting");
  const triesBefore = dials;
  online = true;
  const asked = Date.now();
  await w.call("lsps1.get_order", { order_id: order.order_id });
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "opened right after the buyer's message", 5_000);
  assert.ok(Date.now() - asked < 5_000, "not at the next check, a minute later");
  assert.equal(dials, triesBefore + 1, "one dial: the buyer's message woke the open");
  assert.equal(view(lsp, order.order_id)?.waitingForBuyerSince, undefined);
  assert.equal(view(lsp, order.order_id)?.error, undefined);
});

test("the wait ends before the held payment's HTLC would expire: refunded, never an open the payment can't outlive", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const order = (await w.call("lsps1.create_order", zeusOrder())).result;
  let dials = 0;
  lsp.seams.lndConnect = async () => {
    dials += 1;
    return false;
  };
  lsp.seams.openRetryDelayMs = 2;
  const tip = lsp.node.blockHeight;
  lsp.node.payHoldInvoice(hashOf(order), { expiryHeight: tip + 40 }); // a sender that gave little room
  await until(() => dials >= 3, "it waits while 40 blocks are left");
  assert.equal(view(lsp, order.order_id)?.orderState, "CREATED");
  lsp.node.blockHeight = tip + 11; // 29 left: below the 24-block release margin + 6 for the open
  await until(() => view(lsp, order.order_id)?.orderState === "FAILED", "released");
  const failed = view(lsp, order.order_id);
  assert.equal(failed?.paymentState, "REFUNDED");
  assert.equal(
    failed?.error,
    "the buyer did not come back online before its held payment had to be released (29 blocks left, 30 needed for the open)",
  );
  assert.equal(lsp.node.invoices.get(hashOf(order))?.state, "CANCELED", "the buyer gets the payment back");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 0);
});

test("a held payment whose HTLC expiry LND doesn't name is waited for at most 6 hours after it was paid — then refunded, never opened late", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const order = await storedOrder(node, {
    orderId: "held-long",
    paid: true,
    heldAt: new Date(Date.now() - 7 * 3_600_000).toISOString(),
    waitingForBuyerSince: new Date(Date.now() - 6.5 * 3_600_000).toISOString(),
  });
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([order]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  // LND reports the payment held, but not its HTLC — no expiry height.
  const lookup = lsp.seams.lndInvoice.bind(lsp.svc);
  lsp.seams.lndInvoice = async (id: string) => ({ ...(await lookup(id) as object), payments: [] });
  let dials = 0;
  lsp.seams.lndConnect = async () => {
    dials += 1;
    return true; // the buyer is back — too late
  };
  await lsp.seams.recoverOrders();
  const v = view(lsp, "held-long");
  assert.deepEqual([v?.orderState, v?.paymentState], ["FAILED", "REFUNDED"]);
  assert.equal(v?.error, "the buyer did not come back online before its held payment had to be released (6 h after it was paid)");
  assert.equal(node.invoices.get(order.invoiceId)?.state, "CANCELED");
  // An open the payment might not outlive would give the channel away.
  assert.equal(dials, 0);
  assert.equal(node.callsTo("default.openChannel").length, 0);
});

test("a held payment LND no longer holds ends the wait for an offline buyer at once — refunded, never opened — even when the invoice watch missed it", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const hash = hashOf(order);
  let dials = 0;
  lsp.seams.lndConnect = async () => {
    dials += 1;
    return false;
  };
  lsp.seams.openRetryDelayMs = 2;
  lsp.node.payHoldInvoice(hash);
  await until(() => dials >= 3, "it waits for the buyer");
  // The watch broke (LND restarted, say) just as LND released the HTLC.
  (lsp.seams.invoiceSubs.get(hash) as { removeAllListeners(): void }).removeAllListeners();
  lsp.node.expireHoldInvoice(hash);
  await until(() => view(lsp, order.order_id)?.orderState === "FAILED", "the wait ends");
  const v = view(lsp, order.order_id);
  assert.deepEqual([v?.paymentState, v?.error], ["REFUNDED", "payment no longer held"]);
  assert.equal(lsp.node.callsTo("default.openChannel").length, 0);
});

test("an unpaid order whose invoice LND can't follow yet is looked at again until it can — and paid then, it opens", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const unpaid = await storedOrder(node, { orderId: "unpaid-w", paid: false, sizeSat: 1_000_000 });
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([unpaid]));
  // LND's invoices subserver isn't ready yet: following an invoice fails.
  const invoices = (node.lnd as unknown as { invoices: { subscribeSingleInvoice: (a: Record<string, unknown>) => unknown } }).invoices;
  const follow = invoices.subscribeSingleInvoice;
  let ready = false;
  node.override("invoices.subscribeSingleInvoice", ((a: Record<string, unknown>) => {
    if (!ready) throw new Error("the invoices subserver is not ready");
    return follow(a);
  }) as never);
  const lsp = lspNode(t, { dir, node, lspMode: false });
  lsp.seams.recoveryRetryMinMs = 20;
  lsp.seams.recoveryRetryMs = 20;
  await lsp.seams.recoverOrders();
  assert.equal(lsp.seams.invoiceSubs.has(unpaid.invoiceId), false);
  assert.equal((await lsp.svc.status()).recovery.waiting, 1, "it waits on LND — tried again");
  ready = true;
  await until(() => lsp.seams.invoiceSubs.has(unpaid.invoiceId), "followed on a later pass");
  node.payHoldInvoice(unpaid.invoiceId);
  await until(() => view(lsp, "unpaid-w")?.orderState === "COMPLETED", "paid now, it opens");
});

test("an order that ends while its open waits for the on-chain mutex is not opened — whoever ended it has seen to its payment", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.svc.start();
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  let dialed = false;
  lsp.seams.lndConnect = async () => {
    dialed = true;
    return true;
  };
  // Another open holds the mutex (a Magma open, say) …
  let release = (): void => undefined;
  const held = lsp.capital.mutex.run("magma open (test)", () => new Promise<void>((r) => (release = r)));
  lsp.node.payHoldInvoice(hashOf(order));
  await until(() => dialed, "the buyer is connected: the open waits for the mutex");
  await new Promise((r) => setTimeout(r, 20));
  // … while LND releases the payment (its HTLC near expiry, say).
  lsp.node.expireHoldInvoice(hashOf(order));
  await until(() => view(lsp, order.order_id)?.orderState === "FAILED", "the invoice watch ends the order");
  release();
  await held;
  await new Promise((r) => setTimeout(r, 100));
  // Before: the open went ahead for the ended order — a channel nobody paid for.
  assert.equal(lsp.node.callsTo("default.openChannel").length, 0);
  const v = view(lsp, order.order_id);
  assert.deepEqual([v?.orderState, v?.paymentState, v?.fundingOutpoint], ["FAILED", "REFUNDED", null]);
});

// ── restart recovery ─────────────────────────────────────────────────────────

test("restart recovery keeps trying until LND answers: a held order opens and settles, an unpaid one is watched again, the promised coins are released — and the log says what LND said", async (t) => {
  silence(t);
  const warned = t.mock.method(console, "warn", () => undefined);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const held = await storedOrder(node, { orderId: "held-1", paid: true });
  const unpaid = await storedOrder(node, { orderId: "unpaid-1", paid: false, sizeSat: 1_000_000 });
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([held, unpaid]));
  // Umbrel starts the app while LND is still unlocking.
  let ready = false;
  for (let i = 0; i < 500; i++) node.failNext("default.lookupInvoice", "server is still in the process of starting", () => !ready);
  const lsp = lspNode(t, { dir, node, lspMode: false }); // held payments resolve with LSP mode off too
  lsp.seams.recoveryRetryMinMs = 20;
  lsp.seams.recoveryRetryMs = 20;
  lsp.svc.start();
  await until(() => node.callsTo("default.lookupInvoice").length >= 6, "tried again while LND starts");
  assert.equal(lsp.capital.reservedSat(), 2_000_000, "the paid order's coins stay promised meanwhile");
  const waiting = await lsp.svc.status();
  assert.deepEqual([waiting.recovery.waiting, waiting.recovery.refunds, waiting.recovery.settles], [2, 0, 0]);
  assert.match(waiting.recovery.lastError ?? "", /server is still in the process of starting/);
  assert.ok(waiting.recovery.nextTryAt, "the next try is on its way");
  const lines = warned.mock.calls.map((c) => String(c.arguments[0])).filter((l) => l.includes("[lsps1] recovery:"));
  assert.ok(lines.length > 0 && lines.every((l) => l.includes("server is still in the process of starting") && !l.includes("[object Object]")), lines.join("\n"));

  ready = true;
  // Before: one pass at start-up; neither order was ever looked at again.
  await until(() => view(lsp, "held-1")?.orderState === "COMPLETED", "the held order completes");
  assert.equal(node.callsTo("default.openChannel").length, 1);
  assert.equal(lsp.capital.reservedSat(), 0, "its coins are no longer promised");
  assert.equal(lsp.svc.committedSat(), 0);
  // The unpaid one is followed again: paying it now opens its channel too.
  node.payHoldInvoice(unpaid.invoiceId);
  await until(() => view(lsp, "unpaid-1")?.orderState === "COMPLETED", "the unpaid order, paid now, completes");
  const done = await lsp.svc.status();
  assert.deepEqual([done.recovery.waiting, done.recovery.lastError, done.recovery.nextTryAt], [0, null, null]);
});

test("recovery resumes held orders side by side: one whose buyer stays offline holds up neither the next order nor the next pass", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const offlineBuyer = buyerN(60);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER, offlineBuyer] });
  const waits = await storedOrder(node, { orderId: "held-offline", paid: true, peer: offlineBuyer });
  const opens = await storedOrder(node, { orderId: "held-online", paid: true });
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([waits, opens]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  lsp.seams.recoveryRetryMinMs = 20;
  lsp.seams.recoveryRetryMs = 20;
  lsp.seams.lndConnect = async (pubkey: string) => pubkey !== offlineBuyer;
  lsp.seams.openRetryDelayMs = 60_000; // the offline buyer is looked for again in a minute
  void lsp.seams.recoverOrders();
  // Before: the pass waited for each open in turn — the first order's wait
  // for its buyer (hours, at worst) held up the second order …
  await until(() => view(lsp, "held-online")?.orderState === "COMPLETED", "the second order opens meanwhile", 3_000);
  assert.ok(view(lsp, "held-offline")?.waitingForBuyerSince, "the first still waits for its buyer");
  // … and every later pass: a refund LND refuses now is released by the next one.
  const later = await storedOrder(node, { orderId: "refund-later", paid: true, sizeSat: 1_000_000 });
  lsp.seams.orders.unshift(later);
  let refused = false;
  lsp.seams.lndCancel = async (id: string) => {
    if (!refused) {
      refused = true;
      throw [503, "UnexpectedErrorCancelingHodlInvoice", { err: { details: "Connection dropped" } }];
    }
    await cancelHodl(node.lnd, id);
  };
  await (lsp.svc as unknown as { failAndRefund(o: Lsps1Order, why: string): Promise<void> }).failAndRefund(later, "the open failed for good");
  await until(() => later.paymentState === "REFUNDED", "released by the next pass", 3_000);
  assert.equal(node.invoices.get(later.invoiceId)?.state, "CANCELED");
  assert.ok(view(lsp, "held-offline")?.waitingForBuyerSince, "while the first order still waits");
});

test("an order whose invoice LND no longer has ends — no endless retries, no pending slot held", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const gone = await storedOrder(node, { orderId: "gone-1", paid: false });
  node.invoices.delete(gone.invoiceId); // LND deleted it (gc-canceled-invoices), or never made it
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([gone]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  await lsp.seams.recoverOrders();
  assert.equal(view(lsp, "gone-1")?.orderState, "FAILED");
  assert.equal(view(lsp, "gone-1")?.error, "LND no longer has the order's invoice — nothing was paid");
  const st = await lsp.svc.status();
  assert.deepEqual([st.recovery.waiting, st.recovery.nextTryAt], [0, null]);
});

test("a refund LND refused is tried again until LND confirms it — the buyer's payment is not left held until its HTLC expires", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const order = await storedOrder(node, { orderId: "refund-1", paid: true });
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([order]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  lsp.seams.recoveryRetryMinMs = 20;
  lsp.seams.recoveryRetryMs = 20;
  let lndBack = false;
  let cancels = 0;
  lsp.seams.lndCancel = async (id: string) => {
    cancels += 1;
    if (!lndBack) throw [503, "UnexpectedErrorCancelingHodlInvoice", { err: { details: "Connection dropped" } }];
    await cancelHodl(node.lnd, id);
  };
  const live = lsp.seams.orders[0];
  await (lsp.svc as unknown as { failAndRefund(o: Lsps1Order, why: string): Promise<void> }).failAndRefund(live, "the open failed for good");
  assert.deepEqual([live.orderState, live.paymentState, live.cancelPending], ["FAILED", "HOLD", true]);
  assert.equal(node.invoices.get(order.invoiceId)?.state, "ACCEPTED", "LND still holds the payment");
  await until(() => cancels >= 3, "tried again, and again");
  // Said as what it is: a refund still to come — not "expired", and not an
  // order "waiting for LND after a restart".
  assert.equal(view(lsp, "refund-1")?.refundPending, true);
  const pending = await lsp.svc.status();
  assert.deepEqual([pending.recovery.waiting, pending.recovery.refunds, pending.recovery.settles], [1, 1, 0]);
  assert.match(pending.recovery.lastError ?? "", /Connection dropped/);
  // Before: nothing tried again — held until LND's own expiry, hours later.
  lndBack = true;
  await until(() => live.paymentState === "REFUNDED", "released on a later try");
  assert.equal(node.invoices.get(order.invoiceId)?.state, "CANCELED");
  assert.equal(live.cancelPending, undefined);
  assert.equal(live.error, "the open failed for good", "the reason stays");
  assert.equal(view(lsp, "refund-1")?.refundPending, undefined);
  assert.equal((await lsp.svc.status()).recovery.waiting, 0);
});

test("a failed order whose refund LND hasn't confirmed stays on file however many orders came after it — and is released once LND answers", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const stuck = await storedOrder(node, {
    orderId: "refund-stuck",
    paid: true,
    orderState: "FAILED",
    cancelPending: true,
    error: "the open failed for good",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  // 201 ended orders after it — any peer can leave ~10 abandoned quotes an hour.
  const ended = Array.from({ length: 201 }, (_, i): Lsps1Order => ({
    ...stuck,
    orderId: `ended-${i}`,
    paymentState: "EXPECT_PAYMENT",
    cancelPending: undefined,
    invoiceId: (i + 1).toString(16).padStart(64, "0"),
    error: "order expired unpaid",
  }));
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([...ended, stuck]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  let lndBack = false;
  lsp.seams.lndCancel = async (id: string) => {
    if (!lndBack) throw [503, "UnexpectedErrorCancelingHodlInvoice", { err: { details: "Connection dropped" } }];
    await cancelHodl(node.lnd, id);
  };
  const live = lsp.seams.orders.find((o) => o.orderId === "refund-stuck") as Lsps1Order;
  lsp.seams.persistOrders(); // every save trims the list
  const onDisk = JSON.parse(readFileSync(join(dir, "lsps1-orders.json"), "utf8")) as Lsps1Order[];
  // Before: dropped as the 202nd ended order — the buyer's payment then
  // stayed held until LND's own expiry, with nothing left to release it.
  assert.ok(onDisk.some((o) => o.orderId === "refund-stuck"), "kept on file");
  assert.equal(onDisk.filter((o) => o.orderId.startsWith("ended-")).length, 200, "the newest 200 ended orders, as before");
  await lsp.seams.recoverOrders();
  assert.equal(node.invoices.get(stuck.invoiceId)?.state, "ACCEPTED", "LND still refuses");
  assert.equal(view(lsp, "refund-stuck")?.refundPending, true);
  lndBack = true;
  await lsp.seams.recoverOrders();
  assert.equal(node.invoices.get(stuck.invoiceId)?.state, "CANCELED", "the buyer's payment is released");
  assert.deepEqual([live.paymentState, live.cancelPending], ["REFUNDED", undefined]);
  // Settled, it is an ended order like the others — and the oldest.
  assert.equal(view(lsp, "refund-stuck"), undefined, "trimmed now that nothing is pending");
});

test("when LND comes back, the reconnect of the peer-message stream picks up an order whose invoice watch broke — at once, not at the watch's own retry", async (t) => {
  silence(t);
  const lsp = lspNode(t);
  lsp.seams.recoveryRetryMinMs = 60_000;
  lsp.seams.recoveryRetryMs = 60_000;
  lsp.svc.start();
  const w = lspsWallet(lsp.node, lsp.buyer);
  const order = (await w.call("lsps1.create_order", zeusOrder())).result;
  const hash = hashOf(order);
  assert.ok(lsp.seams.invoiceSubs.has(hash), "watched");
  // LND restarts: the invoice watch and the peer-message stream both break.
  lsp.seams.retryMs = 20;
  lsp.node.dropSubscriptions();
  assert.equal(lsp.seams.invoiceSubs.has(hash), false, "the watch is gone (it looks again itself only after 30 s)");
  // Before: the reconnect re-subscribed the messages only — the order was
  // followed again at the watch's own retry, or the next recovery pass.
  await until(() => lsp.seams.invoiceSubs.has(hash), "followed again right after the reconnect", 2_000);
  lsp.node.payHoldInvoice(hash);
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "paid now, it opens", 3_000);
});

// ── a settle LND refuses ─────────────────────────────────────────────────────

const refuseSettle = (): never => {
  throw [503, "UnexpectedErrorSettlingHodlInvoice", { err: { details: "Connection dropped" } }];
};

test("a channel opened while LND refused the settle is settled by the running process — recovery tries again, at a pace that grows, and the sale and its 1% fee are booked once", async (t) => {
  feeEnv(t);
  silence(t);
  const critical = t.mock.method(console, "error", () => undefined);
  const lsp = lspNode(t);
  lsp.seams.settleRetryBaseMs = 1;
  lsp.seams.recoveryRetryMinMs = 50;
  lsp.seams.recoveryRetryMs = 50;
  const settle = lsp.seams.lndSettle.bind(lsp.svc);
  let tries = 0;
  let lndBack = (): void => undefined;
  const back = new Promise<void>((r) => (lndBack = r));
  lsp.seams.lndSettle = async (secret: string) => {
    tries += 1;
    if (tries <= 10) refuseSettle(); // two rounds of five
    await back; // the next one waits until the test has looked
    return settle(secret);
  };
  lsp.svc.start();
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const hash = hashOf(order);
  lsp.node.payHoldInvoice(hash);

  // Before: five tries, then nothing until a restart — the held payment
  // waited for LND to release it (about a day), the channel given away.
  await until(() => tries === 11, "recovery tries the settle again — and again");
  const v = view(lsp, order.order_id);
  assert.deepEqual([v?.orderState, v?.paymentState], ["CREATED", "HOLD"]);
  assert.ok(v?.fundingOutpoint, "the channel is on record: never a second open");
  assert.equal(v?.error, "the channel is open, but LND hasn't claimed the buyer's payment yet — tried again automatically");
  assert.ok(critical.mock.calls.some((c) => /CRITICAL order .*LND refused to settle the payment \(Connection dropped\)/.test(String(c.arguments[0]))));
  const st = await lsp.svc.status();
  assert.deepEqual([st.recovery.waiting, st.recovery.settles, st.recovery.refunds], [1, 1, 0]);
  assert.match(st.recovery.lastError ?? "", /settle refused — Connection dropped/);
  // The pace doubles while LND keeps refusing (50 → 100 → 200 ms here; 30 s
  // to 5 min in production): the next try is ~200 ms off.
  const ahead = Date.parse(st.recovery.nextTryAt ?? "") - Date.now();
  assert.ok(ahead > 120, `next try in ${ahead} ms`);

  lndBack();
  await until(() => view(lsp, order.order_id)?.orderState === "COMPLETED", "settled in the same process");
  assert.equal(lsp.node.invoices.get(hash)?.state, "SETTLED");
  assert.equal(lsp.node.callsTo("default.openChannel").length, 1, "one channel");
  assert.equal(lsp.earnings.recent().filter((s) => s.orderId === order.order_id).length, 1, "the sale booked once");
  assert.deepEqual(lsp.fees.entries().map((e) => e.key), [`lsps1:${order.order_id}`], "its 1% fee enqueued once");
  assert.equal(view(lsp, order.order_id)?.error, undefined);
  const done = await lsp.svc.status();
  assert.deepEqual([done.recovery.waiting, done.recovery.lastError, done.recovery.nextTryAt], [0, null, null]);
});

test("a settle LND refuses until it releases the held payment: the order says the channel was given away — a CRITICAL line and an alert until acknowledged, never a plain refund", async (t) => {
  silence(t);
  const critical = t.mock.method(console, "error", () => undefined);
  const lsp = lspNode(t);
  lsp.seams.settleRetryBaseMs = 1;
  lsp.seams.recoveryRetryMinMs = 20;
  lsp.seams.recoveryRetryMs = 20;
  let tries = 0;
  lsp.seams.lndSettle = async () => {
    tries += 1;
    refuseSettle();
  };
  lsp.svc.start();
  const order = (await lspsWallet(lsp.node, lsp.buyer).call("lsps1.create_order", zeusOrder())).result;
  const hash = hashOf(order);
  lsp.node.payHoldInvoice(hash);
  await until(() => tries >= 10, "two rounds of settle tries");
  lsp.node.expireHoldInvoice(hash); // LND releases the held HTLC near its expiry
  await until(() => view(lsp, order.order_id)?.orderState === "FAILED", "the order ends");
  const v = view(lsp, order.order_id);
  assert.equal(v?.paymentState, "REFUNDED");
  assert.ok(v?.fundingOutpoint);
  // Before: "payment refunded" (or "will retry") — nothing said a channel was given away.
  assert.equal(
    v?.error,
    "the channel was opened, but LND released the buyer's held payment before it could be claimed — the buyer has the channel without paying for it",
  );
  const alerts = stateAlerts(lsp.dir).filter((a) => a.message.includes(order.order_id));
  assert.equal(alerts.length, 1);
  assert.equal(
    alerts[0].message,
    `LSP order ${order.order_id}: a 1000000 sat channel (${v?.fundingOutpoint}) was opened for the buyer, but LND released the buyer's held ` +
      `payment before it could be claimed — the buyer has the channel without paying the ${v?.feeSat} sat lease fee. ` +
      "The buyer was not charged. The channel is yours: close it to take the capital back, or keep it for routing.",
  );
  assert.ok(critical.mock.calls.some((c) => String(c.arguments[0]).startsWith(`[lsps1] CRITICAL LSP order ${order.order_id}`)));
  assert.equal(lsp.earnings.recent().length, 0, "no sale booked");
  assert.equal(lsp.fees.entries().length, 0, "no service fee");
  // Nothing is left to try.
  const after = tries;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(tries, after, "no more settle tries");
  assert.equal((await lsp.svc.status()).recovery.waiting, 0);
});

test("after a restart too: an opened channel whose payment LND has released — or whose invoice it no longer has — is called out the same way", async (t) => {
  silence(t);
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const channel = (n: number) => ({ fundedAt: new Date().toISOString(), fundingOutpoint: `${"d".repeat(63)}${n}:0`, expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  const released = await storedOrder(node, { orderId: "released-1", paid: true, channel: channel(1) });
  node.expireHoldInvoice(released.invoiceId);
  const lost = await storedOrder(node, { orderId: "lost-1", paid: true, channel: channel(2) });
  node.invoices.delete(lost.invoiceId);
  writeFileSync(join(dir, "lsps1-orders.json"), JSON.stringify([released, lost]));
  const lsp = lspNode(t, { dir, node, lspMode: false });
  await lsp.seams.recoverOrders();
  assert.deepEqual([view(lsp, "released-1")?.orderState, view(lsp, "released-1")?.paymentState], ["FAILED", "REFUNDED"]);
  assert.match(view(lsp, "released-1")?.error ?? "", /^the channel was opened, but LND released the buyer's held payment/);
  assert.match(view(lsp, "lost-1")?.error ?? "", /^the channel was opened, but LND no longer has the order's invoice, so the payment can't be claimed/);
  const kinds = storeIncidents(dir).filter((i) => i.kind === "unpaid_channel").map((i) => i.detail.split(":")[0]);
  assert.deepEqual(kinds.sort(), ["LSP order lost-1", "LSP order released-1"]);
  assert.equal(node.callsTo("invoices.settleInvoice").length, 0);
});

// ── finding an interrupted open ──────────────────────────────────────────────

test("an open whose outcome was unclear never adopts a channel another order's open tagged — even one not on record anywhere yet", async (t) => {
  silence(t);
  const node = new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const lsp = lspNode(t, { node });
  const order = await storedOrder(node, {
    orderId: "mine-1",
    paid: true,
    // The process stopped mid-open 11 minutes ago: LND has had ample time.
    opening: { startedAt: new Date(Date.now() - 11 * 60_000).toISOString(), preExisting: [] },
  });
  lsp.seams.orders.unshift(order);
  // LND shows a channel to the same buyer, of the same size, funded by us —
  // another order's (its outpoint not on record: that order is mid-open too).
  node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: "aa".repeat(32), transactionVout: 0, memo: "lsps1:other-order" });
  await lsp.seams.fulfill(order);
  // Before: adopted as this order's channel, and this buyer's payment settled for it.
  assert.notEqual(order.channel?.fundingOutpoint, `${"aa".repeat(32)}:0`);
  assert.equal(node.callsTo("default.openChannel").length, 1, "its own channel opened instead");
  assert.equal(order.orderState, "COMPLETED");
  assert.equal(node.pending.find((p) => `${p.transactionId}:0` === order.channel?.fundingOutpoint)?.memo, "lsps1:mine-1");

  // With its own tagged channel in LND (and an untagged newer one), its own is found.
  const again = await storedOrder(node, {
    orderId: "mine-2",
    paid: true,
    opening: { startedAt: new Date(Date.now() - 60_000).toISOString(), preExisting: [] },
  });
  lsp.seams.orders.unshift(again);
  // (The untagged one listed first: only the tag tells them apart.)
  node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: "cc".repeat(32), transactionVout: 0 });
  node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: "bb".repeat(32), transactionVout: 0, memo: "lsps1:mine-2" });
  await lsp.seams.fulfill(again);
  assert.equal(again.channel?.fundingOutpoint, `${"bb".repeat(32)}:0`);
  assert.equal(node.callsTo("default.openChannel").length, 1, "no second open");
});
