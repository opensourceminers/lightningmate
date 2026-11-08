/**
 * Dialing a peer, the way LND answers. ConnectPeer with perm: true (what the
 * lightning library sends unless is_temporary is set) returns at once and dials
 * in the background; only perm: false waits for the outcome. The fake used to
 * connect at once either way, so nothing noticed that the dial gave up 1.5 s
 * later: over Tor every Magma buyer not already connected read as unreachable.
 * server/e2e/dial.ts shows the same against a real LND.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectForOpen, ensureConnected } from "../src/services/channelOps.js";
import { INVOICE_NOT_FOUND, hodlStatus } from "../src/services/hodl.js";
import { FakeLnd } from "./helpers/fakeLnd.js";
import { makeNodeKey } from "./helpers/bolt11.js";
import { keepFileAlive } from "./helpers/lifecycle.js";

// A dial's time limit fires on a timer nothing else keeps alive (see keepFileAlive).
keepFileAlive();

/** LND's two modes, with a dial that takes `ms`. */
function dialsLikeLnd(node: FakeLnd, ms: number, fails?: (socket: string) => string | null): void {
  node.override("default.connectPeer", (a, cb) => {
    const addr = a.addr as { pubkey: string; host: string };
    const connect = () => void (node.peers.includes(addr.pubkey) || node.peers.push(addr.pubkey));
    const failure = fails?.(addr.host) ?? null;
    if (a.perm) {
      if (!failure) setTimeout(connect, ms);
      return cb(null, {});
    }
    setTimeout(() => {
      if (failure) return cb({ details: failure });
      connect();
      cb(null, {});
    }, ms);
  });
}

test("the dial waits for LND's answer: a peer that takes 2 s is reached (before: given up after 1.5 s)", async () => {
  const peer = makeNodeKey().publicKey;
  const node = new FakeLnd({ peers: [] });
  dialsLikeLnd(node, 2_000);
  const started = Date.now();
  assert.equal(await ensureConnected(node.lnd, peer, ["1.2.3.4:9735"]), true);
  assert.ok(Date.now() - started >= 1_900, "it did wait");
  const [call] = node.callsTo("default.connectPeer");
  assert.equal(call.perm, false, "synchronous: no persistent dial left behind either");
  assert.equal(call.timeout, "45", "seconds, and long enough for a Tor circuit");
});

test("what LND said about each address reaches the caller, each address gets a second try, and the next address is tried", async () => {
  const peer = makeNodeKey().publicKey;
  const node = new FakeLnd({ peers: [] });
  dialsLikeLnd(node, 1, (socket) => (socket === "dead.onion:9735" ? "dial proxy failed: connection refused" : null));
  const heard: string[] = [];
  assert.equal(await ensureConnected(node.lnd, peer, ["dead.onion:9735", "1.2.3.4:9735"], (s, e) => heard.push(`${s}: ${e}`)), true);
  assert.deepEqual(heard, ["dead.onion:9735: dial proxy failed: connection refused"]);

  const other = makeNodeKey().publicKey;
  const refused = new FakeLnd({ peers: [] });
  dialsLikeLnd(refused, 1, () => "dial tcp: connection refused");
  const told: string[] = [];
  assert.equal(await ensureConnected(refused.lnd, other, ["1.2.3.4:9735"], (s, e) => told.push(`${s}: ${e}`)), false);
  assert.equal(refused.callsTo("default.connectPeer").length, 2, "twice round: Tor circuits fail at random");
  assert.deepEqual(told, ["1.2.3.4:9735: dial tcp: connection refused", "1.2.3.4:9735: dial tcp: connection refused"]);
});

test("an open says why the peer couldn't be reached", async () => {
  const peer = makeNodeKey().publicKey;
  const node = new FakeLnd({ peers: [] });
  dialsLikeLnd(node, 1, () => "dial tcp: connection refused");
  const res = await connectForOpen(node.lnd, { pubkey: peer, socket: "1.2.3.4:9735" });
  assert.equal(res.ok, false);
  assert.match(res.ok ? "" : res.error, /^couldn't connect to .*— the peer looks offline\. Try again later\. \(1\.2\.3\.4:9735: dial tcp: connection refused/);
});

test("a peer already connected isn't dialed; 'already connected' from LND counts as connected", async () => {
  const peer = makeNodeKey().publicKey;
  const connected = new FakeLnd({ peers: [peer] });
  assert.equal(await ensureConnected(connected.lnd, peer, ["1.2.3.4:9735"]), true);
  assert.equal(connected.callsTo("default.connectPeer").length, 0);
  const racing = new FakeLnd({ peers: [] });
  racing.override("default.connectPeer", (a, cb) => {
    racing.peers.push((a.addr as { pubkey: string }).pubkey);
    cb({ message: "already connected to peer", details: "already connected to peer" });
  });
  assert.equal(await ensureConnected(racing.lnd, peer, ["1.2.3.4:9735"]), true);
});

test("silent addresses can't use up the budget: each gets its share, and a live third is reached", async () => {
  const peer = makeNodeKey().publicKey;
  const node = new FakeLnd({ peers: [] });
  node.override("default.connectPeer", (a, cb) => {
    const addr = a.addr as { pubkey: string; host: string };
    if (addr.host !== "5.6.7.8:9735") return; // never answers
    node.peers.push(addr.pubkey);
    cb(null, {});
  });
  const heard: string[] = [];
  const ok = await ensureConnected(node.lnd, peer, ["1.1.1.1:9735", "2.2.2.2:9735", "5.6.7.8:9735"], (s, e) => heard.push(`${s}: ${e}`), 3_000);
  assert.equal(ok, true);
  assert.deepEqual(heard, ["1.1.1.1:9735: no answer within 1 s", "2.2.2.2:9735: no answer within 1 s"]);
});

test("addresses are dialed the way LND takes them, each once, onions first", async () => {
  const peer = makeNodeKey().publicKey;
  const node = new FakeLnd({ peers: [] });
  dialsLikeLnd(node, 1, () => "refused");
  const onion = `${"a".repeat(56)}.onion:9735`;
  await ensureConnected(node.lnd, peer, ["1.2.3.4:9735", `${peer}@1.2.3.4:9735`, onion, ""]);
  const hosts = node.callsTo("default.connectPeer").map((c) => (c.addr as { host: string }).host);
  assert.deepEqual(hosts, [onion, "1.2.3.4:9735", onion, "1.2.3.4:9735"]);
});

test("a buyer with no address known says so, and nothing is dialed", async () => {
  const peer = makeNodeKey().publicKey;
  const node = new FakeLnd({ peers: [] });
  const heard: string[] = [];
  assert.equal(await ensureConnected(node.lnd, peer, [], (s, e) => heard.push(`${s}|${e}`)), false);
  assert.deepEqual(heard, ["|no address of it is known"]);
  assert.equal(node.callsTo("default.connectPeer").length, 0);
});

test("LND has no invoice at all: an invoice is missing, not an error", async () => {
  const node = new FakeLnd({ peers: [] });
  node.override("default.lookupInvoice", (_a, cb) => cb({ details: "there are no existing invoices" }));
  assert.equal((await hodlStatus(node.lnd, "ab".repeat(32))).state, "missing");
  assert.match("there are no existing invoices", INVOICE_NOT_FOUND);
});
