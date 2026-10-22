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
  - **Amboss**: public Magma market data from api.amboss.space and
    magma.amboss.tech (offers, recent sales, the dollar rate, and this node's
    public seller score, so its public key too). This is read **with or
    without an Amboss API key** — by the autopilot's runs, the Market pages
    and the Overview's lease benchmark — and never carries the key. With a
    key, the app also reads and manages your offers, orders and purchases
    (magma.amboss.tech for everything that acts). Those calls carry the key
    and are tied to your Amboss account.
  - **mempool.space**: the BTC price, only while a fiat currency is chosen.
  - **The service-fee lightning address**: an LNURL-pay lookup after a
    completed liquidity sale with the service fee enabled.

  The route depends on whether Umbrel gives the app its Tor proxy
  (`TOR_PROXY_IP` / `TOR_PROXY_PORT`):
  - **With the proxy**, LN+, the price lookup and Amboss's public market data
    (this node's own seller score included) go through Tor by default
    ("Lookups via Tor"). The Amboss calls made with your API key and the
    LNURL lookup go through Tor only with "Everything via Tor", and "Direct"
    sends nothing through it (Settings → Privacy). A lookup routed through
    Tor never falls back to a direct connection: when Amboss can't be read
    through Tor, the selling check and the Overview's lease benchmark say so
    and name the route setting.
  - **Without the proxy**, every one of them leaves from this server's
    internet connection, which is your home IP address.

  Settings → Privacy lists each destination with the route it takes right
  now. Every outbound request has a hard deadline.
- **LSP mode is off by default** (experimental) and adds the only surface that
  processes input from arbitrary network peers: LSPS1 (bLIP-51) JSON-RPC over
  BOLT8 custom messages. It is rate-limited per peer, wrapped in a hard crash
  boundary, and capital-guarded (on-chain reserve, per-channel and aggregate
  deployment caps shared with Magma selling). New orders are capped and paced
  per peer (two open, one replaced quote a minute, six an hour; the same
  request again gets the quote already made) and ten open in all. A request
  those limits rule out, or one the wallet can't fund (LND's balance as last
  read, at most 30 seconds old), is turned away before it takes the on-chain
  lock, under which every order is checked again before it is made — so a
  peer can't fill LND with hold invoices or keep the on-chain lock busy.
  Every parameter it uses is validated strictly; a parameter it doesn't know
  (a wallet's informational `client_info`, say) is ignored, never used — its
  name is logged and counted, made safe for the log and bounded in number,
  like the wallet names `client_info` carries. Payments are collected
  via **hold invoices that settle only after the channel's funding transaction
  is broadcast** — every failure path cancels the invoice, refunding the buyer.
  A settle or a refund LND refuses is tried again, with backoff, until LND
  answers; should LND release a payment before it could be claimed, the
  channel was given away — that raises an alert, it is never filed as a
  refund.
- **Magma sales** are collected the same way: the order is accepted with a
  hold invoice for the order's fee, the preimage is saved before the invoice
  exists, and the payment is settled only once Amboss confirms the channel
  (VALID_CHANNEL_OPENING). Every failure — the open fails, the channel doesn't
  match, the held payment nears its expiry — cancels the invoice, refunding the
  buyer. Each step is written to `magma-orders.json` before it happens, so a
  restart never opens a second channel for an order; the accept itself is
  marked on disk before it goes out, so after a crash the order lane's own
  accept that never left is withdrawn (nothing promised) if selling was
  switched off meanwhile — one you clicked is your decision and goes out —
  and one that may have reached Amboss is completed. An accept whose mark
  can't be saved is not sent at all: its invoice is released, and the order
  is decided again — a running lane rejects it rather than leave it to time
  out when its approval deadline is close; a paused lane leaves it to the
  operator — as either does an order whose accept you clicked. Switched
  off — or with all automation paused — the order lane neither accepts nor
  turns down a new order: it is the operator's to decide. A decision you make
  by hand wins over the lane, for an order the lane isn't working on at that
  moment: a click on Accept or Reject that finds the order — Amboss shows it
  as this node's, awaiting approval, or the lane has it on record as awaiting
  approval — makes the order yours, whatever becomes of the click — except
  for an accept already sent whose answer was lost (the record says
  "accepting"), yours or the lane's: an accept that may have reached Amboss
  is completed first, and a Reject meanwhile is refused ("Not rejected: the
  earlier accept of this order was already sent and is being confirmed with
  Amboss, so it can't be withdrawn."), though Amboss may still show the order
  awaiting approval. A reject Amboss didn't confirm is sent again on every
  pass — paused or not — until Amboss confirms it or the order ends, and that
  order is never accepted; after an accept that didn't go through, the lane
  neither accepts the order nor turns it down. A click that finds neither
  (Amboss or LND not answering) records nothing: with Liquidity provision on,
  the lane may decide that order before you try again. A click that arrives
  while the lane is already deciding or acting on that same order — its
  capital check, its dial of the buyer (up to about a minute and a half over
  Tor), its own accept or reject, or the resend of an earlier reject of
  yours — waits for that step to finish; if the order was accepted or
  rejected meanwhile, the click says so — done, if that is what it asked for
  ("Order is already accepted.", "Order is already rejected."); refused, if
  it asked for the other ("Order is WAITING_FOR_BUYER_PAYMENT — only orders
  awaiting approval can be rejected", "Order is SELLER_REJECTED, not awaiting
  approval").
  Every channel open and
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
- **Dependencies** come from the lockfile (`npm ci`). CI fails a commit with a
  known high or critical vulnerability in a production dependency
  (`npm audit --omit=dev --audit-level=high`), and Dependabot proposes updates
  to the npm packages, the workflow actions and the base image. Transitive
  fixes the `lightning` library's own ranges would let through are forced with
  `overrides`, as ranges, each named with its advisory in `package.json`.
- **Releases** are traceable and immutable — see "Release integrity" below.

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
- **Cross-site requests are refused** under `/api`, in every mode: a request a
  browser marks as coming from another site's page (`Sec-Fetch-Site:
  cross-site`) gets `403`, and every POST must be JSON (`Content-Type:
  application/json`, else `415`) — the one kind of cross-site write a browser
  sends without asking first, an HTML form, can't be JSON, and a cross-site
  fetch that is needs a CORS preflight the server never grants. This matters
  most for standalone without a password, which has no login: before, any
  page the owner opened could POST a form to `/api/autopilot/resume`, `/run`,
  `/pause` or `/backup/export`, which act without a body. (On Umbrel and with
  a password the session token, which a foreign page can't set, already
  stopped that.) The web UI sends JSON on every POST. Nothing else calls the
  API: Umbrel's widget poll is a GET from umbreld, LSPS1 runs over Lightning
  peer messages, and no service calls back.
- **DNS rebinding:** without a login, only requests for `localhost`,
  `127.0.0.1`, `::1` or the address the API is bound to (`LM_BIND`) are
  served — a page that rebinds its own name to 127.0.0.1 gets `403`.
  `LM_ALLOWED_HOSTS` (comma-separated) sets the list explicitly, in any mode.
  With a login there is no default list (Umbrel's app proxy may rewrite
  `Host`), and the request's `Origin` is never compared with its `Host`.
- All state-changing endpoints validate inputs (pubkey/txid/channel-id formats,
  sat/ppm bounds; every autopilot setting has a range — out-of-range or blank
  values are rejected, never coerced). Write and login limits are kept **per
  client address**, and only failed logins count, so another container on the
  Docker network can't lock the owner out.

## Release integrity

- **Images are immutable**: the image workflow refuses to publish a tag the
  registry already has, and a manual run can publish only test tags
  (`dev-…`). A broken release is fixed by the next version.
- **Every image says where it came from**: OCI labels (source, commit,
  version) on each architecture's image and as annotations on the manifest
  list, a build provenance attestation and an SBOM pushed with it, and the
  commit stamped into the app ("Download diagnostics").
- **Pinned inputs**: the Dockerfile's base image by digest, every workflow
  action by commit (the image workflow can write packages). The runtime image
  holds the server's production dependencies only.
- To check an image: `docker buildx imagetools inspect
  ghcr.io/opensourceminers/lightningmate:<tag>` (and `--format '{{json
  .Provenance}}'`); the steps are in [docs/RELEASING.md](docs/RELEASING.md).

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

The state lives in `DATA_DIR`: in the Docker image `/data`, owned by the user
the app runs as (`node`, uid 1000 — never root; the app's own code under
`/app` is root's and not writable by it) — on Umbrel the app's own data dir,
standalone a volume (README: `-v lightningmate-data:/data`); run from a
checkout, `<repo>/.data`. It holds the settings, the Amboss key and the order
records whose saved preimages claim buyers' held payments: the files are
written readable by their owner only (mode 0600) — keep the directory private.

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
  info:read offchain:read onchain:read invoices:read peers:read \
  offchain:write onchain:write peers:write invoices:write address:write \
  --save_to lightningmate.macaroon
```

- `peers:read` is needed by every channel open — manual, autopilot, Magma or
  LSP mode: before an open, LightningMate checks the connection to the peer
  with LND's ListPeers, and the lightning library's addPeer does the same
  right after it dials. Without it no channel can be opened, and LightningMate
  says so: the channel and Magma areas show as blocked naming the missing
  permission, a new Magma order is turned down with that reason, and LSP mode
  takes no new order, its Settings card saying why. (An earlier version of
  this recipe left it out; a macaroon baked from it needs baking again, and
  LightningMate a restart.)
- `invoices:read`/`invoices:write` and `address:write` are used by the hold
  invoices of Magma sales and LSP mode, and by rebalancing's own invoices —
  include them even if you don't sell; they grant no spend power.

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
