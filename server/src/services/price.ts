import type { FiatCurrency } from "./settings.js";

interface PriceCache {
  at: number;
  currency: string;
  price: number;
}
let cache: PriceCache | undefined;

const TTL_MS = 5 * 60_000;

/**
 * Current BTC price in the given fiat currency, or null when fiat is off.
 * Fetched from mempool.space (bitcoin-native) and cached for 5 min. This is the
 * only outbound network call in the app, and only happens when the user opts in
 * to a currency.
 */
export async function getBtcPrice(currency: FiatCurrency): Promise<number | null> {
  if (currency === "off") return null;
  if (cache && cache.currency === currency && Date.now() - cache.at < TTL_MS) {
    return cache.price;
  }
  try {
    const res = await fetch("https://mempool.space/api/v1/prices");
    if (!res.ok) throw new Error(`price http ${res.status}`);
    const data = (await res.json()) as Record<string, number>;
    const price = data[currency];
    if (typeof price === "number" && price > 0) {
      cache = { at: Date.now(), currency, price };
      return price;
    }
    return null;
  } catch {
    // Fall back to a stale cached value if we have one for this currency.
    return cache && cache.currency === currency ? cache.price : null;
  }
}
