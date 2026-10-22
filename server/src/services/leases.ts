import { fundingHeight, leaseEndHeight, type SoldLease } from "./leaseCaps.js";
import type { MagmaPurchase } from "./magmaPurchases.js";

/**
 * Which channels are bound by a lease, and until when (review
 * a3-channels:close-list-leased-and-pending, a4-lsp-payments:lease-unaware-
 * close-suggestions, a6-ux:lease-unaware-close — package P4).
 *
 * Three kinds of channel carry a lease:
 *  - sold on Magma (the order journal): the buyer paid for the inbound until
 *    the lease ends, and Amboss counts a seller who closes early against the
 *    seller score;
 *  - sold over LSPS1: this node promised the wallet channel_expiry_blocks;
 *  - bought on Magma (the purchase ledger): this node paid for the inbound,
 *    and the seller promised to keep the channel open for the lease.
 *
 * Before, nothing that suggests or performs a close knew about any of them:
 * only a 30-day "new channel" guard stood between a sold 90- or 180-day lease
 * (or a bought one) and the close list's "Frees … you could redeploy". Close
 * suggestions, the close dialog, POST /channels/close and the Channels table
 * now all read this one registry.
 *
 * A lease is measured the way the fee promise is (leaseCaps.ts): from the
 * block the funding confirmed in, for the order's lease, a Magma one a day
 * longer (Amboss counts it from its own confirmation). A channel whose
 * funding hasn't confirmed yet is inside its lease.
 */

export type LeaseKind = "magma_sale" | "lsps1_sale" | "magma_purchase";

export interface ChannelLease {
  kind: LeaseKind;
  orderId: string;
  /** The lease, in blocks after funding. */
  leaseBlocks: number;
  /** The last block (exclusive) the lease binds; null while the funding is
   *  unconfirmed. */
  untilHeight: number | null;
  /** Blocks until it ends (≤ 0: over); null while unconfirmed. */
  blocksLeft: number | null;
  /** Rough end date (10 minutes a block); null while unconfirmed. */
  untilApprox: string | null;
  /** Still binding the channel now. */
  running: boolean;
  /** A purchase: what this node paid for it (the invoice and the routing
   *  fee, sat), and when. */
  costSats?: number;
  paidAt?: string | null;
  /** A purchase still being paid: the hold invoice keeps the payment in
   *  flight until Amboss confirms the seller's channel. A close now cancels
   *  the purchase (Amboss refunds the payment) and gives up the inbound. */
  paying?: boolean;
  /** A sale whose lease runs because Amboss reports it still running: one
   *  this node's journal never recorded (completed before it existed, or
   *  with another tool), or one the journal did record whose lease by the
   *  journal's own count is over (Amboss confirmed the channel late). Its
   *  end is Amboss's to say (untilHeight null). */
  reportedByAmboss?: boolean;
  /** …as of this listing (ISO; null: unknown). */
  reportedAt?: string | null;
}

/** The channel fields the registry matches on (a ChannelView fits). */
export interface LeaseChannelRef {
  id: string;
  transactionId: string;
  transactionVout: number;
  peerPubkey: string;
  capacity: number;
  initiator: "local" | "remote";
  status?: "open" | "pending_open" | "pending_close";
}

/** Where the leases come from (the capital ledger, the purchase ledger). */
export interface LeaseSources {
  /** Every channel sold through Magma or LSPS1 (capital.soldLeases()). */
  soldLeases: readonly SoldLease[];
  /** Inbound bought on Magma (MagmaPurchases.list()). */
  purchases: readonly MagmaPurchase[];
  /** This node's sales Amboss lists with a running lease (MagmaDesk
   *  runningLeasesOnAmboss) — those the journal never recorded, and those
   *  whose lease the journal counts as over while Amboss doesn't — and when
   *  Amboss listed them. */
  ambossRunning?: readonly { orderId: string; channelId: string }[];
  ambossListedAt?: string | null;
}

/** The shortest standard lease: a purchase whose order never said its lease. */
const DEFAULT_LEASE_BLOCKS = 4_320;
const MS_PER_BLOCK = 10 * 60_000;

/**
 * A purchase whose seller opened (or is opening) the channel — or may be:
 * one still being paid. A Magma purchase pays a hold invoice, and the
 * payment stays in flight ("paying") until Amboss confirms the seller's
 * channel; a failure only the pay call reported may still be in flight too.
 * Fail closed: the channel being bought is protected like a bought one.
 * (Before, only "paid" and "channel_open" counted: while the seller's channel
 * confirmed, it carried no lease, and the close route closed it unasked —
 * Amboss would refund the payment, but the inbound being paid for was gone.)
 */
const bought = (p: MagmaPurchase): boolean =>
  p.state === "paid" || p.state === "channel_open" || p.state === "paying" || (p.state === "pay_failed" && !p.failureConfirmed);
/** Still being paid (Amboss hasn't confirmed the channel yet). */
const beingPaid = (p: MagmaPurchase): boolean => p.state === "paying" || p.state === "pay_failed";

/** Slack when the block an order was placed in is estimated from its time:
 *  a day of blocks, plus a tenth of the blocks since. Blocks come faster than
 *  one per 10 minutes while the hashrate grows, so an estimate for an order
 *  months old can run ahead of the real height by more than a day. */
const ORDER_HEIGHT_SLACK_BLOCKS = 144;
const ORDER_HEIGHT_SLACK_SHARE = 0.1;

/**
 * The lowest block a purchase's channel can have been funded in: the seller
 * opens it only after the order was placed (`createdAt`, this node's clock
 * at the quote) — estimated at 10 minutes a block, with slack. Null: not
 * known (the height unknown, or no creation time on record).
 */
function earliestFundingHeight(p: Pick<MagmaPurchase, "createdAt">, currentHeight: number, nowMs: number): number | null {
  const created = Date.parse(p.createdAt);
  if (!(currentHeight > 0) || !Number.isFinite(created)) return null;
  const blocksSince = Math.max(0, Math.ceil((nowMs - created) / MS_PER_BLOCK));
  return currentHeight - blocksSince - ORDER_HEIGHT_SLACK_BLOCKS - Math.ceil(blocksSince * ORDER_HEIGHT_SLACK_SHARE);
}

/**
 * Amboss gives a channel id either as LND's "BLOCKxTXxOUT" or as the 64-bit
 * number (block << 40 | tx << 16 | out); either way, LND's form.
 */
export function standardChannelId(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  if (/^\d+x\d+x\d+$/.test(s)) return s;
  if (!/^\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  if (n <= 0n) return null;
  return `${n >> 40n}x${(n >> 16n) & 0xffffffn}x${n & 0xffffn}`;
}

function measure(
  kind: LeaseKind,
  orderId: string,
  leaseBlocks: number,
  channelId: string,
  currentHeight: number,
  nowMs: number,
): ChannelLease {
  const funded = fundingHeight(channelId);
  // Measured like the fee promise: a Magma lease (sold or bought) runs a day
  // of blocks past funding + lease (MAGMA_LEASE_MARGIN_BLOCKS).
  const untilHeight = funded === null ? null : leaseEndHeight({ source: kind === "lsps1_sale" ? "lsps1" : "magma", leaseBlocks }, funded);
  const blocksLeft = untilHeight === null || currentHeight <= 0 ? null : untilHeight - currentHeight;
  return {
    kind,
    orderId,
    leaseBlocks,
    untilHeight,
    blocksLeft,
    untilApprox: blocksLeft === null ? null : new Date(nowMs + Math.max(0, blocksLeft) * MS_PER_BLOCK).toISOString(),
    // Unconfirmed, or the height unknown: inside the lease.
    running: blocksLeft === null || blocksLeft > 0,
  };
}

/** A running lease binds longer than an ended one; of two running ones, the
 *  later end (an unconfirmed one counts as the latest). */
function bindsLonger(a: ChannelLease, b: ChannelLease): boolean {
  if (a.running !== b.running) return a.running;
  return (a.untilHeight ?? Infinity) > (b.untilHeight ?? Infinity);
}

/**
 * The lease of every channel in `channels` that has one — running or ended
 * (a bought channel past its lease is still described with what it cost) —
 * by channel id.
 *
 * Sales match by funding outpoint; where Amboss still lists a sale's lease
 * running, it runs (the journal's count and Amboss's together, fail-closed).
 * A purchase matches by the channel id Amboss reports; only after every
 * purchase Amboss named a channel for has claimed it, a purchase with none
 * yet takes the seller's channel of the size bought, opened after the order
 * (each channel claimed once, the newest first — two purchases of one size
 * from one seller take one channel each).
 *
 * The matching is over all of `channels` together, so every caller must pass
 * the node's whole list: one channel alone could be claimed by a purchase
 * that, against the full list, claims another (review of P4: the close route
 * refused a channel the Channels table showed as unleased, and the dialog had
 * no way to confirm breaking a lease it never showed).
 */
export function channelLeases(
  channels: readonly LeaseChannelRef[],
  sources: LeaseSources,
  currentHeight: number,
  nowMs = Date.now(),
): Map<string, ChannelLease> {
  const out = new Map<string, ChannelLease>();
  const byOutpoint = new Map(channels.map((c) => [`${c.transactionId}:${c.transactionVout}`, c]));
  for (const sold of sources.soldLeases) {
    const c = byOutpoint.get(sold.fundingOutpoint);
    if (!c) continue;
    const kind: LeaseKind = sold.source === "lsps1" ? "lsps1_sale" : "magma_sale";
    const lease = measure(kind, sold.orderId, sold.leaseBlocks, c.id, currentHeight, nowMs);
    // Two records on one outpoint (it should not happen): the one that binds longer.
    const had = out.get(c.id);
    if (!had || bindsLonger(lease, had)) out.set(c.id, lease);
  }

  // The sales Amboss lists with a running lease. Two kinds:
  //  - sales this journal never recorded (completed before it existed, or
  //    with another tool): protected until Amboss says the lease is over
  //    (its listing drops them);
  //  - sales the journal did record whose lease is over by the journal's own
  //    count — funding block + lease + a day — while Amboss still lists it
  //    running. Amboss counts the lease from its own confirmation of the
  //    channel (VALID_CHANNEL_OPENING), which can come more than a day after
  //    the funding block (the transaction reported late, during an Amboss
  //    outage), and Amboss is who counts an early close against the seller
  //    score. Before, any lease on record — an ended one too — kept Amboss's
  //    word out, and the close list and POST /channels/close let through a
  //    close Amboss treats as early (review 2 of P4). Now either source
  //    keeps the lease running.
  // A lease still running by the journal's count keeps its known end.
  for (const a of sources.ambossRunning ?? []) {
    const id = standardChannelId(a.channelId);
    const c = id ? channels.find((x) => x.id === id) : undefined;
    const had = c ? out.get(c.id) : undefined;
    if (!c || had?.running) continue;
    const reported = {
      untilHeight: null,
      blocksLeft: null,
      untilApprox: null,
      running: true,
      reportedByAmboss: true,
      reportedAt: sources.ambossListedAt ?? null,
    };
    // The journal's record of this sale keeps its order and lease; a channel
    // whose ended record is another order's is Amboss's order now.
    out.set(c.id, had?.orderId === a.orderId ? { ...had, ...reported } : { kind: "magma_sale", orderId: a.orderId, leaseBlocks: 0, ...reported });
  }

  // Newest purchases first; a channel claimed by a sale or another purchase
  // is not claimed again.
  const purchases = sources.purchases
    .filter(bought)
    .sort((a, b) => Date.parse(b.paidAt ?? b.updatedAt) - Date.parse(a.paidAt ?? a.updatedAt));
  const claim = (p: MagmaPurchase, c: LeaseChannelRef) => {
    const lease = measure("magma_purchase", p.orderId, p.leaseBlocks && p.leaseBlocks > 0 ? p.leaseBlocks : DEFAULT_LEASE_BLOCKS, c.id, currentHeight, nowMs);
    out.set(c.id, { ...lease, costSats: p.feeSats + (p.routingFeeSats ?? 0), paidAt: p.paidAt ?? null, ...(beingPaid(p) ? { paying: true } : {}) });
  };

  // 1. Every purchase Amboss named a channel for claims that channel — or
  //    none: a channel of ours it isn't (closed since, or a sale's) claims
  //    nothing. Before, it fell back to the seller's channel of that size and
  //    tagged a channel never bought "bought on Magma" (review of P4).
  //    The named purchases all claim before any unnamed one: a repeat order
  //    from the same seller at the same size, paid but its channel not open
  //    yet, came first (newest) and took the channel Amboss had named for the
  //    older order — that channel then read with the new order's cost and
  //    lease, and a 180-day lease with a month left read as over: listed as
  //    a close candidate, and closed with no lease confirmation asked
  //    (review 2 of P4).
  for (const p of purchases) {
    const wanted = standardChannelId(p.channelId);
    const c = wanted ? channels.find((x) => x.id === wanted && !out.has(x.id)) : undefined;
    if (c) claim(p, c);
  }

  // 2. Only then the purchases Amboss hasn't named a channel for (still
  //    opening, or a record from before it was kept): the seller's channel
  //    of the size bought — one the seller opened, not claimed yet, and not
  //    funded before the order was placed (an older channel can't be the
  //    one it bought).
  // Still opening first, then the highest funding block: the likeliest to be
  // the most recent purchase. A channel already closing comes last — it is
  // not the inbound a purchase still waiting for its channel id bought (its
  // "txid:vout" id has no funding block, which would put it first).
  const closing = (c: LeaseChannelRef) => (c.status === "pending_close" ? 1 : 0);
  const newestFirst = (a: LeaseChannelRef, b: LeaseChannelRef) =>
    closing(a) - closing(b) || (fundingHeight(b.id) ?? Infinity) - (fundingHeight(a.id) ?? Infinity);
  for (const p of purchases) {
    if (standardChannelId(p.channelId)) continue;
    const notBefore = earliestFundingHeight(p, currentHeight, nowMs);
    const c = channels
      .filter(
        (x) =>
          !out.has(x.id) &&
          x.initiator === "remote" &&
          !!p.sellerPubkey &&
          x.peerPubkey === p.sellerPubkey &&
          (!(p.sizeSats > 0) || x.capacity === p.sizeSats) &&
          // A channel still opening (or closing) has no funding block to judge.
          !(notBefore !== null && (fundingHeight(x.id) ?? Infinity) < notBefore),
      )
      .sort(newestFirst)[0];
    if (c) claim(p, c);
  }
  return out;
}

/** Amboss's listing is older than this: the text says from when it is. */
const OLD_LISTING_MS = 86_400_000;

/** "as of 2026-10-20" for a listing older than a day (else ""). */
const asOf = (reportedAt: string | null | undefined, nowMs: number): string => {
  const at = reportedAt ? Date.parse(reportedAt) : NaN;
  return Number.isFinite(at) && nowMs - at > OLD_LISTING_MS ? ` (as of ${new Date(at).toISOString().slice(0, 10)})` : "";
};

/** What a lease with no count of blocks left says: its funding hasn't
 *  confirmed (no end yet), or it has — the end is known — and only the
 *  current block height couldn't be read (review of P4: both read "funding
 *  not confirmed yet"). */
export const HEIGHT_UNKNOWN_TEXT = "time left unknown: the current block height couldn't be read";

/** How long a running lease has left, in words ("41 d", "5 h"). */
export function leaseLeftText(
  l: Pick<ChannelLease, "blocksLeft" | "reportedByAmboss" | "reportedAt"> & Partial<Pick<ChannelLease, "untilHeight">>,
  nowMs = Date.now(),
): string {
  if (l.reportedByAmboss) return `Amboss reports it still running${asOf(l.reportedAt, nowMs)}`;
  if (l.blocksLeft === null) return l.untilHeight != null ? HEIGHT_UNKNOWN_TEXT : "funding not confirmed yet";
  const hours = (Math.max(0, l.blocksLeft) * MS_PER_BLOCK) / 3_600_000;
  return hours >= 48 ? `~${Math.round(hours / 24)} d left` : `~${Math.max(1, Math.round(hours))} h left`;
}

/** "Magma sale" / "LSP sale" / "bought on Magma". */
export function leaseKindText(kind: LeaseKind): string {
  return kind === "magma_sale" ? "sold on Magma" : kind === "lsps1_sale" ? "sold to an LSP client" : "bought on Magma";
}

/**
 * Why a running lease protects a channel from closing, in one line — with
 * what breaking it costs.
 */
export function leaseProtection(l: ChannelLease, nowMs = Date.now()): string {
  const until =
    l.untilHeight === null
      ? "until its funding confirms and the lease has run"
      : `until block ${l.untilHeight.toLocaleString("en-US")} (${leaseLeftText(l)})`;
  const breaks = "closing it early breaks the lease the buyer paid for, and Amboss counts that against your seller score";
  switch (l.kind) {
    case "magma_sale":
      return l.reportedByAmboss
        ? `sold on Magma (order ${l.orderId.slice(0, 8)}…) — Amboss reports its lease still running${asOf(l.reportedAt, nowMs)}; ${breaks}`
        : `sold on Magma (order ${l.orderId.slice(0, 8)}…) — leased ${until}; ${breaks}`;
    case "lsps1_sale":
      return `sold to an LSP client (order ${l.orderId.slice(0, 8)}…) — this node promised to keep it open ${until}`;
    case "magma_purchase":
      return l.paying
        ? `being bought on Magma for ${Math.round(l.costSats ?? 0).toLocaleString("en-US")} sat (order ${l.orderId.slice(0, 8)}…) — your payment is held until Amboss confirms this channel; closing it now cancels the purchase (Amboss refunds the payment) and gives up the inbound`
        : `bought on Magma for ${Math.round(l.costSats ?? 0).toLocaleString("en-US")} sat (order ${l.orderId.slice(0, 8)}…) — the inbound you paid for is leased ${until}; closing it throws that away`;
  }
}
