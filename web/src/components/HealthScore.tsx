import { api } from "../api";
import { usePolledData } from "../usePolledData";
import { InfoTip } from "./InfoTip";
import type { NodeScore } from "../types";
import { useCountUp } from "../useCountUp";
import { scoreBar } from "../analyticsView";
import { Skeleton } from "./Skeleton";

const GRADE_COLOR: Record<string, string> = {
  A: "#34d399",
  B: "#5eead4",
  C: "#f7931a",
  D: "#fdba74",
  F: "#ff7a7a",
};

// Colour each category bar by its own score so weak spots stand out.
const barColor = (s: number) => (s >= 0.7 ? "#34d399" : s >= 0.4 ? "#f7931a" : "#ff7a7a");

const R = 52;
const CIRC = 2 * Math.PI * R;

export function HealthScore() {
  // Every minute while the page is visible (30 days of forwards each time).
  const { data, error, updatedAt } = usePolledData<NodeScore>(api.score, 60_000);

  const animated = useCountUp(data?.score ?? 0);
  const color = data ? GRADE_COLOR[data.grade] ?? "#f7931a" : "#f7931a";

  return (
    <section className="panel score">
      <div className="panel-head">
        <h2>Node health</h2>
        {data?.rank ? (
          <span className="rank-badge" title={`#${data.rank.position} of ${data.rank.total} nodes`}>
            top {Math.max(1, Math.round((1 - data.rank.percentile) * 100))}% · #{data.rank.position}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="banner error">
          {data && updatedAt ? `Couldn't refresh the score (${error}) — showing the one from ${new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.` : error}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="score-body">
            <div className="score-ring-wrap">
              <svg viewBox="0 0 120 120" className="score-ring">
                <circle cx="60" cy="60" r={R} className="ring-track" />
                <circle
                  cx="60"
                  cy="60"
                  r={R}
                  className="ring-fill"
                  style={{
                    stroke: color,
                    strokeDasharray: CIRC,
                    strokeDashoffset: CIRC * (1 - animated / 100),
                  }}
                />
              </svg>
              <div className="ring-center">
                <span className="ring-num" style={{ color }}>
                  {Math.round(animated)}
                </span>
                <span className="ring-grade" style={{ color }} title={data.provisional ?? undefined}>
                  Grade {data.grade}
                  {data.provisional ? " · provisional" : ""}
                </span>
              </div>
            </div>

            <div className="score-cats">
              {data.categories.map((c) => {
                // Not enough data (a node too young to judge its earnings):
                // no bar at all — never an empty one that reads as "0".
                const bar = scoreBar(c);
                return (
                  <div className="cat-row" key={c.key}>
                    <div className="cat-head">
                      <span className="cat-label">
                        {c.label}
                        {c.hint ? <InfoTip text={c.hint} label={`About ${c.label}`} /> : null}
                      </span>
                      <span className="cat-detail">{c.detail}</span>
                    </div>
                    {bar.graded ? (
                      <div className="cat-track">
                        <div className="cat-fill" style={{ width: `${bar.widthPct}%`, background: barColor(c.score ?? 0) }} />
                      </div>
                    ) : (
                      <span className="cat-na">{bar.label}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : error ? null : (
        <div className="score-body">
          <Skeleton width={120} height={120} radius={60} />
          <div className="score-cats">
            {Array.from({ length: 6 }).map((_, i) => (
              <div className="cat-row" key={i}>
                <div className="cat-head">
                  <Skeleton width={80} height={11} />
                  <Skeleton width={120} height={10} />
                </div>
                <Skeleton height={7} radius={5} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
