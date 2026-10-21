import { JsonStore } from "../store.js";
import type { Reservation } from "./capital.js";

/**
 * The per-order journal of Magma sales: what this node has done for each order,
 * saved BEFORE the next external action (Amboss call, invoice, channel open,
 * settle), so a crash, a timeout or a restart at any point leaves a record
 * that says exactly what may already have happened.
 *
 * Before this, whether an order was done was decided only from Amboss's status.
 * A channel opened whose report to Amboss failed left no trace, and the next
 * poll opened a second channel for the same order. Now:
 *
 *   seen → accepting (preimage saved, then invoice, then accept) → accepted
 *        → held (the buyer's payment is held by our HODL invoice)
 *        → opening (open started — written before the open)
 *        → funded (funding outpoint — written right after the open)
 *        → reported (Amboss took the funding transaction)
 *        → settled (Amboss confirmed the channel; payment claimed, sale booked)
 *   or, at any point: cancelled (held payment released — buyer refunded),
 *                     rejected (we declined the order), failed (ended without
 *                     anything of ours left to release).
 *
 * An entry with a funding outpoint is never opened again; an "opening" entry
 * without one is first reconciled with LND (magmaDesk.ts).
 */

export type MagmaPhase =
  | "seen"
  | "accepting"
  | "accepted"
  | "held"
  | "opening"
  | "funded"
  | "reported"
  | "settled"
  | "cancelled"
  | "rejected"
  | "failed";

export const TERMINAL_PHASES: ReadonlySet<MagmaPhase> = new Set(["settled", "cancelled", "rejected", "failed"]);

/** Phases whose order still needs coins from the wallet: accepted (or being
 *  accepted) but not yet funded. */
const RESERVING_PHASES: ReadonlySet<MagmaPhase> = new Set(["accepting", "accepted", "held", "opening"]);

export interface MagmaJournalEntry {
  orderId: string;
  phase: MagmaPhase;
  /** Who took the order on: the autopilot's lane, or a click in the UI.
   *  "legacy" = found waiting for its channel with no record here: accepted
   *  before this journal existed (plain invoice), or with another tool. */
  via: "autopilot" | "manual" | "legacy";
  createdAt: string;
  updatedAt: string;
  buyerPubkey: string;
  sizeSats: number;
  isPrivate: boolean;
  /** What we earn — the HODL invoice amount, in millisats (decimal string). */
  feeMsat: string;
  /** Lease terms locked into the order (promises), for the fee autopilot. */
  leaseBlocks: number | null;
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
  /** The HODL invoice. `secret` is saved before the invoice is created. */
  invoice: {
    id: string;
    secret: string;
    request: string | null;
    expiresAt: string;
    cltvDelta: number;
  } | null;
  acceptAttempts: number;
  acceptSentAt?: string;
  heldAt?: string;
  /** Lowest CLTV expiry height of the held HTLCs (cancel before it). */
  heldUntilHeight?: number | null;
  openAttempts: number;
  /** Written BEFORE the open: when it started and which channels to the
   *  buyer already existed, so a crash mid-open can be told apart. `unclear`
   *  is the error of an open whose outcome LND left open (a dropped stream,
   *  a timeout): the entry waits in "opening" until LND shows the channel or
   *  has had ample time to. */
  opening?: { startedAt: string; preExisting: string[]; unclear?: string };
  fundingOutpoint?: string;
  fundedAt?: string;
  reportAttempts: number;
  reportSentAt?: string;
  reportedAt?: string;
  settledAt?: string;
  /** Earnings booked + service fee enqueued (exactly once). */
  bookedAt?: string;
  cancelledAt?: string;
  /** Why the order ended the way it did (reject/cancel/fail), or why the lane
   *  is not acting on it (skip). Shown in the UI. */
  reason?: string;
  /** The lane's latest decision about this order, with its reason. */
  decision?: { at: string; action: string; reason: string };
  lastStatus?: string;
  lastStatusAt?: string;
  /** Amboss's deadline for the current phase, as last seen. */
  timeout?: string | null;
  lastError?: string;
  lastErrorAt?: string;
  /** Consecutive passes in which Amboss refused to show this order although
   *  the key itself was fine — counted only in a pass whose listing of the
   *  orders waiting on us leaves the order out (reset by the next successful
   *  read, and whenever Amboss lists it as waiting on us). */
  refusals?: number;
  /** Consecutive passes in which Amboss answered that it has no such order —
   *  counted only in a pass whose listing leaves the order out (reset by the
   *  next successful read, and whenever Amboss lists it as waiting on us).
   *  Other errors on its read neither count nor reset it. */
  notFound?: number;
  /** For an order found with no record here ("legacy"): the invoice of ours,
   *  settled, that paid for it — what makes it a sale to book. null: LND has
   *  no paid invoice of ours for it (it is fulfilled, but not booked). */
  paidInvoiceId?: string | null;
  /** Lease over and channel closed by the autopilot (sellAutoClose). */
  closedAt?: string;
  closeTxid?: string;
  /** Short event trail (newest last, bounded). */
  events: { at: string; what: string }[];
}

const EVENTS_KEPT = 30;
const TERMINAL_KEPT = 500;

export class MagmaJournal {
  private readonly store: JsonStore<MagmaJournalEntry[]>;
  private entries: MagmaJournalEntry[];

  constructor(dataDir: string) {
    this.store = new JsonStore<MagmaJournalEntry[]>(dataDir, "magma-orders.json");
    this.entries = this.store.read([]).map((e) => ({ ...e, events: Array.isArray(e.events) ? e.events : [] }));
  }

  get(orderId: string): MagmaJournalEntry | undefined {
    return this.entries.find((e) => e.orderId === orderId);
  }

  all(): MagmaJournalEntry[] {
    return [...this.entries];
  }

  /** Orders this node still has something to do (or to release) for. */
  open(): MagmaJournalEntry[] {
    return this.entries.filter((e) => !TERMINAL_PHASES.has(e.phase));
  }

  /** A new entry for an order (not yet saved — `commit` or `note` it). */
  create(init: Pick<MagmaJournalEntry, "orderId" | "via" | "buyerPubkey" | "sizeSats" | "isPrivate" | "feeMsat"> &
    Partial<MagmaJournalEntry>): MagmaJournalEntry {
    const now = new Date().toISOString();
    const entry: MagmaJournalEntry = {
      phase: "seen",
      createdAt: now,
      updatedAt: now,
      leaseBlocks: null,
      feeRateCapPpm: null,
      baseFeeCapSats: null,
      invoice: null,
      acceptAttempts: 0,
      openAttempts: 0,
      reportAttempts: 0,
      events: [],
      ...init,
    };
    this.entries.unshift(entry);
    return entry;
  }

  /** Append to an entry's event trail (in memory; saved with the next write). */
  event(entry: MagmaJournalEntry, what: string): void {
    entry.events.push({ at: new Date().toISOString(), what });
    if (entry.events.length > EVENTS_KEPT) entry.events.splice(0, entry.events.length - EVENTS_KEPT);
  }

  /**
   * Save, and THROW if it can't be saved. For the step before an external
   * action: if the journal cannot record that we are about to do something,
   * we must not do it (fail closed). The store raises the failing save as an
   * alert either way.
   */
  commit(entry: MagmaJournalEntry): void {
    entry.updatedAt = new Date().toISOString();
    this.trim();
    this.store.writeOrThrow(this.entries);
  }

  /** Save; never throws (a failure is logged and alerted by the store). For
   *  records after the fact, where the next step re-derives from Amboss/LND. */
  note(entry?: MagmaJournalEntry): boolean {
    if (entry) entry.updatedAt = new Date().toISOString();
    this.trim();
    return this.store.write(this.entries);
  }

  /** Coins promised to buyers whose channel is not funded yet. Each open
   *  will be checked against `reserveSat` (the sell reserve). */
  reservations(reserveSat: number): Reservation[] {
    return this.entries
      .filter((e) => RESERVING_PHASES.has(e.phase))
      .map((e) => ({ key: `magma:${e.orderId}`, sats: e.sizeSats, reserveSat }));
  }

  /** Orders with something of ours under way: accepted (or being accepted)
   *  and not yet ended — what removing the Amboss key would leave hanging. */
  inFlight(): MagmaJournalEntry[] {
    return this.entries.filter((e) => !TERMINAL_PHASES.has(e.phase) && e.phase !== "seen");
  }

  /** Funding outpoints already tied to an order — never adopt one twice. */
  claimedOutpoints(): Set<string> {
    return new Set(this.entries.map((e) => e.fundingOutpoint).filter((o): o is string => !!o));
  }

  private trim(): void {
    const terminal = this.entries.filter((e) => TERMINAL_PHASES.has(e.phase));
    if (terminal.length <= TERMINAL_KEPT) return;
    const drop = new Set(terminal.slice(TERMINAL_KEPT));
    this.entries = this.entries.filter((e) => !drop.has(e));
  }
}
