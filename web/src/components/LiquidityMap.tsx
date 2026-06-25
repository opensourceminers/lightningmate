import type { ChannelView } from "../types";
import { percent, satsCompact } from "../format";

/** One glance at where your liquidity sits — every active channel as a column,
 *  width = capacity, orange (local/outbound) filling up from the bottom against a
 *  blue (remote/inbound) track. Sorted by balance so the shape reads as a slope
 *  from outbound-heavy to inbound-heavy, with a dashed 50% reference line. */
export function LiquidityMap({ channels }: { channels: ChannelView[] }) {
  const active = channels.filter((c) => c.active);
  if (active.length === 0) return null;

  const sorted = [...active].sort((a, b) => b.localRatio - a.localRatio);
  const totalLocal = active.reduce((s, c) => s + c.localBalance, 0);
  const settled = active.reduce((s, c) => s + c.localBalance + c.remoteBalance, 0);
  const outPct = settled > 0 ? Math.round((totalLocal / settled) * 100) : 0;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          Liquidity map <span className="muted">· {active.length} channels</span>
        </h2>
        <span className="mini-tag">{outPct}% outbound</span>
      </div>
      <div className="liqmap">
        <span className="liqmap-mid" />
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
        <span><i className="sw local" /> local · outbound (can send)</span>
        <span><i className="sw remote" /> remote · inbound (can receive)</span>
      </div>
    </section>
  );
}
