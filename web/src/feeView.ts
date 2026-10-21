import type {
  AutopilotChange,
  ChannelOverride,
  FeeMode,
  FeeRecMetrics,
  FeeRecommendation,
  OutcomesReport,
  UnservedDemandReport,
} from "./types";
import { timeAgo } from "./format";

/**
 * The fee pages' decisions, apart from the components so they can be tested
 * (review a6/a5): what a fee override control does on a mode change, how a
 * pin typed by hand is read, what the Apply button sends, and how unserved
 * demand and fee outcomes are worded.
 */

/** One set of labels for the override modes, on both tables. */
export const OVERRIDE_LABELS: Record<FeeMode, string> = {
  auto: "auto",
  fixed: "fixed",
  exclude: "excluded",
};
export const OVERRIDE_HINTS: Record<FeeMode, string> = {
  auto: "the autopilot manages this channel's fee",
  // Saving a pin writes nothing to the node: fee automation applies it on its
  // next run, or Apply on the Fees tab does (review: "applied exactly as set"
  // read as if saving it changed the fee — with automation off, nothing did).
  fixed: "pin a fee: fee automation (or Apply on the Fees tab) sets it exactly as typed, then holds it",
  exclude: "the autopilot never touches this channel's fee (except to keep a sold channel's fee promise)",
};

/** The most a pin can be (as the server checks it). */
export const MAX_PIN_PPM = 50_000;

/** What a "fixed" input starts with: the stored pin, else what the channel
 *  charges now — never a made-up 100 ppm. Empty when neither is known. */
export function pinSeed(ov: ChannelOverride | undefined, currentPpm: number | null | undefined): string {
  if (ov?.mode === "fixed" && ov.fixedPpm != null) return String(ov.fixedPpm);
  return currentPpm != null ? String(currentPpm) : "";
}

/** A pin as typed: a whole number of ppm in 0–50,000. Blank or garbage is an
 *  error to show, never a 0 (or 100) ppm pin. */
export function parsePin(text: string): { ok: true; value: number } | { ok: false; error: string } {
  const t = text.trim();
  if (t === "") return { ok: false, error: "Enter a fee in ppm to pin." };
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > MAX_PIN_PPM) {
    return { ok: false, error: `A pinned fee is a whole number of ppm between 0 and ${MAX_PIN_PPM.toLocaleString("en-US")}.` };
  }
  return { ok: true, value: n };
}

/**
 * What choosing a mode does. "auto" and "exclude" are saved at once. "fixed"
 * saves NOTHING yet: it opens the input with the current fee, and the pin is
 * saved when the operator confirms a value (before, choosing "fixed" pinned
 * 100 ppm at once — a protected 800 ppm channel could drop to 100).
 */
export function onModeChange(
  mode: FeeMode,
  ov: ChannelOverride | undefined,
  currentPpm: number | null | undefined,
): { save: { mode: FeeMode; fixedPpm?: number } } | { edit: string } {
  if (mode === "fixed") return { edit: pinSeed(ov, currentPpm) };
  return { save: { mode } };
}

/** "120 ppm · 1 sat base" — what a channel charges (base fee only when set). */
export function feeText(ppm: number | null | undefined, baseMsat: number | null | undefined): string {
  if (ppm == null) return "—";
  const base = baseMsat ? ` · ${baseMsat % 1000 === 0 ? `${baseMsat / 1000} sat` : `${baseMsat} msat`} base` : "";
  return `${ppm} ppm${base}`;
}

/**
 * What "Neutral ppm" does (review 3). A fee goes up only on a drain signal,
 * so raising Neutral ppm no longer lifts a balanced channel by itself — the
 * field label ("balanced") suggested it did.
 */
export const NEUTRAL_PPM_HINT =
  "Neutral ppm is a ceiling for balanced channels, not a price they are raised to: raising it doesn't raise a channel that routes at a lower fee (that one is held); it lowers balanced channels priced above it, and the balance curve starts from it for drained and full channels. Only a drain signal or a floor prices a balanced channel above it.";

/** The market into a channel's peer, as the Fees tab shows it: "~200 ppm
 *  (3 channels)". A remembered reference — the latest graph had none for the
 *  peer (its inbound channels disabled after an outage, say) — says when it
 *  was last seen. */
export function marketRefText(m: Pick<FeeRecMetrics, "marketPpm" | "marketSamples" | "marketSeenAt">): string {
  if (m.marketPpm == null) return "—";
  return `~${m.marketPpm} ppm (${m.marketSamples} channels${m.marketSeenAt ? `, last seen ${timeAgo(m.marketSeenAt)}` : ""})`;
}

/** The base-fee part of a recommendation, when it changes. */
export function baseChange(r: Pick<FeeRecommendation, "currentBaseMsat" | "recommendedBaseMsat">): string | null {
  return r.currentBaseMsat !== r.recommendedBaseMsat ? `base ${r.currentBaseMsat}→${r.recommendedBaseMsat} msat` : null;
}

/** What "Apply N" sends: the channels whose rows would change — the server
 *  recomputes them and applies the engine's target AND base fee. */
export function applyChannelIds(recs: Pick<FeeRecommendation, "channelId" | "wouldApply" | "transactionId" | "transactionVout">[]): string[] {
  return recs.filter((r) => r.wouldApply && r.transactionId !== null && r.transactionVout !== null).map((r) => r.channelId);
}

/** One fee change as the run history lists it — with its reason. */
export function historyFeeLine(c: AutopilotChange): string {
  const base = c.fromBaseMsat != null && c.toBaseMsat != null && c.fromBaseMsat !== c.toBaseMsat ? `, base ${c.fromBaseMsat}→${c.toBaseMsat} msat` : "";
  const who = c.via === "manual" ? " (by hand)" : c.via === "lease" ? " (lease promise)" : "";
  return `Fee · ${c.alias}: ${c.fromPpm}→${c.toPpm} ppm${base}${who}`;
}

/** Days of telemetry before the unserved-demand banner says anything. */
export const MIN_DEMAND_DAYS = 3;

const DAY_MS = 86_400_000;
const lastDays = (n: number) => `the last ${Number.isInteger(n) ? n : n.toFixed(1)} days`;

export interface DemandSummary {
  /** What there is to say:
   *  - "sorting": refusals have been sorted for less than MIN_DEMAND_DAYS
   *    (after an update, telemetry ran for weeks before sorting began) —
   *    no claim about demand either way;
   *  - "demand": attempts a refilled channel could have carried;
   *  - "none": nothing like that, and every refusal was sorted;
   *  - "none_unsorted": none among those sorted, but some could not be. */
  kind: "sorting" | "demand" | "none" | "none_unsorted";
  /** Distinct attempts a refilled channel could have carried. */
  attempts: number;
  sats: number;
  missedFeesSats: number;
  /** Raw refusals and what was taken out. */
  raw: number;
  probes: number;
  retries: number;
  oversized: number;
  unclassified: number;
  /** The window the sorted (de-noised) figures cover — since sorting began,
   *  at most the report's: "the last 4.5 days". */
  window: string;
  /** The window the raw refusals cover (since telemetry began). */
  rawWindow: string;
  /** Since when refusals are sorted (null: not reported). */
  classifiedSince: string | null;
}

/**
 * The unserved-demand banner (D20, review a5): only after MIN_DEMAND_DAYS of
 * data, only the de-noised attempts as "possible demand", and what was taken
 * out said next to it. Before, it summed every refused HTLC — probes ~92% of
 * the volume — as "demand worth X sat you didn't earn on", and read "7d"
 * during the first day (trackedDays 0 || days).
 *
 * The de-noised figures exist only since refusals are sorted
 * (`classifiedSince`): on an updated install the telemetry ran for weeks
 * before that, so their window and the 3-day gate count from there — an hour
 * after the update, 34 refusals all from before it no longer read "no payment
 * a refilled channel could have carried was turned away in the last 7 days".
 */
export function demandSummary(report: UnservedDemandReport | null, nowMs = Date.now()): DemandSummary | null {
  if (!report || report.trackedDays < MIN_DEMAND_DAYS) return null;
  const sum = (f: (c: UnservedDemandReport["channels"][number]) => number) => report.channels.reduce((s, c) => s + f(c), 0);
  const raw = sum((c) => c.liquidityCount);
  if (raw === 0) return null;
  const rawDays = Math.min(report.days, report.trackedDays);
  const since = report.classifiedSince ? Date.parse(report.classifiedSince) : NaN;
  const sortedDays = Number.isFinite(since) ? Math.max(0, Math.floor(((nowMs - since) / DAY_MS) * 10) / 10) : rawDays;
  const covered = Math.min(rawDays, sortedDays);
  const attempts = sum((c) => c.demandCount);
  const unclassified = sum((c) => c.unclassifiedCount);
  return {
    kind: covered < MIN_DEMAND_DAYS ? "sorting" : attempts > 0 ? "demand" : unclassified > 0 ? "none_unsorted" : "none",
    attempts,
    sats: sum((c) => c.demandSats),
    missedFeesSats: sum((c) => c.missedFeesSats),
    raw,
    probes: sum((c) => c.probeCount),
    retries: sum((c) => c.retryCount),
    oversized: sum((c) => c.oversizedCount),
    unclassified,
    window: lastDays(covered),
    rawWindow: lastDays(rawDays),
    classifiedSince: report.classifiedSince ?? null,
  };
}

/**
 * The banner's headline when there is possible demand: refused HTLCs a
 * refilled channel could have carried — never "payments turned away" (D20;
 * P3 review: the de-noising is a heuristic, these are not proven payments).
 */
export function demandHeadline(d: Pick<DemandSummary, "attempts" | "window">): string {
  return `${d.attempts} refused HTLC${d.attempts === 1 ? "" : "s"} in ${d.window} that a refilled channel could have carried`;
}

/**
 * The "Fee tuning" figure on Analytics (review a5): a number only over at
 * least `minMeasured` changes that earned something before, revenue-weighted
 * — coloured only then — and always how many changes it rests on.
 */
export function feeTuningKpi(o: OutcomesReport | null): { value: string; unit?: string; tone?: "green" | "cost"; sub: string } {
  if (!o) return { value: "—", sub: "no data yet" };
  const f = o.fees;
  const pending = f.pending ? ` · ${f.pending} too recent` : "";
  if (f.avgRevenueDeltaPct == null) {
    return {
      value: "—",
      sub: f.measured > 0 ? `${f.measurable} of ${f.minMeasured} changes needed${pending}` : `no measured change yet${pending}`,
    };
  }
  const pct = Math.round(f.avgRevenueDeltaPct * 100);
  return {
    value: `${pct >= 0 ? "+" : ""}${pct}`,
    unit: "% rev",
    tone: pct >= 0 ? "green" : "cost",
    sub: `${f.measurable} changes · ${f.confidence} confidence`,
  };
}
