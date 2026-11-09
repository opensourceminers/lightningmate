import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { useDialogFocus } from "../a11y";
import { copyText } from "../clipboard";
import { feeText } from "../feeView";
import { satsCompact, timeAgo } from "../format";
import { leaseTag, offlineLabel } from "../closeView";
import { notifyNodeChanged, setNodeHandler, useNodeChanges, type NodeTarget } from "../nodeNav";
import {
  ageText,
  capacityText,
  closedText,
  eventText,
  firstSeenText,
  nodeStatus,
  nodeVerdict,
  placeText,
  ppmText,
  reachText,
} from "../nodeView";
import { WRITE_MODE_HINT } from "../statusNotes";
import { usePolledData } from "../usePolledData";
import type { ChannelView, FeeMode, NodeAssessment, NodeChannelFacts, NodeDetail, NodePublicInfo, OpenChannelResult, OverrideMap } from "../types";
import { BalanceBar } from "./ChannelTable";
import { CloseChannelDialog } from "./CloseChannelDialog";
import { FeeOverrideControl } from "./FeeOverrideControl";
import { Fold } from "./Fold";
import { OpenChannelForm, OpenResultLine } from "./OpenChannelForm";
import { useUi } from "./Overlay";
import { Skeleton } from "./Skeleton";

/** Offered when nothing says what size would fit. */
const DEFAULT_OPEN_SATS = 1_000_000;

/** A label and its value, in the figures of a section. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * The node details, opened from wherever a node is named: one mounted in the
 * App, opened through nodeNav.ts.
 */
export function NodePanelHost() {
  const [target, setTarget] = useState<NodeTarget | null>(null);
  useEffect(() => {
    setNodeHandler(setTarget);
    return () => setNodeHandler(null);
  }, []);
  if (!target) return null;
  return <NodePanel key={target.pubkey} target={target} onClose={() => setTarget(null)} />;
}

/** One channel with this node: what it holds and what it did. */
function ChannelCard({
  c,
  facts,
  windowDays,
  forwardsKnown,
  canWrite,
  onClose,
}: {
  c: ChannelView;
  facts: NodeChannelFacts | undefined;
  windowDays: number;
  forwardsKnown: boolean;
  canWrite: boolean;
  onClose: () => void;
}) {
  const pending = c.status !== "open";
  const age = ageText(facts?.ageDays ?? null);
  const lease = leaseTag(c.lease);
  const away = !pending ? offlineLabel(c.offline) : null;
  return (
    <div className="node-channel">
      <div className="node-channel-head">
        <span>
          <strong>{satsCompact(c.capacity)} sat</strong>
          <span className="muted">
            {" "}
            · opened by {c.initiator === "local" ? "you" : "them"}
            {age ? ` · ${age} old` : ""}
          </span>
        </span>
        {pending ? (
          <span className="muted small">{c.status === "pending_open" ? "confirming…" : c.timelockBlocks ? `~${c.timelockBlocks} blks` : "closing…"}</span>
        ) : canWrite ? (
          <button className="row-btn ghost danger" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
      <BalanceBar ratio={c.localRatio} />
      <div className="node-channel-sides muted small">
        <span>{satsCompact(c.localBalance)} yours</span>
        <span>{satsCompact(c.remoteBalance)} theirs</span>
      </div>
      {lease || away || c.private ? (
        <div className="node-channel-tags">
          {lease ? <span className="tag tag-lease">{lease}</span> : null}
          {away ? <span className={`tag ${c.offline?.long ? "tag-pending" : ""}`}>{away}</span> : null}
          {c.private ? <span className="tag">private</span> : null}
        </div>
      ) : null}
      {!pending && facts ? (
        <dl className="node-facts">
          {forwardsKnown ? (
            <Fact label={`Last ${windowDays} days`}>
              earned {facts.earnedSats.toLocaleString("en-US")} sat
              {facts.broughtInSats > 0 ? ` · brought in ${facts.broughtInSats.toLocaleString("en-US")} sat` : ""}
              {" · "}
              {facts.forwardsOut + facts.forwardsIn} forwards
              {facts.refillFeeSats > 0 ? ` · refills −${facts.refillFeeSats.toLocaleString("en-US")} sat` : ""}
            </Fact>
          ) : null}
          {c.feeRatePpm !== null ? <Fact label="You charge">{ppmText(c.feeRatePpm)}</Fact> : null}
          {facts.theirFeePpm !== null ? <Fact label="They charge">{ppmText(facts.theirFeePpm)}</Fact> : null}
        </dl>
      ) : null}
    </div>
  );
}

/** The figures only someone tuning a channel looks at. */
function ChannelAdvanced({
  c,
  facts,
  override,
  onSaveFee,
}: {
  c: ChannelView;
  facts: NodeChannelFacts | undefined;
  override: OverrideMap[string] | undefined;
  onSaveFee: (mode: FeeMode, ppm?: number) => Promise<void>;
}) {
  const online = c.timeOnlineMs ?? 0;
  const offline = c.timeOfflineMs ?? 0;
  const uptime = online + offline > 0 ? Math.round((online / (online + offline)) * 100) : null;
  return (
    <div className="node-channel-advanced">
      <div className="muted small node-channel-id">{c.id}</div>
      <dl className="node-facts">
        {c.status === "open" ? (
          <Fact label="Autopilot fee">
            <FeeOverrideControl ov={override} currentPpm={c.feeRatePpm} onSave={onSaveFee} />
          </Fact>
        ) : null}
        {c.feeRatePpm !== null ? <Fact label="Fee and base">{feeText(c.feeRatePpm, c.baseFeeMsat)}</Fact> : null}
        {facts?.theirFeePpm != null ? <Fact label="Their fee and base">{feeText(facts.theirFeePpm, facts.theirBaseFeeMsat)}</Fact> : null}
        {facts?.theirTimeLock != null ? <Fact label="Their time-lock delta">{facts.theirTimeLock} blocks</Fact> : null}
        {facts?.theirDisabled ? <Fact label="Their side">disabled</Fact> : null}
        <Fact label="Funding">
          <code className="mono-sm">{c.transactionId.slice(0, 16)}…:{c.transactionVout}</code>
        </Fact>
        {c.totalSent + c.totalReceived > 0 ? (
          <Fact label="Moved so far">
            {satsCompact(c.totalSent)} out · {satsCompact(c.totalReceived)} in
          </Fact>
        ) : null}
        {facts && facts.refills > 0 ? (
          <Fact label="Refills in 30 days">
            {facts.refills} · {satsCompact(facts.refillSats)} sat
          </Fact>
        ) : null}
        {uptime !== null ? <Fact label="Uptime since LND started">{uptime} %</Fact> : null}
        {c.unsettled > 0 ? <Fact label="In flight">{satsCompact(c.unsettled)} sat</Fact> : null}
        {c.csvDelayBlocks ? <Fact label="Force-close lock">{c.csvDelayBlocks} blocks</Fact> : null}
        {c.commitFeeSats ? <Fact label="Commitment fee">{c.commitFeeSats.toLocaleString("en-US")} sat</Fact> : null}
      </dl>
    </div>
  );
}

function NodePanel({ target, onClose }: { target: NodeTarget; onClose: () => void }) {
  const { pubkey } = target;
  const ui = useUi();
  const detail = usePolledData<NodeDetail>(() => api.nodeDetail(pubkey), 60_000);
  const d = detail.data;
  const [assessment, setAssessment] = useState<NodeAssessment | null>(null);
  const [assessmentError, setAssessmentError] = useState<string | null>(null);
  const [pub, setPub] = useState<NodePublicInfo | null>(null);
  const [pubError, setPubError] = useState<string | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [overrides, setOverrides] = useState<OverrideMap>({});
  const [closeTarget, setCloseTarget] = useState<ChannelView | null>(null);
  const [opening, setOpening] = useState(false);
  const [openResult, setOpenResult] = useState<OpenChannelResult | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [copied, setCopied] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  useDialogFocus(panelRef, true, onClose);
  // An open that ended after its form was closed.
  useNodeChanges((change) => {
    if (change.channels) detail.refresh();
  });

  const loaded = d !== null;
  const isSelf = d?.isSelf ?? false;
  useEffect(() => {
    api.autopilotGet().then((s) => setCanWrite(s.canWrite)).catch(() => setCanWrite(false));
    api.overrides().then(setOverrides).catch(() => {});
  }, []);
  // Each on its own: the first graph read or a slow Tor circuit holds up only
  // its own lines. Not for this node itself, there is nothing to look up.
  useEffect(() => {
    if (!loaded || isSelf) return;
    let gone = false;
    api
      .nodeAssessment(pubkey)
      .then((a) => {
        if (!gone) setAssessment(a);
      })
      .catch((e) => {
        if (!gone) setAssessmentError(e instanceof Error ? e.message : String(e));
      });
    api
      .nodePublic(pubkey)
      .then((p) => {
        if (!gone) setPub(p);
      })
      .catch((e) => {
        if (!gone) setPubError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      gone = true;
    };
  }, [loaded, isSelf, pubkey]);

  const name = d?.alias ?? target.alias ?? `${pubkey.slice(0, 12)}…`;
  const status = d ? nodeStatus(d) : null;
  const verdict = d ? nodeVerdict(d, assessment) : null;
  const candidate = assessment?.candidate ?? null;
  // What keeps it off the suggestions outweighs its score: no "good fit", no
  // size offered for a node that hasn't been seen for a year.
  const offList = assessment?.notSuggestedBecause ?? [];
  const fit = offList.length > 0 ? "Not suggested" : candidate?.usefulness === "high" ? "Good fit" : candidate?.usefulness === "medium" ? "Possible fit" : "Weak fit";
  const n = d?.network ?? null;
  const record = pub?.record ?? null;
  const lnp = pub?.lnplus ?? null;
  const channels = d?.channels ?? [];
  const away = channels.find((c) => c.status === "open" && !c.active);
  const socket = target.socket ?? n?.addresses[0] ?? "";
  const hasOpenable = channels.length === 0;

  const copyKey = async () => {
    if (await copyText(pubkey)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      ui.toast("This browser wouldn't copy it: select the key under Advanced.", "error");
    }
  };

  const reconnect = async () => {
    setReconnecting(true);
    try {
      const r = await api.peerConnect(pubkey);
      if (r.ok) ui.toast("Reconnected: the channel comes back online in a moment.", "success");
      else ui.toast(r.error ?? "Could not reach the peer.", "error");
      detail.refresh();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setReconnecting(false);
    }
  };

  const toggleNever = async () => {
    if (!d) return;
    try {
      await api.neverOpen(pubkey, !d.neverOpen, d.alias);
      notifyNodeChanged({ neverOpen: { pubkey, never: !d.neverOpen } });
      detail.refresh();
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error");
    }
  };

  const onOpened = (result: OpenChannelResult) => {
    setOpenResult(result);
    if (result.ok) {
      setOpening(false);
      detail.refresh();
    }
  };

  const openForm = opening ? (
    <div className="node-open">
      <OpenChannelForm
        pubkey={pubkey}
        alias={name}
        socket={socket}
        initialSize={candidate && offList.length === 0 ? candidate.recommendedSizeSats : DEFAULT_OPEN_SATS}
        onResult={onOpened}
        onCancel={() => setOpening(false)}
      />
    </div>
  ) : null;
  // Beside the form it came from; a success at the top, the form being gone.
  const openFailed =
    openResult && !openResult.ok ? (
      <p className="node-open-result">
        <OpenResultLine result={openResult} />
      </p>
    ) : null;

  return (
    <div className="node-overlay" onClick={onClose}>
      <aside
        className="node-panel"
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-panel-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="node-head">
          <div className="node-title">
            <h2 id="node-panel-title">{name}</h2>
            {status ? <span className={`node-status tone-${status.tone}`}>{status.text}</span> : null}
          </div>
          <button type="button" className="node-x" aria-label="Close details" onClick={onClose}>
            ×
          </button>
        </header>

        {detail.error && !d ? (
          <div className="banner error" role="alert">
            {detail.error}
            <div>
              <button className="reset" onClick={detail.refresh}>
                Try again
              </button>
            </div>
          </div>
        ) : null}

        {!d && !detail.error ? (
          <div className="node-loading">
            <Skeleton height={14} width="90%" />
            <Skeleton height={14} width="70%" />
            <Skeleton height={90} />
          </div>
        ) : null}

        {d && verdict ? (
          <>
            <p className={`node-verdict tone-${verdict.tone}`}>{verdict.text}</p>

            {!d.isSelf ? (
              <div className="node-actions">
                {hasOpenable ? (
                  <button
                    className="primary-btn"
                    disabled={!canWrite}
                    title={canWrite ? undefined : WRITE_MODE_HINT}
                    onClick={() => {
                      setOpenResult(null);
                      setOpening((o) => !o);
                    }}
                  >
                    Open channel
                  </button>
                ) : null}
                {away && canWrite ? (
                  <button className="primary-btn" disabled={reconnecting} onClick={reconnect}>
                    {reconnecting ? "Reconnecting…" : "Reconnect"}
                  </button>
                ) : null}
                <button className="reset" onClick={copyKey}>
                  {copied ? "Copied" : "Copy key"}
                </button>
              </div>
            ) : null}
            {hasOpenable ? openForm : null}
            {hasOpenable ? openFailed : null}
            {openResult?.ok ? (
              <p className="node-open-result">
                <OpenResultLine result={openResult} />
              </p>
            ) : null}

            {channels.length > 0 ? (
              <section className="node-section">
                <h3 className="sub">{channels.length === 1 ? "Your channel" : `Your channels (${channels.length})`}</h3>
                {channels.map((c) => (
                  <ChannelCard
                    key={c.id}
                    c={c}
                    facts={d.channelFacts.find((f) => f.channelId === c.id)}
                    windowDays={d.windowDays}
                    forwardsKnown={d.forwardsKnown}
                    canWrite={canWrite}
                    onClose={() => setCloseTarget(c)}
                  />
                ))}
              </section>
            ) : null}

            {!d.isSelf && channels.length === 0 ? (
              <section className="node-section">
                <h3 className="sub">Should you open a channel?</h3>
                {candidate ? (
                  <>
                    <div className="node-score">
                      <span className={`sug-score u-${offList.length > 0 ? "low" : candidate.usefulness}`}>{candidate.score}</span>
                      <span>
                        <strong>{fit}</strong>
                        {offList.length === 0 ? <span className="muted"> · about {satsCompact(candidate.recommendedSizeSats)} sat</span> : null}
                      </span>
                    </div>
                    <ul className="node-reasons">
                      {candidate.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                      {candidate.warnings.map((w) => (
                        <li key={w} className="sug-warn">
                          ⚠ {w}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : !assessment && !assessmentError ? (
                  <p className="muted small">Comparing it with the rest of the network…</p>
                ) : assessmentError ? (
                  <p className="muted small">Couldn't judge it: {assessmentError}</p>
                ) : null}
                {offList.length > 0 && !candidate ? <p className="muted small">Not on the suggestion list: {offList.join("; ")}.</p> : null}
              </section>
            ) : null}

            {!d.isSelf ? (
              <section className="node-section">
                <h3 className="sub">In the network</h3>
                {n ? (
                  <dl className="node-facts">
                    <Fact label="Channels">
                      {n.channels.toLocaleString("en-US")} · {capacityText(n.capacitySats)}
                    </Fact>
                    {n.channels > 0 ? <Fact label="Average channel">{satsCompact(n.avgChannelSats)} sat</Fact> : null}
                    {n.typicalFeePpm !== null ? <Fact label="Typical fee">{ppmText(n.typicalFeePpm)}</Fact> : null}
                    <Fact label="Reachable over">{reachText(n)}</Fact>
                    {firstSeenText(record?.firstSeenAt ?? null) ? <Fact label="First seen">{firstSeenText(record?.firstSeenAt ?? null)}</Fact> : null}
                    {record && placeText(record) ? <Fact label="Runs in">{placeText(record)}</Fact> : null}
                    {record?.hostedBy ? <Fact label="Hosted by">{record.hostedBy}</Fact> : null}
                    {assessment?.uniqueReach ? (
                      <Fact label="Only through it">
                        {assessment.uniqueReach} node{assessment.uniqueReach === 1 ? "" : "s"} two hops away
                      </Fact>
                    ) : null}
                    {candidate && candidate.newReach > 0 ? <Fact label="It would add">{candidate.newReach} new node{candidate.newReach === 1 ? "" : "s"} two hops away</Fact> : null}
                    {lnp ? (
                      <Fact label="LN+">
                        rank {lnp.rank}/10{lnp.rankName ? ` (${lnp.rankName})` : ""} · {lnp.positiveRatings} positive / {lnp.negativeRatings} negative
                        {lnp.verified ? " · verified" : ""}
                      </Fact>
                    ) : null}
                  </dl>
                ) : (
                  <p className="muted small">Your node's view of the network doesn't have it: it may be private, or never announced itself.</p>
                )}
                {!pub && !pubError ? <p className="muted small">Looking up its public record…</p> : null}
                {pubError || pub?.recordState === "unavailable" ? <p className="muted small">The public record couldn't be read right now.</p> : null}
                {pub?.recordState === "off" ? <p className="muted small">Public record lookups are off (Settings → Privacy).</p> : null}
              </section>
            ) : null}

            {d.events.length > 0 ? (
              <Fold id="node-events" title="What the autopilot did here" note={String(d.events.length + d.eventsMore)}>
                <ul className="node-events">
                  {d.events.map((e, i) => {
                    const t = eventText(e);
                    return (
                      <li key={`${e.at}-${i}`}>
                        <span>{t.title}</span>
                        <span className="muted small"> · {timeAgo(e.at)}</span>
                        {t.detail ? <div className="muted small">{t.detail}</div> : null}
                      </li>
                    );
                  })}
                </ul>
                {d.eventsMore > 0 ? <p className="muted small">And {d.eventsMore} older.</p> : null}
              </Fold>
            ) : null}

            {d.closedChannels.length > 0 ? (
              <Fold id="node-closed" title="Earlier channels" note={String(d.closedChannels.length)}>
                <ul className="node-events">
                  {d.closedChannels.map((c, i) => (
                    <li key={c.id ?? i}>{closedText(c)}</li>
                  ))}
                </ul>
              </Fold>
            ) : null}

            <Fold id="node-advanced" title="Advanced">
              <dl className="node-facts">
                <Fact label="Public key">
                  <code className="mono-sm node-key">{pubkey}</code>
                </Fact>
                {n && n.addresses.length > 0 ? (
                  <Fact label="Addresses">
                    {n.addresses.map((a) => (
                      <code key={a} className="mono-sm node-key">
                        {a}
                      </code>
                    ))}
                  </Fact>
                ) : null}
                {n?.lastAnnouncedAt ? <Fact label="Last announced">{timeAgo(n.lastAnnouncedAt)}</Fact> : null}
                {n ? <Fact label="Enabled channels">{n.enabledChannels.toLocaleString("en-US")}</Fact> : null}
                {d.connection ? (
                  <Fact label="Connection">
                    {d.connection.inbound ? "they dialed in" : "you dialed out"} · {d.connection.pingMs} ms
                    <code className="mono-sm node-key">{d.connection.socket}</code>
                  </Fact>
                ) : null}
                {record?.closedChannels != null ? <Fact label="Channels it has closed">{record.closedChannels.toLocaleString("en-US")}</Fact> : null}
                {lnp && lnp.minChannelSizeSats > 0 ? <Fact label="Smallest channel it takes">{satsCompact(lnp.minChannelSizeSats)} sat (LN+)</Fact> : null}
              </dl>

              {channels.map((c) => (
                <ChannelAdvanced
                  key={c.id}
                  c={c}
                  facts={d.channelFacts.find((f) => f.channelId === c.id)}
                  override={overrides[c.id]}
                  onSaveFee={async (mode, ppm) => {
                    const saved = await api.setOverride(c.id, mode, ppm);
                    setOverrides(saved);
                    notifyNodeChanged({ overrides: saved });
                  }}
                />
              ))}

              {candidate ? (
                <div className="sug-bd node-breakdown">
                  {(
                    [
                      ["Demand", candidate.demandScore],
                      ["Quality reach", candidate.weightedReachScore],
                      ["Graph", candidate.graphScore],
                      ["Role fit", candidate.roleFitScore],
                      ["Economics", candidate.economicsScore],
                    ] as const
                  ).map(([label, v]) => (
                    <div key={label} className="sug-bar-row">
                      <span className="sug-bar-label">{label}</span>
                      <span className="sug-bar">
                        <i style={{ width: `${Math.round(v * 100)}%` }} />
                      </span>
                      <span className="sug-bar-val">{v.toFixed(2)}</span>
                    </div>
                  ))}
                  <p className="muted small">{candidate.sizeReason}</p>
                </div>
              ) : null}

              {!d.isSelf ? (
                <div className="node-actions">
                  <button
                    className="reset"
                    title={d.neverOpen ? "Let the channel autopilot open to this node again" : "The channel autopilot never opens to this node (you still can, by hand)"}
                    onClick={toggleNever}
                  >
                    {d.neverOpen ? "Allow automatic opens" : "Never open automatically"}
                  </button>
                  {!hasOpenable ? (
                    <button
                      className="reset"
                      disabled={!canWrite}
                      title={canWrite ? undefined : WRITE_MODE_HINT}
                      onClick={() => {
                        setOpenResult(null);
                        setOpening((o) => !o);
                      }}
                    >
                      Open another channel
                    </button>
                  ) : null}
                </div>
              ) : null}
              {!hasOpenable ? openForm : null}
              {!hasOpenable ? openFailed : null}

              <p className="node-links small">
                <a href={`https://mempool.space/lightning/node/${pubkey}`} target="_blank" rel="noreferrer noopener">
                  mempool.space ↗
                </a>
                <a href={`https://amboss.space/node/${pubkey}`} target="_blank" rel="noreferrer noopener">
                  Amboss ↗
                </a>
                {lnp ? (
                  <a href={lnp.profileUrl} target="_blank" rel="noreferrer noopener">
                    LN+ ↗
                  </a>
                ) : null}
              </p>
            </Fold>
          </>
        ) : null}
      </aside>

      {closeTarget ? (
        <div onClick={(e) => e.stopPropagation()}>
          <CloseChannelDialog
            channel={closeTarget}
            onCancel={() => setCloseTarget(null)}
            onClosed={() => {
              setCloseTarget(null);
              notifyNodeChanged({ channels: true });
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
