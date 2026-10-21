/**
 * Who decides what about an offer (a6-ux:offer-controls-fight-autopilot). An
 * offer the operator edited or created on Market → Sell is theirs: the
 * autopilot changes none of its terms until the operator hands it back. Its
 * listing follows the operator's last click: one they disabled stays
 * disabled, one they enabled is listed — and a click on enable/disable never
 * takes the terms over. Only capital safety still applies to every offer: it
 * is disabled while its smallest channel can't be funded, and listed again
 * once it can.
 *
 * Before: with Liquidity provision on, a manual "disable" was reverted within
 * half an hour (every DISABLED offer was re-enabled), manual price edits were
 * overwritten unrecorded, size and lease edits under a "relist" entry. Then
 * (review P1b) a manual ENABLE took the offer over: the autopilot stopped
 * fixing its lease and fee promise, and never listed it again after a capital
 * dip, with a note saying "disabled by you".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { sellerSetup } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import type { AfterHook } from "./helpers/tmp.js";
import { until } from "./helpers/wait.js";

/** The API with Liquidity provision on (auto-size on: it would fix the lease). */
async function sellingApi(t: AfterHook, chainBalance = 5_000_000) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const market = new FakeMarket(http, t);
  const api = await startApi(t, { node: new FakeLnd({ chainBalance }) });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  api.autopilot.setConfig({ sellEnabled: true, sellAutoSize: true, sellAutoReprice: false, sellMaxDeploySats: 50_000_000, sellMaxChannelSats: 10_000_000 });
  return { api, magma, market };
}

const TERMS = { totalSizeSats: 2_000_000, minSizeSats: 1_000_000, maxSizeSats: 2_000_000, feeRatePpm: 3000, baseFeeSats: 852 };

test("a manual disable sticks: the autopilot never enables an offer the operator disabled", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  const off = await api.request("POST", "/amboss/offer/toggle", { id: offer.id });
  assert.equal(off.body.status, "DISABLED");
  await api.autopilot.runOnce();
  await api.autopilot.runOnce();
  // Before: "Magma enable" within the next run — the click undone.
  assert.equal(offer.status, "DISABLED");
  assert.equal(magma.count("ToggleOffer"), 1, "only the operator's own click");
  const entry = api.autopilot.offerSyncStatus().offers.find((e) => e.offerId === offer.id);
  assert.match(entry?.differences.join() ?? "", /disabled by you — the autopilot leaves it disabled/);
  assert.ok(entry?.control?.disabledByHandAt, "the listing is the operator's");
  assert.equal(entry?.control?.manual, undefined, "a status click doesn't take the terms over");
});

test("a manual ENABLE lists the offer without taking it over: the autopilot still fixes its lease and promise, disables it in a capital dip and lists it again after — saying why", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t, 3_000_000);
  const offer = magma.addOffer({ status: "DISABLED", minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, minBlockLength: 4032 });
  // The operator lists it again by hand.
  const on = await api.request("POST", "/amboss/offer/toggle", { id: offer.id });
  assert.equal(on.body.status, "ENABLED");
  assert.equal(api.autopilot.offerControls()[offer.id]?.manual, undefined, "not taken over");
  await api.autopilot.runOnce();
  // Before: the enable made the offer "yours" — the 4,032-block lease and the
  // missing promise stayed for good.
  assert.equal(offer.minBlockLength, 4320, "auto-size still sets the standard lease");
  assert.equal(offer.feeRateCap, "2200", "and the routing-fee promise");
  // Capital drops: capital safety disables it …
  api.node.chainBalance = 500_000;
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED");
  const dip = api.autopilot.offerSyncStatus().offers.find((e) => e.offerId === offer.id);
  assert.match(dip?.differences.join() ?? "", /disabled by the autopilot for lack of capital: its smallest channel \(1,000,000 sat\) can't be funded/);
  assert.doesNotMatch(dip?.differences.join() ?? "", /disabled by you/);
  // … and lists it again once capital is back.
  api.node.chainBalance = 3_000_000;
  await api.autopilot.runOnce();
  assert.equal(offer.status, "ENABLED", "the listing the operator chose, restored");
});

test("Turning selling off disables by STATE, not by flip: an offer already disabled is left alone, a refused flip is an error — never a silent success", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t);
  const listed = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  const already = magma.addOffer({ status: "DISABLED", minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  // Already disabled (the autopilot disabled it in between): a flip would
  // have ENABLED it. With want=DISABLED nothing is sent.
  const same = await api.request("POST", "/amboss/offer/toggle", { id: already.id, want: "DISABLED" });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body, { status: "DISABLED", changed: false });
  assert.equal(magma.count("ToggleOffer"), 0);
  assert.equal(already.status, "DISABLED");
  // Amboss answers but doesn't flip it: an error, not "disabled".
  magma.behave.ToggleOffer = "lie";
  const refused = await api.request("POST", "/amboss/offer/toggle", { id: listed.id, want: "DISABLED" });
  assert.equal(refused.status, 502);
  assert.equal(refused.body.status, "ENABLED");
  assert.match(refused.body.message, /not disabled/);
  magma.behave.ToggleOffer = "ok";
  const done = await api.request("POST", "/amboss/offer/toggle", { id: listed.id, want: "DISABLED" });
  assert.deepEqual(done.body, { status: "DISABLED", changed: true });
  assert.equal(listed.status, "DISABLED");
  assert.equal((await api.request("POST", "/amboss/offer/toggle", { id: listed.id, want: "PAUSED" })).status, 400);
});

test("'disable' clicked on an offer the autopilot had just disabled for lack of capital: nothing is flipped, and the click sticks — it is not listed again when capital returns", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t, 500_000);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "capital safety");
  assert.ok(api.autopilot.offerControls()[offer.id]?.autoDisabledAt);
  // The operator's page still showed it listed: they click "disable".
  const res = await api.request("POST", "/amboss/offer/toggle", { id: offer.id, want: "DISABLED" });
  assert.deepEqual(res.body, { status: "DISABLED", changed: false });
  assert.equal(magma.count("ToggleOffer"), 1, "only the autopilot's own disable");
  api.node.chainBalance = 3_000_000;
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "the operator's 'disable' wins over the autopilot's 'list it again'");
});

test("an offer that was disabled before this version (nobody on record) is not enabled either — only one the autopilot disabled itself", async (t) => {
  quiet(t);
  const { autopilot, magma, node } = sellerSetup(t, { chainBalance: 3_000_000 });
  const old = magma.addOffer({ status: "DISABLED", minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await autopilot.runOnce();
  assert.equal(old.status, "DISABLED");
  // One the autopilot disabled for lack of capital comes back with it.
  const mine = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  node.chainBalance = 500_000;
  await autopilot.runOnce();
  assert.equal(mine.status, "DISABLED");
  node.chainBalance = 3_000_000;
  await autopilot.runOnce();
  assert.equal(mine.status, "ENABLED");
  assert.equal(old.status, "DISABLED");
});

test("a manual edit keeps its terms — no lease or promise change, no reprice — until the operator hands the offer back; then the autopilot manages it again", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, minBlockLength: 4320 });
  // The operator deliberately sells 90-day leases.
  const edit = await api.request("POST", "/amboss/offer/update", { id: offer.id, ...TERMS, minBlockLength: 12_960 });
  assert.equal(edit.status, 200);
  const writes = magma.count("UpdateOffer");
  await api.autopilot.runOnce();
  // Before: auto-size set it back to the popular lease at the next run.
  assert.equal(offer.minBlockLength, 12_960);
  assert.equal(magma.count("UpdateOffer"), writes, "nothing written over the operator's terms");
  const listed = await api.request("GET", "/amboss/my-offers");
  assert.equal(listed.body.controls[offer.id]?.manual?.why, "you edited this offer");

  const back = await api.request("POST", "/amboss/offer/automation", { id: offer.id, managed: true });
  assert.equal(back.status, 200);
  await api.autopilot.runOnce();
  assert.equal(offer.minBlockLength, 4320, "managed again: the standard lease");
});

test("an offer created on Market → Sell is the operator's: with auto-price, auto-size and auto-relist on, the autopilot reprices, resizes, re-leases and relists none of it", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t);
  api.autopilot.setConfig({ sellAutoReprice: true, sellAutoRelist: true });
  // Terms every switch would change: far above the floor, a narrow window, a
  // 60-day lease — and, after a sale locked some of it, depleted.
  const created = await api.request("POST", "/amboss/offer", { totalSizeSats: 1_100_000, minSizeSats: 1_000_000, maxSizeSats: 1_050_000, feeRatePpm: 20_000, baseFeeSats: 852, minBlockLength: 8640 });
  assert.equal(created.status, 200);
  const offer = magma.offers.get(created.body.offerId)!;
  offer.lockedSats = 500_000;
  const writes = magma.count("UpdateOffer");
  await api.autopilot.runOnce();
  // Before (not recorded as the operator's): repriced, resized, set to 4,320
  // blocks and topped up behind their back.
  assert.equal(magma.count("UpdateOffer"), writes, "nothing written over the operator's terms");
  assert.deepEqual(
    [offer.feeRatePpm, offer.minBlockLength, offer.minSats, offer.maxSats, offer.totalSats],
    [20_000, 8640, 1_000_000, 1_050_000, 1_100_000],
  );
  assert.equal(api.autopilot.offerControls()[offer.id]?.manual?.why, "you created this offer by hand");
});

test("auto-relist tops up only offers the autopilot manages — a depleted offer the operator took over stays as they left it", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t);
  api.autopilot.setConfig({ sellAutoSize: false, sellAutoRelist: true });
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, minBlockLength: 4320, feeRateCap: "2200", baseFeeCap: "1" });
  const edit = await api.request("POST", "/amboss/offer/update", { id: offer.id, ...TERMS, minBlockLength: 4320 });
  assert.equal(edit.status, 200);
  // A sale locked 1.5M: 500k left to sell, below the 2M max channel.
  offer.lockedSats = 1_500_000;
  const writes = magma.count("UpdateOffer");
  await api.autopilot.runOnce();
  assert.equal(magma.count("UpdateOffer"), writes, "before: 'sold out — topped back up' over the operator's own listing");
  assert.equal(offer.totalSats, 2_000_000);
  // Handed back: now the autopilot tops it up.
  await api.request("POST", "/amboss/offer/automation", { id: offer.id, managed: true });
  await api.autopilot.runOnce();
  assert.equal(offer.totalSats, 1_500_000 + 2_000_000, "managed again: listed liquidity back up to the max channel");
});

test("capital safety still applies to the operator's offer: it is cut to what can be funded, disabled when not even its minimum can be — and listed again once it can, its terms still the operator's", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t, 3_000_000);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await api.request("POST", "/amboss/offer/update", { id: offer.id, ...TERMS, feeRatePpm: 4321, maxSizeSats: 5_000_000, totalSizeSats: 5_000_000, minBlockLength: 12_960 });
  await api.autopilot.runOnce();
  assert.equal(offer.maxSats, 2_940_000, "never advertises a channel the wallet can't fund");
  api.node.chainBalance = 500_000;
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED");
  api.node.chainBalance = 3_000_000;
  await api.autopilot.runOnce();
  // The operator had it listed; the autopilot only undoes its own disable.
  assert.equal(offer.status, "ENABLED");
  assert.deepEqual([offer.feeRatePpm, offer.minBlockLength], [4321, 12_960], "its terms are still the operator's");
  assert.equal(api.autopilot.offerControls()[offer.id]?.manual?.why, "you edited this offer");
});

// ── the autopilot's capital-safety flips vs everyone else's (review P1b) ──────
//
// Amboss's toggle FLIPS whatever the status is. The autopilot used to flip by
// the status it read at the start of its run — with the engine call and other
// offers' upkeep in between — and to write back the ownership record it read
// before the flip.

/** Mutations answer within `ms` (an "apply-then-hang" one runs into it). */
function mutationDeadline(t: AfterHook, ms: number): void {
  const saved = HTTP_TIMEOUTS.ambossMutationMs;
  HTTP_TIMEOUTS.ambossMutationMs = ms;
  t.after(() => {
    HTTP_TIMEOUTS.ambossMutationMs = saved;
  });
}

test("the operator's disable landing just before the autopilot's capital-safety disable: the offer stays DISABLED, the click on record — and it is not listed again when capital returns", async (t) => {
  quiet(t);
  // 400k on chain: a 1M minimum can't be funded — capital safety disables it.
  const { api, magma } = await sellingApi(t, 400_000);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  let raced = false;
  magma.onMutation = (op) => {
    if (op !== "ToggleOffer" || raced) return;
    raced = true;
    // The operator's disable reaches Amboss a moment before the autopilot's
    // flip (on amboss.tech, recorded here by a click).
    offer.status = "DISABLED";
    api.autopilot.offerStatusSetByHand(offer.id, "DISABLED");
  };
  await api.autopilot.runOnce();
  // Before: the autopilot's "disable" flip ENABLED it — unfundable, listed.
  assert.equal(offer.status, "DISABLED");
  assert.ok(api.autopilot.offerControls()[offer.id]?.disabledByHandAt, "the click is on record");
  assert.equal(api.autopilot.offerControls()[offer.id]?.autoDisabledAt, undefined, "the operator's disable, not the autopilot's");
  await api.autopilot.runOnce();
  // Before: the next run cleared the click ("listed again") and disabled it
  // for capital — so it came back with the capital.
  assert.equal(offer.status, "DISABLED");
  assert.ok(api.autopilot.offerControls()[offer.id]?.disabledByHandAt);
  api.node.chainBalance = 5_000_000;
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "the operator's disable stands");
});

test("a status changed since the run read the listing is decided afresh — never flipped by the old one: an offer disabled on amboss.tech meanwhile is not enabled by the autopilot's 'disable'", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t, 400_000);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  // The listing is read, then the engine is asked (auto-size on) — and the
  // operator disables the offer on amboss.tech in between.
  const ap = api.autopilot as unknown as { magmaReport: (key?: string) => Promise<unknown> };
  const real = ap.magmaReport.bind(api.autopilot);
  ap.magmaReport = async (key) => {
    offer.status = "DISABLED";
    return real(key);
  };
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED");
  // Before: one flip by the stale ENABLED — which enabled it.
  assert.equal(magma.count("ToggleOffer"), 0, "read afresh before flipping: nothing to flip");
});

test("a click recorded while the run priced other offers is newer than the listing it read: the run does not clear it as 'listed again'", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t, 5_000_000);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  const ap = api.autopilot as unknown as { magmaReport: (key?: string) => Promise<unknown> };
  const real = ap.magmaReport.bind(api.autopilot);
  let clicked = false;
  ap.magmaReport = async (key) => {
    if (!clicked) {
      clicked = true;
      // After the listing (ENABLED) was read: the operator disables it.
      const res = await api.request("POST", "/amboss/offer/toggle", { id: offer.id, want: "DISABLED" });
      assert.deepEqual(res.body, { status: "DISABLED", changed: true });
    }
    return real(key);
  };
  await api.autopilot.runOnce();
  // Before: cleared on the strength of the older read ("listed again").
  assert.ok(api.autopilot.offerControls()[offer.id]?.disabledByHandAt, "the click stands");
  await api.autopilot.runOnce();
  const entry = api.autopilot.offerSyncStatus().offers.find((e) => e.offerId === offer.id);
  assert.equal(offer.status, "DISABLED");
  assert.match(entry?.differences.join() ?? "", /disabled by you — the autopilot leaves it disabled/);
});

test("a capital-safety disable Amboss applied without answering still counts as the autopilot's: settled by the next read of the offer, said as such, and listed again once capital returns", async (t) => {
  quiet(t);
  mutationDeadline(t, 300);
  for (const readsFail of [false, true]) {
    const { api, magma } = await sellingApi(t, 400_000);
    const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
    magma.behave.ToggleOffer = "apply-then-hang";
    // readsFail: Amboss stops answering reads too, right as the flip arrives.
    magma.onMutation = (op) => {
      if (op === "ToggleOffer" && readsFail) magma.readBehaviour = "throw";
    };
    await api.autopilot.runOnce();
    assert.equal(offer.status, "DISABLED", "Amboss applied it");
    const first = api.autopilot.offerSyncStatus().offers.find((e) => e.offerId === offer.id);
    if (readsFail) {
      assert.ok(api.autopilot.offerControls()[offer.id]?.autoDisablingAt, "the intent, written before the flip, is on record");
      assert.match(first?.differences.join() ?? "", /Amboss's answer never came — the next read of the offer tells whether the disable landed/);
    } else {
      assert.ok(api.autopilot.offerControls()[offer.id]?.autoDisabledAt, "read back at once: the autopilot's disable");
    }
    magma.readBehaviour = "ok";
    magma.behave.ToggleOffer = "ok";
    magma.onMutation = null;
    await api.autopilot.runOnce();
    const entry = api.autopilot.offerSyncStatus().offers.find((e) => e.offerId === offer.id);
    // Before: no record at all — "the autopilot doesn't enable an offer it didn't disable".
    assert.ok(api.autopilot.offerControls()[offer.id]?.autoDisabledAt, `readsFail: ${readsFail}`);
    assert.match(entry?.differences.join() ?? "", /disabled by the autopilot for lack of capital/);
    api.node.chainBalance = 5_000_000;
    await api.autopilot.runOnce();
    assert.equal(offer.status, "ENABLED", `listed again once it can be funded (readsFail: ${readsFail})`);
  }
});

test("a click supersedes the autopilot's unanswered disable: the record holds the click alone, and the offer stays disabled when capital returns", async (t) => {
  quiet(t);
  mutationDeadline(t, 300);
  const { api, magma } = await sellingApi(t, 400_000);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  magma.behave.ToggleOffer = "apply-then-hang";
  magma.onMutation = (op) => {
    if (op === "ToggleOffer") magma.readBehaviour = "throw";
  };
  await api.autopilot.runOnce();
  assert.ok(api.autopilot.offerControls()[offer.id]?.autoDisablingAt);
  magma.readBehaviour = "ok";
  magma.behave.ToggleOffer = "ok";
  magma.onMutation = null;
  // "Keep it disabled", clicked while the autopilot's disable is unsettled.
  const res = await api.request("POST", "/amboss/offer/toggle", { id: offer.id, want: "DISABLED" });
  assert.deepEqual(res.body, { status: "DISABLED", changed: false });
  assert.deepEqual(Object.keys(api.autopilot.offerControls()[offer.id] ?? {}), ["disabledByHandAt"], "the autopilot's intent is superseded");
  api.node.chainBalance = 5_000_000;
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "the operator's disable, not the autopilot's: not listed again");
});

test("a click whose flip Amboss answers with the other status is not recorded as the operator's: an offer the autopilot disabled for lack of capital still comes back with the capital", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t, 500_000);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED");
  assert.ok(api.autopilot.offerControls()[offer.id]?.autoDisabledAt);
  // "enable", answered DISABLED (Amboss didn't flip it).
  magma.behave.ToggleOffer = "lie";
  const res = await api.request("POST", "/amboss/offer/toggle", { id: offer.id, want: "ENABLED" });
  assert.equal(res.status, 502);
  // Before: recorded as the operator's DISABLE — never listed again.
  assert.equal(api.autopilot.offerControls()[offer.id]?.disabledByHandAt, undefined);
  assert.ok(api.autopilot.offerControls()[offer.id]?.autoDisabledAt, "still the autopilot's disable");
  magma.behave.ToggleOffer = "ok";
  api.node.chainBalance = 3_000_000;
  await api.autopilot.runOnce();
  assert.equal(offer.status, "ENABLED");
});

test("a click on 'disable' while the autopilot's re-list is under way waits for it, then reads the offer afresh — the click stands", async (t) => {
  quiet(t);
  mutationDeadline(t, 300);
  const { api, magma } = await sellingApi(t, 500_000);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000 });
  await api.autopilot.runOnce();
  assert.equal(offer.status, "DISABLED", "capital safety");
  api.node.chainBalance = 3_000_000;
  // The autopilot's re-list is applied but its answer is slow (runs into the
  // 300 ms deadline); the operator clicks "disable" meanwhile.
  magma.behave.ToggleOffer = (n) => (n === 1 ? "apply-then-hang" : "ok");
  let click: Promise<{ status: number; body: unknown }> | null = null;
  let clickedAt = 0;
  let answeredAt = 0;
  magma.onMutation = (op) => {
    if (op !== "ToggleOffer" || click) return;
    clickedAt = Date.now();
    click = api.request("POST", "/amboss/offer/toggle", { id: offer.id, want: "DISABLED" }).then((r) => {
      answeredAt = Date.now();
      return r;
    });
  };
  await api.autopilot.runOnce();
  const res = await click!;
  const waited = answeredAt - clickedAt;
  // Before: the click read and flipped at once, crossing the autopilot's
  // flip still under way.
  assert.ok(waited >= 250, `the click waited for the autopilot's status change: answered after ${waited} ms`);
  assert.deepEqual(res.body, { status: "DISABLED", changed: true });
  assert.equal(offer.status, "DISABLED");
  assert.ok(api.autopilot.offerControls()[offer.id]?.disabledByHandAt);
});

// Review of P1b: a manual offer edit was not serialised with the per-offer
// lock. An autopilot terms write could land between the edit and its
// read-back — the edit then reported "not stored" — or after it, putting the
// standard lease back over the operator's own.
test("an edit saved while the autopilot's terms write is under way waits for it and its read-back — then lands, reads back stored, and stands", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t);
  // An old 4,032-block offer: auto-size gives it the standard lease and promise.
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, minBlockLength: 4032 });
  let release = () => undefined as void;
  let edit: Promise<{ status: number; body: any }> | undefined;
  let editSent = false;
  magma.holdMutation = (op, v) => {
    if (op !== "UpdateOffer") return null;
    if ((v.input as Record<string, unknown>).fee_rate === 4321) {
      editSent = true; // the operator's
      return null;
    }
    // The autopilot's write is on its way to Amboss: the operator saves an edit now.
    edit ??= api.request("POST", "/amboss/offer/update", { id: offer.id, ...TERMS, feeRatePpm: 4321, minBlockLength: 12_960 });
    return new Promise<void>((r) => (release = r));
  };
  const run = api.autopilot.runOnce();
  await until(() => !!edit, "the autopilot's write is under way");
  await new Promise((r) => setTimeout(r, 150));
  // Before: the edit went out at once, crossing the autopilot's write.
  assert.equal(editSent, false, "the edit waits for the autopilot's write and its read-back");
  release();
  await run;
  const res = await edit!;
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.verified, true, "read back as stored");
  assert.deepEqual([offer.feeRatePpm, offer.minBlockLength], [4321, 12_960], "the operator's terms stand");
});

test("an autopilot terms write planned on the offer as it was before an edit is not sent over the edit", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t);
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, minBlockLength: 4032 });
  // The operator's edit holds the offer's lock; Amboss is slow to take it.
  let releaseEdit = () => undefined as void;
  let editHeld = false;
  magma.holdMutation = (op, v) => {
    if (op !== "UpdateOffer" || (v.input as Record<string, unknown>).fee_rate !== 4321) return null;
    editHeld = true;
    return new Promise<void>((r) => (releaseEdit = r));
  };
  const edit = api.request("POST", "/amboss/offer/update", { id: offer.id, ...TERMS, feeRatePpm: 4321, minBlockLength: 12_960 });
  await until(() => editHeld, "the edit is being written");
  const chains = (api.autopilot as unknown as { offerChains: Map<string, unknown> }).offerChains;
  const editsTurn = chains.get(offer.id);
  // The autopilot run reads the offer as it still is (4,032 blocks, its own),
  // plans the standard lease — and queues behind the edit for its write.
  const run = api.autopilot.runOnce();
  await until(() => chains.get(offer.id) !== editsTurn, "the autopilot's write waits for the edit");
  releaseEdit();
  const [res] = await Promise.all([edit, run]);
  assert.equal(res.status, 200);
  assert.equal(res.body.verified, true);
  // Before (no lock, or a lock without a fresh look): the planned write went
  // out too and put the standard lease back over the operator's 12,960 blocks.
  assert.deepEqual(magma.calls.filter((c) => c.op === "UpdateOffer").map((c) => (c.variables.input as Record<string, unknown>).fee_rate), [4321]);
  assert.deepEqual([offer.feeRatePpm, offer.minBlockLength], [4321, 12_960]);
  const entry = api.autopilot.offerSyncStatus().offers.find((e) => e.offerId === offer.id);
  assert.match(entry?.differences.join() ?? "", /the offer changed while this run priced it/);
});

test("an autopilot terms write is not sent when the offer's terms changed on Amboss since the run read them — an edit made on amboss.tech stands", async (t) => {
  quiet(t);
  const { api, magma } = await sellingApi(t);
  // An old 4,032-block offer: the run plans the standard lease and promise.
  const offer = magma.addOffer({ minSats: 1_000_000, maxSats: 2_000_000, totalSats: 2_000_000, minBlockLength: 4032 });
  const chains = (api.autopilot as unknown as { offerChains: Map<string, unknown> }).offerChains;
  let edited = false;
  magma.onRead = (op, v) => {
    // The run's write is next: under the offer's lock, it reads the offer
    // afresh. Just before, the operator edits it on amboss.tech — not here,
    // so nothing pauses the automation.
    if (op !== "MyOffer" || v.id !== offer.id || !chains.has(offer.id) || edited) return;
    edited = true;
    offer.feeRatePpm = 4321;
    offer.minBlockLength = 12_960;
  };
  await api.autopilot.runOnce();
  assert.ok(edited, "the edit landed between the run's read and its write");
  // Before (a takeover check alone): the write planned on the old terms went
  // out and put the standard lease back over the operator's 12,960 blocks.
  assert.equal(magma.calls.filter((c) => c.op === "UpdateOffer").length, 0, "no write over the edit");
  assert.deepEqual([offer.feeRatePpm, offer.minBlockLength], [4321, 12_960]);
  const entry = api.autopilot.offerSyncStatus().offers.find((e) => e.offerId === offer.id);
  assert.match(entry?.differences.join() ?? "", /the offer changed while this run priced it/);
  assert.equal(api.autopilot.offerControls()[offer.id]?.manual, undefined, "nothing took it over here: the next run starts from the edit");
});
