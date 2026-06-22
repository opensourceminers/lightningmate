import { useEffect, useState } from "react";
import type { LiveForward } from "../types";
import { sats, satsCompact, timeAgo } from "../format";
import { useCountUp } from "../useCountUp";

export function LiveFeed() {
  const [events, setEvents] = useState<LiveForward[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource("/api/stream/forwards");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      try {
        const f = JSON.parse(m.data) as LiveForward;
        setEvents((prev) => [f, ...prev].slice(0, 14));
      } catch {
        // ignore malformed line
      }
    };
    return () => es.close();
  }, []);

  const feesSession = events.reduce((s, e) => s + e.fee, 0);
  const animatedFees = useCountUp(feesSession);

  return (
    <section className="panel live">
      <div className="panel-head">
        <h2>
          Live routing{" "}
          <span className={`live-state ${connected ? "on" : "off"}`}>
            {connected ? "live" : "offline"}
          </span>
        </h2>
      </div>

      <div className="live-counter">
        <span className="live-counter-val">+{sats(Math.round(animatedFees))}</span>
        <span className="live-counter-label">sat earned this session · {events.length} forwards</span>
      </div>

      {events.length === 0 ? (
        <p className="muted empty live-wait">
          Waiting for the next forward to route through your node…
        </p>
      ) : (
        <ul className="live-list">
          {events.map((e, i) => (
            <li key={`${e.at}-${i}`} className="live-item">
              <span className="live-bolt">⚡</span>
              <span className="live-route">{e.incoming} → {e.outgoing}</span>
              <span className="live-amt">{satsCompact(e.tokens)}</span>
              <span className="live-fee earned">+{e.fee}</span>
              <span className="live-ago muted">{timeAgo(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
