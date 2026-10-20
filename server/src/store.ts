import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Durable JSON-file store under the app data dir — autopilot config, LSPS1
 * orders (incl. hold-invoice preimages), the Amboss key, accounting logs.
 *
 * Writes are ATOMIC: the new content goes to a temp file that is fsync'd and
 * then renamed over the target. rename(2) is atomic on ext4 (and NTFS), so a
 * power cut or a full disk leaves either the old file or the new one — never a
 * truncated mix. The previous version is kept as `<name>.bak` (a hard link, so
 * no data is copied).
 *
 * Reads never silently fall back to defaults on a damaged file: the file is
 * moved aside to `<name>.corrupt-<timestamp>` (kept for the operator), the
 * `.bak` is tried, and the event is recorded as a store INCIDENT that the API
 * surfaces as an alert until the operator acknowledges it. Before this, a torn
 * autopilot.json quietly came back as "everything off" and the next write
 * destroyed the evidence. A MISSING file is handled the same way whenever its
 * `.bak` or a quarantined copy shows the store had state; only a first start,
 * with neither, returns the defaults quietly.
 */

// ── atomic file write ─────────────────────────────────────────────────────────

let tmpCounter = 0;

/** Best-effort fsync of a directory so the rename itself is durable. Windows
 *  can't open a directory for fsync — NTFS journals the rename anyway. */
function fsyncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some filesystems refuse directory fsync; the data file itself is synced.
  }
}

/** Keep the current file as `<file>.bak` before it is replaced. A hard link
 *  costs no I/O; filesystems without links get a copy instead. Never fatal —
 *  the backup is a second line of defence, not a precondition for saving. */
function keepPreviousAsBackup(file: string): void {
  const bak = `${file}.bak`;
  try {
    rmSync(bak, { force: true });
    linkSync(file, bak);
  } catch {
    try {
      copyFileSync(file, bak);
    } catch {
      // no backup this time — the atomic rename below still protects the file
    }
  }
}

/**
 * Replace `file` with `data` atomically: write a temp file, fsync it, keep the
 * old version as `.bak`, rename the temp file over the target, fsync the dir.
 * Throws on failure — and on failure the original file is untouched.
 */
export function atomicWriteFileSync(file: string, data: string, opts: { keepBackup?: boolean } = {}): void {
  const tmp = `${file}.tmp-${process.pid}-${++tmpCounter}`;
  try {
    // 0600: these files can hold an API key and hold-invoice preimages.
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (opts.keepBackup !== false && existsSync(file)) keepPreviousAsBackup(file);
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // leave the temp file; JsonStore cleans stale ones up on the next start
    }
    throw err;
  }
  fsyncDirectory(dirname(file));
}

// ── incidents ─────────────────────────────────────────────────────────────────

export type StoreIncidentKind =
  /** File was unreadable; the previous version (.bak) was restored. */
  | "recovered"
  /** File was unreadable and no usable backup existed; defaults were used. */
  | "reset"
  /** The latest save failed (e.g. disk full); in-memory state is ahead of disk. */
  | "write_failed"
  /** The file was readable, but values in it were outside today's limits and
   *  its owner adjusted them on load (`detail` lists what changed). Not
   *  damage — but a change the operator didn't make must not be silent. */
  | "adjusted";

export interface StoreIncident {
  id: string;
  /** File name within the data dir, e.g. "autopilot.json". */
  file: string;
  kind: StoreIncidentKind;
  at: string;
  detail: string;
  /** Where the damaged copy was moved to (file name within the data dir). */
  quarantinedAs?: string;
  /** The file itself was gone — not unreadable — while its backup or a
   *  quarantined copy was still there: an earlier recovery cut short (a crash,
   *  a full disk), or a deletion. */
  missing?: boolean;
  /** "recovered" / "reset": what the recovery left in memory (the restored
   *  backup, or the defaults) could not be saved yet — e.g. the disk is full —
   *  so the file is still missing or damaged on disk, and a restart finds this
   *  same loss again. Cleared by the file's next successful save; until then
   *  the loss found again is not reported a second time. */
  unsaved?: boolean;
}

const INCIDENTS_FILE = "state-incidents.json";

/**
 * Per-data-dir incident list. Corruption incidents are persisted (they must
 * survive the restart that usually follows) and stay until acknowledged.
 * Write failures are transient: kept in memory and cleared by the next
 * successful save of the same file.
 */
class IncidentRegistry {
  private readonly file: string;
  private persisted: StoreIncident[];
  private readonly writeFailures = new Map<string, StoreIncident>();

  constructor(dataDir: string) {
    this.file = join(dataDir, INCIDENTS_FILE);
    this.persisted = [];
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
        if (Array.isArray(parsed)) this.persisted = parsed as StoreIncident[];
      }
    } catch {
      // A damaged incident list must not take the app down — start empty.
    }
  }

  list(): StoreIncident[] {
    return [...this.persisted, ...this.writeFailures.values()];
  }

  record(incident: Omit<StoreIncident, "id" | "at">): StoreIncident {
    const full: StoreIncident = { id: randomUUID(), at: new Date().toISOString(), ...incident };
    if (full.kind === "write_failed") {
      // One live entry per file; the first failure's time is the useful one.
      const existing = this.writeFailures.get(full.file);
      if (existing) return existing;
      this.writeFailures.set(full.file, full);
      return full;
    }
    // The same adjustment again (one that could not be saved recurs on every
    // start) stays one alert, not a growing pile. Losses are not merged here:
    // JsonStore tells the same loss found again from a new one (lossReporter),
    // and a new loss must be alerted even when it reads exactly like the last.
    if (full.kind === "adjusted") {
      const same = this.persisted.find(
        (i) => i.file === full.file && i.kind === full.kind && i.detail === full.detail,
      );
      if (same) return same;
    }
    this.persisted.push(full);
    this.save();
    return full;
  }

  clearWriteFailure(file: string): void {
    this.writeFailures.delete(file);
  }

  /** A loss of `file` already reported (and not yet acknowledged) whose
   *  recovered state never reached the disk: finding the file missing again
   *  is that same loss, not a new one. */
  hasUnsavedLoss(file: string, kind: "recovered" | "reset"): boolean {
    return this.persisted.some((i) => i.file === file && i.kind === kind && i.unsaved === true);
  }

  /** `file` was just saved: the losses reported for it are settled on disk,
   *  so losing the file again from now on is a NEW loss. */
  markSaved(file: string): void {
    let changed = false;
    for (const i of this.persisted) {
      if (i.file === file && i.unsaved) {
        delete i.unsaved;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  acknowledge(id: string): boolean {
    const before = this.persisted.length;
    this.persisted = this.persisted.filter((i) => i.id !== id);
    if (this.persisted.length !== before) {
      this.save();
      return true;
    }
    for (const [file, inc] of this.writeFailures) {
      if (inc.id === id) {
        this.writeFailures.delete(file);
        return true;
      }
    }
    return false;
  }

  private save(): void {
    try {
      atomicWriteFileSync(this.file, JSON.stringify(this.persisted, null, 2));
    } catch (err) {
      console.error(`[store] could not save ${INCIDENTS_FILE}:`, err);
    }
  }
}

const registries = new Map<string, IncidentRegistry>();

function registryFor(dataDir: string): IncidentRegistry {
  const key = resolve(dataDir);
  let reg = registries.get(key);
  if (!reg) {
    reg = new IncidentRegistry(key);
    registries.set(key, reg);
  }
  return reg;
}

/** Incidents for a data dir: damaged files found at startup, failing saves,
 *  values adjusted on load. */
export function storeIncidents(dataDir: string): StoreIncident[] {
  return registryFor(dataDir).list();
}

/** Report something a file's owner found or changed on load (e.g. settings
 *  outside today's limits). Persisted and alerted until acknowledged, like a
 *  damaged file. */
export function recordStoreIncident(dataDir: string, incident: Omit<StoreIncident, "id" | "at">): StoreIncident {
  return registryFor(dataDir).record(incident);
}

/** Operator has seen the alert. Returns false for an unknown id. */
export function acknowledgeStoreIncident(dataDir: string, id: string): boolean {
  return registryFor(dataDir).acknowledge(id);
}

// ── the store ─────────────────────────────────────────────────────────────────

/** Arrays must stay arrays and objects objects: a file holding `null` or the
 *  wrong JSON type is as unusable as a torn one. */
function sameShape(value: unknown, fallback: unknown): boolean {
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (fallback !== null && typeof fallback === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  return value !== undefined;
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export interface JsonStoreOptions {
  /** The file holds a secret (an API key). A damaged file is then reported
   *  without the parser's message: JSON.parse quotes the bytes around the
   *  error, and that text goes to the log and the incident list. */
  secret?: boolean;
}

export class JsonStore<T> {
  private readonly file: string;
  private readonly dataDir: string;
  readonly name: string;
  private readonly secret: boolean;
  /** The file on disk is known damaged and could not be moved aside: the next
   *  save must not turn it into the `.bak` (that would replace a good backup). */
  private damagedInPlace = false;

  constructor(dataDir: string, name: string, opts: JsonStoreOptions = {}) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.name = name;
    this.file = join(dataDir, name);
    this.secret = opts.secret === true;
    this.removeStaleTempFiles();
  }

  /** Temp files only survive a crash mid-write; they are never the real state. */
  private removeStaleTempFiles(): void {
    try {
      for (const f of readdirSync(this.dataDir)) {
        if (f.startsWith(`${this.name}.tmp-`)) rmSync(join(this.dataDir, f), { force: true });
      }
    } catch {
      // cosmetic cleanup only
    }
  }

  private parse(path: string, fallback: T): { ok: true; value: T } | { ok: false; error: string } {
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (!sameShape(value, fallback)) return { ok: false, error: "unexpected JSON shape" };
      return { ok: true, value: value as T };
    } catch (err) {
      // e.g. `Unexpected token 'S', ..."apiKey": SECRET-KEY"... is not valid JSON`
      if (this.secret && err instanceof SyntaxError) return { ok: false, error: "not valid JSON" };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private get bakFile(): string {
    return `${this.file}.bak`;
  }

  /** A quarantine name no earlier copy has (two in the same millisecond must
   *  not overwrite each other: rename replaces an existing target). */
  private freeQuarantineName(): string {
    const base = `${this.name}.corrupt-${timestampForFileName()}`;
    let name = base;
    for (let n = 1; existsSync(join(this.dataDir, name)); n++) name = `${base}-${n}`;
    return name;
  }

  /** Move a damaged file (the main file or its `.bak`) aside so nothing ever
   *  overwrites the evidence. Returns its new name within the data dir. */
  private quarantine(path: string): string | undefined {
    const target = this.freeQuarantineName();
    try {
      renameSync(path, join(this.dataDir, target));
      return target;
    } catch {
      try {
        copyFileSync(path, join(this.dataDir, target));
        rmSync(path, { force: true });
        return target;
      } catch {
        return undefined;
      }
    }
  }

  /** The most recent quarantined copy of this file, if any. The timestamp in
   *  the name sorts in time order. */
  private latestQuarantined(): string | undefined {
    try {
      return readdirSync(this.dataDir)
        .filter((f) => f.startsWith(`${this.name}.corrupt-`))
        .sort()
        .at(-1);
    } catch {
      return undefined;
    }
  }

  /**
   * Load the stored value. A damaged file is quarantined and reported: the
   * previous version is restored from `.bak` when possible, else `fallback` is
   * used. A missing file is a normal first start and returns `fallback` —
   * unless a backup or a quarantined copy shows there was state (readMissing).
   */
  read(fallback: T): T {
    if (!existsSync(this.file)) return this.readMissing(fallback);
    const main = this.parse(this.file, fallback);
    if (main.ok) return main.value;

    const quarantinedAs = this.quarantine(this.file);
    if (!quarantinedAs) this.damagedInPlace = true;
    const report = this.lossReporter();
    const bak = this.restoreBackup(fallback);
    if (bak.ok) {
      console.error(
        `[store] ${this.name} was unreadable (${main.error}) — restored the previous version from ${this.name}.bak; ` +
          `damaged copy kept as ${quarantinedAs ?? "(could not move it)"}`,
      );
      report({ kind: "recovered", detail: main.error, quarantinedAs, unsaved: !bak.saved });
      return bak.value;
    }
    console.error(
      `[store] ${this.name} was unreadable (${main.error}) and no usable backup exists — starting from defaults; ` +
        `damaged copy kept as ${quarantinedAs ?? "(could not move it)"}`,
    );
    const saved = this.resetTo(fallback);
    report({ kind: "reset", detail: main.error, quarantinedAs, unsaved: !saved });
    return fallback;
  }

  /**
   * No main file, but a `.bak` or a quarantined copy beside it: this store
   * HAD state. An earlier recovery moved the damaged file aside and never got
   * to write its replacement — a crash in between, or a full disk — or the
   * file was deleted. Restore the backup, or report that defaults are used;
   * never start over silently. (Before, this returned defaults without a
   * word: for lsps1-orders.json that dropped held orders and their preimages,
   * for overrides.json the exclusions, for amboss.json the key.)
   */
  private readMissing(fallback: T): T {
    const lastDamaged = this.latestQuarantined();
    if (!existsSync(this.bakFile) && lastDamaged === undefined) return fallback; // a first start
    const report = this.lossReporter();
    const bak = this.restoreBackup(fallback);
    if (bak.ok) {
      console.error(`[store] ${this.name} was missing — restored the previous version from ${this.name}.bak`);
      report({
        kind: "recovered",
        detail: "the file was missing; its backup was restored",
        quarantinedAs: lastDamaged,
        missing: true,
        unsaved: !bak.saved,
      });
      return bak.value;
    }
    const kept = bak.damagedCopy ?? lastDamaged;
    console.error(
      `[store] ${this.name} was missing and no usable backup exists — starting from defaults` +
        (kept ? `; most recent damaged copy: ${kept}` : ""),
    );
    const saved = this.resetTo(fallback);
    report({
      kind: "reset",
      detail: bak.error ? `the file was missing and its backup is unreadable (${bak.error})` : "the file was missing",
      quarantinedAs: kept,
      missing: true,
      unsaved: !saved,
    });
    return fallback;
  }

  /**
   * Records a loss of this file as an incident — unless it is the same loss
   * found again: one already reported (and not acknowledged) whose recovered
   * state never reached the disk, because the disk is still full, so the file
   * is still missing or damaged. That stays one alert. Judged per outcome (a
   * backup restored then but unusable now is a new loss), and only while
   * nothing has been saved since: losing the file once it was back on disk is
   * a new loss, however long the earlier alert has been up. Create it BEFORE
   * the recovery saves anything — a save settles the earlier losses.
   */
  private lossReporter(): (incident: Omit<StoreIncident, "id" | "at" | "file"> & { kind: "recovered" | "reset" }) => void {
    const registry = registryFor(this.dataDir);
    const reported = {
      recovered: registry.hasUnsavedLoss(this.name, "recovered"),
      reset: registry.hasUnsavedLoss(this.name, "reset"),
    };
    return (incident) => {
      if (!reported[incident.kind]) registry.record({ file: this.name, ...incident });
    };
  }

  /**
   * Bring back `.bak` when it is usable, and put it in place as the main file
   * right away, so a restart before the next save finds it there. A damaged
   * `.bak` is moved aside like a damaged main file: it may be the only copy
   * left, and the next saves would replace it.
   */
  private restoreBackup(
    fallback: T,
  ): { ok: true; value: T; saved: boolean } | { ok: false; error?: string; damagedCopy?: string } {
    if (!existsSync(this.bakFile)) return { ok: false };
    const bak = this.parse(this.bakFile, fallback);
    if (!bak.ok) return { ok: false, error: bak.error, damagedCopy: this.quarantine(this.bakFile) };
    try {
      this.replaceFile(readFileSync(this.bakFile, "utf8"), false);
      this.damagedInPlace = false;
      registryFor(this.dataDir).markSaved(this.name);
      return { ok: true, value: bak.value, saved: true };
    } catch {
      // the in-memory value is still the recovered one; the next save (or start) retries
      return { ok: true, value: bak.value, saved: false };
    }
  }

  /** No usable state: save the defaults as the file from now on, so the next
   *  start doesn't find it missing and report the same loss again. Never over
   *  a damaged file that could not be moved aside (that is the evidence).
   *  Returns whether the defaults reached the disk. */
  private resetTo(fallback: T): boolean {
    return !this.damagedInPlace && this.write(fallback);
  }

  /**
   * Save atomically. Never throws: a failure is logged, recorded as an
   * incident (surfaced as an alert) and reported via the return value.
   */
  write(value: T): boolean {
    try {
      this.writeOrThrow(value);
      return true;
    } catch (err) {
      console.error(`[store] FAILED to save ${this.name}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Save atomically, throwing on failure. For fund-critical callers that
   *  must not move money when they cannot record that they did. The failure
   *  is recorded as an incident either way, so the operator sees it.
   *  `keepBackup: false` keeps no `.bak` of the version being replaced (for a
   *  secret that is being replaced or removed). */
  writeOrThrow(value: T, opts: { keepBackup?: boolean } = {}): void {
    const registry = registryFor(this.dataDir);
    try {
      this.replaceFile(JSON.stringify(value, null, 2), opts.keepBackup !== false && !this.damagedInPlace);
      this.damagedInPlace = false;
    } catch (err) {
      registry.record({
        file: this.name,
        kind: "write_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    registry.clearWriteFailure(this.name);
    registry.markSaved(this.name);
  }

  /** Every write of the file goes through here — saves and restores alike (a
   *  test makes it fail the way a full disk does). */
  private replaceFile(data: string, keepBackup: boolean): void {
    atomicWriteFileSync(this.file, data, { keepBackup });
  }

  /**
   * Delete every other copy of this file: the `.bak` and the damaged copies
   * moved aside. For a store whose secret was just replaced or removed — a
   * copy left behind would hold the old one, and a later recovery could bring
   * it back. Returns false when a copy could not be deleted (logged).
   */
  discardCopies(): boolean {
    let names: string[] = [];
    try {
      names = readdirSync(this.dataDir).filter((f) => f === `${this.name}.bak` || f.startsWith(`${this.name}.corrupt-`));
    } catch (err) {
      console.error(`[store] could not list the copies of ${this.name}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    let ok = true;
    for (const f of names) {
      try {
        rmSync(join(this.dataDir, f), { force: true });
      } catch (err) {
        ok = false;
        console.error(`[store] could not delete ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return ok;
  }

  /** Delete the file and every copy of it. Unlike a save this needs no free
   *  space, so it still works on a full disk; the next start reads no file as
   *  a first start. Returns false when something could not be deleted (logged;
   *  the file itself staying is also alerted, like a failed save — the next
   *  start would read it back). */
  erase(): boolean {
    const copiesGone = this.discardCopies();
    try {
      rmSync(this.file, { force: true });
      this.damagedInPlace = false;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      console.error(`[store] could not delete ${this.name}: ${why}`);
      registryFor(this.dataDir).record({ file: this.name, kind: "write_failed", detail: `could not delete it: ${why}` });
      return false;
    }
    return copiesGone;
  }
}
