import { getChainBalance, getChannelBalance, getFeeRates, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { getChannelsView, type ChannelView } from "./channels.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";
import { getNetworkRank, type NetworkRank } from "./suggestions.js";
import { fundingHeight } from "./leaseCaps.js";
import { chainCostsSince, readChainFacts } from "./pnl.js";
import { rebalanceCosts } from "./rebalanceCosts.js";
import type { RebalanceLog } from "./rebalanceLog.js";
import type { MagmaPurchases } from "./magmaPurchases.js";
import { amortizedPurchaseCost, spreadOverLeases } from "./inboundRoi.js";
import type { CloseTxArchive } from "./closeTxArchive.js";
import { saleKind, type EarningsLog } from "./earningsLog.js";
import type { ServiceFeeLedger } from "./serviceFee.js";
import type { SoldLease } from "./leaseCaps.js";

export interface ScoreCategory {
  key: string;
  label: string;
  /** 0..1 — null: not enough data to judge (left out of the overall score). */
  score: number | null;
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
  /** Why the grade is provisional (a category left out for lack of data),
   *  or null. */
  provisional: string | null;
}

function grade(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Earnings are not judged before the node has routed this long … */
export const MIN_HISTORY_DAYS = 14;
/** … and its net yield not on fewer forwards than this in 30 days (a
 *  handful of forwards is noise, not a yield). */
export const MIN_YIELD_FORWARDS = 10;
const DAY_MS = 86_400_000;

/** Everything the score is computed from — no I/O (computeNodeScore). */
export interface ScoreInput {
  /** Every channel, those still opening or closing included. */
  channels: Pick<ChannelView, "id" | "peerPubkey" | "peerAlias" | "active" | "capacity" | "status">[];
  feePpmById: ReadonlyMap<string, number>;
  forwards30: number;
  routingRevenue30Sats: number;
  onchainSats: number;
  /** LND's channel balance (outbound) and inbound — what the header shows. */
  outboundSats: number;
  inboundSats: number;
  rank: NetworkRank | null;
  /** Costs, for the net yield: rebalancing over the last 30 days; on-chain
   *  opens and closes over the last 365 days (spread over 12 months); inbound
   *  bought on Magma, spread over each lease (its part in the last 30 days).
   *  null: unknown — the yield is then gross, and the detail says so. */
  rebalance30Sats: number | null;
  chainCostsYearSats: number | null;
  purchases30Sats: number;
  /** Lease income from sales (Magma and LSPS1), after the service fee paid
   *  on each, spread over each lease (its part in the last 30 days) — income,
   *  as in P&L: the opens of the channels sold are among the costs above. */
  leaseIncome30Sats: number;
  /** Days since the oldest open channel was funded (null: unknown — no open
   *  channel, or LND's chain height unreadable: Earnings not judged). */
  historyDays: number | null;
}

/**
 * What to do about a net yield below zero — about the cost that weighs most.
 * Review of P6: the hint always ended "rebalance less", also for a node that
 * spent nothing on rebalancing and was below zero only for its channel opens
 * (a young routing node, a seller). Null: no cost to point at.
 */
function costsOutrunHint(c: { routing: number; lease: number; rebalance: number; chainMonth: number; bought: number }): string | null {
  const costs = [
    { what: "rebalance", sats: c.rebalance, text: `${Math.round(c.rebalance)} sat rebalancing` },
    { what: "chain", sats: c.chainMonth, text: `~${Math.round(c.chainMonth)} sat/month of on-chain opens and closes` },
    { what: "bought", sats: c.bought, text: `~${Math.round(c.bought)} sat of bought inbound` },
  ].filter((x) => x.sats > 0);
  if (costs.length === 0) return null;
  const top = costs.reduce((a, b) => (b.sats > a.sats ? b : a));
  const texts = costs.map((x) => x.text);
  const spent = texts.length > 1 ? `${texts.slice(0, -1).join(", ")} and ${texts[texts.length - 1]}` : texts[0];
  const earned = c.lease > 0 ? `${c.routing} sat of routing fees and ~${Math.round(c.lease)} sat of lease income` : `${c.routing} sat earned`;
  const advice =
    top.what === "rebalance"
      ? "rebalance less, and only where it pays back."
      : top.what === "chain"
        ? "opens and closes count here spread over a year and pay back only as those channels route: give new channels time to earn, and open or close only where it pays."
        : "inbound bought on Magma weighs most: buy more only where it brings in more fees than it costs (Analytics › Bought inbound).";
  return `Costs outrun ${c.lease > 0 ? "income" : "routing income"}: ${spent} against ${earned} in 30 days — ${advice}`;
}

/**
 * Overall node health (0–100, graded A–F), grouped into plain-language
 * categories — Liquidity, Connectivity, Scale, Earnings, Hygiene, Reserve —
 * each built from data we already pull. Beyond the basics it rewards two-sided
 * (routable) liquidity and penalises peer concentration (capital stuck with a
 * single peer) and dead capacity in offline channels.
 *
 * Review a5-analytics:health-score-pending-gross: channels still opening or
 * closing are not dead capacity — a fresh Magma sale, or a force close in its
 * timelock for two weeks, lowered Connectivity, Hygiene and Earnings. They
 * are left out of every share and denominator now, and named in the detail
 * lines instead. And Earnings looked at gross activity only: a node spending
 * more on rebalancing and opens than it earned could get full marks. Its
 * yield is now NET: routing fees + lease income (spread over each lease) −
 * rebalancing − on-chain opens and closes (spread over a year) − inbound
 * bought (spread over its lease). Lease income counts as in P&L (review of
 * P6): the opens of the channels a node sold were among its costs, and
 * without what the sales earned a seller in profit read a negative yield. A
 * node with less than MIN_HISTORY_DAYS of history gets no Earnings grade at
 * all — the overall grade is then provisional, and says why.
 */
export function computeNodeScore(input: ScoreInput): NodeScore {
  const open = input.channels.filter((c) => c.status === "open");
  const opening = input.channels.filter((c) => c.status === "pending_open").length;
  const closing = input.channels.filter((c) => c.status === "pending_close").length;
  const active = open.filter((c) => c.active);
  const openCapacity = open.reduce((s, c) => s + c.capacity, 0);
  const activeCapacity = active.reduce((s, c) => s + c.capacity, 0);
  const pendingText = [opening ? `${opening} opening` : "", closing ? `${closing} closing` : ""].filter(Boolean).join(" · ");
  const withPending = (detail: string) => (pendingText ? `${detail} · ${pendingText} (not counted)` : detail);

  // ── Liquidity ── a routing node is healthy when it has BOTH outbound and
  // inbound liquidity available ACROSS THE NODE — not when every channel is
  // individually balanced. Dedicated source (outbound) and sink (inbound)
  // channels are normal and fine; what matters is the node can route both ways.
  // Use LND's channel-balance (outbound) + inbound — the SAME numbers the Overview
  // header shows — so the tile and the header always agree.
  const sideTotal = input.outboundSats + input.inboundSats;
  const outShare = sideTotal > 0 ? input.outboundSats / sideTotal : 0;
  const inShare = sideTotal > 0 ? input.inboundSats / sideTotal : 0;
  // 50/50 across the node = best routing flexibility; heavily one-sided = limited.
  const liquidity = clamp01(2 * Math.min(outShare, inShare));

  // ── Connectivity ── online + peer diversity (HHI) + network rank — over
  // the open channels only.
  const onlineShare = open.length ? active.length / open.length : 0;
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
  const rankPct = input.rank ? clamp01(input.rank.percentile) : 0;
  const connectivity = clamp01(0.4 * onlineShare + 0.35 * diversity + 0.25 * rankPct);
  const topPeerAlias = active.find((c) => c.peerPubkey === topPeer)?.peerAlias || "one peer";

  // ── Scale ── channel count + capacity of the open channels (log curve:
  // ~1M→0, ~50M→1).
  const countScore = clamp01(active.length / 8);
  const capScore = clamp01(Math.log10(openCapacity / 1_000_000 + 1) / Math.log10(51));
  const scale = clamp01(0.5 * countScore + 0.5 * capScore);
  const btc = (openCapacity / 100_000_000).toFixed(2);

  // ── Earnings ── routing activity + NET yield (ppm/month of the open
  // capacity, after what the node spends to earn it).
  const costsKnown = input.rebalance30Sats !== null && input.chainCostsYearSats !== null;
  const rebal = input.rebalance30Sats ?? 0;
  const chainMonth = (input.chainCostsYearSats ?? 0) / 12;
  const lease = input.leaseIncome30Sats;
  const net30 = input.routingRevenue30Sats + lease - rebal - chainMonth - input.purchases30Sats;
  const monthlyPpm = openCapacity > 0 ? (net30 / openCapacity) * 1_000_000 : 0;
  const activity = clamp01(input.forwards30 / 60);
  // Lease income is no handful of forwards: with it, the yield is read
  // whatever the forward count.
  const yieldJudged = input.forwards30 >= MIN_YIELD_FORWARDS || lease > 0;
  const yieldScore = yieldJudged ? clamp01(monthlyPpm / 500) : 0;
  const tooEarly = input.historyDays === null || input.historyDays < MIN_HISTORY_DAYS;
  const earnings = tooEarly ? null : clamp01(0.5 * activity + 0.5 * yieldScore);
  // Unknown history is never judged: no open channel yet — or LND didn't
  // say how far the chain is (its height), so the age can't be told.
  const historyText =
    input.historyDays !== null ? `${Math.floor(input.historyDays)} days of history` : open.length === 0 ? "no open channel yet" : "its history can't be read";
  const basis = `${costsKnown ? "net of costs" : "gross (costs unknown)"}${lease > 0 ? ", lease income included" : ""}`;
  const earningsDetail = tooEarly
    ? `insufficient data — ${historyText} (needs ${MIN_HISTORY_DAYS})`
    : !yieldJudged
      ? `${input.forwards30} forwards in 30 d — too few to judge a yield (needs ${MIN_YIELD_FORWARDS})`
      : `${input.forwards30} forwards · ~${Math.round(monthlyPpm)} ppm/mo ${basis}`;
  const earningsHint =
    (yieldJudged && net30 < 0
      ? costsOutrunHint({
          routing: input.routingRevenue30Sats,
          lease,
          rebalance: rebal,
          chainMonth,
          bought: input.purchases30Sats,
        })
      : null) ?? "Lower fees on idle channels or add inbound so they start routing.";

  // ── Hygiene ── sane outbound fees + open capacity that's actually online.
  const sane = active.filter((c) => {
    const ppm = input.feePpmById.get(c.id) ?? 0;
    return ppm >= 1 && ppm <= 2500;
  }).length;
  const feeHealth = active.length ? sane / active.length : 0;
  const activeCapRatio = openCapacity > 0 ? activeCapacity / openCapacity : 0;
  const hygiene = clamp01(0.6 * feeHealth + 0.4 * activeCapRatio);

  // ── Reserve ── on-chain sats to fee-bump force-closes and fund new channels.
  const onchain = input.onchainSats;
  const reserveTarget = Math.max(250_000, active.length * 50_000);
  const reserveScore = clamp01(onchain / reserveTarget);
  const onchainStr =
    onchain >= 1_000_000 ? `${(onchain / 1_000_000).toFixed(1)}M` : `${Math.round(onchain / 1000)}k`;

  const rank = input.rank;
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
      detail: withPending(
        rank
          ? `top ${Math.max(1, Math.round((1 - rank.percentile) * 100))}% · ${effectivePeers.toFixed(1)} effective peers`
          : `${effectivePeers.toFixed(1)} effective peers`,
      ),
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
      detail: earningsDetail,
      hint: earningsHint,
    },
    {
      key: "hygiene",
      label: "Hygiene",
      score: hygiene,
      weight: 0.13,
      detail: withPending(`${sane}/${active.length} sane fees · ${Math.round(activeCapRatio * 100)}% capacity online`),
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

  // A category without data is left out: the rest carry the score.
  const judged = categories.filter((c) => c.score !== null);
  const weightSum = judged.reduce((s, c) => s + c.weight, 0);
  const score = weightSum > 0 ? Math.round((judged.reduce((s, c) => s + (c.score as number) * c.weight, 0) / weightSum) * 100) : 0;
  const provisional = tooEarly ? `Earnings not graded yet — ${historyText}` : null;
  return { score, grade: grade(score), categories, rank, provisional };
}

/** What the score reads beyond LND (the API passes it). */
export interface ScoreSources {
  rebalanceLog?: RebalanceLog;
  purchases?: Pick<MagmaPurchases, "paidCosts">;
  /** Completed sales (Magma and LSPS1): lease income … */
  earnings?: Pick<EarningsLog, "recent">;
  /** … after the service fee paid on each, as P&L counts both … */
  serviceFees?: Pick<ServiceFeeLedger, "entries">;
  /** … spread over its lease: the sold channels' leases, for a sale
   *  recorded before sales carried their own. */
  soldLeases?: () => readonly SoldLease[];
  /** LightningMate's copy of the close transactions LND's wallet forgets. */
  closeTxs?: Pick<CloseTxArchive, "update">;
}

/** Inbound bought on Magma, spread over each lease: its part of the last
 *  30 days (sat). */
export function purchasesInLast30(purchases: Pick<MagmaPurchases, "paidCosts"> | undefined, nowMs: number): number {
  return amortizedPurchaseCost(purchases?.paidCosts() ?? [], 30, nowMs);
}

/**
 * Lease income from sales (Magma and LSPS1), each after the service fee paid
 * on it (P&L counts that fee as a cost) and spread over the lease it was paid
 * for, like inbound bought: its part of the last 30 days (sat). The lease is
 * the sale's own, else the one the sold channel's order holds, else the
 * shortest standard lease (4,320 blocks).
 */
export function leaseIncomeInLast30(src: Pick<ScoreSources, "earnings" | "serviceFees" | "soldLeases">, nowMs: number): number {
  const sales = src.earnings?.recent() ?? [];
  if (sales.length === 0) return 0;
  const feePaid = new Map<string, number>();
  for (const e of src.serviceFees?.entries() ?? []) {
    if (e.state === "paid") feePaid.set(e.key, (e.paidSats ?? 0) + (e.routingFeeSats ?? 0));
  }
  const leaseOf = new Map<string, number>();
  for (const l of src.soldLeases?.() ?? []) if (l.leaseBlocks > 0) leaseOf.set(`${l.source}:${l.orderId}`, l.leaseBlocks);
  return spreadOverLeases(
    sales.map((s) => {
      // The fee ledger's key, and the lease registry's: one per sale.
      const key = `${saleKind(s.via)}:${s.orderId}`;
      return {
        at: s.at,
        sats: (s.leaseSats ?? 0) - (s.feePaidSats ?? 0) - (feePaid.get(key) ?? 0),
        leaseBlocks: s.leaseBlocks ?? leaseOf.get(key) ?? null,
      };
    }),
    30,
    nowMs,
  );
}

// The score barely changes minute-to-minute and the network-rank lookup is heavy
// (pulls the graph), so cache the whole result briefly — the tile then loads
// instantly on auto-refresh; only the first request per window recomputes.
// One per LND connection.
const scoreCache = new WeakMap<AuthenticatedLnd, { at: number; value: NodeScore }>();
const SCORE_TTL_MS = 5 * 60_000;

export async function getNodeScore(lnd: AuthenticatedLnd, src: ScoreSources = {}): Promise<NodeScore> {
  const cached = scoreCache.get(lnd);
  if (cached && Date.now() - cached.at < SCORE_TTL_MS) return cached.value;
  const nowMs = Date.now();
  const [channels, rates, flows, chain, ownKey, chanBal, height] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
    getFlowSummary(lnd, 30),
    getChainBalance({ lnd }).catch(() => ({ chain_balance: 0 })),
    getOwnPubkey(lnd),
    getChannelBalance({ lnd }).catch(() => ({ channel_balance: 0, inbound: 0 })),
    getWalletInfo({ lnd })
      .then((w) => w.current_block_height)
      .catch(() => null),
  ]);
  const [rank, rebal, chainYear] = await Promise.all([
    getNetworkRank(lnd, ownKey).catch(() => null),
    src.rebalanceLog ? rebalanceCosts(lnd, src.rebalanceLog, nowMs - 30 * DAY_MS, nowMs).then((r) => r.feeSats) : Promise.resolve(null),
    readChainFacts(lnd, nowMs, src.closeTxs)
      .then((f) => {
        const c = chainCostsSince(f, nowMs - 365 * DAY_MS);
        return c.openCostSats + c.closeCostSats;
      })
      .catch(() => null),
  ]);
  // The node's routing history: since its oldest open channel was funded.
  let oldest: number | null = null;
  for (const c of channels) {
    const h = c.status === "open" ? fundingHeight(c.id) : null;
    if (h !== null && (oldest === null || h < oldest)) oldest = h;
  }
  const historyDays = oldest !== null && height !== null && height >= oldest ? (height - oldest) / 144 : null;

  const value = computeNodeScore({
    channels,
    feePpmById: new Map(rates.channels.map((c) => [c.id, c.fee_rate])),
    forwards30: flows.totalForwards,
    routingRevenue30Sats: flows.totalFeesEarnedSats,
    onchainSats: chain.chain_balance ?? 0,
    outboundSats: chanBal.channel_balance ?? 0,
    inboundSats: chanBal.inbound ?? 0,
    rank,
    rebalance30Sats: rebal,
    chainCostsYearSats: chainYear,
    purchases30Sats: purchasesInLast30(src.purchases, nowMs),
    leaseIncome30Sats: leaseIncomeInLast30(src, nowMs),
    historyDays,
  });
  scoreCache.set(lnd, { at: Date.now(), value });
  return value;
}
