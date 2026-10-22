import { useEffect, useState } from "react";
import { api } from "../api";
import { pageHidden } from "../usePolledData";
import type { BuyOffer, BuyOffersResponse, OrderState } from "../types";
import { satsCompact } from "../format";
import { Scanning } from "./Scanning";
import { EmptyState } from "./Skeleton";
import { useUi } from "./Overlay";
import { buyConfirmMessage } from "../magmaView";

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/**
 * Buying inbound on Magma: the offers ranked for THIS node at the size it
 * wants — what each really costs per year of lease (Amboss's fee included),
 * whether this node may buy from it at all (the seller's buyer conditions),
 * and the routing-fee promise that makes the inbound usable. A pick buys the
 * size chosen; declining the quote cancels the order on Amboss; the purchase
 * is recorded on the node and followed until its channel opens.
 */
export function MarketBuy() {
  const ui = useUi();
  const [data, setData] = useState<BuyOffersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [sizeText, setSizeText] = useState("2000000");
  const [usd, setUsd] = useState(10);
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderState, setOrderState] = useState<OrderState | null>(null);
  /** The offer the user picked. None: Amboss matches a seller for a dollar amount. */
  const [pick, setPick] = useState<BuyOffer | null>(null);

  const size = Math.max(0, Math.floor(Number(sizeText) || 0));

  const load = async (sizeSats = size) => {
    setLoading(true);
    setError(null);
    try {
      const [ranked, status] = await Promise.all([api.ambossBuyOffers(sizeSats || 2_000_000), api.ambossStatus()]);
      setData(ranked);
      setConnected(status.connected);
      if (pick) setPick(ranked.offers.find((o) => o.offerId === pick.offerId) ?? null);
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
      // (Not in a background tab — the server follows the purchase itself.)
      if (pageHidden()) return;
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
    if (!pick && cents < 500) {
      setBuyError("Minimum is $5.");
      return;
    }
    if (pick && !pick.fits) {
      setBuyError(`This offer sells ${fmt(pick.minSizeSats)}–${fmt(Math.min(pick.maxSizeSats, pick.availableSats))} sat — choose a size in that range.`);
      return;
    }
    setBusy(true);
    try {
      const q = await api.ambossBuyQuote(cents, isPrivate, pick ? { offerId: pick.offerId, sizeSats: size } : undefined);
      const ok = await ui.confirm({
        title: "Confirm liquidity purchase",
        message: buyConfirmMessage(q, pick),
        confirmLabel: `Pay ${q.sats.toLocaleString()} sat`,
        danger: true,
      });
      if (!ok) {
        // Declined: the order Amboss created must not stay live.
        const c = await api.ambossBuyCancel(q.orderId).catch((e: unknown) => ({ cancelled: false, message: e instanceof Error ? e.message : String(e) }));
        ui.toast(c.cancelled ? "Not bought — the order was cancelled on Amboss." : `Not bought. ${c.message}`, c.cancelled ? "info" : "error");
        return;
      }
      await api.ambossBuyPay(q.orderId, q.sats);
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
  const estInbound = data?.inboundSatsPerUsd ? Math.round(usd * data.inboundSatsPerUsd) : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Buy inbound <span className="muted">· Amboss Magma</span>
        </h2>
        {data?.inboundSatsPerUsd ? <span className="muted">≈ {satsCompact(data.inboundSatsPerUsd)} sat of inbound per $1 (market rate)</span> : null}
      </div>

      <div className="dryrun-banner">
        Buy inbound liquidity: a seller opens a channel to your node for a one-time lease fee.{" "}
        {connected ? (
          <>Pick an offer and a size — or let Amboss pick a seller for a dollar amount. You confirm the exact fee before paying.</>
        ) : (
          <>
            Browsing is open to everyone. To buy, add your Amboss API key in <strong>Settings</strong>.
          </>
        )}
      </div>

      <div className="buy-box">
        <label className="policy-field inline" title="The channel size the offers below are priced at — and what a pick buys">
          <span>Channel size (sat)</span>
          <input type="number" min={20_000} step={100_000} value={sizeText} onChange={(e) => setSizeText(e.target.value)} />
        </label>
        <button className="row-btn" disabled={loading} onClick={() => void load(size)}>
          Rank at this size
        </button>
        {connected ? (
          <>
            {!pick ? (
              <label className="policy-field inline" title="Amboss matches a seller for this amount">
                <span>…or spend (USD)</span>
                <input type="number" min={5} step={5} value={usd} onChange={(e) => setUsd(Math.max(0, Number(e.target.value) || 0))} />
              </label>
            ) : null}
            <label className="check" title="unannounced channel">
              <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
              private
            </label>
            {!pick && estInbound ? <span className="muted">≈ {satsCompact(estInbound)} of inbound at the market rate</span> : null}
            {pick ? (
              <div className="muted reason">
                Buying {fmt(size)} sat from <code>{pick.sellerPubkey.slice(0, 14)}…</code> for {pick.leaseDays} days ·{" "}
                {fmt(pick.totalFeeSats)} sat.{" "}
                <button className="link-btn" onClick={() => setPick(null)}>
                  clear
                </button>
              </div>
            ) : null}
            <button className="primary-btn" disabled={busy || (!pick && usd < 5)} onClick={() => void buy()}>
              {busy ? "Working…" : "Buy inbound"}
            </button>
            <span className="open-warn">⚠ real on-chain channel</span>
          </>
        ) : null}
      </div>
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
                : orderState?.payment?.state === "unclear"
                  ? " (payment unclear — checking with your node)…"
                  : "…"}
            </span>
          )}
          <span className="muted"> · followed on Market → Orders → Purchases</span>
        </div>
      ) : null}

      {loading ? <Scanning label="LOADING THE MARKETPLACE" /> : null}
      {error ? <p className="banner error">{error}</p> : null}

      {!loading && !error && offers.length === 0 ? <EmptyState icon="🛒">No offers on the marketplace right now.</EmptyState> : null}

      {offers.length > 0 ? (
        <>
          <table className="fee-table">
            <thead>
              <tr>
                <th>Seller</th>
                <th className="num">Score</th>
                <th className="num">Lease</th>
                <th className="num">Sizes</th>
                <th className="num" title="Seller's fee + Amboss's fee, at your size">Total fee</th>
                <th className="num" title="Total fee per year of guaranteed lease — compares leases of different lengths">Cost / yr</th>
                <th className="num" title="The routing fee the seller promises to keep for the lease">Fee promise</th>
                <th>You can buy?</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {offers.map((o) => {
                const blocked = o.conditions.filter((c) => c.pass === false);
                const unknown = o.conditions.filter((c) => c.pass === null);
                return (
                  <tr key={o.offerId} className={o.eligible === false ? "inactive" : ""}>
                    <td title={o.sellerPubkey}>
                      <code>{o.sellerPubkey.slice(0, 14)}…</code>
                    </td>
                    <td className="num">{o.sellerScore.toFixed(1)}</td>
                    <td className="num" title={`${o.leaseBlocks} blocks`}>
                      {o.leaseDays}d
                    </td>
                    <td className="num" title={`${fmt(o.availableSats)} sat available`}>
                      {satsCompact(o.minSizeSats)}–{satsCompact(Math.min(o.maxSizeSats, o.availableSats))}
                      {o.fits ? "" : " ⚠"}
                    </td>
                    <td
                      className="num strong"
                      title={`at ${fmt(o.sizeSats)} sat: seller ${fmt(o.sellerFeeSats)} (${o.feeRatePpm} ppm + ${o.baseFeeSats} base)${o.ambossFeeSats !== null ? ` + Amboss ${fmt(o.ambossFeeSats)}` : " (Amboss fee unknown)"}`}
                    >
                      {fmt(o.totalFeeSats)}
                    </td>
                    <td className="num">{(o.costPpmPerYear / 10_000).toFixed(2)}%</td>
                    <td className="num">{o.feeRateCapPpm ? `≤ ${o.feeRateCapPpm} ppm` : "none"}</td>
                    <td title={o.conditions.map((c) => `${c.pass === false ? "✗" : c.pass === null ? "?" : "✓"} ${c.text}`).join("\n")}>
                      {o.eligible === false ? `✗ ${blocked[0]?.text ?? ""}` : o.eligible === null ? `? ${unknown[0]?.text ?? ""}` : "✓"}
                    </td>
                    <td>
                      <button
                        className="row-btn"
                        disabled={busy || !connected || o.eligible === false}
                        title={
                          !connected
                            ? "Connect Amboss in Settings first"
                            : o.eligible === false
                              ? "This seller doesn't sell to a node like yours"
                              : "Buy from this seller specifically, at the size above"
                        }
                        onClick={() => setPick(pick?.offerId === o.offerId ? null : o)}
                      >
                        {pick?.offerId === o.offerId ? "Picked" : "Pick"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted reason">
            Ranked for your node at {fmt(data?.sizeSats ?? size)} sat: offers you can buy from first, then those that sell this size,
            then those that promise a routing-fee cap (without one, the inbound is only as useful as the seller's fees allow), then by
            cost per year of guaranteed lease — a 180-day lease can cost more up front and still be cheaper per year. Totals include
            Amboss's own fee, which it charges by order size.{" "}
            {pick ? "You picked a seller, so the order goes to them." : "Without a pick, Amboss chooses the seller for you — the ranking is then only advice."}
          </p>
        </>
      ) : null}
    </section>
  );
}
