/**
 * Amboss client: the transport shared by every Amboss call, the public market
 * data, and the buyer side of Magma. Two endpoints, one account API key
 * (`Authorization: Bearer <key>`):
 *  - api.amboss.space  — public market data only: getOffers (offer book with
 *    seller scores) and getMarketMetrics (real fill history). Both are still
 *    current (not deprecated) on that endpoint.
 *  - magma.amboss.tech — everything that acts: buying (liquidity.buy,
 *    market.order.create/cancel) here, and the whole seller side in
 *    magmaApi.ts. Amboss deprecated every legacy seller mutation on
 *    api.amboss.space ("We have now shifted to our Magma API!").
 *
 * Every GraphQL document is an exported constant: server/test/magmaSchema.test.ts
 * checks each one against the saved Magma schema, so a renamed or missing
 * field fails a test instead of a live order.
 */

import { HTTP_TIMEOUTS, HttpTimeoutError, httpRequest, type TimedResponse } from "./http.js";

export const AMBOSS_URL = "https://api.amboss.space/graphql";
export const MAGMA_URL = "https://magma.amboss.tech/graphql";

// ── transport ─────────────────────────────────────────────────────────────────

/**
 * What went wrong talking to Amboss. The distinction matters: only "auth" — a
 * definitive answer that the key is not accepted — may ever mark the key as
 * revoked. A timeout, a network error or an Amboss outage says nothing about
 * the key (before, every one of them read as "expired or revoked" and the UI
 * offered to delete a working key).
 */
export type AmbossErrorKind =
  /** HTTP 401/403, or a GraphQL FORBIDDEN / UNAUTHENTICATED answer. */
  | "auth"
  /** Network error: DNS, connection refused or reset. */
  | "unreachable"
  /** No answer within the deadline (http.ts). */
  | "timeout"
  /** A non-2xx answer without a GraphQL error in it, or a body that isn't JSON. */
  | "http"
  /** Amboss answered with a GraphQL error (validation, business rule, …) —
   *  with HTTP 200, or with the 4xx a GraphQL server sends for a query that
   *  doesn't fit its schema. */
  | "graphql"
  /** A 200 answer without data. */
  | "no_data";

export class AmbossError extends Error {
  constructor(
    readonly kind: AmbossErrorKind,
    message: string,
    /** HTTP status, or the status Amboss reports inside a GraphQL error. */
    readonly status?: number,
    /** GraphQL `extensions.code`, e.g. "FORBIDDEN". */
    readonly code?: string,
  ) {
    super(message);
    this.name = "AmbossError";
  }
}

/** Amboss definitively refused the key (not: Amboss could not be reached). */
export const isAuthError = (err: unknown): boolean => err instanceof AmbossError && err.kind === "auth";

/** The statuses of a server that can't answer right now: an error on its side
 *  (5xx), a request it timed out (408), too many requests (429). */
const outageStatus = (s: number | undefined): boolean => s !== undefined && (s >= 500 || s === 408 || s === 429);

/**
 * Amboss could not be asked at all — says nothing about the request itself:
 * no connection, no answer in time, a server error (5xx), a 408 or a 429, or
 * an answer that can't be read. Any other 4xx is an answer about the request
 * (before, every non-2xx counted as "unreachable": a query Amboss rejected
 * after a schema change turned every lane pass LND-only, under a status that
 * claimed Amboss was down).
 *
 * A GraphQL server reports the same outages inside an HTTP 200 answer too:
 * Amboss's (NestJS/Apollo) puts the status of a failing resolver, or of its
 * rate limiter (429), into the error's `originalError.statusCode`. Those are
 * outages as well — not answers about the order or offer asked about.
 */
export const isTransientAmbossError = (err: unknown): boolean => {
  if (!(err instanceof AmbossError)) return false;
  if (err.kind === "unreachable" || err.kind === "timeout") return true;
  if (err.kind === "graphql") return outageStatus(err.status);
  if (err.kind !== "http") return false;
  return err.status === undefined || outageStatus(err.status);
};

/**
 * Amboss may be down as a whole — the failure says nothing about the request
 * itself: no connection, no answer in time, an outage at the HTTP level (5xx,
 * 408, an answer that can't be read), or Amboss limiting requests (429, at
 * either level). One such failure may still be about one request alone (a
 * resolver slow for one order runs into the deadline while every other read
 * answers), so the order lane weighs it (magmaDesk.ts, unreadable): a listing
 * that fails this way, a rate limit, or a second order read failing this way
 * in one pass turns the rest of the pass to LND alone.
 *
 * A GraphQL error that reports a 5xx or 408 inside an HTTP 200 answer is not
 * that. Amboss answered, at once, about THIS request: a resolver that threw
 * for one order (NestJS puts the 500 of its InternalServerErrorException into
 * originalError.statusCode), while the listing and every other order's read
 * work. Taken as an outage, one such order cut every pass short for all the
 * orders after it: held payments released unopened, new orders left to time
 * out, a confirmed channel's payment released unclaimed. It stays transient
 * (a retry may clear it, and it never means "not found"), but it is that
 * request's error alone.
 */
export const isAmbossOutage = (err: unknown): boolean =>
  isTransientAmbossError(err) && !(err instanceof AmbossError && err.kind === "graphql" && err.status !== 429);

/** Amboss limiting requests (429 — at the HTTP level, or reported inside a
 *  GraphQL answer): a limit holds for every call, not for one request. */
export const isRateLimited = (err: unknown): boolean => err instanceof AmbossError && err.status === 429;

/**
 * Amboss answered, in so many words, that it has no such order (or offer):
 * the GraphQL code NOT_FOUND, the status 404 it reports with the error, or a
 * "not found" message. Anything else — a resolver failing ("Unexpected
 * error."), a rate limit, a query it rejects — says nothing about whether the
 * order exists. (Before, every GraphQL error on an order's read counted as
 * "Amboss no longer knows this order", and one hiccup ended an order Amboss
 * still listed as waiting for approval: it then timed out on the seller.)
 */
export const isNotFoundAnswer = (err: unknown): boolean =>
  err instanceof AmbossError &&
  err.kind === "graphql" &&
  !isTransientAmbossError(err) &&
  !isQueryRejected(err) &&
  (err.code === "NOT_FOUND" || err.status === 404 || /\bnot found\b/i.test(err.message));

/** Codes of a GraphQL server rejecting the document itself. */
const QUERY_REJECTED_CODES = new Set(["GRAPHQL_VALIDATION_FAILED", "GRAPHQL_PARSE_FAILED"]);

/**
 * Amboss rejected the request itself: the query no longer fits its schema
 * (the Magma API changed under this version). Every call of that kind fails
 * the same way until LightningMate is updated — it says nothing about the
 * order or offer asked about.
 */
export const isQueryRejected = (err: unknown): boolean =>
  err instanceof AmbossError &&
  err.kind === "graphql" &&
  ((err.code !== undefined && QUERY_REJECTED_CODES.has(err.code)) || (err.code === undefined && err.status === 400));

const AUTH_CODES = new Set(["FORBIDDEN", "UNAUTHENTICATED", "UNAUTHORIZED"]);

interface GraphqlError {
  message?: string;
  extensions?: { code?: string; status?: unknown; originalError?: { statusCode?: unknown } };
}

/** The HTTP status a GraphQL error reports for itself: NestJS puts the one of
 *  the exception behind it into `originalError.statusCode`, and newer
 *  versions into `extensions.status` as well. */
function statusInside(e: GraphqlError): number | undefined {
  for (const v of [e.extensions?.originalError?.statusCode, e.extensions?.status]) {
    if (typeof v === "number" && Number.isInteger(v)) return v;
  }
  return undefined;
}

function classifyGraphqlError(e: GraphqlError, httpStatus?: number): AmbossError {
  const code = e.extensions?.code;
  const status = statusInside(e) ?? httpStatus;
  const message = e.message || code || "Amboss returned an error";
  // Seen live: an unknown or missing key answers HTTP 200 with
  // {"message":"Forbidden resource","extensions":{"code":"FORBIDDEN",
  //  "originalError":{"statusCode":403}}}.
  if ((code && AUTH_CODES.has(code)) || status === 401 || status === 403) {
    return new AmbossError("auth", message, status ?? 403, code);
  }
  return new AmbossError("graphql", message, status, code);
}

/** The first GraphQL error in a non-2xx answer's body, if it carries one. A
 *  body that can't be read (HTML from a proxy, a stall) carries none. */
async function graphqlErrorIn(res: TimedResponse): Promise<GraphqlError | null> {
  try {
    const body = await res.json<{ errors?: GraphqlError[] }>();
    return Array.isArray(body?.errors) && body.errors.length > 0 ? body.errors[0] : null;
  } catch {
    return null;
  }
}

/**
 * One GraphQL request to Amboss. Every call is deadline-bound (http.ts): a
 * stalled Amboss must not hold anything hostage. Mutations get their own
 * deadline (see HTTP_TIMEOUTS for why it must stay inside the shutdown wait).
 * Throws AmbossError.
 */
export async function ambossGql<T>(
  url: string,
  query: string,
  apiKey?: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const timeoutMs = /^\s*mutation\b/.test(query) ? HTTP_TIMEOUTS.ambossMutationMs : HTTP_TIMEOUTS.ambossQueryMs;
  let res: TimedResponse;
  try {
    res = await httpRequest(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(variables ? { query, variables } : { query }),
      },
      timeoutMs,
      // A read without the key is a public lookup — through Tor with the
      // default route; a call with the key is the account's (http.ts).
      apiKey ? "amboss" : "amboss_public",
    );
  } catch (e) {
    if (e instanceof HttpTimeoutError) throw new AmbossError("timeout", `Amboss ${e.message}`);
    throw new AmbossError("unreachable", `Amboss unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 401 || res.status === 403) throw new AmbossError("auth", `Amboss HTTP ${res.status}`, res.status);
  if (!res.ok) {
    // A GraphQL server answers a query that doesn't fit its schema with a 4xx
    // and an `errors` body: that message is what tells the operator (and the
    // lane) what went wrong — "Amboss HTTP 400" alone said nothing. A server
    // error (5xx), 408 or 429 stays an outage, whatever its body says.
    const gqlError = await graphqlErrorIn(res);
    const outage = res.status >= 500 || res.status === 408 || res.status === 429;
    if (gqlError && !outage) throw classifyGraphqlError(gqlError, res.status);
    const said = gqlError?.message ? `: ${gqlError.message}` : "";
    throw new AmbossError("http", `Amboss HTTP ${res.status}${said}`, res.status, gqlError?.extensions?.code);
  }
  let json: { data?: T | null; errors?: GraphqlError[] };
  try {
    json = await res.json<{ data?: T | null; errors?: GraphqlError[] }>();
  } catch (e) {
    if (e instanceof HttpTimeoutError) throw new AmbossError("timeout", `Amboss ${e.message}`);
    throw new AmbossError("http", `Amboss sent an unreadable answer: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (json.errors?.length) throw classifyGraphqlError(json.errors[0]);
  if (!json.data) throw new AmbossError("no_data", "Amboss returned no data");
  return json.data;
}

/** One page of an Amboss list (`page: PageInput`), as asked for. */
export interface PageRequest {
  limit: number;
  offset: number;
}

/**
 * Every item of a paged Amboss list, each exactly once (in the order first
 * seen), and the `total` Amboss reported.
 *
 * The Magma lists take a `page: PageInput`, but magma.amboss.tech does not
 * honour it: on 2026-10-21 the public offer list answered all 98 offers, with
 * total 98, for every page asked (offsets 0, 50, 100 and 150; limit 10 at
 * offsets 20 and 50 too), in an order that can differ between requests. Counting pages
 * against `total` — stop once (page + 1) × limit ≥ total — therefore read a
 * list of 51–100 entries twice and one of 101–150 three times: every count of
 * the eligibility check doubled. So the walk keeps items by id and stops when
 * a page brings no id it hasn't seen, once `total` distinct ids are in, or
 * after `maxPages`. Should Amboss start honouring the page, the same walk
 * pages through the list properly.
 */
export async function collectPages<T>(
  fetchPage: (page: PageRequest) => Promise<{ list: T[]; total: number }>,
  idOf: (item: T) => string,
  opts: { pageSize: number; maxPages: number },
): Promise<{ items: T[]; total: number }> {
  const byId = new Map<string, T>();
  let total = 0;
  for (let page = 0; page < opts.maxPages; page++) {
    const res = await fetchPage({ limit: opts.pageSize, offset: page * opts.pageSize });
    total = Number(res.total) || 0;
    const before = byId.size;
    for (const item of res.list) {
      const id = idOf(item);
      if (!byId.has(id)) byId.set(id, item);
    }
    if (byId.size === before || byId.size >= total) break;
  }
  return { items: [...byId.values()], total };
}

// ── public market data (no key) ───────────────────────────────────────────────

/** A buyer condition an offer sets (legacy OfferType.conditions): who may
 *  buy from it — e.g. NODE_CAPACITY GREATER_THAN_OR_EQUAL_TO "10000000". */
export interface OfferCondition {
  condition: string;
  operator: string;
  value: string;
}

export interface MagmaOffer {
  id: string;
  sellerPubkey: string;
  minSizeSats: number;
  maxSizeSats: number;
  baseFeeSats: number;
  feeRatePpm: number;
  sellerScore: number;
  /** total_size minus what is already locked into live orders. */
  availableSats: number;
  /** Listed capacity, before subtracting locked orders. */
  totalSizeSats: number;
  lockedSats: number;
  minBlockLength: number;
  /** The routing fees the seller promises to keep for the lease (null: none). */
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  /** Who may buy (none: anyone). */
  conditions: OfferCondition[];
}

export interface MarketView {
  offers: MagmaOffer[];
  /** The bitcoin price: sats per US dollar (liquidity_per_usd.sats ÷ .usd). */
  satsPerUsd: number | null;
  /** Inbound capacity one US dollar buys at today's market rate
   *  (liquidity_per_usd.sats, Amboss: "satoshis of inbound capacity per USD
   *  spent"). A liquidity.buy order is at least $5 — this × 5 sat of channel. */
  inboundSatsPerUsd: number | null;
}

interface RawOffer {
  id: string;
  account: string;
  min_size: string;
  max_size: string;
  base_fee: number;
  fee_rate: number;
  seller_score: string;
  status: string;
  side: string;
  total_size: string;
  min_block_length?: number | string | null;
  fee_rate_cap?: number | null;
  base_fee_cap?: number | null;
  conditions?: OfferCondition[] | null;
  orders?: { locked_size: string | null } | null;
}

/** Legacy endpoint, still current: the new offer list carries no seller score. */
export const OFFER_BOOK_QUERY = `query {
    getOffers { list {
      id account min_size max_size base_fee fee_rate seller_score status side total_size
      min_block_length fee_rate_cap base_fee_cap
      conditions { condition operator value }
      orders { locked_size }
    } }
  }`;

/** Live SELL offers on the Magma marketplace (no key required). */
export async function getOffers(): Promise<MagmaOffer[]> {
  // `orders { locked_size }` is what an offer has actually committed. Without it
  // total_size reads as "available", which it is not: a seller with a full order
  // book still lists their whole capacity.
  const data = await ambossGql<{ getOffers: { list: RawOffer[] } }>(AMBOSS_URL, OFFER_BOOK_QUERY);
  return data.getOffers.list
    .filter((o) => o.side === "SELL" && o.status === "ENABLED")
    .map((o) => {
      const total = Number(o.total_size);
      const locked = Number(o.orders?.locked_size ?? 0) || 0;
      return {
        id: o.id,
        sellerPubkey: o.account,
        minSizeSats: Number(o.min_size),
        maxSizeSats: Number(o.max_size),
        baseFeeSats: Number(o.base_fee),
        feeRatePpm: Number(o.fee_rate),
        sellerScore: Number(o.seller_score),
        availableSats: Math.max(0, total - locked),
        totalSizeSats: total,
        lockedSats: locked,
        minBlockLength: Number(o.min_block_length ?? 0) || 0,
        feeRateCapPpm: numberOrNull(o.fee_rate_cap),
        baseFeeCapSats: numberOrNull(o.base_fee_cap),
        conditions: Array.isArray(o.conditions)
          ? o.conditions.filter((c) => c && typeof c.condition === "string").map((c) => ({ condition: c.condition, operator: c.operator, value: String(c.value) }))
          : [],
      };
    })
    .sort((a, b) => b.sellerScore - a.sellerScore);
}

const numberOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const PRICE_QUERY = `query { market { liquidity { liquidity_per_usd { sats usd } } } }`;

/**
 * Amboss's dollar rates (no key required): `liquidity_per_usd.sats` is the
 * inbound capacity one US dollar buys at today's market rate, `.usd` what
 * those sats are worth in dollars — so sats ÷ usd is the bitcoin price in
 * sats per dollar. (The two were conflated: what the Buy tab showed as
 * "inbound per $" was the bitcoin price.) Null when Amboss can't be asked.
 */
export async function dollarRates(): Promise<{ satsPerUsd: number | null; inboundSatsPerUsd: number | null }> {
  try {
    const data = await ambossGql<{
      market: { liquidity: { liquidity_per_usd: { sats: string; usd: string } } };
    }>(MAGMA_URL, PRICE_QUERY);
    const l = data.market.liquidity.liquidity_per_usd;
    const sats = Number(l.sats);
    const usd = Number(l.usd);
    return {
      satsPerUsd: usd > 0 && sats > 0 ? sats / usd : null,
      inboundSatsPerUsd: Number.isFinite(sats) && sats > 0 ? sats : null,
    };
  } catch {
    return { satsPerUsd: null, inboundSatsPerUsd: null }; // a nice-to-have; never fail the market view on it
  }
}

/** The bitcoin price in sats per US dollar (see dollarRates). */
export async function satsPerUsd(): Promise<number | null> {
  return (await dollarRates()).satsPerUsd;
}

export async function getMarket(): Promise<MarketView> {
  const [offers, rates] = await Promise.all([getOffers(), dollarRates()]);
  return { offers, ...rates };
}

/**
 * The public Magma offer list (magma.amboss.tech, no key): what the legacy
 * book lacks — how many orders each offer has filled, since when it is
 * listed, and the platform fee Amboss charges its buyers (`fees.amboss`, a
 * step function of the listed total). Joined with the legacy book's seller
 * scores, it is what the sell-eligibility check compares a node against.
 */
export const PUBLIC_OFFERS_QUERY = `query PublicOffers($page: PageInput) {
  market { offer { offers(page: $page) {
    list {
      id status created_at filled_orders
      node { pubkey }
      asset { type }
      total_amount { satoshi { sats } }
      fees { amboss { sats } }
    }
    total
  } } }
}`;

export interface PublicOffer {
  id: string;
  status: string;
  sellerPubkey: string;
  createdAt: string;
  filledOrders: number;
  /** 0 when the offer has no satoshi total (an offer of another asset). */
  totalSizeSats: number;
  /** fees.amboss: what Amboss adds for the buyer (the tier of the listed total). */
  ambossFee: number;
  /** BASE_ASSET (bitcoin) or TAPROOT_ASSET (e.g. a USDT channel); null when
   *  Amboss doesn't say. */
  assetType: string | null;
}

const PUBLIC_PAGE = 50;
const PUBLIC_MAX_PAGES = 20;

interface RawPublicOffer {
  id: string;
  status: string;
  created_at: string;
  filled_orders: number;
  node: { pubkey: string } | null;
  asset: { type: string | null } | null;
  total_amount: { satoshi: { sats: string } | null } | null;
  fees: { amboss: { sats: string } | null } | null;
}

/** The public Magma offer list, each offer once (see collectPages: the
 *  endpoint answers the whole list for every page). */
export async function getPublicOffers(): Promise<PublicOffer[]> {
  const { items } = await collectPages(
    async (page) => {
      const data = await ambossGql<{ market: { offer: { offers: { list: RawPublicOffer[]; total: number } } } }>(
        MAGMA_URL,
        PUBLIC_OFFERS_QUERY,
        undefined,
        { page },
      );
      return data.market.offer.offers;
    },
    (o) => o.id,
    { pageSize: PUBLIC_PAGE, maxPages: PUBLIC_MAX_PAGES },
  );
  return items.map((o) => ({
    id: o.id,
    status: o.status,
    sellerPubkey: o.node?.pubkey ?? "",
    createdAt: o.created_at,
    filledOrders: Number(o.filled_orders) || 0,
    totalSizeSats: Number(o.total_amount?.satoshi?.sats ?? 0) || 0,
    ambossFee: Number(o.fees?.amboss?.sats ?? 0) || 0,
    assetType: o.asset?.type ?? null,
  }));
}

/** A node's public Magma record (legacy endpoint, no key). */
export const NODE_MARKET_QUERY = `query NodeMarket($pubkey: String!) {
  getNode(pubkey: $pubkey) { amboss { market { seller_score stats { sell { confirmed_orders } } } } }
}`;

/** The seller score Amboss shows for a node, and its completed sales. Null
 *  fields when Amboss has none for it. */
export async function getNodeMarket(pubkey: string): Promise<{ sellerScore: number | null; confirmedSells: number | null }> {
  const data = await ambossGql<{
    getNode: { amboss: { market: { seller_score: string | null; stats: { sell: { confirmed_orders: number | null } | null } | null } | null } | null } | null;
  }>(AMBOSS_URL, NODE_MARKET_QUERY, undefined, { pubkey });
  const m = data.getNode?.amboss?.market;
  return {
    sellerScore: numberOrNull(m?.seller_score),
    confirmedSells: numberOrNull(m?.stats?.sell?.confirmed_orders),
  };
}

export interface RawMarketOrder {
  date: string;
  size: string;
  block_duration: number;
  /** Annualised rate the buyer actually paid, as a decimal string. */
  lnr: string | null;
  lny: string | null;
  status: string | null;
}

/**
 * Every completed Magma order since `from` (YYYY-MM-DD). This is the real fill
 * history: size, lease length and the rate the buyer agreed to. Needs no key.
 *
 * It replaces the order-book diffing we used to do. Listed offers are asks;
 * these are trades.
 */
export async function marketOrderHistory(from: string): Promise<RawMarketOrder[]> {
  const query = `query History($from: String!) {
    getMarketMetrics { order_details(from: $from) {
      date size block_duration lnr lny status
    } }
  }`;
  const data = await ambossGql<{ getMarketMetrics: { order_details: RawMarketOrder[] } }>(
    AMBOSS_URL,
    query,
    undefined,
    { from },
  );
  return data.getMarketMetrics?.order_details ?? [];
}

// ── buying ────────────────────────────────────────────────────────────────────

export interface BuyQuote {
  orderId: string;
  paymentRequest: string;
  sats: number;
  /** Channel size Amboss committed to, or 0 when the answer doesn't say
   *  (liquidity.buy is priced in dollars; the size comes with the order). */
  channelSizeSats: number;
  /** The terms the order locked (a targeted buy; null when not told): the
   *  lease, and the seller's routing-fee promise for it. */
  leaseBlocks?: number | null;
  feeRateCapPpm?: number | null;
  baseFeeCapSats?: number | null;
  /** Amboss's own fee in this order. */
  ambossFeeSats?: number | null;
}

/** Failure states of an order — shared with the seller side (magmaApi.ts). */
export const ORDER_FAILED = new Set([
  "BUYER_FAILED_TO_PAY",
  "BUYER_REJECTED",
  "SELLER_REJECTED",
  "SELLER_FAILED_TO_OPEN_CHANNEL",
  "SELLER_FAILED_TO_REACT",
  "SELLER_FAILED_TO_SEND_SWAP",
  "INVALID_CHANNEL_OPENING",
  "ADMIN_CLOSED",
]);

/** The channel is confirmed and matches the order (and later, the lease ran out). */
export const ORDER_SUCCEEDED = new Set(["VALID_CHANNEL_OPENING", "CHANNEL_MONITORING_FINISHED"]);

export interface OrderState {
  status: string;
  paymentStatus: string | null;
  channelId: string | null;
  channelSizeSats: number;
  done: boolean;
  failed: boolean;
  /** The terms the order locked (promises) and who sells (source) — what a
   *  dollar buy's quote can't say: Amboss names them once it matched a
   *  seller. Null (or absent): not told. A 0 fee-rate cap promises nothing. */
  leaseBlocks?: number | null;
  feeRateCapPpm?: number | null;
  baseFeeCapSats?: number | null;
  sellerPubkey?: string | null;
}

// `order` carries only transaction_id and usd_cents: the `amount` this used to
// ask for does not exist on LiquidityOrderDetails, so every generic buy failed
// with a GraphQL validation error.
export const BUY_LIQUIDITY_MUTATION = `mutation Buy($input: LiquidityOrderInput!) {
    liquidity { buy(input: $input) {
      order { transaction_id usd_cents }
      payment { lightning_invoice amount { sats } }
    } }
  }`;

/**
 * Create a Magma buy order. Returns the HODL invoice to pay — does NOT pay it.
 * Amboss matches a seller for the requested USD amount; the seller opens an
 * inbound channel to connectionUri once the invoice is paid.
 */
export async function buyLiquidity(
  apiKey: string,
  connectionUri: string,
  usdCents: number,
  isPrivate: boolean,
): Promise<BuyQuote> {
  const input = {
    connection_uri: connectionUri,
    usd_cents: String(usdCents),
    options: { private: isPrivate },
  };
  const data = await ambossGql<{
    liquidity: {
      buy: {
        order: { transaction_id: string; usd_cents: string };
        payment: { lightning_invoice: string | null; amount: { sats: string } | null };
      };
    };
  }>(MAGMA_URL, BUY_LIQUIDITY_MUTATION, apiKey, { input });
  const buy = data.liquidity.buy;
  if (!buy.payment.lightning_invoice) throw new AmbossError("no_data", "Amboss returned no invoice for the order");
  return {
    orderId: buy.order.transaction_id,
    paymentRequest: buy.payment.lightning_invoice,
    sats: Number(buy.payment.amount?.sats ?? 0),
    channelSizeSats: 0,
  };
}

// `amount` is a SizeValue object, not a number: selecting it bare was invalid.
// promises and source: what a dollar buy (liquidity.buy) learns only from the
// order — its lease, the seller's fee promise and the seller.
export const BUYER_ORDER_QUERY = `query GetOrder($id: String!) {
    user { market { orders { get_order(order_id: $id) {
      status payment_status channel_id amount { satoshi { sats } }
      promises { locked_min_block_length locked_fee_rate_cap { sats } locked_base_fee_cap { sats } }
      source { pubkey }
    } } } }
  }`;

/** Poll a Magma order's status (buyer side). */
export async function getOrder(apiKey: string, orderId: string): Promise<OrderState> {
  const data = await ambossGql<{
    user: {
      market: {
        orders: {
          get_order: {
            status: string;
            payment_status: string | null;
            channel_id: string | null;
            amount: { satoshi: { sats: string } | null } | null;
            promises?: {
              locked_min_block_length: number | null;
              locked_fee_rate_cap: { sats: string | null } | null;
              locked_base_fee_cap: { sats: string | null } | null;
            } | null;
            source?: { pubkey: string | null } | null;
          };
        };
      };
    };
  }>(MAGMA_URL, BUYER_ORDER_QUERY, apiKey, { id: orderId });
  const o = data.user.market.orders.get_order;
  const cap = numberOrNull(o.promises?.locked_fee_rate_cap?.sats);
  return {
    status: o.status,
    paymentStatus: o.payment_status ?? null,
    channelId: o.channel_id ?? null,
    channelSizeSats: Number(o.amount?.satoshi?.sats ?? 0),
    leaseBlocks: numberOrNull(o.promises?.locked_min_block_length) || null,
    // 0 locked = the offer promised nothing.
    feeRateCapPpm: cap !== null && cap > 0 ? cap : null,
    baseFeeCapSats: cap !== null && cap > 0 ? numberOrNull(o.promises?.locked_base_fee_cap?.sats) : null,
    sellerPubkey: o.source?.pubkey || null,
    // CHANNEL_MONITORING_FINISHED is a success too (the lease ran out): a
    // purchase first followed that late — after a long restart — is done,
    // not "paying" for good.
    done: ORDER_SUCCEEDED.has(o.status),
    failed: ORDER_FAILED.has(o.status),
  };
}

export const BUY_FROM_OFFER_MUTATION = `mutation Order($input: CreateManualOrderInput!) {
    market { order { create(input: $input) {
      id
      amount { satoshi { sats } }
      fees { buyer { sats } amboss { sats } }
      promises { locked_min_block_length locked_fee_rate_cap { sats } locked_base_fee_cap { sats } }
      payment { lightning { invoice } }
    } } }
  }`;

/**
 * Buy from one chosen offer.
 *
 * `liquidity.buy` (above) takes only a USD amount and lets Amboss pick the
 * seller, which made the ranked "best offer" list in the Buy tab decorative:
 * whatever the user picked, Amboss matched whoever it wanted. This mutation
 * targets an offer_id, so the pick actually decides who opens the channel.
 */
export async function buyFromOffer(
  apiKey: string,
  offerId: string,
  pubkey: string,
  sizeSats: number,
  isPrivate: boolean,
): Promise<BuyQuote> {
  const input = {
    offer_id: offerId,
    pubkey,
    size: String(Math.round(sizeSats)),
    // PaymentMethod is { AMBUCKS, SATS } — we pay the invoice in sats.
    payment_method: "SATS",
    options: { private: isPrivate },
  };
  const data = await ambossGql<{
    market: {
      order: {
        create: {
          id: string;
          amount: { satoshi: { sats: string | null } | null } | null;
          fees: { buyer: { sats: string | null } | null; amboss?: { sats: string | null } | null } | null;
          promises?: {
            locked_min_block_length: number | null;
            locked_fee_rate_cap: { sats: string | null } | null;
            locked_base_fee_cap: { sats: string | null } | null;
          } | null;
          payment: { lightning: { invoice: string | null } | null } | null;
        };
      };
    };
  }>(MAGMA_URL, BUY_FROM_OFFER_MUTATION, apiKey, { input });
  const o = data.market.order.create;
  const invoice = o.payment?.lightning?.invoice ?? "";
  if (!invoice) throw new AmbossError("no_data", "Amboss returned no invoice for the order");
  const cap = numberOrNull(o.promises?.locked_fee_rate_cap?.sats);
  return {
    orderId: o.id,
    paymentRequest: invoice,
    sats: Number(o.fees?.buyer?.sats ?? 0),
    channelSizeSats: Number(o.amount?.satoshi?.sats ?? sizeSats),
    leaseBlocks: numberOrNull(o.promises?.locked_min_block_length),
    // 0 locked = the offer promised nothing.
    feeRateCapPpm: cap !== null && cap > 0 ? cap : null,
    baseFeeCapSats: cap !== null && cap > 0 ? numberOrNull(o.promises?.locked_base_fee_cap?.sats) : null,
    ambossFeeSats: numberOrNull(o.fees?.amboss?.sats),
  };
}

export type CancellationReason = "CHANNEL_SIZE_OUT_OF_BOUNDS" | "UNABLE_TO_CONNECT_TO_NODE" | "UNABLE_TO_PAY";

export const CANCEL_PURCHASE_MUTATION = `mutation CancelOrder($input: CancelOrderInput!) {
    market { order { cancel(input: $input) { success } } }
  }`;

/** Cancel one of your own buy orders before paying it (legacy cancelOrder is
 *  deprecated; the Magma API wants a reason). True when Amboss confirmed. */
export async function cancelPurchase(apiKey: string, orderId: string, reason: CancellationReason): Promise<boolean> {
  const data = await ambossGql<{ market: { order: { cancel: { success: boolean } } } }>(
    MAGMA_URL,
    CANCEL_PURCHASE_MUTATION,
    apiKey,
    { input: { order_id: orderId, cancellation_reason: reason } },
  );
  return data.market.order.cancel.success === true;
}
