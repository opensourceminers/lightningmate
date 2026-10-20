import type { NumberBounds } from "./types";

export type NumParse = { ok: true; value: number } | { ok: false; error: string };

export const rangeText = (b: NumberBounds): string => `${b.min}–${b.max}${b.integer ? "" : ", decimals allowed"}`;

/**
 * Parse what the user typed into a numeric setting, against the server's
 * bounds. A blank field is an error — never 0. (It used to become 0, and for
 * several settings 0 meant "unlimited", "no reserve" or "run every minute".)
 */
export function parseNumField(text: string, b: NumberBounds | undefined, label: string): NumParse {
  const t = text.trim();
  if (t === "") return { ok: false, error: `${label}: enter a value${b ? ` (${rangeText(b)})` : ""}` };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, error: `${label}: "${t}" is not a number` };
  if (b) {
    if (b.integer && !Number.isInteger(n)) return { ok: false, error: `${label}: use a whole number (${rangeText(b)})` };
    if (n < b.min || n > b.max) return { ok: false, error: `${label}: must be ${rangeText(b)}` };
  }
  return { ok: true, value: n };
}
