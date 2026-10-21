/**
 * The channel autopilot (review a3-channels:auto-open-stuck-on-top1,
 * a3-channels:open-fee-gate-too-loose, a3-channels:history-flood — package P4).
 *
 * Before:
 *  - only suggestion #1 was looked at. A peer that refused (its minimum
 *    channel size — 22 of 50 LN+ pool nodes ask more than 1M —, no address,
 *    offline) was asked again every 30 minutes, forever; nothing else was
 *    tried, and a top pick bigger than the wallet ended the stage silently;
 *  - only one address was ever dialed (clearnet whenever there was one);
 *  - an open paid LND's 6-block fee rate and passed whenever that stayed under
 *    1 % of the channel: 114 sat/vB for a 2M channel, years of its income;
 *  - every deferral and refusal was a failed run: up to 48 a day in a 50-run
 *    history.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getChannelSuggestionsV2, type SuggestionV2 } from "../src/services/suggestRecommend.js";
import {
  MIN_YIELD_EARNED_SAT,
  MIN_YIELD_FORWARDS,
  OPEN_CONF_TARGET,
  PEER_BACKOFF_DAYS,
  measuredYield,
  openAndCloseCost,
  planOpen,
  type OpenContext,
  type PeerOpenRecord,
} from "../src/services/openPlan.js";
import { isPreBroadcastRefusal, nodeSideRefusal, peerMaxChannelFromError, peerMinChannelFromError } from "../src/services/channelOps.js";
import { LnPlusStore } from "../src/services/lnplusStore.js";
import { GOSSIP_PEER, autopilotWith, suggestion, type AutopilotSeams } from "./helpers/autopilot.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { chanNumber, feeNode, forwardsOut } from "./helpers/feeNode.js";
import { makeTempDir } from "./helpers/tmp.js";
import { startApi } from "./helpers/apiHarness.js";
import { installFetchMock } from "./helpers/fetchMock.js";

const DAY = 86_400_000;
const PK = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);

// ── the planner ──────────────────────────────────────────────────────────────

const cand = (o: Partial<SuggestionV2> = {}) =>
  ({
    pubkey: PK(1),
    alias: "peer-1",
    socket: "aaaa.onion:9735",
    sockets: ["aaaa.onion:9735"],
    recommendedSizeSats: 2_000_000,
    usefulness: "high",
    lnplus: null,
    peerMinChannelSats: null,
    closedDaysAgo: null,
    ...o,
  }) as SuggestionV2;
const ctx = (o: Partial<OpenContext> = {}): OpenContext => ({
  fixedSize: null,
  spendableSat: 10_000_000,
  feeRate: 2,
  yieldPpmYear: null,
  maxRaiseSat: 6_000_000,
  peers: {},
  connected: new Set(),
  neverOpen: new Set(),
  nowMs: Date.parse("2026-10-21T12:00:00.000Z"),
  ...o,
});
const refusal = (o: Partial<PeerOpenRecord> = {}): PeerOpenRecord => ({
  alias: "peer-1",
  fails: 1,
  lastAt: "2026-10-21T08:00:00.000Z",
  retryAt: "2026-10-22T08:00:00.000Z",
  error: "couldn't connect to 020101010101… — the peer looks offline. Try again later.",
  ...o,
});

test("planOpen: which suggestion the autopilot opens to, at what size — or why not", () => {
  assert.deepEqual(planOpen(cand(), ctx()), { sizeSats: 2_000_000, why: null });
  assert.deepEqual(planOpen(cand({ usefulness: "low" }), ctx()), { skip: "low usefulness" });
  assert.match(
    (planOpen(cand({ lnplus: { rank: 3, rankName: "", prime: false, verified: false, positiveRatings: 1, negativeRatings: 4, profileUrl: "", scoreEffectPct: -10 } }), ctx()) as { skip: string }).skip,
    /^LN\+ operators rate it poorly \(1 positive, 4 negative\)$/,
  );
  assert.match((planOpen(cand({ closedDaysAgo: 30 }), ctx()) as { skip: string }).skip, /^you closed a channel with it 30 days ago \(not reopened within 90 days\)$/);
  assert.deepEqual(planOpen(cand({ closedDaysAgo: null }), ctx()), { sizeSats: 2_000_000, why: null });
  // A refusal waits out its back-off …
  assert.match(
    (planOpen(cand(), ctx({ peers: { [PK(1)]: refusal() } })) as { skip: string }).skip,
    /^refused an open \(couldn't connect to 020101010101… — the peer looks offline\. Try again later\.\) — tried again in ~20 h$/,
  );
  // … and is tried again after it.
  assert.deepEqual(planOpen(cand(), ctx({ peers: { [PK(1)]: refusal({ retryAt: "2026-10-21T11:00:00.000Z" }) } })), { sizeSats: 2_000_000, why: null });
  // The operator's "never open automatically" list.
  assert.deepEqual(planOpen(cand(), ctx({ neverOpen: new Set([PK(1)]) })), { skip: "you marked it “never open automatically”" });
  // No address: only while connected.
  assert.match((planOpen(cand({ socket: "", sockets: [] }), ctx()) as { skip: string }).skip, /^it advertises no address to dial/);
  assert.deepEqual(planOpen(cand({ socket: "", sockets: [] }), ctx({ connected: new Set([PK(1)]) })), { sizeSats: 2_000_000, why: null });
});

test("planOpen: the peer's minimum is met — auto size rises to it (up to a third of the node's capital), a fixed size never does; a maximum it named is met too", () => {
  // LN+ says 5M: auto size rises.
  assert.deepEqual(planOpen(cand({ peerMinChannelSats: 5_000_000 }), ctx()), { sizeSats: 5_000_000, why: "sized up to its 5,000,000 sat minimum" });
  // A refusal named 0.025 BTC: rounded up to the next 100k.
  assert.deepEqual(planOpen(cand(), ctx({ peers: { [PK(1)]: refusal({ retryAt: "2026-10-21T08:00:00.000Z", minChannelSats: 2_500_000 }) } })), {
    sizeSats: 2_500_000,
    why: "sized up to its 2,500,000 sat minimum",
  });
  assert.match((planOpen(cand({ peerMinChannelSats: 8_000_000 }), ctx()) as { skip: string }).skip, /^it takes channels of at least 8,000,000 sat — more than a third of the node's capital \(6,000,000 sat\)$/);
  assert.match((planOpen(cand({ peerMinChannelSats: 5_000_000 }), ctx({ fixedSize: 1_000_000 })) as { skip: string }).skip, /^it takes channels of at least 5,000,000 sat — your channel size is 1,000,000$/);
  assert.deepEqual(planOpen(cand(), ctx({ peers: { [PK(1)]: refusal({ retryAt: "2026-10-21T08:00:00.000Z", maxChannelSats: 1_677_721 }) } })), {
    sizeSats: 1_600_000,
    why: "sized down to its 1,677,721 sat maximum",
  });
  // Bigger than the wallet: says so (before: silence).
  assert.match((planOpen(cand(), ctx({ spendableSat: 1_400_000 })) as { skip: string }).skip, /^needs 2,000,000 sat — 1,400,000 spendable after the reserve and the coins promised to buyers$/);
});

test("planOpen: the open and its later close must pay back within 12 months of what a channel earns here — the finding's 2M channel at 100 sat/vB doesn't; at 2 sat/vB it does; with no routing income measured only the fee cap applies", () => {
  // 2M at 1,000 ppm/yr earns 2,000 sat a year.
  const at100 = planOpen(cand(), ctx({ feeRate: 100, yieldPpmYear: 1_000 })) as { skip: string };
  assert.equal(openAndCloseCost(100), 32_500);
  assert.match(at100.skip, /^opening and later closing it costs ~32,500 sat at 100 sat\/vB — ~195 months of what a 2,000,000 sat channel earns here \(1,000 ppm\/yr: what a sat in month-old channels earned, capacity-weighted\)/);
  assert.deepEqual(planOpen(cand(), ctx({ feeRate: 2, yieldPpmYear: 1_000 })), { sizeSats: 2_000_000, why: null }, "650 sat: ~4 months");
  assert.deepEqual(planOpen(cand(), ctx({ feeRate: 100, yieldPpmYear: null })), { sizeSats: 2_000_000, why: null }, "no income to measure against");
  // Measured (enough routing behind it) at zero: no fee rate helps — said so.
  assert.equal(
    (planOpen(cand(), ctx({ feeRate: 2, yieldPpmYear: 0 })) as { skip: string }).skip,
    "month-old channels here earned nothing in 30 days (0 ppm/yr: what a sat in month-old channels earned, capacity-weighted) — opening and later closing it (~650 sat at 2 sat/vB) would never pay back",
  );
});

test("a peer's size limits are read from LND's refusal — btcutil amounts in BTC, or sats", () => {
  assert.equal(peerMinChannelFromError("FailedToOpenChannel: received funding error from 02ab…: chan size of 0.01 BTC is below min chan size of 0.05 BTC"), 5_000_000);
  assert.equal(peerMinChannelFromError("chan size of 1000000 sat is below min chan size of 2000000 sat"), 2_000_000);
  assert.equal(peerMaxChannelFromError("chan size of 0.2 BTC exceeds maximum chan size of 0.16777215 BTC"), 16_777_215);
  assert.equal(peerMinChannelFromError("PeerIsNotOnline"), null);
});

// ── the suggestion engine's new fields ─────────────────────────────────────────

/** A node with one channel (to P) and a public graph in which C — ten
 *  channels to nodes this node doesn't reach — is a candidate. */
function graphNode() {
  const node = new FakeLnd({ chainBalance: 5_000_000, blockHeight: 860_000 });
  const me = node.publicKey;
  const P = PK(1);
  const C = PK(2);
  node.channels.push({ id: "850000x1x0", partnerPublicKey: P, capacity: 2_000_000, localBalance: 1_000_000, transactionId: "11".repeat(32), transactionVout: 0 });
  const nowSec = Math.floor(Date.now() / 1000);
  const pol = { disabled: false, fee_base_msat: "0", fee_rate_milli_msat: "200", last_update: nowSec - 3_600, max_htlc_msat: "990000000", min_htlc: "1000", time_lock_delta: 40 };
  const edge = (n: number, a: string, b: string) => ({
    capacity: "5000000",
    chan_point: `${n.toString(16).padStart(64, "0")}:0`,
    channel_id: chanNumber(`840000x${n}x0`),
    node1_pub: a,
    node2_pub: b,
    node1_policy: pol,
    node2_policy: pol,
  });
  // C: 10 channels to nodes we don't reach — a candidate; P: our peer.
  const edges = [edge(1, me, P), ...Array.from({ length: 10 }, (_, i) => edge(10 + i, C, PK(100 + i)))];
  const nodeInfo = (pk: string, alias: string, addrs: string[]) => ({
    pub_key: pk,
    alias,
    addresses: addrs.map((addr) => ({ network: "tcp", addr })),
    last_update: nowSec - 3_600,
    color: "#000000",
    features: {},
  });
  node.override("default.describeGraph", (_a, cb) =>
    cb(null, { edges, nodes: [nodeInfo(C, "candidate", ["203.0.113.5:9735", "candidateonionaddress.onion:9735"]), nodeInfo(P, "peer", [])] }),
  );
  return { node, me, C };
}

test("suggestions carry every address in dialing order (.onion first on a Tor-only node), the peer's LN+ minimum and a recent close", async (t) => {
  const { node, me, C } = graphNode();
  // Closed with C ten days ago — and, long before, a funding that never
  // confirmed (no close height: it can't be dated, so it doesn't count).
  const closedWithC = (closeHeight: number, n: number) => ({
    alias_scids: [], capacity: "1000000", chan_id: chanNumber(`850000x${n}x0`), channel_point: `${n.toString(16).padStart(64, "0")}:0`,
    close_height: closeHeight, closing_tx_hash: "98".repeat(32), remote_pubkey: C, settled_balance: "990000",
    time_locked_balance: "0", close_type: closeHeight ? "COOPERATIVE_CLOSE" : "FUNDING_CANCELED", open_initiator: "INITIATOR_LOCAL",
    close_initiator: "INITIATOR_LOCAL", resolutions: [], zero_conf_confirmed_scid: "0",
  });
  let closes = [closedWithC(0, 8)];
  node.override("default.closedChannels", (_a, cb) => cb(null, { channels: closes }));
  // LN+ knows C: it takes channels of at least 3M (cached — no network).
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "lnplus-nodes.json"),
    JSON.stringify({
      nodes: {
        [C]: {
          at: Date.now(),
          node: { pubkey: C, alias: "candidate", rank: 5, rankName: "", prime: false, pro: false, verified: false, positiveRatings: 3, negativeRatings: 0, positiveGiven: 0, negativeGiven: 0, badges: [], openChannels: 10, capacitySats: 50_000_000, minChannelSizeSats: 3_000_000, profileUrl: "" },
        },
      },
      calls: [],
    }),
  );
  const undated = await getChannelSuggestionsV2(node.lnd, { minChannels: 8 });
  assert.equal(undated.suggestions.find((s) => s.pubkey === C)?.closedDaysAgo, null, "an undated close bars no peer for good");
  closes = [closedWithC(0, 8), closedWithC(860_000 - 1_440, 9)];
  const report = await getChannelSuggestionsV2(node.lnd, { minChannels: 8 }, new LnPlusStore(dir));
  const c = report.suggestions.find((s) => s.pubkey === C);
  assert.ok(c, JSON.stringify(report.suggestions.map((s) => s.alias)));
  // The fake node announces a .onion URI only: Tor-only.
  assert.deepEqual(c.sockets, ["candidateonionaddress.onion:9735", "203.0.113.5:9735"]);
  assert.equal(c.socket, "candidateonionaddress.onion:9735");
  assert.equal(c.peerMinChannelSats, 3_000_000);
  assert.equal(c.closedDaysAgo, 10);
  assert.ok(c.warnings.some((w) => /^You closed a channel with this node 10 days ago — the autopilot doesn't reopen to it within 90 days\.$/.test(w)), c.warnings.join(" | "));
  // A node that announces a clearnet address dials clearnet first.
  node.uris = [`${me}@198.51.100.7:9735`];
  const clearnet = await getChannelSuggestionsV2(node.lnd, { minChannels: 8 });
  assert.deepEqual(clearnet.suggestions.find((s) => s.pubkey === C)?.sockets, ["203.0.113.5:9735", "candidateonionaddress.onion:9735"]);
});

// ── the stage ────────────────────────────────────────────────────────────────

type State = {
  state: { lastChannelOpenAt: string | null; lastChannelOpenUnclear?: string | null; peerOpenFailures?: Record<string, PeerOpenRecord> };
};
const pubkeyOf = (args: Record<string, unknown>) => Buffer.from(args.node_pubkey as Buffer).toString("hex");

function stage(t: Parameters<typeof autopilotWith>[0], config: Record<string, unknown> = {}) {
  const env = autopilotWith(t, { channelEnabled: true, channelCooldownMinutes: 360, ...config });
  env.seams.openFeeRate = async () => 2;
  // No forwards yet (and no channel a month old): only the fee cap applies.
  env.node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  const books = (env.autopilot as unknown as State).state;
  /** The cooldown after an open has passed. */
  const later = () => {
    books.lastChannelOpenAt = new Date(Date.now() - 400 * 60_000).toISOString();
  };
  const opened = () => env.node.callsTo("default.openChannel").map((a) => [pubkeyOf(a), Number(a.local_funding_amount)]);
  return { ...env, books, later, opened };
}

test("a peer that refuses below its minimum: the next suggestion opens in the same run, and the next run opens to the first at the size it named", async (t) => {
  const s = stage(t);
  const A = { ...suggestion, pubkey: PK(1), alias: "picky" };
  const B = { ...suggestion, pubkey: PK(2), alias: "easy" };
  s.seams.channelSuggestions = async () => ({ suggestions: [A, B] });
  s.node.beforeCall = (method, args) => {
    if (method !== "default.openChannel") return;
    s.node.openFailure =
      pubkeyOf(args) === A.pubkey && Number(args.local_funding_amount) < 5_000_000
        ? `received funding error from ${A.pubkey}: chan size of 0.02 BTC is below min chan size of 0.05 BTC`
        : null;
  };
  const run = await s.autopilot.runOnce();
  assert.deepEqual(s.opened(), [[A.pubkey, 2_000_000], [B.pubkey, 2_000_000]]);
  assert.deepEqual(run.channels.map((c) => [c.alias, c.ok]), [["picky", false], ["easy", true]]);
  assert.match(run.channels[0].error ?? "", /below min chan size of 0\.05 BTC/);
  assert.equal(s.books.peerOpenFailures?.[A.pubkey]?.minChannelSats, 5_000_000);
  // (No channel a month old: only the fee cap applied — the note says so.)
  assert.match(
    s.autopilot.getState().decisions.channels?.text ?? "",
    /^opened 2,000,000 sat to easy at 2 sat\/vB — no payback check: no channel is a month old yet, so what a channel earns here can't be measured$/,
  );

  // After the cooldown: auto size meets picky's minimum (a third of 20M is 6.7M).
  s.later();
  s.seams.channelSuggestions = async () => ({ suggestions: [A] });
  const next = await s.autopilot.runOnce();
  assert.deepEqual(s.opened().slice(2), [[A.pubkey, 5_000_000]]);
  assert.equal(next.channels[0]?.ok, true);
  assert.match(s.autopilot.getState().decisions.channels?.text ?? "", /^opened 5,000,000 sat to picky at 2 sat\/vB \(sized up to its 5,000,000 sat minimum\) — no payback check: /);
  assert.equal(s.books.peerOpenFailures?.[A.pubkey], undefined, "a successful open forgets the refusal");
});

test("an unreachable peer backs off 1 day, then 7, then 30 — and its repeated identical failure is one line of history, not one per run", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const s = stage(t);
  const gone = { ...suggestion, pubkey: PK(3), alias: "gone", sockets: ["goneonion.onion:9735"] };
  s.seams.channelSuggestions = async () => ({ suggestions: [gone] });
  s.node.override("default.connectPeer", (_a, cb) => cb({ details: "dial tcp: i/o timeout" }));
  const first = await s.autopilot.runOnce();
  assert.deepEqual(first.channels.map((c) => [c.alias, c.ok]), [["gone", false]]);
  assert.match(first.channels[0].error ?? "", /couldn't connect/);
  const rec = () => s.books.peerOpenFailures?.[gone.pubkey] as PeerOpenRecord;
  const waits = () => Math.round((Date.parse(rec().retryAt) - Date.parse(rec().lastAt)) / DAY);
  assert.deepEqual([rec().fails, waits()], [1, PEER_BACKOFF_DAYS[0]]);

  // The next run (a minute later): not dialed — and no failed run either.
  const second = await s.autopilot.runOnce();
  assert.deepEqual(second.channels, []);
  assert.equal(s.node.callsTo("default.connectPeer").length, 1, "not asked again inside its back-off");
  assert.match(s.autopilot.getState().decisions.channels?.text ?? "", /^no channel opened — gone: refused an open \(couldn't connect to .*\) — tried again in ~\d+ h$/);

  // After the day: tried, refused again → 7 days; then → 30 days.
  for (const [n, days] of [[2, PEER_BACKOFF_DAYS[1]], [3, PEER_BACKOFF_DAYS[2]]] as const) {
    rec().retryAt = new Date(Date.now() - 1).toISOString();
    const run = await s.autopilot.runOnce();
    assert.deepEqual([rec().fails, waits()], [n, days]);
    assert.deepEqual(run.channels, [], "the same failure again is not a new line in the run history");
  }
  assert.equal(s.autopilot.getState().history.length, 1, "one line for three identical failures");
});

test("opens pay LND's economy rate (a 72-block target) at or below the operator's maximum (20 sat/vB by default) — above it they wait, and say so without a failed run; the channel starts at the fee engine's protected fee", async (t) => {
  const s = stage(t);
  // The real fee lookup this time: LND's estimate for the target asked.
  delete (s.seams as Partial<AutopilotSeams>).openFeeRate;
  const asked: number[] = [];
  let satPerKw = 6_250; // 25 sat/vB
  s.node.override("wallet.estimateFee", (a, cb) => {
    asked.push(Number(a.conf_target));
    cb(null, { sat_per_kw: String(satPerKw) });
  });
  s.node.peers.push(suggestion.pubkey);
  s.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  const expensive = await s.autopilot.runOnce();
  assert.ok(asked.includes(OPEN_CONF_TARGET), `asked ${asked.join(",")}`);
  assert.deepEqual(expensive.channels, []);
  assert.equal(s.autopilot.getState().history.length, 0, "a deferral is not a failed run");
  assert.equal(s.opened().length, 0);
  assert.match(s.autopilot.getState().decisions.channels?.text ?? "", /^on-chain fees are 25 sat\/vB at the economy rate — above your 20 sat\/vB maximum for opens; waiting for cheaper fees$/);

  satPerKw = 1_000; // 4 sat/vB
  await s.autopilot.runOnce();
  const [open] = s.node.callsTo("default.openChannel");
  assert.equal(Number(open.sat_per_vbyte), 4, "the economy rate, not LND's 6-block default");
  assert.equal(open.target_conf, undefined);
  // The protected fee the fee engine gives a new channel (80 ppm) and the policy's base fee.
  assert.deepEqual([open.use_fee_rate, Number(open.fee_rate), open.use_base_fee], [true, 80, true]);
});

test("the payback: a month-old channel that earned ~12,000 ppm/yr lets a 1M open through at 20 sat/vB (~6 months), not at 40 (~13 months) — and says why", async (t) => {
  const height = 860_000;
  const node = feeNode({
    blockHeight: height,
    chainBalance: 20_000_000,
    channels: [{ id: "850000x1x0", partnerPublicKey: PK(9), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "99".repeat(32), transactionVout: 0 }],
    // 2,000 sat earned in 30 days on 2M: ~12,167 ppm/yr.
    forwards: forwardsOut("850000x1x0", "850000x1x0", 10, { tokens: 1_000_000, feeMsat: 200_000, days: 20 }),
  });
  const env = autopilotWith(t, { channelEnabled: true, channelSizeSats: 1_000_000, channelMaxFeeRate: 50 }, {}, {}, node);
  const economics = await env.autopilot.openEconomics();
  assert.equal(economics?.ppmYear, 12_167);
  env.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  node.peers.push(suggestion.pubkey);
  // 20 sat/vB: open + close 6,500 sat against ~12,167 sat a year for 1M — ~6 months: fine;
  // 40 sat/vB: 13,000 sat — ~13 months: waits.
  env.seams.openFeeRate = async () => 40;
  await env.autopilot.runOnce();
  assert.equal(node.callsTo("default.openChannel").length, 0);
  assert.match(
    env.autopilot.getState().decisions.channels?.text ?? "",
    /opening and later closing it costs ~13,000 sat at 40 sat\/vB — ~13 months of what a 1,000,000 sat channel earns here \(12,167 ppm\/yr: what a sat in month-old channels earned, capacity-weighted\)/,
  );
  env.seams.openFeeRate = async () => 20;
  await env.autopilot.runOnce();
  assert.equal(node.callsTo("default.openChannel").length, 1);
});

test("the operator's 'never open automatically' list: the stage passes such a peer over for the next one; the suggestions say which are on it", async (t) => {
  const s = stage(t);
  const vetoed = { ...suggestion, pubkey: PK(5), alias: "vetoed" };
  const next = { ...suggestion, pubkey: PK(6), alias: "next" };
  s.seams.channelSuggestions = async () => ({ suggestions: [vetoed, next] });
  s.autopilot.setNeverOpen(vetoed.pubkey, true, "vetoed");
  await s.autopilot.runOnce();
  assert.deepEqual(s.opened(), [[next.pubkey, 2_000_000]]);
  assert.deepEqual(Object.keys(s.autopilot.neverOpenPeers()), [vetoed.pubkey]);
  s.autopilot.setNeverOpen(vetoed.pubkey, false);
  assert.deepEqual(s.autopilot.neverOpenPeers(), {});
});

test("one run dials at most three peers, and starts no new dial once two minutes went into dialing — the main run's lock isn't held for long", async (t) => {
  const s = stage(t);
  const slow = { ...suggestion, pubkey: PK(10), alias: "slow", sockets: ["slowpeer.onion:9735"] };
  const next = { ...suggestion, pubkey: PK(11), alias: "next", sockets: ["nextpeer.onion:9735"] };
  s.seams.channelSuggestions = async () => ({ suggestions: [slow, next] });
  const realNow = Date.now.bind(Date);
  let skew = 0;
  t.mock.method(Date, "now", () => realNow() + skew);
  const dialed: string[] = [];
  s.node.override("default.connectPeer", (a, cb) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    dialed.push(pk);
    if (pk === slow.pubkey) skew += 130_000; // its dial took over two minutes (Tor)
    cb({ details: "dial tcp: i/o timeout" });
  });
  await s.autopilot.runOnce();
  assert.deepEqual([...new Set(dialed)], [slow.pubkey], "no second dial after the budget");
  // Three peers at most, however quick each refusal.
  const many = [12, 13, 14, 15].map((n) => ({ ...suggestion, pubkey: PK(n), alias: `p${n}`, sockets: [`p${n}.onion:9735`] }));
  s.seams.channelSuggestions = async () => ({ suggestions: many });
  skew = 0;
  dialed.length = 0;
  s.node.override("default.connectPeer", (a, cb) => {
    dialed.push((a.addr as { pubkey: string }).pubkey);
    cb({ details: "dial tcp: i/o timeout" });
  });
  await s.autopilot.runOnce();
  assert.deepEqual([...new Set(dialed)], many.slice(0, 3).map((m) => m.pubkey));
});

test("GET /suggestions says which peers are on the operator's 'never open automatically' list", async (t) => {
  const { node, C } = graphNode();
  // LN+ is asked about the shortlist: it has no profile for C (422).
  const http = installFetchMock(t);
  http.on(/^https:\/\/lightningnetwork\.plus\/api\/2\/get_node\//, () => new Response("{}", { status: 422 }));
  const api = await startApi(t, { node });
  const flag = async () => ((await api.request("GET", "/suggestions?minChannels=8")).body.suggestions as { pubkey: string; neverOpen?: boolean }[]).find((s) => s.pubkey === C)?.neverOpen;
  assert.equal(await flag(), false);
  await api.request("POST", "/channels/never-open", { pubkey: C, never: true, alias: "candidate" });
  assert.equal(await flag(), true);
});

test("POST /channels/never-open keeps the operator's list (a preference — no node write)", async (t) => {
  const api = await startApi(t);
  const on = await api.request("POST", "/channels/never-open", { pubkey: PK(7), never: true, alias: "spammy" });
  assert.equal(on.status, 200);
  assert.equal(on.body.neverOpen[PK(7)]?.alias, "spammy");
  assert.equal((await api.request("POST", "/channels/never-open", { pubkey: "nope", never: true })).status, 400);
  assert.equal((await api.request("POST", "/channels/never-open", { pubkey: PK(7), never: "yes" })).status, 400);
  const off = await api.request("POST", "/channels/never-open", { pubkey: PK(7), never: false });
  assert.deepEqual(off.body.neverOpen, {});
});

test("nothing silent: a top pick bigger than the wallet, the cooldown and an empty wallet each leave a decision note — and no failed run", async (t) => {
  const s = stage(t);
  s.node.chainBalance = 1_500_000;
  s.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  const run = await s.autopilot.runOnce();
  assert.deepEqual(run.channels, []);
  assert.match(s.autopilot.getState().decisions.channels?.text ?? "", /^no channel opened — next-peer: needs 2,000,000 sat — 1,4\d\d,\d{3} spendable after the reserve/);
  s.node.chainBalance = 0;
  await s.autopilot.runOnce();
  assert.match(s.autopilot.getState().decisions.channels?.text ?? "", /^nothing to open with: 0 sat on chain/);
  s.books.lastChannelOpenAt = new Date().toISOString();
  await s.autopilot.runOnce();
  assert.match(s.autopilot.getState().decisions.channels?.text ?? "", /^a channel was opened 0 min ago — the next open waits for the 360-minute cooldown$/);
  assert.equal(s.autopilot.getState().history.length, 0);
});

// ── this node's own refusals (review of P4) ─────────────────────────────────
//
// Before: every refusal was booked against the peer the open was meant for —
// also LND's wallet not being synced, too few confirmed coins, or this node
// having lost its own connection. Each run dialed up to three more good peers
// and backed each off for a day, then a week, then 30 days, with a failed-run
// line apiece: while the wallet synced, four runs used up all ten suggestions
// (ten history lines), and the note said they "refused an open".

/** Three suggestions, all good. */
const trio = () => [21, 22, 23].map((n) => ({ ...suggestion, pubkey: PK(n), alias: `good-${n}`, sockets: [`good${n}.onion:9735`] }));

test("LND's own wallet refusing — still syncing, or too few confirmed coins — is not the peer's doing: one open tried, no peer held back, one line of history while it lasts", async (t) => {
  for (const [lndText, says] of [
    // LND's own texts: the library names the first WalletNotFullySynced and
    // passes the second on as InsufficientFundsToCreateChannel.
    ["channels cannot be created before the wallet is fully synced", /^LND's wallet isn't fully synced to the chain yet: the open to good-21 failed \(WalletNotFullySynced\), not by the peer's doing — no peer is held back for it, and the next run tries again$/],
    ["not enough witness outputs to create funding transaction, need 0.02 BTC only have 0.015 BTC available", /^LND's wallet can't fund it \(not enough confirmed coins\): the open to good-21 failed \(not enough witness outputs/],
  ] as const) {
    const s = stage(t);
    const peers = trio();
    s.seams.channelSuggestions = async () => ({ suggestions: peers });
    s.node.openFailure = lndText;
    for (let run = 1; run <= 3; run++) {
      await s.autopilot.runOnce();
      assert.equal(s.node.callsTo("default.openChannel").length, run, `${lndText}: one open tried per run, no further candidate`);
      assert.deepEqual(s.books.peerOpenFailures ?? {}, {}, `${lndText}: no peer is held back for it`);
      const text = s.autopilot.getState().decisions.channels?.text ?? "";
      assert.match(text.replace(/^no channel opened — /, ""), says, text);
    }
    const history = s.autopilot.getState().history;
    assert.equal(history.length, 1, `${lndText}: one line of history over three runs`);
    assert.deepEqual(history[0].channels.map((c) => [c.alias, c.ok]), [["good-21", false]]);
    assert.match(history[0].channels[0].error ?? "", /— not the peer's doing \(/);
    // Fixed (the wallet synced, coins confirmed): the top pick opens — it
    // was never backed off.
    s.node.openFailure = null;
    await s.autopilot.runOnce();
    assert.deepEqual(s.opened().at(-1), [peers[0].pubkey, 2_000_000]);
    assert.match(s.autopilot.getState().decisions.channels?.text ?? "", /^opened 2,000,000 sat to good-21/);
  }
});

test("this node's trouble is one line while it lasts — and news again once the node was fine in between (a peer's own refusal, or an open)", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const s = stage(t);
  const [A, B, C] = trio();
  // The run history's channel lines, oldest first.
  const lines = () => [...s.autopilot.getState().history].reverse().flatMap((r) => r.channels).map((c) => `${c.alias}:${c.ok}`);
  const unsynced = "channels cannot be created before the wallet is fully synced";
  const normalDial = (a: Record<string, unknown>, cb: (err: unknown, res?: unknown) => void) => {
    const pk = (a.addr as { pubkey: string }).pubkey;
    if (!s.node.peers.includes(pk)) s.node.peers.push(pk);
    cb(null, {});
  };
  s.seams.channelSuggestions = async () => ({ suggestions: [A] });
  s.node.openFailure = unsynced;
  await s.autopilot.runOnce();
  await s.autopilot.runOnce();
  assert.deepEqual(lines(), ["good-21:false"], "one line for two runs");
  // The wallet is fine meanwhile; B itself can't be reached (other peers are
  // connected): B's own line — and the node was evidently fine.
  s.node.openFailure = null;
  s.seams.channelSuggestions = async () => ({ suggestions: [B] });
  s.node.override("default.connectPeer", (_a, cb) => cb({ details: "dial tcp: i/o timeout" }));
  await s.autopilot.runOnce();
  // The wallet trouble is back: news again.
  s.node.override("default.connectPeer", normalDial);
  s.seams.channelSuggestions = async () => ({ suggestions: [C] });
  s.node.openFailure = unsynced;
  await s.autopilot.runOnce();
  assert.deepEqual(lines(), ["good-21:false", "good-22:false", "good-23:false"]);
  // An open goes through — and the next trouble of this node's own is news again too.
  s.node.openFailure = null;
  await s.autopilot.runOnce();
  s.later();
  s.seams.channelSuggestions = async () => ({ suggestions: [A] });
  s.node.openFailure = unsynced;
  await s.autopilot.runOnce();
  assert.deepEqual(lines(), ["good-21:false", "good-22:false", "good-23:false", "good-23:true", "good-21:false"]);
});

test("a node connected to no peer at all dials nobody and holds nobody back; one that loses its connection mid-run stops at the first peer it can't reach — not that peer's doing", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  // Nobody connected (Tor or the internet down): no dial, no back-off, no failed run.
  const off = stage(t);
  off.node.peers.length = 0;
  off.seams.channelSuggestions = async () => ({ suggestions: trio() });
  const run = await off.autopilot.runOnce();
  assert.deepEqual(run.channels, []);
  assert.equal(off.node.callsTo("default.connectPeer").length, 0, "nobody dialed");
  assert.equal(off.node.callsTo("default.openChannel").length, 0);
  assert.deepEqual(off.books.peerOpenFailures ?? {}, {});
  assert.match(off.autopilot.getState().decisions.channels?.text ?? "", /^this node is connected to no peer at all right now \(Tor or the internet down\?\) — no peer is dialed, and none is held back for it, until it is$/);
  assert.equal(off.autopilot.getState().history.length, 0);
  // LND can't even list its peers: the same — nobody dialed, nobody held back.
  const mute = stage(t);
  mute.node.override("default.listPeers", (_a, cb) => cb({ details: "unavailable" }));
  mute.seams.channelSuggestions = async () => ({ suggestions: trio() });
  await mute.autopilot.runOnce();
  assert.equal(mute.node.callsTo("default.connectPeer").length, 0);
  assert.deepEqual(mute.books.peerOpenFailures ?? {}, {});
  assert.match(mute.autopilot.getState().decisions.channels?.text ?? "", /^LND didn't list its connected peers — no peer is dialed this run/);

  // Connected when the run starts; the connection goes while the first peer
  // is dialed: that peer is not held back, and nobody else is dialed.
  const lost = stage(t);
  assert.deepEqual(lost.node.peers, [GOSSIP_PEER]);
  lost.seams.channelSuggestions = async () => ({ suggestions: trio() });
  lost.node.override("default.connectPeer", (_a, cb) => {
    lost.node.peers.length = 0; // Tor went down
    cb({ details: "dial tcp: i/o timeout" });
  });
  await lost.autopilot.runOnce();
  assert.deepEqual([...new Set(lost.node.callsTo("default.connectPeer").map((a) => (a.addr as { pubkey: string }).pubkey))], [PK(21)]);
  assert.deepEqual(lost.books.peerOpenFailures ?? {}, {});
  assert.match(lost.autopilot.getState().decisions.channels?.text ?? "", /^no channel opened — this node lost its connection to every peer \(Tor or the internet down\?\): the open to good-21 failed \(couldn't connect/);
  assert.equal(lost.autopilot.getState().history.length, 1);

  // A peer that can't be reached while others are connected: the peer's doing — it backs off.
  const one = stage(t);
  one.seams.channelSuggestions = async () => ({ suggestions: trio().slice(0, 1) });
  one.node.override("default.connectPeer", (_a, cb) => cb({ details: "dial tcp: i/o timeout" }));
  await one.autopilot.runOnce();
  assert.equal(one.books.peerOpenFailures?.[PK(21)]?.fails, 1, "backed off: other peers are connected");
});

test("which refusals are this node's own — and which stay the peer's", () => {
  assert.equal(nodeSideRefusal("WalletNotFullySynced"), "LND's wallet isn't fully synced to the chain yet");
  assert.equal(nodeSideRefusal("FailedToOpenChannel: WalletNotFullySynced"), "LND's wallet isn't fully synced to the chain yet");
  assert.equal(nodeSideRefusal("InsufficientFundsToCreateChannel: not enough witness outputs to create funding transaction"), "LND's wallet can't fund it (not enough confirmed coins)");
  assert.equal(
    nodeSideRefusal("FailedToOpenChannel: reserved wallet balance invalidated: transaction would leave insufficient funds for fee bumping anchor channel closings"),
    "the open would dip into the coins LND keeps for closing anchor channels",
  );
  assert.equal(nodeSideRefusal("ChainUnsupported"), "LND doesn't run this chain");
  assert.equal(nodeSideRefusal("CannotOpenChannelToOwnNode"), "that is this node itself");
  // The peer's own error, whatever it says, and a peer refusal: the peer's.
  assert.equal(nodeSideRefusal("FailedToOpenChannel: received funding error from 02ab…: insufficient funds"), null);
  assert.equal(nodeSideRefusal("FailedToOpenChannel: chan size of 0.01 BTC is below min chan size of 0.05 BTC"), null);
  assert.equal(nodeSideRefusal("couldn't connect to 02ab… — the peer looks offline. Try again later."), null);
  assert.equal(nodeSideRefusal("PeerPendingChannelsExceedMaximumAllowable"), null);
});

test("an open that ended unclearly (its funding may be out) stops the run AND starts the cooldown — the next run doesn't open beside a channel that may exist", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const s = stage(t, { channelCooldownMinutes: 1_440 });
  const A = { ...suggestion, pubkey: PK(41), alias: "A", sockets: ["apeer.onion:9735"] };
  const B = { ...suggestion, pubkey: PK(42), alias: "B", sockets: ["bpeer.onion:9735"] };
  s.seams.channelSuggestions = async () => ({ suggestions: [A, B] });
  // LND broadcast the funding to A, then the stream dropped: A's channel is pending.
  s.node.beforeCall = (method, args) => {
    if (method !== "default.openChannel") return;
    if (pubkeyOf(args) === A.pubkey) {
      s.node.pending.push({ partnerPublicKey: A.pubkey, capacity: 2_000_000, transactionId: "ee".repeat(32), transactionVout: 0 });
      s.node.chainBalance -= 2_000_000;
      s.node.openFailure = "Connection dropped";
    } else s.node.openFailure = null;
  };
  const first = await s.autopilot.runOnce();
  assert.deepEqual(first.channels.map((c) => [c.alias, c.ok]), [["A", false]]);
  assert.equal(isPreBroadcastRefusal(first.channels[0].error ?? ""), false, "unclear: it may have been broadcast");
  assert.deepEqual(
    s.node.callsTo("default.connectPeer").map((a) => (a.addr as { pubkey: string }).pubkey),
    [A.pubkey],
    "B is not dialed in that run",
  );
  assert.ok(s.books.lastChannelOpenAt, "the cooldown started");
  assert.equal(JSON.parse(readFileSync(join(s.dir, "autopilot.json"), "utf8")).lastChannelOpenAt, s.books.lastChannelOpenAt, "on disk");
  assert.match(s.autopilot.getState().decisions.channels?.text ?? "", /^the open to A ended unclearly \(FailedToOpenChannel: Connection dropped\) — it may have opened a channel/);

  // Minutes later: the cooldown holds (before: B was opened at once — two pending channels).
  const second = await s.autopilot.runOnce();
  assert.deepEqual(second.channels, []);
  assert.equal(s.node.callsTo("default.openChannel").length, 1);
  assert.match(
    s.autopilot.getState().decisions.channels?.text ?? "",
    /^the open to A 0 min ago ended unclearly — it may have opened a channel; the next open waits for the 1440-minute cooldown$/,
  );
});

test("the stage's cap: auto size rises to a peer's minimum only up to a third of the node's capital — a peer asking more is passed over for the next", async (t) => {
  const s = stage(t);
  // 20M on chain: a third is 6.67M. One peer asks 8M, the next nothing special.
  const big = { ...suggestion, pubkey: PK(51), alias: "big", peerMinChannelSats: 8_000_000 };
  const next = { ...suggestion, pubkey: PK(52), alias: "next" };
  s.seams.channelSuggestions = async () => ({ suggestions: [big, next] });
  await s.autopilot.runOnce();
  assert.deepEqual(s.opened(), [[next.pubkey, 2_000_000]], "not an 8M channel to 'big'");
  // Its own minimum within the cap: sized up to it.
  s.later();
  s.seams.channelSuggestions = async () => ({ suggestions: [{ ...big, peerMinChannelSats: 5_000_000 }] });
  await s.autopilot.runOnce();
  assert.deepEqual(s.opened().at(-1), [big.pubkey, 5_000_000]);
});

test("a peer that says the channel is too BIG is a refusal before anything is broadcast: the next suggestion opens in the same run, and the next run opens to the first at its maximum", async (t) => {
  const s = stage(t);
  s.node.chainBalance = 40_000_000;
  const A = { ...suggestion, pubkey: PK(61), alias: "small-max", recommendedSizeSats: 20_000_000 };
  const B = { ...suggestion, pubkey: PK(62), alias: "fine" };
  s.seams.channelSuggestions = async () => ({ suggestions: [A, B] });
  s.node.beforeCall = (method, args) => {
    if (method !== "default.openChannel") return;
    s.node.openFailure =
      pubkeyOf(args) === A.pubkey && Number(args.local_funding_amount) > 16_777_215
        ? `received funding error from ${A.pubkey}: chan size of 0.2 BTC exceeds maximum chan size of 0.16777215 BTC`
        : null;
  };
  const run = await s.autopilot.runOnce();
  assert.deepEqual(s.opened(), [[A.pubkey, 20_000_000], [B.pubkey, 2_000_000]]);
  assert.deepEqual(run.channels.map((c) => [c.alias, c.ok]), [["small-max", false], ["fine", true]]);
  assert.equal(s.books.peerOpenFailures?.[A.pubkey]?.maxChannelSats, 16_777_215);
  s.later();
  s.seams.channelSuggestions = async () => ({ suggestions: [A] });
  await s.autopilot.runOnce();
  assert.deepEqual(s.opened().at(-1), [A.pubkey, 16_700_000]);
});

// ── the payback's evidence (review of P4) ───────────────────────────────────

test("the payback trusts the month-old channels' yield only with enough routing behind it — 10 forwards or 1,000 sat in 30 days; below that only the fee cap applies, and the note says so", async (t) => {
  // The boundary itself.
  const ev = (forwards: number, earnedSat: number) => ({ channels: 1, capacitySat: 6_000_000, forwards, earnedSat, forwardsRead: true });
  assert.equal(measuredYield(ev(MIN_YIELD_FORWARDS - 1, MIN_YIELD_EARNED_SAT - 1)), null);
  assert.equal(measuredYield(ev(MIN_YIELD_FORWARDS, 10)), 20, "ten forwards: measured (~20 ppm/yr)");
  assert.equal(measuredYield(ev(1, MIN_YIELD_EARNED_SAT)), 2_028, "1,000 sat: measured");
  assert.equal(measuredYield(ev(MIN_YIELD_FORWARDS, 0)), 0, "ten forwards that earned nothing: a measurement too");
  assert.equal(measuredYield({ ...ev(50, 5_000), channels: 0, capacitySat: 0 }), null);
  assert.equal(measuredYield({ ...ev(50, 5_000), forwardsRead: false }), null);

  // A node with a month-old 6M channel: 3 forwards earning 10 sat — before,
  // ~20 ppm/yr counted as measured and every open waited ~195 months; now
  // the open goes ahead under the fee cap, and the note says why.
  const node = (forwards: ReturnType<typeof forwardsOut>) => {
    const n = feeNode({
      blockHeight: 860_000,
      chainBalance: 20_000_000,
      channels: [{ id: "850000x1x0", partnerPublicKey: PK(9), capacity: 6_000_000, localBalance: 3_000_000, transactionId: "99".repeat(32), transactionVout: 0 }],
      forwards,
    });
    n.peers.push(GOSSIP_PEER);
    return n;
  };
  const few = autopilotWith(t, { channelEnabled: true }, {}, {}, node(forwardsOut("850000x1x0", "850000x1x0", 3, { tokens: 100_000, feeMsat: 3_334, days: 20 })));
  few.seams.openFeeRate = async () => 2;
  few.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  const fewEconomics = await few.autopilot.openEconomics();
  assert.deepEqual([fewEconomics?.ppmYear, fewEconomics?.evidence.forwards, fewEconomics?.evidence.earnedSat], [null, 3, 10]);
  await few.autopilot.runOnce();
  assert.equal(few.node.callsTo("default.openChannel").length, 1);
  assert.match(
    few.autopilot.getState().decisions.channels?.text ?? "",
    /^opened 2,000,000 sat to next-peer at 2 sat\/vB — no payback check: too little routing to measure what a channel earns here \(3 forwards, 10 sat through month-old channels in 30 days — it takes 10 forwards or 1,000 sat\)$/,
  );

  // Ten forwards earning 10 sat in all: measured — and a 2M open at 2 sat/vB
  // doesn't pay back within a year of ~20 ppm/yr.
  const ten = autopilotWith(t, { channelEnabled: true }, {}, {}, node(forwardsOut("850000x1x0", "850000x1x0", 10, { tokens: 100_000, feeMsat: 1_000, days: 20 })));
  ten.seams.openFeeRate = async () => 2;
  ten.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  assert.equal((await ten.autopilot.openEconomics())?.ppmYear, 20);
  await ten.autopilot.runOnce();
  assert.equal(ten.node.callsTo("default.openChannel").length, 0);
  assert.match(ten.autopilot.getState().decisions.channels?.text ?? "", /~195 months of what a 2,000,000 sat channel earns here \(20 ppm\/yr: what a sat in month-old channels earned, capacity-weighted\)/);

  // One forward that earned 1,000 sat: measured (~2,028 ppm/yr) — it pays back in ~2 months.
  const rich = autopilotWith(t, { channelEnabled: true }, {}, {}, node(forwardsOut("850000x1x0", "850000x1x0", 1, { tokens: 1_000_000, feeMsat: 1_000_000, days: 20 })));
  rich.seams.openFeeRate = async () => 2;
  rich.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  await rich.autopilot.runOnce();
  assert.equal(rich.node.callsTo("default.openChannel").length, 1);
  assert.match(rich.autopilot.getState().decisions.channels?.text ?? "", /^opened 2,000,000 sat to next-peer at 2 sat\/vB$/, "checked: no 'no payback check'");
});

// ── the manual Open form (review of P4) ─────────────────────────────────────

test("an open by hand starts at the fee engine's new-channel fee — the Open form's estimate says which, before the click, and the result says it again", async (t) => {
  const node = new FakeLnd({ chainBalance: 5_000_000, peers: [GOSSIP_PEER] });
  node.override("wallet.estimateFee", (_a, cb) => cb(null, { sat_per_kw: "750" })); // 3 sat/vB
  const api = await startApi(t, { node });
  const starting = api.autopilot.initialRoutingFee();
  assert.equal(starting.feeRatePpm, 80, "the protected fee a new channel gets (within the policy's range)");

  const est = await api.request("GET", "/channels/open-estimate?size=2000000");
  assert.equal(est.status, 200, JSON.stringify(est.body));
  assert.deepEqual(est.body.initialRoutingFee, starting);
  // No channel a month old: no yield — and what it stands on is said.
  assert.equal(est.body.yieldPpmYear, null);
  assert.deepEqual([est.body.yieldEvidence?.channels, est.body.minYieldForwards, est.body.minYieldEarnedSat], [0, MIN_YIELD_FORWARDS, MIN_YIELD_EARNED_SAT]);

  const peer = PK(71);
  const res = await api.request("POST", "/channels/open", { pubkey: peer, socket: "peer71.onion:9735", localTokens: 2_000_000, feeRate: 3 });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true, res.body.error);
  assert.deepEqual(res.body.startingFee, starting);
  const [open] = node.callsTo("default.openChannel");
  // Before this was said anywhere, the channel silently started there.
  assert.deepEqual(
    [open.use_fee_rate, Number(open.fee_rate), open.use_base_fee, String(open.base_fee), Number(open.sat_per_vbyte)],
    [true, 80, true, String(starting.baseFeeMsat), 3],
  );
});

// ── review of P4: two open-path guards with no test ─────────────────────────

test("the starting routing fee stays inside the operator's fee range: a 50 ppm maximum starts new channels at 50 (not the engine's 80), a 200 ppm minimum at 200 — the autopilot's open, the Open form's estimate and a manual open alike", async (t) => {
  const cases = [
    { policy: { minPpm: 25, neutralPpm: 40, maxPpm: 50 }, ppm: 50 },
    { policy: { minPpm: 200, neutralPpm: 300, maxPpm: 1000 }, ppm: 200 },
  ];
  for (const [i, c] of cases.entries()) {
    // The autopilot's own open.
    const s = stage(t);
    s.autopilot.setConfig({ policy: { ...s.autopilot.getState().config.policy, ...c.policy } });
    s.node.peers.push(suggestion.pubkey);
    s.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
    await s.autopilot.runOnce();
    const [auto] = s.node.callsTo("default.openChannel");
    // Before the clamp (or with it removed): 80 ppm whatever the range — for
    // good, with fee automation off.
    assert.deepEqual([auto?.use_fee_rate, Number(auto?.fee_rate)], [true, c.ppm], JSON.stringify(c.policy));

    // The Open form's estimate, and an open by hand.
    const node = new FakeLnd({ chainBalance: 5_000_000, peers: [GOSSIP_PEER] });
    node.override("wallet.estimateFee", (_a, cb) => cb(null, { sat_per_kw: "750" })); // 3 sat/vB
    const api = await startApi(t, { node });
    api.autopilot.setConfig({ policy: { ...api.autopilot.getState().config.policy, ...c.policy } });
    const est = await api.request("GET", "/channels/open-estimate?size=2000000");
    assert.equal(est.status, 200, JSON.stringify(est.body));
    assert.equal(est.body.initialRoutingFee.feeRatePpm, c.ppm);
    const res = await api.request("POST", "/channels/open", { pubkey: PK(81 + i), socket: "peer81.onion:9735", localTokens: 2_000_000, feeRate: 3 });
    assert.equal(res.body.ok, true, res.body.error);
    const [manual] = node.callsTo("default.openChannel");
    assert.equal(Number(manual.fee_rate), c.ppm);
  }
});

test("auto-size rising to a peer's minimum rounds UP to the next 100k: a 1,234,567 sat minimum opens 1,300,000 — rounded down (1,200,000) the peer would refuse it on every run", () => {
  const plan = planOpen(cand({ peerMinChannelSats: 1_234_567, recommendedSizeSats: 1_000_000 }), ctx({ maxRaiseSat: 5_000_000 }));
  assert.deepEqual(plan, { sizeSats: 1_300_000, why: "sized up to its 1,234,567 sat minimum" });
  // A round minimum is met exactly.
  assert.deepEqual(planOpen(cand({ peerMinChannelSats: 3_000_000, recommendedSizeSats: 1_000_000 }), ctx()), { sizeSats: 3_000_000, why: "sized up to its 3,000,000 sat minimum" });
});
