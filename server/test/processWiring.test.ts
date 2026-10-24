/**
 * The real entry point applies the stored privacy settings at start-up
 * (review of P4). The API harness builds its own wiring, so a server
 * started without them passed every other test: building the LN+ store
 * without the switch made "LN+ lookups: off" do nothing. Since 0.8.5 every
 * lookup goes through Umbrel's Tor proxy — a route an older version stored
 * ("direct") counts for nothing, and leaves the file with the clearnet
 * address LSP mode no longer announces.
 *
 * Here src/index.ts runs as a child process on a data dir whose settings.json
 * is 0.8.4's — LN+ off, route "direct", a clearnet address — with Umbrel's
 * Tor proxy variables set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { join } from "node:path";
import { makeTempDir } from "./helpers/tmp.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });

test("after a restart the stored privacy settings are in force — LN+ lookups off — and with Umbrel's proxy every lookup goes through Tor, whatever route 0.8.4 stored", { timeout: 60_000 }, async (t) => {
  const dataDir = makeTempDir(t);
  const port = await freePort();
  writeFileSync(
    join(dataDir, "settings.json"),
    JSON.stringify({ fiatCurrency: "off", lnplusLookups: false, torRoute: "direct", lspModeEnabled: false, lspClearnetAddress: "node.example.com:9735" }),
  );
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      // A node that isn't there: the gRPC client connects lazily, so start-up
      // succeeds and nothing ever reaches a real LND.
      LND_SOCKET: "127.0.0.1:1",
      LND_CERT: Buffer.from("not-a-real-cert").toString("base64"),
      LND_MACAROON: "AgEDbG5kAg==",
      LM_ENABLE_WRITE: "false",
      LM_BIND: "127.0.0.1",
      APP_PASSWORD: "",
      PORT: String(port),
      DATA_DIR: dataDir,
      WEB_DIR: "",
      // Umbrel hands the app its Tor proxy (an address nothing listens on:
      // nothing may be sent anywhere).
      TOR_PROXY_IP: "127.0.0.1",
      TOR_PROXY_PORT: "9",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let output = "";
  child.stdout?.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (output += c.toString()));
  const deadline = Date.now() + 30_000;
  while (!output.includes("listening on")) {
    assert.ok(Date.now() < deadline, `server did not start:\n${output}`);
    assert.equal(child.exitCode, null, `server exited early:\n${output}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  const privacy = (await (await fetch(`http://127.0.0.1:${port}/api/privacy`)).json()) as {
    torProxy: string | null;
    lnplusLookups: boolean;
    destinations: { service: string; viaTor: boolean }[];
  };
  assert.equal(privacy.torProxy, "127.0.0.1:9", "the proxy from TOR_PROXY_IP / TOR_PROXY_PORT");
  assert.equal(privacy.lnplusLookups, false);
  assert.equal("torRoute" in privacy, false);
  // 0.8.4 applied the stored route here: "direct" sent nothing through Tor.
  assert.ok(privacy.destinations.length > 0 && privacy.destinations.every((d) => d.viaTor), JSON.stringify(privacy.destinations));
  // The old route and the clearnet address (read-only here: never announced)
  // have left the file; the operator's own settings stayed.
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")), { fiatCurrency: "off", lnplusLookups: false, lspModeEnabled: false });
  // Without the switch wired into the LN+ store, this asked LN+.
  const pool = await fetch(`http://127.0.0.1:${port}/api/lnplus/pool`);
  assert.equal(pool.status, 409);
  assert.equal(((await pool.json()) as { error: string }).error, "lnplus_off");

  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
});
