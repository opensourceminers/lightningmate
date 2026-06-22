import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "cors";
import express from "express";
import { loadConfig } from "./config.js";
import { getLnd, getWriteLnd } from "./lnd.js";
import { createApiRouter } from "./routes/api.js";
import { Autopilot } from "./services/autopilot.js";

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
  const autopilot = new Autopilot(config.dataDir, lnd, writeLnd);
  autopilot.start();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", createApiRouter(lnd, writeLnd, config, autopilot));

  // In production (Docker/Umbrel) we serve the built React app from the same
  // origin, so the whole tool is a single container behind Umbrel's app_proxy.
  if (config.webDir && existsSync(config.webDir)) {
    const webDir = config.webDir;
    app.use(express.static(webDir));
    // SPA fallback — anything not under /api returns index.html.
    app.get("*", (_req, res) => res.sendFile(join(webDir, "index.html")));
    console.log(`   Serving web UI from ${webDir}`);
  }

  app.listen(config.port, () => {
    console.log(`⚡ LightningMate listening on http://localhost:${config.port}`);
    const mode = config.writeEnabled ? "read + write" : "read-only";
    console.log(`   LND socket: ${config.lnd.socket}  (${mode})`);
  });
}

main();
