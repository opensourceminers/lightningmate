import { JsonStore } from "../store.js";

/**
 * Income trail for completed liquidity sales (Magma and direct LSPS1) — the
 * missing half of P&L. Each record is one fulfilled SELL order: the lease fee
 * the buyer paid us (gross revenue). The service fee owed on it is tracked
 * separately, in the service-fee ledger, because it is paid asynchronously.
 */
export interface SaleRecord {
  at: string;
  via: "manual" | "autopilot" | "lsps1";
  orderId: string;
  /** Lease fee the buyer paid us — our gross revenue, in sats. */
  leaseSats: number;
  /** LEGACY: service fee paid inline, on records written before the
   *  service-fee ledger existed. Newer records omit it; P&L reads paid fees
   *  from the ledger instead. */
  feePaidSats?: number;
}

const LIMIT = 500;

/** Magma sales can be completed by the autopilot or by hand — one order is
 *  one sale whichever path got there first. */
const saleKind = (via: SaleRecord["via"]): "magma" | "lsps1" => (via === "lsps1" ? "lsps1" : "magma");

/** Append-only log of completed sales. */
export class EarningsLog {
  private readonly store: JsonStore<SaleRecord[]>;
  private records: SaleRecord[];

  constructor(dataDir: string) {
    this.store = new JsonStore<SaleRecord[]>(dataDir, "earnings.json");
    this.records = this.store.read([]);
  }

  /**
   * Record a completed sale exactly once. Recovery paths (an LSPS1 restart
   * after a settle, a duplicate completion of a Magma order) may report the
   * same sale again; it must not be counted twice. Returns false if already
   * recorded.
   */
  appendOnce(rec: SaleRecord): boolean {
    const kind = saleKind(rec.via);
    if (this.records.some((r) => r.orderId === rec.orderId && saleKind(r.via) === kind)) return false;
    this.records.unshift(rec);
    this.records = this.records.slice(0, LIMIT);
    this.store.write(this.records);
    return true;
  }

  recent(n = LIMIT): SaleRecord[] {
    return this.records.slice(0, n);
  }
}
