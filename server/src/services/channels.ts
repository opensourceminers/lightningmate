import { getChannels, getPendingChannels, type AuthenticatedLnd } from "lightning";
import { getAlias } from "./aliases.js";

export type ChannelRole = "source" | "sink" | "router";

/** "open" = live channel; "pending_close" = a close that hasn't confirmed yet. */
export type ChannelStatus = "open" | "pending_close";

export interface ChannelView {
  id: string;
  peerPubkey: string;
  peerAlias: string;
  active: boolean;
  private: boolean;
  initiator: "local" | "remote";
  capacity: number;
  transactionId: string;
  transactionVout: number;
  localBalance: number;
  remoteBalance: number;
  /** local / (local + remote), 0..1 — the spendable outbound share. */
  localRatio: number;
  totalSent: number;
  totalReceived: number;
  unsettled: number;
  status: ChannelStatus;
  /** Force-close in progress: blocks until time-locked funds are spendable. */
  timelockBlocks?: number;
  /**
   * Heuristic classification from lifetime flow:
   *  - source: mostly receives (drains inbound) → keep fees low
   *  - sink:   mostly sends (drains outbound)   → raise fees
   *  - router: balanced two-way flow
   */
  role: ChannelRole;
}

function classify(sent: number, received: number): ChannelRole {
  const total = sent + received;
  if (total === 0) return "router";
  const sentShare = sent / total;
  if (sentShare >= 0.7) return "sink";
  if (sentShare <= 0.3) return "source";
  return "router";
}

export async function getChannelsView(
  lnd: AuthenticatedLnd,
): Promise<ChannelView[]> {
  const [{ channels }, pending] = await Promise.all([
    getChannels({ lnd }),
    getPendingChannels({ lnd }).catch(() => ({ pending_channels: [] })),
  ]);

  const views = await Promise.all(
    channels.map(async (c): Promise<ChannelView> => {
      const capacity = c.capacity;
      // Split of *settled* funds, ignoring the commit-fee reserve which otherwise
      // keeps the ratio from ever reaching 0/1.
      const settled = c.local_balance + c.remote_balance;
      return {
        id: c.id,
        peerPubkey: c.partner_public_key,
        peerAlias: await getAlias(lnd, c.partner_public_key),
        active: c.is_active,
        private: c.is_private,
        initiator: c.is_partner_initiated ? "remote" : "local",
        capacity,
        transactionId: c.transaction_id,
        transactionVout: c.transaction_vout,
        localBalance: c.local_balance,
        remoteBalance: c.remote_balance,
        localRatio: settled > 0 ? c.local_balance / settled : 0,
        totalSent: c.sent,
        totalReceived: c.received,
        unsettled: c.unsettled_balance,
        status: "open",
        role: classify(c.sent, c.received),
      };
    }),
  );

  // Channels mid-close stay visible as "pending close" until the close confirms.
  const closing = await Promise.all(
    pending.pending_channels
      .filter((p) => p.is_closing)
      .map(async (p): Promise<ChannelView> => {
        const settled = p.local_balance + p.remote_balance;
        return {
          id: `${p.transaction_id}:${p.transaction_vout}`,
          peerPubkey: p.partner_public_key,
          peerAlias: await getAlias(lnd, p.partner_public_key),
          active: false,
          private: false,
          initiator: p.is_partner_initiated ? "remote" : "local",
          capacity: p.capacity,
          transactionId: p.transaction_id,
          transactionVout: p.transaction_vout,
          localBalance: p.local_balance,
          remoteBalance: p.remote_balance,
          localRatio: settled > 0 ? p.local_balance / settled : 0,
          totalSent: p.sent,
          totalReceived: p.received,
          unsettled: 0,
          status: "pending_close",
          timelockBlocks: p.timelock_blocks,
          role: classify(p.sent, p.received),
        };
      }),
  );

  const all = [...views, ...closing];
  // Biggest channels first — that's usually where the action is.
  all.sort((a, b) => b.capacity - a.capacity);
  return all;
}
