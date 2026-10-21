import type { ChannelLease, OfflineInfo } from "./types";
import { sats, satsCompact } from "./format";

/**
 * The words and small decisions behind closing a channel (review
 * a3-channels:offline-means-force-close, a6-ux:lease-unaware-close —
 * package P4), apart from the components so they can be tested.
 *
 * Before: the Channels table offered "close" on every channel and knew no
 * lease; for a peer offline even for a moment the dialog offered only a
 * force-close, and with the peer online a force-close was one click with no
 * word on what it does.
 */

/** What the close dialog knows about a channel (a ChannelView fits). */
export interface CloseTarget {
  peerAlias: string;
  peerPubkey?: string;
  capacity: number;
  /** Our side of it — what a close returns. */
  localBalance?: number;
  initiator?: "local" | "remote";
  active: boolean;
  transactionId: string;
  transactionVout: number;
  lease?: ChannelLease | null;
  offline?: OfflineInfo | null;
  /** A force-close's time-lock (blocks) and the commitment fee LND last signed (sat). */
  csvDelayBlocks?: number | null;
  commitFeeSats?: number | null;
}

/** Mirrors the server: offline at least this long counts toward a close. */
export const LONG_OFFLINE_HOURS = 72;
/** The longest CSV delay LND accepts by default (bitcoin.maxlocaldelay). */
const MAX_CSV_BLOCKS = 2_016;
/** A sweep of one time-locked output, roughly (vbytes). */
const SWEEP_VBYTES = 110;

/** "~1 day", "~14 days" for a number of blocks. */
const daysText = (blocks: number) => {
  const d = Math.max(1, Math.round(blocks / 144));
  return `~${d} day${d === 1 ? "" : "s"}`;
};

/** "~41 d left", "~5 h left" — or that the funding hasn't confirmed. */
export function leaseLeft(l: Pick<ChannelLease, "blocksLeft" | "reportedByAmboss" | "reportedAt">, nowMs = Date.now()): string {
  if (l.reportedByAmboss) {
    // A listing older than a day says from when it is.
    const at = l.reportedAt ? Date.parse(l.reportedAt) : NaN;
    return Number.isFinite(at) && nowMs - at > 86_400_000 ? `running (per Amboss, ${new Date(at).toISOString().slice(0, 10)})` : "running (per Amboss)";
  }
  if (l.blocksLeft === null) return "funding not confirmed yet";
  const hours = (Math.max(0, l.blocksLeft) * 10) / 60;
  return hours >= 48 ? `~${Math.round(hours / 24)} d left` : `~${Math.max(1, Math.round(hours))} h left`;
}

/** The Channels table's tag for a leased channel (null: none, or a sale's
 *  lease is over). */
export function leaseTag(l: ChannelLease | null | undefined): string | null {
  if (!l) return null;
  if (!l.running) return l.kind === "magma_purchase" ? "bought on Magma · lease over" : null;
  const what = l.kind === "magma_sale" ? "Magma lease" : l.kind === "lsps1_sale" ? "LSP lease" : "bought on Magma";
  return `${what} · ${leaseLeft(l)}`;
}

/** What closing a channel inside its lease breaks — the dialog asks for an
 *  explicit "close it anyway" before any close button works. Null: no
 *  running lease. */
export function leaseBreakWarning(l: ChannelLease | null | undefined): string | null {
  if (!l?.running) return null;
  const until = l.reportedByAmboss
    ? "for as long as Amboss reports its lease running"
    : l.untilHeight === null
      ? "until its funding has confirmed and the lease has run"
      : `until block ${sats(l.untilHeight)} (${leaseLeft(l)})`;
  switch (l.kind) {
    case "magma_sale":
      return `This channel was sold on Magma and is leased ${until}. Closing it now breaks the lease the buyer paid for — and Amboss counts that against your seller score.`;
    case "lsps1_sale":
      return `This channel was sold to an LSP client, and this node promised to keep it open ${until}. Closing it now breaks that promise.`;
    case "magma_purchase":
      return `You bought this channel on Magma for ${sats(l.costSats ?? 0)} sat; its lease runs ${until}. Closing it now throws away the inbound you paid for.`;
  }
}

/** "offline ~5 h", "offline ~3 d", "online 30% of the time" (null: online and steady). */
export function offlineLabel(o: OfflineInfo | null | undefined): string | null {
  if (!o) return null;
  if (o.hours === null) return o.uptimeShare !== null ? `online ${Math.round(o.uptimeShare * 100)}% of the time` : null;
  return o.hours >= 48 ? `offline ~${Math.round(o.hours / 24)} d` : `offline ~${Math.max(1, Math.round(o.hours))} h`;
}

/** A peer away for a short while — not a reason to close at all. */
export function shortOutage(t: Pick<CloseTarget, "active" | "offline">): boolean {
  return !t.active && !(t.offline?.long ?? false);
}

/**
 * What a force-close does, said before the button that sends it: the
 * time-lock, the fee nobody can choose any more, the sweep, HTLCs on-chain —
 * and the lease it breaks, or that the outage may simply end.
 */
export function forceCloseConsequences(t: CloseTarget, economyRate: number | null): string[] {
  const out: string[] = [];
  const back = t.localBalance !== undefined ? `Your ${satsCompact(t.localBalance)} sat` : "Your side of the channel";
  out.push(
    t.csvDelayBlocks
      ? `${back} come back on-chain only after a time-lock of ${sats(t.csvDelayBlocks)} blocks (${daysText(t.csvDelayBlocks)}) — not spendable before.`
      : `${back} come back on-chain only after a time-lock (the channel's CSV delay — up to ${sats(MAX_CSV_BLOCKS)} blocks, ~2 weeks).`,
  );
  out.push(
    `The closing fee was fixed when the channel last updated${t.commitFeeSats ? ` (~${sats(t.commitFeeSats)} sat in the commitment transaction${t.initiator === "local" ? ", paid from your side — you opened it" : ""})` : ""}: ` +
      "you can't choose it, and in a busy mempool LND may have to add a fee bump.",
  );
  out.push(
    `Claiming your funds after the time-lock is one more on-chain transaction${economyRate ? ` (~${sats(Math.ceil(economyRate * SWEEP_VBYTES))} sat at today's economy rate)` : ""}.`,
  );
  out.push("Payments in flight through the channel are settled on-chain — more fees, more waiting.");
  const lease = leaseBreakWarning(t.lease);
  if (lease) out.push(lease);
  if (shortOutage(t) && t.offline?.hours != null) {
    out.push(
      `The peer has been offline for only ~${Math.max(1, Math.round(t.offline.hours))} h — most outages end on their own. Reconnecting, or waiting and closing cooperatively, costs far less.`,
    );
  }
  return out;
}

/** A close the server refused because the channel is inside its lease (409
 *  lease_active): its message. Null: any other error. */
export function leaseRefusal(e: unknown): string | null {
  const err = e as { status?: unknown; body?: unknown } | null;
  const body = err?.body as { error?: unknown; message?: unknown } | null | undefined;
  if (err?.status !== 409 || body?.error !== "lease_active") return null;
  return typeof body.message === "string" ? body.message : "This channel is inside its lease.";
}

/** The lease a 409 lease_active refusal named (null: any other error, or a
 *  refusal without one). The server may know a lease the dialog was not
 *  given — Amboss's listing changed since the table loaded, say — and the
 *  dialog then shows it with its "close it anyway" box: a refusal is never
 *  a dead end (review of P4: the channel could not be closed from the UI). */
export function refusedLease(e: unknown): ChannelLease | null {
  if (leaseRefusal(e) === null) return null;
  const lease = ((e as { body?: { lease?: unknown } }).body?.lease ?? null) as ChannelLease | null;
  return lease && typeof lease === "object" && typeof lease.kind === "string" && lease.running === true ? lease : null;
}

/** The lease the close dialog asks about: the channel's own while it runs,
 *  else one the server named when it refused the close. */
export function dialogLease(t: Pick<CloseTarget, "lease">, refused: ChannelLease | null): ChannelLease | null {
  if (t.lease?.running) return t.lease;
  return refused ?? t.lease ?? null;
}

/**
 * Which of the close dialog's buttons work: the cooperative close needs a
 * fee rate; both it and the step to a force-close wait while a lease is
 * running until the operator ticked "close it anyway"; nothing while a
 * request is under way.
 */
export function closeButtons(s: { busy: boolean; rate: number; lease: ChannelLease | null | undefined; breakLease: boolean }): { coop: boolean; force: boolean } {
  const blockedByLease = leaseBreakWarning(s.lease) !== null && !s.breakLease;
  return { coop: !s.busy && s.rate > 0 && !blockedByLease, force: !s.busy && !blockedByLease };
}
