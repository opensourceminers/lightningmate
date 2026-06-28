import type {
  SecurityActionType,
  SecurityCategory,
  SecurityRecommendation,
  SecurityRecommendationPriority,
  SecuritySeverity,
} from "./types.js";

/** Severity ordering — higher is worse. */
const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  healthy: 0,
  warning: 1,
  critical: 2,
};

export function severityRank(s: SecuritySeverity): number {
  return SEVERITY_RANK[s];
}

/** Return the worst (highest-rank) severity of the given list. */
export function worstSeverity(
  severities: SecuritySeverity[],
  fallback: SecuritySeverity = "healthy",
): SecuritySeverity {
  return severities.reduce<SecuritySeverity>(
    (worst, s) => (severityRank(s) > severityRank(worst) ? s : worst),
    fallback,
  );
}

/** Map a 0..100 score to a severity using healthy/warning thresholds. */
export function severityFromScore(
  score: number,
  thresholds: { healthy: number; warning: number },
): SecuritySeverity {
  if (score >= thresholds.healthy) return "healthy";
  if (score >= thresholds.warning) return "warning";
  return "critical";
}

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clampScore(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

/** Safe ratio that never divides by zero or returns NaN. */
export function safeRatio(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : 0;
}

/** Hours between two ISO timestamps (absolute). */
export function hoursBetween(aIso: string, bIso: string): number {
  const a = new Date(aIso).getTime();
  const b = new Date(bIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.abs(b - a) / (1000 * 60 * 60);
}

const SAT_FORMATTER = new Intl.NumberFormat("en-US");

/** Format sats with thousands separators, e.g. 1234567 -> "1,234,567 sat". */
export function formatSat(sats: number | undefined): string {
  if (sats === undefined || Number.isNaN(sats)) return "—";
  return `${SAT_FORMATTER.format(Math.round(sats))} sat`;
}

/** Shorten a 66-char pubkey to "abcd…wxyz" for display. */
export function shortPubkey(pubkey: string | undefined): string {
  if (!pubkey) return "unknown";
  if (pubkey.length <= 14) return pubkey;
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-6)}`;
}

/** Build a SecurityRecommendation with a stable id. */
export function makeRecommendation(input: {
  id: string;
  category: SecurityCategory;
  priority: SecurityRecommendationPriority;
  title: string;
  description: string;
  actionType: SecurityActionType;
  relatedChannelIds?: string[];
  reasons?: string[];
  warnings?: string[];
}): SecurityRecommendation {
  return {
    id: input.id,
    category: input.category,
    priority: input.priority,
    title: input.title,
    description: input.description,
    actionType: input.actionType,
    relatedChannelIds: input.relatedChannelIds,
    reasons: input.reasons ?? [],
    warnings: input.warnings ?? [],
  };
}
