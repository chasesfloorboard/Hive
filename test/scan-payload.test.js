'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { rendererTrackPayload } = require('../app/main/scan-payload');

// Real bug, confirmed live: Hive's main process crashed (SIGTRAP in V8) after
// a routine incremental rescan. writeJsonSafe() pretty-printed EVERY JSON
// write with `null, 2`, including the ~30k-track library cache (a ~93MB
// object graph on this library) -- and that full rewrite fires on every scan
// that finds even one changed file, not just full rescans. Pretty-printing
// that string is pure waste: the file is immediately gzipped for IPC
// transport and never hand-edited, so the extra allocation only added
// avoidable heap pressure on a process that already needed
// --max-old-space-size=8192 raised once before. Every other JSON write (small,
// meant to stay human-readable for debugging) keeps its indentation.
test('the library cache is written as compact JSON, unlike every other JSON write', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'main.js'), 'utf8');
  const start = main.indexOf('async function writeJsonSafe(p, data)');
  const end = main.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, 'expected to find writeJsonSafe');
  const block = main.slice(start, end);
  assert.match(block, /const payload = isLibraryCache \? JSON\.stringify\(data\) : JSON\.stringify\(data, null, 2\);/);
});

test('renderer scan payload excludes lossless native tags from large libraries', () => {
  const nativeTags = { ID3: Array.from({ length: 200 }, (_, i) => ({ id: `TXXX:${i}`, value: 'large tag value' })) };
  const track = {
    path: '/synthetic/song.flac', title: 'Song', lyrics: 'lyrics', customTags: { VIRTUAL1: 'value' }, nativeTags,
    covers: [{ file: 'cover.jpg', type: 'Cover (front)' }], playCount: 2
  };
  const payload = rendererTrackPayload(track);
  assert.equal(payload.path, track.path);
  assert.equal(payload.lyrics, track.lyrics);
  assert.deepEqual(payload.customTags, track.customTags);
  assert.equal(payload.nativeTags, undefined);
  assert.equal(payload.covers, track.covers);
});

test('renderer payload stays bounded across a synthetic 30k-track scan', () => {
  const nativeTags = { ID3: Array.from({ length: 100 }, (_, i) => ({ id: `TXXX:${i}`, value: 'tag' })) };
  const payloads = Array.from({ length: 30000 }, (_, i) => rendererTrackPayload({
    path: `/synthetic/${i}.flac`, title: `Track ${i}`, nativeTags, lyrics: 'short lyrics', customTags: {}
  }));
  assert.equal(payloads.length, 30000);
  assert.equal(payloads[29999].nativeTags, undefined);
  assert.ok(JSON.stringify(payloads).length < 8_000_000, 'renderer payload should not retain lossless tag inventories');
});
