import type { FetchMock } from "./fetchMock.js";
import { makeNodeKey, makePaymentRequest, type NodeKey } from "./bolt11.js";

/**
 * A fake LNURL-pay (LUD-06/16) server for a Lightning Address, served through
 * the fetch mock. It issues REAL signed invoices from `payee`, so the code
 * under test decodes and pays them exactly as it would a live server's.
 *
 *   const fees = mockLnurlPayServer(http, { address: "fees@fees.example" });
 *   fees.requestedMsat   // every amount the client asked an invoice for
 *
 * Misbehaviour for negative tests:
 *   invoiceMsat: (asked) => asked * 1000   // bill far more than asked
 *   invoiceMsat: () => null                // amountless invoice
 *   callback: "https://evil.example/cb"    // metadata points elsewhere
 */
export function mockLnurlPayServer(
  http: FetchMock,
  opts: {
    address: string;
    payee?: NodeKey;
    callback?: string;
    invoiceMsat?: (requestedMsat: number) => number | null;
    minSendable?: number;
    maxSendable?: number;
    /** Clock for invoice creation/expiry (default real time) — pass the same
     *  clock the code under test uses, so invoices don't expire under it. */
    now?: () => number;
  },
): { payee: NodeKey; requestedMsat: number[]; callback: string } {
  const [name, domain] = opts.address.split("@");
  const payee = opts.payee ?? makeNodeKey();
  const callback = opts.callback ?? `https://${domain}/lnurlp/${name}/callback`;
  const requestedMsat: number[] = [];

  http.on(`https://${domain}/.well-known/lnurlp/${name}`, () => ({
    tag: "payRequest",
    callback,
    minSendable: opts.minSendable ?? 1_000,
    maxSendable: opts.maxSendable ?? 100_000_000_000,
    metadata: JSON.stringify([["text/plain", "service fee"]]),
  }));
  http.on(
    (req) => req.url.startsWith(callback),
    (req) => {
      const asked = Number(new URL(req.url).searchParams.get("amount"));
      requestedMsat.push(asked);
      const billed = opts.invoiceMsat ? opts.invoiceMsat(asked) : asked;
      const now = opts.now ? opts.now() : Date.now();
      const { request } = makePaymentRequest({
        key: payee,
        ...(billed === null ? {} : { mtokens: String(billed) }),
        description: "service fee",
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 3_600_000).toISOString(),
      });
      return { pr: request, routes: [] };
    },
  );
  return { payee, requestedMsat, callback };
}
