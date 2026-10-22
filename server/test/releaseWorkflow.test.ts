/**
 * Release traceability (review a8-engineering:supply-chain-release-
 * traceability): a published image tag is never written twice, a manual run
 * can't publish a release tag, every image says where it came from, and the
 * base image and the actions are pinned — the base image on the Node major
 * CI tests.
 *
 * Before: workflow_dispatch could overwrite any tag, v0.7.4 was moved to
 * another commit and rebuilt under the same name, the build legs had no
 * labels (dropped in 074565a) and the base image tag moved under the same
 * name between releases.
 *
 * The guard step's script is run here for real (bash), with a stand-in
 * `docker` that answers `buildx imagetools inspect` from a list.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { makeTempDir } from "./helpers/tmp.js";

const workflow = readFileSync(new URL("../../.github/workflows/build-image.yml", import.meta.url), "utf8");
const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const dependabot = readFileSync(new URL("../../.github/dependabot.yml", import.meta.url), "utf8");

/** A line's indent. */
const indentOf = (l: string) => (l.match(/^\s*/) as RegExpMatchArray)[0].length;

/** The `run: |` block of the step named `name`, unindented. */
function stepScript(name: string): string {
  const lines = workflow.split("\n");
  const at = lines.findIndex((l) => l.includes(`name: ${name}`));
  assert.ok(at >= 0, `no step named ${name}`);
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = indentOf(lines[run + 1]);
  const body: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== "" && indentOf(l) < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n");
}

/** dependabot.yml's update entry for one package ecosystem: its lines, with
 *  comments and blank lines left out (a rule commented out is no rule). */
function dependabotEntry(ecosystem: string): string[] {
  const lines = dependabot
    .split("\n")
    .map((l) => l.replace(/(^|\s)#.*$/, ""))
    .filter((l) => l.trim() !== "");
  const entries = lines.flatMap((l, i) => {
    if (!/^\s*- package-ecosystem:/.test(l)) return [];
    const end = lines.findIndex((m, j) => j > i && indentOf(m) <= indentOf(l));
    return [lines.slice(i, end < 0 ? undefined : end)];
  });
  const found = entries.filter((e) => new RegExp(`- package-ecosystem:\\s*["']?${ecosystem}["']?\\s*$`).test(e[0]));
  assert.equal(found.length, 1, `one ${ecosystem} entry in dependabot.yml`);
  return found[0];
}

/** An entry's `ignore:` rules: the dependency-name each matches (`*` matches
 *  anything), the update types it ignores (none listed: every update, unless
 *  it names versions instead) and whether it names versions. */
function ignoreRules(entry: string[]): { name: string; types: string[]; versions: boolean }[] {
  const at = entry.findIndex((l) => /^\s*ignore:\s*$/.test(l));
  if (at < 0) return [];
  const rules: string[][] = [];
  for (const l of entry.slice(at + 1)) {
    const item = /^\s*- /.test(l);
    // The entry's next key ends the list (whose items may sit at the key's indent).
    if (indentOf(l) < indentOf(entry[at]) || (indentOf(l) === indentOf(entry[at]) && !item)) break;
    if (item && (rules.length === 0 || indentOf(l) === indentOf(rules[0][0]))) rules.push([l]);
    else rules.at(-1)?.push(l);
  }
  return rules.map((r) => {
    const text = r.join("\n");
    return {
      name: /dependency-name:\s*["']?([^"'\s]+)/.exec(text)?.[1] ?? "",
      types: [...text.matchAll(/version-update:semver-(major|minor|patch)/g)].map((m) => m[1]),
      versions: /\bversions:/.test(text),
    };
  });
}

/** Whether a rule's dependency-name (a glob: `*` matches anything) names `dep`. */
const namesDep = (pattern: string, dep: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(dep);

/** Run the guard with these inputs; `published` are the tags the registry has. */
function guard(t: TestContext, o: { event: "push" | "workflow_dispatch"; ref?: string; input?: string; published?: string[]; registryDown?: boolean }) {
  const dir = makeTempDir(t);
  const docker = join(dir, "docker");
  const known = (o.published ?? []).map((tag) => `ghcr.io/opensourceminers/lightningmate:${tag}`);
  writeFileSync(
    docker,
    [
      "#!/usr/bin/env bash",
      // docker buildx imagetools inspect <ref>
      `[ "$1 $2 $3" = "buildx imagetools inspect" ] || { echo "unexpected: $*" >&2; exit 2; }`,
      o.registryDown ? `echo "ERROR: failed to do request: dial tcp: connection refused" >&2; exit 1` : "",
      `for k in ${known.map((k) => `"${k}"`).join(" ")}; do [ "$4" = "$k" ] && { echo "Name: $4"; exit 0; }; done`,
      `echo "ERROR: $4: not found" >&2; exit 1`,
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  const output = join(dir, "github_output");
  writeFileSync(output, "");
  const r = spawnSync("bash", ["-e", "-c", stepScript("Image tag (never one that exists)")], {
    encoding: "utf8",
    env: {
      PATH: `${dir}:${process.env.PATH}`,
      EVENT: o.event,
      REF_NAME: o.ref ?? "",
      INPUT_TAG: o.input ?? "",
      IMAGE: "ghcr.io/opensourceminers/lightningmate",
      GITHUB_SHA: "abcdef1234567890",
      GITHUB_OUTPUT: output,
    },
  });
  const tag = /^tag=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1] ?? null;
  return { code: r.status, tag, log: r.stdout + r.stderr };
}

test("a pushed release tag is published once: a tag the registry has already is refused — images are immutable", (t) => {
  const fresh = guard(t, { event: "push", ref: "v0.8.0", published: ["v0.7.7"] });
  assert.deepEqual([fresh.code, fresh.tag], [0, "v0.8.0"], fresh.log);
  // Before: rebuilt and overwritten (v0.7.4 was moved to another commit).
  const again = guard(t, { event: "push", ref: "v0.7.7", published: ["v0.7.7"] });
  assert.equal(again.code, 1);
  assert.equal(again.tag, null);
  assert.match(again.log, /published already — images are immutable/);
});

test("a pushed tag is a release only as a semantic version with the v prefix — the version the app shows", (t) => {
  assert.deepEqual([guard(t, { event: "push", ref: "v0.8.0-rc.1" }).tag], ["v0.8.0-rc.1"]);
  for (const ref of ["vtest", "v0.8", "v0.8.0.1", "v0.8.0;rm"]) {
    const r = guard(t, { event: "push", ref });
    assert.deepEqual([r.code, r.tag], [1, null], ref);
    assert.match(r.log, /a semantic version with a v prefix/, ref);
  }
});

test("a manual run publishes a test tag only — dev-<commit> by default — never a release tag, nor one that exists, nor a malformed one", (t) => {
  const dflt = guard(t, { event: "workflow_dispatch" });
  assert.deepEqual([dflt.code, dflt.tag], [0, "dev-abcdef1"], dflt.log);
  const named = guard(t, { event: "workflow_dispatch", input: "dev-myfix" });
  assert.deepEqual([named.code, named.tag], [0, "dev-myfix"]);
  // Before: any tag, the default "dev" overwritten every time.
  const release = guard(t, { event: "workflow_dispatch", input: "v0.8.0" });
  assert.equal(release.code, 1);
  assert.match(release.log, /published only by pushing the git tag/);
  // Nor any other name that isn't dev-…: each would be an immutable tag
  // nobody cut as a release (review of P8: only v[0-9]* was refused).
  for (const input of ["latest", "0.8.0", "V0.8.0", "dev", "dev-", "stable-dev-1"]) {
    const r = guard(t, { event: "workflow_dispatch", input });
    assert.deepEqual([r.code, r.tag], [1, null], input);
    assert.match(r.log, /publishes test tags only \(dev-…\)/, input);
  }
  assert.equal(guard(t, { event: "workflow_dispatch", input: "dev-myfix", published: ["dev-myfix"] }).code, 1);
  assert.equal(guard(t, { event: "workflow_dispatch", input: "dev fix;rm" }).code, 1);
});

test("when the registry can't be asked, nothing is published — 'not there' must be the registry's answer", (t) => {
  const down = guard(t, { event: "push", ref: "v0.8.0", registryDown: true });
  assert.equal(down.code, 1);
  assert.match(down.log, /Could not tell whether .* exists/);
});

test("the image says where it came from: labels on each leg, annotations on the index, provenance and an SBOM; the merge asks again before it tags", () => {
  for (const key of ["source", "revision", "version"]) {
    assert.match(workflow, new RegExp(`labels: \\|[\\s\\S]*org\\.opencontainers\\.image\\.${key}=`), `label ${key}`);
    assert.match(workflow, new RegExp(`--annotation "index:org\\.opencontainers\\.image\\.${key}=`), `annotation ${key}`);
  }
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
  assert.doesNotMatch(workflow, /provenance: false/);
  // Least privilege: only the jobs that push can write packages.
  assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  assert.match(workflow, /guard:\n(?:.*\n)*? {4}permissions:\n {6}contents: read\n {6}packages: read/);
});

test("every action is pinned to a commit, and the base image to a digest", () => {
  for (const [file, text] of [["build-image.yml", workflow], ["ci.yml", ci]] as const) {
    const uses = [...text.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
    assert.ok(uses.length > 0, file);
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${file}: ${u} is not pinned to a commit`);
  }
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2);
  for (const f of froms) assert.match(f, /^node:\d+\.\d+\.\d+-alpine@sha256:[0-9a-f]{64}$/, f);
  // The runtime holds the server's production dependencies only.
  assert.match(dockerfile, /RUN npm ci --omit=dev -w server/);
});

// Review of P8: the image kept its state in <repo>/.data = /app/.data, in a
// directory root owns, while the app runs as `node` — the first store's mkdir
// failed (EACCES) and the README's `docker run` never got the server up.
test("the image keeps its state in /data, a directory the user the app runs as owns — created before the switch to that user", () => {
  const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
  const env = /^ENV ([\s\S]*?)(?:\n\n|\n[A-Z])/m.exec(runtime)?.[1] ?? "";
  assert.match(env, /\bDATA_DIR=\/data\b/, "DATA_DIR in the runtime stage");
  const own = runtime.indexOf("RUN mkdir -p /data && chown node:node /data");
  const user = runtime.indexOf("USER node");
  assert.ok(own > 0, "/data is created and given to node");
  assert.ok(user > own, "before the image switches to node");
  // Umbrel mounts its app-data dir at the same place.
  const compose = readFileSync(new URL("../../packaging/umbrel/lightningmate/docker-compose.yml", import.meta.url), "utf8");
  assert.match(compose, /- \$\{APP_DATA_DIR\}\/data:\/data\n/);
  assert.match(compose, /DATA_DIR: "\/data"/);
});

test("CI fails on a known vulnerability in what runs in production, and on payload types that drift", () => {
  assert.match(ci, /run: npm audit --omit=dev --audit-level=high/);
  assert.match(ci, /run: npm run check:api-types/);
  for (const eco of ["npm", "github-actions", "docker"]) assert.match(dependabot, new RegExp(`package-ecosystem: ${eco}`));
});

// Review of P8, round 3: left to itself, Dependabot proposes a base image's
// next major too (node:22.x-alpine → a 24.x alpine tag), the release
// checklist said to merge its bump, and CI tests Node 22 only — nothing held
// the image's Node to the one CI runs, nor the two stages to one image.
test("the image runs the Node major CI tests: one base image for both stages, on ci.yml's node-version — and Dependabot proposes no other major, only the routine bumps", () => {
  const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2);
  assert.equal(froms[1], froms[0], "the build and the runtime stage use one base image, tag and digest");
  const imageMajor = /^node:(\d+)\./.exec(froms[0])?.[1];
  const ciNode = [...ci.matchAll(/^[ \t]*node-version:[ \t]*["']?([^"'\s#]+)/gm)].map((m) => m[1]);
  assert.equal(ciNode.length, 1, "CI sets up one Node");
  const ciMajor = /^(\d+)(?:\.[\dx]+)*$/.exec(ciNode[0])?.[1];
  assert.ok(ciMajor, `ci.yml's node-version names a major (22, 22.x), not ${ciNode[0]}`);
  assert.equal(imageMajor, ciMajor, `the image runs Node ${imageMajor}, CI tests Node ${ciMajor}`);
  // Dependabot's base-image bumps stay on that major; the routine ones (new
  // digests, minor and patch releases) still come, for the checklist to take.
  const onNode = ignoreRules(dependabotEntry("docker")).filter((r) => namesDep(r.name, "node"));
  const ignored = new Set(onNode.flatMap((r) => (r.types.length > 0 ? r.types : r.versions ? [] : ["major", "minor", "patch"])));
  assert.deepEqual([...ignored].sort(), ["major"], "node's semver-major updates are ignored — and only those");
  assert.ok(!onNode.some((r) => r.versions), "no range of node versions is ignored besides");
});

/** Run the merge step's script on two per-arch digests, with a stand-in
 *  `docker` that knows `published` and logs every call. `registryDown`: the
 *  look fails without the registry's answer (network, auth). */
function mergeStep(t: TestContext, tag: string, published: string[], registryDown = false) {
  const dir = makeTempDir(t);
  const digests = join(dir, "digests");
  mkdirSync(digests);
  for (const d of ["aa".repeat(32), "bb".repeat(32)]) writeFileSync(join(digests, d), "");
  const calls = join(dir, "calls.log");
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${calls}"`,
      registryDown ? `if [ "$3" = "inspect" ]; then echo "ERROR: failed to do request: dial tcp: i/o timeout" >&2; exit 1; fi` : "",
      `if [ "$3" = "inspect" ]; then for k in ${published.map((p) => `"ghcr.io/opensourceminers/lightningmate:${p}"`).join(" ")}; do [ "$4" = "$k" ] && exit 0; done; echo "ERROR: $4: not found" >&2; exit 1; fi`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(docker, 0o755);
  const r = spawnSync("bash", ["-e", "-c", stepScript("Create manifest list")], {
    encoding: "utf8",
    cwd: digests,
    env: { PATH: `${dir}:${process.env.PATH}`, IMAGE: "ghcr.io/opensourceminers/lightningmate", TAG: tag, SOURCE: "https://github.com/opensourceminers/lightningmate", GITHUB_SHA: "abcdef1234567890" },
  });
  const log = existsSync(calls) ? readFileSync(calls, "utf8") : "";
  return { code: r.status, created: log.split("\n").filter((l) => l.startsWith("buildx imagetools create")), out: r.stdout + r.stderr };
}

test("the merge asks the registry once more right before it writes the tag — a run of the same tag that finished meanwhile is not overwritten", (t) => {
  const fresh = mergeStep(t, "v0.8.0", []);
  assert.equal(fresh.code, 0, fresh.out);
  assert.equal(fresh.created.length, 1);
  assert.match(fresh.created[0], /-t ghcr\.io\/opensourceminers\/lightningmate:v0\.8\.0 /);
  assert.match(fresh.created[0], /--annotation index:org\.opencontainers\.image\.revision=abcdef1234567890/);
  assert.match(fresh.created[0], /lightningmate@sha256:aa+ ghcr\.io\/opensourceminers\/lightningmate@sha256:b+/);
  // Published between the guard and the merge: nothing written.
  const raced = mergeStep(t, "v0.8.0", ["v0.8.0"]);
  assert.equal(raced.code, 1);
  assert.deepEqual(raced.created, []);
  assert.match(raced.out, /was published meanwhile — not overwritten/);
  // A look that failed is no "not found": nothing written either (review of
  // P8: any inspect error went on to `imagetools create -t`).
  const blind = mergeStep(t, "v0.8.0", [], true);
  assert.equal(blind.code, 1);
  assert.deepEqual(blind.created, []);
  assert.match(blind.out, /Could not tell whether .* exists: .*i\/o timeout — not tagged/);
});
