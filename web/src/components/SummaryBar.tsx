import { useState } from "react";
import type { NodeSummary, PriceInfo } from "../types";
import { COPY_FAILED, copyText } from "../clipboard";
import { useUi } from "./Overlay";
import { fiat, sats } from "../format";

function Stat({ label, value, sub, dot, big }: { label: string; value: string; sub?: string; dot?: "out" | "in"; big?: boolean }) {
  return (
    <div className={`stat ${big ? "stat-main" : ""}`}>
      <div className="stat-label">
        {dot ? <span className={`liq-dot ${dot}`} /> : null}
        {label}
      </div>
      <div className="stat-value">
        {value} <span className="stat-unit">sat</span>
      </div>
      <div className="stat-sub">{sub ?? " "}</div>
    </div>
  );
}

/** The top of the start page: whose node, what it holds, how that is split. */
export function SummaryBar({ node, price }: { node: NodeSummary; price?: PriceInfo | null }) {
  const [copied, setCopied] = useState(false);
  const [wholeKey, setWholeKey] = useState(false);
  const { toast } = useUi();
  const { balances } = node;
  const lnTotal = balances.localSats + balances.inboundSats;
  const outboundPct = lnTotal > 0 ? (balances.localSats / lnTotal) * 100 : 0;
  const inboundPct = 100 - outboundPct;
  const inFiat = (s: number) => (price ? (fiat(s, price.btcPrice, price.currency) ?? undefined) : undefined);
  const skew = Math.abs(outboundPct - 50);
  const balanceLabel =
    lnTotal === 0 ? "no liquidity" : skew <= 10 ? "well balanced" : skew <= 25 ? "slightly skewed" : outboundPct > 50 ? "mostly outbound" : "mostly inbound";
  // What is yours: your side of the channels and the on-chain wallet.
  const own = balances.localSats + balances.onchainConfirmedSats;

  const copyKey = async () => {
    if (await copyText(node.pubkey)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      setWholeKey(true);
      toast(COPY_FAILED, "error");
    }
  };

  return (
    <section className="summary">
      <div className="summary-head">
        <span className="node-dot" style={{ background: node.color || "#f7931a" }} />
        <div className="summary-id">
          <h1>{node.alias || "Lightning Node"}</h1>
          <button type="button" className="pubkey" title={`${node.pubkey} · click to copy`} onClick={() => void copyKey()}>
            {copied ? "copied" : wholeKey ? node.pubkey : `${node.pubkey.slice(0, 12)}…${node.pubkey.slice(-8)}`}
          </button>
        </div>
        <div className="summary-chips">
          <span className="chip">
            <b>{node.activeChannelsCount}</b> channels{node.pendingChannelsCount ? ` · ${node.pendingChannelsCount} pending` : ""}
          </span>
          <span className="chip">
            <b>{node.peersCount}</b> peers
          </span>
          <span className={`chip sync ${node.syncedToChain ? "ok" : "warn"}`}>
            {node.syncedToChain ? "● synced" : "○ syncing"} · {node.blockHeight.toLocaleString("en-US")}
          </span>
        </div>
      </div>

      <div className="stats">
        <Stat big label="Your balance" value={sats(own)} sub={inFiat(own)} />
        <Stat dot="out" label="You can send" value={sats(balances.localSats)} sub={inFiat(balances.localSats)} />
        <Stat dot="in" label="You can receive" value={sats(balances.inboundSats)} sub={inFiat(balances.inboundSats)} />
        <Stat
          label="On-chain wallet"
          value={sats(balances.onchainConfirmedSats)}
          sub={balances.onchainPendingSats ? `+${sats(balances.onchainPendingSats)} pending` : inFiat(balances.onchainConfirmedSats)}
        />
      </div>

      <div className="liquidity">
        <div className="liq-bar" title={`${outboundPct.toFixed(0)}% on your side · ${inboundPct.toFixed(0)}% on theirs`}>
          <div className="liq-out" style={{ width: `${outboundPct}%` }} />
          <div className="liq-in" />
          <span className="liq-mid" />
        </div>
        <div className="liq-labels">
          <span>{Math.round(outboundPct)}% your side</span>
          <span className={`liq-balance s-${skew <= 10 ? "good" : skew <= 25 ? "ok" : "warn"}`}>{balanceLabel}</span>
          <span>{Math.round(inboundPct)}% their side</span>
        </div>
      </div>
    </section>
  );
}
