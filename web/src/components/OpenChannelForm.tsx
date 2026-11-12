import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { OpenChannelResult, OpenEstimate } from "../types";
import { satsCompact } from "../format";
import { notifyNodeChanged } from "../nodeNav";
import { fastRateHint } from "../onchainView";
import { openLines, startingFeeText } from "../openView";
import { promisedSpend, rateFarAbove, spendPromisedQuestion } from "../statusNotes";
import { useUi } from "./Overlay";

const MIN_CHANNEL_SATS = 20_000;

/** The opens being sent, per node. Closing the form doesn't stop one (the dial
 *  alone can take a minute and a half over Tor), and a form opened again must
 *  not send a second: that funds two channels. */
const underWay = new Map<string, Promise<void>>();

/**
 * Opening a channel by hand: its size, its on-chain fee, and what that costs,
 * before anything is sent. The same form on the suggestions and in a node's
 * details. `onResult` gets every outcome, a refused one too.
 */
export function OpenChannelForm({
  pubkey,
  alias,
  socket,
  initialSize,
  onResult,
  onCancel,
}: {
  pubkey: string;
  alias: string;
  socket: string;
  initialSize: number;
  onResult: (result: OpenChannelResult) => void;
  onCancel: () => void;
}) {
  const ui = useUi();
  const [size, setSize] = useState(initialSize);
  const [opening, setOpening] = useState(() => underWay.has(pubkey));
  // The fee it pays (sat/vB) and what it would cost and leave.
  const [estimate, setEstimate] = useState<OpenEstimate | null>(null);
  const [rate, setRate] = useState(0);

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Opened again while one is being sent: it waits with that one.
  useEffect(() => {
    const running = underWay.get(pubkey);
    if (!running) return;
    let gone = false;
    void running.then(() => {
      if (!gone) setOpening(false);
    });
    return () => {
      gone = true;
    };
  }, [pubkey]);

  // Once, when the form opens: a suggested size that arrives later must not
  // put a fee someone chose back to economy.
  useEffect(() => {
    let gone = false;
    // Economy by default: an open is rarely urgent.
    api
      .openEstimate(initialSize)
      .then((e) => {
        if (gone) return;
        setEstimate(e);
        setRate(e.fees.economy ?? e.fees.normal ?? e.fees.fast ?? 0);
      })
      .catch(() => {
        if (!gone) setEstimate(null);
      });
    return () => {
      gone = true;
    };
  }, []);

  const send = async (): Promise<OpenChannelResult> => {
    // Each question the server asks is asked once, and the open sent again
    // only after its yes: a rate far above the next block's (CHAN-2), then
    // coins promised to buyers.
    let rateConfirmed = false;
    let spendPromised = false;
    for (;;) {
      try {
        return await api.channelOpen({
          pubkey,
          socket,
          localTokens: size,
          ...(rate > 0 ? { feeRate: rate } : {}),
          ...(spendPromised ? { spendPromised } : {}),
          ...(rateConfirmed ? { confirmed: ["fee_rate_high"] } : {}),
        });
      } catch (e) {
        const high = rateConfirmed ? null : rateFarAbove(e);
        if (high) {
          const yes = await ui.confirm({ title: "Fee rate far above the next block", message: `${high} Open at this rate anyway?`, confirmLabel: "Open anyway", danger: true });
          if (!yes) return { ok: false, pubkey, localTokens: size, error: high };
          rateConfirmed = true;
          continue;
        }
        // Coins promised to buyers: only with an explicit yes that names them.
        const promised = spendPromised ? null : promisedSpend(e);
        if (!promised) throw e;
        const yes = await ui.confirm({
          title: "Spend coins promised to buyers?",
          message: spendPromisedQuestion(promised),
          confirmLabel: "Open anyway",
          danger: true,
        });
        if (!yes) return { ok: false, pubkey, localTokens: size, error: promised.message };
        spendPromised = true;
      }
    }
  };

  const submit = () => {
    if (underWay.has(pubkey)) return;
    setOpening(true);
    const work = send()
      .catch((e): OpenChannelResult => ({ ok: false, pubkey, localTokens: size, error: e instanceof Error ? e.message : String(e) }))
      .then((res) => {
        underWay.delete(pubkey);
        if (res.ok) notifyNodeChanged({ channels: true });
        if (mounted.current) {
          setOpening(false);
          onResult(res);
        } else {
          // The form was closed meanwhile: the outcome must still be said.
          ui.toast(res.ok ? `Channel to ${alias} opening.` : `The open to ${alias} failed: ${res.error}`, res.ok ? "success" : "error");
        }
      });
    underWay.set(pubkey, work);
  };

  const l = openLines(size, rate || null, estimate);
  return (
    <>
      <div className="open-form">
        <span>Open channel to <strong>{alias}</strong></span>
        <label className="policy-field inline">
          <span>Size (sat)</span>
          <input
            type="number"
            min={MIN_CHANNEL_SATS}
            step={100_000}
            value={size}
            onChange={(e) => setSize(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
          />
        </label>
        <span className="field-label">On-chain fee</span>
        <div className="fee-grid">
          {(
            [
              ["economy", "Economy", "~hours"],
              ["normal", "Normal", "~30 min"],
              ["fast", "Fast", estimate ? fastRateHint(estimate.fees) : "next block"],
            ] as const
          ).map(([key, label, hint]) => {
            const r = estimate?.fees[key] ?? null;
            return (
              <button
                key={key}
                type="button"
                className={`fee-card ${r !== null && rate === r ? "selected" : ""}`}
                disabled={r === null || opening}
                onClick={() => r !== null && setRate(r)}
              >
                <span className="fee-card-label">{label}</span>
                <span className="fee-card-rate">{r ?? "–"}</span>
                <span className="fee-card-hint">{hint}</span>
              </button>
            );
          })}
        </div>
        <label className="policy-field inline">
          <span>sat/vB</span>
          <input type="number" min={1} value={rate || ""} onChange={(e) => setRate(Math.max(0, Math.round(Number(e.target.value) || 0)))} />
        </label>
        <button className="primary-btn" disabled={opening || size < MIN_CHANNEL_SATS} onClick={submit}>
          {opening ? "Opening…" : `Open ${satsCompact(size)} sat channel`}
        </button>
        <button className="reset" disabled={opening} onClick={onCancel}>Cancel</button>
        {!socket ? <span className="muted">no address known — may fail to connect</span> : null}
        <span className="open-warn">⚠ real on-chain transaction</span>
      </div>
      {l.cost ? (
        <div className="open-estimate muted small">
          {[l.cost, l.left, l.payback].filter(Boolean).join(" · ")}
          {l.fee ? <div>{l.fee}</div> : null}
          {l.warn ? <div className="sug-warn">⚠ {l.warn}</div> : null}
        </div>
      ) : null}
    </>
  );
}

/** How an open went. */
export function OpenResultLine({ result }: { result: OpenChannelResult }) {
  return result.ok ? (
    <span className="open-ok">
      ✓ Channel opening — funding tx {result.transactionId?.slice(0, 16)}…
      {result.startingFee ? ` · ${startingFeeText(result.startingFee)}` : ""}
    </span>
  ) : (
    <span className="ap-fail">✗ {result.error}</span>
  );
}
