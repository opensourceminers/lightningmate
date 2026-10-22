import { useState } from "react";

/**
 * The keys the (i) button acts on itself — Enter and Space press it — and so
 * keeps from a clickable parent (a tile opens on them too). Every other key
 * goes on: Esc must still close a dialog the tip sits in, and Tab still move
 * within its focus trap (review of P7: every key was stopped).
 */
export function infoTipKeyDown(e: { key: string; stopPropagation(): void }): void {
  if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") e.stopPropagation();
}

/**
 * A short explanation behind an (i) button — opened by a click, a tap or
 * the keyboard, shown as text on the page (review a6-ux:nav-a11y-copy: key
 * explanations lived only in `title` tooltips, which never appear on a touch
 * screen and only after a hover elsewhere). The button says whether it is
 * open (aria-expanded); a click on it never reaches a clickable parent (a
 * tile, a row).
 */
export function InfoTip({ text, label = "What this means" }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip">
      <button
        type="button"
        className="info-btn"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={infoTipKeyDown}
      >
        ⓘ
      </button>
      {open ? (
        <span className="info-text" role="note">
          {text}
        </span>
      ) : null}
    </span>
  );
}
