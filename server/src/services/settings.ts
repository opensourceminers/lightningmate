import { readdirSync } from "node:fs";
import { JsonStore } from "../store.js";

export type FiatCurrency = "off" | "USD" | "EUR" | "GBP" | "CHF";

export interface AppSettings {
  /** "off" = no external price calls at all (privacy-first default). */
  fiatCurrency: FiatCurrency;
  /** Look peers (and this node) up on lightningnetwork.plus: reputation in
   *  peer picking, the Pool and Swaps views. Off: no LN+ request at all
   *  (cached answers are still used). */
  lnplusLookups: boolean;
  /** Look a node up on mempool.space when its details are opened: where it
   *  runs and since when. Off: no such request at all. */
  nodeLookups: boolean;
  /** LSP mode (experimental): answer LSPS1 (bLIP-51) requests from wallets. Off by default. */
  lspModeEnabled: boolean;
  /** The first-start questions are answered or skipped. Only a new install
   *  ever sees them: one that already has settings or an autopilot on disk
   *  counts as done. */
  setupDone: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  fiatCurrency: "off",
  // On, as since LN+ came in (0.7.4) — with Umbrel's Tor proxy its lookups
  // go through Tor; without one, Settings says they leave from this IP.
  lnplusLookups: true,
  // One node at a time, only when the operator opens it, through Tor.
  nodeLookups: true,
  lspModeEnabled: false,
  setupDone: true,
};

/** What 0.8.4 and before kept beside the settings: a Tor route (every
 *  request goes through Tor now, http.ts) and a clearnet address LSP mode
 *  announced in the node graph (LSP mode is Tor-only now, lsps1.ts). */
type StoredSettings = Partial<AppSettings> & { torRoute?: unknown; lspClearnetAddress?: unknown };

/** Settings or an autopilot on disk, a backup or a recovered copy included
 *  (settings.json.bak, autopilot.json.corrupt-…): a node that has run before. */
function hasStateFile(dataDir: string): boolean {
  try {
    return readdirSync(dataDir).some((name) => /^(settings|autopilot)\.json/.test(name));
  } catch {
    return false;
  }
}

/** Persisted user settings (currency, …). */
export class SettingsStore {
  private readonly store: JsonStore<AppSettings>;
  private settings: AppSettings;
  /** The clearnet address an older version announced ("" = none): withdrawn
   *  once at start (Lsps1Service), then forgotten. */
  private legacyClearnet: string;

  constructor(dataDir: string) {
    const isNewInstall = !hasStateFile(dataDir);
    this.store = new JsonStore<AppSettings>(dataDir, "settings.json");
    const stored: StoredSettings = this.store.read({ ...DEFAULT_SETTINGS, setupDone: !isNewInstall });
    this.legacyClearnet = typeof stored.lspClearnetAddress === "string" ? stored.lspClearnetAddress.trim() : "";
    // Only today's settings: an older version's leave the file at the next save.
    this.settings = {
      fiatCurrency: stored.fiatCurrency ?? DEFAULT_SETTINGS.fiatCurrency,
      lnplusLookups: stored.lnplusLookups ?? DEFAULT_SETTINGS.lnplusLookups,
      nodeLookups: stored.nodeLookups ?? DEFAULT_SETTINGS.nodeLookups,
      lspModeEnabled: stored.lspModeEnabled ?? DEFAULT_SETTINGS.lspModeEnabled,
      setupDone: stored.setupDone ?? !isNewInstall,
    };
    // Said on disk at once: the autopilot's file appears right after this, and
    // the questions must survive a restart before they are answered.
    if (isNewInstall) this.store.write(this.settings);
  }

  get(): AppSettings {
    return this.settings;
  }

  set(partial: Partial<AppSettings>): AppSettings {
    this.settings = { ...this.settings, ...partial };
    this.store.write(this.settings);
    return this.settings;
  }

  /** The clearnet address LSP mode announced before 0.8.5, "" when none. */
  legacyClearnetAddress(): string {
    return this.legacyClearnet;
  }

  /** It is withdrawn: forget it, in the file too. */
  forgetLegacyClearnetAddress(): void {
    this.legacyClearnet = "";
    this.store.write(this.settings);
  }
}
