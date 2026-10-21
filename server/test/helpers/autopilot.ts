import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Autopilot } from "../../src/services/autopilot.js";
import { RebalanceLog } from "../../src/services/rebalanceLog.js";
import { OverridesStore } from "../../src/services/overrides.js";
import { AmbossStore } from "../../src/services/ambossStore.js";
import { EarningsLog } from "../../src/services/earningsLog.js";
import { ServiceFeeLedger, lndFeeLightning } from "../../src/services/serviceFee.js";
import { CapitalLedger } from "../../src/services/capital.js";
import { FakeMagma } from "./magma.js";
import type { FeeApplyItem, FeeApplyResult } from "../../src/services/fees.js";
import type { FeeRecommendation, FeeRecReport } from "../../src/services/feeRecommend.js";
import type { RebalanceExecParams, RebalanceExecResult } from "../../src/services/rebalance.js";
import type { RebalanceRecommendation, RebalanceRecReport } from "../../src/services/rebalanceRecommend.js";
import type { SuggestionV2, SuggestV2Report } from "../../src/services/suggestRecommend.js";
import { FakeLnd } from "./fakeLnd.js";
import { installFetchMock } from "./fetchMock.js";
import { AMBOSS_API } from "./amboss.js";
import { makeTempDir, type AfterHook } from "./tmp.js";

/** The autopilot's planning reads, node writes and later stages, replaceable
 *  by a test (see "node seams" in autopilot.ts). */
export interface AutopilotSeams {
  feeReport: () => Promise<Pick<FeeRecReport, "recommendations">>;
  feeApply: (writeLnd: unknown, items: FeeApplyItem[]) => Promise<FeeApplyResult[]>;
  rebalanceReport: () => Promise<Pick<RebalanceRecReport, "recommendations">>;
  rebalanceExec: (writeLnd: unknown, p: RebalanceExecParams) => Promise<RebalanceExecResult>;
  channelSuggestions: () => Promise<Pick<SuggestV2Report, "suggestions">>;
  /** The Magma stage — the one that always runs after the fee, rebalance and
   *  channel stages; a test replaces it to look at the disk mid-run. */
  runSell: () => Promise<unknown[]>;
}

/**
 * An Autopilot on a fake node, with `config` stored as its settings (and
 * `stored` as the rest of autopilot.json), and no way to reach a real service
 * (every run also refreshes Amboss's public sale history in the background —
 * answered here with an empty one).
 */
export function autopilotWith(t: AfterHook, config: Record<string, unknown>, stored: Record<string, unknown> = {}) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const node = new FakeLnd({ chainBalance: 20_000_000 });
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config, history: [], sellAutoSizeMigrated: true, ...stored }),
  );
  const amboss = new AmbossStore(dir);
  amboss.setKey("test-key");
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    amboss,
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  t.after(() => autopilot.shutdown());
  const seams = autopilot as unknown as AutopilotSeams;
  return { autopilot, node, seams, http, dir };
}

/** A buyer's node id (any valid 33-byte key works with the fake LND). */
export const BUYER = "02" + "ab".repeat(32);

/**
 * Magma selling on a fake node against a fake Magma API: Liquidity provision
 * on, auto-pricing/sizing/relisting off (no market reads), generous caps.
 * `restart()` builds a NEW autopilot on the same data dir, node and Amboss —
 * what a process restart sees: the disk and LND, nothing from memory.
 */
export function sellerSetup(
  t: AfterHook,
  opts: { config?: Record<string, unknown>; chainBalance?: number; payFees?: boolean; payTimeoutMs?: number } = {},
) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  const node = new FakeLnd({ chainBalance: opts.chainBalance ?? 20_000_000 });
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({
      config: {
        sellEnabled: true,
        sellMaxDeploySats: 50_000_000,
        sellMaxChannelSats: 10_000_000,
        sellAutoReprice: false,
        sellAutoSize: false,
        sellAutoRelist: false,
        ...opts.config,
      },
      history: [],
      sellAutoSizeMigrated: true,
    }),
  );
  const amboss = new AmbossStore(dir);
  amboss.setKey("test-key");
  const earnings = new EarningsLog(dir);
  const fees = new ServiceFeeLedger(dir, opts.payFees ? lndFeeLightning(node.lnd) : null, {
    payTimeoutMs: opts.payTimeoutMs ?? 10_000,
  });
  const started: Autopilot[] = [];
  const make = () => {
    const ap = new Autopilot(
      dir,
      node.lnd,
      node.lnd,
      new RebalanceLog(dir),
      new OverridesStore(dir),
      new AmbossStore(dir),
      new EarningsLog(dir),
      new ServiceFeeLedger(dir, null),
      undefined,
      new CapitalLedger(),
    );
    started.push(ap);
    return ap;
  };
  const capital = new CapitalLedger();
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    amboss,
    earnings,
    fees,
    undefined,
    capital,
  );
  started.push(autopilot);
  t.after(() => {
    for (const ap of started) ap.shutdown();
    fees.stop();
  });
  return {
    autopilot,
    desk: autopilot.magma,
    node,
    http,
    magma,
    dir,
    amboss,
    earnings,
    fees,
    capital,
    /** A fresh process on the same disk and node (its own stores, ledger, memory). */
    restart: make,
  };
}

/** A rebalance the planner would run (only the fields the autopilot reads). */
export const plannedRebalance = (channelId: string, expectedNetProfitSats: number) =>
  ({
    channelId,
    alias: `peer-${channelId}`,
    wouldRebalance: true,
    selectedSourceChannel: "800000x1x0",
    recommendedAmount: 100_000,
    maxCostPpm: 500,
    estimatedRouteFeeSats: 10,
    expectedNetProfitSats,
  }) as RebalanceRecommendation;

export const paidRebalance = (p: RebalanceExecParams, feeSats = 7): RebalanceExecResult => ({
  ok: true,
  targetId: p.targetId,
  targetAlias: `peer-${p.targetId}`,
  sourceId: p.sourceId,
  sourceAlias: "source",
  amountSats: p.amountSats,
  budgetPpm: 500,
  feeSats,
  costPpm: 70,
});

export const failedRebalance = (p: RebalanceExecParams): RebalanceExecResult => ({
  ...paidRebalance(p),
  ok: false,
  feeSats: null,
  costPpm: null,
  error: "no route",
});

/** A channel to open, as the suggestion engine ranks it first. */
export const suggestion = {
  pubkey: "02" + "cd".repeat(32),
  alias: "next-peer",
  socket: "",
  recommendedSizeSats: 2_000_000,
} as SuggestionV2;

/** A fee recommendation (only the fields the autopilot reads): by default one
 *  the engine would apply. */
export const plannedFeeChange = (
  channelId: string,
  fromPpm: number,
  toPpm: number,
  opts: { wouldApply?: boolean; routedOut14d?: number } = {},
) =>
  ({
    channelId,
    alias: `peer-${channelId}`,
    wouldApply: opts.wouldApply ?? true,
    transactionId: "ee".repeat(32),
    transactionVout: 0,
    currentPpm: fromPpm,
    targetPpm: toPpm,
    recommendedBaseMsat: 0,
    noFlowLowering: false,
    metrics: { routedOut14d: opts.routedOut14d ?? 0 },
  }) as unknown as FeeRecommendation;
