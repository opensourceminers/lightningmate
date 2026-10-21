import { JsonStore } from "../store.js";

export interface RebalanceRecord {
  /** When the record was written: when the rebalance ended. */
  at: string;
  via: "manual" | "autopilot";
  targetId: string;
  targetAlias: string;
  sourceId: string;
  sourceAlias: string;
  amountSats: number;
  budgetPpm: number;
  feeSats: number | null;
  costPpm: number | null;
  ok: boolean;
  error?: string;
  /** When the payment was sent: its fee belongs to the budget day it was
   *  sent on (one still in flight at midnight, or one that ended after a
   *  restart). Absent on records from before it was kept: `at`. */
  startedAt?: string;
  /** The payment's hash (a paid refill, or one that ended after we stopped
   *  waiting): a payment is booked once, whatever restarts in between. */
  paymentId?: string;
  /** The target channel's lifetime "sent" counter (LND) just before the
   *  refill: the fee engine retires the refilled sats as they route out
   *  (first in, first out — feeRecommend.ts refillLots). */
  targetSentBefore?: number;
  /** What the profit gate valued this refill at (ppm): while its sats are
   *  still in the channel, the fee engine keeps the fee at least there — the
   *  price the refill was paid for (review a2: the gate valued refills at
   *  the drained channel's fee, then the engine cut it after the refill). */
  holdPpm?: number;
}

/** Successful rebalances are kept this long — the accounting trail (P&L, the
 *  daily budget, refill lots) must not lose a fee to a count cap. */
export const SUCCESS_KEEP_DAYS = 400;
/** …and at most this many (a bound on the file, far above real use). */
const SUCCESS_LIMIT = 10_000;
/** Failed attempts: only the latest — they cost nothing and carry no lot. */
const FAILURE_LIMIT = 200;
const DAY_MS = 86_400_000;

/** The UTC day a record's fee counts against (the daily budget). */
export const budgetDayOf = (r: Pick<RebalanceRecord, "at" | "startedAt">): string => (r.startedAt ?? r.at).slice(0, 10);

/**
 * Log of executed rebalances — the accounting trail. Before, one list of 200
 * records held failures and successes alike: a burst of failed attempts
 * pushed paid fees out of P&L (which asked for 500), the profit floor and
 * the daily budget. Successes are now kept SUCCESS_KEEP_DAYS, failures only
 * the latest FAILURE_LIMIT; newest first, in one file.
 */
export class RebalanceLog {
  private readonly store: JsonStore<RebalanceRecord[]>;
  private records: RebalanceRecord[];

  constructor(dataDir: string) {
    this.store = new JsonStore<RebalanceRecord[]>(dataDir, "rebalances.json");
    const read = this.store.read([]);
    this.records = Array.isArray(read) ? read : [];
  }

  append(rec: RebalanceRecord): void {
    this.records.unshift(rec);
    this.trim();
    this.store.write(this.records);
  }

  private trim(nowMs = Date.now()): void {
    const cutoff = nowMs - SUCCESS_KEEP_DAYS * DAY_MS;
    let ok = 0;
    let failed = 0;
    this.records = this.records.filter((r) => {
      if (!r.ok) return ++failed <= FAILURE_LIMIT;
      const at = Date.parse(r.at);
      return (!Number.isFinite(at) || at >= cutoff) && ++ok <= SUCCESS_LIMIT;
    });
  }

  /** Whether a payment is booked already (by its hash). */
  hasPayment(paymentId: string): boolean {
    return this.records.some((r) => r.paymentId === paymentId);
  }

  /** When the latest refill into `targetId` — paid or failed — was booked
   *  (it ended then), or null. */
  lastInto(targetId: string): string | null {
    let latest: string | null = null;
    for (const r of this.records) {
      if (r.targetId === targetId && (latest === null || Date.parse(r.at) > Date.parse(latest))) latest = r.at;
    }
    return latest;
  }

  /** The newest `n` records, failures included (the Rebalance tab's list). */
  recent(n = 50): RebalanceRecord[] {
    return this.records.slice(0, n);
  }

  /** Every successful rebalance written since `sinceMs` (all kept, when
   *  absent), newest first — what was really paid. */
  successes(sinceMs = -Infinity): RebalanceRecord[] {
    return this.records.filter((r) => r.ok && !(Date.parse(r.at) < sinceMs));
  }

  /** Totals over the stored window — what rebalancing has cost so far. */
  summary() {
    const ok = this.records.filter((r) => r.ok);
    const totalFeeSats = ok.reduce((sum, r) => sum + (r.feeSats ?? 0), 0);
    const totalAmountSats = ok.reduce((sum, r) => sum + r.amountSats, 0);
    return {
      count: ok.length,
      failed: this.records.length - ok.length,
      totalFeeSats,
      totalAmountSats,
      avgCostPpm: totalAmountSats > 0 ? Math.round((totalFeeSats / totalAmountSats) * 1_000_000) : 0,
    };
  }
}
