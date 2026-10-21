# Security

LightningMate manages a Lightning node and can move funds. This documents its
security posture and how to harden it. Found an issue? Email
security@opensourceminers.de (please don't open a public issue first).

## Posture

- **Read-only by default.** Writes (fee changes, rebalancing, opening/closing
  channels, autopilot) are off unless you opt in with `LM_ENABLE_WRITE=true` and
  a write-capable macaroon.
- **Outbound traffic, said plainly.** Your node stays Tor-only, but
  LightningMate's own lookups are the app's, not the node's. Beyond LND, the
  app talks to:
  - **LN+ (lightningnetwork.plus)**: node reputations for picking peers and
    for the Pool and Swaps views. This includes a lookup of this node's own
    public key. LN+ lookups are **on by default**; switch them off under
    Settings → Privacy ("LN+ lookups").
  - **Amboss**: public Magma market data from api.amboss.space (offers,
    recent sales, and this node's public seller score, so its public key too).
    This is fetched **with or without an Amboss API key**, by the autopilot's
    runs and the Market pages. With a key, the app also reads and manages
    your offers, orders and purchases (magma.amboss.tech for everything that
    acts). Those calls are tied to your Amboss account.
  - **mempool.space**: the BTC price, only while a fiat currency is chosen.
  - **The service-fee lightning address**: an LNURL-pay lookup after a
    completed liquidity sale with the service fee enabled.

  The route depends on whether Umbrel gives the app its Tor proxy
  (`TOR_PROXY_IP` / `TOR_PROXY_PORT`):
  - **With the proxy**, LN+ and the price lookup go through Tor by default
    ("Lookups via Tor"). Amboss and the LNURL lookup go through Tor only with
    "Everything via Tor", and "Direct" sends nothing through it (Settings →
    Privacy). A lookup routed through Tor never falls back to a direct
    connection.
  - **Without the proxy**, every one of them leaves from this server's
    internet connection, which is your home IP address.

  Settings → Privacy lists each destination with the route it takes right
  now. Every outbound request has a hard deadline.
- **LSP mode is off by default** and adds the only surface that processes input
  from arbitrary network peers: LSPS1 (bLIP-51) JSON-RPC over BOLT8 custom
  messages. It is rate-limited per peer, strictly validated, wrapped in a hard
  crash boundary, and capital-guarded (on-chain reserve, per-channel and
  aggregate deployment caps shared with Magma selling). Payments are collected
  via **hold invoices that settle only after the channel's funding transaction
  is broadcast** — every failure path cancels the invoice, refunding the buyer.
- **Magma sales** are collected the same way: the order is accepted with a
  hold invoice for the order's fee, the preimage is saved before the invoice
  exists, and the payment is settled only once Amboss confirms the channel
  (VALID_CHANNEL_OPENING). Every failure — the open fails, the channel doesn't
  match, the held payment nears its expiry — cancels the invoice, refunding the
  buyer. Each step is written to `magma-orders.json` before it happens, so a
  restart never opens a second channel for an order. Every channel open and
  every on-chain send takes one on-chain lock; Magma, LSPS1 and autopilot opens
  share one capital budget, and a manual open or send may not spend the coins
  promised to buyers (accepted Magma orders, paid LSPS1 orders) unless you
  confirm it — the confirmation names those orders. If the order journal is
  lost, no channel is opened for an order whose held payment can no longer be
  claimed: that payment is released back to the buyer — and any unpaid invoice
  of ours for an order that gets no channel is cancelled, so no payment can
  land on it later.
- **Secrets** (`tls.cert`, macaroons) are read from the mounted LND data dir at
  runtime — never baked into the image, committed to git, or logged.
- **Dependencies** are pinned and `npm audit` is kept at 0 known vulnerabilities
  (transitive DoS advisories patched via `overrides`).

## Network exposure & auth

- **Umbrel:** the API requires a session token proving the **per-app password**
  Umbrel generates for the app (`deterministicPassword`, shown when you open it).
  Other containers share the Docker network, so this stops them from using the
  API; it also runs behind Umbrel's `app_proxy`. The container binds `0.0.0.0`
  (so app_proxy can reach it) — set via `LM_BIND`. `$APP_PASSWORD` / `$APP_SEED`
  are injected by Umbrel and used to verify and sign the session token.
- **Standalone/dev:** with no `APP_PASSWORD` set it runs without a login, so it
  **refuses to start unless bound to loopback** (`127.0.0.1`/`::1`, the default).
  To bind anything else (e.g. `LM_BIND=0.0.0.0` inside Docker), set
  `APP_PASSWORD`. Don't expose it to a LAN/WAN without an authenticating
  reverse proxy.
- **No CORS** is sent, so a malicious web page can't read responses or make
  cross-site JSON requests to the API.
- **DNS rebinding:** without a login, only loopback `Host` headers
  (`localhost`, `127.0.0.1`, `::1`) are served by default. `LM_ALLOWED_HOSTS`
  (comma-separated) sets the list explicitly, in any mode.
- All state-changing endpoints validate inputs (pubkey/txid/channel-id formats,
  sat/ppm bounds; every autopilot setting has a range — out-of-range or blank
  values are rejected, never coerced). Write and login limits are kept **per
  client address**, and only failed logins count, so another container on the
  Docker network can't lock the owner out.

## Service fee (completed sales)

The transparent 1% fee on completed liquidity sales is paid to the Lightning
Address in `LM_SELL_FEE_ADDRESS` (set by the app store compose, rate in
`LM_SELL_FEE_BPS`). It **fails closed**: the invoice the fee server returns is
paid only if it is for exactly the computed fee (LUD-06 amount check), unexpired
and not to this node; the LNURL callback must be https on the address's own
host; and with `LM_SELL_FEE_PUBKEY` set, only invoices to that node id are paid.
Fees are paid from a persistent ledger in the background — never inside an
order's accept/open/settle path — with a hard per-attempt timeout, retries with
backoff, and a recorded payment hash so a crash or timeout can never pay twice.
A fee refused for a security reason (wrong amount, wrong payee, foreign
callback) raises an alert at once; a fee that still has not gone through after
10 attempts (about three days) is given up and raises an alert too. Dismissing
an alert silences only the problem it showed: a later, different one — another
kind of refusal, or the give-up after a dismissed refusal — is alerted again.

## State on disk

All state files are written atomically (temp file → fsync → rename; the previous
version is kept as `.bak`). A damaged file is never silently replaced by
defaults: it is moved aside as `<name>.corrupt-<time>`, the backup is restored
when possible, and an alert stays up until acknowledged. The same goes for a
file that is missing while its backup or a damaged copy is still there (a
recovery cut short by a crash or a full disk); only a first start, with
neither, begins from defaults without an alert. Each loss is alerted once:
finding it again because the disk is still full adds no second alert, but a
file lost again after it was saved is a new alert. The Amboss API key is the
exception to keeping old versions: when it is replaced or removed
(Disconnect), no copy of the old key stays on disk — no `.bak`, no damaged
copy (they are deleted before the new key is written, so not even a power cut
in between leaves one), and on a full disk the file is deleted rather than
left behind — and a damaged amboss.json is reported without quoting its
contents. A key is only marked invalid when Amboss definitively refuses it;
an outage leaves it alone. Autopilot
settings an older version saved outside today's limits are adjusted on load to
the closest valid value, and a fraction in a whole-number setting is rounded
toward doing less. The run interval may be as long as a timer can hold (about
25 days), so a slow schedule an older version honoured is kept as it was. Where
even the closest value would let the autopilot do more than the saved value
allowed — a channel size below the minimum (no open ever went through) or
above the 10 BTC maximum (an open waited until the whole size was on-chain), a
rebalance cost cap of 0, an hour window that never opened — that automation is
switched off instead. Either way the adjustment is shown as an alert.

## Least-privilege write macaroon (recommended)

By default, write mode auto-discovers the **admin** macaroon — convenient, but
it grants full node authority. For a smaller blast radius, bake a macaroon with
only the permissions LightningMate needs and point `LND_WRITE_MACAROON_PATH` at
it:

```bash
# in the Umbrel lightning app (or via lncli)
lncli bakemacaroon \
  info:read offchain:read onchain:read invoices:read \
  offchain:write onchain:write peers:write invoices:write address:write \
  --save_to lightningmate.macaroon
```

(`invoices:read` + `address:write` are used by LSP mode's hold-invoice flow;
include them even if you don't plan to enable it — they grant no spend power.)

Then in the app config:

```yaml
LM_ENABLE_WRITE: "true"
LND_WRITE_MACAROON_PATH: "/lnd/lightningmate.macaroon"
```

This still permits rebalancing (which sends payments) and opening/closing
channels, but excludes admin-only powers like baking further macaroons, message
signing, and wallet/seed access.

> Note: the optional Amboss sign-in helper (Settings → Sign message) uses LND's
> message signing, which the macaroon above omits. Add the message-signing
> permission if you want to use that helper; nothing else in the app needs it.

## Reducing risk further

- Leave write mode **off** unless you use the automation; the dashboard,
  forwards, P&L and suggestions are all read-only.
- Use the per-channel **exclude** override to keep the autopilot off sensitive
  channels.
- The autopilot has safety rails: per-channel cooldowns, max-changes-per-run
  caps, a profit gate on rebalances, and an on-chain reserve for channel opens.
