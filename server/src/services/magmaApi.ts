/**
 * The seller side of Amboss Magma, on the Magma API (magma.amboss.tech).
 *
 * Until 0.7.7 all of this went through api.amboss.space mutations that Amboss
 * has deprecated ("We have now shifted to our Magma API!") and documents as
 * "no longer actively maintained"; its accept path is "no longer reliable".
 * Offer and order ids are the same UUIDs on both APIs, so offers created
 * through the legacy API are managed here unchanged.
 *
 * This module only talks to Amboss: it maps the GraphQL answers to plain
 * objects and reports every mutation's `success`. What to DO with an order
 * (accept with a HODL invoice, open, report, settle) is magmaDesk.ts.
 *
 * Amounts arrive as decimal strings (SatoshiValue.sats). On an OFFER,
 * `fees.fixed` is the base fee in sats and `fees.variable` the fee rate in ppm
 * (checked against the legacy offer book: same ids, same numbers). On an
 * ORDER both are materialised in sats, and `fees.seller` is what the seller
 * earns — the amount of the HODL invoice the buyer pays.
 */

import { AmbossError, MAGMA_URL, ambossGql } from "./amboss.js";

// ── amounts ───────────────────────────────────────────────────────────────────

/** Whole sats from a decimal sats string (fractions dropped); 0 when absent. */
export function satsOf(v: string | number | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Exact millisats from a decimal sats string ("12345", "12345.678"), or null
 *  when it is not a plain non-negative decimal. No floating point involved. */
export function msatOf(v: string | null | undefined): bigint | null {
  if (typeof v !== "string") return null;
  const m = /^(\d+)(?:\.(\d{1,3})\d*)?$/.exec(v.trim());
  if (!m) return null;
  return BigInt(m[1]) * 1000n + BigInt((m[2] ?? "").padEnd(3, "0") || "0");
}

const numOrNull = (v: string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── offers ────────────────────────────────────────────────────────────────────

export type OfferStatus = "ENABLED" | "DISABLED" | "ADMIN_DISABLED";

export interface MyOffer {
  id: string;
  status: string;
  minSizeSats: number;
  maxSizeSats: number;
  /** Listed capacity, including what live orders have locked. */
  totalSizeSats: number;
  /** Locked into orders in progress. */
  lockedSats: number;
  /** What a new buyer can still order: total − locked (Amboss docs). */
  availableSats: number;
  /** fees.fixed — base fee per channel, sats. */
  baseFeeSats: number;
  /** fees.variable — fee rate, ppm of the channel size. */
  feeRatePpm: number;
  /** promises.min_block_length — the minimum lease in blocks. */
  minBlockLength: number;
  /** Routing-fee caps promised for the lease (null = none promised). */
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  filledOrders: number;
  createdAt: string;
}

export const MY_OFFER_IDS_QUERY = `query MyOfferIds($page: PageInput) {
  user { market { offers { offers(page: $page) { list { id } total } } } }
}`;

export const MY_OFFER_QUERY = `query MyOffer($id: String!) {
  user { market { offers { get_offer(offer_id: $id) {
    id status created_at filled_orders
    min_amount { satoshi { sats } }
    max_amount { satoshi { sats } }
    total_amount { satoshi { sats } }
    locked_amount { satoshi { sats } }
    fees { fixed { sats } variable { sats } }
    promises { min_block_length fee_rate_cap base_fee_cap }
  } } } }
}`;

type Sats = { satoshi: { sats: string } | null } | null;
interface RawMyOffer {
  id: string;
  status: string;
  created_at: string;
  filled_orders: number;
  min_amount: Sats;
  max_amount: Sats;
  total_amount: Sats;
  locked_amount: Sats;
  fees: { fixed: { sats: string }; variable: { sats: string } };
  promises: { min_block_length: number; fee_rate_cap: string | null; base_fee_cap: string | null };
}

function toMyOffer(o: RawMyOffer): MyOffer {
  const total = satsOf(o.total_amount?.satoshi?.sats);
  const locked = satsOf(o.locked_amount?.satoshi?.sats);
  return {
    id: o.id,
    status: o.status,
    minSizeSats: satsOf(o.min_amount?.satoshi?.sats),
    maxSizeSats: satsOf(o.max_amount?.satoshi?.sats),
    totalSizeSats: total,
    lockedSats: locked,
    availableSats: Math.max(0, total - locked),
    baseFeeSats: satsOf(o.fees.fixed.sats),
    feeRatePpm: satsOf(o.fees.variable.sats),
    minBlockLength: Number(o.promises.min_block_length) || 0,
    feeRateCapPpm: numOrNull(o.promises.fee_rate_cap),
    baseFeeCapSats: numOrNull(o.promises.base_fee_cap),
    filledOrders: Number(o.filled_orders) || 0,
    createdAt: o.created_at,
  };
}

/** One of your offers, as Amboss has it now. */
export async function getMyOffer(apiKey: string, offerId: string): Promise<MyOffer> {
  const data = await ambossGql<{ user: { market: { offers: { get_offer: RawMyOffer } } } }>(
    MAGMA_URL,
    MY_OFFER_QUERY,
    apiKey,
    { id: offerId },
  );
  return toMyOffer(data.user.market.offers.get_offer);
}

const PAGE = 50;
const MAX_PAGES = 20;

/** All your offers (the list carries no size window, so each is read in full). */
export async function getMyOffers(apiKey: string): Promise<MyOffer[]> {
  const ids: string[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await ambossGql<{
      user: { market: { offers: { offers: { list: { id: string }[]; total: number } } } };
    }>(MAGMA_URL, MY_OFFER_IDS_QUERY, apiKey, { page: { limit: PAGE, offset: page * PAGE } });
    const { list, total } = data.user.market.offers.offers;
    ids.push(...list.map((o) => o.id));
    if (list.length === 0 || ids.length >= total) break;
  }
  return Promise.all(ids.map((id) => getMyOffer(apiKey, id)));
}

/** The offer fields this app sets. Sizes in sats, fee rate in ppm, base fee
 *  in sats, lease in blocks. */
export interface OfferTerms {
  totalSizeSats: number;
  minSizeSats: number;
  maxSizeSats: number;
  feeRatePpm: number;
  baseFeeSats: number;
  minBlockLength: number;
  /** Routing-fee caps promised for the lease (optional). */
  feeRateCapPpm?: number;
  baseFeeCapSats?: number;
}

const offerInput = (p: Partial<OfferTerms>): Record<string, number> => {
  const out: Record<string, number> = {};
  if (p.totalSizeSats !== undefined) out.total_size = p.totalSizeSats;
  if (p.minSizeSats !== undefined) out.min_size = p.minSizeSats;
  if (p.maxSizeSats !== undefined) out.max_size = p.maxSizeSats;
  if (p.feeRatePpm !== undefined) out.fee_rate = p.feeRatePpm;
  if (p.baseFeeSats !== undefined) out.base_fee = p.baseFeeSats;
  if (p.minBlockLength !== undefined) out.min_block_length = p.minBlockLength;
  if (p.feeRateCapPpm !== undefined) out.fee_rate_cap = p.feeRateCapPpm;
  if (p.baseFeeCapSats !== undefined) out.base_fee_cap = p.baseFeeCapSats;
  return out;
};

export const CREATE_OFFER_MUTATION = `mutation CreateOffer($input: CreateOfferInput!) {
  market { offer { create(input: $input) { offer_id } } }
}`;

/** List a new SELL offer for the node `pubkey`. Returns the new offer id;
 *  throws when Amboss answers without one. */
export async function createOffer(apiKey: string, pubkey: string, p: OfferTerms): Promise<string> {
  const data = await ambossGql<{ market: { offer: { create: { offer_id: string | null } } } }>(
    MAGMA_URL,
    CREATE_OFFER_MUTATION,
    apiKey,
    { input: { pubkey, ...offerInput(p) } },
  );
  const id = data.market.offer.create.offer_id;
  if (!id) throw new AmbossError("no_data", "Amboss created no offer (no offer id in the answer)");
  return id;
}

export const UPDATE_OFFER_MUTATION = `mutation UpdateOffer($input: UpdateOfferInput!) {
  market { offer { update(input: $input) { success } } }
}`;

/** Change an offer. Only the fields given are sent (the Magma API updates
 *  partially). True only when Amboss reports success. */
export async function updateOffer(apiKey: string, offerId: string, p: Partial<OfferTerms>): Promise<boolean> {
  const data = await ambossGql<{ market: { offer: { update: { success: boolean } } } }>(
    MAGMA_URL,
    UPDATE_OFFER_MUTATION,
    apiKey,
    { input: { offer_id: offerId, ...offerInput(p) } },
  );
  return data.market.offer.update.success === true;
}

export const TOGGLE_OFFER_MUTATION = `mutation ToggleOffer($input: ToggleOfferInput!) {
  market { offer { toggle(input: $input) { status } } }
}`;

/** Flip an offer between ENABLED and DISABLED; returns the status it has now. */
export async function toggleOffer(apiKey: string, offerId: string): Promise<string> {
  const data = await ambossGql<{ market: { offer: { toggle: { status: string } } } }>(
    MAGMA_URL,
    TOGGLE_OFFER_MUTATION,
    apiKey,
    { input: { offer_id: offerId } },
  );
  return data.market.offer.toggle.status;
}

// ── orders (you as the seller) ────────────────────────────────────────────────

/** Order statuses in which the seller has to act (Amboss: action_needed). */
export const SELLER_ACTION_STATUSES = new Set([
  "WAITING_FOR_SELLER_APPROVAL",
  "WAITING_FOR_CHANNEL_OPEN",
  "SELLER_SENT_TRANSACTION",
]);

/** Past WAITING_FOR_CHANNEL_OPEN: Amboss has the funding transaction. */
export const FUNDING_REPORTED_STATUSES = new Set([
  "SELLER_SENT_TRANSACTION",
  "WAITING_FOR_ON_CHAIN_CONFIRMATION",
  "ON_CHAIN_CONFIRMATION",
  "SELLER_OPENED_CHANNEL",
  "VALID_CHANNEL_OPENING",
  "CHANNEL_MONITORING_FINISHED",
]);

/** A sold channel whose lease is still running (it counts against the
 *  deploy cap). CHANNEL_MONITORING_FINISHED = the lease is over. */
export const LEASE_RUNNING_STATUSES = [
  "SELLER_SENT_TRANSACTION",
  "WAITING_FOR_ON_CHAIN_CONFIRMATION",
  "ON_CHAIN_CONFIRMATION",
  "SELLER_OPENED_CHANNEL",
  "VALID_CHANNEL_OPENING",
] as const;

export interface SaleOrder {
  id: string;
  status: string;
  /** Absolute ISO deadline for the current phase, or null ("check again"). */
  timeout: string | null;
  createdAt: string;
  paymentStatus: string | null;
  channelId: string | null;
  sizeSats: number;
  /** BASE_ASSET (bitcoin) or TAPROOT_ASSET. */
  assetType: string;
  /** Decimal sats strings as Amboss sent them: what the seller earns, and its
   *  parts. `seller` can read 0 until Amboss has settled it. */
  fees: { seller: string; fixed: string; variable: string };
  buyerPubkey: string;
  buyerAlias: string | null;
  isPrivate: boolean;
}

export interface SaleOrderDetail extends SaleOrder {
  isSeller: boolean;
  /** Where the buyer's node can be reached. */
  sockets: string[];
  transactionId: string | null;
  blocksUntilClosable: number | null;
  confirmations: number | null;
  /** Terms locked into the order at acceptance. */
  promises: { minBlockLength: number; feeRateCapPpm: number | null; baseFeeCapSats: number | null };
}

const SALE_FIELDS = `id status timeout created_at payment_status channel_id
      amount { satoshi { sats } }
      asset { type }
      fees { seller { sats } fixed { sats } variable { sats } }
      options { is_private }`;

export const SALES_QUERY = `query Sales($input: OrderInput, $page: PageInput) {
  user { market { orders { sales(input: $input, page: $page) {
    list {
      ${SALE_FIELDS}
      destination { pubkey alias }
    }
    total
  } } } }
}`;

export const SALE_QUERY = `query Sale($id: String!) {
  user { market { orders { get_order(order_id: $id) {
    ${SALE_FIELDS}
    is_seller transaction_id blocks_until_can_be_closed
    destination { pubkey alias sockets }
    promises { locked_min_block_length locked_fee_rate_cap { sats } locked_base_fee_cap { sats } }
    confirmations { confirmations }
  } } } }
}`;

interface RawSale {
  id: string;
  status: string;
  timeout: string | null;
  created_at: string;
  payment_status: string | null;
  channel_id: string | null;
  amount: Sats;
  asset: { type: string } | null;
  fees: { seller: { sats: string }; fixed: { sats: string }; variable: { sats: string } };
  options: { is_private: boolean } | null;
  destination: { pubkey: string; alias: string | null; sockets?: string[] };
}

interface RawSaleDetail extends RawSale {
  is_seller: boolean;
  transaction_id: string | null;
  blocks_until_can_be_closed: number | null;
  promises: {
    locked_min_block_length: number;
    locked_fee_rate_cap: { sats: string } | null;
    locked_base_fee_cap: { sats: string } | null;
  } | null;
  confirmations: { confirmations: number } | null;
}

function toSale(o: RawSale): SaleOrder {
  return {
    id: o.id,
    status: o.status,
    timeout: o.timeout ?? null,
    createdAt: o.created_at,
    paymentStatus: o.payment_status ?? null,
    channelId: o.channel_id ?? null,
    sizeSats: satsOf(o.amount?.satoshi?.sats),
    assetType: o.asset?.type ?? "BASE_ASSET",
    fees: { seller: o.fees.seller.sats, fixed: o.fees.fixed.sats, variable: o.fees.variable.sats },
    buyerPubkey: o.destination.pubkey,
    buyerAlias: o.destination.alias ?? null,
    isPrivate: o.options?.is_private === true,
  };
}

export interface SalesFilter {
  /** Only orders where the seller has to act now. */
  actionNeeded?: boolean;
  status?: readonly string[];
}

/** Your sales, newest first, all pages (bounded). */
export async function listSales(apiKey: string, filter: SalesFilter = {}): Promise<{ orders: SaleOrder[]; total: number }> {
  const input: Record<string, unknown> = {};
  if (filter.actionNeeded !== undefined) input.action_needed = filter.actionNeeded;
  if (filter.status) input.status = [...filter.status];
  const orders: SaleOrder[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await ambossGql<{
      user: { market: { orders: { sales: { list: RawSale[]; total: number } } } };
    }>(MAGMA_URL, SALES_QUERY, apiKey, { input, page: { limit: PAGE, offset: page * PAGE } });
    const res = data.user.market.orders.sales;
    total = Number(res.total) || 0;
    orders.push(...res.list.map(toSale));
    if (res.list.length === 0 || orders.length >= total) break;
  }
  return { orders, total };
}

/** One of your sales with everything needed to fulfil it. */
export async function getSale(apiKey: string, orderId: string): Promise<SaleOrderDetail> {
  const data = await ambossGql<{ user: { market: { orders: { get_order: RawSaleDetail } } } }>(
    MAGMA_URL,
    SALE_QUERY,
    apiKey,
    { id: orderId },
  );
  const o = data.user.market.orders.get_order;
  return {
    ...toSale(o),
    isSeller: o.is_seller === true,
    sockets: (o.destination.sockets ?? []).filter((s) => typeof s === "string" && s.length > 0),
    transactionId: o.transaction_id ?? null,
    blocksUntilClosable: o.blocks_until_can_be_closed ?? null,
    confirmations: o.confirmations?.confirmations ?? null,
    promises: {
      minBlockLength: Number(o.promises?.locked_min_block_length ?? 0) || 0,
      feeRateCapPpm: numOrNull(o.promises?.locked_fee_rate_cap?.sats),
      baseFeeCapSats: numOrNull(o.promises?.locked_base_fee_cap?.sats),
    },
  };
}

/** One of your sales, as the Orders view and the recommendation engine read it. */
export interface MyOrder {
  id: string;
  status: string;
  side: "SELL";
  sizeSats: number;
  /** fees.seller — what you earn (Amboss reports 0 until it has settled it). */
  feeSats: number;
  /** The buyer's node id. */
  destination: string;
  buyerAlias: string | null;
  isPrivate: boolean;
  paymentStatus: string | null;
  channelId: string | null;
  /** Funding txid, when this node's order journal knows it. */
  transactionId: string | null;
  /** 0 once the lease is over (CHANNEL_MONITORING_FINISHED); null = unknown. */
  blocksUntilClosable: number | null;
  /** A sold channel whose lease is running (counts against the deploy cap). */
  leaseActive: boolean;
  /** The channel was funded and reported to Amboss: a sale (done or under way). */
  sold: boolean;
  timeout: string | null;
  createdAt: string;
}

export interface MyOrdersView {
  orders: MyOrder[];
  /** Orders waiting on you: approval, or the channel open. */
  pendingSeller: number;
}

const LEASE_RUNNING = new Set<string>(LEASE_RUNNING_STATUSES);

export function toMyOrder(o: SaleOrder, transactionId: string | null = null): MyOrder {
  return {
    id: o.id,
    status: o.status,
    side: "SELL",
    sizeSats: o.sizeSats,
    feeSats: satsOf(o.fees.seller),
    destination: o.buyerPubkey,
    buyerAlias: o.buyerAlias,
    isPrivate: o.isPrivate,
    paymentStatus: o.paymentStatus,
    channelId: o.channelId,
    transactionId,
    blocksUntilClosable: o.status === "CHANNEL_MONITORING_FINISHED" ? 0 : null,
    leaseActive: LEASE_RUNNING.has(o.status),
    sold: FUNDING_REPORTED_STATUSES.has(o.status),
    timeout: o.timeout,
    createdAt: o.createdAt,
  };
}

/** All your sales (seller side), newest first, plus how many wait on you. */
export async function getMyOrders(apiKey: string): Promise<MyOrdersView> {
  const { orders } = await listSales(apiKey);
  const views = orders.map((o) => toMyOrder(o));
  return {
    orders: views,
    pendingSeller: views.filter((o) => o.status === "WAITING_FOR_SELLER_APPROVAL" || o.status === "WAITING_FOR_CHANNEL_OPEN").length,
  };
}

export const ACCEPT_MUTATION = `mutation AcceptOrder($input: SellerAcceptOrdersInput!) {
  market { order { seller { accept(input: $input) { success } } } }
}`;

/** Accept a sale with the BOLT11 HODL invoice the buyer will pay (Amboss:
 *  for `fees.seller`, expiring in at least 48 hours). */
export async function acceptSale(apiKey: string, orderId: string, paymentRequest: string): Promise<boolean> {
  const data = await ambossGql<{ market: { order: { seller: { accept: { success: boolean } } } } }>(
    MAGMA_URL,
    ACCEPT_MUTATION,
    apiKey,
    { input: { order_id: orderId, payment_request: paymentRequest } },
  );
  return data.market.order.seller.accept.success === true;
}

export const ADD_TRANSACTION_MUTATION = `mutation AddTransaction($input: SellerAddTransactionInput!) {
  market { order { seller { add_transaction(input: $input) { success } } } }
}`;

/** Tell Amboss which transaction funds the channel, as "TXID:OUTPUT_INDEX". */
export async function addSaleTransaction(apiKey: string, orderId: string, outpoint: string): Promise<boolean> {
  const data = await ambossGql<{ market: { order: { seller: { add_transaction: { success: boolean } } } } }>(
    MAGMA_URL,
    ADD_TRANSACTION_MUTATION,
    apiKey,
    { input: { order_id: orderId, tx_id: outpoint } },
  );
  return data.market.order.seller.add_transaction.success === true;
}

export const REJECT_MUTATION = `mutation RejectOrder($input: SellerRejectOrdersInput!) {
  market { order { seller { reject(input: $input) { success } } } }
}`;

/** Reject a sale still waiting for approval (frees the offer's locked amount). */
export async function rejectSale(apiKey: string, orderId: string): Promise<boolean> {
  const data = await ambossGql<{ market: { order: { seller: { reject: { success: boolean } } } } }>(
    MAGMA_URL,
    REJECT_MUTATION,
    apiKey,
    { input: { order_id: orderId } },
  );
  return data.market.order.seller.reject.success === true;
}

// ── the key ───────────────────────────────────────────────────────────────────

export const KEY_CHECK_QUERY = `query KeyCheck { user { id } }`;

/**
 * Does Amboss accept this key? Three answers, because "Amboss could not be
 * asked" is not "the key is bad":
 *   true  — the Magma API returned the account behind the key
 *   false — Amboss definitively refused it (401/403, FORBIDDEN)
 *   null  — no verdict: network error, timeout, Amboss down or garbled
 */
export async function validateKey(apiKey: string): Promise<boolean | null> {
  return (await checkKey(apiKey)).verdict;
}

/** validateKey, plus why there was no verdict (for the status shown in the UI). */
export async function checkKey(apiKey: string): Promise<{ verdict: boolean | null; error: string | null }> {
  if (!apiKey.trim()) return { verdict: false, error: null };
  try {
    const data = await ambossGql<{ user: { id: string } | null }>(MAGMA_URL, KEY_CHECK_QUERY, apiKey.trim());
    return { verdict: data.user?.id ? true : false, error: null };
  } catch (err) {
    if (err instanceof AmbossError && err.kind === "auth") return { verdict: false, error: null };
    return { verdict: null, error: err instanceof Error ? err.message : String(err) };
  }
}
