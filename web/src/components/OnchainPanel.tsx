import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api";
import type { OnchainState, OnchainTx, PriceInfo } from "../types";
import { fiat, sats, timeAgo } from "../format";
import { useUi } from "./Overlay";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function OnchainPanel({ price }: { price?: PriceInfo | null }) {
  const { toast, confirm } = useUi();
  const [canWrite, setCanWrite] = useState(false);
  const [state, setState] = useState<OnchainState | null>(null);
  const [txs, setTxs] = useState<OnchainTx[]>([]);

  // Receive
  const [address, setAddress] = useState<string | null>(null);
  const [genLoading, setGenLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Send
  const [toAddr, setToAddr] = useState("");
  const [amount, setAmount] = useState("");
  const [feeRate, setFeeRate] = useState("");
  const [sending, setSending] = useState(false);

  const load = () => {
    api
      .onchainState()
      .then((s) => {
        setState(s);
        setFeeRate((cur) => cur || (s.suggestedFeeRate ? String(s.suggestedFeeRate) : ""));
      })
      .catch(() => {});
    api.onchainTxs().then(setTxs).catch(() => {});
  };
  useEffect(() => {
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => {});
    load();
  }, []);

  const fiatOf = (s: number) => (price ? fiat(s, price.btcPrice, price.currency) : null);

  const genAddress = async () => {
    setGenLoading(true);
    try {
      const r = await api.onchainAddress();
      setAddress(r.address);
    } catch (e) {
      toast(msg(e), "error");
    } finally {
      setGenLoading(false);
    }
  };

  const copyAddr = () => {
    if (!address) return;
    void navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const send = async () => {
    const amt = Number(amount) || 0;
    const rate = Number(feeRate) || 0;
    if (!toAddr.trim() || amt <= 0 || rate <= 0) {
      toast("Enter address, amount and fee rate.", "error");
      return;
    }
    const ok = await confirm({
      title: "Send on-chain",
      message: `Send ${sats(amt)} sat to ${toAddr.trim().slice(0, 16)}… at ${rate} sat/vByte? On-chain sends are irreversible.`,
      confirmLabel: "Send now",
      danger: true,
    });
    if (!ok) return;
    setSending(true);
    try {
      const r = await api.onchainSend({ address: toAddr.trim(), tokens: amt, feeRate: rate });
      if (r.ok && r.transactionId) {
        toast(`Sent — tx ${r.transactionId.slice(0, 12)}…`, "success");
        setToAddr("");
        setAmount("");
        load();
      } else {
        toast(`Send failed: ${r.error ?? "unknown"}`, "error");
      }
    } catch (e) {
      toast(msg(e), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="pay">
      {!canWrite ? (
        <div className="dryrun-banner">
          Generating an address and sending are <strong>disabled</strong> (read-only macaroon). You
          can still view balance, UTXOs and history.
        </div>
      ) : null}

      {/* Balance strip */}
      <section className="panel oc-bal">
        <div>
          <div className="stat-label">On-chain balance</div>
          <div className="invoice-amt">
            {sats(state?.confirmedSats ?? 0)} sat
            {fiatOf(state?.confirmedSats ?? 0) ? <span className="muted"> · {fiatOf(state?.confirmedSats ?? 0)}</span> : null}
          </div>
          {state && state.pendingSats > 0 ? (
            <div className="muted">+ {sats(state.pendingSats)} sat pending</div>
          ) : null}
        </div>
        <div className="oc-bal-meta">
          {state?.suggestedFeeRate ? <div className="muted">≈ {state.suggestedFeeRate} sat/vB to confirm</div> : null}
          <div className="muted">{state?.utxos.length ?? 0} UTXOs</div>
          <button className="refresh" onClick={load}>↻ refresh</button>
        </div>
      </section>

      <div className="pay-grid">
        {/* ── Receive ───────────────────────────────────────── */}
        <section className="panel">
          <div className="panel-head"><h2>Receive on-chain</h2></div>
          <div className="pay-form">
            <button className="primary-btn" disabled={!canWrite || genLoading} onClick={genAddress}>
              {genLoading ? "Generating…" : "New address"}
            </button>
          </div>
          {address ? (
            <div className="invoice-out">
              <div className="qr-box">
                <QRCodeSVG value={`bitcoin:${address}`} size={188} bgColor="#ffffff" fgColor="#0b0c12" level="M" />
              </div>
              <div className="invoice-meta">
                <code className="inv-string">{address}</code>
                <button className="row-btn" onClick={copyAddr}>{copied ? "✓ copied" : "copy address"}</button>
                <span className="muted" style={{ fontSize: 12 }}>Segwit (bc1q…) · single-use recommended</span>
              </div>
            </div>
          ) : null}
        </section>

        {/* ── Send ──────────────────────────────────────────── */}
        <section className="panel">
          <div className="panel-head"><h2>Send on-chain</h2></div>
          <div className="pay-form">
            <label className="policy-field">
              <span>Bitcoin address</span>
              <input type="text" value={toAddr} onChange={(e) => setToAddr(e.target.value)} placeholder="bc1…" />
            </label>
            <label className="policy-field">
              <span>Amount (sat)</span>
              <input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
              {amount && fiatOf(Number(amount) || 0) ? <span className="muted">≈ {fiatOf(Number(amount) || 0)}</span> : null}
            </label>
            <label className="policy-field">
              <span>Fee rate (sat/vByte)</span>
              <input type="number" min={1} value={feeRate} onChange={(e) => setFeeRate(e.target.value)} />
            </label>
            <button className="primary-btn btn-danger" disabled={!canWrite || sending} onClick={send}>
              {sending ? "Sending…" : "Send now"}
            </button>
          </div>
        </section>
      </div>

      {/* ── Transactions ──────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head"><h2>Transactions</h2></div>
        <table className="fee-table">
          <tbody>
            {txs.slice(0, 12).map((t) => (
              <tr key={t.id}>
                <td>
                  <span className={`status ${t.isConfirmed ? "on" : "off"}`} />
                  {t.isOutgoing ? "Sent" : "Received"}
                  {!t.isConfirmed ? <span className="tag">pending</span> : null}
                </td>
                <td className={`num ${t.amountSats >= 0 ? "earned" : ""}`}>
                  {t.amountSats >= 0 ? "+" : "−"}{sats(Math.abs(t.amountSats))}
                </td>
                <td className="num muted">{t.feeSats ? `fee ${t.feeSats}` : ""}</td>
                <td className="num muted">{t.confirmations} conf</td>
                <td className="num muted">{timeAgo(t.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {txs.length === 0 ? <p className="muted empty">No on-chain transactions yet.</p> : null}
      </section>
    </div>
  );
}
