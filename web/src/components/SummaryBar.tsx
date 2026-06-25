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
  const inboundPct = 100 - outboundPct;
  const inFiat = (s: number) =>
    price ? fiat(s, price.btcPrice, price.currency) ?? undefined : undefined;
  const outFiat = inFiat(balances.localSats);
  const inbFiat = inFiat(balances.inboundSats);
  const skew = Math.abs(outboundPct - 50);
  const balanceLabel = lnTotal === 0 ? "no liquidity" : skew <= 10 ? "well balanced" : skew <= 25 ? "slightly skewed" : outboundPct > 50 ? "outbound-heavy" : "inbound-heavy";

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

      <div className="liquidity">
        <div className="liq-labels">
          <div className="liq-side out">
            <span className="liq-cap"><span className="liq-dot" />Outbound · can send</span>
            <span className="liq-amt">{sats(balances.localSats)} <span className="liq-unit">sat</span></span>
            {outFiat ? <span className="liq-fiat">{outFiat}</span> : null}
          </div>
          <span className={`liq-balance s-${skew <= 10 ? "good" : skew <= 25 ? "ok" : "warn"}`}>{balanceLabel}</span>
          <div className="liq-side in">
            <span className="liq-cap">Inbound · can receive<span className="liq-dot" /></span>
            <span className="liq-amt">{sats(balances.inboundSats)} <span className="liq-unit">sat</span></span>
            {inbFiat ? <span className="liq-fiat">{inbFiat}</span> : null}
          </div>
        </div>
        <div className="liq-bar" title={`${outboundPct.toFixed(0)}% outbound · ${inboundPct.toFixed(0)}% inbound`}>
          <div className="liq-out" style={{ width: `${outboundPct}%` }}>
            {outboundPct >= 12 ? <span>{Math.round(outboundPct)}%</span> : null}
          </div>
          <div className="liq-in">
            {inboundPct >= 12 ? <span>{Math.round(inboundPct)}%</span> : null}
          </div>
          <span className="liq-mid" />
        </div>
      </div>
    </section>
  );
}
