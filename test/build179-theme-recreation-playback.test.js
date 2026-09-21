'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

test('theme window recreation explicitly tells the new renderer to preserve the live transport', () => {
  assert.match(main, /createWindow\(\{\s*bounds,\s*maximized,\s*preservePlayback:\s*true\s*\}\)/);
  assert.match(main, /query:\s*preservePlayback\s*\?\s*\{\s*preservePlayback:\s*'1'\s*\}\s*:\s*undefined/);
});

// Real bug, confirmed: restoreLastPlayback() always runs before the cached
// library arrives (deliberately, for startup speed -- see initialLoad()'s
// comment), so library.tracks/byPath is normally empty at this point on
// EVERY ordinary launch, not just during renderer recreation. Gating the
// serialized-track fallback on rendererRecreationMode meant a plain restart
// looked up every local track in an empty byPath, missed every one, and
// silently dropped the entire restored queue. The fallback must apply
// unconditionally; queueItems already carries enough metadata to play and
// display a reasonable row, and queue rendering re-resolves each row against
// the authoritative library object once it loads (see
// test/build227-playback-queue-recovery.test.js's populateQueueVirtualRow
// coverage), so this doesn't need a separate reconciliation pass.
test('queue restoration falls back to serialized session metadata whenever the library has not loaded yet, not only during renderer recreation', () => {
  assert.match(renderer, /const rendererRecreationMode\s*=\s*new URLSearchParams\(location\.search\)\.get\('preservePlayback'\)\s*===\s*'1'/);
  assert.match(renderer, /restoreQueueItems\(queueState\.queueItems, queueState\.paths, byPath, true\)/);
  assert.match(renderer, /restoreQueueItems\(queueState\.shuffleBaseItems, queueState\.shuffleBasePaths, byPath, true\)/);
  assert.match(renderer, /allowSerializedLocal\s*&&\s*item\s*&&\s*item\.path/);
});

test('renderer recreation adopts the existing GStreamer transport instead of starting a second playback session', () => {
  assert.match(renderer, /rendererRecreationMode\s*&&\s*queueState\.wasPlaying/);
  assert.match(renderer, /gstActive\s*=\s*true/);
  assert.match(renderer, /gstPositionUpdatesEnabled\s*=\s*true/);
  assert.match(renderer, /enginePaused\s*=\s*false/);
  assert.match(renderer, /rendererRecreationMode\s*&&\s*queueState\.wasPlaying\s*&&\s*restored\.path/);
});
