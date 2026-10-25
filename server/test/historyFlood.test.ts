/**
 * The run history is for what the autopilot did, not for what it keeps
 * waiting for (review a3-channels:history-flood, package P4; D15).
 *
 * Before, every 30-minute run that deferred an open ("leasing beats routing",
 * "on-chain fees too high") or failed the same way again was a red "✗" run;
 * at 48 runs a day the 50-run history held about a day. The channel stage's
 * waits are its decision note now (autoOpen.test.ts); this pins the same for
 * Magma offer upkeep failing every run while Amboss is down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { withHistoryLine, type AutopilotRun } from "../src/services/autopilot.js";
import { autopilotWith, plannedFeeChange, sellerSetup } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";

test("offer upkeep that fails the same way every run (Amboss down) is one line of history, not one per run — and a recovery is news again", async (t) => {
  quiet(t);
  const { autopilot, magma } = sellerSetup(t);
  magma.addOffer({});
  magma.readBehaviour = "throw";
  for (let i = 0; i < 4; i++) await autopilot.runOnce();
  const lines = autopilot.getState().history.flatMap((r) => r.sells);
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].ok, false);
  assert.match(lines[0].error ?? "", /could not (read your offers from Amboss|work out the sellable capital)/);
  // The sync status keeps the last error either way.
  assert.match(autopilot.offerSyncStatus().lastError?.message ?? "", /could not/);

  // Amboss answers again; then fails again: that is news.
  magma.readBehaviour = "ok";
  await autopilot.runOnce();
  magma.readBehaviour = "throw";
  await autopilot.runOnce();
  assert.equal(autopilot.getState().history.flatMap((r) => r.sells).filter((s) => !s.ok).length, 2);
});

// Review 2026-10-25: on 22–23 Oct one max_htlc update LND took but never kept
// (300,000 → 1,048,576 sat, every 30 min for 19 h) filled 35 of the 50 lines.
test("the same successful change run after run is one history line, counted — a different change, or another channel, is a line of its own", async (t) => {
  quiet(t);
  const { autopilot, seams } = autopilotWith(t, { enabled: true });
  seams.feeApply = async (_w, items) => items.map((i) => ({ id: i.id, ok: true, feeRatePpm: i.feeRatePpm, baseFeeMsat: i.baseFeeMsat }));
  // LND takes 100 → 80 ppm but keeps 100: the engine asks for it every run.
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800000x1x0", 100, 80)] });
  for (let i = 0; i < 3; i++) await autopilot.runOnce();
  const [line, ...older] = autopilot.getState().history;
  assert.equal(older.length, 0, JSON.stringify(autopilot.getState().history));
  assert.equal(line.repeats, 3);
  assert.ok(line.firstAt && line.firstAt <= line.at, "since the first time; `at` the latest");
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800000x1x0", 100, 60)] });
  await autopilot.runOnce();
  seams.feeReport = async () => ({ recommendations: [plannedFeeChange("800000x2x0", 100, 60)] });
  await autopilot.runOnce();
  assert.deepEqual(autopilot.getState().history.map((r) => r.repeats ?? 1), [1, 1, 3]);
});

test("only successes merge: a failed write, a fee set by hand, a refill, an open, a Magma action or a stage error is on the record every time", () => {
  const at = (n: number) => new Date(Date.UTC(2026, 9, 25, 0, n)).toISOString();
  const line = (n: number, o: Partial<AutopilotRun> = {}): AutopilotRun => ({
    at: at(n),
    attempted: 1,
    applied: 1,
    failed: 0,
    changes: [{ id: "800000x1x0", alias: "a", fromPpm: 100, toPpm: 80, ok: true }],
    rebalances: [],
    channels: [],
    sells: [],
    maxHtlc: [],
    ...o,
  });
  const twice = (o: Partial<AutopilotRun>) => withHistoryLine(withHistoryLine([], line(1, o), 50), line(2, o), 50);
  assert.equal(twice({}).length, 1, "the same success: merged");
  assert.equal(twice({ maxHtlc: [{ id: "800000x1x0", alias: "a", fromSat: 300_000, toSat: 1_048_576, ok: true }], changes: [] }).length, 1);
  const kept: Partial<AutopilotRun>[] = [
    { changes: [{ id: "800000x1x0", alias: "a", fromPpm: 100, toPpm: 80, ok: false, error: "LND refused the update" }] },
    { changes: [{ id: "800000x1x0", alias: "a", fromPpm: 100, toPpm: 80, ok: true, via: "manual" }] },
    { maxHtlc: [{ id: "800000x1x0", alias: "a", fromSat: 300_000, toSat: 1_048_576, ok: false, error: "refused" }], changes: [] },
    { rebalances: [{ alias: "a", amountSats: 1, feeSats: 1, costPpm: 1, ok: true }] },
    { channels: [{ alias: "a", sizeSats: 1, ok: true }] },
    { sells: [{ orderId: "o", action: "accept", sizeSats: 1, ok: true }] },
    { errors: [{ stage: "fees", error: "x" }] },
  ];
  for (const o of kept) assert.equal(twice(o).length, 2, JSON.stringify(o));
  // The limit holds either way.
  let h: AutopilotRun[] = [];
  for (let i = 0; i < 60; i++) h = withHistoryLine(h, line(i, { changes: [{ id: `8000${i}x1x0`, alias: "a", fromPpm: 1, toPpm: 2, ok: true }] }), 50);
  assert.equal(h.length, 50);
});
