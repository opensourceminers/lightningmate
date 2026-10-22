# The base image is pinned by digest: the tag alone moved under the same name
# from one release to the next (NODE_VERSION 22.23.1 in v0.7.0, 22.23.2 in
# v0.7.7), so the same tag could build a different image. Dependabot proposes
# newer digests (.github/dependabot.yml); the release checklist takes the
# latest before a tag (docs/RELEASING.md). Both stages use one reference, on
# the Node major CI tests (ci.yml's node-version): Dependabot proposes no other
# major, and a new one changes this file and CI together, in one pull request
# (server/test/releaseWorkflow.test.ts holds them together).

# ── build stage: compile server (tsc) and web (vite) ──────────────────────────
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build
WORKDIR /app

# Install all workspace deps using the lockfile for reproducible builds.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build

# ── runtime stage: production deps + built artifacts only ─────────────────────
FROM node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime
WORKDIR /app
# Stamped from the git tag by CI (see build-image.yml); surfaced at /health.
ARG APP_VERSION=dev
# The commit the image was built from (CI: github.sha) — in "Download
# diagnostics", so a report names the exact code it came from.
ARG APP_REVISION=
ENV NODE_ENV=production \
    PORT=3001 \
    WEB_DIR=/app/web/dist \
    DATA_DIR=/data \
    APP_VERSION=$APP_VERSION \
    APP_REVISION=$APP_REVISION

# The server's production dependencies only: the web is built into web/dist,
# so its packages (React, the QR code) and every build tool stay out of the
# image. Hoisted to /app.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev -w server && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# The app's state — settings, the order journal, the ledgers — lives in
# DATA_DIR=/data, owned by the user the app runs as. /app belongs to root and
# the app can't write there: without this the first store's mkdir of
# /app/.data failed (EACCES) and the server never started. Mount a volume there to keep the
# state (README: `-v lightningmate-data:/data`; a new named volume takes this
# ownership); Umbrel mounts the app's own data dir there.
RUN mkdir -p /data && chown node:node /data

# Umbrel runs app containers as uid/gid 1000 (matches the node user).
USER node
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
