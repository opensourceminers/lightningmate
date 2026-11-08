/**
 * Shared pieces of the regtest end-to-end checks: real LND nodes (their data
 * directories under REGTEST_DIR), and a SOCKS proxy that delays a connection
 * the way a Tor circuit does. The fakes the normal test suite uses answer ConnectPeer
 * however the test says — only a real LND shows what the call really does.
 */
import { readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { authenticatedLndGrpc, type AuthenticatedLnd } from "lightning";

export const REGTEST_DIR = process.env.REGTEST_DIR ?? "";
if (!REGTEST_DIR) throw new Error("set REGTEST_DIR to the folder holding the nodes' data directories (see docs/E2E-TESTING.md)");

export const NODES = {
  seller: { rpc: 20109, p2p: 29735 },
  hub: { rpc: 20209, p2p: 29736 },
  buyer: { rpc: 20309, p2p: 29737 },
} as const;
export type NodeName = keyof typeof NODES;
/** Where the seller LND's --tor.socks points. */
export const SOCKS_PORT = 19_150;

export function connect(name: NodeName): AuthenticatedLnd {
  const dir = join(REGTEST_DIR, name);
  const { lnd } = authenticatedLndGrpc({
    cert: readFileSync(join(dir, "tls.cert")).toString("base64"),
    macaroon: readFileSync(join(dir, "data/chain/bitcoin/regtest/admin.macaroon")).toString("base64"),
    socket: `127.0.0.1:${NODES[name].rpc}`,
  });
  return lnd;
}

/**
 * A SOCKS5 proxy on `port` that answers a connect only after `delayMs`, the way
 * Tor answers once its circuit stands. The seller LND dials through it, like a
 * node with tor.active. Set `delayMs` between dials; a target in `refuse` gets
 * "connection refused", as from an exit or a node that is down.
 */
export function slowSocks(port: number): Promise<{ delayMs: number; refuse: Set<number>; dials: number; stop: () => void }> {
  const state = { delayMs: 0, refuse: new Set<number>(), dials: 0, stop: () => undefined as void };
  return new Promise((resolve) => {
    const server = createServer((inbound) => {
      inbound.on("error", () => undefined);
      inbound.once("data", (greeting) => {
        if (greeting[0] !== 5) return void inbound.destroy();
        inbound.write(Buffer.from([5, 0]));
        inbound.once("data", (req) => {
          const atyp = req[3];
          const host = atyp === 1 ? [...req.subarray(4, 8)].join(".") : req.subarray(5, 5 + req[4]).toString();
          const targetPort = req.readUInt16BE(req.length - 2);
          state.dials++;
          const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
          setTimeout(() => {
            if (state.refuse.has(targetPort)) {
              inbound.write(reply(5));
              return void inbound.destroy();
            }
            const out = createConnection({ host, port: targetPort }, () => {
              inbound.write(reply(0));
              inbound.pipe(out);
              out.pipe(inbound);
            });
            out.on("error", () => {
              inbound.write(reply(5));
              inbound.destroy();
            });
            inbound.on("close", () => out.destroy());
            out.on("close", () => inbound.destroy());
          }, state.delayMs);
        });
      });
    });
    state.stop = () => void server.close();
    server.listen(port, "127.0.0.1", () => resolve(state));
  });
}
