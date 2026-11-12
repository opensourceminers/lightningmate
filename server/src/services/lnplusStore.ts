import { JsonStore } from "../store.js";
import { getNode, LnPlusNotFound, lnplusUrl, type LnPlusNode } from "./lnplus.js";

/**
 * Persistent cache for LN+ node profiles.
 *
 * LN+ publishes a documented budget of 10 calls/minute, 30/hour and 100/24h.
 * Reputation also barely moves — a rank is earned over months. So we cache hard
 * and spend the budget deliberately:
 *
 *   - a known profile is trusted for HIT_TTL
 *   - "this node is not on LN+" is a real answer too, cached for MISS_TTL
 *     (most of the graph is not on LN+, so without this we would burn the whole
 *     budget re-asking about the same strangers)
 *   - every enrichment pass takes a hard budget of fetches and simply returns
 *     what it has for the rest
 *
 * Nothing here may ever break a caller: LN+ being down, slow or rate-limiting
 * degrades peer suggestions back to the pure-graph scoring we had before.
 */

interface Entry {
  at: number;
  /** null = LN+ confirmed it has no profile for this pubkey. */
  node: LnPlusNode | null;
}

interface CacheState {
  nodes: Record<string, Entry>;
  /** Timestamps of calls we made, for the rolling 24h budget. Persisted, so a
   *  restart cannot be used to reset the counter. */
  calls?: number[];
}

const HIT_TTL_MS = 7 * 86_400_000;
const MISS_TTL_MS = 14 * 86_400_000;
/** Most fetches a single enrichment pass may spend. */
const DEFAULT_BUDGET = 12;
/**
 * Hard ceiling on calls in any rolling 24h, well under the 100 LN+ documents.
 * This is NOT optional bookkeeping: the autopilot alone runs every 30 minutes,
 * so 48 runs × a 12-fetch pass would be 576 calls/day. The per-pass budget does
 * not bound the day; this does. The headroom left over is for the user-facing
 * Pool/Swaps/status views, which must keep working even after a busy night.
 */
const DAILY_CAP = 70;
/** Parallel fetches — small on purpose, we are a guest on their API. */
const CONCURRENCY = 3;
/** After a rate-limit or outage, stop asking for a while. */
const BACKOFF_MS = 15 * 60_000;
/** Drop entries nobody asked about in this long, so the file cannot grow forever. */
const PRUNE_AFTER_MS = 30 * 86_400_000;

export class LnPlusStore {
  private readonly store: JsonStore<CacheState>;
  private state: CacheState;
  private pausedUntil = 0;
  /** One fetch per key at a time: the node panel's two reads of one node
   *  shared nothing and spent two of the day's calls (review 2026-11-10,
   *  CHAN-11). "failed": an outage or rate limit (nothing remembered). */
  private readonly inflight = new Map<string, Promise<LnPlusNode | null | "failed">>();
  private lastError: string | null = null;

  constructor(
    dataDir: string,
    /** The operator's LN+ switch (Settings → Privacy): off, nothing is asked
     *  of LN+ — what is cached is still used. */
    private readonly enabled: () => boolean = () => true,
  ) {
    this.store = new JsonStore<CacheState>(dataDir, "lnplus-nodes.json");
    this.state = this.store.read({ nodes: {}, calls: [] });
    if (!this.state.nodes) this.state.nodes = {};
    // A link kept from before it was checked (SEC-10) is checked now.
    for (const e of Object.values(this.state.nodes)) {
      if (e && typeof e.node === "object" && e.node) e.node.profileUrl = lnplusUrl(e.node.profileUrl, e.node.pubkey);
    }
    if (!Array.isArray(this.state.calls)) this.state.calls = [];
  }

  /** Calls made in the last rolling 24h, pruning as it counts. */
  private callsToday(): number {
    const cutoff = Date.now() - 86_400_000;
    this.state.calls = (this.state.calls ?? []).filter((t) => t >= cutoff);
    return this.state.calls.length;
  }

  /** How many calls we may still make in this rolling 24h window. */
  remainingToday(): number {
    return Math.max(0, DAILY_CAP - this.callsToday());
  }

  private noteCall(): void {
    (this.state.calls ??= []).push(Date.now());
  }

  private fresh(e: Entry | undefined): boolean {
    if (!e) return false;
    const ttl = e.node ? HIT_TTL_MS : MISS_TTL_MS;
    return Date.now() - e.at < ttl;
  }

  /** Whether LN+ may be asked at all (the operator's switch). */
  isEnabled(): boolean {
    return this.enabled();
  }

  /** Cached profile without touching the network. undefined = we don't know. */
  peek(pubkey: string): LnPlusNode | null | undefined {
    const e = this.state.nodes[pubkey];
    return this.fresh(e) ? e.node : undefined;
  }

  /** True while we are backing off after an LN+ error or rate limit. */
  isPaused(): boolean {
    return Date.now() < this.pausedUntil;
  }

  getLastError(): string | null {
    return this.isPaused() ? this.lastError : null;
  }

  private remember(pubkey: string, node: LnPlusNode | null): void {
    this.state.nodes[pubkey] = { at: Date.now(), node };
  }

  private prune(): void {
    const cutoff = Date.now() - PRUNE_AFTER_MS;
    for (const [pk, e] of Object.entries(this.state.nodes)) {
      if (e.at < cutoff) delete this.state.nodes[pk];
    }
  }

  /**
   * Look up many pubkeys at once. Returns every profile we know; fetches at most
   * `budget` of the unknown ones. Never throws.
   */
  async enrich(pubkeys: string[], budget = DEFAULT_BUDGET): Promise<Map<string, LnPlusNode>> {
    const out = new Map<string, LnPlusNode>();
    const missing: string[] = [];
    const waiting: Promise<void>[] = [];

    for (const pk of pubkeys) {
      const e = this.state.nodes[pk];
      if (this.fresh(e)) {
        if (e.node) out.set(pk, e.node);
      } else if (this.inflight.has(pk)) {
        // Asked already by another pass: its answer, not a second call.
        waiting.push(
          (this.inflight.get(pk) as Promise<LnPlusNode | null | "failed">).then((n) => {
            if (n && n !== "failed") out.set(pk, n);
          }),
        );
      } else {
        missing.push(pk);
      }
    }
    if (waiting.length) await Promise.all(waiting);

    // The rolling day budget bounds everything: a per-pass budget alone would
    // let 48 autopilot runs spend 576 calls against a 100/day allowance.
    const allowed = Math.min(budget, this.remainingToday());
    // Switched off: what is cached, nothing asked.
    if (!missing.length || this.isPaused() || allowed <= 0 || !this.enabled()) return out;

    const queue = missing.slice(0, allowed);
    let dirty = false;
    let index = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.isPaused()) return;
        const i = index++;
        if (i >= queue.length) return;
        const pk = queue[i];
        if (this.remainingToday() <= 0) return;
        const already = this.inflight.get(pk);
        const asked = already ?? this.fetchOne(pk);
        if (!already) {
          this.inflight.set(pk, asked);
          void asked.finally(() => this.inflight.delete(pk));
        }
        const node = await asked;
        if (node === "failed") return; // rate limit or outage: the pass stops, keeping what it has
        if (node) out.set(pk, node);
        dirty = true;
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

    // Always persist: even a pass that learned nothing has spent calls, and that
    // spend must survive a restart or the cap is trivially bypassed.
    if (dirty) this.prune();
    this.store.write(this.state);
    return out;
  }

  /** One call to LN+ for `pk`, remembered: its profile, null for a
   *  definitive "no profile", "failed" on a rate limit or outage (the store
   *  then backs off). */
  private async fetchOne(pk: string): Promise<LnPlusNode | null | "failed"> {
    this.noteCall();
    try {
      const node = await getNode(pk);
      this.remember(pk, node);
      return node;
    } catch (err) {
      if (err instanceof LnPlusNotFound) {
        // A definitive "no profile" — cache it so we stop asking.
        this.remember(pk, null);
        return null;
      }
      this.lastError = err instanceof Error ? err.message : String(err);
      this.pausedUntil = Date.now() + BACKOFF_MS;
      return "failed";
    }
  }

  /**
   * One profile and what was asked for it: "ok" — LN+ answered (now or
   * cached), the profile or none; "off" — switched off; "unavailable" — LN+
   * failed or is backed off; "not_asked" — not cached and the day's calls
   * are spent, so whether it has a profile is not known (the panel said
   * "ok" then, read as "no LN+ profile"; review 2026-11-10, CHAN-11).
   */
  async lookupWithState(pubkey: string): Promise<{ profile: LnPlusNode | null; state: "ok" | "off" | "unavailable" | "not_asked" }> {
    const cached = this.peek(pubkey);
    if (!this.enabled()) return { profile: cached ?? null, state: "off" };
    if (cached !== undefined) return { profile: cached, state: "ok" };
    if (this.isPaused()) return { profile: null, state: "unavailable" };
    const found = await this.enrich([pubkey], 1);
    const now = this.peek(pubkey);
    if (now !== undefined) return { profile: now, state: "ok" };
    return { profile: found.get(pubkey) ?? null, state: this.isPaused() ? "unavailable" : "not_asked" };
  }

  /** One profile, cached. Returns null when the node is not on LN+. */
  async lookup(pubkey: string): Promise<LnPlusNode | null> {
    const cached = this.peek(pubkey);
    if (cached !== undefined) return cached;
    const found = await this.enrich([pubkey], 1);
    return found.get(pubkey) ?? this.state.nodes[pubkey]?.node ?? null;
  }

  stats(): {
    cached: number;
    withProfile: number;
    paused: boolean;
    lastError: string | null;
    callsToday: number;
    remainingToday: number;
  } {
    const entries = Object.values(this.state.nodes);
    return {
      cached: entries.length,
      withProfile: entries.filter((e) => e.node).length,
      paused: this.isPaused(),
      lastError: this.getLastError(),
      callsToday: this.callsToday(),
      remainingToday: this.remainingToday(),
    };
  }
}
