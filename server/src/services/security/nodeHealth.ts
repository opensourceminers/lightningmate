import type { SecuritySnapshot, NodeHealthStatus, SecuritySeverity } from "./types.js";
import { worstSeverity } from "./util.js";

/**
 * Node health: is the node reachable, synced to chain and graph, and connected
 * to peers? An unreachable node is always critical — no safety property can be
 * verified when LND can't be reached.
 */
export function evaluateNodeHealth(snapshot: SecuritySnapshot): NodeHealthStatus {
  if (!snapshot.reachable) {
    const reasons = ["LND is unreachable. Node safety cannot be verified."];
    const warnings: string[] = [];
    if (snapshot.connectionError) {
      warnings.push(`Connection error: ${snapshot.connectionError}`);
    }
    return {
      lndReachable: false,
      severity: "critical",
      reasons,
      warnings,
    };
  }

  const info = snapshot.info ?? {};
  const reasons: string[] = [];
  const warnings: string[] = [];
  const severities: SecuritySeverity[] = ["healthy"];

  const syncedToChain = info.isSyncedToChain;
  const syncedToGraph = info.isSyncedToGraph;
  const peers = info.peersCount;

  // The node answered with chain status, so the bitcoin backend is reachable.
  const bitcoinBackendReachable = syncedToChain !== undefined;

  if (syncedToChain === false) {
    severities.push("critical");
    reasons.push("LND is reachable but not synced to the blockchain.");
  } else if (syncedToChain === true) {
    reasons.push("LND is reachable and synced to chain.");
  } else {
    warnings.push("Chain sync status is unavailable from this node.");
    severities.push("warning");
  }

  if (syncedToGraph === false) {
    severities.push("warning");
    warnings.push("LND is not yet synced to the network graph. Routing data may be stale.");
  }

  if (peers !== undefined) {
    if (peers === 0) {
      severities.push("warning");
      warnings.push("No peers are connected. The node cannot send or receive payments.");
    } else if (peers < 3) {
      severities.push("warning");
      warnings.push(`Only ${peers} peer(s) connected. Low peer count reduces routing reliability.`);
    }
  }

  return {
    lndReachable: true,
    lndSyncedToChain: syncedToChain,
    lndSyncedToGraph: syncedToGraph,
    bitcoinBackendReachable,
    bitcoinSynced: syncedToChain,
    blockHeight: info.blockHeight,
    peersCount: peers,
    alias: info.alias,
    pubkey: info.pubkey,
    version: info.version,
    severity: worstSeverity(severities),
    reasons,
    warnings,
  };
}
