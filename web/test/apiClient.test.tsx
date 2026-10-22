/**
 * The web client's own requests (web/src/api.ts): what a failed download
 * says, and that every POST it makes is JSON — the server refuses any other
 * kind under /api (a cross-site form's: SECURITY.md, server
 * test/httpSecurity.test.ts).
 */
import "./helpers/browserGlobals";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { api, downloadFailed } from "../src/api";

/** Answer every fetch with `answer`, recording the requests. */
function stubFetch(t: TestContext, answer: () => Response): { url: string; init: RequestInit | undefined }[] {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    seen.push({ url, init });
    return answer();
  });
  return seen;
}

// Review of P7 (final): "Download diagnostics" dropped the server's message —
// the operator read "Diagnostics failed (502)." and nothing about why.
test("a failed diagnostics download says what the server said — its status only when it said nothing", async (t) => {
  stubFetch(t, () => Response.json({ error: "node", message: "LND did not answer: transport is closing" }, { status: 502 }));
  await assert.rejects(api.diagnosticsDownload(), { message: "LND did not answer: transport is closing" });
  t.mock.restoreAll();
  stubFetch(t, () => new Response("", { status: 502 }));
  await assert.rejects(api.diagnosticsDownload(), { message: "Diagnostics failed (502)." });
  assert.equal((await downloadFailed(new Response("not json", { status: 500 }), "Export failed (500).")).message, "Export failed (500).");
});

test("the channel backup export is a JSON POST (the server refuses a POST of any other type) and says the server's error", async (t) => {
  const seen = stubFetch(t, () => Response.json({ message: "LND did not answer" }, { status: 502 }));
  await assert.rejects(api.backupExport(), { message: "LND did not answer" });
  assert.equal(seen[0].url, "/api/backup/export");
  assert.equal(seen[0].init?.method, "POST");
  assert.equal((seen[0].init?.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("every POST the client sends is JSON: the post() helper, the login and the raw downloads", () => {
  const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  // Each fetch that POSTs names the JSON content type in the same call.
  const posts = [...src.matchAll(/fetch\([^;]*?method: "POST"[^;]*?\)/gs)].map((m) => m[0]);
  assert.ok(posts.length >= 3, `found ${posts.length}`);
  for (const call of posts) assert.match(call, /"Content-Type": "application\/json"/, call);
});

// Review of P8, run 2: the query strings were written out by hand, and are
// built from the query's contract type now — what goes out must be what the
// routes read: each set field as text (a flag "true", which the routes that
// read flags take), nothing for a field left unset.
test("a GET's query is built from its contract type: the set fields, as the routes read them — none when nothing is set", async (t) => {
  const seen = stubFetch(t, () => Response.json({}));
  await api.pnl(30);
  await api.flows();
  await api.forwardsReport(7);
  await api.magmaEligibility(true);
  await api.magmaEligibility();
  await api.onchainPreview({ address: "bc1qexample", feeRate: 5, all: true });
  await api.onchainPreview({ address: "bc1qexample", feeRate: 5, tokens: 20_000 });
  await api.ambossOrder("a b&c");
  await api.suggestions({ minChannels: 8, requireClearnet: false });
  await api.lnplusSwaps();
  await api.closeCandidates();
  const tz = -new Date().getTimezoneOffset();
  assert.deepEqual(
    seen.map((s) => s.url),
    [
      "/api/pnl?days=30",
      "/api/flows",
      `/api/forwards/report?days=7&tz=${tz}`,
      "/api/amboss/eligibility?refresh=true",
      "/api/amboss/eligibility",
      "/api/onchain/send-preview?address=bc1qexample&feeRate=5&all=true",
      "/api/onchain/send-preview?address=bc1qexample&feeRate=5&tokens=20000",
      "/api/amboss/order?id=a+b%26c",
      "/api/suggestions?minChannels=8&requireClearnet=false",
      "/api/lnplus/swaps",
      "/api/suggestions/close",
    ],
  );
  for (const s of seen) assert.equal(s.init?.method, undefined, "a GET");
});
