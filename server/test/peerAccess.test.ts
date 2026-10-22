/**
 * A write macaroon without peers:read (review of P8, final round).
 *
 * SECURITY.md's least-privilege recipe left peers:read out, while every
 * channel open checks its connection to the peer with LND's ListPeers on the
 * write client — LightningMate's own check (channelOps), and the lightning
 * library's addPeer right after it dials. The check swallowed LND's refusal
 * and read it as "not connected": every open said the peer looked offline,
 * the channel autopilot backed healthy peers off for a day, a week, a month,
 * the Magma lane turned every order down as "the buyer's node is
 * unreachable", and LSP mode refunded every paid order.
 *
 * Now the recipe has peers:read (docsMatchCode.test.ts holds it to what the
 * code calls), and LND's refusal is said for what it is — this node's setup,
 * blocked, naming the permission — wherever an open runs into it.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { addPeer } from "lightning";
import {
  MissingPermission,
  PEERS_READ_MISSING,
  checkPeerListing,
  connectForOpen,
  ensureConnected,
  fundChannel,
  isPreBroadcastRefusal,
  nodeSideRefusal,
  opensBlocked,
} from "../src/services/channelOps.js";
import { errorText } from "../src/services/errorText.js";
import { magmaRefusalAlerts } from "../src/services/alerts.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { makeNodeKey, parsePaymentRequest } from "./helpers/bolt11.js";
import { BUYER, GOSSIP_PEER, autopilotWith, sellerSetup, suggestion } from "./helpers/autopilot.js";
import { FakeMagma } from "./helpers/magma.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { startApi } from "./helpers/apiHarness.js";
import { lspNode, lspsWallet, zeusOrder, type LspNode } from "./helpers/lsps.js";
import { IN_AN_HOUR, entryOnDisk, quiet } from "./helpers/lifecycle.js";
import { until } from "./helpers/wait.js";

const NO_PEERS_READ = ["default.listPeers"];
const PK = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);

// ── the connect check ────────────────────────────────────────────────────────

test("the lightning library's addPeer checks its own connect with ListPeers: without peers:read it fails though ConnectPeer went through — why the recipe needs it", async () => {
  const peer = makeNodeKey().publicKey;
  const node = new FakeLnd({ peers: [] });
  const write = node.withoutPermission(...NO_PEERS_READ);
  await assert.rejects(
    addPeer({ lnd: write, public_key: peer, socket: "1.2.3.4:9735", retry_count: 1 }),
    (err: unknown) => /permission denied/.test(errorText(err)),
  );
  assert.equal(node.callsTo("default.connectPeer").length, 1, "ConnectPeer went through");
  assert.ok(node.peers.includes(peer), "the peer is connected in LND");
});

test("an open's connect check without peers:read: blocked, naming the permission — not 'the peer looks offline' — and no peer is dialed whose connection can't be checked", async () => {
  const peer = makeNodeKey().publicKey;
  for (const connected of [false, true]) {
    const node = new FakeLnd({ peers: connected ? [peer] : [] });
    const write = node.withoutPermission(...NO_PEERS_READ);
    const res = await connectForOpen(write, { pubkey: peer, socket: "1.2.3.4:9735" });
    // Before: { ok: false, error: "couldn't connect to 03c8109e984f… — the peer looks offline. Try again later." }
    assert.deepEqual(res, { ok: false, error: PEERS_READ_MISSING, blocked: true }, `connected: ${connected}`);
    assert.equal(node.callsTo("default.connectPeer").length, 0);
    await assert.rejects(ensureConnected(write, peer, ["1.2.3.4:9735"]), (err: unknown) => err instanceof MissingPermission && err.permission === "peers:read");
    assert.equal(opensBlocked(write), PEERS_READ_MISSING, "remembered for the write client");
    assert.equal(opensBlocked(node.lnd), null, "not for another client of the node (the read macaroon)");
  }
  assert.match(PEERS_READ_MISSING, /^the write macaroon lacks peers:read/);
  assert.match(PEERS_READ_MISSING, /SECURITY\.md\) and restart LightningMate$/);
  assert.doesNotMatch(PEERS_READ_MISSING, /offline|unreachable|couldn't connect/);
});

test("LND listing its peers again clears it; a listing that fails otherwise is no permission problem — the peer just isn't connected", async () => {
  const peer = makeNodeKey().publicKey;
  const node = new FakeLnd({ peers: [] });
  node.failNext("default.listPeers", "permission denied");
  await checkPeerListing(node.lnd);
  assert.equal(opensBlocked(node.lnd), PEERS_READ_MISSING);
  await checkPeerListing(node.lnd);
  assert.equal(opensBlocked(node.lnd), null, "listed again: no longer blocked");
  node.override("default.listPeers", (_a, cb) => cb({ details: "unavailable" }));
  const res = await connectForOpen(node.lnd, { pubkey: peer });
  assert.deepEqual(res, { ok: false, error: `couldn't connect to ${peer.slice(0, 12)}… — the peer looks offline. Try again later.` });
  assert.equal(opensBlocked(node.lnd), null);
});

test("LND refusing the open itself to the write macaroon is this node's setup, and came before any funding", async () => {
  const node = new FakeLnd({ chainBalance: 5_000_000, peers: [PK(1)] });
  const res = await fundChannel(node.withoutPermission("default.openChannel"), { pubkey: PK(1), localTokens: 1_000_000 });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /permission denied/);
  assert.equal(isPreBroadcastRefusal(res.error ?? ""), true, "no 'unclear' open to look for in LND");
  assert.match(nodeSideRefusal(res.error ?? "") ?? "", /^the write macaroon may not open channels \(LND: permission denied/);
  // A peer's refusal that says so is still the peer's.
  assert.equal(nodeSideRefusal(`received funding error from ${PK(1)}: permission denied`), null);
  assert.equal(node.pending.length, 0);
});

// ── the channel autopilot ─────────────────────────────────────────────────────

function channelStage(t: TestContext, writeDenied: string[]) {
  const env = autopilotWith(
    t,
    { channelEnabled: true, channelCooldownMinutes: 360 },
    {},
    {},
    new FakeLnd({ chainBalance: 20_000_000, peers: [GOSSIP_PEER] }),
    writeDenied,
  );
  env.seams.openFeeRate = async () => 2;
  env.node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  const books = (env.autopilot as unknown as { state: { peerOpenFailures?: Record<string, unknown> } }).state;
  return { ...env, books };
}

test("the channel autopilot without peers:read: no open, no healthy peer held back, the area blocked naming the permission — and later runs work nothing out until LND lists peers again", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const s = channelStage(t, NO_PEERS_READ);
  let planned = 0;
  s.seams.channelSuggestions = async () => {
    planned += 1;
    return { suggestions: [{ ...suggestion, pubkey: PK(1), alias: "healthy" }, { ...suggestion, pubkey: PK(2), alias: "also-healthy" }] };
  };
  const run = await s.autopilot.runOnce();
  assert.deepEqual(run.channels.map((c) => [c.alias, c.ok]), [["healthy", false]], "one try: every other peer would fail the same way");
  assert.equal(run.channels[0].error, PEERS_READ_MISSING);
  // Before: "couldn't connect … the peer looks offline", and a day's back-off
  // for each healthy peer, then a week's, then a month's.
  assert.deepEqual(s.books.peerOpenFailures ?? {}, {}, "nobody held back for this node's macaroon");
  assert.equal(s.node.callsTo("default.connectPeer").length, 0);
  assert.equal(s.node.callsTo("default.openChannel").length, 0);
  const decision = s.autopilot.getState().decisions.channels;
  assert.equal(decision?.state, "blocked");
  assert.equal(decision?.text, `no channel opened — ${PEERS_READ_MISSING}`);
  const area = s.autopilot.areaStatus().channels;
  assert.equal(area.state, "blocked");
  assert.equal(area.text, `no channel can be opened: ${PEERS_READ_MISSING}`);
  assert.equal(s.autopilot.getState().history.length, 1);

  // The next run asks LND again — still refused: no plan, no dial, no line.
  await s.autopilot.runOnce();
  assert.equal(planned, 1, "no suggestions (LN+ lookups and all) for an open that can't go out");
  assert.equal(s.autopilot.getState().decisions.channels?.state, "blocked");
  assert.equal(s.autopilot.getState().history.length, 1, "one line of history for it");
});

// Review of P8, run 2: the run's own ask before it stays blocked was untested
// — without it, a block once remembered held the channel autopilot for good
// (until some other path happened to list peers on the write client), however
// often LND listed them again.
test("a block the channel autopilot remembers is asked again at its next run: LND listing its peers to the write macaroon again, the run plans and opens — and the area is blocked no more", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const s = channelStage(t, []);
  s.seams.channelSuggestions = async () => ({ suggestions: [{ ...suggestion, pubkey: PK(4), alias: "back" }] });
  // Refused once — at the start probe, or an earlier run's open: remembered.
  s.node.failNext("default.listPeers", "permission denied");
  await checkPeerListing(s.node.lnd);
  assert.equal(s.autopilot.areaStatus().channels.state, "blocked");
  const run = await s.autopilot.runOnce();
  assert.equal(s.node.callsTo("default.openChannel").length, 1, JSON.stringify(run.channels));
  assert.deepEqual(run.channels.map((c) => [c.alias, c.ok]), [["back", true]]);
  assert.notEqual(s.autopilot.getState().decisions.channels?.state, "blocked");
  assert.notEqual(s.autopilot.areaStatus().channels.state, "blocked");
  assert.equal(opensBlocked(s.node.lnd), null);
});

test("a write macaroon LND refuses the open itself: not the peer's doing either — the area is blocked and no peer is held back", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const s = channelStage(t, ["default.openChannel"]);
  s.seams.channelSuggestions = async () => ({ suggestions: [{ ...suggestion, pubkey: PK(3), alias: "fine" }] });
  const run = await s.autopilot.runOnce();
  assert.equal(run.channels[0]?.ok, false);
  assert.deepEqual(s.books.peerOpenFailures ?? {}, {});
  const decision = s.autopilot.getState().decisions.channels;
  assert.equal(decision?.state, "blocked");
  assert.match(decision?.text ?? "", /^no channel opened — the write macaroon may not open channels \(LND: permission denied/);
  // Not an open whose funding may be out: no cooldown as after an unclear one.
  assert.equal((s.autopilot as unknown as { state: { lastChannelOpenUnclear?: string | null } }).state.lastChannelOpenUnclear ?? null, null);
});

test("at start, a write macaroon without peers:read shows the channel and Magma areas blocked — before an open or an order runs into it", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { channelEnabled: true }, writeDenied: NO_PEERS_READ });
  assert.equal(s.autopilot.areaStatus().magma.state, "not_run", "nothing known before the start");
  s.autopilot.start();
  await until(() => s.autopilot.areaStatus().magma.state === "blocked", "probed at start");
  const status = s.autopilot.areaStatus();
  assert.equal(status.magma.text, `new orders are turned down, and a paid order's channel can't be opened: ${PEERS_READ_MISSING}`);
  assert.equal(status.channels.state, "blocked");
  assert.equal(status.channels.text, `no channel can be opened: ${PEERS_READ_MISSING}`);
  assert.notEqual(status.fees.state, "blocked", "fees need no peer listing");

  // With a macaroon that has it, nothing is blocked.
  const fine = sellerSetup(t, { config: { channelEnabled: true } });
  fine.autopilot.start();
  await until(() => fine.node.callsTo("default.listPeers").length > 0, "probed at start");
  await new Promise((r) => setTimeout(r, 20));
  assert.notEqual(fine.autopilot.areaStatus().magma.state, "blocked");
  assert.notEqual(fine.autopilot.areaStatus().channels.state, "blocked");
});

// ── Magma ─────────────────────────────────────────────────────────────────────

test("the Magma lane without peers:read: a new order is still turned down at once (D6) — for what it is, the macaroon named — and the lane, the area and the alert say so", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { writeDenied: NO_PEERS_READ });
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(sale.id)?.status, "SELLER_REJECTED", "rejected via seller.reject, not left to time out");
  const e = entryOnDisk(s.dir, sale.id);
  assert.equal(e?.phase, "rejected");
  // Before: "the buyer's node is unreachable" — for every order.
  assert.equal(e?.reason, `this node can't check its connection to the buyer: ${PEERS_READ_MISSING}`);
  assert.equal(s.node.callsTo("default.connectPeer").length, 0);
  assert.equal(s.node.callsTo("invoices.addHoldInvoice").length, 0);
  assert.equal(s.magma.count("AcceptOrder"), 0);
  const lane = s.autopilot.magma.laneStatus();
  assert.equal(lane.ok, false);
  assert.equal(lane.error, PEERS_READ_MISSING);
  assert.equal(lane.retrying, false, "it won't clear by itself");
  assert.equal(s.autopilot.areaStatus().magma.state, "blocked");
  const [alert] = magmaRefusalAlerts(s.autopilot.magma);
  assert.match(alert?.message ?? "", /was turned down: this node can't check its connection to the buyer: the write macaroon lacks peers:read/);
});

test("accepting by hand without peers:read: refused (403) naming the permission — the order is not rejected, it stays yours to accept once the macaroon is fixed", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance: 20_000_000 }), writeDenied: NO_PEERS_READ });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: IN_AN_HOUR() });
  const res = await api.request("POST", "/amboss/order/accept", { id: sale.id });
  assert.equal(res.status, 403, JSON.stringify(res.body));
  assert.equal(res.body.code, "permission");
  // Before: 409 "The buyer's node is unreachable right now — rejecting the order is safer than accepting it."
  assert.equal(res.body.message, `Not accepted: this node can't check its connection to the buyer — ${PEERS_READ_MISSING}.`);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(magma.count("RejectOrder"), 0);
  assert.equal(api.node.callsTo("invoices.addHoldInvoice").length, 0);
  // The close dialog's reconnect and a manual open say the same.
  const peer = await api.request("POST", "/peers/connect", { pubkey: BUYER });
  assert.deepEqual(peer.body, { ok: false, error: PEERS_READ_MISSING });
  const open = await api.request("POST", "/channels/open", { pubkey: BUYER, localTokens: 1_000_000 });
  assert.equal(open.body.ok, false, JSON.stringify(open.body));
  assert.equal(open.body.error, PEERS_READ_MISSING);
});

test("a paid order whose open runs into the missing peers:read keeps its payment held while there is time — no refund for this node's setup — and opens once LND lists peers again", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  node.failNext("default.listPeers", "permission denied");
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "held", "not released: the operator can fix the macaroon in time");
  assert.equal(e?.lastError, `${PEERS_READ_MISSING} — will try again`);
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED");
  assert.equal(node.callsTo("default.openChannel").length, 0);
  assert.equal(autopilot.areaStatus().magma.state, "blocked");
  await autopilot.pollSellOrders();
  assert.equal(node.callsTo("default.openChannel").length, 1, "opened once LND listed its peers");
  assert.notEqual(autopilot.areaStatus().magma.state, "blocked");
});

// ── LSP mode ──────────────────────────────────────────────────────────────────

const hashOf = (order: { payment: { bolt11: { invoice: string } } }): string => parsePaymentRequest(order.payment.bolt11.invoice).id;
const view = (lsp: LspNode, id: string) => lsp.svc.orderViews().find((o) => o.orderId === id);

test("LSP mode: a paid order whose open runs into a missing peers:read is refunded at once, saying why — not waited on as a buyer gone offline", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  const lsp = lspNode(t);
  lsp.svc.start();
  await until(() => lsp.node.callsTo("default.listPeers").length > 0, "probed at start");
  const w = lspsWallet(lsp.node, lsp.buyer);
  const order = (await w.call("lsps1.create_order", zeusOrder())).result;
  // The open's connect check is the next listing: LND refuses it.
  lsp.node.failNext("default.listPeers", "permission denied");
  lsp.node.payHoldInvoice(hashOf(order));
  await until(() => view(lsp, order.order_id)?.orderState === "FAILED", "ended");
  const failed = view(lsp, order.order_id);
  assert.equal(failed?.paymentState, "REFUNDED");
  // Before: "the buyer is offline — its payment stays held …", for hours.
  assert.equal(failed?.error, PEERS_READ_MISSING);
  assert.equal(failed?.waitingForBuyerSince, undefined);
  assert.equal(lsp.node.invoices.get(hashOf(order))?.state, "CANCELED", "the buyer gets the payment back");
  assert.equal(lsp.node.callsTo("default.connectPeer").length, 0);
  assert.equal(lsp.node.callsTo("default.openChannel").length, 0);
});

test("LSP mode without peers:read takes no order — a buyer never pays for a channel this node can't open — and its status says why from the start", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  const lsp = lspNode(t, { writeDenied: NO_PEERS_READ });
  lsp.svc.start();
  // Probed at start: the status says it before any order.
  const said = async () => (await lsp.svc.status()).blocked;
  for (const end = Date.now() + 10_000; !(await said()) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  assert.equal(await said(), PEERS_READ_MISSING, "before any order");
  const w = lspsWallet(lsp.node, lsp.buyer);
  const invoices = lsp.node.invoices.size;
  const refused = await w.call("lsps1.create_order", zeusOrder());
  assert.equal(refused.error?.code, 1);
  assert.match(refused.error?.data?.message ?? "", /^this LSP can't open channels right now/);
  assert.equal(lsp.node.invoices.size, invoices, "no invoice made");
  // Review of P8, run 2: the macaroon still reads peer messages, so the
  // listener runs — and the card showed the reason (then in lastError) only
  // while it didn't. Now it is a field of its own, shown either way.
  const status = await lsp.svc.status();
  assert.equal(status.running, true, "listening: get_info is answered, create_order turned away");
  assert.equal(status.blocked, PEERS_READ_MISSING);
  assert.equal(status.lastError, null, "lastError is the service's own error, not this");
});

test("LSP mode takes orders again once LND lists its peers to the write macaroon — and its status stops saying it turns them away", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  const lsp = lspNode(t);
  lsp.svc.start();
  await until(() => lsp.node.callsTo("default.listPeers").length > 0, "probed at start");
  const w = lspsWallet(lsp.node, lsp.buyer);
  // Refused twice: at a check, and when the next order asks again.
  lsp.node.failNext("default.listPeers", "permission denied");
  lsp.node.failNext("default.listPeers", "permission denied");
  await checkPeerListing(lsp.node.lnd);
  assert.equal((await lsp.svc.status()).blocked, PEERS_READ_MISSING);
  const turnedAway = await w.call("lsps1.create_order", zeusOrder());
  assert.equal(turnedAway.error?.code, 1);
  // LND lists them again: the next order is made, and the status is clear.
  const order = await w.call("lsps1.create_order", zeusOrder());
  assert.ok(order.result?.order_id, JSON.stringify(order));
  assert.equal((await lsp.svc.status()).blocked, null);
});
