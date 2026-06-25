import { useEffect, useState } from "react";
import { api } from "../api";
import type { MyOrder, MyOrdersView } from "../types";
import { satsCompact } from "../format";
import { EmptyState } from "./Skeleton";
import { useUi } from "./Overlay";

export function MarketOrders() {
  const ui = useUi();
  const [data, setData] = useState<MyOrdersView | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    try {
      const s = await api.ambossStatus();
      setConnected(s.connected);
      if (s.connected) setData(await api.ambossMyOrders());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setConnected(false);
    }
  };

  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 30_000);
    return () => clearInterval(iv);
  }, []);

  const accept = async (o: MyOrder) => {
    const ok = await ui.confirm({
      title: "Accept order",
      message:
        `Accept this order? You'll create a ${o.feeSats.toLocaleString()} sat invoice for the fee and ` +
        `commit to opening a ${satsCompact(o.sizeSats)} channel to the buyer next. No funds move yet.`,
      confirmLabel: "Accept",
    });
    if (!ok) return;
    setBusyId(o.id);
    try {
      await api.ambossAcceptOrder(o.id);
      ui.toast("Order accepted — open the channel next.", "success");
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
      ui.toast(`Channel opening — funding ${r.transactionId.slice(0, 12)}…`, "success");
      await load();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusyId(null);
    }
  };

  if (connected === false) {
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>Orders</h2>
        </div>
        <div className="dryrun-banner">
          Connect your Amboss API key in <strong>Settings</strong> to see orders.
        </div>
      </section>
    );
  }

  const orders = data?.orders ?? [];

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
        Orders buyers placed on your offers. <strong>Accept</strong> creates the fee invoice, then{" "}
        <strong>Open channel</strong> funds the channel to the buyer — you verify each step. The
        Autopilot can do this automatically (enable <strong>Liquidity provision</strong>).
      </div>
      {error ? <p className="banner error">{error}</p> : null}

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
                <td>{o.status}</td>
                <td className="muted">{o.channelId ? `${o.channelId.slice(0, 12)}…` : "—"}</td>
                <td>
                  {o.side === "SELL" && o.status === "WAITING_FOR_SELLER_APPROVAL" ? (
                    <button className="row-btn" disabled={busyId !== null} onClick={() => void accept(o)}>
                      {busyId === o.id ? "…" : "Accept"}
                    </button>
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
    </section>
  );
}
