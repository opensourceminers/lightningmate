import {
  getChannel,
  getChannels,
  getFeeRates,
  getWalletInfo,
  updateRoutingFees,
  type AuthenticatedLnd,
  type UpdateRoutingFeesResult,
} from "lightning";
import { getChannelsView } from "./channels.js";
import { getOwnPubkey } from "./node.js";
import type { OverrideMap } from "./overrides.js";
import { activeCap, capText, clampToCap, type LeaseCap } from "./leaseCaps.js";

/**
 * A fee policy maps each channel's *current local balance ratio* to a target
 * outbound fee rate (ppm), along a linear curve:
 *
 *   localRatio = 1 (full / lots of outbound)  → minPpm   (cheap, invite outflow)
 *   localRatio = 0 (drained / no outbound)    → maxPpm   (expensive, slow drain & earn)
 *
 * This lets the market rebalance the node via fees instead of paid rebalances.
 */
export interface FeePolicy {
  minPpm: number;
  maxPpm: number;
  /** Balanced-channel fee (v2 engine) — where the fee curve sits at target ratio.
   *  Lower = more competitive / more forwards; higher = fewer, richer forwards. */
  neutralPpm: number;
  /** Flat base fee to set, in millisatoshis (1000 msat = 1 sat). */
  baseFeeMsat: number;
  /** Floor for a drained-but-still-wanted channel (v2 engine). */
  protectPpm: number;
  /** Profit floor = rebalance cost basis × this margin (v2 engine). */
  safetyMargin: number;
  /** How fast an idle channel's fee ratchets down (steps/run, v2 engine). */
  noFlowRatchetSteps: number;
  /** Explore-lower multiplier for idle over-local channels (<1, v2 engine). */
  exploreLowerModifier: number;
  /** Round proposed ppm to the nearest step (avoids noisy tiny updates). */
  step: number;
  /** Only flag a change when |proposed − current| ≥ this (anti-churn). */
  minChangePpm: number;
}

export const DEFAULT_POLICY: FeePolicy = {
  minPpm: 25,
  maxPpm: 1000,
  neutralPpm: 80,
  baseFeeMsat: 0,
  protectPpm: 350,
  safetyMargin: 1.15,
  noFlowRatchetSteps: 3,
  exploreLowerModifier: 0.85,
  step: 10,
  minChangePpm: 25,
};

/** Target fee rate (ppm) for a channel at the given local balance ratio. */
export function targetPpm(localRatio: number, p: FeePolicy): number {
  const clamped = Math.min(1, Math.max(0, localRatio));
  const raw = p.minPpm + (p.maxPpm - p.minPpm) * (1 - clamped);
  return Math.round(raw / p.step) * p.step;
}

export interface FeeProposal {
  id: string;
  peerAlias: string;
  active: boolean;
  /** Funding outpoint — needed to target this channel when applying. */
  transactionId: string | null;
  transactionVout: number | null;
  localRatio: number;
  currentPpm: number;
  proposedPpm: number;
  deltaPpm: number;
  currentBaseMsat: number;
  proposedBaseMsat: number;
  /** True when the change is large enough to be worth applying. */
  willChange: boolean;
  reason: string;
}

export interface FeePreview {
  policy: FeePolicy;
  proposals: FeeProposal[];
  /** Active channels whose fee would actually change. */
  changeCount: number;
}

function reasonFor(localRatio: number, delta: number): string {
  const pct = Math.round(localRatio * 100);
  // Describe the channel by its actual balance, not the change direction — the
  // fee can move either way just to align a channel back onto the policy curve.
  const state = localRatio >= 0.55 ? "full" : localRatio <= 0.45 ? "drained" : "balanced";
  if (delta > 0) return `${state} (${pct}% local) → raise toward target`;
  if (delta < 0) return `${state} (${pct}% local) → lower toward target`;
  return `${state} (${pct}% local) → on target`;
}

/**
 * Dry-run: compute proposed fees for every channel against the policy. Reads
 * only (getFeeRates + getChannels) — it never writes to the node.
 */
export async function getFeePreview(
  lnd: AuthenticatedLnd,
  policyOverrides: Partial<FeePolicy> = {},
  channelOverrides: OverrideMap = {},
): Promise<FeePreview> {
  const policy = { ...DEFAULT_POLICY, ...policyOverrides };

  const [channels, rates] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
  ]);

  const rateById = new Map(rates.channels.map((c) => [c.id, c]));

  const proposals: FeeProposal[] = channels.map((ch) => {
    const rate = rateById.get(ch.id);
    const currentPpm = rate?.fee_rate ?? 0;
    const ov = channelOverrides[ch.id];

    let proposedPpm: number;
    let reason: string;
    if (ov?.mode === "exclude") {
      proposedPpm = currentPpm;
      reason = "excluded (manual)";
    } else if (ov?.mode === "fixed") {
      proposedPpm = ov.fixedPpm ?? currentPpm;
      reason = `pinned to ${proposedPpm} ppm (manual)`;
    } else {
      proposedPpm = targetPpm(ch.localRatio, policy);
      reason = reasonFor(ch.localRatio, proposedPpm - currentPpm);
    }

    const deltaPpm = proposedPpm - currentPpm;
    const willChange = ov?.mode !== "exclude" && Math.abs(deltaPpm) >= policy.minChangePpm;
    return {
      id: ch.id,
      peerAlias: ch.peerAlias,
      active: ch.active,
      transactionId: rate?.transaction_id ?? null,
      transactionVout: rate?.transaction_vout ?? null,
      localRatio: ch.localRatio,
      currentPpm,
      proposedPpm,
      deltaPpm,
      currentBaseMsat: rate ? Number(rate.base_fee_mtokens) : 0,
      proposedBaseMsat: policy.baseFeeMsat,
      willChange,
      reason,
    };
  });

  // Biggest proposed changes first.
  proposals.sort((a, b) => Math.abs(b.deltaPpm) - Math.abs(a.deltaPpm));

  return {
    policy,
    proposals,
    changeCount: proposals.filter((p) => p.willChange && p.active).length,
  };
}

// ── Applying fees (writes) ────────────────────────────────────────────────────

export interface FeeApplyItem {
  id: string;
  transactionId: string;
  transactionVout: number;
  feeRatePpm: number;
  baseFeeMsat: number;
}

export interface FeeApplyResult {
  id: string;
  ok: boolean;
  /** The fee rate applied (after a lease promise's clamp, if one bound it). */
  feeRatePpm: number;
  /** The base fee applied, msat. */
  baseFeeMsat?: number;
  /** Set when a sold channel's lease promise lowered what was asked for. */
  clampedBy?: string;
  error?: string;
}

/**
 * LND answers a policy update with a list of per-channel failures instead of
 * an error (review a1: they were ignored — an update LND refused was recorded
 * as applied, its cooldown stamped, its outcome measured). The one for this
 * channel, as text; null when LND took it.
 */
export function updateRefusal(res: UpdateRoutingFeesResult | undefined, transactionId: string, transactionVout: number): string | null {
  const failures = res?.failures ?? [];
  if (failures.length === 0) return null;
  const f = failures.find((x) => x.transaction_id === transactionId && x.transaction_vout === transactionVout) ?? failures[0];
  const why = f.is_pending_channel ? " (channel still pending)" : f.is_unknown_channel ? " (unknown channel)" : f.is_invalid_policy ? " (invalid policy)" : "";
  return `LND refused the update: ${f.failure || "no reason given"}${why}`;
}

/** The most a single HTLC may be on a channel (msat): the smaller of its two
 *  max pending amounts — LND checks a policy's max_htlc against its own, and
 *  a lower bound is always safe. Null when neither is known. */
export function channelMaxPendingMsat(c: { local_max_pending_mtokens?: string; remote_max_pending_mtokens?: string }): number | null {
  const limits = [c.local_max_pending_mtokens, c.remote_max_pending_mtokens]
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0);
  return limits.length ? Math.min(...limits) : null;
}

/** Each channel's max pending amount (channelMaxPendingMsat), by funding
 *  outpoint. Empty when it can't be read — the policy is then echoed as
 *  before. */
export async function maxPendingByOutpoint(lnd: AuthenticatedLnd): Promise<Map<string, number>> {
  try {
    const { channels } = await getChannels({ lnd });
    const out = new Map<string, number>();
    for (const c of channels) {
      const max = channelMaxPendingMsat(c);
      if (max !== null) out.set(`${c.transaction_id}:${c.transaction_vout}`, max);
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Apply fee updates to the node. `readLnd` reads each channel's current policy
 * (to preserve cltv_delta + HTLC limits, which LND would otherwise reset to
 * defaults), `writeLnd` performs the update. Channels whose current policy can't
 * be read are skipped rather than risk clobbering their timelock settings.
 *
 * `leaseCaps`: the routing-fee promises of sold channels (D7). Every write —
 * the autopilot's and a manual apply alike — is clamped to the promise of the
 * channel it targets while its lease runs; the result says so. This is the
 * last gate before LND, so no path can raise a sold channel past its promise.
 */
export async function applyFees(
  readLnd: AuthenticatedLnd,
  writeLnd: AuthenticatedLnd,
  items: FeeApplyItem[],
  leaseCaps: readonly LeaseCap[] = [],
): Promise<FeeApplyResult[]> {
  const mine = await getOwnPubkey(readLnd);
  const results: FeeApplyResult[] = [];
  // The lease of a confirmed channel runs from its funding block: the tip
  // tells whether it is still on. (Only asked when a promise exists.)
  const height = leaseCaps.length ? (await getWalletInfo({ lnd: readLnd })).current_block_height : 0;
  // A max_htlc above the channel's max pending amount makes LND refuse the
  // whole update ("max htlc size … is above max pending amount"): such a
  // legacy value is not echoed — left out, LND keeps or corrects it itself.
  const maxPending = await maxPendingByOutpoint(readLnd);

  for (const asked of items) {
    const cap = leaseCaps.length
      ? activeCap(leaseCaps, { outpoint: `${asked.transactionId}:${asked.transactionVout}`, channelId: asked.id }, height)
      : null;
    const kept = cap ? clampToCap({ feeRatePpm: asked.feeRatePpm, baseFeeMsat: asked.baseFeeMsat }, cap) : null;
    const item: FeeApplyItem = kept ? { ...asked, feeRatePpm: kept.feeRatePpm, baseFeeMsat: kept.baseFeeMsat } : asked;
    const clampedBy = cap && kept?.clamped ? `${capText(cap)} — applied ${item.feeRatePpm} ppm, not ${asked.feeRatePpm}` : undefined;
    try {
      let current;
      try {
        const channel = await getChannel({
          lnd: readLnd,
          transaction_id: item.transactionId,
          transaction_vout: item.transactionVout,
        });
        current = channel.policies.find((p) => p.public_key === mine);
      } catch {
        // Not in the public graph (e.g. private channel).
      }

      if (!current || current.cltv_delta === undefined) {
        results.push({
          id: item.id,
          ok: false,
          feeRatePpm: item.feeRatePpm,
          ...(clampedBy ? { clampedBy } : {}),
          error: "skipped: current policy (cltv) unreadable — won't risk a reset",
        });
        continue;
      }

      const limit = maxPending.get(`${item.transactionId}:${item.transactionVout}`);
      const echoMaxHtlc = !!current.max_htlc_mtokens && (limit === undefined || Number(current.max_htlc_mtokens) <= limit);
      const res = await updateRoutingFees({
        lnd: writeLnd,
        transaction_id: item.transactionId,
        transaction_vout: item.transactionVout,
        fee_rate: item.feeRatePpm,
        base_fee_mtokens: String(item.baseFeeMsat),
        cltv_delta: current.cltv_delta,
        ...(echoMaxHtlc ? { max_htlc_mtokens: current.max_htlc_mtokens } : {}),
        ...(current.min_htlc_mtokens
          ? { min_htlc_mtokens: current.min_htlc_mtokens }
          : {}),
      });
      const refused = updateRefusal(res, item.transactionId, item.transactionVout);
      if (refused) {
        results.push({ id: item.id, ok: false, feeRatePpm: item.feeRatePpm, ...(clampedBy ? { clampedBy } : {}), error: refused });
        continue;
      }

      results.push({ id: item.id, ok: true, feeRatePpm: item.feeRatePpm, baseFeeMsat: item.baseFeeMsat, ...(clampedBy ? { clampedBy } : {}) });
    } catch (err) {
      results.push({
        id: item.id,
        ok: false,
        feeRatePpm: item.feeRatePpm,
        ...(clampedBy ? { clampedBy } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
