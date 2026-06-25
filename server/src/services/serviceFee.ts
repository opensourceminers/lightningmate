import { decodePaymentRequest, getWalletInfo, type AuthenticatedLnd } from "lightning";
import { payRequest } from "./payments.js";

export interface SaleFeeConfig {
  /** Basis points of the earned lease fee, e.g. 50 = 0.5%. 0 disables the fee. */
  bps: number;
  /** Lightning Address the fee is paid to, e.g. name@domain. */
  address: string;
}

/**
 * Service-fee settings, driven by env so they can be tuned (or zeroed) from the
 * app store's docker-compose without rebuilding the image:
 *   LM_SELL_FEE_BPS      basis points (default 0 = off)
 *   LM_SELL_FEE_ADDRESS  destination Lightning Address
 */
export function saleFeeConfig(): SaleFeeConfig {
  const raw = Number(process.env.LM_SELL_FEE_BPS ?? "0");
  const bps = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  return { bps, address: (process.env.LM_SELL_FEE_ADDRESS ?? "").trim() };
}

/** True when a fee is configured (rate > 0 and a destination is set). */
export function saleFeeEnabled(): boolean {
  const { bps, address } = saleFeeConfig();
  return bps > 0 && address.length > 0;
}

const TIMEOUT_MS = 15_000;

/** Resolve a Lightning Address (LNURL-pay) to a BOLT11 invoice for `amountSats`. */
async function addressInvoice(address: string, amountSats: number): Promise<string | null> {
  const [name, domain] = address.split("@");
  if (!name || !domain) return null;
  const lnurlp = `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
  const meta = (await (await fetch(lnurlp, { signal: AbortSignal.timeout(TIMEOUT_MS) })).json()) as {
    tag?: string;
    callback?: string;
    minSendable?: number;
    maxSendable?: number;
  };
  if (meta.tag !== "payRequest" || !meta.callback) return null;
  const msat = amountSats * 1000;
  if (msat < (meta.minSendable ?? 0) || msat > (meta.maxSendable ?? Number.MAX_SAFE_INTEGER)) return null;
  const sep = meta.callback.includes("?") ? "&" : "?";
  const cb = (await (
    await fetch(`${meta.callback}${sep}amount=${msat}`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  ).json()) as { pr?: string };
  return cb.pr ?? null;
}

export interface SaleFeeResult {
  paid: boolean;
  sats: number;
  reason?: string;
}

/**
 * Best-effort service fee on a completed liquidity sale: pays `bps` of the earned
 * lease fee to the configured Lightning Address. This is disclosed in the Sell tab
 * and the release notes — it is not hidden. It never throws: a disabled config, a
 * payment to our own node, a missing invoice or a routing failure just returns a
 * reason for the caller to log, and never affects the user's own order.
 */
export async function paySaleServiceFee(
  lnd: AuthenticatedLnd,
  earnedSats: number,
): Promise<SaleFeeResult> {
  const { bps, address } = saleFeeConfig();
  if (bps <= 0 || !address) return { paid: false, sats: 0, reason: "disabled" };
  const sats = Math.floor((earnedSats * bps) / 10_000);
  if (sats < 1) return { paid: false, sats: 0, reason: "below 1 sat" };
  try {
    const request = await addressInvoice(address, sats);
    if (!request) return { paid: false, sats, reason: "could not fetch invoice" };
    const [{ public_key: me }, decoded] = await Promise.all([
      getWalletInfo({ lnd }),
      decodePaymentRequest({ lnd, request }),
    ]);
    // Don't pay ourselves (the developer running their own node).
    if (decoded.destination === me) return { paid: false, sats, reason: "self" };
    const maxFee = Math.max(5, Math.ceil(sats * 0.1));
    const r = await payRequest(lnd, { request, maxFeeSats: maxFee });
    return r.ok ? { paid: true, sats } : { paid: false, sats, reason: "not confirmed" };
  } catch (e) {
    return { paid: false, sats, reason: e instanceof Error ? e.message : String(e) };
  }
}
