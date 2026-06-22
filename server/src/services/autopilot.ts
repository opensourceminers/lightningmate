import { getChainBalance, type AuthenticatedLnd } from "lightning";
import { JsonStore } from "../store.js";
import { openChannelTo } from "./channelOps.js";
import { getChannelSuggestions } from "./suggestions.js";
import {
  applyFees,
  DEFAULT_POLICY,
  getFeePreview,
  type FeeApplyItem,
  type FeePolicy,
} from "./fees.js";
import {
  DEFAULT_REBALANCE_POLICY,
  executeRebalance,
  getRebalanceCandidates,
  type RebalancePolicy,
} from "./rebalance.js";
import type { RebalanceLog } from "./rebalanceLog.js";
import type { OverridesStore } from "./overrides.js";

export interface AutopilotConfig {
  enabled: boolean;
  intervalMinutes: number;
  /** Per-channel minimum time between fee changes — prevents gossip spam. */
  cooldownMinutes: number;
  /** Max channels changed in a single run — caps blast radius. */
  maxChangesPerRun: number;
  policy: FeePolicy;
  /** Auto-rebalancing — independent of fee automation, also default off. */
  rebalanceEnabled: boolean;
  rebalancePolicy: RebalancePolicy;
  maxRebalancesPerRun: number;
  /** Per-target minimum time between rebalances. */
  rebalanceCooldownMinutes: number;
  /** Channel autopilot: open a channel to the top suggestion when funds allow. */
  channelEnabled: boolean;
  /** Keep at least this much on-chain (sats) untouched. */
  channelReserveSats: number;
  /** Channel size to open; 0 = use the suggestion's recommended size. */
  channelSizeSats: number;
  /** Minimum time between auto-opens. */
  channelCooldownMinutes: number;
}

export interface AutopilotChange {
  id: string;
  alias: string;
  fromPpm: number;
  toPpm: number;
  ok: boolean;
  error?: string;
}

export interface AutopilotRebalance {
  alias: string;
  amountSats: number;
  feeSats: number | null;
  costPpm: number | null;
  ok: boolean;
  error?: string;
}

export interface AutopilotChannelOpen {
  alias: string;
  sizeSats: number;
  ok: boolean;
  transactionId?: string;
  error?: string;
}

export interface AutopilotRun {
  at: string;
  attempted: number;
  applied: number;
  failed: number;
  changes: AutopilotChange[];
  rebalances: AutopilotRebalance[];
  channels: AutopilotChannelOpen[];
}

interface PersistedState {
  config: AutopilotConfig;
  lastRunAt: string | null;
  perChannelLastApplied: Record<string, string>;
  perTargetLastRebalanced: Record<string, string>;
  lastChannelOpenAt: string | null;
  history: AutopilotRun[];
}

const DEFAULT_CONFIG: AutopilotConfig = {
  enabled: false,
  intervalMinutes: 60,
  cooldownMinutes: 360,
  maxChangesPerRun: 5,
  policy: DEFAULT_POLICY,
  rebalanceEnabled: false,
  rebalancePolicy: DEFAULT_REBALANCE_POLICY,
  maxRebalancesPerRun: 2,
  rebalanceCooldownMinutes: 720,
  channelEnabled: false,
  channelReserveSats: 50_000,
  channelSizeSats: 0,
  channelCooldownMinutes: 1_440,
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
    private readonly rebalanceLog: RebalanceLog,
    private readonly overrides: OverridesStore,
  ) {
    this.store = new JsonStore<PersistedState>(dataDir, "autopilot.json");
    this.state = this.store.read({
      config: DEFAULT_CONFIG,
      lastRunAt: null,
      perChannelLastApplied: {},
      perTargetLastRebalanced: {},
      lastChannelOpenAt: null,
      history: [],
    });
    // Merge in any newly added config defaults from older persisted state.
    this.state.config = { ...DEFAULT_CONFIG, ...this.state.config };
    this.state.perTargetLastRebalanced ??= {};
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
    if (!this.canWrite) {
      // Refuse to "enable" anything when we have no write macaroon.
      this.state.config.enabled = false;
      this.state.config.rebalanceEnabled = false;
      this.state.config.channelEnabled = false;
    }
    this.persist();
    this.reschedule();
  }

  private reschedule(): void {
    this.stop();
    const { enabled, rebalanceEnabled, channelEnabled } = this.state.config;
    if ((!enabled && !rebalanceEnabled && !channelEnabled) || !this.canWrite) return;
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

  private rebalanceCooldownOk(targetId: string, cooldownMin: number): boolean {
    const last = this.state.perTargetLastRebalanced[targetId];
    if (!last) return true;
    return (Date.now() - new Date(last).getTime()) / 60_000 >= cooldownMin;
  }

  /** Compute and apply eligible fee changes. */
  private async runFees(writeLnd: AuthenticatedLnd): Promise<AutopilotChange[]> {
    const preview = await getFeePreview(this.readLnd, this.state.config.policy, this.overrides.all());
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

    const results = items.length ? await applyFees(this.readLnd, writeLnd, items) : [];
    const byId = new Map(eligible.map((p) => [p.id, p]));
    return results.map((r) => {
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
  }

  /** Execute eligible (profitable, off-cooldown) rebalances. */
  private async runRebalances(writeLnd: AuthenticatedLnd): Promise<AutopilotRebalance[]> {
    const { rebalancePolicy, maxRebalancesPerRun, rebalanceCooldownMinutes } = this.state.config;
    const analysis = await getRebalanceCandidates(this.readLnd, rebalancePolicy);
    const eligible = analysis.candidates
      .filter((c) => c.profitable && this.rebalanceCooldownOk(c.targetId, rebalanceCooldownMinutes))
      .slice(0, maxRebalancesPerRun);

    const out: AutopilotRebalance[] = [];
    for (const c of eligible) {
      const res = await executeRebalance(this.readLnd, writeLnd, {
        targetId: c.targetId,
        sourceId: c.sourceId,
        amountSats: c.amountSats,
        econRatio: rebalancePolicy.econRatio,
      });
      if (res.ok) this.state.perTargetLastRebalanced[c.targetId] = new Date().toISOString();
      this.rebalanceLog.append({
        at: new Date().toISOString(),
        via: "autopilot",
        targetId: res.targetId,
        targetAlias: res.targetAlias,
        sourceId: res.sourceId,
        sourceAlias: res.sourceAlias,
        amountSats: res.amountSats,
        budgetPpm: res.budgetPpm,
        feeSats: res.feeSats,
        costPpm: res.costPpm,
        ok: res.ok,
        error: res.error,
      });
      out.push({
        alias: res.targetAlias,
        amountSats: res.amountSats,
        feeSats: res.feeSats,
        costPpm: res.costPpm,
        ok: res.ok,
        error: res.error,
      });
    }
    return out;
  }

  /** Open a channel to the top suggestion when on-chain funds allow. */
  private async runChannels(writeLnd: AuthenticatedLnd): Promise<AutopilotChannelOpen[]> {
    const cfg = this.state.config;

    // Respect the cooldown between auto-opens.
    if (this.state.lastChannelOpenAt) {
      const elapsedMin = (Date.now() - new Date(this.state.lastChannelOpenAt).getTime()) / 60_000;
      if (elapsedMin < cfg.channelCooldownMinutes) return [];
    }

    const { chain_balance } = await getChainBalance({ lnd: this.readLnd });
    const available = chain_balance - cfg.channelReserveSats;
    if (available <= 0) return [];

    const { suggestions } = await getChannelSuggestions(this.readLnd, {});
    const top = suggestions[0];
    if (!top) return [];

    const size = cfg.channelSizeSats > 0 ? cfg.channelSizeSats : top.recommendedSizeSats;
    if (available < size) return []; // not enough on-chain to fund it + keep the reserve

    const res = await openChannelTo(writeLnd, {
      pubkey: top.pubkey,
      socket: top.socket || undefined,
      localTokens: size,
    });
    if (res.ok) this.state.lastChannelOpenAt = new Date().toISOString();

    return [
      {
        alias: top.alias,
        sizeSats: size,
        ok: res.ok,
        transactionId: res.transactionId,
        error: res.error,
      },
    ];
  }

  /** Run the autopilot once: fees, then rebalances, then channel opens (each if enabled). */
  async runOnce(): Promise<AutopilotRun> {
    const emptyRun: AutopilotRun = {
      at: new Date().toISOString(),
      attempted: 0,
      applied: 0,
      failed: 0,
      changes: [],
      rebalances: [],
      channels: [],
    };
    if (this.running || !this.writeLnd) return emptyRun;
    this.running = true;
    const writeLnd = this.writeLnd;

    try {
      const changes = this.state.config.enabled ? await this.runFees(writeLnd) : [];
      const rebalances = this.state.config.rebalanceEnabled
        ? await this.runRebalances(writeLnd)
        : [];
      const channels = this.state.config.channelEnabled ? await this.runChannels(writeLnd) : [];

      const run: AutopilotRun = {
        at: new Date().toISOString(),
        attempted: changes.length + rebalances.length + channels.length,
        applied:
          changes.filter((c) => c.ok).length +
          rebalances.filter((r) => r.ok).length +
          channels.filter((c) => c.ok).length,
        failed:
          changes.filter((c) => !c.ok).length +
          rebalances.filter((r) => !r.ok).length +
          channels.filter((c) => !c.ok).length,
        changes,
        rebalances,
        channels,
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
