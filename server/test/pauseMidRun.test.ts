/**
 * "Pause all automation" — or one switch turned off — while a run is under
 * way (review of P7, round 1).
 *
 * Before, every stage read its switch only when it began: its loops checked
 * nothing but the shutdown signal, and the Magma lane worked from the
 * settings it read when its pass began. A pause clicked mid-run still paid
 * the next planned refill, opened a channel to the next peer, sent the fee
 * writes already planned — and the offer upkeep could still create, enable
 * or top up an offer, the lane accept a new order: an offer listed with
 * nobody fulfilling it, the trap the pause exists to avoid. Now each step
 * asks the live switch right before it starts; the one already under way
 * finishes, nothing starts after it.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { SELLING_OFF_SKIP } from "../src/services/magmaDesk.js";
import { executeRebalance } from "../src/services/rebalance.js";
import { runMaxHtlcPass } from "../src/services/maxHtlc.js";
import type { RebalanceRecommendation } from "../src/services/rebalanceRecommend.js";
import { BUYER, autopilotWith, paidRebalance, plannedFeeChange, plannedRebalance, sellerSetup, suggestion } from "./helpers/autopilot.js";
import { feeNode, type FeeChannel } from "./helpers/feeNode.js";
import type { FakeMarket } from "./helpers/market.js";
import { SALE_DEFAULTS } from "./helpers/magma.js";
import { entryOnDisk, quiet } from "./helpers/lifecycle.js";
import { until } from "./helpers/wait.js";
import type { AfterHook } from "./helpers/tmp.js";
import type { FeeRecommendation } from "../src/services/feeRecommend.js";

const PK = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const pubkeyOf = (args: Record<string, unknown>) => Buffer.from(args.node_pubkey as Buffer).toString("hex");
const PAUSED = "all automation was paused during the run";

// ── rebalancing ──────────────────────────────────────────────────────────────

test("a pause during a refill: the next planned refill is not paid — and the decision says why it was skipped", async (t) => {
  quiet(t);
  for (const stop of ["pause", "switch"] as const) {
    const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, maxRebalancesPerRun: 2, rebalanceDailyBudgetSats: 10_000 });
    seams.rebalanceReport = async () => ({ recommendations: [plannedRebalance("800001x1x0", 500), plannedRebalance("800002x1x0", 400)] });
    const paid: string[] = [];
    seams.rebalanceExec = async (_w, p) => {
      paid.push(p.targetId);
      // The operator clicks "Pause all automation" (or turns auto-rebalance off) now.
      if (paid.length === 1) {
        if (stop === "pause") autopilot.pauseAll();
        else autopilot.setConfig({ rebalanceEnabled: false });
      }
      return paidRebalance(p);
    };
    const run = await autopilot.runOnce();
    // Before: ["800001x1x0", "800002x1x0"] — the stage checked only shuttingDown.
    assert.deepEqual(paid, ["800001x1x0"], `${stop}: no refill starts after it`);
    assert.deepEqual(run.rebalances.map((r) => r.ok), [true], "the one under way finished and is on record");
    const d = autopilot.getState().decisions.rebalance;
    const why = stop === "pause" ? PAUSED : "auto-rebalance was switched off during the run";
    assert.equal(d?.text, `1 of 1 refill paid · peer-800002x1x0: skipped, ${why}`);
    assert.equal(autopilot.getState().status.rebalance.state, "off");
  }
});

/** A drained 5M target at 400 ppm and two full 5M sources on a fake LND. */
function refillNode(t: AfterHook) {
  const ch = (id: string, n: number, o: Partial<FeeChannel> = {}): FeeChannel => ({
    id, partnerPublicKey: PK(n), capacity: 5_000_000, localBalance: 4_000_000, transactionId: TX(n), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0, ...o,
  });
  const node = feeNode({ channels: [ch("850000x1x0", 1, { localBalance: 750_000, feeRatePpm: 400 }), ch("850000x3x0", 3), ch("850000x5x0", 5)] });
  t.after(() => {
    for (const p of node.payments.values()) if (p.status === "IN_FLIGHT") node.resolvePayment(p.id, "fail");
  });
  return node;
}

test("a pause inside a refill: the attempt under way is awaited, and no smaller size or other source is sent after it", async (t) => {
  quiet(t);
  const node = refillNode(t);
  node.payOutcome = "hang"; // the first attempt's HTLC is out
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 1_000 }, {}, {}, node);
  seams.rebalanceReport = async () => ({
    recommendations: [
      {
        channelId: "850000x1x0", alias: "router", state: "route_found_profitable", wouldRebalance: true, recommendedAmount: 400_000,
        selectedSourceChannel: "850000x3x0",
        sourceCandidates: ["850000x3x0", "850000x5x0"].map((id) => ({ channelId: id, alias: id, localRatio: 0.8, spareSats: 1_250_000, keepRatio: 0.55, reason: "" })),
        estimatedRouteFeeSats: 20, expectedNetProfitSats: 300, maxCostPpm: 320, maxCostSatsByPayback: 1_000, expectedRevenuePpm: 400,
        earningDemandSats: 1_200_000, minNetProfitSats: 100,
      } as unknown as RebalanceRecommendation,
    ],
  });
  const run = autopilot.runOnce();
  await until(() => [...node.payments.values()].some((p) => p.status === "IN_FLIGHT"), "the first attempt is in flight");
  const [first] = [...node.payments.values()];
  autopilot.pauseAll(); // while it is out
  node.payOutcome = "fail";
  node.resolvePayment(first.id, "fail"); // … and it fails after the pause
  const done = await run;
  // Before: the fallback chain went on — source B's 400k was sent.
  assert.equal(node.callsTo("router.sendPaymentV2").length, 1, "only the attempt under way");
  assert.deepEqual([done.rebalances.length, done.failed], [0, 0], "a deliberate skip (D15), not a failed refill");
  assert.match(autopilot.getState().decisions.rebalance?.text ?? "", new RegExp(`router: skipped, ${PAUSED} \\(after a source found no route\\)$`));
  assert.equal(autopilot.getState().decisions.rebalance?.state, "waiting");
});

test("the refill executor says why it stopped: the reason it is given, or a shutdown", async () => {
  const node = refillNode({ after: () => undefined });
  const params = { targetId: "850000x1x0", sourceId: "850000x3x0", amountSats: 400_000, econRatio: 0.8, maxFeePpm: 320 };
  const stopped = await executeRebalance(node.lnd, node.lnd, params, { shouldStop: () => "auto-rebalance was switched off during the run" });
  assert.deepEqual([stopped.ok, stopped.stopped], [false, true]);
  assert.equal(stopped.error, "skipped: auto-rebalance was switched off during the run — no further attempt was sent");
  assert.equal((await executeRebalance(node.lnd, node.lnd, params, { shouldStop: () => true })).error, "skipped: shutting down — no further attempt was sent");
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0);
});

// ── channel opens ────────────────────────────────────────────────────────────

function openSetup(t: TestContext) {
  t.mock.method(console, "warn", () => undefined);
  const env = autopilotWith(t, { channelEnabled: true, channelCooldownMinutes: 360 });
  env.seams.openFeeRate = async () => 2;
  env.node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  const A = { ...suggestion, pubkey: PK(1), alias: "picky" };
  const B = { ...suggestion, pubkey: PK(2), alias: "easy" };
  env.seams.channelSuggestions = async () => ({ suggestions: [A, B] });
  const opened = () => env.node.callsTo("default.openChannel").map((a) => pubkeyOf(a as Record<string, unknown>));
  return { ...env, A, B, opened };
}

test("a pause while an open to the first peer is under way: the next peer is not opened to", async (t) => {
  quiet(t);
  const { autopilot, node, A, opened } = openSetup(t);
  node.beforeCall = (method, args) => {
    if (method !== "default.openChannel") return;
    if (pubkeyOf(args as Record<string, unknown>) === A.pubkey) {
      autopilot.pauseAll(); // the operator clicks "Pause all automation" now
      node.openFailure = `received funding error from ${A.pubkey}: chan size of 0.02 BTC is below min chan size of 0.05 BTC`;
    } else node.openFailure = null;
  };
  await autopilot.runOnce();
  // Before: [picky, easy] — the walk down the suggestions checked only shuttingDown.
  assert.deepEqual(opened(), [A.pubkey], "no open starts after the pause");
  const dialed = node.callsTo("default.connectPeer").map((a) => (a as { addr: { pubkey: string } }).addr.pubkey);
  assert.deepEqual(dialed, [A.pubkey], "the next peer is not even dialed (a dial over Tor takes up to a minute and a half)");
  const d = autopilot.getState().decisions.channels;
  assert.equal(d?.state, "waiting");
  assert.match(d?.text ?? "", new RegExp(`^picky refused the size — it is tried again next run.* · stopped: ${PAUSED} — no open was started$`));
});

test("a pause while the peer is being dialed (before the on-chain mutex): nothing is broadcast", async (t) => {
  quiet(t);
  const { autopilot, node, opened } = openSetup(t);
  let readsInMutex = 0;
  node.beforeCall = (method) => {
    if (method === "default.connectPeer") autopilot.setConfig({ channelEnabled: false });
    if (method === "default.walletBalance" && autopilot.capital.mutex.heldBy === "autopilot open") readsInMutex += 1;
  };
  await autopilot.runOnce();
  assert.equal(node.callsTo("default.connectPeer").length, 1, "the dial was under way");
  assert.deepEqual(opened(), [], "the check inside the mutex: no funding broadcast after the switch went off");
  assert.equal(readsInMutex, 0, "asked first thing inside the mutex: not even the capital check is made");
  assert.equal(autopilot.getState().decisions.channels?.text, "stopped: the channel autopilot was switched off during the run — no open was started");
});

test("a pause while the channel stage reads its suggestions: it stops there and says so — not 'no peer to suggest'", async (t) => {
  quiet(t);
  const { autopilot, seams } = openSetup(t);
  seams.channelSuggestions = async () => {
    autopilot.pauseAll();
    return { suggestions: [] };
  };
  await autopilot.runOnce();
  assert.deepEqual(
    [autopilot.getState().decisions.channels?.state, autopilot.getState().decisions.channels?.text],
    ["waiting", `stopped: ${PAUSED} — no open was started`],
  );
});

test("a pause while the open re-reads the wallet inside the on-chain mutex: nothing is broadcast", async (t) => {
  quiet(t);
  const { autopilot, node, opened } = openSetup(t);
  node.beforeCall = (method) => {
    // The authoritative capital check, right before the funding broadcast.
    if (method === "default.walletBalance" && autopilot.capital.mutex.heldBy === "autopilot open") autopilot.pauseAll();
  };
  await autopilot.runOnce();
  assert.deepEqual(opened(), []);
  assert.equal(autopilot.getState().decisions.channels?.text, `stopped: ${PAUSED} — no open was started`);
});

// ── fees ─────────────────────────────────────────────────────────────────────

test("a pause while the fee plan is worked out: no fee is written — the planned updates are said, not sent", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  seams.feeReport = async () => {
    autopilot.pauseAll(); // while the report is read
    return { recommendations: [plannedFeeChange("800001x1x0", 300, 280)] };
  };
  let written = 0;
  seams.feeApply = async (_w, items) => {
    written += items.length;
    return items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm }));
  };
  const run = await autopilot.runOnce();
  // Before: 1 — the planned write went out after the pause.
  assert.equal(written, 0);
  assert.deepEqual(run.changes, []);
  assert.deepEqual(autopilot.getState().decisions.fees, {
    ...autopilot.getState().decisions.fees,
    state: "waiting",
    text: `${PAUSED} — 1 planned fee update was not sent`,
  });
});

test("a pause between fee writes of one batch: the write under way lands, the rest are not sent — and nothing is booked for them", async (t) => {
  quiet(t);
  const ch = (n: number): FeeChannel => ({
    id: `850000x${n}x0`, partnerPublicKey: PK(n), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(n), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0,
  });
  const node = feeNode({ channels: [ch(1), ch(2), ch(3)] });
  const { autopilot, seams } = autopilotWith(t, { enabled: true }, {}, {}, node);
  const rec = (n: number) => ({ ...plannedFeeChange(`850000x${n}x0`, 300, 280), transactionId: TX(n) }) as unknown as FeeRecommendation;
  seams.feeReport = async () => ({ recommendations: [rec(1), rec(2), rec(3)] });
  node.beforeCall = (method) => {
    if (method === "default.updateChannelPolicy" && node.policyRequests.length === 0) autopilot.setConfig({ enabled: false });
  };
  const run = await autopilot.runOnce();
  // Before: all three — applyFees wrote the whole batch.
  assert.deepEqual(node.policyWrites.map((w) => w.outpoint), [`${TX(1)}:0`]);
  assert.equal(node.callsTo("default.getChanInfo").length, 1, "nor is the next channel's policy even read");
  assert.deepEqual(run.changes.map((c) => [c.id, c.ok]), [["850000x1x0", true]]);
  assert.equal(autopilot.feeChanges().length, 1, "only the write that landed is in the fee-change log");
  assert.equal(autopilot.feeCooldown().lastApplied["850000x2x0"], undefined, "no cooldown for a fee never written");
  assert.deepEqual(autopilot.feeCooldown().retryAfter, {}, "and no retry back-off");
  const d = autopilot.getState().decisions.fees;
  assert.equal(d?.state, "acted");
  assert.equal(d?.text, "1 fee update applied: peer-850000x1x0 300→280 ppm · fee automation was switched off during the run — 2 planned fee updates were not sent");
});

test("a pause while the first fee write's policy is read: that write is not sent either", async (t) => {
  quiet(t);
  const ch = (n: number): FeeChannel => ({
    id: `850000x${n}x0`, partnerPublicKey: PK(n), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(n), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0,
  });
  const node = feeNode({ channels: [ch(1), ch(2)] });
  const { autopilot, seams } = autopilotWith(t, { enabled: true }, {}, {}, node);
  seams.feeReport = async () => ({
    recommendations: [1, 2].map((n) => ({ ...plannedFeeChange(`850000x${n}x0`, 300, 280), transactionId: TX(n) }) as unknown as FeeRecommendation),
  });
  // The write reads the channel's current policy from the graph first (to
  // keep its CLTV and HTLC limits): the pause lands during that read.
  node.beforeCall = (method) => {
    if (method === "default.getChanInfo") autopilot.pauseAll();
  };
  await autopilot.runOnce();
  assert.deepEqual(node.policyWrites, [], "asked again right before the write");
  assert.equal(autopilot.getState().decisions.fees?.text, `${PAUSED} — 2 planned fee updates were not sent`);
});

// ── max_htlc ─────────────────────────────────────────────────────────────────

test("the max_htlc pass stops before its next update once told to — nothing more is gossiped", async () => {
  const ch = (n: number): FeeChannel => ({
    id: `850000x${n}x0`, partnerPublicKey: PK(n), capacity: 2_000_000, localBalance: 1_500_000, transactionId: TX(n), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0,
  });
  const node = feeNode({ channels: [ch(1), ch(2)] });
  let asked = 0;
  const moved = await runMaxHtlcPass(node.lnd, node.lnd, new Map(), { shouldStop: () => ++asked > 1 });
  assert.equal(moved.length, 1, "the first update went out; the second was not sent");
  assert.equal(node.policyRequests.length, 1);
});

test("a pause during the max_htlc pass: the autopilot's pass sends no further update, and says so", async (t) => {
  quiet(t);
  const ch = (n: number): FeeChannel => ({
    id: `850000x${n}x0`, partnerPublicKey: PK(n), capacity: 2_000_000, localBalance: 1_500_000, transactionId: TX(n), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0,
  });
  const node = feeNode({ channels: [ch(1), ch(2)] });
  const { autopilot } = autopilotWith(t, { maxHtlcEnabled: true }, {}, {}, node);
  node.beforeCall = (method) => {
    if (method === "default.updateChannelPolicy") autopilot.pauseAll();
  };
  const run = await autopilot.runOnce();
  assert.equal(node.policyRequests.length, 1, "before: both channels' updates went out");
  assert.equal(run.maxHtlc?.length, 1);
  assert.equal(autopilot.getState().decisions.maxHtlc?.text, `1 channel's advertised size moved · ${PAUSED} — no further update was sent`);
});

// ── Magma ────────────────────────────────────────────────────────────────────

function fillMarket(market: FakeMarket, fills: (score: number) => number): void {
  for (let i = 0; i < 8; i++) market.addOffer({ totalSats: 20_000_000, sellerScore: i * 5, filledOrders: fills(i * 5), monthsListed: 6 });
  for (let i = 0; i < 6; i++) market.addOffer({ totalSats: 1_000_000, sellerScore: 1, filledOrders: 0 });
}

test("Magma: a pause while the selling check is read — no offer is created", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { sellAutoReprice: true } });
  fillMarket(s.market, () => 30);
  // The selling check (Amboss's public book) is the last read before the
  // create: the operator pauses while it is under way.
  const real = s.autopilot.magmaEligibility.bind(s.autopilot);
  s.autopilot.magmaEligibility = async (force?: boolean) => {
    const e = await real(force);
    s.autopilot.pauseAll();
    return e;
  };
  await s.autopilot.runOnce();
  // Before: the offer was created — listed, with nobody fulfilling its orders.
  assert.equal(s.magma.calls.filter((c) => c.op === "CreateOffer").length, 0);
  assert.equal(s.magma.offers.size, 0);
  const d = s.autopilot.getState().decisions.magma;
  assert.deepEqual([d?.state, d?.text], ["waiting", `no offer listed: ${PAUSED}`]);
});

test("Magma: an offer the autopilot disabled for lack of capital is not listed again by a run that was paused before the flip", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 500_000 });
  const offer = s.magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await s.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "capital safety");
  s.node.chainBalance = 3_000_000; // capital is back: the next run would list it again
  let reads = 0;
  s.magma.onRead = (op) => {
    // The second read of the offer is the one right before the flip.
    if (op === "MyOffer" && ++reads === 2) s.autopilot.pauseAll();
  };
  const toggles = s.magma.count("ToggleOffer");
  await s.autopilot.runOnce();
  assert.equal(s.magma.count("ToggleOffer"), toggles, "before: enabled — listed with selling paused");
  assert.equal(offer.status, "DISABLED");
  assert.ok(s.autopilot.offerControls()[offer.id]?.autoDisabledAt, "still the autopilot's disable: listed again once selling is back on");
  assert.match(s.autopilot.offerSyncStatus().offers[0]?.differences.join(" ") ?? "", new RegExp(`left as it is: ${PAUSED}`));
});

test("Magma: a sold-out offer is not topped up by a run that was paused before the write", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellAutoRelist: true } });
  const offer = s.magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, lockedSats: 1_500_000 });
  let reads = 0;
  s.magma.onRead = (op) => {
    // The fresh read right before the terms write.
    if (op === "MyOffer" && ++reads === 2) s.autopilot.setConfig({ sellEnabled: false });
  };
  await s.autopilot.runOnce();
  // Before: UpdateOffer — the offer topped back up with selling switched off.
  assert.equal(s.magma.calls.filter((c) => c.op === "UpdateOffer").length, 0);
  assert.equal(offer.totalSats, 2_000_000);
  const d = s.autopilot.getState().decisions.magma;
  assert.equal(d?.state, "waiting");
  assert.match(d?.text ?? "", /Liquidity provision was switched off during the run — no further offer change was made/);
  assert.match(s.autopilot.offerSyncStatus().offers[0]?.differences.join(" ") ?? "", /not changed: Liquidity provision was switched off during the run/);
});

/** A sold channel whose lease is over (CHANNEL_MONITORING_FINISHED), with auto-close on. */
function finishedLease(t: TestContext) {
  const s = sellerSetup(t, { config: { sellAutoClose: true } });
  const txid = "cd".repeat(32);
  s.node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  s.magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  s.node.override("default.closeChannel", () => {
    const st = Object.assign(new EventEmitter(), { cancel: () => undefined });
    setImmediate(() => st.emit("data", { update: "close_pending", close_pending: { txid: randomBytes(32), output_index: 0 } }));
    return st;
  });
  return s;
}

test("Magma: a pause during the offer upkeep — a finished lease's channel is not closed by that run", async (t) => {
  quiet(t);
  const s = finishedLease(t);
  let finishedListings = 0;
  s.magma.salesList = (filter) => {
    if (filter.status?.includes("CHANNEL_MONITORING_FINISHED")) finishedListings += 1;
    return null;
  };
  s.magma.onRead = (op) => {
    if (op === "MyOfferIds") s.autopilot.pauseAll(); // while the offers are listed
  };
  await s.autopilot.runOnce();
  // Before: closed — selling's automation acting after the pause.
  assert.equal(s.node.callsTo("default.closeChannel").length, 0);
  assert.equal(finishedListings, 0, "the auto-close isn't even started");
  // Back on, the close goes ahead.
  s.magma.onRead = null;
  s.autopilot.setConfig({ sellEnabled: true });
  await s.autopilot.runOnce();
  assert.equal(s.node.callsTo("default.closeChannel").length, 1);
});

test("Magma: a pause while the finished leases are listed — no order of them is read, no channel closed", async (t) => {
  quiet(t);
  const s = finishedLease(t);
  s.magma.salesList = (filter) => {
    if (filter.status?.includes("CHANNEL_MONITORING_FINISHED")) s.autopilot.pauseAll();
    return null;
  };
  await s.autopilot.runOnce();
  assert.equal(s.magma.count("Sale"), 0, "asked before each order");
  assert.equal(s.node.callsTo("default.closeChannel").length, 0);
});

test("Magma: a pause while a finished lease's order is read — its channel is not closed", async (t) => {
  quiet(t);
  const s = finishedLease(t);
  s.magma.onRead = (op) => {
    if (op === "Sale") s.autopilot.pauseAll(); // inside the auto-close, right before the close
  };
  await s.autopilot.runOnce();
  assert.equal(s.magma.count("Sale") > 0, true, "the order was read");
  assert.equal(s.node.callsTo("default.closeChannel").length, 0);
});

test("Magma: with two offers, a pause during the first one's upkeep leaves the second as it is — not even read again for its write", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellAutoRelist: true } });
  const first = s.magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, lockedSats: 1_500_000 });
  const second = s.magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, lockedSats: 1_500_000 });
  const readsOf = new Map<string, number>();
  s.magma.onRead = (op, vars) => {
    if (op !== "MyOffer") return;
    const id = String((vars as { id?: string }).id);
    readsOf.set(id, (readsOf.get(id) ?? 0) + 1);
    // The first offer's fresh read before its write (its second read).
    if (id === first.id && readsOf.get(id) === 2) s.autopilot.pauseAll();
  };
  await s.autopilot.runOnce();
  assert.equal(s.magma.calls.filter((c) => c.op === "UpdateOffer").length, 0);
  assert.equal(readsOf.get(second.id), 1, "listed once — its upkeep never started");
  const entry = s.autopilot.offerSyncStatus().offers.find((e) => e.offerId === second.id);
  assert.deepEqual(entry?.differences, [`left as it is: ${PAUSED}`]);
});

test("the order lane: a pause while the buyer is dialed — the order is not accepted, nothing is promised, and it waits for a decision by hand", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  node.beforeCall = (method) => {
    if (method === "default.connectPeer") autopilot.pauseAll(); // a slow dial over Tor
  };
  const held: string[] = [];
  const run = autopilot.capital.mutex.run.bind(autopilot.capital.mutex);
  autopilot.capital.mutex.run = <T>(label: string, fn: () => Promise<T>) => {
    held.push(label);
    return run(label, fn);
  };
  await autopilot.pollSellOrders();
  // Before: accepted on the settings the pass began with.
  assert.equal(magma.count("AcceptOrder"), 0);
  assert.deepEqual(held, [], "nothing of the accept starts — not even the wait for the on-chain mutex");
  assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, "no hold invoice either");
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  const e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "seen");
  assert.equal(e?.decision?.reason, SELLING_OFF_SKIP);
  assert.equal(autopilot.capital.reservedSat(), 0, "no coins promised");
});

test("the order lane: a pause while its accept waits for the on-chain mutex — the accept asks again inside it", async (t) => {
  quiet(t);
  const { autopilot, magma, dir, capital } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  // An open holds the on-chain mutex (a funding broadcast takes a while).
  let release!: () => void;
  const held = capital.mutex.run("an open", () => new Promise<void>((r) => (release = r)));
  const pass = autopilot.pollSellOrders();
  await until(() => (capital.mutex as unknown as { depth: number }).depth === 2, "the accept waits for the mutex");
  autopilot.setConfig({ sellEnabled: false });
  release();
  await held;
  await pass;
  assert.equal(magma.count("AcceptOrder"), 0);
  assert.equal(entryOnDisk(dir, sale.id)?.decision?.reason, SELLING_OFF_SKIP);
  assert.equal(capital.reservedSat(), 0);
});

// ── round 2: nothing awaited between the last check and the step ─────────────
//
// Review of P7, round 2: two Magma steps still awaited a read AFTER their
// last look at the switch — the create read this node's key from LND, the
// lane's accept re-read the capital inside the on-chain mutex and then made
// the HODL invoice — so a pause that landed in that read still listed the
// offer, or accepted the order.

test("Magma: a pause while this node's key is read for the create — the last read before it — no offer is created", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 20_000_000, config: { sellAutoReprice: true } });
  fillMarket(s.market, () => 30);
  // After the selling check (Amboss's public book), the create reads only
  // this node's key from LND: the pause lands during that read.
  let armed = false;
  let pausedInKeyRead = false;
  const real = s.autopilot.magmaEligibility.bind(s.autopilot);
  s.autopilot.magmaEligibility = async (force?: boolean) => {
    const e = await real(force);
    armed = true;
    return e;
  };
  s.node.beforeCall = (method) => {
    if (armed && method === "default.getInfo") {
      armed = false;
      pausedInKeyRead = true;
      s.autopilot.pauseAll();
    }
  };
  await s.autopilot.runOnce();
  assert.ok(pausedInKeyRead, "the pause landed in the key read");
  // Before: created — the switch was asked before that read only.
  assert.equal(s.magma.calls.filter((c) => c.op === "CreateOffer").length, 0);
  assert.equal(s.magma.offers.size, 0);
  const d = s.autopilot.getState().decisions.magma;
  assert.deepEqual([d?.state, d?.text], ["waiting", `no offer listed: ${PAUSED}`]);
});

/** An approval deadline a minute away: inside the margin in which the lane
 *  turns down an order it couldn't decide on (D6) — so a reject would show. */
const closeToDeadline = () => new Date(Date.now() + 60_000).toISOString();

test("the order lane: a pause while the accept re-reads the capital inside the on-chain mutex — the order is neither accepted nor turned down, nothing is promised", async (t) => {
  quiet(t);
  for (const read of ["enough", "coins gone", "read fails"] as const) {
    const { autopilot, node, magma, dir, capital } = sellerSetup(t);
    const sale = magma.addSale({ buyerPubkey: BUYER, timeout: closeToDeadline() });
    node.beforeCall = (method) => {
      // The authoritative re-read — after the accept's first look at the
      // switch inside the mutex.
      if (method !== "default.walletBalance" || capital.mutex.heldBy !== "magma accept" || autopilot.getState().paused) return;
      autopilot.pauseAll();
      if (read === "coins gone") node.chainBalance = 0;
      if (read === "read fails") node.failNext("default.walletBalance", "transport is closing");
    };
    await autopilot.pollSellOrders();
    assert.ok(autopilot.getState().paused, `${read}: the pause landed in the re-read`);
    // Before: accepted ("enough"), or turned down ("coins gone"; "read
    // fails", with the deadline close) — the lane deciding after the pause.
    assert.equal(magma.count("AcceptOrder"), 0, read);
    assert.equal(magma.count("RejectOrder"), 0, read);
    assert.equal(node.callsTo("invoices.addHoldInvoice").length, 0, read);
    assert.equal(capital.reservedSat(), 0, `${read}: no coins promised`);
    const e = entryOnDisk(dir, sale.id);
    assert.deepEqual([e?.phase, e?.decision?.reason], ["seen", SELLING_OFF_SKIP], read);
    assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", `${read}: the operator's to decide`);
  }
});

test("the order lane: a pause while the HODL invoice is made — the accept is not sent: the invoice is released, the coins are free, and the order can still be accepted by hand", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital, desk } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  let reservedThen = -1;
  node.beforeCall = (method) => {
    if (method !== "invoices.addHoldInvoice" || autopilot.getState().paused) return;
    reservedThen = capital.reservedSat(); // the coins are promised by now
    autopilot.pauseAll();
  };
  await autopilot.pollSellOrders();
  assert.equal(reservedThen, SALE_DEFAULTS.sizeSats, "the pause landed after the reservation");
  // Before: AcceptOrder went out with the invoice — an order taken on after the pause.
  assert.equal(magma.count("AcceptOrder"), 0);
  assert.equal(capital.reservedSat(), 0, "the coins are free again");
  const [made] = node.callsTo("invoices.addHoldInvoice");
  const hash = Buffer.from(made.hash as Buffer).toString("hex");
  assert.equal(node.invoices.get(hash)?.state, "CANCELED", "the invoice is released");
  const e = entryOnDisk(dir, sale.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.decision?.reason], ["seen", null, SELLING_OFF_SKIP]);
  assert.equal(e?.acceptAttempts, 0, "never sent: no attempt counted against the order");
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  // Nothing was promised: the operator can still accept it — with a fresh invoice.
  node.beforeCall = null;
  const res = await desk.accept(sale.id);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(magma.count("AcceptOrder"), 1);
  const fresh = Buffer.from(node.callsTo("invoices.addHoldInvoice")[1].hash as Buffer).toString("hex");
  assert.notEqual(fresh, hash);
  assert.equal(magma.sales.get(sale.id)?.paymentRequest, node.invoices.get(fresh)?.request);
});

test("the order lane: a pause while the HODL invoice is made, and making it fails — the order is not turned down either", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir, capital } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, timeout: closeToDeadline() });
  node.beforeCall = (method) => {
    if (method !== "invoices.addHoldInvoice" || autopilot.getState().paused) return;
    autopilot.pauseAll();
    node.failNext("invoices.addHoldInvoice", "invoice registry is shutting down");
  };
  await autopilot.pollSellOrders();
  // Before: turned down as an order the lane "could not decide on in time".
  assert.equal(magma.count("RejectOrder"), 0);
  assert.equal(magma.count("AcceptOrder"), 0);
  assert.equal(capital.reservedSat(), 0);
  const e = entryOnDisk(dir, sale.id);
  assert.deepEqual([e?.phase, e?.decision?.reason], ["seen", SELLING_OFF_SKIP]);
});
