import {
  createChainAddress,
  getChainBalance,
  getChainTransactions,
  getPendingChainBalance,
  type AuthenticatedLnd,
} from "lightning";

export interface WalletTx {
  id: string;
  createdAt: string;
  tokens: number;
  fee: number;
  isOutgoing: boolean;
  isConfirmed: boolean;
}

export interface WalletInfo {
  confirmedSats: number;
  pendingSats: number;
  transactions: WalletTx[];
}

export async function getWallet(lnd: AuthenticatedLnd): Promise<WalletInfo> {
  const [chain, pending, txs] = await Promise.all([
    getChainBalance({ lnd }),
    getPendingChainBalance({ lnd }),
    getChainTransactions({ lnd }),
  ]);

  const transactions: WalletTx[] = [...txs.transactions]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20)
    .map((t) => ({
      id: t.id,
      createdAt: t.created_at,
      tokens: t.tokens,
      fee: t.fee ?? 0,
      isOutgoing: t.is_outgoing,
      isConfirmed: t.is_confirmed,
    }));

  return {
    confirmedSats: chain.chain_balance,
    pendingSats: pending.pending_chain_balance,
    transactions,
  };
}

/** Create a fresh receive address (native segwit). Requires address:write. */
export async function newAddress(writeLnd: AuthenticatedLnd): Promise<string> {
  const { address } = await createChainAddress({ lnd: writeLnd, format: "p2wpkh" });
  return address;
}
