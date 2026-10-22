/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * LSP mode as the Settings card and the Orders tab tell it (review
 * a4-lsp-payments:lsp-mode-tor-only-reach, lsps1-rejects-zeus-client-info —
 * package P5). Before: a "beta" mode whose card counted only get_info
 * requests (every ZEUS order was refused while it looked healthy), promised
 * that "any LSPS1-capable wallet" works, and told a Tor-only node to
 * "announce a clearnet address below to reach more wallets" — publishing
 * the home IP for good, against the node's Tor-only stance.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { LspActivity } from "../src/components/LspActivity";
import {
  CLEARNET_WARNING,
  isTorOnly,
  lspBlockedLine,
  lspBuyerGuide,
  lspIgnoredLine,
  lspOrderLabel,
  lspReachText,
  lspRecoveryLine,
  lspRefusalLines,
  lspServedLine,
} from "../src/lspView";
import type { LspOrder, LspStatus } from "../src/types";

const ONION = "02ab@abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion:9735";
const CLEAR = "02ab@203.0.113.7:9735";

test("on a Tor-only node the card says how few wallets can order — and proposes no clearnet address", () => {
  assert.equal(isTorOnly([ONION]), true);
  assert.equal(isTorOnly([]), true, "no address announced at all: nobody dials it but over a peer it already has");
  assert.equal(isTorOnly([ONION, CLEAR]), false);
  // Review of P5: a node that announces no address at all was called
  // "reachable over Tor only" — it is reachable over nothing.
  const none = lspReachText([]);
  assert.match(none, /^This node announces no address — not even a \.onion one — so a buyer's wallet has nothing to dial/);
  assert.doesNotMatch(none, /reachable over Tor only/);
  assert.match(none, /Expect no orders — LSP mode is experimental\.$/);
  assert.doesNotMatch(none, /announce a clearnet|clearnet address/i, "no clearnet proposal");
  const tor = lspReachText([ONION]);
  assert.match(tor, /^This node is reachable over Tor only, so very few wallets can order here\./);
  assert.match(tor, /ZEUS with its embedded node and ZEUS's embedded Tor switched on \(it is off by default\)/);
  assert.match(tor, /typed in by hand/);
  assert.match(tor, /Wallets that order LSPS1 over HTTPS — ZEUS on a remote node or over LNC, LDK-based wallets — can't order here/);
  assert.match(tor, /Expect few or no orders — LSP mode is experimental\.$/);
  for (const text of [tor, lspReachText([CLEAR]), CLEARNET_WARNING, lspBuyerGuide(ONION)]) {
    assert.doesNotMatch(text, /announce a clearnet|reach more wallets|clearnet address below/i, "no clearnet proposal");
  }
  assert.match(CLEARNET_WARNING, /publishes it in the public Lightning graph/);
  assert.match(CLEARNET_WARNING, /your home IP address .* is tied to this node for good/);
  assert.match(CLEARNET_WARNING, /Leave it empty to stay Tor-only\.$/);
});

test("the Settings card: experimental, the reach note and the clearnet warning shown — the old nudge and the get_info-only counter gone", () => {
  const settings = readFileSync(new URL("../src/components/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(settings, /<h3 className="sub">LSP mode \(experimental\)<\/h3>/);
  assert.doesNotMatch(settings, /LSP mode \(beta\)/);
  assert.doesNotMatch(settings, /reach more wallets/);
  assert.doesNotMatch(settings, /get_info served/);
  assert.doesNotMatch(settings, /Any LSPS1-capable wallet/);
  assert.match(settings, /\{lspReachText\(lsp\.uris\)\}/);
  assert.match(settings, /\{CLEARNET_WARNING\}/);
  // What it is doing — served, refused, why orders are turned away — is LspActivity's.
  assert.match(settings, /<LspActivity lsp=\{lsp\} \/>/);
  const activity = readFileSync(new URL("../src/components/LspActivity.tsx", import.meta.url), "utf8");
  assert.match(activity, /lspRefusalLines\(lsp\)\.map/);
  // The field stays (community nodes with a static IP use it), behind the warning.
  assert.match(settings, /placeholder="mynode\.example\.com:9735 or 203\.0\.113\.7:9735"/);
});

const status = (o: Partial<LspStatus> = {}): Pick<LspStatus, "requests" | "ignoredParams" | "recovery"> => ({
  requests: [],
  ignoredParams: [],
  recovery: { waiting: 0, refunds: 0, settles: 0, lastError: null, nextTryAt: null },
  ...o,
});

test("what wallets asked, and what was refused with the reason sent — so a wallet whose every order fails shows up", () => {
  const s = status({
    requests: [
      { method: "lsps1.get_info", served: 3, errors: [] },
      { method: "lsps1.create_order", served: 1, errors: [
        { code: -32602, count: 2, lastMessage: "channel_expiry_blocks must be an unsigned integer", lastAt: "2026-10-21T10:00:00.000Z" },
        { code: 1, count: 1, lastMessage: "this LSP is at its capital deployment cap — try again later", lastAt: "2026-10-21T11:00:00.000Z" },
      ] },
      { method: "other", served: 0, errors: [{ code: -32700, count: 1, lastMessage: "the message is not one JSON-RPC 2.0 object (UTF-8 JSON)", lastAt: "2026-10-21T09:00:00.000Z" }] },
    ],
    ignoredParams: [{ name: "client_info", count: 4 }],
  });
  assert.equal(lspServedLine(s), "get_info 3 · create_order 1");
  assert.equal(lspServedLine(status()), "none yet");
  assert.deepEqual(lspRefusalLines(s), [
    "create_order: 3 refused — last: this LSP is at its capital deployment cap — try again later (1)",
    "unreadable or unknown requests: 1 refused — last: the message is not one JSON-RPC 2.0 object (UTF-8 JSON) (-32700)",
  ]);
  assert.equal(lspIgnoredLine(s), "client_info ×4");
  assert.equal(lspIgnoredLine(status()), null);
});

test("what recovery waits on LND for is said, each kind in its own words — a refund or a settle LND refused is not 'waiting after a restart'", () => {
  assert.equal(lspRecoveryLine(status()), null);
  const startup = { waiting: 2, refunds: 0, settles: 0, lastError: "order 1a2b3c4d…: server is still in the process of starting", nextTryAt: null };
  assert.equal(
    lspRecoveryLine(status({ recovery: startup })),
    "2 orders LND hasn't answered for yet — a held payment is opened or refunded once it does. Tried again automatically " +
      "(LND's last answer: order 1a2b3c4d…: server is still in the process of starting).",
  );
  // Before: "1 order is waiting for LND to answer after a restart" — for a
  // refund LND refused while the app ran, with no restart anywhere.
  const refund = { waiting: 1, refunds: 1, settles: 0, lastError: "order 5e6f7a8b…: refund refused — Connection dropped", nextTryAt: null };
  assert.equal(
    lspRecoveryLine(status({ recovery: refund })),
    "1 refund not confirmed by LND yet — the buyer's payment stays held until it is. Tried again automatically " +
      "(LND's last answer: order 5e6f7a8b…: refund refused — Connection dropped).",
  );
  assert.doesNotMatch(lspRecoveryLine(status({ recovery: refund })) ?? "", /restart/);
  const all = { waiting: 4, refunds: 1, settles: 2, lastError: null, nextTryAt: null };
  assert.equal(
    lspRecoveryLine(status({ recovery: all })),
    "2 channels are open, but LND hasn't claimed the buyer's payment yet; 1 refund not confirmed by LND yet — the buyer's payment stays held until it is; " +
      "1 order LND hasn't answered for yet — a held payment is opened or refunded once it does. Tried again automatically.",
  );
});

const order = (o: Partial<LspOrder>): LspOrder => ({
  orderId: "o",
  peer: "02ab",
  createdAt: "2026-10-21T10:00:00.000Z",
  sizeSat: 1_000_000,
  feeSat: 5_000,
  orderState: "CREATED",
  paymentState: "EXPECT_PAYMENT",
  channelExpiryBlocks: 13_140,
  invoiceExpiresAt: "2026-10-21T11:00:00.000Z",
  fundingOutpoint: null,
  serviceFeePaidSat: 0,
  ...o,
});

test("a direct sale's status: waiting for an offline buyer and a replaced quote are named, not shown as 'opening' or 'expired'", () => {
  assert.equal(lspOrderLabel(order({})), "Awaiting payment");
  assert.equal(lspOrderLabel(order({ paymentState: "HOLD" })), "Paid · opening channel");
  assert.equal(lspOrderLabel(order({ paymentState: "HOLD", waitingForBuyerSince: "2026-10-21T10:05:00.000Z" })), "Paid · waiting for the buyer to come online");
  assert.equal(lspOrderLabel(order({ orderState: "FAILED", superseded: true })), "Replaced by a newer order");
  assert.equal(lspOrderLabel(order({ orderState: "FAILED", paymentState: "REFUNDED" })), "Failed · refunded");
  assert.equal(lspOrderLabel(order({ orderState: "FAILED" })), "Expired");
  // Before: "Expired" — while the buyer's payment was still held, LND
  // having refused the cancel.
  assert.equal(lspOrderLabel(order({ orderState: "FAILED", paymentState: "HOLD", refundPending: true })), "Failed · refund pending");
  // The channel is open, the settle LND refused is tried again …
  assert.equal(lspOrderLabel(order({ paymentState: "HOLD", fundingOutpoint: "ab:0" })), "Channel opened · claiming the payment");
  // … and if LND released the payment first, the channel was given away.
  assert.equal(lspOrderLabel(order({ orderState: "FAILED", paymentState: "REFUNDED", fundingOutpoint: "ab:0" })), "Failed · channel opened, payment lost");
  assert.equal(lspOrderLabel(order({ orderState: "COMPLETED", paymentState: "PAID" })), "Completed");
  const orders = readFileSync(new URL("../src/components/MarketOrders.tsx", import.meta.url), "utf8");
  assert.match(orders, /\{lspOrderLabel\(o\)\}/);
});

test("the buyer guide promises nothing the node can't do: peer-message wallets only, Tor for an .onion address", () => {
  const tor = lspBuyerGuide(ONION);
  assert.match(tor, /Node URI: .*\.onion:9735 \(reachable over Tor only\)/);
  assert.match(tor, /switch on ZEUS's embedded Tor first/);
  assert.match(tor, /ordering over HTTPS\n\(ZEUS on a remote node or LNC\) doesn't work with this node\./);
  assert.doesNotMatch(tor, /Any LSPS1-capable wallet|BTCPay/);
  assert.doesNotMatch(lspBuyerGuide(CLEAR), /embedded Tor/);
});

// Review of P8, run 2: a write macaroon without peers:read still reads peer
// messages, so the listener runs — and the card, which showed the service's
// error only while it didn't, said "Listening for LSP clients" while every
// order was turned away: the cause was named nowhere, only the buyer's line
// ("this LSP can't open channels right now") under Refused.
const NO_PEERS_READ =
  "the write macaroon lacks peers:read — LND refused to list its peers to it, and every channel open checks its connection to the peer that way; " +
  "add peers:read to the macaroon (SECURITY.md) and restart LightningMate";

test("listening while new orders are turned away for want of peers:read: the card says why — not only 'Listening for LSP clients'", () => {
  assert.equal(lspBlockedLine({ blocked: null }), null);
  assert.equal(lspBlockedLine({ blocked: NO_PEERS_READ }), `New orders are turned away: ${NO_PEERS_READ}`);
  type Shown = Parameters<typeof LspActivity>[0]["lsp"];
  const card = (o: Partial<Shown>) =>
    renderToStaticMarkup(<LspActivity lsp={{ running: true, blocked: null, lastError: null, lastRequestAt: null, requests: [], ...o }} />);
  const refused = {
    method: "lsps1.create_order",
    served: 0,
    errors: [{ code: 1, count: 1, lastMessage: "this LSP can't open channels right now — try again later", lastAt: "2026-10-22T10:00:00.000Z" }],
  };
  const listening = card({ blocked: NO_PEERS_READ, requests: [refused] });
  assert.match(listening, /Listening for LSP clients/);
  assert.match(listening, /<p class="banner error">New orders are turned away: the write macaroon lacks peers:read — /);
  assert.match(listening, /add peers:read to the macaroon \(SECURITY\.md\) and restart LightningMate<\/p>/);
  assert.match(listening, /Refused — (<!-- -->)?create_order: 1 refused/);
  // Not listening: said as well, next to the service's own error.
  const down = card({ running: false, blocked: NO_PEERS_READ, lastError: "Connection dropped" });
  assert.match(down, /Not listening/);
  assert.match(down, /New orders are turned away: the write macaroon lacks peers:read/);
  assert.match(down, /<p class="banner error">Connection dropped<\/p>/);
  // Listening, nothing blocked: no banner (an old error of the service is
  // not shown while it listens).
  assert.doesNotMatch(card({ lastError: "Connection dropped" }), /banner error/);
});
