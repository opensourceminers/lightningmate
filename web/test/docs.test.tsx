/**
 * The documentation says what the presets do (D9/D10; review P1b). The
 * strategy doc's preset table had "Balanced: Magma on, auto" and "Max profit:
 * channels off, Magma on" — two releases after no preset touched selling any
 * more — and the README said the Strategy tunes "Magma together" with fees.
 * Checked against the presets themselves, so the two cannot drift apart again.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SELLING_KEYS, buildPresets } from "../src/presets";
import type { AutopilotConfig } from "../src/types";

const doc = readFileSync(new URL("../../docs/AUTOPILOT-STRATEGY.md", import.meta.url), "utf8");
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

const policy = { minPpm: 1, neutralPpm: 50, maxPpm: 500, protectPpm: 300, baseFeeMsat: 1000, step: 5, minChangePpm: 5 } as unknown as AutopilotConfig["policy"];
const rebalancePolicy = { econRatio: 0.5, amountSats: 100_000, maxLocalRatioTarget: 0.3, minLocalRatioSource: 0.6 } as unknown as AutopilotConfig["rebalancePolicy"];

test("the strategy doc's preset table matches the presets: fee curve, channel opens, and Magma untouched by every one", () => {
  for (const p of buildPresets({ policy, rebalancePolicy })) {
    const row = doc.split("\n").find((l) => l.startsWith(`| **${p.label}**`));
    assert.ok(row, `no table row for ${p.label}`);
    const cells = row.split("|").map((c) => c.trim());
    const [, , curve, , , , , , channels, magma] = cells;
    assert.equal(curve, `${p.cfg.policy?.minPpm} / ${p.cfg.policy?.neutralPpm} / ${p.cfg.policy?.maxPpm}`, p.label);
    assert.equal(channels.startsWith("on"), p.cfg.channelEnabled === true, `${p.label}: channels "${channels}"`);
    assert.ok(!/off/i.test(channels), `${p.label}: no preset switches channel opens off`);
    const touchesSelling = SELLING_KEYS.some((k) => k in p.cfg);
    assert.equal(touchesSelling, false);
    assert.equal(magma, "untouched", `${p.label}: Magma "${magma}"`);
  }
  assert.match(doc, /No preset touches Magma selling/);
  assert.doesNotMatch(doc, /lease idle capital rather than\s+route it\.|leasing idle capital\./);
});

test("the README says selling is the operator's decision — no preset tunes it", () => {
  assert.doesNotMatch(readme, /tunes fees, rebalancing, channel-opening and Magma together/);
  assert.match(readme, /no preset ever touches\s+Magma selling/);
  assert.match(readme, /Selling is off by\s+default/);
});

test("the strategy doc says what the fee engine does now (review 3): Neutral ppm is a ceiling for balanced channels, per-channel elasticity is learned only from strong evidence, and a missing market reference never lowers a draining channel", () => {
  assert.doesNotMatch(doc, /neutralPpm\s+80\s+# fee for a balanced channel/, "raising it no longer raises a balanced channel routing lower");
  assert.match(doc, /neutralPpm\s+80\s+# the curve's level for a balanced channel \(at its target ratio\) — a ceiling there, not a/);
  assert.doesNotMatch(doc, /The engine learns per-channel\s+elasticity/);
  assert.match(doc, /can learn per-channel\s+elasticity — only from strong evidence \(most nodes: none\)/);
  assert.match(doc, /\*\*A missing market reference never lowers a draining channel\.\*\*/);
  assert.match(doc, /A read that never answers is given up after 10 minutes/);
});
