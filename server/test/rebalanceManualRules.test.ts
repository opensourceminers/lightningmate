/**
 * A refill by hand against the plan's rules (review 2026-11-10, REB-3).
 *
 * Before: POST /rebalance/execute checked ids and amounts and nothing about
 * the channels. The Rebalancing tab loads its plan once; a row's Run button
 * sent that row's one source, without the share a source keeps, however long
 * ago the plan was made. A source at 80 % local when the tab was opened and
 * routed down to 15 % since was taken to 0.5 %: 290k of its 300k paid out,
 * for a fee. And whatever the planner rules out — a source in a sold lease,
 * a private or young one, one that is draining, a target bought on Magma —
 * went through as asked.
 *
 * Now the server asks the plan's rules, with one fee engine run, before
 * anything is sent: each source must be one the pool would list this minute,
 * keeps its share, and gives at most what the pool says it can spare.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sentPayment } from "./helpers/fakeLnd.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RefillNotAllowedError, StalePlanError } from "../src/services/autopilot.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { REBAL_REC_DEFAULTS, sourceVerdicts, type RebalanceRecommendation } from "../src/services/rebalanceRecommend.js";
import { SAME_PEER_SOURCE, executeRebalance, type RebalanceExecParams } from "../src/services/rebalance.js";
import { autopilotWith, paidRebalance, type AutopilotSeams } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { feeNode, forwardsOut, type FeeChannel } from "./helpers/feeNode.js";
import { planFlow, planNode, PLAN_HEIGHT, type PlanSpec } from "./helpers/refillPlan.js";
import { makeTempDir } from "./helpers/tmp.js";

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const HEIGHT = 860_000;
const TARGET = "850000x1x0";
const LOW = "850000x2x0";
const FULL = "850000x3x0";
const FAIR = "850000x4x0";
/** A peer's name as the plan shows it where LND knows no alias. */
const ALIAS = (n: number) => `${PEER(n).slice(0, 12)}…`;

const chan = (id: string, n: number, localBalance: number, o: Partial<FeeChannel> = {}): FeeChannel => ({
  id,
  partnerPublicKey: PEER(n),
  capacity: 5_000_000,
  localBalance,
  transactionId: TX(n),
  transactionVout: 0,
  feeRatePpm: 100,
  baseFeeMsat: 0,
  ...o,
});
/**
 * A drained 5M target earning 400 ppm (1.2M routed out in 10 days), and three
 * 5M channels: LOW at 15 % local — the "source" of a plan made before it
 * routed out —, FULL at 80 % (1.25M above the 55 % it keeps) and FAIR at 72 %
 * (850k above).
 */
function refillNode(more: FeeChannel[] = [], target: Partial<FeeChannel> = {}) {
  const channels = [
    chan(TARGET, 1, 750_000, { feeRatePpm: 400, totalSent: 3_333_333, ...target }),
    chan(LOW, 2, 750_000),
    chan(FULL, 3, 4_000_000),
    chan(FAIR, 4, 3_600_000),
    ...more,
  ];
  return feeNode({ blockHeight: HEIGHT, channels, forwards: forwardsOut(channels[0].id, LOW, 20, { tokens: 60_000, feeMsat: 24_000, days: 10 }) });
}
const paid = (node: ReturnType<typeof refillNode>) => node.callsTo("router.sendPaymentV2");
const invoices = (node: ReturnType<typeof refillNode>) => node.callsTo("default.addInvoice");
/** What the tab sends for a row (manualRefillRequest). */
const tabRequest = (sourceId: string, amountSats: number, o: Record<string, unknown> = {}) => ({ targetId: TARGET, sourceId, amountSats, econRatio: 0.8, maxFeePpm: 320, ...o });
/** The executor replaced by one that notes what it was handed. */
function handedToExecutor(autopilot: unknown): RebalanceExecParams[] {
  const got: RebalanceExecParams[] = [];
  (autopilot as AutopilotSeams).rebalanceExec = async (_w, p) => {
    got.push(p);
    return paidRebalance(p);
  };
  return got;
}

test("a row whose source routed out since the plan — 15 % local now — is refused (409 not_allowed): no invoice, no payment, nothing booked (before: 290k of its 300k was paid out of it)", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode();
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 10_000 });
  const res = await api.request("POST", "/rebalance/execute", tabRequest(LOW, 700_000));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, "not_allowed");
  assert.equal(res.body.channelId, LOW);
  assert.equal(
    res.body.message,
    `${ALIAS(2)} can't give liquidity now: it holds 15% locally — a source holds 70% or more (20% above its 50% target)`,
  );
  assert.equal(paid(node).length, 0, "nothing was sent");
  assert.equal(invoices(node).length, 0, "no invoice was made for it");
  assert.deepEqual(new RebalanceLog(api.dir).recent(), [], "no attempt is booked");
  assert.equal(api.autopilot.rebalanceBudget().spentSats, 0);
  // The refill lock is free again: a row with a source that may give runs.
  const next = await api.request("POST", "/rebalance/execute", tabRequest(FULL, 400_000));
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.ok, true, next.body.error);
  assert.equal(paid(node).length, 1);
});

test("a source gives no more than it can spare above its share: 2M asked of one at 72 % local moves 850k, and it keeps its 55 % (before: 2M, leaving it at 32 %)", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode();
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 10_000 });
  const res = await api.request("POST", "/rebalance/execute", tabRequest(FAIR, 2_000_000));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true, res.body.error);
  assert.equal(res.body.amountSats, 850_000, "3.6M less the 2.75M it keeps");
  assert.equal(paid(node).length, 1);
  assert.equal(sentPayment(paid(node)[0] as Record<string, unknown>).tokens, 850_000);
});

test("the executor is handed every source with the share it keeps and the most it gives — whatever the request says of shares; the row's other sources go along in its order, and one the rules no longer allow is left out", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode();
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 10_000 });
  const got = handedToExecutor(api.autopilot);
  // A client of its own may send shares: they are not read.
  const sent = await api.request("POST", "/rebalance/execute", { ...tabRequest(FULL, 400_000, { otherSourceIds: [LOW, FAIR] }), sources: [{ id: FULL, keepRatio: 0 }], keepRatio: 0 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(got[0].sourceId, FULL);
  assert.deepEqual(got[0].sources, [
    { id: FULL, keepRatio: 0.55, maxSats: 1_250_000 },
    { id: FAIR, keepRatio: 0.55, maxSats: 850_000 },
  ]);
  // The row's first source has gone: the refill starts from the next one.
  await api.request("POST", "/rebalance/execute", tabRequest(LOW, 400_000, { otherSourceIds: [FAIR, FULL] }));
  assert.equal(got[1].sourceId, FAIR);
  assert.deepEqual(got[1].sources?.map((s) => s.id), [FAIR, FULL]);
  // A source named twice is asked for once.
  await api.request("POST", "/rebalance/execute", tabRequest(FULL, 400_000, { otherSourceIds: [FULL, FAIR, FAIR] }));
  assert.deepEqual(got[2].sources?.map((s) => s.id), [FULL, FAIR]);
  // None left: refused, each with its reason.
  const none = await api.request("POST", "/rebalance/execute", tabRequest(LOW, 400_000, { otherSourceIds: ["850000x9x0"] }));
  assert.equal(none.status, 409);
  assert.equal(none.body.error, "not_allowed");
  assert.equal(
    none.body.message,
    `None of this refill's sources can give liquidity now — ${ALIAS(2)}: it holds 15% locally — a source holds 70% or more (20% above its 50% target); 850000x9x0: it is not an open channel`,
  );
  assert.equal(got.length, 3);
});

test("the request's other sources are channel ids, eight at most — anything else is a bad request, and nothing is asked of the node", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = refillNode();
  const api = await startApi(t, { node });
  const got = handedToExecutor(api.autopilot);
  const nine = Array.from({ length: 9 }, (_, i) => `85000${i}x7x0`);
  for (const otherSourceIds of ["850000x3x0", [42], ["nope"], [FULL, null], nine]) {
    const res = await api.request("POST", "/rebalance/execute", tabRequest(FULL, 400_000, { otherSourceIds }));
    assert.equal(res.status, 400, JSON.stringify(otherSourceIds));
    assert.match(res.body.message, /otherSourceIds \(up to 8 channel ids\)/);
  }
  assert.equal(got.length, 0);
  assert.equal(node.callsTo("default.feeReport").length, 0, "refused before the rules are read");
  const eight = await api.request("POST", "/rebalance/execute", tabRequest(FULL, 400_000, { otherSourceIds: nine.slice(0, 8) }));
  assert.equal(eight.status, 200, JSON.stringify(eight.body));
  assert.deepEqual(got[0].sources?.map((s) => s.id), [FULL], "the eight are not open channels: left out");
});

test("a target bought on Magma is not refilled by hand while its lease runs — its low balance is what was bought; once the lease is over it is", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const bought = "858000x1x0"; // funded 2,000 blocks ago, leased for 4,320
  const purchase = (channelId: string) => ({ "magma-purchases.json": [{ orderId: "order-1", channelId, leaseBlocks: 4320, state: "channel_open", sizeSats: 5_000_000 }] });
  const node = refillNode([], { id: bought });
  const { autopilot } = autopilotWith(t, { rebalanceDailyBudgetSats: 10_000 }, {}, purchase(bought), node);
  await assert.rejects(
    autopilot.rebalanceByHand({ targetId: bought, sourceId: FULL, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 320 }),
    (err: unknown) => {
      assert.ok(err instanceof RefillNotAllowedError);
      assert.equal(err.channelId, bought);
      assert.equal(
        err.message,
        `${ALIAS(1)} is never refilled: it was bought on Magma for its inbound and its lease is still running — its low local balance is what was bought`,
      );
      return true;
    },
  );
  assert.equal(paid(node).length, 0);
  assert.equal(invoices(node).length, 0);
  // Funded 10,000 blocks ago: the lease is over, the channel is the node's to fill.
  const later = refillNode();
  const after = autopilotWith(t, { rebalanceDailyBudgetSats: 10_000 }, {}, purchase(TARGET), later);
  const res = await after.autopilot.rebalanceByHand({ targetId: TARGET, sourceId: FULL, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 320 });
  assert.equal(res?.ok, true, res?.error);
});

test("another channel of the target's peer is no source by hand either: the move would go out to that peer and straight back", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const sibling = "850000x5x0";
  const node = refillNode([chan(sibling, 1, 4_000_000)]);
  const { autopilot } = autopilotWith(t, { rebalanceDailyBudgetSats: 10_000 }, {}, {}, node);
  await assert.rejects(autopilot.rebalanceByHand({ targetId: TARGET, sourceId: sibling, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 320 }), (err: unknown) => {
    assert.ok(err instanceof RefillNotAllowedError);
    assert.equal(err.message, `${ALIAS(1)} can't give liquidity now: ${SAME_PEER_SOURCE}`);
    return true;
  });
  assert.equal(paid(node).length, 0);
  // With a source of another peer beside it, the refill runs from that one alone.
  const got = handedToExecutor(autopilot);
  await autopilot.rebalanceByHand({ targetId: TARGET, sourceId: sibling, sources: [{ id: sibling }, { id: FULL }], amountSats: 400_000, econRatio: 0.8, maxFeePpm: 320 });
  assert.deepEqual(got[0].sources, [{ id: FULL, keepRatio: 0.55, maxSats: 1_250_000 }]);
});

test("a row planned before another channel of its target's peer was refilled is stale too (409 stale_plan, naming that channel): the peer got its liquidity there", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const sibling = "850000x5x0";
  const planAt = new Date(Date.now() - 60_000).toISOString();
  const refilledAt = new Date(Date.now() - 30_000).toISOString();
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config: { rebalanceDailyBudgetSats: 10_000 }, history: [], sellAutoSizeMigrated: true, perTargetLastRebalanced: { [sibling]: refilledAt } }),
  );
  const node = refillNode([chan(sibling, 1, 500_000)]);
  const api = await startApi(t, { node, dir });
  const stale = await api.request("POST", "/rebalance/execute", tabRequest(FULL, 400_000, { planAt }));
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, "stale_plan");
  assert.equal(stale.body.targetId, TARGET);
  assert.equal(stale.body.peerChannelId, sibling);
  assert.equal(stale.body.message, "Another channel of this channel's peer was refilled (or tried) after this plan was made: reload it");
  assert.equal(paid(node).length, 0);
  // A plan made after that refill runs; so does the class by itself.
  const fresh = await api.request("POST", "/rebalance/execute", tabRequest(FULL, 400_000, { planAt: new Date().toISOString() }));
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(new StalePlanError(TARGET, refilledAt, planAt, sibling).peerChannelId, sibling);
  assert.equal(new StalePlanError(TARGET, refilledAt, planAt).message, "This channel was refilled (or tried) after this plan was made: reload it");
});

test("rules that can't be read send nothing: with the node's fees unreadable a manual refill is refused as a failed node request, and the refill lock is free again", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
  const node = refillNode();
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 10_000 });
  const working = node.lnd.default.feeReport;
  node.override("default.feeReport", (_a, cb) => cb(new Error("fee report unavailable")));
  for (let i = 0; i < 2; i += 1) {
    const res = await api.request("POST", "/rebalance/execute", tabRequest(FULL, 400_000));
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.error, "node_request_failed", "the same answer twice: no lock left held");
  }
  assert.equal(paid(node).length, 0);
  assert.equal(invoices(node).length, 0);
  node.override("default.feeReport", working);
  const ok = await api.request("POST", "/rebalance/execute", tabRequest(FULL, 400_000));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test("the executor never takes more from a source than the most it was given for it — the rest of the size is not made up from the share it keeps", async () => {
  const node = refillNode();
  const run = (maxSats: number | undefined) =>
    executeRebalance(node.lnd, node.lnd, { targetId: TARGET, sourceId: FULL, sources: [{ id: FULL, keepRatio: 0.55, ...(maxSats === undefined ? {} : { maxSats }) }], amountSats: 1_000_000, econRatio: 0.8, maxFeePpm: 320 });
  assert.equal((await run(300_000)).amountSats, 300_000);
  // Above its own spare the share it keeps is the limit, as before.
  assert.equal((await run(2_000_000)).amountSats, 1_000_000);
  assert.equal((await run(undefined)).amountSats, 1_000_000);
  // Nothing worth a payment left: the source is not tried.
  const before = paid(node).length;
  const none = await run(10_000);
  assert.equal(none.ok, false);
  assert.equal(paid(node).length, before);
});

test("the autopilot's own refill hands each source over with what the plan found it can spare — a fallback source of a peer with two channels gives what both hold above their shares together, not its own spare", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const { autopilot, seams } = autopilotWith(t, { rebalanceEnabled: true, rebalanceDailyBudgetSats: 10_000 }, {}, {}, refillNode());
  const cand = (channelId: string, spareSats: number) => ({ channelId, alias: channelId, localRatio: 0.8, spareSats, keepRatio: 0.55, reason: "" });
  seams.rebalanceReport = async () => ({
    recommendations: [
      {
        channelId: TARGET,
        alias: "router",
        wouldRebalance: true,
        recommendedAmount: 400_000,
        selectedSourceChannel: FULL,
        sourceCandidates: [cand(FULL, 1_250_000), cand(FAIR, 300_000), { ...cand(LOW, 900_000), rejected: true, rejectedReason: "no route" }],
        estimatedRouteFeeSats: 20,
        expectedNetProfitSats: 300,
        maxCostPpm: 320,
        maxCostSatsByPayback: 1_000,
        expectedRevenuePpm: 400,
        earningDemandSats: 1_200_000,
        minNetProfitSats: 100,
      } as unknown as RebalanceRecommendation,
    ],
  });
  const got = handedToExecutor(autopilot);
  await autopilot.runOnce();
  assert.deepEqual(got[0]?.sources, [
    { id: FULL, keepRatio: 0.55, maxSats: 1_250_000 },
    { id: FAIR, keepRatio: 0.55, maxSats: 300_000 },
  ]);
});

// ─────────────────────────── the pool's rules, in words ───────────────────────────

test("every rule that keeps a channel out of the source pool says why, in the words a refused run shows", () => {
  const specs: PlanSpec[] = [
    { n: 1, local: 4_000_000 }, // a source: 1.25M above the 55 % it keeps
    { n: 2, local: 750_000 }, // 15 % local
    { n: 3, local: 4_000_000, block: PLAN_HEIGHT - 1_000 }, // a week old
    { n: 4, local: 4_000_000 }, // made private below
    { n: 5, local: 4_000_000 }, // excluded below
    { n: 6, local: 4_000_000 }, // sold, its lease running
    { n: 7, local: 4_000_000, f14: planFlow(900_000, 100_000, 12, 90), f30: planFlow(900_000, 100_000, 12, 90) }, // draining
    { n: 8, capacity: 300_000, local: 212_000 }, // 47k above its share
    { n: 9, local: 4_000_000, active: false },
    { n: 10, local: 4_000_000, f14: planFlow(500_000, 600_000, 30, 400), f30: planFlow(500_000, 600_000, 30, 400) }, // earns the most
  ];
  const node = planNode(specs);
  const id = (n: number) => node.channels[n - 1].id;
  node.channels[3].private = true;
  const sold = node.channels[5];
  const verdicts = sourceVerdicts(
    node.channels.filter((c) => c.active),
    new Map(node.fees.map((f) => [f.channelId, f])),
    { [id(5)]: { mode: "exclude" } },
    REBAL_REC_DEFAULTS,
    { soldLeases: [{ fundingOutpoint: `${sold.transactionId}:${sold.transactionVout}`, source: "magma", orderId: "o", leaseBlocks: 20_000 }], currentBlock: PLAN_HEIGHT },
  );
  const first = verdicts.get(id(1));
  assert.ok(typeof first === "object", String(first));
  assert.deepEqual([first.spareSats, first.keepRatio], [1_250_000, 0.55]);
  const said = (n: number) => verdicts.get(id(n));
  assert.equal(said(2), "it holds 15% locally — a source holds 70% or more (20% above its 50% target)");
  assert.equal(said(3), "it is younger than 14 days");
  assert.equal(said(4), "it is a private channel — nothing routes back through one");
  assert.equal(said(5), "it is excluded from the autopilot");
  assert.equal(said(6), "it was sold (Magma or LSP) and its lease is running — its balance is the buyer's inbound");
  assert.equal(said(7), "it is draining — more routed out of it than in over 14 days");
  assert.equal(said(8), "it holds only 47k above the 55% it keeps");
  assert.equal(verdicts.has(id(9)), false, "an offline channel is not asked at all (the caller says so)");
  assert.equal(said(10), "it is one of the best earners");
});
