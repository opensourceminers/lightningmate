import {
  getChannel,
  getFeeRates,
  getWalletInfo,
  updateRoutingFees,
  type AuthenticatedLnd,
} from "lightning";
import { getChannelsView } from "./channels.js";

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
  /** Flat base fee to set, in millisatoshis (1000 msat = 1 sat). */
  baseFeeMsat: number;
  /** Round proposed ppm to the nearest step (avoids noisy tiny updates). */
  step: number;
  /** Only flag a change when |proposed − current| ≥ this (anti-churn). */
  minChangePpm: number;
}

export const DEFAULT_POLICY: FeePolicy = {
  minPpm: 50,
  maxPpm: 1000,
  baseFeeMsat: 1000,
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
  if (delta > 0) return `drained (${pct}% local) → raise to slow drain & earn more`;
  if (delta < 0) return `full (${pct}% local) → lower to encourage outflow`;
  return `balanced (${pct}% local) → keep`;
}

/**
 * Dry-run: compute proposed fees for every channel against the policy. Reads
 * only (getFeeRates + getChannels) — it never writes to the node.
 */
export async function getFeePreview(
  lnd: AuthenticatedLnd,
  overrides: Partial<FeePolicy> = {},
): Promise<FeePreview> {
  const policy = { ...DEFAULT_POLICY, ...overrides };

  const [channels, rates] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
  ]);

  const rateById = new Map(rates.channels.map((c) => [c.id, c]));

  const proposals: FeeProposal[] = channels.map((ch) => {
    const rate = rateById.get(ch.id);
    const currentPpm = rate?.fee_rate ?? 0;
    const proposedPpm = targetPpm(ch.localRatio, policy);
    const deltaPpm = proposedPpm - currentPpm;
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
      willChange: Math.abs(deltaPpm) >= policy.minChangePpm,
      reason: reasonFor(ch.localRatio, deltaPpm),
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
  feeRatePpm: number;
  error?: string;
}

let cachedPubkey: string | undefined;
async function ownPubkey(lnd: AuthenticatedLnd): Promise<string> {
  if (cachedPubkey) return cachedPubkey;
  cachedPubkey = (await getWalletInfo({ lnd })).public_key;
  return cachedPubkey;
}

/**
 * Apply fee updates to the node. `readLnd` reads each channel's current policy
 * (to preserve cltv_delta + HTLC limits, which LND would otherwise reset to
 * defaults), `writeLnd` performs the update. Channels whose current policy can't
 * be read are skipped rather than risk clobbering their timelock settings.
 */
export async function applyFees(
  readLnd: AuthenticatedLnd,
  writeLnd: AuthenticatedLnd,
  items: FeeApplyItem[],
): Promise<FeeApplyResult[]> {
  const mine = await ownPubkey(readLnd);
  const results: FeeApplyResult[] = [];

  for (const item of items) {
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
          error: "skipped: current policy (cltv) unreadable — won't risk a reset",
        });
        continue;
      }

      await updateRoutingFees({
        lnd: writeLnd,
        transaction_id: item.transactionId,
        transaction_vout: item.transactionVout,
        fee_rate: item.feeRatePpm,
        base_fee_mtokens: String(item.baseFeeMsat),
        cltv_delta: current.cltv_delta,
        ...(current.max_htlc_mtokens
          ? { max_htlc_mtokens: current.max_htlc_mtokens }
          : {}),
        ...(current.min_htlc_mtokens
          ? { min_htlc_mtokens: current.min_htlc_mtokens }
          : {}),
      });

      results.push({ id: item.id, ok: true, feeRatePpm: item.feeRatePpm });
    } catch (err) {
      results.push({
        id: item.id,
        ok: false,
        feeRatePpm: item.feeRatePpm,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}
