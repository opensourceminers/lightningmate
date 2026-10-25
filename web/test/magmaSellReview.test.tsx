/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * The Magma words of the full review of 2026-10-25: an Accept below cost asks
 * twice, the dialogs say what an order earns after the service fee and what
 * its channel costs, who lists an offer again is said exactly, and the
 * switch-off says what becomes of orders under way.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../src/apiError";
import {
  acceptConfirmMessage,
  belowCostQuestion,
  belowCostRefusal,
  deskDoneToast,
  disableSellingMessage,
  freeOfferNote,
  offerOwner,
  openConfirmMessage,
  orderEarnings,
  relistsItself,
  turnedDownLine,
} from "../src/magmaView";
import { HowAmbossPicks } from "../src/components/MagmaSellInfo";

const src = (f: string) => readFileSync(new URL(`../src/components/${f}.tsx`, import.meta.url), "utf8");

test("an Accept the server refuses as below cost is asked about — and sent again with belowCost only after a yes", () => {
  const err = new ApiError("Not accepted: this order pays 50 sat …", 409, { error: "below_cost", message: "Not accepted: this order pays 50 sat …", feeSats: 50, floorSats: 1625 });
  const r = belowCostRefusal(err);
  assert.deepEqual(r, { message: "Not accepted: this order pays 50 sat …", feeSats: 50, floorSats: 1625 });
  assert.equal(belowCostRefusal(new ApiError("x", 409, { error: "capital_promised" })), null);
  assert.equal(belowCostRefusal(new Error("x")), null);
  assert.equal(
    belowCostQuestion(r!),
    "This order pays 50 sat; opening and later closing its channel costs 1,625 sat on chain now (after the service fee) — accepting it sells at a loss of about 1,575 sat. The autopilot turns such orders down. Accept it anyway?",
  );
  const orders = src("MarketOrders");
  assert.match(orders, /const below = belowCostRefusal\(e\);/);
  assert.match(orders, /r = await api\.ambossAcceptOrder\(o\.id, true\);/);
});

test("the Accept and Open dialogs say what the order earns after the service fee and what its channel costs — or that Amboss shows no amount", () => {
  assert.equal(orderEarnings(12_345, 100, 1_800), "It pays 12,345 sat — 12,222 sat after the 1% service fee; opening and later closing its channel costs about 1,800 sat on chain at today's fee rate.");
  assert.equal(orderEarnings(12_345, 0, null), "It pays 12,345 sat.");
  const paid = acceptConfirmMessage({ sizeSats: 2_000_000, feeSats: 12_345, feePartsSats: 12_345 }, 100, 1_800);
  assert.match(paid, /^It pays 12,345 sat — 12,222 sat after the 1% service fee; opening and later closing its channel costs about 1,800 sat on chain at today's fee rate\. Accept it\?/);
  const parts = acceptConfirmMessage({ sizeSats: 2_000_000, feeSats: 0, feePartsSats: 6_852 }, 100, 1_800);
  assert.match(parts, /^Amboss shows no amount for this order \(its seller fee reads 0\): the hold invoice bills its fee parts, 6,852 sat — check that this is your price for a 2,000,000 sat channel\./);
  assert.match(acceptConfirmMessage({ sizeSats: 2_000_000, feeSats: 0, feePartsSats: 0 }, 100, null), /^Amboss shows no amount for this order yet — it can't be accepted until it does\./);
  const open = openConfirmMessage({ sizeSats: 2_000_000, feeSats: 0, destination: "02" + "ab".repeat(32), local: { invoiceSats: 6_852 } as never }, 100, 1_800);
  assert.match(open, /This commits real on-chain funds into the channel\. It pays 6,852 sat — 6,784 sat after the 1% service fee; opening and later closing its channel costs about 1,800 sat/);
});

test("a click that finds the order already as it asked shows the API's own words", () => {
  assert.equal(deskDoneToast({ message: "Order is already accepted." }, "Order accepted — …"), "Order is already accepted.");
  assert.equal(deskDoneToast({ message: "Order is already rejected." }, "Order rejected."), "Order is already rejected.");
  assert.equal(deskDoneToast({ message: "Order accepted." }, "Order accepted — …"), "Order accepted — …");
  assert.match(src("MarketOrders"), /ui\.toast\(deskDoneToast\(r, "Order rejected\."\), "success"\)/);
});

test("who lists a free offer again is said as the autopilot does it", () => {
  assert.equal(relistsItself({ freeDisabledAt: "2026-10-25T10:00:00Z" }, true), true);
  assert.equal(relistsItself({ freeDisabledAt: "2026-10-25T10:00:00Z" }, false), false, "it doesn't price it: yours");
  assert.equal(relistsItself({ autoDisabledAt: "2026-10-25T10:00:00Z", disabledByHandAt: "2026-10-25T11:00:00Z" }, true), false);
  assert.equal(relistsItself({ costDisabledAt: "2026-10-25T10:00:00Z" }, false), true);
  assert.equal(relistsItself(undefined, true), false);
  assert.match(freeOfferNote({ freeDisabledAt: "2026-10-25T10:00:00Z" }, true, true), /lists it again itself once it can be funded/);
  assert.match(freeOfferNote({ disabledByHandAt: "2026-10-25T10:00:00Z" }, true, true), /listing it again is then your click/);
  assert.match(freeOfferNote(undefined, false, false), /Give it one with edit, then enable it\.$/);
  assert.doesNotMatch(src("MarketSell"), /Listing it again is your click\./);
});

test("an offer's owner says what the autopilot still does — and with Liquidity provision off, that it lists nothing again until it is on", () => {
  const off = offerOwner({ autoDisabledAt: "2026-10-20T00:00:00.000Z" }, false);
  assert.equal(off.title, "Liquidity provision is off: nothing manages this offer. The autopilot disabled it for lack of capital; with Liquidity provision on, it lists it again once it can be funded.");
  const mine = offerOwner({ manual: { since: "2026-10-20T10:00:00Z", why: "you edited this offer" } }, true);
  assert.match(mine.title, /changes none of its price or lease; it only keeps it fundable: its max channel and total are cut to what can be funded/);
  assert.match(offerOwner({ costDisabledAt: "2026-10-25T10:00:00Z" }, true).title, /pay less than opening and closing their channels cost at today's fee rate — it lists it again once they pay for them/);
});

test("switching selling off says what becomes of orders under way — one accepted by hand waits for your open", () => {
  assert.equal(
    disableSellingMessage(0),
    "Turn off Liquidity provision? Orders the autopilot accepted are still carried to their end (opened, settled or refunded); one you accepted by hand waits for you to open its channel on Market → Orders once it is paid.",
  );
});

test("Market → Sell: from which size orders are turned down, no 'too dear to fill', per-sale figures labelled, the configured service fee", () => {
  assert.equal(
    turnedDownLine({ offerId: "00479f19-540f", turnedDownUnderSat: 650_000 }, false),
    "Offer 00479f19…: orders under 650,000 sat pay less than opening and closing their channel costs at today's fee rate — the autopilot turns them down, and each refusal can cost seller score. Turn on auto-size, or raise its min channel.",
  );
  assert.equal(turnedDownLine({ offerId: "x", turnedDownUnderSat: undefined }, true), null);
  const sell = src("MarketSell");
  assert.doesNotMatch(sell, /too dear to fill/);
  assert.match(sell, /One sale at the recommended price/);
  assert.match(sell, /turnedDownLine\(e,/);
  assert.match(renderToStaticMarkup(<HowAmbossPicks usdOrderSat={null} feeBps={50} />), /The 0\.5% service fee applies only to completed sales\./);
  assert.doesNotMatch(renderToStaticMarkup(<HowAmbossPicks usdOrderSat={null} feeBps={0} />), /service fee applies/);
});
