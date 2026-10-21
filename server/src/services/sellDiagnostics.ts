import type { LaneStatus } from "./magmaDesk.js";
import type { MyOffer, MyOrder } from "./magmaApi.js";
import type { MagmaV2Report } from "./magmaRecommend.js";
import type { OfferControl, OfferSyncStatus, OfferWrite } from "./autopilot.js";
import type { Eligibility } from "./magmaEligibility.js";
import type { OfferFeeCaps } from "./leaseCaps.js";
import { ORDER_FAILED } from "./amboss.js";
import { priceFitsLease } from "./magmaHistory.js";

/**
 * "Why don't I sell?" — answered automatically (m3-sellpath:diagnosis-checklist,
 * a6-ux:sell-diagnosis-hidden). The review found eleven gates that could leave
 * an offer untouched or unsold, and the only way to tell them apart was a
 * numbered list of things to check by hand across four screens and the
 * container logs: which version runs, is write mode on, is the key valid, is
 * Liquidity provision on, did the last offer write land, does the offer on
 * Amboss carry what the engine wants, did orders arrive and how did they end.
 *
 * Each check here is one of those questions, answered from the live state,
 * with what to do about it. Pure: the route gathers the inputs (each may be
 * missing — a check that can't be answered says so, never "ok").
 */

export type CheckStatus = "ok" | "problem" | "info" | "unknown";

export interface DiagnosticCheck {
  id: string;
  status: CheckStatus;
  label: string;
  detail: string;
  /** Where to fix it in the app. */
  fix?: { tab: string; sub?: string; label: string };
}

export interface OfferTermsView {
  status: string;
  feeRatePpm: number;
  baseFeeSats: number;
  minSizeSats: number;
  maxSizeSats: number;
  minBlockLength: number;
  feeRateCapPpm: number | null;
  baseFeeCapSats: number | null;
}

export interface OfferDiagnosis {
  offerId: string;
  /** Who sets its terms: the autopilot, you (you took it over), or nobody
   *  (Liquidity provision off). */
  owner: "autopilot" | "you" | "nobody";
  amboss: OfferTermsView;
  /** What the engine would list: its price, the lease that price is for
   *  (the standard, or a longer one buyers use that the offer keeps), the fee
   *  promise, a window up to what can be funded. */
  target: Omit<OfferTermsView, "status"> | null;
  /** Where Amboss differs from the target, in words. */
  differences: string[];
  lastWrite: OfferWrite | null;
}

export interface SellDiagnostics {
  generatedAt: string;
  checks: DiagnosticCheck[];
  offers: OfferDiagnosis[];
  orders: {
    recent: {
      orderId: string;
      sizeSats: number;
      phase: string;
      seenAt: string;
      at: string;
      action: string;
      reason: string | null;
    }[];
    /** Orders on Amboss that ended badly, by status (90 days). Null: unknown. */
    failedOnAmboss: Record<string, number> | null;
  };
  lane: LaneStatus;
  eligibility: Eligibility | null;
}

export interface DiagnosticsInput {
  version: string;
  canWrite: boolean;
  key: { connected: boolean; valid: boolean | null; check: string; lastError: string | null };
  config: {
    sellEnabled: boolean;
    sellAutoReprice: boolean;
    sellAutoSize: boolean;
    sellAutoRelist: boolean;
    sellAutoClose: boolean;
    sellPricingMode: string;
  };
  lane: LaneStatus;
  sync: OfferSyncStatus;
  controls: Record<string, OfferControl>;
  /** This node's offers as Amboss has them (null: could not be read). */
  offers: MyOffer[] | null;
  offersError: string | null;
  rec: MagmaV2Report | null;
  recError: string | null;
  feeCaps: OfferFeeCaps;
  recentOrders: SellDiagnostics["orders"]["recent"];
  /** This node's sales on Amboss (null: could not be read). */
  sales: MyOrder[] | null;
  eligibility: Eligibility | null;
  /** This node's public channels (null: LND could not be read). */
  node?: { publicChannels: number; capacitySat: number } | null;
  nowMs?: number;
}

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

function termsOf(o: MyOffer): OfferTermsView {
  return {
    status: o.status,
    feeRatePpm: o.feeRatePpm,
    baseFeeSats: o.baseFeeSats,
    minSizeSats: o.minSizeSats,
    maxSizeSats: o.maxSizeSats,
    minBlockLength: o.minBlockLength,
    feeRateCapPpm: o.feeRateCapPpm,
    baseFeeCapSats: o.baseFeeCapSats,
  };
}

/** One offer against what the engine would list. */
function diagnoseOffer(o: MyOffer, input: DiagnosticsInput): OfferDiagnosis {
  const control = input.controls[o.id] ?? {};
  const owner: OfferDiagnosis["owner"] = control.manual ? "you" : input.config.sellEnabled ? "autopilot" : "nobody";
  const r = input.rec?.sell.recommendations.find((x) => x.offerId === o.id) ?? null;
  const sell = input.rec?.sell ?? null;
  // The lease the engine priced this offer for: the standard, or a longer one
  // buyers use that the offer keeps (a 90-day lease chosen on purpose is not
  // a deviation — and its price is the 90-day one).
  const lease = r?.recommended.minBlockLength ?? sell?.standardLeaseBlocks ?? null;
  const target = r && sell && lease !== null
    ? {
        feeRatePpm: r.recommended.feeRatePpm,
        baseFeeSats: r.recommended.baseFeeSat,
        minSizeSats: sell.recommendedMinSizeSat,
        maxSizeSats: Math.max(sell.recommendedMinSizeSat, Math.min(sell.recommendedMaxSizeSat, sell.effectiveMaxOrderSat)),
        minBlockLength: lease,
        feeRateCapPpm: input.feeCaps.feeRateCapPpm,
        baseFeeCapSats: input.feeCaps.baseFeeCapSats,
      }
    : null;
  const differences: string[] = [];
  if (lease !== null && o.minBlockLength !== lease) {
    differences.push(`lease: Amboss has ${fmt(o.minBlockLength)} blocks, the standard is ${fmt(lease)}`);
  }
  if (o.feeRateCapPpm === null || o.feeRateCapPpm <= 0) {
    differences.push(`fee promise: none on Amboss — the standard is ${fmt(input.feeCaps.feeRateCapPpm)} ppm + ${input.feeCaps.baseFeeCapSats} sat base`);
  } else if (o.feeRateCapPpm !== input.feeCaps.feeRateCapPpm || o.baseFeeCapSats !== input.feeCaps.baseFeeCapSats) {
    differences.push(
      `fee promise: Amboss has ${fmt(o.feeRateCapPpm)} ppm + ${o.baseFeeCapSats ?? "—"} sat, the standard is ${fmt(input.feeCaps.feeRateCapPpm)} ppm + ${input.feeCaps.baseFeeCapSats} sat`,
    );
  }
  if (r && (r.recommended.feeRatePpm !== o.feeRatePpm || r.recommended.baseFeeSat !== o.baseFeeSats)) {
    const cur = r.current?.effectiveFeePpm;
    // The autopilot puts a price only on the lease it fits (autopilot.ts
    // wantedTerms, priceFitsLease): with auto-size off an offer keeps its
    // lease, and a price for a shorter one would undercharge it.
    const leaseAfter = input.config.sellAutoSize && owner === "autopilot" ? r.recommended.minBlockLength : o.minBlockLength;
    const why = !(input.config.sellAutoReprice && owner === "autopilot")
      ? " — auto-pricing is off for it, so the price stays yours"
      : !priceFitsLease(r.recommended.minBlockLength, leaseAfter)
        ? ` — not applied: that price is for a ${fmt(r.recommended.minBlockLength)}-block lease, and with auto-size off this offer keeps its ` +
          `${fmt(o.minBlockLength)} blocks (turn on auto-size, or edit the offer on Market → Sell)`
        : "";
    differences.push(
      `price: Amboss has ${fmt(o.feeRatePpm)} ppm + ${fmt(o.baseFeeSats)} sat${cur !== undefined ? ` (${fmt(cur)} ppm effective)` : ""}, ` +
        `the engine would list ${fmt(r.recommended.feeRatePpm)} ppm + ${fmt(r.recommended.baseFeeSat)} sat (${fmt(r.recommended.effectiveFeePpm)} ppm effective ` +
        `for ${fmt(r.recommended.minBlockLength)} blocks)${why}`,
    );
  }
  if (sell && o.status === "ENABLED" && o.maxSizeSats > sell.effectiveMaxOrderSat) {
    differences.push(`max channel: Amboss offers ${fmt(o.maxSizeSats)} sat, only ${fmt(sell.effectiveMaxOrderSat)} sat can be funded now`);
  }
  // The window as a whole, against the engine's (from the smallest channel
  // that pays for itself up to what can be funded). Information, not a fault:
  // the window is offer hygiene, not what gets an offer picked (D19) — only
  // a max above what can be funded (above) is a problem.
  if (target && (o.minSizeSats !== target.minSizeSats || o.maxSizeSats !== target.maxSizeSats)) {
    differences.push(
      `window: Amboss has ${fmt(o.minSizeSats)}–${fmt(o.maxSizeSats)} sat, the engine's target is ` +
        `${fmt(target.minSizeSats)}–${fmt(target.maxSizeSats)} sat (from the smallest channel that pays for itself up to what can be funded)`,
    );
  }
  const lastWrite = input.sync.offers.find((e) => e.offerId === o.id)?.lastWrite ?? null;
  return { offerId: o.id, owner, amboss: termsOf(o), target, differences, lastWrite };
}

/** The checklist, from the live state. */
export function buildSellDiagnostics(input: DiagnosticsInput): SellDiagnostics {
  const now = input.nowMs ?? Date.now();
  const checks: DiagnosticCheck[] = [];
  const add = (c: DiagnosticCheck) => checks.push(c);
  const offers = input.offers ?? [];
  const enabled = offers.filter((o) => o.status === "ENABLED");

  add({ id: "version", status: "info", label: "Version", detail: `LightningMate ${input.version} is running.` });

  add(
    input.canWrite
      ? { id: "write", status: "ok", label: "Write mode", detail: "On — the autopilot can act on offers and orders." }
      : {
          id: "write",
          status: "problem",
          label: "Write mode",
          detail: "Off — nothing can be accepted, opened or listed. Set LM_ENABLE_WRITE=true with an admin macaroon (on Umbrel it is found automatically).",
        },
  );

  if (!input.key.connected) {
    add({ id: "key", status: "problem", label: "Amboss key", detail: "No key connected — offers and orders can't be managed.", fix: { tab: "settings", label: "Connect Amboss" } });
  } else if (input.key.valid === false) {
    add({ id: "key", status: "problem", label: "Amboss key", detail: "Amboss rejects the key (expired or revoked).", fix: { tab: "settings", label: "Connect a fresh key" } });
  } else if (input.key.check === "unreachable") {
    add({ id: "key", status: "unknown", label: "Amboss key", detail: `Amboss can't be reached right now${input.key.lastError ? ` (${input.key.lastError})` : ""} — the last verdict stands.` });
  } else {
    add({ id: "key", status: input.key.valid ? "ok" : "unknown", label: "Amboss key", detail: input.key.valid ? "Valid." : "Not checked yet." });
  }

  const c = input.config;
  if (c.sellEnabled) {
    add({
      id: "provision",
      status: input.canWrite ? "ok" : "problem",
      label: "Liquidity provision",
      detail: input.canWrite
        ? "On — the order lane accepts, opens and rejects orders; the offer is kept fundable."
        : "On, but it can't run: write mode is off.",
      fix: { tab: "autopilot", sub: "magma", label: "Autopilot → Magma" },
    });
  } else {
    add({
      id: "provision",
      status: enabled.length > 0 ? "problem" : "info",
      label: "Liquidity provision",
      detail:
        enabled.length > 0
          ? "Off while an offer is listed: new orders wait for your decision on Market → Orders, and time out if nobody decides — which Amboss counts against your seller score. Turn it on, or disable the offer."
          : "Off — selling is off (the default).",
      fix: { tab: "autopilot", sub: "magma", label: "Autopilot → Magma" },
    });
  }
  const autos = [
    c.sellAutoReprice ? `auto-price (${c.sellPricingMode})` : null,
    c.sellAutoSize ? "auto-size (standard lease and routing-fee promise, sane window)" : null,
    c.sellAutoRelist ? "auto-relist" : null,
    c.sellAutoClose ? "auto-close after the lease" : null,
  ].filter(Boolean);
  add({
    id: "automation",
    status: "info",
    label: "Offer automation",
    detail: autos.length ? `On: ${autos.join(", ")}.` : "All off — the offer's terms are yours; only the capital limits apply.",
  });

  const lane = input.lane;
  add(
    lane.ok === false
      ? { id: "lane", status: "problem", label: "Order lane", detail: `${lane.error ?? "failed"}${lane.retrying === false ? "" : " — retrying"}.`, fix: { tab: "market", sub: "orders", label: "Market → Orders" } }
      : lane.lastTickAt === null
        ? { id: "lane", status: "unknown", label: "Order lane", detail: "Has not run yet." }
        : { id: "lane", status: "ok", label: "Order lane", detail: lane.idle ? `Idle: ${lane.idle}.` : `Last pass ${new Date(lane.lastTickAt).toISOString()}: no problem.` },
  );

  if (input.offers === null) {
    add({ id: "offer", status: "unknown", label: "Your offer", detail: `Could not read your offers from Amboss${input.offersError ? ` (${input.offersError})` : ""}.` });
  } else if (enabled.length === 0) {
    add({
      id: "offer",
      status: offers.length ? "problem" : "info",
      label: "Your offer",
      detail: offers.length
        ? `No enabled offer: ${offers.map((o) => `${o.id.slice(0, 8)}… is ${o.status}`).join(", ")} — buyers can't order from you.`
        : "No offer listed.",
      fix: { tab: "market", sub: "sell", label: "Market → Sell" },
    });
  } else {
    add({ id: "offer", status: "ok", label: "Your offer", detail: `${enabled.length} enabled offer${enabled.length === 1 ? "" : "s"} listed.` });
  }

  const failedWrite = input.sync.offers.find((e) => !e.inSync && e.lastWrite && (!e.lastWrite.ok || e.lastWrite.verified === false));
  if (failedWrite?.lastWrite) {
    add({
      id: "write-result",
      status: "problem",
      label: "Last offer write",
      detail: `The ${failedWrite.lastWrite.by === "manual" ? "manual" : "autopilot's"} ${failedWrite.lastWrite.action} of ${failedWrite.offerId.slice(0, 8)}… did not land: ${failedWrite.lastWrite.error ?? "Amboss did not store the change"}.`,
    });
  } else {
    const last = input.sync.offers.map((e) => e.lastWrite).filter((w): w is OfferWrite => !!w).sort((a, b) => b.at.localeCompare(a.at))[0];
    add({
      id: "write-result",
      status: last ? "ok" : "info",
      label: "Last offer write",
      detail: last ? `${last.action} by ${last.by === "manual" ? "you" : "the autopilot"} at ${last.at}: landed${last.verified ? " (read back)" : ""}.` : "None recorded yet.",
    });
    if (input.sync.lastError) {
      add({ id: "upkeep", status: "problem", label: "Offer upkeep", detail: `${input.sync.lastError.message} (${input.sync.lastError.at}).` });
    }
  }

  const diagnosed = offers.map((o) => diagnoseOffer(o, input));
  for (const d of diagnosed.filter((x) => x.amboss.status === "ENABLED")) {
    const hygiene = d.differences.filter((t) => /^(lease|fee promise|max channel):/.test(t));
    add({
      id: `terms:${d.offerId}`,
      status: hygiene.length ? "problem" : input.rec ? "ok" : "unknown",
      label: `Offer ${d.offerId.slice(0, 8)}… terms`,
      detail: !input.rec
        ? `The engine's target is unavailable${input.recError ? ` (${input.recError})` : ""}.`
        : d.differences.length
          ? `${d.differences.join("; ")}.${
              d.owner === "you"
                ? " You took this offer over: the autopilot leaves its terms to you."
                : d.owner === "autopilot" && c.sellAutoSize
                  ? " The autopilot corrects the lease and promise at its next run."
                  : d.owner === "autopilot"
                    ? " Auto-size is off: the autopilot leaves the lease and the fee promise as they are."
                    : ""
            }`
          : "Matches the engine's target (price, window, lease, fee promise).",
      fix: { tab: "market", sub: "sell", label: "Market → Sell" },
    });
  }

  const e = input.eligibility;
  add(
    !e || e.verdict === "unknown"
      ? { id: "eligibility", status: "unknown", label: "Can this node sell?", detail: e?.reasons[0] ?? "Not checked yet." }
      : {
          id: "eligibility",
          status: e.verdict === "not_realistic" ? "problem" : e.verdict === "possible_but_slow" ? "info" : "ok",
          label: "Can this node sell?",
          detail:
            `${e.verdict === "not_realistic" ? "Not realistic yet" : e.verdict === "possible_but_slow" ? "Possible, but slow" : "Realistic"} — ` +
            `${e.reasons[0] ?? ""} (Indicative: Amboss's matching isn't public.)`,
        },
  );

  // m1-matching: Amboss names reliability, uptime and connectivity among the
  // signals it picks sellers by. Connectivity is this node's channels — a
  // node-strategy matter, never an offer setting; shown so the picture is whole.
  if (input.node) {
    add({
      id: "node",
      status: "info",
      label: "Your node in the network",
      detail:
        `${input.node.publicChannels} public channel${input.node.publicChannels === 1 ? "" : "s"}, ${fmt(input.node.capacitySat)} sat capacity. ` +
        "Amboss weighs reliability and connectivity when it picks a seller; connectivity grows only with well-connected public channels. " +
        "(Amboss's Terminal ranking is not checked here.)",
    });
  }

  // m1-matching: Amboss's buy button sizes orders in dollars ($5 up) — an
  // offer whose largest channel is smaller can only take fixed-size orders.
  if (e?.usdOrders) {
    add({
      id: "usd-orders",
      status: e.usdOrders.fits ? "ok" : "problem",
      label: "Dollar-sized buy orders",
      detail: e.reasons.find((r) => r.startsWith("Amboss sizes its buy-button orders")) ?? "",
    });
  }

  const failedOnAmboss = input.sales
    ? input.sales
        .filter((s) => ORDER_FAILED.has(s.status) && now - Date.parse(s.createdAt) <= 90 * 86_400_000)
        .reduce<Record<string, number>>((m, s) => ({ ...m, [s.status]: (m[s.status] ?? 0) + 1 }), {})
    : null;
  const recent = input.recentOrders;
  const fails = failedOnAmboss ? Object.entries(failedOnAmboss) : [];
  const ourFault = fails.filter(([st]) => st.startsWith("SELLER_FAILED"));
  add({
    id: "orders",
    status: ourFault.length ? "problem" : recent.length || fails.length ? "info" : "info",
    label: "Orders",
    detail: [
      recent.length
        ? `Last order seen ${recent.reduce((a, b) => (a.seenAt > b.seenAt ? a : b)).seenAt}; latest: ${recent[0].orderId.slice(0, 8)}… ${recent[0].action}${recent[0].reason ? ` (${recent[0].reason})` : ""}.`
        : "No order has reached this node yet.",
      failedOnAmboss === null
        ? "Amboss's sales list could not be read."
        : fails.length
          ? `Ended badly on Amboss (90 days): ${fails.map(([st, k]) => `${k}× ${st}`).join(", ")}.`
          : "No order ended badly on Amboss (90 days).",
    ].join(" "),
    fix: { tab: "market", sub: "orders", label: "Market → Orders" },
  });

  return {
    generatedAt: new Date(now).toISOString(),
    checks,
    offers: diagnosed,
    orders: { recent, failedOnAmboss },
    lane,
    eligibility: e,
  };
}
