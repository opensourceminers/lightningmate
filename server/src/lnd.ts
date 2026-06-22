import { authenticatedLndGrpc, type AuthenticatedLnd } from "lightning";
import type { Config } from "./config.js";

let cached: AuthenticatedLnd | undefined;

/**
 * Build (once) and return an authenticated LND gRPC client. We only ever pass a
 * read-only macaroon in v1, so this connection cannot mutate node state.
 */
export function getLnd(config: Config): AuthenticatedLnd {
  if (cached) return cached;

  const { lnd } = authenticatedLndGrpc({
    cert: config.lnd.cert,
    macaroon: config.lnd.macaroon,
    socket: config.lnd.socket,
  });

  cached = lnd;
  return lnd;
}
