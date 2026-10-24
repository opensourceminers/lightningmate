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
  lnplusLookups: true,
  destinations: [
    { service: "Amboss public market data (api.amboss.space, magma.amboss.tech)", what: "Magma market data", active: true, viaTor: false },
    { service: "lightningnetwork.plus", what: "node reputations — your own node's public key included", active: true, viaTor: false },
    { service: "mempool.space", what: "the BTC price, only while a fiat currency is chosen", active: false, viaTor: false },
  ],
  ...o,
});

test("without a Tor proxy the card says the lookups leave from the home IP; with one, that every lookup goes through it", () => {
  assert.match(privacySummary(info()), /^Your node is Tor-only, but LightningMate's own lookups are not the node's: no Tor proxy is available to this app, so they leave from this server's internet connection — your home IP address\./);
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
  assert.match(lnplus, /LN\+ lookups are switched off \(Settings → Privacy\): nothing is asked of lightningnetwork\.plus/);
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
  assert.match(flat, /\*\*Amboss\*\*: public Magma market data from api\.amboss\.space .*\*\*with or without an Amboss API key\*\*/);
  assert.match(flat, /\*\*mempool\.space\*\*: the BTC price, only while a fiat currency is chosen/);
  assert.match(flat, /service-fee lightning address\*\*: an LNURL-pay lookup/);
  assert.match(flat, /`TOR_PROXY_IP` \/ `TOR_PROXY_PORT`/);
  assert.match(flat, /\*\*With the proxy\*\* \(every Umbrel install\), every one of them goes through Tor: LN\+, the price lookup, Amboss's public market data \(this node's own seller score included\), the Amboss calls made with your API key and the LNURL lookup\. None leaves from your home IP address, and none needs a port opened on your router\./);
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
  assert.equal(lnplusDirectNote({ viaTor: false }), "LN+ lookups leave from this server's IP address (no Tor proxy — see Settings → Privacy).");
  const panel = readFileSync(new URL("../src/components/LnPlusPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\{lnplusDirectNote\(status\)\}/);
  assert.doesNotMatch(panel, /no Tor proxy — see Settings/);
});
