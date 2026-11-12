/**
 * Settings can be found, and connecting Amboss is one guided path (review
 * 2026-11-10, P10, SET-2..SET-5): what the server says and gives the page
 * for it — signing with and without write mode, the key's refusals in the
 * words the card uses, and the "needs the Amboss key" mark the start page
 * and the Autopilot rows lead to the card with.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startApi } from "./helpers/apiHarness.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { feeNode } from "./helpers/feeNode.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { makeTempDir } from "./helpers/tmp.js";
import { recordStoreIncident } from "../src/store.js";
import { stateAlerts } from "../src/services/alerts.js";

test("SET-3: signing a message needs write mode — read-only, the route says so (403) and LND is asked nothing; with it, the node's signature comes back", async (t) => {
  const ro = new FakeLnd({ chainBalance: 1_000_000 });
  const readOnly = await startApi(t, { node: ro, readOnly: true });
  const refused = await readOnly.request("POST", "/sign", { message: "amboss-challenge-123" });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.message, "Enable write mode to sign (needs the admin macaroon).");
  assert.equal(ro.callsTo("default.signMessage").length, 0);

  const node = new FakeLnd({ chainBalance: 1_000_000 });
  node.override("default.signMessage", (a, cb) => cb(null, { signature: `sig-of-${Buffer.from(a.msg as Buffer).toString("utf8")}` }));
  const api = await startApi(t, { node });
  const signed = await api.request("POST", "/sign", { message: "amboss-challenge-123" });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.signature, "sig-of-amboss-challenge-123", "exactly the message sent (the page trims what was pasted)");
  assert.equal((await api.request("POST", "/sign", { message: "   " })).status, 400);
  // Whether write mode is on, for the card to say before the click.
  assert.equal((await readOnly.request("GET", "/autopilot")).body.canWrite, false);
  assert.equal((await api.request("GET", "/autopilot")).body.canWrite, true);
});

test("SET-5: the key's refusals say what to do, in the card's words — 'Amboss key', where a fresh one is made", async (t) => {
  const http = installFetchMock(t);
  http.on(/amboss/, () => new Response(JSON.stringify({ errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHENTICATED" } }] }), { status: 401 }));
  const api = await startApi(t);
  const empty = await api.request("POST", "/amboss/key", { apiKey: "  " });
  assert.deepEqual([empty.status, empty.body.message], [400, "Paste your Amboss key first."]);
  const rejected = await api.request("POST", "/amboss/key", { apiKey: "sk_not-a-real-key" });
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.message, "Amboss rejected this key. Make a fresh one at account.amboss.tech → Settings → API keys and paste it again.");
  assert.equal(api.amboss.hasKey(), false, "nothing saved");
});

test("SET-4: selling switched on without an Amboss key — the start page's status carries 'needs the Amboss key', so its line leads to the Amboss card", async (t) => {
  installFetchMock(t).on(/./, () => new Response("{}", { status: 503 }));
  const node = feeNode({ blockHeight: 860_000, channels: [] });
  node.override("default.closedChannels", (_a, cb) => cb(null, { channels: [] }));
  node.override("default.getTransactions", (_a, cb) => cb(null, { transactions: [], first_index: "0", last_index: "0" }));
  node.override("default.listPayments", (_a, cb) => cb(null, { payments: [], first_index_offset: "0", last_index_offset: "0" }));
  const api = await startApi(t, { node });
  api.settings.set({ lnplusLookups: false });
  api.autopilot.setConfig({ sellEnabled: true });
  const dash = await api.request("GET", "/dashboard");
  assert.equal(dash.status, 200, JSON.stringify(dash.body).slice(0, 300));
  const magma = dash.body.autopilot.status.magma;
  assert.equal(magma.state, "blocked");
  assert.equal(magma.needs, "amboss_key");
  assert.match(magma.text, /^no Amboss key — connect it in Settings → Amboss/);
  // Another area's status carries no such mark.
  for (const [area, s] of Object.entries(dash.body.autopilot.status as Record<string, { needs?: string }>)) if (area !== "magma") assert.equal(s.needs, undefined, area);
});

test("SET-4: the alert for a lost Amboss key file leads to the Amboss card; the refusals for want of a key say where", async (t) => {
  const dir = makeTempDir(t);
  recordStoreIncident(dir, { file: "amboss.json", kind: "reset", detail: "unreadable" });
  recordStoreIncident(dir, { file: "settings.json", kind: "reset", detail: "unreadable" });
  const alerts = stateAlerts(dir);
  const key = alerts.find((a) => /amboss\.json/.test(a.message));
  assert.match(key?.message ?? "", /Connect your Amboss key again \(Settings → Amboss\)\./);
  assert.deepEqual(key?.link, { tab: "settings", sub: "amboss", label: "Connect Amboss" });
  assert.equal(alerts.find((a) => /settings\.json/.test(a.message))?.link, undefined, "no link where none leads anywhere new");
  const api = await startApi(t);
  const refused = await api.request("POST", "/amboss/offer", { totalSizeSats: 5_000_000, minSizeSats: 1_000_000, maxSizeSats: 2_000_000, feeRatePpm: 2000, baseFeeSats: 0, minBlockLength: 4320 });
  assert.deepEqual([refused.status, refused.body.message], [400, "Connect your Amboss key first (Settings → Amboss)."]);
});
