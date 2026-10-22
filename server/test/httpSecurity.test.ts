import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { Router } from "express";
import { createHttpApp } from "../src/app.js";
import { RequestGate } from "../src/shutdown.js";
import { assertSafeExposure, effectiveAllowedHosts, hostnameOf, isLoopbackHost } from "../src/exposure.js";
import { issueToken } from "../src/services/auth.js";
import { startApi } from "./helpers/apiHarness.js";
import { withEnv } from "./helpers/env.js";

/** A second loopback address = a different client (e.g. another container).
 *  Linux and Windows route all of 127/8 to loopback; macOS has only
 *  127.0.0.1 there, but IPv6 loopback works everywhere it is enabled. */
async function secondLoopback(): Promise<string | null> {
  for (const address of ["127.0.0.2", "::1"]) {
    const usable = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(0, address, () => probe.close(() => resolve(true)));
    });
    if (usable) return address;
  }
  return null;
}
const OTHER = (await secondLoopback()) ?? "";
const skipOther = OTHER ? false : "no second loopback address (neither 127.0.0.2 nor ::1) on this machine";

test("a guesser from another address cannot lock the owner out of the login", { skip: skipOther }, async (t) => {
  withEnv(t, { APP_PASSWORD: "owner-password", APP_SEED: "seed" });
  const api = await startApi(t);
  for (let i = 0; i < 8; i++) {
    const r = await api.request("POST", "/auth/unlock", { password: `guess-${i}` }, { from: OTHER });
    assert.equal(r.status, 401);
  }
  const blocked = await api.request("POST", "/auth/unlock", { password: "guess-9" }, { from: OTHER });
  assert.equal(blocked.status, 429, "the guesser is throttled");
  const owner = await api.request("POST", "/auth/unlock", { password: "owner-password" });
  assert.equal(owner.status, 200, "the owner's correct password still works");
  assert.ok(owner.body.token);
});

test("only failed logins count toward the limit", async (t) => {
  withEnv(t, { APP_PASSWORD: "owner-password", APP_SEED: "seed" });
  const api = await startApi(t);
  for (let i = 0; i < 12; i++) {
    const r = await api.request("POST", "/auth/unlock", { password: "owner-password" });
    assert.equal(r.status, 200, `login ${i + 1}`);
  }
});

test("unauthenticated write spam does not use up the owner's write budget", { skip: skipOther }, async (t) => {
  withEnv(t, { APP_PASSWORD: "owner-password", APP_SEED: "seed" });
  const api = await startApi(t);
  for (let i = 0; i < 70; i++) {
    const r = await api.request("POST", "/autopilot", {}, { from: OTHER });
    assert.equal(r.status, 401);
  }
  const { body } = await api.request("POST", "/auth/unlock", { password: "owner-password" });
  const write = await api.request("POST", "/autopilot", { intervalMinutes: 45 }, { token: body.token });
  assert.equal(write.status, 200);
  assert.equal(write.body.config.intervalMinutes, 45);
});

test("a client over the write limit only limits itself", { skip: skipOther }, async (t) => {
  withEnv(t, { APP_PASSWORD: "owner-password", APP_SEED: "seed" });
  const api = await startApi(t);
  const { body } = await api.request("POST", "/auth/unlock", { password: "owner-password" });
  for (let i = 0; i < 60; i++) {
    assert.equal((await api.request("POST", "/autopilot", {}, { token: body.token, from: OTHER })).status, 200);
  }
  assert.equal((await api.request("POST", "/autopilot", {}, { token: body.token, from: OTHER })).status, 429);
  assert.equal((await api.request("POST", "/autopilot", {}, { token: body.token })).status, 200);
});

test("refuses to serve beyond loopback without a login", () => {
  assert.throws(() => assertSafeExposure("0.0.0.0", false), /APP_PASSWORD/);
  assert.throws(() => assertSafeExposure("192.168.1.20", false));
  assert.throws(() => assertSafeExposure("::", false));
  assert.doesNotThrow(() => assertSafeExposure("0.0.0.0", true), "Umbrel: login required");
  for (const h of ["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "::ffff:127.0.0.1"]) {
    assert.ok(isLoopbackHost(h), h);
    assert.doesNotThrow(() => assertSafeExposure(h, false));
  }
});

async function serve(t: { after(fn: () => void | Promise<void>): void }, allowedHosts: string[], authRequired: boolean) {
  const router = Router();
  router.get("/ping", (_req, res) => {
    res.json({ ok: true });
  });
  const app = createHttpApp({ apiRouter: router, allowedHosts, authRequired, requestGate: new RequestGate() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  return (host: string) =>
    new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/api/ping", headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
}

test("without a login, only loopback Host names are served (DNS-rebinding defence)", async (t) => {
  const get = await serve(t, [], false);
  assert.equal(await get("attacker.example:3001"), 403);
  assert.equal(await get("localhost:3001"), 200);
  assert.equal(await get("127.0.0.1:3001"), 200);
  assert.equal(await get("[::1]:3001"), 200);
});

test("an explicit allowlist wins; with a login there is no default list", async (t) => {
  const listed = await serve(t, ["umbrel.local"], true);
  assert.equal(await listed("umbrel.local:80"), 200);
  assert.equal(await listed("localhost:3001"), 403);
  const umbrel = await serve(t, [], true);
  assert.equal(await umbrel("lightningmate_web_1:3001"), 200);
  assert.deepEqual(effectiveAllowedHosts([], true), []);
  assert.equal(hostnameOf("[::1]:3001"), "::1");
});

test("with a login: only the open paths answer without a valid, unexpired, untampered token", async (t) => {
  withEnv(t, { APP_PASSWORD: "owner-password", APP_SEED: "seed" });
  const api = await startApi(t);
  assert.equal((await api.request("GET", "/health")).status, 200);
  assert.equal((await api.request("GET", "/autopilot")).status, 401);
  const { body } = await api.request("POST", "/auth/unlock", { password: "owner-password" });
  assert.equal((await api.request("GET", "/autopilot", undefined, { token: body.token })).status, 200);

  const [exp, sig] = (body.token as string).split(".");
  const tampered = `${Number(exp) + 86_400_000}.${sig}`; // extend the expiry, keep the signature
  assert.equal((await api.request("GET", "/autopilot", undefined, { token: tampered })).status, 401);

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 13 * 3_600_000 });
  const old = issueToken(); // issued 13 h ago, sessions last 12 h
  t.mock.timers.reset();
  assert.equal((await api.request("GET", "/autopilot", undefined, { token: old })).status, 401);
});


// ── P8 hardening: where a request comes from ─────────────────────────────────
//
// Standalone without a password serves the API on 127.0.0.1 with no login,
// and nothing checked where a request came from: any page the owner opened
// could send a cross-site HTML form POST to /api/autopilot/resume, /run,
// /pause or /backup/export — routes that act without a JSON body. (On Umbrel
// and with a password the session token, which a foreign page can't set,
// already stopped it.) Now a page of another site is refused outright, and
// every POST must be JSON — which a form can't send, and a cross-site fetch
// can't without a CORS preflight the server never grants.

/** What a browser sends for a form on another site's page: a form type, and
 *  `Sec-Fetch-Site: cross-site` (an older browser leaves that out). */
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const CROSS_SITE = { "Sec-Fetch-Site": "cross-site" };

test("standalone without a password: a cross-site form POST to the body-less actions is refused — 403 from a modern browser, 415 from any other — and nothing happens", async (t) => {
  const api = await startApi(t);
  api.autopilot.setConfig({ enabled: true });
  api.autopilot.pauseAll();
  for (const path of ["/autopilot/resume", "/autopilot/pause", "/autopilot/run", "/backup/export"]) {
    const modern = await api.request("POST", path, undefined, { headers: { ...FORM, ...CROSS_SITE }, rawBody: "" });
    assert.deepEqual([modern.status, modern.body?.error], [403, "cross_site"], path);
    // An older browser sends no Sec-Fetch-Site: the content type gives it away.
    for (const type of ["application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/plain"]) {
      const old = await api.request("POST", path, undefined, { headers: { "Content-Type": type, "Sec-Fetch-Site": "" }, rawBody: "a=1" });
      assert.deepEqual([old.status, old.body?.error], [415, "json_required"], `${path} as ${type}`);
    }
  }
  // Nothing acted: still paused, no run, no export.
  assert.ok(api.autopilot.getState().paused, "a forged resume changed nothing");
  assert.equal(api.backup.get().lastExportAt ?? null, null, "no backup exported");
  // The app's own request (JSON, same-origin) still works.
  const own = await api.request("POST", "/autopilot/resume");
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(api.autopilot.getState().paused, null);
});

test("a body-less POST without any content type is refused too — it is no request of the app's", async (t) => {
  const api = await startApi(t);
  const bare = await api.request("POST", "/autopilot/pause", undefined, { headers: { "Content-Type": "", "Content-Length": "0" }, rawBody: "" });
  assert.equal(bare.status, 415);
  assert.equal(api.autopilot.getState().paused, null);
});

test("a request a browser marks as cross-site is refused whatever it asks — a read, or JSON — while same-origin, same-site and typed-in requests are served", async (t) => {
  const api = await startApi(t);
  assert.equal((await api.request("GET", "/autopilot", undefined, { headers: CROSS_SITE })).status, 403);
  assert.equal((await api.request("POST", "/autopilot", { intervalMinutes: 45 }, { headers: CROSS_SITE })).status, 403);
  assert.equal(api.autopilot.getState().config.intervalMinutes, 30, "the JSON write was refused before it acted");
  for (const site of ["same-origin", "same-site", "none"]) {
    assert.equal((await api.request("GET", "/autopilot", undefined, { headers: { "Sec-Fetch-Site": site } })).status, 200, site);
  }
  // A client that sends no Sec-Fetch-Site at all (curl, an older browser): its JSON is served.
  assert.equal((await api.request("POST", "/autopilot", { intervalMinutes: 45 }, { headers: { "Sec-Fetch-Site": "" } })).status, 200);
  assert.equal(api.autopilot.getState().config.intervalMinutes, 45);
});

test("with a login too: a form POST is refused even with a valid token, and the Host is not checked (Umbrel's app proxy may rewrite it)", async (t) => {
  withEnv(t, { APP_PASSWORD: "owner-password", APP_SEED: "seed" });
  const api = await startApi(t);
  const { body } = await api.request("POST", "/auth/unlock", { password: "owner-password" });
  const form = await api.request("POST", "/autopilot/pause", undefined, { token: body.token, headers: FORM, rawBody: "x=1" });
  assert.equal(form.status, 415);
  assert.equal((await api.request("POST", "/autopilot/pause", undefined, { token: body.token, host: "lightningmate_web_1:3001" })).status, 200);
  // The login itself is JSON, as the web client sends it.
  assert.equal((await api.request("POST", "/auth/unlock", undefined, { headers: FORM, rawBody: "password=owner-password" })).status, 415);
});

test("without a password, a Host other than localhost, 127.0.0.1 or the bound address is refused — the DNS-rebinding defence — on the whole API", async (t) => {
  const api = await startApi(t);
  assert.equal((await api.request("GET", "/autopilot", undefined, { host: "attacker.example:3001" })).status, 403);
  assert.equal((await api.request("POST", "/autopilot/pause", undefined, { host: "rebound.attacker.example" })).status, 403);
  assert.equal(api.autopilot.getState().paused, null);
  assert.equal((await api.request("GET", "/autopilot", undefined, { host: "127.0.0.1:3001" })).status, 200);
  // The address it is bound to (LM_BIND), when that is another loopback one.
  assert.deepEqual(effectiveAllowedHosts([], false, "127.0.0.2"), ["localhost", "127.0.0.1", "::1", "127.0.0.2"]);
  assert.deepEqual(effectiveAllowedHosts([], false, "127.0.0.1"), ["localhost", "127.0.0.1", "::1"]);
  assert.deepEqual(effectiveAllowedHosts([], false, "::1"), ["localhost", "127.0.0.1", "::1"]);
  assert.deepEqual(effectiveAllowedHosts([], true, "0.0.0.0"), [], "with a login: no Host list (Umbrel's proxy)");
  const app = createHttpApp({ apiRouter: Router().get("/ping", (_q, r) => void r.json({ ok: true })), allowedHosts: [], authRequired: false, bindHost: "127.0.0.2", requestGate: new RequestGate() });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  const get = (host: string) =>
    new Promise<number>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/api/ping", headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }).on("error", reject);
    });
  assert.equal(await get("127.0.0.2:3001"), 200, "the bound address");
  assert.equal(await get("attacker.example:3001"), 403);
});
