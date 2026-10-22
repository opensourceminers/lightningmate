import { getPayments, type AuthenticatedLnd } from "lightning";
import { getOwnPubkey } from "./node.js";
import type { RebalanceLog, RebalanceRecord } from "./rebalanceLog.js";

/**
 * What rebalancing cost — from LND's own payment history (review
 * a5-analytics:rebalance-cost-truncated, a8-engineering:pnl-accounting-
 * truncated).
 *
 * Before, P&L and Analytics summed LightningMate's own rebalance log: the
 * Analytics tab read its newest 50 records (failures included) for 30 and 90
 * days, P&L at most 200 for a year and "All", and rebalances made with bos,
 * RTL or ThunderHub — or before the app was installed — were never in it at
 * all, while routing revenue covered the node's whole life. Long windows
 * overstated net profit by every fee they lost.
 *
 * A rebalance is a payment from this node to itself (a circular payment —
 * rebalance.ts pays its own invoice). LND keeps every successful payment, so
 * its payments to this node's own key are the complete ledger, whichever
 * tool made them. Each one's fee is attributed to the channel it came back
 * through (the last hop: the refilled channel). LightningMate's log adds what
 * LND doesn't list — a payment history pruned since — matched by payment
 * hash (records from before the hash was kept: by channel, amount and time),
 * so nothing counts twice; and its daily sums (refills older than 400 days)
 * for the days before LND's history begins. When LND can't be read, the log
 * alone answers (with every fee it ever recorded: rebalanceLog.ts keeps them
 * all), and the answer says so.
 */

export interface SelfPayment {
  id: string;
  at: string;
  /** Sats delivered (to this node). */
  tokens: number;
  feeMsat: number;
  /** The channel(s) it came back through — the refilled channel — with
   *  each part's fee (a payment split over several paths: several parts). */
  targets: { channelId: string; feeMsat: number }[];
}

export interface RebalanceCostChannel {
  channelId: string;
  feeSats: number;
  count: number;
}

export interface RebalanceCosts {
  /** LND's payment history (every tool's rebalances), or LightningMate's own
   *  log alone (LND couldn't be read). */
  source: "lnd" | "log";
  feeSats: number;
  count: number;
  /** Sats the rebalances moved. */
  amountSats: number;
  /** By refilled channel ("": LND didn't say which). */
  perChannel: RebalanceCostChannel[];
  /** Rebalances LND lists that LightningMate's log has no record of: made
   *  outside LightningMate — with another tool (bos, RTL, ThunderHub …), or
   *  before its log existed. */
  notLogged: number;
  /** Rebalances on LightningMate's log that LND no longer lists (its
   *  payment history was pruned): counted from the log — its records, and
   *  its daily sums for the days before LND's history begins. */
  logOnly: number;
  /** Since when LightningMate's log covers rebalances (null: none logged). */
  logTrackedSince: string | null;
  /** What the figure can't see, in words (null: nothing). */
  note: string | null;
}

/** LND pages payments this many at a time … */
const PAGE = 250;
/** … for at most this many pages (100,000 payments). */
const MAX_PAGES = 400;
/** The Overview asks every minute: one read of LND serves a minute. */
const CACHE_MS = 60_000;
/** A record without a payment hash (logged before 0.8) matches an LND
 *  payment of the same channel and amount, sent within this before it ended. */
const LEGACY_MATCH_MS = 30 * 60_000;

type Listing = { items: SelfPayment[]; complete: boolean };
const cache = new WeakMap<AuthenticatedLnd, { at: number; sinceMs: number; listing: Listing }>();

/** Forget what was read (a test changes the node's payments). */
export function forgetSelfPayments(lnd: AuthenticatedLnd): void {
  cache.delete(lnd);
}

/**
 * This node's successful payments to itself since `sinceMs`, newest first.
 * `complete` is false when LND lists more than MAX_PAGES pages: the oldest
 * are then missing.
 */
export async function listSelfPayments(lnd: AuthenticatedLnd, sinceMs: number, nowMs = Date.now()): Promise<Listing> {
  const cached = cache.get(lnd);
  if (cached && nowMs - cached.at < CACHE_MS && cached.sinceMs <= sinceMs) {
    return { items: cached.listing.items.filter((p) => !(Date.parse(p.at) < sinceMs)), complete: cached.listing.complete };
  }
  const own = await getOwnPubkey(lnd);
  const items: SelfPayment[] = [];
  let complete = true;
  let token: string | undefined;
  const after = Number.isFinite(sinceMs) && sinceMs > 0 ? new Date(sinceMs).toISOString() : undefined;
  for (let page = 0; ; page++) {
    if (page >= MAX_PAGES) {
      complete = false;
      break;
    }
    const res = await getPayments(token ? { lnd, token } : { lnd, limit: PAGE, ...(after ? { created_after: after } : {}) });
    let older = false;
    for (const p of res.payments) {
      const at = Date.parse(p.created_at);
      // An LND before 0.16 ignores created_after: the window is applied here.
      if (Number.isFinite(sinceMs) && !(at >= sinceMs)) {
        older = true;
        continue;
      }
      if (!p.is_confirmed || p.destination !== own) continue;
      const targets: SelfPayment["targets"] = [];
      for (const a of p.attempts ?? []) {
        if (!a.is_confirmed) continue;
        const hops = a.route?.hops ?? [];
        const last = hops[hops.length - 1];
        if (last?.channel) targets.push({ channelId: last.channel, feeMsat: Number(a.route.fee_mtokens ?? 0) });
      }
      items.push({
        id: p.id,
        at: p.created_at,
        tokens: p.tokens,
        feeMsat: p.fee_mtokens !== undefined ? Number(p.fee_mtokens) : (p.fee ?? 0) * 1000,
        targets,
      });
    }
    // Pages run newest to oldest: once one reaches past the window, the
    // rest are older still.
    if (!res.next || older) break;
    token = res.next;
  }
  const listing = { items, complete };
  cache.set(lnd, { at: nowMs, sinceMs, listing });
  return listing;
}

const msatToSats = (msat: number): number => Math.round(msat / 1000);

/** The LND payment a record without a hash stands for: same channel (when
 *  LND says), same amount, sent while the record's attempt ran. */
function legacyMatch(r: RebalanceRecord, open: Map<string, SelfPayment>): SelfPayment | undefined {
  const end = Date.parse(r.at);
  const start = Date.parse(r.startedAt ?? r.at) - LEGACY_MATCH_MS;
  for (const p of open.values()) {
    const at = Date.parse(p.at);
    if (p.tokens !== r.amountSats || !(at >= start && at <= end + 5 * 60_000)) continue;
    if (p.targets.length > 0 && !p.targets.some((t) => t.channelId === r.targetId)) continue;
    return p;
  }
  return undefined;
}

/** What rebalancing cost since `sinceMs`. Never throws: LND unreadable, the
 *  log answers alone (and the note says so). */
export async function rebalanceCosts(lnd: AuthenticatedLnd, log: RebalanceLog, sinceMs: number, nowMs = Date.now()): Promise<RebalanceCosts> {
  const logTrackedSince = log.trackedSince();
  let listing: Listing;
  try {
    listing = await listSelfPayments(lnd, sinceMs, nowMs);
  } catch (err) {
    const own = log.costsSince(sinceMs);
    const since = logTrackedSince ? ` (it covers ${logTrackedSince.slice(0, 10)} on)` : "";
    return {
      source: "log",
      feeSats: own.feeSats,
      count: own.count,
      amountSats: own.amountSats,
      perChannel: [...own.perTarget].map(([channelId, t]) => ({ channelId, feeSats: t.feeSats, count: t.count })),
      notLogged: 0,
      logOnly: 0,
      logTrackedSince,
      note:
        `LND's payment history could not be read (${errorText(err)}): rebalancing is LightningMate's own log${since} — ` +
        "rebalances made with other tools are not in it",
    };
  }

  const per = new Map<string, RebalanceCostChannel>();
  const add = (channelId: string, feeSats: number, count = 1) => {
    const c = per.get(channelId) ?? { channelId, feeSats: 0, count: 0 };
    c.feeSats += feeSats;
    c.count += count;
    per.set(channelId, c);
  };

  // The log's records in the window, paired with LND's payments.
  const open = new Map(listing.items.map((p) => [p.id, p]));
  const matchedTarget = new Map<string, string>();
  const logOnly: RebalanceRecord[] = [];
  for (const r of log.successes(sinceMs)) {
    const p = r.paymentId ? open.get(r.paymentId) : legacyMatch(r, open);
    if (p) {
      open.delete(p.id);
      matchedTarget.set(p.id, r.targetId);
    } else if (!r.paymentId || !listing.items.some((x) => x.id === r.paymentId)) {
      logOnly.push(r);
    }
  }

  let feeMsat = 0;
  for (const p of listing.items) {
    feeMsat += p.feeMsat;
    if (p.targets.length > 0) {
      // Each part's fee to the channel it came back through.
      const parts = p.targets.reduce((s, t) => s + t.feeMsat, 0);
      const byChannel = new Map<string, number>();
      for (const t of p.targets) byChannel.set(t.channelId, (byChannel.get(t.channelId) ?? 0) + t.feeMsat);
      for (const [channelId, msat] of byChannel) add(channelId, msatToSats(parts > 0 ? (p.feeMsat * msat) / parts : p.feeMsat / byChannel.size));
    } else {
      add(matchedTarget.get(p.id) ?? "", msatToSats(p.feeMsat));
    }
  }
  let logFeeSats = 0;
  let amountSats = listing.items.reduce((s, p) => s + p.tokens, 0);
  for (const r of logOnly) {
    logFeeSats += r.feeSats ?? 0;
    amountSats += r.amountSats;
    add(r.targetId, r.feeSats ?? 0);
  }

  // The log's daily sums — refills older than 400 days (or past 10,000
  // records), no longer kept one by one — for the days LND's history no
  // longer reaches: before the oldest rebalance it lists in the window (all
  // of the window's when it lists none). Its history has no gaps (deleting
  // payments removes all of them up to then): a summed refill on a day before
  // its oldest is one LND doesn't have. That oldest one's own day stays
  // LND's — the sums can't be paired with payments, and nothing may count
  // twice.
  let oldestListed = Infinity;
  for (const p of listing.items) {
    const t = Date.parse(p.at);
    if (Number.isFinite(t)) oldestListed = Math.min(oldestListed, t);
  }
  const lndFromDay = Number.isFinite(oldestListed) ? new Date(oldestListed).toISOString().slice(0, 10) : null;
  let summed = 0;
  for (const d of log.dailySums(sinceMs)) {
    if (lndFromDay !== null && d.day >= lndFromDay) continue;
    logFeeSats += d.feeSats;
    amountSats += d.amountSats;
    summed += d.count;
    add(d.targetId, d.feeSats, d.count);
  }

  // LND's payments the log has no record of — counted only where the log
  // still holds its records one by one (older ones are in its daily sums,
  // which can't be paired with a payment).
  const detailFrom = log.detailSinceMs() ?? -Infinity;
  const notLogged = [...open.values()].filter((p) => Date.parse(p.at) >= detailFrom).length;

  const notes: string[] = [];
  if (!listing.complete) notes.push(`LND lists more payments than were read (the newest ${(PAGE * MAX_PAGES).toLocaleString("en-US")}) — older rebalances are missing`);
  if (logOnly.length) notes.push(`${logOnly.length} rebalance${logOnly.length === 1 ? "" : "s"} LND no longer lists (its payment history was pruned) counted from LightningMate's log`);
  if (summed) notes.push(`${summed} rebalance${summed === 1 ? "" : "s"} older than LND's payment history counted from LightningMate's daily sums`);
  return {
    source: "lnd",
    feeSats: msatToSats(feeMsat) + logFeeSats,
    count: listing.items.length + logOnly.length + summed,
    amountSats,
    perChannel: [...per.values()].sort((a, b) => b.feeSats - a.feeSats),
    notLogged,
    logOnly: logOnly.length + summed,
    logTrackedSince,
    note: notes.length ? notes.join("; ") : null,
  };
}

function errorText(err: unknown): string {
  if (Array.isArray(err)) {
    const extra = err[2] as { err?: { details?: string } } | undefined;
    return extra?.err?.details ? `${String(err[1])}: ${extra.err.details}` : String(err[1] ?? err[0]);
  }
  return err instanceof Error ? err.message : String(err);
}
