/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * The fee pages' decisions (review a6/a5, package P2): choosing "fixed" pins
 * nothing until a value is confirmed and starts from the CURRENT fee (it
 * pinned 100 ppm at once), a blank pin is an error (never 0), the Channels
 * table shows what each channel charges, "Apply" sends the rows for the
 * server to apply what the engine recommends (base fee included), unserved
 * demand is worded honestly, and the fee-tuning figure needs enough changes.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MIN_DEMAND_DAYS,
  NEUTRAL_PPM_HINT,
  applyChannelIds,
  baseChange,
  demandSummary,
  feeText,
  feeTuningKpi,
  historyFeeLine,
  marketRefText,
  onModeChange,
  parsePin,
  pinSeed,
} from "../src/feeView";
import { FeeOverrideControl } from "../src/components/FeeOverrideControl";
import { ApplyResult } from "../src/components/FeeRecommendations";
import type { AutopilotChange, OutcomesReport, UnservedDemandReport } from "../src/types";

test("choosing 'fixed' saves nothing yet and starts from the channel's current fee (it pinned 100 ppm at once); auto and excluded save at once", () => {
  assert.deepEqual(onModeChange("fixed", undefined, 800), { edit: "800" });
  assert.deepEqual(onModeChange("fixed", { mode: "fixed", fixedPpm: 650 }, 800), { edit: "650" }, "an existing pin is shown as it is");
  assert.deepEqual(onModeChange("fixed", undefined, null), { edit: "" }, "unknown: empty, never a made-up 100");
  assert.deepEqual(onModeChange("auto", { mode: "fixed", fixedPpm: 650 }, 800), { save: { mode: "auto" } });
  assert.deepEqual(onModeChange("exclude", undefined, 800), { save: { mode: "exclude" } });
});

test("the pin input follows the stored pin, else the current fee", () => {
  assert.equal(pinSeed({ mode: "fixed", fixedPpm: 800 }, 120), "800");
  assert.equal(pinSeed(undefined, 120), "120");
  assert.equal(pinSeed({ mode: "exclude" }, 120), "120");
});

test("a pin as typed: blank or garbage is an error to show — it was saved as 0 ppm (Math.max(0, Number('') || 0))", () => {
  assert.deepEqual(parsePin(" 290 "), { ok: true, value: 290 });
  assert.deepEqual(parsePin("0"), { ok: true, value: 0 });
  for (const bad of ["", "  ", "abc", "-5", "12.5", "50001"]) {
    const r = parsePin(bad);
    assert.equal(r.ok, false, bad);
  }
});

test("the override control renders a stored pin as stored — and the shared labels", () => {
  const html = renderToStaticMarkup(<FeeOverrideControl ov={{ mode: "fixed", fixedPpm: 800 }} currentPpm={100} onSave={async () => undefined} />);
  assert.match(html, /value="800"/);
  assert.match(html, />excluded</);
  const buttons = renderToStaticMarkup(<FeeOverrideControl variant="buttons" ov={undefined} currentPpm={100} onSave={async () => undefined} />);
  assert.match(buttons, />auto<\/button>.*>fixed<\/button>.*>excluded<\/button>/);
  assert.doesNotMatch(buttons, /<input/, "no input until 'fixed' is chosen");
});

test("what a channel charges, as the Channels table shows it", () => {
  assert.equal(feeText(640, 1000), "640 ppm · 1 sat base");
  assert.equal(feeText(80, 0), "80 ppm");
  assert.equal(feeText(80, 500), "80 ppm · 500 msat base");
  assert.equal(feeText(null, null), "—");
});

test("Apply sends the rows that would change — the server applies the engine's target AND base fee; a base-fee-only row says so", () => {
  const rows = [
    { channelId: "a", wouldApply: true, transactionId: "t", transactionVout: 0 },
    { channelId: "b", wouldApply: false, transactionId: "t", transactionVout: 1 },
    { channelId: "c", wouldApply: true, transactionId: null, transactionVout: null },
  ];
  assert.deepEqual(applyChannelIds(rows), ["a"]);
  assert.equal(baseChange({ currentBaseMsat: 1000, recommendedBaseMsat: 0 }), "base 1000→0 msat");
  assert.equal(baseChange({ currentBaseMsat: 0, recommendedBaseMsat: 0 }), null);
});

test("a fee change in the run history: the move, the base fee, who made it", () => {
  assert.equal(
    historyFeeLine({ id: "x", alias: "peer", fromPpm: 80, toPpm: 100, fromBaseMsat: 1000, toBaseMsat: 0, via: "manual", ok: true }),
    "Fee · peer: 80→100 ppm, base 1000→0 msat (by hand)",
  );
  assert.equal(historyFeeLine({ id: "x", alias: "peer", fromPpm: 3000, toPpm: 2200, via: "lease", ok: true }), "Fee · peer: 3000→2200 ppm (lease promise)");
});

const demandReport = (o: Partial<UnservedDemandReport> = {}): UnservedDemandReport => ({
  days: 7,
  trackedDays: 10,
  channels: [
    {
      outChannel: "a",
      alias: "peer",
      liquidityCount: 34,
      liquiditySats: 94_391_478,
      otherCount: 0,
      probeCount: 20,
      probeSats: 80_000_000,
      retryCount: 8,
      retrySats: 8_000_000,
      oversizedCount: 2,
      oversizedSats: 4_000_000,
      unclassifiedCount: 0,
      unclassifiedSats: 0,
      demandCount: 4,
      demandSats: 600_000,
      demandDays: 3,
      demandMedianSats: 150_000,
      missedFeesSats: 240,
    },
  ],
  ...o,
});

test("unserved demand: only the de-noised attempts, what was taken out said — and nothing before 3 days of data (the first day read '7d')", () => {
  assert.equal(demandSummary(demandReport({ trackedDays: 0.4 })), null);
  assert.equal(demandSummary(demandReport({ trackedDays: MIN_DEMAND_DAYS - 0.1 })), null);
  const d = demandSummary(demandReport())!;
  assert.deepEqual([d.attempts, d.sats, d.missedFeesSats, d.raw, d.probes, d.retries, d.oversized], [4, 600_000, 240, 34, 20, 8, 2]);
  assert.equal(d.window, "the last 7 days");
  assert.equal(d.kind, "demand");
  assert.equal(demandSummary(demandReport({ trackedDays: 3.5 }))!.window, "the last 3.5 days");
});

test("an updated install: the sorted window and the 3-day gate count from when sorting began — an hour after the update, 34 refusals from before it no longer read 'no payment a refilled channel could have carried was turned away in the last 7 days'", () => {
  const NOW = Date.parse("2026-10-21T12:00:00.000Z");
  const DAY = 86_400_000;
  const unsorted = {
    ...demandReport().channels[0],
    probeCount: 0,
    probeSats: 0,
    retryCount: 0,
    retrySats: 0,
    oversizedCount: 0,
    oversizedSats: 0,
    demandCount: 0,
    demandSats: 0,
    demandDays: 0,
    demandMedianSats: null,
    missedFeesSats: 0,
    unclassifiedCount: 34,
    unclassifiedSats: 94_391_478,
  };
  const report = demandReport({ trackedDays: 30, classifiedSince: new Date(NOW - 3_600_000).toISOString(), channels: [unsorted] });
  const d = demandSummary(report, NOW)!;
  assert.equal(d.kind, "sorting", "no claim either way — before: kind 'none' over 'the last 7 days'");
  assert.equal(d.rawWindow, "the last 7 days");
  assert.equal(d.window, "the last 0 days");
  // Four days on: sorted long enough — the older refusals still aren't called "no demand".
  const later = demandSummary({ ...report, classifiedSince: new Date(NOW - 4 * DAY).toISOString() }, NOW)!;
  assert.deepEqual([later.kind, later.window, later.unclassified], ["none_unsorted", "the last 4 days", 34]);
  // Everything sorted, nothing servable: that may be said.
  const sorted = demandSummary(demandReport({ classifiedSince: new Date(NOW - 20 * DAY).toISOString(), channels: [{ ...unsorted, probeCount: 34, unclassifiedCount: 0 }] }), NOW)!;
  assert.deepEqual([sorted.kind, sorted.window], ["none", "the last 7 days"]);
  // Servable attempts within the sorted window: possible demand.
  assert.equal(demandSummary(demandReport({ classifiedSince: new Date(NOW - 5.5 * DAY).toISOString() }), NOW)!.kind, "demand");
  assert.equal(demandSummary(demandReport({ classifiedSince: new Date(NOW - 5.5 * DAY).toISOString() }), NOW)!.window, "the last 5.5 days");
});

const outcomes = (fees: Partial<OutcomesReport["fees"]>): OutcomesReport => ({
  measureWindowDays: 14,
  fees: { windowDays: 14, measured: 0, measurable: 0, pending: 0, tooClose: 0, raises: 0, cuts: 0, avgRevenueDeltaPct: null, minMeasured: 5, confidence: "none", note: "", items: [], ...fees },
  rebalances: { measured: 0, totalCostSats: 0, totalEarnedBackSats: 0, avgEarnedBackPct: null, paidBackCount: 0, netSats: 0, items: [] },
});

test("the fee-tuning figure: a coloured number only over enough changes, always how many it rests on", () => {
  assert.deepEqual(feeTuningKpi(null), { value: "—", sub: "no data yet" });
  const few = feeTuningKpi(outcomes({ measured: 3, measurable: 2, pending: 4 }));
  assert.equal(few.value, "—");
  assert.equal(few.tone, undefined, "no colour");
  assert.equal(few.sub, "2 of 5 changes needed · 4 too recent");
  const enough = feeTuningKpi(outcomes({ measured: 6, measurable: 6, avgRevenueDeltaPct: -0.12, confidence: "low" }));
  assert.deepEqual(enough, { value: "-12", unit: "% rev", tone: "cost", sub: "6 changes · low confidence" });
});

test("the 'fixed' hint says what puts a pin on the node — fee automation or Apply on the Fees tab — instead of implying that saving it does ('applied exactly as set, then held')", () => {
  const html = renderToStaticMarkup(<FeeOverrideControl ov={undefined} currentPpm={100} onSave={async () => undefined} />);
  assert.match(html, /value="fixed" title="pin a fee: fee automation \(or Apply on the Fees tab\) sets it exactly as typed, then holds it"/);
});

// ── review 3 ────────────────────────────────────────────────────────────────

test("Apply's result: a write that did not happen is 'not applied' — a channel skipped because its policy could not be read was never refused by LND — with each reason in the tooltip", () => {
  const change = (o: Partial<AutopilotChange>): AutopilotChange => ({ id: "850000x1x0", alias: "peer", fromPpm: 100, toPpm: 80, ok: true, ...o });
  const html = renderToStaticMarkup(
    <ApplyResult
      applied={[
        change({}),
        change({ alias: "lease", clampedBy: "lease" } as Partial<AutopilotChange>),
        change({ alias: "skipped", ok: false, error: "skipped: current policy (cltv) unreadable — won't risk a reset" }),
        change({ alias: "refused", ok: false, error: "max htlc size of 1980000000 mSAT is above max pending amount" }),
      ]}
    />,
  );
  assert.match(html, /✓ 2 applied \(1 kept within a lease&#x27;s fee promise\)/);
  assert.match(html, /· 2 not applied/);
  assert.doesNotMatch(html, /refused by LND/);
  // Each one's reason, in the tooltip.
  assert.match(html, /title="[^"]*skipped: skipped: current policy \(cltv\) unreadable[^"]*refused: max htlc size[^"]*"/);
});

test("the policy hint says what Neutral ppm does now: a ceiling for balanced channels — raising it doesn't raise a channel routing at a lower fee", () => {
  assert.match(NEUTRAL_PPM_HINT, /^Neutral ppm is a ceiling for balanced channels, not a price they are raised to/);
  assert.match(NEUTRAL_PPM_HINT, /raising it doesn't raise a channel that routes at a lower fee \(that one is held\)/);
});

test("a remembered market reference says when it was last seen", () => {
  assert.equal(marketRefText({ marketPpm: 200, marketSamples: 3, marketSeenAt: null }), "~200 ppm (3 channels)");
  const seen = new Date(Date.now() - 3 * 3_600_000).toISOString();
  assert.equal(marketRefText({ marketPpm: 200, marketSamples: 3, marketSeenAt: seen }), "~200 ppm (3 channels, last seen 3h ago)");
  assert.equal(marketRefText({ marketPpm: null, marketSamples: 0, marketSeenAt: null }), "—");
});
