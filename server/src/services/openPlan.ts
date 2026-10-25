import type { ChannelView } from "./channels.js";
import { fundingHeight } from "./leaseCaps.js";
import { CLOSE_TX_VBYTES, OPEN_TX_VBYTES } from "./nodeEconomics.js";
import { RECENT_CLOSE_DAYS, type SuggestionV2 } from "./suggestRecommend.js";

/**
 * Which suggested peer the channel autopilot opens to, and how big (review
 * a3-channels:auto-open-stuck-on-top1 and a3-channels:open-fee-gate-too-loose
 * — package P4). Pure: the autopilot walks the ranked suggestions through
 * planOpen and dials the first that passes.
 *
 * Before, only suggestion #1 was ever looked at: a peer whose minimum channel
 * size was above ours (22 of 50 LN+ pool nodes ask more than 1M), one with no
 * address, or one offline refused every 30 minutes, forever. And an open was
 * allowed whenever its funding fee (at the 6-block rate) stayed under 1 % of
 * the channel — 114 sat/vB for a 2M channel, years of its routing income.
 */

/** Most peers one run dials (each dial may take up to 90 s over Tor) … */
export const MAX_OPEN_TRIES_PER_RUN = 3;
/** … and no new dial starts once the stage has dialed this long: the main
 *  run's lock (manual fee applies wait on it) is not held for minutes. */
export const OPEN_DIAL_BUDGET_MS = 120_000;
/** The funding fee's confirmation target: an automatic open is not urgent
 *  (~12 hours — LND's economy estimate, not its 6-block default). */
export const OPEN_CONF_TARGET = 72;
/** Opening and later closing must pay back within this many months of what
 *  a channel of that size earns on this node. (A 3-month horizon would block
 *  nearly every routing open of a small node: a 2M channel at 1,000 ppm/yr
 *  earns ~500 sat a quarter, its open + close cost 650 sat even at 2 sat/vB.) */
export const OPEN_PAYBACK_MONTHS = 12;
/** A refusing peer waits 1 day, then 7, then 30 before it is tried again. */
export const PEER_BACKOFF_DAYS = [1, 7, 30] as const;
/** Refusal records kept (the oldest go first). */
export const PEER_RECORDS_KEPT = 200;
/** Auto-size may rise to meet a peer's minimum up to this share of the
 *  node's capital (on chain + its side of open channels) — never further. */
export const MAX_CAPITAL_SHARE_PER_OPEN = 1 / 3;
/** A channel this many blocks old (~30 days) has a month of routing to judge by. */
export const MONTH_BLOCKS = 4_320;
/** Auto size shrinks a suggestion to what can be spent, but not below this
 *  (nor the peer's minimum): a smaller channel routes too little to be worth
 *  its open and close. */
export const AUTO_SIZE_MIN_SATS = 1_000_000;
/**
 * The month-old channels' yield is trusted for the payback only with this
 * much routing behind it in the 30 days: MIN_YIELD_FORWARDS forwards out
 * through them, or MIN_YIELD_EARNED_SAT earned by them. Below both, the yield
 * counts as not measured and only the maximum fee rate applies — as with no
 * month-old channel at all. (Review of P4: the gate had a cliff at zero. A
 * node whose month-old channels earned 0 sat opened freely up to the fee
 * cap; one whose channels earned 10 sat — ~20 ppm/yr on 6M — had every open
 * skipped indefinitely, a 2M channel at 2 sat/vB "paying back" in ~195
 * months. A few forwards say nothing about what a channel earns; ten, or
 * 1,000 sat, do.)
 */
export const MIN_YIELD_FORWARDS = 10;
export const MIN_YIELD_EARNED_SAT = 1_000;
/** A Magma offer of this node listed this long has a sales record of its own
 *  for the channel stage's comparison (magmaFillsPerYear). */
export const MAGMA_OWN_RECORD_DAYS = 60;

/**
 * The sales a year this node's Magma offer can expect, for the channel
 * stage's comparison (leaveForMagma): what offers like it fill (the public
 * book's comparable cell) — capped, once its own offer has been listed
 * MAGMA_OWN_RECORD_DAYS, by its own record: (own fills + 1) / (listed years
 * + ½). One fill and half a year are added so a short record claims neither
 * nothing nor far more than the market; the estimate rises with every sale
 * and falls the longer the offer sits unsold. (Review 2026-10-25: the
 * comparison took other sellers' ~2 fills a year for a node whose own offer
 * hadn't sold in a year, and never revisited it.)
 */
export function magmaFillsPerYear(comparablePerYear: number, own: { fills: number; listedDays: number } | null): { perYear: number; ownPerYear: number | null } {
  if (!own || !(own.listedDays >= MAGMA_OWN_RECORD_DAYS)) return { perYear: comparablePerYear, ownPerYear: null };
  const ownPerYear = (Math.max(0, own.fills) + 1) / (own.listedDays / 365 + 0.5);
  return { perYear: Math.min(comparablePerYear, ownPerYear), ownPerYear };
}

/** What the autopilot remembers about a peer that refused an open. */
export interface PeerOpenRecord {
  alias: string;
  /** Refusals in a row (a successful open forgets the record). */
  fails: number;
  lastAt: string;
  /** Not tried again before this. */
  retryAt: string;
  /** The last refusal, as LND (or the dial) gave it. */
  error: string;
  /** The smallest / largest channel the peer said it takes (from its refusal). */
  minChannelSats?: number;
  maxChannelSats?: number;
}

/** What planOpen weighs a suggestion against. */
export interface OpenContext {
  /** The operator's channel size; null: auto (the suggestion's). */
  fixedSize: number | null;
  /** What an open may spend: after the reserve, the coins promised to buyers
   *  and those held for Magma (heldSat). */
  spendableSat: number;
  /** Of the spendable coins, those held for Magma (leaveForMagma) — already
   *  taken off spendableSat; said in a skip. */
  heldSat?: number;
  /** The economy fee rate the open pays (sat/vB). */
  feeRate: number;
  /** What a sat in this node's month-old channels earned (ppm/yr,
   *  measuredYield); null: nothing to measure a payback against (no such
   *  channel, or too little routing to tell). */
  yieldPpmYear: number | null;
  /** How far auto-size may rise to meet a peer's minimum (sat). */
  maxRaiseSat: number;
  peers: Readonly<Record<string, PeerOpenRecord>>;
  /** Peers connected right now: one that advertises no address can still be
   *  opened to while it is connected. */
  connected: ReadonlySet<string>;
  /** Peers the operator marked "never open automatically". */
  neverOpen: ReadonlySet<string>;
  nowMs: number;
}

export type OpenPlan = { sizeSats: number; why: string | null } | { skip: string };

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/** What opening a channel and later closing it cooperatively costs on-chain
 *  at `rate` sat/vB. */
export function openAndCloseCost(rate: number): number {
  return Math.ceil(rate * OPEN_TX_VBYTES) + Math.ceil(rate * CLOSE_TX_VBYTES);
}

/** The node's open channels with a month of history behind them. */
export function monthOldChannels(channels: readonly ChannelView[], currentHeight: number): ChannelView[] {
  return channels.filter((c) => {
    const funded = fundingHeight(c.id);
    return c.active && c.status === "open" && funded !== null && currentHeight - funded >= MONTH_BLOCKS;
  });
}

/** What the payback's yield stands on: the month-old channels and their
 *  routing over the last 30 days. */
export interface YieldEvidence {
  /** Month-old open channels, and their capacity (sat). */
  channels: number;
  capacitySat: number;
  /** Forwards out through them, and what they earned (sat). */
  forwards: number;
  earnedSat: number;
  /** False: LND's forwarding history couldn't be read (nothing is known). */
  forwardsRead: boolean;
}

/**
 * What a sat in this node's month-old channels earned over the last 30 days
 * (ppm/yr, capacity-weighted: what a channel of a given size can expect) —
 * or null when that can't be measured: no month-old channel, the forwards
 * unreadable, or too little routing (fewer than MIN_YIELD_FORWARDS forwards
 * and under MIN_YIELD_EARNED_SAT earned). With enough routing behind it, a
 * yield of 0 is a measurement too.
 */
export function measuredYield(e: YieldEvidence): number | null {
  if (e.channels === 0 || e.capacitySat <= 0 || !e.forwardsRead) return null;
  if (e.forwards < MIN_YIELD_FORWARDS && e.earnedSat < MIN_YIELD_EARNED_SAT) return null;
  return Math.round((e.earnedSat / e.capacitySat) * (365 / 30) * 1_000_000);
}

/** Why the payback could not be checked, in words (measuredYield null). */
export function unmeasuredYieldText(e: YieldEvidence): string {
  if (!e.forwardsRead) return "this node's forwarding history couldn't be read, so what a channel earns here is unknown";
  if (e.channels === 0) return "no channel is a month old yet, so what a channel earns here can't be measured";
  return (
    `too little routing to measure what a channel earns here (${fmt(e.forwards)} forward${e.forwards === 1 ? "" : "s"}, ` +
    `${fmt(e.earnedSat)} sat through month-old channels in 30 days — it takes ${MIN_YIELD_FORWARDS} forwards or ${fmt(MIN_YIELD_EARNED_SAT)} sat)`
  );
}

const when = (iso: string, nowMs: number): string => {
  const hours = (Date.parse(iso) - nowMs) / 3_600_000;
  return hours >= 36 ? `in ~${Math.round(hours / 24)} d` : `in ~${Math.max(1, Math.round(hours))} h`;
};

/** A refusal in a few words (LND's texts carry the library's prefix). */
export const briefError = (error: string): string => {
  const text = error.replace(/^\w+: /, "");
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
};

/**
 * Whether to open to this suggestion now, and at what size — or why not.
 * The peer must be worth it (usefulness, LN+ sentiment), not closed within
 * RECENT_CLOSE_DAYS, not backing off after a refusal, dialable, and the size
 * must meet what the peer takes (its LN+ minimum or the one its refusal
 * named; auto-size rises to it up to a third of the node's capital, a fixed
 * size never does), fit the funds, and pay back its open and close.
 */
export function planOpen(
  s: Pick<
    SuggestionV2,
    "pubkey" | "alias" | "socket" | "sockets" | "recommendedSizeSats" | "usefulness" | "lnplus" | "peerMinChannelSats" | "closedDaysAgo" | "closeHistoryKnown"
  >,
  ctx: OpenContext,
): OpenPlan {
  if (ctx.neverOpen.has(s.pubkey)) return { skip: "you marked it “never open automatically”" };
  if (s.usefulness === "low") return { skip: "low usefulness" };
  const lp = s.lnplus;
  if (lp && lp.negativeRatings > 0 && lp.negativeRatings >= lp.positiveRatings) {
    return { skip: `LN+ operators rate it poorly (${lp.positiveRatings} positive, ${lp.negativeRatings} negative)` };
  }
  if (s.closedDaysAgo !== null && s.closedDaysAgo <= RECENT_CLOSE_DAYS) {
    return { skip: `you closed a channel with it ${s.closedDaysAgo === 0 ? "recently" : `${s.closedDaysAgo} days ago`} (not reopened within ${RECENT_CLOSE_DAYS} days)` };
  }
  // LND didn't say its block height (or its closed channels) when the
  // suggestions were made: a close within RECENT_CLOSE_DAYS can't be ruled
  // out — nor, without the height, what a channel earns here (review
  // 2026-10-25: one failed GetInfo dropped the guard, and only the fee cap
  // applied).
  if (s.closeHistoryKnown === false) {
    return { skip: `LND didn't say its block height or its closed channels — whether you closed a channel with it within ${RECENT_CLOSE_DAYS} days can't be checked, so it isn't opened to automatically until LND does` };
  }
  const rec = ctx.peers[s.pubkey];
  if (rec && Date.parse(rec.retryAt) > ctx.nowMs) {
    return { skip: `refused ${rec.fails === 1 ? "an open" : `${rec.fails} opens in a row`} (${briefError(rec.error)}) — tried again ${when(rec.retryAt, ctx.nowMs)}` };
  }
  if (!(s.sockets?.length || s.socket) && !ctx.connected.has(s.pubkey)) return { skip: "it advertises no address to dial (and isn't connected)" };

  let size = ctx.fixedSize ?? s.recommendedSizeSats;
  let why: string | null = null;
  const min = Math.max(s.peerMinChannelSats ?? 0, rec?.minChannelSats ?? 0);
  if (min > size) {
    if (ctx.fixedSize !== null) return { skip: `it takes channels of at least ${fmt(min)} sat — your channel size is ${fmt(size)}` };
    const raised = Math.ceil(min / 100_000) * 100_000;
    if (raised > ctx.maxRaiseSat) {
      return { skip: `it takes channels of at least ${fmt(min)} sat — more than a third of the node's capital (${fmt(ctx.maxRaiseSat)} sat)` };
    }
    size = raised;
    why = `sized up to its ${fmt(min)} sat minimum`;
  }
  const max = rec?.maxChannelSats;
  if (max !== undefined && max < size) {
    const lowered = Math.floor(max / 100_000) * 100_000;
    if (ctx.fixedSize !== null || lowered < min || lowered <= 0) {
      return { skip: `it takes channels of at most ${fmt(max)} sat${ctx.fixedSize !== null ? ` — your channel size is ${fmt(size)}` : ""}` };
    }
    size = lowered;
    why = `sized down to its ${fmt(max)} sat maximum`;
  }
  if (size > ctx.spendableSat) {
    // Auto size shrinks to what can be spent — rounded down to 100k, never
    // below AUTO_SIZE_MIN_SATS nor the peer's minimum (review 2026-10-25:
    // with 3.94M spendable every suggestion of 4–10M was skipped, though a
    // 3.9M channel passed every other check). A fixed size is the
    // operator's: never shrunk. The payback below is judged at the new size.
    const fits = Math.floor(ctx.spendableSat / 100_000) * 100_000;
    if (ctx.fixedSize !== null || fits < Math.max(AUTO_SIZE_MIN_SATS, min)) {
      return { skip: `needs ${fmt(size)} sat — ${fmt(ctx.spendableSat)} spendable after the reserve, the coins promised to buyers${ctx.heldSat ? " and those held for Magma" : ""}` };
    }
    size = fits;
    why = `sized down to the ${fmt(fits)} sat that can be spent`;
  }
  if (ctx.yieldPpmYear !== null) {
    const cost = openAndCloseCost(ctx.feeRate);
    const perYear = (size * ctx.yieldPpmYear) / 1_000_000;
    const months = perYear > 0 ? (cost / perYear) * 12 : Infinity;
    if (months > OPEN_PAYBACK_MONTHS) {
      const measure = `${fmt(ctx.yieldPpmYear)} ppm/yr: what a sat in month-old channels earned, capacity-weighted`;
      return {
        skip: Number.isFinite(months)
          ? `opening and later closing it costs ~${fmt(cost)} sat at ${ctx.feeRate} sat/vB — ~${Math.round(months)} months ` +
            `of what a ${fmt(size)} sat channel earns here (${measure}); it pays back within ${OPEN_PAYBACK_MONTHS} months only at cheaper fees`
          : // Enough routing behind it, and nothing earned: no fee rate helps.
            `month-old channels here earned nothing in 30 days (${measure}) — opening and later closing it ` +
            `(~${fmt(cost)} sat at ${ctx.feeRate} sat/vB) would never pay back`,
      };
    }
  }
  return { sizeSats: size, why };
}
