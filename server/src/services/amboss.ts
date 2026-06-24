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
