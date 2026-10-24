/**
 * Switching Liquidity provision on lists the offers again (2026-10-24).
 *
 * Switching it off disables every listed offer "by hand" (the switch's
 * dialog), and a disable by hand sticks — so switching back on listed none:
 * the live offer had to be enabled on Market → Sell although the autopilot
 * was on. Now the offers the last offer sync showed disabled at the switch-on
 * are marked at the first offer read after it (OfferControl.listOnAt), and
 * capital safety lists each once it has a price and its smallest channel can
 * be funded, whoever owns its terms — its terms written and read back first.
 * A disable by hand after the switch sticks; "keep disabled" keeps one off.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { offerPriceAlerts } from "../src/services/alerts.js";
import { sanitizeSellSwitchOn } from "../src/services/autopilot.js";
import { getMyOffer } from "../src/services/magmaApi.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import { sellerSetup } from "./helpers/autopilot.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { quiet } from "./helpers/lifecycle.js";
import type { AfterHook } from "./helpers/tmp.js";

/** A priced offer whose smallest channel the test node can fund. */
const PRICED = { minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, feeRatePpm: 3000, baseFeeSats: 568, minBlockLength: 4320, feeRateCap: "2200", baseFeeCap: "1" };

type Setup = ReturnType<typeof sellerSetup>;
const entryOf = (autopilot: Setup["autopilot"], id: string) => autopilot.offerSyncStatus().offers.find((e) => e.offerId === id);
const controlOf = (autopilot: Setup["autopilot"], id: string) => autopilot.offerControls()[id] ?? {};

/** No update ever sent a price of nothing. */
const neverSentFree = (magma: FakeMagma) =>
  assert.ok(
    magma.calls
      .filter((c) => c.op === "UpdateOffer")
      .every((c) => Number((c.variables.input as Record<string, unknown>).fee_rate ?? 0) > 0 || Number((c.variables.input as Record<string, unknown>).base_fee ?? 0) > 0),
  );

/** What the switch-off dialog does: every listed offer disabled by state —
 *  the toggle route records the click and what it read — then selling off. */
async function switchOff(s: Setup, offers: { id: string; status: string }[]): Promise<void> {
  for (const o of offers) {
    if (o.status !== "ENABLED") continue;
    o.status = "DISABLED";
    s.autopilot.offerStatusSetByHand(o.id, "DISABLED", await getMyOffer("test-key", o.id));
  }
  s.autopilot.setConfig({ sellEnabled: false });
}

/** A selling node whose comparable leases cleared at 5% a year (the engine has a price). */
function pricedMarket(t: AfterHook, chainBalance = 8_000_000, config: Record<string, unknown> = {}) {
  const s = sellerSetup(t, { chainBalance, config: { sellAutoReprice: true, sellPricingMode: "balanced", ...config } });
  for (let i = 0; i < 8; i++) {
    s.market.addOffer({ totalSats: 2_000_000, minSats: 1_000_000, maxSats: 2_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: 568, sellerScore: 50 });
  }
  __setHistoryForTests(
    Array.from({ length: 30 }, (_, i) => ({ at: Date.now() - i * 86_400_000, sizeSat: 1_500_000, blocks: 4320, apr: 0.05, leasePpm: 4110, status: "FINISHED" })),
  );
  t.after(() => __setHistoryForTests([]));
  return s;
}

const later = () => new Promise((r) => setTimeout(r, 5));

test("switching Liquidity provision on lists the offers its switch-off disabled — in the first run, whoever owns their terms, and their terms stay", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000 });
  const { autopilot, magma } = s;
  const theirs = magma.addOffer(PRICED);
  const mine = magma.addOffer({ ...PRICED, feeRatePpm: 4100, baseFeeSats: 300 });
  autopilot.pauseOfferAutomation(mine.id, "you edited this offer");
  await autopilot.runOnce();
  assert.deepEqual([theirs.status, mine.status], ["ENABLED", "ENABLED"]);

  await switchOff(s, [theirs, mine]);
  await autopilot.runOnce();
  assert.deepEqual([theirs.status, mine.status], ["DISABLED", "DISABLED"], "selling off: nothing lists them");

  const updates = magma.count("UpdateOffer");
  autopilot.setConfig({ sellEnabled: true });
  await autopilot.runOnce();
  assert.deepEqual([theirs.status, mine.status], ["ENABLED", "ENABLED"], "before: both stayed disabled — 'disabled by you'");
  assert.equal(magma.count("UpdateOffer"), updates, "listed as they are: no term changed");
  assert.deepEqual([mine.feeRatePpm, mine.baseFeeSats], [4100, 300], "the operator's terms stay theirs");
  assert.ok(controlOf(autopilot, mine.id).manual, "and so does who owns them");
  for (const [o, whose] of [
    [theirs, "its own price \\(auto-pricing is off\\), 3,000 ppm \\+ 568 sat"],
    [mine, "your price, 4,100 ppm \\+ 300 sat"],
  ] as const) {
    const e = entryOf(autopilot, o.id);
    assert.equal(e?.lastWrite?.action, "enable");
    assert.equal(e?.lastWrite?.by, "autopilot");
    assert.match(e?.lastWrite?.reason ?? "", new RegExp(`^Liquidity provision was switched on with it disabled — it has a price, and its smallest channel can be funded — listed at ${whose}$`));
    assert.equal(controlOf(autopilot, o.id).listOnAt, undefined, "done: nothing left to list");
  }
  // Listed once: the next run has nothing to flip.
  const toggles = magma.count("ToggleOffer");
  await autopilot.runOnce();
  assert.equal(magma.count("ToggleOffer"), toggles);
});

test("after the switch-on, an offer that can't be funded or has no price stays off, saying why — and is listed once it can be, never at 0 ppm + 0 sat", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 500_000 });
  const { autopilot, magma, node } = s;
  const big = magma.addOffer({ ...PRICED, status: "DISABLED" });
  const free = magma.addOffer({ ...PRICED, minSats: 100_000, maxSats: 200_000, totalSats: 200_000, status: "DISABLED", feeRatePpm: 0, baseFeeSats: 0 });
  autopilot.pauseOfferAutomation(free.id, "you edited this offer"); // no price the autopilot may set
  // No offer sync kept yet: every offer disabled at the first read is listed.
  autopilot.setConfig({ sellEnabled: false });
  autopilot.setConfig({ sellEnabled: true });
  await autopilot.runOnce();
  assert.deepEqual([big.status, free.status], ["DISABLED", "DISABLED"]);
  assert.match(
    entryOf(autopilot, big.id)?.differences.join("; ") ?? "",
    /Liquidity provision was switched on, so it is listed again once its smallest channel \(1,000,000 sat\) can be funded — [\d,]+ sat sellable after the reserve, promised orders and the deploy cap; "keep disabled" on Market → Sell keeps it off/,
  );
  // (Fundable: capital safety's own refusal — it never lists an offer without a price.)
  assert.match(entryOf(autopilot, free.id)?.differences.join("; ") ?? "", /left as it is: it has no price on Amboss \(0 ppm \+ 0 sat\) — listed again once it has one/);
  const alerts = offerPriceAlerts(autopilot.offerSyncStatus(), autopilot.actsOnOffers()).map((a) => a.message);
  const priceless = alerts.find((m) => m.includes(`${free.id.slice(0, 8)}… isn't listed yet: it has no price (0 ppm + 0 sat)`));
  assert.ok(priceless, alerts.join(" | "));
  assert.doesNotMatch(priceless, /auto-pricing/, "its terms are the operator's: the autopilot never prices it");

  // Capital comes back: the big one is listed. The free one still has no price: still not.
  node.chainBalance = 8_000_000;
  await autopilot.runOnce();
  assert.deepEqual([big.status, free.status], ["ENABLED", "DISABLED"]);
  // The operator gives it a price (an edit on amboss.tech): listed by the next run.
  free.feeRatePpm = 2500;
  await autopilot.runOnce();
  assert.equal(free.status, "ENABLED");
  neverSentFree(magma);
});

test("with auto-pricing on, an offer at 0 ppm + 0 sat found disabled at the switch-on gets its last price while it waits — and is listed at the autopilot's price once there is one", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoReprice: true } });
  const { autopilot, magma, market } = s;
  market.behaviour = "throw"; // no engine price: the one it last had is what there is
  const offer = magma.addOffer({ ...PRICED, feeRatePpm: 4435, baseFeeSats: 0 });
  await autopilot.runOnce(); // seen at 4,435 (remembered)
  await switchOff(s, [offer]);
  offer.feeRatePpm = 0; // 0.8.0's partial writes left it at nothing
  autopilot.setConfig({ sellEnabled: true });
  await autopilot.runOnce();
  assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["DISABLED", 4435, 0], "priced at its last price while off — not listed at it");
  assert.equal(entryOf(autopilot, offer.id)?.listingWaits, "report");
  market.behaviour = "ok";
  const engine = (await autopilot.magmaReport()).sell.recommendations.find((r) => r.offerId === offer.id)!.recommended;
  await autopilot.runOnce();
  assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["ENABLED", engine.feeRatePpm, engine.baseFeeSat]);
  neverSentFree(magma);
});

test("an offer whose terms the autopilot sets is listed again only at the autopilot's current price: with no market report it waits, saying so, and is listed the run the report is back", async (t) => {
  quiet(t);
  for (const path of ["switch-on", "capital safety"] as const) {
    const s = pricedMarket(t, path === "capital safety" ? 500_000 : 8_000_000);
    const { autopilot, magma, market, node } = s;
    const offer = magma.addOffer({ ...PRICED, feeRatePpm: 300, baseFeeSats: 100, ...(path === "switch-on" ? { status: "DISABLED" } : {}) });
    if (path === "switch-on") {
      autopilot.offerStatusSetByHand(offer.id, "DISABLED");
      autopilot.setConfig({ sellEnabled: false });
      autopilot.setConfig({ sellEnabled: true });
    } else {
      await autopilot.runOnce(); // can't be funded: disabled by capital safety
      assert.equal(offer.status, "DISABLED");
      [offer.feeRatePpm, offer.baseFeeSats] = [300, 100];
      node.chainBalance = 8_000_000;
    }
    market.behaviour = "throw"; // Amboss's public book down this run
    await autopilot.runOnce();
    assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["DISABLED", 300, 100], `${path}: before, listed at 300 + 100`);
    const e = entryOf(autopilot, offer.id);
    assert.match(e?.differences.join("; ") ?? "", /^waits for the autopilot's price before it is listed again: there is no market report for it this run — tried again next run/, path);
    assert.equal(e?.listingWaits, "report");
    market.behaviour = "ok";
    const engine = (await autopilot.magmaReport()).sell.recommendations.find((r) => r.offerId === offer.id)!.recommended;
    await autopilot.runOnce();
    assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["ENABLED", engine.feeRatePpm, engine.baseFeeSat], path);
    assert.match(entryOf(autopilot, offer.id)?.lastWrite?.reason ?? "", /listed at the autopilot's price/);
  }
});

test("with auto-size off and a lease the autopilot doesn't price (5,000 blocks), the offer waits for its operator — an alert says what to do; once they set its price it is listed at theirs", async (t) => {
  quiet(t);
  const s = pricedMarket(t);
  const { autopilot, magma } = s;
  const offer = magma.addOffer({ ...PRICED, status: "DISABLED", feeRatePpm: 300, baseFeeSats: 100, minBlockLength: 5000 });
  autopilot.offerStatusSetByHand(offer.id, "DISABLED");
  autopilot.setConfig({ sellEnabled: false });
  autopilot.setConfig({ sellEnabled: true });
  await autopilot.runOnce();
  await autopilot.runOnce();
  assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["DISABLED", 300, 100], "before: listed at 300 + 100, never repriced");
  const e = entryOf(autopilot, offer.id);
  assert.match(e?.differences.join("; ") ?? "", /waits for the autopilot's price before it is listed again: its 5,000-block lease isn't one the autopilot prices .* set its price or its lease on Market → Sell, or turn on auto-size/);
  assert.equal(e?.listingWaits, "lease");
  const alerts = offerPriceAlerts(autopilot.offerSyncStatus(), autopilot.actsOnOffers()).map((a) => a.message);
  assert.ok(alerts.some((m) => m.includes(`${offer.id.slice(0, 8)}… isn't listed again: its 5,000-block lease isn't one the autopilot prices`)), alerts.join(" | "));
  // The operator sets its price (an edit on Market → Sell makes its terms theirs).
  autopilot.pauseOfferAutomation(offer.id, "you edited this offer");
  [offer.feeRatePpm, offer.baseFeeSats] = [5200, 600];
  await autopilot.runOnce();
  assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats, offer.minBlockLength], ["ENABLED", 5200, 600, 5000]);
  assert.match(entryOf(autopilot, offer.id)?.lastWrite?.reason ?? "", /— listed at your price, 5,200 ppm \+ 600 sat$/);
});

test("with selling on, an offer disabled by hand stays off — one disabled right after the switch-on too; switching off ends what a switch-on still had to list", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000 });
  const { autopilot, magma, node } = s;
  const a = magma.addOffer(PRICED);
  const b = magma.addOffer(PRICED);
  await autopilot.runOnce();
  // Disabled by hand while selling is on: it sticks, run after run.
  a.status = "DISABLED";
  autopilot.offerStatusSetByHand(a.id, "DISABLED", await getMyOffer("test-key", a.id));
  await autopilot.runOnce();
  await autopilot.runOnce();
  assert.equal(a.status, "DISABLED");
  assert.match(entryOf(autopilot, a.id)?.differences.join("; ") ?? "", /disabled by you — the autopilot leaves it disabled/);

  // Off and on: a is listed again — but b, disabled right after the switch-on
  // (before the first offer read), stays off.
  await switchOff(s, [a, b]);
  autopilot.setConfig({ sellEnabled: true });
  await later();
  autopilot.offerStatusSetByHand(b.id, "DISABLED");
  await autopilot.runOnce();
  assert.deepEqual([a.status, b.status], ["ENABLED", "DISABLED"]);

  // A switch-on's pending listing ends with the switch-off.
  node.chainBalance = 500_000;
  const c = magma.addOffer({ ...PRICED, status: "DISABLED" });
  await autopilot.runOnce(); // the offer sync knows c, disabled
  await switchOff(s, [a]);
  autopilot.setConfig({ sellEnabled: true });
  await autopilot.runOnce(); // c can't be funded: pending
  assert.ok(controlOf(autopilot, c.id).listOnAt, "to be listed once it can be funded");
  autopilot.setConfig({ sellEnabled: false });
  assert.equal(controlOf(autopilot, c.id).listOnAt, undefined, "switched off: not to be listed any more");
});

test("only the offers disabled at the switch are listed: one disabled on amboss.tech after it — while Amboss couldn't be read — stays off", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000 });
  const { autopilot, magma } = s;
  const offer = magma.addOffer(PRICED);
  await autopilot.runOnce(); // the offer sync: listed
  autopilot.setConfig({ sellEnabled: false }); // "turn off only": it stays listed
  autopilot.setConfig({ sellEnabled: true });
  magma.readBehaviour = "throw";
  await autopilot.runOnce(); // Amboss down: the switch-on waits for an offer read
  offer.status = "DISABLED"; // meanwhile, on amboss.tech
  magma.readBehaviour = "ok";
  await autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "before: listed again — it was listed at the switch, so disabled after it");
  assert.equal(controlOf(autopilot, offer.id).listOnAt, undefined);
});

test("a switch-on's listing ends once the offer is listed by anyone — so a later disable on amboss.tech sticks", async (t) => {
  quiet(t);
  for (const listedBy of ["the switch-on", "amboss.tech", "the operator's Enable"] as const) {
    const s = sellerSetup(t, { chainBalance: 8_000_000 });
    const { autopilot, magma } = s;
    // The switch-on lists it itself; for the others it has no price yet (its
    // terms the operator's): pending after the switch-on.
    const offer = magma.addOffer({ ...PRICED, status: "DISABLED", ...(listedBy === "the switch-on" ? {} : { feeRatePpm: 0, baseFeeSats: 0 }) });
    if (listedBy !== "the switch-on") autopilot.pauseOfferAutomation(offer.id, "you edited this offer");
    autopilot.setConfig({ sellEnabled: false });
    autopilot.setConfig({ sellEnabled: true });
    await autopilot.runOnce();
    if (listedBy === "the switch-on") {
      assert.equal(offer.status, "ENABLED");
    } else {
      assert.ok(controlOf(autopilot, offer.id).listOnAt, listedBy);
      // Priced and listed — on amboss.tech (seen by a run), or with Enable on Market → Sell.
      offer.feeRatePpm = 2500;
      offer.status = "ENABLED";
      if (listedBy === "amboss.tech") await autopilot.runOnce();
      else autopilot.offerStatusSetByHand(offer.id, "ENABLED");
    }
    // Then disabled on amboss.tech, which LightningMate keeps no record of.
    offer.status = "DISABLED";
    await autopilot.runOnce();
    assert.equal(offer.status, "DISABLED", `${listedBy}: the switch-on's listing was done — not a standing order to relist`);
  }
});

test("a disabled offer is listed only once the terms it is listed with are on Amboss — at the engine's price, never at the stale one; a write not taken keeps it off, saying why", async (t) => {
  quiet(t);
  for (const write of ["taken", "refused", "answered but not kept"] as const) {
    const taken = write === "taken";
    const s = pricedMarket(t);
    const { autopilot, magma } = s;
    // Disabled long ago at a price far below the profit floor (not free).
    const offer = magma.addOffer({ ...PRICED, status: "DISABLED", feeRatePpm: 300, baseFeeSats: 100 });
    autopilot.offerStatusSetByHand(offer.id, "DISABLED");
    autopilot.setConfig({ sellEnabled: false });
    autopilot.setConfig({ sellEnabled: true });
    const engine = (await autopilot.magmaReport()).sell.recommendations.find((r) => r.offerId === offer.id)!.recommended;
    const ops: string[] = [];
    magma.onMutation = (op) => ops.push(op === "ToggleOffer" ? `listed at ${offer.feeRatePpm}+${offer.baseFeeSats}` : op);
    if (write === "refused") magma.behave.UpdateOffer = "false";
    if (write === "answered but not kept") magma.behave.UpdateOffer = "lie"; // success, the old terms kept
    await autopilot.runOnce();
    magma.onMutation = null;
    if (taken) {
      assert.deepEqual(ops, ["UpdateOffer", `listed at ${engine.feeRatePpm}+${engine.baseFeeSat}`], "before: listed at 300+100 first, repriced after");
      assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["ENABLED", engine.feeRatePpm, engine.baseFeeSat]);
      assert.match(entryOf(autopilot, offer.id)?.lastWrite?.reason ?? "", /after its terms were written: before it is listed again: priced at the engine's/);
    } else {
      assert.ok(!ops.some((o) => o.startsWith("listed")), `${write}: never listed at the stale price: ${ops.join(", ")}`);
      assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["DISABLED", 300, 100], write);
      assert.match(entryOf(autopilot, offer.id)?.differences.join("; ") ?? "", /not listed again: the terms it is to be listed with weren't taken/, write);
    }
  }
});

test("capital safety's relist goes the same way: an offer disabled for lack of capital at a stale price is priced before it is listed again", async (t) => {
  quiet(t);
  const s = pricedMarket(t, 500_000);
  const { autopilot, magma, node } = s;
  const offer = magma.addOffer({ ...PRICED, feeRatePpm: 300, baseFeeSats: 100 });
  await autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "disabled for lack of capital");
  assert.ok(controlOf(autopilot, offer.id).autoDisabledAt);
  [offer.feeRatePpm, offer.baseFeeSats] = [300, 100]; // still stale
  node.chainBalance = 8_000_000;
  const ops: string[] = [];
  magma.onMutation = (op) => ops.push(op === "ToggleOffer" ? `listed at ${offer.feeRatePpm}+${offer.baseFeeSats}` : op);
  await autopilot.runOnce();
  magma.onMutation = null;
  assert.equal(offer.status, "ENABLED");
  assert.equal(ops[0], "UpdateOffer", ops.join(", "));
  assert.ok(ops.some((o) => o.startsWith("listed")) && !ops.includes("listed at 300+100"), ops.join(", "));
});

test("an offer whose max channel can't be funded is cut before it is listed — the operator's own too, its price kept; a cut not taken keeps it off", async (t) => {
  quiet(t);
  for (const variant of ["autopilot's terms", "operator's terms", "cut not taken"] as const) {
    const s = sellerSetup(t, { chainBalance: 1_800_000 }); // ~1.7M sellable: min 1M fundable, max 5M not
    const { autopilot, magma } = s;
    const offer = magma.addOffer({ ...PRICED, maxSats: 5_000_000, totalSats: 5_000_000, status: "DISABLED" });
    if (variant === "operator's terms") autopilot.pauseOfferAutomation(offer.id, "you edited this offer");
    if (variant === "cut not taken") magma.behave.UpdateOffer = "false";
    autopilot.setConfig({ sellEnabled: false });
    autopilot.setConfig({ sellEnabled: true });
    const maxAtListing: number[] = [];
    magma.onMutation = (op) => void (op === "ToggleOffer" && maxAtListing.push(offer.maxSats));
    await autopilot.runOnce();
    magma.onMutation = null;
    if (variant === "cut not taken") {
      assert.deepEqual([offer.status, offer.maxSats, maxAtListing.length], ["DISABLED", 5_000_000, 0], "before: listed with a 5M max it can't fund");
      assert.match(entryOf(autopilot, offer.id)?.differences.join("; ") ?? "", /not listed again: the terms it is to be listed with weren't taken/);
      continue;
    }
    assert.equal(offer.status, "ENABLED", variant);
    assert.ok(offer.maxSats >= 1_000_000 && offer.maxSats < 2_000_000, `${variant}: max ${offer.maxSats}`);
    assert.deepEqual(maxAtListing, [offer.maxSats], `${variant}: cut before it was listed`);
    assert.deepEqual([offer.feeRatePpm, offer.baseFeeSats], [3000, 568], `${variant}: its price kept`);
  }
});

test("selling switched off while a flip that lists an offer is on its way — the dialog saw nothing listed: the offer is taken off the market again; a failure is raised", async (t) => {
  quiet(t);
  for (const [undo, by] of [["taken", "the switch-on"], ["fails", "the switch-on"], ["taken", "a free offer priced again"]] as const) {
    const s = sellerSetup(t, { chainBalance: 8_000_000, config: { sellAutoReprice: true } });
    const { autopilot, magma, market } = s;
    let offer;
    if (by === "the switch-on") {
      offer = magma.addOffer({ ...PRICED, status: "DISABLED" });
      autopilot.setConfig({ sellEnabled: false });
      autopilot.setConfig({ sellEnabled: true });
    } else {
      // Listed for free with no price known (no market report): taken off the
      // market — relistFree lists it again at the autopilot's price, once the
      // report is back.
      market.behaviour = "throw";
      offer = magma.addOffer({ ...PRICED, feeRatePpm: 0, baseFeeSats: 0 });
      await autopilot.runOnce();
      assert.ok(controlOf(autopilot, offer.id).freeDisabledAt);
      market.behaviour = "ok";
    }
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let seen = false;
    magma.holdMutation = (op) => {
      if (op !== "ToggleOffer" || seen) return null;
      seen = true;
      return held;
    };
    if (undo === "fails") magma.behave.ToggleOffer = (n) => (n === 1 ? "throw" : "ok");
    const run = autopilot.runOnce();
    for (let i = 0; i < 200 && !seen; i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(seen);
    // turnSellingOff: no offer is listed yet (the flip hasn't landed) — selling off.
    autopilot.setConfig({ sellEnabled: false });
    release();
    await run;
    const alerts = offerPriceAlerts(autopilot.offerSyncStatus(), autopilot.actsOnOffers()).map((a) => a.message);
    if (undo === "taken") {
      assert.equal(offer.status, "DISABLED", `${by}: before, left listed with selling off — its orders waiting for a decision nobody makes`);
      assert.ok(controlOf(autopilot, offer.id).disabledByHandAt, "recorded as the switch-off's disable");
      // (relistFree's undo that lands isn't a write the Sell page shows: the offer is as it was.)
      if (by === "a free offer priced again") continue;
    }
    const e = entryOf(autopilot, offer.id);
    assert.equal(e?.lastWrite?.action, "disable");
    assert.match(e?.lastWrite?.reason ?? "", /was switched off during the run while it was being listed — taken off the market again/);
    if (undo === "taken") {
      assert.ok(!alerts.some((m) => m.includes("listed although Liquidity provision is off")), alerts.join(" | "));
    } else {
      assert.equal(offer.status, "ENABLED");
      assert.ok(alerts.some((m) => m.includes(`${offer.id.slice(0, 8)}… is listed although Liquidity provision is off`)), alerts.join(" | "));
    }
  }
});

test("'keep disabled' on Market → Sell: the toggle route disables by state — nothing is flipped — and the switch-on's listing of it ends", async (t) => {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  new FakeMarket(http, t);
  const node = new FakeLnd({ chainBalance: 500_000 });
  const api = await startApi(t, { node });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  const offer = magma.addOffer({ ...PRICED, status: "DISABLED" });
  api.autopilot.setConfig({ sellEnabled: false, sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000 });
  api.autopilot.setConfig({ sellEnabled: true });
  await api.autopilot.runOnce(); // can't be funded: pending
  assert.ok(api.autopilot.offerControls()[offer.id]?.listOnAt);
  const res = await api.request("POST", "/amboss/offer/toggle", { id: offer.id, want: "DISABLED" });
  assert.deepEqual([res.status, res.body.status, res.body.changed], [200, "DISABLED", false]);
  assert.equal(magma.count("ToggleOffer"), 0, "nothing flipped");
  const control = api.autopilot.offerControls()[offer.id] ?? {};
  assert.equal(control.listOnAt, undefined);
  assert.ok(control.disabledByHandAt);
  node.chainBalance = 8_000_000;
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "kept off");
});

test("a switch-on read back from a damaged state file is made safe: a list that isn't one counts as none (every disabled offer), no time is no switch-on", async (t) => {
  quiet(t);
  for (const [saved, listed] of [
    [{ at: new Date().toISOString(), disabled: 5 }, true],
    [{ at: "not a time", disabled: [] }, false],
    ["garbage", false],
  ] as const) {
    const s = sellerSetup(t, { chainBalance: 8_000_000 });
    const offer = s.magma.addOffer({ ...PRICED, status: "DISABLED" });
    const file = join(s.dir, "autopilot.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.sellSwitchOn = saved;
    writeFileSync(file, JSON.stringify(state));
    const ap = s.restart();
    const run = await ap.runOnce(); // before: "disabled.includes is not a function"
    assert.deepEqual(run.sells.filter((x) => x.action === "error"), [], JSON.stringify(saved));
    assert.equal(offer.status, listed ? "ENABLED" : "DISABLED", JSON.stringify(saved));
  }
  assert.deepEqual(sanitizeSellSwitchOn({ at: "2026-10-24T10:00:00Z", disabled: ["a", 3, "b"] }), { at: "2026-10-24T10:00:00Z", disabled: ["a", "b"] });
  assert.equal(sanitizeSellSwitchOn(null), null);
});

test("a switch-on made while a run is under way, after its offer upkeep, gets one more run at once — never runs back to back on a failing read", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 8_000_000, config: { sellEnabled: false } });
  const { autopilot, magma } = s;
  const offer = magma.addOffer({ ...PRICED, status: "DISABLED" });
  const ap = autopilot as unknown as {
    kick: (fn: () => Promise<unknown>, ms: number) => void;
    runSell: () => Promise<unknown[]>;
  };
  const kicks: number[] = [];
  ap.kick = (_fn, ms) => void kicks.push(ms);
  const realRunSell = ap.runSell.bind(autopilot);
  // The operator switches selling on while the run is past its offer upkeep.
  ap.runSell = async () => {
    autopilot.setConfig({ sellEnabled: true });
    kicks.length = 0; // (the switch's own kicks: the busy run skips them)
    return [];
  };
  await autopilot.runOnce();
  assert.deepEqual(kicks, [2_000], "one more run, right away");
  assert.equal(offer.status, "DISABLED", "the busy run didn't list it");

  // The kicked run: its offer read fails. Not retried back to back — the
  // schedule tries again.
  ap.runSell = realRunSell;
  magma.readBehaviour = "throw";
  kicks.length = 0;
  await autopilot.runOnce();
  assert.deepEqual(kicks, [], "no run after a run that began after the switch");
  magma.readBehaviour = "ok";
  await autopilot.runOnce();
  assert.equal(offer.status, "ENABLED", "the next run lists it");
});
