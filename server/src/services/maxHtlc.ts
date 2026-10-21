import { getChannel, getChannels, updateRoutingFees, type AuthenticatedLnd } from "lightning";
import { getOwnPubkey } from "./node.js";
import { getAlias } from "./aliases.js";
import { channelMaxPendingMsat, updateRefusal } from "./fees.js";

/**
 * Dynamic max_htlc — advertise only what a channel can actually forward.
 *
 * Senders' pathfinding reads our gossiped `max_htlc` and skips channels that
 * can't carry their payment. Keeping it just under the spendable balance turns
 * "try, fail, retry elsewhere" into "never tried" — fewer failed HTLCs through
 * us, better reputation with senders, more completed forwards (the whole point
 * of Paket 3).
 *
 * Power-of-2 buckets, for two reasons:
 *  - privacy: the advertised value only reveals the balance's magnitude, not
 *    its exact size (a fee-update side channel otherwise)
 *  - gossip hygiene: an update is only broadcast when the BUCKET changes, not
 *    on every routed sat
 *
 * Raising to a bigger bucket needs 10% headroom above the bucket floor so a
 * balance sitting exactly on a boundary doesn't flap; lowering happens
 * immediately — advertising more than we can forward is exactly the failure
 * mode this exists to prevent.
 */

export interface MaxHtlcChange {
  id: string;
  alias: string;
  /** Previously advertised max_htlc (sat), null = none/unknown. */
  fromSat: number | null;
  toSat: number;
  ok: boolean;
  error?: string;
}

/** Never advertise below this — keeps max_htlc sane on drained channels. */
const MIN_BUCKET_SAT = 1_024;
/** Spendable must clear the target bucket by this factor before we raise. */
const RAISE_HEADROOM = 1.1;
/** After LND refused a channel's update, leave it alone this long (it was
 *  retried — and recorded as applied — every 30-minute run). */
export const MAX_HTLC_BACKOFF_MS = 6 * 3_600_000;

/** Largest power of two ≤ spendable (floored to the minimum bucket). */
export function maxHtlcBucketSat(spendableSat: number): number {
  if (spendableSat < MIN_BUCKET_SAT) return MIN_BUCKET_SAT;
  return 2 ** Math.floor(Math.log2(spendableSat));
}

/** Decide whether to move a channel's advertised max_htlc, and to what. */
export function decideMaxHtlc(
  spendableSat: number,
  currentMaxSat: number | null,
): { change: boolean; toSat: number } {
  const bucket = maxHtlcBucketSat(spendableSat);
  if (currentMaxSat == null) return { change: true, toSat: bucket };
  if (bucket === currentMaxSat) return { change: false, toSat: bucket };
  // Lower immediately; raise only with headroom over the bucket floor.
  if (bucket < currentMaxSat) return { change: true, toSat: bucket };
  if (spendableSat >= bucket * RAISE_HEADROOM) return { change: true, toSat: bucket };
  return { change: false, toSat: currentMaxSat };
}

/**
 * One pass over all active channels: read the current policy, compute the
 * bucket from the spendable balance, and update where the bucket moved.
 * Fee rate / base fee / CLTV / min_htlc are always echoed back unchanged.
 *
 * The bucket never exceeds the channel's max pending amount: LND refuses a
 * policy whose max_htlc is above it (review a1) — and LND's refusals come
 * back as `failures`, not as an error: each is recorded as failed, and the
 * channel is left alone for MAX_HTLC_BACKOFF_MS (`backoff`: channel id →
 * when it was refused, kept by the caller).
 */
export async function runMaxHtlcPass(
  readLnd: AuthenticatedLnd,
  writeLnd: AuthenticatedLnd,
  backoff: Map<string, number> = new Map(),
): Promise<MaxHtlcChange[]> {
  const [{ channels }, mine] = await Promise.all([getChannels({ lnd: readLnd }), getOwnPubkey(readLnd)]);
  const out: MaxHtlcChange[] = [];
  const now = Date.now();

  for (const c of channels.filter((ch) => ch.is_active)) {
    const refusedAt = backoff.get(c.id);
    if (refusedAt !== undefined && now - refusedAt < MAX_HTLC_BACKOFF_MS) continue;
    // What this channel could actually forward right now — and never more
    // than LND lets a single HTLC be on it.
    const maxPendingMsat = channelMaxPendingMsat(c);
    const spendable = Math.min(
      Math.max(0, c.local_balance - (c.local_reserve ?? 0)),
      maxPendingMsat !== null ? Math.floor(maxPendingMsat / 1000) : Infinity,
    );

    let current;
    try {
      const channel = await getChannel({ lnd: readLnd, id: c.id });
      current = channel.policies.find((p) => p.public_key === mine);
    } catch {
      continue; // not in the graph (private) — nothing gossiped, nothing to manage
    }
    // Without the full current policy we'd risk resetting cltv/fees — skip.
    if (!current || current.cltv_delta === undefined || current.fee_rate === undefined) continue;

    const currentMaxSat = current.max_htlc_mtokens ? Math.floor(Number(current.max_htlc_mtokens) / 1000) : null;
    const { change, toSat } = decideMaxHtlc(spendable, currentMaxSat);
    if (!change) continue;

    try {
      const res = await updateRoutingFees({
        lnd: writeLnd,
        transaction_id: c.transaction_id,
        transaction_vout: c.transaction_vout,
        fee_rate: current.fee_rate,
        ...(current.base_fee_mtokens ? { base_fee_mtokens: current.base_fee_mtokens } : {}),
        cltv_delta: current.cltv_delta,
        max_htlc_mtokens: String(toSat * 1000),
        ...(current.min_htlc_mtokens ? { min_htlc_mtokens: current.min_htlc_mtokens } : {}),
      });
      const refused = updateRefusal(res, c.transaction_id, c.transaction_vout);
      if (refused) {
        backoff.set(c.id, now);
        out.push({
          id: c.id,
          alias: await getAlias(readLnd, c.partner_public_key),
          fromSat: currentMaxSat,
          toSat,
          ok: false,
          error: `${refused} — not retried for ${MAX_HTLC_BACKOFF_MS / 3_600_000} h`,
        });
        continue;
      }
      backoff.delete(c.id);
      out.push({
        id: c.id,
        alias: await getAlias(readLnd, c.partner_public_key),
        fromSat: currentMaxSat,
        toSat,
        ok: true,
      });
    } catch (err) {
      backoff.set(c.id, now);
      out.push({
        id: c.id,
        alias: await getAlias(readLnd, c.partner_public_key),
        fromSat: currentMaxSat,
        toSat,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
