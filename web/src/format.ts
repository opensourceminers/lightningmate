const nf = new Intl.NumberFormat("en-US");

/** Format a sat amount with thousands separators, e.g. 1234567 → "1,234,567". */
export function sats(value: number): string {
  return nf.format(Math.round(value));
}

/** Compact sat amount for tight spaces, e.g. 1234567 → "1.23M". */
export function satsCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}G`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return nf.format(Math.round(value));
}

/** 0..1 → "62%". */
export function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

const FIAT_SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", CHF: "CHF " };

/** Fiat value of a sat amount, or null when fiat is off / price unknown. */
export function fiat(sats: number, btcPrice: number | null, currency: string): string | null {
  if (!btcPrice || currency === "off") return null;
  const value = (sats / 100_000_000) * btcPrice;
  const symbol = FIAT_SYMBOL[currency] ?? "";
  const digits = Math.abs(value) >= 1000 ? 0 : 2;
  return `${symbol}${value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
