/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * Closing a channel (review a3-channels:offline-means-force-close,
 * a6-ux:lease-unaware-close — package P4): the Channels table tags leased
 * channels, the close dialog asks before breaking a lease, offers a reconnect
 * before anything for a peer that is away, and a force-close is its own step
 * that says what it does — never one click.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  closeButtons,
  dialogLease,
  forceCloseConsequences,
  leaseBreakWarning,
  leaseLeft,
  leaseRefusal,
  leaseTag,
  offlineLabel,
  refusedLease,
  shortOutage,
  type CloseTarget,
} from "../src/closeView";
import { CloseChannelDialog, ForceCloseConfirm } from "../src/components/CloseChannelDialog";
import { ChannelTable } from "../src/components/ChannelTable";
import { OverlayProvider } from "../src/components/Overlay";
import type { ChannelLease, ChannelView, OfflineInfo } from "../src/types";

const lease = (o: Partial<ChannelLease> = {}): ChannelLease => ({
  kind: "magma_sale",
  orderId: "magma-order-1",
  leaseBlocks: 8_640,
  untilHeight: 863_024,
  blocksLeft: 5_904, // 41 days
  untilApprox: "2026-12-01T00:00:00.000Z",
  running: true,
  ...o,
});
const away = (hours: number, long = hours >= 72): OfflineInfo => ({ since: "2026-10-21T00:00:00.000Z", hours, uptimeShare: null, long });
const target = (o: Partial<CloseTarget> = {}): CloseTarget => ({
  peerAlias: "router",
  peerPubkey: "02" + "ab".repeat(32),
  capacity: 2_000_000,
  localBalance: 1_500_000,
  initiator: "local",
  active: true,
  transactionId: "aa".repeat(32),
  transactionVout: 0,
  csvDelayBlocks: 144,
  commitFeeSats: 2_810,
  ...o,
});

test("leased channels are tagged with what they are and how long the lease has left; an ended sale's tag goes, a bought one says its lease is over", () => {
  assert.equal(leaseTag(lease()), "Magma lease · ~41 d left");
  assert.equal(leaseTag(lease({ kind: "lsps1_sale", blocksLeft: 30 })), "LSP lease · ~5 h left");
  assert.equal(leaseTag(lease({ kind: "magma_purchase" })), "bought on Magma · ~41 d left");
  assert.equal(leaseTag(lease({ untilHeight: null, blocksLeft: null })), "Magma lease · funding not confirmed yet");
  // Review of P4: a confirmed lease (its end known) whose time left is unknown
  // only because the block height wasn't read is no unconfirmed funding.
  assert.equal(leaseTag(lease({ untilHeight: 900_000, blocksLeft: null })), "Magma lease · time left unknown (block height not read)");
  assert.match(leaseBreakWarning(lease({ untilHeight: 900_000, blocksLeft: null })) ?? "", /until block 900,000 \(time left unknown \(block height not read\)\)/);
  assert.equal(leaseTag(lease({ running: false, blocksLeft: -10 })), null);
  assert.equal(leaseTag(lease({ kind: "magma_purchase", running: false })), "bought on Magma · lease over");
  assert.equal(leaseTag(null), null);
  // A sale only Amboss knows of (no journal record): its end is Amboss's to say.
  const amboss = lease({ untilHeight: null, blocksLeft: null, reportedByAmboss: true });
  assert.equal(leaseTag(amboss), "Magma lease · running (per Amboss)");
  assert.match(leaseBreakWarning(amboss) ?? "", /^This channel was sold on Magma and is leased for as long as Amboss reports its lease running\./);
  const table = renderToStaticMarkup(
    <ChannelTable
      channels={[
        {
          id: "855000x1x0", peerPubkey: "02" + "11".repeat(32), peerAlias: "buyer", active: false, private: false, initiator: "local",
          capacity: 2_000_000, transactionId: "11".repeat(32), transactionVout: 0, localBalance: 2_000_000, remoteBalance: 0, localRatio: 1,
          totalSent: 0, totalReceived: 0, unsettled: 0, status: "open", role: "router", lease: lease(), offline: away(5),
        } as ChannelView,
      ]}
    />,
  );
  assert.match(table, /Magma lease · ~41 d left/);
  assert.match(table, /offline ~5 h/);
});

test("closing inside a lease says what it breaks — per kind", () => {
  assert.match(leaseBreakWarning(lease()) ?? "", /^This channel was sold on Magma and is leased until block 863,024 \(~41 d left\)\. Closing it now breaks the lease the buyer paid for — and Amboss counts that against your seller score\.$/);
  assert.match(leaseBreakWarning(lease({ kind: "lsps1_sale" })) ?? "", /^This channel was sold to an LSP client, and this node promised to keep it open until block 863,024/);
  assert.match(leaseBreakWarning(lease({ kind: "magma_purchase", costSats: 18_012 })) ?? "", /^You bought this channel on Magma for 18,012 sat; its lease runs until block 863,024 \(~41 d left\)\. Closing it now throws away the inbound you paid for\.$/);
  assert.equal(leaseBreakWarning(lease({ running: false })), null);
  assert.equal(
    leaseRefusal({ status: 409, body: { error: "lease_active", message: "Not closed: this channel was sold on Magma …" } }),
    "Not closed: this channel was sold on Magma …",
  );
  assert.equal(leaseRefusal({ status: 409, body: { error: "busy" } }), null);
});

test("a force-close says what it does before the button that sends it: the time-lock, a fee nobody can choose, the sweep, HTLCs on-chain — the lease it breaks, and that a short outage may simply end", () => {
  const lines = forceCloseConsequences(target({ active: false, offline: away(5), lease: lease() }), 4);
  assert.deepEqual(lines, [
    "Your 1.50M sat come back on-chain only after a time-lock of 144 blocks (~1 day) — not spendable before.",
    "The closing fee was fixed when the channel last updated (~2,810 sat in the commitment transaction, paid from your side — you opened it): you can't choose it, and in a busy mempool LND may have to add a fee bump.",
    "Claiming your funds after the time-lock is one more on-chain transaction (~440 sat at today's economy rate).",
    "Payments in flight through the channel are settled on-chain — more fees, more waiting.",
    "This channel was sold on Magma and is leased until block 863,024 (~41 d left). Closing it now breaks the lease the buyer paid for — and Amboss counts that against your seller score.",
    "The peer has been offline for only ~5 h — most outages end on their own. Reconnecting, or waiting and closing cooperatively, costs far less.",
  ]);
  // Unknown CSV: the worst case LND allows.
  assert.match(forceCloseConsequences(target({ csvDelayBlocks: null }), null)[0], /up to 2,016 blocks, ~2 weeks/);
  assert.equal(shortOutage(target({ active: false, offline: away(5) })), true);
  assert.equal(shortOutage(target({ active: false, offline: away(100) })), false);
  assert.equal(offlineLabel(away(100)), "offline ~4 d");
  assert.equal(offlineLabel({ since: null, hours: null, uptimeShare: 0.3, long: true }), "online 30% of the time");
  assert.equal(offlineLabel(null), null);

  const confirm = renderToStaticMarkup(
    <ForceCloseConfirm peerAlias="router" consequences={lines} busy={false} onBack={() => undefined} onConfirm={() => undefined} />,
  );
  assert.match(confirm, /Force-close the channel with router\?/);
  assert.match(confirm, /time-lock of 144 blocks/);
  assert.match(confirm, />Back</);
  assert.match(confirm, />Force-close now</);
});

/** The dialog as it first renders (before the fee estimates arrive). */
const dialog = (t: CloseTarget) =>
  renderToStaticMarkup(
    <OverlayProvider>
      <CloseChannelDialog channel={t} onCancel={() => undefined} onClosed={() => undefined} />
    </OverlayProvider>,
  );

test("the close dialog never force-closes in one click: online and offline alike it opens the confirmation step — and a briefly offline peer is offered a reconnect first", () => {
  const online = dialog(target());
  assert.match(online, /Force-close…/);
  assert.doesNotMatch(online, />Force-close</, "no one-click force-close");
  assert.doesNotMatch(online, /Force-close now/);

  const offline = dialog(target({ active: false, offline: away(5) }));
  assert.match(offline, />Reconnect</);
  assert.match(offline, /The peer is offline \(~5 h\), so a cooperative close isn’t possible right now\. A short outage is no reason to close: reconnect, or wait for the peer to come back and close cooperatively\./);
  assert.doesNotMatch(offline, />Force-close</);
  assert.match(offline, /Force-close…/);
  // Before: "The peer is offline … A force-close works" with only a Force-close button.
  assert.doesNotMatch(offline, /A force-close works/);
});

test("a leased channel: the dialog says what closing breaks, and no close button works until the operator ticks 'close it anyway' — what the request then carries", () => {
  const leased = dialog(target({ lease: lease() }));
  assert.match(leased, /This channel was sold on Magma and is leased until block 863,024/);
  assert.match(leased, /I understand — close it anyway and break the lease/);
  assert.match(leased, /<button class="row-btn ghost danger" disabled="">Force-close…<\/button>/, "the force-close step is locked too");
  const free = dialog(target());
  assert.match(free, /<button class="row-btn ghost danger">Force-close…<\/button>/);
  const src = readFileSync(new URL("../src/components/CloseChannelDialog.tsx", import.meta.url), "utf8");
  // "Force-close…" only opens the confirmation step; only "Force-close now" there sends it.
  assert.match(src, /disabled=\{!can\.force\} onClick=\{\(\) => setStep\("force"\)\}>\s*Force-close…/);
  // The cooperative close is held by the same rule (closeButtons, below).
  assert.match(src, /disabled=\{!can\.coop\} onClick=\{\(\) => void doClose\(false\)\}/);
  assert.match(src, /const can = closeButtons\(\{ busy: busy !== null, rate, lease, breakLease \}\)/);
  assert.equal(src.match(/doClose\(true\)/g)?.length, 1, "one force-close call: the confirmation step's");
  assert.match(src, /onConfirm=\{\(\) => void doClose\(true\)\}/);
  assert.match(src, /api\.channelClose\(\s*channel\.transactionId,\s*channel\.transactionVout,\s*force,\s*force \? undefined : rate,\s*leaseWarning !== null && breakLease,\s*\)/);
});

test("the close buttons with a fee rate set: a running lease holds the cooperative close AND the force-close step until 'close it anyway' is ticked", () => {
  // (The static render above has no fee rate yet, so its cooperative button
  // is disabled anyway — this is the rule itself.)
  const running = lease();
  assert.deepEqual(closeButtons({ busy: false, rate: 4, lease: running, breakLease: false }), { coop: false, force: false });
  assert.deepEqual(closeButtons({ busy: false, rate: 4, lease: running, breakLease: true }), { coop: true, force: true });
  assert.deepEqual(closeButtons({ busy: false, rate: 4, lease: null, breakLease: false }), { coop: true, force: true });
  assert.deepEqual(closeButtons({ busy: false, rate: 4, lease: lease({ running: false }), breakLease: false }), { coop: true, force: true }, "an ended lease holds nothing");
  assert.deepEqual(closeButtons({ busy: false, rate: 0, lease: null, breakLease: false }), { coop: false, force: true }, "no fee rate: no cooperative close");
  assert.deepEqual(closeButtons({ busy: true, rate: 4, lease: null, breakLease: true }), { coop: false, force: false });
});

test("a close the server refuses for a lease the dialog didn't know: the lease it names is shown, with its 'close it anyway' box — never a dead end", () => {
  const named = lease({ kind: "magma_purchase", costSats: 18_012 });
  const refusal = { status: 409, body: { error: "lease_active", message: "Not closed: this channel was bought on Magma …", lease: named } };
  assert.deepEqual(refusedLease(refusal), named);
  assert.equal(refusedLease({ status: 409, body: { error: "lease_active", message: "…" } }), null, "no lease named");
  assert.equal(refusedLease({ status: 409, body: { error: "busy", lease: named } }), null);
  assert.equal(refusedLease({ status: 409, body: { error: "lease_active", lease: { ...named, running: false } } }), null);
  // The channel itself had none (the table showed it unleased): the named one is asked about …
  const unleased = target({ lease: null });
  assert.deepEqual(dialogLease(unleased, refusedLease(refusal)), named);
  assert.match(leaseBreakWarning(dialogLease(unleased, named)) ?? "", /^You bought this channel on Magma for 18,012 sat/);
  assert.deepEqual(closeButtons({ busy: false, rate: 4, lease: dialogLease(unleased, named), breakLease: false }), { coop: false, force: false });
  // … while a running lease of its own comes first.
  assert.deepEqual(dialogLease(target({ lease: lease() }), named), lease());
  assert.equal(dialogLease(target(), null), null);
  // The dialog keeps the named lease and offers the box again (its source).
  const src = readFileSync(new URL("../src/components/CloseChannelDialog.tsx", import.meta.url), "utf8");
  assert.match(src, /const named = refusedLease\(e\);\s*if \(named\) \{\s*setRefused\(named\);\s*setBreakLease\(false\);/);
  assert.match(src, /const lease = dialogLease\(channel, refused\);\s*const leaseWarning = leaseBreakWarning\(lease\);/);
});

test("a sale only Amboss's listing knows: an old listing says from when it is", () => {
  const nowMs = Date.parse("2026-10-21T12:00:00.000Z");
  assert.equal(leaseLeft({ blocksLeft: null, reportedByAmboss: true, reportedAt: "2026-10-21T11:00:00.000Z" }, nowMs), "running (per Amboss)");
  assert.equal(leaseLeft({ blocksLeft: null, reportedByAmboss: true, reportedAt: "2026-10-18T09:00:00.000Z" }, nowMs), "running (per Amboss, 2026-10-18)");
});
