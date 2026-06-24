import { Router, type Request, type Response, type NextFunction } from "express";
import type { AuthenticatedLnd } from "lightning";
import { getNodeScore } from "../services/score.js";
import type { Config } from "../config.js";
import { getNodeSummary } from "../services/node.js";
import { getChannelsView } from "../services/channels.js";
import { getFlowSummary, getForwardsReport } from "../services/forwards.js";
import { applyFees, getFeePreview, type FeeApplyItem, type FeePolicy } from "../services/fees.js";
import {
  executeRebalance,
  getRebalanceCandidates,
  type RebalancePolicy,
} from "../services/rebalance.js";
import { getChannelSuggestions, getCloseCandidates, type SuggestionPolicy } from "../services/suggestions.js";
import { getPnl } from "../services/pnl.js";
import { buildDashboard } from "../services/dashboard.js";
import {
  createInvoice,
  decodeRequest,
  getLnActivity,
  payRequest,
} from "../services/payments.js";
import {
  getOnchainState,
  getOnchainTxs,
  newAddress,
  sendOnchain,
} from "../services/onchain.js";
import { closeChannelByOutpoint, openChannelTo } from "../services/channelOps.js";
import { getBtcPrice } from "../services/price.js";
import type { SettingsStore } from "../services/settings.js";
import type { ChannelOverride, OverridesStore } from "../services/overrides.js";
import { getAlerts } from "../services/alerts.js";
import { authRequired, bearer, issueToken, verifyPassword, verifyToken } from "../services/auth.js";
import type { Autopilot } from "../services/autopilot.js";
import type { RebalanceLog } from "../services/rebalanceLog.js";

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
): Router {
  const router = Router();

  // Simple global rate limit on state-changing requests — blocks runaway loops
  // or a compromised client spamming fund-moving actions. Generous for a human.
  const writeHits: number[] = [];
  router.use((req, res, next) => {
    if (req.method === "GET") return next();
    const now = Date.now();
    while (writeHits.length && now - writeHits[0] > 60_000) writeHits.shift();
    if (writeHits.length >= 60) {
      res.status(429).json({ error: "rate_limited", message: "Too many write requests; slow down." });
      return;
    }
    writeHits.push(now);
    next();
  });

  // ── Auth gate ───────────────────────────────────────────────────────────────
  // The whole API requires a session token (proves the per-install app password
  // Umbrel shows the user) — EXCEPT the auth + health endpoints. Other app
  // containers share the Docker network, so without this they could read node
  // data or move funds directly. No-op when auth isn't required (standalone on
  // 127.0.0.1, where there is no cross-container threat).
  const OPEN_PATHS = new Set(["/auth/status", "/auth/unlock", "/health"]);
  router.use((req, res, next) => {
    if (OPEN_PATHS.has(req.path)) return next();
    if (verifyToken(bearer(req))) return next();
    res.status(401).json({ error: "unauthorized", message: "Sign in to continue." });
  });

  // Whether a login is required, and whether this request is already signed in.
  router.get("/auth/status", (req, res) => {
    res.json({ authRequired: authRequired(), unlocked: verifyToken(bearer(req)) });
  });

  // Exchange the app password for a session token. Brute-force guarded.
  const unlockHits: number[] = [];
  router.post("/auth/unlock", (req, res) => {
    const now = Date.now();
    while (unlockHits.length && now - unlockHits[0] > 60_000) unlockHits.shift();
    if (unlockHits.length >= 8) {
      res.status(429).json({ error: "rate_limited", message: "Too many attempts; wait a minute." });
      return;
    }
    unlockHits.push(now);
    if (!verifyPassword(req.body?.password)) {
      res.status(401).json({ error: "bad_password", message: "Wrong password." });
      return;
    }
    res.json({ token: issueToken() });
  });

  router.get("/health", (_req, res) => {
    res.json({ ok: true, service: "lightningmate", version: "0.1.0" });
  });

  router.get(
    "/node",
    wrap(async (_req, res) => {
      res.json(await getNodeSummary(lnd));
    }),
  );

  router.get(
    "/channels",
    wrap(async (_req, res) => {
      res.json(await getChannelsView(lnd));
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

  // Derived alerts (offline channels, low balances, …).
  router.get(
    "/alerts",
    wrap(async (_req, res) => {
      res.json(await getAlerts(lnd));
    }),
  );

  // Close a channel by funding outpoint — real on-chain action, write only.
  router.post(
    "/channels/close",
    wrap(async (req, res) => {
      if (!writeLnd) {
        res.status(403).json({ error: "write_disabled", message: WRITE_DISABLED_MSG });
        return;
      }
      const { transactionId, transactionVout, isForce } = req.body ?? {};
      const vout = intIn(transactionVout, 0, 1_000_000);
      if (!isTxid(transactionId) || vout === null) {
        res.status(400).json({ error: "bad_request", message: "valid transactionId (64 hex) and transactionVout required." });
        return;
      }
      res.json(await closeChannelByOutpoint(writeLnd, transactionId, vout, Boolean(isForce)));
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
      res.json({ results: await applyFees(lnd, writeLnd, items) });
    }),
  );

  // Autopilot status/config.
  router.get("/autopilot", (_req, res) => {
    res.json(autopilot.getState());
  });

  // Update autopilot config (enable/disable, interval, cooldown, policy).
  router.post("/autopilot", (req, res) => {
    autopilot.setConfig(req.body ?? {});
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

  // Profit-aware rebalance candidates — read-only analysis, probes route costs
  // without paying. Each candidate is gated on cost ppm ≤ profit budget.
  router.get(
    "/rebalance/candidates",
    wrap(async (req, res) => {
      const overrides = numericOverrides<RebalancePolicy>(req.query, [
        "econRatio",
        "maxLocalRatioTarget",
        "minLocalRatioSource",
        "amountSats",
        "minDemandSats",
        "flowWindowDays",
        "maxCandidates",
      ]);
      res.json(await getRebalanceCandidates(lnd, overrides));
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
      const { targetId, sourceId, amountSats, econRatio, maxFeePpm } = req.body ?? {};
      const amount = intIn(amountSats, 1000, MAX_REBALANCE_SATS);
      const ratio = econRatio === undefined ? 0.8 : numIn(econRatio, 0.05, 1);
      const maxFee = maxFeePpm === undefined ? undefined : intIn(maxFeePpm, 1, MAX_FEE_PPM);
      if (
        !isChannelId(targetId) ||
        !isChannelId(sourceId) ||
        amount === null ||
        ratio === null ||
        (maxFeePpm !== undefined && maxFee === null)
      ) {
        res.status(400).json({
          error: "bad_request",
          message: "valid targetId/sourceId, amountSats (1k–1 BTC), econRatio (0.05–1) and optional maxFeePpm required.",
        });
        return;
      }
      const result = await executeRebalance(lnd, writeLnd, {
        targetId,
        sourceId,
        amountSats: amount,
        econRatio: ratio,
        ...(maxFee !== null && maxFee !== undefined ? { maxFeePpm: maxFee } : {}),
      });
      rebalanceLog.append({
        at: new Date().toISOString(),
        via: "manual",
        targetId: result.targetId,
        targetAlias: result.targetAlias,
        sourceId: result.sourceId,
        sourceAlias: result.sourceAlias,
        amountSats: result.amountSats,
        budgetPpm: result.budgetPpm,
        feeSats: result.feeSats,
        costPpm: result.costPpm,
        ok: result.ok,
        error: result.error,
      });
      res.json(result);
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
      res.json(await getPnl(lnd, rebalanceLog, windowDays));
    }),
  );

  // Overview dashboard — KPI totals + sparklines, recent activity feed and an
  // autopilot summary, assembled from a single forwards pull.
  router.get(
    "/dashboard",
    wrap(async (_req, res) => {
      const [report, ln, onchain] = await Promise.all([
        getForwardsReport(lnd, 30),
        getLnActivity(lnd, 10),
        getOnchainTxs(lnd, 10),
      ]);
      res.json(buildDashboard(report, ln, onchain, rebalanceLog.summary(), autopilot.getState()));
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
      res.json(await getChannelSuggestions(lnd, overrides));
    }),
  );

  // Channels worth closing (offline / never routed / idle in the window).
  router.get(
    "/suggestions/close",
    wrap(async (req, res) => {
      const days = Number(req.query.days ?? 90);
      const windowDays = Math.min(365, Math.max(7, Number.isFinite(days) ? days : 90));
      res.json(await getCloseCandidates(lnd, windowDays));
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
      res.json(
        await openChannelTo(writeLnd, {
          pubkey,
          socket: socket ? String(socket) : undefined,
          localTokens: amount,
          feeRate: fee ?? undefined,
          isPrivate: Boolean(isPrivate),
        }),
      );
    }),
  );

  // User settings (currency, …).
  router.get("/settings", (_req, res) => {
    res.json(settings.get());
  });
  router.post("/settings", (req, res) => {
    const fiatCurrency = req.body?.fiatCurrency;
    if (!["off", "USD", "EUR", "GBP", "CHF"].includes(fiatCurrency)) {
      res.status(400).json({ error: "bad_request", message: "invalid fiatCurrency" });
      return;
    }
    res.json(settings.set({ fiatCurrency }));
  });

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
      const { address, tokens, feeRate } = req.body ?? {};
      const amount = intIn(tokens, 546, MAX_ONCHAIN_SEND_SATS); // ≥ dust
      const rate = intIn(feeRate, 1, MAX_FEE_RATE);
      if (!isBtcAddress(address) || amount === null || rate === null) {
        res.status(400).json({
          error: "bad_request",
          message: "valid address, tokens (≥546 sat) and feeRate (1–2000 sat/vB) required.",
        });
        return;
      }
      try {
        res.json(await sendOnchain(writeLnd, { address: address.trim(), tokens: amount, feeRate: rate }));
      } catch (err) {
        res.json({ ok: false, transactionId: "", error: describeError(err) });
      }
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
