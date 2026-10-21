import {
  createChainAddress,
  getChainBalance,
  getChainFeeEstimate,
  getChainFeeRate,
  getChainTransactions,
  getPendingChainBalance,
  getUtxos,
  sendToChainAddress,
  type AuthenticatedLnd,
} from "lightning";
import {
  anchorReserveFor,
  promisedSpendFrom,
  reserveFor,
  reserveInputs,
  type CapitalLedger,
  type PromisedSpendRefusal,
  type ReserveInputs,
} from "./capital.js";

/**
 * On-chain wallet: balance, UTXOs, receive address, send, history. Generating an
 * address and sending require a write macaroon (onchain:write); reads don't.
 */

export interface OnchainState {
  confirmedSats: number;
  pendingSats: number;
  utxos: {
    outpoint: string;
    address: string;
    tokens: number;
    confirmations: number;
  }[];
  /** Suggested fee rate (sat/vByte) for ~3-block confirmation, or null. */
  suggestedFeeRate: number | null;
}

export async function getOnchainState(lnd: AuthenticatedLnd): Promise<OnchainState> {
  const [bal, pending, utxos, fee] = await Promise.all([
    getChainBalance({ lnd }),
    getPendingChainBalance({ lnd }),
    getUtxos({ lnd }),
    getChainFeeRate({ lnd, confirmation_target: 3 }).catch(() => null),
  ]);

  return {
    confirmedSats: bal.chain_balance,
    pendingSats: pending.pending_chain_balance,
    utxos: utxos.utxos
      .map((u) => ({
        outpoint: `${u.transaction_id}:${u.transaction_vout}`,
        address: u.address,
        tokens: u.tokens,
        confirmations: u.confirmation_count ?? 0,
      }))
      .sort((a, b) => b.tokens - a.tokens),
    suggestedFeeRate: fee ? Math.max(1, Math.round(fee.tokens_per_vbyte)) : null,
  };
}

export interface FeeEstimates {
  /** ~next block (sat/vByte): LND's 1-block rate — its 2-block rate on an
   *  LND that won't estimate for one block (see `fastTarget`). */
  fast: number | null;
  /** The confirmation target `fast` is LND's rate for: 1, or 2. */
  fastTarget: 1 | 2 | null;
  /** ~30 min. */
  normal: number | null;
  /** ~hours — cheapest sensible. */
  economy: number | null;
}

/** Current mempool fee rates for a few confirmation targets (the close and
 *  open dialogs, and the on-chain send's rate check). */
export async function getFeeEstimates(lnd: AuthenticatedLnd): Promise<FeeEstimates> {
  const [fast, normal, economy] = await Promise.all([
    nextBlockRate(lnd),
    getChainFeeRate({ lnd, confirmation_target: 3 }).catch(() => null),
    getChainFeeRate({ lnd, confirmation_target: 36 }).catch(() => null),
  ]);
  const r = (f: { tokens_per_vbyte: number } | null) =>
    f ? Math.max(1, Math.round(f.tokens_per_vbyte)) : null;
  return { fast: r(fast?.rate ?? null), fastTarget: fast?.target ?? null, normal: r(normal), economy: r(economy) };
}

/**
 * LND's rate for the next block. LND before 0.20 refuses a 1-block target
 * outright ("confirmation target must be greater than 1"); its 2-block rate
 * is then the nearest it gives — and what bitcoind answers for one block
 * anyway. Before, that refusal left `fast` empty on those versions: the
 * close dialog had no "fast" rate, and the send's check of a rate far above
 * the next block's never ran (200 sat/vB typed for 20 went out unasked).
 */
async function nextBlockRate(lnd: AuthenticatedLnd): Promise<{ rate: { tokens_per_vbyte: number }; target: 1 | 2 } | null> {
  try {
    return { rate: await getChainFeeRate({ lnd, confirmation_target: 1 }), target: 1 };
  } catch {
    const two = await getChainFeeRate({ lnd, confirmation_target: 2 }).catch(() => null);
    return two ? { rate: two, target: 2 } : null;
  }
}

/** How a send's rate check names the rate it compares with. */
const fastRateName = (e: FeeEstimates): string =>
  e.fastTarget === 2 ? `LND's 2-block rate (${e.fast} sat/vB)` : `what LND estimates for the next block (${e.fast} sat/vB)`;

export interface OnchainTx {
  id: string;
  amountSats: number; // signed: negative for sends
  feeSats: number;
  confirmations: number;
  isConfirmed: boolean;
  isOutgoing: boolean;
  createdAt: string;
}

export async function getOnchainTxs(lnd: AuthenticatedLnd, limit = 25): Promise<OnchainTx[]> {
  const { transactions } = await getChainTransactions({ lnd });
  return transactions
    .map((t) => {
      const value = t.tokens ?? 0;
      return {
        id: t.id,
        amountSats: t.is_outgoing ? -Math.abs(value) : Math.abs(value),
        feeSats: t.fee ?? 0,
        confirmations: t.confirmation_count ?? 0,
        isConfirmed: t.is_confirmed,
        isOutgoing: t.is_outgoing,
        createdAt: t.created_at,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export interface NewAddress {
  address: string;
}

export async function newAddress(lnd: AuthenticatedLnd): Promise<NewAddress> {
  // p2wpkh (bc1q…) — widely compatible across senders.
  const { address } = await createChainAddress({ lnd, format: "p2wpkh" });
  return { address };
}

export interface SendResult {
  ok: boolean;
  transactionId: string;
}

/** Send `tokens` — or, `sendAll`, every confirmed coin LND may spend (it
 *  keeps its anchor reserve back as change) — at `feeRate` sat/vB. */
export async function sendOnchain(
  lnd: AuthenticatedLnd,
  opts: { address: string; tokens?: number; feeRate: number; sendAll?: boolean },
): Promise<SendResult> {
  const res = opts.sendAll
    ? await sendToChainAddress({ lnd, address: opts.address, is_send_all: true, fee_tokens_per_vbyte: opts.feeRate })
    : await sendToChainAddress({ lnd, address: opts.address, tokens: opts.tokens ?? 0, fee_tokens_per_vbyte: opts.feeRate });
  return { ok: res.is_confirmed || !!res.id, transactionId: res.id };
}

// ── what a send costs and leaves (review a4-lsp-payments:onchain-send-guardrails) ──
//
// Before, the confirm said only "Send N sat to … at R sat/vByte": no fee in
// sats, no comparison with what the next block takes (200 typed for 20 is
// ~28k sat on a typical send, after one generic confirm), nothing about the
// coins the node keeps for anchor fee bumps and its own channel sales, and
// no way to send the most it can spare. Now a preview — the same one the
// send itself checks again, inside the on-chain mutex — gives the fee in
// sats, what stays, and what needs a second yes.

/** A fee rate above this multiple of LND's next-block estimate needs a second yes. */
export const SEND_RATE_FACTOR = 3;
/** A fee above this share of the amount needs a second yes. */
export const SEND_FEE_SHARE = 0.02;
/** The smallest output LND sends (dust). */
export const MIN_SEND_SATS = 546;
/** A typical send when LND can't estimate one: a P2WPKH input, the output and change. */
const TYPICAL_SEND_VBYTES = 141;
const TX_OVERHEAD_VBYTES = 10.5;
const INPUT_VBYTES: Record<string, number> = { p2wpkh: 68, np2wpkh: 91, p2tr: 57.5 };
/** The change output LND adds (a taproot one). */
const CHANGE_VBYTES = 43;

/** The size of an output paying `address`, vbytes. */
export function outputVbytes(address: string): number {
  const a = address.trim();
  if (/^(bc1q|tb1q|bcrt1q)/i.test(a)) return a.length > 50 ? 43 : 31; // P2WSH : P2WPKH
  if (/^(bc1p|tb1p|bcrt1p)/i.test(a)) return 43; // P2TR
  return /^[32]/.test(a) ? 32 : 34; // P2SH : P2PKH
}

export type SendCheckCode = "fee_rate_high" | "fee_share_high" | "below_reserve";

/** Something about a send the operator must confirm a second time. */
export interface SendCheck {
  code: SendCheckCode;
  message: string;
}

export interface SendRequest {
  address: string;
  feeRate: number;
  /** One of: an amount, the most that can go while the reserve and the
   *  promised coins stay (`max`), or every coin (`sendAll`). */
  tokens?: number;
  max?: boolean;
  sendAll?: boolean;
}

export interface SendPreview {
  mode: "amount" | "max" | "all";
  address: string;
  /** What the address receives (estimated for "all"). */
  amountSats: number;
  feeRate: number;
  vbytes: number;
  /** The transaction's fee at `feeRate`. */
  feeSats: number;
  /** The size is this app's estimate from the wallet's coins, not LND's. */
  feeApprox: boolean;
  /** LND's own estimates (sat/vB), to compare the rate with. */
  estimates: FeeEstimates;
  confirmedSats: number;
  /** The on-chain reserve: the larger of the reserve setting and LND's
   *  anchor reserve (D5), plus the funding fees of promised opens. */
  reserveSats: number;
  /** Coins promised to buyers whose channels aren't open yet (Magma, LSPS1). */
  promisedSats: number;
  /** The most this send could be while the reserve and the promised coins stay. */
  availableSats: number;
  /** On-chain after the send. */
  remainingSats: number;
  /** The send takes coins promised to buyers: the send asks for that yes on
   *  its own, naming the orders (409 capital_promised). */
  touchesPromised: boolean;
  checks: SendCheck[];
  /** Why this send can't be made (then nothing is sent). */
  error?: string;
}

const sat = (n: number) => Math.round(n).toLocaleString("en-US");

/** The confirmation target both of LND's reads for a send's size use: the
 *  fee it estimates and the exact rate behind it must be the same estimate. */
const SIZE_TARGET = 6;

/** LND's size of a send of `tokens` to `address` (vbytes) — or this app's
 *  estimate from the wallet's coins when LND can't give one. */
async function sendVbytes(lnd: AuthenticatedLnd, address: string, tokens: number, utxoVbytes: () => Promise<number>): Promise<{ vbytes: number; approx: boolean }> {
  try {
    const [est, rate] = await Promise.all([
      getChainFeeEstimate({ lnd, send_to: [{ address, tokens }], target_confirmations: SIZE_TARGET }),
      getChainFeeRate({ lnd, confirmation_target: SIZE_TARGET }).catch(() => null),
    ]);
    const vbytes = lndSendSize(est.fee, est.tokens_per_vbyte, rate?.tokens_per_vbyte ?? null);
    if (vbytes !== null) return { vbytes, approx: false };
  } catch {
    // LND can't build it (not enough coins) or doesn't estimate: below
  }
  // No size from LND — nor one its two reads agree on: the size from the
  // wallet's coins, said to be an estimate.
  return { vbytes: await utxoVbytes(), approx: true };
}

/**
 * The size, in vbytes, of the send LND estimated a fee for. LND computes
 * that fee at its exact rate — fee = ⌊rate × size⌋, the rate in sat/kw — but
 * reports the rate itself in whole sat/vB, cut down (lnrpc EstimateFee:
 * SatPerVbyte = FeePerVByte(), an integer). Divided by that, the size came
 * out up to twice too large at the low rates of a quiet mempool: 280 sat at
 * 1.99 sat/vB is 141 vbytes, not 280 — and the preview overstated the fee by
 * as much, held back too much from "Max" and asked about the fee's share
 * too early. walletrpc names the exact rate for the same target (sat/kw):
 * divided by that, the fee gives the size — rounded up to a whole vbyte, as
 * the fee was rounded down. Null when there is no exact rate, or the two
 * clearly disagree (the estimate moved between the two reads): the exact
 * rate cut down must be the whole one LND reported with the fee.
 */
export function lndSendSize(feeSat: number, wholeRate: number, exactRate: number | null): number | null {
  if (!(feeSat > 0) || exactRate === null || !(exactRate > 0)) return null;
  if (Math.floor(exactRate) !== wholeRate) return null;
  return Math.ceil(feeSat / exactRate - 1e-9);
}

/** What the node keeps on-chain whatever is sent: the reserve as every open
 *  checks it (D5) — without a fee for the send itself, counted on its own —
 *  and the coins promised to buyers. */
function kept(inputs: ReserveInputs, userReserveSat: number, ledger: CapitalLedger) {
  const pending = ledger.pending();
  const promisedSats = pending.reduce((s, r) => s + Math.max(0, r.sats), 0);
  const reserve = reserveFor(inputs, userReserveSat, pending, false);
  const reserveSats = Math.max(0, reserve.totalSat - inputs.fundingFeeSat);
  return { pending, reserve, reserveSats, promisedSats, keepSats: reserveSats + promisedSats };
}

/**
 * What the wallet can spare now, as the wallet page shows it: what "Max"
 * fills in at the rate the send form starts with (LND's 3-block estimate,
 * the page's suggested rate) for a typical send — one input, the output and
 * change. Before, the page took a funding-fee estimate for the send's fee
 * instead, and said a different figure than Max then filled in. A given
 * send's exact figures are its preview's.
 */
export async function sendBudget(
  lnd: AuthenticatedLnd,
  ledger: CapitalLedger,
  userReserveSat: number,
): Promise<{ reserveSats: number; promisedSats: number; availableSats: number; feeRate: number | null }> {
  const [{ chain_balance: confirmed }, inputs, rate] = await Promise.all([
    getChainBalance({ lnd }),
    reserveInputs(lnd),
    getChainFeeRate({ lnd, confirmation_target: 3 }).catch(() => null),
  ]);
  const k = kept(inputs, userReserveSat, ledger);
  const feeRate = rate ? Math.max(1, Math.round(rate.tokens_per_vbyte)) : null;
  const fee = feeRate !== null ? Math.ceil(TYPICAL_SEND_VBYTES * feeRate) : inputs.fundingFeeSat;
  return { reserveSats: k.reserveSats, promisedSats: k.promisedSats, availableSats: Math.max(0, confirmed - k.keepSats - fee), feeRate };
}

/** The preview of a send (previewSend), and — when it takes coins promised
 *  to buyers — the refusal the send answers with unless the operator
 *  confirmed spending them (409 capital_promised, naming the orders). Both
 *  from one read of LND, with the send's own fee: the preview's
 *  `touchesPromised` is exactly whether the send is refused. */
export interface SendPlan {
  preview: SendPreview;
  promised: PromisedSpendRefusal | null;
}

/**
 * What a send would cost and leave — and what in it needs a second yes:
 *  - a fee rate above SEND_RATE_FACTOR × LND's next-block estimate;
 *  - a fee above SEND_FEE_SHARE of the amount;
 *  - less left than the on-chain reserve (D5), once the channels promised
 *    to buyers are opened.
 * Coins promised to buyers have their own yes at the send, naming the
 * orders (capital.ts promisedSpendFrom); the preview says whether the send
 * touches them (and then doesn't ask about the reserve on top).
 * `userReserveSat`: the operator's reserve setting.
 */
export async function previewSend(lnd: AuthenticatedLnd, ledger: CapitalLedger, userReserveSat: number, req: SendRequest): Promise<SendPreview> {
  return (await planSend(lnd, ledger, userReserveSat, req)).preview;
}

/** previewSend, with the promised-coins refusal the send itself applies. */
export async function planSend(lnd: AuthenticatedLnd, ledger: CapitalLedger, userReserveSat: number, req: SendRequest): Promise<SendPlan> {
  const [{ chain_balance: confirmed }, inputs, estimates] = await Promise.all([getChainBalance({ lnd }), reserveInputs(lnd), getFeeEstimates(lnd)]);
  const { pending, reserve: r, reserveSats, promisedSats, keepSats: keep } = kept(inputs, userReserveSat, ledger);
  // All confirmed coins in one transaction: the size of a sweep (or of the
  // largest send), from the wallet's coins.
  let utxoSize: number | null = null;
  const utxoVbytes = async (outputs: number): Promise<number> => {
    if (utxoSize === null) {
      try {
        const { utxos } = await getUtxos({ lnd, min_confirmations: 1 });
        const ins = utxos.reduce((s, u) => s + (INPUT_VBYTES[u.address_format] ?? INPUT_VBYTES.p2wpkh), 0);
        utxoSize = TX_OVERHEAD_VBYTES + (ins > 0 ? ins : INPUT_VBYTES.p2wpkh);
      } catch {
        utxoSize = TX_OVERHEAD_VBYTES + INPUT_VBYTES.p2wpkh; // LND can't list them: one input
      }
    }
    return utxoSize + outputVbytes(req.address) + (outputs > 1 ? CHANGE_VBYTES : 0);
  };
  const mode: SendPreview["mode"] = req.sendAll ? "all" : req.max ? "max" : "amount";
  let vbytes: number;
  let approx: boolean;
  let amount: number;
  if (mode === "all") {
    // LND keeps its anchor reserve back as change (lnd: SendCoins send_all).
    const lndKeeps = anchorReserveFor(inputs.anchorChannels);
    vbytes = await utxoVbytes(lndKeeps > 0 ? 2 : 1);
    approx = true;
    amount = confirmed - lndKeeps - Math.ceil(vbytes * req.feeRate);
  } else if (mode === "max") {
    const guess = confirmed - keep - Math.ceil(TYPICAL_SEND_VBYTES * req.feeRate);
    ({ vbytes, approx } =
      guess >= MIN_SEND_SATS ? await sendVbytes(lnd, req.address, guess, () => utxoVbytes(2)) : { vbytes: TYPICAL_SEND_VBYTES, approx: true });
    amount = confirmed - keep - Math.ceil(vbytes * req.feeRate);
  } else {
    amount = req.tokens ?? 0;
    ({ vbytes, approx } = await sendVbytes(lnd, req.address, amount, () => utxoVbytes(2)));
  }
  const feeSats = Math.ceil(vbytes * req.feeRate);
  const remainingSats = confirmed - Math.max(0, amount) - feeSats;
  // Whether the send takes coins promised to buyers — the very judgement the
  // send applies (409 capital_promised), with this send's own fee. Before,
  // the send counted a funding-fee estimate for it instead: at a low rate
  // "Max" was refused as touching them, at a high one a send the preview
  // flagged went out unasked.
  const promised = promisedSpendFrom(confirmed, inputs, pending, Math.max(0, amount), { newChannel: false, sendFeeSat: feeSats });
  const preview: SendPreview = {
    mode,
    address: req.address,
    amountSats: Math.max(0, amount),
    feeRate: req.feeRate,
    vbytes: Math.round(vbytes * 10) / 10,
    feeSats,
    feeApprox: approx,
    estimates,
    confirmedSats: confirmed,
    reserveSats,
    promisedSats,
    availableSats: Math.max(0, confirmed - keep - feeSats),
    remainingSats: Math.max(0, remainingSats),
    touchesPromised: promised !== null,
    checks: [],
  };
  if (amount < MIN_SEND_SATS) {
    preview.error =
      mode === "amount"
        ? `the amount must be at least ${MIN_SEND_SATS} sat`
        : mode === "max"
          ? `nothing can be sent while the node keeps ${sat(keep)} sat (the on-chain reserve${promisedSats ? " and the coins promised to buyers" : ""}) and pays the fee`
          : amount > 0
            ? `after the ~${sat(feeSats)} sat fee, ${sat(amount)} sat would be left to send — less than the ${MIN_SEND_SATS} sat LND sends`
            : "the wallet's confirmed coins don't cover the fee of sending them";
    return { preview, promised };
  }
  if (remainingSats < 0) {
    preview.error = `the wallet's confirmed coins (${sat(confirmed)} sat) don't cover ${sat(amount)} sat and the ~${sat(feeSats)} sat fee`;
    return { preview, promised };
  }
  if (estimates.fast !== null && req.feeRate > SEND_RATE_FACTOR * estimates.fast) {
    preview.checks.push({
      code: "fee_rate_high",
      message: `${req.feeRate} sat/vB is more than ${SEND_RATE_FACTOR}× ${fastRateName(estimates)}: this send pays ~${sat(feeSats)} sat in fees.`,
    });
  }
  if (feeSats > SEND_FEE_SHARE * amount) {
    preview.checks.push({
      code: "fee_share_high",
      message: `The fee (~${sat(feeSats)} sat) is ${Math.round((feeSats / amount) * 1000) / 10}% of the ${sat(amount)} sat sent.`,
    });
  }
  // The reserve as it stands once the promised channels are opened: what
  // the send leaves, less the coins promised to buyers (their funding fees
  // are part of the reserve). Before, the promised coins counted as left
  // over — a send could take the operator's whole reserve unasked while an
  // order was promised. A send that takes promised coins gets the question
  // that names the orders instead (capital_promised): it is the worse of
  // the two, and the reserve goes with it anyway.
  const afterPromised = remainingSats - promisedSats;
  if (!promised && afterPromised < reserveSats) {
    const anchors = inputs.anchorChannels + r.pendingOpens;
    const reserveWhy =
      r.anchorReserveSat > r.userReserveSat
        ? `LND's anchor reserve for fee-bumping ${anchors} anchor channel${anchors === 1 ? "" : "s"}`
        : "your on-chain reserve setting";
    const leaves = promisedSats
      ? `Besides the ${sat(promisedSats)} sat promised to buyers, this leaves ${sat(Math.max(0, afterPromised))} sat on-chain`
      : `This leaves ${sat(Math.max(0, remainingSats))} sat on-chain`;
    preview.checks.push({
      code: "below_reserve",
      message:
        `${leaves} — less than the ${sat(reserveSats)} sat on-chain reserve (${reserveWhy}). ` +
        "Channel opens, channel sales and fee bumps when closing need it.",
    });
  }
  return { preview, promised };
}
