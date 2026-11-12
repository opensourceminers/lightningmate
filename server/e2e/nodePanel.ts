/**
 * What a node's details do against a real LND on regtest, through the app's own
 * routes: look a stranger up, open a channel to it by hand (a second click
 * refused while the first is dialing), read the channel back, set its fee mode,
 * close it, and see the close on record. Everything the panel and the search
 * read from LND is read here from the real thing.
 */
import { execSync } from "node:child_process";
import { createChainAddress, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { startApi } from "../test/helpers/apiHarness.js";
import type { FakeLnd } from "../test/helpers/fakeLnd.js";
import { NODES, SOCKS_PORT, connect, slowSocks } from "./regtest.js";

const cli = process.env.REGTEST_BITCOIN_CLI ?? "";
if (!cli) throw new Error("set REGTEST_BITCOIN_CLI to the bitcoin-cli command with its -regtest and RPC options");
const btc = (args: string): string => execSync(`${cli} ${args}`, { encoding: "utf8" }).trim();
const miner = btc("-rpcwallet=miner getnewaddress");
const mine = (n: number): void => void btc(`generatetoaddress ${n} ${miner}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(500);
  }
}
let failed = 0;
function check(what: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` · ${detail}` : ""}`);
}

const seller = connect("seller");
const buyer = connect("buyer");
const keyOf = async (lnd: AuthenticatedLnd) => (await getWalletInfo({ lnd })).public_key;
const [sellerKey, buyerKey] = [await keyOf(seller), await keyOf(buyer)];
const socks = await slowSocks(SOCKS_PORT);
const { address } = await createChainAddress({ lnd: seller });
btc(`-rpcwallet=miner sendtoaddress ${address} 0.2`);
mine(2);
await until("the seller sees its coins", async () => (await getWalletInfo({ lnd: seller })).is_synced_to_chain);
await sleep(3_000);

const cleanups: (() => unknown)[] = [];
const fakeLike = { lnd: seller, publicKey: sellerKey, withoutPermission: () => seller } as unknown as FakeLnd;
const api = await startApi({ after: (fn: () => unknown) => void cleanups.push(fn) } as never, { node: fakeLike });
api.settings.set({ lnplusLookups: false, nodeLookups: false });

// ── a stranger ───────────────────────────────────────────────────────────────
const stranger = await api.request("GET", `/nodes/detail?pubkey=${buyerKey}`);
check("a stranger's details answer", stranger.status === 200 && stranger.body.channels.length === 0, `network ${JSON.stringify(stranger.body.network)}`);
const selfDetail = await api.request("GET", `/nodes/detail?pubkey=${sellerKey}`);
check("this node knows itself", selfDetail.body.isSelf === true);
const found = await api.request("GET", `/nodes/search?q=${buyerKey}@127.0.0.1:${NODES.buyer.p2p}`);
check("the search takes key@host:port", found.status === 200 && found.body.hits[0]?.pubkey === buyerKey, `${found.body.hits.length} hit(s)`);

// ── open by hand ─────────────────────────────────────────────────────────────
socks.delayMs = 4_000;
const body = { pubkey: buyerKey, socket: `127.0.0.1:${NODES.buyer.p2p}`, localTokens: 2_000_000, feeRate: 2 };
const first = api.request("POST", "/channels/open", body);
await sleep(1_000);
const second = await api.request("POST", "/channels/open", body);
check("a second click while the first is dialing is refused", second.status === 409 && second.body.error === "open_in_flight", `${second.status}`);
const opened = await first;
socks.delayMs = 0;
check("the open goes through a slow dial", opened.status === 200 && opened.body.ok === true, opened.body.error ?? opened.body.transactionId);
const opening = await api.request("GET", `/nodes/detail?pubkey=${buyerKey}`);
check("it shows as opening", opening.body.channels[0]?.status === "pending_open");
mine(3);
const open = await until("the channel to be open", async () => {
  const d = await api.request("GET", `/nodes/detail?pubkey=${buyerKey}`);
  return d.body.channels[0]?.status === "open" && d.body.channels[0]?.active ? d.body : null;
});
mine(6);
const c = open.channels[0];
const f = open.channelFacts[0];
check("its figures are the channel's", c.capacity === 2_000_000 && c.localBalance > 1_900_000 && f.channelId === c.id && c.initiator === "local", `id ${c.id}, local ${c.localBalance}`);
check("its age comes from its block", f.ageDays !== null && f.ageDays >= 0 && f.ageDays < 1, `${f.ageDays}`);
check("the connection is there", open.connection?.socket?.includes(String(NODES.buyer.p2p)) === true && open.connection?.inbound === false, JSON.stringify(open.connection));
const graph = await until("the peer's fee in the graph", async () => {
  const d = await api.request("GET", `/nodes/detail?pubkey=${buyerKey}`);
  return d.body.channelFacts[0]?.theirFeePpm !== null ? d.body : null;
}, 60_000).catch(() => null);
check("what the peer charges is read from the graph", graph !== null, graph ? `${graph.channelFacts[0].theirFeePpm} ppm, base ${graph.channelFacts[0].theirBaseFeeMsat}, time-lock ${graph.channelFacts[0].theirTimeLock}` : "");
check("the network section stands on the real answer", graph?.network?.channels >= 1, JSON.stringify(graph?.network));
const assessed = await api.request("GET", `/nodes/assessment?pubkey=${buyerKey}`);
check("a peer is assessed as a peer", assessed.status === 200 && assessed.body.candidate === null && typeof assessed.body.uniqueReach === "number", JSON.stringify(assessed.body));
const table = await api.request("GET", "/channels");
check("the table has its age", table.body.find((x: { id: string }) => x.id === c.id)?.ageDays !== null);
const dash = await api.request("GET", "/dashboard");
check("the start page's figures answer", dash.status === 200 && dash.body.idleChannels?.count === 0, JSON.stringify(dash.body.idleChannels));

// ── its fee mode, as the panel saves it ──────────────────────────────────────
const pinned = await api.request("POST", "/overrides", { channelId: c.id, mode: "exclude" });
check("the fee mode saves", pinned.status === 200 && pinned.body[c.id]?.mode === "exclude", JSON.stringify(pinned.body[c.id]));
const back = await api.request("POST", "/overrides", { channelId: c.id, mode: "auto" });
check("and goes back", back.status === 200);

// ── never open automatically ─────────────────────────────────────────────────
await api.request("POST", "/channels/never-open", { pubkey: buyerKey, never: true, alias: "buyer" });
const never = await api.request("GET", `/nodes/detail?pubkey=${buyerKey}`);
check("never-open shows in the details", never.body.neverOpen === true);
await api.request("POST", "/channels/never-open", { pubkey: buyerKey, never: false });

// ── close ────────────────────────────────────────────────────────────────────
const closed = await api.request("POST", "/channels/close", { transactionId: c.transactionId, transactionVout: c.transactionVout, isForce: false, feeRate: 2 });
// On regtest the peer's fee estimate is far above 2 sat/vB, so LND's first round
// ends in a refusal; what matters is that the app doesn't call that a failure.
check(
  "the close is sent, or said to be under way",
  closed.status === 200 && (closed.body.ok === true || (closed.body.stillClosing === true && /Wait for it\./.test(closed.body.error))),
  closed.body.error ?? closed.body.transactionId,
);
const closing = await until("the channel to be closing", async () => {
  const d = await api.request("GET", `/nodes/detail?pubkey=${buyerKey}`);
  return d.body.channels[0]?.status === "pending_close" ? d.body : null;
});
check("it shows as closing", closing.channels[0].status === "pending_close", closing.channels[0].id);
mine(3);
const gone = await until("the close on record", async () => {
  const d = await api.request("GET", `/nodes/detail?pubkey=${buyerKey}`);
  return d.body.channels.length === 0 && d.body.closedChannels.length === 1 ? d.body : null;
});
const was = gone.closedChannels[0];
check("the close is on record: cooperative, dated, with what came back", was.how === "cooperative" && was.closedDaysAgo === 0 && was.finalLocalSats > 1_900_000 && was.id === c.id, JSON.stringify(was));

socks.stop();
for (const fn of cleanups) await fn();
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
