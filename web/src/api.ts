import type {
  AutopilotConfig,
  AutopilotRun,
  AutopilotState,
  ChannelView,
  FeeApplyItem,
  FeeApplyResult,
  FeePolicy,
  FeePreview,
  FlowSummary,
  NodeSummary,
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
  channels: () => get<ChannelView[]>("/channels"),
  flows: (days?: number) => get<FlowSummary>(days ? `/flows?days=${days}` : "/flows"),
  pnl: (days: number) => get<PnlSummary>(`/pnl?days=${days}`),
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
};
