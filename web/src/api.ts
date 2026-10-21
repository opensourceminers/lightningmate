import type {
  Alert,
  AppSettings,
  CloseCandidatesResponse,
  CloseChannelResult,
  AutopilotChange,
  AutopilotConfigPatch,
  AutopilotRun,
  AutopilotState,
  ChannelView,
  FeeEstimates,
  FeeMode,
  OverrideMap,
  PriceInfo,
  FeeApplyItem,
  FeeApplyResult,
  FeePolicy,
  FeePreview,
  FeeRecReport,
  FlowSummary,
  ForwardsReport,
  HealthInfo,
  CreatedInvoice,
  DecodedRequest,
  LnActivity,
  LspOrder,
  LspStatus,
  PayResult,
  OnchainState,
  OnchainTx,
  NewAddress,
  OnchainSendResult,
  DashboardData,
  NodeScore,
  NodeSummary,
  OpenChannelResult,
  BuyQuote,
  BuyOffersResponse,
  Eligibility,
  MagmaPurchase,
  SellDiagnostics,
  MagmaV2Report,
  MarketView,
  OutcomesReport,
  AmbossStatus,
  DeskResult,
  MyOffer,
  MyOffersResponse,
  MyOrdersView,
  OfferSyncStatus,
  OrderState,
  PnlSummary,
  RebalanceExecRequest,
  RebalanceExecResult,
  RebalanceLogResponse,
  RebalanceRecReport,
  BackupStatus,
  SuggestionPolicy,
  SuggestionsResponse,
  LnPlusStatus,
  LnPlusPoolResponse,
  LnPlusSwapsResponse,
  UnservedDemandReport,
} from "./types";
import { ApiError } from "./apiError";

export { ApiError };

// ── Session token ─────────────────────────────────────────────────────────────
let token = localStorage.getItem("lm_token") ?? "";
let onUnauthorized: (() => void) | null = null;

function setToken(t: string): void {
  token = t;
  if (t) localStorage.setItem("lm_token", t);
  else localStorage.removeItem("lm_token");
}
/** App registers this so an expired/invalid session bounces back to the login screen. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}
const authHeaders = (): Record<string, string> =>
  token ? { Authorization: `Bearer ${token}` } : {};

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    let detail = res.statusText;
    let body: unknown = null;
    try {
      body = await res.json();
      const message = (body as { message?: unknown } | null)?.message;
      if (typeof message === "string" && message) detail = message;
    } catch {
      // non-JSON error body — keep statusText
    }
    throw new ApiError(detail, res.status, body);
  }
  return (await res.json()) as T;
}

async function get<T>(path: string): Promise<T> {
  return handle<T>(await fetch(`/api${path}`, { headers: authHeaders() }));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(
    await fetch(`/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
    }),
  );
}

async function del<T>(path: string): Promise<T> {
  return handle<T>(await fetch(`/api${path}`, { method: "DELETE", headers: authHeaders() }));
}

export const api = {
  node: () => get<NodeSummary>("/node"),
  dashboard: () => get<DashboardData>("/dashboard"),
  channels: () => get<ChannelView[]>("/channels"),
  flows: (days?: number) => get<FlowSummary>(days ? `/flows?days=${days}` : "/flows"),
  pnl: (days: number) => get<PnlSummary>(`/pnl?days=${days}`),
  score: () => get<NodeScore>("/score"),
  getSettings: () => get<AppSettings>("/settings"),
  setSettings: (s: Partial<AppSettings>) => post<AppSettings>("/settings", s),
  lspStatus: () => get<LspStatus>("/lsp/status"),
  lspOrders: () => get<{ orders: LspOrder[] }>("/lsp/orders"),
  htlcDemand: (days = 7) => get<UnservedDemandReport>(`/htlc/demand?days=${days}`),
  price: () => get<PriceInfo>("/price"),
  overrides: () => get<OverrideMap>("/overrides"),
  setOverride: (channelId: string, mode: FeeMode, fixedPpm?: number) =>
    post<OverrideMap>("/overrides", { channelId, mode, fixedPpm }),
  alerts: () => get<Alert[]>("/alerts"),
  alertAck: (id: string) => post<{ ok: boolean }>("/alerts/ack", { id }),
  health: () => get<HealthInfo>("/health"),
  channelClose: (transactionId: string, transactionVout: number, isForce: boolean, feeRate?: number) =>
    post<CloseChannelResult>("/channels/close", { transactionId, transactionVout, isForce, feeRate }),
  feeEstimates: () => get<FeeEstimates>("/chain/fee-estimates"),
  forwardsReport: (days: number) => get<ForwardsReport>(`/forwards/report?days=${days}`),
  feesPreview: (policy?: Partial<FeePolicy>) => {
    const qs = policy
      ? "?" + new URLSearchParams(
          Object.entries(policy).map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    return get<FeePreview>(`/fees/preview${qs}`);
  },
  feesApply: (items: FeeApplyItem[]) =>
    post<{ results: FeeApplyResult[] }>("/fees/apply", { items }),
  /** Apply what the engine recommends for these channels (target AND base
   *  fee, recomputed server-side), on the autopilot's books. */
  feesApplyRecommended: (channelIds: string[]) =>
    post<{ changes: AutopilotChange[] }>("/fees/apply-recommended", { channelIds }),
  feesRecommendations: () => get<FeeRecReport>("/fees/recommendations"),
  autopilotGet: () => get<AutopilotState>("/autopilot"),
  autopilotSet: (patch: AutopilotConfigPatch) => post<AutopilotState>("/autopilot", patch),
  autopilotRun: () =>
    post<{ run: AutopilotRun; state: AutopilotState }>("/autopilot/run", {}),
  /** A refill by hand. It counts toward the daily rebalance budget: its fee
   *  is capped at what is left (and at maxFeeSats, what the confirm dialog
   *  promised); with nothing left — or a payment still in flight through one
   *  of its channels — the server answers 409. */
  rebalanceExecute: (params: RebalanceExecRequest) => post<RebalanceExecResult>("/rebalance/execute", params),
  rebalanceLog: () => get<RebalanceLogResponse>("/rebalance/log"),
  rebalanceRecommendations: () => get<RebalanceRecReport>("/rebalance/recommendations"),
  suggestions: (policy?: Partial<SuggestionPolicy>) => {
    const qs = policy
      ? "?" + new URLSearchParams(
          Object.entries(policy).map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    return get<SuggestionsResponse>(`/suggestions${qs}`);
  },
  closeCandidates: (days?: number) =>
    get<CloseCandidatesResponse>(days ? `/suggestions/close?days=${days}` : "/suggestions/close"),

  // ── lightningnetwork.plus (read-only, no key) ──
  lnplusStatus: () => get<LnPlusStatus>("/lnplus/status"),
  lnplusPool: (minCreditsSats?: number) =>
    get<LnPlusPoolResponse>(minCreditsSats ? `/lnplus/pool?minCredits=${minCreditsSats}` : "/lnplus/pool"),
  lnplusSwaps: (status?: "pending" | "opening" | "completed") =>
    get<LnPlusSwapsResponse>(status ? `/lnplus/swaps?status=${status}` : "/lnplus/swaps"),
  /** A 409 "capital_promised" refusal (coins promised to buyers) is thrown
   *  as an ApiError; send again with `spendPromised: true` only after the
   *  operator confirmed spending them (see statusNotes promisedSpend). */
  channelOpen: (params: {
    pubkey: string;
    socket?: string;
    localTokens: number;
    feeRate?: number;
    isPrivate?: boolean;
    spendPromised?: boolean;
  }) => post<OpenChannelResult>("/channels/open", params),
  lnActivity: () => get<LnActivity>("/ln/activity"),
  lnDecode: (request: string) => post<DecodedRequest>("/ln/decode", { request }),
  lnInvoice: (params: { tokens: number; description: string; expirySec?: number }) =>
    post<CreatedInvoice>("/ln/invoice", params),
  lnPay: (params: { request: string; maxFeeSats: number; tokens?: number }) =>
    post<PayResult>("/ln/pay", params),
  onchainState: () => get<OnchainState>("/onchain"),
  onchainTxs: () => get<OnchainTx[]>("/onchain/txs"),
  onchainAddress: () => post<NewAddress>("/onchain/address", {}),
  onchainSend: (params: { address: string; tokens: number; feeRate: number; spendPromised?: boolean }) =>
    post<OnchainSendResult>("/onchain/send", params),
  authStatus: () => get<{ authRequired: boolean; unlocked: boolean }>("/auth/status"),
  login: async (password: string): Promise<boolean> => {
    const res = await fetch("/api/auth/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return false;
    const { token: t } = (await res.json()) as { token: string };
    setToken(t);
    return true;
  },
  logout: () => {
    setToken("");
    onUnauthorized?.();
  },
  ambossStatus: () => get<AmbossStatus>("/amboss/status"),
  /** Ask Amboss about the key now (the "Re-check" button). */
  ambossKeyCheck: () => post<AmbossStatus>("/amboss/key/check", {}),
  ambossMarket: () => get<MarketView>("/amboss/market"),
  ambossConnect: (apiKey: string) =>
    post<{ ok: boolean; connected: boolean; error?: string }>("/amboss/key", { apiKey }),
  ambossDisconnect: () => del<{ ok: boolean; connected: boolean }>("/amboss/key"),
  // Without offerId Amboss picks the seller; with it, the user's pick decides.
  ambossBuyQuote: (usdCents: number, isPrivate: boolean, target?: { offerId: string; sizeSats: number }) =>
    post<BuyQuote & { sellerChosen?: boolean }>("/amboss/buy/quote", {
      usdCents,
      private: isPrivate,
      ...(target ?? {}),
    }),
  /** Pays only the invoice recorded with the quote, for the confirmed amount. */
  ambossBuyPay: (orderId: string, maxSats: number) =>
    post<{ ok: boolean; sats: number }>("/amboss/buy/pay", { orderId, maxSats }),
  /** The buyer declined the quote: cancel the order on Amboss. */
  ambossBuyCancel: (orderId: string) =>
    post<{ ok: boolean; cancelled: boolean; message: string }>("/amboss/buy/cancel", { orderId }),
  /** The book ranked for this node at `sizeSats` (lease, conditions, Amboss fee, caps). */
  ambossBuyOffers: (sizeSats: number) => get<BuyOffersResponse>(`/amboss/buy-offers?size=${Math.round(sizeSats)}`),
  /** Inbound bought here: quotes, cancels, payments, channels. */
  ambossPurchases: () => get<{ purchases: MagmaPurchase[] }>("/amboss/purchases"),
  /** Can this node realistically sell on Magma? (live, indicative) */
  magmaEligibility: (refresh = false) => get<Eligibility>(`/amboss/eligibility${refresh ? "?refresh=1" : ""}`),
  /** "Why don't I sell?" — the checklist from the live state. */
  sellDiagnostics: () => get<SellDiagnostics>("/amboss/sell-diagnostics"),
  /** Hand an offer to the autopilot (true) or take it over (false). */
  ambossOfferAutomation: (id: string, managed: boolean) =>
    post<{ ok: boolean; sync: OfferSyncStatus }>("/amboss/offer/automation", { id, managed }),
  ambossOrder: (id: string) => get<OrderState>(`/amboss/order?id=${encodeURIComponent(id)}`),
  signMessage: (message: string) => post<{ signature: string }>("/sign", { message }),
  ambossMyOffers: () => get<MyOffersResponse>("/amboss/my-offers"),
  ambossOfferSync: () => get<OfferSyncStatus>("/amboss/offer-sync"),
  ambossMyOrders: () => get<MyOrdersView>("/amboss/my-orders"),
  magmaRecommendations: () => get<MagmaV2Report>("/amboss/recommendations"),
  autopilotOutcomes: () => get<OutcomesReport>("/autopilot/outcomes"),
  ambossCreateOffer: (p: {
    totalSizeSats: number;
    minSizeSats: number;
    maxSizeSats: number;
    feeRatePpm: number;
    baseFeeSats: number;
    minBlockLength: number;
  }) => post<{ ok: boolean; offerId: string }>("/amboss/offer", p),
  ambossUpdateOffer: (
    id: string,
    p: {
      totalSizeSats: number;
      minSizeSats: number;
      maxSizeSats: number;
      feeRatePpm: number;
      baseFeeSats: number;
      minBlockLength: number;
    },
  ) => post<{ ok: boolean; verified: boolean | null; offer: MyOffer | null }>("/amboss/offer/update", { id, ...p }),
  /** Flip an offer — or, with `want`, put it in that state (read first,
   *  flipped only if needed; an answer that isn't `want` throws). */
  ambossToggleOffer: (id: string, want?: "ENABLED" | "DISABLED") =>
    post<{ status: string; changed?: boolean }>("/amboss/offer/toggle", want ? { id, want } : { id }),
  // Manual order actions go through the same order journal as the autopilot;
  // a failure answers with an error status (thrown here), never 200 + ok:false.
  ambossAcceptOrder: (id: string) => post<DeskResult>("/amboss/order/accept", { id }),
  ambossOpenOrder: (id: string) => post<DeskResult>("/amboss/order/open", { id }),
  ambossRejectOrder: (id: string) => post<DeskResult>("/amboss/order/reject", { id }),
  backupStatus: () => get<BackupStatus>("/backup/status"),
  // Download the channel backup with the auth header, then trigger a browser
  // download of a `channel.backup` file from the response blob.
  backupExport: async (): Promise<void> => {
    const res = await fetch("/api/backup/export", { method: "POST", headers: authHeaders() });
    if (!res.ok) {
      if (res.status === 401) onUnauthorized?.();
      let detail = `Export failed (${res.status}).`;
      try {
        const body = (await res.json()) as { message?: string };
        if (body.message) detail = body.message;
      } catch {
        // binary or empty body — keep the default detail
      }
      throw new Error(detail);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "channel.backup";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
