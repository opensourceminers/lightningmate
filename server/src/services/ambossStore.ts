import { JsonStore } from "../store.js";
import { checkKey } from "./magmaApi.js";

interface AmbossConfig {
  apiKey: string;
}

const DEFAULT: AmbossConfig = { apiKey: "" };
/** How long a validity check is trusted before we re-verify against Amboss. */
const VALIDITY_TTL_MS = 5 * 60_000;
/** After "unreachable", ask again sooner — the outage may be over. */
const UNREACHABLE_RETRY_MS = 60_000;

/**
 * What the app knows about the stored key:
 *   valid       — Amboss accepted it (key check, or a successful seller call)
 *   rejected    — Amboss definitively refused it (401/403, FORBIDDEN)
 *   unreachable — the last check got no answer; the last verdict is kept
 *   unknown     — not checked yet
 */
export type KeyCheck = "valid" | "rejected" | "unreachable" | "unknown";

export interface AmbossKeyStatus {
  connected: boolean;
  /** Last DEFINITIVE verdict (null = none yet). Not changed by an outage. */
  keyValid: boolean | null;
  keyCheck: KeyCheck;
  checkedAt: string | null;
  /** Why the last check could not get a verdict (outage text), if so. */
  lastError: string | null;
}

/**
 * Stores the user's Amboss API key (per-install, in the app's private data dir)
 * and tracks whether Amboss still accepts it. A key that was valid at connect
 * time can later expire or be revoked ("Login with Node" keys do) — without a
 * validity check the whole Magma path silently no-ops while the UI still shows
 * "connected". This surfaces that so the user knows to reconnect.
 *
 * Only a definitive answer from Amboss changes the verdict. Before, every
 * network blip or timeout read as "expired or revoked" for five minutes, and
 * the UI's only button for it deleted the working key.
 */
export class AmbossStore {
  private readonly store: JsonStore<AmbossConfig>;
  private config: AmbossConfig;
  /** null = unknown/not yet checked; true/false = last known Amboss verdict. */
  private valid: boolean | null = null;
  private checkedAt = 0;
  private check: KeyCheck = "unknown";
  private lastError: string | null = null;

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
    this.check = this.valid ? "valid" : "unknown";
    this.lastError = null;
    this.checkedAt = Date.now();
  }

  /** Disconnect: the key is gone from memory and from disk. */
  clear(): void {
    this.config = { ...DEFAULT };
    // No file at all is "no key" — and deleting needs no free space.
    this.store.erase();
    this.valid = null;
    this.check = "unknown";
    this.lastError = null;
    this.checkedAt = 0;
  }

  /**
   * Save a new key so the one it replaces survives nowhere on disk.
   *
   * The OTHER copies (a `.bak`, damaged copies moved aside) are deleted FIRST.
   * From then on the old key is only in amboss.json itself, which the atomic
   * save below replaces in one rename, without keeping a `.bak` of it. A power
   * cut at any point leaves either the old key in amboss.json alone (the new
   * one simply wasn't saved) or the new key — never the old key in a backup
   * that a later loss of amboss.json would restore. (Deleting after the save,
   * as before, left exactly that window.)
   *
   * If the save fails — a full disk — the old file is deleted instead: the
   * new key lasts until the next restart (the failed save is alerted), but
   * the old one can never come back.
   */
  private saveForgettingOldKey(): void {
    this.store.discardCopies();
    try {
      this.store.writeOrThrow(this.config, { keepBackup: false });
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

  status(): AmbossKeyStatus {
    const connected = this.hasKey();
    return {
      connected,
      keyValid: connected ? this.valid : null,
      keyCheck: connected ? this.check : "unknown",
      checkedAt: connected && this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
      lastError: connected ? this.lastError : null,
    };
  }

  /** Amboss definitively refused an authenticated call (401/403 FORBIDDEN):
   *  flip to invalid at once, so the UI shows it without waiting for the TTL.
   *  Never call this for a timeout or network error. */
  markInvalid(): void {
    if (this.hasKey()) {
      this.valid = false;
      this.check = "rejected";
      this.lastError = null;
      this.checkedAt = Date.now();
    }
  }

  /** Amboss refused an authenticated call (401/403, FORBIDDEN). Whether that
   *  means the key is bad is for the key check to say — a refusal can be about
   *  one resource. Never call this for an outage. */
  async recheckAfterRefusal(): Promise<void> {
    await this.checkValidity(true);
  }

  /** An authenticated call just succeeded: the key works. */
  markValid(): void {
    if (this.hasKey()) {
      this.valid = true;
      this.check = "valid";
      this.lastError = null;
      this.checkedAt = Date.now();
    }
  }

  /** Verify the key against Amboss, cached for VALIDITY_TTL_MS. Returns null
   *  when no key is set. Never throws — an outage keeps the last verdict and
   *  is reported as keyCheck "unreachable". */
  async checkValidity(force = false): Promise<boolean | null> {
    if (!this.hasKey()) return null;
    const ttl = this.check === "unreachable" ? UNREACHABLE_RETRY_MS : VALIDITY_TTL_MS;
    if (!force && this.check !== "unknown" && Date.now() - this.checkedAt < ttl) return this.valid;
    const key = this.config.apiKey;
    const { verdict, error } = await checkKey(key);
    if (key !== this.config.apiKey) return this.valid; // replaced or removed meanwhile
    this.checkedAt = Date.now();
    if (verdict === null) {
      // No answer is not a "no": keep the last verdict.
      this.check = "unreachable";
      this.lastError = error ?? "Amboss could not be reached";
    } else {
      this.valid = verdict;
      this.check = verdict ? "valid" : "rejected";
      this.lastError = null;
    }
    return this.valid;
  }
}
