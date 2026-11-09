import { Fragment, useEffect, useState } from "react";
import { COPY_FAILED, copyText } from "../clipboard";
import { api } from "../api";
import { caretButtonProps } from "../a11y";
import type {
  ChannelSuggestion,
  NodeNeed,
  OpenChannelResult,
  SuggestionPolicy,
  SuggestionsResponse,
} from "../types";
import { sats, satsCompact } from "../format";
import { WRITE_MODE_HINT } from "../statusNotes";
import { useNodeChanges } from "../nodeNav";
import { NodeLink } from "./NodeLink";
import { NodeSearch } from "./NodeSearch";
import { OpenChannelForm, OpenResultLine } from "./OpenChannelForm";
import { useUi } from "./Overlay";
import { Scanning } from "./Scanning";
import { EmptyState } from "./Skeleton";
import { InfoTip } from "./InfoTip";

type NumKey = "count" | "minChannels" | "maxStaleDays";

const DEFAULTS = { count: 12, minChannels: 8, maxStaleDays: 21, requireClearnet: false };

const CONTROLS: { key: NumKey; label: string; hint: string }[] = [
  { key: "count", label: "How many", hint: "number of suggestions" },
  { key: "minChannels", label: "Min channels", hint: "candidate must have at least this many channels" },
  { key: "maxStaleDays", label: "Max stale (d)", hint: "only nodes seen within this many days" },
];

/** localRatio is the outbound share: ≥ 70 % local = short of inbound (an
 *  open adds outbound only), ≤ 30 % local = short of outbound (an open adds
 *  exactly that). Before, the two labels were swapped. */
export const NEED_LABEL: Record<NodeNeed, string> = {
  need_inbound: "Short of inbound — opens add outbound only",
  need_outbound: "Short of outbound — new channels add it",
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
  const ui = useUi();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="row-btn ghost"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(pubkey).then((ok) => {
          if (!ok) {
            ui.toast(COPY_FAILED, "error");
            return;
          }
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
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

  // "Never open automatically" set from a node's details: this list says so too.
  useNodeChanges(({ neverOpen }) => {
    if (!neverOpen) return;
    setData((d) => (d ? { ...d, suggestions: d.suggestions.map((x) => (x.pubkey === neverOpen.pubkey ? { ...x, neverOpen: neverOpen.never } : x)) } : d));
  });

  const startOpen = (s: ChannelSuggestion) => {
    setOpenFor(s.pubkey);
    setResult(null);
  };

  // The channel autopilot's "never open automatically" list — the row's
  // toggle; opening by hand stays possible.
  const toggleNeverOpen = async (s: ChannelSuggestion) => {
    try {
      await api.neverOpen(s.pubkey, !s.neverOpen, s.alias);
      setData((d) => (d ? { ...d, suggestions: d.suggestions.map((x) => (x.pubkey === s.pubkey ? { ...x, neverOpen: !s.neverOpen } : x)) } : d));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const rows: ChannelSuggestion[] = data?.suggestions ?? [];
  const ps = data?.portfolioSummary;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Channel suggestions
        </h2>
        {data ? <span className="muted">graph age {Math.round(data.graphAgeSec / 60)}m</span> : null}
      </div>

      <p className="muted lede">
        Peers where your node already sees demand.
        {canWrite ? null : (
          <> Opening is <strong>disabled</strong> — {WRITE_MODE_HINT}.</>
        )}
        <InfoTip label="How peers are scored">
          Scored locally from the LND graph <strong>and your own forwards</strong>: demand fit, quality of new reach, your node's
          current need, and portfolio diversity — not just where the graph looks big. <strong>Open</strong> funds a channel at the
          suggested size (editable).
        </InfoTip>
      </p>

      <NodeSearch />

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

      <div className="table-scroll">
<table className="fee-table feerec-table t-sug">
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
                  <td className="feerec-caret">
                    <button {...caretButtonProps(isOpen, () => toggle(s.pubkey), `Details: ${s.alias || s.pubkey.slice(0, 12)}`)}>{isOpen ? "▾" : "▸"}</button>
                  </td>
                  <td className="num strong">
                    <span className={`sug-score u-${s.usefulness}`}>{s.score}</span>
                  </td>
                  <td>
                    <div className="sug-peer">
                      <NodeLink pubkey={s.pubkey} alias={s.alias} /> {s.hasClearnet ? "🌐" : "🧅"}
                      {s.lnplus ? (
                        <a
                          className={`lnp-chip${s.lnplus.scoreEffectPct < 0 ? " neg" : ""}`}
                          href={s.lnplus.profileUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                          onClick={(e) => e.stopPropagation()}
                          title={`LN+ rank ${s.lnplus.rank}/10${s.lnplus.rankName ? ` (${s.lnplus.rankName})` : ""} · ${s.lnplus.positiveRatings} positive / ${s.lnplus.negativeRatings} negative ratings${s.lnplus.prime ? " · Prime" : ""} — moves this score by ${s.lnplus.scoreEffectPct > 0 ? "+" : ""}${s.lnplus.scoreEffectPct}%`}
                        >
                          LN+ {s.lnplus.rank}/10
                          {s.lnplus.prime ? " ★" : ""}
                        </a>
                      ) : null}
                    </div>
                    {s.badges.length || s.neverOpen ? (
                      <div className="sug-badges">
                        {s.neverOpen ? <span className="sug-badge warn">never auto-open</span> : null}
                        {s.badges.map((b) => (
                          <span key={b} className="sug-badge">{b}</span>
                        ))}
                      </div>
                    ) : null}
                    <div className="muted reason" title={s.reasons[0]}>{s.reasons[0]?.split(" — ")[0]}</div>
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
                        className="row-btn ghost"
                        title={
                          s.neverOpen
                            ? "Let the channel autopilot open to this peer again"
                            : "The channel autopilot never opens to this peer (you still can, by hand)"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleNeverOpen(s);
                        }}
                      >
                        {s.neverOpen ? "allow auto" : "never auto"}
                      </button>
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
                          {s.lnplus ? (
                            <span>
                              LN+ {s.lnplus.rankName || `rank ${s.lnplus.rank}`} · {s.lnplus.positiveRatings}
                              {" "}positive / {s.lnplus.negativeRatings} negative
                              {s.lnplus.prime ? " · Prime" : ""}
                              {s.lnplus.verified ? " · verified" : ""}
                              {" · "}
                              {s.lnplus.scoreEffectPct > 0 ? "+" : ""}
                              {s.lnplus.scoreEffectPct}% on this score
                            </span>
                          ) : null}
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
                      <OpenChannelForm
                        pubkey={s.pubkey}
                        alias={s.alias}
                        socket={s.socket}
                        initialSize={s.recommendedSizeSats}
                        onResult={(res) => {
                          setResult(res);
                          if (res.ok) setOpenFor(null);
                        }}
                        onCancel={() => setOpenFor(null)}
                      />
                    </td>
                  </tr>
                ) : null}
                {result && result.pubkey === s.pubkey ? (
                  <tr className="open-row">
                    <td></td>
                    <td colSpan={7}>
                      <OpenResultLine result={result} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
</div>
      {rows.length === 0 && !loading && !error ? (
        <EmptyState icon="🔍">No suggestions — try lowering “Min channels” or widening “Max stale”.</EmptyState>
      ) : null}
    </section>
  );
}
