'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createUserDataBackup } = require('../app/main/user-data-backup');

async function sandbox() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hive-udb-'));
  const dataRoot = path.join(dir, 'Hive Data');
  const backupRoot = path.join(dir, 'User Data Backup');
  const udb = createUserDataBackup({ stableDataRoot: () => dataRoot, userBackupRoot: () => backupRoot, fs, path });
  return { dir, dataRoot, backupRoot, udb };
}

test('userBackupPathFor maps a stable-profile file to its backup twin and rejects escapes', async () => {
  const { dir, dataRoot, backupRoot, udb } = await sandbox();
  try {
    assert.equal(udb.userBackupPathFor(path.join(dataRoot, 'playlists.json')), path.join(backupRoot, 'playlists.json'));
    assert.equal(udb.userBackupPathFor('/etc/passwd'), null, 'a path outside the stable root has no backup twin');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('backup snapshots the profile (excluding caches) and restore brings back only missing files', async () => {
  const { dir, dataRoot, backupRoot, udb } = await sandbox();
  try {
    fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'playlists.json'), 'A');
    fs.writeFileSync(path.join(dataRoot, 'logs', 'x.log'), 'noise');
    assert.equal(udb.backupHiveUserDataSync(), true);
    assert.equal(fs.readFileSync(path.join(backupRoot, 'playlists.json'), 'utf8'), 'A');
    assert.equal(fs.existsSync(path.join(backupRoot, 'logs')), false, 'volatile dirs are excluded from the backup');

    // A fresh profile: the backup restores what's missing but never overwrites a newer live file.
    const fresh = path.join(dir, 'Hive Data 2');
    const udb2 = createUserDataBackup({ stableDataRoot: () => fresh, userBackupRoot: () => backupRoot, fs, path });
    fs.mkdirSync(fresh, { recursive: true });
    fs.writeFileSync(path.join(fresh, 'playlists.json'), 'LIVE'); // already present, must be kept
    udb2.restoreHiveUserBackupSync(fresh);
    assert.equal(fs.readFileSync(path.join(fresh, 'playlists.json'), 'utf8'), 'LIVE', 'existing file not clobbered by the backup');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
