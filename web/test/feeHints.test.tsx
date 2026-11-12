/**
 * The fee hints say what the step-back does (final review 2026-10-25): it is
 * one of the moves made in one update (the Fees tab's banner and the
 * Autopilot's policy hint listed every other one). Since the review of
 * 2026-11-10 it goes back to the last fee that sold — through all the raises
 * of a climb, not one — and is not raised back for a week, longer each time;
 * and a fee that sells is kept (the hints said "the higher of the last price
 * that sold and the fee before it" and "for a week", and nothing about a fee
 * that sells).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8").replace(/\s+/g, " ");

test("the Fees tab's banner and the policy hint list the step-back among the moves made in one update, and say where it goes back to", () => {
  const banner = source("components/FeeRecommendations.tsx");
  assert.match(banner, /steps back to the last fee that sold, and isn&apos;t raised back to that level for a week — longer each time it fails again/);
  assert.match(banner, /Only these move in one update: a step back, an idle channel dropping/);
  const hint = source("components/AutopilotPanel.tsx");
  assert.match(hint, /goes back to the last fee that sold — and isn’t raised back to that level for a week, two weeks the second time in " \+ "a row, four the third/);
  assert.match(hint, /In one update only: a step back, an idle channel dropping/);
  for (const text of [banner, hint]) assert.doesNotMatch(text, /the higher of the last price that sold and the fee before it/);
});

test("both say that a fee that sells is kept, and that a higher one is tried where a channel sells every day", () => {
  const banner = source("components/FeeRecommendations.tsx");
  assert.match(banner, /A fee that sells is kept: it is not lowered while the channel sells at it, unless the channel holds more than its target and takes in more than it sells/);
  assert.match(banner, /a slightly higher fee is tried and taken back if it earns less/);
  const hint = source("components/AutopilotPanel.tsx");
  assert.match(hint, /A fee that sells is kept: " \+ "it is not lowered while the channel sells at it/);
  assert.match(hint, /higher is tried, and taken back if it earns less/);
  // The ramp that acts before a channel is empty, and what paces it.
  assert.match(hint, /the demand and drain ramps 6 h/);
  assert.match(hint, /sells itself empty within three weeks — the drain ramp/);
});
