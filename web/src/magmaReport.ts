import { api } from "./api";
import type { MagmaV2Report } from "./types";

/**
 * The Magma report, fetched once and shared by every view that shows it
 * (review a6-ux:polling-and-stale-data: seven components each fetched it —
 * two on opening Market, Market → Orders again every 30 s — and each fetch
 * is four Amboss calls plus LND's channels, chain and 30 days of flow). A
 * fetch under way is shared; a copy younger than `maxAgeMs` is reused; a
 * failed fetch is not kept. After something the report shows was changed
 * here (the Magma caps saved, an offer written), forgetMagmaReport() makes
 * the next view fetch afresh. (The server shares its own read for a minute
 * too.)
 */
let entry: { at: number; report: Promise<MagmaV2Report> } | null = null;

/** How long a fetched report is reused by default. */
export const MAGMA_REPORT_MAX_AGE_MS = 60_000;

export function sharedMagmaReport(maxAgeMs = MAGMA_REPORT_MAX_AGE_MS, fetch: () => Promise<MagmaV2Report> = api.magmaRecommendations): Promise<MagmaV2Report> {
  const now = Date.now();
  if (entry && now - entry.at < maxAgeMs) return entry.report;
  const mine = { at: now, report: fetch() };
  entry = mine;
  mine.report.catch(() => {
    if (entry === mine) entry = null;
  });
  return mine.report;
}

/** The next view fetches afresh (and the server reads afresh: it forgets
 *  its own copy when an offer is written or the settings change). */
export function forgetMagmaReport(): void {
  entry = null;
}

/** A view's copy of the report: the report, when it was got, and why the
 *  last refresh failed (null: it didn't). */
export interface ReportView {
  report: MagmaV2Report | null;
  at: number | null;
  error: string | null;
}

export const EMPTY_REPORT_VIEW: ReportView = { report: null, at: null, error: null };

/** A refresh got the report. */
export function reportLoaded(report: MagmaV2Report, nowMs = Date.now()): ReportView {
  return { report, at: nowMs, error: null };
}

/** A refresh failed: the last report stays, shown as of when it was got,
 *  with the error beside it (review of P7: Market → Sell's minute refresh
 *  blanked the whole market card when one read failed). */
export function reportRefreshFailed(view: ReportView, err: unknown): ReportView {
  return { ...view, error: err instanceof Error ? err.message : String(err) };
}

/** What the view says about a failed refresh — with what it still shows,
 *  and from when (null: nothing failed). */
export function reportErrorText(view: ReportView): string | null {
  if (!view.error) return null;
  if (!view.report || view.at === null) return `The market picture couldn't be worked out right now: ${view.error}`;
  const at = new Date(view.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Couldn't refresh the market picture (${view.error}) — what follows is from ${at}.`;
}
