import type {
  AlertAckRequest,
  AlertAckResult,
  AmbossKeyRequest,
  AmbossKeyResult,
  AmbossStatus,
  ApplyRecommendedRequest,
  ApplyRecommendedResponse,
  AuthStatus,
  AuthUnlockRequest,
  AuthUnlockResult,
  AutopilotConfigPatch,
  AutopilotResumeResult,
  AutopilotRunResult,
  AutopilotState,
  BoughtInboundResponse,
  BuyCancelRequest,
  BuyCancelResult,
  BuyOffersResponse,
  BuyPayRequest,
  BuyPayResult,
  BuyQuoteRequest,
  BuyQuoteResponse,
  ChannelCloseRequest,
  ChannelOpenRequest,
  ChannelView as ApiChannelView,
  DaysQuery,
  EligibilityQuery,
  FeeApplyRequest,
  FeeApplyResponse,
  FeePreviewQuery,
  ForwardsReportQuery,
  HealthInfo,
  LnDecodeRequest,
  LnInvoiceRequest,
  LnPayRequest,
  LnPlusPoolQuery,
  LnPlusPoolResponse,
  LnPlusStatus,
  LnPlusSwapsQuery,
  LnPlusSwapsResponse,
  LspOrdersResponse,
  LspStatus,
  MyOffersResponse,
  MyOrder as ApiMyOrder,
  MyOrdersView,
  NeverOpenRequest,
  NeverOpenResult,
  OfferAutomationRequest,
  OfferAutomationResult,
  OfferCreateResult,
  OfferTermsRequest,
  OfferToggleRequest,
  OfferToggleResult,
  OfferUpdateRequest,
  OfferUpdateResult,
  OnchainSendRequest,
  OnchainSendResult,
  OnchainState as ApiOnchainState,
  OpenChannelResult as ApiOpenChannelResult,
  OpenEstimate,
  OrderActionRequest,
  OrderQuery,
  OrderState as ApiOrderState,
  OverrideRequest,
  PayResult as ApiPayResult,
  PeerConnectRequest,
  PeerConnectResult,
  PriceInfo,
  PrivacyInfo,
  PurchasePaymentHint,
  PurchasesResponse,
  RebalanceCostsResponse,
  RebalanceExecRequest,
  RebalanceLogResponse,
  SendPreviewQuery,
  SettingsPatch,
  SignRequest,
  SignResult,
  SizeQuery,
  SuggestionsQuery,
  SuggestionsResponse,
  TzQuery,
  UnservedDemandReport,
} from "../apiTypes.js";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Router, type Request, type Response, type NextFunction } from "express";
import { getClosedChannels, getFeeRates, getWalletInfo, signMessage, type AuthenticatedLnd, type GetClosedChannelsResult } from "lightning";
import { getNodeScore } from "../services/score.js";
import type { Config } from "../config.js";
import { getNodeSummary, getOwnPubkey } from "../services/node.js";
import { getChannelsView } from "../services/channels.js";
import { getFlowSummary, getForwardsReport, parseTzOffset, readForwardEvents } from "../services/forwards.js";
import { getFeePreview, type FeeApplyItem, type FeePolicy } from "../services/fees.js";
import { type SuggestionPolicy } from "../services/suggestions.js";
import { getChannelSuggestionsV2, getCloseSuggestionsV2 } from "../services/suggestRecommend.js";
import { channelLeases, leaseProtection, standardChannelId } from "../services/leases.js";
import { BOUGHT_INBOUND_METHOD, amortizedPurchaseCost, boughtInboundRoi } from "../services/inboundRoi.js";
import { labelCostChannels, rebalanceCosts } from "../services/rebalanceCosts.js";
import { getAlias } from "../services/aliases.js";
import type { LnPlusStore } from "../services/lnplusStore.js";
import { checkSwapEligibility, getPoolNodes, getSwaps, type NodeFacts } from "../services/lnplus.js";
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
  MIN_SEND_SATS,
  getFeeEstimates,
  getOnchainState,
  getOnchainTxs,
  newAddress,
  planSend,
  previewSend,
  sendBudget,
  sendOnchain,
  type SendCheckCode,
  type SendPreview,
  type SendRequest,
  type SendResult,
} from "../services/onchain.js";
import { closeChannelByOutpoint, connectForOpen, fundChannel, MIN_CHANNEL_SATS, type OpenChannelResult } from "../services/channelOps.js";
import { promisedSpendRefusal, spendableOnchain, type PromisedSpendRefusal } from "../services/capital.js";
import { CLOSE_TX_VBYTES, OPEN_TX_VBYTES } from "../services/nodeEconomics.js";
import { MIN_YIELD_EARNED_SAT, MIN_YIELD_FORWARDS, OPEN_PAYBACK_MONTHS } from "../services/openPlan.js";
import { saleFeeConfig, type ServiceFeeLedger } from "../services/serviceFee.js";
import { floorWindowStart, getFeeRecommendations } from "../services/feeRecommend.js";
import { getBtcPrice } from "../services/price.js";
import { outboundRouting, viaTor } from "../services/http.js";
import type { FiatCurrency, SettingsStore } from "../services/settings.js";
import type { ChannelOverride, FeeMode, OverridesStore } from "../services/overrides.js";
import { getAlerts, magmaRefusalAlerts, offerPriceAlerts, serviceFeeAlerts, stateAlerts } from "../services/alerts.js";
import { authRequired, bearer, issueToken, verifyPassword, verifyToken } from "../services/auth.js";
import { SlidingWindowLimiter } from "../services/rateLimit.js";
import { acknowledgeStoreIncident } from "../store.js";
import { ConfigValidationError } from "../services/autopilotConfig.js";
import { buyFromOffer, buyLiquidity, cancelPurchase, getMarket, getOffers, getOrder, isAuthError } from "../services/amboss.js";
import { rankBuyOffers, type BuyerFacts } from "../services/magmaBuy.js";
import { feeTiers, publicBook } from "../services/magmaEligibility.js";
import {
  checkKey,
  NO_EXTRA_TERMS,
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
import { FeeItemError, RebalanceBudgetError, RefillInFlightError, StalePlanError, ambossFields, termsMatch, type Autopilot, type OfferWrite } from "../services/autopilot.js";
import type { RebalanceLog } from "../services/rebalanceLog.js";
import { BackupStore, exportScb, getBackupStatus } from "../services/backup.js";
import type { EarningsLog } from "../services/earningsLog.js";
import type { Lsps1Service } from "../services/lsps1.js";
import { classifiedSince, getUnservedDemand, telemetryAgeDays } from "../services/htlcTelemetry.js";
import { buildSellDiagnostics } from "../services/sellDiagnostics.js";

// Pull the numeric keys of a policy object out of the query string (read as
// its contract type: queryOf).
function numericOverrides<T>(query: Fields<T>, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    const n = Number(query[key]);
    if (Number.isFinite(n)) out[key] = n as T[keyof T];
  }
  return out;
}

const WRITE_DISABLED_MSG =
  "Writing is disabled. Set LM_ENABLE_WRITE=true and provide a write macaroon " +
  "(LND_WRITE_MACAROON / LND_WRITE_MACAROON_PATH, or admin.macaroon on Umbrel).";

// ── What a request carries, as the contract names it ─────────────────────────

/** The mark a read carries of the contract type it was read as (Fields) —
 *  declared only: nothing of it exists at run time. */
declare const readAs: unique symbol;

/**
 * A request's fields as the contract type `T` names them (apiTypes.ts — what
 * the web sends): each of T's keys, none of them promised, every value
 * `unknown` until the route's own checks have vouched for it (anything can
 * arrive over HTTP).
 *
 * The mark keeps a read what it was read as: it can't be handed on as — or
 * joined with — the read of another contract type that has a key it lacks.
 * So whatever reads a request (the route, or a parser it hands the read to)
 * reads its route's own contract's keys only. Before, the on-chain send read
 * its body as the preview's query and its own body at once (`Fields<
 * SendPreviewQuery> & Fields<OnchainSendRequest>`): a key renamed in one of
 * the two, the web changed to match, still compiled while the other kept the
 * old name — and every send of an amount would have got a 400 (review of P8,
 * run 2). A read may still go where fewer keys are read: an offer's update
 * (id and terms) to the terms' parser. `key => void` makes that the rule — a
 * read of A passes as one of B only when every key of B is one of A's.
 */
type Fields<T> = { [K in keyof T]?: unknown } & { readonly [readAs]?: (key: keyof T) => void };

/**
 * A request's body, read as the contract names it. A route reads its body
 * only through this (web/test/apiContract.test.tsx holds it to that, and
 * pairs the type with the one the web's request names): a key the route
 * reads that the contract doesn't have fails to compile here, and the web
 * builds the body from the same type — before, the routes destructured an
 * untyped `req.body`, and a field renamed on one side passed every check
 * (review of P8, final round).
 */
function bodyOf<T extends object>(req: Request): Fields<T> {
  return (req.body ?? {}) as Fields<T>;
}

/** A query string's parameters the same way, for every route that reads one
 *  (web/test/apiContract.test.tsx holds them to that, and pairs each with the
 *  contract type the web's get<…, Q>() names). Every value arrives as text:
 *  the web sends a number in decimal and a flag as "true" or "false"
 *  (web/src/api.ts, queryString) — the route's own checks parse them. */
function queryOf<T extends object>(req: Request): Fields<T> {
  return req.query as Fields<T>;
}

/** An object inside a request (a refill's gate, a fee item) the same way —
 *  no fields at all when it is no object. */
function fieldsOf<T extends object>(value: unknown): Fields<T> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields<T>) : {};
}

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
/** `value` is one of `options` (a string union's allowed values). */
function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}
const FIAT_CURRENCIES: readonly FiatCurrency[] = ["off", "USD", "EUR", "GBP", "CHF"];
const FEE_MODES: readonly FeeMode[] = ["auto", "fixed", "exclude"];
const isFeeMode = (v: unknown): v is FeeMode => isOneOf(v, FEE_MODES);
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
function parsePolicyQuery(query: Fields<FeePreviewQuery>): Partial<FeePolicy> {
  const out: Partial<FeePolicy> = {};
  const keys: (keyof FeePreviewQuery)[] = [
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

/** A state file in the data directory, for "Download diagnostics": its size
 *  and age — or why it could not be looked at. Never its contents. */
export interface StateFileInfo {
  file: string;
  bytes?: number;
  modifiedAt?: string;
  error?: string;
}

/**
 * The data directory's state files, for diagnostics. The directory is busy:
 * every save writes "<name>.tmp-<pid>-<n>" and renames it over the file a
 * moment later (store.ts), and the autopilot saves on every run and every
 * decision change. A temp file is no state of its own and is left out, and a
 * file gone between the listing and its look is skipped — before, either
 * failed the whole download with HTTP 502 "node_request_failed", which reads
 * as an LND failure (review of P7, round 2). A file that is there but can't
 * be looked at is listed with the reason: worth knowing when helping.
 */
export function stateFileList(dir: string): StateFileInfo[] {
  const out: StateFileInfo[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || f.name.includes(".tmp-")) continue;
    try {
      const s = statSync(join(dir, f.name));
      out.push({ file: f.name, bytes: s.size, modifiedAt: s.mtime.toISOString() });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // gone since the listing
      out.push({ file: f.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
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
  /** The chain tip as LND sees it (0 when it can't say: leases then read as running). */
  const currentHeight = (): Promise<number> =>
    getWalletInfo({ lnd })
      .then((w) => w.current_block_height)
      .catch(() => 0);

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
    res.json({ authRequired: authRequired(), unlocked: verifyToken(bearer(req)) } satisfies AuthStatus);
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
    if (!verifyPassword(bodyOf<AuthUnlockRequest>(req).password)) {
      unlockFailures.hit(key);
      res.status(401).json({ error: "bad_password", message: "Wrong password." });
      return;
    }
    unlockFailures.reset(key);
    res.json({ token: issueToken() } satisfies AuthUnlockResult);
  });

  router.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "lightningmate",
      version: process.env.APP_VERSION ?? "dev",
      // Umbrel hands the app its LND through APP_LIGHTNING_NODE_IP (config.ts):
      // the UI's words for "LND unreachable" differ (no .env to check there).
      platform: process.env.APP_LIGHTNING_NODE_IP?.trim() ? "umbrel" : "standalone",
    } satisfies HealthInfo);
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
  // could not show what a channel charges — only Autopilot → Fees could), its
  // lease (sold on Magma or over LSPS1, or bought on Magma — the table tags
  // it and the close dialog asks before breaking it), and how long its peer
  // has been away (a short outage is no reason to force-close).
  router.get(
    "/channels",
    wrap(async (_req, res) => {
      const [channels, rates, height] = await Promise.all([
        getChannelsView(lnd),
        getFeeRates({ lnd }).catch(() => null),
        currentHeight(),
      ]);
      const nowMs = Date.now();
      autopilot.uptime.observe(channels, nowMs);
      const leases = channelLeases(channels, autopilot.leaseSources(), height, nowMs);
      const rateById = new Map((rates?.channels ?? []).map((c) => [c.id, c]));
      res.json(
        channels.map((c) => {
          const r = rateById.get(c.id);
          return {
            ...c,
            feeRatePpm: r ? r.fee_rate : null,
            baseFeeMsat: r ? Number(r.base_fee_mtokens) : null,
            lease: leases.get(c.id) ?? null,
            offline: autopilot.uptime.offlineInfo(c, nowMs),
          } satisfies ApiChannelView;
        }),
      );
    }),
  );

  router.get(
    "/flows",
    wrap(async (req, res) => {
      const days = Number(queryOf<DaysQuery>(req).days ?? config.flowWindowDays);
      const windowDays = Number.isFinite(days) && days > 0 ? days : config.flowWindowDays;
      res.json(await getFlowSummary(lnd, windowDays));
    }),
  );

  // Forwards report (Thunderhub-style) — daily series + per-channel + recent,
  // bucketed in the viewer's local days (`tz`: minutes east of UTC).
  router.get(
    "/forwards/report",
    wrap(async (req, res) => {
      const q = queryOf<ForwardsReportQuery>(req);
      const days = Number(q.days ?? 30);
      const windowDays = Math.min(90, Math.max(1, Number.isFinite(days) ? days : 30));
      res.json(await getForwardsReport(lnd, windowDays, { tzOffsetMin: parseTzOffset(q.tz) }));
    }),
  );

  // Dry-run fee proposals — read-only, never writes to the node.
  router.get(
    "/fees/preview",
    wrap(async (req, res) => {
      res.json(await getFeePreview(lnd, parsePolicyQuery(queryOf<FeePreviewQuery>(req)), overrides.all()));
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
          {},
          autopilot.feeChanges(),
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
    const { channelId, mode, fixedPpm } = bodyOf<OverrideRequest>(req);
    if (!isChannelId(channelId) || !isFeeMode(mode)) {
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
        await getAlerts(lnd, [
          ...stateAlerts(config.dataDir),
          ...serviceFeeAlerts(serviceFees),
          ...magmaRefusalAlerts(autopilot.magma),
          ...offerPriceAlerts(autopilot.offerSyncStatus(), autopilot.actsOnOffers()),
          ...autopilot.onchainLockAlerts(),
        ]),
      );
    }),
  );

  // Operator has read an acknowledgeable alert ("state:<id>" / "fee:<key>").
  router.post("/alerts/ack", (req, res) => {
    const { id: given } = bodyOf<AlertAckRequest>(req);
    const id = typeof given === "string" ? given : "";
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
    res.json({ ok: true } satisfies AlertAckResult);
  });

  // The service-fee ledger, for transparency: what was owed, paid or refused.
  router.get("/service-fees", (_req, res) => {
    const { bps, address } = saleFeeConfig();
    res.json({ bps, address, entries: serviceFees.entries() });
  });

  // Close a channel by funding outpoint — real on-chain action, write only.
  // A channel inside its lease (sold on Magma or over LSPS1, or bought on
  // Magma) is refused unless the request says `breakLease: true` — what the
  // close dialog sends only after the operator confirmed breaking it (review
  // a3/a4/a6: closing one broke a buyer's lease, which Amboss counts against
  // the seller score, or threw away inbound this node paid for). A channel
  // still opening can't be closed at all.
  router.post(
    "/channels/close",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { transactionId, transactionVout, isForce, feeRate, breakLease } = bodyOf<ChannelCloseRequest>(req);
      const vout = intIn(transactionVout, 0, 1_000_000);
      if (!isTxid(transactionId) || vout === null) {
        res.status(400).json({ error: "bad_request", message: "valid transactionId (64 hex) and transactionVout required." });
        return;
      }
      if (breakLease !== undefined && typeof breakLease !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "breakLease must be true or false." });
        return;
      }
      // Optional sat/vByte for cooperative closes; ignored for force-closes.
      const rate = feeRate === undefined ? undefined : (intIn(feeRate, 1, 5000) ?? undefined);
      const [channels, height, sources] = await Promise.all([getChannelsView(lnd), currentHeight(), autopilot.leaseSourcesFresh()]);
      const channel = channels.find((c) => c.transactionId === transactionId && c.transactionVout === vout);
      if (channel?.status === "pending_open") {
        res.status(409).json({
          error: "pending",
          message: "This channel is still opening — it can't be closed until its funding transaction confirms.",
        });
        return;
      }
      // Matched against every channel, as the Channels table and the close
      // list match it: a purchase is claimed by the same channel everywhere.
      const lease = channel ? channelLeases(channels, sources, height).get(channel.id) : undefined;
      if (lease?.running && breakLease !== true) {
        res.status(409).json({
          error: "lease_active",
          message: `Not closed: this channel was ${leaseProtection(lease)}. Confirm breaking the lease to close it anyway.`,
          lease,
        });
        return;
      }
      res.json(await closeChannelByOutpoint(writeLnd, transactionId, vout, Boolean(isForce), rate));
    }),
  );

  // Reconnect to a channel's peer (the close dialog offers this first for a
  // peer that is offline: a short outage is no reason to force-close). Dials
  // the given address, then the ones the graph knows — over Tor that can
  // take up to a minute and a half.
  router.post(
    "/peers/connect",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { pubkey, socket } = bodyOf<PeerConnectRequest>(req);
      if (!isPubkey(pubkey) || (socket !== undefined && (typeof socket !== "string" || socket.length > 256))) {
        res.status(400).json({ error: "bad_request", message: "valid pubkey (66 hex) and optional socket required." });
        return;
      }
      const done = await connectForOpen(writeLnd, { pubkey, socket: socket || undefined });
      res.json((done.ok ? { ok: true } : { ok: false, error: done.error }) satisfies PeerConnectResult);
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
      const { items: given } = bodyOf<FeeApplyRequest>(req);
      const raw: unknown[] = Array.isArray(given) ? given : [];
      if (raw.length === 0 || raw.length > 500) {
        res.status(400).json({ error: "bad_request", message: "1–500 fee items required." });
        return;
      }
      const items: FeeApplyItem[] = [];
      for (const entry of raw) {
        const it = fieldsOf<FeeApplyItem>(entry);
        const vout = intIn(it.transactionVout, 0, 1_000_000);
        const feeRatePpm = intIn(it.feeRatePpm, 0, MAX_FEE_PPM);
        const baseFeeMsat = intIn(it.baseFeeMsat, 0, MAX_BASE_MSAT);
        if (typeof it.id !== "string" || !isTxid(it.transactionId) || vout === null || feeRatePpm === null || baseFeeMsat === null) {
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
      res.json({ results: done.results } satisfies FeeApplyResponse);
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
      const { channelIds: raw } = bodyOf<ApplyRecommendedRequest>(req);
      if (raw !== undefined && (!Array.isArray(raw) || raw.length > 500 || !raw.every((id: unknown) => isChannelId(id)))) {
        res.status(400).json({ error: "bad_request", message: "channelIds must be a list of channel ids (at most 500)." });
        return;
      }
      const changes = await autopilot.applyRecommended(raw as string[] | undefined);
      if (!changes) {
        res.status(409).json({ error: "busy", message: "The autopilot is running right now — try again in a moment." });
        return;
      }
      res.json({ changes } satisfies ApplyRecommendedResponse);
    }),
  );

  // LSP mode (Settings) is no switch of the autopilot's: "Pause all
  // automation" leaves it on — it keeps answering wallet orders and opening
  // their channels — and while it is on, the pause says so (review of P7,
  // round 2: "every automation off at once" and "nothing new starts on its
  // own" were untrue with it on). It runs only with write access.
  const lspModeOn = (): boolean => settings.get().lspModeEnabled && !!writeLnd;
  /** The autopilot's state as the pages get it. */
  const autopilotView = (): AutopilotState => ({ ...autopilot.getState(), lspModeOn: lspModeOn() });

  // Autopilot status/config.
  router.get("/autopilot", (_req, res) => {
    res.json(autopilotView());
  });

  // Update autopilot config (enable/disable, interval, cooldown, policy). Every
  // value is checked against its bounds; one bad field rejects the whole update
  // with a message naming it, and nothing is saved.
  router.post("/autopilot", (req, res) => {
    try {
      autopilot.setConfig(bodyOf<AutopilotConfigPatch>(req));
    } catch (err) {
      if (err instanceof ConfigValidationError) {
        res.status(400).json({ error: "invalid_config", message: err.message, errors: err.errors });
        return;
      }
      throw err;
    }
    res.json(autopilotView());
  });

  // "Download diagnostics" (review a8-engineering:autopilot-decisions-
  // invisible): what someone helping needs to see why the autopilot did or
  // didn't act — the version, the settings (they hold no secret; the Amboss
  // key is never in it), each area's status and when its decision changed,
  // the run history, the Magma lane and offer sync, and each state file's
  // size and age (names and times only, never contents). Reads nothing new
  // from Amboss: the Magma report is included only when the pages have it.
  router.get(
    "/diagnostics",
    wrap(async (_req, res) => {
      const st = autopilot.getState();
      const files = stateFileList(config.dataDir);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      res.setHeader("Content-Disposition", `attachment; filename="lightningmate-diagnostics-${stamp}.json"`);
      res.json({
        generatedAt: new Date().toISOString(),
        app: {
          version: process.env.APP_VERSION ?? "dev",
          // The commit (Dockerfile ARG APP_REVISION, from CI); empty in a
          // local build — null then.
          revision: process.env.APP_REVISION?.trim() || null,
          platform: process.env.APP_LIGHTNING_NODE_IP?.trim() ? "umbrel" : "standalone",
          node: process.version,
          writeEnabled: !!writeLnd,
        },
        autopilot: {
          config: st.config,
          status: st.status,
          lastRunAt: st.lastRunAt,
          runningSince: st.runningSince,
          lastRun: st.lastRun,
          paused: st.paused,
          lspModeOn: lspModeOn(),
          decisionLog: autopilot.decisionLog(),
          history: st.history,
          rebalanceBudget: st.rebalanceBudget,
        },
        magma: {
          key: amboss.status(),
          lane: st.magmaLane,
          offerSync: autopilot.offerSyncStatus(),
          recentOrders: autopilot.magma.recentOrders(20),
          refusals: autopilot.magma.refusals(),
          eligibility: autopilot.lastEligibility,
          report: await autopilot.cachedPageReport(),
        },
        alerts: stateAlerts(config.dataDir),
        stateFiles: files,
      });
    }),
  );

  // "Pause all automation": every switch off at once, what was on kept for
  // "Resume" — which switches them back on, Liquidity provision excepted
  // (switching selling on is its own decision, with the selling check, D9).
  // LSP mode is not among them (lspModeOn above).
  router.post("/autopilot/pause", (_req, res) => {
    autopilot.pauseAll();
    res.json(autopilotView());
  });
  router.post("/autopilot/resume", (_req, res) => {
    const { resumed, sellingWasOn } = autopilot.resumeAll();
    res.json({ resumed, sellingWasOn, state: autopilotView() } satisfies AutopilotResumeResult);
  });

  // Trigger one autopilot run immediately.
  router.post(
    "/autopilot/run",
    wrap(async (_req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const run = await autopilot.runOnceNow();
      if (!run) {
        // A run in progress (the schedule's, or a click before): this click
        // starts nothing — it no longer answers an empty run as if a run had
        // found nothing to do.
        const since = autopilot.getState().runningSince;
        res.status(409).json({
          error: "busy",
          message: `A run is already in progress${since ? ` (since ${since.slice(11, 16)} UTC)` : ""} — its result shows here when it ends.`,
          runningSince: since,
        });
        return;
      }
      res.json({ run, state: autopilotView() } satisfies AutopilotRunResult);
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
      const { targetId, sourceId, amountSats, econRatio, maxFeePpm, maxFeeSats, gate, planAt, routeCostPpm } = bodyOf<RebalanceExecRequest>(req);
      const amount = intIn(amountSats, 1000, MAX_REBALANCE_SATS);
      // When the plan the row came from was made (the tab sends its
      // generatedAt): a target refilled since is refused as stale.
      const planOk = planAt === undefined || (typeof planAt === "string" && planAt.length <= 64 && Number.isFinite(Date.parse(planAt)));
      const ratio = econRatio === undefined ? 0.8 : numIn(econRatio, 0.05, 1);
      const maxFee = maxFeePpm === undefined ? undefined : intIn(maxFeePpm, 1, MAX_FEE_PPM);
      const maxSats = maxFeeSats === undefined ? undefined : intIn(maxFeeSats, 1, MAX_REBALANCE_SATS);
      // The plan's route cost for the row's size (a recommended row sends it).
      const routeCost = routeCostPpm === undefined ? undefined : intIn(routeCostPpm, 0, MAX_FEE_PPM);
      // The profit gate's earnings side (a recommended row sends it): each
      // size it tries may pay at most what it earns above the minimum.
      const gateFields = fieldsOf<NonNullable<RebalanceExecRequest["gate"]>>(gate);
      const g =
        gate === undefined
          ? undefined
          : {
              revenuePpm: intIn(gateFields.revenuePpm, 1, MAX_FEE_PPM),
              demandSats: intIn(gateFields.demandSats, 0, MAX_REBALANCE_SATS * 1000),
              minNetSats: intIn(gateFields.minNetSats, 0, MAX_REBALANCE_SATS),
            };
      if (
        !isChannelId(targetId) ||
        !isChannelId(sourceId) ||
        amount === null ||
        ratio === null ||
        (maxFeePpm !== undefined && maxFee === null) ||
        (maxFeeSats !== undefined && maxSats === null) ||
        (routeCostPpm !== undefined && routeCost === null) ||
        (g !== undefined && (g.revenuePpm === null || g.demandSats === null || g.minNetSats === null)) ||
        !planOk
      ) {
        res.status(400).json({
          error: "bad_request",
          message:
            "valid targetId/sourceId, amountSats (1k–1 BTC), econRatio (0.05–1) and optional maxFeePpm, maxFeeSats (the most the refill may pay, sat), gate {revenuePpm, demandSats, minNetSats}, routeCostPpm (the plan's route cost) and planAt (when the plan was made, ISO time) required.",
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
          ...(routeCost !== null && routeCost !== undefined ? { routeCostPpm: routeCost } : {}),
          ...(planAt !== undefined ? { planAt: planAt as string } : {}),
        });
      } catch (err) {
        if (err instanceof StalePlanError) {
          // Nothing was sent: the row was planned before its target's last
          // refill — the tab reloads its plan.
          res.status(409).json({ error: "stale_plan", message: err.message, targetId: err.targetId, lastAt: err.lastAt, planAt: err.planAt });
          return;
        }
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

  // Rebalance accounting log + totals over a stated window (the Rebalance
  // tab's "N done · X sat fees" covered an unlabelled 200 attempts).
  router.get("/rebalance/log", (_req, res) => {
    res.json({ summary: rebalanceLog.summary(30), records: rebalanceLog.recent(), trackedSince: rebalanceLog.trackedSince() } satisfies RebalanceLogResponse);
  });

  // What rebalancing cost over a window, per refilled channel — from LND's
  // payments (every tool's rebalances), not a capped log: the Analytics tab
  // read the newest 50 records for 30 and 90 days.
  router.get(
    "/rebalance/costs",
    wrap(async (req, res) => {
      const days = intIn(queryOf<DaysQuery>(req).days ?? 30, 1, 36_500);
      if (days === null) {
        res.status(400).json({ error: "bad_request", message: "days must be 1–36500." });
        return;
      }
      const nowMs = Date.now();
      const [costs, channels, closed] = await Promise.all([
        rebalanceCosts(lnd, rebalanceLog, nowMs - days * 86_400_000, nowMs),
        getChannelsView(lnd).catch(() => null),
        getClosedChannels({ lnd }).catch((): GetClosedChannelsResult => ({ channels: [] })),
      ]);
      // A channel closed since: named by the log's record of its refills,
      // else by its peer (LND's closed channels).
      const logged = new Map<string, string>();
      for (const r of rebalanceLog.successes()) if (r.targetAlias && !logged.has(r.targetId)) logged.set(r.targetId, r.targetAlias);
      const peerOfClosed = new Map(closed.channels.filter((c) => c.id).map((c) => [c.id as string, c.partner_public_key]));
      for (const c of costs.perChannel) {
        const peer = peerOfClosed.get(c.channelId);
        if (c.channelId && !logged.has(c.channelId) && peer) logged.set(c.channelId, await getAlias(lnd, peer));
      }
      res.json({ windowDays: days, ...costs, perChannel: labelCostChannels(costs.perChannel, channels, (id) => logged.get(id)) } satisfies RebalanceCostsResponse);
    }),
  );

  // Node health score (A–F) + network rank — net of what the node spends,
  // and with what its sales earned (lease income, as in P&L).
  router.get(
    "/score",
    wrap(async (_req, res) => {
      res.json(
        await getNodeScore(lnd, {
          rebalanceLog,
          purchases: autopilot.purchases,
          earnings,
          serviceFees,
          soldLeases: () => autopilot.capital.soldLeases(),
          closeTxs: autopilot.closeTxs,
        }),
      );
    }),
  );

  // Profit & loss over a window — routing revenue and lease income vs every
  // cost: opens, closes, rebalancing, inbound bought, the service fee.
  router.get(
    "/pnl",
    wrap(async (req, res) => {
      const days = Number(queryOf<DaysQuery>(req).days ?? config.flowWindowDays);
      const windowDays = Number.isFinite(days) && days > 0 ? days : config.flowWindowDays;
      res.json(await getPnl(lnd, { rebalanceLog, earnings, serviceFees, purchases: autopilot.purchases, closeTxs: autopilot.closeTxs }, windowDays));
    }),
  );

  // Autopilot outcomes — did the fee changes / rebalances actually pay off?
  router.get(
    "/autopilot/outcomes",
    wrap(async (_req, res) => {
      // The fee-change log (D15) — every applied change, for a year — not
      // the run history's last 20 runs; and every successful refill of the
      // window, not the newest 200 records of successes and failures mixed.
      res.json(await getAutopilotOutcomes(lnd, autopilot.feeChanges(), rebalanceLog.successes(Date.now() - 400 * 86_400_000)));
    }),
  );

  // What inbound bought on Magma brought in: per purchase, the fees of the
  // forwards that came in through its channel during the lease, against what
  // it cost.
  router.get(
    "/analytics/bought-inbound",
    wrap(async (req, res) => {
      const windowDays = intIn(queryOf<DaysQuery>(req).days ?? 30, 1, 36_500);
      if (windowDays === null) {
        res.status(400).json({ error: "bad_request", message: "days must be 1–36500." });
        return;
      }
      const nowMs = Date.now();
      // The window's share of what inbound bought cost, spread over each lease.
      const amortizedSats = amortizedPurchaseCost(autopilot.purchases.paidCosts(), windowDays, nowMs);
      const purchases = autopilot.purchases.list().filter((p) => p.state === "channel_open" && p.paidAt);
      if (purchases.length === 0) {
        res.json({ method: BOUGHT_INBOUND_METHOD, windowDays, amortizedSats, items: [] } satisfies BoughtInboundResponse);
        return;
      }
      const oldest = Math.min(...purchases.map((p) => Date.parse(p.paidAt as string)).filter((t) => Number.isFinite(t)));
      const days = Math.min(400, Math.max(1, Math.ceil((nowMs - oldest) / 86_400_000) + 1));
      const [channels, height, forwards] = await Promise.all([getChannelsView(lnd), currentHeight(), readForwardEvents(lnd, days, nowMs)]);
      const leases = channelLeases(channels, autopilot.leaseSources(), height, nowMs);
      const aliasById = new Map(channels.map((c) => [c.id, c.peerAlias]));
      const byOrder = new Map<string, string>();
      for (const [channelId, l] of leases) if (l.kind === "magma_purchase") byOrder.set(l.orderId, channelId);
      const channelOf = (p: (typeof purchases)[number]) => {
        // The lease registry's match first; a channel closed since: the one Amboss named.
        const id = byOrder.get(p.orderId) ?? standardChannelId(p.channelId);
        return id ? { channelId: id, alias: aliasById.get(id) ?? "" } : null;
      };
      res.json({
        method: BOUGHT_INBOUND_METHOD,
        windowDays,
        amortizedSats,
        // Whether the read got every forward: a read cut short misses the newest.
        forwardsComplete: forwards.complete,
        items: boughtInboundRoi(purchases, channelOf, forwards.events, nowMs, { fromMs: nowMs - days * 86_400_000, complete: forwards.complete }),
      } satisfies BoughtInboundResponse);
    }),
  );

  // Overview dashboard — KPI totals + sparklines, recent activity feed and an
  // autopilot summary, assembled from a single forwards pull.
  router.get(
    "/dashboard",
    wrap(async (req, res) => {
      const nowMs = Date.now();
      const [report, ln, onchain, channels, leaseBenchmark, ownPubkey, closed] = await Promise.all([
        getForwardsReport(lnd, 30, { tzOffsetMin: parseTzOffset(queryOf<TzQuery>(req).tz), nowMs }),
        getLnActivity(lnd, 10),
        getOnchainTxs(lnd, 10),
        getChannelsView(lnd),
        autopilot.leaseBenchmark(),
        getOwnPubkey(lnd).catch(() => undefined),
        getClosedChannels({ lnd }).catch((): GetClosedChannelsResult => ({ channels: [] })),
      ]);
      const totalCapacitySats = channels.reduce((s, c) => s + c.capacity, 0);
      // This node's own capital in its channels (pending ones earn nothing yet).
      const ownCapitalSats = channels.filter((c) => c.status === "open").reduce((s, c) => s + c.localBalance, 0);
      const since = nowMs - report.windowDays * 86_400_000;
      const rebalancing = await rebalanceCosts(lnd, rebalanceLog, since, nowMs);
      // The feed's on-chain lines: funding transactions, and closing ones
      // with the sweeps LND names for them — of closed channels and of
      // channels still closing (whose fee bumps and sweeps the feed tells by
      // what they spend), each named by its peer.
      const opens = new Set<string>([...channels.map((c) => c.transactionId), ...closed.channels.map((c) => c.transaction_id)]);
      const closes = new Set<string>();
      // Closing transactions of channels still closing: what spends their
      // non-wallet outputs is their fee bump or sweep (buildDashboard).
      const closingNow = new Set<string>();
      const closeTitles = new Map<string, string>();
      const inFeed = new Set(onchain.flatMap((t) => [t.id, ...(t.spends ?? [])]));
      for (const c of channels) {
        if (c.status !== "pending_close" || !c.closeTransactionId) continue;
        closes.add(c.closeTransactionId);
        closingNow.add(c.closeTransactionId);
        closeTitles.set(c.closeTransactionId, c.peerAlias);
      }
      for (const c of closed.channels) {
        const ids = [c.close_transaction_id, c.close_balance_spent_by, c.anchor_spent_by, ...c.close_payments.map((p) => p.spent_by)].filter(
          (id): id is string => !!id,
        );
        for (const id of ids) closes.add(id);
        // Named only when one of its transactions is in the feed (an alias
        // is a graph lookup).
        if (!ids.some((id) => inFeed.has(id))) continue;
        const alias = await getAlias(lnd, c.partner_public_key);
        for (const id of ids) closeTitles.set(id, id === c.close_transaction_id ? alias : `${alias} — sweep`);
      }
      res.json(
        buildDashboard(
          report,
          ln,
          onchain,
          { count: rebalancing.count, totalAmountSats: rebalancing.amountSats },
          autopilot.getState(),
          totalCapacitySats,
          {
            ownCapitalSats,
            rebalanceFeesSats: rebalancing.feeSats,
            rebalanceSource: rebalancing.source,
            leaseBenchmark,
            magmaRefusals: autopilot.magma.refusals(),
            ownPubkey,
            channelTxids: { opens, closes, closingNow, closeTitles },
            lspModeOn: lspModeOn(),
          },
        ),
      );
    }),
  );

  // Channel peer suggestions — read-only, computed from the network graph.
  router.get(
    "/suggestions",
    wrap(async (req, res) => {
      const q = queryOf<SuggestionsQuery>(req);
      const overrides: Partial<SuggestionPolicy> = numericOverrides(q, [
        "count",
        "minChannels",
        "maxStaleDays",
        "minSizeSats",
        "maxSizeSats",
      ]);
      if (q.requireClearnet !== undefined) {
        overrides.requireClearnet = q.requireClearnet === "true";
      }
      const report = await getChannelSuggestionsV2(lnd, overrides, lnplus);
      // Which of them the channel autopilot never opens to (the operator's list).
      const never = autopilot.neverOpenPeers();
      res.json({
        ...report,
        suggestions: report.suggestions.map((s) => ({ ...s, neverOpen: Object.prototype.hasOwnProperty.call(never, s.pubkey) })),
      } satisfies SuggestionsResponse);
    }),
  );

  // The operator's "never open automatically" list (the channel autopilot
  // skips these peers; an open by hand is still possible). A preference, no
  // node write.
  router.post("/channels/never-open", (req, res) => {
    const { pubkey, never, alias } = bodyOf<NeverOpenRequest>(req);
    if (!isPubkey(pubkey) || typeof never !== "boolean" || (alias !== undefined && (typeof alias !== "string" || alias.length > 100))) {
      res.status(400).json({ error: "bad_request", message: "valid pubkey (66 hex), never (true/false) and optional alias required." });
      return;
    }
    autopilot.setNeverOpen(pubkey, never, alias ?? "");
    res.json({ ok: true, neverOpen: autopilot.neverOpenPeers() } satisfies NeverOpenResult);
  });

  // Channels worth closing — demand/P&L/reach-aware, honest about freed
  // capital — never one still opening or closing, or inside its lease, and
  // never because its peer went away for a moment.
  router.get(
    "/suggestions/close",
    wrap(async (_req, res) => {
      const leaseSources = await autopilot.leaseSourcesFresh();
      res.json(
        await getCloseSuggestionsV2(lnd, rebalanceLog.successes(), autopilot.feeV2Overrides(), overrides.all(), {
          leaseSources,
          uptime: autopilot.uptime,
          // Only opens the channel autopilot would make (its rules, LN+).
          opportunity: () => autopilot.swapTargets(),
        }),
      );
    }),
  );

  // ── lightningnetwork.plus (LN+) ─────────────────────────────────────────────
  // Read-only and key-free. LN+ adds a social trust layer on top of the graph:
  // ratings real operators gave each other, plus two liquidity marketplaces
  // (Pool and Swaps) that work differently from Magma — you trade channels for
  // channels or for credits, not for sats.

  // Our own LN+ standing, and what the reputation cache is doing. (With LN+
  // lookups switched off: what is cached, nothing asked.)
  router.get(
    "/lnplus/status",
    wrap(async (_req, res) => {
      const ownKey = await getOwnPubkey(lnd);
      const me = await lnplus.lookup(ownKey).catch(() => null);
      res.json({
        enabled: lnplus.isEnabled(),
        viaTor: viaTor(),
        // Whether the app has Umbrel's Tor proxy at all (every request goes
        // through it when it does).
        torProxy: !!outboundRouting().proxy,
        pubkey: ownKey,
        onLnPlus: !!me,
        me,
        cache: lnplus.stats(),
      } satisfies LnPlusStatus);
    }),
  );

  /** 409 for an LN+ view while the operator has LN+ lookups switched off. */
  const lnplusOff = (res: Response): boolean => {
    if (lnplus.isEnabled()) return false;
    res.status(409).json({ error: "lnplus_off", message: "LN+ lookups are switched off (Settings → Privacy)." });
    return true;
  };

  // Liquidity Pool participants: nodes that will open you a channel in exchange
  // for liquidity credits rather than sats. "minCredits" filters by how many
  // credits a node holds, which is what it can actually spend on a channel.
  router.get(
    "/lnplus/pool",
    wrap(async (req, res) => {
      if (lnplusOff(res)) return;
      const minCredits = Number(queryOf<LnPlusPoolQuery>(req).minCredits);
      const nodes = await getPoolNodes({
        minCreditsSats: Number.isFinite(minCredits) && minCredits > 0 ? minCredits : undefined,
        limit: 50,
      });
      // Our node is Tor-only on many installs, so say up front who we can reach.
      const peers = new Set((await getChannelsView(lnd)).map((c) => c.peerPubkey));
      res.json({
        nodes: nodes.map((n) => ({ ...n, alreadyPeered: peers.has(n.pubkey) })),
      } satisfies LnPlusPoolResponse);
    }),
  );

  // Liquidity Swaps, annotated with whether THIS node could actually join —
  // checked locally against the gates LN+ publishes, so we never invite the
  // user into a swap that would reject them.
  router.get(
    "/lnplus/swaps",
    wrap(async (req, res) => {
      if (lnplusOff(res)) return;
      const { status: asked } = queryOf<LnPlusSwapsQuery>(req);
      const status = asked === "opening" || asked === "completed" ? asked : "pending";
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
      } satisfies LnPlusSwapsResponse);
    }),
  );

  /** 409 for a manual spend that would take coins promised to buyers. The
   *  orders are named, so the UI can ask "spend them anyway?" — and send the
   *  request again with `spendPromised: true` only after a yes. */
  const refusePromisedSpend = (res: Response, r: PromisedSpendRefusal): void => {
    res.status(409).json({ error: "capital_promised", ...r });
  };

  // What opening a channel of `size` would cost and leave (the Open form):
  // the mempool's rates, what can be spent after the reserve and the coins
  // promised to buyers, and what a sat in this node's month-old channels
  // earns — so the form shows the open's cost, the balance left and its
  // payback before anything is sent (review a3-channels:open-fee-gate-too-loose).
  router.get(
    "/channels/open-estimate",
    wrap(async (req, res) => {
      const size = intIn(queryOf<SizeQuery>(req).size, MIN_CHANNEL_SATS, MAX_CHANNEL_SATS);
      if (size === null) {
        res.status(400).json({ error: "bad_request", message: `size (${MIN_CHANNEL_SATS}–${MAX_CHANNEL_SATS} sat) required.` });
        return;
      }
      const reserveSat = autopilot.getState().config.channelReserveSats;
      const [fees, sp, economics] = await Promise.all([
        getFeeEstimates(lnd),
        spendableOnchain(lnd, autopilot.capital, reserveSat).catch(() => null),
        autopilot.openEconomics(),
      ]);
      res.json({
        sizeSats: size,
        fees,
        spendableSat: sp?.spendableSat ?? null,
        reserveSat: sp?.reserve.totalSat ?? null,
        promisedSat: sp?.reservedSat ?? null,
        yieldPpmYear: economics?.ppmYear ?? null,
        // What that yield stands on (null: LND couldn't be read) — with too
        // little routing behind it the form says so instead of a payback.
        yieldEvidence: economics?.evidence ?? null,
        minYieldForwards: MIN_YIELD_FORWARDS,
        minYieldEarnedSat: MIN_YIELD_EARNED_SAT,
        openVbytes: OPEN_TX_VBYTES,
        closeVbytes: CLOSE_TX_VBYTES,
        paybackMonths: OPEN_PAYBACK_MONTHS,
        autopilotMaxFeeRate: autopilot.getState().config.channelMaxFeeRate,
        // The routing fee the channel starts with (POST /channels/open sets
        // it) — the form says so before the click.
        initialRoutingFee: autopilot.initialRoutingFee(),
      } satisfies OpenEstimate);
    }),
  );

  // Open a channel to a peer — real on-chain action, requires write access.
  router.post(
    "/channels/open",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { pubkey, socket, localTokens, feeRate, isPrivate, spendPromised } = bodyOf<ChannelOpenRequest>(req);
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
      if (spendPromised !== undefined && typeof spendPromised !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "spendPromised must be true or false." });
        return;
      }
      // The routing fee it starts with: the one the fee engine protects a new
      // channel at — not LND's default (stock: 1 sat + 1 ppm).
      const routing = autopilot.initialRoutingFee();
      const params = {
        pubkey,
        socket: socket ? String(socket) : undefined,
        localTokens: amount,
        feeRate: fee ?? undefined,
        isPrivate: Boolean(isPrivate),
        routingFeePpm: routing.feeRatePpm,
        routingBaseFeeMsat: routing.baseFeeMsat,
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
        res.json({ ok: false, pubkey, localTokens: amount, error: connected.error } satisfies ApiOpenChannelResult);
        return;
      }
      const done = await autopilot.capital.mutex.run("manual open", async (): Promise<{ refusal: PromisedSpendRefusal } | { opened: OpenChannelResult }> => {
        // Again, with the balance as it is now: an order may have been
        // accepted (or paid) while the peer was dialed.
        const refusal = spendPromised ? null : await promisedSpendRefusal(lnd, autopilot.capital, amount, { newChannel: true });
        return refusal ? { refusal } : { opened: await fundChannel(writeLnd, params) };
      });
      if ("refusal" in done) refusePromisedSpend(res, done.refusal);
      // An open also says the routing fee the channel starts with.
      else res.json((done.opened.ok ? { ...done.opened, startingFee: routing } : done.opened) satisfies ApiOpenChannelResult);
    }),
  );

  // User settings (currency, …).
  router.get("/settings", (_req, res) => {
    res.json(settings.get());
  });
  router.post("/settings", (req, res) => {
    const { fiatCurrency, lspModeEnabled, lnplusLookups } = bodyOf<SettingsPatch>(req);
    const patch: Parameters<typeof settings.set>[0] = {};
    if (fiatCurrency !== undefined) {
      if (!isOneOf(fiatCurrency, FIAT_CURRENCIES)) {
        res.status(400).json({ error: "bad_request", message: "invalid fiatCurrency" });
        return;
      }
      patch.fiatCurrency = fiatCurrency;
    }
    if (lnplusLookups !== undefined) {
      if (typeof lnplusLookups !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "lnplusLookups must be true or false." });
        return;
      }
      patch.lnplusLookups = lnplusLookups;
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
    const next = settings.set(patch);
    lsps1.applySettings();
    res.json(next);
  });

  // Where LightningMate's own lookups go, and how — the Settings page's
  // privacy card. The node is Tor-only, and so are these lookups: through
  // Umbrel's Tor proxy, every one (http.ts); without a proxy, from this
  // server's internet connection (review a3-channels:lnplus-clearnet-lookups).
  router.get("/privacy", (_req, res) => {
    const s = settings.get();
    const proxy = outboundRouting().proxy;
    res.json({
      torProxy: proxy ? `${proxy.host}:${proxy.port}` : null,
      lnplusLookups: s.lnplusLookups,
      destinations: [
        {
          service: "Amboss public market data (api.amboss.space, magma.amboss.tech)",
          // The public book (eligibility, the Overview's lease benchmark, buy
          // offers) asks for this node's own seller score — by its public
          // key — with or without an Amboss key: a public lookup (review of P4).
          what: "Magma offers, recent sales and the dollar rate — your own node's public seller score included (by its public key), read without your API key",
          active: true,
          viaTor: viaTor(),
        },
        {
          service: "Amboss account (magma.amboss.tech)",
          what: "with your API key: your offers, orders and purchases — tied to your Amboss account",
          active: amboss.hasKey(),
          viaTor: viaTor(),
        },
        {
          service: "lightningnetwork.plus",
          what: "node reputations for peer picking, the Pool and Swaps views — your own node's public key included",
          active: s.lnplusLookups,
          viaTor: viaTor(),
        },
        {
          service: "mempool.space",
          what: "the BTC price, only while a fiat currency is chosen",
          active: s.fiatCurrency !== "off",
          viaTor: viaTor(),
        },
        {
          service: "the service-fee lightning address",
          what: "an invoice for the 1 % fee after a completed sale",
          active: true,
          viaTor: viaTor(),
        },
      ],
    } satisfies PrivacyInfo);
  });

  // LSP mode (LSPS1) — live status + the offer wallets currently see.
  router.get(
    "/lsp/status",
    wrap(async (_req, res) => {
      const [status, info] = await Promise.all([lsps1.status(), getWalletInfo({ lnd })]);
      res.json({ ...status, pubkey: info.public_key, uris: info.uris ?? [] } satisfies LspStatus);
    }),
  );

  // LSPS1 orders for the Market → Orders tab (never exposes invoice secrets).
  router.get("/lsp/orders", (_req, res) => {
    res.json({ orders: lsps1.orderViews() } satisfies LspOrdersResponse);
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
      const days = intIn(queryOf<DaysQuery>(req).days, 1, 30) ?? 7;
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
      } satisfies UnservedDemandReport);
    }),
  );

  // Current BTC price in the chosen fiat currency (null when fiat is off).
  router.get(
    "/price",
    wrap(async (_req, res) => {
      const currency = settings.get().fiatCurrency;
      res.json({ currency, btcPrice: await getBtcPrice(currency) } satisfies PriceInfo);
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
      const { request } = bodyOf<LnDecodeRequest>(req);
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
      const { tokens, description, expirySec } = bodyOf<LnInvoiceRequest>(req);
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
      const { request, maxFeeSats, tokens } = bodyOf<LnPayRequest>(req);
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
        res.json({ ok: false, id: "", tokens: 0, feeSats: 0, secret: "", error: describeError(err) } satisfies ApiPayResult);
      }
    }),
  );

  // ── On-chain wallet ────────────────────────────────────────────────────────

  // Balance + UTXOs + suggested fee rate (read-only), and what the wallet
  // can spare: confirmed coins less the on-chain reserve (D5) and the coins
  // promised to buyers (null when LND can't say).
  router.get(
    "/onchain",
    wrap(async (_req, res) => {
      const [state, budget] = await Promise.all([
        getOnchainState(lnd),
        sendBudget(lnd, autopilot.capital, autopilot.onchainReserveSetting()).catch(() => null),
      ]);
      res.json({ ...state, budget } satisfies ApiOnchainState);
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

  /** An on-chain send as asked, in the parser's own words. Each route fills
   *  it from its own contract type's keys, one by one (the preview's `all` is
   *  the send's `sendAll`; the send has no `max`): neither route's request is
   *  read as the other's (see Fields). */
  type SendAsk = { address: unknown; feeRate: unknown; tokens: unknown; max: unknown; sendAll: unknown };

  /** An on-chain send as asked: an address, a fee rate, and exactly one of an
   *  amount, `max` or a sweep — `modes` names them as the route does, for the
   *  400. Null after a 400 naming what is wrong. */
  const parseSend = (input: SendAsk, modes: string, res: Response): SendRequest | null => {
    const flag = (v: unknown): boolean | null => (v === undefined ? false : v === true || v === "1" || v === "true" ? true : v === false || v === "0" || v === "false" ? false : null);
    const max = flag(input.max);
    const sendAll = flag(input.sendAll);
    const rate = intIn(input.feeRate, 1, MAX_FEE_RATE);
    const amount = input.tokens === undefined || input.tokens === "" ? undefined : intIn(input.tokens, MIN_SEND_SATS, MAX_ONCHAIN_SEND_SATS);
    const given = [amount !== undefined, max === true, sendAll === true].filter(Boolean).length;
    if (!isBtcAddress(input.address) || rate === null || amount === null || max === null || sendAll === null || given !== 1) {
      res.status(400).json({
        error: "bad_request",
        message: `a valid address, feeRate (1–${MAX_FEE_RATE} sat/vB) and one of ${modes} required.`,
      });
      return null;
    }
    return { address: input.address.trim(), feeRate: rate, ...(amount !== undefined ? { tokens: amount } : {}), ...(max ? { max: true } : {}), ...(sendAll ? { sendAll: true } : {}) };
  };

  // What a send would cost and leave, before anything is sent: the fee in
  // sats (LND's own size of the transaction at the chosen rate), LND's
  // next-block rate to compare with, the reserve and the promised coins that
  // stay, and what needs a second yes (review a4-lsp-payments:onchain-send-
  // guardrails). `max`: the most that can go while all of that stays;
  // `all`: every coin (LND keeps its anchor reserve) — each a flag, "true"
  // as the web sends it, or "1" (curl).
  router.get(
    "/onchain/send-preview",
    wrap(async (req, res) => {
      const q = queryOf<SendPreviewQuery>(req);
      const ask = parseSend(
        { address: q.address, feeRate: q.feeRate, tokens: q.tokens, max: q.max, sendAll: q.all },
        `tokens (≥${MIN_SEND_SATS} sat), max or all`,
        res,
      );
      if (!ask) return;
      res.json(await previewSend(lnd, autopilot.capital, autopilot.onchainReserveSetting(), ask));
    }),
  );

  // Send on-chain. Requires write access. The preview is made again here,
  // inside the on-chain mutex: what it asks a second yes for must be in
  // `confirmed` (the codes the operator confirmed), or nothing is sent (409
  // confirm_send, with the checks) — a page that skipped the question can't
  // skip the check.
  router.post(
    "/onchain/send",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      // The send's own body. `max` and `all` are the preview's words, which
      // the contract declares never sent here: the preview's max goes as its
      // amount, a sweep is `sendAll`. Refused rather than ignored — an `all`
      // next to an amount would otherwise send the amount without a word.
      const body = bodyOf<OnchainSendRequest>(req);
      const { spendPromised, confirmed } = body;
      const codes: unknown[] | null = Array.isArray(confirmed) ? confirmed : confirmed === undefined ? [] : null;
      if ((spendPromised !== undefined && typeof spendPromised !== "boolean") || codes === null || !codes.every((c) => typeof c === "string")) {
        res.status(400).json({ error: "bad_request", message: "spendPromised must be true/false and confirmed a list of check codes." });
        return;
      }
      if (body.max !== undefined || body.all !== undefined) {
        res.status(400).json({ error: "bad_request", message: "send an amount (the preview's max) or sendAll — not the preview's max or all." });
        return;
      }
      const ask = parseSend(
        { address: body.address, feeRate: body.feeRate, tokens: body.tokens, max: undefined, sendAll: body.sendAll },
        `tokens (≥${MIN_SEND_SATS} sat) or sendAll`,
        res,
      );
      if (!ask) return;
      // Taken in turn with every channel open (Magma, LSPS1, the autopilot,
      // manual): a send in the middle of an open's check would spend what
      // that check counted on. Coins promised to buyers are refused unless
      // the operator confirmed spending them — judged by the plan itself,
      // with the send's own fee, exactly as its preview's touchesPromised.
      let done:
        | { refusal: PromisedSpendRefusal }
        | { invalid: string }
        | { confirm: { checks: SendPreview["checks"]; preview: SendPreview } }
        | { sent: SendResult };
      try {
        done = await autopilot.capital.mutex.run("on-chain send", async () => {
          const { preview, promised } = await planSend(lnd, autopilot.capital, autopilot.onchainReserveSetting(), ask);
          if (preview.error) return { invalid: preview.error };
          const unconfirmed = preview.checks.filter((c) => !(codes as SendCheckCode[]).includes(c.code));
          if (unconfirmed.length) return { confirm: { checks: unconfirmed, preview } };
          if (promised && !spendPromised) return { refusal: promised };
          return { sent: await sendOnchain(writeLnd, { address: ask.address, feeRate: ask.feeRate, ...(ask.sendAll ? { sendAll: true } : { tokens: ask.tokens }) }) };
        });
      } catch (err) {
        res.json({ ok: false, transactionId: "", error: describeError(err) } satisfies OnchainSendResult);
        return;
      }
      if ("refusal" in done) refusePromisedSpend(res, done.refusal);
      else if ("invalid" in done) res.status(400).json({ error: "bad_send", message: done.invalid });
      else if ("confirm" in done) {
        res.status(409).json({
          error: "confirm_send",
          message: done.confirm.checks.map((c) => c.message).join(" "),
          checks: done.confirm.checks,
          preview: done.confirm.preview,
        });
      } else res.json(done.sent satisfies OnchainSendResult);
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
      const { message: given } = bodyOf<SignRequest>(req);
      const message = typeof given === "string" ? given : "";
      if (!message.trim()) {
        res.status(400).json({ error: "bad_request", message: "Enter a message to sign." });
        return;
      }
      const { signature } = await signMessage({ lnd: writeLnd, message });
      res.json({ signature } satisfies SignResult);
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
  const keyStatus = (): AmbossStatus => ({
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
    const { apiKey: given } = bodyOf<AmbossKeyRequest>(req);
    const apiKey = typeof given === "string" ? given.trim() : "";
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
    res.json({ ok: true, connected: true } satisfies AmbossKeyResult);
  });

  router.delete("/amboss/key", (_req, res) => {
    amboss.clear();
    res.json({ ok: true, connected: false } satisfies AmbossKeyResult);
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
      const sizeSats = intIn(queryOf<SizeQuery>(req).size, MIN_CHANNEL_SATS, MAX_CHANNEL_SATS) ?? 2_000_000;
      const own = await getOwnPubkey(lnd);
      const [market, me, book] = await Promise.all([getMarket(), buyerFacts(), publicBook(own).catch(() => null)]);
      const tiers = book ? feeTiers(book.offers) : [];
      res.json({
        sizeSats,
        offers: rankBuyOffers(market.offers.filter((o) => o.sellerPubkey !== own), tiers, me, sizeSats),
        ambossFeeTiers: tiers.map((t) => ({ ambossFeePpm: t.ambossFee, upToSats: t.upTo })),
        inboundSatsPerUsd: market.inboundSatsPerUsd,
        satsPerUsd: market.satsPerUsd,
      } satisfies BuyOffersResponse);
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
      const asked = bodyOf<BuyQuoteRequest>(req);
      const usdCents = Math.floor(Number(asked.usdCents));
      const wantsOffer = typeof asked.offerId === "string" && asked.offerId.trim().length > 0;
      if (!wantsOffer && (!Number.isFinite(usdCents) || usdCents < 500)) {
        res.status(400).json({ error: "bad_amount", message: "Minimum is $5 (500 cents)." });
        return;
      }
      const isPrivate = asked.private === true;
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
      const offerId = typeof asked.offerId === "string" ? asked.offerId.trim() : "";
      const sizeSats = Math.floor(Number(asked.sizeSats));
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
        } satisfies BuyQuoteResponse);
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
      } satisfies BuyQuoteResponse);
    }),
  );

  // The buyer declined the quote: cancel the order on Amboss, so it doesn't
  // stay live (before, declining just closed the dialog).
  router.post(
    "/amboss/buy/cancel",
    wrap(async (req, res) => {
      if (!needKey(res)) return;
      const { orderId: given } = bodyOf<BuyCancelRequest>(req);
      const orderId = typeof given === "string" ? given : "";
      if (!autopilot.purchases.get(orderId)) {
        res.status(404).json({ error: "not_found", message: "No quote on record for this order." });
        return;
      }
      // A failure only the pay call reported (a dropped stream, a restart)
      // may still be in flight: LND is asked first. Cancelling an order whose
      // payment then lands would record "declined" for inbound that was paid
      // for (review of P1b).
      const p = (await autopilot.checkPurchasePayment(orderId)) ?? autopilot.purchases.get(orderId)!;
      if (p.state === "pay_failed" && !p.failureConfirmed) {
        res.status(409).json({
          error: "payment_unclear",
          message: "LND hasn't confirmed that the payment failed — it may still be in flight. The order is followed automatically; cancel it once the payment has ended.",
        });
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
      } satisfies BuyCancelResult);
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
      const pay = bodyOf<BuyPayRequest>(req);
      const orderId = typeof pay.orderId === "string" ? pay.orderId : "";
      const maxSats = Math.floor(Number(pay.maxSats));
      if (!orderId || !Number.isFinite(maxSats) || maxSats <= 0) {
        res.status(400).json({ error: "bad_request", message: "Missing order or confirmed amount." });
        return;
      }
      if (!autopilot.purchases.get(orderId)) {
        res.status(404).json({ error: "not_found", message: "No quote on record for this order — get a new quote." });
        return;
      }
      // A failure only the pay call reported: LND says first whether the
      // payment is still in flight (then this is "paying" — not paid again).
      const p = (await autopilot.checkPurchasePayment(orderId)) ?? autopilot.purchases.get(orderId)!;
      if (p.state !== "quoted" && p.state !== "pay_failed") {
        res.status(409).json({ error: "bad_state", message: `This order is ${p.state} — not paying it again.` });
        return;
      }
      const sent = typeof pay.paymentRequest === "string" ? pay.paymentRequest.trim() : "";
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
      res.json({ ok: true, sats: decoded.tokens } satisfies BuyPayResult);
    }),
  );

  /** The payment hint for an order, from the purchase ledger. */
  const paymentHint = (orderId: string): PurchasePaymentHint | null => {
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
      const { id: asked } = queryOf<OrderQuery>(req);
      const id = typeof asked === "string" ? asked : "";
      if (!id) {
        res.status(400).json({ error: "bad_request", message: "Missing order id." });
        return;
      }
      const order = await withAmboss(() => getOrder(amboss.getKey(), id));
      autopilot.purchases.fromOrder(id, order);
      res.json({ ...order, payment: paymentHint(id) } satisfies ApiOrderState);
    }),
  );

  // Inbound bought here (newest first): quotes, cancels, payments, channels.
  router.get("/amboss/purchases", (_req, res) => {
    res.json({ purchases: autopilot.purchases.list() } satisfies PurchasesResponse);
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
      // Shared with the other pages for a minute (magmaReportShared).
      res.json(await autopilot.magmaReportShared(amboss.getKey()));
    }),
  );

  // Can this node realistically SELL on Magma (D8)? Comparable live offers,
  // how many ever sold, the fills per offer-month — from Amboss's public book
  // (cached a day; ?refresh=1 asks again) and the capital listable now.
  // Needs no key: the user deciding whether to sell at all is who needs it.
  router.get(
    "/amboss/eligibility",
    wrap(async (req, res) => {
      // A flag the web sends as "true" (curl's "1" is taken too).
      const { refresh } = queryOf<EligibilityQuery>(req);
      res.json(await autopilot.magmaEligibility(refresh === "true" || refresh === "1"));
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
      res.json({ offers, sync: autopilot.offerSyncStatus(), controls: autopilot.offerControls(), feeCaps: autopilot.offerFeeCaps() } satisfies MyOffersResponse);
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
        settle(autopilot.magmaReportShared(amboss.getKey())),
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
        orders: view.orders.map((o): ApiMyOrder => {
          const local = autopilot.magma.localView(o.id);
          return {
            ...o,
            transactionId: local?.fundingOutpoint?.split(":")[0] ?? o.transactionId,
            local,
            // Who opens the sale's channel once it is paid: the lane, or you.
            opensItself: autopilot.magma.opensItself(o.id),
          };
        }),
      } satisfies MyOrdersView);
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
  // The operator's terms; the routing-fee promise is added by the route (D7).
  const parseOfferTerms = (
    b: Fields<OfferTermsRequest>,
    res: Response,
  ): Omit<OfferTerms, "feeRateCapPpm" | "baseFeeCapSats" | "conditions" | "onchainPriority" | "onchainMultiplier"> | null => {
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
    // A base fee of 0 is a price (the fee rate carries it; comparable offers
    // may charge none) — 0 ppm + 0 sat is not: buyers would get a channel for
    // free. (A base above 0 used to be required: the engine's price buttons
    // carry the market's base, and where that is 0 the form refused them.)
    if (terms.feeRatePpm <= 0 && terms.baseFeeSats <= 0) {
      res.status(400).json({
        error: "bad_fee",
        message: "Set a price: a fee rate, a base fee or both — at 0 ppm + 0 sat buyers would get a channel for free.",
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
      const parsed = parseOfferTerms(bodyOf<OfferTermsRequest>(req), res);
      if (!parsed) return;
      // Every offer carries the routing-fee promise (D7) — kept by the fee
      // autopilot for each channel sold.
      const terms: OfferTerms = { ...parsed, ...autopilot.offerFeeCaps(), ...NO_EXTRA_TERMS };
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
      res.json({ ok: true, offerId } satisfies OfferCreateResult);
    }),
  );

  router.post(
    "/amboss/offer/update",
    wrap(async (req, res) => {
      if (!needKey(res)) return;
      const b = bodyOf<OfferUpdateRequest>(req);
      const id = typeof b.id === "string" ? b.id : "";
      if (!id) {
        res.status(400).json({ error: "bad_request", message: "Missing offer id." });
        return;
      }
      const parsed = parseOfferTerms(b, res);
      if (!parsed) return;
      const current = await ownOffer(id, res);
      if (!current) return;
      // Every term goes out (updateOffer): the buyer conditions and on-chain
      // settings the form doesn't show, as the offer has them.
      const terms: OfferTerms = {
        ...parsed,
        ...autopilot.offerFeeCaps(),
        conditions: current.conditions,
        onchainPriority: current.onchainPriority,
        onchainMultiplier: current.onchainMultiplier,
      };
      const write: OfferWrite = { at: new Date().toISOString(), by: "manual", action: "update", fields: ambossFields(terms), ok: false };
      // One write per offer at a time (withOffer), as the autopilot's own
      // terms writes and status flips: this edit and its read-back never
      // cross one of them. Before (review of P1b), an autopilot write could
      // land between this one and its read-back — the edit reported "not
      // stored" — or after it, undoing it.
      const read = await autopilot.withOffer(id, async (): Promise<MyOffer | null | undefined> => {
        // What the form doesn't set, as Amboss has it now (inside the lock:
        // an edit on amboss.tech since `current` was read stands).
        const now = await getMyOffer(amboss.getKey(), id).catch(() => null);
        if (now) {
          terms.conditions = now.conditions;
          terms.onchainPriority = now.onchainPriority;
          terms.onchainMultiplier = now.onchainMultiplier;
          write.fields = ambossFields(terms);
        }
        try {
          write.ok = await withAmboss(() => updateOffer(amboss.getKey(), id, terms));
          if (!write.ok) write.error = "Amboss did not apply the update (success: false)";
        } catch (err) {
          write.error = describeError(err);
        }
        if (!write.ok) {
          autopilot.recordOfferWrite(null, id, write);
          return undefined;
        }
        // Edited by hand: the operator's terms now — the autopilot leaves
        // them alone until handed back (it used to overwrite them at its next
        // run). Set before the lock is released: an autopilot write planned
        // on the old terms, waiting for this lock, then sends nothing.
        autopilot.pauseOfferAutomation(id, "you edited this offer");
        // "success" is Amboss's word; reading the offer back is the proof.
        const back = await getMyOffer(amboss.getKey(), id).catch(() => null);
        write.verified = back ? termsMatch(back, terms) : undefined;
        autopilot.recordOfferWrite(back, id, write);
        return back;
      });
      if (read === undefined) {
        res.status(502).json({ error: "amboss_refused", message: `Offer not updated: ${write.error}` });
        return;
      }
      res.json({ ok: true, verified: write.verified ?? null, offer: read } satisfies OfferUpdateResult);
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
      const { id: given, want: wantRaw } = bodyOf<OfferToggleRequest>(req);
      const id = typeof given === "string" ? given : "";
      if (!id) {
        res.status(400).json({ error: "bad_request", message: "Missing offer id." });
        return;
      }
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
        // Never listed without a price: Amboss matches orders to an offer at
        // 0 ppm + 0 sat at 0 sats for the seller (2026-10-23).
        const listing = want === "ENABLED" || (!want && offer.status === "DISABLED");
        if (listing && offer.status !== "ENABLED" && offer.feeRatePpm <= 0 && offer.baseFeeSats <= 0) {
          res.status(409).json({
            error: "no_price",
            message: "This offer has no price (0 ppm + 0 sat): set its price before you list it — buyers would get a channel for free.",
          });
          return;
        }
        if (want && offer.status !== (want === "ENABLED" ? "DISABLED" : "ENABLED")) {
          // ("keep disabled" on Market → Sell: an offer a switch-on would list
          // stays off — offerStatusSetByHand ends what it had still to list.)
          if (offer.status === want) autopilot.offerStatusSetByHand(id, want, offer);
          res.json({ status: offer.status, changed: false } satisfies OfferToggleResult);
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
        res.json({ status, changed: true } satisfies OfferToggleResult);
      });
    }),
  );

  // Hand an offer back to the autopilot ("Let the autopilot manage it"), or
  // take it over without changing it. Only this node's offers.
  router.post(
    "/amboss/offer/automation",
    wrap(async (req, res) => {
      if (!needKey(res)) return;
      const { id: given, managed } = bodyOf<OfferAutomationRequest>(req);
      const id = typeof given === "string" ? given : "";
      if (!id || typeof managed !== "boolean") {
        res.status(400).json({ error: "bad_request", message: "Offer id and managed (true/false) required." });
        return;
      }
      if (!(await ownOffer(id, res))) return;
      if (managed) autopilot.resumeOfferAutomation(id);
      else autopilot.pauseOfferAutomation(id, "you took it over");
      res.json({ ok: true, sync: autopilot.offerSyncStatus(), controls: autopilot.offerControls() } satisfies OfferAutomationResult);
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
      r.code === "read_only" || r.code === "permission" ? 403
      : r.code === "no_key" ? 400
      : r.code === "shutting_down" || r.code === "journal" ? 503
      : r.code === "bad_status" || r.code === "capital" || r.code === "unreachable" || r.code === "not_held" ? 409
      : 502;
    res.status(status).json({ ...r, error: r.code ?? "failed" });
  };

  /** The order a click acts on (its body's `id`). Null after a 400. */
  const orderId = (body: Fields<OrderActionRequest>, res: Response): string | null => {
    const id = typeof body.id === "string" ? body.id.trim() : "";
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
      const id = orderId(bodyOf<OrderActionRequest>(req), res);
      if (!id) return;
      const result = await autopilot.magma.accept(id);
      // What happens once the buyer pays: the lane opens it, or you do.
      sendDesk(res, result.ok ? { ...result, opensItself: autopilot.magma.opensItself(id) } : result);
    }),
  );

  // Open the channel to the buyer and report it (idempotent per order).
  router.post(
    "/amboss/order/open",
    wrap(async (req, res) => {
      const id = orderId(bodyOf<OrderActionRequest>(req), res);
      if (id) sendDesk(res, await autopilot.magma.open(id));
    }),
  );

  // Reject an order that can't be served (only while it awaits approval).
  router.post(
    "/amboss/order/reject",
    wrap(async (req, res) => {
      const id = orderId(bodyOf<OrderActionRequest>(req), res);
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
