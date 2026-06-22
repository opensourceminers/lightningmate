import { getChannels, type AuthenticatedLnd } from "lightning";
import { getAlias } from "./aliases.js";

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
  /** local / capacity, 0..1 — how full the outbound side is. */
  localRatio: number;
  totalSent: number;
  totalReceived: number;
  unsettled: number;
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
  const { channels } = await getChannels({ lnd });

  const views = await Promise.all(
    channels.map(async (c): Promise<ChannelView> => {
      const capacity = c.capacity;
      return {
        id: c.id,
        peerPubkey: c.partner_public_key,
        peerAlias: await getAlias(lnd, c.partner_public_key),
        active: c.is_active,
        private: c.is_private,
        initiator: c.is_partner_initiated ? "remote" : "local",
        capacity,
        localBalance: c.local_balance,
        remoteBalance: c.remote_balance,
        localRatio: capacity > 0 ? c.local_balance / capacity : 0,
        totalSent: c.sent,
        totalReceived: c.received,
        unsettled: c.unsettled_balance,
        role: classify(c.sent, c.received),
      };
    }),
  );

  // Biggest channels first — that's usually where the action is.
  views.sort((a, b) => b.capacity - a.capacity);
  return views;
}
