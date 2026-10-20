import type { RequestHandler } from "express";

/**
 * Network exposure of the app's own HTTP API (nothing here touches LND's
 * networking — the node stays Tor-only).
 *
 * The API moves funds when write mode is on, and it only asks for a login when
 * APP_PASSWORD is set (Umbrel always sets it). Standalone without a password is
 * safe ONLY while bound to loopback, so that combination is the one we allow;
 * anything else refuses to start. Before, LM_BIND=0.0.0.0 — which the
 * documented `docker run -p 3001:3001` needs — served an unauthenticated,
 * fund-moving API on every interface Docker published.
 */

/** Loopback addresses: 127.0.0.0/8, ::1 (also IPv4-mapped) and "localhost". */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Throws (with guidance) when the API would be reachable beyond this machine
 *  without a login. */
export function assertSafeExposure(bindHost: string, authRequired: boolean): void {
  if (authRequired || isLoopbackHost(bindHost)) return;
  throw new Error(
    `Refusing to serve the API on ${bindHost} without a login. Set APP_PASSWORD to require one ` +
      `(Umbrel does this for you), or bind to 127.0.0.1 (LM_BIND) so only this machine can reach it.`,
  );
}

/** Loopback names a browser on this machine may use in the Host header. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * The Host-header allowlist to enforce. An explicit LM_ALLOWED_HOSTS wins.
 * Without a login, default to loopback names: a page on another site can
 * rebind its own DNS name to 127.0.0.1 and would otherwise be treated as
 * same-origin by the browser (DNS rebinding). With a login the token already
 * stops that, and Umbrel's proxy hostnames vary, so no default list is needed.
 */
export function effectiveAllowedHosts(configured: string[], authRequired: boolean): string[] {
  if (configured.length > 0) return configured;
  return authRequired ? [] : LOOPBACK_HOSTS;
}

/** Hostname part of a Host header, IPv6-literal aware ("[::1]:3001" → "::1"). */
export function hostnameOf(hostHeader: string | undefined): string {
  const h = (hostHeader ?? "").trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  return h.split(":")[0];
}

/** An allowlist entry as a bare hostname: "umbrel.local", "::1", "[::1]:3001". */
function normalizeAllowedHost(entry: string): string {
  const e = entry.trim().toLowerCase();
  if (e.startsWith("[")) return hostnameOf(e);
  if ((e.match(/:/g) ?? []).length > 1) return e; // bare IPv6 literal
  return e.split(":")[0];
}

/** Express middleware: 403 for a Host header outside `allowed` (empty = off). */
export function hostAllowlist(allowed: string[]): RequestHandler {
  const set = new Set(allowed.map(normalizeAllowedHost));
  return (req, res, next) => {
    if (set.size === 0 || set.has(hostnameOf(req.headers.host))) {
      next();
      return;
    }
    res.status(403).json({ error: "forbidden_host" });
  };
}
