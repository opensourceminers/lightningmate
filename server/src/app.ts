import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type Router } from "express";
import { apiRequestGuard, effectiveAllowedHosts, hostAllowlist } from "./exposure.js";
import type { RequestGate } from "./shutdown.js";

/**
 * The HTTP app: Host-header guard, the shutdown gate, JSON body parsing, the
 * API under /api and (in production) the built web UI from the same origin.
 */
export function createHttpApp(opts: {
  apiRouter: Router;
  /** LM_ALLOWED_HOSTS. */
  allowedHosts: string[];
  /** Whether the API requires a login (APP_PASSWORD set). */
  authRequired: boolean;
  /** The address the server listens on (LM_BIND): allowed as a Host
   *  without a login, beside the loopback names. */
  bindHost?: string;
  webDir?: string;
  /** Refuses new state-changing API requests once shutdown has begun. */
  requestGate: RequestGate;
}): Express {
  const app = express();
  app.disable("x-powered-by");

  // Host-header allowlist — the DNS-rebinding defence. Explicit hosts win;
  // without a login it defaults to loopback names and the bound address
  // (see exposure.ts).
  const allowed = effectiveAllowedHosts(opts.allowedHosts, opts.authRequired, opts.bindHost);
  if (allowed.length > 0) app.use(hostAllowlist(allowed));

  // Never another site's page, and every POST as JSON (exposure.ts) — before
  // anything else of the API's: a refused request is never "under way" for
  // the shutdown to wait on, and its body is never parsed.
  app.use("/api", apiRequestGuard());

  // Shutting down: no new channel open, payment or order step may start from
  // the API, and the ones under way are waited for (see RequestGate).
  app.use("/api", opts.requestGate.middleware());

  // No CORS: the UI is served same-origin (Vite proxies /api in dev), so a
  // cross-origin site can neither read responses nor make preflighted JSON
  // POSTs — and a form, the one cross-site POST without a preflight, is not
  // JSON (apiRequestGuard). That closes the cross-site / CSRF vector on the
  // fund-moving API.
  app.use(express.json({ limit: "256kb" }));
  app.use("/api", opts.apiRouter);

  // In production (Docker/Umbrel) we serve the built React app from the same
  // origin, so the whole tool is a single container behind Umbrel's app_proxy.
  if (opts.webDir && existsSync(opts.webDir)) {
    const webDir = opts.webDir;
    app.use(express.static(webDir));
    // SPA fallback — anything not under /api returns index.html.
    app.get("*", (_req, res) => res.sendFile(join(webDir, "index.html")));
    console.log(`   Serving web UI from ${webDir}`);
  }
  return app;
}
