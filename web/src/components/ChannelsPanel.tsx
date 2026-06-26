import { useState } from "react";
import type { ChannelView } from "../types";
import { ChannelTable } from "./ChannelTable";
import { CloseCandidatesPanel } from "./CloseCandidatesPanel";

type Sub = "channels" | "close";

export function ChannelsPanel({
  channels,
  initialSub,
}: {
  channels: ChannelView[];
  initialSub?: string;
}) {
  const [sub, setSub] = useState<Sub>(initialSub === "close" ? "close" : "channels");
  return (
    <div>
      <div className="subnav">
        <button className={`subtab ${sub === "channels" ? "active" : ""}`} onClick={() => setSub("channels")}>
          Channels
        </button>
        <button className={`subtab ${sub === "close" ? "active" : ""}`} onClick={() => setSub("close")}>
          To close
        </button>
      </div>
      {sub === "channels" ? <ChannelTable channels={channels} /> : <CloseCandidatesPanel />}
    </div>
  );
}
