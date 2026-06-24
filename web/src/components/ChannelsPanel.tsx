import { useState } from "react";
import type { ChannelView } from "../types";
import { ChannelTable } from "./ChannelTable";
import { CloseCandidatesPanel } from "./CloseCandidatesPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";

type Sub = "channels" | "suggestions" | "close";

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
      </div>
      {sub === "channels" ? (
        <ChannelTable channels={channels} />
      ) : sub === "suggestions" ? (
        <SuggestionsPanel />
      ) : (
        <CloseCandidatesPanel />
      )}
    </div>
  );
}
