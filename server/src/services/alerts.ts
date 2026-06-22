import type { AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { getNodeSummary } from "./node.js";

export interface Alert {
  level: "warn" | "info";
  message: string;
}

const LOW_ONCHAIN_SATS = 25_000;

/** Derive actionable alerts from the current node state (read-only). */
export async function getAlerts(lnd: AuthenticatedLnd): Promise<Alert[]> {
  const [node, channels] = await Promise.all([getNodeSummary(lnd), getChannelsView(lnd)]);
  const alerts: Alert[] = [];

  if (!node.syncedToChain) {
    alerts.push({ level: "warn", message: "Node is not synced to the chain" });
  }

  const inactive = channels.filter((c) => !c.active).length;
  if (inactive > 0) {
    alerts.push({ level: "warn", message: `${inactive} channel${inactive > 1 ? "s" : ""} offline` });
  }

  const drained = channels.filter((c) => c.active && c.localRatio < 0.05).length;
  if (drained > 0) {
    alerts.push({
      level: "info",
      message: `${drained} channel${drained > 1 ? "s" : ""} nearly out of outbound liquidity`,
    });
  }

  const full = channels.filter((c) => c.active && c.localRatio > 0.95).length;
  if (full > 0) {
    alerts.push({
      level: "info",
      message: `${full} channel${full > 1 ? "s" : ""} nearly out of inbound liquidity`,
    });
  }

  if (node.balances.onchainConfirmedSats < LOW_ONCHAIN_SATS) {
    alerts.push({ level: "info", message: "Low on-chain balance for fees / channel opens" });
  }

  return alerts;
}
