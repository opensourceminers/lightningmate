# Releasing LightningMate

How a version goes from a commit on `master` to the two Umbrel stores. Every
release is cut by hand; nothing here runs on its own. The steps assume the
public repo `github.com/opensourceminers/lightningmate` and its image
`ghcr.io/opensourceminers/lightningmate`.

## What makes a release trustworthy

- **CI is green on the commit** (`.github/workflows/ci.yml`): install from the
  lockfile, `npm audit --omit=dev --audit-level=high` (a known high or critical
  vulnerability in a production dependency fails), type-check of server, web
  and tests, the API contract check (`npm run check:api-types`: every body a
  route builds is checked against the one set of payload types, the web
  type-checks against the same types, and every answer the web reads must be
  what its route sends), the test suites and the build.
- **Images are immutable.** The image workflow
  (`.github/workflows/build-image.yml`) refuses to publish a tag the registry
  already has, and a manual run can publish only test tags (`dev-…`), never a
  release tag. A release that turns out broken is fixed by the next version,
  never by moving or rebuilding its tag (v0.7.4 was once moved to another
  commit and rebuilt under the same name; that can't happen any more).
- **Every image says where it came from**: OCI labels on each architecture's
  image and annotations on the manifest list (source, commit, version), a
  provenance attestation (`mode=max`) and an SBOM, both pushed with the image.
  The commit is also stamped into the app (`APP_REVISION`, shown in "Download
  diagnostics") and the version (`APP_VERSION`, the footer, Settings and
  `/api/health`).
- **Pinned inputs**: the Dockerfile's base image by digest, every workflow
  action by commit. Dependabot (`.github/dependabot.yml`) proposes updates to
  npm packages, actions and the base image (within its Node major, the one CI
  tests) as pull requests that run CI.
- **Dependency overrides are justified**: `package.json` names the advisory
  behind each override (`comment:overrides`) and the condition for dropping it.

## Before the tag

1. **Master is green in CI**, and the commit to release is the one CI checked.
2. **Base image**: merge Dependabot's base-image bump if one is open — or take
   the current `node:22.x.y-alpine` digest by hand: the manifest list must
   carry `linux/amd64` and `linux/arm64` (Umbrel runs both). Both `FROM` lines
   use the same tag and digest. A routine bump stays on Node 22, the major CI
   tests (`node-version: 22` in `ci.yml`); Dependabot is set not to propose
   another major. A new Node major is not a release step but a change of its
   own: the Dockerfile's `FROM` lines and CI's `node-version` move together,
   in one pull request whose CI then runs on that major (a test refuses an
   image and a CI on different majors).
3. **Dependencies**: open Dependabot pull requests merged or consciously left;
   `npm audit` clean for production dependencies (CI checks it).
4. **Manual end-to-end tests** for what the release changes on money paths —
   Magma selling, LSP mode — following [E2E-TESTING.md](E2E-TESTING.md), on a
   real node, with the results noted in the release notes.
5. **Release notes** for the store manifests (`umbrel-app.yml`
   `releaseNotes`). `packaging/umbrel/lightningmate/umbrel-app.yml` holds a
   draft for the first release after the 2026-10 review fixes: check each line
   against the release's code and the end-to-end results, and finish it. Say
   only what the code does: Amboss decides which seller a buyer is matched
   with (seller score × listed depth); the app makes the sell path correct and
   reliable — it does not make a node sell (D11, D19: never claim that price
   or size raises the seller score or wins orders). The 0.7.7 notes the stores
   still show claim size decides whether a buyer can be matched: never copy
   them out again (a docs test refuses them in this repo).

## Cutting the release

1. Tag the commit and push the tag (semantic version, `v` prefix). The tag is
   the version: the image stamps it as `APP_VERSION` (the `version` fields of
   the package.json files are not the app's version and stay as they are):

   ```bash
   git tag -a v0.8.0 -m "LightningMate 0.8.0"
   git push origin v0.8.0
   ```

2. The image workflow runs:
   - **guard** — refuses a tag that exists already, or that isn't a
     semantic version with the `v` prefix (`v0.8.0`, `v0.8.0-rc.1`); when
     the registry can't be asked, nothing is published;
   - **build** — amd64 and arm64 on native runners (never QEMU: `npm ci` under
     qemu-user dies with "Illegal instruction"), each pushed by digest with
     its labels, provenance and SBOM;
   - **merge** — one manifest list, tagged once, with the annotations —
     after asking the registry once more: only its "not found" lets the tag
     be written;
   - its summary prints the pin: `ghcr.io/opensourceminers/lightningmate:v0.8.0@sha256:…`.

3. **Check the image** before it goes to a store:

   ```bash
   IMG=ghcr.io/opensourceminers/lightningmate:v0.8.0
   docker buildx imagetools inspect "$IMG"                                    # linux/amd64 + linux/arm64, each with its attestation
   docker buildx imagetools inspect "$IMG" --format '{{json .Provenance}}' | head -c 2000   # the build's provenance: repository and commit
   docker buildx imagetools inspect "$IMG" --format '{{json .SBOM}}' | head -c 500          # the packages in the image
   docker buildx imagetools inspect "$IMG" --raw | grep -o '"org.opencontainers.image.revision":"[0-9a-f]*"'   # = the tag's commit
   ```

   Pull it on a test install (`docker run` per README, or a test Umbrel) and
   open the app: the footer shows the version, "Download diagnostics" the
   commit. Change a setting, remove the container and start the image again
   with the same `-v lightningmate-data:/data`: the setting is still there
   (the app's state lives on the volume, not in the container).

A manual run of the workflow (`workflow_dispatch`) publishes a test image
under `dev-<commit>` (or a `dev-…` name you give) — for trying an image on a
device before tagging. It can't publish or overwrite a release tag.

## The community store (opensourceminers app store)

Repo `github.com/opensourceminers/umbrel-app-store`, folder
`opensourceminers-lightningmate/`. Its `docker-compose.yml` and
`umbrel-app.yml` follow `packaging/umbrel/lightningmate/` in this repo (the
app id there is `opensourceminers-lightningmate`, so `APP_HOST` is
`opensourceminers-lightningmate_web_1`; its manifest also declares the
home-screen widget, which the official one doesn't).

1. `docker-compose.yml` — set `image:` to the pin from the workflow summary
   (`…:v0.8.0@sha256:…`, tag AND digest).
2. **At the next release (the first after the 2026-10 review fixes) add the Tor
   proxy lines** to the `web` service's `environment:` — they are in this
   repo's packaging compose, not yet in the store's:

   ```yaml
   TOR_PROXY_IP: "$TOR_PROXY_IP"
   TOR_PROXY_PORT: "$TOR_PROXY_PORT"
   ```

   Without them LightningMate has no Tor proxy on Umbrel: LN+ reputations
   (this node's key included), the BTC price and Amboss's public market data
   go out directly from the home connection, and Settings → Privacy says so.
3. Keep `LM_SELL_FEE_BPS: "100"` and `LM_SELL_FEE_ADDRESS` (the disclosed 1 %
   service fee on completed sales). Optional: `LM_SELL_FEE_PUBKEY` — the fee
   server's node id; with it, fee invoices to any other node are refused (D13).
4. `umbrel-app.yml` — `version` and `releaseNotes` (see "Before the tag").
5. Commit and push the store repo; on a test Umbrel, update the app from the
   community store and check it starts, signs in with the per-app password
   and keeps its settings (`/data` survives the update).

## The official Umbrel store (getumbrel/umbrel-apps)

A pull request to `getumbrel/umbrel-apps`, folder `lightningmate/` (app id
`lightningmate`, `APP_HOST: lightningmate_web_1`). Make the same edits as for
the community store — image pin, the Tor proxy lines, `version`,
`releaseNotes` — copying from `packaging/umbrel/lightningmate/` here, and follow
[packaging/umbrel/SUBMISSION.md](../packaging/umbrel/SUBMISSION.md) for the PR
itself (test on umbrelOS, the PR template). Umbrel reviews and merges it; the
official store updates only then.

**At the next official update, set `category: bitcoin`** (this repo's manifest
has it already; the official store still lists `finance`) and say why in the
PR body: Lightning Mate manages a Lightning node — its channels, routing fees,
liquidity and on-chain funds — like Lightning Node, Ride The Lightning, Core
Lightning and Lightning Terminal, which the store lists under `bitcoin`; the
community store lists it there too. (The owner's decision of 2026-10-21.)

## After publishing

- Update `packaging/umbrel/lightningmate/` in this repo to what was published
  (image pin, `version`, `releaseNotes`, `category`), so it starts the next
  release from what the stores have.
- Never move or delete a release tag, and never re-run a release with the same
  tag: the guard refuses it, and an image already pulled by a store must stay
  what it was.
