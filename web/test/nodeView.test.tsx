/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * A node's details and the Channels table: one sentence says where you stand
 * with a node, the figures follow, every view names a node the same way, and
 * the table shows four columns unless someone asks for more.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ageText,
  capacityText,
  channelNotes,
  closedText,
  eventText,
  firstSeenText,
  nodeStatus,
  nodeVerdict,
  placeText,
  ppmText,
  reachText,
  sinceText,
} from "../src/nodeView";
import { NodeLink } from "../src/components/NodeLink";
import { ChannelTable } from "../src/components/ChannelTable";
import { typedSocket } from "../src/components/NodeSearch";
import { openNode, rememberChannels, resolveNode, setNodeHandler } from "../src/nodeNav";
import { readRemembered, readRememberedList, writeRemembered } from "../src/remembered";
import { trapTab } from "../src/a11y";
import type { ChannelView, NodeAssessment, NodeChannelFacts, NodeDetail } from "../src/types";

const channel = (o: Partial<ChannelView> = {}): ChannelView =>
  ({
    id: "850000x1x0",
    peerPubkey: "02" + "11".repeat(32),
    peerAlias: "peer",
    active: true,
    private: false,
    initiator: "local",
    capacity: 5_000_000,
    transactionId: "11".repeat(32),
    transactionVout: 0,
    localBalance: 3_000_000,
    remoteBalance: 2_000_000,
    localRatio: 0.6,
    totalSent: 0,
    totalReceived: 0,
    unsettled: 0,
    status: "open",
    role: "router",
    feeRatePpm: 430,
    baseFeeMsat: 0,
    lease: null,
    offline: null,
    ageDays: null,
    ...o,
  }) as ChannelView;

const facts = (o: Partial<NodeChannelFacts> = {}): NodeChannelFacts => ({
  channelId: "850000x1x0",
  ageDays: 100,
  forwardsOut: 0,
  routedOutSats: 0,
  earnedSats: 0,
  forwardsIn: 0,
  routedInSats: 0,
  broughtInSats: 0,
  refills: 0,
  refillSats: 0,
  refillFeeSats: 0,
  theirFeePpm: null,
  theirBaseFeeMsat: null,
  theirDisabled: null,
  theirTimeLock: null,
  ...o,
});

const detail = (o: Partial<NodeDetail> = {}) => ({
  isSelf: false,
  channels: [channel()],
  channelFacts: [facts()],
  forwardsKnown: true,
  closedChannels: [],
  windowDays: 30,
  connection: null,
  ...o,
});

const candidate = (usefulness: "high" | "medium" | "low", score: number) =>
  ({ candidate: { usefulness, score, recommendedSizeSats: 2_000_000 }, notSuggestedBecause: [] }) as unknown as NodeAssessment;

const away = (hours: number, long = false) => ({ since: "2026-01-01T00:00:00Z", hours, uptimeShare: null, long });

test("one sentence says where you stand: earning, idle, new, offline, closing", () => {
  const earning = nodeVerdict(detail({ channelFacts: [facts({ forwardsOut: 84, earnedSats: 1_240, broughtInSats: 300, refillFeeSats: 120 })] }), null);
  assert.equal(earning.text, "Earned 1,240 sat in the last 30 days. It also brought in forwards that earned 300 sat elsewhere. Refills cost 120 sat.");
  assert.equal(earning.tone, "good");

  // A channel that only brings flow in earned nothing itself and still earns its keep.
  const inbound = nodeVerdict(detail({ channelFacts: [facts({ forwardsIn: 9, broughtInSats: 114 })] }), null);
  assert.match(inbound.text, /^Earned 0 sat in the last 30 days\. It also brought in forwards that earned 114 sat elsewhere\.$/);
  assert.equal(inbound.tone, "good");

  // Refills cost more than it made: said, and not called good.
  assert.equal(nodeVerdict(detail({ channelFacts: [facts({ forwardsOut: 2, earnedSats: 10, refillFeeSats: 500 })] }), null).tone, "neutral");

  const idle = nodeVerdict(detail(), null);
  assert.equal(idle.text, "No forwards in the last 30 days: 3.00M sat of yours sit idle here.");
  assert.equal(idle.tone, "warn");

  // A week-old channel isn't idle yet.
  assert.equal(nodeVerdict(detail({ channelFacts: [facts({ ageDays: 7 })] }), null).text, "A new channel: no forwards yet.");

  // A second channel still opening doesn't make a three-day-old one idle.
  const opening = channel({ id: "aa:0", status: "pending_open", active: false });
  assert.equal(nodeVerdict(detail({ channels: [channel(), opening], channelFacts: [facts({ ageDays: 3 }), facts({ channelId: "aa:0", ageDays: null })] }), null).text, "A new channel: no forwards yet.");
  // How old it is can't be told (no block height): no word of idle coins.
  const unknownAge = nodeVerdict(detail({ channelFacts: [facts({ ageDays: null })] }), null);
  assert.equal(unknownAge.text, "No forwards in the last 30 days.");
  assert.equal(unknownAge.tone, "neutral");

  // Whether it earned can't be told: no figure, no judgment.
  assert.match(nodeVerdict(detail({ forwardsKnown: false }), null).text, /couldn't be read in full/);

  const short = nodeVerdict(detail({ channels: [channel({ active: false, offline: away(5) })] }), null);
  assert.equal(short.text, "Offline ~5 h. Short outages are common over Tor and usually end on their own.");
  assert.equal(short.tone, "neutral");

  const long = nodeVerdict(detail({ channels: [channel({ active: false, offline: away(216, true) })] }), null);
  assert.equal(long.text, "Offline ~9 d: 3.00M sat of yours can't move until it is back or the channel is closed.");
  assert.equal(long.tone, "warn");

  assert.match(nodeVerdict(detail({ channels: [channel({ status: "pending_open", active: false })] }), null).text, /^A channel is opening/);
  assert.equal(nodeVerdict(detail({ channels: [channel({ status: "pending_close", active: false })] }), null).text, "A channel is closing: 3.00M sat come back on-chain once it confirms.");
  // A force-close: its coins wait out the time-lock.
  assert.equal(
    nodeVerdict(detail({ channels: [channel({ status: "pending_close", active: false, timelockBlocks: 1_440 })] }), null).text,
    "A channel is closing: 3.00M sat come back on-chain after 1440 more blocks (~10 days).",
  );
  assert.equal(nodeVerdict(detail({ isSelf: true, channels: [] }), null).text, "This is your own node.");
});

test("a node without a channel is judged, in words, once the assessment is in", () => {
  const none = detail({ channels: [], channelFacts: [] });
  assert.equal(nodeVerdict(none, null).text, "No channel with this node.");
  assert.equal(nodeVerdict(none, candidate("high", 80)).text, "Looks like a good peer for you: 80/100. About 2.00M sat would fit.");
  assert.equal(nodeVerdict(none, candidate("high", 80)).tone, "good");
  assert.equal(nodeVerdict(none, candidate("medium", 50)).text, "Could work as a peer: 50/100. About 2.00M sat would fit.");
  assert.equal(nodeVerdict(none, candidate("low", 13)).text, "Not a strong candidate for you: 13/100.");
  assert.equal(nodeVerdict(none, candidate("low", 13)).tone, "warn");
  // A high score doesn't outweigh what keeps it off the list: a dead node isn't "good".
  const dead = nodeVerdict(none, { ...candidate("high", 85), notSuggestedBecause: ["none of its channels is enabled", "its last announcement is 365 days old (suggestions stop at 21)"] });
  assert.equal(dead.text, "Not suggested: none of its channels is enabled; its last announcement is 365 days old (suggestions stop at 21).");
  assert.equal(dead.tone, "warn");
  assert.equal(
    nodeVerdict(none, { candidate: null, notSuggestedBecause: ["your node's view of the network doesn't have it"] }).text,
    "No channel with this node. Your node's view of the network doesn't have it.",
  );
  // A channel you closed is part of the answer.
  const closed = detail({ channels: [], channelFacts: [], closedChannels: [{ id: "1x1x1", capacitySats: 1, closedDaysAgo: 40, how: "cooperative", finalLocalSats: 1 }] });
  assert.equal(nodeVerdict(closed, null).text, "No channel with this node. You had a channel with it, closed 40 days ago.");
});

test("the headline by the name", () => {
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.deepEqual(nodeStatus(detail(), now), { text: "online", tone: "good" });
  const connection = { socket: "x", inbound: false, pingMs: 1, connectedSince: "2026-11-08T12:00:00Z", sentBytes: 0, receivedBytes: 0 };
  assert.equal(nodeStatus(detail({ connection }), now).text, "online for ~24 h");
  assert.deepEqual(nodeStatus(detail({ channels: [channel({ active: false, offline: away(216, true) })] }), now), { text: "offline ~9 d", tone: "warn" });
  assert.equal(nodeStatus(detail({ channels: [channel({ active: false })] }), now).text, "offline");
  assert.equal(nodeStatus(detail({ channels: [channel({ status: "pending_open" })] }), now).text, "channel opening");
  assert.equal(nodeStatus(detail({ channels: [channel({ status: "pending_close" })] }), now).text, "channel closing");
  assert.equal(nodeStatus(detail({ channels: [] }), now).text, "no channel");
  assert.equal(nodeStatus(detail({ channels: [], connection }), now).text, "connected, no channel");
  assert.equal(nodeStatus(detail({ isSelf: true }), now).text, "your node");
});

test("figures anyone can read: a fee in percent too, big amounts in BTC, plain ages", () => {
  assert.equal(ppmText(430), "430 ppm (0.043 %)");
  assert.equal(ppmText(4_280), "4,280 ppm (0.428 %)");
  assert.equal(ppmText(1), "1 ppm (0.0001 %)");
  assert.equal(ppmText(0), "0 ppm (0 %)");
  assert.equal(capacityText(120_000_000), "1.20 BTC");
  assert.equal(capacityText(1_800_000), "1.80M sat");
  assert.equal(ageText(null), null);
  assert.equal(ageText(0.5), "less than a day");
  assert.equal(ageText(1.2), "1 day");
  assert.equal(ageText(13.4), "13 days");
  assert.equal(ageText(365), "11 months");
  assert.equal(ageText(840), "2.3 years");
  const now = Date.parse("2026-11-09T12:00:00Z");
  assert.equal(sinceText("2026-11-09T11:40:00Z", now), "~20 min");
  assert.equal(sinceText("2026-11-09T07:00:00Z", now), "~5 h");
  assert.equal(sinceText("2026-11-01T12:00:00Z", now), "~8 d");
  assert.equal(sinceText(null, now), null);
  assert.equal(sinceText("nonsense", now), null);
  assert.equal(sinceText("2027-01-01T00:00:00Z", now), null, "a clock ahead of ours says nothing");
  assert.equal(firstSeenText("2018-04-05T15:13:42.000Z", now), "April 2018 (8.6 years)");
  assert.equal(firstSeenText(null, now), null);
  assert.equal(reachText({ hasClearnet: true, hasOnion: true }), "Tor and clearnet");
  assert.equal(reachText({ hasClearnet: false, hasOnion: true }), "Tor only");
  assert.equal(reachText({ hasClearnet: true, hasOnion: false }), "clearnet only");
  assert.equal(reachText({ hasClearnet: false, hasOnion: false }), "no address announced");
  const place = { firstSeenAt: null, hostedBy: null, closedChannels: null };
  assert.equal(placeText({ ...place, city: "Ashburn", country: "United States" }), "Ashburn, United States");
  assert.equal(placeText({ ...place, city: null, country: "United States" }), "United States");
  assert.equal(placeText({ ...place, city: null, country: null }), null);
});

test("a history line and an earlier channel, in words", () => {
  assert.deepEqual(eventText({ kind: "fee", at: "", channelId: "x", fromPpm: 400, toPpm: 430, via: "autopilot", why: "drains fast — raising toward the market" }), {
    title: "Fee 400 → 430 ppm (autopilot)",
    detail: "drains fast",
  });
  assert.equal(eventText({ kind: "fee", at: "", channelId: "x", fromPpm: null, toPpm: 50, via: "manual", why: null }).title, "Fee 50 ppm (by hand)");
  assert.equal(eventText({ kind: "refill", at: "", channelId: "x", direction: "in", amountSats: 500_000, feeSats: 120, via: "autopilot" }).title, "Refilled with 500.0k sat for 120 sat (autopilot)");
  assert.equal(eventText({ kind: "refill", at: "", channelId: "x", direction: "out", amountSats: 500_000, feeSats: null, via: "manual" }).title, "Gave 500.0k sat to refill another channel (by hand)");
  assert.equal(closedText({ id: "1", capacitySats: 3_000_000, closedDaysAgo: 40, how: "cooperative", finalLocalSats: 1 }), "3.00M sat, closed together, 40 days ago");
  assert.equal(closedText({ id: "1", capacitySats: 3_000_000, closedDaysAgo: null, how: "they_forced", finalLocalSats: 1 }), "3.00M sat, force-closed by them");
});

test("the Channels table's notes: what is worth saying about a channel, nothing else", () => {
  const flow = { forwardCount: 2, inboundForwardCount: 0 };
  const texts = (c: ChannelView, f: typeof flow | undefined = flow, loaded = true) => channelNotes(c, f, loaded).map((n) => n.text);
  const noFlow = (c: ChannelView, loaded = true) => channelNotes(c, undefined, loaded).map((n) => n.text);
  assert.deepEqual(texts(channel()), []);
  assert.deepEqual(noFlow(channel()), ["no forwards in 30 d"]);
  assert.deepEqual(noFlow(channel({ ageDays: 200 })), ["no forwards in 30 d"]);
  assert.deepEqual(noFlow(channel({ ageDays: 3 })), ["new, no forwards yet"], "it hasn't had the time");
  // Not when the report hasn't arrived, or can't tell.
  assert.deepEqual(noFlow(channel(), false), []);
  // A channel away says that, not that it is idle.
  assert.deepEqual(noFlow(channel({ active: false, offline: away(5) })), ["offline ~5 h"]);
  assert.deepEqual(noFlow(channel({ status: "pending_close", timelockBlocks: 79, active: false })), ["pending close · ~79 blks"]);
  assert.deepEqual(noFlow(channel({ status: "pending_open", active: false })), ["pending open · confirming"]);
  assert.deepEqual(texts(channel({ private: true })), ["private"]);
});

test("the table shows four columns; the rest are on request, and a row names its node as a button", () => {
  const html = renderToStaticMarkup(<ChannelTable channels={[channel({ peerAlias: `<script>alert("x")</script>` })]} />);
  const heads = html.slice(html.indexOf("<thead>"), html.indexOf("</thead>"));
  assert.equal((heads.match(/<th[ >]/g) ?? []).length, 4);
  assert.match(heads, />Node</);
  assert.doesNotMatch(heads, /Flow|Routed|Fee now|Autopilot fee/);
  assert.match(html, /More columns/);
  assert.doesNotMatch(html, /<script>/, "an alias is text, whatever it says");
  const src = readFileSync(new URL("../src/components/ChannelTable.tsx", import.meta.url), "utf8");
  for (const id of ["role", "sent", "received", "fee", "auto", "close"]) assert.match(src, new RegExp(`has\\("${id}"\\)`), id);
  // A chosen column stays chosen, in this browser.
  assert.match(src, /writeRemembered\(COLUMNS_KEY/);
  // The controls in a row stay controls.
  assert.equal((src.match(/onClick=\{stay\}/g) ?? []).length, 2);
});

test("a name opens the node: by key, by channel, by alias — and stays plain text when nobody can be placed", () => {
  const key = "02" + "22".repeat(32);
  const opened: unknown[] = [];
  setNodeHandler((t) => opened.push(t));
  rememberChannels([
    { id: "1x1x1", peerPubkey: key, peerAlias: "alias one" },
    { id: "2x2x2", peerPubkey: key, peerAlias: "alias one" },
    { id: "3x3x3", peerPubkey: "03" + "33".repeat(32), peerAlias: "twin" },
    { id: "4x4x4", peerPubkey: "03" + "44".repeat(32), peerAlias: "twin" },
  ]);
  assert.equal(resolveNode({ pubkey: key }), key);
  assert.equal(resolveNode({ channelId: "1x1x1" }), key);
  assert.equal(resolveNode({ alias: "alias one" }), key, "two channels with one peer still name it");
  assert.equal(resolveNode({ alias: "twin" }), undefined, "two peers with one alias name neither");
  assert.equal(resolveNode({ channelId: "9x9x9", alias: "gone" }), undefined);
  assert.equal(resolveNode({ channelId: "9x9x9", alias: "alias one" }), key, "a channel closed since: its alias still names the peer");

  assert.match(renderToStaticMarkup(<NodeLink channelId="1x1x1" alias="alias one" />), /<button type="button" class="node-link"[^>]*>alias one<\/button>/);
  assert.equal(renderToStaticMarkup(<NodeLink channelId="9x9x9" alias="gone" />), "gone");
  assert.equal(renderToStaticMarkup(<NodeLink>a label</NodeLink>), "a label");

  openNode({ pubkey: key, alias: "alias one" });
  assert.deepEqual(opened, [{ pubkey: key, alias: "alias one" }]);
  setNodeHandler(null);
  openNode({ pubkey: key });
  assert.equal(opened.length, 1, "no panel mounted: nothing happens");
});

test("every list that names a node lets it be opened", () => {
  const read = (f: string) => readFileSync(new URL(`../src/components/${f}.tsx`, import.meta.url), "utf8");
  for (const f of ["ChannelTable", "SuggestionsPanel", "CloseCandidatesPanel", "ForwardsPanel", "FeeRecommendations", "RebalanceRecommendations", "AnalyticsPanel", "MarketBuy", "MarketOrders", "LnPlusPanel", "AutopilotPanel"]) {
    assert.match(read(f), /<NodeLink\b/, f);
  }
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /<NodePanelHost \/>/);
  assert.match(app, /rememberChannels\(channels\.data\)/);
  // The form that opens a channel is one, wherever it is shown.
  assert.match(read("SuggestionsPanel"), /<OpenChannelForm\b/);
  assert.match(read("NodePanel"), /<OpenChannelForm\b/);
  // The details stand above the page, and close like every dialog.
  assert.match(read("NodePanel"), /useDialogFocus\(panelRef, true, onClose\)/);
  assert.match(read("NodePanel"), /role="dialog"/);
});

test("key@host:port gives its address to the open form; anything else gives none", () => {
  assert.equal(typedSocket(`02ab@1.2.3.4:9735`), "1.2.3.4:9735");
  assert.equal(typedSocket(` 02ab@abc.onion:9735 `), "abc.onion:9735");
  assert.equal(typedSocket("alpha"), undefined);
  assert.equal(typedSocket("02ab@"), undefined);
  assert.equal(typedSocket(`02ab@${"x".repeat(300)}`), undefined);
});

test("what this browser remembers: a choice stays, junk and blocked storage fall back", () => {
  writeRemembered("t1", "1");
  assert.equal(readRemembered("t1"), "1");
  assert.equal(readRemembered("nope"), null);
  const allowed = ["a", "b", "c"] as const;
  assert.deepEqual(readRememberedList("nope", allowed), []);
  assert.deepEqual(readRememberedList("nope", allowed, ["b"]), ["b"]);
  writeRemembered("t2", JSON.stringify(["c", "gone", "a"]));
  assert.deepEqual(readRememberedList("t2", allowed), ["a", "c"], "only what still exists, in the columns' order");
  writeRemembered("t3", "{not json");
  assert.deepEqual(readRememberedList("t3", allowed, ["a"]), ["a"]);
  writeRemembered("t4", JSON.stringify({ a: 1 }));
  assert.deepEqual(readRememberedList("t4", allowed), []);

  const real = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    assert.equal(readRemembered("t1"), null);
    assert.doesNotThrow(() => writeRemembered("t1", "2"));
  } finally {
    if (real) Object.defineProperty(globalThis, "localStorage", real);
  }
});

test("a dialog over a dialog: only the newest answers the keyboard", () => {
  const src = readFileSync(new URL("../src/a11y.ts", import.meta.url), "utf8");
  assert.match(src, /if \(openDialogs\[openDialogs\.length - 1\] !== self\) return;/);
  assert.match(src, /openDialogs\.splice\(openDialogs\.indexOf\(self\), 1\)/);
  assert.equal(trapTab(0, 3, true), 2);
});

test("Copy works on Umbrel's plain http too, and says 'copied' only when it was: no view calls navigator.clipboard itself", () => {
  const dir = new URL("../src/components/", import.meta.url);
  for (const f of ["PaymentsPanel", "OnchainPanel", "SettingsPanel", "SuggestionsPanel", "MarketSell", "NodePanel"]) {
    const src = readFileSync(new URL(`${f}.tsx`, dir), "utf8");
    assert.doesNotMatch(src, /navigator\.clipboard/, f);
    assert.match(src, /copyText\(/, f);
    assert.doesNotMatch(src, /void copyText\([^)]*\);\s*set\w*Copied\(true\)/, `${f}: an address someone pastes must really be on the clipboard`);
  }
});

test("an open is sent once per node: a form closed and opened again waits with it, a chosen fee stays, and the outcome is said either way", () => {
  const src = readFileSync(new URL("../src/components/OpenChannelForm.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(underWay\.has\(pubkey\)\) return;/);
  assert.match(src, /useState\(\(\) => underWay\.has\(pubkey\)\)/);
  assert.match(src, /ui\.toast\(res\.ok \? `Channel to \$\{alias\} opening\.`/);
  // The estimate, and with it the fee, is read once: no effect on the size.
  assert.doesNotMatch(src, /\}, \[initialSize\]\);/);
});

test("what the details change reaches the lists behind them", () => {
  const read = (f: string) => readFileSync(new URL(`../src/components/${f}.tsx`, import.meta.url), "utf8");
  for (const f of ["ChannelTable", "FeeRecommendations", "RebalanceRecommendations", "SuggestionsPanel"]) assert.match(read(f), /useNodeChanges\(/, f);
  const panel = read("NodePanel");
  assert.match(panel, /notifyNodeChanged\(\{ overrides: saved \}\)/);
  assert.match(panel, /notifyNodeChanged\(\{ neverOpen:/);
  assert.match(panel, /notifyNodeChanged\(\{ channels: true \}\)/);
});
