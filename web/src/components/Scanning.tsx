/** Indeterminate "scanning" loader — a sweeping bar + pulsing gold label. */
export function Scanning({ label = "SCANNING" }: { label?: string }) {
  return (
    <div className="scanning">
      <div className="scan-bar">
        <div className="scan-sweep" />
      </div>
      <div className="scan-label">{label}</div>
      <div className="scan-sub">this can take a moment — please wait</div>
    </div>
  );
}
