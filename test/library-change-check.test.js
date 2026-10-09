'use strict';
// Startup change check (app/main/library-change-check.js): Hive skips its
// startup scan only when nothing in the library changed while it was closed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { libraryChangeReason } = require('../app/main/library-change-check');

const VERSIONS = { metadataScanVersion: 2, artworkScanVersion: 1 };

// A tiny library on disk plus the snapshot/cache a completed scan would leave.
async function makeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-change-check-'));
  const album = path.join(root, 'Artist', 'Album');
  fs.mkdirSync(album, { recursive: true });
  const track = path.join(album, '01.mp3');
  fs.writeFileSync(track, 'audio');
  const st = fs.statSync(track);
  const tracks = [{ path: track, fileMtimeMs: st.mtimeMs, fileCtimeMs: st.ctimeMs, fileSize: st.size, metadataScanVersion: 2, artworkScanVersion: 1, cover: 'x.jpg' }];
  const directories = {};
  for (const dir of [root, path.join(root, 'Artist'), album]) directories[dir] = fs.statSync(dir).mtimeMs;
  const snapshot = { roots: [root], directories };
  const check = (overrides = {}) => libraryChangeReason({ roots: [root], snapshot, tracks, stat: p => fsp.stat(p), ...VERSIONS, ...overrides });
  return { root, album, track, tracks, snapshot, check };
}

// Folder and file times have whole-millisecond-or-better resolution, but give
// the clock a moment so a change can't land in the same timestamp.
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

test('nothing changed: no startup scan needed', async () => {
  const lib = await makeLibrary();
  try { assert.equal(await lib.check(), null); }
  finally { fs.rmSync(lib.root, { recursive: true, force: true }); }
});

test('a new file dropped into an album folder is noticed', async () => {
  const lib = await makeLibrary();
  try {
    await tick();
    fs.writeFileSync(path.join(lib.album, '02.mp3'), 'new');
    assert.match(await lib.check(), /^folder changed: /);
  } finally { fs.rmSync(lib.root, { recursive: true, force: true }); }
});

test('a new album folder is noticed', async () => {
  const lib = await makeLibrary();
  try {
    await tick();
    fs.mkdirSync(path.join(lib.root, 'Artist', 'New Album'));
    assert.match(await lib.check(), /^folder changed: /);
  } finally { fs.rmSync(lib.root, { recursive: true, force: true }); }
});

test('a file retagged in place by another program is noticed', async () => {
  const lib = await makeLibrary();
  try {
    await tick();
    fs.appendFileSync(lib.track, 'retagged');
    assert.match(await lib.check(), /^file changed: /);
  } finally { fs.rmSync(lib.root, { recursive: true, force: true }); }
});

test('a deleted file is noticed', async () => {
  const lib = await makeLibrary();
  try {
    fs.unlinkSync(lib.track);
    assert.ok(await lib.check());
  } finally { fs.rmSync(lib.root, { recursive: true, force: true }); }
});

test('first launch after updating Hive (no snapshot yet) scans once', async () => {
  const lib = await makeLibrary();
  try { assert.equal(await lib.check({ snapshot: null }), 'no folder snapshot yet'); }
  finally { fs.rmSync(lib.root, { recursive: true, force: true }); }
});

test('adding or removing a library folder in Settings triggers a scan', async () => {
  const lib = await makeLibrary();
  try { assert.equal(await lib.check({ roots: [lib.root, '/somewhere/else'].sort() }), 'library folders changed'); }
  finally { fs.rmSync(lib.root, { recursive: true, force: true }); }
});

test('a newer scanner version rescans cached tracks', async () => {
  const lib = await makeLibrary();
  try { assert.equal(await lib.check({ metadataScanVersion: 3 }), 'scanner updated'); }
  finally { fs.rmSync(lib.root, { recursive: true, force: true }); }
});
