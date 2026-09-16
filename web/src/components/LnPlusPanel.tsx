import { useEffect, useState } from "react";
import { api } from "../api";
import type { LnPlusPoolNode, LnPlusStatus, LnPlusSwap, LnPlusSwapsResponse } from "../types";
import { satsCompact } from "../format";

/**
 * lightningnetwork.plus — the second liquidity market, and a different trade.
 *
 * Magma sells inbound for sats. LN+ trades channels for channels (Swaps) or for
 * liquidity credits (Pool). This view is READ-ONLY on purpose: joining a swap
 * commits you to opening a channel within 48 hours and keeping it open for
 * months, so the decision stays with the operator. What the app does do is the
 * part software is good at — telling you, before you click through to LN+,
 * whether your node would even be accepted.
 */

type Sub = "pool" | "swaps";

function RankChip({ rank, rankName }: { rank: number; rankName?: string }) {
  return (
    <span className="lnp-chip" title={rankName ? `LN+ ${rankName}` : `LN+ rank ${rank}/10`}>
      LN+ {rank}/10
    </span>
  );
}

function PoolTable({ nodes }: { nodes: LnPlusPoolNode[] }) {
  if (!nodes.length) return <div className="muted pad">No pool nodes returned right now.</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Node</th>
          <th className="num">Credits</th>
          <th className="num">Min channel</th>
          <th className="num">Capacity</th>
          <th className="num">Channels</th>
          <th>Reachable</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((n) => (
          <tr key={n.pubkey}>
            <td>
              <div className="sug-peer">
                <a href={n.profileUrl} target="_blank" rel="noreferrer noopener">
                  {n.alias}
                </a>
                <RankChip rank={n.rank} rankName={n.rankName} />
                {n.alreadyPeered ? <span className="sug-badge">already a peer</span> : null}
              </div>
              <div className="muted reason">
                {n.positiveRatings} positive / {n.negativeRatings} negative ratings
              </div>
            </td>
            <td className="num strong">{satsCompact(n.creditsBalanceSats)}</td>
            <td className="num">{satsCompact(n.minChannelSizeSats)}</td>
            <td className="num">{satsCompact(n.capacitySats)}</td>
            <td className="num">{n.openChannels}</td>
            <td>{n.connection || (n.reachableOverTor ? "Tor" : "Clearnet")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SwapsTable({ data }: { data: LnPlusSwapsResponse }) {
  const swaps = data.swaps;
  if (!swaps.length) return <div className="muted pad">No open swaps right now.</div>;
  const eligible = swaps.filter((s) => s.eligibility.eligible);
  return (
    <>
      <div className="market-score">
        <span className="market-score-main">
          <b>{eligible.length}</b> of {swaps.length} open swaps accept your node
        </span>
        <span className="muted">
          {satsCompact(data.me.capacitySats)} capacity · {data.me.channelCount} channels ·{" "}
          {data.me.hasClearnet ? "clearnet" : "Tor only"}
          {data.me.prime ? " · LN+ Prime" : " · not Prime"}
        </span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Swap</th>
            <th className="num">Size</th>
            <th className="num">Term</th>
            <th className="num">Seats</th>
            <th>Can you join?</th>
          </tr>
        </thead>
        <tbody>
          {swaps.map((s) => (
            <SwapRow key={s.id} swap={s} />
          ))}
        </tbody>
      </table>
    </>
  );
}

function SwapRow({ swap: s }: { swap: LnPlusSwap }) {
  const ok = s.eligibility.eligible;
  return (
    <tr>
      <td>
        <div className="sug-peer">
          <a href={s.url} target="_blank" rel="noreferrer noopener">
            #{s.id}
          </a>
          {s.requiresPrime ? <span className="sug-badge">Prime only</span> : null}
          {!s.clearnetAllowed ? <span className="sug-badge">Tor only</span> : null}
          {!s.torAllowed ? <span className="sug-badge">clearnet only</span> : null}
        </div>
        <div className="muted reason">
          {s.participants.length} participant{s.participants.length === 1 ? "" : "s"} · {s.statusText}
        </div>
      </td>
      <td className="num strong">{satsCompact(s.capacitySats)}</td>
      <td className="num">
        {s.durationMonths} mo
      </td>
      <td className="num">
        {s.openSeats}/{s.maxParticipants}
      </td>
      <td>
        {ok ? (
          <span className="lnp-ok">Yes — open it on LN+</span>
        ) : (
          <span className="muted">{s.eligibility.blockers.join(" · ")}</span>
        )}
      </td>
    </tr>
  );
}

export function LnPlusPanel() {
  const [sub, setSub] = useState<Sub>("pool");
  const [status, setStatus] = useState<LnPlusStatus | null>(null);
  const [pool, setPool] = useState<LnPlusPoolNode[] | null>(null);
  const [swaps, setSwaps] = useState<LnPlusSwapsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.lnplusStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    setError(null);
    if (sub === "pool" && pool === null) {
      api
        .lnplusPool()
        .then((r) => setPool(r.nodes))
        .catch((e: Error) => setError(e.message));
    }
    if (sub === "swaps" && swaps === null) {
      api
        .lnplusSwaps("pending")
        .then(setSwaps)
        .catch((e: Error) => setError(e.message));
    }
  }, [sub, pool, swaps]);

  const me = status?.me ?? null;

  return (
    <div>
      <div className="subnav">
        <button className={`subtab ${sub === "pool" ? "active" : ""}`} onClick={() => setSub("pool")}>
          Liquidity Pool
        </button>
        <button className={`subtab ${sub === "swaps" ? "active" : ""}`} onClick={() => setSub("swaps")}>
          Swaps
        </button>
      </div>

      <div className="market-score">
        {me ? (
          <>
            <span className="market-score-main">
              Your LN+ standing <b>{me.rank}/10</b> {me.rankName ? `(${me.rankName})` : ""}
            </span>
            <span className="muted">
              {me.positiveRatings} positive / {me.negativeRatings} negative ·{" "}
              {me.prime ? "Prime" : "not Prime yet"}
              {me.verified ? " · verified" : ""}
            </span>
          </>
        ) : (
          <span className="muted">
            Your node has no LN+ profile yet. Everything here still works read-only.
          </span>
        )}
      </div>

      <p className="muted pad">
        LN+ trades channels for channels or for liquidity credits, not for sats. Joining commits you
        to opening a channel within 48 hours and keeping it open for the full term, so the app shows
        you what you qualify for and leaves the commitment to you.
      </p>

      {error ? <div className="sug-warn pad">⚠ {error}</div> : null}

      {sub === "pool" ? (
        pool === null && !error ? (
          <div className="muted pad">Loading pool…</div>
        ) : (
          <PoolTable nodes={pool ?? []} />
        )
      ) : swaps === null && !error ? (
        <div className="muted pad">Loading swaps…</div>
      ) : swaps ? (
        <SwapsTable data={swaps} />
      ) : null}
    </div>
  );
}
