import { createHash, randomBytes } from "node:crypto";
import {
  cancelHodlInvoice,
  createHodlInvoice,
  getInvoice,
  getInvoices,
  settleHodlInvoice,
  type AuthenticatedLnd,
  type GetInvoiceResult,
} from "lightning";

/**
 * HODL invoices — shared by LSP mode (LSPS1) and Magma selling.
 *
 * A HODL invoice does not settle when the buyer pays: the payment is HELD
 * until we release the preimage. That is what makes selling a channel
 * non-custodial: we settle only once the channel is delivered, and on any
 * failure we cancel and the buyer's payment returns to them automatically.
 *
 * The rules every caller follows:
 *  1. Persist the preimage BEFORE the invoice exists (newHodlSecret, then save,
 *     then createHodl) — a restart must always be able to settle or cancel.
 *  2. Settle only after delivery; cancel on every failure.
 *  3. Cancel before the held HTLC would expire. LND cancels held HTLCs itself
 *     shortly before their CLTV expiry (to avoid a force close) — a caller must
 *     treat "canceled" as a normal outcome, never as an error.
 */

export interface HodlSecret {
  /** Payment hash, hex — the invoice id. */
  id: string;
  /** Preimage, hex — releases the held payment. */
  secret: string;
}

export const sha256Hex = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** A fresh preimage and its payment hash. */
export function newHodlSecret(): HodlSecret {
  const secret = randomBytes(32);
  return { id: sha256Hex(secret), secret: secret.toString("hex") };
}

/** True when `secret` is the preimage of `id`. */
export function secretMatches(id: string, secret: string): boolean {
  return /^[0-9a-f]{64}$/i.test(secret) && sha256Hex(Buffer.from(secret, "hex")) === id.toLowerCase();
}

export interface CreateHodlParams {
  id: string;
  /** Amount in sats or, for amounts with a fractional sat, millisats. */
  tokens?: number;
  mtokens?: string;
  description: string;
  expiresAt: string;
  /** Final CLTV delta: how many blocks a paid HTLC can stay held. */
  cltvDelta?: number;
}

export async function createHodl(lnd: AuthenticatedLnd, p: CreateHodlParams): Promise<{ request: string }> {
  const inv = await createHodlInvoice({
    lnd,
    id: p.id,
    description: p.description,
    expires_at: p.expiresAt,
    ...(p.mtokens !== undefined ? { mtokens: p.mtokens } : { tokens: p.tokens }),
    ...(p.cltvDelta ? { cltv_delta: p.cltvDelta } : {}),
  });
  return { request: inv.request };
}

export function settleHodl(lnd: AuthenticatedLnd, secret: string): Promise<void> {
  return settleHodlInvoice({ lnd, secret });
}

export function cancelHodl(lnd: AuthenticatedLnd, id: string): Promise<void> {
  return cancelHodlInvoice({ lnd, id });
}

export type HodlState = "open" | "held" | "settled" | "canceled" | "missing";

export interface HodlStatus {
  state: HodlState;
  /** The BOLT11 request, when LND still has the invoice. */
  request: string | null;
  /** Invoice amount, millisats. */
  mtokens: bigint;
  /** Sum of the HTLCs currently held, millisats. */
  heldMtokens: bigint;
  /** Lowest CLTV expiry height among the held HTLCs (null when none held). */
  heldUntilHeight: number | null;
  expiresAt: string | null;
}

/** LND's view of a HODL invoice. "missing" when LND has no such invoice. */
export async function hodlStatus(lnd: AuthenticatedLnd, id: string): Promise<HodlStatus> {
  let inv: GetInvoiceResult;
  try {
    inv = await getInvoice({ lnd, id });
  } catch (err) {
    // LND answers an unknown hash with "unable to locate invoice".
    const text = Array.isArray(err) ? JSON.stringify(err) : String(err);
    if (/unable to locate invoice|InvoiceNotFound/i.test(text)) {
      return { state: "missing", request: null, mtokens: 0n, heldMtokens: 0n, heldUntilHeight: null, expiresAt: null };
    }
    throw err;
  }
  const held = (inv.payments ?? []).filter((p) => p.is_held);
  const state: HodlState = inv.is_confirmed ? "settled" : inv.is_canceled ? "canceled" : inv.is_held ? "held" : "open";
  return {
    state,
    request: inv.request ?? null,
    // The typings lack `mtokens` (the library returns it); tokens is whole sats.
    mtokens: BigInt((inv as { mtokens?: string }).mtokens ?? String(BigInt(inv.tokens ?? 0) * 1000n)),
    heldMtokens: held.reduce((s, p) => s + BigInt(p.mtokens ?? "0"), 0n),
    heldUntilHeight: held.length ? Math.min(...held.map((p) => p.timeout)) : null,
    expiresAt: inv.expires_at ?? null,
  };
}

export interface FoundInvoice {
  id: string;
  state: Exclude<HodlState, "missing">;
  /** A hold invoice: LND doesn't know its preimage until it is settled (only
   *  its maker does) — and a plain invoice is never "held". */
  hold: boolean;
  /** Paid so far (held or settled), millisats. */
  receivedMtokens: bigint;
  createdAt: string;
}

const INVOICE_PAGE = 100;

/**
 * The invoices LND has with exactly this description, created at or after
 * `since` — newest first; at most `maxPages` pages are looked at. How the
 * invoice of a sale is found when the record that named it is gone.
 */
export async function findInvoicesByDescription(
  lnd: AuthenticatedLnd,
  description: string,
  since: string,
  maxPages = 20,
): Promise<FoundInvoice[]> {
  const sinceMs = Date.parse(since);
  const out: FoundInvoice[] = [];
  let token: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    // created_after narrows the scan on LND ≥ 0.16; older ones ignore it and
    // the date check below ends the scan instead.
    const res = await getInvoices(token ? { lnd, token } : { lnd, limit: INVOICE_PAGE, created_after: since });
    let older = false;
    for (const inv of res.invoices) {
      if (Date.parse(inv.created_at) < sinceMs) {
        older = true;
        continue;
      }
      if (inv.description !== description) continue;
      out.push({
        id: inv.id,
        state: inv.is_confirmed ? "settled" : inv.is_canceled ? "canceled" : inv.is_held ? "held" : "open",
        hold: inv.is_held === true || (!inv.is_confirmed && !inv.secret),
        receivedMtokens: BigInt(inv.received_mtokens || "0"),
        createdAt: inv.created_at,
      });
    }
    if (older || !res.next) break;
    token = res.next;
  }
  return out;
}
