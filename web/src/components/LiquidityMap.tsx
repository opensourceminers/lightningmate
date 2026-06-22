import type { ChannelView } from "../types";
import { percent, satsCompact } from "../format";

/** One glance at where your liquidity sits — every active channel as a bar,
 *  width = capacity, orange fill = local (outbound) share. */
export function LiquidityMap({ channels }: { channels: ChannelView[] }) {
  const active = channels.filter((c) => c.active);
  if (active.length === 0) return null;

  const sorted = [...active].sort((a, b) => b.capacity - a.capacity);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Liquidity map <span className="muted">· {active.length} active channels</span></h2>
      </div>
      <div className="liqmap">
        {sorted.map((c) => (
          <div
            className="liqmap-cell"
            key={c.id}
            style={{ flexGrow: c.capacity }}
            title={`${c.peerAlias} · ${percent(c.localRatio)} local · ${satsCompact(c.capacity)} sat`}
          >
            <div className="liqmap-local" style={{ height: `${c.localRatio * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="liqmap-legend">
        <span><i className="sw local" /> local (outbound)</span>
        <span><i className="sw remote" /> remote (inbound)</span>
      </div>
    </section>
  );
}
