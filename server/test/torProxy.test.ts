/**
 * LightningMate's own lookups and the node's Tor-only policy (review
 * a3-channels:lnplus-clearnet-lookups — package P4).
 *
 * Before, every LN+ request (this node's own pubkey included), the BTC price
 * and Amboss went out over the home internet connection with no way to change
 * it, and Settings claimed the price lookup was "the only outbound request".
 * Now, where Umbrel hands the app its Tor proxy (TOR_PROXY_IP/PORT), the
 * lookups go through it — every one of them since 0.8.5, the Amboss calls
 * made with the API key and the fee lookup too (up to 0.8.4 the operator
 * chose a route, and those two went direct by default) — a SOCKS5 client on
 * Node's own modules, the
 * destination resolved by the proxy, TLS checked as usual, the same deadline,
 * and never a quiet fallback to a direct connection — and LN+ can be switched
 * off. These tests run a local SOCKS5 server (what Tor would be) in front of
 * local HTTP/HTTPS servers (what the services would be).
 */
import { test, type TestContext } from "node:test";
import { clearNodeLookupCache, lookupPublicNode } from "../src/services/nodeLookup.js";
import { getBtcPrice } from "../src/services/price.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { join, sep } from "node:path";
import { HttpTimeoutError, httpRequest, logRouting, mempoolBase, routingLine, setOutboundRouting, torVia, viaTor } from "../src/services/http.js";
import { getNode as lnplusNode } from "../src/services/lnplus.js";
import { fetchFeeInvoice } from "../src/services/serviceFee.js";
import { ambossGql } from "../src/services/amboss.js";
import { __resetEligibilityCache } from "../src/services/magmaEligibility.js";
import { readTorProxyEnv, socksFetch, socksResolve, torProxyFromEnv } from "../src/services/torProxy.js";
import { socksResolver } from "./helpers/socksResolver.js";
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
    authorization: string | undefined;
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
        authorization: req.headers.authorization,
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

const restoreRouting = (t: TestContext) => t.after(() => setOutboundRouting({ proxy: null, fault: null, tlsCa: undefined }));

test("Umbrel's Tor proxy is read from TOR_PROXY_IP / TOR_PROXY_PORT — nothing else counts", () => {
  assert.deepEqual(torProxyFromEnv({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "9050" }), { host: "10.21.21.11", port: 9050 });
  assert.equal(torProxyFromEnv({}), null);
  assert.equal(torProxyFromEnv({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "nope" }), null);
  assert.equal(torProxyFromEnv({ TOR_PROXY_IP: "x; rm -rf", TOR_PROXY_PORT: "9050" }), null);
});

test("SEC-1: a proxy value given and unusable is named as the fault it is — not passed over as 'no proxy'", () => {
  assert.deepEqual(readTorProxyEnv({}), { proxy: null, fault: null });
  assert.deepEqual(readTorProxyEnv({ TOR_PROXY_IP: " ", TOR_PROXY_PORT: "" }), { proxy: null, fault: null });
  assert.deepEqual(readTorProxyEnv({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "9050" }), { proxy: { host: "10.21.21.11", port: 9050 }, fault: null });
  const fault = (env: NodeJS.ProcessEnv) => readTorProxyEnv(env).fault;
  assert.equal(fault({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "nope" }), 'TOR_PROXY_PORT "nope" is no port number (1–65535)');
  for (const port of ["0", "65536", "9050x", "-1", "90.5", "0x2352"]) {
    assert.equal(fault({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: port }), `TOR_PROXY_PORT "${port}" is no port number (1–65535)`, port);
  }
  assert.equal(fault({ TOR_PROXY_IP: "x; rm -rf", TOR_PROXY_PORT: "9050" }), 'TOR_PROXY_IP "x; rm -rf" is no host name or address');
  assert.equal(fault({ TOR_PROXY_IP: "10.21.21.11" }), 'TOR_PROXY_IP is set ("10.21.21.11") but TOR_PROXY_PORT is not');
  assert.equal(fault({ TOR_PROXY_PORT: "9050" }), 'TOR_PROXY_PORT is set ("9050") but TOR_PROXY_IP is not');
  assert.equal(fault({ TOR_PROXY_IP: "a".repeat(60), TOR_PROXY_PORT: "x" }), 'TOR_PROXY_PORT "x" is no port number (1–65535)');
  assert.equal(fault({ TOR_PROXY_IP: "a;".repeat(30), TOR_PROXY_PORT: "9050" }), `TOR_PROXY_IP "${"a;".repeat(20)}…" is no host name or address`, "a long value is cut");
});

test("SEC-1: the start's line says the route in force — through Tor by which proxy, direct with no proxy given, direct and the fault with a faulty one (a warning)", () => {
  const said = (env: NodeJS.ProcessEnv) => {
    const lines: { level: string; line: string }[] = [];
    logRouting(readTorProxyEnv(env), { log: (l: string) => lines.push({ level: "log", line: l }), warn: (l: string) => lines.push({ level: "warn", line: l }) });
    return lines;
  };
  assert.deepEqual(said({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "9050" }), [
    { level: "log", line: "   Outbound requests: through Tor: every outbound request goes through the SOCKS5 proxy 10.21.21.11:9050 (TOR_PROXY_IP / TOR_PROXY_PORT)" },
  ]);
  assert.deepEqual(said({}), [
    {
      level: "log",
      line: "   Outbound requests: direct, from this server's internet connection — no Tor proxy is given (TOR_PROXY_IP / TOR_PROXY_PORT are not set; on Umbrel the app's compose file passes them)",
    },
  ]);
  assert.deepEqual(said({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "90 50" }), [
    {
      level: "warn",
      line:
        "   Outbound requests: direct, from this server's internet connection — the Tor proxy setting is faulty: " +
        'TOR_PROXY_PORT "90 50" is no port number (1–65535). Fix TOR_PROXY_IP / TOR_PROXY_PORT in the app\'s environment for the requests to go through Tor',
    },
  ]);
  // The start says it once, after the listen line.
  const index = readFileSync(join(import.meta.dirname, "../src/index.ts"), "utf8");
  assert.match(index, /console\.log\(`   LND socket: [^\n]+\n\s+\/\/[^\n]+\n\s+logRouting\(\);/);
  // The routing is read from the environment once, when http.ts loads.
  const httpSrc = readFileSync(join(import.meta.dirname, "../src/services/http.ts"), "utf8");
  assert.match(httpSrc, /^let routing: OutboundRouting = readTorProxyEnv\(\);$/m);
});

test("SEC-1: GET /privacy says the route in force — with a valid proxy, with none, with a faulty one", async (t) => {
  restoreRouting(t);
  const api = await startApi(t);
  const at = async (env: NodeJS.ProcessEnv) => {
    setOutboundRouting({ ...readTorProxyEnv(env) });
    return (await api.request("GET", "/privacy")).body as { torProxy: string | null; torProxyFault: string | null; route: string; destinations: { viaTor: boolean }[] };
  };
  const tor = await at({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "9050" });
  assert.deepEqual([tor.torProxy, tor.torProxyFault], ["10.21.21.11:9050", null]);
  assert.equal(tor.route, routingLine({ proxy: { host: "10.21.21.11", port: 9050 } }));
  assert.match(tor.route, /^through Tor: every outbound request goes through the SOCKS5 proxy 10\.21\.21\.11:9050/);
  assert.ok(tor.destinations.every((d) => d.viaTor));
  const none = await at({});
  assert.deepEqual([none.torProxy, none.torProxyFault], [null, null]);
  assert.match(none.route, /^direct, from this server's internet connection — no Tor proxy is given/);
  assert.ok(none.destinations.every((d) => !d.viaTor));
  const faulty = await at({ TOR_PROXY_IP: "10.21.21.11", TOR_PROXY_PORT: "nope" });
  assert.deepEqual([faulty.torProxy, faulty.torProxyFault], [null, 'TOR_PROXY_PORT "nope" is no port number (1–65535)']);
  assert.match(faulty.route, /the Tor proxy setting is faulty: TOR_PROXY_PORT "nope" is no port number/);
  assert.ok(faulty.destinations.every((d) => !d.viaTor), "said as direct: it is");
});

test("SEC-1: LN+ and the service fee's LNURL lookup take the proxy when there is one — through the services' own calls, none goes direct", async (t) => {
  restoreRouting(t);
  const web = await webServer(t);
  const socks = await socksServer(t, () => web.port);
  const fetchMock = installFetchMock(t);
  setOutboundRouting({ proxy: socks.proxy });
  // (Plain http behind the tunnel: the https calls fail at TLS — what counts
  // is where they went.)
  await lnplusNode("02" + "ab".repeat(32)).catch(() => undefined);
  await fetchFeeInvoice("fee@fees.example", 21).catch(() => undefined);
  assert.deepEqual(socks.asked, [
    { host: "lightningnetwork.plus", port: 443 },
    { host: "fees.example", port: 443 },
  ]);
  assert.equal(fetchMock.requests.length, 0, "nothing went direct");
});

test("SEC-1: no request goes around the proxy — only http.ts calls fetch, only torProxy.ts opens sockets, and the one DNS lookup is lsps1's proxy-less fallback", () => {
  const src = join(import.meta.dirname, "../src");
  // Every source file, tracked or not (R1-18: git's list missed a new one).
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.split(sep).join("/"));
  assert.ok(files.length > 50, "the sources were listed");
  const hits = (re: RegExp) => files.filter((f) => re.test(readFileSync(join(src, f), "utf8"))).sort();
  assert.deepEqual(hits(/(?<![.\w])fetch\(|globalThis\.fetch|\bundici\b/), ["services/http.ts"]);
  assert.deepEqual(hits(/^import (?!type )[^\n]*from "(node:)?(net|tls|https?|http2|dgram)"/m), ["services/torProxy.ts"]);
  assert.deepEqual(hits(/from "(node:)?dns/), ["services/lsps1.ts"]);
  assert.match(readFileSync(join(src, "services/lsps1.ts"), "utf8"), /if \(proxy\) return socksResolve\(proxy, host\);/, "the DNS lookup only without a proxy");
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

test("mempool.space leaves Tor exits unanswered: through Tor the price and a node's record ask its onion service, without a proxy its website", async (t) => {
  restoreRouting(t);
  clearNodeLookupCache();
  const web = await webServer(t);
  const socks = await socksServer(t, () => web.port);
  installFetchMock(t);
  setOutboundRouting({ proxy: socks.proxy });
  const onion = "mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion";
  await getBtcPrice("CHF");
  await lookupPublicNode("02" + "ab".repeat(32));
  assert.deepEqual(socks.asked, [
    { host: onion, port: 80 },
    { host: onion, port: 80 },
  ]);
  assert.deepEqual(web.seen.map((s) => s.host), [onion, onion]);
  assert.equal(mempoolBase(), `http://${onion}`);
  setOutboundRouting({ proxy: null });
  assert.equal(mempoolBase(), "https://mempool.space");
});

test("with a proxy every request goes through Tor — LN+, the price, Amboss with and without the API key, the fee lookup — and none goes direct; without one, every request goes direct", async (t) => {
  restoreRouting(t);
  const web = await webServer(t);
  const socks = await socksServer(t, () => web.port);
  const fetchMock = installFetchMock(t);
  fetchMock.on("http://api.amboss.example/graphql", () => ({ data: {} }));
  setOutboundRouting({ proxy: socks.proxy });
  assert.equal(viaTor(), true);
  const lnplus = await httpRequest("http://lightningnetwork.plus/api/2/get_swaps/", { headers: { Accept: "application/json" } }, 5_000);
  assert.equal(lnplus.status, 200);
  assert.equal((await lnplus.json<{ path: string }>()).path, "/api/2/get_swaps/");
  // A read without the key — the public book, this node's own seller score
  // by its public key. Review of P4: it went direct, so a node with no Amboss
  // key linked its home IP to its key at Amboss.
  await ambossGql("http://api.amboss.example/graphql", "query { x }").catch(() => undefined);
  // A call with the key (the offers, the orders), through Tor too. Up to
  // 0.8.4 it went direct by default: on 2026-10-24 a provider's block of
  // Amboss's addresses cut the Magma lane off while Tor reached Amboss.
  await ambossGql("http://api.amboss.example/graphql", "query { x }", "the-key").catch(() => undefined);
  assert.deepEqual(socks.asked.map((a) => a.host), ["lightningnetwork.plus", "api.amboss.example", "api.amboss.example"]);
  assert.equal(web.seen.at(-1)?.authorization, "Bearer the-key", "the key went through the tunnel");
  const amboss = await httpRequest("http://api.amboss.example/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"query":"{ x — ü }"}' }, 5_000);
  assert.equal(amboss.status, 200);
  assert.equal(web.seen.at(-1)?.method, "POST");
  assert.equal(web.seen.at(-1)?.body, '{"query":"{ x — ü }"}');
  // With its length (in bytes), as fetch sends it — not chunked, which some gateways refuse.
  assert.deepEqual([web.seen.at(-1)?.contentLength, web.seen.at(-1)?.transferEncoding], [String(Buffer.byteLength('{"query":"{ x — ü }"}')), undefined]);
  assert.equal(fetchMock.requests.length, 0, "nothing went direct");

  // Without a proxy (outside Umbrel) every request goes direct.
  setOutboundRouting({ proxy: null });
  assert.equal(viaTor(), false);
  await ambossGql("http://api.amboss.example/graphql", "query { x }", "the-key");
  assert.deepEqual(fetchMock.requests.map((r) => r.url), ["http://api.amboss.example/graphql"]);
  assert.equal(fetchMock.requests[0].headers.authorization, "Bearer the-key");
  assert.equal(socks.asked.length, 4, "the proxy saw no more");
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
  setOutboundRouting({ proxy: socks.proxy, tlsCa: cert.cert });
  const res = await httpRequest(`https://lookup.test:${web.port}/api/v1/prices`, {}, 5_000);
  assert.equal(res.status, 200);
  assert.equal((await res.json<{ USD: number }>()).USD, 67_000);
  assert.deepEqual(socks.asked.at(-1), { host: "lookup.test", port: web.port });
  assert.equal(web.seen.at(-1)?.host, `lookup.test:${web.port}`);
  // Another name behind the same certificate: refused.
  await assert.rejects(httpRequest(`https://other.test:${web.port}/api/v1/prices`, {}, 5_000), /altnames|not in the cert|hostname|certificate/i);
  // The system's CAs don't trust it: refused, not sent.
  setOutboundRouting({ tlsCa: undefined });
  await assert.rejects(httpRequest(`https://lookup.test:${web.port}/api/v1/prices`, {}, 5_000), /self[- ]signed|certificate/i);
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
  setOutboundRouting({ proxy: { host: "127.0.0.1", port: deadPort } });
  await assert.rejects(httpRequest("http://lightningnetwork.plus/api/2/get_swaps/", {}, 5_000), /Tor proxy 127\.0\.0\.1:\d+ unreachable/);
  assert.equal(fetchMock.requests.length, 0, "nothing went out directly");

  const mute = await socksServer(t, () => 1, { mute: true });
  setOutboundRouting({ proxy: mute.proxy });
  const started = Date.now();
  await assert.rejects(httpRequest("http://lightningnetwork.plus/api/2/get_swaps/", {}, 300), (err) => err instanceof HttpTimeoutError);
  assert.ok(Date.now() - started < 3_000, "bounded by the deadline");
});

test("LN+ can be switched off: no LN+ request at all — the views say so — and the privacy card lists where the app's lookups go: through Tor, every one, with a proxy", async (t) => {
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
  // No route to choose any more: an old client's "Direct" changes nothing.
  const old = await api.request("POST", "/settings", { torRoute: "direct" });
  assert.equal(old.status, 200);
  assert.equal("torRoute" in old.body, false);

  const privacy = await api.request("GET", "/privacy");
  assert.equal(privacy.body.torProxy, null, "no proxy in this environment: everything goes direct, and the card says so");
  const rows = (b: { destinations: { service: string; active: boolean; viaTor: boolean }[] }) => b.destinations.map((d) => [d.service, d.active, d.viaTor]);
  assert.deepEqual(rows(privacy.body), [
    ["Amboss public market data (api.amboss.space, magma.amboss.tech)", true, false],
    ["Amboss account (magma.amboss.tech)", false, false],
    ["lightningnetwork.plus", false, false],
    ["mempool.space", false, false],
    ["mempool.space", true, false],
    ["the service-fee lightning address", true, false],
  ]);
  // With Umbrel's proxy every one goes through Tor — the account calls (with
  // a key) and the fee lookup too (up to 0.8.4: direct by default).
  setOutboundRouting({ proxy: { host: "10.21.21.11", port: 9050 } });
  api.amboss.setKey("test-key");
  await api.request("POST", "/settings", { lnplusLookups: true });
  const withTor = await api.request("GET", "/privacy");
  assert.equal(withTor.body.torProxy, "10.21.21.11:9050");
  assert.equal("torRoute" in withTor.body, false);
  assert.deepEqual(rows(withTor.body).map(([service, , tor]) => [service, tor]), [
    ["Amboss public market data (api.amboss.space, magma.amboss.tech)", true],
    ["Amboss account (magma.amboss.tech)", true],
    ["lightningnetwork.plus", true],
    ["mempool.space", true],
    ["mempool.space", true],
    ["the service-fee lightning address", true],
  ]);
  assert.equal(withTor.body.destinations[1].active, true, "with a key the account calls are made");
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
  const amboss = destinations.find((d) => d.service.startsWith("Amboss public"));
  assert.match(amboss?.what ?? "", /your own node's public seller score included \(by its public key\), read without your API key/);
  // Every trigger of the own-key lookup is named — the Overview's lease
  // benchmark too (review of P4: it was missing).
  assert.match(security, /by the autopilot's runs, the Market pages and the Overview's lease benchmark/);
});

// Review of P4: where a Tor-routed Amboss read fails, the page says that it
// failed through Tor — never a quiet fallback to direct. (Up to 0.8.4 it
// also named the route setting; there is none any more.)
test("an Amboss read that fails through Tor says so — the selling check, the Overview's benchmark — and nothing goes direct", async (t) => {
  restoreRouting(t);
  __resetEligibilityCache();
  t.after(() => __resetEligibilityCache());
  const fetchMock = installFetchMock(t);
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  setOutboundRouting({ proxy: { host: "127.0.0.1", port: deadPort } });
  assert.equal(torVia(), " through Tor");
  const api = await startApi(t);
  const check = await api.request("GET", "/amboss/eligibility");
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.equal(check.body.verdict, "unknown");
  assert.equal(check.body.reasons[0], "Amboss's public offer book could not be read through Tor — no comparison is possible right now.");
  const benchmark = await api.autopilot.leaseBenchmark();
  assert.equal(benchmark.text, "the Magma market could not be read through Tor — asked again in a few minutes");
  assert.equal(fetchMock.requests.length, 0, "never a quiet fallback to a direct connection");
  setOutboundRouting({ proxy: null });
  assert.equal(torVia(), "", "without a proxy nothing went through Tor: nothing to say");
});

// Review of P4: GET /lnplus/status's viaTor was untested, and the LN+ panel
// said "no Tor proxy" whenever it was false — then also when Umbrel's proxy
// was there and the operator chose "Direct" (a route gone since 0.8.5).
test("GET /lnplus/status: through Tor whenever there is a proxy — and whether there is one at all", async (t) => {
  restoreRouting(t);
  installFetchMock(t); // any LN+ request would fail the test: lookups are off
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
  const deadPort = (closed.address() as AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  const api = await startApi(t);
  await api.request("POST", "/settings", { lnplusLookups: false });
  const status = async () => {
    const r = await api.request("GET", "/lnplus/status");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return [r.body.viaTor, r.body.torProxy];
  };
  assert.deepEqual(await status(), [false, false], "no proxy");
  setOutboundRouting({ proxy: { host: "127.0.0.1", port: deadPort } });
  assert.deepEqual(await status(), [true, true]);
  // An old client asking for "Direct" routes nothing around Tor.
  await api.request("POST", "/settings", { torRoute: "direct" });
  assert.deepEqual(await status(), [true, true]);
});

// Review 2026-11-10 (LSP mode): the one name the app looks up on its own —
// the DDNS name LSP mode once announced — went to the system's resolver
// beside the proxy. Tor's RESOLVE extension asks the Tor network instead.
test("a name is resolved by the Tor proxy (RESOLVE): the name goes to the proxy, its IPv4 address comes back — and a refusal is said in the proxy's words", async (t) => {
  const { proxy, asked } = await socksResolver(t, (name) => (name === "home.example.org" ? "203.0.113.9" : 4));
  assert.equal(await socksResolve(proxy, "home.example.org"), "203.0.113.9");
  await assert.rejects(socksResolve(proxy, "gone.example.org"), /the Tor proxy could not resolve gone\.example\.org: host unreachable/);
  assert.deepEqual(asked, ["home.example.org", "gone.example.org"]);
});

/** A web service behind the test proxy that answers by path: a body of
 *  3 MB, or a redirect to where `?to=` says; and counts its open connections. */
async function trickyServer(t: TestContext) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/big") {
      res.setHeader("Content-Type", "application/json");
      res.end(`"${"x".repeat(3 * 1024 * 1024)}"`);
      return;
    }
    if (u.pathname === "/endless") {
      // An answer that never ends: only the client closing the tunnel stops it.
      res.setHeader("Content-Type", "application/json");
      const chunk = "x".repeat(256 * 1024);
      const timer = setInterval(() => res.write(chunk), 5);
      res.on("close", () => clearInterval(timer));
      return;
    }
    if (u.pathname === "/redirect") {
      res.statusCode = 302;
      res.setHeader("Location", u.searchParams.get("to") ?? "/");
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const open = () => new Promise<number>((r) => server.getConnections((_e, n) => r(n)));
  return { port: (server.address() as AddressInfo).port, open };
}

test("SEC-8: through the proxy an answer larger than 2 MB is refused, not read whole — and a redirect is followed to the same host over https only", async (t) => {
  restoreRouting(t);
  const web = await trickyServer(t);
  const socks = await socksServer(t, () => web.port);
  setOutboundRouting({ proxy: socks.proxy });
  await assert.rejects(httpRequest("http://lightningnetwork.plus/big", {}, 5_000), /the answer from lightningnetwork\.plus is larger than 2 MB — not read/);
  const to = (where: string) => `http://lightningnetwork.plus/redirect?to=${encodeURIComponent(where)}`;
  await assert.rejects(httpRequest(to("http://192.168.1.1:8080/admin"), { headers: { Authorization: "Bearer x" } }, 5_000), /lightningnetwork\.plus redirected to another host \(192\.168\.1\.1:8080\) — not followed/);
  await assert.rejects(httpRequest(to("http://lightningnetwork.plus/other"), {}, 5_000), /redirected to http:\/\/lightningnetwork\.plus — not followed \(https only\)/);
  // An onion service may answer over plain http (Tor encrypts to the service).
  const onion = "mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion";
  const viaOnion = await httpRequest(`http://${onion}/redirect?to=${encodeURIComponent(`http://${onion}/api/v1/prices`)}`, {}, 5_000);
  assert.equal((await viaOnion.json<{ path: string }>()).path, "/api/v1/prices");
  assert.deepEqual(
    socks.asked.map((a) => a.host),
    ["lightningnetwork.plus", "lightningnetwork.plus", "lightningnetwork.plus", onion, onion],
    "the other host was never asked for",
  );
});

test("SEC-8: direct, the same — a body over 2 MB is refused, a redirect to another host or to plain http is not followed", async (t) => {
  restoreRouting(t);
  setOutboundRouting({ proxy: null });
  const fetchMock = installFetchMock(t);
  fetchMock.on("https://mempool.space/api/v1/prices", () => new Response("x".repeat(3 * 1024 * 1024), { status: 200 }));
  fetchMock.on("https://mempool.space/declared", () => new Response("{}", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } }));
  fetchMock.on("https://mempool.space/away", () => new Response(null, { status: 302, headers: { location: "http://192.168.1.1/admin" } }));
  fetchMock.on("https://mempool.space/down", () => new Response(null, { status: 301, headers: { location: "http://mempool.space/x" } }));
  fetchMock.on("https://mempool.space/moved", () => new Response(null, { status: 301, headers: { location: "/api/v1/lightning/nodes/x" } }));
  fetchMock.on("https://mempool.space/api/v1/lightning/nodes/x", () => ({ ok: true }));
  await assert.rejects((await httpRequest("https://mempool.space/api/v1/prices", {}, 5_000)).text(), /larger than 2 MB/);
  await assert.rejects((await httpRequest("https://mempool.space/declared", {}, 5_000)).json(), /larger than 2 MB/);
  await assert.rejects(httpRequest("https://mempool.space/away", {}, 5_000), /redirected to another host \(192\.168\.1\.1\) — not followed/);
  await assert.rejects(httpRequest("https://mempool.space/down", {}, 5_000), /not followed \(https only\)/);
  const moved = await httpRequest("https://mempool.space/moved", {}, 5_000);
  assert.deepEqual(await moved.json(), { ok: true }, "the same host over https: followed");
  assert.ok(!fetchMock.requests.some((r) => r.url.includes("192.168")), "the other host was never asked");
});

test("SEC-7: a header http.request refuses (a line break in the key) leaves no tunnel open through the proxy", async (t) => {
  restoreRouting(t);
  const web = await trickyServer(t);
  const socks = await socksServer(t, () => web.port);
  await assert.rejects(socksFetch("http://lightningnetwork.plus/x", { headers: { Authorization: "Bearer first\nsecond" } }, socks.proxy, new AbortController().signal));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await web.open(), 0, "the tunnel was closed");
  // And the key path: refused before any request, never quoted.
  setOutboundRouting({ proxy: socks.proxy });
  await assert.rejects(ambossGql("http://api.amboss.example/graphql", "query { x }", "sk_first\nSECOND-HALF"), (err: Error) => !err.message.includes("SECOND") && /not one line of printable characters/.test(err.message));
  assert.equal(socks.asked.length, 1, "the malformed key never went out");
});

test("SEC-1 (R1-13): a compose service name with an underscore is a host — not a fault", () => {
  assert.deepEqual(readTorProxyEnv({ TOR_PROXY_IP: "umbrel_tor_proxy_1", TOR_PROXY_PORT: "9050" }), { proxy: { host: "umbrel_tor_proxy_1", port: 9050 }, fault: null });
  assert.match(readTorProxyEnv({ TOR_PROXY_IP: "tor proxy", TOR_PROXY_PORT: "9050" }).fault ?? "", /is no host name or address/);
});

test("SEC-8 (R1-8, M33): through the proxy a redirect to another port of the same host is not followed, and an answer too large closes the tunnel", async (t) => {
  restoreRouting(t);
  const web = await trickyServer(t);
  const socks = await socksServer(t, () => web.port);
  setOutboundRouting({ proxy: socks.proxy });
  await assert.rejects(httpRequest(`http://lightningnetwork.plus/redirect?to=${encodeURIComponent("https://lightningnetwork.plus:8443/admin")}`, {}, 5_000), /redirected to another port \(lightningnetwork\.plus:8443\) — not followed/);
  await assert.rejects(httpRequest("http://lightningnetwork.plus/endless", {}, 5_000), /larger than 2 MB/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await web.open(), 0, "the tunnel of the too-large answer was closed");
});

test("SEC-8 (M16): direct, a real redirect to another host is never asked for — the app follows redirects itself, by its own rule", async (t) => {
  restoreRouting(t);
  setOutboundRouting({ proxy: null });
  const target = await trickyServer(t);
  let asked = 0;
  const other = http.createServer((_q, s) => {
    asked += 1;
    s.end("{}");
  });
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  t.after(() => new Promise<void>((r) => other.close(() => r())));
  const otherPort = (other.address() as AddressInfo).port;
  // 127.0.0.1 → localhost: another host for the rule, the same machine for undici.
  await assert.rejects(
    httpRequest(`http://127.0.0.1:${target.port}/redirect?to=${encodeURIComponent(`http://localhost:${otherPort}/x`)}`, { headers: { Authorization: "Bearer k" } }, 5_000),
    /redirected to another host \(localhost:\d+\) — not followed/,
  );
  assert.equal(asked, 0, "the other host was never asked");
});
