/**
 * On-chain sends with guardrails (review a4-lsp-payments:onchain-send-
 * guardrails — package P5).
 *
 * Before: any rate from 1 to 2,000 sat/vB went out after one generic confirm
 * ("Send N sat to … at R sat/vByte") — no fee in sats, no comparison with the
 * next block's rate (200 typed for 20: ~28k sat on a typical send), nothing
 * about the reserve the node keeps for anchor fee bumps and its own channel
 * sales, and no way to send the most it can spare, or everything.
 *
 * Now a preview gives the fee from LND's own size of the transaction, LND's
 * next-block rate, what stays and what needs a second yes; the send makes
 * the same preview again inside the on-chain mutex and refuses (409
 * confirm_send) what the operator didn't confirm. "Max" sends the most that
 * keeps the reserve and the promised coins; "everything" sweeps (LND keeps
 * its anchor reserve). Coins promised to buyers keep their own named yes
 * (capital.test.ts).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { FakeLnd, type FakeChannel } from "./helpers/fakeLnd.js";
import { startApi } from "./helpers/apiHarness.js";

const ADDRESS = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"; // P2WPKH: a 31-vbyte output

/** `n` open anchor channels (LND keeps 10k on-chain for each, up to 100k). */
const anchorChannels = (n: number): FakeChannel[] =>
  Array.from({ length: n }, (_, i) => ({
    partnerPublicKey: "03" + (i + 1).toString(16).padStart(2, "0").repeat(32),
    capacity: 1_000_000,
    localBalance: 500_000,
    transactionId: (i + 1).toString(16).padStart(64, "0"),
    transactionVout: 0,
  }));

/** The wallet's coins as LND lists them (P2WPKH, confirmed). */
function listCoins(node: FakeLnd, sats: () => number[]): void {
  const impl = (_a: Record<string, unknown>, cb: (err: unknown, res?: unknown) => void) =>
    cb(null, {
      utxos: sats().map((amount, i) => ({
        address: ADDRESS,
        address_type: "WITNESS_PUBKEY_HASH",
        amount_sat: String(amount),
        confirmations: "6",
        outpoint: { output_index: i, txid_str: "ab".repeat(32) },
        pk_script: "0014" + "11".repeat(20),
      })),
    });
  node.override("wallet.listUnspent", impl);
  node.override("default.listUnspent", impl);
}

/** A node whose LND estimates fees: `rates` sat/vB per confirmation target,
 *  and every send 141 vbytes (one input, the output and change). Its coins:
 *  one UTXO of the whole balance unless a test lists others.
 *
 *  As LND answers: rates in sat/kw (a fractional sat/vB); EstimateFee's fee
 *  at that exact rate, truncated (btcwallet: ⌊sat/kvB × vbytes / 1000⌋),
 *  with its sat_per_vbyte a whole number, cut down (FeePerVByte()). LND
 *  before 0.20 refuses a 1-block target (`rejectTarget1`). `sendRate`: the
 *  rate EstimateFee uses when the estimate moved since walletrpc's answer. */
async function wallet(
  t: TestContext,
  o: { chainBalance: number; channels?: FakeChannel[]; rates?: Record<number, number>; rejectTarget1?: boolean; sendRate?: number },
) {
  const node = new FakeLnd({ chainBalance: o.chainBalance, channels: o.channels ?? [] });
  listCoins(node, () => [node.chainBalance]);
  const rates: Record<number, number> = { 1: 20, 3: 10, 6: 8, 36: 2, ...(o.rates ?? {}) };
  const satPerKw = (target: number) => Math.round((rates[target] ?? rates[6]) * 250);
  node.override("wallet.estimateFee", (a, cb) => {
    const target = Number(a.conf_target) || 6;
    if (target < 2 && o.rejectTarget1) return cb({ details: "confirmation target must be greater than 1" });
    cb(null, { sat_per_kw: String(satPerKw(target)), min_relay_fee_sat_per_kw: "253" });
  });
  node.override("default.estimateFee", (a, cb) => {
    const total = Object.values(a.AddrToAmount as Record<string, number>).reduce((s, v) => s + Number(v), 0);
    if (total + 1_000 > node.chainBalance) return cb({ details: "insufficient funds available to construct transaction" });
    const kw = o.sendRate !== undefined ? Math.round(o.sendRate * 250) : satPerKw(Number(a.target_conf) || 6);
    const whole = Math.floor((kw * 4) / 1000);
    cb(null, { fee_sat: String(Math.floor((kw * 4 * 141) / 1000)), sat_per_vbyte: String(whole), feerate_sat_per_byte: String(whole) });
  });
  node.override("default.sendCoins", (_a, cb) => cb(null, { txid: "ef".repeat(32) }));
  const api = await startApi(t, { node });
  const preview = (q: Record<string, string | number>) =>
    api.request("GET", `/onchain/send-preview?${new URLSearchParams(Object.entries({ address: ADDRESS, ...q }).map(([k, v]) => [k, String(v)]))}`);
  return { api, node, preview };
}

test("the preview gives the fee in sats from LND's size of the transaction and its next-block rate — and 200 sat/vB typed for 20 needs a second yes, enforced by the send itself", async (t) => {
  const { api, node, preview } = await wallet(t, { chainBalance: 5_000_000 });
  const p = await preview({ tokens: 2_000_000, feeRate: 200 });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual([p.body.vbytes, p.body.feeSats, p.body.feeApprox], [141, 28_200, false], "LND's 141 vbytes × 200 sat/vB");
  assert.deepEqual(p.body.estimates, { fast: 20, fastTarget: 1, normal: 10, economy: 2 });
  assert.deepEqual(p.body.checks.map((c: { code: string }) => c.code), ["fee_rate_high"]);
  assert.equal(
    p.body.checks[0].message,
    "200 sat/vB is more than 3× what LND estimates for the next block (20 sat/vB): this send pays ~28,200 sat in fees.",
  );
  assert.equal(p.body.remainingSats, 5_000_000 - 2_000_000 - 28_200);

  // Before: sent at once. Now the send checks again and asks for the yes.
  const blind = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 2_000_000, feeRate: 200 });
  assert.equal(blind.status, 409);
  assert.equal(blind.body.error, "confirm_send");
  assert.deepEqual(blind.body.checks.map((c: { code: string }) => c.code), ["fee_rate_high"]);
  assert.equal(node.callsTo("default.sendCoins").length, 0, "nothing sent");
  const sure = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 2_000_000, feeRate: 200, confirmed: ["fee_rate_high"] });
  assert.equal(sure.status, 200, JSON.stringify(sure.body));
  const [sent] = node.callsTo("default.sendCoins");
  assert.deepEqual([Number(sent.amount), Number(sent.sat_per_vbyte), sent.send_all], [2_000_000, 200, undefined]);

  // At a sane rate there's nothing to confirm.
  const normal = await preview({ tokens: 2_000_000, feeRate: 12 });
  assert.deepEqual(normal.body.checks, []);
});

test("a fee above 2% of the amount needs a second yes too", async (t) => {
  const { api, node, preview } = await wallet(t, { chainBalance: 5_000_000 });
  const p = await preview({ tokens: 20_000, feeRate: 10 });
  assert.deepEqual(p.body.checks.map((c: { code: string; message: string }) => [c.code, c.message]), [["fee_share_high", "The fee (~1,410 sat) is 7.1% of the 20,000 sat sent."]]);
  assert.equal((await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 20_000, feeRate: 10 })).status, 409);
  assert.equal((await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 20_000, feeRate: 10, confirmed: ["fee_share_high"] })).status, 200);
  assert.equal(node.callsTo("default.sendCoins").length, 1);
});

// Review of P5: LND's EstimateFee prices the fee at its exact rate (sat/kw)
// but reports the rate in whole sat/vB, cut down. The preview divided the
// one by the other: at a 6-block rate of 1.99 sat/vB — common in a quiet
// mempool — a 141-vbyte send read as 280 vbytes, its fee at 10 sat/vB as
// 2,800 sat instead of 1,410, presented as LND's own size; Max held back
// ~1,400 sat more than needed, and the fee's share was asked about too early.
test("LND prices the fee at its exact rate but reports the rate in whole sat/vB: at fractional 6-block rates the preview still has the send's 141 vbytes — 1,410 sat at 10 sat/vB — and Max is what the wallet page says can be spared", async (t) => {
  for (const r6 of [1.012, 1.5, 1.99, 2.5, 3.5, 10.5]) {
    const { api, preview } = await wallet(t, { chainBalance: 5_000_000, rates: { 6: r6 } });
    const p = await preview({ tokens: 1_000_000, feeRate: 10 });
    assert.deepEqual([p.body.vbytes, p.body.feeSats, p.body.feeApprox], [141, 1_410, false], `6-block rate ${r6} sat/vB`);
    const state = await api.request("GET", "/onchain");
    assert.equal(state.body.suggestedFeeRate, 10);
    const max = await preview({ max: 1, feeRate: state.body.suggestedFeeRate });
    assert.equal(max.body.amountSats, 5_000_000 - state.body.budget.reserveSats - 1_410, `6-block rate ${r6} sat/vB`);
    assert.equal(state.body.budget.availableSats, max.body.amountSats, "the page's 'available to send' is Max at the suggested rate");
  }
  // The two reads disagree — the estimate moved between them (LND priced the
  // fee at 1.5 sat/vB, walletrpc now says 3): no size LND vouches for, so
  // the size from the wallet's coins (10.5 + 68 + 31 + 43 = 152.5), said to
  // be an estimate — never 211 sat ÷ 3 = 71 vbytes.
  const moved = await wallet(t, { chainBalance: 5_000_000, rates: { 6: 3 }, sendRate: 1.5 });
  const m = await moved.preview({ tokens: 1_000_000, feeRate: 10 });
  assert.deepEqual([m.body.vbytes, m.body.feeApprox], [152.5, true]);
});

test("on an LND that won't estimate for one block (before 0.20), the rate check compares with its 2-block rate: 200 sat/vB typed still needs a second yes — and the close dialog gets its 'fast' rate", async (t) => {
  const { api, node, preview } = await wallet(t, { chainBalance: 10_000_000, rates: { 2: 25 }, rejectTarget1: true });
  const p = await preview({ tokens: 5_000_000, feeRate: 200 });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  // Before: LND refused the 1-block target, `fast` was empty, and the check
  // never ran — no question asked, and the send went out.
  assert.deepEqual(p.body.estimates, { fast: 25, fastTarget: 2, normal: 10, economy: 2 });
  assert.deepEqual(
    p.body.checks.map((c: { code: string; message: string }) => [c.code, c.message]),
    [["fee_rate_high", "200 sat/vB is more than 3× LND's 2-block rate (25 sat/vB): this send pays ~28,200 sat in fees."]],
  );
  const blind = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 5_000_000, feeRate: 200 });
  assert.deepEqual([blind.status, blind.body.error], [409, "confirm_send"]);
  assert.equal(node.callsTo("default.sendCoins").length, 0, "nothing sent");
  const sure = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 5_000_000, feeRate: 200, confirmed: ["fee_rate_high"] });
  assert.equal(sure.status, 200, JSON.stringify(sure.body));
  const fees = await api.request("GET", "/chain/fee-estimates");
  assert.deepEqual(fees.body, { fast: 25, fastTarget: 2, normal: 10, economy: 2 });
});

test("dipping into the on-chain reserve (D5: here LND's anchor reserve for 6 channels) needs a second yes; Max sends the most that keeps it — and the wallet page says what can be spared", async (t) => {
  const { api, node, preview } = await wallet(t, { chainBalance: 1_000_000, channels: anchorChannels(6), rates: { 6: 2 } });
  const tooMuch = await preview({ tokens: 980_000, feeRate: 2 });
  assert.deepEqual(tooMuch.body.checks.map((c: { code: string }) => c.code), ["below_reserve"]);
  assert.equal(
    tooMuch.body.checks[0].message,
    "This leaves 19,718 sat on-chain — less than the 60,000 sat on-chain reserve (LND's anchor reserve for fee-bumping 6 anchor channels). Channel opens, channel sales and fee bumps when closing need it.",
  );
  assert.equal((await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 980_000, feeRate: 2 })).status, 409);

  const max = await preview({ max: 1, feeRate: 2 });
  assert.equal(max.status, 200, JSON.stringify(max.body));
  // 1,000,000 − 60,000 kept − 282 fee (141 vbytes × 2).
  assert.deepEqual([max.body.mode, max.body.amountSats, max.body.feeSats, max.body.remainingSats], ["max", 939_718, 282, 60_000]);
  assert.deepEqual(max.body.checks, []);
  const sent = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: max.body.amountSats, feeRate: 2 });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(Number(node.callsTo("default.sendCoins")[0].amount), 939_718);

  // The wallet page: what can be spared, with a typical send's fee.
  node.chainBalance = 1_000_000;
  const state = await api.request("GET", "/onchain");
  assert.deepEqual([state.body.budget.reserveSats, state.body.budget.promisedSats], [60_000, 0]);
  assert.ok(state.body.budget.availableSats < 940_000 && state.body.budget.availableSats > 935_000, String(state.body.budget.availableSats));
});

test("send everything: a sweep (LND keeps its anchor reserve as change), its fee from the wallet's coins — below a larger reserve setting it needs a second yes", async (t) => {
  const { api, node, preview } = await wallet(t, { chainBalance: 1_000_000, channels: anchorChannels(6), rates: { 6: 2 } });
  listCoins(node, () => [600_000, 400_000]);
  api.autopilot.setConfig({ sellReserveSats: 100_000 });
  const all = await preview({ all: 1, feeRate: 2 });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  // 10.5 overhead + 2 × 68 inputs + 31 output + 43 change (LND's anchor reserve) = 220.5 vbytes.
  assert.deepEqual([all.body.mode, all.body.vbytes, all.body.feeSats, all.body.feeApprox], ["all", 220.5, 441, true]);
  assert.equal(all.body.amountSats, 1_000_000 - 60_000 - 441, "LND keeps 10k per anchor channel");
  assert.deepEqual(all.body.checks.map((c: { code: string }) => c.code), ["below_reserve"], "leaves 60k: below the 100k setting");

  const blind = await api.request("POST", "/onchain/send", { address: ADDRESS, sendAll: true, feeRate: 2 });
  assert.equal(blind.status, 409);
  const swept = await api.request("POST", "/onchain/send", { address: ADDRESS, sendAll: true, feeRate: 2, confirmed: ["below_reserve"] });
  assert.equal(swept.status, 200, JSON.stringify(swept.body));
  const [sent] = node.callsTo("default.sendCoins");
  assert.deepEqual([sent.send_all, sent.amount, Number(sent.sat_per_vbyte)], [true, undefined, 2], "LND sends all: no amount");
});

test("a send the wallet can't cover is refused with the reason, and every request names exactly one way to send", async (t) => {
  const { api, node, preview } = await wallet(t, { chainBalance: 100_000 });
  const p = await preview({ tokens: 99_900, feeRate: 10 });
  // LND can't build it; the size from the wallet's one coin: 10.5 + 68 + 31 + 43 = 152.5 vbytes.
  assert.equal(p.body.error, "the wallet's confirmed coins (100,000 sat) don't cover 99,900 sat and the ~1,525 sat fee");
  assert.equal(p.body.feeApprox, true);
  const refused = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: 99_900, feeRate: 10, confirmed: ["fee_share_high", "below_reserve"] });
  assert.deepEqual([refused.status, refused.body.error], [400, "bad_send"]);
  // From here the wallet covers every amount asked, with nothing to confirm:
  // a request the send failed to refuse would go out, not merely ask a
  // second yes.
  node.chainBalance = 5_000_000;
  for (const body of [
    { address: ADDRESS, tokens: 50_000, sendAll: true, feeRate: 2 },
    { address: ADDRESS, feeRate: 2 },
    { address: ADDRESS, tokens: 50_000, feeRate: 2, confirmed: "fee_rate_high" },
    { address: ADDRESS, tokens: 50_000, feeRate: 2_001 },
  ]) {
    assert.equal((await api.request("POST", "/onchain/send", body)).status, 400, JSON.stringify(body));
  }
  // `max` and `all` are the preview's words (the send's amount is `tokens`,
  // a sweep `sendAll`): refused with the reason, not ignored — next to an
  // amount either would send the amount without a word. The send hands its
  // parser no `max`, so this refusal is all that stops the first (review of
  // P8, run 2: each route reads only its own contract's keys).
  for (const body of [
    { address: ADDRESS, tokens: 50_000, max: true, feeRate: 2 },
    { address: ADDRESS, tokens: 50_000, all: true, feeRate: 2 },
    { address: ADDRESS, sendAll: true, max: true, feeRate: 2 },
    { address: ADDRESS, max: true, feeRate: 2 },
    { address: ADDRESS, all: true, feeRate: 2 },
  ]) {
    const res = await api.request("POST", "/onchain/send", body);
    assert.deepEqual(
      [res.status, res.body.error, res.body.message],
      [400, "bad_request", "send an amount (the preview's max) or sendAll — not the preview's max or all."],
      JSON.stringify(body),
    );
  }
  // Each route takes its own words, and names them when none was given: the
  // send's `sendAll` is no sweep in the preview.
  const unsaid = await preview({ sendAll: 1, feeRate: 2 });
  assert.equal(unsaid.status, 400);
  assert.match(unsaid.body.message, /and one of tokens \(≥\d+ sat\), max or all required\.$/);
  const sendUnsaid = await api.request("POST", "/onchain/send", { address: ADDRESS, feeRate: 2 });
  assert.match(sendUnsaid.body.message, /and one of tokens \(≥\d+ sat\) or sendAll required\.$/);
  assert.equal(node.callsTo("default.sendCoins").length, 0);
});

test("Max or 'send everything' that would leave less than LND sends (546 sat) is refused with the reason — nothing sent", async (t) => {
  // 50,000 is the reserve the node keeps (the default setting).
  const { api, node, preview } = await wallet(t, { chainBalance: 50_400 });
  const max = await preview({ max: 1, feeRate: 2 });
  assert.equal(max.body.error, "nothing can be sent while the node keeps 50,000 sat (the on-chain reserve) and pays the fee");
  node.chainBalance = 600;
  const all = await preview({ all: 1, feeRate: 2 });
  // One coin, no change: 10.5 + 68 + 31 = 109.5 vbytes, 219 sat at 2 sat/vB.
  assert.equal(all.body.error, "after the ~219 sat fee, 381 sat would be left to send — less than the 546 sat LND sends");
  node.chainBalance = 150;
  assert.equal((await preview({ all: 1, feeRate: 2 })).body.error, "the wallet's confirmed coins don't cover the fee of sending them");
  node.chainBalance = 600;
  const sent = await api.request("POST", "/onchain/send", { address: ADDRESS, sendAll: true, feeRate: 2, confirmed: ["fee_rate_high", "fee_share_high", "below_reserve"], spendPromised: true });
  assert.deepEqual([sent.status, sent.body.error], [400, "bad_send"]);
  assert.equal(node.callsTo("default.sendCoins").length, 0);
});

// ── coins promised to buyers ─────────────────────────────────────────────────

/** A paid order whose channel isn't open yet: 1,000,000 sat promised (its
 *  own open is checked against the 50,000 sat sell reserve). */
function promise(api: Awaited<ReturnType<typeof wallet>>["api"]): void {
  api.capital.register("test-sales", {
    reservations: () => [{ key: "magma:order-1", sats: 1_000_000, reserveSat: 50_000 }],
    deployedSat: () => 0,
    claimedOutpoints: () => [],
  });
}

for (const rate of [2, 30]) {
  test(`with coins promised to a buyer, Max (at ${rate} sat/vB) is exactly what the send lets through without the named question — and touchesPromised is exactly whether the send asks it`, async (t) => {
    const { api, node, preview } = await wallet(t, { chainBalance: 5_000_000 });
    promise(api);
    const max = await preview({ max: 1, feeRate: rate });
    // 5,000,000 − 1,000,000 promised − 51,400 reserve (the sell reserve and
    // the promised open's funding fee) − the send's own fee (141 vbytes).
    const fee = 141 * rate;
    assert.deepEqual([max.body.amountSats, max.body.feeSats, max.body.touchesPromised, max.body.checks], [3_948_600 - fee, fee, false, []]);
    // Before: the send counted a funding-fee estimate (1,400 sat) for itself
    // instead of its fee — at 2 sat/vB "Max" was refused as touching the
    // promised coins (409); at 30 sat/vB a send the preview flagged went out.
    const sent = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: max.body.amountSats, feeRate: rate });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(Number(node.callsTo("default.sendCoins")[0]?.amount), max.body.amountSats);

    const over = await preview({ tokens: max.body.amountSats + 1, feeRate: rate });
    assert.equal(over.body.touchesPromised, true, "one sat more takes promised coins");
    assert.deepEqual(over.body.checks, [], "asked by the named question alone — not about the reserve on top");
    const refused = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: max.body.amountSats + 1, feeRate: rate });
    assert.deepEqual([refused.status, refused.body.error, refused.body.spendableSat], [409, "capital_promised", max.body.amountSats]);
    assert.deepEqual(refused.body.promised, [{ source: "magma", orderId: "order-1", sats: 1_000_000 }]);
    assert.equal(node.callsTo("default.sendCoins").length, 1, "nothing more sent");
  });
}

test("the wallet page's 'available to send' is what Max fills in at the rate the form starts with — promised coins or not", async (t) => {
  const { api, preview } = await wallet(t, { chainBalance: 5_000_000 });
  for (const promised of [false, true]) {
    if (promised) promise(api);
    const state = await api.request("GET", "/onchain");
    assert.equal(state.body.suggestedFeeRate, 10, "LND's 3-block estimate pre-fills the form");
    assert.equal(state.body.budget.feeRate, 10);
    const max = await preview({ max: 1, feeRate: state.body.suggestedFeeRate });
    // Before: the page took a funding-fee estimate as the send's fee — a
    // different figure than Max then filled in.
    assert.equal(state.body.budget.availableSats, max.body.amountSats, promised ? "with a promise" : "without");
  }
});

test("sending everything takes the promised coins too: refused with the named question (nothing sent) — and with the explicit yes, swept with send_all", async (t) => {
  const { api, node, preview } = await wallet(t, { chainBalance: 5_000_000 });
  promise(api);
  const all = await preview({ all: 1, feeRate: 2 });
  assert.equal(all.body.touchesPromised, true);
  const confirmed = all.body.checks.map((c: { code: string }) => c.code);
  const refused = await api.request("POST", "/onchain/send", { address: ADDRESS, sendAll: true, feeRate: 2, confirmed });
  assert.deepEqual([refused.status, refused.body.error], [409, "capital_promised"]);
  assert.deepEqual(refused.body.promised, [{ source: "magma", orderId: "order-1", sats: 1_000_000 }]);
  assert.match(refused.body.message, /^Only [\d,]+ sat can be spent without touching the coins promised to buyers/);
  assert.equal(node.callsTo("default.sendCoins").length, 0, "nothing sent");
  const swept = await api.request("POST", "/onchain/send", { address: ADDRESS, sendAll: true, feeRate: 2, confirmed, spendPromised: true });
  assert.equal(swept.status, 200, JSON.stringify(swept.body));
  const [sent] = node.callsTo("default.sendCoins");
  assert.deepEqual([sent.send_all, sent.amount], [true, undefined]);
});

test("with coins promised, a send that leaves them but dips into the operator's larger reserve setting asks about the reserve — counting the promised coins as spent", async (t) => {
  const { api, preview } = await wallet(t, { chainBalance: 5_000_000 });
  promise(api);
  api.autopilot.setConfig({ channelReserveSats: 100_000 });
  const max = await preview({ max: 1, feeRate: 2 });
  // The reserve is the operator's 100,000 setting (+ the promised open's fee).
  assert.deepEqual([max.body.reserveSats, max.body.amountSats], [101_400, 5_000_000 - 1_000_000 - 101_400 - 282]);
  // 40,000 more: the promised coins stay, but the reserve doesn't.
  const dip = await preview({ tokens: max.body.amountSats + 40_000, feeRate: 2 });
  assert.equal(dip.body.touchesPromised, false);
  // Before: no question — the 1,000,000 promised coins counted as left over.
  assert.deepEqual(dip.body.checks.map((c: { code: string }) => c.code), ["below_reserve"]);
  assert.equal(
    dip.body.checks[0].message,
    "Besides the 1,000,000 sat promised to buyers, this leaves 61,400 sat on-chain — less than the 101,400 sat on-chain reserve (your on-chain reserve setting). Channel opens, channel sales and fee bumps when closing need it.",
  );
  assert.equal((await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: max.body.amountSats + 40_000, feeRate: 2 })).status, 409);
  const sure = await api.request("POST", "/onchain/send", { address: ADDRESS, tokens: max.body.amountSats + 40_000, feeRate: 2, confirmed: ["below_reserve"] });
  assert.equal(sure.status, 200, JSON.stringify(sure.body));
});
