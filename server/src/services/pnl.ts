import {
  getChainTransactions,
  getChannels,
  getClosedChannels,
  type AuthenticatedLnd,
} from "lightning";
import { getFlowSummary } from "./forwards.js";
import type { RebalanceLog } from "./rebalanceLog.js";

/**
 * Profit & loss over a window:
 *   revenue  = routing (forwarding) fees earned
 *   costs    = channel-open on-chain fees + channel-close on-chain fees + rebalancing fees
 *   net      = revenue − costs
 *
 * On-chain fees are attributed by matching our chain transactions against the
 * funding/closing txids of our channels — a tx only shows a fee we paid if we
 * created it, so opens/closes we didn't initiate don't get counted.
 */
export interface PnlSummary {
  windowDays: number;
  routingRevenueSats: number;
  forwardCount: number;
  rebalanceCostSats: number;
  rebalanceCount: number;
  channelOpenCostSats: number;
  channelCloseCostSats: number;
  otherChainFeesSats: number;
  totalCostSats: number;
  netProfitSats: number;
}

export async function getPnl(
  lnd: AuthenticatedLnd,
  rebalanceLog: RebalanceLog,
  windowDays: number,
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

  const routingRevenueSats = flows.totalFeesEarnedSats;
  const totalCostSats = channelOpenCostSats + channelCloseCostSats + rebalanceCostSats;

  return {
    windowDays,
    routingRevenueSats,
    forwardCount: flows.totalForwards,
    rebalanceCostSats,
    rebalanceCount: rebRecords.length,
    channelOpenCostSats,
    channelCloseCostSats,
    otherChainFeesSats,
    totalCostSats,
    netProfitSats: routingRevenueSats - totalCostSats,
  };
}
