import { useEffect, useState } from "react";
import { api } from "../api";
import type { NodeScore } from "../types";
import { useCountUp } from "../useCountUp";
import { Skeleton } from "./Skeleton";

const GRADE_CLASS: Record<string, string> = {
  A: "g-a",
  B: "g-b",
  C: "g-c",
  D: "g-d",
  F: "g-f",
};

export function HealthScore() {
  const [data, setData] = useState<NodeScore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .score()
        .then((s) => !cancelled && (setData(s), setError(null)))
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const animated = useCountUp(data?.score ?? 0);

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

      {error ? <p className="banner error">{error}</p> : null}

      {data ? (
        <div className="score-body">
          <div className={`grade ${GRADE_CLASS[data.grade] ?? "g-c"}`}>
            <span className="grade-letter">{data.grade}</span>
            <span className="grade-num">{Math.round(animated)}</span>
          </div>
          <div className="score-components">
            {data.components.map((c) => (
              <div className="score-row" key={c.key} title={c.detail}>
                <span className="score-label">{c.label}</span>
                <div className="score-track">
                  <div className="score-fill" style={{ width: `${Math.round(c.score * 100)}%` }} />
                </div>
                <span className="score-pct">{Math.round(c.score * 100)}</span>
              </div>
            ))}
          </div>
        </div>
      ) : error ? null : (
        <div className="score-body">
          <Skeleton width={92} height={92} radius={16} />
          <div className="score-components">
            {Array.from({ length: 8 }).map((_, i) => (
              <div className="score-row" key={i}>
                <Skeleton width={90} height={10} />
                <Skeleton height={8} />
                <Skeleton width={20} height={10} />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
