import { getChainBalance, getChannelBalance, getFeeRates, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { getNetworkRank, type NetworkRank } from "./suggestions.js";

export interface ScoreCategory {
  key: string;
  label: string;
  /** 0..1 */
  score: number;
  /** contribution to the overall score (weights sum to 1) */
  weight: number;
  /** one-line summary of where this category stands */
  detail: string;
  /** actionable way to improve this category (used for the "biggest win") */
  hint: string;
}

export interface NodeScore {
  score: number; // 0..100
  grade: string; // A–F
  categories: ScoreCategory[];
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
 * Overall node health (0–100, graded A–F), grouped into five plain-language
 * categories — Liquidity, Connectivity, Scale, Earnings and Hygiene — each built
 * from data we already pull. Beyond the basics it rewards two-sided (routable)
 * liquidity and penalises peer concentration (capital stuck with a single peer)
 * and dead capacity in offline channels, so the score reflects real resilience.
 */
// The score barely changes minute-to-minute and the network-rank lookup is heavy
// (pulls the graph), so cache the whole result briefly — the tile then loads
// instantly on auto-refresh; only the first request per window recomputes.
let scoreCache: { at: number; value: NodeScore } | null = null;
const SCORE_TTL_MS = 5 * 60_000;

export async function getNodeScore(lnd: AuthenticatedLnd): Promise<NodeScore> {
  if (scoreCache && Date.now() - scoreCache.at < SCORE_TTL_MS) return scoreCache.value;
  const [channels, rates, flows, chain, ownKey, chanBal] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
    getFlowSummary(lnd, 30),
    getChainBalance({ lnd }).catch(() => ({ chain_balance: 0 })),
    getOwnPubkey(lnd),
    getChannelBalance({ lnd }).catch(() => ({ channel_balance: 0, inbound: 0 })),
  ]);
  const rank = await getNetworkRank(lnd, ownKey).catch(() => null);

  const active = channels.filter((c) => c.active);
  const totalCapacity = channels.reduce((s, c) => s + c.capacity, 0);
  const activeCapacity = active.reduce((s, c) => s + c.capacity, 0);

  // ── Liquidity ── a routing node is healthy when it has BOTH outbound and
  // inbound liquidity available ACROSS THE NODE — not when every channel is
  // individually balanced. Dedicated source (outbound) and sink (inbound)
  // channels are normal and fine; what matters is the node can route both ways.
  // Use LND's channel-balance (outbound) + inbound — the SAME numbers the Overview
  // header shows — so the tile and the header always agree.
  const outboundSats = chanBal.channel_balance ?? 0;
  const inboundSats = chanBal.inbound ?? 0;
  const sideTotal = outboundSats + inboundSats;
  const outShare = sideTotal > 0 ? outboundSats / sideTotal : 0;
  const inShare = sideTotal > 0 ? inboundSats / sideTotal : 0;
  // 50/50 across the node = best routing flexibility; heavily one-sided = limited.
  const liquidity = clamp01(2 * Math.min(outShare, inShare));

  // ── Connectivity ── online + peer diversity (HHI) + network rank.
  const onlineShare = channels.length ? active.length / channels.length : 0;
  const byPeer = new Map<string, number>();
  for (const c of active) byPeer.set(c.peerPubkey, (byPeer.get(c.peerPubkey) ?? 0) + c.capacity);
  let maxShare = 0;
  let topPeer = "";
  const hhi =
    activeCapacity > 0
      ? [...byPeer.entries()].reduce((s, [k, v]) => {
          const share = v / activeCapacity;
          if (share > maxShare) {
            maxShare = share;
            topPeer = k;
          }
          return s + share * share;
        }, 0)
      : 1;
  const effectivePeers = hhi > 0 ? 1 / hhi : 0; // ~number of "equal" peers
  const diversity = clamp01((effectivePeers - 1) / 7); // 8 even peers → full marks
  const rankPct = rank ? clamp01(rank.percentile) : 0;
  const connectivity = clamp01(0.4 * onlineShare + 0.35 * diversity + 0.25 * rankPct);
  const topPeerAlias = active.find((c) => c.peerPubkey === topPeer)?.peerAlias || "one peer";

  // ── Scale ── channel count + total capacity (log curve: ~1M→0, ~50M→1).
  const countScore = clamp01(active.length / 8);
  const capScore = clamp01(Math.log10(totalCapacity / 1_000_000 + 1) / Math.log10(51));
  const scale = clamp01(0.5 * countScore + 0.5 * capScore);
  const btc = (totalCapacity / 100_000_000).toFixed(2);

  // ── Earnings ── routing activity + yield (fees earned vs capacity, ppm/month).
  const activity = clamp01(flows.totalForwards / 60);
  const monthlyPpm =
    totalCapacity > 0 ? (flows.totalFeesEarnedSats / totalCapacity) * 1_000_000 : 0;
  const yieldScore = clamp01(monthlyPpm / 500);
  const earnings = clamp01(0.5 * activity + 0.5 * yieldScore);

  // ── Hygiene ── sane outbound fees + capacity that's actually online.
  const feeById = new Map(rates.channels.map((c) => [c.id, c.fee_rate]));
  const sane = active.filter((c) => {
    const ppm = feeById.get(c.id) ?? 0;
    return ppm >= 1 && ppm <= 2500;
  }).length;
  const feeHealth = active.length ? sane / active.length : 0;
  const activeCapRatio = totalCapacity > 0 ? activeCapacity / totalCapacity : 0;
  const hygiene = clamp01(0.6 * feeHealth + 0.4 * activeCapRatio);

  // ── Reserve ── on-chain sats to fee-bump force-closes and fund new channels.
  const onchain = chain.chain_balance ?? 0;
  const reserveTarget = Math.max(250_000, active.length * 50_000);
  const reserveScore = clamp01(onchain / reserveTarget);
  const onchainStr =
    onchain >= 1_000_000 ? `${(onchain / 1_000_000).toFixed(1)}M` : `${Math.round(onchain / 1000)}k`;

  const categories: ScoreCategory[] = [
    {
      key: "liquidity",
      label: "Liquidity",
      score: liquidity,
      weight: 0.2,
      detail: `${Math.round(outShare * 100)}% outbound · ${Math.round(inShare * 100)}% inbound`,
      hint:
        outShare < 0.2
          ? "Low outbound — you can receive but barely forward out. Refill outbound (rebalance or open a channel)."
          : inShare < 0.2
            ? "Low inbound — you can forward out but barely receive. Get inbound (sell on Magma, spend, or loop out)."
            : "Healthy two-sided liquidity — the node can route in both directions.",
    },
    {
      key: "connectivity",
      label: "Connectivity",
      score: connectivity,
      weight: 0.2,
      detail: rank
        ? `top ${Math.max(1, Math.round((1 - rank.percentile) * 100))}% · ${effectivePeers.toFixed(1)} effective peers`
        : `${effectivePeers.toFixed(1)} effective peers`,
      hint: `Spread capacity across more peers — ${Math.round(maxShare * 100)}% sits with ${topPeerAlias}.`,
    },
    {
      key: "scale",
      label: "Scale",
      score: scale,
      weight: 0.15,
      detail: `${active.length} channel${active.length === 1 ? "" : "s"} · ${btc} BTC`,
      hint: `Open a few more well-connected channels (target 8+) to grow reach.`,
    },
    {
      key: "earnings",
      label: "Earnings",
      score: earnings,
      weight: 0.2,
      detail: `${flows.totalForwards} forwards · ~${Math.round(monthlyPpm)} ppm/mo`,
      hint: `Lower fees on idle channels or add inbound so they start routing.`,
    },
    {
      key: "hygiene",
      label: "Hygiene",
      score: hygiene,
      weight: 0.13,
      detail: `${sane}/${active.length} sane fees · ${Math.round(activeCapRatio * 100)}% capacity online`,
      hint: `Set sensible outbound fees on the rest and clear out dead channels.`,
    },
    {
      key: "reserve",
      label: "Reserve",
      score: reserveScore,
      weight: 0.12,
      detail: `${onchainStr} sat on-chain`,
      hint: `Keep on-chain sats to fee-bump force-closes and fund new channels.`,
    },
  ];

  const score = Math.round(categories.reduce((s, c) => s + c.score * c.weight, 0) * 100);

  const value: NodeScore = { score, grade: grade(score), categories, rank };
  scoreCache = { at: Date.now(), value };
  return value;
}
