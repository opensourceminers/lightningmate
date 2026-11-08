/**
 * A whole Magma sale against real LND nodes on regtest: the order lane accepts
 * with a real hold invoice, a real buyer pays it through a real hub, the channel
 * is really funded and confirmed, the payment really settled, and the channel
 * really closed when the lease ends. The seller dials through a slow SOCKS proxy,
 * as a node with tor.active does. Only Amboss is the test suite's fake (every
 * request checked against the saved Magma schema): what the live API answers can
 * only be seen on a live order (docs/E2E-TESTING.md, section A).
 */
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPeer,
  createChainAddress,
  getChainBalance,
  getChannel,
  getChannels,
  getClosedChannels,
  getInvoice,
  getPendingChannels,
  getRouteToDestination,
  getWalletInfo,
  openChannel,
  pay,
  type AuthenticatedLnd,
} from "lightning";
import { Autopilot } from "../src/services/autopilot.js";
import { CapitalLedger } from "../src/services/capital.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { OverridesStore } from "../src/services/overrides.js";
import { RebalanceLog } from "../src/services/rebalanceLog.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { suppressSchedulerKicks } from "../test/helpers/autopilot.js";
import { installFetchMock } from "../test/helpers/fetchMock.js";
import { FakeMagma } from "../test/helpers/magma.js";
import { FakeMarket } from "../test/helpers/market.js";
import { parsePaymentRequest } from "../test/helpers/bolt11.js";
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

// ── the network: buyer → hub → seller, and seller and buyer strangers ──────
async function fund(lnd: AuthenticatedLnd, btcAmount: number): Promise<void> {
  const { address } = await createChainAddress({ lnd });
  btc(`-rpcwallet=miner sendtoaddress ${address} ${btcAmount}`);
}
await fund(seller, 0.2);
await fund(hub, 0.1);
await fund(buyer, 0.1);
mine(2);
await until("wallets funded", async () => (await getChainBalance({ lnd: seller })).chain_balance > 0 && (await getChainBalance({ lnd: buyer })).chain_balance > 0 && (await getChainBalance({ lnd: hub })).chain_balance > 0);
await addPeer({ lnd: hub, public_key: sellerKey, socket: `127.0.0.1:${NODES.seller.p2p}` });
await addPeer({ lnd: buyer, public_key: hubKey, socket: `127.0.0.1:${NODES.hub.p2p}` });
const hubSeller = await openChannel({ lnd: hub, partner_public_key: sellerKey, local_tokens: 5_000_000 });
const buyerHub = await openChannel({ lnd: buyer, partner_public_key: hubKey, local_tokens: 3_000_000 });
await until("funding in the mempool", async () => {
  mine(1);
  return (await getChannels({ lnd: hub })).channels.length > 0 || (await getPendingChannels({ lnd: hub })).pending_channels.length === 0;
});
mine(8);
await until("both channels active", async () => (await getChannels({ lnd: hub })).channels.filter((c) => c.is_active).length === 2);
mine(4);
const route = await until("the buyer's graph reaches the seller", async () => {
  const r = await getRouteToDestination({ lnd: buyer, destination: sellerKey, tokens: 60_000 });
  return r.route;
});
console.log(`network up (${[hubSeller.transaction_id.slice(0, 8), buyerHub.transaction_id.slice(0, 8)].join(", ")}; buyer → seller over ${route.hops.length} hops)`);
check("seller and buyer are strangers", !(await getChannels({ lnd: seller })).channels.some((c) => c.partner_public_key === buyerKey));

// ── the app: the real Autopilot and order lane on the real seller LND ──────
const dir = mkdtempSync(join(tmpdir(), "lm-e2e-"));
const cleanups: (() => void)[] = [];
const t = { after: (fn: () => void) => void cleanups.push(fn) };
const http = installFetchMock(t);
const magma = new FakeMagma(http, t);
new FakeMarket(http, t);
http.onGraphql("https://api.amboss.space/graphql", "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
magma.sellerPubkey = sellerKey;
writeFileSync(
  join(dir, "autopilot.json"),
  JSON.stringify({
    config: { sellEnabled: true, sellMaxDeploySats: 10_000_000, sellMaxChannelSats: 5_000_000, sellAutoReprice: false, sellAutoSize: false, sellAutoRelist: false, sellAutoClose: true, channelMaxFeeRate: 500 },
    history: [],
    sellAutoSizeMigrated: true,
  }),
);
const amboss = new AmbossStore(dir);
amboss.setKey("test-key");
const fees = new ServiceFeeLedger(dir, null);
const earnings = new EarningsLog(dir);
const autopilot = new Autopilot(dir, seller, seller, new RebalanceLog(dir), new OverridesStore(dir), amboss, earnings, fees, undefined, new CapitalLedger());
suppressSchedulerKicks(autopilot);
const desk = autopilot.magma;
const journalPhase = (id: string) => desk.localView(id)?.phase ?? "none";

// ── the order: first the buyer can't be reached, then it can ───────────────
const SIZE = 1_000_000;
const sale = magma.addSale({
  buyerPubkey: buyerKey,
  sizeSats: SIZE,
  feeSeller: "60000",
  timeout: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  sockets: [`127.0.0.1:${NODES.buyer.p2p}`],
});
socks.delayMs = 200;
socks.refuse.add(NODES.buyer.p2p);
let actions = await desk.tick();
check("a buyer that can't be reached is not turned down", sale.status === "WAITING_FOR_SELLER_APPROVAL" && journalPhase(sale.id) === "seen", `${journalPhase(sale.id)}; ${JSON.stringify(actions.map((a) => a.error ?? a.action)).slice(0, 170)}`);
check("the lane says why", /couldn't be reached/.test(autopilot.getState().magmaLane?.error ?? ""), (autopilot.getState().magmaLane?.error ?? "").slice(0, 150));
actions = await desk.tick();
check("the next pass within minutes doesn't dial again", socks.dials <= 2 + 2, `${socks.dials} dials`);

socks.refuse.clear();
socks.delayMs = 8_000;
(desk as unknown as { buyerDials: Map<string, unknown> }).buyerDials.clear();
const dialStart = Date.now();
actions = await desk.tick();
const dialTook = (Date.now() - dialStart) / 1000;
socks.delayMs = 200;
check("over a circuit of 8 s the buyer is reached and the order accepted", sale.status === "WAITING_FOR_BUYER_PAYMENT" && !!sale.paymentRequest, `${dialTook.toFixed(1)} s, ${sale.status}, journal ${journalPhase(sale.id)}; ${JSON.stringify(actions).slice(0, 400)}`);

// ── the buyer pays: the hold invoice really holds ──────────────────────────
const request = sale.paymentRequest ?? "";
const hash = parsePaymentRequest(request).id;
const paid = pay({ lnd: buyer, request, max_fee: 1_000 });
const held = await until("the payment held at the seller", async () => {
  const i = await getInvoice({ lnd: seller, id: hash });
  return i.is_held ? i : null;
});
check("the buyer's payment is held, not settled", !!held.is_held && !held.is_confirmed, `${held.tokens} sat`);
sale.status = "WAITING_FOR_CHANNEL_OPEN";
sale.paymentStatus = "SUCCESSFUL_PAYMENT";

// ── the lane opens the channel by itself ───────────────────────────────────
actions = await desk.tick();
actions = actions.some((a) => a.action === "open" && a.ok) ? actions : await desk.tick();
const pending = await until("the sold channel pending", async () => (await getPendingChannels({ lnd: seller })).pending_channels.find((c) => c.partner_public_key === buyerKey));
check("the channel was opened by the lane, on its own", pending.is_opening && pending.capacity === SIZE, `${pending.capacity} sat, ${pending.transaction_id.slice(0, 12)}…`);
await until("the funding reported to Amboss", async () => {
  await desk.tick();
  return magma.count("AddTransaction") > 0 || !!sale.transactionId;
}, 30_000).catch(() => null);
check("the funding transaction was reported to Amboss", !!sale.transactionId, sale.transactionId ?? `status ${sale.status}`);
mine(3);
const sold = await until("the sold channel active", async () => (await getChannels({ lnd: seller })).channels.find((c) => c.partner_public_key === buyerKey && c.is_active));
check("the channel is active, the capital on our side", sold.local_balance > SIZE * 0.95, `${sold.local_balance} of ${sold.capacity} sat`);
mine(6);

// ── Amboss confirms: the payment is claimed ────────────────────────────────
sale.status = "VALID_CHANNEL_OPENING";
sale.channelId = sold.id;
await until("the payment settled", async () => {
  await desk.tick();
  return (await getInvoice({ lnd: seller, id: hash })).is_confirmed;
}, 30_000);
const settled = await paid.catch((err: unknown) => ({ failed: String(err) }));
check("the payment was claimed and the buyer's pay() succeeded", "is_confirmed" in settled && settled.is_confirmed === true, JSON.stringify(settled).slice(0, 120));
check("the sale is booked", earnings.recent().some((e) => e.orderId === sale.id), JSON.stringify(earnings.recent()[0] ?? null).slice(0, 170));
const after = await until("the sold channel in the graph", async () => {
  mine(1);
  return getChannel({ lnd: seller, id: sold.id });
}, 30_000).catch(() => null);
check("the sold channel is in the graph", after !== null);
check("it starts with a routing fee of its own, not LND's default", !!after && after.policies.some((p) => p.public_key === sellerKey && Number(p.fee_rate) !== 1), JSON.stringify(after?.policies.find((p) => p.public_key === sellerKey)?.fee_rate));

// ── the lease ends: the channel is closed, the coins come back ─────────────
const before = (await getChainBalance({ lnd: seller })).chain_balance;
sale.status = "CHANNEL_MONITORING_FINISHED";
const closing = await desk.closeFinishedLeases();
check("at the lease's end the channel is closed, on its own", closing.some((a) => a.action === "close" && a.ok), JSON.stringify(closing).slice(0, 200));
mine(3);
await until("the channel gone", async () => !(await getChannels({ lnd: seller })).channels.some((c) => c.id === sold.id));
const closed = await until("the close confirmed", async () => (await getClosedChannels({ lnd: seller })).channels.find((c) => c.id === sold.id));
mine(1);
const back = await until("the coins back on chain", async () => {
  const b = (await getChainBalance({ lnd: seller })).chain_balance;
  return b > before ? b : null;
});
check("cooperatively, and the coins are back on chain", closed.is_cooperative_close && back - before > SIZE * 0.9, `+${back - before} sat`);

// ── a sale that can't be delivered: the buyer gets the money back ──────────
const failing = magma.addSale({
  buyerPubkey: buyerKey,
  sizeSats: SIZE,
  feeSeller: "60000",
  timeout: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  sockets: [`127.0.0.1:${NODES.buyer.p2p}`],
});
await desk.tick();
check("a second order from the now known buyer is accepted", failing.status === "WAITING_FOR_BUYER_PAYMENT", failing.status);
const failingHash = parsePaymentRequest(failing.paymentRequest ?? "").id;
const refund = pay({ lnd: buyer, request: failing.paymentRequest ?? "", max_fee: 1_000 }).then(
  () => "paid",
  (err: unknown) => `refused: ${JSON.stringify(err).slice(0, 80)}`,
);
await until("the second payment held", async () => (await getInvoice({ lnd: seller, id: failingHash })).is_held);
failing.status = "WAITING_FOR_CHANNEL_OPEN";
failing.paymentStatus = "SUCCESSFUL_PAYMENT";
const funds = await getChainBalance({ lnd: seller });
// Amboss calls the order off while the payment is held.
failing.status = "BUYER_FAILED_TO_PAY";
await until("the held payment released", async () => {
  await desk.tick();
  return (await getInvoice({ lnd: seller, id: failingHash })).is_canceled;
}, 30_000);
check("the buyer's payment came back", (await refund).startsWith("refused"), await refund);
check("no second channel, no coins spent", (await getChainBalance({ lnd: seller })).chain_balance === funds.chain_balance && !(await getPendingChannels({ lnd: seller })).pending_channels.some((c) => c.is_opening), journalPhase(failing.id));

// ── done ───────────────────────────────────────────────────────────────────
autopilot.shutdown();
fees.stop();
socks.stop();
for (const fn of cleanups) {
  try {
    fn();
  } catch (err) {
    console.log(`after: ${String(err).slice(0, 200)}`);
  }
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
