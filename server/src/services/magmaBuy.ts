import type { MagmaOffer, OfferCondition } from "./amboss.js";
import { BLOCKS_PER_YEAR } from "./magmaHistory.js";

/**
 * Buying inbound on Magma: the offers ranked honestly (a4-lsp-payments:
 * buy-ranking-misleading). The old "best value" compared offers by their fee
 * per lease alone — a 30-day lease and a 180-day one as if they were the same
 * product — left out Amboss's own fee, never showed the seller's routing-fee
 * promise, and ranked first offers this node could not even buy from (buyer
 * conditions such as "node capacity ≥ 10M" or "clearnet sockets").
 *
 * Here every offer is evaluated at the size the buyer chose:
 *  - can this node buy it at all? Each buyer condition the seller set is
 *    checked against this node (capacity, channel count, sockets — Tor-only
 *    nodes fail "CLEARNET" — and an existing channel to the seller); one that
 *    can't be checked here (the Lightning Terminal rank) is said so;
 *  - what it costs: the seller's fee (base + rate × size) plus Amboss's
 *    platform fee — a ppm rate by the ORDER's size, read off the live book's
 *    fee tiers (on 2026-10 fills: ≤1M 1500, ≤5M 1000, ≤50M 500, above 350) —
 *    and that total per year of guaranteed lease, so leases of different
 *    lengths compare fairly (the up-front total is shown too);
 *  - what the inbound is worth: the routing-fee promise for the lease.
 * Ranked: buyable first, then fitting the size, then with a fee promise,
 * then cheapest per year of lease.
 */

/** What the buyer conditions are checked against: this node. */
export interface BuyerFacts {
  capacitySat: number;
  channelCount: number;
  /** Address kinds this node announces (an onion address = TOR). */
  sockets: ReadonlySet<"TOR" | "CLEARNET">;
  /** Channels this node has with a node (open or opening). */
  channelsWith: (pubkey: string) => number;
}

export interface ConditionCheck {
  condition: string;
  /** null: can't be checked from here. */
  pass: boolean | null;
  text: string;
}

export interface BuyOffer {
  offerId: string;
  sellerPubkey: string;
  sellerScore: number;
  minSizeSats: number;
  maxSizeSats: number;
  availableSats: number;
  /** The size this was evaluated at: the buyer's, clamped into the offer. */
  sizeSats: number;
  /** The buyer's size lies within what the offer sells. */
  fits: boolean;
  leaseBlocks: number;
  leaseDays: number;
  feeRatePpm: number;
  baseFeeSats: number;
  sellerFeeSats: number;
  /** Amboss's platform fee for an order of this size (null: tiers unknown). */
  ambossFeeSats: number | null;
  totalFeeSats: number;
  /** The total per year of guaranteed lease, ppm of the channel. */
  costPpmPerYear: number;
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  /** Can this node buy it? null: a condition can't be checked from here. */
  eligible: boolean | null;
  conditions: ConditionCheck[];
}

/** The Amboss fee tier an order of `sizeSats` pays (ppm), from the live
 *  book's tiers; null when none is known. */
export function ambossFeePpmFor(tiers: { ambossFee: number; upTo: number | null }[], sizeSats: number): number | null {
  if (!tiers.length) return null;
  return (tiers.find((t) => t.upTo === null || sizeSats <= t.upTo) ?? tiers[tiers.length - 1]).ambossFee;
}

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

function compare(actual: number, operator: string, value: number): boolean | null {
  switch (operator) {
    case "GREATER_THAN":
      return actual > value;
    case "GREATER_THAN_OR_EQUAL_TO":
      return actual >= value;
    case "LESS_THAN":
      return actual < value;
    case "LESS_THAN_OR_EQUAL_TO":
      return actual <= value;
    case "EQUAL_TO":
      return actual === value;
    case "NOT_EQUAL_TO":
      return actual !== value;
    default:
      return null;
  }
}

const OP_TEXT: Record<string, string> = {
  GREATER_THAN: "more than",
  GREATER_THAN_OR_EQUAL_TO: "at least",
  LESS_THAN: "less than",
  LESS_THAN_OR_EQUAL_TO: "at most",
  EQUAL_TO: "exactly",
  NOT_EQUAL_TO: "anything but",
  CONTAINS: "including",
  DOES_NOT_CONTAIN: "without",
};

/** One buyer condition, checked against this node. */
export function checkCondition(c: OfferCondition, me: BuyerFacts, sellerPubkey: string): ConditionCheck {
  const op = OP_TEXT[c.operator] ?? c.operator.toLowerCase();
  const n = Number(c.value);
  switch (c.condition) {
    case "NODE_CAPACITY": {
      const pass = Number.isFinite(n) ? compare(me.capacitySat, c.operator, n) : null;
      return { condition: c.condition, pass, text: `node capacity ${op} ${fmt(n)} sat (yours: ${fmt(me.capacitySat)})` };
    }
    case "NODE_CHANNELS": {
      const pass = Number.isFinite(n) ? compare(me.channelCount, c.operator, n) : null;
      return { condition: c.condition, pass, text: `${op} ${fmt(n)} channels (yours: ${me.channelCount})` };
    }
    case "PARALLEL_CHANNELS": {
      const have = me.channelsWith(sellerPubkey);
      const pass = Number.isFinite(n) ? compare(have, c.operator, n) : null;
      return { condition: c.condition, pass, text: `${op} ${fmt(n)} existing channels with the seller (yours: ${have})` };
    }
    case "NODE_SOCKETS": {
      const kind = String(c.value).toUpperCase();
      const kinds = me.sockets;
      const only = kinds.size === 1 && kinds.has(kind as "TOR" | "CLEARNET");
      const pass =
        c.operator === "CONTAINS"
          ? kinds.has(kind as "TOR" | "CLEARNET")
          : c.operator === "DOES_NOT_CONTAIN"
            ? !kinds.has(kind as "TOR" | "CLEARNET")
            : c.operator === "EQUAL_TO"
              ? only
              : c.operator === "NOT_EQUAL_TO"
                ? !only
                : null;
      const yours = kinds.size ? [...kinds].join(" + ").toLowerCase() : "none announced";
      return { condition: c.condition, pass, text: `node addresses ${op} ${kind.toLowerCase()} (yours: ${yours})` };
    }
    case "TERMINAL_WEB_RANK":
      return { condition: c.condition, pass: null, text: `Lightning Terminal rank ${op} ${c.value} (can't be checked from here)` };
    default:
      return { condition: c.condition, pass: null, text: `${c.condition.toLowerCase()} ${op} ${c.value} (unknown condition)` };
  }
}

/** Every offer, evaluated at `desiredSat` for this node, ranked. */
export function rankBuyOffers(
  offers: MagmaOffer[],
  tiers: { ambossFee: number; upTo: number | null }[],
  me: BuyerFacts,
  desiredSat: number,
): BuyOffer[] {
  return offers
    .map((o): BuyOffer => {
      const top = Math.max(o.minSizeSats, Math.min(o.maxSizeSats, o.availableSats));
      const sizeSats = Math.min(top, Math.max(o.minSizeSats, Math.floor(desiredSat)));
      const fits = desiredSat >= o.minSizeSats && desiredSat <= Math.min(o.maxSizeSats, o.availableSats);
      const sellerFeeSats = Math.ceil(o.baseFeeSats + (o.feeRatePpm * sizeSats) / 1_000_000);
      const ppm = ambossFeePpmFor(tiers, sizeSats);
      const ambossFeeSats = ppm === null ? null : Math.ceil((ppm * sizeSats) / 1_000_000);
      const totalFeeSats = sellerFeeSats + (ambossFeeSats ?? 0);
      const leaseBlocks = o.minBlockLength > 0 ? o.minBlockLength : 4_320;
      const conditions = o.conditions.map((c) => checkCondition(c, me, o.sellerPubkey));
      const eligible = conditions.some((c) => c.pass === false) ? false : conditions.some((c) => c.pass === null) ? null : true;
      return {
        offerId: o.id,
        sellerPubkey: o.sellerPubkey,
        sellerScore: o.sellerScore,
        minSizeSats: o.minSizeSats,
        maxSizeSats: o.maxSizeSats,
        availableSats: o.availableSats,
        sizeSats,
        fits,
        leaseBlocks,
        leaseDays: Math.round(leaseBlocks / 144),
        feeRatePpm: o.feeRatePpm,
        baseFeeSats: o.baseFeeSats,
        sellerFeeSats,
        ambossFeeSats,
        totalFeeSats,
        costPpmPerYear: sizeSats > 0 ? Math.round((totalFeeSats / sizeSats) * 1_000_000 * (BLOCKS_PER_YEAR / leaseBlocks)) : 0,
        feeRateCapPpm: o.feeRateCapPpm,
        baseFeeCapSats: o.baseFeeCapSats,
        eligible,
        conditions,
      };
    })
    .sort((a, b) => {
      const rank = (x: BuyOffer) => (x.eligible === true ? 0 : x.eligible === null ? 1 : 2);
      return (
        rank(a) - rank(b) ||
        Number(b.fits) - Number(a.fits) ||
        Number(b.feeRateCapPpm !== null && b.feeRateCapPpm > 0) - Number(a.feeRateCapPpm !== null && a.feeRateCapPpm > 0) ||
        a.costPpmPerYear - b.costPpmPerYear ||
        b.sellerScore - a.sellerScore
      );
    });
}
