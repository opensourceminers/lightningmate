import {
  getChainBalance,
  sendMessageToPeer,
  subscribeToPeerMessages,
  type AuthenticatedLnd,
} from "lightning";
import type { EventEmitter } from "node:events";
import type { SettingsStore } from "./settings.js";

/**
 * LSP mode phase 1 — LSPS0 transport + `lsps1.get_info` (bLIP-50 / bLIP-51).
 *
 * Wallets and nodes speaking the open LSP standard connect to us as a peer and
 * talk JSON-RPC 2.0 over BOLT8 custom messages (type 37913). Phase 1 is
 * discovery-only: we answer `lsps0.list_protocols` and `lsps1.get_info` so a
 * client (e.g. ZEUS) can see our channel offer. Orders (`lsps1.create_order`,
 * HODL invoice, open-on-payment) land in phase 2.
 *
 * Spec rules implemented here (bLIP-50):
 *  - one BOLT8 message = one complete JSON-RPC 2.0 object, UTF-8 encoded
 *  - malformed payload → error `-32700` with `id: null`, then ignore
 *  - unknown method → `-32601`; unrecognized params → `-32602` with
 *    `data.unrecognized`
 *  - notifications from clients (no `id`) are ignored
 *  - never send 37913 to a peer that hasn't sent one first (we only respond)
 */

/** BOLT8 custom message type carrying all LSPS traffic (bLIP-50). */
export const LSPS0_MESSAGE_TYPE = 37913;

/**
 * Our fixed LSPS1 offer parameters. Sizes are shared with the Magma sell caps
 * (one capital budget across both demand sources); these are the protocol-side
 * constants that don't depend on live balances.
 */
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

type JsonRpcId = string | number | null;

const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

export interface Lsps1Status {
  enabled: boolean;
  /** Peer-message subscription is live (write mode on + LND reachable). */
  running: boolean;
  canWrite: boolean;
  requestsServed: number;
  lastRequestAt: string | null;
  lastError: string | null;
  /** What `lsps1.get_info` currently answers — shown in the Settings card. */
  offer: {
    minChannelSat: number;
    maxChannelSat: number;
    deployableSat: number;
    maxChannelExpiryBlocks: number;
    minFundingConfirmsWithinBlocks: number;
  } | null;
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

  constructor(
    private readonly writeLnd: AuthenticatedLnd | undefined,
    private readonly settings: SettingsStore,
    /** Live sell caps (shared with Magma): max channel size + on-chain reserve. */
    private readonly caps: () => { maxChannelSats: number; reserveSats: number },
  ) {}

  start(): void {
    this.applySettings();
  }

  /** Call after the LSP-mode toggle changes — starts/stops the subscription. */
  applySettings(): void {
    if (this.settings.get().lspModeEnabled && this.writeLnd) this.startSub();
    else this.stopSub();
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
    return {
      enabled,
      running: !!this.sub,
      canWrite: !!this.writeLnd,
      requestsServed: this.requestsServed,
      lastRequestAt: this.lastRequestAt,
      lastError: this.lastError,
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
    // Removing all listeners terminates the underlying gRPC subscription.
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
    if (msg.type !== LSPS0_MESSAGE_TYPE) return;
    if (!this.settings.get().lspModeEnabled) return;
    if (!this.allowPeer(msg.public_key)) return; // over budget → stay silent
    const raw = Buffer.from(msg.message, "hex").toString("utf8");
    const response = await this.dispatch(raw);
    if (response) await this.send(msg.public_key, response);
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

  private async dispatch(raw: string): Promise<Record<string, unknown> | null> {
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
    const paramKeys = Object.keys((params ?? {}) as Record<string, unknown>);

    switch (method) {
      case "lsps0.list_protocols": {
        if (paramKeys.length) {
          return rpcError(rid, -32602, "unrecognized parameter", { unrecognized: paramKeys });
        }
        this.served();
        return rpcResult(rid, { protocols: [1] });
      }
      case "lsps1.get_info": {
        if (paramKeys.length) {
          return rpcError(rid, -32602, "unrecognized parameter", { unrecognized: paramKeys });
        }
        try {
          const info = await this.getInfo();
          this.served();
          return rpcResult(rid, info);
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err);
          return rpcError(rid, -32603, "Internal error");
        }
      }
      case "lsps1.create_order":
      case "lsps1.get_order":
        // Phase 1 is discovery-only; orders arrive in phase 2.
        return rpcError(rid, -32601, "Method not found (orders are not yet available)");
      default:
        return rpcError(rid, -32601, "Method not found");
    }
  }

  private served(): void {
    this.requestsServed += 1;
    this.lastRequestAt = new Date().toISOString();
  }

  // ── the offer ────────────────────────────────────────────────────────────────

  /** Deployable on-chain capital (balance minus the sell reserve), cached 30s. */
  private async deployableSat(): Promise<number> {
    if (!this.writeLnd) return 0;
    if (!this.chainCache || Date.now() - this.chainCache.at > 30_000) {
      const { chain_balance } = await getChainBalance({ lnd: this.writeLnd });
      this.chainCache = { at: Date.now(), sats: chain_balance };
    }
    return Math.max(0, this.chainCache.sats - this.caps().reserveSats);
  }

  private async offerView() {
    const deployable = await this.deployableSat();
    // Never advertise more than we could actually fund, capped by the shared
    // Magma sell cap; clamped up to min so the min ≤ max spec constraint holds
    // even when the wallet is empty (create_order enforces real capital in P2).
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
}
