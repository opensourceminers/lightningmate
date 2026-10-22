import { JsonStore, recordStoreIncident } from "../store.js";

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

/** Successful rebalances are kept one by one this long … */
export const SUCCESS_KEEP_DAYS = 400;
/** …and at most this many (a bound on the file, far above real use). Older
 *  ones are not dropped: they are summed per day (RebalanceTotals). */
export const SUCCESS_LIMIT = 10_000;
/** Failed attempts: only the latest — they cost nothing and carry no lot. */
const FAILURE_LIMIT = 200;
const DAY_MS = 86_400_000;

/** The UTC day a record's fee counts against (the daily budget). */
export const budgetDayOf = (r: Pick<RebalanceRecord, "at" | "startedAt">): string => (r.startedAt ?? r.at).slice(0, 10);

export interface RebalanceDayTotal {
  feeSats: number;
  amountSats: number;
  count: number;
}

/**
 * Successful rebalances too old (or too many) to keep one by one, summed per
 * UTC day and target channel — the accounting trail never loses a fee (review
 * a5-analytics:rebalance-cost-truncated, a8-engineering:pnl-accounting-
 * truncated: P&L offers 90 days, a year and "All", and the 200-record log it
 * read lost every older fee).
 */
interface RebalanceTotals {
  /** The earliest time this log has a record of (ISO): what it covers.
   *  Null: nothing logged yet. */
  trackedSince: string | null;
  /** Every success that ended before this (ms) is in `days` — and only
   *  those: a record still on file from before it (the process stopped
   *  between the two saves) is not counted a second time. */
  throughMs: number | null;
  /** day (YYYY-MM-DD, UTC) → target channel → totals. */
  days: Record<string, Record<string, RebalanceDayTotal>>;
}

/** One day's sum for one target channel (successes no longer kept one by one). */
export interface RebalanceDaySum extends RebalanceDayTotal {
  /** The UTC day (YYYY-MM-DD) the fees count on. */
  day: string;
  targetId: string;
}

/** What rebalancing cost over a window, from the log. */
export interface LogCosts {
  feeSats: number;
  amountSats: number;
  count: number;
  /** By target channel. */
  perTarget: Map<string, RebalanceDayTotal>;
}

const emptyTotals = (): RebalanceTotals => ({ trackedSince: null, throughMs: null, days: {} });

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A sum's count or amount as kept: a finite number ≥ 0 — numeric text is
 *  read as the number it says — else null. */
function sumField(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The daily sums as rebalance-totals.json holds them, each checked (final
 * review of P6: they were taken as they came — a JSON-valid but malformed
 * entry, a day of `null` or a channel's sum of text, made P&L throw or add
 * up strings). Kept: a YYYY-MM-DD day of channel sums, each with numbers ≥ 0
 * (numeric text read as numbers — repaired). Anything else is dropped, and
 * said: `problems` names what was dropped or repaired.
 */
export function checkedDays(raw: unknown): { days: Record<string, Record<string, RebalanceDayTotal>>; problems: string[] } {
  const days: Record<string, Record<string, RebalanceDayTotal>> = {};
  const problems: string[] = [];
  if (raw === undefined) return { days, problems };
  if (!isObject(raw)) return { days, problems: ["the daily sums were not a list of days — dropped"] };
  for (const [day, byTarget] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || !isObject(byTarget)) {
      problems.push(`${JSON.stringify(day).slice(0, 40)}: not a day of channel sums — dropped`);
      continue;
    }
    for (const [target, t] of Object.entries(byTarget)) {
      const feeSats = isObject(t) ? sumField(t.feeSats) : null;
      const amountSats = isObject(t) ? sumField(t.amountSats) : null;
      const count = isObject(t) ? sumField(t.count) : null;
      if (!isObject(t) || feeSats === null || amountSats === null || count === null) {
        problems.push(`${day} ${target.slice(0, 40)}: not a sum of fees, amounts and a count — dropped`);
        continue;
      }
      if (t.feeSats !== feeSats || t.amountSats !== amountSats || t.count !== count) problems.push(`${day} ${target.slice(0, 40)}: numbers stored as text — read as numbers`);
      (days[day] ??= {})[target] = { feeSats, amountSats, count };
    }
  }
  return { days, problems };
}

/**
 * Log of executed rebalances — the accounting trail. Before, one list of 200
 * records held failures and successes alike: a burst of failed attempts
 * pushed paid fees out of P&L (which asked for 500), the profit floor and
 * the daily budget. Successes are kept one by one for SUCCESS_KEEP_DAYS (at
 * most SUCCESS_LIMIT), then summed per day and channel — never dropped;
 * failures only the latest FAILURE_LIMIT. Records newest first, in one file;
 * the daily sums in another.
 */
export class RebalanceLog {
  private readonly store: JsonStore<RebalanceRecord[]>;
  private readonly totalsStore: JsonStore<RebalanceTotals>;
  private records: RebalanceRecord[];
  private totals: RebalanceTotals;

  constructor(dataDir: string) {
    this.store = new JsonStore<RebalanceRecord[]>(dataDir, "rebalances.json");
    this.totalsStore = new JsonStore<RebalanceTotals>(dataDir, "rebalance-totals.json");
    const read = this.store.read([]);
    this.records = Array.isArray(read) ? read : [];
    const totals = this.totalsStore.read(emptyTotals());
    const checked = checkedDays(totals.days);
    this.totals = {
      trackedSince: typeof totals.trackedSince === "string" ? totals.trackedSince : null,
      throughMs: typeof totals.throughMs === "number" && Number.isFinite(totals.throughMs) ? totals.throughMs : null,
      days: checked.days,
    };
    if (checked.problems.length > 0) {
      // Never silently (D18): the operator learns P&L's older totals were
      // repaired or lost something. Saved repaired, so it is said once.
      const shown = checked.problems.slice(0, 5).join("; ") + (checked.problems.length > 5 ? `; and ${checked.problems.length - 5} more` : "");
      console.warn(`[rebalance] rebalance-totals.json: ${shown}`);
      // (alerts.ts words it: repaired or dropped, P&L's older costs maybe lower.)
      recordStoreIncident(dataDir, { file: "rebalance-totals.json", kind: "adjusted", detail: shown });
      this.totalsStore.write(this.totals);
    }
    // A success already in the daily sums but still on file (the process
    // stopped between the two saves) is counted there only.
    const through = this.totals.throughMs;
    if (through !== null) this.records = this.records.filter((r) => !(r.ok && Date.parse(r.at) < through));
    // A log from before the daily sums existed (0.7.x kept 200 records of
    // both kinds): it covers from its oldest record on — said once, and kept,
    // since that record will leave the file one day.
    if (this.totals.trackedSince === null && this.records.length > 0) {
      this.totals.trackedSince = this.oldestRecordAt();
      if (this.totals.trackedSince) this.totalsStore.write(this.totals);
    }
  }

  append(rec: RebalanceRecord): void {
    const startedAt = rec.startedAt ?? rec.at;
    if (this.totals.trackedSince === null || Date.parse(startedAt) < Date.parse(this.totals.trackedSince)) {
      this.totals.trackedSince = startedAt;
      this.totalsStore.write(this.totals);
    }
    // Booked late for a day already summed (a payment that ended long after
    // it was sent): straight into the sums, never lost.
    const at = Date.parse(rec.at);
    if (rec.ok && this.totals.throughMs !== null && Number.isFinite(at) && at < this.totals.throughMs) {
      this.addToTotals([rec]);
      this.totalsStore.write(this.totals);
      return;
    }
    this.records.unshift(rec);
    this.trim();
    this.store.write(this.records);
  }

  private oldestRecordAt(): string | null {
    let oldest: number | null = null;
    for (const r of this.records) {
      const t = Date.parse(r.startedAt ?? r.at);
      if (Number.isFinite(t) && (oldest === null || t < oldest)) oldest = t;
    }
    return oldest === null ? null : new Date(oldest).toISOString();
  }

  private addToTotals(recs: RebalanceRecord[]): void {
    for (const r of recs) {
      const day = (this.totals.days[budgetDayOf(r)] ??= {});
      const t = (day[r.targetId] ??= { feeSats: 0, amountSats: 0, count: 0 });
      t.feeSats += r.feeSats ?? 0;
      t.amountSats += r.amountSats;
      t.count += 1;
    }
  }

  /**
   * Keep the latest FAILURE_LIMIT failures, and the successes of the last
   * SUCCESS_KEEP_DAYS (at most SUCCESS_LIMIT) one by one; older successes go
   * into the daily sums. The sums are saved FIRST, with how far they reach:
   * a stop before the log's own save leaves those records on file, and they
   * are dropped then — never counted twice. If the sums can't be saved, the
   * records stay as they are.
   */
  private trim(nowMs = Date.now()): void {
    const okAt = this.records
      .filter((r) => r.ok)
      .map((r) => Date.parse(r.at))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a);
    let through = nowMs - SUCCESS_KEEP_DAYS * DAY_MS;
    // Beyond the count limit, the oldest go too (ties at the limit stay).
    if (okAt.length > SUCCESS_LIMIT) through = Math.max(through, okAt[SUCCESS_LIMIT - 1]);
    const already = this.totals.throughMs ?? -Infinity;
    const newWatermark = Math.max(already, through);
    const old = (r: RebalanceRecord) => {
      const t = Date.parse(r.at);
      return r.ok && Number.isFinite(t) && t < newWatermark;
    };
    const toAdd = this.records.filter((r) => old(r) && Date.parse(r.at) >= already);
    if (toAdd.length > 0 || newWatermark !== already) {
      if (toAdd.length > 0) {
        const saved = structuredClone(this.totals);
        this.addToTotals(toAdd);
        this.totals.throughMs = newWatermark;
        if (!this.totalsStore.write(this.totals)) {
          this.totals = saved; // nothing summed: keep the records as they are
          this.trimFailures();
          return;
        }
      }
    }
    this.records = this.records.filter((r) => !old(r));
    this.trimFailures();
  }

  private trimFailures(): void {
    let failed = 0;
    this.records = this.records.filter((r) => r.ok || ++failed <= FAILURE_LIMIT);
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

  /** Every successful rebalance on file one by one, written since `sinceMs`
   *  (all, when absent), newest first — what was really paid. Older ones are
   *  in the daily sums only (costsSince). */
  successes(sinceMs = -Infinity): RebalanceRecord[] {
    return this.records.filter((r) => r.ok && !(Date.parse(r.at) < sinceMs));
  }

  /** What this log has a record of from when on (null: nothing yet). */
  trackedSince(): string | null {
    return this.totals.trackedSince ?? this.oldestRecordAt();
  }

  /** From when on every success is on file one by one (before it, only the
   *  daily sums): null while nothing has been summed. */
  detailSinceMs(): number | null {
    return this.totals.throughMs;
  }

  /**
   * The daily sums of the days from `sinceMs` on, oldest first: the
   * successes no longer kept one by one (older than SUCCESS_KEEP_DAYS, or
   * past SUCCESS_LIMIT). A day counts whole once any of it is in the window.
   */
  dailySums(sinceMs = -Infinity): RebalanceDaySum[] {
    const fromDay = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString().slice(0, 10) : "";
    const out: RebalanceDaySum[] = [];
    for (const [day, byTarget] of Object.entries(this.totals.days)) {
      if (day < fromDay) continue;
      for (const [targetId, t] of Object.entries(byTarget)) out.push({ day, targetId, feeSats: t.feeSats, amountSats: t.amountSats, count: t.count });
    }
    return out.sort((a, b) => a.day.localeCompare(b.day) || a.targetId.localeCompare(b.targetId));
  }

  /**
   * What rebalancing cost since `sinceMs`, from the records and the daily
   * sums — every fee ever paid through LightningMate, however old. A day
   * summed counts whole once any of it is in the window (only days older
   * than SUCCESS_KEEP_DAYS are summed).
   */
  costsSince(sinceMs = -Infinity): LogCosts {
    const perTarget = new Map<string, RebalanceDayTotal>();
    const add = (target: string, feeSats: number, amountSats: number, count: number) => {
      const t = perTarget.get(target) ?? { feeSats: 0, amountSats: 0, count: 0 };
      t.feeSats += feeSats;
      t.amountSats += amountSats;
      t.count += count;
      perTarget.set(target, t);
    };
    for (const r of this.successes(sinceMs)) add(r.targetId, r.feeSats ?? 0, r.amountSats, 1);
    for (const d of this.dailySums(sinceMs)) add(d.targetId, d.feeSats, d.amountSats, d.count);
    let feeSats = 0;
    let amountSats = 0;
    let count = 0;
    for (const t of perTarget.values()) {
      feeSats += t.feeSats;
      amountSats += t.amountSats;
      count += t.count;
    }
    return { feeSats, amountSats, count, perTarget };
  }

  /** Totals over the last `windowDays` — what rebalancing cost lately (the
   *  window is part of the answer: the Rebalance tab says what it covers). */
  summary(windowDays = 30, nowMs = Date.now()) {
    const since = nowMs - windowDays * DAY_MS;
    const inWindow = (r: RebalanceRecord) => !(Date.parse(r.at) < since);
    const ok = this.records.filter((r) => r.ok && inWindow(r));
    const totalFeeSats = ok.reduce((sum, r) => sum + (r.feeSats ?? 0), 0);
    const totalAmountSats = ok.reduce((sum, r) => sum + r.amountSats, 0);
    return {
      windowDays,
      count: ok.length,
      failed: this.records.filter((r) => !r.ok && inWindow(r)).length,
      totalFeeSats,
      totalAmountSats,
      avgCostPpm: totalAmountSats > 0 ? Math.round((totalFeeSats / totalAmountSats) * 1_000_000) : 0,
    };
  }
}
