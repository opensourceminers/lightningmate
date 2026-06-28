/**
 * Channel backup (SCB) watchdog + export (server-only, self-contained).
 *
 * Uses only READ-ONLY LND calls (getChannels + getBackups / ExportAllChannelBackups,
 * offchain:read). By construction this module can never move funds or change
 * channels. The exported hex blob is streamed straight to the operator's browser
 * for download — it is never written to disk or uploaded anywhere. Only the
 * export timestamp + channel count metadata are persisted, so the watchdog can
 * detect a stale or missing backup. NO seed phrase, key, or backup blob is ever
 * stored here.
 */

import { getChannels, getBackups, type AuthenticatedLnd, type GetBackupsResult } from "lightning";
import { JsonStore } from "../store.js";

/** Persisted metadata — non-sensitive, used only to detect a stale backup. */
interface BackupState {
  lastExportAt?: string;
  lastExportChannelCount?: number;
}

const DEFAULT: BackupState = {};

/** Re-export is recommended once the last backup is older than this. */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class BackupStore {
  private readonly store: JsonStore<BackupState>;
  private state: BackupState;

  constructor(dataDir: string) {
    this.store = new JsonStore<BackupState>(dataDir, "backup.json");
    this.state = { ...DEFAULT, ...this.store.read(DEFAULT) };
  }

  get(): BackupState {
    return { ...this.state };
  }

  /** Record that the operator exported a fresh channel backup. */
  recordExport(channelCount: number | undefined, atIso: string): void {
    this.state = {
      ...this.state,
      lastExportAt: atIso,
      lastExportChannelCount: channelCount ?? this.state.lastExportChannelCount,
    };
    this.store.write(this.state);
  }
}

export interface BackupStatusResult {
  available: boolean;
  currentChannelCount: number;
  lastExportAt: string | null;
  lastExportChannelCount: number | null;
  stale: boolean;
  reason: string;
}

/** Reduce any thrown value (ln-service throws arrays) to a short string. */
function errToMessage(err: unknown): string {
  if (Array.isArray(err)) {
    const parts = err.filter((p) => typeof p === "string" || typeof p === "number");
    return (parts.join(" ").trim() || "Unknown LND error").slice(0, 300);
  }
  if (err instanceof Error) return err.message.slice(0, 300);
  if (typeof err === "string") return err.slice(0, 300);
  return "Unknown LND error";
}

function isPermissionError(msg: string): boolean {
  return /permission|unauthorized|not authorized|macaroon/i.test(msg);
}

/**
 * Read-only backup status: current channel count + last-export metadata, with a
 * staleness verdict. Tolerates LND errors gracefully (returns available:false).
 * Never throws, never writes.
 */
export async function getBackupStatus(
  lnd: AuthenticatedLnd,
  store: BackupStore,
): Promise<BackupStatusResult> {
  const persisted = store.get();
  const lastExportAt = persisted.lastExportAt ?? null;
  const lastExportChannelCount = persisted.lastExportChannelCount ?? null;

  let currentChannelCount = 0;
  try {
    const { channels } = await getChannels({ lnd });
    currentChannelCount = Array.isArray(channels) ? channels.length : 0;
  } catch (err) {
    return {
      available: false,
      currentChannelCount: 0,
      lastExportAt,
      lastExportChannelCount,
      stale: true,
      reason: `Could not read channels: ${errToMessage(err)}`,
    };
  }

  if (!lastExportAt) {
    return {
      available: true,
      currentChannelCount,
      lastExportAt,
      lastExportChannelCount,
      stale: true,
      reason: "No backup exported yet",
    };
  }

  if (lastExportChannelCount !== null && currentChannelCount !== lastExportChannelCount) {
    return {
      available: true,
      currentChannelCount,
      lastExportAt,
      lastExportChannelCount,
      stale: true,
      reason: "Channel set changed since last export — re-export recommended",
    };
  }

  const ageMs = Date.now() - new Date(lastExportAt).getTime();
  if (Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS) {
    return {
      available: true,
      currentChannelCount,
      lastExportAt,
      lastExportChannelCount,
      stale: true,
      reason: "Backup is over 30 days old — re-export recommended",
    };
  }

  return {
    available: true,
    currentChannelCount,
    lastExportAt,
    lastExportChannelCount,
    stale: false,
    reason: "Backup current",
  };
}

/**
 * Export the all-channels static channel backup (read-only LND call). On success
 * persist the export timestamp + channel count so the watchdog knows a fresh
 * backup exists. The hex blob is returned to the caller (for download) and never
 * persisted. Handles permission errors gracefully.
 */
export async function exportScb(
  lnd: AuthenticatedLnd,
  store: BackupStore,
): Promise<{ ok: boolean; backupHex?: string; channelCount?: number; error?: string }> {
  let value: GetBackupsResult;
  try {
    value = await getBackups({ lnd });
  } catch (err) {
    const msg = errToMessage(err);
    return {
      ok: false,
      error: isPermissionError(msg)
        ? "The configured macaroon does not permit channel backup export (offchain:read required)."
        : msg,
    };
  }

  if (!value.backup) {
    return { ok: false, error: "LND returned an empty channel backup." };
  }

  const channelCount = Array.isArray(value.channels) ? value.channels.length : undefined;
  store.recordExport(channelCount, new Date().toISOString());

  return { ok: true, backupHex: String(value.backup), channelCount };
}
