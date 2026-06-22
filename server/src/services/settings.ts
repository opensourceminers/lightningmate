import { JsonStore } from "../store.js";

export type FiatCurrency = "off" | "USD" | "EUR" | "GBP" | "CHF";

export interface AppSettings {
  /** "off" = no external price calls at all (privacy-first default). */
  fiatCurrency: FiatCurrency;
}

export const DEFAULT_SETTINGS: AppSettings = { fiatCurrency: "off" };

/** Persisted user settings (currency, …). */
export class SettingsStore {
  private readonly store: JsonStore<AppSettings>;
  private settings: AppSettings;

  constructor(dataDir: string) {
    this.store = new JsonStore<AppSettings>(dataDir, "settings.json");
    this.settings = { ...DEFAULT_SETTINGS, ...this.store.read(DEFAULT_SETTINGS) };
  }

  get(): AppSettings {
    return this.settings;
  }

  set(partial: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...partial };
    this.store.write(this.settings);
    return this.settings;
  }
}
