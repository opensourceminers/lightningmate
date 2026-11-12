import { JsonStore } from "../store.js";
import type { Reservation } from "./capital.js";
import { MAGMA_LEASE_MARGIN_BLOCKS, leaseCapFrom, type LeaseCap, type SoldLease } from "./leaseCaps.js";

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
 *        → held (the buyer's payment is held by our HODL invoice — only when
 *          the buyer pays that invoice before the channel: see below)
 *        → opening (open started — written before the open)
 *        → funded (funding outpoint — written right after the open)
 *        → reported (Amboss took the funding transaction)
 *        → settled (Amboss confirmed the channel; payment claimed, sale booked)
 *   or, at any point: cancelled (our invoice cancelled — a payment it held
 *                     goes back), rejected (we declined the order), failed
 *                     (ended without anything of ours left to release).
 *
 * Where the buyer's money is (the first live sale, 2026-11-11): a buyer on
 * Magma pays AMBOSS when the order is placed, and Amboss pays our HODL
 * invoice only once the channel has its confirmations. Such an order goes
 * accepted → opening → funded → reported with our invoice still unpaid
 * (`ambossHoldsAt` says so), the payment arrives in "funded"/"reported"
 * (`heldAt`, `heldUntilHeight`), and it never passes through "held". The
 * other way, in Amboss's documentation — the buyer pays our invoice right
 * after the accept — goes accepted → held → opening as before.
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

/** What an order the lane turned down was refused for: the operator's caps
 *  (max channel size, deploy cap), the wallet (not enough on-chain capital),
 *  or anything else — an unreachable buyer, an asset or a fee Amboss didn't
 *  report, an accept Amboss kept refusing, a deadline. Only the first two are
 *  helped by raising the caps or funding the wallet. */
export type RefusalKind = "cap" | "capital" | "other";

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
  /** What Amboss answered the last accept sent, when it answered the request
   *  itself with an error (a business rule, a 4xx, a query it rejects) — not
   *  an outage, not a lost answer. The next pass that reads the order as
   *  still awaiting approval takes it as a refusal (MagmaDesk.resumeAccept).
   *  Gone once the accept is released or confirmed. */
  acceptRefused?: string;
  /** The buyer's channels with this node (open and pending outpoints) when
   *  the order was accepted. A channel to the buyer that is not among them
   *  and belongs to no other sale is this order's — opened by hand or with
   *  another tool while the order waited — and no second one is opened for
   *  it (MagmaDesk.channelAlreadyThere). Absent on records from before it
   *  was kept. */
  preExistingAtAccept?: string[];
  /** When the lane first found the order waiting for its channel with our
   *  invoice still unpaid: the buyer paid Amboss when the order was placed,
   *  and Amboss pays our invoice after the channel is confirmed. The channel
   *  is opened without a payment held here (MagmaDesk.fulfil). */
  ambossHoldsAt?: string;
  /** When our invoice came to hold the payment — before the open (the phase
   *  is then "held"), or after it, in "funded"/"reported". */
  heldAt?: string;
  /** Lowest CLTV expiry height of the held HTLCs (cancel before it). */
  heldUntilHeight?: number | null;
  openAttempts: number;
  /** Written BEFORE the open: when it started and which channels to the
   *  buyer already existed, so a crash mid-open can be told apart. `unclear`
   *  is the error of an open whose outcome LND left open (a dropped stream,
   *  a timeout): the entry waits in "opening" until LND shows the channel or
   *  has had ample time to. */
  opening?: {
    startedAt: string;
    preExisting: string[];
    unclear?: string;
    /** The phase the open started from, and goes back to if it turns out
     *  never to have happened: "held", or "accepted" for an order whose
     *  payment Amboss holds (absent on older records: "held"). */
    from?: "accepted" | "held";
  };
  fundingOutpoint?: string;
  fundedAt?: string;
  reportAttempts: number;
  reportSentAt?: string;
  reportedAt?: string;
  settledAt?: string;
  /** Earnings booked + service fee enqueued (exactly once). */
  bookedAt?: string;
  /** Settled without a booking: no invoice of ours held or settled the
   *  payment (accepted with another tool's invoice) — nothing to book as
   *  income, no service fee. The Orders tab says "not booked", never
   *  "payment settled". */
  unbooked?: boolean;
  /** Ended here without LightningMate taking it on: accepted outside
   *  LightningMate (no invoice of ours — Amboss showed it past approval
   *  while this node had only seen it), or an order of another node of the
   *  same Amboss account. Nothing of it is booked, charged or opened here. */
  external?: "accepted_elsewhere" | "other_node";
  cancelledAt?: string;
  /** Why the order ended the way it did (reject/cancel/fail), or why the lane
   *  is not acting on it (skip). Shown in the UI. */
  reason?: string;
  /** A rejected order: what it was refused for (RefusalKind). Absent on
   *  records from before it was kept. */
  refusalKind?: RefusalKind;
  /** The lane's latest decision about this order, with its reason. `kind`
   *  "parts": a skip because its fee parts aren't an offer price — the
   *  order is the operator's to decide (MagmaDesk.partsLeftToYou). */
  decision?: { at: string; action: string; reason: string; kind?: "parts" };
  lastStatus?: string;
  lastStatusAt?: string;
  /** Amboss's deadline for the current phase, as last seen. */
  timeout?: string | null;
  /** The `timeout` Amboss showed while the order awaited our approval: the
   *  approval deadline. Kept apart because `timeout` is overwritten by every
   *  read — a `timeout` still equal to this one after the accept is that
   *  deadline left in the field, not a deadline for opening the channel
   *  (MagmaDesk.openDeadline). */
  approvalDeadline?: string;
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
  /** Such an order ended "failed" with no channel opened: the buyer's
   *  payment is settled here and nothing gives it back — the operator's to
   *  put right (MagmaDesk.paymentsKept; “Open channel” tries again). */
  paymentKeptAt?: string;
  /** The operator dismissed the alert about this order being turned down. */
  alertAckAt?: string;
  /** Lease over and channel closed by the autopilot (sellAutoClose). */
  closedAt?: string;
  closeTxid?: string;
  /** Since when Amboss has reported this order's channel confirmed while the
   *  invoice of ours it was accepted with is unpaid (MagmaDesk.settle): the
   *  normal wait of an order whose buyer paid Amboss — Amboss pays after the
   *  confirmation — and, when it goes on for long, an alert
   *  (MagmaDesk.paymentsOverdue). */
  unpaidSince?: string;
  /** A lease-end close the buyer's node refused for its fee in the first
   *  round: the shutdown is out and LND goes on with it — not a failure, and
   *  not asked again each run (MagmaDesk.closeFinishedLeases; CHAN-5). */
  closeAskedAt?: string;
  /** Short event trail (newest last, bounded). */
  events: { at: string; what: string }[];
  /** What Amboss answered about this order, as it came (newest last,
   *  bounded): each accept, reject and funding report — "success: true",
   *  "success: false", or the error with its HTTP status and GraphQL code —
   *  and each read of the order whose answer differs from the one before
   *  (status, timeout, payment status, channel, transaction, confirmations,
   *  fees). Never the key, never an invoice. What Amboss does at each step
   *  of a sale has only ever been simulated (review 2026-11-10, lane.md
   *  section 2): this is where the first live sale shows it. */
  amboss?: AmbossAnswer[];
}

/** One answer of Amboss's about an order (MagmaJournalEntry.amboss). */
export interface AmbossAnswer {
  at: string;
  op: "read" | "accept" | "reject" | "report";
  answer: string;
}

const EVENTS_KEPT = 30;
/** Amboss's answers kept on an order's record (MagmaJournal.answered), and
 *  the most of one answer that is kept. */
export const ANSWERS_KEPT = 24;
export const ANSWER_MAX_CHARS = 400;
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

  /** Keep what Amboss answered about an entry's order (in memory; saved
   *  with the next write). A read's answer is kept only when it differs
   *  from the last read on record: the lane reads every order on every pass.
   *  `first`: the read a record was made from, in the pass that made it —
   *  kept before what that pass sent, at the record's own time. */
  answered(entry: MagmaJournalEntry, op: AmbossAnswer["op"], answer: string, first = false): void {
    const kept = (entry.amboss ??= []);
    const text = answer.length > ANSWER_MAX_CHARS ? `${answer.slice(0, ANSWER_MAX_CHARS)}…` : answer;
    if (op === "read" && !first) {
      const last = [...kept].reverse().find((a) => a.op === "read");
      if (last?.answer === text) return;
    }
    if (first) kept.unshift({ at: entry.createdAt, op, answer: text });
    else kept.push({ at: new Date().toISOString(), op, answer: text });
    // Over the bound, the oldest read goes first: an accept's or a reject's
    // answer is what a sale that went wrong is read from, and an Amboss that
    // answers every other read with an error would push it out.
    while (kept.length > ANSWERS_KEPT) {
      const oldestRead = kept.findIndex((a, i) => a.op === "read" && i < kept.length - 1);
      kept.splice(oldestRead >= 0 ? oldestRead : 0, 1);
    }
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

  /** Orders that hold part of an offer and aren't sold yet: seen waiting for
   *  this node's approval (and not past their deadline), taken on and not
   *  yet settled, or settled and not yet booked — the offer upkeep tops up
   *  and gives back nothing meanwhile. */
  pendingSale(nowMs = Date.now()): MagmaJournalEntry[] {
    return this.entries.filter((e) => {
      if (e.phase === "seen") return !e.timeout || Date.parse(e.timeout) > nowMs;
      if (e.phase === "settled") return !e.bookedAt;
      return !TERMINAL_PHASES.has(e.phase);
    });
  }

  /** The channels this node sold and funded after `sinceMs` (sat): a listing
   *  of sold capital from before can't show them yet. */
  fundedSince(sinceMs: number): number {
    return this.entries
      .filter((e) => (e.phase === "funded" || e.phase === "reported" || e.phase === "settled") && !e.closedAt && !!e.fundedAt && Date.parse(e.fundedAt) > sinceMs)
      .reduce((sum, e) => sum + e.sizeSats, 0);
  }

  /** Orders with something of ours under way: accepted (or being accepted)
   *  and not yet ended — what removing the Amboss key would leave hanging. */
  inFlight(): MagmaJournalEntry[] {
    return this.entries.filter((e) => !TERMINAL_PHASES.has(e.phase) && e.phase !== "seen");
  }

  /** The routing-fee promises of channels this node sold and opened: what the
   *  order locked (promises.locked_*), for its lease. A channel whose order
   *  ended without a sale (cancelled, failed) or whose lease channel was
   *  closed carries none. */
  leaseCaps(): LeaseCap[] {
    return this.entries
      .filter((e) => (e.phase === "funded" || e.phase === "reported" || e.phase === "settled") && !e.closedAt)
      .map((e) =>
        leaseCapFrom({
          fundingOutpoint: e.fundingOutpoint,
          source: "magma",
          orderId: e.orderId,
          feeRateCapPpm: e.feeRateCapPpm,
          baseFeeCapSats: e.baseFeeCapSats,
          leaseBlocks: e.leaseBlocks,
        }),
      )
      .filter((c): c is LeaseCap => c !== null);
  }

  /** Every channel this node sold and opened whose lease may still run —
   *  with or without a fee promise (the rebalancer never pulls from them). */
  soldLeases(): SoldLease[] {
    return this.entries
      .filter((e) => (e.phase === "funded" || e.phase === "reported" || e.phase === "settled") && !e.closedAt && !!e.fundingOutpoint)
      .map((e) => ({
        fundingOutpoint: e.fundingOutpoint as string,
        source: "magma" as const,
        orderId: e.orderId,
        leaseBlocks: e.leaseBlocks && e.leaseBlocks > 0 ? e.leaseBlocks : 4_320,
      }));
  }

  /** Funding outpoints already tied to an order — never adopt one twice. */
  claimedOutpoints(): Set<string> {
    return new Set(this.entries.map((e) => e.fundingOutpoint).filter((o): o is string => !!o));
  }

  /**
   * The oldest ended orders beyond TERMINAL_KEPT are dropped — never a sale
   * whose lease may still be running: its entry is what binds the channel's
   * routing-fee promise (leaseCaps) and claims its outpoint
   * (claimedOutpoints). Before, any terminal entry could go, and on a busy
   * seller (every turned-down order is terminal too) a sold channel's
   * promise could vanish mid-lease — and the fee autopilot then raise its fee
   * past the cap.
   */
  private trim(nowMs = Date.now()): void {
    const terminal = this.entries.filter((e) => TERMINAL_PHASES.has(e.phase) && !leaseMayRun(e, nowMs));
    if (terminal.length <= TERMINAL_KEPT) return;
    const drop = new Set(terminal.slice(TERMINAL_KEPT));
    this.entries = this.entries.filter((e) => !drop.has(e));
  }
}

/** Blocks come every ~10 minutes; a lease's end is estimated with half again
 *  as long, so a run of slow blocks never ends it early. */
const LEASE_MS_PER_BLOCK = 10 * 60_000 * 1.5;

/**
 * A sale whose channel may still be inside its lease: funded, not closed,
 * and not yet past the lease measured generously from the latest moment the
 * funding can have confirmed (the sale settles only once it has). The fee
 * autopilot itself tells the lease's end by block height (leaseCaps.ts);
 * this only decides what may be forgotten.
 */
function leaseMayRun(e: MagmaJournalEntry, nowMs: number): boolean {
  if (e.phase !== "settled" || !e.fundingOutpoint || e.closedAt) return false;
  const blocks = (e.leaseBlocks && e.leaseBlocks > 0 ? e.leaseBlocks : 4_320) + MAGMA_LEASE_MARGIN_BLOCKS;
  const from = Date.parse(e.settledAt ?? e.reportedAt ?? e.fundedAt ?? e.updatedAt);
  return !Number.isFinite(from) || nowMs < from + blocks * LEASE_MS_PER_BLOCK;
}
