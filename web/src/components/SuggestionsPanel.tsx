import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChannelSuggestion, SuggestionPolicy, SuggestionsResponse } from "../types";
import { sats, satsCompact } from "../format";

type NumKey = "count" | "minChannels" | "maxStaleDays";

const DEFAULTS = {
  count: 12,
  minChannels: 8,
  maxStaleDays: 21,
  requireClearnet: false,
};

const CONTROLS: { key: NumKey; label: string; hint: string }[] = [
  { key: "count", label: "How many", hint: "number of suggestions" },
  { key: "minChannels", label: "Min channels", hint: "candidate must have at least this many channels" },
  { key: "maxStaleDays", label: "Max stale (d)", hint: "only nodes seen within this many days" },
];

function CopyButton({ pubkey }: { pubkey: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="row-btn"
      onClick={() => {
        void navigator.clipboard.writeText(pubkey);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={pubkey}
    >
      {copied ? "copied" : "copy key"}
    </button>
  );
}

export function SuggestionsPanel() {
  const [draft, setDraft] = useState(DEFAULTS);
  const [data, setData] = useState<SuggestionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (policy: Partial<SuggestionPolicy>) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.suggestions(policy));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(DEFAULTS);
  }, []);

  const setNum = (key: NumKey, value: number) =>
    setDraft((d) => ({ ...d, [key]: Math.max(0, value || 0) }));

  const rows: ChannelSuggestion[] = data?.suggestions ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Channel suggestions <span className="muted">· from the network graph</span></h2>
        {data ? (
          <span className="muted">graph age {Math.round(data.graphAgeSec / 60)}m</span>
        ) : null}
      </div>

      <div className="dryrun-banner">
        Best peers to open channels to, scored locally from the LND graph — no external
        service. Ranked by <strong>connectivity, capacity, activity, reachability and
        fees</strong>, excluding peers you already have, with a suggested channel size
        scaled to your node.
      </div>

      <div className="policy-controls">
        {CONTROLS.map((c) => (
          <label key={c.key} className="policy-field" title={c.hint}>
            <span>{c.label}</span>
            <input
              type="number"
              min={0}
              value={draft[c.key]}
              onChange={(e) => setNum(c.key, Number(e.target.value))}
            />
          </label>
        ))}
        <label className="check" title="only nodes reachable over clearnet">
          <input
            type="checkbox"
            checked={draft.requireClearnet}
            onChange={(e) => setDraft((d) => ({ ...d, requireClearnet: e.target.checked }))}
          />
          clearnet only
        </label>
        <button className="primary-btn" disabled={loading} onClick={() => load(draft)}>
          {loading ? "Analyzing graph…" : "Refresh"}
        </button>
      </div>

      {loading && !data ? (
        <p className="muted empty">Analyzing the network graph — this can take a moment…</p>
      ) : null}
      {error ? <p className="banner error">{error}</p> : null}

      <table className="fee-table">
        <thead>
          <tr>
            <th className="num">Score</th>
            <th>Peer</th>
            <th className="num">Channels</th>
            <th className="num">Capacity</th>
            <th className="num">Avg fee</th>
            <th>Reach</th>
            <th className="num">Suggested size</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.pubkey}>
              <td className="num strong">{s.score}</td>
              <td>
                {s.alias}
                <div className="muted reason">{s.reason}</div>
              </td>
              <td className="num">{s.channels}</td>
              <td className="num">{satsCompact(s.capacitySats)}</td>
              <td className="num">{s.avgFeePpm} ppm</td>
              <td>{s.hasClearnet ? "🌐" : "🧅"}</td>
              <td className="num strong">{sats(s.recommendedSizeSats)}</td>
              <td><CopyButton pubkey={s.pubkey} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !loading && !error ? (
        <p className="muted empty">No suggestions — try lowering “Min channels” or widening “Max stale”.</p>
      ) : null}
    </section>
  );
}
