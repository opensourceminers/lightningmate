import { useEffect, useState } from "react";
import type { ChannelOverride, FeeMode } from "../types";
import { OVERRIDE_HINTS, OVERRIDE_LABELS, onModeChange, parsePin, pinSeed } from "../feeView";

/**
 * A channel's fee mode (auto / fixed / excluded) — the same control on the
 * Channels table and on Autopilot → Fees (review a6). Choosing "fixed" opens
 * the input with the channel's CURRENT fee and saves nothing until a value
 * is confirmed (Enter, the Pin button, or leaving the field with a changed
 * value); Escape cancels. A refused save is shown, not swallowed. The input
 * follows the stored pin when the overrides arrive after the first render
 * (before, an existing 800 ppm pin showed — and on blur re-saved — 100).
 */
export function FeeOverrideControl({
  ov,
  currentPpm,
  onSave,
  variant = "select",
  disabled = false,
}: {
  ov: ChannelOverride | undefined;
  currentPpm: number | null | undefined;
  /** Rejects with the server's message when the save is refused. */
  onSave: (mode: FeeMode, fixedPpm?: number) => Promise<void>;
  variant?: "select" | "buttons";
  disabled?: boolean;
}) {
  const mode = ov?.mode ?? "auto";
  // null: not editing. Otherwise the text in the pin input.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The stored pin changed (loaded, or saved elsewhere): show it.
  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [ov?.mode, ov?.fixedPpm]);

  const save = async (m: FeeMode, fixedPpm?: number) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(m, fixedPpm);
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const choose = (m: FeeMode) => {
    const next = onModeChange(m, ov, currentPpm);
    if ("edit" in next) {
      setDraft(next.edit);
      setError(null);
    } else void save(next.save.mode);
  };

  const confirm = (text: string) => {
    const pin = parsePin(text);
    if (!pin.ok) {
      setError(pin.error);
      return;
    }
    if (mode === "fixed" && ov?.fixedPpm === pin.value) {
      setDraft(null);
      return;
    }
    void save("fixed", pin.value);
  };

  const editing = draft !== null;
  const shownMode: FeeMode = editing ? "fixed" : mode;
  const seed = pinSeed(ov, currentPpm);

  return (
    <div className={variant === "select" ? "ov" : "ov-control"}>
      {variant === "select" ? (
        <select value={shownMode} disabled={disabled || saving} onChange={(e) => choose(e.target.value as FeeMode)}>
          {(["auto", "fixed", "exclude"] as FeeMode[]).map((m) => (
            <option key={m} value={m} title={OVERRIDE_HINTS[m]}>
              {OVERRIDE_LABELS[m]}
            </option>
          ))}
        </select>
      ) : (
        (["auto", "fixed", "exclude"] as FeeMode[]).map((m) => (
          <button
            key={m}
            className={`ov-btn ${shownMode === m ? "active" : ""}`}
            title={OVERRIDE_HINTS[m]}
            disabled={disabled || saving}
            onClick={() => choose(m)}
          >
            {OVERRIDE_LABELS[m]}
          </button>
        ))
      )}
      {shownMode === "fixed" ? (
        <>
          <input
            type="number"
            className={variant === "select" ? "ov-ppm" : "ov-input"}
            min={0}
            max={50_000}
            step={1}
            title="pinned fee, ppm"
            value={draft ?? seed}
            disabled={disabled || saving}
            onFocus={() => setDraft((d) => d ?? seed)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirm(draft ?? seed);
              if (e.key === "Escape") {
                setDraft(null);
                setError(null);
              }
            }}
            onBlur={() => {
              // Leaving the field saves only a changed value of a pin that
              // exists; a new pin needs Enter or "Pin".
              if (draft !== null && mode === "fixed" && draft !== seed) confirm(draft);
            }}
          />
          {editing && mode !== "fixed" ? (
            <>
              <button className="ov-btn" disabled={saving} onMouseDown={(e) => e.preventDefault()} onClick={() => confirm(draft ?? seed)}>
                Pin
              </button>
              <button
                className="ov-btn"
                disabled={saving}
                title="cancel"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setDraft(null);
                  setError(null);
                }}
              >
                ✕
              </button>
            </>
          ) : null}
        </>
      ) : null}
      {error ? <span className="ov-error">{error}</span> : null}
    </div>
  );
}
