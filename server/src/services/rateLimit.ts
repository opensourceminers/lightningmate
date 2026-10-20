/**
 * Sliding-window counters, one per client key (e.g. the remote address).
 *
 * The API's limits used to be single global buckets, so any other container
 * on the Docker network could burn them and lock the owner out of the login
 * and of every write. Keyed buckets confine a noisy client to its own limit.
 * The key map is bounded so a client can't grow it without limit by varying
 * its key.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly opts: {
      windowMs: number;
      max: number;
      /** Upper bound on tracked keys (default 1000). */
      maxKeys?: number;
    },
  ) {}

  private live(key: string, now: number): number[] {
    const cutoff = now - this.opts.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Hits by `key` inside the current window. */
  count(key: string, now = Date.now()): number {
    return this.live(key, now).length;
  }

  /** True when `key` has used up its window. */
  limited(key: string, now = Date.now()): boolean {
    return this.count(key, now) >= this.opts.max;
  }

  /** Record one hit for `key`. */
  hit(key: string, now = Date.now()): void {
    const list = this.live(key, now);
    list.push(now);
    this.hits.set(key, list);
    this.prune(now);
  }

  /** Count-and-record in one step: false (and nothing recorded) when over. */
  tryHit(key: string, now = Date.now()): boolean {
    if (this.limited(key, now)) return false;
    this.hit(key, now);
    return true;
  }

  /** Forget `key` (e.g. after a successful login). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(now: number): void {
    const maxKeys = this.opts.maxKeys ?? 1000;
    if (this.hits.size <= maxKeys) return;
    for (const key of [...this.hits.keys()]) this.live(key, now);
    // Still too many live keys: drop the oldest-inserted ones.
    for (const key of this.hits.keys()) {
      if (this.hits.size <= maxKeys) break;
      this.hits.delete(key);
    }
  }
}
