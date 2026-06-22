import { Router, type Request, type Response, type NextFunction } from "express";
import type { AuthenticatedLnd } from "lightning";
import type { Config } from "../config.js";
import { getNodeSummary } from "../services/node.js";
import { getChannelsView } from "../services/channels.js";
import { getFlowSummary } from "../services/forwards.js";

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

export function createApiRouter(lnd: AuthenticatedLnd, config: Config): Router {
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

  // Error middleware — surface LND/connection failures as JSON, not a crash.
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = describeError(err);
    console.error("[api error]", message);
    res.status(502).json({ error: "node_request_failed", message });
  });

  return router;
}
