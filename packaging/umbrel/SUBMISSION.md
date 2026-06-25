# Submitting Lightning Mate to the official Umbrel App Store

The official-store package is [`lightningmate/`](./lightningmate/): bare
`lightningmate` id, `gallery: []`, **no `icon` field** (Umbrel hosts the final
assets, provided in the PR). Docs: <https://github.com/getumbrel/umbrel-apps>.

## Prerequisites

1. **Source repo public.** `github.com/opensourceminers/lightningmate` must be
   public (the manifest `repo` points to it; the store requires open source —
   MIT LICENSE is in the repo root). The git history has been scrubbed of any
   runtime data (`.data/`), so it is safe to publish.
2. **GHCR image public** (already is) so Umbrel can pull
   `ghcr.io/opensourceminers/lightningmate` (multi-arch, digest-pinned).
3. **Screenshots** for the PR body — ready in `screenshots/` (branded 16:9 cards,
   un-branded in `screenshots/raw/`): Overview, Market, Wallet, Channels,
   Routing, Autopilot.
4. **Icon** — `opensourceminers-app-store/opensourceminers-lightningmate/icon.svg`
   (256×256 SVG, square / no rounded corners). This is what Umbrel asks for.

## Steps

1. Fork **getumbrel/umbrel-apps** and copy the `lightningmate/` folder to the
   repo root (folder name must equal the id).
2. `port` is **3742** — already verified unique (3001 clashed with Ride The
   Lightning). The container still listens on 3001 internally (app_proxy bridges).
3. **Test on umbrelOS** (Raspberry Pi, Umbrel Home, *or* a Linux VM) — the PR
   must confirm this. Verify: installs zero-config, dashboard / forwards / P&L
   load, sign-in with the per-app password works, and settings persist across a
   restart/update.
4. Open the PR with the template below. After opening, set `submission:` in
   `umbrel-app.yml` to the PR URL.

## PR body template

```
**Lightning Mate** v0.6.6 — profit-aware management & autopilot for an LND node.

- Source: https://github.com/opensourceminers/lightningmate (MIT)
- Image: ghcr.io/opensourceminers/lightningmate (multi-arch, digest-pinned)
- Dependencies: lightning (LND) — auto-discovered, zero-config
- Sign-in: the per-app password Umbrel generates (deterministicPassword), shown
  on first open; the API requires it so no other app on the server can use it
- Host access: none beyond the mounted LND data dir (read-only mount)
- Runs as uid 1000 (non-root); a one-shot init container fixes the data-dir owner
- Writes (fees / rebalance / channel open+close / Magma fulfilment / autopilot)
  use the auto-discovered admin macaroon, like RTL / Thunderhub / Lightning
  Terminal. The autopilot stays OFF until the user enables it and every
  fund-moving action is confirmed; a least-privilege baked macaroon is supported
  (see SECURITY.md)

What it does: channels with balance bars + roles, a Forwards routing report, a
Profit & Loss overview, a node health score, graph-based channel suggestions, a
Lightning + on-chain wallet, an Amboss Magma marketplace (buy & sell channel
liquidity), profit-aware rebalancing, and an autopilot that tunes fees / runs
profitable rebalances / opens channels / fulfils Magma sell orders on safe
defaults.

Tested on umbrelOS (<Pi / Umbrel Home / Linux VM>): installs zero-config against
LND, all tabs load, autopilot toggles, settings persist across update.

[screenshots attached]
```
