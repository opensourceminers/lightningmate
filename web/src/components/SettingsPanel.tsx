import { useEffect, useState } from "react";
import { api } from "../api";
import type { AppSettings, FiatCurrency } from "../types";

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

  return (
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

      <p className="hint">
        More settings (autopilot safety caps, refresh intervals, alerts) live in their own
        tabs — this page will grow.
      </p>
    </section>
  );
}
