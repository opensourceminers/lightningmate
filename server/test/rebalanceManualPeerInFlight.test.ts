/** A refill by hand toward a peer whose other channel has a refill still in
 *  flight is refused, as the stage refuses it (the review of P4, P2: the run
 *  by hand checked only the row's own target and sources, and paid a second
 *  refill toward the peer). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApi } from "./helpers/apiHarness.js";
import { feeNode, forwardsOut, type FeeChannel } from "./helpers/feeNode.js";

const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const TARGET = "850000x1x0";
const SIBLING = "850000x9x0";
const FULL = "850000x3x0";
const FAIR = "850000x4x0";
const chan = (id: string, n: number, localBalance: number, o: Partial<FeeChannel> = {}): FeeChannel => ({
  id, partnerPublicKey: PEER(n), capacity: 5_000_000, localBalance, transactionId: TX(n), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0, ...o,
});

test("a refill by hand into a channel whose peer's other channel has a refill in flight is refused, and nothing is paid", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const channels = [
    chan(TARGET, 1, 750_000, { feeRatePpm: 400 }),
    chan(SIBLING, 9, 600_000, { partnerPublicKey: PEER(1), feeRatePpm: 400 }),
    chan(FULL, 3, 4_000_000),
    chan(FAIR, 4, 3_600_000),
  ];
  const node = feeNode({ blockHeight: 860_000, channels, forwards: forwardsOut(SIBLING, FULL, 20, { tokens: 60_000, feeMsat: 24_000, days: 10 }) });
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ rebalanceDailyBudgetSats: 10_000 });
  // An autopilot refill into TARGET out of FULL, sent 10 minutes ago, still in flight.
  const at = new Date(Date.now() - 10 * 60_000).toISOString();
  const st = (api.autopilot as unknown as { state: Record<string, unknown> }).state;
  st.pendingRebalances = [{ id: "ab".repeat(32), targetId: TARGET, sourceId: FULL, alias: "peer-1", amountSats: 400_000, maxFeeSats: 120, day: at.slice(0, 10), at, via: "autopilot" }];
  (st.perTargetLastRebalanced as Record<string, string>)[TARGET] = at;
  // The tab's plan was made after that (it shows the in-flight payment on TARGET's row only).
  const planAt = new Date(Date.now() - 60_000).toISOString();
  const res = await api.request("POST", "/rebalance/execute", { targetId: SIBLING, sourceId: FAIR, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 320, planAt });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, "in_flight");
  assert.match(res.body.message, /It refills the same peer as .*: until then no other refill goes toward that peer\.$/);
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0, "no second refill toward the peer while the first may still land");
});
