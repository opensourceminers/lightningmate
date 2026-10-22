import { CapitalLedger } from "../../src/services/capital.js";
import { EarningsLog } from "../../src/services/earningsLog.js";
import { LSPS0_MESSAGE_TYPE, Lsps1Service, type Lsps1Order } from "../../src/services/lsps1.js";
import { ServiceFeeLedger } from "../../src/services/serviceFee.js";
import { SettingsStore } from "../../src/services/settings.js";
import { FakeLnd } from "./fakeLnd.js";
import { makeTempDir, type AfterHook } from "./tmp.js";

/**
 * LSP mode on a fake node, and a wallet that orders from it the way ZEUS does:
 * JSON-RPC 2.0 over BOLT8 custom messages (LSPS0, type 37913) — through the
 * real subscribeToPeerMessages / sendMessageToPeer of the `lightning` library.
 *
 *   const lsp = lspNode(t);
 *   const zeus = lspsWallet(lsp.node, lsp.buyer);
 *   const info = await zeus.call("lsps1.get_info", {});
 *
 * The market side of the price is not under test: the Magma engine's report
 * fails (the local profit floor prices), unless a test replaces it.
 */

/** A buyer node: connected to ours — it placed its order over BOLT8. */
export const BUYER = "02" + "b7".repeat(32);

/** The private parts of the service a test drives or watches. */
export interface LspSeams {
  orders: Lsps1Order[];
  fulfill(o: Lsps1Order): Promise<void>;
  recoverOrders(): Promise<void>;
  /** Save the order list (trimmed first, as every save does). */
  persistOrders(): void;
  marketReport: () => Promise<unknown>;
  lndConnect: (pubkey: string) => Promise<boolean>;
  lndOpen: (order: Lsps1Order, feeRate: number | undefined) => Promise<unknown>;
  lndSettle: (secret: string) => Promise<void>;
  lndCancel: (id: string) => Promise<void>;
  lndInvoice: (id: string) => Promise<unknown>;
  /** Live invoice watches, by payment hash. */
  invoiceSubs: Map<string, unknown>;
  openRetryDelayMs: number;
  settleRetryBaseMs: number;
  recoveryRetryMinMs: number;
  recoveryRetryMs: number;
  /** The wait before the peer-message stream is subscribed again. */
  retryMs: number;
  pricingWaitMs: number;
  pricingCache: { at: number } | undefined;
}

export interface LspNode {
  dir: string;
  node: FakeLnd;
  svc: Lsps1Service;
  seams: LspSeams;
  settings: SettingsStore;
  capital: CapitalLedger;
  fees: ServiceFeeLedger;
  earnings: EarningsLog;
  buyer: string;
}

/** `writeDenied`: the gRPC methods LND refuses the write client (its macaroon
 *  lacks them, FakeLnd.withoutPermission); the read client may call all. */
export function lspNode(
  t: AfterHook,
  opts: {
    node?: FakeLnd;
    dir?: string;
    lspMode?: boolean;
    caps?: { maxChannelSats: number; reserveSats: number; maxDeploySats: number };
    writeDenied?: string[];
  } = {},
): LspNode {
  const dir = opts.dir ?? makeTempDir(t);
  const node = opts.node ?? new FakeLnd({ chainBalance: 20_000_000, peers: [BUYER] });
  const settings = new SettingsStore(dir);
  if (opts.lspMode !== false) settings.set({ lspModeEnabled: true });
  const capital = new CapitalLedger();
  const fees = new ServiceFeeLedger(dir, null);
  const earnings = new EarningsLog(dir);
  const caps = opts.caps ?? { maxChannelSats: 10_000_000, reserveSats: 50_000, maxDeploySats: 50_000_000 };
  const svc = new Lsps1Service(
    dir,
    node.lnd,
    opts.writeDenied?.length ? node.withoutPermission(...opts.writeDenied) : node.lnd,
    settings,
    () => caps,
    () => ({ sellPricingMode: "balanced", adaptiveLevel: 0.5, offerFeeCaps: { feeRateCapPpm: 2_200, baseFeeCapSats: 1 } }),
    () => "",
    earnings,
    fees,
    undefined,
    capital,
  );
  const seams = svc as unknown as LspSeams;
  seams.marketReport = async () => {
    throw new Error("the market is not under test");
  };
  t.after(() => svc.stop());
  return { dir, node, svc, seams, settings, capital, fees, earnings, buyer: BUYER };
}

/** What ZEUS v13.2.3 sends with every create_order (stores/LSPStore.ts):
 *  an informational description of itself. */
export const ZEUS_CLIENT_INFO = { app: "ZEUS", app_version: "v13.2.3", platform: "android", backend: "embedded-lnd" };

/** ZEUS's create_order params: sizes as strings, the lease from its presets
 *  (1/3/6/12 months = 4,380 / 13,140 / 26,280 / 52,560 blocks), empty token
 *  and refund address, and client_info. */
export function zeusOrder(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lsp_balance_sat: "1000000",
    client_balance_sat: "0",
    required_channel_confirmations: 1,
    funding_confirms_within_blocks: 6,
    channel_expiry_blocks: 13_140,
    token: "",
    refund_onchain_address: "",
    announce_channel: false,
    client_info: ZEUS_CLIENT_INFO,
    ...o,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A wallet speaking LSPS0 from `pubkey`: each call sends one JSON-RPC
 *  request and resolves with the node's reply to it. */
export function lspsWallet(node: FakeLnd, pubkey: string) {
  let nextId = 1;
  const replyTo = async (id: string | number | null, from: number, ms: number): Promise<any> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      for (const m of node.sentMessages.slice(from)) {
        if (m.peer !== pubkey || m.type !== LSPS0_MESSAGE_TYPE) continue;
        const body = JSON.parse(m.data.toString("utf8"));
        if (body.id === id) return body;
      }
      await sleep(5);
    }
    throw new Error(`no reply to request ${String(id)} within ${ms} ms`);
  };
  return {
    async call(method: string, params?: unknown, ms = 10_000): Promise<any> {
      const id = `w-${nextId++}`;
      const from = node.sentMessages.length;
      node.peerMessage(pubkey, LSPS0_MESSAGE_TYPE, JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
      return replyTo(id, from, ms);
    },
    /** Send any text; resolves with the reply carrying `id` (null for a
     *  parse error). */
    async raw(text: string, id: string | number | null, ms = 10_000): Promise<any> {
      const from = node.sentMessages.length;
      node.peerMessage(pubkey, LSPS0_MESSAGE_TYPE, text);
      return replyTo(id, from, ms);
    },
  };
}
