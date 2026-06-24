import { useEffect, useState } from "react";
import { api } from "../api";
import type { MarketView } from "../types";
import { satsCompact } from "../format";
import { Scanning } from "./Scanning";
import { EmptyState } from "./Skeleton";

export function MarketPanel() {
  const [data, setData] = useState<MarketView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [market, status] = await Promise.all([api.ambossMarket(), api.ambossStatus()]);
      setData(market);
      setConnected(status.connected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const offers = data?.offers ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Liquidity market <span className="muted">· Amboss Magma</span>
        </h2>
        {data?.satsPerUsd ? (
          <span className="muted">≈ {satsCompact(Math.round(data.satsPerUsd))} sat inbound / $1</span>
        ) : null}
      </div>

      <div className="dryrun-banner">
        Buy inbound liquidity from the Amboss Magma marketplace — a seller opens a channel
        to your node for a one-time lease fee.{" "}
        {connected ? (
          <>Amboss is connected; buying lands in the next update.</>
        ) : (
          <>
            Browsing is open to everyone. To buy, add your Amboss API key in{" "}
            <strong>Settings</strong>.
          </>
        )}
      </div>

      {loading ? <Scanning label="LOADING THE MARKETPLACE" /> : null}
      {error ? <p className="banner error">{error}</p> : null}

      {!loading && !error && offers.length === 0 ? (
        <EmptyState icon="🛒">No offers on the marketplace right now.</EmptyState>
      ) : null}

      {offers.length > 0 ? (
        <>
          <table className="fee-table">
            <thead>
              <tr>
                <th className="num">Score</th>
                <th>Seller</th>
                <th className="num">Size range</th>
                <th className="num">Available</th>
                <th className="num">Fee rate</th>
                <th className="num">Base fee</th>
                <th className="num">From*</th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => {
                const cost = o.baseFeeSats + Math.round((o.minSizeSats * o.feeRatePpm) / 1_000_000);
                return (
                  <tr key={o.id}>
                    <td className="num strong">{o.sellerScore.toFixed(1)}</td>
                    <td title={o.sellerPubkey}>
                      <code>{o.sellerPubkey.slice(0, 14)}…</code>
                    </td>
                    <td className="num">
                      {satsCompact(o.minSizeSats)}–{satsCompact(o.maxSizeSats)}
                    </td>
                    <td className="num">{satsCompact(o.availableSats)}</td>
                    <td className="num">{o.feeRatePpm} ppm</td>
                    <td className="num">{o.baseFeeSats}</td>
                    <td className="num strong">{satsCompact(cost)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted reason">
            * one-time lease fee for the smallest channel (base + size × rate). The seller sets
            routing fees on the channel afterwards. Score is Amboss’ seller-reliability rating.
          </p>
        </>
      ) : null}
    </section>
  );
}
