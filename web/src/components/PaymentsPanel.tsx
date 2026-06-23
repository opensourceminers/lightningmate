import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api";
import type { CreatedInvoice, DecodedRequest, LnActivity, PriceInfo } from "../types";
import { fiat, sats, timeAgo } from "../format";
import { useUi } from "./Overlay";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PaymentsPanel({ price }: { price?: PriceInfo | null }) {
  const { toast, confirm } = useUi();
  const [canWrite, setCanWrite] = useState(false);
  const [activity, setActivity] = useState<LnActivity | null>(null);

  // Receive
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [invoice, setInvoice] = useState<CreatedInvoice | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  // Send
  const [request, setRequest] = useState("");
  const [decoded, setDecoded] = useState<DecodedRequest | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [paying, setPaying] = useState(false);
  const [maxFee, setMaxFee] = useState(50);
  const [payAmount, setPayAmount] = useState(""); // for amountless invoices

  const loadActivity = () => api.lnActivity().then(setActivity).catch(() => {});
  useEffect(() => {
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => {});
    loadActivity();
  }, []);

  const fiatOf = (s: number) => (price ? fiat(s, price.btcPrice, price.currency) : null);

  const createInvoice = async () => {
    setCreating(true);
    setInvoice(null);
    try {
      const inv = await api.lnInvoice({ tokens: Number(amount) || 0, description: memo });
      setInvoice(inv);
    } catch (e) {
      toast(msg(e), "error");
    } finally {
      setCreating(false);
    }
  };

  const copyInvoice = () => {
    if (!invoice) return;
    void navigator.clipboard.writeText(invoice.request);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const decode = async () => {
    setDecoded(null);
    if (!request.trim()) return;
    setDecoding(true);
    try {
      setDecoded(await api.lnDecode(request.trim()));
    } catch (e) {
      toast(msg(e), "error");
    } finally {
      setDecoding(false);
    }
  };

  const payNow = async () => {
    if (!decoded) return;
    const amountless = decoded.tokens === 0;
    const sendSats = amountless ? Number(payAmount) || 0 : decoded.tokens;
    if (amountless && sendSats <= 0) {
      toast("Enter an amount for this invoice.", "error");
      return;
    }
    const ok = await confirm({
      title: "Send payment",
      message: `Pay ${sats(sendSats)} sat to ${decoded.destination.slice(0, 18)}… ? Routing fee capped at ${maxFee} sat.`,
      confirmLabel: "Pay now",
      danger: true,
    });
    if (!ok) return;
    setPaying(true);
    try {
      const r = await api.lnPay({
        request: request.trim(),
        maxFeeSats: maxFee,
        ...(amountless ? { tokens: sendSats } : {}),
      });
      if (r.ok) {
        toast(`Paid ${sats(r.tokens)} sat · fee ${r.feeSats} sat`, "success");
        setRequest("");
        setDecoded(null);
        setPayAmount("");
        loadActivity();
      } else {
        toast(`Payment failed: ${r.error ?? "no route found"}`, "error");
      }
    } catch (e) {
      toast(msg(e), "error");
    } finally {
      setPaying(false);
    }
  };

  return (
    <div className="pay">
      {!canWrite ? (
        <div className="dryrun-banner">
          Sending and creating invoices are <strong>disabled</strong> (read-only macaroon). You can
          still decode requests and view history. Enable writes to send & receive.
        </div>
      ) : null}

      <div className="pay-grid">
        {/* ── Receive ───────────────────────────────────────── */}
        <section className="panel">
          <div className="panel-head"><h2>Receive</h2></div>
          <div className="pay-form">
            <label className="policy-field">
              <span>Amount (sat) — blank = any</span>
              <input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
              />
            </label>
            <label className="policy-field">
              <span>Description</span>
              <input
                type="text"
                value={memo}
                maxLength={640}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="optional memo"
              />
            </label>
            <button className="primary-btn" disabled={!canWrite || creating} onClick={createInvoice}>
              {creating ? "Creating…" : "Create invoice"}
            </button>
          </div>

          {invoice ? (
            <div className="invoice-out">
              <div className="qr-box">
                <QRCodeSVG value={invoice.request} size={188} bgColor="#ffffff" fgColor="#0b0c12" level="M" />
              </div>
              <div className="invoice-meta">
                {invoice.tokens > 0 ? (
                  <div className="invoice-amt">
                    {sats(invoice.tokens)} sat
                    {fiatOf(invoice.tokens) ? <span className="muted"> · {fiatOf(invoice.tokens)}</span> : null}
                  </div>
                ) : (
                  <div className="invoice-amt muted">any amount</div>
                )}
                <code className="inv-string">{invoice.request}</code>
                <button className="row-btn" onClick={copyInvoice}>{copied ? "✓ copied" : "copy invoice"}</button>
              </div>
            </div>
          ) : null}
        </section>

        {/* ── Send ──────────────────────────────────────────── */}
        <section className="panel">
          <div className="panel-head"><h2>Send</h2></div>
          <div className="pay-form">
            <label className="policy-field">
              <span>BOLT11 invoice</span>
              <textarea
                className="pay-req"
                value={request}
                onChange={(e) => { setRequest(e.target.value); setDecoded(null); }}
                placeholder="lnbc…"
                rows={3}
              />
            </label>
            <button className="reset" disabled={!request.trim() || decoding} onClick={decode}>
              {decoding ? "Decoding…" : "Decode"}
            </button>
          </div>

          {decoded ? (
            <div className="pay-decoded">
              <div className="kv"><span className="muted">Amount</span><span>
                {decoded.tokens > 0 ? `${sats(decoded.tokens)} sat` : "any (enter below)"}
                {decoded.tokens > 0 && fiatOf(decoded.tokens) ? <span className="muted"> · {fiatOf(decoded.tokens)}</span> : null}
              </span></div>
              {decoded.description ? <div className="kv"><span className="muted">Description</span><span>{decoded.description}</span></div> : null}
              <div className="kv"><span className="muted">Destination</span><code className="mono-sm">{decoded.destination.slice(0, 22)}…</code></div>
              {decoded.expired ? <div className="kv"><span className="muted">Status</span><span className="delta-up">expired</span></div> : null}

              {decoded.tokens === 0 ? (
                <label className="policy-field">
                  <span>Amount to send (sat)</span>
                  <input type="number" min={1} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
                </label>
              ) : null}

              <label className="policy-field">
                <span>Max routing fee (sat)</span>
                <input type="number" min={0} value={maxFee} onChange={(e) => setMaxFee(Math.max(0, Number(e.target.value) || 0))} />
              </label>

              <button
                className="primary-btn btn-danger"
                disabled={!canWrite || paying || decoded.expired}
                onClick={payNow}
              >
                {paying ? "Paying…" : "Pay now"}
              </button>
            </div>
          ) : null}
        </section>
      </div>

      {/* ── Activity ──────────────────────────────────────── */}
      <section className="panel">
        <div className="panel-head">
          <h2>Recent activity</h2>
          <button className="refresh" onClick={loadActivity}>↻ refresh</button>
        </div>
        <div className="pay-grid">
          <div>
            <h3 className="sub">Received</h3>
            <table className="fee-table">
              <tbody>
                {(activity?.invoices ?? []).slice(0, 8).map((i) => (
                  <tr key={i.id}>
                    <td><span className={`status ${i.isPaid ? "on" : "off"}`} /> {i.description || <span className="muted">no memo</span>}</td>
                    <td className="num earned">{i.isPaid ? `+${sats(i.receivedSats || i.tokens)}` : sats(i.tokens)}</td>
                    <td className="num muted">{timeAgo(i.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!activity?.invoices.length ? <p className="muted empty">No invoices yet.</p> : null}
          </div>
          <div>
            <h3 className="sub">Sent</h3>
            <table className="fee-table">
              <tbody>
                {(activity?.payments ?? []).slice(0, 8).map((p) => (
                  <tr key={p.id}>
                    <td><code className="mono-sm">{p.destination.slice(0, 14)}…</code></td>
                    <td className="num">−{sats(p.tokens)}</td>
                    <td className="num muted">fee {p.feeSats}</td>
                    <td className="num muted">{timeAgo(p.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!activity?.payments.length ? <p className="muted empty">No payments yet.</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
