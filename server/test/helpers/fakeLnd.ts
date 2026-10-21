import { EventEmitter } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import type { AuthenticatedLnd } from "lightning";
import { makeNodeKey, makePaymentRequest, parsePaymentRequest, type NodeKey } from "./bolt11.js";

/**
 * An in-memory LND that speaks the gRPC shapes the `lightning` library expects.
 *
 * The app never talks gRPC itself — it calls `lightning` functions such as
 * `getChannels({ lnd })`, which call `lnd.default.listChannels(args, cb)` and
 * then run strict response validators. This fake implements those callback /
 * stream methods with responses that pass the validators, so tests exercise
 * the real library code paths (argument mapping, validation, error mapping)
 * against a node whose state the test controls:
 *
 *   const node = new FakeLnd({ chainBalance: 5_000_000, channels: [{ … }] });
 *   await getChannels({ lnd: node.lnd });        // real library call
 *   node.callsTo("router.sendPaymentV2")          // what was sent to "LND"
 *
 * Implemented (namespace.method → lightning function):
 *   default.getInfo → getWalletInfo          default.listChannels → getChannels
 *   default.pendingChannels → getPendingChannels
 *   default.walletBalance → getChainBalance / getPendingChainBalance
 *   default.channelBalance → getChannelBalance
 *   default.exportAllChannelBackups → getBackups
 *   default.decodePayReq → decodePaymentRequest
 *   default.addInvoice / default.lookupInvoice → createInvoice / getInvoice
 *   default.listInvoices → getInvoices (newest first, paged, created_after)
 *   invoices.addHoldInvoice / settleInvoice / cancelInvoice → createHodlInvoice,
 *     settleHodlInvoice, cancelHodlInvoice; invoices.subscribeSingleInvoice
 *     (stream) → subscribeToInvoice
 *   default.listPeers / default.connectPeer → getPeers / addPeer
 *   default.openChannel (stream) → openChannel
 *   router.sendPaymentV2 (stream) → pay / payViaPaymentRequest / payViaPaymentDetails
 *   router.trackPaymentV2 (stream) → getPayment
 *   chain.registerBlockEpochNtfn (stream) → subscribeToBlocks / getHeight
 *
 * Anything else: `node.override("default.feeReport", (args, cb) => cb(null, {...}))`.
 * A method that is neither implemented nor overridden is ABSENT, so the
 * library fails fast with its "ExpectedLnd…" error instead of hanging.
 *
 * Payments: `payOutcome` decides what `sendPaymentV2` does — "succeed",
 * "fail", or "hang" (stays IN_FLIGHT until `resolvePayment()`), which is how
 * a test reproduces a stuck HTLC.
 *
 * HODL invoices: `payHoldInvoice(id)` plays the buyer — an HTLC arrives and is
 * held (state ACCEPTED) until the code under test settles or cancels it.
 */

type Callback = (err: unknown, res?: unknown) => void;
type GrpcArgs = Record<string, unknown>;
export type UnaryImpl = (args: GrpcArgs, cb: Callback) => void;
export type StreamImpl = (args: GrpcArgs) => EventEmitter;

export interface FakeChannel {
  /** Standard format "block x tx x out"; derived from the position if omitted. */
  id?: string;
  partnerPublicKey: string;
  capacity: number;
  localBalance: number;
  remoteBalance?: number;
  transactionId: string;
  transactionVout: number;
  isActive?: boolean;
  isPrivate?: boolean;
  /** Opened by the peer, not by this node (default: by this node). */
  partnerInitiated?: boolean;
}

export interface FakePendingChannel {
  partnerPublicKey: string;
  capacity: number;
  localBalance?: number;
  transactionId: string;
  transactionVout: number;
  /** "opening" (default) or a cooperative/force close waiting to confirm. */
  state?: "opening" | "waiting_close";
  /** Opened by the peer, not by this node (default: by this node). */
  partnerInitiated?: boolean;
}

export interface FakeInvoice {
  id: string;
  /** Preimage — "" for a HODL invoice until it is settled. */
  secret: string;
  request: string;
  tokens: number;
  /** Exact amount, millisats. */
  mtokens: string;
  description: string;
  createdAtSec: number;
  expirySec: number;
  state: "OPEN" | "ACCEPTED" | "SETTLED" | "CANCELED";
  receivedSats: number;
  /** A HODL invoice (settles only with settleInvoice). */
  hold?: boolean;
  /** Final CLTV delta asked for when it was created. */
  cltvDelta?: number;
  /** HTLCs paying it (held, settled or cancelled). */
  htlcs?: { amtMsat: string; expiryHeight: number; acceptHeight: number; state: "ACCEPTED" | "SETTLED" | "CANCELED" }[];
}

export interface FakePayment {
  id: string;
  request?: string;
  destination: string;
  tokens: number;
  feeMsat: string;
  status: "IN_FLIGHT" | "SUCCEEDED" | "FAILED";
  preimage: string;
  /** The exact SendPaymentV2 request the library built. */
  params: GrpcArgs;
}

export type PayOutcome = "succeed" | "fail" | "hang";

export interface FakeLndOptions {
  key?: NodeKey;
  alias?: string;
  uris?: string[];
  blockHeight?: number;
  chainBalance?: number;
  channels?: FakeChannel[];
  pending?: FakePendingChannel[];
  /** Connected peer public keys. */
  peers?: string[];
}

const rand32 = (): string => randomBytes(32).toString("hex");
const nowSec = (): number => Math.floor(Date.now() / 1000);
/** LND reports txids in display order but carries them reversed in OutPoints. */
const txidBytes = (hex: string): Buffer => Buffer.from(hex, "hex").reverse();

function chanNumber(id: string): string {
  const [block, tx, out] = id.split("x").map((n) => BigInt(n));
  return ((block << 40n) | (tx << 16n) | out).toString();
}

const constraints = {
  chan_reserve_sat: "10000",
  csv_delay: 144,
  dust_limit_sat: "354",
  max_accepted_htlcs: 483,
  max_pending_amt_msat: "990000000",
  min_htlc_msat: "1",
};

/** Our side of a pending channel: all of it when we funded it, none when the
 *  peer did (unless the test says otherwise). */
const pendingLocal = (p: FakePendingChannel): number => p.localBalance ?? (p.partnerInitiated ? 0 : p.capacity);

/** Emit on the next tick so listeners attached after the call still see it. */
function later(fn: () => void): void {
  setImmediate(fn);
}

function stream(): EventEmitter & { cancel: () => void } {
  return Object.assign(new EventEmitter(), { cancel: () => undefined });
}

export class FakeLnd {
  readonly key: NodeKey;
  readonly lnd: AuthenticatedLnd;
  alias: string;
  uris: string[];
  blockHeight: number;
  chainBalance: number;
  channels: FakeChannel[];
  pending: FakePendingChannel[];
  peers: string[];
  readonly invoices = new Map<string, FakeInvoice>();
  readonly payments = new Map<string, FakePayment>();
  /** What the next payments do. A function decides per payment. */
  payOutcome: PayOutcome | ((p: FakePayment) => PayOutcome) = "succeed";
  /** Routing fee charged on successful payments. */
  routingFeeMsat = 2_000;
  /** Next channel opens: succeed (pending channel) or fail with this LND status text. */
  openFailure: string | null = null;
  /** Every gRPC call, in order. */
  readonly calls: { method: string; args: GrpcArgs }[] = [];
  /** Runs as each call arrives, before LND acts on it — e.g. to look at the
   *  disk at exactly that moment. */
  beforeCall: ((method: string, args: GrpcArgs) => void) | null = null;
  private readonly overrides = new Map<string, UnaryImpl | StreamImpl>();
  private readonly failures: { method: string; details: string; when: () => boolean }[] = [];
  private readonly paymentStreams = new Map<string, EventEmitter[]>();
  private readonly invoiceStreams = new Map<string, EventEmitter[]>();

  constructor(opts: FakeLndOptions = {}) {
    this.key = opts.key ?? makeNodeKey();
    this.alias = opts.alias ?? "fake-node";
    this.uris = opts.uris ?? [`${this.key.publicKey}@abcdefghijklmnop.onion:9735`];
    this.blockHeight = opts.blockHeight ?? 860_000;
    this.chainBalance = opts.chainBalance ?? 0;
    this.channels = opts.channels ?? [];
    this.pending = opts.pending ?? [];
    this.peers = opts.peers ?? [];

    const impls: Record<string, Record<string, UnaryImpl | StreamImpl>> = {
      default: {
        getInfo: (_a, cb) => cb(null, this.infoRpc()),
        listChannels: (_a, cb) => cb(null, { channels: this.channels.map((c, i) => this.channelRpc(c, i)) }),
        pendingChannels: (_a, cb) => cb(null, this.pendingRpc()),
        walletBalance: (_a, cb) =>
          cb(null, {
            confirmed_balance: String(this.chainBalance),
            unconfirmed_balance: "0",
            total_balance: String(this.chainBalance),
            locked_balance: "0",
            reserved_balance_anchor_chan: "10000",
            account_balance: {},
          }),
        channelBalance: (_a, cb) =>
          cb(null, {
            balance: String(this.channels.reduce((s, c) => s + c.localBalance, 0)),
            pending_open_balance: String(this.pending.reduce((s, p) => s + pendingLocal(p), 0)),
          }),
        exportAllChannelBackups: (_a, cb) => cb(null, this.backupsRpc()),
        decodePayReq: (a, cb) => {
          try {
            cb(null, this.decodeRpc(String(a.pay_req)));
          } catch (err) {
            cb({ details: `invalid payment request: ${(err as Error).message}` });
          }
        },
        addInvoice: (a, cb) => cb(null, this.addInvoiceRpc(a)),
        lookupInvoice: (a, cb) => {
          const id = Buffer.from(a.r_hash as Buffer).toString("hex");
          const inv = this.invoices.get(id);
          if (!inv) cb({ details: "unable to locate invoice" });
          else cb(null, this.invoiceRpc(inv));
        },
        listInvoices: (a, cb) => cb(null, this.listInvoicesRpc(a)),
        listPeers: (_a, cb) => cb(null, { peers: this.peers.map((pk) => this.peerRpc(pk)) }),
        connectPeer: (a, cb) => {
          const addr = a.addr as { pubkey: string };
          if (!this.peers.includes(addr.pubkey)) this.peers.push(addr.pubkey);
          cb(null, {});
        },
        openChannel: (a: GrpcArgs) => this.openChannelStream(a),
      },
      router: {
        sendPaymentV2: (a: GrpcArgs) => this.sendPaymentStream(a),
        trackPaymentV2: (a: GrpcArgs) => this.trackPaymentStream(a),
      },
      chain: {
        // Block notifications: the current tip right away (as LND does).
        registerBlockEpochNtfn: () => {
          const s = stream();
          later(() => s.emit("data", { hash: randomBytes(32), height: this.blockHeight }));
          return s;
        },
      },
      invoices: {
        addHoldInvoice: (a, cb) => cb(null, this.addHoldInvoiceRpc(a)),
        settleInvoice: (a, cb) => {
          const secret = Buffer.from(a.preimage as Buffer).toString("hex");
          const inv = this.invoices.get(paymentHashOf(secret));
          if (!inv) return cb({ details: "unable to locate invoice" });
          if (inv.state === "SETTLED") return cb(null, {});
          if (inv.state !== "ACCEPTED") return cb({ details: inv.state === "OPEN" ? "invoice still open" : "invoice already canceled" });
          inv.state = "SETTLED";
          inv.secret = secret;
          for (const h of inv.htlcs ?? []) if (h.state === "ACCEPTED") h.state = "SETTLED";
          this.emitInvoice(inv);
          cb(null, {});
        },
        cancelInvoice: (a, cb) => {
          const inv = this.invoices.get(Buffer.from(a.payment_hash as Buffer).toString("hex"));
          if (!inv) return cb({ details: "unable to locate invoice" });
          if (inv.state === "SETTLED") return cb({ details: "invoice already settled" });
          inv.state = "CANCELED";
          for (const h of inv.htlcs ?? []) if (h.state === "ACCEPTED") h.state = "CANCELED";
          this.emitInvoice(inv);
          cb(null, {});
        },
        subscribeSingleInvoice: (a: GrpcArgs) => {
          const id = Buffer.from(a.r_hash as Buffer).toString("hex");
          const s = stream();
          this.invoiceStreams.set(id, [...(this.invoiceStreams.get(id) ?? []), s]);
          later(() => {
            const inv = this.invoices.get(id);
            if (inv) s.emit("data", this.invoiceRpc(inv));
          });
          return s;
        },
      },
    };

    const namespace = (ns: string) =>
      new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (typeof prop !== "string") return undefined;
            const name = `${ns}.${prop}`;
            const impl = this.overrides.get(name) ?? impls[ns]?.[prop];
            if (!impl) return undefined;
            return (args: GrpcArgs, cb?: Callback) => {
              this.calls.push({ method: name, args });
              this.beforeCall?.(name, args);
              const failure = cb ? this.failures.findIndex((f) => f.method === name && f.when()) : -1;
              if (failure >= 0) {
                const [f] = this.failures.splice(failure, 1);
                return cb!({ details: f.details });
              }
              return cb ? (impl as UnaryImpl)(args, cb) : (impl as StreamImpl)(args);
            };
          },
        },
      );
    this.lnd = {
      default: namespace("default"),
      router: namespace("router"),
      invoices: namespace("invoices"),
      wallet: namespace("wallet"),
      chain: namespace("chain"),
      peers: namespace("peers"),
      signer: namespace("signer"),
      version: namespace("version"),
    } as unknown as AuthenticatedLnd;
  }

  get publicKey(): string {
    return this.key.publicKey;
  }

  /** Replace or add a gRPC method, e.g. "default.feeReport". */
  override(method: string, impl: UnaryImpl | StreamImpl): void {
    this.overrides.set(method, impl);
  }

  /** The next call of the unary method `method` for which `when` says yes
   *  fails with LND's `details` text (once); every other call is answered as
   *  usual — LND blinking at exactly one moment. */
  failNext(method: string, details: string, when: () => boolean = () => true): void {
    this.failures.push({ method, details, when });
  }

  /** Arguments of every call to one gRPC method, in order. */
  callsTo(method: string): GrpcArgs[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.args);
  }

  /** An invoice issued BY this node (destination = this node's key). */
  makeOwnRequest(tokens: number, description = ""): string {
    return makePaymentRequest({ key: this.key, tokens, description }).request;
  }

  /**
   * The buyer pays a HODL invoice: an HTLC for its amount (or `mtokens`)
   * arrives and is HELD until settled or cancelled. `expiryHeight` is the
   * HTLC's CLTV expiry (default: tip + the invoice's final CLTV delta).
   */
  payHoldInvoice(id: string, opts: { mtokens?: string; expiryHeight?: number } = {}): void {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error(`no invoice ${id}`);
    if (!inv.hold) throw new Error(`invoice ${id} is not a HODL invoice`);
    if (inv.state !== "OPEN") throw new Error(`invoice ${id} is ${inv.state}`);
    inv.htlcs = [
      ...(inv.htlcs ?? []),
      {
        amtMsat: opts.mtokens ?? inv.mtokens,
        expiryHeight: opts.expiryHeight ?? this.blockHeight + (inv.cltvDelta ?? 40),
        acceptHeight: this.blockHeight,
        state: "ACCEPTED",
      },
    ];
    inv.state = "ACCEPTED";
    this.emitInvoice(inv);
  }

  /**
   * A plain (non-HODL) invoice of this node — the kind 0.7.x accepted Magma
   * orders with. `paid` settles it as the buyer's payment would have (a plain
   * invoice settles the moment it is paid). Returns its payment hash.
   */
  addPlainInvoice(opts: { tokens: number; description: string; paid?: boolean }): string {
    const res = this.addInvoiceRpc({ value_msat: String(opts.tokens * 1000), memo: opts.description, expiry: 49 * 3600 });
    const id = Buffer.from(res.r_hash).toString("hex");
    const inv = this.invoices.get(id)!;
    if (opts.paid) {
      inv.state = "SETTLED";
      inv.receivedSats = opts.tokens;
    }
    return id;
  }

  /** LND's own expiry handling: a held HTLC near its expiry is cancelled. */
  expireHoldInvoice(id: string): void {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error(`no invoice ${id}`);
    inv.state = "CANCELED";
    for (const h of inv.htlcs ?? []) if (h.state === "ACCEPTED") h.state = "CANCELED";
    this.emitInvoice(inv);
  }

  private emitInvoice(inv: FakeInvoice): void {
    for (const s of this.invoiceStreams.get(inv.id) ?? []) s.emit("data", this.invoiceRpc(inv));
  }

  /** Finish a payment left IN_FLIGHT by payOutcome "hang". */
  resolvePayment(id: string, outcome: "succeed" | "fail"): void {
    const p = this.payments.get(id);
    if (!p) throw new Error(`no payment ${id}`);
    p.status = outcome === "succeed" ? "SUCCEEDED" : "FAILED";
    for (const s of this.paymentStreams.get(id) ?? []) s.emit("data", this.paymentRpc(p));
  }

  // ── response builders (shapes the library validators require) ─────────────

  private infoRpc() {
    return {
      alias: this.alias,
      best_header_timestamp: String(nowSec()),
      block_hash: "00".repeat(32),
      block_height: this.blockHeight,
      chains: [{ chain: "bitcoin", network: "mainnet" }],
      color: "#3399ff",
      commit_hash: "",
      features: {},
      identity_pubkey: this.key.publicKey,
      num_active_channels: this.channels.filter((c) => c.isActive !== false).length,
      num_inactive_channels: this.channels.filter((c) => c.isActive === false).length,
      num_peers: this.peers.length,
      num_pending_channels: this.pending.length,
      synced_to_chain: true,
      synced_to_graph: true,
      testnet: false,
      uris: this.uris,
      version: "0.18.3-beta",
    };
  }

  private channelRpc(c: FakeChannel, index: number) {
    const id = c.id ?? `${800_000 + index}x1x${c.transactionVout}`;
    return {
      active: c.isActive ?? true,
      alias_scids: [],
      capacity: String(c.capacity),
      chan_id: chanNumber(id),
      channel_point: `${c.transactionId}:${c.transactionVout}`,
      chan_status_flags: "ChanStatusDefault",
      close_address: "",
      commit_fee: "2810",
      commit_weight: "1116",
      commitment_type: "ANCHORS",
      csv_delay: 144,
      fee_per_kw: "253",
      initiator: !c.partnerInitiated,
      lifetime: "86400",
      local_balance: String(c.localBalance),
      local_chan_reserve_sat: "10000",
      local_constraints: constraints,
      memo: "",
      num_updates: "12",
      pending_htlcs: [],
      private: c.isPrivate ?? false,
      push_amount_sat: "0",
      remote_balance: String(c.remoteBalance ?? Math.max(0, c.capacity - c.localBalance)),
      remote_chan_reserve_sat: "10000",
      remote_constraints: constraints,
      remote_pubkey: c.partnerPublicKey,
      thaw_height: 0,
      total_satoshis_received: "0",
      total_satoshis_sent: "0",
      unsettled_balance: "0",
      uptime: "86400",
      zero_conf_confirmed_scid: "0",
    };
  }

  private pendingChannelRpc(p: FakePendingChannel) {
    return {
      capacity: String(p.capacity),
      channel_point: `${p.transactionId}:${p.transactionVout}`,
      chan_status_flags: "",
      commitment_type: "ANCHORS",
      initiator: p.partnerInitiated ? "INITIATOR_REMOTE" : "INITIATOR_LOCAL",
      local_balance: String(pendingLocal(p)),
      local_chan_reserve_sat: "0",
      memo: "",
      num_forwarding_packages: "0",
      private: false,
      remote_balance: "0",
      remote_chan_reserve_sat: "0",
      remote_node_pub: p.partnerPublicKey,
    };
  }

  private pendingRpc() {
    const opening = this.pending.filter((p) => (p.state ?? "opening") === "opening");
    const closing = this.pending.filter((p) => p.state === "waiting_close");
    return {
      total_limbo_balance: "0",
      pending_open_channels: opening.map((p) => ({
        channel: this.pendingChannelRpc(p),
        commit_fee: "2810",
        commit_weight: "1116",
        fee_per_kw: "253",
        confirmation_height: 0,
        funding_expiry_blocks: 2016,
      })),
      waiting_close_channels: closing.map((p) => ({
        channel: this.pendingChannelRpc(p),
        limbo_balance: String(pendingLocal(p)),
        closing_txid: rand32(),
        closing_tx_hex: "",
      })),
      pending_force_closing_channels: [],
    };
  }

  /** LND's SCB covers open, pending-open and waiting-close channels. */
  private backupsRpc() {
    const population = [
      ...this.channels.map((c) => ({ txid: c.transactionId, vout: c.transactionVout })),
      ...this.pending.map((p) => ({ txid: p.transactionId, vout: p.transactionVout })),
    ];
    return {
      multi_chan_backup: {
        chan_points: population.map((o) => ({ funding_txid_bytes: txidBytes(o.txid), output_index: o.vout })),
        multi_chan_backup: randomBytes(96),
      },
      single_chan_backups: {
        chan_backups: population.map((o) => ({
          chan_backup: randomBytes(48),
          chan_point: { funding_txid_bytes: txidBytes(o.txid), output_index: o.vout },
        })),
      },
    };
  }

  private decodeRpc(request: string) {
    const p = parsePaymentRequest(request);
    const created = Math.floor(Date.parse(p.created_at) / 1000);
    const expires = Math.floor(Date.parse(p.expires_at) / 1000);
    return {
      destination: p.destination,
      payment_hash: p.id,
      num_satoshis: String(p.tokens ?? 0),
      num_msat: p.mtokens ?? "0",
      timestamp: String(created),
      expiry: String(Math.max(1, expires - created)),
      description: p.description ?? "",
      description_hash: p.description_hash ?? "",
      fallback_addr: "",
      cltv_expiry: String(p.cltv_delta ?? 40),
      route_hints: [],
      payment_addr: p.payment ? Buffer.from(p.payment, "hex") : Buffer.alloc(0),
      features: {},
    };
  }

  private addInvoiceRpc(a: GrpcArgs) {
    const secret = a.r_preimage ? Buffer.from(a.r_preimage as Buffer).toString("hex") : rand32();
    const mtokens = a.value_msat ? String(a.value_msat) : undefined;
    const expirySec = Number(a.expiry) || 3600;
    const made = makePaymentRequest({
      key: this.key,
      mtokens,
      description: typeof a.memo === "string" ? a.memo : "",
      expiresAt: new Date(Date.now() + expirySec * 1000).toISOString(),
      secret,
    });
    this.invoices.set(made.id, {
      id: made.id,
      secret,
      request: made.request,
      tokens: mtokens ? Math.floor(Number(mtokens) / 1000) : 0,
      mtokens: mtokens ?? "0",
      description: typeof a.memo === "string" ? a.memo : "",
      createdAtSec: nowSec(),
      expirySec,
      state: "OPEN",
      receivedSats: 0,
    });
    return {
      r_hash: Buffer.from(made.id, "hex"),
      payment_request: made.request,
      add_index: String(this.invoices.size),
      payment_addr: randomBytes(32),
    };
  }

  private addHoldInvoiceRpc(a: GrpcArgs) {
    const id = Buffer.from(a.hash as Buffer).toString("hex");
    const mtokens = a.value_msat ? String(a.value_msat) : a.value ? String(Number(a.value) * 1000) : "0";
    const expirySec = Number(a.expiry) || 3600;
    const cltvDelta = Number(a.cltv_expiry) || undefined;
    const made = makePaymentRequest({
      key: this.key,
      id,
      mtokens: mtokens === "0" ? undefined : mtokens,
      description: typeof a.memo === "string" ? a.memo : "",
      expiresAt: new Date(Date.now() + expirySec * 1000).toISOString(),
      cltvDelta,
    });
    this.invoices.set(id, {
      id,
      secret: "",
      request: made.request,
      tokens: Math.floor(Number(mtokens) / 1000),
      mtokens,
      description: typeof a.memo === "string" ? a.memo : "",
      createdAtSec: nowSec(),
      expirySec,
      state: "OPEN",
      receivedSats: 0,
      hold: true,
      cltvDelta,
      htlcs: [],
    });
    return { payment_request: made.request, add_index: String(this.invoices.size), payment_addr: randomBytes(32) };
  }

  /** ListInvoices with reversed=true, as the library asks: the newest
   *  `num_max_invoices` added before `index_offset` (all, when 0), within the
   *  creation dates given. Add indexes follow the order invoices were made. */
  private listInvoicesRpc(a: GrpcArgs) {
    const start = Number(a.creation_date_start) || 0;
    const end = Number(a.creation_date_end) || Number.POSITIVE_INFINITY;
    const offset = Number(a.index_offset) || 0;
    const max = Number(a.num_max_invoices) || 100;
    const indexed = [...this.invoices.values()]
      .map((inv, i) => ({ inv, index: i + 1 }))
      .filter(({ inv }) => inv.createdAtSec >= start && inv.createdAtSec <= end)
      .filter(({ inv }) => a.pending_only !== true || inv.state === "OPEN" || inv.state === "ACCEPTED");
    const page = (offset > 0 ? indexed.filter((x) => x.index < offset) : indexed).slice(-max);
    return {
      invoices: page.map(({ inv, index }) => ({ ...this.invoiceRpc(inv), add_index: String(index) })),
      first_index_offset: String(page[0]?.index ?? 0),
      last_index_offset: String(page[page.length - 1]?.index ?? 0),
    };
  }

  private invoiceRpc(inv: FakeInvoice) {
    const htlcs = inv.htlcs ?? [];
    const paidMsat = htlcs.filter((h) => h.state !== "CANCELED").reduce((s, h) => s + BigInt(h.amtMsat), 0n);
    const paid = inv.hold ? paidMsat : BigInt(inv.receivedSats) * 1000n;
    return {
      add_index: "1",
      amt_paid_msat: String(paid),
      amt_paid_sat: String(paid / 1000n),
      cltv_expiry: String(inv.cltvDelta ?? 80),
      creation_date: String(inv.createdAtSec),
      description_hash: Buffer.alloc(0),
      expiry: String(inv.expirySec),
      fallback_addr: "",
      features: {},
      htlcs: htlcs.map((h, i) => ({
        accept_height: h.acceptHeight,
        accept_time: String(nowSec()),
        amt_msat: h.amtMsat,
        chan_id: chanNumber("800000x1x0"),
        custom_records: {},
        expiry_height: h.expiryHeight,
        htlc_index: String(i + 1),
        mpp_total_amt_msat: h.amtMsat,
        resolve_time: h.state === "ACCEPTED" ? "0" : String(nowSec()),
        state: h.state,
      })),
      is_amp: false,
      is_keysend: false,
      memo: inv.description,
      payment_addr: randomBytes(32),
      payment_request: inv.request,
      private: false,
      r_hash: Buffer.from(inv.id, "hex"),
      r_preimage: Buffer.from(inv.secret, "hex"),
      settle_date: inv.state === "SETTLED" ? String(nowSec()) : "0",
      settle_index: inv.state === "SETTLED" ? "1" : "0",
      state: inv.state,
      value: String(inv.tokens),
      value_msat: inv.mtokens,
    };
  }

  private peerRpc(pubkey: string) {
    return {
      address: "127.0.0.1:9735",
      bytes_recv: "0",
      bytes_sent: "0",
      errors: [],
      features: {},
      flap_count: 0,
      inbound: false,
      last_flap_ns: "0",
      ping_time: "0",
      pub_key: pubkey,
      sat_recv: "0",
      sat_sent: "0",
      sync_type: "ACTIVE_SYNC",
    };
  }

  // ── streams ────────────────────────────────────────────────────────────────

  private openChannelStream(a: GrpcArgs) {
    const s = stream();
    later(() => {
      if (this.openFailure) {
        s.emit("status", { details: this.openFailure });
        return;
      }
      const partner = Buffer.from(a.node_pubkey as Buffer).toString("hex");
      const amount = Number(a.local_funding_amount);
      const txid = rand32();
      this.chainBalance -= amount;
      this.pending.push({ partnerPublicKey: partner, capacity: amount, transactionId: txid, transactionVout: 0 });
      s.emit("data", { update: "chan_pending", chan_pending: { txid: txidBytes(txid), output_index: 0 } });
    });
    return s;
  }

  private paymentRpc(p: FakePayment) {
    const ns = String(BigInt(Date.now()) * 1_000_000n);
    const succeeded = p.status === "SUCCEEDED";
    const htlcStatus = p.status === "SUCCEEDED" ? "SUCCEEDED" : p.status === "FAILED" ? "FAILED" : "IN_FLIGHT";
    return {
      creation_date: String(nowSec()),
      creation_time_ns: ns,
      failure_reason: p.status === "FAILED" ? "FAILURE_REASON_NO_ROUTE" : "FAILURE_REASON_NONE",
      fee: String(Math.floor(Number(p.feeMsat) / 1000)),
      fee_msat: p.feeMsat,
      fee_sat: String(Math.floor(Number(p.feeMsat) / 1000)),
      htlcs: [
        {
          attempt_time_ns: ns,
          resolve_time_ns: p.status === "IN_FLIGHT" ? "0" : ns,
          status: htlcStatus,
          route: {
            hops: [
              {
                amt_to_forward_msat: String(p.tokens * 1000),
                chan_capacity: "5000000",
                chan_id: chanNumber("800000x1x0"),
                expiry: this.blockHeight + 40,
                fee_msat: p.feeMsat,
                pub_key: p.destination,
                tlv_payload: true,
              },
            ],
            total_amt_msat: String(p.tokens * 1000 + Number(p.feeMsat)),
            total_fees_msat: p.feeMsat,
            total_time_lock: this.blockHeight + 40,
          },
        },
      ],
      payment_hash: p.id,
      payment_index: "1",
      payment_preimage: succeeded ? p.preimage : "00".repeat(32),
      payment_request: p.request ?? "",
      status: p.status,
      value: String(p.tokens),
      value_msat: String(p.tokens * 1000),
      value_sat: String(p.tokens),
    };
  }

  private sendPaymentStream(a: GrpcArgs) {
    const s = stream();
    later(() => {
      const request = typeof a.payment_request === "string" ? a.payment_request : undefined;
      if (!request) {
        // Paying by details (payViaPaymentDetails — e.g. a circular rebalance).
        if (!a.dest || !a.payment_hash) {
          s.emit("error", { details: "fake LND needs a payment request or dest + payment_hash" });
          return;
        }
        const msat = a.amt_msat !== undefined ? Number(a.amt_msat) : Number(a.amt ?? 0) * 1000;
        this.startPayment(s, a, {
          id: Buffer.from(a.payment_hash as Buffer).toString("hex"),
          destination: Buffer.from(a.dest as Buffer).toString("hex"),
          tokens: Math.floor(msat / 1000),
        });
        return;
      }
      const parsed = parsePaymentRequest(request);
      // LND rejects an explicit amount for an invoice that already carries one.
      if (parsed.tokens > 0 && a.amt !== undefined && Number(a.amt) > 0) {
        s.emit("error", { details: "amount must not be specified when paying a non-zero amount invoice" });
        return;
      }
      const existing = this.payments.get(parsed.id);
      if (existing && existing.status !== "FAILED") {
        s.emit("error", {
          details: existing.status === "SUCCEEDED" ? "invoice is already paid" : "payment is in transition",
        });
        return;
      }
      const tokens = parsed.tokens > 0 ? parsed.tokens : Number(a.amt ?? 0);
      this.startPayment(s, a, { id: parsed.id, request, destination: parsed.destination, tokens });
    });
    return s;
  }

  private startPayment(
    s: EventEmitter,
    a: GrpcArgs,
    p: { id: string; request?: string; destination: string; tokens: number },
  ): void {
    const payment: FakePayment = {
      id: p.id,
      request: p.request,
      destination: p.destination,
      tokens: p.tokens,
      feeMsat: String(this.routingFeeMsat),
      status: "IN_FLIGHT",
      preimage: rand32(),
      params: a,
    };
    this.payments.set(payment.id, payment);
    this.paymentStreams.set(payment.id, [...(this.paymentStreams.get(payment.id) ?? []), s]);
    const outcome = typeof this.payOutcome === "function" ? this.payOutcome(payment) : this.payOutcome;
    if (outcome === "hang") {
      s.emit("data", this.paymentRpc(payment));
      return;
    }
    payment.status = outcome === "succeed" ? "SUCCEEDED" : "FAILED";
    s.emit("data", this.paymentRpc(payment));
  }

  private trackPaymentStream(a: GrpcArgs) {
    const s = stream();
    later(() => {
      const id = Buffer.from(a.payment_hash as Buffer).toString("hex");
      const p = this.payments.get(id);
      if (!p) {
        s.emit("error", { details: "payment isn't initiated" });
        return;
      }
      this.paymentStreams.set(id, [...(this.paymentStreams.get(id) ?? []), s]);
      s.emit("data", this.paymentRpc(p));
    });
    return s;
  }
}

/** sha256 hex — payment hash of a preimage. */
export const paymentHashOf = (secretHex: string): string =>
  createHash("sha256").update(Buffer.from(secretHex, "hex")).digest("hex");
