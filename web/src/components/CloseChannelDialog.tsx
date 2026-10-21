import { useEffect, useState } from "react";
import { api } from "../api";
import type { FeeEstimates } from "../types";
import { satsCompact } from "../format";
import { fastRateHint } from "../onchainView";
import {
  closeButtons,
  dialogLease,
  forceCloseConsequences,
  leaseBreakWarning,
  leaseRefusal,
  offlineLabel,
  refusedLease,
  shortOutage,
  type CloseTarget,
} from "../closeView";
import type { ChannelLease } from "../types";
import { useUi } from "./Overlay";

export type { CloseTarget } from "../closeView";

/**
 * The force-close confirmation — its own step, never one click (review
 * a6-ux:lease-unaware-close): what a force-close does is said before the
 * button that sends it.
 */
export function ForceCloseConfirm({
  peerAlias,
  consequences,
  busy,
  onBack,
  onConfirm,
}: {
  peerAlias: string;
  consequences: string[];
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <h3 className="modal-title">Force-close the channel with {peerAlias}?</h3>
      <p className="modal-msg warn">A force-close closes without the peer. That means:</p>
      <ul className="modal-msg force-consequences">
        {consequences.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
      <div className="modal-actions">
        <button className="reset" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button className="primary-btn btn-danger" disabled={busy} onClick={onConfirm}>
          {busy ? "Force-closing…" : "Force-close now"}
        </button>
      </div>
    </>
  );
}

/**
 * Close dialog. A cooperative close comes first, with a free fee choice (the
 * mempool's rates as pickable speed cards, or a sat/vByte of your own).
 *  - A peer that is away: "Reconnect" first — a short outage is no reason to
 *    close at all, and a cooperative close needs the peer.
 *  - A force-close is a separate step that states its consequences.
 *  - A channel inside its lease (sold on Magma or over LSPS1, or bought on
 *    Magma) says what closing breaks, and no close button works until the
 *    operator ticks "close it anyway" — the server refuses it otherwise.
 *    A lease the server names when it refuses (one the table didn't know
 *    yet) is shown the same way, with the same box.
 */
export function CloseChannelDialog({
  channel,
  onCancel,
  onClosed,
}: {
  channel: CloseTarget;
  onCancel: () => void;
  onClosed: () => void;
}) {
  const { toast } = useUi();
  const [fees, setFees] = useState<FeeEstimates | null>(null);
  const [rate, setRate] = useState<number>(0);
  const [busy, setBusy] = useState<null | "coop" | "force" | "reconnect">(null);
  const [step, setStep] = useState<"close" | "force">("close");
  const [breakLease, setBreakLease] = useState(false);
  const [refused, setRefused] = useState<ChannelLease | null>(null);
  const [error, setError] = useState<string | null>(null);
  const offline = !channel.active;
  const lease = dialogLease(channel, refused);
  const leaseWarning = leaseBreakWarning(lease);
  const can = closeButtons({ busy: busy !== null, rate, lease, breakLease });

  useEffect(() => {
    api
      .feeEstimates()
      .then((f) => {
        setFees(f);
        setRate(f.normal ?? f.fast ?? f.economy ?? 1);
      })
      .catch(() => {});
  }, []);

  const doClose = async (force: boolean) => {
    setBusy(force ? "force" : "coop");
    setError(null);
    try {
      const r = await api.channelClose(
        channel.transactionId,
        channel.transactionVout,
        force,
        force ? undefined : rate,
        leaseWarning !== null && breakLease,
      );
      if (r.ok) {
        toast(`Closing channel — ${r.transactionId?.slice(0, 12)}…`, "success");
        onClosed();
        return;
      }
      setError(`Close failed: ${r.error}`);
    } catch (e) {
      // A lease the server knows and this dialog didn't: shown now, with its
      // "close it anyway" box — the next try can confirm breaking it.
      const named = refusedLease(e);
      if (named) {
        setRefused(named);
        setBreakLease(false);
        setStep("close");
      }
      setError(leaseRefusal(e) ?? `Close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(null);
  };

  const reconnect = async () => {
    if (!channel.peerPubkey) return;
    setBusy("reconnect");
    setError(null);
    try {
      const r = await api.peerConnect(channel.peerPubkey);
      if (r.ok) toast("Peer reconnected — the channel comes back online in a moment; close it cooperatively if you still want to.", "success");
      else setError(r.error ?? "Could not reach the peer.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(null);
  };

  const presets = [
    { key: "fast", label: "Fast", hint: fees ? fastRateHint(fees) : "next block", rate: fees?.fast ?? null },
    { key: "normal", label: "Normal", hint: "~30 min", rate: fees?.normal ?? null },
    { key: "economy", label: "Economy", hint: "~hours", rate: fees?.economy ?? null },
  ];

  const away = offlineLabel(channel.offline);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal close-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        {step === "force" ? (
          <ForceCloseConfirm
            peerAlias={channel.peerAlias}
            consequences={forceCloseConsequences({ ...channel, lease }, fees?.economy ?? null)}
            busy={busy === "force"}
            onBack={() => setStep("close")}
            onConfirm={() => void doClose(true)}
          />
        ) : (
          <>
            <h3 className="modal-title">Close channel</h3>
            <p className="modal-msg">
              with <strong>{channel.peerAlias}</strong> · {satsCompact(channel.capacity)} sat — broadcasts an
              on-chain transaction.
            </p>

            {leaseWarning ? (
              <>
                <p className="modal-msg warn">{leaseWarning}</p>
                <label className="check">
                  <input type="checkbox" checked={breakLease} disabled={busy !== null} onChange={(e) => setBreakLease(e.target.checked)} />
                  I understand — close it anyway and break the lease
                </label>
              </>
            ) : null}

            {offline ? (
              <>
                <p className="modal-msg warn">
                  The peer is offline{away ? ` (${away.replace(/^offline /, "")})` : ""}, so a cooperative close isn’t possible
                  right now.{" "}
                  {shortOutage(channel)
                    ? "A short outage is no reason to close: reconnect, or wait for the peer to come back and close cooperatively."
                    : "It has been away for a long time — if it doesn’t come back, a force-close is the way out."}
                </p>
                <div className="modal-actions">
                  <button className="reset" onClick={onCancel} disabled={busy !== null}>
                    Cancel
                  </button>
                  {channel.peerPubkey ? (
                    <button className="primary-btn" disabled={busy !== null} onClick={() => void reconnect()}>
                      {busy === "reconnect" ? "Reconnecting…" : "Reconnect"}
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <span className="field-label">Fee rate — pick a speed</span>
                <div className="fee-grid">
                  {presets.map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={`fee-card ${p.rate !== null && rate === p.rate ? "selected" : ""}`}
                      disabled={p.rate === null}
                      onClick={() => p.rate !== null && setRate(p.rate)}
                    >
                      <span className="fee-card-label">{p.label}</span>
                      <span className="fee-card-rate">{p.rate ?? "–"}</span>
                      <span className="fee-card-hint">{p.hint}</span>
                    </button>
                  ))}
                </div>

                <label className="fee-field">
                  <span className="field-label">Custom</span>
                  <span className="fee-field-input">
                    <input
                      type="number"
                      min={1}
                      value={rate || ""}
                      onChange={(e) => setRate(Math.max(1, Math.round(Number(e.target.value) || 0)))}
                    />
                    <span className="suffix">sat/vByte</span>
                  </span>
                </label>

                <div className="modal-actions">
                  <button className="reset" onClick={onCancel} disabled={busy !== null}>
                    Cancel
                  </button>
                  <button className="primary-btn" disabled={!can.coop} onClick={() => void doClose(false)}>
                    {busy === "coop" ? "Closing…" : `Close · ${rate || "?"} sat/vB`}
                  </button>
                </div>
              </>
            )}

            {error ? <p className="banner error">{error}</p> : null}

            <div className="force-row">
              <span className="muted small">{offline ? "The peer won’t come back?" : "Peer unreachable or stuck?"}</span>
              <button className="row-btn ghost danger" disabled={!can.force} onClick={() => setStep("force")}>
                Force-close…
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
