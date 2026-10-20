import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  JsonStore,
  acknowledgeStoreIncident,
  recordStoreIncident,
  storeIncidents,
  type StoreIncident,
} from "../src/store.js";
import { stateAlerts } from "../src/services/alerts.js";
import { makeTempDir } from "./helpers/tmp.js";

interface Cfg {
  enabled: boolean;
  n: number;
}
const DEFAULTS: Cfg = { enabled: false, n: 0 };
const incidentsFor = (dir: string, file: string) => storeIncidents(dir).filter((i) => i.file === file);

test("write replaces the file atomically and keeps the previous version as .bak", (t) => {
  const dir = makeTempDir(t);
  const store = new JsonStore<Cfg>(dir, "cfg.json");
  assert.equal(store.write({ enabled: true, n: 1 }), true);
  assert.equal(store.write({ enabled: true, n: 2 }), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8")), { enabled: true, n: 2 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "cfg.json.bak"), "utf8")), { enabled: true, n: 1 });
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes(".tmp-")),
    [],
    "no temp files left behind",
  );
});

test("a crash mid-write leaves the old file intact and the stale temp file is cleaned up", (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "cfg.json"), JSON.stringify({ enabled: true, n: 7 }));
  // What a power cut during the old in-place write — or during our temp write — leaves behind.
  writeFileSync(join(dir, "cfg.json.tmp-999-1"), '{"enabled": tr');
  const store = new JsonStore<Cfg>(dir, "cfg.json");
  assert.deepEqual(store.read(DEFAULTS), { enabled: true, n: 7 });
  assert.equal(existsSync(join(dir, "cfg.json.tmp-999-1")), false);
});

test("a torn file is quarantined and the previous version restored from .bak", (t) => {
  const dir = makeTempDir(t);
  const seed = new JsonStore<Cfg>(dir, "cfg.json");
  seed.write({ enabled: true, n: 1 });
  seed.write({ enabled: true, n: 2 });
  const torn = '{"enabled": true, "n": 3'; // power cut mid-write (pre-atomic versions)
  writeFileSync(join(dir, "cfg.json"), torn);

  const value = new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS);
  assert.deepEqual(value, { enabled: true, n: 1 }, "the .bak (previous good save) is used, not defaults");
  const [incident] = incidentsFor(dir, "cfg.json");
  assert.equal(incident.kind, "recovered");
  assert.ok(incident.quarantinedAs);
  assert.equal(readFileSync(join(dir, incident.quarantinedAs), "utf8"), torn, "damaged bytes kept for the operator");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8")), { enabled: true, n: 1 }, "main file restored");
});

test("a torn file without a backup is reported, not silently reset, and never overwritten", (t) => {
  const dir = makeTempDir(t);
  const torn = '{"enabled": tru';
  writeFileSync(join(dir, "cfg.json"), torn);
  const store = new JsonStore<Cfg>(dir, "cfg.json");
  assert.deepEqual(store.read(DEFAULTS), DEFAULTS);
  const [incident] = incidentsFor(dir, "cfg.json");
  assert.equal(incident.kind, "reset");
  // The app's next save must not destroy the evidence.
  store.write(DEFAULTS);
  assert.equal(readFileSync(join(dir, incident.quarantinedAs as string), "utf8"), torn);
  // Persisted, so the alert survives the restart that usually follows.
  const onDisk = JSON.parse(readFileSync(join(dir, "state-incidents.json"), "utf8")) as { id: string }[];
  assert.ok(onDisk.some((i) => i.id === incident.id));

  assert.equal(acknowledgeStoreIncident(dir, incident.id), true);
  assert.equal(incidentsFor(dir, "cfg.json").length, 0);
});

test("a first start — no file, no backup, no damaged copy — is silent and writes nothing", (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "other.json.corrupt-2026-10-20T00-00-00-000Z"), "{"); // another file's history
  assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), DEFAULTS);
  assert.equal(incidentsFor(dir, "cfg.json").length, 0);
  assert.equal(existsSync(join(dir, "cfg.json")), false);
});

test("a missing file whose backup survived is restored and reported — not silently reset", (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "error", () => undefined);
  const seed = new JsonStore<Cfg>(dir, "cfg.json");
  seed.write({ enabled: true, n: 1 });
  seed.write({ enabled: true, n: 2 });
  // What a recovery cut short leaves behind: the damaged file was moved
  // aside, and the restore from .bak never landed (a crash, a full disk).
  renameSync(join(dir, "cfg.json"), join(dir, "cfg.json.corrupt-2026-10-20T00-00-00-000Z"));

  const value = new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS);
  // Before: no main file meant "first start" — defaults without a word, and
  // the next save made them the state for good.
  assert.deepEqual(value, { enabled: true, n: 1 }, "the backup, not the defaults");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8")), value, "and it is back in place");
  const [incident] = incidentsFor(dir, "cfg.json");
  assert.equal(incident?.kind, "recovered");
  assert.equal(incident.missing, true);
  assert.equal(incident.quarantinedAs, "cfg.json.corrupt-2026-10-20T00-00-00-000Z");
  assert.ok(
    stateAlerts(dir).some((a) => /^cfg\.json was missing and has been restored from its previous version\./.test(a.message)),
    JSON.stringify(stateAlerts(dir)),
  );

  // The next start finds the file in place: nothing new to report.
  assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), value);
  assert.equal(incidentsFor(dir, "cfg.json").length, 1);
});

test("a missing file with only a damaged copy left is reported as a reset — once", (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "error", () => undefined);
  writeFileSync(join(dir, "cfg.json.corrupt-2026-10-19T08-00-00-000Z"), "{}");
  writeFileSync(join(dir, "cfg.json.corrupt-2026-10-20T00-00-00-000Z"), '{"enabled": tr');

  assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), DEFAULTS);
  const [incident] = incidentsFor(dir, "cfg.json");
  assert.equal(incident?.kind, "reset", "defaults, but not silently");
  assert.equal(incident.missing, true);
  assert.equal(incident.quarantinedAs, "cfg.json.corrupt-2026-10-20T00-00-00-000Z", "the most recent damaged copy");
  assert.ok(
    stateAlerts(dir).some((a) => a.message.includes("The most recent damaged copy is kept as cfg.json.corrupt-2026-10-20T00-00-00-000Z.")),
  );

  // The defaults are saved as the file, so once the operator has seen the
  // alert, the next start is an ordinary one and doesn't raise it again.
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8")), DEFAULTS);
  assert.equal(acknowledgeStoreIncident(dir, incident.id), true);
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS);
  assert.equal(incidentsFor(dir, "cfg.json").length, 0);
});

test("a missing file whose backup is damaged too: the backup is kept for the operator, and the reset reported", (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "error", () => undefined);
  const tornBackup = '{"enabled": true, "n"';
  writeFileSync(join(dir, "cfg.json.bak"), tornBackup);

  assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), DEFAULTS);
  const [incident] = incidentsFor(dir, "cfg.json");
  assert.equal(incident?.kind, "reset");
  assert.match(incident.detail, /^the file was missing and its backup is unreadable/);
  assert.ok(incident.quarantinedAs);
  // Left as .bak, the next saves would have replaced it.
  assert.equal(readFileSync(join(dir, incident.quarantinedAs), "utf8"), tornBackup, "moved aside, bytes intact");
  assert.equal(existsSync(join(dir, "cfg.json.bak")), false);
});

test("a damaged file and its damaged backup, moved aside in the same millisecond, don't overwrite each other", (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "error", () => undefined);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T00:00:00.000Z") }); // one timestamp for both
  writeFileSync(join(dir, "cfg.json"), '{"enabled": tru');
  writeFileSync(join(dir, "cfg.json.bak"), '{"enabled": true, "n"');

  assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), DEFAULTS);
  const kept = readdirSync(dir)
    .filter((f) => f.startsWith("cfg.json.corrupt-"))
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .sort();
  // rename() replaces an existing target: with one name for both, the
  // backup's bytes would have wiped out the damaged file's.
  assert.deepEqual(kept, ['{"enabled": tru', '{"enabled": true, "n"']);
});

test("a reset whose defaults can't be saved (disk still full) stays one alert across restarts", (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "error", () => undefined);
  writeFileSync(join(dir, "cfg.json"), '{"enabled": tru');
  const full = t.mock.method(JsonStore.prototype, "writeOrThrow", () => {
    throw new Error("ENOSPC: no space left on device");
  });

  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS); // damaged: quarantined, reset
  assert.equal(existsSync(join(dir, "cfg.json")), false, "the defaults could not be saved");
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS); // restart: missing, same damaged copy
  const incidents = incidentsFor(dir, "cfg.json");
  assert.equal(incidents.length, 1, JSON.stringify(incidents));
  assert.equal(incidents[0].kind, "reset");

  full.mock.restore(); // space again
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "cfg.json"), "utf8")), DEFAULTS, "saved at last");
  assert.equal(incidentsFor(dir, "cfg.json").length, 1);
});

/** From now on every write of a store's file fails the way a full disk makes
 *  it fail — saves and restores alike. `.mock.restore()` frees space again. */
function diskFull(t: TestContext) {
  t.mock.method(console, "error", () => undefined);
  return t.mock.method(JsonStore.prototype as unknown as { replaceFile(): void }, "replaceFile", () => {
    throw new Error("ENOSPC: no space left on device");
  });
}

/** The loss alerts (damaged / missing file) for one file — not the transient
 *  "could not save" ones a full disk adds. */
const lossesFor = (dir: string, file: string) => incidentsFor(dir, file).filter((i) => i.kind !== "write_failed");

test("an earlier restore still on screen doesn't hide a later total loss", (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "error", () => undefined);
  type Orders = { id: string; preimage: string }[];
  const name = "lsps1-orders.json";
  const seed = new JsonStore<Orders>(dir, name);
  seed.write([{ id: "a", preimage: "p1" }]);
  seed.write([{ id: "a", preimage: "p1" }, { id: "b", preimage: "p2" }]);
  writeFileSync(join(dir, name), '[{"id": '); // damaged → restored from .bak
  assert.equal(new JsonStore<Orders>(dir, name).read([]).length, 1);
  assert.deepEqual(lossesFor(dir, name).map((i) => i.kind), ["recovered"]);

  // Days later, the alert still up: the file AND its backup are gone.
  rmSync(join(dir, name));
  rmSync(join(dir, `${name}.bak`));
  assert.deepEqual(new JsonStore<Orders>(dir, name).read([]), []);
  // Before: the earlier "restored" alert named the same damaged copy, so this
  // loss counted as already reported — the orders were dropped in silence.
  const reset = lossesFor(dir, name).find((i) => i.kind === "reset");
  assert.ok(reset, JSON.stringify(lossesFor(dir, name)));
  assert.equal(reset.missing, true);
  assert.ok(
    stateAlerts(dir).some((a) => a.message.startsWith("lsps1-orders.json was missing and no backup was usable, so it was reset.")),
  );
});

test("an earlier reset still on screen doesn't hide a later loss that reads exactly like it", (t) => {
  const dir = makeTempDir(t);
  t.mock.method(console, "error", () => undefined);
  writeFileSync(join(dir, "cfg.json.corrupt-2026-10-20T00-00-00-000Z"), '{"enabled": tru');
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS); // missing → reset, defaults saved
  const store = new JsonStore<Cfg>(dir, "cfg.json");
  store.write({ enabled: true, n: 5 }); // the operator sets things up again …
  store.write({ enabled: true, n: 6 });
  rmSync(join(dir, "cfg.json")); // … and later it is all lost
  rmSync(join(dir, "cfg.json.bak"));

  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS);
  // Same file, same wording, same newest damaged copy as the first alert —
  // but a new loss: before, it was merged into the alert already up.
  const losses = lossesFor(dir, "cfg.json");
  assert.equal(losses.length, 2, "a second loss, a second alert");
  assert.deepEqual(
    losses.map((i) => [i.kind, i.detail, i.quarantinedAs]),
    [
      ["reset", "the file was missing", "cfg.json.corrupt-2026-10-20T00-00-00-000Z"],
      ["reset", "the file was missing", "cfg.json.corrupt-2026-10-20T00-00-00-000Z"],
    ],
  );
});

test("a restore that finally reaches the disk settles the loss: losing the file again is new", (t) => {
  const dir = makeTempDir(t);
  const seed = new JsonStore<Cfg>(dir, "cfg.json");
  seed.write({ enabled: true, n: 1 });
  seed.write({ enabled: true, n: 2 });
  renameSync(join(dir, "cfg.json"), join(dir, "cfg.json.corrupt-2026-10-20T00-00-00-000Z")); // a recovery cut short
  const full = diskFull(t);
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS); // restored in memory only
  full.mock.restore();
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS); // the same loss: restored, now on disk
  assert.ok(existsSync(join(dir, "cfg.json")));
  assert.equal(lossesFor(dir, "cfg.json").length, 1);

  rmSync(join(dir, "cfg.json")); // gone again, before anything else was saved
  assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), { enabled: true, n: 1 });
  assert.equal(lossesFor(dir, "cfg.json").length, 2);
});

test("a loss found again because the disk is still full stays one alert, however it began", (t) => {
  const GOOD = JSON.stringify({ enabled: true, n: 1 });
  const scenarios: [string, Record<string, string>, Cfg, StoreIncident["kind"]][] = [
    // Before: from the second start on, the backup's damaged copy (the newest)
    // wasn't the one the first alert named — a second alert for one loss.
    ["damaged file, damaged backup", { "cfg.json": '{"enabled": tru', "cfg.json.bak": '{"enabled": true, "n"' }, DEFAULTS, "reset"],
    ["damaged file, good backup", { "cfg.json": '{"enabled": tru', "cfg.json.bak": GOOD }, { enabled: true, n: 1 }, "recovered"],
    ["missing file, only a damaged copy", { "cfg.json.corrupt-2026-10-20T00-00-00-000Z": "{" }, DEFAULTS, "reset"],
    ["missing file, good backup", { "cfg.json.bak": GOOD }, { enabled: true, n: 1 }, "recovered"],
  ];
  const full = diskFull(t);
  for (const [what, files, value, kind] of scenarios) {
    const dir = makeTempDir(t);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    for (let start = 1; start <= 3; start++) {
      assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), value, `${what}, start ${start}`);
      assert.deepEqual(
        lossesFor(dir, "cfg.json").map((i) => i.kind),
        [kind],
        `${what}, start ${start}`,
      );
    }
  }
  full.mock.restore();
});

test("once the file could be saved again, losing it again is a new loss", (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "cfg.json"), '{"enabled": tru');
  const full = diskFull(t);
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS); // reset, nothing saved
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS); // the same loss, found again
  assert.equal(lossesFor(dir, "cfg.json").length, 1);

  full.mock.restore(); // space again: the next start saves the defaults
  const store = new JsonStore<Cfg>(dir, "cfg.json");
  store.read(DEFAULTS);
  assert.ok(existsSync(join(dir, "cfg.json")));
  assert.equal(lossesFor(dir, "cfg.json").length, 1);

  store.write({ enabled: true, n: 3 });
  rmSync(join(dir, "cfg.json"));
  rmSync(join(dir, "cfg.json.bak"));
  new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS);
  assert.equal(lossesFor(dir, "cfg.json").length, 2, "reported, although the first alert is still up");
});

test("a backup restored on a full disk, then deleted to free space, is a new loss", (t) => {
  const dir = makeTempDir(t);
  const seed = new JsonStore<Cfg>(dir, "cfg.json");
  seed.write({ enabled: true, n: 1 });
  seed.write({ enabled: true, n: 2 });
  renameSync(join(dir, "cfg.json"), join(dir, "cfg.json.corrupt-2026-10-20T00-00-00-000Z")); // a recovery cut short
  diskFull(t);
  assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), { enabled: true, n: 1 });
  assert.equal(existsSync(join(dir, "cfg.json")), false, "the restore could not be saved");
  assert.deepEqual(lossesFor(dir, "cfg.json").map((i) => i.kind), ["recovered"]);

  rmSync(join(dir, "cfg.json.bak")); // the operator deletes backups to make room
  assert.deepEqual(new JsonStore<Cfg>(dir, "cfg.json").read(DEFAULTS), DEFAULTS);
  // The alert up says "restored from its previous version" — no longer true.
  assert.deepEqual(lossesFor(dir, "cfg.json").map((i) => i.kind), ["recovered", "reset"]);
});

test("valid JSON of the wrong shape counts as damaged", (t) => {
  const dir = makeTempDir(t);
  writeFileSync(join(dir, "list.json"), "null");
  assert.deepEqual(new JsonStore<number[]>(dir, "list.json").read([]), []);
  assert.equal(incidentsFor(dir, "list.json")[0]?.kind, "reset");
});

test("the same report again (an adjustment that couldn't be saved recurs every start) stays one alert", (t) => {
  const dir = makeTempDir(t);
  const report = { file: "autopilot.json", kind: "adjusted" as const, detail: "channelSizeSats: 15000 is below 20000" };
  const first = recordStoreIncident(dir, report);
  assert.equal(recordStoreIncident(dir, report).id, first.id);
  assert.equal(incidentsFor(dir, "autopilot.json").length, 1);
  assert.equal(acknowledgeStoreIncident(dir, first.id), true);
  recordStoreIncident(dir, report);
  assert.equal(incidentsFor(dir, "autopilot.json").length, 1, "once acknowledged, a new occurrence is reported again");
});

test("a failing save is reported and clears once saving works again", (t) => {
  const dir = makeTempDir(t);
  const store = new JsonStore<Cfg>(dir, "cfg.json");
  // A directory where the file should be makes the rename fail on every OS.
  mkdirSync(join(dir, "cfg.json"));
  assert.equal(store.write({ enabled: true, n: 1 }), false);
  assert.throws(() => store.writeOrThrow({ enabled: true, n: 1 }));
  assert.equal(incidentsFor(dir, "cfg.json")[0]?.kind, "write_failed");
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes(".tmp-")),
    [],
    "failed attempt cleans its temp file",
  );

  rmSync(join(dir, "cfg.json"), { recursive: true });
  assert.equal(store.write({ enabled: true, n: 1 }), true);
  assert.equal(incidentsFor(dir, "cfg.json").length, 0);
});
