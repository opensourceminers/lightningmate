import {
  addAdvertisedFeature,
  addExternalSocket,
  getChainFeeRate,
  getInvoice,
  removeExternalSocket,
  sendMessageToPeer,
  subscribeToInvoice,
  subscribeToPeerMessages,
  type AuthenticatedLnd,
} from "lightning";
import * as lnService from "lightning";

// lightning@10 exports removeAdvertisedFeature at runtime but forgot it in the
// package typings (peers/index.d.ts) — same call shape as addAdvertisedFeature.
const removeAdvertisedFeature = (
  lnService as unknown as {
    removeAdvertisedFeature: (args: { lnd: AuthenticatedLnd; feature: number }) => Promise<void>;
  }
).removeAdvertisedFeature;
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { EventEmitter } from "node:events";
import { JsonStore, recordStoreIncident } from "../store.js";
import type { SettingsStore } from "./settings.js";
import type { EarningsLog } from "./earningsLog.js";
import { getMagmaRecommendations, MAGMA_V2_DEFAULTS } from "./magmaRecommend.js";
import { onchainCosts } from "./nodeEconomics.js";
import { saleFeeConfig, type ServiceFeeLedger } from "./serviceFee.js";
import { couldNotConnect, ensureConnected, fundChannel, isPendingChannelsLimit, isPreBroadcastRefusal } from "./channelOps.js";
import { cancelHodl, createHodl, newHodlSecret, settleHodl } from "./hodl.js";
import { CapitalLedger, channelsWith, findOpenedChannel, spendableOnchain, type Reservation } from "./capital.js";
import { leaseCapFrom, type LeaseCap, type OfferFeeCaps } from "./leaseCaps.js";

/**
 * LSP mode — LSPS1 (bLIP-51) channel selling over LSPS0 (bLIP-50) transport.
 *
 * Wallets and nodes speaking the open LSP standard connect to us as a peer and
 * talk JSON-RPC 2.0 over BOLT8 custom messages (type 37913).
 *
 * Phase 2 (orders): `lsps1.create_order` prices a channel with the same engine
 * Magma selling uses (profit floor + market level, duration-scaled), collects
 * payment via a **HODL invoice**, opens the channel once the payment is held,
 * and only then settles. Any failure cancels the invoice → the buyer is
 * automatically refunded. This settle-after-broadcast ordering is the critical
 * fund-safety property: we can never keep a payment without delivering.
 *
 * Spec rules implemented (bLIP-50/51):
 *  - one BOLT8 message = one complete JSON-RPC 2.0 object, UTF-8 encoded
 *  - malformed payload → `-32700` with `id: null`; unknown method → `-32601`;
 *    unrecognized params → `-32602` + `data.unrecognized`
 *  - order errors: `100` option_mismatch, `101` not found, `1` client_rejected
 *  - sat amounts are strings; `payment.bolt11` sub-object with state machine
 *    EXPECT_PAYMENT → HOLD → PAID | REFUNDED; order CREATED → COMPLETED | FAILED
 */

/** BOLT8 custom message type carrying all LSPS traffic (bLIP-50). */
export const LSPS0_MESSAGE_TYPE = 37913;

/** `option_supports_lsps` (bLIP-50): advertised in the node announcement while
 *  LSP mode is on, so graph crawlers and wallets can discover the node as an
 *  LSP. Clients MUST NOT set this bit — we only ever set it as the LSP side. */
export const LSPS_FEATURE_BIT = 729;

/** Protocol-side offer constants (sizes shared with the Magma sell caps). */
const LSPS1_LIMITS = {
  /** Smallest channel we sell — matches the Magma minimum sell size. */
  minChannelSat: 1_000_000,
  /** We don't do zero-conf: the client gets channel_ready after 1 conf. */
  minRequiredChannelConfirmations: 1,
  /** Fastest funding-confirmation promise a client may request. */
  minFundingConfirmsWithinBlocks: 6,
  supportsZeroChannelReserve: false,
  /** Longest lease we promise not to close: ~90 days. */
  maxChannelExpiryBlocks: 12_960,
};

/** Per-peer inbound message budget — order spam / DoS guard. */
const RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_MAX_PEERS = 500;

/** Unpaid orders expire after an hour; the HODL invoice carries the deadline. */
const ORDER_EXPIRY_MS = 60 * 60 * 1000;
/** Basic abuse caps (P3 refines): open unpaid/held orders, per peer and total. */
const MAX_PENDING_PER_PEER = 2;
const MAX_PENDING_TOTAL = 10;
/** Peer-offline retry budget when opening after payment (1 min apart). */
const OPEN_RETRY_ATTEMPTS = 10;
const OPEN_RETRY_DELAY_MS = 60_000;
/** Ended orders kept beyond the ones that still matter (trimOrders). */
const ORDERS_KEPT = 200;
/** Blocks come every ~10 minutes; a lease's end is estimated with half again
 *  as long, so a run of slow blocks never ends it early (as magmaJournal.ts). */
const LEASE_MS_PER_BLOCK = 10 * 60_000 * 1.5;
const BLOCKS_PER_YEAR = MAGMA_V2_DEFAULTS.blocksPerYear;

type JsonRpcId = string | number | null;

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** After a restart mid-open (or an open whose outcome LND left unclear): how
 *  long LND gets to show the channel before we conclude the open never
 *  happened (same as Magma, magmaDesk.ts). */
const OPENING_GRACE_MS = 10 * 60_000;
/** Opens with an unclear outcome (each followed by the grace above, with no
 *  channel in LND) before the order is refunded instead of tried again. */
const MAX_UNCLEAR_OPENS = 3;

/** ln-service throws array errors: [code, name, { err }] — dig out the detail. */
function lndErrorDetail(err: unknown): string {
  if (Array.isArray(err)) {
    const extra = err[2] as { err?: { details?: string; message?: string } } | undefined;
    return extra?.err?.details ?? extra?.err?.message ?? String(err[1] ?? err[0]);
  }
  return err instanceof Error ? err.message : String(err);
}

// ── orders ────────────────────────────────────────────────────────────────────

/**
 * A channel this service opened that may still be inside its lease: funded,
 * and not yet past the lease measured generously from its funding. Whatever
 * the order's end: a sold channel carries its routing-fee promise and its
 * share of the deploy cap; one whose order failed after the open (the buyer
 * refunded) still claims its channel, so no other order's open adopts it.
 * The fee autopilot tells the lease's end by block height (leaseCaps.ts);
 * this only decides what may be forgotten.
 */
function lsps1ChannelMayRun(o: Lsps1Order, nowMs: number): boolean {
  if (!o.channel) return false;
  const from = Date.parse(o.channel.fundedAt);
  return !Number.isFinite(from) || nowMs < from + o.channelExpiryBlocks * LEASE_MS_PER_BLOCK;
}

export type Lsps1OrderState = "CREATED" | "COMPLETED" | "FAILED";
export type Lsps1PaymentState = "EXPECT_PAYMENT" | "HOLD" | "PAID" | "REFUNDED";

export interface Lsps1Order {
  orderId: string;
  /** Buyer pubkey (the peer that placed the order — also who we open to). */
  peer: string;
  createdAt: string;
  lspBalanceSat: number;
  /** Always 0 — we sell pure inbound, no push amount. */
  clientBalanceSat: number;
  requiredChannelConfirmations: number;
  fundingConfirmsWithinBlocks: number;
  channelExpiryBlocks: number;
  token: string;
  announceChannel: boolean;
  orderState: Lsps1OrderState;
  paymentState: Lsps1PaymentState;
  feeTotalSat: number;
  orderTotalSat: number;
  invoice: string;
  /** Payment hash of the HODL invoice. */
  invoiceId: string;
  /** Preimage — required to settle once the channel is irrevocably opening. */
  invoiceSecret: string;
  invoiceExpiresAt: string;
  channel: { fundedAt: string; fundingOutpoint: string; expiresAt: string } | null;
  /** Written BEFORE the channel open: when it started and which channels to
   *  the buyer existed then. A restart that finds this without `channel`
   *  looks for the open in LND before ever opening again. `unclear` is the
   *  error of an open whose outcome LND left open (a dropped stream, a
   *  timeout) — the same search decides what happened. */
  opening?: { startedAt: string; preExisting: string[]; unclear?: string };
  /** Opens whose outcome was unclear and turned out not to have happened. */
  unclearOpens?: number;
  /** LEGACY: fee paid inline by older versions. The service-fee ledger is the
   *  source of truth for orders completed since. */
  serviceFeePaidSat: number;
  /** The routing-fee promise this sale carries for its lease — the same one
   *  this node's Magma offers make (leaseCaps.ts), locked when the order is
   *  created. The fee autopilot keeps the sold channel within it. Absent on
   *  orders created before the promise existed: nothing was promised then. */
  feeRateCapPpm?: number;
  baseFeeCapSats?: number;
  error?: string;
}

/** Order view for the app UI — never includes the invoice preimage. */
export interface Lsps1OrderView {
  orderId: string;
  peer: string;
  createdAt: string;
  sizeSat: number;
  feeSat: number;
  orderState: Lsps1OrderState;
  paymentState: Lsps1PaymentState;
  channelExpiryBlocks: number;
  invoiceExpiresAt: string;
  fundingOutpoint: string | null;
  serviceFeePaidSat: number;
  error?: string;
}

export interface Lsps1Status {
  enabled: boolean;
  /** Peer-message subscription is live (write mode on + LND reachable). */
  running: boolean;
  canWrite: boolean;
  requestsServed: number;
  lastRequestAt: string | null;
  lastError: string | null;
  ordersPending: number;
  ordersCompleted: number;
  ordersFailed: number;
  /** Gross lease fees collected on completed LSPS1 sales. */
  earnedSat: number;
  /** Disclosed service fee on completed sales (same as Magma sales). */
  serviceFeeBps: number;
  /** Graph discovery: feature bit 729 announced? null error = fine/unknown. */
  featureBit: { set: boolean; error: string | null };
  /** Clearnet address announced via peersrpc ("" = none configured). */
  announcedSocket: { address: string; applied: boolean; error: string | null };
  /** What `lsps1.get_info` currently answers — shown in the Settings card. */
  offer: {
    minChannelSat: number;
    maxChannelSat: number;
    deployableSat: number;
    maxChannelExpiryBlocks: number;
    minFundingConfirmsWithinBlocks: number;
  } | null;
}

/** Cached pricing inputs (refreshed every 60s; orders are rare, quotes cheap). */
interface PricingContext {
  at: number;
  /** Routing-adjusted minimum lease yield (ppm of size, per year). */
  minLeasePpmPerYear: number;
  /** Market-level effective price (ppm per year) from the Magma engine, if known. */
  marketPpmPerYear: number | null;
  openCostSat: number;
  closeCostSat: number;
  serviceFeeRate: number;
}

export class Lsps1Service {
  private sub: EventEmitter | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryMs = 10_000;
  private requestsServed = 0;
  private lastRequestAt: string | null = null;
  private lastError: string | null = null;
  private readonly rateWindow = new Map<string, number[]>();
  private spendableCache: { at: number; sats: number } | undefined;
  private pricingCache: PricingContext | undefined;
  /** Retry pacing — instance fields so tests can shrink the waits. */
  private openRetryDelayMs = OPEN_RETRY_DELAY_MS;
  private settleRetryBaseMs = 2_000;
  private featureBitSet = false;
  private featureBitError: string | null = null;
  /** Last applied toggle state — detects on→off transitions (withdraw the bit). */
  private lastEnabled: boolean | undefined;
  /** Last clearnet socket applied via peersrpc; undefined = unknown (re-assert). */
  private lastAppliedSocket: string | undefined;
  private socketError: string | null = null;

  private readonly ordersStore: JsonStore<Lsps1Order[]>;
  private orders: Lsps1Order[];
  /** Live invoice subscriptions by payment hash. */
  private readonly invoiceSubs = new Map<string, EventEmitter>();
  /** Orders currently in the open-and-settle critical section. */
  private readonly fulfilling = new Set<string>();
  /** Opens whose funding outpoint is not yet on disk — shutdown waits for these. */
  private opensInFlight = 0;
  /** Set by stop(): no new channel open may begin. */
  private stopping = false;
  private socketTimer: NodeJS.Timeout | undefined;
  /** "Look again for the interrupted open" timers — cleared by stop(). */
  private readonly resumeTimers = new Set<NodeJS.Timeout>();
  /** The on-chain budget shared with Magma selling and the channel autopilot. */
  private readonly capital: CapitalLedger;

  constructor(
    private readonly dataDir: string,
    private readonly readLnd: AuthenticatedLnd,
    private readonly writeLnd: AuthenticatedLnd | undefined,
    private readonly settings: SettingsStore,
    /** Live sell caps (shared with Magma): max channel size, on-chain reserve,
     *  aggregate deploy cap. */
    private readonly caps: () => { maxChannelSats: number; reserveSats: number; maxDeploySats: number },
    /** The Magma engine's inputs (pricing mode, adaptive level, capital caps,
     *  the routing-fee promise), so both demand sources price — and promise —
     *  alike. */
    private readonly pricingMode: () => {
      sellPricingMode: "fast" | "balanced" | "premium" | "auto";
      adaptiveLevel: number;
      offerFeeCaps?: OfferFeeCaps | null;
    },
    private readonly ambossKey: () => string,
    private readonly earnings: EarningsLog,
    /** Completed sales enqueue their service fee here (paid in the background). */
    private readonly serviceFees: ServiceFeeLedger,
    /** Surface a completed sale in the run history / Overview digest. */
    private readonly onSale?: (orderId: string, sizeSats: number, transactionId: string) => void,
    /** Shared with the autopilot (index.ts): one mutex and one set of
     *  reservations for every on-chain commitment. */
    capital?: CapitalLedger,
  ) {
    this.ordersStore = new JsonStore<Lsps1Order[]>(dataDir, "lsps1-orders.json");
    this.orders = this.ordersStore.read([]);
    this.capital = capital ?? new CapitalLedger();
    this.capital.register("lsps1", {
      reservations: () => this.reservations(),
      deployedSat: () => this.deployedSat(),
      claimedOutpoints: () => this.orders.map((o) => o.channel?.fundingOutpoint ?? ""),
      leaseCaps: () => this.leaseCaps(),
    });
  }

  /** The routing-fee promises of the channels this service sold (a failed
   *  order sold nothing, so it promised nothing). */
  leaseCaps(): LeaseCap[] {
    return this.orders
      .filter((o) => o.orderState !== "FAILED" && o.channel)
      .map((o) =>
        leaseCapFrom({
          fundingOutpoint: o.channel?.fundingOutpoint,
          source: "lsps1",
          orderId: o.orderId,
          feeRateCapPpm: o.feeRateCapPpm,
          baseFeeCapSats: o.baseFeeCapSats,
          leaseBlocks: o.channelExpiryBlocks,
        }),
      )
      .filter((c): c is LeaseCap => c !== null);
  }

  start(): void {
    this.applySettings();
    void this.recoverOrders();
    // Hourly re-check of the announced clearnet address: a DDNS name follows
    // the home IP, so re-resolve and swap the announcement when it moved.
    this.socketTimer = setInterval(() => void this.applyAnnouncedSocket(), 60 * 60_000);
    this.socketTimer.unref?.();
  }

  /**
   * Process shutdown. Stops listening and refuses to start new channel opens;
   * the graph announcements are left as they are (this is not "LSP mode off").
   * Held payments stay held — restart recovery resumes them, and every state
   * change is already on disk. Await `waitForOpens()` before exiting so an open
   * that already started can record its funding outpoint.
   */
  stop(): void {
    this.stopping = true;
    if (this.socketTimer) clearInterval(this.socketTimer);
    this.socketTimer = undefined;
    for (const t of this.resumeTimers) clearTimeout(t);
    this.resumeTimers.clear();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    // Detach directly (stopSub() would log "LSP mode off", which it isn't).
    this.sub?.removeAllListeners();
    this.sub = undefined;
    for (const sub of this.invoiceSubs.values()) sub.removeAllListeners();
    this.invoiceSubs.clear();
  }

  /** Resolves when no channel open is between broadcast and its record on disk. */
  async waitForOpens(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.opensInFlight > 0) {
      if (Date.now() >= deadline) return false;
      await sleep(100);
    }
    return true;
  }

  /** Call after the LSP-mode toggle or clearnet address changes — starts/stops
   *  the subscription and keeps the graph announcements in sync. */
  applySettings(): void {
    const enabled = this.settings.get().lspModeEnabled && !!this.writeLnd;
    if (enabled) {
      this.startSub(); // asserts the feature bit
    } else {
      this.stopSub();
      // Withdraw only on a real on→off transition — a boot with the mode off
      // shouldn't touch (and needlessly re-gossip) the node announcement.
      if (this.lastEnabled) void this.advertiseFeature(false);
    }
    this.lastEnabled = enabled;
    // The clearnet announcement is independent of the LSP toggle — reachability
    // helps the node either way, and buyers may connect before enabling.
    void this.applyAnnouncedSocket();
  }

  /** Announce (or withdraw) the configured clearnet address via peersrpc.
   *
   *  LND resolves a hostname only ONCE when it's announced, so for DDNS names
   *  (dynamic home IPs) we resolve ourselves, announce the IP literal, and
   *  re-check hourly — when the IP behind the name changes, the stale address
   *  is withdrawn and the new one announced. Runtime announcements also don't
   *  survive an LND restart, so the reconnect path re-asserts too. */
  private async applyAnnouncedSocket(): Promise<void> {
    if (!this.writeLnd) return;
    const desired = (this.settings.get().lspClearnetAddress ?? "").trim();
    let target = ""; // the ip:port we actually announce ("" = withdraw)
    try {
      if (desired) {
        const [host, port] = desired.split(":");
        const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : (await lookup(host, { family: 4 })).address;
        target = `${ip}:${port}`;
      }
      if (this.lastAppliedSocket === target) {
        this.socketError = null;
        return; // same IP as announced — nothing to gossip
      }
      // IP changed / address cleared: withdraw the previous announcement (boot
      // = unknown, nothing to withdraw — LND lost runtime updates on restart).
      if (this.lastAppliedSocket) {
        await this.lndRemoveSocket(this.lastAppliedSocket).catch(() => undefined);
      }
      if (target) await this.lndAddSocket(target);
      this.lastAppliedSocket = target;
      this.socketError = null;
      if (target) console.log(`[lsps1] announcing clearnet address ${target} (${desired}) in the node graph`);
    } catch (err) {
      const detail = lndErrorDetail(err);
      // A no-op add means the address is already announced (e.g. via lnd.conf).
      if (/already|no modification/i.test(detail)) {
        this.lastAppliedSocket = target;
        this.socketError = null;
        return;
      }
      this.socketError = detail;
      console.warn(`[lsps1] could not announce clearnet address "${desired}": ${detail}`);
    }
  }

  /** Advertise (or withdraw) `option_supports_lsps` in the node announcement.
   *  Best-effort: a node without a public graph presence, or an LND without the
   *  peersrpc subserver, can't announce — LSP mode still works via directly
   *  shared URIs, so this never blocks; the Settings card shows the outcome. */
  private async advertiseFeature(on: boolean): Promise<void> {
    if (!this.writeLnd) return;
    try {
      if (on) await addAdvertisedFeature({ lnd: this.writeLnd, feature: LSPS_FEATURE_BIT });
      else await removeAdvertisedFeature({ lnd: this.writeLnd, feature: LSPS_FEATURE_BIT });
      this.featureBitSet = on;
      this.featureBitError = null;
      console.log(`[lsps1] feature bit ${LSPS_FEATURE_BIT} ${on ? "announced" : "withdrawn"} in the node graph`);
    } catch (err) {
      const detail = lndErrorDetail(err);
      // A no-op update means the bit already is in the desired state.
      if (/already|no modification|not set|not advertised/i.test(detail)) {
        this.featureBitSet = on;
        this.featureBitError = null;
        return;
      }
      if (on) this.featureBitSet = false;
      this.featureBitError = detail;
      console.warn(`[lsps1] could not ${on ? "announce" : "withdraw"} feature bit ${LSPS_FEATURE_BIT}: ${detail}`);
    }
  }

  /** Capital promised to paid-but-not-yet-opened orders. */
  committedSat(): number {
    return this.orders
      .filter((o) => o.orderState === "CREATED" && o.paymentState === "HOLD" && !o.channel)
      .reduce((s, o) => s + o.lspBalanceSat, 0);
  }

  /** This service's share of the shared capital ledger: PAID orders whose
   *  channel isn't open yet. An unpaid quote is not a promise anyone else
   *  must honour: any peer connected in LSP mode can ask for one (two per
   *  peer, ten in all, renewable hourly), and counting them let quotes nobody
   *  meant to pay turn Magma buyers away and sink an already paid Magma order. */
  reservations(): Reservation[] {
    return this.orders
      .filter((o) => o.orderState === "CREATED" && o.paymentState === "HOLD" && !o.channel)
      .map((o) => ({ key: `lsps1:${o.orderId}`, sats: o.lspBalanceSat, reserveSat: this.caps().reserveSats }));
  }

  /** Unpaid quotes: LSPS1's own soft claims. They count against its NEW
   *  quotes (so two buyers aren't quoted the same coins) and its own deploy
   *  headroom — never against Magma or the open of a paid order. */
  private unpaidQuotes(): Reservation[] {
    return this.orders
      .filter((o) => o.orderState === "CREATED" && o.paymentState === "EXPECT_PAYMENT" && !o.channel)
      .map((o) => ({ key: `lsps1:${o.orderId}`, sats: o.lspBalanceSat, reserveSat: this.caps().reserveSats }));
  }

  /** Capital sitting in LSPS1-sold channels whose lease hasn't expired —
   *  counts against the shared sellMaxDeploySats cap (as Magma's deployed does). */
  deployedSat(): number {
    const now = Date.now();
    // A channel opened but not yet settled counts too: it is no longer a
    // reservation (the funding transaction is out), but the capital is sold.
    return this.orders
      .filter(
        (o) => o.orderState !== "FAILED" && o.channel && new Date(o.channel.expiresAt).getTime() > now,
      )
      .reduce((s, o) => s + o.lspBalanceSat, 0);
  }

  /** Deploy-cap headroom for a NEW order: cap minus everything sold and still
   *  leased (Magma and LSPS1), minus every promised order of both demand
   *  sources, minus this service's own unpaid quotes (so two of its buyers
   *  can't oversell the cap together; MAX_PENDING_* keeps that abuse-bounded). */
  private deployHeadroomSat(): number {
    const unpaid = this.unpaidQuotes().reduce((s, r) => s + r.sats, 0);
    return Math.max(0, this.caps().maxDeploySats - this.capital.deployedSat() - this.capital.reservedSat() - unpaid);
  }

  orderViews(): Lsps1OrderView[] {
    return this.orders.map((o) => ({
      orderId: o.orderId,
      peer: o.peer,
      createdAt: o.createdAt,
      sizeSat: o.lspBalanceSat,
      feeSat: o.feeTotalSat,
      orderState: o.orderState,
      paymentState: o.paymentState,
      channelExpiryBlocks: o.channelExpiryBlocks,
      invoiceExpiresAt: o.invoiceExpiresAt,
      fundingOutpoint: o.channel?.fundingOutpoint ?? null,
      serviceFeePaidSat: this.serviceFees.paidFor("lsps1", o.orderId) ?? o.serviceFeePaidSat,
      error: o.error,
    }));
  }

  async status(): Promise<Lsps1Status> {
    const enabled = this.settings.get().lspModeEnabled;
    let offer: Lsps1Status["offer"] = null;
    if (this.writeLnd) {
      try {
        offer = await this.offerView();
      } catch {
        // Chain balance unavailable — status still renders without the offer.
      }
    }
    const completed = this.orders.filter((o) => o.orderState === "COMPLETED");
    return {
      enabled,
      running: !!this.sub,
      canWrite: !!this.writeLnd,
      requestsServed: this.requestsServed,
      lastRequestAt: this.lastRequestAt,
      lastError: this.lastError,
      ordersPending: this.orders.filter((o) => o.orderState === "CREATED").length,
      ordersCompleted: completed.length,
      ordersFailed: this.orders.filter((o) => o.orderState === "FAILED").length,
      earnedSat: completed.reduce((s, o) => s + o.feeTotalSat, 0),
      serviceFeeBps: saleFeeConfig().bps,
      featureBit: { set: this.featureBitSet, error: this.featureBitError },
      announcedSocket: {
        address: (this.settings.get().lspClearnetAddress ?? "").trim(),
        applied: !!this.lastAppliedSocket && this.socketError == null,
        error: this.socketError,
      },
      offer,
    };
  }

  // ── transport ────────────────────────────────────────────────────────────────

  private startSub(): void {
    if (this.sub || !this.writeLnd || this.stopping) return;
    try {
      const sub = subscribeToPeerMessages({ lnd: this.writeLnd });
      sub.on("message_received", (m: { message: string; public_key: string; type: number }) => {
        void this.onMessage(m);
      });
      sub.on("error", (err: unknown) => {
        this.lastError = err instanceof Error ? err.message : JSON.stringify(err);
        this.scheduleReconnect();
      });
      this.sub = sub;
      this.lastError = null;
      this.retryMs = 10_000;
      console.log("[lsps1] LSP mode on — listening for LSPS peer messages (type 37913)");
      // (Re)assert the graph announcements: an LND restart (the usual reason
      // this stream reconnects) drops runtime announcement updates.
      void this.advertiseFeature(true);
      this.lastAppliedSocket = undefined;
      void this.applyAnnouncedSocket();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.scheduleReconnect();
    }
  }

  private stopSub(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    if (!this.sub) return;
    // Removing all listeners terminates the underlying gRPC subscription. Note:
    // in-flight ORDER watchers stay alive regardless of the toggle — a held
    // payment must always resolve to settled or refunded.
    this.sub.removeAllListeners();
    this.sub = undefined;
    console.log("[lsps1] LSP mode off — stopped listening");
  }

  /** LND restarts drop the stream — retry with backoff while the mode is on. */
  private scheduleReconnect(): void {
    this.sub?.removeAllListeners();
    this.sub = undefined;
    if (!this.settings.get().lspModeEnabled || this.retryTimer || this.stopping) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 300_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.settings.get().lspModeEnabled) this.startSub();
    }, delay);
    this.retryTimer.unref?.();
  }

  private async onMessage(msg: { message: string; public_key: string; type: number }): Promise<void> {
    // Hard boundary: this handles input from ARBITRARY network peers, and the
    // process-level unhandledRejection handler exits — nothing a peer sends may
    // ever escape as a rejection, or a single message becomes a crash-loop DoS.
    try {
      if (msg.type !== LSPS0_MESSAGE_TYPE) return;
      if (!this.settings.get().lspModeEnabled) return;
      if (!this.allowPeer(msg.public_key)) return; // over budget → stay silent
      const raw = Buffer.from(msg.message, "hex").toString("utf8");
      const response = await this.dispatch(raw, msg.public_key);
      if (response) await this.send(msg.public_key, response);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[lsps1] peer message handling failed: ${this.lastError}`);
    }
  }

  private async send(publicKey: string, payload: object): Promise<void> {
    if (!this.writeLnd) return;
    try {
      await sendMessageToPeer({
        lnd: this.writeLnd,
        public_key: publicKey,
        type: LSPS0_MESSAGE_TYPE,
        message: Buffer.from(JSON.stringify(payload), "utf8").toString("hex"),
      });
    } catch {
      // Peer disconnected before the reply — per LSPS0 no different from a
      // delivered response the client never acted on.
    }
  }

  /** Sliding one-minute window per pubkey; map bounded so peers can't grow it. */
  private allowPeer(pubkey: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const hits = (this.rateWindow.get(pubkey) ?? []).filter((t) => t > cutoff);
    hits.push(now);
    this.rateWindow.set(pubkey, hits);
    if (this.rateWindow.size > RATE_LIMIT_MAX_PEERS) {
      for (const [key, times] of this.rateWindow) {
        if (!times.some((t) => t > cutoff)) this.rateWindow.delete(key);
      }
    }
    return hits.length <= RATE_LIMIT_PER_MINUTE;
  }

  // ── JSON-RPC dispatch ────────────────────────────────────────────────────────

  private async dispatch(raw: string, peer: string): Promise<Record<string, unknown> | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("payload is not a single JSON object");
      }
    } catch {
      console.warn("[lsps1] unparseable LSPS payload from peer (ignored)");
      return rpcError(null, -32700, "Parse error");
    }

    const { jsonrpc, id, method, params } = parsed as {
      jsonrpc?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    // Clients MUST NOT send notifications — nothing to respond to; drop it.
    if (id === undefined) return null;
    const rid: JsonRpcId = typeof id === "string" || typeof id === "number" ? id : null;
    if (jsonrpc !== "2.0" || typeof method !== "string") {
      return rpcError(rid, -32600, "Invalid Request");
    }
    // bLIP-50: params must be by-name (an object), never by-position.
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      return rpcError(rid, -32602, "params must be passed by name (JSON object)", { unrecognized: [] });
    }
    const p = (params ?? {}) as Record<string, unknown>;
    const rejectUnknown = (known: string[]): Record<string, unknown> | null => {
      const unknown = Object.keys(p).filter((k) => !known.includes(k));
      return unknown.length ? rpcError(rid, -32602, "unrecognized parameter", { unrecognized: unknown }) : null;
    };

    switch (method) {
      case "lsps0.list_protocols": {
        const bad = rejectUnknown([]);
        if (bad) return bad;
        this.served();
        return rpcResult(rid, { protocols: [1] });
      }
      case "lsps1.get_info": {
        const bad = rejectUnknown([]);
        if (bad) return bad;
        try {
          const info = await this.getInfo();
          this.served();
          return rpcResult(rid, info);
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
          return rpcError(rid, -32603, "Internal error");
        }
      }
      case "lsps1.create_order": {
        const bad = rejectUnknown([
          "lsp_balance_sat",
          "client_balance_sat",
          "required_channel_confirmations",
          "funding_confirms_within_blocks",
          "channel_expiry_blocks",
          "token",
          "refund_onchain_address",
          "announce_channel",
        ]);
        if (bad) return bad;
        try {
          this.served();
          return await this.createOrder(rid, peer, p);
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
          return rpcError(rid, -32603, "Internal error");
        }
      }
      case "lsps1.get_order": {
        const bad = rejectUnknown(["order_id"]);
        if (bad) return bad;
        const orderId = p.order_id;
        if (typeof orderId !== "string") {
          return rpcError(rid, -32602, "invalid parameter", { property: "order_id", message: "must be a string" });
        }
        // Orders are private to the peer that created them.
        const order = this.orders.find((o) => o.orderId === orderId && o.peer === peer);
        if (!order) return rpcError(rid, 101, "Not found", {});
        this.served();
        return rpcResult(rid, this.orderPayload(order));
      }
      default:
        return rpcError(rid, -32601, "Method not found");
    }
  }

  private served(): void {
    this.requestsServed += 1;
    this.lastRequestAt = new Date().toISOString();
  }

  // ── LND seams ────────────────────────────────────────────────────────────────
  // Every fund-moving/lookup call in the order path goes through these
  // one-liners, so the state machine can be exercised without a node in tests.

  private lndCreateHodl(id: string, tokens: number, description: string, expiresAt: string) {
    return createHodl(this.writeLnd!, { id, tokens, description, expiresAt });
  }
  private lndSettle(secret: string) {
    return settleHodl(this.writeLnd!, secret);
  }
  private lndCancel(id: string) {
    return cancelHodl(this.writeLnd!, id);
  }
  private lndInvoice(id: string) {
    return getInvoice({ lnd: this.writeLnd!, id });
  }
  /** The open itself — the buyer was connected before the mutex (lndConnect). */
  private lndOpen(order: Lsps1Order, feeRate: number | undefined) {
    return fundChannel(this.writeLnd!, {
      pubkey: order.peer,
      localTokens: order.lspBalanceSat,
      feeRate,
      isPrivate: !order.announceChannel,
    });
  }
  /** The buyer placed the order over BOLT8, so it is usually still a peer;
   *  if not, the graph's addresses are dialed (Tor: up to ~1.5 min). */
  private lndConnect(pubkey: string) {
    return ensureConnected(this.writeLnd!, pubkey, []);
  }
  private lndFeeRate(confirmationTarget: number) {
    return getChainFeeRate({ lnd: this.writeLnd!, confirmation_target: confirmationTarget });
  }
  private lndAddSocket(socket: string) {
    return addExternalSocket({ lnd: this.writeLnd!, socket });
  }
  private lndRemoveSocket(socket: string) {
    return removeExternalSocket({ lnd: this.writeLnd!, socket });
  }

  // ── the offer ────────────────────────────────────────────────────────────────

  /**
   * On-chain capital a NEW order could be funded with: balance minus the
   * effective reserve (the sell reserve or LND's anchor reserve, whichever is
   * larger, plus a funding fee for this open and every promised one — D5),
   * minus every promise: paid orders of both demand sources (the shared
   * ledger) and this service's own unpaid quotes. Cached 30 s for get_info
   * and the status card; `fresh` reads LND now (create_order, in the mutex).
   */
  private async quotableSat(fresh = false): Promise<number> {
    if (!this.writeLnd) return 0;
    if (fresh || !this.spendableCache || Date.now() - this.spendableCache.at > 30_000) {
      const sp = await spendableOnchain(this.writeLnd, this.capital, this.caps().reserveSats, { extra: this.unpaidQuotes() });
      this.spendableCache = { at: Date.now(), sats: sp.spendableSat };
    }
    return this.spendableCache.sats;
  }

  /** What the open of a PAID order may use, fresh: the shared ledger minus
   *  its own reservation — an unpaid quote never stands in a paid order's way. */
  private async fundableFor(order: Lsps1Order): Promise<number> {
    const sp = await spendableOnchain(this.writeLnd!, this.capital, this.caps().reserveSats, { exceptKey: `lsps1:${order.orderId}` });
    return sp.spendableSat;
  }

  private async offerView() {
    const deployable = await this.quotableSat();
    // Never advertise more than we could actually fund, capped by the shared
    // Magma sell cap; clamped up to min so the min ≤ max spec constraint holds
    // even when the wallet is empty. The clamp vouches for nothing:
    // create_order checks the real capital, fresh, before it quotes.
    const maxChannelSat = Math.max(
      LSPS1_LIMITS.minChannelSat,
      Math.min(deployable, this.caps().maxChannelSats),
    );
    return {
      minChannelSat: LSPS1_LIMITS.minChannelSat,
      maxChannelSat,
      deployableSat: deployable,
      maxChannelExpiryBlocks: LSPS1_LIMITS.maxChannelExpiryBlocks,
      minFundingConfirmsWithinBlocks: LSPS1_LIMITS.minFundingConfirmsWithinBlocks,
    };
  }

  /** bLIP-51 `lsps1.get_info` result — sat amounts are strings per spec. */
  private async getInfo(): Promise<Record<string, unknown>> {
    const offer = await this.offerView();
    const min = String(LSPS1_LIMITS.minChannelSat);
    const max = String(offer.maxChannelSat);
    return {
      min_required_channel_confirmations: LSPS1_LIMITS.minRequiredChannelConfirmations,
      min_funding_confirms_within_blocks: LSPS1_LIMITS.minFundingConfirmsWithinBlocks,
      supports_zero_channel_reserve: LSPS1_LIMITS.supportsZeroChannelReserve,
      max_channel_expiry_blocks: LSPS1_LIMITS.maxChannelExpiryBlocks,
      // We sell pure inbound: the client side starts empty (no push amount).
      min_initial_client_balance_sat: "0",
      max_initial_client_balance_sat: "0",
      min_initial_lsp_balance_sat: min,
      max_initial_lsp_balance_sat: max,
      min_channel_balance_sat: min,
      max_channel_balance_sat: max,
    };
  }

  // ── pricing ──────────────────────────────────────────────────────────────────

  /** Pricing inputs from the shared Magma engine (market level + profit floor);
   *  falls back to a pure local profit floor when the market is unreachable. */
  private async pricingContext(): Promise<PricingContext> {
    if (this.pricingCache && Date.now() - this.pricingCache.at < 60_000) return this.pricingCache;
    const serviceFeeRate = saleFeeConfig().bps / 10_000;
    let ctx: PricingContext;
    try {
      const report = await getMagmaRecommendations(this.readLnd, this.ambossKey(), this.pricingMode());
      const rec = report.sell.recommendations[0];
      ctx = {
        at: Date.now(),
        minLeasePpmPerYear: report.sell.recommendedMinLeasePpmPerYear,
        marketPpmPerYear:
          rec != null
            ? rec.recommended.effectiveFeePpm / (rec.recommended.minBlockLength / BLOCKS_PER_YEAR)
            : null,
        openCostSat: report.sell.onchainOpenCostSat,
        closeCostSat: report.sell.onchainCloseCostSat,
        serviceFeeRate,
      };
    } catch {
      // Market unreachable — quote from the local profit floor only.
      const oc = await onchainCosts(this.readLnd);
      ctx = {
        at: Date.now(),
        minLeasePpmPerYear: Math.round(
          MAGMA_V2_DEFAULTS.defaultRoutingOpportunityPpmPerYear * MAGMA_V2_DEFAULTS.minLeaseVsRoutingRatio,
        ),
        marketPpmPerYear: null,
        openCostSat: oc.openCostSat,
        closeCostSat: oc.closeCostSat,
        serviceFeeRate,
      };
    }
    this.pricingCache = ctx;
    return ctx;
  }

  /** Price an order: market level scaled to the requested duration, never below
   *  the profit floor (routing opportunity + on-chain costs + min net profit,
   *  all net of the service fee) — the same economics Magma selling uses. */
  private async quote(sizeSat: number, durationBlocks: number): Promise<{ feeTotalSat: number; effectivePpm: number }> {
    const ctx = await this.pricingContext();
    const years = durationBlocks / BLOCKS_PER_YEAR;
    const costPpm = ((ctx.openCostSat + ctx.closeCostSat) / sizeSat) * 1_000_000;
    const floorRouting = (ctx.minLeasePpmPerYear * years + costPpm) / (1 - ctx.serviceFeeRate);
    const floorMinProfit =
      ((MAGMA_V2_DEFAULTS.minNetLeaseProfitSat + ctx.openCostSat + ctx.closeCostSat) /
        (sizeSat * (1 - ctx.serviceFeeRate))) *
      1_000_000;
    const floor = Math.max(floorRouting, floorMinProfit, MAGMA_V2_DEFAULTS.minFeeRatePpm);
    const market = ctx.marketPpmPerYear != null ? ctx.marketPpmPerYear * years : 0;
    const effectivePpm = Math.min(Math.max(floor, market), MAGMA_V2_DEFAULTS.maxFeeRatePpm);
    return { feeTotalSat: Math.ceil((sizeSat * effectivePpm) / 1_000_000), effectivePpm: Math.round(effectivePpm) };
  }

  // ── create_order ─────────────────────────────────────────────────────────────

  private async createOrder(
    rid: JsonRpcId,
    peer: string,
    p: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.writeLnd) return rpcError(rid, -32603, "Internal error");
    const invalid = (property: string, message: string) =>
      rpcError(rid, -32602, "invalid parameter", { property, message });
    const mismatch = (property: string, message: string) =>
      rpcError(rid, 100, "Option mismatch", { property, message });

    // Sat amounts arrive as strings per spec (tolerate plain numbers).
    const satParam = (v: unknown): number | null => {
      const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : typeof v === "number" ? v : NaN;
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    const uintParam = (v: unknown): number | null =>
      typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;

    const lspBalanceSat = satParam(p.lsp_balance_sat);
    if (lspBalanceSat == null) return invalid("lsp_balance_sat", "must be a satoshi amount string");
    const clientBalanceSat = satParam(p.client_balance_sat);
    if (clientBalanceSat == null) return invalid("client_balance_sat", "must be a satoshi amount string");
    const requiredConfs = uintParam(p.required_channel_confirmations);
    if (requiredConfs == null) return invalid("required_channel_confirmations", "must be an unsigned integer");
    const confirmsWithin = uintParam(p.funding_confirms_within_blocks);
    if (confirmsWithin == null) return invalid("funding_confirms_within_blocks", "must be an unsigned integer");
    const expiryBlocks = uintParam(p.channel_expiry_blocks);
    if (expiryBlocks == null) return invalid("channel_expiry_blocks", "must be an unsigned integer");
    if (typeof p.announce_channel !== "boolean") return invalid("announce_channel", "must be a boolean");
    const token = p.token === undefined ? "" : p.token;
    if (typeof token !== "string" || token.length > 512) return invalid("token", "must be a short string");
    if (p.refund_onchain_address !== undefined && typeof p.refund_onchain_address !== "string") {
      return invalid("refund_onchain_address", "must be a string");
    }

    // Options must match what lsps1.get_info advertises (error 100 otherwise).
    const offer = await this.offerView();
    if (clientBalanceSat !== 0) return mismatch("client_balance_sat", "client balance is not supported (max 0)");
    if (lspBalanceSat < offer.minChannelSat) {
      return mismatch("lsp_balance_sat", `below min_initial_lsp_balance_sat (${offer.minChannelSat})`);
    }
    if (lspBalanceSat > offer.maxChannelSat) {
      return mismatch("lsp_balance_sat", `above max_initial_lsp_balance_sat (${offer.maxChannelSat})`);
    }
    if (requiredConfs < LSPS1_LIMITS.minRequiredChannelConfirmations) {
      return mismatch("required_channel_confirmations", "zero-conf is not supported");
    }
    if (confirmsWithin < LSPS1_LIMITS.minFundingConfirmsWithinBlocks) {
      return mismatch(
        "funding_confirms_within_blocks",
        `below min_funding_confirms_within_blocks (${LSPS1_LIMITS.minFundingConfirmsWithinBlocks})`,
      );
    }
    if (expiryBlocks < 1 || expiryBlocks > LSPS1_LIMITS.maxChannelExpiryBlocks) {
      return mismatch("channel_expiry_blocks", `must be 1..${LSPS1_LIMITS.maxChannelExpiryBlocks}`);
    }

    // Abuse caps: open (unresolved) orders, per peer and total.
    const pending = this.orders.filter((o) => o.orderState === "CREATED");
    if (pending.filter((o) => o.peer === peer).length >= MAX_PENDING_PER_PEER) {
      return rpcError(rid, 1, "Client rejected", { message: "too many open orders — pay or let them expire first" });
    }
    if (pending.length >= MAX_PENDING_TOTAL) {
      return rpcError(rid, 1, "Client rejected", { message: "LSP is at capacity — try again later" });
    }
    // Aggregate deploy cap (shared with Magma selling): reject up front rather
    // than refunding a paid order later.
    const atCap = () =>
      rpcError(rid, 1, "Client rejected", { message: "LSP is at its capital deployment cap — try again later" });
    if (lspBalanceSat > this.deployHeadroomSat()) return atCap();

    // Pricing may ask Amboss for the market — never while holding the mutex.
    const { feeTotalSat } = await this.quote(lspBalanceSat, expiryBlocks);
    const announceChannel = p.announce_channel;
    // The routing-fee promise of this sale, locked now (leaseCaps.ts).
    const caps = this.pricingMode().offerFeeCaps ?? null;

    // The coins must exist NOW, net of every promise: checked with a fresh
    // balance inside the on-chain mutex, and the order recorded in the same
    // turn — so a Magma accept or another quote can't plan the same coins at
    // the same moment. (get_info's maximum is clamped up to the minimum so
    // min ≤ max holds; it never vouched for capital. Before, an order up to
    // that clamped maximum was taken on with nothing behind it.)
    return this.capital.mutex.run("lsps1 order", async () => {
      if (lspBalanceSat > this.deployHeadroomSat()) return atCap();
      const spendable = await this.quotableSat(true);
      if (lspBalanceSat > spendable) {
        return rpcError(rid, 1, "Client rejected", {
          message: `LSP has no on-chain capital for a channel this size right now (${spendable} sat available) — try a smaller channel or later`,
        });
      }

      // HODL invoice: we hold the payment until the channel is irrevocably
      // opening, then settle with the preimage; every failure path cancels
      // instead — the buyer's payment automatically bounces back.
      const { id: invoiceId, secret } = newHodlSecret();
      const expiresAt = new Date(Date.now() + ORDER_EXPIRY_MS).toISOString();
      const orderId = randomUUID();
      const inv = await this.lndCreateHodl(
        invoiceId,
        feeTotalSat,
        `LSPS1 ${orderId}: ${lspBalanceSat} sat channel for ${expiryBlocks} blocks`,
        expiresAt,
      );

      const order: Lsps1Order = {
        orderId,
        peer,
        createdAt: new Date().toISOString(),
        lspBalanceSat,
        clientBalanceSat: 0,
        requiredChannelConfirmations: requiredConfs,
        fundingConfirmsWithinBlocks: confirmsWithin,
        channelExpiryBlocks: expiryBlocks,
        token,
        announceChannel,
        orderState: "CREATED",
        paymentState: "EXPECT_PAYMENT",
        feeTotalSat,
        orderTotalSat: feeTotalSat, // + client_balance (always 0)
        invoice: inv.request,
        invoiceId,
        invoiceSecret: secret,
        invoiceExpiresAt: expiresAt,
        channel: null,
        serviceFeePaidSat: 0,
        ...(caps ? { feeRateCapPpm: caps.feeRateCapPpm, baseFeeCapSats: caps.baseFeeCapSats } : {}),
      };
      this.orders.unshift(order);
      this.spendableCache = undefined; // this quote now counts against the next
      this.persistOrders();
      this.watchInvoice(order);
      console.log(`[lsps1] order ${orderId}: ${lspBalanceSat} sat / ${expiryBlocks} blocks → ${feeTotalSat} sat fee`);
      return rpcResult(rid, this.orderPayload(order));
    });
  }

  /** bLIP-51 order object, shared by create_order and get_order. */
  private orderPayload(o: Lsps1Order): Record<string, unknown> {
    return {
      order_id: o.orderId,
      lsp_balance_sat: String(o.lspBalanceSat),
      client_balance_sat: String(o.clientBalanceSat),
      required_channel_confirmations: o.requiredChannelConfirmations,
      funding_confirms_within_blocks: o.fundingConfirmsWithinBlocks,
      channel_expiry_blocks: o.channelExpiryBlocks,
      token: o.token,
      created_at: o.createdAt,
      announce_channel: o.announceChannel,
      order_state: o.orderState,
      payment: {
        bolt11: {
          state: o.paymentState,
          expires_at: o.invoiceExpiresAt,
          fee_total_sat: String(o.feeTotalSat),
          order_total_sat: String(o.orderTotalSat),
          invoice: o.invoice,
        },
      },
      channel: o.channel
        ? {
            funded_at: o.channel.fundedAt,
            funding_outpoint: o.channel.fundingOutpoint,
            expires_at: o.channel.expiresAt,
          }
        : null,
    };
  }

  private persistOrders(): void {
    this.trimOrders();
    this.ordersStore.write(this.orders);
  }

  /**
   * Keep the newest ORDERS_KEPT orders, and beyond them every order that
   * still matters: one in progress (its held payment, reservation and
   * invoice watch live here), and one whose channel's lease may still run —
   * its routing-fee promise (leaseCaps), its claimed outpoint and its share
   * of the deploy cap must outlive the trim. Before, a plain slice dropped
   * them: any peer can leave ~10 abandoned orders an hour (MAX_PENDING_TOTAL,
   * one-hour expiry), so a 30-day sale lost its promise about 20 hours in,
   * and the fee autopilot stopped keeping its channel within the cap.
   */
  private trimOrders(nowMs = Date.now()): void {
    let others = 0;
    this.orders = this.orders.filter((o) => o.orderState === "CREATED" || lsps1ChannelMayRun(o, nowMs) || ++others <= ORDERS_KEPT);
  }

  // ── payment → channel-open state machine ────────────────────────────────────

  private watchInvoice(order: Lsps1Order): void {
    if (!this.writeLnd || this.invoiceSubs.has(order.invoiceId)) return;
    let sub: EventEmitter;
    try {
      sub = subscribeToInvoice({ lnd: this.writeLnd, id: order.invoiceId });
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return;
    }
    this.invoiceSubs.set(order.invoiceId, sub);
    const detach = () => {
      sub.removeAllListeners();
      this.invoiceSubs.delete(order.invoiceId);
    };
    sub.on("invoice_updated", (inv: { is_held?: boolean; is_confirmed: boolean; is_canceled?: boolean }) => {
      if (inv.is_held && order.orderState === "CREATED" && order.paymentState === "EXPECT_PAYMENT") {
        order.paymentState = "HOLD";
        this.persistOrders();
        console.log(`[lsps1] order ${order.orderId}: payment held — opening channel to ${order.peer.slice(0, 12)}…`);
        void this.fulfill(order);
      } else if (inv.is_confirmed) {
        detach(); // settled — fulfill() already recorded completion
      } else if (inv.is_canceled) {
        // Either we cancelled (refund path) or the invoice expired unpaid.
        if (order.orderState === "CREATED") {
          if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
          order.orderState = "FAILED";
          order.error ??= order.paymentState === "REFUNDED" ? "payment refunded" : "order expired unpaid";
          this.persistOrders();
        }
        detach();
      }
    });
    sub.on("error", () => {
      detach();
      // Re-attach later while the order is still live (LND restart etc.).
      const timer = setTimeout(() => {
        const current = this.orders.find((o) => o.orderId === order.orderId);
        if (current && current.orderState === "CREATED") this.watchInvoice(current);
      }, 30_000);
      timer.unref?.();
    });
  }

  /** Open the channel for a held payment, settle on success, refund on failure.
   *  Settle happens ONLY after the funding tx is broadcast — never before. */
  private async fulfill(order: Lsps1Order): Promise<void> {
    if (!this.writeLnd || this.fulfilling.has(order.orderId)) return;
    this.fulfilling.add(order.orderId);
    try {
      // A channel was already funded for this order (e.g. settle failed and we
      // restarted) — never open a second one; just finish claiming the payment.
      if (order.channel) {
        await this.settleAndRecord(order);
        return;
      }
      // An open was under way when the process last stopped (its outpoint
      // never reached the disk), or ended with an unclear error: find that
      // channel in LND before anything else.
      if (order.opening) {
        const found = await this.reconcileOpening(order);
        if (found === "found") {
          await this.settleAndRecord(order);
          return;
        }
        if (found === "wait") {
          this.resumeLater(order);
          return;
        }
        if ((order.unclearOpens ?? 0) >= MAX_UNCLEAR_OPENS) {
          await this.failAndRefund(order, `the channel open failed ${order.unclearOpens} times without a clear answer from LND`);
          return;
        }
      }

      // Honor funding_confirms_within_blocks via the chain fee estimator.
      let feeRate: number | undefined;
      try {
        feeRate = (await this.lndFeeRate(order.fundingConfirmsWithinBlocks)).tokens_per_vbyte;
      } catch {
        feeRate = undefined; // let LND pick
      }

      // The buyer must be connected as a peer (they reached us over BOLT8, but
      // may have dropped). We have no socket to dial, so retry while they
      // reconnect — bounded well inside the held HTLC's CLTV budget.
      let lastError = "open not attempted";
      for (let attempt = 0; attempt < OPEN_RETRY_ATTEMPTS; attempt++) {
        if (attempt > 0) await sleep(this.openRetryDelayMs);
        // Shutting down: leave the payment held. Restart recovery resumes this
        // order from its saved state — far better than being killed mid-open.
        if (this.stopping) return;
        // Stop if the payment is no longer held (expired/cancelled meanwhile).
        try {
          const inv = await this.lndInvoice(order.invoiceId);
          if (!inv.is_held) {
            lastError = "payment no longer held";
            break;
          }
        } catch {
          // Invoice lookup failing shouldn't abort the open attempt.
        }
        if (this.stopping) return;
        // Connect first, OUTSIDE the mutex: dialing over Tor can take a minute
        // and a half, and must not hold up anyone else's open meanwhile.
        if (!(await this.lndConnect(order.peer))) {
          lastError = couldNotConnect(order.peer);
          continue; // the buyer may reconnect — wait and try again
        }
        if (this.stopping) return;
        // One open at a time across Magma, LSPS1 and the autopilot — held only
        // for this attempt, never across the retry wait above.
        const step = await this.capital.mutex.run("lsps1 open", () => this.openOnce(order, feeRate));
        if (step.done) {
          // The outpoint is on record: claim the held payment — after the
          // mutex. Settling retries with waits of up to 10 s (30 s in all);
          // inside the mutex those held up every Magma accept and open.
          if (order.channel) await this.settleAndRecord(order);
          return;
        }
        if (step.unclear) {
          // LND may have funded it: look for the channel before anything else.
          this.resumeLater(order);
          return;
        }
        lastError = step.error;
        // Only a connect problem (or the buyer's pending-channel limit) is
        // worth waiting out; anything else is final.
        if (!step.retry) break;
      }
      await this.failAndRefund(order, lastError);
    } catch (err) {
      await this.failAndRefund(order, err instanceof Error ? err.message : String(err));
    } finally {
      this.fulfilling.delete(order.orderId);
    }
  }

  /** One open attempt, inside the on-chain mutex: check capital with a fresh
   *  balance, record the intent, open, record the outpoint. `done` with the
   *  channel on the order: the caller settles, once the mutex is released. */
  private async openOnce(
    order: Lsps1Order,
    feeRate: number | undefined,
  ): Promise<{ done: true } | { done: false; error: string; retry: boolean; unclear?: boolean }> {
    // Capital gate with a FRESH balance, net of everything promised elsewhere
    // (paid orders only — an unpaid quote never blocks a paid order).
    const deployable = await this.fundableFor(order);
    if (order.lspBalanceSat > deployable) {
      return { done: false, error: "insufficient on-chain capital at open time", retry: false };
    }
    // Deploy cap re-check at open time — catches a cap the user LOWERED
    // after this order was created (create-time already serialized siblings).
    if (this.capital.deployedSat() + order.lspBalanceSat > this.caps().maxDeploySats) {
      return { done: false, error: "capital deployment cap reached", retry: false };
    }
    const preExisting = (await channelsWith(this.writeLnd!, order.peer)).map((c) => c.outpoint);
    // Check again: the reads above waited on LND, and a shutdown that began
    // meanwhile has already been told "no open in flight" (the count below is
    // still 0) — the process may exit at any moment. An open started now could
    // fund a channel whose outpoint never reaches disk. Leave the payment held
    // instead; restart recovery resumes it. Nothing below awaits before the
    // count goes up, so this check cannot go stale.
    if (this.stopping) return { done: true };
    // Never move funds we couldn't record: if the order file can't be written
    // now, the funding outpoint couldn't be either. Refund instead. The
    // "opening" mark it saves is what a restart uses to find this open.
    order.opening = { startedAt: new Date().toISOString(), preExisting };
    try {
      this.ordersStore.writeOrThrow(this.orders);
    } catch (err) {
      order.opening = undefined;
      return {
        done: false,
        error: `cannot save order state (${err instanceof Error ? err.message : String(err)}) — refunded instead of opening`,
        retry: false,
      };
    }
    this.opensInFlight += 1;
    try {
      const res = await this.lndOpen(order, feeRate);
      if (res.ok && res.transactionId) {
        this.recordChannel(order, `${res.transactionId}:${res.transactionVout ?? 0}`);
        return { done: true };
      }
      // An error after the broadcast must not lead to a refund plus a channel.
      const found = await this.findOurOpen(order).catch(() => null);
      if (found) {
        this.recordChannel(order, found);
        return { done: true };
      }
      const error = res.error ?? "open failed";
      if (!isPreBroadcastRefusal(error)) {
        // Not a refusal LND gives before funding (a dropped stream, a
        // timeout, an unknown error): LND may have broadcast without showing
        // the channel yet. The "opening" mark stays, and reconcileOpening
        // decides once LND has had ample time — no refund (the buyer would
        // keep a free channel) and no second open before that.
        order.opening = { ...(order.opening ?? { startedAt: new Date().toISOString(), preExisting }), unclear: error };
        order.error = `open outcome unclear (${error}) — looking for the channel in LND before anything else`;
        this.persistOrders();
        return { done: false, error, retry: false, unclear: true };
      }
      order.opening = undefined;
      this.persistOrders();
      // The buyer's LND takes one pending channel at a time by default: that
      // clears once the earlier channel confirms — worth waiting out too.
      return { done: false, error, retry: error.includes("couldn't connect") || isPendingChannelsLimit(error) };
    } finally {
      this.opensInFlight -= 1;
    }
  }

  /** The channel this order's open funded, if LND shows one — never one
   *  another sale has claimed: LSPS1's own, and Magma's (the same buyer may
   *  have bought a channel of the same size there; adopting it would have the
   *  buyer pay twice for one channel). */
  private async findOurOpen(order: Lsps1Order): Promise<string | null> {
    const found = await findOpenedChannel(this.writeLnd!, {
      pubkey: order.peer,
      capacity: order.lspBalanceSat,
      exclude: [...(order.opening?.preExisting ?? []), ...this.capital.claimedOutpoints()],
    });
    return found?.outpoint ?? null;
  }

  /** An "opening" mark without a channel: the process stopped mid-open, or
   *  the open's outcome was unclear. Adopt the channel LND shows; give LND
   *  time before concluding there is none — and only then may a new open
   *  start.
   *
   *  The lookup and its record happen under the on-chain mutex: a sale's open
   *  (LSPS1's, Magma's) holds it until its funding outpoint is recorded, so
   *  the lookup never meets a channel LND lists already for another sale that
   *  hasn't claimed it yet — and takes it as this order's, settling this
   *  buyer's payment for a channel another buyer paid for. The mutex isn't
   *  re-entrant: never call this from inside it (openOnce looks with
   *  findOurOpen itself). */
  private async reconcileOpening(order: Lsps1Order): Promise<"found" | "wait" | "none"> {
    return this.capital.mutex.run("lsps1 reconcile", async () => {
      // LND not answering is no answer: look again later. (Before, a failed
      // lookup read as "no channel" — once the grace was over, a second open
      // followed for an order whose channel may well exist: say, right after
      // a restart, while LND is still starting up.)
      const found = await this.findOurOpen(order).catch(() => undefined);
      if (found === undefined) return "wait";
      if (found) {
        const expiresAt = new Date(Date.now() + order.channelExpiryBlocks * 10 * 60_000).toISOString();
        order.channel = { fundedAt: order.opening?.startedAt ?? new Date().toISOString(), fundingOutpoint: found, expiresAt };
        order.opening = undefined;
        this.persistOrders();
        console.log(`[lsps1] order ${order.orderId}: found the channel of the interrupted open (${found})`);
        return "found";
      }
      const startedAt = order.opening ? Date.parse(order.opening.startedAt) : 0;
      if (Date.now() - startedAt < OPENING_GRACE_MS) return "wait";
      if (order.opening?.unclear) order.unclearOpens = (order.unclearOpens ?? 0) + 1;
      order.opening = undefined;
      this.persistOrders();
      return "none";
    });
  }

  /** Look for an interrupted open's channel again in a minute. */
  private resumeLater(order: Lsps1Order): void {
    if (this.stopping) return;
    const t = setTimeout(() => {
      this.resumeTimers.delete(t);
      const current = this.orders.find((o) => o.orderId === order.orderId);
      if (current && current.orderState === "CREATED" && current.paymentState === "HOLD") void this.fulfill(current);
    }, 60_000);
    t.unref?.();
    this.resumeTimers.add(t);
  }

  /** Funding tx is broadcast — record the outpoint FIRST (so a crash can never
   *  lead to a second open for the same order); the caller then settles and
   *  books the sale, outside the on-chain mutex.
   *
   *  If the record cannot be saved (the disk filled up since the save before
   *  the open), fail closed: the outpoint stays in memory, so this process
   *  never opens again for the order; an alert says what happened; and after
   *  a restart the "opening" mark saved before the open leads recovery to this
   *  channel in LND instead of to a second open. The payment is still settled
   *  — the channel was delivered. */
  private recordChannel(order: Lsps1Order, fundingOutpoint: string): void {
    const expiresAt = new Date(Date.now() + order.channelExpiryBlocks * 10 * 60_000).toISOString();
    order.channel = { fundedAt: new Date().toISOString(), fundingOutpoint, expiresAt };
    order.opening = undefined;
    try {
      this.trimOrders();
      this.ordersStore.writeOrThrow(this.orders);
    } catch (err) {
      const detail =
        `LSP order ${order.orderId}: channel ${fundingOutpoint} opened, but it could not be saved ` +
        `(${err instanceof Error ? err.message : String(err)}). It will not be opened again; after a restart it is found in LND.`;
      console.error(`[lsps1] CRITICAL ${detail}`);
      recordStoreIncident(this.dataDir, { file: "lsps1-orders.json", kind: "unrecorded_open", detail });
    }
  }

  /** The channel is irrevocably opening: claim the held payment. If settling
   *  fails (LND hiccup) retry hard — the alternative is opening for free. */
  private async settleAndRecord(order: Lsps1Order): Promise<void> {
    if (!this.writeLnd) return;
    let settled = false;
    for (let attempt = 0; attempt < 5 && !settled; attempt++) {
      try {
        await this.lndSettle(order.invoiceSecret);
        settled = true;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        await sleep(this.settleRetryBaseMs * (attempt + 1));
      }
    }
    if (!settled) {
      // Channel is opening but the payment isn't claimed yet — keep the order
      // in HOLD; restart recovery retries the settle (the preimage persists,
      // and order.channel being set blocks any second open).
      order.error = "channel opening but settle failed — will retry";
      this.persistOrders();
      console.error(`[lsps1] CRITICAL order ${order.orderId}: settle failed after open — retrying on restart`);
      return;
    }

    order.paymentState = "PAID";
    order.orderState = "COMPLETED";
    order.error = undefined;
    // Book the sale BEFORE saving COMPLETED: if we crash in between, recovery
    // sees a settled invoice on a not-yet-completed order and books it then —
    // recordSale is idempotent, so it can never count twice.
    this.recordSale(order);
    this.persistOrders();
    this.onSale?.(order.orderId, order.lspBalanceSat, order.channel?.fundingOutpoint.split(":")[0] ?? "");
    console.log(
      `[lsps1] order ${order.orderId} COMPLETED: ${order.lspBalanceSat} sat channel, ${order.feeTotalSat} sat fee collected`,
    );
  }

  /** P&L income + the disclosed service fee for a settled order. The fee is
   *  only ENQUEUED — the ledger pays it in the background, so it can never
   *  delay or fail the settle. Income is feeTotalSat, our fee for the lease —
   *  not the hold invoice's amount (orderTotalSat), which would also carry a
   *  client balance: that part is the buyer's own, handed back to them in the
   *  channel. (Today a client balance is refused at order time, so the two are
   *  equal.) Both steps are idempotent per order. */
  private recordSale(order: Lsps1Order): void {
    this.earnings.appendOnce({
      at: new Date().toISOString(),
      via: "lsps1",
      orderId: order.orderId,
      leaseSats: order.feeTotalSat,
    });
    this.serviceFees.enqueue({ source: "lsps1", orderId: order.orderId, earnedSats: order.feeTotalSat });
  }

  /** Any failure with a held payment ends in a refund — cancel the HODL invoice. */
  private async failAndRefund(order: Lsps1Order, reason: string): Promise<void> {
    if (order.orderState !== "CREATED") return;
    try {
      if (this.writeLnd) await this.lndCancel(order.invoiceId);
      if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
    } catch (err) {
      // Cancel failing is unusual; LND cancels held HTLCs itself near CLTV
      // expiry, so funds still return — but log it loudly.
      console.error(`[lsps1] order ${order.orderId}: cancel failed (${err instanceof Error ? err.message : err})`);
    }
    order.orderState = "FAILED";
    order.error = reason;
    this.persistOrders();
    console.warn(`[lsps1] order ${order.orderId} FAILED: ${reason}`);
  }

  /** Re-attach in-flight orders after a restart: resume held payments (or the
   *  missed settle), re-watch unpaid invoices, expire what's already dead. */
  private async recoverOrders(): Promise<void> {
    if (!this.writeLnd) return;
    for (const order of this.orders.filter((o) => o.orderState === "CREATED")) {
      try {
        const inv = await this.lndInvoice(order.invoiceId);
        if (inv.is_confirmed) {
          // We settled before the crash: the channel open succeeded first
          // (settle strictly follows broadcast), only the bookkeeping is lost —
          // so book the sale now (idempotent), or it vanishes from P&L and its
          // service fee is never paid.
          if (order.paymentState !== "PAID" || order.orderState !== "COMPLETED") {
            order.paymentState = "PAID";
            order.orderState = "COMPLETED";
            order.error = order.channel ? undefined : "completed across restart — funding outpoint not recorded";
            this.recordSale(order);
            this.persistOrders();
            this.onSale?.(order.orderId, order.lspBalanceSat, order.channel?.fundingOutpoint.split(":")[0] ?? "");
          }
        } else if (inv.is_held) {
          order.paymentState = "HOLD";
          this.persistOrders();
          this.watchInvoice(order);
          // Sequentially — right after a restart LND is busy enough already.
          await this.fulfill(order);
        } else if (inv.is_canceled || new Date(order.invoiceExpiresAt).getTime() < Date.now()) {
          if (order.paymentState === "HOLD") order.paymentState = "REFUNDED";
          order.orderState = "FAILED";
          order.error ??= "expired across restart";
          this.persistOrders();
        } else {
          this.watchInvoice(order); // still awaiting payment
        }
      } catch (err) {
        console.error(
          `[lsps1] recover ${order.orderId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
