# ⚡ LightningMate

Self-hosted management dashboard for a Bitcoin Lightning node running on Umbrel
(LND). Built to replace manual fee tweaking with proper visibility and — later —
automated fee & liquidity management.

## Status

**v1 — read-only dashboard.** Connects to LND via gRPC using a **read-only
macaroon**, so it can observe everything but change nothing. Shows node status,
balances, channels (with local/remote balance bars), and forwarding flows.

Planned next: fee automation (rule/flow-based), rebalancing engine
(circular + PeerSwap/Loop), alerts.

## Architecture

```
LightningMate/
├── server/   Node + TypeScript backend (LND gRPC, REST API)
└── web/      React + Vite dashboard
```

The backend talks to LND with the [`lightning`](https://www.npmjs.com/package/lightning)
(ln-service) library. It exposes a small REST API that the React frontend renders.

## Connecting to your Umbrel LND

LightningMate needs three things from your node:

| Value          | Where it lives on Umbrel                                                        |
| -------------- | ------------------------------------------------------------------------------ |
| `LND_SOCKET`   | host:port of LND gRPC, e.g. `umbrel.local:10009` or the container host `lnd:10009` |
| `LND_CERT`     | base64 of `tls.cert`                                                            |
| `LND_MACAROON` | base64 of **`readonly.macaroon`** (NOT admin — v1 only reads)                   |

On Umbrel the LND data dir is typically:
`~/umbrel/app-data/lightning/data/lnd/`

Grab the read-only macaroon + cert as base64 (run on the Umbrel host):

```bash
# tls cert
base64 -w0 ~/umbrel/app-data/lightning/data/lnd/tls.cert

# read-only macaroon
base64 -w0 ~/umbrel/app-data/lightning/data/lnd/data/chain/bitcoin/mainnet/readonly.macaroon
```

Then copy `.env.example` → `.env` and paste the values.

> If you'd rather mount files than paste base64, set `LND_CERT_PATH` and
> `LND_MACAROON_PATH` instead.

## Development

```bash
npm install            # installs both server and web workspaces
npm run dev            # runs backend (:3001) and frontend (:5173) together
```

Open http://localhost:5173.

## Production (single container)

In production the backend serves the built React app itself, so the whole tool
is one container on one port:

```bash
docker build -t lightningmate .
docker run -p 3001:3001 --env-file .env lightningmate   # standalone
```

## Umbrel App Store

LightningMate is built to be listed in the official Umbrel App Store. Packaging
lives in [`packaging/umbrel/lightningmate/`](packaging/umbrel/lightningmate/):

- It declares `dependencies: [lightning]`, so on Umbrel it **auto-discovers**
  LND — no manual macaroon/cert pasting. The compose file mounts LND's data dir
  read-only (`/lnd`) and passes `LND_SOCKET` from the lightning app's exports;
  [`server/src/config.ts`](server/src/config.ts) reads the read-only macaroon
  from there automatically.
- Umbrel's `app_proxy` provides authentication — LightningMate ships no login.

Path to listing:

1. **Build a multi-arch image** (Raspberry Pi needs arm64) and push it:
   ```bash
   docker buildx build --platform linux/amd64,linux/arm64 \
     -t <DOCKERHUB>/lightningmate:0.1.0 --push .
   ```
2. Paste the resulting `@sha256:` digest into the packaging `docker-compose.yml`
   (Umbrel requires images pinned by digest).
3. **Test in a community app store** first: put the `lightningmate/` folder in a
   fork of `getumbrel/umbrel-community-app-store`, add that store's URL in
   umbrelOS, and install. Dogfood there before the official submission.
4. **Submit**: open a PR adding `lightningmate/` to
   [`getumbrel/umbrel-apps`](https://github.com/getumbrel/umbrel-apps). Apps must
   be open source, self-contained (no external tracking), and resource-conscious.

## License

MIT
