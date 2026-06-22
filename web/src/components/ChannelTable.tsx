import { useState } from "react";
import type { ChannelRole, ChannelView } from "../types";
import { satsCompact } from "../format";

const ROLE_LABEL: Record<ChannelRole, string> = {
  source: "source",
  sink: "sink",
  router: "router",
};

function BalanceBar({ ratio }: { ratio: number }) {
  // Color shifts from red (drained outbound) → green (balanced) → blue (full).
  const pct = Math.round(ratio * 100);
  return (
    <div className="bal-bar" title={`${pct}% local`}>
      <div className="bal-local" style={{ width: `${pct}%` }} />
      <span className="bal-pct">{pct}%</span>
    </div>
  );
}

type SortKey = "capacity" | "localRatio" | "totalSent" | "totalReceived";

export function ChannelTable({ channels }: { channels: ChannelView[] }) {
  const [sort, setSort] = useState<SortKey>("capacity");
  const [onlyActive, setOnlyActive] = useState(false);

  const rows = channels
    .filter((c) => (onlyActive ? c.active : true))
    .slice()
    .sort((a, b) => b[sort] - a[sort]);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Channels <span className="muted">({rows.length})</span></h2>
        <div className="controls">
          <label className="check">
            <input
              type="checkbox"
              checked={onlyActive}
              onChange={(e) => setOnlyActive(e.target.checked)}
            />
            active only
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="capacity">sort: capacity</option>
            <option value="localRatio">sort: local %</option>
            <option value="totalSent">sort: routed out</option>
            <option value="totalReceived">sort: routed in</option>
          </select>
        </div>
      </div>

      <table className="channels">
        <thead>
          <tr>
            <th>Peer</th>
            <th>Role</th>
            <th className="num">Capacity</th>
            <th className="bal-col">Local ⟷ Remote</th>
            <th className="num">Sent</th>
            <th className="num">Received</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className={c.active ? "" : "inactive"}>
              <td>
                <span className={`status ${c.active ? "on" : "off"}`} />
                {c.peerAlias}
                {c.private ? <span className="tag">priv</span> : null}
              </td>
              <td>
                <span className={`role role-${c.role}`}>{ROLE_LABEL[c.role]}</span>
              </td>
              <td className="num">{satsCompact(c.capacity)}</td>
              <td className="bal-col"><BalanceBar ratio={c.localRatio} /></td>
              <td className="num">{satsCompact(c.totalSent)}</td>
              <td className="num">{satsCompact(c.totalReceived)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="muted empty">No channels to show.</p> : null}
      <p className="hint">
        <strong>Roles</strong> are flow heuristics: <em>source</em> mostly receives
        (keep fees low), <em>sink</em> mostly sends (raise fees), <em>router</em> is
        balanced. Use <code>local %</code> to spot drained channels.
      </p>
    </section>
  );
}
