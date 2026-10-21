/**
 * Self-test of the shared test helpers: every FakeLnd method must satisfy the
 * real `lightning` library's response validators, and the fetch mock must
 * route, record and refuse exactly as documented. Later suites lean on these.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createInvoice,
  decodePaymentRequest,
  getBackups,
  getChainBalance,
  getChannels,
  getInvoice,
  getPayment,
  getPeers,
  getPendingChannels,
  getWalletInfo,
  openChannel,
  pay,
} from "lightning";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { makeNodeKey, makePaymentRequest } from "./helpers/bolt11.js";
import { hang, installFetchMock } from "./helpers/fetchMock.js";

const PEER = "02" + "11".repeat(32);
const TXID_A = "aa".repeat(32);
const TXID_B = "bb".repeat(32);

test("FakeLnd answers the read calls through the real library", async () => {
  const node = new FakeLnd({
    chainBalance: 1_234_567,
    channels: [{ partnerPublicKey: PEER, capacity: 2_000_000, localBalance: 600_000, transactionId: TXID_A, transactionVout: 1 }],
    pending: [{ partnerPublicKey: PEER, capacity: 500_000, transactionId: TXID_B, transactionVout: 0 }],
    peers: [PEER],
  });
  const info = await getWalletInfo({ lnd: node.lnd });
  assert.equal(info.public_key, node.publicKey);
  const { channels } = await getChannels({ lnd: node.lnd });
  assert.equal(channels[0].transaction_id, TXID_A);
  assert.equal(channels[0].transaction_vout, 1);
  assert.equal(channels[0].local_balance, 600_000);
  const { pending_channels } = await getPendingChannels({ lnd: node.lnd });
  assert.equal(pending_channels[0].is_opening, true);
  assert.equal(pending_channels[0].transaction_id, TXID_B);
  assert.equal((await getChainBalance({ lnd: node.lnd })).chain_balance, 1_234_567);
  const backups = await getBackups({ lnd: node.lnd });
  // (lightning's typings declare `channels` as a single object; it is an array.)
  const backedUp = backups.channels as unknown as { transaction_id: string; transaction_vout: number }[];
  assert.deepEqual(
    backedUp.map((c) => `${c.transaction_id}:${c.transaction_vout}`).sort(),
    [`${TXID_A}:1`, `${TXID_B}:0`],
  );
  assert.equal((await getPeers({ lnd: node.lnd })).peers[0].public_key, PEER);
});

test("FakeLnd decodes, pays and tracks real BOLT11 requests", async () => {
  const node = new FakeLnd();
  const payee = makeNodeKey();
  const { request, id } = makePaymentRequest({ key: payee, tokens: 42 });
  const decoded = await decodePaymentRequest({ lnd: node.lnd, request });
  assert.equal(decoded.destination, payee.publicKey);
  assert.equal(decoded.mtokens, "42000");
  assert.equal(decoded.tokens, 42);

  const paid = await pay({ lnd: node.lnd, request, max_fee: 5 });
  assert.equal(paid.is_confirmed, true);
  assert.equal(paid.tokens, 42 + 2); // + the fake's 2 sat routing fee
  assert.equal(node.callsTo("router.sendPaymentV2")[0].amt, undefined, "no explicit amount for an amounted invoice");
  const status = await getPayment({ lnd: node.lnd, id });
  assert.equal(status.is_confirmed, true);

  // A hanging payment stays pending until the test resolves it.
  node.payOutcome = "hang";
  const second = makePaymentRequest({ key: payee, tokens: 7 });
  const pending = pay({ lnd: node.lnd, request: second.request, max_fee: 5 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await getPayment({ lnd: node.lnd, id: second.id })).is_pending, true);
  node.resolvePayment(second.id, "fail");
  await assert.rejects(pending);
  await assert.rejects(getPayment({ lnd: node.lnd, id: "cd".repeat(32) }), (err: unknown) =>
    Array.isArray(err) && err[0] === 404,
  );
});

test("FakeLnd issues invoices signed by its own key and opens channels", async () => {
  const node = new FakeLnd({ chainBalance: 3_000_000, peers: [PEER] });
  const inv = await createInvoice({ lnd: node.lnd, tokens: 1500, description: "x" });
  assert.equal((await decodePaymentRequest({ lnd: node.lnd, request: inv.request })).destination, node.publicKey);
  assert.equal((await getInvoice({ lnd: node.lnd, id: inv.id })).tokens, 1500);

  const opened = await openChannel({ lnd: node.lnd, partner_public_key: PEER, local_tokens: 1_000_000 });
  assert.match(opened.transaction_id, /^[0-9a-f]{64}$/);
  assert.equal(node.pending[0].transactionId, opened.transaction_id);
  assert.equal(node.chainBalance, 2_000_000);
});

test("fetch mock routes GraphQL by query text, records mutations, and fails on strays", async (t) => {
  const http = installFetchMock(t);
  http.onGraphql("https://api.example/graphql", "getThing", (vars) => ({ data: { getThing: vars.id } }));
  http.onGraphql("https://api.example/graphql", /^\s*mutation/, () => ({ data: { ok: true } }));
  http.on("https://slow.example/", hang);

  const res = await fetch("https://api.example/graphql", {
    method: "POST",
    body: JSON.stringify({ query: "query Q($id: String!) { getThing(id: $id) }", variables: { id: "abc" } }),
  });
  assert.deepEqual(await res.json(), { data: { getThing: "abc" } });
  await fetch("https://api.example/graphql", { method: "POST", body: JSON.stringify({ query: "mutation { doIt }" }) });
  assert.equal(http.mutations.length, 1);

  await assert.rejects(fetch("https://slow.example/", { signal: AbortSignal.timeout(20) }));

  await assert.rejects(fetch("https://not-routed.example/"), /unexpected outbound request/);
  // The stray request would fail this test in the after-hook; clear it here
  // because provoking it was the point.
  http.unmatched.length = 0;
});

test("the API harness's autopilot kicks off nothing after a settings change: tests drive runs themselves (no stray run firing into the next test step or the fetch mock's after-hook)", async (t) => {
  const { startApi } = await import("./helpers/apiHarness.js");
  const api = await startApi(t);
  const started: string[] = [];
  t.mock.method(api.autopilot, "runOnce", async () => void started.push("run"));
  t.mock.method(api.autopilot, "pollSellOrders", async () => void started.push("poll"));
  // Only the timers armed from here on are mocked (the server is listening).
  t.mock.timers.enable({ apis: ["setTimeout"] });
  api.autopilot.setConfig({ enabled: true, sellEnabled: true });
  // Before: a main run 2 s and an order-lane pass 5 s later, on real timers.
  t.mock.timers.tick(10_000);
  assert.deepEqual(started, []);
});
