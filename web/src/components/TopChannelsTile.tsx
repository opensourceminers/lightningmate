import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChannelForwardStat } from "../types";
import { sats } from "../format";
import { Sparkline } from "./Sparkline";

export function TopChannelsTile() {
  const [rows, setRows] = useState<ChannelForwardStat[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .forwardsReport(30)
        .then((r) => {
          if (cancelled) return;
          setRows(
            [...r.perChannel]
              .filter((c) => c.feesEarnedSats > 0)
              .sort((a, b) => b.feesEarnedSats - a.feesEarnedSats)
              .slice(0, 4),
          );
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
    <section className="panel mini">
      <div className="panel-head">
        <h2>Top channels</h2>
        <span className="mini-tag">30d · earned</span>
      </div>
      {rows === null ? (
        <p className="muted empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted empty">No routing fees yet.</p>
      ) : (
        <div className="top-list">
          {rows.map((r, i) => (
            <div className="top-row" key={r.channelId} title={`${r.forwardCount} forwards`}>
              <span className="top-rank">{i + 1}</span>
              <span className="top-alias">{r.alias || r.channelId}</span>
              <span className="top-spark">
                <Sparkline data={r.spark} width={46} height={16} color="var(--green)" />
              </span>
              <span className="top-val">
                {sats(r.feesEarnedSats)} <span className="top-unit">sat</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
