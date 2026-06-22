import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

// npm runs workspace scripts with cwd set to the workspace (server/), but the
// .env lives at the repo root. Load it explicitly from there, then also honor a
// .env in the current working directory if one exists.
const moduleDir = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(moduleDir, "../../.env") });
loadDotenv();

function fileToBase64(path: string): string {
  return readFileSync(path).toString("base64");
}

/**
 * On Umbrel we declare a dependency on the `lightning` app, which exports
 * APP_LIGHTNING_NODE_IP / _GRPC_PORT and lets us mount its data dir read-only.
 * When those are present we auto-discover everything — no manual config needed.
 * Standalone/dev users instead set LND_SOCKET + LND_CERT/_PATH + LND_MACAROON/_PATH.
 */
function umbrelDefaults(): { socket: string; certPath: string; macaroonPath: string } | null {
  const ip = process.env.APP_LIGHTNING_NODE_IP?.trim();
  const grpcPort = process.env.APP_LIGHTNING_NODE_GRPC_PORT?.trim();
  if (!ip || !grpcPort) return null;

  // We mount ${APP_LIGHTNING_NODE_DATA_DIR}:/lnd:ro in docker-compose; LND_DIR
  // overrides the mount point. v1 reads the read-only macaroon on purpose.
  const lndDir = process.env.LND_DIR?.trim() || "/lnd";
  return {
    socket: `${ip}:${grpcPort}`,
    certPath: `${lndDir}/tls.cert`,
    macaroonPath: `${lndDir}/data/chain/bitcoin/mainnet/readonly.macaroon`,
  };
}

/**
 * Resolve one credential as base64. Precedence:
 *   1. explicit base64 env (LND_CERT / LND_MACAROON)
 *   2. explicit file path env (LND_CERT_PATH / LND_MACAROON_PATH)
 *   3. Umbrel auto-discovered path (mounted /lnd)
 */
function resolveCredential(
  name: string,
  base64Env: string | undefined,
  pathEnv: string | undefined,
  umbrelPath: string | undefined,
): string {
  if (base64Env && base64Env.trim().length > 0) return base64Env.trim();

  const path = pathEnv?.trim() || umbrelPath;
  if (path && existsSync(path)) return fileToBase64(path);

  throw new Error(
    `Missing LND credential "${name}". On Umbrel this comes from the mounted ` +
      `lightning data dir; standalone, set ${name} (base64) or ${name}_PATH.`,
  );
}

export interface Config {
  port: number;
  flowWindowDays: number;
  webDir: string | undefined;
  lnd: {
    socket: string;
    cert: string;
    macaroon: string;
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

  return {
    port: Number(process.env.PORT ?? 3001),
    flowWindowDays: Number(process.env.FLOW_WINDOW_DAYS ?? 30),
    // When set (production/Docker), the server also serves the built web UI.
    webDir: process.env.WEB_DIR?.trim() || undefined,
    lnd: {
      socket,
      cert: resolveCredential(
        "LND_CERT",
        process.env.LND_CERT,
        process.env.LND_CERT_PATH,
        umbrel?.certPath,
      ),
      macaroon: resolveCredential(
        "LND_MACAROON",
        process.env.LND_MACAROON,
        process.env.LND_MACAROON_PATH,
        umbrel?.macaroonPath,
      ),
    },
  };
}
