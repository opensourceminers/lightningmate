import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Minimal slice of node:test's TestContext we need (keeps helpers usable from
 *  both `test()` callbacks and suites). */
export interface AfterHook {
  after(fn: () => void | Promise<void>): void;
}

/**
 * A fresh, empty data dir under the OS temp dir, removed after the test.
 * Every store in the app takes a data dir, so this is how a test gets an
 * isolated "disk" — never point a test at the repo's own `.data/`.
 */
export function makeTempDir(t: AfterHook, prefix = "lm-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    // maxRetries: Windows can briefly hold a handle on a just-renamed file.
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return dir;
}
