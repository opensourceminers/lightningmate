/**
 * Routing-fee promises on sold channels (D7).
 *
 * A Magma offer promises its buyers how the channel's routing fees will be kept
 * for the lease (`fee_rate_cap`, `base_fee_cap`; Amboss locks them into each
 * order as `promises.locked_*`). Without them the inbound a buyer paid for is
 * only as useful as the seller's fee whims allow — 97% of the offers that sell
 * carry them, and Amboss's reputation model counted "fee promise compliance".
 * LightningMate's offers never sent any, and nothing kept a sold channel's fee
 * in check either: the protect ramp or a profit floor could lift it far above
 * what a buyer would accept.
 *
 * Now every offer carries the promise, and the promise is kept: the fee
 * autopilot clamps every channel sold through Magma or LSPS1 to the caps locked
 * in its order for the lease — after every rule that can raise a fee (profit
 * floor, protect ramp, elasticity, a fixed override), and a manual fee apply is
 * clamped the same way. Lowering a fee is always allowed.
 *
 * The promise is generous on purpose — max(2,200 ppm, the fee policy's own
 * ceiling) and max(1 sat, the policy's base fee): the most common cap among
 * sellers that sell is 2,200 ppm / 1 sat, and the fee engine's ordinary range
 * (presets: 1,000–1,500 ppm, base 0) stays well inside it, so keeping it costs
 * nothing in normal operation.
 */

/** The most common fee-rate cap among Magma offers that sell (2026-10). */
export const STANDARD_FEE_RATE_CAP_PPM = 2_200;

export interface OfferFeeCaps {
  feeRateCapPpm: number;
  baseFeeCapSats: number;
}

/** The routing-fee promise an offer of this node carries (D7). */
export function offerFeeCaps(policy: { maxPpm: number; baseFeeMsat: number }): OfferFeeCaps {
  const maxPpm = Number.isFinite(policy.maxPpm) ? policy.maxPpm : 0;
  const baseMsat = Number.isFinite(policy.baseFeeMsat) ? policy.baseFeeMsat : 0;
  return {
    feeRateCapPpm: Math.max(STANDARD_FEE_RATE_CAP_PPM, Math.ceil(maxPpm)),
    baseFeeCapSats: Math.max(1, Math.ceil(baseMsat / 1000)),
  };
}

/** A channel this node sold with a routing-fee promise. */
export interface LeaseCap {
  /** "txid:vout" of the sold channel. */
  fundingOutpoint: string;
  source: "magma" | "lsps1";
  orderId: string;
  feeRateCapPpm: number;
  /** Base-fee cap in millisats. */
  baseFeeCapMsat: number;
  /** The lease: how many blocks after the funding confirmed the promise holds. */
  leaseBlocks: number;
  /** Amboss's last listing has this sale's lease running (MagmaDesk): the
   *  promise holds while it does — whatever the count above says. */
  ambossRunning?: boolean;
}

/**
 * A promise from an order's locked terms, or null when the order locked none.
 * A fee-rate cap of 0 (or none) means no promise: Amboss reads 0 for orders on
 * offers that set no caps, and clamping a sold channel to 0 ppm would route
 * for free — never what anyone promised.
 */
export function leaseCapFrom(o: {
  fundingOutpoint: string | null | undefined;
  source: LeaseCap["source"];
  orderId: string;
  feeRateCapPpm: number | null | undefined;
  baseFeeCapSats: number | null | undefined;
  leaseBlocks: number | null | undefined;
}): LeaseCap | null {
  if (!o.fundingOutpoint) return null;
  const rate = Number(o.feeRateCapPpm);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  const base = Number(o.baseFeeCapSats);
  const blocks = Number(o.leaseBlocks);
  return {
    fundingOutpoint: o.fundingOutpoint,
    source: o.source,
    orderId: o.orderId,
    feeRateCapPpm: Math.floor(rate),
    baseFeeCapMsat: Number.isFinite(base) && base >= 0 ? Math.floor(base * 1000) : Number.MAX_SAFE_INTEGER,
    // No lease length on record: the shortest standard lease (30 days).
    leaseBlocks: Number.isFinite(blocks) && blocks > 0 ? Math.floor(blocks) : 4_320,
  };
}

/**
 * Amboss counts a Magma lease from its own confirmation of the channel
 * (VALID_CHANNEL_OPENING, a few blocks after the funding block), and ends it
 * with CHANNEL_MONITORING_FINISHED. A sale's promise is kept a day of blocks
 * longer than funding height + lease, so it can never end before Amboss's
 * lease does. (LSPS1 leases are this node's own count: no margin.)
 */
export const MAGMA_LEASE_MARGIN_BLOCKS = 144;

/** The last block (exclusive) a promise binds after its funding block. */
export function leaseEndHeight(cap: Pick<LeaseCap, "source" | "leaseBlocks">, fundedAt: number): number {
  return fundedAt + cap.leaseBlocks + (cap.source === "magma" ? MAGMA_LEASE_MARGIN_BLOCKS : 0);
}

/** The block a channel was funded in, from its short channel id
 *  ("BLOCKxTXxOUT"); null for a pending channel (not confirmed yet). */
export function fundingHeight(channelId: string | null | undefined): number | null {
  const n = Number(String(channelId ?? "").split("x")[0]);
  return Number.isFinite(n) && n > 0 && /^\d+x\d+x\d+$/.test(String(channelId)) ? n : null;
}

/**
 * The promise binding a channel now, or null. The lease runs from the block the
 * funding transaction confirmed in for `leaseBlocks` blocks (a Magma sale's a
 * day longer, see MAGMA_LEASE_MARGIN_BLOCKS); a channel not yet confirmed (no
 * short channel id) is inside its lease. Several promises on one outpoint (it
 * should not happen): the strictest wins.
 */
export function activeCap(
  caps: readonly LeaseCap[],
  channel: { outpoint: string; channelId?: string | null },
  currentHeight: number,
): (LeaseCap & { untilHeight: number | null }) | null {
  let found: (LeaseCap & { untilHeight: number | null }) | null = null;
  const funded = fundingHeight(channel.channelId);
  for (const c of caps) {
    if (c.fundingOutpoint !== channel.outpoint) continue;
    let untilHeight = funded === null ? null : leaseEndHeight(c, funded);
    if (untilHeight !== null && currentHeight > 0 && currentHeight >= untilHeight) {
      // Over by its own count — unless Amboss still lists the lease running
      // (it counts from its own confirmation of the channel, which can come
      // more than a day after funding). Fail closed: the promise holds, and
      // its end is Amboss's to say. (Review of P4: the fee could rise past
      // the cap while Amboss still monitored the lease.)
      if (!c.ambossRunning) continue; // lease over
      untilHeight = null;
    }
    if (
      !found ||
      c.feeRateCapPpm < found.feeRateCapPpm ||
      (c.feeRateCapPpm === found.feeRateCapPpm && c.baseFeeCapMsat < found.baseFeeCapMsat)
    ) {
      found = { ...c, untilHeight };
    }
  }
  return found;
}

/**
 * A channel this node sold (Magma, LSPS1) — with or without a routing-fee
 * promise. Its liquidity is the inbound the buyer paid for until the lease
 * ends: the rebalancer never pulls from it (review a2 — pushing our balance
 * out through it hands the buyer's inbound back to them, unpaid).
 */
export interface SoldLease {
  /** "txid:vout" of the sold channel ("" for a sale only Amboss knows of —
   *  then `channelId` names it). */
  fundingOutpoint: string;
  source: LeaseCap["source"];
  orderId: string;
  /** Blocks after funding the lease runs (absent on record: 4,320). */
  leaseBlocks: number;
  /** Amboss's last listing has the lease running: it runs while it does. */
  ambossRunning?: boolean;
  /** The channel as Amboss names it ("BLOCKxTXxOUT" or its number) — for a
   *  sale this node's journal never recorded. */
  channelId?: string;
}

/** Whether a sold channel is still inside its lease — measured as the fee
 *  promise is (leaseEndHeight); one not confirmed yet always is, and one
 *  Amboss lists as running too (fail closed). */
export function leaseRunning(
  lease: Pick<SoldLease, "source" | "leaseBlocks" | "ambossRunning">,
  channelId: string | null | undefined,
  currentHeight: number,
): boolean {
  if (lease.ambossRunning) return true;
  const funded = fundingHeight(channelId);
  if (funded === null || currentHeight <= 0) return true;
  return currentHeight < leaseEndHeight(lease, funded);
}

/** A fee within a promise: never above its caps. */
export function clampToCap(
  fee: { feeRatePpm: number; baseFeeMsat: number },
  cap: Pick<LeaseCap, "feeRateCapPpm" | "baseFeeCapMsat">,
): { feeRatePpm: number; baseFeeMsat: number; clamped: boolean } {
  const feeRatePpm = Math.min(fee.feeRatePpm, cap.feeRateCapPpm);
  const baseFeeMsat = Math.min(fee.baseFeeMsat, cap.baseFeeCapMsat);
  return { feeRatePpm, baseFeeMsat, clamped: feeRatePpm !== fee.feeRatePpm || baseFeeMsat !== fee.baseFeeMsat };
}

/** How a promise reads in reasons and apply results. */
export function capText(cap: Pick<LeaseCap, "source" | "orderId" | "feeRateCapPpm" | "baseFeeCapMsat">): string {
  const base = cap.baseFeeCapMsat >= Number.MAX_SAFE_INTEGER ? "" : ` + ${Math.round(cap.baseFeeCapMsat / 1000)} sat base`;
  return `${cap.source === "magma" ? "Magma" : "LSP"} order ${cap.orderId.slice(0, 8)}… promised at most ${cap.feeRateCapPpm} ppm${base} for its lease`;
}
