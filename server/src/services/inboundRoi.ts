import type { ForwardEvent } from "./forwards.js";
import type { MagmaPurchase } from "./magmaPurchases.js";

/**
 * What inbound bought on Magma brought in — review a5-analytics:inbound-
 * channels-invisible and magma-buy-costs-missing.
 *
 * A bought channel earns nothing itself: payments come IN through it, and
 * the fee is earned on the channel they leave by. Credited by outgoing fees
 * only, every bought channel looked worthless, and nothing set what it cost
 * against what it made possible. Here each purchase whose channel opened is
 * set against the fees of the forwards that entered through that channel
 * while its lease ran — a simple return on what was paid (invoice + routing
 * fee). An upper bound on what the purchase added: some of those payments
 * might have found another way in.
 */
export interface BoughtInboundRoi {
  orderId: string;
  /** The bought channel (null: not found among this node's channels). */
  channelId: string | null;
  alias: string;
  sizeSats: number;
  /** What the purchase cost: the invoice and the Lightning routing fee. */
  costSats: number;
  paidAt: string;
  leaseDays: number;
  leaseEndsAt: string;
  /** The lease still runs: the figures are so far. */
  running: boolean;
  /** Forwards that came in through it during the lease, their volume and the
   *  fees they earned (on their outgoing channel). */
  inboundForwards: number;
  routedInSats: number;
  inboundFeesSats: number;
  /** inboundFees / cost (%); null with no channel to follow. */
  roiPct: number | null;
}

export const BOUGHT_INBOUND_METHOD =
  "Fees of the forwards that came in through the bought channel while its lease ran, against what the purchase cost " +
  "(the invoice and its routing fee). The fee is earned on the channel a payment leaves by; the bought channel brought it in. " +
  "An upper bound on what the purchase added: some of those payments might have found another way in.";

const BLOCK_MS = 10 * 60_000;
/** A purchase whose order never said its lease: the shortest standard one. */
const DEFAULT_LEASE_BLOCKS = 4_320;

/**
 * Amounts tied to a lease, each spread evenly over its lease from `at`: the
 * part of each that falls in the last `windowDays` (sat). A lease not on
 * record counts as the shortest standard one.
 */
export function spreadOverLeases(
  items: readonly { at: string; sats: number; leaseBlocks: number | null | undefined }[],
  windowDays: number,
  nowMs: number,
): number {
  const from = nowMs - windowDays * 86_400_000;
  let sats = 0;
  for (const p of items) {
    const start = Date.parse(p.at);
    if (!Number.isFinite(start)) continue;
    const leaseMs = (p.leaseBlocks && p.leaseBlocks > 0 ? p.leaseBlocks : DEFAULT_LEASE_BLOCKS) * BLOCK_MS;
    const overlap = Math.min(nowMs, start + leaseMs) - Math.max(from, start);
    if (overlap > 0) sats += (p.sats * overlap) / leaseMs;
  }
  return Math.round(sats);
}

/**
 * What inbound bought on Magma cost over the last `windowDays`, spread over
 * each lease (review a5-analytics:magma-buy-costs-missing: "amortized over
 * the lease length in Analytics"): a purchase counts with the part of its
 * lease that falls in the window. P&L books the whole cost when it was paid;
 * the routing views compare it with what a month of routing earned.
 */
export function amortizedPurchaseCost(
  paidCosts: readonly { at: string; feeSats: number; routingFeeSats: number; leaseBlocks: number | null }[],
  windowDays: number,
  nowMs: number,
): number {
  return spreadOverLeases(
    paidCosts.map((p) => ({ at: p.at, sats: p.feeSats + p.routingFeeSats, leaseBlocks: p.leaseBlocks })),
    windowDays,
    nowMs,
  );
}

/** Purchases whose channel opened, set against the forwards that came in
 *  through their channel during the lease — pure, for tests. */
export function boughtInboundRoi(
  purchases: readonly MagmaPurchase[],
  channelOf: (p: MagmaPurchase) => { channelId: string; alias: string } | null,
  events: readonly ForwardEvent[],
  nowMs: number,
): BoughtInboundRoi[] {
  const out: BoughtInboundRoi[] = [];
  for (const p of purchases) {
    if (p.state !== "channel_open" || !p.paidAt) continue;
    const start = Date.parse(p.paidAt);
    if (!Number.isFinite(start)) continue;
    const blocks = p.leaseBlocks && p.leaseBlocks > 0 ? p.leaseBlocks : DEFAULT_LEASE_BLOCKS;
    const end = start + blocks * BLOCK_MS;
    const ch = channelOf(p);
    let inboundForwards = 0;
    let routedInSats = 0;
    let feeMsat = 0;
    if (ch) {
      for (const e of events) {
        if (e.incomingChannel !== ch.channelId) continue;
        const t = Date.parse(e.createdAt);
        if (!(t >= start && t < Math.min(end, nowMs + 1))) continue;
        inboundForwards += 1;
        routedInSats += e.tokens;
        feeMsat += e.feeMsat;
      }
    }
    const costSats = p.feeSats + (p.routingFeeSats ?? 0);
    const inboundFeesSats = Math.round(feeMsat / 1000);
    out.push({
      orderId: p.orderId,
      channelId: ch?.channelId ?? null,
      alias: ch?.alias ?? "",
      sizeSats: p.sizeSats,
      costSats,
      paidAt: p.paidAt,
      leaseDays: Math.round((blocks / 144) * 10) / 10,
      leaseEndsAt: new Date(end).toISOString(),
      running: nowMs < end,
      inboundForwards,
      routedInSats,
      inboundFeesSats,
      roiPct: ch && costSats > 0 ? Math.round(((feeMsat / 1000) / costSats) * 100) : null,
    });
  }
  return out.sort((a, b) => b.paidAt.localeCompare(a.paidAt));
}
