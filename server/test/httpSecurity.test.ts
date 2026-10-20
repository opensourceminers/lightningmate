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

