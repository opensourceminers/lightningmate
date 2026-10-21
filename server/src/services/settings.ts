import { JsonStore } from "../store.js";
import type { TorRoute } from "./http.js";

export type FiatCurrency = "off" | "USD" | "EUR" | "GBP" | "CHF";

export interface AppSettings {
  /** "off" = no external price calls at all (privacy-first default). */
  fiatCurrency: FiatCurrency;
  /** Look peers (and this node) up on lightningnetwork.plus: reputation in
   *  peer picking, the Pool and Swaps views. Off: no LN+ request at all
   *  (cached answers are still used). */
  lnplusLookups: boolean;
  /** Which outbound requests go through Umbrel's Tor proxy when the app has
   *  one (http.ts TorRoute). */
  torRoute: TorRoute;
  /** LSP mode (beta): answer LSPS1 (bLIP-51) requests from wallets. Off by default. */
  lspModeEnabled: boolean;
  /** Clearnet address (host:port) to announce in the node graph, "" = none.
   *  Applied via peersrpc at runtime — Umbrel's UI has no externalip field. */
  lspClearnetAddress: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fiatCurrency: "off",
  // On, as since LN+ came in (0.7.4) — with Umbrel's Tor proxy its lookups
  // go through Tor; without one, Settings says they leave from this IP.
  lnplusLookups: true,
  torRoute: "lookups",
  lspModeEnabled: false,
  lspClearnetAddress: "",
};

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
