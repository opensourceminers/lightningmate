import { useEffect, useState } from "react";
import type { ConfirmOpts } from "./Overlay";
import type { AutomationSwitch, AutopilotConfig, AutopilotConfigPatch, Eligibility, MyOffer, OfferSyncStatus } from "../types";
import {
  disableSellingMessage,
  enableSellingMessage,
  enableSellingOffersMessage,
  enableSellingOffersPendingMessage,
  enableSellingPendingMessage,
  offersSwitchOnLists,
} from "../magmaView";
import { LSP_NOT_PAUSED, pauseLines } from "../autopilotView";

/**
 * Switching Liquidity provision on and off (D9) — the decisions behind the
 * Autopilot → Magma switch, kept apart from the panel so they are tested
 * without a browser.
 *
 * On: the confirmation opens at once and shows the live selling check when it
 * arrives. Before, the switch waited for the check (Amboss's public book, up to
 * its 15 s deadline — or longer when it hung) before any dialog appeared. It
 * also says what happens to the offers disabled now: the autopilot lists them
 * again, each once it has a price and can be funded (the switch-off below
 * disabled them; before, each had to be enabled again by hand).
 *
 * Off with offers listed: each is disabled by STATE (the server reads it and
 * flips only an enabled one), and selling is switched off only once none is
 * listed any more. Before, every offer listed a moment earlier was flipped and
 * every failure swallowed: an offer the autopilot had disabled in between was
 * ENABLED again, a failed flip left an offer listed, and the dialog said
 * "your offers are disabled" — while nobody decided their orders, which then
 * timed out against the seller score.
 */
export interface SellingSwitchDeps {
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  /** The live selling check (GET /amboss/eligibility). */
  eligibility: () => Promise<Eligibility>;
  /** This node's offers on Amboss. */
  offers: () => Promise<MyOffer[]>;
  /** The autopilot's last offer sync (GET /amboss/offer-sync): which offers
   *  a switch-on lists again (offersSwitchOnLists). */
  offerSync: () => Promise<OfferSyncStatus>;
  /** Disable one offer by state (POST /amboss/offer/toggle, want DISABLED):
   *  resolves with its status, throws when Amboss didn't disable it. */
  disableOffer: (id: string) => Promise<{ status: string }>;
  save: (patch: AutopilotConfigPatch, successMsg?: string) => Promise<boolean>;
  toast: (message: string, type?: "success" | "error" | "info") => void;
}

/** The body of the "turn on" confirmation: the check's verdict once it is
 *  in, "checking…" until then — and, once the offers are read, what the
 *  switch does with the disabled ones (they are listed again). */
export function EnableSellingBody({ check, disabledOffers }: { check: Promise<Eligibility | null>; disabledOffers: Promise<number | null> }) {
  const [result, setResult] = useState<{ done: boolean; e: Eligibility | null }>({ done: false, e: null });
  const [offers, setOffers] = useState<{ done: boolean; n: number | null }>({ done: false, n: null });
  useEffect(() => {
    let alive = true;
    void check.then((e) => {
      if (alive) setResult({ done: true, e });
    });
    void disabledOffers.then((n) => {
      if (alive) setOffers({ done: true, n });
    });
    return () => {
      alive = false;
    };
  }, [check, disabledOffers]);
  const listing = offers.done ? enableSellingOffersMessage(offers.n) : enableSellingOffersPendingMessage();
  return (
    <>
      <p className="modal-msg">{result.done ? enableSellingMessage(result.e) : enableSellingPendingMessage()}</p>
      {listing && <p className="modal-msg">{listing}</p>}
    </>
  );
}

/** Switch selling on — after a confirmation that opens at once. */
export async function turnSellingOn(d: SellingSwitchDeps): Promise<boolean> {
  // Both started now, never awaited before the dialog: they answer when Amboss does.
  const check = d.eligibility().catch(() => null);
  // Counted as the server decides it: never more than it will list.
  const disabledOffers = Promise.all([d.offers(), d.offerSync().catch(() => null)])
    .then(([os, sync]) => offersSwitchOnLists(os, sync))
    .catch(() => null);
  const ok = await d.confirm({
    title: "Turn on Liquidity provision?",
    body: <EnableSellingBody check={check} disabledOffers={disabledOffers} />,
    confirmLabel: "Turn on",
  });
  if (!ok) return false;
  return d.save({ sellEnabled: true }, "Liquidity provision is on");
}

const short = (id: string) => `${id.slice(0, 8)}…`;

/** Switch selling off — and, if the operator wants, every listed offer too. */
export async function turnSellingOff(d: SellingSwitchDeps): Promise<boolean> {
  const listed = await d
    .offers()
    .then((os) => os.filter((o) => o.status === "ENABLED"))
    .catch(() => null);
  if (listed === null) {
    // Can't tell whether an offer is still listed: say so rather than assume none.
    const ok = await d.confirm({
      title: "Turn off Liquidity provision",
      message:
        "Your offers could not be read from Amboss right now. If one is still listed, its new orders wait for your decision on " +
        "Market → Orders — and Amboss counts an order nobody decides against your seller score. Turn off anyway?",
      confirmLabel: "Turn off",
      danger: true,
    });
    return ok ? d.save({ sellEnabled: false }, "Liquidity provision is off — check your offers on Market → Sell") : false;
  }
  if (listed.length === 0) return d.save({ sellEnabled: false }, "Liquidity provision is off");
  if (
    await d.confirm({
      title: "Turn off Liquidity provision",
      message: disableSellingMessage(listed.length),
      confirmLabel: "Turn off & disable offers",
      danger: true,
    })
  ) {
    const stillListed: string[] = [];
    for (const o of listed) {
      try {
        const r = await d.disableOffer(o.id);
        if (r.status === "ENABLED") stillListed.push(short(o.id));
      } catch (e) {
        stillListed.push(`${short(o.id)} (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    if (stillListed.length) {
      // A listed offer with nobody deciding its orders is worse than selling
      // on: the order lane keeps handling them until the offer is disabled.
      const one = stillListed.length === 1;
      d.toast(
        `Liquidity provision stays on: ${one ? "offer" : "offers"} ${stillListed.join(", ")} could not be disabled and ${one ? "is" : "are"} ` +
          `still listed. Try again, or disable ${one ? "it" : "them"} on Market → Sell.`,
        "error",
      );
      return false;
    }
    return d.save({ sellEnabled: false }, "Liquidity provision is off; your offers are disabled");
  }
  if (
    await d.confirm({
      title: "Turn off Liquidity provision only?",
      message: "Your offers stay listed on Amboss, and their orders wait for your decision on Market → Orders.",
      confirmLabel: "Turn off only",
    })
  ) {
    return d.save({ sellEnabled: false }, "Liquidity provision is off (offers still listed)");
  }
  return false;
}


/** The "Pause all automation" confirmation: what stops, and what doesn't —
 *  LSP mode included, which is no switch of the autopilot's (LSP_NOT_PAUSED). */
export function PauseBody({ lines, lspModeOn = false }: { lines: string[]; lspModeOn?: boolean }) {
  return (
    <>
      <p className="modal-msg">This switches off at once:</p>
      <ul className="preset-changes">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {lspModeOn ? <p className="modal-msg">{LSP_NOT_PAUSED}</p> : null}
      <p className="modal-msg muted">
        What is already under way ends on record, and a sold channel's promised fee cap is still kept. “Resume” switches back on
        what was on — Liquidity provision excepted, which you switch on yourself.
      </p>
    </>
  );
}

/**
 * "Pause all automation" (review a6-ux:presets-unconfirmed-capital: there was
 * no global off — five switches on four sub-tabs). After a confirmation that
 * says what stops — and, with Liquidity provision on and offers listed, the
 * same question as switching selling off: disable them too, or keep them
 * listed with their orders waiting for a decision nobody makes (D6).
 */
export async function pauseAllAutomation(
  d: Pick<SellingSwitchDeps, "confirm" | "offers" | "disableOffer" | "toast"> & {
    config: Pick<AutopilotConfig, AutomationSwitch>;
    /** LSP mode (Settings) is on: the pause leaves it on, and says so. */
    lspModeOn?: boolean;
    pause: () => Promise<boolean>;
  },
): Promise<boolean> {
  const lines = pauseLines(d.config);
  if (lines.length === 0) return false;
  const ok = await d.confirm({
    title: "Pause all automation?",
    body: <PauseBody lines={lines} lspModeOn={d.lspModeOn} />,
    confirmLabel: "Pause all",
    danger: true,
  });
  if (!ok) return false;
  if (d.config.sellEnabled) {
    const listed = await d
      .offers()
      .then((os) => os.filter((o) => o.status === "ENABLED"))
      .catch(() => null);
    if (listed === null) {
      const go = await d.confirm({
        title: "Your Magma offers",
        message:
          "Your offers could not be read from Amboss right now. If one is still listed, its new orders wait for your decision on " +
          "Market → Orders — and Amboss counts an order nobody decides against your seller score. Pause anyway?",
        confirmLabel: "Pause anyway",
        danger: true,
      });
      if (!go) return false;
    } else if (listed.length > 0) {
      if (await d.confirm({ title: "Your Magma offers", message: disableSellingMessage(listed.length), confirmLabel: "Disable offers too", danger: true })) {
        const stillListed: string[] = [];
        for (const o of listed) {
          try {
            const r = await d.disableOffer(o.id);
            if (r.status === "ENABLED") stillListed.push(short(o.id));
          } catch (e) {
            stillListed.push(`${short(o.id)} (${e instanceof Error ? e.message : String(e)})`);
          }
        }
        if (stillListed.length) {
          // Paused with an offer listed nobody decides on: not without asking.
          d.toast(`Not paused: offer ${stillListed.join(", ")} could not be disabled and is still listed. Try again, or disable it on Market → Sell.`, "error");
          return false;
        }
      } else if (
        !(await d.confirm({
          title: "Pause with your offers still listed?",
          message: "Your offers stay listed on Amboss, and their orders wait for your decision on Market → Orders.",
          confirmLabel: "Pause, keep offers listed",
        }))
      ) {
        return false;
      }
    }
  }
  return d.pause();
}
