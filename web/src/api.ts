import type {
  Alert,
  AppSettings,
  CloseCandidatesResponse,
  CloseChannelResult,
  AutopilotConfig,
  AutopilotRun,
  AutopilotState,
  ChannelView,
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
  CreatedInvoice,
  DecodedRequest,
  LnActivity,
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
  MarketView,
  MyOffer,
  MyOrdersView,
  OrderState,
  PnlSummary,
  RebalanceAnalysis,
  RebalanceExecResult,
  RebalanceLogResponse,
  RebalancePolicy,
  RebalanceRecReport,
  SuggestionPolicy,
  SuggestionsResponse,
} from "./types";

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
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) detail = body.message;
    } catch {
      // non-JSON error body — keep statusText
    }
    throw new Error(detail);
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
  price: () => get<PriceInfo>("/price"),
  overrides: () => get<OverrideMap>("/overrides"),
  setOverride: (channelId: string, mode: FeeMode, fixedPpm?: number) =>
    post<OverrideMap>("/overrides", { channelId, mode, fixedPpm }),
  alerts: () => get<Alert[]>("/alerts"),
  channelClose: (transactionId: string, transactionVout: number, isForce: boolean) =>
    post<CloseChannelResult>("/channels/close", { transactionId, transactionVout, isForce }),
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
  feesRecommendations: () => get<FeeRecReport>("/fees/recommendations"),
  autopilotGet: () => get<AutopilotState>("/autopilot"),
  autopilotSet: (partial: Partial<AutopilotConfig>) =>
    post<AutopilotState>("/autopilot", partial),
  autopilotRun: () =>
    post<{ run: AutopilotRun; state: AutopilotState }>("/autopilot/run", {}),
  rebalanceCandidates: (policy?: Partial<RebalancePolicy>) => {
    const qs = policy
      ? "?" + new URLSearchParams(
          Object.entries(policy).map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    return get<RebalanceAnalysis>(`/rebalance/candidates${qs}`);
  },
  rebalanceExecute: (params: {
    targetId: string;
    sourceId: string;
    amountSats: number;
    econRatio: number;
    maxFeePpm?: number;
  }) => post<RebalanceExecResult>("/rebalance/execute", params),
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
  channelOpen: (params: {
    pubkey: string;
    socket?: string;
    localTokens: number;
    feeRate?: number;
    isPrivate?: boolean;
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
  onchainSend: (params: { address: string; tokens: number; feeRate: number }) =>
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
  ambossStatus: () => get<{ connected: boolean; saleFeeBps?: number }>("/amboss/status"),
  ambossMarket: () => get<MarketView>("/amboss/market"),
  ambossConnect: (apiKey: string) =>
    post<{ ok: boolean; connected: boolean; error?: string }>("/amboss/key", { apiKey }),
  ambossDisconnect: () => del<{ ok: boolean; connected: boolean }>("/amboss/key"),
  ambossBuyQuote: (usdCents: number, isPrivate: boolean) =>
    post<BuyQuote>("/amboss/buy/quote", { usdCents, private: isPrivate }),
  ambossBuyPay: (orderId: string, paymentRequest: string, maxSats: number) =>
    post<{ ok: boolean; sats: number }>("/amboss/buy/pay", { orderId, paymentRequest, maxSats }),
  ambossOrder: (id: string) => get<OrderState>(`/amboss/order?id=${encodeURIComponent(id)}`),
  signMessage: (message: string) => post<{ signature: string }>("/sign", { message }),
  ambossMyOffers: () => get<{ offers: MyOffer[] }>("/amboss/my-offers"),
  ambossMyOrders: () => get<MyOrdersView>("/amboss/my-orders"),
  ambossCreateOffer: (p: {
    totalSizeSats: number;
    minSizeSats: number;
    maxSizeSats: number;
    feeRatePpm: number;
    baseFeeSats: number;
    minBlockLength: number;
  }) => post<{ ok: boolean }>("/amboss/offer", p),
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
  ) => post<{ ok: boolean }>("/amboss/offer/update", { id, ...p }),
  ambossToggleOffer: (id: string) => post<{ status: string }>("/amboss/offer/toggle", { id }),
  ambossAcceptOrder: (id: string) => post<{ ok: boolean }>("/amboss/order/accept", { id }),
  ambossOpenOrder: (id: string) =>
    post<{ ok: boolean; transactionId: string; outpoint: string }>("/amboss/order/open", { id }),
};
