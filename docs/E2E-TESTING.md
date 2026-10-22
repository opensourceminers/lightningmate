# Manual end-to-end tests

The automated suites (`npm test`) drive every money path against a fake LND
and fake Amboss APIs — they never touch a real node, a real payment or a real
Amboss account. Two paths depend on what only the real systems do, and have
**not been run end to end yet**:

- **A. Selling on Amboss Magma** — the seller API on `magma.amboss.tech`, the
  hold invoice Amboss's buyer pays, and Amboss's confirmation of the channel.
- **B. An LSPS1 buy from ZEUS's embedded node over Tor** — LightningMate's LSP
  mode as the one wallet known to order over peer messages sees it.

Run them on a real node, with small amounts, before a release that changes
these paths (see [RELEASING.md](RELEASING.md)), and note the results in the
release notes. Each step says what to look at; "Download diagnostics"
(Settings) gives the order journal's view (`magma.recentOrders`), the lane's
status and each area's last decision without exposing the Amboss key.

---

## A. Magma selling with a second node

**You need**

- **Seller (node A)**: LightningMate in write mode — with the admin macaroon
  or the least-privilege one SECURITY.md lists, which needs `peers:read`
  (Autopilot → Magma must not show "blocked … lacks peers:read") — an Amboss
  API key of account X with node A on it (Settings → Amboss: "valid"),
  on-chain coins of at least the test channel size plus the on-chain reserve
  and the funding fee.
- **Buyer (node B)**: another node, on another Amboss account Y, that can pay
  a hold invoice and that node A can dial (node A may be Tor-only: B needs an
  address A can reach — .onion is fine).
- A test size inside both nodes' limits, e.g. a 1,000,000 sat channel.

**1. Offer and selling switch (node A)**

1. Market → Sell: read the selling check. Switch **Liquidity provision** on
   (the confirmation shows the check again).
2. Create an offer whose size window covers the test size, or let the
   autopilot list one (auto-price). Check the offer as Amboss stores it
   (Market → Sell, the diagnostics card): a **4,320-block** minimum lease and
   the **routing-fee promise** (fee-rate cap and base-fee cap) are set.
3. "Copy id" — the offer id the buyer orders from.

**2. The order (node B)**

4. On Amboss, as account Y: order from that offer id, 1,000,000 sat, the
   offer's lease.

**3. Accept with a hold invoice (node A)**

5. Within about 45 s (the order lane) Market → Orders shows the order —
   "Waiting for you to accept", then accepted by the lane (selling on, within
   the caps and the capital) — or accept it by hand. The journal goes
   `seen → accepting → accepted`.
6. **Check the invoice amount — the one live point not yet verified.**
   Before B pays, read the order on Amboss (`fees.seller`, `fees.fixed`,
   `fees.variable`) and the invoice in LND
   (`lncli listinvoices --pending_only` — memo `Magma order <id>`; its
   `value_msat`, `state OPEN`, expiry about 49 h, `cltv_expiry 288`).
   - With `fees.seller` above 0, the invoice is for exactly that.
   - If `fees.seller` read **0** when the order was accepted, LightningMate
     billed **`fees.fixed + fees.variable`** (`magmaDesk.invoiceMsat`).
     Confirm on this sale that Amboss charges the buyer for that invoice and
     moves the order on when it is paid — no mismatch error, no refund.
   Note `fees.seller`, `fees.fixed`, `fees.variable` at accept time, the
   invoice amount and what B paid.

**4. Payment held (B pays)**

7. B pays the invoice Amboss presents. On A: `lncli lookupinvoice <hash>` shows
   `ACCEPTED` (held, not settled); the journal `held`; Amboss
   `WAITING_FOR_CHANNEL_OPEN`. The coins for the channel stay reserved
   (Wallet: "promised to buyers").

**5. Channel open and report (node A)**

8. The lane opens the channel to B (with Liquidity provision on, or for an
   order it accepted itself; an order accepted by hand with selling off waits
   for "Open channel" — the Orders tab says which). The journal records
   `opening` before the open and the funding outpoint right after it
   (`funded`), then `reported` once Amboss took the transaction
   (`SELLER_SENT_TRANSACTION`).
9. The channel shows in Channels with its lease tag.

**6. Confirmation and settle**

10. After the confirmations Amboss asks for, the order turns
    `VALID_CHANNEL_OPENING`; within a lane pass the invoice is **settled**
    (`SETTLED` in LND), the journal `settled`.
11. Booked once: Analytics / P&L shows the lease income of this sale once; the
    1 % service fee is in the fee ledger once (`GET /api/service-fees`) and
    paid in the background.
12. The lease promise: the channel's fee never goes above the caps the order
    locked (Channels → the channel's fee; the Fees tab says "lease promise"
    if the engine wanted more).

**7. The other paths (a second, smaller order each)**

- **Reject by hand**: Market → Orders → Reject. Amboss `SELLER_REJECTED`;
  no "turned down" alert (it was your decision).
- **Pause while an order waits**: Autopilot → "Pause all automation", then
  place an order. The paused lane neither accepts nor rejects it: it stays
  "Waiting for you to accept" on Market → Orders, nothing is promised — accept
  or reject it yourself before its deadline.
- **Restart mid-order**: restart the app between the accept and the payment,
  and again between the payment and the open. No second invoice, no second
  channel; the order carries on.
- **Buyer never pays**: the invoice expires unpaid (about 49 h), the order
  ends `BUYER_FAILED_TO_PAY`, the reserved coins are free again.

Record for each: the order id, the statuses Amboss showed, the journal
phases, the LND invoice states, and anything unexpected.

---

## B. LSPS1 buy from ZEUS's embedded node over Tor

**You need**

- **Node A**: LightningMate with **LSP mode** on (Settings → LSP mode,
  experimental), write mode (its macaroon with `peers:read`, as in A: the
  card must not say "New orders are turned away … lacks peers:read"), at
  least one public channel (feature bit 729 needs a node announcement),
  on-chain coins of at least 1,000,000 sat plus the reserve and the funding
  fee. A Tor-only node is fine (that is the case to test).
- **ZEUS** on a phone with its **embedded LND node** (on a remote LND or LNC,
  ZEUS orders over LSPS1 REST, which LightningMate does not serve) and its
  **embedded Tor switched on** (off by default) — needed to reach a .onion
  address.

**Steps**

1. Node A: Settings → LSP mode → copy the buyer guide (the node URI,
   `pubkey@<address>.onion:9735`).
2. ZEUS: Settings → Tor: on. Settings → Lightning Service Provider (LSPS1):
   set node A as a custom provider by that URI; connect to it as a peer.
3. ZEUS: Channels → "Purchase inbound": 1,000,000 sat (LightningMate's
   minimum), lease "3 months" (13,140 blocks — the longest accepted). Get
   the quote.
   - Node A: Settings → LSP mode shows the request served, ZEUS's
     `client_info` app and version, and the ignored parameter names counted.
   - The quote arrives within ZEUS's 7 s (the price is cached; the first
     order after a start waits at most 4 s for the market).
4. Pay in ZEUS. Node A: `GET /api/lsp/orders` shows the order `HOLD`; LND
   shows the invoice `ACCEPTED` (held).
5. Node A opens the channel to ZEUS (its description in LND is
   `lsps1:<order id>`); once the funding transaction is out the payment is
   settled. ZEUS shows the channel pending, then open.
6. Booked once (P&L lease income, `via: lsps1`), the 1 % service fee once, the
   coins promised to the order released, the lease promise kept on the
   channel's fee.

**The other paths**

- **Quote not paid**: leave it — after an hour the invoice is cancelled and
  the order failed.
- **Buyer offline after paying**: pay, then close ZEUS before the open.
  Node A waits (`waitingForBuyerSince`) and opens as soon as ZEUS is back —
  or refunds the payment when the held HTLC nears its expiry (the invoice asks
  for a 144-block CLTV).
- **Too long a lease**: ask for 6 months — refused with a message that names
  the range ZEUS shows.

Record: ZEUS version, the Tor round-trip times, every message ZEUS showed,
and the order's states on node A.

---

## C. The API refuses other sites (standalone, no password)

A quick check of the cross-site defence (SECURITY.md) on a standalone install
bound to 127.0.0.1 without a password, from the same machine:

```bash
# A form a foreign page could send: refused (415), nothing paused.
curl -s -X POST -H 'Content-Type: application/x-www-form-urlencoded' http://127.0.0.1:3001/api/autopilot/pause
# What a browser marks as another site's request: refused (403).
curl -s -H 'Sec-Fetch-Site: cross-site' http://127.0.0.1:3001/api/autopilot
# A rebound DNS name: refused (403).
curl -s -H 'Host: rebound.example' http://127.0.0.1:3001/api/autopilot
# The app's own kind of request: served — it pauses all automation, so
# resume right after (Resume never switches selling back on).
curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3001/api/autopilot/pause
curl -s -X POST -H 'Content-Type: application/json' -d '{}' http://127.0.0.1:3001/api/autopilot/resume
```
