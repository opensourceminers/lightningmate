import type {
  RebalanceBudget,
  RebalanceExecRequest,
  RebalanceExecResult,
  RebalancePolicy,
  RebalanceRecommendation,
  RefillInFlight,
} from "./types";
import { sats, satsCompact, timeAgo } from "./format";

/**
 * The words and small decisions behind the Rebalancing views, apart from the
 * components so they can be tested (review a2, package P3).
 */

/**
 * The rebalance settings on Autopilot → Rebalancing — every one of them binds
 * the profit gate. ("Amount", "Target ≤ local" and "Source ≥ local" were
 * shown here and reached nothing: the autopilot read only econRatio.)
 */
export const REBALANCE_POLICY_FIELDS: { key: keyof RebalancePolicy; label: string; step: number; hint: string }[] = [
  {
    key: "econRatio",
    label: "Max share of expected earnings spent on a refill (0.05–1)",
    step: 0.05,
    hint: "A refill's route may cost at most this share of what the refilled sats are expected to earn — 0.8 keeps 20 % as margin.",
  },
  {
    key: "minNetProfitSats",
    label: "Min net profit per refill (sat)",
    step: 10,
    hint: "A refill must be expected to earn at least this much more than its route costs.",
  },
  {
    key: "maxPaybackDays",
    label: "Max payback (days)",
    step: 1,
    hint: "A refill's fee must be earned back within this many days of the channel's routing revenue.",
  },
  {
    key: "maxAmountSats",
    label: "Max refill per move (sat)",
    step: 10_000,
    hint:
      "The most one refill moves. A move is also never more than 1.5× the channel's net drain (what it is expected to sell), a quarter " +
      "of the channel, what the source can spare above its own share — and, valued at a price it proved, 10× what sold at that price.",
  },
];

/** What the removed settings did — for the hint under the fields. */
export const REMOVED_SETTINGS_NOTE =
  "“Amount”, “Target ≤ local” and “Source ≥ local” are gone: they never reached the autopilot. A refill is sized by the channel's demand, its capacity and what the source can spare.";

/** Today's budget, as one line. */
export function budgetLine(b: RebalanceBudget | null | undefined): string | null {
  if (!b) return null;
  const resets = new Date(b.resetsAt).toISOString().slice(11, 16);
  const inFlight = b.inFlightSats ? ` (${sats(b.inFlightSats)} of it in payments still in flight, at their maximum fee)` : "";
  return b.budgetSats === null
    ? `Today: ${sats(b.spentSats)} sat spent on rebalancing${inFlight} — no daily limit. Manual runs count too.`
    : `Today: ${sats(b.spentSats)} of ${sats(b.budgetSats)} sat spent on rebalancing${inFlight} — ${sats(b.leftSats ?? 0)} left, resets ${resets} UTC. Manual runs count too.`;
}

/** A profitable move that today's budget can't pay for now (it waits for the reset). */
export function budgetBlocked(r: Pick<RebalanceRecommendation, "wouldRebalance" | "estimatedRouteFeeSats">, b: RebalanceBudget | null | undefined): boolean {
  return !!b && b.leftSats !== null && r.wouldRebalance && b.leftSats < (r.estimatedRouteFeeSats ?? 0);
}

/**
 * What "Run it" sends for a recommended row — the refill the confirm dialog
 * describes: the row's move, its caps (the most per sat moved, and the most
 * the refill pays at all — what the dialog promises), and the profit gate's
 * earnings side, so every smaller size the payment falls back to is checked
 * the same way. With the gate, the server books the refill's value as its
 * hold, like an autopilot refill's: the fee is kept until the refilled sats
 * have routed out (what the tab says). The plan's time goes with it: the
 * server refuses the row once its target was refilled (or tried) after the
 * plan was made — the tab loads its plan once, and a stale row paid a
 * second refill into a target the autopilot had just refilled. Null: the
 * row has nothing to run.
 */
export function manualRefillRequest(
  r: Pick<
    RebalanceRecommendation,
    | "channelId"
    | "selectedSourceChannel"
    | "recommendedAmount"
    | "maxCostPpm"
    | "maxFeeSats"
    | "expectedRevenuePpm"
    | "earningDemandSats"
    | "minNetProfitSats"
    | "estimatedRouteCostPpm"
  >,
  /** The operator's econRatio (the plan's profitShare): the cost cap's
   *  fallback when the row has no max ppm. */
  econRatio = 0.8,
  /** The plan's generatedAt. */
  planAt?: string,
): RebalanceExecRequest | null {
  if (!r.selectedSourceChannel || !r.recommendedAmount) return null;
  return {
    targetId: r.channelId,
    sourceId: r.selectedSourceChannel,
    amountSats: r.recommendedAmount,
    econRatio,
    ...(r.maxCostPpm != null ? { maxFeePpm: r.maxCostPpm } : {}),
    ...(r.maxFeeSats != null ? { maxFeeSats: r.maxFeeSats } : {}),
    ...(r.expectedRevenuePpm != null
      ? { gate: { revenuePpm: r.expectedRevenuePpm, demandSats: r.earningDemandSats, minNetSats: r.minNetProfitSats } }
      : {}),
    // The plan's route cost at that size: a size the cap no longer allows
    // (today's budget left shrank) falls to the largest one it does first.
    ...(r.estimatedRouteCostPpm != null ? { routeCostPpm: r.estimatedRouteCostPpm } : {}),
    ...(planAt ? { planAt } : {}),
  };
}

/** A refused manual refill the tab answers by loading a fresh plan: the
 *  row's target was refilled (or tried) after the plan was made (409
 *  stale_plan). Null: any other error (shown as it is). */
export function stalePlanRefusal(e: unknown): string | null {
  const err = e as { status?: unknown; body?: unknown; message?: unknown } | null;
  const body = err?.body as { error?: unknown; message?: unknown } | null | undefined;
  if (err?.status !== 409 || body?.error !== "stale_plan") return null;
  const why = typeof body.message === "string" && body.message ? body.message : "This channel was refilled (or tried) after this plan was made";
  return `${why.replace(/: reload it$/, "")} — loading a fresh plan, nothing was sent.`;
}

/**
 * The confirm dialog for a manual refill: what it moves, from where, and the
 * most it pays — the profit gate's cap at that size, never more than what is
 * left of today's budget (it was the channel's 21 days of revenue, shown as
 * if it were the payment's cap) — and that its price is then held, as after
 * an autopilot refill.
 */
export function confirmRefillText(
  r: Pick<RebalanceRecommendation, "recommendedAmount" | "alias" | "maxFeeSats" | "maxCostPpm" | "sourceCandidates" | "expectedRevenuePpm">,
  b: RebalanceBudget | null | undefined,
  /** Fee automation is on: only then does the fee engine hold the price. */
  feeAutomation = true,
): string {
  const amount = r.recommendedAmount ?? 0;
  const cap = r.maxFeeSats ?? Math.ceil((amount * (r.maxCostPpm ?? 0)) / 1_000_000);
  const left = b?.leftSats ?? null;
  const pays = left !== null && left < cap ? left : cap;
  const budget =
    left === null
      ? "There is no daily limit on rebalance fees."
      : `It counts toward today's rebalance budget (${sats(left)} sat left)${left < cap ? ", which caps it" : ""}.`;
  const hold =
    r.expectedRevenuePpm != null && feeAutomation
      ? ` The fee engine then keeps this channel's fee at ≥ ${r.expectedRevenuePpm} ppm — what the refill is valued at — until the refilled sats have routed out ` +
        "(at most 30 days, never above your Max ppm unless you let a refill's cost lift it, and released a week on if they barely move), as after an autopilot refill."
      : "";
  return (
    `Move ${satsCompact(amount)} into ${r.alias} from ${r.sourceCandidates[0]?.alias ?? "a source channel"} ` +
    `(a smaller amount if no route takes that much), paying at most ${sats(pays)} sat in routing fees ` +
    `(${r.maxCostPpm ?? "—"} ppm at most, and no more than the refill is expected to earn above the minimum).${hold} ` +
    `${budget} It starts this channel's rebalance cooldown, but isn't held back by it. This sends a real payment.`
  );
}

/** A payment still in flight through a row's channels — its target or its
 *  source — if any: a refill there is refused until LND says how it ended
 *  (a second move could double what was planned). */
export function inFlightThrough(
  r: Pick<RebalanceRecommendation, "channelId" | "selectedSourceChannel">,
  inFlight: RefillInFlight[] | null | undefined,
): { payment: RefillInFlight; channelId: string } | null {
  const ids = [r.channelId, ...(r.selectedSourceChannel ? [r.selectedSourceChannel] : [])];
  for (const payment of inFlight ?? []) {
    const channelId = ids.find((id) => id === payment.targetId || id === payment.sourceId);
    if (channelId) return { payment, channelId };
  }
  return null;
}

/** What a row shows instead of its Run button while such a payment may
 *  still land. */
export function inFlightLine(hit: { payment: RefillInFlight; channelId: string }): string {
  const p = hit.payment;
  const what = hit.channelId === p.targetId ? `into ${p.alias || p.targetId}` : `out of ${p.sourceAlias || hit.channelId}`;
  return (
    `A payment ${what} (${satsCompact(p.amountSats)}, sent ${timeAgo(p.at)}) is still in flight — ` +
    `no refill through that channel until LightningMate learns how it ended (checked every 2 minutes).`
  );
}

/** What a manual refill's result says (its toast). */
export function refillOutcome(
  res: Pick<RebalanceExecResult, "ok" | "amountSats" | "feeSats" | "error" | "inFlight" | "stopped">,
): { text: string; kind: "success" | "info" | "error" } {
  if (res.ok) return { text: `Rebalanced ${satsCompact(res.amountSats)} for ${res.feeSats} sat`, kind: "success" };
  // Still in flight is not a failure: it may land, and the log will say.
  if (res.inFlight) return { text: `Still in flight: ${res.error}`, kind: "info" };
  // Nor is a refill the shutdown stopped before its next attempt.
  if (res.stopped) return { text: "Stopped: LightningMate is shutting down — no further attempt was sent", kind: "info" };
  return { text: `Failed: ${res.error}`, kind: "error" };
}

/** The post-refill line in a row's detail: held at the estimate from before
 *  the refill — or, where the engine charges less after it (a pin, a lease
 *  promise), that fee, which the moved sats are then valued at. (Compared
 *  with the estimate from BEFORE the refill: the gate's value is already the
 *  lower of the two, so comparing with it never showed the second case.) */
export function afterRefillText(
  r: Pick<RebalanceRecommendation, "postRefillPpm" | "expectedRevenuePpm" | "preRefillPpm">,
  /** Fee automation is on: the hold is the fee engine's — off, nothing holds it. */
  feeAutomation = true,
): string | null {
  if (r.postRefillPpm == null || r.expectedRevenuePpm == null) return null;
  if (r.postRefillPpm < (r.preRefillPpm ?? r.expectedRevenuePpm)) return `after the refill: ~${r.postRefillPpm} ppm (valued at that)`;
  return feeAutomation ? `after the refill: kept at ≥ ${r.expectedRevenuePpm} ppm until the refilled sats have routed out` : null;
}

