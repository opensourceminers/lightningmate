import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import type { CloseCandidate, CloseCandidatesResponse, MagmaV2Report } from "../types";
import { satsCompact } from "../format";
import { CloseChannelDialog, type CloseTarget } from "./CloseChannelDialog";
import { EmptyState } from "./Skeleton";

const scoreClass = (s: number) => (s >= 55 ? "u-high" : s >= 35 ? "u-medium" : "u-low");

export function CloseCandidatesPanel() {
  const [data, setData] = useState<CloseCandidatesResponse | null>(null);
  const [closeTarget, setCloseTarget] = useState<CloseTarget | null>(null);
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

  const openClose = (c: CloseCandidate) =>
    setCloseTarget({
      peerAlias: c.alias,
      capacity: c.capacitySats,
      active: c.active,
      transactionId: c.transactionId,
      transactionVout: c.transactionVout,
    });

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
                        {c.opportunityCandidates.length ? <span className="sug-badge swap">⇄ swap</span> : null}
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
                        disabled={!canWrite}
                        onClick={(e) => {
                          e.stopPropagation();
                          openClose(c);
                        }}
                        title={canWrite ? "Close this channel" : "Enable writes to close"}
                      >
                        close
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
                              <b>{satsCompact(c.capitalFreedSats)}</b> · close cost <b>~{c.closeCostSat} sat</b>
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
                              <span className="muted">
                                ⇄ Swap — close this, open <strong>{c.opportunityCandidates[0].alias}</strong> with the
                                freed {satsCompact(c.capitalFreedSats)}:
                              </span>
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

      {closeTarget ? (
        <CloseChannelDialog
          channel={closeTarget}
          onCancel={() => setCloseTarget(null)}
          onClosed={() => {
            setCloseTarget(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}
