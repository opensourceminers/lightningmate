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
  PnlSummary,
  RebalanceAnalysis,
  RebalanceExecResult,
  RebalanceLogResponse,
  RebalancePolicy,
  SuggestionPolicy,
  SuggestionsResponse,
} from "./types";

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
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
  return handle<T>(await fetch(`/api${path}`));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(
    await fetch(`/api${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
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
};
