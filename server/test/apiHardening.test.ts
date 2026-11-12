/**
 * The API's hardening (review 2026-11-10, package P5): the tokenless widget
 * can't make LND scan its history per request (SEC-3), every answer carries
 * the security headers (SEC-4), the right password is not locked out behind
 * Umbrel's proxy (SEC-5), a broken body is answered as JSON behind the login
 * gate (SEC-6), an Amboss key is one line of printable characters and never
 * echoed (SEC-7), sessions are signed with a secret of their own and can be
 * ended (SEC-9), an address is judged by the node's own chain (CHAN-10), an
 * unknown setting is refused (ENG-12), an unknown API path is a 404, every
 * async route is wrapped, and the data directory is readable by the app only.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { startApi } from "./helpers/apiHarness.js";
import { withEnv } from "./helpers/env.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { makeTempDir } from "./helpers/tmp.js";
import { CONTENT_SECURITY_POLICY, createHttpApp } from "../src/app.js";
import { RequestGate } from "../src/shutdown.js";
import { issueToken, loadTokenSecret, revokeAllTokens, verifyToken } from "../src/services/auth.js";
import { createHmac } from "node:crypto";
import { tidyDataDir } from "../src/store.js";

function quiet(t: TestContext): string[] {
  const lines: string[] = [];
  for (const level of ["log", "warn", "error"] as const) t.mock.method(console, level, (...a: unknown[]) => lines.push(a.join(" ")));
  return lines;
}

test("SEC-3: parallel widget requests share one read of LND, a fresh answer is kept 30 s, a failed one 10 s — and the route is wrapped", async (t) => {
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  let scans = 0;
  let fail = false;
  node.override("default.forwardingHistory", (_a, cb) => {
    scans += 1;
    setTimeout(() => (fail ? cb({ details: "LND is down" }) : cb(null, { forwarding_events: [], last_offset_index: "0" })), 60);
  });
  const api = await startApi(t, { node });
  const answers = await Promise.all(Array.from({ length: 40 }, () => api.request("GET", "/widget/stats")));
  assert.ok(answers.every((a) => a.status === 200 && a.body.type === "four-stats" && a.body.items.length === 4));
  assert.equal(scans, 1, "40 parallel requests, one forwarding-history scan");
  await api.request("GET", "/widget/stats");
  assert.equal(scans, 1, "kept");
  // A failed read is kept too (10 s), not tried again per request.
  const fresh = await startApi(t, { node });
  fail = true;
  scans = 0;
  const failed = await Promise.all(Array.from({ length: 10 }, () => fresh.request("GET", "/widget/stats")));
  assert.ok(failed.every((a) => a.status === 200 && a.body.items.length === 0));
  for (let i = 0; i < 5; i++) await fresh.request("GET", "/widget/stats");
  assert.equal(scans, 1, "one scan while LND fails");
  const src = readFileSync(join(import.meta.dirname, "../src/routes/api.ts"), "utf8");
  assert.match(src, /router\.get\(\n\s+"\/widget\/stats",\n\s+wrap\(async/);
});

test("every async route handler is wrapped — an unhandled rejection would end the process (index.ts exits on one)", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/routes/api.ts"), "utf8");
  const bare = [...src.matchAll(/router\.(get|post|put|delete|patch)\(\s*"([^"]+)",\s*async\b/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.deepEqual(bare, [], "routes registered with a bare async function");
  assert.match(src, /router\.post\(\n\s+"\/amboss\/key",\n\s+wrap\(async/);
});

test("SEC-4: the page and the API carry the CSP, frame, nosniff and referrer headers — the policy allows only what the built app uses", async (t) => {
  const web = makeTempDir(t);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>x</title>");
  const app = createHttpApp({ apiRouter: Router().get("/ping", (_q, s) => void s.json({ ok: true })), allowedHosts: [], authRequired: false, requestGate: new RequestGate(), webDir: web });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  const get = (path: string) =>
    new Promise<http.IncomingMessage>((resolve, reject) =>
      http.get({ host: "127.0.0.1", port, path, headers: { Host: `localhost:${port}`, "Sec-Fetch-Site": "same-origin" } }, (res) => {
        res.resume();
        resolve(res);
      }).on("error", reject),
    );
  for (const path of ["/", "/some/page", "/api/ping"]) {
    const res = await get(path);
    assert.equal(res.headers["content-security-policy"], CONTENT_SECURITY_POLICY, path);
    assert.equal(res.headers["x-frame-options"], "DENY", path);
    assert.equal(res.headers["x-content-type-options"], "nosniff", path);
    assert.equal(res.headers["referrer-policy"], "no-referrer", path);
  }
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/, "no inline or foreign script");
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self'(;|$)/, "the page talks to its own API only");
  // The built page loads nothing from elsewhere and has no inline script.
  const html = readFileSync(join(import.meta.dirname, "../../web/index.html"), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "no inline script");
  assert.doesNotMatch(html, /(src|href)="https?:/, "nothing from another origin");
});

test("SEC-6: a broken or oversized body is answered as JSON — behind the login gate, with one short log line and no stack", async (t) => {
  const lines = quiet(t);
  withEnv(t, { APP_PASSWORD: "owner-password-long-enough", APP_SEED: "seed" });
  const api = await startApi(t);
  // Without a token the body is never read: 401, nothing logged.
  const tokenless = await api.request("POST", "/settings", undefined, { rawBody: "{broken" });
  assert.equal(tokenless.status, 401);
  assert.equal(lines.length, 0, "nothing logged for a tokenless broken body");
  const token = issueToken();
  const broken = await api.request("POST", "/settings", undefined, { rawBody: "{broken", token });
  assert.equal(broken.status, 400);
  assert.deepEqual(broken.body, { error: "bad_json", message: "The request body is no valid JSON." });
  const big = await api.request("POST", "/settings", undefined, { rawBody: JSON.stringify({ x: "y".repeat(300_000) }), token });
  assert.equal(big.status, 413);
  assert.equal(big.body.error, "body_too_large");
  assert.equal(lines.length, 2, lines.join("\n"));
  assert.ok(lines.every((l) => l.length < 200 && !/\n\s+at /.test(l)), "short lines, no stack");
  // The login itself still reads its body (an open path).
  const unlocked = await api.request("POST", "/auth/unlock", { password: "owner-password-long-enough" });
  assert.equal(unlocked.status, 200);
});

test("an unknown API path is a JSON 404 — not the web app's page — and only once signed in", async (t) => {
  withEnv(t, { APP_PASSWORD: "owner-password-long-enough", APP_SEED: "seed" });
  const api = await startApi(t);
  assert.equal((await api.request("GET", "/no/such/route")).status, 401);
  const res = await api.request("GET", "/no/such/route", undefined, { token: issueToken() });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "not_found", message: "No such API route." });
  assert.equal((await api.request("POST", "/amboss/buy", {}, { token: issueToken() })).status, 404);
});

test("SEC-5: behind Umbrel's proxy (one address for every browser) 8 wrong passwords a minute no longer lock Umbrel's own password out; a password a person chose keeps the limit for every attempt, however long", async (t) => {
  const UMBREL = "3f".repeat(32); // as umbreld derives it: an HMAC-SHA256 in hex
  withEnv(t, { APP_PASSWORD: UMBREL, APP_SEED: "seed" });
  const api = await startApi(t);
  for (let i = 0; i < 8; i++) assert.equal((await api.request("POST", "/auth/unlock", { password: `guess-${i}` })).status, 401);
  assert.equal((await api.request("POST", "/auth/unlock", { password: "guess-9" })).status, 429, "guessing is still limited");
  const owner = await api.request("POST", "/auth/unlock", { password: UMBREL });
  assert.equal(owner.status, 200, "the owner gets in");
  assert.ok(verifyToken(owner.body.token));
  // Not random by construction: the limit holds for every attempt (R1-2).
  for (const chosen of ["short-pw", "lightningmate-password-2026-long", "3f".repeat(31) + "3", "g".repeat(64), UMBREL + "0"]) {
    const other = await startApi(t);
    process.env.APP_PASSWORD = chosen; // (withEnv above puts it back)
    for (let i = 0; i < 8; i++) await other.request("POST", "/auth/unlock", { password: `guess-${i}` });
    assert.equal((await other.request("POST", "/auth/unlock", { password: chosen })).status, 429, `${chosen.slice(0, 20)}…: the limit holds`);
  }
  const src = readFileSync(join(import.meta.dirname, "../src/routes/api.ts"), "utf8");
  assert.match(src, /The password is checked\n\s+\/\/ first \(in constant time\), and the right one gets through the limit when\n\s+\/\/ it is random by construction — Umbrel's derived one, 64 hex characters\./, "the comment says what the code does");
});

test("SEC-9: sessions are signed with a random secret kept in the data directory (mode 600) — not the password — and 'Sign out everywhere' ends every one", async (t) => {
  withEnv(t, { APP_PASSWORD: "owner-password-long-enough", APP_SEED: undefined });
  const dir = makeTempDir(t);
  loadTokenSecret(dir);
  const file = join(dir, "token-secret");
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, "utf8").trim(), /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const token = issueToken();
  const [exp, sig] = token.split(".");
  assert.notEqual(sig, createHmac("sha256", "owner-password-long-enough").update(exp).digest("base64url"), "the password is not the key");
  assert.ok(verifyToken(token));
  // Kept over a restart: the same file, the same secret.
  loadTokenSecret(dir);
  assert.ok(verifyToken(token), "a restart keeps the sessions");
  revokeAllTokens();
  assert.equal(verifyToken(token), false, "ended");
  loadTokenSecret(dir);
  assert.equal(verifyToken(token), false, "and stays ended over a restart");
  assert.ok(verifyToken(issueToken()), "a new sign-in works");
  // A damaged file: a new secret.
  writeFileSync(file, "not hex");
  loadTokenSecret(dir);
  assert.match(readFileSync(file, "utf8").trim(), /^[0-9a-f]{64}$/);
  // Through the API: this session too.
  const api = await startApi(t);
  const mine = issueToken();
  assert.equal((await api.request("GET", "/settings", undefined, { token: mine })).status, 200);
  const done = await api.request("POST", "/auth/revoke", {}, { token: mine });
  assert.deepEqual([done.status, done.body], [200, { ok: true }]);
  assert.equal((await api.request("GET", "/settings", undefined, { token: mine })).status, 401);
  assert.equal((await api.request("POST", "/auth/revoke", {})).status, 401, "needs a session");
});

test("SEC-7: an Amboss key with a line break, a space or 3,000 characters is refused before any request — and never echoed", async (t) => {
  const api = await startApi(t);
  for (const key of ["sk_first-half\nSECOND-HALF", "two words", "k".repeat(3000), "tab\there", "ümlaut-key"]) {
    const res = await api.request("POST", "/amboss/key", { apiKey: key });
    assert.equal(res.status, 400, JSON.stringify(key));
    assert.equal(res.body.error, "invalid_key");
    assert.ok(!JSON.stringify(res.body).includes(key.slice(0, 12)), "the key is not in the answer");
    assert.ok(!res.body.message.includes("SECOND-HALF"));
  }
  assert.equal(api.amboss.hasKey(), false, "nothing saved");
});

test("CHAN-10: the send takes an address of the node's own chain — regtest's bcrt1 on regtest, never a mainnet one there; mainnet as before", async (t) => {
  const preview = async (chain: string | null, address: string) => {
    const node = new FakeLnd({ chainBalance: 1_000_000 });
    if (chain) {
      // LND's getInfo as it answers on that chain.
      const fake = node as unknown as { infoRpc: () => Record<string, unknown> };
      const info = fake.infoRpc.bind(node);
      fake.infoRpc = () => ({ ...info(), chains: [{ chain: "bitcoin", network: chain }] });
    }
    const api = await startApi(t, { node });
    return api.request("GET", `/onchain/send-preview?address=${address}&feeRate=5&tokens=10000`);
  };
  const bad = (r: { status: number; body: { message?: string } }) => r.status === 400 && /a valid address/.test(r.body.message ?? "");
  assert.ok(!bad(await preview("regtest", "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")), "bcrt1 on regtest");
  assert.ok(bad(await preview("regtest", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")), "a mainnet address on regtest");
  assert.ok(!bad(await preview("testnet", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")), "tb1 on testnet");
  assert.ok(!bad(await preview("signet", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")), "tb1 on signet");
  assert.ok(!bad(await preview("mainnet", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")), "bc1 on mainnet");
  assert.ok(!bad(await preview("mainnet", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")), "base58 3… on mainnet");
  assert.ok(bad(await preview("mainnet", "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080")), "regtest's on mainnet");
  assert.ok(bad(await preview("mainnet", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")), "testnet's on mainnet");
  // Base58 by chain: m/n/2 off mainnet, 1/3 on it only.
  assert.ok(!bad(await preview("testnet", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")), "m… on testnet");
  assert.ok(!bad(await preview("regtest", "2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc")), "2… on regtest");
  assert.ok(bad(await preview("testnet", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy")), "3… on testnet");
  assert.ok(bad(await preview("regtest", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")), "1… on regtest");
  assert.ok(bad(await preview("mainnet", "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")), "m… on mainnet");
  // A chain LND doesn't say: mainnet's rules (the strictest) — and asked again next time.
  const node = new FakeLnd({ chainBalance: 1_000_000 });
  const fake = node as unknown as { infoRpc: () => Record<string, unknown> };
  const info = fake.infoRpc.bind(node);
  fake.infoRpc = () => ({ ...info(), chains: [{ chain: "bitcoin", network: "regtest" }] });
  node.failNext("default.getInfo", "LND is starting");
  const api = await startApi(t, { node });
  const ask = () => api.request("GET", "/onchain/send-preview?address=bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080&feeRate=5&tokens=10000");
  assert.ok(bad(await ask()), "unread: mainnet's rules");
  assert.ok(!bad(await ask()), "read the next time: regtest's");
});

test("ENG-12: POST /autopilot refuses a field the settings don't have, by name, and saves nothing", async (t) => {
  const api = await startApi(t);
  const before = (await api.request("GET", "/autopilot")).body.config;
  const res = await api.request("POST", "/autopilot", { intervalMinutes: 45, intervalMinuts: 45 });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body.errors, ["intervalMinuts is no setting"]);
  assert.deepEqual((await api.request("GET", "/autopilot")).body.config, before, "nothing saved");
});

test("the data directory at start: every file readable by the app only (amboss.json with the key, settings, backup, rebalances) and the orphaned market telemetry gone", (t) => {
  const lines = quiet(t);
  const dir = makeTempDir(t);
  for (const f of ["amboss.json", "settings.json", "backup.json", "rebalances.json", "market-telemetry.json", "market-telemetry.json.bak", "autopilot.json"]) {
    writeFileSync(join(dir, f), "{}");
    chmodSync(join(dir, f), f === "autopilot.json" ? 0o600 : 0o644);
  }
  const done = tidyDataDir(dir);
  assert.deepEqual(done.removed.sort(), ["market-telemetry.json", "market-telemetry.json.bak"]);
  assert.deepEqual(done.tightened.sort(), ["amboss.json", "backup.json", "rebalances.json", "settings.json"]);
  for (const f of ["amboss.json", "settings.json", "backup.json", "rebalances.json", "autopilot.json"]) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600, f);
  assert.ok(!existsSync(join(dir, "market-telemetry.json")));
  assert.equal(readFileSync(join(dir, "rebalances.json"), "utf8"), "{}", "the rebalance record is kept: it is no orphan");
  assert.ok(lines.some((l) => /readable by this app only now: /.test(l)));
  assert.deepEqual(tidyDataDir(dir), { tightened: [], removed: [] }, "once done, nothing more");
  const index = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
  assert.match(index, /tidyDataDir\(config\.dataDir\);\n\s+loadTokenSecret\(config\.dataDir\);/);
});

test("SEC-9: APP_SEED is mixed into the key — the same secret with another seed signs other tokens — and a kept secret file left readable by others is made 0600", (t) => {
  const dir = makeTempDir(t);
  withEnv(t, { APP_PASSWORD: "owner-password-long-enough", APP_SEED: "seed-one" });
  loadTokenSecret(dir);
  const token = issueToken();
  assert.ok(verifyToken(token));
  process.env.APP_SEED = "seed-two";
  assert.equal(verifyToken(token), false, "another seed, another key");
  process.env.APP_SEED = "seed-one";
  assert.ok(verifyToken(token));
  chmodSync(join(dir, "token-secret"), 0o644);
  loadTokenSecret(dir);
  assert.equal(statSync(join(dir, "token-secret")).mode & 0o777, 0o600);
  assert.ok(verifyToken(token), "the kept secret");
});

test("SEC-6 (R1-5): of the open paths only the sign-in reads a body, and a broken one there writes no log line; a body in a charset the parser can't read is 415", async (t) => {
  const lines = quiet(t);
  withEnv(t, { APP_PASSWORD: "owner-password-long-enough", APP_SEED: "seed" });
  const api = await startApi(t);
  for (let i = 0; i < 5; i++) assert.equal((await api.request("POST", "/auth/unlock", undefined, { rawBody: "{broken" })).status, 400);
  const health = await api.request("GET", "/health", undefined, { rawBody: "{broken", headers: { "Content-Type": "application/json" } });
  assert.equal(health.status, 200, "the health check reads no body");
  assert.deepEqual(lines, [], "nothing logged for tokenless bodies");
  const latin = await api.request("POST", "/settings", undefined, { rawBody: '{"fiatCurrency":"EUR"}', token: issueToken(), headers: { "Content-Type": "application/json; charset=klingon" } });
  assert.equal(latin.status, 415);
  assert.equal(latin.body.error, "unsupported_body");
});

test("SEC-6 (R1-17): the app's last error handler answers JSON under /api and keeps a client's 4xx as it is, without a log line or a stack", async (t) => {
  const lines = quiet(t);
  const web = makeTempDir(t);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>x</title>");
  const router = Router().get("/boom", () => {
    throw new Error("an LND library error /home/x/node_modules");
  });
  const app = createHttpApp({ apiRouter: router, allowedHosts: [], authRequired: false, requestGate: new RequestGate(), webDir: web });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  const get = (path: string) =>
    new Promise<{ status: number; type: string; body: string }>((resolve, reject) =>
      http
        .get({ host: "127.0.0.1", port, path, headers: { Host: `localhost:${port}`, "Sec-Fetch-Site": "same-origin" } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
        })
        .on("error", reject),
    );
  const boom = await get("/api/boom");
  assert.equal(boom.status, 500);
  assert.match(boom.type, /application\/json/);
  assert.deepEqual(JSON.parse(boom.body), { error: "server_error", message: "The request could not be handled." });
  const logged = () => lines.filter((l) => l.includes("[http]"));
  assert.equal(logged().length, 1);
  assert.doesNotMatch(logged()[0]!, /\n\s+at /, "one line, no stack");
  const bad = await get("/%");
  assert.equal(bad.status, 400, "serve-static's own 400 for a malformed path");
  assert.equal(bad.body, "The request is not valid.");
  assert.equal(logged().length, 1, "no log line for a client's fault");
});

test("tidyDataDir (R1-6): only the app's own files — not another file of a mis-set data dir, never through a symlink out of it", (t) => {
  quiet(t);
  const dir = makeTempDir(t);
  const outside = makeTempDir(t);
  writeFileSync(join(outside, "elsewhere.json"), "{}");
  chmodSync(join(outside, "elsewhere.json"), 0o644);
  symlinkSync(join(outside, "elsewhere.json"), join(dir, "linked.json"));
  for (const f of ["notes.txt", "settings.json", "settings.json.bak", "settings.json.corrupt-2026-11-12T10-00-00-000Z", "token-secret"]) {
    writeFileSync(join(dir, f), "x");
    chmodSync(join(dir, f), 0o644);
  }
  const done = tidyDataDir(dir);
  assert.deepEqual(done.tightened.sort(), ["settings.json", "settings.json.bak", "settings.json.corrupt-2026-11-12T10-00-00-000Z", "token-secret"]);
  assert.equal(statSync(join(dir, "notes.txt")).mode & 0o777, 0o644, "not the app's");
  assert.equal(statSync(join(outside, "elsewhere.json")).mode & 0o777, 0o644, "not through the link");
});
