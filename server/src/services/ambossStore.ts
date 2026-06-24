import { JsonStore } from "../store.js";

interface AmbossConfig {
  apiKey: string;
}

const DEFAULT: AmbossConfig = { apiKey: "" };

/**
 * Stores the user's Amboss API key (per-install, in the app's private data dir).
 * Used to authenticate Magma marketplace calls (buying/selling liquidity).
 */
export class AmbossStore {
  private readonly store: JsonStore<AmbossConfig>;
  private config: AmbossConfig;

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
  }

  clear(): void {
    this.config = { ...DEFAULT };
    this.store.write(this.config);
  }
}
