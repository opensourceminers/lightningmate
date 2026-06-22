import type { ChannelView, FlowSummary, NodeSummary } from "./types";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
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

export const api = {
  node: () => get<NodeSummary>("/node"),
  channels: () => get<ChannelView[]>("/channels"),
  flows: (days?: number) => get<FlowSummary>(days ? `/flows?days=${days}` : "/flows"),
};
