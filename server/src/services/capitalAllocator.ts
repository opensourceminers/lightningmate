import { getChainBalance, type AuthenticatedLnd } from "lightning";
import { getChannelsView } from "./channels.js";
import { getForwardsReport } from "./forwards.js";
import { getChannelSuggestionsV2 } from "./suggestRecommend.js";

/**
 * Capital Allocation Engine (ADVISORY / read-only).
 *
 * Turns the separate modules (fees / rebalance / suggestions / Magma) into one
 * question: "where should my sats go?" It scores every use of capital in a common
 * currency — expected yield in ppm/year — and proposes a coordinated plan:
 *   keep healthy channels · close dead ones to free capital · open to top peers ·
 *   lease idle capital on Magma above a threshold · keep an on-chain reserve.
 *
 * It NEVER executes anything. The output is a recommendation the operator reads
 * and acts on (auto-execution is a separate, opt-in step). Yields are annualised
 * from the last 30 days; a brand-new channel's yield is an estimate, not measured,
 * and is flagged as such.
 */

/** Sats kept on-chain for force-close fee bumps + opportunistic opens. */
const RESERVE_SATS = 250_000;
/** Minimum sensible size to open a channel or list a Magma offer. */
const MIN_DEPLOY_SATS = 1_000_000;
/** Lease only above this × your marginal routing yield (else routing wins). */
const LEASE_VS_ROUTE_RATIO = 1.2;
/** Don't bother proposing to free a channel below this much local capital. */
const MIN_FREE_SATS = 50_000;
const YEAR_OVER_30D = 365 / 30;

export type CapitalActionKind = "reserve" | "close" | "open" | "lease" | "hold" | "keep";

export interface CapitalAction {
  kind: CapitalActionKind;
  title: string;
  sats: number;
  /** Expected annual yield on these sats (ppm/year), null if not applicable. */
  expectedYieldPpmYear: number | null;
  confidence: "high" | "medium" | "low";
  rationale: string;
  /** Channel id (close) or peer pubkey (open), for the UI to link. */
  ref?: string;
}

export interface CapitalPlan {
  generatedAt: string;
  totalCapacitySats: number;
  onchainConfirmedSats: number;
  reserveSats: number;
  /** On-chain deployable now + capital freed by the proposed closes. */
  deployableSats: number;
  freedByClosesSats: number;
  medianRoutingYieldPpmYear: number;
  marginalRoutingYieldPpmYear: number;
  /** The price floor below which leasing isn't worth it vs routing. */
  leaseThresholdPpmYear: number;
  actions: CapitalAction[];
  summary: string;
  notes: string[];
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * sortedAsc.length)));
  return sortedAsc[i];
}

const compact = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n);

export async function getCapitalPlan(lnd: AuthenticatedLnd): Promise<CapitalPlan> {
  const [channels, report, chain] = await Promise.all([
    getChannelsView(lnd),
    getForwardsReport(lnd, 30),
    getChainBalance({ lnd }),
  ]);

  const onchainConfirmedSats = chain.chain_balance;
  const revByChan = new Map(report.perChannel.map((c) => [c.channelId, c.feesEarnedSats]));
  const fwdByChan = new Map(report.perChannel.map((c) => [c.channelId, c.forwardCount]));

  const active = channels.filter((c) => c.active);
  const totalCapacitySats = channels.reduce((s, c) => s + c.capacity, 0);

  // Per-channel routing yield = fees earned / capital tied up, annualised.
  const yieldOf = (id: string, capacity: number): number => {
    const rev = revByChan.get(id) ?? 0;
    return capacity > 0 ? Math.round((rev / capacity) * YEAR_OVER_30D * 1_000_000) : 0;
  };

  const yields = active.map((c) => yieldOf(c.id, c.capacity)).sort((a, b) => a - b);
  const medianRoutingYieldPpmYear = percentile(yields, 50);
  const marginalRoutingYieldPpmYear = percentile(yields, 25);
  const leaseThresholdPpmYear = Math.round(Math.max(marginalRoutingYieldPpmYear, 1) * LEASE_VS_ROUTE_RATIO);

  const actions: CapitalAction[] = [];
  const notes: string[] = [];

  // 1) On-chain reserve.
  const reserveSats = RESERVE_SATS;
  actions.push({
    kind: "reserve",
    title: `Keep ${compact(reserveSats)} on-chain reserve`,
    sats: reserveSats,
    expectedYieldPpmYear: 0,
    confidence: "high",
    rationale: "Headroom to CPFP-bump force-closes and fund opportunistic opens.",
  });

  // 2) Close candidates — conservative: zero forwards in 30d AND either offline or
  //    yield far below the marginal channel. Frees local capital to redeploy.
  let freedByClosesSats = 0;
  const closeable = channels
    .filter((c) => {
      const fwd = fwdByChan.get(c.id) ?? 0;
      const y = yieldOf(c.id, c.capacity);
      const dead = fwd === 0 && (!c.active || y < marginalRoutingYieldPpmYear * 0.25);
      return dead && c.localBalance >= MIN_FREE_SATS;
    })
    .sort((a, b) => b.localBalance - a.localBalance);
  for (const c of closeable) {
    freedByClosesSats += c.localBalance;
    actions.push({
      kind: "close",
      title: `Close idle channel with ${c.peerAlias || c.id}`,
      sats: c.localBalance,
      expectedYieldPpmYear: yieldOf(c.id, c.capacity),
      confidence: c.active ? "low" : "medium",
      rationale: `No forwards in 30d${c.active ? "" : ", currently offline"} — frees ~${compact(c.localBalance)} sat to redeploy.`,
      ref: c.id,
    });
  }

  // 3) Deployable = on-chain above reserve + what the closes would free.
  const deployableSats = Math.max(0, onchainConfirmedSats - reserveSats) + freedByClosesSats;
  let remaining = deployableSats;

  // 4) Deploy: open to top peers if a new channel's expected (median) routing yield
  //    beats the lease threshold; otherwise lease the rest on Magma above the floor.
  if (remaining >= MIN_DEPLOY_SATS) {
    const openWins = medianRoutingYieldPpmYear >= leaseThresholdPpmYear;
    let suggestions: { alias: string; pubkey: string; recommendedSizeSats: number }[] = [];
    if (openWins) {
      try {
        suggestions = ((await getChannelSuggestionsV2(lnd, {})).suggestions ?? []) as typeof suggestions;
      } catch {
        notes.push("Couldn't load peer suggestions — left the routing-side capital for Magma.");
      }
    }
    for (const s of suggestions.slice(0, 3)) {
      if (remaining < MIN_DEPLOY_SATS) break;
      const want = Math.max(MIN_DEPLOY_SATS, s.recommendedSizeSats || MIN_DEPLOY_SATS);
      const size = Math.min(want, remaining);
      if (size < MIN_DEPLOY_SATS) break;
      remaining -= size;
      actions.push({
        kind: "open",
        title: `Open ~${compact(size)} to ${s.alias}`,
        sats: size,
        expectedYieldPpmYear: medianRoutingYieldPpmYear,
        confidence: "low",
        rationale: `Top peer suggestion. New-channel yield is estimated at your node's median routing yield (~${compact(medianRoutingYieldPpmYear)} ppm/yr) — not yet measured.`,
        ref: s.pubkey,
      });
    }
    if (remaining >= MIN_DEPLOY_SATS) {
      actions.push({
        kind: "lease",
        title: `List ${compact(remaining)} on Magma above ${leaseThresholdPpmYear.toLocaleString()} ppm/year`,
        sats: remaining,
        expectedYieldPpmYear: leaseThresholdPpmYear,
        confidence: "medium",
        rationale: `Lease idle capital — only worth it above your marginal routing yield × ${LEASE_VS_ROUTE_RATIO} (${leaseThresholdPpmYear.toLocaleString()} ppm/yr). Below that, routing earns more.`,
      });
      remaining = 0;
    }
  } else if (deployableSats > 0) {
    actions.push({
      kind: "hold",
      title: `Hold ${compact(deployableSats)} on-chain`,
      sats: deployableSats,
      expectedYieldPpmYear: 0,
      confidence: "medium",
      rationale: `Below the ${compact(MIN_DEPLOY_SATS)} minimum to open or list — accumulate before deploying.`,
    });
  }

  // 5) Keep — healthy capital that should stay where it is (top of the yield curve).
  const keepSats = active.reduce((s, c) => s + c.localBalance, 0) - freedByClosesSats;
  if (keepSats > 0) {
    actions.push({
      kind: "keep",
      title: `Keep ${compact(keepSats)} in working channels`,
      sats: keepSats,
      expectedYieldPpmYear: medianRoutingYieldPpmYear,
      confidence: "high",
      rationale: "Capital in channels that are routing — leave it earning.",
    });
  }

  // Summary line.
  const closeCount = actions.filter((a) => a.kind === "close").length;
  const openCount = actions.filter((a) => a.kind === "open").length;
  const leaseSats = actions.filter((a) => a.kind === "lease").reduce((s, a) => s + a.sats, 0);
  const parts: string[] = [`keep ${compact(reserveSats)} reserve`];
  if (closeCount) parts.push(`close ${closeCount} idle channel${closeCount > 1 ? "s" : ""} (frees ${compact(freedByClosesSats)})`);
  if (openCount) parts.push(`open to ${openCount} top peer${openCount > 1 ? "s" : ""}`);
  if (leaseSats) parts.push(`list ${compact(leaseSats)} on Magma above ${leaseThresholdPpmYear.toLocaleString()} ppm/yr`);
  if (parts.length === 1) parts.push("no idle capital to redeploy right now");
  const summary = `Best use of capital: ${parts.join(", ")}.`;

  notes.push("Advisory only — review before acting. Closing channels is irreversible and costs on-chain fees.");
  notes.push("Yields are annualised from the last 30 days; new-channel yields are estimates, not measured.");
  if (yields.length === 0 || yields.every((y) => y === 0)) {
    notes.push("No routing revenue in the last 30 days yet — estimates are weak until data accumulates.");
  }

  return {
    generatedAt: new Date().toISOString(),
    totalCapacitySats,
    onchainConfirmedSats,
    reserveSats,
    deployableSats,
    freedByClosesSats,
    medianRoutingYieldPpmYear,
    marginalRoutingYieldPpmYear,
    leaseThresholdPpmYear,
    actions,
    summary,
    notes,
  };
}
