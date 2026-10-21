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
| Channel opening | `channelOps.connectForOpen` (dial, outside the on-chain mutex) + `channelOps.fundChannel` (the open, inside it) |
| Earnings/P&L recording | `earningsLog` (new `via: "lsps1"`) |
| Fast reaction | the Magma order lane (45 s poll, its own lane) → here: event-driven |

## Architecture

- `server/src/services/lsps1.ts` — peer-message router (JSON-RPC parse/dispatch,
  per-peer rate limiting), order state machine, `JsonStore("lsps1-orders.json")`.
- Settings card **"LSP mode (beta)"** — OFF by default. Caps shared with the
  Magma sell caps: one capital budget across both demand sources and the
  channel autopilot (`capital.ts` — one on-chain mutex for every open, and
  the coins promised to unopened orders reserved from both order files). A
  manual open or on-chain send may not spend those promised coins unless the
  operator confirms it.
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
   ✅ **Built 2026-07-03.** Pricing = Magma engine level (market ppm/year from
   the current sell recommendation, scaled to the requested lease duration),
   floored by the profit floor (routing benchmark + live on-chain costs + min
   net profit, net of the service fee); local-floor fallback when Amboss is
   unreachable. Fund safety: the funding outpoint is persisted BEFORE settling
   (a restart can never double-open), settle only after broadcast, every
   failure path cancels the HODL invoice → auto-refund. Service fee: same
   transparent `LM_SELL_FEE_BPS` (1%) as Magma sales, paid on completion,
   disclosed with the same fee-note in the Settings card. Earnings →
   `earningsLog` `via:"lsps1"` (flows into P&L); fills appear in the run
   history/digest (`lsps1:<order>`); orders in Market → Orders ("Direct
   sales"). Shared capital: every PAID LSPS1 order without a channel is a
   reservation in the shared capital ledger (`capital.ts`) — with its funding
   fee and its step of LND's anchor reserve. Unpaid quotes count only against
   LSPS1's own next quotes and deploy headroom (any connected peer can ask for
   one, so they never take capital from a Magma buyer). `create_order` checks
   the capital fresh, inside the shared on-chain mutex, and each open runs
   under that mutex too (the held payment is settled once the mutex is
   released, so settle retries never hold up a Magma accept); an "opening"
   mark is saved before the open, so a restart — or an open whose outcome LND
   left unclear — finds the channel in LND instead of opening twice, and never
   adopts a channel that a Magma sale to the same buyer has claimed (the search
   runs under the on-chain mutex, so a channel another sale has just broadcast
   but not yet recorded is never taken; and LND not answering is never read as
   "no channel"). Basic P3 items already in: per-peer rate limit,
   pending-order caps (2/peer, 10 total), invoice expiry (1 h), restart
   recovery of in-flight orders (resume held → open/settle, expire dead).
3. **P3 — hardening:** invoice expiry, refund paths, per-peer rate limits,
   abuse caps (max pending orders), restart recovery of in-flight orders.
4. **P4 — reach:** list the node in LSP directories; feature-bit/announcement
   per spec; docs for wallet users.
   ✅ **Built 2026-07-03** (see "Reach" below). Feature bit 729 is announced
   while the mode is on and withdrawn on disable; the Settings card shows the
   announcement state, a copyable node URI and a ready-to-share buyer guide.

## Open decisions

- ~~Service fee~~ **Decided (P2):** same transparent 1% (`LM_SELL_FEE_BPS`),
  disclosed like the Magma fee (fee-note in the card, env-driven, never hidden).
- ~~Default pricing mode~~ **Decided (P2):** same engine level as Magma (the
  autopilot's configured mode + adaptive level), duration-scaled, profit-floored.
- Beta gating: community store only at first? (decide at release time)

## Reach — how buyers find a LightningMate LSP (P4)

Every LightningMate node is its own independent LSP; there is no central
LightningMate directory. Discovery works through:

1. **Feature bit 729 (`option_supports_lsps`, bLIP-50).** Set in the node
   announcement via LND `peersrpc.UpdateNodeAnnouncement` whenever LSP mode is
   enabled; withdrawn when disabled. Graph explorers (Amboss, mempool.space)
   and LSPS-aware wallets can filter for it. Caveats: LND must include the
   `peersrpc` subserver (official release builds do); a node **without public
   channels has no node announcement** and can't set the bit — the card then
   says so and direct sharing still works. The spec's optional init-message
   feature bit can't be set through the LND API — node_announcement only.
2. **Directly shared URI** (the practical channel). The Settings card offers
   "copy buyer guide": node URI + wallet steps, ready to paste into a chat or
   forum post. Buyer steps in ZEUS: Settings → Lightning Service Provider →
   set the node as custom LSPS1 provider (pubkey@host), then Channels →
   "Purchase Inbound". The BTCPay Server LSP plugin (2.2+) also speaks LSPS1
   with a custom provider option.
3. **Curated LSP lists.** The bLIP/LSPS ecosystem list
   (github.com/BitcoinAndLightningLayerSpecs/lsp) accepts PRs; realistic for
   committed operators, not every node. Not automated by the app on purpose.

Reachability notes: a Tor-only node (Umbrel default) needs Tor-capable buyer
wallets — ZEUS on Android works; hybrid clearnet+Tor widens reach (LND config,
outside LightningMate's scope). Offer size is capped by deployable on-chain
capital, so a thin wallet advertises (and sells) little.

## Risks

- **Refund correctness** (HODL settle/cancel) is fund-adjacent — needs the most
  careful review + restart-recovery tests.
- Order spam / DoS → rate limit per pubkey, cap open orders.
- Spec drift → re-read bLIP-51 at build start; don't code from memory.
