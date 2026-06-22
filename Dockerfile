# ── build stage: compile server (tsc) and web (vite) ──────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# Install all workspace deps using the lockfile for reproducible builds.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build

# ── runtime stage: production deps + built artifacts only ─────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    WEB_DIR=/app/web/dist

# Production dependencies only (drops tsx/typescript/vite). Hoisted to /app.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# Umbrel runs app containers as uid/gid 1000 (matches the node user).
USER node
EXPOSE 3001
CMD ["node", "server/dist/index.js"]
