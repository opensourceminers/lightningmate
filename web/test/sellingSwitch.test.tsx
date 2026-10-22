/** @jsxRuntime automatic */
/** @jsxImportSource react */
/**
 * The Liquidity provision switch (D9; review P1b): switching on opens the
 * confirmation at once — the selling check follows when Amboss answers —
 * and switching off with offers listed reports success only when none is
 * listed any more.
 */
import "./helpers/browserGlobals";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { turnSellingOff, turnSellingOn, type SellingSwitchDeps } from "../src/components/SellingSwitch";
import type { ConfirmOpts } from "../src/components/Overlay";
import type { MyOffer } from "../src/types";

const offer = (id: string, status = "ENABLED"): MyOffer => ({
  id,
  nodePubkey: "02" + "11".repeat(32),
  status,
  minSizeSats: 1_000_000,
  maxSizeSats: 2_000_000,
  totalSizeSats: 2_000_000,
  lockedSats: 0,
  availableSats: 2_000_000,
  baseFeeSats: 852,
  feeRatePpm: 3000,
  minBlockLength: 4320,
  feeRateCapPpm: 2200,
  baseFeeCapSats: 1,
  filledOrders: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
});

function deps(over: Partial<SellingSwitchDeps> & { answers?: boolean[] } = {}) {
  const asked: ConfirmOpts[] = [];
  const saved: unknown[] = [];
  const toasts: { message: string; type?: string }[] = [];
  const answers = over.answers ?? [true];
  const d: SellingSwitchDeps = {
    confirm: async (opts) => {
      asked.push(opts);
      return answers[asked.length - 1] ?? false;
    },
    eligibility: () => new Promise(() => undefined),
    offers: async () => [],
    disableOffer: async () => ({ status: "DISABLED" }),
    save: async (patch) => {
      saved.push(patch);
      return true;
    },
    toast: (message, type) => void toasts.push({ message, type }),
    ...over,
  };
  return { d, asked, saved, toasts };
}

test("switching selling on opens the confirmation at once — the selling check still running — and the dialog says it is checking", async () => {
  // The check never answers (Amboss hanging). Before, nothing appeared until
  // it did: the switch awaited it before opening the dialog.
  const { d, asked, saved } = deps();
  const done = await Promise.race([turnSellingOn(d), new Promise((r) => setTimeout(() => r("blocked"), 500))]);
  assert.notEqual(done, "blocked", "the dialog did not wait for the check");
  assert.equal(asked.length, 1);
  assert.ok(isValidElement(asked[0].body));
  const html = renderToStaticMarkup(asked[0].body as ReactElement);
  assert.match(html, /Checking Amboss(&#x27;|')s public offer book/);
  assert.match(html, /Amboss decides which seller gets an order/);
  assert.deepEqual(saved, [{ sellEnabled: true }]);
});

test("declining the 'turn on' confirmation changes nothing", async () => {
  const { d, saved } = deps({ answers: [false] });
  assert.equal(await turnSellingOn(d), false);
  assert.deepEqual(saved, []);
});

test("turning selling off with offers listed: success only once every one is disabled — an offer still listed keeps selling on, and says which", async () => {
  const listed = [offer("aaaaaaaa-1111"), offer("bbbbbbbb-2222"), offer("cccccccc-3333", "DISABLED")];
  const disabled: string[] = [];
  const failing = deps({
    offers: async () => listed,
    disableOffer: async (id) => {
      disabled.push(id);
      if (id.startsWith("bbbb")) throw new Error("Offer not disabled: Amboss reports the offer ENABLED, not DISABLED.");
      return { status: "DISABLED" };
    },
  });
  assert.equal(await turnSellingOff(failing.d), false);
  assert.deepEqual(disabled, ["aaaaaaaa-1111", "bbbbbbbb-2222"], "only the listed ones — never a flip of a disabled one");
  assert.deepEqual(failing.saved, [], "selling stays on while an offer is still listed");
  assert.equal(failing.toasts[0]?.type, "error");
  assert.match(failing.toasts[0]?.message ?? "", /stays on: offer bbbbbbbb… .* could not be disabled and is still listed/);
  // An answer that is still ENABLED counts as listed too.
  const lying = deps({ offers: async () => [offer("dddddddd-4444")], disableOffer: async () => ({ status: "ENABLED" }) });
  assert.equal(await turnSellingOff(lying.d), false);
  assert.deepEqual(lying.saved, []);
  // All disabled: selling off, and the message says so.
  const ok = deps({ offers: async () => listed });
  assert.equal(await turnSellingOff(ok.d), true);
  assert.deepEqual(ok.saved, [{ sellEnabled: false }]);
});

test("turning selling off when the offers can't be read warns instead of assuming none is listed", async () => {
  const { d, asked, saved } = deps({ offers: async () => Promise.reject(new Error("Amboss unreachable")) });
  assert.equal(await turnSellingOff(d), true);
  assert.match(asked[0].message ?? "", /could not be read from Amboss/);
  assert.deepEqual(saved, [{ sellEnabled: false }]);
});
