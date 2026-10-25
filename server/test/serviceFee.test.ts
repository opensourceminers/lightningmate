import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEE_RETRY_DAYS,
  ServiceFeeLedger,
  checkFeeInvoice,
  feeForSale,
  lndFeeLightning,
} from "../src/services/serviceFee.js";
import { serviceFeeAlerts } from "../src/services/alerts.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { hang, installFetchMock } from "./helpers/fetchMock.js";
import { mockLnurlPayServer } from "./helpers/lnurl.js";
import { makeNodeKey } from "./helpers/bolt11.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";
import { withEnv } from "./helpers/env.js";

const ADDRESS = "fees@fees.example";
const HOUR = 3_600_000;
const GAVE_UP = new RegExp(`gave up after \\d+ attempts in ${FEE_RETRY_DAYS} days`);

/** Pass after pass, a day and an hour apart, until the fee is no longer
 *  owed (or `limit` passes): the time that took. */
async function untilSettled(ledger: ServiceFeeLedger, clock: { now(): number; advance(ms: number): number }, limit = FEE_RETRY_DAYS + 5): Promise<number> {
  const start = clock.now();
  for (let i = 0; i < limit && ledger.entries()[0].state === "pending"; i++) {
    clock.advance(25 * HOUR);
    await ledger.processDue();
  }
  return clock.now() - start;
}

function feeEnv(t: AfterHook, extra: Record<string, string | undefined> = {}): void {
  withEnv(t, { LM_SELL_FEE_BPS: "100", LM_SELL_FEE_ADDRESS: ADDRESS, LM_SELL_FEE_PUBKEY: undefined, ...extra });
}

/** A payment that is meant to go through gets plenty of time: on a busy CI
 *  runner the fake payment can take longer than a short timeout, which would
 *  turn a success into "still in flight". */
const PAY_TIMEOUT_MS = 10_000;
/** A STUCK payment's timeout: short, so a test of a hanging payment is quick
 *  — a hang never completes, so this timeout always wins, however busy the
 *  machine. */
const STUCK_PAY_TIMEOUT_MS = 150;

/** A ledger on a fake node with a controllable clock. Tests of a stuck
 *  payment pass STUCK_PAY_TIMEOUT_MS. */
function setup(
  t: AfterHook & { after(fn: () => void): void },
  node = new FakeLnd(),
  dir = makeTempDir(t),
  payTimeoutMs = PAY_TIMEOUT_MS,
) {
  let now = Date.now();
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  const make = (timeoutMs = PAY_TIMEOUT_MS) => {
    const ledger = new ServiceFeeLedger(dir, lndFeeLightning(node.lnd), { payTimeoutMs: timeoutMs, now: clock.now });
    t.after(() => ledger.stop());
    return ledger;
  };
  return { node, dir, clock, ledger: make(payTimeoutMs), restart: make };
}

const sends = (node: FakeLnd) => node.callsTo("router.sendPaymentV2");

test("feeForSale is bps of what was earned, rounded down", () => {
  assert.equal(feeForSale(12_345, 100), 123);
  assert.equal(feeForSale(99, 100), 0);
  assert.equal(feeForSale(12_345, 0), 0);
});

test("checkFeeInvoice fails closed on everything but an exact, unexpired invoice to the right payee", () => {
  const base = { id: "aa".repeat(32), destination: "02" + "11".repeat(32), mtokens: "123000", expiresAt: "2030-01-01T00:00:00Z" };
  const expect = { sats: 123, ownPubkey: "03" + "22".repeat(32), payeePubkey: null, now: Date.parse("2026-10-17T00:00:00Z") };
  assert.equal(checkFeeInvoice(base, expect), "ok");
  assert.equal(checkFeeInvoice({ ...base, mtokens: "123001" }, expect), "amount_mismatch");
  assert.equal(checkFeeInvoice({ ...base, mtokens: "0" }, expect), "amount_mismatch", "amountless");
  assert.equal(checkFeeInvoice({ ...base, mtokens: "5000000000" }, expect), "amount_mismatch");
  assert.equal(checkFeeInvoice({ ...base, expiresAt: "2026-01-01T00:00:00Z" }, expect), "expired");
  assert.equal(checkFeeInvoice({ ...base, destination: expect.ownPubkey }, expect), "self");
  assert.equal(checkFeeInvoice(base, { ...expect, payeePubkey: "02" + "33".repeat(32) }), "payee_mismatch");
  assert.equal(checkFeeInvoice(base, { ...expect, payeePubkey: base.destination }), "ok");
});

test("pays exactly the computed fee, after verifying the invoice, without passing an amount", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t);
  const fees = mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });

  ledger.enqueue({ source: "magma", orderId: "ord-1", earnedSats: 12_345 });
  await ledger.processDue();

  assert.deepEqual(fees.requestedMsat, [123_000]);
  const [e] = ledger.entries();
  assert.equal(e.state, "paid");
  assert.equal(e.feeSats, 123);
  assert.equal(e.paidSats, 123, "records what actually reached the fee address");
  assert.equal(e.routingFeeSats, 2, "and what delivering it cost");
  const [send] = sends(node);
  assert.equal(sends(node).length, 1);
  assert.equal(send.amt, undefined, "never an explicit amount: LND pays the verified invoice amount");
  assert.equal(send.amt_msat, undefined);
  assert.equal(ledger.paidFor("magma", "ord-1"), 123);
});

test("refuses an invoice for the wrong amount (LUD-06), alerts, and eventually gives up — never pays", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, invoiceMsat: (asked) => asked * 1000, now: clock.now });

  ledger.enqueue({ source: "magma", orderId: "ord-2", earnedSats: 12_345 });
  await ledger.processDue();
  let [e] = ledger.entries();
  assert.equal(e.state, "pending");
  assert.equal(e.lastErrorCode, "amount_mismatch");
  assert.equal(ledger.problems().length, 1, "surfaced as an alert while it keeps retrying");

  const took = await untilSettled(ledger, clock);
  [e] = ledger.entries();
  assert.equal(e.state, "failed");
  assert.ok(took >= FEE_RETRY_DAYS * 24 * HOUR, `tried for ${FEE_RETRY_DAYS} days first (${Math.round(took / HOUR)} h)`);
  assert.match(e.lastError ?? "", GAVE_UP);
  assert.equal(sends(node).length, 0);
});

test("dismissing a refused invoice's alert doesn't hide that the fee was given up later", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, invoiceMsat: (asked) => asked * 1000, now: clock.now });
  t.mock.method(console, "error", () => undefined);

  ledger.enqueue({ source: "magma", orderId: "ord-ack", earnedSats: 12_345 });
  await ledger.processDue();
  assert.equal(serviceFeeAlerts(ledger).length, 1, "the refusal is alerted");
  assert.equal(ledger.acknowledge("magma:ord-ack"), true);
  assert.equal(serviceFeeAlerts(ledger).length, 0, "and dismissed");

  clock.advance(25 * HOUR);
  await ledger.processDue();
  assert.equal(serviceFeeAlerts(ledger).length, 0, "the same refusal on the next try stays dismissed");
  await untilSettled(ledger, clock);
  assert.equal(ledger.entries()[0].state, "failed");
  // Before: the dismissal stuck to the entry, so the give-up — which needs a
  // human, and which SECURITY.md promises to alert — never showed.
  const alerts = serviceFeeAlerts(ledger);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, GAVE_UP);
  assert.equal(ledger.acknowledge("magma:ord-ack"), true);
  assert.equal(serviceFeeAlerts(ledger).length, 0, "dismissing the give-up silences it for good");
  assert.equal(sends(node).length, 0);
});

test("a different refusal after a dismissed one is alerted again", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { ledger, clock } = setup(t);
  let overbill = true;
  mockLnurlPayServer(http, { address: ADDRESS, invoiceMsat: (asked) => (overbill ? asked * 1000 : asked), now: clock.now });
  t.mock.method(console, "error", () => undefined);

  ledger.enqueue({ source: "lsps1", orderId: "o-ack", earnedSats: 10_000 });
  await ledger.processDue();
  ledger.acknowledge("lsps1:o-ack");
  // Now the amount is right, but the invoice pays a node other than the pin.
  overbill = false;
  process.env.LM_SELL_FEE_PUBKEY = makeNodeKey().publicKey;
  clock.advance(2 * HOUR);
  await ledger.processDue();
  assert.equal(ledger.entries()[0].lastErrorCode, "payee_mismatch");
  assert.deepEqual(
    serviceFeeAlerts(ledger).map((a) => a.id),
    ["fee:lsps1:o-ack"],
  );
});

test("a fee outside the fee server's limits, or a fee server error, is never paid", async (t) => {
  feeEnv(t);
  const cases: [string, (http: ReturnType<typeof installFetchMock>, clock: { now: () => number }) => void, RegExp][] = [
    [
      "below minSendable",
      (http, clock) => void mockLnurlPayServer(http, { address: ADDRESS, minSendable: 500_000, now: clock.now }),
      /outside the fee server's limits/,
    ],
    [
      "above maxSendable",
      (http, clock) => void mockLnurlPayServer(http, { address: ADDRESS, maxSendable: 50_000, now: clock.now }),
      /outside the fee server's limits/,
    ],
    [
      "an error instead of the metadata",
      (http) => http.on("https://fees.example/.well-known/lnurlp/fees", () => ({ status: "ERROR", reason: "down for maintenance" })),
      /fee server error: down for maintenance/,
    ],
    [
      "an error instead of the invoice",
      (http) => {
        http.on("https://fees.example/.well-known/lnurlp/fees", () => ({
          tag: "payRequest",
          callback: "https://fees.example/cb",
          minSendable: 1_000,
          maxSendable: 100_000_000,
        }));
        http.on((req) => req.url.startsWith("https://fees.example/cb"), () => ({ status: "ERROR", reason: "amount not accepted" }));
      },
      /fee server error: amount not accepted/,
    ],
  ];
  for (const [what, serve, reason] of cases) {
    const http = installFetchMock(t);
    const { node, ledger, clock } = setup(t);
    serve(http, clock);
    ledger.enqueue({ source: "magma", orderId: `limits-${what}`, earnedSats: 10_000 }); // 100 sat = 100,000 msat
    await ledger.processDue();
    const [e] = ledger.entries();
    assert.equal(e.state, "pending", `${what}: owed, tried again later`);
    assert.match(e.lastError ?? "", reason, what);
    assert.equal(sends(node).length, 0, `${what}: nothing paid`);
    http.restore();
  }
});

test("refuses an amountless invoice", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, invoiceMsat: () => null, now: clock.now });
  ledger.enqueue({ source: "lsps1", orderId: "o-3", earnedSats: 50_000 });
  await ledger.processDue();
  assert.equal(ledger.entries()[0].lastErrorCode, "amount_mismatch");
  assert.equal(sends(node).length, 0);
});

test("refuses a callback that is not https on the address's own host", async (t) => {
  feeEnv(t);
  for (const callback of ["https://evil.example/cb", "http://fees.example/cb"]) {
    const http = installFetchMock(t);
    const { node, ledger, clock } = setup(t);
    const fees = mockLnurlPayServer(http, { address: ADDRESS, callback, now: clock.now });
    ledger.enqueue({ source: "magma", orderId: `ord-${callback}`, earnedSats: 10_000 });
    await ledger.processDue();
    assert.equal(ledger.entries()[0].lastErrorCode, "callback_refused", callback);
    assert.deepEqual(fees.requestedMsat, [], "the foreign callback is never even called");
    assert.equal(sends(node).length, 0);
    http.restore();
  }
});

test("LM_SELL_FEE_PUBKEY pins the payee", async (t) => {
  const http = installFetchMock(t);
  const payee = makeNodeKey();
  feeEnv(t, { LM_SELL_FEE_PUBKEY: makeNodeKey().publicKey });
  const { node, ledger, clock } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, payee, now: clock.now });
  ledger.enqueue({ source: "magma", orderId: "ord-pin", earnedSats: 10_000 });
  await ledger.processDue();
  assert.equal(ledger.entries()[0].lastErrorCode, "payee_mismatch");
  assert.equal(sends(node).length, 0);

  process.env.LM_SELL_FEE_PUBKEY = payee.publicKey;
  clock.advance(HOUR);
  await ledger.processDue();
  assert.equal(ledger.entries()[0].state, "paid");
});

test("an invoice to this node itself is skipped, not paid", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const node = new FakeLnd();
  const { ledger, clock } = setup(t, node);
  mockLnurlPayServer(http, { address: ADDRESS, payee: node.key, now: clock.now });
  ledger.enqueue({ source: "magma", orderId: "ord-self", earnedSats: 10_000 });
  await ledger.processDue();
  assert.equal(ledger.entries()[0].state, "skipped");
  assert.equal(sends(node).length, 0);
});

test("a stuck payment never blocks the caller and is never paid twice", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t, undefined, undefined, STUCK_PAY_TIMEOUT_MS);
  mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });
  node.payOutcome = "hang";

  ledger.enqueue({ source: "magma", orderId: "ord-hang", earnedSats: 20_000 });
  const started = Date.now();
  await ledger.processDue();
  assert.ok(Date.now() - started < 5_000, "gave up WAITING after the pay timeout");
  let [e] = ledger.entries();
  assert.equal(e.state, "inflight");
  assert.ok(e.paymentHash);

  clock.advance(10 * 60_000);
  await ledger.processDue(); // LND still reports it in flight
  assert.equal(ledger.entries()[0].state, "inflight");
  assert.equal(sends(node).length, 1, "no second payment while the first may land");

  node.resolvePayment(e.paymentHash as string, "succeed");
  clock.advance(10 * 60_000);
  await ledger.processDue();
  [e] = ledger.entries();
  assert.equal(e.state, "paid");
  assert.equal(sends(node).length, 1);
});

test("after a restart mid-payment, LND is asked before anything is paid again", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock, restart } = setup(t, undefined, undefined, STUCK_PAY_TIMEOUT_MS);
  mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });
  node.payOutcome = "hang";
  ledger.enqueue({ source: "lsps1", orderId: "o-restart", earnedSats: 30_000 });
  await ledger.processDue();
  const firstHash = ledger.entries()[0].paymentHash as string;
  assert.ok(firstHash);

  const after = restart(); // a fresh process reading service-fees.json
  clock.advance(10 * 60_000);
  await after.processDue();
  assert.equal(sends(node).length, 1, "still in flight: nothing new is sent");

  node.resolvePayment(firstHash, "fail");
  node.payOutcome = "succeed";
  clock.advance(10 * 60_000);
  await after.processDue();
  const [e] = after.entries();
  assert.equal(e.state, "paid");
  assert.equal(sends(node).length, 2, "one failed attempt, then exactly one more");
  assert.notEqual(e.paymentHash, firstHash);
});

test("one fee per sale: enqueue is idempotent and survives a restart", async (t) => {
  feeEnv(t);
  const { ledger, restart } = setup(t, new FakeLnd());
  // This test only checks the bookkeeping; the background pass that enqueue()
  // kicks off just finds the fee server down.
  const http = installFetchMock(t);
  http.on(/.*/, () => new Response("down", { status: 503 }));
  const a = ledger.enqueue({ source: "magma", orderId: "dup", earnedSats: 10_000 });
  const b = ledger.enqueue({ source: "magma", orderId: "dup", earnedSats: 99_999 });
  assert.equal(a?.key, b?.key);
  assert.equal(ledger.entries().length, 1);
  assert.equal(ledger.entries()[0].feeSats, 100);
  await ledger.processDue(); // let the kicked-off pass finish before the dir goes
  const again = restart();
  assert.equal(again.enqueue({ source: "magma", orderId: "dup", earnedSats: 10_000 })?.feeSats, 100);
  assert.equal(again.entries().length, 1);
  await again.processDue();
});

test("nothing is owed when the fee is switched off", (t) => {
  withEnv(t, { LM_SELL_FEE_BPS: "0", LM_SELL_FEE_ADDRESS: ADDRESS });
  const { ledger } = setup(t, new FakeLnd());
  assert.equal(ledger.enqueue({ source: "magma", orderId: "x", earnedSats: 10_000 }), null);
  assert.equal(ledger.entries().length, 0);
});

test("a fee above the per-sale ceiling is never paid automatically", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });
  ledger.enqueue({ source: "magma", orderId: "huge", earnedSats: 10_000_000 }); // 1% = 100,000 sat
  await ledger.processDue();
  assert.equal(ledger.entries()[0].state, "failed");
  assert.equal(ledger.problems().length, 1);
  assert.equal(sends(node).length, 0);
});

test("a stalled LNURL server times out instead of hanging the fee loop", async (t) => {
  feeEnv(t);
  const saved = HTTP_TIMEOUTS.lnurlMs;
  HTTP_TIMEOUTS.lnurlMs = 100;
  t.after(() => {
    HTTP_TIMEOUTS.lnurlMs = saved;
  });
  const http = installFetchMock(t);
  http.on(/fees\.example/, hang);
  const { node, ledger } = setup(t);
  ledger.enqueue({ source: "magma", orderId: "slow", earnedSats: 10_000 });
  await ledger.processDue();
  const [e] = ledger.entries();
  assert.equal(e.state, "pending");
  assert.match(e.lastError ?? "", /timed out/);
  assert.equal(sends(node).length, 0);
});

test("a payment that keeps failing is given up after the last attempt, with exactly one alert", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });
  node.payOutcome = "fail"; // e.g. no route to the fee node, every time

  ledger.enqueue({ source: "magma", orderId: "no-route", earnedSats: 20_000 });
  await ledger.processDue();
  let [e] = ledger.entries();
  assert.equal(e.state, "pending", "a failed payment is owed again, not 'in flight'");
  assert.ok(e.paymentHash, "its hash is kept until LND confirms how it ended");
  assert.equal(ledger.problems().length, 0, "no alert while it is still being retried");

  const took = await untilSettled(ledger, clock);
  [e] = ledger.entries();
  assert.equal(e.state, "failed", "given up once its days are over");
  assert.ok(took >= FEE_RETRY_DAYS * 24 * HOUR, "not before");
  assert.ok(took < (FEE_RETRY_DAYS + 2) * 24 * HOUR, "and within about a day of it");
  assert.equal(e.paymentHash, undefined, "its last payment confirmed failed first");
  assert.match(e.lastError ?? "", GAVE_UP);
  const attempts = e.attempts;
  assert.ok(attempts > 10, `tried ${attempts} times — not the old ten`);

  for (let i = 0; i < 10; i++) {
    clock.advance(25 * HOUR);
    await ledger.processDue();
  }
  assert.equal(sends(node).length, attempts, "one payment per attempt, then none");
  assert.deepEqual(
    ledger.problems().map((p) => p.key),
    ["magma:no-route"],
  );
  const alerts = serviceFeeAlerts(ledger);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].message, /no-route.*not paid: .*gave up/);
});

test("a fee that can't be paid for a long weekend is still paid after it — retried for 30 days, not given up after ten attempts (about three days)", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });
  node.payOutcome = "fail"; // no route to the fee node over the weekend
  ledger.enqueue({ source: "magma", orderId: "weekend", earnedSats: 20_000 });
  await ledger.processDue();
  for (let i = 0; i < 12; i++) {
    clock.advance(9 * HOUR);
    await ledger.processDue();
  }
  let [e] = ledger.entries();
  assert.equal(e.state, "pending", `still owed after ${e.attempts} attempts in 4½ days`);
  assert.equal(ledger.problems().length, 0, "and no alert: it is still being tried");
  node.payOutcome = "succeed"; // the route is back
  await untilSettled(ledger, clock, 3);
  [e] = ledger.entries();
  assert.equal(e.state, "paid");
  assert.equal(e.paidSats, 200);
});

test("a last attempt we stopped waiting for, then confirmed failed, gives up with the real reason", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t); // nothing may be fetched: no new attempt is left
  const node = new FakeLnd();
  const dir = makeTempDir(t);
  const hash = "ab".repeat(32);
  node.payments.set(hash, {
    id: hash,
    destination: makeNodeKey().publicKey,
    tokens: 200,
    feeMsat: "0",
    status: "FAILED",
    preimage: "00".repeat(32),
    params: {},
  });
  writeFileSync(
    join(dir, "service-fees.json"),
    JSON.stringify([
      {
        key: "magma:last",
        source: "magma",
        orderId: "last",
        earnedSats: 20_000,
        bps: 100,
        feeSats: 200,
        createdAt: new Date(Date.now() - (FEE_RETRY_DAYS + 1) * 86_400_000).toISOString(),
        state: "inflight",
        attempts: 34,
        nextAttemptAt: new Date(Date.now() - 60_000).toISOString(),
        paymentHash: hash,
        lastError: "payment still in flight after 60s — will check its outcome",
        lastErrorCode: "inflight",
      },
    ]),
  );
  const { ledger } = setup(t, node, dir);
  await ledger.processDue();
  const [e] = ledger.entries();
  assert.equal(e.state, "failed");
  assert.equal(e.lastError, `the payment failed (gave up after 34 attempts in ${FEE_RETRY_DAYS} days)`);
  assert.equal(sends(node).length, 0);
  assert.equal(http.requests.length, 0);
});

test("a shutdown while the invoice is being fetched sends nothing; the fee waits on disk", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock, restart } = setup(t);
  mockLnurlPayServer(http, {
    address: ADDRESS,
    now: clock.now,
    // SIGTERM arrives while the fee server is still answering.
    invoiceMsat: (asked) => {
      ledger.stop();
      return asked;
    },
  });
  ledger.enqueue({ source: "lsps1", orderId: "o-sigterm", earnedSats: 10_000 });
  await ledger.processDue();
  const [e] = ledger.entries();
  assert.equal(sends(node).length, 0, "no payment after the shutdown began");
  assert.equal(e.state, "pending");
  assert.equal(e.paymentHash, undefined, "nothing written ahead either");
  assert.equal(e.attempts, 0, "the interrupted round doesn't count against the fee server");

  const next = restart(); // next start of the app
  await next.processDue();
  assert.equal(next.entries()[0].state, "paid");
  assert.equal(sends(node).length, 1);
});

test("when LND can't say how an earlier payment ended, nothing is paid and it asks again later", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock } = setup(t, undefined, undefined, STUCK_PAY_TIMEOUT_MS);
  mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });
  node.payOutcome = "hang";
  ledger.enqueue({ source: "magma", orderId: "lnd-busy", earnedSats: 20_000 });
  await ledger.processDue(); // sent, then we stop waiting for it

  node.override("router.trackPaymentV2", () => {
    const s = Object.assign(new EventEmitter(), { cancel: () => undefined });
    setImmediate(() => s.emit("error", { details: "rpc error: unavailable" }));
    return s;
  });
  clock.advance(10 * 60_000);
  await ledger.processDue();
  const [e] = ledger.entries();
  assert.equal(sends(node).length, 1, "never a second payment while the first one's fate is unknown");
  assert.equal(e.state, "inflight");
  assert.ok(Date.parse(e.nextAttemptAt) > clock.now(), "rescheduled, instead of retried on every tick");
});

test("when the payment can't be recorded before sending, nothing is sent; the fee stays owed", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock, dir } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });
  t.mock.method(console, "error", () => undefined); // the store reports each failing save
  t.mock.method(console, "warn", () => undefined);

  ledger.enqueue({ source: "magma", orderId: "disk-full", earnedSats: 20_000 });
  // The disk fills up right after the sale was booked: a directory where the
  // ledger file belongs makes every save fail from here on.
  const file = join(dir, "service-fees.json");
  rmSync(file);
  mkdirSync(file);
  await ledger.processDue();
  let [e] = ledger.entries();
  // Paying without the hash on disk: after a restart we couldn't tell whether
  // it went out — and might pay the same fee again.
  assert.equal(sends(node).length, 0, "no payment without its write-ahead record");
  assert.equal(e.state, "pending");
  assert.equal(e.paymentHash, undefined);
  assert.match(e.lastError ?? "", /^could not record the payment before sending it/);

  rmSync(file, { recursive: true }); // space again
  clock.advance(2 * 60_000);
  await ledger.processDue();
  [e] = ledger.entries();
  assert.equal(e.state, "paid");
  assert.equal(sends(node).length, 1, "paid exactly once");
});

test("a stopped ledger (shutdown) starts no payment; the fee waits on disk", async (t) => {
  feeEnv(t);
  const http = installFetchMock(t);
  const { node, ledger, clock, restart } = setup(t);
  mockLnurlPayServer(http, { address: ADDRESS, now: clock.now });
  ledger.stop();
  ledger.enqueue({ source: "magma", orderId: "late-sale", earnedSats: 10_000 });
  await ledger.processDue();
  assert.equal(sends(node).length, 0);
  assert.equal(ledger.entries()[0].state, "pending");

  const next = restart(); // next start of the app
  await next.processDue();
  assert.equal(next.entries()[0].state, "paid");
});

