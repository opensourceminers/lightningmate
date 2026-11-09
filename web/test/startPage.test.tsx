/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * The start page says what needs you; a new install's first start asks what
 * the node is for; Advanced says what was changed and can put it back; the
 * words are the plain ones; Settings is a gear; selling has one home.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { todoItems } from "../src/todoView";
import { activityTitle } from "../src/analyticsView";
import { SETUP_GOALS, setupLines, setupPatch, setupProblem, withoutSelling, type SetupChoice } from "../src/setupView";
import { advancedChanged, baselineConfig, EMPTY_DRAFT, resetToBaseline, type AdvancedSet, type Draft } from "../src/autopilotForm";
import { buildPresets, matchesPreset, SELLING_KEYS } from "../src/presets";
import { GLOSSARY } from "../src/components/SettingsPanel";
import type { AutopilotConfig, ChannelView, DashboardData } from "../src/types";

const read = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-11-09T12:00:00Z");
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const dash = (o: Partial<DashboardData> = {}, ap: Partial<DashboardData["autopilot"]> = {}): DashboardData =>
  ({
    windowDays: 30,
    forwardCount: 12,
    forwardsComplete: true,
    rolling: { last24h: { forwards: 1, routedSats: 1, feesSats: 1 }, last7d: { forwards: 3, routedSats: 1, feesSats: 1 } },
    idleChannels: null,
    autopilot: {
      fees: true,
      rebalance: false,
      channel: false,
      sell: false,
      maxHtlc: false,
      lastRunAt: iso(44),
      lastRun: { applied: 0, attempted: 0, failed: 0, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0 },
      lastActionAt: iso(120),
      intervalMinutes: 30,
      pausedAt: null,
      lspModeOn: false,
      status: {},
      magmaRefusals: 0,
      magmaRefusalReason: null,
      ...ap,
    },
    ...o,
  }) as unknown as DashboardData;

const channel = (o: Partial<ChannelView>): ChannelView =>
  ({ id: "1x1x1", peerPubkey: "02" + "11".repeat(32), peerAlias: "peer", status: "open", active: true, localBalance: 1_000_000, offline: null, ...o }) as ChannelView;
const away = (hours: number) => ({ since: iso(hours * 60), hours, uptimeShare: null, long: hours >= 72 });

test("with nothing to do the list is empty, and an autopilot run that changed nothing is a footnote, no task", () => {
  const { todo, footnote } = todoItems(dash(), [channel({})], NOW);
  assert.deepEqual(todo, []);
  assert.match(footnote ?? "", /^Autopilot 44m ago: nothing needed changing/);
  assert.match(footnote ?? "", /Last change by the autopilot 2h ago$/);
});

test("a peer away for days is named, its coins counted, and leads to its details; a short outage is no task", () => {
  const key = "02" + "22".repeat(32);
  const { todo } = todoItems(dash(), [channel({ id: "a", active: false, offline: away(5) }), channel({ id: "b", peerPubkey: key, peerAlias: "MOLA", active: false, offline: away(216), localBalance: 3_370_000 })], NOW);
  assert.equal(todo.length, 1);
  assert.equal(todo[0].text, "MOLA is offline ~9 d: 3.37M sat of yours can't move");
  assert.equal(todo[0].warn, true);
  assert.deepEqual(todo[0].node, { pubkey: key, alias: "MOLA" });
});

test("many away: the biggest stakes by name, the rest counted", () => {
  const list = [1, 2, 3, 4, 5].map((n) => channel({ id: `c${n}`, peerPubkey: `key${n}`, peerAlias: `p${n}`, active: false, offline: away(100), localBalance: n * 1_000_000 }));
  const { todo } = todoItems(dash(), list, NOW);
  assert.deepEqual(todo.map((t) => t.text.split(" ")[0]), ["p5", "p4", "p3", "2"]);
  assert.equal(todo[3].text, "2 more channels offline for days");
  assert.equal(todo[3].tab, "channels");
});

test("four areas reporting one trouble are one line: a read-only node doesn't get a heap of messages", () => {
  const why = "write mode is off (LM_ENABLE_WRITE) — the autopilot can't change anything on the node";
  const blocked = { state: "blocked", text: why };
  const { todo } = todoItems(
    dash({}, { rebalance: true, sell: true, channel: true, status: { fees: blocked, rebalance: blocked, magma: blocked, channels: blocked } as never }),
    [],
    NOW,
  );
  assert.equal(todo.length, 1);
  assert.match(todo[0].text, /blocked: write mode is off/);
  assert.match(todo[0].text, /^[^:]+, [^:]+, [^:]+, [^:]+ blocked:/, "all four named");
  // Different troubles stay apart.
  const two = todoItems(dash({}, { rebalance: true, status: { fees: { state: "error", text: "boom" }, rebalance: blocked } as never }), [], NOW);
  assert.equal(two.todo.length, 2);
});

test("what is merely under way comes after what needs you; idle channels lead to the close list", () => {
  const { todo } = todoItems(
    dash({ idleChannels: { count: 2, localSats: 5_000_000 } }, { pausedAt: iso(10) }),
    [channel({ id: "x", status: "pending_close", active: false }), channel({ id: "y", status: "pending_open", active: false })],
    NOW,
  );
  assert.ok(todo[0].warn, "the pause first");
  assert.deepEqual(
    todo.filter((t) => !t.warn).map((t) => t.text),
    ["2 channels routed nothing in 30 days: 5.00M sat of yours sit idle", "1 channel opening: waiting for confirmation", "1 channel closing"],
  );
  // Can't be told: not said.
  assert.equal(todoItems(dash({ idleChannels: null }), [], NOW).todo.length, 0);
  assert.equal(todoItems(dash({ idleChannels: { count: 0, localSats: 0 } }), [], NOW).todo.length, 0);
});

const base: AutopilotConfig = {
  channelMaxFeeRate: 20,
  enabled: false,
  rebalanceEnabled: false,
  channelEnabled: false,
  sellEnabled: false,
  intervalMinutes: 30,
  cooldownMinutes: 360,
  maxChangesPerRun: 5,
  feeFloorAboveMax: false,
  maxRebalancesPerRun: 2,
  rebalanceDailyBudgetSats: 10_000,
  channelReserveSats: 50_000,
  channelSizeSats: 0,
  sellMaxDeploySats: 2_000_000,
  sellMaxChannelSats: 2_000_000,
  sellReserveSats: 50_000,
  sellAutoReprice: true,
  sellAutoSize: true,
  sellAutoRelist: false,
  sellAutoClose: false,
  sellPricingMode: "balanced",
  policy: { minPpm: 25, maxPpm: 1000, neutralPpm: 80, baseFeeMsat: 0, protectPpm: 350, safetyMargin: 1.15, noFlowRatchetSteps: 3, exploreLowerModifier: 0.85, step: 10, minChangePpm: 25 },
  rebalancePolicy: { econRatio: 0.8, minNetProfitSats: 100, maxPaybackDays: 21, maxAmountSats: 2_000_000 },
} as unknown as AutopilotConfig;

const choice = (o: Partial<SetupChoice> = {}): SetupChoice => ({ goal: "routing", openChannels: true, reserveSats: 100_000, sellEverything: false, sellCapSats: 3_000_000, ...o });

test("the first-start answers: routing is the recommended strategy, selling never switches itself on", () => {
  assert.deepEqual(setupPatch(choice({ goal: "watch" }), base, 1e9), {});
  const routing = setupPatch(choice(), base, 1e9);
  assert.equal(routing.enabled, true);
  assert.equal(routing.rebalanceEnabled, true);
  assert.equal(routing.channelEnabled, true);
  assert.equal(routing.channelReserveSats, 100_000);
  const balanced = buildPresets(base).find((p) => p.id === "balanced")?.cfg ?? {};
  assert.ok(matchesPreset({ ...base, ...routing } as AutopilotConfig, balanced), "the Autopilot page shows it as Balanced");
  for (const k of SELLING_KEYS) assert.equal(k in routing, false, k);
  assert.equal(setupPatch(choice({ openChannels: false }), base, 1e9).channelEnabled, false);

  const selling = setupPatch(choice({ goal: "selling", sellEverything: true }), base, 1e9);
  assert.equal(selling.sellEnabled, undefined, "D9: its own dialog");
  assert.equal(selling.sellMaxDeploySats, 1e9);
  assert.equal(selling.sellMaxChannelSats, 5_000_000);
  assert.equal(selling.sellReserveSats, 100_000);
  assert.deepEqual([selling.sellAutoReprice, selling.sellAutoSize, selling.sellAutoRelist, selling.sellAutoClose], [true, true, true, true]);
  const small = setupPatch(choice({ goal: "selling", sellCapSats: 3_000_000 }), base, 1e9);
  assert.equal(small.sellMaxDeploySats, 3_000_000);
  assert.equal(small.sellMaxChannelSats, 3_000_000, "never above what may be listed");
});

test("the first start says what it will do, with the strategy's figures, before it starts", () => {
  const lines = setupLines(choice(), base, false);
  assert.match(lines[0], /25 ppm \(0\.0025 %\) to 1,000 ppm \(0\.1 %\)/);
  assert.match(lines[1], /at most 10,000 sat in fees a day/);
  assert.match(lines[2], /keeping 100\.0k sat on chain and paying at most 20 sat\/vB/);
  assert.match(lines[2], /Until this node has routing history that fee limit is the only check, no payback/, "a new node has no yield to pay back from");
  assert.equal(setupLines(choice({ openChannels: false }), base, false)[2], "New channels: only when you open them, under Channels → To open.");
  assert.equal(setupLines(choice({ goal: "selling" }), base, false)[3], "Selling: off for now. Connect an Amboss key in Settings, then switch it on under Autopilot → Selling.");
  const selling = setupLines(choice({ goal: "selling", sellEverything: true }), base, true)[3];
  assert.match(selling, /^Selling: everything free is listed once you confirm/);
  assert.match(selling, /closes a sold channel after its lease, for an on-chain fee/, "what it switches on, said");
  assert.deepEqual(setupLines(choice({ goal: "watch" }), base, false), ["Nothing runs on its own."]);
  assert.equal(SETUP_GOALS.length, 3);
  const bounds = { reserve: { min: 0, max: 1_000_000 }, cap: { min: 0, max: 1_000_000_000 } };
  assert.equal(setupProblem(choice(), bounds), null);
  assert.match(setupProblem(choice({ reserveSats: NaN }), bounds) ?? "", /Keep on chain/);
  assert.match(setupProblem(choice({ reserveSats: 2_000_000 }), bounds) ?? "", /Keep on chain/);
  assert.match(setupProblem(choice({ reserveSats: 50_000.5 }), bounds) ?? "", /a whole number/, "what the server would refuse is said here");
  assert.match(setupProblem(choice({ goal: "selling", sellCapSats: NaN }), bounds) ?? "", /Capital to sell/);
  assert.match(setupProblem(choice({ goal: "selling", sellCapSats: 2_000_000_000 }), bounds) ?? "", /Capital to sell/);
  assert.equal(setupProblem(choice({ goal: "selling", sellEverything: true, sellCapSats: NaN }), bounds), null);
  assert.equal(setupProblem(choice({ goal: "watch", reserveSats: NaN }), bounds), null);
});

test("the first start asks only a new install that can write and has nothing on, and can be skipped at every step", () => {
  const src = read("components/SetupWizard.tsx");
  assert.match(src, /if \(s\.setupDone\) return;/);
  assert.match(src, /if \(!ap\.canWrite\) return;/);
  assert.equal((src.match(/\{skip\}/g) ?? []).length, 3);
  assert.match(src, /await turnSellingOn\(/, "selling's own dialog, its live check");
});

const set: AdvancedSet = { paths: ["intervalMinutes", "policy.minPpm", "policy.step"], flags: ["feeFloorAboveMax"], pricingMode: true };

test("Advanced counts what differs from the strategy in force, unsaved typing included, and resets as a draft", () => {
  const baseline = baselineConfig(base, null);
  assert.equal(advancedChanged(set, EMPTY_DRAFT, base, baseline), 0);
  const edited = { ...base, intervalMinutes: 60, policy: { ...base.policy, step: 5 }, sellPricingMode: "premium" } as AutopilotConfig;
  assert.equal(advancedChanged(set, EMPTY_DRAFT, edited, baseline), 3);
  // Typed, not saved: counted as it stands. Half typed: the saved value counts.
  const typed: Draft = { ...EMPTY_DRAFT, nums: { intervalMinutes: "30", "policy.minPpm": "40" } };
  assert.equal(advancedChanged(set, typed, edited, baseline), 3);
  assert.equal(advancedChanged(set, { ...EMPTY_DRAFT, nums: { "policy.minPpm": "" } }, base, baseline), 0);

  const reset = resetToBaseline(set, typed, edited, baseline);
  assert.deepEqual(reset.nums, { intervalMinutes: "30", "policy.step": "10" });
  assert.equal(reset.pricingMode, "balanced");
  assert.equal(advancedChanged(set, reset, edited, baseline), 0, "nothing left to reset");
  // A setting already at the baseline leaves no draft behind.
  assert.deepEqual(resetToBaseline(set, EMPTY_DRAFT, base, baseline).nums, {});
  assert.equal(resetToBaseline(set, EMPTY_DRAFT, base, baseline).pricingMode, undefined);
  // Without pricing in the set, an unsaved pricing choice is left alone.
  assert.equal(resetToBaseline({ paths: [] }, { ...EMPTY_DRAFT, pricingMode: "fast" }, base, baseline).pricingMode, "fast");
});

test("a strategy's own values aren't 'changed': Advanced measures against the strategy, built on the defaults", () => {
  const routing = buildPresets(base).find((p) => p.id === "routing");
  assert.ok(routing);
  const applied = { ...base, ...routing.cfg } as AutopilotConfig;
  const paths = { paths: ["policy.minPpm", "policy.neutralPpm", "policy.protectPpm", "policy.step", "maxRebalancesPerRun"] } as AdvancedSet;
  assert.ok(advancedChanged(paths, EMPTY_DRAFT, applied, baselineConfig(base, null)) > 0, "against the factory settings they differ");
  const baseline = baselineConfig(base, routing.cfg);
  assert.equal(advancedChanged(paths, EMPTY_DRAFT, applied, baseline), 0);
  // A hand-set rounding on top of the strategy is one change.
  const hand = { ...applied, policy: { ...applied.policy, step: 5 } } as AutopilotConfig;
  const built = buildPresets(hand).find((p) => p.id === "routing");
  assert.ok(built && matchesPreset(hand, built.cfg), "still the same strategy");
  const fromDefaults = buildPresets(base).find((p) => p.id === "routing")?.cfg ?? null;
  assert.equal(advancedChanged(paths, EMPTY_DRAFT, hand, baselineConfig(base, fromDefaults)), 1);
  const panel = read("components/AutopilotPanel.tsx");
  assert.match(panel, /buildPresets\(server\.defaults\)/, "built on the defaults, or the operator's own values would count as the strategy's");
});

test("every area's Advanced is a remembered fold that counts its changes", () => {
  const panel = read("components/AutopilotPanel.tsx");
  for (const area of ["fees", "rebalancing", "channels", "magma"]) assert.match(panel, new RegExp(`advanced\\(\\s*"${area}"`), area);
  assert.doesNotMatch(panel, /<summary>Advanced<\/summary>/);
  assert.match(panel, /note=\{changed > 0 \? `\$\{changed\} changed` : undefined\}/);
});

test("Settings is a gear in the top bar, not a tab; a link to it still works", () => {
  const app = read("App.tsx");
  assert.doesNotMatch(app, /\{ id: "settings", label: "Settings" \}/);
  assert.match(app, /aria-label="Settings"/);
  assert.match(app, /navigate\("settings"\)/);
  assert.match(app, /tab === "settings" \? <SettingsPanel/);
});

test("selling has one home for its settings: Market → Sell shows the offer and points there", () => {
  const sell = read("components/MarketSell.tsx");
  assert.match(sell, /settings under Autopilot → Selling/);
  assert.match(sell, /<Fold id="sell-by-hand"/);
  assert.match(sell, /<Fold id="sell-check"/);
  assert.doesNotMatch(sell, /v2-badge/);
  // An edit under way, or no offer yet, opens what it needs.
  assert.match(sell, /forceOpen=\{editingId !== null \|\| draft !== null \|\| showForm \|\| \(connected !== null && offers\.length === 0\)\}/);
  const panel = read("components/AutopilotPanel.tsx");
  assert.match(panel, /goTo\("market", "sell"\)/);
});

test("the plain words: nobody has to know 'liquidity provision', and the rest is looked up in one place", () => {
  for (const f of ["components/AutopilotPanel.tsx", "components/SellingSwitch.tsx", "components/MarketSell.tsx", "magmaView.ts", "autopilotView.ts", "autopilotForm.ts", "presets.ts"]) {
    assert.doesNotMatch(read(f), /Liquidity provision/, f);
  }
  assert.doesNotMatch(read("components/SummaryBar.tsx"), /Local \(outbound\)/);
  for (const f of ["components/FeeRecommendations.tsx", "components/RebalanceRecommendations.tsx"]) assert.match(read(f), />Your side</, f);
  const words = GLOSSARY.map(([w]) => w);
  for (const w of ["sat", "Channel", "Forward", "ppm", "Refill (rebalance)"]) assert.ok(words.includes(w), w);
  assert.match(GLOSSARY.find(([w]) => w === "ppm")?.[1] ?? "", /1,000 ppm is 0\.1 %/);
});

test("the close dialog doesn't call a close LND goes on with a failure, and offers nothing more to press", () => {
  const dialog = read("components/CloseChannelDialog.tsx");
  assert.match(dialog, /if \(r\.stillClosing\) \{\s+setUnderWay\(r\.error \?\? ""\);\s+return;/);
  assert.match(dialog, /underWay !== null \? \(/);
  assert.match(dialog, /The close is under way/);
});

test("the start page gives no false all-clear: a failed run is a task, and an alert above keeps the tick away", () => {
  const failed = todoItems(dash({}, { lastRun: { applied: 0, attempted: 2, failed: 2, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0 } as never }), [], NOW);
  assert.equal(failed.todo.length, 1);
  assert.match(failed.todo[0].text, /^Autopilot 44m ago: nothing applied/);
  assert.equal(failed.todo[0].warn, true);
  assert.equal(failed.todo[0].sub, "history");
  assert.equal(failed.footnote?.startsWith("Autopilot"), false, "not also a footnote");
  const overview = read("components/Overview.tsx");
  assert.match(overview, /alerts\.length > 0 \? "Nothing else needs you right now\." : "Nothing needs you right now\."/);
});

test("idle channels lead to the table that marks them, not a list that may leave them out", () => {
  const { todo } = todoItems(dash({ idleChannels: { count: 1, localSats: 1_000_000 } }), [], NOW);
  assert.deepEqual([todo[0].tab, todo[0].sub], ["channels", undefined]);
});

test("Market → Sell keeps what is wrong in view: the price's state and its warnings above the folds, a problem count on the check", () => {
  const sell = read("components/MarketSell.tsx");
  const fold = sell.indexOf('<Fold id="sell-by-hand"');
  assert.ok(sell.indexOf("sell-price-line") < fold && sell.indexOf("sell-price-line") > 0);
  assert.ok(sell.indexOf("r0.warnings.map") < fold && sell.indexOf("r0.warnings.map") > 0);
  assert.match(sell, /note=\{sellProblems > 0 \? `\$\{sellProblems\} to look at` : undefined\}/);
});

test("the first start saves once, after selling's own dialog: nothing runs while it is up, and a no leaves no selling settings behind", () => {
  const src = read("components/SetupWizard.tsx");
  assert.equal((src.match(/api\.autopilotSet\(/g) ?? []).length, 1);
  assert.ok(src.indexOf("await turnSellingOn(") < src.indexOf("api.autopilotSet("));
  assert.match(src, /sellingYes \? \{ \.\.\.patch, sellEnabled: true \} : withoutSelling\(patch\)/);
  assert.match(src, /openChannels: false/, "opening channels with someone's coins is theirs to tick");
  const patch = setupPatch(choice({ goal: "selling", sellEverything: true }), base, 1e9);
  const without = withoutSelling(patch);
  assert.equal(Object.keys(without).some((k) => k.startsWith("sell")), false);
  assert.equal(without.enabled, true);
  // Set up by hand, or paused: no questions, now or later.
  assert.match(src, /!allAutomationOff\(ap\.config\) \|\| ap\.paused/);
});

test("a feed row says a thing once", () => {
  assert.equal(activityTitle({ kind: "channel_open", title: "Channel open" }), "Channel open");
  assert.equal(activityTitle({ kind: "channel_close", title: "Sunny Sarah" }), "Channel close · Sunny Sarah");
  assert.equal(activityTitle({ kind: "onchain_in", title: "On-chain receive" } as never), "On-chain in");
});
