import type { ReactNode } from "react";
import { openNode, resolveNode } from "../nodeNav";

/**
 * A node's name that opens its details. A real button, so it works from the
 * keyboard; its click stops here, since many rows open or expand on a click of
 * their own. A name the app can't place (a channel closed since) stays plain
 * text.
 */
export function NodeLink({
  pubkey,
  channelId,
  alias,
  socket,
  children,
}: {
  pubkey?: string | null;
  channelId?: string | null;
  alias?: string | null;
  socket?: string;
  children?: ReactNode;
}) {
  const key = resolveNode({ pubkey, channelId, alias });
  const label = children ?? alias ?? (key ? `${key.slice(0, 12)}…` : "");
  if (!key) return <>{label}</>;
  return (
    <button
      type="button"
      className="node-link"
      title="Node details"
      onClick={(e) => {
        e.stopPropagation();
        openNode({ pubkey: key, alias: alias ?? undefined, socket });
      }}
    >
      {label}
    </button>
  );
}
