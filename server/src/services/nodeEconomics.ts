import { getChainFeeRate, type AuthenticatedLnd } from "lightning";
import type { ChannelView } from "./channels.js";

/**
 * One shared economics model so every algo speaks the same language:
 *  - what a sat of capital actually earns routing (yield on capital, annualised)
 *  - what it costs on-chain to open/close a channel right now (live fee rate)
 * Fee-v2, rebalance, suggestions, close and Magma all read these instead of each
 * rolling their own (previously inconsistent) version.
 */

export const OPEN_TX_VBYTES = 175;
export const CLOSE_TX_VBYTES = 150;
const DEFAULT_OPEN_COST_SAT = 1_000;
const DEFAULT_CLOSE_COST_SAT = 500;

export interface OnchainCosts {
  /** Live estimate, sat/vByte (null if unavailable → defaults used). */
  feePerVbyte: number | null;
  openCostSat: number;
  closeCostSat: number;
}

export async function onchainCosts(
  lnd: AuthenticatedLnd,
  openVbytes = OPEN_TX_VBYTES,
  closeVbytes = CLOSE_TX_VBYTES,
): Promise<OnchainCosts> {
  let feePerVbyte: number | null = null;
  try {
    feePerVbyte = (await getChainFeeRate({ lnd })).tokens_per_vbyte ?? null;
  } catch {
    feePerVbyte = null;
  }
  return {
    feePerVbyte,
    openCostSat: feePerVbyte != null ? Math.ceil(feePerVbyte * openVbytes) : DEFAULT_OPEN_COST_SAT,
    closeCostSat: feePerVbyte != null ? Math.ceil(feePerVbyte * closeVbytes) : DEFAULT_CLOSE_COST_SAT,
  };
}

export interface CapitalYield {
  /** Routing revenue as ppm/year on total deployed capacity (null if no data). */
  routingYieldPpmPerYear: number | null;
  revenueWindowSats: number;
  totalCapacitySats: number;
}

/** Yield ON CAPITAL — the honest bar leasing / rebalancing must clear. */
export function nodeCapitalYield(
  channels: ChannelView[],
  revenueWindowSats: number,
  windowDays: number,
): CapitalYield {
  const totalCapacitySats = channels.reduce((s, c) => s + c.capacity, 0);
  const has = totalCapacitySats > 0 && revenueWindowSats > 0 && windowDays > 0;
  return {
    routingYieldPpmPerYear: has
      ? Math.round((revenueWindowSats / totalCapacitySats) * (365 / windowDays) * 1_000_000)
      : null,
    revenueWindowSats,
    totalCapacitySats,
  };
}
