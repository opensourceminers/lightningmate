# ⚡ Lightning Mate

Management and autopilot for an LND Lightning node on Umbrel. See what each
channel earns and what needs you today, and let the autopilot look after fees,
refills and new channels. It does nothing on its own until you switch it on.

![Lightning Mate's start page](https://cdn.jsdelivr.net/gh/opensourceminers/umbrel-app-store@master/opensourceminers-lightningmate/gallery/0.9.1/1-start.png)

## Install

**On Umbrel.** Lightning Mate finds your Lightning Node app by itself; there is
no certificate or macaroon to paste.

- **Umbrel App Store:** search for *Lightning Mate*.
- **Community store**, where new versions arrive first: in the App Store, open
  *Community App Stores* and add `https://github.com/opensourceminers/umbrel-app-store`.

Sign in with the password Umbrel shows for the app. A new install asks three
short questions: what the node is for, how much the app may use, and what that
will do.

**Anywhere else:** one Docker container next to your LND, see
[Run with Docker](#run-with-docker).

## What it does

- **Start page:** what needs you today, your balances, a health score for the
  node, and profit and loss with every cost counted.
- **Channels:** balance, fee, earnings and forwards for each channel. Click any
  node for its details. Suggestions for new peers, and channels worth closing:
  never a channel still opening or closing, or one inside its lease.
  Closing asks first; a force-close is its own step that says what it does.
- **Autopilot:** fees, rebalancing, new channels and selling, each with its own
  switch and a line on what it last did. A strategy (Max routing, Balanced,
  Max profit) sets them together; no preset ever touches Magma selling.
  *Pause all* stops everything at once, and every setting is under *Advanced*.
- **Market (Amboss Magma):** buy inbound liquidity, or sell your own.
  Selling is off by default, and Amboss decides which seller gets an order. A buyer pays
  with a hold invoice that settles only once the channel is confirmed. On
  Umbrel a 1 % service fee applies to completed sales; the app shows it before
  you sell.
- **Wallet:** Lightning and on-chain, to receive, send and pay invoices.
- **Analytics:** a routing report, what each channel earns, and how fee changes
  worked out.
- **LSP mode** (experimental, off by default): sell inbound channels straight to
  wallets that speak LSPS1, see [docs/LSP-MODE.md](docs/LSP-MODE.md).

## Privacy and safety

- On Umbrel the app has its own password, so no other app on your server can
  read your node or move your funds through it.
- With Umbrel's Tor proxy, every lookup the app makes goes through Tor.
  *Settings → Privacy* says where each one goes.
- Nothing runs on its own until you switch it on, and what you do by hand asks
  before it moves funds.

More in [SECURITY.md](SECURITY.md).

## Run with Docker

The app needs your LND's gRPC address, its TLS certificate and a read-only
macaroon. It only changes anything with `LM_ENABLE_WRITE=true` and a write
macaroon: the admin macaroon works, a least-privilege one is better
([SECURITY.md](SECURITY.md) bakes it).

| In `.env` | What |
| --- | --- |
| `LND_SOCKET` | LND's gRPC address, e.g. `umbrel.local:10009` |
| `LND_CERT` | `tls.cert`, base64 |
| `LND_MACAROON` | `readonly.macaroon`, base64 |
| `LND_WRITE_MACAROON` | write mode only (with `LM_ENABLE_WRITE=true`): the write macaroon, base64 |

On Umbrel these files are under `~/umbrel/app-data/lightning/data/lnd/`
(`base64 -w0 <file>`). To mount files instead, use `LND_CERT_PATH`,
`LND_MACAROON_PATH` and `LND_WRITE_MACAROON_PATH`.

Inside a container the app has to listen on `0.0.0.0`, so it needs a login: put
`LM_BIND=0.0.0.0` and `APP_PASSWORD` in `.env`, not on the command line, where
the password would end up in your shell history.

```bash
cp .env.example .env
docker build -t lightningmate .
# --stop-timeout 60: Docker kills a container 10 s after `docker stop` by default;
# the app takes up to 45 s to let work under way finish and save its state.
docker run -p 127.0.0.1:3001:3001 --env-file .env -v lightningmate-data:/data --stop-timeout 60 lightningmate
```

Then open http://127.0.0.1:3001.
The named volume `lightningmate-data` holds the app's state (settings, history,
order records, the Amboss key); keep it across updates.

Run without a login, the app listens on `127.0.0.1` only. It then serves only
requests for `localhost`, `127.0.0.1`, `::1` or the address it is bound to,
refuses any request a browser marks as coming from another site, and takes
every POST as JSON only. Don't open it to a network without a login.

## Development

```bash
npm install
npm run dev              # API on :3001, web app on :5173
npm run typecheck
npm run check:api-types  # the API's payload types, server and web
npm test                 # fake LND, no network
```

The server is Node and TypeScript (LND through the
[`lightning`](https://www.npmjs.com/package/lightning) library), the web app
React and Vite; in production one container serves both. The API's payload
types live in `server/src/apiTypes.ts`.

## Documentation

- [SECURITY.md](SECURITY.md): what leaves your node, sign-in, state on disk,
  the service fee, hardening.
- [docs/AUTOPILOT-STRATEGY.md](docs/AUTOPILOT-STRATEGY.md): how fees,
  rebalancing, channel opens, selling and the strategies work.
- [docs/LSP-MODE.md](docs/LSP-MODE.md): LSP mode.
- [docs/E2E-TESTING.md](docs/E2E-TESTING.md): end-to-end tests with real nodes.
- [docs/RELEASING.md](docs/RELEASING.md): releases, the image and both Umbrel
  stores ([packaging/umbrel/](packaging/umbrel/)).

## License

MIT
