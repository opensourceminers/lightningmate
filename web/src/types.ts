// Mirrors the server's response shapes (server/src/services/*).

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
    localSats: number;
    inboundSats: number;
    onchainConfirmedSats: number;
    onchainPendingSats: number;
  };
}

export type ChannelRole = "source" | "sink" | "router";

export interface ChannelView {
  id: string;
  peerPubkey: string;
  peerAlias: string;
  active: boolean;
  private: boolean;
  initiator: "local" | "remote";
  capacity: number;
  localBalance: number;
  remoteBalance: number;
  localRatio: number;
  totalSent: number;
  totalReceived: number;
  unsettled: number;
  role: ChannelRole;
}

export interface ChannelFlow {
  channelId: string;
  routedOut: number;
  routedIn: number;
  feesEarned: number;
  forwardCount: number;
}

export interface ForwardEvent {
  createdAt: string;
  incomingChannel: string;
  outgoingChannel: string;
  tokens: number;
  fee: number;
}

export interface FlowSummary {
  windowDays: number;
  totalForwards: number;
  totalRoutedSats: number;
  totalFeesEarnedSats: number;
  perChannel: ChannelFlow[];
  recent: ForwardEvent[];
}
