/** The dead-capital alert reads the close list as it is ranked (review of P4, P1): a
 *  channel that routed 3M of forwards in, none out, is listed on its yield — and is no
 *  "routed nothing in 60 days" channel: forwards60d counts outgoing forwards only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankCloseCandidates, type CloseInput } from "../src/services/suggestRecommend.js";
import { deadCapitalAlerts } from "../src/services/alerts.js";
import type { ChannelView } from "../src/services/channels.js";
import type { FeeRecommendation } from "../src/services/feeRecommend.js";

const HEIGHT = 860_000;
const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
function chan(n: number, o: Partial<ChannelView> = {}): ChannelView {
  const capacity = 4_000_000, local = o.localBalance ?? 2_000_000;
  return { id: `${HEIGHT - 8_000}x${n}x0`, peerPubkey: PEER(n), peerAlias: `peer-${n}`, active: true, private: false, initiator: "local", capacity,
    transactionId: TX(n), transactionVout: 0, localBalance: local, remoteBalance: capacity - local, localRatio: local / capacity, totalSent: 0, totalReceived: 5_000_000,
    unsettled: 0, status: "open", role: "router", csvDelayBlocks: 144, commitFeeSats: 2_810, ...o } as ChannelView;
}
const feeOf = (c: ChannelView) => ({ channelId: c.id, state: "normal", metrics: { routedOut30d: 0, routedIn30d: 1_000_000, revenue30d: 0, channelAgeDays: 55, isTopEarner: false, peerGate: "ok" } }) as unknown as FeeRecommendation;

test("a channel that brought 3M of forwards in, none out, is listed on its yield but not named dead by the alert", () => {
  const earner = chan(1, { localBalance: 2_000_000 });
  const feeder = chan(2, { localBalance: 2_000_000 });
  const input: CloseInput = {
    channels: [earner, feeder],
    feeById: new Map([earner, feeder].map((c) => [c.id, feeOf(c)])),
    flow60ById: new Map([
      [earner.id, { channelId: earner.id, routedOut: 3_000_000, routedIn: 0, feesEarned: 5_000, forwardCount: 60, inboundFeesEarned: 0, inboundForwardCount: 0 }],
      [feeder.id, { channelId: feeder.id, routedOut: 0, routedIn: 3_000_000, feesEarned: 0, forwardCount: 0, inboundFeesEarned: 100, inboundForwardCount: 60 }],
    ]),
    uniqueReachByChan: new Map([[earner.id, 0], [feeder.id, 0]]),
    opportunity: [],
    closeCostSat: 500,
    rebalanceRecords: [],
    channelOverrides: {},
    leases: new Map(),
    offline: () => null,
    nowMs: Date.now(),
  };
  const report = rankCloseCandidates(input);
  const c = report.candidates.find((x) => x.channelId === feeder.id);
  assert.ok(c, "the feeder is listed (low yield)");
  const alerts = deadCapitalAlerts(report.candidates);
  // What it should say: nothing — the feeder routed 3M in 60 days.
  assert.deepEqual(alerts, [], "a channel that routed 3M (in) is not dead capital");
});
