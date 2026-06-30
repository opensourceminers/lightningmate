import {
  createChainAddress,
  getChainBalance,
  getChainFeeRate,
  getChainTransactions,
  getPendingChainBalance,
  getUtxos,
  sendToChainAddress,
  type AuthenticatedLnd,
} from "lightning";

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
  /** ~next block (sat/vByte). */
  fast: number | null;
  /** ~30 min. */
  normal: number | null;
  /** ~hours — cheapest sensible. */
  economy: number | null;
}

/** Current mempool fee rates for a few confirmation targets (for the close dialog). */
export async function getFeeEstimates(lnd: AuthenticatedLnd): Promise<FeeEstimates> {
  const [fast, normal, economy] = await Promise.all([
    getChainFeeRate({ lnd, confirmation_target: 1 }).catch(() => null),
    getChainFeeRate({ lnd, confirmation_target: 3 }).catch(() => null),
    getChainFeeRate({ lnd, confirmation_target: 36 }).catch(() => null),
  ]);
  const r = (f: { tokens_per_vbyte: number } | null) =>
    f ? Math.max(1, Math.round(f.tokens_per_vbyte)) : null;
  return { fast: r(fast), normal: r(normal), economy: r(economy) };
}

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

export async function sendOnchain(
  lnd: AuthenticatedLnd,
  opts: { address: string; tokens: number; feeRate: number },
): Promise<SendResult> {
  const res = await sendToChainAddress({
    lnd,
    address: opts.address,
    tokens: opts.tokens,
    fee_tokens_per_vbyte: opts.feeRate,
  });
  return { ok: res.is_confirmed || !!res.id, transactionId: res.id };
}
