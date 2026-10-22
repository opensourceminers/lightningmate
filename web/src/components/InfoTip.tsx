import { useState } from "react";

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
        onKeyDown={(e) => e.stopPropagation()}
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
