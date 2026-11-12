/**
 * Refills against real LND nodes on regtest (review 2026-11-10, REB-1 and
 * REB-2): what the fake LND of the test suite answers as the code expects,
 * asked of the real one. Run on a fresh network (`regtest.sh up`).
 *
 * The network: seller → hub → buyer → seller, a cycle a refill pays around;
 * the hub charges 500 ppm toward the buyer. The seller has two channels with
 * the buyer: one the buyer opened (nothing on the seller's side — drained)
 * and one the seller opened (full).
 *
 * REB-1: a route asked for under a fee limit is within it, or none — never a
 * dearer one; a refill attempt that pays nothing has its self-invoice
 * cancelled. (That a tighter limit returns a cheaper route LND did not prefer
 * needs two paths through different nodes: LND prices parallel channels
 * between two nodes at the highest fee and time lock among them, for
 * non-strict forwarding — the test suite's fake LND holds that case,
 * rebalanceRouteLimit.test.ts.)
 *
 * And what only the real LND showed (P4b): LND 0.21 ignores the single
 * outgoing channel the library sends (QueryRoutes' and SendPaymentV2's
 * deprecated `outgoing_chan_id`) — the route "out of the source" went out
 * over the buyer's own full channel and back. Checked here: the route and
 * the refill go out of the source, through the hub. REB-2: the buyer's full channel is no source for its drained
 * one, and the drained one is not refilled while the buyer is reachable
 * through the full one; with both drained the buyer is refilled once, and a
 * refill is booked on the channel it arrived on.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPeer,
  createChainAddress,
  createInvoice,
  getChainBalance,
  getChannel,
  getChannels,
  getInvoice,
  getPendingChannels,
  getWalletInfo,
  openChannel,
  pay,
  updateRoutingFees,
  type AuthenticatedLnd,
} from "lightning";
import { Autopilot } from "../src/services/autopilot.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { getChannelsView, type ChannelView } from "../src/services/channels.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { estimateCost, executeRebalance } from "../src/services/rebalance.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { getRebalanceRecommendations } from "../src/services/rebalanceRecommend.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { suppressSchedulerKicks } from "../test/helpers/autopilot.js";
import { installFetchMock } from "../test/helpers/fetchMock.js";
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
    await sleep(300);
  }
}
let failed = 0;
function check(what: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` · ${detail}` : ""}`);
}

const seller = connect("seller");
const hub = connect("hub");
const buyer = connect("buyer");
const keyOf = async (lnd: AuthenticatedLnd) => (await getWalletInfo({ lnd })).public_key;
const [sellerKey, hubKey, buyerKey] = [await keyOf(seller), await keyOf(hub), await keyOf(buyer)];
const socks = await slowSocks(SOCKS_PORT);

// ── the network ─────────────────────────────────────────────────────────────
async function fund(lnd: AuthenticatedLnd, btcAmount: number): Promise<void> {
  const { address } = await createChainAddress({ lnd });
  btc(`-rpcwallet=miner sendtoaddress ${address} ${btcAmount}`);
}
await fund(seller, 0.2);
await fund(hub, 0.2);
await fund(buyer, 0.2);
mine(2);
await until("wallets funded", async () => (await getChainBalance({ lnd: seller })).chain_balance > 0 && (await getChainBalance({ lnd: hub })).chain_balance > 0 && (await getChainBalance({ lnd: buyer })).chain_balance > 0);
// The others dial the seller (it dials through the SOCKS proxy only).
await addPeer({ lnd: hub, public_key: sellerKey, socket: `127.0.0.1:${NODES.seller.p2p}` });
await addPeer({ lnd: buyer, public_key: sellerKey, socket: `127.0.0.1:${NODES.seller.p2p}` });
await addPeer({ lnd: buyer, public_key: hubKey, socket: `127.0.0.1:${NODES.hub.p2p}` });

const opens: { lnd: AuthenticatedLnd; to: string; sats: number; name: string }[] = [
  { lnd: seller, to: hubKey, sats: 4_000_000, name: "seller→hub (the source)" },
  { lnd: hub, to: buyerKey, sats: 3_000_000, name: "hub→buyer at 500 ppm" },
  { lnd: buyer, to: sellerKey, sats: 2_000_000, name: "buyer→seller (drained on the seller's side)" },
  { lnd: seller, to: buyerKey, sats: 2_000_000, name: "seller→buyer (full on the seller's side)" },
];
const synced = () =>
  until("the nodes synced to the chain", async () => (await Promise.all([seller, hub, buyer].map((lnd) => getWalletInfo({ lnd })))).every((w) => w.is_synced_to_chain));
const funded: { txid: string; vout: number }[] = [];
for (const o of opens) {
  await synced();
  const r = await openChannel({ lnd: o.lnd, partner_public_key: o.to, local_tokens: o.sats });
  funded.push({ txid: r.transaction_id, vout: r.transaction_vout });
  mine(1);
}
await until("every funding confirmed", async () => {
  mine(1);
  return (await getPendingChannels({ lnd: hub })).pending_channels.length === 0 && (await getPendingChannels({ lnd: seller })).pending_channels.length === 0;
});
mine(8);
await until("all channels active", async () => (await getChannels({ lnd: seller })).channels.filter((c) => c.is_active).length === 3 && (await getChannels({ lnd: hub })).channels.filter((c) => c.is_active).length === 2);

const idOf = async (lnd: AuthenticatedLnd, txid: string): Promise<string> => (await getChannels({ lnd })).channels.find((c) => c.transaction_id === txid)!.id;
const sourceId = await idOf(seller, funded[0].txid);
const hb500 = await idOf(hub, funded[1].txid);
const drainedId = await idOf(seller, funded[2].txid);
const fullId = await idOf(seller, funded[3].txid);

// The hub's prices toward the buyer; the buyer forwards back to the seller for free.
await updateRoutingFees({ lnd: hub, transaction_id: funded[1].txid, transaction_vout: funded[1].vout, base_fee_tokens: 0, fee_rate: 500, cltv_delta: 40 });
for (const f of [funded[2], funded[3]]) await updateRoutingFees({ lnd: buyer, transaction_id: f.txid, transaction_vout: f.vout, base_fee_tokens: 0, fee_rate: 0, cltv_delta: 40 });
mine(6);
await until("the seller's graph has the hub's prices", async () => {
  const a = await getChannel({ lnd: seller, id: hb500 });
  return a.policies.find((p) => p.public_key === hubKey)?.fee_rate === 500;
}, 120_000);
// Channels must be two weeks old to give liquidity (the refill rules): 2,100 blocks.
for (let i = 0; i < 7; i++) {
  mine(300);
  await synced();
}
console.log(`network up: source ${sourceId}, drained ${drainedId}, full ${fullId}; hub→buyer ${hb500} (500 ppm)`);

const view = async (id: string): Promise<ChannelView> => (await getChannelsView(seller)).find((c) => c.id === id)!;
const AMOUNT = 500_000;

// ── REB-1: a route under a limit is within it, or none ─────────────────────
{
  const [source, target] = [await view(sourceId), await view(drainedId)];
  const peers = (await getChannelsView(seller)).map((c) => c.peerPubkey);
  const loose = await estimateCost(seller, sellerKey, source, target, AMOUNT, 3_000, 1_500, peers);
  console.log(`LND's route under 1,500 sat: ${loose.feeSats ?? "none"} sat (${loose.costPpm ?? "-"} ppm)`);
  check("under a loose limit LND finds a route", loose.feeSats !== null && loose.feeSats <= 1_500, `${loose.feeSats} sat`);
  // The route goes out of the source, through the hub: it costs the hub's
  // fee. (LND ignores QueryRoutes' outgoing channel: without the first hops
  // to the other peers shut out it went out over the buyer's own full
  // channel and back for 2 sat.)
  check("the route goes out of the source, through the hub, not out over the buyer's own channel and back", (loose.costPpm ?? 0) >= 190, `${loose.costPpm} ppm`);
  const tight = await estimateCost(seller, sellerKey, source, target, AMOUNT, 3_000, 260, peers);
  check("under a limit the route fits, that route, within it", tight.feeSats !== null && tight.feeSats <= 260, `${tight.feeSats} sat (500 ppm of 500k = 250 sat)`);
  const none = await estimateCost(seller, sellerKey, source, target, AMOUNT, 3_000, 200, peers);
  check("under a limit no route fits, none — never one above it", none.feeSats === null, `${none.feeSats}`);
}

// ── REB-1: an attempt that pays nothing has its invoice cancelled ──────────
{
  const sent: string[] = [];
  const before = (await getChannelsView(seller)).find((c) => c.id === drainedId)!.localBalance;
  const res = await executeRebalance(
    seller,
    seller,
    { targetId: drainedId, sourceId, amountSats: AMOUNT, econRatio: 1, maxFeePpm: 3_000, maxFeeSats: 2 },
    { onSend: (a) => void sent.push(a.paymentId) },
  );
  check("a refill with no route within its 2 sat pays nothing", !res.ok && (await view(drainedId)).localBalance === before, res.error ?? "");
  check("each attempt went out with its own invoice", sent.length >= 1, `${sent.length} attempt(s)`);
  const states = await Promise.all(sent.map((id) => getInvoice({ lnd: seller, id })));
  check("every attempt's self-invoice is cancelled", states.length > 0 && states.every((i) => i.is_canceled === true), states.map((i) => (i.is_canceled ? "cancelled" : i.is_confirmed ? "paid" : "open")).join(", "));
}

// ── REB-2: the plan, one peer over two channels ─────────────────────────────
const plan = async () => getRebalanceRecommendations(seller, { rebalanceRecords: [], cooldown: null });
{
  const p = await plan();
  const drained = p.recommendations.find((r) => r.channelId === drainedId);
  // (The peer rule must be what holds it back: a drained channel with no
  // demand is not refilled anyway, so its reason is what is checked.)
  check(
    "the buyer's drained channel is not refilled while the buyer is reachable through its full one — by the peer rule",
    !!drained && !drained.wouldRebalance && drained.blockedBy.includes("peer has outbound in another channel"),
    drained ? `${drained.state}: ${drained.blockedBy.join(", ")}` : "no row",
  );
  // The executor, asked to refill the drained channel out of the full one
  // (a stale plan, a request by hand): refused before any invoice or route.
  const sameSent: string[] = [];
  const same = await executeRebalance(
    seller,
    seller,
    { targetId: drainedId, sourceId: fullId, amountSats: 200_000, econRatio: 1, maxFeePpm: 3_000, maxFeeSats: 500 },
    { onSend: (a) => void sameSent.push(a.paymentId) },
  );
  check("the buyer's full channel is never a source for its drained one: the executor refuses it, nothing is sent", !same.ok && sameSent.length === 0, same.error ?? "");
}

// Empty the full one too: the seller pays the buyer 1.8M over it.
{
  const inv = await createInvoice({ lnd: buyer, tokens: 1_800_000 });
  await pay({ lnd: seller, request: inv.request, outgoing_channel: fullId, max_fee: 10 });
  await until("the seller's side of both buyer channels drained", async () => (await view(fullId)).localBalance < 300_000);
}

// ── REB-2: both drained — refilled once, booked where the sats landed ──────
{
  // (That a peer drained over both channels is refilled once per plan needs
  // demand the regtest network has none of — no forwards: the suite holds it,
  // rebalanceSamePeer.test.ts. The review of P4, P9.)

  const dir = mkdtempSync(join(tmpdir(), "lm-e2e-refill-"));
  const cleanups: (() => void)[] = [];
  const t = { after: (fn: () => void) => void cleanups.push(fn) };
  const http = installFetchMock(t);
  http.onGraphql("https://api.amboss.space/graphql", "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  writeFileSync(join(dir, "autopilot.json"), JSON.stringify({ config: {}, history: [], sellAutoSizeMigrated: true }));
  const log = new RebalanceLog(dir);
  const fees = new ServiceFeeLedger(dir, null);
  const autopilot = new Autopilot(dir, seller, seller, log, new OverridesStore(dir), new AmbossStore(dir), new EarningsLog(dir), fees);
  suppressSchedulerKicks(autopilot);
  const localOf = async () => Object.fromEntries((await getChannels({ lnd: seller })).channels.map((c) => [c.id, c.local_balance]));
  const before = await localOf();
  const res = await autopilot.rebalanceByHand({ targetId: drainedId, sourceId, amountSats: 300_000, econRatio: 2, maxFeePpm: 3_000, maxFeeSats: 300 });
  // (LND updates the incoming channel's balance when the HTLC settles on it,
  // a moment after the payment reports success.)
  const after = res?.ok
    ? await until("the refill on one of the buyer's channels", async () => {
        const now = await localOf();
        return [drainedId, fullId].some((id) => (now[id] ?? 0) - (before[id] ?? 0) >= 250_000) ? now : null;
      }, 30_000).catch(() => localOf())
    : await localOf();
  // (A channel the peer opened can show a few sats more on our side after
  // any update — its commitment fee: what arrived is the 300k.)
  const grew = [drainedId, fullId].filter((id) => (after[id] ?? 0) - (before[id] ?? 0) >= 250_000);
  console.log(`seller's side: ${[drainedId, fullId].map((id) => `${id} ${before[id]} → ${after[id]}`).join(", ")}`);
  const record = log.successes().at(-1);
  console.log(`refill: ${res?.ok ? "paid" : `not paid (${res?.error})`}; landed ${res?.landed?.id ?? "on the target"}; grew ${grew.join(", ")}`);
  check("the refill pays", res?.ok === true, res?.error ?? "");
  check("it went out of the source, through the hub", (after[sourceId] ?? 0) < (before[sourceId] ?? 0), `source ${before[sourceId]} → ${after[sourceId]}`);
  check("it arrived on one of the buyer's channels", grew.length === 1, grew.join(", "));
  check("it is booked on the channel it arrived on", !!record && record.targetId === grew[0], `booked ${record?.targetId}, arrived ${grew[0]}${record?.plannedTargetId ? `, planned ${record.plannedTargetId}` : ""}`);
  const stamped = (JSON.parse(readFileSync(join(dir, "autopilot.json"), "utf8")) as { perTargetLastRebalanced?: Record<string, string> }).perTargetLastRebalanced ?? {};
  check("the cooldown is that channel's", !!stamped[grew[0]], Object.keys(stamped).join(", "));
  autopilot.shutdown();
  fees.stop();
  for (const fn of cleanups) {
    try {
      fn();
    } catch (err) {
      console.log(`after: ${String(err).slice(0, 200)}`);
    }
  }
}

socks.stop();
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
