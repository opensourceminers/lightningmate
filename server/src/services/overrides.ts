import { JsonStore } from "../store.js";

export type FeeMode = "auto" | "fixed" | "exclude";

export interface ChannelOverride {
  mode: FeeMode;
  /** ppm to pin, when mode === "fixed". */
  fixedPpm?: number;
}

export type OverrideMap = Record<string, ChannelOverride>;

/**
 * Per-channel manual fee overrides. "auto" = follow the policy (default),
 * "fixed" = pin a ppm, "exclude" = never let the engine/autopilot touch it.
 */
export class OverridesStore {
  private readonly store: JsonStore<OverrideMap>;
  private map: OverrideMap;

  constructor(dataDir: string) {
    this.store = new JsonStore<OverrideMap>(dataDir, "overrides.json");
    this.map = this.store.read({});
  }

  all(): OverrideMap {
    return this.map;
  }

  set(channelId: string, override: ChannelOverride): OverrideMap {
    if (override.mode === "auto") {
      delete this.map[channelId];
    } else {
      this.map[channelId] = override;
    }
    this.store.write(this.map);
    return this.map;
  }
}
