/** LightningMate logo mark — a gradient bolt in a rounded tile. */
export function BrandMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="lm-bolt" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffce8a" />
          <stop offset=".5" stopColor="#ffb45a" />
          <stop offset="1" stopColor="#f7931a" />
        </linearGradient>
        <linearGradient id="lm-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#222637" />
          <stop offset="1" stopColor="#0e1018" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#lm-bg)" />
      <rect x="1" y="1" width="62" height="62" rx="14" fill="none" stroke="#f7931a" strokeOpacity=".3" />
      <path
        d="M36 7 L16 35 H28 L24 57 L48 27 H34 Z"
        fill="url(#lm-bolt)"
        stroke="#fff2e0"
        strokeOpacity=".25"
        strokeLinejoin="round"
      />
    </svg>
  );
}
