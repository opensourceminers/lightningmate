import { useEffect, useState } from "react";
import { api } from "../api";
import type { FeeEstimates } from "../types";
import { satsCompact } from "../format";
import { useUi } from "./Overlay";

/** Minimal shape a channel needs to be closable — a ChannelView satisfies it. */
export interface CloseTarget {
  peerAlias: string;
  capacity: number;
  active: boolean;
  transactionId: string;
  transactionVout: number;
}

/**
 * Close dialog with a free fee choice for cooperative closes: shows the current
 * mempool fee rates as pickable speed cards, lets the user fine-tune a sat/vByte,
 * and offers a separate force-close. Force-closes can't set a fee (the commitment
 * tx fee was fixed at open time) and time-lock the funds.
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
  const [busy, setBusy] = useState<null | "coop" | "force">(null);
  const offline = !channel.active;

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
    try {
      const r = await api.channelClose(
        channel.transactionId,
        channel.transactionVout,
        force,
        force ? undefined : rate,
      );
      if (r.ok) {
        toast(`Closing channel — ${r.transactionId?.slice(0, 12)}…`, "success");
        onClosed();
        return;
      }
      toast(`Close failed: ${r.error}`, "error");
    } catch (e) {
      toast(`Close failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    }
    setBusy(null);
  };

  const presets = [
    { key: "fast", label: "Fast", hint: "next block", rate: fees?.fast ?? null },
    { key: "normal", label: "Normal", hint: "~30 min", rate: fees?.normal ?? null },
    { key: "economy", label: "Economy", hint: "~hours", rate: fees?.economy ?? null },
  ];

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal close-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="modal-title">Close channel</h3>
        <p className="modal-msg">
          with <strong>{channel.peerAlias}</strong> · {satsCompact(channel.capacity)} sat — broadcasts an
          on-chain transaction.
        </p>

        {offline ? (
          <>
            <p className="modal-msg warn">
              The peer is offline, so a cooperative close isn’t possible. A force-close works, but your
              funds stay time-locked for a while before they return on-chain — and you can’t set the fee
              (it was fixed when the channel opened).
            </p>
            <div className="modal-actions">
              <button className="reset" onClick={onCancel} disabled={busy !== null}>
                Cancel
              </button>
              <button className="primary-btn btn-danger" disabled={busy !== null} onClick={() => doClose(true)}>
                {busy === "force" ? "Force-closing…" : "Force-close"}
              </button>
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
              <button className="primary-btn" disabled={busy !== null || !rate} onClick={() => doClose(false)}>
                {busy === "coop" ? "Closing…" : `Close · ${rate || "?"} sat/vB`}
              </button>
            </div>

            <div className="force-row">
              <span className="muted small">Peer unreachable or stuck?</span>
              <button className="row-btn ghost danger" disabled={busy !== null} onClick={() => doClose(true)}>
                {busy === "force" ? "Force-closing…" : "Force-close"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
