import { decodePaymentRequest, getPayment, getWalletInfo, pay, type AuthenticatedLnd } from "lightning";
import { JsonStore } from "../store.js";
import { HTTP_TIMEOUTS, httpRequest } from "./http.js";

/**
 * The disclosed service fee on completed liquidity sales (Magma + LSPS1).
 *
 * Two hard rules, both learned the expensive way in review:
 *
 * 1. FAIL CLOSED. The invoice comes from a remote LNURL server. We only pay it
 *    when it is for EXACTLY the fee we computed (mtokens == sats × 1000, as
 *    LUD-06 requires the wallet to check), is unexpired, is not to ourselves,
 *    and — if LM_SELL_FEE_PUBKEY is set — goes to that exact node. Before this,
 *    a compromised or misconfigured fee server could bill every install any
 *    amount on every sale.
 *
 * 2. NEVER IN THE CRITICAL PATH. A fee payment can hang for hours (an in-flight
 *    HTLC). Sales therefore only ENQUEUE the fee in a persistent ledger; a
 *    background loop pays it with a hard timeout and retries with backoff. A
 *    fee can never block or fail an accept, open or settle, and a crash or
 *    timeout can never lead to paying twice (the payment hash is recorded
 *    before the payment is sent, and checked before any retry).
 */

export interface SaleFeeConfig {
  /** Basis points of the earned lease fee, e.g. 100 = 1%. 0 disables the fee. */
  bps: number;
  /** Lightning Address the fee is paid to, e.g. name@domain. */
  address: string;
  /** Optional node id the fee invoice must be payable to (66 hex). */
  payeePubkey: string | null;
}

/**
 * Service-fee settings, driven by env so they can be tuned (or zeroed) from the
 * app store's docker-compose without rebuilding the image:
 *   LM_SELL_FEE_BPS      basis points (default 0 = off)
 *   LM_SELL_FEE_ADDRESS  destination Lightning Address
 *   LM_SELL_FEE_PUBKEY   optional: only pay invoices to this node id
 */
export function saleFeeConfig(): SaleFeeConfig {
  const raw = Number(process.env.LM_SELL_FEE_BPS ?? "0");
  const bps = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  const pin = (process.env.LM_SELL_FEE_PUBKEY ?? "").trim().toLowerCase();
  return {
    bps,
    address: (process.env.LM_SELL_FEE_ADDRESS ?? "").trim(),
    // A set-but-malformed pin is kept as-is: it then matches no destination,
    // so the fee fails closed instead of silently dropping the check.
    payeePubkey: pin.length > 0 ? pin : null,
  };
}

/** True when a fee is configured (rate > 0 and a destination is set). */
export function saleFeeEnabled(): boolean {
  const { bps, address } = saleFeeConfig();
  return bps > 0 && address.length > 0;
}

/** The fee owed on a sale: `bps` of what was actually earned, rounded down. */
export function feeForSale(earnedSats: number, bps: number): number {
  if (!Number.isFinite(earnedSats) || earnedSats <= 0 || bps <= 0) return 0;
  return Math.floor((earnedSats * bps) / 10_000);
}

/** Defence in depth: 1% of a realistic lease fee is far below this. Anything
 *  above it means the "earned" figure itself is wrong — never pay that blind. */
export const MAX_FEE_PER_SALE_SATS = 50_000;

// ── LNURL-pay (LUD-06 / LUD-16) ───────────────────────────────────────────────

export type FeeInvoiceErrorCode =
  | "lnurl"
  | "callback_refused"
  | "amount_mismatch"
  | "payee_mismatch"
  | "expired";

/** Refusals that mean the fee server (or its DNS/TLS) misbehaved — worth an
 *  alert even while the ledger keeps retrying. */
const SECURITY_REFUSALS: ReadonlySet<string> = new Set(["callback_refused", "amount_mismatch", "payee_mismatch"]);

export class FeeInvoiceError extends Error {
  constructor(
    readonly code: FeeInvoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FeeInvoiceError";
  }
}

interface LnurlPayMeta {
  tag?: unknown;
  callback?: unknown;
  minSendable?: unknown;
  maxSendable?: unknown;
  status?: unknown;
  reason?: unknown;
}

/**
 * Resolve a Lightning Address to a BOLT11 invoice for `sats`. The callback must
 * be https on the address's own host — the address is our only trust anchor,
 * so a metadata response pointing elsewhere is refused.
 */
export async function fetchFeeInvoice(address: string, sats: number): Promise<string> {
  const at = address.lastIndexOf("@");
  const name = at > 0 ? address.slice(0, at) : "";
  const domain = at > 0 ? address.slice(at + 1).toLowerCase() : "";
  if (!name || !domain) throw new FeeInvoiceError("lnurl", `invalid fee address "${address}"`);

  const metaRes = await httpRequest(
    `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`,
    { headers: { Accept: "application/json" } },
    HTTP_TIMEOUTS.lnurlMs,
  );
  if (!metaRes.ok) throw new FeeInvoiceError("lnurl", `fee address lookup failed (HTTP ${metaRes.status})`);
  const meta = await metaRes.json<LnurlPayMeta>();
  if (meta.status === "ERROR") throw new FeeInvoiceError("lnurl", `fee server error: ${String(meta.reason ?? "")}`);
  if (meta.tag !== "payRequest" || typeof meta.callback !== "string") {
    throw new FeeInvoiceError("lnurl", "fee address is not an LNURL-pay endpoint");
  }
  let callback: URL;
  try {
    callback = new URL(meta.callback);
  } catch {
    throw new FeeInvoiceError("lnurl", "fee server returned an invalid callback URL");
  }
  if (callback.protocol !== "https:" || callback.hostname.toLowerCase() !== new URL(`https://${domain}`).hostname) {
    throw new FeeInvoiceError(
      "callback_refused",
      `fee server callback ${callback.protocol}//${callback.host} is not https on ${domain} — refused`,
    );
  }
  const msat = sats * 1000;
  const min = Number(meta.minSendable ?? 0);
  const max = Number(meta.maxSendable ?? Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(min) || !Number.isFinite(max) || msat < min || msat > max) {
    throw new FeeInvoiceError("lnurl", `fee of ${sats} sat is outside the fee server's limits`);
  }
  callback.searchParams.set("amount", String(msat));
  const cbRes = await httpRequest(callback.toString(), { headers: { Accept: "application/json" } }, HTTP_TIMEOUTS.lnurlMs);
  if (!cbRes.ok) throw new FeeInvoiceError("lnurl", `fee invoice request failed (HTTP ${cbRes.status})`);
  const cb = await cbRes.json<{ pr?: unknown; status?: unknown; reason?: unknown }>();
  if (cb.status === "ERROR") throw new FeeInvoiceError("lnurl", `fee server error: ${String(cb.reason ?? "")}`);
  if (typeof cb.pr !== "string" || !cb.pr) throw new FeeInvoiceError("lnurl", "fee server returned no invoice");
  return cb.pr;
}

// ── verification (pure) ───────────────────────────────────────────────────────

export interface DecodedFeeInvoice {
  id: string;
  destination: string;
  /** Requested millisatoshis as LND decoded them ("0" = amountless). */
  mtokens: string;
  expiresAt: string;
}

export type FeeInvoiceVerdict = "ok" | "self" | "amount_mismatch" | "payee_mismatch" | "expired";

/** The pre-payment check. Anything but "ok" means: do not pay this invoice. */
export function checkFeeInvoice(
  d: DecodedFeeInvoice,
  expect: { sats: number; ownPubkey: string; payeePubkey: string | null; now?: number },
): FeeInvoiceVerdict {
  let requested: bigint;
  try {
    requested = BigInt(d.mtokens);
  } catch {
    return "amount_mismatch";
  }
  if (requested !== BigInt(expect.sats) * 1000n) return "amount_mismatch";
  if (Date.parse(d.expiresAt) <= (expect.now ?? Date.now())) return "expired";
  if (d.destination === expect.ownPubkey) return "self";
  if (expect.payeePubkey && d.destination.toLowerCase() !== expect.payeePubkey) return "payee_mismatch";
  return "ok";
}

// ── lightning port ────────────────────────────────────────────────────────────

export type FeePaymentStatus =
  | { state: "confirmed"; deliveredSats: number; routingFeeSats: number }
  | { state: "failed" | "pending" | "unknown" };

/** The node operations the ledger needs — a seam, so tests can drive a fake node. */
export interface FeeLightning {
  ownPubkey(): Promise<string>;
  decode(request: string): Promise<DecodedFeeInvoice>;
  pay(request: string, maxRoutingFeeSats: number): Promise<{ confirmed: boolean; deliveredSats: number; routingFeeSats: number }>;
  paymentStatus(id: string): Promise<FeePaymentStatus>;
}

export function lndFeeLightning(lnd: AuthenticatedLnd): FeeLightning {
  return {
    ownPubkey: async () => (await getWalletInfo({ lnd })).public_key,
    decode: async (request) => {
      const d = await decodePaymentRequest({ lnd, request });
      return { id: d.id, destination: d.destination, mtokens: d.mtokens ?? "0", expiresAt: d.expires_at };
    },
    pay: async (request, maxRoutingFeeSats) => {
      // Never pass `tokens`: the invoice carries its own (already verified)
      // amount, and LND refuses an explicit amount for an amounted invoice.
      const r = await pay({ lnd, request, max_fee: maxRoutingFeeSats, pathfinding_timeout: 30_000 });
      return { confirmed: r.is_confirmed, deliveredSats: r.tokens - r.fee, routingFeeSats: r.fee };
    },
    paymentStatus: async (id) => {
      try {
        const s = await getPayment({ lnd, id });
        if (s.is_confirmed && s.payment) {
          return { state: "confirmed", deliveredSats: s.payment.tokens - s.payment.fee, routingFeeSats: s.payment.fee };
        }
        return { state: s.is_failed ? "failed" : "pending" };
      } catch (err) {
        // 404 SentPaymentNotFound: LND never saw it (we stopped before sending).
        if (Array.isArray(err) && err[0] === 404) return { state: "unknown" };
        throw err;
      }
    },
  };
}

// ── the ledger ────────────────────────────────────────────────────────────────

export type FeeEntryState =
  /** Owed; next attempt at nextAttemptAt (preceded by asking LND how the
   *  previous payment ended, while paymentHash is set). */
  | "pending"
  /** A payment was sent and LND last reported it in flight (or we stopped
   *  waiting for it): it may still land, so never start another one. */
  | "inflight"
  | "paid"
  /** Nothing to pay (fee address is this node, or the fee was switched off). */
  | "skipped"
  /** Gave up — needs a human. Surfaced as an alert. */
  | "failed";

export interface ServiceFeeEntry {
  /** `${source}:${orderId}` — one fee per sale, ever. */
  key: string;
  source: "magma" | "lsps1";
  orderId: string;
  earnedSats: number;
  bps: number;
  feeSats: number;
  createdAt: string;
  state: FeeEntryState;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  /** Machine-readable cause of the last failure (FeeInvoiceErrorCode, …). */
  lastErrorCode?: string;
  /** Write-ahead record of the last payment sent, kept until LND confirms how
   *  it ended — the guard against ever paying the same fee twice. */
  paymentHash?: string;
  paidAt?: string;
  /** Amount that reached the fee address (excludes routing). */
  paidSats?: number;
  routingFeeSats?: number;
  /** The problem the operator dismissed the alert for: the entry's state and
   *  cause at that moment (see problemOf). A later, different problem — the
   *  fee given up after a refusal that was dismissed, or another kind of
   *  refusal — raises the alert again. */
  acknowledgedProblem?: string;
}

/** What an entry's alert is about. Dismissing it silences this problem only. */
const problemOf = (e: ServiceFeeEntry): string => `${e.state}:${e.lastErrorCode ?? ""}`;

/** Retry backoff after a failed attempt (index = attempts so far − 1). */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];
const LAST_RETRY_DELAY_MS = 24 * 3_600_000;
/** With the delays above, ≈ 3 days of trying before a human is asked to look. */
export const MAX_FEE_ATTEMPTS = 10;
/** How often an in-flight payment's final state is re-checked. */
const INFLIGHT_RECHECK_MS = 5 * 60_000;
const ENTRIES_KEPT = 500;

const retryDelay = (attempts: number): number =>
  RETRY_DELAYS_MS[Math.max(0, attempts - 1)] ?? LAST_RETRY_DELAY_MS;
const errMessage = (err: unknown): string => {
  if (Array.isArray(err)) return String(err[1] ?? err[0]);
  return err instanceof Error ? err.message : String(err);
};
const PAY_TIMED_OUT = Symbol("pay-timeout");

export interface ServiceFeeLedgerOptions {
  /** Hard ceiling on one payment attempt before we stop waiting (not paying). */
  payTimeoutMs?: number;
  /** Background loop cadence. */
  tickMs?: number;
  now?: () => number;
}

export class ServiceFeeLedger {
  private readonly store: JsonStore<ServiceFeeEntry[]>;
  private list: ServiceFeeEntry[];
  private timer: NodeJS.Timeout | undefined;
  /** The pass in progress, if any — passes never overlap. */
  private current: Promise<void> | null = null;
  private rerun = false;
  /** Set by stop(): no new payment starts (shutdown). Enqueued fees wait for
   *  the next start — they are on disk. */
  private stopped = false;
  private readonly payTimeoutMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;

  constructor(
    dataDir: string,
    /** null in read-only mode: nothing can be sold, so nothing is paid. */
    private readonly ln: FeeLightning | null,
    opts: ServiceFeeLedgerOptions = {},
  ) {
    this.store = new JsonStore<ServiceFeeEntry[]>(dataDir, "service-fees.json");
    this.list = this.store.read([]);
    this.payTimeoutMs = opts.payTimeoutMs ?? 60_000;
    this.tickMs = opts.tickMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    if (this.timer || !this.ln) return;
    this.timer = setInterval(() => void this.processDue(), this.tickMs);
    this.timer.unref?.();
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Process due entries soon, without the caller waiting for it. */
  kick(): void {
    if (!this.ln || this.stopped) return;
    setImmediate(() => void this.processDue());
  }

  /**
   * Record that a sale completed and its fee is owed. Idempotent per sale
   * (source + orderId), so a retried or duplicated completion can never be
   * charged twice. Returns null when no fee applies. Never pays inline.
   */
  enqueue(sale: { source: "magma" | "lsps1"; orderId: string; earnedSats: number }): ServiceFeeEntry | null {
    const key = `${sale.source}:${sale.orderId}`;
    const existing = this.list.find((e) => e.key === key);
    if (existing) return existing;
    const { bps, address } = saleFeeConfig();
    if (bps <= 0 || !address) return null;
    const feeSats = feeForSale(sale.earnedSats, bps);
    if (feeSats < 1) return null;
    const at = new Date(this.now()).toISOString();
    const entry: ServiceFeeEntry = {
      key,
      source: sale.source,
      orderId: sale.orderId,
      earnedSats: sale.earnedSats,
      bps,
      feeSats,
      createdAt: at,
      state: "pending",
      attempts: 0,
      nextAttemptAt: at,
    };
    if (feeSats > MAX_FEE_PER_SALE_SATS) {
      entry.state = "failed";
      entry.lastError = `${feeSats} sat is above the ${MAX_FEE_PER_SALE_SATS} sat per-sale ceiling — not paid automatically`;
      console.error(`[fee] ${key}: ${entry.lastError}`);
    }
    this.list.unshift(entry);
    this.save();
    this.kick();
    return entry;
  }

  entries(): ServiceFeeEntry[] {
    return this.list.map((e) => ({ ...e }));
  }

  /** Sats that reached the fee address for one sale, if paid. */
  paidFor(source: "magma" | "lsps1", orderId: string): number | undefined {
    const e = this.list.find((x) => x.key === `${source}:${orderId}`);
    return e?.state === "paid" ? e.paidSats : undefined;
  }

  /** Paid fees since a time — what P&L counts as service-fee cost. */
  paidSince(sinceMs: number): { at: string; paidSats: number; routingFeeSats: number }[] {
    return this.list
      .filter((e) => e.state === "paid" && e.paidAt && Date.parse(e.paidAt) >= sinceMs)
      .map((e) => ({ at: e.paidAt as string, paidSats: e.paidSats ?? 0, routingFeeSats: e.routingFeeSats ?? 0 }));
  }

  /** Entries a human should look at: given up, or refused for a security
   *  reason (wrong amount / wrong payee) even while still retrying — unless
   *  the operator already dismissed that very problem. */
  problems(): ServiceFeeEntry[] {
    return this.list.filter(
      (e) =>
        (e.state === "failed" || (e.state === "pending" && SECURITY_REFUSALS.has(e.lastErrorCode ?? ""))) &&
        e.acknowledgedProblem !== problemOf(e),
    );
  }

  /** The operator has seen this entry's alert. Only the problem shown is
   *  silenced: dismissing a refused invoice must not also hide that the fee
   *  was given up later, which SECURITY.md promises to alert. */
  acknowledge(key: string): boolean {
    const e = this.list.find((x) => x.key === key);
    if (!e) return false;
    e.acknowledgedProblem = problemOf(e);
    this.save();
    return true;
  }

  /**
   * Work through the due entries, one at a time. Passes never overlap: a call
   * made while one runs asks it to go round once more and returns the same
   * promise, so `await processDue()` always means "everything due is handled".
   */
  processDue(): Promise<void> {
    const ln = this.ln;
    if (!ln) return Promise.resolve();
    if (this.current) {
      this.rerun = true;
      return this.current;
    }
    this.current = (async () => {
      do {
        this.rerun = false;
        const due = this.list.filter(
          (e) => (e.state === "pending" || e.state === "inflight") && Date.parse(e.nextAttemptAt) <= this.now(),
        );
        for (const e of due) {
          if (this.stopped) break;
          try {
            await this.processEntry(e, ln);
          } catch (err) {
            // processEntry handles its own failures; this is a last guard so
            // one odd entry can never stop the others or crash the process.
            console.error(`[fee] ${e.key}: unexpected error: ${errMessage(err)}`);
          }
        }
      } while (this.rerun);
    })().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  private async processEntry(e: ServiceFeeEntry, ln: FeeLightning): Promise<void> {
    // 1. A payment sent earlier may still land: learn its outcome before doing
    //    anything else, so we never pay the same fee twice.
    if (e.paymentHash) {
      let status: FeePaymentStatus;
      try {
        status = await ln.paymentStatus(e.paymentHash);
      } catch (err) {
        // LND can't tell us right now. Never pay while that payment's fate is
        // unknown — ask again later rather than every tick.
        console.warn(`[fee] ${e.key}: could not check the earlier payment (${errMessage(err)}) — will ask again`);
        e.nextAttemptAt = new Date(this.now() + INFLIGHT_RECHECK_MS).toISOString();
        this.save();
        return;
      }
      if (status.state === "confirmed") {
        this.markPaid(e, status.deliveredSats, status.routingFeeSats);
        return;
      }
      if (status.state === "pending") {
        e.state = "inflight";
        e.nextAttemptAt = new Date(this.now() + INFLIGHT_RECHECK_MS).toISOString();
        this.save();
        return;
      }
      // Failed for good, or never reached LND: the hash has done its job.
      e.paymentHash = undefined;
      e.state = "pending";
      if (e.lastErrorCode === "inflight") {
        // We had stopped waiting for it; now we know how it ended.
        e.lastError = status.state === "failed" ? "the payment failed" : "the payment never reached LND";
        e.lastErrorCode = "error";
      }
      // The give-up check lives here because a failed payment keeps its hash
      // until LND confirms the failure — retryLater can't give up on it.
      if (e.attempts >= MAX_FEE_ATTEMPTS) {
        this.finish(e, "failed", `${e.lastError ?? "the payment did not go through"} (gave up after ${e.attempts} attempts)`);
        return;
      }
    }

    const cfg = saleFeeConfig();
    if (cfg.bps <= 0 || !cfg.address) {
      this.finish(e, "skipped", "service fee switched off");
      return;
    }

    // 2. A fresh invoice that passes every check, or no payment at all.
    e.attempts += 1;
    let request: string;
    let decoded: DecodedFeeInvoice;
    try {
      request = await fetchFeeInvoice(cfg.address, e.feeSats);
      decoded = await ln.decode(request);
      const verdict = checkFeeInvoice(decoded, {
        sats: e.feeSats,
        ownPubkey: await ln.ownPubkey(),
        payeePubkey: cfg.payeePubkey,
        now: this.now(),
      });
      if (verdict === "self") {
        // The developer's own node selling: there is nobody to pay.
        this.finish(e, "skipped", "fee address belongs to this node");
        return;
      }
      if (verdict === "amount_mismatch") {
        throw new FeeInvoiceError(
          "amount_mismatch",
          `fee server returned an invoice for ${decoded.mtokens} msat instead of ${e.feeSats * 1000} msat — refused`,
        );
      }
      if (verdict === "payee_mismatch") {
        throw new FeeInvoiceError(
          "payee_mismatch",
          `fee invoice pays ${decoded.destination.slice(0, 16)}…, not LM_SELL_FEE_PUBKEY — refused`,
        );
      }
      if (verdict === "expired") throw new FeeInvoiceError("expired", "fee server returned an expired invoice");
    } catch (err) {
      this.retryLater(e, err);
      return;
    }

    // Fetching and checking the invoice can take half a minute. A shutdown that
    // arrived meanwhile means: send nothing. The fee waits on disk, and this
    // round doesn't count against the fee server.
    if (this.stopped) {
      e.attempts -= 1;
      return;
    }

    // 3. Write-ahead: record the payment BEFORE sending it. If that record
    //    can't be saved, don't pay — after a restart we couldn't tell whether
    //    it went out, and might pay again.
    e.paymentHash = decoded.id;
    e.state = "inflight";
    try {
      this.store.writeOrThrow(this.list);
    } catch (err) {
      e.paymentHash = undefined;
      e.state = "pending";
      this.retryLater(e, new Error(`could not record the payment before sending it: ${errMessage(err)}`));
      return;
    }

    // 4. Pay — but stop WAITING after payTimeoutMs. The HTLC may still settle;
    //    the recorded hash makes the next pass check instead of re-paying.
    const maxRoutingFee = Math.max(5, Math.ceil(e.feeSats * 0.1));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<typeof PAY_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(PAY_TIMED_OUT), this.payTimeoutMs);
    });
    try {
      const outcome = await Promise.race([ln.pay(request, maxRoutingFee), timeout]);
      if (outcome === PAY_TIMED_OUT) {
        e.nextAttemptAt = new Date(this.now() + INFLIGHT_RECHECK_MS).toISOString();
        e.lastError = `payment still in flight after ${Math.round(this.payTimeoutMs / 1000)}s — will check its outcome`;
        e.lastErrorCode = "inflight";
        console.warn(`[fee] ${e.key}: ${e.lastError}`);
        this.save();
        return;
      }
      if (outcome.confirmed) {
        this.markPaid(e, outcome.deliveredSats, outcome.routingFeeSats);
        return;
      }
      this.retryLater(e, new Error("payment not confirmed"));
    } catch (err) {
      // pay() rejects on a definitive failure (no route, …). The hash stays:
      // the next pass confirms the failure with LND before trying again.
      this.retryLater(e, new Error(`payment failed: ${errMessage(err)}`));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private markPaid(e: ServiceFeeEntry, deliveredSats: number, routingFeeSats: number): void {
    e.state = "paid";
    e.paidAt = new Date(this.now()).toISOString();
    e.paidSats = deliveredSats;
    e.routingFeeSats = routingFeeSats;
    e.lastError = undefined;
    e.lastErrorCode = undefined;
    this.save();
    console.log(`[fee] ${e.key}: paid ${deliveredSats} sat service fee (+${routingFeeSats} sat routing)`);
  }

  private retryLater(e: ServiceFeeEntry, err: unknown): void {
    e.lastError = errMessage(err);
    e.lastErrorCode = err instanceof FeeInvoiceError ? err.code : "error";
    // A payment LND may still know about is never given up on here: its
    // outcome must be learned first (step 1 of the next pass asks LND, and
    // gives up there once the last attempt is confirmed failed).
    if (!e.paymentHash && e.attempts >= MAX_FEE_ATTEMPTS) {
      this.finish(e, "failed", `${e.lastError} (gave up after ${e.attempts} attempts)`);
      return;
    }
    // Nothing is known to be in flight — a kept hash is only there for that
    // status check — so this is "pending", not "inflight".
    e.state = "pending";
    // After the last attempt only the confirmation is left: ask soon, so the
    // give-up (and its alert) comes within minutes instead of a day later.
    const lastAttempt = e.paymentHash !== undefined && e.attempts >= MAX_FEE_ATTEMPTS;
    e.nextAttemptAt = new Date(this.now() + (lastAttempt ? INFLIGHT_RECHECK_MS : retryDelay(e.attempts))).toISOString();
    const log = SECURITY_REFUSALS.has(e.lastErrorCode) ? console.error : console.warn;
    log(`[fee] ${e.key}: attempt ${e.attempts} failed — ${e.lastError}; next try ${e.nextAttemptAt}`);
    this.save();
  }

  private finish(e: ServiceFeeEntry, state: "skipped" | "failed", reason: string): void {
    e.state = state;
    e.lastError = reason;
    this.save();
    const log = state === "failed" ? console.error : console.log;
    log(`[fee] ${e.key}: ${state} — ${reason}`);
  }

  private save(): void {
    // Keep every unresolved entry; trim only settled history.
    if (this.list.length > ENTRIES_KEPT) {
      const open = this.list.filter((e) => e.state === "pending" || e.state === "inflight");
      const done = this.list.filter((e) => e.state !== "pending" && e.state !== "inflight");
      this.list = [...open, ...done.slice(0, Math.max(0, ENTRIES_KEPT - open.length))];
    }
    this.store.write(this.list);
  }
}
