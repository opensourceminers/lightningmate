import type { ReactNode } from "react";
import { useRememberedFlag } from "../remembered";

/**
 * A section that opens on a click and stays as it was left, in this browser:
 * whoever wants the details keeps them open, everyone else never sees them.
 * `id` names it for that memory; the same id everywhere is the same choice.
 * `forceOpen`: something in it needs seeing now (an edit under way). What is
 * inside is mounted only while open, so a closed section reads nothing.
 */
export function Fold({
  id,
  title,
  note,
  className,
  defaultOpen = false,
  forceOpen = false,
  children,
}: {
  id: string;
  title: string;
  note?: string;
  className?: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useRememberedFlag(`fold_${id}`, defaultOpen);
  const shown = open || forceOpen;
  return (
    <details
      className={`fold${className ? ` ${className}` : ""}`}
      open={shown}
      onToggle={(e) => {
        if (e.currentTarget.open !== shown) setOpen(e.currentTarget.open);
      }}
    >
      <summary>
        {title}
        {note ? <span className="muted fold-note"> · {note}</span> : null}
      </summary>
      <div className="fold-body">{shown ? children : null}</div>
    </details>
  );
}
