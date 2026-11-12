/** The refill's hard limit covers the making of its invoice (the review of P4,
 *  P5: an AddInvoice LND never answered held the refill, and the refill lock,
 *  past the limit for good). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRebalance } from "../src/services/rebalance.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { chanNumber } from "./helpers/feeNode.js";

const TARGET = "800001x1x0";
const SOURCE = "800002x1x0";
test("an AddInvoice LND never answers ends the refill at its hard limit: nothing is sent, and it says why", async () => {
  const node = new FakeLnd({
    channels: [
      { id: TARGET, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 200_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: SOURCE, partnerPublicKey: "02" + "b2".repeat(32), capacity: 2_000_000, localBalance: 1_800_000, transactionId: "b2".repeat(32), transactionVout: 0 },
    ],
  });
  node.override("default.feeReport", (_a, cb) =>
    cb(null, { channel_fees: [TARGET, SOURCE].map((id, i) => ({ chan_id: chanNumber(id), channel_point: `${(i ? "b2" : "a1").repeat(32)}:0`, base_fee_msat: "1000", fee_per_mil: "500", inbound_base_fee_msat: 0, inbound_fee_per_mil: 0 })) }),
  );
  node.override("default.addInvoice", () => undefined); // never answers
  const started = Date.now();
  const res = await Promise.race([
    executeRebalance(node.lnd, node.lnd, { targetId: TARGET, sourceId: SOURCE, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 500 }, { hardTimeoutMs: 1_000 }).then((r) => r.error ?? "ok"),
    new Promise<string>((r) => setTimeout(() => r("STILL WAITING after 4 s"), 4_000)),
  ]);
  assert.notEqual(res, "STILL WAITING after 4 s", "the refill ends at its hard limit");
  assert.match(res, /time limit reached/);
  assert.ok(Date.now() - started < 3_000);
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0);
});

test("an invoice LND makes only after the hard limit is cancelled when it arrives, and the source is not backed off for LND's slow answer", async () => {
  const node = new FakeLnd({
    channels: [
      { id: TARGET, partnerPublicKey: "02" + "a1".repeat(32), capacity: 2_000_000, localBalance: 200_000, transactionId: "a1".repeat(32), transactionVout: 0 },
      { id: SOURCE, partnerPublicKey: "02" + "b2".repeat(32), capacity: 2_000_000, localBalance: 1_800_000, transactionId: "b2".repeat(32), transactionVout: 0 },
    ],
  });
  node.override("default.feeReport", (_a, cb) =>
    cb(null, { channel_fees: [TARGET, SOURCE].map((id, i) => ({ chan_id: chanNumber(id), channel_point: `${(i ? "b2" : "a1").repeat(32)}:0`, base_fee_msat: "1000", fee_per_mil: "500", inbound_base_fee_msat: 0, inbound_fee_per_mil: 0 })) }),
  );
  const add = node.lnd.default.addInvoice;
  node.override("default.addInvoice", (a, cb) => void setTimeout(() => add(a, cb), 1_300));
  const res = await executeRebalance(node.lnd, node.lnd, { targetId: TARGET, sourceId: SOURCE, amountSats: 400_000, econRatio: 0.8, maxFeePpm: 500 }, { hardTimeoutMs: 1_000 });
  assert.match(res.error ?? "", /time limit reached/);
  assert.deepEqual(res.failedSourceIds ?? [], [], "LND's slow answer is no failure of the source");
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(node.callsTo("invoices.cancelInvoice").length, 1, "the late invoice is cancelled: nothing pays it");
  assert.equal(node.callsTo("router.sendPaymentV2").length, 0);
});
