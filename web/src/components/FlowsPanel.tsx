import type { ChannelView, FlowSummary } from "../types";
import { sats, satsCompact, timeAgo } from "../format";

/** Build a channel-id → peer alias lookup so flows read in human terms. */
function aliasLookup(channels: ChannelView[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of channels) map.set(c.id, c.peerAlias);
  return map;
}

export function FlowsPanel({
  flows,
  channels,
}: {
  flows: FlowSummary;
  channels: ChannelView[];
}) {
  const aliases = aliasLookup(channels);
  const name = (id: string) => aliases.get(id) ?? id;

  const topChannels = flows.perChannel.slice(0, 10);
  const maxFlow = Math.max(1, ...topChannels.map((f) => f.routedOut + f.routedIn));

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Forwarding flows <span className="muted">· last {flows.windowDays}d</span></h2>
      </div>

      <div className="flow-totals">
        <div><strong>{flows.totalForwards}</strong> forwards</div>
        <div><strong>{satsCompact(flows.totalRoutedSats)}</strong> sat routed</div>
        <div className="earned"><strong>{sats(flows.totalFeesEarnedSats)}</strong> sat earned</div>
      </div>

      <h3 className="sub">Busiest channels</h3>
      <ul className="flow-list">
        {topChannels.map((f) => {
          const total = f.routedOut + f.routedIn;
          const outPct = total > 0 ? (f.routedOut / total) * 100 : 0;
          return (
            <li key={f.channelId}>
              <div className="flow-row">
                <span className="flow-name">{name(f.channelId)}</span>
                <span className="flow-fee">+{sats(f.feesEarned)} sat</span>
              </div>
              <div className="flow-bar" style={{ width: `${(total / maxFlow) * 100}%` }}>
                <div className="flow-out" style={{ width: `${outPct}%` }} />
              </div>
              <div className="flow-meta muted">
                {satsCompact(f.routedOut)} out · {satsCompact(f.routedIn)} in · {f.forwardCount}×
              </div>
            </li>
          );
        })}
      </ul>
      {topChannels.length === 0 ? (
        <p className="muted empty">No forwards in this window yet.</p>
      ) : null}

      <h3 className="sub">Recent forwards</h3>
      <table className="forwards">
        <tbody>
          {flows.recent.slice(0, 12).map((e, i) => (
            <tr key={`${e.createdAt}-${i}`}>
              <td className="muted">{timeAgo(e.createdAt)}</td>
              <td>{name(e.incomingChannel)} → {name(e.outgoingChannel)}</td>
              <td className="num">{satsCompact(e.tokens)}</td>
              <td className="num earned">+{e.fee}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
