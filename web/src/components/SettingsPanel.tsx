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
        marketplace in between. <strong>Off by default.</strong> This phase is discovery-only:
        wallets like ZEUS can see your offer; ordering &amp; payment ship next. Needs write
        mode (admin macaroon).
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
          <p className="muted">Point a wallet at your node to test (it connects as a peer):</p>
          {lsp.uris.length ? (
            <div className="challenge-row">
              <code className="challenge">{lsp.uris[0]}</code>
              <button className="reset" onClick={() => copyUri(lsp.uris[0])}>
                {uriCopied ? "copied" : "copy"}
              </button>
            </div>
          ) : (
            <div className="challenge-row">
              <code className="challenge">{lsp.pubkey}</code>
              <button className="reset" onClick={() => copyUri(lsp.pubkey)}>
                {uriCopied ? "copied" : "copy"}
              </button>
            </div>
          )}
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
