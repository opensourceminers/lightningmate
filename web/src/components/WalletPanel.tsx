import { useState } from "react";
import type { PriceInfo } from "../types";
import { PaymentsPanel } from "./PaymentsPanel";
import { OnchainPanel } from "./OnchainPanel";

type Sub = "lightning" | "onchain";

export function WalletPanel({ price }: { price?: PriceInfo | null }) {
  const [sub, setSub] = useState<Sub>("lightning");
  return (
    <div>
      <div className="subnav">
        <button className={`subtab ${sub === "lightning" ? "active" : ""}`} onClick={() => setSub("lightning")}>
          ⚡ Lightning
        </button>
        <button className={`subtab ${sub === "onchain" ? "active" : ""}`} onClick={() => setSub("onchain")}>
          ⛓ On-chain
        </button>
      </div>
      {sub === "lightning" ? <PaymentsPanel price={price} /> : <OnchainPanel price={price} />}
    </div>
  );
}
