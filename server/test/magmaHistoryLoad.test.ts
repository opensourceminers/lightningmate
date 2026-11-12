// The Magma order history as it is read from disk at startup (review of P2,
// H3 and n4). A file of its own: the history is read once per process
// (initMagmaHistory), and node's test runner gives each file its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonStore } from "../src/store.js";
import { clearingFor, initMagmaHistory, marketActivity } from "../src/services/magmaHistory.js";
import { makeTempDir } from "./helpers/tmp.js";

const DAY = 86_400_000;

test("a history stored before only sales were kept loses its rows that are not sales when it is read — and a sale's status in another case, or none, is still a sale", (t) => {
  const dir = makeTempDir(t);
  const row = (daysAgo: number, status: string, apr: number) => ({ at: Date.now() - daysAgo * DAY, sizeSat: 1_000_000, blocks: 4320, apr, leasePpm: Math.round((apr * 4320 * 1_000_000) / 52_560), status });
  new JsonStore(dir, "magma-history.json").write({
    fetchedAt: Date.now(),
    from: "disk",
    orders: [
      ...Array.from({ length: 12 }, (_, i) => row(i + 1, ["FINISHED", "finished", "Active", ""][i % 4]!, 0.05)),
      ...Array.from({ length: 6 }, (_, i) => row(i + 1, ["SELLER_REJECTED", "CANCELLED", "EXPIRED"][i % 3]!, 0.6)),
    ],
  });
  initMagmaHistory(dir);
  assert.equal(marketActivity(90)?.orders, 12, "the 12 sold leases, none of the 6 orders nobody paid for");
  const c = clearingFor({ minSizeSat: 250_000, maxSizeSat: 2_000_000, blocks: 4320 });
  assert.equal(c?.count, 12);
  assert.equal(c?.p75Ppm, 4110, "no price nobody paid");
});
