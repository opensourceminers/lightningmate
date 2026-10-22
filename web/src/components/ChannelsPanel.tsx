import { useState } from "react";
import type { ChannelView } from "../types";
import { ChannelTable } from "./ChannelTable";
import { CloseCandidatesPanel } from "./CloseCandidatesPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";

type Sub = "channels" | "open" | "close";

/**
 * Channels, and opening and closing them, in one place (review a6-ux:nav-
 * a11y-copy: opening lived under Autopilot → Channels and closing under
 * Channels → To close). The channel autopilot's switch and settings stay on
 * Autopilot → Channels.
 */
export function ChannelsPanel({
  channels,
  initialSub,
}: {
  channels: ChannelView[];
  initialSub?: string;
}) {
  const [sub, setSub] = useState<Sub>(initialSub === "close" ? "close" : initialSub === "open" ? "open" : "channels");
  const tab = (id: Sub, label: string) => (
    <button className={`subtab ${sub === id ? "active" : ""}`} onClick={() => setSub(id)}>
      {label}
    </button>
  );
  return (
    <div>
      <div className="subnav">
        {tab("channels", "Channels")}
        {tab("open", "To open")}
        {tab("close", "To close")}
      </div>
      {sub === "channels" ? <ChannelTable channels={channels} /> : sub === "open" ? <SuggestionsPanel /> : <CloseCandidatesPanel />}
    </div>
  );
}
