/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * The Autopilot tab and the Overview, made to say what the autopilot does
 * (package P7: a6-ux:presets-unconfirmed-capital, a6-ux:no-why-not-status,
 * a8-engineering:autopilot-decisions-invisible, a6-ux:numbers-mislead,
 * a6-ux:autopilot-form-traps, a6-ux:polling-and-stale-data,
 * a6-ux:nav-a11y-copy).
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  STATE_CHIP,
  allAutomationOff,
  areaStatusView,
  autopilotDigest,
  autopilotTileFoot,
  LSP_NOT_PAUSED,
  pauseHint,
  pauseLines,
  pausedText,
  pausedToast,
  presetChanges,
  presetConfirmLines,
  resumeLines,
  runResultLine,
} from "../src/autopilotView";
import {
  EMPTY_DRAFT,
  PER_RUN_HINTS,
  REBALANCE_WINDOW_HINT,
  checkDraft,
  draftIsEmpty,
  draftStore,
  switchOnConfirm,
  windowEverOpen,
  type Draft,
} from "../src/autopilotForm";
import { buildPresets } from "../src/presets";
import { EMPTY_REPORT_VIEW, MAGMA_REPORT_MAX_AGE_MS, forgetMagmaReport, reportErrorText, reportLoaded, reportRefreshFailed, sharedMagmaReport } from "../src/magmaReport";
import { caretButtonProps, trapTab } from "../src/a11y";
import { pollGuard, shouldPoll, visibleTicker, type IntervalTimers, type VisibilitySource } from "../src/usePolledData";
import { acceptedToast, orderStatusLabel } from "../src/magmaView";
import { WRITE_MODE_HINT, nodeErrorHint } from "../src/statusNotes";
import { PresetPreview, StatusLine } from "../src/components/AutopilotPanel";
import { InfoTip, infoTipKeyDown } from "../src/components/InfoTip";
import { pauseAllAutomation } from "../src/components/SellingSwitch";
import { dashStaleText } from "../src/components/Overview";
import type { ConfirmOpts } from "../src/components/Overlay";
import type { AreaStatus, AutopilotBounds, AutopilotConfig, DashboardData, MagmaV2Report, MyOffer, NumberBounds } from "../src/types";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const iso = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();

const config = (o: Partial<AutopilotConfig> = {}): AutopilotConfig =>
  ({
    enabled: false,
    intervalMinutes: 30,
    cooldownMinutes: 360,
    maxChangesPerRun: 5,
    policy: { minPpm: 25, maxPpm: 1000, neutralPpm: 80, protectPpm: 350, baseFeeMsat: 0, step: 10, minChangePpm: 25, safetyMargin: 1.15, noFlowRatchetSteps: 3, exploreLowerModifier: 0.85 },
    feeFloorAboveMax: false,
    rebalanceEnabled: false,
    rebalancePolicy: { econRatio: 0.8, minNetProfitSats: 100, maxPaybackDays: 21, maxAmountSats: 2_000_000 },
    maxRebalancesPerRun: 2,
    rebalanceCooldownMinutes: 720,
    rebalanceHourStart: 0,
    rebalanceHourEnd: 24,
    rebalanceDailyBudgetSats: 10_000,
    channelEnabled: false,
    channelReserveSats: 50_000,
    channelSizeSats: 0,
    channelCooldownMinutes: 1440,
    channelMaxFeeRate: 20,
    sellEnabled: false,
    sellMaxDeploySats: 2_000_000,
    sellReserveSats: 50_000,
    sellMaxChannelSats: 2_000_000,
    sellAutoClose: false,
    sellAutoRelist: false,
    sellAutoReprice: true,
    sellAutoSize: true,
    sellPricingMode: "balanced",
    maxHtlcEnabled: false,
    ...o,
  }) as AutopilotConfig;

// ── the per-area status (D16) ────────────────────────────────────────────────

test("an area's status line: a wait or a deferral is amber information — only an error is red — and a standing decision reads '×N since'", () => {
  const waiting: AreaStatus = { state: "waiting", text: "outside the rebalance hours", at: iso(3), since: "2026-10-22T08:00:00.000Z", repeats: 48 };
  const v = areaStatusView(waiting, NOW);
  assert.deepEqual([v?.tone, v?.chip, v?.when], ["wait", "waiting", "3m ago · ×48 since 08:00 UTC"]);
  assert.equal(areaStatusView({ state: "deferred", text: "left for Magma", at: iso(1) }, NOW)?.tone, "wait");
  assert.equal(areaStatusView({ state: "error", text: "LND didn't answer", at: iso(1) }, NOW)?.tone, "error");
  assert.equal(areaStatusView({ state: "off", text: "auto-rebalance is off", at: null }, NOW)?.when, null);
  // The last error stays in view for a day after a later decision.
  const after: AreaStatus = { state: "idle", text: "no fee needed changing", at: iso(1), lastError: { at: iso(120), text: "the fees stage failed: timeout" } };
  assert.equal(areaStatusView(after, NOW)?.lastError, "last error 2h ago: the fees stage failed: timeout");
  assert.equal(areaStatusView({ ...after, lastError: { at: iso(25 * 60), text: "old" } }, NOW)?.lastError, null);
  const html = renderToStaticMarkup(<StatusLine area="rebalance" status={waiting} />);
  assert.match(html, /Auto-rebalance<\/span><span class="ap-state t-wait">waiting<\/span><span class="ap-status-text">outside the rebalance hours<\/span>/);
});

// ── presets: a preview, and a confirmation ───────────────────────────────────

test("a preset says exactly what it changes before it applies — what moves capital first — and never touches selling", () => {
  const c = config();
  const balanced = buildPresets(c).find((p) => p.id === "balanced")!;
  const changes = presetChanges(c, balanced.cfg);
  const by = Object.fromEntries(changes.map((x) => [x.label, x]));
  assert.equal(by["Channel autopilot"]?.capital, "opens channels with your on-chain funds, when an open pays back — not with the coins held for Magma while Liquidity provision is on");
  assert.equal(by["Auto-rebalance"]?.capital, "pays routing fees for refills — up to 10,000 sat a day");
  assert.deepEqual([by["Fee automation"]?.from, by["Fee automation"]?.to], ["off", "on"]);
  assert.ok(!changes.some((x) => /Liquidity|selling|Magma/i.test(x.label)), "presets never switch selling (D9)");
  const lines = presetConfirmLines(c, balanced.cfg)!;
  assert.ok(lines.findIndex((l) => l.startsWith("Fee automation")) > lines.findIndex((l) => l.startsWith("Channel autopilot")), "capital first");
  // Nothing to change: no dialog.
  assert.equal(presetConfirmLines(config({ ...balanced.cfg, policy: { ...c.policy, ...balanced.cfg.policy }, rebalancePolicy: { ...c.rebalancePolicy, ...balanced.cfg.rebalancePolicy } } as Partial<AutopilotConfig>), balanced.cfg), null);
  const html = renderToStaticMarkup(<PresetPreview preset={balanced} config={c} />);
  assert.match(html, /<li class="capital">Channel autopilot: off → <strong>on<\/strong> — opens channels with your on-chain funds/);
  assert.match(html, /Liquidity provision \(Magma selling\) is never changed by a preset\./);
  // The panel asks before it applies (before: save(p.cfg) on the click).
  const panel = readFileSync(new URL("../src/components/AutopilotPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /onClick=\{\(\) => void applyPreset\(p\)\}/);
  assert.doesNotMatch(panel, /onClick=\{\(\) => void save\(p\.cfg/);
});

test("a fresh install reads 'Autopilot off', not 'Custom settings'", () => {
  assert.equal(allAutomationOff(config()), true);
  assert.equal(allAutomationOff(config({ maxHtlcEnabled: true })), false);
});

// ── pause all / resume ───────────────────────────────────────────────────────

const offer = (id: string, status = "ENABLED") => ({ id, status }) as MyOffer;

function pauseDeps(
  over: { answers?: boolean[]; offers?: () => Promise<MyOffer[]>; disable?: (id: string) => Promise<{ status: string }>; cfg?: Partial<AutopilotConfig>; lsp?: boolean } = {},
) {
  const asked: ConfirmOpts[] = [];
  const toasts: string[] = [];
  let paused = 0;
  const answers = over.answers ?? [true];
  return {
    asked,
    toasts,
    paused: () => paused,
    deps: {
      config: config({ enabled: true, channelEnabled: true, ...over.cfg }),
      lspModeOn: over.lsp,
      confirm: async (o: ConfirmOpts) => {
        asked.push(o);
        return answers[asked.length - 1] ?? false;
      },
      offers: over.offers ?? (async () => []),
      disableOffer: over.disable ?? (async () => ({ status: "DISABLED" })),
      toast: (m: string) => void toasts.push(m),
      pause: async () => {
        paused += 1;
        return true;
      },
    },
  };
}

test("'Pause all automation' says what stops and pauses after one yes; with selling on and offers listed it asks about them first (D6)", async () => {
  const plain = pauseDeps();
  assert.equal(await pauseAllAutomation(plain.deps), true);
  assert.equal(plain.paused(), 1);
  assert.ok(isValidElement(plain.asked[0].body));
  const html = renderToStaticMarkup(plain.asked[0].body as ReactElement);
  // Exact about a run in progress: nothing new starts, what is under way finishes.
  assert.match(html, /Channel autopilot — no further channel is opened \(an open already being broadcast completes\)/);
  assert.match(html, /Fee automation — no further fee is written/);
  // Selling on, an offer listed: "disable it too" disables it, then pauses.
  const disabled: string[] = [];
  const selling = pauseDeps({ cfg: { sellEnabled: true }, answers: [true, true], offers: async () => [offer("a"), offer("b", "DISABLED")], disable: async (id) => (disabled.push(id), { status: "DISABLED" }) });
  assert.equal(await pauseAllAutomation(selling.deps), true);
  assert.deepEqual(disabled, ["a"]);
  assert.equal(selling.paused(), 1);
  // An offer that can't be disabled: not paused with it listed, and said.
  const stuck = pauseDeps({ cfg: { sellEnabled: true }, answers: [true, true], offers: async () => [offer("a")], disable: async () => ({ status: "ENABLED" }) });
  assert.equal(await pauseAllAutomation(stuck.deps), false);
  assert.equal(stuck.paused(), 0);
  assert.match(stuck.toasts[0], /^Not paused: offer a… could not be disabled/);
  // Keep them listed: only after saying what that means.
  const keep = pauseDeps({ cfg: { sellEnabled: true }, answers: [true, false, true], offers: async () => [offer("a")] });
  assert.equal(await pauseAllAutomation(keep.deps), true);
  assert.equal(keep.asked[2].title, "Pause with your offers still listed?");
  // No to the first question: nothing happens.
  const no = pauseDeps({ answers: [false] });
  assert.equal(await pauseAllAutomation(no.deps), false);
  assert.equal(no.paused(), 0);
});

test("resume switches back on what was on — selling excepted, with the reason", () => {
  assert.deepEqual(pauseLines(config()), []);
  const r = resumeLines(["enabled", "channelEnabled", "sellEnabled"]);
  assert.deepEqual(r.lines, ["Fee automation", "Channel autopilot"]);
  assert.match(r.sellingNote ?? "", /^Liquidity provision was on too: it stays off — switch it on again on Autopilot → Magma/);
  assert.equal(resumeLines(["enabled"]).sellingNote, null);
});

// Review of P7, round 2: no test asked the offers question's other branch —
// without its confirmation the flow even threw on `listed.length`.
test("'Pause all automation' when the offers can't be read: it asks before pausing with one perhaps still listed — no pauses nothing, yes pauses", async () => {
  const unreadable = () => Promise.reject(new Error("Amboss unreachable"));
  const no = pauseDeps({ cfg: { sellEnabled: true }, answers: [true, false], offers: unreadable });
  assert.equal(await pauseAllAutomation(no.deps), false);
  assert.equal(no.paused(), 0, "not paused");
  assert.equal(no.asked.length, 2);
  assert.deepEqual([no.asked[1].title, no.asked[1].confirmLabel, no.asked[1].danger], ["Your Magma offers", "Pause anyway", true]);
  assert.match(
    no.asked[1].message ?? "",
    /^Your offers could not be read from Amboss right now\. If one is still listed, its new orders wait for your decision on Market → Orders — and Amboss counts an order nobody decides against your seller score\. Pause anyway\?$/,
  );
  const yes = pauseDeps({ cfg: { sellEnabled: true }, answers: [true, true], offers: unreadable });
  assert.equal(await pauseAllAutomation(yes.deps), true);
  assert.equal(yes.paused(), 1);
  assert.deepEqual(yes.toasts, []);
});

// ── the Overview: honest numbers ─────────────────────────────────────────────

const ap = (o: Partial<DashboardData["autopilot"]> = {}): DashboardData["autopilot"] => ({
  fees: true,
  rebalance: false,
  channel: false,
  sell: false,
  maxHtlc: false,
  lastRunAt: iso(3),
  lastRun: { applied: 0, attempted: 0, failed: 0, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0, errors: [] },
  lastActionAt: iso(3 * 24 * 60),
  intervalMinutes: 30,
  pausedAt: null,
  lspModeOn: false,
  status: {},
  magmaRefusals: 0,
  magmaRefusalReason: null,
  ...o,
});

test("the digest pairs the last run's time with THAT run's counts, counts failures, and says the last change apart", () => {
  const items = autopilotDigest(ap(), NOW);
  // Before: "Autopilot 3m ago: 2 fees adjusted" — counts from the run three days ago.
  assert.equal(items[0].text, "Autopilot 3m ago: nothing needed changing — next run in ~27 min");
  assert.equal(items[1].text, "Last change by the autopilot 3d ago");
  const failed = autopilotDigest(ap({ lastRun: { applied: 0, attempted: 2, failed: 2, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0, errors: [] } }), NOW);
  // Before: "nothing needed changing" for a run whose every update failed.
  assert.equal(failed[0].text, "Autopilot 3m ago: nothing applied · 2 failed — next run in ~27 min");
  assert.equal(failed[0].warn, true);
  const did = autopilotDigest(ap({ lastActionAt: iso(3), lastRun: { applied: 3, attempted: 3, failed: 0, feeChanges: 2, rebalances: 1, sells: 0, opens: 0, maxHtlc: 0, errors: [] } }), NOW);
  assert.deepEqual(did.map((i) => i.text), ["Autopilot 3m ago: 2 fees adjusted · 1 rebalance — next run in ~27 min"]);
  // An area that is blocked or failing is on the Overview too.
  const blocked = autopilotDigest(ap({ sell: true, status: { magma: { state: "blocked", text: "no Amboss API key — connect one in Settings", at: null } } }), NOW);
  assert.ok(blocked.some((i) => i.text === "Liquidity provision blocked: no Amboss API key — connect one in Settings" && i.warn && i.sub === "magma"));
  // Paused: said first — without promising more than the pause does.
  assert.equal(autopilotDigest(ap({ fees: false, pausedAt: iso(120) }), NOW)[0].text, "All automation paused 2h ago — nothing new starts on its own");
  // An area that is off is never listed as blocked (a read-only node).
  assert.ok(!autopilotDigest(ap({ sell: false, status: { magma: { state: "blocked", text: "write mode is off", at: null } } }), NOW).some((i) => i.key === "ap-magma"));
  // A summary not of this run (from before an upgrade): no counts claimed.
  assert.match(autopilotDigest(ap({ lastRun: null }), NOW)[0].text, /^Autopilot 3m ago: ran — next run/);
});

// Review of P7, round 2: LSP mode (Settings) is no switch of the autopilot's
// — the pause leaves it on, answering wallet orders and opening their
// channels — while the copy said "every automation off at once" and
// "nothing new starts on its own". And "Resume brings back what was on" left
// out that selling stays off.
test("LSP mode is not part of the pause: with it on, the dialog, the banner, the hint, the note and the Overview say so — and 'selling excepted' is said beside the button and in the note", async () => {
  const plain = pauseDeps();
  await pauseAllAutomation(plain.deps);
  assert.doesNotMatch(renderToStaticMarkup(plain.asked[0].body as ReactElement), /LSP mode/);
  const lsp = pauseDeps({ lsp: true });
  assert.equal(await pauseAllAutomation(lsp.deps), true, "it still pauses");
  const html = renderToStaticMarkup(lsp.asked[0].body as ReactElement);
  assert.ok(html.includes(`<p class="modal-msg">${LSP_NOT_PAUSED}</p>`), html);
  assert.match(LSP_NOT_PAUSED, /^LSP mode \(Settings\) is not paused: it keeps answering wallet orders and opens their channels from your on-chain funds once they are paid/);
  // Where the pause is shown.
  assert.equal(pausedText(), "nothing new starts on its own");
  assert.equal(pausedText(true), "the autopilot starts nothing new, but LSP mode (Settings) is still on: it keeps answering wallet orders and opening their channels");
  assert.equal(
    autopilotDigest(ap({ fees: false, pausedAt: iso(120), lspModeOn: true }), NOW)[0].text,
    "All automation paused 2h ago — the autopilot starts nothing new, but LSP mode (Settings) is still on: it keeps answering wallet orders and opening their channels",
  );
  // Beside the button, and the note once paused: selling stays off on Resume.
  assert.equal(pauseHint(), "every automation off at once — Resume brings back what was on, selling excepted");
  assert.equal(pauseHint(true), "every autopilot automation off at once (LSP mode, in Settings, stays on) — Resume brings back what was on, selling excepted");
  assert.equal(pausedToast(), "All automation paused — Resume brings back what was on, selling excepted");
  assert.equal(pausedToast(true), "All automation paused — Resume brings back what was on, selling excepted. LSP mode (Settings) is still on");
  // The panel says them where the pause is: the dialog, the banner, the hint, the note.
  const panel = readFileSync(new URL("../src/components/AutopilotPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /const lspModeOn = server\.lspModeOn \?\? false;/);
  assert.match(panel, /pauseAllAutomation\(\{\n\s+config,\n\s+lspModeOn,/);
  assert.match(panel, /All automation paused \{timeAgo\(paused\.at\)\} — \{pausedText\(lspModeOn\)\}\./);
  assert.match(panel, /<span className="muted">\{pauseHint\(lspModeOn\)\}<\/span>/);
  assert.match(panel, /toast\(pausedToast\(next\.lspModeOn \?\? false\), "success"\)/);
  assert.doesNotMatch(panel, /Resume brings back what was on"/);
});

// Review of P7: from the second identical failure on, a stage's failure was
// left out of the pass's counts (no news for the history) — and the Overview
// read "Autopilot 3m ago: nothing needed changing" right above "Fee
// automation failed: …", the tile "0 applied", "Run once now" "nothing
// needed doing".
test("a stage failing the same way run after run is a failure of every one of those runs: the digest, the tile and 'Run once now' say it", () => {
  const repeated = ap({
    lastRun: { applied: 0, attempted: 1, failed: 1, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0, errors: ["fees"] },
    status: { fees: { state: "error", text: "the fees stage failed: LND unreachable", at: iso(3) } },
  });
  const items = autopilotDigest(repeated, NOW);
  assert.equal(items[0].text, "Autopilot 3m ago: nothing applied · the fees stage failed — next run in ~27 min");
  assert.equal(items[0].warn, true);
  // A summary counting the stage under `errors` only (the reviewer's probe):
  // still a failure, never "nothing needed changing".
  const probe = autopilotDigest(
    ap({ lastRun: { applied: 0, attempted: 0, failed: 0, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0, errors: ["fees"] } }),
    NOW,
  );
  assert.equal(probe[0].text, "Autopilot 3m ago: nothing applied · the fees stage failed — next run in ~27 min");
  assert.equal(probe[0].warn, true);
  // Items that failed and a stage: both said, each once.
  const both = autopilotDigest(
    ap({ lastRun: { applied: 1, attempted: 4, failed: 3, feeChanges: 1, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0, errors: ["max_htlc"] } }),
    NOW,
  );
  assert.equal(both[0].text, "Autopilot 3m ago: 1 fee adjusted · 2 failed · the max_htlc stage failed — next run in ~27 min");
  // The tile's foot.
  assert.equal(autopilotTileFoot(repeated, NOW), "Last run 3m ago · 0 applied, the fees stage failed");
  assert.equal(autopilotTileFoot(ap(), NOW), "Last run 3m ago · 0 applied");
  assert.equal(autopilotTileFoot(ap({ lastRun: { applied: 2, attempted: 3, failed: 1, feeChanges: 2, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0, errors: [] } }), NOW), "Last run 3m ago · 2 applied, 1 failed");
  assert.equal(autopilotTileFoot(ap({ lastRunAt: null }), NOW), "Has not run yet");
  const overview = readFileSync(new URL("../src/components/Overview.tsx", import.meta.url), "utf8");
  assert.match(overview, /<div className="ap-foot">\{autopilotTileFoot\(a\)\}<\/div>/);
  // "Run once now" on such a pass (the server returns every stage that
  // threw on the run itself).
  assert.equal(
    runResultLine({ applied: 0, failed: 1, attempted: 1, errors: [{ stage: "fees", error: "LND unreachable" }] }),
    "Run finished: nothing applied — the fees stage failed: LND unreachable.",
  );
  assert.equal(runResultLine({ applied: 0, failed: 0, attempted: 0, errors: [{ stage: "fees", error: "LND unreachable" }] }), "Run finished: nothing applied — the fees stage failed: LND unreachable.");
});

// Review of P7 (final): an item failing the same way as in the last run (a
// fee LND refused again, the wallet failing an open again) was dropped from
// the pass's counts — the server now counts it (autopilotStatus.test.ts,
// PROBE-DIGEST-QUIET-REPEAT): these are the words for those counts.
test("PROBE-DIGEST-QUIET-REPEAT: a run whose one fee update LND refused again reads 'nothing applied · 1 failed' — never 'nothing needed changing' — beside the fee area's failure; 'Run once now' never says 'nothing needed doing'", () => {
  const repeated = ap({
    lastRun: { applied: 0, attempted: 1, failed: 1, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 0, errors: [] },
    status: { fees: { state: "error", text: "1 update LND refused (LND refused the update: invalid policy — not retried for 6 h)", at: iso(3) } },
  });
  const items = autopilotDigest(repeated, NOW);
  assert.deepEqual(
    items.filter((i) => i.key === "ap" || i.key === "ap-fees").map((i) => [i.text, i.warn]),
    [
      ["Autopilot 3m ago: nothing applied · 1 failed — next run in ~27 min", true],
      ["Fee automation failed: 1 update LND refused (LND refused the update: invalid policy — not retried for 6 h)", true],
    ],
  );
  assert.equal(autopilotTileFoot(repeated, NOW), "Last run 3m ago · 0 applied, 1 failed");
  assert.equal(runResultLine({ applied: 0, failed: 1, attempted: 1 }), "Run finished: 0 applied, 1 failed of 1.");
});

// Review of P7 (final): the digest left out Advertise routable size — on
// alone, its runs and its failures never reached the Overview.
test("the digest counts Advertise routable size (max_htlc) as an automation: on alone, its run is said — and its area's failure too", () => {
  const only = ap({ fees: false, maxHtlc: true, lastRun: { applied: 2, attempted: 2, failed: 0, feeChanges: 0, rebalances: 0, sells: 0, opens: 0, maxHtlc: 2, errors: [] } });
  // Before: nothing at all — anyOn read fees, rebalancing, channels and selling only.
  assert.equal(autopilotDigest(only, NOW)[0]?.text, "Autopilot 3m ago: 2 max-HTLC updates — next run in ~27 min");
  const failing = autopilotDigest(ap({ fees: false, maxHtlc: true, status: { maxHtlc: { state: "error", text: "the max_htlc stage failed: transport is closing", at: iso(3) } } }), NOW);
  assert.ok(failing.some((i) => i.key === "ap-maxHtlc" && i.text === "Routable size failed: the max_htlc stage failed: transport is closing" && i.warn && i.sub === "fees"));
  // Off: nothing of it is said.
  assert.equal(autopilotDigest(ap({ fees: false, maxHtlc: false, status: { maxHtlc: { state: "error", text: "x", at: null } } }), NOW).length, 0);
});

test("an area switched on that hasn't decided anything yet reads 'not run yet' — not 'nothing to do', which nobody checked", () => {
  assert.deepEqual(STATE_CHIP.not_run, { label: "not run yet", tone: "info" });
  const v = areaStatusView({ state: "not_run", text: "not run yet since it was switched on — the next run decides", at: null }, NOW);
  assert.deepEqual([v?.chip, v?.tone, v?.when], ["not run yet", "info", null]);
  // The Overview tile shows the chip, not the text that repeats it.
  const overview = readFileSync(new URL("../src/components/Overview.tsx", import.meta.url), "utf8");
  assert.match(overview, /s\.state !== "idle" && s\.state !== "not_run" \? <span className="ap-row-why">/);
});

test("'Run once now' says what happened — never a bare '0 applied, 0 failed of 0 attempted'", () => {
  assert.equal(runResultLine({ applied: 0, failed: 0, attempted: 0 }), "Run finished: nothing needed doing — each area's decision is below.");
  assert.equal(runResultLine({ applied: 1, failed: 1, attempted: 2, errors: [{ stage: "max_htlc", error: "timeout" }] }), "Run finished: 1 applied, 1 failed of 2 (max_htlc stage failed: timeout).");
});

test("the Overview says when its figures couldn't be loaded, and from when the ones shown are", () => {
  assert.match(dashStaleText("Bad Gateway", NOW), /^Couldn't refresh the overview \(Bad Gateway\) — the figures below are from /);
  assert.equal(dashStaleText("Bad Gateway", null), "Couldn't load the overview's figures (Bad Gateway).");
});

// ── the settings form: one save model, checked before it is sent (D17) ────────

const int = (min: number, max: number): NumberBounds => ({ min, max, integer: true });
const bounds: AutopilotBounds = {
  config: { intervalMinutes: int(5, 35_791), channelSizeSats: int(0, 1_000_000_000), rebalanceDailyBudgetSats: { ...int(1, 10_000_000), nullable: true } } as AutopilotBounds["config"],
  policy: { minPpm: int(0, 50_000), maxPpm: int(1, 50_000), neutralPpm: int(0, 50_000) } as AutopilotBounds["policy"],
  rebalancePolicy: { econRatio: { min: 0.05, max: 1, integer: false } } as AutopilotBounds["rebalancePolicy"],
  rules: { channelSizeMinSats: 20_000 },
};
const labels = { intervalMinutes: "Run every (min)", "policy.minPpm": "Min ppm", "policy.maxPpm": "Max ppm", "policy.neutralPpm": "Neutral ppm", channelSizeSats: "Channel size", rebalanceDailyBudgetSats: "Daily fee budget" };
const draft = (o: Partial<Draft>): Draft => ({ ...EMPTY_DRAFT, ...o });

test("the settings draft: a blank or out-of-range field is reported at the field and never sent (never as 0); what equals the saved value isn't a change", () => {
  const c = config();
  const blank = checkDraft(draft({ nums: { intervalMinutes: "" } }), c, bounds, labels);
  assert.deepEqual(blank.patch, {});
  assert.equal(blank.fieldErrors.intervalMinutes, "Run every (min): enter a value (5–35791)");
  const fast = checkDraft(draft({ nums: { intervalMinutes: "1" } }), c, bounds, labels);
  assert.equal(fast.fieldErrors.intervalMinutes, "Run every (min): must be 5–35791");
  const same = checkDraft(draft({ nums: { intervalMinutes: "30" } }), c, bounds, labels);
  assert.deepEqual([same.patch, same.changes], [{}, []]);
  const ok = checkDraft(draft({ nums: { intervalMinutes: "45" }, flags: { sellAutoReprice: false }, pricingMode: "premium" }), c, bounds, labels);
  assert.deepEqual(ok.patch, { intervalMinutes: 45, sellAutoReprice: false, sellPricingMode: "premium" });
  assert.deepEqual(ok.changes, ["Run every (min)", "Auto-price off", "Pricing level: premium"]);
  assert.deepEqual(ok.errors, []);
});

test("the settings draft checks the rules across fields the server checks: min ≤ max ppm, neutral between them, a channel size of 0 or ≥ 20,000", () => {
  const c = config();
  const inverted = checkDraft(draft({ nums: { "policy.minPpm": "2000" } }), c, bounds, labels);
  assert.deepEqual(inverted.errors, ["Min ppm (2000) must not be above Max ppm (1000)"]);
  assert.equal(inverted.fieldErrors["policy.minPpm"], "Min ppm (2000) must not be above Max ppm (1000)");
  // Raising both together is fine — one Save, not one field at a time.
  assert.deepEqual(checkDraft(draft({ nums: { "policy.minPpm": "2000", "policy.maxPpm": "3000", "policy.neutralPpm": "2500" } }), c, bounds, labels).errors, []);
  assert.deepEqual(checkDraft(draft({ nums: { "policy.neutralPpm": "5" } }), c, bounds, labels).errors, ["Neutral ppm (5) must lie between Min ppm (25) and Max ppm (1000)"]);
  assert.deepEqual(checkDraft(draft({ nums: { channelSizeSats: "15000" } }), c, bounds, labels).errors, ["Channel size: 0 (auto) or at least 20,000 sat"]);
  assert.deepEqual(checkDraft(draft({ nums: { channelSizeSats: "0" } }), config({ channelSizeSats: 2_000_000 }), bounds, labels).patch, { channelSizeSats: 0 });
});

test("the rebalance budget's 'no daily limit' is an explicit choice in the draft — a cleared field never means unlimited", () => {
  assert.deepEqual(checkDraft(draft({ noBudgetLimit: true }), config(), bounds, labels).patch, { rebalanceDailyBudgetSats: null });
  const from = config({ rebalanceDailyBudgetSats: null });
  assert.deepEqual(checkDraft(draft({ noBudgetLimit: false, nums: { rebalanceDailyBudgetSats: "5000" } }), from, bounds, labels).patch, { rebalanceDailyBudgetSats: 5000 });
  assert.deepEqual(checkDraft(draft({ noBudgetLimit: false }), from, bounds, labels).errors, ['Daily fee budget: enter a daily limit, or tick "No daily limit"']);
  assert.deepEqual(checkDraft(draft({ nums: { rebalanceDailyBudgetSats: "" } }), config(), bounds, labels).errors, ["Daily fee budget: enter a value (1–10000000)"]);
});

test("unsaved settings outlive the panel (a tab switch unmounts it) and the tab is told", () => {
  const seen: boolean[] = [];
  const stop = draftStore.subscribe((d) => seen.push(draftIsEmpty(d)));
  draftStore.set(draft({ nums: { intervalMinutes: "45" } }));
  // The panel is gone and back: it starts from the kept draft.
  assert.deepEqual(draftStore.get().nums, { intervalMinutes: "45" });
  draftStore.set(EMPTY_DRAFT);
  stop();
  assert.deepEqual(seen, [false, true]);
  // The panel reads it on mount; the App marks the tab.
  const panel = readFileSync(new URL("../src/components/AutopilotPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /useState<Draft>\(\(\) => draftStore\.get\(\)\)/);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /draftStore\.subscribe\(\(d\) => setApUnsaved\(!draftIsEmpty\(d\)\)\)/);
});

// ── polling: visible tabs only, one Magma report for every view ──────────────

test("polling waits while the tab is hidden and while the last request is still under way", () => {
  assert.equal(shouldPoll(false, false), true);
  assert.equal(shouldPoll(true, false), false);
  assert.equal(shouldPoll(false, true), false);
});

/** A document whose visibility a test sets, and an interval a test fires. */
function fakePage() {
  const listeners = new Set<() => void>();
  const doc: VisibilitySource & { visibilityState: string } = {
    visibilityState: "visible",
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  let tick: (() => void) | null = null;
  let cleared = false;
  const timers: IntervalTimers = {
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval: () => void (cleared = true),
  };
  return {
    doc,
    timers,
    fire: () => tick?.(),
    show: (state: "visible" | "hidden") => {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
    listeners,
    cleared: () => cleared,
  };
}

test("the poll ticker skips a tick while the tab is hidden, catches up once on coming back, and stops cleanly", () => {
  const page = fakePage();
  let ticks = 0;
  const stop = visibleTicker(() => (ticks += 1), 15_000, page.doc, page.timers);
  page.fire();
  assert.equal(ticks, 1, "visible: it ticks");
  page.show("hidden");
  page.fire();
  page.fire();
  assert.equal(ticks, 1, "hidden: no request — a background tab polled all day");
  page.show("visible");
  assert.equal(ticks, 2, "back: one catch-up tick at once, for the two it missed");
  page.show("visible");
  assert.equal(ticks, 2, "no second catch-up without a missed tick");
  page.show("hidden");
  page.show("visible");
  assert.equal(ticks, 2, "hidden and back between ticks: nothing was missed");
  stop();
  assert.equal(page.cleared(), true);
  assert.equal(page.listeners.size, 0);
});

test("one poll at a time: a second load while the first is under way calls nothing — a forced one waits for it — and a hidden page polls only when forced", async () => {
  let calls = 0;
  const releases: ((v: string) => void)[] = [];
  let hidden = false;
  const seen: string[] = [];
  const load = pollGuard(
    () => {
      calls += 1;
      return new Promise<string>((r) => releases.push(r));
    },
    () => hidden,
    { loaded: (v) => void seen.push(`ok:${v}`), failed: (e) => void seen.push(`err:${String(e)}`), settled: () => void seen.push("settled") },
  );
  const first = load();
  assert.equal(await load(), false, "the earlier request is still under way");
  const forced = load(true);
  assert.equal(calls, 1, "no pile-up on a slow node: the forced load waits for the one under way");
  releases[0]("a");
  assert.equal(await first, true);
  releases[1]("b");
  assert.equal(await forced, true, "it ran right after");
  assert.deepEqual(seen, ["ok:a", "settled", "ok:b", "settled"]);
  hidden = true;
  assert.equal(await load(), false, "hidden: no poll");
  assert.equal(calls, 2);
  const tryAgain = load(true);
  releases[2]("c");
  assert.equal(await tryAgain, true, "the first load and Try again run hidden or not");
  assert.equal(calls, 3);
  // A failure goes to `failed` (the view keeps the data it had), and the
  // next poll can start.
  hidden = false;
  const failing = pollGuard(() => Promise.reject(new Error("502")), () => false, {
    loaded: () => undefined,
    failed: (e) => void seen.push(`err:${(e as Error).message}`),
    settled: () => undefined,
  });
  assert.equal(await failing(), true);
  assert.equal(await failing(), true, "not stuck in flight after a failure");
  assert.deepEqual(seen.slice(-2), ["err:502", "err:502"]);
});

// Review of P7 (final): pollGuard dropped a forced load that came while a
// poll was under way — AlertsBar's Dismiss refreshes with one, and the poll
// in flight, answered from before the dismiss, kept the alert on screen for
// another 30 s.
test("a forced load during a poll in flight causes exactly one more call, right after it settles — however many came meanwhile; an ordinary poll during it none", async () => {
  let calls = 0;
  const releases: ((v: string) => void)[] = [];
  const seen: string[] = [];
  const load = pollGuard(
    () => {
      calls += 1;
      return new Promise<string>((r) => releases.push(r));
    },
    () => false,
    { loaded: (v) => void seen.push(v), failed: () => undefined, settled: () => undefined },
  );
  const poll = load(); // the 30 s poll, answering with the alert still listed
  const dismiss = load(true); // Dismiss → refresh
  const again = load(true);
  void load(); // the next tick: still one in flight
  assert.equal(calls, 1);
  releases[0]("before the dismiss");
  await poll;
  assert.equal(calls, 2, "one more call — after the one under way");
  releases[1]("after the dismiss");
  assert.deepEqual([await dismiss, await again], [true, true]);
  assert.equal(calls, 2, "exactly one: the two forced loads share it");
  assert.deepEqual(seen, ["before the dismiss", "after the dismiss"], "the view ends on the answer from after the dismiss");
  // Nothing owed: the next poll is an ordinary one.
  const next = load();
  releases[2]("later");
  assert.equal(await next, true);
  assert.equal(calls, 3);
});
test("Market → Sell keeps the last market picture when a refresh fails — with the error, and from when — instead of blanking it", () => {
  const report = { sell: {} } as MagmaV2Report;
  const at = Date.parse("2026-10-22T11:58:00.000Z");
  const loaded = reportLoaded(report, at);
  const failed = reportRefreshFailed(loaded, new Error("Bad Gateway"));
  // Before: the report was dropped — the whole market card went blank.
  assert.equal(failed.report, report);
  assert.equal(failed.at, at);
  assert.match(reportErrorText(failed) ?? "", /^Couldn't refresh the market picture \(Bad Gateway\) — what follows is from /);
  assert.equal(reportErrorText(loaded), null);
  // Nothing loaded yet: said as such.
  assert.equal(reportErrorText(reportRefreshFailed(EMPTY_REPORT_VIEW, "502")), "The market picture couldn't be worked out right now: 502");
  // A later refresh that works clears the error.
  assert.equal(reportLoaded(report, at + 60_000).error, null);
  // After its own write, the view reads afresh — not the shared copy that
  // still shows the offer as it was.
  const sell = readFileSync(new URL("../src/components/MarketSell.tsx", import.meta.url), "utf8");
  assert.match(sell, /const reload = async \(\) => \{\n\s+forgetMagmaReport\(\);\n\s+await load\(\);/);
});

// Review of P7 (final): "as of" stamped when the view received the shared
// report — with the server's 60 s memo and the views' 60 s cache, up to
// about two minutes after it was read.
test("Market → Sell's 'as of' is when the report was READ on the server — not when this view got its shared copy", () => {
  const readAt = Date.parse("2026-10-22T11:58:00.000Z");
  const gotAt = readAt + 110_000; // a copy shared by the server, then by another view
  const report = { generatedAt: new Date(readAt).toISOString(), sell: {} } as MagmaV2Report;
  const view = reportLoaded(report, gotAt);
  assert.equal(view.at, readAt, "before: the time the view got it");
  // So does the failed refresh's "what follows is from …".
  const failed = reportRefreshFailed(view, new Error("Bad Gateway"));
  const time = new Date(readAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  assert.equal(reportErrorText(failed), `Couldn't refresh the market picture (Bad Gateway) — what follows is from ${time}.`);
  // A report without the time (an older server): as of when it came.
  assert.equal(reportLoaded({ sell: {} } as MagmaV2Report, gotAt).at, gotAt);
  const sell = readFileSync(new URL("../src/components/MarketSell.tsx", import.meta.url), "utf8");
  assert.match(sell, /as of \$?\{new Date\(recAt\)\.toLocaleTimeString/);
  assert.match(sell, /const takeReport = \(r: MagmaV2Report\) => setRecView\(reportLoaded\(r\)\);/);
});

test("the Magma report is fetched once and shared — a failed fetch is not kept, and a write makes the next view fetch afresh", async () => {
  forgetMagmaReport();
  let fetches = 0;
  const report = {} as MagmaV2Report;
  const fetch = async () => {
    fetches += 1;
    return report;
  };
  const [a, b] = await Promise.all([sharedMagmaReport(60_000, fetch), sharedMagmaReport(60_000, fetch)]);
  await sharedMagmaReport(60_000, fetch);
  assert.equal(fetches, 1, "seven views asked; one fetch");
  assert.equal(a, b);
  forgetMagmaReport();
  await sharedMagmaReport(60_000, fetch);
  assert.equal(fetches, 2);
  forgetMagmaReport();
  const failing = () => Promise.reject(new Error("502"));
  await assert.rejects(sharedMagmaReport(60_000, failing));
  await sharedMagmaReport(60_000, fetch);
  assert.equal(fetches, 3, "the failure was not kept");
  forgetMagmaReport();
  // Market → Sell refreshes it while visible (its "waiting on you" banner went
  // stale) and says when it couldn't be worked out — no silent blank.
  const sell = readFileSync(new URL("../src/components/MarketSell.tsx", import.meta.url), "utf8");
  assert.match(sell, /useVisibleInterval\(\(\) => void sharedMagmaReport\(\)\.then\(takeReport\)\.catch\(reportFailed\), 60_000\)/);
  assert.match(sell, /\{recView\.error \? <p className="banner error">\{reportErrorText\(recView\)\}<\/p> : null\}/);
  // Every view that showed it fetches through the cache now.
  for (const f of ["AnalyticsPanel", "AutopilotPanel", "CloseCandidatesPanel", "MarketOrders", "MarketSell"]) {
    const src = readFileSync(new URL(`../src/components/${f}.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /api\.magmaRecommendations\(\)/, f);
    assert.match(src, /sharedMagmaReport\(\)/, f);
  }
});

// Review of P7, round 2: a cache that never expired passed every test — and
// Market → Sell's minute refresh would never have fetched again.
test("the shared Magma report is fetched afresh once it is older than its max age — a minute, as every view asks for it", async (t) => {
  forgetMagmaReport();
  let fetches = 0;
  const fetch = async () => {
    fetches += 1;
    return {} as MagmaV2Report;
  };
  const realNow = Date.now;
  let skew = 0;
  t.mock.method(Date, "now", () => realNow() + skew);
  await sharedMagmaReport(undefined, fetch); // the default max age, as the views use it
  skew = MAGMA_REPORT_MAX_AGE_MS - 1_000;
  await sharedMagmaReport(undefined, fetch);
  assert.equal(fetches, 1, "reused within the minute");
  skew = MAGMA_REPORT_MAX_AGE_MS + 1;
  await sharedMagmaReport(undefined, fetch);
  assert.equal(fetches, 2, "fetched afresh after it");
  assert.equal(MAGMA_REPORT_MAX_AGE_MS, 60_000);
  forgetMagmaReport();
});

// ── keyboard, touch and copy ──────────────────────────────────────────────────

test("an expandable row opens from a real button in its caret cell — focusable, Enter and Space natively, saying whether it is open — and the row stays a table row", () => {
  let toggled = 0;
  let stopped = 0;
  const props = caretButtonProps(false, () => (toggled += 1), "Details: ACINQ");
  assert.deepEqual([props.type, props.className, props["aria-expanded"], props["aria-label"]], ["button", "row-caret", false, "Details: ACINQ"]);
  // Its click must not reach the row too (the row's click would toggle back).
  props.onClick({ stopPropagation: () => (stopped += 1) });
  assert.deepEqual([toggled, stopped], [1, 1]);
  const html = renderToStaticMarkup(
    <table>
      <tbody>
        <tr className="feerec-row" onClick={() => undefined}>
          <td className="feerec-caret">
            <button {...caretButtonProps(true, () => undefined, "Details: ACINQ")}>▾</button>
          </td>
          <td>
            <button className="row-btn">Run…</button>
          </td>
        </tr>
      </tbody>
    </table>,
  );
  assert.match(html, /<td class="feerec-caret"><button type="button" class="row-caret" aria-expanded="true" aria-label="Details: ACINQ">▾<\/button><\/td>/);
  // Review of P7: role="button" on the <tr> made the buttons and inputs in it
  // presentational children (axe: nested-interactive) and dropped its row role.
  assert.match(html, /<tr class="feerec-row">/);
  for (const f of ["FeeRecommendations", "RebalanceRecommendations", "SuggestionsPanel", "CloseCandidatesPanel"]) {
    const src = readFileSync(new URL(`../src/components/${f}.tsx`, import.meta.url), "utf8");
    assert.match(src, /<tr className=\{?[`"]feerec-row[^>]*onClick=\{\(\) => toggle\(/, f);
    assert.match(src, /<td className="feerec-caret">\s*<button \{\.\.\.caretButtonProps\(isOpen, \(\) => toggle\(/, f);
    assert.doesNotMatch(src, /rowToggleProps|role="button"/, f);
  }
  // The Run action is in the rebalance row itself, not only in the opened row.
  const reb = readFileSync(new URL("../src/components/RebalanceRecommendations.tsx", import.meta.url), "utf8");
  assert.match(reb, /\{running === r\.channelId \? "Running…" : "Run…"\}/);
});

test("a dialog keeps Tab inside it — wrapping around — and the confirm and close dialogs use the keyboard handling (Esc, focus in and back)", () => {
  assert.equal(trapTab(2, 3, false), 0, "Tab on the last control: back to the first");
  assert.equal(trapTab(0, 3, true), 2, "Shift+Tab on the first: to the last");
  assert.equal(trapTab(0, 3, false), null, "in between: the browser moves on");
  assert.equal(trapTab(-1, 3, false), 0, "focus outside the dialog: into it");
  assert.equal(trapTab(-1, 0, false), -1);
  for (const f of ["Overlay", "CloseChannelDialog"]) {
    const src = readFileSync(new URL(`../src/components/${f}.tsx`, import.meta.url), "utf8");
    assert.match(src, /useDialogFocus\(dialogRef, /, f);
    assert.match(src, /ref=\{dialogRef\}/, f);
  }
});

test("help that was only a hover tooltip opens on a tap: an (i) button that says whether it is open", () => {
  const html = renderToStaticMarkup(<InfoTip text="what it means" label="About it" />);
  assert.match(html, /<button type="button" class="info-btn" aria-expanded="false" aria-label="About it"/);
  assert.doesNotMatch(html, /what it means/, "closed until asked");
  const score = readFileSync(new URL("../src/components/HealthScore.tsx", import.meta.url), "utf8");
  assert.match(score, /<InfoTip text=\{c\.hint\}/);
  assert.doesNotMatch(score, /title=\{c\.hint\}/);
  const sell = readFileSync(new URL("../src/components/MarketSell.tsx", import.meta.url), "utf8");
  assert.match(sell, /<span className="field-hint">\{f\.hint\}<\/span>/);
  const overview = readFileSync(new URL("../src/components/Overview.tsx", import.meta.url), "utf8");
  assert.match(overview, /<InfoTip text=\{d\.leaseBenchmark\.text\}/);
});

// Review of P7: InfoTip stopped every key from reaching its parents — inside
// a dialog, Esc would no longer close it and Tab would leave its focus trap.
test("the (i) button keeps only the keys it acts on (Enter, Space) from its parent — Esc and Tab go on to a dialog", () => {
  const stopped = (key: string) => {
    let s = false;
    infoTipKeyDown({ key, stopPropagation: () => void (s = true) });
    return s;
  };
  assert.deepEqual(["Enter", " ", "Escape", "Tab", "ArrowDown", "a"].map(stopped), [true, true, false, false, false, false]);
  const src = readFileSync(new URL("../src/components/InfoTip.tsx", import.meta.url), "utf8");
  assert.match(src, /onKeyDown=\{infoTipKeyDown\}/);
});

test("Umbrel users are no longer sent to a .env; write mode is described as what it is; order statuses read as words", () => {
  assert.equal(nodeErrorHint("umbrel"), "Is the Lightning Node app running and fully synced? LightningMate keeps trying every 15 seconds.");
  assert.doesNotMatch(nodeErrorHint("umbrel"), /\.env|LND_SOCKET|macaroon/);
  assert.match(nodeErrorHint("standalone"), /LND_SOCKET, the TLS cert and the macaroon in your settings \(\.env\)/);
  assert.match(nodeErrorHint(undefined), /^Is the Lightning Node app running/);
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /read-only macaroon in your/);
  assert.match(WRITE_MODE_HINT, /LM_ENABLE_WRITE=true and an admin macaroon/);
  const sug = readFileSync(new URL("../src/components/SuggestionsPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sug, /enable writes in the Autopilot tab/);
  assert.equal(orderStatusLabel("WAITING_FOR_SELLER_APPROVAL", "SELL"), "Waiting for you to accept");
  assert.equal(orderStatusLabel("WAITING_FOR_SELLER_APPROVAL", "BUY"), "Waiting for the seller to accept");
  assert.equal(orderStatusLabel("SOMETHING_NEW", "SELL"), "Something new");
  const orders = readFileSync(new URL("../src/components/MarketOrders.tsx", import.meta.url), "utf8");
  assert.match(orders, /\{orderStatusLabel\(o\.status, o\.side, o\.opensItself\)\}/);
});

// Review of P7: "Paid — waiting for you to open the channel" also showed when
// the order lane opens the channel itself. The server says who (opensItself).
test("a paid sale says who opens its channel — the autopilot, or you — and so does the toast after a manual accept", () => {
  assert.equal(orderStatusLabel("WAITING_FOR_CHANNEL_OPEN", "SELL", true), "Paid — the autopilot opens the channel");
  assert.equal(orderStatusLabel("WAITING_FOR_CHANNEL_OPEN", "SELL", false), "Paid — waiting for you to open the channel");
  assert.equal(orderStatusLabel("WAITING_FOR_CHANNEL_OPEN", "SELL"), "Paid — waiting for you to open the channel");
  // A purchase is the seller's to open, whatever the flag.
  assert.equal(orderStatusLabel("WAITING_FOR_CHANNEL_OPEN", "BUY", true), "Paid — waiting for the seller to open the channel");
  assert.equal(acceptedToast(true), "Order accepted — while Liquidity provision is on, the autopilot opens the channel once the buyer has paid.");
  assert.equal(acceptedToast(false), "Order accepted — open the channel once the buyer has paid.");
  const orders = readFileSync(new URL("../src/components/MarketOrders.tsx", import.meta.url), "utf8");
  assert.match(orders, /ui\.toast\(deskDoneToast\(r, acceptedToast\(r\.opensItself === true\)\), "success"\)/);
});

test("no internal engine badges ('v1', 'v2') on the panels; the LN+ tables scroll on a phone like the others", () => {
  for (const f of ["FeeRecommendations", "RebalanceRecommendations", "SuggestionsPanel", "CloseCandidatesPanel"]) {
    const src = readFileSync(new URL(`../src/components/${f}.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /v2-badge">v[12]</, f);
  }
  const lnplus = readFileSync(new URL("../src/components/LnPlusPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(lnplus, /className="table"/);
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(css, /table\.channels, \.fee-table, \.feerec-table, \.table \{\n\s+display: block; overflow-x: auto;/);
});

test("opening and closing channels live together under Channels — the Overview's suggested peers lead there", () => {
  const channels = readFileSync(new URL("../src/components/ChannelsPanel.tsx", import.meta.url), "utf8");
  assert.match(channels, /\{tab\("open", "To open"\)\}/);
  assert.match(channels, /<SuggestionsPanel \/>/);
  const overview = readFileSync(new URL("../src/components/Overview.tsx", import.meta.url), "utf8");
  assert.match(overview, /<SuggestedPeersTile onOpen=\{\(\) => onNavigate\?\.\("channels", "open"\)\} \/>/);
});

test("Settings offers 'Download diagnostics' — what the autopilot decided and why, for whoever helps", () => {
  const settings = readFileSync(new URL("../src/components/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(settings, /api\.diagnosticsDownload\(\)/);
  assert.match(settings, />\s*Download diagnostics\s*</);
  const api = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.match(api, /fetch\("\/api\/diagnostics", \{ headers: authHeaders\(\) \}\)/);
});

// Review 2026-10-25: the channel autopilot and auto-rebalance switched on at
// once — while this form's own comment said each asks first.
test("switching the channel autopilot or auto-rebalance on asks first, saying what it spends; switching off — or fee automation and max_htlc on — never asks", () => {
  const c = config({ rebalanceDailyBudgetSats: 2_000, maxRebalancesPerRun: 3, channelReserveSats: 500_000, channelMaxFeeRate: 8, channelSizeSats: 0 });
  const open = switchOnConfirm("channelEnabled", c);
  assert.equal(open?.title, "Turn on the channel autopilot?");
  assert.match(open?.message ?? "", /opens channels with your on-chain funds, on its own: .*sized automatically, keeping 500,000 sat on chain, at most 8 sat\/vB/);
  // Final review 2026-10-25: the payback check needs routing history, and
  // routing opens leave Magma what it can list — the confirmation says both.
  assert.match(open?.message ?? "", /With enough routing history an open must also pay back what opening and closing cost; without it, only that fee rate cap applies\./);
  assert.match(open?.message ?? "", /While Liquidity provision is on, routing opens leave the coins your offers can list to Magma when leasing them is expected to earn more — how much is decided each run\./);
  assert.doesNotMatch(open?.message ?? "", /only when an open pays back/);
  const refill = switchOnConfirm("rebalanceEnabled", c);
  assert.equal(refill?.title, "Turn on auto-rebalance?");
  assert.match(refill?.message ?? "", /at most 2,000 sat a day in fees \(manual runs included\) and at most 3 per run\.$/);
  assert.match(switchOnConfirm("rebalanceEnabled", { ...c, rebalanceDailyBudgetSats: null })?.message ?? "", /with no daily limit/);
  assert.match(switchOnConfirm("rebalanceEnabled", { ...c, maxRebalancesPerRun: 0 })?.message ?? "", /Max rebalances \/ run is 0: none runs until you raise it\.$/);
  for (const f of ["enabled", "maxHtlcEnabled", "sellEnabled"] as const) assert.equal(switchOnConfirm(f, c), null, f);
  const panel = readFileSync(new URL("../src/components/AutopilotPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /const ask = v \? switchOnConfirm\(field, config\) : null;/, "off never asks");
});

test("a rebalance window with no hour in it (24 → 0) is refused at the field before it is sent; equal hours mean any time — and the hints say what 0 per run means", () => {
  assert.equal(windowEverOpen(24, 0), false);
  for (const [s, e] of [[5, 5], [0, 24], [22, 6], [24, 3], [0, 1]]) assert.equal(windowEverOpen(s, e), true, `${s}→${e}`);
  const b = { ...bounds, config: { ...bounds.config, rebalanceHourStart: int(0, 24), rebalanceHourEnd: int(0, 24) } } as AutopilotBounds;
  const never = checkDraft(draft({ nums: { rebalanceHourStart: "24", rebalanceHourEnd: "0" } }), config(), b, labels);
  assert.match(never.fieldErrors.rebalanceHourStart ?? "", /never opens \(hour 24 is the next day's 0\) — use equal hours for any time/);
  assert.equal(never.errors.length, 1);
  assert.deepEqual(checkDraft(draft({ nums: { rebalanceHourStart: "5", rebalanceHourEnd: "5" } }), config(), b, labels).errors, []);
  assert.match(REBALANCE_WINDOW_HINT, /Equal hours \(0 and 24, or 5 and 5\) mean any time/);
  assert.match(PER_RUN_HINTS.maxChangesPerRun, /^0 = the autopilot writes no fee change \(it still shows what it would change\) — except the 10-minute check that lowers a sold channel's fee to what its buyer was promised\./);
  assert.match(PER_RUN_HINTS.maxRebalancesPerRun, /^0 = no refill runs automatically/);
});
