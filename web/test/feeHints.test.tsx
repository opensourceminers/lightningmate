/**
 * The fee hints say what the step-back does (final review 2026-10-25): it
 * goes back to the higher of the last price that sold and the fee before
 * the raise, not raised back for a week — and it is one of the moves made
 * in one update (the Fees tab's banner and the Autopilot's policy hint
 * listed every other one).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8").replace(/\s+/g, " ");

test("the Fees tab's banner and the policy hint list the step-back among the moves made in one update, and say where it goes back to", () => {
  const banner = source("components/FeeRecommendations.tsx");
  assert.match(banner, /steps back to the higher of the last price that sold and the fee before it, and isn&apos;t raised back to that level for a week/);
  assert.match(banner, /Only these move in one update: a step back, an idle channel dropping/);
  const hint = source("components/AutopilotPanel.tsx");
  assert.match(hint, /goes back to the higher of the last price that sold and the fee before it — and isn’t raised back to that level for a week/);
  assert.match(hint, /In one update only: a step back, an idle channel dropping/);
});
