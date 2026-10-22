import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChannelForwardStat } from "../types";
import { topChannels, topChannelValue } from "../analyticsView";
import { Sparkline } from "./Sparkline";

export function TopChannelsTile({ onOpen }: { onOpen?: () => void }) {
  const [rows, setRows] = useState<ChannelForwardStat[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .forwardsReport(30)
        .then((r) => {
          if (cancelled) return;
          // Ranked by what each earned out PLUS what it brought in: the
          // source of the best route is a top channel too.
          setRows(topChannels(r.perChannel, 5));
        })
        .catch(() => !cancelled && setRows((cur) => cur ?? []));
    load();
    const id = setInterval(load, 120_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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
      {rows === null ? (
        <p className="muted empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted empty">No routing fees yet.</p>
      ) : (
        <div className="top-list">
          {rows.map((r, i) => {
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
    </section>
  );
}
