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
import { sellerSetup } from "./helpers/autopilot.js";
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
