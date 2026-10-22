import { api } from "../api";
import { topChannelValue, topChannelsState } from "../analyticsView";
import { usePolledData } from "../usePolledData";
import { Sparkline } from "./Sparkline";

export function TopChannelsTile({ onOpen }: { onOpen?: () => void }) {
  // Every 2 min while the page is visible (30 days of forwards each time).
  const report = usePolledData(() => api.forwardsReport(30), 120_000);
  // Ranked by what each earned out PLUS what it brought in: the source of
  // the best route is a top channel too. A failed read says so — it is no
  // "No routing fees yet" — and older rows say when they are from.
  const view = topChannelsState(report);

  return (
    <section
      className="panel mini clickable"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen?.()}
      title="Open routing report"
    >
      <div className="panel-head">
        <h2>Top channels</h2>
        <span className="mini-tag" title="Fees earned on forwards out of the channel, plus those of forwards that came in through it">
          30d · earned + brought in
        </span>
        <span className="tile-go" aria-hidden>↗</span>
      </div>
      {view.kind === "loading" ? (
        <p className="muted empty">Loading…</p>
      ) : view.kind === "error" ? (
        <p className="banner error">{view.text}</p>
      ) : (
        <>
          {view.stale ? <p className="banner error">{view.stale}</p> : null}
          {view.rows.length === 0 ? (
            <p className="muted empty">No routing fees yet.</p>
          ) : (
            <div className="top-list">
              {view.rows.map((r, i) => {
                const v = topChannelValue(r);
                return (
                  <div className="top-row" key={r.channelId} title={`${r.forwardCount} forwards out · ${r.inboundForwardCount ?? 0} in${v.assisted ? ` · ${v.assisted}` : ""}`}>
                    <span className="top-rank">{i + 1}</span>
                    <span className="top-alias">{r.alias || r.channelId}</span>
                    <span className="top-spark">
                      <Sparkline data={r.spark} width={46} height={16} color="var(--green)" />
                    </span>
                    <span className="top-val">
                      {v.earned} <span className="top-unit">sat</span>
                      {v.assisted ? <span className="top-unit"> {v.assisted}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
