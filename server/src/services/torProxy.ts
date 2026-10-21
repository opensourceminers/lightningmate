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
  const host = (env.TOR_PROXY_IP ?? "").trim();
  const port = Number((env.TOR_PROXY_PORT ?? "").trim());
  if (!host || !/^[a-z0-9.:-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
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

/** What a response through the proxy carries (the body read in full). */
export interface ProxiedResponse {
  status: number;
  headers: Headers;
  body: string;
}

/** Redirects a GET follows through the proxy (fetch follows them too). */
const MAX_REDIRECTS = 3;

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
    const req = http.request(
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
        r.on("data", (c: Buffer) => chunks.push(c));
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
    return socksFetch(new URL(res.location, u).toString(), init, proxy, signal, tlsCa, redirects + 1);
  }
  return { status: res.status, headers: res.headers, body: res.body };
}
