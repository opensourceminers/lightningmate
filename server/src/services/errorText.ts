/**
 * Readable text for anything a call can throw.
 *
 * The lightning library throws arrays — [503, "UnexpectedErrorWhenGettingChainBalance",
 * { err: { details: "transport is closing" } }] — which String() turns into
 * "503,UnexpectedErrorWhenGettingChainBalance,[object Object]": the cause is
 * lost, and that text reached the UI as a Magma order's reason. Here it reads
 * "503 UnexpectedErrorWhenGettingChainBalance: transport is closing".
 */
export function errorText(err: unknown): string {
  if (Array.isArray(err)) {
    const head = err
      .slice(0, 2)
      .filter((p) => typeof p === "string" || typeof p === "number")
      .join(" ");
    const detail = detailOf(err[2]);
    if (detail) return `${head || "LND error"}: ${detail}`;
    return head || "unknown LND error";
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return detailOf(err) || String(err);
}

/** LND's own words inside the library's error payload: { err: "<text>" },
 *  { err: { details | message } }, or { details | message }. */
function detailOf(extra: unknown): string {
  if (!extra || typeof extra !== "object") return "";
  const e = extra as { err?: unknown; details?: unknown; message?: unknown };
  if (typeof e.err === "string" && e.err) return e.err;
  if (e.err && typeof e.err === "object") {
    const inner = e.err as { details?: unknown; message?: unknown };
    if (typeof inner.details === "string" && inner.details) return inner.details;
    if (typeof inner.message === "string" && inner.message) return inner.message;
  }
  if (typeof e.details === "string" && e.details) return e.details;
  if (typeof e.message === "string" && e.message) return e.message;
  return "";
}
