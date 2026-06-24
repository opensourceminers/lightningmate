import { useState } from "react";
import type { ChannelView } from "../types";
import { ChannelTable } from "./ChannelTable";
import { CloseCandidatesPanel } from "./CloseCandidatesPanel";
import { MarketPanel } from "./MarketPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";

type Sub = "channels" | "suggestions" | "close" | "market";

export function ChannelsPanel({ channels }: { channels: ChannelView[] }) {
  const [sub, setSub] = useState<Sub>("channels");
  return (
    <div>
      <div className="subnav">
        <button className={`subtab ${sub === "channels" ? "active" : ""}`} onClick={() => setSub("channels")}>
          Channels
        </button>
        <button className={`subtab ${sub === "suggestions" ? "active" : ""}`} onClick={() => setSub("suggestions")}>
          Suggestions
        </button>
        <button className={`subtab ${sub === "close" ? "active" : ""}`} onClick={() => setSub("close")}>
          To close
        </button>
        <button className={`subtab ${sub === "market" ? "active" : ""}`} onClick={() => setSub("market")}>
          Market
        </button>
      </div>
      {sub === "channels" ? (
        <ChannelTable channels={channels} />
      ) : sub === "suggestions" ? (
        <SuggestionsPanel />
      ) : sub === "close" ? (
        <CloseCandidatesPanel />
      ) : (
        <MarketPanel />
      )}
    </div>
  );
}
