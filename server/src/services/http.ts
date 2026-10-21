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
  const res = await bounded(fetch(url, { ...init, signal }));
  return {
    status: res.status,
    ok: res.ok,
    headers: res.headers,
    json: <T>() => bounded(res.json() as Promise<T>),
    text: () => bounded(res.text()),
  };
}
