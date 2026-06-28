import { useEffect, useState } from "react";
import { api } from "../api";
import type { PnlSummary, PriceInfo } from "../types";
import { fiat, sats } from "../format";
import { useCountUp } from "../useCountUp";
import { Skeleton } from "./Skeleton";

const WINDOWS: { label: string; days: number }[] = [
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
  { label: "All", days: 36_500 },
];

const signed = (v: number): string => (v < 0 ? `−${sats(Math.abs(v))}` : `+${sats(v)}`);

export function PnlOverview({ price }: { price?: PriceInfo | null }) {
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
  const animatedNet = useCountUp(net);

  const routing = data?.routingRevenueSats ?? 0;
  const magma = data?.magmaRevenueSats ?? 0;
  const revenue = routing + magma;
  const opens = data?.channelOpenCostSats ?? 0;
  const rebal = data?.rebalanceCostSats ?? 0;
  const closes = data?.channelCloseCostSats ?? 0;
  const svcFee = data?.serviceFeePaidSats ?? 0;
  const totalCost = data?.totalCostSats ?? 0;
  const max = Math.max(1, revenue, totalCost);
  const pct = (v: number) => `${(v / max) * 100}%`;
  const margin = revenue > 0 ? Math.round((net / revenue) * 100) : null;
  const winLabel = data ? (data.windowDays >= 36_500 ? "all time" : `${data.windowDays}d`) : "";
  const netFiat = data && price ? fiat(net, price.btcPrice, price.currency) : null;

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
          <div className="pnl-hero">
            <div className="pnl-hero-left">
              <div className="pnl-net-label">Net profit · {winLabel}</div>
              <div className={`pnl-net-value ${net >= 0 ? "pos" : "neg"}`}>
                {signed(Math.round(animatedNet))} <span className="pnl-unit">sat</span>
              </div>
              {netFiat ? <div className="pnl-net-fiat">≈ {netFiat}</div> : null}
            </div>
            <div className="pnl-hero-right">
              {margin !== null ? (
                <span className={`pnl-margin ${net >= 0 ? "pos" : "neg"}`}>
                  {margin >= 0 ? "+" : "−"}
                  {Math.abs(margin)}% margin
                </span>
              ) : null}
              <span className="pnl-meta">{data.forwardCount} forwards</span>
              <span className="pnl-meta">{data.rebalanceCount} rebalances</span>
            </div>
          </div>

          <div className="pnl-bars">
            <div className="pnl-bar-row">
              <span className="pnl-bar-tag">Revenue</span>
              <div className="pnl-track">
                <div className="pnl-seg rev" style={{ width: pct(routing) }} title={`Routing · ${sats(routing)} sat`} />
                <div className="pnl-seg rev-magma" style={{ width: pct(magma) }} title={`Magma leases · ${sats(magma)} sat`} />
              </div>
              <span className="pnl-bar-val rev">{signed(revenue)}</span>
            </div>
            <div className="pnl-bar-row">
              <span className="pnl-bar-tag">Costs</span>
              <div className="pnl-track">
                <div className="pnl-seg c-open" style={{ width: pct(opens) }} title={`Channel opens · ${sats(opens)} sat`} />
                <div className="pnl-seg c-rebal" style={{ width: pct(rebal) }} title={`Rebalancing · ${sats(rebal)} sat`} />
                <div className="pnl-seg c-close" style={{ width: pct(closes) }} title={`Channel closes · ${sats(closes)} sat`} />
                <div className="pnl-seg c-fee" style={{ width: pct(svcFee) }} title={`Magma service fee · ${sats(svcFee)} sat`} />
              </div>
              <span className="pnl-bar-val cost">{totalCost > 0 ? `−${sats(totalCost)}` : "0"}</span>
            </div>
          </div>

          <div className="pnl-legend">
            <span className="pnl-leg"><i className="pnl-d rev" />Routing<b>{sats(routing)}</b></span>
            {magma > 0 ? <span className="pnl-leg"><i className="pnl-d rev-magma" />Magma<b>{sats(magma)}</b></span> : null}
            <span className="pnl-leg"><i className="pnl-d c-open" />Opens<b>{sats(opens)}</b></span>
            <span className="pnl-leg"><i className="pnl-d c-rebal" />Rebalance<b>{sats(rebal)}</b></span>
            <span className="pnl-leg"><i className="pnl-d c-close" />Closes<b>{sats(closes)}</b></span>
            {svcFee > 0 ? <span className="pnl-leg"><i className="pnl-d c-fee" />Fee<b>{sats(svcFee)}</b></span> : null}
          </div>

          {data.otherChainFeesSats > 0 ? (
            <p className="pnl-foot muted">
              + {sats(data.otherChainFeesSats)} sat other on-chain fees (sends), not counted in net
            </p>
          ) : null}
        </>
      ) : error ? null : (
        <>
          <div className="pnl-hero">
            <div className="pnl-hero-left">
              <Skeleton width={90} height={11} />
              <div style={{ height: 8 }} />
              <Skeleton width={170} height={32} />
              <div style={{ height: 8 }} />
              <Skeleton width={110} height={11} />
            </div>
          </div>
          <div className="pnl-bars">
            {Array.from({ length: 2 }).map((_, i) => (
              <div className="pnl-bar-row" key={i}>
                <Skeleton width={56} height={11} />
                <div style={{ flex: 1 }}>
                  <Skeleton height={9} radius={6} />
                </div>
                <Skeleton width={60} height={11} />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
