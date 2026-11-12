import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * App auth. Umbrel's app_proxy only authenticates the browser session; it does
 * not pass a credential the app can verify, and other app containers share the
 * Docker network — so they could call our API directly to read node data or move
 * funds. The whole API therefore requires a session token, obtained by proving
 * the per-install app password Umbrel derives and shows the user (deterministic-
 * Password), exposed to the container as $APP_PASSWORD. Tokens are signed with a
 * secret of the data directory mixed with $APP_SEED (loadTokenSecret).
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

/**
 * Tokens are signed with a random 32-byte secret made at the first start and
 * kept in the data directory (`token-secret`, mode 600), mixed with
 * $APP_SEED when there is one (review 2026-11-10, SEC-9). Before, the key was
 * $APP_SEED or else the password itself — a captured token let a password be
 * guessed offline — and no token could be withdrawn before its 12 hours were
 * up. Now "Sign out everywhere" (POST /auth/revoke) makes a new secret, and
 * so does deleting the file before a restart: every token is void.
 *
 * Without `loadTokenSecret` (tests) the secret lives in memory only.
 */
const TOKEN_SECRET_FILE = "token-secret";
let secret: Buffer = randomBytes(32);
let secretDir: string | null = null;

/** The data directory's secret, made when missing. A file that can't be
 *  read or written leaves an in-memory secret (tokens then end with the
 *  process) — said in the log. */
export function loadTokenSecret(dataDir: string): void {
  secretDir = dataDir;
  const file = join(dataDir, TOKEN_SECRET_FILE);
  try {
    mkdirSync(dataDir, { recursive: true });
    const kept = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (/^[0-9a-f]{64}$/.test(kept)) {
      secret = Buffer.from(kept, "hex");
      try {
        chmodSync(file, 0o600);
      } catch (err) {
        console.warn(`[auth] ${file}: could not be made readable by this app only (${err instanceof Error ? err.message : String(err)})`);
      }
      return;
    }
    writeSecret(randomBytes(32));
  } catch (err) {
    console.warn(`[auth] the token secret could not be kept in ${dataDir} (${err instanceof Error ? err.message : String(err)}): sessions end when the app restarts`);
  }
}

function writeSecret(next: Buffer): void {
  secret = next;
  if (!secretDir) return;
  const file = join(secretDir, TOKEN_SECRET_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, next.toString("hex") + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** A new secret: every token issued so far is void ("Sign out everywhere"). */
export function revokeAllTokens(): void {
  try {
    writeSecret(randomBytes(32));
  } catch (err) {
    // The new secret holds in memory either way; on disk the old one would
    // come back with a restart.
    console.warn(`[auth] the new token secret could not be saved (${err instanceof Error ? err.message : String(err)}): it holds until the app restarts`);
  }
}

const signingKey = (): Buffer =>
  createHash("sha256")
    .update(secret)
    .update(process.env.APP_SEED?.trim() ?? "")
    .digest();

/** Auth is only enforced when Umbrel provides an app password. */
export const authRequired = (): boolean => password().length > 0;

const TTL_MS = 12 * 60 * 60 * 1000; // 12h sessions
const sign = (payload: string): string =>
  createHmac("sha256", signingKey()).update(payload).digest("base64url");

export const verifyPassword = (pw: unknown): boolean =>
  typeof pw === "string" && pw.length > 0 && eq(pw, password());

/** Whether the password is random by construction, so the unlock may let
 *  it through while it is limiting (SEC-5): Umbrel's derived app password —
 *  an HMAC-SHA256 in hex, 64 characters (umbreld's
 *  deriveDeterministicPassword) — 256 bits nobody guesses at any rate. A
 *  password a person chose is not, however long (independent review of P5,
 *  R1-2: "lightningmate-password-2026" would have counted). */
export const passwordUnguessable = (): boolean => /^[0-9a-f]{64}$/i.test(password());

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
