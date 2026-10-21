/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * On-chain sends as the Wallet tab asks about them (review a4-lsp-payments:
 * onchain-send-guardrails — package P5). Before: one confirmation, "Send N
 * sat to … at R sat/vByte" — no fee in sats, nothing to compare the rate
 * with, nothing about the reserve, no Max, no "everything".
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ApiError } from "../src/apiError";
import { budgetLine, fastRateHint, sendDoubleCheck, sendNeedsConfirm, sendSummary } from "../src/onchainView";
import type { SendPreview } from "../src/types";

const preview = (o: Partial<SendPreview> = {}): SendPreview => ({
  mode: "amount",
  address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  amountSats: 2_000_000,
  feeRate: 200,
  vbytes: 141,
  feeSats: 28_200,
  feeApprox: false,
  estimates: { fast: 20, fastTarget: 1, normal: 10, economy: 2 },
  confirmedSats: 5_000_000,
  reserveSats: 60_000,
  promisedSats: 0,
  availableSats: 4_911_800,
  remainingSats: 2_971_800,
  touchesPromised: false,
  checks: [{ code: "fee_rate_high", message: "200 sat/vB is more than 3× what LND estimates for the next block (20 sat/vB): this send pays ~28,200 sat in fees." }],
  ...o,
});

test("the first confirmation names the fee in sats, its share of the amount, LND's next-block rate and what stays", () => {
  assert.equal(
    sendSummary(preview()),
    "Send 2,000,000 sat to bc1qar0srrr7xfkv… at 200 sat/vB. Fee: ~28,200 sat for 141 vbytes — 1.4% of the amount; " +
      "LND's next-block rate is 20 sat/vB. Leaves 2,971,800 sat on-chain. On-chain sends are irreversible.",
  );
  const all = sendSummary(preview({ mode: "all", amountSats: 939_559, feeSats: 441, vbytes: 220.5, feeApprox: true, estimates: { fast: null, fastTarget: null, normal: null, economy: null }, remainingSats: 60_000 }));
  assert.match(all, /^Send everything LND may spend \(~939,559 sat\)/);
  assert.match(all, /about 221 vbytes \(estimated from the wallet's coins\)/);
  assert.doesNotMatch(all, /next-block rate/, "no estimate: nothing compared");
  assert.match(all, /LND keeps back what it needs for its anchor channels\./);
  assert.match(sendSummary(preview({ touchesPromised: true })), /This takes coins promised to buyers — you'll be asked about that separately\./);
});

test("on an LND that won't estimate for one block (before 0.20), the 'fast' rate is its 2-block rate — and is called that", () => {
  const two = preview({ estimates: { fast: 25, fastTarget: 2, normal: 10, economy: 2 } });
  assert.match(sendSummary(two), /; LND's 2-block rate is 25 sat\/vB\./);
  assert.doesNotMatch(sendSummary(two), /next-block/);
  // The close and open dialogs' "Fast" card says which.
  assert.equal(fastRateHint({ fastTarget: 2 }), "~2 blocks");
  assert.equal(fastRateHint({ fastTarget: 1 }), "next block");
  assert.equal(fastRateHint({ fastTarget: null }), "next block");
  for (const file of ["CloseChannelDialog.tsx", "SuggestionsPanel.tsx"]) {
    const src = readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8");
    assert.match(src, /fastRateHint\((fees|estimate\.fees)\)/, file);
  }
});

test("a second yes for what the preview flags, in its own words — none when nothing is", () => {
  assert.equal(sendDoubleCheck([]), null);
  assert.equal(
    sendDoubleCheck(preview().checks),
    "200 sat/vB is more than 3× what LND estimates for the next block (20 sat/vB): this send pays ~28,200 sat in fees. Send anyway?",
  );
});

test("the wallet says what it can spare; a send refused for a check the page didn't ask about is recognised", () => {
  assert.equal(budgetLine({ budget: null }), null);
  // What Max fills in at the rate the form starts with — the rate is named.
  assert.equal(
    budgetLine({ budget: { reserveSats: 60_000, promisedSats: 0, availableSats: 938_590, feeRate: 10 } }),
    "Available to send: ~938,590 sat at 10 sat/vB (keeps 60,000 sat on-chain reserve)",
  );
  assert.equal(
    budgetLine({ budget: { reserveSats: 52_000, promisedSats: 2_000_000, availableSats: 946_000, feeRate: null } }),
    "Available to send: ~946,000 sat (keeps 52,000 sat on-chain reserve and 2,000,000 sat promised to buyers)",
  );
  const checks = [{ code: "below_reserve", message: "This leaves …" }];
  assert.deepEqual(sendNeedsConfirm(new ApiError("x", 409, { error: "confirm_send", checks })), checks);
  assert.equal(sendNeedsConfirm(new ApiError("x", 409, { error: "capital_promised" })), null);
  assert.equal(sendNeedsConfirm(new Error("x")), null);
});

test("the Wallet tab previews before the first yes, asks the second, sends the confirmed checks — and offers Max and 'send everything'", () => {
  const panel = readFileSync(new URL("../src/components/OnchainPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /at \$\{rate\} sat\/vByte\? On-chain sends are irreversible/, "the old one-line confirm is gone");
  assert.match(panel, /api\.onchainPreview\(\{ address: toAddr\.trim\(\), feeRate: rate, \.\.\.\(sendAll \? \{ all: true \} : \{ tokens: amt \}\) \}\)/);
  assert.match(panel, /message: sendSummary\(preview\)/);
  assert.match(panel, /const second = sendDoubleCheck\(preview\.checks\)/);
  assert.match(panel, /const confirmed = preview\.checks\.map\(\(c\) => c\.code\)/);
  assert.match(panel, /api\.onchainSend\(\{ address: toAddr\.trim\(\), feeRate: rate, \.\.\.what, confirmed,/);
  assert.match(panel, /api\.onchainPreview\(\{ address: toAddr\.trim\(\), feeRate: rate, max: true \}\)/);
  assert.match(panel, /Send everything/);
  assert.match(panel, /\{budgetLine\(state\)\}/);
});
