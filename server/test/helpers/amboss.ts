import type { FetchMock } from "./fetchMock.js";

export const AMBOSS_API = "https://api.amboss.space/graphql";
export const MAGMA_API = "https://magma.amboss.tech/graphql";

/** A seller order as the (legacy) `getUser.market.offer_orders` query returns it. */
export interface RawSellerOrder {
  id: string;
  status: string;
  size: string;
  offer_side: "SELL" | "BUY";
  seller_invoice_amount: string | null;
  payment_status: string | null;
  channel_id: string | null;
  created_at: string;
  transaction_id: string | null;
  blocks_until_can_be_closed: number | null;
  endpoints: { destination: string } | null;
}

export function sellerOrder(o: Partial<RawSellerOrder> & { id: string; destination: string }): RawSellerOrder {
  const { destination, ...rest } = o;
  return {
    status: "WAITING_FOR_CHANNEL_OPEN",
    size: "2000000",
    offer_side: "SELL",
    seller_invoice_amount: "12345",
    payment_status: "PAID",
    channel_id: null,
    created_at: new Date().toISOString(),
    transaction_id: null,
    blocks_until_can_be_closed: null,
    endpoints: { destination },
    ...rest,
  };
}

/**
 * The legacy seller endpoints the current fulfilment code calls on
 * api.amboss.space: the order list, sellerAcceptOrder and
 * sellerAddTransaction. `state.orders` can be changed between calls; every
 * mutation is visible in `http.mutations`.
 */
export function mockAmbossSeller(
  http: FetchMock,
  init: { orders: RawSellerOrder[]; addTransactionResult?: boolean; acceptResult?: boolean },
): { orders: RawSellerOrder[] } {
  const state = { orders: init.orders };
  http.onGraphql(AMBOSS_API, "offer_orders", () => ({
    data: {
      getUser: {
        market: {
          pending_seller_orders: state.orders.filter((o) => o.status === "WAITING_FOR_SELLER_APPROVAL").length,
          offer_orders: { list: state.orders },
        },
      },
    },
  }));
  http.onGraphql(AMBOSS_API, "sellerAddTransaction", () => ({
    data: { sellerAddTransaction: init.addTransactionResult ?? true },
  }));
  http.onGraphql(AMBOSS_API, "sellerAcceptOrder", () => ({ data: { sellerAcceptOrder: init.acceptResult ?? true } }));
  return state;
}
