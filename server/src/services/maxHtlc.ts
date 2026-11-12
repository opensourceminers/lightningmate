import { getChannel, getChannels, updateRoutingFees, type AuthenticatedLnd } from "lightning";
import { getOwnPubkey } from "./node.js";
import { getAlias } from "./aliases.js";
import { channelMaxPendingMsat, inboundFeeEcho, updateRefusal } from "./fees.js";
import { errorText } from "./errorText.js";

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
 * balance sitting exactly on a boundary doesn't flap; lowering needs none —
 * advertising more than we can forward is exactly the failure mode this
 * exists to prevent.
 *
 * Paced per channel (review FEE-6): a near-empty channel in use crossed a
 * bucket boundary with every payment in and out — 32,768 ↔ 65,536 four times
 * in a day in the probe, an update a run where payments come between runs —
 * and every one is a channel update the whole network relays, on top of the
 * fee stage's own. Peers limit how many they take from one channel, and a
 * sender still holding the older, larger value fails its first try anyway.
 * So one channel's max_htlc changes at most once in MAX_HTLC_MIN_INTERVAL_MS
 * — except a change of two buckets or more, either way. Down (a quarter of
 * what is advertised, or less): the channel is far emptier than it says,
 * which is what this exists to prevent. Up (four times what is advertised,
 * or more): it was emptied and filled again, and held to the small size it
 * would advertise 8,192 sat for six hours with 600,000 to sell — senders'
 * pathfinding skips it for every payment above that (review of the fee
 * package, R4). Within the interval the advertised size is off by one bucket
 * at most, either way.
 *
 * A channel the operator excluded from fee automation is left alone here too
 * (review FEE-5): its policy was rewritten — fee, base fee and CLTV echoed,
 * max_htlc changed — and gossiped, eight times in three days in the probe,
 * for a channel "the autopilot never touches"; whoever excludes a channel to
 * manage it with another tool had two writers on it. A pinned channel stays
 * managed: the pin is about its fee.
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

/** The smallest bucket advertised while a channel can forward anything. */
const MIN_BUCKET_SAT = 1_024;
/** Spendable must clear the target bucket by this factor before we raise. */
const RAISE_HEADROOM = 1.1;
/** After LND refused a channel's update, leave it alone this long (it was
 *  retried — and recorded as applied — every 30-minute run). */
export const MAX_HTLC_BACKOFF_MS = 6 * 3_600_000;
/** The least time between two max_htlc changes on one channel (four a day
 *  at most), a change by URGENT_CHANGE or more — either way — excepted. */
export const MAX_HTLC_MIN_INTERVAL_MS = 6 * 3_600_000;
/** Two buckets: the channel can forward a quarter of what it advertises, or
 *  four times as much. */
const URGENT_CHANGE = 4;

/**
 * Largest power of two ≤ spendable. Below the smallest bucket: the
 * channel's min_htlc — the least LND accepts (`minHtlcSat`, at least 1 sat).
 * A channel at its reserve advertised 1,024 sat it couldn't forward: senders
 * tried small payments that failed, and those failures read as "possible
 * demand" that kept the channel protected and raising (review 2026-10-25).
 */
export function maxHtlcBucketSat(spendableSat: number, minHtlcSat = 1): number {
  if (spendableSat < MIN_BUCKET_SAT) return Math.max(1, minHtlcSat);
  return 2 ** Math.floor(Math.log2(spendableSat));
}

/** Decide whether to move a channel's advertised max_htlc, and to what. */
export function decideMaxHtlc(
  spendableSat: number,
  currentMaxSat: number | null,
  minHtlcSat = 1,
): { change: boolean; toSat: number } {
  const bucket = maxHtlcBucketSat(spendableSat, minHtlcSat);
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
 * Fee rate / base fee / CLTV / min_htlc — and an inbound fee set by hand
 * (inboundFeeEcho) — are always echoed back unchanged.
 *
 * The bucket never exceeds the channel's max pending amount: LND refuses a
 * policy whose max_htlc is above it (review a1) — and LND's refusals come
 * back as `failures`, not as an error: each is recorded as failed, and the
 * channel is left alone for MAX_HTLC_BACKOFF_MS (`backoff`: channel id →
 * when it was refused, kept by the caller).
 *
 * `shouldStop`: asked right before each update — once it says yes, the pass
 * ends there and writes nothing more (the switch went off, or all
 * automation was paused, while it ran — review of P7).
 *
 * `excluded`: the channels the operator took out of fee automation — not
 * read, not written. `lastChanged`: when each channel's max_htlc was last
 * changed by a pass (kept by the caller), for the pacing above; kept in
 * memory only — after a restart one change may come early.
 */
export async function runMaxHtlcPass(
  readLnd: AuthenticatedLnd,
  writeLnd: AuthenticatedLnd,
  backoff: Map<string, number> = new Map(),
  opts: {
    shouldStop?: () => boolean;
    /** The last update applied per channel (kept by the caller): one that
     *  LND took but the channel doesn't advertise is not sent again. */
    lastWrites?: Map<string, { fromSat: number | null; toSat: number }>;
    excluded?: ReadonlySet<string>;
    lastChanged?: Map<string, number>;
  } = {},
): Promise<MaxHtlcChange[]> {
  const lastWrites = opts.lastWrites ?? new Map<string, { fromSat: number | null; toSat: number }>();
  const lastChanged = opts.lastChanged ?? new Map<string, number>();
  const [{ channels }, mine] = await Promise.all([getChannels({ lnd: readLnd }), getOwnPubkey(readLnd)]);
  const out: MaxHtlcChange[] = [];
  const now = Date.now();
  for (const [id, at] of lastChanged) if (now - at >= MAX_HTLC_MIN_INTERVAL_MS) lastChanged.delete(id);

  for (const c of channels.filter((ch) => ch.is_active && !opts.excluded?.has(ch.id))) {
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
    const minHtlcSat = current.min_htlc_mtokens ? Math.ceil(Number(current.min_htlc_mtokens) / 1000) : 1;
    const { change, toSat } = decideMaxHtlc(spendable, currentMaxSat, minHtlcSat);
    // The last update LND said OK to, and the channel still advertises what
    // it replaced: it didn't take. Sent again every 30 min, it flooded the
    // run history and the network (live: 19 h of 300,000 → 1,048,576 on one
    // channel, review 2026-10-25) — recorded once, then left alone like a
    // refusal.
    const last = lastWrites.get(c.id);
    if (last && currentMaxSat !== last.toSat) {
      lastWrites.delete(c.id);
      if (change && toSat === last.toSat && currentMaxSat === last.fromSat) {
        backoff.set(c.id, now);
        out.push({
          id: c.id,
          alias: await getAlias(readLnd, c.partner_public_key),
          fromSat: currentMaxSat,
          toSat,
          ok: false,
          error: `LND took the update, but the channel still advertises ${currentMaxSat ?? "no"} max_htlc — not retried for ${MAX_HTLC_BACKOFF_MS / 3_600_000} h`,
        });
        continue;
      }
    } else if (last) lastWrites.delete(c.id);
    if (!change) continue;
    // Changed within the interval: it waits — unless the channel can forward
    // a quarter or less of what it advertises, or four times as much or more.
    // (A size the channel doesn't say — none in its policy — is no measure.)
    const urgent = !!currentMaxSat && (toSat * URGENT_CHANGE <= currentMaxSat || toSat >= currentMaxSat * URGENT_CHANGE);
    if (lastChanged.has(c.id) && !urgent) continue;
    if (opts.shouldStop?.()) break;

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
        ...inboundFeeEcho(current),
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
      lastWrites.set(c.id, { fromSat: currentMaxSat, toSat });
      lastChanged.set(c.id, now);
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
        error: errorText(err),
      });
    }
  }
  return out;
}
