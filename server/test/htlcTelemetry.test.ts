/**
 * Unserved-demand telemetry, de-noised (D20; review a2/a5/a1, package P2).
 *
 * Before: every INSUFFICIENT_BALANCE refusal was summed — on the dev node
 * 94.4M sat in two hours, more than the node's whole capacity, ~92% of it
 * probe-shaped (HTLCs of 95–99% of a channel; one round amount tried on
 * seven channels) — and shown as "demand worth X sat you didn't earn on".
 * Now each refusal is classified as it arrives; the engines read only the
 * attempts a refilled channel could have carried.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  getUnservedDemand,
  initHtlcTelemetry,
  recordForwardEvent,
  servableDemand,
  setChannelCapacities,
  startHtlcTelemetry,
  stopHtlcTelemetry,
  telemetryAgeDays,
} from "../src/services/htlcTelemetry.js";
import { FakeLnd, type FakeChannel } from "./helpers/fakeLnd.js";
import { getFeeRecommendations } from "../src/services/feeRecommend.js";
import { feeNode } from "./helpers/feeNode.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir, type AfterHook } from "./helpers/tmp.js";

function telemetry(t: AfterHook, capacities: [string, number][] = []): string {
  const dir = makeTempDir(t);
  initHtlcTelemetry(dir);
  setChannelCapacities(capacities);
  t.after(() => {
    stopHtlcTelemetry();
    setChannelCapacities([]);
  });
  return dir;
}

const refuse = (out: string, sats: number, inn = "800000x9x0") =>
  recordForwardEvent({ is_failed: true, is_receive: false, is_send: false, out_channel: out, in_channel: inn, internal_failure: "INSUFFICIENT_BALANCE", tokens: sats });

test("refusals are classified: probes (≥ 90% of the channel), retries of the same amount, HTLCs too big for any refill — and only the rest is demand", (t) => {
  telemetry(t, [["A", 5_000_000], ["B", 2_000_000], ["C", 2_000_000]]);
  refuse("A", 4_925_000); // 98.5% of a 5M channel: capacity probing
  refuse("A", 1_000_000); // a plausible attempt …
  refuse("B", 1_000_000); // … the same amount on two more channels: one attempt
  refuse("C", 1_000_000);
  refuse("B", 1_200_000); // 60% of B: no refill to a healthy balance carries it
  refuse("B", 150_000);
  refuse("C", 200_000);
  refuse("D", 50_000); // a channel whose size isn't known (yet)
  recordForwardEvent({ is_failed: true, is_receive: false, is_send: false, out_channel: "B", in_channel: "800000x9x0", internal_failure: "FEE_INSUFFICIENT", tokens: 10_000 });

  const by = new Map(getUnservedDemand(7).map((d) => [d.outChannel, d]));
  const A = by.get("A")!;
  assert.deepEqual([A.liquidityCount, A.liquiditySats, A.probeCount, A.demandCount, A.demandSats], [2, 5_925_000, 1, 1, 1_000_000]);
  const B = by.get("B")!;
  assert.deepEqual([B.liquidityCount, B.retryCount, B.oversizedCount, B.demandCount, B.demandSats, B.otherCount], [3, 1, 1, 1, 150_000, 1]);
  const C = by.get("C")!;
  assert.deepEqual([C.retryCount, C.demandCount, C.demandSats], [1, 1, 200_000]);
  assert.equal(by.get("D")!.unclassifiedCount, 1);
  // What the engines read: the attempts only.
  assert.deepEqual(
    [...servableDemand(7)].map(([id, d]) => [id, d.attempts, d.sats]).sort(),
    [["A", 1, 1_000_000], ["B", 1, 150_000], ["C", 1, 200_000]],
  );
  // Raw: 9.475M refused; de-noised: 1.35M of possible demand.
  const raw = getUnservedDemand(7).reduce((s, d) => s + d.liquiditySats, 0);
  const real = [...servableDemand(7).values()].reduce((s, d) => s + d.sats, 0);
  assert.equal(raw, 9_525_000);
  assert.equal(real, 1_350_000);
});

test("the same amount again after the retry window is a new attempt; the days with attempts and their median are kept", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T10:00:00.000Z") });
  telemetry(t, [["A", 2_000_000]]);
  refuse("A", 100_000);
  t.mock.timers.tick(11 * 60_000);
  refuse("A", 100_000); // 11 minutes later: another attempt
  t.mock.timers.tick(24 * 3_600_000);
  refuse("A", 400_000);
  const [a] = getUnservedDemand(7);
  assert.equal(a.demandCount, 3);
  assert.equal(a.demandDays, 2);
  assert.equal(a.demandMedianSats, 100_000);
  assert.deepEqual(servableDemand(7).get("A"), { attempts: 3, sats: 600_000, days: 2, medianSats: 100_000 });
});

test("the age of the data is reported to a tenth of a day — the first day read 0, and the UI then said '7d'", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T00:00:00.000Z") });
  telemetry(t);
  t.mock.timers.tick(12 * 3_600_000);
  assert.equal(telemetryAgeDays(), 0.5);
});

test("buckets written before classification existed count as unclassified, never as demand", (t) => {
  const dir = makeTempDir(t);
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(dir, "htlc-telemetry.json"),
    JSON.stringify({ startedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), buckets: [{ day: today, outChannel: "A", liquidityCount: 3, liquiditySats: 14_775_000, otherCount: 0 }] }),
  );
  initHtlcTelemetry(dir);
  t.after(() => stopHtlcTelemetry());
  const [a] = getUnservedDemand(7);
  assert.deepEqual([a.liquidityCount, a.unclassifiedCount, a.demandCount], [3, 3, 0]);
  assert.equal(servableDemand(7).size, 0);
});

test("the fee engine reads the de-noised telemetry by itself: a channel turning real payments away is not lowered as idle — a probe storm on it changes nothing", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() - 86_400_000 });
  telemetry(t, [["850000x1x0", 2_000_000], ["850000x2x0", 2_000_000]]);
  const node = feeNode({
    channels: [
      { id: "850000x1x0", partnerPublicKey: "02" + "11".repeat(32), capacity: 2_000_000, localBalance: 400_000, transactionId: "11".repeat(32), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0 },
      { id: "850000x2x0", partnerPublicKey: "02" + "22".repeat(32), capacity: 2_000_000, localBalance: 400_000, transactionId: "22".repeat(32), transactionVout: 0, feeRatePpm: 300, baseFeeMsat: 0 },
    ],
  });
  // Channel 1: three real attempts over two days. Channel 2: ten probes.
  refuse("850000x1x0", 120_000);
  refuse("850000x1x0", 90_000);
  for (let i = 0; i < 10; i++) refuse("850000x2x0", 1_980_000 - i);
  t.mock.timers.tick(86_400_000);
  refuse("850000x1x0", 70_000);
  t.mock.timers.reset();
  const report = await getFeeRecommendations(node.lnd, [], null, {}, {}, new Map(), new Map(), [], { market: new Map() });
  const by = (id: string) => report.recommendations.find((r) => r.channelId === id)!;
  assert.equal(by("850000x1x0").noFlowLowering, false, by("850000x1x0").reasons.join(" | "));
  assert.equal(by("850000x1x0").metrics.refusedAttempts14d, 3);
  assert.equal(by("850000x2x0").noFlowLowering, true, "probes are not demand");
  assert.equal(by("850000x2x0").metrics.refusedAttempts14d, 0);
});

test("GET /htlc/demand: raw and de-noised side by side, fees missed at the channel's current fee, the data's age in tenths of a day", async (t) => {
  const node = feeNode({
    channels: [{ id: "850000x1x0", partnerPublicKey: "02" + "11".repeat(32), capacity: 2_000_000, localBalance: 100_000, transactionId: "11".repeat(32), transactionVout: 0, feeRatePpm: 400, baseFeeMsat: 0 }],
  });
  const api = await startApi(t, { node });
  telemetry(t, [["850000x1x0", 2_000_000]]);
  refuse("850000x1x0", 250_000);
  refuse("850000x1x0", 1_990_000);
  const res = await api.request("GET", "/htlc/demand?days=7");
  assert.equal(res.status, 200);
  const [c] = res.body.channels;
  assert.deepEqual([c.liquidityCount, c.probeCount, c.demandCount, c.demandSats, c.missedFeesSats], [2, 1, 1, 250_000, 100]);
  assert.equal(typeof res.body.trackedDays, "number");
  assert.ok(res.body.classifiedSince);
});

test("upgrading: telemetry from before refusals were sorted (no classifiedSince) reports sorting from NOW — never since the telemetry began, which would skip the page's 'not sorted yet' and claim a week of sorted refusals", async (t) => {
  const node = feeNode({
    channels: [{ id: "850000x1x0", partnerPublicKey: "02" + "11".repeat(32), capacity: 2_000_000, localBalance: 100_000, transactionId: "11".repeat(32), transactionVout: 0, feeRatePpm: 400, baseFeeMsat: 0 }],
  });
  const api = await startApi(t, { node });
  const dir = makeTempDir(t);
  const startedAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
  writeFileSync(
    join(dir, "htlc-telemetry.json"),
    JSON.stringify({ startedAt, buckets: [{ day: new Date().toISOString().slice(0, 10), outChannel: "850000x1x0", liquidityCount: 34, liquiditySats: 40_000_000, otherCount: 0 }] }),
  );
  const before = Date.now();
  initHtlcTelemetry(dir);
  t.after(() => stopHtlcTelemetry());
  const res = await api.request("GET", "/htlc/demand?days=7");
  assert.equal(res.status, 200);
  assert.ok(res.body.trackedDays >= 19.9, "the raw counts still date from when telemetry began");
  const since = Date.parse(res.body.classifiedSince);
  assert.ok(since >= before - 1_000 && since <= Date.now(), `sorted since now, not ${startedAt}: ${res.body.classifiedSince}`);
});

test("a refusal on a channel whose size isn't known yet has the channel sizes read from LND again — at most once a minute — and once they are, its refusals are sorted", async (t) => {
  telemetry(t);
  const channels: FakeChannel[] = [
    { id: "850000x1x0", partnerPublicKey: "02" + "11".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "11".repeat(32), transactionVout: 0 },
  ];
  const node = new FakeLnd({ channels });
  node.override("router.subscribeHtlcEvents", () => Object.assign(new EventEmitter(), { cancel: () => undefined }));
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const reads = () => node.callsTo("default.listChannels").length;
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  startHtlcTelemetry(node.lnd);
  await settle();
  assert.equal(reads(), 1, "the sizes are read at start");
  // A channel opened since: its size isn't known yet.
  channels.push({ id: "850000x2x0", partnerPublicKey: "02" + "22".repeat(32), capacity: 2_000_000, localBalance: 1_000_000, transactionId: "22".repeat(32), transactionVout: 0 });
  refuse("850000x2x0", 100_000);
  await settle();
  assert.equal(reads(), 1, "not again within the minute");
  t.mock.timers.tick(61_000);
  refuse("850000x2x0", 110_000);
  await settle();
  assert.equal(reads(), 2, "read again: a refusal on a channel of unknown size");
  refuse("850000x2x0", 120_000);
  await settle();
  assert.equal(reads(), 2);
  const d = getUnservedDemand(7).find((x) => x.outChannel === "850000x2x0");
  assert.deepEqual([d?.unclassifiedCount, d?.demandCount], [2, 1], "sorted once its size is known");
});
