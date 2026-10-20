/**
 * The Amboss API key is the one secret in the data dir. Every save keeps the
 * previous version as `.bak`, so a key the operator replaced or removed
 * (Disconnect) stayed on disk there — and a later damaged or missing
 * amboss.json restored it: Magma automation (accepting orders, opening
 * channels) running on a key the operator had removed.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JsonStore, storeIncidents } from "../src/store.js";
import { AmbossStore } from "../src/services/ambossStore.js";
import { makeTempDir } from "./helpers/tmp.js";

/** Every file in the data dir whose bytes contain `secret`. */
const filesHolding = (dir: string, secret: string): string[] =>
  readdirSync(dir).filter((f) => readFileSync(join(dir, f), "utf8").includes(secret));

const restart = (dir: string) => new AmbossStore(dir);

function quietErrors(t: TestContext): string[] {
  const logged: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  return logged;
}

test("Disconnect leaves no copy of the key on disk, and nothing brings it back", (t) => {
  const dir = makeTempDir(t);
  quietErrors(t);
  const amboss = new AmbossStore(dir);
  amboss.setKey("SECRET-KEY-1234");
  amboss.setKey("SECRET-KEY-1234"); // connected again with the same key: kept as .bak too
  assert.ok(filesHolding(dir, "SECRET-KEY-1234").length > 0);

  amboss.clear();
  assert.equal(amboss.hasKey(), false);
  assert.deepEqual(filesHolding(dir, "SECRET-KEY-1234"), [], "not in amboss.json, its .bak or anywhere else");
  assert.equal(restart(dir).hasKey(), false);

  // Before: amboss.json.bak still held the key, and a missing or damaged
  // amboss.json was "recovered" from it.
  rmSync(join(dir, "amboss.json"), { force: true });
  assert.equal(restart(dir).hasKey(), false, "after amboss.json goes missing");
  writeFileSync(join(dir, "amboss.json"), '{"apiKey": "');
  assert.equal(restart(dir).hasKey(), false, "after amboss.json is damaged");
});

test("connecting a new key leaves no copy of the old one", (t) => {
  const dir = makeTempDir(t);
  quietErrors(t);
  const amboss = new AmbossStore(dir);
  amboss.setKey("OLD-KEY-5678");
  amboss.setKey("OLD-KEY-5678");
  amboss.setKey("NEW-KEY-9012");
  assert.deepEqual(filesHolding(dir, "OLD-KEY-5678"), []);
  assert.equal(restart(dir).getKey(), "NEW-KEY-9012");

  writeFileSync(join(dir, "amboss.json"), '{"apiKey": "NEW-KEY'); // damaged later
  const after = restart(dir);
  assert.notEqual(after.getKey(), "OLD-KEY-5678", "the replaced key never comes back");
  assert.equal(after.hasKey(), false, "reconnect — as the alert says");
});

test("a replaced key gets no backup at all, even when the clean-up after the save never runs", (t) => {
  const dir = makeTempDir(t);
  quietErrors(t);
  restart(dir).setKey("OLD-KEY-4242");
  // A power cut right after the new key is saved: the old copies are never
  // cleaned up. The save itself must not have made one.
  t.mock.method(JsonStore.prototype, "discardCopies", () => true);
  restart(dir).setKey("NEW-KEY-4343");
  assert.deepEqual(filesHolding(dir, "OLD-KEY-4242"), []);
  assert.equal(restart(dir).getKey(), "NEW-KEY-4343");
});

test("damaged copies of the key are deleted on Disconnect, and never quoted in logs or alerts", (t) => {
  const dir = makeTempDir(t);
  const logged = quietErrors(t);
  restart(dir).setKey("SECRET-KEY-3456");
  // Damaged so that JSON.parse quotes the bytes around the error:
  // `Unexpected token 'S', ..."apiKey": SECRET-KEY"... is not valid JSON`.
  writeFileSync(join(dir, "amboss.json"), '{"apiKey": SECRET-KEY-3456}');

  const amboss = restart(dir);
  assert.equal(amboss.hasKey(), false);
  const [incident] = storeIncidents(dir).filter((i) => i.file === "amboss.json");
  assert.equal(incident?.kind, "reset");
  assert.ok(incident.quarantinedAs && filesHolding(dir, "SECRET").includes(incident.quarantinedAs), "kept for inspection");
  for (const text of [incident.detail, ...logged, readFileSync(join(dir, "state-incidents.json"), "utf8")]) {
    assert.ok(!text.includes("SECRET"), `the key leaked: ${text}`);
  }

  amboss.clear();
  assert.deepEqual(filesHolding(dir, "SECRET-KEY-3456"), [], "the damaged copy held the key too");
});

/** From now on no store file can be written — a full disk. */
const fillDisk = (t: TestContext) =>
  t.mock.method(JsonStore.prototype as unknown as { replaceFile(): void }, "replaceFile", () => {
    throw new Error("ENOSPC: no space left on device");
  });

test("on a full disk, Disconnect still removes the key, and a new key never revives the old one", (t) => {
  const dir = makeTempDir(t);
  quietErrors(t);
  const amboss = new AmbossStore(dir);
  amboss.setKey("OLD-KEY-7777");
  amboss.setKey("OLD-KEY-7777");

  // The new key can't be saved: it works until the next restart (the failed
  // save is alerted), but the old one is gone from disk for good.
  const full = fillDisk(t);
  amboss.setKey("NEW-KEY-8888");
  assert.equal(amboss.getKey(), "NEW-KEY-8888");
  assert.deepEqual(filesHolding(dir, "OLD-KEY-7777"), []);
  assert.ok(storeIncidents(dir).some((i) => i.file === "amboss.json" && i.kind === "write_failed"));
  assert.notEqual(restart(dir).getKey(), "OLD-KEY-7777");

  full.mock.restore();
  amboss.setKey("NEW-KEY-8888"); // saved once there is space again
  assert.equal(restart(dir).getKey(), "NEW-KEY-8888");
  fillDisk(t);
  amboss.clear(); // deleting needs no space
  assert.deepEqual(filesHolding(dir, "NEW-KEY-8888"), []);
  assert.equal(restart(dir).hasKey(), false);
});
