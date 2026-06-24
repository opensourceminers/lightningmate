/**
 * Amboss Magma marketplace client. Two public endpoints share the same Amboss
 * account API key (Bearer):
 *  - api.amboss.space  — getOffers (marketplace listing), getUser (key check)
 *  - magma.amboss.tech — market.liquidity (price), liquidity.buy (purchase)
 * Reads (offers, price) need no key; the key is for buying/selling + key checks.
 */

const AMBOSS_URL = "https://api.amboss.space/graphql";
const MAGMA_URL = "https://magma.amboss.tech/graphql";

export interface MagmaOffer {
  id: string;
  sellerPubkey: string;
  minSizeSats: number;
  maxSizeSats: number;
  baseFeeSats: number;
  feeRatePpm: number;
  sellerScore: number;
  availableSats: number;
}

export interface MarketView {
  offers: MagmaOffer[];
  satsPerUsd: number | null;
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
}

async function gql<T>(
  url: string,
  query: string,
  apiKey?: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
    });
  } catch (e) {
    throw new Error(`Amboss unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`Amboss HTTP ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error("Amboss returned no data");
  return json.data;
}

/** Live SELL offers on the Magma marketplace (no key required). */
export async function getOffers(): Promise<MagmaOffer[]> {
  const query = `query {
    getOffers { list {
      id account min_size max_size base_fee fee_rate seller_score status side total_size
    } }
  }`;
  const data = await gql<{ getOffers: { list: RawOffer[] } }>(AMBOSS_URL, query);
  return data.getOffers.list
    .filter((o) => o.side === "SELL" && o.status === "ENABLED")
    .map((o) => ({
      id: o.id,
      sellerPubkey: o.account,
      minSizeSats: Number(o.min_size),
      maxSizeSats: Number(o.max_size),
      baseFeeSats: Number(o.base_fee),
      feeRatePpm: Number(o.fee_rate),
      sellerScore: Number(o.seller_score),
      availableSats: Number(o.total_size),
    }))
    .sort((a, b) => b.sellerScore - a.sellerScore);
}

/** sats of inbound you get per 1 USD spent (no key required). */
export async function satsPerUsd(): Promise<number | null> {
  try {
    const query = `query { market { liquidity { liquidity_per_usd { sats usd } } } }`;
    const data = await gql<{
      market: { liquidity: { liquidity_per_usd: { sats: string; usd: string } } };
    }>(MAGMA_URL, query);
    const l = data.market.liquidity.liquidity_per_usd;
    const usd = Number(l.usd);
    return usd > 0 ? Number(l.sats) / usd : null;
  } catch {
    return null; // price is a nice-to-have; never fail the whole market view on it
  }
}

export async function getMarket(): Promise<MarketView> {
  const [offers, perUsd] = await Promise.all([getOffers(), satsPerUsd()]);
  return { offers, satsPerUsd: perUsd };
}

export interface BuyQuote {
  orderId: string;
  paymentRequest: string;
  sats: number;
  channelSizeSats: number;
}

const TERMINAL_FAIL = new Set([
  "BUYER_FAILED_TO_PAY",
  "BUYER_REJECTED",
  "SELLER_REJECTED",
  "SELLER_FAILED_TO_OPEN_CHANNEL",
  "SELLER_FAILED_TO_REACT",
  "SELLER_FAILED_TO_SEND_SWAP",
  "INVALID_CHANNEL_OPENING",
  "ADMIN_CLOSED",
]);

export interface OrderState {
  status: string;
  paymentStatus: string | null;
  channelId: string | null;
  channelSizeSats: number;
  done: boolean;
  failed: boolean;
}

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
  const query = `mutation Buy($input: LiquidityOrderInput!) {
    liquidity { buy(input: $input) {
      order { transaction_id amount }
      payment { lightning_invoice amount { sats } }
    } }
  }`;
  const input = {
    connection_uri: connectionUri,
    usd_cents: String(usdCents),
    options: { private: isPrivate },
  };
  const data = await gql<{
    liquidity: {
      buy: {
        order: { transaction_id: string; amount: string };
        payment: { lightning_invoice: string; amount: { sats: string } };
      };
    };
  }>(MAGMA_URL, query, apiKey, { input });
  const buy = data.liquidity.buy;
  return {
    orderId: buy.order.transaction_id,
    paymentRequest: buy.payment.lightning_invoice,
    sats: Number(buy.payment.amount.sats),
    channelSizeSats: Number(buy.order.amount),
  };
}

/** Poll a Magma order's status. */
export async function getOrder(apiKey: string, orderId: string): Promise<OrderState> {
  const query = `query GetOrder($id: String!) {
    user { market { orders { get_order(order_id: $id) {
      status payment_status channel_id amount
    } } } }
  }`;
  const data = await gql<{
    user: {
      market: {
        orders: {
          get_order: {
            status: string;
            payment_status: string | null;
            channel_id: string | null;
            amount: string | null;
          };
        };
      };
    };
  }>(MAGMA_URL, query, apiKey, { id: orderId });
  const o = data.user.market.orders.get_order;
  return {
    status: o.status,
    paymentStatus: o.payment_status ?? null,
    channelId: o.channel_id ?? null,
    channelSizeSats: Number(o.amount ?? 0),
    done: o.status === "VALID_CHANNEL_OPENING",
    failed: TERMINAL_FAIL.has(o.status),
  };
}

// ── Selling (offers) ──────────────────────────────────────────────────────────

export interface MyOffer {
  id: string;
  status: string;
  minSizeSats: number;
  maxSizeSats: number;
  totalSizeSats: number;
  baseFeeSats: number;
  feeRatePpm: number;
  minBlockLength: number;
}

export interface CreateOfferParams {
  totalSizeSats: number;
  minSizeSats: number;
  maxSizeSats: number;
  feeRatePpm: number;
  baseFeeSats: number;
  minBlockLength: number;
}

export interface MyOrder {
  id: string;
  status: string;
  side: string; // offer_side: SELL = you're the seller
  sizeSats: number;
  feeSats: number; // seller_invoice_amount — what you earn for fulfilling
  destination: string; // buyer endpoint to open the channel to (pubkey[@socket])
  paymentStatus: string | null;
  channelId: string | null;
  createdAt: string;
}

export interface MyOrdersView {
  orders: MyOrder[];
  pendingSeller: number;
}

/** Create a SELL channel offer on the marketplace. */
export async function createOffer(apiKey: string, p: CreateOfferParams): Promise<boolean> {
  const mutation = `mutation Create($input: CreateOffer!) { createOffer(input: $input) }`;
  // Amboss wants either (onchain_priority + onchain_multiplier) OR a base_fee.
  // We price with base_fee + fee_rate, so omit the on-chain fields entirely.
  const input = {
    offer_side: "SELL",
    offer_type: "CHANNEL",
    total_size: p.totalSizeSats,
    min_size: p.minSizeSats,
    max_size: p.maxSizeSats,
    fee_rate: p.feeRatePpm,
    base_fee: p.baseFeeSats,
    min_block_length: p.minBlockLength,
  };
  const data = await gql<{ createOffer: boolean }>(AMBOSS_URL, mutation, apiKey, { input });
  return data.createOffer;
}

/** Update an existing offer's pricing / sizes (free tier allows one offer). */
export async function updateOffer(apiKey: string, id: string, p: CreateOfferParams): Promise<boolean> {
  const mutation = `mutation Update($input: UpdateOffer!) { updateOffer(input: $input) }`;
  const input = {
    offer: id,
    total_size: p.totalSizeSats,
    min_size: p.minSizeSats,
    max_size: p.maxSizeSats,
    fee_rate: p.feeRatePpm,
    base_fee: p.baseFeeSats,
    min_block_length: p.minBlockLength,
  };
  const data = await gql<{ updateOffer: boolean }>(AMBOSS_URL, mutation, apiKey, { input });
  return data.updateOffer;
}

/** Enable/disable one of your offers; returns the new status. */
export async function toggleOffer(apiKey: string, id: string): Promise<string> {
  const mutation = `mutation Toggle($id: String!) { toggleOffer(id: $id) }`;
  const data = await gql<{ toggleOffer: string }>(AMBOSS_URL, mutation, apiKey, { id });
  return data.toggleOffer;
}

/** Your own SELL offers. */
export async function getMyOffers(apiKey: string): Promise<MyOffer[]> {
  const query = `query { getUser { market { offers { list {
    id side status min_size max_size total_size base_fee fee_rate min_block_length
  } } } } }`;
  const data = await gql<{
    getUser: { market: { offers: { list: (RawOffer & { min_block_length: string })[] } } };
  }>(AMBOSS_URL, query, apiKey);
  return (data.getUser?.market?.offers?.list ?? [])
    .filter((o) => o.side === "SELL")
    .map((o) => ({
      id: o.id,
      status: o.status,
      minSizeSats: Number(o.min_size),
      maxSizeSats: Number(o.max_size),
      totalSizeSats: Number(o.total_size),
      baseFeeSats: Number(o.base_fee),
      feeRatePpm: Number(o.fee_rate),
      minBlockLength: Number(o.min_block_length),
    }));
}

/** Orders placed against your offers (you as the seller), + pending count. */
export async function getMyOrders(apiKey: string): Promise<MyOrdersView> {
  const query = `query { getUser { market {
    pending_seller_orders
    offer_orders { list {
      id status size offer_side seller_invoice_amount payment_status channel_id created_at
      endpoints { destination }
    } }
  } } }`;
  const data = await gql<{
    getUser: {
      market: {
        pending_seller_orders: number;
        offer_orders: {
          list: {
            id: string;
            status: string;
            size: string;
            offer_side: string;
            seller_invoice_amount: string | null;
            payment_status: string | null;
            channel_id: string | null;
            created_at: string;
            endpoints: { destination: string } | null;
          }[];
        };
      };
    };
  }>(AMBOSS_URL, query, apiKey);
  const m = data.getUser?.market;
  return {
    pendingSeller: Number(m?.pending_seller_orders ?? 0),
    orders: (m?.offer_orders?.list ?? []).map((o) => ({
      id: o.id,
      status: o.status,
      side: o.offer_side,
      sizeSats: Number(o.size),
      feeSats: Number(o.seller_invoice_amount ?? 0),
      destination: o.endpoints?.destination ?? "",
      paymentStatus: o.payment_status ?? null,
      channelId: o.channel_id ?? null,
      createdAt: o.created_at,
    })),
  };
}

// ── Seller fulfillment ────────────────────────────────────────────────────────

/** Accept an order by providing a BOLT11 invoice (expiry > 48h) for the fee. */
export async function acceptOrder(apiKey: string, id: string, request: string): Promise<boolean> {
  const mutation = `mutation Accept($id: String!, $request: String!) { sellerAcceptOrder(id: $id, request: $request) }`;
  const data = await gql<{ sellerAcceptOrder: boolean }>(AMBOSS_URL, mutation, apiKey, { id, request });
  return data.sellerAcceptOrder;
}

/** Tell Amboss the channel funding outpoint ("txid:vout") after opening it. */
export async function addOrderTransaction(apiKey: string, id: string, outpoint: string): Promise<boolean> {
  const mutation = `mutation AddTx($id: String!, $transaction: String!) { sellerAddTransaction(id: $id, transaction: $transaction) }`;
  const data = await gql<{ sellerAddTransaction: boolean }>(AMBOSS_URL, mutation, apiKey, { id, transaction: outpoint });
  return data.sellerAddTransaction;
}

export interface SellerOrderDetail {
  id: string;
  status: string;
  sizeSats: number;
  feeSats: number;
  destination: string;
}

/** Fetch one of your seller orders by id (fields needed to fulfill it). */
export async function getSellerOrder(apiKey: string, id: string): Promise<SellerOrderDetail | null> {
  const view = await getMyOrders(apiKey);
  const o = view.orders.find((x) => x.id === id);
  if (!o) return null;
  return { id: o.id, status: o.status, sizeSats: o.sizeSats, feeSats: o.feeSats, destination: o.destination };
}

/** True if the key authenticates against Amboss (getUser requires auth). */
export async function validateKey(apiKey: string): Promise<boolean> {
  if (!apiKey.trim()) return false;
  try {
    const data = await gql<{ getUser: { id: string } | null }>(
      AMBOSS_URL,
      `query { getUser { id } }`,
      apiKey.trim(),
    );
    return !!data.getUser?.id;
  } catch {
    return false;
  }
}
