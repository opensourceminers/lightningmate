import {
  createInvoice,
  decodePaymentRequest,
  getFeeRates,
  getRouteToDestination,
  payViaPaymentDetails,
  type AuthenticatedLnd,
} from "lightning";
import { getChannelsView, type ChannelView } from "./channels.js";
import { getFlowSummary } from "./forwards.js";
import { getOwnPubkey } from "./node.js";

/**
 * Rebalancing economics. The golden rule: a rebalance is only worth doing when
 * the route cost (ppm) is below the fee (ppm) you'll earn deploying that
 * liquidity again. So per target channel:
 *
 *   budget_ppm = target_outbound_fee_ppm × econRatio   (econRatio < 1 = margin)
 *
 * We only consider depleted targets that have *proven outbound demand* (they've
 * actually routed out recently), and pull from the fullest source channels.
 */
export interface RebalancePolicy {
  econRatio: number;
  maxLocalRatioTarget: number;
  minLocalRatioSource: number;
  amountSats: number;
  minDemandSats: number;
  flowWindowDays: number;
  maxCandidates: number;
}

export const DEFAULT_REBALANCE_POLICY: RebalancePolicy = {
  econRatio: 0.8,
  maxLocalRatioTarget: 0.35,
  minLocalRatioSource: 0.65,
  amountSats: 1_000_000,
  minDemandSats: 1,
  flowWindowDays: 30,
  maxCandidates: 8,
};

// Search routes up to this cost so we can report an honest number even when a
// candidate turns out to be unprofitable.
const PROBE_CEILING_PPM = 3000;

export interface RebalanceCandidate {
  targetId: string;
  targetAlias: string;
  targetLocalRatio: number;
  targetOutboundPpm: number;
  /** Sats this channel routed OUT over the window — why it's worth refilling. */
  demandSats: number;
  sourceId: string;
  sourceAlias: string;
  sourceLocalRatio: number;
  amountSats: number;
  /** Profit budget: most we should pay to rebalance, in ppm. */
  maxFeePpm: number;
  /** Cheapest route cost found (ppm), or null if none. */
  estCostPpm: number | null;
  estFeeSats: number | null;
  routeFound: boolean;
  profitable: boolean;
  verdict: string;
}

export interface RebalanceAnalysis {
  policy: RebalancePolicy;
  candidates: RebalanceCandidate[];
}

/**
 * Fast cost estimate from the graph (no payment, no probe HTLCs). Optimistic —
 * the real cost and whether liquidity is actually there is only known when you
 * run the rebalance. Shown as guidance; the user decides (Thunderhub-style).
 */
async function estimateCost(
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

/** Amounts to attempt, largest first, down to a floor — for adaptive rebalancing. */
function adaptiveAmounts(target: number): number[] {
  const floor = 50_000;
  const raw = [target, Math.round(target / 2), Math.round(target / 4)];
  return [...new Set(raw.filter((a) => a >= floor))];
}

// Pathfinding budget per attempt. Generous because over a dev SSH tunnel each
// route attempt is a slow round-trip; on Umbrel (direct) it resolves far quicker.
const PATHFINDING_TIMEOUT_MS = 45_000;

function verdictFor(maxFeePpm: number, costPpm: number | null, profitable: boolean): string {
  if (costPpm === null) return "no cheap route — try a smaller amount or run it manually";
  if (maxFeePpm <= 0) return `est. ${costPpm} ppm — target earns 0 ppm (set a fee or your call)`;
  if (profitable) return `profitable: est. ${costPpm} ≤ budget ${maxFeePpm} ppm`;
  return `est. ${costPpm} ppm > budget ${maxFeePpm} ppm — your call`;
}

export async function getRebalanceCandidates(
  lnd: AuthenticatedLnd,
  overrides: Partial<RebalancePolicy> = {},
): Promise<RebalanceAnalysis> {
  const policy = { ...DEFAULT_REBALANCE_POLICY, ...overrides };

  const [channels, rates, flows, ownKey] = await Promise.all([
    getChannelsView(lnd),
    getFeeRates({ lnd }),
    getFlowSummary(lnd, policy.flowWindowDays),
    getOwnPubkey(lnd),
  ]);

  const ppmById = new Map(rates.channels.map((c) => [c.id, c.fee_rate]));
  const demandById = new Map(flows.perChannel.map((f) => [f.channelId, f.routedOut]));

  const active = channels.filter((c) => c.active);

  // Sources: full channels we can pull liquidity from, fullest first.
  const sources = active
    .filter((c) => c.localRatio >= policy.minLocalRatioSource)
    .sort((a, b) => b.localRatio - a.localRatio);
  if (sources.length === 0) return { policy, candidates: [] };

  // Targets: depleted channels with proven outbound demand, neediest first.
  const targets = active
    .filter(
      (c) =>
        c.localRatio <= policy.maxLocalRatioTarget &&
        (demandById.get(c.id) ?? 0) >= policy.minDemandSats,
    )
    .sort((a, b) => (demandById.get(b.id) ?? 0) - (demandById.get(a.id) ?? 0))
    .slice(0, policy.maxCandidates);

  // Pair each target with the fullest available source, then probe them all in
  // parallel — real probes are slow, so don't serialise.
  const pairs = targets
    .map((target) => ({ target, source: sources.find((s) => s.id !== target.id) }))
    .filter((p): p is { target: ChannelView; source: ChannelView } => !!p.source);

  const candidates: RebalanceCandidate[] = await Promise.all(
    pairs.map(async ({ target, source }) => {
      const outboundPpm = ppmById.get(target.id) ?? 0;
      const maxFeePpm = Math.floor(outboundPpm * policy.econRatio);
      const probe = await estimateCost(lnd, ownKey, source, target, policy.amountSats, PROBE_CEILING_PPM);
      const profitable = probe.costPpm !== null && maxFeePpm > 0 && probe.costPpm <= maxFeePpm;
      return {
        targetId: target.id,
        targetAlias: target.peerAlias,
        targetLocalRatio: target.localRatio,
        targetOutboundPpm: outboundPpm,
        demandSats: demandById.get(target.id) ?? 0,
        sourceId: source.id,
        sourceAlias: source.peerAlias,
        sourceLocalRatio: source.localRatio,
        amountSats: policy.amountSats,
        maxFeePpm,
        estCostPpm: probe.costPpm,
        estFeeSats: probe.feeSats,
        routeFound: probe.costPpm !== null,
        profitable,
        verdict: verdictFor(maxFeePpm, probe.costPpm, profitable),
      };
    }),
  );

  // Profitable first, then by demand.
  candidates.sort(
    (a, b) => Number(b.profitable) - Number(a.profitable) || b.demandSats - a.demandSats,
  );
  return { policy, candidates };
}

// ── Executing a rebalance (writes) ────────────────────────────────────────────

export interface RebalanceExecParams {
  targetId: string;
  sourceId: string;
  amountSats: number;
  /** Safety margin; budget = target outbound fee ppm × econRatio. */
  econRatio: number;
  /** Manual override: explicit fee budget (ppm). Bypasses the profit gate. */
  maxFeePpm?: number;
}

export interface RebalanceExecResult {
  ok: boolean;
  targetId: string;
  targetAlias: string;
  sourceId: string;
  sourceAlias: string;
  amountSats: number;
  budgetPpm: number;
  feeSats: number | null;
  costPpm: number | null;
  error?: string;
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
 * Execute one circular rebalance: pay a self-invoice out via the source channel
 * and back in via the target's peer. The profit budget is computed server-side
 * from the target's own outbound fee and enforced as the route's max_fee, so the
 * payment can NEVER exceed what the rebalance is worth — if no route fits the
 * budget, nothing is paid.
 */
export async function executeRebalance(
  readLnd: AuthenticatedLnd,
  writeLnd: AuthenticatedLnd,
  params: RebalanceExecParams,
): Promise<RebalanceExecResult> {
  const channels = await getChannelsView(readLnd);
  const target = channels.find((c) => c.id === params.targetId);
  const source = channels.find((c) => c.id === params.sourceId);

  const base = {
    ok: false,
    targetId: params.targetId,
    targetAlias: target?.peerAlias ?? params.targetId,
    sourceId: params.sourceId,
    sourceAlias: source?.peerAlias ?? params.sourceId,
    amountSats: params.amountSats,
    budgetPpm: 0,
    feeSats: null,
    costPpm: null,
  };

  if (!target || !source) {
    return { ...base, error: "unknown source or target channel" };
  }
  if (source.id === target.id) {
    return { ...base, error: "source and target must differ" };
  }

  const rates = await getFeeRates({ lnd: readLnd });
  const outboundPpm = rates.channels.find((c) => c.id === params.targetId)?.fee_rate ?? 0;
  // Manual runs may pass an explicit budget; otherwise it's the profit-gated
  // fraction of what the target earns on outbound.
  const budgetPpm =
    params.maxFeePpm && params.maxFeePpm > 0
      ? Math.floor(params.maxFeePpm)
      : Math.floor(outboundPpm * params.econRatio);
  if (budgetPpm <= 0) {
    return { ...base, error: "target earns 0 ppm — set an outbound fee or a max fee (ppm)" };
  }

  const ownKey = await getOwnPubkey(readLnd);

  // Adaptive: try the requested amount, then progressively smaller, paying the
  // first that actually routes. LND's multi-path payment retries across many
  // routes (skipping hops that fail), constrained to leave via the source and
  // return via the target's peer, never exceeding the per-amount fee budget.
  let lastErr: unknown = null;
  for (const amount of adaptiveAmounts(params.amountSats)) {
    const maxFeeSats = Math.max(1, Math.floor((amount * budgetPpm) / 1_000_000));
    try {
      const invoice = await createInvoice({ lnd: writeLnd, tokens: amount });
      const decoded = await decodePaymentRequest({ lnd: readLnd, request: invoice.request });
      const paid = await payViaPaymentDetails({
        lnd: writeLnd,
        id: invoice.id,
        destination: ownKey,
        tokens: amount,
        max_fee: maxFeeSats,
        outgoing_channel: source.id,
        incoming_peer: target.peerPubkey,
        payment: decoded.payment,
        mtokens: decoded.mtokens,
        pathfinding_timeout: PATHFINDING_TIMEOUT_MS,
      });
      const feeSats = paid.safe_fee ?? paid.fee;
      return {
        ...base,
        ok: true,
        amountSats: amount,
        budgetPpm,
        feeSats,
        costPpm: Math.round((feeSats / amount) * 1_000_000),
      };
    } catch (err) {
      lastErr = err;
    }
  }
  return { ...base, budgetPpm, error: describePayError(lastErr, budgetPpm) };
}
