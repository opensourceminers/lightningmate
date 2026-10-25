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

/** A forward through the node, for its forwarding history. */
export interface FakeForward {
  /** When (ms or ISO); default now. */
  at?: number | string;
  inId: string;
  outId: string;
  tokens: number;
  /** Fee earned, msat. */
  feeMsat: number;
}

/** `n` forwards out of `outId` (in via `inId`), spread over the last `days`. */
export function forwardsOut(outId: string, inId: string, n: number, opts: { tokens?: number; feeMsat?: number; days?: number } = {}): FakeForward[] {
  const days = opts.days ?? 10;
  return Array.from({ length: n }, (_, i) => ({
    at: Date.now() - Math.round(((i + 0.5) / n) * days * 86_400_000),
    inId,
    outId,
    tokens: opts.tokens ?? 50_000,
    feeMsat: opts.feeMsat ?? 5_000,
  }));
}

/**
 * A fake node for the fee engine and the fee writes: its channels with our
 * current fees (FeeReport), the channel graph's view of them (GetChanInfo —
 * our policy, with a CLTV delta, so a write is allowed), an empty forwarding
 * history, and UpdateChannelPolicy recording every write and moving the fee.
 *
 *   const node = feeNode({ channels: [{ id: "800001x1x0", … feeRatePpm: 500 }] });
 *   node.policyWrites  // [{ outpoint, feeRatePpm, baseFeeMsat }]
 *
 * `node.refusals.set(outpoint, "why")` makes LND refuse that channel's next
 * updates the way it does — in `failed_updates`, not as an error — and
 * `node.policyRequests` holds every UpdateChannelPolicy request as sent.
 */
export function feeNode(opts: { channels: FeeChannel[]; blockHeight?: number; chainBalance?: number; forwards?: FakeForward[] }) {
  const node = new FakeLnd({ channels: opts.channels, blockHeight: opts.blockHeight ?? 860_000, chainBalance: opts.chainBalance ?? 0 });
  const forwards = opts.forwards ?? [];
  const fees = new Map(opts.channels.map((c) => [c.id, { ppm: c.feeRatePpm ?? 100, base: c.baseFeeMsat ?? 1000 }]));
  /** max_htlc each channel advertises after an update set it (msat). */
  const maxHtlcOf = new Map<string, number>();
  const byPoint = new Map(opts.channels.map((c) => [`${c.transactionId}:${c.transactionVout}`, c]));
  const writes: { outpoint: string; feeRatePpm: number; baseFeeMsat: number }[] = [];
  const requests: Record<string, unknown>[] = [];
  const refusals = new Map<string, string>();
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
  // The forwarding history, paged the way LND pages it (start/end time,
  // index offset, a page size).
  node.override("default.forwardingHistory", (a, cb) => {
    const atMs = (f: FakeForward) => (f.at === undefined ? Date.now() : typeof f.at === "number" ? f.at : Date.parse(f.at));
    const from = a.start_time ? Number(a.start_time) * 1000 : -Infinity;
    const to = a.end_time ? Number(a.end_time) * 1000 : Infinity;
    const offset = Number(a.index_offset ?? 0);
    const max = Number(a.num_max_events ?? 100);
    const all = forwards
      .filter((f) => atMs(f) >= from && atMs(f) <= to)
      .sort((x, y) => atMs(x) - atMs(y));
    const page = all.slice(offset, offset + max);
    cb(null, {
      forwarding_events: page.map((f) => {
        const ms = atMs(f);
        return {
          amt_in: String(f.tokens + Math.floor(f.feeMsat / 1000)),
          amt_in_msat: String(f.tokens * 1000 + f.feeMsat),
          amt_out: String(f.tokens),
          amt_out_msat: String(f.tokens * 1000),
          chan_id_in: chanNumber(f.inId),
          chan_id_out: chanNumber(f.outId),
          fee: String(Math.floor(f.feeMsat / 1000)),
          fee_msat: String(f.feeMsat),
          timestamp: String(Math.floor(ms / 1000)),
          timestamp_ns: String(BigInt(Math.floor(ms)) * 1_000_000n),
        };
      }),
      last_offset_index: String(offset + page.length),
    });
  });
  node.override("default.getChanInfo", (a, cb) => {
    const ch = typeof a.chan_point === "string" ? byPoint.get(a.chan_point) : opts.channels.find((c) => chanNumber(c.id) === String(a.chan_id));
    if (!ch) return cb({ details: "edge not found" });
    const ours = fees.get(ch.id)!;
    const policy = (ppm: number, base: number) => ({
      disabled: false,
      fee_base_msat: String(base),
      fee_rate_milli_msat: String(ppm),
      last_update: Math.floor(Date.now() / 1000),
      max_htlc_msat: String(maxHtlcOf.get(ch.id) ?? ch.capacity * 990),
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
    requests.push(a);
    const refused = refusals.get(outpoint);
    if (refused) {
      return cb(null, {
        failed_updates: [
          {
            outpoint: { txid_bytes: Buffer.from(point.funding_txid_str, "hex").reverse(), output_index: point.output_index },
            reason: "UPDATE_FAILURE_INVALID_PARAMETER",
            update_error: refused,
          },
        ],
      });
    }
    const ch = byPoint.get(outpoint);
    const feeRatePpm = Math.round(Number(a.fee_rate) * 1_000_000);
    const baseFeeMsat = Number(a.base_fee_msat);
    writes.push({ outpoint, feeRatePpm, baseFeeMsat });
    if (ch) fees.set(ch.id, { ppm: feeRatePpm, base: baseFeeMsat });
    // As LND does: the max_htlc it took is what the channel advertises next.
    if (ch && a.max_htlc_msat !== undefined && Number(a.max_htlc_msat) > 0) maxHtlcOf.set(ch.id, Number(a.max_htlc_msat));
    cb(null, { failed_updates: [] });
  });
  return Object.assign(node, {
    policyWrites: writes,
    policyRequests: requests,
    refusals,
    feeOf: (id: string) => fees.get(id),
  });
}

/**
 * A public graph around the node (DescribeGraph) for the fee engine's market
 * reference: per channel id, three other nodes' channels into that channel's
 * peer charging `intoPpm`, and the peer's own fee back to us (`backPpm`).
 *
 *   withMarket(node, channels, { "850000x1x0": { intoPpm: 300, backPpm: 100 } });
 *
 * Returns the graph it answers with.
 */
export function withMarket(
  node: ReturnType<typeof feeNode>,
  channels: FeeChannel[],
  markets: Record<string, { intoPpm: number; backPpm?: number }>,
): { edges: Record<string, unknown>[]; nodes: never[] } {
  const policy = (ppm: number) => ({
    disabled: false,
    fee_base_msat: "0",
    fee_rate_milli_msat: String(ppm),
    last_update: Math.floor(Date.now() / 1000) - 86_400,
    max_htlc_msat: "990000000",
    min_htlc: "1000",
    time_lock_delta: 40,
  });
  const edges: Record<string, unknown>[] = [];
  let n = 0;
  for (const c of channels) {
    const m = markets[c.id];
    if (!m) continue;
    edges.push({
      capacity: String(c.capacity),
      chan_point: `${c.transactionId}:${c.transactionVout}`,
      channel_id: chanNumber(c.id),
      node1_pub: node.publicKey,
      node2_pub: c.partnerPublicKey,
      node1_policy: policy(c.feeRatePpm ?? 100),
      node2_policy: policy(m.backPpm ?? 1),
    });
    for (let k = 0; k < 3; k++) {
      n += 1;
      const other = "03" + n.toString(16).padStart(2, "0").repeat(32);
      edges.push({
        capacity: "2000000",
        chan_point: `${n.toString(16).padStart(4, "0").repeat(16)}:0`,
        channel_id: chanNumber(`840000x${n}x0`),
        node1_pub: other,
        node2_pub: c.partnerPublicKey,
        node1_policy: policy(m.intoPpm),
        node2_policy: policy(1),
      });
    }
  }
  const graph = { edges, nodes: [] as never[] };
  node.override("default.describeGraph", (_a, cb) => cb(null, graph));
  // (Returned, for a test that answers the read itself — late, say.)
  return graph;
}
