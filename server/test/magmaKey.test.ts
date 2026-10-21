/**
 * Only a definitive answer from Amboss may mark the API key as revoked.
 *
 * Before: validateKey returned false for every failure alike — a timeout, a
 * reset connection, an Amboss outage — and the UI then said "Your Amboss key
 * is expired or revoked" for five minutes, with one button, "Reconnect", that
 * deleted the working key. Connecting a key while Amboss was unreachable said
 * "Amboss rejected this API key".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AmbossStore } from "../src/services/ambossStore.js";
import { KEY_CHECK_QUERY, validateKey } from "../src/services/magmaApi.js";
import {
  AmbossError,
  MAGMA_URL,
  ambossGql,
  isAmbossOutage,
  isAuthError,
  isNotFoundAnswer,
  isQueryRejected,
  isRateLimited,
  isTransientAmbossError,
} from "../src/services/amboss.js";
import { HTTP_TIMEOUTS } from "../src/services/http.js";
import { hang, installFetchMock } from "./helpers/fetchMock.js";
import {
  FakeMagma,
  MAGMA_API,
  forbidden,
  gqlError,
  internalError,
  orderNotFound,
  resolverFailed,
  schemaChanged,
  throttled,
} from "./helpers/magma.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";

function shrink(t: AfterHook, key: keyof typeof HTTP_TIMEOUTS, ms: number): void {
  const saved = HTTP_TIMEOUTS[key];
  HTTP_TIMEOUTS[key] = ms;
  t.after(() => {
    HTTP_TIMEOUTS[key] = saved;
  });
}

/** Amboss's key check, answering however the test says. */
function keyCheck(t: AfterHook, answer: { mode: "ok" | "forbidden" | "http401" | "http403" | "network" | "timeout" | "http502" }) {
  const http = installFetchMock(t);
  http.onGraphql(MAGMA_API, "KeyCheck", (_v, req) => {
    switch (answer.mode) {
      case "ok":
        return { data: { user: { id: "user-1" } } };
      case "forbidden":
        return forbidden("KeyCheck");
      case "http401":
        return new Response("unauthorized", { status: 401 });
      case "http403":
        return new Response("forbidden", { status: 403 });
      case "http502":
        return new Response("bad gateway", { status: 502 });
      case "timeout":
        return hang(req);
      case "network":
        throw new TypeError("fetch failed: ECONNRESET");
    }
  });
  return http;
}

test("validateKey has three answers: yes, a definitive no (401/403/FORBIDDEN), and 'could not ask' (null)", async (t) => {
  shrink(t, "ambossQueryMs", 100);
  const answer = { mode: "ok" as Parameters<typeof keyCheck>[1]["mode"] };
  keyCheck(t, answer);
  assert.equal(await validateKey("k"), true);
  for (const mode of ["forbidden", "http401", "http403"] as const) {
    answer.mode = mode;
    assert.equal(await validateKey("k"), false, mode);
  }
  for (const mode of ["network", "timeout", "http502"] as const) {
    answer.mode = mode;
    assert.equal(await validateKey("k"), null, `${mode} is not a verdict on the key`);
  }
});

test("a network error does NOT mark the key revoked; a 401/403 answer does", async (t) => {
  const answer = { mode: "ok" as Parameters<typeof keyCheck>[1]["mode"] };
  keyCheck(t, answer);
  const store = new AmbossStore(makeTempDir(t));
  store.setKey("WORKING-KEY");

  answer.mode = "network";
  assert.equal(await store.checkValidity(true), true, "an outage keeps the last verdict");
  assert.equal(store.status().keyCheck, "unreachable");
  assert.equal(store.status().keyValid, true);
  assert.match(store.status().lastError ?? "", /unreachable|ECONNRESET/);
  assert.equal(store.hasKey(), true);

  answer.mode = "http403";
  assert.equal(await store.checkValidity(true), false);
  assert.equal(store.status().keyCheck, "rejected");

  answer.mode = "ok";
  assert.equal(await store.checkValidity(true), true, "a later yes counts again");
  answer.mode = "forbidden";
  assert.equal(await store.checkValidity(true), false, "Amboss's GraphQL FORBIDDEN is a definitive no too");
});

test("the order lane: Amboss unreachable leaves the key alone; Amboss refusing it marks it revoked", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const { autopilot, magma, amboss } = sellerSetup(t);
  magma.addSale({ buyerPubkey: BUYER });
  magma.readBehaviour = "throw"; // Amboss down
  await autopilot.pollSellOrders();
  assert.equal(amboss.status().keyValid, true);
  assert.equal(autopilot.getState().magmaLane.ok, false, "the lane says it could not read Amboss");
  magma.readBehaviour = "ok";
  magma.keyValid = false; // the key was revoked
  await autopilot.pollSellOrders();
  assert.equal(amboss.status().keyValid, false);
  assert.equal(amboss.status().keyCheck, "rejected");
});

test("connecting a key: rejected → 400, Amboss unreachable → 503 and nothing saved, valid → saved", async (t) => {
  const answer = { mode: "forbidden" as Parameters<typeof keyCheck>[1]["mode"] };
  keyCheck(t, answer);
  const api = await startApi(t);
  const rejected = await api.request("POST", "/amboss/key", { apiKey: "BAD-KEY" });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, "invalid_key");

  answer.mode = "network";
  const down = await api.request("POST", "/amboss/key", { apiKey: "MAYBE-KEY" });
  assert.equal(down.status, 503, "not 'Amboss rejected this API key'");
  assert.equal(down.body.error, "amboss_unreachable");
  assert.equal(api.amboss.hasKey(), false, "an unverified key is not kept");

  answer.mode = "ok";
  const ok = await api.request("POST", "/amboss/key", { apiKey: "GOOD-KEY" });
  assert.equal(ok.status, 200);
  assert.equal(api.amboss.getKey(), "GOOD-KEY");

  // Status during an outage: still valid, check "unreachable"; Re-check asks again.
  answer.mode = "network";
  const status = await api.request("POST", "/amboss/key/check");
  assert.equal(status.status, 200);
  assert.equal(status.body.keyValid, true);
  assert.equal(status.body.keyCheck, "unreachable");
  answer.mode = "ok";
  const again = await api.request("POST", "/amboss/key/check");
  assert.equal(again.body.keyCheck, "valid");
});

test("a seller route that Amboss refuses for the key marks it revoked — an outage does not", async (t) => {
  const http = installFetchMock(t);
  const magma = new FakeMagma(http, t);
  const api = await startApi(t);
  magma.sellerPubkey = api.node.publicKey; // this node's sales and offers
  api.amboss.setKey("test-key");
  magma.readBehaviour = "throw";
  const down = await api.request("GET", "/amboss/my-orders");
  assert.equal(down.status, 502);
  assert.equal(api.amboss.status().keyValid, true);
  magma.readBehaviour = "ok";
  magma.keyValid = false;
  const refused = await api.request("GET", "/amboss/my-orders");
  assert.equal(refused.status, 502);
  assert.equal(api.amboss.status().keyValid, false);
});

// ── what an answer says: an outage, or an answer about the request ───────────

test("a 4xx carrying a GraphQL error is an answer about the request, with Amboss's own words; only outages are transient", async (t) => {
  const http = installFetchMock(t);
  let answer: () => Response = schemaChanged;
  http.onGraphql(MAGMA_API, "KeyCheck", () => answer());
  const ask = () =>
    ambossGql(MAGMA_URL, KEY_CHECK_QUERY, "k").then(
      () => null,
      (e: unknown) => e as AmbossError,
    );

  // A query that no longer fits Amboss's schema. Before: AmbossError("http",
  // "Amboss HTTP 400"), counted as transient — the order lane went LND-only
  // every pass and said "Amboss unreachable", dropping what Amboss had said.
  let err = await ask();
  assert.equal(err?.kind, "graphql");
  assert.equal(err?.code, "GRAPHQL_VALIDATION_FAILED");
  assert.match(err?.message ?? "", /Cannot query field "fees" on type "MarketOrder"/);
  assert.equal(isTransientAmbossError(err), false, "not an outage: it fails the same way every time");
  assert.equal(isQueryRejected(err), true);
  assert.equal(isAuthError(err), false);
  assert.equal(await validateKey("k"), null, "and no verdict on the key either");

  for (const status of [500, 502, 503, 408, 429]) {
    answer = () => new Response("upstream trouble", { status });
    assert.equal(isTransientAmbossError(await ask()), true, `HTTP ${status} is an outage`);
  }
  // A server error stays an outage even with a GraphQL body — its words kept.
  answer = () => Response.json({ errors: [{ message: "database down", extensions: { code: "INTERNAL_SERVER_ERROR" } }] }, { status: 500 });
  err = await ask();
  assert.equal(isTransientAmbossError(err), true);
  assert.match(err?.message ?? "", /HTTP 500: database down/);
  // Any other 4xx, without a GraphQL error: about the request, not an outage.
  answer = () => new Response("bad request", { status: 400 });
  err = await ask();
  assert.equal(err?.kind, "http");
  assert.equal(isTransientAmbossError(err), false);
  assert.equal(isQueryRejected(err), false);
  // A refused key stays a refused key, whatever the status it comes with.
  answer = () => Response.json(forbidden("KeyCheck"), { status: 400 });
  assert.equal(isAuthError(await ask()), true);
});

test("inside an HTTP 200 answer: an outage reported by Amboss's server (5xx, 408, 429) is transient — and only a definite 'not found' says an order doesn't exist", async (t) => {
  const http = installFetchMock(t);
  let answer: () => unknown = resolverFailed;
  http.onGraphql(MAGMA_API, "KeyCheck", () => answer() as Record<string, unknown>);
  const ask = () =>
    ambossGql(MAGMA_URL, KEY_CHECK_QUERY, "k").then(
      () => null,
      (e: unknown) => e as AmbossError,
    );

  // NestJS's rate limiter, and failing resolvers that report their status
  // (originalError.statusCode, or extensions.status in newer versions).
  // Before: kind "graphql" was never transient — the lane went on asking
  // Amboss about every order while it was limiting requests.
  answer = throttled;
  let err = await ask();
  assert.equal(err?.kind, "graphql");
  assert.equal(err?.status, 429);
  assert.equal(isTransientAmbossError(err), true, "a rate limit is an outage");
  assert.equal(isNotFoundAnswer(err), false);
  for (const status of [500, 502, 503, 504, 408]) {
    answer = () => gqlError("upstream trouble", { code: "INTERNAL_SERVER_ERROR", originalError: { statusCode: status } });
    assert.equal(isTransientAmbossError(await ask()), true, `${status} inside a GraphQL answer`);
  }
  answer = () => gqlError("Bad Gateway", { code: "INTERNAL_SERVER_ERROR", status: 503 });
  assert.equal(isTransientAmbossError(await ask()), true, "extensions.status is read too");

  // A resolver that threw, without a status: an answer, but not about the
  // order — neither an outage nor a "not found".
  answer = resolverFailed;
  err = await ask();
  assert.equal(err?.kind, "graphql");
  assert.equal(isTransientAmbossError(err), false);
  assert.equal(isNotFoundAnswer(err), false, "'Unexpected error.' says nothing about whether the order exists");
  assert.equal(isQueryRejected(err), false);

  // A definite "not found": the code, the 404 Amboss reports with it, or the words.
  answer = orderNotFound;
  assert.equal(isNotFoundAnswer(await ask()), true);
  answer = () => gqlError("Order 1234 does not exist", { code: "INTERNAL_SERVER_ERROR", originalError: { statusCode: 404, error: "Not Found" } });
  assert.equal(isNotFoundAnswer(await ask()), true);
  answer = () => gqlError("Not Found", { code: "BAD_REQUEST" });
  assert.equal(isNotFoundAnswer(await ask()), true);
  // A query Amboss rejects is never a "not found", whatever its words.
  answer = () => gqlError('Cannot query field "x": type not found', { code: "GRAPHQL_VALIDATION_FAILED" });
  assert.equal(isNotFoundAnswer(await ask()), false);
  // Nor is an outage.
  answer = () => gqlError("Upstream not found", { code: "INTERNAL_SERVER_ERROR", originalError: { statusCode: 503 } });
  assert.equal(isNotFoundAnswer(await ask()), false);
});

test("what cuts an order-lane pass short is Amboss down or limiting requests — not a 500 that one resolver reports inside its answer", async (t) => {
  const http = installFetchMock(t);
  let answer: () => Response | Record<string, unknown> = internalError;
  http.onGraphql(MAGMA_API, "KeyCheck", () => answer());
  const ask = () =>
    ambossGql(MAGMA_URL, KEY_CHECK_QUERY, "k").then(
      () => null,
      (e: unknown) => e as AmbossError,
    );

  // A resolver that threw for this one request — NestJS reports its 500
  // inside an HTTP 200 answer. Transient (a retry may clear it; never a "not
  // found"), but that request's error alone: Amboss answered, at once.
  // Before, it counted as Amboss being down, and one order whose read kept
  // failing that way left every order after it to LND alone, every pass.
  let err = await ask();
  assert.equal(err?.kind, "graphql");
  assert.equal(err?.status, 500);
  assert.equal(isTransientAmbossError(err), true);
  assert.equal(isAmbossOutage(err), false);
  answer = () => gqlError("Gateway Timeout", { code: "INTERNAL_SERVER_ERROR", originalError: { statusCode: 504 } });
  assert.equal(isAmbossOutage(await ask()), false);
  answer = () => gqlError("Request Timeout", { code: "INTERNAL_SERVER_ERROR", status: 408 });
  assert.equal(isAmbossOutage(await ask()), false);

  // A rate limit holds for every call, whichever level reports it: the lane
  // stops asking at once (isRateLimited). Any other outage-type failure of one
  // order's read may still be that order's alone — a second in the same pass
  // is what makes the lane stop asking (magmaDesk.ts, unreadable).
  answer = throttled;
  err = await ask();
  assert.equal(isAmbossOutage(err), true, "429 inside a GraphQL answer");
  assert.equal(isRateLimited(err), true);
  for (const status of [500, 502, 503, 408, 429]) {
    answer = () => new Response("upstream trouble", { status });
    err = await ask();
    assert.equal(isAmbossOutage(err), true, `HTTP ${status}`);
    assert.equal(isRateLimited(err), status === 429, `HTTP ${status}: a rate limit?`);
  }
  answer = internalError;
  assert.equal(isRateLimited(await ask()), false, "a resolver's 500 is no rate limit");
  assert.equal(isRateLimited(new AmbossError("timeout", "Amboss request timed out")), false);
  assert.equal(isAmbossOutage(new AmbossError("unreachable", "Amboss unreachable: fetch failed")), true);
  assert.equal(isAmbossOutage(new AmbossError("timeout", "Amboss request timed out")), true);
  assert.equal(isAmbossOutage(new AmbossError("http", "Amboss sent an unreadable answer: Unexpected token")), true);

  // Answers about the request never are.
  for (const a of [resolverFailed, orderNotFound, schemaChanged, () => forbidden("KeyCheck")]) {
    answer = a;
    assert.equal(isAmbossOutage(await ask()), false);
  }
  assert.equal(isAmbossOutage(new Error("not from Amboss")), false);
});

test("the order lane: Amboss rejecting its query (a schema change) is reported as that — not as 'Amboss unreachable'", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  const { autopilot, node, magma, amboss } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  // Waiting for Amboss to report its fee: "seen", nothing of ours tied to it.
  const waiting = magma.addSale({ buyerPubkey: BUYER, feeSeller: "0", timeout: new Date(Date.now() + 3_600_000).toISOString() });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  assert.equal(autopilot.magma.journal.get(waiting.id)?.phase, "seen");

  magma.readBehaviour = "invalid";
  const reads = magma.count("Sale");
  await autopilot.pollSellOrders();
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false);
  assert.match(lane.error ?? "", /Amboss rejected LightningMate's request \(Cannot query field/);
  assert.match(lane.error ?? "", /until LightningMate is updated/);
  assert.doesNotMatch(lane.error ?? "", /unreachable/, "Amboss answered — it is not down");
  // Before: the Orders tab appended "— retrying" to this, though no retry
  // can help until LightningMate is updated.
  assert.equal(lane.retrying, false, "nothing the next pass can clear");
  assert.ok(magma.count("Sale") > reads, "not an outage: the pass was not cut down to LND-only work");
  assert.equal(autopilot.magma.journal.get(waiting.id)?.phase, "seen", "a rejected query says nothing about the order: not dropped as unknown");
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "the held payment is untouched (it has time)");
  assert.equal(amboss.status().keyValid, true, "and nothing about the key");

  magma.readBehaviour = "ok"; // LightningMate updated (or Amboss fixed it)
  await autopilot.pollSellOrders();
  assert.equal(autopilot.getState().magmaLane.ok, true);
  assert.equal(node.callsTo("default.openChannel").length, 1, "the paid order goes on");
});

test("the order lane: Amboss rejecting the query for the orders shows in the lane's status, though the listing still worked", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
  const { autopilot, magma } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "WAITING_FOR_BUYER_PAYMENT");
  // A schema change that hits get_order's fields only.
  const desk = autopilot.magma as unknown as { ambossSale: (key: string, id: string) => Promise<unknown> };
  desk.ambossSale = async () => {
    throw new AmbossError("graphql", 'Cannot query field "promises" on type "MarketOrder".', 400, "GRAPHQL_VALIDATION_FAILED");
  };
  await autopilot.pollSellOrders();
  const lane = autopilot.getState().magmaLane;
  assert.equal(lane.ok, false, "orders can't be acted on: not 'fine'");
  assert.match(lane.error ?? "", /Amboss rejected LightningMate's request \(Cannot query field "promises"/);
  assert.equal(lane.retrying, false);
});
