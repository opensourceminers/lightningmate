/**
 * This node's own public key: the Magma lane acts only on orders whose seller
 * is this node, so the key must be the right one for every LND connection.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getOwnPubkey } from "../src/services/node.js";
import { FakeLnd } from "./helpers/fakeLnd.js";

test("the own-pubkey lookup is cached per LND connection — never the first node's key for every later one", async () => {
  const a = new FakeLnd();
  const b = new FakeLnd();
  assert.equal(await getOwnPubkey(a.lnd), a.publicKey);
  // Before: one value for the whole process — the first node's key.
  assert.equal(await getOwnPubkey(b.lnd), b.publicKey);
  assert.equal(await getOwnPubkey(a.lnd), a.publicKey);
  const calls = a.callsTo("default.getInfo").length;
  await getOwnPubkey(a.lnd);
  assert.equal(a.callsTo("default.getInfo").length, calls, "asked once per connection");
});
