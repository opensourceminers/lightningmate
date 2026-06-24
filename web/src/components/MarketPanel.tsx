import { useEffect, useState } from "react";
import { api } from "../api";
import type { MarketView, OrderState } from "../types";
import { satsCompact } from "../format";
import { Scanning } from "./Scanning";
import { EmptyState } from "./Skeleton";
import { useUi } from "./Overlay";

export function MarketPanel() {
  const ui = useUi();
  const [data, setData] = useState<MarketView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  // Buy flow
  const [usd, setUsd] = useState(10);
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderState, setOrderState] = useState<OrderState | null>(null);

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

  // Poll the order until the channel opens or it fails (Amboss is the truth).
  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    let iv: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      try {
        const s = await api.ambossOrder(orderId);
        if (!alive) return;
        setOrderState(s);
        if (s.done || s.failed) {
          if (iv) clearInterval(iv);
          if (s.done) ui.toast("✓ Channel opening!", "success");
        }
      } catch {
        // keep polling
      }
    };
    void tick();
    iv = setInterval(() => void tick(), 5000);
    return () => {
      alive = false;
      if (iv) clearInterval(iv);
    };
  }, [orderId, ui]);

  const buy = async () => {
    setBuyError(null);
    const cents = Math.round(usd * 100);
    if (cents < 500) {
      setBuyError("Minimum is $5.");
      return;
    }
    setBusy(true);
    try {
      const q = await api.ambossBuyQuote(cents, isPrivate);
      const ok = await ui.confirm({
        title: "Confirm liquidity purchase",
        message:
          `Pay a one-time ${q.sats.toLocaleString()} sat fee for a ~${satsCompact(q.channelSizeSats)} ` +
          `inbound channel? A seller opens the channel to your node. This is a real Lightning payment.`,
        confirmLabel: `Pay ${q.sats.toLocaleString()} sat`,
        danger: true,
      });
      if (!ok) {
        setBusy(false);
        return;
      }
      await api.ambossBuyPay(q.orderId, q.paymentRequest, q.sats);
      setOrderState(null);
      setOrderId(q.orderId);
      ui.toast("Payment sent — waiting for the seller to open the channel…", "info");
    } catch (e) {
      setBuyError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const offers = data?.offers ?? [];
  const estInbound = data?.satsPerUsd ? Math.round(usd * data.satsPerUsd) : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Liquidity market <span className="muted">· Amboss Magma</span>
        </h2>
        {data?.satsPerUsd ? (
          <span className="muted">≈ {satsCompact(Math.round(data.satsPerUsd))} sat / $1</span>
        ) : null}
      </div>

      <div className="dryrun-banner">
        Buy inbound liquidity from the Amboss Magma marketplace — a seller opens a channel to your
        node for a one-time lease fee.{" "}
        {connected ? (
          <>Pick an amount; Amboss matches a top-scored seller and you confirm the exact fee.</>
        ) : (
          <>
            Browsing is open to everyone. To buy, add your Amboss API key in <strong>Settings</strong>.
          </>
        )}
      </div>

      {connected ? (
        <div className="buy-box">
          <label className="policy-field inline">
            <span>Spend (USD)</span>
            <input
              type="number"
              min={5}
              step={5}
              value={usd}
              onChange={(e) => setUsd(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
          <label className="check" title="unannounced channel">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            private
          </label>
          {estInbound ? <span className="muted">≈ {satsCompact(estInbound)} of value</span> : null}
          <button className="primary-btn" disabled={busy || usd < 5} onClick={() => void buy()}>
            {busy ? "Working…" : "Buy inbound"}
          </button>
          <span className="open-warn">⚠ real on-chain channel</span>
        </div>
      ) : null}
      {buyError ? <p className="banner error">{buyError}</p> : null}

      {orderId ? (
        <div className="buy-status">
          {orderState?.done ? (
            <span className="open-ok">
              ✓ Channel opening — {satsCompact(orderState.channelSizeSats)} inbound
              {orderState.channelId ? ` (${orderState.channelId})` : ""}
            </span>
          ) : orderState?.failed ? (
            <span className="ap-fail">
              ✗ {orderState.status}
              {orderState.payment?.error ? ` — payment: ${orderState.payment.error}` : ""}
            </span>
          ) : (
            <span className="muted">
              Order {orderId.slice(0, 8)}… — {orderState?.status ?? "starting"}
              {orderState?.payment?.state === "failed"
                ? ` (payment failed: ${orderState.payment.error ?? "unknown"})`
                : "…"}
            </span>
          )}
        </div>
      ) : null}

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
