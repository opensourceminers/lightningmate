/**
 * LightningMate's own lookups and the node's Tor-only policy (review
 * a3-channels:lnplus-clearnet-lookups — package P4).
 *
 * Before, every LN+ request (this node's own pubkey included), the BTC price
 * and Amboss went out over the home internet connection with no way to change
 * it, and Settings claimed the price lookup was "the only outbound request".
 * Now, where Umbrel hands the app its Tor proxy (TOR_PROXY_IP/PORT), the
 * lookups go through it — a SOCKS5 client on Node's own modules, the
 * destination resolved by the proxy, TLS checked as usual, the same deadline,
 * and never a quiet fallback to a direct connection — and LN+ can be switched
 * off. These tests run a local SOCKS5 server (what Tor would be) in front of
 * local HTTP/HTTPS servers (what the services would be).
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { join } from "node:path";
import { HttpTimeoutError, httpRequest, setOutboundRouting, viaTor } from "../src/services/http.js";
import { socksFetch, torProxyFromEnv } from "../src/services/torProxy.js";
import { installFetchMock } from "./helpers/fetchMock.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir } from "./helpers/tmp.js";

/** A SOCKS5 server like Tor's: no auth, CONNECT by name — every name is
 *  "resolved" to `target` — recording what it was asked for. `mute`: it
 *  accepts the connection and never answers. */
async function socksServer(t: TestContext, target: () => number, opts: { mute?: boolean } = {}) {
  const asked: { host: string; port: number }[] = [];
  const server = net.createServer((client) => {
    if (opts.mute) return;
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 3) {
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 5 && buf[3] === 0x03 && buf.length >= 7 + buf[4]) {
        const len = buf[4];
        const host = buf.subarray(5, 5 + len).toString("utf8");
        const port = buf.readUInt16BE(5 + len);
        asked.push({ host, port });
        const rest = buf.subarray(7 + len);
        client.removeListener("data", onData);
        const upstream = net.connect(target(), "127.0.0.1", () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
        stage = 2;
      }
    };
    client.on("data", onData);
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { proxy: { host: "127.0.0.1", port: (server.address() as AddressInfo).port }, asked };
}

/** A local web service answering JSON, recording the Host header it got
 *  (and how a body came: with its length, or chunked). */
async function webServer(t: TestContext, tlsOpts?: { key: Buffer; cert: Buffer }) {
  const seen: {
    host: string | undefined;
    path: string | undefined;
    method: string | undefined;
    body: string;
    contentLength: string | undefined;
    transferEncoding: string | undefined;
  }[] = [];
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({
        host: req.headers.host,
        path: req.url,
        method: req.method,
        body,
        contentLength: req.headers["content-length"],
        transferEncoding: req.headers["transfer-encoding"],
      });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ USD: 67_000, path: req.url }));
    });
  };
  const server = tlsOpts ? https.createServer(tlsOpts, handler) : http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { port: (server.address() as AddressInfo).port, seen };
}

/** A throwaway self-signed certificate for `name` (null: no openssl). */
function testCert(t: TestContext, name: string): { key: Buffer; cert: Buffer } | null {
  const dir = makeTempDir(t);
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const r = spawnSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", key, "-out", cert, "-days", "2", "-subj", `/CN=${name}`, "-addext", `subjectAltName=DNS:${name}`,
  ]);
  return r.status === 0 ? { key: readFileSync(key), cert: readFileSync(cert) } : null;
}

const restoreRouting = (t: TestContext) => t.after(() => setOutboundRouting({ proxy: null, route: "lookups", tlsCa: undefined }));

test("Umbrel's Tor proxy is read from TOR_PROXY_IP / TOR_PROXY_PORT — nothing else counts", () => {
  assert.deepEqual(torProxyFromEnv({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "9050" }), { host: "10.21.21.11", port: 9050 });
  assert.equal(torProxyFromEnv({}), null);
  assert.equal(torProxyFromEnv({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "nope" }), null);
  assert.equal(torProxyFromEnv({ TOR_PROXY_IP: "x; rm -rf", TOR_PROXY_PORT: "9050" }), null);
});

test("through the proxy the destination is sent by NAME (Tor resolves it — no DNS lookup leaves the server) and the request arrives with its own Host", async (t) => {
  const web = await webServer(t);
  const socks = await socksServer(t, () => web.port);
  const ctl = new AbortController();
  const res = await socksFetch("http://lightningnetwork.plus/api/2/get_node/pubkey=02ab", { headers: { Accept: "application/json" } }, socks.proxy, ctl.signal);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { USD: 67_000, path: "/api/2/get_node/pubkey=02ab" });
  assert.deepEqual(socks.asked, [{ host: "lightningnetwork.plus", port: 80 }]);
  assert.equal(web.seen[0].host, "lightningnetwork.plus");
});

test("with a proxy, LN+ and price lookups go through Tor; Amboss and the fee lookup stay direct unless the operator routes everything — and 'direct' routes nothing", async (t) => {
  restoreRouting(t);
  const web = await webServer(t);
  const socks = await socksServer(t, () => web.port);
  const fetchMock = installFetchMock(t);
  fetchMock.on("http://api.amboss.example/graphql", () => ({ data: {} }));
  setOutboundRouting({ proxy: socks.proxy, route: "lookups" });
  assert.deepEqual([viaTor("lnplus"), viaTor("price"), viaTor("amboss"), viaTor("lnurl")], [true, true, false, false]);
  const lnplus = await httpRequest("http://lightningnetwork.plus/api/2/get_swaps/", { headers: { Accept: "application/json" } }, 5_000, "lnplus");
  assert.equal(lnplus.status, 200);
  assert.equal((await lnplus.json<{ path: string }>()).path, "/api/2/get_swaps/");
  await httpRequest("http://api.amboss.example/graphql", { method: "POST", body: "{}" }, 5_000, "amboss");
  assert.deepEqual(socks.asked.map((a) => a.host), ["lightningnetwork.plus"], "Amboss went direct");
  assert.deepEqual(fetchMock.requests.map((r) => r.url), ["http://api.amboss.example/graphql"], "and LN+ never touched the direct path");

  setOutboundRouting({ route: "all" });
  assert.deepEqual([viaTor("amboss"), viaTor("lnurl")], [true, true]);
  const amboss = await httpRequest("http://api.amboss.example/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"query":"{ x — ü }"}' }, 5_000, "amboss");
  assert.equal(amboss.status, 200);
  assert.equal(web.seen.at(-1)?.method, "POST");
  assert.equal(web.seen.at(-1)?.body, '{"query":"{ x — ü }"}');
  // With its length (in bytes), as fetch sends it — not chunked, which some gateways refuse.
  assert.deepEqual([web.seen.at(-1)?.contentLength, web.seen.at(-1)?.transferEncoding], [String(Buffer.byteLength('{"query":"{ x — ü }"}')), undefined]);
  assert.equal(fetchMock.requests.length, 1, "nothing more went direct");

  setOutboundRouting({ route: "direct" });
  assert.deepEqual([viaTor("lnplus"), viaTor("price")], [false, false]);
  // Without a proxy nothing can go through Tor, whatever the setting.
  setOutboundRouting({ proxy: null, route: "all" });
  assert.equal(viaTor("lnplus"), false);
});

test("TLS through the tunnel: the destination's certificate is checked against ITS name (sent as SNI) — an untrusted one, or one for another name, fails", async (t) => {
  restoreRouting(t);
  // A name that isn't "localhost": TLS falls back to "localhost" (or the
  // proxy's address) when it is not told the destination's name — a
  // "localhost" certificate would pass that way too.
  const cert = testCert(t, "lookup.test");
  if (!cert) {
    t.skip("openssl is not available to make a test certificate");
    return;
  }
  const web = await webServer(t, cert);
  const socks = await socksServer(t, () => web.port); // every name → the local server
  setOutboundRouting({ proxy: socks.proxy, route: "lookups", tlsCa: cert.cert });
  const res = await httpRequest(`https://lookup.test:${web.port}/api/v1/prices`, {}, 5_000, "price");
  assert.equal(res.status, 200);
  assert.equal((await res.json<{ USD: number }>()).USD, 67_000);
  assert.deepEqual(socks.asked.at(-1), { host: "lookup.test", port: web.port });
  assert.equal(web.seen.at(-1)?.host, `lookup.test:${web.port}`);
  // Another name behind the same certificate: refused.
  await assert.rejects(httpRequest(`https://other.test:${web.port}/api/v1/prices`, {}, 5_000, "price"), /altnames|not in the cert|hostname|certificate/i);
  // The system's CAs don't trust it: refused, not sent.
  setOutboundRouting({ tlsCa: undefined });
  await assert.rejects(httpRequest(`https://lookup.test:${web.port}/api/v1/prices`, {}, 5_000, "price"), /self[- ]signed|certificate/i);
  assert.equal(web.seen.length, 1);
});

test("no quiet fallback: with the proxy down a Tor-routed lookup fails — it never goes out directly — and a proxy that never answers runs into the request's deadline", async (t) => {
  restoreRouting(t);
  const fetchMock = installFetchMock(t);
  // A port nothing listens on.
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  setOutboundRouting({ proxy: { host: "127.0.0.1", port: deadPort }, route: "lookups" });
  await assert.rejects(httpRequest("http://lightningnetwork.plus/api/2/get_swaps/", {}, 5_000, "lnplus"), /Tor proxy 127\.0\.0\.1:\d+ unreachable/);
  assert.equal(fetchMock.requests.length, 0, "nothing went out directly");

  const mute = await socksServer(t, () => 1, { mute: true });
  setOutboundRouting({ proxy: mute.proxy });
  const started = Date.now();
  await assert.rejects(httpRequest("http://lightningnetwork.plus/api/2/get_swaps/", {}, 300, "lnplus"), (err) => err instanceof HttpTimeoutError);
  assert.ok(Date.now() - started < 3_000, "bounded by the deadline");
});

test("LN+ can be switched off: no LN+ request at all — the views say so — and the privacy card lists where the app's lookups go and by which route", async (t) => {
  restoreRouting(t);
  // The fetch mock fails the test on any request nobody routed: an LN+ call
  // would be one.
  installFetchMock(t);
  const api = await startApi(t);
  const off = await api.request("POST", "/settings", { lnplusLookups: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.lnplusLookups, false);
  const status = await api.request("GET", "/lnplus/status");
  assert.deepEqual([status.status, status.body.enabled, status.body.onLnPlus], [200, false, false]);
  const pool = await api.request("GET", "/lnplus/pool");
  assert.deepEqual([pool.status, pool.body.error], [409, "lnplus_off"]);
  assert.equal((await api.request("GET", "/lnplus/swaps")).status, 409);
  assert.equal((await api.request("POST", "/settings", { lnplusLookups: "no" })).status, 400);
  assert.equal((await api.request("POST", "/settings", { torRoute: "sometimes" })).status, 400);

  const privacy = await api.request("GET", "/privacy");
  assert.equal(privacy.body.torProxy, null, "no proxy in this environment: everything goes direct, and the card says so");
  assert.deepEqual(
    (privacy.body.destinations as { service: string; active: boolean; viaTor: boolean }[]).map((d) => [d.service, d.active, d.viaTor]),
    [
      ["Amboss (api.amboss.space, magma.amboss.tech)", true, false],
      ["lightningnetwork.plus", false, false],
      ["mempool.space", false, false],
      ["the service-fee lightning address", true, false],
    ],
  );
  // With Umbrel's proxy: LN+ and price through Tor; "all" adds Amboss.
  setOutboundRouting({ proxy: { host: "10.21.21.11", port: 9050 } });
  await api.request("POST", "/settings", { lnplusLookups: true, torRoute: "all" });
  const withTor = await api.request("GET", "/privacy");
  assert.equal(withTor.body.torProxy, "10.21.21.11:9050");
  assert.ok((withTor.body.destinations as { viaTor: boolean }[]).every((d) => d.viaTor));
});

// Review 2 of P4: SECURITY.md promised "Nothing else leaves your node" while
// the Privacy card listed LN+ (on by default) and Amboss (with or without a
// key). Every destination the card lists is in the policy, and the card's
// Amboss line says what the public book sends: this node's own key.
test("SECURITY.md names every destination the Privacy card lists — and the card says Amboss gets the node's own public key too", async (t) => {
  restoreRouting(t);
  installFetchMock(t);
  const api = await startApi(t);
  const destinations = (await api.request("GET", "/privacy")).body.destinations as { service: string; what: string }[];
  const security = readFileSync(new URL("../../SECURITY.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  for (const d of destinations) {
    const hosts = d.service.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/g) ?? [];
    for (const host of hosts) assert.ok(security.includes(host), `SECURITY.md names ${host}`);
    if (hosts.length === 0) assert.ok(security.toLowerCase().includes(d.service.replace(/^the /, "").toLowerCase()), `SECURITY.md names ${d.service}`);
  }
  const amboss = destinations.find((d) => d.service.startsWith("Amboss"));
  assert.match(amboss?.what ?? "", /your own node's public seller score included \(by its public key\), with or without a key/);
});
