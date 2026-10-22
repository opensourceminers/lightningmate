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
import { FakeMarket } from "./market.js";
import type { FeeApplyItem, FeeApplyResult } from "../../src/services/fees.js";
import type { FeeRecommendation, FeeRecReport } from "../../src/services/feeRecommend.js";
import type { RebalanceExecOptions, RebalanceExecParams, RebalanceExecResult } from "../../src/services/rebalance.js";
import type { RebalanceRecommendation, RebalanceRecReport } from "../../src/services/rebalanceRecommend.js";
import type { SuggestionV2, SuggestV2Report } from "../../src/services/suggestRecommend.js";
import { FakeLnd } from "./fakeLnd.js";
import { installFetchMock } from "./fetchMock.js";
import { AMBOSS_API } from "./amboss.js";
import { makeTempDir, type AfterHook } from "./tmp.js";

/**
 * No "run soon after a settings change" kicks (setConfig → reschedule: a main
 * run after 2 s, an order-lane pass after 5 s, on real timers). A test drives
 * runOnce/pollSellOrders itself; a kick firing into the next step — or, on a
 * slow CI runner, after the test, into its fetch mock's after-hook ("unexpected
 * outbound request(s)") — only made tests flaky. The scheduler's own tests
 * build an Autopilot without this.
 */
export function suppressSchedulerKicks(autopilot: Autopilot): void {
  (autopilot as unknown as { kick: (fn: () => Promise<unknown>, delayMs: number) => void }).kick = () => undefined;
}

/** The autopilot's planning reads, node writes and later stages, replaceable
 *  by a test (see "node seams" in autopilot.ts). */
export interface AutopilotSeams {
  feeReport: () => Promise<Pick<FeeRecReport, "recommendations">>;
  feeApply: (writeLnd: unknown, items: FeeApplyItem[]) => Promise<FeeApplyResult[]>;
  rebalanceReport: () => Promise<Pick<RebalanceRecReport, "recommendations">>;
  /** The executor; the real one gets the books' write-ahead hooks and the
   *  shutdown check (a stub may ignore them — the books then record a
   *  payment left in flight when the stub returns it). */
  rebalanceExec: (writeLnd: unknown, p: RebalanceExecParams, opts?: RebalanceExecOptions) => Promise<RebalanceExecResult>;
  channelSuggestions: () => Promise<Pick<SuggestV2Report, "suggestions">>;
  /** The economy fee rate an automatic open pays (sat/vB) — LND's estimate;
   *  the fake LND has none unless a test gives it one (null: no open). */
  openFeeRate: () => Promise<number | null>;
  /** The Magma stage — the one that always runs after the fee, rebalance and
   *  channel stages; a test replaces it to look at the disk mid-run. */
  runSell: () => Promise<unknown[]>;
}

/** A peer LND is connected to for gossip (no channel with it). A live LND
 *  keeps a few such peers at all times; with none at all, the channel stage
 *  takes this node to be offline and dials nobody. */
export const GOSSIP_PEER = "03" + "9a".repeat(32);

/**
 * An Autopilot on a fake node, with `config` stored as its settings (and
 * `stored` as the rest of autopilot.json), and no way to reach a real service
 * (every run also refreshes Amboss's public sale history in the background —
 * answered here with an empty one). `files`: other state files of the data
 * dir as a previous process left them (e.g. "rebalances.json"). `node`: the
 * fake LND to run on (default: an empty one with 20M on chain, connected to a
 * gossip peer). `writeDenied`: the gRPC methods LND refuses the write client
 * (its macaroon lacks them, FakeLnd.withoutPermission); the read client may
 * call everything.
 */
export function autopilotWith(
  t: AfterHook,
  config: Record<string, unknown>,
  stored: Record<string, unknown> = {},
  files: Record<string, unknown> = {},
  node: FakeLnd = new FakeLnd({ chainBalance: 20_000_000, peers: [GOSSIP_PEER] }),
  writeDenied: string[] = [],
) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "autopilot.json"),
    JSON.stringify({ config, history: [], sellAutoSizeMigrated: true, ...stored }),
  );
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(content));
  const amboss = new AmbossStore(dir);
  amboss.setKey("test-key");
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    writeDenied.length > 0 ? node.withoutPermission(...writeDenied) : node.lnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    amboss,
    new EarningsLog(dir),
    new ServiceFeeLedger(dir, null),
  );
  suppressSchedulerKicks(autopilot);
  t.after(() => autopilot.shutdown());
  const seams = autopilot as unknown as AutopilotSeams;
  return { autopilot, node, seams, http, dir };
}

/**
 * A NEW process on a data dir another one left behind — what a restart (or a
 * crash) finds: the disk and LND, nothing from memory. Its own stores, no
 * scheduler kicks; the fetch mock of the test stays in place.
 */
export function autopilotAt(t: AfterHook, dir: string, node: FakeLnd) {
  const amboss = new AmbossStore(dir);
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
  suppressSchedulerKicks(autopilot);
  t.after(() => autopilot.shutdown());
  return { autopilot, seams: autopilot as unknown as AutopilotSeams };
}

/** A buyer's node id (any valid 33-byte key works with the fake LND). */
export const BUYER = "02" + "ab".repeat(32);

/**
 * Magma selling on a fake node against a fake Magma API: Liquidity provision
 * on, auto-pricing/sizing/relisting off (no market reads), generous caps.
 * `restart()` builds a NEW autopilot on the same data dir, node and Amboss —
 * what a process restart sees: the disk and LND, nothing from memory.
 * `writeDenied`: the gRPC methods LND refuses the write client (its macaroon
 * lacks them, FakeLnd.withoutPermission).
 */
export function sellerSetup(
  t: AfterHook,
  opts: { config?: Record<string, unknown>; chainBalance?: number; payFees?: boolean; payTimeoutMs?: number; writeDenied?: string[] } = {},
) {
  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const magma = new FakeMagma(http, t);
  // Amboss's public market data (offer book, node stats, dollar rate): empty
  // unless a test fills it — the engine and the selling check stay offline.
  const market = new FakeMarket(http, t);
  const node = new FakeLnd({ chainBalance: opts.chainBalance ?? 20_000_000, peers: [GOSSIP_PEER] });
  // Sales and offers are this node's unless a test says otherwise.
  magma.sellerPubkey = node.publicKey;
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
  const writeLnd = opts.writeDenied?.length ? node.withoutPermission(...opts.writeDenied) : node.lnd;
  const started: Autopilot[] = [];
  const make = () => {
    const ap = new Autopilot(
      dir,
      node.lnd,
      writeLnd,
      new RebalanceLog(dir),
      new OverridesStore(dir),
      new AmbossStore(dir),
      new EarningsLog(dir),
      new ServiceFeeLedger(dir, null),
      undefined,
      new CapitalLedger(),
    );
    suppressSchedulerKicks(ap);
    started.push(ap);
    return ap;
  };
  const capital = new CapitalLedger();
  const autopilot = new Autopilot(
    dir,
    node.lnd,
    writeLnd,
    new RebalanceLog(dir),
    new OverridesStore(dir),
    amboss,
    earnings,
    fees,
    undefined,
    capital,
  );
  suppressSchedulerKicks(autopilot);
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
    market,
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

/** A channel to open, as the suggestion engine ranks it first (a useful
 *  peer with an address to dial, no LN+ profile, never closed with). */
export const suggestion = {
  pubkey: "02" + "cd".repeat(32),
  alias: "next-peer",
  socket: "",
  sockets: ["abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuvwx.onion:9735"],
  recommendedSizeSats: 2_000_000,
  usefulness: "high",
  lnplus: null,
  peerMinChannelSats: null,
  closedDaysAgo: null,
} as unknown as SuggestionV2;

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
