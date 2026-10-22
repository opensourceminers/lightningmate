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
import { crashAt, entryOnDisk, quiet } from "./helpers/lifecycle.js";
import { magmaRefusalAlerts } from "../src/services/alerts.js";
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

// ── review of P7 (final): a paused lane never turns an order down on its own ──
//
// acceptOrder neither accepts nor rejects once Liquidity provision is off —
// but decide() still sent RejectOrder after a pause: it awaits the first
// capital check and the buyer's dial (up to ~90 s over Tor), its capital
// catch went on to "could not decide on it in time" near the deadline, and
// advance() called it on the settings read before the order's Amboss read.
// D6's immediate reject is a RUNNING lane's; a paused one leaves the order
// to the operator (SELLING_OFF_SKIP), as the README and the strategy doc say.

/** The order is the operator's: not accepted, not refused, nothing promised. */
function leftToOperator(s: ReturnType<typeof sellerSetup>, id: string, what: string): void {
  assert.equal(s.magma.count("RejectOrder"), 0, `${what}: no reject after the pause`);
  assert.equal(s.magma.count("AcceptOrder"), 0, `${what}: no accept either`);
  assert.equal(s.capital.reservedSat(), 0, `${what}: no coins promised`);
  const e = entryOnDisk(s.dir, id);
  assert.deepEqual([e?.phase, e?.decision?.reason], ["seen", SELLING_OFF_SKIP], what);
  assert.equal(s.magma.sales.get(id)?.status, "WAITING_FOR_SELLER_APPROVAL", `${what}: still the operator's to decide`);
}

test("PROBE-DECIDE-DIAL: a pause while the buyer is dialed, and the dial fails — the order is not turned down as unreachable", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  s.node.beforeCall = (method) => {
    if (method === "default.connectPeer" && !s.autopilot.getState().paused) {
      s.autopilot.pauseAll(); // the operator pauses during a slow dial over Tor
      s.node.failNext("default.connectPeer", "unable to connect: dial timeout");
    }
  };
  await s.autopilot.pollSellOrders();
  // Before: RejectOrder 1, "the buyer's node is unreachable".
  leftToOperator(s, sale.id, "dial failed");
});

test("PROBE-DECIDE-CAPITAL: a pause during the first capital check (before the mutex) — coins gone, or the read failing with the deadline a minute away — no reject", async (t) => {
  quiet(t);
  for (const read of ["coins gone", "read fails"] as const) {
    const s = sellerSetup(t);
    const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: closeToDeadline() });
    s.node.beforeCall = (method) => {
      // decide()'s own capital check runs outside the on-chain mutex.
      if (method !== "default.walletBalance" || s.capital.mutex.heldBy !== null || s.autopilot.getState().paused) return;
      s.autopilot.pauseAll();
      if (read === "coins gone") s.node.chainBalance = 0;
      else s.node.failNext("default.walletBalance", "transport is closing");
    };
    await s.autopilot.pollSellOrders();
    assert.ok(s.autopilot.getState().paused, `${read}: the pause landed in the check`);
    // Before: "not enough on-chain capital …" — or, the read failing near the
    // deadline, "could not decide on it in time".
    leftToOperator(s, sale.id, read);
    assert.equal(s.autopilot.magma.laneStatus().error, null, `${read}: not reported as an order the lane couldn't decide`);
  }
});

test("a pause while the order is read from Amboss — the pass began with selling on — and the order can't be served: not refused either", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  // Not a bitcoin channel: refused at once by a running lane (D6).
  const sale = s.magma.addSale({ buyerPubkey: BUYER, assetType: "TAPROOT_ASSET" });
  s.magma.saleRead = () => {
    if (!s.autopilot.getState().paused) s.autopilot.pauseAll();
    return null; // answered as usual — after the pause
  };
  await s.autopilot.pollSellOrders();
  // Before: rejected on the settings read before this order's read.
  leftToOperator(s, sale.id, "paused during the read");
  // Running again: the lane's own reject, as D6 says.
  s.magma.saleRead = null;
  s.autopilot.resumeAll();
  s.autopilot.setConfig({ sellEnabled: true });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("RejectOrder"), 1);
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "rejected");
});

test("an accept Amboss refuses a third time while the lane was paused meanwhile — released, and left to the operator, not turned down", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  s.magma.behave.AcceptOrder = "false";
  await s.autopilot.pollSellOrders();
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("AcceptOrder"), 2);
  // The third accept goes out; the operator pauses while Amboss answers it.
  s.magma.onMutation = (op) => {
    if (op === "AcceptOrder") s.autopilot.pauseAll();
  };
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("AcceptOrder"), 3);
  // Before: "Amboss refused the accept 3 times" — rejected by the paused lane.
  assert.equal(s.magma.count("RejectOrder"), 0);
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.decision?.reason], ["seen", null, SELLING_OFF_SKIP]);
  assert.equal(s.capital.reservedSat(), 0, "no coins promised");
});

test("the operator rejects an order the paused lane left to them: their own decision — no 'turned down' alert, no refusal on the Overview", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  s.node.beforeCall = (method) => {
    if (method === "default.connectPeer" && !s.autopilot.getState().paused) s.autopilot.pauseAll();
  };
  await s.autopilot.pollSellOrders();
  assert.equal(entryOnDisk(s.dir, sale.id)?.decision?.reason, SELLING_OFF_SKIP);
  s.node.beforeCall = null;
  const res = await s.desk.reject(sale.id); // the click the skip asked for
  assert.equal(res.ok, true, res.message);
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.via, e?.reason], ["rejected", "manual", "rejected by you"]);
  // Before: "A 2,000,000 sat Magma order was turned down: rejected by you",
  // and "1 Magma order turned down" on the Overview.
  assert.deepEqual(magmaRefusalAlerts(s.autopilot.magma), []);
  assert.deepEqual(s.autopilot.magma.refusals(), [], "the dashboard's magmaRefusals counts these");
});

// After a crash between making the HODL invoice and sending the accept,
// resumeAccept sent the accept even with selling off by then: nothing
// recorded whether it had gone out. `acceptSentAt` is on disk before it goes
// out now: without it the accept never left, and a paused lane withdraws it.

test("restart after a crash before the accept went out, with selling paused since: the accept is withdrawn — invoice released, coins free, the attempt not counted", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  // The invoice is made in LND, then the process dies (nothing after it runs).
  const crashed = crashAt(s.autopilot.magma, "lndCreateHodl", "after");
  void s.autopilot.pollSellOrders();
  await until(crashed, "the invoice was made");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepting");
  assert.equal(entryOnDisk(s.dir, sale.id)?.acceptSentAt, undefined, "the accept never went out");
  const p2 = s.restart();
  p2.pauseAll(); // the operator paused (or switched selling off) meanwhile
  await p2.pollSellOrders();
  // Before: AcceptOrder sent by the restarted, paused lane.
  assert.equal(s.magma.count("AcceptOrder"), 0);
  assert.equal(s.magma.count("RejectOrder"), 0);
  const [made] = s.node.callsTo("invoices.addHoldInvoice");
  assert.equal(s.node.invoices.get(Buffer.from(made.hash as Buffer).toString("hex"))?.state, "CANCELED", "the invoice is released");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.decision?.reason, e?.acceptAttempts], ["seen", null, SELLING_OFF_SKIP, 0]);
  assert.equal(p2.capital.reservedSat(), 0, "the coins are free");
  // The operator can still take it: a fresh invoice, the accept sent.
  const res = await p2.magma.accept(sale.id);
  assert.equal(res.ok, true, res.message);
  assert.equal(s.magma.count("AcceptOrder"), 1);
});

test("restart after a crash once the accept was on its way out (its mark saved), with selling paused since: the step under way is completed", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  const crashed = crashAt(s.autopilot.magma, "ambossAccept", "before");
  void s.autopilot.pollSellOrders();
  await until(crashed, "the accept was about to go out");
  assert.ok(entryOnDisk(s.dir, sale.id)?.acceptSentAt, "marked on disk before it went out");
  const p2 = s.restart();
  p2.pauseAll();
  await p2.pollSellOrders();
  // It may have reached Amboss: completed, whatever the switch says now.
  assert.equal(s.magma.count("AcceptOrder"), 1);
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "accepted");
});

/** The disk fills up right after the order's HODL invoice is recorded:
 *  ensureInvoice's own commit goes through, the accept's mark (and, with
 *  `forGood`, every commit after it) can't be saved. */
function diskFullAfterInvoice(s: ReturnType<typeof sellerSetup>, forGood: boolean): { restore: () => void } {
  const desk = s.autopilot.magma as unknown as { lndCreateHodl: (p: unknown) => Promise<unknown> };
  const real = desk.lndCreateHodl.bind(s.autopilot.magma);
  const journal = s.autopilot.magma.journal as unknown as { commit: (e: unknown) => void };
  const commit = journal.commit.bind(s.autopilot.magma.journal);
  let commits = 0;
  desk.lndCreateHodl = async (p) => {
    const r = await real(p);
    journal.commit = (e) => {
      commits += 1;
      if (commits === 2 || (forGood && commits > 2)) throw new Error("ENOSPC: no space left on device");
      commit(e);
    };
    return r;
  };
  return { restore: () => (journal.commit = commit) };
}

test("an accept whose mark can't be saved is not sent — the journal's rule for every external step: its invoice is released, the order is to be decided again, and the next pass sends a fresh accept", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  const disk = diskFullAfterInvoice(s, false);
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("AcceptOrder"), 0, "not sent without its mark on disk");
  assert.equal(s.magma.count("RejectOrder"), 0, "the deadline is far: decided again on the next pass");
  // Before: left "accepting" with its invoice open in LND, retried every pass.
  const [made] = s.node.callsTo("invoices.addHoldInvoice");
  assert.equal(s.node.invoices.get(Buffer.from(made.hash as Buffer).toString("hex"))?.state, "CANCELED", "the invoice is released");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.acceptSentAt, e?.acceptAttempts], ["seen", null, undefined, 0]);
  assert.match(e?.lastError ?? "", /cannot save the order journal \(ENOSPC.*\) — the accept was not sent and its invoice was released/);
  assert.equal(s.capital.reservedSat(), 0, "the coins are free");
  // The lane says why, meanwhile.
  assert.match(s.autopilot.getState().magmaLane.error ?? "", /could not decide 1 order \(cannot save the order journal/);
  disk.restore();
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("AcceptOrder"), 1, "sent once it can be marked");
  assert.equal(s.node.callsTo("invoices.addHoldInvoice").length, 2, "with a fresh invoice");
  assert.deepEqual([entryOnDisk(s.dir, sale.id)?.phase, entryOnDisk(s.dir, sale.id)?.acceptAttempts], ["accepted", 1]);
});

test("an accept whose mark can't be saved, with the approval deadline a minute away: the order is rejected — never left to time out on us (D6)", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 60_000).toISOString() });
  diskFullAfterInvoice(s, true);
  await s.autopilot.pollSellOrders();
  await s.autopilot.pollSellOrders();
  // Before: AcceptOrder 0 and RejectOrder 0 after every pass — "accepting",
  // "tried again on the next pass", until Amboss ended it SELLER_FAILED_TO_REACT.
  assert.equal(s.magma.count("AcceptOrder"), 0, "not sent without its mark");
  assert.equal(s.magma.count("RejectOrder"), 1);
  assert.equal(s.magma.sales.get(sale.id)?.status, "SELLER_REJECTED");
  const [made] = s.node.callsTo("invoices.addHoldInvoice");
  assert.equal(s.node.invoices.get(Buffer.from(made.hash as Buffer).toString("hex"))?.state, "CANCELED");
  assert.equal(s.capital.reservedSat(), 0);
});

test("a resend whose mark can't be saved is released the same way — but the earlier send, which went out marked, still counts as an attempt", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
  await s.autopilot.pollSellOrders(); // sent, marked — no answer
  assert.equal(s.magma.count("AcceptOrder"), 1);
  assert.ok(entryOnDisk(s.dir, sale.id)?.acceptSentAt, "the first send was marked");
  const journal = s.autopilot.magma.journal as unknown as { commit: (e: unknown) => void };
  const commit = journal.commit.bind(s.autopilot.magma.journal);
  journal.commit = () => {
    throw new Error("ENOSPC: no space left on device");
  };
  await s.autopilot.pollSellOrders(); // the resend's mark fails
  assert.equal(s.magma.count("AcceptOrder"), 1, "no resend without its mark");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.acceptAttempts], ["seen", null, 1], "the attempt that went out stays counted");
  journal.commit = commit;
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.count("AcceptOrder"), 2);
  assert.deepEqual([entryOnDisk(s.dir, sale.id)?.phase, entryOnDisk(s.dir, sale.id)?.acceptAttempts], ["accepted", 2]);
});

test("an order you accepted by hand whose resend can't be marked is left to you — the lane rejects none of yours, near its deadline neither", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: new Date(Date.now() + 60_000).toISOString() });
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
  const clicked = await s.desk.accept(sale.id); // sent, marked — no answer
  assert.equal(clicked.ok, false);
  assert.deepEqual([entryOnDisk(s.dir, sale.id)?.phase, entryOnDisk(s.dir, sale.id)?.via], ["accepting", "manual"]);
  const journal = s.autopilot.magma.journal as unknown as { commit: (e: unknown) => void };
  journal.commit = () => {
    throw new Error("ENOSPC: no space left on device");
  };
  await s.autopilot.pollSellOrders(); // the lane resumes your accept; its mark fails
  assert.equal(s.magma.count("AcceptOrder"), 1, "no resend without its mark");
  assert.equal(s.magma.count("RejectOrder"), 0, "your order: never rejected by the lane");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "seen", "back with you, its invoice released");
});

test("a click whose accept can't be marked is told so — nothing sent, the invoice released, the order still yours to decide", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  const disk = diskFullAfterInvoice(s, false);
  const res = await s.desk.accept(sale.id);
  assert.equal(res.ok, false);
  assert.match(res.message ?? "", /cannot save the order journal .* — the accept was not sent/);
  assert.equal(s.magma.count("AcceptOrder"), 0);
  assert.equal(s.magma.count("RejectOrder"), 0, "a click's order is never rejected for it");
  assert.equal(entryOnDisk(s.dir, sale.id)?.phase, "seen");
  disk.restore();
  const again = await s.desk.accept(sale.id);
  assert.equal(again.ok, true, again.message);
  assert.equal(s.magma.count("AcceptOrder"), 1);
});

test("the mark is per attempt: an earlier accept Amboss refused leaves no mark on the next one — a crash before that one went out, with selling paused since, still withdraws it", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "false" : "ok");
  await s.autopilot.pollSellOrders(); // attempt 1: sent, refused
  assert.equal(s.magma.count("AcceptOrder"), 1);
  assert.ok(entryOnDisk(s.dir, sale.id)?.acceptSentAt, "attempt 1 was marked");
  // Attempt 2: the invoice is made, then the process dies before the accept.
  const crashed = crashAt(s.autopilot.magma, "lndCreateHodl", "after");
  void s.autopilot.pollSellOrders();
  await until(crashed, "attempt 2's invoice was made");
  assert.equal(entryOnDisk(s.dir, sale.id)?.acceptSentAt, undefined, "attempt 2 starts unmarked");
  const p2 = s.restart();
  p2.pauseAll();
  await p2.pollSellOrders();
  // Before: attempt 1's mark made attempt 2 look sent — completed after the pause.
  assert.equal(s.magma.count("AcceptOrder"), 1);
  assert.deepEqual([entryOnDisk(s.dir, sale.id)?.phase, entryOnDisk(s.dir, sale.id)?.decision?.reason], ["seen", SELLING_OFF_SKIP]);
});

// Review of P8, round 2: two ways a paused lane still acted on its own.
// invoiceFailed — where an accept whose mark can't be saved ends up
// (unmarkedAccept) — rejected near the approval deadline without asking the
// switch; and resumeAccept asked it only before ensureInvoice, whose LND
// lookup (the invoice's request lost in a crash) is awaited.

/** The order's one HODL invoice, as LND has it now. */
function invoiceState(s: ReturnType<typeof sellerSetup>): string | undefined {
  const made = s.node.callsTo("invoices.addHoldInvoice");
  assert.equal(made.length, 1, "one invoice made");
  return s.node.invoices.get(Buffer.from(made[0].hash as Buffer).toString("hex"))?.state;
}

test("a resend whose mark can't be saved, the lane paused since the first send and the approval deadline a minute away: released and left to the operator — not turned down", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER, timeout: closeToDeadline() });
  s.magma.behave.AcceptOrder = (n) => (n === 0 ? "throw" : "ok");
  await s.autopilot.pollSellOrders(); // sent, marked — no answer
  assert.equal(s.magma.count("AcceptOrder"), 1);
  assert.ok(entryOnDisk(s.dir, sale.id)?.acceptSentAt, "the first send was marked");
  s.autopilot.pauseAll();
  const journal = s.autopilot.magma.journal as unknown as { commit: (e: unknown) => void };
  journal.commit = () => {
    throw new Error("ENOSPC: no space left on device");
  };
  // The step under way is completed whatever the switch says — but its
  // resend can't be marked, so it is released instead.
  await s.autopilot.pollSellOrders();
  // Before: RejectOrder 1 — "could not decide on it in time: cannot save the
  // order journal …" — and a "turned down" alert, from a paused lane.
  assert.equal(s.magma.count("RejectOrder"), 0, "a paused lane never rejects an order on its own");
  assert.equal(s.magma.count("AcceptOrder"), 1, "no resend without its mark");
  assert.equal(s.magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL", "still the operator's to decide");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.decision?.reason, e?.acceptAttempts], ["seen", null, SELLING_OFF_SKIP, 1]);
  assert.equal(invoiceState(s), "CANCELED", "the invoice is released");
  assert.equal(s.capital.reservedSat(), 0, "no coins promised");
  assert.deepEqual(magmaRefusalAlerts(s.autopilot.magma), []);
  assert.equal(s.autopilot.magma.laneStatus().error, null, "not an order the lane couldn't decide: the operator's");
});

test("restart after a crash that lost the invoice's request, the pause landing while LND is asked for it: the lane's never-sent accept is withdrawn, not sent", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  // The invoice is made in LND, then the process dies before its request is saved.
  const crashed = crashAt(s.autopilot.magma, "lndCreateHodl", "after");
  void s.autopilot.pollSellOrders();
  await until(crashed, "the invoice was made");
  const left = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([left?.phase, left?.invoice?.request, left?.acceptSentAt], ["accepting", null, undefined], "its request is not on disk; the accept never went out");
  const p2 = s.restart();
  const desk = p2.magma as unknown as { lndHodlStatus: (id: string) => Promise<unknown> };
  const lookup = desk.lndHodlStatus.bind(p2.magma);
  let lookups = 0;
  desk.lndHodlStatus = async (id) => {
    lookups += 1;
    if (!p2.getState().paused) p2.pauseAll(); // the operator pauses while LND is asked
    return lookup(id);
  };
  await p2.pollSellOrders();
  assert.equal(lookups, 1, "ensureInvoice asked LND for the lost request");
  assert.ok(p2.getState().paused);
  // Before: AcceptOrder 1 — the paused lane's accept, the order "accepted".
  assert.equal(s.magma.count("AcceptOrder"), 0);
  assert.equal(s.magma.count("RejectOrder"), 0);
  assert.equal(invoiceState(s), "CANCELED", "the invoice is released");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.decision?.reason, e?.acceptAttempts], ["seen", null, SELLING_OFF_SKIP, 0]);
  assert.equal(p2.capital.reservedSat(), 0, "the coins are free");
});

test("restart with selling paused since, and LND not answering about the order's invoice: the never-sent accept is withdrawn without asking — the attempt not counted", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  const sale = s.magma.addSale({ buyerPubkey: BUYER });
  const crashed = crashAt(s.autopilot.magma, "lndCreateHodl", "after");
  void s.autopilot.pollSellOrders();
  await until(crashed, "the invoice was made");
  const p2 = s.restart();
  p2.pauseAll();
  const desk = p2.magma as unknown as { lndHodlStatus: (id: string) => Promise<unknown> };
  let lookups = 0;
  desk.lndHodlStatus = async () => {
    lookups += 1;
    throw new Error("transport is closing");
  };
  await p2.pollSellOrders();
  // The switch is asked before the invoice is: withdrawn as it stands. (Asked
  // only after, the failed lookup left the never-sent attempt counted toward
  // the three refused accepts after which the lane turns an order down.)
  assert.equal(lookups, 0, "nothing to ask LND: the accept never went out, and the lane is paused");
  const e = entryOnDisk(s.dir, sale.id);
  assert.deepEqual([e?.phase, e?.invoice, e?.decision?.reason, e?.acceptAttempts], ["seen", null, SELLING_OFF_SKIP, 0]);
  assert.equal(s.magma.count("AcceptOrder"), 0);
  assert.equal(s.magma.count("RejectOrder"), 0);
  assert.equal(p2.capital.reservedSat(), 0);
});
