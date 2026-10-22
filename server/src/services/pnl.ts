import {
  getChainTransactions,
  getChannels,
  getClosedChannels,
  getPendingChannels,
  getWalletInfo,
  type AuthenticatedLnd,
} from "lightning";
import { getFlowSummary } from "./forwards.js";
import type { RebalanceLog } from "./rebalanceLog.js";
import type { EarningsLog } from "./earningsLog.js";
import type { ServiceFeeLedger } from "./serviceFee.js";
import type { MagmaPurchases } from "./magmaPurchases.js";
import { lightningPaymentFees, rebalanceCosts } from "./rebalanceCosts.js";
import { closeCostTxids, closeCostsFrom, closedFactsOf, walletTxsOf, type CloseCost, type WalletTx } from "./closeCosts.js";
import { closeSeeds, type CloseTxArchive } from "./closeTxArchive.js";

/**
 * Profit & loss over a window:
 *   revenue  = routing (forwarding) fees earned + lease income (Magma and
 *              LSPS1 sales)
 *   costs    = channel-open + channel-close on-chain fees + rebalancing fees
 *              + inbound bought on Magma + service fees paid out
 *   net      = revenue − costs
 *
 * Every cost comes from a ledger that keeps all of it (review a5/a8: P&L
 * offers 90 days, a year and "All", and capped logs lost the older costs):
 *  - opens: our funding transactions' fees, from the wallet;
 *  - closes: worked out from the closing transactions and sweeps themselves
 *    (closeCosts.ts) — LND reports no fee for them, so this read 0 for
 *    every node;
 *  - rebalancing: LND's payments to this node itself, whichever tool made
 *    them (rebalanceCosts.ts), with LightningMate's log for what LND no
 *    longer lists;
 *  - inbound bought on Magma: the purchase ledger — the invoice and the
 *    Lightning routing fee of every purchase whose channel opened
 *    (review a5-analytics:magma-buy-costs-missing: it was never counted);
 *  - the service fee: what the fee ledger actually paid, routing fee
 *    included.
 * Lease income comes from the earnings log (one record per completed sale).
 * What a figure can't see is said in `notes`.
 */
export interface PnlSummary {
  windowDays: number;
  routingRevenueSats: number;
  forwardCount: number;
  /** Gross lease income over the window: Magma and LSPS1 sales. */
  magmaRevenueSats: number;
  magmaSaleCount: number;
  rebalanceCostSats: number;
  rebalanceCount: number;
  /** "lnd": LND's payment history (every tool's rebalances); "log":
   *  LightningMate's own log only (LND couldn't be read). */
  rebalanceSource: "lnd" | "log";
  /** Of rebalanceCount, those LightningMate didn't make: from when its log
   *  covers rebalances on, with no record in it (another tool). */
  rebalanceNotLogged: number;
  /** Of rebalanceCount, those from before LightningMate's log began
   *  (rebalanceLogSince) — whose they were can't be told. */
  rebalanceBeforeLog: number;
  rebalanceLogSince: string | null;
  channelOpenCostSats: number;
  channelCloseCostSats: number;
  /** Channels whose close falls in the window … */
  channelCloseCount: number;
  /** … and those of them whose cost couldn't all be worked out. */
  channelCloseUnknownCount: number;
  /** Inbound bought on Magma (invoice + Lightning routing fee): purchases
   *  whose channel opened, counted in the window they were PAID in
   *  (purchaseCostsSince — by paidAt, not by when the channel opened). */
  inboundPurchaseCostSats: number;
  inboundPurchaseCount: number;
  otherChainFeesSats: number;
  /** The routing fees of the Lightning payments this node sent over the
   *  window — its own sends, not rebalances, Magma purchases or the service
   *  fee (each counted as its own cost). Shown apart, not counted in net:
   *  like otherChainFeesSats, a cost of spending, not of running the node. */
  lightningPaymentFeesSats: number;
  lightningPaymentCount: number;
  /** Service fees actually paid out over the window, incl. the routing fee to
   *  deliver them. */
  serviceFeePaidSats: number;
  totalCostSats: number;
  netProfitSats: number;
  /** What the figures can't see, in words. */
  notes: string[];
}

export interface PnlSources {
  rebalanceLog: RebalanceLog;
  earnings: Pick<EarningsLog, "recent">;
  serviceFees?: Pick<ServiceFeeLedger, "paidSince"> & Partial<Pick<ServiceFeeLedger, "entries">>;
  purchases?: Pick<MagmaPurchases, "paidCosts"> & Partial<Pick<MagmaPurchases, "list">>;
  /** LightningMate's copy of the close transactions LND's wallet forgets
   *  at a restart (closeTxArchive.ts). */
  closeTxs?: Pick<CloseTxArchive, "update">;
}

/** On-chain costs over a window: opens, closes and other sends. */
export interface ChainCosts {
  openCostSats: number;
  closeCostSats: number;
  closeCount: number;
  closeUnknownCount: number;
  /** Why closes in the window have an unknown part (distinct reasons). */
  closeUnknownReasons: string[];
  otherChainFeesSats: number;
}

/** Where on-chain costs are worked out from — read once, for any window. */
export interface ChainFacts {
  txs: WalletTx[];
  fundingTxids: Set<string>;
  closes: CloseCost[];
}

/** The wallet, the channels and their closes, read once for any window.
 *  With `closeTxs`, the close transactions the wallet has forgotten since
 *  (a commitment, at LND's restart) come from LightningMate's own copy — and
 *  what the wallet holds of them now is copied there. */
export async function readChainFacts(lnd: AuthenticatedLnd, nowMs = Date.now(), closeTxs?: Pick<CloseTxArchive, "update">): Promise<ChainFacts> {
  const [chain, channels, pending, closed, height] = await Promise.all([
    getChainTransactions({ lnd }),
    getChannels({ lnd }),
    getPendingChannels({ lnd }).catch(() => ({ pending_channels: [] })),
    getClosedChannels({ lnd }),
    getWalletInfo({ lnd })
      .then((w) => w.current_block_height)
      .catch(() => null),
  ]);
  const closedFacts = closedFactsOf(closed.channels);
  const walletTxs = walletTxsOf(chain.transactions);
  const txs = closeTxs ? closeTxs.update(walletTxs, closeSeeds(closedFacts, pending.pending_channels)) : walletTxs;
  const fundingTxids = new Set<string>();
  for (const c of channels.channels) fundingTxids.add(c.transaction_id);
  // Every pending channel's funding: one still opening, and one already
  // closing (waiting for its close to confirm, or force closing for up to two
  // weeks) — its open cost stays an open cost meanwhile, never an "other
  // on-chain fee" left out of net until LND lists the channel as closed.
  for (const p of pending.pending_channels) fundingTxids.add(p.transaction_id);
  for (const c of closed.channels) fundingTxids.add(c.transaction_id);
  const closes = closeCostsFrom(closedFacts, txs, { nowMs, height });
  return { txs, fundingTxids, closes };
}

/** Undated closes (no wallet record, no height) count only in a window that
 *  reaches back before 1970 — "All". */
const closedAtMs = (c: CloseCost): number => (c.closedAt ? Date.parse(c.closedAt) : 0);

export function chainCostsSince(facts: ChainFacts, cutoff: number): ChainCosts {
  const closeTxs = closeCostTxids(facts.closes);
  let openCostSats = 0;
  let otherChainFeesSats = 0;
  for (const tx of facts.txs) {
    if (!tx.isOutgoing || !tx.isConfirmed || !tx.fee) continue;
    if (Date.parse(tx.createdAt) < cutoff) continue;
    if (facts.fundingTxids.has(tx.id)) openCostSats += tx.fee;
    else if (!closeTxs.has(tx.id)) otherChainFeesSats += tx.fee;
  }
  let closeCostSats = 0;
  for (const c of facts.closes) for (const f of c.fees) if (Date.parse(f.at) >= cutoff) closeCostSats += f.sats;
  const inWindow = facts.closes.filter((c) => closedAtMs(c) >= cutoff);
  const unknown = inWindow.filter((c) => c.unknown !== null);
  return {
    openCostSats,
    closeCostSats,
    closeCount: inWindow.length,
    closeUnknownCount: unknown.length,
    closeUnknownReasons: [...new Set(unknown.map((c) => c.unknown as string))],
    otherChainFeesSats,
  };
}

/** What inbound bought on Magma cost over a window: purchases paid in it. */
export function purchaseCostsSince(purchases: Pick<MagmaPurchases, "paidCosts"> | undefined, cutoff: number): { sats: number; count: number } {
  const inWindow = (purchases?.paidCosts() ?? []).filter((p) => Date.parse(p.at) >= cutoff);
  return { sats: inWindow.reduce((s, p) => s + p.feeSats + p.routingFeeSats, 0), count: inWindow.length };
}

export async function getPnl(lnd: AuthenticatedLnd, src: PnlSources, windowDays: number, nowMs = Date.now()): Promise<PnlSummary> {
  const cutoff = nowMs - windowDays * 86_400_000;

  // Payments P&L counts under their own cost: a Magma purchase's invoice
  // (inbound bought) and a service fee — not again as a Lightning send.
  const counted = new Set<string>([
    ...(src.purchases?.list?.() ?? []).map((p) => p.paymentHash),
    ...(src.serviceFees?.entries?.() ?? []).flatMap((e) => (e.paymentHash ? [e.paymentHash] : [])),
  ]);
  const [flows, facts, rebalancing, sends] = await Promise.all([
    getFlowSummary(lnd, windowDays),
    readChainFacts(lnd, nowMs, src.closeTxs),
    rebalanceCosts(lnd, src.rebalanceLog, cutoff, nowMs),
    lightningPaymentFees(lnd, cutoff, counted, nowMs),
  ]);
  const chain = chainCostsSince(facts, cutoff);
  const bought = purchaseCostsSince(src.purchases, cutoff);

  const saleRecords = src.earnings.recent().filter((s) => new Date(s.at).getTime() >= cutoff);
  const magmaRevenueSats = saleRecords.reduce((sum, s) => sum + (s.leaseSats ?? 0), 0);
  // Older sales paid the fee inline and stored it on the sale record; newer
  // ones are paid by the ledger. Both count, neither twice (new records carry
  // no feePaidSats).
  const legacyFeeSats = saleRecords.reduce((sum, s) => sum + (s.feePaidSats ?? 0), 0);
  const ledgerFeeSats = (src.serviceFees?.paidSince(cutoff) ?? []).reduce((sum, f) => sum + f.paidSats + f.routingFeeSats, 0);
  const serviceFeePaidSats = legacyFeeSats + ledgerFeeSats;

  const routingRevenueSats = flows.totalFeesEarnedSats;
  const totalCostSats = chain.openCostSats + chain.closeCostSats + rebalancing.feeSats + bought.sats + serviceFeePaidSats;

  const notes: string[] = [];
  if (chain.closeUnknownCount > 0) {
    notes.push(
      `${chain.closeUnknownCount} of ${chain.closeCount} close${chain.closeCount === 1 ? "" : "s"} in this window: cost partly unknown — ` +
        chain.closeUnknownReasons.join("; "),
    );
  }
  if (rebalancing.note) notes.push(rebalancing.note);
  // LND hands forwards over oldest first: a read cut short misses the newest.
  if (flows.complete === false) notes.push("Routing revenue: only the first 100,000 forwards of this window were read — the most recent are missing");
  if (sends === null) notes.push("The routing fees of Lightning payments sent couldn't be read from LND");

  return {
    windowDays,
    routingRevenueSats,
    forwardCount: flows.totalForwards,
    magmaRevenueSats,
    magmaSaleCount: saleRecords.length,
    rebalanceCostSats: rebalancing.feeSats,
    rebalanceCount: rebalancing.count,
    rebalanceSource: rebalancing.source,
    rebalanceNotLogged: rebalancing.notLogged,
    rebalanceBeforeLog: rebalancing.beforeLog,
    rebalanceLogSince: rebalancing.logTrackedSince,
    channelOpenCostSats: chain.openCostSats,
    channelCloseCostSats: chain.closeCostSats,
    channelCloseCount: chain.closeCount,
    channelCloseUnknownCount: chain.closeUnknownCount,
    inboundPurchaseCostSats: bought.sats,
    inboundPurchaseCount: bought.count,
    otherChainFeesSats: chain.otherChainFeesSats,
    lightningPaymentFeesSats: sends?.feeSats ?? 0,
    lightningPaymentCount: sends?.count ?? 0,
    serviceFeePaidSats,
    totalCostSats,
    netProfitSats: routingRevenueSats + magmaRevenueSats - totalCostSats,
    notes,
  };
}
