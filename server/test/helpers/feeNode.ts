import { FakeLnd, type FakeChannel } from "./fakeLnd.js";

/** Short channel id "block x tx x out" as LND's numeric chan_id. */
export const chanNumber = (id: string): string => {
  const [block, tx, out] = id.split("x").map((n) => BigInt(n));
  return ((block << 40n) | (tx << 16n) | out).toString();
};

export interface FeeChannel extends FakeChannel {
  id: string;
  /** Our current routing fee on it. */
  feeRatePpm?: number;
  baseFeeMsat?: number;
}

/**
 * A fake node for the fee engine and the fee writes: its channels with our
 * current fees (FeeReport), the channel graph's view of them (GetChanInfo —
 * our policy, with a CLTV delta, so a write is allowed), an empty forwarding
 * history, and UpdateChannelPolicy recording every write and moving the fee.
 *
 *   const node = feeNode({ channels: [{ id: "800001x1x0", … feeRatePpm: 500 }] });
 *   node.policyWrites  // [{ outpoint, feeRatePpm, baseFeeMsat }]
 */
export function feeNode(opts: { channels: FeeChannel[]; blockHeight?: number; chainBalance?: number }) {
  const node = new FakeLnd({ channels: opts.channels, blockHeight: opts.blockHeight ?? 860_000, chainBalance: opts.chainBalance ?? 0 });
  const fees = new Map(opts.channels.map((c) => [c.id, { ppm: c.feeRatePpm ?? 100, base: c.baseFeeMsat ?? 1000 }]));
  const byPoint = new Map(opts.channels.map((c) => [`${c.transactionId}:${c.transactionVout}`, c]));
  const writes: { outpoint: string; feeRatePpm: number; baseFeeMsat: number }[] = [];
  node.override("default.feeReport", (_a, cb) =>
    cb(null, {
      channel_fees: opts.channels.map((c) => ({
        chan_id: chanNumber(c.id),
        channel_point: `${c.transactionId}:${c.transactionVout}`,
        base_fee_msat: String(fees.get(c.id)!.base),
        fee_per_mil: String(fees.get(c.id)!.ppm),
        inbound_base_fee_msat: 0,
        inbound_fee_per_mil: 0,
      })),
    }),
  );
  node.override("default.forwardingHistory", (_a, cb) => cb(null, { forwarding_events: [], last_offset_index: "0" }));
  node.override("default.getChanInfo", (a, cb) => {
    const ch = typeof a.chan_point === "string" ? byPoint.get(a.chan_point) : opts.channels.find((c) => chanNumber(c.id) === String(a.chan_id));
    if (!ch) return cb({ details: "edge not found" });
    const ours = fees.get(ch.id)!;
    const policy = (ppm: number, base: number) => ({
      disabled: false,
      fee_base_msat: String(base),
      fee_rate_milli_msat: String(ppm),
      last_update: Math.floor(Date.now() / 1000),
      max_htlc_msat: String(ch.capacity * 990),
      min_htlc: "1000",
      time_lock_delta: 80,
    });
    const [node1, node2] = [node.publicKey, ch.partnerPublicKey].sort();
    const pol = (pk: string) => (pk === node.publicKey ? policy(ours.ppm, ours.base) : policy(1, 1000));
    cb(null, {
      capacity: String(ch.capacity),
      chan_point: `${ch.transactionId}:${ch.transactionVout}`,
      channel_id: chanNumber(ch.id),
      node1_pub: node1,
      node2_pub: node2,
      node1_policy: pol(node1),
      node2_policy: pol(node2),
    });
  });
  node.override("default.updateChannelPolicy", (a, cb) => {
    const point = a.chan_point as { funding_txid_str: string; output_index: number };
    const outpoint = `${point.funding_txid_str}:${point.output_index}`;
    const ch = byPoint.get(outpoint);
    const feeRatePpm = Math.round(Number(a.fee_rate) * 1_000_000);
    const baseFeeMsat = Number(a.base_fee_msat);
    writes.push({ outpoint, feeRatePpm, baseFeeMsat });
    if (ch) fees.set(ch.id, { ppm: feeRatePpm, base: baseFeeMsat });
    cb(null, { failed_updates: [] });
  });
  return Object.assign(node, {
    policyWrites: writes,
    feeOf: (id: string) => fees.get(id),
  });
}
