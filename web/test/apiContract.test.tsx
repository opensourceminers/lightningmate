/**
 * The API contract: one source of truth for the payload types, shared by
 * the server and the web (review a8-engineering:web-server-type-drift) —
 * what the routes answer, and what the web sends them.
 *
 * The shapes themselves are checked by the compiler: web/src/types.ts
 * re-exports server/src/apiTypes.ts, so a field the server drops or renames
 * fails the web's type-check where the web reads it, and every body a route
 * composes is checked against its contract type (`satisfies`) — the server's
 * type-check fails where a route sends something else. These tests keep that
 * arrangement from eroding — no hand-kept copy creeping back (not even a
 * small `{ ok, … }` answer written out in web/src/api.ts), no server code
 * reaching the bundle, no route sending a body it built unchecked (read from
 * the routes' syntax tree) — and no answer the web reads as another type
 * than its route sends (the two sides paired by the compiler: every body a
 * route can send must be assignable to the type web/src/api.ts names for that
 * path). Requests the same way: the web names the contract type of every body
 * and query string it sends, a route reads them only as contract types
 * (`bodyOf<…>(req)`, `queryOf<…>(req)`, whose keys are the type's), a read
 * stays exactly that type (never widened, never handed on as another's), and
 * the two sides are paired. CI runs them with both type-checks as its own
 * step: `npm run check:api-types`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function filesUnder(rel: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel))) {
    const path = join(rel, name);
    if (statSync(join(root, path)).isDirectory()) out.push(...filesUnder(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** Every import / export-from statement of a module: its text and source. */
function moduleRefs(src: string): { text: string; from: string }[] {
  return [...stripComments(src).matchAll(/^\s*(import|export)\b[^;]*?\bfrom\s+["']([^"']+)["'];?/gms)].map((m) => ({ text: m[0].trim(), from: m[2] }));
}

test("web/src/types.ts is the server's contract re-exported — it declares no payload type of its own (the hand-kept copy that drifted)", () => {
  const src = stripComments(read("web/src/types.ts"));
  assert.doesNotMatch(src, /\b(interface|enum|class)\s+\w+/, "no interface of its own");
  assert.doesNotMatch(src, /^\s*(export\s+)?type\s+\w+\s*(<[^>]*>)?\s*=/m, "no type alias of its own");
  const refs = moduleRefs(src);
  assert.deepEqual(refs.map((r) => r.from), ["../../server/src/apiTypes"], "one source: the server's contract module");
  assert.match(refs[0].text, /^export type \{/, "type-only: nothing of the server reaches the bundle");
  // Nothing else in the file.
  const rest = src.replace(refs[0].text, "").trim();
  assert.equal(rest, "", `unexpected: ${rest.slice(0, 120)}`);
});

test("the web reaches the server only through the contract, type-only — no server module, and no runtime import, in the browser bundle", () => {
  for (const file of filesUnder("web/src")) {
    for (const ref of moduleRefs(read(file))) {
      if (!/(^|\/)server\//.test(ref.from) && !ref.from.startsWith("../../")) continue;
      assert.equal(file, "web/src/types.ts", `${file} imports ${ref.from}: go through ./types`);
      assert.match(ref.text, /^(import|export) type\b/, `${file}: ${ref.text}`);
    }
  }
});

test("the contract module holds types only — no runtime code — and draws on the server's own declarations", () => {
  const src = stripComments(read("server/src/apiTypes.ts"));
  for (const ref of moduleRefs(src)) {
    assert.match(ref.text, /^(import|export) type\b/, ref.text);
    assert.match(ref.from, /^\.\/services\/[\w]+\.js$/, ref.from);
  }
  assert.doesNotMatch(src, /^\s*export\s+(const|let|var|function|class|default|enum)\b/m, "no runtime export");
  assert.doesNotMatch(src, /^\s*(const|let|var|function|class)\s/m, "no runtime statement");
});

test("every body a route composes is checked against its contract type where it is sent", () => {
  const contract = stripComments(read("server/src/apiTypes.ts"));
  const routes = read("server/src/routes/api.ts");
  // The bodies the routes build (the contract's own declarations — not the
  // aliases of server types, which the server functions return as such).
  const composed = [
    ["HealthInfo", "HealthInfo"],
    ["ChannelView", "ApiChannelView"],
    ["AutopilotState", "AutopilotState"],
    ["OpenChannelResult", "ApiOpenChannelResult"],
    ["OpenEstimate", "OpenEstimate"],
    ["SuggestionsResponse", "SuggestionsResponse"],
    ["PrivacyInfo", "PrivacyInfo"],
    ["LspStatus", "LspStatus"],
    ["PriceInfo", "PriceInfo"],
    ["UnservedDemandReport", "UnservedDemandReport"],
    ["RebalanceLogResponse", "RebalanceLogResponse"],
    ["RebalanceCostsResponse", "RebalanceCostsResponse"],
    ["OrderState", "ApiOrderState"],
    ["PayResult", "ApiPayResult"],
    ["OnchainState", "ApiOnchainState"],
    ["OnchainSendResult", "OnchainSendResult"],
    ["BuyOffersResponse", "BuyOffersResponse"],
    ["MyOffersResponse", "MyOffersResponse"],
    ["AmbossStatus", "AmbossStatus"],
    ["MyOrder", "ApiMyOrder"],
    ["BoughtInboundResponse", "BoughtInboundResponse"],
    ["LnPlusStatus", "LnPlusStatus"],
    ["LnPlusPoolResponse", "LnPlusPoolResponse"],
    ["LnPlusSwapsResponse", "LnPlusSwapsResponse"],
    ["MyOrdersView", "MyOrdersView"],
    ["AuthStatus", "AuthStatus"],
    ["AuthUnlockResult", "AuthUnlockResult"],
    ["AlertAckResult", "AlertAckResult"],
    ["PeerConnectResult", "PeerConnectResult"],
    ["FeeApplyResponse", "FeeApplyResponse"],
    ["ApplyRecommendedResponse", "ApplyRecommendedResponse"],
    ["AutopilotRunResult", "AutopilotRunResult"],
    ["AutopilotResumeResult", "AutopilotResumeResult"],
    ["NeverOpenResult", "NeverOpenResult"],
    ["LspOrdersResponse", "LspOrdersResponse"],
    ["SignResult", "SignResult"],
    ["AmbossKeyResult", "AmbossKeyResult"],
    ["BuyQuoteResponse", "BuyQuoteResponse"],
    ["BuyPayResult", "BuyPayResult"],
    ["BuyCancelResult", "BuyCancelResult"],
    ["PurchasesResponse", "PurchasesResponse"],
    ["OfferCreateResult", "OfferCreateResult"],
    ["OfferUpdateResult", "OfferUpdateResult"],
    ["OfferToggleResult", "OfferToggleResult"],
    ["OfferAutomationResult", "OfferAutomationResult"],
  ] as const;
  for (const [name, local] of composed) {
    assert.match(contract, new RegExp(`export (interface|type) ${name}\\b`), `${name} is declared in the contract`);
    assert.match(routes, new RegExp(`(satisfies ${local}\\b|\\): ${local}\\b)`), `${name}: the route checks the body it sends (satisfies ${local})`);
  }
  // Every body the contract declares itself is on that list (or a part of
  // one) — or one the web sends: the request tests below pair those.
  const parts = new Set(["StartingFee", "PurchasePaymentHint", "UnservedDemandChannel", "LnPlusPoolNode", "LnPlusSwap", "RebalanceLogSummary", "RebalanceRecReport", "ChannelSuggestion", "LnPlusRating", "OnchainUtxo", "AutopilotBounds"]);
  const requests = routeRequests();
  const sent = new Set([...requests.bodies.values(), ...requests.queries.values()].flat());
  const declared = [...contract.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
  const listed = new Set<string>(composed.map(([n]) => n));
  for (const name of declared) {
    assert.ok(listed.has(name) || parts.has(name) || sent.has(name), `${name}: a body of which route? Check it where it is sent (or read) and list it here`);
  }
});

/** The names routes/api.ts imports from the contract (as it calls them there). */
function contractNamesIn(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== "../apiTypes.js") continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) names.add(el.name.text);
  }
  return names;
}

/** An object the expression builds right there: a literal, or a choice
 *  between such (`ok ? {…} : {…}`). A call's result is typed by its function. */
function buildsObject(e: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isObjectLiteralExpression(e)) return true;
  if (ts.isConditionalExpression(e)) return buildsObject(e.whenTrue) || buildsObject(e.whenFalse);
  return false;
}

/** The variable `name` as the code at `at` sees it: declared in the nearest
 *  enclosing function that declares it (not inside a function nested in it). */
function declarationOf(name: string, at: ts.Node): ts.VariableDeclaration | null {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) continue;
    const root = scope;
    let found: ts.VariableDeclaration | null = null;
    const look = (n: ts.Node): void => {
      if (found) return;
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name) {
        found = n;
        return;
      }
      if (n !== root && ts.isFunctionLike(n)) return;
      ts.forEachChild(n, look);
    };
    ts.forEachChild(root, look);
    if (found) return found;
  }
  return null;
}

/** The route (method and path) a node of routes/api.ts sits in. */
function routeOf(n: ts.Node): string {
  for (let p: ts.Node | undefined = n; p; p = p.parent) {
    if (!ts.isCallExpression(p) || !ts.isPropertyAccessExpression(p.expression)) continue;
    const callee = p.expression;
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "router" && p.arguments[0] && ts.isStringLiteral(p.arguments[0])) {
      return `${callee.name.text.toUpperCase()} ${p.arguments[0].text}`;
    }
  }
  return "(no route)";
}

// Bodies the routes send that no page of the web reads — no contract type.
const NOT_THE_WEBS: Record<string, string> = {
  "GET /widget/stats": "umbreld's home-screen widget format (four-stats), read by umbrelOS",
  "GET /diagnostics": "a file the operator downloads and passes on; the page saves it as it is",
  "GET /service-fees": "the service-fee ledger for transparency (curl, SECURITY.md); no page reads it",
};

test("every success body a route builds is checked against a contract type where it is sent — no route answers with an object the contract doesn't know", () => {
  const src = read("server/src/routes/api.ts");
  const sf = ts.createSourceFile("api.ts", src, ts.ScriptTarget.Latest, true);
  const contract = contractNamesIn(sf);
  assert.ok(contract.size > 20, "the routes import the contract");
  const unchecked: string[] = [];
  const visit = (n: ts.Node): void => {
    // res.json(<body>) — a success answer (an error is res.status(…).json).
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "json" &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === "res" &&
      n.arguments.length === 1
    ) {
      let body = n.arguments[0];
      while (ts.isParenthesizedExpression(body)) body = body.expression;
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      if (ts.isSatisfiesExpression(body)) {
        const as = body.type.getText(sf);
        assert.ok(contract.has(as), `api.ts:${line} (${routeOf(n)}): checked against ${as}, which is not a contract type`);
      } else if (buildsObject(body)) {
        unchecked.push(routeOf(n));
      } else if (ts.isIdentifier(body)) {
        // Built in a variable first (`const out = {…}; res.json(out)`): the
        // variable is typed with a contract type, or it is unchecked too.
        const decl = declarationOf(body.text, n);
        if (decl?.initializer && buildsObject(decl.initializer)) {
          if (!decl.type) unchecked.push(routeOf(n));
          else assert.ok(contract.has(decl.type.getText(sf)), `api.ts:${line} (${routeOf(n)}): ${body.text} is a ${decl.type.getText(sf)}, not a contract type`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.deepEqual(
    [...new Set(unchecked)].sort(),
    Object.keys(NOT_THE_WEBS).sort(),
    "a body the web reads must be `satisfies <contract type>`; one no page reads goes on NOT_THE_WEBS, with why",
  );
});

/** The names web/src/types.ts re-exports from the contract. */
function webExports(): Set<string> {
  const exported = new Set([...stripComments(read("web/src/types.ts")).matchAll(/^\s+(\w+),$/gm)].map((m) => m[1]));
  assert.ok(exported.size > 100, "web/src/types.ts re-exports the contract");
  return exported;
}

/** A contract type by name — or an array of one — as the web client writes
 *  an answer's type: nothing written out, no type arguments. */
function namesContractType(t: ts.TypeNode, exported: Set<string>): boolean {
  if (ts.isArrayTypeNode(t)) return namesContractType(t.elementType, exported);
  return ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && exported.has(t.typeName.text) && !t.typeArguments;
}

test("the web client names a contract type for every answer it reads — no shape of its own written out in web/src/api.ts", () => {
  const src = read("web/src/api.ts");
  const sf = ts.createSourceFile("api.ts", src, ts.ScriptTarget.Latest, true);
  const exported = webExports();
  const named = (t: ts.TypeNode): boolean => namesContractType(t, exported);
  /** A defensive read of an error body: every field `unknown` (checked at
   *  run time) — not a payload's shape. */
  const defensive = (t: ts.TypeNode): boolean => {
    if (ts.isUnionTypeNode(t)) return t.types.every((u) => defensive(u) || u.kind === ts.SyntaxKind.LiteralType);
    return ts.isTypeLiteralNode(t) && t.members.every((m) => ts.isPropertySignature(m) && m.type?.kind === ts.SyntaxKind.UnknownKeyword);
  };
  const calls: string[] = [];
  const visit = (n: ts.Node): void => {
    const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    // get<T>(…), post<T>(…), del<T>(…): T is a contract type.
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ["get", "post", "del"].includes(n.expression.text) && n.typeArguments) {
      const [t] = n.typeArguments;
      calls.push(n.expression.text);
      assert.ok(named(t), `api.ts:${line}: ${n.expression.text}<${t.getText(sf)}> — name the answer in server/src/apiTypes.ts`);
    }
    // An answer read by hand ((await res.json()) as T): T is a contract type,
    // a type parameter of the helper, or a defensive read of an error body.
    if (ts.isAsExpression(n) && n.getText(sf).includes(".json()")) {
      const t = n.type;
      const typeParam = ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && t.typeName.text === "T";
      assert.ok(named(t) || typeParam || defensive(t), `api.ts:${line}: as ${t.getText(sf)} — name the answer in server/src/apiTypes.ts`);
    }
    // No shape written out inside a type argument or an intersection.
    if (ts.isIntersectionTypeNode(n)) assert.fail(`api.ts:${line}: ${n.getText(sf)} — an answer's shape belongs in the contract`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.ok(calls.length > 80, `${calls.length} calls checked`);
});

// ── The two sides, paired ────────────────────────────────────────────────────
//
// The rules above hold each side to the contract, not to each other:
// web/src/api.ts pairs every path with a type by hand (get<T>("/path")), and
// nothing checked that T is what that route sends. A route answering with
// another contract type, or with a body built where the syntax-tree rule
// doesn't look (inside a .map callback), passed both type-checks while the
// page read the wrong shape (review of P8, round 2). Here the compiler
// decides, as the finding's own contract check did: every success body the
// route can send must be assignable to the type the web reads it as.

const WEB_METHODS: Record<string, string> = { get: "GET", post: "POST", del: "DELETE" };

/** Helpers of the routes that send a body they are handed (`res.json(r)`):
 *  name → the position of that body among their arguments. */
const SENDERS: Record<string, number> = { sendDesk: 1 };

/** The route path a web request names — a literal, a template's text before
 *  its first substitution when that is the query (`/x?d=${d}`, `/x${qs}`), or
 *  a choice between such that agree — without the query string. Null: a
 *  substitution in the path itself (`/x/${id}`), which this check can't
 *  follow — name such a path plainly, or teach the check. */
function webPath(e: ts.Expression): string | null {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isConditionalExpression(e)) {
    const [a, b] = [webPath(e.whenTrue), webPath(e.whenFalse)];
    return a !== null && a === b ? a : null;
  }
  let text: string;
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) text = e.text;
  else if (ts.isTemplateExpression(e)) {
    text = e.head.text;
    const after = e.templateSpans[0].literal.text;
    if (!text.includes("?") && (text.endsWith("/") || !(after === "" || after.startsWith("?")))) return null;
  } else return null;
  return text.split("?")[0];
}

/** The request an answer read by hand (`(await res.json()) as T`) belongs
 *  to: the one fetch of its function — its method and its path under /api.
 *  Null when that can't be told. */
function fetchOf(n: ts.Node): { method: string; path: string } | null {
  let fn: ts.Node | undefined = n.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return null;
  const fetches: ts.CallExpression[] = [];
  const look = (c: ts.Node): void => {
    if (ts.isCallExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === "fetch") fetches.push(c);
    if (!ts.isFunctionLike(c)) ts.forEachChild(c, look);
  };
  ts.forEachChild(fn, look);
  if (fetches.length !== 1) return null;
  const [url, init] = fetches[0].arguments;
  const path = url ? webPath(url) : null;
  if (!path?.startsWith("/api/")) return null;
  let method = "GET";
  if (init) {
    if (!ts.isObjectLiteralExpression(init)) return null;
    for (const p of init.properties) {
      if (!p.name || !ts.isIdentifier(p.name) || p.name.text !== "method") continue;
      if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.initializer)) return null;
      method = p.initializer.text.toUpperCase();
    }
  }
  return { method, path: path.slice("/api".length) };
}

/** What the web reads: each request of web/src/api.ts whose answer it types —
 *  "METHOD /path", the type as written, and where. */
function webReads(): { route: string; type: string; at: string }[] {
  const sf = ts.createSourceFile("api.ts", read("web/src/api.ts"), ts.ScriptTarget.Latest, true);
  const exported = webExports();
  const reads: { route: string; type: string; at: string }[] = [];
  const visit = (n: ts.Node): void => {
    const at = `web/src/api.ts:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && WEB_METHODS[n.expression.text] && n.typeArguments) {
      const path = n.arguments[0] ? webPath(n.arguments[0]) : null;
      assert.ok(path, `${at}: which route does ${n.getText(sf).slice(0, 60)} ask? Name its path plainly`);
      reads.push({ route: `${WEB_METHODS[n.expression.text]} ${path}`, type: n.typeArguments[0].getText(sf), at });
    }
    if (ts.isAsExpression(n) && n.getText(sf).includes(".json()") && namesContractType(n.type, exported)) {
      const req = fetchOf(n);
      assert.ok(req, `${at}: which request is ${n.getText(sf)} the answer to? One fetch per function, its path a literal`);
      reads.push({ route: `${req.method} ${req.path}`, type: n.type.getText(sf), at });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return reads;
}

/**
 * The server as its compiler sees it: every success body each route of
 * routes/api.ts can send, typed — and the web's answer types, resolved by
 * the same compiler from a file of their own beside the contract, written
 * as the web writes them (from the names web/src/types.ts re-exports).
 */
function serverSide(webTypes: string[]) {
  const config = ts.getParsedCommandLineOfConfigFile(join(root, "server/tsconfig.json"), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => assert.fail(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  });
  assert.ok(config, "server/tsconfig.json");
  const routesFile = join(root, "server/src/routes/api.ts");
  const readsFile = join(root, "server/src/webReads.check.ts"); // never on disk
  const names = [...new Set(webTypes.flatMap((t) => t.match(/[A-Za-z_]\w*/g) ?? []))].sort();
  const text = [`import type { ${names.join(", ")} } from "./apiTypes.js";`, ...webTypes.map((t, i) => `export type Read${i} = ${t};`)].join("\n");
  const isReads = (name: string) => name.replace(/\\/g, "/") === readsFile.replace(/\\/g, "/");
  const host = ts.createCompilerHost(config.options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, version, ...rest) =>
    isReads(name) ? ts.createSourceFile(name, text, version, true) : getSourceFile.call(host, name, version, ...rest);
  host.fileExists = (name) => isReads(name) || fileExists.call(host, name);
  host.readFile = (name) => (isReads(name) ? text : readFile.call(host, name));
  const program = ts.createProgram([routesFile, readsFile], config.options, host);
  const checker = program.getTypeChecker();

  // The web's types: a contract name (or an array of one) the compiler
  // resolves — never `any`, which every body would pass.
  const readsSf = program.getSourceFile(readsFile);
  assert.ok(readsSf);
  const targets = readsSf.statements.filter(ts.isTypeAliasDeclaration).map((d) => checker.getTypeFromTypeNode(d.type));
  assert.equal(targets.length, webTypes.length);
  targets.forEach((t, i) => assert.equal(t.flags & ts.TypeFlags.Any, 0, `${webTypes[i]}: no such contract type`));

  // The routes' success bodies: `res.json(body)` (an error answer is
  // `res.status(…).json`), or a body handed to one of the SENDERS.
  const sf = program.getSourceFile(routesFile);
  assert.ok(sf);
  const at = (n: ts.Node) => `server/src/routes/api.ts:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const routes = new Map<string, { type: ts.Type; at: string }[]>();
  const senders = new Set<string>();
  const visit = (n: ts.Node, route: string | null): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "router" && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
        route = `${callee.name.text.toUpperCase()} ${n.arguments[0].text}`;
        if (!routes.has(route)) routes.set(route, []);
      }
      const json = ts.isPropertyAccessExpression(callee) && callee.name.text === "json" && ts.isIdentifier(callee.expression) && callee.expression.text === "res" && n.arguments.length === 1;
      const sender = ts.isIdentifier(callee) && callee.text in SENDERS ? callee.text : null;
      const body = json ? n.arguments[0] : sender ? n.arguments[SENDERS[sender]] : undefined;
      if (body && route) routes.get(route)!.push({ type: checker.getTypeAtLocation(body), at: at(n) });
      else if (json) {
        // Outside a route: only in one of the SENDERS, sending what it is handed.
        let fn: ts.Node | undefined = n.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        const name = fn && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : "";
        const param = fn && ts.isFunctionLike(fn) ? fn.parameters[SENDERS[name] ?? -1] : undefined;
        const sent = n.arguments[0];
        assert.ok(
          name in SENDERS && param && ts.isIdentifier(param.name) && ts.isIdentifier(sent) && sent.text === param.name.text,
          `${at(n)}: a body sent outside a route — list its helper in SENDERS, with the position of the body it sends`,
        );
        senders.add(name);
      }
    }
    ts.forEachChild(n, (c) => visit(c, route));
  };
  visit(sf, null);
  assert.deepEqual([...senders].sort(), Object.keys(SENDERS).sort(), "every helper in SENDERS sends the body it is handed");
  return { checker, routes, targets };
}

test("every answer the web reads is what its route sends — each success body the route can send is assignable to the type web/src/api.ts reads it as", () => {
  const reads = webReads();
  assert.ok(reads.length > 80, `${reads.length} reads`);
  assert.ok(reads.some((r) => r.route === "POST /auth/unlock"), "the login's read by hand is paired too");
  const { checker, routes, targets } = serverSide(reads.map((r) => r.type));
  const problems: string[] = [];
  let bodies = 0;
  reads.forEach((r, i) => {
    const sent = routes.get(r.route);
    if (!sent) return void problems.push(`${r.at}: ${r.route} — no such route`);
    if (sent.length === 0) return void problems.push(`${r.at}: ${r.route} sends no body this check sees (res.json, or a helper in SENDERS)`);
    for (const b of sent) {
      bodies += 1;
      if (b.type.flags & ts.TypeFlags.Any) problems.push(`${b.at} (${r.route}): an untyped body (any) — ${r.at} reads it as ${r.type}`);
      else if (!checker.isTypeAssignableTo(b.type, targets[i])) {
        problems.push(`${b.at} (${r.route}) sends ${checker.typeToString(b.type).slice(0, 160)} — ${r.at} reads it as ${r.type}`);
      }
    }
  });
  assert.deepEqual(problems, [], "the web reads each answer as what its route sends");
  assert.ok(bodies > 80, `${bodies} bodies checked`);
});

// The web's type-check compiles every server file the contract reaches with
// the web's options. A check the server's own config lacks made a server-only
// change — an unused local — pass `npm run typecheck -w server`, then fail
// the web's check and the build with an error in a server file (review of P8).
test("the server's own type-check holds its files to every check the web's type-check applies to them", () => {
  const options = (rel: string): Record<string, unknown> => {
    const { config, error } = ts.readConfigFile(join(root, rel), ts.sys.readFile);
    assert.equal(error, undefined, rel);
    return (config as { compilerOptions: Record<string, unknown> }).compilerOptions;
  };
  const web = options("web/tsconfig.json");
  const server = options("server/tsconfig.json");
  const checks = [
    "strict",
    "noUnusedLocals",
    "noUnusedParameters",
    "noFallthroughCasesInSwitch",
    "noImplicitReturns",
    "noImplicitOverride",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noPropertyAccessFromIndexSignature",
    "isolatedModules",
  ];
  const on = checks.filter((c) => web[c] === true);
  assert.ok(on.length >= 4, `the web's checks: ${on.join(", ")}`);
  for (const c of on) assert.equal(server[c], true, `server/tsconfig.json: "${c}": true, as the web's check of the server's files has it`);
});

// The `satisfies` checks sit in server/src/routes/api.ts, which the web's
// type-check never reaches: the contract check compiles the server too
// (review of P8: renaming `pendingSeller` in GET /amboss/my-orders passed it).
test("`npm run check:api-types` compiles the routes, the web and these rules", () => {
  const script = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts["check:api-types"] ?? "";
  assert.match(script, /tsc -p server\/tsconfig\.json --noEmit/);
  assert.match(script, /npm run typecheck -w web/);
  assert.match(script, /--test web\/test\/apiContract\.test\.tsx/);
});

// The finding's own drift, now impossible by construction: the web reads the
// server's FeeRecommendation (with its recommended base fee), its sell-action
// kinds and its offers — not copies that lacked them.
test("the payloads the review found drifted are the server's own now", () => {
  const types = read("web/src/types.ts");
  for (const name of ["FeeRecommendation", "AutopilotSell", "MagmaOffer", "MyOrder", "DashboardData"]) {
    assert.match(types, new RegExp(`\\b${name},`), `${name} comes from the server`);
  }
});

// ── What the web sends ───────────────────────────────────────────────────────
//
// Review of P8, final round: the request bodies were the second hand-kept
// copy — written out again as parameter types in web/src/api.ts, while the
// routes destructured an untyped `req.body`. Renaming `localTokens` in POST
// /channels/open (the route and its tests) passed every check, and every
// Open from the UI would have got a 400; a renamed `breakLease` or
// `spendPromised` would have dropped the operator's confirmation. Now a
// route reads its body only through `bodyOf<contract type>(req)` — its keys
// are the type's, so a key the contract lacks fails to compile — the web
// names the same type for the body it sends, and the two are paired here.

/** What each route of routes/api.ts reads its request as — the contract type
 *  of its `bodyOf<…>(req)` and `queryOf<…>(req)` — and every `req.body` read
 *  outside `bodyOf` (`bare`), every `req.query` read outside `queryOf`
 *  (`bareQueries`). */
function routeRequests(): { bodies: Map<string, string[]>; queries: Map<string, string[]>; bare: string[]; bareQueries: string[]; problems: string[] } {
  const sf = ts.createSourceFile("api.ts", read("server/src/routes/api.ts"), ts.ScriptTarget.Latest, true);
  const contract = contractNamesIn(sf);
  const at = (n: ts.Node) => `server/src/routes/api.ts:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const bodies = new Map<string, string[]>();
  const queries = new Map<string, string[]>();
  const bare: string[] = [];
  const bareQueries: string[] = [];
  const problems: string[] = [];
  let helpers = 0;
  // What the handlers call their request: the first parameter of every
  // function handed to router.<method>(…), router.use(…) or wrap(…).
  const requestNames = new Set(["req", "_req", "request"]);
  const visit = (n: ts.Node, route: string | null, inHelper: boolean): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router" && n.arguments[0] && ts.isStringLiteral(n.arguments[0])) {
      route = `${n.expression.name.text.toUpperCase()} ${n.arguments[0].text}`;
    }
    const handsOver =
      ts.isCallExpression(n) &&
      ((ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "router") ||
        (ts.isIdentifier(n.expression) && n.expression.text === "wrap"));
    if (handsOver) {
      for (const a of n.arguments) {
        const first = (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) && a.parameters[0];
        if (first && ts.isIdentifier(first.name)) requestNames.add(first.name.text);
      }
    }
    if (ts.isFunctionDeclaration(n) && (n.name?.text === "bodyOf" || n.name?.text === "queryOf")) {
      helpers += 1;
      inHelper = true;
    }
    // A request's body or query: `req.body` (or `req["body"]`), `req.query`,
    // whatever the handler calls its request.
    const ofRequest = (e: ts.Expression) => ts.isIdentifier(e) && requestNames.has(e.text);
    const reads = (part: string) =>
      (ts.isPropertyAccessExpression(n) && n.name.text === part && ofRequest(n.expression)) ||
      (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === part && ofRequest(n.expression));
    if (reads("body") && !inHelper) bare.push(`${at(n)} (${route ?? "outside a route"}): ${n.getText(sf)}`);
    if (reads("query") && !inHelper) bareQueries.push(`${at(n)} (${route ?? "outside a route"}): ${n.getText(sf)}`);
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "bodyOf" || n.expression.text === "queryOf")) {
      const [t] = n.typeArguments ?? [];
      const named = t && ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName) && !t.typeArguments ? t.typeName.text : null;
      if (!named || !contract.has(named)) problems.push(`${at(n)}: ${n.getText(sf)} — read a request as a contract type, by name`);
      else if (!route) problems.push(`${at(n)}: ${n.getText(sf)} outside a route — read the body in the route, and hand it on`);
      else {
        const map = n.expression.text === "bodyOf" ? bodies : queries;
        map.set(route, [...new Set([...(map.get(route) ?? []), named])]);
      }
    }
    ts.forEachChild(n, (c) => visit(c, route, inHelper));
  };
  visit(sf, null, false);
  assert.equal(helpers, 2, "routes/api.ts declares bodyOf and queryOf");
  return { bodies, queries, bare, bareQueries, problems };
}

/** The `api` object of web/src/api.ts: each method's name, its parameters'
 *  type annotations, and the function itself. */
function webMethods(sf: ts.SourceFile): { name: string; fn: ts.ArrowFunction; params: ts.ParameterDeclaration[] }[] {
  const out: { name: string; fn: ts.ArrowFunction; params: ts.ParameterDeclaration[] }[] = [];
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== "api" || !d.initializer || !ts.isObjectLiteralExpression(d.initializer)) continue;
      for (const p of d.initializer.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ts.isArrowFunction(p.initializer)) {
          out.push({ name: p.name.text, fn: p.initializer, params: [...p.initializer.parameters] });
        }
      }
    }
  }
  return out;
}

/** What the web sends: each request of web/src/api.ts that carries a body —
 *  "METHOD /path", the contract type it names for the body (null: an empty
 *  one), and where. A POST names its body's type as `post<Answer, Body>`; the
 *  login, a fetch of its own, as `JSON.stringify(… satisfies Body)`. */
function webRequests(): { route: string; type: string | null; at: string }[] {
  const sf = ts.createSourceFile("api.ts", read("web/src/api.ts"), ts.ScriptTarget.Latest, true);
  const exported = webExports();
  const at = (n: ts.Node) => `web/src/api.ts:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const out: { route: string; type: string | null; at: string }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "post" && n.typeArguments) {
      const path = n.arguments[0] ? webPath(n.arguments[0]) : null;
      assert.ok(path, `${at(n)}: which route does ${n.getText(sf).slice(0, 60)} ask? Name its path plainly`);
      const [, b] = n.typeArguments;
      const body = n.arguments[1];
      if (b) {
        assert.ok(namesContractType(b, exported) && !ts.isArrayTypeNode(b), `${at(n)}: post<…, ${b.getText(sf)}> — name the request's contract type`);
        out.push({ route: `POST ${path}`, type: b.getText(sf), at: at(n) });
      } else {
        // No body type named: the empty body of a POST that acts without one.
        assert.ok(body && ts.isObjectLiteralExpression(body) && body.properties.length === 0, `${at(n)}: a body sent without its contract type — post<Answer, Body>(…)`);
        out.push({ route: `POST ${path}`, type: null, at: at(n) });
      }
    }
    // A fetch of its own (the login, the backup download): its JSON body.
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "fetch") {
      const [url, init] = n.arguments;
      const path = url ? webPath(url) : null;
      const method = init && ts.isObjectLiteralExpression(init)
        ? init.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "method")
        : undefined;
      if (path?.startsWith("/api/") && method && ts.isStringLiteral(method.initializer) && method.initializer.text === "POST") {
        const body = (init as ts.ObjectLiteralExpression).properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "body");
        const route = `POST ${path.slice("/api".length)}`;
        if (body && ts.isStringLiteral(body.initializer) && body.initializer.text === "{}") out.push({ route, type: null, at: at(n) });
        else {
          let arg = body && ts.isCallExpression(body.initializer) && body.initializer.expression.getText(sf) === "JSON.stringify" ? body.initializer.arguments[0] : undefined;
          while (arg && ts.isParenthesizedExpression(arg)) arg = arg.expression;
          assert.ok(arg && ts.isSatisfiesExpression(arg) && namesContractType(arg.type, exported), `${at(n)}: ${route}'s body — JSON.stringify(… satisfies <its contract type>)`);
          out.push({ route, type: arg.type.getText(sf), at: at(n) });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("a route reads its body only as a contract type — through bodyOf<…>(req), whose keys are the type's — never a bare req.body", () => {
  const { bodies, bare, problems } = routeRequests();
  assert.deepEqual(problems, []);
  assert.deepEqual(bare, [], "read the body with bodyOf<the request's contract type>(req)");
  assert.ok(bodies.size >= 25, `${bodies.size} routes read a body`);
  for (const [route, types] of bodies) assert.equal(types.length, 1, `${route} reads its body as ${types.join(" and ")} — one contract type per request`);
});

test("the web client's methods take what they send as contract types — no shape written out in a parameter", () => {
  const sf = ts.createSourceFile("api.ts", read("web/src/api.ts"), ts.ScriptTarget.Latest, true);
  const methods = webMethods(sf);
  assert.ok(methods.length > 80, `${methods.length} methods`);
  const inline: string[] = [];
  for (const m of methods) {
    for (const p of m.params) {
      const look = (n: ts.Node): void => {
        if (ts.isTypeLiteralNode(n)) inline.push(`api.${m.name}(${p.getText(sf)})`);
        ts.forEachChild(n, look);
      };
      if (p.type) look(p.type);
    }
  }
  assert.deepEqual(inline, [], "a request's shape belongs in server/src/apiTypes.ts");
});

test("every request the web sends names its body's contract type, and its route reads the body as that very type — a route that reads one is sent it", () => {
  const sent = webRequests();
  assert.ok(sent.length >= 30, `${sent.length} requests`);
  assert.ok(sent.some((r) => r.route === "POST /auth/unlock" && r.type === "AuthUnlockRequest"), "the login's own fetch is paired too");
  const { bodies } = routeRequests();
  const problems: string[] = [];
  for (const r of sent) {
    const reads = bodies.get(r.route);
    if (r.type === null && reads) problems.push(`${r.at}: ${r.route} reads its body as ${reads[0]} — the web sends none`);
    else if (r.type !== null && !reads) problems.push(`${r.at}: ${r.route} reads no body as a contract type — the web sends a ${r.type}`);
    else if (r.type !== null && reads?.[0] !== r.type) problems.push(`${r.at}: ${r.route} reads its body as ${reads?.[0]} — the web sends a ${r.type}`);
  }
  for (const [route, [type]] of bodies) {
    if (!sent.some((r) => r.route === route && r.type === type)) problems.push(`${route} reads a ${type} no request of the web sends`);
  }
  assert.deepEqual(problems, [], "the web sends each route the body it reads");
});

// ── A read stays its route's contract type ──────────────────────────────────
//
// Review of P8, run 2: the on-chain send read its body as the preview's query
// and its own body at once — `const body: Fields<SendPreviewQuery> &
// Fields<OnchainSendRequest> = bodyOf<OnchainSendRequest>(req)`, handed to a
// parser typed with the same intersection that served both routes. A key
// renamed in one of the two contract types (the web changed to match) still
// compiled while the other kept the old name, and passed every check: every
// send of an amount would have got a 400. Now each route fills the parser
// from its own read, key by key, and a read can't be widened: not by a
// declared type or a cast (below), and not by handing it on — the compiler
// refuses that (the mark Fields carries; the test after this one).

const READS = new Set(["bodyOf", "queryOf", "fieldsOf"]);

test("a route's read stays exactly its contract type — no declared type or cast on what bodyOf, queryOf or fieldsOf read, and no Fields<…> joined with another type", () => {
  const sf = ts.createSourceFile("api.ts", read("server/src/routes/api.ts"), ts.ScriptTarget.Latest, true);
  const at = (n: ts.Node) => `server/src/routes/api.ts:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const unwrap = (e: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  };
  const isRead = (e: ts.Expression): boolean => {
    const u = unwrap(e);
    return ts.isCallExpression(u) && ts.isIdentifier(u.expression) && READS.has(u.expression.text);
  };
  /** Somewhere inside: a node `hit` says yes to. */
  const holds = (t: ts.Node, hit: (n: ts.Node) => boolean): boolean => {
    let found = false;
    const look = (n: ts.Node): void => {
      if (found) return;
      if (hit(n)) found = true;
      else ts.forEachChild(n, look);
    };
    look(t);
    return found;
  };
  const isFields = (n: ts.Node) => ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName) && n.typeName.text === "Fields";
  const combines = (n: ts.Node) => ts.isIntersectionTypeNode(n) || ts.isUnionTypeNode(n) || ts.isTypeLiteralNode(n) || ts.isMappedTypeNode(n);
  const problems: string[] = [];
  let reads = 0;
  const visit = (n: ts.Node): void => {
    // `const body: X = bodyOf<…>(req)`: the read is what it reads, no more.
    if (ts.isVariableDeclaration(n) && n.initializer && isRead(n.initializer) && n.type) {
      problems.push(`${at(n)}: ${n.name.getText(sf)}: ${n.type.getText(sf)} — let it be what ${unwrap(n.initializer).getText(sf)} reads`);
    }
    if ((ts.isAsExpression(n) || ts.isTypeAssertionExpression(n)) && isRead(n.expression)) {
      problems.push(`${at(n)}: ${n.getText(sf)} — a read cast to another type`);
    }
    // `Fields<A> & Fields<B>` (or `| …`), wherever it is written: a variable,
    // a parameter, a return type.
    if ((ts.isIntersectionTypeNode(n) || ts.isUnionTypeNode(n)) && n.types.some((t) => holds(t, isFields))) {
      problems.push(`${at(n)}: ${n.getText(sf)} — a read joined with another type`);
    }
    // Fields<…>, bodyOf<…>, queryOf<…>, fieldsOf<…>: one contract type (or a
    // part of one) — not a combination, not a shape written out.
    const call = ts.isCallExpression(n) && ts.isIdentifier(n.expression) && READS.has(n.expression.text);
    if (call) reads += 1;
    const args = call ? (n as ts.CallExpression).typeArguments : isFields(n) ? (n as ts.TypeReferenceNode).typeArguments : undefined;
    for (const t of args ?? []) {
      if (holds(t, combines)) problems.push(`${at(n)}: ${n.getText(sf).slice(0, 90)} — read as one contract type, not ${t.getText(sf)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  assert.deepEqual(problems, [], "a read stays exactly its route's contract type");
  assert.ok(reads >= 30, `${reads} reads checked`);
});

/** routes/api.ts as the server's compiler sees it with `extra` appended — in
 *  memory, the file on disk untouched: its diagnostics, each on the line it
 *  is on, counted from the first line of `extra` (negative: the file's own). */
function routesCompiledWith(extra: string): { line: number; code: number; text: string }[] {
  const config = ts.getParsedCommandLineOfConfigFile(join(root, "server/tsconfig.json"), undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => assert.fail(ts.flattenDiagnosticMessageText(d.messageText, "\n")),
  });
  assert.ok(config, "server/tsconfig.json");
  const routesFile = join(root, "server/src/routes/api.ts");
  const original = read("server/src/routes/api.ts");
  const text = `${original}\n${extra}`;
  const offset = original.split("\n").length;
  const isRoutes = (name: string) => name.replace(/\\/g, "/") === routesFile.replace(/\\/g, "/");
  const host = ts.createCompilerHost(config.options);
  const { getSourceFile, readFile } = host;
  host.getSourceFile = (name, version, ...rest) =>
    isRoutes(name) ? ts.createSourceFile(name, text, version, true) : getSourceFile.call(host, name, version, ...rest);
  host.readFile = (name) => (isRoutes(name) ? text : readFile.call(host, name));
  const program = ts.createProgram([routesFile], config.options, host);
  const sf = program.getSourceFile(routesFile);
  assert.ok(sf);
  return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => ({
    line: sf.getLineAndCharacterOfPosition(d.start ?? 0).line - offset,
    code: d.code,
    text: ts.flattenDiagnosticMessageText(d.messageText, " "),
  }));
}

test("the compiler holds a read to its contract type: handed on as — or joined with — the read of another contract type with a key it lacks, it fails to compile; handed where fewer keys are read, it passes", () => {
  // The review's case, in the routes' own scope (in memory): the preview's
  // query handed to a parser that reads the send's body too, and the two
  // reads joined — as GET /onchain/send-preview did.
  const probe = [
    "export function readsProbe(req: Request): unknown[] {",
    "  const asSend = (b: Fields<OnchainSendRequest>): unknown => b.sendAll;",
    "  const asTerms = (b: Fields<OfferTermsRequest>): unknown => b.totalSizeSats;",
    "  const handedOn = asSend(queryOf<SendPreviewQuery>(req));",
    "  const joined: Fields<SendPreviewQuery> & Fields<OnchainSendRequest> = queryOf<SendPreviewQuery>(req);",
    "  const fewerKeys = asTerms(bodyOf<OfferUpdateRequest>(req));",
    "  return [handedOn, joined, fewerKeys];",
    "}",
  ].join("\n");
  const found = routesCompiledWith(probe);
  assert.deepEqual(found.filter((d) => d.line < 0), [], "routes/api.ts itself compiles");
  assert.deepEqual(
    found.map((d) => [d.line, d.code]),
    [
      [3, 2345], // handed on: Argument of type 'Fields<SendPreviewQuery>' is not assignable to …
      [4, 2322], // joined: Type 'Fields<SendPreviewQuery>' is not assignable to …
    ],
    found.map((d) => `${d.line}: TS${d.code} ${d.text}`).join("\n"),
  );
  for (const d of found) assert.match(d.text, /is not assignable to type 'keyof SendPreviewQuery'/, "the keys the preview's query lacks are named");
});

// ── What the web asks with: the query strings ───────────────────────────────
//
// Review of P8, run 2: a GET's query string was the last part of a request
// still paired by hand — written out in web/src/api.ts (`/pnl?days=${days}`)
// and read from `req.query` in the routes. A parameter renamed on one side
// passed every check, and the page silently got the route's default; GET
// /suggestions/close was offered a `days` it never read. Now the web names the
// query's contract type — get<Answer, Query>(path, query), the path a literal
// — the route reads it through queryOf<that type>(req), and the two are
// paired here, as the bodies are.

/** What the web asks with: each GET of web/src/api.ts — "GET /path", the
 *  contract type it names for the query (null: none), and where. */
function webQueries(): { route: string; type: string | null; at: string }[] {
  const sf = ts.createSourceFile("api.ts", read("web/src/api.ts"), ts.ScriptTarget.Latest, true);
  const exported = webExports();
  const at = (n: ts.Node) => `web/src/api.ts:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const out: { route: string; type: string | null; at: string }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "get" && n.typeArguments) {
      const [path] = n.arguments;
      // The route's path, nothing written into it: a parameter goes out as a
      // field of the query's contract type.
      assert.ok(path && (ts.isStringLiteral(path) || ts.isNoSubstitutionTemplateLiteral(path)) && !path.text.includes("?"), `${at(n)}: ${path?.getText(sf)} — the route's path as a literal; its query as get<Answer, Query>(path, query)`);
      const [, q] = n.typeArguments;
      if (q) {
        assert.ok(namesContractType(q, exported) && !ts.isArrayTypeNode(q), `${at(n)}: get<…, ${q.getText(sf)}> — name the query's contract type`);
        out.push({ route: `GET ${path.text}`, type: q.getText(sf), at: at(n) });
      } else {
        assert.equal(n.arguments.length, 1, `${at(n)}: a query sent without its contract type — get<Answer, Query>(path, query)`);
        out.push({ route: `GET ${path.text}`, type: null, at: at(n) });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test("every query string the web sends names its contract type, and its route reads the query as that very type — a route that reads one is sent it, and none reads req.query by hand", () => {
  const { queries, bareQueries, problems: unnamed } = routeRequests();
  assert.deepEqual(unnamed, []);
  assert.deepEqual(bareQueries, [], "read the query with queryOf<the query's contract type>(req)");
  assert.ok(queries.size >= 15, `${queries.size} routes read a query`);
  for (const [route, types] of queries) assert.equal(types.length, 1, `${route} reads its query as ${types.join(" and ")} — one contract type per request`);
  const asked = webQueries();
  assert.ok(asked.length > 40, `${asked.length} GETs`);
  const problems: string[] = [];
  for (const r of asked) {
    const reads = queries.get(r.route);
    if (r.type === null && reads) problems.push(`${r.at}: ${r.route} reads its query as ${reads[0]} — the web sends none`);
    else if (r.type !== null && !reads) problems.push(`${r.at}: ${r.route} reads no query — the web sends a ${r.type}`);
    else if (r.type !== null && reads?.[0] !== r.type) problems.push(`${r.at}: ${r.route} reads its query as ${reads?.[0]} — the web sends a ${r.type}`);
  }
  for (const [route, [type]] of queries) {
    if (!asked.some((r) => r.route === route && r.type === type)) problems.push(`${route} reads a ${type} no request of the web sends`);
  }
  assert.deepEqual(problems, [], "the web sends each route the query it reads");
});
