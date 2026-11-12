import { Fragment, useEffect, useState } from "react";
import { COPY_FAILED, copyText } from "../clipboard";
import { api } from "../api";
import { pageHidden } from "../usePolledData";
import type { AppSettings, FiatCurrency, LspStatus, PrivacyInfo } from "../types";
import { LSP_LIMITS_NOTE, lspBuyerGuide, lspIgnoredLine, lspReachText, lspRecoveryLine } from "../lspView";
import { destinationLine, privacySummary } from "../privacyView";
import { BackupCard } from "./BackupCard";
import { Fold } from "./Fold";
import { AmbossConnect, type AmbossCardState } from "./AmbossConnect";
import { SignMessage } from "./SignMessage";
import { LspActivity } from "./LspActivity";
import { Switch, RunState } from "./Switch";
import { useUi } from "./Overlay";
import { satsCompact, timeAgo } from "../format";
import { formatVersion } from "../version";

const CURRENCIES: { value: FiatCurrency; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "USD", label: "USD $" },
  { value: "EUR", label: "EUR €" },
  { value: "GBP", label: "GBP £" },
  { value: "CHF", label: "CHF" },
];

/** The few words the app can't do without. */
export const GLOSSARY: [string, string][] = [
  ["sat", "The smallest unit of bitcoin: 100,000,000 sat are 1 BTC."],
  ["Channel", "Coins locked between your node and one other, so payments between you are instant. Opening and closing one costs an on-chain fee."],
  ["Your side, their side", "Who holds a channel's coins right now. You can send what is on your side (outbound) and receive what is on theirs (inbound)."],
  ["Forward", "A payment between two others that passes through your node, for a small fee."],
  ["ppm", "Parts per million, how routing fees are written: 1,000 ppm is 0.1 % of the amount."],
  ["Refill (rebalance)", "Paying yourself across the network, to move coins back to the side of a channel that ran out."],
  ["Peer", "A node you are connected to, or have a channel with."],
  ["Offer, lease", "An offer sells channels on Amboss Magma. A lease is how long you promise to keep a sold channel open."],
  ["HTLC", "One payment in flight through a channel. Max HTLC is the largest one a channel says it can take."],
  ["On-chain", "Your normal bitcoin wallet on this node, as opposed to the coins in channels."],
];

/** The sections a link can open Settings at (`goTo("settings", section)`). */
export type SettingsSection = "amboss" | "sign" | "privacy" | "sessions" | "lsp";

export function SettingsPanel({ onChange, version, initialSection }: { onChange: () => void; version?: string; initialSection?: string }) {
  const [diagError, setDiagError] = useState<string | null>(null);
  const ui = useUi();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  // Write mode read (or its read failed): what the signing parts show is
  // settled.
  const [writeKnown, setWriteKnown] = useState(false);
  // The Amboss card: read yet, and its steps (with their own signing box) open?
  const [amboss, setAmboss] = useState<AmbossCardState>({ ready: false, steps: false });
  // Opened from a link ("Connect Amboss", "Settings → Privacy"): at that
  // section, marked for a moment, the keyboard's focus there (review
  // 2026-11-10, SET-4). Once the parts above it have read what they show —
  // before, the Amboss card grew after the scroll and pushed Privacy and LSP
  // mode off the screen (review of P10, F1).
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!initialSection || scrolled || !amboss.ready || !writeKnown) return;
    setScrolled(true);
    const el = typeof document !== "undefined" && typeof document.getElementById === "function" ? document.getElementById(`set-${initialSection}`) : null;
    if (!el) return;
    const still = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
    el.focus?.({ preventScroll: true });
    el.classList?.add("flash");
    const t = setTimeout(() => el.classList?.remove("flash"), 1700);
    return () => clearTimeout(t);
  }, [amboss.ready, writeKnown]);

  // Where the app's own lookups go (Privacy).
  const [privacy, setPrivacy] = useState<PrivacyInfo | null>(null);
  const loadPrivacy = () => api.privacy().then(setPrivacy).catch(() => setPrivacy(null));
  // Sessions (only where a login is required): end every sign-in (SEC-9).
  const [authRequired, setAuthRequired] = useState(false);
  const signOutEverywhere = async () => {
    const yes = await ui.confirm({
      title: "Sign out everywhere",
      message: "Every device signed in to LightningMate must sign in again with the app password — this one too.",
      confirmLabel: "Sign out everywhere",
    });
    if (!yes) return;
    try {
      await api.authRevokeAll();
      api.logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void loadPrivacy();
    api
      .authStatus()
      .then((s) => setAuthRequired(s.authRequired))
      .catch(() => undefined);
    api.getSettings().then(setSettings).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // Write mode: what signing can do, said before the click (SET-3).
    api
      .autopilotGet()
      .then((a) => setCanWrite(a.canWrite))
      .catch(() => setCanWrite(null))
      .finally(() => setWriteKnown(true));
  }, []);

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

  const savePrivacy = async (patch: { lnplusLookups?: boolean; nodeLookups?: boolean }) => {
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

  const copyUri = async (uri: string) => {
    if (!(await copyText(uri))) {
      ui.toast(COPY_FAILED, "error");
      return;
    }
    setUriCopied(true);
    setTimeout(() => setUriCopied(false), 1500);
  };

  // Ready-to-share buyer instructions — the practical discovery channel while
  // graph crawlers catch up on the feature bit.
  const [guideCopied, setGuideCopied] = useState(false);
  // The node's .onion URI: LSP mode is Tor-only, a buyer reaches it with no
  // port opened anywhere. (Else whatever LND announces.)
  const preferredUri = (l: LspStatus) =>
    l.uris.find((u) => u.includes(".onion")) ?? l.uris[0] ?? l.pubkey;

  const copyBuyerGuide = async () => {
    if (!lsp) return;
    if (!(await copyText(lspBuyerGuide(preferredUri(lsp))))) {
      ui.toast(COPY_FAILED, "error");
      return;
    }
    setGuideCopied(true);
    setTimeout(() => setGuideCopied(false), 1500);
  };

  return (
    <>
    <section className="panel">
      <div className="panel-head"><h2>Settings</h2></div>

      {/* Each section shows its switches and its state; what explains them
          is one click away (2026-10-24: the page ran to 815 words). Amboss
          first: what most people come here for (SET-2). */}
      <div id="set-amboss" className="set-target" tabIndex={-1}>
        <h3 className="sub">Amboss — needed to sell and buy channels on Magma</h3>
        <AmbossConnect canWrite={canWrite} onState={setAmboss} />
      </div>

      <div id="set-sign" className="set-target" tabIndex={-1}>
        <h3 className="sub">Sign a message with your node</h3>
        {amboss.steps ? (
          // One signing box at a time: step 1 above has it (review of P10, F5).
          <p className="muted">For Amboss&apos;s login, step 1 above signs right there; for any other challenge too.</p>
        ) : (
          <>
            <p className="muted">For Amboss&apos;s “Login with Node” — again whenever you log in there — or any other challenge.</p>
            <SignMessage canWrite={canWrite} placeholder="Message to sign (e.g. Amboss's amboss-… challenge)" />
          </>
        )}
      </div>

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

      <h3 className="sub set-target" id="set-privacy" tabIndex={-1}>
        Privacy
      </h3>
      {privacy ? (
        <>
          {/* Without a proxy every lookup leaves from the home IP: a warning. */}
          {privacy.torProxy ? (
            <p className="muted">{privacySummary(privacy)}</p>
          ) : privacy.torProxyFault ? (
            <p className="banner error">{privacySummary(privacy)}</p>
          ) : (
            <div className="dryrun-banner">{privacySummary(privacy)}</div>
          )}
          <div className="amboss-row set-toggle" style={{ marginTop: 10 }}>
            <Switch
              checked={privacy.lnplusLookups}
              disabled={busy}
              onChange={(v) => void savePrivacy({ lnplusLookups: v })}
              label="LN+ lookups"
            />
            <span className="muted">LN+ lookups: peer reputations from lightningnetwork.plus, for any node whose details you open too — your node's own key included</span>
          </div>
          <div className="amboss-row set-toggle" style={{ marginTop: 10 }}>
            <Switch
              checked={privacy.nodeLookups}
              disabled={busy}
              onChange={(v) => void savePrivacy({ nodeLookups: v })}
              label="Public node records"
            />
            <span className="muted">Public node records: where a node runs and since when, from mempool.space — one node, only when you open its details.</span>
          </div>
          <details className="set-more">
            <summary>Where each lookup goes</summary>
            <p className="muted small">Route in force since the app started: {privacy.route}.</p>
            <ul className="close-aside">
              {privacy.destinations.map((d) => (
                <li key={`${d.service}:${d.what}`}>{destinationLine(d)}</li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="muted">Loading…</p>
      )}

      {authRequired ? (
        <>
          <h3 className="sub set-target" id="set-sessions" tabIndex={-1}>
            Sessions
          </h3>
          <div className="amboss-row">
            <span className="muted">A sign-in lasts 12 hours on each device. Sign out everywhere ends every one at once — this one too.</span>
            <button className="row-btn" disabled={busy} onClick={() => void signOutEverywhere()}>
              Sign out everywhere
            </button>
          </div>
        </>
      ) : null}

      <h3 className="sub set-target" id="set-lsp" tabIndex={-1}>
        LSP mode (experimental)
      </h3>
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
      {/* Write mode off with LSP orders paid before: said whatever the switch says (with it on, LspActivity says it). */}
      {lsp && !lsp.canWrite && lsp.lastError && !settings?.lspModeEnabled ? <p className="banner error">{lsp.lastError}</p> : null}
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
          <p className="muted">{LSP_LIMITS_NOTE}</p>
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
        </>
      ) : null}
      {lsp ? (
        <details className="set-more">
          <summary>{settings?.lspModeEnabled ? "Who can order, and the graph announcement" : "How it works, and who can order"}</summary>
          <p className="muted">
            Inbound channels sold directly to wallets speaking the open LSP standard (LSPS1 / bLIP-51) over Lightning
            peer messages, with no marketplace in between. Orders are priced by the same engine as Magma selling; the
            buyer pays a hold invoice that only settles once the channel is opening, so failures refund automatically.
            Needs write mode (admin macaroon).
          </p>
          {/* Who can order here — before the mode is switched on, too. */}
          <p className="muted">{lspReachText(lsp.uris)}</p>
          {settings?.lspModeEnabled ? (
            <p className="muted">
              {lsp.featureBit.set
                ? "Announcing LSP support in the node graph (feature bit 729) — explorers and wallets can discover you."
                : lsp.featureBit.error
                  ? `Graph announcement unavailable (${lsp.featureBit.error}) — share your URI directly instead.`
                  : "Graph announcement pending…"}
            </p>
          ) : null}
        </details>
      ) : null}

      <Fold id="words" title="What the words mean">
        <dl className="node-facts glossary">
          {GLOSSARY.map(([word, meaning]) => (
            <Fragment key={word}>
              <dt>{word}</dt>
              <dd>{meaning}</dd>
            </Fragment>
          ))}
        </dl>
      </Fold>

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
