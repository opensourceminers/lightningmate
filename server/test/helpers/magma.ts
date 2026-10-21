import type { FetchMock, RecordedRequest } from "./fetchMock.js";
import { hang } from "./fetchMock.js";
import { makeNodeKey, makePaymentRequest, parsePaymentRequest } from "./bolt11.js";
import { checkDocument, checkVariables, magmaSchema, parseOperation } from "./graphqlSchema.js";
import type { FakeLnd } from "./fakeLnd.js";
import type { AfterHook } from "./tmp.js";

export const MAGMA_API = "https://magma.amboss.tech/graphql";

/**
 * A fake Amboss Magma API (magma.amboss.tech) for the seller side: your sales,
 * your offers, accept / add_transaction / reject, offer create / update /
 * toggle, and the key check — served through the fetch mock.
 *
 * Every request is checked against the saved Magma schema (document AND the
 * variables actually sent); a mismatch is answered like the real API would
 * (a GraphQL validation error) and fails the test in the after-hook.
 *
 * Orders move like Amboss moves them: accept → WAITING_FOR_BUYER_PAYMENT;
 * `buyerPays(id, node)` pays the HODL invoice we sent (held in the fake LND)
 * → WAITING_FOR_CHANNEL_OPEN; add_transaction → SELLER_SENT_TRANSACTION;
 * `setStatus(id, "VALID_CHANNEL_OPENING")` → the channel is confirmed.
 * Each mutation's outcome can be scripted (`behave`).
 */

export interface FakeSale {
  id: string;
  status: string;
  timeout: string | null;
  createdAt: string;
  sizeSats: number;
  /** fees.* as decimal sats strings. */
  feeSeller: string;
  feeFixed: string;
  feeVariable: string;
  buyerPubkey: string;
  buyerAlias: string | null;
  /** The node that sells (MarketOrder.source). Unset: the fake's
   *  `sellerPubkey` — the node under test, once the test says which. */
  sellerPubkey?: string;
  sockets: string[];
  isPrivate: boolean;
  assetType: "BASE_ASSET" | "TAPROOT_ASSET";
  paymentStatus: string | null;
  channelId: string | null;
  transactionId: string | null;
  promises: { minBlockLength: number; feeRateCap: string; baseFeeCap: string };
  /** What we sent: the HODL invoice (accept), the outpoint (add_transaction). */
  paymentRequest?: string;
}

export interface FakeOfferState {
  id: string;
  /** The node the offer sells for. Unset: the fake's `sellerPubkey`. */
  pubkey?: string;
  status: string;
  createdAt: string;
  filledOrders: number;
  totalSats: number;
  lockedSats: number;
  minSats: number;
  maxSats: number;
  baseFeeSats: number;
  feeRatePpm: number;
  minBlockLength: number;
  feeRateCap: string | null;
  baseFeeCap: string | null;
}

/** What a mutation does. "throw": HTTP 502. "hang": no answer (the caller's
 *  deadline fires). "apply-then-hang": Amboss applies it but the answer never
 *  arrives. "false": answers success:false and changes nothing. "lie":
 *  answers success:true and changes nothing. "invalid": Amboss rejects the
 *  request itself, as after a change of its schema — HTTP 400 with a GraphQL
 *  validation error — and changes nothing. */
export type Behaviour = "ok" | "false" | "throw" | "hang" | "apply-then-hang" | "lie" | "invalid";

/** The answer of a GraphQL server to a query its schema no longer has. */
export function schemaChanged(): Response {
  return Response.json(
    {
      errors: [
        {
          message: 'Cannot query field "fees" on type "MarketOrder".',
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        },
      ],
    },
    { status: 400 },
  );
}

export const SALE_DEFAULTS = {
  sizeSats: 2_000_000,
  feeSeller: "12345",
} as const;

let nextId = 1;

export function makeSale(o: Partial<FakeSale> & { buyerPubkey: string }): FakeSale {
  return {
    id: o.id ?? `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
    status: "WAITING_FOR_SELLER_APPROVAL",
    timeout: new Date(Date.now() + 15 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    sizeSats: SALE_DEFAULTS.sizeSats,
    feeSeller: SALE_DEFAULTS.feeSeller,
    feeFixed: "0",
    feeVariable: "0",
    buyerAlias: "buyer",
    sockets: ["1.2.3.4:9735"],
    isPrivate: false,
    assetType: "BASE_ASSET",
    paymentStatus: null,
    channelId: null,
    transactionId: null,
    promises: { minBlockLength: 4320, feeRateCap: "2200", baseFeeCap: "1" },
    ...o,
  };
}

const ACTION_NEEDED = new Set(["WAITING_FOR_SELLER_APPROVAL", "WAITING_FOR_CHANNEL_OPEN", "SELLER_SENT_TRANSACTION"]);

const OPS = /^\s*(query|mutation)\s+(Sales|Sale|AcceptOrder|AddTransaction|RejectOrder|MyOfferIds|MyOffer|CreateOffer|UpdateOffer|ToggleOffer|KeyCheck|Order|Buy|CancelOrder|GetOrder)\b/;

/** An order this node placed as a BUYER (market.order.create — or
 *  liquidity.buy, where Amboss picks the seller: no offer id). */
export interface FakePurchase {
  id: string;
  offerId: string | null;
  pubkey: string;
  sizeSats: number;
  status: string;
  paymentRequest: string;
  channelId: string | null;
  /** The seller (MarketOrder.source). */
  sellerPubkey: string;
  /** The terms the order locked (MarketOrder.promises). */
  promises: { minBlockLength: number; feeRateCap: string; baseFeeCap: string };
  cancelled?: string;
}

const sats = (n: number | string) => ({ sats: String(n) });
const size = (n: number) => ({ satoshi: sats(n) });

export class FakeMagma {
  readonly sales = new Map<string, FakeSale>();
  readonly offers = new Map<string, FakeOfferState>();
  /** Every problem a request had against the schema (must stay empty). */
  readonly schemaErrors: string[] = [];
  /** Every mutation by operation name, with its variables. */
  readonly calls: { op: string; variables: Record<string, unknown> }[] = [];
  keyValid = true;
  /** The node this account sells for unless a sale or offer names another —
   *  set it to the node under test (sellerSetup does). One Amboss account
   *  can sell for several nodes: a sale or offer with another `sellerPubkey`
   *  / `pubkey` belongs to another node of the same account. */
  sellerPubkey = "02" + "11".repeat(32);
  /** Scripted outcomes, per operation (default "ok"). A function decides per call. */
  behave: Partial<
    Record<
      "AcceptOrder" | "AddTransaction" | "RejectOrder" | "UpdateOffer" | "CreateOffer" | "ToggleOffer" | "Order" | "Buy" | "CancelOrder",
      Behaviour | ((n: number) => Behaviour)
    >
  > = {};
  /** Answers to the read queries: "throw" (HTTP 502) or "hang". */
  readBehaviour: Behaviour = "ok";
  /** How the offer and sales listings answer their `page` argument.
   *  "whole-list": every page is the whole list, `total` its length — what
   *  magma.amboss.tech's public offer list does (checked 2026-10-21; the
   *  keyed listings could not be checked without a key, so LightningMate
   *  reads them as if they did the same). "pages": offset/limit honoured. */
  paging: "whole-list" | "pages" = "whole-list";
  /** Answers to a BUYER's order read (get_order of a purchase) only — the
   *  seller's reads go on as `readBehaviour` says. */
  orderReadBehaviour: Behaviour = "ok";
  /** Scripted answers to one order's read (get_order), e.g. `gqlError(…)`:
   *  return the answer to send instead of the order, or null to answer as
   *  usual. `n` is the zero-based index of the read of that order. */
  saleRead: ((id: string, n: number) => Response | Record<string, unknown> | null) | null = null;
  private readonly saleReads = new Map<string, number>();
  /** Scripted answers to the sales listing, by its filter (action_needed,
   *  status): the answer to send instead, or null to answer as usual. */
  salesList: ((filter: { action_needed?: boolean; status?: string[] }) => Response | Record<string, unknown> | null) | null = null;
  /** Orders placed as a buyer, by id. */
  readonly purchases = new Map<string, FakePurchase>();
  /** The node Amboss's buyer invoices are issued by. */
  readonly ambossNode = makeNodeKey();
  /** What a targeted buy costs the buyer (fees.buyer), and Amboss's part of it. */
  buyerFeeSats = 5_068;
  buyerAmbossFeeSats = 1_500;
  /** The terms a buy locks (promises). */
  buyPromises = { minBlockLength: 4320, feeRateCap: "2200", baseFeeCap: "1" };
  /** A dollar buy (liquidity.buy): the channel Amboss matched, and its seller. */
  usdBuySizeSats = 2_500_000;
  matchedSeller = "03" + "5e".repeat(32);
  /** Runs as each mutation arrives, before Amboss acts on it (e.g. SIGTERM
   *  arriving while Amboss is answering). */
  onMutation: ((op: string, variables: Record<string, unknown>) => void) | null = null;
  private readonly counts = new Map<string, number>();

  constructor(http: FetchMock, t?: AfterHook) {
    http.onGraphql(MAGMA_API, OPS, (variables, req) => this.handle(variables, req));
    t?.after(() => {
      if (this.schemaErrors.length) {
        throw new Error(`requests that don't match the Magma schema:\n  ${this.schemaErrors.join("\n  ")}`);
      }
    });
  }

  addSale(o: Partial<FakeSale> & { buyerPubkey: string }): FakeSale {
    const sale = makeSale(o);
    this.sales.set(sale.id, sale);
    return sale;
  }

  addOffer(o: Partial<FakeOfferState> = {}): FakeOfferState {
    const offer: FakeOfferState = {
      id: o.id ?? `offer-${nextId++}`,
      status: "ENABLED",
      createdAt: new Date().toISOString(),
      filledOrders: 0,
      totalSats: 5_000_000,
      lockedSats: 0,
      minSats: 1_000_000,
      maxSats: 5_000_000,
      baseFeeSats: 852,
      feeRatePpm: 3000,
      minBlockLength: 4320,
      feeRateCap: null,
      baseFeeCap: null,
      ...o,
    };
    this.offers.set(offer.id, offer);
    return offer;
  }

  setStatus(id: string, status: string): void {
    const s = this.sales.get(id);
    if (!s) throw new Error(`no sale ${id}`);
    s.status = status;
  }

  /** The buyer pays the HODL invoice we accepted with: held in the fake LND,
   *  and Amboss moves the order on. Returns the invoice's payment hash. */
  buyerPays(id: string, node: FakeLnd): string {
    const s = this.sales.get(id);
    if (!s?.paymentRequest) throw new Error(`order ${id} was not accepted with an invoice`);
    const hash = parsePaymentRequest(s.paymentRequest).id;
    node.payHoldInvoice(hash);
    s.status = "WAITING_FOR_CHANNEL_OPEN";
    s.paymentStatus = "SUCCESSFUL_PAYMENT";
    return hash;
  }

  /** How many times an operation was called. */
  count(op: string): number {
    return this.counts.get(op) ?? 0;
  }

  /** This call's scripted outcome; `n` is the zero-based index of the call. */
  private outcome(op: keyof FakeMagma["behave"]): Behaviour {
    const n = this.count(op) - 1;
    const b = this.behave[op] ?? "ok";
    return typeof b === "function" ? b(n) : b;
  }

  private async handle(variables: Record<string, unknown>, req: RecordedRequest): Promise<Response | Record<string, unknown>> {
    const query = req.graphql?.query ?? "";
    const errors = [...checkDocument(magmaSchema(), query), ...checkVariables(magmaSchema(), query, variables)];
    const op = parseOperation(query).name ?? "";
    this.counts.set(op, this.count(op) + 1);
    if (errors.length) {
      this.schemaErrors.push(...errors.map((e) => `${op}: ${e}`));
      return Response.json({ errors: errors.map((message) => ({ message, extensions: { code: "GRAPHQL_VALIDATION_FAILED" } })) }, { status: 400 });
    }
    if (op !== "KeyCheck" && !req.headers.authorization?.startsWith("Bearer ")) return forbidden(op);
    if (!this.keyValid) return forbidden(op);
    if (req.graphql?.isMutation) {
      this.calls.push({ op, variables });
      this.onMutation?.(op, variables);
    }

    const read = (data: () => unknown): Promise<Response | Record<string, unknown>> | Response | Record<string, unknown> => {
      if (this.readBehaviour === "throw") return new Response("upstream error", { status: 502 });
      if (this.readBehaviour === "hang") return hang(req);
      if (this.readBehaviour === "invalid") return schemaChanged();
      return { data: data() };
    };
    /** Scripted mutation: `apply` changes Amboss's state and says whether it took. */
    const mutate = (name: keyof FakeMagma["behave"], apply: () => boolean, answer: (ok: boolean) => unknown) => {
      const b = this.outcome(name);
      if (b === "throw") return new Response("upstream error", { status: 502 });
      if (b === "hang") return hang(req);
      if (b === "invalid") return schemaChanged();
      if (b === "false") return { data: answer(false) };
      if (b === "lie") return { data: answer(true) };
      const ok = apply();
      if (b === "apply-then-hang") return hang(req);
      return { data: answer(ok) };
    };
    const input = (variables.input ?? {}) as Record<string, unknown>;

    switch (op) {
      case "KeyCheck":
        return this.keyValid && req.headers.authorization ? { data: { user: { id: "user-1" } } } : forbidden(op);
      case "Sales": {
        const filter = (variables.input ?? {}) as { action_needed?: boolean; status?: string[] };
        const scripted = this.salesList?.(filter);
        if (scripted) return scripted;
        return read(() => {
          const page = (variables.page ?? { limit: 50, offset: 0 }) as { limit: number; offset: number };
          const all = [...this.sales.values()]
            .filter((s) => (filter.action_needed ? ACTION_NEEDED.has(s.status) : true))
            .filter((s) => (filter.status ? filter.status.includes(s.status) : true))
            .reverse();
          const answered = this.paging === "pages" ? all.slice(page.offset, page.offset + page.limit) : all;
          return {
            user: { market: { orders: { sales: { list: answered.map((s) => this.simple(s)), total: all.length } } } },
          };
        });
      }
      case "Sale": {
        const id = String(variables.id);
        const n = this.saleReads.get(id) ?? 0;
        this.saleReads.set(id, n + 1);
        const scripted = this.saleRead?.(id, n);
        if (scripted) return scripted;
        const s = this.sales.get(id);
        if (!s) return orderNotFound();
        return read(() => ({ user: { market: { orders: { get_order: this.full(s) } } } }));
      }
      case "AcceptOrder":
        return mutate(
          "AcceptOrder",
          () => {
            const s = this.sales.get(String(input.order_id));
            if (!s || s.status !== "WAITING_FOR_SELLER_APPROVAL") return false;
            s.paymentRequest = String(input.payment_request);
            s.status = "WAITING_FOR_BUYER_PAYMENT";
            s.timeout = null;
            return true;
          },
          (ok) => ({ market: { order: { seller: { accept: { success: ok } } } } }),
        );
      case "AddTransaction":
        return mutate(
          "AddTransaction",
          () => {
            const s = this.sales.get(String(input.order_id));
            if (!s || (s.status !== "WAITING_FOR_CHANNEL_OPEN" && s.status !== "SELLER_SENT_TRANSACTION")) return false;
            s.transactionId = String(input.tx_id);
            s.status = "SELLER_SENT_TRANSACTION";
            return true;
          },
          (ok) => ({ market: { order: { seller: { add_transaction: { success: ok } } } } }),
        );
      case "RejectOrder":
        return mutate(
          "RejectOrder",
          () => {
            const s = this.sales.get(String(input.order_id));
            if (!s || s.status !== "WAITING_FOR_SELLER_APPROVAL") return false;
            s.status = "SELLER_REJECTED";
            return true;
          },
          (ok) => ({ market: { order: { seller: { reject: { success: ok } } } } }),
        );
      case "MyOfferIds":
        return read(() => {
          const page = (variables.page ?? { limit: 50, offset: 0 }) as { limit: number; offset: number };
          const all = [...this.offers.values()];
          const answered = this.paging === "pages" ? all.slice(page.offset, page.offset + page.limit) : all;
          return {
            user: {
              market: {
                offers: {
                  offers: {
                    list: answered.map((o) => ({ id: o.id, node: { pubkey: o.pubkey ?? this.sellerPubkey } })),
                    total: all.length,
                  },
                },
              },
            },
          };
        });
      case "MyOffer": {
        const o = this.offers.get(String(variables.id));
        if (!o) return { errors: [{ message: "Offer not found" }], data: null };
        return read(() => ({ user: { market: { offers: { get_offer: this.offer(o) } } } }));
      }
      case "CreateOffer":
        return mutate(
          "CreateOffer",
          () => {
            const created = this.addOffer({
              pubkey: String(input.pubkey),
              totalSats: Number(input.total_size),
              minSats: Number(input.min_size ?? 1_000_000),
              maxSats: Number(input.max_size ?? input.total_size),
              feeRatePpm: Number(input.fee_rate ?? 0),
              baseFeeSats: Number(input.base_fee ?? 0),
              minBlockLength: Number(input.min_block_length),
              feeRateCap: input.fee_rate_cap === undefined ? null : String(input.fee_rate_cap),
              baseFeeCap: input.base_fee_cap === undefined ? null : String(input.base_fee_cap),
            });
            this.lastCreated = created.id;
            return true;
          },
          (ok) => ({ market: { offer: { create: { offer_id: ok ? this.lastCreated : "" } } } }),
        );
      case "UpdateOffer":
        return mutate(
          "UpdateOffer",
          () => {
            const o = this.offers.get(String(input.offer_id));
            if (!o) return false;
            if (input.total_size !== undefined) o.totalSats = Number(input.total_size);
            if (input.min_size !== undefined) o.minSats = Number(input.min_size);
            if (input.max_size !== undefined) o.maxSats = Number(input.max_size);
            if (input.fee_rate !== undefined) o.feeRatePpm = Number(input.fee_rate);
            if (input.base_fee !== undefined) o.baseFeeSats = Number(input.base_fee);
            if (input.min_block_length !== undefined) o.minBlockLength = Number(input.min_block_length);
            if (input.fee_rate_cap !== undefined) o.feeRateCap = String(input.fee_rate_cap);
            if (input.base_fee_cap !== undefined) o.baseFeeCap = String(input.base_fee_cap);
            return true;
          },
          (ok) => ({ market: { offer: { update: { success: ok } } } }),
        );
      case "ToggleOffer":
        return mutate(
          "ToggleOffer",
          () => {
            const o = this.offers.get(String(input.offer_id));
            if (!o || o.status === "ADMIN_DISABLED") return false;
            o.status = o.status === "ENABLED" ? "DISABLED" : "ENABLED";
            return true;
          },
          () => ({ market: { offer: { toggle: { status: this.offers.get(String(input.offer_id))?.status ?? "DISABLED" } } } }),
        );
      case "Order": {
        let created: FakePurchase | null = null;
        return mutate(
          "Order",
          () => {
            const id = `00000000-0000-4000-9000-${String(nextId++).padStart(12, "0")}`;
            const invoice = makePaymentRequest({ key: this.ambossNode, tokens: this.buyerFeeSats, description: `Magma order ${id}` });
            created = {
              id,
              offerId: String(input.offer_id),
              pubkey: String(input.pubkey),
              sizeSats: Number(input.size),
              status: "WAITING_FOR_SELLER_APPROVAL",
              paymentRequest: invoice.request,
              channelId: null,
              sellerPubkey: this.matchedSeller,
              promises: { ...this.buyPromises },
            };
            this.purchases.set(id, created);
            return true;
          },
          (ok) => {
            const p = created as FakePurchase | null;
            if (!ok || !p) return { market: { order: { create: null } } };
            return {
              market: {
                order: {
                  create: {
                    id: p.id,
                    amount: size(p.sizeSats),
                    fees: { buyer: sats(this.buyerFeeSats), amboss: sats(this.buyerAmbossFeeSats) },
                    promises: {
                      locked_min_block_length: this.buyPromises.minBlockLength,
                      locked_fee_rate_cap: sats(this.buyPromises.feeRateCap),
                      locked_base_fee_cap: sats(this.buyPromises.baseFeeCap),
                    },
                    payment: { lightning: { invoice: p.paymentRequest } },
                  },
                },
              },
            };
          },
        );
      }
      case "Buy": {
        // liquidity.buy: dollars in, Amboss matches the seller; the answer
        // names no size, lease or seller — the order does, once read.
        let created: FakePurchase | null = null;
        return mutate(
          "Buy",
          () => {
            const id = `00000000-0000-4000-a000-${String(nextId++).padStart(12, "0")}`;
            const invoice = makePaymentRequest({ key: this.ambossNode, tokens: this.buyerFeeSats, description: `Magma order ${id}` });
            created = {
              id,
              offerId: null,
              pubkey: "",
              sizeSats: this.usdBuySizeSats,
              status: "WAITING_FOR_SELLER_APPROVAL",
              paymentRequest: invoice.request,
              channelId: null,
              sellerPubkey: this.matchedSeller,
              promises: { ...this.buyPromises },
            };
            this.purchases.set(id, created);
            return true;
          },
          (ok) => {
            const p = created as FakePurchase | null;
            if (!ok || !p) return { liquidity: { buy: null } };
            return {
              liquidity: {
                buy: {
                  order: { transaction_id: p.id, usd_cents: String(input.usd_cents) },
                  payment: { lightning_invoice: p.paymentRequest, amount: sats(this.buyerFeeSats) },
                },
              },
            };
          },
        );
      }
      case "CancelOrder":
        return mutate(
          "CancelOrder",
          () => {
            const p = this.purchases.get(String(input.order_id));
            if (!p) return false;
            p.cancelled = String(input.cancellation_reason);
            p.status = "BUYER_REJECTED";
            return true;
          },
          (ok) => ({ market: { order: { cancel: { success: ok } } } }),
        );
      case "GetOrder": {
        if (this.orderReadBehaviour === "hang") return hang(req);
        if (this.orderReadBehaviour === "throw") return new Response("upstream error", { status: 502 });
        const p = this.purchases.get(String(variables.id));
        if (!p) return orderNotFound();
        return read(() => ({
          user: {
            market: {
              orders: {
                get_order: {
                  status: p.status,
                  payment_status: null,
                  channel_id: p.channelId,
                  amount: size(p.sizeSats),
                  promises: {
                    locked_min_block_length: p.promises.minBlockLength,
                    locked_fee_rate_cap: sats(p.promises.feeRateCap),
                    locked_base_fee_cap: sats(p.promises.baseFeeCap),
                  },
                  source: { pubkey: p.sellerPubkey },
                },
              },
            },
          },
        }));
      }
    }
    return { errors: [{ message: `fake Magma: unhandled ${op}` }] };
  }

  private lastCreated = "";

  private simple(s: FakeSale) {
    return {
      id: s.id,
      status: s.status,
      timeout: s.timeout,
      created_at: s.createdAt,
      payment_status: s.paymentStatus,
      channel_id: s.channelId,
      amount: size(s.sizeSats),
      asset: { type: s.assetType },
      fees: { seller: sats(s.feeSeller), fixed: sats(s.feeFixed), variable: sats(s.feeVariable) },
      options: { is_private: s.isPrivate },
      source: { pubkey: s.sellerPubkey ?? this.sellerPubkey },
      destination: { pubkey: s.buyerPubkey, alias: s.buyerAlias },
    };
  }

  private full(s: FakeSale) {
    return {
      ...this.simple(s),
      is_seller: true,
      transaction_id: s.transactionId,
      blocks_until_can_be_closed: s.status === "CHANNEL_MONITORING_FINISHED" ? 0 : null,
      destination: { pubkey: s.buyerPubkey, alias: s.buyerAlias, sockets: s.sockets },
      promises: {
        locked_min_block_length: s.promises.minBlockLength,
        locked_fee_rate_cap: sats(s.promises.feeRateCap),
        locked_base_fee_cap: sats(s.promises.baseFeeCap),
      },
      confirmations: s.transactionId ? { confirmations: 0 } : null,
    };
  }

  private offer(o: FakeOfferState) {
    return {
      id: o.id,
      node: { pubkey: o.pubkey ?? this.sellerPubkey },
      status: o.status,
      created_at: o.createdAt,
      filled_orders: o.filledOrders,
      min_amount: size(o.minSats),
      max_amount: size(o.maxSats),
      total_amount: size(o.totalSats),
      locked_amount: size(o.lockedSats),
      fees: { fixed: sats(o.baseFeeSats), variable: sats(o.feeRatePpm) },
      promises: { min_block_length: o.minBlockLength, fee_rate_cap: o.feeRateCap, base_fee_cap: o.baseFeeCap },
    };
  }
}

/** A GraphQL error inside an HTTP 200 answer — how Amboss's (NestJS/Apollo)
 *  server reports a resolver that failed, a rate limit, or an unknown order. */
export function gqlError(message: string, extensions: Record<string, unknown>) {
  return { errors: [{ message, path: ["user"], extensions }], data: null };
}

/** A resolver that threw: Apollo's default answer, no status of its own. */
export const resolverFailed = () => gqlError("Unexpected error.", { code: "INTERNAL_SERVER_ERROR" });

/** NestJS's answer for a resolver that threw an InternalServerErrorException:
 *  its 500 reported inside the GraphQL error, with HTTP 200. */
export const internalError = () =>
  gqlError("Internal server error", { code: "INTERNAL_SERVER_ERROR", originalError: { statusCode: 500, message: "Internal server error" } });

/** NestJS's rate limiter (ThrottlerException, 429) inside a GraphQL answer. */
export const throttled = () =>
  gqlError("ThrottlerException: Too Many Requests", {
    code: "INTERNAL_SERVER_ERROR",
    originalError: { statusCode: 429, message: "ThrottlerException: Too Many Requests" },
  });

/** Amboss has no such order. */
export const orderNotFound = () => gqlError("Order not found", { code: "NOT_FOUND" });

/** The answer an unknown, revoked or missing key gets (seen live). */
export function forbidden(op: string) {
  return {
    errors: [
      {
        message: "Forbidden resource",
        path: [op === "KeyCheck" ? "user" : "market"],
        extensions: { code: "FORBIDDEN", originalError: { message: "Forbidden resource", error: "Forbidden", statusCode: 403 } },
      },
    ],
    data: null,
  };
}

/** The payment hash and amount of the HODL invoice an order was accepted with. */
export function acceptedInvoice(sale: FakeSale) {
  if (!sale.paymentRequest) throw new Error(`order ${sale.id} has no invoice`);
  return parsePaymentRequest(sale.paymentRequest);
}
