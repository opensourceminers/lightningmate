import { useState } from "react";
import { api } from "./api";
import { AlertsBar } from "./components/AlertsBar";
import { AutopilotPanel } from "./components/AutopilotPanel";
import { BrandMark } from "./components/BrandMark";
import { ChannelTable } from "./components/ChannelTable";
import { PnlOverview } from "./components/PnlOverview";
import { FeesPanel } from "./components/FeesPanel";
import { Footer } from "./components/Footer";
import { ForwardsPanel } from "./components/ForwardsPanel";
import { HealthScore } from "./components/HealthScore";
import { LiquidityMap } from "./components/LiquidityMap";
import { LiveFeed } from "./components/LiveFeed";
import { RebalancePanel } from "./components/RebalancePanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SuggestionsPanel } from "./components/SuggestionsPanel";
import { SummaryBar } from "./components/SummaryBar";
import { usePolledData } from "./usePolledData";

type Tab = "channels" | "suggestions" | "forwards" | "fees" | "rebalance" | "autopilot" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "channels", label: "Channels" },
  { id: "suggestions", label: "Suggestions" },
  { id: "forwards", label: "Forwards" },
  { id: "fees", label: "Fees" },
  { id: "rebalance", label: "Rebalancing" },
  { id: "autopilot", label: "Autopilot" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const node = usePolledData(api.node, 15_000);
  const channels = usePolledData(api.channels, 30_000);
  const price = usePolledData(api.price, 300_000);
  const [tab, setTab] = useState<Tab>("channels");

  const anyError = node.error ?? channels.error;
  const initialLoading = node.loading && !node.data;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">
          <BrandMark />
          Lightning Mate
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

      {node.data ? <SummaryBar node={node.data} price={price.data} /> : null}
      {node.data ? <AlertsBar /> : null}
      {node.data ? (
        <div className="hero-row">
          <HealthScore />
          <LiveFeed />
        </div>
      ) : null}
      {node.data ? <PnlOverview price={price.data} /> : null}

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
          channels.data ? (
            <>
              <LiquidityMap channels={channels.data} />
              <ChannelTable channels={channels.data} />
            </>
          ) : (
            <Placeholder />
          )
        ) : null}
        {tab === "forwards" ? <ForwardsPanel /> : null}
        {tab === "suggestions" ? <SuggestionsPanel /> : null}
        {tab === "fees" ? <FeesPanel /> : null}
        {tab === "rebalance" ? <RebalancePanel /> : null}
        {tab === "autopilot" ? <AutopilotPanel /> : null}
        {tab === "settings" ? <SettingsPanel onChange={price.refresh} /> : null}
      </div>

      <Footer />
    </div>
  );
}

function Placeholder() {
  return <div className="panel"><p className="muted empty">Loading…</p></div>;
}
