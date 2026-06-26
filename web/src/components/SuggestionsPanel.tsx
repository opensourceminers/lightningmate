import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type {
  ChannelSuggestion,
  NodeNeed,
  OpenChannelResult,
  SuggestionPolicy,
  SuggestionsResponse,
} from "../types";
import { sats, satsCompact } from "../format";
import { Scanning } from "./Scanning";
import { EmptyState } from "./Skeleton";

type NumKey = "count" | "minChannels" | "maxStaleDays";

const MIN_CHANNEL_SATS = 20_000;
const DEFAULTS = { count: 12, minChannels: 8, maxStaleDays: 21, requireClearnet: false };

const CONTROLS: { key: NumKey; label: string; hint: string }[] = [
  { key: "count", label: "How many", hint: "number of suggestions" },
  { key: "minChannels", label: "Min channels", hint: "candidate must have at least this many channels" },
  { key: "maxStaleDays", label: "Max stale (d)", hint: "only nodes seen within this many days" },
];

const NEED_LABEL: Record<NodeNeed, string> = {
  need_inbound: "Needs inbound liquidity",
  need_outbound: "Lots of local liquidity to deploy",
  need_routing_diversity: "Needs more routing diversity",
  need_revenue: "Needs more routing revenue",
  balanced: "Well balanced",
};

const BREAKDOWN: { key: keyof ChannelSuggestion; label: string }[] = [
  { key: "demandScore", label: "Demand" },
  { key: "weightedReachScore", label: "Quality reach" },
  { key: "graphScore", label: "Graph" },
  { key: "roleFitScore", label: "Role fit" },
  { key: "economicsScore", label: "Economics" },
];

function CopyButton({ pubkey }: { pubkey: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="row-btn ghost"
      onClick={(e) => {
        e.stopPropagation();
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  const toggle = (pk: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(pk)) n.delete(pk);
      else n.add(pk);
      return n;
    });

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
  const ps = data?.portfolioSummary;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Channel suggestions <span className="v2-badge">v2</span>
        </h2>
        {data ? <span className="muted">graph age {Math.round(data.graphAgeSec / 60)}m</span> : null}
      </div>

      <div className="dryrun-banner">
        Open channels where your node already sees demand — not just where the graph looks big. Scored locally from
        the LND graph <strong>and your own forwards</strong>: demand fit, quality of new reach, your node's current
        need, and portfolio diversity.
        {canWrite ? (
          <> Hit <strong>Open</strong> to fund a channel at the suggested size (editable).</>
        ) : (
          <> Opening is <strong>disabled</strong> (read-only) — enable writes in the Autopilot tab.</>
        )}
      </div>

      {data ? (
        <div className="sug-need">
          <span className={`sug-need-tag need-${data.nodeNeed}`}>{NEED_LABEL[data.nodeNeed]}</span>
          <span className="muted">{data.nodeNeedReason}</span>
          {!data.hasDemandData ? (
            <span className="sug-need-note">no forwards yet — ranking on graph topology until you route</span>
          ) : null}
        </div>
      ) : null}

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
          {loading ? "Analyzing…" : "Refresh"}
        </button>
      </div>

      {ps && rows.length ? (
        <div className="feerec-chips">
          <span className="feerec-chip s-good">{ps.selectedCount} suggestions</span>
          <span className="feerec-chip s-explore">+{ps.estimatedNewReach} new reach</span>
          {data?.hasDemandData ? (
            <span className="feerec-chip s-cost">{ps.demandCoveragePct}% demand covered</span>
          ) : null}
          <span className="feerec-bench muted">diversified across clusters · sized to your node</span>
        </div>
      ) : null}

      {loading ? <Scanning label="SCANNING THE NETWORK GRAPH" /> : null}
      {error ? <p className="banner error">{error}</p> : null}

      <table className="fee-table feerec-table">
        <thead>
          <tr>
            <th></th>
            <th className="num">Score</th>
            <th>Peer</th>
            <th className="num">Demand</th>
            <th className="num">New reach</th>
            <th className="num">Avg fee</th>
            <th className="num">Suggested</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const isOpen = expanded.has(s.pubkey);
            return (
              <Fragment key={s.pubkey}>
                <tr className="feerec-row" onClick={() => toggle(s.pubkey)}>
                  <td className="feerec-caret">{isOpen ? "▾" : "▸"}</td>
                  <td className="num strong">
                    <span className={`sug-score u-${s.usefulness}`}>{s.score}</span>
                  </td>
                  <td>
                    <div className="sug-peer">
                      {s.alias} {s.hasClearnet ? "🌐" : "🧅"}
                    </div>
                    {s.badges.length ? (
                      <div className="sug-badges">
                        {s.badges.map((b) => (
                          <span key={b} className="sug-badge">{b}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="muted reason">{s.reasons[0]}</div>
                  </td>
                  <td className="num strong" title="share of your outbound flow whose neighbourhood this touches">
                    {data?.hasDemandData ? (s.demandFlowSharePct > 0 ? `${s.demandFlowSharePct}%` : "—") : "n/a"}
                  </td>
                  <td className="num" title="new 2-hop destinations · high-quality routers">
                    {s.newReach > 0 ? <>+{s.newReach}</> : "—"}
                    {s.qualityReachCount > 0 ? <span className="muted"> · {s.qualityReachCount}★</span> : null}
                  </td>
                  <td className="num">{s.avgFeePpm} ppm</td>
                  <td className="num strong">{sats(s.recommendedSizeSats)}</td>
                  <td>
                    <div className="row-actions">
                      <CopyButton pubkey={s.pubkey} />
                      <button
                        className="row-btn"
                        disabled={!canWrite}
                        title={canWrite ? "Open a channel to this peer" : "Enable writes to open"}
                        onClick={(e) => {
                          e.stopPropagation();
                          openFor === s.pubkey ? setOpenFor(null) : startOpen(s);
                        }}
                      >
                        Open
                      </button>
                    </div>
                  </td>
                </tr>

                {isOpen ? (
                  <tr className="feerec-detail-row">
                    <td></td>
                    <td colSpan={7}>
                      <div className="feerec-detail">
                        <div className="sug-bd">
                          {BREAKDOWN.map((b) => {
                            const v = Number(s[b.key]) || 0;
                            return (
                              <div key={b.key} className="sug-bar-row">
                                <span className="sug-bar-label">{b.label}</span>
                                <span className="sug-bar"><i style={{ width: `${Math.round(v * 100)}%` }} /></span>
                                <span className="sug-bar-val">{v.toFixed(2)}</span>
                              </div>
                            );
                          })}
                        </div>
                        <div className="feerec-reasons">
                          {s.reasons.map((r, i) => (
                            <div key={i}>• {r}</div>
                          ))}
                          {s.warnings.map((w, i) => (
                            <div key={`w${i}`} className="sug-warn">⚠ {w}</div>
                          ))}
                        </div>
                        <div className="feerec-metrics">
                          <span>{s.channels} channels · {satsCompact(s.capacitySats)} total · {satsCompact(s.avgChannelSats)} avg</span>
                          <span>seen {s.lastSeenDays}d ago · {s.demandOverlapCount} demand-node overlap</span>
                          <span className="muted">{s.sizeReason}</span>
                        </div>
                      </div>
                    </td>
                  </tr>
                ) : null}

                {openFor === s.pubkey ? (
                  <tr className="open-row">
                    <td></td>
                    <td colSpan={7}>
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
                        <button className="primary-btn" disabled={opening || size < MIN_CHANNEL_SATS} onClick={() => submitOpen(s)}>
                          {opening ? "Opening…" : `Open ${satsCompact(size)} sat channel`}
                        </button>
                        <button className="reset" disabled={opening} onClick={() => setOpenFor(null)}>Cancel</button>
                        {!s.socket ? <span className="muted">no address known — may fail to connect</span> : null}
                        <span className="open-warn">⚠ real on-chain transaction</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
                {result && result.pubkey === s.pubkey ? (
                  <tr className="open-row">
                    <td></td>
                    <td colSpan={7}>
                      {result.ok ? (
                        <span className="open-ok">✓ Channel opening — funding tx {result.transactionId?.slice(0, 16)}…</span>
                      ) : (
                        <span className="ap-fail">✗ {result.error}</span>
                      )}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && !loading && !error ? (
        <EmptyState icon="🔍">No suggestions — try lowering “Min channels” or widening “Max stale”.</EmptyState>
      ) : null}
    </section>
  );
}
