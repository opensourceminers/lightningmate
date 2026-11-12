/**
 * LSP mode (LSPS1 / bLIP-51) against real LND nodes on regtest — the money
 * path of docs/E2E-TESTING.md part B, with the buyer's wallet played by
 * the `buyer` node speaking LSPS0 over BOLT8 custom messages (type 37913),
 * as ZEUS's embedded node does. What only a real ZEUS shows (its screens,
 * its Tor round trips, its polling) stays part B's manual run.
 *
 * Run (after `bash server/e2e/regtest.sh up`, with REGTEST_BITCOIN_CLI set):
 *   cd server && node --import tsx e2e/lsps.ts
 *
 * It checks, in order: get_info and a quote; a token refused (102) and a
 * lease too long refused (100); the buyer pays, the channel is opened to it
 * with the order's tag and the payment claimed once the funding is out,
 * booked once; a buyer that pays and goes offline is opened for when it
 * comes back, at the fee rate of then; one whose open would cost more than
 * the order brings waits, and is opened once fees are down; one that stays
 * away past the six hours is refunded (its payment comes back); a quote not
 * paid is withdrawn when LSP mode is switched off (its invoice cancelled in
 * LND); and at very high fees a channel is refused, not quoted below cost.
 */
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addPeer,
  createChainAddress,
  getChainBalance,
  getChannels,
  getInvoice,
  getPendingChannels,
  getRouteToDestination,
  getWalletInfo,
  openChannel,
  pay,
  removePeer,
  sendMessageToPeer,
  subscribeToPeerMessages,
  type AuthenticatedLnd,
} from "lightning";
import { CapitalLedger } from "../src/services/capital.js";
import { EarningsLog } from "../src/services/earningsLog.js";
import { HELD_WAIT_MS, LSPS0_MESSAGE_TYPE, Lsps1Service, type Lsps1Order } from "../src/services/lsps1.js";
import { ServiceFeeLedger } from "../src/services/serviceFee.js";
import { SettingsStore } from "../src/services/settings.js";
import { installFetchMock } from "../test/helpers/fetchMock.js";
import { parsePaymentRequest } from "../test/helpers/bolt11.js";
import { NODES, connect } from "./regtest.js";

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

// ── the network: buyer → hub → seller, so the buyer can pay the LSP ─────────
async function fund(lnd: AuthenticatedLnd, btcAmount: number): Promise<void> {
  const { address } = await createChainAddress({ lnd });
  btc(`-rpcwallet=miner sendtoaddress ${address} ${btcAmount}`);
}
await fund(seller, 0.2);
await fund(hub, 0.1);
await fund(buyer, 0.1);
mine(2);
await until("wallets funded", async () => (await getChainBalance({ lnd: seller })).chain_balance > 0 && (await getChainBalance({ lnd: hub })).chain_balance > 0 && (await getChainBalance({ lnd: buyer })).chain_balance > 0);
await addPeer({ lnd: hub, public_key: sellerKey, socket: `127.0.0.1:${NODES.seller.p2p}` });
await addPeer({ lnd: buyer, public_key: hubKey, socket: `127.0.0.1:${NODES.hub.p2p}` });
await openChannel({ lnd: hub, partner_public_key: sellerKey, local_tokens: 5_000_000 });
await openChannel({ lnd: buyer, partner_public_key: hubKey, local_tokens: 3_000_000 });
await until("funding in the mempool", async () => {
  mine(1);
  return (await getPendingChannels({ lnd: hub })).pending_channels.length === 0;
});
mine(8);
await until("both channels active", async () => (await getChannels({ lnd: hub })).channels.filter((c) => c.is_active).length === 2);
mine(4);
await until("the buyer's graph reaches the seller", async () => (await getRouteToDestination({ lnd: buyer, destination: sellerKey, tokens: 100_000 })).route);
console.log("network up (buyer → hub → seller)");

// ── LightningMate's LSP mode on the seller ──────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "lm-e2e-lsps-"));
const cleanups: (() => void)[] = [];
// No Amboss here: every market read is answered 502 and the quote is the
// local profit floor. (Nothing leaves this machine.)
installFetchMock({ after: (fn: () => void) => void cleanups.push(fn) }).on(/amboss\./, () => new Response("no Amboss on regtest", { status: 502 }));
const settings = new SettingsStore(dir);
settings.set({ lspModeEnabled: true });
const capital = new CapitalLedger();
const earnings = new EarningsLog(dir);
const svc = new Lsps1Service(
  dir,
  seller,
  seller,
  settings,
  () => ({ maxChannelSats: 5_000_000, reserveSats: 50_000, maxDeploySats: 20_000_000 }),
  () => ({ sellPricingMode: "balanced", adaptiveLevel: 0.5, offerFeeCaps: null }),
  () => "",
  earnings,
  new ServiceFeeLedger(dir, null),
  undefined,
  capital,
);
const inner = svc as unknown as { orders: Lsps1Order[]; openRetryDelayMs: number; pricingCache: unknown; chainCache: unknown };
inner.openRetryDelayMs = 2_000;
svc.start();
const orderOf = (id: string) => inner.orders.find((o) => o.orderId === id);

// The seller's fee estimate, as LND gives it — or one a scene sets.
const wallet = (seller as unknown as { wallet: { estimateFee: (args: unknown, cb: (err: unknown, res?: { sat_per_kw: string }) => void) => void } }).wallet;
const realEstimate = wallet.estimateFee;
const estimateAt = (satPerVbyte: number) => {
  wallet.estimateFee = (_args, cb) => cb(null, { sat_per_kw: String(satPerVbyte * 250) });
  inner.pricingCache = undefined;
};

// ── the buyer's wallet: LSPS0 over BOLT8 custom messages ────────────────────
const replies = new Map<string, unknown>();
const sub = subscribeToPeerMessages({ lnd: buyer });
sub.on("message_received", (m: { public_key: string; type: number; message: string }) => {
  if (m.public_key !== sellerKey || m.type !== LSPS0_MESSAGE_TYPE) return;
  try {
    const body = JSON.parse(Buffer.from(m.message, "hex").toString("utf8")) as { id?: string };
    if (typeof body.id === "string") replies.set(body.id, body);
  } catch {
    // not JSON: not ours
  }
});
sub.on("error", () => undefined);
let nextId = 1;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function rpc(method: string, params?: unknown): Promise<any> {
  const id = `e2e-${nextId++}`;
  const message = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }), "utf8").toString("hex");
  await sendMessageToPeer({ lnd: buyer, public_key: sellerKey, type: LSPS0_MESSAGE_TYPE, message });
  return until(`the answer to ${method}`, async () => replies.get(id), 30_000);
}
const orderParams = (o: Record<string, unknown> = {}) => ({
  lsp_balance_sat: "1000000",
  client_balance_sat: "0",
  required_channel_confirmations: 1,
  funding_confirms_within_blocks: 6,
  channel_expiry_blocks: 4_320,
  token: "",
  refund_onchain_address: "",
  announce_channel: false,
  ...o,
});
/** A quote, or the script stops with the LSP's answer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function quoteFor(params: Record<string, unknown> = {}): Promise<any> {
  const res = await rpc("lsps1.create_order", orderParams(params));
  if (!res.result) throw new Error(`create_order refused: ${JSON.stringify(res.error)}`);
  return res.result;
}
/** Blocks mined after an open: the change confirmed in the seller's wallet,
 *  and LSP mode reading it afresh (its balance read lives 30 s). */
async function settled(): Promise<void> {
  mine(3);
  await until("the seller's change confirmed", async () => (await getChainBalance({ lnd: seller })).chain_balance > 5_000_000 && (await getWalletInfo({ lnd: seller })).is_synced_to_chain);
  inner.chainCache = undefined;
}
const connectBuyer = () => addPeer({ lnd: buyer, public_key: sellerKey, socket: `127.0.0.1:${NODES.seller.p2p}` });
const pendingToBuyer = async () => (await getPendingChannels({ lnd: seller })).pending_channels.filter((c) => c.partner_public_key === buyerKey && c.is_opening);
await connectBuyer();
await until("the buyer is the seller's peer", async () => (await rpc("lsps0.list_protocols")).result?.protocols?.includes(1));

// ── get_info, a quote, two refusals ─────────────────────────────────────────
const info = (await rpc("lsps1.get_info")).result;
check("get_info answers with the offer (strings, the 1M minimum)", info?.min_initial_lsp_balance_sat === "1000000" && Number(info?.max_initial_lsp_balance_sat) >= 1_000_000, JSON.stringify(info).slice(0, 160));
const coupon = await rpc("lsps1.create_order", orderParams({ token: "PROMO" }));
check("a token this LSP never issued is refused with error 102", coupon.error?.code === 102, JSON.stringify(coupon.error));
const tooLong = await rpc("lsps1.create_order", orderParams({ channel_expiry_blocks: 26_280 }));
check("a lease too long is refused with error 100, naming the property", tooLong.error?.code === 100 && tooLong.error?.data?.property === "channel_expiry_blocks", JSON.stringify(tooLong.error).slice(0, 160));

// ── a whole buy ─────────────────────────────────────────────────────────────
const first = (await rpc("lsps1.create_order", orderParams())).result;
const firstHash = parsePaymentRequest(first?.payment?.bolt11?.invoice ?? "").id;
check("create_order quotes a hold invoice for the fee", first?.order_state === "CREATED" && first?.payment?.bolt11?.state === "EXPECT_PAYMENT" && Number(first?.payment?.bolt11?.fee_total_sat) > 0, `fee ${first?.payment?.bolt11?.fee_total_sat} sat`);
const firstPay = pay({ lnd: buyer, request: first.payment.bolt11.invoice, max_fee: 1_000 });
const firstPending = await until("the order's channel pending", async () => (await pendingToBuyer())[0]);
const opened = await until("the order completed", async () => (orderOf(first.order_id)?.orderState === "COMPLETED" ? orderOf(first.order_id) : null));
check(
  "paid: the channel is opened to the buyer, 1M on the seller's side, and the order records its outpoint",
  firstPending.capacity === 1_000_000 && opened?.channel?.fundingOutpoint === `${firstPending.transaction_id}:${firstPending.transaction_vout}`,
  `${firstPending.capacity} sat, ${opened?.channel?.fundingOutpoint?.slice(0, 16)}…`,
);
const firstDone = await firstPay.catch((err: unknown) => ({ failed: JSON.stringify(err).slice(0, 120) }));
check("the payment is claimed once the funding is out", "is_confirmed" in firstDone && firstDone.is_confirmed === true && (await getInvoice({ lnd: seller, id: firstHash })).is_confirmed, JSON.stringify(firstDone).slice(0, 100));
const got = (await rpc("lsps1.get_order", { order_id: first.order_id })).result;
check("get_order: COMPLETED, PAID, with the channel", got?.order_state === "COMPLETED" && got?.payment?.bolt11?.state === "PAID" && !!got?.channel?.funding_outpoint, JSON.stringify(got?.channel ?? null));
check("booked once", earnings.recent().filter((e) => e.orderId === first.order_id).length === 1, `${earnings.recent().length} booking(s)`);
check("no coins kept reserved for it", capital.reservedSat() === 0, `${capital.reservedSat()} sat`);
await settled();
await until("the first channel active", async () => (await getChannels({ lnd: seller })).channels.some((c) => c.partner_public_key === buyerKey && c.is_active));

// ── the buyer pays and goes offline; back later, at a higher fee rate ──────
estimateAt(3);
const away = await quoteFor();
const awayHash = parsePaymentRequest(away.payment.bolt11.invoice).id;
const awayFee = Number(away.payment.bolt11.fee_total_sat);
await removePeer({ lnd: buyer, public_key: sellerKey }).catch(() => undefined);
const awayPay = pay({ lnd: buyer, request: away.payment.bolt11.invoice, max_fee: 1_000 });
await until("the payment held", async () => (await getInvoice({ lnd: seller, id: awayHash })).is_held);
await until("the order waits for the buyer", async () => !!orderOf(away.order_id)?.waitingForBuyerSince, 30_000);
check("a buyer offline after paying is waited for, its payment held", (await pendingToBuyer()).length === 0 && orderOf(away.order_id)?.paymentState === "HOLD");
// Back online, with opening and closing above what the order brings: it waits.
const dear = Math.ceil(awayFee / 325) + 20;
estimateAt(dear);
await connectBuyer();
await until("the fee wait on the order", async () => /^on-chain fees rose since the quote/.test(orderOf(away.order_id)?.error ?? ""), 30_000);
check("back online with fees above what the order brings: not opened — the order says why, the payment stays held", (await pendingToBuyer()).length === 0 && (await getInvoice({ lnd: seller, id: awayHash })).is_held === true, orderOf(away.order_id)?.error?.slice(0, 140));
// Fees fall to 5: opened at 5 — not at the 3 of when it was paid.
estimateAt(5);
const awayPending = await until("the channel opened once fees are down", async () => (await pendingToBuyer())[0], 60_000);
await until("the second order completed", async () => orderOf(away.order_id)?.orderState === "COMPLETED");
const awayDone = await awayPay.catch((err: unknown) => ({ failed: JSON.stringify(err).slice(0, 120) }));
check("opened once fees are down, and the payment claimed", !!awayPending && "is_confirmed" in awayDone && awayDone.is_confirmed === true);
// The funding transaction's own rate, as bitcoind has it in its mempool.
const entry = JSON.parse(btc(`getmempoolentry ${awayPending.transaction_id}`)) as { vsize: number; fees: { base: number } };
const fundedAt = (entry.fees.base * 1e8) / entry.vsize;
check("funded at the rate of then (5 sat/vB), not the 3 of when it was paid", fundedAt >= 4.5 && fundedAt < 6, `${fundedAt.toFixed(2)} sat/vB`);
wallet.estimateFee = realEstimate;
await settled();

// ── the buyer stays away past the six hours: refunded ───────────────────────
const gone = await quoteFor();
const goneHash = parsePaymentRequest(gone.payment.bolt11.invoice).id;
await removePeer({ lnd: buyer, public_key: sellerKey }).catch(() => undefined);
const gonePay = pay({ lnd: buyer, request: gone.payment.bolt11.invoice, max_fee: 1_000 });
await until("the third payment held", async () => (await getInvoice({ lnd: seller, id: goneHash })).is_held);
await until("the third order waits", async () => !!orderOf(gone.order_id)?.waitingForBuyerSince, 30_000);
check("while it waits, its size is reserved in the shared capital", capital.reservedSat() === 1_000_000, `${capital.reservedSat()} sat`);
// Six hours on by the clock (the HTLC would allow far more).
const goneOrder = orderOf(gone.order_id)!;
goneOrder.heldAt = new Date(Date.now() - HELD_WAIT_MS - 60_000).toISOString();
await until("refunded", async () => orderOf(gone.order_id)?.orderState === "FAILED", 30_000);
const goneDone = await gonePay.then(
  () => "paid",
  (err: unknown) => `refused: ${JSON.stringify(err).slice(0, 80)}`,
);
check(
  "six hours after the payment the buyer is refunded — its payment comes back, the capital is free, nothing opened",
  goneDone.startsWith("refused") && (await getInvoice({ lnd: seller, id: goneHash })).is_canceled === true && capital.reservedSat() === 0 && (await pendingToBuyer()).length === 0,
  `${goneDone}; ${orderOf(gone.order_id)?.error?.slice(0, 120)}`,
);
await connectBuyer();
await until("the buyer back", async () => (await rpc("lsps0.list_protocols")).result);

// ── switched off: an unpaid quote is withdrawn ──────────────────────────────
const quote = await quoteFor();
const quoteHash = parsePaymentRequest(quote.payment.bolt11.invoice).id;
settings.set({ lspModeEnabled: false });
svc.applySettings();
await until("the quote withdrawn", async () => (await getInvoice({ lnd: seller, id: quoteHash })).is_canceled, 30_000);
check("LSP mode switched off withdraws the unpaid quote: its invoice is cancelled in LND", orderOf(quote.order_id)?.orderState === "FAILED", orderOf(quote.order_id)?.error);
settings.set({ lspModeEnabled: true });
svc.applySettings();

// ── at very high fees a channel is refused, not quoted below cost ──────────
estimateAt(400);
await until("listening again", async () => (await rpc("lsps0.list_protocols")).result);
const spike = await rpc("lsps1.create_order", orderParams());
check("at 400 sat/vB a 1M channel is refused (code 1), not quoted below its open and close cost", spike.error?.code === 1 && /is above the most it ever asks for one right now/.test(spike.error?.data?.message ?? ""), JSON.stringify(spike.error).slice(0, 160));
wallet.estimateFee = realEstimate;

// ── done ────────────────────────────────────────────────────────────────────
sub.removeAllListeners();
svc.stop();
for (const fn of cleanups) {
  try {
    fn();
  } catch (err) {
    console.log(`after: ${String(err).slice(0, 200)}`);
  }
}
console.log(failed ? `${failed} check(s) FAILED` : "all checks passed");
process.exit(failed ? 1 : 0);
