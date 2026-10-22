import {
  createInvoice,
  decodePaymentRequest,
  getFeeRates,
  getRouteToDestination,
  getWalletInfo,
  payViaPaymentDetails,
  type AuthenticatedLnd,
} from "lightning";
import { getChannelsView, type ChannelView } from "./channels.js";
import { getOwnPubkey } from "./node.js";

/**
 * Rebalancing: circular payments that move our own liquidity from an idle
 * channel (the source) into a drained one (the target). The golden rule: a
 * refill is only worth paying for when what the refilled liquidity earns
 * covers its route cost with a margin — the profit gate in
 * rebalanceRecommend.ts. This file probes route costs and executes a refill
 * under a fee cap no looser than that gate (feeCapAt).
 *
 * (The first engine — a target ≤ local / source ≥ local / fixed amount picker
 * behind GET /rebalance/candidates — is gone: nothing called it, and its
 * three settings on the Autopilot tab never reached the autopilot.)
 */
export interface RebalancePolicy {
  /** The most a refill's route may cost, as a share of what the refilled
   *  liquidity is expected to earn (0.05–1) — the gate's cost cap. */
  econRatio: number;
  /** A refill must be expected to net at least this much (sat). */
  minNetProfitSats: number;
  /** A refill's fee must be earned back within this many days of the
   *  target's routing revenue. */
  maxPaybackDays: number;
  /** The most one refill moves (sat). */
  maxAmountSats: number;
}

export const DEFAULT_REBALANCE_POLICY: RebalancePolicy = {
  econRatio: 0.8,
  minNetProfitSats: 100,
  maxPaybackDays: 21,
  maxAmountSats: 2_000_000,
};

/**
 * Fast cost estimate from the graph (no payment, no probe HTLCs). Optimistic —
 * the real cost and whether liquidity is actually there is only known when you
 * run the rebalance.
 */
export async function estimateCost(
  lnd: AuthenticatedLnd,
  ownKey: string,
  source: ChannelView,
  target: ChannelView,
  amountSats: number,
  maxPpm: number,
): Promise<{ costPpm: number | null; feeSats: number | null }> {
  try {
    const maxFee = Math.ceil((amountSats * maxPpm) / 1_000_000);
    const { route } = await getRouteToDestination({
      lnd,
      destination: ownKey,
      tokens: amountSats,
      outgoing_channel: source.id,
      incoming_peer: target.peerPubkey,
      max_fee: maxFee,
    });
    if (!route) return { costPpm: null, feeSats: null };
    const feeSats = route.safe_fee;
    return { costPpm: Math.round((feeSats / amountSats) * 1_000_000), feeSats };
  } catch {
    return { costPpm: null, feeSats: null };
  }
}

/** The smallest refill worth trying (the recommender's minRebalanceAmount). */
export const MIN_REFILL_SATS = 50_000;

/** A size fitted to the gate (largestFittingRefill) is rounded down to this. */
export const REFILL_FIT_STEP_SATS = 10_000;

/**
 * Amounts to attempt, largest first, down to a floor — for adaptive
 * rebalancing: the planned size; then, when given, `fit` — the largest size
 * the gate allows at the route cost probed for the planned one
 * (largestFittingRefill) — and the planned size's half and quarter.
 */
export function adaptiveAmounts(target: number, fit: number | null = null): number[] {
  const raw = [target, ...(fit !== null && fit < target ? [fit] : []), Math.round(target / 2), Math.round(target / 4)];
  return [...new Set(raw.filter((a) => a >= MIN_REFILL_SATS))].sort((a, b) => b - a);
}

/** A refill at least this big may be split over several paths (MPP): one
 *  path rarely has the liquidity for it, and a payment that can't be split
 *  fails where its parts would route (review a2: 6 of 14 attempts timed out
 *  — ln-service sends single-path unless told otherwise). */
export const MULTI_PATH_MIN_SATS = 500_000;
export const MULTI_PATH_MAX_PATHS = 3;

/**
 * What one refill may pay in routing fees — the profit gate's limits, as a
 * payment's max_fee (review a2: the payment was capped at amount × the
 * gate's ppm alone, looser than the gate itself; a 750k refill earning 200
 * sat could pay 240 and lose 40 "within budget").
 */
export interface RefillFeeCap {
  /** The most the route may cost per sat moved (ppm). */
  maxCostPpm: number;
  /** The most the refill may cost at all (sat): the payback limit, the
   *  daily budget left. */
  maxFeeSats?: number | null;
  /** The gate's earnings side: an attempt of A sat earns min(A, demandSats)
   *  × revenuePpm and must keep at least minNetSats of it. */
  earnings?: { revenuePpm: number; demandSats: number; minNetSats: number } | null;
}

/** The max fee (sat) a refill of `amountSats` may pay and still pass the
 *  gate; below 1, the attempt is not worth sending. */
export function feeCapAt(cap: RefillFeeCap, amountSats: number): number {
  let sats = Math.floor((amountSats * cap.maxCostPpm) / 1_000_000);
  if (cap.maxFeeSats != null) sats = Math.min(sats, Math.floor(cap.maxFeeSats));
  if (cap.earnings) {
    const e = cap.earnings;
    const earned = (Math.min(amountSats, Math.max(0, e.demandSats)) * e.revenuePpm) / 1_000_000;
    sats = Math.min(sats, Math.floor(earned - e.minNetSats));
  }
  return Math.max(0, sats);
}

/**
 * The largest refill below `planned` whose fee at `costPpm` — the route cost
 * probed for the planned size — stays within the gate's cap at its own size
 * (feeCapAt), rounded down to REFILL_FIT_STEP_SATS and at least `minSats`.
 * Null: no such size. The fee is reckoned high (rounded up): the planner
 * probes the route at that size and judges it as any other, and a payment
 * of that size is capped by feeCapAt whatever the route costs — every gate
 * stays as it is.
 *
 * Review of P7 (a P3 gap): the sizes tried were the planned one, its half and
 * its quarter only. A refill that failed only on the payback limit — 1.25M
 * at ~300 ppm needing 375 sat against a 336 sat limit — fell to 625k, which
 * no longer cleared the minimum net profit, while 1.0M–1.12M would have
 * passed: the drained channel got no refill at all.
 */
export function largestFittingRefill(cap: RefillFeeCap, planned: number, costPpm: number, minSats = MIN_REFILL_SATS): number | null {
  if (!Number.isFinite(costPpm) || costPpm < 0) return null;
  const top = Math.floor((planned - 1) / REFILL_FIT_STEP_SATS) * REFILL_FIT_STEP_SATS;
  for (let a = top; a >= minSats; a -= REFILL_FIT_STEP_SATS) {
    const max = feeCapAt(cap, a);
    if (max >= 1 && Math.ceil((a * costPpm) / 1_000_000) <= max) return a;
  }
  return null;
}

/** The route cost (ppm) a probe found for a refill's planned size: when that
 *  size doesn't fit the gate's cap at that cost, the largest size that does
 *  (largestFittingRefill) — else null (the planned size fits, or nothing
 *  smaller does). */
export function fitBelowPlanned(cap: RefillFeeCap, planned: number, costPpm: number | null | undefined, minSats = MIN_REFILL_SATS): number | null {
  if (costPpm == null) return null;
  const max = feeCapAt(cap, planned);
  if (max >= 1 && Math.ceil((planned * costPpm) / 1_000_000) <= max) return null;
  return largestFittingRefill(cap, planned, costPpm, minSats);
}

// Pathfinding budget per attempt. Generous because over a dev SSH tunnel each
// route attempt is a slow round-trip; on Umbrel (direct) it resolves far quicker.
const PATHFINDING_TIMEOUT_MS = 45_000;

/**
 * Hard wall-clock limit for one rebalance, all sources and amounts together.
 * LND's pathfinding timeout only stops NEW attempts: a payment with an HTLC
 * stuck at a downstream hop stays in flight until that HTLC resolves — hours
 * or days — and the autopilot run awaiting it stood still all that time.
 * Past this limit we stop WAITING (the payment may still land) and report it
 * as in flight; the autopilot charges its maximum fee to the daily budget
 * and learns the real outcome on a later run (getPayment).
 */
export const REBALANCE_HARD_TIMEOUT_MS = 150_000;

/**
 * How far above the chain tip the route's total CLTV may reach. Without it
 * LND allows 2016 blocks (two weeks of funds locked by a stuck HTLC). A
 * circular route of 3–4 hops needs roughly 250–450 blocks, so a tight limit
 * (+144) would block nearly every route; one week is a safe ceiling.
 */
export const REBALANCE_MAX_TIMEOUT_BLOCKS = 1_008;

const TIMED_OUT = Symbol("timed-out");

/** Resolve with the work's value, or TIMED_OUT once `ms` have passed. The
 *  work keeps running; its eventual rejection is swallowed here (the caller
 *  has stopped listening — an unhandled rejection would end the process). */
function waitAtMost<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// ── Executing a rebalance (writes) ────────────────────────────────────────────

/** A channel to pull from, and the share of its balance to leave on our side. */
export interface RebalanceSource {
  id: string;
  /** Never take it below this local ratio (its own target + a margin): a
   *  move is capped at the source's spare balance, not sized by the target
   *  alone (review a2). Absent: anything it has. */
  keepRatio?: number;
}

export interface RebalanceExecParams {
  targetId: string;
  /** The source to pull from (the first of `sources` when that is given). */
  sourceId: string;
  /** The sources to try, in order: the next one only when no route paid
   *  from the ones before (review a2: one source per target, no fallback).
   *  Absent: `sourceId` alone. */
  sources?: RebalanceSource[];
  amountSats: number;
  /** Fallback cost cap: the target's fee × econRatio (ppm). */
  econRatio: number;
  /** The cost cap per sat moved (ppm). A manual run may set its own. */
  maxFeePpm?: number;
  /** The most the whole refill may pay in fees (sat): the payback limit,
   *  the daily budget left, what the confirm dialog promised. */
  maxFeeSats?: number;
  /** The profit gate's earnings side (feeCapAt): an attempt of A sat pays
   *  at most what it is expected to earn minus the minimum net profit — at
   *  the halved fallback sizes too. Absent for a manual run without it. */
  gate?: { revenuePpm: number; demandSats: number; minNetSats: number };
  /** The route cost (ppm) the plan probed for `amountSats`. When the
   *  planned size doesn't fit the cap at that cost (a daily budget left
   *  smaller than at planning, say), the largest size that does is tried
   *  before the halves (fitBelowPlanned). */
  routeCostPpm?: number;
}

export interface RebalanceExecResult {
  ok: boolean;
  targetId: string;
  targetAlias: string;
  /** The source that paid — or, when none did, the first one. */
  sourceId: string;
  sourceAlias: string;
  amountSats: number;
  budgetPpm: number;
  feeSats: number | null;
  costPpm: number | null;
  error?: string;
  /** The payment that paid (its hash) — the attempt onSend announced. */
  paymentId?: string;
  /** We stopped waiting while the payment was still in flight — at the hard
   *  limit (REBALANCE_HARD_TIMEOUT_MS), or because the wait for it broke off
   *  without LND saying how it ended: it may still succeed. Its hash lets a
   *  later run learn the outcome; until then its maximum fee counts as spent. */
  inFlight?: { paymentId: string; maxFeeSats: number };
  /** The target's lifetime "sent" counter (LND) before the refill: the fee
   *  engine retires the refilled sats against it (refill lots). */
  targetSentBefore?: number;
  /** The target's outbound fee (ppm) as LND reported it for this refill —
   *  what its sats are really sold at now. The books never hold the fee
   *  above it (refillBooks: a gate from a stale plan may value the refill
   *  above a fee that has dropped since). Absent: LND didn't list it. */
  targetPpm?: number;
  /** Sources that were tried and paid nothing (no route within the cap) —
   *  each pair backs off on its own. */
  failedSourceIds?: string[];
  /** The refill stopped before its next attempt (opts.shouldStop): the
   *  process is shutting down, or the operator switched auto-rebalance off
   *  (or paused all automation) while it ran — a skip, not a failure: nothing
   *  more was sent. A source whose attempts failed before it is in
   *  failedSourceIds; the error says why it stopped. */
  stopped?: boolean;
}

/** One payment attempt of a refill, as it is about to be sent. */
export interface RefillAttempt {
  /** The payment's hash — LND's id for it (getPayment). */
  paymentId: string;
  sourceId: string;
  /** The source's peer alias (for the books, and to name a payment still in
   *  flight out of it). */
  sourceAlias?: string;
  /** The target's peer alias (for the books). */
  targetAlias: string;
  amountSats: number;
  /** The most it may pay in routing fees (its fee limit, sat). */
  maxFeeSats: number;
  /** The target's lifetime "sent" counter before the refill. */
  targetSentBefore?: number;
  /** The target's outbound fee (ppm) as read for this refill (absent: LND
   *  didn't list it) — the write-ahead record books no hold above it. */
  targetPpm?: number;
}

/**
 * How an attempt that was sent ended, as far as this process knows: paid;
 * failed (LND says so — nothing was paid); or still in flight — the hard limit
 * passed, or the wait for it broke off (the stream to LND dropped) without LND
 * saying how it ended. One still in flight may land later.
 */
export type RefillAttemptEnd = "paid" | "failed" | "in_flight";

/**
 * The caller's books, kept attempt by attempt (write-ahead, the rule the Magma
 * journal follows): a payment that may move money is recorded BEFORE it is
 * sent, so a restart or a crash while it is under way — a shutdown waits 37 s
 * (shutdown.ts), a payment up to REBALANCE_HARD_TIMEOUT_MS — can't lose it.
 */
export interface RefillHooks {
  /** Right before an attempt is sent. It must record the attempt durably; if
   *  it throws, the attempt is not sent and the refill stops there. */
  onSend?(attempt: RefillAttempt): void;
  /** Once per attempt that was sent, when this process stops waiting on it. */
  onEnd?(paymentId: string, outcome: RefillAttemptEnd): void;
}

export interface RebalanceExecOptions extends RefillHooks {
  /** Wall-clock limit for the whole rebalance (default REBALANCE_HARD_TIMEOUT_MS). */
  hardTimeoutMs?: number;
  /** Asked right before each attempt is sent: true (the process is shutting
   *  down) — or a reason, in words ("auto-rebalance was switched off during
   *  the run") — stops the refill there: no smaller size, no other source.
   *  One refill may try up to 3 sources × 3 sizes, and the caller can only
   *  check between refills: without this, an update's shutdown window saw new
   *  payments start (review of P3), and so did a pause clicked while a refill
   *  ran (review of P7). */
  shouldStop?: () => boolean | string;
}

/**
 * The ways LND says a payment FAILED — it ended, nothing was paid (ln-service
 * finished_payment.js) — and the library's own refusals before anything is
 * sent (400). Any other error — the stream to LND broke (LND restarted, the
 * connection dropped), LND answered something unexpected — leaves the
 * payment's outcome unknown: it may still be in flight, so no other amount or
 * source may be tried for this refill now (it could move twice what was
 * planned).
 */
const PAYMENT_FAILED = new Set([
  "PaymentExecutionCanceled",
  "InsufficientBalanceToAttemptPayment",
  "PaymentRejectedByDestination",
  "PaymentAttemptsTimedOut",
  "PaymentPathfindingFailedToFindPossibleRoute",
  "FailedToFindPayableRouteToDestination",
]);
function paymentFailed(err: unknown): boolean {
  return Array.isArray(err) && (err[0] === 400 || PAYMENT_FAILED.has(String(err[1])));
}

/** ln-service throws errors as [code, name, { ... }] arrays — surface the cause. */
function describePayError(err: unknown, budgetPpm: number): string {
  if (Array.isArray(err)) {
    const name = String(err[1] ?? err[0] ?? "payment_failed");
    if (/Route|Payable|Possible|Pathfinding/i.test(name)) {
      return `no route within budget (${budgetPpm} ppm) — target may be too costly to refill`;
    }
    const extra = err[2] as { err?: { details?: string; message?: string } } | undefined;
    const detail = extra?.err?.details ?? extra?.err?.message ?? "";
    return detail ? `${name}: ${detail}` : name;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute one circular rebalance: pay a self-invoice out via a source channel
 * and back in via the target's peer. Every attempt's max_fee is the profit
 * gate's own limit at that size (feeCapAt), so a refill can never pay more
 * than it is worth — and never more than `maxFeeSats` (the daily budget left)
 * — at any of the fallback sizes. If no route fits, nothing is paid. Each
 * attempt goes through the caller's books (opts.onSend / onEnd) before it is
 * sent and when it ends, and none starts once opts.shouldStop says to stop
 * (the process is shutting down, or rebalancing was switched off).
 */
export async function executeRebalance(
  readLnd: AuthenticatedLnd,
  writeLnd: AuthenticatedLnd,
  params: RebalanceExecParams,
  opts: RebalanceExecOptions = {},
): Promise<RebalanceExecResult> {
  const deadline = Date.now() + (opts.hardTimeoutMs ?? REBALANCE_HARD_TIMEOUT_MS);
  const channels = await getChannelsView(readLnd);
  const target = channels.find((c) => c.id === params.targetId);
  const sources: RebalanceSource[] = (params.sources?.length ? params.sources : [{ id: params.sourceId }]).filter(
    (s, i, all) => all.findIndex((x) => x.id === s.id) === i,
  );
  // (A source closed since the plan is skipped; the next one may still pay.)
  const first = sources.map((s) => channels.find((c) => c.id === s.id)).find((c) => c !== undefined);

  const base = {
    ok: false,
    targetId: params.targetId,
    targetAlias: target?.peerAlias ?? params.targetId,
    sourceId: first?.id ?? sources[0]?.id ?? params.sourceId,
    sourceAlias: first?.peerAlias ?? sources[0]?.id ?? params.sourceId,
    amountSats: params.amountSats,
    budgetPpm: 0,
    feeSats: null,
    costPpm: null,
  };

  if (!target || !first) {
    return { ...base, error: "unknown source or target channel" };
  }
  if (sources.some((s) => s.id === target.id)) {
    return { ...base, error: "source and target must differ" };
  }

  const rates = await getFeeRates({ lnd: readLnd });
  const targetPpm = rates.channels.find((c) => c.id === params.targetId)?.fee_rate;
  const outboundPpm = targetPpm ?? 0;
  // Manual runs may pass an explicit budget; otherwise it's the profit-gated
  // fraction of what the target earns on outbound.
  const budgetPpm =
    params.maxFeePpm && params.maxFeePpm > 0
      ? Math.floor(params.maxFeePpm)
      : Math.floor(outboundPpm * params.econRatio);
  if (budgetPpm <= 0) {
    return { ...base, error: "target earns 0 ppm — set an outbound fee or a max fee (ppm)" };
  }
  const cap: RefillFeeCap = { maxCostPpm: budgetPpm, maxFeeSats: params.maxFeeSats ?? null, earnings: params.gate ?? null };

  const ownKey = await getOwnPubkey(readLnd);
  // The CLTV ceiling is relative to the tip; without a height, LND's default applies.
  const tip = await getWalletInfo({ lnd: readLnd })
    .then((w) => w.current_block_height)
    .catch(() => null);

  const withTarget = { ...base, budgetPpm, targetSentBefore: target.totalSent, ...(targetPpm !== undefined ? { targetPpm } : {}) };
  const failedSourceIds: string[] = [];
  let lastErr: unknown = null;
  let tried = false;
  // Source by source; per source the requested amount, then smaller ones,
  // paying the first that routes. A route that pays from no size of one
  // source sends the next source's attempts — within one deadline.
  for (const spec of sources) {
    const source = channels.find((c) => c.id === spec.id);
    if (!source) {
      failedSourceIds.push(spec.id);
      lastErr ??= new Error(`source ${spec.id} is not an open channel`);
      continue;
    }
    // Never more than the source can spare above the share it keeps.
    const settled = source.localBalance + source.remoteBalance;
    const spare = source.localBalance - Math.round((spec.keepRatio ?? 0) * settled);
    let triedHere = false;
    // A payment from this source was sent and failed (what a stop reports).
    let sentAndFailedHere = false;
    // Told to stop (shutting down, or switched off): no new payment starts —
    // only the one already under way was awaited. A source one of whose
    // payments failed is reported (it backs off); the sources not tried yet
    // are not.
    const stop = (why: string | true): RebalanceExecResult => {
      if (sentAndFailedHere) failedSourceIds.push(spec.id);
      const reason = why === true ? "shutting down" : why;
      return { ...withTarget, failedSourceIds, stopped: true, error: `skipped: ${reason} — no further attempt was sent` };
    };
    // The planned size (what this source can spare of it), the largest
    // size the cap allows at the plan's route cost when the planned one
    // doesn't, then the halves.
    const planned = Math.min(params.amountSats, spare);
    for (const amount of adaptiveAmounts(planned, fitBelowPlanned(cap, planned, params.routeCostPpm))) {
      const left = deadline - Date.now();
      if (left <= 0) {
        lastErr ??= new Error("rebalance time limit reached");
        break;
      }
      const maxFeeSats = feeCapAt(cap, amount);
      if (maxFeeSats < 1) {
        // The gate leaves no fee at this size (or the budget is spent).
        lastErr ??= new Error(`no fee room at ${Math.round(amount / 1000)}k: the profit check or the daily budget leaves less than 1 sat`);
        continue;
      }
      const halt = opts.shouldStop?.();
      if (halt) return stop(halt);
      triedHere = true;
      tried = true;
      let sent: string | null = null;
      const attemptedHere = { ...withTarget, sourceId: source.id, sourceAlias: source.peerAlias, amountSats: amount, failedSourceIds };
      try {
        const invoice = await createInvoice({ lnd: writeLnd, tokens: amount });
        const decoded = await decodePaymentRequest({ lnd: readLnd, request: invoice.request });
        // Asked again right before it goes out: the signal may have come
        // while the invoice was made (it stays unpaid and expires).
        const late = opts.shouldStop?.();
        if (late) return stop(late);
        // On the caller's books before it is sent (write-ahead). If it can't
        // be recorded, it is not sent — nor is anything else of this refill.
        try {
          opts.onSend?.({
            paymentId: invoice.id,
            sourceId: source.id,
            sourceAlias: source.peerAlias,
            targetAlias: withTarget.targetAlias,
            amountSats: amount,
            maxFeeSats,
            targetSentBefore: target.totalSent,
            ...(targetPpm !== undefined ? { targetPpm } : {}),
          });
        } catch (err) {
          return {
            ...attemptedHere,
            error: `not sent: the payment couldn't be recorded before sending it (${err instanceof Error ? err.message : String(err)}) — nothing was paid`,
          };
        }
        sent = invoice.id;
        const paying = payViaPaymentDetails({
          lnd: writeLnd,
          id: invoice.id,
          destination: ownKey,
          tokens: amount,
          max_fee: maxFeeSats,
          outgoing_channel: source.id,
          incoming_peer: target.peerPubkey,
          payment: decoded.payment,
          mtokens: decoded.mtokens,
          // A big refill may split; the cap is for the whole payment. LND
          // splits only for a destination that declares multi-path payments:
          // without the invoice's features it has none to go by (DestFeatures
          // nil — "not splitting") and max_paths changes nothing.
          features: decoded.features,
          max_paths: amount >= MULTI_PATH_MIN_SATS ? MULTI_PATH_MAX_PATHS : 1,
          pathfinding_timeout: Math.min(PATHFINDING_TIMEOUT_MS, left),
          ...(tip ? { max_timeout_height: tip + REBALANCE_MAX_TIMEOUT_BLOCKS } : {}),
        });
        const paid = await waitAtMost(paying, left);
        if (paid === TIMED_OUT) {
          // Never try another amount or source now: this one may still go through.
          opts.onEnd?.(invoice.id, "in_flight");
          return {
            ...attemptedHere,
            inFlight: { paymentId: invoice.id, maxFeeSats },
            error: `payment still in flight after ${Math.round((opts.hardTimeoutMs ?? REBALANCE_HARD_TIMEOUT_MS) / 1000)}s — it may still land; LightningMate keeps checking and logs how it ends`,
          };
        }
        opts.onEnd?.(invoice.id, "paid");
        const feeSats = paid.safe_fee ?? paid.fee;
        return {
          ...attemptedHere,
          ok: true,
          feeSats,
          costPpm: Math.round((feeSats / amount) * 1_000_000),
          paymentId: invoice.id,
        };
      } catch (err) {
        lastErr = err;
        if (sent !== null && !paymentFailed(err)) {
          // The wait broke off and LND hasn't said how the payment ended: it
          // may still land. Not a failure — and no smaller amount or other
          // source now (that could move twice what was planned).
          opts.onEnd?.(sent, "in_flight");
          return {
            ...attemptedHere,
            inFlight: { paymentId: sent, maxFeeSats },
            error: `LND hasn't said how the payment ended (${describePayError(err, budgetPpm)}) — it may still land; LightningMate keeps checking and logs how it ends`,
          };
        }
        if (sent !== null) {
          opts.onEnd?.(sent, "failed");
          sentAndFailedHere = true;
        }
      }
    }
    if (triedHere) failedSourceIds.push(spec.id);
    else if (spare < MIN_REFILL_SATS) lastErr ??= new Error(`source ${source.peerAlias || source.id} has too little spare balance`);
    if (Date.now() >= deadline) break;
  }
  return {
    ...withTarget,
    failedSourceIds,
    error: tried ? describePayError(lastErr, budgetPpm) : lastErr instanceof Error ? lastErr.message : "nothing to try",
  };
}
