import type { TestContext } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MagmaJournalEntry } from "../../src/services/magmaJournal.js";
import { EarningsLog } from "../../src/services/earningsLog.js";
import { ServiceFeeLedger } from "../../src/services/serviceFee.js";
import { AmbossError } from "../../src/services/amboss.js";
import type { FakeLnd } from "./fakeLnd.js";
import type { sellerSetup } from "./autopilot.js";
import { withEnv } from "./env.js";
import type { AfterHook } from "./tmp.js";

/**
 * Shared pieces of the Magma order-lane tests (magmaLifecycle, magmaDecisions,
 * magmaReads, magmaOpens, magmaLegacy …). They were one 2,000-line file whose
 * 81 tests came close to node:test's per-FILE timeout on a slow CI runner;
 * split into focused files, each runs well inside it.
 */

export const ADDRESS = "fees@fees.example";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The disclosed 1% service fee, paid to a test address. */
export function feeEnv(t: AfterHook): void {
  withEnv(t, { LM_SELL_FEE_BPS: "100", LM_SELL_FEE_ADDRESS: ADDRESS, LM_SELL_FEE_PUBKEY: undefined });
}

export const journalOnDisk = (dir: string): MagmaJournalEntry[] =>
  existsSync(join(dir, "magma-orders.json"))
    ? (JSON.parse(readFileSync(join(dir, "magma-orders.json"), "utf8")) as MagmaJournalEntry[])
    : [];
export const entryOnDisk = (dir: string, id: string) => journalOnDisk(dir).find((e) => e.orderId === id);
/** What a restarted process would read: fee ledger and earnings from disk. */
export const feesOnDisk = (dir: string) => new ServiceFeeLedger(dir, null).entries();
export const salesOnDisk = (dir: string) => new EarningsLog(dir).recent();

export function quiet(t: TestContext): void {
  t.mock.method(console, "warn", () => undefined);
  t.mock.method(console, "log", () => undefined);
}

/** LND's WalletBalance answer for the fake node's chain balance. */
export const walletBalance = (node: FakeLnd) => ({
  confirmed_balance: String(node.chainBalance),
  unconfirmed_balance: "0",
  total_balance: String(node.chainBalance),
  locked_balance: "0",
  reserved_balance_anchor_chan: "10000",
  account_balance: {},
});

export const IN_AN_HOUR = () => new Date(Date.now() + 3_600_000).toISOString();

type SellerAutopilot = ReturnType<typeof sellerSetup>["autopilot"];

/** The sells the run history shows for one order. */
export const historyFor = (autopilot: SellerAutopilot, id: string) =>
  autopilot.getState().history.flatMap((r) => r.sells).filter((s) => s.orderId === id);

/** Amboss's answer for these orders' reads never comes: each read runs into
 *  its deadline (`fail` answers instead, e.g. an HTTP-level error). Returns
 *  the ids read, in order. */
export function readsHang(
  autopilot: SellerAutopilot,
  hanging: (id: string) => boolean,
  fail: () => Error = () => new AmbossError("timeout", "Amboss request to magma.amboss.tech timed out after 15s"),
): string[] {
  const desk = autopilot.magma as unknown as { ambossSale: (key: string, id: string) => Promise<unknown> };
  const real = desk.ambossSale.bind(autopilot.magma);
  const read: string[] = [];
  desk.ambossSale = async (key, id) => {
    read.push(id);
    if (hanging(id)) throw fail();
    return real(key, id);
  };
  return read;
}

/** An external step of the Magma desk a test can make "kill the process". */
export type Seam = "lndCreateHodl" | "ambossAccept" | "lndOpen" | "ambossAddTx" | "lndSettle" | "ambossReject" | "lndConnect";

/** Make one external step "kill the process": the step's side effect happens
 *  (when `after`), then nothing of ours ever runs again in that process.
 *  Returns whether the step was reached. */
export function crashAt(desk: object, seam: Seam, when: "before" | "after"): () => boolean {
  const d = desk as Record<Seam, (...a: unknown[]) => Promise<unknown>>;
  const real = d[seam].bind(desk);
  let reached = false;
  d[seam] = async (...args: unknown[]) => {
    if (when === "after") await real(...args);
    reached = true;
    return new Promise(() => undefined); // the process is gone
  };
  return () => reached;
}
