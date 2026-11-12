import http from "node:http";
import net from "node:net";
import tls from "node:tls";

/**
 * Third-party lookups through Umbrel's Tor proxy (review
 * a3-channels:lnplus-clearnet-lookups — package P4).
 *
 * The node is Tor-only by policy, but LightningMate's own lookups (LN+ — the
 * node's own pubkey included —, the BTC price, Amboss) went out over the home
 * internet connection: they tie the home IP address to the node. Umbrel hands
 * apps a SOCKS5 Tor proxy (TOR_PROXY_IP / TOR_PROXY_PORT, passed in by the
 * app's docker-compose). Node's fetch can't speak SOCKS, so this is a small
 * SOCKS5 client (RFC 1928: no authentication, CONNECT by host NAME — the
 * proxy resolves it, so no DNS lookup of the destination leaves this host
 * either) with TLS and HTTP/1.1 on top, from Node's own modules. No new
 * dependency for ~150 lines of a stable, 30-year-old protocol.
 *
 * Nothing falls back to a direct connection when Tor fails: a lookup that
 * was to go through Tor fails instead (the callers degrade, as for any outage).
 */

export interface SocksProxy {
  host: string;
  port: number;
}

/** Umbrel's Tor proxy, when the app's environment passes it (null: none). */
export function torProxyFromEnv(env: NodeJS.ProcessEnv = process.env): SocksProxy | null {
  return readTorProxyEnv(env).proxy;
}

/**
 * What the app's environment says about a Tor proxy: the proxy, or none —
 * and when a value is given and unusable, what is wrong with it (`fault`).
 * Before (review 2026-11-10, SEC-1), a malformed TOR_PROXY_PORT passed as
 * "no proxy" without a word, and every request went direct.
 */
export function readTorProxyEnv(env: NodeJS.ProcessEnv = process.env): { proxy: SocksProxy | null; fault: string | null } {
  const rawHost = env.TOR_PROXY_IP;
  const rawPort = env.TOR_PROXY_PORT;
  const host = (rawHost ?? "").trim();
  const portText = (rawPort ?? "").trim();
  if (!host && !portText) return { proxy: null, fault: null };
  const shown = (v: string) => JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  if (!host) return { proxy: null, fault: `TOR_PROXY_PORT is set (${shown(portText)}) but TOR_PROXY_IP is not` };
  if (!portText) return { proxy: null, fault: `TOR_PROXY_IP is set (${shown(host)}) but TOR_PROXY_PORT is not` };
  // (An underscore too: a compose service name like tor_proxy is one.)
  if (!/^[a-z0-9._:-]{1,253}$/i.test(host)) return { proxy: null, fault: `TOR_PROXY_IP ${shown(host)} is no host name or address` };
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return { proxy: null, fault: `TOR_PROXY_PORT ${shown(portText)} is no port number (1–65535)` };
  return { proxy: { host, port }, fault: null };
}

/** RFC 1928 reply codes, in words. */
const REPLY: Record<number, string> = {
  1: "general failure",
  2: "connection not allowed",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/**
 * A TCP connection to `host:port` through the SOCKS5 proxy. The name goes to
 * the proxy as it is (ATYP 3). Rejects on any refusal, on the proxy closing,
 * or when `signal` aborts.
 */
export function socksConnect(proxy: SocksProxy, host: string, port: number, signal?: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const name = Buffer.from(host, "utf8");
    if (name.length === 0 || name.length > 255) {
      reject(new Error(`invalid host name for the Tor proxy: ${host}`));
      return;
    }
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let stage: "greeting" | "connect" = "greeting";
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const fail = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    const onError = (err: Error) => fail(new Error(`Tor proxy ${proxy.host}:${proxy.port} unreachable: ${err.message}`));
    const onClose = () => fail(new Error("the Tor proxy closed the connection"));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("the Tor proxy refused: no acceptable authentication method"));
        buf = buf.subarray(2);
        stage = "connect";
        socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, Buffer.from([port >> 8, port & 0xff])]));
      }
      if (buf.length < 5) return;
      if (buf[0] !== 0x05) return fail(new Error("the Tor proxy answered something other than SOCKS5"));
      if (buf[1] !== 0x00) return fail(new Error(`the Tor proxy could not reach ${host}: ${REPLY[buf[1]] ?? `error ${buf[1]}`}`));
      const atyp = buf[3];
      const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + buf[4] : -1;
      if (addrLen < 0) return fail(new Error("the Tor proxy answered an unknown address type"));
      const total = 4 + addrLen + 2;
      if (buf.length < total) return;
      cleanup();
      // Held until the caller reads (TLS or HTTP speak first; nothing is lost).
      socket.pause();
      if (buf.length > total) socket.unshift(buf.subarray(total));
      resolve(socket);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
  });
}

/**
 * A host name resolved by the Tor proxy — Tor's SOCKS extension RESOLVE
 * (command 0xF0; tor's socks-extensions.txt): the name goes to the proxy,
 * the proxy asks the Tor network, and no DNS lookup leaves this host. The
 * IPv4 address, or a rejection with the proxy's words. For the one name the
 * app ever looks up on its own (the DDNS name LSP mode once announced —
 * lsps1.ts withdrawLegacyClearnet); every request goes by name otherwise.
 */
export function socksResolve(proxy: SocksProxy, host: string, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const name = Buffer.from(host, "utf8");
    if (name.length === 0 || name.length > 255) {
      reject(new Error(`invalid host name for the Tor proxy: ${host}`));
      return;
    }
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let stage: "greeting" | "resolve" = "greeting";
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => fail(new Error(`the Tor proxy did not resolve ${host} within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    const done = () => {
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("close");
      socket.destroy();
    };
    const fail = (err: Error) => {
      done();
      reject(err);
    };
    socket.on("error", (err) => fail(new Error(`Tor proxy ${proxy.host}:${proxy.port} unreachable: ${err.message}`)));
    socket.on("close", () => fail(new Error("the Tor proxy closed the connection")));
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === "greeting") {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("the Tor proxy refused: no acceptable authentication method"));
        buf = buf.subarray(2);
        stage = "resolve";
        socket.write(Buffer.concat([Buffer.from([0x05, 0xf0, 0x00, 0x03, name.length]), name, Buffer.from([0, 0])]));
      }
      if (buf.length < 4) return;
      if (buf[0] !== 0x05) return fail(new Error("the Tor proxy answered something other than SOCKS5"));
      if (buf[1] !== 0x00) return fail(new Error(`the Tor proxy could not resolve ${host}: ${REPLY[buf[1]] ?? `error ${buf[1]}`}`));
      if (buf[3] !== 0x01) return fail(new Error(`the Tor proxy answered no IPv4 address for ${host}`));
      if (buf.length < 10) return;
      const ip = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      done();
      resolve(ip);
    });
    socket.once("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
  });
}

/** What a response through the proxy carries (the body read in full). */
export interface ProxiedResponse {
  status: number;
  headers: Headers;
  body: string;
}

/** Redirects a GET follows (through the proxy and direct alike). */
export const MAX_REDIRECTS = 3;
/** The largest answer read (review 2026-11-10, SEC-8: a 64 MB body was read
 *  whole; every service the app asks answers in kilobytes). */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** The error for an answer larger than MAX_RESPONSE_BYTES. */
export const tooLargeError = (host: string): Error => new Error(`the answer from ${host} is larger than ${MAX_RESPONSE_BYTES / 1024 / 1024} MB — not read`);

/**
 * Whether a redirect from `from` to `to` is followed: to the same host only,
 * over https — or plain http to an onion service, which Tor encrypts end to
 * end (SEC-8: a 302 to a LAN address made the app ask for it, with the same
 * headers). Throws, naming the hop, when it is not.
 */
export function checkRedirect(from: URL, to: URL): void {
  const onion = /\.onion$/i.test(to.hostname);
  // The same host and port (another port is another service: R1-8); a
  // move from http to https on the host's default ports is followed.
  const port = (u: URL): string => u.port || (u.protocol === "https:" ? "443" : "80");
  const samePort = port(to) === port(from) || (from.protocol === "http:" && to.protocol === "https:" && !from.port && !to.port);
  if (to.hostname.toLowerCase() !== from.hostname.toLowerCase()) throw new Error(`${from.host} redirected to another host (${to.host}) — not followed`);
  if (to.protocol !== "https:" && !(to.protocol === "http:" && onion)) throw new Error(`${from.host} redirected to ${to.protocol}//${to.host} — not followed (https only)`);
  if (!samePort) throw new Error(`${from.host} redirected to another port (${to.host}) — not followed`);
}

/**
 * One HTTP(S) request through the SOCKS5 proxy: TLS with the destination's
 * name (SNI, certificate checked against the system's CAs — or `tlsCa`,
 * tests), HTTP/1.1, the whole body read. `signal` bounds everything; the
 * caller (http.ts) turns its deadline into the usual timeout error.
 */
export async function socksFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  proxy: SocksProxy,
  signal: AbortSignal,
  tlsCa?: string | Buffer,
  redirects = 0,
): Promise<ProxiedResponse> {
  const u = new URL(url);
  const secure = u.protocol === "https:";
  if (!secure && u.protocol !== "http:") throw new Error(`unsupported protocol ${u.protocol}`);
  const port = Number(u.port) || (secure ? 443 : 80);
  const raw = await socksConnect(proxy, u.hostname, port, signal);
  const socket: net.Socket = secure
    ? tls.connect({ socket: raw, servername: u.hostname, ALPNProtocols: ["http/1.1"], ...(tlsCa ? { ca: tlsCa } : {}) })
    : raw;
  const headers: Record<string, string> = { Host: u.host, Connection: "close", ...(init.headers ?? {}) };
  // A body goes out with its length, as fetch sends it. Without one, Node
  // sends it chunked (Transfer-Encoding), which some gateways and WAFs refuse
  // for a request — an Amboss GraphQL POST routed through Tor could fail for
  // that alone (review of P4).
  if (init.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(Buffer.byteLength(init.body));
  }
  const res = await new Promise<ProxiedResponse & { location?: string }>((resolve, reject) => {
    let req: http.ClientRequest;
    try {
      req = http.request(
        {
          method: init.method ?? "GET",
          host: u.hostname,
          port,
          path: `${u.pathname}${u.search}`,
          headers,
          createConnection: () => socket,
          signal,
        },
        (r) => {
          const chunks: Buffer[] = [];
          let size = 0;
          r.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) {
              // Read no further: the tunnel goes, the answer is refused.
              socket.destroy();
              raw.destroy();
              reject(tooLargeError(u.host));
              return;
            }
            chunks.push(c);
          });
          r.on("error", reject);
          r.on("end", () => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(r.headers)) {
              if (v === undefined) continue;
              for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
            }
            resolve({ status: r.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8"), location: r.headers.location });
          });
        },
      );
    } catch (err) {
      // A header http.request refuses (a line break in a value): it throws
      // before the request exists — the tunnel was open and must go (SEC-7:
      // one leaked tunnel per attempt).
      socket.destroy();
      raw.destroy();
      reject(err);
      return;
    }
    req.on("error", (err) => {
      socket.destroy();
      reject(err);
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
    // socksConnect handed the tunnel over paused (nothing could be lost
    // before a reader was attached): the TLS layer and the HTTP client read
    // from it now — their listeners are attached first (both on this tick).
    raw.resume();
  });
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" && [301, 302, 303, 307, 308].includes(res.status) && res.location && redirects < MAX_REDIRECTS) {
    const next = new URL(res.location, u);
    checkRedirect(u, next);
    return socksFetch(next.toString(), init, proxy, signal, tlsCa, redirects + 1);
  }
  return { status: res.status, headers: res.headers, body: res.body };
}
