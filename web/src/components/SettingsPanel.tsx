import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, FiatCurrency, LspStatus } from "../types";
import { BackupCard } from "./BackupCard";
import { Switch, RunState } from "./Switch";
import { satsCompact, timeAgo } from "../format";

const CURRENCIES: { value: FiatCurrency; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "USD", label: "USD $" },
  { value: "EUR", label: "EUR €" },
  { value: "GBP", label: "GBP £" },
  { value: "CHF", label: "CHF" },
];

export function SettingsPanel({ onChange }: { onChange: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Amboss / Magma connection
  const [ambossConnected, setAmbossConnected] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [ambossBusy, setAmbossBusy] = useState(false);
  const [ambossError, setAmbossError] = useState<string | null>(null);

  useEffect(() => {
    api.getSettings().then(setSettings).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api.ambossStatus().then((s) => setAmbossConnected(s.connected)).catch(() => setAmbossConnected(false));
  }, []);

  const connectAmboss = async () => {
    if (!keyInput.trim() || ambossBusy) return;
    setAmbossBusy(true);
    setAmbossError(null);
    try {
      await api.ambossConnect(keyInput.trim());
      setAmbossConnected(true);
      setKeyInput("");
    } catch (e) {
      setAmbossError(e instanceof Error ? e.message : String(e));
    } finally {
      setAmbossBusy(false);
    }
  };

  const disconnectAmboss = async () => {
    setAmbossBusy(true);
    setAmbossError(null);
    try {
      await api.ambossDisconnect();
      setAmbossConnected(false);
    } catch (e) {
      setAmbossError(e instanceof Error ? e.message : String(e));
    } finally {
      setAmbossBusy(false);
    }
  };

  const choose = async (fiatCurrency: FiatCurrency) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.setSettings({ fiatCurrency }));
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // LSP mode (beta) — sell channels to LSPS1 wallets, discovery-only phase.
  const [lsp, setLsp] = useState<LspStatus | null>(null);
  const [lspBusy, setLspBusy] = useState(false);
  const [lspError, setLspError] = useState<string | null>(null);
  const [uriCopied, setUriCopied] = useState(false);

  useEffect(() => {
    api.lspStatus().then(setLsp).catch(() => setLsp(null));
  }, []);

  // While the mode is on, poll so incoming get_info requests show up live —
  // that's how you verify a wallet (e.g. ZEUS) actually reached the node.
  useEffect(() => {
    if (!lsp?.enabled) return;
    const t = setInterval(() => {
      api.lspStatus().then(setLsp).catch(() => undefined);
    }, 10_000);
    return () => clearInterval(t);
  }, [lsp?.enabled]);

  const toggleLsp = async (on: boolean) => {
    if (lspBusy) return;
    setLspBusy(true);
    setLspError(null);
    try {
      setSettings(await api.setSettings({ lspModeEnabled: on }));
      setLsp(await api.lspStatus());
    } catch (e) {
      setLspError(e instanceof Error ? e.message : String(e));
    } finally {
      setLspBusy(false);
    }
  };

  const copyUri = (uri: string) => {
    void navigator.clipboard.writeText(uri);
    setUriCopied(true);
    setTimeout(() => setUriCopied(false), 1500);
  };

  // Clearnet announcement (host:port) via the node API — Umbrel's own UI has
  // no externalip field, so LightningMate keeps this announced for you.
  const [clearnetInput, setClearnetInput] = useState("");
  useEffect(() => {
    if (settings) setClearnetInput(settings.lspClearnetAddress ?? "");
  }, [settings?.lspClearnetAddress]);

  const saveClearnet = async () => {
    if (lspBusy) return;
    setLspBusy(true);
    setLspError(null);
    try {
      setSettings(await api.setSettings({ lspClearnetAddress: clearnetInput.trim() }));
      setLsp(await api.lspStatus());
    } catch (e) {
      setLspError(e instanceof Error ? e.message : String(e));
    } finally {
      setLspBusy(false);
    }
  };

  // Ready-to-share buyer instructions — the practical discovery channel while
  // graph crawlers catch up on the feature bit.
  const [guideCopied, setGuideCopied] = useState(false);
  // Prefer a clearnet URI when the node announces both — more wallets reach it.
  const preferredUri = (l: LspStatus) =>
    l.uris.find((u) => !u.includes(".onion")) ?? l.uris[0] ?? l.pubkey;

  const copyBuyerGuide = () => {
    if (!lsp) return;
    const uri = preferredUri(lsp);
    const tor = uri.includes(".onion") ? " (reachable over Tor)" : "";
    void navigator.clipboard.writeText(
      [
        "Buy an inbound Lightning channel directly from my node (LSPS1 / bLIP-51):",
        "",
        `Node URI: ${uri}${tor}`,
        "",
        "In ZEUS: Settings → Lightning Service Provider → set this node as your",
        'LSPS1 provider (pubkey@host), then Channels → "Purchase Inbound".',
        "Any LSPS1-capable wallet or the BTCPay Server LSP plugin works too.",
      ].join("\n"),
    );
    setGuideCopied(true);
    setTimeout(() => setGuideCopied(false), 1500);
  };

  // Sign a message with the node (e.g. Amboss's "Login with Node" challenge)
  const [signInput, setSignInput] = useState("");
  const [signature, setSignature] = useState("");
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [sigCopied, setSigCopied] = useState(false);

  const doSign = async () => {
    if (!signInput.trim() || signing) return;
    setSigning(true);
    setSignError(null);
    setSignature("");
    try {
      setSignature((await api.signMessage(signInput.trim())).signature);
    } catch (e) {
      setSignError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigning(false);
    }
  };

  const copySig = () => {
    void navigator.clipboard.writeText(signature);
    setSigCopied(true);
    setTimeout(() => setSigCopied(false), 1500);
  };

  return (
    <>
    <section className="panel">
      <div className="panel-head"><h2>Settings</h2></div>

      <h3 className="sub">Fiat currency</h3>
      <div className="dryrun-banner">
        Show a fiat estimate next to sat amounts. <strong>Off by default</strong> — when
        enabled, LightningMate fetches the BTC price from mempool.space (the only outbound
        request it makes).
      </div>
      <div className="seg">
        {CURRENCIES.map((c) => (
          <button
            key={c.value}
            className={`seg-btn ${settings?.fiatCurrency === c.value ? "active" : ""}`}
            disabled={busy || !settings}
            onClick={() => choose(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error ? <p className="banner error">{error}</p> : null}

      <h3 className="sub">Amboss Magma</h3>
      <div className="dryrun-banner">
        Connect your Amboss account to buy (and later sell) channel liquidity on the Magma
        marketplace, from the <strong>Channels → Market</strong> tab. Browsing the market needs
        no key; buying does. Get a key at{" "}
        <a href="https://account.amboss.tech/settings/api-keys" target="_blank" rel="noreferrer">
          account.amboss.tech
        </a>
        . It’s stored only on your node.
      </div>
      {ambossConnected === null ? (
        <p className="muted">Checking…</p>
      ) : ambossConnected ? (
        <div className="amboss-row">
          <span className="conn up">
            <i /> Amboss connected
          </span>
          <button className="reset" disabled={ambossBusy} onClick={() => void disconnectAmboss()}>
            {ambossBusy ? "…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="amboss-row">
          <input
            type="password"
            className="unlock-input amboss-key"
            value={keyInput}
            placeholder="Amboss API key"
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void connectAmboss();
            }}
          />
          <button className="primary-btn" disabled={!keyInput.trim() || ambossBusy} onClick={() => void connectAmboss()}>
            {ambossBusy ? "Connecting…" : "Connect"}
          </button>
        </div>
      )}
      {ambossError ? <p className="banner error">{ambossError}</p> : null}

      <h3 className="sub">LSP mode (beta)</h3>
      <div className="dryrun-banner">
        Sell inbound channels <strong>directly to wallets and nodes</strong> speaking the open
        LSP standard (LSPS1 / bLIP-51) — a second demand source beside Magma, with no
        marketplace in between. Orders are priced by the same engine as Magma selling; the
        buyer pays a hold invoice that only settles once the channel is opening, so failures
        refund automatically. <strong>Off by default.</strong> Needs write mode (admin macaroon).
      </div>
      <div className="amboss-row">
        <Switch
          checked={settings?.lspModeEnabled ?? false}
          disabled={lspBusy || !settings || (lsp !== null && !lsp.canWrite)}
          onChange={(v) => void toggleLsp(v)}
          label="LSP mode"
        />
        <RunState on={settings?.lspModeEnabled ?? false} />
        {lsp && !lsp.canWrite ? <span className="muted">write mode is off — enable it to use LSP mode</span> : null}
      </div>
      {lspError ? <p className="banner error">{lspError}</p> : null}
      {settings?.lspModeEnabled && lsp ? (
        <>
          <div className="amboss-row" style={{ marginTop: 10 }}>
            <span className={`conn ${lsp.running ? "up" : "down"}`}>
              <i /> {lsp.running ? "Listening for LSP clients" : "Not listening"}
            </span>
            <span className="muted">
              get_info served: {lsp.requestsServed}
              {lsp.lastRequestAt ? ` · last ${timeAgo(lsp.lastRequestAt)}` : ""}
            </span>
          </div>
          {!lsp.running && lsp.lastError ? <p className="banner error">{lsp.lastError}</p> : null}
          {lsp.offer ? (
            <p className="muted">
              Advertising {satsCompact(lsp.offer.minChannelSat)}–{satsCompact(lsp.offer.maxChannelSat)} sat
              channels, leases up to ~{Math.round(lsp.offer.maxChannelExpiryBlocks / 144)} days
              · {satsCompact(lsp.offer.deployableSat)} sat deployable on-chain
            </p>
          ) : null}
          {lsp.ordersPending + lsp.ordersCompleted + lsp.ordersFailed > 0 ? (
            <p className="muted">
              Orders: {lsp.ordersPending} pending · {lsp.ordersCompleted} completed
              {lsp.ordersFailed > 0 ? ` · ${lsp.ordersFailed} failed` : ""}
              {lsp.earnedSat > 0 ? ` · ${lsp.earnedSat.toLocaleString()} sat earned` : ""} — details
              in Channels → Market → Orders
            </p>
          ) : null}
          {lsp.serviceFeeBps > 0 ? (
            <p className="fee-note">
              A {lsp.serviceFeeBps / 100}% service fee on completed sales supports Lightning Mate’s development.
            </p>
          ) : null}
          <p className="muted">
            {lsp.featureBit.set
              ? "Announcing LSP support in the node graph (feature bit 729) — explorers and wallets can discover you."
              : lsp.featureBit.error
                ? `Graph announcement unavailable (${lsp.featureBit.error}) — share your URI directly instead.`
                : "Graph announcement pending…"}
          </p>
          <p className="muted">Buyers point their wallet at your node (it connects as a peer):</p>
          {(() => {
            const uri = preferredUri(lsp);
            return (
              <div className="challenge-row">
                <code className="challenge">{uri}</code>
                <button className="reset" onClick={() => copyUri(uri)}>
                  {uriCopied ? "copied" : "copy"}
                </button>
                <button className="reset" onClick={copyBuyerGuide}>
                  {guideCopied ? "copied" : "copy buyer guide"}
                </button>
              </div>
            );
          })()}
          {lsp.uris.length > 0 && lsp.uris.every((u) => u.includes(".onion")) ? (
            <p className="hint">
              Your node announces a Tor-only address — buyers need a Tor-capable wallet (e.g. ZEUS on
              Android). Announce a clearnet address below to reach more wallets.
            </p>
          ) : null}
          <p className="muted" style={{ marginTop: 10 }}>
            Announce a clearnet address (needs port 9735 forwarded on your router; use a DDNS name
            if your IP changes). LightningMate keeps it announced across node restarts:
          </p>
          <div className="amboss-row">
            <input
              className="unlock-input amboss-key"
              value={clearnetInput}
              placeholder="mynode.example.com:9735 or 203.0.113.7:9735"
              onChange={(e) => setClearnetInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveClearnet();
              }}
            />
            <button
              className="primary-btn"
              disabled={lspBusy || clearnetInput.trim() === (settings?.lspClearnetAddress ?? "")}
              onClick={() => void saveClearnet()}
            >
              {clearnetInput.trim() ? "Announce" : "Withdraw"}
            </button>
          </div>
          {lsp.announcedSocket.error ? (
            <p className="banner error">{lsp.announcedSocket.error}</p>
          ) : lsp.announcedSocket.address && lsp.announcedSocket.applied ? (
            <p className="muted">Announcing {lsp.announcedSocket.address} in the node graph ✓</p>
          ) : null}
        </>
      ) : null}

      <h3 className="sub">Sign a message</h3>
      <div className="dryrun-banner">
        Sign any message with your node’s key. Use this for Amboss’ <strong>“Login with Node”</strong>{" "}
        challenge (e.g. <code>amboss-…</code>) to get your API key above — paste the message,
        sign, and copy the signature back to Amboss. Needs write mode (admin macaroon).
      </div>
      <textarea
        className="unlock-input sig-input"
        rows={2}
        value={signInput}
        placeholder="Message to sign (e.g. the amboss-… challenge)"
        onChange={(e) => setSignInput(e.target.value)}
      />
      <div className="amboss-row">
        <button className="primary-btn" disabled={!signInput.trim() || signing} onClick={() => void doSign()}>
          {signing ? "Signing…" : "Sign with node"}
        </button>
      </div>
      {signature ? (
        <div className="challenge-row" style={{ marginTop: 10 }}>
          <code className="challenge">{signature}</code>
          <button className="reset" onClick={copySig}>{sigCopied ? "copied" : "copy"}</button>
        </div>
      ) : null}
      {signError ? <p className="banner error">{signError}</p> : null}

      <p className="hint">
        More settings (autopilot safety caps, refresh intervals, alerts) live in their own
        tabs — this page will grow.
      </p>
    </section>

    <BackupCard />
    </>
  );
}
