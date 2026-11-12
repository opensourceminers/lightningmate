import { MAX_REDIRECTS, MAX_RESPONSE_BYTES, checkRedirect, readTorProxyEnv, socksFetch, tooLargeError, type SocksProxy } from "./torProxy.js";

/**
 * The one way this app makes outbound HTTP requests (Amboss, LN+, mempool.space,
 * the service-fee LNURL server).
 *
 * Node's fetch (undici) has no overall deadline: it waits up to 5 min for
 * response headers and another 5 min for the body. One stalled Amboss call
 * therefore froze the whole autopilot pass — including the time-critical Magma
 * order lane — for up to ten minutes. Here every request carries a deadline
 * that covers the WHOLE exchange: connecting, headers and reading the body.
 */

/** Per-service deadlines, in one place. Mutable so tests can shrink them. */
export const HTTP_TIMEOUTS = {
  /** Amboss GraphQL reads (offers, orders, history, key checks). */
  ambossQueryMs: 15_000,
  /** Amboss mutations get longer: a timed-out mutation may still have been
   *  applied server-side, so give a slow-but-working Amboss time to answer.
   *  Must stay well below the shutdown wait (shutdown.ts SHUTDOWN_WAIT_MS),
   *  so a mutation in flight at SIGTERM ends — answered or timed out, and
   *  recorded — before the process exits. A timeout is not a guess either:
   *  the Magma order journal re-reads the order from Amboss on the next pass
   *  and acts on what actually happened. */
  ambossMutationMs: 25_000,
  /** The Magma accept alone gets longer still, and is the one call that may
   *  outlast the shutdown wait. On the first live sale (2026-11-11) Amboss
   *  took more than 25 s over the accept ten times in a row — each a
   *  timeout here, each sent again 45 s later — before one answered; the
   *  order had its channel to open 20 minutes late. What makes the longer
   *  wait safe at a stop: the accept's mark (`acceptSentAt`) is on disk
   *  before it goes out, and after a restart the lane reads the order from
   *  Amboss before anything else — it sends the accept again only while the
   *  order still awaits approval, with the same invoice, and takes an accept
   *  Amboss applied as accepted (MagmaDesk.resumeAccept). */
  ambossAcceptMs: 90_000,
  lnplusMs: 10_000,
  /** Through Tor a new circuit to an onion service can take several seconds. */
  priceMs: 20_000,
  /** LNURL-pay lookups for the service fee. */
  lnurlMs: 15_000,
  /** One node's public record, when its details are opened (see priceMs). */
  nodeLookupMs: 20_000,
};

/**
 * Every outbound request goes through Umbrel's Tor proxy when the app has one
 * (TOR_PROXY_IP / TOR_PROXY_PORT): LN+, the BTC price, Amboss — its public
 * market data and the calls made with the API key — and the service-fee
 * LNURL. None leaves from this server's IP address, and none needs a port
 * opened anywhere. Without a proxy (outside Umbrel) every request goes
 * direct, and the Settings page says so.
 *
 * Before (0.8.4), the operator chose a route: "Lookups via Tor", the default,
 * sent the Amboss calls made with the key and the fee lookup direct, and
 * "Direct" sent everything direct. On 2026-10-24 a provider's block of
 * Amboss's addresses (during football matches) cut the direct calls off —
 * "Amboss unreachable" for the offers and the orders, with their deadlines —
 * while Tor reached Amboss in 1.4 s.
 */
export interface OutboundRouting {
  /** Umbrel's Tor proxy (TOR_PROXY_IP / TOR_PROXY_PORT), or null. */
  proxy: SocksProxy | null;
  /** A proxy value given and unusable, in words (null: none, or fine).
   *  Requests then go direct — said at start and in Settings, never
   *  silently (review 2026-11-10, SEC-1 as E5 was changed on 2026-11-12:
   *  Tor first, no fail-closed). */
  fault?: string | null;
  /** Tests only: the CA a proxied TLS connection trusts. */
  tlsCa?: string | Buffer;
}

/** Decided once, when the app starts: from the environment. */
let routing: OutboundRouting = readTorProxyEnv();

/**
 * The route in force, in one line — logged at start and shown in Settings
 * → Privacy: through Tor by which proxy, or direct and why.
 */
export function routingLine(r: Readonly<OutboundRouting> = routing): string {
  if (r.proxy) return `through Tor: every outbound request goes through the SOCKS5 proxy ${r.proxy.host}:${r.proxy.port} (TOR_PROXY_IP / TOR_PROXY_PORT)`;
  if (r.fault) {
    return (
      `direct, from this server's internet connection — the Tor proxy setting is faulty: ${r.fault}. ` +
      "Fix TOR_PROXY_IP / TOR_PROXY_PORT in the app's environment for the requests to go through Tor"
    );
  }
  return "direct, from this server's internet connection — no Tor proxy is given (TOR_PROXY_IP / TOR_PROXY_PORT are not set; on Umbrel the app's compose file passes them)";
}

/** The start's line about the route (index.ts): a faulty proxy setting is a
 *  warning, the rest is said plainly. */
export function logRouting(r: Readonly<OutboundRouting> = routing, log: Pick<Console, "log" | "warn"> = console): void {
  const line = `   Outbound requests: ${routingLine(r)}`;
  if (r.fault && !r.proxy) log.warn(line);
  else log.log(line);
}

/** Change the routing (a test's proxy). */
export function setOutboundRouting(patch: Partial<OutboundRouting>): void {
  routing = { ...routing, ...patch };
}

/** The routing in force (for the Settings page). */
export function outboundRouting(): Readonly<OutboundRouting> {
  return routing;
}

/** Whether outbound requests go through the Tor proxy: all of them, when
 *  there is one. */
export function viaTor(): boolean {
  return !!routing.proxy;
}

/**
 * Said with a lookup that failed: " through Tor" when it went through Tor,
 * else "" — a Tor exit a service refuses is then not taken for the service
 * being down.
 */
export function torVia(): string {
  return viaTor() ? " through Tor" : "";
}

/**
 * Where mempool.space answers. It leaves requests from Tor exits unanswered
 * (measured 2026-11-09: three of three stalled past 45 s, while its onion
 * service answered in 3–8 s), so through Tor its own onion service is asked:
 * plain http is fine there, Tor encrypts to the service itself. Before, the
 * BTC price failed on every Tor install from 0.8.5 on and the fiat figures
 * stayed empty.
 */
export function mempoolBase(): string {
  return viaTor() ? "http://mempoolhqx4isw62xs7abwphsq7ldayuidyx2v2oethdhhj6mlo2r6ad.onion" : "https://mempool.space";
}

export class HttpTimeoutError extends Error {
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`request to ${new URL(url).host} timed out after ${Math.round(timeoutMs / 100) / 10}s`);
    this.name = "HttpTimeoutError";
  }
}

/** A response whose body reads are bound by the same deadline as the request. */
export interface TimedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

/**
 * fetch() with a hard deadline. Rejects with HttpTimeoutError when the server
 * does not answer in time, and the returned body readers reject the same way
 * when the body stalls. Network errors are passed through unchanged.
 */
export async function httpRequest(url: string, init: RequestInit, timeoutMs: number): Promise<TimedResponse> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  // The signal also tells fetch to tear the connection down; the race makes the
  // deadline hold even where a body stream doesn't react to the abort.
  const bounded = <T>(work: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const onDeadline = () => reject(new HttpTimeoutError(url, timeoutMs));
      if (deadline.aborted) {
        onDeadline();
        return;
      }
      deadline.addEventListener("abort", onDeadline, { once: true });
      work.then(
        (value) => {
          deadline.removeEventListener("abort", onDeadline);
          resolve(value);
        },
        (err) => {
          deadline.removeEventListener("abort", onDeadline);
          reject(deadline.aborted ? new HttpTimeoutError(url, timeoutMs) : err);
        },
      );
    });
  if (routing.proxy) {
    // Through the Tor proxy, the same deadline over the whole exchange — and
    // never a quiet fallback to a direct connection.
    const proxied = await bounded(
      socksFetch(
        url,
        {
          method: init.method,
          headers: init.headers as Record<string, string> | undefined,
          body: typeof init.body === "string" ? init.body : undefined,
        },
        routing.proxy,
        signal,
        routing.tlsCa,
      ),
    );
    return {
      status: proxied.status,
      ok: proxied.status >= 200 && proxied.status < 300,
      headers: proxied.headers,
      json: async <T>() => JSON.parse(proxied.body) as T,
      text: async () => proxied.body,
    };
  }
  // Direct: the same rules as through the proxy (SEC-8) — a redirect only to
  // the same host over https, an answer read up to MAX_RESPONSE_BYTES.
  let at = new URL(url);
  let res = await bounded(fetch(url, { ...init, signal, redirect: "manual" }));
  for (let hops = 0; [301, 302, 303, 307, 308].includes(res.status) && (init.method ?? "GET").toUpperCase() === "GET"; hops++) {
    const location = res.headers.get("location");
    if (!location || hops >= MAX_REDIRECTS) break;
    const next = new URL(location, at);
    checkRedirect(at, next);
    await res.body?.cancel().catch(() => undefined);
    at = next;
    res = await bounded(fetch(next.toString(), { ...init, signal, redirect: "manual" }));
  }
  const answer = res;
  const host = at.host;
  let read: Promise<string> | null = null;
  const text = (): Promise<string> => (read ??= bounded(readCapped(answer, host)));
  return {
    status: answer.status,
    ok: answer.ok,
    headers: answer.headers,
    json: async <T>() => JSON.parse(await text()) as T,
    text,
  };
}

/** A response's body as text, refused past MAX_RESPONSE_BYTES (SEC-8). */
async function readCapped(res: Response, host: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLargeError(host);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw tooLargeError(host);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
