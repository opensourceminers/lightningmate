import { authenticatedLndGrpc, type AuthenticatedLnd } from "lightning";
import type { Config } from "./config.js";

let cachedRead: AuthenticatedLnd | undefined;
let cachedWrite: AuthenticatedLnd | undefined;

/** Read-only LND client (built from the read macaroon). Cached per process. */
export function getLnd(config: Config): AuthenticatedLnd {
  if (cachedRead) return cachedRead;
  const { lnd } = authenticatedLndGrpc({
    cert: config.lnd.cert,
    macaroon: config.lnd.macaroon,
    socket: config.lnd.socket,
  });
  cachedRead = lnd;
  return lnd;
}

/**
 * Write-capable LND client, only available when writes are enabled (a separate
 * offchain:write macaroon was provided). Returns undefined otherwise, so write
 * paths can refuse cleanly instead of using the read-only client.
 */
export function getWriteLnd(config: Config): AuthenticatedLnd | undefined {
  if (!config.writeEnabled || !config.lnd.writeMacaroon) return undefined;
  if (cachedWrite) return cachedWrite;
  const { lnd } = authenticatedLndGrpc({
    cert: config.lnd.cert,
    macaroon: config.lnd.writeMacaroon,
    socket: config.lnd.socket,
  });
  cachedWrite = lnd;
  return lnd;
}
