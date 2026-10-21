/**
 * Loaded before every test file (`npm test` passes `--import ./test/setup.ts`,
 * and node:test hands it on to each file's process).
 *
 * fsync is a no-op under test. The stores write atomically (temp file, fsync,
 * rename — src/store.ts), and the Magma order journal is saved before every
 * step of an order. On macOS each fsync is a full drive-cache flush
 * (F_FULLFSYNC), so with several test processes running at once they queued
 * on the disk: a test file took 12× longer than alone, and the biggest ones
 * hit the runner's 60 s limit. Skipping the flush changes nothing a test can
 * observe — the temp-file-and-rename logic (what the store tests check) runs
 * unchanged; only durability across a power cut is lost, and no test cuts the
 * power. The app itself always fsyncs.
 */
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

fs.fsyncSync = () => undefined;
// ES-module imports of node:fs (`import { fsyncSync } from "node:fs"`) read
// the builtin's ESM view: bring it in line with the patched object.
syncBuiltinESMExports();
