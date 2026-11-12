/**
 * What a sat in this node's month-old channels earned — the figure an open's
 * payback, the Magma hold and the lease-end close stand on (review
 * 2026-11-10, CHAN-1 and CHAN-13).
 *
 * Before: only the channels whose peer was connected at the moment of the
 * read counted. Dead channels left the denominator (the yield read higher
 * than the node's, and the open went out), and with the peer of the earning
 * channel away for a moment its forwards left too (the yield read "too little
 * routing to measure" and the open went out at the maximum fee rate with no
 * payback check). And a forwarding history LND handed over only in part was
 * measured as if it were whole.
 *
 * The node here is close to the one the review looked at: four month-old 10M
 * channels, 2,400 sat earned in 30 days through one of them — 730 ppm/yr.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { measuredYield, monthOldChannels, offlineYieldWords, planOpen, unmeasuredYieldText, type OpenContext } from "../src/services/openPlan.js";
import type { ChannelView } from "../src/services/channels.js";
import { GOSSIP_PEER, autopilotWith, suggestion } from "./helpers/autopilot.js";
import { chanNumber, feeNode, forwardsOut, type FeeChannel } from "./helpers/feeNode.js";

const PK = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const HEIGHT = 860_000;
const EARNER = "850000x1x0";

const channels = (): FeeChannel[] =>
  [1, 2, 3, 4].map((n) => ({
    id: `850000x${n}x0`,
    partnerPublicKey: PK(n),
    capacity: 10_000_000,
    localBalance: 5_000_000,
    transactionId: TX(n),
    transactionVout: 0,
  }));
// 12 forwards of 200 sat each: 2,400 sat in 30 days (about 80 sat a day).
const forwards = () => forwardsOut(EARNER, "850000x2x0", 12, { tokens: 1_000_000, feeMsat: 200_000, days: 20 });

function setup(t: TestContext, offline: number[]) {
  t.mock.method(console, "log", () => undefined);
  const node = feeNode({ blockHeight: HEIGHT, chainBalance: 20_000_000, channels: channels(), forwards: forwards() });
  for (const n of offline) node.channels[n - 1].isActive = false;
  node.peers.push(GOSSIP_PEER, suggestion.pubkey);
  const env = autopilotWith(t, { channelEnabled: true, channelMaxFeeRate: 20 }, {}, {}, node);
  env.seams.channelSuggestions = async () => ({ suggestions: [suggestion] });
  const said = () => env.autopilot.getState().decisions.channels?.text ?? "";
  const opens = () => env.node.callsTo("default.openChannel").length;
  return { ...env, said, opens };
}

test("with every peer connected: 730 ppm/yr over the four channels, and a 2M open at 8 sat/vB waits (~21 months of what it would earn)", async (t) => {
  const env = setup(t, []);
  const e = await env.autopilot.openEconomics();
  assert.deepEqual(e?.evidence, { channels: 4, capacitySat: 40_000_000, offline: 0, forwards: 12, earnedSat: 2_400, forwardsRead: true });
  assert.equal(e?.ppmYear, 730);
  env.seams.openFeeRate = async () => 8;
  await env.autopilot.runOnce();
  assert.equal(env.opens(), 0);
  assert.match(env.said(), /costs ~2,600 sat at 8 sat\/vB — ~21 months of what a 2,000,000 sat channel earns here \(730 ppm\/yr: what a sat in month-old channels earned, capacity-weighted\)/);
});

test("two dead channels whose peers are away still count: the yield stays 730 ppm/yr over 40M and the open still waits — said with how many are offline (before: 1,460 ppm/yr over the two connected ones, and the open went out)", async (t) => {
  const env = setup(t, [3, 4]);
  const e = await env.autopilot.openEconomics();
  assert.deepEqual(e?.evidence, { channels: 4, capacitySat: 40_000_000, offline: 2, forwards: 12, earnedSat: 2_400, forwardsRead: true });
  assert.equal(e?.ppmYear, 730);
  env.seams.openFeeRate = async () => 8;
  await env.autopilot.runOnce();
  assert.equal(env.opens(), 0, env.said());
  assert.match(
    env.said(),
    /~21 months of what a 2,000,000 sat channel earns here \(730 ppm\/yr: what a sat in month-old channels earned, capacity-weighted — 2 of the 4 are offline and count all the same\)/,
  );
});

test("the earning channel's peer away for a moment: its forwards still count, the yield is still measured, and a 2M open at the 20 sat/vB maximum waits (before: 'too little routing to measure' — opened with no payback check, ~53 months at the true yield)", async (t) => {
  const env = setup(t, [1]);
  const e = await env.autopilot.openEconomics();
  assert.deepEqual(e?.evidence, { channels: 4, capacitySat: 40_000_000, offline: 1, forwards: 12, earnedSat: 2_400, forwardsRead: true });
  assert.equal(e?.ppmYear, 730);
  env.seams.openFeeRate = async () => 20;
  await env.autopilot.runOnce();
  assert.equal(env.opens(), 0, env.said());
  assert.match(env.said(), /costs ~6,500 sat at 20 sat\/vB — ~53 months of what a 2,000,000 sat channel earns here \(730 ppm\/yr: .* — 1 of the 4 is offline and counts all the same\)/);
});

test("a month-old channel counts open, connected or not — a pending or closing one, or one under a month old, does not", () => {
  const chan = (id: string, o: Partial<ChannelView> = {}) => ({ id, status: "open", active: true, capacity: 1_000_000, ...o }) as unknown as ChannelView;
  const aged = monthOldChannels(
    [
      chan("850000x1x0"),
      chan("850000x2x0", { active: false }),
      chan("850000x3x0", { status: "pending_close" }),
      chan("850000x7x0", { status: "pending_open" }),
      chan("859000x4x0"), // 1,000 blocks old
      chan("855680x5x0", { active: false }), // 4,320 blocks: a month to the block
      chan("855681x6x0"),
    ],
    HEIGHT,
  );
  assert.deepEqual(aged.map((c) => c.id), ["850000x1x0", "850000x2x0", "855680x5x0"]);
});

test("the words for the offline ones: none said with all connected, and 'that one', '1 of the 3 is', '2 of the 4 are', 'all 3 are' otherwise — in the skip, and in why a yield couldn't be measured", () => {
  const of = (channels: number, offline: number) => offlineYieldWords({ channels, offline });
  assert.equal(of(4, 0), "");
  assert.equal(offlineYieldWords(null), "");
  assert.equal(of(1, 1), "that one channel is offline and counts all the same");
  assert.equal(of(3, 1), "1 of the 3 is offline and counts all the same");
  assert.equal(of(4, 2), "2 of the 4 are offline and count all the same");
  assert.equal(of(3, 3), "all 3 are offline and count all the same");
  const few = { channels: 3, capacitySat: 30_000_000, offline: 2, forwards: 3, earnedSat: 10, forwardsRead: true };
  assert.equal(
    unmeasuredYieldText(few),
    "too little routing to measure what a channel earns here (3 forwards, 10 sat through month-old channels in 30 days — it takes 10 forwards or 1,000 sat; 2 of the 3 are offline and count all the same)",
  );
  assert.equal(
    unmeasuredYieldText({ ...few, offline: 0 }),
    "too little routing to measure what a channel earns here (3 forwards, 10 sat through month-old channels in 30 days — it takes 10 forwards or 1,000 sat)",
  );
  // planOpen's skip carries them when it is given what the yield stands on.
  const ctx: OpenContext = {
    fixedSize: null,
    spendableSat: 20_000_000,
    feeRate: 8,
    yieldPpmYear: 730,
    yieldEvidence: { channels: 4, capacitySat: 40_000_000, offline: 2, forwards: 12, earnedSat: 2_400, forwardsRead: true },
    maxRaiseSat: 10_000_000,
    peers: {},
    connected: new Set([suggestion.pubkey]),
    neverOpen: new Set(),
    nowMs: Date.now(),
  };
  const plan = planOpen(suggestion, ctx);
  assert.match("skip" in plan ? plan.skip : "", /capacity-weighted — 2 of the 4 are offline and count all the same\); it pays back within 12 months only at cheaper fees$/);
  const { yieldEvidence: _none, ...bare } = ctx;
  const plain = planOpen(suggestion, bare);
  assert.match("skip" in plain ? plain.skip : "", /capacity-weighted\); it pays back/);
});

test("a forwarding history LND handed over only in part is no measurement: no yield figure, and the open's note says the history couldn't be read in full (before: the part read counted as the node's whole earnings)", async (t) => {
  const env = setup(t, []);
  const day = 86_400_000;
  const event = (ms: number, inId: string, outId: string, tokens: number, feeMsat: number) => ({
    amt_in: String(tokens + Math.floor(feeMsat / 1000)),
    amt_in_msat: String(tokens * 1000 + feeMsat),
    amt_out: String(tokens),
    amt_out_msat: String(tokens * 1000),
    chan_id_in: chanNumber(inId),
    chan_id_out: chanNumber(outId),
    fee: String(Math.floor(feeMsat / 1000)),
    fee_msat: String(feeMsat),
    timestamp: String(Math.floor(ms / 1000)),
    timestamp_ns: String(BigInt(Math.floor(ms)) * 1_000_000n),
  });
  // A node busier than the reader's 100 pages: the 12 forwards first, then
  // every further page holds one more.
  env.node.override("default.forwardingHistory", (a, cb) => {
    const offset = Number(a.index_offset ?? 0);
    const page =
      offset === 0
        ? Array.from({ length: 12 }, (_, i) => event(Date.now() - 20 * day + i * 60_000, "850000x2x0", EARNER, 1_000_000, 200_000))
        : [event(Date.now() - day, "850000x2x0", EARNER, 1_000_000, 200_000)];
    cb(null, { forwarding_events: page, last_offset_index: String(offset + page.length) });
  });
  const e = await env.autopilot.openEconomics();
  assert.equal(e?.evidence.forwardsRead, false);
  assert.equal(e?.ppmYear, null);
  assert.equal(measuredYield({ channels: 4, capacitySat: 40_000_000, offline: 0, forwards: 500, earnedSat: 90_000, forwardsRead: false }), null);
  env.seams.openFeeRate = async () => 8;
  await env.autopilot.runOnce();
  assert.equal(env.opens(), 1, env.said());
  assert.match(env.said(), /^opened 2,000,000 sat to next-peer at 8 sat\/vB — no payback check: this node's forwarding history couldn't be read in full, so what a channel earns here is unknown/);
});
