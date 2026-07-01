import { useEffect, useState } from "react";
import { api } from "./api";
import { setNavHandler } from "./nav";
import { AlertsBar } from "./components/AlertsBar";
import { AnalyticsPanel } from "./components/AnalyticsPanel";
import { AutopilotPanel } from "./components/AutopilotPanel";
import { BrandMark } from "./components/BrandMark";
import { ChannelsPanel } from "./components/ChannelsPanel";
import { Footer } from "./components/Footer";
import { LogoutButton } from "./components/LogoutButton";
import { MarketPanel } from "./components/MarketPanel";
import { Overview } from "./components/Overview";
import { SettingsPanel } from "./components/SettingsPanel";
import { SkeletonPanel } from "./components/Skeleton";
import { TabIcon } from "./components/TabIcon";
import { WalletPanel } from "./components/WalletPanel";
import { usePolledData } from "./usePolledData";

type Tab = "overview" | "channels" | "market" | "wallet" | "analytics" | "autopilot" | "settings";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "channels", label: "Channels" },
  { id: "market", label: "Market" },
  { id: "wallet", label: "Wallet" },
  { id: "analytics", label: "Analytics" },
  { id: "autopilot", label: "Autopilot" },
  { id: "settings", label: "Settings" },
];

export function App() {
  const node = usePolledData(api.node, 15_000);
  const channels = usePolledData(api.channels, 30_000);
  const price = usePolledData(api.price, 300_000);
  const [tab, setTab] = useState<Tab>("overview");
  // Sub-tab to open when navigating from an Overview tile (e.g. Channels → suggestions).
  const [pendingSub, setPendingSub] = useState<string | undefined>(undefined);
  const navigate = (t: string, sub?: string) => {
    setTab(t as Tab);
    setPendingSub(sub);
  };

  // Let any component request a tab jump (e.g. "go to Autopilot" links).
  useEffect(() => {
    setNavHandler(navigate);
    return () => setNavHandler(null);
  }, []);

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
          <LogoutButton />
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
            onClick={() => {
              setTab(t.id);
              setPendingSub(undefined);
            }}
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
            <Overview node={node.data} channels={channels.data} price={price.data} onNavigate={navigate} />
          ) : (
            <SkeletonPanel rows={6} />
          )
        ) : null}

        {tab === "channels" ? (
          channels.data ? (
            <ChannelsPanel channels={channels.data} initialSub={pendingSub} />
          ) : (
            <SkeletonPanel rows={6} />
          )
        ) : null}

        {tab === "market" ? <MarketPanel /> : null}
        {tab === "wallet" ? <WalletPanel price={price.data} /> : null}
        {tab === "analytics" ? <AnalyticsPanel initialSub={pendingSub} /> : null}
        {tab === "autopilot" ? <AutopilotPanel initialSub={pendingSub} /> : null}
        {tab === "settings" ? <SettingsPanel onChange={price.refresh} /> : null}
      </div>

      <Footer />
    </div>
  );
}
