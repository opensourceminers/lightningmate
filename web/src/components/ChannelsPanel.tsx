import { useState } from "react";
import type { ChannelView } from "../types";
import { ChannelTable } from "./ChannelTable";
import { CloseCandidatesPanel } from "./CloseCandidatesPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";

type Sub = "channels" | "suggestions" | "close";

export function ChannelsPanel({
  channels,
  initialSub,
}: {
  channels: ChannelView[];
  initialSub?: string;
}) {
  const [sub, setSub] = useState<Sub>(
    initialSub === "suggestions" || initialSub === "close" ? initialSub : "channels",
  );
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
