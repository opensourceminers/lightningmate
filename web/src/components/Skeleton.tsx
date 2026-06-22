import type { ReactNode } from "react";

export function Skeleton({
  width = "100%",
  height = 14,
  radius = 6,
}: {
  width?: number | string;
  height?: number;
  radius?: number;
}) {
  return <span className="skeleton" style={{ width, height, borderRadius: radius }} />;
}

/** A panel of skeleton lines, for initial loads. */
export function SkeletonPanel({ rows = 5 }: { rows?: number }) {
  return (
    <section className="panel">
      <Skeleton width={180} height={18} />
      <div style={{ height: 16 }} />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ margin: "10px 0" }}>
          <Skeleton height={12} width={`${90 - i * 8}%`} />
        </div>
      ))}
    </section>
  );
}

export function EmptyState({ icon = "✨", children }: { icon?: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-ico">{icon}</span>
      <span>{children}</span>
    </div>
  );
}
