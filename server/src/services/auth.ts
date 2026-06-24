import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * App auth. Umbrel's app_proxy only authenticates the browser session; it does
 * not pass a credential the app can verify, and other app containers share the
 * Docker network — so they could call our API directly to read node data or move
 * funds. The whole API therefore requires a session token, obtained by proving
 * the per-install app password Umbrel derives and shows the user (deterministic-
 * Password), exposed to the container as $APP_PASSWORD. $APP_SEED signs tokens.
 *
 * Standalone (no $APP_PASSWORD) binds to 127.0.0.1, so there is no cross-container
 * threat and auth is disabled.
 */

const eq = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// Read lazily so dotenv (loaded in config.ts) has populated the env first.
const password = (): string => process.env.APP_PASSWORD?.trim() ?? "";
const signingKey = (): string =>
  process.env.APP_SEED?.trim() || password() || "lightningmate-standalone";

/** Auth is only enforced when Umbrel provides an app password. */
export const authRequired = (): boolean => password().length > 0;

const TTL_MS = 12 * 60 * 60 * 1000; // 12h sessions
const sign = (payload: string): string =>
  createHmac("sha256", signingKey()).update(payload).digest("base64url");

export const verifyPassword = (pw: unknown): boolean =>
  typeof pw === "string" && pw.length > 0 && eq(pw, password());

export const issueToken = (): string => {
  const exp = String(Date.now() + TTL_MS);
  return `${exp}.${sign(exp)}`;
};

export const verifyToken = (token: unknown): boolean => {
  if (!authRequired()) return true;
  if (typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !eq(sig, sign(exp))) return false;
  const n = Number(exp);
  return Number.isFinite(n) && Date.now() < n;
};

/** Extract the Bearer token from a request's Authorization header. */
export const bearer = (req: { headers: Record<string, unknown> }): string => {
  const h = req.headers.authorization;
  return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : "";
};
