import {
  addAdvertisedFeature,
  addExternalSocket,
  cancelHodlInvoice,
  createHodlInvoice,
  getChainBalance,
  getChainFeeRate,
  getInvoice,
  removeExternalSocket,
  sendMessageToPeer,
  settleHodlInvoice,
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
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { EventEmitter } from "node:events";
import { JsonStore } from "../store.js";
import type { SettingsStore } from "./settings.js";
import type { EarningsLog } from "./earningsLog.js";
import { getMagmaRecommendations, MAGMA_V2_DEFAULTS } from "./magmaRecommend.js";
import { onchainCosts } from "./nodeEconomics.js";
import { paySaleServiceFee, saleFeeConfig } from "./serviceFee.js";
import { openChannelTo } from "./channelOps.js";

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
const ORDERS_KEPT = 200;
const BLOCKS_PER_YEAR = MAGMA_V2_DEFAULTS.blocksPerYear;

type JsonRpcId = string | number | null;

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

/** ln-service throws array errors: [code, name, { err }] — dig out the detail. */
function lndErrorDetail(err: unknown): string {
  if (Array.isArray(err)) {
    const extra = err[2] as { err?: { details?: string; message?: string } } | undefined;
    return extra?.err?.details ?? extra?.err?.message ?? String(err[1] ?? err[0]);
  }
  return err instanceof Error ? err.message : String(err);
}

// ── orders ────────────────────────────────────────────────────────────────────

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
  serviceFeePaidSat: number;
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
  private chainCache: { at: number; sats: number } | undefined;
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

  constructor(
    dataDir: string,
    private readonly readLnd: AuthenticatedLnd,
    private readonly writeLnd: AuthenticatedLnd | undefined,
    private readonly settings: SettingsStore,
    /** Live sell caps (shared with Magma): max channel size, on-chain reserve,
     *  aggregate deploy cap. */
    private readonly caps: () => { maxChannelSats: number; reserveSats: number; maxDeploySats: number },
    /** Magma pricing mode + adaptive level, so both demand sources price alike. */
    private readonly pricingMode: () => { sellPricingMode: "fast" | "balanced" | "premium" | "auto"; adaptiveLevel: number },
    private readonly ambossKey: () => string,
    private readonly earnings: EarningsLog,
    /** Surface a completed sale in the run history / Overview digest. */
    private readonly onSale?: (orderId: string, sizeSats: number, transactionId: string) => void,
  ) {
    this.ordersStore = new JsonStore<Lsps1Order[]>(dataDir, "lsps1-orders.json");
    this.orders = this.ordersStore.read([]);
  }

  start(): void {
    this.applySettings();
    void this.recoverOrders();
    // Hourly re-check of the announced clearnet address: a DDNS name follows
    // the home IP, so re-resolve and swap the announcement when it moved.
    const timer = setInterval(() => void this.applyAnnouncedSocket(), 60 * 60_000);
    timer.unref?.();
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

  /** Capital promised to paid-but-not-yet-opened orders — the autopilot subtracts
   *  this from its own budget so both demand sources can't plan the same coins. */
  committedSat(): number {
    return this.orders
      .filter((o) => o.orderState === "CREATED" && o.paymentState === "HOLD")
      .reduce((s, o) => s + o.lspBalanceSat, 0);
  }

  /** Capital sitting in LSPS1-sold channels whose lease hasn't expired —
   *  counts against the shared sellMaxDeploySats cap (as Magma's deployed does). */
  deployedSat(): number {
    const now = Date.now();
    return this.orders
      .filter(
        (o) => o.orderState === "COMPLETED" && o.channel && new Date(o.channel.expiresAt).getTime() > now,
      )
      .reduce((s, o) => s + o.lspBalanceSat, 0);
  }

  /** Deploy-cap headroom for a NEW order: cap minus deployed (unexpired) minus
   *  every open order (paid or not — an unpaid order reserves its size until it
   *  expires, so two buyers can't oversell the cap together; MAX_PENDING_* keeps
   *  the reservation window abuse-bounded). Magma's own deployed capital is
   *  enforced on the autopilot side via setExternalDeployed. */
  private deployHeadroomSat(): number {
    const reserved = this.orders
      .filter((o) => o.orderState === "CREATED")
      .reduce((s, o) => s + o.lspBalanceSat, 0);
    return Math.max(0, this.caps().maxDeploySats - this.deployedSat() - reserved);
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
      serviceFeePaidSat: o.serviceFeePaidSat,
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
    if (this.sub || !this.writeLnd) return;
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
    if (!this.settings.get().lspModeEnabled || this.retryTimer) return;
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
    return createHodlInvoice({ lnd: this.writeLnd!, id, tokens, description, expires_at: expiresAt });
  }
  private lndSettle(secret: string) {
    return settleHodlInvoice({ lnd: this.writeLnd!, secret });
  }
  private lndCancel(id: string) {
    return cancelHodlInvoice({ lnd: this.writeLnd!, id });
  }
  private lndInvoice(id: string) {
    return getInvoice({ lnd: this.writeLnd!, id });
  }
  private lndOpen(order: Lsps1Order, feeRate: number | undefined) {
    return openChannelTo(this.writeLnd!, {
      pubkey: order.peer,
      localTokens: order.lspBalanceSat,
      feeRate,
      isPrivate: !order.announceChannel,
    });
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

  /** Deployable on-chain capital (balance minus the sell reserve), cached 30s. */
  private async deployableSat(fresh = false): Promise<number> {
    if (!this.writeLnd) return 0;
    if (fresh || !this.chainCache || Date.now() - this.chainCache.at > 30_000) {
      const { chain_balance } = await getChainBalance({ lnd: this.writeLnd });
      this.chainCache = { at: Date.now(), sats: chain_balance };
    }
    return Math.max(0, this.chainCache.sats - this.caps().reserveSats);
  }

  private async offerView() {
    const deployable = await this.deployableSat();
    // Never advertise more than we could actually fund, capped by the shared
    // Magma sell cap; clamped up to min so the min ≤ max spec constraint holds
    // even when the wallet is empty (create_order enforces real capital).
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
    if (lspBalanceSat > this.deployHeadroomSat()) {
      return rpcError(rid, 1, "Client rejected", { message: "LSP is at its capital deployment cap — try again later" });
    }

    const { feeTotalSat } = await this.quote(lspBalanceSat, expiryBlocks);

    // HODL invoice: we hold the payment until the channel is irrevocably
    // opening, then settle with the preimage; every failure path cancels
    // instead — the buyer's payment automatically bounces back.
    const secret = randomBytes(32);
    const invoiceId = sha256(secret);
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
      announceChannel: p.announce_channel,
      orderState: "CREATED",
      paymentState: "EXPECT_PAYMENT",
      feeTotalSat,
      orderTotalSat: feeTotalSat, // + client_balance (always 0)
      invoice: inv.request,
      invoiceId,
      invoiceSecret: secret.toString("hex"),
      invoiceExpiresAt: expiresAt,
      channel: null,
      serviceFeePaidSat: 0,
    };
    this.orders.unshift(order);
    this.persistOrders();
    this.watchInvoice(order);
    console.log(`[lsps1] order ${orderId}: ${lspBalanceSat} sat / ${expiryBlocks} blocks → ${feeTotalSat} sat fee`);
    return rpcResult(rid, this.orderPayload(order));
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
    this.orders = this.orders.slice(0, ORDERS_KEPT);
    this.ordersStore.write(this.orders);
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
      // Capital gate with a FRESH balance — the offer cache may be 30s old.
      const deployable = await this.deployableSat(true);
      if (order.lspBalanceSat > deployable) {
        await this.failAndRefund(order, "insufficient on-chain capital at open time");
        return;
      }
      // Deploy cap re-check at open time — catches a cap the user LOWERED
      // after this order was created (create-time already serialized siblings).
      if (this.deployedSat() + order.lspBalanceSat > this.caps().maxDeploySats) {
        await this.failAndRefund(order, "capital deployment cap reached");
        return;
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
        const res = await this.lndOpen(order, feeRate);
        if (res.ok && res.transactionId) {
          await this.completeOrder(order, `${res.transactionId}:${res.transactionVout ?? 0}`);
          return;
        }
        lastError = res.error ?? "open failed";
        // Only a connect problem is worth waiting out; anything else is final.
        if (!lastError.includes("couldn't connect")) break;
      }
      await this.failAndRefund(order, lastError);
    } catch (err) {
      await this.failAndRefund(order, err instanceof Error ? err.message : String(err));
    } finally {
      this.fulfilling.delete(order.orderId);
    }
  }

  /** Funding tx is broadcast — record the outpoint FIRST (so a crash can never
   *  lead to a second open for the same order), then settle and book the sale. */
  private async completeOrder(order: Lsps1Order, fundingOutpoint: string): Promise<void> {
    const expiresAt = new Date(Date.now() + order.channelExpiryBlocks * 10 * 60_000).toISOString();
    order.channel = { fundedAt: new Date().toISOString(), fundingOutpoint, expiresAt };
    this.persistOrders();
    await this.settleAndRecord(order);
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

    // Disclosed service fee on a completed sale — best-effort, never throws
    // (same rules as Magma sales: env-driven rate, skipped when self/disabled).
    const fee = await paySaleServiceFee(this.writeLnd, order.feeTotalSat);
    if (fee.paid) console.log(`[fee] lsps1 order ${order.orderId}: paid ${fee.sats} sat service fee`);
    order.serviceFeePaidSat = fee.paid ? fee.sats : 0;
    this.persistOrders();

    // Record the sale for P&L, and surface it in the run history / digest.
    this.earnings.append({
      at: new Date().toISOString(),
      via: "lsps1",
      orderId: order.orderId,
      leaseSats: order.feeTotalSat,
      feePaidSats: order.serviceFeePaidSat,
    });
    this.onSale?.(order.orderId, order.lspBalanceSat, order.channel?.fundingOutpoint.split(":")[0] ?? "");
    console.log(
      `[lsps1] order ${order.orderId} COMPLETED: ${order.lspBalanceSat} sat channel, ${order.feeTotalSat} sat fee collected`,
    );
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
          // (settle strictly follows broadcast), only the bookkeeping is lost.
          if (order.paymentState !== "PAID") {
            order.paymentState = "PAID";
            order.orderState = "COMPLETED";
            order.error = order.channel ? undefined : "completed across restart — funding outpoint not recorded";
            this.persistOrders();
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
