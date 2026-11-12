/**
 * A channel's close or open at a rate far above the next block's asks again
 * (review 2026-11-10, CHAN-2), and an on-chain send is never sent twice
 * (CHAN-14): the dialogs, mounted, against a stubbed api.
 */
import "./helpers/browserGlobals";
import { all, button, newContainer, propsOf, settle, type El } from "./helpers/fakeDom";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../src/api";
import { ApiError } from "../src/apiError";
import { newSendId, refusedByApp, sendRepeated } from "../src/onchainView";
import { rateFarAbove } from "../src/statusNotes";
import { OverlayProvider } from "../src/components/Overlay";
import { CloseChannelDialog } from "../src/components/CloseChannelDialog";
import { OpenChannelForm } from "../src/components/OpenChannelForm";
import { OnchainPanel } from "../src/components/OnchainPanel";
import type { CloseTarget } from "../src/closeView";

/* eslint-disable @typescript-eslint/no-explicit-any */
const a = api as Record<string, any>;
const HIGH = "500 sat/vB is more than 3× what LND estimates for the next block (12 sat/vB): this close (about 150 vB) pays ~75,000 sat in fees.";
const rateHigh = () => new ApiError(HIGH, 409, { error: "fee_rate_high", code: "fee_rate_high", message: HIGH });
const FEES = { fast: 12, normal: 8, economy: 5, minimum: 1, fastTarget: 1 };

const target: CloseTarget = {
  peerAlias: "router",
  peerPubkey: "02" + "ab".repeat(32),
  capacity: 2_000_000,
  localBalance: 1_500_000,
  initiator: "local",
  active: true,
  transactionId: "aa".repeat(32),
  transactionVout: 0,
  csvDelayBlocks: 144,
  commitFeeSats: 2_810,
};

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
const byText = (c: El, re: RegExp) => all(c).filter((n) => n.nodeName === "BUTTON" && re.test(n.textContent.trim()));

test("the server's 409 fee_rate_high is read as the question it asks; any other refusal is not", () => {
  assert.equal(rateFarAbove(rateHigh()), HIGH);
  assert.equal(rateFarAbove(new ApiError("x", 409, { error: "lease_active", message: "x" })), null);
  assert.equal(rateFarAbove(new ApiError("x", 400, { error: "fee_rate_high" })), null);
  assert.equal(rateFarAbove(new Error("fee_rate_high")), null);
});

test("CHAN-2: a close at a rate far above the next block's says what it would pay, and closes only on 'Close anyway' — with the yes sent; another rate asks again", async () => {
  a.feeEstimates = async () => FEES;
  const sent: unknown[][] = [];
  let closed = 0;
  a.channelClose = async (...args: unknown[]) => {
    sent.push(args);
    if (args[5] === undefined) throw rateHigh();
    return { ok: true, transactionId: "cc".repeat(32) };
  };
  const { c, root } = await mount(h(CloseChannelDialog, { channel: target, onCancel: () => undefined, onClosed: () => (closed += 1) }));
  const rateInput = all(c).find((n) => n.nodeName === "INPUT" && propsOf(n).type === "number");
  await typeInto(rateInput, "500", "the custom rate");
  await click(button(c, "Close · 500 sat/vB"), "Close · 500 sat/vB");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]![3], 500);
  assert.equal(sent[0]![5], undefined, "the first try confirms nothing");
  assert.match(c.textContent, /pays ~75,000 sat in fees\. Close at this rate anyway\?/);
  assert.equal(closed, 0, "nothing closed on the question");
  // Another rate: the question was about 500, not this one.
  await typeInto(rateInput, "400", "the custom rate");
  assert.ok(button(c, "Close · 400 sat/vB"), "the plain button for another rate");
  assert.doesNotMatch(c.textContent, /Close at this rate anyway/);
  await typeInto(rateInput, "500", "the custom rate");
  await click(button(c, "Close anyway · 500 sat/vB"), "Close anyway");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1]![5], ["fee_rate_high"], "the yes goes with the second try");
  assert.equal(sent[1]![2], false, "still cooperative");
  assert.equal(closed, 1);
  root.unmount();
});

test("CHAN-2: an open at a rate far above the next block's is sent again only after 'Open anyway', with the yes; a no opens nothing", async () => {
  a.openEstimate = async () => ({ sizeSats: 1_000_000, fees: FEES, spendableSat: 5_000_000, reserveSat: 50_000, promisedSat: 0 });
  a.nodeDetail = async () => null;
  for (const answer of ["Open anyway", "Cancel"] as const) {
    const sent: any[] = [];
    const results: any[] = [];
    a.channelOpen = async (p: any) => {
      sent.push(p);
      if (!p.confirmed) throw rateHigh();
      return { ok: true, pubkey: p.pubkey, localTokens: p.localTokens, transactionId: "dd".repeat(32) };
    };
    const { c, root } = await mount(
      h(OpenChannelForm, { pubkey: "03" + "cd".repeat(32), alias: "peer", socket: "", initialSize: 1_000_000, onResult: (r: unknown) => results.push(r), onCancel: () => undefined }),
    );
    await click(byText(c, /^Open/).find((n) => !/anyway/.test(n.textContent)), "the open button");
    assert.equal(sent.length, 1);
    assert.match(c.textContent, /Fee rate far above the next block/);
    assert.match(c.textContent, /Open at this rate anyway\?/);
    await click(byText(c, new RegExp(`^${answer}$`)).at(-1), answer);
    if (answer === "Open anyway") {
      assert.equal(sent.length, 2);
      assert.deepEqual(sent[1].confirmed, ["fee_rate_high"]);
      assert.equal(results[0]?.ok, true);
    } else {
      assert.equal(sent.length, 1, "a no sends nothing more");
      assert.equal(results[0]?.ok, false);
      assert.equal(results[0]?.error, HIGH);
    }
    root.unmount();
  }
});

test("CHAN-14: a send id is 32 hex characters, new each time; a repeat's refusal is read with the first send's transaction and whether it ended", () => {
  const one = newSendId();
  assert.match(one, /^[0-9a-f]{32}$/);
  assert.notEqual(one, newSendId());
  const done = sendRepeated(new ApiError("x", 409, { error: "send_repeated", message: "went out", result: { ok: true, transactionId: "ee".repeat(32) } }));
  assert.deepEqual(done, { message: "went out", transactionId: "ee".repeat(32), settled: true });
  const running = sendRepeated(new ApiError("x", 409, { error: "send_repeated", message: "under way" }));
  assert.deepEqual(running, { message: "under way", transactionId: null, settled: false });
  const failed = sendRepeated(new ApiError("x", 409, { error: "send_repeated", message: "failed", result: { ok: false, transactionId: "", error: "no" } }));
  assert.deepEqual(failed, { message: "failed", transactionId: null, settled: true });
  assert.equal(sendRepeated(new ApiError("x", 409, { error: "confirm_send" })), null);
  // The app's own refusal (4xx, its reason) vs a proxy's 502/504 or a body that isn't the app's (R1-9).
  assert.equal(refusedByApp(new ApiError("x", 400, { error: "bad_request", message: "x" })), true);
  assert.equal(refusedByApp(new ApiError("x", 409, { error: "confirm_send" })), true);
  assert.equal(refusedByApp(new ApiError("Gateway Timeout", 504, null)), false);
  assert.equal(refusedByApp(new ApiError("x", 502, { error: "node_request_failed" })), false);
  assert.equal(refusedByApp(new ApiError("x", 404, "<html>")), false);
  assert.equal(refusedByApp(new TypeError("Failed to fetch")), false);
});

test("CHAN-14: the send form sends one id per send — kept when LND's outcome is unknown or no answer came (a second click finds the first send), new after an answer", async () => {
  a.autopilotGet = async () => ({ canWrite: true, config: {} });
  a.onchainState = async () => ({ confirmedSats: 5_000_000, unconfirmedSats: 0, suggestedFeeRate: 5, budget: null, utxos: [] });
  a.onchainTxs = async () => [];
  a.onchainPreview = async (q: any) => ({
    mode: "amount",
    address: q.address,
    amountSats: q.tokens,
    feeRate: q.feeRate,
    feeSats: 705,
    vbytes: 141,
    feeApprox: false,
    remainingSats: 4_000_000,
    estimates: FEES,
    checks: [],
    touchesPromised: false,
  });
  const answers: (() => Promise<unknown>)[] = [
    async () => ({ ok: false, transactionId: "", unknown: true, error: "LND has not answered within 60 s." }),
    async () => {
      throw new TypeError("Failed to fetch");
    },
    async () => {
      throw new ApiError("Gateway Timeout", 504, null); // a proxy gave up waiting (R1-9)
    },
    async () => {
      throw new ApiError("x", 409, { error: "send_repeated", message: "went out already", result: { ok: true, transactionId: "ff".repeat(32) } });
    },
    async () => {
      throw new ApiError("x", 400, { error: "bad_send", message: "the amount must be at least 546 sat" });
    },
    async () => ({ ok: false, transactionId: "", unknown: true, error: "LND has not answered within 45 s." }),
    async () => ({ ok: true, transactionId: "ab".repeat(32) }),
  ];
  const ids: string[] = [];
  const bodies: any[] = [];
  a.onchainSend = async (p: any) => {
    ids.push(p.requestId);
    bodies.push(p);
    return answers.shift()!();
  };
  const { c, root } = await mount(h(OnchainPanel, {}));
  const inputs = all(c).filter((n) => n.nodeName === "INPUT");
  const address = inputs.find((n) => propsOf(n).placeholder === "bc1…");
  const amount = inputs.find((n) => propsOf(n).placeholder === "0");
  await typeInto(address, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "the address");
  await typeInto(amount, "100000.7", "the amount");
  const send = async () => {
    await click(button(c, "Review & send"), "Review & send");
    await click(byText(c, /^Send now$/).at(-1), "Send now");
  };
  await send(); // LND's outcome unknown
  await send(); // no answer at all
  await send(); // a proxy's 504
  await send(); // the server: it went out with the first
  assert.equal(ids.length, 4);
  assert.equal(ids[0], ids[1], "kept after an unknown outcome");
  assert.equal(ids[1], ids[2], "kept when no answer came");
  assert.equal(ids[2], ids[3], "kept after a proxy's 504: it may hide a send");
  assert.equal(bodies[0].tokens, 100_000, "whole sat");
  assert.match(c.textContent, /went out already/);
  // The form was cleared by the repeat's answer (it went out); a new send is a new id.
  await typeInto(address, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", "the address");
  await typeInto(amount, "100000", "the amount");
  await send(); // the app refuses it (its own 400)
  assert.notEqual(ids[4], ids[3], "a new send, a new id");
  await send(); // LND's outcome unknown
  assert.notEqual(ids[5], ids[4], "after the app's own refusal, a new id");
  await typeInto(amount, "90000", "the amount");
  await send();
  assert.notEqual(ids[6], ids[5], "another amount is another send, whatever came before");
  root.unmount();
});

test("R1-19: a close refused because one is already under way is said as that — not as a failed close", async () => {
  a.feeEstimates = async () => FEES;
  a.channelClose = async () => {
    throw new ApiError("x", 409, { error: "close_in_flight", message: "A close of this channel is already under way — wait for its answer, or look under pending channels." });
  };
  const { c, root } = await mount(h(CloseChannelDialog, { channel: target, onCancel: () => undefined, onClosed: () => undefined }));
  await click(byText(c, /^Close · /)[0], "Close");
  assert.match(c.textContent, /A close of this channel is already under way — wait for its answer/);
  assert.doesNotMatch(c.textContent, /Close failed/);
  root.unmount();
});
