/**
 * The write routes take what the contract says and nothing else (review
 * 2026-11-10, SEC-2 / CHAN-2), a channel's open or close at a rate far above
 * the next block's asks again (CHAN-2), and a manual close and an on-chain
 * send have a deadline and are never run twice (CHAN-14).
 *
 * Before: `Number(v)` read null, "", [] and false as 0 — a fee of 0 ppm written
 * to LND, a channel pinned at 0 ppm, output 0 for a missing vout — and "0x10"
 * as 16; `Boolean("false")` force-closed a channel; a close's unusable rate
 * was dropped (LND closed at its own); any rate up to 5,000 sat/vB went out
 * with one click; a close LND kept waiting on held the dialog forever; and a
 * send whose answer was lost could be sent again.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApi } from "./helpers/apiHarness.js";
import { feeNode, type FeeChannel } from "./helpers/feeNode.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { MANUAL_CHAIN_DEADLINE } from "../src/routes/api.js";
import { closeMaxRate } from "../src/services/onchain.js";

const HEIGHT = 860_000;
const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const channel = (n: number, o: Partial<FeeChannel> = {}): FeeChannel => ({
  id: `${HEIGHT - 5_760}x${n}x0`,
  partnerPublicKey: PEER(n),
  capacity: 2_000_000,
  localBalance: 1_000_000,
  transactionId: TX(n),
  transactionVout: 0,
  feeRatePpm: 300,
  baseFeeMsat: 1000,
  ...o,
});
/** Wrong-typed values `Number` or `Boolean` read as something. */
const WRONG_NUMBERS: unknown[] = [null, "", [], false, true, "0x10", "1e3", "12", [5], 12.9, {}];
const WRONG_BOOLEANS: unknown[] = ["false", "0", 0, 1, [], "", null, "true"];

/** LND's estimate: `fast` sat/vB for the next block. */
function estimates(node: FakeLnd, fast: number): void {
  const kw = (target: number) => String(Math.round((target <= 1 ? fast : target <= 3 ? fast / 2 : 2) * 250));
  node.override("wallet.estimateFee", (a, cb) => cb(null, { sat_per_kw: kw(Number(a.conf_target) || 6), min_relay_fee_sat_per_kw: "253" }));
}
const closeNode = (fast = 10, n = 1) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(n)] });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  estimates(node, fast);
  return node;
};
const sentCloses = (node: FakeLnd) =>
  node.callsTo("default.closeChannel").map((a) => ({ force: a.force, rate: a.sat_per_vbyte, max: a.max_fee_per_vbyte }));
function quiet(t: TestContext): void {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "warn", () => undefined);
}

test("SEC-2: /fees/apply refuses a fee that is no whole JSON number — nothing is written to LND", async (t) => {
  for (const bad of [...WRONG_NUMBERS, -1]) {
    const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1)] });
    const api = await startApi(t, { node });
    const res = await api.request("POST", "/fees/apply", {
      items: [{ id: channel(1).id, transactionId: TX(1), transactionVout: 0, feeRatePpm: bad, baseFeeMsat: 1000 }],
    });
    assert.equal(res.status, 400, `feeRatePpm ${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(node.policyWrites, [], `feeRatePpm ${JSON.stringify(bad)} wrote nothing`);
  }
  for (const bad of [null, "", "0"]) {
    const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1)] });
    const api = await startApi(t, { node });
    const res = await api.request("POST", "/fees/apply", {
      items: [{ id: channel(1).id, transactionId: TX(1), transactionVout: bad, feeRatePpm: 777, baseFeeMsat: 1000 }],
    });
    assert.equal(res.status, 400, `transactionVout ${JSON.stringify(bad)}`);
    assert.deepEqual(node.policyWrites, []);
  }
  // A real number still goes.
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1)] });
  const api = await startApi(t, { node });
  const ok = await api.request("POST", "/fees/apply", { items: [{ id: channel(1).id, transactionId: TX(1), transactionVout: 0, feeRatePpm: 777, baseFeeMsat: 1000 }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(node.policyWrites.length, 1);
});

test("SEC-2: /overrides refuses a fixed fee that is no whole JSON number — no channel is pinned at 0 ppm", async (t) => {
  for (const bad of WRONG_NUMBERS) {
    const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1)] });
    const api = await startApi(t, { node });
    const res = await api.request("POST", "/overrides", { channelId: channel(1).id, mode: "fixed", fixedPpm: bad });
    assert.equal(res.status, 400, `fixedPpm ${JSON.stringify(bad)}: ${JSON.stringify(res.body)}`);
    const file = join(api.dir, "overrides.json");
    assert.ok(!existsSync(file) || !readFileSync(file, "utf8").includes('"fixed"'), `fixedPpm ${JSON.stringify(bad)} pinned nothing`);
  }
});

test("SEC-2/CHAN-2: /channels/close takes isForce only as true or false — \"false\" is no force-close any more", async (t) => {
  for (const bad of WRONG_BOOLEANS) {
    const node = closeNode();
    const api = await startApi(t, { node });
    const res = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: bad });
    assert.equal(res.status, 400, `isForce ${JSON.stringify(bad)}`);
    assert.match(res.body.message, /isForce must be true or false/);
    assert.deepEqual(sentCloses(node), [], `isForce ${JSON.stringify(bad)} closed nothing`);
  }
});

test("CHAN-2: a close's rate that is given and unusable is refused, not dropped; a missing vout is no output 0", async (t) => {
  for (const feeRate of [...WRONG_NUMBERS, 0, 5001, 999_999, "fast"]) {
    const node = closeNode();
    const api = await startApi(t, { node });
    const res = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate });
    assert.equal(res.status, 400, `feeRate ${JSON.stringify(feeRate)}`);
    assert.match(res.body.message, /feeRate must be a whole number of sat\/vByte from 1 to 5000/);
    assert.deepEqual(sentCloses(node), []);
  }
  for (const transactionVout of [null, [], "", "0", 0.5]) {
    const node = closeNode();
    const api = await startApi(t, { node });
    const res = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout, isForce: false, feeRate: 2 });
    assert.equal(res.status, 400, `transactionVout ${JSON.stringify(transactionVout)}`);
    assert.deepEqual(sentCloses(node), []);
  }
  for (const confirmed of ["fee_rate_high", [1], {}]) {
    const node = closeNode();
    const api = await startApi(t, { node });
    const res = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 2, confirmed });
    assert.equal(res.status, 400, `confirmed ${JSON.stringify(confirmed)}`);
  }
});

test("CHAN-2: a close's maximum: what LND would agree to, never above the rate at which the app asks — or the confirmed rate itself", async (t) => {
  const node = closeNode();
  const api = await startApi(t, { node });
  const res = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 7 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  // LND would agree to three times 7 by itself; the next block's 10 sets
  // the line at 30: the most is 21.
  assert.deepEqual(sentCloses(node), [{ force: false, rate: 7, max: 21 }]);
  // The rule: an economy close keeps LND's headroom, a rate near the line
  // stops at it, a confirmed high rate is the most, no estimate is LND's rule.
  assert.equal(closeMaxRate(2, 12), 6);
  assert.equal(closeMaxRate(30, 12), 36);
  assert.equal(closeMaxRate(36, 12), 36);
  assert.equal(closeMaxRate(500, 10), 500);
  assert.equal(closeMaxRate(5, null), undefined);
});

test("CHAN-2: a close at more than 3× the next block's rate asks again with the fee it would pay, and goes once the yes is sent; a force-close's rate asks nothing", async (t) => {
  const node = closeNode(10);
  const api = await startApi(t, { node });
  const ask = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 500 });
  assert.equal(ask.status, 409);
  assert.equal(ask.body.error, "fee_rate_high");
  assert.equal(ask.body.message, "500 sat/vB is more than 3× what LND estimates for the next block (10 sat/vB): this close (about 150 vB) pays ~75,000 sat in fees.");
  assert.deepEqual(sentCloses(node), [], "nothing closed on the question");
  // 30 is 3× 10: not "more than".
  const edge = closeNode(10);
  const edgeApi = await startApi(t, { node: edge });
  assert.equal((await edgeApi.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 30 })).status, 200);
  const yes = await api.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 500, confirmed: ["fee_rate_high"] });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  assert.deepEqual(sentCloses(node), [{ force: false, rate: 500, max: 500 }]);
  // A force-close pays the commitment's fee, not a rate: nothing to ask.
  const forced = closeNode(10);
  const forcedApi = await startApi(t, { node: forced });
  const f = await forcedApi.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: true, feeRate: 500 });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  assert.deepEqual(sentCloses(forced), [{ force: true, rate: undefined, max: undefined }]);
  // No estimate from LND: nothing to compare with, the close goes.
  const blind = feeNode({ blockHeight: HEIGHT, channels: [channel(1)] });
  blind.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  blind.override("wallet.estimateFee", (_a, cb) => cb({ details: "fee estimation not available" }));
  const blindApi = await startApi(t, { node: blind });
  assert.equal((await blindApi.request("POST", "/channels/close", { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 500 })).status, 200);
});

test("CHAN-14: a close LND does not answer is told as maybe under way after the deadline; until then a second close of the same kind is refused, never a force-close; its late answer is logged and frees no later request's guard", async (t) => {
  const logs: string[] = [];
  t.mock.method(console, "log", (...a: unknown[]) => logs.push(a.join(" ")));
  const before = MANUAL_CHAIN_DEADLINE.ms;
  MANUAL_CHAIN_DEADLINE.ms = 150;
  t.after(() => {
    MANUAL_CHAIN_DEADLINE.ms = before;
  });
  const node = closeNode(10, 0xab); // a txid with letters
  const answers: (() => void)[] = [];
  node.override("default.closeChannel", () => {
    const s = Object.assign(new EventEmitter(), { cancel: () => undefined });
    answers.push(() => s.emit("data", { update: "close_pending", close_pending: { txid: Buffer.alloc(32, 0xcd), output_index: 0 } }));
    return s;
  });
  const api = await startApi(t, { node });
  const coop = { transactionId: TX(0xab), transactionVout: 0, isForce: false, feeRate: 5 };
  const first = api.request("POST", "/channels/close", coop);
  await new Promise((r) => setTimeout(r, 40));
  const second = await api.request("POST", "/channels/close", coop);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "close_in_flight");
  // The same channel, its txid in upper case: the same close (R1-1b).
  const upper = await api.request("POST", "/channels/close", { ...coop, transactionId: TX(0xab).toUpperCase() });
  assert.equal(upper.body.error, "close_in_flight");
  // R1-1: a force-close is not held up by the cooperative close LND waits on.
  const force = api.request("POST", "/channels/close", { transactionId: TX(0xab), transactionVout: 0, isForce: true });
  const told = await first;
  assert.equal(told.status, 200);
  assert.deepEqual([told.body.ok, told.body.stillClosing], [false, true]);
  assert.match(told.body.error, /LND has not answered within 0 s\. The close may still go out: look under pending channels/);
  assert.equal((await force).body.stillClosing, true, "went to LND");
  assert.deepEqual(node.callsTo("default.closeChannel").map((a) => a.force), [false, true]);
  // Past the deadline the guard is gone: LND decides about another close.
  const third = api.request("POST", "/channels/close", coop);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(node.callsTo("default.closeChannel").length, 3, "the third went to LND");
  answers[0]!(); // the first's late answer …
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await api.request("POST", "/channels/close", coop)).body.error, "close_in_flight", "… frees not the third's guard");
  assert.ok(logs.some((l) => /answered after the page was told the outcome was unknown — closing transaction/.test(l)), logs.join("\n"));
  answers[2]!();
  assert.equal((await third).body.ok, true);
});

test("SEC-2/CHAN-2: /channels/open refuses an isPrivate that is no boolean, and an open at more than 3× the next block's rate asks again", async (t) => {
  quiet(t);
  for (const bad of WRONG_BOOLEANS) {
    const node = new FakeLnd({ chainBalance: 5_000_000 });
    const api = await startApi(t, { node });
    const res = await api.request("POST", "/channels/open", { pubkey: PEER(7), localTokens: 1_000_000, isPrivate: bad });
    assert.equal(res.status, 400, `isPrivate ${JSON.stringify(bad)}`);
    assert.equal(node.callsTo("default.openChannel").length, 0);
  }
  for (const localTokens of [null, "1000000", 1_000_000.5, true]) {
    const api = await startApi(t, { node: new FakeLnd({ chainBalance: 5_000_000 }) });
    assert.equal((await api.request("POST", "/channels/open", { pubkey: PEER(7), localTokens })).status, 400, `localTokens ${JSON.stringify(localTokens)}`);
  }
  const node = new FakeLnd({ chainBalance: 5_000_000, peers: [PEER(7)] });
  estimates(node, 10);
  const api = await startApi(t, { node });
  const ask = await api.request("POST", "/channels/open", { pubkey: PEER(7), localTokens: 1_000_000, feeRate: 100 });
  assert.equal(ask.status, 409, JSON.stringify(ask.body));
  assert.equal(ask.body.error, "fee_rate_high");
  assert.equal(ask.body.message, "100 sat/vB is more than 3× what LND estimates for the next block (10 sat/vB): this open (about 175 vB) pays ~17,500 sat in fees.");
  assert.equal(node.callsTo("default.openChannel").length, 0);
  const yes = await api.request("POST", "/channels/open", { pubkey: PEER(7), localTokens: 1_000_000, feeRate: 100, confirmed: ["fee_rate_high"] });
  assert.equal(yes.status, 200, JSON.stringify(yes.body));
  assert.equal(yes.body.ok, true, JSON.stringify(yes.body));
  assert.equal(node.callsTo("default.openChannel").length, 1);
});

/** A wallet whose LND estimates fees and sends (as onchainSend.test.ts's). */
function sender(): FakeLnd {
  const node = new FakeLnd({ chainBalance: 5_000_000 });
  node.override("wallet.listUnspent", (_a, cb) =>
    cb(null, {
      utxos: [
        {
          address: ADDRESS,
          address_type: "WITNESS_PUBKEY_HASH",
          amount_sat: String(node.chainBalance),
          confirmations: "6",
          outpoint: { output_index: 0, txid_str: "ab".repeat(32) },
          pk_script: "0014" + "11".repeat(20),
        },
      ],
    }),
  );
  estimates(node, 20);
  node.override("default.estimateFee", (_a, cb) => cb(null, { fee_sat: "705", sat_per_vbyte: "5", feerate_sat_per_byte: "5" }));
  return node;
}

test("CHAN-14: a send's request id is never sent twice — a repeat is answered with what the first did; a send refused before LND frees its id", async (t) => {
  const node = sender();
  let sends = 0;
  node.override("default.sendCoins", (_a, cb) => {
    sends += 1;
    cb(null, { txid: "ef".repeat(32) });
  });
  const api = await startApi(t, { node });
  const body = { address: ADDRESS, tokens: 100_000, feeRate: 5, requestId: "send-0001" };
  const first = await api.request("POST", "/onchain/send", body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.transactionId, "ef".repeat(32));
  const again = await api.request("POST", "/onchain/send", body);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "send_repeated");
  assert.equal(again.body.message, `This send went out already: transaction ${"ef".repeat(32)}. Nothing was sent again.`);
  assert.deepEqual(again.body.result, first.body);
  assert.equal(sends, 1, "sent once");
  // A refusal before LND (a check to confirm): the same id goes again with the yes.
  const asked = await api.request("POST", "/onchain/send", { ...body, feeRate: 200, requestId: "send-0002" });
  assert.equal(asked.status, 409);
  assert.equal(asked.body.error, "confirm_send");
  const confirmed = await api.request("POST", "/onchain/send", { ...body, feeRate: 200, requestId: "send-0002", confirmed: ["fee_rate_high", "fee_share_high"] });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(sends, 2);
  // Without an id (curl): as before.
  assert.equal((await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 100_000, feeRate: 5 })).status, 200);
  assert.equal(sends, 3);
  for (const requestId of ["short", "x".repeat(65), "has space ok", 12345678, null]) {
    assert.equal((await api.request("POST", "/onchain/send", { ...body, requestId })).status, 400, `requestId ${JSON.stringify(requestId)}`);
  }
  // A failed send stays on record: the same id is not tried again.
  node.override("default.sendCoins", (_a, cb) => cb({ details: "insufficient funds available to construct transaction" }));
  const failed = await api.request("POST", "/onchain/send", { ...body, requestId: "send-0003" });
  assert.equal(failed.body.ok, false);
  const failedAgain = await api.request("POST", "/onchain/send", { ...body, requestId: "send-0003" });
  assert.equal(failedAgain.status, 409);
  assert.match(failedAgain.body.message, /^This send was tried already and failed \(InsufficientBalance/);
});

test("CHAN-14: a send LND does not answer is told as unknown after the deadline; the same id meanwhile is 'still under way', and once LND answers, what it did", async (t) => {
  quiet(t);
  const before = MANUAL_CHAIN_DEADLINE.ms;
  MANUAL_CHAIN_DEADLINE.ms = 150;
  t.after(() => {
    MANUAL_CHAIN_DEADLINE.ms = before;
  });
  const node = sender();
  let answer = (): void => undefined;
  let sends = 0;
  node.override("default.sendCoins", (_a, cb) => {
    sends += 1;
    answer = () => cb(null, { txid: "fe".repeat(32) });
  });
  const api = await startApi(t, { node });
  const body = { address: ADDRESS, tokens: 100_000, feeRate: 5, requestId: "slow-send-1" };
  const told = await api.request("POST", "/onchain/send", body);
  assert.equal(told.status, 200);
  assert.deepEqual([told.body.ok, told.body.unknown], [false, true]);
  assert.match(told.body.error, /The send may still go out: look under the on-chain transactions before you send again\./);
  const meanwhile = await api.request("POST", "/onchain/send", body);
  assert.equal(meanwhile.status, 409);
  assert.equal(meanwhile.body.message, "This send is still under way — look under the on-chain transactions before sending again.");
  answer();
  await new Promise((r) => setTimeout(r, 30));
  const after = await api.request("POST", "/onchain/send", body);
  assert.equal(after.status, 409);
  assert.equal(after.body.result.transactionId, "fe".repeat(32));
  assert.equal(sends, 1);
});

test("SEC-2: the send takes its numbers and flags as JSON numbers and booleans; the preview's query its digits and \"true\"/\"1\"", async (t) => {
  const node = sender();
  node.override("default.sendCoins", (_a, cb) => cb(null, { txid: "ef".repeat(32) }));
  const api = await startApi(t, { node });
  for (const patch of [{ tokens: "100000" }, { feeRate: "5" }, { tokens: 100_000.5 }, { tokens: undefined, sendAll: "true" }, { feeRate: null }]) {
    const res = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 100_000, feeRate: 5, ...patch });
    assert.equal(res.status, 400, `${JSON.stringify(patch)}: ${JSON.stringify(res.body)}`);
  }
  const q = (s: string) => api.request("GET", `/onchain/send-preview?address=${ADDRESS}&${s}`);
  assert.equal((await q("feeRate=5&tokens=100000")).status, 200);
  assert.equal((await q("feeRate=5&max=true")).status, 200);
  assert.equal((await q("feeRate=5&all=1")).status, 200);
  for (const s of ["feeRate=0x5&tokens=100000", "feeRate=5&tokens=1e5", "feeRate=5.5&tokens=100000", "feeRate=&tokens=100000", "feeRate=5&max=yes"]) {
    assert.equal((await q(s)).status, 400, s);
  }
});

test("SEC-2: query numbers are plain digits — the open estimate's size of '1e6' or '0x10' is refused, the windows fall back to their default", async (t) => {
  const node = new FakeLnd({ chainBalance: 5_000_000 });
  estimates(node, 10);
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  const api = await startApi(t, { node });
  const fine = await api.request("GET", "/channels/open-estimate?size=1000000");
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  for (const size of ["1e6", "0x100000", "1000000.5", "", " 1000000"]) {
    assert.equal((await api.request("GET", `/channels/open-estimate?size=${encodeURIComponent(size)}`)).status, 400, `size ${JSON.stringify(size)}`);
  }
  assert.equal((await api.request("GET", "/flows?days=1e3")).status, 200, "an unusable window is the default one");
});

test("SEC-2: an offer's terms and a buy's amounts are whole JSON numbers — null is no base fee of 0", async (t) => {
  const node = new FakeLnd({ chainBalance: 5_000_000 });
  const api = await startApi(t, { node });
  api.amboss.setKey("TEST-KEY-0001"); // (no request reaches Amboss: each is refused first)
  const terms = { totalSizeSats: 5_000_000, minSizeSats: 1_000_000, maxSizeSats: 2_000_000, feeRatePpm: 2000, baseFeeSats: 0, minBlockLength: 4320 };
  for (const patch of [{ baseFeeSats: null }, { feeRatePpm: "2000" }, { minBlockLength: 4320.5 }, { totalSizeSats: [] }, { minSizeSats: false }]) {
    const res = await api.request("POST", "/amboss/offer", { ...terms, ...patch });
    assert.equal(res.status, 400, `${JSON.stringify(patch)}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.message, "Fill in all fields with whole numbers (0 or more).");
  }
  for (const usdCents of [null, "1000", 1000.5, true]) {
    const res = await api.request("POST", "/amboss/buy/quote", { usdCents, private: false });
    assert.equal(res.status, 400, `usdCents ${JSON.stringify(usdCents)}`);
    assert.equal(res.body.error, "bad_amount");
  }
  for (const maxSats of [null, "500", 0, 1.5]) {
    const res = await api.request("POST", "/amboss/buy/pay", { orderId: "order-1", maxSats });
    assert.equal(res.status, 400, `maxSats ${JSON.stringify(maxSats)}`);
  }
});

test("SEC-2: a refill's econRatio is a JSON number in its range — \"0.5\", null or true is refused before anything is asked of LND", async (t) => {
  quiet(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const api = await startApi(t, { node });
  const ask = (econRatio: unknown) =>
    api.request("POST", "/rebalance/execute", { targetId: "850000x1x0", sourceId: "850000x2x0", amountSats: 100_000, econRatio });
  for (const bad of ["0.5", null, true, [0.5], 0.01, 1.5]) {
    const res = await ask(bad);
    assert.equal(res.status, 400, `econRatio ${JSON.stringify(bad)}`);
    assert.match(res.body.message, /econRatio \(0\.05–1\)/);
  }
  const fine = await ask(0.5);
  assert.notEqual(fine.status, 400, `a real number passes the check (${JSON.stringify(fine.body)})`);
});

test("SEC-2: the fee preview's query numbers are plain decimals — '0x10', '1e3' or an empty value don't set the policy", async (t) => {
  const node = feeNode({ blockHeight: HEIGHT, channels: [channel(1)] });
  const api = await startApi(t, { node });
  const plain = await api.request("GET", "/fees/preview");
  const asked = await api.request("GET", "/fees/preview?minPpm=0x10&maxPpm=&step=1e3&minChangePpm=abc&baseFeeMsat=250");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(asked.body.policy, { ...plain.body.policy, baseFeeMsat: 250 }, "only the plain decimal was taken");
  const decimals = await api.request("GET", "/fees/preview?step=2.5&minPpm=-3");
  assert.deepEqual([decimals.body.policy.step, decimals.body.policy.minPpm], [2.5, -3], "as the policy's own checks then judge them");
});

test("CHAN-14 (R1-3): a send still waiting for the wallet at the deadline is withdrawn — nothing goes out later, the answer says so and the id is free", async (t) => {
  quiet(t);
  const before = MANUAL_CHAIN_DEADLINE.ms;
  MANUAL_CHAIN_DEADLINE.ms = 150;
  t.after(() => {
    MANUAL_CHAIN_DEADLINE.ms = before;
  });
  const node = sender();
  let sends = 0;
  node.override("default.sendCoins", (_a, cb) => {
    sends += 1;
    cb(null, { txid: "ef".repeat(32) });
  });
  const api = await startApi(t, { node });
  // A channel open holds the wallet past the deadline.
  let free = (): void => undefined;
  const held = api.capital.mutex.run("Magma open", () => new Promise<void>((r) => (free = r)));
  const body = { address: ADDRESS, tokens: 100_000, feeRate: 5, requestId: "busy-send-1" };
  const told = await api.request("POST", "/onchain/send", body);
  assert.equal(told.status, 200);
  assert.equal(told.body.unknown, undefined, "a known outcome");
  assert.equal(told.body.error, "Nothing was sent: the wallet was busy (Magma open) for 0 s, so the send was withdrawn. Send it again in a moment.");
  free();
  await held;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sends, 0, "the withdrawn send never went out");
  const again = await api.request("POST", "/onchain/send", body);
  assert.equal(again.status, 200, "the id is free again");
  assert.equal(again.body.ok, true);
  assert.equal(sends, 1);
});

test("CHAN-14 (R1-4): a send whose plan LND could not make never reached LND — its id is free for the same request", async (t) => {
  quiet(t);
  const node = sender();
  node.failNext("default.walletBalance", "LND is not ready");
  node.failNext("default.listUnspent", "LND is not ready");
  node.failNext("wallet.listUnspent", "LND is not ready");
  let sends = 0;
  node.override("default.sendCoins", (_a, cb) => {
    sends += 1;
    cb(null, { txid: "ef".repeat(32) });
  });
  const api = await startApi(t, { node });
  const body = { address: ADDRESS, tokens: 100_000, feeRate: 5, requestId: "plan-fails-1" };
  const first = await api.request("POST", "/onchain/send", body);
  assert.equal(sends, 0, `nothing reached LND (${JSON.stringify(first.body)})`);
  const again = await api.request("POST", "/onchain/send", body);
  assert.notEqual(again.body.error, "send_repeated", JSON.stringify(again.body));
});

test("SEC-2 (R1-16): an invoice's amount and expiry left out take their defaults — null is no number, nor for a payment's fee cap", async (t) => {
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const api = await startApi(t, { node });
  for (const patch of [{ tokens: null }, { expirySec: null }, { tokens: "1000" }]) {
    const res = await api.request("POST", "/ln/invoice", { description: "x", ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
  }
  const pay = await api.request("POST", "/ln/pay", { request: "lnbc1" + "q".repeat(60), maxFeeSats: null });
  assert.equal(pay.status, 400);
  assert.equal((await api.request("POST", "/ln/invoice", { description: "x" })).status, 200, "left out: an invoice for any amount");
});

test("CHAN-14 (R1-3): a send whose plan is still being made at the deadline is withdrawn too — it never reaches LND", async (t) => {
  quiet(t);
  const before = MANUAL_CHAIN_DEADLINE.ms;
  MANUAL_CHAIN_DEADLINE.ms = 150;
  t.after(() => {
    MANUAL_CHAIN_DEADLINE.ms = before;
  });
  const node = sender();
  // LND slow to size the send: the plan outlasts the deadline.
  node.override("default.estimateFee", (_a, cb) => setTimeout(() => cb(null, { fee_sat: "705", sat_per_vbyte: "5", feerate_sat_per_byte: "5" }), 400));
  let sends = 0;
  node.override("default.sendCoins", (_a, cb) => {
    sends += 1;
    cb(null, { txid: "ef".repeat(32) });
  });
  const api = await startApi(t, { node });
  const told = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 100_000, feeRate: 5, requestId: "slow-plan-1" });
  assert.match(told.body.error, /^Nothing was sent: the wallet was busy for 0 s, so the send was withdrawn\./);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sends, 0, "the plan finished after the deadline: nothing sent");
});
