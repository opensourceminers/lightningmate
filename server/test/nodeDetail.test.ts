/**
 * One node's details (GET /nodes/…): what the app knows about a node, whether
 * it has a channel with it or only thinks of opening one. A node's public
 * record is asked for one node at a time, when it is opened, and can be
 * switched off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApi } from "./helpers/apiHarness.js";
import { chanNumber, feeNode, type FakeForward, type FeeChannel } from "./helpers/feeNode.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { makeTempDir } from "./helpers/tmp.js";
import { clearNodeLookupCache, parsePublicNode } from "../src/services/nodeLookup.js";
import { searchGraph, NODE_SEARCH_MAX } from "../src/services/nodeDetail.js";
import type { NodeMeta, NodeStat } from "../src/services/suggestions.js";

const HEIGHT = 860_000;
const PK = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const nowSec = () => Math.floor(Date.now() / 1000);

const policy = (ppm: number, disabled = false) => ({
  disabled,
  fee_base_msat: "1000",
  fee_rate_milli_msat: String(ppm),
  last_update: nowSec() - 3_600,
  max_htlc_msat: "990000000",
  min_htlc: "1000",
  time_lock_delta: 80,
});

/** What LND's GetNodeInfo answers for a node with `edges`. */
const nodeInfo = (pk: string, alias: string, addrs: string[], edges: unknown[]) => ({
  node: { pub_key: pk, alias, addresses: addrs.map((addr) => ({ network: "tcp", addr })), last_update: nowSec() - 7_200, color: "#000000", features: {} },
  num_channels: edges.length,
  total_capacity: String(edges.length * 5_000_000),
  channels: edges,
});

const closedRow = (peer: string, n: number, closeHeight: number, type: string) => ({
  alias_scids: [],
  capacity: "3000000",
  chan_id: chanNumber(`850000x${n}x0`),
  channel_point: `${TX(n)}:0`,
  close_height: closeHeight,
  closing_tx_hash: TX(n + 50),
  remote_pubkey: peer,
  settled_balance: "2900000",
  time_locked_balance: "0",
  close_type: type,
  open_initiator: "INITIATOR_LOCAL",
  close_initiator: "INITIATOR_LOCAL",
  resolutions: [],
  zero_conf_confirmed_scid: "0",
});

const PID = `${HEIGHT - 14_400}x1x0`;
const QID = `${HEIGHT - 14_400}x2x0`;

/** A node with a channel to P (and one to Q): P routes, is priced, and has a story. */
function setup(forwards: FakeForward[] = []) {
  const P = PK(1);
  const Q = PK(2);
  const channels: FeeChannel[] = [
    { id: PID, partnerPublicKey: P, capacity: 5_000_000, localBalance: 3_000_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 430, baseFeeMsat: 0 },
    { id: QID, partnerPublicKey: Q, capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
  ];
  const node = feeNode({ blockHeight: HEIGHT, channels, forwards });
  node.peers.push(P);
  // A current LND: GetNodeInfo's own channel data is what the library uses.
  node.override("version.getVersion", (_a, cb) => cb(null, { app_minor: 18, app_patch: 5, build_tags: [], commit_hash: "" }));
  return { node, P, Q };
}

test("a peer: its channel with what it earned and brought in, refills, the fee it charges, the network's view of it and its story", async (t) => {
  const pid = PID;
  const qid = QID;
  const { node, P } = setup([
    { at: Date.now() - 60_000, inId: qid, outId: pid, tokens: 100_000, feeMsat: 43_000 },
    { at: Date.now() - 60_000, inId: qid, outId: pid, tokens: 200_000, feeMsat: 86_000 },
    { at: Date.now() - 60_000, inId: pid, outId: qid, tokens: 50_000, feeMsat: 5_000 },
    // Older than the window: not counted.
    { at: Date.now() - 40 * 86_400_000, inId: qid, outId: pid, tokens: 900_000, feeMsat: 900_000 },
  ]);
  const edge = (n: number, ppm: number, disabled = false) => ({
    capacity: "5000000",
    chan_point: `${TX(n)}:0`,
    channel_id: chanNumber(n === 1 ? pid : `840000x${n}x0`),
    node1_pub: P,
    node2_pub: PK(100 + n),
    node1_policy: policy(ppm, disabled),
    node2_policy: policy(7),
    last_update: nowSec() - 3_600,
  });
  // Its fees: 50, 200, 300 and a channel priced to stay empty, which is off.
  node.override("default.getNodeInfo", (_a, cb) =>
    cb(null, nodeInfo(P, "peer one", ["203.0.113.9:9735", "peeronionaddress.onion:9735"], [edge(1, 200), edge(2, 50), edge(3, 300), edge(4, 50_000, true)])),
  );
  node.override("default.closedChannels", (_a, cb) =>
    cb(null, {
      channels: [
        closedRow(P, 7, HEIGHT - 1_440, "COOPERATIVE_CLOSE"),
        closedRow(P, 8, 0, "FUNDING_CANCELED"),
        closedRow(PK(9), 9, HEIGHT - 144, "COOPERATIVE_CLOSE"),
      ],
    }),
  );
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));

  const dir = makeTempDir(t);
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  writeFileSync(
    join(dir, "rebalances.json"),
    JSON.stringify([
      { at: iso(3_600_000), via: "autopilot", targetId: pid, targetAlias: "peer one", sourceId: qid, sourceAlias: "q", amountSats: 500_000, budgetPpm: 500, feeSats: 120, costPpm: 240, ok: true },
      { at: iso(40 * 86_400_000), via: "manual", targetId: pid, targetAlias: "peer one", sourceId: qid, sourceAlias: "q", amountSats: 100_000, budgetPpm: 500, feeSats: 50, costPpm: 500, ok: true },
      { at: iso(7_200_000), via: "autopilot", targetId: qid, targetAlias: "q", sourceId: pid, sourceAlias: "peer one", amountSats: 200_000, budgetPpm: 500, feeSats: 30, costPpm: 150, ok: true },
      { at: iso(600_000), via: "autopilot", targetId: pid, targetAlias: "peer one", sourceId: qid, sourceAlias: "q", amountSats: 1, budgetPpm: 500, feeSats: null, costPpm: null, ok: false, error: "no route" },
    ]),
  );
  writeFileSync(
    join(dir, "fee-changes.json"),
    JSON.stringify([
      { at: iso(1_800_000), channelId: pid, alias: "peer one", fromPpm: 400, toPpm: 430, fromBaseMsat: 0, toBaseMsat: 0, via: "autopilot", why: "drains — raising" },
      { at: iso(1_900_000), channelId: qid, alias: "q", fromPpm: 90, toPpm: 100, fromBaseMsat: 0, toBaseMsat: 0, via: "autopilot" },
    ]),
  );
  const api = await startApi(t, { node, dir });
  api.autopilot.setNeverOpen(P, true, "peer one");

  // The key as typed, in capitals: the same node.
  const res = await api.request("GET", `/nodes/detail?pubkey=${P.toUpperCase()}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body;
  assert.equal(d.pubkey, P);
  assert.equal(d.alias, "peer one");
  assert.equal(d.isSelf, false);
  assert.equal(d.neverOpen, true);

  assert.equal(d.channels.length, 1);
  assert.equal(d.channels[0].id, pid);
  assert.equal(d.channels[0].feeRatePpm, 430);

  const f = d.channelFacts[0];
  assert.equal(f.ageDays, 100);
  assert.deepEqual(
    [f.forwardsOut, f.routedOutSats, f.earnedSats, f.forwardsIn, f.routedInSats, f.broughtInSats],
    [2, 300_000, 129, 1, 50_000, 5],
    "the window's forwards, out and in, on exact msat",
  );
  assert.deepEqual([f.refills, f.refillSats, f.refillFeeSats], [1, 500_000, 120], "a refill into it within the window; the older one and the failed one aren't");
  assert.deepEqual([f.theirFeePpm, f.theirBaseFeeMsat, f.theirTimeLock, f.theirDisabled], [200, 1000, 80, false], "what the peer charges on this very channel");
  assert.equal(d.forwardsKnown, true);
  assert.equal(d.windowDays, 30);

  const n = d.network;
  assert.equal(n.channels, 4);
  assert.equal(n.capacitySats, 20_000_000);
  assert.equal(n.avgChannelSats, 5_000_000);
  assert.equal(n.typicalFeePpm, 200, "the median of its enabled channels: the 50,000 ppm one that is off doesn't count");
  assert.equal(n.enabledChannels, 3);
  assert.deepEqual(n.addresses, ["peeronionaddress.onion:9735", "203.0.113.9:9735"], "a Tor-only node dials the onion first");
  assert.equal(n.hasClearnet, true);
  assert.equal(n.hasOnion, true);

  assert.equal(d.connection.socket, "127.0.0.1:9735");
  assert.equal(d.connection.inbound, false);

  // Fee changes and refills that touched this node's channels, newest first:
  // not Q's fee change, and only successes.
  const kinds = d.events.map((e: { kind: string; direction?: string }) => (e.kind === "refill" ? `refill ${e.direction}` : e.kind));
  assert.deepEqual(kinds, ["fee", "refill in", "refill out", "refill in"]);
  assert.equal(d.events[0].why, "drains — raising");
  assert.equal(d.eventsMore, 0);

  // Closed with it: dated, not the funding that never confirmed, not another peer's.
  assert.equal(d.closedChannels.length, 1);
  assert.equal(d.closedChannels[0].how, "cooperative");
  assert.equal(d.closedChannels[0].closedDaysAgo, 10);
  assert.equal(d.closedChannels[0].finalLocalSats, 2_900_000);
});

test("a node without a channel, or one the graph doesn't know: an answer, not an error — and a bad key is refused", async (t) => {
  const { node } = setup();
  node.override("default.getNodeInfo", (_a, cb) => cb({ details: "unable to find node" }));
  node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [] }));
  const api = await startApi(t, { node });

  const stranger = PK(50);
  const res = await api.request("GET", `/nodes/detail?pubkey=${stranger}`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.channels, []);
  assert.deepEqual(res.body.channelFacts, []);
  assert.equal(res.body.network, null);
  assert.equal(res.body.connection, null);
  assert.match(res.body.alias, /^023232323232…$/);

  // This node itself.
  const self = await api.request("GET", `/nodes/detail?pubkey=${node.publicKey}`);
  assert.equal(self.body.isSelf, true);

  for (const route of ["detail", "assessment", "public"]) {
    assert.equal((await api.request("GET", `/nodes/${route}?pubkey=nope`)).status, 400, route);
    assert.equal((await api.request("GET", `/nodes/${route}`)).status, 400, route);
  }
});

test("if LND won't give a node's channels it still gives the node, without its fees", async (t) => {
  const { node, P } = setup();
  node.override("default.getNodeInfo", (a, cb) => {
    if ((a as { include_channels?: boolean }).include_channels) return cb({ details: "boom" });
    cb(null, { ...nodeInfo(P, "peer one", ["peeronionaddress.onion:9735"], []), num_channels: 9, total_capacity: "90000000" });
  });
  node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [] }));
  const api = await startApi(t, { node });
  const d = (await api.request("GET", `/nodes/detail?pubkey=${P}`)).body;
  assert.equal(d.alias, "peer one");
  assert.equal(d.network.channels, 9);
  assert.equal(d.network.typicalFeePpm, null);
  assert.equal(d.channelFacts[0].theirFeePpm, null);
});

/** A graph: this node → P and Q; C has 10 channels to nodes out of reach; S
 *  has three; P alone reaches X. */
function graphSetup() {
  const { node, P, Q } = setup();
  const me = node.publicKey;
  const C = PK(3);
  const S = PK(4);
  const X = PK(5);
  const edge = (n: number, a: string, b: string) => ({
    capacity: "5000000",
    chan_point: `${n.toString(16).padStart(64, "0")}:0`,
    channel_id: chanNumber(`840000x${n}x0`),
    node1_pub: a,
    node2_pub: b,
    node1_policy: policy(200),
    node2_policy: policy(200),
    last_update: nowSec() - 3_600,
  });
  const edges = [
    edge(1, me, P),
    edge(2, me, Q),
    edge(3, P, X),
    ...Array.from({ length: 10 }, (_, i) => edge(10 + i, C, PK(100 + i))),
    ...Array.from({ length: 3 }, (_, i) => edge(30 + i, S, PK(120 + i))),
  ];
  const info = (pk: string, alias: string, addrs: string[]) => ({ pub_key: pk, alias, addresses: addrs.map((addr) => ({ network: "tcp", addr })), last_update: nowSec() - 3_600, color: "#000000", features: {} });
  node.override("default.describeGraph", (_a, cb) =>
    cb(null, { edges, nodes: [info(C, "Candidate Alpha", ["203.0.113.5:9735"]), info(S, "small alpha", ["smallnode.onion:9735"]), info(P, "peer one", []), info(Q, "peer two", []), info(X, "X", [])] }),
  );
  node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [] }));
  return { node, P, C, S };
}

test("the assessment scores any node exactly as the suggestions score it — on their list or off it — and says what keeps it off", async (t) => {
  const { node, P, C, S } = graphSetup();
  const api = await startApi(t, { node });
  api.settings.set({ lnplusLookups: false });

  const list = await api.request("GET", "/suggestions");
  const listed = list.body.suggestions.find((s: { pubkey: string }) => s.pubkey === C);
  assert.ok(listed, "C is on the list");

  const onList = (await api.request("GET", `/nodes/assessment?pubkey=${C}`)).body;
  assert.equal(onList.candidate.pubkey, C);
  assert.equal(onList.candidate.score, listed.score, "the same score as on the list");
  assert.equal(onList.candidate.recommendedSizeSats, listed.recommendedSizeSats);
  assert.equal(onList.candidate.newReach, listed.newReach);
  assert.deepEqual(onList.notSuggestedBecause, []);
  assert.equal(onList.uniqueReach, null);

  // Three channels: below what the list takes — judged anyway, and said why.
  const offList = (await api.request("GET", `/nodes/assessment?pubkey=${S}`)).body;
  assert.equal(offList.candidate.pubkey, S);
  assert.deepEqual(offList.notSuggestedBecause, ["it has 3 channels (suggestions start at 8)"]);
  assert.deepEqual(offList.candidate.sockets, ["smallnode.onion:9735"]);

  // A peer: not a candidate; what a close would lose.
  const peer = (await api.request("GET", `/nodes/assessment?pubkey=${P}`)).body;
  assert.equal(peer.candidate, null);
  assert.equal(peer.uniqueReach, 1, "X is reached only through P");

  // Unknown, and this node itself.
  const unknown = (await api.request("GET", `/nodes/assessment?pubkey=${PK(99)}`)).body;
  assert.equal(unknown.candidate, null);
  assert.deepEqual(unknown.notSuggestedBecause, ["your node's view of the network doesn't have it"]);
  const self = (await api.request("GET", `/nodes/assessment?pubkey=${node.publicKey}`)).body;
  assert.equal(self.candidate, null);
  assert.deepEqual(self.notSuggestedBecause, []);
});

test("an LN+ reputation moves the assessment's score as it moves the list's", async (t) => {
  const { node, C } = graphSetup();
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "lnplus-nodes.json"),
    JSON.stringify({
      nodes: {
        [C]: {
          at: Date.now(),
          node: { pubkey: C, alias: "Candidate Alpha", rank: 8, rankName: "Platinum", prime: true, pro: false, verified: true, positiveRatings: 30, negativeRatings: 0, positiveGiven: 0, negativeGiven: 0, badges: [], openChannels: 10, capacitySats: 50_000_000, minChannelSizeSats: 3_000_000, profileUrl: "https://lightningnetwork.plus/nodes/x" },
        },
      },
      calls: [],
    }),
  );
  const api = await startApi(t, { node, dir });
  // No LN+ request for anyone else on the list.
  const http = installFetchMock(t);
  http.on(/lightningnetwork\.plus/, () => new Response("{}", { status: 404 }));
  const listed = (await api.request("GET", "/suggestions")).body.suggestions.find((s: { pubkey: string }) => s.pubkey === C);
  const assessed = (await api.request("GET", `/nodes/assessment?pubkey=${C}`)).body.candidate;
  assert.equal(assessed.score, listed.score);
  assert.equal(assessed.lnplus.rank, 8);
  assert.equal(assessed.peerMinChannelSats, 3_000_000);
});

const RECORD = {
  public_key: "x",
  first_seen: 1_522_941_222,
  city: { en: "Ashburn", de: "Ashburn" },
  country: { en: "United States", de: "Vereinigte Staaten" },
  as_organization: "Amazon.com",
  closed_channel_count: 21_982,
};

test("a node's public record is asked for once, for that node alone, and what it says is checked", async (t) => {
  clearNodeLookupCache();
  const { node, C } = graphSetup();
  const api = await startApi(t, { node });
  api.settings.set({ lnplusLookups: false });
  const http = installFetchMock(t);
  http.on(`https://mempool.space/api/v1/lightning/nodes/${C}`, () => RECORD);

  const res = await api.request("GET", `/nodes/public?pubkey=${C}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.recordState, "ok");
  assert.deepEqual(res.body.record, {
    firstSeenAt: "2018-04-05T15:13:42.000Z",
    country: "United States",
    city: "Ashburn",
    hostedBy: "Amazon.com",
    closedChannels: 21_982,
  });
  assert.equal(res.body.lnplusState, "off");
  // Cached: no second request, and no other node was named.
  await api.request("GET", `/nodes/public?pubkey=${C}`);
  assert.deepEqual(http.requests.map((r) => r.url), [`https://mempool.space/api/v1/lightning/nodes/${C}`]);

  // Junk, a wrong type here and there: nothing invented.
  assert.deepEqual(parsePublicNode({ first_seen: "soon", country: 5, city: null, as_organization: "", closed_channel_count: -1 }), {
    firstSeenAt: null,
    country: null,
    city: null,
    hostedBy: null,
    closedChannels: null,
  });
  assert.deepEqual(parsePublicNode(null).country, null);
});

test("mempool.space not knowing a node is no failure; a failed lookup says so and isn't remembered", async (t) => {
  clearNodeLookupCache();
  const { node } = graphSetup();
  const api = await startApi(t, { node });
  api.settings.set({ lnplusLookups: false });
  const http = installFetchMock(t);
  let answer = () => new Response(JSON.stringify({ error: "Failed to get node" }), { status: 500 });
  const stranger = PK(60);
  http.on(`https://mempool.space/api/v1/lightning/nodes/${stranger}`, () => answer());
  const unknown = (await api.request("GET", `/nodes/public?pubkey=${stranger}`)).body;
  assert.equal(unknown.recordState, "unknown");
  assert.equal(unknown.record, null);

  const other = PK(61);
  let failing = true;
  http.on(`https://mempool.space/api/v1/lightning/nodes/${other}`, () => (failing ? new Response("bad gateway", { status: 502 }) : RECORD));
  const failed = (await api.request("GET", `/nodes/public?pubkey=${other}`)).body;
  assert.equal(failed.recordState, "unavailable");
  assert.match(failed.recordError, /502/);
  failing = false;
  const later = (await api.request("GET", `/nodes/public?pubkey=${other}`)).body;
  assert.equal(later.recordState, "ok", "the next open asks again");
});

test("switched off, no request goes out for a node's public record — and the switch checks its value, and the Privacy card lists it", async (t) => {
  clearNodeLookupCache();
  const { node, C } = graphSetup();
  const api = await startApi(t, { node });
  api.settings.set({ lnplusLookups: false });
  const http = installFetchMock(t);

  assert.equal((await api.request("POST", "/settings", { nodeLookups: "no" })).status, 400);
  const off = await api.request("POST", "/settings", { nodeLookups: false });
  assert.equal(off.body.nodeLookups, false);
  const res = (await api.request("GET", `/nodes/public?pubkey=${C}`)).body;
  assert.equal(res.recordState, "off");
  assert.equal(res.record, null);
  assert.equal(http.requests.length, 0);

  const privacy = (await api.request("GET", "/privacy")).body;
  assert.equal(privacy.nodeLookups, false);
  const row = privacy.destinations.find((d: { what: string }) => /public record/.test(d.what));
  assert.equal(row.service, "mempool.space");
  assert.equal(row.active, false);
});

test("opening a node's details asks nothing of anyone until /nodes/public is called", async (t) => {
  const { node, C } = graphSetup();
  node.override("default.getNodeInfo", (_a, cb) => cb(null, nodeInfo(C, "Candidate Alpha", ["203.0.113.5:9735"], [])));
  const api = await startApi(t, { node });
  api.settings.set({ lnplusLookups: false });
  const http = installFetchMock(t);
  assert.equal((await api.request("GET", `/nodes/detail?pubkey=${C}`)).status, 200);
  assert.equal((await api.request("GET", `/nodes/assessment?pubkey=${C}`)).status, 200);
  assert.equal((await api.request("GET", "/nodes/search?q=alpha")).status, 200);
  assert.equal(http.requests.length, 0, "LND and this app's records only");
});

const meta = (alias: string): NodeMeta => ({ alias, hasClearnet: false, updatedAt: 0, socket: "", sockets: [] });
const stat = (degree: number): NodeStat => ({ degree, totalCapacity: degree * 1_000_000, feeSum: 0, feeCount: 0, recentUpdates: 0, enabledCount: degree, neighbors: new Set() });

test("the search finds a node by part of its alias or the start of its key: an exact match first, then the start of a name, the biggest first", () => {
  const a = "02aa" + "11".repeat(31);
  const b = "02bb" + "22".repeat(31);
  const c = "02cc" + "33".repeat(31);
  const d = "02dd" + "44".repeat(31);
  const graph = {
    meta: new Map([
      [a, meta("Big Alpha Hub")],
      [b, meta("Alpha")],
      [c, meta("alpha small")],
      [d, meta("alpha large")],
    ]),
    stats: new Map([
      [a, stat(500)],
      [b, stat(1)],
      [c, stat(2)],
      [d, stat(9)],
    ]),
  };
  const peers = new Set([d]);
  assert.deepEqual(searchGraph(graph, peers, " ALPHA ").map((h) => h.alias), ["Alpha", "alpha large", "alpha small", "Big Alpha Hub"]);
  assert.equal(searchGraph(graph, peers, "alpha large")[0].isPeer, true);
  // The start of a key, and a whole key@address.
  assert.deepEqual(searchGraph(graph, peers, "02cc33").map((h) => h.pubkey), [c]);
  assert.deepEqual(searchGraph(graph, peers, `${a}@1.2.3.4:9735`).map((h) => h.pubkey), [a]);
  // A short hex string is a name, not a key start.
  assert.deepEqual(searchGraph(graph, peers, "02cc"), []);
  // A whole key nobody announced is still something to look at.
  const stranger = "03" + "ef".repeat(32);
  const hit = searchGraph(graph, peers, stranger);
  assert.deepEqual(hit.map((h) => [h.pubkey, h.channels]), [[stranger, 0]]);
  // Nothing typed; and the list stays short.
  assert.deepEqual(searchGraph(graph, peers, "   "), []);
  const many = { meta: new Map(Array.from({ length: 60 }, (_, i) => [PK(i + 1), meta(`node ${i}`)])), stats: new Map() };
  assert.equal(searchGraph(many, peers, "node").length, NODE_SEARCH_MAX);
});

test("GET /nodes/search answers from the graph, marks your peers, and refuses what can't be a search", async (t) => {
  const { node, P, C } = graphSetup();
  const api = await startApi(t, { node });
  const res = await api.request("GET", "/nodes/search?q=alpha");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.hits.map((h: { pubkey: string }) => h.pubkey)[0], C, "the biggest first");
  assert.equal(res.body.hits[0].channels, 10);
  assert.equal(typeof res.body.graphAgeSec, "number");
  const peer = await api.request("GET", "/nodes/search?q=peer%20one");
  assert.equal(peer.body.hits[0].pubkey, P);
  assert.equal(peer.body.hits[0].isPeer, true);
  assert.equal((await api.request("GET", "/nodes/search?q=a")).status, 400);
  assert.equal((await api.request("GET", "/nodes/search")).status, 400);
  assert.equal((await api.request("GET", `/nodes/search?q=${"x".repeat(301)}`)).status, 400);
});

test("a closing channel keeps its history: its logs are matched by name while it goes by its funding outpoint — unless another peer shares the name", async (t) => {
  const scenario = async (closingPeer: string, otherPeer: string, aliases: Record<string, string>) => {
    const channels: FeeChannel[] = [
      { id: QID, partnerPublicKey: otherPeer, capacity: 2_000_000, localBalance: 1_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
    ];
    const node = feeNode({ blockHeight: HEIGHT, channels });
    node.override("version.getVersion", (_a, cb) => cb(null, { app_minor: 18, app_patch: 5, build_tags: [], commit_hash: "" }));
    node.override("default.getNodeInfo", (a, cb) => {
      const pk = (a as { pub_key: string }).pub_key;
      cb(null, nodeInfo(pk, aliases[pk], [], []));
    });
    node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [] }));
    node.pending.push({ partnerPublicKey: closingPeer, capacity: 5_000_000, transactionId: TX(1), transactionVout: 0, state: "force_closing" });
    const dir = makeTempDir(t);
    const at = new Date(Date.now() - 3_600_000).toISOString();
    const alias = aliases[closingPeer];
    writeFileSync(join(dir, "fee-changes.json"), JSON.stringify([{ at, channelId: PID, alias, fromPpm: 400, toPpm: 430, fromBaseMsat: 0, toBaseMsat: 0, via: "autopilot" }]));
    writeFileSync(
      join(dir, "rebalances.json"),
      JSON.stringify([{ at, via: "autopilot", targetId: PID, targetAlias: alias, sourceId: QID, sourceAlias: aliases[otherPeer], amountSats: 500_000, budgetPpm: 500, feeSats: 120, costPpm: 240, ok: true }]),
    );
    const api = await startApi(t, { node, dir });
    return (await api.request("GET", `/nodes/detail?pubkey=${closingPeer}`)).body;
  };

  const known = await scenario(PK(80), PK(81), { [PK(80)]: "closing one", [PK(81)]: "other one" });
  assert.equal(known.channels[0].status, "pending_close");
  assert.deepEqual(known.events.map((e: { kind: string }) => e.kind).sort(), ["fee", "refill"], "still there while it closes");

  // Another peer goes by the same alias: a name proves nothing, so nothing is claimed.
  const twin = await scenario(PK(82), PK(83), { [PK(82)]: "twin", [PK(83)]: "twin" });
  assert.equal(twin.channels[0].status, "pending_close");
  assert.deepEqual(twin.events, []);
});

test("one open to a node at a time: a second click while the first is dialing is refused, and it is free again afterwards", async (t) => {
  const { node } = setup();
  const peer = PK(70);
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => (release = resolve));
  node.override("default.connectPeer", (a, cb) => {
    void held.then(() => {
      const pk = (a.addr as { pubkey: string }).pubkey;
      if (!node.peers.includes(pk)) node.peers.push(pk);
      cb(null, {});
    });
  });
  const api = await startApi(t, { node });
  const body = { pubkey: peer, socket: "peer70.onion:9735", localTokens: 2_000_000, feeRate: 3 };
  const first = api.request("POST", "/channels/open", body);
  // (Until the first is known to be dialing.)
  for (let i = 0; i < 200 && node.callsTo("default.connectPeer").length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(node.callsTo("default.connectPeer").length > 0, "the first is dialing");

  const second = await api.request("POST", "/channels/open", { ...body, pubkey: peer.toUpperCase() });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, "open_in_flight");
  assert.match(second.body.message, /already under way/);
  // Another node isn't held up.
  const other = await api.request("POST", "/channels/open", { ...body, pubkey: PK(71), localTokens: 1 });
  assert.equal(other.status, 400);

  release();
  const done = await first;
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.ok, true, done.body.error);
  assert.equal(node.callsTo("default.openChannel").length, 1, "one channel funded");

  const again = await api.request("POST", "/channels/open", body);
  assert.notEqual(again.status, 409, "free again");
});

test("the autopilot and a click share the one open under way to a node: the autopilot's open waits while a click is dialing it, and a click is refused while the autopilot opens to it (review 2026-11-10, CHAN-7)", async (t) => {
  const { node } = setup();
  const peer = PK(73);
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => (release = resolve));
  node.override("default.connectPeer", (a, cb) => {
    void held.then(() => {
      const pk = (a.addr as { pubkey: string }).pubkey;
      if (!node.peers.includes(pk)) node.peers.push(pk);
      cb(null, {});
    });
  });
  const api = await startApi(t, { node });
  const body = { pubkey: peer, socket: "peer73.onion:9735", localTokens: 2_000_000, feeRate: 3 };
  const click = api.request("POST", "/channels/open", body);
  for (let i = 0; i < 200 && node.callsTo("default.connectPeer").length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const openTo = (api.autopilot as unknown as { openTo: (w: unknown, s: object, size: number, fee: number) => Promise<{ kind: string; reason?: string }> }).openTo.bind(api.autopilot);
  const auto = await openTo(node.lnd, { pubkey: peer, alias: "peer73", sockets: ["peer73.onion:9735"] }, 2_000_000, 3);
  assert.deepEqual(auto, { kind: "deferred", reason: "deferred: an open to peer73 is already under way (by hand)" });
  release();
  await click;
  assert.equal(node.callsTo("default.openChannel").length, 1, "one channel funded");
  // The reverse: while the autopilot holds it, a click is refused and says by whom.
  assert.equal(api.autopilot.claimOpen(PK(74), "autopilot"), true);
  const refused = await api.request("POST", "/channels/open", { ...body, pubkey: PK(74) });
  assert.deepEqual([refused.status, refused.body.error, refused.body.message], [409, "open_in_flight", "An open to this node is already under way (by the autopilot)."]);
  api.autopilot.releaseOpen(PK(74));
  assert.equal(api.autopilot.openUnderWayBy(PK(74)), null);
});

test("a refused or failed open doesn't leave the node marked as being opened to", async (t) => {
  const { node } = setup();
  node.override("default.connectPeer", (_a, cb) => cb({ details: "dial tcp: i/o timeout" }));
  const api = await startApi(t, { node });
  const peer = PK(72);
  const body = { pubkey: peer, socket: "peer72.onion:9735", localTokens: 2_000_000, feeRate: 3 };
  t.mock.method(console, "warn", () => undefined);
  const first = await api.request("POST", "/channels/open", body);
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, false);
  const second = await api.request("POST", "/channels/open", body);
  assert.notEqual(second.status, 409);
});

test("the Privacy card says LN+ is asked about a node you open", async (t) => {
  const { node } = setup();
  const api = await startApi(t, { node });
  const row = (await api.request("GET", "/privacy")).body.destinations.find((d: { service: string }) => d.service === "lightningnetwork.plus");
  assert.match(row.what, /any node whose details you open/);
});

test("GET /autopilot says the factory settings, for what Advanced measures against", async (t) => {
  const { node } = setup();
  const api = await startApi(t, { node });
  const res = await api.request("GET", "/autopilot");
  assert.equal(res.body.defaults.policy.minPpm, 25);
  assert.equal(res.body.defaults.enabled, false);
  assert.equal(res.body.defaults.sellMaxChannelSats, 2_000_000);
  // The answer to a save says it too.
  const saved = await api.request("POST", "/autopilot", { intervalMinutes: 40 });
  assert.equal(saved.body.config.intervalMinutes, 40);
  assert.equal(saved.body.defaults.intervalMinutes, 30);
});

test("a new install hasn't done its first-start questions; one with anything on disk has — so an update never asks", async (t) => {
  const fresh = await startApi(t, { node: setup().node });
  assert.equal((await fresh.request("GET", "/settings")).body.setupDone, false);
  assert.equal((await fresh.request("POST", "/settings", { setupDone: "yes" })).status, 400);
  const done = await fresh.request("POST", "/settings", { setupDone: true });
  assert.equal(done.body.setupDone, true);

  for (const [file, body] of [
    ["settings.json", { fiatCurrency: "EUR" }],
    ["autopilot.json", {}],
  ] as const) {
    const dir = makeTempDir(t);
    writeFileSync(join(dir, file), JSON.stringify(body));
    const old = await startApi(t, { node: setup().node, dir });
    assert.equal((await old.request("GET", "/settings")).body.setupDone, true, file);
  }
  // Not answered yet, the questions survive a restart — though the autopilot's
  // file exists by then. Answered, they stay answered.
  const dir = makeTempDir(t);
  const first = await startApi(t, { node: setup().node, dir });
  const restarted = await startApi(t, { node: setup().node, dir });
  assert.equal((await restarted.request("GET", "/settings")).body.setupDone, false);
  await first.request("POST", "/settings", { setupDone: true });
  const again = await startApi(t, { node: setup().node, dir });
  assert.equal((await again.request("GET", "/settings")).body.setupDone, true);
});

test("the dashboard counts idle channels: open, online, past the window, outside a lease, and routing nothing — and says nothing when it can't tell", async (t) => {
  const OLD = HEIGHT - 8_640; // 60 days
  const NEW = HEIGHT - 1_440; // 10 days
  const P = (n: number) => PK(90 + n);
  const channels: FeeChannel[] = [
    { id: `${OLD}x1x0`, partnerPublicKey: P(1), capacity: 4_000_000, localBalance: 3_000_000, transactionId: TX(61), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
    { id: `${OLD}x2x0`, partnerPublicKey: P(2), capacity: 4_000_000, localBalance: 2_000_000, transactionId: TX(62), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
    { id: `${NEW}x3x0`, partnerPublicKey: P(3), capacity: 4_000_000, localBalance: 1_000_000, transactionId: TX(63), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 },
  ];
  const node = feeNode({
    blockHeight: HEIGHT,
    channels,
    forwards: [{ at: Date.now() - 60_000, inId: `${NEW}x3x0`, outId: `${OLD}x2x0`, tokens: 100_000, feeMsat: 1_000 }],
  });
  node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [] }));
  node.override("default.getTransactions", (_a, cb) => cb(null, { transactions: [], first_index: "0", last_index: "0" }));
  node.override("default.listPayments", (_a, cb) => cb(null, { payments: [], first_index_offset: "0", last_index_offset: "0" }));
  const api = await startApi(t, { node });
  const http = installFetchMock(t);
  http.on(/./, () => new Response("{}", { status: 503 }));
  api.settings.set({ lnplusLookups: false });
  const res = await api.request("GET", "/dashboard");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.idleChannels, { count: 1, localSats: 3_000_000 }, "only the old one no forward used");
});

test("a close whose fee the peer refuses isn't called failed: LND goes on with it, so nobody is sent to force-close", async (t) => {
  const { node } = setup();
  const api = await startApi(t, { node });
  const close = { transactionId: TX(1), transactionVout: 0, isForce: false, feeRate: 2 };
  // LND's words, as seen on regtest (0.21).
  node.closeFailure = "unable to process close msg: latest fee proposal exceeds max fee: 0.00000933 BTC > 0.00000900 BTC";
  const refused = await api.request("POST", "/channels/close", close);
  assert.equal(refused.status, 200);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.stillClosing, true);
  // No fee estimate from LND: LND's own rule, up to three times the rate.
  assert.match(refused.body.error, /^The peer wants more than three times the fee you chose/);
  assert.match(refused.body.error, /shutting down all the same/);
  assert.match(refused.body.error, /Wait for it\./);
  // With one: the close's maximum (three times 2, below 3× the next block's 12).
  node.override("wallet.estimateFee", (a, cb) => cb(null, { sat_per_kw: String(Number(a.conf_target) <= 1 ? 3000 : 500), min_relay_fee_sat_per_kw: "253" }));
  const capped = await api.request("POST", "/channels/close", close);
  assert.equal(capped.body.stillClosing, true);
  assert.match(capped.body.error, /^The peer wants more than 6 sat\/vB, the most this close may pay, so this round ended/);
  assert.match(capped.body.error, /Wait for it\./);
  // Any other failure is one.
  node.closeFailure = "peer is offline";
  const other = await api.request("POST", "/channels/close", close);
  assert.equal(other.body.ok, false);
  assert.equal(other.body.stillClosing, undefined);
  assert.match(other.body.error, /peer is offline/);
});

test("a node that has run before never gets the first-start questions, whatever is left of its files", async (t) => {
  for (const file of ["settings.json.bak", "autopilot.json.bak", "autopilot.json.corrupt-1731150000"]) {
    const dir = makeTempDir(t);
    writeFileSync(join(dir, file), "{}");
    const api = await startApi(t, { node: setup().node, dir });
    assert.equal((await api.request("GET", "/settings")).body.setupDone, true, file);
  }
});

test("a channel the operator set aside isn't called idle", async (t) => {
  const OLD = HEIGHT - 8_640;
  const P = PK(97);
  const channels: FeeChannel[] = [{ id: `${OLD}x1x0`, partnerPublicKey: P, capacity: 4_000_000, localBalance: 3_000_000, transactionId: TX(71), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 }];
  const node = feeNode({ blockHeight: HEIGHT, channels });
  node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [] }));
  node.override("default.getTransactions", (_a, cb) => cb(null, { transactions: [], first_index: "0", last_index: "0" }));
  node.override("default.listPayments", (_a, cb) => cb(null, { payments: [], first_index_offset: "0", last_index_offset: "0" }));
  const api = await startApi(t, { node });
  const http = installFetchMock(t);
  http.on(/./, () => new Response("{}", { status: 503 }));
  api.settings.set({ lnplusLookups: false });
  assert.deepEqual((await api.request("GET", "/dashboard")).body.idleChannels, { count: 1, localSats: 3_000_000 });
  await api.request("POST", "/overrides", { channelId: `${OLD}x1x0`, mode: "exclude" });
  assert.deepEqual((await api.request("GET", "/dashboard")).body.idleChannels, { count: 0, localSats: 0 });
});
