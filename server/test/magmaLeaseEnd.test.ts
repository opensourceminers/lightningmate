/**
 * Auto-close at the end of a sold lease (review 2026-10-25, channels).
 *
 * Before:
 *  - the finished sale's channel was found by its funding txid alone: with two
 *    channels in one funding transaction, the first LND listed was closed —
 *    here another buyer's, whose lease still ran;
 *  - it was closed whatever was left on our side (20k of 2M: 1.98M of
 *    inbound given up) and however well it routed;
 *  - at LND's 6-block fee rate, whatever that was — no economy rate, no
 *    maximum.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { SOLD_CLOSE_MIN_LOCAL_SHARE, channelAtOutpoint } from "../src/services/magmaDesk.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import type { FakeLnd } from "./helpers/fakeLnd.js";
import { chanNumber } from "./helpers/feeNode.js";
import { quiet } from "./helpers/lifecycle.js";

const OTHER = "03" + "ef".repeat(32);

/** A selling node with auto-close on; LND closes what it is asked to, and
 *  estimates `satPerKw` for the economy rate (null: no estimate). */
function closer(t: Parameters<typeof sellerSetup>[0], satPerKw: string | null = "500") {
  const s = sellerSetup(t, { config: { sellAutoClose: true } });
  if (satPerKw !== null) s.node.override("wallet.estimateFee", (_a, cb) => cb(null, { sat_per_kw: satPerKw }));
  s.node.override("default.closeChannel", () => {
    const st = Object.assign(new EventEmitter(), { cancel: () => undefined });
    setImmediate(() => st.emit("data", { update: "close_pending", close_pending: { txid: randomBytes(32), output_index: 0 } }));
    return st;
  });
  /** Each close asked of LND: the funding output and the fee rate (sat/vB). */
  const closes = () =>
    s.node.callsTo("default.closeChannel").map((a) => ({ vout: (a.channel_point as { output_index: number }).output_index, satPerVbyte: a.sat_per_vbyte }));
  return { ...s, closes };
}

/** 30 days of forwards out of `channelId`: ten, `feeSats` earned in all. */
function forwardsEarning(node: FakeLnd, channelId: string, feeSats: number): void {
  const nowMs = Date.now();
  const events = Array.from({ length: 10 }, (_, i) => {
    const at = nowMs - (i + 1) * 2 * 86_400_000;
    const fee = feeSats / 10;
    return {
      amt_in: String(1_000_000 + fee),
      amt_in_msat: String((1_000_000 + fee) * 1000),
      amt_out: "1000000",
      amt_out_msat: "1000000000",
      chan_id_in: chanNumber("850000x9x0"),
      chan_id_out: chanNumber(channelId),
      fee: String(fee),
      fee_msat: String(fee * 1000),
      timestamp: String(Math.floor(at / 1000)),
      timestamp_ns: String(BigInt(at) * 1_000_000n),
    };
  });
  node.override("default.forwardingHistory", (a, cb) =>
    Number(a.index_offset) > 0
      ? cb(null, { forwarding_events: [], last_offset_index: String(a.index_offset) })
      : cb(null, { forwarding_events: events, last_offset_index: String(events.length) }),
  );
}

test("the finished sale's channel is found by its funding outpoint — txid AND vout: of two channels in one funding transaction, the one whose lease is over is closed, not the first LND lists", async (t) => {
  quiet(t);
  const s = closer(t);
  const txid = "ce".repeat(32);
  s.node.channels.push({ partnerPublicKey: OTHER, capacity: 3_000_000, localBalance: 2_990_000, transactionId: txid, transactionVout: 0 });
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 1 });
  s.magma.addSale({ buyerPubkey: OTHER, status: "VALID_CHANNEL_OPENING", transactionId: `${txid}:0` });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:1` });
  const run = await s.autopilot.runOnce();
  assert.equal(run.sells.find((a) => a.action === "close")?.ok, true);
  assert.deepEqual(s.closes().map((c) => c.vout), [1], "before: vout 0 — a lease still running");
});

test("channelAtOutpoint: txid and vout; a bare txid only when one channel has it — of a shared funding transaction it can't say which", () => {
  const open = [
    { id: "a", transaction_id: "aa".repeat(32), transaction_vout: 0 },
    { id: "b", transaction_id: "aa".repeat(32), transaction_vout: 1 },
    { id: "c", transaction_id: "cc".repeat(32), transaction_vout: 2 },
  ];
  assert.equal(channelAtOutpoint(open, `${"aa".repeat(32)}:1`)?.id, "b");
  assert.equal(channelAtOutpoint(open, `${"aa".repeat(32)}:0`)?.id, "a");
  assert.equal(channelAtOutpoint(open, `${"aa".repeat(32)}:2`), undefined);
  assert.equal(channelAtOutpoint(open, "aa".repeat(32)), undefined, "shared: which one isn't known");
  assert.equal(channelAtOutpoint(open, "cc".repeat(32))?.id, "c");
  assert.equal(channelAtOutpoint(open, `${"cc".repeat(32)}:2`)?.id, "c");
});

test("a lease over whose channel Amboss still lists another sale's lease running on is not closed", async (t) => {
  quiet(t);
  const s = closer(t);
  const txid = "cd".repeat(32);
  s.node.channels.push({ id: "850000x7x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  s.magma.addSale({ buyerPubkey: BUYER, status: "VALID_CHANNEL_OPENING", channelId: chanNumber("850000x7x0"), transactionId: `${txid}:0` });
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
});

test("a finished lease's channel with under a quarter of it on our side is kept — what is left is inbound worth keeping — and that is said once, not every run", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logs.push(String(line)));
  const s = closer(t);
  const txid = "cd".repeat(32);
  // 20k of 2M on our side (the probe of the review).
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 20_000, remoteBalance: 1_975_000, transactionId: txid, transactionVout: 0 });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
  assert.equal(SOLD_CLOSE_MIN_LOCAL_SHARE, 0.25);
  const said = logs.filter((l) => l.includes(sale.id));
  assert.deepEqual(said, [`[magma] order ${sale.id}: lease over — kept open: 20,000 of its 2,000,000 sat are on our side — the rest is inbound worth keeping`]);
  // A quarter or more on our side: closed.
  s.node.channels[0].localBalance = 500_000;
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 1);
});

test("a finished lease's channel that routes well — it earned at least what a sat of this node's month-old channels earns — is kept; one that earns less is closed", async (t) => {
  quiet(t);
  const s = closer(t);
  const txid = "cd".repeat(32);
  s.node.channels.push({ id: "850000x5x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_500_000, transactionId: txid, transactionVout: 0 });
  // An idle month-old channel beside it: the node earns ~6,083 ppm/yr on
  // 4M; the sold channel ~12,167 on its 2M.
  s.node.channels.push({ id: "850000x6x0", partnerPublicKey: OTHER, capacity: 2_000_000, localBalance: 1_000_000, transactionId: "ef".repeat(32), transactionVout: 0 });
  forwardsEarning(s.node, "850000x5x0", 2_000);
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [], "it routes well");
  // The other channel earns the node's money: the sold one is below it.
  forwardsEarning(s.node, "850000x6x0", 20_000);
  const fresh = s.restart(); // (what was kept is said once per process)
  await fresh.runOnce();
  assert.equal(s.closes().length, 1);
});

test("a finished lease's channel closes at LND's economy rate, never above the operator's maximum for on-chain fees — and not without an estimate", async (t) => {
  quiet(t);
  // No estimate from LND: not closed (before: at LND's 6-block rate, whatever it was).
  const blind = closer(t, null);
  blind.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: "cd".repeat(32), transactionVout: 0 });
  blind.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${"cd".repeat(32)}:0` });
  await blind.autopilot.runOnce();
  assert.deepEqual(blind.closes(), []);

  // 100 sat/vB at the economy rate, above the 20 sat/vB maximum: waits.
  const s = closer(t, "25000");
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: "ce".repeat(32), transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${"ce".repeat(32)}:0` });
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
  // Fees down to 2 sat/vB: closed at that rate.
  s.node.override("wallet.estimateFee", (_a, cb) => cb(null, { sat_per_kw: "500" }));
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [{ vout: 0, satPerVbyte: 2 }]);
});
