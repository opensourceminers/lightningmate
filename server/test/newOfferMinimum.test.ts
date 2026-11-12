// The minimum of an offer the autopilot creates (autopilot.ts newOfferMinimum;
// review of P2, S20, B5, B16, B17): each of the three sizes it falls through,
// and the "no offer" it ends in. At 3,761 ppm + 284 sat and a lane floor of
// 3,250 sat (10 sat/vB) the smallest order pays the write margin from
// 1,010,000 sat, the keep margin from 930,000, the bare floor from 790,000.
import { test } from "node:test";
import assert from "node:assert/strict";
import { newOfferMinimum } from "../src/services/autopilot.js";

const PRICE = { feeRatePpm: 3761, baseFeeSats: 284 };
const FLOOR = 3250;
const SHARE = 0.01;
/** Orders up to `cap` can be funded / listed. */
const upTo = (cap: number) => () => cap;
const ALL = upTo(20_000_000);

test("everything can be funded and listed: the write margin's size", () => {
  assert.deepEqual(newOfferMinimum(PRICE, FLOOR, SHARE, 500_000, ALL, ALL), { minSat: 1_010_000, uncovered: null });
});

test("the write margin's size cannot be funded, the keep margin's can: the keep margin's", () => {
  assert.deepEqual(newOfferMinimum(PRICE, FLOOR, SHARE, 500_000, upTo(950_000), ALL), { minSat: 930_000, uncovered: null });
});

test("…and the same where the wallet funds it but less can be listed (the reserve, promised orders, the deploy cap)", () => {
  assert.deepEqual(newOfferMinimum(PRICE, FLOOR, SHARE, 500_000, ALL, upTo(950_000)), { minSat: 930_000, uncovered: null });
});

test("no margin can be funded, the bare floor can: the bare floor's size", () => {
  assert.deepEqual(newOfferMinimum(PRICE, FLOOR, SHARE, 500_000, upTo(800_000), ALL), { minSat: 790_000, uncovered: null });
});

test("no order that can be funded pays the floor: no offer, and the reason names the price, what can be funded and the floor", () => {
  assert.deepEqual(newOfferMinimum(PRICE, FLOOR, SHARE, 500_000, upTo(700_000), ALL), {
    minSat: 0,
    uncovered:
      "no offer listed: at the engine's price (3,761 ppm + 284 sat) no order that can be funded now (up to 700,000 sat) pays for opening and closing its channel at today's fee rate (3,250 sat) — the order lane would turn every order down",
  });
});

test("a viable size above the covering one stands: the engine's smallest viable channel", () => {
  assert.deepEqual(newOfferMinimum(PRICE, FLOOR, SHARE, 1_200_000, ALL, ALL), { minSat: 1_200_000, uncovered: null });
});

test("no floor known: the viable size as far as it can be funded", () => {
  assert.deepEqual(newOfferMinimum(PRICE, null, SHARE, 1_200_000, upTo(1_000_000), ALL), { minSat: 1_000_000, uncovered: null });
});

test("nothing at all can be funded: no minimum, and no reason of the cover's (the caller says what is missing: capital)", () => {
  assert.deepEqual(newOfferMinimum(PRICE, FLOOR, SHARE, 500_000, upTo(0), ALL), { minSat: 0, uncovered: null });
});
