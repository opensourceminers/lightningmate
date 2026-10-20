import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "../../src/config.js";
import { createHttpApp } from "../../src/app.js";
import { createApiRouter } from "../../src/routes/api.js";
import { RequestGate } from "../../src/shutdown.js";
import { authRequired } from "../../src/services/auth.js";
import { Autopilot } from "../../src/services/autopilot.js";
import { RebalanceLog } from "../../src/services/rebalanceLog.js";
import { SettingsStore } from "../../src/services/settings.js";
import { OverridesStore } from "../../src/services/overrides.js";
import { AmbossStore } from "../../src/services/ambossStore.js";
import { BackupStore } from "../../src/services/backup.js";
import { EarningsLog } from "../../src/services/earningsLog.js";
import { LnPlusStore } from "../../src/services/lnplusStore.js";
import { Lsps1Service } from "../../src/services/lsps1.js";
import { ServiceFeeLedger, lndFeeLightning } from "../../src/services/serviceFee.js";
import { FakeLnd } from "./fakeLnd.js";
import { makeTempDir, type AfterHook } from "./tmp.js";

/**
 * The whole API — every store, the autopilot, LSPS1, the service-fee ledger and
 * the real router + HTTP app — on a fake LND, served on 127.0.0.1:<random>.
 * Nothing is started (no schedulers): tests drive what they need.
 *
 *   const api = await startApi(t, { node: new FakeLnd({ chainBalance: 5e6 }) });
 *   const res = await api.request("POST", "/autopilot", { intervalMinutes: 40000 });
 *   assert.equal(res.status, 400);
 *
 * `request(..., { from: "127.0.0.2" })` sends from another loopback address,
 * i.e. looks like a different client (another container) to the server.
 * `from: "::1"` does the same over IPv6 loopback, through a second listener
 * on [::1] that serves the same app — for macOS, which has no 127.0.0.2.
 * Outbound HTTP (Amboss, LNURL, …) is NOT mocked here — install the fetch mock
 * in the test when a route needs it.
 */
export interface ApiHarness {
  dir: string;
  node: FakeLnd;
  autopilot: Autopilot;
  lsps1: Lsps1Service;
  serviceFees: ServiceFeeLedger;
  earnings: EarningsLog;
  amboss: AmbossStore;
  backup: BackupStore;
  overrides: OverridesStore;
  settings: SettingsStore;
  /** The shutdown gate for state-changing requests: close() = SIGTERM arrived. */
  requestGate: RequestGate;
  baseUrl: string;
  request(
    method: string,
    path: string,
    body?: unknown,
    opts?: { token?: string; from?: string; host?: string },
  ): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }>;
}

export async function startApi(
  t: AfterHook,
  opts: { node?: FakeLnd; readOnly?: boolean; dir?: string; payTimeoutMs?: number } = {},
): Promise<ApiHarness> {
  const dir = opts.dir ?? makeTempDir(t);
  const node = opts.node ?? new FakeLnd();
  const writeLnd = opts.readOnly ? undefined : node.lnd;
  const rebalanceLog = new RebalanceLog(dir);
  const settings = new SettingsStore(dir);
  const overrides = new OverridesStore(dir);
  const amboss = new AmbossStore(dir);
  const backup = new BackupStore(dir);
  const lnplus = new LnPlusStore(dir);
  const earnings = new EarningsLog(dir);
  const serviceFees = new ServiceFeeLedger(dir, writeLnd ? lndFeeLightning(writeLnd) : null, {
    payTimeoutMs: opts.payTimeoutMs ?? 200,
  });
  const autopilot = new Autopilot(dir, node.lnd, writeLnd, rebalanceLog, overrides, amboss, earnings, serviceFees, lnplus);
  const lsps1 = new Lsps1Service(
    dir,
    node.lnd,
    writeLnd,
    settings,
    () => autopilot.sellCaps(),
    () => autopilot.magmaOverrides(),
    () => amboss.getKey(),
    earnings,
    serviceFees,
  );
  const config: Config = {
    port: 0,
    bindHost: "127.0.0.1",
    allowedHosts: [],
    flowWindowDays: 30,
    webDir: undefined,
    dataDir: dir,
    writeEnabled: !opts.readOnly,
    lnd: { socket: "fake:10009", cert: "", macaroon: "" },
  };
  const requestGate = new RequestGate();
  const app = createHttpApp({
    requestGate,
    apiRouter: createApiRouter(
      node.lnd,
      writeLnd,
      config,
      autopilot,
      rebalanceLog,
      settings,
      overrides,
      amboss,
      backup,
      earnings,
      lsps1,
      lnplus,
      serviceFees,
    ),
    allowedHosts: [],
    authRequired: authRequired(),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const servers: http.Server[] = [server];
  t.after(async () => {
    autopilot.shutdown();
    lsps1.stop();
    serviceFees.stop();
    for (const s of servers) s.closeAllConnections?.();
    await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  // The same app on [::1] — loopback only — opened on first use by a request
  // `from` an IPv6 address.
  let v6Port: Promise<number> | undefined;
  const openV6 = () =>
    (v6Port ??= new Promise<number>((resolve, reject) => {
      const v6 = http.createServer(app);
      v6.once("error", reject);
      v6.listen(0, "::1", () => {
        servers.push(v6);
        resolve((v6.address() as AddressInfo).port);
      });
    }));

  const request: ApiHarness["request"] = async (method, path, body, ropts = {}) => {
    const target = ropts.from?.includes(":")
      ? { host: "::1", port: await openV6() }
      : { host: "127.0.0.1", port, localAddress: ropts.from };
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          ...target,
          method,
          path: `/api${path}`,
          headers: {
            Host: ropts.host ?? `localhost:${port}`,
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
            ...(ropts.token ? { Authorization: `Bearer ${ropts.token}` } : {}),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              // non-JSON body (e.g. the binary channel.backup)
            }
            resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  return {
    dir,
    node,
    autopilot,
    lsps1,
    serviceFees,
    earnings,
    amboss,
    backup,
    overrides,
    settings,
    requestGate,
    baseUrl: `http://127.0.0.1:${port}/api`,
    request,
  };
}
