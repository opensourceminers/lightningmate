import { addPeer, closeChannel, getPeers, openChannel, type AuthenticatedLnd } from "lightning";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function isConnected(lnd: AuthenticatedLnd, pubkey: string): Promise<boolean> {
  try {
    const { peers } = await getPeers({ lnd });
    return peers.some((p) => p.public_key === pubkey);
  } catch {
    return false;
  }
}

/**
 * Make sure there's a live connection to the peer before funding a channel —
 * otherwise openChannel fails with RemotePeerDisconnected. Dials the socket and
 * verifies the peer actually shows up as connected, retrying a few times since
 * the handshake can take a moment.
 */
async function ensureConnected(
  lnd: AuthenticatedLnd,
  pubkey: string,
  socket?: string,
): Promise<boolean> {
  if (await isConnected(lnd, pubkey)) return true;
  if (!socket) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await addPeer({ lnd, public_key: pubkey, socket });
    } catch {
      // "already connected" or a transient dial error — verify below either way
    }
    if (await isConnected(lnd, pubkey)) return true;
    await sleep(1200);
  }
  return isConnected(lnd, pubkey);
}

/**
 * Open a channel to a peer. Connects first (and confirms the peer is online),
 * then funds the channel on-chain. This spends real funds and is irreversible —
 * callers must gate it behind write access and explicit user confirmation.
 */
export async function openChannelTo(
  writeLnd: AuthenticatedLnd,
  params: OpenChannelParams,
): Promise<OpenChannelResult> {
  const base = { ok: false, pubkey: params.pubkey, localTokens: params.localTokens };

  if (!Number.isFinite(params.localTokens) || params.localTokens < MIN_CHANNEL_SATS) {
    return { ...base, error: `channel size must be at least ${MIN_CHANNEL_SATS} sat` };
  }

  // Connect to (and confirm) the peer first — openChannel otherwise fails with
  // RemotePeerDisconnected when the peer isn't already a live connection.
  const connected = await ensureConnected(writeLnd, params.pubkey, params.socket);
  if (!connected) {
    return {
      ...base,
      error: `couldn't connect to ${params.pubkey.slice(0, 12)}… — the peer looks offline. Try again later.`,
    };
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

export interface CloseChannelResult {
  ok: boolean;
  transactionId?: string;
  error?: string;
}

/**
 * Close a channel by funding outpoint. Cooperative by default (needs the peer
 * online); force-close when the peer is unreachable. Real on-chain action.
 */
export async function closeChannelByOutpoint(
  writeLnd: AuthenticatedLnd,
  transactionId: string,
  transactionVout: number,
  isForce: boolean,
): Promise<CloseChannelResult> {
  try {
    const res = await closeChannel(
      isForce
        ? { lnd: writeLnd, transaction_id: transactionId, transaction_vout: transactionVout, is_force_close: true }
        : { lnd: writeLnd, transaction_id: transactionId, transaction_vout: transactionVout },
    );
    return { ok: true, transactionId: res.transaction_id };
  } catch (err) {
    return { ok: false, error: describe(err) };
  }
}
