import { getChannels, getChainBalance, type AuthenticatedLnd } from "lightning";
import { JsonStore } from "../store.js";
import { closeChannelByOutpoint, openChannelTo } from "./channelOps.js";
import { createInvoice } from "./payments.js";
import { acceptOrder, addOrderTransaction, getMyOffers, getMyOrders, updateOffer } from "./amboss.js";
import { paySaleServiceFee } from "./serviceFee.js";
import type { AmbossStore } from "./ambossStore.js";
import { getChannelSuggestionsV2 } from "./suggestRecommend.js";
import { getMagmaRecommendations, type MagmaSellRecommendation } from "./magmaRecommend.js";
import {
  applyFees,
  DEFAULT_POLICY,
  type FeeApplyItem,
  type FeePolicy,
} from "./fees.js";
import { getFeeRecommendations, type FeeRecConfig } from "./feeRecommend.js";
import { DEFAULT_REBALANCE_POLICY, executeRebalance, type RebalancePolicy } from "./rebalance.js";
import { getRebalanceRecommendations } from "./rebalanceRecommend.js";
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
  /** Only auto-rebalance within this hour window (node local time, 0–24). Equal
   *  start/end = any time. e.g. 0→6 = only overnight, when routes are cheaper. */
  rebalanceHourStart: number;
  rebalanceHourEnd: number;
  /** Channel autopilot: open a channel to the top suggestion when funds allow. */
  channelEnabled: boolean;
  /** Keep at least this much on-chain (sats) untouched. */
  channelReserveSats: number;
  /** Channel size to open; 0 = use the suggestion's recommended size. */
  channelSizeSats: number;
  /** Minimum time between auto-opens. */
  channelCooldownMinutes: number;
  /** Magma liquidity provision: auto-fulfill sell orders (accept + open channel). */
  sellEnabled: boolean;
  /** Max total capital deployed into sold channels (sats). */
  sellMaxDeploySats: number;
  /** On-chain balance to always keep when fulfilling (sats). */
  sellReserveSats: number;
  /** Max channel size to fulfill per order (sats). */
  sellMaxChannelSats: number;
  /** Auto-close sold channels once the lease is over, to reclaim capital. */
  sellAutoClose: boolean;
  /** Top a depleted offer back up (within the caps) so it keeps taking orders. */
  sellAutoRelist: boolean;
  /** Auto-tune the offer price to the Magma v2 recommendation (competitive +
   *  profit-aware), instead of leaving it static. Respects a daily cooldown. */
  sellAutoReprice: boolean;
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

export interface AutopilotSell {
  orderId: string;
  action: "accept" | "open" | "close" | "skip" | "relist" | "reprice";
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
  sells: AutopilotSell[];
}

interface PersistedState {
  config: AutopilotConfig;
  lastRunAt: string | null;
  perChannelLastApplied: Record<string, string>;
  perTargetLastRebalanced: Record<string, string>;
  lastChannelOpenAt: string | null;
  lastSellRepriceAt: string | null;
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
  rebalanceHourStart: 0,
  rebalanceHourEnd: 24,
  channelEnabled: false,
  channelReserveSats: 50_000,
  channelSizeSats: 0,
  channelCooldownMinutes: 1_440,
  sellEnabled: false,
  sellMaxDeploySats: 2_000_000,
  sellReserveSats: 50_000,
  sellMaxChannelSats: 5_000_000,
  sellAutoClose: false,
  sellAutoRelist: false,
  sellAutoReprice: true,
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
    private readonly amboss: AmbossStore,
  ) {
    this.store = new JsonStore<PersistedState>(dataDir, "autopilot.json");
    this.state = this.store.read({
      config: DEFAULT_CONFIG,
      lastRunAt: null,
      perChannelLastApplied: {},
      perTargetLastRebalanced: {},
      lastChannelOpenAt: null,
      lastSellRepriceAt: null,
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

  /** Cooldown view for the fee-recommendation dry-run (read-only). */
  feeCooldown(): { lastApplied: Record<string, string>; cooldownHours: number } {
    return {
      lastApplied: this.state.perChannelLastApplied,
      cooldownHours: this.state.config.cooldownMinutes / 60,
    };
  }

  /** Map the autopilot's existing policy onto the v2 engine, so v2 honours the
   *  user's own min/max/step/anti-churn caps instead of its wider defaults. */
  feeV2Overrides(): Partial<FeeRecConfig> {
    const p = this.state.config.policy;
    return {
      minPpm: p.minPpm,
      maxPpm: p.maxPpm,
      stepPpm: p.step,
      minChangePpm: p.minChangePpm,
      maxChangesPerRun: this.state.config.maxChangesPerRun,
    };
  }

  /** Public, serializable view for the API. */
  getState() {
    return {
      canWrite: this.canWrite,
      config: this.state.config,
      lastRunAt: this.state.lastRunAt,
      // Only surface runs that did something; hide any older "0 applied" no-ops.
      // Normalise older persisted runs that predate newer arrays.
      history: this.state.history
        .filter((r) => (r.attempted ?? 0) > 0)
        .slice(0, 20)
        .map((r) => ({
          ...r,
          changes: r.changes ?? [],
          rebalances: r.rebalances ?? [],
          channels: r.channels ?? [],
          sells: r.sells ?? [],
        })),
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

  private rebalanceCooldownOk(targetId: string, cooldownMin: number): boolean {
    const last = this.state.perTargetLastRebalanced[targetId];
    if (!last) return true;
    return (Date.now() - new Date(last).getTime()) / 60_000 >= cooldownMin;
  }

  /** Compute and apply eligible fee changes. */
  private async runFees(writeLnd: AuthenticatedLnd): Promise<AutopilotChange[]> {
    // v2 engine — wouldApply already folds in the relative/absolute threshold,
    // cooldown and max-changes-per-run, so we just apply the eligible ones.
    const report = await getFeeRecommendations(
      this.readLnd,
      this.rebalanceLog.recent(200),
      this.feeCooldown(),
      this.feeV2Overrides(),
      this.overrides.all(),
    );
    const eligible = report.recommendations.filter(
      (r) => r.wouldApply && r.transactionId !== null && r.transactionVout !== null,
    );

    const items: FeeApplyItem[] = eligible.map((r) => ({
      id: r.channelId,
      transactionId: r.transactionId as string,
      transactionVout: r.transactionVout as number,
      feeRatePpm: r.targetPpm,
      baseFeeMsat: r.currentBaseMsat, // preserve the channel's base fee
    }));

    const results = items.length ? await applyFees(this.readLnd, writeLnd, items) : [];
    const byId = new Map(eligible.map((r) => [r.channelId, r]));
    return results.map((res) => {
      const r = byId.get(res.id);
      if (res.ok) this.state.perChannelLastApplied[res.id] = new Date().toISOString();
      return {
        id: res.id,
        alias: r?.alias ?? res.id,
        fromPpm: r?.currentPpm ?? 0,
        toPpm: res.feeRatePpm,
        ok: res.ok,
        error: res.error,
      };
    });
  }

  /** Within the configured rebalance hour window (node local time)? */
  private inRebalanceWindow(): boolean {
    const { rebalanceHourStart: s, rebalanceHourEnd: e } = this.state.config;
    if (s === e) return true; // any time
    const h = new Date().getHours();
    return s < e ? h >= s && h < e : h >= s || h < e; // handles midnight wrap
  }

  /** Execute eligible (profitable, off-cooldown) rebalances. */
  private async runRebalances(writeLnd: AuthenticatedLnd): Promise<AutopilotRebalance[]> {
    if (!this.inRebalanceWindow()) return [];
    const { rebalancePolicy, maxRebalancesPerRun, rebalanceCooldownMinutes } = this.state.config;
    // v1 recommender — only acts on route_found_profitable (wouldRebalance), with
    // the fee-adjust-first / payback / profit gating already applied.
    const report = await getRebalanceRecommendations(
      this.readLnd,
      this.rebalanceLog.recent(200),
      this.feeCooldown(),
      this.feeV2Overrides(),
      this.overrides.all(),
    );
    const eligible = report.recommendations
      .filter(
        (r) =>
          r.wouldRebalance &&
          r.selectedSourceChannel &&
          r.recommendedAmount &&
          this.rebalanceCooldownOk(r.channelId, rebalanceCooldownMinutes),
      )
      .slice(0, maxRebalancesPerRun);

    const out: AutopilotRebalance[] = [];
    for (const r of eligible) {
      const res = await executeRebalance(this.readLnd, writeLnd, {
        targetId: r.channelId,
        sourceId: r.selectedSourceChannel as string,
        amountSats: r.recommendedAmount as number,
        econRatio: rebalancePolicy.econRatio,
        maxFeePpm: r.maxCostPpm ?? undefined, // the v1 economic ceiling
      });
      // Mark the target on every attempt (success or fail) so the cooldown also
      // backs off failing targets — no more hammering the same dead route.
      this.state.perTargetLastRebalanced[r.channelId] = new Date().toISOString();
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

    const { suggestions } = await getChannelSuggestionsV2(this.readLnd, {});
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

  /**
   * Magma liquidity provision: auto-fulfill incoming sell orders within caps.
   * Accept (creates the fee invoice) → open the channel to the buyer → after the
   * lease, optionally close it to reclaim the capital. Every action is gated by
   * the deploy cap, max channel size and on-chain reserve.
   */
  private async runSell(writeLnd: AuthenticatedLnd): Promise<AutopilotSell[]> {
    const cfg = this.state.config;
    if (!cfg.sellEnabled || !this.amboss.hasKey()) return [];

    let orders;
    try {
      orders = (await getMyOrders(this.amboss.getKey())).orders.filter((o) => o.side === "SELL");
    } catch {
      return []; // Amboss unreachable — retry next run
    }

    const key = this.amboss.getKey();
    const out: AutopilotSell[] = [];
    const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const { chain_balance } = await getChainBalance({ lnd: this.readLnd });
    const skip = (o: { id: string; sizeSats: number }, error: string) =>
      out.push({ orderId: o.id, action: "skip" as const, sizeSats: o.sizeSats, ok: false, error });

    // Capital already committed to currently-open sold channels.
    const deployed = orders
      .filter((o) => o.channelId && o.blocksUntilClosable > 0)
      .reduce((s, o) => s + o.sizeSats, 0);
    // Capital committed during THIS run (accepts + opens) — so multiple orders in
    // one run can't each pass against the same starting balance and collectively
    // blow past the deploy cap or the on-chain reserve.
    let extra = 0;

    // Manage live offers: keep the price competitive (Magma v2 reprice) and top up
    // depleted offers so they keep taking orders. Repricing uses the profit-aware
    // recommendation (only when it beats routing and is competitive), is capped to
    // once per 24h, and never sells when the node itself needs inbound. Relisting
    // commits no funds; order fulfillment re-checks the caps before any open.
    if (cfg.sellAutoRelist || cfg.sellAutoReprice) {
      try {
        const offers = await getMyOffers(key);
        let recByOffer = new Map<string, MagmaSellRecommendation>();
        let canReprice = false;
        if (cfg.sellAutoReprice) {
          canReprice =
            !this.state.lastSellRepriceAt ||
            Date.now() - new Date(this.state.lastSellRepriceAt).getTime() >= 24 * 3_600_000;
          try {
            const rec = await getMagmaRecommendations(this.readLnd, key);
            if (rec.sell.state !== "not_recommended_node_needs_inbound")
              recByOffer = new Map(
                rec.sell.recommendations.filter((r) => r.offerId).map((r) => [r.offerId as string, r]),
              );
          } catch {
            // no recommendation — fall back to the offer's current price
          }
        }
        // Recommended price for an offer, when a reprice is actually warranted + allowed.
        const priceFor = (off: { id: string; feeRatePpm: number; baseFeeSats: number }) => {
          const r = recByOffer.get(off.id);
          const should =
            !!r &&
            r.shouldReprice &&
            r.economics.beatsRouting &&
            r.state !== "do_not_list_unprofitable" &&
            r.state !== "do_not_list_uncompetitive";
          if (should && canReprice && r) return { fee: r.recommended.feeRatePpm, base: r.recommended.baseFeeSat, repriced: true };
          return { fee: off.feeRatePpm, base: off.baseFeeSats, repriced: false };
        };

        for (const off of offers) {
          if (off.status !== "ENABLED") continue;
          const depleted = off.totalSizeSats < off.maxSizeSats;
          const price = priceFor(off);

          if (depleted && cfg.sellAutoRelist) {
            if (off.maxSizeSats > chain_balance - cfg.sellReserveSats) continue;
            if (off.maxSizeSats > cfg.sellMaxDeploySats - deployed) continue;
            await updateOffer(key, off.id, {
              totalSizeSats: off.maxSizeSats,
              minSizeSats: off.minSizeSats,
              maxSizeSats: off.maxSizeSats,
              feeRatePpm: price.fee,
              baseFeeSats: price.base,
              minBlockLength: off.minBlockLength,
            });
            out.push({ orderId: off.id, action: "relist", sizeSats: off.maxSizeSats, ok: true });
            if (price.repriced) this.state.lastSellRepriceAt = new Date().toISOString();
          } else if (!depleted && price.repriced) {
            await updateOffer(key, off.id, {
              totalSizeSats: off.totalSizeSats,
              minSizeSats: off.minSizeSats,
              maxSizeSats: off.maxSizeSats,
              feeRatePpm: price.fee,
              baseFeeSats: price.base,
              minBlockLength: off.minBlockLength,
            });
            out.push({ orderId: off.id, action: "reprice", sizeSats: off.totalSizeSats, ok: true });
            this.state.lastSellRepriceAt = new Date().toISOString();
          }
        }
      } catch {
        // best-effort — managing offers never blocks order fulfillment
      }
    }

    if (orders.length === 0) return out;

    let myChannels: { transaction_id: string; transaction_vout: number }[] | null = null;

    for (const o of orders) {
      if (o.status === "WAITING_FOR_SELLER_APPROVAL") {
        if (o.sizeSats > cfg.sellMaxChannelSats) {
          skip(o, "above max channel size");
        } else if (deployed + extra + o.sizeSats > cfg.sellMaxDeploySats) {
          skip(o, "deploy cap reached");
        } else if (chain_balance - extra - o.sizeSats < cfg.sellReserveSats) {
          skip(o, "would breach on-chain reserve");
        } else {
          try {
            const inv = await createInvoice(writeLnd, {
              tokens: o.feeSats,
              description: `Magma order ${o.id}`,
              expirySec: 49 * 3600,
            });
            await acceptOrder(key, o.id, inv.request);
            extra += o.sizeSats; // committed — it will need funding when it opens
            out.push({ orderId: o.id, action: "accept", sizeSats: o.sizeSats, ok: true });
          } catch (e) {
            out.push({ orderId: o.id, action: "accept", sizeSats: o.sizeSats, ok: false, error: msg(e) });
          }
        }
      } else if (o.status === "WAITING_FOR_CHANNEL_OPEN") {
        if (deployed + extra + o.sizeSats > cfg.sellMaxDeploySats) {
          skip(o, "deploy cap reached");
          continue;
        }
        if (chain_balance - extra - o.sizeSats < cfg.sellReserveSats) {
          skip(o, "would breach on-chain reserve");
          continue;
        }
        const [pubkey, socket] = o.destination.split("@");
        if (!pubkey) {
          out.push({ orderId: o.id, action: "open", sizeSats: o.sizeSats, ok: false, error: "no buyer endpoint" });
          continue;
        }
        const res = await openChannelTo(writeLnd, { pubkey, socket: socket || undefined, localTokens: o.sizeSats });
        if (res.ok && res.transactionId) {
          try {
            await addOrderTransaction(key, o.id, `${res.transactionId}:${res.transactionVout}`);
            extra += o.sizeSats;
            // Disclosed service fee on a completed sale — best-effort, never throws.
            const fee = await paySaleServiceFee(writeLnd, o.feeSats);
            if (fee.paid) console.log(`[fee] order ${o.id}: paid ${fee.sats} sat service fee`);
            out.push({ orderId: o.id, action: "open", sizeSats: o.sizeSats, ok: true, transactionId: res.transactionId });
          } catch (e) {
            out.push({ orderId: o.id, action: "open", sizeSats: o.sizeSats, ok: false, error: `channel opened but Amboss update failed: ${msg(e)}` });
          }
        } else {
          out.push({ orderId: o.id, action: "open", sizeSats: o.sizeSats, ok: false, error: res.error });
        }
      } else if (cfg.sellAutoClose && o.channelId && o.transactionId && o.blocksUntilClosable <= 0) {
        if (!myChannels) {
          try {
            myChannels = (await getChannels({ lnd: this.readLnd })).channels.map((c) => ({
              transaction_id: c.transaction_id,
              transaction_vout: c.transaction_vout,
            }));
          } catch {
            myChannels = [];
          }
        }
        const ch = myChannels.find((c) => c.transaction_id === o.transactionId);
        if (!ch) continue; // already closed or not ours
        const res = await closeChannelByOutpoint(writeLnd, ch.transaction_id, ch.transaction_vout, false);
        out.push({ orderId: o.id, action: "close", sizeSats: o.sizeSats, ok: res.ok, transactionId: res.transactionId, error: res.error });
      }
    }
    return out;
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
      sells: [],
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
      const sells = await this.runSell(writeLnd);
      // "skip" entries are non-actions (cap/reserve) — don't count them as attempts.
      const acted = sells.filter((s) => s.action !== "skip");

      const run: AutopilotRun = {
        at: new Date().toISOString(),
        attempted: changes.length + rebalances.length + channels.length + acted.length,
        applied:
          changes.filter((c) => c.ok).length +
          rebalances.filter((r) => r.ok).length +
          channels.filter((c) => c.ok).length +
          acted.filter((s) => s.ok).length,
        failed:
          changes.filter((c) => !c.ok).length +
          rebalances.filter((r) => !r.ok).length +
          channels.filter((c) => !c.ok).length +
          acted.filter((s) => !s.ok).length,
        changes,
        rebalances,
        channels,
        sells,
      };

      this.state.lastRunAt = run.at;
      // Only record runs that actually did something (applied or failed) — skip the
      // hourly no-op runs so the history shows changes, not "0 applied" every hour.
      if (run.attempted > 0) {
        this.state.history.unshift(run);
        this.state.history = this.state.history.slice(0, HISTORY_LIMIT);
      }
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
