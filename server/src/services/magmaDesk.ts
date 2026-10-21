import { getChannels, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { recordStoreIncident } from "../store.js";
import {
  AmbossError,
  ORDER_FAILED,
  ORDER_SUCCEEDED,
  isAmbossOutage,
  isAuthError,
  isNotFoundAnswer,
  isQueryRejected,
  isRateLimited,
} from "./amboss.js";
import {
  FUNDING_REPORTED_STATUSES,
  LEASE_RUNNING_STATUSES,
  acceptSale,
  addSaleTransaction,
  getSale,
  listSales,
  msatOf,
  rejectSale,
  type SaleOrder,
  type SaleOrderDetail,
  type SalesFilter,
} from "./magmaApi.js";
import { MagmaJournal, TERMINAL_PHASES, type MagmaJournalEntry, type MagmaPhase } from "./magmaJournal.js";
import {
  cancelHodl,
  createHodl,
  findInvoicesByDescription,
  hodlStatus,
  newHodlSecret,
  settleHodl,
  type CreateHodlParams,
  type FoundInvoice,
  type HodlStatus,
} from "./hodl.js";
import { channelsWith, findOpenedChannel, spendableOnchain, type CapitalLedger } from "./capital.js";
import {
  closeChannelByOutpoint,
  couldNotConnect,
  ensureConnected,
  fundChannel,
  isPendingChannelsLimit,
  isPreBroadcastRefusal,
  type OpenChannelParams,
} from "./channelOps.js";
import type { AmbossStore } from "./ambossStore.js";
import type { EarningsLog } from "./earningsLog.js";
import type { ServiceFeeLedger } from "./serviceFee.js";
import { errorText } from "./errorText.js";

/**
 * Magma selling, end to end, on the Magma API — the "order desk".
 *
 * The order LANE (tick, every 45 s from the autopilot) asks Amboss which sales
 * need us (`sales(action_needed: true)`) and walks every order this node has
 * taken on through its journal (magmaJournal.ts):
 *
 *   accept    with a HODL invoice for `fees.seller`, expiring in 49 h; the
 *             preimage is saved before the invoice exists (D2)
 *   held      the buyer's payment is held by that invoice (checked in LND)
 *   open      the channel, under the shared on-chain mutex; "opening" is saved
 *             before the open and the funding outpoint right after (D3)
 *   report    the outpoint to Amboss (add_transaction), retried until Amboss
 *             has it — never a second open
 *   settle    only when Amboss says VALID_CHANNEL_OPENING (or later); then the
 *             sale is booked and its service fee enqueued, once
 *   cancel    the HODL invoice on any failure, so the buyer gets the payment
 *             back automatically — and before the held HTLC would expire
 *   reject    orders this node cannot serve, right away (D6), instead of
 *             letting them time out
 *
 * The lane holds no lock shared with the 30-minute autopilot run: a slow
 * rebalance payment or a slow Amboss call in the main run cannot delay it.
 * What it shares with every other on-chain commitment (LSPS1 opens, routing
 * opens, manual opens) is the capital ledger and its mutex (capital.ts).
 *
 * When Amboss can't be asked — no key, a key Amboss refuses, Amboss down —
 * the lane still does what needs only LND (maintainFromLnd): a held payment
 * is released before its HTLC expires, and an invoice that can no longer be
 * paid ends its order's capital reservation. Nothing waits for the key.
 *
 * Manual actions from the Orders tab (accept, open, reject) go through the
 * same journal, the same per-order serialisation and the same mutex, so a
 * click can never race the lane into a second channel.
 */

/** Amboss: the HODL invoice "must expire in at least 48 hours". */
export const HODL_EXPIRY_MS = 49 * 3_600_000;
/** An invoice is re-used for a repeated accept only while it still has this
 *  much life left (Amboss checks the 48 h at accept time). */
const MIN_INVOICE_LIFE_MS = 48 * 3_600_000 + 5 * 60_000;
/** Blocks a paid HTLC may stay held: room for the open, its confirmations
 *  and Amboss's check (~2 days), well inside a sender's 2016-block limit. */
export const HODL_CLTV_DELTA = 288;
/** Release a held payment this many blocks before its HTLC would expire
 *  (LND itself cancels at 12; we do it earlier, and on the record). */
export const CANCEL_MARGIN_BLOCKS = 24;
/** An open needs the held payment to outlive the cancel margin by the time
 *  the channel takes to confirm and Amboss to validate it (~6 h). With only
 *  the cancel margin, an open at 25 blocks left was followed one block later
 *  by the release of the buyer's payment: a channel delivered for nothing. */
export const OPEN_MIN_BLOCKS_LEFT = CANCEL_MARGIN_BLOCKS + 36;
/** After a crash mid-open (or an open whose outcome LND left unclear): how
 *  long LND gets to show the channel before we conclude it never happened. */
export const OPENING_GRACE_MS = 10 * 60_000;
/** Passes in a row in which Amboss may refuse to show an order (with the key
 *  itself fine), or answer that it has no such order — each time while its
 *  own listing of the orders waiting on us leaves the order out — before an
 *  order with nothing of ours tied to it is dropped. */
const MAX_REFUSALS = 3;
/** Without Amboss, an order paid outside a HODL invoice (accepted before the
 *  journal) keeps its reservation until its open deadline, or this long. */
const LEGACY_HOLD_MS = 48 * 3_600_000;
/** A transient open failure (peer offline, coins not yet confirmed) is
 *  retried on later passes while the channel-open deadline is this far away. */
const OPEN_RETRY_MIN_TIME_LEFT_MS = 10 * 60_000;
/** …or, when Amboss gives no deadline, for this long after the payment. */
const OPEN_RETRY_WINDOW_MS = 30 * 60_000;
const MAX_ACCEPT_ATTEMPTS = 3;
/** Reject (rather than wait) once the approval deadline is this close. */
const REJECT_MARGIN_MS = 2 * 60_000;
/** An order with nothing of ours tied to it that Amboss neither lists nor
 *  shows any more ends here this long after its approval deadline (Amboss has
 *  ended it by then; the slack covers clocks that differ). */
const SEEN_GRACE_MS = 10 * 60_000;
/** …or, with no approval deadline on record, this long after it was first
 *  recorded — far beyond any approval window Amboss gives. */
const SEEN_MAX_AGE_MS = 24 * 3_600_000;
/** A successful report Amboss still hasn't acted on is re-sent after this. */
const REPORT_RESEND_MS = 10 * 60_000;
/** The deployed-capital listing is re-read at most this often. */
const DEPLOYED_TTL_MS = 30_000;

export type SellActionKind =
  | "accept"
  | "reject"
  | "open"
  | "report"
  | "settle"
  | "cancel"
  | "close"
  | "skip"
  | "relist"
  | "reprice"
  | "resize"
  | "enable"
  | "disable"
  | "create"
  | "error";

/** One Magma action as the run history shows it. */
export interface MagmaSellAction {
  orderId: string;
  action: SellActionKind;
  sizeSats: number;
  ok: boolean;
  transactionId?: string;
  error?: string;
}

export interface MagmaDeskConfig {
  sellEnabled: boolean;
  sellMaxChannelSats: number;
  sellMaxDeploySats: number;
  sellReserveSats: number;
}

export interface MagmaDeskDeps {
  dataDir: string;
  readLnd: AuthenticatedLnd;
  writeLnd: AuthenticatedLnd | undefined;
  amboss: AmbossStore;
  capital: CapitalLedger;
  earnings: EarningsLog;
  serviceFees: ServiceFeeLedger;
  config: () => MagmaDeskConfig;
}

/** Outcome of a manual action, for the API route. */
export interface DeskResult {
  ok: boolean;
  /** Why it did not go through — the route maps it to an HTTP status. */
  code?:
    | "no_key"
    | "read_only"
    | "shutting_down"
    | "amboss"
    /** LND did not answer (nothing was changed). */
    | "node"
    | "bad_status"
    | "capital"
    | "unreachable"
    | "not_held"
    | "journal"
    | "open_failed";
  message: string;
  phase?: MagmaPhase;
  outpoint?: string;
  transactionId?: string;
  /** For an opened channel: has Amboss taken the funding transaction yet?
   *  (If not, the order lane keeps reporting it — it is never reopened.) */
  reported?: boolean;
}

/** What this node knows about an order — merged into the Orders view. */
export interface MagmaOrderLocal {
  phase: MagmaPhase;
  via: MagmaJournalEntry["via"];
  updatedAt: string;
  fundingOutpoint: string | null;
  reason: string | null;
  decision: MagmaJournalEntry["decision"] | null;
  lastError: string | null;
}

export interface LaneStatus {
  lastTickAt: string | null;
  /** null: the last pass had nothing to do (see `idle`). */
  ok: boolean | null;
  error: string | null;
  /** Whether the lane's next pass may clear `error` by itself (an outage, a
   *  refused read). False when it can't: Amboss rejects LightningMate's
   *  request as such (only an update of LightningMate fixes that), or there
   *  is no key to ask with. */
  retrying: boolean;
  /** Why the last pass had nothing to do, when it hadn't. */
  idle: string | null;
  running: boolean;
  openOrders: number;
}

/** Readable for LND's array errors too (they used to reach an order's reason
 *  as "503,UnexpectedErrorWhenGettingChainBalance,[object Object]"). */
const msg = errorText;
/** The memo of every invoice this app made for an order — 0.7.x's plain ones
 *  and the HODL ones since. With the order's record lost, it is how LND tells
 *  what was paid for it. */
export const orderMemo = (orderId: string): string => `Magma order ${orderId}`;
const now = (): string => new Date().toISOString();
const feeSatsOf = (e: MagmaJournalEntry): number => Number(BigInt(e.feeMsat || "0") / 1000n);
/** Phases with a funding outpoint on record: never opened again. */
const FUNDED: ReadonlySet<MagmaPhase> = new Set(["funded", "reported", "settled"]);
/** Phases in which the buyer's payment may be held by our invoice. */
const HOLDING: ReadonlySet<MagmaPhase> = new Set(["held", "opening", "funded", "reported"]);
/** The phase as it is NOW (after awaited steps that may have moved it). */
const phaseOf = (e: MagmaJournalEntry): MagmaPhase => e.phase;
/** Open failures worth retrying while there is time. "Too many pending
 *  channels" too: the buyer's LND takes one at a time by default (two orders
 *  from one buyer), and it clears once the earlier channel confirms. */
const TRANSIENT_OPEN = /couldn't connect|offline|not online|disconnect|not enough on-chain capital|insufficient|witness/i;
const isTransientOpen = (error: string): boolean => TRANSIENT_OPEN.test(error) || isPendingChannelsLimit(error);

const NO_KEY =
  "no Amboss key — orders in flight can't be opened, reported or settled; held payments are still released before they expire";
const KEY_REJECTED =
  "Amboss rejects your key — orders in flight can't be opened, reported or settled; held payments are still released before they expire";

/** The lane status when Amboss rejects the lane's request as such (the query
 *  no longer fits the Magma API): not an outage, and not about one order. */
const queryRejectedText = (err: unknown): string =>
  `Amboss rejected LightningMate's request (${msg(err)}) — the Magma API may have changed; ` +
  "orders can't be acted on until LightningMate is updated";

/** One pass of the order lane: how much of Amboss it may still use. */
interface LanePass {
  /** Amboss can't be used for the rest of this pass (no key, a key Amboss
   *  refuses, Amboss unreachable): only the LND-side work runs. */
  lndOnly: boolean;
  /** Why — the lane's status says so. */
  reason: string | null;
  /** The key check was asked once this pass already. */
  rechecked: boolean;
  /** A problem with Amboss's answers that isn't an outage — Amboss rejecting
   *  the lane's own request — for the lane's status (the pass goes on). */
  problem: string | null;
  /** The orders this pass's listing shows waiting on us, as listed (null: no
   *  listing this pass). An order in it exists, whatever a read of it
   *  answered — and the listing says enough to turn it down. */
  listed: ReadonlyMap<string, SaleOrder> | null;
  /** What Amboss answered for each order it would not show this pass, the
   *  pass going on with the others — for the lane's status. */
  unread: string[];
  /** Order reads this pass that failed the way they do when Amboss is down:
   *  no answer in time, no connection, a server error at the HTTP level. The
   *  first may be about that one order alone (a resolver slow for it) and the
   *  pass goes on; a second makes the rest of the pass LND-only. */
  outages: number;
  /** What each order the lane could not decide on this pass ran into — a
   *  check before the accept that could not be made — for the lane's status. */
  undecided: string[];
  /** Amboss's listing of your sold capital (the deploy cap's share) failed in
   *  this pass: not asked again for every further new order (each time up to
   *  its deadline) — those orders wait for the next pass, or are rejected. */
  deployedFailure: { err: unknown } | null;
}

/** The lane's status when Amboss would not show some orders (not an outage:
 *  the pass went on with the others, and the next one asks again). */
const unreadText = (unread: string[]): string =>
  `could not read ${unread.length === 1 ? "1 order" : `${unread.length} orders`} from Amboss (${unread[0]})`;

/** The lane's status when it could not decide on some new orders (a check
 *  before the accept could not be made; the next pass tries again). */
const undecidedText = (undecided: string[]): string =>
  `could not decide ${undecided.length === 1 ? "1 order" : `${undecided.length} orders`} (${undecided[0]})`;

/** What a capital check before an accept ran into: Amboss's listing of your
 *  sold capital (the deploy cap's share — the check's only Amboss call), or
 *  LND (the wallet, the channels). Amboss's bare "Internal server error" on
 *  an order's record said neither. */
const capitalCheckFailed = (err: unknown): string =>
  err instanceof AmbossError
    ? `could not read your sold capital from Amboss: ${msg(err)}`
    : `LND did not answer the capital check: ${msg(err)}`;

export class MagmaDesk {
  readonly journal: MagmaJournal;
  private laneBusy = false;
  private stopping = false;
  private active = 0;
  private readonly orderChains = new Map<string, Promise<void>>();
  private lane: Omit<LaneStatus, "running" | "openOrders"> = { lastTickAt: null, ok: null, error: null, retrying: false, idle: null };
  /** Magma capital in sold channels with a running lease (and orders accepted
   *  outside this journal), from the last listing — the deploy-cap share. */
  private deployed = { sats: 0, at: 0 };
  /** Funding txids of finished leases, learned once per process. */
  private readonly finishedTxids = new Map<string, string | null>();
  /** Orders whose last read Amboss refused or failed, whatever the failure
   *  (this process). The lane walks them after every other order: a read
   *  that hangs every pass (a resolver slow for one order) then costs one
   *  deadline at the end of each pass, and never anyone's turn. And the run
   *  history gets one line when an order becomes unreadable, not one per
   *  pass — Amboss's answer may differ each time, and the autopilot drops
   *  only identical repeats; the order's record keeps the latest. */
  private readonly unreadOrders = new Set<string>();

  constructor(private readonly deps: MagmaDeskDeps) {
    this.journal = new MagmaJournal(deps.dataDir);
    deps.capital.register("magma", {
      // Each accepted order's open will be checked against the sell reserve.
      reservations: () => this.journal.reservations(deps.config().sellReserveSats),
      deployedSat: () => this.deployed.sats,
      claimedOutpoints: () => this.journal.claimedOutpoints(),
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /** Shutdown: no new step starts; the one under way finishes (waitIdle). */
  stop(): void {
    this.stopping = true;
  }

  isBusy(): boolean {
    return this.laneBusy || this.active > 0;
  }

  async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.isBusy()) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  laneStatus(): LaneStatus {
    return { ...this.lane, running: this.laneBusy, openOrders: this.journal.open().length };
  }

  /** Orders with something of ours under way (accepted, paid, opening, …) —
   *  Settings warns with this before the Amboss key is removed. */
  ordersInFlight(): number {
    return this.journal.inFlight().length;
  }

  localView(orderId: string): MagmaOrderLocal | null {
    const e = this.journal.get(orderId);
    if (!e) return null;
    return {
      phase: e.phase,
      via: e.via,
      updatedAt: e.updatedAt,
      fundingOutpoint: e.fundingOutpoint ?? null,
      reason: e.reason ?? null,
      decision: e.decision ?? null,
      lastError: e.lastError ?? null,
    };
  }

  // ── the lane ───────────────────────────────────────────────────────────────

  /**
   * One pass of the order lane. Cheap when there is nothing to do: with
   * selling off and no order of ours in flight — or without a key and no
   * invoice of ours out — it makes no call at all. Never overlaps itself;
   * never waits for the main autopilot run.
   *
   * Without a usable key (none, or one Amboss refuses) the pass still runs
   * for the orders this node has taken on, on LND alone: before, it returned
   * at once, so a held payment ran into its HTLC expiry and the order's coins
   * stayed reserved — blocking routing opens, LSPS1 and the offer — until a
   * key came back.
   */
  async tick(): Promise<MagmaSellAction[]> {
    const { writeLnd, amboss } = this.deps;
    if (this.laneBusy || this.stopping || !writeLnd) return [];
    const cfg = this.deps.config();
    const mine = this.journal.open();
    const keyed = amboss.hasKey();
    // Nothing to do — and the status says so. Before, it kept the last busy
    // pass's: after an outage, "Amboss unreachable … retrying" stayed on
    // screen for good once selling was switched off, with nothing retrying.
    if (!keyed && !mine.some((e) => e.invoice || e.phase !== "seen")) {
      return this.idle("no Amboss key, and no order of yours in flight");
    }
    if (!cfg.sellEnabled && mine.length === 0) {
      return this.idle("Liquidity provision is off, and no order of yours is in flight");
    }
    this.laneBusy = true;
    const pass: LanePass = {
      lndOnly: !keyed,
      reason: keyed ? null : NO_KEY,
      rechecked: false,
      problem: null,
      listed: null,
      unread: [],
      outages: 0,
      undecided: [],
      deployedFailure: null,
    };
    const out: MagmaSellAction[] = [];
    let listError: { text: string; retrying: boolean } | null = null;
    try {
      if (keyed && amboss.getValidity() === false) {
        // Amboss refused this key before: ask again (the check is cached for
        // a few minutes), and until it says yes, do only what LND can do.
        await amboss.checkValidity();
        if (amboss.getValidity() === false) this.lndOnlyFor(pass, KEY_REJECTED);
      }
      // Orders waiting on us — only with selling on. In manual mode the lane
      // only carries the orders already taken on (journal) to their end: a
      // held payment must always end settled or refunded.
      let actionable: SaleOrder[] = [];
      if (!pass.lndOnly && cfg.sellEnabled) {
        try {
          actionable = (await this.ambossSales(amboss.getKey(), { actionNeeded: true })).orders;
          pass.listed = new Map(actionable.map((o) => [o.id, o]));
          amboss.markValid();
        } catch (err) {
          // No new orders this pass; the ones in flight are still carried on —
          // with Amboss, unless it is down: a listing that failed inside a
          // GraphQL answer (a 500 of its resolver) is that request's error,
          // not a reason to stop opening, reporting and settling.
          listError = isQueryRejected(err)
            ? { text: queryRejectedText(err), retrying: false }
            : { text: `could not list your sales on Amboss: ${msg(err)}`, retrying: true };
          if (isAuthError(err)) await this.keyStillValid(pass);
          else if (isAmbossOutage(err)) this.lndOnlyFor(pass, `Amboss unreachable (${msg(err)}) — held payments are still watched in LND`);
        }
      }
      // An order this node has finished with (rejected, cancelled, failed,
      // settled) has nothing left to do here, whatever Amboss still lists —
      // unless it ended "failed" with nothing of ours tied to it while Amboss
      // waits for our approval after all (revive).
      const fresh = actionable.filter((o) => {
        const e = this.journal.get(o.id);
        return !e || !TERMINAL_PHASES.has(e.phase) || this.revive(e, o.status);
      });
      const ids = this.walkOrder(mine, fresh);
      for (const id of ids) {
        if (this.stopping) break;
        out.push(...(await this.withOrder(id, () => this.advance(id, pass))));
      }
      // Orders the lane no longer walks (ended, or no longer listed) are
      // forgotten as unreadable too.
      const walked = new Set(ids);
      for (const id of this.unreadOrders) if (!walked.has(id)) this.unreadOrders.delete(id);
      // What the status reports, and whether the next pass may clear it. A
      // request Amboss rejects as such fails the same way every pass until
      // LightningMate is updated: the Orders tab must not say "retrying".
      // Orders Amboss would not show, and new orders the lane could not
      // decide on, are reported too (never silently).
      const leftOver = [
        pass.unread.length > 0 ? unreadText(pass.unread) : null,
        pass.undecided.length > 0 ? undecidedText(pass.undecided) : null,
      ].filter((t): t is string => t !== null);
      const problem: { text: string; retrying: boolean } | null = pass.lndOnly
        ? { text: pass.reason ?? "Amboss can't be asked", retrying: pass.reason !== NO_KEY }
        : (listError ??
          (pass.problem !== null ? { text: pass.problem, retrying: false } : null) ??
          (leftOver.length > 0 ? { text: leftOver.join("; "), retrying: true } : null));
      this.lane = { lastTickAt: now(), ok: problem === null, error: problem?.text ?? null, retrying: problem?.retrying ?? false, idle: null };
    } catch (err) {
      this.lane = { lastTickAt: now(), ok: false, error: msg(err), retrying: true, idle: null };
      console.warn(`[magma] order lane: ${msg(err)}`);
    } finally {
      this.laneBusy = false;
    }
    return out;
  }

  /**
   * The order in which a pass walks the orders:
   *  1. orders with something of ours at stake — an invoice out, a payment
   *     held, a channel being opened, reported or settled: their turn must
   *     never depend on a decision about a new order;
   *  2. then orders still to be decided (journal first, then new ones);
   *  3. and, after all of these, every order whose last read failed (any
   *     failure — a timeout too), at stake or not.
   * A read that hangs costs its whole deadline. Before, the order whose read
   * hung every pass came first in every pass whenever it was the newest one
   * at stake — and as that failure counted as "Amboss down", every order
   * after it was left to LND alone, pass after pass: an older paid order was
   * never opened, a confirmed channel never settled (its payment released
   * unclaimed near expiry), new orders never decided. Walked last, it can't
   * hold up anyone. (The sort is stable: journal order — newest first —
   * within each group.)
   */
  private walkOrder(mine: MagmaJournalEntry[], fresh: SaleOrder[]): string[] {
    const ids = [...new Set([...mine.map((e) => e.orderId), ...fresh.map((o) => o.id)])];
    const rank = (id: string): number => {
      const e = this.journal.get(id);
      const atStake = e !== undefined && e.phase !== "seen";
      return (this.unreadOrders.has(id) ? 2 : 0) + (atStake ? 0 : 1);
    };
    return ids
      .map((id, i) => ({ id, i, r: rank(id) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.id);
  }

  /**
   * An order this node ended as "failed" with nothing of ours tied to it (no
   * invoice, no channel) that Amboss shows waiting for our approval after
   * all: it is not over — back to "seen", to be decided (by the lane, or by a
   * click). An order is only ended so when Amboss's listing leaves it out;
   * should one ever be ended while Amboss still waits on us, this keeps it
   * from timing out on us (the seller-score hit D6 exists to prevent) with
   * the Orders tab hiding its Accept and Reject. True: revived.
   */
  private revive(entry: MagmaJournalEntry | undefined, status: string): boolean {
    if (!entry || entry.phase !== "failed" || entry.invoice || entry.fundingOutpoint) return false;
    if (status !== "WAITING_FOR_SELLER_APPROVAL") return false;
    entry.phase = "seen";
    entry.reason = undefined;
    entry.refusals = undefined;
    entry.notFound = undefined;
    this.journal.event(entry, "Amboss shows it waiting for your approval after all — to be decided again");
    this.journal.note(entry);
    return true;
  }

  /** A pass with nothing to do: no call made, and the status says why. */
  private idle(why: string): MagmaSellAction[] {
    this.lane = { lastTickAt: now(), ok: null, error: null, retrying: false, idle: why };
    return [];
  }

  private lndOnlyFor(pass: LanePass, reason: string): void {
    if (pass.lndOnly) return;
    pass.lndOnly = true;
    pass.reason = reason;
  }

  /**
   * Amboss refused a call. A refusal can be about one resource, so the key
   * check decides (asked at most once per pass): a refused key turns the rest
   * of the pass to LND-only work; a fine key makes it this order's problem
   * alone, and the other orders go on.
   */
  private async keyStillValid(pass: LanePass): Promise<boolean> {
    if (!pass.rechecked) {
      pass.rechecked = true;
      await this.deps.amboss.recheckAfterRefusal();
    }
    if (this.deps.amboss.getValidity() === false) {
      this.lndOnlyFor(pass, KEY_REJECTED);
      return false;
    }
    return true;
  }

  /** Move one order as far as it can go now. Errors stay with the order. */
  private async advance(id: string, pass: LanePass): Promise<MagmaSellAction[]> {
    const cfg = this.deps.config();
    let entry = this.journal.get(id);
    if (pass.lndOnly) return entry ? this.maintainFromLnd(entry) : [];
    let order: SaleOrderDetail;
    try {
      order = await this.ambossSale(this.deps.amboss.getKey(), id);
    } catch (err) {
      return this.unreadable(id, entry, err, pass);
    }
    this.unreadOrders.delete(id);
    if (entry) {
      entry.lastStatus = order.status;
      entry.lastStatusAt = now();
      entry.timeout = order.timeout;
      entry.refusals = undefined;
      entry.notFound = undefined;
    }
    const out: MagmaSellAction[] = [];
    try {
      if (ORDER_FAILED.has(order.status)) {
        if (entry && !TERMINAL_PHASES.has(entry.phase)) {
          // Ended after we funded it (say, the report came too late): the
          // buyer is refunded either way, and the channel stays ours to close.
          const channel = entry.fundingOutpoint ? ` — the channel ${entry.fundingOutpoint} stays open; close it if you don't want it` : "";
          out.push(...(await this.release(entry, `Amboss ended the order: ${order.status}${channel}`)));
        }
        return out;
      }
      if (ORDER_SUCCEEDED.has(order.status)) {
        if (entry && !TERMINAL_PHASES.has(entry.phase)) out.push(...(await this.settle(entry, order)));
        return out;
      }
      switch (order.status) {
        case "WAITING_FOR_SELLER_APPROVAL":
          if (entry?.phase === "accepting") out.push(...(await this.resumeAccept(entry, order, pass)));
          else if ((!entry || entry.phase === "seen") && cfg.sellEnabled) out.push(...(await this.decide(order, pass)));
          break;
        case "WAITING_FOR_BUYER_PAYMENT":
          if (entry?.phase === "accepting") this.toPhase(entry, "accepted", "Amboss shows the order accepted");
          if (entry?.phase === "accepted") out.push(...(await this.checkHeld(entry)));
          break;
        case "WAITING_FOR_CHANNEL_OPEN":
          if (!entry) {
            if (!cfg.sellEnabled) break;
            entry = await this.adoptLegacy(order);
            // A held payment released for good (its record was lost): on
            // the run history too, not only on the order.
            if (entry.phase === "cancelled") {
              out.push({ orderId: id, action: "cancel", sizeSats: entry.sizeSats, ok: true, error: entry.reason });
            }
          }
          if (!TERMINAL_PHASES.has(entry.phase)) {
            out.push(...(await this.fulfil(entry, order, { auto: entry.via === "autopilot" || cfg.sellEnabled })));
          }
          break;
        default:
          // SELLER_SENT_TRANSACTION … SELLER_OPENED_CHANNEL: Amboss has our
          // funding transaction (a report whose answer we lost ends up here).
          if (entry && FUNDING_REPORTED_STATUSES.has(order.status)) {
            if (entry.phase === "opening") await this.reconcileOpening(entry);
            if (entry.phase === "funded") {
              entry.reportedAt = now();
              this.toPhase(entry, "reported", `Amboss has the funding transaction (${order.status})`);
            }
            // Amboss sees the transaction but no confirmation yet. LND
            // rebroadcasts its own funding transactions; if LND no longer
            // knows this one at all, a human must look — opening again
            // would be a second channel for the same order.
            if (order.status === "SELLER_SENT_TRANSACTION" && entry.phase === "reported" && entry.fundingOutpoint) {
              const known = (await channelsWith(this.deps.readLnd, entry.buyerPubkey)).some((c) => c.outpoint === entry!.fundingOutpoint);
              if (!known) this.noteError(entry, `LND no longer knows the funding transaction ${entry.fundingOutpoint} (dropped from the mempool?) — check this channel`);
            }
          }
          break;
      }
      if (entry && !TERMINAL_PHASES.has(entry.phase)) out.push(...(await this.cancelIfExpiring(entry)));
    } catch (err) {
      // The entry as it is now: deciding on a new order creates it.
      entry ??= this.journal.get(id);
      if (isAuthError(err) && !(await this.keyStillValid(pass))) {
        // The key itself is refused now: what LND alone can do still happens.
        this.noteError(entry, `Amboss refused the key (${msg(err)})`);
        if (entry) out.push(...(await this.maintainFromLnd(entry)));
        return out;
      }
      if (isQueryRejected(err)) pass.problem ??= queryRejectedText(err);
      // Anything else (LND not answering, Amboss refusing one step) is this
      // order's error for now; the next pass tries again from the record.
      this.noteError(entry, msg(err));
      out.push({ orderId: id, action: "error", sizeSats: order.sizeSats, ok: false, error: msg(err) });
    }
    return out;
  }

  /** Amboss would not show us this order. */
  private async unreadable(
    id: string,
    entry: MagmaJournalEntry | undefined,
    err: unknown,
    pass: LanePass,
  ): Promise<MagmaSellAction[]> {
    // Listed as waiting on us in this very pass: the order exists, and it is
    // ours to decide — whatever its read answered.
    const listed = pass.listed?.get(id) ?? null;
    if (isAuthError(err)) {
      if (!(await this.keyStillValid(pass))) return entry ? this.maintainFromLnd(entry) : [];
      // The key works — Amboss refuses this one order. Before, this aborted
      // the whole pass, every pass: one such order blocked every other order
      // for good. One taken on under another account's key, say, isn't
      // listed as waiting on us either: with nothing of ours tied to it, it
      // is dropped after a few refusals in a row. A refusal counts toward
      // that only against a listing this pass HAS, one that leaves the order
      // out. One Amboss lists is never dropped on a refusal (an edge's 403, a
      // hiccup in Amboss's guard) — and without a listing (selling off, or
      // the listing refused or failed too: Amboss's guard sits in front of
      // both) nothing tells the two apart, so nothing is counted. Before,
      // three such passes ended an order still waiting for approval: never
      // accepted nor rejected — not even by hand ("already failed here") —
      // it timed out on us. An unlisted one still ends once its approval
      // deadline is long past (couldNotRead).
      if (entry) {
        if (listed) entry.refusals = undefined;
        else if (pass.listed !== null) entry.refusals = (entry.refusals ?? 0) + 1;
        if (!entry.invoice && entry.phase === "seen" && (entry.refusals ?? 0) >= MAX_REFUSALS) {
          entry.reason = `Amboss refuses to show this order to your key (${msg(err)}) — nothing of ours is tied to it`;
          this.toPhase(entry, "failed", entry.reason);
          return [];
        }
      }
      return this.couldNotRead(id, entry, listed, `Amboss refused to show this order (${msg(err)})`, msg(err), pass);
    }
    if (isAmbossOutage(err)) {
      // Amboss may be down — unreachable, too slow, failing at the HTTP level
      // — or only this order's read failing that way (a resolver slow for
      // one order runs into the deadline, a proxy fails one request) while
      // the listing and every other read answer. One such failure is this
      // order's own: the pass goes on with the others, and the order is
      // walked last from now on (walkOrder). A second one in the same pass,
      // or a rate limit (it holds for every call), means Amboss as a whole:
      // the other reads would only fail too, each up to its deadline — the
      // rest of the pass goes on with LND alone. Before, the first one did
      // that: a read that hung every pass left every order after it to LND
      // alone, pass after pass, under "Amboss unreachable".
      pass.outages += 1;
      if (isRateLimited(err) || pass.outages > 1) {
        this.lndOnlyFor(pass, `Amboss unreachable (${msg(err)}) — held payments are still watched in LND`);
        const error = `could not read the order from Amboss: ${msg(err)}`;
        this.noteError(entry, error);
        const out = this.unreadLine(id, entry?.sizeSats ?? listed?.sizeSats ?? 0, error);
        // Amboss unreadable is no reason to let a held HTLC run into expiry,
        // nor to keep an unpaid invoice past its end: LND's answers suffice.
        return entry ? [...out, ...(await this.maintainFromLnd(entry))] : out;
      }
      return this.couldNotRead(id, entry, listed, `could not read the order from Amboss: ${msg(err)}`, msg(err), pass);
    }
    // Amboss rejected the query itself (its API changed): says nothing about
    // this order — and the lane's status must say what is wrong.
    if (isQueryRejected(err)) pass.problem ??= queryRejectedText(err);
    if (entry && isNotFoundAnswer(err) && this.goneFromAmboss(entry, err, pass)) return [];
    // Anything else says nothing about the order: a resolver that failed
    // ("Unexpected error.", or a 500 it reports inside its answer), a
    // rejected query. It stays where it is, and the next pass decides.
    // (Before, ANY GraphQL error here ended a "seen" order for good: one
    // hiccup on Amboss's side, and an order still waiting for approval was
    // never accepted nor rejected — it timed out on us, the seller-score hit
    // D6 exists to prevent.)
    return this.couldNotRead(id, entry, listed, `could not read the order from Amboss: ${msg(err)}`, msg(err), pass);
  }

  /**
   * An order Amboss would not show this pass, for a reason of its own — or
   * as the first read of the pass to fail as if Amboss were down (see
   * unreadable): the pass goes on with the other orders. Never silently:
   *  - the error is on the order's record, in the run history (once, when
   *    the order becomes unreadable) and in the lane's status;
   *  - a new order Amboss lists as waiting for our approval gets a record
   *    ("seen", from the listing), so the Orders tab shows it, and why;
   *  - once its approval deadline is close, it is rejected — a reject needs
   *    only the order's id — rather than left to time out on us (D6);
   *  - whatever LND alone can do for it still happens.
   * Before, a new order whose read kept failing left no trace at all — no
   * record, no history line, a lane reporting "ok" — and timed out.
   * `detail` is Amboss's answer, for the lane's status and the reasons.
   */
  private async couldNotRead(
    id: string,
    found: MagmaJournalEntry | undefined,
    listed: SaleOrder | null,
    error: string,
    detail: string,
    pass: LanePass,
  ): Promise<MagmaSellAction[]> {
    let entry = found;
    // Waiting for our decision, with nothing of ours tied to it yet.
    const undecided = listed?.status === "WAITING_FOR_SELLER_APPROVAL" && (!entry || (entry.phase === "seen" && !entry.invoice));
    if (listed && undecided) entry ??= this.seenFromListing(listed);
    if (entry && !listed && this.pastApproval(entry)) {
      // Not listed as waiting on us (or no listing to tell), long past its
      // approval deadline, still unreadable: Amboss has ended it, and nothing
      // of ours is tied to it. It ends here too — rather than being asked
      // about, and reported unreadable, for good. (Should Amboss list it
      // waiting for approval after all, it is revived.)
      entry.reason = entry.timeout
        ? `its approval deadline passed while Amboss would not show it (${detail}) — nothing of ours is tied to it`
        : `recorded over a day ago with no approval deadline, and Amboss would not show it (${detail}) — nothing of ours is tied to it`;
      this.toPhase(entry, "failed", entry.reason);
      return [];
    }
    this.noteError(entry, error);
    if (listed && undecided && entry && this.deps.config().sellEnabled && this.nearDeadline(listed, REJECT_MARGIN_MS) && !this.deadlinePassed(listed)) {
      const rejected = await this.rejectUnread(entry, detail, pass);
      if (phaseOf(entry) === "rejected") return rejected;
      // The reject didn't go through either: still unread, and still ours.
      pass.unread.push(detail);
      return [...this.unreadLine(id, entry.sizeSats, error), ...rejected];
    }
    pass.unread.push(detail);
    const out = this.unreadLine(id, entry?.sizeSats ?? listed?.sizeSats ?? 0, error);
    if (entry) out.push(...(await this.maintainFromLnd(entry)));
    return out;
  }

  /** An order whose read failed: one run-history line when it becomes
   *  unreadable, none on the passes after (see unreadOrders). */
  private unreadLine(id: string, sizeSats: number, error: string): MagmaSellAction[] {
    if (this.unreadOrders.has(id)) return [];
    this.unreadOrders.add(id);
    return [{ orderId: id, action: "error", sizeSats, ok: false, error }];
  }

  /** A record for an order known only from the listing (its read failed). */
  private seenFromListing(o: SaleOrder): MagmaJournalEntry {
    const entry = this.journal.create({
      orderId: o.id,
      via: "autopilot",
      buyerPubkey: o.buyerPubkey,
      sizeSats: o.sizeSats,
      isPrivate: o.isPrivate,
      feeMsat: String(this.invoiceMsat(o)),
      lastStatus: o.status,
      lastStatusAt: now(),
      timeout: o.timeout,
    });
    this.journal.event(entry, "listed by Amboss as waiting for your approval");
    return entry;
  }

  /** Turn down an order Amboss would not show, before its approval deadline.
   *  rejectOrder leaves a refused key, and a request Amboss rejects as such,
   *  to the pass (it throws them): dealt with here, as this order's error. */
  private async rejectUnread(entry: MagmaJournalEntry, detail: string, pass: LanePass): Promise<MagmaSellAction[]> {
    const reason = `Amboss would not show this order (${detail}) — rejected rather than left to time out`;
    try {
      return await this.rejectOrder(entry, reason);
    } catch (err) {
      if (isAuthError(err)) await this.keyStillValid(pass);
      else if (isQueryRejected(err)) pass.problem ??= queryRejectedText(err);
      this.noteError(entry, `Amboss would not show this order (${detail}), and rejecting it failed: ${msg(err)}`);
      return [{ orderId: entry.orderId, action: "reject", sizeSats: entry.sizeSats, ok: false, error: entry.lastError }];
    }
  }

  /** A "seen" order (nothing of ours tied to it) long past its approval
   *  deadline — or, with no deadline on record (every read of it failed, say,
   *  since a click recorded it), a day old: otherwise it would be asked about
   *  for good, a refused one with a forced key check every pass. */
  private pastApproval(entry: MagmaJournalEntry): boolean {
    if (entry.phase !== "seen" || entry.invoice) return false;
    const deadline = entry.timeout ? Date.parse(entry.timeout) : NaN;
    const end = Number.isFinite(deadline) ? deadline + SEEN_GRACE_MS : Date.parse(entry.createdAt) + SEEN_MAX_AGE_MS;
    return end < Date.now();
  }

  /**
   * Amboss answered that it has no such order. Taken at its word only when it
   * says so MAX_REFUSALS passes in a row, each time while its own listing of
   * the orders waiting on us, fetched in that pass, leaves the order out — and
   * only for an order with nothing of ours tied to it ("seen", no invoice:
   * nothing held, nothing payable, nothing reserved). A pass without a
   * listing (selling off, or the listing failed) has nothing to check the
   * answer against and counts nothing, as for a refusal: such an order ends
   * once its approval deadline is long past (couldNotRead). An order with an
   * invoice of ours is never dropped on Amboss's word: its payment may be
   * held, and LND alone carries it to its end (maintainFromLnd). True: the
   * order ended here.
   */
  private goneFromAmboss(entry: MagmaJournalEntry, err: unknown, pass: LanePass): boolean {
    if (pass.listed === null) return false;
    if (pass.listed.has(entry.orderId)) {
      // Listed as waiting on us in this very pass: Amboss knows it.
      entry.notFound = undefined;
      return false;
    }
    entry.notFound = (entry.notFound ?? 0) + 1;
    if (entry.invoice || entry.phase !== "seen" || entry.notFound < MAX_REFUSALS) return false;
    entry.reason = `Amboss no longer knows this order (${msg(err)} — ${entry.notFound} times in a row); nothing of ours is tied to it`;
    this.toPhase(entry, "failed", entry.reason);
    return true;
  }

  /**
   * What an order needs from LND alone — whenever Amboss can't be asked
   * about it (no key, a key Amboss refuses, Amboss down, an order Amboss
   * won't show):
   *  - a held payment is released before its HTLC would expire (D2);
   *  - an invoice LND has cancelled, lost, or that expired unpaid ends the
   *    order (and with it the coins reserved for it);
   *  - an interrupted open is looked for in LND;
   *  - an order paid outside a HODL invoice (accepted before the journal)
   *    gives its reservation up once its open deadline has passed.
   * Opening, reporting and settling need Amboss and wait for it.
   */
  private async maintainFromLnd(entry: MagmaJournalEntry): Promise<MagmaSellAction[]> {
    if (TERMINAL_PHASES.has(entry.phase) || entry.phase === "seen") return [];
    try {
      if (entry.phase === "opening") await this.reconcileOpening(entry);
      const inv = entry.invoice;
      if (!inv) return this.endLegacyPastDeadline(entry);
      const st = await this.lndHodlStatus(inv.id);
      if (entry.phase === "accepting" && (st.state === "missing" || st.state === "canceled")) {
        // No invoice the buyer could pay: nothing of ours is out there. The
        // order goes back to "seen" (its reservation ends); with Amboss back,
        // the lane decides on it afresh.
        entry.phase = "seen";
        entry.invoice = null;
        this.journal.event(entry, `its invoice is ${st.state} in LND — nothing was offered; the reservation ends`);
        this.journal.note(entry);
        return [];
      }
      if (st.state === "missing" || st.state === "canceled") {
        return this.release(entry, `its invoice was ${st.state === "missing" ? "not found" : "cancelled or expired"} in LND before the sale completed`);
      }
      if (st.state === "open") {
        return Date.parse(inv.expiresAt) <= Date.now() ? this.release(entry, "its invoice expired before the buyer paid") : [];
      }
      if (st.state === "settled") return this.checkHeld(entry); // only we settle: recover the record
      // Held. The buyer paid — record it, and release it in time.
      if ((entry.phase === "accepting" || entry.phase === "accepted") && st.heldMtokens >= BigInt(entry.feeMsat || "0")) {
        entry.heldAt = now();
        entry.heldUntilHeight = st.heldUntilHeight;
        this.toPhase(entry, "held", `buyer's payment held (${feeSatsOf(entry)} sat)`);
      } else if (st.heldUntilHeight !== null) {
        entry.heldUntilHeight = st.heldUntilHeight;
      }
      return this.cancelIfExpiring(entry);
    } catch (err) {
      this.noteError(entry, `could not check the order in LND: ${msg(err)}`);
      return [];
    }
  }

  /** An order paid through a plain invoice (accepted before this journal)
   *  has no HODL invoice to release. While Amboss can't be asked, it keeps
   *  its coins reserved only until its open deadline (as last seen) — past
   *  that, Amboss has ended it either way. */
  private endLegacyPastDeadline(entry: MagmaJournalEntry): MagmaSellAction[] {
    if (entry.phase !== "held") return [];
    const deadline = entry.timeout
      ? Date.parse(entry.timeout)
      : Date.parse(entry.heldAt ?? entry.createdAt) + LEGACY_HOLD_MS;
    if (!(deadline < Date.now())) return [];
    entry.reason = "its channel-open deadline passed while Amboss could not be asked — the coins reserved for it are free again";
    this.toPhase(entry, "failed", entry.reason);
    return [];
  }

  // ── deciding on a new order (D6) ───────────────────────────────────────────

  /** The HODL invoice amount: what the seller earns. `fees.seller` can read 0
   *  before Amboss has settled it; its parts (fixed + variable) are the
   *  seller's fee too — the buyer pays those plus Amboss's own fee. */
  private invoiceMsat(order: SaleOrder): bigint {
    const seller = msatOf(order.fees.seller) ?? 0n;
    if (seller > 0n) return seller;
    return (msatOf(order.fees.fixed) ?? 0n) + (msatOf(order.fees.variable) ?? 0n);
  }

  private nearDeadline(order: SaleOrder, marginMs: number): boolean {
    return order.timeout !== null && Date.parse(order.timeout) - Date.now() <= marginMs;
  }

  private deadlinePassed(order: SaleOrder): boolean {
    return order.timeout !== null && Date.parse(order.timeout) <= Date.now();
  }

  /**
   * Can a channel of `sizeSats` be funded (and, with `caps`, is it within the
   * autopilot's limits)? Null when yes, else the reason. `exceptKey` is this
   * order's own reservation, which must not count against itself. The same
   * check runs at accept and at open. Every accepted order reserves its size
   * AND what its open will need on top (its funding fee, its step of LND's
   * anchor reserve, the sell reserve — capital.ts), so an order accepted now
   * still passes this check when its own open comes, after the others.
   */
  private async capitalFor(
    sizeSats: number,
    opts: {
      caps: boolean;
      exceptKey?: string;
      /** false inside the mutex: no Amboss call there */
      refresh?: boolean;
      /** The lane pass asking: a listing of your sold capital that failed in
       *  it is not asked again (see refreshDeployedFor). */
      pass?: LanePass | null;
    },
  ): Promise<string | null> {
    const cfg = this.deps.config();
    if (opts.caps && sizeSats > cfg.sellMaxChannelSats) {
      return `above your max channel size (${fmt(sizeSats)} > ${fmt(cfg.sellMaxChannelSats)} sat)`;
    }
    // The wallet before the deploy cap: LND is local and quick, and an order
    // the wallet can't fund is turned down at once — whatever Amboss's
    // listing of your sold capital answers below, or fails to.
    const sp = await spendableOnchain(this.deps.readLnd, this.deps.capital, cfg.sellReserveSats, { exceptKey: opts.exceptKey });
    if (sp.spendableSat < sizeSats) {
      const n = sp.reserve.pendingOpens;
      const fees = n > 0 ? `the funding fees of this and ${n} promised open${n === 1 ? "" : "s"}` : "the funding fee";
      return (
        `not enough on-chain capital: ${fmt(sp.spendableSat)} sat spendable after a ${fmt(sp.reserve.totalSat)} sat ` +
        `reserve (incl. LND's anchor reserve and ${fees}) and ${fmt(sp.reservedSat)} sat promised to other orders`
      );
    }
    if (opts.caps) {
      if (opts.refresh !== false) await this.refreshDeployedFor(opts.pass ?? null);
      const committed = this.deps.capital.deployedSat() + this.deps.capital.reservedSat(opts.exceptKey);
      if (committed + sizeSats > cfg.sellMaxDeploySats) {
        return `deploy cap reached (${fmt(committed)} sat already sold or promised, cap ${fmt(cfg.sellMaxDeploySats)} sat)`;
      }
    }
    return null;
  }

  /** The deploy cap's share from Amboss, for a decision in a lane pass. A
   *  listing that failed is not asked again in the same pass: before, every
   *  further new order fetched it afresh — on a timeout, 15 s each. */
  private async refreshDeployedFor(pass: LanePass | null): Promise<void> {
    if (pass?.deployedFailure) throw pass.deployedFailure.err;
    try {
      await this.refreshDeployed();
    } catch (err) {
      if (pass) pass.deployedFailure = { err };
      throw err;
    }
  }

  /**
   * A check before the accept could not be made (Amboss's listing of your
   * sold capital, LND's wallet or channels, the invoice): nothing was promised
   * and nothing created — the order is still to be decided. Never silently:
   * its error is on its record (saying what failed), in the lane's status and
   * in the run history, and the next pass decides afresh. Once its approval
   * deadline is close, it is rejected instead (rejectUndecided). Before, such
   * an order sat "seen" with Amboss's bare "Internal server error" on record,
   * under a lane reporting "ok", until it timed out on us.
   */
  private async undecided(entry: MagmaJournalEntry, order: SaleOrder, what: string, pass: LanePass): Promise<MagmaSellAction[]> {
    const rejected = await this.rejectUndecided(entry, order, what, pass);
    if (rejected) return rejected;
    this.noteError(entry, what);
    pass.undecided.push(what);
    return [{ orderId: entry.orderId, action: "error", sizeSats: entry.sizeSats, ok: false, error: what }];
  }

  /** An order the lane can't decide on, with its approval deadline close:
   *  rejected — a reject needs only its id — rather than left to time out on
   *  us (D6). Null: there is time, and the next pass tries again (or the
   *  deadline has passed already: Amboss has ended the order, and could only
   *  refuse a reject). */
  private async rejectUndecided(
    entry: MagmaJournalEntry,
    order: SaleOrder,
    what: string,
    pass: LanePass,
  ): Promise<MagmaSellAction[] | null> {
    if (!this.nearDeadline(order, REJECT_MARGIN_MS) || this.deadlinePassed(order)) return null;
    const out = await this.rejectOrder(entry, `could not decide on it in time: ${what} — rejected rather than left to time out`);
    if (phaseOf(entry) !== "rejected") pass.undecided.push(what);
    return out;
  }

  /** The lane's decision on an order waiting for approval: accept, or reject
   *  at once when it cannot be served — never let it time out. */
  private async decide(order: SaleOrderDetail, pass: LanePass): Promise<MagmaSellAction[]> {
    const entry =
      this.journal.get(order.id) ??
      this.journal.create({
        orderId: order.id,
        via: "autopilot",
        buyerPubkey: order.buyerPubkey,
        sizeSats: order.sizeSats,
        isPrivate: order.isPrivate,
        feeMsat: String(this.invoiceMsat(order)),
      });
    entry.lastStatus = order.status;
    entry.timeout = order.timeout;
    if (order.timeout !== null && Date.parse(order.timeout) <= Date.now()) {
      return [this.skip(entry, "the approval deadline has passed")];
    }
    if (order.assetType !== "BASE_ASSET") return this.rejectOrder(entry, `not a bitcoin channel (${order.assetType})`);
    if (!/^[0-9a-f]{66}$/i.test(order.buyerPubkey)) return this.rejectOrder(entry, "the order names no valid buyer node");
    if (order.sizeSats <= 0) return this.rejectOrder(entry, "the order has no channel size");
    const fee = this.invoiceMsat(order);
    if (fee <= 0n) {
      if (this.nearDeadline(order, REJECT_MARGIN_MS)) return this.rejectOrder(entry, "Amboss reported no fee for this order");
      return [this.skip(entry, "waiting for Amboss to report the order's fee")];
    }
    // Cheap capital check first: no point dialing a buyer we must turn down.
    let lacking: string | null;
    try {
      lacking = await this.capitalFor(order.sizeSats, { caps: true, exceptKey: `magma:${order.id}`, pass });
    } catch (err) {
      // A key Amboss refuses now: the pass turns to LND alone (advance).
      if (isAuthError(err) && !(await this.keyStillValid(pass))) throw err;
      if (isQueryRejected(err)) pass.problem ??= queryRejectedText(err);
      return this.undecided(entry, order, capitalCheckFailed(err), pass);
    }
    if (lacking) return this.rejectOrder(entry, lacking);
    if (!(await this.connectBuyer(order))) return this.rejectOrder(entry, "the buyer's node is unreachable");
    if (this.stopping) return [this.skip(entry, "shutting down")];
    return this.acceptOrder(entry, order, fee, "autopilot", pass);
  }

  private skip(entry: MagmaJournalEntry, reason: string): MagmaSellAction {
    entry.decision = { at: now(), action: "skip", reason };
    this.journal.note(entry);
    return { orderId: entry.orderId, action: "skip", sizeSats: entry.sizeSats, ok: false, error: reason };
  }

  // ── accept ─────────────────────────────────────────────────────────────────

  /**
   * Accept with a HODL invoice. Each step is saved before the next external
   * action: reserve the coins + save the preimage (under the mutex, so two
   * accepts can't promise the same coins) → create the invoice → save its
   * request → send accept → save the result.
   *
   * Only a journal that can't be saved turns the buyer away at once (an
   * accept whose preimage isn't on disk could never be settled). An LND read
   * failing in the capital check — the balance, the channel list — is no
   * reason to: nothing was reserved or created, the order stays "seen", and
   * the next pass decides afresh (undecided) — unless its approval deadline
   * is close by then, when it is rejected rather than left to time out. A
   * click is told LND's error. (Before, any error in here was reported as
   * "cannot save the order journal" and the order rejected — a blink of LND
   * cost a sale and seller reputation.) `pass`: the lane's, or null for a
   * click.
   */
  private async acceptOrder(
    entry: MagmaJournalEntry,
    order: SaleOrderDetail,
    feeMsat: bigint,
    via: "autopilot" | "manual",
    pass: LanePass | null,
  ): Promise<MagmaSellAction[]> {
    const fail = (error: string): MagmaSellAction => ({ orderId: entry.orderId, action: "accept", sizeSats: entry.sizeSats, ok: false, error });
    const secret = newHodlSecret();
    const step = await this.deps.capital.mutex.run(
      "magma accept",
      async (): Promise<{ lacking: string } | { unsaved: string } | { unchecked: unknown } | null> => {
        // The deploy-cap listing was refreshed just before (decide): no slow
        // Amboss call while the on-chain mutex is held.
        let lacking: string | null;
        try {
          lacking = await this.capitalFor(order.sizeSats, { caps: via === "autopilot", exceptKey: `magma:${entry.orderId}`, refresh: false });
        } catch (err) {
          return { unchecked: err }; // nothing changed yet
        }
        if (lacking) return { lacking };
        entry.via = via;
        entry.phase = "accepting";
        entry.sizeSats = order.sizeSats;
        entry.isPrivate = order.isPrivate;
        entry.buyerPubkey = order.buyerPubkey;
        entry.feeMsat = String(feeMsat);
        entry.leaseBlocks = order.promises.minBlockLength || null;
        entry.feeRateCapPpm = order.promises.feeRateCapPpm;
        entry.baseFeeCapSats = order.promises.baseFeeCapSats;
        entry.invoice = {
          id: secret.id,
          secret: secret.secret,
          request: null,
          expiresAt: new Date(Date.now() + HODL_EXPIRY_MS).toISOString(),
          cltvDelta: HODL_CLTV_DELTA,
        };
        entry.acceptAttempts += 1;
        entry.decision = { at: now(), action: "accept", reason: via === "manual" ? "accepted by you" : "within your caps and capital" };
        this.journal.event(entry, "accepting: preimage saved");
        try {
          this.journal.commit(entry);
        } catch (err) {
          // Not on disk: nothing is reserved and nothing created — undone
          // before the mutex is released, so no other check sees it reserved.
          entry.phase = "seen";
          entry.invoice = null;
          return { unsaved: msg(err) };
        }
        return null;
      },
    );
    if (step && "unchecked" in step) {
      if (via === "manual" || !pass) throw step.unchecked; // the click is told; nothing changed
      return this.undecided(entry, order, capitalCheckFailed(step.unchecked), pass);
    }
    if (step && "unsaved" in step) {
      const reason = `cannot save the order journal (${step.unsaved}) — not accepting`;
      this.noteError(entry, reason);
      return via === "autopilot" ? [fail(reason), ...(await this.rejectOrder(entry, reason))] : [fail(reason)];
    }
    if (step) return via === "autopilot" ? this.rejectOrder(entry, step.lacking) : [fail(step.lacking)];
    if (!(await this.ensureInvoice(entry))) return this.invoiceFailed(entry, order, pass);
    return [await this.sendAccept(entry)];
  }

  /**
   * LND could not make (or find) the order's HODL invoice: nothing was
   * offered — ensureInvoice put the order back to "seen", nothing reserved.
   * The lane tries again on its next pass; with the approval deadline close,
   * it rejects the order instead of leaving it to time out. A click (or an
   * order taken on by hand) is only told.
   */
  private async invoiceFailed(entry: MagmaJournalEntry, order: SaleOrder, pass: LanePass | null): Promise<MagmaSellAction[]> {
    const error = entry.lastError ?? "could not create the HODL invoice";
    const failed: MagmaSellAction = { orderId: entry.orderId, action: "accept", sizeSats: entry.sizeSats, ok: false, error };
    if (!pass || entry.via === "manual") return [failed];
    const rejected = await this.rejectUndecided(entry, order, error, pass);
    if (rejected) return [failed, ...rejected];
    pass.undecided.push(error);
    return [failed];
  }

  /** Make sure the HODL invoice for the saved preimage exists in LND and its
   *  request is saved — resumes cleanly after a crash at any point. */
  private async ensureInvoice(entry: MagmaJournalEntry): Promise<boolean> {
    const inv = entry.invoice;
    if (!inv) return false;
    if (inv.request) return true;
    try {
      const st = await this.lndHodlStatus(inv.id);
      if (st.state === "open" && st.request) {
        inv.request = st.request; // created before a crash; only its record was lost
      } else if (st.state === "missing") {
        const { request } = await this.lndCreateHodl({
          id: inv.id,
          mtokens: entry.feeMsat,
          description: orderMemo(entry.orderId),
          expiresAt: inv.expiresAt,
          cltvDelta: inv.cltvDelta,
        });
        inv.request = request;
      } else {
        throw new Error(`the order's invoice is already ${st.state}`);
      }
      this.journal.event(entry, "HODL invoice created");
      this.journal.commit(entry);
      return true;
    } catch (err) {
      // Nothing was promised to Amboss yet: drop the invoice and start over.
      await this.lndCancel(inv.id).catch(() => undefined);
      entry.phase = "seen";
      entry.invoice = null;
      this.noteError(entry, `could not create the HODL invoice: ${msg(err)}`);
      return false;
    }
  }

  private async sendAccept(entry: MagmaJournalEntry): Promise<MagmaSellAction> {
    const inv = entry.invoice!;
    const base = { orderId: entry.orderId, action: "accept" as const, sizeSats: entry.sizeSats };
    entry.acceptSentAt = now();
    this.journal.event(entry, "accept sent");
    this.journal.note(entry);
    let ok: boolean;
    try {
      ok = await this.ambossAccept(this.deps.amboss.getKey(), entry.orderId, inv.request!);
    } catch (err) {
      // A refused key, or a request Amboss rejected as such (not applied):
      // the pass deals with those (key check, lane status).
      if (isAuthError(err) || isQueryRejected(err)) throw err;
      // Maybe applied, maybe not: the next pass asks Amboss (resumeAccept).
      this.noteError(entry, `accept not confirmed (${msg(err)}) — checking with Amboss on the next pass`);
      return { ...base, ok: false, error: entry.lastError };
    }
    if (ok) {
      this.toPhase(entry, "accepted", "Amboss confirmed the accept");
      return { ...base, ok: true };
    }
    // Refused: release the unused invoice; the lane may try again (bounded).
    await this.lndCancel(inv.id).catch(() => undefined);
    entry.phase = "seen";
    entry.invoice = null;
    this.noteError(entry, "Amboss refused the accept");
    if (entry.acceptAttempts >= MAX_ACCEPT_ATTEMPTS && entry.via === "autopilot") {
      const [rejected] = await this.rejectOrder(entry, `Amboss refused the accept ${entry.acceptAttempts} times`);
      return rejected ?? { ...base, ok: false, error: "Amboss refused the accept" };
    }
    return { ...base, ok: false, error: "Amboss refused the accept" };
  }

  /** Our accept may or may not have reached Amboss (timeout, crash), and the
   *  order still waits for approval: send it again with the same invoice
   *  while that still has its 48 h. Older than that, start over. `pass`: the
   *  lane's, or null for a click. */
  private async resumeAccept(entry: MagmaJournalEntry, order: SaleOrderDetail, pass: LanePass | null): Promise<MagmaSellAction[]> {
    const inv = entry.invoice;
    if (!inv || Date.parse(inv.expiresAt) - Date.now() < MIN_INVOICE_LIFE_MS) {
      if (inv) await this.lndCancel(inv.id).catch(() => undefined);
      entry.phase = "seen";
      entry.invoice = null;
      this.journal.event(entry, "earlier accept never confirmed; its invoice was released");
      this.journal.note(entry);
      // The lane decides afresh; a manual accept is repeated by the caller.
      return entry.via !== "manual" && pass && this.deps.config().sellEnabled ? this.decide(order, pass) : [];
    }
    if (!(await this.ensureInvoice(entry))) return this.invoiceFailed(entry, order, pass);
    return [await this.sendAccept(entry)];
  }

  // ── reject ─────────────────────────────────────────────────────────────────

  private async rejectOrder(entry: MagmaJournalEntry, reason: string): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "reject" as const, sizeSats: entry.sizeSats };
    entry.decision = { at: now(), action: "reject", reason };
    let ok: boolean;
    try {
      ok = await this.ambossReject(this.deps.amboss.getKey(), entry.orderId);
    } catch (err) {
      // A refused key, or a request Amboss rejected as such (not applied):
      // the pass deals with those (key check, lane status).
      if (isAuthError(err) || isQueryRejected(err)) throw err;
      this.noteError(entry, `reject not confirmed (${msg(err)}) — will try again`);
      return [{ ...base, ok: false, error: `${reason} — reject failed: ${msg(err)}` }];
    }
    if (!ok) {
      this.noteError(entry, "Amboss refused the reject");
      return [{ ...base, ok: false, error: `${reason} — Amboss refused the reject` }];
    }
    entry.reason = reason;
    this.toPhase(entry, "rejected", `rejected: ${reason}`);
    console.log(`[magma] rejected order ${entry.orderId}: ${reason}`);
    return [{ ...base, ok: true, error: reason }];
  }

  // ── held → open → report ───────────────────────────────────────────────────

  /** Is the buyer's payment held by our invoice? */
  private async checkHeld(entry: MagmaJournalEntry): Promise<MagmaSellAction[]> {
    if (!entry.invoice) return [];
    const st = await this.lndHodlStatus(entry.invoice.id);
    if (st.state === "held" && st.heldMtokens >= BigInt(entry.feeMsat || "0")) {
      entry.heldAt = now();
      entry.heldUntilHeight = st.heldUntilHeight;
      this.toPhase(entry, "held", `buyer's payment held (${feeSatsOf(entry)} sat)`);
    } else if (st.state === "canceled" || st.state === "missing") {
      return this.release(entry, "the invoice expired or was cancelled before the buyer paid");
    } else if (st.state === "settled") {
      // Only we settle, and only after Amboss confirmed: recover the record.
      entry.settledAt = now();
      this.book(entry);
      this.toPhase(entry, "settled", "payment found settled");
    }
    return [];
  }

  /** WAITING_FOR_CHANNEL_OPEN: open (when allowed), then report. */
  private async fulfil(
    entry: MagmaJournalEntry,
    order: SaleOrderDetail,
    how: { auto: boolean; manual?: boolean },
  ): Promise<MagmaSellAction[]> {
    const out: MagmaSellAction[] = [];
    if (entry.phase === "accepting" || entry.phase === "accepted") {
      if (entry.phase === "accepting") this.journal.event(entry, "Amboss shows the order accepted and paid");
      out.push(...(await this.checkHeld(entry)));
      // (checkHeld moves the phase on — read it afresh, not as narrowed above)
      if (phaseOf(entry) !== "held") {
        if (!TERMINAL_PHASES.has(entry.phase)) {
          entry.decision = { at: now(), action: "wait", reason: "Amboss says paid, but our invoice holds no payment yet" };
          this.journal.note(entry);
        }
        return out;
      }
    }
    if (entry.phase === "opening") await this.reconcileOpening(entry);
    if (entry.phase === "held") {
      if (!how.auto && !how.manual) {
        entry.decision = { at: now(), action: "wait", reason: "payment held — waiting for you to open the channel" };
        this.journal.note(entry);
        return out;
      }
      out.push(...(await this.openFor(entry, order)));
    }
    if (entry.phase === "funded") {
      out.push(...(await this.report(entry)));
    } else if (entry.phase === "reported" && entry.reportedAt && Date.now() - Date.parse(entry.reportedAt) > REPORT_RESEND_MS) {
      // Amboss said yes long ago but still waits for the transaction: tell it again.
      entry.phase = "funded";
      out.push(...(await this.report(entry)));
    }
    return out;
  }

  /**
   * Open the channel for a held order. The buyer is dialed first, OUTSIDE the
   * on-chain mutex — over Tor that can take a minute and a half, and it must
   * not hold up anyone else's open or a Magma accept's capital check. Inside
   * the mutex: the payment is checked once more, then the capital; the intent
   * is saved before the open and the outpoint right after.
   */
  private async openFor(entry: MagmaJournalEntry, order: SaleOrderDetail): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "open" as const, sizeSats: entry.sizeSats };
    const unfit = await this.cannotOpen(entry, order);
    if (unfit) return unfit;
    if (!(await this.connectBuyer(order))) return this.openFailed(entry, order, couldNotConnect(entry.buyerPubkey));
    if (this.stopping) return [{ ...base, ok: false, error: "shutting down" }];
    return this.deps.capital.mutex.run("magma open", async (): Promise<MagmaSellAction[]> => {
      if (entry.phase !== "held") return []; // someone else got here first
      // Again: dialing took a while, and LND may have released the payment.
      const gone = await this.cannotOpen(entry, order);
      if (gone) return gone;
      const lacking = await this.capitalFor(entry.sizeSats, { caps: false, exceptKey: `magma:${entry.orderId}` });
      if (lacking) return this.openFailed(entry, order, lacking);
      const preExisting = (await channelsWith(this.deps.readLnd, entry.buyerPubkey)).map((c) => c.outpoint);
      if (this.stopping) return [{ ...base, ok: false, error: "shutting down" }];
      entry.phase = "opening";
      entry.opening = { startedAt: now(), preExisting };
      entry.openAttempts += 1;
      this.journal.event(entry, "open started");
      try {
        this.journal.commit(entry);
      } catch (err) {
        entry.phase = "held";
        entry.opening = undefined;
        const reason = `cannot save the order journal (${msg(err)}) — not opening`;
        this.noteError(entry, reason);
        return [{ ...base, ok: false, error: reason }];
      }
      // Nothing is awaited between the save above and the open: a shutdown
      // that began meanwhile still finds this open on the record.
      const res = await this.lndOpen({
        pubkey: entry.buyerPubkey,
        sockets: order.sockets,
        localTokens: entry.sizeSats,
        isPrivate: entry.isPrivate,
      });
      if (res.ok && res.transactionId) {
        this.recordFunding(entry, `${res.transactionId}:${res.transactionVout ?? 0}`);
        return [{ ...base, ok: true, transactionId: res.transactionId }];
      }
      // An error after the broadcast must not lead to a second open.
      const opened = await this.findOurOpen(entry).catch(() => null);
      if (opened) {
        this.recordFunding(entry, opened);
        return [{ ...base, ok: true, transactionId: opened.split(":")[0] }];
      }
      const error = res.error ?? "channel open failed";
      if (!isPreBroadcastRefusal(error)) {
        // Not a refusal LND gives before funding (a dropped stream, a timeout,
        // an error we don't know): the funding transaction may exist without
        // LND showing it yet. Stay "opening" — reconcileOpening adopts the
        // channel once LND shows it, and only after LND has had ample time to
        // (OPENING_GRACE_MS) may anything else happen: a second open, or
        // releasing the payment while a channel appears (a free channel).
        entry.opening = { ...(entry.opening ?? { startedAt: now(), preExisting }), unclear: error };
        this.noteError(entry, `the open's outcome is unclear (${error}) — waiting for LND to show the channel before anything else`);
        return [{ ...base, ok: false, error: entry.lastError }];
      }
      entry.phase = "held";
      entry.opening = undefined;
      return this.openFailed(entry, order, error);
    });
  }

  /**
   * Reasons not to open now, each with the buyer's payment released: no
   * time left for another attempt, a payment no longer held (LND releases a
   * held HTLC on its own shortly before it expires), or one that would not
   * stay held until the channel is confirmed and validated. Null: go ahead.
   */
  private async cannotOpen(entry: MagmaJournalEntry, order: SaleOrder): Promise<MagmaSellAction[] | null> {
    const base = { orderId: entry.orderId, action: "open" as const, sizeSats: entry.sizeSats };
    if (entry.openAttempts > 0 && !this.timeLeftToOpen(entry, order)) {
      return [{ ...base, ok: false, error: "no time left to open the channel" }, ...(await this.release(entry, "the channel could not be opened in time"))];
    }
    if (!entry.invoice) return null; // paid by a plain invoice (before the journal): nothing held
    const st = await this.lndHodlStatus(entry.invoice.id);
    if (st.state !== "held") {
      return [{ ...base, ok: false, error: "the buyer's payment is no longer held" }, ...(await this.release(entry, `the buyer's payment is no longer held (${st.state})`))];
    }
    const height = (await getWalletInfo({ lnd: this.deps.readLnd })).current_block_height;
    const until = st.heldUntilHeight ?? entry.heldUntilHeight ?? null;
    if (until !== null && until - height < OPEN_MIN_BLOCKS_LEFT) {
      return [
        { ...base, ok: false, error: "the held payment expires too soon" },
        ...(await this.release(
          entry,
          `the held payment would expire before the channel could be confirmed (${Math.max(0, until - height)} blocks left, ${OPEN_MIN_BLOCKS_LEFT} needed)`,
        )),
      ];
    }
    return null;
  }

  /** A failed open: retried on later passes while it may still work and there
   *  is time; otherwise the held payment is released (buyer refunded). */
  private async openFailed(entry: MagmaJournalEntry, order: SaleOrder, error: string): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "open" as const, sizeSats: entry.sizeSats };
    if (isTransientOpen(error) && this.timeLeftToOpen(entry, order)) {
      this.noteError(entry, `${error} — will try again`);
      return [{ ...base, ok: false, error: `${error} — will try again` }];
    }
    return [{ ...base, ok: false, error }, ...(await this.release(entry, `channel open failed: ${error}`))];
  }

  private timeLeftToOpen(entry: MagmaJournalEntry, order: SaleOrder): boolean {
    if (order.timeout) return Date.parse(order.timeout) - Date.now() > OPEN_RETRY_MIN_TIME_LEFT_MS;
    const since = entry.heldAt ? Date.parse(entry.heldAt) : Date.now();
    return Date.now() - since < OPEN_RETRY_WINDOW_MS;
  }

  /** The funding outpoint is the record that prevents a second channel: saved
   *  at once. If it can't be saved (disk full), fail closed: it stays in
   *  memory (this process never opens again), an alert says so, and after a
   *  restart the "opening" record on disk leads to the channel in LND. */
  private recordFunding(entry: MagmaJournalEntry, outpoint: string): void {
    entry.phase = "funded";
    entry.fundingOutpoint = outpoint;
    entry.fundedAt = now();
    entry.lastError = undefined;
    this.journal.event(entry, `funded ${outpoint}`);
    try {
      this.journal.commit(entry);
    } catch (err) {
      const detail =
        `Magma order ${entry.orderId}: channel ${outpoint} opened, but it could not be saved (${msg(err)}). ` +
        "It will not be opened again; after a restart it is found in LND.";
      console.error(`[magma] CRITICAL ${detail}`);
      recordStoreIncident(this.deps.dataDir, { file: "magma-orders.json", kind: "unrecorded_open", detail });
    }
  }

  /** The channel this order's open funded, if LND shows one: ours, to the
   *  buyer, of the order's size — and neither there before the open started
   *  nor already tied to another sale (Magma's or LSPS1's: the same buyer may
   *  have bought a channel of the same size there). */
  private async findOurOpen(entry: MagmaJournalEntry): Promise<string | null> {
    const found = await findOpenedChannel(this.deps.readLnd, {
      pubkey: entry.buyerPubkey,
      capacity: entry.sizeSats,
      exclude: [...(entry.opening?.preExisting ?? []), ...this.deps.capital.claimedOutpoints()],
    });
    return found?.outpoint ?? null;
  }

  /**
   * "opening" without an outpoint (a crash mid-open, or an open whose outcome
   * LND left unclear): adopt the channel LND shows, or — once LND has had
   * ample time — conclude no open happened.
   *
   * The lookup and its record happen under the on-chain mutex. A sale's open
   * (Magma's, LSPS1's) holds the mutex from before it asks LND until its
   * funding outpoint is recorded as that sale's, so a lookup under the mutex
   * never meets a channel that LND lists already but whose sale hasn't
   * claimed it yet. Outside the mutex it could: another sale's fresh channel
   * to the same buyer, of the same size, claimed by nobody for a moment —
   * adopted and reported here, while its own sale settles too (one channel,
   * paid for twice). The mutex isn't re-entrant: never call this from inside
   * it (openFor, which holds it, looks with findOurOpen itself).
   */
  private async reconcileOpening(entry: MagmaJournalEntry): Promise<void> {
    await this.deps.capital.mutex.run("magma reconcile", async () => {
      if (entry.phase !== "opening") return;
      const found = await this.findOurOpen(entry);
      if (found) {
        this.journal.event(entry, "the interrupted open's channel was found in LND");
        this.recordFunding(entry, found);
        return;
      }
      const startedAt = entry.opening ? Date.parse(entry.opening.startedAt) : 0;
      if (Date.now() - startedAt < OPENING_GRACE_MS) {
        entry.decision = { at: now(), action: "wait", reason: "an open was under way — waiting for LND to show its channel" };
        this.journal.note(entry);
        return;
      }
      const unclear = entry.opening?.unclear;
      entry.phase = "held";
      entry.opening = undefined;
      this.journal.event(
        entry,
        unclear
          ? `no channel appeared after the unclear open (${unclear}) — it never happened`
          : "no channel appeared for the interrupted open — it never happened",
      );
      this.journal.note(entry);
    });
  }

  /** Report the funding outpoint. The attempt is on the record before it is
   *  sent; a lost answer is resolved by Amboss's status on the next pass. */
  private async report(entry: MagmaJournalEntry): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "report" as const, sizeSats: entry.sizeSats };
    if (this.stopping || !entry.fundingOutpoint) return [];
    entry.reportAttempts += 1;
    entry.reportSentAt = now();
    this.journal.event(entry, "funding transaction sent to Amboss");
    this.journal.note(entry);
    let ok: boolean;
    try {
      ok = await this.ambossAddTx(this.deps.amboss.getKey(), entry.orderId, entry.fundingOutpoint);
    } catch (err) {
      // A refused key, or a request Amboss rejected as such (not applied):
      // the pass deals with those (key check, lane status).
      if (isAuthError(err) || isQueryRejected(err)) throw err;
      this.noteError(entry, `report not confirmed (${msg(err)}) — checking with Amboss on the next pass`);
      return [{ ...base, ok: false, error: entry.lastError }];
    }
    if (!ok) {
      this.noteError(entry, "Amboss did not accept the funding transaction — will report it again");
      return [{ ...base, ok: false, error: entry.lastError }];
    }
    entry.reportedAt = now();
    this.toPhase(entry, "reported", "Amboss accepted the funding transaction");
    return [{ ...base, ok: true, transactionId: entry.fundingOutpoint.split(":")[0] }];
  }

  // ── settle / cancel ────────────────────────────────────────────────────────

  /** Amboss confirmed the channel (VALID_CHANNEL_OPENING or later): claim the
   *  held payment, then book the sale and enqueue its service fee — once. */
  private async settle(entry: MagmaJournalEntry, order: SaleOrderDetail): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "settle" as const, sizeSats: entry.sizeSats };
    if (entry.phase === "opening") await this.reconcileOpening(entry);
    if (!entry.fundingOutpoint) this.journal.event(entry, `Amboss reports ${order.status} but no funding outpoint is on record here`);
    // Amboss's word alone is never income: only a payment our invoice holds
    // is claimed, booked and charged the service fee.
    if (entry.invoice) {
      const st = await this.lndHodlStatus(entry.invoice.id);
      if (st.state === "held") {
        try {
          await this.lndSettle(entry.invoice.secret);
        } catch (err) {
          const again = await this.lndHodlStatus(entry.invoice.id).catch(() => null);
          if (again?.state !== "settled") {
            this.noteError(entry, `settle failed (${msg(err)}) — will try again`);
            return [{ ...base, ok: false, error: entry.lastError }];
          }
        }
      } else if (st.state === "canceled") {
        entry.reason = "the held payment was released before Amboss confirmed the channel (LND cancels held payments near expiry)";
        entry.cancelledAt = now();
        this.toPhase(entry, "cancelled", entry.reason);
        return [{ orderId: entry.orderId, action: "cancel", sizeSats: entry.sizeSats, ok: true, error: entry.reason }];
      } else if (st.state === "missing") {
        // Gone from LND: nothing can be claimed for this order, ever. It ends
        // here, unbooked — rather than keeping its coins reserved, and the
        // lane asking, for as long as Amboss lists it.
        return this.release(entry, `Amboss reports ${order.status}, but our invoice is gone from LND — nothing to settle, nothing booked`);
      } else if (st.state !== "settled") {
        this.noteError(entry, `Amboss reports ${order.status}, but our invoice is ${st.state} — nothing to settle`);
        return [{ ...base, ok: false, error: entry.lastError }];
      }
    }
    entry.settledAt = now();
    // An order taken on with no fee on record (accepted before the journal,
    // while Amboss still read fees.seller as 0): book what it earns now.
    if (BigInt(entry.feeMsat || "0") === 0n) entry.feeMsat = String(this.invoiceMsat(order));
    // Booked before the "settled" record: a crash in between is recovered on
    // the next pass (the invoice reads settled), and booking twice is a no-op.
    this.book(entry);
    this.toPhase(entry, "settled", entry.invoice ? "payment settled — sale complete" : "sale complete");
    console.log(`[magma] order ${entry.orderId} complete: ${entry.sizeSats} sat channel, ${feeSatsOf(entry)} sat earned`);
    return [{ ...base, ok: true, transactionId: entry.fundingOutpoint?.split(":")[0] }];
  }

  /** Book the completed sale and enqueue the disclosed service fee. Both are
   *  idempotent per order, so a retried or recovered settle never counts twice.
   *  (Saved by the caller.) */
  private book(entry: MagmaJournalEntry): void {
    if (entry.via === "legacy" && !entry.paidInvoiceId) {
      // Fulfilled, but LND shows no paid invoice of ours for it (accepted
      // with another tool's invoice): nothing to book as income, and no
      // service fee on money this node can't show it received.
      this.journal.event(entry, "not booked as a sale: LND shows no paid invoice of ours for this order");
      entry.bookedAt = now();
      return;
    }
    const earned = feeSatsOf(entry);
    if (earned > 0) {
      // 0.7.x paid the 1% inline as soon as it had opened the channel — even
      // when Amboss had refused the report — and booked it as feePaidSats.
      // Such an order is completed here now; the fee ledger doesn't know that
      // payment, so it must not be charged a second time.
      const inlineFee = this.deps.earnings.find("magma", entry.orderId)?.feePaidSats ?? 0;
      this.deps.earnings.appendOnce({
        at: now(),
        via: entry.via === "manual" ? "manual" : "autopilot",
        orderId: entry.orderId,
        leaseSats: earned,
      });
      if (inlineFee > 0) {
        this.journal.event(entry, `service fee already paid by an earlier version (${inlineFee} sat) — not charged again`);
      } else {
        this.deps.serviceFees.enqueue({ source: "magma", orderId: entry.orderId, earnedSats: earned });
      }
    }
    entry.bookedAt = now();
  }

  /** End an order on our side: cancel the HODL invoice (the buyer's payment
   *  returns automatically) when we hold one. */
  private async release(entry: MagmaJournalEntry, reason: string): Promise<MagmaSellAction[]> {
    const base = { orderId: entry.orderId, action: "cancel" as const, sizeSats: entry.sizeSats };
    if (!entry.invoice) {
      entry.reason = reason;
      this.toPhase(entry, "failed", reason);
      return [];
    }
    try {
      await this.lndCancel(entry.invoice.id);
    } catch (err) {
      const st = await this.lndHodlStatus(entry.invoice.id).catch(() => null);
      if (st?.state === "settled") {
        this.noteError(entry, `${reason} — but the payment is already settled here; check this order`);
        return [{ ...base, ok: false, error: entry.lastError }];
      }
      if (st?.state !== "canceled" && st?.state !== "missing") {
        this.noteError(entry, `could not cancel the HODL invoice (${msg(err)}) — will try again`);
        return [{ ...base, ok: false, error: entry.lastError }];
      }
    }
    entry.cancelledAt = now();
    entry.reason = reason;
    this.toPhase(entry, "cancelled", `cancelled: ${reason}`);
    console.warn(`[magma] order ${entry.orderId}: ${reason} — HODL invoice cancelled, the buyer gets the payment back`);
    return [{ ...base, ok: true, error: reason }];
  }

  /** Release a held payment before its HTLC would expire. */
  private async cancelIfExpiring(entry: MagmaJournalEntry): Promise<MagmaSellAction[]> {
    if (!entry.invoice || !entry.heldUntilHeight || !HOLDING.has(entry.phase)) return [];
    const height = (await getWalletInfo({ lnd: this.deps.readLnd })).current_block_height;
    if (height < entry.heldUntilHeight - CANCEL_MARGIN_BLOCKS) return [];
    return this.release(entry, "the held payment was about to expire before Amboss confirmed the channel");
  }

  // ── orders found with no record here ───────────────────────────────────────

  /**
   * An order waiting for its channel that this journal has no record of:
   * accepted by an older version (a plain invoice, settled on payment), with
   * another tool — or by this version, with the record since lost (the
   * journal and its backup damaged). Before anything is recorded or opened,
   * LND says what was paid: the invoices of ours for the order (memo
   * "Magma order <id>", the one every version used).
   *  - One is SETTLED: paid to this node (0.7.x settled on payment). Fulfilled,
   *    and booked once Amboss confirms the channel.
   *  - A HODL invoice still holds (or awaits) the payment: its preimage was
   *    lost with the record, so the payment can never be claimed. Opening gave
   *    the channel away — and booking it, with its service fee, counted money
   *    never received. The invoice is cancelled instead: the buyer gets the
   *    payment back, and the order ends here.
   *  - Only cancelled ones, or a plain one still unpaid: nothing was paid to
   *    this node — no channel.
   *  - None at all: accepted with another tool's invoice. Fulfilled as before,
   *    but not booked — LND shows no payment to book.
   * Then, before any open, LND is asked whether a channel for it exists
   * already: the old code could open one and then fail to report it.
   * Every LND read comes before the record: one that fails leaves nothing
   * behind, and the next pass asks again.
   */
  private async adoptLegacy(order: SaleOrderDetail): Promise<MagmaJournalEntry> {
    const invoices = await this.lndOrderInvoices(order);
    const paid = invoices.find((i) => i.state === "settled");
    const terms = {
      orderId: order.id,
      via: "legacy" as const,
      buyerPubkey: order.buyerPubkey,
      sizeSats: order.sizeSats,
      isPrivate: order.isPrivate,
      timeout: order.timeout,
      leaseBlocks: order.promises.minBlockLength || null,
      feeRateCapPpm: order.promises.feeRateCapPpm,
      baseFeeCapSats: order.promises.baseFeeCapSats,
    };
    if (!paid && invoices.length > 0) return this.endUnpaidLegacy(order, terms, invoices);

    const height = (await getWalletInfo({ lnd: this.deps.readLnd })).current_block_height;
    const blocksSince = Math.ceil((Date.now() - Date.parse(order.createdAt)) / 600_000);
    // The lookup and the record under the on-chain mutex, as in
    // reconcileOpening: a channel another sale's open has broadcast but not
    // yet recorded can't be taken for this order's.
    return this.deps.capital.mutex.run("magma adopt", async () => {
      const found = await findOpenedChannel(this.deps.readLnd, {
        pubkey: order.buyerPubkey,
        capacity: order.sizeSats,
        exclude: this.deps.capital.claimedOutpoints(),
        // Funded before the order was placed (with a few blocks of slack for
        // clocks): an older channel of ours to this buyer — a routing one, or
        // a sale whose record was trimmed — never the one this buyer paid for.
        notBeforeHeight: height - blocksSince - 6,
      });
      const entry = this.journal.create({
        ...terms,
        // What the paid invoice brought in. Without one, the order's fee:
        // fees.seller reads 0 until Amboss settles it; its parts don't.
        feeMsat: paid && paid.receivedMtokens > 0n ? String(paid.receivedMtokens) : String(this.invoiceMsat(order)),
        phase: "held",
        heldAt: now(),
        paidInvoiceId: paid?.id ?? null,
      });
      this.journal.event(
        entry,
        paid
          ? `found waiting for its channel with no record here; paid to this node (invoice ${paid.id.slice(0, 12)}… settled)`
          : "found waiting for its channel with no record here, and no invoice of ours for it in LND (accepted with another tool?) — fulfilled, but not booked as a sale",
      );
      if (found) {
        this.journal.event(entry, "a channel for it already exists — reporting that one instead of opening another");
        this.recordFunding(entry, found.outpoint);
      } else {
        this.journal.note(entry);
      }
      return entry;
    });
  }

  /**
   * An order with no record here whose invoices of ours show no payment this
   * node can keep: no channel, and it ends here. Every invoice of ours for it
   * that could still take a payment is cancelled first:
   *  - a HODL invoice, holding the buyer's payment or still payable: its
   *    preimage went with the record, it can never be settled — the buyer
   *    gets the payment back;
   *  - a plain (0.7.x) invoice still unpaid: a plain invoice settles the
   *    moment an HTLC arrives, so a payment in flight, or a late one, would
   *    be kept by this node with no channel, no booking and the order over.
   * LND cancels any invoice that isn't settled. A cancel that fails — say,
   * the invoice settled just now — throws before anything is recorded: the
   * next pass finds it settled and fulfils the order.
   */
  private async endUnpaidLegacy(
    order: SaleOrderDetail,
    terms: Pick<MagmaJournalEntry, "orderId" | "via" | "buyerPubkey" | "sizeSats" | "isPrivate"> & Partial<MagmaJournalEntry>,
    invoices: FoundInvoice[],
  ): Promise<MagmaJournalEntry> {
    const payable = invoices.filter((i) => i.state === "held" || i.state === "open");
    for (const inv of payable) await this.lndCancel(inv.id);
    const unclaimable = payable.some((i) => i.hold);
    const reason = unclaimable
      ? "its record here was lost, and with it the preimage of its hold invoice: the buyer's payment could never be claimed, so it was released to the buyer instead of opening a channel nobody would pay for"
      : payable.length > 0
        ? "Amboss shows it paid, but its invoice in LND is unpaid — no channel for a payment this node never received (that invoice is cancelled now, so no payment can land on it later)"
        : "its invoice in LND is cancelled — the payment went back to the buyer; no channel is opened for it";
    const entry = this.journal.create({
      ...terms,
      feeMsat: String(this.invoiceMsat(order)),
      phase: unclaimable ? "cancelled" : "failed",
      ...(unclaimable ? { cancelledAt: now() } : {}),
      reason,
    });
    this.journal.event(entry, `found waiting for its channel with no record here — ${reason}`);
    this.journal.note(entry);
    console.warn(`[magma] order ${order.id}: ${reason}`);
    return entry;
  }

  // ── manual actions (Orders tab) ────────────────────────────────────────────

  private guard(): DeskResult | null {
    if (!this.deps.writeLnd) return { ok: false, code: "read_only", message: "Enable write mode to fulfil orders." };
    if (!this.deps.amboss.hasKey()) return { ok: false, code: "no_key", message: "Connect Amboss in Settings first." };
    if (this.stopping) return { ok: false, code: "shutting_down", message: "LightningMate is shutting down." };
    return null;
  }

  private async readForManual(id: string): Promise<SaleOrderDetail | DeskResult> {
    try {
      return await this.ambossSale(this.deps.amboss.getKey(), id);
    } catch (err) {
      if (isAuthError(err)) await this.deps.amboss.recheckAfterRefusal();
      return { ok: false, code: "amboss", message: `Could not read the order from Amboss: ${msg(err)}` };
    }
  }

  private async manual(id: string, fn: () => Promise<DeskResult>): Promise<DeskResult> {
    const blocked = this.guard();
    if (blocked) return blocked;
    this.active += 1;
    try {
      return await this.withOrder(id, fn);
    } catch (err) {
      // LND not answering (a capital check, an invoice lookup) is not Amboss's
      // failure: nothing was changed, try again.
      return { ok: false, code: err instanceof AmbossError ? "amboss" : "node", message: msg(err) };
    } finally {
      this.active -= 1;
    }
  }

  /** Accept an order by hand: same journal, same HODL invoice, same capital
   *  check as the lane (the autopilot's caps don't bind a manual pick). */
  accept(id: string): Promise<DeskResult> {
    return this.manual(id, async () => {
      const order = await this.readForManual(id);
      if ("ok" in order) return order;
      if (order.status !== "WAITING_FOR_SELLER_APPROVAL") {
        return { ok: false, code: "bad_status", message: `Order is ${order.status}, not awaiting approval.` };
      }
      let entry = this.journal.get(id);
      // Ended here with nothing of ours tied to it, while Amboss still waits
      // for your approval: yours to decide after all.
      this.revive(entry, order.status);
      if (entry?.phase === "accepting") {
        entry.via = "manual";
        const [res] = await this.resumeAccept(entry, order, null);
        if (phaseOf(entry) !== "seen") return this.result(entry, res);
        // its invoice had grown too old and was released: accept afresh below
      } else if (entry && entry.phase !== "seen") {
        return { ok: entry.phase === "accepted", ...(entry.phase === "accepted" ? {} : { code: "bad_status" as const }), phase: entry.phase, message: `Order is already ${entry.phase} here.` };
      }
      const fee = this.invoiceMsat(order);
      if (fee <= 0n) return { ok: false, code: "amboss", message: "Amboss reports no fee for this order yet — try again in a minute." };
      if (!(await this.connectBuyer(order))) {
        return { ok: false, code: "unreachable", message: "The buyer's node is unreachable right now — rejecting the order is safer than accepting it." };
      }
      entry ??= this.journal.create({
        orderId: id,
        via: "manual",
        buyerPubkey: order.buyerPubkey,
        sizeSats: order.sizeSats,
        isPrivate: order.isPrivate,
        feeMsat: String(fee),
      });
      const [res] = await this.acceptOrder(entry, order, fee, "manual", null);
      return this.result(entry, res, /capital/.test(res?.error ?? "") ? "capital" : undefined);
    });
  }

  /** Open the channel for a paid order by hand. Idempotent: an order with a
   *  channel on record is only reported again, never opened twice. */
  open(id: string): Promise<DeskResult> {
    return this.manual(id, async () => {
      const order = await this.readForManual(id);
      if ("ok" in order) return order;
      let entry = this.journal.get(id);
      if (entry && FUNDED.has(entry.phase)) {
        if (entry.phase === "funded" && order.status === "WAITING_FOR_CHANNEL_OPEN") await this.report(entry);
        return this.result(entry, undefined);
      }
      if (FUNDING_REPORTED_STATUSES.has(order.status)) {
        return { ok: true, phase: entry?.phase, message: `Amboss already has this order's channel (${order.status}).` };
      }
      if (order.status !== "WAITING_FOR_CHANNEL_OPEN") {
        return { ok: false, code: "bad_status", message: `Order is ${order.status}, not ready for a channel.` };
      }
      entry ??= await this.adoptLegacy(order);
      if (TERMINAL_PHASES.has(entry.phase)) {
        return { ok: false, code: "bad_status", phase: entry.phase, message: `Order is ${entry.phase} here: ${entry.reason ?? ""}`.trim() };
      }
      const actions = await this.fulfil(entry, order, { auto: true, manual: true });
      if (entry.phase === "accepting" || entry.phase === "accepted") {
        return { ok: false, code: "not_held", phase: entry.phase, message: "The buyer's payment is not held by our invoice yet." };
      }
      const failedOpen = actions.find((a) => a.action === "open" && !a.ok);
      if (failedOpen && !entry.fundingOutpoint) {
        return {
          ok: false,
          code: /capital/.test(failedOpen.error ?? "") ? "capital" : "open_failed",
          phase: entry.phase,
          message: failedOpen.error ?? "Channel open failed.",
        };
      }
      return this.result(entry, undefined);
    });
  }

  /**
   * The order as a reject needs it: its status (only an order awaiting
   * approval can be rejected), and who and what it is for the record. When
   * Amboss won't show the order itself, its listing of the orders waiting on
   * us says as much. (Before, a read that kept failing left the operator no
   * way to turn such an order down: it timed out on them.)
   */
  private async readForReject(id: string): Promise<SaleOrder | DeskResult> {
    const read = await this.readForManual(id);
    if (!("ok" in read)) return read;
    try {
      const listed = (await this.ambossSales(this.deps.amboss.getKey(), { actionNeeded: true })).orders.find((o) => o.id === id);
      if (listed) return listed;
    } catch {
      // The read's own error says what is wrong.
    }
    return read;
  }

  /** Reject an order by hand (only while it waits for approval). */
  reject(id: string): Promise<DeskResult> {
    return this.manual(id, async () => {
      const order = await this.readForReject(id);
      if ("ok" in order) return order;
      if (order.status !== "WAITING_FOR_SELLER_APPROVAL") {
        return { ok: false, code: "bad_status", message: `Order is ${order.status} — only orders awaiting approval can be rejected.` };
      }
      let entry = this.journal.get(id);
      this.revive(entry, order.status); // as in accept
      if (entry && entry.phase !== "seen") {
        return { ok: false, code: "bad_status", phase: entry.phase, message: `Order is already ${entry.phase} here.` };
      }
      entry ??= this.journal.create({
        orderId: id,
        via: "manual",
        buyerPubkey: order.buyerPubkey,
        sizeSats: order.sizeSats,
        isPrivate: order.isPrivate,
        feeMsat: String(this.invoiceMsat(order)),
      });
      const [res] = await this.rejectOrder(entry, "rejected by you");
      return this.result(entry, res);
    });
  }

  private result(entry: MagmaJournalEntry, action: MagmaSellAction | undefined, code?: DeskResult["code"]): DeskResult {
    const ok = action ? action.ok : FUNDED.has(entry.phase) || !entry.lastError;
    const opened = entry.fundingOutpoint
      ? {
          outpoint: entry.fundingOutpoint,
          transactionId: entry.fundingOutpoint.split(":")[0],
          reported: entry.phase === "reported" || entry.phase === "settled",
        }
      : {};
    let message: string;
    if (!ok) message = action?.error ?? entry.lastError ?? "failed";
    else if (entry.phase === "funded") message = `Channel opened (${entry.fundingOutpoint}); reporting it to Amboss is retried: ${entry.lastError ?? "pending"}.`;
    else message = `Order ${entry.phase}.`;
    return { ok, ...(ok ? {} : { code: code ?? "amboss" }), phase: entry.phase, message, ...opened };
  }

  // ── the main run's share: deployed capital, finished leases ────────────────

  /** Magma capital whose lease is still running, plus orders accepted outside
   *  this journal (they will need coins too) — the deploy-cap share. */
  async refreshDeployed(force = false): Promise<number> {
    if (!this.deps.amboss.hasKey()) return this.deployed.sats;
    if (!force && Date.now() - this.deployed.at < DEPLOYED_TTL_MS) return this.deployed.sats;
    const reserving = new Set(this.journal.reservations(0).map((r) => r.key));
    const { orders } = await this.ambossSales(this.deps.amboss.getKey(), {
      status: [...LEASE_RUNNING_STATUSES, "WAITING_FOR_BUYER_PAYMENT", "WAITING_FOR_CHANNEL_OPEN"],
    });
    // Orders this journal reserves are counted as reservations already.
    const sats = orders.filter((o) => !reserving.has(`magma:${o.id}`)).reduce((s, o) => s + o.sizeSats, 0);
    this.deployed = { sats, at: Date.now() };
    return sats;
  }

  /** Close sold channels whose lease is over (CHANNEL_MONITORING_FINISHED). */
  async closeFinishedLeases(): Promise<MagmaSellAction[]> {
    const { writeLnd, amboss } = this.deps;
    if (!writeLnd || !amboss.hasKey()) return [];
    const key = amboss.getKey();
    const { orders } = await this.ambossSales(key, { status: ["CHANNEL_MONITORING_FINISHED"] });
    if (orders.length === 0) return [];
    const open = (await getChannels({ lnd: this.deps.readLnd })).channels;
    const out: MagmaSellAction[] = [];
    for (const o of orders) {
      if (this.stopping) break;
      let txid = this.journal.get(o.id)?.fundingOutpoint?.split(":")[0] ?? this.finishedTxids.get(o.id);
      if (txid === undefined) {
        // Asked once per process — but only Amboss's answer is remembered. A
        // read that failed is asked again on the next run (before, one
        // hiccup was remembered as "no funding transaction", and that lease's
        // channel stayed open until a restart).
        const sale = await this.ambossSale(key, o.id).catch(() => null);
        if (!sale) continue;
        txid = sale.transactionId?.split(":")[0] ?? null;
        this.finishedTxids.set(o.id, txid);
      }
      const ch = txid ? open.find((c) => c.transaction_id === txid) : undefined;
      if (!ch) continue; // closed already, or not ours
      const res = await closeChannelByOutpoint(writeLnd, ch.transaction_id, ch.transaction_vout, false);
      const entry = this.journal.get(o.id);
      if (entry && res.ok) {
        entry.closedAt = now();
        entry.closeTxid = res.transactionId;
        this.journal.event(entry, "lease over — channel closed");
        this.journal.note(entry);
      }
      out.push({ orderId: o.id, action: "close", sizeSats: o.sizeSats, ok: res.ok, transactionId: res.transactionId, error: res.error });
    }
    return out;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private toPhase(entry: MagmaJournalEntry, phase: MagmaPhase, what: string): void {
    entry.phase = phase;
    entry.lastError = undefined;
    entry.lastErrorAt = undefined;
    this.journal.event(entry, what);
    this.journal.note(entry);
  }

  private noteError(entry: MagmaJournalEntry | undefined, error: string): void {
    if (!entry) return;
    entry.lastError = error;
    entry.lastErrorAt = now();
    this.journal.event(entry, error);
    this.journal.note(entry);
  }

  /** One action per order at a time, whoever asks (lane or click). */
  private async withOrder<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.orderChains.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chain = prev.then(() => mine);
    this.orderChains.set(id, chain);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.orderChains.get(id) === chain) this.orderChains.delete(id);
    }
  }

  private async connectBuyer(order: SaleOrderDetail): Promise<boolean> {
    try {
      return await this.lndConnect(order.buyerPubkey, order.sockets);
    } catch {
      return false;
    }
  }

  // ── seams: every external call, so a test can drive (and crash) each step ──

  private ambossSales(key: string, filter: SalesFilter) {
    return listSales(key, filter);
  }
  private ambossSale(key: string, id: string) {
    return getSale(key, id);
  }
  private ambossAccept(key: string, id: string, request: string) {
    return acceptSale(key, id, request);
  }
  private ambossAddTx(key: string, id: string, outpoint: string) {
    return addSaleTransaction(key, id, outpoint);
  }
  private ambossReject(key: string, id: string) {
    return rejectSale(key, id);
  }
  private lndCreateHodl(p: CreateHodlParams) {
    return createHodl(this.deps.writeLnd!, p);
  }
  private lndHodlStatus(id: string): Promise<HodlStatus> {
    return hodlStatus(this.deps.writeLnd!, id);
  }
  private lndSettle(secret: string) {
    return settleHodl(this.deps.writeLnd!, secret);
  }
  private lndCancel(id: string) {
    return cancelHodl(this.deps.writeLnd!, id);
  }
  /** The invoices of ours for an order (by memo). They are made at accept
   *  time, after the order was placed: the scan starts an hour before that
   *  (clocks differ) — on a busy node, not through months of invoices. */
  private lndOrderInvoices(order: SaleOrder): Promise<FoundInvoice[]> {
    const placed = Date.parse(order.createdAt);
    const since = new Date((Number.isFinite(placed) ? placed : Date.now() - 7 * 86_400_000) - 3_600_000).toISOString();
    return findInvoicesByDescription(this.deps.writeLnd!, orderMemo(order.id), since, 50);
  }
  /** The open itself — the buyer was dialed before the mutex (connectBuyer). */
  private lndOpen(p: OpenChannelParams) {
    return fundChannel(this.deps.writeLnd!, p);
  }
  private lndConnect(pubkey: string, sockets: string[]) {
    return ensureConnected(this.deps.writeLnd!, pubkey, sockets);
  }
}

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
