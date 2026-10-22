/**
 * A raw Bitcoin transaction, as far as the books need it: what it spends
 * (outpoints) and what it pays (output values).
 *
 * Parsed locally from the hex LND keeps with each wallet transaction — never
 * looked up on an explorer: the node stays private (Tor-only), and a txid
 * sent to a third party would tie this node to its channels. A close's fee is
 * not in LND's wallet record at all (btcwallet reports a fee only when every
 * input is a wallet input, and a close spends the 2-of-2 funding output), so
 * it can only be worked out from the transaction itself: what went in minus
 * what came out.
 *
 * Handles the legacy and the segwit (BIP 144) serialisation; anything else —
 * truncated, trailing bytes, absurd counts — is refused with an error rather
 * than read wrong.
 */
export interface RawTx {
  version: number;
  inputs: { txid: string; vout: number; sequence: number }[];
  outputs: { value: number; script: string }[];
  locktime: number;
}

/** No real transaction comes near this many inputs or outputs (a block holds
 *  ~4 MB): a count beyond it is a damaged or foreign blob. */
const MAX_COUNT = 100_000;

export function parseRawTx(hex: string): RawTx {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("not a hex transaction");
  }
  const buf = Buffer.from(hex, "hex");
  let pos = 0;
  const need = (n: number) => {
    if (n < 0 || pos + n > buf.length) throw new Error("truncated transaction");
  };
  const u8 = (): number => {
    need(1);
    return buf[pos++];
  };
  const u32 = (): number => {
    need(4);
    const v = buf.readUInt32LE(pos);
    pos += 4;
    return v;
  };
  const u64 = (): number => {
    need(8);
    const v = buf.readBigUInt64LE(pos);
    pos += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount out of range");
    return Number(v);
  };
  const varint = (): number => {
    const b = u8();
    if (b < 0xfd) return b;
    if (b === 0xfd) {
      need(2);
      const v = buf.readUInt16LE(pos);
      pos += 2;
      return v;
    }
    if (b === 0xfe) return u32();
    return u64();
  };
  const count = (): number => {
    const n = varint();
    if (n > MAX_COUNT) throw new Error("implausible count in transaction");
    return n;
  };
  const bytes = (n: number): Buffer => {
    need(n);
    const b = buf.subarray(pos, pos + n);
    pos += n;
    return b;
  };

  const version = u32();
  // BIP 144: a 0x00 marker and a 0x01 flag after the version mean witness
  // data follows the outputs (a legacy transaction never has 0 inputs).
  let segwit = false;
  if (buf.length > pos + 1 && buf[pos] === 0x00 && buf[pos + 1] === 0x01) {
    segwit = true;
    pos += 2;
  }
  const inputs: RawTx["inputs"] = [];
  for (let i = 0, n = count(); i < n; i++) {
    // Outpoints carry the txid byte-reversed against how it is displayed.
    const txid = Buffer.from(bytes(32)).reverse().toString("hex");
    const vout = u32();
    bytes(count()); // scriptSig
    inputs.push({ txid, vout, sequence: u32() });
  }
  const outputs: RawTx["outputs"] = [];
  for (let i = 0, n = count(); i < n; i++) {
    const value = u64();
    outputs.push({ value, script: bytes(count()).toString("hex") });
  }
  if (segwit) {
    for (let i = 0; i < inputs.length; i++) {
      for (let k = 0, items = count(); k < items; k++) bytes(count());
    }
  }
  const locktime = u32();
  if (pos !== buf.length) throw new Error("trailing bytes after transaction");
  if (inputs.length === 0) throw new Error("transaction without inputs");
  return { version, inputs, outputs, locktime };
}

/** Σ output values (sat). */
export const outputTotal = (tx: Pick<RawTx, "outputs">): number => tx.outputs.reduce((s, o) => s + o.value, 0);
