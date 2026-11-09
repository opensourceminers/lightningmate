import type { ReactNode } from "react";
import { useRememberedFlag } from "../remembered";

/**
 * A section that opens on a click and stays as it was left, in this browser:
 * whoever wants the details keeps them open, everyone else never sees them.
 * `id` names it for that memory; the same id everywhere is the same choice.
 */
export function Fold({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  const [open, setOpen] = useRememberedFlag(`fold_${id}`);
  return (
    <details className="fold" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        {title}
        {note ? <span className="muted fold-note"> · {note}</span> : null}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}
