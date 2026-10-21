/**
 * Opening the channel for a paid order: only while the buyer's payment is
 * held long enough, with the buyer's options honoured, and an open whose
 * outcome is unclear is looked for in LND before anything else happens — no
 * second channel, no refund for a channel that exists.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptedInvoice } from "./helpers/magma.js";
import { BUYER, sellerSetup } from "./helpers/autopilot.js";
import { OPEN_MIN_BLOCKS_LEFT, OPENING_GRACE_MS } from "../src/services/magmaDesk.js";
import {
  entryOnDisk,
  quiet,
} from "./helpers/lifecycle.js";

test("SELLER_SENT_TRANSACTION with a funding transaction LND no longer knows: flagged for a human — never opened again", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(magma.sales.get(sale.id)?.status, "SELLER_SENT_TRANSACTION");
  node.pending = []; // dropped from the mempool, and LND forgot it
  await autopilot.pollSellOrders();
  const e = entryOnDisk(dir, sale.id);
  assert.match(e?.lastError ?? "", /no longer knows the funding transaction/);
  assert.equal(e?.phase, "reported");
  assert.equal(node.callsTo("default.openChannel").length, 1, "no automatic second open");
});

test("the payment was held, then LND released it before the open: the open-time check catches it — no channel", async (t) => {
  quiet(t);
  // Selling off: the lane carries the order taken on by hand up to "held",
  // then waits for the click — meanwhile LND releases the HTLC.
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  assert.equal((await autopilot.magma.accept(sale.id)).ok, true);
  const hash = magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "held");
  node.expireHoldInvoice(hash);
  const res = await autopilot.magma.open(sale.id);
  assert.equal(node.callsTo("default.openChannel").length, 0, "never a channel for a payment that is gone");
  assert.equal(res.ok, false);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
});

test("the buyer's options are honoured: a private channel when asked, and every listed address is tried before giving up", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const tried: string[] = [];
  node.override("default.connectPeer", (a, cb) => {
    const addr = a.addr as { pubkey: string; host: string };
    tried.push(addr.host);
    if (addr.host !== "5.6.7.8:9735") return cb({ details: "dial tcp: connection refused" });
    if (!node.peers.includes(addr.pubkey)) node.peers.push(addr.pubkey);
    cb(null, {});
  });
  const sale = magma.addSale({ buyerPubkey: BUYER, isPrivate: true, sockets: ["1.2.3.4:9735", "5.6.7.8:9735"] });
  await autopilot.pollSellOrders();
  assert.deepEqual([...new Set(tried)], ["1.2.3.4:9735", "5.6.7.8:9735"], "the second address after the first failed");
  magma.buyerPays(sale.id, node);
  await autopilot.pollSellOrders();
  const [open] = node.callsTo("default.openChannel");
  assert.equal(open?.private, true, "a private channel, as the buyer ordered (a public one ends INVALID_CHANNEL_OPENING)");
});

// ── the open needs time, and an unclear open is looked for first ──────────────

test("an open needs the held payment to outlive the cancel margin by the confirmation time — or the payment is released, not used", async (t) => {
  quiet(t);
  for (const left of [25, OPEN_MIN_BLOCKS_LEFT - 1, OPEN_MIN_BLOCKS_LEFT]) {
    const { autopilot, node, magma, dir } = sellerSetup(t);
    const sale = magma.addSale({ buyerPubkey: BUYER });
    await autopilot.pollSellOrders();
    const inv = acceptedInvoice(magma.sales.get(sale.id)!);
    node.payHoldInvoice(inv.id, { expiryHeight: node.blockHeight + left });
    magma.setStatus(sale.id, "WAITING_FOR_CHANNEL_OPEN");
    await autopilot.pollSellOrders();
    const opens = node.callsTo("default.openChannel").length;
    if (left < OPEN_MIN_BLOCKS_LEFT) {
      // Before: 25 blocks passed the open-time check (it only wanted the
      // 24-block cancel margin) — the channel opened, and one block later the
      // buyer's payment was released: a channel delivered for nothing.
      assert.equal(opens, 0, `${left} blocks left: no channel`);
      assert.equal(node.invoices.get(inv.id)?.state, "CANCELED", `${left} blocks left: released at once`);
      assert.match(entryOnDisk(dir, sale.id)?.reason ?? "", /expire before the channel could be confirmed/);
    } else {
      assert.equal(opens, 1, `${left} blocks left: room for confirmations and Amboss's check`);
      node.blockHeight += 1;
      await autopilot.pollSellOrders();
      assert.equal(node.invoices.get(inv.id)?.state, "ACCEPTED", "and still held a block later");
    }
  }
});

test("an open whose outcome is unclear (the stream dropped) waits for LND: the channel that shows up is adopted — no second open, no refund", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  // LND took the open, but the gRPC stream dropped before it said so: the
  // channel shows up in LND only a little later.
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  let opens = 0;
  desk.lndOpen = async () => {
    opens += 1;
    return { ok: false, error: "FailedToOpenChannel: Connection dropped" };
  };
  await autopilot.pollSellOrders();
  let e = entryOnDisk(dir, sale.id);
  assert.equal(e?.phase, "opening", "not 'held' — that would allow a second open");
  assert.match(e?.opening?.unclear ?? "", /Connection dropped/);
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "and not released: a channel may exist");

  await autopilot.pollSellOrders();
  assert.equal(opens, 1, "within the grace period: no second open");

  const txid = "ab".repeat(32);
  node.pending.push({ partnerPublicKey: BUYER, capacity: sale.sizeSats, transactionId: txid, transactionVout: 0 });
  await autopilot.pollSellOrders();
  e = entryOnDisk(dir, sale.id);
  assert.equal(e?.fundingOutpoint, `${txid}:0`, "the channel LND shows was adopted");
  assert.equal(e?.phase, "reported");
  assert.equal(opens, 1);
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED");
});

test("an unclear open that LND never shows is tried again once LND has had ample time — but only then", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const real = desk.lndOpen.bind(autopilot.magma);
  let opens = 0;
  desk.lndOpen = async (p) => {
    opens += 1;
    return opens === 1 ? { ok: false, error: "UnknownChannelOpenStatus" } : real(p);
  };
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "opening");
  const entry = autopilot.magma.journal.get(sale.id)!;
  entry.opening = { ...entry.opening!, startedAt: new Date(Date.now() - OPENING_GRACE_MS - 60_000).toISOString() };
  await autopilot.pollSellOrders();
  assert.equal(opens, 2, "no channel after the grace: it never happened, so it is opened now");
  assert.equal(node.callsTo("default.openChannel").length, 1);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "reported");
});

test("two orders of one size from one buyer: the one whose open was unclear never adopts the other's channel", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const a = magma.addSale({ buyerPubkey: BUYER });
  const b = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  magma.buyerPays(a.id, node);
  magma.buyerPays(b.id, node);
  // The first open's stream drops (nothing reached LND); the second opens.
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const real = desk.lndOpen.bind(autopilot.magma);
  let opens = 0;
  desk.lndOpen = async (p) => {
    opens += 1;
    return opens === 1 ? { ok: false, error: "FailedToOpenChannel: Connection dropped" } : real(p);
  };
  await autopilot.pollSellOrders();
  const [ea, eb] = [autopilot.magma.journal.get(a.id)!, autopilot.magma.journal.get(b.id)!];
  const [unclear, funded] = ea.phase === "opening" ? [ea, eb] : [eb, ea];
  assert.equal(unclear.phase, "opening");
  assert.ok(funded.fundingOutpoint, "the other order's channel is open and on record");

  await autopilot.pollSellOrders(); // the unclear one looks for its channel — the other's is the only one there
  assert.equal(unclear.fundingOutpoint, undefined, "not the other order's channel: both buyers' payments would settle on one channel");
  assert.equal(unclear.phase, "opening", "it waits for its own");

  unclear.opening = { ...unclear.opening!, startedAt: new Date(Date.now() - OPENING_GRACE_MS - 60_000).toISOString() };
  await autopilot.pollSellOrders();
  assert.equal(unclear.phase, "reported", "LND never showed it: opened now, its own channel");
  assert.notEqual(unclear.fundingOutpoint, funded.fundingOutpoint);
  assert.equal(node.callsTo("default.openChannel").length, 2);
});

/** The first open's stream drops (nothing reached LND): the order waits in
 *  "opening" for LND to show a channel. Later opens go through. */
function firstOpenUnclear(autopilot: ReturnType<typeof sellerSetup>["autopilot"]): void {
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  const real = desk.lndOpen.bind(autopilot.magma);
  let opens = 0;
  desk.lndOpen = async (p) => {
    opens += 1;
    return opens === 1 ? { ok: false, error: "FailedToOpenChannel: Connection dropped" } : real(p);
  };
}

test("an unclear open never adopts a channel of ours to the buyer of another size — one that appeared after the open started", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  firstOpenUnclear(autopilot);
  await autopilot.pollSellOrders();
  const e = autopilot.magma.journal.get(sale.id)!;
  assert.equal(e.phase, "opening");
  // Meanwhile the operator opened a 1.5M routing channel to the same node.
  node.pending.push({ partnerPublicKey: BUYER, capacity: 1_500_000, transactionId: "cd".repeat(32), transactionVout: 0 });
  await autopilot.pollSellOrders();
  // Without the size check: that channel was adopted and reported to Amboss
  // as the 2M channel the buyer paid for.
  assert.equal(e.fundingOutpoint, undefined, "the 1.5M channel is not this 2M order's channel");
  assert.equal(e.phase, "opening");
  assert.equal(magma.count("AddTransaction"), 0, "nothing reported to Amboss");
  e.opening = { ...e.opening!, startedAt: new Date(Date.now() - OPENING_GRACE_MS - 60_000).toISOString() };
  await autopilot.pollSellOrders();
  assert.equal(e.phase, "reported", "its own channel, opened once LND had ample time to show one");
  assert.notEqual(e.fundingOutpoint, `${"cd".repeat(32)}:0`);
});

test("an unclear open never adopts a channel the buyer opened to us, even of the order's size", async (t) => {
  quiet(t);
  const { autopilot, node, magma } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER, sizeSats: 2_000_000 });
  await autopilot.pollSellOrders();
  magma.buyerPays(sale.id, node);
  firstOpenUnclear(autopilot);
  await autopilot.pollSellOrders();
  const e = autopilot.magma.journal.get(sale.id)!;
  assert.equal(e.phase, "opening");
  // Meanwhile the buyer opened a 2M channel of their own to us: their coins,
  // not the inbound liquidity they paid this node for.
  node.pending.push({ partnerPublicKey: BUYER, capacity: 2_000_000, transactionId: "ce".repeat(32), transactionVout: 0, partnerInitiated: true });
  await autopilot.pollSellOrders();
  assert.equal(e.fundingOutpoint, undefined, "a channel this node didn't fund is not the order's");
  assert.equal(magma.count("AddTransaction"), 0, "nothing reported to Amboss");
});

test("the buyer's node takes one pending channel at a time: that refusal is waited out, not refunded", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t);
  const sale = magma.addSale({ buyerPubkey: BUYER });
  await autopilot.pollSellOrders();
  const hash = magma.buyerPays(sale.id, node);
  // LND's default maxpendingchannels=1: the buyer has another channel pending.
  node.openFailure = "remote node pending channels exceed maximum allowed";
  await autopilot.pollSellOrders();
  assert.equal(node.invoices.get(hash)?.state, "ACCEPTED", "still held — before, refunded at once");
  assert.match(entryOnDisk(dir, sale.id)?.lastError ?? "", /will try again/);
  node.openFailure = null; // the earlier channel confirmed
  await autopilot.pollSellOrders();
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "reported");
});

test("'Open channel' on an order whose earlier open is still unclear never answers ok and never opens again", async (t) => {
  quiet(t);
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  assert.equal((await autopilot.magma.accept(sale.id)).ok, true);
  magma.buyerPays(sale.id, node);
  const desk = autopilot.magma as unknown as { lndOpen: (p: unknown) => Promise<unknown> };
  let opens = 0;
  desk.lndOpen = async () => {
    opens += 1;
    return { ok: false, error: "FailedToOpenChannel: Connection dropped" };
  };
  const first = await autopilot.magma.open(sale.id);
  assert.equal(first.ok, false);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "opening");
  // A second click while LND may still show the channel.
  const again = await autopilot.magma.open(sale.id);
  assert.equal(again.ok, false, "not 'Channel opening' — nothing was opened by this click");
  assert.equal(again.code, "open_failed");
  assert.match(again.message, /still unclear — waiting for LND/);
  assert.equal(opens, 1, "never a second open within the grace period");
});

test("'Open channel' on an accepted order whose invoice LND has cancelled (the buyer never paid us) never answers ok — the order ends cancelled, no channel", async (t) => {
  quiet(t);
  // Selling off: nothing but the clicks acts on the order.
  const { autopilot, node, magma, dir } = sellerSetup(t, { config: { sellEnabled: false } });
  const sale = magma.addSale({ buyerPubkey: BUYER });
  assert.equal((await autopilot.magma.accept(sale.id)).ok, true);
  // The invoice expires unpaid in LND, while Amboss moves the order on as if paid.
  node.expireHoldInvoice(acceptedInvoice(magma.sales.get(sale.id)!).id);
  magma.setStatus(sale.id, "WAITING_FOR_CHANNEL_OPEN");
  const res = await autopilot.magma.open(sale.id);
  // Before (without the last check): ok: true, "Order cancelled." — the
  // Orders tab said "Channel opening" for an order it had just ended.
  assert.equal(res.ok, false);
  assert.equal(res.code, "bad_status");
  assert.match(res.message, /^No channel opened: the order is cancelled here \(the invoice expired or was cancelled before the buyer paid\)\.$/);
  assert.equal(node.callsTo("default.openChannel").length, 0);
  assert.equal(entryOnDisk(dir, sale.id)?.phase, "cancelled");
});
