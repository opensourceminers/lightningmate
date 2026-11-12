import { ApiError } from "./apiError";
import type { FeeEstimates, OnchainState, SendCheck, SendPreview } from "./types";

/**
 * Sending on-chain (review a4-lsp-payments:onchain-send-guardrails — package
 * P5). Before, the one confirmation said "Send N sat to … at R sat/vByte":
 * no fee in sats, nothing to compare the rate with (200 typed for 20 cost
 * ~28k sat on a typical send), nothing about the reserve the node keeps, and
 * no way to send the most it can spare, or everything. The server's preview
 * says all that; these put it in words for the two confirmations.
 */

const sats = (n: number): string => Math.round(n).toLocaleString("en-US");

/** "Available to send: …" under the balance — what Max fills in at the
 *  suggested rate — null when LND couldn't say. */
export function budgetLine(s: Pick<OnchainState, "budget">): string | null {
  const b = s.budget;
  if (!b) return null;
  const kept = [`${sats(b.reserveSats)} sat on-chain reserve`, ...(b.promisedSats > 0 ? [`${sats(b.promisedSats)} sat promised to buyers`] : [])];
  const rate = b.feeRate !== null && b.feeRate !== undefined ? ` at ${b.feeRate} sat/vB` : "";
  return `Available to send: ~${sats(b.availableSats)} sat${rate} (keeps ${kept.join(" and ")})`;
}

/** What the "fast" rate is: LND's rate for the next block — or for two
 *  blocks, on an LND that won't estimate for one (before 0.20). */
export const fastRateHint = (f: Pick<FeeEstimates, "fastTarget">): string => (f.fastTarget === 2 ? "~2 blocks" : "next block");

/** The first confirmation: what goes, the fee in sats (and its share), the
 *  rate against LND's next-block (or 2-block) rate, and what stays. */
export function sendSummary(p: SendPreview): string {
  const what = p.mode === "all" ? `everything LND may spend (~${sats(p.amountSats)} sat)` : `${sats(p.amountSats)} sat`;
  const share = p.amountSats > 0 ? ` — ${Math.round((p.feeSats / p.amountSats) * 1000) / 10}% of the amount` : "";
  const rateName = p.estimates.fastTarget === 2 ? "LND's 2-block rate" : "LND's next-block rate";
  const next = p.estimates.fast !== null ? `; ${rateName} is ${p.estimates.fast} sat/vB` : "";
  const size = p.feeApprox ? `about ${Math.round(p.vbytes)} vbytes (estimated from the wallet's coins)` : `${Math.round(p.vbytes)} vbytes`;
  return (
    `Send ${what} to ${p.address.slice(0, 16)}… at ${p.feeRate} sat/vB. ` +
    `Fee: ~${sats(p.feeSats)} sat for ${size}${share}${next}. ` +
    `Leaves ${sats(p.remainingSats)} sat on-chain.` +
    (p.mode === "all" ? " LND keeps back what it needs for its anchor channels." : "") +
    (p.touchesPromised ? " This takes coins promised to buyers — you'll be asked about that separately." : "") +
    " On-chain sends are irreversible."
  );
}

/** The second confirmation: what the preview asks a second yes for, in its
 *  own words. Null when nothing does. */
export function sendDoubleCheck(checks: readonly SendCheck[]): string | null {
  if (!checks.length) return null;
  return `${checks.map((c) => c.message).join(" ")} Send anyway?`;
}

/** A fresh id for one send (CHAN-14: the server never sends the same id
 *  twice). From getRandomValues: randomUUID needs a secure context, and the
 *  app is served over plain http on a LAN. */
export function newSendId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Whether an error is the app's own refusal — a 4xx with the app's reason —
 *  so nothing was sent; not a 5xx or an answer that isn't the app's (a
 *  proxy's 502/504), which may hide a send that went out. */
export function refusedByApp(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status < 400 || err.status >= 500) return false;
  const body = err.body as { error?: unknown } | null;
  return typeof body?.error === "string";
}

/** The send refused as one asked before (409 send_repeated): what to say,
 *  the first one's transaction when it went out, and whether the first one
 *  has ended (`settled`: sent or failed — not still under way). Null for any
 *  other error. */
export function sendRepeated(err: unknown): { message: string; transactionId: string | null; settled: boolean } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { error?: unknown; message?: unknown; result?: { ok?: unknown; transactionId?: unknown } } | null;
  if (body?.error !== "send_repeated") return null;
  const tx = body.result?.ok === true && typeof body.result.transactionId === "string" && body.result.transactionId ? body.result.transactionId : null;
  return { message: typeof body.message === "string" && body.message ? body.message : err.message, transactionId: tx, settled: !!body.result && typeof body.result === "object" };
}

/** The send refused because something needs a second yes the page didn't
 *  ask for (it changed since the preview): its checks. */
export function sendNeedsConfirm(err: unknown): SendCheck[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { error?: unknown; checks?: unknown } | null;
  if (body?.error !== "confirm_send" || !Array.isArray(body.checks)) return null;
  return body.checks.filter((c): c is SendCheck => !!c && typeof (c as SendCheck).code === "string" && typeof (c as SendCheck).message === "string");
}
