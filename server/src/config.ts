import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

// npm runs workspace scripts with cwd set to the workspace (server/), but the
// .env lives at the repo root. Load it explicitly from there, then also honor a
// .env in the current working directory if one exists.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "../../");
loadDotenv({ path: resolve(repoRoot, ".env") });
loadDotenv();

function fileToBase64(path: string): string {
  return readFileSync(path).toString("base64");
}

/**
 * On Umbrel we declare a dependency on the `lightning` app, which exports
 * APP_LIGHTNING_NODE_IP / _GRPC_PORT and lets us mount its data dir read-only.
 * When those are present we auto-discover everything — no manual config needed.
 */
function umbrelDefaults(): {
  socket: string;
  certPath: string;
  macaroonPath: string;
  adminMacaroonPath: string;
} | null {
  const ip = process.env.APP_LIGHTNING_NODE_IP?.trim();
  const grpcPort = process.env.APP_LIGHTNING_NODE_GRPC_PORT?.trim();
  if (!ip || !grpcPort) return null;

  const lndDir = process.env.LND_DIR?.trim() || "/lnd";
  const chainDir = `${lndDir}/data/chain/bitcoin/mainnet`;
  return {
    socket: `${ip}:${grpcPort}`,
    certPath: `${lndDir}/tls.cert`,
    macaroonPath: `${chainDir}/readonly.macaroon`,
    adminMacaroonPath: `${chainDir}/admin.macaroon`,
  };
}

/** Resolve a credential as base64. Throws if none of the sources are present. */
function resolveCredential(
  name: string,
  base64Env: string | undefined,
  pathEnv: string | undefined,
  umbrelPath: string | undefined,
): string {
  const value = resolveOptional(base64Env, pathEnv, umbrelPath);
  if (value) return value;
  throw new Error(
    `Missing LND credential "${name}". On Umbrel this comes from the mounted ` +
      `lightning data dir; standalone, set ${name} (base64) or ${name}_PATH.`,
  );
}

/** Like resolveCredential but returns undefined instead of throwing. */
function resolveOptional(
  base64Env: string | undefined,
  pathEnv: string | undefined,
  umbrelPath: string | undefined,
): string | undefined {
  if (base64Env && base64Env.trim().length > 0) return base64Env.trim();
  const path = pathEnv?.trim() || umbrelPath;
  if (path && existsSync(path)) return fileToBase64(path);
  return undefined;
}

export interface Config {
  port: number;
  flowWindowDays: number;
  webDir: string | undefined;
  dataDir: string;
  /** True only when a write-capable macaroon is available AND opt-in is set. */
  writeEnabled: boolean;
  lnd: {
    socket: string;
    cert: string;
    macaroon: string;
    /** offchain:write-capable macaroon, present only when writeEnabled. */
    writeMacaroon?: string;
  };
}

export function loadConfig(): Config {
  const umbrel = umbrelDefaults();

  const socket = process.env.LND_SOCKET?.trim() || umbrel?.socket;
  if (!socket) {
    throw new Error(
      "Missing LND_SOCKET (e.g. umbrel.local:10009). On Umbrel it is derived " +
        "automatically from the lightning app dependency.",
    );
  }

  const cert = resolveCredential(
    "LND_CERT",
    process.env.LND_CERT,
    process.env.LND_CERT_PATH,
    umbrel?.certPath,
  );
  const macaroon = resolveCredential(
    "LND_MACAROON",
    process.env.LND_MACAROON,
    process.env.LND_MACAROON_PATH,
    umbrel?.macaroonPath,
  );

  // Writes are off unless explicitly enabled AND a write macaroon is resolvable.
  const wantsWrite = process.env.LM_ENABLE_WRITE?.trim() === "true";
  const writeMacaroon = wantsWrite
    ? resolveOptional(
        process.env.LND_WRITE_MACAROON,
        process.env.LND_WRITE_MACAROON_PATH,
        umbrel?.adminMacaroonPath,
      )
    : undefined;

  if (wantsWrite && !writeMacaroon) {
    console.warn(
      "⚠ LM_ENABLE_WRITE=true but no write macaroon found — staying read-only. " +
        "Set LND_WRITE_MACAROON (base64) or LND_WRITE_MACAROON_PATH (admin macaroon).",
    );
  }

  return {
    port: Number(process.env.PORT ?? 3001),
    flowWindowDays: Number(process.env.FLOW_WINDOW_DAYS ?? 30),
    webDir: process.env.WEB_DIR?.trim() || undefined,
    dataDir: process.env.DATA_DIR?.trim() || resolve(repoRoot, ".data"),
    writeEnabled: Boolean(writeMacaroon),
    lnd: { socket, cert, macaroon, writeMacaroon },
  };
}
