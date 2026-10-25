/**
 * The close routes over HTTP (package P4): the close list, the Channels table
 * and POST /channels/close know about leases, pending channels and how long a
 * peer has been away — and a peer can be reconnected before anything is
 * force-closed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApi } from "./helpers/apiHarness.js";
import { chanNumber, feeNode, type FeeChannel } from "./helpers/feeNode.js";
import { makeTempDir } from "./helpers/tmp.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { channelLeases } from "../src/services/leases.js";
import { Autopilot } from "../src/services/autopilot.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";

const HEIGHT = 860_000;
const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

/** Idle full channels 40 days old (past the 30-day guard): #1 sold on Magma
 *  with a 60-day lease, #2 an ordinary one, #3 sold over LSPS1 (90 days) —
 *  plus a channel still opening (#4). */
async function setup(t: Parameters<typeof makeTempDir>[0]) {
  const channels: FeeChannel[] = [1, 2, 3].map((n) => ({
    id: `${HEIGHT - 5_760}x${n}x0`,
    partnerPublicKey: PEER(n),
    capacity: 2_000_000,
    localBalance: 2_000_000,
    transactionId: TX(n),
    transactionVout: 0,
    feeRatePpm: 100,
    baseFeeMsat: 0,
  }));
  const node = feeNode({ blockHeight: HEIGHT, channels });
  node.pending.push({ partnerPublicKey: PEER(4), capacity: 3_000_000, transactionId: TX(4), transactionVout: 0 });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const dir = makeTempDir(t);
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, "magma-orders.json"),
    JSON.stringify([
      {
        orderId: "magma-sale-1", phase: "settled", via: "autopilot", createdAt: now, updatedAt: now, settledAt: now, buyerPubkey: PEER(1),
        sizeSats: 2_000_000, isPrivate: false, feeMsat: "12345000", leaseBlocks: 8_640, feeRateCapPpm: 2200, baseFeeCapSats: 1,
        invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: `${TX(1)}:0`, events: [],
      },
    ]),
  );
  writeFileSync(
    join(dir, "lsps1-orders.json"),
    JSON.stringify([
      {
        orderId: "lsp-sale-3", peer: PEER(3), createdAt: now, lspBalanceSat: 2_000_000, clientBalanceSat: 0,
        requiredChannelConfirmations: 1, fundingConfirmsWithinBlocks: 6, channelExpiryBlocks: 12_960, token: "",
        announceChannel: true, orderState: "COMPLETED", paymentState: "PAID", feeTotalSat: 20_000, orderTotalSat: 20_000,
        invoice: "", invoiceId: "ab".repeat(32), invoiceSecret: "cd".repeat(32), invoiceExpiresAt: now,
        channel: { fundedAt: now, fundingOutpoint: `${TX(3)}:0`, expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString() },
        serviceFeePaidSat: 0, feeRateCapPpm: 2200, baseFeeCapSats: 1,
      },
    ]),
  );
  const api = await startApi(t, { node, dir });
  return { api, node, channels };
}

test("GET /suggestions/close: a channel sold on Magma or over LSPS1 is protected for its lease, a channel still opening is listed apart — only the ordinary idle channel is a candidate", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const { api, channels } = await setup(t);
  const res = await api.request("GET", "/suggestions/close");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as {
    candidates: { channelId: string }[];
    protected: { channelId: string; reason: string; lease: { kind: string } | null }[];
    pending: { channelId: string; status: string; lease: unknown }[];
    totalCapitalFreedSats: number;
  };
  assert.deepEqual(body.candidates.map((c) => c.channelId), [channels[1].id]);
  assert.equal(body.totalCapitalFreedSats, 2_000_000, "the leased and the opening channels' balances aren't 'freeable'");
  const leased = Object.fromEntries(body.protected.map((p) => [p.channelId, p]));
  assert.match(leased[channels[0].id]?.reason ?? "", /^sold on Magma \(order magma-sa…\) — leased until block 863,024/);
  assert.equal(leased[channels[0].id]?.lease?.kind, "magma_sale");
  assert.match(leased[channels[2].id]?.reason ?? "", /^sold to an LSP client \(order lsp-sale…\) — this node promised to keep it open until block 867,200/);
  assert.deepEqual(body.pending.map((p) => [p.channelId, p.status]), [[`${TX(4)}:0`, "pending_open"]]);
});

test("GET /suggestions/close: where a close's capital could go names the opens the channel autopilot would make — not the top suggestions as ranked", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const { api, channels } = await setup(t);
  // (The autopilot's peer rules and LN+: swapTargets.)
  let asked = 0;
  api.autopilot.swapTargets = async () => {
    asked += 1;
    return [{ alias: "the-autopilots-pick", score: 70, sizeSats: 1_000_000 }];
  };
  const res = await api.request("GET", "/suggestions/close");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [c] = res.body.candidates as { channelId: string; reasons: string[]; opportunityCandidates: { alias: string }[] }[];
  assert.equal(c?.channelId, channels[1].id);
  assert.ok(c.reasons.includes("Frees 2,000k you could redeploy into the-autopilots-pick."), c.reasons.join(" | "));
  assert.deepEqual(c.opportunityCandidates.map((o) => o.alias), ["the-autopilots-pick"]);
  assert.equal(asked, 1);
});

test("POST /channels/close refuses a channel inside its lease unless the request says breakLease — and a channel still opening at all", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const { api, node } = await setup(t);
  const closes = () => node.callsTo("default.closeChannel").length;
  const leased = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 2 });
  assert.equal(leased.status, 409);
  assert.equal(leased.body.error, "lease_active");
  assert.match(leased.body.message, /^Not closed: this channel was sold on Magma \(order magma-sa…\) — leased until block 863,024 \(~\d+ d left\); closing it early breaks the lease the buyer paid for/);
  assert.equal(leased.body.lease.kind, "magma_sale");
  assert.equal(closes(), 0, "nothing reached LND");
  const forced = await api.request("POST", "/channels/close", { transactionId: TX(3), transactionVout: 0, isForce: true });
  assert.equal(forced.status, 409, "a force-close too");
  const opening = await api.request("POST", "/channels/close", { transactionId: TX(4), transactionVout: 0, isForce: true });
  assert.deepEqual([opening.status, opening.body.error], [409, "pending"]);
  const bad = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, breakLease: "yes" });
  assert.equal(bad.status, 400);
  assert.equal(closes(), 0);

  // The operator confirmed breaking it: closed.
  const confirmed = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 2, breakLease: true });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.ok, true, confirmed.body.error);
  // An ordinary channel needs nothing extra.
  const plain = await api.request("POST", "/channels/close", { transactionId: TX(2), transactionVout: 0, isForce: false, feeRate: 2 });
  assert.equal(plain.body.ok, true, plain.body.error);
  assert.equal(closes(), 2);
});

test("GET /channels: each channel's lease and how long its peer has been away; POST /peers/connect dials a peer back", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const { api, node, channels } = await setup(t);
  node.channels[1].isActive = false;
  const res = await api.request("GET", "/channels");
  assert.equal(res.status, 200);
  const byId = Object.fromEntries((res.body as { id: string }[]).map((c) => [c.id, c])) as unknown as Record<
    string,
    { lease: { kind: string; running: boolean; untilHeight: number | null } | null; offline: { hours: number | null; long: boolean } | null; csvDelayBlocks?: number; commitFeeSats?: number }
  >;
  assert.deepEqual([byId[channels[0].id].lease?.kind, byId[channels[0].id].lease?.running, byId[channels[0].id].lease?.untilHeight], ["magma_sale", true, 863_024]);
  assert.equal(byId[channels[2].id].lease?.kind, "lsps1_sale");
  assert.equal(byId[channels[1].id].lease, null);
  assert.deepEqual([byId[channels[1].id].offline?.hours, byId[channels[1].id].offline?.long], [0, false], "just seen offline: not a close signal");
  assert.equal(byId[channels[0].id].offline, null);
  assert.deepEqual([byId[channels[0].id].csvDelayBlocks, byId[channels[0].id].commitFeeSats], [144, 2810]);
  assert.equal(byId[`${TX(4)}:0`].lease, null);

  const peer = "03" + "11".repeat(32);
  const connected = await api.request("POST", "/peers/connect", { pubkey: peer, socket: "abcdefghijklmnop.onion:9735" });
  assert.deepEqual(connected.body, { ok: true });
  assert.ok(node.peers.includes(peer));
  const bad = await api.request("POST", "/peers/connect", { pubkey: "nope" });
  assert.equal(bad.status, 400);
});

test("a sale Amboss lists with a running lease but this node's journal never recorded (sold before the journal existed): protected and refused to close like any other lease", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const id = `${HEIGHT - 9_000}x7x0`;
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [{ id, partnerPublicKey: PEER(7), capacity: 3_000_000, localBalance: 3_000_000, transactionId: TX(7), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 }],
  });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const api = await startApi(t, { node });
  magma.sellerPubkey = node.publicKey;
  api.amboss.setKey("test-key");
  magma.addSale({ buyerPubkey: PEER(7), status: "VALID_CHANNEL_OPENING", sizeSats: 3_000_000, channelId: chanNumber(id) });
  // The deploy cap's listing (every main run, the order lane, the selling check).
  await api.autopilot.magma.refreshDeployed(true);
  const list = await api.request("GET", "/suggestions/close");
  assert.deepEqual(list.body.candidates, []);
  assert.match(list.body.protected[0]?.reason ?? "", /— Amboss reports its lease still running/);
  const close = await api.request("POST", "/channels/close", { transactionId: TX(7), transactionVout: 0, isForce: false, feeRate: 2 });
  assert.deepEqual([close.status, close.body.error], [409, "lease_active"]);
  // Once Amboss's listing no longer has it (lease over), it is a channel like any other.
  magma.setStatus([...magma.sales.keys()][0], "CHANNEL_MONITORING_FINISHED");
  await api.autopilot.magma.refreshDeployed(true);
  const after = await api.request("GET", "/suggestions/close");
  assert.deepEqual(after.body.candidates.map((c: { channelId: string }) => c.channelId), [id]);
});

// ── review of P4: one registry everywhere, purchases matched carefully, the
//    Amboss listing kept ─────────────────────────────────────────────────────

const SELLER = "02" + "77".repeat(32);

/** A Magma purchase on record (the purchase ledger's shape): ordered and
 *  paid 15 days ago — before the seller funded any channel these tests give
 *  it (the registry never takes a channel older than the order). */
const bought = (o: Record<string, unknown> = {}) => ({
  orderId: "buy-order-1",
  createdAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
  updatedAt: new Date().toISOString(),
  offerId: null,
  sellerPubkey: SELLER,
  sizeSats: 3_000_000,
  feeSats: 18_000,
  paymentRequest: "lnbc1",
  paymentHash: "aa".repeat(32),
  payee: SELLER,
  expiresAt: new Date().toISOString(),
  leaseBlocks: 8_640,
  feeRateCapPpm: 2200,
  baseFeeCapSats: 1,
  usdCents: null,
  state: "channel_open",
  routingFeeSats: 12,
  paidAt: new Date(Date.now() - 15 * 86_400_000 + 10 * 60_000).toISOString(),
  orderStatus: "VALID_CHANNEL_OPENING",
  channelId: null,
  ...o,
});

test("the close route judges a purchase against every channel, as the Channels table does: the seller's other channel of that size, shown unleased, closes — the bought one is refused", async (t) => {
  t.mock.method(console, "log", () => undefined);
  // The seller opened two 3M channels to us: X (newer) was bought, Y (older) not.
  const X = { id: `${HEIGHT - 1_000}x1x0`, partnerPublicKey: SELLER, capacity: 3_000_000, localBalance: 0, transactionId: TX(31), transactionVout: 0, partnerInitiated: true };
  const Y = { id: `${HEIGHT - 2_000}x2x0`, partnerPublicKey: SELLER, capacity: 3_000_000, localBalance: 0, transactionId: TX(32), transactionVout: 0, partnerInitiated: true };
  const node = feeNode({ blockHeight: HEIGHT, channels: [X, Y] });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "magma-purchases.json"), JSON.stringify([bought()]));
  const api = await startApi(t, { node, dir });
  const table = Object.fromEntries(((await api.request("GET", "/channels")).body as { id: string; lease: { kind: string } | null }[]).map((c) => [c.id, c.lease]));
  assert.equal(table[X.id]?.kind, "magma_purchase");
  assert.equal(table[Y.id], null, "the table shows Y unleased");
  // Before: the route matched Y alone — the purchase claimed it, 409 lease_active.
  const closeY = await api.request("POST", "/channels/close", { transactionId: TX(32), transactionVout: 0, isForce: false, feeRate: 2 });
  assert.equal(closeY.status, 200, JSON.stringify(closeY.body));
  assert.equal(closeY.body.ok, true, closeY.body.error);
  const closeX = await api.request("POST", "/channels/close", { transactionId: TX(31), transactionVout: 0, isForce: false, feeRate: 2 });
  assert.deepEqual([closeX.status, closeX.body.error, closeX.body.lease?.kind], [409, "lease_active", "magma_purchase"]);
  // breakLease: false is no confirmation.
  const notConfirmed = await api.request("POST", "/channels/close", { transactionId: TX(31), transactionVout: 0, isForce: false, feeRate: 2, breakLease: false });
  assert.deepEqual([notConfirmed.status, notConfirmed.body.error], [409, "lease_active"]);
  assert.equal(node.callsTo("default.closeChannel").length, 1, "only Y reached LND");
});

test("a purchase claims the channel Amboss names, or none — a named channel since closed doesn't pass the lease to another of the seller's; and only a channel the seller opened is ever claimed", () => {
  const ref = (id: string, initiator: "local" | "remote", tx: number) => ({
    id,
    transactionId: TX(tx),
    transactionVout: 0,
    peerPubkey: SELLER,
    capacity: 3_000_000,
    initiator,
  });
  const Y = ref(`${HEIGHT - 2_000}x2x0`, "remote", 32);
  // The bought channel was 855000x9x0 — closed since (not in the list).
  const gone = channelLeases([Y], { soldLeases: [], purchases: [bought({ channelId: "855000x9x0" }) as never] }, HEIGHT);
  assert.equal(gone.size, 0, "Y was never bought");
  // Named and present: claimed.
  const named = channelLeases([Y], { soldLeases: [], purchases: [bought({ channelId: chanNumber(Y.id) }) as never] }, HEIGHT);
  assert.equal(named.get(Y.id)?.kind, "magma_purchase");
  // Not named yet: the seller's channel of that size — one it opened, never one this node opened.
  const ours = ref(`${HEIGHT - 500}x5x0`, "local", 35);
  const unnamed = channelLeases([ours], { soldLeases: [], purchases: [bought() as never] }, HEIGHT);
  assert.equal(unnamed.size, 0, "this node's own channel to the seller is not the purchase");
  assert.equal(channelLeases([ours, Y], { soldLeases: [], purchases: [bought() as never] }, HEIGHT).get(Y.id)?.kind, "magma_purchase");
  // A channel of the seller's already closing (its id the funding outpoint)
  // doesn't take the purchase from the open one.
  const closing = { ...ref(`${TX(36)}:0`, "remote", 36), status: "pending_close" as const };
  const both = channelLeases([closing, { ...Y, status: "open" as const }], { soldLeases: [], purchases: [bought() as never] }, HEIGHT);
  assert.deepEqual([both.get(Y.id)?.kind, both.has(closing.id)], ["magma_purchase", false]);
});

test("the Amboss listing of older sales is kept on disk — a restart still protects them — and asked again before the close list goes by one more than an hour old", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const id = `${HEIGHT - 9_000}x7x0`;
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [{ id, partnerPublicKey: PEER(7), capacity: 3_000_000, localBalance: 3_000_000, transactionId: TX(7), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 }],
  });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  magma.sellerPubkey = node.publicKey;
  const sale = magma.addSale({ buyerPubkey: PEER(7), status: "VALID_CHANNEL_OPENING", sizeSats: 3_000_000, channelId: chanNumber(id) });
  const dir = makeTempDir(t);
  const first = await startApi(t, { node, dir });
  first.amboss.setKey("test-key");
  await first.autopilot.magma.refreshDeployed(true);
  const kept = JSON.parse(readFileSync(join(dir, "magma-amboss-leases.json"), "utf8")) as { at: string; leases: { orderId: string; channelId: string }[] };
  assert.deepEqual(kept.leases, [{ orderId: sale.id, channelId: chanNumber(id) }]);

  // A restart, the listing minutes old: the new process knows the lease
  // without asking Amboss (before: nothing until selling refreshed it).
  const salesReads = () => http.requests.filter((r) => /sales/.test(r.body ?? "")).length;
  const readsBefore = salesReads();
  const second = await startApi(t, { node, dir });
  const list = await second.request("GET", "/suggestions/close");
  assert.deepEqual(list.body.candidates, []);
  assert.match(list.body.protected[0]?.reason ?? "", /— Amboss reports its lease still running; closing it early breaks/);
  const refused = await second.request("POST", "/channels/close", { transactionId: TX(7), transactionVout: 0, isForce: false, feeRate: 2 });
  assert.deepEqual([refused.status, refused.body.error], [409, "lease_active"]);
  assert.equal(salesReads(), readsBefore, "a listing minutes old is not asked again");

  // Hours later the lease is over on Amboss: the close list asks again
  // first (a key is set), and the channel is one like any other.
  magma.setStatus(sale.id, "CHANNEL_MONITORING_FINISHED");
  writeFileSync(join(dir, "magma-amboss-leases.json"), JSON.stringify({ ...kept, at: new Date(Date.now() - 3 * 3_600_000).toISOString() }));
  const third = await startApi(t, { node, dir });
  const after = await third.request("GET", "/suggestions/close");
  assert.ok(salesReads() > readsBefore, "asked Amboss again");
  assert.deepEqual(after.body.candidates.map((c: { channelId: string }) => c.channelId), [id]);

  // Without an Amboss key nothing can be asked: the last listing known (here
  // three days old, on a disk without the key) stands, and says from when it is.
  const keylessDir = makeTempDir(t);
  writeFileSync(join(keylessDir, "magma-amboss-leases.json"), JSON.stringify({ ...kept, at: new Date(Date.now() - 3 * 86_400_000).toISOString() }));
  const keyless = await startApi(t, { node, dir: keylessDir });
  const stale = await keyless.request("GET", "/suggestions/close");
  assert.match(stale.body.protected[0]?.reason ?? "", /— Amboss reports its lease still running \(as of \d{4}-\d{2}-\d{2}\); closing it early/);
});

// Review of P4: only GET /suggestions/close was tested for asking Amboss
// again; POST /channels/close reading the cached listing passed every test.
test("POST /channels/close asks Amboss again when its listing is over an hour old — as the first request after a start: a lease Amboss says is over closes, one still running is refused", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const salesReads = () => http.requests.filter((r) => /sales/.test(r.body ?? "")).length;
  const id = `${HEIGHT - 9_000}x7x0`;
  for (const [status, closes] of [["CHANNEL_MONITORING_FINISHED", true], ["VALID_CHANNEL_OPENING", false]] as const) {
    const node = feeNode({
      blockHeight: HEIGHT,
      channels: [{ id, partnerPublicKey: PEER(7), capacity: 3_000_000, localBalance: 3_000_000, transactionId: TX(7), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 }],
    });
    node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
    magma.sellerPubkey = node.publicKey;
    magma.sales.clear();
    // A sale only Amboss knows of (no journal record); the listing on disk —
    // 3 hours old — still has its lease running.
    const sale = magma.addSale({ buyerPubkey: PEER(7), status, sizeSats: 3_000_000, channelId: chanNumber(id) });
    const dir = makeTempDir(t);
    writeFileSync(
      join(dir, "magma-amboss-leases.json"),
      JSON.stringify({ at: new Date(Date.now() - 3 * 3_600_000).toISOString(), leases: [{ orderId: sale.id, channelId: chanNumber(id) }] }),
    );
    const api = await startApi(t, { node, dir });
    api.amboss.setKey("test-key");
    const before = salesReads();
    const res = await api.request("POST", "/channels/close", { transactionId: TX(7), transactionVout: 0, isForce: false, feeRate: 2 });
    assert.ok(salesReads() > before, `${status}: Amboss is asked again before the close`);
    if (closes) {
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.ok, true, res.body.error);
      assert.equal(node.callsTo("default.closeChannel").length, 1, "the lease is over on Amboss: closed");
    } else {
      assert.deepEqual([res.status, res.body.error], [409, "lease_active"], "still running on Amboss");
      assert.equal(node.callsTo("default.closeChannel").length, 0);
    }
  }
});

// ── review 2 of P4: a repeat purchase, and Amboss's word on a sale's lease ──

type LeaseBody = { orderId: string; running: boolean; untilHeight: number | null; blocksLeft: number | null; leaseBlocks: number; reportedByAmboss?: boolean } | null;

test("a repeat purchase from the same seller at the same size, paid but its channel not open yet, leaves the earlier purchase's channel its lease — in the table, the close list and the close route — and claims its own channel once it is opening", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const DAY = 86_400_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  // X: bought 150 days ago (order B, a 180-day lease: a month left), idle, all inbound.
  const X = { id: `${HEIGHT - 21_600}x1x0`, partnerPublicKey: SELLER, capacity: 3_000_000, localBalance: 0, transactionId: TX(41), transactionVout: 0, partnerInitiated: true };
  const node = feeNode({ blockHeight: HEIGHT, channels: [X] });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "magma-purchases.json"),
    JSON.stringify([
      bought({ orderId: "older-B-180d", leaseBlocks: 25_920, channelId: chanNumber(X.id), createdAt: ago(150 * DAY + 600_000), paidAt: ago(150 * DAY) }),
      // A: ordered minutes ago, its payment held by the hold invoice
      // ("paying") until Amboss confirms the channel — not funded yet.
      bought({ orderId: "newer-A-30d", leaseBlocks: 4_320, state: "paying", orderStatus: "WAITING_FOR_CHANNEL_OPEN", channelId: null, createdAt: ago(1_200_000), paidAt: undefined, payStartedAt: ago(600_000), routingFeeSats: null }),
    ]),
  );
  const api = await startApi(t, { node, dir });
  const leaseOf = async (id: string) => ((await api.request("GET", "/channels")).body as { id: string; lease: LeaseBody }[]).find((c) => c.id === id)?.lease ?? null;
  // Before: X read "bought on Magma · lease over" (A's 30-day lease from
  // X's funding), was a close candidate, and POST /channels/close closed it.
  const l = await leaseOf(X.id);
  assert.deepEqual([l?.orderId, l?.running, l?.blocksLeft], ["older-B-180d", true, 4_464]);
  const list = await api.request("GET", "/suggestions/close");
  assert.deepEqual(list.body.candidates, []);
  assert.match(list.body.protected[0]?.reason ?? "", /^bought on Magma for 18,012 sat \(order older-B-…\) — the inbound you paid for is leased until block 864,464/);
  const close = await api.request("POST", "/channels/close", { transactionId: TX(41), transactionVout: 0, isForce: false, feeRate: 2 });
  assert.deepEqual([close.status, close.body.error, close.body.lease?.orderId], [409, "lease_active", "older-B-180d"]);
  assert.equal(node.callsTo("default.closeChannel").length, 0, "nothing reached LND");

  // A's channel is opening: A claims it, and X keeps B's lease.
  node.pending.push({ partnerPublicKey: SELLER, capacity: 3_000_000, transactionId: TX(42), transactionVout: 0, partnerInitiated: true });
  const opening = await leaseOf(`${TX(42)}:0`);
  assert.deepEqual([opening?.orderId, opening?.running, opening?.untilHeight], ["newer-A-30d", true, null]);
  assert.equal((await leaseOf(X.id))?.orderId, "older-B-180d");
});

test("a sale whose lease the journal counts as over while Amboss's listing still has it running: protected in the close list and the table, refused by the close route — Amboss says when it ends", async (t) => {
  t.mock.method(console, "log", () => undefined);
  // Sold with a 30-day lease and funded 32 days ago (4,608 blocks): by the
  // journal's count (funding + lease + a day) over 144 blocks ago. Amboss
  // confirmed the channel late; its listing — on disk, minutes old — still
  // has the lease running.
  const id = `${HEIGHT - 4_608}x9x0`;
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [{ id, partnerPublicKey: PEER(9), capacity: 2_000_000, localBalance: 2_000_000, transactionId: TX(9), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 }],
  });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const journal = (dir: string) => {
    const at = new Date(Date.now() - 33 * 86_400_000).toISOString();
    writeFileSync(
      join(dir, "magma-orders.json"),
      JSON.stringify([
        {
          orderId: "sale-1", phase: "settled", via: "autopilot", createdAt: at, updatedAt: at, settledAt: at, buyerPubkey: PEER(9),
          sizeSats: 2_000_000, isPrivate: false, feeMsat: "12345000", leaseBlocks: 4_320, feeRateCapPpm: 2200, baseFeeCapSats: 1,
          invoice: null, acceptAttempts: 1, openAttempts: 1, reportAttempts: 1, fundingOutpoint: `${TX(9)}:0`, events: [],
        },
      ]),
    );
  };

  // The journal alone: the lease is over — an idle channel like any other.
  const journalOnlyDir = makeTempDir(t);
  journal(journalOnlyDir);
  const journalOnly = await startApi(t, { node, dir: journalOnlyDir });
  assert.deepEqual((await journalOnly.request("GET", "/suggestions/close")).body.candidates.map((c: { channelId: string }) => c.channelId), [id]);

  const dir = makeTempDir(t);
  journal(dir);
  writeFileSync(join(dir, "magma-amboss-leases.json"), JSON.stringify({ at: new Date().toISOString(), leases: [{ orderId: "sale-1", channelId: chanNumber(id) }] }));
  const api = await startApi(t, { node, dir });
  // Before: the ended journal record kept Amboss's listing out — a candidate,
  // and closed without asking.
  const list = await api.request("GET", "/suggestions/close");
  assert.deepEqual(list.body.candidates, []);
  assert.match(list.body.protected[0]?.reason ?? "", /^sold on Magma \(order sale-1…\) — Amboss reports its lease still running; closing it early breaks the lease the buyer paid for/);
  const table = ((await api.request("GET", "/channels")).body as { id: string; lease: LeaseBody }[]).find((c) => c.id === id)?.lease;
  assert.deepEqual([table?.orderId, table?.leaseBlocks, table?.running, table?.reportedByAmboss, table?.untilHeight], ["sale-1", 4_320, true, true, null]);
  const refused = await api.request("POST", "/channels/close", { transactionId: TX(9), transactionVout: 0, isForce: false, feeRate: 2 });
  assert.deepEqual([refused.status, refused.body.error, refused.body.lease?.reportedByAmboss], [409, "lease_active", true]);
  assert.equal(node.callsTo("default.closeChannel").length, 0, "nothing reached LND");
  const confirmed = await api.request("POST", "/channels/close", { transactionId: TX(9), transactionVout: 0, isForce: false, feeRate: 2, breakLease: true });
  assert.equal(confirmed.body.ok, true, confirmed.body.error);
  assert.equal(node.callsTo("default.closeChannel").length, 1);
});

// ── review of P4: the offline duration accrues on its own ────────────────────

const HOUR = 3_600_000;

/** One channel whose peer is away (inactive), on a fee-engine-ready node. */
function awayNode() {
  const node = feeNode({
    blockHeight: HEIGHT,
    channels: [{ id: `${HEIGHT - 9_000}x1x0`, partnerPublicKey: PEER(1), capacity: 2_000_000, localBalance: 2_000_000, transactionId: TX(1), transactionVout: 0, isActive: false, feeRatePpm: 100, baseFeeMsat: 0 }],
  });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  return node;
}

test("a started autopilot counts how long a peer is away by itself — every 10 minutes, on disk — with nobody reading the API: 72 hours later the channel counts as long offline", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const t0 = Date.parse("2026-10-20T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: t0 });
  const node = awayNode();
  const dir = makeTempDir(t);
  // Read-only: no main runs, no order lane — only the uptime timer.
  const autopilot = new Autopilot(dir, node.lnd, undefined, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  t.after(() => autopilot.shutdown());
  autopilot.start();
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  };
  await settle();
  for (let step = 0; step < 6 * 73; step++) {
    t.mock.timers.tick(10 * 60_000);
    await settle();
  }
  const id = `${HEIGHT - 9_000}x1x0`;
  const onDisk = JSON.parse(readFileSync(join(dir, "channel-uptime.json"), "utf8")) as { inactiveSince: Record<string, string> };
  assert.equal(onDisk.inactiveSince[id], new Date(t0).toISOString(), "away since the first look");
  const info = autopilot.uptime.offlineInfo({ id, active: false }, Date.now());
  assert.deepEqual([info?.hours, info?.long], [73, true]);
});

test("the Channels table and the close list each record what they see: polled through 73 hours, either one alone counts the outage", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const t0 = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: t0 });
  const id = `${HEIGHT - 9_000}x1x0`;
  // A look every 110 minutes (the series allows 2 h between looks), the last at 73 h.
  const looks: number[] = [];
  for (let at = 0; at < 73 * HOUR; at += 110 * 60_000) looks.push(at);
  looks.push(73 * HOUR);
  // Only GET /channels.
  const table = await startApi(t, { node: awayNode() });
  let row: { offline: { hours: number | null; long: boolean } | null } | undefined;
  for (const at of looks) {
    t.mock.timers.setTime(t0 + at);
    row = ((await table.request("GET", "/channels")).body as { id: string; offline: { hours: number | null; long: boolean } | null }[]).find((c) => c.id === id);
  }
  assert.deepEqual([row?.offline?.hours, row?.offline?.long], [73, true], JSON.stringify(row?.offline));

  // Only the close list, on a node of its own.
  const list = await startApi(t, { node: awayNode() });
  let body: { candidates: { channelId: string; reasons: string[] }[] } | undefined;
  for (const at of looks) {
    t.mock.timers.setTime(t0 + at);
    body = (await list.request("GET", "/suggestions/close")).body;
  }
  const c = body?.candidates.find((x) => x.channelId === id);
  assert.equal(c?.reasons[0], "Offline for ~3 d — peer unreachable.", JSON.stringify(c?.reasons));
});
