/**
 * Wait until `cond` holds — polled on real timers (the work under test runs
 * meanwhile) — or fail after `ms`, naming what never happened.
 */
export async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
