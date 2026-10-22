import type { GetChainTransactionsResult, GetClosedChannelsResult } from "lightning";
import { outputTotal, parseRawTx, type RawTx } from "./rawTx.js";

/**
 * What closing channels cost this node — review a5-analytics:close-costs-
 * always-zero.
 *
 * Before, P&L booked a chain transaction as a close cost only when LND
 * reported it outgoing WITH a fee. A close never is: it spends the 2-of-2
 * funding output, not a wallet coin, so btcwallet reports no fee for it
 * (it computes one only when every input is the wallet's), and a cooperative
 * close only pays our balance back to the wallet (amount > 0: "incoming").
 * Force-close commitments, anchor CPFPs and sweeps all have a non-wallet
 * input too. "Closes" read 0 for every node, and net profit left out every
 * close the node paid for — the sales it funded hardest of all.
 *
 * Now each closed channel's costs are worked out from the transactions
 * themselves, parsed locally from the raw hex LND keeps (rawTx.ts):
 *  - the closing transaction's fee: the funding output's value (the channel's
 *    capacity) minus what the close pays out. It falls to whoever pays it:
 *    the channel's funder for a legacy cooperative close and for every
 *    commitment (BOLT 2/3); the closer for a cooperative close made with the
 *    RBF protocol (option_simple_close: the closer pays for its own closing
 *    transaction, recognisable by its nSequence 0xfffffffd). A breach is
 *    left out: the justice transaction claims every output;
 *  - a force-closed anchor channel's anchors: the funder pays both 330-sat
 *    anchor outputs out of its balance (BOLT 3). The one no transaction of
 *    this node spent is lost to it — the peer's always, its own unless LND
 *    swept it (then its value is in that sweep's fee). The funder's close
 *    cost is the commitment's fee plus those (review of P6: up to 660 sat a
 *    force close were missing);
 *  - after a force close, every sweep this node made of the channel's
 *    outputs — to_local, HTLCs (second-level transactions too) and the anchor
 *    CPFP: what it spent minus what it paid out. A sweep that batches several
 *    channels is shared between them by the inputs each one put in. When the
 *    peer funded the channel, an anchor a CPFP spent was the peer's money:
 *    its 330 sat are not this node's cost.
 * A cost this node can't see — the closing transaction is not in its wallet
 * nor in LightningMate's copy of it (closeTxArchive.ts), a sweep spends a
 * coin the wallet doesn't know — is not guessed: the close is counted with
 * "cost unknown".
 *
 * Each fee is booked at the time its transaction was made, like every other
 * P&L cost. Only transactions known to have confirmed count (knownConfirmed):
 * a sweep LND replaced (RBF) leaves its earlier versions unconfirmed in the
 * wallet, and they must not add up. The wallet's own flag is not enough to
 * tell (review of P6): btcwallet keeps a transaction LND published that pays
 * no wallet address and spends no wallet coin — a force close's commitment,
 * a legacy second-level HTLC transaction — as unconfirmed for good, and the
 * commitment's fee, the costliest part of a force close, was silently dropped.
 */

/** One wallet transaction, as P&L needs it (from getChainTransactions). */
export interface WalletTx {
  id: string;
  createdAt: string;
  isConfirmed: boolean;
  isOutgoing: boolean;
  /** LND's fee: only when every input was a wallet coin. */
  fee?: number;
  /** The raw transaction (hex), when LND gives it. */
  transaction?: string;
  /** What each input spends, and whether that was one of the wallet's coins
   *  (LND ≥ 0.15.1; empty before). */
  inputs: { txid: string; vout: number; isLocal: boolean }[];
}

export type CloseKind = "cooperative" | "local_force" | "remote_force" | "breach";

export interface ClosedChannelFacts {
  channelId: string | null;
  capacity: number;
  fundingTxid: string;
  fundingVout: number;
  closeTxid: string;
  closeHeight: number | null;
  kind: CloseKind;
  /** This node funded the channel (null: LND doesn't say). */
  weFunded: boolean | null;
  /** This node started the close (null: LND doesn't say). */
  weClosed: boolean | null;
  /** The transactions LND names as having claimed this channel's outputs
   *  (anchor, our balance, HTLCs). */
  sweepTxids: string[];
}

export interface CloseFee {
  at: string;
  sats: number;
  txid: string;
  what: "close" | "sweep";
}

export interface CloseCost {
  channelId: string | null;
  closeTxid: string;
  kind: CloseKind;
  /** When the channel closed: its closing transaction as the wallet saw it,
   *  else estimated from the block it confirmed in; null: can't be dated. */
  closedAt: string | null;
  /** Every fee of this close that fell to this node, at the time it was paid. */
  fees: CloseFee[];
  /** Why part of what this node paid couldn't be worked out (null: it all was). */
  unknown: string | null;
}

/** nSequence of the funding input of a cooperative close made with LND's RBF
 *  close protocol (option_simple_close); the legacy close uses 0xffffffff. */
const SIMPLE_CLOSE_SEQUENCE = 0xfffffffd;
const MS_PER_BLOCK = 10 * 60_000;
/** An anchor output's value (BOLT 3, option_anchors). Nothing else in a
 *  commitment is this small: a balance or HTLC output below the dust limit
 *  (at least 354 sat) is left out of it. */
const ANCHOR_SATS = 330;

/** The wallet's transactions, as P&L reads them. */
export function walletTxsOf(transactions: GetChainTransactionsResult["transactions"]): WalletTx[] {
  return transactions.map((t) => ({
    id: t.id,
    createdAt: t.created_at,
    isConfirmed: t.is_confirmed,
    isOutgoing: t.is_outgoing,
    ...(t.fee ? { fee: t.fee } : {}),
    ...(t.transaction ? { transaction: t.transaction } : {}),
    inputs: (t.inputs ?? []).map((i) => ({ txid: i.transaction_id, vout: i.transaction_vout, isLocal: i.is_local })),
  }));
}

/** Closed channels with a closing transaction (a funding that never
 *  confirmed, or an abandoned channel, closed nothing on chain). */
export function closedFactsOf(channels: GetClosedChannelsResult["channels"]): ClosedChannelFacts[] {
  const out: ClosedChannelFacts[] = [];
  for (const c of channels) {
    if (c.is_funding_cancel || !c.close_transaction_id) continue;
    const kind: CloseKind | null = c.is_cooperative_close
      ? "cooperative"
      : c.is_local_force_close
        ? "local_force"
        : c.is_remote_force_close
          ? "remote_force"
          : c.is_breach_close
            ? "breach"
            : null;
    if (!kind) continue;
    const sweeps = [c.anchor_spent_by, c.close_balance_spent_by, ...c.close_payments.map((p) => p.spent_by)].filter(
      (id): id is string => typeof id === "string" && /^[0-9a-f]{64}$/i.test(id),
    );
    out.push({
      channelId: c.id ?? null,
      capacity: c.capacity,
      fundingTxid: c.transaction_id,
      fundingVout: c.transaction_vout,
      closeTxid: c.close_transaction_id,
      closeHeight: c.close_confirm_height ?? null,
      kind,
      weFunded: c.is_partner_initiated === undefined ? null : !c.is_partner_initiated,
      weClosed: c.is_partner_closed === undefined ? null : !c.is_partner_closed,
      sweepTxids: [...new Set(sweeps)],
    });
  }
  return out;
}

/** Each wallet transaction's raw form, parsed once (null: no hex, or a blob
 *  that can't be read — treated alike: a transaction we don't have). */
function rawReader(byId: ReadonlyMap<string, WalletTx>): (id: string) => RawTx | null {
  const parsed = new Map<string, RawTx | null>();
  return (id) => {
    if (parsed.has(id)) return parsed.get(id) ?? null;
    const hex = byId.get(id)?.transaction;
    let tx: RawTx | null = null;
    if (hex) {
      try {
        tx = parseRawTx(hex);
      } catch {
        tx = null;
      }
    }
    parsed.set(id, tx);
    return tx;
  };
}

/** Whether a transaction's input spent one of the wallet's own coins — as
 *  LND reports it (an older LND reports nothing: not the wallet's). A coin a
 *  cooperative close paid back, spent later, is an ordinary spend; the
 *  outputs of a force close (to_local, HTLCs, anchors) are not wallet coins
 *  until swept. */
const spendsWalletCoin = (t: WalletTx, txid: string, vout: number): boolean =>
  t.inputs.some((i) => i.txid === txid && i.vout === vout && i.isLocal);

/** The spend graph of the closes: each transaction's channels (indexes into
 *  the seeds) and, per channel, how many of its inputs came from that
 *  channel's outputs — to share a batched sweep. */
interface SpendTree {
  chans: Map<string, Set<number>>;
  inputs: Map<string, Map<number, number>>;
}

/**
 * Follows the spends from `seeds` (per channel: the transactions it starts
 * from — its closing transaction, the sweeps LND names): every wallet
 * transaction spending an output of one of them through an input that isn't
 * a wallet coin joins that channel — second-level HTLC transactions, the
 * sweeps after them, anchor CPFPs — until nothing new is found (each pass
 * adds at least one, so this ends).
 */
function walkSpends(seeds: readonly (readonly string[])[], txs: readonly WalletTx[], raw: (id: string) => RawTx | null): SpendTree {
  const chans = new Map<string, Set<number>>();
  const mark = (txid: string, chan: number): boolean => {
    const set = chans.get(txid) ?? new Set<number>();
    if (set.has(chan)) return false;
    set.add(chan);
    chans.set(txid, set);
    return true;
  };
  seeds.forEach((ids, i) => {
    for (const id of ids) mark(id, i);
  });
  const inputs = new Map<string, Map<number, number>>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of txs) {
      // LND worked out this one's fee itself: every input was a wallet coin
      // — an ordinary spend (an open funded from a close's payout, say),
      // never a sweep, which always spends a channel output.
      if (t.fee) continue;
      const tx = raw(t.id);
      if (!tx) continue;
      const counts = new Map<number, number>();
      for (const i of tx.inputs) {
        const from = chans.get(i.txid);
        if (!from || spendsWalletCoin(t, i.txid, i.vout)) continue;
        for (const chan of from) counts.set(chan, (counts.get(chan) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      inputs.set(t.id, counts);
      for (const chan of counts.keys()) if (mark(t.id, chan)) grew = true;
    }
  }
  return { chans, inputs };
}

/**
 * The sweeps (and second-level transactions) known to have confirmed:
 *  - the wallet says so;
 *  - LND names it as having claimed one of a channel's outputs: it records
 *    such a resolution once the spend confirmed;
 *  - a transaction known to have confirmed spends one of its outputs: a
 *    transaction only confirms once everything it spends has.
 * The wallet's flag alone misses what btcwallet never sees mined (it keeps a
 * published transaction that pays no wallet address and spends no wallet
 * coin as unconfirmed — a legacy second-level HTLC transaction, like a
 * commitment). What none of these vouch for — a sweep LND replaced (RBF),
 * left unconfirmed in the wallet — never confirmed.
 */
function knownConfirmed(closed: readonly ClosedChannelFacts[], txs: readonly WalletTx[], raw: (id: string) => RawTx | null): Set<string> {
  const known = new Set<string>();
  const queue: string[] = [];
  const add = (id: string) => {
    if (known.has(id)) return;
    known.add(id);
    queue.push(id);
  };
  for (const t of txs) if (t.isConfirmed) add(t.id);
  for (const c of closed) for (const s of c.sweepTxids) add(s);
  while (queue.length > 0) {
    const tx = raw(queue.pop() as string);
    if (tx) for (const i of tx.inputs) add(i.txid);
  }
  return known;
}

/**
 * The cost of every close in `closed`, from the wallet's transactions — pure:
 * no node, no network.
 */
export function closeCostsFrom(
  closed: readonly ClosedChannelFacts[],
  txs: readonly WalletTx[],
  opts: { nowMs: number; height: number | null },
): CloseCost[] {
  const byId = new Map(txs.map((t) => [t.id, t]));
  const raw = rawReader(byId);
  /** A transaction's fee: what it spent minus what it paid out — null when
   *  an input spends an output of a transaction the wallet doesn't hold. */
  const feeOf = (id: string): number | null => {
    const tx = raw(id);
    if (!tx) return null;
    let spent = 0;
    for (const i of tx.inputs) {
      const v = raw(i.txid)?.outputs[i.vout]?.value;
      if (v === undefined) return null;
      spent += v;
    }
    const fee = spent - outputTotal(tx);
    return fee >= 0 ? fee : null;
  };

  // Which channel's close each sweep descends from (a batched sweep:
  // several). Seeds: every force close's closing transaction, and the sweeps
  // LND names; a cooperative close has nothing to sweep (both outputs are
  // final).
  const { chans: tree, inputs: treeInputs } = walkSpends(
    closed.map((c) => (c.kind === "cooperative" ? [] : [c.closeTxid, ...c.sweepTxids.filter((s) => byId.has(s))])),
    txs,
    raw,
  );
  const confirmed = knownConfirmed(closed, txs, raw);

  const estimateAt = (height: number | null): string | null =>
    height !== null && opts.height !== null && opts.height >= height
      ? new Date(opts.nowMs - (opts.height - height) * MS_PER_BLOCK).toISOString()
      : null;

  return closed.map((c, idx): CloseCost => {
    const closeWallet = byId.get(c.closeTxid);
    const closeTx = raw(c.closeTxid);
    const fees: CloseFee[] = [];
    const unknown: string[] = [];

    // This close's sweeps known to have confirmed, and the anchors of its
    // commitment (a force close's closing transaction) — a cooperative close
    // has none.
    const sweeps = [...tree]
      .filter(([txid, chans]) => txid !== c.closeTxid && chans.has(idx) && byId.has(txid) && confirmed.has(txid))
      .map(([txid]) => txid);
    const anchors =
      closeTx && (c.kind === "local_force" || c.kind === "remote_force")
        ? new Set(closeTx.outputs.flatMap((o, vout) => (o.value === ANCHOR_SATS ? [vout] : [])))
        : new Set<number>();
    /** The anchors of this close a transaction spends (their output indexes). */
    const anchorsSpentBy = (txid: string): number[] =>
      (raw(txid)?.inputs ?? []).filter((i) => i.txid === c.closeTxid && anchors.has(i.vout)).map((i) => i.vout);

    // ── the closing transaction's fee, when it fell to this node ──
    const simpleClose =
      c.kind === "cooperative" && closeTx !== null && closeTx.inputs.length === 1 && closeTx.inputs[0].sequence === SIMPLE_CLOSE_SEQUENCE;
    const payer: boolean | null = c.kind === "breach" ? false : simpleClose ? c.weClosed : c.weFunded;
    if (payer === null) {
      unknown.push(simpleClose ? "LND doesn't say who closed it" : "LND doesn't say who funded it");
    } else if (payer) {
      if (!closeTx || !closeWallet) {
        unknown.push("its closing transaction is not in this node's wallet");
      } else if (closeTx.inputs.length !== 1 || closeTx.inputs[0].txid !== c.fundingTxid || closeTx.inputs[0].vout !== c.fundingVout) {
        unknown.push("its closing transaction doesn't spend the channel's funding output");
      } else {
        const fee = c.capacity - outputTotal(closeTx);
        // The funder paid both anchors out of its balance: those no sweep of
        // ours spent are gone with the commitment's fee (one we swept is in
        // that sweep's fee, as one of its inputs). A sweep still to come
        // takes its anchor back out of here once it confirmed.
        const swept = new Set(sweeps.flatMap(anchorsSpentBy));
        const anchorsLost = (anchors.size - swept.size) * ANCHOR_SATS;
        if (fee < 0) unknown.push("its closing transaction pays out more than the channel held");
        // Whatever the wallet's own flag says: the channel is listed as
        // closed, so this transaction confirmed (a commitment we published
        // stays "unconfirmed" in btcwallet for good).
        else if (fee + anchorsLost > 0) fees.push({ at: closeWallet.createdAt, sats: fee + anchorsLost, txid: c.closeTxid, what: "close" });
      }
    }

    // ── every sweep of its outputs this node made (a share of a batched one) ──
    for (const txid of sweeps) {
      const t = byId.get(txid) as WalletTx;
      const fee = feeOf(txid);
      if (fee === null) {
        unknown.push("a sweep of it spends a coin this node's wallet doesn't know");
        continue;
      }
      const counts = treeInputs.get(txid);
      const total = counts ? [...counts.values()].reduce((s, n) => s + n, 0) : 0;
      // A sweep LND names whose inputs can't be traced (an older LND): shared
      // evenly between the channels that name it.
      const share = counts && total > 0 ? (counts.get(idx) ?? 0) / total : 1 / (tree.get(txid)?.size ?? 1);
      let sats = Math.round(fee * share);
      // The peer funded the channel: the anchor a CPFP of ours spent was the
      // peer's 330 sat (BOLT 3) — in the fee, but not this node's money (a
      // CPFP its anchor paid for alone cost this node nothing).
      if (c.weFunded === false) sats -= anchorsSpentBy(txid).length * ANCHOR_SATS;
      if (sats > 0) fees.push({ at: t.createdAt, sats, txid, what: "sweep" });
    }

    return {
      channelId: c.channelId,
      closeTxid: c.closeTxid,
      kind: c.kind,
      closedAt: closeWallet?.createdAt ?? estimateAt(c.closeHeight),
      fees,
      unknown: unknown.length ? [...new Set(unknown)].join("; ") : null,
    };
  });
}

/**
 * Every wallet transaction a close's cost is worked out from: those of
 * `seeds` (closing transactions — of closed channels and of channels still
 * closing — and the sweeps LND names) and every transaction spending a
 * channel output of them, transitively: the walk closeCostsFrom makes.
 * LightningMate keeps a copy of each (closeTxArchive.ts) — LND's wallet
 * forgets some of them at its next restart.
 */
export function closeTxidsOf(seeds: Iterable<string>, txs: readonly WalletTx[]): Set<string> {
  const byId = new Map(txs.map((t) => [t.id, t]));
  const { chans } = walkSpends([[...seeds]], txs, rawReader(byId));
  return new Set([...chans.keys()].filter((id) => byId.has(id)));
}

/** The transactions a close cost is made of (closing transactions and every
 *  sweep found) — so P&L doesn't book any of them a second time elsewhere. */
export function closeCostTxids(costs: readonly CloseCost[]): Set<string> {
  const ids = new Set<string>();
  for (const c of costs) {
    ids.add(c.closeTxid);
    for (const f of c.fees) ids.add(f.txid);
  }
  return ids;
}
