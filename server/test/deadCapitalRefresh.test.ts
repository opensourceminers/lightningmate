/**
 * The close list behind the dead-capital alert is computed in the background
 * (the review of P4, P3): at most once per refresh time, not again on every
 * poll after a failure, under a deadline, and not shown once it is old.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEAD_CAPITAL } from "../src/services/alerts.js";
import { startApi } from "./helpers/apiHarness.js";
import { feeNode, type FeeChannel } from "./helpers/feeNode.js";

const HEIGHT = 860_000;
const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const channels: FeeChannel[] = [{ id: `${HEIGHT - 5_760}x2x0`, partnerPublicKey: PEER(2), capacity: 2_000_000, localBalance: 2_000_000, transactionId: TX(2), transactionVout: 0, feeRatePpm: 100, baseFeeMsat: 0 }];
const deadOf = (body: unknown) => (body as { message: string }[]).filter((a) => /routed nothing in 60 days/.test(a.message));
/** DEAD_CAPITAL with some times shortened for one test. */
function times(t: { after: (fn: () => void) => void }, o: Partial<typeof DEAD_CAPITAL>) {
  const was = { ...DEAD_CAPITAL };
  Object.assign(DEAD_CAPITAL, o);
  t.after(() => Object.assign(DEAD_CAPITAL, was));
}
async function polls(api: Awaited<ReturnType<typeof startApi>>, n: number) {
  for (let i = 0; i < n; i++) {
    await api.request("GET", "/alerts");
    await sleep(40);
  }
}

test("the close list is computed once for many polls within its refresh time", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = feeNode({ blockHeight: HEIGHT, channels });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const api = await startApi(t, { node });
  // (The graph is cached on its own; the fee report is read once per close list.)
  const before = node.callsTo("default.feeReport").length;
  await polls(api, 6);
  assert.equal(deadOf((await api.request("GET", "/alerts")).body).length, 1);
  const lists = node.callsTo("default.feeReport").length - before;
  assert.ok(lists >= 1 && lists <= 2, `${lists} fee-report reads for 7 polls`);
});

test("a close list that failed is not computed again on the next polls, only after the retry time (before: on every 30-second poll)", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = feeNode({ blockHeight: HEIGHT, channels });
  node.override("default.describeGraph", (_a, cb) => cb({ details: "rpc error: unavailable" }));
  const api = await startApi(t, { node });
  await polls(api, 6);
  assert.ok(node.callsTo("default.describeGraph").length <= 2, `${node.callsTo("default.describeGraph").length} reads for 6 polls`);
  // After the retry time it is asked again, and with LND answering the alert is there.
  times(t, { retryMs: 0 });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  await polls(api, 3);
  assert.equal(deadOf((await api.request("GET", "/alerts")).body).length, 1);
});

test("a close-list read LND never answers is given up at its deadline: the refresh goes on once LND answers again (before: frozen until a restart)", async (t) => {
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "warn", () => undefined);
  times(t, { deadlineMs: 100, retryMs: 0 });
  const node = feeNode({ blockHeight: HEIGHT, channels });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const report = node.lnd.default.feeReport;
  node.override("default.feeReport", () => undefined);
  const api = await startApi(t, { node });
  await polls(api, 3);
  await sleep(150);
  node.override("default.feeReport", report);
  await polls(api, 5);
  assert.equal(deadOf((await api.request("GET", "/alerts")).body).length, 1, "the alert, once the list can be read");
});

test("one computation of the close list at a time: polls while it runs start no second one", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = feeNode({ blockHeight: HEIGHT, channels });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const report = node.lnd.default.feeReport;
  // The fee report of the close list answers only after the polls.
  let held = true;
  node.override("default.feeReport", (a, cb) => void (function wait() {
    if (held) setTimeout(wait, 20);
    else report(a, cb);
  })());
  const api = await startApi(t, { node });
  const before = node.callsTo("default.feeReport").length;
  await polls(api, 4);
  assert.equal(node.callsTo("default.feeReport").length - before, 1, "one close list under way, not one per poll");
  held = false;
  await polls(api, 3);
  assert.equal(deadOf((await api.request("GET", "/alerts")).body).length, 1);
});

test("a close list older than its stale time is not shown while a new one fails", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const node = feeNode({ blockHeight: HEIGHT, channels });
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const api = await startApi(t, { node });
  await polls(api, 3);
  assert.equal(deadOf((await api.request("GET", "/alerts")).body).length, 1);
  times(t, { refreshMs: 0, staleMs: 0, retryMs: 60_000 });
  node.override("default.describeGraph", (_a, cb) => cb({ details: "rpc error: unavailable" }));
  await polls(api, 2);
  assert.equal(deadOf((await api.request("GET", "/alerts")).body).length, 0);
});
