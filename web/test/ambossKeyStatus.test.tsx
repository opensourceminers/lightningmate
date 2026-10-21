/** @jsxRuntime automatic */
/** @jsxImportSource react */
// (tsx applies web/tsconfig.json's JSX settings to src/ only — the pragma
// selects the same automatic runtime for this test file.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AmbossKeyStatus } from "../src/components/AmbossKeyStatus";

const render = (p: Partial<Parameters<typeof AmbossKeyStatus>[0]>) =>
  renderToStaticMarkup(
    <AmbossKeyStatus
      keyValid={true}
      keyCheck="valid"
      lastError={null}
      busy={false}
      onRecheck={() => undefined}
      onRemove={() => undefined}
      {...p}
    />,
  );

test("Amboss unreachable: 'retrying' with Re-check — never 'revoked', never a button that removes the key", () => {
  const html = render({ keyValid: true, keyCheck: "unreachable", lastError: "Amboss unreachable: ECONNRESET" });
  assert.match(html, /Amboss unreachable — retrying/);
  assert.match(html, /Re-check/);
  assert.match(html, /ECONNRESET/);
  assert.doesNotMatch(html, /revoked|rejected|Remove key|Disconnect|Reconnect/);
});

test("key rejected by Amboss: says so, offers Re-check, and removal only as its own explicit button", () => {
  const html = render({ keyValid: false, keyCheck: "rejected" });
  assert.match(html, /Amboss rejected your key/);
  assert.match(html, /Re-check/);
  assert.match(html, /Remove key/);
});

test("a working key: connected, with Disconnect", () => {
  const html = render({ keyValid: true, keyCheck: "valid" });
  assert.match(html, /Amboss connected · key valid/);
  assert.match(html, /Disconnect/);
  assert.doesNotMatch(html, /unreachable|rejected/);
  assert.doesNotMatch(html, /in flight/, "nothing in flight: no warning");
});

test("Magma orders in flight: the card warns before anyone reaches for Disconnect or Remove key", () => {
  for (const keyCheck of ["valid", "rejected"] as const) {
    const html = render({ keyValid: keyCheck === "valid", keyCheck, ordersInFlight: 2 });
    assert.match(html, /2 Magma orders are in flight/);
    assert.match(html, /stops LightningMate from opening, reporting and settling them/);
  }
  assert.match(render({ ordersInFlight: 1 }), /1 Magma order is in flight/);
  // Amboss merely unreachable: no removal is offered, so no warning about it.
  assert.doesNotMatch(render({ keyCheck: "unreachable", ordersInFlight: 2 }), /in flight/);
});
