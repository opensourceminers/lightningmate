/**
 * Magma offer upkeep on the Magma API: every write checks Amboss's answer and
 * is read back, every failure lands in the run history and the sync status,
 * and an offer never advertises a channel the wallet can't fund.
 *
 * Before: errors were swallowed (`catch {}`), `false` from updateOffer still
 * recorded "✓ Magma relist", pure reprices were only console-logged, the UI
 * said "Autopilot is managing your Magma pricing" from the settings alone, and
 * the offer only ever widened — after capital was spent elsewhere it kept
 * advertising sizes the node could no longer fund.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma, resolverFailed } from "./helpers/magma.js";
import { startApi } from "./helpers/apiHarness.js";
import type { AutopilotSeams } from "./helpers/autopilot.js";

function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
}

/** The live offer of the node this all started with: created on the legacy
 *  API, it has the same id on the Magma API. */
const LEGACY_OFFER_ID = "ea9edb42-d005-46ce-b2a9-97d8e3811f59";

test("an offer never advertises what can't be funded: shrunk to it, disabled below its minimum, enabled again when capital is back", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t, { chainBalance: 3_000_000 });
  const offer = magma.addOffer({ id: LEGACY_OFFER_ID, minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000 });

  await autopilot.runOnce();
  // 3M on chain − the reserve (50k, LND's anchor reserve being smaller) − the
  // ~1k funding fee, rounded down: 2.94M can be funded.
  assert.equal(offer.maxSats, 2_940_000);
  assert.equal(offer.totalSats, 2_940_000);
  const update = magma.calls.find((c) => c.op === "UpdateOffer");
  assert.equal((update?.variables.input as { offer_id: string }).offer_id, LEGACY_OFFER_ID, "managed through the Magma API, same id");
  let sells = autopilot.getState().history[0]?.sells ?? [];
  assert.deepEqual(sells.map((s) => [s.action, s.ok]), [["resize", true]]);

  node.chainBalance = 500_000; // spent elsewhere
  await autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "can't fund even its 1M minimum");
  sells = autopilot.getState().history[0]?.sells ?? [];
  assert.equal(sells[0]?.action, "disable");
  assert.match(sells[0]?.error ?? "", /can't be funded/);

  node.chainBalance = 3_000_000;
  await autopilot.runOnce();
  assert.equal(offer.status, "ENABLED");
  const sync = autopilot.offerSyncStatus();
  assert.equal(sync.managed, true);
  assert.equal(sync.offers[0]?.inSync, true, JSON.stringify(sync.offers[0]?.differences));
});

test("coins promised to an accepted order are not advertised again", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 5_000_000 });
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 4_000_000, totalSats: 4_000_000 });
  magma.addSale({ buyerPubkey: BUYER, sizeSats: 3_000_000 });
  await autopilot.pollSellOrders(); // accepted: 3M reserved
  await autopilot.runOnce();
  // 5M − ~51k reserve − 3M promised ≈ 1.94M left to list.
  assert.equal(offer.maxSats, 1_940_000);
  assert.equal(offer.totalSats - offer.lockedSats, 1_940_000);
});

test("an update Amboss refuses is on record — in the run history and the sync status, never 'managed' in silence", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 3_000_000 });
  magma.addOffer({ maxSats: 5_000_000, totalSats: 5_000_000 });
  magma.behave.UpdateOffer = "false";
  const run = await autopilot.runOnce();
  assert.deepEqual(run.sells.map((s) => [s.action, s.ok]), [["resize", false]]);
  assert.match(run.sells[0]?.error ?? "", /did not apply/);
  const [entry] = autopilot.offerSyncStatus().offers;
  assert.equal(entry.lastWrite?.ok, false);
  assert.equal(entry.inSync, false);
  assert.match(entry.differences.join(), /max channel/);
});

test("'success' that didn't stick is caught by reading the offer back", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 3_000_000 });
  magma.addOffer({ maxSats: 5_000_000, totalSats: 5_000_000 });
  magma.behave.UpdateOffer = "lie"; // answers success, changes nothing
  const run = await autopilot.runOnce();
  assert.equal(run.sells[0]?.ok, false);
  assert.match(run.sells[0]?.error ?? "", /reads back different/);
  assert.equal(autopilot.offerSyncStatus().offers[0]?.lastWrite?.verified, false);
});

test("Amboss unreachable during offer upkeep is on record, not swallowed", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t);
  magma.addOffer();
  magma.readBehaviour = "throw";
  const run = await autopilot.runOnce();
  assert.equal(run.sells[0]?.action, "error");
  assert.equal(run.failed, 1);
  assert.match(autopilot.offerSyncStatus().lastError?.message ?? "", /could not/);
});

test("a failing earlier stage no longer skips Magma offer upkeep", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t, { chainBalance: 3_000_000, config: { enabled: true } });
  magma.addOffer({ maxSats: 5_000_000, totalSats: 5_000_000 });
  (autopilot as unknown as AutopilotSeams).feeReport = async () => {
    throw new Error("fee engine broke");
  };
  const run = await autopilot.runOnce();
  assert.deepEqual(run.errors?.map((e) => e.stage), ["fees"]);
  assert.equal(magma.count("UpdateOffer"), 1, "the offer was still kept fundable");
});

test("manual offer writes: a refused update is an error status, a create returns the offer id, both are recorded", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const api = await startApi(t);
  api.amboss.setKey("test-key");
  const offer = magma.addOffer();
  const terms = { totalSizeSats: 4_000_000, minSizeSats: 1_000_000, maxSizeSats: 4_000_000, feeRatePpm: 2971, baseFeeSats: 852, minBlockLength: 4320 };

  magma.behave.UpdateOffer = "false";
  const refused = await api.request("POST", "/amboss/offer/update", { id: offer.id, ...terms });
  assert.equal(refused.status, 502, "not '200 { ok: false }' — the UI toasted success on that");
  magma.behave.UpdateOffer = "lie";
  const lied = await api.request("POST", "/amboss/offer/update", { id: offer.id, ...terms });
  assert.equal(lied.status, 200);
  assert.equal(lied.body.verified, false, "the read-back shows it didn't stick");
  magma.behave.UpdateOffer = "ok";
  const updated = await api.request("POST", "/amboss/offer/update", { id: offer.id, ...terms });
  assert.equal(updated.body.verified, true);
  assert.equal(offer.feeRatePpm, 2971);

  const created = await api.request("POST", "/amboss/offer", terms);
  assert.equal(created.status, 200);
  assert.ok(magma.offers.has(created.body.offerId));
  const input = magma.calls.find((c) => c.op === "CreateOffer")?.variables.input as Record<string, unknown>;
  assert.equal(input.pubkey, api.node.publicKey, "the Magma API wants the node the offer is for");

  const listed = await api.request("GET", "/amboss/my-offers");
  const sync = listed.body.sync.offers.find((e: { offerId: string }) => e.offerId === offer.id);
  assert.equal(sync.lastWrite.by, "manual");
  assert.equal(sync.lastWrite.verified, true);
});

test("a finished lease (CHANNEL_MONITORING_FINISHED) is closed when auto-close is on", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t, { config: { sellAutoClose: true } });
  const txid = "cd".repeat(32);
  node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  node.override("default.closeChannel", () => {
    const s = Object.assign(new EventEmitter(), { cancel: () => undefined });
    setImmediate(() => s.emit("data", { update: "close_pending", close_pending: { txid: randomBytes(32), output_index: 0 } }));
    return s;
  });
  const run = await autopilot.runOnce();
  const close = run.sells.find((s) => s.action === "close");
  assert.equal(close?.ok, true);
  assert.equal(node.callsTo("default.closeChannel").length, 1);
});

test("a finished lease whose order Amboss fails to show once is closed on the next run — the hiccup isn't remembered as 'no channel'", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t, { config: { sellAutoClose: true } });
  const txid = "ce".repeat(32);
  node.channels.push({ partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_990_000, transactionId: txid, transactionVout: 0 });
  magma.addSale({ buyerPubkey: BUYER, status: "CHANNEL_MONITORING_FINISHED", transactionId: `${txid}:0` });
  magma.saleRead = (_id, n) => (n === 0 ? resolverFailed() : null);
  node.override("default.closeChannel", () => {
    const s = Object.assign(new EventEmitter(), { cancel: () => undefined });
    setImmediate(() => s.emit("data", { update: "close_pending", close_pending: { txid: randomBytes(32), output_index: 0 } }));
    return s;
  });
  await autopilot.runOnce();
  assert.equal(node.callsTo("default.closeChannel").length, 0, "Amboss didn't say which channel");
  // Before: the failed read was cached as "no funding transaction" for the
  // life of the process — this lease's channel was never closed.
  const run = await autopilot.runOnce();
  assert.equal(run.sells.find((s) => s.action === "close")?.ok, true);
  assert.equal(node.callsTo("default.closeChannel").length, 1);
});

test("a capital dip cuts the offer, and capital coming back gives the cut back — up to what the offer had, never more", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t, { chainBalance: 10_000_000 });
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000 });
  node.chainBalance = 2_000_000; // a dip: coins locked in a pending open elsewhere
  await autopilot.runOnce();
  assert.equal(offer.maxSats, 1_940_000);
  assert.equal(offer.totalSats, 1_940_000);

  node.chainBalance = 3_000_000; // partly back: given back as far as it can be funded
  await autopilot.runOnce();
  assert.equal(offer.maxSats, 2_940_000);

  node.chainBalance = 10_000_000; // all back
  await autopilot.runOnce();
  // Before: the cut was for good — 1.94M forever, though the operator had
  // listed 5M and the wallet could fund it again.
  assert.equal(offer.maxSats, 5_000_000, "the operator's max, not more");
  assert.equal(offer.totalSats, 5_000_000);
  const sells = autopilot.getState().history[0]?.sells ?? [];
  assert.deepEqual(sells.map((s) => [s.action, s.ok]), [["resize", true]]);
  assert.match(autopilot.offerSyncStatus().offers[0]?.lastWrite?.reason ?? "", /capital is back/);

  await autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), 3, "nothing left to give back: no further writes");
});

test("a cut offer the operator has changed since is theirs again: nothing is 'given back' over their change", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t, { chainBalance: 2_000_000 });
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000 });
  await autopilot.runOnce();
  assert.equal(offer.maxSats, 1_940_000);
  // The operator lowers the max on amboss.tech meanwhile.
  offer.maxSats = 1_500_000;
  node.chainBalance = 10_000_000;
  await autopilot.runOnce();
  assert.equal(offer.maxSats, 1_500_000, "their 1.5M stands");
  assert.equal(offer.totalSats, 5_000_000, "the listed liquidity they didn't touch comes back");
});
