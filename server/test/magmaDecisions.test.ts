/**
 * The order lane deciding on new orders (D6): accept with a HODL invoice when
 * the order can be served, reject at once — with the reason on record — when
 * it can't, and never leave an order to time out because a check before the
 * accept could not be made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonStore } from "../src/store.js";
import { magmaRefusalAlerts } from "../src/services/alerts.js";
import { BUYER_DIALS, refusalKindOf } from "../src/services/magmaDesk.js";
import { internalError } from "./helpers/magma.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import {
  IN_AN_HOUR,
  entryOnDisk,
  historyFor,
  quiet,
  walletBalance,
} from "./helpers/lifecycle.js";

test("an order this node can't fund is rejected at once, before its deadline, with the reason on record", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { chainBalance: 1_000_000 });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "rejected via seller.reject, not left to time out");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "rejected");
  assert.match(e?.reason ?? "", /not enough on-chain capital/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "no invoice for an order we can't serve");
  const reject = autopilot.getState().history[0]?.sells[0];
  assert.equal(reject?.action, "reject");
  assert.match(reject?.error ?? "", /not enough on-chain capital/, "the history says why");
});

test("LND not answering during the accept's capital check is no reason to turn the buyer away: no reject, the next pass accepts", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  let blinks = 0;
  node.override("default.walletBalance", (_a, cb) => {
    // Once, exactly inside the accept's on-chain mutex (the check before it,
    // outside, went through).
    if (capital.mutex.heldBy === "magma accept" && blinks === 0) {
      blinks += 1;
      return cb({ details: "transport is closing" });
    }
    cb(null, walletBalance(node));
  });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(blinks, 1, "LND blinked inside the accept");
  // Before: "cannot save the order journal (503,UnexpectedErrorWhenGettingChainBalance,[object Object]) — not accepting",
  // and the order was rejected on Amboss — a sale and seller reputation lost to one blink.
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "not rejected");
  assert.equal(magma.count("RejectOrder"), 0);
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen", "nothing reserved, nothing created");
  assert.match(e?.lastError ?? "", /UnexpectedErrorWhenGettingChainBalance: transport is closing/, "LND's own words, readable");
  assert.doesNotMatch(e?.lastError ?? "", /\[object Object\]|journal/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);
  const error = autopilot.getState().history[0]?.sells.find((s) => s.orderId === sale.id);
  assert.equal(error?.action, "error", "on record as this order's error for now");

  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted on the next pass");
});

test("an accept whose preimage can't be saved fails closed: the order is rejected — no invoice, no accept", async (t) => {
  quiet(t);
  t.mock.method(console, "error", () => undefined);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  // The disk fails exactly when the accept saves its preimage.
  const proto = JsonStore.prototype as unknown as { replaceFile(...a: unknown[]): unknown };
  const realReplace = proto.replaceFile;
  t.mock.method(proto, "replaceFile", function (this: unknown, ...a: unknown[]) {
    if (capital.mutex.heldBy === "magma accept") throw new Error("ENOSPC: no space left on device");
    return realReplace.apply(this, a);
  });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "an accept that could never be settled is not sent");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /^cannot save the order journal \(ENOSPC: no space left on device\) — not accepting$/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);
  assert.equal(magma.count("AcceptOrder"), 0);
  assert.equal(capital.reservedSat(), 0, "nothing stays reserved");
});

test("orders outside the caps are rejected too, each with its reason; a buyer that can't be reached is not", async (t) => {
  quiet(t);
  const unreachable = "02" + "ee".repeat(32);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  // This buyer never answers a connection attempt.
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (pk === unreachable) return cb({ details: "dial tcp: i/o timeout" });
    if (!node.peers.includes(pk)) node.peers.push(pk);
    cb(null, {});
  });
  const big = magma.addSale({ buyerPubkey: BUYER, sizeSats: 4_500_000 });
  const far = magma.addSale({ buyerPubkey: unreachable, sizeSats: 1_000_000 });
  const fits = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(fits.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "the order that fits is accepted");
  // 2M promised to `fits`: a further 3.5M would exceed the 5M deploy cap.
  const over = magma.addSale({ buyerPubkey: BUYER, sizeSats: 3_500_000 });
  await autopilot.pollSellOrders();
  const reason = (id: string) => entryOnDisk(dir, id)?.reason ?? "";
  for (const id of [big.id, over.id]) assert.equal(magma.sales.get(id)?.status, "SELLER_REJECTED", id);
  assert.match(reason(big.id), /above your max channel size/);
  assert.match(reason(over.id), /deploy cap reached/);
  assert.equal(magma.sales.get(far.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "the order still waits");
  assert.match(entryOnDisk(dir, far.id)?.lastError ?? "", /the buyer's node couldn't be reached \(1\.2\.3\.4:9735: dial tcp: i\/o timeout\)/);
});

// Order cbebc117, 2026-10-31: a 2,436 sat sale turned down 5.3 s into a two-hour
// window as "the buyer's node is unreachable", with the buyer reachable.
test("a buyer that can't be reached: dialed again every few minutes, the lane says why, accepted once reached — rejected only with its deadline close", async (t) => {
  quiet(t);
  const away = "02" + "ee".repeat(32);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  let reachable = false;
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (!reachable) return cb({ details: "dial tcp: i/o timeout" });
    if (!node.peers.includes(pk)) node.peers.push(pk);
    cb(null, {});
  });
  const sale = magma.addSale({ buyerPubkey: away, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(magma.count("RejectOrder"), 0);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "seen");
  assert.match(autopilot.getState().magmaLane?.error ?? "", /^could not decide 1 order \(the buyer's node couldn't be reached \(1\.2\.3\.4:9735: dial tcp: i\/o timeout\)\)/);
  const dials = node.callsTo("default.connectPeer").length;
  const lines = entryOnDisk(dir, sale.id)?.events.length;

  // The next passes (45 s apart): not dialed again yet, no new line on its record.
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.connectPeer").length, dials, "a dial over Tor would hold up the lane's other orders");
  assert.equal(entryOnDisk(dir, sale.id)?.events.length, lines);
  assert.match(autopilot.getState().magmaLane?.error ?? "", /couldn't be reached/, "the status still says so");

  // Minutes later it dials again, and the buyer is back.
  const memory = (autopilot.magma as unknown as { buyerDials: Map<string, { at: number; what: string }> }).buyerDials;
  memory.get(sale.id)!.at = Date.now() - 4 * 60_000;
  reachable = true;
  await autopilot.pollSellOrders();
  assert.ok(node.callsTo("default.connectPeer").length > dials);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted");
  assert.equal(memory.has(sale.id), false);
});

test("silent buyers don't hold up a reachable one: a pass spends its dial budget, the next goes on with who hasn't been dialed", async (t) => {
  quiet(t);
  const was = { ...BUYER_DIALS };
  BUYER_DIALS.passBudgetMs = 1;
  t.after(() => Object.assign(BUYER_DIALS, was));
  const dead = [1, 2, 3, 4].map((n) => "02" + String(n).repeat(2).padStart(2, "e").repeat(32).slice(0, 64));
  const { autopilot, node, magma } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 50_000_000 } });
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (dead.includes(pk)) return void setTimeout(() => cb({ details: "dial tcp: i/o timeout" }), 3);
    if (!node.peers.includes(pk)) node.peers.push(pk);
    cb(null, {});
  });
  for (const pk of dead) magma.addSale({ buyerPubkey: pk, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  const reachable = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  const dialedPerPass: number[] = [];
  for (let pass = 0; pass < 5; pass++) {
    const before = new Set(node.callsTo("default.connectPeer").map((c) => (c.addr as { pubkey: string }).pubkey)).size;
    await autopilot.pollSellOrders();
    dialedPerPass.push(new Set(node.callsTo("default.connectPeer").map((c) => (c.addr as { pubkey: string }).pubkey)).size - before);
  }
  assert.ok(Math.max(...dialedPerPass) <= 2, `one silent buyer per pass: ${dialedPerPass}`);
  assert.equal(dialedPerPass.reduce((a, b) => a + b, 0), 5, "everyone had a turn");
  assert.equal(magma.sales.get(reachable.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(magma.count("RejectOrder"), 0);
  // All the silent ones due again, and a new order arrives: never dialed, so it goes first.
  const memory = (autopilot.magma as unknown as { buyerDials: Map<string, { at: number; what: string }> }).buyerDials;
  for (const d of memory.values()) d.at = Date.now() - 4 * 60_000;
  const another = "03" + "ab".repeat(32);
  const late = magma.addSale({ buyerPubkey: another, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(late.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "not behind the silent ones");
});

test("the deadline close and the buyer silent: turned down now, without another dial that could outlast it; a reject that failed is sent again", async (t) => {
  quiet(t);
  const away = "02" + "ee".repeat(32);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  node.override("default.connectPeer", (_a, cb) => cb({ details: "dial tcp: i/o timeout" }));
  const sale = magma.addSale({ buyerPubkey: away, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  const dials = node.callsTo("default.connectPeer").length;
  // 3.5 minutes left, and a redial due.
  const memory = (autopilot.magma as unknown as { buyerDials: Map<string, { at: number; what: string }> }).buyerDials;
  memory.get(sale.id)!.at = Date.now() - 4 * 60_000;
  sale.timeout = new Date(Date.now() + 3.5 * 60_000).toISOString();
  magma.behave.RejectOrder = (n) => (n === 0 ? "throw" : "ok");
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.connectPeer").length, dials, "not dialed again");
  assert.equal(magma.count("RejectOrder"), 1);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "Amboss answered with an error");
  assert.ok(memory.has(sale.id), "the record stays until the reject is confirmed");
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.connectPeer").length, dials, "the reject is sent again, not another dial");
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /^could not decide on it in time: the buyer's node couldn't be reached/);
  assert.equal(memory.has(sale.id), false);
});

test("the run history keeps one line for a buyer away, whatever LND says from dial to dial; the order's record has its words", async (t) => {
  quiet(t);
  const away = "02" + "ee".repeat(32);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  let n = 0;
  node.override("default.connectPeer", (_a, cb) => cb({ details: `socks connect tcp: circuit ${n++} failed` }));
  const sale = magma.addSale({ buyerPubkey: away, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  const memory = (autopilot.magma as unknown as { buyerDials: Map<string, { at: number; what: string }> }).buyerDials;
  for (let pass = 0; pass < 4; pass++) {
    await autopilot.pollSellOrders();
    memory.get(sale.id)!.at = Date.now() - 4 * 60_000;
  }
  const lines = autopilot.getState().history.filter((r) => r.sells.some((x) => x.orderId === sale.id));
  assert.equal(lines.length, 1, JSON.stringify(lines).slice(0, 400));
  assert.match(entryOnDisk(dir, sale.id)?.lastError ?? "", /circuit \d+ failed/);
});

test("selling switched off while the lane keeps dialing: the record says the order is the operator's, not 'couldn't be reached'", async (t) => {
  quiet(t);
  const away = "02" + "ee".repeat(32);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  node.override("default.connectPeer", (_a, cb) => cb({ details: "dial tcp: i/o timeout" }));
  const sale = magma.addSale({ buyerPubkey: away, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  autopilot.setConfig({ ...autopilot.getState().config, sellEnabled: false });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  const entry = entryOnDisk(dir, sale.id);
  assert.equal(entry?.lastError, undefined);
  assert.equal(entry?.decision?.action, "skip");
});

test("a paid order whose buyer is away: dialed again after the gap too, not every pass", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  node.peers = node.peers.filter((p) => p !== BUYER);
  let reachable = false;
  node.override("default.connectPeer", (a, cb) => {
    if (!reachable) return cb({ details: "dial tcp: i/o timeout" });
    node.peers.push((a.addr as { pubkey: string }).pubkey);
    cb(null, {});
  });
  await autopilot.pollSellOrders();
  const dials = node.callsTo("default.connectPeer").length;
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "held", "the payment stays held");
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.connectPeer").length, dials, "not every pass");
  const memory = (autopilot.magma as unknown as { buyerDials: Map<string, { at: number; what: string }> }).buyerDials;
  memory.get(sale.id)!.at = Date.now() - 4 * 60_000;
  reachable = true;
  await autopilot.pollSellOrders();
  assert.ok(node.callsTo("default.connectPeer").length > dials);
  assert.equal(node.pending.length, 1, "the channel is opened");
  assert.equal(memory.has(sale.id), false);
});

test("a paid order: a dial that outlasts the deadline opens nothing — the payment goes back; no free channel for an order Amboss has ended", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  node.peers = node.peers.filter((p) => p !== BUYER);
  node.override("default.connectPeer", (a, cb) =>
    void setTimeout(() => {
      node.peers.push((a.addr as { pubkey: string }).pubkey);
      cb(null, {});
    }, 1_500),
  );
  sale.timeout = new Date(Date.now() + 500).toISOString();
  await autopilot.pollSellOrders();
  assert.equal(node.pending.length, 0, "no channel");
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /no answer within 1 s/, "the dial's budget ends with the deadline, and the record says why");
});

test("a paid order's buyer away: one counted history line whatever LND says, and the lane's status says so", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  node.peers = node.peers.filter((p) => p !== BUYER);
  let n = 0;
  node.override("default.connectPeer", (_a, cb) => cb({ details: `socks connect tcp: circuit ${n++} failed` }));
  const memory = (autopilot.magma as unknown as { buyerDials: Map<string, { at: number; what: string }> }).buyerDials;
  const before = autopilot.getState().history.length;
  for (let pass = 0; pass < 4; pass++) {
    await autopilot.pollSellOrders();
    if (pass === 1) memory.get(sale.id)!.at = Date.now() - 4 * 60_000;
  }
  assert.equal(autopilot.getState().history.length - before, 1, JSON.stringify(autopilot.getState().history.slice(0, 3)).slice(0, 500));
  assert.match(autopilot.getState().magmaLane?.error ?? "", /^can't reach the buyer of 1 paid order yet \(couldn't connect/);
  assert.match(entryOnDisk(dir, sale.id)?.lastError ?? "", /circuit \d+ failed/);
});

test("deadlines close and the budget spent: a buyer never dialed still gets its try — the silent one doesn't cost the reachable one its sale", async (t) => {
  quiet(t);
  const was = { ...BUYER_DIALS };
  BUYER_DIALS.passBudgetMs = 1;
  t.after(() => Object.assign(BUYER_DIALS, was));
  const away = "02" + "ee".repeat(32);
  const { autopilot, node, magma } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (pk === away) return void setTimeout(() => cb({ details: "dial tcp: i/o timeout" }), 3);
    if (!node.peers.includes(pk)) node.peers.push(pk);
    cb(null, {});
  });
  const silent = magma.addSale({ buyerPubkey: away, sizeSats: 1_000_000, timeout: new Date(Date.now() + 2.9 * 60_000).toISOString() });
  const reachable = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, timeout: new Date(Date.now() + 3 * 60_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(silent.id)?.status, "SELLER_REJECTED");
  assert.equal(magma.sales.get(reachable.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "dialed, reached, accepted");
});

test("a buyer that stays away is rejected shortly before the deadline, with what LND said — never left to time out", async (t) => {
  quiet(t);
  const away = "02" + "ee".repeat(32);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  node.override("default.connectPeer", (_a, cb) => cb({ details: "dial tcp: i/o timeout" }));
  const sale = magma.addSale({ buyerPubkey: away, sizeSats: 1_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  // The clock runs down between two dials: the lane doesn't wait for the next.
  sale.timeout = new Date(Date.now() + 3 * 60_000).toISOString();
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /^could not decide on it in time: the buyer's node couldn't be reached \(1\.2\.3\.4:9735: dial tcp: i\/o timeout\) — rejected rather than left to time out$/);
  assert.equal((autopilot.magma as unknown as { buyerDials: Map<string, unknown> }).buyerDials.has(sale.id), false, "forgotten");
});

// Review of P1b: the alert for every turned-down order advised "raise the caps
// or fund the wallet" — also for an unreachable buyer, an asset channel, a fee
// Amboss didn't report: refusals more capital can't help.
test("each refusal records what it was about, and only a cap or the wallet gets the 'raise the caps / fund the wallet' advice", async (t) => {
  quiet(t);
  const unreachable = "02" + "ee".repeat(32);
  const { autopilot, node, magma, dir } = sellerSetup(t, { chainBalance: 6_000_000, config: { sellMaxChannelSats: 4_000_000, sellMaxDeploySats: 5_000_000 } });
  node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (pk === unreachable) return cb({ details: "dial tcp: i/o timeout" });
    if (!node.peers.includes(pk)) node.peers.push(pk);
    cb(null, {});
  });
  const big = magma.addSale({ buyerPubkey: BUYER, sizeSats: 4_500_000 });
  const far = magma.addSale({ buyerPubkey: unreachable, sizeSats: 1_000_000, timeout: new Date(Date.now() + 60_000).toISOString() });
  const asset = magma.addSale({ buyerPubkey: BUYER, assetType: "TAPROOT_ASSET" });
  await autopilot.pollSellOrders();
  // The wallet short: the next order can't be funded.
  node.chainBalance = 500_000;
  const poor = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  for (const s of [big, far, asset, poor]) assert.equal(magma.sales.get(s.id)?.status, "SELLER_REJECTED", s.id);
  const kinds = Object.fromEntries(autopilot.magma.refusals().map((r) => [r.orderId, r.kind]));
  assert.deepEqual(
    [kinds[big.id], kinds[far.id], kinds[asset.id], kinds[poor.id]],
    ["cap", "other", "other", "capital"],
    JSON.stringify(autopilot.magma.refusals()),
  );
  assert.equal(entryOnDisk(dir, big.id)?.refusalKind, "cap", "kept on the order's record");
  const alerts = Object.fromEntries(magmaRefusalAlerts(autopilot.magma).map((a) => [a.id, a.message]));
  assert.match(alerts[`magma:${big.id}`], /above your max channel size .* If you want orders like it, raise the caps on Autopilot → Selling/);
  assert.match(alerts[`magma:${poor.id}`], /not enough on-chain capital.* If you want orders like it, add on-chain funds to the wallet/);
  for (const id of [far.id, asset.id]) {
    // Before: "If you want orders like it, raise the caps or fund the wallet".
    assert.doesNotMatch(alerts[`magma:${id}`], /raise the caps|fund the wallet|on-chain funds/, alerts[`magma:${id}`]);
    assert.match(alerts[`magma:${id}`], /See Market → Orders for the order\.$/);
  }
});

test("a refusal recorded before its kind was kept still gets the right advice, from its reason", () => {
  assert.equal(refusalKindOf("deploy cap reached (2,000,000 sat already sold or promised, cap 2,000,000 sat)"), "cap");
  assert.equal(refusalKindOf("above your max channel size (3,000,000 > 2,000,000 sat)"), "cap");
  assert.equal(refusalKindOf("not enough on-chain capital: 10,000 sat spendable after a 60,000 sat reserve"), "capital");
  for (const r of ["the buyer's node is unreachable", "Amboss reported no fee for this order", "Amboss refused the accept 3 times", "not a bitcoin channel (TAPROOT_ASSET)"]) {
    assert.equal(refusalKindOf(r), "other", r);
  }
});

test("an order for a Taproot Assets channel is rejected at once — no HODL invoice, no accept", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, assetType: "TAPROOT_ASSET" });
  await autopilot.pollSellOrders();
  // Without the check: accepted with a bitcoin HODL invoice, and a bitcoin
  // channel opened for an order that asked for an asset channel.
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /^not a bitcoin channel \(TAPROOT_ASSET\)$/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);
  assert.equal(magma.count("AcceptOrder"), 0);
});

test("LND's anchor reserve and the funding fee count: an order sized 'balance − 50k' is rejected, not accepted and then refused by LND", async (t) => {
  quiet(t);
  // Six anchor channels: LND keeps 10k × (6 + 1) = 70k for fee bumping and
  // refuses to fund a channel that would leave less.
  const channels = Array.from({ length: 6 }, (_, i) => ({
    partnerPublicKey: "03" + String(i).repeat(64).slice(0, 64),
    capacity: 1_000_000,
    localBalance: 500_000,
    transactionId: String(i + 1).repeat(64).slice(0, 64),
    transactionVout: 0,
  }));
  const { autopilot, magma, dir, node } = sellerSetup(t, { chainBalance: 2_050_000 });
  node.channels.push(...channels);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /reserve \(incl\. LND's anchor reserve and the funding fee\)/);
});

// ── a new order the lane can read but can't decide on ─────────────────────────

test("a new order whose decision can't be made (Amboss's listing of your sold capital fails): never silent — its record and the lane say what failed; near its deadline it is rejected, not left to time out", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 5 * 60_000).toISOString() });
  // One broken order among the running leases breaks every listing that
  // contains it: the deploy cap's listing answers a 500 inside GraphQL, pass
  // after pass. The listing of orders waiting on us, and the order's read, work.
  let broken = true;
  magma.salesList = (f) => (broken && f.status ? internalError() : null);
  await autopilot.pollSellOrders();
  let e = entryOnDisk(dir, sale.id);
  // Before: "seen", lastError "Internal server error" (no word of what
  // failed), and a lane reporting ok — until the order timed out on us.
  assert.equal(e?.phase, "seen", "nothing promised, nothing created");
  assert.equal(e?.lastError, "could not read your sold capital from Amboss: Internal server error");
  let lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false, "not 'ok'");
  assert.equal(lane.error, "could not decide 1 order (could not read your sold capital from Amboss: Internal server error)");
  assert.equal(lane.retrying, true);
  assert.deepEqual(historyFor(autopilot, sale.id).map((s) => [s.action, s.ok]), [["error", false]]);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "not turned down while there is time");
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0);

  // Its approval deadline draws near, and the listing still fails.
  magma.sales.get(sale.id)!.timeout = new Date(Date.now() + 90_000).toISOString();
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "rejected — a reject needs only the order's id");
  e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "rejected");
  assert.equal(
    e?.reason,
    "could not decide on it in time: could not read your sold capital from Amboss: Internal server error — rejected rather than left to time out",
  );
  lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, true, "nothing left undecided");

  // The listing works again: a new order is accepted.
  broken = false;
  const next = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(next.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(autopilot.getState().magmaLane.ok, true);
});

test("Amboss's listing of your sold capital is asked once per pass: with it failing, several new orders don't each wait for it again", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t);
  const sales = [1_000_000, 1_100_000, 1_200_000].map((sizeSats) => magma.addSale({ buyerPubkey: BUYER, sizeSats, timeout: IN_AN_HOUR() }));
  let deployReads = 0;
  magma.salesList = (f) => {
    if (!f.status) return null;
    deployReads += 1;
    return internalError();
  };
  await autopilot.pollSellOrders();
  // Before: one request per new order — on a timeout, 15 s each.
  assert.equal(deployReads, 1, "asked once in the pass");
  for (const s of sales) {
    assert.equal(entryOnDisk(dir, s.id)?.phase, "seen");
    assert.match(entryOnDisk(dir, s.id)?.lastError ?? "", /^could not read your sold capital from Amboss: Internal server error$/);
  }
  assert.match(autopilot.getState().magmaLane.error ?? "", /^could not decide 3 orders \(could not read your sold capital from Amboss: /);
  await autopilot.pollSellOrders();
  assert.equal(deployReads, 2, "and asked again on the next pass");
});

test("an order the wallet can't fund is rejected at once, even while Amboss's listing of your sold capital fails — the wallet is checked first", async (t) => {
  quiet(t);
  const { autopilot, magma, dir } = sellerSetup(t, { chainBalance: 1_000_000 });
  let deployReads = 0;
  magma.salesList = (f) => {
    if (!f.status) return null;
    deployReads += 1;
    return internalError();
  };
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, timeout: IN_AN_HOUR() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "turned down at once, not near its deadline");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /^not enough on-chain capital/);
  assert.equal(deployReads, 0, "no need to ask Amboss for that");
});

test("LND not answering the accept's own capital check close to the approval deadline: the order is rejected, not left to time out", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  // LND fails every balance read inside the accept's on-chain mutex (the
  // check before it, outside, went through).
  node.override("default.walletBalance", (_a, cb) => {
    if (capital.mutex.heldBy === "magma accept") return cb({ details: "transport is closing" });
    cb(null, walletBalance(node));
  });
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 90_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "rejected");
  assert.match(
    e?.reason ?? "",
    /^could not decide on it in time: LND did not answer the capital check: .*UnexpectedErrorWhenGettingChainBalance: transport is closing — rejected rather than left to time out$/,
  );
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "nothing offered");
  assert.equal(capital.reservedSat(), 0);
});

test("LND failing to create the HODL invoice: nothing is offered, the lane says so and accepts on the next pass — or, near the approval deadline, rejects the order", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  node.failNext("invoices.addHoldInvoice", "transport is closing");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.equal(e?.invoice, null);
  assert.match(e?.lastError ?? "", /^could not create the HODL invoice: /);
  assert.equal(capital.reservedSat(), 0, "nothing stays reserved");
  assert.equal(magma.count("AcceptOrder"), 0);
  assert.match(autopilot.getState().magmaLane.error ?? "", /^could not decide 1 order \(could not create the HODL invoice: /);
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT", "accepted on the next pass");

  const late = magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 90_000).toISOString() });
  node.failNext("invoices.addHoldInvoice", "transport is closing");
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(late.id)?.status, "SELLER_REJECTED", "near its deadline: rejected");
  assert.match(entryOnDisk(dir, late.id)?.reason ?? "", /^could not decide on it in time: could not create the HODL invoice: .* — rejected rather than left to time out$/);
});

test("an order whose fee Amboss never reports is rejected before its approval deadline, not left to time out", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 60_000).toISOString() });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /priced it at 0 sats/);
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "never an invoice for 0 sat");
});

test("Amboss refuses the accept (success:false): the HODL invoice is cancelled at once — nothing of ours stays payable", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  magma.behave.AcceptOrder = "false";
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const created = node.callsTo("invoices.addHoldInvoice");
  assert.equal(created.length, 1);
  const hash = Buffer.from(created[0].hash as Buffer).toString("hex");
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "an invoice Amboss didn't take is released");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.equal(e?.invoice, null);
  assert.match(e?.lastError ?? "", /Amboss refused the accept/);
});
