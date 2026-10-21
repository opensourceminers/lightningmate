import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUN_STUCK_MINUTES,
  awaitsYourDecision,
  failedOfferWrite,
  laneBanner,
  promisedSpend,
  removeKeyMessage,
  runProgress,
  spendPromisedQuestion,
} from "../src/statusNotes";
import { ApiError } from "../src/apiError";
import type { MagmaLaneStatus, MagmaOrderLocal, OfferSyncEntry, OfferSyncStatus, OfferWrite } from "../src/types";

const fields = {
  status: "ENABLED",
  minSizeSats: 1_000_000,
  maxSizeSats: 5_000_000,
  totalSizeSats: 5_000_000,
  availableSats: 5_000_000,
  feeRatePpm: 3000,
  baseFeeSats: 852,
  minBlockLength: 4320,
};

const failed: OfferWrite = {
  at: "2026-10-20T10:00:00.000Z",
  by: "autopilot",
  action: "update",
  fields: { max_size: 2_940_000 },
  ok: false,
  error: "Amboss did not apply the update (success: false)",
};

const entry = (o: Partial<OfferSyncEntry>): OfferSyncEntry => ({
  offerId: "offer-1",
  checkedAt: "2026-10-20T10:00:00.000Z",
  amboss: fields,
  wanted: fields,
  inSync: true,
  differences: [],
  lastWrite: null,
  ...o,
});

const sync = (...offers: OfferSyncEntry[]): OfferSyncStatus => ({ at: null, managed: true, offers, lastError: null });

test("a failed offer write shows while that offer is still out of sync — not after a later write fixed it", () => {
  assert.equal(failedOfferWrite(sync(entry({ inSync: false, lastWrite: failed }))), failed.error);
  // The offer is in sync again (a later run's write landed, or Amboss now has
  // what is wanted): the old failure is history, not a banner.
  assert.equal(failedOfferWrite(sync(entry({ inSync: true, lastWrite: failed }))), null);
  // A write Amboss said yes to but that reads back different counts as failed.
  const unverified: OfferWrite = { ...failed, ok: true, error: undefined, verified: false };
  assert.equal(failedOfferWrite(sync(entry({ inSync: false, lastWrite: unverified }))), "Amboss did not store the change");
  assert.equal(failedOfferWrite(sync(entry({ inSync: false, lastWrite: { ...failed, ok: true, error: undefined, verified: true } }))), null);
  assert.equal(failedOfferWrite(null), null);
});

test("a run in progress is shown, and called stuck once it runs far longer than usual", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  assert.equal(runProgress(null, now), null, "no run in progress: nothing to say");
  assert.deepEqual(runProgress(ago(0.2), now), { text: "Run in progress…", stuck: false });
  assert.deepEqual(runProgress(ago(4), now), { text: "Run in progress for 4 min…", stuck: false });
  const stuck = runProgress(ago(RUN_STUCK_MINUTES + 25), now);
  assert.equal(stuck?.stuck, true);
  assert.match(stuck?.text ?? "", /35 min — far longer than usual/);
  assert.match(stuck?.text ?? "", /Magma orders are handled separately/);
});

test("removing the Amboss key says what happens to Magma orders in flight", () => {
  assert.doesNotMatch(removeKeyMessage(0), /in flight/);
  const one = removeKeyMessage(1);
  assert.match(one, /1 Magma order is still in flight/);
  assert.match(one, /can't open, report or settle/);
  assert.match(one, /releases held payments back to their buyers before they expire/);
  assert.match(removeKeyMessage(3), /3 Magma orders are still in flight/);
});

test("a spend refused for coins promised to buyers is recognised — the confirmation names them; any other error is not", () => {
  const message =
    "Only 948,000 sat can be spent without touching the coins promised to buyers whose channels aren't open yet: " +
    "1 accepted Magma order (2,000,000 sat). Spending more makes that channel fail to open after the buyer paid — the payment goes back.";
  const refusal = new ApiError(message, 409, {
    error: "capital_promised",
    message,
    spendableSat: 948_000,
    promisedSat: 2_000_000,
    promised: [{ source: "magma", orderId: "o-1", sats: 2_000_000 }],
  });
  assert.deepEqual(promisedSpend(refusal), { message, promisedSat: 2_000_000 });
  assert.equal(spendPromisedQuestion({ message }), `${message} Spend them anyway?`);
  // Only that refusal offers "spend anyway": other conflicts, other errors, plain errors don't.
  assert.equal(promisedSpend(new ApiError("Order is WAITING_FOR_BUYER_PAYMENT", 409, { error: "bad_status" })), null);
  assert.equal(promisedSpend(new ApiError("bad", 400, { error: "capital_promised" })), null);
  assert.equal(promisedSpend(new Error("network down")), null);
  assert.equal(promisedSpend(undefined), null);
});

test("the order lane's note says 'retrying' only where the next pass can clear it — not for a request Amboss rejects until LightningMate is updated", () => {
  const lane = (o: Partial<MagmaLaneStatus>): MagmaLaneStatus => ({
    lastTickAt: "2026-10-20T12:00:00.000Z",
    ok: false,
    error: null,
    retrying: true,
    idle: null,
    running: false,
    openOrders: 0,
    ...o,
  });
  const outage = "Amboss unreachable (Amboss HTTP 502) — held payments are still watched in LND";
  assert.equal(laneBanner(lane({ error: outage })), `Order lane: ${outage} — retrying.`);
  const rejected =
    "Amboss rejected LightningMate's request (Cannot query field \"fees\" on type \"MarketOrder\".) — the Magma API may have " +
    "changed; orders can't be acted on until LightningMate is updated";
  // Before: "… until LightningMate is updated — retrying." — a recovery that can't come.
  const note = laneBanner(lane({ error: rejected, retrying: false }));
  assert.equal(note, `Order lane: ${rejected}.`);
  assert.doesNotMatch(note ?? "", /retrying/);
  // Nothing to report: no note.
  assert.equal(laneBanner(lane({ ok: true })), null);
  assert.equal(laneBanner(lane({ ok: null, idle: "Liquidity provision is off" })), null);
  assert.equal(laneBanner(undefined), null);
  // An older server without the flag: as before.
  assert.equal(laneBanner(lane({ error: outage, retrying: undefined })), `Order lane: ${outage} — retrying.`);
});

test("Accept and Reject are offered for a sale awaiting your approval with nothing of yours tied to it — an order ended here as 'failed' included", () => {
  const local = (o: Partial<MagmaOrderLocal>): MagmaOrderLocal => ({
    phase: "seen",
    via: "autopilot",
    updatedAt: "2026-10-21T00:00:00.000Z",
    fundingOutpoint: null,
    reason: null,
    decision: null,
    lastError: null,
    ...o,
  });
  const waiting = { side: "SELL" as const, status: "WAITING_FOR_SELLER_APPROVAL" };
  assert.equal(awaitsYourDecision({ ...waiting, local: null }), true, "not taken on yet");
  assert.equal(awaitsYourDecision({ ...waiting, local: local({}) }), true, "seen");
  // Before: hidden — an order ended here while Amboss still waited on you
  // could only time out (the server takes it up again now).
  assert.equal(awaitsYourDecision({ ...waiting, local: local({ phase: "failed", reason: "Amboss refuses to show this order" }) }), true);
  // Something of yours tied to it, or decided already: no buttons.
  for (const phase of ["accepting", "accepted", "rejected", "cancelled", "settled"] as const) {
    assert.equal(awaitsYourDecision({ ...waiting, local: local({ phase }) }), false, phase);
  }
  assert.equal(awaitsYourDecision({ ...waiting, local: local({ phase: "failed", fundingOutpoint: "ab".repeat(32) + ":0" }) }), false, "a channel");
  assert.equal(awaitsYourDecision({ side: "SELL", status: "WAITING_FOR_CHANNEL_OPEN", local: null }), false);
});
