/**
 * React wants the same hooks in the same order on every render: a hook below an
 * early return crashes the whole page to a black screen the moment that return
 * is taken (Market -> Sell did, with no Amboss key connected). The app has no
 * lint for it, so this reads every component: no hook after a return at the top
 * level of a function.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../src/components/", import.meta.url);
const HOOK = /^ {2}(?:(?:const|let) .*= )?(use[A-Z]\w*)\b.*\(/;

/** Hooks that come after a top-level return, one line per finding. */
export function hooksAfterReturn(src: string): string[] {
  const found: string[] = [];
  let inFunction = false;
  let returnedAt = 0;
  let opener = "";
  src.split("\n").forEach((line, i) => {
    if (/^(export )?(default )?(async )?function |^(export )?const \w+ = (\(|function|async)/.test(line)) {
      inFunction = true;
      returnedAt = 0;
      opener = "";
    } else if (/^[})]/.test(line)) {
      inFunction = false;
    } else if (inFunction) {
      if (/^ {2}\S/.test(line) && !/^ {2}\}/.test(line)) opener = line;
      // `  if (x) return …;`, or `    return …` inside a top-level `  if (x) {`:
      // not an effect's cleanup, or a helper's own return.
      if (/^ {2}if \(.*\) return\b/.test(line) || (/^ {4}return\b/.test(line) && /^ {2}if \(/.test(opener))) returnedAt ||= i + 1;
      else if (returnedAt && HOOK.test(line)) found.push(`line ${i + 1}: ${line.trim().slice(0, 60)} (returned at ${returnedAt})`);
    }
  });
  return found;
}

test("the check itself finds a hook below an early return, and passes one above it", () => {
  const bad = `export function A() {\n  const [x] = useState(0);\n  if (x) return null;\n  const r = useRef(null);\n  return r;\n}\n`;
  const badBlock = `function A() {\n  if (x) {\n    return <div />;\n  }\n  useEffect(() => {}, []);\n  return null;\n}\n`;
  const good = `export function A() {\n  const r = useRef(null);\n  useEffect(() => {\n    return () => {};\n  }, []);\n  const go = () => {\n    return 1;\n  };\n  const m = useMemo(() => go(), []);\n  if (r) return null;\n  return m;\n}\n`;
  assert.equal(hooksAfterReturn(bad).length, 1);
  assert.equal(hooksAfterReturn(badBlock).length, 1);
  assert.deepEqual(hooksAfterReturn(good), []);
});

test("no component calls a hook below an early return", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsx"));
  assert.ok(files.length > 20);
  const findings = files.flatMap((f) => hooksAfterReturn(readFileSync(new URL(f, dir), "utf8")).map((x) => `${f} ${x}`));
  assert.deepEqual(findings, []);
});
