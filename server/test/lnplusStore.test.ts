/**
 * The LN+ store (review 2026-11-10, CHAN-11, CHAN-12): one call per node at a
 * time, a state that says when LN+ was not asked, and an answer that is
 * checked before it is used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LnPlusStore } from "../src/services/lnplusStore.js";
import { getSwaps, lnplusUrl } from "../src/services/lnplus.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { makeTempDir } from "./helpers/tmp.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PK = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const GET_NODE = /^https:\/\/lightningnetwork\.plus\/api\/2\/get_node\//;
const answer = (pubkey: string, o: Record<string, unknown> = {}) => ({ pubkey, alias: "n", lnp_rank: 5, lnp_rank_name: "Gold", profile_urls: { "LN+": `https://lightningnetwork.plus/nodes/${pubkey}` }, ...o });

test("two reads of one unknown node at once ask LN+ once — the node panel's two requests spent two of the day's calls", async (t) => {
  const http = installFetchMock(t);
  let release = () => undefined as void;
  const held = new Promise<void>((r) => (release = r));
  let calls = 0;
  http.on(GET_NODE, async () => {
    calls += 1;
    await held;
    return answer(PK(1));
  });
  const store = new LnPlusStore(makeTempDir(t));
  const a = store.lookupWithState(PK(1));
  const b = store.enrich([PK(1)], 1);
  await new Promise((r) => setTimeout(r, 10));
  release();
  const [one, two] = await Promise.all([a, b]);
  assert.equal(calls, 1);
  assert.equal(one.profile?.rank, 5);
  assert.equal(one.state, "ok");
  assert.equal(two.get(PK(1))?.rank, 5);
  assert.equal(store.stats().callsToday, 1);
});

test("with the day's LN+ calls spent, an unknown node is 'not_asked' — not 'ok' with no profile, which read as 'no LN+ profile'", async (t) => {
  const http = installFetchMock(t);
  let calls = 0;
  http.on(GET_NODE, () => {
    calls += 1;
    return new Response("{}", { status: 422 });
  });
  const store = new LnPlusStore(makeTempDir(t));
  const left = store.remainingToday();
  for (let i = 0; i < left; i++) await store.lookupWithState(PK(10 + (i % 200)));
  assert.equal(store.remainingToday(), 0);
  const before = calls;
  assert.deepEqual(await store.lookupWithState(PK(250)), { profile: null, state: "not_asked" });
  assert.equal(calls, before, "nothing asked");
  // A node LN+ already answered for is "ok" still, with what it said.
  assert.deepEqual(await store.lookupWithState(PK(10)), { profile: null, state: "ok" });
  // Switched off: "off".
  const off = new LnPlusStore(makeTempDir(t), () => false);
  assert.equal((await off.lookupWithState(PK(1))).state, "off");
});

test("an LN+ answer about another node is not taken for this one, and a profile link that does not point at LN+ is replaced by the profile's address (CHAN-12)", async (t) => {
  const http = installFetchMock(t);
  http.on(GET_NODE, (req) => {
    const asked = decodeURIComponent(req.url.split("pubkey=")[1] ?? "");
    if (asked === PK(2)) return answer(PK(3));
    return answer(asked, { profile_urls: { "LN+": "https://evil.example/phish" } });
  });
  const store = new LnPlusStore(makeTempDir(t));
  assert.deepEqual(await store.lookupWithState(PK(2)), { profile: null, state: "ok" }, "no rank of another node on this key");
  const own = await store.lookupWithState(PK(4));
  assert.equal(own.profile?.profileUrl, `https://lightningnetwork.plus/nodes/${PK(4)}`);
  assert.equal(lnplusUrl("https://lightningnetwork.plus/nodes/x", "x"), "https://lightningnetwork.plus/nodes/x");
  assert.equal(lnplusUrl("https://lightningnetwork.plus.evil.example/", "x"), "https://lightningnetwork.plus/nodes/x");
  assert.equal(lnplusUrl(42, "x"), "https://lightningnetwork.plus/nodes/x");
  // A swap's page the same way (the review of P4, P6: its link was taken unchecked).
  assert.equal(lnplusUrl("https://evil.example/swap", "", "swaps/12"), "https://lightningnetwork.plus/swaps/12");
  assert.equal(lnplusUrl("https://lightningnetwork.plus/swaps/12", "", "swaps/12"), "https://lightningnetwork.plus/swaps/12");
});

test("SEC-10: an LN+ link is parsed — https on LN+'s own host — and one kept in the cache from before is checked again when it is loaded", async (t) => {
  assert.equal(lnplusUrl("javascript:alert(1)", "x"), "https://lightningnetwork.plus/nodes/x");
  assert.equal(lnplusUrl("http://lightningnetwork.plus/nodes/x", "x"), "https://lightningnetwork.plus/nodes/x", "not plain http");
  assert.equal(lnplusUrl('https://lightningnetwork.plus/nodes/x" onclick="y', "x"), "https://lightningnetwork.plus/nodes/x%22%20onclick=%22y", "as the URL reads it");
  const http = installFetchMock(t);
  http.on(GET_NODE, (req) => answer(decodeURIComponent(req.url.split("pubkey=")[1] ?? "")));
  const dir = makeTempDir(t);
  const first = new LnPlusStore(dir);
  assert.equal((await first.lookupWithState(PK(5))).profile?.profileUrl, `https://lightningnetwork.plus/nodes/${PK(5)}`);
  // As an older version may have kept it, unchecked.
  const file = join(dir, "lnplus-nodes.json");
  const kept = JSON.parse(readFileSync(file, "utf8"));
  kept.nodes[PK(5)].node.profileUrl = "javascript:alert(document.cookie)";
  writeFileSync(file, JSON.stringify(kept));
  const asked = http.requests.length;
  const again = new LnPlusStore(dir);
  assert.equal((await again.lookupWithState(PK(5))).profile?.profileUrl, `https://lightningnetwork.plus/nodes/${PK(5)}`);
  assert.equal(http.requests.length, asked, "from the cache");
  // A link with another port is no LN+ page either (M36).
  assert.equal(lnplusUrl("https://lightningnetwork.plus:8443/nodes/x", "x"), "https://lightningnetwork.plus/nodes/x");
  // An entry that is no node at all doesn't stop the start (R1-7).
  kept.nodes[PK(6)] = { at: Date.now(), node: 42 };
  writeFileSync(file, JSON.stringify(kept));
  assert.doesNotThrow(() => new LnPlusStore(dir));
});

test("a swap's link from LN+ that does not point at LN+ is replaced by the swap's page there", async (t) => {
  const http = installFetchMock(t);
  http.on(/^https:\/\/lightningnetwork\.plus\/api\/2\/get_swaps\//, () => [
    { id: 12, web_url: "https://evil.example/phish", status: "waiting", capacity_sats: 1_000_000 },
    { id: 13, web_url: "https://lightningnetwork.plus/swaps/13", status: "waiting", capacity_sats: 1_000_000 },
  ]);
  const swaps = await getSwaps();
  assert.deepEqual(swaps.map((s) => s.url), ["https://lightningnetwork.plus/swaps/12", "https://lightningnetwork.plus/swaps/13"]);
});
