import { getFeeRates, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { getNetworkRank, type NetworkRank } from "./suggestions.js";

export interface ScoreComponent {
  key: string;
  label: string;
  /** 0..1 */
  score: number;
  weight: number;
  detail: string;
}

export interface NodeScore {
  score: number; // 0..100
  grade: string; // A–F
  components: ScoreComponent[];
  rank: NetworkRank | null;
}

function grade(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Overall node health (0–100, graded A–F). Combines liquidity balance, share of
 * active channels, routing activity, fee sanity, and network connectivity — all
 * from data we already pull, so it's a one-glance "how am I doing".
 */
export async function getNodeScore(lnd: AuthenticatedLnd): Promise<NodeScore> {
  const [channels, rates, flows, ownKey] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
    getFlowSummary(lnd, 30),
    getOwnPubkey(lnd),
  ]);
  const rank = await getNetworkRank(lnd, ownKey).catch(() => null);

  const active = channels.filter((c) => c.active);

  // 1. Liquidity balance — channels near 50/50 are healthiest.
  const balance = active.length
    ? 1 - active.reduce((s, c) => s + Math.abs(c.localRatio - 0.5) * 2, 0) / active.length
    : 0;

  // 2. Active channel share.
  const activeShare = channels.length ? active.length / channels.length : 0;

  // 3. Routing activity — soft-capped at ~60 forwards / 30d.
  const activity = clamp01(flows.totalForwards / 60);

  // 4. Fee sanity — share of channels with a sensible outbound fee (1–2500 ppm).
  const feeById = new Map(rates.channels.map((c) => [c.id, c.fee_rate]));
  const sane = active.filter((c) => {
    const ppm = feeById.get(c.id) ?? 0;
    return ppm >= 1 && ppm <= 2500;
  }).length;
  const feeHealth = active.length ? sane / active.length : 0;

  // 5. Connectivity — our network percentile.
  const connectivity = rank ? clamp01(rank.percentile) : 0;

  const components: ScoreComponent[] = [
    {
      key: "balance",
      label: "Liquidity balance",
      score: clamp01(balance),
      weight: 0.25,
      detail: `${Math.round(clamp01(balance) * 100)}% balanced across ${active.length} channels`,
    },
    {
      key: "active",
      label: "Active channels",
      score: clamp01(activeShare),
      weight: 0.15,
      detail: `${active.length}/${channels.length} channels active`,
    },
    {
      key: "activity",
      label: "Routing activity",
      score: activity,
      weight: 0.25,
      detail: `${flows.totalForwards} forwards in 30d`,
    },
    {
      key: "fees",
      label: "Fee health",
      score: clamp01(feeHealth),
      weight: 0.15,
      detail: `${sane}/${active.length} channels with sane fees`,
    },
    {
      key: "connectivity",
      label: "Connectivity",
      score: connectivity,
      weight: 0.2,
      detail: rank ? `top ${Math.max(1, Math.round((1 - rank.percentile) * 100))}% by channels` : "not in graph",
    },
  ];

  const score = Math.round(components.reduce((s, c) => s + c.score * c.weight, 0) * 100);
  return { score, grade: grade(score), components, rank };
}
