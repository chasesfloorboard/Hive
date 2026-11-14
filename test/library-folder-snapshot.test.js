'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLibraryFolderSnapshot } = require('../app/main/library-folder-snapshot');

// A real path guard matching main.js's isPathInsideFolder semantics (inside-or-equal).
function isPathInsideFolder(p, folder) {
  const rel = path.relative(path.resolve(folder), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function sandbox() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hive-snap-'));
  const dataDir = path.join(dir, 'data');
  await fsp.mkdir(dataDir, { recursive: true });
  const files = new Map();
  const snap = createLibraryFolderSnapshot({
    fsp, path, isPathInsideFolder,
    userDataDir: () => dataDir,
    readJsonSafe: async (p, fb) => (files.has(p) ? JSON.parse(files.get(p)) : fb),
    writeJsonSafe: async (p, data) => { files.set(p, JSON.stringify(data)); },
  });
  return { dir, dataDir, files, snap };
}

test('sortedLibraryRoots resolves, dedups and sorts', async () => {
  const { dir, snap } = await sandbox();
  try {
    const got = snap.sortedLibraryRoots(['/b/x', '/a', '/b/x', '/a/']);
    assert.deepEqual(got, ['/a', '/b/x']);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('statDirectoryMtimes returns a numeric mtime for each real directory', async () => {
  const { dir, snap } = await sandbox();
  try {
    const a = path.join(dir, 'A'); const b = path.join(dir, 'B');
    await fsp.mkdir(a); await fsp.mkdir(b);
    const got = await snap.statDirectoryMtimes([a, b, a]);
    assert.ok(typeof got[path.resolve(a)] === 'number' && got[path.resolve(a)] > 0);
    assert.ok(typeof got[path.resolve(b)] === 'number');
    assert.equal(Object.keys(got).length, 2, 'deduped');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('saveLibraryFolderSnapshot persists sorted roots + directories, loadable back', async () => {
  const { dir, dataDir, snap } = await sandbox();
  try {
    await snap.saveLibraryFolderSnapshot(['/music/b', '/music/a'], { '/music/a': 10 });
    const loaded = await snap.loadLibraryFolderSnapshot();
    assert.deepEqual(loaded.roots, ['/music/a', '/music/b']);
    assert.deepEqual(loaded.directories, { '/music/a': 10 });
    assert.ok(Number.isFinite(loaded.takenAt));
    // persisted to the snapshot file in dataDir
    assert.equal(snap.snapshotPath(), path.join(dataDir, 'library-folder-snapshot.json'));
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('refreshLibraryFolderSnapshot updates the touched folder and its parents up to the root', async () => {
  const { dir, snap } = await sandbox();
  try {
    const root = path.join(dir, 'lib');
    const sub = path.join(root, 'artist', 'album');
    await fsp.mkdir(sub, { recursive: true });
    // seed a snapshot with stale (0) mtimes for root, artist, album
    const artist = path.join(root, 'artist');
    await snap.saveLibraryFolderSnapshot([root], { [root]: 0, [artist]: 0, [sub]: 0 });
    await snap.refreshLibraryFolderSnapshot([path.join(sub, 'song.flac')]);
    const loaded = await snap.loadLibraryFolderSnapshot();
    // all three (album, its parent artist, and root) refreshed to real, non-zero mtimes
    for (const d of [sub, artist, root]) {
      assert.ok(loaded.directories[d] > 0, `${d} refreshed from real stat`);
    }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test('refreshLibraryFolderSnapshot ignores paths outside any known root', async () => {
  const { dir, snap } = await sandbox();
  try {
    const root = path.join(dir, 'lib');
    await fsp.mkdir(root, { recursive: true });
    await snap.saveLibraryFolderSnapshot([root], { [root]: 5 });
    await snap.refreshLibraryFolderSnapshot(['/somewhere/else/song.flac']);
    const loaded = await snap.loadLibraryFolderSnapshot();
    assert.deepEqual(Object.keys(loaded.directories), [root], 'no foreign dirs added');
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});
