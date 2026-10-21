/**
 * The market reference from the public graph (review a1:
 * blind-price-discovery, package P2): what other nodes charge to forward into
 * the same peer, and what the peer charges back to us — no paid service,
 * nothing sent anywhere. Before, only per-node averages were kept and the fee
 * engine priced every channel blind: an idle channel waited, then stepped
 * down from wherever it sat.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_READ_DEADLINE_MS,
  GRAPH_STALE_MAX_MS,
  GRAPH_TTL_MS,
  buildGraphCache,
  peerMarketFees,
  weightedMedianFee,
} from "../src/services/suggestions.js";
import { MARKET_MEMORY_MS, MARKET_WAIT_MS, getFeeRecommendations } from "../src/services/feeRecommend.js";
import { feeNode, chanNumber, forwardsOut, withMarket } from "./helpers/feeNode.js";

const PK = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const nowSec = () => Math.floor(Date.now() / 1000);

const policy = (feePpm: number, o: { disabled?: boolean; ageDays?: number } = {}) => ({
  disabled: o.disabled ?? false,
  fee_base_msat: "1000",
  fee_rate_milli_msat: String(feePpm),
  last_update: nowSec() - (o.ageDays ?? 1) * 86_400,
  max_htlc_msat: "990000000",
  min_htlc: "1000",
  time_lock_delta: 40,
});

/** A graph edge between a and b; `aFee` is a's policy (a forwarding into b). */
function edge(id: string, a: string, b: string, capacity: number, aPolicy: ReturnType<typeof policy> | null, bPolicy: ReturnType<typeof policy> | null, tx: string) {
  return {
    capacity: String(capacity),
    chan_point: `${tx}:0`,
    channel_id: chanNumber(id),
    node1_pub: a,
    node2_pub: b,
    node1_policy: aPolicy,
    node2_policy: bPolicy,
  };
}

function graphNode(feeRatePpm = 500) {
  const node = feeNode({
    channels: [{ id: "850000x1x0", partnerPublicKey: PK(1), capacity: 2_000_000, localBalance: 800_000, transactionId: TX(1), transactionVout: 0, feeRatePpm, baseFeeMsat: 0 }],
  });
  const me = node.publicKey;
  const P = PK(1);
  const edges = [
    // Our channel with P: our policy (our fee into P — not "the market") and
    // P's (its fee back to us).
    edge("850000x1x0", me, P, 2_000_000, policy(500), policy(150), TX(1)),
    // Other nodes into P: 80 ppm on 1M, 100 on 4M, 120 on 1M, 5,000 on 0.5M.
    edge("850001x1x0", PK(11), P, 1_000_000, policy(80), policy(1), TX(11)),
    edge("850002x1x0", PK(12), P, 4_000_000, policy(100), policy(1), TX(12)),
    edge("850003x1x0", PK(13), P, 1_000_000, policy(120), policy(1), TX(13)),
    edge("850004x1x0", PK(14), P, 500_000, policy(5_000), policy(1), TX(14)),
    // Not a price anyone pays: disabled, or untouched for months.
    edge("850005x1x0", PK(15), P, 9_000_000, policy(9, { disabled: true }), policy(1), TX(15)),
    edge("850006x1x0", PK(16), P, 9_000_000, policy(9, { ageDays: 90 }), policy(1), TX(16)),
    // A thinly connected node (two channels in): no reference for it.
    edge("850007x1x0", PK(17), PK(2), 1_000_000, policy(50), policy(1), TX(17)),
    edge("850008x1x0", PK(18), PK(2), 1_000_000, policy(60), policy(1), TX(18)),
  ];
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges, nodes: [] }));
  return Object.assign(node, { edges });
}

test("the capacity-weighted median of what others charge into a peer — own, disabled and stale policies left out", () => {
  assert.equal(weightedMedianFee([80, 1_000_000, 100, 4_000_000, 120, 1_000_000, 5_000, 500_000]), 100);
  assert.equal(weightedMedianFee([]), null);
});

test("peerMarketFees: the market into each peer and the peer's own fee back to us; a peer with fewer than 3 channels in gets none", async () => {
  const node = graphNode();
  const refs = await peerMarketFees(node.lnd, [
    { id: "850000x1x0", peerPubkey: PK(1) },
    { id: "850099x1x0", peerPubkey: PK(2) },
  ]);
  assert.deepEqual(refs.get("850000x1x0"), { intoPeerPpm: 100, samples: 4, peerFeeToUsPpm: 150 });
  assert.equal(refs.has("850099x1x0"), false);
});

test("the fee engine reads the graph by itself: an idle channel at 500 ppm drops to just under the market into its peer, not 30 ppm a day from wherever it sat", async () => {
  // (Step 10: the policy's "Round to", as the autopilot maps it.)
  const report = await getFeeRecommendations(graphNode(500).lnd, [], null, { stepPpm: 10 }, {}, new Map(), new Map(), [], { demand: new Map() });
  const [r] = report.recommendations;
  assert.equal(r.metrics.marketPpm, 100);
  assert.equal(r.metrics.replacementCostPpm, 250, "100 into the peer + its 150 back to us");
  assert.equal(r.metrics.marketComparison, "above");
  assert.equal(r.targetPpm, 90);
  assert.match(r.reasons[0], /other nodes charge ~100 ppm into this peer/);
  assert.equal(report.marketReferenced, 1);
  // The graph can't be read: priced as before.
  const blind = await getFeeRecommendations(feeNode({ channels: [{ id: "850000x1x0", partnerPublicKey: PK(1), capacity: 2_000_000, localBalance: 800_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 500, baseFeeMsat: 0 }] }).lnd, [], null, {}, {}, new Map(), new Map(), [], { demand: new Map() });
  assert.equal(blind.recommendations[0].metrics.marketPpm, null);
  assert.equal(blind.marketReferenced, 0);
});

test("a graph that takes too long never holds up the fee engine: that report prices without the market, and the read goes on for the next one", async (t) => {
  const node = graphNode(500);
  let answer: ((err: unknown, res?: unknown) => void) | null = null;
  let reads = 0;
  node.override("default.describeGraph", (_a, cb) => {
    reads += 1;
    answer = cb;
  });
  // (A real interval keeps the loop alive while the mocked timeout waits.)
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = getFeeRecommendations(node.lnd, [], null, { stepPpm: 10 }, {}, new Map(), new Map(), [], { demand: new Map() });
  for (let i = 0; i < 200 && !answer; i++) await new Promise((r) => setImmediate(r));
  assert.ok(answer, "the graph was asked for");
  t.mock.timers.tick(MARKET_WAIT_MS);
  const first = await pending;
  assert.equal(first.recommendations[0].metrics.marketPpm, null, "priced without it");
  // A second report meanwhile shares the read under way.
  const second = getFeeRecommendations(node.lnd, [], null, { stepPpm: 10 }, {}, new Map(), new Map(), [], { demand: new Map() });
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1, "one read for both");
  (answer as unknown as (err: unknown, res?: unknown) => void)(null, { edges: node.edges, nodes: [] });
  const next = await second;
  assert.equal(next.recommendations[0].metrics.marketPpm, 100);
});

test("a graph past its 30 minutes is served at once while a fresh read runs — a slow read no longer drops the market from every other report — and only one older than 12 h is waited for", async (t) => {
  const node = graphNode(500);
  // (A real interval keeps the loop alive while mocked timeouts wait.)
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const report = () => getFeeRecommendations(node.lnd, [], null, { stepPpm: 10 }, {}, new Map(), new Map(), [], { demand: new Map() });
  const first = await report();
  assert.equal(first.recommendations[0].metrics.marketPpm, 100);

  // 31 minutes on, the next read takes longer than the fee engine waits.
  let answer: ((err: unknown, res?: unknown) => void) | null = null;
  let reads = 0;
  node.override("default.describeGraph", (_a, cb) => {
    reads += 1;
    answer = cb;
  });
  t.mock.timers.tick(GRAPH_TTL_MS + 60_000);
  let done = false;
  const pending = report().then((r) => {
    done = true;
    return r;
  });
  for (let i = 0; i < 200 && !done; i++) await new Promise((r) => setImmediate(r));
  // Before: the cache was dropped, this report gave up after MARKET_WAIT_MS
  // and priced without the market — every other autopilot run.
  assert.ok(done, "served at once — no wait for the slow read");
  const second = await pending;
  assert.equal(second.recommendations[0].metrics.marketPpm, 100, "the last good graph");
  assert.equal(second.marketReferenced, 1);
  assert.equal(second.recommendations[0].targetPpm, 90, "priced as before: no flap");
  assert.equal(reads, 1, "a fresh read was started in the background");

  // The fresh read lands: the next report uses it (others now charge 200).
  const dearer = node.edges.map((e) =>
    e.node2_pub === PK(1) && e.node1_pub !== node.publicKey ? { ...e, node1_policy: e.node1_policy && { ...e.node1_policy, fee_rate_milli_msat: "200" } } : e,
  );
  (answer as unknown as (err: unknown, res?: unknown) => void)(null, { edges: dearer, nodes: [] });
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal((await report()).recommendations[0].metrics.marketPpm, 200);

  // A graph older than GRAPH_STALE_MAX_MS is no longer "today's market": the
  // report waits for the read again — past the wait, each channel keeps the
  // reference it last had (MARKET_MEMORY_MS), and says so.
  answer = null;
  t.mock.timers.tick(GRAPH_STALE_MAX_MS);
  const old = report();
  for (let i = 0; i < 200 && !answer; i++) await new Promise((r) => setImmediate(r));
  assert.ok(answer, "the old graph is not served: a read is waited for");
  t.mock.timers.tick(MARKET_WAIT_MS);
  const remembered = (await old).recommendations[0];
  assert.equal(remembered.metrics.marketPpm, 200);
  assert.ok(remembered.metrics.marketSeenAt, "a remembered reference says so");
  assert.match(remembered.reasons[0], /other nodes charge ~200 ppm into this peer \(last seen 12 h ago\)/);
});

test("a background refresh that fails leaves the last good graph in place — no unhandled rejection — and the next report starts another read", async (t) => {
  const node = graphNode(500);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const report = () => getFeeRecommendations(node.lnd, [], null, { stepPpm: 10 }, {}, new Map(), new Map(), [], { demand: new Map() });
  assert.equal((await report()).recommendations[0].metrics.marketPpm, 100);
  let reads = 0;
  node.override("default.describeGraph", (_a, cb) => {
    reads += 1;
    cb({ details: "graph read failed for the test" });
  });
  t.mock.timers.tick(GRAPH_TTL_MS + 60_000);
  assert.equal((await report()).recommendations[0].metrics.marketPpm, 100);
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal((await report()).recommendations[0].metrics.marketPpm, 100, "still the last good graph");
  assert.equal(reads, 2, "each report past the 30 minutes tries a fresh read");
});

// ── review 3: a reference the graph lacks for a while, a read that never answers ──

/** The graph after the peer of channel 1 was offline: the other nodes'
 *  channels into it carry the disabled bit (LND re-enables them only ~20
 *  minutes after the peer is back). */
function peerOffline(graph: { edges: Record<string, unknown>[] }, peer: string, own: string) {
  return {
    edges: graph.edges.map((e) =>
      e.node2_pub === peer && e.node1_pub !== own ? { ...e, node1_policy: { ...(e.node1_policy as object), disabled: true } } : e,
    ),
    nodes: [],
  };
}

test("a channel whose peer drops out of the market reference (its inbound channels disabled after an outage) keeps its last one for MARKET_MEMORY_MS — a draining channel is not lowered — and says when it was last seen", async (t) => {
  // Draining (10 forwards of 50,000 out in 10 days) at 300 ppm; 200 into the
  // peer + 100 back: a refill costs ~300, × 1.15 = 345.
  const channels = [
    { id: "850000x1x0", partnerPublicKey: PK(1), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0 },
    { id: "850000x3x0", partnerPublicKey: PK(3), capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(3), transactionVout: 0, feeRatePpm: 80, baseFeeMsat: 0 },
  ];
  const node = feeNode({ channels, forwards: forwardsOut("850000x1x0", "850000x3x0", 10) });
  const graph = withMarket(node, channels, { "850000x1x0": { intoPpm: 200, backPpm: 100 } });
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const report = async () => (await getFeeRecommendations(node.lnd, [], null, { stepPpm: 10 }, {}, new Map(), new Map(), [], { demand: new Map() })).recommendations.find((r) => r.channelId === "850000x1x0")!;
  const first = await report();
  assert.deepEqual([first.metrics.marketPpm, first.metrics.marketSeenAt, first.targetPpm, first.aimPpm], [200, null, 320, 350]);
  const seenAt = Date.now();

  // The peer was offline: the graph read after it has no reference for it.
  node.override("default.describeGraph", (_a, cb) => cb(null, peerOffline(graph, PK(1), node.publicKey)));
  t.mock.timers.tick(GRAPH_TTL_MS + 60_000);
  await report(); // (served the cached graph while the fresh read runs)
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(5 * 60_000);
  const gap = await report();
  // Before: no reference — the balance curve's ~80 ppm, 300 → 270.
  assert.deepEqual([gap.metrics.marketPpm, gap.targetPpm, gap.aimPpm], [200, 320, 350], gap.reasons.join(" | "));
  assert.equal(Date.parse(gap.metrics.marketSeenAt ?? ""), seenAt + GRAPH_TTL_MS + 60_000, "when a report last had it");
  assert.match(gap.reasons[0], /^replacement: draining, .* \(last seen 5 min ago\) — pricing toward 345 ppm/);
  // A market given explicitly (a test seam) is used as given — not completed from memory.
  const explicit = await getFeeRecommendations(node.lnd, [], null, { stepPpm: 10 }, {}, new Map(), new Map(), [], { demand: new Map(), market: new Map() });
  assert.equal(explicit.recommendations.find((r) => r.channelId === "850000x1x0")?.metrics.marketPpm, null);

  // A week on, still no reference: forgotten — and the draining channel is
  // held, not lowered toward the curve.
  t.mock.timers.tick(MARKET_MEMORY_MS);
  const later = await report();
  assert.deepEqual([later.metrics.marketPpm, later.metrics.marketSeenAt, later.targetPpm], [null, null, 300], later.reasons.join(" | "));
  assert.match(later.reasons[0], /^hold: draining — no market reference for its refill cost this run/);
});

test("a graph read that never answers is given up after GRAPH_READ_DEADLINE_MS: the next caller starts a new read while the last good graph is still served, and a caller with no graph gets an error instead of waiting for good", async (t) => {
  const node = graphNode(500);
  const keepAlive = setInterval(() => undefined, 1_000);
  t.after(() => clearInterval(keepAlive));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  assert.equal((await buildGraphCache(node.lnd)).into.get(PK(1))?.length, 8, "a good graph first");
  // From now on DescribeGraph never answers (unless the test answers it).
  let reads = 0;
  const answers: ((err: unknown, res?: unknown) => void)[] = [];
  node.override("default.describeGraph", (_a, cb) => {
    reads += 1;
    answers.push(cb);
  });
  t.mock.timers.tick(GRAPH_TTL_MS + 60_000);
  const stale = await buildGraphCache(node.lnd);
  assert.equal(stale.into.get(PK(1))?.length, 8, "served at once, while a fresh read runs");
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1);
  // Before: that read stayed "under way" for good — no caller ever started another.
  await buildGraphCache(node.lnd);
  assert.equal(reads, 1, "still under way: shared, not started again");
  t.mock.timers.tick(GRAPH_READ_DEADLINE_MS);
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal((await buildGraphCache(node.lnd)).into.get(PK(1))?.length, 8, "the last good graph, still");
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(reads, 2, "a new read was started");
  // The read given up fails after all: that ends nothing but itself — the
  // next caller shares the second read instead of starting a third.
  answers[0]({ details: "the first read failed, late" });
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  await buildGraphCache(node.lnd);
  assert.equal(reads, 2, "the second read is still the one under way");

  // No graph younger than 12 h: the caller waits — but no longer for good.
  t.mock.timers.tick(GRAPH_STALE_MAX_MS);
  const waiting = buildGraphCache(node.lnd);
  let settled = false;
  waiting.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "waiting for the read");
  t.mock.timers.tick(GRAPH_READ_DEADLINE_MS);
  await assert.rejects(waiting, /the network graph read took longer than 10 minutes/);
});
