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
import { getChannelSuggestions, type SuggestionPolicy } from "../services/suggestions.js";
import { getPnl } from "../services/pnl.js";
import { closeChannelByOutpoint, openChannelTo } from "../services/channelOps.js";
import { getBtcPrice } from "../services/price.js";
import type { SettingsStore } from "../services/settings.js";
import type { ChannelOverride, OverridesStore } from "../services/overrides.js";
import { getAlerts } from "../services/alerts.js";
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
      const { targetId, sourceId, amountSats, econRatio } = req.body ?? {};
      const amount = intIn(amountSats, 1000, MAX_REBALANCE_SATS);
      const ratio = econRatio === undefined ? 0.8 : numIn(econRatio, 0.05, 1);
      if (!isChannelId(targetId) || !isChannelId(sourceId) || amount === null || ratio === null) {
        res.status(400).json({
          error: "bad_request",
          message: "valid targetId/sourceId, amountSats (1k–1 BTC) and econRatio (0.05–1) required.",
        });
        return;
      }
      const result = await executeRebalance(lnd, writeLnd, {
        targetId,
        sourceId,
        amountSats: amount,
        econRatio: ratio,
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

  // Error middleware — surface LND/connection failures as JSON, not a crash.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = describeError(err);
    console.error("[api error]", message);
    res.status(502).json({ error: "node_request_failed", message });
  });

  return router;
}
