import type { SecurityConfig } from "./config.js";
import type {
  BackupHealthState,
  BackupHealthStatus,
  SecuritySnapshot,
  SecurityRecommendation,
  SecuritySeverity,
} from "./types.js";
import { hoursBetween, makeRecommendation, worstSeverity } from "./util.js";

export const BACKUP_SECURITY_NOTE =
  "LightningMate never asks for or stores your seed phrase. Store your channel backup encrypted and outside this device.";

export type BackupPersistedInput = {
  lastBackupAt?: string;
  lastKnownChannelCount?: number;
};

function exportRecommendation(
  priority: SecurityRecommendation["priority"],
): SecurityRecommendation {
  return makeRecommendation({
    id: "rec-export-backup",
    category: "backup_health",
    priority,
    title: "Export a fresh channel backup",
    description:
      "Export your static channel backup (SCB) and store it encrypted, off this device. You need it to recover channel funds if the node is lost.",
    actionType: "export_backup",
    reasons: ["A current channel backup is the single most important safety net for a funded node."],
  });
}

/**
 * Backup watchdog — the most important safety check.
 *
 * Determines whether the channel backup is likely current. LightningMate only
 * knows about backups the operator exported *through the Security tab* (timestamp
 * and channel count are persisted; the blob itself is never stored).
 */
export function evaluateBackupHealth(
  snapshot: SecuritySnapshot,
  config: SecurityConfig,
  persisted: BackupPersistedInput,
  now: Date = new Date(),
): BackupHealthStatus {
  const cfg = config.backup;
  const nowIso = now.toISOString();

  const channelsKnown = Array.isArray(snapshot.channels);
  const currentChannelCount = channelsKnown
    ? snapshot.channels!.length
    : snapshot.info?.activeChannelsCount ?? 0;
  const pendingCount = snapshot.pendingChannels?.length ?? snapshot.info?.pendingChannelsCount ?? 0;
  const hasChannels = currentChannelCount > 0;

  const canExportScb = snapshot.backup?.available ?? false;
  const exportedBackupAvailable = snapshot.backup?.allChannelsScbAvailable;

  const reasons: string[] = [];
  const warnings: string[] = [];
  const recommendations: SecurityRecommendation[] = [];
  const severities: SecuritySeverity[] = ["healthy"];

  let state: BackupHealthState = "unknown";

  if (!snapshot.reachable) {
    state = "unknown";
    severities.push(hasChannels ? "warning" : "healthy");
    warnings.push("LND is unreachable, so backup status cannot be verified right now.");
  } else if (!canExportScb) {
    state = "unknown";
    if (hasChannels) {
      severities.push("warning");
      warnings.push(
        "Channel backup could not be verified. This check requires additional LND permissions or is unavailable.",
      );
      recommendations.push(exportRecommendation("high"));
    } else {
      reasons.push("No channels to back up yet.");
    }
  } else if (!hasChannels) {
    state = "current";
    reasons.push("No channels to back up yet. Backup status will be watched once you open a channel.");
  } else if (!persisted.lastBackupAt) {
    state = "missing";
    severities.push("critical");
    reasons.push(
      "Active channels exist but no verified channel backup has been recorded. If this node is lost, channel funds could be unrecoverable.",
    );
    recommendations.push(exportRecommendation("urgent"));
  } else {
    const lastKnown = persisted.lastKnownChannelCount;
    const countChanged =
      cfg.warnIfChannelCountChanged &&
      channelsKnown &&
      lastKnown !== undefined &&
      lastKnown !== currentChannelCount;

    if (countChanged) {
      state = "needs_export_after_channel_change";
      severities.push("critical");
      reasons.push(
        `Your channel set changed since the last backup (was ${lastKnown}, now ${currentChannelCount}). The recorded backup no longer covers all channels.`,
      );
      recommendations.push(exportRecommendation("urgent"));
    } else {
      const ageHours = hoursBetween(persisted.lastBackupAt, nowIso);
      if (ageHours > cfg.criticalBackupHours) {
        state = "stale";
        severities.push("critical");
        reasons.push(
          `Channel backup is very old (last export ${Math.round(ageHours)}h ago, threshold ${cfg.criticalBackupHours}h).`,
        );
        recommendations.push(exportRecommendation("high"));
      } else if (ageHours > cfg.staleBackupHours) {
        state = "stale";
        severities.push("warning");
        warnings.push(
          `Channel backup is older than ${cfg.staleBackupHours}h (last export ${Math.round(ageHours)}h ago).`,
        );
        recommendations.push(exportRecommendation("medium"));
      } else {
        state = "current";
        reasons.push(`Channel backup is current (last export ${Math.round(ageHours)}h ago).`);
      }
    }
  }

  if (pendingCount > 0 && snapshot.reachable) {
    severities.push("warning");
    warnings.push(`${pendingCount} channel(s) are pending. Export a fresh backup once they confirm.`);
    if (!recommendations.some((r) => r.id === "rec-export-backup")) {
      recommendations.push(exportRecommendation("medium"));
    }
  }

  let channelChangesSinceLastBackup: BackupHealthStatus["channelChangesSinceLastBackup"];
  if (persisted.lastKnownChannelCount !== undefined && channelsKnown) {
    const delta = currentChannelCount - persisted.lastKnownChannelCount;
    channelChangesSinceLastBackup = {
      opened: Math.max(0, delta),
      closed: Math.max(0, -delta),
      pending: pendingCount,
    };
  }

  return {
    state,
    severity: worstSeverity(severities),
    lastBackupAt: persisted.lastBackupAt,
    lastKnownChannelCount: persisted.lastKnownChannelCount,
    currentChannelCount,
    channelChangesSinceLastBackup,
    canExportScb,
    exportedBackupAvailable,
    reasons,
    warnings,
    recommendations,
  };
}
