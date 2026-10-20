import type { AfterHook } from "./tmp.js";

/**
 * Intercepts `globalThis.fetch` so no test can ever reach a real service
 * (Amboss, LN+, mempool.space, an LNURL server …).
 *
 *   const http = installFetchMock(t);
 *   http.onGraphql("https://api.amboss.space/graphql", "getOffers", () => ({ data: { getOffers: { list: [] } } }));
 *   http.on("https://example.com/.well-known/lnurlp/fee", () => ({ tag: "payRequest", … }));
 *   … run code …
 *   assert.equal(http.mutations.length, 0);
 *
 * - Routes match by URL (exact string, RegExp or predicate); GraphQL routes
 *   additionally match a substring/RegExp of the query text.
 * - A handler may return a `Response`, a plain object (sent as JSON 200), or a
 *   promise of either. `hang()` returns a response that never arrives but
 *   honours the request's AbortSignal — the way to test timeouts;
 *   `stalledBody()` does the same for a body that stops after the headers.
 * - Every request is recorded (`requests`); GraphQL mutations also land in
 *   `mutations`, so a test can prove which state-changing calls were made.
 * - An UNMATCHED request rejects like a network error and is recorded in
 *   `unmatched`; the after-hook then fails the test, because code under test
 *   often swallows network errors and would otherwise hide a live call.
 * - Loopback URLs are blocked too unless `allowLocalhost()` is called (for
 *   tests that run a real local HTTP server).
 */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  /** Parsed GraphQL envelope when the body is `{ query, variables }`. */
  graphql?: { query: string; variables?: Record<string, unknown>; isMutation: boolean };
  /** The AbortSignal the caller passed — lets tests assert a timeout is wired. */
  signal: AbortSignal | null;
}

type HandlerResult = Response | Record<string, unknown> | unknown[];
export type FetchHandler = (req: RecordedRequest) => HandlerResult | Promise<HandlerResult>;
type UrlMatcher = string | RegExp | ((req: RecordedRequest) => boolean);

interface Route {
  url: UrlMatcher;
  query?: string | RegExp;
  handler: FetchHandler;
}

export interface FetchMock {
  /** Route requests by URL. */
  on(url: UrlMatcher, handler: FetchHandler): FetchMock;
  /** Route GraphQL requests by endpoint URL + query text. The handler gets the
   *  variables and returns the response body (usually `{ data: … }`). */
  onGraphql(
    url: string,
    query: string | RegExp,
    handler: (variables: Record<string, unknown>, req: RecordedRequest) => HandlerResult | Promise<HandlerResult>,
  ): FetchMock;
  /** Let http://127.0.0.1 / localhost requests through to the real fetch. */
  allowLocalhost(): FetchMock;
  readonly requests: RecordedRequest[];
  readonly mutations: RecordedRequest[];
  readonly unmatched: RecordedRequest[];
  /** Put the real fetch back (done automatically by the after-hook). */
  restore(): void;
}

/** Runs `onAbort` once the caller aborts, and keeps the event loop alive until
 *  then. A stalled real request holds its socket open; a mocked one holds
 *  nothing, and the timer behind AbortSignal.timeout() is unref'd — without the
 *  keep-alive the loop runs empty before the deadline and node:test cancels the
 *  test instead of letting the timeout fire. */
function untilAborted(signal: AbortSignal, onAbort: () => void): void {
  if (signal.aborted) {
    onAbort();
    return;
  }
  const keepAlive = setInterval(() => {}, 1_000);
  signal.addEventListener(
    "abort",
    () => {
      clearInterval(keepAlive);
      onAbort();
    },
    { once: true },
  );
}

/** A response that never arrives — but rejects when the caller aborts, exactly
 *  like a stalled server. Use it to prove a timeout fires. */
export function hang(req: RecordedRequest): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = req.signal;
    if (!signal) return; // no signal: hangs forever (the bug a timeout fixes)
    untilAborted(signal, () => reject(signal.reason));
  });
}

/** Headers that arrive, then a body that never does — but errors when the
 *  caller aborts, like a server that stalls mid-response. Use it to prove a
 *  deadline also covers reading the body. */
export function stalledBody(req: RecordedRequest): Response {
  const signal = req.signal;
  const body = new ReadableStream({
    start(controller) {
      if (!signal) return; // no signal: stalls forever
      untilAborted(signal, () => controller.error(signal.reason));
    },
  });
  return new Response(body, { status: 200 });
}

function headersToRecord(h: RequestInit["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function matchesUrl(m: UrlMatcher, req: RecordedRequest): boolean {
  if (typeof m === "string") return req.url === m;
  if (m instanceof RegExp) return m.test(req.url);
  return m(req);
}

function matchesQuery(q: string | RegExp | undefined, req: RecordedRequest): boolean {
  if (q === undefined) return true;
  const text = req.graphql?.query ?? "";
  return typeof q === "string" ? text.includes(q) : q.test(text);
}

const isLoopback = (url: string): boolean => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?\//i.test(url);

export function installFetchMock(t?: AfterHook): FetchMock {
  const realFetch = globalThis.fetch;
  const routes: Route[] = [];
  const requests: RecordedRequest[] = [];
  const mutations: RecordedRequest[] = [];
  const unmatched: RecordedRequest[] = [];
  let passLocalhost = false;
  let restored = false;

  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (passLocalhost && isLoopback(url)) return realFetch(input, init);
    const body = typeof init?.body === "string" ? init.body : undefined;
    const req: RecordedRequest = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers: headersToRecord(init?.headers),
      body,
      signal: init?.signal ?? null,
    };
    if (body) {
      try {
        const parsed = JSON.parse(body) as { query?: unknown; variables?: Record<string, unknown> };
        if (typeof parsed.query === "string") {
          req.graphql = {
            query: parsed.query,
            variables: parsed.variables,
            isMutation: /^\s*mutation\b/.test(parsed.query),
          };
        }
      } catch {
        // not JSON — a plain body
      }
    }
    requests.push(req);
    if (req.graphql?.isMutation) mutations.push(req);

    const route = routes.find((r) => matchesUrl(r.url, req) && matchesQuery(r.query, req));
    if (!route) {
      unmatched.push(req);
      throw new TypeError(`fetchMock: unexpected outbound request ${req.method} ${url}`);
    }
    const result = await route.handler(req);
    return result instanceof Response ? result : Response.json(result);
  };

  globalThis.fetch = fake as typeof fetch;

  const mock: FetchMock = {
    on(url, handler) {
      routes.push({ url, handler });
      return mock;
    },
    onGraphql(url, query, handler) {
      routes.push({
        url,
        query,
        handler: (req) => handler(req.graphql?.variables ?? {}, req),
      });
      return mock;
    },
    allowLocalhost() {
      passLocalhost = true;
      return mock;
    },
    requests,
    mutations,
    unmatched,
    restore() {
      if (restored) return;
      restored = true;
      globalThis.fetch = realFetch;
    },
  };

  t?.after(() => {
    mock.restore();
    if (unmatched.length > 0) {
      throw new Error(
        `fetchMock: ${unmatched.length} unexpected outbound request(s): ` +
          unmatched.map((r) => `${r.method} ${r.url}`).join(", "),
      );
    }
  });
  return mock;
}
