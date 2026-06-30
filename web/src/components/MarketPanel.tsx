import { useEffect, useState } from "react";
import { api } from "../api";
import type { MagmaV2Report } from "../types";
import { sats } from "../format";
import { MarketBuy } from "./MarketBuy";
import { MarketSell } from "./MarketSell";
import { MarketOrders } from "./MarketOrders";

type Sub = "buy" | "sell" | "orders";

export function MarketPanel() {
  const [sub, setSub] = useState<Sub>("buy");
  const [rec, setRec] = useState<MagmaV2Report | null>(null);

  useEffect(() => {
    // Needs the Amboss key; quietly hidden when not connected.
    api.magmaRecommendations().then(setRec).catch(() => setRec(null));
  }, []);

  const a = rec?.analytics;

  return (
    <div>
      {a ? (
        <div className="market-score">
          <span className="market-score-main">
            Seller score <b>{a.mySellerScore != null ? a.mySellerScore.toFixed(1) : "—"}</b>
          </span>
          <span className="muted">
            {a.filledOrdersAllTime} sold · {sats(a.netProfitSat)} sat net
          </span>
        </div>
      ) : null}

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
      </div>
      {sub === "buy" ? <MarketBuy /> : sub === "sell" ? <MarketSell /> : <MarketOrders />}
    </div>
  );
}
