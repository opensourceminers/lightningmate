# Security

LightningMate manages a Lightning node and can move funds. This documents its
security posture and how to harden it. Found an issue? Email
security@opensourceminers.de (please don't open a public issue first).

## Posture

- **Read-only by default.** Writes (fee changes, rebalancing, opening/closing
  channels, autopilot) are off unless you opt in with `LM_ENABLE_WRITE=true` and
  a write-capable macaroon.
- **Minimal outbound traffic.** Beyond LND, outbound calls happen only for
  features you use: the optional fiat price lookup (mempool.space) when a
  currency is set; the Amboss Magma marketplace (api.amboss.space /
  magma.amboss.tech) when you add an Amboss API key; and — on the community
  build — resolving the service-fee Lightning Address (LNURL) when a Magma sale
  completes. Nothing else leaves your node.
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
- **Standalone/dev:** with no `APP_PASSWORD` set it binds **`127.0.0.1`** and
  runs without a login, so the API is reachable only from the same machine.
  Don't expose it to a LAN/WAN without an authenticating reverse proxy.
- **No CORS** is sent, so a malicious web page can't read responses or make
  cross-site JSON requests to the API.
- `LM_ALLOWED_HOSTS` (comma-separated) optionally pins accepted `Host` headers
  to defend against DNS rebinding.
- All state-changing endpoints validate inputs (pubkey/txid/channel-id formats,
  sat/ppm bounds) and are globally rate-limited.

## Least-privilege write macaroon (recommended)

By default, write mode auto-discovers the **admin** macaroon — convenient, but
it grants full node authority. For a smaller blast radius, bake a macaroon with
only the permissions LightningMate needs and point `LND_WRITE_MACAROON_PATH` at
it:

```bash
# in the Umbrel lightning app (or via lncli)
lncli bakemacaroon \
  info:read offchain:read onchain:read \
  offchain:write onchain:write peers:write invoices:write \
  --save_to lightningmate.macaroon
```

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
