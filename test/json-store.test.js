'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createJsonStore } = require('../app/main/json-store');

async function sandbox() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hive-json-'));
  const dataRoot = path.join(dir, 'Hive Data');
  const backupRoot = path.join(dir, 'User Data Backup');
  await fsp.mkdir(dataRoot, { recursive: true });
  const cachePath = path.join(dataRoot, 'library.json');
  const gzPath = path.join(dataRoot, 'library.json.gz');
  // backup twin only for files under dataRoot
  const userBackupPathFor = (p) => {
    const rel = path.relative(dataRoot, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return path.join(backupRoot, rel);
  };
  const store = createJsonStore({
    fsp, path, userBackupPathFor,
    libraryCachePath: () => cachePath,
    libraryCacheGzipPath: () => gzPath,
  });
  return { dir, dataRoot, backupRoot, cachePath, gzPath, store };
}

test('readJsonSafe returns the fallback for a missing file and parses a good one', async () => {
  const { dir, dataRoot, store } = await sandbox();
  try {
    assert.deepEqual(await store.readJsonSafe(path.join(dataRoot, 'nope.json'), { d: 1 }), { d: 1 });
    const p = path.join(dataRoot, 'ok.json');
    await fsp.writeFile(p, JSON.stringify({ hello: 'world' }));
    assert.deepEqual(await store.readJsonSafe(p, null), { hello: 'world' });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('writeJsonSafe writes the primary atomically and mirrors user JSON into the backup', async () => {
  const { dir, dataRoot, backupRoot, store } = await sandbox();
  try {
    const p = path.join(dataRoot, 'playlists.json');
    await store.writeJsonSafe(p, { lists: ['a', 'b'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { lists: ['a', 'b'] });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backupRoot, 'playlists.json'), 'utf8')), { lists: ['a', 'b'] }, 'mirrored to backup');
    // human-readable files stay pretty-printed
    assert.match(fs.readFileSync(p, 'utf8'), /\n {2}"lists"/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('a damaged file is quarantined, recovered from its backup, and the backup is not clobbered', async () => {
  const { dir, dataRoot, backupRoot, store } = await sandbox();
  try {
    const p = path.join(dataRoot, 'settings.json');
    // good backup exists, primary is corrupt
    await fsp.mkdir(backupRoot, { recursive: true });
    await fsp.writeFile(path.join(backupRoot, 'settings.json'), JSON.stringify({ theme: 'dark' }));
    await fsp.writeFile(p, '{ this is not json');
    const got = await store.readJsonSafe(p, { theme: 'light' });
    assert.deepEqual(got, { theme: 'dark' }, 'recovered from backup, not the fallback');
    // the corrupt primary was set aside
    const quarantined = (await fsp.readdir(dataRoot)).filter(n => n.startsWith('settings.json.damaged-'));
    assert.equal(quarantined.length, 1, 'damaged copy kept aside');
    // primary rewritten from backup
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { theme: 'dark' });
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('a damaged file with no backup returns the fallback but keeps the backup untouched on next write', async () => {
  const { dir, dataRoot, backupRoot, store } = await sandbox();
  try {
    const p = path.join(dataRoot, 'ratings.json');
    await fsp.writeFile(p, '\u0000\u0000'); // 0-byte-ish / damaged
    const got = await store.readJsonSafe(p, { fallback: true });
    assert.deepEqual(got, { fallback: true });
    // now a write of that fallback must NOT create/overwrite a backup (file is flagged damaged)
    await store.writeJsonSafe(p, { fallback: true });
    assert.equal(fs.existsSync(path.join(backupRoot, 'ratings.json')), false, 'backup not written while file is flagged damaged');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('the library cache is compacted, gzipped, and never mirrored to the backup', async () => {
  const { dir, cachePath, gzPath, backupRoot, store } = await sandbox();
  try {
    const big = { tracks: Array.from({ length: 5 }, (_, i) => ({ i, name: 'song' + i })) };
    await store.writeJsonSafe(cachePath, big);
    const txt = fs.readFileSync(cachePath, 'utf8');
    assert.doesNotMatch(txt, /\n {2}/, 'cache is compact (no pretty-print indentation)');
    assert.ok(fs.existsSync(gzPath), 'gzip transport copy written');
    assert.deepEqual(JSON.parse(zlib.gunzipSync(fs.readFileSync(gzPath)).toString('utf8')), big);
    assert.equal(fs.existsSync(backupRoot), false, 'library cache is not mirrored into the user backup');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('withJsonFileLock serializes read-modify-write against one path (no lost update)', async () => {
  const { dir, dataRoot, store } = await sandbox();
  try {
    const p = path.join(dataRoot, 'counter.json');
    await store.writeJsonSafe(p, { n: 0 });
    const bump = () => store.withJsonFileLock(p, async () => {
      const cur = await store.readJsonSafe(p, { n: 0 });
      await store.writeJsonSafe(p, { n: cur.n + 1 });
    });
    await Promise.all([bump(), bump(), bump(), bump(), bump()]);
    assert.equal((await store.readJsonSafe(p, { n: 0 })).n, 5, 'all five increments applied, none lost');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('removeStaleWriteTemps deletes dead-pid temps but keeps this process\'s own', async () => {
  const { dir, dataRoot, store } = await sandbox();
  try {
    const mine = path.join(dataRoot, `x.json.beehive-write-${process.pid}-abcd12.tmp`);
    const dead = path.join(dataRoot, 'y.json.beehive-write-999999-ffee00.tmp');
    const other = path.join(dataRoot, 'z.json');
    fs.writeFileSync(mine, '1'); fs.writeFileSync(dead, '2'); fs.writeFileSync(other, '3');
    const removed = await store.removeStaleWriteTemps(dataRoot);
    assert.equal(removed, 1, 'only the dead-pid temp removed');
    assert.ok(fs.existsSync(mine), 'own live temp kept');
    assert.ok(!fs.existsSync(dead), 'dead temp gone');
    assert.ok(fs.existsSync(other), 'non-temp untouched');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
