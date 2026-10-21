/**
 * The node's inbound/outbound need (review a3-channels:node-need-inverted,
 * package P4).
 *
 * A channel's localRatio is its OUTBOUND share. Before, computeNodeNeed called
 * a node with ≤ 30 % local "needs inbound" — the node was already ≥ 70 %
 * inbound and short of OUTBOUND, exactly what an open adds. So every
 * suggestion on it warned "You need inbound — opening this gives outbound",
 * Magma told it to buy inbound ("would help directly") and blocked selling
 * ("selling more outbound may not improve receive capacity"), while a ≥ 70 %
 * local node — short of inbound — read "inbound isn't your bottleneck".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeNodeNeed, needWarning } from "../src/services/suggestRecommend.js";
import type { ChannelView } from "../src/services/channels.js";
import { MAGMA_V2_DEFAULTS } from "../src/services/magmaRecommend.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import { sellerSetup } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";

const view = (n: number, localRatio: number): ChannelView => ({
  id: `850000x${n}x0`,
  peerPubkey: "02" + n.toString(16).padStart(2, "0").repeat(32),
  peerAlias: `peer-${n}`,
  active: true,
  private: false,
  initiator: "local",
  capacity: 2_000_000,
  transactionId: n.toString(16).padStart(2, "0").repeat(32),
  transactionVout: 0,
  localBalance: 2_000_000 * localRatio,
  remoteBalance: 2_000_000 * (1 - localRatio),
  localRatio,
  totalSent: 0,
  totalReceived: 0,
  unsettled: 0,
  status: "open",
  role: "router",
});
const node = (localRatio: number) => Array.from({ length: 5 }, (_, i) => view(i + 1, localRatio));

test("≤ 30 % local is short of OUTBOUND — what an open adds; ≥ 70 % local is short of INBOUND — opens add outbound only", () => {
  const inboundRich = computeNodeNeed(node(0.15), 10_000, 30);
  assert.equal(inboundRich.nodeNeed, "need_outbound");
  assert.equal(inboundRich.localPct, 15);
  assert.match(inboundRich.reason, /^only 15% of your liquidity is local — the node is short of outbound: channels you open add exactly that/);
  assert.doesNotMatch(inboundRich.reason, /need inbound|short of inbound/);

  const outboundHeavy = computeNodeNeed(node(0.85), 10_000, 30);
  assert.equal(outboundHeavy.nodeNeed, "need_inbound");
  assert.match(outboundHeavy.reason, /^85% of your liquidity is local \(outbound\) — the node is short of inbound: channels you open add outbound only; inbound comes from peers opening to you, Magma Buy or LN\+ swaps$/);

  // The caveat on every suggestion: only where an open can't give what is missing.
  assert.equal(needWarning("need_outbound"), null, "an inbound-rich node is no longer told it needs inbound");
  assert.match(needWarning("need_inbound") ?? "", /^Your node is short of inbound — opening this adds outbound only/);
  // Fewer than 5 channels: diversity first, as before.
  assert.equal(computeNodeNeed(node(0.15).slice(0, 4), 10_000, 30).nodeNeed, "need_routing_diversity");
});

/** A seller node with five 2M channels at `localRatio`, against a market
 *  whose comparable leases cleared at ~5 %/yr. */
async function magmaFor(t: Parameters<typeof sellerSetup>[0], localRatio: number) {
  const s = sellerSetup(t, { chainBalance: 5_000_000 });
  for (let i = 1; i <= 5; i++) {
    s.node.channels.push({
      id: `850000x${i}x0`,
      partnerPublicKey: "02" + i.toString(16).padStart(2, "0").repeat(32),
      capacity: 2_000_000,
      localBalance: 2_000_000 * localRatio,
      transactionId: i.toString(16).padStart(2, "0").repeat(32),
      transactionVout: 0,
    });
  }
  for (let i = 0; i < 8; i++) s.market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: 568, sellerScore: 50 });
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_500_000, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })),
  );
  t.after(() => __setHistoryForTests([]));
  return s.autopilot.magmaReport();
}

test("Magma: an outbound-heavy node is told to BUY inbound and may still lease; an inbound-rich node is told buying more inbound won't help — and selling is blocked for neither", async (t) => {
  quiet(t);
  const heavy = await magmaFor(t, 0.85);
  assert.equal(heavy.nodeNeed, "need_inbound");
  assert.equal(heavy.buy.state, "recommended");
  assert.match(heavy.buy.reasons[0], /^your node is short of inbound \(85% of its liquidity is local\) — buying inbound adds exactly that$/);
  // Leasing spends on-chain coins and changes neither side of the node's own
  // channels: the need never blocks it.
  assert.equal(heavy.sell.state, "good_to_sell", heavy.sell.reasons.join(" | "));
  assert.ok(![...heavy.sell.reasons, ...heavy.sell.warnings].some((w) => /receive capacity|needs inbound/.test(w)));
  // Routing is worth less where more outbound is not what's missing.
  assert.equal(heavy.sell.adjustedRoutingPpmPerYear, Math.round(MAGMA_V2_DEFAULTS.defaultRoutingOpportunityPpmPerYear * 0.8));

  const rich = await magmaFor(t, 0.15);
  assert.equal(rich.nodeNeed, "need_outbound");
  // Before: "your node needs inbound — buying inbound liquidity would help directly".
  assert.equal(rich.buy.state, "not_needed");
  assert.match(rich.buy.reasons[0], /^your node already has plenty of inbound \(only 15% of its liquidity is local\) — buying more won't help; it lacks outbound, which opening channels adds$/);
  // Before: "not_recommended_node_needs_inbound" — 'selling more outbound may not improve receive capacity'.
  assert.notEqual(rich.sell.state as string, "not_recommended_node_needs_inbound");
  assert.ok(![...rich.sell.reasons, ...rich.sell.warnings].some((w) => /receive capacity/.test(w)));
  // It prefers routing opens over leasing, and says so.
  assert.equal(rich.sell.adjustedRoutingPpmPerYear, Math.round(MAGMA_V2_DEFAULTS.defaultRoutingOpportunityPpmPerYear * 1.2));
  assert.ok(
    rich.sell.reasons.some((r) => /^your node is short of outbound \(only 15% of its liquidity is local\) — a routing channel adds exactly that, so a lease must beat routing valued 1\.2×$/.test(r)),
    rich.sell.reasons.join(" | "),
  );
});
