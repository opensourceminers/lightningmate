import { existsSync } from "node:fs";
import { join } from "node:path";
import { JsonStore } from "../store.js";

/**
 * Every fee change that reached LND, in its own log (D15) — what the fee
 * outcomes (Analytics) and the elasticity learner measure.
 *
 * Both used to read the run history: 50 runs shared with rebalances, channel
 * opens, Magma, max_htlc and LSPS1 entries, and the Analytics view only its
 * newest 20. A change must be a week old before its effect can be measured,
 * so on a node whose history turned over in a day or two nothing was ever
 * measurable — and a change whose neighbours had already dropped out of the
 * list looked "clean" when it was not. Here only applied fee writes are kept
 * (the autopilot's, the lease-promise keeper's and manual ones), for a year:
 * skips, deferrals and other stages can never push one out.
 */

export interface FeeChangeRecord {
  at: string;
  channelId: string;
  alias: string;
  /** The fee before it — null: not known (LND's fee couldn't be read before
   *  a manual apply); never recorded as 0, which read as a raise from 0. */
  fromPpm: number | null;
  toPpm: number;
  /** Base fee before and after, msat (null: not known — records imported
   *  from the run history). */
  fromBaseMsat: number | null;
  toBaseMsat: number | null;
  /** Who made it: the fee autopilot, the lease-promise keeper (D7), or a
   *  manual apply/pin from the UI. */
  via: "autopilot" | "lease" | "manual";
  /** The engine's main reason, as the run history shows it. */
  why?: string;
  /** It applied a pin (an override "fixed"): the operator's fee, as one set
   *  by hand is — the step-back never takes it back. */
  pinned?: boolean;
}

const FILE = "fee-changes.json";

/** Long enough for any outcome window (a change is measured up to 60 days
 *  back, against the fortnight before it) with room to spare. */
export const FEE_LOG_KEEP_DAYS = 400;
/** A ceiling on the file: a 50-channel node changing every channel daily
 *  still keeps months. */
export const FEE_LOG_MAX_RECORDS = 10_000;

export class FeeChangeLog {
  private readonly store: JsonStore<FeeChangeRecord[]>;
  private records: FeeChangeRecord[];
  /** The log did not exist yet when this process started (see seed). */
  readonly fresh: boolean;

  constructor(dataDir: string) {
    const file = join(dataDir, FILE);
    this.fresh = !existsSync(file) && !existsSync(`${file}.bak`);
    this.store = new JsonStore<FeeChangeRecord[]>(dataDir, FILE, { compact: true });
    this.records = this.store.read([]).filter(isRecord);
  }

  /** Record applied changes (newest first in the file). Saved at once: a
   *  change that reached LND must not be forgotten by a crash. */
  append(recs: FeeChangeRecord[]): void {
    if (recs.length === 0) return;
    this.records = [...[...recs].reverse(), ...this.records];
    this.trim();
    this.store.write(this.records);
  }

  /**
   * One-shot import for an install upgrading to this log: the fee changes
   * still in the run history, so what was already measurable stays so. Only
   * when the log did not exist (never twice, never over real records).
   */
  seed(recs: FeeChangeRecord[]): void {
    if (!this.fresh || this.records.length > 0) return;
    this.records = [...recs].sort((a, b) => b.at.localeCompare(a.at));
    this.trim();
    this.store.write(this.records);
  }

  /** Every record kept, newest first. */
  all(): FeeChangeRecord[] {
    return [...this.records];
  }

  private trim(nowMs = Date.now()): void {
    const cutoff = nowMs - FEE_LOG_KEEP_DAYS * 86_400_000;
    this.records = this.records.filter((r) => Date.parse(r.at) >= cutoff).slice(0, FEE_LOG_MAX_RECORDS);
  }
}

function isRecord(r: unknown): r is FeeChangeRecord {
  const o = r as Partial<FeeChangeRecord> | null;
  return (
    !!o &&
    typeof o.at === "string" &&
    typeof o.channelId === "string" &&
    (typeof o.fromPpm === "number" || o.fromPpm === null) &&
    typeof o.toPpm === "number"
  );
}
