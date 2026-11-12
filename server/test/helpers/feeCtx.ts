/**
 * One channel's context for the fee engine's rule tests (`buildRecommendation`
 * is pure): a channel, the settings of a Strategy preset on the default
 * policy's step, and what the engine would have read for it.
 */
import { FEE_REC_DEFAULTS, type BuildCtx, type FeeChannel, type FeeRecConfig, type Flow } from "../../src/services/feeRecommend.js";

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const NOW = Date.parse("2026-10-21T12:00:00.000Z");
export const HEIGHT = 860_000;
/** The policy's "Round to" (DEFAULT_POLICY.step), as the autopilot maps it. */
export const STEP = 10;

/** The "Balanced" preset's fee settings (web/src/presets.ts). */
export const BALANCED: Partial<FeeRecConfig> = {
  minPpm: 25,
  neutralPpm: 80,
  maxPpm: 1000,
  protectPpm: 350,
  safetyMargin: 1.15,
  noFlowRatchetSteps: 3,
  exploreLowerModifier: 0.85,
};

export const cfgOf = (o: Partial<FeeRecConfig> = {}): FeeRecConfig => ({
  ...FEE_REC_DEFAULTS,
  ...BALANCED,
  stepPpm: STEP,
  minChangePpm: 25,
  maxChangesPerRun: 5,
  ...o,
});

export const NO_FLOW: Flow = { out: 0, inn: 0, revenue: 0, forwards: 0 };
export const flow = (out: number, inn: number, forwards: number, revenue = 0): Flow => ({ out, inn, forwards, revenue });

/** A channel id opened `days` before HEIGHT (144 blocks a day). */
export const openedDaysAgo = (days: number): string => `${HEIGHT - Math.round(144 * days)}x1x0`;

/** A 2M channel, half local, ~69 days old. */
export const chan = (o: Partial<FeeChannel> = {}): FeeChannel => ({
  id: "850000x1x0",
  peerAlias: "peer",
  capacity: 2_000_000,
  localRatio: 0.5,
  role: "router",
  active: true,
  ...o,
});

/** ISO time `hours` before NOW. */
export const hoursAgo = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();

/** The engine's context for one channel at `ppm` (80 by default): nothing
 *  routed, no refills, no market, forwards history not read (no
 *  `soldSinceChange`) unless given. */
export const ctx = (o: Partial<BuildCtx> & { ppm?: number; baseMsat?: number } = {}): BuildCtx => {
  const { ppm, baseMsat, ...rest } = o;
  return {
    cfg: cfgOf(),
    rate: { fee_rate: ppm ?? 80, base_fee_mtokens: String(baseMsat ?? 0), transaction_id: "aa".repeat(32), transaction_vout: 0 },
    override: undefined,
    f14: NO_FLOW,
    f30: NO_FLOW,
    currentBlock: HEIGHT,
    records: [],
    bench: { activeChannelCount: 1, topGrossFlow14d: 0, medianGrossFlow14d: 0, topRevenue30d: 0, medianRevenue30d: 0, topRevenuePpm30d: 0, medianRevenuePpm30d: 0 },
    enoughChannels: false,
    earnerCutoff: 0,
    cooldown: { lastApplied: {}, cooldownHours: 6 },
    elasticityMod: 1,
    flowAnchor: undefined,
    leaseCap: null,
    demand: undefined,
    market: undefined,
    nowMs: NOW,
    ...rest,
  };
};
