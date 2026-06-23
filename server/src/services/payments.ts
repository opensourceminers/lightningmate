import {
  createInvoice as lnCreateInvoice,
  decodePaymentRequest,
  getInvoices,
  getPayments,
  pay,
  type AuthenticatedLnd,
} from "lightning";

/**
 * Lightning send / receive. Creating invoices and paying require a write
 * macaroon (invoices:write / offchain:write); decoding and history are read-only.
 */

export interface CreatedInvoice {
  id: string;
  request: string;
  tokens: number;
  description: string;
  createdAt: string;
  expiresAt: string;
}

export async function createInvoice(
  lnd: AuthenticatedLnd,
  opts: { tokens: number; description: string; expirySec: number },
): Promise<CreatedInvoice> {
  const expiresAt = new Date(Date.now() + opts.expirySec * 1000).toISOString();
  const inv = await lnCreateInvoice({
    lnd,
    tokens: opts.tokens > 0 ? opts.tokens : undefined,
    description: opts.description || undefined,
    expires_at: expiresAt,
  });
  return {
    id: inv.id,
    request: inv.request,
    tokens: inv.tokens ?? opts.tokens,
    description: opts.description,
    createdAt: inv.created_at ?? new Date().toISOString(),
    expiresAt,
  };
}

export interface DecodedRequest {
  id: string;
  destination: string;
  tokens: number;
  description: string;
  expiresAt: string;
  expired: boolean;
}

export async function decodeRequest(
  lnd: AuthenticatedLnd,
  request: string,
): Promise<DecodedRequest> {
  const d = await decodePaymentRequest({ lnd, request });
  return {
    id: d.id,
    destination: d.destination,
    tokens: d.safe_tokens ?? d.tokens ?? 0,
    description: d.description ?? "",
    expiresAt: d.expires_at,
    expired: new Date(d.expires_at).getTime() < Date.now(),
  };
}

export interface PayResult {
  ok: boolean;
  id: string;
  tokens: number;
  feeSats: number;
  secret: string;
}

/** Pay a BOLT11 request. The route enforces max_fee; pathfinding is time-boxed. */
export async function payRequest(
  lnd: AuthenticatedLnd,
  opts: { request: string; maxFeeSats: number; tokens?: number },
): Promise<PayResult> {
  const res = await pay({
    lnd,
    request: opts.request,
    max_fee: opts.maxFeeSats,
    pathfinding_timeout: 30_000,
    ...(opts.tokens ? { tokens: opts.tokens } : {}),
  });
  return {
    ok: res.is_confirmed,
    id: res.id,
    tokens: res.tokens,
    feeSats: res.safe_fee ?? res.fee,
    secret: res.secret,
  };
}

export interface LnActivity {
  invoices: {
    id: string;
    tokens: number;
    description: string;
    isPaid: boolean;
    receivedSats: number;
    createdAt: string;
  }[];
  payments: {
    id: string;
    destination: string;
    tokens: number;
    feeSats: number;
    isConfirmed: boolean;
    createdAt: string;
  }[];
}

export async function getLnActivity(lnd: AuthenticatedLnd, limit = 25): Promise<LnActivity> {
  const [inv, pmt] = await Promise.all([
    getInvoices({ lnd, limit }),
    getPayments({ lnd, limit }),
  ]);

  return {
    invoices: inv.invoices.map((i) => ({
      id: i.id,
      tokens: i.tokens ?? 0,
      description: i.description ?? "",
      isPaid: i.is_confirmed,
      receivedSats: i.received ?? 0,
      createdAt: i.created_at,
    })),
    payments: pmt.payments.map((p) => ({
      id: p.id,
      destination: p.destination,
      tokens: p.tokens,
      feeSats: p.safe_fee ?? p.fee,
      isConfirmed: p.is_confirmed,
      createdAt: p.created_at,
    })),
  };
}
