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
 * mempool fee rates, lets the user type a sat/vByte (or pick Fast / Economy),
 * and offers a separate force-close. Force-closes can't set a fee (the
 * commitment tx fee was fixed at open time) and time-lock the funds.
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

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal close-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 className="modal-title">Close channel with {channel.peerAlias}</h3>
        <p className="modal-msg">
          {satsCompact(channel.capacity)} sat capacity — this broadcasts an on-chain transaction.
        </p>

        <div className="fee-now">
          Network fee now:{" "}
          {fees ? (
            <>
              fast <strong>~{fees.fast ?? "–"}</strong> · normal <strong>~{fees.normal ?? "–"}</strong> ·{" "}
              economy <strong>~{fees.economy ?? "–"}</strong> sat/vB
            </>
          ) : (
            "loading…"
          )}
        </div>

        {!offline ? (
          <>
            <label className="fee-input-row">
              <span>Fee rate</span>
              <input
                type="number"
                min={1}
                value={rate || ""}
                onChange={(e) => setRate(Math.max(1, Math.round(Number(e.target.value) || 0)))}
              />
              <span className="unit">sat/vByte</span>
            </label>
            <div className="fee-presets">
              <button
                type="button"
                className="chip"
                disabled={!fees?.fast}
                onClick={() => fees?.fast && setRate(fees.fast)}
              >
                Fast · next block{fees?.fast ? ` · ${fees.fast}` : ""}
              </button>
              <button
                type="button"
                className="chip"
                disabled={!fees?.economy}
                onClick={() => fees?.economy && setRate(fees.economy)}
              >
                Economy{fees?.economy ? ` · ${fees.economy}` : ""}
              </button>
            </div>
          </>
        ) : (
          <p className="modal-msg warn">
            The peer is offline, so a cooperative close isn’t possible. A force-close works, but your
            funds stay time-locked for a while before they return on-chain — and you can’t set the fee
            (it was fixed when the channel opened).
          </p>
        )}

        <div className="modal-actions close-actions">
          <button className="reset" onClick={onCancel} disabled={busy !== null}>
            Cancel
          </button>
          {!offline ? (
            <button className="primary-btn" disabled={busy !== null || !rate} onClick={() => doClose(false)}>
              {busy === "coop" ? "Closing…" : `Close at ${rate || "?"} sat/vB`}
            </button>
          ) : null}
          <button className="primary-btn btn-danger" disabled={busy !== null} onClick={() => doClose(true)}>
            {busy === "force" ? "Force-closing…" : "Force-close"}
          </button>
        </div>
      </div>
    </div>
  );
}
