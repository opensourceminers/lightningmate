import { HTTP_TIMEOUTS, httpRequest, mempoolBase } from "./http.js";

/**
 * What the public record says about a node that LND's own graph doesn't:
 * where it runs and since when (mempool.space). Asked for one node at a time,
 * only when the operator opens that node's details — through Tor like every
 * other lookup (http.ts) — so no list of this node's peers ever goes out.
 */

export interface PublicNodeRecord {
  /** First seen in the network (null: not known). */
  firstSeenAt: string | null;
  /** English name, e.g. "United States" (null: runs behind Tor, or unknown). */
  country: string | null;
  city: string | null;
  /** The network it runs on, e.g. "Amazon.com". */
  hostedBy: string | null;
  /** Channels it has closed over its life. */
  closedChannels: number | null;
}

/** A node's record barely moves. */
const HIT_TTL_MS = 6 * 3_600_000;
const MISS_TTL_MS = 3_600_000;
const CACHE_MAX = 500;

/** undefined in the cache: not asked yet. null: mempool.space doesn't know it. */
const cache = new Map<string, { at: number; record: PublicNodeRecord | null }>();

/** Tests: forget what was asked. */
export function clearNodeLookupCache(): void {
  cache.clear();
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);

/** mempool.space's answer, taking only what it should hold. */
export function parsePublicNode(raw: unknown): PublicNodeRecord {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const firstSeen = count(o.first_seen);
  const place = (v: unknown): string | null => {
    if (v && typeof v === "object") return text((v as Record<string, unknown>).en);
    return text(v);
  };
  return {
    firstSeenAt: firstSeen ? new Date(firstSeen * 1000).toISOString() : null,
    country: place(o.country),
    city: place(o.city),
    hostedBy: text(o.as_organization),
    closedChannels: count(o.closed_channel_count),
  };
}

/**
 * One node's public record: null when mempool.space doesn't know the node.
 * Throws when the lookup itself failed (never cached — the next open asks
 * again).
 */
export async function lookupPublicNode(pubkey: string, nowMs = Date.now()): Promise<PublicNodeRecord | null> {
  const hit = cache.get(pubkey);
  if (hit && nowMs - hit.at < (hit.record ? HIT_TTL_MS : MISS_TTL_MS)) return hit.record;
  const res = await httpRequest(`${mempoolBase()}/api/v1/lightning/nodes/${pubkey}`, {}, HTTP_TIMEOUTS.nodeLookupMs);
  let record: PublicNodeRecord | null;
  if (res.ok) {
    record = parsePublicNode(await res.json());
  } else {
    // A node it doesn't know: 404, or its 500 "Failed to get node".
    const body = await res.text().catch(() => "");
    if (res.status !== 404 && !/failed to get node/i.test(body)) throw new Error(`mempool.space answered ${res.status}`);
    record = null;
  }
  cache.delete(pubkey);
  cache.set(pubkey, { at: nowMs, record });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return record;
}
