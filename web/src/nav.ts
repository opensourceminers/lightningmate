// Tiny global tab navigation, mirroring api.ts's setUnauthorizedHandler pattern.
// App registers its tab switcher; any component can request a jump (e.g. a
// "go to Autopilot" link) without prop-drilling through every panel.
type NavFn = (tab: string, sub?: string) => void;

let handler: NavFn | null = null;

export function setNavHandler(fn: NavFn | null): void {
  handler = fn;
}

export function goTo(tab: string, sub?: string): void {
  handler?.(tab, sub);
}
