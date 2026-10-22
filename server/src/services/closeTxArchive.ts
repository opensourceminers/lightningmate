import {
  getChainTransactions,
  getClosedChannels,
  getPendingChannels,
  type AuthenticatedLnd,
  type GetPendingChannelsResult,
} from "lightning";
import { JsonStore } from "../store.js";
import { closedFactsOf, closeTxidsOf, walletTxsOf, type ClosedChannelFacts, type WalletTx } from "./closeCosts.js";

/**
 * LightningMate's own copy of the transactions close costs are worked out
 * from (closeCosts.ts) — review of P6.
 *
 * LND's wallet (btcwallet) stores a transaction LND publishes that pays no
 * wallet address and spends no wallet coin — a force close's commitment, a
 * legacy second-level HTLC transaction, a cooperative close that paid this
 * node nothing — as unconfirmed, and never learns that it was mined. At the
 * next start it broadcasts it again, hears that it is already in the chain,
 * and removes it from its store. From then on the commitment's fee could not
 * be worked out, nor the fees of the sweeps whose inputs its outputs value:
 * the close read "cost unknown". So every transaction a close (or a channel
 * still closing) is made of is copied here as the books see it — on every
 * P&L or score read, and once an hour from the autopilot's start, a read
 * that needs no switch on — and stands in for the wallet's record once the
 * wallet no longer lists it.
 */

/** At most this many transactions are kept — a close brings two to six, so
 *  this is far beyond any node's closes; past it the oldest go first. */
const MAX_RECORDS = 20_000;
/** With nobody reading the books, the wallet is looked at this long after
 *  the start … */
const FIRST_LOOK_MS = 60_000;
/** … and then every hour: a force close sits in its timelock for a day to
 *  two weeks, and its commitment must be copied before LND restarts. */
const LOOK_EVERY_MS = 60 * 60_000;

const TXID = /^[0-9a-f]{64}$/i;

function isRecord(r: unknown): r is WalletTx {
  if (!r || typeof r !== "object") return false;
  const t = r as Partial<WalletTx>;
  return (
    typeof t.id === "string" &&
    TXID.test(t.id) &&
    typeof t.createdAt === "string" &&
    typeof t.isConfirmed === "boolean" &&
    typeof t.isOutgoing === "boolean" &&
    typeof t.transaction === "string" &&
    (t.fee === undefined || typeof t.fee === "number") &&
    Array.isArray(t.inputs) &&
    t.inputs.every((i) => i && typeof i.txid === "string" && typeof i.vout === "number" && typeof i.isLocal === "boolean")
  );
}

/** What the walk starts from: every closed channel's closing transaction and
 *  the sweeps LND names for it, and the closing transaction of every channel
 *  still closing (waiting for it to confirm, or force closing). */
export function closeSeeds(closed: readonly ClosedChannelFacts[], pending: GetPendingChannelsResult["pending_channels"]): string[] {
  const seeds = closed.flatMap((c) => [c.closeTxid, ...c.sweepTxids]);
  for (const p of pending) if (p.is_closing && p.close_transaction_id) seeds.push(p.close_transaction_id);
  return seeds;
}

export class CloseTxArchive {
  private readonly store: JsonStore<WalletTx[]>;
  private readonly byId = new Map<string, WalletTx>();
  private firstLook: ReturnType<typeof setTimeout> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private looking = false;
  /** The last save failed (a full disk, an I/O error): what is kept here is
   *  ahead of the file. Review of P6: the next looks saw the same wallet,
   *  found nothing changed and never saved again — a LightningMate restart
   *  then lost the copy, and once LND had restarted too the force close read
   *  "cost unknown", the very case the copy is for. */
  private unsaved = false;

  constructor(dataDir: string) {
    this.store = new JsonStore<WalletTx[]>(dataDir, "close-txs.json", { compact: true });
    const read = this.store.read([]);
    for (const r of Array.isArray(read) ? read : []) if (isRecord(r)) this.byId.set(r.id, r);
  }

  /** How many transactions are kept. */
  get size(): number {
    return this.byId.size;
  }

  /**
   * The books' view of the wallet: its own transactions, and every kept one
   * it no longer lists — after keeping (or refreshing) the wallet's record of
   * each transaction the closes are worked out from: those of `seeds`
   * (closeSeeds) and the transactions spending their channel outputs.
   * Saved when something changed — and after a failed save, on every call
   * until a save succeeds (the hourly look retries it by itself).
   */
  update(walletTxs: readonly WalletTx[], seeds: Iterable<string>): WalletTx[] {
    const listed = new Set(walletTxs.map((t) => t.id));
    const txs = [...walletTxs, ...[...this.byId.values()].filter((r) => !listed.has(r.id))];
    const ids = closeTxidsOf(seeds, txs);
    let changed = false;
    for (const t of walletTxs) {
      if (!ids.has(t.id) || !t.transaction) continue;
      const kept = this.byId.get(t.id);
      if (kept && JSON.stringify(kept) === JSON.stringify(t)) continue;
      this.byId.set(t.id, { ...t, inputs: t.inputs.map((i) => ({ ...i })) });
      changed = true;
    }
    if (changed || this.unsaved) {
      if (this.byId.size > MAX_RECORDS) {
        const oldest = [...this.byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        for (const r of oldest.slice(0, this.byId.size - MAX_RECORDS)) this.byId.delete(r.id);
      }
      // A failed save is logged and alerted by the store (write_failed, until
      // a save of this file succeeds).
      this.unsaved = !this.store.write([...this.byId.values()]);
    }
    return txs;
  }

  /** Copy what the wallet holds of the closes now (LND unreachable: nothing
   *  this time). */
  async look(lnd: AuthenticatedLnd): Promise<void> {
    if (this.looking) return;
    this.looking = true;
    try {
      const [chain, closed, pending] = await Promise.all([
        getChainTransactions({ lnd }),
        getClosedChannels({ lnd }),
        getPendingChannels({ lnd }).catch(() => ({ pending_channels: [] })),
      ]);
      this.update(walletTxsOf(chain.transactions), closeSeeds(closedFactsOf(closed.channels), pending.pending_channels));
    } catch {
      // The next look, or the next read of the books, tries again.
    } finally {
      this.looking = false;
    }
  }

  /** Look at the wallet soon after the start and every hour from then on (a
   *  read; never keeps the process alive). */
  start(lnd: AuthenticatedLnd): void {
    if (this.timer || this.firstLook) return;
    this.firstLook = setTimeout(() => void this.look(lnd), FIRST_LOOK_MS);
    this.firstLook.unref?.();
    this.timer = setInterval(() => void this.look(lnd), LOOK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.firstLook) clearTimeout(this.firstLook);
    if (this.timer) clearInterval(this.timer);
    this.firstLook = undefined;
    this.timer = undefined;
  }
}
