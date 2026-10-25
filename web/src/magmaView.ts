import type {
  AutopilotConfig,
  BuyOffer,
  BuyQuote,
  CheckStatus,
  Eligibility,
  EligibilityVerdict,
  LeaseBenchmark,
  MagmaOrderLocal,
  MagmaPurchase,
  MagmaV2Report,
  MyOffer,
  OfferControl,
  OfferSyncStatus,
  PurchaseState,
} from "./types";

/**
 * The words and small decisions behind the Magma views (Market → Buy / Sell /
 * Orders, the Liquidity provision switch, the Overview) — pure, so they are
 * tested without a browser. Everything shown about selling is either a live
 * number from Amboss or this node, or labelled as what it is (an inference,
 * Amboss's documentation): Amboss decides which seller gets an order, and the
 * app says so instead of promising sales.
 */

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

export const VERDICT: Record<EligibilityVerdict, { label: string; tone: "bad" | "slow" | "good" | "unknown" }> = {
  not_realistic: { label: "Not realistic yet", tone: "bad" },
  possible_but_slow: { label: "Possible, but slow", tone: "slow" },
  realistic: { label: "Realistic", tone: "good" },
  unknown: { label: "Unknown", tone: "unknown" },
};

/** D11: what the seller score is — and that settings can't raise it. */
export const SELLER_SCORE_COPY =
  "Amboss computes the seller score from reliability, speed and track record of completed Magma orders; settings cannot raise it.";

/** What switching Liquidity provision on means — whatever the check says. */
const ENABLE_SELLING_TERMS =
  "Amboss decides which seller gets an order — mostly sellers with a track record; LightningMate can make fulfilment correct and reliable, " +
  "not make Amboss pick you. With Liquidity provision on, the order lane accepts (with a hold invoice), opens and rejects orders on its own, " +
  "within your caps, and keeps your offer fundable. Routing opens of the channel autopilot then wait for the coins your offer can list " +
  "(within your deploy cap) while selling them is expected to earn more than a routing channel; the rest stays free for them.";

/**
 * The confirmation before Liquidity provision is switched ON (D9): the
 * eligibility verdict with its live numbers, and what switching on does.
 */
export function enableSellingMessage(e: Eligibility | null): string {
  const verdict = e ? VERDICT[e.verdict].label : "Unknown";
  const evidence = e?.reasons[0] ?? "The selling check could not be made right now.";
  const expect =
    e && e.expectedSalesPerYear !== null
      ? ` Offers like yours sell about ${e.expectedSalesPerYear < 1 ? "less than once" : `${e.expectedSalesPerYear.toFixed(1)} times`} a year.`
      : "";
  return `Can this node sell on Magma? ${verdict}. ${evidence}${expect} ${ENABLE_SELLING_TERMS}`;
}

/** The same confirmation while the check is still running: the dialog opens
 *  at once — the check takes as long as Amboss does (up to its deadline). */
export function enableSellingPendingMessage(): string {
  return `Can this node sell on Magma? Checking Amboss's public offer book… ${ENABLE_SELLING_TERMS}`;
}

/** What switching Liquidity provision on does with the offers disabled now
 *  (`disabled`: how many the server will list — those its last offer sync
 *  showed disabled and Amboss still does; null when that couldn't be told):
 *  the autopilot lists them again — the switch-off disabled them — each once
 *  its smallest channel can be funded and it has its price, written first:
 *  the autopilot's current one where it prices the offer (it waits for one),
 *  the offer's own where its terms are yours or auto-pricing is off. Empty
 *  when none is to be listed. */
export function enableSellingOffersMessage(disabled: number | null): string {
  const how =
    "once its smallest channel can be funded and it has its price — the autopilot's current price where it prices the offer " +
    "(until it has one, the offer waits), the offer's own price where you set its terms or auto-pricing is off.";
  const after = '"Keep disabled" on Market → Sell keeps one off.';
  if (disabled === 0) return "";
  if (disabled === null) return `Your offers that are disabled now are listed again, each ${how} ${after}`;
  return disabled === 1 ? `Your disabled offer is listed again ${how} ${after}` : `Your ${disabled} disabled offers are listed again, each ${how} ${after}`;
}

/** How many offers switching selling on will list again, decided as the
 *  server does (autopilot.ts applySwitchOn): those its last offer sync showed
 *  disabled and Amboss still does — with no sync kept yet, every one disabled
 *  now. Null: the sync couldn't be read (the count would be a guess). */
export function offersSwitchOnLists(
  live: Pick<MyOffer, "id" | "status">[],
  sync: Pick<OfferSyncStatus, "at" | "offers"> | null,
): number | null {
  if (!sync) return null;
  const disabledNow = live.filter((o) => o.status === "DISABLED");
  if (!sync.at) return disabledNow.length;
  const wasDisabled = new Set(sync.offers.filter((e) => e.amboss.status === "DISABLED").map((e) => e.offerId));
  return disabledNow.filter((o) => wasDisabled.has(o.id)).length;
}

/** The same line while the offers are still being read from Amboss. */
export function enableSellingOffersPendingMessage(): string {
  return "Checking your offers on Amboss…";
}

/** The confirmation before Liquidity provision is switched OFF while offers
 *  are still listed: orders would then wait for a decision nobody makes. */
export function disableSellingMessage(enabledOffers: number): string {
  if (enabledOffers <= 0) return "Turn off Liquidity provision? Orders already in flight are still finished (settled or refunded).";
  const which = enabledOffers === 1 ? "Your offer is" : `${enabledOffers} offers are`;
  return (
    `${which} still listed on Amboss. With Liquidity provision off, new orders wait for your decision on Market → Orders — ` +
    "and Amboss counts an order nobody decides against your seller score. Disable the offer too?"
  );
}

/** Amboss's order statuses in plain words, as the side this node is on sees
 *  them (review a6-ux:nav-a11y-copy: Market → Orders showed the raw enums,
 *  "WAITING_FOR_SELLER_APPROVAL"). */
const SELL_STATUS: Record<string, string> = {
  WAITING_FOR_SELLER_APPROVAL: "Waiting for you to accept",
  WAITING_FOR_BUYER_PAYMENT: "Accepted — waiting for the buyer to pay",
  WAITING_FOR_CHANNEL_OPEN: "Paid — waiting for you to open the channel",
  SELLER_SENT_TRANSACTION: "Channel opened — reported to Amboss",
  SELLER_OPENED_CHANNEL: "Channel opened",
  WAITING_FOR_ON_CHAIN_CONFIRMATION: "Channel confirming on-chain",
  ON_CHAIN_CONFIRMATION: "Channel confirming on-chain",
  VALID_CHANNEL_OPENING: "Channel confirmed — lease running",
  CHANNEL_MONITORING_FINISHED: "Lease over",
  SELLER_REJECTED: "Rejected (by you or the autopilot)",
  SELLER_FAILED_TO_REACT: "Expired — not accepted or rejected in time",
  SELLER_FAILED_TO_OPEN_CHANNEL: "Failed — the channel wasn't opened in time",
  SELLER_FAILED_TO_SEND_SWAP: "Failed — the swap wasn't sent",
  BUYER_FAILED_TO_PAY: "The buyer didn't pay",
  BUYER_REJECTED: "Cancelled by the buyer",
  INVALID_CHANNEL_OPENING: "The channel didn't match the order — the buyer was refunded",
  ADMIN_CLOSED: "Closed by Amboss",
};
const BUY_STATUS: Record<string, string> = {
  WAITING_FOR_SELLER_APPROVAL: "Waiting for the seller to accept",
  WAITING_FOR_BUYER_PAYMENT: "Waiting for your payment",
  WAITING_FOR_CHANNEL_OPEN: "Paid — waiting for the seller to open the channel",
  SELLER_SENT_TRANSACTION: "The seller opened the channel",
  SELLER_OPENED_CHANNEL: "The seller opened the channel",
  SELLER_REJECTED: "Rejected by the seller",
  SELLER_FAILED_TO_REACT: "Expired — the seller didn't answer in time",
  SELLER_FAILED_TO_OPEN_CHANNEL: "Failed — the seller didn't open the channel",
  BUYER_FAILED_TO_PAY: "Not paid in time",
  BUYER_REJECTED: "Cancelled by you",
};

/** An order's status in plain words, for the side this node is on. A paid
 *  sale says who opens its channel: the order lane (`opensItself`, from the
 *  server — with Liquidity provision on, or an order the lane accepted
 *  itself), or you (review of P7: "waiting for you to open the channel"
 *  showed while the lane was opening it). */
export function orderStatusLabel(status: string, side: "SELL" | "BUY" | string, opensItself = false): string {
  if (side !== "BUY" && status === "WAITING_FOR_CHANNEL_OPEN" && opensItself) return "Paid — the autopilot opens the channel";
  const words = (side === "BUY" ? BUY_STATUS[status] : undefined) ?? SELL_STATUS[status];
  if (words) return words;
  // A status this version doesn't know yet: readable all the same.
  const plain = status.toLowerCase().replace(/_/g, " ");
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

/** The toast after an order is accepted by hand: who opens its channel
 *  once the buyer has paid — the order lane (Liquidity provision on), or
 *  you ("Open channel"). */
export function acceptedToast(opensItself: boolean): string {
  return opensItself
    ? "Order accepted — the autopilot opens the channel once the buyer has paid."
    : "Order accepted — open the channel once the buyer has paid.";
}

/** This node's own record of an order, in a few words. */
export function localLabel(local: Pick<MagmaOrderLocal, "phase" | "booked" | "external">): string {
  if (local.external === "accepted_elsewhere") return "accepted outside LightningMate";
  if (local.external === "other_node") return "another node's order";
  if (local.phase === "settled") return local.booked === false ? "completed · not booked (no payment of ours)" : "completed · payment settled";
  const labels: Record<string, string> = {
    seen: "seen",
    accepting: "accepting…",
    accepted: "accepted · awaiting payment",
    held: "paid (held) · channel to open",
    opening: "opening channel…",
    funded: "channel opened · reporting to Amboss",
    reported: "channel reported · awaiting confirmation",
    cancelled: "cancelled · buyer refunded",
    rejected: "rejected",
    failed: "failed",
  };
  return labels[local.phase] ?? local.phase;
}

/** Who sets an offer's terms, as the Sell tab says it — and who decides
 *  whether it is listed (your last click; capital safety aside). */
export function offerOwner(control: OfferControl | undefined, sellEnabled: boolean): { label: string; yours: boolean; title: string } {
  const listing = control?.disabledByHandAt
    ? " You disabled it: it stays disabled until you enable it (or switch Liquidity provision off and on again)."
    : control?.listOnAt
      ? ' Liquidity provision was switched on with it disabled: the autopilot lists it once it has a price and its smallest channel can be funded ("keep disabled" keeps it off).'
      : control?.autoDisabledAt
        ? " The autopilot disabled it for lack of capital and lists it again once it can be funded."
        : "";
  if (control?.manual) {
    return {
      label: "yours",
      yours: true,
      title:
        `You took this offer over (${control.manual.why}) — the autopilot changes none of its terms; it only keeps it fundable ` +
        `(disabled while its smallest channel can't be funded, listed again once it can).${listing}`,
    };
  }
  if (!sellEnabled) return { label: "not managed", yours: false, title: `Liquidity provision is off: nothing manages this offer.${listing}` };
  return { label: "autopilot", yours: false, title: `Managed by the autopilot (as your Automation settings say).${listing}` };
}

/**
 * The base fee move the autopilot has pending for an offer, said where the
 * base fee is shown (2026-10-25: the move waited a day and nothing on the page
 * said so — the 0 that 0.8.0 left looked like the autopilot's choice). Only
 * for an offer the autopilot prices: "→ 284 at 16:14", "→ 284 next run", or
 * null when its base is where comparable offers' is. `time` formats the
 * moment (local time; the date too when it isn't today).
 */
export function baseFeeFollow(
  o: Pick<MyOffer, "id" | "baseFeeSats">,
  report: Pick<MagmaV2Report, "sell"> | null | undefined,
  autoPriced: boolean,
  time: (iso: string) => string = localMoment,
): { cell: string; title: string } | null {
  if (!autoPriced) return null;
  const r = report?.sell.recommendations.find((x) => x.offerId === o.id);
  if (!r?.baseFeeDiffers || r.baseFeeMarketSat == null || r.baseFeeMarketSat === o.baseFeeSats) return null;
  const market = r.baseFeeMarketSat;
  const when = r.baseFeeFollowsAt ? `at ${time(r.baseFeeFollowsAt)}` : "next run";
  return {
    cell: `→ ${market} ${when}`,
    title:
      `Comparable offers charge ${market} sat base; the autopilot moves this offer's base there ${r.baseFeeFollowsAt ? `at ${time(r.baseFeeFollowsAt)}` : "at its next run"} ` +
      "— right away when the base is far off, else once the market's has held for 1.5 h, and at most once every 6 h. " +
      "The rate makes up the rest, so a channel of the offer's typical size costs the same.",
  };
}

/** "16:14" today, "Mon 16:14" on another day (local time). */
function localMoment(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`;
}

/** The Sell tab's "keep disabled" for an offer a switch-on is to list
 *  (OfferControl.listOnAt): the click records a disable by hand, so the
 *  autopilot leaves it off. Null for any other offer — one that is listed is
 *  disabled with "disable". */
export function keepDisabledAction(o: Pick<MyOffer, "status">, control: OfferControl | undefined): { label: string; title: string } | null {
  if (o.status !== "DISABLED" || !control?.listOnAt) return null;
  return {
    label: "keep disabled",
    title:
      "Liquidity provision was switched on with this offer disabled: the autopilot lists it once it has a price and its smallest channel " +
      "can be funded. Keep it off instead — it stays disabled until you enable it, or switch selling off and on again.",
  };
}

export interface OfferDraft {
  totalSizeSats: number;
  minSizeSats: number;
  maxSizeSats: number;
  feeRatePpm: number;
  baseFeeSats: number;
  minBlockLength: number;
}

/** The standard lease (D7): 30 days. min_block_length is a minimum, so it
 *  serves longer leases too. */
export const STANDARD_LEASE_BLOCKS = 4320;

/**
 * The Sell form's starting terms: the engine's recommendation — its price and
 * the lease that price is for (the standard for a new offer), a window from
 * the smallest channel that pays for itself up to what can be funded within
 * the caps — never sizes the autopilot would turn down (it used to default to
 * a 1M–5M window, 5M listed, and a 4032-block lease, under a 2M deploy cap).
 */
export function offerDraftDefaults(
  rec: MagmaV2Report | null,
  caps: Pick<AutopilotConfig, "sellMaxChannelSats" | "sellMaxDeploySats"> | null,
): OfferDraft {
  const ceiling = Math.min(caps?.sellMaxChannelSats ?? Infinity, caps?.sellMaxDeploySats ?? Infinity, rec?.sell.effectiveMaxOrderSat ?? Infinity);
  const minSize = rec?.sell.recommendedMinSizeSat ?? 1_000_000;
  const maxSize = Math.max(minSize, Math.min(rec?.sell.recommendedMaxSizeSat ?? 2_000_000, Number.isFinite(ceiling) ? ceiling : 2_000_000));
  const create = rec?.sell.recommendations.find((r) => r.mode === "create") ?? rec?.sell.recommendations[0];
  return {
    totalSizeSats: maxSize,
    minSizeSats: Math.min(minSize, maxSize),
    maxSizeSats: maxSize,
    feeRatePpm: create?.recommended.feeRatePpm ?? 3000,
    // (A base of 0 is a price — the market's, where comparable offers charge none.)
    baseFeeSats: create?.recommended.baseFeeSat ?? 1000,
    // The lease its price is for: a price and a lease belong together.
    minBlockLength: create?.recommended.minBlockLength ?? rec?.sell.standardLeaseBlocks ?? STANDARD_LEASE_BLOCKS,
  };
}

/** The lease lengths buyers order (blocks): 30, 60, 90 and 180 days. */
export const COMMON_LEASES: readonly number[] = [4320, 8640, 12960, 25920];

/** A lease worth keeping: one buyers order, at least the standard (a longer
 *  minimum still serves its buyers — 90-day leases on purpose stay). Anything
 *  else — the old 4,032-block default, a shorter one — becomes the standard. */
export function leaseToKeep(blocks: number, standard = STANDARD_LEASE_BLOCKS): number {
  return COMMON_LEASES.includes(blocks) && blocks >= standard ? blocks : standard;
}

/** Said before an offer is saved with a lease buyers don't use — saving it by
 *  hand makes the offer yours, so the autopilot won't correct it later. */
export function leaseWarning(blocks: number, standard = STANDARD_LEASE_BLOCKS): string | null {
  if (leaseToKeep(blocks, standard) === blocks) return null;
  return (
    ` Its lease of ${fmt(blocks)} blocks is not one buyers use — the standard is ${fmt(standard)} blocks (30 days); ` +
    "saved by hand, the autopilot won't correct it."
  );
}

/**
 * The edit draft a price button opens on an existing offer (it used to copy
 * only the fee): the price, and the lease that price is for — `leaseBlocks`,
 * the engine's recommended.minBlockLength for this offer. That is a lease
 * buyers use: the standard (an odd lease like 4,032 blocks, frozen in for
 * good once a save makes the offer the operator's, becomes it), or a longer
 * one chosen on purpose, which stays — priced as such. (For a while the
 * buttons kept a 90-day lease but filled in the engine's 30-day price: a
 * third of what the lease is worth, below its profit floor.) "Apply
 * recommended" (`full`) applies the engine's window too, clamped to what can
 * be funded and the caps, as the new-offer form does.
 */
export function priceDraft(
  offer: Pick<OfferDraft, "totalSizeSats" | "minSizeSats" | "maxSizeSats" | "minBlockLength">,
  price: { feeRatePpm: number; baseFeeSat: number },
  leaseBlocks: number,
  rec: MagmaV2Report | null,
  caps: Pick<AutopilotConfig, "sellMaxChannelSats" | "sellMaxDeploySats"> | null,
  full: boolean,
): OfferDraft {
  const window = full && rec ? offerDraftDefaults(rec, caps) : offer;
  return {
    minSizeSats: window.minSizeSats,
    maxSizeSats: window.maxSizeSats,
    totalSizeSats: Math.max(offer.totalSizeSats, window.maxSizeSats),
    feeRatePpm: price.feeRatePpm,
    baseFeeSats: price.baseFeeSat,
    minBlockLength: leaseBlocks,
  };
}

/** Said before an offer is saved whose lease isn't the one its price was
 *  worked out for (the lease edited after a price button): a longer lease at
 *  a shorter one's price undercharges for it. Null: they match, or no price
 *  button set the price. */
export function pricedLeaseWarning(blocks: number, pricedForBlocks: number | null): string | null {
  if (pricedForBlocks === null || blocks <= pricedForBlocks) return null;
  return (
    ` Its price was worked out for a ${fmt(pricedForBlocks)}-block lease, and it promises ${fmt(blocks)} blocks — ` +
    "a longer lease at that price may sit below its profit floor: raise the price with the lease (about in proportion to its length)."
  );
}

/** Market → Sell's summary of the engine's verdict — per sale. Where offers
 *  like this node's don't sell (or that is unknown), "priced to beat routing"
 *  is no reason to list: it says so next to the per-sale line. */
export function sellSummary(rec: MagmaV2Report, e: Eligibility | null): { label: string; line: string; good: boolean } {
  const label = SUMMARY_LABEL[rec.sell.state];
  const line = rec.sell.reasons[0] ?? rec.nodeNeedReason;
  if (rec.sell.state !== "good_to_sell") return { label, line, good: false };
  if (e?.verdict === "possible_but_slow" || e?.verdict === "realistic") return { label, line, good: true };
  const why = e?.verdict === "not_realistic" ? "offers like yours don't sell" : "whether orders come at all is unknown";
  return { label: "Per sale only", line: `${line} — but ${why} (see "Can this node sell on Magma?"), so this alone is no reason to list`, good: false };
}

export const SUMMARY_LABEL: Record<MagmaV2Report["sell"]["state"], string> = {
  good_to_sell: "Priced to beat routing",
  sell_only_above_profit_floor: "Sell above floor only",
  market_too_cheap: "Market too cheap right now",
  insufficient_capital: "Not enough idle capital",
};

/** A form whose window the autopilot would turn orders away from (with
 *  selling on): say so before it is listed. */
export function offerSizeWarning(
  draft: Pick<OfferDraft, "maxSizeSats">,
  config: Pick<AutopilotConfig, "sellEnabled" | "sellMaxChannelSats" | "sellMaxDeploySats"> | null,
  fundableSat: number | null,
): string | null {
  if (!config?.sellEnabled) return null;
  const limits = [
    { sat: config.sellMaxChannelSats, what: "your max channel size" },
    { sat: config.sellMaxDeploySats, what: "your capital cap" },
    ...(fundableSat !== null ? [{ sat: fundableSat, what: "what your wallet can fund now" }] : []),
  ];
  const binding = limits.reduce((a, b) => (b.sat < a.sat ? b : a));
  if (draft.maxSizeSats <= binding.sat) return null;
  return `Channels above ${fmt(binding.sat)} sat (${binding.what}) would be turned down by the autopilot — lower the max channel, or raise the limit.`;
}

/** The buy confirmation: what is paid, for what lease and fee promise. */
export function buyConfirmMessage(q: BuyQuote, offer: Pick<BuyOffer, "sellerPubkey" | "leaseDays" | "feeRateCapPpm" | "baseFeeCapSats"> | null): string {
  const size = q.channelSizeSats > 0 ? `a ${fmt(q.channelSizeSats)} sat inbound channel` : "an inbound channel";
  const leaseDays = q.leaseBlocks ? Math.round(q.leaseBlocks / 144) : offer?.leaseDays;
  const lease = leaseDays ? ` for at least ${leaseDays} days` : "";
  const capPpm = q.feeRateCapPpm ?? offer?.feeRateCapPpm ?? null;
  const capBase = q.baseFeeCapSats ?? offer?.baseFeeCapSats ?? null;
  const promise =
    capPpm !== null && capPpm > 0
      ? ` The seller promises to keep its routing fee at or below ${fmt(capPpm)} ppm${capBase !== null ? ` + ${capBase} sat` : ""} for the lease.`
      : offer
        ? " The seller promises no routing-fee cap — the inbound is only as useful as their fee allows."
        : "";
  const amboss = q.ambossFeeSats ? ` (incl. ${fmt(q.ambossFeeSats)} sat Amboss fee)` : "";
  const who = offer
    ? `Seller ${offer.sellerPubkey.slice(0, 12)}… opens the channel to your node.`
    : "Amboss picks the seller, who then opens the channel to your node.";
  return `Pay a one-time ${fmt(q.sats)} sat fee${amboss} for ${size}${lease}? ${who}${promise} If you decline, the order is cancelled on Amboss. This is a real Lightning payment.`;
}

/** A purchase's state in a few words. A failure only the pay call reported
 *  (a dropped stream, a restart) is not called a failure: the order lane
 *  asks LND how the payment really ended. */
export function purchaseLabel(p: Pick<MagmaPurchase, "state" | "failureConfirmed">): string {
  if (p.state === "pay_failed" && !p.failureConfirmed) return "payment unclear · checking with LND";
  return PURCHASE_LABEL[p.state] ?? p.state;
}

export const PURCHASE_LABEL: Record<PurchaseState, string> = {
  quoted: "quoted · not paid",
  declined: "declined · cancelled on Amboss",
  cancel_failed: "declined · not paid (Amboss didn't confirm the cancel)",
  paying: "paying…",
  paid: "paid · waiting for the seller's channel",
  pay_failed: "payment failed",
  channel_open: "channel open",
  order_failed: "failed on Amboss · refunded",
};

/** The Overview's lease benchmark line (D12): live, or that selling isn't
 *  realistic for this node — never a constant. */
export function leaseBenchmarkLine(b: LeaseBenchmark | undefined): string | null {
  if (!b || b.status === "unknown") return null;
  // What buyers paid — a seller nets less (on-chain costs, the service fee).
  if (b.status === "eligible" && b.grossAprPct !== null) return `Magma lease ≈ ${b.grossAprPct}%/yr (gross, buyer-paid)`;
  if (b.status === "not_realistic") return "Magma selling: not realistic for this node yet";
  return null;
}

export const CHECK_MARK: Record<CheckStatus, string> = { ok: "✓", problem: "✗", info: "ℹ", unknown: "?" };

/** What each pricing mode really does (m3-sellpath:misleading-ui: "Low" did
 *  not undercut; "Auto" no longer steps down for lack of sales — but it does
 *  follow the market down, so it doesn't say "never lowers"). */
export const PRICING_MODES: { id: AutopilotConfig["sellPricingMode"]; label: string; desc: string }[] = [
  {
    id: "auto",
    label: "Auto",
    desc:
      "between the 25th and 75th percentile of what buyers actually paid: starts in the middle and steps up after each sale — it never steps down on its own, " +
      "but it follows the market: when buyers pay less, your price comes down with it (never below your profit floor)",
  },
  { id: "fast", label: "Low", desc: "the low end of what buyers actually paid (their 25th percentile) — never below your profit floor" },
  { id: "balanced", label: "Median", desc: "the median of what buyers actually paid" },
  { id: "premium", label: "Premium", desc: "the top of what buyers paid (75th percentile)" },
];

/**
 * Autopilot → Magma's note on who decides what about an offer — what the
 * offer upkeep really does (autopilot.ts): an edit or create by hand makes the
 * terms yours; a status click only lists or unlists (it never takes the terms
 * over); the routing-fee promise comes with auto-size; and with every
 * offer-automation switch off, capital safety is all that touches an offer.
 * (It used to say a disable by hand made the offer yours, and that every
 * offer carried the promise — written even with every switch off.)
 */
export const OFFER_AUTOMATION_HINT =
  "An offer you edit or create by hand on Market → Sell is yours: the autopilot leaves its terms alone (it only keeps it fundable) " +
  "until you hand it back. Enabling or disabling an offer by hand decides only whether it is listed — a disable sticks while " +
  "Liquidity provision stays on (switching it on lists your disabled offers again; \"keep disabled\" on Market → Sell keeps one off). " +
  "With auto-size on, every offer the autopilot manages promises buyers a routing-fee cap for the lease (offers you create or edit " +
  "on Market → Sell always do); with every switch above off, the autopilot only keeps your offers fundable. The fee autopilot keeps " +
  "each sold channel within the cap its order locked.";

/** A Magma order-refusal line for the Overview digest (null: none). */
export function refusalDigest(count: number | undefined, reason: string | null | undefined): string | null {
  if (!count) return null;
  return `${count} Magma order${count === 1 ? "" : "s"} turned down in the last 2 days${reason ? ` — ${reason}` : ""}`;
}

/**
 * The Close tab's hint to list the capital a close frees on Magma — only
 * where this node can realistically sell (D8). For a node whose comparable
 * offers don't sell, one sale's lease rate advertised a feature that brings it
 * no orders (m4: per-sale margin is not expected value).
 */
export function freedCapitalMagmaHint(
  rec: MagmaV2Report | null,
  e: Eligibility | null,
  freedSat: number,
  /** What your deploy cap still lets Magma sell (null: unknown). */
  roomSat: number | null = null,
): string | null {
  const r0 = rec?.sell.recommendations[0];
  if (!rec || !r0 || freedSat <= 0 || !e) return null;
  if (e.verdict !== "possible_but_slow" && e.verdict !== "realistic") return null;
  if (!r0.economics.beatsRouting) return null;
  // Never an invitation to close more than Magma may take (review
  // 2026-10-25): the deploy cap reached, no hint; part of it, that part.
  if (roomSat !== null && roomSat <= 0) return null;
  const cap = roomSat !== null && roomSat < freedSat ? ` — your deploy cap lets Magma take ~${fmt(roomSat)} sat of it` : "";
  const sales = e.expectedSalesPerYear !== null ? `; offers like yours sell about ${e.expectedSalesPerYear.toFixed(1)} times a year` : "";
  // leaseApy is NET (after on-chain costs and the service fee), per sale.
  return (
    `Closing these frees ~${fmt(freedSat)} sat${cap}. One Magma sale at today's price nets ~${r0.economics.leaseApy}%/yr ` +
    `(after on-chain costs and the service fee), against ~${(rec.sell.adjustedRoutingPpmPerYear / 10_000).toFixed(2)}% routing${sales} — see Market → Sell.`
  );
}
