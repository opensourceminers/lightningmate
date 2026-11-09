import { useEffect, useState } from "react";
import { api } from "../api";
import type { NodeSearchResponse } from "../types";
import { capacityText } from "../nodeView";
import { openNode } from "../nodeNav";

/** The address in what was typed: "key@host:port" (undefined: none). */
export function typedSocket(typed: string): string | undefined {
  const at = typed.trim().indexOf("@");
  if (at < 0) return undefined;
  const socket = typed.trim().slice(at + 1);
  return socket.length > 0 && socket.length <= 256 ? socket : undefined;
}

/**
 * Find any node, not just the suggested ones: by part of its alias, its key,
 * or key@host:port. Searches the network graph LND already holds, so nothing
 * leaves the machine.
 */
export function NodeSearch() {
  const [typed, setTyped] = useState("");
  const [found, setFound] = useState<NodeSearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = typed.trim();
    setError(null);
    if (q.length < 2) {
      setFound(null);
      setBusy(false);
      return;
    }
    let gone = false;
    // A search still waiting (the graph's first read) ends when another is
    // typed: a pile of them would use up the browser's connections.
    const abort = new AbortController();
    setBusy(true);
    const timer = setTimeout(() => {
      api
        .nodeSearch(q, abort.signal)
        .then((r) => {
          if (!gone) setFound(r);
        })
        .catch((e) => {
          if (!gone) setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!gone) setBusy(false);
        });
    }, 300);
    return () => {
      gone = true;
      clearTimeout(timer);
      abort.abort();
    };
  }, [typed]);

  const socket = typedSocket(typed);
  const hits = found?.hits ?? [];
  return (
    <div className="node-search">
      <input
        type="search"
        value={typed}
        placeholder="Find any node: alias, public key or key@host:port"
        aria-label="Find any node"
        onChange={(e) => setTyped(e.target.value)}
      />
      {busy ? <div className="muted small node-search-note">Searching the network graph…</div> : null}
      {error ? <div className="ap-fail small node-search-note">{error}</div> : null}
      {!busy && !error && found && hits.length === 0 ? <div className="muted small node-search-note">No node with that name or key in your node's view of the network.</div> : null}
      {hits.length > 0 ? (
        <ul className="node-search-hits">
          {hits.map((h) => (
            <li key={h.pubkey}>
              <button type="button" className="node-search-hit" onClick={() => openNode({ pubkey: h.pubkey, alias: h.alias, socket })}>
                <span className="node-search-name">
                  {h.alias}
                  {h.isPeer ? <span className="sug-badge">your peer</span> : null}
                </span>
                <span className="muted small">
                  {h.channels > 0 ? `${h.channels.toLocaleString("en-US")} channel${h.channels === 1 ? "" : "s"} · ${capacityText(h.capacitySats)}` : "not in the network graph"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
