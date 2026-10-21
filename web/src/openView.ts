import type { OpenEstimate, StartingFee } from "./types";
import { sats } from "./format";

/**
 * What the Open form says before a channel is funded (review
 * a3-channels:open-fee-gate-too-loose — package P4): the on-chain fee at the
 * chosen rate, what is left to spend after it (the reserve and the coins
 * promised to buyers kept), and how long the open and a later close take to
 * pay back at what a channel earns on this node. Before, the form sent a
 * size alone: no fee choice, no cost, no balance check — LND paid its
 * 6-block rate.
 */
export interface OpenLines {
  /** "~700 sat on-chain at 4 sat/vB". */
  cost: string | null;
  /** The routing fee the channel starts with — the fee engine's new-channel
   *  fee, not LND's own default (stock: 1 sat + 1 ppm). */
  fee: string | null;
  /** What is left to spend after the open, or that there isn't enough. */
  left: string | null;
  /** How long the open and its close take to pay back. */
  payback: string | null;
  /** Something to think twice about (not enough funds, over a year's payback,
   *  a rate above the autopilot's maximum). */
  warn: string | null;
}

/** "starts at 80 ppm + 0 msat — …" (the fee engine's new-channel fee). */
export function startingFeeText(f: StartingFee): string {
  return `it starts at ${sats(f.feeRatePpm)} ppm + ${sats(f.baseFeeMsat)} msat routing fee — the fee engine's new-channel fee, not LND's default`;
}

/** Why the payback can't be estimated, from what the yield stands on. */
function unmeasured(est: OpenEstimate): string {
  const e = est.yieldEvidence;
  if (!e || !e.forwardsRead) return "this node's routing income couldn't be read — its payback can't be estimated";
  if (e.channels === 0) return "no channel is a month old yet — its payback can't be estimated";
  return (
    `too little routing on month-old channels to estimate its payback (${sats(e.forwards)} forward${e.forwards === 1 ? "" : "s"}, ` +
    `${sats(e.earnedSat)} sat in 30 days — it takes ${est.minYieldForwards} forwards or ${sats(est.minYieldEarnedSat)} sat)`
  );
}

export function openLines(sizeSats: number, rate: number | null, est: OpenEstimate | null): OpenLines {
  if (!est || !rate || !(sizeSats > 0)) return { cost: null, fee: null, left: null, payback: null, warn: null };
  const open = Math.ceil(rate * est.openVbytes);
  const close = Math.ceil(rate * est.closeVbytes);
  const cost = `~${sats(open)} sat on-chain to open at ${rate} sat/vB`;
  let left: string | null = null;
  let warn: string | null = null;
  if (est.spendableSat !== null) {
    if (sizeSats > est.spendableSat) {
      warn =
        `Only ${sats(est.spendableSat)} sat can be spent after the on-chain reserve (${sats(est.reserveSat ?? 0)} sat)` +
        (est.promisedSat ? ` and the ${sats(est.promisedSat)} sat promised to buyers` : "") +
        ` — not enough for ${sats(sizeSats)}.`;
    } else {
      left = `${sats(est.spendableSat - sizeSats)} sat left to spend after it (the reserve kept)`;
    }
  }
  let payback: string | null = null;
  if (est.yieldPpmYear !== null && est.yieldPpmYear > 0) {
    const perYear = (sizeSats * est.yieldPpmYear) / 1_000_000;
    const months = ((open + close) / perYear) * 12;
    payback =
      `the open and a later close (~${sats(open + close)} sat) pay back in ~${months < 1 ? "<1" : Math.round(months)} month${Math.round(months) === 1 ? "" : "s"} ` +
      `at what a channel earns here (${sats(est.yieldPpmYear)} ppm/yr in month-old channels)`;
    if (months > est.paybackMonths && !warn) {
      warn = `At ${rate} sat/vB this channel takes ~${Math.round(months)} months to earn back its open and close — more than the autopilot's ${est.paybackMonths}-month limit. A lower rate (it confirms slower) pays back sooner.`;
    }
  } else if (est.yieldPpmYear === 0) {
    // Measured (enough forwards behind it) — and nothing earned.
    payback = `month-old channels here earned nothing in 30 days — at that, the open and a later close (~${sats(open + close)} sat) never pay back`;
    warn ??= "The channel autopilot wouldn't open this: at what channels earn here it never pays back.";
  } else {
    payback = unmeasured(est);
  }
  if (!warn && rate > est.autopilotMaxFeeRate) {
    warn = `${rate} sat/vB is above the ${est.autopilotMaxFeeRate} sat/vB the channel autopilot would pay — fine for an urgent open, costly otherwise.`;
  }
  return { cost, fee: est.initialRoutingFee ? startingFeeText(est.initialRoutingFee) : null, left, payback, warn };
}
