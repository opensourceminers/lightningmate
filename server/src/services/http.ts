import { socksFetch, torProxyFromEnv, type SocksProxy } from "./torProxy.js";

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
  lnplusMs: 10_000,
  priceMs: 10_000,
  /** LNURL-pay lookups for the service fee. */
  lnurlMs: 15_000,
};

/** What an outbound request is for — what decides its route.
 *  "amboss_public": an Amboss read made without the API key (the public
 *  market data, this node's own seller score by its public key);
 *  "amboss": a call with the key (offers, orders, purchases). */
export type OutboundPurpose = "amboss" | "amboss_public" | "lnplus" | "price" | "lnurl";

/**
 * Which outbound requests go through the Tor proxy (when one is available):
 *  - "lookups" (default): the third-party lookups that tie this server's IP
 *    to the node — LN+ (its own pubkey included), the BTC price and
 *    Amboss's public market data (this node's own seller score included);
 *  - "all": the Amboss calls made with the API key (offers, orders,
 *    purchases — tied to the Amboss account anyway; their orders have
 *    deadlines, and Tor is slower) and the service-fee LNURL too;
 *  - "direct": nothing (a lookup service that blocks Tor exits).
 * Without a proxy every request goes direct, and the Settings page says so.
 * (Review of P4: under "lookups" the keyless Amboss reads went direct too —
 * a node with no Amboss key linked its home IP to its public key at Amboss
 * about once a day.)
 */
export type TorRoute = "lookups" | "all" | "direct";

export interface OutboundRouting {
  /** Umbrel's Tor proxy (TOR_PROXY_IP / TOR_PROXY_PORT), or null. */
  proxy: SocksProxy | null;
  route: TorRoute;
  /** Tests only: the CA a proxied TLS connection trusts. */
  tlsCa?: string | Buffer;
}

let routing: OutboundRouting = { proxy: torProxyFromEnv(), route: "lookups" };

/** Change the routing (the operator's setting, or a test's proxy). */
export function setOutboundRouting(patch: Partial<OutboundRouting>): void {
  routing = { ...routing, ...patch };
}

/** The routing in force (for the Settings page). */
export function outboundRouting(): Readonly<OutboundRouting> {
  return routing;
}

/** Whether a request for `purpose` goes through the Tor proxy right now. */
export function viaTor(purpose: OutboundPurpose | undefined): boolean {
  if (!routing.proxy || !purpose || routing.route === "direct") return false;
  return routing.route === "all" || purpose === "lnplus" || purpose === "price" || purpose === "amboss_public";
}

/**
 * Said with a lookup that failed: ` through Tor (Settings → Privacy, Tor
 * route "…")` when requests for `purpose` go through Tor now, else "". A Tor
 * exit a service refuses is then not taken for the service being down, and
 * the operator sees which setting decides the route. (The labels are the
 * Settings card's — web/src/privacyView.ts TOR_ROUTES; a web test keeps the
 * two the same.)
 */
export function torVia(purpose: OutboundPurpose): string {
  if (!viaTor(purpose)) return "";
  return ` through Tor (Settings → Privacy, Tor route "${routing.route === "all" ? "Everything via Tor" : "Lookups via Tor"}")`;
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
export async function httpRequest(url: string, init: RequestInit, timeoutMs: number, purpose?: OutboundPurpose): Promise<TimedResponse> {
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
  if (viaTor(purpose) && routing.proxy) {
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
  const res = await bounded(fetch(url, { ...init, signal }));
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    json: <T>() => bounded(res.json() as Promise<T>),
    text: () => bounded(res.text()),
  };
}
