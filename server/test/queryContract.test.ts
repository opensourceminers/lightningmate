/**
 * The query strings, as the routes read them (review of P8, run 2).
 *
 * A GET's query was the last part of a request still paired by hand: the web
 * wrote it out (`/pnl?days=${days}`) and each route read `req.query` itself,
 * so a parameter renamed on one side passed every check and the page got the
 * route's default without a word. Now every query is a contract type
 * (server/src/apiTypes.ts): the web builds it from the type (each set field
 * as text, a flag as "true" or "false" — web/test/apiClient.test.tsx), the
 * route reads it through `queryOf<that type>(req)`, and the contract check
 * pairs the two (web/test/apiContract.test.tsx).
 *
 * Here: the routes whose parameters no other test reaches act on each one,
 * by the contract's name and in the web's encoding.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { startApi } from "./helpers/apiHarness.js";

async function queryApi(t: TestContext) {
  const http = installFetchMock(t);
  // LN+ lists nothing: what the routes ask it is what is checked.
  http.on(/^https:\/\/lightningnetwork\.plus\/api\/2\//, () => []);
  const node = new FakeLnd({ chainBalance: 5_000_000 });
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  node.override("default.listPayments", (_a, cb) => cb(null, { payments: [], first_index_offset: "0", last_index_offset: "0" }));
  node.override("default.feeReport", (_a, cb) => cb(null, { channel_fees: [], day_fee_sum: "0", week_fee_sum: "0", month_fee_sum: "0" }));
  node.override("default.describeGraph", (_a, cb) => cb(null, { edges: [], nodes: [] }));
  const api = await startApi(t, { node });
  return { api, http };
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

test("a window and the viewer's time zone: /flows, /forwards/report and /htlc/demand read `days` and `tz` as the web sends them", async (t) => {
  const { api } = await queryApi(t);
  const flows = await api.request("GET", "/flows?days=3");
  assert.equal(flows.status, 200, JSON.stringify(flows.body));
  assert.equal(flows.body.windowDays, 3);
  const report = await api.request("GET", "/forwards/report?days=7&tz=60");
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.deepEqual([report.body.windowDays, report.body.tzOffsetMin], [7, 60]);
  const demand = await api.request("GET", "/htlc/demand?days=3");
  assert.equal(demand.status, 200, JSON.stringify(demand.body));
  assert.equal(demand.body.days, 3);
});

test("the fee preview and the peer suggestions take the policy settings the web sends — the clearnet flag as 'true' or 'false'", async (t) => {
  const { api } = await queryApi(t);
  const preview = await api.request("GET", "/fees/preview?minPpm=11&maxPpm=900&baseFeeMsat=2000&step=5&minChangePpm=7");
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(pick(preview.body.policy, ["minPpm", "maxPpm", "baseFeeMsat", "step", "minChangePpm"]), {
    minPpm: 11,
    maxPpm: 900,
    baseFeeMsat: 2000,
    step: 5,
    minChangePpm: 7,
  });
  const keys = ["count", "minChannels", "maxStaleDays", "minSizeSats", "maxSizeSats", "requireClearnet"];
  const asked = await api.request("GET", "/suggestions?count=3&minChannels=4&maxStaleDays=9&minSizeSats=2000000&maxSizeSats=9000000&requireClearnet=true");
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.deepEqual(pick(asked.body.policy, keys), {
    count: 3,
    minChannels: 4,
    maxStaleDays: 9,
    minSizeSats: 2_000_000,
    maxSizeSats: 9_000_000,
    requireClearnet: true,
  });
  assert.equal((await api.request("GET", "/suggestions?requireClearnet=false")).body.policy.requireClearnet, false);
});

test("LN+: the pool's minimum credits and the swaps' status reach LN+ as asked — pending swaps when no status is given", async (t) => {
  const { api, http } = await queryApi(t);
  const ln = () => http.requests.map((r) => new URL(r.url)).filter((u) => /\/get_(pool_nodes|swaps)/.test(u.pathname));
  assert.equal((await api.request("GET", "/lnplus/pool?minCredits=5000000")).status, 200);
  assert.equal(ln().at(-1)?.searchParams.get("min_size"), "5000000");
  assert.equal((await api.request("GET", "/lnplus/swaps?status=opening")).status, 200);
  assert.equal(ln().at(-1)?.searchParams.get("status"), "opening");
  assert.equal((await api.request("GET", "/lnplus/swaps")).status, 200);
  assert.equal(ln().at(-1)?.searchParams.get("status"), "pending");
  assert.equal((await api.request("GET", "/lnplus/swaps?status=pending")).status, 200);
  assert.equal(ln().at(-1)?.searchParams.get("status"), "pending", "as the web's type allows");
});
