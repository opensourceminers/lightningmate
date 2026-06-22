import { api } from "./api";
import { ChannelTable } from "./components/ChannelTable";
import { FlowsPanel } from "./components/FlowsPanel";
import { SummaryBar } from "./components/SummaryBar";
import { usePolledData } from "./usePolledData";

export function App() {
  const node = usePolledData(api.node, 15_000);
  const channels = usePolledData(api.channels, 30_000);
  const flows = usePolledData(() => api.flows(), 60_000);

  const anyError = node.error ?? channels.error ?? flows.error;
  const initialLoading = node.loading && !node.data;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">⚡ LightningMate</span>
        <button
          className="refresh"
          onClick={() => {
            node.refresh();
            channels.refresh();
            flows.refresh();
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

      {initialLoading ? (
        <div className="loading">Connecting to your node…</div>
      ) : null}

      {node.data ? <SummaryBar node={node.data} /> : null}

      <div className="grid">
        {channels.data ? <ChannelTable channels={channels.data} /> : null}
        {flows.data && channels.data ? (
          <FlowsPanel flows={flows.data} channels={channels.data} />
        ) : null}
      </div>

      <footer className="foot muted">
        Read-only · v0.1 · data refreshes automatically
      </footer>
    </div>
  );
}
