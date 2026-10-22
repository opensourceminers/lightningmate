import { JsonStore } from "../store.js";
import type { OrderState } from "./amboss.js";

/**
 * Inbound this node bought on Magma — a persistent record (a4-lsp-payments:
 * buy-flow-size-and-tracking). Before, a purchase lived in the browser tab's
 * state and an in-memory map: a quote the buyer declined stayed a live order on
 * Amboss, leaving the tab or restarting lost the purchase's tracking, and P&L
 * never saw what inbound cost. Now every quote is recorded when Amboss creates
 * the order; declining it cancels the order on Amboss; paying pays only the
 * invoice recorded with the quote (unexpired, to the payee it named, for the
 * amount the buyer confirmed); and the order is followed until its channel
 * opens or it fails. The analytics package reads `paidCosts()` for P&L.
 *
 * The record converges on what LND and Amboss report, whatever this process
 * saw. A Magma purchase is paid to a hold invoice: the payment stays in flight
 * until the seller's channel is confirmed — minutes to hours. Before, only the
 * pay call's own answer, in this process, could record it paid: a restart in
 * that window left the record "paying" for good (paid and delivered, yet
 * missing from P&L), a pay stream that dropped while LND kept the HTLC in
 * flight recorded "payment failed" and was never looked at again, and a late
 * answer could turn "channel open" back into "paid". Now the order lane asks
 * LND by payment hash how each payment ended (and Amboss how each order
 * stands) until both are known, and no report moves a record backwards.
 */

export type PurchaseState =
  /** Amboss created the order; nothing paid. */
  | "quoted"
  /** The buyer declined the quote: the order was cancelled on Amboss. */
  | "declined"
  /** Declined, but Amboss didn't confirm the cancel (it expires unpaid). */
  | "cancel_failed"
  | "paying"
  | "paid"
  | "pay_failed"
  /** The seller's channel is open (Amboss: VALID_CHANNEL_OPENING or later). */
  | "channel_open"
  /** Amboss ended the order (a seller that didn't deliver: refunded). */
  | "order_failed";

export interface MagmaPurchase {
  orderId: string;
  createdAt: string;
  updatedAt: string;
  /** The offer bought from, when the buyer picked one (null: Amboss matched). */
  offerId: string | null;
  sellerPubkey: string | null;
  sizeSats: number;
  /** What the buyer pays (the invoice amount: seller's fee + Amboss's). */
  feeSats: number;
  paymentRequest: string;
  paymentHash: string;
  /** The invoice's payee, as decoded at quote time — pay binds to it. */
  payee: string;
  expiresAt: string;
  leaseBlocks: number | null;
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  usdCents: number | null;
  state: PurchaseState;
  /** Lightning routing fee paid on the invoice (from LND; null: not known yet). */
  routingFeeSats: number | null;
  /** When the payment settled (LND's time when it says; else when Amboss
   *  first reported the channel open — it opens only once paid). */
  paidAt?: string;
  /** When the (last) payment attempt started. */
  payStartedAt?: string;
  /** LND confirmed that the payment failed (or never left this node): the
   *  record is not followed any more. A failure the pay call reported
   *  without LND's word — a dropped stream, a restart — is checked again. */
  failureConfirmed?: boolean;
  /** LND has no record of this payment, though Amboss reports the channel
   *  open: the routing fee stays unknown (it isn't asked for again). */
  paymentNotFound?: boolean;
  orderStatus: string | null;
  channelId: string | null;
  error?: string;
}

/** How a purchase's payment stands, as LND reports it (by payment hash) or
 *  as the pay call answered. */
export type PaymentReport =
  | { status: "succeeded"; feeSats: number; at?: string }
  | { status: "in_flight" }
  /** `confirmed`: LND's own word (the payment failed, or it never saw one);
   *  false: only the pay call said so — it may still be in flight. */
  | { status: "failed"; error: string; confirmed: boolean }
  /** LND has no payment with this hash. */
  | { status: "not_found" };

/** Purchases that carry no cost and no lease (quotes declined or never paid,
 *  orders that failed) are kept up to this many; one that was paid — a cost
 *  in P&L for every window, "All" included — or may still be, is never
 *  dropped (review a8-engineering:pnl-accounting-truncated: every record
 *  past the newest 300 went, paid ones too). */
const KEPT = 300;

/** A record P&L or a lease still needs: paid, opened, or a payment that may
 *  still be moving. */
const carriesCost = (p: MagmaPurchase): boolean =>
  p.state === "paid" || p.state === "channel_open" || PAYMENT_OPEN(p) || !!p.paidAt;

/**
 * What the order says that the record doesn't yet: a dollar buy
 * (liquidity.buy — Amboss picks the seller) is quoted with no channel size,
 * lease, seller or fee promise; Amboss's order names them once it matched a
 * seller. Before, such a purchase kept size 0 and no lease for good — the
 * Purchases table showed "—", and paidCosts() (P&L) had nothing to spread
 * its cost over. Only what the record lacks is filled in (a targeted buy's
 * quote already said it). Null: nothing new.
 */
function termsLearned(p: MagmaPurchase, o: OrderState): Partial<MagmaPurchase> | null {
  const t: Partial<MagmaPurchase> = {};
  if (!(p.sizeSats > 0) && o.channelSizeSats > 0) t.sizeSats = o.channelSizeSats;
  if (p.leaseBlocks == null && o.leaseBlocks) t.leaseBlocks = o.leaseBlocks;
  if (p.sellerPubkey == null && o.sellerPubkey) t.sellerPubkey = o.sellerPubkey;
  if (p.feeRateCapPpm == null && o.feeRateCapPpm) {
    t.feeRateCapPpm = o.feeRateCapPpm;
    t.baseFeeCapSats = o.baseFeeCapSats ?? null;
  }
  return Object.keys(t).length ? t : null;
}
/** A payment LND doesn't know this long after it was started never left. */
const NOT_SENT_AFTER_MS = 10 * 60_000;

/** States whose payment may still be moving — the pay call hasn't told, or
 *  only the pay call has (no LND word yet). */
const PAYMENT_OPEN = (p: MagmaPurchase): boolean => p.state === "paying" || (p.state === "pay_failed" && !p.failureConfirmed);

export class MagmaPurchases {
  private readonly store: JsonStore<MagmaPurchase[]>;
  private items: MagmaPurchase[];

  constructor(dataDir: string) {
    this.store = new JsonStore<MagmaPurchase[]>(dataDir, "magma-purchases.json");
    this.items = this.store.read([]);
  }

  list(): MagmaPurchase[] {
    return this.items.map((p) => ({ ...p }));
  }

  get(orderId: string): MagmaPurchase | undefined {
    return this.items.find((p) => p.orderId === orderId);
  }

  /** A quote Amboss made into an order (nothing paid yet). */
  recordQuote(p: Omit<MagmaPurchase, "createdAt" | "updatedAt" | "state" | "routingFeeSats" | "orderStatus" | "channelId">): MagmaPurchase {
    const at = new Date().toISOString();
    const rec: MagmaPurchase = { ...p, createdAt: at, updatedAt: at, state: "quoted", routingFeeSats: null, orderStatus: null, channelId: null };
    this.items = [rec, ...this.items.filter((x) => x.orderId !== p.orderId)];
    this.trim();
    this.save();
    return rec;
  }

  update(orderId: string, patch: Partial<MagmaPurchase>): MagmaPurchase | undefined {
    const p = this.get(orderId);
    if (!p) return undefined;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return p;
  }

  /** The buyer confirmed: a payment of the quote's invoice starts (a quote,
   *  or a retry after a failure). */
  startPayment(orderId: string): MagmaPurchase | undefined {
    return this.update(orderId, { state: "paying", error: undefined, failureConfirmed: undefined, payStartedAt: new Date().toISOString() });
  }

  /**
   * How the payment stands — the pay call's answer, or LND's by payment hash.
   * Only ever moves a record forward: a late failure report never undoes
   * "paid" or "channel open", and a success always records the payment (its
   * time and routing fee), whichever report arrives first.
   */
  paymentOutcome(orderId: string, r: PaymentReport, nowMs = Date.now()): MagmaPurchase | undefined {
    const p = this.get(orderId);
    if (!p) return undefined;
    const patch: Partial<MagmaPurchase> = {};
    switch (r.status) {
      case "succeeded":
        patch.paidAt = r.at ?? p.paidAt ?? new Date(nowMs).toISOString();
        patch.routingFeeSats = r.feeSats;
        patch.failureConfirmed = undefined;
        patch.paymentNotFound = undefined;
        if (p.state === "quoted" || p.state === "paying" || p.state === "pay_failed") {
          patch.state = "paid";
          patch.error = undefined;
        }
        break;
      case "in_flight":
        // The failure an earlier answer reported was the stream's, not the
        // payment's: LND is still sending it.
        if (p.state === "pay_failed") Object.assign(patch, { state: "paying", error: undefined, failureConfirmed: undefined });
        break;
      case "failed":
        if (PAYMENT_OPEN(p)) Object.assign(patch, { state: "pay_failed", error: r.error, failureConfirmed: r.confirmed || undefined });
        break;
      case "not_found": {
        if (PAYMENT_OPEN(p)) {
          // Just started, LND may not have registered it yet: asked again.
          const started = Date.parse(p.payStartedAt ?? p.updatedAt);
          if (Number.isFinite(started) && nowMs - started < NOT_SENT_AFTER_MS) return p;
          Object.assign(patch, { state: "pay_failed", error: "LND never sent this payment", failureConfirmed: true });
        } else if (p.state === "channel_open" || p.state === "paid") {
          patch.paymentNotFound = true;
        }
        break;
      }
    }
    if (Object.keys(patch).every((k) => (p as unknown as Record<string, unknown>)[k] === (patch as Record<string, unknown>)[k])) return p;
    return this.update(orderId, patch);
  }

  /** Amboss's view of the order: where the purchase stands now. Never moves
   *  a record backwards (an open channel stays open in the record). */
  fromOrder(orderId: string, o: OrderState, nowMs = Date.now()): MagmaPurchase | undefined {
    const p = this.get(orderId);
    if (!p) return undefined;
    const ended = p.state === "channel_open" || p.state === "order_failed";
    const state: PurchaseState = ended ? p.state : o.done ? "channel_open" : o.failed ? "order_failed" : p.state;
    // The channel opens only once the hold invoice is paid: the purchase is
    // paid, whatever this process saw of the payment (LND's time and fee
    // replace this once the order lane reads the payment).
    const paidAt = state === "channel_open" && !p.paidAt ? new Date(nowMs).toISOString() : p.paidAt;
    const terms = termsLearned(p, o);
    if (p.orderStatus === o.status && p.state === state && p.channelId === o.channelId && p.paidAt === paidAt && !terms) return p;
    return this.update(orderId, { orderStatus: o.status, channelId: o.channelId ?? p.channelId, state, paidAt, ...terms });
  }

  /**
   * What the order lane still has to ask about:
   *  - `payments`: purchases whose payment LND hasn't told the end of —
   *    paying, failed by the pay call's word only, or channel open with the
   *    routing fee unknown (after a restart);
   *  - `orders`: purchases paid or being paid whose order hasn't ended on
   *    Amboss.
   */
  followUps(): { payments: MagmaPurchase[]; orders: MagmaPurchase[] } {
    const feeUnknown = (p: MagmaPurchase) => (p.state === "paid" || p.state === "channel_open") && p.routingFeeSats === null && !p.paymentNotFound;
    return {
      payments: this.items.filter((p) => PAYMENT_OPEN(p) || feeUnknown(p)),
      orders: this.items.filter((p) => PAYMENT_OPEN(p) || p.state === "paid"),
    };
  }

  /** Purchases whose order still has to end (paid or being paid). */
  inFlight(): MagmaPurchase[] {
    return this.followUps().orders;
  }

  /** What inbound bought here cost — purchases whose channel opened (a
   *  failed order's held payment goes back to the buyer): for P&L. */
  paidCosts(): { orderId: string; at: string; feeSats: number; routingFeeSats: number; sizeSats: number; leaseBlocks: number | null }[] {
    return this.items
      .filter((p) => p.paidAt && p.state === "channel_open")
      .map((p) => ({
        orderId: p.orderId,
        at: p.paidAt as string,
        feeSats: p.feeSats,
        routingFeeSats: p.routingFeeSats ?? 0,
        sizeSats: p.sizeSats,
        leaseBlocks: p.leaseBlocks,
      }));
  }

  /** Drop the oldest records that carry no cost, beyond KEPT (newest first). */
  private trim(): void {
    let free = 0;
    this.items = this.items.filter((p) => carriesCost(p) || ++free <= KEPT);
  }

  private save(): void {
    this.store.write(this.items);
  }
}
