import { getChainBalance, getChannels, getPendingChannels, type AuthenticatedLnd } from "lightning";
import { onchainCosts } from "./nodeEconomics.js";
import type { LeaseCap } from "./leaseCaps.js";

/**
 * One on-chain budget for every demand on the wallet's coins: Magma sales,
 * LSPS1 sales and autopilot routing opens — and the operator's own manual
 * opens and on-chain sends, which take the same mutex and may not spend what
 * is promised to buyers unless the operator confirms it (promisedSpendRefusal).
 *
 * Before, each path checked "balance − reserve" on its own, with a per-run
 * counter that was reset every run: a Magma order accepted at 10:00 was
 * forgotten by 10:03, so a routing open could spend the coins promised to
 * that buyer, and the buyer's paid order then failed at open time. Two pieces
 * fix that:
 *
 *  - OnchainMutex: one commitment at a time. Every "check the balance, then
 *    open" runs inside it, so two paths can never both plan the same coins.
 *    It is held only for the check + open + record, never across a slow
 *    Amboss call, a payment, or a retry wait.
 *  - CapitalLedger: the coins already promised (accepted Magma orders not yet
 *    funded, PAID LSPS1 orders not yet opened). Each reservation lives in its
 *    owner's persisted order record (magma-orders.json, lsps1-orders.json), so
 *    a restart sees exactly the same reservations — there is no second copy
 *    to drift out of sync. A reservation ends when the funding transaction is
 *    broadcast: from then on the wallet balance itself shows the spend, and
 *    counting the order again would subtract it twice.
 *
 * A promised open needs more than its channel size: its own funding fee, one
 * more step of LND's anchor reserve (10k per anchor channel), and the sell
 * reserve its own check will apply. Every other open — and every new promise
 * — leaves all of that in the wallet, so each promised open still passes its
 * check when its turn comes (see spendableFrom).
 */

// ── the mutex ─────────────────────────────────────────────────────────────────

export class OnchainMutex {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;
  private holder: string | null = null;

  /** Run `fn` once every earlier holder is done. FIFO — waits, never skips. */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.depth += 1;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((r) => (release = r));
    try {
      await prev;
      this.holder = label;
      return await fn();
    } finally {
      this.holder = null;
      this.depth -= 1;
      release();
    }
  }

  /** True while anyone holds or waits for the mutex. */
  get busy(): boolean {
    return this.depth > 0;
  }

  /** Who holds it right now (for status and logs). */
  get heldBy(): string | null {
    return this.holder;
  }

  /** Resolves true once nobody holds or waits for it, false after `timeoutMs`. */
  async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.depth > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }
}

// ── the ledger ────────────────────────────────────────────────────────────────

export interface Reservation {
  /** "magma:<orderId>" / "lsps1:<orderId>" — unique per order. */
  key: string;
  sats: number;
  /** The operator reserve this order's own open is checked against (the sell
   *  reserve). Until the order is funded, every other open leaves at least
   *  this much in the wallet too — or the promised open would find it gone. */
  reserveSat: number;
}

export interface CapitalSource {
  /** Coins promised to buyers and not yet spent on-chain. */
  reservations(): Reservation[];
  /** Capital in sold channels whose lease is still running (deploy cap). */
  deployedSat(): number;
  /** Funding outpoints this source has tied to one of its sales. */
  claimedOutpoints(): Iterable<string>;
  /** The routing-fee promises of the channels it sold (leaseCaps.ts) — the
   *  fee autopilot and manual fee applies keep those channels within them. */
  leaseCaps?(): LeaseCap[];
}

export class CapitalLedger {
  readonly mutex = new OnchainMutex();
  private readonly sources = new Map<string, CapitalSource>();

  /** Add (or replace) a demand source, e.g. "magma", "lsps1". */
  register(name: string, source: CapitalSource): void {
    this.sources.set(name, source);
  }

  reservations(): Reservation[] {
    return [...this.sources.values()].flatMap((s) => s.reservations());
  }

  /** The promised opens still to come, leaving out `exceptKey` (the order
   *  about to be funded: its own reservation is what pays for it). */
  pending(exceptKey?: string): Reservation[] {
    return this.reservations().filter((r) => r.key !== exceptKey && r.sats > 0);
  }

  /** Sats promised to buyers, leaving out `exceptKey`. */
  reservedSat(exceptKey?: string): number {
    return this.pending(exceptKey).reduce((s, r) => s + r.sats, 0);
  }

  /** Sold capital whose lease is still running, across every source. */
  deployedSat(): number {
    return [...this.sources.values()].reduce((s, src) => s + Math.max(0, src.deployedSat()), 0);
  }

  /**
   * Every funding outpoint some sale has claimed — Magma's AND LSPS1's. An
   * open whose outcome was unclear looks for "a channel we funded, to this
   * buyer, of this size": excluding only its own source's channels let a
   * Magma order adopt (and report, and get paid for) the channel an LSPS1
   * sale had opened to the same buyer, or the other way round — one channel,
   * paid for twice.
   */
  claimedOutpoints(): Set<string> {
    const out = new Set<string>();
    for (const src of this.sources.values()) for (const o of src.claimedOutpoints()) if (o) out.add(o);
    return out;
  }

  /** Every routing-fee promise of a sold channel, Magma's and LSPS1's. */
  leaseCaps(): LeaseCap[] {
    return [...this.sources.values()].flatMap((s) => s.leaseCaps?.() ?? []);
  }
}

// ── the reserve (D5) ──────────────────────────────────────────────────────────

/** LND keeps this much per anchor channel for fee bumping, up to 10× (lnd
 *  lnwallet: AnchorChanReservedValue / MaxAnchorChanReservedValue) and refuses
 *  to fund a public channel that would leave less. */
export const ANCHOR_RESERVE_PER_CHANNEL_SAT = 10_000;
export const ANCHOR_RESERVE_MAX_SAT = 100_000;

const ANCHOR_TYPES = new Set(["anchor", "anchor_with_lease_constraint", "simplified_taproot"]);

export interface EffectiveReserve {
  /** The caller's reserve setting — or, while opens are promised, the larger
   *  reserve those opens' own checks will apply. */
  userReserveSat: number;
  anchorChannels: number;
  /** Opens promised to buyers and not made yet (each needs its own funding
   *  fee and adds one anchor channel). */
  pendingOpens: number;
  /** What LND will insist on once this open AND every pending one are made. */
  anchorReserveSat: number;
  /** Estimated on-chain fee of ONE funding transaction. */
  fundingFeeSat: number;
  /** max(user, anchor) + a funding fee for this open and for each pending
   *  one — never spend below this. */
  totalSat: number;
}

/** What the reserve depends on in LND: anchor channels and the fee estimate. */
export interface ReserveInputs {
  anchorChannels: number;
  fundingFeeSat: number;
}

const anchorReserveFor = (anchorChannels: number): number =>
  Math.min(ANCHOR_RESERVE_MAX_SAT, ANCHOR_RESERVE_PER_CHANNEL_SAT * anchorChannels);

/** Anchor-type channels LND must be able to fee-bump: open, opening, closing. */
async function countAnchorChannels(lnd: AuthenticatedLnd): Promise<number> {
  const [open, pending] = await Promise.all([
    getChannels({ lnd }),
    getPendingChannels({ lnd }).catch(() => ({ pending_channels: [] as { type?: string }[] })),
  ]);
  const anchors = (t: string | undefined) => (t && ANCHOR_TYPES.has(t) ? 1 : 0);
  return (
    open.channels.reduce((n, c) => n + anchors(c.type), 0) +
    pending.pending_channels.reduce((n, c) => n + anchors((c as { type?: string }).type), 0)
  );
}

export async function reserveInputs(lnd: AuthenticatedLnd): Promise<ReserveInputs> {
  const [anchorChannels, costs] = await Promise.all([countAnchorChannels(lnd), onchainCosts(lnd)]);
  return { anchorChannels, fundingFeeSat: costs.openCostSat };
}

/**
 * D5, for one open with `pending` promised opens still to come after it:
 *
 *   max(user reserve, the reserve any pending open's own check applies,
 *       LND's anchor reserve once all of them are made: 10k × (anchor
 *       channels + 1 + pending), capped at 100k)
 *   + a funding fee for this open and one for each pending open.
 *
 * The old check used the user reserve alone (50k by default) and no fee, so
 * an order sized at "balance − 50k" was accepted and then refused by LND at
 * open time — after the buyer had paid. Counting only one open's fee and
 * anchor step did the same to the LAST of two orders that sold an offer out:
 * the first open took the fee and the anchor step the second one needed.
 */
export function reserveFor(
  inputs: ReserveInputs,
  userReserveSat: number,
  pending: readonly Reservation[] = [],
  /** false for a spend that adds no channel (an on-chain send): no anchor
   *  step of its own — it still pays one transaction fee. */
  newChannel = true,
): EffectiveReserve {
  const pendingOpens = pending.length;
  const user = Math.max(userReserveSat, ...pending.map((r) => (Number.isFinite(r.reserveSat) ? r.reserveSat : 0)));
  const anchorReserveSat = anchorReserveFor(inputs.anchorChannels + (newChannel ? 1 : 0) + pendingOpens);
  return {
    userReserveSat: user,
    anchorChannels: inputs.anchorChannels,
    pendingOpens,
    anchorReserveSat,
    fundingFeeSat: inputs.fundingFeeSat,
    totalSat: Math.max(user, anchorReserveSat) + inputs.fundingFeeSat * (1 + pendingOpens),
  };
}

/** The reserve for one open now, with `pending` promised opens after it. */
export async function effectiveReserve(
  lnd: AuthenticatedLnd,
  userReserveSat: number,
  pending: readonly Reservation[] = [],
): Promise<EffectiveReserve> {
  return reserveFor(await reserveInputs(lnd), userReserveSat, pending);
}

export interface Spendable {
  /** Confirmed on-chain balance. */
  chainSat: number;
  reserve: EffectiveReserve;
  /** Promised to other buyers (pending opens, minus the one being funded). */
  reservedSat: number;
  /** What one new open may use: chain − reserve − promised (≥ 0). Whatever
   *  it is spent on, every pending open can still be made afterwards. */
  spendableSat: number;
}

export function spendableFrom(
  chainSat: number,
  inputs: ReserveInputs,
  userReserveSat: number,
  pending: readonly Reservation[],
  newChannel = true,
): Spendable {
  const reserve = reserveFor(inputs, userReserveSat, pending, newChannel);
  const reservedSat = pending.reduce((s, r) => s + Math.max(0, r.sats), 0);
  const left = chainSat - reserve.totalSat - reservedSat;
  // Fail closed: a NaN anywhere (a bad fee estimate, a malformed record)
  // must read as "nothing to spend" — never pass every `spendable < size`.
  return { chainSat, reserve, reservedSat, spendableSat: Number.isFinite(left) ? Math.max(0, left) : 0 };
}

export interface SpendableOpts {
  /** The order about to be funded: its own reservation is what pays for it. */
  exceptKey?: string;
  /** Promises outside the shared ledger that this caller honours as well
   *  (LSPS1 counts its own unpaid quotes against its new quotes). */
  extra?: readonly Reservation[];
  /** false for a spend that opens no channel (an on-chain send). */
  newChannel?: boolean;
}

/** What a new on-chain commitment may spend right now. Call it inside the
 *  mutex when the answer decides an open. */
export async function spendableOnchain(
  lnd: AuthenticatedLnd,
  ledger: CapitalLedger,
  userReserveSat: number,
  opts: SpendableOpts = {},
): Promise<Spendable> {
  const [{ chain_balance }, inputs] = await Promise.all([getChainBalance({ lnd }), reserveInputs(lnd)]);
  const pending = [...ledger.pending(opts.exceptKey), ...(opts.extra ?? []).filter((r) => r.key !== opts.exceptKey && r.sats > 0)];
  return spendableFrom(chain_balance, inputs, userReserveSat, pending, opts.newChannel ?? true);
}

/** One promise standing in the way of a manual spend. */
export interface PromisedOrder {
  /** "magma" or "lsps1". */
  source: string;
  orderId: string;
  sats: number;
}

/** A manual spend refused because it would take coins promised to buyers. */
export interface PromisedSpendRefusal {
  /** What can be spent while every promised open can still be made. */
  spendableSat: number;
  /** Promised to buyers (the channel sizes). */
  promisedSat: number;
  promised: PromisedOrder[];
  message: string;
}

/**
 * A manual open or on-chain send — the operator's own spend, outside the
 * autopilot's limits — may not take the coins promised to buyers: accepted
 * Magma orders and paid LSPS1 orders whose channel isn't open yet. Spending
 * them makes those channels fail AFTER the buyers paid (refunded, and on
 * Magma an unfulfilled order Amboss counts against the seller score).
 *
 * The spend must leave what the promised opens need: their sizes, their
 * funding fees, their steps of LND's anchor reserve and the sell reserve
 * their own checks apply. With nothing promised there is nothing to protect
 * — no reserve of the autopilot's is imposed on a manual spend; LND applies
 * its own limits. Null: go ahead. Call it inside the on-chain mutex when the
 * answer decides the spend.
 */
export async function promisedSpendRefusal(
  lnd: AuthenticatedLnd,
  ledger: CapitalLedger,
  amountSat: number,
  opts: { newChannel: boolean },
): Promise<PromisedSpendRefusal | null> {
  const pending = ledger.pending();
  if (pending.length === 0) return null;
  const sp = await spendableOnchain(lnd, ledger, 0, { newChannel: opts.newChannel });
  if (amountSat <= sp.spendableSat) return null;
  const promised = pending.map((r) => {
    const at = r.key.indexOf(":");
    return { source: at > 0 ? r.key.slice(0, at) : r.key, orderId: at > 0 ? r.key.slice(at + 1) : "", sats: r.sats };
  });
  return { spendableSat: sp.spendableSat, promisedSat: sp.reservedSat, promised, message: promisedSpendText(sp.spendableSat, promised) };
}

const satsText = (n: number): string => Math.round(n).toLocaleString("en-US");

function promisedSpendText(spendableSat: number, promised: PromisedOrder[]): string {
  const group = (source: string, label: string) => {
    const of = promised.filter((p) => p.source === source);
    if (of.length === 0) return null;
    const sats = of.reduce((s, p) => s + p.sats, 0);
    return `${of.length} ${label}${of.length === 1 ? "" : "s"} (${satsText(sats)} sat)`;
  };
  const who = [group("magma", "accepted Magma order"), group("lsps1", "paid LSP order")].filter(Boolean).join(" and ");
  const magma = promised.some((p) => p.source === "magma");
  return (
    `Only ${satsText(spendableSat)} sat can be spent without touching the coins promised to buyers whose channels ` +
    `aren't open yet: ${who || `${promised.length} order${promised.length === 1 ? "" : "s"}`}. Spending more makes ` +
    `${promised.length === 1 ? "that channel" : "those channels"} fail to open after the buyer paid — the payment goes back` +
    (magma ? ", and Amboss counts a Magma order that isn't fulfilled against your seller score." : ".")
  );
}

/**
 * The most liquidity one offer may list so that WHATEVER orders buy it out —
 * each at least `minOrderSat` — can all be funded: each of them is one more
 * open with its own funding fee and its own step of LND's anchor reserve.
 *
 * Listing "what one open may spend" let two orders sell the offer out and the
 * second open fail after its buyer had paid. Here, k orders of at least m fit
 * into anything below (k + 1) × m, so for each k the listing may be as large
 * as k opens can fund — the best k wins.
 */
export function listableSat(sp: Spendable, minOrderSat: number): number {
  const m = Math.max(1, Math.floor(minOrderSat));
  const { anchorChannels, pendingOpens, fundingFeeSat, userReserveSat } = sp.reserve;
  let best = 0;
  for (let k = 1; k <= 1_000; k++) {
    const opens = pendingOpens + k;
    const capital =
      sp.chainSat - sp.reservedSat - opens * fundingFeeSat - Math.max(userReserveSat, anchorReserveFor(anchorChannels + opens));
    if (!(capital >= k * m)) break; // k orders of at least m no longer fit (or NaN: list nothing)
    best = Math.max(best, Math.min(capital, (k + 1) * m - 1));
  }
  return Math.max(0, best);
}

// ── finding an open after a crash ─────────────────────────────────────────────

export interface PeerChannel {
  outpoint: string;
  capacity: number;
  pending: boolean;
  /** We funded it (initiator local). */
  ours: boolean;
  /** Funding block height for confirmed channels (from the short channel id). */
  fundedHeight: number | null;
}

/** Every channel to `pubkey` that LND knows: open, or pending open. */
export async function channelsWith(lnd: AuthenticatedLnd, pubkey: string): Promise<PeerChannel[]> {
  const [open, pending] = await Promise.all([getChannels({ lnd, partner_public_key: pubkey }), getPendingChannels({ lnd })]);
  return [
    ...open.channels
      .filter((c) => c.partner_public_key === pubkey)
      .map((c) => ({
        outpoint: `${c.transaction_id}:${c.transaction_vout}`,
        capacity: c.capacity,
        pending: false,
        ours: !c.is_partner_initiated,
        fundedHeight: Number(c.id.split("x")[0]) || null,
      })),
    ...pending.pending_channels
      .filter((p) => p.is_opening && p.partner_public_key === pubkey)
      .map((p) => ({
        outpoint: `${p.transaction_id}:${p.transaction_vout}`,
        capacity: p.capacity,
        pending: true,
        ours: !p.is_partner_initiated,
        fundedHeight: null,
      })),
  ];
}

/**
 * After a crash between "open started" and "outpoint saved": the channel LND
 * opened for us, if any. A match is a channel we funded, to `pubkey`, of
 * exactly `capacity`, that existed neither before the open started
 * (`exclude` holds the outpoints seen then, plus those other orders claim)
 * nor confirmed before `notBeforeHeight`.
 */
export async function findOpenedChannel(
  lnd: AuthenticatedLnd,
  q: { pubkey: string; capacity: number; exclude: Iterable<string>; notBeforeHeight?: number },
): Promise<PeerChannel | null> {
  const exclude = new Set(q.exclude);
  const candidates = (await channelsWith(lnd, q.pubkey)).filter(
    (c) =>
      c.ours &&
      c.capacity === q.capacity &&
      !exclude.has(c.outpoint) &&
      (q.notBeforeHeight === undefined || c.fundedHeight === null || c.fundedHeight >= q.notBeforeHeight),
  );
  // Pending first: a fresh open is the likeliest match.
  candidates.sort((a, b) => Number(b.pending) - Number(a.pending));
  return candidates[0] ?? null;
}
