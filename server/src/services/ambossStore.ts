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
    this.store = new JsonStore<AmbossConfig>(dataDir, "amboss.json");
    this.config = { ...DEFAULT, ...this.store.read(DEFAULT) };
  }

  getKey(): string {
    return this.config.apiKey;
  }

  hasKey(): boolean {
    return this.config.apiKey.length > 0;
  }

  setKey(apiKey: string): void {
    this.config = { apiKey: apiKey.trim() };
    this.store.write(this.config);
    // A freshly connected key was just validated by the caller.
    this.valid = this.config.apiKey.length > 0 ? true : null;
    this.checkedAt = Date.now();
  }

  clear(): void {
    this.config = { ...DEFAULT };
    this.store.write(this.config);
    this.valid = null;
    this.checkedAt = 0;
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
