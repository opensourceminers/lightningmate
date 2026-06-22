import { useEffect, useState } from "react";
import { api } from "../api";
import type { PnlSummary } from "../types";
import { sats } from "../format";

const WINDOWS: { label: string; days: number }[] = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: 36_500 },
];

function signed(value: number): string {
  const s = sats(Math.abs(value));
  return value < 0 ? `−${s}` : `+${s}`;
}

function Item({ label, value, kind }: { label: string; value: number; kind: "rev" | "cost" }) {
  return (
    <div className="pnl-item">
      <span className="pnl-item-dot" data-kind={kind} />
      <span className="pnl-item-label">{label}</span>
      <span className={`pnl-item-val ${kind}`}>{signed(value)} sat</span>
    </div>
  );
}

export function PnlOverview() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<PnlSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .pnl(days)
      .then((p) => !cancelled && (setData(p), setError(null)))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [days]);

  const net = data?.netProfitSats ?? 0;
  const max = data ? Math.max(1, data.routingRevenueSats, data.totalCostSats) : 1;

  return (
    <section className="pnl">
      <div className="pnl-head">
        <h3>Profit &amp; Loss</h3>
        <div className="pnl-windows">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              className={`pnl-win ${days === w.days ? "active" : ""}`}
              onClick={() => setDays(w.days)}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error ? <p className="banner error">{error}</p> : null}

      {data ? (
        <>
          <div className="pnl-grid">
            <div className={`pnl-net ${net >= 0 ? "pos" : "neg"}`}>
              <div className="pnl-net-label">Net profit</div>
              <div className="pnl-net-value">{signed(net)} sat</div>
              <div className="pnl-net-sub">
                {data.forwardCount} forwards · {data.rebalanceCount} rebalances
              </div>
            </div>

            <div className="pnl-items">
              <Item label="Routing revenue" value={data.routingRevenueSats} kind="rev" />
              <Item label="Channel opens" value={-data.channelOpenCostSats} kind="cost" />
              <Item label="Rebalancing" value={-data.rebalanceCostSats} kind="cost" />
              <Item label="Channel closes" value={-data.channelCloseCostSats} kind="cost" />
            </div>
          </div>

          <div className="pnl-bars">
            <div className="pnl-bar-row">
              <span className="pnl-bar-tag">revenue</span>
              <div className="pnl-track">
                <div
                  className="pnl-fill rev"
                  style={{ width: `${(data.routingRevenueSats / max) * 100}%` }}
                />
              </div>
            </div>
            <div className="pnl-bar-row">
              <span className="pnl-bar-tag">costs</span>
              <div className="pnl-track">
                <div
                  className="pnl-fill cost"
                  style={{ width: `${(data.totalCostSats / max) * 100}%` }}
                />
              </div>
            </div>
          </div>

          {data.otherChainFeesSats > 0 ? (
            <p className="pnl-foot muted">
              + {sats(data.otherChainFeesSats)} sat other on-chain fees (sends), not counted in net
            </p>
          ) : null}
        </>
      ) : (
        <p className="muted empty">Loading P&amp;L…</p>
      )}
    </section>
  );
}
