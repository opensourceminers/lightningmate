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

import { AmbossError, MAGMA_URL, ambossGql, collectPages } from "./amboss.js";

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
  /** The node the offer sells for. One Amboss account can list offers for
   *  several nodes: only this node's are LightningMate's to manage. */
  nodePubkey: string;
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
  /** Conditions a buyer's node must meet (set on amboss.tech; LightningMate
   *  keeps them as they are). */
  conditions: OfferCondition[];
  /** On-chain fee settings of the offer (amboss.tech; kept as they are). */
  onchainPriority: string | null;
  onchainMultiplier: number | null;
  filledOrders: number;
  createdAt: string;
}

/** One buyer condition of an offer (Amboss's OfferConditionsInput). */
export interface OfferCondition {
  condition: string;
  operator: string;
  value: string;
}

export const MY_OFFER_IDS_QUERY = `query MyOfferIds($page: PageInput) {
  user { market { offers { offers(page: $page) { list { id node { pubkey } } total } } } }
}`;

export const MY_OFFER_QUERY = `query MyOffer($id: String!) {
  user { market { offers { get_offer(offer_id: $id) {
    id status created_at filled_orders
    node { pubkey }
    min_amount { satoshi { sats } }
    max_amount { satoshi { sats } }
    total_amount { satoshi { sats } }
    locked_amount { satoshi { sats } }
    fees { fixed { sats } variable { sats } }
    promises { min_block_length fee_rate_cap base_fee_cap }
    conditions { condition operator value }
    onchain_priority onchain_multiplier
  } } } }
}`;

type Sats = { satoshi: { sats: string } | null } | null;
interface RawMyOffer {
  id: string;
  node: { pubkey: string } | null;
  status: string;
  created_at: string;
  filled_orders: number;
  min_amount: Sats;
  max_amount: Sats;
  total_amount: Sats;
  locked_amount: Sats;
  fees: { fixed: { sats: string }; variable: { sats: string } };
  promises: { min_block_length: number; fee_rate_cap: string | null; base_fee_cap: string | null };
  conditions?: OfferCondition[] | null;
  onchain_priority?: string | null;
  onchain_multiplier?: number | null;
}

function toMyOffer(o: RawMyOffer): MyOffer {
  const total = satsOf(o.total_amount?.satoshi?.sats);
  const locked = satsOf(o.locked_amount?.satoshi?.sats);
  return {
    id: o.id,
    nodePubkey: o.node?.pubkey ?? "",
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
    conditions: (o.conditions ?? []).map((c) => ({ condition: c.condition, operator: c.operator, value: String(c.value) })),
    onchainPriority: o.onchain_priority ?? null,
    onchainMultiplier: typeof o.onchain_multiplier === "number" && Number.isFinite(o.onchain_multiplier) ? o.onchain_multiplier : null,
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

/**
 * Your offers for the node `ownPubkey` (the list carries no size window, so
 * each is read in full). One Amboss account can hold offers for several
 * nodes: without `ownPubkey` every offer of the account is returned — callers
 * that act on offers must pass it, so another node's offer is never repriced,
 * resized, enabled or disabled from here.
 */
export async function getMyOffers(apiKey: string, ownPubkey?: string): Promise<MyOffer[]> {
  // Each offer once, however Amboss pages the list (collectPages). Before,
  // pages were counted against `total`: had this listing ignored the page
  // like the public one does, an account with more than 50 offers would have
  // had each read — and upkept — twice a run.
  const { items } = await collectPages(
    async (page) => {
      const data = await ambossGql<{
        user: { market: { offers: { offers: { list: { id: string; node: { pubkey: string } | null }[]; total: number } } } };
      }>(MAGMA_URL, MY_OFFER_IDS_QUERY, apiKey, { page });
      return data.user.market.offers.offers;
    },
    (o) => o.id,
    { pageSize: PAGE, maxPages: MAX_PAGES },
  );
  const ids = items.filter((o) => ownPubkey === undefined || o.node?.pubkey === ownPubkey).map((o) => o.id);
  const offers = await Promise.all(ids.map((id) => getMyOffer(apiKey, id)));
  // The full read says it again (a listing without the node would let one through).
  return ownPubkey === undefined ? offers : offers.filter((o) => o.nodePubkey === ownPubkey);
}

/** The offer fields this app sets. Sizes in sats, fee rate in ppm, base fee
 *  in sats, lease in blocks. Every write sends all of them (see updateOffer). */
export interface OfferTerms {
  totalSizeSats: number;
  minSizeSats: number;
  maxSizeSats: number;
  feeRatePpm: number;
  baseFeeSats: number;
  minBlockLength: number;
  /** Routing-fee caps promised for the lease (null: none promised). */
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  /** What LightningMate doesn't set but must send back as it is (an update
   *  that leaves a term out may reset it): buyer conditions, on-chain fee
   *  settings. None / null for an offer it creates. */
  conditions: OfferCondition[];
  onchainPriority: string | null;
  onchainMultiplier: number | null;
}

/** The terms LightningMate leaves as they are, for an offer it creates. */
export const NO_EXTRA_TERMS = { conditions: [] as OfferCondition[], onchainPriority: null, onchainMultiplier: null };

/** An offer's complete terms as Amboss has them now — the starting point of
 *  any write that changes some of them. */
export const termsOf = (o: MyOffer): OfferTerms => ({
  totalSizeSats: o.totalSizeSats,
  minSizeSats: o.minSizeSats,
  maxSizeSats: o.maxSizeSats,
  feeRatePpm: o.feeRatePpm,
  baseFeeSats: o.baseFeeSats,
  minBlockLength: o.minBlockLength,
  feeRateCapPpm: o.feeRateCapPpm,
  baseFeeCapSats: o.baseFeeCapSats,
  conditions: o.conditions.map((c) => ({ ...c })),
  onchainPriority: o.onchainPriority,
  onchainMultiplier: o.onchainMultiplier,
});

const offerInput = (p: OfferTerms): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    total_size: p.totalSizeSats,
    min_size: p.minSizeSats,
    max_size: p.maxSizeSats,
    fee_rate: p.feeRatePpm,
    base_fee: p.baseFeeSats,
    min_block_length: p.minBlockLength,
  };
  // No promise is sent as none: Amboss clears a cap an update leaves out.
  if (p.feeRateCapPpm !== null) out.fee_rate_cap = p.feeRateCapPpm;
  if (p.baseFeeCapSats !== null) out.base_fee_cap = p.baseFeeCapSats;
  // Sent back as they are (none: left out, as an offer that has none).
  if (p.conditions.length) out.conditions = p.conditions.map((c) => ({ condition: c.condition, operator: c.operator, value: c.value }));
  if (p.onchainPriority !== null) out.onchain_priority = p.onchainPriority;
  if (p.onchainMultiplier !== null) out.onchain_multiplier = p.onchainMultiplier;
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

/**
 * Replace an offer's terms. ALL of them are sent, every time — Amboss's update
 * is not partial, whatever its optional inputs suggest. Seen live on
 * 2026-10-23: an update that sent only the routing-fee caps set the fee rate
 * to 0 (the offer was listed for free for half an hour, and Amboss matched a
 * 1.95M sat order to it at 0 sats), and the next one, sending the fee rate,
 * cleared the caps. Hence `terms` is complete by type (termsOf for the rest).
 * True only when Amboss reports success; the caller reads the offer back and
 * compares every field (termsMatch) to know the terms hold.
 */
export async function updateOffer(apiKey: string, offerId: string, terms: OfferTerms): Promise<boolean> {
  const data = await ambossGql<{ market: { offer: { update: { success: boolean } } } }>(
    MAGMA_URL,
    UPDATE_OFFER_MUTATION,
    apiKey,
    { input: { offer_id: offerId, ...offerInput(terms) } },
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
  /** The node that sells (opens the channel): one Amboss account can sell
   *  for several nodes — only this node's orders are LightningMate's. */
  sellerPubkey: string;
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
      options { is_private }
      source { pubkey }`;

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
  source: { pubkey: string } | null;
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
    sellerPubkey: o.source?.pubkey ?? "",
    isPrivate: o.options?.is_private === true,
  };
}

export interface SalesFilter {
  /** Only orders where the seller has to act now. */
  actionNeeded?: boolean;
  status?: readonly string[];
}

/** Your sales, newest first, all pages (bounded), each order once — however
 *  Amboss pages the list (collectPages). */
export async function listSales(apiKey: string, filter: SalesFilter = {}): Promise<{ orders: SaleOrder[]; total: number }> {
  const input: Record<string, unknown> = {};
  if (filter.actionNeeded !== undefined) input.action_needed = filter.actionNeeded;
  if (filter.status) input.status = [...filter.status];
  const { items, total } = await collectPages(
    async (page) => {
      const data = await ambossGql<{
        user: { market: { orders: { sales: { list: RawSale[]; total: number } } } };
      }>(MAGMA_URL, SALES_QUERY, apiKey, { input, page });
      return data.user.market.orders.sales;
    },
    (o) => o.id,
    { pageSize: PAGE, maxPages: MAX_PAGES },
  );
  return { orders: items.map(toSale), total };
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

/** All your sales (seller side) for the node `ownPubkey`, newest first, plus
 *  how many wait on you. Without `ownPubkey`, every sale of the account (one
 *  account can sell for several nodes). */
export async function getMyOrders(apiKey: string, ownPubkey?: string): Promise<MyOrdersView> {
  const { orders } = await listSales(apiKey);
  const views = orders.filter((o) => ownPubkey === undefined || o.sellerPubkey === ownPubkey).map((o) => toMyOrder(o));
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
