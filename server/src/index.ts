import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { loadConfig } from "./config.js";
import { getLnd, getWriteLnd } from "./lnd.js";
import { createApiRouter } from "./routes/api.js";
import { Autopilot } from "./services/autopilot.js";
import { RebalanceLog } from "./services/rebalanceLog.js";
import { SettingsStore } from "./services/settings.js";
import { OverridesStore } from "./services/overrides.js";
import { AmbossStore } from "./services/ambossStore.js";
import { BackupStore } from "./services/backup.js";
import { EarningsLog } from "./services/earningsLog.js";

// Never let a startup error vanish silently — print it so it's diagnosable.
process.on("uncaughtException", (err) => {
  console.error(`\n⚡ LightningMate crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`\n⚡ LightningMate unhandled rejection: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});

function main(): void {
  let config;
  let lnd;
  try {
    config = loadConfig();
    // Building the gRPC client validates the cert/macaroon format, so a
    // corrupted/line-wrapped base64 value surfaces here as a clear error.
    lnd = getLnd(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n⚡ LightningMate config error:\n  ${message}\n`);
    console.error("Standalone: check LND_SOCKET, LND_CERT and LND_MACAROON in your .env.");
    console.error("Tip: the cert/macaroon must each be a single unbroken base64 line.\n");
    process.exit(1);
  }

  const writeLnd = getWriteLnd(config);
  const rebalanceLog = new RebalanceLog(config.dataDir);
  const settings = new SettingsStore(config.dataDir);
  const overrides = new OverridesStore(config.dataDir);
  const ambossStore = new AmbossStore(config.dataDir);
  const backupStore = new BackupStore(config.dataDir);
  const earningsLog = new EarningsLog(config.dataDir);
  const autopilot = new Autopilot(config.dataDir, lnd, writeLnd, rebalanceLog, overrides, ambossStore, earningsLog);
  autopilot.start();

  const app = express();
  app.disable("x-powered-by");

  // Optional Host-header allowlist — defends against DNS-rebinding. Off unless
  // LM_ALLOWED_HOSTS is set, so it never breaks default access.
  if (config.allowedHosts.length > 0) {
    app.use((req, res, next) => {
      const host = (req.headers.host ?? "").split(":")[0].toLowerCase();
      if (!config.allowedHosts.includes(host)) {
        res.status(403).json({ error: "forbidden_host" });
        return;
      }
      next();
    });
  }

  // No CORS: the UI is served same-origin (Vite proxies /api in dev), so a
  // cross-origin site can neither read responses nor make preflighted JSON
  // POSTs — closing the cross-site / CSRF vector on the fund-moving API.
  app.use(express.json({ limit: "256kb" }));
  app.use(
    "/api",
    createApiRouter(lnd, writeLnd, config, autopilot, rebalanceLog, settings, overrides, ambossStore, backupStore, earningsLog),
  );

  // In production (Docker/Umbrel) we serve the built React app from the same
  // origin, so the whole tool is a single container behind Umbrel's app_proxy.
  if (config.webDir && existsSync(config.webDir)) {
    const webDir = config.webDir;
    app.use(express.static(webDir));
    // SPA fallback — anything not under /api returns index.html.
    app.get("*", (_req, res) => res.sendFile(join(webDir, "index.html")));
    console.log(`   Serving web UI from ${webDir}`);
  }

  app.listen(config.port, config.bindHost, () => {
    console.log(`⚡ LightningMate listening on ${config.bindHost}:${config.port}`);
    const mode = config.writeEnabled ? "read + write" : "read-only";
    console.log(`   LND socket: ${config.lnd.socket}  (${mode})`);
  });
}

main();
