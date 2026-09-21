const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');

test('Build 227 keeps local playback GStreamer-only while recovering from native faults explicitly', () => {
  assert.match(renderer, /GStreamer is the sole local transport/);
  assert.match(renderer, /native GStreamer load failed; Web Audio fallback disabled/);
  assert.match(renderer, /const currentTrack = currentQueue\[currentIndex\];/);
  assert.match(renderer, /gstFatalError && currentTrack\?\.path/);
});

// Volume-architecture coverage, including the manual-routing-experiment
// guards this test used to duplicate, now lives in test/volume.test.js.

test('Build 227 queue rows resolve artwork through the authoritative library object', () => {
  const start = renderer.indexOf('function populateQueueVirtualRow');
  assert.notEqual(start, -1);
  const end = renderer.indexOf('function createQueueVirtualRow', start);
  assert.notEqual(end, -1);
  const block = renderer.slice(start, end);
  assert.match(block, /libraryTrackByPath\.get\(String\(track\.path\)\)/);
  assert.match(block, /track = authoritative/);
});

// Real bug, confirmed: window close (beforeunload/pagehide) only called
// savePlaybackSession(true), a throttled transport-only merge that spreads
// whatever `paths` already happen to be on disk rather than writing fresh
// ones. saveQueueSession() -- the function that actually persists the full
// paths/version snapshot to both localStorage and the backend recovery file
// -- only fires on explicit queue mutations, never on shutdown itself. If
// the queue hadn't mutated recently before the user closed the window, the
// backend playback-state.json could restart with a stale or (on a fresh
// profile) entirely missing `paths` array, and restoreSavedQueue() requires
// a non-empty `paths` array to restore anything at all.
test('window close persists the full queue snapshot, not just a throttled transport merge', () => {
  const start = renderer.indexOf("window.addEventListener('beforeunload'");
  const end = renderer.indexOf("window.addEventListener('pagehide'");
  assert.ok(start >= 0 && end > start, 'expected beforeunload/pagehide handlers');
  const block = renderer.slice(start, end + 200);
  assert.match(block, /window\.addEventListener\('beforeunload', \(\) => \{ saveQueueSession\(\); savePlaybackSession\(true\); void wrapFinishListening\(\); \}\);/);
  assert.match(block, /window\.addEventListener\('pagehide', \(\) => \{ saveQueueSession\(\); savePlaybackSession\(true\); \}\);/);
});
