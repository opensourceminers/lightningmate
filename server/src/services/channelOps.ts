import { addPeer, openChannel, type AuthenticatedLnd } from "lightning";

export interface OpenChannelParams {
  pubkey: string;
  socket?: string;
  localTokens: number;
  /** On-chain fee rate in sat/vByte; omit to let LND estimate. */
  feeRate?: number;
  isPrivate?: boolean;
}

export interface OpenChannelResult {
  ok: boolean;
  pubkey: string;
  localTokens: number;
  transactionId?: string;
  transactionVout?: number;
  error?: string;
}

/** LND won't open channels below ~20k sat; keep a sane floor. */
export const MIN_CHANNEL_SATS = 20_000;

function describe(err: unknown): string {
  if (Array.isArray(err)) {
    const code = err[1] ?? err[0];
    const extra = err[2] as { err?: { details?: string; message?: string }; details?: string } | undefined;
    const detail = extra?.err?.details ?? extra?.err?.message ?? extra?.details ?? "";
    return detail ? `${code}: ${detail}` : String(code);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Open a channel to a peer. Connects first (best-effort), then funds the channel
 * on-chain. This spends real funds and is irreversible — callers must gate it
 * behind write access and explicit user confirmation.
 */
export async function openChannelTo(
  writeLnd: AuthenticatedLnd,
  params: OpenChannelParams,
): Promise<OpenChannelResult> {
  const base = { ok: false, pubkey: params.pubkey, localTokens: params.localTokens };

  if (!Number.isFinite(params.localTokens) || params.localTokens < MIN_CHANNEL_SATS) {
    return { ...base, error: `channel size must be at least ${MIN_CHANNEL_SATS} sat` };
  }

  // Connect to the peer first; ignore "already connected" style errors.
  if (params.socket) {
    try {
      await addPeer({ lnd: writeLnd, public_key: params.pubkey, socket: params.socket });
    } catch {
      // proceed — openChannel will also try via partner_socket
    }
  }

  try {
    const res = await openChannel({
      lnd: writeLnd,
      partner_public_key: params.pubkey,
      local_tokens: params.localTokens,
      ...(params.socket ? { partner_socket: params.socket } : {}),
      ...(params.feeRate ? { chain_fee_tokens_per_vbyte: params.feeRate } : {}),
      ...(params.isPrivate ? { is_private: true } : {}),
    });
    return {
      ...base,
      ok: true,
      transactionId: res.transaction_id,
      transactionVout: res.transaction_vout,
    };
  } catch (err) {
    return { ...base, error: describe(err) };
  }
}
