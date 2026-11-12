# Manual end-to-end tests

The automated suites (`npm test`) drive every money path against a fake LND
and fake Amboss APIs — they never touch a real node, a real payment or a real
Amboss account. `server/e2e/` adds real LND nodes on regtest (next section). Two paths depend on what only the real systems do, and have
**not been run end to end yet**:

- **A. Selling on Amboss Magma** — the seller API on `magma.amboss.tech`, the
  hold invoice (which Amboss pays once the channel is confirmed, or the buyer
  right after the accept), and Amboss's confirmation of the channel.
- **B. An LSPS1 buy from ZEUS's embedded node over Tor** — LightningMate's LSP
  mode as the one wallet known to order over peer messages sees it.

Run them on a real node, with small amounts, before a release that changes
these paths (see [RELEASING.md](RELEASING.md)), and note the results in the
release notes. Each step says what to look at; "Download diagnostics"
(Settings) gives the order journal's view (`magma.recentOrders`), the lane's
status and each area's last decision without exposing the Amboss key.

---

## Regtest: a whole sale against real LND nodes

`server/e2e/` runs what the fakes can't show, on your machine, with no real money: a real
`bitcoind` and three real LND nodes (seller, hub, buyer). The seller dials through a slow SOCKS
proxy, as a node with Tor does. Only Amboss stays the suite's fake, its requests checked against
the saved schema, so sections A and B below are still needed for what the live services answer.
Two things only a real LND showed: `ConnectPeer` answers at once unless the dial is temporary (every
buyer not already connected read as unreachable), and a node without any invoice yet answers "there
are no existing invoices" (its first sale failed its accept).

```sh
# LND_DIR and BITCOIN_DIR: unpacked release folders (lnd, lncli / bitcoind, bitcoin-cli),
# REGTEST_DIR: an empty folder with a short path. Use LND's version from your node.
server/e2e/regtest.sh up
cd server
node --import tsx e2e/dial.ts   # how a dial behaves with circuits of 0–35 s and refused addresses
server/e2e/regtest.sh up        # (fresh chain and nodes for the next one)
node --import tsx e2e/sale.ts   # a whole sale to the lease's end, then what can go wrong (listed below)
server/e2e/regtest.sh up
node --import tsx e2e/nodePanel.ts  # a node's details through the app's routes: open by hand, fee mode, close
server/e2e/regtest.sh up
node --import tsx e2e/refill.ts     # refills: a route under its fee limit, invoices of failed tries, one peer over two channels
server/e2e/regtest.sh up
node --import tsx e2e/lsps.ts       # LSP mode: a buyer's node orders a channel over LSPS1 (part B's money path)
server/e2e/regtest.sh down
```

Run it before a release that changes how LightningMate talks to LND on a money path. Each line
says PASS or FAIL; the exit code says whether all passed.

`sale.ts` takes about half an hour, most of it mining: it runs a sale to the end of its lease by
the node's own block count (some 4,500 blocks; the three LND nodes follow in steps of 400). What
it shows, in order:

- **A whole sale, the buyer paying our invoice first**: an unreachable buyer is waited for, not
  turned down; accept, held payment, the open at a stated fee rate — the funding transaction is read back from the mempool and pays
  that rate —, the report to Amboss, settle, the sale booked once.
- **The lease's end**: with Amboss listing the lease as over while the node's own count says it
  still runs, nothing is closed; one block before the end the channel is still open; at the end
  it is closed cooperatively and the coins are back on chain.
- **Amboss calls a paid order off**: the buyer has the payment back, no second channel.
- **Fees rise after the buyer paid**: with LND's estimate at 400 sat/vB the lane opens nothing
  and keeps the payment held, its status says what it waits for; at the last block an open could
  still be confirmed in time it still waits, one block later the buyer is refunded, nothing stays
  reserved, and the operator's alert is there.
- **Amboss answers an accept with an error (HTTP 502)**: the order stays unconfirmed with its
  hold invoice and its size reserved; near the approval deadline it is rejected rather than left
  to time out, the accept not sent again, the invoice cancelled and the size free; the next order
  is accepted as ever.
- **A whole sale, the buyer having paid Amboss** (how a live sale ran): the accept leads straight
  to "waiting for the channel" with our invoice unpaid; the lane opens the channel with nothing
  held and reports it; when Amboss confirms the channel before it has paid, nothing is claimed
  and the order says it waits for Amboss's payment; the payment that arrives after the
  confirmation is claimed and the sale booked once. (The buyer node stands in for Amboss as the
  payer.)
- **A channel opened by hand while the lane waits**: with fees above what the sale earns the
  unpaid order waits and says when it is ended if the open still costs more; a channel the operator
  then opens with another tool is taken as the order's and reported to Amboss, and with fees back
  to normal no second one is opened; its payment is claimed and the sale booked once.
- **The ceiling**: an order whose buyer paid Amboss, at its last moment to open (Amboss's deadline
  minutes away) with fees at 400 sat/vB — the open would cost 70,000 sat for a sale that earns
  60,000: the order is ended instead of opened, our invoice cancelled, nothing opened or spent,
  nothing kept reserved for it, and the refund's alert names both numbers.

No service fee is set in that run, so "what the sale earns" is the order's whole fee there.

`lsps.ts` (a few minutes) plays part B's buyer with the `buyer` node: it speaks LSPS0 to the
seller over BOLT8 custom messages (type 37913), as ZEUS's embedded node does, and pays through
the hub. It checks: get_info and a quote; a token refused with error 102 and a lease too long with
100; a paid order's channel opened to the buyer with the order's outpoint, its payment claimed
once the funding is out, booked once; a buyer that pays and goes offline waited for, its payment
held; back online with fees above what the order brings, not opened and the order says why; once
fees are down, opened at the rate of then; a buyer that stays away refunded six hours after its
payment (its payment comes back, the capital is free); an unpaid quote withdrawn when LSP mode is
switched off (its invoice cancelled in LND); and at 400 sat/vB a channel refused rather than quoted
below its cost. What only ZEUS shows — its screens, its Tor round trips, its polling — stays part B.

`refill.ts` (a few minutes; it mines two weeks of blocks so the hub's channel may give
liquidity) builds the cycle seller → hub → buyer → seller with two channels between seller and
buyer, one drained and one full on the seller's side, and checks:

- **A route asked for under a fee limit** is within it or none, never a dearer one; and it goes
  out of the source, through the hub. LND 0.21 ignores the single outgoing channel QueryRoutes
  and SendPaymentV2 still accept (deprecated `outgoing_chan_id`): asked that way, the route "out
  of the source" went out over the buyer's own full channel and straight back, and the payment
  was refused by the buyer ("same incoming and outgoing channel"), after which LND shunned that
  last hop for every refill. The app shuts the first hops to every other peer out of the route
  question and pays by the invoice's request with `outgoing_chan_ids`.
- **A refill no route fits** pays nothing, and each of its tries' self-invoices is cancelled.
- **One peer over two channels**: the drained one is not refilled while the full one reaches the
  peer (the peer rule is the reason the plan gives), and the executor refuses the full one as its
  source before anything is sent; a refill is booked on the channel it arrived on (LND forwards
  over either channel of the peer: it was planned for the drained one and arrived on the other),
  with that channel's cooldown. That a peer drained over both channels is refilled once per plan
  needs demand the regtest network has none of (no forwards); the suite holds it
  (`rebalanceSamePeer.test.ts`).

A tighter limit returning a cheaper route LND did not prefer needs two paths through different
nodes (LND prices parallel channels between two nodes at the highest fee and time lock among
them): the test suite's fake LND holds that case (`rebalanceRouteLimit.test.ts`).

---

## A. Magma selling with a second node

**You need**

- **Seller (node A)**: LightningMate in write mode — with the admin macaroon
  or the least-privilege one SECURITY.md lists, which needs `peers:read`
  (Autopilot → Selling must not show "blocked … lacks peers:read") — an Amboss
  Amboss key of account X with node A on it (Settings → Amboss: "valid"),
  on-chain coins of at least the test channel size plus the on-chain reserve
  and the funding fee.
- **Buyer (node B)**: another node, on another Amboss account Y, that can pay
  a hold invoice and that node A can dial (node A may be Tor-only: B needs an
  address A can reach — .onion is fine).
- A test size inside both nodes' limits, e.g. a 1,000,000 sat channel.

**1. Offer and selling switch (node A)**

1. Market → Sell: read the selling check. Switch **Selling** on
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
   Before anything is paid to A, read the order on Amboss (`fees.seller`, `fees.fixed`,
   `fees.variable`) and the invoice in LND
   (`lncli listinvoices --pending_only` — memo `Magma order <id>`; its
   `value_msat`, `state OPEN`, expiry about 49 h, `cltv_expiry 288`).
   - With `fees.seller` above 0, the invoice is for exactly that.
   - If `fees.seller` read **0** when the order was accepted, LightningMate
     billed **`fees.fixed + fees.variable`** (`magmaDesk.invoiceMsat`) — the
     order lane only when that sum is the offer's price for the order's size
     (fee rate × size / 1,000,000 + base, within 1 sat); any other amount it
     leaves to you on Market → Orders ("Amboss shows no amount for this
     order …"), and the Accept dialog says so. Confirm on this sale that
     Amboss charges the buyer for that invoice and moves the order on when it
     is paid — no mismatch error, no refund.
   Note `fees.seller`, `fees.fixed`, `fees.variable`, `fees.buyer` and
   Amboss's own fee at accept time, the invoice amount and what B paid — on
   the first real sale, so the fallback is checked against what Amboss
   really sends.

**4. Where the buyer's payment is**

7. Read the order's status right after the accept: it shows which of two ways
   the sale runs.
   - **`WAITING_FOR_CHANNEL_OPEN`, A's invoice still `OPEN`** — how the first
     live sale ran (2026-11-11). B paid Amboss when placing the order, and
     Amboss pays A's invoice only after it confirmed the channel. The journal
     stays `accepted` and says "Amboss holds the buyer's payment: it waits
     for the channel, and pays our invoice once the channel is confirmed".
     Nothing is held on A.
   - **`WAITING_FOR_BUYER_PAYMENT`** — the way Amboss's documentation puts
     it. B pays the invoice Amboss presents. On A:
     `lncli lookupinvoice <hash>` shows `ACCEPTED` (held, not settled); the
     journal `held`; Amboss `WAITING_FOR_CHANNEL_OPEN`.

   Either way the coins for the channel stay reserved (Wallet: "promised to
   buyers"). Note which way it was.

**5. Channel open and report (node A)**

8. The lane opens the channel to B (with selling on, or for an
   order it accepted itself; an order accepted by hand with selling off waits
   for "Open channel" — the Orders tab says which; so does an order found
   paid with no invoice of ours in LND, accepted outside LightningMate). The
   journal records
   `opening` before the open and the funding outpoint right after it
   (`funded`), then `reported` once Amboss took the transaction
   (`SELLER_SENT_TRANSACTION`). The open states its fee rate ("open started
   at N sat/vB" in the order's history — LND's 6-block estimate). If 175 vB at
   that rate cost more than the order's fee after the 1 % service fee, the
   lane waits instead ("on-chain fees are N sat/vB: opening the channel would
   cost about …"): on regtest LND's estimate is bitcoind's fallback (about
   25 sat/vB, 4,375 sat an open), so the test order must pay more than that,
   or use "Open channel". An order whose payment Amboss holds is opened
   with A's invoice unpaid — what is at risk is the open's on-chain fee, the
   channel and its coins stay A's — and, should fees stay too high, whatever
   the fee in the last hours before Amboss's deadline (the wait says from
   when); one whose payment A holds is refunded instead.
9. The channel shows in Channels with its lease tag.

**6. Confirmation and settle**

10. After the confirmations Amboss asks for (three, by its own words), the
    order turns `VALID_CHANNEL_OPENING`. With the payment held on A, the
    invoice is **settled** within a lane pass (`SETTLED` in LND), the journal
    `settled`. With the payment held by Amboss, A's invoice is still unpaid
    then: the order says "channel confirmed — waiting for Amboss's payment
    (Amboss pays after the confirmation)" and nothing is claimed; once
    Amboss's payment arrives (`ACCEPTED` in LND) the next lane pass settles
    it. **Note how long Amboss takes to pay — not yet measured.** An alert
    tells the operator when it has taken more than six hours.
11. Booked once: Analytics / P&L shows the lease income of this sale once; the
    1 % service fee is in the fee ledger once (`GET /api/service-fees`) and
    paid in the background.
12. The lease promise: the channel's fee never goes above the caps the order
    locked (Channels → the channel's fee; the Fees tab says "lease promise"
    if the engine wanted more).

**7. The other paths (a second, smaller order each)**

- **Reject by hand**: Market → Orders → Reject. Amboss `SELLER_REJECTED`;
  no "turned down" alert (it was your decision). Should the click fail
  ("Your reject stands: …"), the lane sends the reject again on its next pass
  — selling on or off — and never accepts the order.
- **Pause while an order waits**: Autopilot → "Pause all automation", then
  place an order. The paused lane neither accepts nor rejects it: it stays
  "Waiting for you to accept" on Market → Orders, nothing is promised — accept
  or reject it yourself before its deadline.
- **Restart mid-order**: restart the app between the accept and the open,
  and again right after the open. No second invoice, no second
  channel; the order carries on.
- **Open by hand**: with selling on, open the order's channel yourself (the
  order's size, to the buyer) before the lane does — or report one on
  Amboss's site. The lane takes that channel as the order's ("opened
  outside LightningMate" in the order's history), reports it if Amboss does
  not have it yet, and opens no second one.
- **Buyer never pays** (only where the buyer pays A's invoice): the invoice
  expires unpaid (about 49 h), the order ends `BUYER_FAILED_TO_PAY`, the
  reserved coins are free again.

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
  or refunds the payment six hours after it was paid (sooner, should the held
  HTLC near its expiry first; the invoice asks for a 144-block CLTV).
- **Polling**: count ZEUS's `get_order` requests a minute while it waits — the
  LSP answers 30 a minute per peer.
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
