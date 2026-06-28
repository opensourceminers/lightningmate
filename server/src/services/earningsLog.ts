import { JsonStore } from "../store.js";

/**
 * Income trail for completed Magma liquidity sales — the missing half of P&L.
 * Each record is one fulfilled SELL order: the lease fee the buyer paid us
 * (gross Magma revenue) and the service fee we paid out on it. Persisted so the
 * P&L can show real lease income and net out the fee we actually paid, instead
 * of silently ignoring both.
 */
export interface SaleRecord {
  at: string;
  via: "manual" | "autopilot";
  orderId: string;
  /** Lease fee the buyer paid us — our gross Magma revenue, in sats. */
  leaseSats: number;
  /** Service fee we paid out on this sale (1%); 0 if skipped/disabled/self. */
  feePaidSats: number;
}

const LIMIT = 500;

/** Append-only log of completed Magma sales. */
export class EarningsLog {
  private readonly store: JsonStore<SaleRecord[]>;
  private records: SaleRecord[];

  constructor(dataDir: string) {
    this.store = new JsonStore<SaleRecord[]>(dataDir, "earnings.json");
    this.records = this.store.read([]);
  }

  append(rec: SaleRecord): void {
    this.records.unshift(rec);
    this.records = this.records.slice(0, LIMIT);
    this.store.write(this.records);
  }

  recent(n = LIMIT): SaleRecord[] {
    return this.records.slice(0, n);
  }
}
