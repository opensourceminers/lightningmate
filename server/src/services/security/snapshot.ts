/**
 * Read-only LND data collection for the Security tab (server-only).
 *
 * Calls a fixed set of READ-ONLY LND methods, tolerating partial failures, and
 * produces a normalized {@link SecuritySnapshot}. NO write/action methods are
 * ever called here — by construction this module cannot move funds or change
 * channels.
 *
 * Unlike Lightning Guardian's original collector, this reuses LightningMate's
 * already-authenticated `lnd` client (passed in) instead of building its own.
 *
 * If a macaroon lacks a permission, the affected data is simply omitted and the
 * per-call status records why. Nothing throws.
 */

import {
  getWalletInfo,
  getChainBalance,
  getPendingChainBalance,
  getChannelBalance,
  getChannels,
  getPendingChannels,
  getBackups,
  getChainFeeRate,
  type AuthenticatedLnd,
} from "lightning";
import { clamp } from "./util.js";
import type {
  LndCallName,
  LndCallResult,
  NormalizedChannel,
  NormalizedPendingChannel,
  ScbExportResult,
  SecuritySnapshot,
} from "./types.js";

const CALL_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 10_000;

const ALL_CALLS: LndCallName[] = [
  "getWalletInfo",
  "getChainBalance",
  "getPendingChainBalance",
  "getChannelBalance",
  "getChannels",
  "getPendingChannels",
  "getBackups",
  "getChainFeeRate",
];

function emptyCalls(status: LndCallResult["status"]): Record<LndCallName, LndCallResult> {
  return ALL_CALLS.reduce(
    (acc, name) => {
      acc[name] = { status };
      return acc;
    },
    {} as Record<LndCallName, LndCallResult>,
  );
}

function resolveNetwork(): string {
  return process.env.LND_NETWORK?.trim() || "mainnet";
}

/** Reduce any thrown value to a short, secret-free string. */
function errToMessage(err: unknown): string {
  if (Array.isArray(err)) {
    const parts = err.filter((p) => typeof p === "string" || typeof p === "number");
    return (parts.join(" ").trim() || "Unknown LND error").slice(0, 300);
  }
  if (err instanceof Error) return err.message.slice(0, 300);
  if (typeof err === "string") return err.slice(0, 300);
  try {
    return JSON.stringify(err).slice(0, 300);
  } catch {
    return "Unknown LND error";
  }
}

function isPermissionError(msg: string): boolean {
  return /permission|unauthorized|not authorized|macaroon/i.test(msg);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LND call timed out")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type CallOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; result: LndCallResult };

async function runCall<T>(fn: () => Promise<T>, ms = CALL_TIMEOUT_MS): Promise<CallOutcome<T>> {
  try {
    const value = await withTimeout(fn(), ms);
    return { ok: true, value };
  } catch (err) {
    const msg = errToMessage(err);
    return {
      ok: false,
      result: { status: "error", error: msg, permissionDenied: isPermissionError(msg) },
    };
  }
}

function normalizeChannel(c: {
  id?: string;
  partner_public_key?: string;
  capacity?: number;
  local_balance?: number;
  remote_balance?: number;
  is_active?: boolean;
  is_private?: boolean;
  is_partner_initiated?: boolean;
  pending_payments?: unknown[];
  unsettled_balance?: number;
}): NormalizedChannel {
  const capacity = Number(c.capacity ?? (c.local_balance ?? 0) + (c.remote_balance ?? 0));
  const local = Number(c.local_balance ?? 0);
  return {
    id: String(c.id ?? ""),
    partnerPublicKey: String(c.partner_public_key ?? ""),
    capacitySat: capacity,
    localBalanceSat: local,
    remoteBalanceSat: Number(c.remote_balance ?? 0),
    isActive: Boolean(c.is_active),
    isPrivate: Boolean(c.is_private),
    isPartnerInitiated: Boolean(c.is_partner_initiated),
    pendingHtlcCount: Array.isArray(c.pending_payments) ? c.pending_payments.length : 0,
    unsettledBalanceSat: Number(c.unsettled_balance ?? 0),
    localRatio: capacity > 0 ? clamp(local / capacity, 0, 1) : 0,
  };
}

function normalizePending(p: {
  partner_public_key?: string;
  capacity?: number;
  local_balance?: number;
  remote_balance?: number;
  is_opening?: boolean;
  is_closing?: boolean;
  is_timelocked?: boolean;
}): NormalizedPendingChannel {
  const isClosing = Boolean(p.is_closing);
  const isTimelocked = Boolean(p.is_timelocked);
  return {
    partnerPublicKey: String(p.partner_public_key ?? ""),
    capacitySat: Number(p.capacity ?? 0),
    localBalanceSat: Number(p.local_balance ?? 0),
    remoteBalanceSat: Number(p.remote_balance ?? 0),
    isOpening: Boolean(p.is_opening),
    isClosing,
    isTimelocked,
    isForceClose: isClosing && isTimelocked,
  };
}

/**
 * Collect a full read-only snapshot using the supplied authenticated `lnd`
 * client. Always resolves — never throws.
 */
export async function collectSecuritySnapshot(lnd: AuthenticatedLnd): Promise<SecuritySnapshot> {
  const collectedAt = new Date().toISOString();
  const network = resolveNetwork();
  const calls = emptyCalls("skipped");

  // Reachability probe: getWalletInfo. If this fails, treat the node as down.
  const infoOutcome = await runCall(() => getWalletInfo({ lnd }), PROBE_TIMEOUT_MS);
  if (!infoOutcome.ok) {
    calls.getWalletInfo = infoOutcome.result;
    return {
      reachable: false,
      connectionError: infoOutcome.result.error,
      network,
      calls,
      collectedAt,
    };
  }
  calls.getWalletInfo = { status: "ok" };
  const info = infoOutcome.value;

  // Remaining read-only calls run concurrently; each tolerates its own failure.
  const [
    chainBalance,
    pendingChainBalance,
    channelBalance,
    channels,
    pendingChannels,
    backups,
    feeRate,
  ] = await Promise.all([
    runCall(() => getChainBalance({ lnd })),
    runCall(() => getPendingChainBalance({ lnd })),
    runCall(() => getChannelBalance({ lnd })),
    runCall(() => getChannels({ lnd })),
    runCall(() => getPendingChannels({ lnd })),
    runCall(() => getBackups({ lnd })),
    runCall(() => getChainFeeRate({ lnd })),
  ]);

  const snapshot: SecuritySnapshot = {
    reachable: true,
    network,
    calls,
    collectedAt,
    info: {
      alias: info.alias,
      pubkey: info.public_key,
      version: info.version,
      blockHeight: info.current_block_height,
      peersCount: info.peers_count,
      activeChannelsCount: info.active_channels_count,
      pendingChannelsCount: info.pending_channels_count,
      isSyncedToChain: info.is_synced_to_chain,
      isSyncedToGraph: info.is_synced_to_graph,
    },
  };

  if (chainBalance.ok) {
    calls.getChainBalance = { status: "ok" };
    snapshot.confirmedChainBalanceSat = chainBalance.value.chain_balance;
  } else {
    calls.getChainBalance = chainBalance.result;
  }

  if (pendingChainBalance.ok) {
    calls.getPendingChainBalance = { status: "ok" };
    snapshot.unconfirmedChainBalanceSat = pendingChainBalance.value.pending_chain_balance;
  } else {
    calls.getPendingChainBalance = pendingChainBalance.result;
  }

  if (channelBalance.ok) {
    calls.getChannelBalance = { status: "ok" };
    snapshot.channelBalanceLocalSat = channelBalance.value.channel_balance;
    snapshot.channelBalanceRemoteSat = channelBalance.value.inbound;
  } else {
    calls.getChannelBalance = channelBalance.result;
  }

  if (channels.ok) {
    calls.getChannels = { status: "ok" };
    snapshot.channels = (channels.value.channels ?? []).map(normalizeChannel);
  } else {
    calls.getChannels = channels.result;
  }

  if (pendingChannels.ok) {
    calls.getPendingChannels = { status: "ok" };
    snapshot.pendingChannels = (pendingChannels.value.pending_channels ?? []).map(normalizePending);
  } else {
    calls.getPendingChannels = pendingChannels.result;
  }

  if (backups.ok) {
    calls.getBackups = { status: "ok" };
    const value = backups.value;
    snapshot.backup = {
      available: true,
      allChannelsScbAvailable: Boolean(value.backup),
      channelCount: Array.isArray(value.channels) ? value.channels.length : undefined,
    };
  } else {
    calls.getBackups = backups.result;
    snapshot.backup = { available: false, allChannelsScbAvailable: false };
  }

  if (feeRate.ok) {
    calls.getChainFeeRate = { status: "ok" };
    snapshot.feeRateSatPerVbyte = feeRate.value.tokens_per_vbyte;
  } else {
    calls.getChainFeeRate = feeRate.result;
  }

  return snapshot;
}

/**
 * Export the all-channels static channel backup (SCB). User-triggered only.
 *
 * This is a READ-only LND call (ExportAllChannelBackups, offchain:read). The
 * returned hex blob is streamed straight to the operator's browser for download
 * — the blob is never written to disk or uploaded anywhere. Only the timestamp
 * and channel-count metadata are persisted (see securityStore.ts).
 */
export async function exportScb(lnd: AuthenticatedLnd): Promise<ScbExportResult> {
  const outcome = await runCall(() => getBackups({ lnd }));
  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.result.permissionDenied
        ? "The configured macaroon does not permit channel backup export (offchain:read required)."
        : outcome.result.error,
    };
  }

  const value = outcome.value;
  if (!value.backup) {
    return { ok: false, error: "LND returned an empty channel backup." };
  }

  return {
    ok: true,
    backupHex: String(value.backup),
    channelCount: Array.isArray(value.channels) ? value.channels.length : undefined,
    exportedAt: new Date().toISOString(),
  };
}
