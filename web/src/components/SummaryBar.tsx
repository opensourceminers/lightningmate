import type { NodeSummary, PriceInfo } from "../types";
import { fiat, sats } from "../format";

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function SummaryBar({ node, price }: { node: NodeSummary; price?: PriceInfo | null }) {
  const { balances } = node;
  const lnTotal = balances.localSats + balances.inboundSats;
  const outboundPct = lnTotal > 0 ? (balances.localSats / lnTotal) * 100 : 0;
  const inFiat = (s: number) =>
    price ? fiat(s, price.btcPrice, price.currency) ?? undefined : undefined;

  return (
    <section className="summary">
      <div className="summary-head">
        <span className="node-dot" style={{ background: node.color || "#f7931a" }} />
        <div>
          <h1>{node.alias || "Lightning Node"}</h1>
          <code className="pubkey">{node.pubkey}</code>
        </div>
        <div className={`sync ${node.syncedToChain ? "ok" : "warn"}`}>
          {node.syncedToChain ? "● synced" : "○ syncing"} · block {node.blockHeight}
        </div>
      </div>

      <div className="stats">
        <Stat
          label="Channels"
          value={String(node.activeChannelsCount)}
          sub={node.pendingChannelsCount ? `${node.pendingChannelsCount} pending` : "active"}
        />
        <Stat label="Peers" value={String(node.peersCount)} />
        <Stat label="Local (outbound)" value={`${sats(balances.localSats)} sat`} sub={inFiat(balances.localSats)} />
        <Stat label="Inbound" value={`${sats(balances.inboundSats)} sat`} sub={inFiat(balances.inboundSats)} />
        <Stat
          label="On-chain"
          value={`${sats(balances.onchainConfirmedSats)} sat`}
          sub={
            balances.onchainPendingSats
              ? `+${sats(balances.onchainPendingSats)} pending`
              : inFiat(balances.onchainConfirmedSats)
          }
        />
      </div>

      <div className="liquidity-bar" title={`${outboundPct.toFixed(0)}% outbound`}>
        <div className="liquidity-out" style={{ width: `${outboundPct}%` }} />
      </div>
      <div className="liquidity-legend">
        <span>◀ outbound {sats(balances.localSats)}</span>
        <span>inbound {sats(balances.inboundSats)} ▶</span>
      </div>
    </section>
  );
}
