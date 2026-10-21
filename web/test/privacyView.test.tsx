/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * Settings → Privacy (review a3-channels:lnplus-clearnet-lookups, package P4):
 * where LightningMate's own lookups go and by which route, said plainly — and
 * no more "the only outbound request it makes" for the price lookup.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOR_ROUTES, destinationLine, lnplusDirectNote, privacySummary } from "../src/privacyView";
import type { PrivacyInfo } from "../src/types";

const info = (o: Partial<PrivacyInfo> = {}): PrivacyInfo => ({
  torProxy: null,
  torRoute: "lookups",
  lnplusLookups: true,
  destinations: [
    { service: "Amboss public market data (api.amboss.space, magma.amboss.tech)", what: "Magma market data", active: true, viaTor: false },
    { service: "lightningnetwork.plus", what: "node reputations — your own node's public key included", active: true, viaTor: false },
    { service: "mempool.space", what: "the BTC price, only while a fiat currency is chosen", active: false, viaTor: false },
  ],
  ...o,
});

test("without a Tor proxy the card says the lookups leave from the home IP; with one, what goes through Tor on the chosen route", () => {
  assert.match(privacySummary(info()), /^Your node is Tor-only, but LightningMate's own lookups are not the node's: no Tor proxy is available to this app, so they leave from this server's internet connection — your home IP address\./);
  assert.match(
    privacySummary(info({ torProxy: "10.21.21.11:9050" })),
    /^Umbrel's Tor proxy is available \(10\.21\.21\.11:9050\)\. LN\+, the BTC price and Amboss's public market data \(your node's own seller score included\) go through Tor\./,
  );
  // Review of P4: the default's reason ("Amboss knows your account anyway") was
  // false for a node with no Amboss key — whose keyless lookups went direct.
  assert.match(privacySummary(info({ torProxy: "10.21.21.11:9050" })), /Amboss calls made with your API key and the service-fee lookup go direct: those Amboss calls act for your account/);
  assert.match(privacySummary(info({ torProxy: "10.21.21.11:9050", torRoute: "all" })), /Amboss calls made with your API key and the service-fee lookup go through Tor too/);
  assert.deepEqual(TOR_ROUTES.map((r) => r.id), ["lookups", "all", "direct"]);
  assert.equal(
    destinationLine(info().destinations[1]),
    "lightningnetwork.plus — node reputations — your own node's public key included: direct, from this server's IP address",
  );
  assert.equal(destinationLine({ ...info().destinations[1], viaTor: true }), "lightningnetwork.plus — node reputations — your own node's public key included: through Tor");
  assert.match(destinationLine(info().destinations[2]), /: not used now$/);
});

test("Settings no longer calls the price lookup 'the only outbound request', has the LN+ switch, and the LN+ views stop asking LN+ when it is off", () => {
  const settings = readFileSync(new URL("../src/components/SettingsPanel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(settings, /the only outbound/);
  assert.match(settings, /label="LN\+ lookups"/);
  assert.match(settings, /savePrivacy\(\{ lnplusLookups: v \}\)/);
  assert.match(settings, /savePrivacy\(\{ torRoute: r\.id \}\)/);
  const lnplus = readFileSync(new URL("../src/components/LnPlusPanel.tsx", import.meta.url), "utf8");
  assert.match(lnplus, /if \(!statusLoaded \|\| off\) return;/);
  assert.match(lnplus, /LN\+ lookups are switched off \(Settings → Privacy\): nothing is asked of lightningnetwork\.plus/);
});

// Review 2 of P4: the security policy still promised "Nothing else leaves
// your node" — with LN+ on by default (the node's own public key included),
// Amboss's market data fetched without a key, and no word of Tor.
test("SECURITY.md says what the Privacy card says: LN+ on by default with the node's own key, Amboss with or without a key, the routes by the card's own names — and no 'Nothing else leaves your node'", () => {
  const security = readFileSync(new URL("../../SECURITY.md", import.meta.url), "utf8");
  const flat = security.replace(/\s+/g, " ");
  assert.doesNotMatch(flat, /Nothing else leaves your node/);
  assert.doesNotMatch(flat, /Minimal outbound traffic/);
  assert.match(flat, /LN\+ \(lightningnetwork\.plus\)\*\*: .*this node's own public key\. LN\+ lookups are \*\*on by default\*\*; switch them off under Settings → Privacy \("LN\+ lookups"\)/);
  assert.match(flat, /\*\*Amboss\*\*: public Magma market data from api\.amboss\.space .*\*\*with or without an Amboss API key\*\*/);
  assert.match(flat, /\*\*mempool\.space\*\*: the BTC price, only while a fiat currency is chosen/);
  assert.match(flat, /service-fee lightning address\*\*: an LNURL-pay lookup/);
  assert.match(flat, /`TOR_PROXY_IP` \/ `TOR_PROXY_PORT`/);
  assert.match(flat, /LN\+, the price lookup and Amboss's public market data \(this node's own seller score included\) go through Tor by default/);
  assert.match(flat, /The Amboss calls made with your API key and the LNURL lookup go through Tor only with "Everything via Tor"/);
  assert.match(flat, /by the autopilot's runs, the Market pages and the Overview's lease benchmark — and never carries the key/);
  assert.match(flat, /\*\*Without the proxy\*\*, every one of them leaves from this server's internet connection, which is your home IP address\./);
  // The routes by the names the Settings card gives them.
  for (const r of TOR_ROUTES) assert.ok(flat.includes(`"${r.label}"`), `SECURITY.md names the route "${r.label}"`);
});

// The server names the route when a Tor-routed lookup fails (http.ts torVia):
// by the labels this card gives the routes.
test("the server's failure notes name the routes by the card's labels", () => {
  const http = readFileSync(new URL("../../server/src/services/http.ts", import.meta.url), "utf8");
  for (const id of ["lookups", "all"] as const) {
    const label = TOR_ROUTES.find((r) => r.id === id)?.label ?? "";
    assert.ok(http.includes(`"${label}"`), `http.ts names "${label}"`);
  }
});

// Review of P4: the LN+ panel said "no Tor proxy" whenever its lookups went
// direct — also when Umbrel's proxy is there and the route is "Direct".
test("the LN+ panel says why its lookups go direct: no proxy, or the route set to Direct", () => {
  assert.equal(lnplusDirectNote({ viaTor: true, torProxy: true }), null);
  assert.equal(lnplusDirectNote({ viaTor: false, torProxy: false }), "LN+ lookups leave from this server's IP address (no Tor proxy — see Settings → Privacy).");
  assert.equal(
    lnplusDirectNote({ viaTor: false, torProxy: true }),
    "LN+ lookups leave from this server's IP address: the Tor route is set to Direct (Settings → Privacy).",
  );
  const panel = readFileSync(new URL("../src/components/LnPlusPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /\{lnplusDirectNote\(status\)\}/);
  assert.doesNotMatch(panel, /no Tor proxy — see Settings/);
});
