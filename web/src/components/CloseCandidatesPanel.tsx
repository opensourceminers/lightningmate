import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type { CloseCandidate, CloseCandidatesResponse, MagmaV2Report } from "../types";
import { satsCompact } from "../format";
import { useUi } from "./Overlay";
import { EmptyState } from "./Skeleton";

const scoreClass = (s: number) => (s >= 55 ? "u-high" : s >= 35 ? "u-medium" : "u-low");

export function CloseCandidatesPanel() {
  const { toast, confirm } = useUi();
  const [data, setData] = useState<CloseCandidatesResponse | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [magma, setMagma] = useState<MagmaV2Report | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const load = () => api.closeCandidates().then(setData).catch(() => {});

  useEffect(() => {
    void load();
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
    api.magmaRecommendations().then(setMagma).catch(() => {});
  }, []);

  const closeChannel = async (c: CloseCandidate) => {
    const how = c.active ? "Cooperatively close" : "Force-close (offline peer)";
    const inbound = c.inboundLiquidityLostSats > 0 ? ` You'd give up ${satsCompact(c.inboundLiquidityLostSats)} of inbound.` : "";
    const ok = await confirm({
      title: "Close channel",
      message: `${how} the channel with ${c.alias}? Frees ~${satsCompact(c.capitalFreedSats)} on-chain.${inbound} This is an on-chain transaction.`,
      confirmLabel: "Close channel",
      danger: true,
    });
    if (!ok) return;
    setClosingId(c.channelId);
    try {
      const r = await api.channelClose(c.transactionId, c.transactionVout, !c.active);
      if (r.ok) {
        toast(`Closing channel — funding ${r.transactionId?.slice(0, 12)}…`, "success");
        await load();
      } else {
        toast(`Close failed: ${r.error}`, "error");
      }
    } catch (e) {
      toast(`Close failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setClosingId(null);
    }
  };

  const rows = data?.candidates ?? [];

  return (
    <section className="panel feerec">
      <div className="panel-head">
        <h2>
          Channels to close <span className="v2-badge">v2</span>
        </h2>
        {data ? (
          <span className="muted">
            {data.protectedCount} protected · ~{satsCompact(data.totalCapitalFreedSats)} freeable
          </span>
        ) : null}
      </div>

      <div className="dryrun-banner">
        Dead-weight channels worth closing — judged on real flow, P&amp;L, weak-peer signals and how much unique reach
        they actually add. Honest about what a close <strong>frees</strong>: you only ever reclaim your local balance,
        and a channel the peer opened to you gives up free inbound.
        {canWrite ? null : <> Closing is <strong>disabled</strong> (read-only).</>}
      </div>

      {data && data.totalCapitalFreedSats > 0 && magma?.sell.recommendations[0]?.economics.beatsRouting && magma.sell.state !== "not_recommended_node_needs_inbound" ? (
        <div className="magma-crosslink">
          💡 Closing these frees ~{satsCompact(data.totalCapitalFreedSats)} — Magma leasing currently yields ~
          {magma.sell.recommendations[0].economics.leaseApy}% APY vs ~
          {(magma.sell.adjustedRoutingPpmPerYear / 10000).toFixed(2)}% routing. Consider listing freed capital on Magma
          (Market → Sell).
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState icon="✅">Nothing to close — every channel is earning, reachable or strategic.</EmptyState>
      ) : (
        <table className="fee-table feerec-table">
          <thead>
            <tr>
              <th></th>
              <th className="num">Close</th>
              <th>Peer</th>
              <th className="num">Frees</th>
              <th className="num">Inbound lost</th>
              <th className="num">P&amp;L 60d</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const isOpen = open.has(c.channelId);
              return (
                <Fragment key={c.channelId}>
                  <tr className={`feerec-row ${c.active ? "" : "inactive"}`} onClick={() => toggle(c.channelId)}>
                    <td className="feerec-caret">{isOpen ? "▾" : "▸"}</td>
                    <td className="num strong">
                      <span className={`sug-score ${scoreClass(c.closeScore)}`}>{c.closeScore}</span>
                    </td>
                    <td>
                      <div className="sug-peer">
                        {c.alias} {c.active ? "" : <span className="muted">· offline</span>}
                      </div>
                      <div className="sug-badges">
                        <span className="sug-badge">{c.weOpened ? "you funded" : "peer-opened"}</span>
                        {c.warnings.length ? <span className="sug-badge warn">⚠ {c.warnings.length}</span> : null}
                      </div>
                      <div className="muted reason">{c.reasons[0]}</div>
                    </td>
                    <td className="num strong">{satsCompact(c.capitalFreedSats)}</td>
                    <td className="num">{c.inboundLiquidityLostSats > 0 ? satsCompact(c.inboundLiquidityLostSats) : "—"}</td>
                    <td className={`num ${c.pnl60dSats < 0 ? "cost" : c.pnl60dSats > 0 ? "green" : ""}`}>
                      {c.pnl60dSats === 0 ? "—" : `${c.pnl60dSats > 0 ? "+" : ""}${c.pnl60dSats}`}
                    </td>
                    <td>
                      <button
                        className="row-btn ghost danger"
                        disabled={!canWrite || closingId !== null}
                        onClick={(e) => {
                          e.stopPropagation();
                          void closeChannel(c);
                        }}
                        title={canWrite ? "Close this channel" : "Enable writes to close"}
                      >
                        {closingId === c.channelId ? "…" : "close"}
                      </button>
                    </td>
                  </tr>

                  {isOpen ? (
                    <tr className="feerec-detail-row">
                      <td></td>
                      <td colSpan={6}>
                        <div className="feerec-detail">
                          <div className="feerec-reasons">
                            {c.reasons.map((r, i) => (
                              <div key={i}>• {r}</div>
                            ))}
                            {c.warnings.map((w, i) => (
                              <div key={`w${i}`} className="sug-warn">⚠ {w}</div>
                            ))}
                          </div>
                          <div className="feerec-metrics">
                            <span>
                              capacity <b>{satsCompact(c.capacitySats)}</b> · local <b>{satsCompact(c.localSats)}</b> · frees{" "}
                              <b>{satsCompact(c.capitalFreedSats)}</b>
                            </span>
                            <span>
                              {c.forwards60d} forwards / 60d · {satsCompact(c.flow60dSats)} routed · P&amp;L 30d{" "}
                              {c.pnl30dSats >= 0 ? "+" : ""}
                              {c.pnl30dSats}
                            </span>
                            <span>
                              unique reach lost {c.uniqueReachLost} ({Math.round(c.reachContribution * 100)}%) ·{" "}
                              {c.ageDays != null ? `${c.ageDays}d old` : "age unknown"} · {c.feeV2State}
                            </span>
                          </div>
                          {c.opportunityCandidates.length ? (
                            <div className="close-redeploy">
                              <span className="muted">Redeploy {satsCompact(c.capitalFreedSats)} into:</span>
                              {c.opportunityCandidates.map((o) => (
                                <span key={o.alias} className="sug-badge">
                                  {o.alias} ({o.score}) · ~{satsCompact(o.sizeSats)}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
