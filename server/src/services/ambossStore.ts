import { JsonStore } from "../store.js";
import { validateKey } from "./amboss.js";

interface AmbossConfig {
  apiKey: string;
}

const DEFAULT: AmbossConfig = { apiKey: "" };
/** How long a validity check is trusted before we re-verify against Amboss. */
const VALIDITY_TTL_MS = 5 * 60_000;

/**
 * Stores the user's Amboss API key (per-install, in the app's private data dir)
 * and tracks whether Amboss still accepts it. A key that was valid at connect
 * time can later expire or be revoked ("Login with Node" keys do) — without a
 * validity check the whole Magma path silently no-ops while the UI still shows
 * "connected". This surfaces that so the user knows to reconnect.
 */
export class AmbossStore {
  private readonly store: JsonStore<AmbossConfig>;
  private config: AmbossConfig;
  /** null = unknown/not yet checked; true/false = last known Amboss verdict. */
  private valid: boolean | null = null;
  private checkedAt = 0;

  constructor(dataDir: string) {
    this.store = new JsonStore<AmbossConfig>(dataDir, "amboss.json", { secret: true });
    this.config = { ...DEFAULT, ...this.store.read(DEFAULT) };
  }

  getKey(): string {
    return this.config.apiKey;
  }

  hasKey(): boolean {
    return this.config.apiKey.length > 0;
  }

  setKey(apiKey: string): void {
    const key = apiKey.trim();
    const replaced = key !== this.config.apiKey;
    this.config = { apiKey: key };
    if (replaced) this.saveForgettingOldKey();
    else this.store.write(this.config);
    // A freshly connected key was just validated by the caller.
    this.valid = this.config.apiKey.length > 0 ? true : null;
    this.checkedAt = Date.now();
  }

  /** Disconnect: the key is gone from memory and from disk. */
  clear(): void {
    this.config = { ...DEFAULT };
    // No file at all is "no key" — and deleting needs no free space.
    this.store.erase();
    this.valid = null;
    this.checkedAt = 0;
  }

  /**
   * Save a new key so the one it replaces survives nowhere on disk: no `.bak`
   * of it is kept, and copies left from before (a `.bak`, damaged copies moved
   * aside) are deleted. If the save fails — a full disk — the old file is
   * deleted instead: the new key then lasts until the next restart (the
   * failed save is alerted), but the old one can never come back. Before,
   * the `.bak` kept a removed key, and a later damaged or missing amboss.json
   * brought it back — Magma automation running on a key the operator removed.
   */
  private saveForgettingOldKey(): void {
    try {
      this.store.writeOrThrow(this.config, { keepBackup: false });
      this.store.discardCopies();
    } catch (err) {
      console.error(
        `[amboss] could not save the new key (${err instanceof Error ? err.message : String(err)}) — ` +
          "deleted the old one from disk instead",
      );
      this.store.erase();
    }
  }

  /** Last known validity without hitting the network. */
  getValidity(): boolean | null {
    return this.hasKey() ? this.valid : null;
  }

  /** An authenticated Magma call just failed with an auth error — flip to
   *  invalid immediately so the UI reflects it without waiting for the TTL. */
  markInvalid(): void {
    if (this.hasKey()) {
      this.valid = false;
      this.checkedAt = Date.now();
    }
  }

  /** Verify the key against Amboss, cached for VALIDITY_TTL_MS. Returns null
   *  when no key is set. Never throws — a network error keeps the last verdict. */
  async checkValidity(force = false): Promise<boolean | null> {
    if (!this.hasKey()) return null;
    if (!force && this.valid !== null && Date.now() - this.checkedAt < VALIDITY_TTL_MS) {
      return this.valid;
    }
    try {
      this.valid = await validateKey(this.config.apiKey);
      this.checkedAt = Date.now();
    } catch {
      // Network blip — don't flip a previously-known verdict on a transient error.
    }
    return this.valid;
  }
}
