/**
 * The close list (review a3-channels:close-list-leased-and-pending,
 * a3-channels:offline-means-force-close, a4-lsp-payments:lease-unaware-close-
 * suggestions, a6-ux:lease-unaware-close — package P4).
 *
 * Before:
 *  - a channel still opening (a just-funded routing, Magma or LSPS1 open) was
 *    listed FIRST, as "Offline — peer unreachable", its whole balance counted
 *    as capital to free, with only a force-close offered;
 *  - a channel sold on Magma or over LSPS1, or bought on Magma, became a close
 *    candidate after 30 days — mid-lease ("Frees 2000k you could redeploy");
 *  - a bought channel past its lease read "free inbound it provided";
 *  - a peer offline for a moment lost the "routed recently" and "unique reach"
 *    protections, scored as the strongest close signal and went to the top.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { rankCloseCandidates, type CloseInput } from "../src/services/suggestRecommend.js";
import { channelLeases, leaseLeftText, leaseProtection, standardChannelId, type ChannelLease } from "../src/services/leases.js";
import { ChannelUptime, MAX_GAP_MS, OFFLINE_CLOSE_SIGNAL_HOURS, type OfflineInfo } from "../src/services/channelUptime.js";
import type { ChannelView } from "../src/services/channels.js";
import type { FeeRecommendation } from "../src/services/feeRecommend.js";
import type { MagmaPurchase } from "../src/services/magmaPurchases.js";
import { makeTempDir } from "./helpers/tmp.js";

const HEIGHT = 860_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

/** A channel funded `ageBlocks` ago (open), or still opening (`pending`). */
function chan(n: number, o: Partial<ChannelView> & { ageBlocks?: number; pending?: boolean } = {}): ChannelView {
  const { ageBlocks = 8_000, pending = false, ...rest } = o;
  const capacity = rest.capacity ?? 2_000_000;
  const local = rest.localBalance ?? 2_000_000;
  return {
    id: pending ? `${TX(n)}:0` : `${HEIGHT - ageBlocks}x${n}x0`,
    peerPubkey: PEER(n),
    peerAlias: `peer-${n}`,
    active: !pending,
    private: false,
    initiator: "local",
    capacity,
    transactionId: TX(n),
    transactionVout: 0,
    localBalance: local,
    remoteBalance: capacity - local,
    localRatio: local / capacity,
    totalSent: 0,
    totalReceived: 0,
    unsettled: 0,
    status: pending ? "pending_open" : "open",
    role: "router",
    csvDelayBlocks: 144,
    commitFeeSats: 2_810,
    ...rest,
  };
}

/** The fee engine's view of a channel (only what the close list reads). */
const feeOf = (c: ChannelView, o: { routed30?: number; ageDays?: number; topEarner?: boolean; state?: string } = {}) =>
  ({
    channelId: c.id,
    state: o.state ?? "normal",
    metrics: {
      routedOut30d: o.routed30 ?? 0,
      routedIn30d: 0,
      revenue30d: 0,
      channelAgeDays: o.ageDays ?? 55,
      isTopEarner: o.topEarner ?? false,
      peerGate: "ok",
    },
  }) as unknown as FeeRecommendation;

function input(channels: ChannelView[], o: Partial<CloseInput> = {}): CloseInput {
  return {
    channels,
    feeById: new Map(channels.map((c) => [c.id, feeOf(c)])),
    flow60ById: new Map(),
    uniqueReachByChan: new Map(channels.map((c) => [c.id, 0])),
    opportunity: [{ alias: "next-peer", score: 70, sizeSats: 2_000_000 }],
    closeCostSat: 500,
    rebalanceRecords: [],
    channelOverrides: {},
    leases: new Map(),
    offline: () => null,
    nowMs: Date.now(),
    ...o,
  };
}

// ── the lease registry ────────────────────────────────────────────────────────

const purchase = (o: Partial<MagmaPurchase>): MagmaPurchase => ({
  orderId: "buy-order-1",
  // Quoted ten minutes before it was paid: a purchase's channel is never
  // older than its order (the registry reads this).
  createdAt: new Date(Date.now() - 5 * DAY - 10 * 60_000).toISOString(),
  updatedAt: new Date().toISOString(),
  offerId: null,
  sellerPubkey: PEER(7),
  sizeSats: 3_000_000,
  feeSats: 18_000,
  paymentRequest: "lnbc1",
  paymentHash: "aa".repeat(32),
  payee: PEER(7),
  expiresAt: new Date().toISOString(),
  leaseBlocks: 8_640,
  feeRateCapPpm: 2200,
  baseFeeCapSats: 1,
  usdCents: null,
  state: "channel_open",
  routingFeeSats: 12,
  paidAt: new Date(Date.now() - 5 * DAY).toISOString(),
  orderStatus: "VALID_CHANNEL_OPENING",
  channelId: null,
  ...o,
});

test("the lease registry: Magma and LSPS1 sales by funding outpoint, purchases by Amboss's channel id (either form) or the seller's channel of that size — each lease measured like the fee promise", () => {
  const magmaSale = chan(1, { ageBlocks: 5_000 });
  const lspSale = chan(2, { ageBlocks: 9_000 });
  const bought = chan(3, { ageBlocks: 700, initiator: "remote", peerPubkey: PEER(7), capacity: 3_000_000, localBalance: 0 });
  const opening = chan(4, { pending: true });
  const plain = chan(5);
  const sources = {
    soldLeases: [
      { fundingOutpoint: `${TX(1)}:0`, source: "magma" as const, orderId: "magma-order", leaseBlocks: 8_640 },
      { fundingOutpoint: `${TX(2)}:0`, source: "lsps1" as const, orderId: "lsp-order", leaseBlocks: 12_960 },
      { fundingOutpoint: `${TX(4)}:0`, source: "magma" as const, orderId: "fresh-sale", leaseBlocks: 4_320 },
    ],
    purchases: [purchase({ channelId: standardNumber(bought.id) })],
  };
  const leases = channelLeases([magmaSale, lspSale, bought, opening, plain], sources, HEIGHT);
  const m = leases.get(magmaSale.id) as ChannelLease;
  // Funded at 855,000: 8,640 blocks + Amboss's day of margin.
  assert.deepEqual([m.kind, m.untilHeight, m.blocksLeft, m.running], ["magma_sale", 855_000 + 8_640 + 144, 8_640 + 144 - 5_000, true]);
  const l = leases.get(lspSale.id) as ChannelLease;
  assert.deepEqual([l.kind, l.untilHeight, l.running], ["lsps1_sale", 851_000 + 12_960, true], "this node's own count: no margin");
  const b = leases.get(bought.id) as ChannelLease;
  assert.deepEqual([b.kind, b.orderId, b.costSats, b.running], ["magma_purchase", "buy-order-1", 18_012, true]);
  const p = leases.get(opening.id) as ChannelLease;
  assert.deepEqual([p.untilHeight, p.blocksLeft, p.running], [null, null, true], "not confirmed yet: inside its lease");
  assert.equal(leases.has(plain.id), false);

  // Without a channel id, the seller's channel of the size bought — and
  // over a while later (9,000 blocks, and the clock with them), the lease
  // has ended.
  const later = channelLeases([bought], { soldLeases: [], purchases: [purchase({ channelId: null })] }, HEIGHT + 9_000, Date.now() + 9_000 * 600_000);
  // Funded at 859,300: 8,640 + 144 blocks → block 868,084; now 869,000.
  assert.deepEqual([later.get(bought.id)?.running, later.get(bought.id)?.blocksLeft], [false, -916]);
  // A purchase that was never paid, or from another seller, claims nothing.
  assert.equal(channelLeases([bought], { soldLeases: [], purchases: [purchase({ state: "quoted" })] }, HEIGHT).size, 0);
  assert.equal(channelLeases([bought], { soldLeases: [], purchases: [purchase({ sellerPubkey: PEER(9) })] }, HEIGHT).size, 0);
  // Height unknown (LND didn't say): every lease reads as running.
  assert.equal(channelLeases([magmaSale], sources, 0).get(magmaSale.id)?.running, true);
  assert.equal(standardChannelId("945477745306042368"), "859907x1x0");
  assert.equal(standardChannelId("859907x1x0"), "859907x1x0");
  assert.equal(standardChannelId("nonsense"), null);
});

test("a sale the journal never recorded, which Amboss lists with its lease running, is protected too — until Amboss says the lease is over", () => {
  const legacy = chan(6, { ageBlocks: 9_000 });
  const leases = channelLeases([legacy], { soldLeases: [], purchases: [], ambossRunning: [{ orderId: "legacy-sale-6", channelId: standardNumber(legacy.id) }] }, HEIGHT);
  const l = leases.get(legacy.id) as ChannelLease;
  assert.deepEqual([l.kind, l.running, l.reportedByAmboss, l.untilHeight], ["magma_sale", true, true, null]);
  const report = rankCloseCandidates(input([legacy], { leases }));
  assert.deepEqual(report.candidates, []);
  assert.match(report.protected[0].reason, /^sold on Magma \(order legacy-s…\) — Amboss reports its lease still running; closing it early breaks the lease the buyer paid for/);
  // Where both know the channel and the journal's count still runs, the
  // journal's record (with its known end) stands.
  const both = channelLeases(
    [legacy],
    { soldLeases: [{ fundingOutpoint: `${TX(6)}:0`, source: "magma", orderId: "journal-sale", leaseBlocks: 25_920 }], purchases: [], ambossRunning: [{ orderId: "legacy-sale-6", channelId: legacy.id }] },
    HEIGHT,
  );
  assert.deepEqual([both.get(legacy.id)?.orderId, both.get(legacy.id)?.reportedByAmboss], ["journal-sale", undefined]);
});

/** LND's numeric channel id for "BxTxO". */
function standardNumber(id: string): string {
  const [b, t, o] = id.split("x").map((x) => BigInt(x));
  return ((b << 40n) | (t << 16n) | o).toString();
}

// ── review 2 of P4: named purchases claim first, no channel older than its
//    order, and Amboss's word on a sale's lease counts ────────────────────────

/** A channel the seller (PEER(7)) opened to us: 3M, all inbound. */
const sellers = (n: number, o: { ageBlocks?: number; pending?: boolean } = {}) =>
  chan(n, { ...o, initiator: "remote", peerPubkey: PEER(7), capacity: 3_000_000, localBalance: 0 });

test("a repeat order from the same seller at the same size, paid but its channel not open yet, never takes the channel Amboss named for the earlier order — and claims its own once it is opening", () => {
  const nowMs = Date.now();
  const ago = (ms: number) => new Date(nowMs - ms).toISOString();
  // X: bought 150 days ago as order B with a 180-day lease — a month left.
  const X = sellers(41, { ageBlocks: 21_600 });
  const B = purchase({ orderId: "older-B-180d", leaseBlocks: 25_920, channelId: standardNumber(X.id), createdAt: ago(150 * DAY + 600_000), paidAt: ago(150 * DAY) });
  // A: the same seller and size, its payment sent minutes ago — held by the
  // hold invoice ("paying") until Amboss confirms the channel; Amboss names
  // no channel yet.
  const A = purchase({ orderId: "newer-A-30d", leaseBlocks: 4_320, channelId: null, state: "paying", orderStatus: "WAITING_FOR_CHANNEL_OPEN", createdAt: ago(1_200_000), paidAt: undefined, payStartedAt: ago(600_000), routingFeeSats: null });
  for (const purchases of [[B, A], [A, B]]) {
    const l = channelLeases([X], { soldLeases: [], purchases }, HEIGHT, nowMs).get(X.id);
    // Before: A (the newest) came first and took X — B's lease was lost, X
    // read "a 30-day lease that ended at block 842,864", and closed unasked.
    // Funded at 838,400: 25,920 + 144 blocks → block 864,464.
    assert.deepEqual([l?.orderId, l?.running, l?.untilHeight, l?.blocksLeft, l?.costSats], ["older-B-180d", true, 864_464, 4_464, 18_012]);
  }
  // A's channel is opening now: A claims that one, X keeps B's lease.
  const opening = sellers(42, { pending: true });
  const both = channelLeases([X, opening], { soldLeases: [], purchases: [A, B] }, HEIGHT, nowMs);
  assert.deepEqual([both.get(X.id)?.orderId, both.get(opening.id)?.orderId, both.get(opening.id)?.running, both.get(opening.id)?.untilHeight], ["older-B-180d", "newer-A-30d", true, null]);

  // Named first even where the channel's age can't tell them apart: B2
  // ordered 3 days ago, A2 a day later, and the seller funded B2's channel
  // yesterday — after both orders.
  const X2 = sellers(43, { ageBlocks: 144 });
  const B2 = purchase({ orderId: "older-B2-90d", leaseBlocks: 12_960, channelId: standardNumber(X2.id), createdAt: ago(3 * DAY + 600_000), paidAt: ago(3 * DAY) });
  const A2 = purchase({ orderId: "newer-A2-30d", leaseBlocks: 4_320, channelId: null, state: "paying", orderStatus: "WAITING_FOR_CHANNEL_OPEN", createdAt: ago(2 * DAY + 600_000), paidAt: undefined, payStartedAt: ago(2 * DAY), routingFeeSats: null });
  const l2 = channelLeases([X2], { soldLeases: [], purchases: [A2, B2] }, HEIGHT, nowMs).get(X2.id);
  assert.deepEqual([l2?.orderId, l2?.untilHeight], ["older-B2-90d", 859_856 + 12_960 + 144]);
});

// Review of P4 (PROBE-F06): the purchases Amboss names no channel for are
// matched newest first. Walked oldest first, the older order's 180-day lease
// claimed the NEWER channel, the newer order couldn't take the older channel
// (funded before it was placed) — and the older order's real channel was left
// with no lease at all: unprotected in the close list and the close route.
test("two purchases of one seller and size, neither named by Amboss yet: each claims its own channel — newest order to newest channel — whatever order the ledger lists them in", () => {
  const nowMs = Date.now();
  const ago = (ms: number) => new Date(nowMs - ms).toISOString();
  // P1 ordered 20 days ago (a 180-day lease), its channel C1 funded 19 days ago;
  // P2 ordered 5 days ago, its channel C2 funded 4 days ago.
  const P1 = purchase({ orderId: "P1-older", leaseBlocks: 25_920, createdAt: ago(20 * DAY), paidAt: ago(19 * DAY) });
  const P2 = purchase({ orderId: "P2-newer", leaseBlocks: 4_320, createdAt: ago(5 * DAY), paidAt: ago(4 * DAY) });
  const C1 = sellers(61, { ageBlocks: 2_736 });
  const C2 = sellers(62, { ageBlocks: 576 });
  for (const purchases of [[P1, P2], [P2, P1]]) {
    const l = channelLeases([C1, C2], { soldLeases: [], purchases }, HEIGHT, nowMs);
    assert.deepEqual([l.get(C1.id)?.orderId, l.get(C2.id)?.orderId], ["P1-older", "P2-newer"], purchases.map((p) => p.orderId).join(","));
    assert.equal(l.get(C1.id)?.untilHeight, HEIGHT - 2_736 + 25_920 + 144, "C1 keeps P1's 180-day lease");
  }
});

// Review of P4: a lease whose funding HAS confirmed (its end is known) read
// "funding not confirmed yet" whenever only LND's block height was unknown.
test("a confirmed lease whose time left is unknown (no block height) says that — not 'funding not confirmed yet'", () => {
  const sale = chan(1, { ageBlocks: 5_000 });
  const opening = chan(4, { pending: true });
  const sources = {
    soldLeases: [
      { fundingOutpoint: `${TX(1)}:0`, source: "magma" as const, orderId: "magma-order", leaseBlocks: 8_640 },
      { fundingOutpoint: `${TX(4)}:0`, source: "magma" as const, orderId: "fresh-sale", leaseBlocks: 4_320 },
    ],
    purchases: [],
  };
  // currentHeight 0: LND didn't say (the API's currentHeight() fallback).
  const leases = channelLeases([sale, opening], sources, 0);
  const confirmed = leases.get(sale.id) as ChannelLease;
  assert.deepEqual([confirmed.untilHeight, confirmed.blocksLeft, confirmed.running], [855_000 + 8_640 + 144, null, true]);
  const text = leaseProtection(confirmed);
  assert.doesNotMatch(text, /funding not confirmed/, text);
  assert.match(text, /leased until block 863,784 \(time left unknown: the current block height couldn't be read\)/);
  // A channel still opening: its funding really hasn't confirmed.
  assert.match(leaseProtection(leases.get(opening.id) as ChannelLease), /until its funding confirms and the lease has run/);
  assert.equal(leaseLeftText({ blocksLeft: null, untilHeight: null }), "funding not confirmed yet");
});

// Review of P4: BOUGHT_STATES left out "paying" — a hold-invoice purchase
// whose seller channel was confirming carried no lease until Amboss's
// VALID_CHANNEL_OPENING. Decided: protected (fail closed), and said so.
test("a purchase still being paid protects the seller's channel it pays for — saying a close cancels the purchase; one LND confirmed failed claims nothing", () => {
  const nowMs = Date.now();
  const ago = (ms: number) => new Date(nowMs - ms).toISOString();
  const confirming = sellers(63, { ageBlocks: 2 }); // funded two blocks ago
  const paying = purchase({ orderId: "paying-1", state: "paying", orderStatus: "WAITING_FOR_ON_CHAIN_CONFIRMATION", channelId: null, createdAt: ago(3 * 3_600_000), paidAt: undefined, payStartedAt: ago(2 * 3_600_000), routingFeeSats: null });
  const l = channelLeases([confirming], { soldLeases: [], purchases: [paying] }, HEIGHT, nowMs).get(confirming.id);
  assert.deepEqual([l?.orderId, l?.running, l?.paying], ["paying-1", true, true]);
  assert.equal(
    leaseProtection(l!),
    "being bought on Magma for 18,000 sat (order paying-1…) — your payment is held until Amboss confirms this channel; closing it now cancels the purchase (Amboss refunds the payment) and gives up the inbound",
  );
  const [c] = rankCloseCandidates(input([confirming], { leases: channelLeases([confirming], { soldLeases: [], purchases: [paying] }, HEIGHT, nowMs) })).protected;
  assert.deepEqual([c?.channelId, c?.lease?.paying], [confirming.id, true], "kept out of the close list by the purchase");
  assert.match(c?.reason ?? "", /^being bought on Magma/);
  // A failure only the pay call reported may still be in flight: protected too.
  const unclear = { ...paying, state: "pay_failed" as const, failureConfirmed: undefined };
  assert.equal(channelLeases([confirming], { soldLeases: [], purchases: [unclear] }, HEIGHT, nowMs).get(confirming.id)?.orderId, "paying-1");
  // LND's word that it failed: nothing bought, nothing claimed.
  const failed = { ...paying, state: "pay_failed" as const, failureConfirmed: true };
  assert.equal(channelLeases([confirming], { soldLeases: [], purchases: [failed] }, HEIGHT, nowMs).size, 0);
});

test("a purchase Amboss hasn't named a channel for never takes a channel the seller funded before the order was placed — an estimate from the clock, with slack for fast blocks", () => {
  const nowMs = Date.now();
  const ago = (ms: number) => new Date(nowMs - ms).toISOString();
  const A = purchase({ orderId: "newer-A-30d", leaseBlocks: 4_320, channelId: null, state: "paying", orderStatus: "WAITING_FOR_CHANNEL_OPEN", createdAt: ago(1_200_000), paidAt: undefined, payStartedAt: ago(600_000), routingFeeSats: null });
  // Z: a channel the seller opened to us on its own 150 days ago — no
  // purchase on record names it. Before, A took it while A's own channel
  // was not open yet: Z read "bought on Magma" with A's cost and lease.
  const Z = sellers(44, { ageBlocks: 21_600 });
  const leases = channelLeases([Z], { soldLeases: [], purchases: [A] }, HEIGHT, nowMs);
  assert.equal(leases.size, 0);
  const [c] = rankCloseCandidates(input([Z], { leases })).candidates;
  assert.ok(c.warnings.some((w) => /^Peer opened this channel — closing gives up 3,000k of free inbound liquidity it provided\.$/.test(w)), c.warnings.join(" | "));

  // The boundary: ordered exactly 3 days (432 blocks) ago, the slack is a
  // day plus a tenth (144 + 44 blocks): funded 620 blocks ago may be its
  // channel, 621 blocks ago can't.
  const C = purchase({ orderId: "order-C", channelId: null, createdAt: ago(3 * DAY), paidAt: ago(3 * DAY - 600_000) });
  assert.equal(channelLeases([sellers(45, { ageBlocks: 620 })], { soldLeases: [], purchases: [C] }, HEIGHT, nowMs).size, 1);
  assert.equal(channelLeases([sellers(46, { ageBlocks: 621 })], { soldLeases: [], purchases: [C] }, HEIGHT, nowMs).size, 0);
  // A record from 150 days ago (21,600 blocks at 10 minutes each) whose
  // channel was funded 22,600 blocks ago, a day after the order: blocks came
  // ~5 % faster than one per 10 minutes. Still its channel — a day's slack
  // alone would have dropped it.
  const old = purchase({ orderId: "old-order", channelId: null, createdAt: ago(150 * DAY), paidAt: ago(150 * DAY - 600_000) });
  const oldChannel = sellers(47, { ageBlocks: 22_600 });
  assert.equal(channelLeases([oldChannel], { soldLeases: [], purchases: [old] }, HEIGHT, nowMs).get(oldChannel.id)?.orderId, "old-order");
});

test("a sale whose lease is over by the journal's own count while Amboss still lists it running stays protected — Amboss says when it ends", () => {
  // Sold with a 30-day lease and funded 32 days ago (4,608 blocks): by the
  // journal's count — funding + 4,320 + a day — over 144 blocks ago. Amboss
  // confirmed the channel late (the transaction reported during an outage):
  // its monitoring, and the lease, still run.
  const X = chan(9, { ageBlocks: 4_608 });
  const soldLeases = [{ fundingOutpoint: `${TX(9)}:0`, source: "magma" as const, orderId: "sale-1", leaseBlocks: 4_320 }];
  const listedAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const journalOnly = channelLeases([X], { soldLeases, purchases: [] }, HEIGHT);
  assert.deepEqual([journalOnly.get(X.id)?.running, journalOnly.get(X.id)?.blocksLeft], [false, -144]);
  assert.deepEqual(rankCloseCandidates(input([X], { leases: journalOnly })).candidates.map((c) => c.channelId), [X.id], "the journal alone: a channel like any other");

  const leases = channelLeases([X], { soldLeases, purchases: [], ambossRunning: [{ orderId: "sale-1", channelId: standardNumber(X.id) }], ambossListedAt: listedAt }, HEIGHT);
  const l = leases.get(X.id) as ChannelLease;
  // Before: the ended record kept Amboss's word out — running: false.
  assert.deepEqual(
    [l.kind, l.orderId, l.leaseBlocks, l.running, l.reportedByAmboss, l.reportedAt, l.untilHeight, l.blocksLeft, l.untilApprox],
    ["magma_sale", "sale-1", 4_320, true, true, listedAt, null, null, null],
  );
  const report = rankCloseCandidates(input([X], { leases }));
  assert.deepEqual(report.candidates, []);
  assert.match(report.protected[0].reason, /^sold on Magma \(order sale-1…\) — Amboss reports its lease still running; closing it early breaks the lease the buyer paid for/);

  // Amboss listing another order on the channel of an ended record: that
  // order's lease, as for any sale the journal never recorded.
  const other = channelLeases([X], { soldLeases, purchases: [], ambossRunning: [{ orderId: "other-order", channelId: X.id }], ambossListedAt: listedAt }, HEIGHT).get(X.id);
  assert.deepEqual([other?.orderId, other?.leaseBlocks, other?.running, other?.reportedByAmboss], ["other-order", 0, true, true]);
});

// ── offline as a duration ─────────────────────────────────────────────────────

test("offline is a duration kept on disk: an unbroken series of observations; a gap (the app was down) starts it again; LND's counters add what they prove", (t) => {
  const dir = makeTempDir(t);
  const up = new ChannelUptime(dir);
  const t0 = Date.parse("2026-10-20T00:00:00.000Z");
  const c = { id: "850000x1x0", active: false };
  for (let h = 0; h <= 80; h += 1) up.observe([c], t0 + h * HOUR);
  // A restart: a new process reads what the old one saw.
  const again = new ChannelUptime(dir);
  const info = again.offlineInfo(c, t0 + 80 * HOUR) as OfflineInfo;
  assert.deepEqual([info.since, info.hours, info.long], [new Date(t0).toISOString(), 80, true]);
  // Back online: forgotten.
  again.observe([{ ...c, active: true }], t0 + 81 * HOUR);
  assert.equal(again.offlineInfo({ ...c, active: true }, t0 + 81 * HOUR), null);
  // Offline again, then the app was down longer than the gap allows: the
  // series starts again (the peer may have been back in between).
  again.observe([c], t0 + 82 * HOUR);
  again.observe([c], t0 + 82 * HOUR + MAX_GAP_MS + HOUR);
  assert.equal(again.inactiveSince(c.id), new Date(t0 + 82 * HOUR + MAX_GAP_MS + HOUR).toISOString());
  // A peer away for hours is not "long" …
  const brief = again.offlineInfo(c, t0 + 82 * HOUR + MAX_GAP_MS + 6 * HOUR) as OfflineInfo;
  assert.deepEqual([brief.hours, brief.long], [5, false]);
  assert.ok(OFFLINE_CLOSE_SIGNAL_HOURS > 5);
  // … unless LND has never seen it online since it started monitoring it 4 days ago.
  const lnd = again.offlineInfo({ ...c, timeOfflineMs: 4 * DAY, timeOnlineMs: 0 }, t0 + 82 * HOUR + MAX_GAP_MS + 6 * HOUR) as OfflineInfo;
  assert.deepEqual([lnd.hours, lnd.long], [96, true]);
  // A flaky peer (online 30 % of 20 days) counts, even while it is online.
  const flaky = again.offlineInfo({ id: "850000x2x0", active: true, timeOfflineMs: 14 * DAY, timeOnlineMs: 6 * DAY }) as OfflineInfo;
  assert.deepEqual([flaky.hours, flaky.long, Math.round((flaky.uptimeShare ?? 0) * 100)], [null, true, 30]);
  // Online and steady: nothing to say.
  assert.equal(again.offlineInfo({ id: "850000x3x0", active: true, timeOfflineMs: DAY, timeOnlineMs: 19 * DAY }), null);
});

// ── the close ranking ─────────────────────────────────────────────────────────

test("a channel still opening or closing is never a close candidate: listed apart, its balance never 'freeable'", () => {
  const opening = chan(1, { pending: true });
  const closing = { ...chan(2), status: "pending_close" as const, active: false, timelockBlocks: 120 };
  const idle = chan(3);
  const report = rankCloseCandidates(input([opening, closing, idle]));
  assert.deepEqual(report.candidates.map((c) => c.channelId), [idle.id]);
  assert.deepEqual(report.pending.map((p) => [p.channelId, p.status, p.timelockBlocks]), [
    [opening.id, "pending_open", null],
    [closing.id, "pending_close", 120],
  ]);
  assert.equal(report.totalCapitalFreedSats, idle.localBalance, "only the candidate's balance");
  // Before: the opening channel led the list as "Offline — peer unreachable".
  assert.ok(!report.candidates.some((c) => c.reasons.some((r) => /peer unreachable/.test(r))));
});

test("a channel inside its lease — sold on Magma (60-day lease, 40 days in), sold over LSPS1, or bought on Magma — is protected and says until when; past the lease it is judged like any other", () => {
  const sold = chan(1, { ageBlocks: 5_760 }); // 40 days: past the 30-day guard
  const lsp = chan(2, { ageBlocks: 5_760 });
  const bought = chan(3, { ageBlocks: 5_760, initiator: "remote", localBalance: 0, peerPubkey: PEER(7), capacity: 3_000_000 });
  const leases = channelLeases([sold, lsp, bought], {
    soldLeases: [
      { fundingOutpoint: `${TX(1)}:0`, source: "magma", orderId: "magma-order-1", leaseBlocks: 8_640 },
      { fundingOutpoint: `${TX(2)}:0`, source: "lsps1", orderId: "lsp-order-2", leaseBlocks: 12_960 },
    ],
    purchases: [purchase({ channelId: standardNumber(bought.id) })],
  }, HEIGHT);
  const report = rankCloseCandidates(input([sold, lsp, bought], { leases }));
  assert.deepEqual(report.candidates, [], "no sold or bought channel mid-lease");
  assert.equal(report.protectedCount, 3);
  assert.equal(report.totalCapitalFreedSats, 0, "nothing freeable — no 'list it on Magma' nudge for leased capital");
  const why = Object.fromEntries(report.protected.map((p) => [p.channelId, p.reason]));
  assert.match(why[sold.id], /^sold on Magma \(order magma-or…\) — leased until block 863,024 \(~21 d left\); closing it early breaks the lease the buyer paid for, and Amboss counts that against your seller score$/);
  assert.match(why[lsp.id], /^sold to an LSP client \(order lsp-orde…\) — this node promised to keep it open until block 867,200/);
  assert.match(why[bought.id], /^bought on Magma for 18,012 sat \(order buy-orde…\) — the inbound you paid for is leased until block/);
  assert.ok(report.protected.every((p) => p.lease?.running));

  // Months later every lease has ended: judged like any other channel.
  const over = channelLeases([sold, lsp, bought], {
    soldLeases: [
      { fundingOutpoint: `${TX(1)}:0`, source: "magma", orderId: "magma-order-1", leaseBlocks: 8_640 },
      { fundingOutpoint: `${TX(2)}:0`, source: "lsps1", orderId: "lsp-order-2", leaseBlocks: 12_960 },
    ],
    purchases: [purchase({ channelId: standardNumber(bought.id) })],
  }, HEIGHT + 20_000);
  const later = rankCloseCandidates(input([sold, lsp, bought], { leases: over }));
  assert.deepEqual(later.candidates.map((c) => c.channelId).sort(), [sold.id, lsp.id, bought.id].sort());
});

test("a bought channel past its lease is described with what it cost and its lease — never as 'free inbound'", () => {
  const bought = chan(3, { ageBlocks: 12_000, initiator: "remote", localBalance: 0, peerPubkey: PEER(7), capacity: 3_000_000 });
  const leases = channelLeases([bought], { soldLeases: [], purchases: [purchase({ channelId: bought.id })] }, HEIGHT);
  assert.equal(leases.get(bought.id)?.running, false);
  const [c] = rankCloseCandidates(input([bought], { leases })).candidates;
  assert.ok(
    c.warnings.some((w) => /^Bought on Magma for 18,012 sat \(order buy-orde…, a 60-day lease that ended at block 856,784\) — closing gives up the 3,000k of inbound it provided\.$/.test(w)),
    c.warnings.join(" | "),
  );
  assert.ok(!c.warnings.some((w) => /free inbound/.test(w)), c.warnings.join(" | "));
  assert.equal(c.lease?.kind, "magma_purchase");
  // A channel a peer opened for free keeps its wording.
  const free = chan(4, { initiator: "remote", localBalance: 0 });
  const [f] = rankCloseCandidates(input([free])).candidates;
  assert.ok(f.warnings.some((w) => /^Peer opened this channel — closing gives up 2,000k of free inbound liquidity it provided\.$/.test(w)), f.warnings.join(" | "));
});

test("a peer offline for a few hours: 'routed recently' and 'unique reach' still protect its channel, an idle one is not pushed up the list, and it says to reconnect rather than force-close", () => {
  const briefly: OfflineInfo = { since: new Date(Date.now() - 5 * HOUR).toISOString(), hours: 5, uptimeShare: null, long: false };
  const routing = chan(1, { active: false });
  const reach = chan(2, { active: false });
  const idleAway = chan(3, { active: false });
  const idleHere = chan(4);
  const report = rankCloseCandidates(
    input([routing, reach, idleAway, idleHere], {
      feeById: new Map([
        [routing.id, feeOf(routing, { routed30: 300_000 })],
        [reach.id, feeOf(reach)],
        [idleAway.id, feeOf(idleAway)],
        [idleHere.id, feeOf(idleHere)],
      ]),
      uniqueReachByChan: new Map([[routing.id, 0], [reach.id, 40], [idleAway.id, 0], [idleHere.id, 0]]),
      offline: (c) => (c.active ? null : briefly),
    }),
  );
  const why = Object.fromEntries(report.protected.map((p) => [p.channelId, p.reason]));
  assert.equal(why[routing.id], "routed recently", "before: lost while the peer was away");
  // A channel losing money while its peer is here outranks the briefly-away
  // idle one: the list is by close score (before: "offline first").
  const losing = chan(5);
  const ranked = rankCloseCandidates(
    input([idleAway, losing], {
      rebalanceRecords: [
        { at: new Date().toISOString(), via: "autopilot", targetId: losing.id, targetAlias: "", sourceId: "", sourceAlias: "", amountSats: 500_000, budgetPpm: 0, feeSats: 3_000, costPpm: 6_000, ok: true },
      ],
      offline: (c) => (c.active ? null : briefly),
    }),
  );
  assert.deepEqual(ranked.candidates.map((c) => c.channelId), [losing.id, idleAway.id]);
  assert.equal(why[reach.id], "provides significant unique reach");
  const [first, second] = report.candidates;
  // The away channel scores like the same channel online — no jump to the top.
  assert.equal(first.closeScore, second.closeScore);
  const away = report.candidates.find((c) => c.channelId === idleAway.id)!;
  assert.ok(!away.reasons.some((r) => /Offline|unreachable/.test(r)), away.reasons.join(" | "));
  assert.ok(
    away.warnings.some((w) => /^The peer is offline for ~5 h — a short outage is no reason to close: reconnect, or wait for it to come back and close cooperatively\. A force-close locks your funds for 144 blocks\.$/.test(w)),
    away.warnings.join(" | "),
  );
  assert.deepEqual([away.offline?.hours, away.csvDelayBlocks, away.commitFeeSats], [5, 144, 2_810]);
});

test("a peer away for days — or online less than half the time — is a close signal, and the reason says how long", () => {
  const gone = chan(1, { active: false });
  const flaky = chan(2);
  const steady = chan(3);
  const report = rankCloseCandidates(
    input([gone, flaky, steady], {
      offline: (c) =>
        c.id === gone.id
          ? { since: new Date(Date.now() - 4 * DAY).toISOString(), hours: 96, uptimeShare: null, long: true }
          : c.id === flaky.id
            ? { since: null, hours: null, uptimeShare: 0.3, long: true }
            : null,
    }),
  );
  const byId = Object.fromEntries(report.candidates.map((c) => [c.channelId, c]));
  assert.equal(byId[gone.id].reasons[0], "Offline for ~4 d — peer unreachable.");
  assert.equal(byId[flaky.id].reasons[0], "Flaky peer — online only 30% of the time over LND's last 14+ days.");
  assert.ok(byId[gone.id].closeScore > byId[steady.id].closeScore, "a real outage weighs");
  assert.deepEqual(report.candidates.map((c) => c.channelId).slice(0, 1), [gone.id]);
});

test("amounts read with thousands separators: 'Frees 2,000k', not 'Frees 2000k'", () => {
  const [c] = rankCloseCandidates(input([chan(1)])).candidates;
  assert.ok(c.reasons.includes("Frees 2,000k you could redeploy into next-peer."), c.reasons.join(" | "));
});

test("a flaky peer that is offline right now counts as long offline at once — LND saw it online only 30 % of 20 days — though this outage is minutes old", (t) => {
  const up = new ChannelUptime(makeTempDir(t));
  const nowMs = Date.parse("2026-10-21T12:00:00.000Z");
  const c = { id: "850000x4x0", active: false, timeOfflineMs: 14 * DAY, timeOnlineMs: 6 * DAY };
  up.observe([c], nowMs);
  const info = up.offlineInfo(c, nowMs) as OfflineInfo;
  assert.deepEqual([info.hours, Math.round((info.uptimeShare ?? 0) * 100), info.long], [0, 30, true]);
  // The same outage on a steady peer (90 % online): not a close signal yet.
  const steady = up.offlineInfo({ ...c, timeOfflineMs: 2 * DAY, timeOnlineMs: 18 * DAY }, nowMs) as OfflineInfo;
  assert.equal(steady.long, false);
});
