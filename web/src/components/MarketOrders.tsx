import { useEffect, useState } from "react";
import { api } from "../api";
import type { MyOrdersView } from "../types";
import { satsCompact } from "../format";
import { EmptyState } from "./Skeleton";

export function MarketOrders() {
  const [data, setData] = useState<MyOrdersView | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        Orders buyers placed on your offers. A pending order needs a channel opened to the buyer in
        time — for now you do that on your node; the Autopilot will handle it next.
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
              <th>Role</th>
              <th>Status</th>
              <th>Payment</th>
              <th>Channel</th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id}>
                <td className="muted">{new Date(o.createdAt).toLocaleString()}</td>
                <td className="num">{satsCompact(o.sizeSats)}</td>
                <td>{o.side === "SELL" ? "seller" : "buyer"}</td>
                <td>{o.status}</td>
                <td className="muted">{o.paymentStatus ?? "—"}</td>
                <td className="muted">{o.channelId ? `${o.channelId.slice(0, 12)}…` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
