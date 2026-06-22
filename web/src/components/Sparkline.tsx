/** Tiny inline sparkline (line + soft area) from a series of numbers. */
export function Sparkline({
  data,
  width = 84,
  height = 26,
  color = "var(--accent)",
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (data.length < 2 || data.every((v) => v === 0)) {
    return <span className="spark-flat" style={{ width }} />;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const y = (v: number) => height - 2 - ((v - min) / range) * (height - 4);

  const line = data.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;

  return (
    <svg width={width} height={height} className="spark" aria-hidden="true">
      <polygon points={area} fill={color} fillOpacity="0.12" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
