import type { AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { getNodeSummary } from "./node.js";
import { storeIncidents, type StoreIncident } from "../store.js";
import type { ServiceFeeLedger } from "./serviceFee.js";
import type { MagmaRefusal } from "./magmaDesk.js";

export interface Alert {
  level: "warn" | "info";
  message: string;
  /** Set on alerts the operator acknowledges (dismisses) explicitly; derived
   *  node alerts have none and disappear on their own. */
  id?: string;
}

const LOW_ONCHAIN_SATS = 25_000;

/** What losing each state file means for the operator, in plain words. */
const RESET_CONSEQUENCE: Record<string, string> = {
  "autopilot.json": "All automation is OFF and settings are back to defaults until you set them again.",
  "lsps1-orders.json": "LSP orders that were in progress can no longer be tracked — check them in LND.",
  "amboss.json": "Reconnect your Amboss key in Settings.",
  "overrides.json": "Per-channel fee overrides (incl. exclusions) are gone — re-check them on the Channels tab.",
  "settings.json": "Check your Settings (LSP mode, currency, LN+ lookups).",
  "channel-uptime.json": "How long each channel's peer has been offline is counted again from now — no channel counts as long offline until it has been for 72 hours.",
  "magma-amboss-leases.json":
    "The last list of older Magma sales Amboss reports with a running lease is fetched again (with an Amboss key set) — until then, such a sale's channel is not marked as leased.",
  "service-fees.json": "Pending service-fee records were lost.",
  "magma-purchases.json":
    "The record of inbound you bought on Magma was lost — the channels are not affected; P&L no longer shows those purchases.",
  "rebalance-totals.json":
    "The daily sums of rebalancing fees older than 400 days are gone: P&L counts those LND's payment history still lists, and no others.",
  "close-txs.json":
    "LightningMate's copy of your close transactions is gone: a close whose transactions LND's wallet has since forgotten shows its cost as unknown in P&L.",
  "decision-log.json": "The record of when each autopilot area's decision changed starts afresh; each area's current decision is kept.",
  "magma-orders.json":
    "Magma orders in progress lost their record, and with it what claims their held payments. No channel is opened " +
    "for such an order: when Amboss asks for one, its held payment is released back to the buyer instead (LND releases " +
    "any other before it expires), and nothing is booked as a sale. Check Market → Orders and your channels in LND for " +
    "channels already opened for them — those can no longer be paid for.",
};

/** What an "adjusted" file holds, in plain words, for the alert text. */
const ADJUSTED_WHAT: Record<string, string> = {
  "autopilot.json": "Saved autopilot settings",
  "overrides.json": "Fees pinned by hand",
};

/** An "adjusted" file whose repair is not about limits: what was done, and
 *  what it costs the operator. (Review of P8: malformed daily sums dropped
 *  from rebalance-totals.json read "were outside the current limits and were
 *  adjusted", and nothing said P&L's older costs were now lower.) */
const ADJUSTED_MESSAGE: Record<string, (detail: string) => string> = {
  "rebalance-totals.json": (detail) =>
    `Some daily sums of older rebalancing fees in rebalance-totals.json were malformed and have been repaired or dropped: ${detail}. ` +
    "P&L may now count less rebalancing cost for those days than you paid — by what was dropped — unless LND's payment history still lists those rebalances.",
};

function incidentMessage(i: StoreIncident): string {
  // A missing file names the most recent damaged copy found beside it, which
  // may stem from an earlier incident — say so rather than claim it is this one.
  const kept = !i.quarantinedAs
    ? undefined
    : i.missing
      ? `The most recent damaged copy is kept as ${i.quarantinedAs}.`
      : `The damaged copy was saved as ${i.quarantinedAs}.`;
  const what = i.missing ? "was missing" : "was damaged";
  const sentences = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ");
  switch (i.kind) {
    case "recovered":
      return sentences(`${i.file} ${what} and has been restored from its previous version.`, kept);
    case "reset":
      return sentences(`${i.file} ${what} and no backup was usable, so it was reset.`, RESET_CONSEQUENCE[i.file], kept);
    case "write_failed":
      return `Could not save ${i.file} (${i.detail}) — recent changes will be lost on restart. Is the disk full?`;
    case "adjusted":
      return (
        ADJUSTED_MESSAGE[i.file]?.(i.detail) ??
        `${ADJUSTED_WHAT[i.file] ?? `Values in ${i.file}`} were outside the current limits and were adjusted: ${i.detail}.`
      );
    case "unrecorded_open":
      return `${i.detail} Is the disk full?`;
    case "unpaid_channel":
      return `${i.detail} The buyer was not charged. The channel is yours: close it to take the capital back, or keep it for routing.`;
  }
}

/** Damaged, unsaveable or adjusted state files — these must never go unnoticed. */
export function stateAlerts(dataDir: string): Alert[] {
  return storeIncidents(dataDir).map((i) => ({
    level: "warn" as const,
    message: incidentMessage(i),
    id: `state:${i.id}`,
  }));
}

/** What to do about a turned-down order, by what it was refused for. Only a
 *  cap or the wallet can be changed to serve orders like it; for anything
 *  else (an unreachable buyer, an asset or a fee Amboss didn't report, an
 *  accept Amboss refused, a deadline) more capital would not have helped, and
 *  the alert used to say it would. */
const REFUSAL_ADVICE: Record<MagmaRefusal["kind"], string> = {
  cap: "If you want orders like it, raise the caps on Autopilot → Magma; see Market → Orders.",
  capital: "If you want orders like it, add on-chain funds to the wallet (or lower the reserve on Autopilot → Magma); see Market → Orders.",
  other: "See Market → Orders for the order.",
};

/** Magma orders the order lane turned down (cap, capital, an unreachable
 *  buyer …), until dismissed — each one a sale this node didn't make. */
export function magmaRefusalAlerts(desk: { refusals(): Pick<MagmaRefusal, "orderId" | "sizeSats" | "reason" | "kind">[] }): Alert[] {
  return desk.refusals().map((r) => ({
    level: "warn" as const,
    message: `A ${Math.round(r.sizeSats).toLocaleString("en-US")} sat Magma order was turned down: ${r.reason}. ${REFUSAL_ADVICE[r.kind] ?? REFUSAL_ADVICE.other}`,
    id: `magma:${r.orderId}`,
  }));
}

/** A listed offer of this node that is priced wrong: listed for free, or
 *  holding terms other than the ones LightningMate last wrote — and one the
 *  autopilot took off the market for being free, or is to list since selling
 *  was switched on but can't, having no price. Derived from the offer sync
 *  record (the order lane re-reads listed offers every two minutes), so each
 *  goes once the offer is right again. What it says LightningMate does is
 *  only what it will do: with selling on, a free offer's price goes back on
 *  (one the autopilot manages, its price known) or it is taken off the market;
 *  with selling off or paused, nothing changes it. */
export function offerPriceAlerts(
  sync: {
    offers: {
      offerId: string;
      amboss: { status: string; feeRatePpm: number; baseFeeSats: number; minBlockLength?: number };
      /** To be listed again, waiting for the autopilot's price ("lease": one
       *  it doesn't price — the operator's to change). */
      listingWaits?: string;
      inSync: boolean;
      lastWrite: { ok: boolean; verified?: boolean; error?: string; by?: string; action?: string } | null;
      /** Orders under this size pay less than their channel's on-chain cost
       *  at today's fee rate — the lane turns them down (an offer whose window
       *  the autopilot doesn't size). */
      turnedDownUnderSat?: number;
      /** Set when the operator owns the offer's terms, when the autopilot
       *  took it off the market for being free, or when it is to be listed
       *  since Liquidity provision was switched on. */
      control?: { manual?: unknown; freeDisabledAt?: string; listOnAt?: string };
    }[];
  },
  /** Liquidity provision on and not paused: the autopilot acts on offers. */
  selling: boolean,
  /** Auto-pricing on: the autopilot prices (and lists again) the offers whose
   *  terms are its own. */
  autoPricing = false,
): Alert[] {
  const alerts: Alert[] = [];
  for (const e of sync.offers) {
    const id = `${e.offerId.slice(0, 8)}…`;
    const free = e.amboss.feeRatePpm <= 0 && e.amboss.baseFeeSats <= 0;
    if (e.amboss.status === "ENABLED" && free) {
      alerts.push({
        level: "warn",
        message:
          `Your Magma offer ${id} is listed at 0 ppm + 0 sat: Amboss can match orders to it at 0 sats for you. ` +
          (selling
            ? (e.control?.manual
                ? "Its terms are yours, so LightningMate takes it off the market within minutes; set its price on Market → Sell, then enable it."
                : "LightningMate puts its last price back within minutes, or takes it off the market if it knows none.") +
              " Orders that don't cover their channel's on-chain cost are turned away meanwhile."
            : "Liquidity provision is off (or paused), so nothing changes it: set its price on Market → Sell or disable it, and reject any order it gets."),
      });
    } else if (e.amboss.status !== "ENABLED" && e.control?.freeDisabledAt && free) {
      // Who lists it again, said exactly (review 2026-10-25: "LightningMate
      // lists it again itself" was said of offers it never relists — the
      // operator's own, or with auto-pricing off).
      alerts.push({
        level: "warn",
        message:
          `Your Magma offer ${id} was taken off the market: Amboss listed it for free (0 ppm + 0 sat). ` +
          (autoPricing && !e.control.manual
            ? "LightningMate lists it again itself — its terms written and checked first — once it has its price; or set one on Market → Sell."
            : "Set its price on Market → Sell and enable it."),
      });
    } else if (e.amboss.status !== "ENABLED" && e.control?.listOnAt && free) {
      alerts.push({
        level: "warn",
        message:
          `Your Magma offer ${id} isn't listed yet: it has no price (0 ppm + 0 sat). Set its price on Market → Sell — ` +
          `LightningMate lists it once it has one${e.control.manual || !autoPricing ? "." : " (it prices it itself once it knows a price)."}`,
      });
    } else if (e.amboss.status === "ENABLED" && !selling && e.lastWrite?.by === "autopilot" && e.lastWrite.action === "disable" && !e.lastWrite.ok) {
      // Listed with Liquidity provision off, LightningMate's disable not taken
      // (one being listed when selling went off, or a capital disable).
      alerts.push({
        level: "warn",
        message:
          `Your Magma offer ${id} is listed although Liquidity provision is off — LightningMate tried to take it off the market and couldn't ` +
          `(${e.lastWrite.error ?? "no answer"}). Disable it on Market → Sell: meanwhile its orders wait for your decision on Market → Orders.`,
      });
    } else if (e.amboss.status !== "ENABLED" && e.listingWaits === "lease") {
      alerts.push({
        level: "warn",
        message:
          `Your Magma offer ${id} isn't listed again: its ${e.amboss.minBlockLength ? `${e.amboss.minBlockLength.toLocaleString("en-US")}-block ` : ""}lease isn't one the autopilot prices ` +
          "(with auto-size off it keeps its lease). Set its price or its lease on Market → Sell, or turn on auto-size — it gives the offer the standard lease.",
      });
    } else if (e.lastWrite?.ok && e.lastWrite.verified === false && !e.inSync) {
      alerts.push({
        level: "warn",
        message: `Amboss doesn't hold the terms LightningMate set for offer ${id} (${e.lastWrite.error ?? "it reads back different"}). Check it on Market → Sell.`,
      });
    }
    // Listed, with a window that invites orders the lane turns down below
    // cost (its window not the autopilot's to size): from which size.
    if (e.amboss.status === "ENABLED" && e.turnedDownUnderSat !== undefined) {
      alerts.push({
        level: "warn",
        message:
          `Your Magma offer ${id}: orders under ${Math.round(e.turnedDownUnderSat).toLocaleString("en-US")} sat pay less than opening and closing their channel costs at today's fee rate — ` +
          `LightningMate turns them down, and each refusal can cost seller score. ${
            e.control?.manual ? "Raise its min channel (or its price) on Market → Sell." : "Turn on auto-size, or raise its min channel on Market → Sell."
          }`,
      });
    }
  }
  return alerts;
}

/** Sold channels whose fee breaks the routing-fee promise made to their buyer
 *  (D7) and that LND keeps refusing to lower: the lease-promise keeper tries
 *  every 10 minutes, but a promise broken for hours must not be one line in
 *  the run history (review 2026-10-25, PROBE-LEASE-FAIL). Derived: each goes
 *  once a write takes or the fee is back within the promise. */
export function leasePromiseAlerts(failing: { channelId: string; alias: string; since: string; error: string; why: string }[]): Alert[] {
  return failing.map((f) => {
    const promise = f.why.replace(/^lease promise: /, "").replace(/ — its fee .*$/, "");
    return {
      level: "warn" as const,
      message:
        `The fee of ${f.alias} (${f.channelId}), a channel you sold, is above what its buyer was promised (${promise}), ` +
        `and LND has refused to lower it since ${f.since.slice(0, 16).replace("T", " ")} UTC: ${f.error}. ` +
        "LightningMate tries again every 10 minutes. If it keeps failing, check LND's log for why it refuses the update, and the channel's state (for example whether it is closing).",
    };
  });
}

/** Service fees that need a human: given up, or refused for safety. */
export function serviceFeeAlerts(ledger: Pick<ServiceFeeLedger, "problems">): Alert[] {
  return ledger.problems().map((e) => ({
    level: "warn" as const,
    message: `Service fee for ${e.source} order ${e.orderId.slice(0, 12)} not paid: ${e.lastError ?? e.state}`,
    id: `fee:${e.key}`,
  }));
}

/** Derive actionable alerts from the current node state (read-only), plus any
 *  `extra` app-level alerts. Node trouble never hides the extras. */
export async function getAlerts(lnd: AuthenticatedLnd, extra: Alert[] = []): Promise<Alert[]> {
  const alerts: Alert[] = [...extra];
  let node: Awaited<ReturnType<typeof getNodeSummary>>;
  let channels: Awaited<ReturnType<typeof getChannelsView>>;
  try {
    [node, channels] = await Promise.all([getNodeSummary(lnd), getChannelsView(lnd)]);
  } catch (err) {
    if (extra.length === 0) throw err; // nothing else to show: let the caller report the node error
    return alerts;
  }

  if (!node.syncedToChain) {
    alerts.push({ level: "warn", message: "Node is not synced to the chain" });
  }

  const inactive = channels.filter((c) => !c.active).length;
  if (inactive > 0) {
    alerts.push({ level: "warn", message: `${inactive} channel${inactive > 1 ? "s" : ""} offline` });
  }

  if (node.balances.onchainConfirmedSats < LOW_ONCHAIN_SATS) {
    alerts.push({ level: "info", message: "Low on-chain balance for fees / channel opens" });
  }

  return alerts;
}
