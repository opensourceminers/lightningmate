/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * Settings → Privacy (review a3-channels:lnplus-clearnet-lookups, package P4):
 * where LightningMate's own lookups go, said plainly — every one through Tor
 * since 0.8.5 — and no more "the only outbound request it makes" for the
 * price lookup.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { destinationLine, lnplusDirectNote, privacySummary } from "../src/privacyView";
import type { PrivacyInfo } from "../src/types";

const info = (o: Partial<PrivacyInfo> = {}): PrivacyInfo => ({
  torProxy: null,
  torProxyFault: null,
  route: "direct",
  lnplusLookups: true,
  nodeLookups: true,
  destinations: [
    { service: "Amboss public market data (api.amboss.space, magma.amboss.tech)", what: "Magma market data", active: true, viaTor: false },
    { service: "lightningnetwork.plus", what: "node reputations — your own node's public key included", active: true, viaTor: false },
    { service: "mempool.space", what: "the BTC price, only while a fiat currency is chosen", active: false, viaTor: false },
  ],
  ...o,
});

test("without a Tor proxy the card says the lookups leave from the home IP; with one, that every lookup goes through it", () => {
  assert.match(
    privacySummary(info()),
    /^No Tor proxy is given to this app \(TOR_PROXY_IP \/ TOR_PROXY_PORT are not set\), so LightningMate's own lookups leave from this server's internet connection — your home IP address\./,
  );
  // SEC-1: a proxy value given and unusable is named — not "no proxy".
  assert.match(
    privacySummary(info({ torProxyFault: 'TOR_PROXY_PORT "90 50" is no port number (1–65535)' })),
    /^The Tor proxy setting is faulty: TOR_PROXY_PORT "90 50" is no port number \(1–65535\)\. Until it is fixed \(TOR_PROXY_IP \/ TOR_PROXY_PORT in the app's environment\), LightningMate's own lookups leave from this server's internet connection/,
  );
  // 0.8.5: Tor-only — the Amboss calls made with the API key and the
  // service-fee lookup too (up to 0.8.4 they went direct by default).
  assert.equal(
    privacySummary(info({ torProxy: "10.21.21.11:9050" })),
    "Every lookup goes through Umbrel's Tor proxy (10.21.21.11:9050) — none leaves from this server's IP address.",
  );
  assert.equal(
    destinationLine(info().destinations[1]),
    "lightningnetwork.plus — node reputations — your own node's public key included: direct, from this server's IP address",
  );
  assert.equal(destinationLine({ ...info().destinations[1], viaTor: true }), "lightningnetwork.plus — node reputations — your own node's public key included: through Tor");
  assert.match(destinationLine(info().destinations[2]), /: not used now$/);
});

test("Settings no longer calls the price lookup 'the only outbound request', has the LN+ switch — and no route around Tor — and the LN+ views stop asking LN+ when it is off", () => {
  const settings = readFileSync(new URL("../src/components/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(settings, /the only outbound/);
  assert.match(settings, /label="LN\+ lookups"/);
  assert.match(settings, /savePrivacy\(\{ lnplusLookups: v \}\)/);
  assert.doesNotMatch(settings, /torRoute|TOR_ROUTES|Everything via Tor|Lookups via Tor/, "every lookup goes through Tor: nothing to choose");
  const lnplus = readFileSync(new URL("../src/components/LnPlusPanel.tsx", import.meta.url), "utf8");
  assert.match(lnplus, /if \(!statusLoaded \|\| off\) return;/);
  assert.match(lnplus, /LN\+ lookups are switched off \(<SettingsLink section="privacy">Settings → Privacy<\/SettingsLink>\): nothing is asked of\s+lightningnetwork\.plus/);
});

// Review 2 of P4: the security policy still promised "Nothing else leaves
// your node" — with LN+ on by default (the node's own public key included),
// Amboss's market data fetched without a key, and no word of Tor.
test("SECURITY.md says what the Privacy card says: LN+ on by default with the node's own key, Amboss with or without a key, every lookup through Tor with no route around it — and no 'Nothing else leaves your node'", () => {
  const security = readFileSync(new URL("../../SECURITY.md", import.meta.url), "utf8");
  const flat = security.replace(/\s+/g, " ");
  assert.doesNotMatch(flat, /Nothing else leaves your node/);
  assert.doesNotMatch(flat, /Minimal outbound traffic/);
  assert.match(flat, /LN\+ \(lightningnetwork\.plus\)\*\*: .*this node's own public key\. LN\+ lookups are \*\*on by default\*\*; switch them off under Settings → Privacy \("LN\+ lookups"\)/);
  assert.match(flat, /\*\*Amboss\*\*: public Magma market data from api\.amboss\.space .*\*\*with or without an Amboss key\*\*/);
  assert.match(flat, /\*\*mempool\.space\*\*: the BTC price, only while a fiat currency is chosen/);
  assert.match(flat, /service-fee lightning address\*\*: an LNURL-pay lookup/);
  assert.match(flat, /`TOR_PROXY_IP` \/ `TOR_PROXY_PORT`/);
  assert.match(flat, /\*\*With the proxy\*\* \(every Umbrel install\), every one of them goes through Tor: LN\+, the price lookup, Amboss's public market data \(this node's own seller score included\), the Amboss calls made with your Amboss key and the LNURL lookup\. None leaves from your home IP address, and none needs a port opened on your router\./);
  assert.match(flat, /No setting routes them around Tor/);
  assert.match(flat, /by the autopilot's runs, the Market pages and the Overview's lease benchmark — and never carries the key/);
  assert.match(flat, /\*\*Without the proxy\*\* \(outside Umbrel\), every one of them leaves from this server's internet connection, which is your home IP address/);
  // No route names: there is no route to choose.
  assert.doesNotMatch(flat, /"Lookups via Tor"|"Everything via Tor"/);
});

// The server's failure notes named the route setting ("Lookups via Tor") —
// there is none any more: a lookup that failed through Tor says only that.
test("the server's failure notes name no route setting: there is none", () => {
  const http = readFileSync(new URL("../../server/src/services/http.ts", import.meta.url), "utf8");
  const torVia = /export function torVia\(\): string \{[\s\S]*?\n\}/.exec(http)?.[0];
  assert.equal(torVia, 'export function torVia(): string {\n  return viaTor() ? " through Tor" : "";\n}');
});

// Review of P4: the LN+ panel said "no Tor proxy" whenever its lookups went
// direct — then also when Umbrel's proxy was there and the route "Direct".
// With every lookup through Tor, only a missing proxy sends them direct.
test("the LN+ panel says why its lookups go direct: the app has no Tor proxy", () => {
  assert.equal(lnplusDirectNote({ viaTor: true }), null);
  assert.equal(lnplusDirectNote({ viaTor: false }), "LN+ lookups leave from this server's IP address (no Tor proxy).");
  const panel = readFileSync(new URL("../src/components/LnPlusPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\{lnplusDirectNote\(status\)\}/);
  assert.doesNotMatch(panel, /no Tor proxy — see Settings/);
});

test("SEC-10: an LN+ link goes into an href only as LN+'s own https page — a javascript: URL or another host becomes LN+'s start page", async () => {
  const { lnplusHref } = await import("../src/format");
  assert.equal(lnplusHref("https://lightningnetwork.plus/nodes/02ab"), "https://lightningnetwork.plus/nodes/02ab");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "http://lightningnetwork.plus/nodes/x", "https://lightningnetwork.plus.evil.example/", "https://user@lightningnetwork.plus/", "//evil.example", "", null, 42]) {
    assert.equal(lnplusHref(bad), "https://lightningnetwork.plus/", JSON.stringify(bad));
  }
  // Every LN+ link of the pages goes through it.
  for (const [file, expr] of [
    ["../src/components/NodePanel.tsx", "href={lnplusHref(lnp.profileUrl)}"],
    ["../src/components/LnPlusPanel.tsx", "href={lnplusHref(s.url)}"],
    ["../src/components/SuggestionsPanel.tsx", "href={lnplusHref(s.lnplus.profileUrl)}"],
  ] as const) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.ok(src.includes(expr), `${file}: ${expr}`);
    assert.doesNotMatch(src, /href=\{[^}]*(profileUrl|s\.url)\}/, `${file}: no LN+ link unchecked`);
  }
});

test("SEC-1/SEC-9 in Settings: a faulty proxy setting is an error banner, the route in force is said, and 'Sign out everywhere' ends every session where a login is required", () => {
  const src = readFileSync(new URL("../src/components/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.match(src, /privacy\.torProxyFault \? \(\n\s+<p className="banner error">\{privacySummary\(privacy\)\}<\/p>/);
  assert.match(src, /Route in force since the app started: \{privacy\.route\}\./);
  assert.match(src, /\{authRequired \? \(\n\s+<>\n\s+<h3 className="sub set-target" id="set-sessions" tabIndex=\{-1\}>\s+Sessions\s+<\/h3>/);
  assert.match(src, /await api\.authRevokeAll\(\);\n\s+api\.logout\(\);/, "the server ends them, then this page signs out");
  const client = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.match(client, /authRevokeAll: \(\) => post<AuthRevokeResult>\("\/auth\/revoke", \{\}\)/);
});
