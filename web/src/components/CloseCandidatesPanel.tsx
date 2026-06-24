import { useEffect, useState } from "react";
import { api } from "../api";
import type { CloseCandidate } from "../types";
import { satsCompact } from "../format";
import { useUi } from "./Overlay";
import { EmptyState } from "./Skeleton";

export function CloseCandidatesPanel() {
  const { toast, confirm } = useUi();
  const [closeData, setCloseData] = useState<CloseCandidate[]>([]);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);

  const loadClose = () =>
    api.closeCandidates().then((d) => setCloseData(d.candidates)).catch(() => {});

  useEffect(() => {
    void loadClose();
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
  }, []);

  const closeChannel = async (c: CloseCandidate) => {
    const how = c.active ? "Cooperatively close" : "Force-close (offline peer)";
    const ok = await confirm({
      title: "Close channel",
      message: `${how} the channel with ${c.alias}? This is an on-chain transaction.`,
      confirmLabel: "Close channel",
      danger: true,
    });
    if (!ok) return;
    setClosingId(c.channelId);
    try {
      const r = await api.channelClose(c.transactionId, c.transactionVout, !c.active);
      if (r.ok) {
        toast(`Closing channel — funding ${r.transactionId?.slice(0, 12)}…`, "success");
        await loadClose();
      } else {
        toast(`Close failed: ${r.error}`, "error");
      }
    } catch (e) {
      toast(`Close failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      setClosingId(null);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Channels to close <span className="muted">· idle / unproductive</span></h2>
      </div>
      <div className="dryrun-banner">
        Channels not pulling their weight — offline, never routed, or idle for the
        lookback window. Closing frees the capital to redeploy.
        {canWrite ? null : <> Closing is <strong>disabled</strong> (read-only).</>}
      </div>
      {closeData.length === 0 ? (
        <EmptyState icon="✅">No idle channels — every active channel has routed.</EmptyState>
      ) : (
        <table className="fee-table">
          <thead>
            <tr>
              <th>Peer</th>
              <th className="num">Capacity</th>
              <th className="num">Local</th>
              <th className="num">Forwards</th>
              <th className="num">Fees</th>
              <th>Why</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {closeData.map((c) => (
              <tr key={c.channelId} className={c.active ? "" : "inactive"}>
                <td>{c.alias}</td>
                <td className="num">{satsCompact(c.capacitySats)}</td>
                <td className="num">{Math.round(c.localRatio * 100)}%</td>
                <td className="num">{c.forwards}</td>
                <td className="num">{c.feesEarnedSats}</td>
                <td className="muted reason">{c.reason}</td>
                <td>
                  <button
                    className="row-btn ghost danger"
                    disabled={!canWrite || closingId !== null}
                    onClick={() => closeChannel(c)}
                    title={canWrite ? "Close this channel" : "Enable writes to close"}
                  >
                    {closingId === c.channelId ? "…" : "close"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
