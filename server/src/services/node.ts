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

/** Per LND connection: a node's key never changes while it is connected. (One
 *  value for the whole process answered with the FIRST node's key for every
 *  later one — the Magma lane filters orders by this key, so that would have
 *  meant acting on another node's orders, or on none.) */
const cachedPubkeys = new WeakMap<AuthenticatedLnd, string>();

/** Our node's own public key (cached for the life of the LND connection). */
export async function getOwnPubkey(lnd: AuthenticatedLnd): Promise<string> {
  const cached = cachedPubkeys.get(lnd);
  if (cached) return cached;
  const pubkey = (await getWalletInfo({ lnd })).public_key;
  cachedPubkeys.set(lnd, pubkey);
  return pubkey;
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
