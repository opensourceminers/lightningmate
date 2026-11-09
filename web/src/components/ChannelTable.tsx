import { useEffect, useState } from "react";
import { useNodeChanges } from "../nodeNav";
import { api } from "../api";
import type { ChannelRole, ChannelView, FeeMode, OverrideMap } from "../types";
import { satsCompact } from "../format";
import { feeText } from "../feeView";
import { channelNotes, type ChannelNote } from "../nodeView";
import { openNode } from "../nodeNav";
import { readRememberedList, writeRemembered } from "../remembered";
import { usePolledData } from "../usePolledData";
import { CloseChannelDialog } from "./CloseChannelDialog";
import { FeeOverrideControl } from "./FeeOverrideControl";
import { Fold } from "./Fold";
import { NodeLink } from "./NodeLink";
import { EmptyState } from "./Skeleton";
import { InfoTip } from "./InfoTip";

const ROLE_LABEL: Record<ChannelRole, string> = {
  source: "mostly receives",
  sink: "mostly sends",
  router: "balanced",
};

export function BalanceBar({ ratio }: { ratio: number }) {
  const pct = Math.round(ratio * 100);
  return (
    <div className="bal-bar" title={`${pct}% on your side`}>
      <div className="bal-local" style={{ width: `${pct}%` }} />
      <span className="bal-pct">{pct}%</span>
    </div>
  );
}

type SortKey = "capacity" | "localRatio" | "earned" | "totalSent" | "totalReceived";

/** The columns anyone can add to the four every row has. */
const EXTRA_COLUMNS = [
  { id: "role", label: "Flow" },
  { id: "sent", label: "Routed out" },
  { id: "received", label: "Routed in" },
  { id: "fee", label: "Fee now" },
  { id: "auto", label: "Autopilot fee" },
  { id: "close", label: "Close" },
] as const;
type ExtraColumn = (typeof EXTRA_COLUMNS)[number]["id"];
const EXTRA_IDS = EXTRA_COLUMNS.map((c) => c.id);
const COLUMNS_KEY = "channel_columns";

function Notes({ notes }: { notes: ChannelNote[] }) {
  return (
    <>
      {notes.map((n) => (
        <span key={n.text} className={`tag ${n.tone === "lease" ? "tag-lease" : n.tone === "warn" ? "tag-pending" : ""}`} title={n.title}>
          {n.text}
        </span>
      ))}
    </>
  );
}

export function ChannelTable({ channels }: { channels: ChannelView[] }) {
  const [sort, setSort] = useState<SortKey>("capacity");
  const [onlyActive, setOnlyActive] = useState(false);
  const [overrides, setOverrides] = useState<OverrideMap>({});
  // A fee mode saved in a node's details: this list shows it too.
  useNodeChanges(({ overrides: saved }) => {
    if (saved) setOverrides(saved);
  });
  const [canWrite, setCanWrite] = useState(false);
  const [closeTarget, setCloseTarget] = useState<ChannelView | null>(null);
  const [extra, setExtra] = useState<ExtraColumn[]>(() => readRememberedList(COLUMNS_KEY, EXTRA_IDS));
  // What each channel earned: the same report Analytics shows, every few minutes.
  const report = usePolledData(() => api.forwardsReport(30), 300_000);

  useEffect(() => {
    api.overrides().then(setOverrides).catch(() => {});
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => {});
  }, []);

  // A refused save rejects: the control shows why (it used to be swallowed).
  const applyOverride = async (id: string, mode: FeeMode, fixedPpm?: number) => {
    setOverrides(await api.setOverride(id, mode, fixedPpm));
  };

  const flows = new Map((report.data?.perChannel ?? []).map((f) => [f.channelId, f]));
  const flowsLoaded = report.data !== null && report.data.complete;
  const earned = (c: ChannelView) => flows.get(c.id)?.feesEarnedSats ?? 0;

  const has = (id: ExtraColumn) => extra.includes(id);
  const toggleColumn = (id: ExtraColumn) => {
    const next = EXTRA_IDS.filter((x) => (x === id ? !has(id) : has(x)));
    setExtra(next);
    writeRemembered(COLUMNS_KEY, JSON.stringify(next));
  };

  const sortValue = (c: ChannelView) => (sort === "earned" ? earned(c) : c[sort]);
  const rows = channels
    .filter((c) => (onlyActive ? c.active : true))
    .slice()
    .sort((a, b) => sortValue(b) - sortValue(a));

  // A control in a row stays a control: only the rest of the row opens the node.
  const stay = (e: { stopPropagation(): void }) => e.stopPropagation();

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
            <option value="capacity">sort: size</option>
            <option value="earned">sort: earned</option>
            <option value="localRatio">sort: your side %</option>
            <option value="totalSent">sort: routed out</option>
            <option value="totalReceived">sort: routed in</option>
          </select>
        </div>
      </div>

      <table className="channels channels-simple">
        <thead>
          <tr>
            <th>Node</th>
            <th className="bal-col">
              Size<span className="ct-long-word"> · your side</span>
            </th>
            <th className="num">
              Earned<span className="ct-long-word"> 30 d</span>
            </th>
            <th className="ct-note-col">Note</th>
            {has("role") ? <th>Flow</th> : null}
            {has("sent") ? <th className="num">Routed out</th> : null}
            {has("received") ? <th className="num">Routed in</th> : null}
            {has("fee") ? <th className="num">Fee now</th> : null}
            {has("auto") ? <th>Autopilot fee</th> : null}
            {has("close") ? <th></th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const pendingClose = c.status === "pending_close";
            const pendingOpen = c.status === "pending_open";
            const pending = pendingClose || pendingOpen;
            const flow = flows.get(c.id);
            const notes = channelNotes(c, flow, flowsLoaded);
            return (
              <tr
                key={c.id}
                className={`ct-row ${pending ? "pending" : c.active ? "" : "inactive"}`}
                onClick={() => openNode({ pubkey: c.peerPubkey, alias: c.peerAlias })}
              >
                <td>
                  <span className={`status ${pending ? "pending" : c.active ? "on" : "off"}`} />
                  <NodeLink pubkey={c.peerPubkey} alias={c.peerAlias} />
                  {notes.length > 0 ? (
                    <div className="ct-note-inline">
                      <Notes notes={notes} />
                    </div>
                  ) : null}
                </td>
                <td className="bal-col">
                  <div className="bal-cell">
                    <span className="bal-cap">{satsCompact(c.capacity)}</span>
                    <BalanceBar ratio={c.localRatio} />
                  </div>
                </td>
                <td className="num">
                  {report.data === null || pending ? <span className="muted">—</span> : <span className="strong">{earned(c).toLocaleString("en-US")}</span>}
                  {flow && flow.inboundFeesSats > 0 ? (
                    <div className="muted small" title="Fees earned elsewhere on the forwards that came in through this channel">
                      +{flow.inboundFeesSats.toLocaleString("en-US")}
                      <span className="ct-long-word"> brought in</span>
                    </div>
                  ) : null}
                </td>
                <td className="ct-note-col">
                  <Notes notes={notes} />
                </td>
                {has("role") ? (
                  <td>
                    <span className={`role role-${c.role}`}>{ROLE_LABEL[c.role]}</span>
                  </td>
                ) : null}
                {has("sent") ? <td className="num">{satsCompact(c.totalSent)}</td> : null}
                {has("received") ? <td className="num">{satsCompact(c.totalReceived)}</td> : null}
                {has("fee") ? (
                  <td className="num" title="what this channel charges to forward out now">
                    {pending ? <span className="muted">—</span> : feeText(c.feeRatePpm, c.baseFeeMsat)}
                  </td>
                ) : null}
                {has("auto") ? (
                  <td onClick={stay}>
                    {pending ? (
                      <span className="muted">—</span>
                    ) : (
                      <FeeOverrideControl ov={overrides[c.id]} currentPpm={c.feeRatePpm} onSave={(mode, ppm) => applyOverride(c.id, mode, ppm)} />
                    )}
                  </td>
                ) : null}
                {has("close") ? (
                  <td onClick={stay}>
                    {pending ? (
                      <span className="muted small" title="Waiting for the transaction to confirm">
                        {pendingOpen ? "confirming…" : c.timelockBlocks ? `~${c.timelockBlocks} blks` : "closing…"}
                      </span>
                    ) : canWrite ? (
                      <button className="row-btn ghost danger" onClick={() => setCloseTarget(c)} title="Close this channel">
                        close
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <EmptyState icon="⚡">No channels to show.</EmptyState> : null}

      <div className="ct-foot">
        <span className="hint">
          Click a node for its details.
          <InfoTip label="What the columns mean">
            <strong>Earned</strong>: the fees of the forwards that left through this channel. <strong>Brought in</strong>: the fees
            earned elsewhere on the forwards that came in through it; closing it would lose those too. <strong>Your side</strong>: the
            share of the channel you can send. <strong>Autopilot fee</strong>: <code>auto</code> follows the policy, <code>fixed</code>{" "}
            pins a fee (it starts at the current one; confirm with Enter or Pin — fee automation then sets it, or Apply on the Fees
            tab; saving it changes nothing on the node by itself), <code>excluded</code> keeps the autopilot off this channel.
          </InfoTip>
        </span>
        <Fold id="channel-columns" title="More columns" note={extra.length > 0 ? String(extra.length) : undefined}>
          <div className="ct-columns">
            {EXTRA_COLUMNS.map((c) => (
              <label key={c.id} className="check">
                <input type="checkbox" checked={has(c.id)} onChange={() => toggleColumn(c.id)} />
                {c.label}
              </label>
            ))}
          </div>
        </Fold>
      </div>

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
