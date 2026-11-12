import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response, type Router } from "express";
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

  // On the page and the API alike (review 2026-11-10, SEC-4): the session
  // token lives in the page's localStorage, so a script injected anywhere
  // would be a takeover with the admin macaroon behind it. The policy is
  // what the built app needs: its own scripts, styles and fonts, its own API,
  // inline style attributes (React sets some), data: images (the QR code
  // library), and no frame around it.
  app.use((_req, res, next) => {
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

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
  // fund-moving API. The JSON body is parsed by the API router itself,
  // behind its login gate (SEC-6).
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

  // The last word on any error no route answered: one short log line, and
  // JSON for the API — never Express's page with a stack trace (SEC-6).
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    // A client's fault the middleware named (serve-static's 400 for a
    // malformed path, say) keeps its status and writes no log line.
    const given = err && typeof err === "object" ? Number((err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode) : NaN;
    const status = Number.isInteger(given) && given >= 400 && given < 500 ? given : 500;
    if (status === 500) console.error(`[http] ${req.method} ${req.path.slice(0, 80)}: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
    const message = status === 500 ? "The request could not be handled." : "The request is not valid.";
    if (req.path.startsWith("/api")) res.status(status).json({ error: status === 500 ? "server_error" : "bad_request", message });
    else res.status(status).type("text/plain").send(message);
  });
  return app;
}

/** The page's and the API's Content-Security-Policy (SEC-4). */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
