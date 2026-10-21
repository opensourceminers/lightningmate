import { useEffect, useState } from "react";
import { api } from "../api";
import type { LspOrder, MagmaPurchase, MagmaV2Report, MyOrder, MyOrdersView } from "../types";
import { sats, satsCompact } from "../format";
import { EmptyState } from "./Skeleton";
import { useUi } from "./Overlay";
import { awaitsYourDecision, laneBanner } from "../statusNotes";
import { localLabel, purchaseLabel } from "../magmaView";

/** Why the order is where it is: the reason, the lane's last decision, or the
 *  last error — whichever applies (shown on hover). */
function localDetail(o: MyOrder): string | undefined {
  const l = o.local;
  if (!l) return undefined;
  return l.lastError ?? l.reason ?? l.decision?.reason ?? undefined;
}

/** Human status for a direct (LSPS1) sale — order + payment state in one word. */
function lspStatusLabel(o: LspOrder): string {
  if (o.orderState === "COMPLETED") return "Completed";
  if (o.orderState === "FAILED") {
    return o.paymentState === "REFUNDED" ? "Failed · refunded" : "Expired";
  }
  return o.paymentState === "HOLD" ? "Paid · opening channel" : "Awaiting payment";
}

export function MarketOrders() {
  const ui = useUi();
  const [data, setData] = useState<MyOrdersView | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rec, setRec] = useState<MagmaV2Report | null>(null);
  const [lspOrders, setLspOrders] = useState<LspOrder[]>([]);
  const [purchases, setPurchases] = useState<MagmaPurchase[]>([]);
  const [ordersInFlight, setOrdersInFlight] = useState(0);

  const load = async () => {
    // Direct LSPS1 sales and Magma purchases are on this node — shown
    // regardless of the Amboss connection.
    api.lspOrders().then((r) => setLspOrders(r.orders)).catch(() => {});
    api.ambossPurchases().then((r) => setPurchases(r.purchases)).catch(() => {});
    let conn = false;
    try {
      const s = await api.ambossStatus();
      conn = s.connected;
      setConnected(s.connected);
      setOrdersInFlight(s.ordersInFlight ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnected(false);
      return;
    }
    if (!conn) return;
    api.ambossMyOrders().then(setData).catch(() => {});
    api.magmaRecommendations().then(setRec).catch(() => {});
  };

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, []);

  const accept = async (o: MyOrder) => {
    const fee = o.feeSats > 0 ? `${o.feeSats.toLocaleString()} sat ` : "";
    const ok = await ui.confirm({
      title: "Accept order",
      message:
        `Accept this order? You'll create a ${fee}hold invoice for the fee — the buyer's payment is held, ` +
        `and only settles once Amboss confirms the ${satsCompact(o.sizeSats)} channel you then open ` +
        `(any failure refunds the buyer). No funds move yet.`,
      confirmLabel: "Accept",
    });
    if (!ok) return;
    setBusyId(o.id);
    try {
      await api.ambossAcceptOrder(o.id);
      ui.toast("Order accepted — open the channel once the buyer has paid.", "success");
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusyId(null);
    }
  };

  const openCh = async (o: MyOrder) => {
    const pubkey = o.destination.split("@")[0] || o.destination;
    const ok = await ui.confirm({
      title: "Open channel to buyer",
      message:
        `Open a ${satsCompact(o.sizeSats)} channel to ${pubkey.slice(0, 20)}…? This commits real ` +
        `on-chain funds into the channel (you earn ${o.feeSats.toLocaleString()} sat). Real transaction.`,
      confirmLabel: `Open ${satsCompact(o.sizeSats)} channel`,
      danger: true,
    });
    if (!ok) return;
    setBusyId(o.id);
    try {
      const r = await api.ambossOpenOrder(o.id);
      const tx = r.transactionId ? ` — funding ${r.transactionId.slice(0, 12)}…` : "";
      ui.toast(
        r.reported === false
          ? `Channel opening${tx}. Amboss hasn't taken it yet — reporting it is retried automatically.`
          : `Channel opening${tx}`,
        "success",
      );
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (o: MyOrder) => {
    const ok = await ui.confirm({
      title: "Reject order",
      message: `Reject this ${satsCompact(o.sizeSats)} order? Rejecting is better for your seller score than letting it time out.`,
      confirmLabel: "Reject",
      danger: true,
    });
    if (!ok) return;
    setBusyId(o.id);
    try {
      await api.ambossRejectOrder(o.id);
      ui.toast("Order rejected.", "success");
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusyId(null);
    }
  };

  // Inbound bought on Magma — recorded on the node, followed to its channel.
  const purchaseBlock = purchases.length ? (
    <>
      <h3 className="sub">Purchases · inbound you bought</h3>
      <table className="fee-table">
        <thead>
          <tr>
            <th>When</th>
            <th className="num">Size</th>
            <th className="num">Fee paid</th>
            <th className="num">Lease</th>
            <th>Status</th>
            <th>Channel</th>
          </tr>
        </thead>
        <tbody>
          {purchases.map((p) => (
            <tr key={p.orderId}>
              <td className="muted">{new Date(p.createdAt).toLocaleString()}</td>
              <td className="num">{p.sizeSats > 0 ? satsCompact(p.sizeSats) : "—"}</td>
              <td className="num" title={p.routingFeeSats ? `+ ${p.routingFeeSats} sat routing fee` : undefined}>
                {p.feeSats.toLocaleString()}
              </td>
              <td className="num">{p.leaseBlocks ? `${Math.round(p.leaseBlocks / 144)}d` : "—"}</td>
              <td title={p.error ?? p.orderStatus ?? undefined}>{purchaseLabel(p)}</td>
              <td className="muted">{p.channelId ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  ) : null;

  // Direct LSPS1 sales — rendered below the Magma orders, and even when Amboss
  // isn't connected (they don't involve the marketplace at all).
  const lspBlock = lspOrders.length ? (
    <>
      <h3 className="sub">Direct sales · LSP mode</h3>
      <div className="dryrun-banner">
        Channels sold directly to wallets over the open LSP standard (LSPS1). The buyer pays a
        hold invoice that only settles once the channel is opening — failures refund automatically.
      </div>
      <table className="fee-table">
        <thead>
          <tr>
            <th>When</th>
            <th className="num">Size</th>
            <th className="num">Fee</th>
            <th>Status</th>
            <th>Channel</th>
          </tr>
        </thead>
        <tbody>
          {lspOrders.map((o) => (
            <tr key={o.orderId}>
              <td className="muted">{new Date(o.createdAt).toLocaleString()}</td>
              <td className="num">{satsCompact(o.sizeSat)}</td>
              <td className="num">{o.feeSat.toLocaleString()}</td>
              <td title={o.error ?? undefined}>{lspStatusLabel(o)}</td>
              <td className="muted">{o.fundingOutpoint ? `${o.fundingOutpoint.slice(0, 12)}…` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  ) : null;

  if (connected === false) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Orders</h2>
        </div>
        <div className="dryrun-banner">
          Connect your Amboss API key in <strong>Settings</strong> to see orders.
        </div>
        {ordersInFlight > 0 ? (
          <p className="banner error">
            {ordersInFlight === 1 ? "1 Magma order is" : `${ordersInFlight} Magma orders are`} still in flight. Without a
            key they can't be opened, reported or settled — LightningMate only releases held payments back to the
            buyers before they expire. Connect a key to finish {ordersInFlight === 1 ? "it" : "them"}.
          </p>
        ) : null}
        {purchaseBlock}
        {lspBlock}
      </section>
    );
  }

  const orders = data?.orders ?? [];
  const laneNote = laneBanner(data?.lane);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Orders <span className="muted">· on your offers</span>
        </h2>
        {data && data.pendingSeller > 0 ? (
          <span className="open-warn">{data.pendingSeller} pending</span>
        ) : null}
      </div>
      <div className="dryrun-banner">
        Orders buyers placed on your offers. <strong>Accept</strong> creates a hold invoice for the fee,
        then — once the buyer has paid — <strong>Open channel</strong> funds the channel to the buyer; the
        payment settles only when Amboss confirms the channel. The Autopilot can do this automatically
        (enable <strong>Liquidity provision</strong>); orders it can't serve are rejected right away.
      </div>
      {laneNote ? <p className="banner error">{laneNote}</p> : null}
      {error ? <p className="banner error">{error}</p> : null}

      {rec ? (
        <div className="magma-analytics">
          <div className="magma-an"><span>{rec.analytics.filledOrdersAllTime}</span><label>sold all-time</label></div>
          <div className="magma-an"><span>{rec.analytics.filledOrders30d}</span><label>sold 30d</label></div>
          <div className="magma-an green"><span>{sats(rec.analytics.grossEarningsSat)}</span><label>gross earned (sat)</label></div>
          <div className="magma-an green"><span>{sats(rec.analytics.netProfitSat)}</span><label>net after costs</label></div>
          <div className="magma-an"><span>{satsCompact(rec.analytics.deployedSat)}</span><label>capital deployed</label></div>
          <div className="magma-an"><span>{rec.analytics.avgLeaseFeePpm != null ? `${rec.analytics.avgLeaseFeePpm}` : "—"}</span><label>avg lease ppm</label></div>
          {rec.analytics.closableSoon > 0 ? (
            <div className="magma-an"><span>{rec.analytics.closableSoon}</span><label>closable soon</label></div>
          ) : null}
        </div>
      ) : null}

      {connected === null ? (
        <p className="muted">Loading…</p>
      ) : orders.length === 0 ? (
        <EmptyState icon="📭">No orders yet.</EmptyState>
      ) : (
        <table className="fee-table">
          <thead>
            <tr>
              <th>When</th>
              <th className="num">Size</th>
              <th className="num">Fee</th>
              <th>Status</th>
              <th>Channel</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="muted">{new Date(o.createdAt).toLocaleString()}</td>
                <td className="num">{satsCompact(o.sizeSats)}</td>
                <td className="num">{o.feeSats > 0 ? o.feeSats.toLocaleString() : "—"}</td>
                <td title={localDetail(o)}>
                  {o.status}
                  {o.local ? <span className="muted"> · {localLabel(o.local)}</span> : null}
                </td>
                <td className="muted">{o.channelId ? `${o.channelId.slice(0, 12)}…` : "—"}</td>
                <td>
                  {awaitsYourDecision(o) ? (
                    <div className="row-actions">
                      <button className="row-btn" disabled={busyId !== null} onClick={() => void accept(o)}>
                        {busyId === o.id ? "…" : "Accept"}
                      </button>
                      <button className="row-btn ghost" disabled={busyId !== null} onClick={() => void reject(o)}>
                        Reject
                      </button>
                    </div>
                  ) : o.side === "SELL" && o.status === "WAITING_FOR_CHANNEL_OPEN" ? (
                    <button className="row-btn" disabled={busyId !== null} onClick={() => void openCh(o)}>
                      {busyId === o.id ? "…" : "Open channel"}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {purchaseBlock}
      {lspBlock}
    </section>
  );
}
