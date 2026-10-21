import { ApiError } from "./apiError";
import type { MagmaLaneStatus, MyOrder, OfferSyncStatus } from "./types";

/**
 * Small pure helpers behind the status notes of the Sell, Autopilot and
 * Settings views — kept here so they can be tested without a browser.
 */

/**
 * The error of an offer write that did not land, for an offer that is STILL
 * out of sync with what the autopilot wants — or null.
 *
 * Shown whenever Liquidity provision is on (the capital clamp and the
 * enable/disable writes run with auto-pricing off too), and only while the
 * offer is out of sync: once a later write lands, an old failure is history,
 * not a problem to show.
 */
export function failedOfferWrite(sync: OfferSyncStatus | null | undefined): string | null {
  const bad = sync?.offers.find((e) => !e.inSync && e.lastWrite && (!e.lastWrite.ok || e.lastWrite.verified === false));
  return bad?.lastWrite ? (bad.lastWrite.error ?? "Amboss did not store the change") : null;
}

/**
 * The Orders tab's note on the Magma order lane, or null while it has nothing
 * to report. "— retrying" only where the lane's next pass can clear it: a
 * request Amboss rejects as such fails the same way every pass until
 * LightningMate is updated, and its text says so — "retrying" there promised
 * a recovery that can't come.
 */
export function laneBanner(lane: MagmaLaneStatus | null | undefined): string | null {
  if (lane?.ok !== false) return null;
  const text = lane.error ?? "could not reach Amboss";
  return lane.retrying === false ? `Order lane: ${text}.` : `Order lane: ${text} — retrying.`;
}

/**
 * Whether the Orders tab offers Accept and Reject for an order: a sale Amboss
 * shows waiting for your approval, with nothing of yours tied to it here — not
 * taken on yet ("seen"), or ended here as "failed" with no channel (a failed
 * order never holds an invoice). The server takes such an order up again when
 * Amboss still waits on you. Before, the buttons showed for "seen" alone: an
 * order ended here by mistake could only time out on you.
 */
export function awaitsYourDecision(o: Pick<MyOrder, "side" | "status" | "local">): boolean {
  if (o.side !== "SELL" || o.status !== "WAITING_FOR_SELLER_APPROVAL") return false;
  return !o.local || o.local.phase === "seen" || (o.local.phase === "failed" && !o.local.fundingOutpoint);
}

/** A main autopilot run this long is not normal: a payment or a call is stuck. */
export const RUN_STUCK_MINUTES = 10;

/**
 * The main run in progress, as a note: null when no run is in progress; a
 * warning once it has run for RUN_STUCK_MINUTES or more. (The "last run"
 * time alone stands still during a stuck run — and used to be moved by the
 * order lane, which hid it.)
 */
export function runProgress(
  runningSince: string | null | undefined,
  nowMs: number,
): { text: string; stuck: boolean } | null {
  if (!runningSince) return null;
  const started = Date.parse(runningSince);
  if (!Number.isFinite(started)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - started) / 60_000));
  if (minutes < RUN_STUCK_MINUTES) {
    return { text: minutes < 1 ? "Run in progress…" : `Run in progress for ${minutes} min…`, stuck: false };
  }
  return {
    text:
      `A run has been in progress for ${minutes} min — far longer than usual. A payment or a call to the ` +
      "node may be stuck; fees, rebalancing and channel opens wait until it ends. (Magma orders are handled " +
      "separately and are not held up.)",
    stuck: true,
  };
}

/**
 * What removing the Amboss key means, for the confirmation. With Magma orders
 * in flight it says what happens to them: nothing can be opened, reported or
 * settled any more; held payments are still released before they expire.
 */
export function removeKeyMessage(ordersInFlight: number): string {
  const base =
    "Remove the Amboss API key from this node? Buying and selling on Magma stop until you connect a key again.";
  if (ordersInFlight <= 0) return base;
  const orders = ordersInFlight === 1 ? "1 Magma order is" : `${ordersInFlight} Magma orders are`;
  return (
    `${base} ${orders} still in flight: without a key LightningMate can't open, report or settle ` +
    "them — it only releases held payments back to their buyers before they expire, and Amboss may count " +
    "an order that isn't fulfilled against your seller score."
  );
}

/**
 * A manual spend (a channel open, an on-chain send) the server refused
 * because it would take coins promised to buyers — accepted Magma orders,
 * paid LSP orders whose channels aren't open yet. Its message names them; the
 * caller asks "spend them anyway?" and sends again with `spendPromised` only
 * after a yes. Null for any other error.
 */
export function promisedSpend(err: unknown): { message: string; promisedSat: number } | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { error?: unknown; message?: unknown; promisedSat?: unknown } | null;
  if (body?.error !== "capital_promised") return null;
  return {
    message: typeof body.message === "string" && body.message ? body.message : err.message,
    promisedSat: Number(body.promisedSat) || 0,
  };
}

/** The confirmation for spending promised coins anyway. */
export function spendPromisedQuestion(refusal: { message: string }): string {
  return `${refusal.message} Spend them anyway?`;
}
