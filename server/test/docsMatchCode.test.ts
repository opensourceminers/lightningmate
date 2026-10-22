/**
 * The documentation says what the code does (review a8-engineering:docs-
 * packaging-drift): the strategy doc's numbers are the ones the autopilot
 * runs with, its config model is the real one, and the README, SECURITY.md,
 * the release and test procedures and the packaging say what this version
 * does — checked against the code, so they can't drift apart unnoticed again.
 *
 * Before: the strategy doc gave stepPpm 25 and maxChangesPerRun 6 (the
 * autopilot runs 10 and 5), its config model left out half the settings the
 * presets write, SECURITY.md said npm audit was "kept at 0" with 14 findings
 * open, and the in-repo Umbrel compose pinned v0.6.10 under a 0.7.7 manifest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { FEE_REC_DEFAULTS } from "../src/services/feeRecommend.js";
import { DEFAULT_CONFIG } from "../src/services/autopilotConfig.js";
import { DEFAULT_POLICY } from "../src/services/fees.js";
import { LOOPBACK_HOSTS } from "../src/exposure.js";
import { SHUTDOWN_GRACE_MS, SHUTDOWN_WAIT_MS } from "../src/shutdown.js";
import { MANUAL_ACCEPT_SKIP, NOT_REJECTED_ACCEPT_SENT } from "../src/services/magmaDesk.js";
import { autopilotWith } from "./helpers/autopilot.js";
import { quiet } from "./helpers/lifecycle.js";

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
const strategy = read("docs/AUTOPILOT-STRATEGY.md");

test("the strategy doc's fee-engine numbers are the ones the autopilot runs the engine with by default", (t) => {
  quiet(t);
  const { autopilot } = autopilotWith(t, {});
  const effective: Record<string, unknown> = { ...FEE_REC_DEFAULTS, ...autopilot.feeV2Overrides() };
  const block = /\*\*Config \(defaults\):\*\*\n```\n([\s\S]*?)```/.exec(strategy)?.[1];
  assert.ok(block, "the config block");
  const rows = [...block.matchAll(/^(\w+)\s+(\S+)\s+#/gm)].map((m) => [m[1], m[2]] as const);
  assert.ok(rows.length >= 14, `${rows.length} rows`);
  for (const [key, value] of rows) {
    assert.ok(key in effective, `${key}: no such engine setting`);
    assert.equal(String(effective[key]), value, `${key}: the doc says ${value}, the autopilot runs ${String(effective[key])}`);
  }
  // The two the review found wrong.
  assert.deepEqual([effective.stepPpm, effective.maxChangesPerRun], [DEFAULT_POLICY.step, DEFAULT_CONFIG.maxChangesPerRun]);
});

test("the strategy doc's config model names every setting there is — those the presets write included", () => {
  const model = /## 5\. Config model[\s\S]*?```\n([\s\S]*?)```/.exec(strategy)?.[1] ?? "";
  for (const key of [...Object.keys(DEFAULT_CONFIG), ...Object.keys(DEFAULT_POLICY), ...Object.keys(DEFAULT_CONFIG.rebalancePolicy)]) {
    if (key === "policy" || key === "rebalancePolicy") continue;
    assert.match(model, new RegExp(`\\b${key}\\b`), `${key} is missing from the config model`);
  }
  assert.doesNotMatch(strategy, /runMagma/, "the function is runSell");
});

test("the README and SECURITY.md say what the server does about where requests come from — and about dependencies", () => {
  const readme = read("README.md");
  const security = read("SECURITY.md");
  // The Docker recipe publishes on this machine only, settings from
  // --env-file, and keeps the app's state on a volume — mounted where the
  // image keeps it (review of P8: without DATA_DIR on a writable volume the
  // container could not start, and nothing would have survived it).
  const recipe = /^docker run .*$/m.exec(readme)?.[0] ?? "";
  assert.match(recipe, /^docker run -p 127\.0\.0\.1:3001:3001 --env-file \.env -v lightningmate-data:\/data --stop-timeout \d+ lightningmate$/);
  assert.doesNotMatch(readme, /docker run -p 3001:3001/);
  const dataDir = /\bDATA_DIR=(\S+)/.exec(read("Dockerfile"))?.[1];
  assert.equal(/-v [\w.-]+:(\S+)/.exec(recipe)?.[1], dataDir, "the volume is mounted at the image's DATA_DIR");
  assert.match(readme, /named volume `lightningmate-data` holds the app's state/);
  // ...and gives `docker stop` the time the app's shutdown takes. Docker
  // kills a container 10 s after it by default (review of P8, run 2: the
  // recipe set nothing, so a stop during an Amboss call or a channel open
  // ended in the crash path, not in the graceful exit the README promises).
  // The README's numbers are the code's.
  const stopTimeoutS = Number(/--stop-timeout (\d+)/.exec(recipe)?.[1]);
  assert.ok(stopTimeoutS * 1000 >= SHUTDOWN_GRACE_MS, `--stop-timeout ${stopTimeoutS} is shorter than the app's ${SHUTDOWN_GRACE_MS / 1000} s shutdown`);
  const prose = readme.replace(/\s+/g, " ");
  assert.match(prose, new RegExp(`# --stop-timeout ${stopTimeoutS}: Docker kills a container 10 s after \`docker stop\` by default; # the app takes up to ${SHUTDOWN_GRACE_MS / 1000} s to let work under way finish and save its state`));
  assert.match(prose, new RegExp(`up to ${SHUTDOWN_WAIT_MS / 1000} seconds to finish`), "the wait for work under way");
  assert.match(prose, new RegExp(`exits, within ${SHUTDOWN_GRACE_MS / 1000} seconds of the signal: hence the recipe's \`--stop-timeout ${stopTimeoutS}\``));
  // P4: the Amboss lease listing is asked again when the kept copy is over an hour old — not "hourly".
  assert.doesNotMatch(readme, /asked again hourly/);
  assert.match(readme, /ask\s+Amboss for it again only when the copy is over an hour old/);
  // The cross-site defence, as SECURITY.md documents it.
  assert.match(security, /Sec-Fetch-Site:\s+cross-site/);
  assert.match(security, /every POST must be JSON/);
  assert.match(security, /the address the API is bound to \(`LM_BIND`\)/);
  assert.match(readme, /takes\s+every POST as JSON only/);
  // Without a login, the Host names served are the code's loopback names and
  // the bound address — in both docs (review of P8, final round: the README
  // left out ::1).
  const hostsIn = (doc: string, sentence: RegExp): string[] =>
    [...(sentence.exec(doc.replace(/\s+/g, " "))?.[1] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
  const loopback = [...LOOPBACK_HOSTS].sort();
  assert.deepEqual(hostsIn(readme, /serves only requests for (.*?) or the address it is bound to/), loopback, "README");
  assert.deepEqual(hostsIn(security, /only requests for (.*?) or the address the API is bound to/), loopback, "SECURITY.md");
  // No claim the build doesn't back.
  assert.doesNotMatch(security, /kept at 0 known vulnerabilities/);
  assert.match(security, /npm audit --omit=dev --audit-level=high/);
  assert.match(security, /## Release integrity/);
});

test("the release process says how the stores' compose changes at the next release — the Tor proxy lines — and that images are immutable", () => {
  const releasing = read("docs/RELEASING.md");
  assert.match(releasing, /TOR_PROXY_IP: "\$TOR_PROXY_IP"/);
  assert.match(releasing, /TOR_PROXY_PORT: "\$TOR_PROXY_PORT"/);
  assert.match(releasing, /next release/);
  assert.match(releasing, /Images are immutable/);
  assert.match(releasing, /imagetools inspect/);
  // The packaging compose has them already, beside the disclosed service fee.
  const compose = read("packaging/umbrel/lightningmate/docker-compose.yml");
  assert.match(compose, /TOR_PROXY_IP: "\$TOR_PROXY_IP"/);
  assert.match(compose, /LM_SELL_FEE_BPS: "100"/);
  // Its stop grace outlasts the app's shutdown, as the README's recipe's
  // --stop-timeout does (compose's default is Docker's 10 s).
  const grace = /^\s*stop_grace_period:\s*"?((?:\d+(?:ms|h|m|s))+)"?\s*$/m.exec(compose)?.[1] ?? "";
  const unitMs: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  const graceMs = [...grace.matchAll(/(\d+)(ms|h|m|s)/g)].reduce((sum, [, n, unit]) => sum + Number(n) * unitMs[unit], 0);
  assert.ok(graceMs >= SHUTDOWN_GRACE_MS, `stop_grace_period ${grace || "(none)"} is shorter than the app's ${SHUTDOWN_GRACE_MS / 1000} s shutdown`);
  // One pin, tag AND digest, and the manifest's version is that tag's.
  const pin = /image: ghcr\.io\/opensourceminers\/lightningmate:v(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}/.exec(compose);
  assert.ok(pin, "the image is pinned by tag and digest");
  const manifest = read("packaging/umbrel/lightningmate/umbrel-app.yml");
  assert.equal(/^version: "([^"]+)"/m.exec(manifest)?.[1], pin[1], "umbrel-app.yml's version is the image's");
  assert.doesNotMatch(read("packaging/umbrel/SUBMISSION.md"), /init container/);
});

// Review of P8, round 3: the checklist said to merge any base-image bump
// Dependabot opened — one onto another Node major too, with CI still on 22.
test("the release checklist keeps the base image on the Node major CI tests — a new major is a change of its own, made together with CI's", () => {
  const major = /^[ \t]*node-version:[ \t]*["']?(\d+)/m.exec(read(".github/workflows/ci.yml"))?.[1];
  assert.ok(major, "ci.yml's node-version");
  const releasing = read("docs/RELEASING.md");
  const step = (/^2\. \*\*Base image\*\*([\s\S]*?)^\d+\. /m.exec(releasing)?.[1] ?? "").replace(/\s+/g, " ");
  assert.match(step, new RegExp(`the current \`node:${major}\\.x\\.y-alpine\` digest`), "the digest to take is of CI's major");
  assert.match(step, new RegExp(`A routine bump stays on Node ${major}, the major CI tests`));
  assert.match(step, /Dependabot is set not to propose another major/);
  assert.match(step, /A new Node major is not a release step but a change of its own: the Dockerfile's `FROM` lines and CI's `node-version` move together/);
});

// Review of P8: wording the code no longer backed — the capital guards placed
// in a function that no longer has them, a crash withdrawal said of every
// accept (a click's goes out), and the executor's fitted size said of the
// autopilot's run (its budget backstop holds such a move back first).
test("the docs place the capital guards, the accept withdrawal and the fitted refill size where the code has them", () => {
  const lsp = read("docs/LSP-MODE.md");
  assert.doesNotMatch(lsp, /autopilot\.runSell/);
  assert.match(lsp, /\| Capital guards [^|]*\| [^|]*`capital\.ts`[^|]*`magmaDesk\.ts`/);
  const security = read("SECURITY.md");
  assert.match(security, /the order lane's own\s+accept that never left is withdrawn/);
  assert.match(strategy, /the lane's own accept that never left is withdrawn/);
  for (const doc of [security, strategy]) assert.doesNotMatch(doc, /(an|one) accept that never\s+left is withdrawn|one that never left is withdrawn/);
  assert.match(strategy, /\*\*manual\*\* refill does the same when it runs/);
  assert.doesNotMatch(strategy, /executor does the same with the plan's route cost/);
  // Round 2: the audit log said it of the executor too (in German), and the
  // near-deadline reject of an accept that couldn't be marked is a running
  // lane's — a paused lane rejects nothing on its own.
  const audit = read("docs/ALGO-AUDIT.md");
  assert.doesNotMatch(audit, /der Executor tut dasselbe mit dem Routenpreis des Plans/);
  assert.match(audit, /Ein \*\*manueller\*\* Refill \(POST \/rebalance\/execute\) tut dasselbe/);
  assert.match(audit, /im Lauf des Autopiloten[^.]*Budget-Sperre/i);
  for (const doc of [security, strategy]) {
    assert.match(doc, /mark\s+can't be saved[^.]*decided again — a running\s+lane rejects it[^.]*; a paused lane\s+leaves it to the\s+operator/);
    assert.doesNotMatch(doc, /decided again (\(rejected|— rejected)/);
  }
});

// Review of P8: the manifest had taken over the official store's `finance`
// (the owner decided on `bitcoin`) and the published 0.7.7 notes, whose "size
// decides whether a buyer can be matched" D19 disproved — RELEASING.md says
// to copy this folder into the next PR.
test("the store manifest here is the next release's: category bitcoin, and release notes without the disproven size claims — the release process says to set the category, and why", () => {
  const manifest = read("packaging/umbrel/lightningmate/umbrel-app.yml");
  assert.match(manifest, /^category: bitcoin$/m);
  const notes = manifest.slice(manifest.indexOf("\nreleaseNotes:"), manifest.indexOf("\ndeveloper:"));
  assert.ok(notes.length > 200, "the notes");
  for (const claim of [
    /size decides whether a buyer can be matched/i,
    /size window/i,
    /% of real (Magma )?orders/i,
    /would unlock/i,
    /share of real Magma orders you\s+can serve/i,
  ]) {
    assert.doesNotMatch(notes, claim);
  }
  assert.match(notes, /Amboss decides which\s+seller gets an order/, "who decides, said plainly (D11)");
  const releasing = read("docs/RELEASING.md");
  assert.match(releasing, /set `category: bitcoin`/);
  assert.match(releasing, /say why in the\s+PR body/);
});

// Review of P8, final round: the docs said only that a manual reject raises
// no alert — while the lane could accept an order whose reject by hand
// failed, or turn down one whose accept by hand failed. The code now carries
// out the operator's decision (magmaByHand.test.ts); the docs say so, and
// quote the reason the Orders tab shows as the code words it.
test("the docs say a decision made by hand wins over the Magma order lane, for an order the lane isn't working on — a reject Amboss didn't confirm is sent again, an accept that didn't go through leaves the order to the operator, a click mid-step waits, and an accept already sent is completed first", () => {
  const prose = (doc: string) => doc.replace(/\s+/g, " ");
  const readme = prose(read("README.md"));
  const security = prose(read("SECURITY.md"));
  const strategyProse = prose(strategy);
  const desk = read("server/src/services/magmaDesk.ts");
  for (const [name, doc] of [["README.md", readme], ["SECURITY.md", security], ["AUTOPILOT-STRATEGY.md", strategyProse]] as const) {
    // Review of P9, round 3: "always wins" — while a click that comes as the
    // lane is deciding or acting on that same order waits for that step (one
    // action per order at a time), and finds the order accepted or rejected:
    // refused (magmaByHand.test.ts pins it). The docs claim it for an order
    // the lane isn't working on, and say what happens to the other clicks.
    assert.doesNotMatch(doc, /always wins/, name);
    assert.match(doc, /decision (you make|made) by hand (on Market → Orders )?wins over the (lane|autopilot), for an order the \3 isn't working on at that moment/, name);
    const steps = /A click that arrives while the (lane|autopilot) is already deciding or acting on that same order — ([^—]+) — waits for that step to finish/.exec(doc)?.[2] ?? "";
    assert.ok(steps, `${name}: a click that comes while the lane is working on the order waits for that step`);
    for (const step of [/capital/, /(dialing|dial of) the buyer \(up to about a minute and a half over Tor\)/, /its own accept or reject/, /earlier reject of (yours|the operator's)/]) {
      assert.match(steps, step, `${name}: the steps a click waits for`);
    }
    // Review of P9, final round: a click that finds the order as it asked —
    // rejected by the lane's resend of the operator's own reject, accepted
    // by the lane — is told it is done, not refused; only one asking for the
    // other is refused (magmaByHand.test.ts pins both).
    assert.match(
      doc,
      /if the order was accepted or rejected meanwhile, the click says so — done, if that is what it asked for \("Order is already accepted\.", "Order is already rejected\."\); refused, if it asked for the other \("Order is /,
      name,
    );
    // What the refused click says, as the code words it (the status is the
    // order's own, read once the click has its turn).
    for (const [, said] of doc.matchAll(/"(Order is [A-Z_]+[^"]*)"/g)) {
      const template = said.replace(/^Order is [A-Z_]+/, () => "Order is ${order.status}");
      assert.ok(desk.includes(`message: \`${template}`), `${name} quotes "${said}" — no click says that (magmaDesk.ts)`);
    }
    // ...and what the other answers say, word for word.
    for (const [, said] of doc.matchAll(/"((?:Order is already (?:accepted|rejected)|Not rejected:)[^"]*)"/g)) {
      assert.ok(desk.includes(`"${said}"`), `${name} quotes "${said}" — no click says that (magmaDesk.ts)`);
    }
    // Review of P9, final round: "makes the order yours, whatever becomes of
    // the click", "their latest click stands" — while an accept already sent
    // whose answer was lost ("accepting") is completed first, the lane's or
    // the operator's, and a Reject meanwhile is refused, though Amboss still
    // shows the order awaiting approval (magmaByHand.test.ts pins it). Each
    // doc says so, quoting the refusal as the code words it, and every such
    // claim is qualified in its own sentence.
    assert.match(
      doc,
      /an accept already sent whose answer was lost \([^)]*"accepting[^)]*\), (yours|the operator's) or the (lane's|autopilot's): an accept that may have reached Amboss is completed first/,
      name,
    );
    const refused = /a Reject meanwhile is refused \("(Not rejected: [^"]*)"\), though Amboss may still show the order awaiting approval/.exec(doc)?.[1];
    assert.equal(refused, NOT_REJECTED_ACCEPT_SENT, `${name}: the refusal, as the click words it`);
    for (const [claim] of doc.matchAll(/(whatever becomes of the click|their latest click stands)[^.]*/g)) {
      assert.match(claim, /except for an accept already sent whose answer was lost/, `${name}: "${claim.slice(0, 60)}…" is qualified`);
    }
    assert.match(doc, /reject Amboss didn't confirm (\(an error, a refusal\) )?is sent again/, name);
    // Review of P9, round 2: "a click on Accept or Reject makes the order
    // yours, whatever becomes of the click" — while a click that couldn't
    // read the order recorded nothing. It now takes an order the lane has on
    // record as awaiting approval (unreadClick, magmaByHand.test.ts); any
    // other is still left as it was, and the docs say so.
    assert.doesNotMatch(doc, /a click on Accept or Reject makes the order/, name);
    assert.match(doc, /(click that finds neither \(Amboss or LND not answering\)|otherwise it) records nothing/, name);
    assert.match(doc, /with Liquidity provision on, the (lane|autopilot) may decide that order/, name);
  }
  // The desk's own account of it (its header comment) claims no more than
  // the docs.
  const deskComments = prose(desk.replace(/^\s*\* ?/gm, ""));
  assert.doesNotMatch(deskComments, /always wins/, "magmaDesk.ts");
  assert.match(deskComments, /wins over the lane \(byHand\): .* That holds for an order the lane isn't working on when the click comes\./, "magmaDesk.ts");
  // Review of P9, final round: the header and byHand's own account of the
  // rule state its exception too.
  assert.match(
    deskComments,
    /Nor does a click take back an accept already sent whose answer was lost \("accepting"\), the lane's or the operator's: an accept that may have reached Amboss is completed first, and a Reject meanwhile is refused, saying why\./,
    "magmaDesk.ts",
  );
  const byHandDoc = prose((/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*private byHand\(/.exec(desk)?.[1] ?? "").replace(/^\s*\* ?/gm, ""));
  assert.match(
    byHandDoc,
    /their latest click is what stands: .* an accept already sent whose answer was lost \("accepting"\), the lane's or theirs: an accept that may have reached Amboss is completed first \(resumeAccept\), and a Reject meanwhile is refused/,
    "byHand's docblock",
  );
  // Review of P9, final round: the lane's resend of the operator's reject,
  // once Amboss confirmed it, read as "Last change by the autopilot".
  assert.match(
    strategyProse,
    /The lane carrying out the operator's decision \(their reject sent again, their accept completed\) is recorded as theirs \(the run history's `via: "manual"`\): the Overview's "Last change by the autopilot" leaves it out\./,
  );
  assert.match(
    readme,
    /A click that can't read the order \(Amboss or LND not answering\) counts too once the autopilot has the order on record as awaiting your decision/,
  );
  for (const [name, doc] of [["SECURITY.md", security], ["AUTOPILOT-STRATEGY.md", strategyProse]] as const) {
    assert.match(
      doc,
      /a click on Accept or Reject that finds the order — Amboss shows it as this node's, awaiting approval, or the lane has it on record as awaiting approval( \([^)]*\))? — makes the order (yours|the operator's), whatever becomes of the click/,
      name,
    );
  }
  assert.match(strategyProse, /the lane never accepts that order/);
  // Review of P9: with selling off, the resend waited for a read of the order
  // that worked; it no longer does (magmaByHand.test.ts).
  assert.match(strategyProse, /whatever the selling switch says and even while Amboss won't show the order/);
  const quoted = /\("(your accept didn't go through)"\)/.exec(strategyProse)?.[1] ?? "";
  assert.ok(quoted && MANUAL_ACCEPT_SKIP.startsWith(quoted), `the strategy doc quotes "${quoted}" — the Orders tab shows "${MANUAL_ACCEPT_SKIP}"`);
  assert.match(prose(read("docs/E2E-TESTING.md")), /the lane sends the reject again on its next pass — selling on or off — and never accepts the order/);
});

test("the manual end-to-end procedures cover the two paths no automated test can: Magma selling with a second node (the hold invoice's amount included) and an LSPS1 buy from ZEUS's embedded node over Tor", () => {
  const e2e = read("docs/E2E-TESTING.md");
  assert.match(e2e, /## A\. Magma selling with a second node/);
  assert.match(e2e, /`fees\.seller` read \*\*0\*\*/);
  assert.match(e2e, /\*\*`fees\.fixed \+ fees\.variable`\*\* \(`magmaDesk\.invoiceMsat`\)/);
  assert.match(e2e, /## B\. LSPS1 buy from ZEUS's embedded node over Tor/);
  assert.match(e2e, /embedded Tor switched on/);
  assert.match(read("docs/LSP-MODE.md"), /\[E2E-TESTING\.md\]\(E2E-TESTING\.md\), part B/);
});

// ── the least-privilege write macaroon ───────────────────────────────────────

/** Every lightning function the server imports (type imports aside), with
 *  the permissions the library documents for it ("Requires `x:y`, `…`
 *  permission" in the function's own doc comment). */
function lightningPermissions(): Map<string, string[]> {
  const src = fileURLToPath(new URL("../src", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
  const used = new Set<string>();
  for (const file of files(src)) {
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "lightning") continue;
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
      for (const el of clause.namedBindings.elements) if (!el.isTypeOnly) used.add((el.propertyName ?? el.name).text);
    }
  }
  // Each function lives in lnd_methods/<area>/<snake_case>.js.
  const methods = join(dirname(createRequire(import.meta.url).resolve("lightning")), "lnd_methods");
  const modules = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith(".js")) modules.set(n.slice(0, -3), p);
    }
  };
  walk(methods);
  const out = new Map<string, string[]>();
  for (const fn of used) {
    if (fn === "authenticatedLndGrpc") continue; // builds the client: no RPC of its own
    const file = modules.get(fn.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase());
    assert.ok(file, `${fn}: not found in the lightning library's methods`);
    const doc = /Requires\s+((?:`[a-z]+:[a-z]+`(?:,\s*|\s+and\s+)?)+)\s*permission/.exec(readFileSync(file, "utf8"));
    assert.ok(doc, `${fn}: the library documents no permission for it`);
    out.set(fn, doc[1].match(/[a-z]+:[a-z]+/g) ?? []);
  }
  return out;
}

// Review of P8, final round: the recipe left out peers:read, which every
// open's connect check needs — LND's ListPeers, on the write client (the
// lightning library's addPeer lists the peers too, right after it dials).
// With a macaroon baked from it, every open said the peer looked offline and
// every Magma order was turned down as "the buyer's node is unreachable".
test("SECURITY.md's least-privilege macaroon holds every permission the code's LND calls need — peers:read included — and nothing more but the optional message signing", () => {
  const security = read("SECURITY.md");
  const recipe = /lncli bakemacaroon \\\n([\s\S]*?)--save_to/.exec(security)?.[1] ?? "";
  const granted = [...new Set(recipe.match(/\b[a-z]+:[a-z]+\b/g) ?? [])].sort();
  assert.ok(granted.length > 0, "the bakemacaroon command");
  const calls = lightningPermissions();
  assert.ok(calls.size > 30, `${calls.size} lightning calls`);
  assert.deepEqual(calls.get("getPeers"), ["peers:read"], "the connect check's listing");
  assert.deepEqual(calls.get("signMessage"), ["message:write"]);
  // The read client's calls need only :read permissions the write client
  // needs as well (it reads invoices, the wallet, channels and peers too),
  // so the union is the write macaroon's set — but message signing, which
  // only the optional sign-in helper uses: the doc says to add it for that.
  const needed = [...new Set([...calls.values()].flat())].filter((p) => p !== "message:write").sort();
  assert.deepEqual(granted, needed, "the recipe grants what the calls need, and only that");
  assert.ok(granted.includes("peers:read"));
  assert.match(security, /`peers:read` is needed by every channel open/);
  assert.match(security, /the lightning library's addPeer does the same/);
  assert.match(security, /message signing, which the macaroon above omits/);
  // The strategy doc's "blocked" names it too.
  assert.match(strategy.replace(/\s+/g, " "), /a write macaroon without `peers:read`, which every open needs to check its peer's connection/);
  // LSP mode's card says why it turns new orders away, in the words the docs
  // quote (lspView.lspBlockedLine) — while it listens, too (review of P8,
  // run 2: the reason sat in lastError, which the card shows only while the
  // listener is down, and a macaroon without peers:read still listens).
  assert.match(read("web/src/lspView.ts"), /`New orders are turned away: \$\{s\.blocked\}`/);
  assert.match(security.replace(/\s+/g, " "), /LSP mode takes no new order, its Settings card saying why/);
  for (const doc of ["docs/LSP-MODE.md", "docs/E2E-TESTING.md"]) {
    assert.match(read(doc).replace(/\s+/g, " "), /"New orders are turned away:? …/, `${doc} quotes the card`);
  }
  // And the README's credential table says what config.ts reads: the read
  // macaroon only reads — write mode takes a macaroon of its own (it said
  // to put admin.macaroon into LND_MACAROON "for write mode", which stays
  // read-only).
  const readme = read("README.md");
  const config = read("server/src/config.ts");
  assert.doesNotMatch(readme, /admin\.macaroon` for write mode/);
  assert.match(readme, /\| `LND_WRITE_MACAROON` \| write mode only \(with `LM_ENABLE_WRITE=true`\)/);
  for (const env of ["LND_WRITE_MACAROON", "LND_WRITE_MACAROON_PATH", "LM_ENABLE_WRITE"]) assert.match(config, new RegExp(`process\\.env\\.${env}\\b`), env);
});
