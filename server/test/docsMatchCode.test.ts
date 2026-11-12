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
import { SHUTDOWN_GRACE_MS } from "../src/shutdown.js";
import {
  ACCEPT_BEAT_REJECT,
  AMBOSS_LEASES_MAX_AGE_MS,
  BUYER_DIALS,
  CANCEL_MARGIN_BLOCKS,
  CLOSE_ASKED_RETRY_MS,
  HODL_CLTV_DELTA,
  HODL_EXPIRY_MS,
  LEGACY_FEE_WAIT_RESERVE_MS,
  LEGACY_OPEN_RETRY_MS,
  MANUAL_ACCEPT_SKIP,
  NO_PAYMENT_WAIT,
  OPEN_MIN_BLOCKS_LEFT,
  OPEN_RETRY_MIN_TIME_LEFT_MS,
  PAYMENT_OVERDUE_MS,
  OPEN_RETRY_WINDOW_MS,
  SOLD_CLOSE_MIN_LOCAL_SHARE,
  SOLD_KEEP_BAR_TEXT,
  UNPAID_OPEN_RESERVE_MS,
  AMBOSS_OPEN_WINDOW_MS,
} from "../src/services/magmaDesk.js";
import { ANSWERS_KEPT } from "../src/services/magmaJournal.js";
import { MAGMA_LEASE_MARGIN_BLOCKS } from "../src/services/leaseCaps.js";
import { SOLD_CHANNEL_KEEP_PPM_YEAR, URGENT_OPEN_CONF_TARGET } from "../src/services/autopilot.js";
import { OPEN_TX_VBYTES } from "../src/services/nodeEconomics.js";
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
  // P4: the Amboss lease listing is asked again when the kept copy is over an hour old — not
  // "hourly". The README is short now; the strategy doc says it.
  const strategy = read("docs/AUTOPILOT-STRATEGY.md");
  assert.equal(AMBOSS_LEASES_MAX_AGE_MS, 3_600_000);
  assert.doesNotMatch(strategy, /asked again hourly/);
  assert.match(strategy, /ask\s+Amboss for it again only when the copy is over an hour old/);
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
test("the docs say a decision made by hand wins over the Magma order lane, for an order the lane isn't working on — a reject Amboss didn't confirm is sent again, an accept that didn't go through leaves the order to the operator, a click mid-step waits, and a Reject stands against an accept already sent that Amboss never confirmed", () => {
  const prose = (doc: string) => doc.replace(/\s+/g, " ");
  // The README is short now and leaves this to the two docs below.
  const security = prose(read("SECURITY.md"));
  const strategyProse = prose(strategy);
  const desk = read("server/src/services/magmaDesk.ts");
  for (const [name, doc] of [["SECURITY.md", security], ["AUTOPILOT-STRATEGY.md", strategyProse]] as const) {
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
    // Review 2026-11-10, LANE-1: until then an accept already sent whose
    // answer was lost ("accepting") was completed first and a Reject of it
    // refused — while an accept Amboss answered with an error was sent again
    // every pass until the order timed out, and could not be rejected by
    // hand. A Reject now goes out and stands; only an accept Amboss turns
    // out to have applied stands against it (magmaAcceptError.test.ts and
    // magmaByHand.test.ts pin it). Each doc says so, quoting the record's
    // reason as the code words it, and no longer states the old exception.
    assert.match(
      doc,
      /also against an accept already sent that Amboss never confirmed \([^)]*"accepting[^)]*\), (yours|the operator's) or the (lane's|autopilot's): a Reject of such an order is sent while Amboss still shows it awaiting approval, and again on every pass, the accept no more; the accept's invoice is released once Amboss confirms the reject\./,
      name,
    );
    const beat = /Only an accept Amboss turns out to have applied stands against it: the order is accepted then, and its record says so \("([^"]*)"\)/.exec(doc)?.[1];
    assert.equal(beat, ACCEPT_BEAT_REJECT, `${name}: the record's reason, as the code words it`);
    assert.doesNotMatch(doc, /except for an accept already sent|an accept that may have reached Amboss is completed first|a Reject meanwhile is refused/, name);
    // What becomes of an accept Amboss doesn't confirm, with the code's
    // numbers: the refusals after which the lane rejects its own order, and
    // how close to the approval deadline it rejects rather than waits.
    const attempts = Number(/const MAX_ACCEPT_ATTEMPTS = (\d+);/.exec(desk)?.[1]);
    const marginMin = Number(/const REJECT_MARGIN_MS = (\d+) \* 60_000;/.exec(desk)?.[1]);
    assert.ok(attempts > 0 && marginMin > 0, "the desk's constants");
    assert.match(doc, new RegExp(`the invoice is released[,;] (and after ${attempts} refusals the lane rejects its own order|the lane rejects its own order after ${attempts})`), name);
    assert.match(
      doc,
      new RegExp(`with the approval deadline ${marginMin} minutes off,? the lane rejects its own order whose accept is still unconfirmed rather than let it time out( on the seller)? — the reject first, the invoice released only once Amboss confirms it`, "i"),
      name,
    );
    assert.match(doc, /reject Amboss didn't confirm (\(an error, a refusal\) )?is sent again/, name);
    // Review of P9, round 2: "a click on Accept or Reject makes the order
    // yours, whatever becomes of the click" — while a click that couldn't
    // read the order recorded nothing. It now takes an order the lane has on
    // record as awaiting approval (unreadClick, magmaByHand.test.ts); any
    // other is still left as it was, and the docs say so.
    assert.doesNotMatch(doc, /a click on Accept or Reject makes the order/, name);
    assert.match(doc, /(click that finds neither \(Amboss or LND not answering\)|otherwise it) records nothing/, name);
    assert.match(doc, /with selling on, the (lane|autopilot) may decide that order/, name);
  }
  // The desk's own account of it (its header comment) claims no more than
  // the docs.
  const deskComments = prose(desk.replace(/^\s*\* ?/gm, ""));
  assert.doesNotMatch(deskComments, /always wins/, "magmaDesk.ts");
  assert.match(deskComments, /wins over the lane \(byHand\): .* That holds for an order the lane isn't working on when the click comes\./, "magmaDesk.ts");
  // Review 2026-11-10, LANE-1: the header and byHand's own account of the
  // rule say what the docs say.
  assert.match(
    deskComments,
    /A Reject stands against an accept already sent that Amboss never confirmed \("accepting"\), the lane's or the operator's, too: the reject is sent — again on every pass, the accept no more — and only an accept Amboss turns out to have applied stands against it\./,
    "magmaDesk.ts",
  );
  assert.doesNotMatch(deskComments, /a Reject meanwhile is refused/, "magmaDesk.ts");
  const byHandDoc = prose((/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*private byHand\(/.exec(desk)?.[1] ?? "").replace(/^\s*\* ?/gm, ""));
  assert.match(
    byHandDoc,
    /their latest click is what stands: .* A Reject of an order with an accept already sent that Amboss never confirmed \("accepting"\), the lane's or theirs, stands too: the reject is sent — again on every pass, the accept no more — and the accept's invoice is released once Amboss confirms it \(rejectSentAccept\)\. Only an accept Amboss turns out to have applied stands against it/,
    "byHand's docblock",
  );
  // Review of P9, final round: the lane's resend of the operator's reject,
  // once Amboss confirmed it, read as "Last change by the autopilot".
  assert.match(
    strategyProse,
    /The lane carrying out the operator's decision \(their reject sent again, their accept completed\) is recorded as theirs \(the run history's `via: "manual"`\): the Overview's "Last change by the autopilot" leaves it out\./,
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

test("the docs say how long a paid order's channel may still be opened and what its open may cost — in the code's own numbers", () => {
  // Review 2026-11-10, LANE-2, LANE-4, LANE-6.
  const flat = strategy.replace(/\s+/g, " ");
  const confirm = OPEN_MIN_BLOCKS_LEFT - CANCEL_MARGIN_BLOCKS;
  assert.ok(
    flat.includes(`only while the payment can still be held ${OPEN_MIN_BLOCKS_LEFT} blocks more (${confirm} for the channel to confirm and Amboss to validate it, ${CANCEL_MARGIN_BLOCKS} before the payment is released)`),
    "the open window, in blocks",
  );
  const hours = Math.round(((HODL_CLTV_DELTA - OPEN_MIN_BLOCKS_LEFT) * 10) / 60);
  assert.ok(flat.includes(`about ${hours} hours of the invoice's ${HODL_CLTV_DELTA} blocks`), "how long a buyer is waited for");
  assert.match(flat, /Amboss's `timeout` only where it lies after the payment was held/);
  // Review of the package: the windows in minutes and hours, and the rule
  // for the approval deadline Amboss may leave in `timeout`.
  assert.ok(flat.includes(`a failed open is tried again only while it is more than ${OPEN_RETRY_MIN_TIME_LEFT_MS / 60_000} minutes off`), "the open deadline's margin");
  assert.equal(OPEN_RETRY_MIN_TIME_LEFT_MS, 10 * 60_000);
  assert.ok(flat.includes(`blocks, before: ${OPEN_RETRY_WINDOW_MS / 60_000} minutes — a buyer offline after paying is dialed again`), "what the window was");
  assert.match(flat, /nor is a `timeout` still equal to the one the order showed while it awaited approval \(kept on its record as `approvalDeadline`\)/);
  assert.ok(
    flat.includes(`it is tried for ${LEGACY_OPEN_RETRY_MS / 3_600_000} hours after the payment was found. It waits for lower on-chain fees`),
    "an order paid outside a HODL invoice",
  );
  // othervice's decision of 2026-11-10: such an order waits for lower fees
  // too, and is opened whatever the fee near the end of its hours.
  const reserveHours = LEGACY_FEE_WAIT_RESERVE_MS / 3_600_000;
  assert.ok(
    flat.includes(
      `${reserveHours} hours before those ${LEGACY_OPEN_RETRY_MS / 3_600_000} run out (or before a deadline of Amboss's) the channel is opened whatever the fee, with the ${reserveHours} hours left to reach a buyer`,
    ),
    "when its wait for lower fees ends",
  );
  assert.ok(LEGACY_FEE_WAIT_RESERVE_MS < LEGACY_OPEN_RETRY_MS);
  // Review of the package, second round: what follows those hours, the
  // fallback window and how often a refused open is asked again.
  assert.match(flat, /the order ends with the buyer's payment kept: an alert says so until it is dismissed, and "Open channel" on Market → Orders takes the order up again/);
  assert.ok(flat.includes(`those hours cannot be counted and the window stays ${OPEN_RETRY_WINDOW_MS / 60_000} minutes`), "the fallback window");
  assert.ok(flat.includes(`is asked again every ${BUYER_DIALS.redialMs / 60_000} minutes too, not on every pass`), "a refused open's spacing");
  assert.match(flat, /the lane's status "1 paid order waits for lower on-chain fees", or "… waits for an on-chain fee estimate"/);
  assert.match(flat, /"… — it waited for lower fees until then: …"/);
  // What Amboss answered, on the order's record.
  assert.ok(flat.includes(`(\`amboss\`, the last ${ANSWERS_KEPT}, never the key or an invoice)`), "how many answers are kept");
  assert.ok(flat.includes(`the funding transaction (${OPEN_TX_VBYTES} vB) at that rate costs no more than the order's fee after the service fee`), "the open's limit");
  assert.match(flat, /not capped by `channelMaxFeeRate`/);
  assert.match(flat, /Every paid order refunded with no channel opened raises an alert/);
  // LANE-5: the one paid order the lane opens no channel for.
  assert.match(flat, /LightningMate opens none by itself for a payment it can't see — the order waits for "Open channel"/);
  assert.match(NO_PAYMENT_WAIT, /opens no channel by itself for a payment it can't see: waiting for you to open the channel$/);
  const security = read("SECURITY.md").replace(/\s+/g, " ");
  assert.ok(security.includes(`A channel is opened only while the payment can still be held ${OPEN_MIN_BLOCKS_LEFT} blocks more`));
  assert.match(security, /an open that would cost more on chain than the sale earns/);
  const e2e = read("docs/E2E-TESTING.md").replace(/\s+/g, " ");
  assert.ok(e2e.includes(`If ${OPEN_TX_VBYTES} vB at that rate cost more than the order's fee after the 1 % service fee`));
});

test("the docs and the Auto-close hint say when a sold channel is closed at its lease's end, and when it is kept — in the code's own numbers", () => {
  // Review 2026-11-10, LANE-3, OFFER-9, CHAN-5.
  const flat = strategy.replace(/\s+/g, " ");
  const ppm = SOLD_CHANNEL_KEEP_PPM_YEAR.toLocaleString("en-US");
  assert.equal(SOLD_CLOSE_MIN_LOCAL_SHARE, 0.25, "“a quarter”");
  assert.equal(CLOSE_ASKED_RETRY_MS, 24 * 3_600_000, "“a day later”");
  assert.equal(MAGMA_LEASE_MARGIN_BLOCKS, 144, "“a day” of blocks");
  assert.ok(flat.includes("kept open when under a quarter of it is on our side"));
  assert.ok(flat.includes(`it routes well — over 30 days it earned, on the coins a close would free, at least ${ppm} ppm a year`));
  assert.ok(flat.includes(`the funding block, the order's lease and a day (${MAGMA_LEASE_MARGIN_BLOCKS} blocks) have passed`));
  assert.match(flat, /Amboss's status \(`CHANNEL_MONITORING_FINISHED`\) is not enough/);
  assert.match(flat, /\*\*Auto-close does not need selling on\*\*.*nothing is closed while all automation is paused/);
  assert.match(flat, /while the buyer's node is offline none is asked for/);
  assert.match(flat, /asked again only if the channel is still open a day later/);
  // Review of the package: the maximum binds the rate the close is asked
  // at — not what LND may settle on with the buyer's node.
  assert.match(flat, /the close asked for at LND's economy rate, not while that is above the maximum on-chain fee rate \(`channelMaxFeeRate`\)/);
  assert.match(flat, /LND then finishes the close at its own estimate, which can be above the maximum/);
  assert.match(flat, /whether auto-close was switched off, all automation paused, or the stage given up/);
  // LANE-7: such a channel counts against the deploy cap until closed.
  assert.match(flat, /after the lease with what is still on this node's side of it, until it is closed/);
  // What the order's history says of a channel that routes well.
  assert.ok(SOLD_KEEP_BAR_TEXT.includes(`at least ${ppm} ppm a year`));
  // The web's hint on the switch itself.
  const view = read("web/src/magmaView.ts").replace(/"\s*\+\s*"/g, "");
  const hint = view.slice(view.indexOf("export const AUTO_CLOSE_HINT"));
  assert.ok(hint.includes("while less than a quarter of it is on your side"));
  assert.ok(hint.includes(`at least this node's average and ${ppm} ppm a year`));
  assert.match(hint, /Amboss lists it as finished and, by this node's own count, the funding block, the lease and a day have passed/);
  assert.match(hint, /It also works with selling switched off/);
  assert.match(hint, /nothing is closed while all automation is paused/);
  assert.match(hint, /while the buyer's node is offline \(a force close stays yours to decide, on Channels\)/);
  assert.match(hint, /LND may still finish the close at its own estimate, which can be above that maximum/);
  assert.match(hint, /the order's history on Market → Orders says which, for a sale this app recorded/);
  assert.doesNotMatch(hint.slice(0, hint.indexOf("\n\n")), /never above/);
});

test("the docs say how long an order Amboss reports confirmed waits for its payment, and when an unpaid order's channel is opened", () => {
  // Review 2026-11-10, LANE-8 and LANE-9..13 (Amboss pays after the channel is confirmed).
  const flat = strategy.replace(/\s+/g, " ");
  assert.equal(HODL_EXPIRY_MS, 49 * 3_600_000, "“49 hours after it was made”");
  assert.equal(PAYMENT_OVERDUE_MS, 6 * 3_600_000, "“After 6 hours of waiting an alert names the order”");
  assert.equal(UNPAID_OPEN_RESERVE_MS, 6 * 3_600_000, "“less 6 hours for the channel to get its confirmations”");
  assert.equal(LEGACY_FEE_WAIT_RESERVE_MS, 6 * 3_600_000, "“in its last 6 hours the open is priced at LND's 3-block estimate”");
  assert.equal(URGENT_OPEN_CONF_TARGET, 3, "“at LND's 3-block estimate”");
  assert.match(flat, /the order waits for Amboss's payment \("channel confirmed — waiting for Amboss's payment", said once on its record\) until the invoice runs out, 49 hours after it was made/);
  assert.equal(AMBOSS_OPEN_WINDOW_MS, 48 * 3_600_000, "“with no usable `timeout` … 48 hours after the invoice”");
  assert.equal(PAYMENT_OVERDUE_MS, 6 * 3_600_000);
  assert.match(flat, /After 6 hours of waiting an alert names the order \(not one whose payment is here and whose claim is held up: its record says why\)\. Only when the invoice has expired, or was cancelled, unpaid does the order end here, unbooked/);
  assert.match(flat, /Amboss's `timeout` for the channel \(seen live: 48 hours after the invoice was made; never past the invoice's own end, and with no usable `timeout` — none, not a date, or earlier than the invoice — 48 hours after the invoice\), less 6 hours for the channel to get its confirmations \(half the time there is, when Amboss gives less than 12 hours\): its last moment to open/);
  assert.match(flat, /Up to then a failed open is tried again and high on-chain fees are waited out as above; in its last 6 hours the open is priced at LND's 3-block estimate — or, where that is dearer than the order brings, at the highest rate the order pays for, if that is no less than LND's usual estimate\. Still dearer, or with no estimate at all, at the last moment to open, the order is ended instead of opened/);
  assert.match(flat, /"Open channel" opens it up to its last moment to open, under the same ceiling; after that the lane ends it \(as a click would, saying why\) and the refund is told/);
  assert.doesNotMatch(flat, /up to an hour before Amboss's deadline/);
  assert.match(flat, /\*\*No open costs more than the order brings\*\*/);
  assert.doesNotMatch(flat, /looked at again for an hour/);
});

test("the docs say when a fee that sells is kept, when a higher one is tried and how the try is judged — in the code's own numbers", async () => {
  // Review 2026-11-10, package P3 (its own review, R15: the doc test pinned
  // none of the package's numbers).
  const fee = await import("../src/services/feeRecommend.js");
  const { MAX_HTLC_MIN_INTERVAL_MS } = await import("../src/services/maxHtlc.js");
  const flat = strategy.replace(/\s+/g, " ");
  assert.equal(fee.SELLS_HERE_SALES, 3, "“sold at least three times at the fee it charges now”");
  assert.equal(fee.RAISE_TRIAL_DAYS, 7, "“for 7 days and whatever the channel holds, a fee the autopilot raised to”");
  assert.equal(fee.SPARE_SELL_DAYS, 90, "“more than 90 days at its selling rate”");
  assert.deepEqual([fee.PROBE_WEEK_SALES, fee.PROBE_RECENT_SALES, fee.PROBE_SHARE], [7, 6, 0.1], "“at least 7 sales in the last 7 days … 6 in the last 72 h … a tenth of its fee”");
  assert.equal(fee.PROBE_JUDGE_AFTER_HOURS, 72, "“judged once, 72 h after the raise”");
  assert.deepEqual([fee.CLIMB_CHECK_DAYS, fee.CLIMB_WINDOW_DAYS, fee.CLIMB_CHECK_HOURS], [7, 14, 48], "“at the end of each of the climb's weeks (in force for 48 h) … up to 14”");
  assert.equal(fee.STEP_BACK_AFTER_HOURS, 48, "“A test nothing sells at for 48 h goes back”");
  assert.deepEqual([1, 2, 3].map(fee.stepBackMemoryDays), [7, 14, 28], "“not repeated for 7 days — 14, then 28”");
  assert.equal(MAX_HTLC_MIN_INTERVAL_MS, 6 * 3_600_000, "“at most once in 6 h”");
  assert.match(flat, /A channel that sold at least three times at the fee it charges now, since that fee was set, and at least once in the last 7 days, is not lowered toward a lower aim/);
  assert.match(flat, /covers, for 7 days and whatever the channel holds, a fee the autopilot raised to/);
  assert.match(flat, /would need more than 90 days at its selling rate of the last 14 days/);
  assert.match(flat, /at least 7 sales in the last 7 days, three of them at the fee it charges now, and 6 in the last 72 h, which the fee has stood/);
  assert.match(flat, /one step higher, or a tenth of its fee where that is more\*\* \(rounded down onto the grid, at most to the max; never on a pinned or excluded channel\)/);
  assert.match(flat, /judged once, 72 h after the raise\*\*: what the channel earned in the test's first 72 h against the 72 h before it/);
  assert.match(flat, /at the end of each of the climb's weeks \(in force for 48 h\), what the channel earned in its last days — up to 14 — is set against as many days before the climb/);
  assert.match(flat, /A test nothing sells at for 48 h goes back by the step back below/);
  assert.match(flat, /A test that was taken back is not repeated for 7 days — 14, then 28 when tests fail in a row at the same level/);
  assert.match(flat, /advertised size changes \*\*at most once in 6 h\*\*/);
  assert.doesNotMatch(flat, /never on a fee set by hand/);
  // The package's second review (Q1, Q2, Q4, Q5, random buyers).
  assert.equal(fee.DRAIN_RAMP_KEPT_SHARE, 0.5, "“at least half of what the stretch says goes out”");
  assert.match(flat, /and at least half of what the stretch says goes out in as many of them as it covers/);
  assert.match(flat, /A \*\*raise the drain rules made\*\* — the drain and demand ramps, the velocity nudge, the balance curve under the target, the protect ramp, a 30-day drain's raise, the benchmark's nudge for a draining top earner — is part of the climb it begins/);
  assert.match(flat, /\*\*once the drain is over\*\*: the channel is inside its target band again, no fast drain is measured, and the days the climb is set against were no drain either/);
  assert.match(flat, /with it off no price test is offered and a raise applied by hand is not taken back/);
  assert.match(flat, /by more than max\(1 % of capacity, 50k sat\) and one of its sales/);
  assert.match(flat, /up to four times as much or more once in the 6 h/);
});
