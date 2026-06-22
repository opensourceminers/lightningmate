import { useEffect, useState } from "react";
import { api } from "../api";
import type { WalletInfo } from "../types";
import { sats, satsCompact, timeAgo } from "../format";

export function WalletPanel() {
  const [data, setData] = useState<WalletInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.wallet().then((w) => !cancelled && (setData(w), setError(null)))
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    load();
    api.autopilotGet().then((s) => !cancelled && setCanWrite(s.canWrite)).catch(() => {});
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const getAddress = async () => {
    setBusy(true);
    try {
      const res = await api.walletAddress();
      setAddress(res.address);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    if (!address) return;
    void navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="panel">
      <div className="panel-head"><h2>On-chain wallet</h2></div>

      {error ? <p className="banner error">{error}</p> : null}

      <div className="report-stats">
        <div className="stat">
          <div className="stat-label">Confirmed</div>
          <div className="stat-value">{sats(data?.confirmedSats ?? 0)} sat</div>
        </div>
        <div className="stat">
          <div className="stat-label">Pending</div>
          <div className="stat-value">{sats(data?.pendingSats ?? 0)} sat</div>
        </div>
      </div>

      <h3 className="sub">Receive</h3>
      <div className="apply-row">
        <button className="primary-btn" disabled={!canWrite || busy} onClick={getAddress}
          title={canWrite ? "" : "Enable writes to generate an address"}>
          {busy ? "…" : "Get deposit address"}
        </button>
        {address ? (
          <span className="foot-donate">
            <code>{address}</code>
            <button className="foot-copy-btn" onClick={copy}>{copied ? "✓ copied" : "copy"}</button>
          </span>
        ) : null}
      </div>

      <h3 className="sub">Recent transactions</h3>
      <table className="forwards">
        <tbody>
          {(data?.transactions ?? []).map((t) => (
            <tr key={t.id}>
              <td className="muted">{timeAgo(t.createdAt)}</td>
              <td>{t.isOutgoing ? "↑ sent" : "↓ received"}{t.isConfirmed ? "" : " (pending)"}</td>
              <td className="num">{satsCompact(t.tokens)}</td>
              <td className="num muted">{t.fee ? `fee ${t.fee}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data && data.transactions.length === 0 ? (
        <p className="muted empty">No on-chain transactions yet.</p>
      ) : null}
    </section>
  );
}
