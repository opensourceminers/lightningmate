# LSP Mode — selling channels via LSPS1 (bLIP-51)

> Design doc / kickoff plan. Goal: LightningMate nodes can SELL inbound channels
> directly to wallets and nodes speaking the open LSP standard — a second demand
> source beside Amboss Magma, with no marketplace dependency. Verified in the
> 2026-07 liquidity-market research: LSPS1/bLIP-51 is finalized ("For
> Implementation"), actively implemented by ZEUS, Breez, Megalithic and others.

## Protocol summary (to re-verify against the spec at build time)

- **Transport (LSPS0):** JSON-RPC 2.0 over BOLT8 **custom peer messages**
  (message type 37913). The buyer connects as a peer and talks JSON-RPC to us.
  LND supports this via `SubscribeCustomMessages` / `SendCustomMessage`
  (ln-service: `subscribeToPeerMessages` / `sendMessageToPeer`).
- **Methods (LSPS1):**
  - `lsps1.get_info` → our offer LIMITS only: min/max channel size, max lease
    blocks, min onchain confs. (Spec-checked at P1 build: there is NO fee
    schedule in `get_info` — the price is quoted per-order in the
    `create_order` response. All sat amounts are JSON strings; fields are
    top-level in `result`, no `options` wrapper.)
  - `lsps1.create_order` → buyer picks size/duration; we respond with an order
    id + payment options (BOLT11 invoice; optionally on-chain address).
  - `lsps1.get_order` → order status polling (created → paid → channel opening
    → opened / failed+refunded).
- **Flow:** order created → buyer pays the invoice → we open the channel to the
  buyer (they're already our peer) → order complete. Payment MUST be refundable
  until the channel is irrevocably opening → use a **HODL invoice**, settle only
  once the funding tx is broadcast, cancel on any failure. This is the critical
  fund-safety piece.

## What we reuse (the reason this fits us well)

| Piece | Source |
|---|---|
| Pricing (fee = fixed + ppm × size, duration-scaled) | `magmaRecommend` profit floor + **fill telemetry** (price to what sells) |
| Capital guards (on-chain reserve, max deploy, max channel size, per-run budget) | Magma fulfilment path in `autopilot.runSell` |
| Channel opening | `channelOps.openChannelTo` |
| Earnings/P&L recording | `earningsLog` (new `via: "lsps1"`) |
| Fast reaction | autopilot fast lane pattern (3-min poll → here: event-driven) |

## Architecture

- `server/src/services/lsps1.ts` — peer-message router (JSON-RPC parse/dispatch,
  per-peer rate limiting), order state machine, `JsonStore("lsps1-orders.json")`.
- Settings card **"LSP mode (beta)"** — OFF by default. Caps shared with the
  Magma sell caps (one capital budget across both demand sources — the
  `onchainCommittedThisRun` counter already models this).
- Orders appear in Market → Orders alongside Magma orders; digest item on fills.

## Phases

1. **P1 — skeleton (read-only):** LSPS0 transport + `lsps1.get_info` from live
   pricing. No orders yet. Verifiable with a ZEUS wallet pointing at the node.
   ✅ **Built 2026-07-03** (`server/src/services/lsps1.ts`, Settings card "LSP
   mode (beta)", `GET /api/lsp/status`). Offer limits come from chain balance
   minus the shared Magma sell reserve, capped by `sellMaxChannelSats`;
   `create_order`/`get_order` answer `-32601` until P2.
2. **P2 — orders:** `create_order` + HODL invoice + open on payment +
   `get_order` states. Caps + earnings + UI.
3. **P3 — hardening:** invoice expiry, refund paths, per-peer rate limits,
   abuse caps (max pending orders), restart recovery of in-flight orders.
4. **P4 — reach:** list the node in LSP directories; feature-bit/announcement
   per spec; docs for wallet users.

## Open decisions (ask the user during build)

- Service fee: apply the same transparent 1% (`LM_SELL_FEE_BPS`) to LSPS1 sales?
  (Consistent + funds the app; must stay clearly disclosed in the UI.)
- Default pricing mode for LSPS1 vs Magma (same engine level, or slightly
  premium since there's no marketplace fee?).
- Beta gating: community store only at first?

## Risks

- **Refund correctness** (HODL settle/cancel) is fund-adjacent — needs the most
  careful review + restart-recovery tests.
- Order spam / DoS → rate limit per pubkey, cap open orders.
- Spec drift → re-read bLIP-51 at build start; don't code from memory.
