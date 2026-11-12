/**
 * Channels and the fee engine's view of them, as one run would build it, for
 * tests of the refill plan (planRebalances) — and a fake LND whose route
 * answers depend on the fee limit of the question, as LND's do.
 */
import { FEE_REC_DEFAULTS, buildRecommendation, type BuildCtx, type FeeRecConfig, type Flow } from "../../src/services/feeRecommend.js";
import { REBAL_REC_DEFAULTS, planRebalances, type RebalanceRecConfig, type RouteProbe } from "../../src/services/rebalanceRecommend.js";
import type { ChannelView } from "../../src/services/channels.js";
import type { SoldLease } from "../../src/services/leaseCaps.js";
import { FakeLnd } from "./fakeLnd.js";

export const PLAN_HEIGHT = 860_000;
export const PLAN_NOW = Date.parse("2026-10-21T12:00:00.000Z");
export const planPeer = (n: number): string => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const engineDefaults: FeeRecConfig = { ...FEE_REC_DEFAULTS, stepPpm: 10, minChangePpm: 25 };
const NO_FLOW: Flow = { out: 0, inn: 0, forwards: 0, revenue: 0 };
export const planFlow = (out: number, inn: number, forwards: number, revenue: number): Flow => ({ out, inn, forwards, revenue });

export interface PlanSpec {
  /** The channel's number: its id is `<block>x<n>x0`. */
  n: number;
  /** The peer's number (default: `n` — one channel per peer). */
  peer?: number;
  /** Block the channel was funded in (default 850,000: ~69 days old). */
  block?: number;
  capacity?: number;
  local: number;
  feePpm?: number;
  f14?: Flow;
  f30?: Flow;
  active?: boolean;
}

export interface PlanNode {
  channels: ChannelView[];
  contexts: Map<string, BuildCtx>;
  fees: ReturnType<typeof buildRecommendation>[];
}

export function planNode(specs: PlanSpec[], engineCfg: FeeRecConfig = engineDefaults): PlanNode {
  const channels: ChannelView[] = specs.map((s) => {
    const capacity = s.capacity ?? 5_000_000;
    return {
      id: `${s.block ?? 850_000}x${s.n}x0`,
      peerPubkey: planPeer(s.peer ?? s.n),
      peerAlias: `peer-${s.peer ?? s.n}`,
      active: s.active ?? true,
      private: false,
      initiator: "local",
      capacity,
      transactionId: TX(s.n),
      transactionVout: 0,
      localBalance: s.local,
      remoteBalance: capacity - s.local,
      localRatio: s.local / capacity,
      totalSent: 0,
      totalReceived: 0,
      unsettled: 0,
      status: "open",
      role: "router",
    };
  });
  const contexts = new Map<string, BuildCtx>(
    specs.map((s, i) => [
      channels[i].id,
      {
        cfg: engineCfg,
        rate: { fee_rate: s.feePpm ?? 100, base_fee_mtokens: "0", transaction_id: TX(s.n), transaction_vout: 0 },
        override: undefined,
        f14: s.f14 ?? NO_FLOW,
        f30: s.f30 ?? planFlow(0, 50_000, 1, 0),
        currentBlock: PLAN_HEIGHT,
        records: [],
        bench: { activeChannelCount: specs.length, topGrossFlow14d: 0, medianGrossFlow14d: 0, topRevenue30d: 0, medianRevenue30d: 0, topRevenuePpm30d: 0, medianRevenuePpm30d: 0 },
        enoughChannels: false,
        earnerCutoff: 0,
        cooldown: null,
        elasticityMod: 1,
        flowAnchor: undefined,
        leaseCap: null,
        demand: undefined,
        market: { intoPeerPpm: 100, samples: 5, peerFeeToUsPpm: 50 },
        nowMs: PLAN_NOW,
      },
    ]),
  );
  const fees = channels.map((c) => buildRecommendation(c, contexts.get(c.id) as BuildCtx));
  return { channels, contexts, fees };
}

/** A drained 5M channel at 15 % local earning 400 ppm (1.2M out in 14 days):
 *  the gate lets its refill cost at most 320 ppm. */
export const drainedSpec = (n: number, o: Partial<PlanSpec> = {}): PlanSpec => ({
  n,
  local: 750_000,
  feePpm: 400,
  f14: planFlow(1_200_000, 200_000, 20, 480),
  f30: planFlow(2_400_000, 400_000, 40, 960),
  ...o,
});

export function planOf(
  node: PlanNode,
  probe: RouteProbe,
  opts: { soldLeases?: SoldLease[]; cfg?: Partial<RebalanceRecConfig>; boughtLeases?: { channelId: string; leaseBlocks: number | null }[] } = {},
) {
  return planRebalances(
    {
      channels: node.channels,
      fees: node.fees,
      contextOf: (id) => node.contexts.get(id),
      cfg: { ...REBAL_REC_DEFAULTS, ...(opts.cfg ?? {}) },
      overrides: {},
      soldLeases: opts.soldLeases ?? [],
      currentBlock: PLAN_HEIGHT,
      boughtLeases: opts.boughtLeases ?? [],
    },
    probe,
  );
}

/** One route question as LND got it. */
export interface RouteQuestion {
  amountSats: number;
  limitSats: number;
  /** The fee limit as ppm of the amount. */
  limitPpm: number;
  /** The price of the route answered (null: no route). */
  answerPpm: number | null;
}

/**
 * LND as it answers a route question: it knows routes at the given prices,
 * the one it prefers first, and returns the first of them whose fee is
 * within the question's fee limit — a cheaper route only when the limit
 * rules the preferred one out.
 */
export function lndPreferring(pricesPpm: number[], asked: RouteQuestion[]): FakeLnd {
  const node = new FakeLnd({ blockHeight: PLAN_HEIGHT });
  node.override("default.queryRoutes", (a: Record<string, unknown>, cb: (e: unknown, r?: unknown) => void) => {
    const amtMsat = BigInt(String(a.amt_msat));
    const limitMsat = BigInt(String((a.fee_limit as { fixed_msat: string }).fixed_msat));
    const feeAt = (ppm: number) => (amtMsat * BigInt(ppm)) / 1_000_000n;
    const pick = pricesPpm.find((ppm) => feeAt(ppm) <= limitMsat) ?? null;
    asked.push({
      amountSats: Number(amtMsat / 1000n),
      limitSats: Number(limitMsat / 1000n),
      limitPpm: Math.round(Number((limitMsat * 1_000_000n) / amtMsat)),
      answerPpm: pick,
    });
    if (pick === null) return cb({ details: "unable to find a path to destination" });
    const fee = feeAt(pick);
    cb(null, {
      success_prob: 0.5,
      routes: [
        {
          total_amt_msat: (amtMsat + fee).toString(),
          total_fees_msat: fee.toString(),
          total_time_lock: PLAN_HEIGHT + 200,
          hops: [
            { amt_to_forward_msat: (amtMsat + fee).toString(), chan_capacity: "5000000", chan_id: "945565418029056000", expiry: PLAN_HEIGHT + 120, fee_msat: fee.toString(), pub_key: planPeer(9), tlv_payload: true },
            { amt_to_forward_msat: amtMsat.toString(), chan_capacity: "5000000", chan_id: "945565418029121536", expiry: PLAN_HEIGHT + 80, fee_msat: "0", pub_key: node.publicKey, tlv_payload: true },
          ],
        },
      ],
    });
  });
  return node;
}
