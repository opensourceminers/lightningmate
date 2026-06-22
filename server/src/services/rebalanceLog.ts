import { JsonStore } from "../store.js";

export interface RebalanceRecord {
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
}

const LIMIT = 200;

/** Append-only log of executed rebalances — the accounting trail. */
export class RebalanceLog {
  private readonly store: JsonStore<RebalanceRecord[]>;
  private records: RebalanceRecord[];

  constructor(dataDir: string) {
    this.store = new JsonStore<RebalanceRecord[]>(dataDir, "rebalances.json");
    this.records = this.store.read([]);
  }

  append(rec: RebalanceRecord): void {
    this.records.unshift(rec);
    this.records = this.records.slice(0, LIMIT);
    this.store.write(this.records);
  }

  recent(n = 50): RebalanceRecord[] {
    return this.records.slice(0, n);
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
