import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChannelSuggestion } from "../types";
import { satsCompact } from "../format";

const scoreClass = (s: number) => (s >= 75 ? "good" : s >= 50 ? "ok" : "low");

export function SuggestedPeersTile() {
  const [rows, setRows] = useState<ChannelSuggestion[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .suggestions()
      .then((r) => !cancelled && setRows(r.suggestions.slice(0, 4)))
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="panel mini">
      <div className="panel-head">
        <h2>Suggested peers</h2>
        <span className="mini-tag">to grow reach</span>
      </div>
      {rows === null ? (
        <p className="muted empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted empty">No suggestions right now.</p>
      ) : (
        <div className="sug-list">
          {rows.map((s) => (
            <div className="sug-row" key={s.pubkey} title={s.reason}>
              <span className={`sug-score ${scoreClass(s.score)}`}>{Math.round(s.score)}</span>
              <span className="sug-alias">{s.alias || `${s.pubkey.slice(0, 12)}…`}</span>
              <span className="sug-size">~{satsCompact(s.recommendedSizeSats)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
