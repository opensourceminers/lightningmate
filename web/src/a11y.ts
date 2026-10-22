import { useEffect, useRef, type RefObject } from "react";

/**
 * Keyboard and touch access (review a6-ux:nav-a11y-copy): rows that open on
 * a click were mouse-only — `<tr onClick>` with no focus, no Enter, no state
 * for a screen reader — and the confirm and close dialogs had no Esc, no
 * initial focus and let Tab wander behind them.
 */

/**
 * An expandable row's toggle for the keyboard and screen readers: a real
 * `<button>` in its caret cell — focusable, activated by Enter and Space
 * natively, saying whether the row is open — while the `<tr>` itself stays a
 * table row that opens on a mouse click. (Review of P7: role="button" on the
 * row made its Run…, Open, Close… buttons and the fee override inputs
 * "presentational children" — hidden from assistive tech, axe's
 * nested-interactive — and the row lost its table semantics.) Its click
 * stops at the button: the row's own click would toggle it back.
 */
export function caretButtonProps(open: boolean, toggle: () => void, label: string) {
  return {
    type: "button" as const,
    className: "row-caret",
    "aria-expanded": open,
    "aria-label": label,
    onClick: (e: { stopPropagation(): void }) => {
      e.stopPropagation();
      toggle();
    },
  };
}

/** Where Tab goes inside a dialog of `count` focusable controls, from the
 *  one at `current` (-1: none of them): null lets the browser move on;
 *  otherwise the index to focus — wrapping around, never out of the dialog. */
export function trapTab(current: number, count: number, shift: boolean): number | null {
  if (count === 0) return -1;
  if (shift) return current <= 0 ? count - 1 : null;
  return current === -1 || current >= count - 1 ? 0 : null;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog's keyboard behaviour while `open`: focus moves into it (its first
 * control, else the dialog itself), Tab and Shift+Tab stay inside it, Esc
 * closes it (`onClose`), and focus goes back to where it was once it closes.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables()[0] ?? el).focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const f = focusables();
      const next = trapTab(f.indexOf(document.activeElement as HTMLElement), f.length, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      if (next >= 0) f[next].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [open, ref]);
}
