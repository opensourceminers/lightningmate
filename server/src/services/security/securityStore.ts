import { JsonStore } from "../../store.js";

/**
 * Persists a handful of non-sensitive Security-tab values in the app data dir:
 *   - last security check timestamp
 *   - last channel-backup timestamp + channel count (set when the operator
 *     exports an SCB through the Security tab)
 *
 * NO secrets, seed phrases, keys, or backup blobs are ever written here — only
 * the metadata used to detect a stale or missing backup.
 */
export interface SecurityState {
  lastSecurityCheckAt?: string;
  lastBackupAt?: string;
  lastKnownChannelCount?: number;
}

const DEFAULT: SecurityState = {};

export class SecurityStore {
  private readonly store: JsonStore<SecurityState>;
  private state: SecurityState;

  constructor(dataDir: string) {
    this.store = new JsonStore<SecurityState>(dataDir, "security.json");
    this.state = { ...DEFAULT, ...this.store.read(DEFAULT) };
  }

  get(): SecurityState {
    return { ...this.state };
  }

  /** Record that a security check ran (best-effort timestamp). */
  recordCheck(atIso: string): void {
    this.state = { ...this.state, lastSecurityCheckAt: atIso };
    this.store.write(this.state);
  }

  /** Record that the operator exported a fresh channel backup. */
  recordBackupExport(channelCount: number | undefined, atIso: string): void {
    this.state = {
      ...this.state,
      lastBackupAt: atIso,
      lastKnownChannelCount: channelCount ?? this.state.lastKnownChannelCount,
    };
    this.store.write(this.state);
  }
}
