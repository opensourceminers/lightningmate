/**
 * Channel backup (SCB) watchdog + export (server-only, self-contained).
 *
 * Uses only READ-ONLY LND calls (getChannels, getPendingChannels and getBackups
 * / ExportAllChannelBackups, offchain:read). By construction this module can
 * never move funds or change channels. The exported hex blob is streamed
 * straight to the operator's browser for download — it is never written to
 * disk or uploaded anywhere. Only the export time and the list of channel
 * funding outpoints the backup contains are persisted, so the watchdog can
 * tell exactly which channels a backup covers. NO seed phrase, key, or backup
 * blob is ever stored here.
 */

import {
  getBackups,
  getChannels,
  getPendingChannels,
  type AuthenticatedLnd,
  type GetBackupsResult,
} from "lightning";
import { JsonStore } from "../store.js";

/** Persisted metadata — non-sensitive, used only to detect a stale backup. */
interface BackupState {
  lastExportAt?: string;
  lastExportChannelCount?: number;
  /** Funding outpoints ("txid:vout") contained in the last exported backup.
   *  Absent on exports made by versions that only counted channels. */
  lastExportOutpoints?: string[];
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

  /** Record that the operator exported a backup covering `outpoints`. */
  recordExport(outpoints: string[], atIso: string): void {
    this.state = {
      lastExportAt: atIso,
      lastExportChannelCount: outpoints.length,
      lastExportOutpoints: [...outpoints].sort(),
    };
    this.store.write(this.state);
  }
}

export interface BackupStatusResult {
  available: boolean;
  /** Channels that need to be in a backup: open + pending-open. */
  currentChannelCount: number;
  lastExportAt: string | null;
  lastExportChannelCount: number | null;
  /** Channels open (or opening) now that the last backup does not contain. */
  notInBackupCount: number;
  /** Channels in the last backup that have since fully closed. */
  closedSinceExportCount: number;
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

const outpoint = (c: { transaction_id: string; transaction_vout: number }): string =>
  `${c.transaction_id}:${c.transaction_vout}`;

/**
 * The node's channels as two sets:
 *  - `needed`: open + pending-open — every one of these must be in the backup;
 *  - `known`:  everything LND still tracks, incl. channels that are closing.
 * Counting channels was not enough: one close plus one open keeps the count,
 * and the new channel would silently be missing from the "current" backup.
 */
async function channelOutpoints(lnd: AuthenticatedLnd): Promise<{ needed: Set<string>; known: Set<string> }> {
  const [{ channels }, { pending_channels }] = await Promise.all([getChannels({ lnd }), getPendingChannels({ lnd })]);
  const needed = new Set<string>(channels.map(outpoint));
  const known = new Set<string>(needed);
  for (const p of pending_channels) {
    known.add(outpoint(p));
    if (p.is_opening) needed.add(outpoint(p));
  }
  return { needed, known };
}

/**
 * Read-only backup status with a staleness verdict. Tolerates LND errors
 * gracefully (returns available:false). Never throws, never writes.
 */
export async function getBackupStatus(lnd: AuthenticatedLnd, store: BackupStore): Promise<BackupStatusResult> {
  const persisted = store.get();
  const lastExportAt = persisted.lastExportAt ?? null;
  const lastExportChannelCount = persisted.lastExportChannelCount ?? null;
  const base = { lastExportAt, lastExportChannelCount, notInBackupCount: 0, closedSinceExportCount: 0 };

  let current: { needed: Set<string>; known: Set<string> };
  try {
    current = await channelOutpoints(lnd);
  } catch (err) {
    return {
      ...base,
      available: false,
      currentChannelCount: 0,
      stale: true,
      reason: `Could not read channels: ${errToMessage(err)}`,
    };
  }
  const result = (stale: boolean, reason: string, extra: Partial<BackupStatusResult> = {}): BackupStatusResult => ({
    ...base,
    available: true,
    currentChannelCount: current.needed.size,
    stale,
    reason,
    ...extra,
  });

  if (!lastExportAt) return result(true, "No backup exported yet");
  if (!persisted.lastExportOutpoints) {
    return result(
      true,
      "This backup was made by an older version that only counted channels — download it once more so every channel can be tracked",
    );
  }

  const exported = new Set(persisted.lastExportOutpoints);
  const notInBackup = [...current.needed].filter((o) => !exported.has(o)).length;
  // A closing channel is still covered by LND's backup until it is gone, so it
  // only counts as "closed" once LND no longer tracks it at all.
  const closed = [...exported].filter((o) => !current.known.has(o)).length;
  if (notInBackup > 0) {
    return result(
      true,
      `${notInBackup} channel${notInBackup > 1 ? "s are" : " is"} not in your last backup — download a fresh one now`,
      { notInBackupCount: notInBackup, closedSinceExportCount: closed },
    );
  }
  if (closed > 0) {
    return result(
      true,
      `${closed} channel${closed > 1 ? "s" : ""} in your last backup closed since — re-export recommended`,
      { closedSinceExportCount: closed },
    );
  }

  const ageMs = Date.now() - new Date(lastExportAt).getTime();
  if (Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS) {
    return result(true, "Backup is over 30 days old — re-export recommended");
  }
  return result(false, "Backup current — it covers every open and pending channel");
}

/**
 * Export the all-channels static channel backup (read-only LND call). On success
 * persist the export time + the funding outpoints the backup contains, so the
 * watchdog knows exactly which channels it covers. The hex blob is returned to
 * the caller (for download) and never persisted. Handles permission errors.
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

  // What the file actually contains — LND's SCB covers open, pending-open and
  // closing channels — not a separate (racy) channel listing.
  const outpoints = Array.isArray(value.channels) ? value.channels.map(outpoint) : [];
  store.recordExport(outpoints, new Date().toISOString());

  return { ok: true, backupHex: String(value.backup), channelCount: outpoints.length };
}
