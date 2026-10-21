import { useEffect, useState } from "react";
import type { ConfirmOpts } from "./Overlay";
import type { AutopilotConfigPatch, Eligibility, MyOffer } from "../types";
import { disableSellingMessage, enableSellingMessage, enableSellingPendingMessage } from "../magmaView";

/**
 * Switching Liquidity provision on and off (D9) — the decisions behind the
 * Autopilot → Magma switch, kept apart from the panel so they are tested
 * without a browser.
 *
 * On: the confirmation opens at once and shows the live selling check when it
 * arrives. Before, the switch waited for the check (Amboss's public book, up to
 * its 15 s deadline — or longer when it hung) before any dialog appeared.
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
  /** Disable one offer by state (POST /amboss/offer/toggle, want DISABLED):
   *  resolves with its status, throws when Amboss didn't disable it. */
  disableOffer: (id: string) => Promise<{ status: string }>;
  save: (patch: AutopilotConfigPatch, successMsg?: string) => Promise<boolean>;
  toast: (message: string, type?: "success" | "error" | "info") => void;
}

/** The body of the "turn on" confirmation: the check's verdict once it is
 *  in, "checking…" until then. */
export function EnableSellingBody({ check }: { check: Promise<Eligibility | null> }) {
  const [result, setResult] = useState<{ done: boolean; e: Eligibility | null }>({ done: false, e: null });
  useEffect(() => {
    let alive = true;
    void check.then((e) => {
      if (alive) setResult({ done: true, e });
    });
    return () => {
      alive = false;
    };
  }, [check]);
  return <p className="modal-msg">{result.done ? enableSellingMessage(result.e) : enableSellingPendingMessage()}</p>;
}

/** Switch selling on — after a confirmation that opens at once. */
export async function turnSellingOn(d: SellingSwitchDeps): Promise<boolean> {
  // Started now, never awaited before the dialog: it answers when Amboss does.
  const check = d.eligibility().catch(() => null);
  const ok = await d.confirm({ title: "Turn on Liquidity provision?", body: <EnableSellingBody check={check} />, confirmLabel: "Turn on" });
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
