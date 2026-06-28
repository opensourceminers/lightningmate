import { type AuthenticatedLnd } from "lightning";
import { getSecurityConfig } from "./config.js";
import { collectSecuritySnapshot, exportScb } from "./snapshot.js";
import { computeSecuritySummary } from "./summary.js";
import type { SecurityStore } from "./securityStore.js";
import type { ScbExportResult, SecuritySummary } from "./types.js";

/**
 * Full Security summary build with I/O (server-only): collect a live READ-ONLY
 * LND snapshot using the existing authenticated client, read persisted state,
 * compute the summary, then record the check timestamp. Always resolves —
 * snapshot collection never throws.
 */
export async function buildSecuritySummary(
  lnd: AuthenticatedLnd,
  store: SecurityStore,
  now: Date = new Date(),
): Promise<SecuritySummary> {
  const config = getSecurityConfig();
  const snapshot = await collectSecuritySnapshot(lnd);
  const persisted = store.get();

  const summary = computeSecuritySummary({
    snapshot,
    persisted: {
      lastBackupAt: persisted.lastBackupAt,
      lastKnownChannelCount: persisted.lastKnownChannelCount,
    },
    config,
    now,
  });

  store.recordCheck(now.toISOString());

  return summary;
}

/**
 * Export the all-channels static channel backup (read-only LND call) and record
 * the export metadata so the backup watchdog knows a fresh backup exists. The
 * hex blob is returned to the caller (for download) and never persisted.
 */
export async function exportSecurityBackup(
  lnd: AuthenticatedLnd,
  store: SecurityStore,
): Promise<ScbExportResult> {
  const result = await exportScb(lnd);
  if (result.ok && result.exportedAt) {
    store.recordBackupExport(result.channelCount, result.exportedAt);
  }
  return result;
}
