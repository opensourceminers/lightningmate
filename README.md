# ⚡ Lightning Mate

Self-hosted management dashboard **and autopilot** for a Bitcoin Lightning node
on Umbrel (LND). It replaces manual babysitting with visibility, profit
accounting, and optional automation for fees, rebalancing, channels and
liquidity.

Packaged for Umbrel (one-click install, auto-discovers LND). Also runs
standalone via Docker.

## Features

- **Overview** — a node **health score** (six categories on a score ring;
  channels still opening or closing are left out, and Earnings are judged net
  of rebalancing, on-chain and inbound costs, with lease income counted as in
  P&L — a node too young to judge gets a provisional grade), an
  outbound/inbound **liquidity meter**, KPIs (earned /
  forwards with rolling 24h·7d / routed / **yield on capital**), a **Profit &
  Loss** view (routing revenue and lease income vs every cost: channel opens,
  channel closes — worked out from the closing transactions and sweeps
  themselves —, rebalancing by any tool, from LND's own payment history,
  inbound bought on Magma, and the service fee), a liquidity map, recent
  activity (a rebalance as one line, channel opens and closes named), your
  **top channels** (fees earned out plus those of the flow they brought in)
  and graph-based **peer suggestions**.
- **Channels** — live balance bars with source / sink / router roles, scored
  peer suggestions, and close candidates — never a channel still opening or
  closing, or one inside its lease (sold on Magma or over LSPS1, or bought on
  Magma; the table tags those). A sale older than the app's order journal is
  known from Amboss's listing of this node's running leases (with an Amboss
  key): the listing is kept on disk, and the close list and a close ask
  Amboss for it again only when the copy is over an hour old. A sale that
  listing still reports running stays protected — its routing-fee promise
  kept, its channel never drained by a rebalance — even after the journal's
  own count has ended. A peer counts as offline only after days away.
  Closing opens a dialog to pick the on-chain fee (fast / normal / economy /
  custom; economy is preselected); a
  peer that is away is offered a reconnect first, a force-close is
  its own step that says what it does, and breaking a lease needs an explicit
  "close it anyway". The channel stays visible as "pending close" until it
  confirms.
- **Market (Amboss Magma)** — **buy** inbound liquidity (offers ranked by what
  they really cost per year of lease, Amboss's fee included; purchases are
  recorded and followed to their channel) and, as an advanced opt-in feature,
  **sell** your own: create / edit offers and fulfil orders (accept + open a
  channel to the buyer), manually or via the autopilot. Selling is off by
  default; before you switch **Liquidity provision** on, a live check of
  Amboss's public offer book shows whether offers like yours sell at all
  (Amboss picks sellers mostly by track record — price and size are not the
  lever below that), and a diagnostics card answers "why don't I sell?".
  Selling runs on Amboss's Magma API:
  an order is accepted with a **hold invoice** that settles only once Amboss
  confirms the channel (any failure refunds the buyer automatically), every
  step is recorded in a per-order journal before it happens (a crash or a lost
  answer never leads to a second channel), and orders the node can't serve are
  rejected at once instead of being left to time out. A decision you make by
  hand on Market → Orders wins over the autopilot, for an order the autopilot
  isn't working on at that moment: a reject Amboss didn't confirm is sent
  again until it is or the order ends (that order is never accepted), and an
  order whose accept didn't go through waits for your decision — the
  autopilot neither accepts nor rejects it. The one exception is an accept
  already sent whose answer was lost (the order shows "accepting…"), yours or
  the autopilot's: an accept that may have reached Amboss is completed first,
  and a Reject meanwhile is refused ("Not rejected: the earlier accept of this
  order was already sent and is being confirmed with Amboss, so it can't be
  withdrawn."), though Amboss may still show the order awaiting approval. A
  click that arrives while the autopilot is already deciding or acting on that
  same order — checking capital, dialing the buyer (up to about a minute and a
  half over Tor), sending its own accept or reject, or sending an earlier
  reject of yours again — waits for that step to finish; if the order was
  accepted or rejected meanwhile, the click says so — done, if that is what it
  asked for ("Order is already accepted.", "Order is already rejected.");
  refused, if it asked for the other ("Order is WAITING_FOR_BUYER_PAYMENT —
  only orders awaiting approval can be rejected"). A click that can't read the
  order (Amboss or LND not answering) counts too once the autopilot has the
  order on record as awaiting your decision; otherwise it records nothing —
  try it again (with Liquidity provision on, the autopilot may decide that
  order first). Amboss decides which seller gets matched; the app makes the
  sell path correct and reliable.
- **LSP mode (experimental)** — sell inbound channels **directly to wallets**
  speaking the open LSPS1 standard (bLIP-51) over Lightning peer messages, with
  no marketplace in between: orders are priced by the same profit-aware engine
  as Magma selling, paid via a **hold invoice that only settles once the
  channel is opening** (every failure path refunds the buyer automatically),
  and capital is guarded by the same reserve and deployment caps. Few wallets
  can order this way — as far as we know, ZEUS with its embedded node; wallets
  that order over HTTPS can't — and on a Tor-only node the buyer also needs
  Tor (ZEUS's embedded Tor, off by default). Includes graph discovery (feature
  bit 729) and a shareable buyer guide with the node's .onion address: Tor-only,
  no port to open on any router. Off by default.
- **Wallet** — Lightning + on-chain: receive, send, decode and pay invoices.
  An on-chain send is previewed first — its fee in sats from LND's own size
  of the transaction, LND's next-block rate beside it (its 2-block rate on
  LND before 0.20), and what stays — and a rate above 3× that, a fee above
  2 % of the amount, or a send that dips into the on-chain reserve needs a
  second yes (the server checks it again). "Max" sends the most that keeps
  the reserve and the coins promised to buyers (the page's "available to
  send" is the same figure for a typical send at the suggested rate); a send
  that would take promised coins is refused unless you confirm it with the
  orders named. "Send everything" empties the wallet (LND keeps
  its anchor reserve).
- **Routing** — a full forwards report (per-channel, daily, recent events).
- **Autopilot** — a **Strategy** preset (Max routing / Balanced / Max profit)
  tunes fees, rebalancing and channel opening together — it shows exactly what
  it changes (what moves capital first) and applies after you confirm;
  no preset ever touches Magma selling, which stays your own explicit decision.
  **Pause all automation** switches every automation off at once — a run in
  progress starts no further fee write, refill, open, offer change or Magma
  order accept (a payment or open already under way finishes, and Magma
  orders already taken on are carried to their end). A paused order lane
  neither accepts nor turns down a new order: it waits for you on Market →
  Orders, which says whether a paid order's channel is opened by the
  autopilot or by you. Resume brings back what
  was on, selling excepted. LSP mode (Settings) is not part of the pause:
  while it is on it keeps answering wallet orders and opening their channels,
  and the pause says so. Each area — fees, rebalancing, channels, Magma —
  says what it last decided and why (acted, nothing to do, waiting, deferred,
  blocked, error), on its sub-tab and on the Overview — a failure that repeats
  (a fee LND keeps refusing, a wallet that can't fund an open) is reported by
  every run it happens in, with one line in the run history; settings below the
  switches are saved together, after a check of every value. Fees are volume-first
  (competitive, zero base fee); a refilled channel's fee is held at what the
  refill was valued at while its sats route out (at most 30 days, capped at Max
  ppm unless you opt in, released when they barely move), a raise waits for a
  sale at the fee before it, and one nobody buys at steps back — and every
  channel sold through Magma or LSPS1 is kept
  within the routing-fee cap its buyer was promised, for the lease; rebalances
  run only when they pass the profit check (valued at the fee the channel keeps
  after the refill, the payment capped by that check — at the planned size, the
  largest size the check allows at the route's cost, then smaller ones), within
  one daily fee budget that manual runs count toward too — on a small, low-fee
  node that is rarely; channels open to top peers;
  with Liquidity provision on, Magma sell orders are fulfilled — all on
  recommended settings with safe caps, per-channel cooldowns and an on-chain
  reserve. Off until you enable it, and every fund-moving action is gated behind
  write access.
- **More forwards** — the optional **Advertise routable size** pass keeps each
  channel's gossiped max HTLC just under its spendable balance (power-of-2
  buckets; under 1,024 sat, the channel's min HTLC) so senders skip depleted
  channels — an update LND takes but the channel doesn't advertise is recorded
  once and left alone for 6 h — and the **Unserved demand** panel
  shows the payments your node had to turn away for lack of liquidity — with
  probes, retries and HTLCs too big for any refill counted apart, so what is left
  is possible demand a refill could have carried (not a promise of income).

## Architecture

```
LightningMate/
├── server/   Node + TypeScript backend (LND gRPC via ln-service, REST API, Amboss client)
│   └── src/apiTypes.ts   the API's payload types — one source for server and web
└── web/      React + Vite dashboard
```

The backend talks to LND with the [`lightning`](https://www.npmjs.com/package/lightning)
(ln-service) library and to the Amboss Magma marketplace over GraphQL (selling
on Amboss's Magma API, `magma.amboss.tech`). In production it also serves the
built React app, so the whole tool is **one container on one port**. The API's
payload types — what the routes answer and what the web sends them — are
declared once (`server/src/apiTypes.ts`): every body a route builds is checked
against them where it is sent, a route reads a request's body and query
string only as their contract types (`bodyOf<…>(req)`, `queryOf<…>(req)`,
whose keys are the type's — a read can't be widened to another contract
type's keys, nor handed to code that reads them), and the web imports them
type-only — a payload that changes shape fails the type-check instead of
drifting from a hand-kept copy. The contract check
(`npm run check:api-types`) also pairs the two sides: every body a route can
send must fit the type the web client reads that route's answer as, and
every request the web sends — its body, its query — names the very type its
route reads. The server's compiler settings include the checks the web's
applies to the server files it reads, so a server-only change fails in the
server's own check, not in the web's build.

## Authentication

- **On Umbrel** Lightning Mate signs in with the **per-app password** Umbrel
  generates for it (`deterministicPassword`), shown when you open the app. The
  whole API requires a session token proving that password, so no other app on
  your server can read your node or move your funds.
- **Standalone** binds to `127.0.0.1` and runs without a login (reachable only
  from the same machine). It refuses to start bound to anything else unless
  `APP_PASSWORD` sets a login. Without a login it serves only requests for
  `localhost`, `127.0.0.1`, `::1` or the address it is bound to (no DNS
  rebinding), refuses any request a browser marks as coming from another
  site, and takes every POST as JSON only — so a web page you happen to open
  can't pause, resume or run the autopilot, or export your channel backup
  (SECURITY.md). Don't expose it to a LAN/WAN without an authenticating
  reverse proxy.

## Read-only vs. write

Read-only by default — the dashboard, forwards, P&L and suggestions only
observe. To let it **apply fee changes, rebalance, open/close channels, run the
autopilot and fulfil Magma orders**, opt in with `LM_ENABLE_WRITE=true` and a
write-capable macaroon (admin works; a least-privilege baked macaroon is
recommended — see [SECURITY.md](SECURITY.md)). On Umbrel the admin macaroon is
auto-discovered from the mounted LND data dir.

## Connecting to your Umbrel LND (standalone)

Lightning Mate needs the LND gRPC socket, the TLS cert and the **read-only**
macaroon to observe — and, to also manage, a **write** macaroon of its own:

| Value                | Where it lives on Umbrel                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `LND_SOCKET`         | host:port of LND gRPC, e.g. `umbrel.local:10009` or the container host `lnd:10009` |
| `LND_CERT`           | base64 of `tls.cert`                                                                |
| `LND_MACAROON`       | base64 of `readonly.macaroon` — the reads; it never writes                          |
| `LND_WRITE_MACAROON` | write mode only (with `LM_ENABLE_WRITE=true`): base64 of `admin.macaroon`, or of the least-privilege macaroon [SECURITY.md](SECURITY.md) bakes (`peers:read` included) |

On Umbrel the LND data dir is typically `~/umbrel/app-data/lightning/data/lnd/`.
Grab the cert + macaroon as base64 (run on the Umbrel host):

```bash
base64 -w0 ~/umbrel/app-data/lightning/data/lnd/tls.cert
base64 -w0 ~/umbrel/app-data/lightning/data/lnd/data/chain/bitcoin/mainnet/readonly.macaroon
```

Then copy `.env.example` → `.env` and paste the values. (Prefer mounting files?
Use `LND_CERT_PATH` / `LND_MACAROON_PATH` / `LND_WRITE_MACAROON_PATH` instead.)

## Development

```bash
npm install            # installs both server and web workspaces
npm run dev            # backend (:3001) + frontend (:5173) together
npm run typecheck      # server + web, including the tests
npm run check:api-types  # the routes' bodies and the web against the one set of payload types
npm test               # server + web test suites (node:test, fake LND, no network)
```

Open http://localhost:5173. CI runs `npm ci`, an audit of the production
dependencies, the type-check, the API contract check, the tests and the build
on every push and pull request (`.github/workflows/ci.yml`); Dependabot keeps
dependencies, actions and the base image current. The tests never touch a
real node or Amboss; the money paths that need the real systems have manual
end-to-end procedures in [docs/E2E-TESTING.md](docs/E2E-TESTING.md).

## Production (single container)

```bash
docker build -t lightningmate .
# standalone: inside the container the API must bind 0.0.0.0, so it requires a
# login — set LM_BIND=0.0.0.0 and APP_PASSWORD in .env (see .env.example), not
# with -e on the command line, where the password would end up in your shell
# history and in `ps`. The port is published on this machine only.
# --stop-timeout 60: Docker kills a container 10 s after `docker stop` by default;
# the app takes up to 45 s to let work under way finish and save its state
# (below). Umbrel's compose gives it the same minute (stop_grace_period: 1m).
docker run -p 127.0.0.1:3001:3001 --env-file .env -v lightningmate-data:/data --stop-timeout 60 lightningmate
```

The named volume `lightningmate-data` holds the app's state (`/data` in the
container): the settings and the autopilot's history, the Magma and LSPS1
order records — what claims a buyer's held payment — the rebalance, earnings
and service-fee ledgers, and the Amboss key. Keep it across updates (run the
new image with the same `-v`); without a volume that state goes with the
container.

LightningMate refuses to start when it would serve its API beyond loopback
without a login. On `docker stop` it answers new state-changing requests with
`503` (send them again once it is back up; reads keep working), starts no new
payment, channel open or order step of its own, and gives whatever is already
under way — an autopilot step, an LSP channel open, a request sent from the UI,
even one whose browser or proxy connection has already gone — up to 37 seconds
to finish (a held LSP payment is left for restart recovery). Then it saves its
state and exits, within 45 seconds of the signal: hence the recipe's
`--stop-timeout 60`. With Docker's default of 10 s, work still under way would
be cut off and left for the restart's recovery instead.

The published multi-arch image is built by CI on version tags and pushed to
`ghcr.io/opensourceminers/lightningmate` (amd64 + arm64): every image carries
its source, commit and version, a provenance attestation and an SBOM, and a
published tag is never rebuilt or overwritten. How a release is cut and goes
to the two Umbrel stores: [docs/RELEASING.md](docs/RELEASING.md).

## Umbrel App Store

Packaging lives in [`packaging/umbrel/lightningmate/`](packaging/umbrel/lightningmate/).
It declares `dependencies: [lightning]`, so on Umbrel it **auto-discovers** LND —
no manual cert/macaroon pasting. The compose mounts LND's data dir read-only
(`/lnd`) and passes the connection details from the lightning app; the admin
macaroon is auto-discovered for write mode.

- **Community store** — published in the opensourceminers app store (install by
  adding that store's URL in umbrelOS). New features land here first.
- **Official store** — submission PR to
  [`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps). See
  [`packaging/umbrel/SUBMISSION.md`](packaging/umbrel/SUBMISSION.md).

The folder holds what the next release publishes: the image pin and version
the stores have now, plus the changes waiting for that release (the Tor proxy
lines, the official store's category, draft release notes). A release updates
both stores from it and then the folder ([docs/RELEASING.md](docs/RELEASING.md)).

## Documentation

- [SECURITY.md](SECURITY.md) — what leaves your node and by which route, auth,
  state on disk, the service fee, release integrity, hardening.
- [docs/AUTOPILOT-STRATEGY.md](docs/AUTOPILOT-STRATEGY.md) — how the fee engine,
  rebalancing, channel opens, Magma selling and the presets work.
- [docs/LSP-MODE.md](docs/LSP-MODE.md) — LSP mode (LSPS1), its reach and its
  safety.
- [docs/RELEASING.md](docs/RELEASING.md) — cutting a release; the store manifests.
- [docs/E2E-TESTING.md](docs/E2E-TESTING.md) — manual end-to-end tests: Magma
  selling with a second node, an LSPS1 buy from ZEUS over Tor.
- [docs/ALGO-AUDIT.md](docs/ALGO-AUDIT.md) — the June 2026 algorithm audit
  (German, historical) with what the fixes made of it.

## License

MIT
