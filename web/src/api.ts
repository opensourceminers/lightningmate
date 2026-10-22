import type {
  Alert,
  AlertAckRequest,
  AlertAckResult,
  AmbossKeyRequest,
  AmbossKeyResult,
  AmbossStatus,
  AppSettings,
  ApplyRecommendedRequest,
  ApplyRecommendedResponse,
  AuthStatus,
  AuthUnlockRequest,
  AuthUnlockResult,
  AutopilotConfigPatch,
  AutopilotResumeResult,
  AutopilotRunResult,
  AutopilotState,
  BackupStatus,
  BoughtInboundResponse,
  BuyCancelRequest,
  BuyCancelResult,
  BuyOffersResponse,
  BuyPayRequest,
  BuyPayResult,
  BuyQuoteRequest,
  BuyQuoteResponse,
  ChannelCloseRequest,
  ChannelOpenRequest,
  ChannelView,
  CloseCandidatesResponse,
  CloseChannelResult,
  CreatedInvoice,
  DashboardData,
  DaysQuery,
  DecodedRequest,
  DeskResult,
  Eligibility,
  EligibilityQuery,
  FeeApplyItem,
  FeeApplyRequest,
  FeeApplyResponse,
  FeeEstimates,
  FeeMode,
  FeePreview,
  FeePreviewQuery,
  FeeRecReport,
  FlowSummary,
  ForwardsReport,
  ForwardsReportQuery,
  HealthInfo,
  LnActivity,
  LnDecodeRequest,
  LnInvoiceRequest,
  LnPayRequest,
  LnPlusPoolQuery,
  LnPlusPoolResponse,
  LnPlusStatus,
  LnPlusSwapsQuery,
  LnPlusSwapsResponse,
  LspOrdersResponse,
  LspStatus,
  MagmaV2Report,
  MarketView,
  MyOffersResponse,
  MyOrdersView,
  NeverOpenRequest,
  NeverOpenResult,
  NewAddress,
  NodeScore,
  NodeSummary,
  OfferAutomationRequest,
  OfferAutomationResult,
  OfferCreateResult,
  OfferSyncStatus,
  OfferTermsRequest,
  OfferToggleRequest,
  OfferToggleResult,
  OfferUpdateRequest,
  OfferUpdateResult,
  OnchainSendRequest,
  OnchainSendResult,
  OnchainState,
  OnchainTx,
  OpenChannelResult,
  OpenEstimate,
  OrderActionRequest,
  OrderQuery,
  OrderState,
  OutcomesReport,
  OverrideMap,
  OverrideRequest,
  PayResult,
  PeerConnectRequest,
  PeerConnectResult,
  PnlSummary,
  PriceInfo,
  PrivacyInfo,
  PurchasesResponse,
  RebalanceCostsResponse,
  RebalanceExecRequest,
  RebalanceExecResult,
  RebalanceLogResponse,
  RebalanceRecReport,
  SellDiagnostics,
  SendPreview,
  SendPreviewQuery,
  SettingsPatch,
  SignRequest,
  SignResult,
  SizeQuery,
  SuggestionsQuery,
  SuggestionsResponse,
  TzQuery,
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

/**
 * A download that failed (diagnostics, the channel backup): the server's own
 * message when it sent one — what went wrong, in its words — else
 * `fallback`. A 401 signs out, as for every other request. (Review of P7:
 * "Download diagnostics" said only "Diagnostics failed (502).".)
 */
export async function downloadFailed(res: Response, fallback: string): Promise<Error> {
  if (res.status === 401) onUnauthorized?.();
  try {
    const body = (await res.json()) as { message?: unknown } | null;
    if (typeof body?.message === "string" && body.message) return new Error(body.message);
  } catch {
    // binary or empty body — the fallback says what failed
  }
  return new Error(fallback);
}

/** A GET without a query string. */
type NoQuery = Record<string, never>;

/** "?k=v&…" from the fields of a query that are set (each as text: a flag
 *  is "true" or "false"); "" when none is. */
function queryString(query: object | undefined): string {
  const set = Object.entries(query ?? {}).filter(([, v]) => v !== undefined && v !== null);
  return set.length ? `?${new URLSearchParams(set.map(([k, v]) => [k, String(v)]))}` : "";
}

/**
 * GET `path` and read the answer as `T`. `Q` names the query string's
 * contract type (server/src/apiTypes.ts) — the one its route reads the query
 * as (`queryOf<…>(req)`): a parameter goes out only as a field of it, so the
 * compiler holds what is asked here to the contract, and the contract check
 * pairs it with the route. Before, the query strings were written out by hand
 * (`/pnl?days=${days}`), and a parameter renamed on one side passed every
 * check — the page silently got the route's default.
 */
async function get<T, Q extends object = NoQuery>(path: string, query?: Q): Promise<T> {
  return handle<T>(await fetch(`/api${path}${queryString(query)}`, { headers: authHeaders() }));
}

/** The body of a POST that acts without one: an empty JSON object (the
 *  server takes every POST as JSON only). */
type NoBody = Record<string, never>;

/**
 * POST `body` as JSON and read the answer as `T`. `B` names the request's
 * contract type (server/src/apiTypes.ts) — the one its route reads the body
 * as: any body but `{}` must name it, so the compiler holds what is built
 * here to the contract, and the contract check pairs it with the route.
 */
async function post<T, B extends object = NoBody>(path: string, body: B): Promise<T> {
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

/** The viewer's time zone, minutes east of UTC: the server buckets daily
 *  series in the viewer's own days (a UTC day ends at 01:00 or 02:00 in
 *  Europe — "today" was half an hour old at 02:30). */
export const tzOffsetMin = (): number => -new Date().getTimezoneOffset();

export const api = {
  node: () => get<NodeSummary>("/node"),
  dashboard: () => get<DashboardData, TzQuery>("/dashboard", { tz: tzOffsetMin() }),
  channels: () => get<ChannelView[]>("/channels"),
  flows: (days?: number) => get<FlowSummary, DaysQuery>("/flows", { days }),
  pnl: (days: number) => get<PnlSummary, DaysQuery>("/pnl", { days }),
  score: () => get<NodeScore>("/score"),
  getSettings: () => get<AppSettings>("/settings"),
  setSettings: (s: SettingsPatch) => post<AppSettings, SettingsPatch>("/settings", s),
  /** Where the app's own lookups go and by which route (Settings → Privacy). */
  privacy: () => get<PrivacyInfo>("/privacy"),
  lspStatus: () => get<LspStatus>("/lsp/status"),
  lspOrders: () => get<LspOrdersResponse>("/lsp/orders"),
  htlcDemand: (days = 7) => get<UnservedDemandReport, DaysQuery>("/htlc/demand", { days }),
  price: () => get<PriceInfo>("/price"),
  overrides: () => get<OverrideMap>("/overrides"),
  setOverride: (channelId: string, mode: FeeMode, fixedPpm?: number) =>
    post<OverrideMap, OverrideRequest>("/overrides", { channelId, mode, ...(fixedPpm !== undefined ? { fixedPpm } : {}) }),
  alerts: () => get<Alert[]>("/alerts"),
  alertAck: (id: string) => post<AlertAckResult, AlertAckRequest>("/alerts/ack", { id }),
  health: () => get<HealthInfo>("/health"),
  /** A channel inside its lease is refused (409 lease_active) unless
   *  `breakLease` — sent only after the operator confirmed breaking it. */
  channelClose: (transactionId: string, transactionVout: number, isForce: boolean, feeRate?: number, breakLease?: boolean) =>
    post<CloseChannelResult, ChannelCloseRequest>("/channels/close", {
      transactionId,
      transactionVout,
      isForce,
      ...(feeRate !== undefined ? { feeRate } : {}),
      ...(breakLease ? { breakLease } : {}),
    }),
  /** Dial a channel's peer again (the close dialog's first offer for a peer that is away). */
  peerConnect: (pubkey: string, socket?: string) =>
    post<PeerConnectResult, PeerConnectRequest>("/peers/connect", { pubkey, ...(socket ? { socket } : {}) }),
  feeEstimates: () => get<FeeEstimates>("/chain/fee-estimates"),
  forwardsReport: (days: number) => get<ForwardsReport, ForwardsReportQuery>("/forwards/report", { days, tz: tzOffsetMin() }),
  feesPreview: (policy?: FeePreviewQuery) => get<FeePreview, FeePreviewQuery>("/fees/preview", policy),
  feesApply: (items: FeeApplyItem[]) => post<FeeApplyResponse, FeeApplyRequest>("/fees/apply", { items }),
  /** Apply what the engine recommends for these channels (target AND base
   *  fee, recomputed server-side), on the autopilot's books. */
  feesApplyRecommended: (channelIds: string[]) =>
    post<ApplyRecommendedResponse, ApplyRecommendedRequest>("/fees/apply-recommended", { channelIds }),
  feesRecommendations: () => get<FeeRecReport>("/fees/recommendations"),
  autopilotGet: () => get<AutopilotState>("/autopilot"),
  autopilotSet: (patch: AutopilotConfigPatch) => post<AutopilotState, AutopilotConfigPatch>("/autopilot", patch),
  autopilotRun: () => post<AutopilotRunResult>("/autopilot/run", {}),
  /** "Pause all automation": every switch off, what was on kept for Resume. */
  autopilotPause: () => post<AutopilotState>("/autopilot/pause", {}),
  /** Switch back on what was on before the pause — never selling (D9). */
  autopilotResume: () => post<AutopilotResumeResult>("/autopilot/resume", {}),
  /** A refill by hand. It counts toward the daily rebalance budget: its fee
   *  is capped at what is left (and at maxFeeSats, what the confirm dialog
   *  promised); with nothing left — or a payment still in flight through one
   *  of its channels — the server answers 409. */
  rebalanceExecute: (params: RebalanceExecRequest) => post<RebalanceExecResult, RebalanceExecRequest>("/rebalance/execute", params),
  rebalanceLog: () => get<RebalanceLogResponse>("/rebalance/log"),
  /** What rebalancing cost over a window, per refilled channel — every tool's. */
  rebalanceCosts: (days: number) => get<RebalanceCostsResponse, DaysQuery>("/rebalance/costs", { days }),
  /** Inbound bought on Magma against the forwards it brought in. */
  boughtInbound: (days = 30) => get<BoughtInboundResponse, DaysQuery>("/analytics/bought-inbound", { days }),
  rebalanceRecommendations: () => get<RebalanceRecReport>("/rebalance/recommendations"),
  suggestions: (policy?: SuggestionsQuery) => get<SuggestionsResponse, SuggestionsQuery>("/suggestions", policy),
  // No window: the route reads none (it was offered a `days` it never read).
  closeCandidates: () => get<CloseCandidatesResponse>("/suggestions/close"),

  // ── lightningnetwork.plus (read-only, no key) ──
  lnplusStatus: () => get<LnPlusStatus>("/lnplus/status"),
  lnplusPool: (minCreditsSats?: number) => get<LnPlusPoolResponse, LnPlusPoolQuery>("/lnplus/pool", { minCredits: minCreditsSats }),
  lnplusSwaps: (status?: LnPlusSwapsQuery["status"]) => get<LnPlusSwapsResponse, LnPlusSwapsQuery>("/lnplus/swaps", { status }),
  /** Put a peer on (or take it off) the channel autopilot's "never open automatically" list. */
  neverOpen: (pubkey: string, never: boolean, alias?: string) =>
    post<NeverOpenResult, NeverOpenRequest>("/channels/never-open", { pubkey, never, ...(alias ? { alias } : {}) }),
  /** What opening a channel of this size would cost and leave, before the click. */
  openEstimate: (sizeSats: number) => get<OpenEstimate, SizeQuery>("/channels/open-estimate", { size: Math.round(sizeSats) }),
  /** A 409 "capital_promised" refusal (coins promised to buyers) is thrown
   *  as an ApiError; send again with `spendPromised: true` only after the
   *  operator confirmed spending them (see statusNotes promisedSpend). */
  channelOpen: (params: ChannelOpenRequest) => post<OpenChannelResult, ChannelOpenRequest>("/channels/open", params),
  lnActivity: () => get<LnActivity>("/ln/activity"),
  lnDecode: (request: string) => post<DecodedRequest, LnDecodeRequest>("/ln/decode", { request }),
  lnInvoice: (params: LnInvoiceRequest) => post<CreatedInvoice, LnInvoiceRequest>("/ln/invoice", params),
  lnPay: (params: LnPayRequest) => post<PayResult, LnPayRequest>("/ln/pay", params),
  onchainState: () => get<OnchainState>("/onchain"),
  onchainTxs: () => get<OnchainTx[]>("/onchain/txs"),
  onchainAddress: () => post<NewAddress>("/onchain/address", {}),
  onchainPreview: (q: SendPreviewQuery) => get<SendPreview, SendPreviewQuery>("/onchain/send-preview", q),
  onchainSend: (params: OnchainSendRequest) => post<OnchainSendResult, OnchainSendRequest>("/onchain/send", params),
  authStatus: () => get<AuthStatus>("/auth/status"),
  login: async (password: string): Promise<boolean> => {
    const res = await fetch("/api/auth/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password } satisfies AuthUnlockRequest),
    });
    if (!res.ok) return false;
    const { token: t } = (await res.json()) as AuthUnlockResult;
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
  ambossConnect: (apiKey: string) => post<AmbossKeyResult, AmbossKeyRequest>("/amboss/key", { apiKey }),
  ambossDisconnect: () => del<AmbossKeyResult>("/amboss/key"),
  // Without offerId Amboss picks the seller; with it, the user's pick decides.
  ambossBuyQuote: (usdCents: number, isPrivate: boolean, target?: Required<Pick<BuyQuoteRequest, "offerId" | "sizeSats">>) =>
    post<BuyQuoteResponse, BuyQuoteRequest>("/amboss/buy/quote", {
      usdCents,
      private: isPrivate,
      ...(target ?? {}),
    }),
  /** Pays only the invoice recorded with the quote, for the confirmed amount. */
  ambossBuyPay: (orderId: string, maxSats: number) =>
    post<BuyPayResult, BuyPayRequest>("/amboss/buy/pay", { orderId, maxSats }),
  /** The buyer declined the quote: cancel the order on Amboss. */
  ambossBuyCancel: (orderId: string) =>
    post<BuyCancelResult, BuyCancelRequest>("/amboss/buy/cancel", { orderId }),
  /** The book ranked for this node at `sizeSats` (lease, conditions, Amboss fee, caps). */
  ambossBuyOffers: (sizeSats: number) => get<BuyOffersResponse, SizeQuery>("/amboss/buy-offers", { size: Math.round(sizeSats) }),
  /** Inbound bought here: quotes, cancels, payments, channels. */
  ambossPurchases: () => get<PurchasesResponse>("/amboss/purchases"),
  /** Can this node realistically sell on Magma? (live, indicative) */
  magmaEligibility: (refresh = false) => get<Eligibility, EligibilityQuery>("/amboss/eligibility", refresh ? { refresh } : {}),
  /** "Why don't I sell?" — the checklist from the live state. */
  sellDiagnostics: () => get<SellDiagnostics>("/amboss/sell-diagnostics"),
  /** Hand an offer to the autopilot (true) or take it over (false). */
  ambossOfferAutomation: (id: string, managed: boolean) =>
    post<OfferAutomationResult, OfferAutomationRequest>("/amboss/offer/automation", { id, managed }),
  ambossOrder: (id: string) => get<OrderState, OrderQuery>("/amboss/order", { id }),
  signMessage: (message: string) => post<SignResult, SignRequest>("/sign", { message }),
  ambossMyOffers: () => get<MyOffersResponse>("/amboss/my-offers"),
  ambossOfferSync: () => get<OfferSyncStatus>("/amboss/offer-sync"),
  ambossMyOrders: () => get<MyOrdersView>("/amboss/my-orders"),
  magmaRecommendations: () => get<MagmaV2Report>("/amboss/recommendations"),
  autopilotOutcomes: () => get<OutcomesReport>("/autopilot/outcomes"),
  ambossCreateOffer: (p: OfferTermsRequest) => post<OfferCreateResult, OfferTermsRequest>("/amboss/offer", p),
  ambossUpdateOffer: (id: string, p: OfferTermsRequest) =>
    post<OfferUpdateResult, OfferUpdateRequest>("/amboss/offer/update", { id, ...p }),
  /** Flip an offer — or, with `want`, put it in that state (read first,
   *  flipped only if needed; an answer that isn't `want` throws). */
  ambossToggleOffer: (id: string, want?: OfferToggleRequest["want"]) =>
    post<OfferToggleResult, OfferToggleRequest>("/amboss/offer/toggle", want ? { id, want } : { id }),
  // Manual order actions go through the same order journal as the autopilot;
  // a failure answers with an error status (thrown here), never 200 + ok:false.
  ambossAcceptOrder: (id: string) => post<DeskResult, OrderActionRequest>("/amboss/order/accept", { id }),
  ambossOpenOrder: (id: string) => post<DeskResult, OrderActionRequest>("/amboss/order/open", { id }),
  ambossRejectOrder: (id: string) => post<DeskResult, OrderActionRequest>("/amboss/order/reject", { id }),
  backupStatus: () => get<BackupStatus>("/backup/status"),
  /** "Download diagnostics": the server's JSON report, saved as a file. */
  diagnosticsDownload: async (): Promise<void> => {
    const res = await fetch("/api/diagnostics", { headers: authHeaders() });
    if (!res.ok) throw await downloadFailed(res, `Diagnostics failed (${res.status}).`);
    const blob = await res.blob();
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "lightningmate-diagnostics.json";
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
  // Download the channel backup with the auth header, then trigger a browser
  // download of a `channel.backup` file from the response blob.
  backupExport: async (): Promise<void> => {
    // JSON, like every POST of this client: the server refuses a POST of any
    // other type (a cross-site form's), and this one has no body of its own.
    const res = await fetch("/api/backup/export", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: "{}",
    });
    if (!res.ok) throw await downloadFailed(res, `Export failed (${res.status}).`);
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
