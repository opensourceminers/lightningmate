import { Router, type Request, type Response, type NextFunction } from "express";
import { getFeeRates, getWalletInfo, signMessage, type AuthenticatedLnd } from "lightning";
import { getNodeScore } from "../services/score.js";
import type { Config } from "../config.js";
import { getNodeSummary, getOwnPubkey } from "../services/node.js";
import { getChannelsView } from "../services/channels.js";
import { getFlowSummary, getForwardsReport } from "../services/forwards.js";
import { getFeePreview, type FeeApplyItem, type FeePolicy } from "../services/fees.js";
import { type SuggestionPolicy } from "../services/suggestions.js";
import { getChannelSuggestionsV2, getCloseSuggestionsV2 } from "../services/suggestRecommend.js";
import type { LnPlusStore } from "../services/lnplusStore.js";
import { checkSwapEligibility, getPoolNodes, getSwaps, type NodeFacts } from "../services/lnplus.js";
import { getMagmaRecommendations } from "../services/magmaRecommend.js";
import { getAutopilotOutcomes } from "../services/outcomes.js";
import { getPnl } from "../services/pnl.js";
import { buildDashboard } from "../services/dashboard.js";
import {
  createInvoice,
  decodeRequest,
  getLnActivity,
  payRequest,
} from "../services/payments.js";
import {
  getFeeEstimates,
  getOnchainState,
  getOnchainTxs,
  newAddress,
  sendOnchain,
} from "../services/onchain.js";
import { closeChannelByOutpoint, connectForOpen, fundChannel, MIN_CHANNEL_SATS } from "../services/channelOps.js";
import { promisedSpendRefusal, type PromisedSpendRefusal } from "../services/capital.js";
import { saleFeeConfig, type ServiceFeeLedger } from "../services/serviceFee.js";
import { floorWindowStart, getFeeRecommendations } from "../services/feeRecommend.js";
import { getBtcPrice } from "../services/price.js";
import type { SettingsStore } from "../services/settings.js";
import type { ChannelOverride, OverridesStore } from "../services/overrides.js";
import { getAlerts, magmaRefusalAlerts, serviceFeeAlerts, stateAlerts } from "../services/alerts.js";
import { authRequired, bearer, issueToken, verifyPassword, verifyToken } from "../services/auth.js";
import { SlidingWindowLimiter } from "../services/rateLimit.js";
import { acknowledgeStoreIncident } from "../store.js";
import { ConfigValidationError } from "../services/autopilotConfig.js";
import { buyFromOffer, buyLiquidity, cancelPurchase, getMarket, getOffers, getOrder, isAuthError } from "../services/amboss.js";
import { rankBuyOffers, type BuyerFacts } from "../services/magmaBuy.js";
import { feeTiers, publicBook } from "../services/magmaEligibility.js";
import {
  checkKey,
  createOffer,
  getMyOffer,
  getMyOffers,
  getMyOrders,
  toggleOffer,
  updateOffer,
  type MyOffer,
  type OfferTerms,
} from "../services/magmaApi.js";
import type { DeskResult } from "../services/magmaDesk.js";
import type { AmbossStore } from "../services/ambossStore.js";
import { FeeItemError, RebalanceBudgetError, RefillInFlightError, ambossFields, termsMatch, type Autopilot, type OfferWrite } from "../services/autopilot.js";
import type { RebalanceLog } from "../services/rebalanceLog.js";
import { BackupStore, exportScb, getBackupStatus } from "../services/backup.js";
import type { EarningsLog } from "../services/earningsLog.js";
import type { Lsps1Service } from "../services/lsps1.js";
import { classifiedSince, getUnservedDemand, telemetryAgeDays } from "../services/htlcTelemetry.js";
import { buildSellDiagnostics } from "../services/sellDiagnostics.js";

// Pull the numeric keys of a policy object out of the query string.
function numericOverrides<T>(query: Request["query"], keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    const n = Number(query[key as string]);
    if (Number.isFinite(n)) out[key] = n as T[keyof T];
  }
  return out;
}

const WRITE_DISABLED_MSG =
  "Writing is disabled. Set LM_ENABLE_WRITE=true and provide a write macaroon " +
  "(LND_WRITE_MACAROON / LND_WRITE_MACAROON_PATH, or admin.macaroon on Umbrel).";

// ── Input validation helpers (defense for fund-moving endpoints) ──────────────
const isHex = (s: unknown, len: number): s is string =>
  typeof s === "string" && new RegExp(`^[0-9a-f]{${len}}$`, "i").test(s);
const isPubkey = (s: unknown): s is string => isHex(s, 66);
const isTxid = (s: unknown): s is string => isHex(s, 64);
const isChannelId = (s: unknown): s is string =>
  typeof s === "string" && /^\d+x\d+x\d+$/.test(s);
/** A BOLT11 payment request (bech32-ish, starts with "ln"). */
const isPayRequest = (s: unknown): s is string =>
  typeof s === "string" && s.length >= 20 && s.length <= 2000 && /^ln[a-z0-9]+$/i.test(s.trim());
/** A mainnet on-chain address (bech32 bc1… or base58 1…/3…). LND validates fully. */
const isBtcAddress = (s: unknown): s is string =>
  typeof s === "string" &&
  (/^bc1[a-z0-9]{8,87}$/i.test(s.trim()) || /^[13][a-km-zA-HJ-NP-Z1-9]{20,40}$/.test(s.trim()));
/** Finite integer within [min, max], else null. */
function intIn(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : null;
}
function numIn(v: unknown, min: number, max: number): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
// Sane bounds.
const MAX_CHANNEL_SATS = 1_000_000_000; // 10 BTC
const MAX_FEE_PPM = 50_000; // 5%
const MAX_BASE_MSAT = 10_000_000; // 10k sat
const MAX_REBALANCE_SATS = 100_000_000; // 1 BTC
const MAX_RECEIVE_SATS = 100_000_000; // 1 BTC per invoice
const MAX_PAY_FEE_SATS = 2_000_000; // routing-fee budget cap
const MAX_ONCHAIN_SEND_SATS = 1_000_000_000; // 10 BTC per send
const MAX_FEE_RATE = 2_000; // sat/vByte

// Read optional fee-policy overrides from the query string.
function parsePolicyQuery(query: Request["query"]): Partial<FeePolicy> {
  const out: Partial<FeePolicy> = {};
  const keys: (keyof FeePolicy)[] = [
    "minPpm",
    "maxPpm",
    "baseFeeMsat",
    "step",
    "minChangePpm",
  ];
  for (const key of keys) {
    const n = Number(query[key]);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

// Wrap async handlers so rejected promises reach the error middleware.
type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

// ln-service throws errors as arrays: [statusCode, ErrorCode, { err, details }].
// Dig out the underlying gRPC detail so the real cause (connection refused, TLS
// host mismatch, timeout, …) reaches the UI instead of "[object Object]".
function describeError(err: unknown): string {
  if (Array.isArray(err)) {
    const code = err[1] ?? err[0];
    const extra = err[2] as
      | { err?: { details?: string; message?: string }; details?: string }
      | undefined;
    const detail =
      extra?.err?.details ?? extra?.err?.message ?? extra?.details ?? "";
    return detail ? `${code}: ${detail}` : String(code);
  }
  return err instanceof Error ? err.message : String(err);
}

export function createApiRouter(
  lnd: AuthenticatedLnd,
  writeLnd: AuthenticatedLnd | undefined,
  config: Config,
  autopilot: Autopilot,
  rebalanceLog: RebalanceLog,
  settings: SettingsStore,
  overrides: OverridesStore,
  amboss: AmbossStore,
  backup: BackupStore,
  earnings: EarningsLog,
  lsps1: Lsps1Service,
  lnplus: LnPlusStore,
  serviceFees: ServiceFeeLedger,
): Router {
  const router = Router();

  // Limits are kept PER CLIENT ADDRESS. Umbrel's app_proxy (the owner's
  // browser) and other containers on the Docker network arrive from different
  // addresses, so a noisy neighbour can only exhaust its own budget — with
  // single global buckets it could lock the owner out of logging in or saving.
  const clientKey = (req: Request): string => req.socket.remoteAddress ?? "unknown";

  // ── Auth gate ───────────────────────────────────────────────────────────────
  // The whole API requires a session token (proves the per-install app password
  // Umbrel shows the user) — EXCEPT the auth + health endpoints. Other app
  // containers share the Docker network, so without this they could read node
  // data or move funds directly. No-op when auth isn't required (standalone on
  // 127.0.0.1, where there is no cross-container threat).
  // /widget/* is polled by umbreld directly (bypassing app_proxy), so it can't
  // carry a session token — it serves only non-sensitive summary stats.
  const OPEN_PATHS = new Set(["/auth/status", "/auth/unlock", "/health", "/widget/stats"]);
  router.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path)) return next();
    if (verifyToken(bearer(req))) return next();
    res.status(401).json({ error: "unauthorized", message: "Sign in to continue." });
  });

  // Rate limit on state-changing requests — blocks runaway loops or a
  // compromised client spamming fund-moving actions. Generous for a human.
  // Mounted AFTER the auth gate, so unauthenticated requests (401 above) never
  // count; the login has its own failure-only limiter below.
  const writeLimiter = new SlidingWindowLimiter({ windowMs: 60_000, max: 60 });
  router.use((req, res, next) => {
    if (req.method === "GET" || OPEN_PATHS.has(req.path)) return next();
    if (!writeLimiter.tryHit(clientKey(req))) {
      res.status(429).json({ error: "rate_limited", message: "Too many write requests; slow down." });
      return;
    }
    next();
  });

  // Whether a login is required, and whether this request is already signed in.
  router.get("/auth/status", (req, res) => {
    res.json({ authRequired: authRequired(), unlocked: verifyToken(bearer(req)) });
  });

  // Exchange the app password for a session token. Brute-force guarded by
  // counting FAILED attempts per client: guessing from one address can't lock
  // out the owner, whose correct password always gets through.
  const unlockFailures = new SlidingWindowLimiter({ windowMs: 60_000, max: 8 });
  router.post("/auth/unlock", (req, res) => {
    const key = clientKey(req);
    if (unlockFailures.limited(key)) {
      res.status(429).json({ error: "rate_limited", message: "Too many attempts; wait a minute." });
      return;
    }
    if (!verifyPassword(req.body?.password)) {
      unlockFailures.hit(key);
      res.status(401).json({ error: "bad_password", message: "Wrong password." });
      return;
    }
    unlockFailures.reset(key);
    res.json({ token: issueToken() });
  });

  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "lightningmate", version: process.env.APP_VERSION ?? "dev" });
  });

  // Umbrel home-screen widget (four-stats). Polled by umbreld; cached briefly so
  // continuous polling doesn't keep re-scanning forwarding history.
  let widgetCache: { at: number; body: unknown } | null = null;
  router.get("/widget/stats", async (_req, res) => {
    if (widgetCache && Date.now() - widgetCache.at < 30_000) {
      res.json(widgetCache.body);
      return;
    }
    const compact = (n: number) =>
      n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
    try {
      const [node, flow] = await Promise.all([getNodeSummary(lnd), getFlowSummary(lnd, 30)]);
      const body = {
        type: "four-stats",
        refresh: "60s",
        link: "",
        items: [
          { title: "Channels", text: String(node.activeChannelsCount), subtext: "active" },
          { title: "Outbound", text: compact(node.balances.localSats), subtext: "can send" },
          { title: "Earned", text: compact(flow.totalFeesEarnedSats), subtext: "sat · 30d" },
          { title: "Forwards", text: String(flow.totalForwards), subtext: "30d" },
        ],
      };
      widgetCache = { at: Date.now(), body };
      res.json(body);
    } catch {
      res.json({ type: "four-stats", refresh: "60s", link: "", items: [] });
    }
  });

  router.get(
    "/node",
    wrap(async (_req, res) => {
      res.json(await getNodeSummary(lnd));
    }),
  );

  // Every channel with the fee it charges now (review a6: the Channels table
  // could not show what a channel charges — only Autopilot → Fees could).
  router.get(
    "/channels",
    wrap(async (_req, res) => {
      const [channels, rates] = await Promise.all([getChannelsView(lnd), getFeeRates({ lnd }).catch(() => null)]);
      const rateById = new Map((rates?.channels ?? []).map((c) => [c.id, c]));
      res.json(
        channels.map((c) => {
          const r = rateById.get(c.id);
          return { ...c, feeRatePpm: r ? r.fee_rate : null, baseFeeMsat: r ? Number(r.base_fee_mtokens) : null };
        }),
      );
    }),
  );

  router.get(
    "/flows",
    wrap(async (req, res) => {
      const days = Number(req.query.days ?? config.flowWindowDays);
      const windowDays = Number.isFinite(days) && days > 0 ? days : config.flowWindowDays;
      res.json(await getFlowSummary(lnd, windowDays));
    }),
  );

  // Forwards report (Thunderhub-style) — daily series + per-channel + recent.
  router.get(
    "/forwards/report",
    wrap(async (req, res) => {
      const days = Number(req.query.days ?? 30);
      const windowDays = Math.min(90, Math.max(1, Number.isFinite(days) ? days : 30));
      res.json(await getForwardsReport(lnd, windowDays));
    }),
  );

  // Dry-run fee proposals — read-only, never writes to the node.
  router.get(
    "/fees/preview",
    wrap(async (req, res) => {
      res.json(await getFeePreview(lnd, parsePolicyQuery(req.query), overrides.all()));
    }),
  );

  // Fee Autopilot v2 — recommendation engine (dry-run only, never writes fees).
  router.get(
    "/fees/recommendations",
    wrap(async (_req, res) => {
      res.json(
        await getFeeRecommendations(
          lnd,
          // The refills the profit floor can stand on (not 200 records of
          // failures and successes mixed).
          rebalanceLog.successes(floorWindowStart()),
          autopilot.feeCooldown(),
          autopilot.feeV2Overrides(),
          overrides.all(),
          await autopilot.feeElasticityModifiers(),
          autopilot.flowAnchors(),
          autopilot.capital.leaseCaps(),
        ),
      );
    }),
  );

  // ── Channel backup (SCB) watchdog ─────────────────────────────────────────────
  // Read-only backup status: current channel count + last-export metadata and a
  // staleness verdict. Uses only read LND calls — it can never move funds or
  // change channels.
  router.get(
    "/backup/status",
    wrap(async (_req, res) => {
      res.json(await getBackupStatus(lnd, backup));
    }),
  );

  // Export the all-channels static channel backup (read-only LND call,
  // offchain:read). The hex blob streams straight to the browser for download
  // and is never written to disk or uploaded. Only the timestamp + channel count
  // metadata is persisted, so the backup watchdog can detect staleness.
  router.post(
    "/backup/export",
    wrap(async (_req, res) => {
      const result = await exportScb(lnd, backup);
      if (!result.ok || !result.backupHex) {
        res.status(400).json({ error: "backup_export_failed", message: result.error ?? "Backup export failed." });
        return;
      }
      const buf = Buffer.from(result.backupHex, "hex");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="channel.backup"`);
      if (result.channelCount !== undefined) {
        res.setHeader("X-Channel-Count", String(result.channelCount));
      }
      res.send(buf);
    }),
  );

  // Per-channel manual fee overrides (auto / fixed / exclude).
  router.get("/overrides", (_req, res) => {
    res.json(overrides.all());
  });
  router.post("/overrides", (req, res) => {
    const { channelId, mode, fixedPpm } = req.body ?? {};
    if (!isChannelId(channelId) || !["auto", "fixed", "exclude"].includes(mode)) {
      res.status(400).json({ error: "bad_request", message: "valid channelId and mode (auto/fixed/exclude) required." });
      return;
    }
    const override: ChannelOverride = { mode };
    if (mode === "fixed") {
      const ppm = intIn(fixedPpm, 0, MAX_FEE_PPM);
      if (ppm === null) {
        res.status(400).json({ error: "bad_request", message: "fixedPpm out of range (0–50000)." });
        return;
      }
      override.fixedPpm = ppm;
    }
    res.json(overrides.set(channelId, override));
  });

  // Alerts: damaged/unsaveable state files and service-fee problems (these
  // stay until acknowledged), plus derived node alerts (offline channels, …).
  router.get(
    "/alerts",
    wrap(async (_req, res) => {
      res.json(
        await getAlerts(lnd, [...stateAlerts(config.dataDir), ...serviceFeeAlerts(serviceFees), ...magmaRefusalAlerts(autopilot.magma)]),
      );
    }),
  );

  // Operator has read an acknowledgeable alert ("state:<id>" / "fee:<key>").
  router.post("/alerts/ack", (req, res) => {
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    const ok = id.startsWith("state:")
      ? acknowledgeStoreIncident(config.dataDir, id.slice("state:".length))
      : id.startsWith("fee:")
        ? serviceFees.acknowledge(id.slice("fee:".length))
        : id.startsWith("magma:")
          ? autopilot.magma.acknowledgeRefusal(id.slice("magma:".length))
          : false;
    if (!ok) {
      res.status(404).json({ error: "not_found", message: "No such alert." });
      return;
    }
    res.json({ ok: true });
  });

  // The service-fee ledger, for transparency: what was owed, paid or refused.
  router.get("/service-fees", (_req, res) => {
    const { bps, address } = saleFeeConfig();
    res.json({ bps, address, entries: serviceFees.entries() });
  });

  // Close a channel by funding outpoint — real on-chain action, write only.
  router.post(
    "/channels/close",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { transactionId, transactionVout, isForce, feeRate } = req.body ?? {};
      const vout = intIn(transactionVout, 0, 1_000_000);
      if (!isTxid(transactionId) || vout === null) {
        res.status(400).json({ error: "bad_request", message: "valid transactionId (64 hex) and transactionVout required." });
        return;
      }
      // Optional sat/vByte for cooperative closes; ignored for force-closes.
      const rate = feeRate === undefined ? undefined : (intIn(feeRate, 1, 5000) ?? undefined);
      res.json(await closeChannelByOutpoint(writeLnd, transactionId, vout, Boolean(isForce), rate));
    }),
  );

  // Current on-chain fee estimates (sat/vByte) for the close dialog. Read-only.
  router.get(
    "/chain/fee-estimates",
    wrap(async (_req, res) => {
      res.json(await getFeeEstimates(lnd));
    }),
  );

  // Apply specific fee changes to the node. Requires a write macaroon.
  router.post(
    "/fees/apply",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const raw = Array.isArray(req.body?.items) ? req.body.items : [];
      if (raw.length === 0 || raw.length > 500) {
        res.status(400).json({ error: "bad_request", message: "1–500 fee items required." });
        return;
      }
      const items: FeeApplyItem[] = [];
      for (const it of raw) {
        const vout = intIn(it?.transactionVout, 0, 1_000_000);
        const feeRatePpm = intIn(it?.feeRatePpm, 0, MAX_FEE_PPM);
        const baseFeeMsat = intIn(it?.baseFeeMsat, 0, MAX_BASE_MSAT);
        if (typeof it?.id !== "string" || !isTxid(it?.transactionId) || vout === null || feeRatePpm === null || baseFeeMsat === null) {
          res.status(400).json({ error: "bad_request", message: "invalid fee item." });
          return;
        }
        items.push({ id: it.id, transactionId: it.transactionId, transactionVout: vout, feeRatePpm, baseFeeMsat });
      }
      // A manual apply is clamped to a sold channel's lease promise too (D7):
      // the result says where it was. It goes through the autopilot's books
      // (cooldown, run history, fee-change log), like its own changes. An
      // item whose id isn't the channel at its outpoint is refused (400)
      // before anything is written.
      let done: Awaited<ReturnType<Autopilot["applyByHand"]>>;
      try {
        done = await autopilot.applyByHand(items);
      } catch (err) {
        if (err instanceof FeeItemError) {
          res.status(400).json({ error: "bad_request", message: err.message, problems: err.problems });
          return;
        }
        throw err;
      }
      if (!done) {
        res.status(409).json({ error: "busy", message: "The autopilot is running right now — try again in a moment." });
        return;
      }
      res.json({ results: done.results });
    }),
  );

  // "Apply" on Autopilot → Fees: the engine's recommendations (target AND
  // base fee), recomputed now and applied through the autopilot's books.
  // `channelIds` limits it to the rows the operator saw.
  router.post(
    "/fees/apply-recommended",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const raw = req.body?.channelIds;
      if (raw !== undefined && (!Array.isArray(raw) || raw.length > 500 || !raw.every((id: unknown) => isChannelId(id)))) {
        res.status(400).json({ error: "bad_request", message: "channelIds must be a list of channel ids (at most 500)." });
        return;
      }
      const changes = await autopilot.applyRecommended(raw as string[] | undefined);
      if (!changes) {
        res.status(409).json({ error: "busy", message: "The autopilot is running right now — try again in a moment." });
        return;
      }
      res.json({ changes });
    }),
  );

  // Autopilot status/config.
  router.get("/autopilot", (_req, res) => {
    res.json(autopilot.getState());
  });

  // Update autopilot config (enable/disable, interval, cooldown, policy). Every
  // value is checked against its bounds; one bad field rejects the whole update
  // with a message naming it, and nothing is saved.
  router.post("/autopilot", (req, res) => {
    try {
      autopilot.setConfig(req.body);
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(400).json({ error: "invalid_config", message: err.message, errors: err.errors });
        return;
      }
      throw err;
    }
    res.json(autopilot.getState());
  });

  // Trigger one autopilot run immediately.
  router.post(
    "/autopilot/run",
    wrap(async (_req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      res.json({ run: await autopilot.runOnce(), state: autopilot.getState() });
    }),
  );

  // Rebalance recommendations — dry-run only, no payments: exactly what the
  // autopilot's rebalance stage would plan (the same fee-engine inputs and
  // settings), with today's fee budget and the payments still in flight.
  // (The older "candidates" engine behind GET /rebalance/candidates is gone:
  // nothing called it.)
  router.get(
    "/rebalance/recommendations",
    wrap(async (_req, res) => {
      res.json(await autopilot.rebalanceRecommendations());
    }),
  );

  // Execute one rebalance. Budget is enforced server-side; requires write access.
  router.post(
    "/rebalance/execute",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { targetId, sourceId, amountSats, econRatio, maxFeePpm, maxFeeSats, gate } = req.body ?? {};
      const amount = intIn(amountSats, 1000, MAX_REBALANCE_SATS);
      const ratio = econRatio === undefined ? 0.8 : numIn(econRatio, 0.05, 1);
      const maxFee = maxFeePpm === undefined ? undefined : intIn(maxFeePpm, 1, MAX_FEE_PPM);
      const maxSats = maxFeeSats === undefined ? undefined : intIn(maxFeeSats, 1, MAX_REBALANCE_SATS);
      // The profit gate's earnings side (a recommended row sends it): each
      // size it tries may pay at most what it earns above the minimum.
      const g =
        gate === undefined
          ? undefined
          : {
              revenuePpm: intIn(gate?.revenuePpm, 1, MAX_FEE_PPM),
              demandSats: intIn(gate?.demandSats, 0, MAX_REBALANCE_SATS * 1000),
              minNetSats: intIn(gate?.minNetSats, 0, MAX_REBALANCE_SATS),
            };
      if (
        !isChannelId(targetId) ||
        !isChannelId(sourceId) ||
        amount === null ||
        ratio === null ||
        (maxFeePpm !== undefined && maxFee === null) ||
        (maxFeeSats !== undefined && maxSats === null) ||
        (g !== undefined && (g.revenuePpm === null || g.demandSats === null || g.minNetSats === null))
      ) {
        res.status(400).json({
          error: "bad_request",
          message:
            "valid targetId/sourceId, amountSats (1k–1 BTC), econRatio (0.05–1) and optional maxFeePpm, maxFeeSats (the most the refill may pay, sat) and gate {revenuePpm, demandSats, minNetSats} required.",
        });
        return;
      }
      // Logged as manual. A payment still in flight at the hard limit is
      // tracked until LND knows how it ended, and logged then (autopilot.ts).
      // It counts toward the daily rebalance budget like the autopilot's own
      // refills: its fee is capped at what is left, and with nothing left it
      // is refused (409) before anything is paid. So is a refill into or out
      // of a channel whose earlier payment may still land (409, in_flight).
      let done: Awaited<ReturnType<Autopilot["rebalanceByHand"]>>;
      try {
        done = await autopilot.rebalanceByHand({
          targetId,
          sourceId,
          amountSats: amount,
          econRatio: ratio,
          ...(maxFee !== null && maxFee !== undefined ? { maxFeePpm: maxFee } : {}),
          ...(maxSats !== null && maxSats !== undefined ? { maxFeeSats: maxSats } : {}),
          ...(g ? { gate: { revenuePpm: g.revenuePpm as number, demandSats: g.demandSats as number, minNetSats: g.minNetSats as number } } : {}),
        });
      } catch (err) {
        if (err instanceof RebalanceBudgetError) {
          res.status(409).json({ error: "budget_exhausted", message: err.message, budget: err.budget });
          return;
        }
        if (err instanceof RefillInFlightError) {
          res.status(409).json({ error: "in_flight", message: err.message, channelId: err.channelId, payment: err.payment });
          return;
        }
        throw err;
      }
      if (!done) {
        // (The refill lock: the autopilot's refills or another manual one
        // are paying — never two side by side, or both could pass the budget.)
        res.status(409).json({
          error: "busy",
          message: "A refill is already under way (the autopilot's or another manual one) — try again in a few minutes.",
        });
        return;
      }
      res.json(done);
    }),
  );

  // Rebalance accounting log + totals.
  router.get("/rebalance/log", (_req, res) => {
    res.json({ summary: rebalanceLog.summary(), records: rebalanceLog.recent() });
  });

  // Node health score (A–F) + network rank.
  router.get(
    "/score",
    wrap(async (_req, res) => {
      res.json(await getNodeScore(lnd));
    }),
  );


  // Profit & loss over a window — routing revenue vs channel/rebalance costs.
  router.get(
    "/pnl",
    wrap(async (req, res) => {
      const days = Number(req.query.days ?? config.flowWindowDays);
      const windowDays = Number.isFinite(days) && days > 0 ? days : config.flowWindowDays;
      res.json(await getPnl(lnd, rebalanceLog, earnings, windowDays, serviceFees));
    }),
  );

  // Autopilot outcomes — did the fee changes / rebalances actually pay off?
  router.get(
    "/autopilot/outcomes",
    wrap(async (_req, res) => {
      // The fee-change log (D15) — every applied change, for a year — not
      // the run history's last 20 runs.
      res.json(await getAutopilotOutcomes(lnd, autopilot.feeChanges(), rebalanceLog.recent(200)));
    }),
  );

  // Overview dashboard — KPI totals + sparklines, recent activity feed and an
  // autopilot summary, assembled from a single forwards pull.
  router.get(
    "/dashboard",
    wrap(async (_req, res) => {
      const [report, ln, onchain, channels, leaseBenchmark] = await Promise.all([
        getForwardsReport(lnd, 30),
        getLnActivity(lnd, 10),
        getOnchainTxs(lnd, 10),
        getChannelsView(lnd),
        autopilot.leaseBenchmark(),
      ]);
      const totalCapacitySats = channels.reduce((s, c) => s + c.capacity, 0);
      // This node's own capital in its channels (pending ones earn nothing yet).
      const ownCapitalSats = channels.filter((c) => c.status === "open").reduce((s, c) => s + c.localBalance, 0);
      const since = Date.now() - report.windowDays * 86_400_000;
      const rebalanceFeesSats = rebalanceLog.successes(since).reduce((s, r) => s + (r.feeSats ?? 0), 0);
      res.json(
        buildDashboard(report, ln, onchain, rebalanceLog.summary(), autopilot.getState(), totalCapacitySats, {
          ownCapitalSats,
          rebalanceFeesSats,
          leaseBenchmark,
          magmaRefusals: autopilot.magma.refusals(),
        }),
      );
    }),
  );

  // Channel peer suggestions — read-only, computed from the network graph.
  router.get(
    "/suggestions",
    wrap(async (req, res) => {
      const overrides: Partial<SuggestionPolicy> = numericOverrides<SuggestionPolicy>(req.query, [
        "count",
        "minChannels",
        "maxStaleDays",
        "minSizeSats",
        "maxSizeSats",
      ]);
      if (req.query.requireClearnet !== undefined) {
        overrides.requireClearnet = req.query.requireClearnet === "true";
      }
      res.json(await getChannelSuggestionsV2(lnd, overrides, lnplus));
    }),
  );

  // Channels worth closing — demand/P&L/reach-aware, honest about freed capital.
  router.get(
    "/suggestions/close",
    wrap(async (_req, res) => {
      res.json(
        await getCloseSuggestionsV2(
          lnd,
          rebalanceLog.successes(),
          autopilot.feeV2Overrides(),
          overrides.all(),
        ),
      );
    }),
  );

  // ── lightningnetwork.plus (LN+) ─────────────────────────────────────────────
  // Read-only and key-free. LN+ adds a social trust layer on top of the graph:
  // ratings real operators gave each other, plus two liquidity marketplaces
  // (Pool and Swaps) that work differently from Magma — you trade channels for
  // channels or for credits, not for sats.

  // Our own LN+ standing, and what the reputation cache is doing.
  router.get(
    "/lnplus/status",
    wrap(async (_req, res) => {
      const ownKey = await getOwnPubkey(lnd);
      const me = await lnplus.lookup(ownKey).catch(() => null);
      res.json({
        pubkey: ownKey,
        onLnPlus: !!me,
        me,
        cache: lnplus.stats(),
      });
    }),
  );

  // Liquidity Pool participants: nodes that will open you a channel in exchange
  // for liquidity credits rather than sats. "minCredits" filters by how many
  // credits a node holds, which is what it can actually spend on a channel.
  router.get(
    "/lnplus/pool",
    wrap(async (req, res) => {
      const minCredits = Number(req.query.minCredits);
      const nodes = await getPoolNodes({
        minCreditsSats: Number.isFinite(minCredits) && minCredits > 0 ? minCredits : undefined,
        limit: 50,
      });
      // Our node is Tor-only on many installs, so say up front who we can reach.
      const peers = new Set((await getChannelsView(lnd)).map((c) => c.peerPubkey));
      res.json({
        nodes: nodes.map((n) => ({ ...n, alreadyPeered: peers.has(n.pubkey) })),
      });
    }),
  );

  // Liquidity Swaps, annotated with whether THIS node could actually join —
  // checked locally against the gates LN+ publishes, so we never invite the
  // user into a swap that would reject them.
  router.get(
    "/lnplus/swaps",
    wrap(async (req, res) => {
      const status = req.query.status === "opening" || req.query.status === "completed"
        ? (req.query.status as "opening" | "completed")
        : "pending";
      const [swaps, channels, info, ownKey] = await Promise.all([
        getSwaps({ status, limit: 50 }),
        getChannelsView(lnd),
        getWalletInfo({ lnd }),
        getOwnPubkey(lnd),
      ]);
      const mine = await lnplus.lookup(ownKey).catch(() => null);
      const uris: string[] = info.uris ?? [];
      const facts: NodeFacts = {
        capacitySats: channels.reduce((s, c) => s + c.capacity, 0),
        channelCount: channels.length,
        hasClearnet: uris.some((u) => !u.includes(".onion")),
        hasTor: uris.some((u) => u.includes(".onion")),
        prime: mine?.prime ?? false,
        pro: mine?.pro ?? false,
      };
      res.json({
        me: facts,
        swaps: swaps
          .filter((s) => !s.isPrivate)
          .map((s) => ({ ...s, eligibility: checkSwapEligibility(s, facts) })),
      });
    }),
  );

  /** 409 for a manual spend that would take coins promised to buyers. The
   *  orders are named, so the UI can ask "spend them anyway?" — and send the
   *  request again with `spendPromised: true` only after a yes. */
  const refusePromisedSpend = (res: Response, r: PromisedSpendRefusal): void => {
    res.status(409).json({ error: "capital_promised", ...r });
  };

  // Open a channel to a peer — real on-chain action, requires write access.
  router.post(
    "/channels/open",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { pubkey, socket, localTokens, feeRate, isPrivate } = req.body ?? {};
      const amount = intIn(localTokens, 20_000, MAX_CHANNEL_SATS);
      if (!isPubkey(pubkey) || amount === null) {
        res.status(400).json({ error: "bad_request", message: "valid pubkey (66 hex) and localTokens (20k–10 BTC) required." });
        return;
      }
      if (socket !== undefined && (typeof socket !== "string" || socket.length > 256)) {
        res.status(400).json({ error: "bad_request", message: "invalid socket." });
        return;
      }
      const fee = feeRate === undefined ? undefined : intIn(feeRate, 1, 10_000);
      if (feeRate !== undefined && fee === null) {
        res.status(400).json({ error: "bad_request", message: "feeRate out of range (1–10000 sat/vByte)." });
        return;
      }
      const spendPromised = req.body?.spendPromised;
      if (spendPromised !== undefined && typeof spendPromised !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "spendPromised must be true or false." });
        return;
      }
      const params = {
        pubkey,
        socket: socket ? String(socket) : undefined,
        localTokens: amount,
        feeRate: fee ?? undefined,
        isPrivate: Boolean(isPrivate),
      };
      // Coins promised to buyers are not the click's to spend (unless the
      // operator confirmed exactly that): a cheap look before the dial, so a
      // peer isn't dialed for an open that would be refused anyway.
      const early = spendPromised ? null : await promisedSpendRefusal(lnd, autopilot.capital, amount, { newChannel: true });
      if (early) {
        refusePromisedSpend(res, early);
        return;
      }
      // Dial first, outside the mutex (over Tor that can take a minute and a
      // half) — then the open itself, taken in turn with every other on-chain
      // commitment (Magma, LSPS1, autopilot opens), so none of those can check
      // the balance while this open is spending it.
      const connected = await connectForOpen(writeLnd, params);
      if (!connected.ok) {
        res.json({ ok: false, pubkey, localTokens: amount, error: connected.error });
        return;
      }
      const done = await autopilot.capital.mutex.run("manual open", async (): Promise<{ refusal: PromisedSpendRefusal } | { opened: unknown }> => {
        // Again, with the balance as it is now: an order may have been
        // accepted (or paid) while the peer was dialed.
        const refusal = spendPromised ? null : await promisedSpendRefusal(lnd, autopilot.capital, amount, { newChannel: true });
        return refusal ? { refusal } : { opened: await fundChannel(writeLnd, params) };
      });
      if ("refusal" in done) refusePromisedSpend(res, done.refusal);
      else res.json(done.opened);
    }),
  );

  // User settings (currency, …).
  router.get("/settings", (_req, res) => {
    res.json(settings.get());
  });
  router.post("/settings", (req, res) => {
    const { fiatCurrency, lspModeEnabled } = req.body ?? {};
    const patch: Parameters<typeof settings.set>[0] = {};
    if (fiatCurrency !== undefined) {
      if (!["off", "USD", "EUR", "GBP", "CHF"].includes(fiatCurrency)) {
        res.status(400).json({ error: "bad_request", message: "invalid fiatCurrency" });
        return;
      }
      patch.fiatCurrency = fiatCurrency;
    }
    if (lspModeEnabled !== undefined) {
      if (typeof lspModeEnabled !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "invalid lspModeEnabled" });
        return;
      }
      if (lspModeEnabled && !writeLnd) {
        res.status(400).json({ error: "read_only", message: WRITE_DISABLED_MSG });
        return;
      }
      patch.lspModeEnabled = lspModeEnabled;
    }
    const { lspClearnetAddress } = req.body ?? {};
    if (lspClearnetAddress !== undefined) {
      // host:port (IPv4 or domain), or "" to withdraw. Tor is announced by LND
      // itself — .onion doesn't belong here.
      const value = typeof lspClearnetAddress === "string" ? lspClearnetAddress.trim() : null;
      const m = value != null ? /^([a-z0-9.-]+):(\d{1,5})$/i.exec(value) : null;
      const okSocket =
        value === "" ||
        (m != null && !m[1].toLowerCase().endsWith(".onion") && Number(m[2]) >= 1 && Number(m[2]) <= 65535);
      if (value == null || !okSocket) {
        res.status(400).json({
          error: "bad_request",
          message: "invalid lspClearnetAddress — expected host:port (e.g. mynode.example.com:9735), not .onion",
        });
        return;
      }
      if (value && !writeLnd) {
        res.status(400).json({ error: "read_only", message: WRITE_DISABLED_MSG });
        return;
      }
      patch.lspClearnetAddress = value;
    }
    const next = settings.set(patch);
    lsps1.applySettings();
    res.json(next);
  });

  // LSP mode (LSPS1) — live status + the offer wallets currently see.
  router.get(
    "/lsp/status",
    wrap(async (_req, res) => {
      const [status, info] = await Promise.all([lsps1.status(), getWalletInfo({ lnd })]);
      res.json({ ...status, pubkey: info.public_key, uris: info.uris ?? [] });
    }),
  );

  // LSPS1 orders for the Market → Orders tab (never exposes invoice secrets).
  router.get("/lsp/orders", (_req, res) => {
    res.json({ orders: lsps1.orderViews() });
  });

  // Unserved demand — forwards we refused for lack of outbound liquidity,
  // aggregated per outgoing channel (failed-HTLC telemetry).
  // Raw refusals and what de-noising (D20) makes of them: probes, retries
  // and HTLCs too big for any refill are counted apart from the attempts a
  // refilled channel could have carried. "Fees missed" = those attempts ×
  // the channel's current fee — not the raw volume.
  router.get(
    "/htlc/demand",
    wrap(async (req, res) => {
      const days = intIn(req.query.days, 1, 30) ?? 7;
      const demand = getUnservedDemand(days);
      // Join peer aliases (and current fees) so the UI can name the channels.
      const [channels, rates] = demand.length
        ? await Promise.all([getChannelsView(lnd), getFeeRates({ lnd }).catch(() => null)])
        : [[], null];
      const alias = new Map(channels.map((c) => [c.id, c.peerAlias]));
      const ppm = new Map((rates?.channels ?? []).map((c) => [c.id, c.fee_rate]));
      res.json({
        days,
        trackedDays: telemetryAgeDays(),
        classifiedSince: classifiedSince(),
        channels: demand.map((d) => ({
          ...d,
          alias: alias.get(d.outChannel) ?? d.outChannel,
          missedFeesSats: Math.round((d.demandSats * (ppm.get(d.outChannel) ?? 0)) / 1_000_000),
        })),
      });
    }),
  );

  // Current BTC price in the chosen fiat currency (null when fiat is off).
  router.get(
    "/price",
    wrap(async (_req, res) => {
      const currency = settings.get().fiatCurrency;
      res.json({ currency, btcPrice: await getBtcPrice(currency) });
    }),
  );

  // ── Lightning send / receive ───────────────────────────────────────────────

  // Recent invoices + payments (read-only).
  router.get(
    "/ln/activity",
    wrap(async (_req, res) => {
      res.json(await getLnActivity(lnd));
    }),
  );

  // Decode a BOLT11 request so the UI can show amount/destination before paying.
  router.post(
    "/ln/decode",
    wrap(async (req, res) => {
      const { request } = req.body ?? {};
      if (!isPayRequest(request)) {
        res.status(400).json({ error: "bad_request", message: "valid BOLT11 request required." });
        return;
      }
      res.json(await decodeRequest(lnd, request.trim()));
    }),
  );

  // Create a receive invoice. Requires a write (invoices:write) macaroon.
  router.post(
    "/ln/invoice",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { tokens, description, expirySec } = req.body ?? {};
      const amount = intIn(tokens ?? 0, 0, MAX_RECEIVE_SATS);
      const expiry = intIn(expirySec ?? 3600, 60, 31_536_000);
      if (amount === null || expiry === null) {
        res.status(400).json({ error: "bad_request", message: "tokens (0–1 BTC) / expirySec out of range." });
        return;
      }
      if (description !== undefined && (typeof description !== "string" || description.length > 640)) {
        res.status(400).json({ error: "bad_request", message: "description too long (max 640)." });
        return;
      }
      res.json(
        await createInvoice(writeLnd, {
          tokens: amount,
          description: typeof description === "string" ? description : "",
          expirySec: expiry,
        }),
      );
    }),
  );

  // Pay a BOLT11 request. max_fee is enforced server-side; requires write access.
  router.post(
    "/ln/pay",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { request, maxFeeSats, tokens } = req.body ?? {};
      const maxFee = intIn(maxFeeSats ?? 0, 0, MAX_PAY_FEE_SATS);
      const amount = tokens === undefined ? undefined : intIn(tokens, 1, MAX_RECEIVE_SATS);
      if (!isPayRequest(request) || maxFee === null || (tokens !== undefined && amount === null)) {
        res.status(400).json({ error: "bad_request", message: "valid request and maxFeeSats (0–2M) required." });
        return;
      }
      try {
        res.json(await payRequest(writeLnd, { request: request.trim(), maxFeeSats: maxFee, tokens: amount ?? undefined }));
      } catch (err) {
        // A failed payment (no route, rejected, …) is a normal result, not a 502.
        res.json({ ok: false, id: "", tokens: 0, feeSats: 0, secret: "", error: describeError(err) });
      }
    }),
  );

  // ── On-chain wallet ────────────────────────────────────────────────────────

  // Balance + UTXOs + suggested fee rate (read-only).
  router.get(
    "/onchain",
    wrap(async (_req, res) => {
      res.json(await getOnchainState(lnd));
    }),
  );

  // On-chain transaction history (read-only).
  router.get(
    "/onchain/txs",
    wrap(async (_req, res) => {
      res.json(await getOnchainTxs(lnd));
    }),
  );

  // Generate a fresh receive address. Requires a write macaroon.
  router.post(
    "/onchain/address",
    wrap(async (_req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      res.json(await newAddress(writeLnd));
    }),
  );

  // Send on-chain. Requires write access; amount + fee rate validated.
  router.post(
    "/onchain/send",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { address, tokens, feeRate, spendPromised } = req.body ?? {};
      const amount = intIn(tokens, 546, MAX_ONCHAIN_SEND_SATS); // ≥ dust
      const rate = intIn(feeRate, 1, MAX_FEE_RATE);
      if (!isBtcAddress(address) || amount === null || rate === null || (spendPromised !== undefined && typeof spendPromised !== "boolean")) {
        res.status(400).json({
          error: "bad_request",
          message: "valid address, tokens (≥546 sat), feeRate (1–2000 sat/vB) and an optional spendPromised (true/false) required.",
        });
        return;
      }
      // Taken in turn with every channel open (Magma, LSPS1, the autopilot,
      // manual): a send in the middle of an open's check would spend what
      // that check counted on. Coins promised to buyers are refused unless
      // the operator confirmed spending them.
      let done: { refusal: PromisedSpendRefusal } | { sent: unknown };
      try {
        done = await autopilot.capital.mutex.run("on-chain send", async () => {
          const refusal = spendPromised ? null : await promisedSpendRefusal(lnd, autopilot.capital, amount, { newChannel: false });
          return refusal ? { refusal } : { sent: await sendOnchain(writeLnd, { address: address.trim(), tokens: amount, feeRate: rate }) };
        });
      } catch (err) {
        res.json({ ok: false, transactionId: "", error: describeError(err) });
        return;
      }
      if ("refusal" in done) refusePromisedSpend(res, done.refusal);
      else res.json(done.sent);
    }),
  );

  // Sign a message with the node (admin macaroon) — e.g. to prove node ownership
  // to Amboss when connecting your account, or any "Login with Node" challenge.
  router.post(
    "/sign",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "read_only", message: "Enable write mode to sign (needs the admin macaroon)." });
        return;
      }
      const message = typeof req.body?.message === "string" ? req.body.message : "";
      if (!message.trim()) {
        res.status(400).json({ error: "bad_request", message: "Enter a message to sign." });
        return;
      }
      const { signature } = await signMessage({ lnd: writeLnd, message });
      res.json({ signature });
    }),
  );

  // ── Amboss Magma (liquidity marketplace) ────────────────────────────────────
  // Reads (the marketplace + price) need no key. The key is stored per-install
  // and used for buying/selling. All behind the app login gate already.

  /** Run an Amboss call for a route. A refusal for the key (401/403,
   *  FORBIDDEN) has the key checked again — that check's definitive answer
   *  decides; an outage never touches the key. The error still reaches the
   *  client. */
  const withAmboss = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (isAuthError(err)) await amboss.recheckAfterRefusal();
      throw err;
    }
  };

  /** The key's state, plus how many Magma orders are in flight — Settings
   *  warns with that count before the key is removed: without a key those
   *  orders can't be opened, reported or settled (held payments are still
   *  released before they expire). */
  const keyStatus = () => ({
    ...amboss.status(),
    saleFeeBps: saleFeeConfig().bps,
    ordersInFlight: autopilot.magma.ordersInFlight(),
  });

  router.get(
    "/amboss/status",
    wrap(async (_req, res) => {
      // Report real key validity (cached), not just presence — a key that
      // expired/was revoked otherwise shows "connected" while Magma silently
      // fails. An outage is reported as keyCheck "unreachable", never as a
      // bad key: the last real verdict stays.
      await amboss.checkValidity();
      res.json(keyStatus());
    }),
  );

  // "Re-check" in the UI: ask Amboss now instead of trusting the cached verdict.
  router.post(
    "/amboss/key/check",
    wrap(async (_req, res) => {
      await amboss.checkValidity(true);
      res.json(keyStatus());
    }),
  );

  router.get(
    "/amboss/market",
    wrap(async (_req, res) => {
      res.json(await getMarket());
    }),
  );

  router.post("/amboss/key", async (req, res) => {
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    if (!apiKey) {
      res.status(400).json({ error: "missing_key", message: "Missing API key." });
      return;
    }
    const { verdict, error } = await checkKey(apiKey);
    if (verdict === false) {
      res.status(400).json({ error: "invalid_key", message: "Amboss rejected this API key." });
      return;
    }
    if (verdict === null) {
      // Not a verdict on the key: say so, and keep nothing unverified.
      res.status(503).json({
        error: "amboss_unreachable",
        message: `Could not reach Amboss to check the key (${error ?? "no answer"}) — nothing was saved. Try again in a moment.`,
      });
      return;
    }
    amboss.setKey(apiKey);
    res.json({ ok: true, connected: true });
  });

  router.delete("/amboss/key", (_req, res) => {
    amboss.clear();
    res.json({ ok: true, connected: false });
  });

  /** This node, as an offer's buyer conditions see it. */
  const buyerFacts = async (): Promise<BuyerFacts> => {
    const [channels, info] = await Promise.all([getChannelsView(lnd), getWalletInfo({ lnd })]);
    const open = channels.filter((c) => c.status === "open");
    const sockets = new Set<"TOR" | "CLEARNET">();
    for (const uri of info.uris ?? []) sockets.add(/\.onion(:\d+)?$/i.test(uri.split("@")[1] ?? "") ? "TOR" : "CLEARNET");
    return {
      capacitySat: open.reduce((s, c) => s + c.capacity, 0),
      channelCount: open.length,
      sockets,
      channelsWith: (pubkey) => channels.filter((c) => c.peerPubkey === pubkey && c.status !== "pending_close").length,
    };
  };

  // The offers ranked for THIS node at the size it wants (a4: lease length,
  // buyer conditions, Amboss's fee by order size, fee caps). Public data; no key.
  router.get(
    "/amboss/buy-offers",
    wrap(async (req, res) => {
      const sizeSats = intIn(req.query.size, MIN_CHANNEL_SATS, MAX_CHANNEL_SATS) ?? 2_000_000;
      const own = await getOwnPubkey(lnd);
      const [market, me, book] = await Promise.all([getMarket(), buyerFacts(), publicBook(own).catch(() => null)]);
      const tiers = book ? feeTiers(book.offers) : [];
      res.json({
        sizeSats,
        offers: rankBuyOffers(market.offers.filter((o) => o.sellerPubkey !== own), tiers, me, sizeSats),
        ambossFeeTiers: tiers.map((t) => ({ ambossFeePpm: t.ambossFee, upToSats: t.upTo })),
        inboundSatsPerUsd: market.inboundSatsPerUsd,
        satsPerUsd: market.satsPerUsd,
      });
    }),
  );

  // Step 1 — create an order and return the HODL invoice + EXACT sats. No
  // payment. The quote is recorded (magmaPurchases.ts): paying pays only this
  // invoice, declining cancels the order on Amboss.
  router.post(
    "/amboss/buy/quote",
    wrap(async (req, res) => {
      if (!amboss.hasKey()) {
        res.status(400).json({ error: "no_key", message: "Connect Amboss in Settings first." });
        return;
      }
      const usdCents = Math.floor(Number(req.body?.usdCents));
      const wantsOffer = typeof req.body?.offerId === "string" && req.body.offerId.trim().length > 0;
      if (!wantsOffer && (!Number.isFinite(usdCents) || usdCents < 500)) {
        res.status(400).json({ error: "bad_amount", message: "Minimum is $5 (500 cents)." });
        return;
      }
      const isPrivate = req.body?.private === true;
      const info = await getWalletInfo({ lnd });
      const uri = info.uris?.[0];
      if (!uri) {
        res.status(400).json({
          error: "no_uri",
          message: "Your node has no public address, so a seller can't open a channel to it.",
        });
        return;
      }
      // Buying a SPECIFIC offer, when the user picked one from the ranked list.
      // The generic `liquidity.buy` call takes only a dollar amount and lets
      // Amboss choose the seller, which made the ranking decorative: whatever the
      // user clicked, someone else could get the order. `market.order.create`
      // takes an offer_id, so the pick decides.
      const offerId = typeof req.body?.offerId === "string" ? req.body.offerId.trim() : "";
      const sizeSats = Math.floor(Number(req.body?.sizeSats));
      if (offerId) {
        if (!Number.isFinite(sizeSats) || sizeSats < MIN_CHANNEL_SATS || sizeSats > MAX_CHANNEL_SATS) {
          res.status(400).json({ error: "bad_size", message: "Choose a channel size within the offer's range." });
          return;
        }
        // The size the buyer chose must be one the offer sells now.
        const offer = (await getOffers()).find((o) => o.id === offerId);
        if (!offer) {
          res.status(409).json({ error: "offer_gone", message: "That offer is no longer listed — reload the market." });
          return;
        }
        const top = Math.min(offer.maxSizeSats, offer.availableSats);
        if (sizeSats < offer.minSizeSats || sizeSats > top) {
          res.status(400).json({
            error: "bad_size",
            message: `This offer sells channels of ${offer.minSizeSats.toLocaleString("en-US")}–${top.toLocaleString("en-US")} sat right now.`,
          });
          return;
        }
        const targeted = await withAmboss(() => buyFromOffer(amboss.getKey(), offerId, info.public_key, sizeSats, isPrivate));
        const dec = await decodeRequest(lnd, targeted.paymentRequest);
        const purchase = autopilot.purchases.recordQuote({
          orderId: targeted.orderId,
          offerId,
          sellerPubkey: offer.sellerPubkey,
          sizeSats: targeted.channelSizeSats,
          feeSats: dec.tokens,
          paymentRequest: targeted.paymentRequest,
          paymentHash: dec.id,
          payee: dec.destination,
          expiresAt: dec.expiresAt,
          leaseBlocks: targeted.leaseBlocks ?? offer.minBlockLength ?? null,
          feeRateCapPpm: targeted.feeRateCapPpm ?? offer.feeRateCapPpm,
          baseFeeCapSats: targeted.baseFeeCapSats ?? offer.baseFeeCapSats,
          usdCents: null,
        });
        res.json({
          orderId: targeted.orderId,
          paymentRequest: targeted.paymentRequest,
          sats: dec.tokens,
          channelSizeSats: targeted.channelSizeSats,
          sellerChosen: true,
          leaseBlocks: purchase.leaseBlocks,
          feeRateCapPpm: purchase.feeRateCapPpm,
          baseFeeCapSats: purchase.baseFeeCapSats,
          ambossFeeSats: targeted.ambossFeeSats ?? null,
        });
        return;
      }
      const quote = await withAmboss(() => buyLiquidity(amboss.getKey(), uri, usdCents, isPrivate));
      // Decode the invoice ourselves — authoritative amount for the confirm + cap.
      const decoded = await decodeRequest(lnd, quote.paymentRequest);
      autopilot.purchases.recordQuote({
        orderId: quote.orderId,
        offerId: null,
        sellerPubkey: null,
        sizeSats: quote.channelSizeSats,
        feeSats: decoded.tokens,
        paymentRequest: quote.paymentRequest,
        paymentHash: decoded.id,
        payee: decoded.destination,
        expiresAt: decoded.expiresAt,
        leaseBlocks: null,
        feeRateCapPpm: null,
        baseFeeCapSats: null,
        usdCents,
      });
      res.json({
        orderId: quote.orderId,
        paymentRequest: quote.paymentRequest,
        sats: decoded.tokens,
        channelSizeSats: quote.channelSizeSats,
      });
    }),
  );

  // The buyer declined the quote: cancel the order on Amboss, so it doesn't
  // stay live (before, declining just closed the dialog).
  router.post(
    "/amboss/buy/cancel",
    wrap(async (req, res) => {
      if (!needKey(res)) return;
      const orderId = typeof req.body?.orderId === "string" ? req.body.orderId : "";
      const p = autopilot.purchases.get(orderId);
      if (!p) {
        res.status(404).json({ error: "not_found", message: "No quote on record for this order." });
        return;
      }
      if (p.state !== "quoted" && p.state !== "pay_failed") {
        res.status(409).json({ error: "bad_state", message: `This order is ${p.state} — it can't be cancelled from here.` });
        return;
      }
      let cancelled = false;
      let error: string | undefined;
      try {
        // Amboss wants a reason; the closest for "I won't pay this" is UNABLE_TO_PAY.
        cancelled = await withAmboss(() => cancelPurchase(amboss.getKey(), orderId, "UNABLE_TO_PAY"));
        if (!cancelled) error = "Amboss did not confirm the cancel";
      } catch (err) {
        error = describeError(err);
      }
      autopilot.purchases.update(orderId, { state: cancelled ? "declined" : "cancel_failed", ...(error ? { error } : {}) });
      res.json({
        ok: true,
        cancelled,
        message: cancelled ? "Order cancelled on Amboss." : `Not paid; Amboss didn't confirm the cancel (${error}) — the unpaid order expires on its own.`,
      });
    }),
  );

  // Step 2 — pay the quoted invoice from our node (background). Only the
  // invoice recorded with the quote is paid: unexpired, to the payee it named,
  // for exactly the amount the buyer confirmed.
  router.post(
    "/amboss/buy/pay",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "read_only", message: "Write mode is off." });
        return;
      }
      const orderId = typeof req.body?.orderId === "string" ? req.body.orderId : "";
      const maxSats = Math.floor(Number(req.body?.maxSats));
      if (!orderId || !Number.isFinite(maxSats) || maxSats <= 0) {
        res.status(400).json({ error: "bad_request", message: "Missing order or confirmed amount." });
        return;
      }
      const p = autopilot.purchases.get(orderId);
      if (!p) {
        res.status(404).json({ error: "not_found", message: "No quote on record for this order — get a new quote." });
        return;
      }
      if (p.state !== "quoted" && p.state !== "pay_failed") {
        res.status(409).json({ error: "bad_state", message: `This order is ${p.state} — not paying it again.` });
        return;
      }
      const sent = typeof req.body?.paymentRequest === "string" ? req.body.paymentRequest.trim() : "";
      if (sent && sent !== p.paymentRequest) {
        res.status(400).json({ error: "wrong_invoice", message: "That is not the invoice of this quote. Aborted." });
        return;
      }
      if (Date.parse(p.expiresAt) <= Date.now()) {
        res.status(409).json({ error: "expired", message: "The quote's invoice has expired — get a new quote." });
        return;
      }
      const decoded = await decodeRequest(lnd, p.paymentRequest);
      if (decoded.tokens > maxSats || decoded.tokens !== p.feeSats) {
        res.status(400).json({
          error: "amount_mismatch",
          message: `Invoice is ${decoded.tokens} sat, not the confirmed ${maxSats} sat. Aborted.`,
        });
        return;
      }
      if (decoded.destination !== p.payee || decoded.destination === (await getOwnPubkey(lnd))) {
        res.status(400).json({ error: "wrong_payee", message: "The invoice's payee doesn't match the quote. Aborted." });
        return;
      }
      // Routing-fee cap for paying the (small) fee invoice: 1% + 25 sat floor.
      const maxFeeSats = Math.max(25, Math.ceil(decoded.tokens * 0.01));
      autopilot.purchases.startPayment(orderId);
      // A hold invoice: the payment stays in flight until the seller's channel
      // is confirmed. This call's answer is one report among others — the
      // order lane also asks LND by payment hash (after a restart, or when
      // this stream drops while LND keeps the HTLC in flight), and no report
      // moves the record backwards. A failure said here is only the stream's
      // word until LND confirms it.
      void payRequest(writeLnd, { request: p.paymentRequest, maxFeeSats })
        .then((r) =>
          autopilot.purchases.paymentOutcome(
            orderId,
            r.ok ? { status: "succeeded", feeSats: r.feeSats } : { status: "failed", error: "payment failed", confirmed: false },
          ),
        )
        .catch((e) => autopilot.purchases.paymentOutcome(orderId, { status: "failed", error: describeError(e), confirmed: false }));
      res.json({ ok: true, sats: decoded.tokens });
    }),
  );

  /** The payment hint for an order, from the purchase ledger. */
  const paymentHint = (orderId: string) => {
    const p = autopilot.purchases.get(orderId);
    if (!p) return null;
    if (p.state === "paying") return { state: "paying" as const };
    // Only the pay call said "failed" (a dropped stream, a restart): the order
    // lane asks LND how it really ended — not a failure yet.
    if (p.state === "pay_failed" && !p.failureConfirmed) return { state: "unclear" as const, error: p.error };
    if (p.state === "pay_failed") return { state: "failed" as const, error: p.error };
    if (p.state === "paid" || p.state === "channel_open") return { state: "paid" as const, feeSats: p.routingFeeSats ?? undefined };
    return null;
  };

  // Poll order status (Amboss truth) + our payment record; the purchase
  // ledger follows it.
  router.get(
    "/amboss/order",
    wrap(async (req, res) => {
      if (!amboss.hasKey()) {
        res.status(400).json({ error: "no_key", message: "Connect Amboss in Settings first." });
        return;
      }
      const id = typeof req.query.id === "string" ? req.query.id : "";
      if (!id) {
        res.status(400).json({ error: "bad_request", message: "Missing order id." });
        return;
      }
      const order = await withAmboss(() => getOrder(amboss.getKey(), id));
      autopilot.purchases.fromOrder(id, order);
      res.json({ ...order, payment: paymentHint(id) });
    }),
  );

  // Inbound bought here (newest first): quotes, cancels, payments, channels.
  router.get("/amboss/purchases", (_req, res) => {
    res.json({ purchases: autopilot.purchases.list() });
  });

  // ── Magma selling (offers + orders, on the Magma API) ───────────────────────
  const needKey = (res: Response): boolean => {
    if (amboss.hasKey()) return true;
    res.status(400).json({ error: "no_key", message: "Connect Amboss in Settings first." });
    return false;
  };

  // Magma v2 — profit-aware recommendations (dry-run; no execution).
  router.get(
    "/amboss/recommendations",
    wrap(async (_req, res) => {
      // Deliberately NOT gated on an Amboss key. Almost everything that makes
      // this page useful now comes from public data — the clearing price, the
      // market's real order sizes, whether your size window can be matched at
      // all. Gating it meant that the one user who most needs the diagnosis, the
      // one whose key expired and whose offer therefore stopped selling, saw an
      // empty page instead. The engine already tolerates a missing key: your own
      // offers and orders simply come back empty.
      // The autopilot's own call, with its inputs (a8: one builder for both).
      res.json(await autopilot.magmaReport(amboss.getKey()));
    }),
  );

  // Can this node realistically SELL on Magma (D8)? Comparable live offers,
  // how many ever sold, the fills per offer-month — from Amboss's public book
  // (cached a day; ?refresh=1 asks again) and the capital listable now.
  // Needs no key: the user deciding whether to sell at all is who needs it.
  router.get(
    "/amboss/eligibility",
    wrap(async (req, res) => {
      res.json(await autopilot.magmaEligibility(req.query.refresh === "1"));
    }),
  );

  // Your offers, plus the sync status: what the autopilot wants for each vs
  // what Amboss has, and how the last write went (nothing silent).
  router.get(
    "/amboss/my-offers",
    wrap(async (_req, res) => {
      if (!needKey(res)) return;
      const own = await getOwnPubkey(lnd);
      const offers = await withAmboss(() => getMyOffers(amboss.getKey(), own));
      res.json({ offers, sync: autopilot.offerSyncStatus(), controls: autopilot.offerControls(), feeCaps: autopilot.offerFeeCaps() });
    }),
  );

  router.get("/amboss/offer-sync", (_req, res) => {
    res.json(autopilot.offerSyncStatus());
  });

  // "Why don't I sell?" — the diagnosis checklist answered from the live
  // state: version, write mode, key, Liquidity provision and the automation
  // switches, the order lane, the offer vs the engine's target (price,
  // window, lease, fee promise), the last offer write, recent orders and
  // how they ended, and whether this node can realistically sell at all.
  // Every part that can't be read says so (never a silent "ok").
  router.get(
    "/amboss/sell-diagnostics",
    wrap(async (_req, res) => {
      const st = autopilot.getState();
      const keyed = amboss.hasKey();
      if (keyed) await amboss.checkValidity();
      const own = await getOwnPubkey(lnd);
      const settle = <T>(p: Promise<T>): Promise<{ ok: T } | { err: string }> =>
        p.then(
          (ok) => ({ ok }),
          (err: unknown) => ({ err: describeError(err) }),
        );
      const [offers, rec, sales, eligibility, channels] = await Promise.all([
        keyed ? settle(withAmboss(() => getMyOffers(amboss.getKey(), own))) : Promise.resolve({ err: "no Amboss key" } as const),
        settle(autopilot.magmaReport(amboss.getKey())),
        keyed ? getMyOrders(amboss.getKey(), own).then((v) => v.orders, () => null) : Promise.resolve(null),
        autopilot.magmaEligibility().catch(() => autopilot.lastEligibility),
        getChannelsView(lnd).catch(() => null),
      ]);
      const publicOpen = channels?.filter((c) => c.status === "open" && !c.private) ?? null;
      const key = amboss.status();
      res.json(
        buildSellDiagnostics({
          version: process.env.APP_VERSION ?? "dev",
          canWrite: st.canWrite,
          key: { connected: key.connected, valid: key.keyValid, check: key.keyCheck, lastError: key.lastError },
          config: st.config,
          lane: st.magmaLane,
          sync: autopilot.offerSyncStatus(),
          controls: autopilot.offerControls(),
          offers: "ok" in offers ? offers.ok : null,
          offersError: "err" in offers ? offers.err : null,
          rec: "ok" in rec ? rec.ok : null,
          recError: "err" in rec ? rec.err : null,
          feeCaps: autopilot.offerFeeCaps(),
          recentOrders: autopilot.magma.recentOrders(10),
          sales,
          eligibility,
          node: publicOpen ? { publicChannels: publicOpen.length, capacitySat: publicOpen.reduce((t, c) => t + c.capacity, 0) } : null,
        }),
      );
    }),
  );

  // Your sales, with this node's own record of each (order journal: phase,
  // why it was rejected or skipped, the funding outpoint) and the order lane.
  router.get(
    "/amboss/my-orders",
    wrap(async (_req, res) => {
      if (!needKey(res)) return;
      // This node's sales only (one Amboss account can sell for several nodes).
      const view = await withAmboss(async () => getMyOrders(amboss.getKey(), await getOwnPubkey(lnd)));
      res.json({
        pendingSeller: view.pendingSeller,
        lane: autopilot.magma.laneStatus(),
        orders: view.orders.map((o) => {
          const local = autopilot.magma.localView(o.id);
          return { ...o, transactionId: local?.fundingOutpoint?.split(":")[0] ?? o.transactionId, local };
        }),
      });
    }),
  );

  /**
   * A manual write to an offer: only to one of THIS node's offers. One Amboss
   * account can list offers for several nodes; the ids are all in the same
   * account, so without this check a click could reprice, resize or disable
   * another node's offer. Null (and a 409 sent) when it isn't this node's.
   */
  const ownOffer = async (id: string, res: Response): Promise<MyOffer | null> => {
    const [offer, own] = await Promise.all([withAmboss(() => getMyOffer(amboss.getKey(), id)), getOwnPubkey(lnd)]);
    if (offer.nodePubkey === own) return offer;
    res.status(409).json({
      error: "other_node",
      message: "This offer belongs to another node of your Amboss account — LightningMate only manages this node's offers.",
    });
    return null;
  };

  /** Offer terms from a request body (sizes in sats, rate in ppm, lease in blocks). */
  const parseOfferTerms = (b: Record<string, unknown>, res: Response): OfferTerms | null => {
    const terms = {
      totalSizeSats: Math.floor(Number(b.totalSizeSats)),
      minSizeSats: Math.floor(Number(b.minSizeSats)),
      maxSizeSats: Math.floor(Number(b.maxSizeSats)),
      feeRatePpm: Math.floor(Number(b.feeRatePpm)),
      baseFeeSats: Math.floor(Number(b.baseFeeSats)),
      minBlockLength: Math.floor(Number(b.minBlockLength)),
    };
    if (!Object.values(terms).every((n) => Number.isFinite(n) && n >= 0)) {
      res.status(400).json({ error: "bad_request", message: "Fill in all fields with valid numbers." });
      return null;
    }
    if (terms.minSizeSats <= 0 || terms.maxSizeSats < terms.minSizeSats || terms.totalSizeSats < terms.maxSizeSats) {
      res.status(400).json({ error: "bad_sizes", message: "Sizes must satisfy 0 < min ≤ max ≤ total." });
      return null;
    }
    if (terms.baseFeeSats <= 0) {
      res.status(400).json({
        error: "bad_fee",
        message: "Set a base fee above 0 — offers are priced with a base fee + fee rate.",
      });
      return null;
    }
    if (terms.minBlockLength <= 0) {
      res.status(400).json({ error: "bad_lease", message: "Set a minimum lease length in blocks." });
      return null;
    }
    return terms;
  };

  router.post(
    "/amboss/offer",
    wrap(async (req, res) => {
      if (!needKey(res)) return;
      const parsed = parseOfferTerms(req.body ?? {}, res);
      if (!parsed) return;
      // Every offer carries the routing-fee promise (D7) — kept by the fee
      // autopilot for each channel sold.
      const terms: OfferTerms = { ...parsed, ...autopilot.offerFeeCaps() };
      const write: OfferWrite = { at: new Date().toISOString(), by: "manual", action: "create", fields: ambossFields(terms), ok: false };
      let offerId: string;
      try {
        const { public_key } = await getWalletInfo({ lnd });
        offerId = await withAmboss(() => createOffer(amboss.getKey(), public_key, terms));
      } catch (err) {
        write.error = describeError(err);
        autopilot.recordOfferWrite(null, "new-offer", write);
        res.status(502).json({ error: "amboss_failed", message: `Amboss did not create the offer: ${write.error}` });
        return;
      }
      write.ok = true;
      // Created by hand with the operator's terms: theirs until they hand it
      // to the autopilot (no repricing of it behind their back).
      autopilot.pauseOfferAutomation(offerId, "you created this offer by hand");
      const created = await getMyOffer(amboss.getKey(), offerId).catch(() => null);
      autopilot.recordOfferWrite(created, offerId, { ...write, verified: created ? created.id === offerId : undefined });
      res.json({ ok: true, offerId });
    }),
  );

  router.post(
    "/amboss/offer/update",
    wrap(async (req, res) => {
      if (!needKey(res)) return;
      const b = req.body ?? {};
      const id = typeof b.id === "string" ? b.id : "";
      if (!id) {
        res.status(400).json({ error: "bad_request", message: "Missing offer id." });
        return;
      }
      const parsed = parseOfferTerms(b, res);
      if (!parsed) return;
      if (!(await ownOffer(id, res))) return;
      const terms: OfferTerms = { ...parsed, ...autopilot.offerFeeCaps() };
      const write: OfferWrite = { at: new Date().toISOString(), by: "manual", action: "update", fields: ambossFields(terms), ok: false };
      try {
        write.ok = await withAmboss(() => updateOffer(amboss.getKey(), id, terms));
        if (!write.ok) write.error = "Amboss did not apply the update (success: false)";
      } catch (err) {
        write.error = describeError(err);
      }
      if (!write.ok) {
        autopilot.recordOfferWrite(null, id, write);
        res.status(502).json({ error: "amboss_refused", message: `Offer not updated: ${write.error}` });
        return;
      }
      // Edited by hand: the operator's terms now — the autopilot leaves them
      // alone until handed back (it used to overwrite them at its next run).
      autopilot.pauseOfferAutomation(id, "you edited this offer");
      // "success" is Amboss's word; reading the offer back is the proof.
      const read = await getMyOffer(amboss.getKey(), id).catch(() => null);
      write.verified = read ? termsMatch(read, terms) : undefined;
      autopilot.recordOfferWrite(read, id, write);
      res.json({ ok: true, verified: write.verified ?? null, offer: read });
    }),
  );

  // Enable or disable an offer. Amboss's toggle flips whatever the status is
  // — it is not idempotent — so a caller that wants a STATE says so (`want`):
  // the offer is read right before, flipped only when it isn't in that state
  // already, and an answer that isn't the wanted state is an error. (Turning
  // Liquidity provision off flipped every offer it had listed a moment
  // before: one the autopilot had disabled in between was ENABLED again, and
  // a failed flip was swallowed while the dialog said "disabled".)
  router.post(
    "/amboss/offer/toggle",
    wrap(async (req, res) => {
      if (!needKey(res)) return;
      const id = typeof req.body?.id === "string" ? req.body.id : "";
      if (!id) {
        res.status(400).json({ error: "bad_request", message: "Missing offer id." });
        return;
      }
      const wantRaw = req.body?.want;
      if (wantRaw !== undefined && wantRaw !== "ENABLED" && wantRaw !== "DISABLED") {
        res.status(400).json({ error: "bad_request", message: "want must be ENABLED or DISABLED." });
        return;
      }
      const want: "ENABLED" | "DISABLED" | null = wantRaw ?? null;
      // One status change per offer at a time: a capital-safety flip of the
      // autopilot's under way is waited for, and the offer read afresh after
      // it — never flipped by a status that just changed.
      await autopilot.withOffer(id, async () => {
        const offer = await ownOffer(id, res);
        if (!offer) return;
        // Already as wanted — or not flippable from here (ADMIN_DISABLED is
        // Amboss support's): nothing to toggle. The click still counts: "keep
        // it disabled" on an offer the autopilot had just disabled for lack of
        // capital is the operator's decision now — it is not listed again
        // when capital returns.
        if (want && offer.status !== (want === "ENABLED" ? "DISABLED" : "ENABLED")) {
          if (offer.status === want) autopilot.offerStatusSetByHand(id, want);
          res.json({ status: offer.status, changed: false });
          return;
        }
        const write: OfferWrite = { at: new Date().toISOString(), by: "manual", action: "update", fields: { offer_id: id }, ok: false };
        let status: string;
        try {
          status = await withAmboss(() => toggleOffer(amboss.getKey(), id));
        } catch (err) {
          write.error = describeError(err);
          autopilot.recordOfferWrite(null, id, write);
          throw err;
        }
        write.ok = !want || status === want;
        write.action = status === "ENABLED" ? "enable" : "disable";
        if (!write.ok) write.error = `Amboss reports the offer ${status}, not ${want}`;
        // The listing is the operator's now: a manual disable sticks (the
        // autopilot used to re-enable it within half an hour), a manual enable
        // lists it. Neither takes the offer's terms over. A status Amboss
        // reports AGAINST the click is not the operator's choice: recording it
        // as theirs made "enable" on an offer the autopilot had disabled for
        // lack of capital — answered DISABLED — a disable by hand, never
        // listed again.
        if (write.ok) autopilot.offerStatusSetByHand(id, status);
        autopilot.recordOfferWrite(await getMyOffer(amboss.getKey(), id).catch(() => null), id, write);
        if (!write.ok) {
          res.status(502).json({ error: "not_toggled", status, message: `Offer not ${want === "DISABLED" ? "disabled" : "enabled"}: ${write.error}.` });
          return;
        }
        res.json({ status, changed: true });
      });
    }),
  );

  // Hand an offer back to the autopilot ("Let the autopilot manage it"), or
  // take it over without changing it. Only this node's offers.
  router.post(
    "/amboss/offer/automation",
    wrap(async (req, res) => {
      if (!needKey(res)) return;
      const id = typeof req.body?.id === "string" ? req.body.id : "";
      const managed = req.body?.managed;
      if (!id || typeof managed !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "Offer id and managed (true/false) required." });
        return;
      }
      if (!(await ownOffer(id, res))) return;
      if (managed) autopilot.resumeOfferAutomation(id);
      else autopilot.pauseOfferAutomation(id, "you took it over");
      res.json({ ok: true, sync: autopilot.offerSyncStatus(), controls: autopilot.offerControls() });
    }),
  );

  // Seller fulfilment by hand. Each goes through the SAME order journal,
  // per-order serialisation and on-chain mutex as the autopilot's order lane
  // (magmaDesk.ts): a click can never race the lane into a second channel,
  // and a failure is an error status, never "200 { ok: false }".
  const sendDesk = (res: Response, r: DeskResult): void => {
    if (r.ok) {
      res.json(r);
      return;
    }
    const status =
      r.code === "read_only" ? 403
      : r.code === "no_key" ? 400
      : r.code === "shutting_down" || r.code === "journal" ? 503
      : r.code === "bad_status" || r.code === "capital" || r.code === "unreachable" || r.code === "not_held" ? 409
      : 502;
    res.status(status).json({ ...r, error: r.code ?? "failed" });
  };

  const orderId = (req: Request, res: Response): string | null => {
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if (!id || id.length > 100) {
      res.status(400).json({ error: "bad_request", message: "Missing order id." });
      return null;
    }
    return id;
  };

  // Accept: a HODL invoice for the order's fee (the buyer's payment is held
  // until the channel is confirmed; any failure refunds it).
  router.post(
    "/amboss/order/accept",
    wrap(async (req, res) => {
      const id = orderId(req, res);
      if (id) sendDesk(res, await autopilot.magma.accept(id));
    }),
  );

  // Open the channel to the buyer and report it (idempotent per order).
  router.post(
    "/amboss/order/open",
    wrap(async (req, res) => {
      const id = orderId(req, res);
      if (id) sendDesk(res, await autopilot.magma.open(id));
    }),
  );

  // Reject an order that can't be served (only while it awaits approval).
  router.post(
    "/amboss/order/reject",
    wrap(async (req, res) => {
      const id = orderId(req, res);
      if (id) sendDesk(res, await autopilot.magma.reject(id));
    }),
  );

  // Error middleware — surface LND/connection failures as JSON, not a crash.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = describeError(err);
    console.error("[api error]", message);
    res.status(502).json({ error: "node_request_failed", message });
  });

  return router;
}
