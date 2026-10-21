import type { LspOrder, LspStatus } from "./types";

/**
 * LSP mode in Settings and Market → Orders (review a4-lsp-payments:lsp-mode-
 * tor-only-reach and lsps1-rejects-zeus-client-info — package P5).
 *
 * Who can actually order here, said plainly. A wallet orders LSPS1 either
 * over Lightning peer messages (BOLT8, what LightningMate serves) or over
 * HTTPS (LSPS1 REST, which it doesn't). Checked against ZEUS v13.2.3 — the
 * one wallet known to order over peer messages, and only with its embedded
 * node: on a remote node or LNC it uses REST. Reaching a Tor-only LSP also
 * takes Tor on the buyer's side (ZEUS's embedded Tor is off by default) and
 * typing this node's key and .onion address in by hand. Before, the card
 * called the mode "beta", counted only get_info requests, promised that "any
 * LSPS1-capable wallet" works, and nudged a Tor-only node to announce a
 * clearnet address — which publishes the home IP for good.
 */

/** The node announces only .onion addresses (or none): reachable over Tor only. */
export const isTorOnly = (uris: readonly string[]): boolean => uris.every((u) => u.includes(".onion"));

/** Who can order from this node, in words. */
export function lspReachText(uris: readonly string[]): string {
  const http =
    "Wallets that order LSPS1 over HTTPS — ZEUS on a remote node or over LNC, LDK-based wallets — can't order here: " +
    "LightningMate answers LSPS1 only over Lightning peer messages.";
  if (isTorOnly(uris)) {
    return (
      "This node is reachable over Tor only, so very few wallets can order here. A buyer's wallet has to order over " +
      "Lightning peer messages and reach a .onion address: as far as we know, that is ZEUS with its embedded node and " +
      "ZEUS's embedded Tor switched on (it is off by default), with this node's key and .onion address typed in by hand. " +
      `${http} Expect few or no orders — LSP mode is experimental.`
    );
  }
  return (
    "Wallets that order over Lightning peer messages can reach this node at its announced address — as far as we know, " +
    `ZEUS with its embedded node, with this node's key and address typed in by hand. ${http} LSP mode is experimental.`
  );
}

/** What announcing a clearnet address gives away — shown above the field. */
export const CLEARNET_WARNING =
  "Announcing a clearnet address publishes it in the public Lightning graph: every node and explorer stores it with " +
  "your node's key, so your home IP address (or the one your DDNS name points to) is tied to this node for good — " +
  "withdrawing it later doesn't erase the copies others keep. Leave it empty to stay Tor-only.";

const shortMethod = (m: string): string => m.replace(/^lsps\d\./, "");

/** "get_info 3 · create_order 1" — requests answered, per method. */
export function lspServedLine(s: Pick<LspStatus, "requests">): string {
  const served = s.requests.filter((r) => r.served > 0 && r.method !== "other");
  return served.length ? served.map((r) => `${shortMethod(r.method)} ${r.served}`).join(" · ") : "none yet";
}

/** One line per method that refused requests: how often, and the last
 *  reason sent — a wallet whose every order is refused shows here. */
export function lspRefusalLines(s: Pick<LspStatus, "requests">): string[] {
  return s.requests
    .filter((r) => r.errors.length > 0)
    .map((r) => {
      const count = r.errors.reduce((n, e) => n + e.count, 0);
      const last = [...r.errors].sort((a, b) => b.lastAt.localeCompare(a.lastAt))[0];
      const name = r.method === "other" ? "unreadable or unknown requests" : shortMethod(r.method);
      return `${name}: ${count} refused — last: ${last.lastMessage || `error ${last.code}`} (${last.code})`;
    });
}

/** "client_info ×4" — parameters wallets sent that this LSP ignores (D14). */
export function lspIgnoredLine(s: Pick<LspStatus, "ignoredParams">): string | null {
  if (!s.ignoredParams.length) return null;
  return s.ignoredParams.map((p) => `${p.name} ×${p.count}`).join(", ");
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What recovery is waiting on LND for, each kind in its own words — null
 * when nothing. A refund LND refused (the buyer's payment still held) and a
 * channel opened whose payment LND hasn't claimed are not "orders waiting
 * after a restart": they happen while the app runs, and recovery tries them
 * again just the same.
 */
export function lspRecoveryLine(s: Pick<LspStatus, "recovery">): string | null {
  const r = s.recovery;
  if (!r.waiting) return null;
  const refunds = r.refunds ?? 0;
  const settles = r.settles ?? 0;
  const lookups = Math.max(0, r.waiting - refunds - settles);
  const parts = [
    settles ? `${count(settles, "channel is", "channels are")} open, but LND hasn't claimed the buyer's payment yet` : null,
    refunds ? `${count(refunds, "refund", "refunds")} not confirmed by LND yet — the buyer's payment stays held until it is` : null,
    lookups ? `${count(lookups, "order", "orders")} LND hasn't answered for yet — a held payment is opened or refunded once it does` : null,
  ].filter((p): p is string => p !== null);
  return `${parts.join("; ")}. Tried again automatically${r.lastError ? ` (LND's last answer: ${r.lastError})` : ""}.`;
}

/** A direct (LSPS1) sale's status in a few words. */
export function lspOrderLabel(o: LspOrder): string {
  if (o.orderState === "COMPLETED") return "Completed";
  if (o.orderState === "FAILED") {
    if (o.superseded) return "Replaced by a newer order";
    // Its payment is still held: the refund comes, but hasn't yet.
    if (o.refundPending) return "Failed · refund pending";
    // The channel was opened, the payment never claimed: given away.
    if (o.fundingOutpoint && o.paymentState !== "PAID") return "Failed · channel opened, payment lost";
    return o.paymentState === "REFUNDED" ? "Failed · refunded" : "Expired";
  }
  if (o.paymentState === "HOLD") {
    if (o.fundingOutpoint) return "Channel opened · claiming the payment";
    return o.waitingForBuyerSince ? "Paid · waiting for the buyer to come online" : "Paid · opening channel";
  }
  return "Awaiting payment";
}

/** The buyer guide the card copies: how to order, and who can't. */
export function lspBuyerGuide(uri: string): string {
  const onion = uri.includes(".onion");
  return [
    "Buy an inbound Lightning channel directly from my node (LSPS1 / bLIP-51):",
    "",
    `Node URI: ${uri}${onion ? " (reachable over Tor only)" : ""}`,
    "",
    "In ZEUS with its embedded node: Settings → Lightning Service Provider → set this node as your",
    'LSPS1 provider (pubkey@host), then Channels → "Purchase Inbound".',
    ...(onion ? ["The address is a .onion one: switch on ZEUS's embedded Tor first."] : []),
    "Your wallet must order over Lightning peer messages — ordering over HTTPS",
    "(ZEUS on a remote node or LNC) doesn't work with this node.",
  ].join("\n");
}
