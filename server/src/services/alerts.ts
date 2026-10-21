import type { AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { getNodeSummary } from "./node.js";
import { storeIncidents, type StoreIncident } from "../store.js";
import type { ServiceFeeLedger } from "./serviceFee.js";

export interface Alert {
  level: "warn" | "info";
  message: string;
  /** Set on alerts the operator acknowledges (dismisses) explicitly; derived
   *  node alerts have none and disappear on their own. */
  id?: string;
}

const LOW_ONCHAIN_SATS = 25_000;

/** What losing each state file means for the operator, in plain words. */
const RESET_CONSEQUENCE: Record<string, string> = {
  "autopilot.json": "All automation is OFF and settings are back to defaults until you set them again.",
  "lsps1-orders.json": "LSP orders that were in progress can no longer be tracked — check them in LND.",
  "amboss.json": "Reconnect your Amboss key in Settings.",
  "overrides.json": "Per-channel fee overrides (incl. exclusions) are gone — re-check them on the Channels tab.",
  "settings.json": "Check your Settings (LSP mode, currency, privacy: LN+ lookups and the Tor route).",
  "channel-uptime.json": "How long each channel's peer has been offline is counted again from now — no channel counts as long offline until it has been for 72 hours.",
  "magma-amboss-leases.json":
    "The last list of older Magma sales Amboss reports with a running lease is fetched again (with an Amboss key set) — until then, such a sale's channel is not marked as leased.",
  "service-fees.json": "Pending service-fee records were lost.",
  "magma-purchases.json":
    "The record of inbound you bought on Magma was lost — the channels are not affected; P&L no longer shows those purchases.",
  "magma-orders.json":
    "Magma orders in progress lost their record, and with it what claims their held payments. No channel is opened " +
    "for such an order: when Amboss asks for one, its held payment is released back to the buyer instead (LND releases " +
    "any other before it expires), and nothing is booked as a sale. Check Market → Orders and your channels in LND for " +
    "channels already opened for them — those can no longer be paid for.",
};

/** What an "adjusted" file holds, in plain words, for the alert text. */
const ADJUSTED_WHAT: Record<string, string> = {
  "autopilot.json": "Saved autopilot settings",
  "overrides.json": "Fees pinned by hand",
};

function incidentMessage(i: StoreIncident): string {
  // A missing file names the most recent damaged copy found beside it, which
  // may stem from an earlier incident — say so rather than claim it is this one.
  const kept = !i.quarantinedAs
    ? undefined
    : i.missing
      ? `The most recent damaged copy is kept as ${i.quarantinedAs}.`
      : `The damaged copy was saved as ${i.quarantinedAs}.`;
  const what = i.missing ? "was missing" : "was damaged";
  const sentences = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ");
  switch (i.kind) {
    case "recovered":
      return sentences(`${i.file} ${what} and has been restored from its previous version.`, kept);
    case "reset":
      return sentences(`${i.file} ${what} and no backup was usable, so it was reset.`, RESET_CONSEQUENCE[i.file], kept);
    case "write_failed":
      return `Could not save ${i.file} (${i.detail}) — recent changes will be lost on restart. Is the disk full?`;
    case "adjusted":
      return `${ADJUSTED_WHAT[i.file] ?? `Values in ${i.file}`} were outside the current limits and were adjusted: ${i.detail}.`;
    case "unrecorded_open":
      return `${i.detail} Is the disk full?`;
    case "unpaid_channel":
      return `${i.detail} The buyer was not charged. The channel is yours: close it to take the capital back, or keep it for routing.`;
  }
}

/** Damaged, unsaveable or adjusted state files — these must never go unnoticed. */
export function stateAlerts(dataDir: string): Alert[] {
  return storeIncidents(dataDir).map((i) => ({
    level: "warn" as const,
    message: incidentMessage(i),
    id: `state:${i.id}`,
  }));
}

/** Magma orders the order lane turned down (cap, capital, an unreachable
 *  buyer …), until dismissed — each one a sale this node didn't make. */
export function magmaRefusalAlerts(desk: { refusals(): { orderId: string; sizeSats: number; reason: string }[] }): Alert[] {
  return desk.refusals().map((r) => ({
    level: "warn" as const,
    message:
      `A ${Math.round(r.sizeSats).toLocaleString("en-US")} sat Magma order was turned down: ${r.reason}. ` +
      "If you want orders like it, raise the caps or fund the wallet (Autopilot → Magma); see Market → Orders.",
    id: `magma:${r.orderId}`,
  }));
}

/** Service fees that need a human: given up, or refused for safety. */
export function serviceFeeAlerts(ledger: Pick<ServiceFeeLedger, "problems">): Alert[] {
  return ledger.problems().map((e) => ({
    level: "warn" as const,
    message: `Service fee for ${e.source} order ${e.orderId.slice(0, 12)} not paid: ${e.lastError ?? e.state}`,
    id: `fee:${e.key}`,
  }));
}

/** Derive actionable alerts from the current node state (read-only), plus any
 *  `extra` app-level alerts. Node trouble never hides the extras. */
export async function getAlerts(lnd: AuthenticatedLnd, extra: Alert[] = []): Promise<Alert[]> {
  const alerts: Alert[] = [...extra];
  let node: Awaited<ReturnType<typeof getNodeSummary>>;
  let channels: Awaited<ReturnType<typeof getChannelsView>>;
  try {
    [node, channels] = await Promise.all([getNodeSummary(lnd), getChannelsView(lnd)]);
  } catch (err) {
    if (extra.length === 0) throw err; // nothing else to show: let the caller report the node error
    return alerts;
  }

  if (!node.syncedToChain) {
    alerts.push({ level: "warn", message: "Node is not synced to the chain" });
  }

  const inactive = channels.filter((c) => !c.active).length;
  if (inactive > 0) {
    alerts.push({ level: "warn", message: `${inactive} channel${inactive > 1 ? "s" : ""} offline` });
  }

  if (node.balances.onchainConfirmedSats < LOW_ONCHAIN_SATS) {
    alerts.push({ level: "info", message: "Low on-chain balance for fees / channel opens" });
  }

  return alerts;
}
