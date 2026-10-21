import type { RequestHandler } from "express";

/**
 * Graceful shutdown on SIGTERM / SIGINT.
 *
 * In the container, node runs as PID 1 with no init. PID 1 gets no default
 * signal handlers, so without these a `docker stop` (every Umbrel update or
 * restart) was ignored until the 1-minute grace period ran out and the process
 * was SIGKILLed — possibly between broadcasting a channel's funding transaction
 * and recording it. Now we stop scheduling new work, let in-flight work reach a
 * recorded state, flush state to disk and exit cleanly well inside the grace.
 */

/** Total shutdown budget: well inside docker's stop_grace_period (1 min in
 *  our composes), after which the process is SIGKILLed. */
export const SHUTDOWN_GRACE_MS = 45_000;
/** Kept back from the wait for the flush and the server close. */
export const SHUTDOWN_FLUSH_RESERVE_MS = 8_000;
/**
 * How long the shutdown waits for work under way (an autopilot step, an
 * order-lane step, an LSP open, a request). It must outlast the longest
 * single Amboss call — HTTP_TIMEOUTS.ambossMutationMs (http.ts) plus the
 * journal save around it — so a Magma accept, add_transaction or reject that
 * is in flight when the signal comes either completes or times out, and is
 * recorded either way, before the process exits. (It used to be 37 s against
 * a 45 s mutation deadline: a slow add_transaction could be cut off with its
 * outcome unknown.) Every such step is also written to the order journal
 * before it is sent, so even a SIGKILL leaves a record to reconcile from.
 */
export const SHUTDOWN_WAIT_MS = SHUTDOWN_GRACE_MS - SHUTDOWN_FLUSH_RESERVE_MS;

export interface ShutdownStep {
  name: string;
  run: () => void | Promise<unknown>;
  /** Upper bound for this step (it also never exceeds what is left of the grace). */
  timeoutMs?: number;
  /** Run even when the grace budget is used up (quick, essential steps such as
   *  flushing state to disk), bounded by ALWAYS_STEP_MS. */
  always?: boolean;
}

export interface ShutdownOptions {
  steps: ShutdownStep[];
  /** Total time budget for all steps (stay below docker's stop_grace_period). */
  graceMs: number;
  exit: (code: number) => void;
  log?: (message: string) => void;
}

const ALWAYS_STEP_MS = 2_000;

/**
 * Returns the signal handler. Steps run in order, each bounded by its own
 * timeout and by what is left of the grace budget; a failing or slow step is
 * logged and the rest still run. A second signal while shutting down exits
 * immediately with code 1.
 */
export function createShutdown(opts: ShutdownOptions): (signal: string) => Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(m));
  let started = false;
  return async (signal: string) => {
    if (started) {
      log(`[shutdown] second ${signal} — exiting now`);
      opts.exit(1);
      return;
    }
    started = true;
    const deadline = Date.now() + opts.graceMs;
    // Set when a step was cut off by the grace itself. From then on the grace
    // is used up, whatever Date.now() says: a timer may fire a millisecond
    // before the wall clock agrees, and that millisecond must not let a step
    // that isn't `always` start after the time it was given has run out.
    let graceUsedUp = false;
    log(`[shutdown] ${signal} received — finishing in-flight work (up to ${Math.round(opts.graceMs / 1000)}s)`);
    for (const step of opts.steps) {
      const left = graceUsedUp ? 0 : deadline - Date.now();
      if (left <= 0 && !step.always) {
        log(`[shutdown] grace period used up — skipping "${step.name}"`);
        continue;
      }
      const bound = Math.min(step.timeoutMs ?? Number.POSITIVE_INFINITY, left > 0 ? left : ALWAYS_STEP_MS);
      let timer: NodeJS.Timeout | undefined;
      try {
        const outcome = await Promise.race([
          Promise.resolve().then(step.run).then(() => "done" as const),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), bound);
          }),
        ]);
        if (outcome === "timeout") {
          log(`[shutdown] "${step.name}" did not finish in time`);
          if (left > 0 && bound === left) graceUsedUp = true;
        }
      } catch (err) {
        log(`[shutdown] "${step.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    log("[shutdown] done");
    opts.exit(0);
  };
}

// ── the API during shutdown ───────────────────────────────────────────────────

/** Methods that only read. Everything else may move funds or change state. */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Gate for state-changing API requests. Once closed (first shutdown step),
 * every new one is answered 503 — reads keep working until the server closes —
 * and the shutdown waits for the ones already running.
 *
 * Without it the API kept taking POSTs (channel open, on-chain send, pay,
 * Magma accept/open) through the whole shutdown wait, and the final exit could
 * cut one off half-way: for a Magma open, after the funding broadcast but
 * before anything recorded it, so the autopilot would open again.
 *
 * A request counts until its HANDLER has answered — not until its connection
 * closes. The client may be gone long before that: on Umbrel the same
 * `docker compose stop` stops app_proxy (10 s grace against our minute), which
 * drops the proxied connection while a handler is still between opening a
 * channel and reporting it to Amboss. A handler that never answers is bounded
 * by waitIdle's timeout: waiting too long only delays the exit (the flush
 * still runs), stopping too early could fund a channel twice.
 */
export class RequestGate {
  private closed = false;
  private active = 0;

  close(): void {
    this.closed = true;
  }

  /** State-changing requests currently being handled. */
  get inFlight(): number {
    return this.active;
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      if (READ_METHODS.has(req.method)) return next();
      if (this.closed) {
        res
          .status(503)
          .set("Retry-After", "60")
          .json({ error: "shutting_down", message: "LightningMate is shutting down — try again once it is back up." });
        return;
      }
      this.active += 1;
      let counted = true;
      const done = () => {
        if (!counted) return;
        counted = false;
        this.active -= 1;
      };
      // The handler is done once it ends its response — res.json/res.send,
      // express's error handlers and the 404 fallback all go through end(),
      // whether or not anyone is still listening. No "close" listener: that
      // fires as soon as the client leaves, while the handler may still be
      // moving funds.
      const end = res.end;
      res.end = function (this: typeof res, ...args: unknown[]) {
        done();
        return (end as (...a: unknown[]) => unknown).apply(this, args);
      } as typeof res.end;
      res.once("finish", done); // a second path to the same idempotent done()
      next();
    };
  }

  /** Resolves true once no state-changing request is running, or false after `timeoutMs`. */
  async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.active > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }
}

/** What the app's shutdown has to stop, wait for and flush (structural, so a
 *  test can hand in fakes). */
export interface ShutdownParts {
  requests: Pick<RequestGate, "close" | "waitIdle">;
  autopilot: { shutdown(): void; waitIdle(ms: number): Promise<boolean>; flush(): void };
  lsps1: { stop(): void; waitForOpens(ms: number): Promise<boolean> };
  serviceFees: { stop(): void };
  telemetry: { stop(): void; flush(): void };
  closeServer: () => Promise<void>;
}

/**
 * The app's shutdown, in order: stop starting new work (schedulers AND new
 * state-changing requests) → let started work reach a recorded state → flush
 * → stop serving. The wait leaves time for the flush, and the flush runs even
 * if the wait used everything up.
 */
export function appShutdownSteps(p: ShutdownParts, waitBudgetMs: number): ShutdownStep[] {
  return [
    {
      name: "stop schedulers and new write requests",
      run: () => {
        p.requests.close();
        p.autopilot.shutdown();
        p.lsps1.stop();
        p.serviceFees.stop();
        p.telemetry.stop();
      },
    },
    {
      name: "wait for in-flight work (autopilot pass, Magma order step, LSP channel opens, write requests)",
      timeoutMs: waitBudgetMs,
      run: () =>
        Promise.all([
          p.autopilot.waitIdle(waitBudgetMs),
          p.lsps1.waitForOpens(waitBudgetMs),
          p.requests.waitIdle(waitBudgetMs),
        ]),
    },
    {
      name: "flush state",
      always: true,
      run: () => {
        p.autopilot.flush();
        p.telemetry.flush();
      },
    },
    { name: "close HTTP server", timeoutMs: 3_000, run: p.closeServer },
  ];
}
