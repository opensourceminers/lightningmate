/**
 * P&L's close costs (review a5-analytics:close-costs-always-zero, package P6).
 *
 * Before: a chain transaction was booked as a close cost only when LND
 * reported it OUTGOING with a FEE. A close never is: it spends the 2-of-2
 * funding output, so btcwallet reports no fee (it computes one only when
 * every input is a wallet coin), and a cooperative close only pays our
 * balance back (amount > 0: incoming). Force-close commitments, anchor CPFPs
 * and sweeps have a non-wallet input too. "Closes" read 0 for every node.
 *
 * Now each close's costs come from the transactions themselves (parsed from
 * the raw hex LND keeps — never looked up anywhere), charged to whoever paid
 * them. These tests build real transactions, byte for byte, and hand them to
 * the app the way LND's GetTransactions and ClosedChannels report them —
 * a commitment this node published as btcwallet keeps it: unconfirmed for
 * good (it pays no wallet address, so the wallet never sees it mined).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChainTransactions, getClosedChannels } from "lightning";
import { parseRawTx } from "../src/services/rawTx.js";
import { closeCostsFrom, closedFactsOf, walletTxsOf, type ClosedChannelFacts, type WalletTx } from "../src/services/closeCosts.js";
import { CloseTxArchive } from "../src/services/closeTxArchive.js";
import { Autopilot } from "../src/services/autopilot.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { JsonStore, storeIncidents } from "../src/store.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { startApi } from "./helpers/apiHarness.js";
import { closedChannel, coin, installChain, installPayments, rawTx, walletTx } from "./helpers/chain.js";
import { quiet } from "./helpers/lifecycle.js";
import { makeTempDir } from "./helpers/tmp.js";

const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number) => now - days * DAY;

/** A channel this node funded from the wallet: the funding transaction (its
 *  fee reported by the wallet, every input being a wallet coin). */
function funded(capacity: number, feeSats = 3_000, atMs = ago(60), confirmations = 6) {
  const tx = rawTx({ inputs: [coin()], outputs: [{ value: capacity }, { value: 500_000 }] });
  return { tx, wallet: walletTx(tx, { amount: -(capacity + feeSats), fee: feeSats, at: atMs, local: true, confirmations }) };
}

/** A commitment this node published, as btcwallet keeps it: in the wallet,
 *  nothing of the wallet's in it — and unconfirmed for good (it pays no
 *  wallet address, so the wallet is never told it was mined). */
const ourCommitment = (tx: ReturnType<typeof rawTx>, atMs: number) => walletTx(tx, { amount: 0, at: atMs, confirmations: 0 });

const PEER = "02" + "c3".repeat(32);

/** A node whose P&L reads only these chain records (no forwards, no payments). */
async function pnlApi(t: TestContext, chain: Parameters<typeof installChain>[1], opts: { node?: FakeLnd; dir?: string } = {}) {
  quiet(t);
  const node = opts.node ?? new FakeLnd({ chainBalance: 1_000_000 });
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  installPayments(node, []);
  const state = installChain(node, chain);
  const api = await startApi(t, { node, dir: opts.dir });
  return { api, node, state };
}

test("the raw transaction parser reads the legacy and the segwit form alike — and refuses what isn't a whole transaction", () => {
  const spec = {
    inputs: [{ txid: "11".repeat(32), vout: 3, sequence: 0xfffffffd }],
    outputs: [{ value: 1_234_567, script: "0014" + "22".repeat(20) }, { value: 330, script: "0020" + "33".repeat(32) }],
    locktime: 859_999,
  };
  const segwit = rawTx({ ...spec, witness: true });
  const legacy = rawTx({ ...spec, witness: false });
  for (const built of [segwit, legacy]) {
    const tx = parseRawTx(built.hex);
    assert.deepEqual(tx.inputs, [{ txid: "11".repeat(32), vout: 3, sequence: 0xfffffffd }]);
    assert.deepEqual(tx.outputs.map((o) => o.value), [1_234_567, 330]);
    assert.equal(tx.locktime, 859_999);
  }
  assert.equal(segwit.txid, legacy.txid, "the txid never covers the witness");
  for (const bad of ["", "zz", segwit.hex.slice(0, -2), segwit.hex + "00", "0200000000"]) {
    assert.throws(() => parseRawTx(bad), Error, bad);
  }
});

test("a cooperative close this node funded costs its closing transaction's fee — P&L's Closes reads it (before: 0 for every node)", async (t) => {
  const chan = funded(2_000_000);
  // Our 1,198,600 back to the wallet, the peer's 800,000: 1,400 sat fee.
  const close = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 1_198_600 }, { value: 800_000 }] });
  const { api } = await pnlApi(t, {
    txs: [chan.wallet, walletTx(close, { amount: 1_198_600, at: ago(5) })], // incoming, no fee: what LND reports
    closed: [closedChannel({ id: "850000x1x0", capacity: 2_000_000, funding: { txid: chan.tx.txid, vout: 0 }, closeTxid: close.txid, type: "COOPERATIVE_CLOSE", weOpened: true, weClosed: true })],
  });
  const p = (await api.request("GET", "/pnl?days=30")).body;
  assert.equal(p.channelCloseCostSats, 1_400);
  assert.equal(p.channelCloseCount, 1);
  assert.equal(p.channelCloseUnknownCount, 0);
  assert.equal(p.otherChainFeesSats, 0);
  const all = (await api.request("GET", "/pnl?days=36500")).body;
  assert.equal(all.channelOpenCostSats, 3_000);
  assert.equal(all.totalCostSats, 4_400, "the open and the close");
  assert.equal(all.netProfitSats, -4_400);
});

test("a cooperative close the peer funded costs this node nothing — the funder pays a legacy close; with the RBF close protocol the closer pays", async (t) => {
  const peers = rawTx({ inputs: [coin()], outputs: [{ value: 1_000_000 }] }); // the peer's funding: not in our wallet
  const legacyClose = rawTx({ inputs: [{ txid: peers.txid, vout: 0 }], outputs: [{ value: 300_000 }, { value: 699_000 }] });
  const peers2 = rawTx({ inputs: [coin()], outputs: [{ value: 1_000_000 }] });
  // option_simple_close: nSequence 0xfffffffd, a locktime — we closed it, we paid.
  const rbfClose = rawTx({ inputs: [{ txid: peers2.txid, vout: 0, sequence: 0xfffffffd }], outputs: [{ value: 299_000 }, { value: 700_000 }], locktime: 859_400 });
  const { api } = await pnlApi(t, {
    txs: [walletTx(legacyClose, { amount: 300_000, at: ago(3) }), walletTx(rbfClose, { amount: 299_000, at: ago(2) })],
    closed: [
      closedChannel({ id: "851000x1x0", capacity: 1_000_000, funding: { txid: peers.txid, vout: 0 }, closeTxid: legacyClose.txid, type: "COOPERATIVE_CLOSE", weOpened: false, weClosed: true }),
      closedChannel({ id: "851001x1x0", capacity: 1_000_000, funding: { txid: peers2.txid, vout: 0 }, closeTxid: rbfClose.txid, type: "COOPERATIVE_CLOSE", weOpened: false, weClosed: true }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=30")).body;
  assert.equal(p.channelCloseCount, 2);
  assert.equal(p.channelCloseCostSats, 1_000, "only the RBF close we made (1,000,000 − 999,000); the legacy one was the funder's");
});

test("a force close this node funded: the commitment's fee, the anchor CPFP, the sweep of its own balance and a second-level HTLC claim — all counted, a later ordinary spend not", async (t) => {
  const chan = funded(3_000_000);
  // Commitment: to_local 2,000,000, to_remote 990,000, two anchors: 9,340 fee.
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 2_000_000 }, { value: 990_000 }, { value: 330 }, { value: 330 }] });
  // Anchor CPFP: our anchor + a wallet coin of 100,000 → 95,330 back: 5,000 fee.
  const walletCoin = rawTx({ inputs: [coin()], outputs: [{ value: 100_000 }] });
  const cpfp = rawTx({ inputs: [{ txid: commit.txid, vout: 2 }, { txid: walletCoin.txid, vout: 0 }], outputs: [{ value: 95_330 }] });
  // After the CSV delay: to_local swept, 1,999,000 back: 1,000 fee.
  const sweep = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 1_999_000 }] });
  // A later open funded from that payout: an ordinary spend, the open's fee.
  const reopen = rawTx({ inputs: [{ txid: sweep.txid, vout: 0 }], outputs: [{ value: 1_500_000 }, { value: 497_000 }] });
  const { api } = await pnlApi(t, {
    txs: [
      chan.wallet,
      walletTx(walletCoin, { amount: 100_000, at: ago(30) }),
      ourCommitment(commit, ago(20)), // published by us: in the wallet, nothing of ours in it, never seen mined
      walletTx(cpfp, { amount: -4_670, at: ago(20), local: [false, true] }),
      walletTx(sweep, { amount: 1_999_000, at: ago(18) }),
      walletTx(reopen, { amount: -1_502_000, fee: 2_000, at: ago(10), local: true }),
    ],
    closed: [
      closedChannel({
        id: "852000x1x0",
        capacity: 3_000_000,
        funding: { txid: chan.tx.txid, vout: 0 },
        closeTxid: commit.txid,
        type: "LOCAL_FORCE_CLOSE",
        weOpened: true,
        weClosed: true,
        sweeps: [
          { type: "ANCHOR", vout: 2, amount: 330, txid: cpfp.txid },
          { type: "COMMIT", vout: 0, amount: 2_000_000, txid: sweep.txid },
        ],
      }),
    ],
  });
  // The reopen's channel is open now: its funding is an open.
  const p = (await api.request("GET", "/pnl?days=36500")).body;
  // The funder paid both anchors: the peer's (vout 3) is lost with the
  // commitment's fee; ours (vout 2) went into the CPFP's fee as an input.
  assert.equal(p.channelCloseCostSats, 9_340 + 330 + 5_000 + 1_000);
  assert.equal(p.channelCloseUnknownCount, 0);
  assert.equal(p.otherChainFeesSats, 2_000, "the reopen is a send of its own here (its channel isn't listed) — never a close cost");
  assert.equal(p.channelCloseCount, 1);
});

test("a remote force close of a channel this node funded, whose commitment isn't in the wallet: counted with its cost unknown — never as 0 — and the P&L says so", async (t) => {
  const chan = funded(1_500_000);
  const theirCommit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 700_000 }, { value: 795_000 }] });
  // Our to_remote swept: its parent (their commitment) is not in our wallet.
  const sweep = rawTx({ inputs: [{ txid: theirCommit.txid, vout: 0 }], outputs: [{ value: 699_500 }] });
  const { api } = await pnlApi(t, {
    txs: [chan.wallet, walletTx(sweep, { amount: 699_500, at: ago(4) })],
    closed: [
      closedChannel({
        id: "853000x1x0",
        capacity: 1_500_000,
        funding: { txid: chan.tx.txid, vout: 0 },
        closeTxid: theirCommit.txid,
        closeHeight: 860_000 - 900,
        type: "REMOTE_FORCE_CLOSE",
        weOpened: true,
        weClosed: false,
        sweeps: [{ type: "COMMIT", vout: 0, amount: 700_000, txid: sweep.txid }],
      }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=30")).body;
  assert.equal(p.channelCloseCount, 1, "dated from its block: ~6 days ago");
  assert.equal(p.channelCloseUnknownCount, 1);
  assert.equal(p.channelCloseCostSats, 0);
  assert.ok(
    p.notes.some((n: string) => /1 of 1 close in this window: cost partly unknown — its closing transaction is not in this node's wallet; a sweep of it spends a coin this node's wallet doesn't know/.test(n)),
    JSON.stringify(p.notes),
  );
});

test("each close fee is booked when it was paid: a sweep in the window counts there, its close from before the window only in a longer one", async (t) => {
  const chan = funded(1_000_000, 2_000, ago(90));
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 600_000 }, { value: 395_000 }] });
  const sweep = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 599_200 }] });
  const { api } = await pnlApi(t, {
    txs: [chan.wallet, ourCommitment(commit, ago(40)), walletTx(sweep, { amount: 599_200, at: ago(25) })],
    closed: [
      closedChannel({ id: "854000x1x0", capacity: 1_000_000, funding: { txid: chan.tx.txid, vout: 0 }, closeTxid: commit.txid, type: "LOCAL_FORCE_CLOSE", weOpened: true, weClosed: true }),
    ],
  });
  const d30 = (await api.request("GET", "/pnl?days=30")).body;
  assert.deepEqual([d30.channelCloseCostSats, d30.channelCloseCount], [800, 0], "the sweep; the close itself was 40 days ago");
  const d90 = (await api.request("GET", "/pnl?days=90")).body;
  assert.deepEqual([d90.channelCloseCostSats, d90.channelCloseCount], [5_000 + 800, 1]);
});

test("a sweep that batches two channels' outputs is shared between them by the inputs each put in — its fee counted once", async () => {
  const a = rawTx({ inputs: [coin()], outputs: [{ value: 1_000_000 }] });
  const b = rawTx({ inputs: [coin()], outputs: [{ value: 2_000_000 }] });
  const commitA = rawTx({ inputs: [{ txid: a.txid, vout: 0 }], outputs: [{ value: 500_000 }, { value: 498_000 }] });
  const commitB = rawTx({ inputs: [{ txid: b.txid, vout: 0 }], outputs: [{ value: 900_000 }, { value: 100_000 }, { value: 997_000 }] });
  // One sweep: A's to_local, B's to_local and an HTLC of B → 1,497,000: 3,000 fee.
  const batch = rawTx({ inputs: [{ txid: commitA.txid, vout: 0 }, { txid: commitB.txid, vout: 0 }, { txid: commitB.txid, vout: 1 }], outputs: [{ value: 1_497_000 }] });
  const node = new FakeLnd();
  installChain(node, {
    txs: [ourCommitment(commitA, ago(10)), ourCommitment(commitB, ago(10)), walletTx(batch, { amount: 1_497_000, at: ago(5) })],
    closed: [
      closedChannel({ id: "855000x1x0", capacity: 1_000_000, funding: { txid: a.txid, vout: 0 }, closeTxid: commitA.txid, type: "LOCAL_FORCE_CLOSE", weOpened: false, weClosed: true }),
      closedChannel({ id: "855001x1x0", capacity: 2_000_000, funding: { txid: b.txid, vout: 0 }, closeTxid: commitB.txid, type: "LOCAL_FORCE_CLOSE", weOpened: false, weClosed: true }),
    ],
  });
  // Through the real library's mappers, as P&L reads them.
  const [chain, closed] = await Promise.all([getChainTransactions({ lnd: node.lnd }), getClosedChannels({ lnd: node.lnd })]);
  const costs = closeCostsFrom(closedFactsOf(closed.channels), walletTxsOf(chain.transactions), { nowMs: now, height: 860_000 });
  // The peer funded both: the commitments' fees are theirs; the sweep is ours.
  assert.deepEqual(
    costs.map((c) => [c.channelId, c.fees.map((f) => [f.what, f.sats])]),
    [
      ["855000x1x0", [["sweep", 1_000]]],
      ["855001x1x0", [["sweep", 2_000]]],
    ],
  );
});

test("LND not saying who funded a channel: its close is counted, its cost unknown — never guessed", () => {
  const f = rawTx({ inputs: [coin()], outputs: [{ value: 1_000_000 }] });
  const close = rawTx({ inputs: [{ txid: f.txid, vout: 0 }], outputs: [{ value: 999_000 }] });
  const [cost] = closeCostsFrom(
    [{ channelId: "856000x1x0", capacity: 1_000_000, fundingTxid: f.txid, fundingVout: 0, closeTxid: close.txid, closeHeight: null, kind: "cooperative", weFunded: null, weClosed: null, sweepTxids: [] }],
    [{ id: close.txid, createdAt: new Date(ago(1)).toISOString(), isConfirmed: true, isOutgoing: false, transaction: close.hex, inputs: [] }],
    { nowMs: now, height: null },
  );
  assert.deepEqual([cost.fees, cost.unknown], [[], "LND doesn't say who funded it"]);
});

test("only what a close's own outputs paid for: a CPFP for one force close funded with the coin another close's sweep paid back is the first one's cost alone", async (t) => {
  const x = funded(1_000_000);
  const y = funded(1_000_000);
  const commitX = rawTx({ inputs: [{ txid: x.tx.txid, vout: 0 }], outputs: [{ value: 600_000 }, { value: 395_000 }] }); // 5,000 fee
  const sweepX = rawTx({ inputs: [{ txid: commitX.txid, vout: 0 }], outputs: [{ value: 599_000 }] }); // 1,000 fee, pays the wallet
  const commitY = rawTx({ inputs: [{ txid: y.tx.txid, vout: 0 }], outputs: [{ value: 500_000 }, { value: 495_670 }, { value: 330 }] }); // 4,000 fee
  // Y's anchor bumped with the coin X's sweep paid back: 330 + 599,000 → 597,330 (2,000 fee).
  const cpfpY = rawTx({ inputs: [{ txid: commitY.txid, vout: 2 }, { txid: sweepX.txid, vout: 0 }], outputs: [{ value: 597_330 }] });
  const { api } = await pnlApi(t, {
    txs: [
      x.wallet,
      y.wallet,
      ourCommitment(commitX, ago(20)),
      walletTx(sweepX, { amount: 599_000, at: ago(18) }),
      ourCommitment(commitY, ago(10)),
      walletTx(cpfpY, { amount: -1_670, at: ago(10), local: [false, true] }),
    ],
    closed: [
      closedChannel({ id: "857000x1x0", capacity: 1_000_000, funding: { txid: x.tx.txid, vout: 0 }, closeTxid: commitX.txid, type: "LOCAL_FORCE_CLOSE", weOpened: true, weClosed: true }),
      closedChannel({ id: "857001x1x0", capacity: 1_000_000, funding: { txid: y.tx.txid, vout: 0 }, closeTxid: commitY.txid, type: "LOCAL_FORCE_CLOSE", weOpened: true, weClosed: true }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=36500")).body;
  // X: 5,000 + 1,000; Y: 4,000 + 2,000. Before the wallet-coin check, X's
  // tree took a share of Y's CPFP through the coin it had paid back.
  assert.equal(p.channelCloseCostSats, 6_000 + 6_000);
  const [chainTxs, closed] = await Promise.all([getChainTransactions({ lnd: api.node.lnd }), getClosedChannels({ lnd: api.node.lnd })]);
  const byChannel = Object.fromEntries(
    closeCostsFrom(closedFactsOf(closed.channels), walletTxsOf(chainTxs.transactions), { nowMs: now, height: 860_000 }).map((c) => [c.channelId, c.fees.reduce((s, f) => s + f.sats, 0)]),
  );
  assert.deepEqual(byChannel, { "857000x1x0": 6_000, "857001x1x0": 6_000 });
});

test("an LND too old to list inputs: an ordinary spend of a close's payout (the wallet saw its fee) is never taken for a sweep", async (t) => {
  const chan = funded(1_000_000);
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 700_000 }, { value: 297_000 }] }); // 3,000 fee
  const sweep = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 699_000 }] }); // 1,000 fee
  const spend = rawTx({ inputs: [{ txid: sweep.txid, vout: 0 }], outputs: [{ value: 500_000 }, { value: 197_000 }] }); // a send: 2,000 fee
  const { api } = await pnlApi(t, {
    txs: [
      chan.wallet,
      walletTx(commit, { amount: 0, at: ago(20), noInputs: true, confirmations: 0 }),
      walletTx(sweep, { amount: 699_000, at: ago(18), noInputs: true }),
      walletTx(spend, { amount: -502_000, fee: 2_000, at: ago(5), noInputs: true }),
    ],
    closed: [
      closedChannel({ id: "858000x1x0", capacity: 1_000_000, funding: { txid: chan.tx.txid, vout: 0 }, closeTxid: commit.txid, type: "LOCAL_FORCE_CLOSE", weOpened: true, weClosed: true }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=36500")).body;
  assert.deepEqual([p.channelCloseCostSats, p.otherChainFeesSats], [3_000 + 1_000, 2_000]);
});

test("a sweep LND replaced (RBF) counts once: only the confirmed version, never the replaced one left unconfirmed in the wallet", async (t) => {
  const chan = funded(1_000_000);
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 700_000 }, { value: 297_000 }] }); // 3,000 fee
  const first = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 699_500 }] }); // 500 fee, replaced
  const bumped = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 698_800 }] }); // 1,200 fee, confirmed
  const { api } = await pnlApi(t, {
    txs: [
      chan.wallet,
      ourCommitment(commit, ago(20)),
      walletTx(first, { amount: 699_500, at: ago(19), confirmations: 0 }),
      walletTx(bumped, { amount: 698_800, at: ago(18) }),
    ],
    closed: [
      closedChannel({ id: "859000x1x0", capacity: 1_000_000, funding: { txid: chan.tx.txid, vout: 0 }, closeTxid: commit.txid, type: "LOCAL_FORCE_CLOSE", weOpened: true, weClosed: true }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=36500")).body;
  assert.equal(p.channelCloseCostSats, 3_000 + 1_200);
});

test("a breach close costs only the justice transaction: the cheater's old commitment was theirs to pay, and every output came back", async (t) => {
  const chan = funded(1_000_000); // we funded it
  // The peer broadcast an old state (its fee 4,000 out of the funding) …
  const oldState = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 400_000 }, { value: 596_000 }] });
  // … and our justice transaction claimed both outputs: 996,000 → 994,500.
  const justice = rawTx({ inputs: [{ txid: oldState.txid, vout: 0 }, { txid: oldState.txid, vout: 1 }], outputs: [{ value: 994_500 }] });
  const { api } = await pnlApi(t, {
    txs: [chan.wallet, walletTx(oldState, { amount: 0, at: ago(6) }), walletTx(justice, { amount: 994_500, at: ago(5) })],
    closed: [
      closedChannel({ id: "860000x1x0", capacity: 1_000_000, funding: { txid: chan.tx.txid, vout: 0 }, closeTxid: oldState.txid, type: "BREACH_CLOSE", weOpened: true, weClosed: false }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=30")).body;
  assert.deepEqual([p.channelCloseCostSats, p.channelCloseCount, p.channelCloseUnknownCount], [1_500, 1, 0]);
});

// ── Review of P6: what the wallet can't vouch for, and what it forgets ──────

test("a local force close whose commitment the wallet still calls unconfirmed (it never sees it mined) costs its fee — the channel is listed as closed, so it confirmed (before: silently 0, not even 'cost unknown')", async (t) => {
  const chan = funded(3_000_000);
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 2_000_000 }, { value: 990_000 }, { value: 330 }, { value: 330 }] }); // 9,340 fee
  const sweep = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 1_999_000 }] }); // 1,000 fee
  const { api } = await pnlApi(t, {
    txs: [chan.wallet, ourCommitment(commit, ago(20)), walletTx(sweep, { amount: 1_999_000, at: ago(18) })],
    closed: [
      closedChannel({
        id: "861000x1x0",
        capacity: 3_000_000,
        funding: { txid: chan.tx.txid, vout: 0 },
        closeTxid: commit.txid,
        type: "LOCAL_FORCE_CLOSE",
        weOpened: true,
        weClosed: true,
        sweeps: [{ type: "COMMIT", vout: 0, amount: 2_000_000, txid: sweep.txid }],
      }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=36500")).body;
  // The commitment's fee and both anchors (neither swept: the funder's loss), and the sweep.
  assert.deepEqual([p.channelCloseCostSats, p.channelCloseCount, p.channelCloseUnknownCount], [9_340 + 660 + 1_000, 1, 0]);
  const d30 = (await api.request("GET", "/pnl?days=30")).body;
  assert.equal(d30.channelCloseCostSats, 11_000, "booked when the commitment went out, 20 days ago");
});

test("a legacy channel's second-level HTLC transaction, which the wallet keeps unconfirmed (it pays a timelocked script), counts once a confirmed sweep spends it — a transaction only confirms once what it spends has", async (t) => {
  const chan = funded(2_000_000);
  // Commitment: to_local 1,200,000, to_remote 700,000, an outgoing HTLC of 95,000: 5,000 fee.
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 1_200_000 }, { value: 700_000 }, { value: 95_000 }] });
  // The HTLC timed out: the second-level timeout transaction pays its fee out of it (2,000) …
  const timeout = rawTx({ inputs: [{ txid: commit.txid, vout: 2 }], outputs: [{ value: 93_000 }] });
  // … and after its delay the sweep to the wallet (500); to_local swept too (1,000).
  const htlcSweep = rawTx({ inputs: [{ txid: timeout.txid, vout: 0 }], outputs: [{ value: 92_500 }] });
  const localSweep = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 1_199_000 }] });
  // A version of the timeout LND replaced (RBF) stays unconfirmed: no confirmed transaction spends it.
  const replaced = rawTx({ inputs: [{ txid: commit.txid, vout: 2 }], outputs: [{ value: 94_000 }] });
  const { api } = await pnlApi(t, {
    txs: [
      chan.wallet,
      ourCommitment(commit, ago(20)),
      walletTx(replaced, { amount: 0, at: ago(19.5), confirmations: 0 }),
      walletTx(timeout, { amount: 0, at: ago(19), confirmations: 0 }),
      walletTx(localSweep, { amount: 1_199_000, at: ago(18) }),
      walletTx(htlcSweep, { amount: 92_500, at: ago(17) }),
    ],
    closed: [
      closedChannel({
        id: "862000x1x0",
        capacity: 2_000_000,
        funding: { txid: chan.tx.txid, vout: 0 },
        closeTxid: commit.txid,
        type: "LOCAL_FORCE_CLOSE",
        weOpened: true,
        weClosed: true,
        // LND names only the to_local sweep here: the HTLC's second stage is
        // known confirmed only through the sweep that spends it.
        sweeps: [{ type: "COMMIT", vout: 0, amount: 1_200_000, txid: localSweep.txid }],
      }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=36500")).body;
  // Before: 1,500 (the two sweeps the wallet saw mined).
  assert.deepEqual([p.channelCloseCostSats, p.channelCloseUnknownCount], [5_000 + 2_000 + 500 + 1_000, 0]);
});

test("a transaction LND names as having claimed a channel output counts as confirmed, whatever the wallet's flag — even with nothing in the wallet to show it", async (t) => {
  const chan = funded(2_000_000);
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 1_200_000 }, { value: 700_000 }, { value: 95_000 }] }); // 5,000 fee
  const timeout = rawTx({ inputs: [{ txid: commit.txid, vout: 2 }], outputs: [{ value: 93_000 }] }); // 2,000 fee
  const htlcSweep = rawTx({ inputs: [{ txid: timeout.txid, vout: 0 }], outputs: [{ value: 92_500 }] });
  const { api } = await pnlApi(t, {
    txs: [
      chan.wallet,
      ourCommitment(commit, ago(20)),
      walletTx(timeout, { amount: 0, at: ago(19), confirmations: 0 }),
      // The final sweep came without its raw transaction: what it spends can't be read.
      walletTx(htlcSweep, { amount: 92_500, at: ago(17), hex: false }),
    ],
    closed: [
      closedChannel({
        id: "862500x1x0",
        capacity: 2_000_000,
        funding: { txid: chan.tx.txid, vout: 0 },
        closeTxid: commit.txid,
        type: "LOCAL_FORCE_CLOSE",
        weOpened: true,
        weClosed: true,
        sweeps: [
          { type: "OUTGOING_HTLC", vout: 2, amount: 95_000, txid: timeout.txid },
          { type: "OUTGOING_HTLC", vout: 0, amount: 93_000, txid: htlcSweep.txid },
        ],
      }),
    ],
  });
  const p = (await api.request("GET", "/pnl?days=36500")).body;
  // The timeout's 2,000 counts because LND names it; the final sweep can't be valued: said.
  assert.deepEqual([p.channelCloseCostSats, p.channelCloseUnknownCount], [5_000 + 2_000, 1]);
});

test("a closing transaction that can't be this channel's — paying out more than it held, or not spending its funding output — is a cost unknown, never 0 and never booked", () => {
  const f = rawTx({ inputs: [coin()], outputs: [{ value: 1_000_000 }] });
  const tooMuch = rawTx({ inputs: [{ txid: f.txid, vout: 0 }], outputs: [{ value: 1_000_500 }] });
  const elsewhere = rawTx({ inputs: [coin()], outputs: [{ value: 990_000 }] });
  const facts = (id: string, closeTxid: string): ClosedChannelFacts => ({
    channelId: id,
    capacity: 1_000_000,
    fundingTxid: f.txid,
    fundingVout: 0,
    closeTxid,
    closeHeight: null,
    kind: "cooperative",
    weFunded: true,
    weClosed: true,
    sweepTxids: [],
  });
  const inWallet = (tx: ReturnType<typeof rawTx>): WalletTx => ({ id: tx.txid, createdAt: new Date(ago(1)).toISOString(), isConfirmed: true, isOutgoing: false, transaction: tx.hex, inputs: [] });
  const costs = closeCostsFrom([facts("863000x1x0", tooMuch.txid), facts("863001x1x0", elsewhere.txid)], [inWallet(tooMuch), inWallet(elsewhere)], { nowMs: now, height: null });
  assert.deepEqual(
    costs.map((c) => [c.fees, c.unknown]),
    [
      [[], "its closing transaction pays out more than the channel held"],
      [[], "its closing transaction doesn't spend the channel's funding output"],
    ],
  );
});

test("a channel still opening or already closing keeps its funding fee under opens — not an 'other on-chain fee' left out of net until LND lists it as closed", async (t) => {
  const opening = funded(2_000_000, 3_000, ago(0.1), 1); // 1 of 3 confirmations: the channel is still pending
  const waiting = funded(1_000_000, 2_000, ago(10));
  const forceClosing = funded(1_500_000, 2_500, ago(20));
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  node.pending.push(
    { partnerPublicKey: PEER, capacity: 2_000_000, transactionId: opening.tx.txid, transactionVout: 0 },
    { partnerPublicKey: PEER, capacity: 1_000_000, transactionId: waiting.tx.txid, transactionVout: 0, state: "waiting_close" },
    { partnerPublicKey: PEER, capacity: 1_500_000, transactionId: forceClosing.tx.txid, transactionVout: 0, state: "force_closing" },
  );
  const { api } = await pnlApi(t, { txs: [opening.wallet, waiting.wallet, forceClosing.wallet] }, { node });
  const p = (await api.request("GET", "/pnl?days=30")).body;
  // Before: 3,000 — the closing channels' fees fell into "other on-chain fees".
  assert.deepEqual([p.channelOpenCostSats, p.otherChainFeesSats, p.totalCostSats], [7_500, 0, 7_500]);
});

/** A local force close of a 3M channel this node funded: its commitment
 *  (9,340 fee, and two anchors nobody of ours swept: 660) and the to_local
 *  sweep after the timelock (1,000). */
function forceClose() {
  const chan = funded(3_000_000);
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 2_000_000 }, { value: 990_000 }, { value: 330 }, { value: 330 }] });
  const sweep = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 1_999_000 }] });
  const closed = closedChannel({
    id: "864000x1x0",
    capacity: 3_000_000,
    funding: { txid: chan.tx.txid, vout: 0 },
    closeTxid: commit.txid,
    type: "LOCAL_FORCE_CLOSE",
    weOpened: true,
    weClosed: true,
    sweeps: [{ type: "COMMIT", vout: 0, amount: 2_000_000, txid: sweep.txid }],
  });
  return { chan, commit, sweep, closed };
}

test("a force close's commitment, which LND's wallet drops at its next restart, is kept by LightningMate while the channel closes: once it is closed, its fee and its sweep's still count (without the copy: cost unknown)", async (t) => {
  const { chan, commit, sweep, closed } = forceClose();
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  // Force closing: the commitment confirmed, its to_local in the timelock.
  node.pending.push({ partnerPublicKey: PEER, capacity: 3_000_000, transactionId: chan.tx.txid, transactionVout: 0, state: "force_closing", closingTxid: commit.txid });
  node.override("default.feeReport", (_a, cb) => cb(null, { channel_fees: [] }));
  const { api, state } = await pnlApi(t, { txs: [chan.wallet, ourCommitment(commit, ago(20))] }, { node, dir });
  // Any read of the books copies it — the health score's too.
  assert.equal((await api.request("GET", "/score")).status, 200);
  // LND restarts: btcwallet broadcasts the commitment again, hears it is
  // mined, and removes it. Later the to_local is swept and the channel listed
  // as closed.
  node.pending.length = 0;
  state.txs.splice(0, state.txs.length, chan.wallet, walletTx(sweep, { amount: 1_999_000, at: ago(18) }));
  state.closed.push(closed);
  const p = (await api.request("GET", "/pnl?days=36500")).body;
  assert.deepEqual([p.channelCloseCostSats, p.channelCloseCount, p.channelCloseUnknownCount], [9_340 + 660 + 1_000, 1, 0]);
  // The copy is on disk: a restarted LightningMate reads it.
  const kept = JSON.parse(readFileSync(join(dir, "close-txs.json"), "utf8")) as WalletTx[];
  assert.ok(kept.some((r) => r.id === commit.txid && r.transaction === commit.hex), "the commitment, raw, on disk");
  const again = await startApi(t, { node, dir });
  assert.equal((await again.request("GET", "/pnl?days=36500")).body.channelCloseCostSats, 11_000);
  // A node whose books were never read in between has no copy: said, not 0.
  const fresh = await pnlApi(t, { txs: [chan.wallet, walletTx(sweep, { amount: 1_999_000, at: ago(18) })], closed: [closed] });
  const unknown = (await fresh.api.request("GET", "/pnl?days=36500")).body;
  assert.deepEqual([unknown.channelCloseCostSats, unknown.channelCloseUnknownCount], [0, 1]);
});

test("the copy stands in only for what the wallet no longer lists — never twice, and the wallet's newer record replaces it", (t) => {
  const { chan, commit } = forceClose();
  const dir = makeTempDir(t);
  const archive = new CloseTxArchive(dir);
  const [fundingTx, commitTx] = walletTxsOfRaw([chan.wallet, ourCommitment(commit, ago(20))]);
  assert.deepEqual(archive.update([fundingTx, commitTx], [commit.txid]).map((t) => t.id), [fundingTx.id, commitTx.id], "the wallet lists both: nothing added");
  assert.equal(archive.size, 1, "only the close's own transaction is kept — not the funding");
  assert.deepEqual(archive.update([fundingTx], [commit.txid]).map((t) => t.id), [fundingTx.id, commitTx.id], "the wallet forgot it: the copy stands in");
  const seenMined = { ...commitTx, isConfirmed: true };
  archive.update([fundingTx, seenMined], [commit.txid]);
  assert.equal(new CloseTxArchive(dir).update([fundingTx], [commit.txid]).find((t) => t.id === commit.txid)?.isConfirmed, true, "refreshed on disk");
});

test("with nobody reading the books, a started autopilot copies a closing channel's commitment by itself — a minute after the start and every hour after", async (t) => {
  quiet(t);
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const { chan, commit } = forceClose();
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  node.pending.push({ partnerPublicKey: PEER, capacity: 3_000_000, transactionId: chan.tx.txid, transactionVout: 0, state: "waiting_close", closingTxid: commit.txid });
  const state = installChain(node, { txs: [chan.wallet, ourCommitment(commit, ago(0.1))] });
  // Read-only: no main runs, no order lane — the read-only timers only.
  const autopilot = new Autopilot(dir, node.lnd, undefined, new RebalanceLog(dir), new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  t.after(() => autopilot.shutdown());
  autopilot.start();
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };
  const kept = () => new CloseTxArchive(dir).update([], []).map((r) => r.id);
  await settle();
  assert.deepEqual(kept(), [], "nothing before the first look");
  t.mock.timers.tick(60_000);
  await settle();
  assert.deepEqual(kept(), [commit.txid]);
  // Another channel starts closing; the next hourly look copies its commitment.
  const other = funded(1_000_000);
  const otherCommit = rawTx({ inputs: [{ txid: other.tx.txid, vout: 0 }], outputs: [{ value: 600_000 }, { value: 395_000 }] });
  node.pending.push({ partnerPublicKey: PEER, capacity: 1_000_000, transactionId: other.tx.txid, transactionVout: 0, state: "waiting_close", closingTxid: otherCommit.txid });
  state.txs.push(other.wallet, ourCommitment(otherCommit, ago(0.01)));
  t.mock.timers.tick(60 * 60_000);
  await settle();
  assert.deepEqual(kept().sort(), [commit.txid, otherCommit.txid].sort());
});

/** Wallet records as P&L reads them, from raw GetTransactions entries. */
function walletTxsOfRaw(list: ReturnType<typeof walletTx>[]): WalletTx[] {
  return list.map((w) => ({
    id: w.tx_hash,
    createdAt: new Date(Number(w.time_stamp) * 1000).toISOString(),
    isConfirmed: w.num_confirmations > 0,
    isOutgoing: Number(w.amount) < 0,
    ...(Number(w.total_fees) ? { fee: Number(w.total_fees) } : {}),
    transaction: w.raw_tx_hex,
    inputs: w.previous_outpoints.map((o) => ({ txid: o.outpoint.split(":")[0], vout: Number(o.outpoint.split(":")[1]), isLocal: o.is_our_output })),
  }));
}

test("a damaged copy of the close transactions is reported, with what it means for P&L — never silently emptied", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "close-txs.json"), '[{"id": "ab');
  const api = await startApi(t, { dir });
  assert.equal(api.autopilot.closeTxs.size, 0);
  const alerts = (await api.request("GET", "/alerts")).body as { message: string }[];
  assert.ok(
    alerts.some((a) => /close-txs\.json was damaged .* a close whose transactions LND's wallet has since forgotten shows its cost as unknown in P&L/.test(a.message)),
    JSON.stringify(alerts),
  );
});

test("the copy stays bounded — past 20,000 transactions the oldest go first", (t) => {
  const dir = makeTempDir(t);
  const archive = new CloseTxArchive(dir);
  const records: WalletTx[] = Array.from({ length: 20_003 }, (_, i) => ({
    id: i.toString(16).padStart(64, "0"),
    createdAt: new Date(ago(30) + i * 60_000).toISOString(),
    isConfirmed: true,
    isOutgoing: false,
    transaction: "00", // what it holds doesn't matter here
    inputs: [],
  }));
  archive.update(records, records.map((r) => r.id));
  const kept = new CloseTxArchive(dir).update([], []).map((r) => r.id);
  assert.equal(kept.length, 20_000);
  assert.ok(!kept.includes(records[0].id) && !kept.includes(records[2].id), "the three oldest went");
  assert.ok(kept.includes(records[3].id) && kept.includes(records[20_002].id));
});

// ── Review 2 of P6: anchors, a copy whose save failed, records that can't be right ──

/** A 1M anchor channel closed by force: its commitment pays to_local 600,000,
 *  to_remote 395,000 and two 330-sat anchors — a 4,340 sat fee. */
function anchorClose(o: { weFunded: boolean; kind?: "local_force" | "remote_force" }) {
  const fund = rawTx({ inputs: [coin()], outputs: [{ value: 1_000_000 }] });
  const commit = rawTx({ inputs: [{ txid: fund.txid, vout: 0 }], outputs: [{ value: 600_000 }, { value: 395_000 }, { value: 330 }, { value: 330 }] });
  const kind = o.kind ?? "local_force";
  const facts: ClosedChannelFacts = {
    channelId: "865000x1x0",
    capacity: 1_000_000,
    fundingTxid: fund.txid,
    fundingVout: 0,
    closeTxid: commit.txid,
    closeHeight: null,
    kind,
    weFunded: o.weFunded,
    weClosed: kind === "local_force",
    sweepTxids: [],
  };
  // Our anchor bumped with a wallet coin of 50,000 → 46,330 back: 4,000 sat
  // fee. The coin is output 3 of its transaction — the index of the peer's
  // anchor in the commitment, which this CPFP doesn't spend.
  const walletCoin = rawTx({ inputs: [coin()], outputs: [{ value: 7_000 }, { value: 8_000 }, { value: 9_000 }, { value: 50_000 }] });
  const cpfp = rawTx({ inputs: [{ txid: commit.txid, vout: 2 }, { txid: walletCoin.txid, vout: 3 }], outputs: [{ value: 46_330 }] });
  const held = (tx: ReturnType<typeof rawTx>, w: Partial<WalletTx> = {}): WalletTx => ({
    id: tx.txid,
    createdAt: new Date(ago(20)).toISOString(),
    isConfirmed: false,
    isOutgoing: false,
    transaction: tx.hex,
    inputs: [],
    ...w,
  });
  const cpfpInputs = [
    { txid: commit.txid, vout: 2, isLocal: false },
    { txid: walletCoin.txid, vout: 3, isLocal: true },
  ];
  return {
    facts,
    commitment: held(commit),
    coin: held(walletCoin, { isConfirmed: true }),
    cpfp: (confirmed = true) => held(cpfp, { isConfirmed: confirmed, isOutgoing: true, inputs: cpfpInputs }),
  };
}
const feesOf = (c: { fees: { what: string; sats: number }[] }) => c.fees.map((f) => [f.what, f.sats]);

test("a force close of an anchor channel this node funded: both anchors are its loss when nothing of ours swept them — the commitment's fee plus 660 (before: 4,340, while the funder lost 5,000)", () => {
  for (const kind of ["local_force", "remote_force"] as const) {
    const a = anchorClose({ weFunded: true, kind });
    const [cost] = closeCostsFrom([a.facts], [a.commitment], { nowMs: now, height: null });
    assert.deepEqual([feesOf(cost), cost.unknown], [[["close", 4_340 + 660]], null], kind);
  }
});

test("our anchor bumped (CPFP): the peer's anchor is still the funder's loss, ours is in the CPFP's fee — counted once; a CPFP that never confirmed counts nothing and leaves the anchor lost", () => {
  const a = anchorClose({ weFunded: true });
  const [cost] = closeCostsFrom([a.facts], [a.coin, a.commitment, a.cpfp()], { nowMs: now, height: null });
  assert.deepEqual(feesOf(cost), [
    ["close", 4_340 + 330],
    ["sweep", 4_000],
  ]);
  // All the funder lost: the commitment's fee, both anchors, and 3,670 of the wallet's (50,000 → 46,330).
  assert.equal(cost.fees.reduce((s, f) => s + f.sats, 0), 4_340 + 660 + 3_670);
  const [replaced] = closeCostsFrom([a.facts], [a.coin, a.commitment, a.cpfp(false)], { nowMs: now, height: null });
  assert.deepEqual(feesOf(replaced), [["close", 4_340 + 660]]);
});

test("the peer funded the anchor channel: the anchor our CPFP spent was its 330 sat — our cost is what the wallet put in, not the CPFP's whole fee", () => {
  const a = anchorClose({ weFunded: false });
  const [cost] = closeCostsFrom([a.facts], [a.coin, a.commitment, a.cpfp()], { nowMs: now, height: null });
  // The commitment's fee and both anchors were the funder's; of the CPFP's
  // 4,000, 330 was its anchor: 50,000 − 46,330 left our wallet.
  assert.deepEqual([feesOf(cost), cost.unknown], [[["sweep", 3_670]], null]);
});

test("a cooperative close has no anchors: a 330-sat output in it is no anchor of the funder's", () => {
  const fund = rawTx({ inputs: [coin()], outputs: [{ value: 1_000_000 }] });
  const close = rawTx({ inputs: [{ txid: fund.txid, vout: 0 }], outputs: [{ value: 998_670 }, { value: 330 }] }); // 1,000 fee
  const [cost] = closeCostsFrom(
    [{ channelId: "866000x1x0", capacity: 1_000_000, fundingTxid: fund.txid, fundingVout: 0, closeTxid: close.txid, closeHeight: null, kind: "cooperative", weFunded: true, weClosed: true, sweepTxids: [] }],
    [{ id: close.txid, createdAt: new Date(ago(1)).toISOString(), isConfirmed: true, isOutgoing: false, transaction: close.hex, inputs: [] }],
    { nowMs: now, height: null },
  );
  assert.deepEqual(feesOf(cost), [["close", 1_000]]);
});

test("a sweep the wallet's records value below what it pays out can't be right: its cost is unknown — never a negative fee taken off the close", () => {
  const chan = funded(1_000_000);
  const commit = rawTx({ inputs: [{ txid: chan.tx.txid, vout: 0 }], outputs: [{ value: 600_000 }, { value: 395_000 }] }); // 5,000 fee
  // Pays out 1,000 more than the output it spends holds (a record that isn't this sweep's parent's).
  const sweep = rawTx({ inputs: [{ txid: commit.txid, vout: 0 }], outputs: [{ value: 601_000 }] });
  const [cost] = closeCostsFrom(
    [{ channelId: "867000x1x0", capacity: 1_000_000, fundingTxid: chan.tx.txid, fundingVout: 0, closeTxid: commit.txid, closeHeight: null, kind: "local_force", weFunded: true, weClosed: true, sweepTxids: [] }],
    [
      { id: commit.txid, createdAt: new Date(ago(20)).toISOString(), isConfirmed: false, isOutgoing: false, transaction: commit.hex, inputs: [] },
      { id: sweep.txid, createdAt: new Date(ago(18)).toISOString(), isConfirmed: true, isOutgoing: false, transaction: sweep.hex, inputs: [] },
    ],
    { nowMs: now, height: null },
  );
  assert.deepEqual(feesOf(cost), [["close", 5_000]]);
  assert.match(cost.unknown ?? "", /a sweep of it/);
});

test("a copy whose save failed is saved by the next look, the same wallet or not — and the alert clears with it (before: never again until something changed, and a restart lost it)", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { chan, commit } = forceClose();
  const dir = makeTempDir(t);
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  node.pending.push({ partnerPublicKey: PEER, capacity: 3_000_000, transactionId: chan.tx.txid, transactionVout: 0, state: "force_closing", closingTxid: commit.txid });
  installChain(node, { txs: [chan.wallet, ourCommitment(commit, ago(1))] });
  const archive = new CloseTxArchive(dir);
  // The disk is full during the first look.
  const proto = JsonStore.prototype as unknown as { replaceFile: (this: { name: string }, ...args: unknown[]) => void };
  const real = proto.replaceFile;
  const full = t.mock.method(proto, "replaceFile", function (this: { name: string }, ...args: unknown[]) {
    if (this.name === "close-txs.json") throw new Error("ENOSPC: no space left on device");
    return real.apply(this, args);
  });
  await archive.look(node.lnd);
  const failing = () => storeIncidents(dir).some((i) => i.file === "close-txs.json" && i.kind === "write_failed");
  assert.equal(archive.size, 1, "kept in memory");
  assert.ok(failing(), "the failed save is alerted");
  full.mock.restore();
  // The hourly look finds the very same wallet.
  await archive.look(node.lnd);
  assert.equal(new CloseTxArchive(dir).size, 1, "on disk now: a restart keeps it");
  assert.ok(!failing(), "the alert clears with the save");
});

test("a record in the copy that isn't a whole transaction record is left out on load — P&L reads the rest", async (t) => {
  const { chan, commit, sweep, closed } = forceClose();
  const dir = makeTempDir(t);
  const good: WalletTx = { id: commit.txid, createdAt: new Date(ago(20)).toISOString(), isConfirmed: false, isOutgoing: false, transaction: commit.hex, inputs: [] };
  writeFileSync(
    join(dir, "close-txs.json"),
    JSON.stringify([good, { id: "ab".repeat(32), createdAt: good.createdAt, isConfirmed: true }, { ...good, id: "cd".repeat(32), inputs: "none" }, { ...good, id: "not a txid" }]),
  );
  assert.equal(new CloseTxArchive(dir).size, 1);
  const { api } = await pnlApi(t, { txs: [chan.wallet, walletTx(sweep, { amount: 1_999_000, at: ago(18) })], closed: [closed] }, { dir });
  const p = await api.request("GET", "/pnl?days=36500");
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.channelCloseCostSats, p.body.channelCloseUnknownCount], [9_340 + 660 + 1_000, 0]);
});
