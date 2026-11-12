/**
 * The fee autopilot as a closed loop (review 2026-11-10, package P3): the
 * REAL Autopilot (fee stage, books, fee-change log, step-back clocks, anchors,
 * elasticity learner) on the fake fee node, on a mocked clock. Between two
 * runs a small market model moves sats over the subject channel, depending on
 * the fee the node really charges. What a scenario sold, what it earned, where
 * the fee ended and how many days went by without a sale are the numbers the
 * fee rules are judged on (test/feeScenarios*.test.ts).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Autopilot } from "../../src/services/autopilot.js";
import { RebalanceLog } from "../../src/services/rebalanceLog.js";
import { OverridesStore } from "../../src/services/overrides.js";
import { AmbossStore } from "../../src/services/ambossStore.js";
import { EarningsLog } from "../../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../../src/services/serviceFee.js";
import { initHtlcTelemetry, recordForwardEvent, setChannelCapacities, stopHtlcTelemetry } from "../../src/services/htlcTelemetry.js";
import { feeNode, withMarket, type FakeForward, type FeeChannel } from "./feeNode.js";
import { suppressSchedulerKicks } from "./autopilot.js";
import { installFetchMock } from "./fetchMock.js";
import { AMBOSS_API } from "./amboss.js";
import { makeTempDir } from "./tmp.js";

export const PEER = (n: number) => "02" + n.toString(16).padStart(2, "0").repeat(32);
export const TX = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const A = "850000x1x0";
export const B = "850000x2x0";

export interface SimOpts {
  days: number;
  /** Subject channel. */
  capacity?: number;
  localStart: number; // sats
  feeStart: number;
  /** Channel id of the subject (its block height sets its age). */
  id?: string;
  blockHeight?: number;
  /** Sats per day buyers would route OUT over the subject at `fee` on `day`. */
  outRate?: (feePpm: number, day: number, localRatio: number) => number;
  /** Sats per day arriving IN over the subject (refilling local). */
  inRate?: (day: number, localRatio: number) => number;
  /** Size of one forward. */
  chunk?: number;
  market?: { intoPpm: number; backPpm?: number };
  config?: Record<string, unknown>;
  stepHours?: number;
  /** Runs before each autopilot run (to pin, exclude, etc.). */
  each?: (ctx: { day: number; autopilot: Autopilot; node: ReturnType<typeof feeNode>; overrides: OverridesStore }) => void | Promise<void>;
  /** Days of forwards before the start, at the start fee and the model's rates (balance unchanged). */
  warmDays?: number;
  /** Extra excluded channels (so the node has >= 5 active ones). */
  extra?: number;
  /**
   * Single forwards at their own times and sizes (a case seen on a live node,
   * replayed), on top of the rates. One going out is sold at the fee in force
   * if the buyers pay it (`paysUpTo`) and the channel can carry it; one it
   * cannot carry is turned away, and the HTLC telemetry hears of it as it
   * does from LND. One from before the start (`atHour` below 0) is the
   * channel's history: sold at the start fee, the balance as given.
   */
  replay?: SimForward[];
  /** The highest fee the buyers of `replay` pay (default: any). */
  paysUpTo?: number;
}

/** One forward of a replay: `atHour` hours after the start (below 0: before it), `out` or `in` sats over the subject. */
export interface SimForward {
  atHour: number;
  out?: number;
  in?: number;
}

export interface SimResult {
  changes: { day: number; from: number; to: number; why: string; local: number }[];
  daily: { day: number; fee: number; local: number; soldSats: number; revenueSats: number }[];
  revenueSats: number;
  soldSats: number;
  /** Whole days in which nothing was sold over the subject. */
  daysWithoutSale: number;
  /** Replayed forwards the channel could not carry (sats). */
  turnedAwaySats: number;
  /** Replayed forwards whose buyers do not pay the fee in force (sats). */
  pricedOutSats: number;
  /** The fee at the end. */
  finalPpm: number;
  node: ReturnType<typeof feeNode>;
  autopilot: Autopilot;
}

export async function simulate(t: TestContext, o: SimOpts): Promise<SimResult> {
  const capacity = o.capacity ?? 5_000_000;
  const id = o.id ?? A;
  const height = o.blockHeight ?? 860_000;
  const subject: FeeChannel = {
    id,
    partnerPublicKey: PEER(1),
    capacity,
    localBalance: o.localStart,
    transactionId: TX(1),
    transactionVout: 0,
    feeRatePpm: o.feeStart,
    baseFeeMsat: 0,
  };
  // The other side of every forward: a big channel, kept half full.
  const other: FeeChannel = {
    id: B,
    partnerPublicKey: PEER(2),
    capacity: 20_000_000,
    localBalance: 10_000_000,
    transactionId: TX(2),
    transactionVout: 0,
    feeRatePpm: 80,
    baseFeeMsat: 0,
  };
  const channels = [subject, other];
  for (let k = 0; k < (o.extra ?? 0); k++)
    channels.push({ id: `85000${k}x9x0`, partnerPublicKey: PEER(10 + k), capacity: 3_000_000, localBalance: 1_500_000, transactionId: TX(10 + k), transactionVout: 0, feeRatePpm: 80, baseFeeMsat: 0 });
  const forwards: FakeForward[] = [];
  const start0 = Date.parse("2026-11-01T00:00:00.000Z");
  if (o.warmDays) {
    const ck = o.chunk ?? 50_000;
    const ratio0 = o.localStart / capacity;
    const perDayOut = o.outRate?.(o.feeStart, 0, ratio0) ?? 0;
    const perDayIn = o.inRate?.(0, ratio0) ?? 0;
    const nOut = Math.floor((perDayOut * o.warmDays) / ck);
    const nIn = Math.floor((perDayIn * o.warmDays) / ck);
    for (let k = 0; k < nOut; k++) forwards.push({ at: start0 - o.warmDays * DAY + Math.round(((k + 0.5) / nOut) * o.warmDays * DAY), inId: B, outId: id, tokens: ck, feeMsat: Math.round((ck * o.feeStart) / 1000) });
    for (let k = 0; k < nIn; k++) forwards.push({ at: start0 - o.warmDays * DAY + Math.round(((k + 0.25) / nIn) * o.warmDays * DAY), inId: id, outId: B, tokens: ck, feeMsat: 4_000 });
  }
  for (const e of o.replay ?? []) {
    if (e.atHour >= 0) continue;
    const at = start0 + Math.round(e.atHour * HOUR);
    if (e.out) forwards.push({ at, inId: B, outId: id, tokens: e.out, feeMsat: Math.round((e.out * o.feeStart) / 1000) });
    if (e.in) forwards.push({ at, inId: id, outId: B, tokens: e.in, feeMsat: 4_000 });
  }
  forwards.sort((a, b) => Number(a.at) - Number(b.at));
  const node = feeNode({ blockHeight: height, channels, forwards });
  if (o.market) withMarket(node, channels, { [id]: o.market });
  const start = Date.parse("2026-11-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now: start });

  const http = installFetchMock(t);
  http.onGraphql(AMBOSS_API, "getMarketMetrics", () => ({ data: { getMarketMetrics: { order_details: [] } } }));
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "autopilot.json"), JSON.stringify({ config: { enabled: true, ...(o.config ?? {}) }, history: [], sellAutoSizeMigrated: true }));
  if (o.replay) {
    // What the channel turns away is evidence the fee rules read.
    initHtlcTelemetry(dir);
    setChannelCapacities(channels.map((c) => [c.id, c.capacity]));
    t.after(() => {
      stopHtlcTelemetry();
      setChannelCapacities([]);
    });
  }
  const replay = [...(o.replay ?? [])].sort((a, b) => a.atHour - b.atHour);
  const overrides = new OverridesStore(dir);
  // The other channel is not the subject of the probe: the engine leaves it alone.
  for (const c of channels) if (c.id !== id) overrides.set(c.id, { mode: "exclude" });
  const autopilot = new Autopilot(dir, node.lnd, node.lnd, new RebalanceLog(dir), overrides, new AmbossStore(dir), new EarningsLog(dir), new ServiceFeeLedger(dir, null));
  suppressSchedulerKicks(autopilot);
  t.after(() => autopilot.shutdown());

  const stepH = o.stepHours ?? 1;
  const chunk = o.chunk ?? 50_000;
  const reserve = Math.round(capacity * 0.01);
  const res: SimResult = { changes: [], daily: [], revenueSats: 0, soldSats: 0, daysWithoutSale: 0, turnedAwaySats: 0, pricedOutSats: 0, finalPpm: o.feeStart, node, autopilot };
  let soldAtDayStart = 0;
  let outCarry = 0;
  let inCarry = 0;
  const steps = Math.round((o.days * 24) / stepH);
  for (let i = 0; i < steps; i++) {
    const now = start + i * stepH * HOUR;
    const day = (i * stepH) / 24;
    // The market acts over the step that just passed, at the fee in force.
    if (i > 0) {
      const fee = node.feeOf(id)!.ppm;
      const ratio = subject.localBalance / capacity;
      const outPerDay = o.outRate?.(fee, day, ratio) ?? 0;
      // Buyers who don't pay this fee don't wait in line for it (a chunk
      // carried over from a lower fee sold at one nobody pays).
      if (outPerDay <= 0) outCarry = 0;
      outCarry += (outPerDay * stepH) / 24;
      inCarry += ((o.inRate?.(day, ratio) ?? 0) * stepH) / 24;
      let k = 0;
      while (outCarry >= chunk && subject.localBalance - reserve >= chunk) {
        outCarry -= chunk;
        subject.localBalance -= chunk;
        subject.totalSent = (subject.totalSent ?? 0) + chunk;
        const feeMsat = Math.round((chunk * fee) / 1000);
        // Spread inside the step, more than a minute apart (a burst counts once).
        forwards.push({ at: now - Math.round(stepH * HOUR * 0.9) + k * 120_000, inId: B, outId: id, tokens: chunk, feeMsat });
        res.revenueSats += feeMsat / 1000;
        res.soldSats += chunk;
        k += 1;
      }
      // Demand that found no liquidity is gone (not queued for ever).
      if (subject.localBalance - reserve < chunk) outCarry = Math.min(outCarry, chunk);
      while (inCarry >= chunk && capacity - subject.localBalance - reserve >= chunk) {
        inCarry -= chunk;
        subject.localBalance += chunk;
        forwards.push({ at: now - Math.round(stepH * HOUR * 0.5) + k * 120_000, inId: id, outId: B, tokens: chunk, feeMsat: 4_000 });
        k += 1;
      }
      if (capacity - subject.localBalance - reserve < chunk) inCarry = Math.min(inCarry, chunk);
      // The replayed forwards of the step, each at its own time.
      for (const e of replay) {
        const at = start + Math.round(e.atHour * HOUR);
        if (at <= now - stepH * HOUR || at > now) continue;
        if (e.in && capacity - subject.localBalance - reserve >= e.in) {
          subject.localBalance += e.in;
          forwards.push({ at, inId: id, outId: B, tokens: e.in, feeMsat: 4_000 });
        }
        if (!e.out) continue;
        if (fee > (o.paysUpTo ?? Infinity)) {
          res.pricedOutSats += e.out;
        } else if (subject.localBalance - reserve < e.out) {
          res.turnedAwaySats += e.out;
          t.mock.timers.setTime(at);
          recordForwardEvent({ is_failed: true, is_receive: false, is_send: false, in_channel: B, out_channel: id, internal_failure: "INSUFFICIENT_BALANCE", tokens: e.out });
        } else {
          subject.localBalance -= e.out;
          subject.totalSent = (subject.totalSent ?? 0) + e.out;
          const feeMsat = Math.round((e.out * fee) / 1000);
          forwards.push({ at, inId: B, outId: id, tokens: e.out, feeMsat });
          res.revenueSats += feeMsat / 1000;
          res.soldSats += e.out;
        }
      }
    }
    t.mock.timers.setTime(now);
    node.blockHeight = height + Math.floor((i * stepH * 6));
    await o.each?.({ day, autopilot, node, overrides });
    const run = await autopilot.runOnce();
    for (const c of run?.changes ?? []) {
      if (c.id !== id) continue;
      res.changes.push({ day: Math.round(day * 100) / 100, from: c.fromPpm, to: c.toPpm, why: (c.ok ? "" : `FAILED ${c.error}: `) + (c.why ?? ""), local: Math.round((subject.localBalance / capacity) * 100) });
    }
    if ((i * stepH) % 24 === 0) {
      if (i > 0 && res.soldSats === soldAtDayStart) res.daysWithoutSale += 1;
      soldAtDayStart = res.soldSats;
      res.daily.push({ day: Math.round(day), fee: node.feeOf(id)!.ppm, local: Math.round((subject.localBalance / capacity) * 100), soldSats: res.soldSats, revenueSats: Math.round(res.revenueSats) });
    }
  }
  res.finalPpm = node.feeOf(id)!.ppm;
  return res;
}

/** One line of the before/after table: sold, earned, final fee, fee changes, days without a sale. */
export const outcome = (r: SimResult) => ({ sold: r.soldSats, earned: Math.round(r.revenueSats), finalPpm: r.finalPpm, changes: r.changes.length, daysWithoutSale: r.daysWithoutSale });

type Change = SimResult["changes"][number];
/** The fee changes of a run as [from, to] pairs. */
export const movesOf = (r: SimResult): [number, number][] => r.changes.map((c) => [c.from, c.to]);
export const raisesOf = (r: SimResult): Change[] => r.changes.filter((c) => c.to > c.from);
export const loweringsOf = (r: SimResult): Change[] => r.changes.filter((c) => c.to < c.from);
/** The lowerings that take a raise back ("step back: …"). */
export const stepBacksOf = (r: SimResult): Change[] => r.changes.filter((c) => c.why.startsWith("step back"));
/** The fee in force on a day (after that day's first run). */
export const feeOn = (r: SimResult, day: number): number => r.daily.find((d) => d.day === day)!.fee;
/** Days between one fee change and the next. */
export const gapsOf = (cs: Change[]): number[] => cs.slice(1).map((c, i) => Math.round((c.day - cs[i].day) * 100) / 100);

/** What happened, one line per fee change — the message of a failed assertion. */
export function told(r: SimResult, everyDays = 5): string {
  const lines: string[] = [];
  for (const c of r.changes) lines.push(`  d${String(c.day).padStart(6)}  ${String(c.from).padStart(4)} -> ${String(c.to).padStart(4)}  (${c.local}% local)  ${c.why.slice(0, 150)}`);
  lines.push("  daily: " + r.daily.filter((d) => d.day % everyDays === 0).map((d) => `d${d.day}:${d.fee}ppm/${d.local}%`).join("  "));
  lines.push(`  sold ${r.soldSats.toLocaleString("en-US")} sat, earned ${Math.round(r.revenueSats).toLocaleString("en-US")} sat; final fee ${r.finalPpm} ppm; ${r.changes.length} fee changes; ${r.daysWithoutSale} days without a sale`);
  if (r.turnedAwaySats || r.pricedOutSats) lines.push(`  turned away for lack of sats: ${r.turnedAwaySats.toLocaleString("en-US")} sat; not sent at this fee: ${r.pricedOutSats.toLocaleString("en-US")} sat`);
  return lines.join("\n");
}

/**
 * With FEE_SIM_TRACE=1 a scenario prints its fee changes and one
 * `OUT {"id":…}` line (sold, earned, final fee, changes, days without a sale)
 * — the before/after table of a change to the fee rules is made from those.
 * Without it a scenario is silent.
 */
export function report(id: string, title: string, r: SimResult, everyDays = 5): void {
  if (!process.env.FEE_SIM_TRACE) return;
  console.log(`\n=== ${id} ${title} ===\n${told(r, everyDays)}\nOUT ${JSON.stringify({ id, ...outcome(r) })}`);
}
