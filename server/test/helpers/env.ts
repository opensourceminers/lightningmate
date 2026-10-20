import type { AfterHook } from "./tmp.js";

/**
 * Set environment variables for one test and restore them afterwards.
 * `undefined` deletes a variable. (Each test FILE runs in its own process, so
 * this only has to keep tests within a file from leaking into each other.)
 */
export function withEnv(t: AfterHook, vars: Record<string, string | undefined>): void {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}
