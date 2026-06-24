import { useState } from "react";
import { api } from "./api";
import { AlertsBar } from "./components/AlertsBar";
import { AutopilotPanel } from "./components/AutopilotPanel";
import { BrandMark } from "./components/BrandMark";
import { ChannelTable } from "./components/ChannelTable";
import { Footer } from "./components/Footer";
import { Overview } from "./components/Overview";
import { RoutingPanel } from "./components/RoutingPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { SkeletonPanel } from "./components/Skeleton";
import { SuggestionsPanel } from "./components/SuggestionsPanel";
import { TabIcon } from "./components/TabIcon";
import { WalletPanel } from "./components/WalletPanel";
import { WriteLock } from "./components/WriteLock";
import { usePolledData } from "./usePolledData";

type Tab = "overview" | "channels" | "wallet" | "routing" | "autopilot" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "channels", label: "Channels" },
  { id: "wallet", label: "Wallet" },
  { id: "routing", label: "Routing" },
  { id: "autopilot", label: "Autopilot" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const node = usePolledData(api.node, 15_000);
  const channels = usePolledData(api.channels, 30_000);
  const price = usePolledData(api.price, 300_000);
  const [tab, setTab] = useState<Tab>("overview");

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
        <div className="topbar-right">
          <WriteLock />
          <span
            className={`conn ${node.error ? "down" : node.data ? "up" : "wait"}`}
            title={node.error ? "Disconnected — retrying" : node.data ? "Connected" : "Connecting"}
          >
            <i /> {node.error ? "reconnecting" : node.data ? "connected" : "connecting"}
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
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <TabIcon id={t.id} />
            {t.label}
          </button>
        ))}
      </nav>

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
      {node.data ? <AlertsBar /> : null}

      <div className="tab-body">
        {tab === "overview" ? (
          node.data ? (
            <Overview node={node.data} channels={channels.data} price={price.data} />
          ) : (
            <SkeletonPanel rows={6} />
          )
        ) : null}

        {tab === "channels" ? (
          channels.data ? (
            <>
              <ChannelTable channels={channels.data} />
              <SuggestionsPanel />
            </>
          ) : (
            <SkeletonPanel rows={6} />
          )
        ) : null}

        {tab === "wallet" ? <WalletPanel price={price.data} /> : null}
        {tab === "routing" ? <RoutingPanel /> : null}
        {tab === "autopilot" ? <AutopilotPanel /> : null}
        {tab === "settings" ? <SettingsPanel onChange={price.refresh} /> : null}
      </div>

      <Footer />
    </div>
  );
}
