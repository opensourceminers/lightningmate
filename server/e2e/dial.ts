/**
 * What ensureConnected does against a real LND: a peer that answers fast, one
 * that takes as long as a Tor circuit, and an address nothing listens on.
 */
import { getPeers, getWalletInfo, removePeer, type AuthenticatedLnd } from "lightning";
import { ensureConnected } from "../src/services/channelOps.js";
import { NODES, SOCKS_PORT, connect, slowSocks } from "./regtest.js";

const seller = connect("seller");
const buyer = connect("buyer");
const buyerKey = (await getWalletInfo({ lnd: buyer })).public_key;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const connected = async (lnd: AuthenticatedLnd, key: string) => (await getPeers({ lnd })).peers.some((p) => p.public_key === key);
async function apart(): Promise<void> {
  await removePeer({ lnd: seller, public_key: buyerKey }).catch(() => undefined);
  await sleep(1_000);
}
async function run(label: string, sockets: string[], expectOk: boolean): Promise<boolean> {
  await apart();
  const errors: string[] = [];
  const started = Date.now();
  const ok = await (ensureConnected as (l: AuthenticatedLnd, k: string, s: string[], e?: (s: string, m: string) => void) => Promise<boolean>)(seller, buyerKey, sockets, (s, m) => errors.push(`${s}: ${m}`));
  const took = ((Date.now() - started) / 1000).toFixed(1);
  const pass = ok === expectOk;
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}: ensureConnected → ${ok} after ${took} s${errors.length ? ` · ${errors.join(" · ")}` : ""}`);
  return pass;
}

const socks = await slowSocks(SOCKS_PORT);
const buyerAddress = `127.0.0.1:${NODES.buyer.p2p}`;
const results: boolean[] = [];
for (const delay of [0, 3_000, 8_000, 20_000, 35_000]) {
  socks.delayMs = delay;
  results.push(await run(`a circuit that takes ${delay / 1000} s`, [buyerAddress], true));
}
socks.delayMs = 500;
socks.refuse.add(1);
results.push(await run("the address refuses", ["127.0.0.1:1"], false));
results.push(await run("first address refuses, the second works", ["127.0.0.1:1", buyerAddress], true));
socks.delayMs = 100_000;
results.push(await run("no circuit within the budget", [buyerAddress], false));
socks.delayMs = 0;
await apart();
console.log(`in the end connected: ${await connected(seller, buyerKey)}`);
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} of ${results.length} FAILED` : `all ${results.length} passed`);
process.exit(failed ? 1 : 0);
