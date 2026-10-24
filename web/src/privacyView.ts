import type { PrivacyInfo } from "./types";

/**
 * Settings → Privacy (review a3-channels:lnplus-clearnet-lookups, package
 * P4): the node is Tor-only, and so are LightningMate's own lookups — every
 * one through Umbrel's Tor proxy (server/src/services/http.ts). Before 0.8.5
 * the operator chose a route, and the Amboss calls made with the API key and
 * the service-fee lookup went direct by default; before P4, Settings claimed
 * the BTC price was "the only outbound request it makes", while LN+ (this
 * node's own pubkey included) and Amboss went out from the home IP address.
 */

/** The card's headline: is there a Tor proxy — then everything goes through it. */
export function privacySummary(p: PrivacyInfo): string {
  if (!p.torProxy) {
    return (
      "Your node is Tor-only, but LightningMate's own lookups are not the node's: no Tor proxy is available to this app, " +
      "so they leave from this server's internet connection — your home IP address. Switch off what you don't need."
    );
  }
  return `Every lookup goes through Umbrel's Tor proxy (${p.torProxy}) — none leaves from this server's IP address.`;
}

/** One destination, as the card lists it. */
export function destinationLine(d: PrivacyInfo["destinations"][number]): string {
  const how = !d.active ? "not used now" : d.viaTor ? "through Tor" : "direct, from this server's IP address";
  return `${d.service} — ${d.what}: ${how}`;
}

/** Why LN+ lookups leave from this server's IP (null when they go through
 *  Tor): the app has no Tor proxy. */
export function lnplusDirectNote(s: { viaTor: boolean }): string | null {
  return s.viaTor ? null : "LN+ lookups leave from this server's IP address (no Tor proxy — see Settings → Privacy).";
}
