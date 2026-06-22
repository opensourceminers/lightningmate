# Submitting Lightning Mate to the official Umbrel App Store

The official-store package lives in [`lightningmate/`](./lightningmate/) (bare
`lightningmate` id, `gallery: []`, no icon — Umbrel hosts the final assets).

## Prerequisites (you must do these)

1. **Make the source repo public.** `github.com/opensourceminers/lightningmate`
   must be public — the manifest `repo` points to it and the store requires open
   source (MIT LICENSE is in the repo root).
2. **Make the GHCR image public** (already done for v0.5.x) so Umbrel can pull
   `ghcr.io/opensourceminers/lightningmate`.
3. **Capture screenshots** of the running app for the PR body (not committed).
   Suggested: 4–5 shots, **~1440×900 px** (PNG), e.g.
   - the home view (node header + Health + P&L)
   - the Forwards report (with the daily chart)
   - the Autopilot tab (the three sliders)
   - Channel suggestions (with scores)
   - the Channels tab (balance bars + override)
4. **Provide the icon** to the Umbrel team if asked: `icon.svg` (256×256, no
   rounded corners) is in the community-store folder
   `opensourceminers-app-store/opensourceminers-lightningmate/icon.svg`.

## Steps

1. Fork **getumbrel/umbrel-apps** and copy this `lightningmate/` folder to the
   repo root (folder name must equal the id).
2. Confirm the `port` (3001) is unique across the store — the linter will flag a
   clash; bump if needed.
3. Lint + test (in the fork):
   ```
   npm run lint:apps -- lightningmate --check-images
   git diff --check
   ```
   Then install/restart-test via the repo's `umbrel-test-app` flow.
4. Open the PR. Fill `submission:` in `umbrel-app.yml` with the PR URL.

## PR body template

```
**Lightning Mate** v0.5.1 — profit-aware management & autopilot for an LND node.

- Upstream / source: https://github.com/opensourceminers/lightningmate (MIT)
- Image: ghcr.io/opensourceminers/lightningmate (multi-arch, digest-pinned)
- Dependencies: lightning (LND)
- Default credentials: none (UI behind app_proxy auth)
- Permissions / host access: none beyond the mounted LND data dir (read-only)
- Writes (fee/rebalance/open, autopilot) are OFF by default; opt-in via
  LM_ENABLE_WRITE + a write macaroon (least-privilege recommended, see SECURITY.md)

Testing: installed on umbrelOS, verified dashboard/forwards/P&L/suggestions
load zero-config against LND, autopilot toggles, restart persists data.

[screenshots attached]
```
