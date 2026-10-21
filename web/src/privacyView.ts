import type { PrivacyInfo, TorRoute } from "./types";

/**
 * Settings → Privacy (review a3-channels:lnplus-clearnet-lookups, package
 * P4): the node is Tor-only, LightningMate's own lookups are not the node's —
 * where they go, and by which route, said plainly. Before, Settings claimed
 * the BTC price was "the only outbound request it makes", while LN+ (this
 * node's own pubkey included) and Amboss went out from the home IP address.
 */
export const TOR_ROUTES: { id: TorRoute; label: string; desc: string }[] = [
  {
    id: "lookups",
    label: "Lookups via Tor",
    desc: "LN+ and the BTC price go through Tor. Amboss and the service-fee lookup go direct: Amboss knows your account anyway, and its orders have deadlines Tor can make tight.",
  },
  {
    id: "all",
    label: "Everything via Tor",
    desc: "Amboss and the service-fee lookup go through Tor too — slower, and a service may refuse some Tor exits.",
  },
  {
    id: "direct",
    label: "Direct",
    desc: "Nothing through Tor — for a lookup service that blocks Tor exits. Everything leaves from this server's IP address.",
  },
];

/** The card's headline: is there a Tor proxy, and what goes through it. */
export function privacySummary(p: PrivacyInfo): string {
  if (!p.torProxy) {
    return (
      "Your node is Tor-only, but LightningMate's own lookups are not the node's: no Tor proxy is available to this app, " +
      "so they leave from this server's internet connection — your home IP address. Switch off what you don't need."
    );
  }
  const route = TOR_ROUTES.find((r) => r.id === p.torRoute) ?? TOR_ROUTES[0];
  return `Umbrel's Tor proxy is available (${p.torProxy}). ${route.desc}`;
}

/** One destination, as the card lists it. */
export function destinationLine(d: PrivacyInfo["destinations"][number]): string {
  const how = !d.active ? "not used now" : d.viaTor ? "through Tor" : "direct, from this server's IP address";
  return `${d.service} — ${d.what}: ${how}`;
}
