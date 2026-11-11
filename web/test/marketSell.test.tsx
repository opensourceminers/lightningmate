/**
 * Market → Sell, rendered with its reads done (review 2026-11-10, WEB-1 and
 * ENG-1): what the page shows and offers when this node's offers were read,
 * are empty, could not be read or could not be refreshed — and with write
 * mode off.
 */
import "./helpers/browserGlobals";
import { all, button, buttons, newContainer, propsOf, settle, type El } from "./helpers/fakeDom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { forgetMagmaReport } from "../src/magmaReport";
import { OverlayProvider } from "../src/components/Overlay";
import { MarketSell } from "../src/components/MarketSell";
import { MarketBuy } from "../src/components/MarketBuy";
import type { MyOffer } from "../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const a = api as Record<string, any>;
/** The real request, kept before the tests below put their own in its place. */
const realCreateOffer = api.ambossCreateOffer;
const fail = (m: string) => () => Promise.reject(new Error(m));

const OFFER: MyOffer = {
  id: "offer-1",
  nodePubkey: "02".padEnd(66, "a"),
  status: "ENABLED",
  minSizeSats: 1_000_000,
  maxSizeSats: 2_000_000,
  totalSizeSats: 5_000_000,
  lockedSats: 0,
  availableSats: 5_000_000,
  baseFeeSats: 0,
  feeRatePpm: 4000,
  minBlockLength: 4320,
  feeRateCapPpm: 2200,
  baseFeeCapSats: 1,
  conditions: [],
  onchainPriority: null,
  onchainMultiplier: null,
  filledOrders: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const read = (offers: MyOffer[]) => async () => ({
  offers,
  sync: { offers: [] },
  controls: {},
  feeCaps: { feeRateCapPpm: 2200, baseFeeCapSats: 1 },
});

/** The page's reads other than the offers; `canWrite` is the write mode. */
function mockCommon(canWrite = true) {
  forgetMagmaReport();
  a.ambossStatus = async () => ({ connected: true, keyValid: true, keyCheck: "valid", lastError: null, saleFeeBps: 100, ordersInFlight: 0 });
  a.magmaRecommendations = fail("report not needed here");
  a.magmaEligibility = fail("eligibility not needed here");
  a.sellDiagnostics = fail("diagnostics not needed here");
  a.autopilotGet = async () => ({ config: { sellEnabled: false, sellAutoReprice: true, sellMaxChannelSats: 10_000_000, sellMaxDeploySats: 50_000_000 }, canWrite });
}

async function mount(component: Parameters<typeof h>[0] = MarketSell) {
  const c = newContainer();
  const root = createRoot(c as unknown as Element);
  root.render(h(OverlayProvider, null, h(component as any)));
  await settle();
  return { c, root };
}
const click = async (el: El | undefined, what: string) => {
  assert.ok(el, `${what} is on the page`);
  assert.notEqual(propsOf(el).disabled, true, `${what} is not disabled`);
  propsOf(el).onClick({ stopPropagation() {} });
  await settle();
};
const createButtons = (c: El) => all(c).filter((n) => n.nodeName === "BUTTON" && /^(Create offer|Create another offer|\+ Create another offer)$/.test(n.textContent.trim()));

test("WEB-1: the offers read FAILS — the page says so, shows no 'No offer yet' and no create form; Retry reads them", async () => {
  mockCommon();
  a.ambossMyOffers = fail("Amboss did not answer (502)");
  let created = 0;
  a.ambossCreateOffer = async () => {
    created++;
    return { ok: true, offerId: "x" };
  };
  const { c, root } = await mount();
  assert.match(c.textContent, /Couldn't read your offers from Amboss: Amboss did not answer \(502\)\./);
  assert.match(c.textContent, /Whether this node has an offer isn't known, so none can be created from here now\./);
  assert.doesNotMatch(c.textContent, /No offer yet/, "not read is not 'none'");
  assert.doesNotMatch(c.textContent, /New offer/, "no create form");
  assert.equal(createButtons(c).length, 0, "nothing to create an offer with");
  // Retry: the offer that was there all along shows, and still no create form.
  a.ambossMyOffers = read([OFFER]);
  await click(button(c, "Retry"), "Retry");
  assert.doesNotMatch(c.textContent, /Couldn't read your offers/);
  assert.match(c.textContent, /4,000 ppm/);
  assert.doesNotMatch(c.textContent, /New offer/);
  assert.equal(created, 0);
  root.unmount();
});

test("WEB-1: the offers read is STILL UNDER WAY — 'Reading your offers', no create form", async () => {
  mockCommon();
  a.ambossMyOffers = () => new Promise(() => {});
  const { c, root } = await mount();
  assert.match(c.textContent, /Reading your offers from Amboss…/);
  assert.doesNotMatch(c.textContent, /No offer yet/);
  assert.equal(createButtons(c).length, 0);
  root.unmount();
});

test("the offers are read and there is none: the create form is open, and the create is sent as a first offer", async () => {
  mockCommon();
  a.ambossMyOffers = read([]);
  const sent: unknown[][] = [];
  a.ambossCreateOffer = async (...args: unknown[]) => {
    sent.push(args);
    return { ok: true, offerId: "x" };
  };
  const { c, root } = await mount();
  assert.match(c.textContent, /No offer yet — create one below\./);
  assert.match(c.textContent, /New offer/);
  await click(button(c, "Create offer"), "Create offer");
  assert.match(c.textContent, /Create sell offer/);
  assert.doesNotMatch(c.textContent, /SECOND/);
  // The dialog's own button (the last of that name) confirms.
  await click(buttons(c, "Create offer").at(-1), "the dialog's Create offer");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![1], false, "not marked as a further offer");
  root.unmount();
});

test("an offer is there: no form until 'Create another offer' — whose dialog names the SECOND offer and whose create says it is meant", async () => {
  mockCommon();
  a.ambossMyOffers = read([OFFER]);
  const sent: unknown[][] = [];
  a.ambossCreateOffer = async (...args: unknown[]) => {
    sent.push(args);
    return { ok: true, offerId: "y" };
  };
  const { c, root } = await mount();
  assert.doesNotMatch(c.textContent, /Another offer \(it lists a second one\)/);
  await click(button(c, "+ Create another offer"), "+ Create another offer");
  assert.match(c.textContent, /Another offer \(it lists a second one\)/);
  await click(button(c, "Create another offer"), "the form's Create another offer");
  assert.match(c.textContent, /You already have an offer — this lists a SECOND one\./);
  await click(buttons(c, "Create another offer").at(-1), "the dialog's Create another offer");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![1], true, "sent as a further offer: the server refuses a create beside an offer without it");
  root.unmount();
});

test("R2-8: an older offers read that answers late doesn't replace the newer one — the offer stays, no 'No offer yet', no create form", async () => {
  mockCommon();
  a.ambossMyOffers = fail("Amboss did not answer (502)");
  const { c, root } = await mount();
  // Two Retry clicks: two reads under way, answered in the other order.
  const answers: ((r: unknown) => void)[] = [];
  a.ambossMyOffers = () => new Promise((resolve) => answers.push(resolve));
  await click(button(c, "Retry"), "Retry");
  await click(button(c, "Retry"), "Retry, a second time");
  assert.equal(answers.length, 2);
  answers[1]!(await read([OFFER])());
  await settle();
  assert.match(c.textContent, /4,000 ppm/, "the newer read's offer shows");
  // The older read answers now — with the empty list of before the offer was there.
  answers[0]!(await read([])());
  await settle();
  assert.match(c.textContent, /4,000 ppm/, "and stays");
  assert.doesNotMatch(c.textContent, /No offer yet/);
  assert.doesNotMatch(c.textContent, /New offer/, "no form for a new offer beside the one that exists");
  assert.equal(createButtons(c).filter((b) => b.textContent.trim() === "Create offer").length, 0);
  root.unmount();
});

test("R2-8: an older read that FAILS late doesn't mark the newer one's offers as not refreshed", async () => {
  mockCommon();
  a.ambossMyOffers = fail("Amboss did not answer (502)");
  const { c, root } = await mount();
  const calls: { resolve: (r: unknown) => void; reject: (e: Error) => void }[] = [];
  a.ambossMyOffers = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  await click(button(c, "Retry"), "Retry");
  await click(button(c, "Retry"), "Retry, a second time");
  calls[1]!.resolve(await read([OFFER])());
  await settle();
  calls[0]!.reject(new Error("timed out"));
  await settle();
  assert.match(c.textContent, /4,000 ppm/);
  assert.doesNotMatch(c.textContent, /Couldn't refresh your offers|Couldn't read your offers/);
  root.unmount();
});

test("M2: after the first create the page reads the offers again — until that read answers it shows no 'No offer yet', no New-offer form and no create button", async () => {
  mockCommon();
  a.ambossMyOffers = read([]);
  let sent = 0;
  let answer: ((r: unknown) => void) | undefined;
  a.ambossCreateOffer = async () => {
    sent++;
    // The reload's offers read is held open.
    a.ambossMyOffers = () => new Promise((resolve) => (answer = resolve));
    return { ok: true, offerId: "offer-1" };
  };
  const { c, root } = await mount();
  await click(button(c, "Create offer"), "Create offer");
  await click(buttons(c, "Create offer").at(-1), "the dialog's Create offer");
  assert.equal(sent, 1);
  assert.ok(answer, "the offers are being read again");
  // (Before: "No offer yet — create one below." with the form open and its
  // button live — a second click sent a second create.)
  assert.match(c.textContent, /Reading your offers from Amboss…/);
  assert.doesNotMatch(c.textContent, /No offer yet/);
  assert.doesNotMatch(c.textContent, /New offer/);
  assert.equal(createButtons(c).length, 0, "nothing to create a second one with");
  answer(await read([OFFER])());
  await settle();
  assert.match(c.textContent, /4,000 ppm/, "the offer shows once the read answers");
  assert.doesNotMatch(c.textContent, /No offer yet/);
  assert.equal(sent, 1);
  root.unmount();
});

test("M1: 'another' goes out in the request — a further offer is sent with another: true, a first one without the field", async (t) => {
  const bodies: unknown[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    bodies.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, offerId: "x" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = savedFetch;
  });
  const terms = { minSizeSats: 1_000_000, maxSizeSats: 2_000_000, totalSizeSats: 5_000_000, feeRatePpm: 4000, baseFeeSats: 0, minBlockLength: 4320 };
  await realCreateOffer(terms as Parameters<typeof realCreateOffer>[0], true);
  await realCreateOffer(terms as Parameters<typeof realCreateOffer>[0]);
  assert.deepEqual(bodies, [
    { url: "/api/amboss/offer", method: "POST", body: { ...terms, another: true } },
    { url: "/api/amboss/offer", method: "POST", body: terms },
  ]);
});

test("R2-12: 'Create another offer' is asked once — with the second offer made the form closes, it doesn't stand open for a third", async () => {
  mockCommon();
  a.ambossMyOffers = read([OFFER]);
  a.ambossCreateOffer = async () => {
    a.ambossMyOffers = read([OFFER, { ...OFFER, id: "offer-2" }]);
    return { ok: true, offerId: "offer-2" };
  };
  const { c, root } = await mount();
  await click(button(c, "+ Create another offer"), "+ Create another offer");
  await click(button(c, "Create another offer"), "the form's Create another offer");
  await click(buttons(c, "Create another offer").at(-1), "the dialog's Create another offer");
  assert.doesNotMatch(c.textContent, /Another offer \(it lists a second one\)/, "the form is closed");
  assert.match(c.textContent, /Your offers/);
  assert.ok(button(c, "+ Create another offer"), "a third one has to be asked for again");
  root.unmount();
});

test("WEB-1: a refresh that fails keeps the offers last read, says so — and offers no second one from the stale list", async () => {
  mockCommon();
  a.ambossMyOffers = read([OFFER]);
  a.ambossToggleOffer = async () => ({ status: "DISABLED", changed: true });
  const { c, root } = await mount();
  assert.ok(button(c, "+ Create another offer"));
  // The reload after a click finds Amboss down.
  a.ambossMyOffers = fail("Amboss unreachable");
  await click(button(c, "disable"), "disable");
  assert.match(c.textContent, /Couldn't refresh your offers from Amboss \(Amboss unreachable\) — shown as last read\./);
  assert.match(c.textContent, /4,000 ppm/, "the offer stays on the page");
  assert.equal(button(c, "+ Create another offer"), undefined);
  assert.ok(button(c, "Retry"));
  root.unmount();
});

test("ENG-1: write mode off — the page says so; create and enable are disabled, disable stays", async () => {
  mockCommon(false);
  a.ambossMyOffers = read([OFFER, { ...OFFER, id: "offer-2", status: "DISABLED" }]);
  const { c, root } = await mount();
  assert.match(c.textContent, /Creating, changing and listing an offer are disabled — write mode is off/);
  assert.match(c.textContent, /You can still disable an offer\./);
  assert.equal(button(c, "+ Create another offer"), undefined);
  const enable = button(c, "enable");
  assert.equal(propsOf(enable!).disabled, true);
  assert.match(String(propsOf(enable!).title), /write mode is off/);
  assert.notEqual(propsOf(button(c, "disable")!).disabled, true, "taking an offer off the market needs no write mode");
  // An edit can be looked at, not saved.
  await click(buttons(c, "edit")[0], "edit");
  const save = button(c, "Save changes");
  assert.equal(propsOf(save!).disabled, true);
  root.unmount();

  // With none: no create form's button to press.
  mockCommon(false);
  a.ambossMyOffers = read([]);
  const second = await mount();
  assert.match(second.c.textContent, /No offer yet\./);
  assert.equal(propsOf(button(second.c, "Create offer")!).disabled, true);
  second.root.unmount();
});

test("ENG-1: Market → Buy with write mode off — buying is disabled and says why; browsing stays", async () => {
  a.ambossStatus = async () => ({ connected: true, keyValid: true, keyCheck: "valid", lastError: null, saleFeeBps: 100, ordersInFlight: 0 });
  a.ambossBuyOffers = async () => ({ offers: [], inboundSatsPerUsd: null, satsPerUsd: null });
  a.ambossPurchases = async () => [];
  a.autopilotGet = async () => ({ config: {}, canWrite: false });
  let quoted = 0;
  a.ambossBuyQuote = async () => {
    quoted++;
    throw new Error("must not be asked");
  };
  const { c, root } = await mount(MarketBuy);
  assert.match(c.textContent, /Buying is disabled — write mode is off/);
  const buy = button(c, "Buy inbound");
  assert.equal(propsOf(buy!).disabled, true);
  assert.notEqual(propsOf(button(c, "Rank at this size")!).disabled, true);
  assert.equal(quoted, 0);
  root.unmount();

  // Write mode on: no banner, the button works as before.
  a.autopilotGet = async () => ({ config: {}, canWrite: true });
  const on = await mount(MarketBuy);
  assert.doesNotMatch(on.c.textContent, /Buying is disabled/);
  assert.notEqual(propsOf(button(on.c, "Buy inbound")!).disabled, true);
  on.root.unmount();
});
