import { Router, type Request, type Response, type NextFunction } from "express";
import { subscribeToForwards, type AuthenticatedLnd } from "lightning";
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
import { openChannelTo } from "../services/channelOps.js";
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
    if (!channelId || !["auto", "fixed", "exclude"].includes(mode)) {
      res.status(400).json({ error: "bad_request", message: "channelId and a valid mode are required." });
      return;
    }
    const override: ChannelOverride = { mode };
    if (mode === "fixed" && Number.isFinite(Number(fixedPpm))) override.fixedPpm = Number(fixedPpm);
    res.json(overrides.set(String(channelId), override));
  });

  // Derived alerts (offline channels, low balances, …).
  router.get(
    "/alerts",
    wrap(async (_req, res) => {
      res.json(await getAlerts(lnd));
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
      const items = Array.isArray(req.body?.items) ? (req.body.items as FeeApplyItem[]) : [];
      if (!items.length) {
        res.status(400).json({ error: "no_items", message: "No fee changes provided." });
        return;
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
      if (!targetId || !sourceId || !Number.isFinite(Number(amountSats))) {
        res.status(400).json({ error: "bad_request", message: "targetId, sourceId and amountSats are required." });
        return;
      }
      const result = await executeRebalance(lnd, writeLnd, {
        targetId: String(targetId),
        sourceId: String(sourceId),
        amountSats: Number(amountSats),
        econRatio: Number.isFinite(Number(econRatio)) ? Number(econRatio) : 0.8,
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

  // Live forwarding events via Server-Sent Events.
  router.get(
    "/stream/forwards",
    wrap(async (req, res) => {
      const channels = await getChannelsView(lnd);
      const aliasById = new Map(channels.map((c) => [c.id, c.peerAlias]));
      const name = (id?: string) => (id ? aliasById.get(id) ?? `${id.slice(0, 10)}…` : "?");

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      res.write("retry: 5000\n\n");

      const sub = subscribeToForwards({ lnd });
      const onForward = (e: {
        at: string;
        is_confirmed: boolean;
        is_receive: boolean;
        is_send: boolean;
        tokens?: number;
        fee?: number;
        in_channel?: string;
        out_channel?: string;
      }) => {
        // Only settled routing forwards (not our own sends/receives).
        if (!e.is_confirmed || e.is_receive || e.is_send || !e.tokens) return;
        const payload = JSON.stringify({
          at: e.at,
          tokens: e.tokens,
          fee: e.fee ?? 0,
          incoming: name(e.in_channel),
          outgoing: name(e.out_channel),
        });
        res.write(`data: ${payload}\n\n`);
      };
      sub.on("forward", onForward);
      sub.on("error", () => {});

      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        sub.removeAllListeners();
        res.end();
      });
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
      if (!pubkey || !Number.isFinite(Number(localTokens))) {
        res.status(400).json({ error: "bad_request", message: "pubkey and localTokens are required." });
        return;
      }
      res.json(
        await openChannelTo(writeLnd, {
          pubkey: String(pubkey),
          socket: socket ? String(socket) : undefined,
          localTokens: Number(localTokens),
          feeRate: Number.isFinite(Number(feeRate)) ? Number(feeRate) : undefined,
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
    res.json(settings.set(req.body ?? {}));
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
