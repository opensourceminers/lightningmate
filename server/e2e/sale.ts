/**
 * A whole Magma sale against real LND nodes on regtest: the order lane accepts
 * with a real hold invoice, a real buyer pays it through a real hub, the channel
 * is really funded and confirmed, the payment really settled, and the channel
 * really closed when the lease ends. The seller dials through a slow SOCKS proxy,
 * as a node with tor.active does. Only Amboss is the test suite's fake (every
 * request checked against the saved Magma schema): what the live API answers can
 * only be seen on a live order (docs/E2E-TESTING.md, section A).
 *
 * The first sale runs the way Amboss's docs put it — the buyer pays our hold
 * invoice before the channel is opened. The last two run the way a live sale
 * did (2026-11-11): the buyer has paid Amboss, the channel is opened with our
 * invoice unpaid, and the payment comes only after Amboss confirmed the
 * channel — the buyer node stands in for Amboss as the payer.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { magmaRefundAlerts } from "../src/services/alerts.js";
import { Autopilot } from "../src/services/autopilot.js";
import { CapitalLedger } from "../src/services/capital.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { fundingHeight } from "../src/services/leaseCaps.js";
import { AWAITING_AMBOSS_PAYMENT, OPEN_MIN_BLOCKS_LEFT } from "../src/services/magmaDesk.js";
import type { MagmaJournalEntry } from "../src/services/magmaJournal.js";
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
const capital = new CapitalLedger();
const autopilot = new Autopilot(dir, seller, seller, new RebalanceLog(dir), new OverridesStore(dir), amboss, earnings, fees, undefined, capital);
suppressSchedulerKicks(autopilot);
const desk = autopilot.magma;
const journalPhase = (id: string) => desk.localView(id)?.phase ?? "none";
/** The order's record as a restart would read it. */
const onDisk = (id: string): MagmaJournalEntry | undefined =>
  existsSync(join(dir, "magma-orders.json"))
    ? (JSON.parse(readFileSync(join(dir, "magma-orders.json"), "utf8")) as MagmaJournalEntry[]).find((e) => e.orderId === id)
    : undefined;
const heightOf = async (lnd: AuthenticatedLnd) => (await getWalletInfo({ lnd })).current_block_height;
/** Mine up to `height`, the three nodes following. */
async function mineTo(height: number): Promise<void> {
  for (let at = await heightOf(seller); at < height; at = await heightOf(seller)) {
    mine(Math.min(400, height - at));
    const tip = Number(btc("getblockcount"));
    await until(`the nodes at block ${tip}`, async () => (await Promise.all([seller, hub, buyer].map(heightOf))).every((h) => h >= tip), 180_000);
  }
}

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
// The open states its fee rate (LND's 6-block estimate), and LND pays it.
const stated = Number(/^open started at (\d+) sat\/vB$/.exec(onDisk(sale.id)?.events.find((e) => e.what.startsWith("open started at"))?.what ?? "")?.[1] ?? NaN);
const funding = JSON.parse(btc(`getmempoolentry ${pending.transaction_id}`)) as { vsize: number; fees: { base: number } };
const paidRate = (funding.fees.base * 1e8) / funding.vsize;
check(
  "the open named its fee rate, and the funding transaction pays it",
  Number.isFinite(stated) && Math.abs(paidRate - stated) <= Math.max(1, stated * 0.05),
  `stated ${stated} sat/vB; paid ${Math.round(funding.fees.base * 1e8)} sat for ${funding.vsize} vB = ${paidRate.toFixed(2)} sat/vB`,
);
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
// Amboss's word alone closes nothing: by the seller's own count (funding
// block, the lease, a day) the lease still runs.
const early = await desk.closeFinishedLeases();
const leaseEnd = (fundingHeight(sold.id) ?? 0) + sale.promises.minBlockLength + 144;
check(
  "Amboss lists the lease as over, the node's own count doesn't: nothing is closed",
  early.length === 0 && (await getChannels({ lnd: seller })).channels.some((c) => c.id === sold.id) && /by this node's count it runs until block/.test(onDisk(sale.id)?.events.at(-1)?.what ?? ""),
  (onDisk(sale.id)?.events.at(-1)?.what ?? JSON.stringify(early)).slice(0, 220),
);
await mineTo(leaseEnd - 1);
check("one block before the lease's end it is still open", (await desk.closeFinishedLeases()).length === 0, `block ${await heightOf(seller)} of ${leaseEnd}`);
await mineTo(leaseEnd);
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

// ── fees rise after the buyer paid: the open waits, then the buyer is refunded ──
const pricey = magma.addSale({
  buyerPubkey: buyerKey,
  sizeSats: SIZE,
  feeSeller: "60000",
  timeout: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  sockets: [`127.0.0.1:${NODES.buyer.p2p}`],
});
await desk.tick();
check("a third order is accepted at regtest's fee estimate", pricey.status === "WAITING_FOR_BUYER_PAYMENT", pricey.status);
const priceyHash = parsePaymentRequest(pricey.paymentRequest ?? "").id;
const priceyPay = pay({ lnd: buyer, request: pricey.paymentRequest ?? "", max_fee: 1_000 }).then(
  () => "paid",
  (err: unknown) => `refused: ${JSON.stringify(err).slice(0, 80)}`,
);
const priceyHeld = await until("the third payment held", async () => {
  const i = await getInvoice({ lnd: seller, id: priceyHash });
  return i.is_held ? i : null;
});
pricey.status = "WAITING_FOR_CHANNEL_OPEN";
pricey.paymentStatus = "SUCCESSFUL_PAYMENT";
// LND's estimate is the one thing changed here: 400 sat/vB, so the open
// (175 vB, 70,000 sat) would cost more than the 60,000 sat the sale earns
// (no service fee is set here).
const wallet = (seller as unknown as { wallet: { estimateFee: (args: unknown, cb: (err: unknown, res?: { sat_per_kw: string }) => void) => void } }).wallet;
const realEstimate = wallet.estimateFee;
wallet.estimateFee = (_args, cb) => cb(null, { sat_per_kw: String(400 * 250) });
const chainBefore = (await getChainBalance({ lnd: seller })).chain_balance;
await desk.tick();
await desk.tick();
check(
  "with fees above what the sale earns the lane opens nothing and keeps the payment held",
  !(await getPendingChannels({ lnd: seller })).pending_channels.some((c) => c.is_opening) &&
    (await getInvoice({ lnd: seller, id: priceyHash })).is_held === true &&
    /^on-chain fees are 400 sat\/vB: opening the channel would cost about 70,000 sat, more than the 60,000 sat this sale earns/.test(onDisk(pricey.id)?.lastError ?? ""),
  (onDisk(pricey.id)?.lastError ?? journalPhase(pricey.id)).slice(0, 200),
);
check("the lane's status says what it waits for", /^1 paid order waits for lower on-chain fees/.test(autopilot.getState().magmaLane?.error ?? ""), (autopilot.getState().magmaLane?.error ?? "").slice(0, 120));
// The held payment's own height is the limit: OPEN_MIN_BLOCKS_LEFT before it
// the open could no longer be confirmed in time.
const heldUntil = Math.min(...priceyHeld.payments.filter((p) => p.is_held).map((p) => p.timeout));
await mineTo(heldUntil - OPEN_MIN_BLOCKS_LEFT);
await desk.tick();
check("still waited for at the last block an open could be confirmed in time", (await getInvoice({ lnd: seller, id: priceyHash })).is_held === true, `block ${await heightOf(seller)}, held until ${heldUntil}`);
await mineTo(heldUntil - OPEN_MIN_BLOCKS_LEFT + 1);
await until("the third payment released", async () => {
  await desk.tick();
  return (await getInvoice({ lnd: seller, id: priceyHash })).is_canceled;
}, 30_000);
wallet.estimateFee = realEstimate;
check("one block later the buyer is refunded", (await priceyPay).startsWith("refused"), await priceyPay);
check(
  "no channel was opened, no coins spent, nothing kept reserved",
  !(await getPendingChannels({ lnd: seller })).pending_channels.some((c) => c.is_opening) &&
    (await getChainBalance({ lnd: seller })).chain_balance === chainBefore &&
    capital.reservedSat() === 0,
  `${journalPhase(pricey.id)}: ${(onDisk(pricey.id)?.reason ?? "").slice(0, 170)}`,
);
const refundAlerts = magmaRefundAlerts(desk);
check("the operator is told of the refund", refundAlerts.length === 1 && refundAlerts[0].id === `magma:${pricey.id}`, (refundAlerts[0]?.message ?? "none").slice(0, 150));

// ── Amboss answers the accept with an error (HTTP 502): bounded ────────────
magma.behave.AcceptOrder = "throw";
const unsure = magma.addSale({
  buyerPubkey: buyerKey,
  sizeSats: SIZE,
  feeSeller: "60000",
  timeout: new Date(Date.now() + 10 * 60_000).toISOString(),
  sockets: [`127.0.0.1:${NODES.buyer.p2p}`],
});
await desk.tick();
const unsureInvoice = onDisk(unsure.id)?.invoice?.id ?? "";
const made = unsureInvoice ? await getInvoice({ lnd: seller, id: unsureInvoice }).catch(() => null) : null;
check(
  "an accept answered with a 502 stays unconfirmed: its hold invoice exists, its size is reserved",
  journalPhase(unsure.id) === "accepting" && !!made && !made.is_canceled && !made.is_held && capital.reservedSat() === SIZE && unsure.status === "WAITING_FOR_SELLER_APPROVAL",
  `${journalPhase(unsure.id)}, reserved ${capital.reservedSat()} sat`,
);
// The approval deadline is a minute away: inside the reject margin.
unsure.timeout = new Date(Date.now() + 60_000).toISOString();
const acceptsSent = magma.count("AcceptOrder");
await desk.tick();
check(
  "near the approval deadline the order is rejected, not left to time out — the accept not sent again",
  unsure.status === "SELLER_REJECTED" && journalPhase(unsure.id) === "rejected" && magma.count("AcceptOrder") === acceptsSent,
  `${unsure.status}, ${journalPhase(unsure.id)}: ${(onDisk(unsure.id)?.reason ?? "").slice(0, 120)}`,
);
check(
  "its hold invoice is cancelled in LND and its size free again",
  (await getInvoice({ lnd: seller, id: unsureInvoice })).is_canceled === true && capital.reservedSat() === 0,
  `reserved ${capital.reservedSat()} sat`,
);
magma.behave.AcceptOrder = "ok";
const next = magma.addSale({
  buyerPubkey: buyerKey,
  sizeSats: SIZE,
  feeSeller: "60000",
  timeout: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  sockets: [`127.0.0.1:${NODES.buyer.p2p}`],
});
await desk.tick();
check("the next order is accepted as ever", next.status === "WAITING_FOR_BUYER_PAYMENT", `${next.status}; ${(onDisk(next.id)?.reason ?? "").slice(0, 120)}`);

// ── the buyer paid Amboss: the channel is opened before our invoice is paid ──
const order = () =>
  magma.addSale({
    buyerPubkey: buyerKey,
    sizeSats: SIZE,
    feeSeller: "60000",
    timeout: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    sockets: [`127.0.0.1:${NODES.buyer.p2p}`],
  });
/** The seller's channels to the buyer that are still being opened. */
const openingToBuyer = async () => (await getPendingChannels({ lnd: seller })).pending_channels.filter((c) => c.partner_public_key === buyerKey && c.is_opening);
const unpaid = (i: { is_held?: boolean; is_confirmed: boolean; is_canceled?: boolean }) => !i.is_held && !i.is_confirmed && !i.is_canceled;
const bookedFor = (id: string) => earnings.recent().filter((e) => e.orderId === id).length;

const prepaid = order();
magma.buyerPaidAmboss(prepaid.id);
await desk.tick();
const prepaidHash = parsePaymentRequest(prepaid.paymentRequest ?? "").id;
check(
  "an order whose buyer paid Amboss is accepted and waits for its channel, our invoice unpaid",
  prepaid.status === "WAITING_FOR_CHANNEL_OPEN" && journalPhase(prepaid.id) === "accepted" && unpaid(await getInvoice({ lnd: seller, id: prepaidHash })),
  `${prepaid.status}, journal ${journalPhase(prepaid.id)}`,
);
await desk.tick();
const prepaidPending = await until("the unpaid order's channel pending", async () => (await openingToBuyer())[0]);
check(
  "the lane opens its channel with nothing held by our invoice",
  prepaidPending.capacity === SIZE && unpaid(await getInvoice({ lnd: seller, id: prepaidHash })),
  `${prepaidPending.capacity} sat, ${prepaidPending.transaction_id.slice(0, 12)}…; ${(onDisk(prepaid.id)?.events.map((e) => e.what).join(" | ") ?? "").slice(0, 260)}`,
);
await until("the unpaid order's funding reported to Amboss", async () => {
  await desk.tick();
  return !!prepaid.transactionId;
}, 30_000).catch(() => null);
check("its funding transaction is reported to Amboss", (prepaid.transactionId ?? "").startsWith(prepaidPending.transaction_id), prepaid.transactionId ?? `status ${prepaid.status}`);
mine(3);
const prepaidChannel = await until("the unpaid order's channel active", async () => (await getChannels({ lnd: seller })).channels.find((c) => c.transaction_id === prepaidPending.transaction_id && c.is_active));
mine(6);
prepaid.status = "VALID_CHANNEL_OPENING";
prepaid.channelId = prepaidChannel.id;
await desk.tick();
await desk.tick();
check(
  "Amboss confirms the channel before it has paid: nothing is claimed, the order waits for Amboss's payment",
  unpaid(await getInvoice({ lnd: seller, id: prepaidHash })) && journalPhase(prepaid.id) === "reported" && onDisk(prepaid.id)?.decision?.reason === AWAITING_AMBOSS_PAYMENT && bookedFor(prepaid.id) === 0,
  `${journalPhase(prepaid.id)}: ${onDisk(prepaid.id)?.decision?.reason ?? onDisk(prepaid.id)?.lastError ?? ""}`.slice(0, 200),
);
const latePay = pay({ lnd: buyer, request: prepaid.paymentRequest ?? "", max_fee: 1_000 });
await until("the payment after the confirmation settled", async () => {
  await desk.tick();
  return (await getInvoice({ lnd: seller, id: prepaidHash })).is_confirmed;
}, 60_000).catch(() => null);
const lateDone = await latePay.catch((err: unknown) => ({ failed: JSON.stringify(err).slice(0, 120) }));
check("the payment that arrives after the confirmation is claimed", "is_confirmed" in lateDone && lateDone.is_confirmed === true, JSON.stringify(lateDone).slice(0, 120));
check("the sale is booked, once", bookedFor(prepaid.id) === 1 && journalPhase(prepaid.id) === "settled", `${bookedFor(prepaid.id)} booking(s), journal ${journalPhase(prepaid.id)}`);

// ── a channel opened by hand while the lane waits: taken, never a second ───
const byHand = order();
magma.buyerPaidAmboss(byHand.id);
await desk.tick();
const byHandHash = parsePaymentRequest(byHand.paymentRequest ?? "").id;
// Fees above what the sale earns: the lane waits for lower ones.
wallet.estimateFee = (_args, cb) => cb(null, { sat_per_kw: String(400 * 250) });
await desk.tick();
await desk.tick();
check(
  "with fees above what the sale earns the unpaid order waits for lower fees, and says when it is ended should the open still cost more",
  byHand.status === "WAITING_FOR_CHANNEL_OPEN" &&
    (await openingToBuyer()).length === 0 &&
    /^on-chain fees are 400 sat\/vB: opening the channel would cost about 70,000 sat, more than the 60,000 sat this sale earns; Amboss holds the buyer's payment\. If the open still costs more at .* UTC, the order is ended then and Amboss refunds the buyer/.test(
      onDisk(byHand.id)?.lastError ?? "",
    ),
  (onDisk(byHand.id)?.lastError ?? journalPhase(byHand.id)).slice(0, 260),
);
// The operator opens the channel with another tool, at a fee of their choice.
await addPeer({ lnd: seller, public_key: buyerKey, socket: `127.0.0.1:${NODES.buyer.p2p}` }).catch(() => null);
const hand = await openChannel({ lnd: seller, partner_public_key: buyerKey, local_tokens: SIZE, chain_fee_tokens_per_vbyte: 2 });
const handOutpoint = `${hand.transaction_id}:${hand.transaction_vout}`;
await until("the hand-opened channel pending", async () => (await openingToBuyer()).some((c) => c.transaction_id === hand.transaction_id));
wallet.estimateFee = realEstimate;
await until("the hand-opened channel reported to Amboss", async () => {
  await desk.tick();
  return !!byHand.transactionId;
}, 30_000).catch(() => null);
await desk.tick();
const nowOpening = await openingToBuyer();
check(
  "the channel opened by hand is taken as the order's — with fees back to normal the lane opens no second one",
  nowOpening.length === 1 && nowOpening[0].transaction_id === hand.transaction_id && onDisk(byHand.id)?.fundingOutpoint === handOutpoint,
  `${nowOpening.length} opening, journal ${journalPhase(byHand.id)} ${onDisk(byHand.id)?.fundingOutpoint?.slice(0, 14) ?? "no outpoint"}…; ${(onDisk(byHand.id)?.events.map((e) => e.what).slice(-3).join(" | ") ?? "").slice(0, 260)}`,
);
check("and it is the one reported to Amboss", (byHand.transactionId ?? "").startsWith(hand.transaction_id), byHand.transactionId ?? `status ${byHand.status}`);
mine(3);
const handChannel = await until("the hand-opened channel active", async () => (await getChannels({ lnd: seller })).channels.find((c) => c.transaction_id === hand.transaction_id && c.is_active));
mine(6);
byHand.status = "VALID_CHANNEL_OPENING";
byHand.channelId = handChannel.id;
const handPay = pay({ lnd: buyer, request: byHand.paymentRequest ?? "", max_fee: 1_000 });
await until("the hand-opened order's payment settled", async () => {
  await desk.tick();
  return (await getInvoice({ lnd: seller, id: byHandHash })).is_confirmed;
}, 60_000).catch(() => null);
const handDone = await handPay.catch((err: unknown) => ({ failed: JSON.stringify(err).slice(0, 120) }));
check(
  "its payment is claimed and the sale booked, once",
  "is_confirmed" in handDone && handDone.is_confirmed === true && bookedFor(byHand.id) === 1 && journalPhase(byHand.id) === "settled",
  `${JSON.stringify(handDone).slice(0, 80)}; ${bookedFor(byHand.id)} booking(s), journal ${journalPhase(byHand.id)}`,
);

// ── the ceiling: an open dearer than the order brings ends the order ───────
// At the last moment to open fees are still 400 sat/vB: the order is ended
// instead of opened, our invoice cancelled, Amboss refunds the buyer. (Regtest
// has no clock to wait 42 hours by: Amboss's deadline is set 15 minutes out,
// which halves the window — its last moment to open is minutes away, inside
// the ten minutes no open is begun in. The wait through a 48-hour window is
// in magmaPrepaid.test.ts.)
const dear = order();
magma.buyerPaidAmboss(dear.id);
await desk.tick();
const dearHash = parsePaymentRequest(dear.paymentRequest ?? "").id;
check("the last order is accepted, our invoice unpaid", dear.status === "WAITING_FOR_CHANNEL_OPEN" && unpaid(await getInvoice({ lnd: seller, id: dearHash })), `${dear.status}, journal ${journalPhase(dear.id)}`);
dear.timeout = new Date(Date.now() + 15 * 60_000).toISOString();
wallet.estimateFee = (_args, cb) => cb(null, { sat_per_kw: String(400 * 250) });
const dearChainBefore = (await getChainBalance({ lnd: seller })).chain_balance;
await desk.tick();
await desk.tick();
wallet.estimateFee = realEstimate;
const dearEntry = onDisk(dear.id);
check(
  "at its last moment to open, with the open dearer than the sale earns, the order is ended instead of opened",
  dearEntry?.phase === "cancelled" &&
    /^on-chain fees are 400 sat\/vB: opening the channel would cost about 70,000 sat, more than the 60,000 sat this sale earns — ended at its last moment to open instead of opened/.test(dearEntry?.reason ?? ""),
  `${dearEntry?.phase}: ${(dearEntry?.reason ?? dearEntry?.lastError ?? "").slice(0, 240)}`,
);
check("its invoice is cancelled", (await getInvoice({ lnd: seller, id: dearHash })).is_canceled === true, JSON.stringify(await getInvoice({ lnd: seller, id: dearHash })).slice(0, 120));
await desk.tick();
// (An earlier order still waiting for its buyer's payment keeps its own.)
const dearReserved = () => capital.pending().filter((r) => r.key === `magma:${dear.id}`).length;
check(
  "nothing is opened to the buyer, no coins spent, nothing kept reserved for the order",
  (await openingToBuyer()).length === 0 && (await getChainBalance({ lnd: seller })).chain_balance === dearChainBefore && dearReserved() === 0,
  `${(await openingToBuyer()).length} opening, ${dearReserved()} reservation(s) of the order`,
);
check(
  "the refund is named, with both numbers",
  desk.refunds().some((r) => r.orderId === dear.id && /70,000 sat, more than the 60,000 sat/.test(r.reason ?? "")),
  JSON.stringify(desk.refunds().filter((r) => r.orderId === dear.id)).slice(0, 200),
);

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
