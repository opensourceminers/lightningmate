import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BackupStore, exportScb, getBackupStatus } from "../src/services/backup.js";
import { FakeLnd, type FakeChannel } from "./helpers/fakeLnd.js";
import { startApi } from "./helpers/apiHarness.js";
import { makeTempDir } from "./helpers/tmp.js";

const PEER = "02" + "11".repeat(32);
const chan = (txidByte: string, vout = 0): FakeChannel => ({
  partnerPublicKey: PEER,
  capacity: 2_000_000,
  localBalance: 1_000_000,
  transactionId: txidByte.repeat(32),
  transactionVout: vout,
});

test("one close plus one open keeps the count — and the backup is still reported stale", async (t) => {
  const node = new FakeLnd({ channels: [chan("aa"), chan("bb")] });
  const store = new BackupStore(makeTempDir(t));
  assert.equal((await exportScb(node.lnd, store)).ok, true);
  assert.equal((await getBackupStatus(node.lnd, store)).stale, false);

  node.channels = [chan("bb"), chan("cc")]; // aa closed, cc opened: still 2 channels
  const status = await getBackupStatus(node.lnd, store);
  assert.equal(status.currentChannelCount, 2);
  assert.equal(status.lastExportChannelCount, 2);
  assert.equal(status.stale, true, "a channel is missing from the backup");
  assert.equal(status.notInBackupCount, 1);
  assert.match(status.reason, /not in your last backup/);
});

test("a channel that is still opening must be in the backup too", async (t) => {
  const node = new FakeLnd({ channels: [chan("aa")] });
  const store = new BackupStore(makeTempDir(t));
  await exportScb(node.lnd, store);
  node.pending.push({ partnerPublicKey: PEER, capacity: 1_000_000, transactionId: "dd".repeat(32), transactionVout: 1 });
  const status = await getBackupStatus(node.lnd, store);
  assert.equal(status.stale, true);
  assert.equal(status.notInBackupCount, 1);

  // Exporting now covers it (LND's SCB includes pending opens).
  await exportScb(node.lnd, store);
  assert.equal((await getBackupStatus(node.lnd, store)).stale, false);
});

test("closing channels don't nag; fully closed ones ask for a tidy re-export", async (t) => {
  const node = new FakeLnd({ channels: [chan("aa"), chan("bb")] });
  const store = new BackupStore(makeTempDir(t));
  await exportScb(node.lnd, store);

  // bb starts closing: LND still tracks (and backs up) it.
  node.channels = [chan("aa")];
  node.pending.push({ ...chan("bb"), state: "waiting_close" });
  assert.equal((await getBackupStatus(node.lnd, store)).stale, false);

  node.pending = []; // close confirmed
  const status = await getBackupStatus(node.lnd, store);
  assert.equal(status.stale, true);
  assert.equal(status.notInBackupCount, 0);
  assert.equal(status.closedSinceExportCount, 1);
});

test("a backup recorded by the count-only version asks for one fresh export", async (t) => {
  const dir = makeTempDir(t);
  writeFileSync(
    join(dir, "backup.json"),
    JSON.stringify({ lastExportAt: new Date().toISOString(), lastExportChannelCount: 1 }),
  );
  const node = new FakeLnd({ channels: [chan("aa")] });
  const status = await getBackupStatus(node.lnd, new BackupStore(dir));
  assert.equal(status.stale, true, "counts can't prove which channels it covers");
  assert.match(status.reason, /older version/);
});

test("the export route streams the file and the status route tracks it", async (t) => {
  const node = new FakeLnd({ channels: [chan("aa"), chan("bb")] });
  const api = await startApi(t, { node });
  const exp = await api.request("POST", "/backup/export");
  assert.equal(exp.status, 200);
  assert.equal(exp.headers["x-channel-count"], "2");
  const st = await api.request("GET", "/backup/status");
  assert.equal(st.body.stale, false);
  node.channels = [chan("aa"), chan("ee")];
  assert.equal((await api.request("GET", "/backup/status")).body.stale, true);
});
