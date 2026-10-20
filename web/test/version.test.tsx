/** @jsxRuntime automatic */
/** @jsxImportSource react */
// (tsx applies web/tsconfig.json's JSX settings to src/ only — the pragma
// selects the same automatic runtime for this test file.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { Footer } from "../src/components/Footer";
import { formatVersion } from "../src/version";

test("the footer shows the running version", () => {
  const html = renderToStaticMarkup(<Footer version="v0.7.8" />);
  assert.match(html, /Lightning Mate.*v0\.7\.8/);
});

test("the footer renders without a version while it is still loading", () => {
  const html = renderToStaticMarkup(<Footer />);
  assert.match(html, /Lightning Mate/);
  assert.doesNotMatch(html, /foot-version/);
});

test("versions read the same whichever way the image was tagged", () => {
  assert.equal(formatVersion("v0.7.8"), "v0.7.8");
  assert.equal(formatVersion("0.7.8"), "v0.7.8");
  assert.equal(formatVersion("dev"), "dev build");
  assert.equal(formatVersion(""), "");
  assert.equal(formatVersion(undefined), "");
});
