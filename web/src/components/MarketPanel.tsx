import { useState } from "react";
import { MarketBuy } from "./MarketBuy";
import { MarketSell } from "./MarketSell";
import { MarketOrders } from "./MarketOrders";
import { LnPlusPanel } from "./LnPlusPanel";

type Sub = "buy" | "sell" | "orders" | "lnplus";
const SUBS: Sub[] = ["buy", "sell", "orders", "lnplus"];

/**
 * Market: buying inbound first — the part that works for any node — then
 * selling, labelled as the advanced feature it is (D9): Amboss decides which
 * seller gets an order, and most small nodes don't get any. The seller-score
 * "coach" that used to sit above every tab promised that listing, pricing and
 * size would build a score and win buyers; the Sell tab now says what is
 * known instead (eligibility, diagnostics, how Amboss picks sellers).
 * `initialSub` lets the Overview, the alerts and the diagnostics link straight
 * to Sell or Orders.
 */
export function MarketPanel({ initialSub }: { initialSub?: string }) {
  const [sub, setSub] = useState<Sub>(initialSub && (SUBS as string[]).includes(initialSub) ? (initialSub as Sub) : "buy");
  const tab = (id: Sub, label: string, title?: string) => (
    <button className={`subtab ${sub === id ? "active" : ""}`} onClick={() => setSub(id)} title={title}>
      {label}
    </button>
  );
  return (
    <div>
      <div className="subnav">
        {tab("buy", "Buy")}
        {tab("sell", "Sell (advanced)", "Selling liquidity on Magma: Amboss decides which seller gets an order")}
        {tab("orders", "Orders")}
        {tab("lnplus", "LN+")}
      </div>
      {sub === "buy" ? <MarketBuy /> : sub === "sell" ? <MarketSell /> : sub === "orders" ? <MarketOrders /> : <LnPlusPanel />}
    </div>
  );
}
