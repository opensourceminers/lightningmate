/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * The Rebalancing views (review a2, package P3): the settings shown are the
 * ones that bind the profit gate, the confirm dialog states the payment's
 * real cap, today's budget is shown with manual runs in it, and the presets
 * promise no rebalancing the gate can't deliver.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  REBALANCE_POLICY_FIELDS,
  REMOVED_SETTINGS_NOTE,
  afterRefillText,
  budgetBlocked,
  budgetLine,
  confirmRefillText,
  inFlightLine,
  inFlightThrough,
  manualRefillRequest,
  refillOutcome,
  stalePlanRefusal,
} from "../src/rebalanceView";
import { RefillAction } from "../src/components/RebalanceRecommendations";
import { buildPresets } from "../src/presets";
import type { AutopilotConfig, RebalanceBudget, RebalanceRecommendation, RefillInFlight } from "../src/types";

const budget = (o: Partial<RebalanceBudget> = {}): RebalanceBudget => ({
  day: "2026-10-21",
  budgetSats: 10_000,
  spentSats: 9_880,
  inFlightSats: 0,
  leftSats: 120,
  resetsAt: "2026-10-22T00:00:00.000Z",
  ...o,
});

test("the rebalance settings shown are exactly the ones the gate reads — 'Amount', 'Target ≤ local' and 'Source ≥ local' reached nothing", () => {
  assert.deepEqual(
    REBALANCE_POLICY_FIELDS.map((f) => f.key),
    ["econRatio", "minNetProfitSats", "maxPaybackDays", "maxAmountSats"],
  );
  assert.equal(REBALANCE_POLICY_FIELDS[0].label, "Max share of expected earnings spent on a refill (0.05–1)");
  const panel = readFileSync(new URL("../src/components/AutopilotPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /"Target ≤ local"|"Source ≥ local"|label: "Amount \(sat\)"|label: "Econ ratio"/);
  assert.match(panel, /Run from hour \(UTC, 0–24\)/, "the hours are UTC, like the budget's day");
  assert.match(REMOVED_SETTINGS_NOTE, /never reached the autopilot/);
});

test("the confirm dialog states the most the refill pays — the gate's cap, or what is left of today's budget — not the channel's 21 days of revenue", () => {
  const rec = {
    recommendedAmount: 750_000,
    alias: "router",
    maxFeeSats: 380,
    maxCostPpm: 320,
    maxCostSatsByPayback: 8_400,
    sourceCandidates: [{ channelId: "s", alias: "src", localRatio: 0.9, spareSats: 1_000_000, keepRatio: 0.55, reason: "" }],
  } as unknown as RebalanceRecommendation;
  const text = confirmRefillText(rec, budget({ leftSats: 5_000 }));
  assert.match(text, /^Move 750.0k into router from src \(a smaller amount if no route takes that much\), paying at most 380 sat in routing fees/);
  assert.doesNotMatch(text, /8,400/, "the payback figure was shown as if it were the cap");
  assert.match(text, /It counts toward today's rebalance budget \(5,000 sat left\)\./);
  assert.match(text, /It starts this channel's rebalance cooldown, but isn't held back by it/);
  // Less left than the gate allows: the budget is the cap, and it says so.
  assert.match(confirmRefillText(rec, budget()), /paying at most 120 sat .* \(120 sat left\), which caps it/);
  assert.match(confirmRefillText(rec, budget({ budgetSats: null, leftSats: null })), /There is no daily limit on rebalance fees/);
});

test("today's budget line counts manual runs and payments in flight; a profitable move it can't pay for is 'budget-blocked'", () => {
  assert.equal(
    budgetLine(budget({ inFlightSats: 40 })),
    "Today: 9,880 of 10,000 sat spent on rebalancing (40 of it in payments still in flight, at their maximum fee) — 120 left, resets 00:00 UTC. Manual runs count too.",
  );
  assert.match(budgetLine(budget({ budgetSats: null, leftSats: null })) ?? "", /no daily limit/);
  assert.equal(budgetBlocked({ wouldRebalance: true, estimatedRouteFeeSats: 300 }, budget()), true);
  assert.equal(budgetBlocked({ wouldRebalance: true, estimatedRouteFeeSats: 100 }, budget()), false);
  assert.equal(budgetBlocked({ wouldRebalance: false, estimatedRouteFeeSats: 300 }, budget()), false);
  assert.equal(
    afterRefillText({ postRefillPpm: 400, expectedRevenuePpm: 400, preRefillPpm: 400 }),
    "after the refill: kept at ≥ 400 ppm until the refilled sats have routed out",
  );
});

test("a refill the engine reprices lower after it (a pin, a lease promise) says so — the moved sats are valued at that fee", () => {
  // The gate's value is already the lower of the estimate (400) and the fee
  // after the refill (300): compared with it, this case never showed.
  assert.equal(afterRefillText({ postRefillPpm: 300, expectedRevenuePpm: 300, preRefillPpm: 400 }), "after the refill: ~300 ppm (valued at that)");
  // Higher after the refill (the market's replacement cost): held at the estimate.
  assert.equal(
    afterRefillText({ postRefillPpm: 460, expectedRevenuePpm: 400, preRefillPpm: 400 }),
    "after the refill: kept at ≥ 400 ppm until the refilled sats have routed out",
  );
});

test("no preset promises rebalancing the gate can't deliver — 'Max routing' says refills rarely pass at its fees", () => {
  const config = {
    policy: { minPpm: 25, neutralPpm: 80, maxPpm: 1000, protectPpm: 350, baseFeeMsat: 0, step: 10, minChangePpm: 25 },
    rebalancePolicy: { econRatio: 0.8, minNetProfitSats: 100, maxPaybackDays: 21, maxAmountSats: 2_000_000 },
  } as unknown as Pick<AutopilotConfig, "policy" | "rebalancePolicy">;
  const presets = buildPresets(config);
  for (const p of presets) assert.doesNotMatch(p.desc, /loose rebalancing/i, p.label);
  const routing = presets.find((p) => p.id === "routing")!;
  assert.match(routing.desc, /Refills run only when the profit check passes, which is rare at fees this low/);
  // Every preset leaves the gate's other settings as the operator set them.
  for (const p of presets) assert.equal(p.cfg.rebalancePolicy?.minNetProfitSats, 100, p.label);
  const doc = readFileSync(new URL("../../docs/AUTOPILOT-STRATEGY.md", import.meta.url), "utf8");
  assert.doesNotMatch(doc, /loose \(still\s+profitable\) rebalancing/);
  assert.match(doc, /refills rarely pass at these fees/);
});

/** A row the planner recommends (only what the run path reads). */
const recommended = (o: Partial<RebalanceRecommendation> = {}) =>
  ({
    channelId: "850000x1x0",
    alias: "router",
    wouldRebalance: true,
    selectedSourceChannel: "850000x2x0",
    recommendedAmount: 750_000,
    maxCostPpm: 320,
    maxFeeSats: 380,
    expectedRevenuePpm: 400,
    earningDemandSats: 1_200_000,
    minNetProfitSats: 100,
    sourceCandidates: [{ channelId: "850000x2x0", alias: "src", localRatio: 0.9, spareSats: 1_000_000, keepRatio: 0.55, reason: "" }],
    ...o,
  }) as RebalanceRecommendation;

test("'Run it' sends the row's fee caps and the profit gate — the cap the dialog promises, the check at every smaller size, and the hold that comes with it", () => {
  assert.deepEqual(manualRefillRequest(recommended(), 0.7), {
    targetId: "850000x1x0",
    sourceId: "850000x2x0",
    amountSats: 750_000,
    econRatio: 0.7,
    maxFeePpm: 320,
    maxFeeSats: 380,
    gate: { revenuePpm: 400, demandSats: 1_200_000, minNetSats: 100 },
  });
  // Nothing to run without a source or an amount.
  assert.equal(manualRefillRequest(recommended({ selectedSourceChannel: null })), null);
  assert.equal(manualRefillRequest(recommended({ recommendedAmount: null })), null);
  // The tab sends exactly this — no request of its own beside it.
  const tab = readFileSync(new URL("../src/components/RebalanceRecommendations.tsx", import.meta.url), "utf8");
  assert.match(tab, /const request = manualRefillRequest\(r, data\?\.config\?\.profitShare, data\?\.generatedAt\);/);
  assert.match(tab, /api\.rebalanceExecute\(request\)/);
  assert.doesNotMatch(tab, /econRatio: 0\.8/, "the operator's econRatio, not a constant");
});

// Review of P7 (a P3 gap): a run whose planned size the cap no longer allows
// (today's budget left shrank since the plan) tries the largest size that
// fits at the plan's route cost before the halves — the server needs it.
test("'Run it' carries the plan's route cost for the row's size — so a size the cap no longer allows falls to the largest one it does before the halves", () => {
  assert.equal(manualRefillRequest(recommended({ estimatedRouteCostPpm: 300 }), 0.8)?.routeCostPpm, 300);
  assert.equal(manualRefillRequest(recommended({ estimatedRouteCostPpm: null }), 0.8)?.routeCostPpm, undefined, "no probed cost: none sent");
});

test("a Run from the tab carries its plan's time: a row whose target was refilled since the plan was made is refused (409 stale_plan), and the tab loads a fresh plan instead of showing an error", () => {
  const planAt = "2026-10-21T10:00:00.000Z";
  assert.equal(manualRefillRequest(recommended(), 0.8, planAt)?.planAt, planAt);
  assert.equal(manualRefillRequest(recommended(), 0.8)?.planAt, undefined, "no plan time: none sent");
  const refused = { status: 409, body: { error: "stale_plan", message: "This channel was refilled (or tried) after this plan was made: reload it" } };
  assert.equal(stalePlanRefusal(refused), "This channel was refilled (or tried) after this plan was made — loading a fresh plan, nothing was sent.");
  // Any other refusal is shown as it is.
  assert.equal(stalePlanRefusal({ status: 409, body: { error: "busy" } }), null);
  assert.equal(stalePlanRefusal(new Error("boom")), null);
  const tab = readFileSync(new URL("../src/components/RebalanceRecommendations.tsx", import.meta.url), "utf8");
  assert.match(tab, /const stale = stalePlanRefusal\(e\);\s*if \(stale\) \{\s*ui\.toast\(stale, "info"\);\s*await load\(\);/);
});

test("the confirm dialog says the refill's price is then held, as after an autopilot refill", () => {
  assert.match(
    confirmRefillText(recommended(), budget({ leftSats: 5_000 })),
    /The fee engine then keeps this channel's fee at ≥ 400 ppm — what the refill is valued at — until the refilled sats have routed out \(at most 30 days\), as after an autopilot refill\./,
  );
  assert.doesNotMatch(confirmRefillText(recommended({ expectedRevenuePpm: null }), budget()), /keeps this channel's fee/);
});

test("a row whose channels a payment still in flight goes through shows that payment instead of a Run button — the server refuses a refill there until LND says how it ended", () => {
  const payment = (o: Partial<RefillInFlight> = {}): RefillInFlight => ({
    targetId: "850000x9x0",
    alias: "other",
    sourceId: "850000x2x0",
    sourceAlias: "src",
    amountSats: 400_000,
    maxFeeSats: 60,
    at: new Date().toISOString(),
    via: "autopilot",
    ...o,
  });
  // Out of this row's source …
  const out = inFlightThrough(recommended(), [payment()]);
  assert.equal(out?.channelId, "850000x2x0");
  assert.match(inFlightLine(out!), /^A payment out of src \(400\.0k, sent .*\) is still in flight — no refill through that channel until LightningMate learns how it ended \(checked every 2 minutes\)\.$/);
  // … or into this row's target.
  const into = inFlightThrough(recommended(), [payment({ targetId: "850000x1x0", alias: "router", sourceId: "850000x7x0" })]);
  assert.match(inFlightLine(into!), /^A payment into router /);
  assert.equal(inFlightThrough(recommended(), [payment({ sourceId: "850000x7x0" })]), null, "other channels don't block it");
  // The run area: the line, no button — and the button when nothing blocks it.
  const blocked = renderToStaticMarkup(<RefillAction r={recommended()} inFlight={[payment()]} running={false} onRun={() => undefined} />);
  assert.match(blocked, /A payment out of src/);
  assert.doesNotMatch(blocked, /<button/);
  const free = renderToStaticMarkup(<RefillAction r={recommended()} inFlight={[]} running={false} onRun={() => undefined} />);
  assert.match(free, /<button[^>]*>Run rebalance — move 750\.0k<\/button>/);
});

test("a manual refill the shutdown stopped is reported as a stop, not a failure", () => {
  const base = { amountSats: 400_000, feeSats: null, error: "skipped: shutting down — no further attempt was sent" };
  assert.deepEqual(refillOutcome({ ...base, ok: false, stopped: true }), {
    text: "Stopped: LightningMate is shutting down — no further attempt was sent",
    kind: "info",
  });
  assert.equal(refillOutcome({ ...base, ok: false }).kind, "error");
  assert.equal(refillOutcome({ ...base, ok: false, inFlight: { paymentId: "ab", maxFeeSats: 60 } }).kind, "info");
  assert.deepEqual(refillOutcome({ ok: true, amountSats: 400_000, feeSats: 12 }), { text: "Rebalanced 400.0k for 12 sat", kind: "success" });
});
