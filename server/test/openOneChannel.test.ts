/** One channel to a node (the review of P4, P4): the shared claim covers opens
 *  that overlap; an autopilot open whose suggestions were read before a click's
 *  open to the same node finished asks LND, under the on-chain mutex, which
 *  channels it has with the node — open or pending — and opens no second. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApi } from "./helpers/apiHarness.js";
import { feeNode, type FeeChannel } from "./helpers/feeNode.js";

const HEIGHT = 860_000;
const PK = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

test("an autopilot open right after a click's open to the same node finished opens no second channel: the one the click funded is pending, and the open is deferred and says why", async (t) => {
  const channels: FeeChannel[] = [{ id: `${HEIGHT - 14_400}x1x0`, partnerPublicKey: PK(1), capacity: 5_000_000, localBalance: 3_000_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 430, baseFeeMsat: 0 }];
  const node = feeNode({ blockHeight: HEIGHT, channels, chainBalance: 10_000_000 });
  node.override("version.getVersion", (_a, cb) => cb(null, { app_minor: 18, app_patch: 5, build_tags: [], commit_hash: "" }));
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ channelEnabled: true });
  const peer = PK(73);
  const click = await api.request("POST", "/channels/open", { pubkey: peer, socket: "peer73.onion:9735", localTokens: 2_000_000, feeRate: 3 });
  assert.equal(click.status, 200, JSON.stringify(click.body));
  const pending = node.callsTo("default.openChannel").length;
  // The stage's list was read before the click's open went out: it still names the node.
  const openTo = (api.autopilot as unknown as { openTo: (w: unknown, s: object, size: number, fee: number, held: number) => Promise<{ kind: string; reason?: string }> }).openTo.bind(api.autopilot);
  const auto = await openTo(node.lnd, { pubkey: peer, alias: "peer73", sockets: ["peer73.onion:9735"] }, 2_000_000, 3, 0);
  assert.equal(node.callsTo("default.openChannel").length, pending, "no second channel to the node the click just opened to");
  assert.deepEqual(auto, { kind: "deferred", reason: "deferred: a channel with peer73 exists already (pending) — not opened to again" });
});

test("an autopilot open whose look at LND's channels with the node is not answered opens nothing, and says so", async (t) => {
  const channels: FeeChannel[] = [{ id: `${HEIGHT - 14_400}x1x0`, partnerPublicKey: PK(1), capacity: 5_000_000, localBalance: 3_000_000, transactionId: TX(1), transactionVout: 0, feeRatePpm: 430, baseFeeMsat: 0 }];
  const node = feeNode({ blockHeight: HEIGHT, channels, chainBalance: 10_000_000 });
  const api = await startApi(t, { node });
  api.autopilot.setConfig({ channelEnabled: true });
  const openTo = (api.autopilot as unknown as { openTo: (w: unknown, s: object, size: number, fee: number, held: number) => Promise<{ kind: string; reason?: string }> }).openTo.bind(api.autopilot);
  node.override("default.pendingChannels", (_a, cb) => cb({ details: "rpc error: deadline exceeded" }));
  const auto = await openTo(node.lnd, { pubkey: PK(74), alias: "peer74", sockets: ["peer74.onion:9735"] }, 2_000_000, 3, 0);
  assert.equal(auto.kind, "deferred");
  assert.match(auto.reason ?? "", /^deferred: LND didn't list its channels with peer74 /);
  assert.equal(node.callsTo("default.openChannel").length, 0);
});
