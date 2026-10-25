/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * Opening channels from the UI and the node's need (package P4):
 *  - the Open form chooses its on-chain fee and shows the cost, what is left
 *    and the payback before anything is sent (a3-channels:open-fee-gate-too-loose);
 *  - the need labels name what the node really lacks (a3-channels:node-need-inverted);
 *  - the channel autopilot's settings carry its fee cap, and its last
 *    decision is shown (a3-channels:history-flood, D16).
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openLines, startingFeeText } from "../src/openView";
import { NEED_LABEL } from "../src/components/SuggestionsPanel";
import { CHANNEL_OPEN_HINT } from "../src/components/AutopilotPanel";
import { enableSellingPendingMessage, freedCapitalMagmaHint, SUMMARY_LABEL } from "../src/magmaView";
import type { OpenEstimate } from "../src/types";

const estimate = (o: Partial<OpenEstimate> = {}): OpenEstimate => ({
  sizeSats: 2_000_000,
  fees: { fast: 30, fastTarget: 1, normal: 12, economy: 4 },
  spendableSat: 5_000_000,
  reserveSat: 61_000,
  promisedSat: 0,
  yieldPpmYear: 1_000,
  yieldEvidence: { channels: 2, capacitySat: 4_000_000, forwards: 40, earnedSat: 330, forwardsRead: true },
  minYieldForwards: 10,
  minYieldEarnedSat: 1_000,
  openVbytes: 175,
  closeVbytes: 150,
  paybackMonths: 12,
  autopilotMaxFeeRate: 20,
  initialRoutingFee: { feeRatePpm: 80, baseFeeMsat: 0 },
  ...o,
});

test("the Open form says what an open costs at the chosen rate, what is left, and how long it takes to pay back — and warns past a year's payback or the funds", () => {
  const l = openLines(2_000_000, 4, estimate());
  assert.equal(l.cost, "~700 sat on-chain to open at 4 sat/vB");
  assert.equal(l.left, "3,000,000 sat left to spend after it (the reserve kept)");
  // 2M at 1,000 ppm/yr earns 2,000 sat a year; open + close 1,300 sat: ~8 months.
  assert.equal(l.payback, "the open and a later close (~1,300 sat) pay back in ~8 months at what a channel earns here (1,000 ppm/yr in month-old channels)");
  assert.equal(l.warn, null);
  // At 30 sat/vB (Fast): ~59 months — more than the autopilot's limit.
  assert.match(openLines(2_000_000, 30, estimate()).warn ?? "", /^At 30 sat\/vB this channel takes ~59 months to earn back its open and close — more than the autopilot's 12-month limit/);
  // Bigger than what can be spent.
  assert.match(openLines(6_000_000, 4, estimate({ promisedSat: 2_000_000 })).warn ?? "", /^Only 5,000,000 sat can be spent after the on-chain reserve \(61,000 sat\) and the 2,000,000 sat promised to buyers — not enough for 6,000,000\./);
  // No yield to go by: said — and why — not guessed.
  const few = { channels: 1, capacitySat: 6_000_000, forwards: 3, earnedSat: 10, forwardsRead: true };
  assert.equal(
    openLines(2_000_000, 4, estimate({ yieldPpmYear: null, yieldEvidence: few })).payback,
    "too little routing on month-old channels to estimate its payback (3 forwards, 10 sat in 30 days — it takes 10 forwards or 1,000 sat)",
  );
  assert.equal(openLines(2_000_000, 4, estimate({ yieldPpmYear: null, yieldEvidence: { ...few, channels: 0 } })).payback, "no channel is a month old yet — its payback can't be estimated");
  assert.equal(openLines(2_000_000, 4, estimate({ yieldPpmYear: null, yieldEvidence: null })).payback, "this node's routing income couldn't be read — its payback can't be estimated");
  // Enough routing behind it, and nothing earned: it never pays back — said, and warned.
  const nothing = openLines(2_000_000, 4, estimate({ yieldPpmYear: 0 }));
  assert.equal(nothing.payback, "month-old channels here earned nothing in 30 days — at that, the open and a later close (~1,300 sat) never pay back");
  assert.match(nothing.warn ?? "", /^The channel autopilot wouldn't open this/);
  // Above what the autopilot would pay (and still paying back): said.
  assert.match(openLines(20_000_000, 25, estimate({ spendableSat: 30_000_000 })).warn ?? "", /^25 sat\/vB is above the 20 sat\/vB the channel autopilot would pay/);
  // The routing fee the channel starts with is said before the click (and after it).
  assert.equal(l.fee, "it starts at 80 ppm + 0 msat routing fee — the fee engine's new-channel fee, not LND's default");
  assert.equal(startingFeeText({ feeRatePpm: 150, baseFeeMsat: 1_000 }), "it starts at 150 ppm + 1,000 msat routing fee — the fee engine's new-channel fee, not LND's default");
  // The form sends the chosen rate (before: only pubkey, socket and size).
  const panel = readFileSync(new URL("../src/components/SuggestionsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\{l\.fee \? <div>\{l\.fee\}<\/div> : null\}/);
  assert.match(panel, /\{result\.startingFee \? ` · \$\{startingFeeText\(result\.startingFee\)\}` : ""\}/);
  assert.match(panel, /\.\.\.\(rate > 0 \? \{ feeRate: rate \} : \{\}\)/);
  assert.match(panel, /setRate\(e\.fees\.economy \?\? e\.fees\.normal \?\? e\.fees\.fast \?\? 0\)/, "economy by default");
});

test("the need labels say what the node lacks: ≥ 70 % local is short of INBOUND (an open adds outbound only), ≤ 30 % local is short of OUTBOUND — and a Magma hint no longer hides behind the old 'needs inbound' state", () => {
  assert.equal(NEED_LABEL.need_inbound, "Short of inbound — opens add outbound only");
  assert.equal(NEED_LABEL.need_outbound, "Short of outbound — new channels add it");
  assert.ok(!Object.keys(SUMMARY_LABEL).includes("not_recommended_node_needs_inbound"));
  const sell = readFileSync(new URL("../src/components/MarketSell.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(sell, /not_recommended_node_needs_inbound/);
  // An inbound-rich node (the old "needs inbound" state) gets the close tab's
  // Magma hint like any other where selling is realistic.
  const rec = {
    nodeNeed: "need_outbound",
    sell: { state: "good_to_sell", adjustedRoutingPpmPerYear: 12_000, recommendations: [{ economics: { beatsRouting: true, leaseApy: 4.2 } }] },
  } as unknown as Parameters<typeof freedCapitalMagmaHint>[0];
  const elig = { verdict: "realistic", expectedSalesPerYear: 6 } as unknown as Parameters<typeof freedCapitalMagmaHint>[1];
  assert.match(freedCapitalMagmaHint(rec, elig, 2_000_000) ?? "", /^Closing these frees ~2,000,000 sat\. One Magma sale at today's price nets ~4\.2%\/yr/);
  // Review 2026-10-25: never an invitation to close beyond the deploy cap.
  assert.equal(freedCapitalMagmaHint(rec, elig, 2_000_000, 0), null, "the cap reached: no hint");
  assert.match(freedCapitalMagmaHint(rec, elig, 2_000_000, 500_000) ?? "", /^Closing these frees ~2,000,000 sat — your deploy cap lets Magma take ~500,000 sat of it\. One Magma sale/);
  assert.match(freedCapitalMagmaHint(rec, elig, 2_000_000, 5_000_000) ?? "", /^Closing these frees ~2,000,000 sat\. One Magma sale/);
  const panel = readFileSync(new URL("../src/components/CloseCandidatesPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /freedCapitalMagmaHint\(magma, elig, data\?\.totalCapitalFreedSats \?\? 0, room\)/);
});

test("review 2026-10-25: the close dialog preselects the economy rate; the channel hint, the presets and the switch-on dialog say opens wait for the coins held for Magma", () => {
  const dialog = readFileSync(new URL("../src/components/CloseChannelDialog.tsx", import.meta.url), "utf8");
  assert.match(dialog, /setRate\(f\.economy \?\? f\.normal \?\? f\.fast \?\? 1\)/);
  assert.match(CHANNEL_OPEN_HINT, /the coins your Magma offer can list \(within your deploy cap\) wait for Magma/);
  assert.match(CHANNEL_OPEN_HINT, /LND's own anchor reserve \(10,000 sat per anchor channel, up to 100,000\) wins when it is larger/);
  assert.match(CHANNEL_OPEN_HINT, /Auto size shrinks to what can be spent/);
  assert.match(enableSellingPendingMessage(), /Routing opens of the channel autopilot then wait for the coins your offer can list/);
  const presets = readFileSync(new URL("../src/presets.ts", import.meta.url), "utf8");
  assert.match(presets, /open channels as funds allow \(with Liquidity provision on, not the coins held for Magma\)/);
});

test("a suggestion can be put on the channel autopilot's 'never open automatically' list from its row", () => {
  const panel = readFileSync(new URL("../src/components/SuggestionsPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /await api\.neverOpen\(s\.pubkey, !s\.neverOpen, s\.alias\)/);
  assert.match(panel, /\{s\.neverOpen \? "allow auto" : "never auto"\}/);
  assert.match(panel, /never auto-open<\/span>/);
});

test("the docs say what the channel autopilot and the close list do now — no 'top suggestion', no '1 %' gate, leases and pending channels never close candidates", () => {
  const doc = readFileSync(new URL("../../docs/AUTOPILOT-STRATEGY.md", import.meta.url), "utf8");
  assert.doesNotMatch(doc, /opens a channel to the top-scored peer suggestion/);
  assert.match(doc, /LND's economy rate \(a 72-block target\)/);
  assert.match(doc, /pay back within 12 months/);
  assert.match(doc, /Waits and deferrals are the stage's decision note, never failed\s+runs/);
  assert.match(doc, /channelMaxFeeRate/);
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.match(readme, /never a channel still opening or\s+closing, or one inside its lease/);
  assert.match(readme, /a force-close is\s+its own step that says what it does/);
});

test("the channel autopilot: its fee cap is a setting, how it decides is said under its settings, and its last decision is shown", () => {
  const panel = readFileSync(new URL("../src/components/AutopilotPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\{ key: "channelMaxFeeRate", label: "Max on-chain fee for opens \(sat\/vB\)" \}/);
  // Its last decision, with its state (D16): the status line at the top of the sub-tab.
  assert.match(panel, /<StatusLine area="channels" status=\{status\?\.channels\} \/>/);
  assert.match(CHANNEL_OPEN_HINT, /paid back within a year/);
  assert.match(CHANNEL_OPEN_HINT, /refused an open waits 1 day, then 7, then 30/);
  // Review of P4: "without an address … is never opened to" — but a peer
  // that is connected already is (planOpen dials only peers it must reach).
  assert.doesNotMatch(CHANNEL_OPEN_HINT, /without an address, of low usefulness/);
  assert.match(CHANNEL_OPEN_HINT, /nor one that advertises no address to dial unless it is connected already/);
});
