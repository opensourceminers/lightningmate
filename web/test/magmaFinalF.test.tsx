/**
 * Market → Sell after the final review (2026-10-25): the base fee the engine
 * keeps, the banner for orders waiting on you, the switch-off dialog with
 * offers listed, and the owner note's wording.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseFeeFollow, disableSellingMessage, offerOwner, pendingOrdersBanner } from "../src/magmaView";

test("a base the engine keeps (the market's would push the smallest order below cost) reads 'kept' — never '→ 568 next run' for a move that won't come", () => {
  type Report = Parameters<typeof baseFeeFollow>[1];
  const rec = (r: Record<string, unknown>) => ({ sell: { recommendations: [{ offerId: "o1", ...r }] } }) as unknown as Report;
  const kept = baseFeeFollow({ id: "o1", baseFeeSats: 1500 }, rec({ baseFeeDiffers: true, baseFeeMarketSat: 568, baseFeeKept: true }), true);
  assert.equal(kept?.cell, "kept");
  assert.match(kept!.title, /^Comparable offers charge 568 sat base; this offer keeps its own: with the market's, its smallest order would pay less than opening and closing its channel costs at today's fee rate/);
  // Not for an offer the autopilot doesn't price.
  assert.equal(baseFeeFollow({ id: "o1", baseFeeSats: 1500 }, rec({ baseFeeDiffers: true, baseFeeMarketSat: 568, baseFeeKept: true }), false), null);
  // A move that comes still says when.
  assert.equal(baseFeeFollow({ id: "o1", baseFeeSats: 1500 }, rec({ baseFeeDiffers: true, baseFeeMarketSat: 568 }), true)?.cell, "→ 568 next run");
});

test("the Sell banner asks a decision of orders awaiting approval, and the Open click of paid ones the lane doesn't open (before: 'accept or reject in time' for both)", () => {
  assert.equal(pendingOrdersBanner({ pendingSellerOrders: 0, pendingSellerOpens: 0 }), null);
  assert.equal(
    pendingOrdersBanner({ pendingSellerOrders: 1, pendingSellerOpens: 0 }),
    "1 order waiting for your decision — accept or reject it in time on Market → Orders, or Amboss counts it against your seller score.",
  );
  assert.equal(
    pendingOrdersBanner({ pendingSellerOrders: 2, pendingSellerOpens: 2 }),
    "2 paid orders waiting for you to open their channels — click Open on Market → Orders before the deadline, or Amboss counts them against your seller score.",
  );
  assert.equal(
    pendingOrdersBanner({ pendingSellerOrders: 2, pendingSellerOpens: 1 }),
    "1 order waiting for your decision — accept or reject it in time on Market → Orders; 1 paid order waiting for you to open its channel — " +
      "click Open on Market → Orders before the deadline, or Amboss counts them against your seller score.",
  );
  // A report from before the split: all of them a decision.
  assert.match(pendingOrdersBanner({ pendingSellerOrders: 1 }) ?? "", /^1 order waiting for your decision/);
});

test("switching selling off with offers listed says what becomes of orders accepted by hand — they wait for you to open their channel", () => {
  const one = disableSellingMessage(1);
  assert.match(one, /^Your offer is still listed on Amboss\./);
  assert.match(one, /Orders the autopilot accepted are still carried to their end; one you accepted by hand waits for you to open its channel on Market → Orders once it is paid\. Disable the offer too\?$/);
});

test("the owner note of an offer taken off the market below cost: 'opening and closing their channels cost'", () => {
  const o = offerOwner({ costDisabledAt: "2026-10-25T10:00:00.000Z" }, true);
  assert.match(o.title, /its orders would pay less than opening and closing their channels cost at today's fee rate/);
});
