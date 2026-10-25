/**
 * Magma selling after the final review (2026-10-25), what was still open:
 *  - the deploy cap: an order funded while the sold-capital listing is on its
 *    way counts against the cap (refreshDeployed dates the listing by its ask);
 *  - LND's fee estimate failing: the lane keeps the last real floor (never the
 *    minimum relay fee's), says which one past 6 h, and an offer taken off the
 *    market below cost is listed again only on a real estimate;
 *  - an auto-sized offer whose min goes up is priced for the window it gets;
 *  - a free offer's price going back on, and its relist, judged at that price;
 *  - the offer capital check: its own lock and deadline — never the main run's;
 *  - a given-up magma stage writes no record when its call answers late;
 *  - the base kept, the below-cost alert while selling is on, the fee-parts alert.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { WORK_DEADLINES_MS } from "../src/services/autopilot.js";
import { LANE_PASS_DEADLINE } from "../src/services/magmaDesk.js";
import { __setHistoryForTests } from "../src/services/magmaHistory.js";
import { minSizeCoveringSat, saleAcceptFloorSats } from "../src/services/magmaRecommend.js";
import { magmaPartsAlerts, offerPriceAlerts } from "../src/services/alerts.js";
import { BUYER, plannedFeeChange, sellerSetup, type AutopilotSeams } from "./helpers/autopilot.js";
import { IN_AN_HOUR, entryOnDisk, feeEnv, quiet, walletBalance, keepFileAlive } from "./helpers/lifecycle.js";
import type { FakeLnd } from "./helpers/fakeLnd.js";
import type { AfterHook } from "./helpers/tmp.js";

// Deadlines in these tests fire on timers nothing else keeps alive (see keepFileAlive).
keepFileAlive();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number) => n.toLocaleString("en-US");
const otherBuyer = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);

const LIVE_ID = "00479f19-540f-4ce5-83fa-9e13c85269e1";
const LIVE_OFFER = {
  id: LIVE_ID,
  status: "ENABLED",
  minSats: 250_000,
  maxSats: 2_000_000,
  totalSats: 4_500_000,
  lockedSats: 2_500_000,
  feeRatePpm: 4445,
  baseFeeSats: 0,
  minBlockLength: 4320,
  feeRateCap: "2200",
  baseFeeCap: "1",
  filledOrders: 3,
};
const LIVE_CONFIG = {
  sellEnabled: true,
  sellMaxDeploySats: 2_000_000,
  sellMaxChannelSats: 5_000_000,
  sellReserveSats: 50_000,
  sellAutoReprice: true,
  sellAutoSize: true,
  sellAutoRelist: true,
  sellAutoClose: true,
  sellPricingMode: "balanced",
};
const aprFor = (ppm: number) => (ppm / 1e6) * (52_560 / 4320);

/** The live offer (Nerdminerstore.com) in a market like the live one. */
function liveSetup(
  t: AfterHook,
  opts: { feeSatPerVb: number; marketBase?: number; config?: Record<string, unknown>; offer?: Record<string, unknown> },
) {
  const s = sellerSetup(t, { chainBalance: 4_000_000, config: { ...LIVE_CONFIG, ...opts.config } });
  for (let i = 0; i < 20; i++) {
    s.market.addOffer({ totalSats: 5_000_000, minSats: 250_000, maxSats: 5_000_000, feeRatePpm: 3000 + i * 300, baseFeeSats: opts.marketBase ?? 568, sellerScore: 50 });
  }
  __setHistoryForTests(
    Array.from({ length: 40 }, (_, i) => ({
      at: Date.now() - i * 2 * 86_400_000,
      sizeSat: [300_000, 500_000, 1_000_000, 1_500_000, 2_000_000][i % 5],
      blocks: 4320,
      apr: aprFor(4445),
      leasePpm: 4445,
      status: "FINISHED",
    })),
  );
  t.after(() => __setHistoryForTests([]));
  setFee(s.node, opts.feeSatPerVb);
  const offer = s.magma.addOffer({ ...LIVE_OFFER, ...opts.offer });
  return { ...s, offer };
}
type Seller = ReturnType<typeof sellerSetup>;

function setFee(node: FakeLnd, satPerVb: number): void {
  node.override("wallet.estimateFee", (_a, cb) => (cb as (e: unknown, r: unknown) => void)(null, { sat_per_kw: String(satPerVb * 250) }));
}
function estimateFails(node: FakeLnd): void {
  node.override("wallet.estimateFee", (_a, cb) => (cb as (e: unknown) => void)(new Error("fee estimate unavailable")));
}
type FloorState = { saleFloor: unknown; state: { lastSaleFloor?: { at: string; sats: number } } };
/** The lane's 10-min floor cache runs out (and, `forget`, no floor is known from before). */
function floorExpires(s: Pick<Seller, "autopilot">, opts: { forget?: boolean; lastAt?: number } = {}): void {
  const ap = s.autopilot as unknown as FloorState;
  ap.saleFloor = null;
  if (opts.forget) delete ap.state.lastSaleFloor;
  if (opts.lastAt !== undefined && ap.state.lastSaleFloor) ap.state.lastSaleFloor.at = new Date(opts.lastAt).toISOString();
}
const syncOf = (s: Pick<Seller, "autopilot">, id: string) => s.autopilot.offerSyncStatus().offers.find((e) => e.offerId === id);

function shortDeadlines(t: TestContext): void {
  const saved = { ...WORK_DEADLINES_MS };
  const lane = LANE_PASS_DEADLINE.ms;
  Object.assign(WORK_DEADLINES_MS, { stage: 150, perRefill: 150, feeWork: 150, inflightCheck: 150, laneWork: 150 });
  LANE_PASS_DEADLINE.ms = 150;
  t.after(() => {
    Object.assign(WORK_DEADLINES_MS, saved);
    LANE_PASS_DEADLINE.ms = lane;
  });
  t.mock.method(console, "error", () => undefined);
}

// ── the deploy cap ───────────────────────────────────────────────────────────

test("an order funded while the sold-capital listing is on its way counts against the deploy cap — a second 2M order against a 3M cap with 2M funded is turned down (before: accepted, 4M promised)", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellMaxDeploySats: 3_000_000 } });
  type Desk = {
    deployed: { at: number };
    refreshDeployed(force?: boolean): Promise<number>;
    ambossSales: (...a: unknown[]) => Promise<unknown>;
    journal: { get(id: string): Record<string, unknown> | undefined; note(e: unknown): void };
  };
  const desk = s.autopilot.magma as unknown as Desk;
  const x = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(x.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  s.magma.buyerPays(x.id, s.node);
  const real = desk.ambossSales.bind(s.autopilot.magma);
  let once = false;
  desk.ambossSales = async (...a: unknown[]) => {
    await sleep(5);
    const res = await real(...a);
    if (!once) {
      once = true;
      // Meanwhile the lane's pass opened X (its own record of the open).
      const e = desk.journal.get(x.id)!;
      e.phase = "funded";
      e.fundingOutpoint = `${"ab".repeat(32)}:0`;
      e.fundedAt = new Date().toISOString();
      desk.journal.note(e);
    }
    await sleep(5); // the answer is on its way
    return res;
  };
  desk.deployed.at = 0;
  await desk.refreshDeployed(true);
  desk.ambossSales = real;
  const y = s.magma.addSale({ buyerPubkey: otherBuyer(77), sizeSats: 2_000_000 });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(y.id)?.status, "SELLER_REJECTED", "before: accepted against the 3M cap");
  assert.match(entryOnDisk(s.dir, y.id)?.reason ?? "", /deploy cap reached/);
});

// ── LND's fee estimate failing ───────────────────────────────────────────────

test("while LND's fee estimate fails, the lane's floor is the last one it gave — kept across a restart — not the minimum relay fee's; past 6 h a refusal says which floor, and with none known that it is the minimum relay fee's", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  setFee(s.node, 20);
  const f20 = await s.autopilot.saleFeeFloorSats();
  const f1 = saleAcceptFloorSats(null, 0);
  assert.equal(f20, saleAcceptFloorSats(20, 0));
  estimateFails(s.node);
  floorExpires(s);
  assert.equal(await s.autopilot.saleFeeFloorSats(), f20, `before: ${f1} — the minimum relay fee's`);
  assert.equal(s.autopilot.saleFloorNote(), null, "a recent floor: nothing to add");
  s.autopilot.flush();
  assert.equal(await s.restart().saleFeeFloorSats(), f20, "kept across a restart");
  // An order between the two floors: turned down, its reason the plain one.
  const under = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000, feeSeller: String(f20 - 1), timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(under.id)?.status, "SELLER_REJECTED", "before: accepted — above the 1 sat/vB floor");
  assert.match(entryOnDisk(s.dir, under.id)?.reason ?? "", new RegExp(`less than opening and closing its channel costs on chain now \\(${fmt(f20)} sat\\)$`));
  // Seven hours on: still that floor, and the refusal says so.
  const since = Date.now() - 7 * 3_600_000;
  floorExpires(s, { lastAt: since });
  const late = s.magma.addSale({ buyerPubkey: otherBuyer(5), sizeSats: 1_000_000, feeSeller: String(f20 - 1), timeout: IN_AN_HOUR() });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(late.id)?.status, "SELLER_REJECTED");
  const stamp = new Date(since).toISOString().slice(0, 16).replace("T", " ");
  assert.ok(
    (entryOnDisk(s.dir, late.id)?.reason ?? "").endsWith(`(${fmt(f20)} sat); LND's fee estimate isn't answering — the floor is the one it last gave (${stamp} UTC)`),
    entryOnDisk(s.dir, late.id)?.reason,
  );
  // A click below that floor is told the same.
  const click = s.magma.addSale({ buyerPubkey: otherBuyer(6), sizeSats: 1_000_000, feeSeller: String(f20 - 1), timeout: IN_AN_HOUR() });
  const asked = await s.desk.accept(click.id);
  assert.equal(asked.ok, false);
  assert.ok(asked.message.endsWith(`after the service fee). LND's fee estimate isn't answering — the floor is the one it last gave (${stamp} UTC).`), asked.message);
  // None known at all: the minimum relay fee's, and said.
  floorExpires(s, { forget: true });
  assert.equal(await s.autopilot.saleFeeFloorSats(), f1);
  assert.equal(s.autopilot.saleFloorNote(), "LND's fee estimate isn't answering and none is known from before — the floor is the minimum relay fee's");
  // The estimate answers again: live, nothing to add.
  setFee(s.node, 20);
  assert.equal(await s.autopilot.saleFeeFloorSats(), f20);
  assert.equal(s.autopilot.saleFloorNote(), null);
});

test("an offer taken off the market below cost is listed again only on a real fee estimate — not while LND's estimate fails, whatever floor stands in (before: listed again, judged at the minimum relay fee's floor)", async (t) => {
  quiet(t);
  // A 600k deploy cap: at 25 sat/vB no order up to 600k covers the floor at the engine's price.
  const s = liveSetup(t, { feeSatPerVb: 25, config: { sellMaxDeploySats: 600_000 } });
  await s.autopilot.runOnce();
  assert.equal(s.offer.status, "DISABLED");
  assert.ok(s.autopilot.offerControls()[LIVE_ID]?.costDisabledAt);
  // The estimate fails, and no floor is known from before: the stand-in is
  // the minimum relay fee's — the one every order "covers".
  estimateFails(s.node);
  floorExpires(s, { forget: true });
  await s.autopilot.runOnce();
  assert.equal(s.offer.status, "DISABLED", "before: listed again");
  assert.ok(
    syncOf(s, LIVE_ID)?.differences.some((d) => d.startsWith("taken off the market by the autopilot below cost") && d.endsWith("on a fee rate LND's estimate gives: it isn't answering now")),
    JSON.stringify(syncOf(s, LIVE_ID)?.differences),
  );
  // A real estimate, and fees are down: listed again, its terms first.
  setFee(s.node, 1);
  floorExpires(s);
  await s.autopilot.runOnce();
  assert.equal(s.offer.status, "ENABLED");
  assert.equal(s.autopilot.offerControls()[LIVE_ID]?.costDisabledAt, undefined);
});

// ── an auto-sized offer priced for the window it gets ────────────────────────

test("the live offer at 20 sat/vB: its min goes up and it is priced for that window in the same run — one write, and the next run has nothing to change (before: ~9,980 + 284 for 250k–2M, back to ~4,608 + 284 a run later)", async (t) => {
  quiet(t);
  feeEnv(t);
  const s = liveSetup(t, { feeSatPerVb: 20, marketBase: 284 });
  await s.autopilot.runOnce();
  const writes = () => s.magma.calls.filter((c) => c.op === "UpdateOffer").length;
  assert.equal(writes(), 1);
  assert.ok(s.offer.minSats >= 1_000_000, `min ${fmt(s.offer.minSats)}`);
  assert.ok(s.offer.feeRatePpm < 6_000, `${fmt(s.offer.feeRatePpm)} ppm — the price for 250k–2M`);
  const rec = (await s.autopilot.magmaReport()).sell.recommendations.find((r) => r.offerId === LIVE_ID);
  assert.equal(rec?.shouldReprice, false, `the engine after run 1: ${rec?.recommended.feeRatePpm} + ${rec?.recommended.baseFeeSat}, the offer ${s.offer.feeRatePpm} + ${s.offer.baseFeeSats}`);
  await s.autopilot.runOnce();
  assert.equal(writes(), 1, "before: a second write, the price for the new window");
});

// ── a free offer's price, judged at that price ───────────────────────────────

test("an offer Amboss lists for free gets its last price back judged at that price: at 20 sat/vB its min goes up to the smallest order that pays for its channel (before: put back with its old min — orders under it turned down by the lane)", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { config: { sellAutoSize: true } });
  setFee(s.node, 1);
  const offer = s.magma.addOffer({ minSats: 250_000, maxSats: 4_000_000, totalSats: 4_000_000, feeRatePpm: 3000, baseFeeSats: 0, minBlockLength: 4320 });
  await s.autopilot.runOnce(); // its price on record, its window auto-size's
  const before = offer.minSats;
  // Amboss drops the price; fees rise.
  offer.feeRatePpm = 0;
  offer.baseFeeSats = 0;
  setFee(s.node, 20);
  floorExpires(s);
  await s.autopilot.runOnce();
  const floor = saleAcceptFloorSats(20, 0);
  const cover = minSizeCoveringSat(3000, 0, floor);
  assert.deepEqual([offer.status, offer.feeRatePpm, offer.baseFeeSats], ["ENABLED", 3000, 0]);
  assert.ok(cover > before, `${fmt(cover)} vs ${fmt(before)}`);
  assert.equal(offer.minSats, cover, `before: ${fmt(before)} (the lane's floor ${fmt(floor)} sat)`);
  const reason = syncOf(s, offer.id)?.lastWrite?.reason ?? "";
  assert.match(reason, /price put back to the last one it had, 3,000 ppm \+ 0 sat \(Amboss listed it at 0 ppm \+ 0 sat\)/);
  assert.match(reason, new RegExp(`min channel raised to ${fmt(cover)} sat`));
});

test("an offer taken off the market for being free is listed again only where an order it can fund pays for its channel at the price it gets (before: listed at the engine's price and taken off again below cost in the same run)", async (t) => {
  quiet(t);
  const s = liveSetup(t, { feeSatPerVb: 25, config: { sellMaxDeploySats: 600_000 }, offer: { status: "DISABLED", feeRatePpm: 0, baseFeeSats: 0 } });
  (s.autopilot as unknown as { setOfferControl(id: string, c: object): void }).setOfferControl(LIVE_ID, { freeDisabledAt: new Date().toISOString() });
  await s.autopilot.runOnce();
  assert.equal(s.offer.status, "DISABLED");
  assert.ok(s.offer.feeRatePpm > 0, "priced while off");
  assert.equal(s.magma.calls.filter((c) => c.op === "ToggleOffer").length, 0, "before: listed and taken off again — two toggles");
  assert.ok(
    syncOf(s, LIVE_ID)?.differences.some((d) => d.includes("not listed again yet: at the autopilot's price for it no order it can fund pays for opening and closing its channel")),
    JSON.stringify(syncOf(s, LIVE_ID)?.differences),
  );
  // Fees drop: listed again.
  setFee(s.node, 1);
  floorExpires(s);
  await s.autopilot.runOnce();
  assert.equal(s.offer.status, "ENABLED");
  assert.equal(s.autopilot.offerControls()[LIVE_ID]?.freeDisabledAt, undefined);
});

// ── the offer capital check: its own lock ────────────────────────────────────

test("the offer capital check never holds the main run's lock: with LND not answering its wallet read, the check is given up at its deadline and every run still runs (before: no run at all until a restart, 'Run once now' busy)", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const s = sellerSetup(t, { chainBalance: 5_000_000 });
  s.magma.addOffer({ minSats: 1_000_000, maxSats: 4_000_000, totalSats: 4_000_000 });
  await s.autopilot.runOnce();
  const lastRunBefore = s.autopilot.getState().lastRunAt;
  let hang = true;
  const pending: (() => void)[] = [];
  s.node.override("default.walletBalance", (_a, cb) => {
    if (hang) pending.push(() => cb(null, walletBalance(s.node)));
    else cb(null, walletBalance(s.node));
  });
  const check = s.autopilot.offerCapitalNow(); // what recheckOfferCapital's timer calls
  await sleep(20);
  assert.equal(s.autopilot.isRunning(), false, "no main run's lock held");
  assert.deepEqual(await check, [], "given up at its deadline");
  await sleep(30);
  await s.autopilot.runOnce(); // the 30-min tick
  assert.notEqual(s.autopilot.getState().lastRunAt, lastRunBefore, "before: a silent no-op");
  assert.notEqual(await s.autopilot.runOnceNow(), null, "before: 409 busy");
  hang = false;
  for (const p of pending.splice(0)) p();
  assert.equal(await s.autopilot.waitIdle(1_000), true);
});

test("a scheduled run that comes due while the offer capital check runs is not skipped: its fee stage runs at once, its magma stage once the check is done — the two never work on the offers at the same time", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 5_000_000, config: { enabled: true } });
  s.magma.addOffer({ minSats: 1_000_000, maxSats: 4_000_000, totalSats: 4_000_000 });
  await s.autopilot.runOnce();
  const seams = s.autopilot as unknown as AutopilotSeams & { runSell: (o?: object) => Promise<unknown[]> };
  let feeReports = 0;
  seams.feeReport = async () => {
    feeReports++;
    return { recommendations: [plannedFeeChange("800000x1x0", 100, 80)] };
  };
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm, baseFeeMsat: i.baseFeeMsat }));
  const realSell = seams.runSell.bind(s.autopilot);
  let inSell = 0;
  let most = 0;
  const sells: string[] = [];
  seams.runSell = async (o?: object) => {
    inSell++;
    most = Math.max(most, inSell);
    sells.push((o as { capitalOnly?: boolean } | undefined)?.capitalOnly ? "check" : "stage");
    try {
      return await realSell(o);
    } finally {
      inSell--;
    }
  };
  // The wallet read takes 300 ms (LND busy, or Amboss's listing over Tor).
  s.node.override("default.walletBalance", (_a, cb) => void setTimeout(() => cb(null, walletBalance(s.node)), 300));
  const lastRunBefore = s.autopilot.getState().lastRunAt;
  const check = s.autopilot.offerCapitalNow();
  await sleep(30);
  assert.equal(await s.autopilot.waitIdle(50), false, "the check is work under way (a shutdown waits for it)");
  await s.autopilot.runOnce();
  await check;
  assert.equal(feeReports, 1, "before: 0 — the run was skipped without a trace");
  assert.notEqual(s.autopilot.getState().lastRunAt, lastRunBefore);
  assert.deepEqual(sells, ["check", "stage"]);
  assert.equal(most, 1, "never side by side");
  // A check that comes during the magma stage waits for it, and still runs.
  sells.length = 0;
  const run = s.autopilot.runOnce();
  while (!sells.includes("stage")) await sleep(5);
  await s.autopilot.offerCapitalNow();
  await run;
  assert.deepEqual(sells, ["stage", "check"]);
  assert.equal(most, 1);
});

test("the lane's offer price check leaves the offers alone while the capital check works on them — and runs after it as before", async (t) => {
  quiet(t);
  const s = sellerSetup(t, { chainBalance: 5_000_000 });
  s.magma.addOffer({ minSats: 1_000_000, maxSats: 4_000_000, totalSats: 4_000_000 });
  await s.autopilot.runOnce();
  const ap = s.autopilot as unknown as { offerGuardAt: number };
  ap.offerGuardAt = 0;
  s.node.override("default.walletBalance", (_a, cb) => void setTimeout(() => cb(null, walletBalance(s.node)), 200));
  const check = s.autopilot.offerCapitalNow();
  await sleep(20);
  await s.autopilot.pollSellOrders();
  assert.equal(ap.offerGuardAt, 0, "not beside the check");
  await check;
  await s.autopilot.pollSellOrders();
  assert.ok(ap.offerGuardAt > 0, "after it");
});

// ── a given-up magma stage ───────────────────────────────────────────────────

for (const late of ["reads its offers", "fails"] as const) {
  test(`a magma stage given up on a wallet read writes nothing when the read answers after a newer run — and then ${late}: the offers' sync record stays the newer run's (before: 'left as it is: … given up' over it)`, async (t) => {
    quiet(t);
    shortDeadlines(t);
    const s = sellerSetup(t, { chainBalance: 5_000_000 });
    s.magma.addOffer({ minSats: 1_000_000, maxSats: 4_000_000, totalSats: 4_000_000 });
    await s.autopilot.runOnce();
    let hangNext = true;
    const pending: (() => void)[] = [];
    s.node.override("default.walletBalance", (_a, cb) => {
      if (hangNext) {
        hangNext = false;
        pending.push(() => cb(null, walletBalance(s.node)));
        return;
      }
      cb(null, walletBalance(s.node));
    });
    const run1 = await s.autopilot.runOnce();
    assert.ok(run1.errors?.some((e) => e.stage === "magma"), JSON.stringify(run1.errors));
    // The newer run can't read the offers: its error is the record.
    s.magma.readBehaviour = "throw";
    await s.autopilot.runOnce();
    const after2 = structuredClone(s.autopilot.offerSyncStatus());
    assert.match(after2.lastError?.message ?? "", /could not read your offers from Amboss/);
    if (late === "reads its offers") s.magma.readBehaviour = "ok";
    for (const p of pending.splice(0)) p();
    await sleep(100);
    const after1 = s.autopilot.offerSyncStatus();
    assert.equal(after1.at, after2.at, "before: the given-up stage wrote the sync status again");
    assert.deepEqual(after1.offers, after2.offers);
    assert.deepEqual(after1.lastError, after2.lastError, "the newer run's error stands");
  });
}

test("a magma stage given up on its market read writes nothing when it answers after a newer run — neither the offers' entries ('left as it is: … given up') nor its error", async (t) => {
  quiet(t);
  shortDeadlines(t);
  const s = sellerSetup(t, { chainBalance: 5_000_000, config: { sellAutoSize: true } });
  s.magma.addOffer({ minSats: 1_000_000, maxSats: 4_000_000, totalSats: 4_000_000 });
  await s.autopilot.runOnce();
  const ap = s.autopilot as unknown as { magmaReport: (...a: unknown[]) => Promise<unknown> };
  const real = ap.magmaReport.bind(s.autopilot);
  let release: (() => void) | undefined;
  let first = true;
  ap.magmaReport = async (...a: unknown[]) => {
    if (!first) return real(...a);
    first = false;
    await new Promise<void>((r) => (release = r));
    throw new Error("the market did not answer");
  };
  const run1 = await s.autopilot.runOnce();
  assert.ok(run1.errors?.some((e) => e.stage === "magma"), JSON.stringify(run1.errors));
  await s.autopilot.runOnce();
  const after2 = structuredClone(s.autopilot.offerSyncStatus());
  release!();
  await sleep(100);
  const after1 = s.autopilot.offerSyncStatus();
  assert.equal(after1.at, after2.at);
  assert.deepEqual(after1.offers, after2.offers);
  assert.deepEqual(after1.lastError, after2.lastError);
});

// ── the texts ────────────────────────────────────────────────────────────────

test("the alert about orders turned down below cost comes only while selling is on — with it off, nothing turns them down", () => {
  const sync = {
    offers: [
      {
        offerId: "a".repeat(36),
        amboss: { status: "ENABLED", feeRatePpm: 3000, baseFeeSats: 0 },
        inSync: true,
        lastWrite: null,
        turnedDownUnderSat: 500_000,
      },
    ],
  };
  assert.equal(offerPriceAlerts(sync, true).length, 1);
  assert.match(offerPriceAlerts(sync, true)[0]!.message, /orders under 500,000 sat pay less than opening and closing/);
  assert.deepEqual(offerPriceAlerts(sync, false), [], "before: said with selling off too");
});

test("an order the lane leaves to the operator — its fee parts aren't an offer price — is an alert with its deadline until it is decided or past it", async (t) => {
  quiet(t);
  const s = sellerSetup(t);
  s.magma.addOffer({ minSats: 1_000_000, maxSats: 5_000_000, totalSats: 5_000_000, feeRatePpm: 3000, baseFeeSats: 852 });
  await s.autopilot.runOnce(); // the offer's price on record
  const deadline = IN_AN_HOUR();
  const odd = s.magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000, feeSeller: "0", feeFixed: "852", feeVariable: "9000", timeout: deadline });
  // One the lane skips for now for another reason (no fee reported yet): not the operator's.
  const zero = s.magma.addSale({ buyerPubkey: otherBuyer(9), sizeSats: 2_000_000, feeSeller: "0", timeout: deadline });
  await s.autopilot.pollSellOrders();
  assert.equal(s.magma.sales.get(odd.id)?.status, "WAITING_FOR_SELLER_APPROVAL");
  assert.equal(entryOnDisk(s.dir, zero.id)?.decision?.action, "skip");
  const alerts = magmaPartsAlerts(s.autopilot.magma);
  assert.equal(alerts.length, 1, "before: none — only the order's own row said so");
  assert.equal(
    alerts[0]!.message,
    "A 2,000,000 sat Magma order waits for your decision: Amboss shows no amount for this order, and its fee parts — 9,852 sat — aren't your price for a 2,000,000 sat channel " +
      `(your price: 6,852 sat): the lane doesn't accept it; accept or reject it on Market → Orders before ${deadline.slice(0, 16).replace("T", " ")} UTC — ` +
      "Amboss counts an order nobody decides against your seller score.",
  );
  assert.deepEqual(s.autopilot.magma.partsLeftToYou(Date.parse(deadline) + 1), [], "past its deadline: gone");
  // Taken up here meanwhile (an Accept on its way): no longer waiting for a decision.
  const journal = (s.autopilot.magma as unknown as { journal: { get(id: string): { phase: string } | undefined; note(e: unknown): void } }).journal;
  const e = journal.get(odd.id)!;
  e.phase = "accepting";
  journal.note(e);
  assert.deepEqual(magmaPartsAlerts(s.autopilot.magma), []);
  e.phase = "seen";
  journal.note(e);
  assert.equal(magmaPartsAlerts(s.autopilot.magma).length, 1);
  // Decided (rejected by hand): gone.
  assert.equal((await s.desk.reject(odd.id)).ok, true);
  assert.deepEqual(magmaPartsAlerts(s.autopilot.magma), []);
});
