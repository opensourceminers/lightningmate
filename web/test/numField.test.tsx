import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumField } from "../src/numField";

const interval = { min: 5, max: 1_440, integer: true };
const ratio = { min: 0.05, max: 1, integer: false };

test("a blank field is an error — never 0", () => {
  // Before: Math.max(0, Number("") || 0) turned a cleared field into 0, which
  // meant "run every minute", "no reserve" or "unlimited budget".
  const r = parseNumField("", interval, "Run every (min)");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /Run every \(min\): enter a value \(5–1440\)/);
  assert.equal(parseNumField("   ", interval, "x").ok, false);
});

test("values are checked against the server's bounds", () => {
  assert.deepEqual(parseNumField("30", interval, "x"), { ok: true, value: 30 });
  assert.equal(parseNumField("0", interval, "x").ok, false);
  assert.equal(parseNumField("40000", interval, "x").ok, false);
  assert.equal(parseNumField("4.5", interval, "x").ok, false, "whole numbers only");
  assert.equal(parseNumField("abc", interval, "x").ok, false);
  assert.deepEqual(parseNumField("0.8", ratio, "x"), { ok: true, value: 0.8 });
  assert.equal(parseNumField("2", ratio, "x").ok, false);
});
