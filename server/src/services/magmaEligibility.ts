import { getNodeMarket, getOffers, getPublicOffers, dollarRates, type MagmaOffer, type PublicOffer } from "./amboss.js";
import { torVia } from "./http.js";

/**
 * Can this node realistically SELL on Magma? (D8)
 *
 * Amboss decides which seller gets an order. Its matcher is not public, but its
 * outcome is: the public offer book shows, for every live offer, how many
 * orders it has filled since it was listed, its seller's score, and the
 * platform fee Amboss charges its buyers. Measured on that book (2026-10), the
 * sellers who get orders are the ones with a track record and depth: of the 31
 * offers with a seller score below 10 and at most 5M listed, none had ever sold
 * — 0 fills in 225 offer-months — whatever their price, lease or fee caps.
 * Price and size were never the lever below that gate (the old "size, not
 * price" advice was wrong), and the seller score rises only with completed
 * orders.
 *
 * So this check compares the node with the offers that look like the offer it
 * could list — computed live from the public book, never from hard-coded
 * thresholds:
 *  - the LISTED-TOTAL band is Amboss's own: the platform-fee tier its fee
 *    grid puts a listing of this node's size in (fees.amboss steps down as the
 *    listed total rises; the tier boundaries are read off the live book);
 *  - the SCORE band splits that tier at its median seller score, live.
 * Of the offers in that cell: how many there are, how many ever sold, and how
 * many orders they filled per offer-month. That rate is what one more offer
 * like this node's can expect — shown as real numbers, and marked indicative.
 * The verdict is about the outcome only: under one sale a year expected is
 * "not realistic", under one a month "possible but slow".
 *
 * Inputs: the legacy book (getOffers: seller scores), the public Magma offer
 * list (filled orders, listing date, Amboss fee), the node's own score and
 * completed sales (getNode), the dollar rate (liquidity.buy orders are sized in
 * dollars), and the capital this node could list now (capital.ts). The public
 * data is cached for a day; the capital is the caller's, fresh every time.
 */

export type EligibilityVerdict = "not_realistic" | "possible_but_slow" | "realistic" | "unknown";

/** One offer of the live book, as the check sees it. */
export interface BookOffer {
  id: string;
  sellerPubkey: string;
  totalSats: number;
  filledOrders: number;
  createdAt: string;
  ambossFee: number;
  /** The legacy book's seller score; null when the offer isn't in it. */
  sellerScore: number | null;
  /** Its price (legacy book), when known: what a buyer pays per order is
   *  size × (fee rate + Amboss's fee) / 1e6 + base fee. */
  feeRatePpm?: number;
  baseFeeSats?: number;
}

/** The public data, as fetched (cached for a day). */
export interface PublicBook {
  fetchedAt: string;
  offers: BookOffer[];
  /** Inbound capacity one US dollar buys at today's market rate. */
  inboundSatsPerUsd: number | null;
  /** The bitcoin price: sats per US dollar. */
  satsPerUsd?: number | null;
  own: {
    pubkey: string;
    sellerScore: number | null;
    confirmedSells: number | null;
    /** The own-key lookup failed: why, and the route it took ("" direct). */
    lookupError?: { error: string; via: string };
  };
}

export interface CellStats {
  offers: number;
  /** Offers that ever filled an order. */
  sold: number;
  fills: number;
  offerMonths: number;
  /** Fills per offer-month: what one more such offer can expect. */
  fillsPerMonth: number;
  /** With no fill at all: the 95% upper bound (3 / offer-months). */
  upperBoundPerMonth: number | null;
}

export interface Eligibility {
  verdict: EligibilityVerdict;
  /** Always true: derived from Amboss's public book; its matcher isn't public. */
  indicative: true;
  computedAt: string;
  bookFetchedAt: string | null;
  own: { sellerScore: number | null; confirmedSells: number | null; listableSat: number; maxChannelSat: number };
  /** The Amboss fee tier a listing of this node's size falls in, as read off
   *  the live book: the fee, and the listed totals that tier spans. */
  tier: { ambossFee: number; fromSat: number; toSat: number | null } | null;
  /** Every Amboss fee tier of the live book (ppm, up to which size; null:
   *  above the last boundary) — what a buyer pays Amboss on top, by order
   *  size. Empty when the book could not be read. */
  feeTiers: { ambossFeePpm: number; upToSats: number | null }[];
  /** The tier's median seller score, and which side of it this node is on. */
  scoreSplit: { median: number; side: "at_or_below" | "above" } | null;
  /** Offers like this node's would-be offer (same tier, same side of the median). */
  comparable: CellStats | null;
  /** The cell was too small to say anything: compared with the whole tier. */
  widened: boolean;
  /** The other side of the median in the same tier, for context. */
  otherSide: CellStats | null;
  /** Sales a year one more offer like this one can expect (fillsPerMonth × 12). */
  expectedSalesPerYear: number | null;
  /** liquidity.buy orders start at $5: the smallest such order at the market
   *  rate; what $5 buys at this node's own listed price (Amboss's fee
   *  included; null without an offer of its own in the book); and whether this
   *  node's largest channel could take both. */
  usdOrders: { minOrderSat: number; atOwnPriceSat: number | null; fits: boolean } | null;
  /** The verdict in plain words — numbers from the live book only. */
  reasons: string[];
}

/** Below this many offers a cell says nothing; the whole tier is used. */
const MIN_CELL = 5;
const MONTH_MS = 30 * 86_400_000;
/** liquidity.buy: "usd_cents … Minimum 500 ($5)" (Amboss docs). */
const MIN_USD_ORDER = 5;

const fmtSats = (n: number): string => Math.round(n).toLocaleString("en-US");
const fmtRate = (n: number): string => (n >= 1 ? n.toFixed(1) : n >= 0.1 ? n.toFixed(2) : n.toFixed(3));

/**
 * The Amboss fee tiers of the live book: each distinct fees.amboss, with the
 * listed totals it spans — highest fee (smallest listings) first. A tier
 * reaches up to the largest total observed in it: Amboss's grid is "up to"
 * a round size (on the live book: 1,500 ppm up to exactly 1M, 1,000 up to 5M,
 * 500 up to 50M — listings of exactly those sizes are in the lower-size tier).
 * Before, the boundary sat at the geometric middle between one tier's largest
 * total and the next one's smallest (~1.12M on the live book): a 1.1M order
 * was charged — and a 1.1M listing compared — as the 1,500 tier.
 */
export function feeTiers(offers: Pick<BookOffer, "ambossFee" | "totalSats">[]): { ambossFee: number; minSat: number; maxSat: number; upTo: number | null }[] {
  const byFee = new Map<number, { min: number; max: number }>();
  for (const o of offers) {
    if (!(o.ambossFee > 0) || !(o.totalSats > 0)) continue;
    const t = byFee.get(o.ambossFee);
    if (t) {
      t.min = Math.min(t.min, o.totalSats);
      t.max = Math.max(t.max, o.totalSats);
    } else byFee.set(o.ambossFee, { min: o.totalSats, max: o.totalSats });
  }
  const tiers = [...byFee.entries()].sort((a, b) => b[0] - a[0]).map(([ambossFee, r]) => ({ ambossFee, minSat: r.min, maxSat: r.max }));
  return tiers.map((t, i) => ({ ...t, upTo: tiers[i + 1] ? t.maxSat : null }));
}

function cellStats(offers: BookOffer[], nowMs: number): CellStats {
  let fills = 0;
  let months = 0;
  for (const o of offers) {
    fills += o.filledOrders;
    const listed = Date.parse(o.createdAt);
    months += Number.isFinite(listed) ? Math.max(0, nowMs - listed) / MONTH_MS : 0;
  }
  const fillsPerMonth = months > 0 ? fills / months : 0;
  return {
    offers: offers.length,
    sold: offers.filter((o) => o.filledOrders > 0).length,
    fills,
    offerMonths: Math.round(months * 10) / 10,
    fillsPerMonth: Math.round(fillsPerMonth * 1000) / 1000,
    upperBoundPerMonth: fills === 0 && months > 0 ? Math.round((3 / months) * 1000) / 1000 : null,
  };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The check itself — pure, from the public book and this node's capital.
 * `listableSat`: what this node could list now (on-chain after the effective
 * reserve and every promised order, within the deploy cap's headroom);
 * `maxChannelSat`: the largest single channel it could sell now.
 */
export function assessEligibility(
  book: PublicBook | null,
  capital: { listableSat: number; maxChannelSat: number },
  nowMs = Date.now(),
): Eligibility {
  const own = {
    sellerScore: book?.own.sellerScore ?? null,
    confirmedSells: book?.own.confirmedSells ?? null,
    listableSat: Math.max(0, Math.floor(capital.listableSat)),
    maxChannelSat: Math.max(0, Math.floor(capital.maxChannelSat)),
  };
  const base: Eligibility = {
    verdict: "unknown",
    indicative: true,
    computedAt: new Date(nowMs).toISOString(),
    bookFetchedAt: book?.fetchedAt ?? null,
    own,
    tier: null,
    feeTiers: [],
    scoreSplit: null,
    comparable: null,
    widened: false,
    otherSide: null,
    expectedSalesPerYear: null,
    usdOrders: null,
    reasons: [],
  };
  if (!book || book.offers.length === 0) {
    base.reasons.push(`Amboss's public offer book could not be read${torVia("amboss_public")} — no comparison is possible right now.`);
    return base;
  }

  const usdMin = book.inboundSatsPerUsd ? Math.round(book.inboundSatsPerUsd * MIN_USD_ORDER) : null;
  if (usdMin) {
    // How Amboss sizes a dollar order for a given seller isn't documented: at
    // the market rate, and at this node's own all-in price, a $5 order has to
    // fit its largest channel (m1-matching: both, never a widened window).
    const atOwn = usdAtOwnPrice(book);
    base.usdOrders = { minOrderSat: usdMin, atOwnPriceSat: atOwn, fits: own.maxChannelSat >= Math.max(usdMin, atOwn ?? 0) };
  }

  // Another node's offers only: this node's own offer is what is being judged.
  const others = book.offers.filter((o) => o.sellerPubkey !== book.own.pubkey);
  const tiers = feeTiers(others);
  base.feeTiers = tiers.map((t) => ({ ambossFeePpm: t.ambossFee, upToSats: t.upTo }));
  const tier = tiers.find((t) => t.upTo === null || own.listableSat <= t.upTo) ?? tiers[tiers.length - 1];
  if (!tier) {
    base.reasons.push("The public offer book carries no Amboss fee tiers — no comparison is possible right now.");
    return base;
  }
  const tierIndex = tiers.indexOf(tier);
  const fromSat = tierIndex === 0 ? 0 : (tiers[tierIndex - 1].upTo ?? 0);
  base.tier = { ambossFee: tier.ambossFee, fromSat, toSat: tier.upTo };

  const inTier = others.filter((o) => o.ambossFee === tier.ambossFee);
  const scored = inTier.filter((o): o is BookOffer & { sellerScore: number } => o.sellerScore !== null);
  // No score of its own yet: a seller with no track record — it sits where
  // zero sits (the median split tells which side that is).
  const ownScore = own.sellerScore ?? 0;
  let cell: BookOffer[] = inTier;
  let other: BookOffer[] = [];
  if (scored.length > 0) {
    const split = median(scored.map((o) => o.sellerScore));
    const side = ownScore <= split ? "at_or_below" : "above";
    base.scoreSplit = { median: Math.round(split * 100) / 100, side };
    const mine = (o: BookOffer & { sellerScore: number }) => (side === "at_or_below" ? o.sellerScore <= split : o.sellerScore > split);
    cell = scored.filter(mine);
    other = scored.filter((o) => !mine(o));
  }
  if (cell.length < MIN_CELL) {
    base.widened = true;
    cell = inTier;
    other = [];
  }
  const stats = cellStats(cell, nowMs);
  base.comparable = stats;
  base.otherSide = other.length ? cellStats(other, nowMs) : null;
  if (stats.offerMonths <= 0) {
    base.reasons.push("The offers like yours were listed too recently to tell how often they sell.");
    return base;
  }
  const perYear = stats.fillsPerMonth * 12;
  base.expectedSalesPerYear = Math.round(perYear * 100) / 100;
  base.verdict = perYear < 1 ? "not_realistic" : perYear < 12 ? "possible_but_slow" : "realistic";

  const band =
    `Amboss fee tier ${fmtSats(tier.ambossFee)} (listings of ${fmtSats(fromSat)}${tier.upTo ? `–${fmtSats(tier.upTo)}` : "+"} sat)` +
    (base.widened
      ? ", all seller scores (too few offers to split by score)"
      : base.scoreSplit
        ? `, seller score ${base.scoreSplit.side === "at_or_below" ? "at or below" : "above"} that tier's median ${base.scoreSplit.median}`
        : "");
  base.reasons.push(
    `Offers like yours — ${band}: ${stats.offers} live, ${stats.sold} ever sold; ${stats.fills} fill${stats.fills === 1 ? "" : "s"} in ` +
      `${stats.offerMonths} offer-months (~${fmtRate(stats.fillsPerMonth)} a month per offer` +
      `${stats.upperBoundPerMonth !== null ? `, at most ~${fmtRate(stats.upperBoundPerMonth)} at 95% confidence` : ""}).`,
  );
  if (base.otherSide) {
    base.reasons.push(
      `For comparison, the same tier with ${base.scoreSplit?.side === "at_or_below" ? "higher" : "lower"} seller scores: ` +
        `${base.otherSide.offers} offers, ${base.otherSide.sold} sold, ~${fmtRate(base.otherSide.fillsPerMonth)} fills a month per offer.`,
    );
  }
  const lookup = book.own.lookupError;
  base.reasons.push(
    lookup
      ? `Your node's own seller score could not be read${lookup.via} (${lookup.error}) — it is compared as a seller with no score yet; ` +
          `up to ${fmtSats(own.listableSat)} sat listable now.`
      : `Your node: seller score ${own.sellerScore === null ? "not set yet" : own.sellerScore}` +
          `${own.confirmedSells === null ? "" : `, ${own.confirmedSells} completed sale${own.confirmedSells === 1 ? "" : "s"}`}; ` +
          `up to ${fmtSats(own.listableSat)} sat listable now.`,
  );
  if (base.usdOrders) {
    const u = base.usdOrders;
    const size =
      `the smallest ($5) is about ${fmtSats(u.minOrderSat)} sat of channel at today's rate` +
      (u.atOwnPriceSat !== null ? ` (about ${fmtSats(u.atOwnPriceSat)} sat at your offer's price, Amboss's fee included)` : "");
    base.reasons.push(
      u.fits
        ? `Amboss sizes its buy-button orders in dollars: ${size}; your largest channel could take one.`
        : `Amboss sizes its buy-button orders in dollars: ${size} — more than the ${fmtSats(own.maxChannelSat)} sat your node can sell in one channel now. Only fixed-size orders (e.g. 1M) can reach you.`,
    );
  }
  return base;
}

/**
 * The channel a $5 order buys at this node's own listed price — size × (fee
 * rate + Amboss's fee) / 1e6 + base fee = $5 in sats — or null when the book
 * has no priced offer of this node's (or no dollar rate). Its largest offer.
 */
function usdAtOwnPrice(book: PublicBook): number | null {
  if (!book.satsPerUsd) return null;
  const mine = book.offers
    .filter((o) => o.sellerPubkey === book.own.pubkey && o.feeRatePpm !== undefined && o.baseFeeSats !== undefined)
    .sort((a, b) => b.totalSats - a.totalSats)[0];
  if (!mine) return null;
  const perSat = ((mine.feeRatePpm as number) + mine.ambossFee) / 1_000_000;
  if (!(perSat > 0)) return null;
  const dollars = MIN_USD_ORDER * book.satsPerUsd;
  return Math.max(0, Math.round((dollars - (mine.baseFeeSats as number)) / perSat));
}

// ── the live public data, cached for a day ─────────────────────────────────

const BOOK_TTL_MS = 24 * 3_600_000;
/**
 * After a fetch failed, the book is not asked for again for this long: every
 * caller gets the stale copy (or the failure) at once. Before, a failure was
 * not remembered at all — while Amboss was slow or down, every Overview load,
 * every Sell-tab visit and every confirmation waited out the full query
 * deadline (15 s) again. An explicit "check again" (force) still asks.
 */
export const BOOK_RETRY_AFTER_FAILURE_MS = 15 * 60_000;
let cachedBook: { at: number; pubkey: string; book: PublicBook } | null = null;
let lastFailure: { at: number; pubkey: string; error: unknown } | null = null;
/** The fetch under way, per node (one at a time: the page, the autopilot and
 *  the dashboard ask at once). */
const inFlight = new Map<string, Promise<PublicBook>>();

/** The book as cached for this node — however old — without asking Amboss
 *  (null: none yet). `fresh`: younger than a day. */
export function cachedPublicBook(ownPubkey: string, nowMs = Date.now()): { book: PublicBook; fresh: boolean } | null {
  if (!cachedBook || cachedBook.pubkey !== ownPubkey) return null;
  return { book: cachedBook.book, fresh: nowMs - cachedBook.at < BOOK_TTL_MS };
}

/** The last fetch of this node's book failed, and it is not asked for again
 *  before `retryAt` (null: no failure being waited out). */
export function publicBookFailure(ownPubkey: string, nowMs = Date.now()): { at: string; retryAt: string } | null {
  if (!lastFailure || lastFailure.pubkey !== ownPubkey || nowMs - lastFailure.at >= BOOK_RETRY_AFTER_FAILURE_MS) return null;
  return { at: new Date(lastFailure.at).toISOString(), retryAt: new Date(lastFailure.at + BOOK_RETRY_AFTER_FAILURE_MS).toISOString() };
}

/**
 * A bitcoin offer: BASE_ASSET, with a satoshi total. The public list also
 * carries offers of other assets — on 2026-10-21 two Taproot-asset (USDT)
 * offers, no satoshi total, 39 and 14 fills, Amboss fee 350 — whose fills say
 * nothing about a bitcoin listing: kept, they fell into the 350-ppm cells and
 * their fills counted as sales of offers like this node's. No asset named
 * counts as bitcoin when there is a satoshi total.
 */
export const isBitcoinOffer = (o: Pick<PublicOffer, "assetType" | "totalSizeSats">): boolean =>
  (o.assetType ?? "BASE_ASSET") === "BASE_ASSET" && o.totalSizeSats > 0;

/** Join the legacy book (seller scores) with the public Magma list (fills,
 *  listing dates, Amboss fees). Only enabled bitcoin offers count — in the
 *  cells and in the fee tiers alike — and each id once, whatever the list
 *  repeated (getPublicOffers already reads each offer once; a count shown to
 *  the operator must not depend on it). */
export function joinBook(legacy: MagmaOffer[], live: PublicOffer[]): BookOffer[] {
  const byId = new Map(legacy.map((o) => [o.id, o]));
  const once = new Map(live.map((o) => [o.id, o]));
  return [...once.values()]
    .filter((o) => o.status === "ENABLED" && isBitcoinOffer(o))
    .map((o) => {
      const l = byId.get(o.id);
      return {
        id: o.id,
        sellerPubkey: o.sellerPubkey,
        totalSats: o.totalSizeSats,
        filledOrders: o.filledOrders,
        createdAt: o.createdAt,
        ambossFee: o.ambossFee,
        sellerScore: l ? l.sellerScore : null,
        ...(l ? { feeRatePpm: l.feeRatePpm, baseFeeSats: l.baseFeeSats } : {}),
      };
    });
}

/**
 * The public book for `ownPubkey`, from cache (a day) or Amboss. Throws when
 * Amboss can't be asked and nothing is cached; a stale copy is better than
 * none, so an outage keeps serving the last one (its date is shown). A failed
 * fetch is not repeated for BOOK_RETRY_AFTER_FAILURE_MS unless `force`.
 */
export async function publicBook(ownPubkey: string, force = false): Promise<PublicBook> {
  const cached = cachedBook && cachedBook.pubkey === ownPubkey ? cachedBook : null;
  if (!force && cached && Date.now() - cached.at < BOOK_TTL_MS) return cached.book;
  if (!force && publicBookFailure(ownPubkey)) {
    if (cached) return cached.book;
    throw lastFailure?.error ?? new Error("Amboss's public offer book could not be read");
  }
  const running = inFlight.get(ownPubkey);
  if (running) return running;
  const fetching = (async () => {
    try {
      const [legacy, live, own, rates] = await Promise.all([
        getOffers(),
        getPublicOffers(),
        // Its failure is no failure of the book — but it is said (a Tor exit
        // Amboss refuses would otherwise read as "no score yet").
        getNodeMarket(ownPubkey).catch((err: unknown) => ({
          sellerScore: null,
          confirmedSells: null,
          lookupError: { error: err instanceof Error ? err.message : String(err), via: torVia("amboss_public") },
        })),
        dollarRates(),
      ]);
      const book: PublicBook = {
        fetchedAt: new Date().toISOString(),
        offers: joinBook(legacy, live),
        inboundSatsPerUsd: rates.inboundSatsPerUsd,
        satsPerUsd: rates.satsPerUsd,
        own: { pubkey: ownPubkey, ...own },
      };
      cachedBook = { at: Date.now(), pubkey: ownPubkey, book };
      if (lastFailure?.pubkey === ownPubkey) lastFailure = null;
      return book;
    } catch (err) {
      lastFailure = { at: Date.now(), pubkey: ownPubkey, error: err };
      if (cachedBook && cachedBook.pubkey === ownPubkey) return cachedBook.book;
      throw err;
    } finally {
      inFlight.delete(ownPubkey);
    }
  })();
  inFlight.set(ownPubkey, fetching);
  return fetching;
}

/** Test seam: forget the cached book (and any failure being waited out). */
export function __resetEligibilityCache(): void {
  cachedBook = null;
  lastFailure = null;
  inFlight.clear();
}

/** Test seam: age the last failure, as if `ms` had passed since it. */
export function __ageBookFailureForTests(ms: number): void {
  if (lastFailure) lastFailure = { ...lastFailure, at: lastFailure.at - ms };
}

/** Test seam: age this node's cached book, as if `ms` had passed since it was read. */
export function __ageBookForTests(ownPubkey: string, ms: number): void {
  if (cachedBook && cachedBook.pubkey === ownPubkey) cachedBook = { ...cachedBook, at: cachedBook.at - ms };
}
