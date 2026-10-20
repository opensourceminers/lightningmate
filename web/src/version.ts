/**
 * How the running app version is shown. The server reports APP_VERSION — the
 * git tag the image was built from ("v0.7.8"; a manual build may pass "0.7.8")
 * or "dev" for a local build. Knowing which version is running is step one of
 * any "why doesn't X work" diagnosis, so it is shown in the footer and Settings.
 */
export function formatVersion(raw: string | null | undefined): string {
  const v = (raw ?? "").trim();
  if (!v) return "";
  if (v === "dev") return "dev build";
  return /^\d/.test(v) ? `v${v}` : v;
}
