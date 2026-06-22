import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type {
  ChannelSuggestion,
  OpenChannelResult,
  SuggestionPolicy,
  SuggestionsResponse,
} from "../types";
import { sats, satsCompact } from "../format";

type NumKey = "count" | "minChannels" | "maxStaleDays";

const MIN_CHANNEL_SATS = 20_000;

const DEFAULTS = { count: 12, minChannels: 8, maxStaleDays: 21, requireClearnet: false };

const CONTROLS: { key: NumKey; label: string; hint: string }[] = [
  { key: "count", label: "How many", hint: "number of suggestions" },
  { key: "minChannels", label: "Min channels", hint: "candidate must have at least this many channels" },
  { key: "maxStaleDays", label: "Max stale (d)", hint: "only nodes seen within this many days" },
];

function CopyButton({ pubkey }: { pubkey: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="row-btn ghost"
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
  const [canWrite, setCanWrite] = useState(false);

  // Open-channel flow state
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [size, setSize] = useState(0);
  const [opening, setOpening] = useState(false);
  const [result, setResult] = useState<OpenChannelResult | null>(null);

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
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
  }, []);

  const setNum = (key: NumKey, value: number) =>
    setDraft((d) => ({ ...d, [key]: Math.max(0, value || 0) }));

  const startOpen = (s: ChannelSuggestion) => {
    setOpenFor(s.pubkey);
    setSize(s.recommendedSizeSats);
    setResult(null);
  };

  const submitOpen = async (s: ChannelSuggestion) => {
    setOpening(true);
    setResult(null);
    try {
      const res = await api.channelOpen({ pubkey: s.pubkey, socket: s.socket, localTokens: size });
      setResult(res);
      if (res.ok) setOpenFor(null);
    } catch (e) {
      setResult({ ok: false, pubkey: s.pubkey, localTokens: size, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setOpening(false);
    }
  };

  const rows: ChannelSuggestion[] = data?.suggestions ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Channel suggestions <span className="muted">· from the network graph</span></h2>
        {data ? <span className="muted">graph age {Math.round(data.graphAgeSec / 60)}m</span> : null}
      </div>

      <div className="dryrun-banner">
        Best peers to open channels to, scored locally from the LND graph (0–100 =
        how well they fit on <strong>connectivity, capacity, activity, reachability
        and fees</strong>), excluding peers you already have.
        {canWrite ? (
          <> Hit <strong>Open</strong> to fund a channel at the suggested size (editable).</>
        ) : (
          <> Opening is <strong>disabled</strong> (read-only) — enable writes in the Autopilot tab.</>
        )}
      </div>

      <div className="policy-controls">
        {CONTROLS.map((c) => (
          <label key={c.key} className="policy-field" title={c.hint}>
            <span>{c.label}</span>
            <input type="number" min={0} value={draft[c.key]} onChange={(e) => setNum(c.key, Number(e.target.value))} />
          </label>
        ))}
        <label className="check" title="only nodes reachable over clearnet">
          <input type="checkbox" checked={draft.requireClearnet} onChange={(e) => setDraft((d) => ({ ...d, requireClearnet: e.target.checked }))} />
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
            <th className="num">Suggested</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <Fragment key={s.pubkey}>
              <tr>
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
                <td>
                  <div className="row-actions">
                    <CopyButton pubkey={s.pubkey} />
                    <button
                      className="row-btn"
                      disabled={!canWrite}
                      title={canWrite ? "Open a channel to this peer" : "Enable writes to open"}
                      onClick={() => (openFor === s.pubkey ? setOpenFor(null) : startOpen(s))}
                    >
                      Open
                    </button>
                  </div>
                </td>
              </tr>
              {openFor === s.pubkey ? (
                <tr className="open-row">
                  <td colSpan={8}>
                    <div className="open-form">
                      <span>Open channel to <strong>{s.alias}</strong></span>
                      <label className="policy-field inline">
                        <span>Size (sat)</span>
                        <input
                          type="number"
                          min={MIN_CHANNEL_SATS}
                          step={100_000}
                          value={size}
                          onChange={(e) => setSize(Math.max(0, Number(e.target.value) || 0))}
                        />
                      </label>
                      <button
                        className="primary-btn"
                        disabled={opening || size < MIN_CHANNEL_SATS}
                        onClick={() => submitOpen(s)}
                      >
                        {opening ? "Opening…" : `Open ${satsCompact(size)} sat channel`}
                      </button>
                      <button className="reset" disabled={opening} onClick={() => setOpenFor(null)}>
                        Cancel
                      </button>
                      {!s.socket ? <span className="muted">no address known — may fail to connect</span> : null}
                      <span className="open-warn">⚠ real on-chain transaction</span>
                    </div>
                  </td>
                </tr>
              ) : null}
              {result && result.pubkey === s.pubkey ? (
                <tr className="open-row">
                  <td colSpan={8}>
                    {result.ok ? (
                      <span className="open-ok">✓ Channel opening — funding tx {result.transactionId?.slice(0, 16)}…</span>
                    ) : (
                      <span className="ap-fail">✗ {result.error}</span>
                    )}
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !loading && !error ? (
        <p className="muted empty">No suggestions — try lowering “Min channels” or widening “Max stale”.</p>
      ) : null}
    </section>
  );
}
