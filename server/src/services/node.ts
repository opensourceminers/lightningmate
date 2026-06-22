import {
  getChainBalance,
  getChannelBalance,
  getPendingChainBalance,
  getWalletInfo,
  type AuthenticatedLnd,
} from "lightning";

export interface NodeSummary {
  alias: string;
  pubkey: string;
  color: string;
  version: string;
  syncedToChain: boolean;
  syncedToGraph: boolean;
  blockHeight: number;
  peersCount: number;
  activeChannelsCount: number;
  pendingChannelsCount: number;
  balances: {
    /** Total local (outbound) balance across channels, in sats. */
    localSats: number;
    /** Total inbound (receivable) liquidity, in sats, if reported. */
    inboundSats: number;
    /** Confirmed on-chain wallet balance, in sats. */
    onchainConfirmedSats: number;
    /** Unconfirmed on-chain balance, in sats. */
    onchainPendingSats: number;
  };
}

export async function getNodeSummary(lnd: AuthenticatedLnd): Promise<NodeSummary> {
  const [info, channelBalance, chainBalance, pendingChain] = await Promise.all([
    getWalletInfo({ lnd }),
    getChannelBalance({ lnd }),
    getChainBalance({ lnd }),
    getPendingChainBalance({ lnd }),
  ]);

  return {
    alias: info.alias,
    pubkey: info.public_key,
    color: info.color,
    version: info.version,
    syncedToChain: info.is_synced_to_chain,
    syncedToGraph: info.is_synced_to_graph ?? true,
    blockHeight: info.current_block_height,
    peersCount: info.peers_count,
    activeChannelsCount: info.active_channels_count,
    pendingChannelsCount: info.pending_channels_count,
    balances: {
      localSats: channelBalance.channel_balance,
      inboundSats: channelBalance.inbound ?? 0,
      onchainConfirmedSats: chainBalance.chain_balance,
      onchainPendingSats: pendingChain.pending_chain_balance,
    },
  };
}
