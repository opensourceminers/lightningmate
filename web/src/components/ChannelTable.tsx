import { useEffect, useState } from "react";
import { api } from "../api";
import type { ChannelOverride, ChannelRole, ChannelView, FeeMode, OverrideMap } from "../types";
import { satsCompact } from "../format";
import { CloseChannelDialog } from "./CloseChannelDialog";
import { EmptyState } from "./Skeleton";

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
  const [canWrite, setCanWrite] = useState(false);
  const [closeTarget, setCloseTarget] = useState<ChannelView | null>(null);

  useEffect(() => {
    api.overrides().then(setOverrides).catch(() => {});
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => {});
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
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const pending = c.status === "pending_close";
            return (
            <tr key={c.id} className={pending ? "pending" : c.active ? "" : "inactive"}>
              <td>
                <span className={`status ${pending ? "pending" : c.active ? "on" : "off"}`} />
                {c.peerAlias}
                {pending ? (
                  <span className="tag tag-pending">pending close</span>
                ) : c.private ? (
                  <span className="tag">priv</span>
                ) : null}
              </td>
              <td>
                <span className={`role role-${c.role}`}>{ROLE_LABEL[c.role]}</span>
              </td>
              <td className="num">{satsCompact(c.capacity)}</td>
              <td className="bal-col"><BalanceBar ratio={c.localRatio} /></td>
              <td className="num">{satsCompact(c.totalSent)}</td>
              <td className="num">{satsCompact(c.totalReceived)}</td>
              <td>
                {pending ? (
                  <span className="muted">—</span>
                ) : (
                  <OverrideControl
                    ov={overrides[c.id]}
                    onSet={(mode, ppm) => applyOverride(c.id, mode, ppm)}
                  />
                )}
              </td>
              <td>
                {pending ? (
                  <span className="muted small" title="Waiting for the closing transaction to confirm">
                    {c.timelockBlocks ? `~${c.timelockBlocks} blks` : "closing…"}
                  </span>
                ) : canWrite ? (
                  <button
                    className="row-btn ghost danger"
                    onClick={() => setCloseTarget(c)}
                    title="Close this channel"
                  >
                    close
                  </button>
                ) : null}
              </td>
            </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <EmptyState icon="⚡">No channels to show.</EmptyState> : null}
      <p className="hint">
        <strong>Roles</strong>: <em>source</em> mostly receives, <em>sink</em> mostly sends,
        <em> router</em> is balanced. <strong>Autopilot fee</strong>: <code>auto</code> follows the
        policy, <code>fixed</code> pins a ppm, <code>exclude</code> keeps the autopilot off this channel.
      </p>

      {closeTarget ? (
        <CloseChannelDialog
          channel={closeTarget}
          onCancel={() => setCloseTarget(null)}
          onClosed={() => setCloseTarget(null)}
        />
      ) : null}
    </section>
  );
}
