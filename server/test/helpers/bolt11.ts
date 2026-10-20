import { createECDH, createHash, createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { createRequire } from "node:module";

/**
 * Real, signed BOLT11 payment requests for tests.
 *
 * The `lightning` library parses every request it pays locally (and rejects
 * garbage), so tests that go through `pay()`/`decodePaymentRequest()` need the
 * genuine article. We build them with the `invoices` package the library
 * itself uses (resolved through lightning's own dependency tree, so hoisting
 * can't break it) and sign with a throwaway secp256k1 key from node:crypto.
 */

interface UnsignedRequest {
  hash: string;
  hrp: string;
  preimage: string;
  tags: number[];
}

export interface ParsedRequest {
  destination: string;
  id: string;
  tokens: number;
  mtokens: string;
  description?: string;
  description_hash?: string;
  created_at: string;
  expires_at: string;
  is_expired: boolean;
  cltv_delta?: number;
  payment?: string;
  features: { bit: number }[];
}

interface InvoicesModule {
  createUnsignedRequest(args: Record<string, unknown>): UnsignedRequest;
  createSignedRequest(args: { destination: string; hrp: string; signature: string; tags: number[] }): {
    request: string;
  };
  parsePaymentRequest(args: { request: string }): ParsedRequest;
}

const requireHere = createRequire(import.meta.url);
const fromLightning = createRequire(requireHere.resolve("lightning/package.json"));
const invoices = fromLightning("invoices") as InvoicesModule;

/** secp256k1 group order — signatures are normalised to low-S as BOLT11 expects. */
const CURVE_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

export interface NodeKey {
  /** 33-byte compressed public key, hex — the node id. */
  publicKey: string;
  /** Compact (r‖s, low-S) signature of sha256(preimage), hex. */
  signPreimage(preimageHex: string): string;
}

/** A throwaway node identity (fake LND nodes, fake LNURL payees, …). */
export function makeNodeKey(): NodeKey {
  const ecdh = createECDH("secp256k1");
  ecdh.generateKeys();
  const uncompressed = ecdh.getPublicKey();
  const keyObject: KeyObject = createPrivateKey({
    key: {
      kty: "EC",
      crv: "secp256k1",
      d: ecdh.getPrivateKey().toString("base64url"),
      x: uncompressed.subarray(1, 33).toString("base64url"),
      y: uncompressed.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  return {
    publicKey: Buffer.from(ecdh.getPublicKey(null, "compressed")).toString("hex"),
    signPreimage(preimageHex: string): string {
      const der = sign("sha256", Buffer.from(preimageHex, "hex"), { key: keyObject, dsaEncoding: "ieee-p1363" });
      const r = BigInt(`0x${der.subarray(0, 32).toString("hex")}`);
      let s = BigInt(`0x${der.subarray(32).toString("hex")}`);
      if (s > CURVE_N / 2n) s = CURVE_N - s;
      return r.toString(16).padStart(64, "0") + s.toString(16).padStart(64, "0");
    },
  };
}

export interface MadeRequest {
  request: string;
  /** Payment hash, hex. */
  id: string;
  /** Preimage, hex. */
  secret: string;
  destination: string;
}

/**
 * Build a signed BOLT11 request. Omit both `tokens` and `mtokens` for an
 * amountless invoice.
 */
export function makePaymentRequest(opts: {
  key?: NodeKey;
  tokens?: number;
  mtokens?: string;
  description?: string;
  /** Default: 1 hour from now. */
  expiresAt?: string;
  createdAt?: string;
  secret?: string;
  network?: "bitcoin" | "testnet" | "regtest";
}): MadeRequest {
  const key = opts.key ?? makeNodeKey();
  const secret = opts.secret ?? randomBytes(32).toString("hex");
  const id = createHash("sha256").update(Buffer.from(secret, "hex")).digest("hex");
  const unsigned = invoices.createUnsignedRequest({
    created_at: opts.createdAt,
    description: opts.description ?? "",
    destination: key.publicKey,
    expires_at: opts.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
    features: [{ bit: 9 }, { bit: 14 }],
    id,
    mtokens: opts.mtokens,
    network: opts.network ?? "bitcoin",
    payment: randomBytes(32).toString("hex"),
    tokens: opts.tokens,
  });
  const { request } = invoices.createSignedRequest({
    destination: key.publicKey,
    hrp: unsigned.hrp,
    signature: key.signPreimage(unsigned.preimage),
    tags: unsigned.tags,
  });
  return { request, id, secret, destination: key.publicKey };
}

/** Parse a BOLT11 request exactly as the `lightning` library does. */
export function parsePaymentRequest(request: string): ParsedRequest {
  return invoices.parsePaymentRequest({ request });
}
