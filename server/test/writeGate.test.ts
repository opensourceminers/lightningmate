/**
 * The write gate (review 2026-11-10, ENG-1) and the second offer (WEB-1).
 *
 * "It only changes anything with LM_ENABLE_WRITE=true and a write macaroon"
 * (README) — and the by-hand Amboss routes did not know it: a read-only
 * install could create an offer, list one, change one and order a channel.
 * Everything that then has to act on the result needs LND: the order lane
 * does not run without a write client, a by-hand accept or reject is refused,
 * an order placed can't be paid. The offer drew orders nobody answered, and
 * an order left unanswered counts against the seller score that sales hang
 * on.
 *
 * And nothing had ever walked the routes: the last test here sends every POST
 * and DELETE the router has to a read-only install and checks that LND is
 * only read and that Amboss is sent nothing but a withdrawal.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { installFetchMock } from "./helpers/fetchMock.js";
import { FakeMagma } from "./helpers/magma.js";
import { FakeMarket } from "./helpers/market.js";
import { AMBOSS_API } from "./helpers/amboss.js";
import { startApi, type ApiHarness } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { BUYER } from "./helpers/autopilot.js";

const TERMS = { totalSizeSats: 5_000_000, minSizeSats: 250_000, maxSizeSats: 2_000_000, feeRatePpm: 4000, baseFeeSats: 0, minBlockLength: 4320 };
const MUTATIONS = ["AcceptOrder", "AddTransaction", "RejectOrder", "UpdateOffer", "CreateOffer", "ToggleOffer", "Order", "Buy", "CancelOrder"] as const;

function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
}

async function install(t: TestContext, opts: { readOnly: boolean; node?: FakeLnd }): Promise<{ api: ApiHarness; magma: FakeMagma }> {
  quiet(t);
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  new FakeMarket(http, t);
  const api = await startApi(t, { node: opts.node ?? new FakeLnd({ chainBalance: 5_000_000 }), readOnly: opts.readOnly });
  magma.sellerPubkey = api.node.publicKey;
  api.amboss.setKey("test-key");
  return { api, magma };
}
const mutations = (magma: FakeMagma) => MUTATIONS.filter((op) => magma.count(op) > 0).map((op) => `${op}×${magma.count(op)}`);

test("ENG-1: without write mode no offer is created, changed or listed and no channel ordered — each refusal says why; taking an offer off the market still works", async (t) => {
  const { api, magma } = await install(t, { readOnly: true });
  assert.equal(api.autopilot.canWrite, false);
  const listed = magma.addOffer({ status: "ENABLED", minSats: 250_000, maxSats: 2_000_000, totalSats: 5_000_000, feeRatePpm: 4435 });
  const parked = magma.addOffer({ status: "DISABLED", minSats: 250_000, maxSats: 2_000_000, totalSats: 5_000_000, feeRatePpm: 4435 });

  const refusedWith = async (path: string, body: unknown, what: RegExp) => {
    const res = await api.request("POST", path, body);
    assert.equal(res.status, 403, `${path}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.error, "write_disabled");
    assert.match(res.body.message, what);
    assert.match(res.body.message, /LM_ENABLE_WRITE/, "and how to switch it on");
  };
  await refusedWith("/amboss/offer", { ...TERMS, another: true }, /^Creating an offer needs write mode: without it LightningMate can't answer the orders an offer draws\./);
  await refusedWith("/amboss/offer/update", { id: listed.id, ...TERMS }, /^Changing an offer needs write mode/);
  await refusedWith("/amboss/offer/toggle", { id: parked.id, want: "ENABLED" }, /^Listing an offer needs write mode/);
  await refusedWith("/amboss/offer/toggle", { id: parked.id }, /^Listing an offer needs write mode/); // no `want`: it would list
  // … and so would a bare toggle of an offer in any other state that isn't
  // listed (before: only "DISABLED" counted — these went out to Amboss).
  for (const status of ["ADMIN_DISABLED", "PAUSED", "disabled", ""]) {
    parked.status = status;
    await refusedWith("/amboss/offer/toggle", { id: parked.id }, /^Listing an offer needs write mode/);
  }
  parked.status = "DISABLED";
  await refusedWith("/amboss/buy/quote", { usdCents: 1000, private: false }, /^Ordering a channel needs write mode: without it LightningMate can't pay for the order\./);
  await refusedWith("/amboss/buy/quote", { usdCents: 0, private: false, offerId: "offer-9", sizeSats: 1_000_000 }, /^Ordering a channel needs write mode/);
  assert.deepEqual(mutations(magma), [], "nothing was sent to Amboss");
  assert.equal(parked.status, "DISABLED");
  assert.equal(listed.feeRatePpm, 4435);
  assert.equal(magma.offers.size, 2);

  // Withdrawing needs no LND: the listed offer comes off the market.
  const off = await api.request("POST", "/amboss/offer/toggle", { id: listed.id, want: "DISABLED" });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(listed.status, "DISABLED");
  assert.deepEqual(mutations(magma), ["ToggleOffer×1"]);
  // Asked to list an offer that is listed already: nothing to do, nothing refused.
  listed.status = "ENABLED";
  const same = await api.request("POST", "/amboss/offer/toggle", { id: listed.id, want: "ENABLED" });
  assert.equal(same.status, 200, JSON.stringify(same.body));
  assert.equal(same.body.changed, false);
  assert.deepEqual(mutations(magma), ["ToggleOffer×1"]);
});

test("ENG-1: with write mode the same clicks go through", async (t) => {
  const { api, magma } = await install(t, { readOnly: false });
  const created = await api.request("POST", "/amboss/offer", TERMS);
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const offer = magma.offers.get(created.body.offerId)!;
  offer.status = "DISABLED";
  const on = await api.request("POST", "/amboss/offer/toggle", { id: offer.id, want: "ENABLED" });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(offer.status, "ENABLED");
  const changed = await api.request("POST", "/amboss/offer/update", { id: offer.id, ...TERMS, feeRatePpm: 3900 });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(offer.feeRatePpm, 3900);
});

test("WEB-1: a create beside an offer is refused unless it says it means a further one — and when this node's offers can't be read, nothing is created", async (t) => {
  const { api, magma } = await install(t, { readOnly: false });

  // Amboss can't be read: whether there is an offer isn't known.
  magma.readBehaviour = "throw";
  const blind = await api.request("POST", "/amboss/offer", TERMS);
  assert.equal(blind.status, 502, JSON.stringify(blind.body));
  assert.equal(blind.body.error, "amboss_failed");
  assert.match(blind.body.message, /^No offer created: your offers on Amboss couldn't be read \(.+\), so it isn't known whether this node has one already\. Try again\.$/);
  const blindToo = await api.request("POST", "/amboss/offer", { ...TERMS, another: true });
  assert.equal(blindToo.status, 502, "not with `another` either: the page that sent it never saw the offers");
  assert.equal(magma.count("CreateOffer"), 0);
  magma.readBehaviour = "ok";

  // None of this node's — another node's offer on the same Amboss account is
  // not this node's: the first is created.
  magma.addOffer({ pubkey: "03" + "bb".repeat(32) });
  const first = await api.request("POST", "/amboss/offer", TERMS);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(magma.count("CreateOffer"), 1);

  // One: a second create — a page that didn't know, a double click, a script.
  const again = await api.request("POST", "/amboss/offer", TERMS);
  assert.equal(again.status, 409, JSON.stringify(again.body));
  assert.equal(again.body.error, "offer_exists");
  assert.match(again.body.message, /^This node already has an offer on Amboss — reload Market → Sell to see it\. A second offer sells the same coins twice over; create one only if you mean to\.$/);
  for (const notYes of ["true", 1, "yes", null]) {
    const res = await api.request("POST", "/amboss/offer", { ...TERMS, another: notYes });
    assert.equal(res.status, 409, `another: ${JSON.stringify(notYes)} is not a yes`);
  }
  // An offer taken off the market is this node's offer all the same: a
  // second one beside it would sell the same coins the day it is listed again.
  magma.offers.get(first.body.offerId)!.status = "DISABLED";
  const besideParked = await api.request("POST", "/amboss/offer", TERMS);
  assert.equal(besideParked.status, 409, JSON.stringify(besideParked.body));
  assert.equal(besideParked.body.error, "offer_exists");
  assert.equal(magma.count("CreateOffer"), 1);
  assert.equal(magma.offers.size, 2);

  // Meant: created.
  const second = await api.request("POST", "/amboss/offer", { ...TERMS, another: true });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(magma.offers.size, 3);
  const input = magma.calls.filter((c) => c.op === "CreateOffer").at(-1)?.variables.input as Record<string, unknown>;
  assert.equal("another" in input, false, "the word is the app's, not Amboss's");
  const third = await api.request("POST", "/amboss/offer", TERMS);
  assert.match(third.body.message, /^This node already has 2 offers on Amboss — reload Market → Sell to see them\./);
});

/**
 * Every POST and DELETE, with a body that would do its work on an install
 * that can write. `expect`: the answer on a read-only one.
 */
const CHANNEL = { id: "800000x1x0", partnerPublicKey: BUYER, capacity: 2_000_000, localBalance: 1_000_000, transactionId: "ab".repeat(32), transactionVout: 0 };
const INVOICE =
  "lnbc1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq9qrsgq357wnc5r2ueh7ck6q93dj32dlqnls087fxdwk8qakdyafkq3yap9us6v52vjjsrvywa6rt52cm9r9zqt8r2t7mlcwspyetp5h2tztugp9lfyql";
type Walk = { body?: (ids: { offerOn: string; offerOff: string; sale: string; channelId: string }) => unknown; expect: number };
const WALK: Record<string, Walk> = {
  "POST /auth/unlock": { body: () => ({ password: "nope" }), expect: 401 },
  "POST /backup/export": { expect: 200 },
  "POST /overrides": { body: (i) => ({ channelId: i.channelId, mode: "fixed", fixedPpm: 100 }), expect: 200 },
  "POST /alerts/ack": { body: () => ({ id: "nothing-here" }), expect: 404 },
  "POST /channels/close": { body: () => ({ transactionId: CHANNEL.transactionId, transactionVout: 0, isForce: false, feeRate: 2 }), expect: 403 },
  "POST /peers/connect": { body: () => ({ pubkey: BUYER, socket: "127.0.0.1:9735" }), expect: 403 },
  "POST /fees/apply": { body: (i) => ({ items: [{ channelId: i.channelId, feeRatePpm: 100 }] }), expect: 403 },
  "POST /fees/apply-recommended": { expect: 403 },
  "POST /autopilot": { body: () => ({ enabled: true, rebalanceEnabled: true, channelEnabled: true, sellEnabled: true, maxHtlcEnabled: true }), expect: 200 },
  "POST /autopilot/pause": { expect: 200 },
  "POST /autopilot/resume": { expect: 200 },
  "POST /autopilot/run": { expect: 403 },
  "POST /rebalance/execute": { body: (i) => ({ outChannelId: i.channelId, inPubkey: BUYER, tokens: 100_000, maxFeeSats: 100 }), expect: 403 },
  "POST /channels/never-open": { body: () => ({ pubkey: BUYER, never: true, alias: "a peer" }), expect: 200 },
  "POST /channels/open": { body: () => ({ pubkey: BUYER, localTokens: 1_000_000, feeRate: 2 }), expect: 403 },
  // LSP mode sells channels: refused ("read_only") without write mode.
  "POST /settings": { body: () => ({ fiatCurrency: "EUR", lspModeEnabled: true }), expect: 400 },
  "POST /ln/decode": { body: () => ({ request: INVOICE }), expect: 200 },
  "POST /ln/invoice": { body: () => ({ tokens: 1000, description: "x" }), expect: 403 },
  "POST /ln/pay": { body: () => ({ request: INVOICE, maxFeeSats: 10 }), expect: 403 },
  "POST /onchain/address": { expect: 403 },
  "POST /onchain/send": { body: () => ({ address: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", feeRate: 2, tokens: 100_000 }), expect: 403 },
  "POST /sign": { body: () => ({ message: "hello" }), expect: 403 },
  "POST /amboss/key/check": { expect: 200 },
  "POST /amboss/buy/quote": { body: () => ({ usdCents: 1000, private: false }), expect: 403 },
  // (An order this node never placed: nothing to cancel, and nothing sent.)
  "POST /amboss/buy/cancel": { body: () => ({ orderId: "no-such-order" }), expect: 404 },
  "POST /amboss/buy/pay": { body: () => ({ orderId: "no-such-order", maxSats: 10_000 }), expect: 403 },
  "POST /amboss/offer": { body: () => ({ ...TERMS, another: true }), expect: 403 },
  "POST /amboss/offer/update": { body: (i) => ({ id: i.offerOn, ...TERMS }), expect: 403 },
  // Listing is refused; the same route takes an offer off the market (below).
  "POST /amboss/offer/toggle": { body: (i) => ({ id: i.offerOff, want: "ENABLED" }), expect: 403 },
  "POST /amboss/offer/automation": { body: (i) => ({ id: i.offerOn, managed: false }), expect: 200 },
  "POST /amboss/order/accept": { body: (i) => ({ id: i.sale }), expect: 403 },
  "POST /amboss/order/open": { body: (i) => ({ id: i.sale }), expect: 403 },
  "POST /amboss/order/reject": { body: (i) => ({ id: i.sale }), expect: 403 },
  "POST /amboss/key": { body: () => ({ apiKey: "another-key" }), expect: 200 },
  "DELETE /amboss/key": { expect: 200 },
};

/** What LND may be asked on a read-only install: reads. Anything else the
 *  walk calls fails it — a route that reached a write through the read
 *  client would be refused by a real read-only macaroon, after the fact. */
const LND_READS = new Set([
  "default.getInfo",
  "default.listChannels",
  "default.pendingChannels",
  "default.closedChannels",
  "default.walletBalance",
  "default.channelBalance",
  "default.feeReport",
  "default.forwardingHistory",
  "default.listPeers",
  "default.getNodeInfo",
  "default.getChanInfo",
  "default.decodePayReq",
  "default.exportAllChannelBackups",
  "default.getTransactions",
  "wallet.estimateFee",
  "wallet.listUnspent",
]);

test("ENG-1: a read-only install — every POST and DELETE the router has is walked: LND is only read, and Amboss is sent nothing but an offer taken off the market", async (t) => {
  const node = new FakeLnd({ chainBalance: 5_000_000, channels: [CHANNEL] });
  const { api, magma } = await install(t, { readOnly: true, node });
  const offerOn = magma.addOffer({ status: "ENABLED", minSats: 250_000, maxSats: 2_000_000, totalSats: 5_000_000 });
  const offerOff = magma.addOffer({ status: "DISABLED", minSats: 250_000, maxSats: 2_000_000, totalSats: 5_000_000 });
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 1_000_000 });

  const writes = api.routes.filter((r) => !r.startsWith("GET "));
  // A route added later is walked too, or this fails.
  assert.deepEqual([...writes].sort(), Object.keys(WALK).sort(), "every POST and DELETE route has a line in WALK");

  const ids = { offerOn: offerOn.id, offerOff: offerOff.id, sale: sale.id, channelId: CHANNEL.id };
  const before = node.calls.length;
  for (const route of Object.keys(WALK)) {
    const [method, path] = route.split(" ") as [string, string];
    const step = WALK[route]!;
    const res = await api.request(method, path, step.body?.(ids));
    assert.equal(res.status, step.expect, `${route} answered ${res.status} ${JSON.stringify(res.body ?? null).slice(0, 300)}`);
    if (step.expect === 403) {
      assert.ok(["write_disabled", "read_only"].includes(res.body.error ?? res.body.code), `${route}: refused for want of write mode — ${JSON.stringify(res.body)}`);
    }
  }
  const asked = [...new Set(node.calls.slice(before).map((c) => c.method))];
  assert.deepEqual(
    asked.filter((m) => !LND_READS.has(m)),
    [],
    "LND was only read",
  );
  assert.deepEqual(mutations(magma), [], "nothing was sent to Amboss");
  assert.equal(offerOff.status, "DISABLED");
  assert.equal(magma.offers.size, 2);
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_SELLER_APPROVAL");

  // The one thing a read-only install may tell Amboss: an offer comes off the market.
  api.amboss.setKey("test-key");
  const off = await api.request("POST", "/amboss/offer/toggle", { id: offerOn.id, want: "DISABLED" });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(mutations(magma), ["ToggleOffer×1"]);
  assert.equal(offerOn.status, "DISABLED");
  assert.deepEqual(
    [...new Set(node.calls.slice(before).map((c) => c.method))].filter((m) => !LND_READS.has(m)),
    [],
  );
});
