/**
 * The real entry point, as a child process: SIGTERM must lead to a clean,
 * logged shutdown and exit code 0 — not the default "killed by signal" (or, as
 * PID 1 in the container, being ignored until docker SIGKILLs it).
 *
 * On Linux/macOS (CI) a real SIGTERM is sent. Windows can't deliver a signal to
 * another process's handlers (it terminates the target), so there the signal
 * event is raised through an IPC bridge — same handler, same shutdown path.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "./helpers/tmp.js";

const viaIpc = process.platform === "win32";

test("SIGTERM stops the server cleanly with exit code 0", { timeout: 60_000 }, async (t) => {
  const dataDir = makeTempDir(t);
  const bridge = viaIpc ? ["--import", "./test/helpers/signalBridge.mjs"] : [];
  const child = spawn(process.execPath, ["--import", "tsx", ...bridge, "src/index.ts"], {
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
      PORT: "0",
      DATA_DIR: dataDir,
      WEB_DIR: "",
    },
    stdio: viaIpc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
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

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  if (viaIpc) child.send("SIGTERM");
  else child.kill("SIGTERM");
  const { code, signal } = await exited;
  assert.equal(signal, null, `killed by ${signal} instead of shutting down:\n${output}`);
  assert.equal(code, 0, output);
  assert.match(output, /\[shutdown\] SIGTERM received/);
  assert.match(output, /\[shutdown\] done/);
  assert.ok(existsSync(join(dataDir, "autopilot.json")), "state was written");
});
