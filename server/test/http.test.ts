import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { HTTP_TIMEOUTS, HttpTimeoutError, httpRequest } from "../src/services/http.js";
import { getOffers } from "../src/services/amboss.js";
import { updateOffer } from "../src/services/magmaApi.js";
import { getPoolNodes } from "../src/services/lnplus.js";
import { getBtcPrice } from "../src/services/price.js";
import { hang, installFetchMock, stalledBody } from "./helpers/fetchMock.js";
import { AMBOSS_API, MAGMA_API } from "./helpers/amboss.js";

/** A local server whose handler decides how (badly) to answer. */
async function localServer(
  t: { after(fn: () => void | Promise<void>): void },
  handler: http.RequestListener,
): Promise<string> {
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer(handler);
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  t.after(
    () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

/** Temporarily shrink one deadline. */
function shrink(t: { after(fn: () => void): void }, key: keyof typeof HTTP_TIMEOUTS, ms: number): void {
  const saved = HTTP_TIMEOUTS[key];
  HTTP_TIMEOUTS[key] = ms;
  t.after(() => {
    HTTP_TIMEOUTS[key] = saved;
  });
}

const elapsed = async (p: Promise<unknown>): Promise<{ ms: number; err: unknown }> => {
  const start = Date.now();
  try {
    await p;
    return { ms: Date.now() - start, err: undefined };
  } catch (err) {
    return { ms: Date.now() - start, err };
  }
};

test("a server that never answers times out", async (t) => {
  const url = await localServer(t, () => {
    /* never respond */
  });
  const { ms, err } = await elapsed(httpRequest(url, {}, 200));
  assert.ok(err instanceof HttpTimeoutError, String(err));
  assert.ok(ms < 3_000, `took ${ms} ms`);
});

test("a body that stalls after the headers times out too", async (t) => {
  const url = await localServer(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"partial": '); // …and never finishes
  });
  const res = await httpRequest(url, {}, 300);
  assert.equal(res.status, 200);
  const { ms, err } = await elapsed(res.json());
  assert.ok(err instanceof HttpTimeoutError, String(err));
  assert.ok(ms < 3_000, `took ${ms} ms`);
});

test("Amboss calls carry a deadline (they used to wait up to 10 minutes)", async (t) => {
  shrink(t, "ambossQueryMs", 100);
  const mock = installFetchMock(t);
  mock.onGraphql(AMBOSS_API, "getOffers", (_vars, req) => hang(req));
  const { ms, err } = await elapsed(getOffers());
  assert.match(String(err), /Amboss request to api\.amboss\.space timed out/);
  assert.ok(ms < 3_000, `took ${ms} ms`);
});

test("Amboss mutations get their own, longer deadline", async (t) => {
  shrink(t, "ambossQueryMs", 50);
  shrink(t, "ambossMutationMs", 2_000);
  const mock = installFetchMock(t);
  mock.onGraphql(MAGMA_API, "UpdateOffer", async () => {
    await new Promise((r) => setTimeout(r, 200)); // slower than a read may take
    return { data: { market: { offer: { update: { success: true } } } } };
  });
  const offer = { totalSizeSats: 2e6, minSizeSats: 1e6, maxSizeSats: 2e6, feeRatePpm: 500, baseFeeSats: 1, minBlockLength: 4320 };
  assert.equal(await updateOffer("key", "offer-1", offer), true);
});

test("LN+ and the price lookup carry deadlines that also cover the body", async (t) => {
  shrink(t, "lnplusMs", 100);
  shrink(t, "priceMs", 100);
  const mock = installFetchMock(t);
  // Headers arrive, the body never does.
  mock.on(/lightningnetwork\.plus/, stalledBody);
  mock.on("https://mempool.space/api/v1/prices", stalledBody);

  const lnplus = await elapsed(getPoolNodes({ limit: 5 }));
  assert.match(String(lnplus.err), /timed out/);
  assert.ok(lnplus.ms < 3_000, `LN+ took ${lnplus.ms} ms`);

  const price = await elapsed(getBtcPrice("USD"));
  assert.equal(price.err, undefined, "price lookups degrade to null, never throw");
  assert.ok(price.ms < 3_000, `price took ${price.ms} ms`);
});
