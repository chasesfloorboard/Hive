'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// renderer.js is one browser-side closure, so load just the two pure queue
// restore helpers out of it and test what they do, not how they are written.
const renderer = fs.readFileSync(path.join(__dirname, '..', 'app/renderer/renderer.js'), 'utf8');
function extract(startMarker, endMarker) {
  const start = renderer.indexOf(startMarker);
  const end = renderer.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not find ${startMarker}`);
  return renderer.slice(start, end);
}
const { restoreQueueItems, pickQueueSnapshot } = new Function(
  extract('function restoreQueueItems(', '// Picks the queue snapshot to restore.') +
  extract('function pickQueueSnapshot(', 'function saveQueueSession()') +
  'return { restoreQueueItems, pickQueueSnapshot };'
)();

const A = '/music/a.flac', B = '/music/b.mp3', C = '/music/c.wav';
const item = p => ({ path: p, source: 'local', title: `Title ${p}`, artist: 'Artist', duration: 200 });

// What the stores hold after a normal shutdown: saveQueueSession() writes the
// full localStorage snapshot and the paths-only backend file with the same
// queueSavedAt, then the forced transport save bumps the backend's savedAt.
function shutdownSnapshots(paths, t = 1000) {
  const local = { paths, queueItems: paths.map(item), currentIndex: 1, savedAt: t, queueSavedAt: t };
  const backend = { version: 3, paths, currentIndex: 1, position: 42, savedAt: t + 7, queueSavedAt: t };
  return { local, backend };
}

test('a normal restart restores every local track before the library has loaded', () => {
  const { local, backend } = shutdownSnapshots([A, B, C]);
  const state = pickQueueSnapshot([backend, local]);
  const queue = restoreQueueItems(state.queueItems, state.paths, new Map(), true);
  assert.deepEqual(queue.map(t => t.path), [A, B, C]);
  assert.equal(queue[0].title, `Title ${A}`);
});

test('snapshots written before queueSavedAt existed still restore the queue', () => {
  // Old files: no queueSavedAt anywhere, and the paths-only backend is newer.
  const local = { paths: [A, B], queueItems: [item(A), item(B)], shuffleBasePaths: [B, A], shuffleBaseItems: [item(B), item(A)], savedAt: 1000 };
  const backend = { paths: [A, B], position: 3, savedAt: 1009 };
  const state = pickQueueSnapshot([backend, local]);
  assert.equal(state.position, 3, 'transport fields still come from the newest snapshot');
  assert.deepEqual(state.queueItems.map(t => t.path), [A, B]);
  assert.deepEqual(state.shuffleBasePaths, [B, A]);
});

test('a newer queue saved only to the backend wins over an older local queue', () => {
  const local = { paths: [A], queueItems: [item(A)], savedAt: 1000, queueSavedAt: 1000 };
  const backend = { paths: [B, C], savedAt: 2005, queueSavedAt: 2000 };
  const state = pickQueueSnapshot([backend, local]);
  assert.deepEqual(state.paths, [B, C]);
  // Different queue, so nothing to borrow; paths still restore without the library.
  const queue = restoreQueueItems(state.queueItems, state.paths, new Map(), true);
  assert.deepEqual(queue.map(t => t.path), [B, C]);
  assert.equal(queue[0].title, 'b');
});

test('paths-only restore prefers the library object when it is available', () => {
  const libraryTrack = { path: A, title: 'From library', rating: 5 };
  const queue = restoreQueueItems(undefined, [A, B], new Map([[A, libraryTrack]]), true);
  assert.equal(queue[0], libraryTrack);
  assert.equal(queue[1].path, B);
});

test('an empty queue restores nothing', () => {
  assert.equal(pickQueueSnapshot([{ paths: [], savedAt: 5 }, null]), null);
  assert.equal(pickQueueSnapshot([]), null);
});
