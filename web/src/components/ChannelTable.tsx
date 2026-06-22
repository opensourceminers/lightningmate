import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChannelOverride, ChannelRole, ChannelView, FeeMode, OverrideMap } from "../types";
import { satsCompact } from "../format";

const ROLE_LABEL: Record<ChannelRole, string> = {
  source: "source",
  sink: "sink",
  router: "router",
};

function BalanceBar({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  return (
    <div className="bal-bar" title={`${pct}% local`}>
      <div className="bal-local" style={{ width: `${pct}%` }} />
      <span className="bal-pct">{pct}%</span>
    </div>
  );
}

function OverrideControl({
  ov,
  onSet,
}: {
  ov?: ChannelOverride;
  onSet: (mode: FeeMode, fixedPpm?: number) => void;
}) {
  const mode = ov?.mode ?? "auto";
  const [ppm, setPpm] = useState(ov?.fixedPpm ?? 100);
  return (
    <div className="ov">
      <select
        value={mode}
        onChange={(e) => {
          const m = e.target.value as FeeMode;
          onSet(m, m === "fixed" ? ppm : undefined);
        }}
      >
        <option value="auto">auto</option>
        <option value="fixed">fixed</option>
        <option value="exclude">exclude</option>
      </select>
      {mode === "fixed" ? (
        <input
          type="number"
          className="ov-ppm"
          min={0}
          value={ppm}
          onChange={(e) => setPpm(Math.max(0, Number(e.target.value) || 0))}
          onBlur={() => onSet("fixed", ppm)}
          title="fixed ppm"
        />
      ) : null}
    </div>
  );
}

type SortKey = "capacity" | "localRatio" | "totalSent" | "totalReceived";

export function ChannelTable({ channels }: { channels: ChannelView[] }) {
  const [sort, setSort] = useState<SortKey>("capacity");
  const [onlyActive, setOnlyActive] = useState(false);
  const [overrides, setOverrides] = useState<OverrideMap>({});

  useEffect(() => {
    api.overrides().then(setOverrides).catch(() => {});
  }, []);

  const applyOverride = (id: string, mode: FeeMode, fixedPpm?: number) => {
    api.setOverride(id, mode, fixedPpm).then(setOverrides).catch(() => {});
  };

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
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
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
            <th>Autopilot fee</th>
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
              <td>
                <OverrideControl
                  ov={overrides[c.id]}
                  onSet={(mode, ppm) => applyOverride(c.id, mode, ppm)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? <p className="muted empty">No channels to show.</p> : null}
      <p className="hint">
        <strong>Roles</strong>: <em>source</em> mostly receives, <em>sink</em> mostly sends,
        <em> router</em> is balanced. <strong>Autopilot fee</strong>: <code>auto</code> follows the
        policy, <code>fixed</code> pins a ppm, <code>exclude</code> keeps the autopilot off this channel.
      </p>
    </section>
  );
}
