import { useEffect, useState } from "react";
import { api } from "../api";
import type { AutopilotConfig, MagmaV2Report } from "../types";
import { sats, satsCompact } from "../format";
import { MarketBuy } from "./MarketBuy";
import { MarketSell } from "./MarketSell";
import { MarketOrders } from "./MarketOrders";
import { LnPlusPanel } from "./LnPlusPanel";

type Sub = "buy" | "sell" | "orders" | "lnplus";

/** One seller-score coach line: what typically drives the Amboss seller score,
 *  checked against what we can actually see locally. */
function CoachItem({ ok, info, text }: { ok?: boolean; info?: boolean; text: string }) {
  return (
    <div className={`coach-item ${info ? "info" : ok ? "ok" : "todo"}`}>
      <span className="coach-mark">{info ? "ℹ" : ok ? "✓" : "→"}</span>
      <span>{text}</span>
    </div>
  );
}

export function MarketPanel() {
  const [sub, setSub] = useState<Sub>("buy");
  const [rec, setRec] = useState<MagmaV2Report | null>(null);
  const [cfg, setCfg] = useState<AutopilotConfig | null>(null);

  useEffect(() => {
    // Needs the Amboss key; quietly hidden when not connected.
    api.magmaRecommendations().then(setRec).catch(() => setRec(null));
    api.autopilotGet().then((s) => setCfg(s.config)).catch(() => {});
  }, []);

  const a = rec?.analytics;
  const pulse = rec?.sell.marketPulse ?? null;
  const offerState = rec?.sell.recommendations.find((r) => r.offerId)?.state;

  return (
    <div>
      <div className="subnav">
        <button className={`subtab ${sub === "buy" ? "active" : ""}`} onClick={() => setSub("buy")}>
          Buy
        </button>
        <button className={`subtab ${sub === "sell" ? "active" : ""}`} onClick={() => setSub("sell")}>
          Sell
        </button>
        <button className={`subtab ${sub === "orders" ? "active" : ""}`} onClick={() => setSub("orders")}>
          Orders
        </button>
        <button className={`subtab ${sub === "lnplus" ? "active" : ""}`} onClick={() => setSub("lnplus")}>
          LN+
        </button>
      </div>

      {a && sub !== "lnplus" ? (
        <div className="market-score">
          <span className="market-score-main">
            Seller score <b>{a.mySellerScore != null ? a.mySellerScore.toFixed(1) : "—"}</b>
          </span>
          <span className="muted">
            {a.filledOrdersAllTime} sold · {sats(a.netProfitSat)} sat net
          </span>
          {pulse ? (
            <span
              className="market-pulse"
              title="From local order-book telemetry: real sales observed across the market — listings are asks, this is what actually SOLD"
            >
              {pulse.confirmed > 0 && pulse.medianFilledPpm != null
                ? `market pulse: ${pulse.confirmed} sale${pulse.confirmed > 1 ? "s" : ""}/${pulse.trackedDays}d · fills ~${pulse.medianFilledPpm} ppm · ${satsCompact(pulse.soldSats)} sat sold`
                : `market pulse: watching the order book (${pulse.trackedDays}d) — no sales observed yet`}
            </span>
          ) : null}
        </div>
      ) : null}

      {a && rec && sub !== "lnplus" ? (
        <details className="score-coach">
          <summary>Improve your seller score</summary>
          <div className="coach-list">
            <CoachItem
              ok={!!cfg?.sellEnabled}
              text={
                cfg?.sellEnabled
                  ? "Fast fulfilment: the autopilot accepts + opens orders within minutes (fast lane) — response speed feeds the score"
                  : "Enable Liquidity provision (Autopilot → Magma) so orders are fulfilled in minutes — slow responses hurt the score"
              }
            />
            <CoachItem
              ok={a.offersActive > 0 && a.offersExhausted === 0}
              text={
                a.offersActive === 0
                  ? "No active offer — a continuously listed, funded offer builds score history"
                  : a.offersExhausted > 0
                    ? "Offer depleted — top it back up (or enable auto-relist) so it keeps taking orders"
                    : "Active, funded offer listed — continuity builds trust"
              }
            />
            <CoachItem
              ok={(rec.sell.pendingSellerOrders ?? 0) === 0}
              text={
                (rec.sell.pendingSellerOrders ?? 0) > 0
                  ? `${rec.sell.pendingSellerOrders} order(s) waiting for your action — respond quickly, waiting buyers rate you down`
                  : "No orders waiting on you"
              }
            />
            <CoachItem
              ok={offerState === "well_priced" || (!!cfg?.sellAutoReprice && !!cfg?.sellEnabled)}
              text={
                offerState === "underpriced" || offerState === "overpriced" || offerState === "below_profit_floor"
                  ? "Offer is mispriced vs the market — reprice (or enable auto-reprice) so it fills instead of sitting"
                  : "Offer tracks the market price — priced offers fill, and fills build score"
              }
            />
            <CoachItem info text="24/7 uptime matters — the score tracks your node's availability; an always-on Umbrel does this for you" />
          </div>
        </details>
      ) : null}

      {sub === "buy" ? (
        <MarketBuy />
      ) : sub === "sell" ? (
        <MarketSell />
      ) : sub === "orders" ? (
        <MarketOrders />
      ) : (
        <LnPlusPanel />
      )}
    </div>
  );
}
