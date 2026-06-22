import { useState } from "react";
import { api } from "./api";
import { AutopilotPanel } from "./components/AutopilotPanel";
import { BrandMark } from "./components/BrandMark";
import { ChannelTable } from "./components/ChannelTable";
import { PnlOverview } from "./components/PnlOverview";
import { FeesPanel } from "./components/FeesPanel";
import { ForwardsPanel } from "./components/ForwardsPanel";
import { RebalancePanel } from "./components/RebalancePanel";
import { SuggestionsPanel } from "./components/SuggestionsPanel";
import { SummaryBar } from "./components/SummaryBar";
import { usePolledData } from "./usePolledData";

type Tab = "channels" | "suggestions" | "forwards" | "fees" | "rebalance" | "autopilot";

const TABS: { id: Tab; label: string }[] = [
  { id: "channels", label: "Channels" },
  { id: "suggestions", label: "Suggestions" },
  { id: "forwards", label: "Forwards" },
  { id: "fees", label: "Fees" },
  { id: "rebalance", label: "Rebalancing" },
  { id: "autopilot", label: "Autopilot" },
];

export function App() {
  const node = usePolledData(api.node, 15_000);
  const channels = usePolledData(api.channels, 30_000);
  const [tab, setTab] = useState<Tab>("channels");

  const anyError = node.error ?? channels.error;
  const initialLoading = node.loading && !node.data;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <BrandMark />
          LightningMate
          <span className="brand-sub">Lightning node manager</span>
        </span>
        <button
          className="refresh"
          onClick={() => {
            node.refresh();
            channels.refresh();
          }}
        >
          ↻ refresh
        </button>
      </header>

      {anyError ? (
        <div className="banner error">
          Couldn’t reach the node: {anyError}
          <div className="banner-sub">
            Check <code>LND_SOCKET</code>, cert and read-only macaroon in your
            <code> .env</code>, and that the backend is running.
          </div>
        </div>
      ) : null}

      {initialLoading ? <div className="loading">Connecting to your node…</div> : null}

      {node.data ? <SummaryBar node={node.data} /> : null}
      {node.data ? <PnlOverview /> : null}

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="tab-body">
        {tab === "channels" ? (
          channels.data ? <ChannelTable channels={channels.data} /> : <Placeholder />
        ) : null}
        {tab === "forwards" ? <ForwardsPanel /> : null}
        {tab === "suggestions" ? <SuggestionsPanel /> : null}
        {tab === "fees" ? <FeesPanel /> : null}
        {tab === "rebalance" ? <RebalancePanel /> : null}
        {tab === "autopilot" ? <AutopilotPanel /> : null}
      </div>

      <footer className="foot muted">Read-only by default · v0.4 · data refreshes automatically</footer>
    </div>
  );
}

function Placeholder() {
  return <div className="panel"><p className="muted empty">Loading…</p></div>;
}
