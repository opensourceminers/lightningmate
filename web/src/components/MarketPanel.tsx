import { useState } from "react";
import { MarketBuy } from "./MarketBuy";
import { MarketSell } from "./MarketSell";
import { MarketOrders } from "./MarketOrders";

type Sub = "buy" | "sell" | "orders";

export function MarketPanel() {
  const [sub, setSub] = useState<Sub>("buy");
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
      </div>
      {sub === "buy" ? <MarketBuy /> : sub === "sell" ? <MarketSell /> : <MarketOrders />}
    </div>
  );
}
