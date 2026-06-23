import { useState } from "react";
import { ForwardsPanel } from "./ForwardsPanel";
import { FeesPanel } from "./FeesPanel";
import { RebalancePanel } from "./RebalancePanel";

type Sub = "forwards" | "fees" | "rebalance";

export function RoutingPanel() {
  const [sub, setSub] = useState<Sub>("forwards");
  return (
    <div>
      <div className="subnav">
        <button className={`subtab ${sub === "forwards" ? "active" : ""}`} onClick={() => setSub("forwards")}>
          Forwards
        </button>
        <button className={`subtab ${sub === "fees" ? "active" : ""}`} onClick={() => setSub("fees")}>
          Fees
        </button>
        <button className={`subtab ${sub === "rebalance" ? "active" : ""}`} onClick={() => setSub("rebalance")}>
          Rebalancing
        </button>
      </div>
      {sub === "forwards" ? <ForwardsPanel /> : sub === "fees" ? <FeesPanel /> : <RebalancePanel />}
    </div>
  );
}
