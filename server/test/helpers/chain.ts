import { createHash, randomBytes } from "node:crypto";
import type { FakeLnd } from "./fakeLnd.js";
import { chanNumber } from "./feeNode.js";

/**
 * On-chain history and payment history for the books (package P6): real
 * Bitcoin transactions serialised byte for byte (legacy or segwit), the
 * wallet's view of them as LND's GetTransactions reports it, closed channels
 * as ClosedChannels reports them, and payments as ListPayments pages them —
 * all through the real `lightning` library's response checks.
 *
 *   const fund = rawTx({ inputs: [coin()], outputs: [{ value: 2_000_000 }, { value: 497_000 }] });
 *   const chain = installChain(node, { txs: [walletTx(fund, { amount: -2_003_000, fee: 3_000 })] });
 */

export interface TxIn {
  txid: string;
  vout: number;
  sequence?: number;
}
export interface TxOut {
  value: number;
  script?: string;
}
export interface RawTxBuilt {
  hex: string;
  txid: string;
  inputs: TxIn[];
  outputs: TxOut[];
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const varint = (n: number): Buffer => {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  return Buffer.concat([Buffer.from([0xfe]), u32(n)]);
};

/** A pay-to-witness-key-hash output script (any 20 bytes). */
export const p2wpkh = (): string => "0014" + randomBytes(20).toString("hex");

/** A transaction, serialised; `witness` writes the segwit form (each input
 *  with a two-item witness), whose txid is still that of the legacy form. */
export function rawTx(opts: { inputs: TxIn[]; outputs: TxOut[]; locktime?: number; version?: number; witness?: boolean }): RawTxBuilt {
  const version = u32(opts.version ?? 2);
  const ins = Buffer.concat([
    varint(opts.inputs.length),
    ...opts.inputs.map((i) =>
      Buffer.concat([Buffer.from(i.txid, "hex").reverse(), u32(i.vout), varint(0), u32(i.sequence ?? 0xffffffff)]),
    ),
  ]);
  const outs = Buffer.concat([
    varint(opts.outputs.length),
    ...opts.outputs.map((o) => {
      const script = Buffer.from(o.script ?? p2wpkh(), "hex");
      return Buffer.concat([u64(o.value), varint(script.length), script]);
    }),
  ]);
  const locktime = u32(opts.locktime ?? 0);
  const legacy = Buffer.concat([version, ins, outs, locktime]);
  const txid = createHash("sha256").update(createHash("sha256").update(legacy).digest()).digest().reverse().toString("hex");
  const hex = opts.witness === false
    ? legacy.toString("hex")
    : Buffer.concat([
        version,
        Buffer.from([0x00, 0x01]),
        ins,
        outs,
        ...opts.inputs.map(() => Buffer.concat([varint(2), varint(72), randomBytes(72), varint(33), randomBytes(33)])),
        locktime,
      ]).toString("hex");
  return { hex, txid, inputs: opts.inputs, outputs: opts.outputs };
}

/** A coin from outside (a deposit's output): an input that spends it. */
export const coin = (vout = 0): TxIn => ({ txid: randomBytes(32).toString("hex"), vout });

/** How the wallet reports a transaction (LND GetTransactions). `amount`:
 *  the wallet's net change (negative: sent); `fee`: only when every input
 *  was the wallet's (btcwallet reports none otherwise); `local`: which
 *  inputs spent wallet coins (default: none). */
export function walletTx(
  tx: RawTxBuilt,
  o: {
    amount: number;
    fee?: number;
    at?: number;
    confirmations?: number;
    local?: boolean[] | boolean;
    hex?: boolean;
    /** An LND before 0.15.1: it lists no previous outpoints at all. */
    noInputs?: boolean;
  },
) {
  const local = (i: number) => (Array.isArray(o.local) ? o.local[i] === true : o.local === true);
  const confirmations = o.confirmations ?? 6;
  return {
    amount: String(o.amount),
    block_hash: confirmations > 0 ? "ab".repeat(32) : "",
    block_height: confirmations > 0 ? 859_000 : 0,
    dest_addresses: [],
    label: "",
    num_confirmations: confirmations,
    previous_outpoints: o.noInputs ? [] : tx.inputs.map((i, n) => ({ outpoint: `${i.txid}:${i.vout}`, is_our_output: local(n) })),
    raw_tx_hex: o.hex === false ? "" : tx.hex,
    time_stamp: String(Math.floor((o.at ?? Date.now()) / 1000)),
    total_fees: String(o.fee ?? 0),
    tx_hash: tx.txid,
  };
}

export type CloseType = "COOPERATIVE_CLOSE" | "LOCAL_FORCE_CLOSE" | "REMOTE_FORCE_CLOSE" | "BREACH_CLOSE" | "FUNDING_CANCELED";

/** A closed channel as LND reports it (ClosedChannels). */
export function closedChannel(c: {
  id: string;
  capacity: number;
  funding: { txid: string; vout: number };
  closeTxid: string;
  closeHeight?: number;
  type: CloseType;
  weOpened: boolean;
  weClosed?: boolean;
  partner?: string;
  settled?: number;
  /** Outputs of the close LND swept, and by which transaction. */
  sweeps?: { type: "COMMIT" | "ANCHOR" | "INCOMING_HTLC" | "OUTGOING_HTLC"; vout: number; amount: number; txid: string }[];
}) {
  return {
    alias_scids: [],
    capacity: String(c.capacity),
    chan_id: chanNumber(c.id),
    channel_point: `${c.funding.txid}:${c.funding.vout}`,
    close_height: c.closeHeight ?? 859_500,
    close_initiator: c.weClosed === undefined ? "INITIATOR_UNKNOWN" : c.weClosed ? "INITIATOR_LOCAL" : "INITIATOR_REMOTE",
    close_type: c.type,
    closing_tx_hash: c.closeTxid,
    open_initiator: c.weOpened ? "INITIATOR_LOCAL" : "INITIATOR_REMOTE",
    remote_pubkey: c.partner ?? "02" + "c3".repeat(32),
    resolutions: (c.sweeps ?? []).map((s) => ({
      amount_sat: String(s.amount),
      outcome: "CLAIMED",
      outpoint: { output_index: s.vout, txid_str: c.closeTxid },
      resolution_type: s.type,
      sweep_txid: s.txid,
    })),
    settled_balance: String(c.settled ?? 0),
    time_locked_balance: "0",
    zero_conf_confirmed_scid: "0",
  };
}

/** Answer GetTransactions and ClosedChannels from these lists (kept live:
 *  push to them to change what LND says). */
export function installChain(
  node: FakeLnd,
  data: { txs?: ReturnType<typeof walletTx>[]; closed?: ReturnType<typeof closedChannel>[] } = {},
) {
  const state = { txs: data.txs ?? [], closed: data.closed ?? [] };
  node.override("default.getTransactions", (_a, cb) => cb(null, { transactions: state.txs, first_index: "0", last_index: "0" }));
  node.override("default.closedChannels", (_a, cb) => cb(null, { channels: state.closed }));
  return state;
}

/** A successful payment as LND lists it (ListPayments): `destination` is the
 *  last hop of its route — this node's own key for a rebalance — and the
 *  route comes back through `lastChannel`. `parts`: a payment split over
 *  several paths (one HTLC each, each back through its own channel; their
 *  tokens and fees add up to the payment's). */
export function paymentRpc(p: {
  id?: string;
  at: number;
  tokens: number;
  feeMsat: number;
  destination: string;
  lastChannel?: string;
  status?: "SUCCEEDED" | "FAILED";
  parts?: { lastChannel: string; tokens: number; feeMsat: number }[];
}) {
  const ns = String(BigInt(Math.floor(p.at)) * 1_000_000n);
  const succeeded = (p.status ?? "SUCCEEDED") === "SUCCEEDED";
  const parts = p.parts ?? [{ lastChannel: p.lastChannel ?? "800001x1x0", tokens: p.tokens, feeMsat: p.feeMsat }];
  return {
    creation_date: String(Math.floor(p.at / 1000)),
    creation_time_ns: ns,
    failure_reason: succeeded ? "FAILURE_REASON_NONE" : "FAILURE_REASON_NO_ROUTE",
    fee: String(Math.floor(p.feeMsat / 1000)),
    fee_msat: String(p.feeMsat),
    fee_sat: String(Math.floor(p.feeMsat / 1000)),
    htlcs: parts.map((part) => {
      const hops = [
        { chan_id: chanNumber("800000x1x0"), pub_key: "02" + "d4".repeat(32) },
        { chan_id: chanNumber(part.lastChannel), pub_key: p.destination },
      ];
      return {
        attempt_time_ns: ns,
        resolve_time_ns: ns,
        status: succeeded ? "SUCCEEDED" : "FAILED",
        route: {
          hops: hops.map((h, i) => ({
            amt_to_forward_msat: String(part.tokens * 1000),
            chan_capacity: "5000000",
            chan_id: h.chan_id,
            expiry: 860_040,
            fee_msat: i === 0 ? String(part.feeMsat) : "0",
            pub_key: h.pub_key,
            tlv_payload: true,
          })),
          total_amt_msat: String(part.tokens * 1000 + part.feeMsat),
          total_fees_msat: String(part.feeMsat),
          total_time_lock: 860_080,
        },
      };
    }),
    payment_hash: p.id ?? randomBytes(32).toString("hex"),
    payment_index: "1",
    payment_preimage: succeeded ? randomBytes(32).toString("hex") : "00".repeat(32),
    payment_request: "",
    status: succeeded ? "SUCCEEDED" : "FAILED",
    value: String(p.tokens),
    value_msat: String(p.tokens * 1000),
    value_sat: String(p.tokens),
  };
}

/** Answer ListPayments from this list, paged the way LND pages it (newest
 *  first with reversed=true, index_offset, max_payments, creation dates).
 *  `ignoreDates`: an LND before 0.16, which knows no creation-date filter. */
export function installPayments(node: FakeLnd, list: ReturnType<typeof paymentRpc>[], opts: { ignoreDates?: boolean } = {}) {
  node.override("default.listPayments", (a, cb) => {
    const start = opts.ignoreDates ? 0 : Number(a.creation_date_start) || 0;
    const end = opts.ignoreDates ? Number.POSITIVE_INFINITY : Number(a.creation_date_end) || Number.POSITIVE_INFINITY;
    const max = Number(a.max_payments) || 100;
    const offset = Number(a.index_offset) || 0;
    const indexed = list
      .map((p, i) => ({ p: { ...p, payment_index: String(i + 1) }, index: i + 1 }))
      .filter(({ p }) => a.include_incomplete === true || p.status === "SUCCEEDED")
      .filter(({ p }) => Number(p.creation_date) >= start && Number(p.creation_date) <= end);
    const page = (offset > 0 ? indexed.filter((x) => x.index < offset) : indexed).slice(-max);
    cb(null, {
      payments: page.map((x) => x.p),
      first_index_offset: String(page[0]?.index ?? 0),
      last_index_offset: String(page[page.length - 1]?.index ?? 0),
      total_num_payments: String(indexed.length),
    });
  });
  return list;
}
