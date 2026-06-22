import type { AuthenticatedLnd } from "lightning";
import { JsonStore } from "../store.js";
import {
  applyFees,
  DEFAULT_POLICY,
  getFeePreview,
  type FeeApplyItem,
  type FeePolicy,
} from "./fees.js";

export interface AutopilotConfig {
  enabled: boolean;
  intervalMinutes: number;
  /** Per-channel minimum time between fee changes — prevents gossip spam. */
  cooldownMinutes: number;
  /** Max channels changed in a single run — caps blast radius. */
  maxChangesPerRun: number;
  policy: FeePolicy;
}

export interface AutopilotChange {
  id: string;
  alias: string;
  fromPpm: number;
  toPpm: number;
  ok: boolean;
  error?: string;
}

export interface AutopilotRun {
  at: string;
  attempted: number;
  applied: number;
  failed: number;
  changes: AutopilotChange[];
}

interface PersistedState {
  config: AutopilotConfig;
  lastRunAt: string | null;
  perChannelLastApplied: Record<string, string>;
  history: AutopilotRun[];
}

const DEFAULT_CONFIG: AutopilotConfig = {
  enabled: false,
  intervalMinutes: 60,
  cooldownMinutes: 360,
  maxChangesPerRun: 5,
  policy: DEFAULT_POLICY,
};

const HISTORY_LIMIT = 50;

export class Autopilot {
  private readonly store: JsonStore<PersistedState>;
  private state: PersistedState;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    dataDir: string,
    private readonly readLnd: AuthenticatedLnd,
    private readonly writeLnd: AuthenticatedLnd | undefined,
  ) {
    this.store = new JsonStore<PersistedState>(dataDir, "autopilot.json");
    this.state = this.store.read({
      config: DEFAULT_CONFIG,
      lastRunAt: null,
      perChannelLastApplied: {},
      history: [],
    });
    // Merge in any newly added config defaults from older persisted state.
    this.state.config = { ...DEFAULT_CONFIG, ...this.state.config };
  }

  /** Whether writing to the node is possible at all. */
  get canWrite(): boolean {
    return !!this.writeLnd;
  }

  /** Public, serializable view for the API. */
  getState() {
    return {
      canWrite: this.canWrite,
      config: this.state.config,
      lastRunAt: this.state.lastRunAt,
      history: this.state.history.slice(0, 20),
    };
  }

  /** Begin scheduling if enabled and writing is possible. */
  start(): void {
    this.reschedule();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setConfig(partial: Partial<AutopilotConfig>): void {
    this.state.config = { ...this.state.config, ...partial };
    if (partial.policy) {
      this.state.config.policy = { ...this.state.config.policy, ...partial.policy };
    }
    if (this.state.config.enabled && !this.canWrite) {
      // Refuse to "enable" when we have no write macaroon.
      this.state.config.enabled = false;
    }
    this.persist();
    this.reschedule();
  }

  private reschedule(): void {
    this.stop();
    if (!this.state.config.enabled || !this.canWrite) return;
    const ms = Math.max(1, this.state.config.intervalMinutes) * 60_000;
    this.timer = setInterval(() => void this.runOnce(), ms);
    // Kick off one run shortly after enabling, without blocking.
    setTimeout(() => void this.runOnce(), 2_000);
  }

  private cooldownOk(channelId: string): boolean {
    const last = this.state.perChannelLastApplied[channelId];
    if (!last) return true;
    const elapsedMin = (Date.now() - new Date(last).getTime()) / 60_000;
    return elapsedMin >= this.state.config.cooldownMinutes;
  }

  /** Run the policy once: compute proposals, apply the eligible ones. */
  async runOnce(): Promise<AutopilotRun> {
    const emptyRun: AutopilotRun = {
      at: new Date().toISOString(),
      attempted: 0,
      applied: 0,
      failed: 0,
      changes: [],
    };
    if (this.running || !this.writeLnd) return emptyRun;
    this.running = true;

    try {
      const preview = await getFeePreview(this.readLnd, this.state.config.policy);

      // Eligible: active, worth changing, has an outpoint, past its cooldown.
      const eligible = preview.proposals
        .filter(
          (p) =>
            p.active &&
            p.willChange &&
            p.transactionId !== null &&
            p.transactionVout !== null &&
            this.cooldownOk(p.id),
        )
        .slice(0, this.state.config.maxChangesPerRun);

      const items: FeeApplyItem[] = eligible.map((p) => ({
        id: p.id,
        transactionId: p.transactionId as string,
        transactionVout: p.transactionVout as number,
        feeRatePpm: p.proposedPpm,
        baseFeeMsat: p.proposedBaseMsat,
      }));

      const results = items.length
        ? await applyFees(this.readLnd, this.writeLnd, items)
        : [];

      const byId = new Map(eligible.map((p) => [p.id, p]));
      const changes: AutopilotChange[] = results.map((r) => {
        const p = byId.get(r.id);
        if (r.ok) this.state.perChannelLastApplied[r.id] = new Date().toISOString();
        return {
          id: r.id,
          alias: p?.peerAlias ?? r.id,
          fromPpm: p?.currentPpm ?? 0,
          toPpm: r.feeRatePpm,
          ok: r.ok,
          error: r.error,
        };
      });

      const run: AutopilotRun = {
        at: new Date().toISOString(),
        attempted: items.length,
        applied: changes.filter((c) => c.ok).length,
        failed: changes.filter((c) => !c.ok).length,
        changes,
      };

      this.state.lastRunAt = run.at;
      this.state.history.unshift(run);
      this.state.history = this.state.history.slice(0, HISTORY_LIMIT);
      this.persist();
      return run;
    } catch (err) {
      console.error("[autopilot] run failed:", err);
      return emptyRun;
    } finally {
      this.running = false;
    }
  }

  private persist(): void {
    this.store.write(this.state);
  }
}
