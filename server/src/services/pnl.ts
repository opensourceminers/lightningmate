import {
  getChainTransactions,
  getChannels,
  getClosedChannels,
  type AuthenticatedLnd,
} from "lightning";
import { getFlowSummary } from "./forwards.js";
import type { RebalanceLog } from "./rebalanceLog.js";
import type { EarningsLog } from "./earningsLog.js";
import type { ServiceFeeLedger } from "./serviceFee.js";

/**
 * Profit & loss over a window:
 *   revenue  = routing (forwarding) fees earned + Magma lease income
 *   costs    = channel-open + channel-close on-chain fees + rebalancing fees
 *              + Magma service fees we paid out
 *   net      = revenue − costs
 *
 * On-chain fees are attributed by matching our chain transactions against the
 * funding/closing txids of our channels — a tx only shows a fee we paid if we
 * created it, so opens/closes we didn't initiate don't get counted. Lease income
 * comes from the earnings log (one record per completed sale); the service fee
 * comes from the service-fee ledger, which records what was ACTUALLY paid and
 * when (it is paid asynchronously, after the sale).
 */
export interface PnlSummary {
  windowDays: number;
  routingRevenueSats: number;
  forwardCount: number;
  /** Gross Magma lease income over the window. */
  magmaRevenueSats: number;
  magmaSaleCount: number;
  rebalanceCostSats: number;
  rebalanceCount: number;
  channelOpenCostSats: number;
  channelCloseCostSats: number;
  otherChainFeesSats: number;
  /** Service fees actually paid out over the window, incl. the routing fee to
   *  deliver them. */
  serviceFeePaidSats: number;
  totalCostSats: number;
  netProfitSats: number;
}

export async function getPnl(
  lnd: AuthenticatedLnd,
  rebalanceLog: RebalanceLog,
  earnings: EarningsLog,
  windowDays: number,
  serviceFees?: Pick<ServiceFeeLedger, "paidSince">,
): Promise<PnlSummary> {
  const cutoff = Date.now() - windowDays * 86_400_000;

  const [flows, chain, channels, closed] = await Promise.all([
    getFlowSummary(lnd, windowDays),
    getChainTransactions({ lnd }),
    getChannels({ lnd }),
    getClosedChannels({ lnd }),
  ]);

  const fundingTxids = new Set<string>();
  for (const c of channels.channels) fundingTxids.add(c.transaction_id);
  for (const c of closed.channels) fundingTxids.add(c.transaction_id);

  const closeTxids = new Set<string>();
  for (const c of closed.channels) {
    if (c.close_transaction_id) closeTxids.add(c.close_transaction_id);
  }

  let channelOpenCostSats = 0;
  let channelCloseCostSats = 0;
  let otherChainFeesSats = 0;
  for (const tx of chain.transactions) {
    if (!tx.is_outgoing || !tx.is_confirmed || !tx.fee) continue;
    if (new Date(tx.created_at).getTime() < cutoff) continue;
    if (fundingTxids.has(tx.id)) channelOpenCostSats += tx.fee;
    else if (closeTxids.has(tx.id)) channelCloseCostSats += tx.fee;
    else otherChainFeesSats += tx.fee;
  }

  const rebRecords = rebalanceLog
    .recent(500)
    .filter((r) => r.ok && new Date(r.at).getTime() >= cutoff);
  const rebalanceCostSats = rebRecords.reduce((sum, r) => sum + (r.feeSats ?? 0), 0);

  const saleRecords = earnings.recent().filter((s) => new Date(s.at).getTime() >= cutoff);
  const magmaRevenueSats = saleRecords.reduce((sum, s) => sum + (s.leaseSats ?? 0), 0);
  // Older sales paid the fee inline and stored it on the sale record; newer
  // ones are paid by the ledger. Both count, neither twice (new records carry
  // no feePaidSats).
  const legacyFeeSats = saleRecords.reduce((sum, s) => sum + (s.feePaidSats ?? 0), 0);
  const ledgerFeeSats = (serviceFees?.paidSince(cutoff) ?? []).reduce(
    (sum, f) => sum + f.paidSats + f.routingFeeSats,
    0,
  );
  const serviceFeePaidSats = legacyFeeSats + ledgerFeeSats;

  const routingRevenueSats = flows.totalFeesEarnedSats;
  const totalCostSats =
    channelOpenCostSats + channelCloseCostSats + rebalanceCostSats + serviceFeePaidSats;

  return {
    windowDays,
    routingRevenueSats,
    forwardCount: flows.totalForwards,
    magmaRevenueSats,
    magmaSaleCount: saleRecords.length,
    rebalanceCostSats,
    rebalanceCount: rebRecords.length,
    channelOpenCostSats,
    channelCloseCostSats,
    otherChainFeesSats,
    serviceFeePaidSats,
    totalCostSats,
    netProfitSats: routingRevenueSats + magmaRevenueSats - totalCostSats,
  };
}
