# ⚡ Lightning Mate

Self-hosted management dashboard **and autopilot** for a Bitcoin Lightning node
on Umbrel (LND). It replaces manual babysitting with visibility, profit
accounting, and optional automation for fees, rebalancing, channels and
liquidity.

Packaged for Umbrel (one-click install, auto-discovers LND). Also runs
standalone via Docker.

## Features

- **Overview** — a node **health score** (six categories on a score ring), an
  outbound/inbound **liquidity meter**, KPIs (earned / forwards with 24h·7d at a
  glance / routed / **yield on capital**), a **Profit & Loss** view (routing
  revenue vs channel-open and rebalancing costs), a liquidity map, recent
  activity, your **top earning channels** and graph-based **peer suggestions**.
- **Channels** — live balance bars with source / sink / router roles, scored
  peer suggestions, and close candidates. Closing opens a dialog to pick the
  on-chain fee (fast / economy / custom) or force-close, and the channel stays
  visible as "pending close" until it confirms.
- **Market (Amboss Magma)** — **buy** inbound liquidity (USD-priced) and **sell**
  your own: create / edit offers and fulfil orders (accept + open a channel to
  the buyer), manually or via the autopilot.
- **Wallet** — Lightning + on-chain: receive, send, decode and pay invoices.
- **Routing** — a full forwards report (per-channel, daily, recent events).
- **Autopilot** — a one-click **Strategy** (Max routing / Balanced / Max profit)
  tunes fees, rebalancing, channel-opening and Magma together. Fees are
  volume-first (competitive, zero base fee) with profit floors so a channel never
  routes below its refill cost; rebalances run only when profitable (within a
  daily budget); channels open to top peers; Magma sell orders are fulfilled — all
  on recommended settings with safe caps, per-channel cooldowns and an on-chain
  reserve. Off until you enable it, and every fund-moving action is gated behind
  write access.

## Architecture

```
LightningMate/
├── server/   Node + TypeScript backend (LND gRPC via ln-service, REST API, Amboss client)
└── web/      React + Vite dashboard
```

The backend talks to LND with the [`lightning`](https://www.npmjs.com/package/lightning)
(ln-service) library and to the Amboss Magma marketplace over GraphQL. In
production it also serves the built React app, so the whole tool is **one
container on one port**.

## Authentication

- **On Umbrel** Lightning Mate signs in with the **per-app password** Umbrel
  generates for it (`deterministicPassword`), shown when you open the app. The
  whole API requires a session token proving that password, so no other app on
  your server can read your node or move your funds.
- **Standalone** binds to `127.0.0.1` and runs without a login (reachable only
  from the same machine). Don't expose it to a LAN/WAN without an authenticating
  reverse proxy.

## Read-only vs. write

Read-only by default — the dashboard, forwards, P&L and suggestions only
observe. To let it **apply fee changes, rebalance, open/close channels, run the
autopilot and fulfil Magma orders**, opt in with `LM_ENABLE_WRITE=true` and a
write-capable macaroon (admin works; a least-privilege baked macaroon is
recommended — see [SECURITY.md](SECURITY.md)). On Umbrel the admin macaroon is
auto-discovered from the mounted LND data dir.

## Connecting to your Umbrel LND (standalone)

Lightning Mate needs the LND gRPC socket, the TLS cert, and a macaroon
(**read-only** to observe, **admin** to also manage):

| Value          | Where it lives on Umbrel                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `LND_SOCKET`   | host:port of LND gRPC, e.g. `umbrel.local:10009` or the container host `lnd:10009` |
| `LND_CERT`     | base64 of `tls.cert`                                                                |
| `LND_MACAROON` | base64 of `readonly.macaroon` (or `admin.macaroon` for write mode)                  |

On Umbrel the LND data dir is typically `~/umbrel/app-data/lightning/data/lnd/`.
Grab the cert + macaroon as base64 (run on the Umbrel host):

```bash
base64 -w0 ~/umbrel/app-data/lightning/data/lnd/tls.cert
base64 -w0 ~/umbrel/app-data/lightning/data/lnd/data/chain/bitcoin/mainnet/readonly.macaroon
```

Then copy `.env.example` → `.env` and paste the values. (Prefer mounting files?
Use `LND_CERT_PATH` / `LND_MACAROON_PATH` instead.)

## Development

```bash
npm install            # installs both server and web workspaces
npm run dev            # backend (:3001) + frontend (:5173) together
```

Open http://localhost:5173.

## Production (single container)

```bash
docker build -t lightningmate .
docker run -p 3001:3001 --env-file .env lightningmate   # standalone
```

The published multi-arch image is built by CI on version tags and pushed to
`ghcr.io/opensourceminers/lightningmate` (amd64 + arm64, digest-pinned).

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

## License

MIT
