import type { Server } from "node:http";
import { loadConfig } from "./config.js";
import { getLnd, getWriteLnd } from "./lnd.js";
import { createApiRouter } from "./routes/api.js";
import { createHttpApp } from "./app.js";
import { assertSafeExposure } from "./exposure.js";
import { RequestGate, SHUTDOWN_GRACE_MS, SHUTDOWN_WAIT_MS, appShutdownSteps, createShutdown } from "./shutdown.js";
import { authRequired } from "./services/auth.js";
import { LnPlusStore } from "./services/lnplusStore.js";
import { setOutboundRouting } from "./services/http.js";
import { Autopilot } from "./services/autopilot.js";
import { CapitalLedger } from "./services/capital.js";
import { RebalanceLog } from "./services/rebalanceLog.js";
import { SettingsStore } from "./services/settings.js";
import { OverridesStore } from "./services/overrides.js";
import { AmbossStore } from "./services/ambossStore.js";
import { BackupStore } from "./services/backup.js";
import { EarningsLog } from "./services/earningsLog.js";
import { Lsps1Service } from "./services/lsps1.js";
import { ServiceFeeLedger, lndFeeLightning } from "./services/serviceFee.js";
import {
  flushHtlcTelemetry,
  initHtlcTelemetry,
  startHtlcTelemetry,
  stopHtlcTelemetry,
} from "./services/htlcTelemetry.js";

// Never let a startup error vanish silently — print it so it's diagnosable.
process.on("uncaughtException", (err) => {
  console.error(`\n⚡ LightningMate crashed: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(`\n⚡ LightningMate unhandled rejection: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Idle keep-alive sockets would otherwise hold close() open.
    server.closeIdleConnections?.();
  });
}

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
  // Fail closed: never serve the (fund-moving) API beyond loopback without a
  // login. Checked before anything starts.
  try {
    assertSafeExposure(config.bindHost, authRequired());
  } catch (err) {
    console.error(`\n⚡ LightningMate refused to start:\n  ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const writeLnd = getWriteLnd(config);
  const rebalanceLog = new RebalanceLog(config.dataDir);
  const settings = new SettingsStore(config.dataDir);
  const overrides = new OverridesStore(config.dataDir);
  const ambossStore = new AmbossStore(config.dataDir);
  const backupStore = new BackupStore(config.dataDir);
  // LN+ node reputation cache (public API, no key). Used to re-rank peer
  // suggestions with a social trust signal the network graph cannot provide.
  // The operator can switch LN+ lookups off (Settings → Privacy).
  const lnplusStore = new LnPlusStore(config.dataDir, () => settings.get().lnplusLookups);
  // Third-party lookups through Umbrel's Tor proxy when the app has one
  // (TOR_PROXY_IP / TOR_PROXY_PORT), as the operator's setting says.
  setOutboundRouting({ route: settings.get().torRoute });
  const earningsLog = new EarningsLog(config.dataDir);
  // The disclosed service fee on completed sales is paid from this persistent
  // ledger in the background — never inline in an accept/open/settle path.
  const serviceFees = new ServiceFeeLedger(config.dataDir, writeLnd ? lndFeeLightning(writeLnd) : null);
  // One on-chain budget for every demand on the wallet: Magma sales, LSPS1
  // sales, routing opens. One mutex, one set of (persisted) reservations.
  const capital = new CapitalLedger();
  const autopilot = new Autopilot(
    config.dataDir,
    lnd,
    writeLnd,
    rebalanceLog,
    overrides,
    ambossStore,
    earningsLog,
    serviceFees,
    lnplusStore,
    capital,
  );
  const lsps1 = new Lsps1Service(
    config.dataDir,
    lnd,
    writeLnd,
    settings,
    () => autopilot.sellCaps(),
    () => autopilot.magmaOverrides(),
    () => ambossStore.getKey(),
    earningsLog,
    serviceFees,
    (orderId, sizeSats, transactionId) => autopilot.recordExternalSell(orderId, sizeSats, transactionId),
    capital,
  );
  autopilot.start();
  lsps1.start();
  serviceFees.start();
  // Failed-HTLC telemetry (read-only): unserved-demand history accrues from
  // day one, independent of any autopilot toggle.
  initHtlcTelemetry(config.dataDir);
  startHtlcTelemetry(lnd);

  // Closed by the first shutdown step: from then on new state-changing API
  // requests get 503, and the shutdown waits for the ones already running.
  const requestGate = new RequestGate();
  const app = createHttpApp({
    requestGate,
    apiRouter: createApiRouter(
      lnd,
      writeLnd,
      config,
      autopilot,
      rebalanceLog,
      settings,
      overrides,
      ambossStore,
      backupStore,
      earningsLog,
      lsps1,
      lnplusStore,
      serviceFees,
    ),
    allowedHosts: config.allowedHosts,
    authRequired: authRequired(),
    webDir: config.webDir,
  });

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`⚡ LightningMate listening on ${config.bindHost}:${config.port}`);
    const mode = config.writeEnabled ? "read + write" : "read-only";
    console.log(`   LND socket: ${config.lnd.socket}  (${mode})`);
  });

  // Stop starting new work → let started work reach a recorded state → flush
  // → stop serving → exit 0 (see appShutdownSteps). The wait leaves time for
  // the flush, and the flush runs even if the wait used everything up. The
  // wait outlasts any single Amboss call (shutdown.ts checks the deadlines).
  const waitBudgetMs = SHUTDOWN_WAIT_MS;
  const shutdown = createShutdown({
    graceMs: SHUTDOWN_GRACE_MS,
    exit: (code) => process.exit(code),
    steps: appShutdownSteps(
      {
        requests: requestGate,
        autopilot,
        lsps1,
        serviceFees,
        telemetry: { stop: stopHtlcTelemetry, flush: flushHtlcTelemetry },
        closeServer: () => closeServer(server),
      },
      waitBudgetMs,
    ),
  });
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main();
