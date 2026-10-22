import { useEffect, useRef, useState } from "react";

export interface PolledData<T> {
  data: T | null;
  /** The last load's error (the data, if any, is from before it). */
  error: string | null;
  loading: boolean;
  /** When `data` was loaded (ms) — the "as of" a stale view shows. */
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * When the next poll may start (review a6-ux:polling-and-stale-data):
 * never while the tab is hidden — a background tab polled every view's reads
 * (three of them scan 30 days of forwards) all day — and never while the
 * previous request is still under way (a slow node piled them up).
 */
export function shouldPoll(hidden: boolean, inFlight: boolean): boolean {
  return !hidden && !inFlight;
}

/** Whether the page is visible, and the event that says it changed —
 *  `document` in the browser, a fake in a test. */
export interface VisibilitySource {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** The interval timer (the global one, or a fake in a test). */
export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const browserTimers: IntervalTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
};

/** The document is hidden (a background tab, a minimised window). */
export const pageHidden = (doc: Pick<VisibilitySource, "visibilityState"> | undefined = typeof document !== "undefined" ? document : undefined): boolean =>
  doc?.visibilityState === "hidden";

/**
 * Call `tick` every `intervalMs` while the page is visible — a tick that
 * falls while it is hidden is skipped — and once at once when the page
 * becomes visible again after missing one (a returning viewer sees current
 * data, not data from before they left). Returns the function that stops it.
 */
export function visibleTicker(tick: () => void, intervalMs: number, doc: VisibilitySource, timers: IntervalTimers = browserTimers): () => void {
  let missed = false;
  const id = timers.setInterval(() => {
    if (pageHidden(doc)) missed = true;
    else tick();
  }, intervalMs);
  const onVisible = () => {
    if (pageHidden(doc) || !missed) return;
    missed = false;
    tick();
  };
  doc.addEventListener("visibilitychange", onVisible);
  return () => {
    timers.clearInterval(id);
    doc.removeEventListener("visibilitychange", onVisible);
  };
}

/** `visibleTicker` for a component: `tick` every `intervalMs` while the page
 *  is visible, and once on coming back after a missed one. */
export function useVisibleInterval(tick: () => void, intervalMs: number): void {
  const tickRef = useRef(tick);
  tickRef.current = tick;
  useEffect(() => visibleTicker(() => tickRef.current(), intervalMs, document), [intervalMs]);
}

/**
 * One poll at a time (review a6-ux:polling-and-stale-data): `load()` calls
 * `fn` only while the page is visible and no earlier call is still under
 * way; `load(true)` — the first load, a "Try again", a refresh after a
 * change (a dismissed alert) — skips the visibility check, never the
 * one-at-a-time rule. The outcome goes to `on`: the value, or the error (the
 * caller keeps the data it had), then `settled`.
 *
 * A forced load that comes while a call is under way is not dropped: that
 * call's answer may be from before what the caller just changed (review of
 * P7: an alert dismissed during a poll stayed up for another 30 s, the poll
 * in flight answering with it). It runs once more right after — one such
 * re-run however many forced loads came meanwhile — and resolves when that
 * re-run has. Resolves to whether `fn` was called for it.
 */
export function pollGuard<T>(
  fn: () => Promise<T>,
  hidden: () => boolean,
  on: { loaded(value: T): void; failed(err: unknown): void; settled(): void },
): (force?: boolean) => Promise<boolean> {
  let inFlight = false;
  /** The re-run owed to forced loads that came during a call. */
  let rerun: { done: Promise<boolean>; resolve: (called: boolean) => void } | null = null;
  const load = async (force = false): Promise<boolean> => {
    if (inFlight) {
      if (!force) return false;
      if (!rerun) {
        let resolve!: (called: boolean) => void;
        const done = new Promise<boolean>((r) => (resolve = r));
        rerun = { done, resolve };
      }
      return rerun.done;
    }
    if (!force && !shouldPoll(hidden(), inFlight)) return false;
    inFlight = true;
    try {
      on.loaded(await fn());
    } catch (err) {
      on.failed(err);
    } finally {
      inFlight = false;
      on.settled();
    }
    const owed = rerun;
    rerun = null;
    // (Started at once: `load` marks itself in flight before it awaits, so
    // no other call slips in between.)
    if (owed) void load(true).then(owed.resolve);
    return true;
  };
  return load;
}

/** Fetch `fn` on mount and every `intervalMs` while the page is visible,
 *  exposing loading/error state and when the data is from. A failed load
 *  keeps the data it had (shown as of when it was loaded), never blanks it. */
export function usePolledData<T>(fn: () => Promise<T>, intervalMs = 15_000): PolledData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Keep the latest fn without re-subscribing the interval each render.
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);
  // One guard for the component's life: its in-flight flag must outlive renders.
  const load = useRef<((force?: boolean) => Promise<boolean>) | null>(null);
  load.current ??= pollGuard(() => fnRef.current(), () => pageHidden(), {
    loaded: (result) => {
      if (!alive.current) return;
      setData(result);
      setError(null);
      setUpdatedAt(Date.now());
    },
    failed: (err) => {
      if (alive.current) setError(err instanceof Error ? err.message : String(err));
    },
    settled: () => {
      if (alive.current) setLoading(false);
    },
  });

  useEffect(() => {
    alive.current = true;
    void load.current?.(true);
    return () => {
      alive.current = false;
    };
  }, []);
  useVisibleInterval(() => void load.current?.(), intervalMs);

  return { data, error, loading, updatedAt, refresh: () => void load.current?.(true) };
}
