/**
 * Settings can be found, and connecting Amboss is one guided path (review
 * 2026-11-10, P10 — othervice, 2026-11-11: entering the key and signing for
 * the Amboss login were hidden). The card in its three states, signing with
 * and without write mode, Settings' order and words, the gear's word, and
 * every "in Settings" place leading there.
 */
import "./helpers/browserGlobals";
import { all, button, newContainer, propsOf, settle, type El } from "./helpers/fakeDom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { ApiError } from "../src/apiError";
import { setNavHandler } from "../src/nav";
import { OverlayProvider } from "../src/components/Overlay";
import { AMBOSS_KEYS_URL, AmbossConnect } from "../src/components/AmbossConnect";
import { SIGN_NEEDS_WRITE, SignMessage } from "../src/components/SignMessage";
import { ConnectAmbossButton, SettingsLink } from "../src/components/SettingsLink";
import { setupDestination, setupLines } from "../src/setupView";

/* eslint-disable @typescript-eslint/no-explicit-any */
const a = api as Record<string, any>;
const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

async function mount(el: ReturnType<typeof h>) {
  const c = newContainer();
  const root = createRoot(c as unknown as Element);
  root.render(h(OverlayProvider, null, el));
  await settle();
  return { c, root };
}
const click = async (el: El | undefined, what: string) => {
  assert.ok(el, `${what} is on the page`);
  assert.notEqual(propsOf(el).disabled, true, `${what} is not disabled`);
  propsOf(el).onClick({ stopPropagation() {} });
  await settle();
};
const typeInto = async (el: El | undefined, value: string, what: string) => {
  assert.ok(el, `${what} is on the page`);
  propsOf(el).onChange({ target: { value } });
  await settle();
};
const status = (o: Record<string, unknown> = {}) => async () => ({
  connected: false,
  keyValid: null,
  keyCheck: "unknown",
  lastError: null,
  saleFeeBps: 100,
  ordersInFlight: 0,
  ...o,
});

test("SET-2, no key: three steps in order — log in with the node (sign right here), make a key at Amboss, paste it and connect; checked by Amboss, then the steps give way to its state", async () => {
  a.ambossStatus = status();
  const signed: string[] = [];
  a.signMessage = async (m: string) => {
    signed.push(m);
    return { signature: "d9a1f0signature" };
  };
  const connected: string[] = [];
  a.ambossConnect = async (k: string) => {
    connected.push(k);
    return { ok: true, connected: true };
  };
  const { c, root } = await mount(h(AmbossConnect, { canWrite: true }));
  const steps = all(c).filter((n) => n.nodeName === "LI");
  assert.equal(steps.length, 3);
  assert.match(steps[0]!.textContent, /^Log in at Amboss with your node\. Open account\.amboss\.tech → Settings → API keys; when Amboss asks you to log in, choose your Lightning node\./);
  assert.match(steps[1]!.textContent, /^Make a key there\. On that page create a key and copy it\. If it offers an expiry, choose the longest/);
  assert.match(steps[2]!.textContent, /^Paste the key here\./);
  assert.ok(all(steps[0]!).some((n) => n.nodeName === "A" && propsOf(n).href === AMBOSS_KEYS_URL), "where keys are made, and the login");
  assert.equal(propsOf(all(steps[0]!).find((n) => n.nodeName === "TEXTAREA")!)["aria-label"], "Amboss's message to sign");
  // Step 1: sign Amboss's message here, copy the signature.
  await typeInto(all(steps[0]!).find((n) => n.nodeName === "TEXTAREA"), "  amboss-challenge-1  ", "the message box");
  await click(button(c, "Sign with node"), "Sign with node");
  assert.deepEqual(signed, ["amboss-challenge-1"]);
  assert.match(c.textContent, /d9a1f0signature/);
  assert.ok(button(c, "Copy"), "the signature can be copied");
  // Step 3: paste the key, connect.
  const key = all(steps[2]!).find((n) => n.nodeName === "INPUT");
  assert.equal(propsOf(key!).type, "password");
  await typeInto(key, " sk_live_key ", "the key");
  await click(button(c, "Connect"), "Connect");
  assert.deepEqual(connected, ["sk_live_key"]);
  assert.match(c.textContent, /Amboss connected · key valid/);
  assert.equal(all(c).filter((n) => n.nodeName === "LI").length, 0, "the steps are done");
  root.unmount();
});

test("SET-2, key ok: its state, Re-check is not needed, Remove is there — no steps", async () => {
  a.ambossStatus = status({ connected: true, keyValid: true, keyCheck: "valid" });
  const { c, root } = await mount(h(AmbossConnect, { canWrite: true }));
  assert.match(c.textContent, /Amboss connected · key valid/);
  assert.ok(button(c, "Disconnect"));
  assert.equal(all(c).filter((n) => n.nodeName === "LI").length, 0);
  root.unmount();
});

test("SET-2, key rejected: said so, and a fresh key goes in right here — replacing the old one without removing it first", async () => {
  a.ambossStatus = status({ connected: true, keyValid: false, keyCheck: "rejected" });
  const connected: string[] = [];
  a.ambossConnect = async (k: string) => {
    connected.push(k);
    return { ok: true, connected: true };
  };
  const { c, root } = await mount(h(AmbossConnect, { canWrite: true }));
  assert.match(c.textContent, /Amboss rejected your key/);
  assert.match(c.textContent, /Make a fresh key at Amboss and connect it below: it replaces the rejected one\./);
  assert.match(c.textContent, /Paste the fresh key here\./);
  await typeInto(all(c).find((n) => n.nodeName === "INPUT" && propsOf(n).type === "password"), "sk_fresh", "the key");
  await click(button(c, "Connect"), "Connect");
  assert.deepEqual(connected, ["sk_fresh"]);
  assert.match(c.textContent, /Amboss connected · key valid/);
  root.unmount();
});

test("SET-2: a key Amboss refuses at Connect is said, and nothing changes; Amboss unreachable keeps the stored key and shows no steps", async () => {
  a.ambossStatus = status();
  a.ambossConnect = async () => {
    throw new ApiError("Amboss rejected this key. Make a fresh one at account.amboss.tech → Settings → API keys and paste it again.", 400, { error: "invalid_key" });
  };
  const { c, root } = await mount(h(AmbossConnect, { canWrite: true }));
  await typeInto(all(c).find((n) => n.nodeName === "INPUT"), "sk_bad", "the key");
  await click(button(c, "Connect"), "Connect");
  assert.match(c.textContent, /Amboss rejected this key\. Make a fresh one/);
  assert.equal(all(c).filter((n) => n.nodeName === "LI").length, 3, "the steps stay");
  root.unmount();
  a.ambossStatus = status({ connected: true, keyValid: true, keyCheck: "unreachable", lastError: "Amboss unreachable: timeout" });
  const down = await mount(h(AmbossConnect, { canWrite: true }));
  assert.match(down.c.textContent, /Amboss unreachable — retrying/);
  assert.equal(all(down.c).filter((n) => n.nodeName === "LI").length, 0);
  down.root.unmount();
});

test("SET-3: without write mode signing says before the click that it can't, and how else — no box to fill in for nothing; step 1 says to sign on the node", async () => {
  const { c, root } = await mount(h(SignMessage, { canWrite: false }));
  assert.equal(c.textContent, `${SIGN_NEEDS_WRITE} Sign the message on the node itself and paste that signature at Amboss: lncli signmessage "<the message>"`);
  assert.match(SIGN_NEEDS_WRITE, /^Signing here needs write mode \(the admin macaroon\)/);
  assert.ok(all(c).some((n) => n.nodeName === "CODE" && /^lncli signmessage/.test(n.textContent)), "the command as code");
  assert.equal(all(c).filter((n) => n.nodeName === "TEXTAREA").length, 0);
  root.unmount();
  a.ambossStatus = status();
  const card = await mount(h(AmbossConnect, { canWrite: false }));
  const first = all(card.c).filter((n) => n.nodeName === "LI")[0]!;
  assert.match(first.textContent, /\(it starts with amboss-\): sign it on the node and paste the signature back at Amboss\. Already logged in\? Go on to step 2\./);
  assert.doesNotMatch(first.textContent, /paste it here, sign it/);
  card.root.unmount();
});

test("SET-2 (review F3): a key rejected at the last check while Amboss can't be reached now — said as rejected, Remove offered, the steps open, orders in flight warned", async () => {
  a.ambossStatus = status({ connected: true, keyValid: false, keyCheck: "unreachable", lastError: "Amboss unreachable: timeout", ordersInFlight: 2 });
  const { c, root } = await mount(h(AmbossConnect, { canWrite: true }));
  assert.match(c.textContent, /Amboss rejected your key at the last check \(expired or revoked\)/);
  assert.doesNotMatch(c.textContent, /resume once Amboss answers/);
  assert.ok(button(c, "Remove key"));
  assert.match(c.textContent, /2 Magma orders are in flight/);
  assert.equal(all(c).filter((n) => n.nodeName === "LI").length, 3);
  assert.match(c.textContent, /Amboss can't be reached right now, so a fresh key is taken once it answers/);
  root.unmount();
});

test("SET-2 (review F6): a key state that can't be read is said as that — never as 'no key, three steps' — and read again on Try again", async () => {
  let fail = true;
  a.ambossStatus = async () => {
    if (fail) throw new Error("LightningMate isn't answering");
    return (await status({ connected: true, keyValid: true, keyCheck: "valid" })());
  };
  const { c, root } = await mount(h(AmbossConnect, { canWrite: true }));
  assert.match(c.textContent, /Couldn't read your Amboss key's state \(LightningMate isn't answering\)\. Try again/);
  assert.equal(all(c).filter((n) => n.nodeName === "LI").length, 0, "no steps on a guess");
  assert.doesNotMatch(c.textContent, /need your Amboss key/);
  fail = false;
  await click(button(c, "Try again"), "Try again");
  assert.match(c.textContent, /Amboss connected · key valid/);
  root.unmount();
});

test("SET-2: removing the key — the count of orders in flight read again, a confirmation that says it, and then the steps", async () => {
  let reads = 0;
  a.ambossStatus = async () => {
    reads += 1;
    return (await status({ connected: true, keyValid: true, keyCheck: "valid", ordersInFlight: reads === 1 ? 0 : 1 })());
  };
  let removed = 0;
  a.ambossDisconnect = async () => {
    removed += 1;
    return { ok: true, connected: false };
  };
  const { c, root } = await mount(h(AmbossConnect, { canWrite: true }));
  await click(button(c, "Disconnect"), "Disconnect");
  assert.equal(reads, 2, "read again before asking");
  assert.match(c.textContent, /Remove the Amboss key\? Orders are in flight/);
  assert.equal(removed, 0, "nothing removed before the yes");
  // A no keeps the key.
  await click(button(c, "Cancel"), "the dialog's Cancel");
  assert.equal(removed, 0, "kept on a no");
  assert.match(c.textContent, /Amboss connected · key valid/);
  await click(button(c, "Disconnect"), "Disconnect");
  await click(button(c, "Remove key"), "the dialog's Remove key");
  assert.equal(removed, 1);
  assert.equal(all(c).filter((n) => n.nodeName === "LI").length, 3, "the steps to connect one again");
  root.unmount();
});

test("SET-1/SET-3/SET-5 in Settings: Amboss first with its purpose in the heading, signing its own open section, the words 'Amboss key'", () => {
  const s = src("../src/components/SettingsPanel.tsx");
  const amboss = s.indexOf('<h3 className="sub">Amboss — needed to sell and buy channels on Magma</h3>');
  const sign = s.indexOf('<h3 className="sub">Sign a message with your node</h3>');
  const fiat = s.indexOf('<h3 className="sub">Fiat currency</h3>');
  assert.ok(amboss > 0 && amboss < sign && sign < fiat, "Amboss, then signing, then the rest");
  assert.doesNotMatch(s, /<summary>Sign a message<\/summary>/, "no closed fold");
  assert.match(s, /<SignMessage canWrite=\{canWrite\}/);
  for (const id of ["set-amboss", "set-sign", "set-privacy", "set-sessions", "set-lsp"]) assert.match(s, new RegExp(`id="${id}"( className="set-target")? tabIndex=\\{-1\\}`), id);
  for (const file of ["AmbossConnect", "MarketSell", "MarketBuy", "MarketOrders", "SetupWizard", "AmbossKeyStatus"]) {
    assert.doesNotMatch(src(`../src/components/${file}.tsx`), /Amboss API key|your API key/, `${file}: "Amboss key"`);
  }
  assert.doesNotMatch(src("../src/statusNotes.ts"), /Amboss API key/);
  for (const file of ["SettingsPanel", "AmbossConnect"]) assert.doesNotMatch(src(`../src/components/${file}.tsx`), /Liquidity provision/i);
});

test("SET-1: the way into Settings carries its word; on a phone the gear alone, 40 px", () => {
  const app = src("../src/App.tsx");
  assert.match(app, /<TabIcon id="settings" \/>\n\s+<span className="gear-word">Settings<\/span>/);
  const css = src("../src/styles.css");
  assert.match(css, /\.gear \{[^}]*color: var\(--text\);/, "text colour, not muted");
  assert.match(css, /@media \(max-width: 760px\) \{\n\s+\.gear \{ width: 40px; height: 40px;[^}]*\}\n\s+\.gear-word \{ display: none; \}/);
});

test("SET-4: every 'in Settings' leads there — the link opens Settings at its section", async () => {
  const went: [string, string | undefined][] = [];
  setNavHandler((tab, sub) => went.push([tab, sub]));
  const { c, root } = await mount(
    h("div", null, h(ConnectAmbossButton, null), h(SettingsLink, { section: "privacy", children: "Settings → Privacy" }), h(SettingsLink, { section: "lsp", children: "LSP mode in Settings" })),
  );
  await click(button(c, "Connect Amboss"), "Connect Amboss");
  await click(button(c, "Settings → Privacy"), "Settings → Privacy");
  await click(button(c, "LSP mode in Settings"), "LSP mode in Settings");
  assert.deepEqual(went, [
    ["settings", "amboss"],
    ["settings", "privacy"],
    ["settings", "lsp"],
  ]);
  setNavHandler(null);
  root.unmount();
  // Where: Market → Sell, → Buy and → Orders without a key, a rejected key on Sell, the Autopilot's Selling row and
  // status, the LN+ and node panels' privacy notes, the pause note with LSP mode on — and Settings opens there.
  assert.match(src("../src/components/MarketSell.tsx"), /To create offers, connect your Amboss key — three steps, all in Settings\.<\/span>\n\s+<ConnectAmbossButton \/>/);
  assert.match(src("../src/components/MarketSell.tsx"), /<SettingsLink section="amboss">Connect a fresh key<\/SettingsLink>/);
  assert.match(src("../src/components/MarketBuy.tsx"), /To buy, <SettingsLink section="amboss">connect your Amboss key<\/SettingsLink>/);
  assert.match(src("../src/components/MarketOrders.tsx"), /<ConnectAmbossButton \/>/);
  const ap = src("../src/components/AutopilotPanel.tsx");
  assert.match(ap, /status\?\.needs === "amboss_key" \? <ConnectAmbossButton small \/> : null/);
  assert.match(ap, /config\[a\.field\] && !isOpen && status\?\.\[a\.area\]\?\.needs === "amboss_key" \? <ConnectAmbossButton small \/> : null/);
  assert.match(ap, /<SettingsLink section="lsp">LSP mode in Settings<\/SettingsLink>/);
  assert.match(src("../src/components/LnPlusPanel.tsx"), /<SettingsLink section="privacy">Settings → Privacy<\/SettingsLink>/);
  const app = src("../src/App.tsx");
  assert.match(app, /<SettingsPanel key=\{subKey\} onChange=\{price\.refresh\} version=\{version\} initialSection=\{pendingSub\} \/>/);

});

test("SET-4 (review F1/F5/F9): Settings rendered — opened at a section it scrolls there and focuses it once the Amboss card has read its state; one signing box at a time", async () => {
  let answerAmboss: (v: unknown) => void = () => undefined;
  a.ambossStatus = () => new Promise((r) => (answerAmboss = r));
  a.autopilotGet = async () => ({ canWrite: false, config: {} });
  a.privacy = async () => ({ torProxy: "10.21.21.11:9050", torProxyFault: null, route: "through Tor", lnplusLookups: true, nodeLookups: true, destinations: [] });
  a.getSettings = async () => ({ fiatCurrency: "off", lspModeEnabled: false, lnplusLookups: true, nodeLookups: true, setupDone: true });
  a.lspStatus = async () => ({ enabled: false, canWrite: false, uris: [], pubkey: "02", orders: [] });
  a.authStatus = async () => ({ authRequired: false, unlocked: true });
  a.backupStatus = async () => ({ lastExportAt: null, channelsNow: 0, channelsAtExport: null });
  const { SettingsPanel } = await import("../src/components/SettingsPanel");
  const c = newContainer();
  const doc = globalThis.document as unknown as Record<string, unknown>;
  const before = doc.getElementById;
  const done: string[] = [];
  doc.getElementById = (id: string) => {
    const n = all(c).find((x) => propsOf(x).id === id);
    if (!n) return null;
    const el = n as unknown as Record<string, unknown>;
    el.scrollIntoView = () => done.push(`scroll:${id}`);
    el.focus = () => done.push(`focus:${id}`);
    el.classList = { add: (k: string) => done.push(`mark:${id}:${k}`), remove: () => undefined };
    return el;
  };
  try {
    const root = createRoot(c as unknown as Element);
    root.render(h(OverlayProvider, null, h(SettingsPanel, { onChange: () => undefined, initialSection: "privacy" })));
    await settle();
    assert.deepEqual(done, [], "not while the Amboss card is still reading (it grows when it answers)");
    answerAmboss(await status()());
    await settle();
    assert.deepEqual(done, ["scroll:set-privacy", "focus:set-privacy", "mark:set-privacy:flash"]);
    // Amboss first, then signing; with the steps open the signing section points at step 1 — one box.
    const text = c.textContent;
    assert.ok(text.indexOf("Amboss — needed to sell and buy channels on Magma") < text.indexOf("Sign a message with your node"));
    assert.match(text, /For Amboss's login, step 1 above signs right there; for any other challenge too\./);
    // Read-only: step 1 says it can't sign here, and how else.
    assert.match(text, /Signing here needs write mode \(the admin macaroon\)/);
    assert.equal(all(c).filter((n) => n.nodeName === "TEXTAREA").length, 0);
    root.unmount();
  } finally {
    doc.getElementById = before;
  }
});

test("SET-4 (review F2): the node details' privacy link closes the details first — they'd else stay over Settings", async () => {
  const went: string[] = [];
  setNavHandler((tab, sub) => went.push(`go:${tab}:${sub}`));
  const { c, root } = await mount(h(SettingsLink, { section: "privacy", onGo: () => went.push("closed"), children: "Settings → Privacy" }));
  await click(button(c, "Settings → Privacy"), "the link");
  assert.deepEqual(went, ["closed", "go:settings:privacy"]);
  setNavHandler(null);
  root.unmount();
  assert.match(src("../src/components/NodePanel.tsx"), /<SettingsLink section="privacy" onGo=\{onClose\}>/);
});

test("SET-4: the first start with selling and no key ends in Settings at Amboss, and its summary says so", () => {
  assert.deepEqual(setupDestination("selling", false), { tab: "settings", section: "amboss" });
  assert.equal(setupDestination("selling", true), null);
  assert.equal(setupDestination("routing", false), null);
  assert.equal(setupDestination("watch", false), null);
  const config = { policy: { minPpm: 1, maxPpm: 2000 }, rebalancePolicy: {}, channelMaxFeeRate: 20 } as never;
  const lines = setupLines({ goal: "selling", openChannels: false, reserveSats: 100_000, sellEverything: true, sellCapSats: NaN } as never, config, false);
  assert.ok(lines.includes("Selling: off for now. After the start, Settings opens at Amboss: connect your key there (three steps), then switch selling on under Autopilot → Selling."));
  assert.match(src("../src/components/SetupWizard.tsx"), /^\s+const dest = setupDestination\(choice\.goal, keyNow\);\n\s+if \(dest\) goTo\(dest\.tab, dest\.section\);$/m);
});
