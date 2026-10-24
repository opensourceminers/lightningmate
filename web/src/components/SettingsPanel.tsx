import { useEffect, useState } from "react";
import { api } from "../api";
import { pageHidden } from "../usePolledData";
import type { AmbossKeyCheck, AppSettings, FiatCurrency, LspStatus, PrivacyInfo, TorRoute } from "../types";
import { CLEARNET_WARNING, lspBuyerGuide, lspIgnoredLine, lspReachText, lspRecoveryLine } from "../lspView";
import { TOR_ROUTES, destinationLine, privacySummary } from "../privacyView";
import { BackupCard } from "./BackupCard";
import { AmbossKeyStatus } from "./AmbossKeyStatus";
import { LspActivity } from "./LspActivity";
import { Switch, RunState } from "./Switch";
import { useUi } from "./Overlay";
import { satsCompact, timeAgo } from "../format";
import { formatVersion } from "../version";
import { removeKeyMessage } from "../statusNotes";

const CURRENCIES: { value: FiatCurrency; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "USD", label: "USD $" },
  { value: "EUR", label: "EUR €" },
  { value: "GBP", label: "GBP £" },
  { value: "CHF", label: "CHF" },
];

export function SettingsPanel({ onChange, version }: { onChange: () => void; version?: string }) {
  const [diagError, setDiagError] = useState<string | null>(null);
  const ui = useUi();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Amboss / Magma connection
  const [ambossConnected, setAmbossConnected] = useState<boolean | null>(null);
  const [keyValid, setKeyValid] = useState<boolean | null | undefined>(undefined);
  const [keyCheck, setKeyCheck] = useState<AmbossKeyCheck>("unknown");
  const [keyCheckError, setKeyCheckError] = useState<string | null>(null);
  const [ordersInFlight, setOrdersInFlight] = useState(0);
  const [keyInput, setKeyInput] = useState("");
  const [ambossBusy, setAmbossBusy] = useState(false);
  const [ambossError, setAmbossError] = useState<string | null>(null);

  // Where the app's own lookups go (Privacy).
  const [privacy, setPrivacy] = useState<PrivacyInfo | null>(null);
  const loadPrivacy = () => api.privacy().then(setPrivacy).catch(() => setPrivacy(null));

  useEffect(() => {
    void loadPrivacy();
    api.getSettings().then(setSettings).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    api
      .ambossStatus()
      .then((s) => {
        setAmbossConnected(s.connected);
        setKeyValid(s.keyValid);
        setKeyCheck(s.keyCheck);
        setKeyCheckError(s.lastError);
        setOrdersInFlight(s.ordersInFlight ?? 0);
      })
      .catch(() => setAmbossConnected(false));
  }, []);

  // "Re-check": ask Amboss about the stored key now. Never deletes it.
  const recheckAmboss = async () => {
    setAmbossBusy(true);
    setAmbossError(null);
    try {
      const s = await api.ambossKeyCheck();
      setKeyValid(s.keyValid);
      setKeyCheck(s.keyCheck);
      setKeyCheckError(s.lastError);
      setOrdersInFlight(s.ordersInFlight ?? 0);
    } catch (e) {
      setAmbossError(e instanceof Error ? e.message : String(e));
    } finally {
      setAmbossBusy(false);
    }
  };

  const connectAmboss = async () => {
    if (!keyInput.trim() || ambossBusy) return;
    setAmbossBusy(true);
    setAmbossError(null);
    try {
      await api.ambossConnect(keyInput.trim());
      setAmbossConnected(true);
      setKeyValid(true);
      setKeyCheck("valid");
      setKeyInput("");
    } catch (e) {
      setAmbossError(e instanceof Error ? e.message : String(e));
    } finally {
      setAmbossBusy(false);
    }
  };

  // Removing the key is never a single click: it is confirmed, and the
  // confirmation says what happens to Magma orders still in flight (fetched
  // fresh — the count on screen may be minutes old).
  const disconnectAmboss = async () => {
    let inFlight = ordersInFlight;
    try {
      inFlight = (await api.ambossStatus()).ordersInFlight ?? inFlight;
      setOrdersInFlight(inFlight);
    } catch {
      // keep the last known count
    }
    const ok = await ui.confirm({
      title: inFlight > 0 ? "Remove the Amboss key? Orders are in flight" : "Remove the Amboss key?",
      message: removeKeyMessage(inFlight),
      confirmLabel: "Remove key",
      danger: true,
    });
    if (!ok) return;
    setAmbossBusy(true);
    setAmbossError(null);
    try {
      await api.ambossDisconnect();
      setAmbossConnected(false);
      setKeyValid(undefined);
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
      void loadPrivacy();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const savePrivacy = async (patch: { lnplusLookups?: boolean; torRoute?: TorRoute }) => {
    setBusy(true);
    setError(null);
    try {
      setSettings(await api.setSettings(patch));
      await loadPrivacy();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // LSP mode (experimental) — sell channels to LSPS1 wallets over BOLT8.
  const [lsp, setLsp] = useState<LspStatus | null>(null);
  const [lspBusy, setLspBusy] = useState(false);
  const [lspError, setLspError] = useState<string | null>(null);
  const [uriCopied, setUriCopied] = useState(false);

  useEffect(() => {
    api.lspStatus().then(setLsp).catch(() => setLsp(null));
  }, []);

  // While the mode is on, poll so incoming requests show up live — served
  // or refused — which is how you verify a wallet (e.g. ZEUS) reached the node.
  useEffect(() => {
    if (!lsp?.enabled) return;
    const t = setInterval(() => {
      // (Not in a background tab: nobody is watching.)
      if (!pageHidden()) api.lspStatus().then(setLsp).catch(() => undefined);
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
  // The node's announced clearnet URI when it has one (a buyer without Tor
  // can reach that one), else its .onion URI.
  const preferredUri = (l: LspStatus) =>
    l.uris.find((u) => !u.includes(".onion")) ?? l.uris[0] ?? l.pubkey;

  const copyBuyerGuide = () => {
    if (!lsp) return;
    void navigator.clipboard.writeText(lspBuyerGuide(preferredUri(lsp)));
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

      {/* Each section shows its switches and its state; what explains them
          is one click away (2026-10-24: the page ran to 815 words). */}
      <h3 className="sub">Fiat currency</h3>
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

      <h3 className="sub">Privacy</h3>
      {privacy ? (
        <>
          {/* Without a proxy every lookup leaves from the home IP: said up front. */}
          {privacy.torProxy ? null : <div className="dryrun-banner">{privacySummary(privacy)}</div>}
          {privacy.torProxy ? (
            <div className="seg">
              {TOR_ROUTES.map((r) => (
                <button
                  key={r.id}
                  className={`seg-btn ${privacy.torRoute === r.id ? "active" : ""}`}
                  disabled={busy}
                  title={r.desc}
                  onClick={() => void savePrivacy({ torRoute: r.id })}
                >
                  {r.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="amboss-row" style={{ marginTop: 10 }}>
            <Switch
              checked={privacy.lnplusLookups}
              disabled={busy}
              onChange={(v) => void savePrivacy({ lnplusLookups: v })}
              label="LN+ lookups"
            />
            <span className="muted">LN+ lookups: peer reputations from lightningnetwork.plus — your node's own key included</span>
          </div>
          <details className="set-more">
            <summary>Where each lookup goes</summary>
            {privacy.torProxy ? <p className="muted">{privacySummary(privacy)}</p> : null}
            <ul className="close-aside">
              {privacy.destinations.map((d) => (
                <li key={d.service}>{destinationLine(d)}</li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}

      <h3 className="sub">Amboss Magma</h3>
      {ambossConnected === null ? (
        <p className="muted">Checking…</p>
      ) : ambossConnected ? (
        <AmbossKeyStatus
          keyValid={keyValid}
          keyCheck={keyCheck}
          lastError={keyCheckError}
          busy={ambossBusy}
          onRecheck={() => void recheckAmboss()}
          onRemove={() => void disconnectAmboss()}
          ordersInFlight={ordersInFlight}
        />
      ) : (
        <>
          <p className="muted">
            Buying and selling on Magma (Market tab) need an Amboss API key — get one at{" "}
            <a href="https://account.amboss.tech/settings/api-keys" target="_blank" rel="noreferrer">
              account.amboss.tech
            </a>
            . It’s stored only on your node.
          </p>
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
        </>
      )}
      {ambossError ? <p className="banner error">{ambossError}</p> : null}
      <details className="set-more">
        <summary>Sign a message</summary>
        <p className="muted">
          With your node’s key — for Amboss’ <strong>“Login with Node”</strong> challenge (<code>amboss-…</code>):
          paste it, sign, and copy the signature back to Amboss. Needs write mode (admin macaroon).
        </p>
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
      </details>

      <h3 className="sub">LSP mode (experimental)</h3>
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
      {settings?.lspModeEnabled ? null : (
        <p className="muted">Sell inbound channels directly to wallets that order over Lightning (LSPS1) — few wallets can, so expect few orders.</p>
      )}
      {settings?.lspModeEnabled && lsp ? (
        <>
          <LspActivity lsp={lsp} />
          {lsp.clients.length > 0 ? (
            <p className="muted">
              Wallets seen: {lsp.clients.map((c) => `${c.app}${c.version ? ` ${c.version}` : ""} (${timeAgo(c.lastAt)})`).join(", ")}
            </p>
          ) : null}
          {lspIgnoredLine(lsp) ? <p className="muted">Wallet extras ignored (accepted, not used): {lspIgnoredLine(lsp)}</p> : null}
          {lspRecoveryLine(lsp) ? <p className="banner error">{lspRecoveryLine(lsp)}</p> : null}
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
              in Market → Orders
            </p>
          ) : null}
          {lsp.serviceFeeBps > 0 ? (
            <p className="fee-note">
              A {lsp.serviceFeeBps / 100}% service fee on completed sales supports Lightning Mate’s development.
            </p>
          ) : null}
          <p className="muted">Buyers connect to:</p>
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
          {/* A home IP in the public graph is never tucked away. */}
          {lsp.announcedSocket.error ? (
            <p className="banner error">{lsp.announcedSocket.error}</p>
          ) : lsp.announcedSocket.address && lsp.announcedSocket.applied ? (
            <p className="muted">Announcing {lsp.announcedSocket.address} in the node graph ✓</p>
          ) : null}
        </>
      ) : null}
      {lsp ? (
        <details className="set-more">
          <summary>{settings?.lspModeEnabled ? "Who can order, graph announcement, clearnet address" : "How it works, and who can order"}</summary>
          <p className="muted">
            Inbound channels sold directly to wallets speaking the open LSP standard (LSPS1 / bLIP-51) over Lightning
            peer messages, with no marketplace in between. Orders are priced by the same engine as Magma selling; the
            buyer pays a hold invoice that only settles once the channel is opening, so failures refund automatically.
            Needs write mode (admin macaroon).
          </p>
          {/* Who can order here — before the mode is switched on, too. */}
          <p className="muted">{lspReachText(lsp.uris)}</p>
          {settings?.lspModeEnabled ? (
            <>
              <p className="muted">
                {lsp.featureBit.set
                  ? "Announcing LSP support in the node graph (feature bit 729) — explorers and wallets can discover you."
                  : lsp.featureBit.error
                    ? `Graph announcement unavailable (${lsp.featureBit.error}) — share your URI directly instead.`
                    : "Graph announcement pending…"}
              </p>
              <div className="dryrun-banner warn" style={{ marginTop: 10 }}>{CLEARNET_WARNING}</div>
              <p className="muted">
                Optional clearnet address (host:port, with port 9735 forwarded on your router). A DDNS
                name is re-resolved hourly and kept announced across node restarts and IP changes:
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
            </>
          ) : null}
        </details>
      ) : null}

      <h3 className="sub">About</h3>
      <div className="apply-row">
        <span className="muted">
          Lightning Mate <strong>{formatVersion(version) || "version unknown"}</strong>
        </span>
        <button
          className="reset"
          onClick={() => {
            setDiagError(null);
            api.diagnosticsDownload().catch((e) => setDiagError(e instanceof Error ? e.message : String(e)));
          }}
        >
          Download diagnostics
        </button>
        <span className="muted small">for support — no keys or secrets</span>
      </div>
      {diagError ? <p className="banner error">{diagError}</p> : null}
    </section>

    <BackupCard />
    </>
  );
}
