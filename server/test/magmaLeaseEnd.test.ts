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
 *
 * And (review 2026-11-10, LANE-3, OFFER-9, CHAN-5) — before:
 *  - Amboss's status alone ended the lease: a channel ten blocks into its
 *    4,320 was closed once the order read CHANNEL_MONITORING_FINISHED;
 *  - with "Liquidity provision" off nothing was closed at all;
 *  - an offline buyer made a failed close on every run;
 *  - a close refused for its fee was a failure each run, of a channel LND
 *    was already closing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { AMBOSS_LEASES_MAX_AGE_MS, CLOSE_ASKED_RETRY_MS, LANE_PASS_DEADLINE, SOLD_CLOSE_MIN_LOCAL_SHARE, SOLD_KEEP_BAR_TEXT, channelAtOutpoint } from "../src/services/magmaDesk.js";
import { SOLD_CHANNEL_KEEP_PPM_YEAR, WORK_DEADLINES_MS } from "../src/services/autopilot.js";
import { MAGMA_LEASE_MARGIN_BLOCKS } from "../src/services/leaseCaps.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import type { FakeLnd } from "./helpers/fakeLnd.js";
import { chanNumber } from "./helpers/feeNode.js";
import { entryOnDisk, feeEnv, quiet, keepFileAlive } from "./helpers/lifecycle.js";

// Deadlines in these tests fire on timers nothing else keeps alive (see keepFileAlive).
keepFileAlive();

const OTHER = "03" + "ef".repeat(32);

/** A selling node with auto-close on; LND closes what it is asked to, and
 *  estimates `satPerKw` for the economy rate (null: no estimate). Its
 *  forwarding history reads, and is empty: whether a channel routes well is
 *  known — unread, a channel is never closed (final review 2026-10-25). */
function closer(t: Parameters<typeof sellerSetup>[0], satPerKw: string | null = "500") {
  const s = sellerSetup(t, { config: { sellAutoClose: true } });
  s.node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
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
  forwardsEarningEach(node, { [channelId]: feeSats });
}

/** The same for several channels at once: ten forwards out of each, earning
 *  what `fees` says for it (the forwarding history is one list: a second
 *  forwardsEarning replaces the first). */
function forwardsEarningEach(node: FakeLnd, fees: Record<string, number>): void {
  const nowMs = Date.now();
  const events = Object.entries(fees).flatMap(([channelId, feeSats]) =>
    Array.from({ length: 10 }, (_, i) => {
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
    }),
  );
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
  const kept = t.mock.method(console, "log", () => undefined);
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [], "it routes well");
  // The reason says what the bar is — not "what selling its capital again
  // would earn", which nobody compares (review 2026-11-10, OFFER-9).
  assert.ok(kept.mock.calls.some((c) => String(c.arguments[0]).endsWith(`lease over — kept open: it routes well (${SOLD_KEEP_BAR_TEXT})`)));
  assert.ok(SOLD_KEEP_BAR_TEXT.includes(`at least ${SOLD_CHANNEL_KEEP_PPM_YEAR.toLocaleString("en-US")} ppm a year`));
  // The other channel earns the node's money: the sold one is below it.
  forwardsEarning(s.node, "850000x6x0", 20_000);
  const fresh = s.restart(); // (what was kept is said once per process)
  await fresh.runOnce();
  assert.equal(s.closes().length, 1);
});

test("the node's own low average is no bar: a sold channel that earned above it, but under what its capital earns sold again, closes (56 sat a month kept a 2M channel out of the market)", async (t) => {
  quiet(t);
  const s = closer(t);
  const txid = "cd".repeat(32);
  s.node.channels.push({ id: "850000x5x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_500_000, transactionId: txid, transactionVout: 0 });
  // ~340 ppm/yr on its 2M, and the idle channel beside it halves the node's average.
  s.node.channels.push({ id: "850000x6x0", partnerPublicKey: OTHER, capacity: 2_000_000, localBalance: 1_000_000, transactionId: "ef".repeat(32), transactionVout: 0 });
  forwardsEarning(s.node, "850000x5x0", 56);
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 1, "closed: the capital goes back on the market");
});

test("the node's own average is a bar too: a sold channel that earned over 5,000 ppm a year, but less than a sat of this node's channels does, closes — and stays when it earns the node's average", async (t) => {
  // Review of the package (OFFER-9): the test above replaced the sold
  // channel's forwards with the other channel's, so the sold one earned
  // nothing when it closed — the node's average was never what closed it.
  quiet(t);
  const txid = "cd".repeat(32);
  const setup = (soldEarned: number) => {
    const s = closer(t);
    s.node.channels.push({ id: "850000x5x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_500_000, transactionId: txid, transactionVout: 0 });
    s.node.channels.push({ id: "850000x6x0", partnerPublicKey: OTHER, capacity: 2_000_000, localBalance: 1_000_000, transactionId: "ef".repeat(32), transactionVout: 0 });
    forwardsEarningEach(s.node, { "850000x5x0": soldEarned, "850000x6x0": 20_000 });
    s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
    return s;
  };
  // 2,000 sat in 30 days on the 1.5M a close frees: ~16,200 ppm a year, over
  // the fixed 5,000 — the node earns ~66,900 on its 4M (22,000 sat).
  const below = setup(2_000);
  await below.autopilot.runOnce();
  assert.equal(below.closes().length, 1, "under the node's average: closed, though over 5,000 ppm a year");
  // 20,000 sat: ~162,000 ppm a year on its 1.5M, the node ~121,700 on its 4M.
  const above = setup(20_000);
  await above.autopilot.runOnce();
  assert.deepEqual(above.closes(), [], "at least the node's average: kept");
});

test("what a sold channel earns is measured on the coins a close frees, and a close passes on the most it may pay", async (t) => {
  quiet(t);
  const s = closer(t);
  const txid = "cd".repeat(32);
  // 400 sat in 30 days: 2,433 ppm/yr on its 2M, 8,111 on the 600k a close frees.
  s.node.channels.push({ id: "850000x5x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 600_000, transactionId: txid, transactionVout: 0 });
  forwardsEarning(s.node, "850000x5x0", 400);
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [], "selling 600k again wouldn't earn that");

  const other = closer(t);
  const id2 = "ce".repeat(32);
  other.node.channels.push({ id: "850000x7x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: id2, transactionVout: 0 });
  other.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${id2}:0` });
  await other.autopilot.runOnce();
  const [call] = other.node.callsTo("default.closeChannel");
  assert.equal(Number(call.max_fee_per_vbyte), other.autopilot.getState().config.channelMaxFeeRate, "LND would otherwise negotiate up to 3× the rate");
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

test("N2: whether a finished lease's channel routes well can't be read — LND's forwarding history fails — it is kept, never closed on a guess (final review 2026-10-25)", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logs.push(String(line)));
  const s = closer(t);
  const txid = "cd".repeat(32);
  s.node.channels.push({ id: "850000x5x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_500_000, transactionId: txid, transactionVout: 0 });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  s.node.override("default.forwardingHistory", (_a, cb) => cb({ details: "rpc error: deadline exceeded" }));
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [], "before: closed — a failed read made it 'not routing well'");
  assert.ok(
    logs.some((l) => l.includes(sale.id) && l.includes("not closed yet: whether it routes well couldn't be read")),
    logs.filter((l) => l.includes(sale.id)).join("\n"),
  );
  // Readable again — it earned nothing: closed.
  s.node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 1);
});

test("N2: auto-close asks again right before each close — switched off while the close terms were read: no close (final review 2026-10-25)", async (t) => {
  quiet(t);
  const s = closer(t);
  const txid = "ce".repeat(32);
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  const real = s.autopilot.soldChannelClose.bind(s.autopilot);
  (s.autopilot as unknown as { soldChannelClose: () => ReturnType<typeof real> }).soldChannelClose = async () => {
    s.autopilot.setConfig({ sellAutoClose: false });
    return real();
  };
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
});

test("N2: the magma stage given up while the close terms were read — LND answering late — closes nothing when they come (final review 2026-10-25)", async (t) => {
  quiet(t);
  const saved = { ...WORK_DEADLINES_MS };
  const lane = LANE_PASS_DEADLINE.ms;
  Object.assign(WORK_DEADLINES_MS, { stage: 150, perRefill: 150, feeWork: 150, inflightCheck: 150, laneWork: 150 });
  LANE_PASS_DEADLINE.ms = 150;
  t.after(() => {
    Object.assign(WORK_DEADLINES_MS, saved);
    LANE_PASS_DEADLINE.ms = lane;
  });
  t.mock.method(console, "error", () => undefined);
  const s = closer(t);
  const txid = "ce".repeat(32);
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  let answer!: () => void;
  const late = new Promise<void>((r) => (answer = r));
  const real = s.autopilot.soldChannelClose.bind(s.autopilot);
  (s.autopilot as unknown as { soldChannelClose: () => ReturnType<typeof real> }).soldChannelClose = async () => {
    await late;
    return real();
  };
  const run = await s.autopilot.runOnce();
  assert.ok(run.errors?.some((e) => e.stage === "magma"), "the magma stage was given up");
  answer();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(s.closes(), [], "before: the given-up stage closed it once LND answered");
});

test("N5: a finished lease's channel kept for the same reason is one line in its order's history, however the figures in it move run to run (final review 2026-10-25)", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logs.push(String(line)));
  const s = closer(t, "25000"); // 100 sat/vB at the economy rate, above the 20 sat/vB maximum
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: "ce".repeat(32), transactionVout: 0 });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${"ce".repeat(32)}:0` });
  await s.autopilot.runOnce();
  s.node.override("wallet.estimateFee", (_a, cb) => cb(null, { sat_per_kw: "30000" })); // 120 sat/vB
  await s.autopilot.runOnce();
  const said = logs.filter((l) => l.includes(sale.id));
  assert.equal(said.length, 1, said.join("\n"));
  assert.match(said[0], /not closed yet: on-chain fees are 100 sat\/vB at the economy rate/);
  assert.deepEqual(s.closes(), []);
});

// ── Review 2026-11-10: LANE-3, OFFER-9, CHAN-5 ──────────────────────────────

/** The lane sells BUYER a 2,000,000 sat channel, and its funding confirms
 *  `age` blocks ago: the journal has the sale settled, with its lease. */
async function soldByLane(t: Parameters<typeof sellerSetup>[0], s: ReturnType<typeof closer>, age: number) {
  feeEnv(t);
  s.node.peers.push(BUYER);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, feeSeller: "12345", sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  s.magma.buyerPays(sale.id, s.node);
  await s.autopilot.pollSellOrders();
  const p = s.node.pending.find((x) => x.partnerPublicKey === BUYER);
  assert.ok(p, "the sold channel's funding is out");
  s.node.pending.splice(s.node.pending.indexOf(p), 1);
  const funded = s.node.blockHeight - age;
  s.node.channels.push({ id: `${funded}x7x${p.transactionVout}`, partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: p.transactionId, transactionVout: p.transactionVout });
  s.magma.setStatus(sale.id, "VALID_CHANNEL_OPENING");
  await s.autopilot.pollSellOrders();
  assert.deepEqual([entryOnDisk(s.dir, sale.id)?.phase, entryOnDisk(s.dir, sale.id)?.leaseBlocks], ["settled", 4320]);
  return { sale, funded };
}
const leaseEvents = (s: ReturnType<typeof closer>, id: string) => (entryOnDisk(s.dir, id)?.events ?? []).map((e) => e.what).filter((w) => w.startsWith("lease over"));

test("LANE-3: Amboss lists a sale's lease as over ten blocks into its 4,320 — by this node's count it runs, and the channel is not closed; once funding + lease + a day have passed it is (before: closed on the status alone)", async (t) => {
  quiet(t);
  const s = closer(t);
  const { sale, funded } = await soldByLane(t, s, 10);
  s.magma.setStatus(sale.id, "CHANNEL_MONITORING_FINISHED");
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [], "before: closed, 10 blocks into the lease");
  const ends = funded + 4320 + MAGMA_LEASE_MARGIN_BLOCKS;
  assert.deepEqual(leaseEvents(s, sale.id), [
    `lease over — not closed: Amboss lists the lease as over, but by this node's count it runs until block ${ends.toLocaleString("en-US")} ` +
      `(funded in block ${funded.toLocaleString("en-US")}, a lease of 4,320 blocks and a day) — 4,454 blocks to go`,
  ]);
  // The last block of the lease: still kept. The next: closed.
  s.node.blockHeight = ends - 1;
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
  s.node.blockHeight = ends;
  const run = await s.autopilot.runOnce();
  assert.equal(run.sells.find((a) => a.action === "close")?.ok, true);
  assert.equal(s.closes().length, 1);
  assert.ok(entryOnDisk(s.dir, sale.id)?.closedAt);
});

test("LANE-3: the same for a sale the journal has no record of — the lease's length is the order's on Amboss; with none there either, the channel is never closed on the status alone", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logs.push(String(line)));
  const s = closer(t);
  const height = s.node.blockHeight;
  const txid = "ce".repeat(32);
  s.node.channels.push({ id: `${height - 100}x7x0`, partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  // No lease length on the order, here or at Amboss.
  const other = "cf".repeat(32);
  s.node.channels.push({ id: "800000x9x0", partnerPublicKey: OTHER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: other, transactionVout: 0 });
  const blank = s.magma.addSale({ buyerPubkey: OTHER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${other}:0`, promises: { minBlockLength: 0, feeRateCap: "2200", baseFeeCap: "1" } });
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [], "before: both closed");
  assert.deepEqual(
    logs.filter((l) => l.includes(sale.id)),
    [
      `[magma] order ${sale.id}: lease over — not closed: Amboss lists the lease as over, but by this node's count it runs until block ${(height + 4364).toLocaleString("en-US")} ` +
        `(funded in block ${(height - 100).toLocaleString("en-US")}, a lease of 4,320 blocks and a day) — 4,364 blocks to go`,
    ],
  );
  assert.deepEqual(
    logs.filter((l) => l.includes(blank.id)),
    [`[magma] order ${blank.id}: lease over — not closed: how long this lease runs is on no record here or at Amboss — it is not closed on Amboss's status alone`],
  );
  // 4,464 blocks after the funding: the first is closed, the other stays.
  s.node.blockHeight = height + 4364;
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes().length, 1);
  assert.deepEqual(s.node.callsTo("default.closeChannel").map((a) => Buffer.from((a.channel_point as { funding_txid_bytes: Buffer }).funding_txid_bytes).reverse().toString("hex")), [txid]);
});

test("LANE-3: this node's block height can't be read — the lease's end can't be counted, and nothing is closed", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logs.push(String(line)));
  const s = closer(t);
  const txid = "ce".repeat(32);
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  s.node.blockHeight = 0;
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
  assert.ok(logs.some((l) => l.includes(sale.id) && l.includes("not closed yet: this node's block height couldn't be read")), logs.join("\n"));
});

test("LANE-3: the block the channel's funding confirmed in is unknown — the lease's end can't be counted, and nothing is closed", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logs.push(String(line)));
  const s = closer(t);
  const txid = "ce".repeat(32);
  // A channel id that names no block (an alias, a funding LND lists at height 0).
  s.node.channels.push({ id: "0x7x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
  assert.deepEqual(
    logs.filter((l) => l.includes(sale.id)),
    [`[magma] order ${sale.id}: lease over — not closed yet: the block its funding confirmed in is unknown, so the lease's end can't be counted`],
  );
});

test("OFFER-9: with selling off nothing lists the running leases (the offer upkeep does that) — the close asks Amboss itself, and a channel another sale's lease still runs on is not closed", async (t) => {
  quiet(t);
  const s = closer(t);
  s.autopilot.setConfig({ sellEnabled: false });
  const txid = "cd".repeat(32);
  s.node.channels.push({ id: "850000x7x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  const running = s.magma.addSale({ buyerPubkey: BUYER, status: "VALID_CHANNEL_OPENING", channelId: chanNumber("850000x7x0"), transactionId: `${txid}:0` });
  assert.deepEqual(s.autopilot.magma.runningLeasesOnAmboss(), [], "no listing yet: selling never ran");
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [], "going by the listing in memory — none — closed it");
  assert.equal(s.autopilot.magma.runningLeasesOnAmboss().length, 1, "the close listed the running leases first");
  // That lease over too (and the listing an hour old): now it closes.
  s.magma.setStatus(running.id, "CHANNEL_MONITORING_FINISHED");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + AMBOSS_LEASES_MAX_AGE_MS + 60_000 });
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 1, "one close, though two finished sales name the channel");
});

test("OFFER-9: a lease that ends with “Liquidity provision” off is closed all the same — auto-close is its own setting (before: nothing was closed until selling was on again); not while all automation is paused", async (t) => {
  quiet(t);
  const s = closer(t);
  const txid = "ce".repeat(32);
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  // Paused: selling goes off with everything else — and nothing is closed.
  s.autopilot.pauseAll();
  assert.deepEqual([s.autopilot.getState().config.sellEnabled, s.autopilot.getState().config.sellAutoClose], [false, true]);
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), [], "paused: no on-chain action");
  // Resumed: selling stays off (it is switched on by hand) — the close goes out.
  s.autopilot.resumeAll();
  assert.equal(s.autopilot.getState().config.sellEnabled, false);
  const run = await s.autopilot.runOnce();
  assert.equal(run.sells.find((a) => a.action === "close")?.ok, true, "before: no close with selling off");
  assert.equal(s.closes().length, 1);
});

test("OFFER-9: selling off and auto-close off: nothing is closed", async (t) => {
  quiet(t);
  const s = closer(t);
  const txid = "ce".repeat(32);
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  s.autopilot.setConfig({ sellEnabled: false, sellAutoClose: false });
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
});

test("OFFER-9 / CHAN-5: the buyer's node is offline — a cooperative close takes both sides, so none is asked for (before: a failed close every run); said once, and closed when the buyer is back", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logs.push(String(line)));
  const s = closer(t);
  const txid = "ce".repeat(32);
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0, isActive: false });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  const first = await s.autopilot.runOnce();
  const second = await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
  assert.deepEqual([...first.sells, ...second.sells].filter((a) => a.action === "close"), [], "no failed close in the run history");
  assert.deepEqual(
    logs.filter((l) => l.includes(sale.id)),
    [`[magma] order ${sale.id}: lease over — not closed yet: the buyer's node is offline, and closing takes both sides — tried again once it is back (a force close stays yours to decide, on Channels)`],
  );
  s.node.channels[0].isActive = true;
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 1);
});

/** LND ends each close with `details` (its stream's error). */
function closeFails(s: ReturnType<typeof closer>, details: string): void {
  s.node.override("default.closeChannel", () => {
    const st = Object.assign(new EventEmitter(), { cancel: () => undefined });
    setImmediate(() => st.emit("error", { details }));
    return st;
  });
}
const FEE_REFUSED = "unable to process close msg: latest fee proposal exceeds max fee: 0.00000933 BTC > 0.00000900 BTC";

test("CHAN-5: the buyer's node refuses the close for its fee — LND goes on with the shutdown: said once with what that means, and the close is not asked again each run (before: a plain failure, every run); asked again a day later if the channel is still open", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const logs: string[] = [];
  t.mock.method(console, "log", (line: unknown) => void logs.push(String(line)));
  const s = closer(t);
  const txid = "ce".repeat(32);
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  closeFails(s, FEE_REFUSED);
  const max = s.autopilot.getState().config.channelMaxFeeRate;
  const text =
    `The peer wants more than the ${max} sat/vB maximum, so this round ended without a closing transaction. ` +
    "The channel is shutting down all the same: LND normally finishes the close with the peer at its own fee estimate — which can be above that maximum.";
  const first = await s.autopilot.runOnce();
  assert.deepEqual(
    first.sells.filter((a) => a.action === "close").map((a) => [a.ok, a.error]),
    [[false, text]],
  );
  const again = await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 1, "before: asked again on every run");
  assert.deepEqual(again.sells.filter((a) => a.action === "close"), []);
  assert.deepEqual(
    logs.filter((l) => l.includes(sale.id)),
    [`[magma] order ${sale.id}: lease over — close asked at 2 sat/vB. ${text} Asked again in a day if the channel is still open then.`],
  );
  // A day on, the channel still open: asked again.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + CLOSE_ASKED_RETRY_MS + 60_000 });
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 2);
});

test("CHAN-5: for a sale on the journal the refused close is on its record — a restart does not ask again either — and any other failure is still tried again the next run", async (t) => {
  quiet(t);
  const s = closer(t);
  const { sale } = await soldByLane(t, s, 5_000);
  s.magma.setStatus(sale.id, "CHANNEL_MONITORING_FINISHED");
  closeFails(s, "rpc error: chain backend is still syncing");
  const failed = await s.autopilot.runOnce();
  assert.deepEqual(failed.sells.filter((a) => a.action === "close").map((a) => a.ok), [false]);
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 2, "a plain failure: tried again");
  assert.equal(entryOnDisk(s.dir, sale.id)?.closeAskedAt, undefined);
  closeFails(s, FEE_REFUSED);
  await s.autopilot.runOnce();
  assert.equal(s.closes().length, 3);
  assert.ok(entryOnDisk(s.dir, sale.id)?.closeAskedAt, "on the order's record");
  assert.equal(leaseEvents(s, sale.id).filter((w) => w.startsWith("lease over — close asked at 2 sat/vB. The peer wants more than")).length, 1);
  const fresh = s.restart();
  await fresh.runOnce();
  assert.equal(s.closes().length, 3, "not asked again after a restart");
  assert.equal(entryOnDisk(s.dir, sale.id)?.closedAt, undefined);
  // LND finishes that close with the buyer's node: the channel is open no
  // more. Before, the order's record never said so — it read "close asked …
  // asked again in a day" for good (review of the package).
  const sold = s.node.channels.findIndex((c) => c.partnerPublicKey === BUYER);
  s.node.channels.splice(sold, 1);
  await fresh.runOnce();
  await fresh.runOnce();
  const e = entryOnDisk(s.dir, sale.id);
  assert.ok(e?.closedAt, "closed, on the order's record");
  assert.equal(e?.closeAskedAt, undefined);
  assert.equal(leaseEvents(s, sale.id).filter((w) => w === "lease over — the channel is no longer open (a close was asked for earlier)").length, 1, "said once");
  assert.equal(s.closes().length, 3, "and nothing more is asked of LND");
});

test("CHAN-5: a sold channel gone with no close asked of it by the autopilot — closed by hand, or by the buyer — is not written down as the autopilot's close", async (t) => {
  quiet(t);
  const s = closer(t);
  const { sale } = await soldByLane(t, s, 5_000);
  s.magma.setStatus(sale.id, "CHANNEL_MONITORING_FINISHED");
  s.node.channels.splice(s.node.channels.findIndex((c) => c.partnerPublicKey === BUYER), 1);
  await s.autopilot.runOnce();
  assert.deepEqual(s.closes(), []);
  assert.deepEqual(leaseEvents(s, sale.id), []);
  assert.equal(entryOnDisk(s.dir, sale.id)?.closedAt, undefined);
});
