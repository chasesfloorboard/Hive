'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'app/main/gstreamer-bridge.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

test('shutdown does not synchronously snapshot the entire user-data profile', () => {
  const first = main.indexOf("app.on('before-quit', () => {");
  const second = main.indexOf("app.on('before-quit', () => {", first + 1);
  assert.ok(first >= 0 && second > first);
  const block = main.slice(first, second);
  assert.doesNotMatch(block, /backupHiveUserDataSync\(\)/);
  assert.match(block, /flushSessionLogSync\(\)/);
});

test('GStreamer shutdown remains non-blocking from Electron', () => {
  const requestQuit = bridge.slice(bridge.indexOf('function requestQuit()'));
  assert.match(requestQuit, /gstreamerProcess\.stdin\.write\('QUIT\\n'\)/);
  assert.match(requestQuit, /setTimeout\(\(\) => \{[\s\S]*dying\.kill\('SIGTERM'\)/);
});

test('renderer shutdown forces only the small transport snapshot, not the full queue', () => {
  const saverStart = renderer.indexOf('function savePlaybackSession(forceSync = false)');
  const saverEnd = renderer.indexOf('function saveSession()', saverStart);
  assert.ok(saverStart >= 0 && saverEnd > saverStart);
  const block = renderer.slice(saverStart, saverEnd);
  assert.match(block, /if \(forceSync \|\| now - lastTransportBackendSaveAt >= 2000\)/);
  assert.match(block, /window\.beehive\.updatePlaybackTransportSync\(state\)/);
  assert.doesNotMatch(block, /forceSync\) window\.beehive\.savePlaybackStateSync\(buildPlaybackState\(\)\)/);
});

// Double-clicking a large collection (e.g. Favorites, thousands of tracks) to
// play it visibly stalled for close to a second before audio started.
// saveQueueSession() ran synchronously inside playQueue() before playback
// began, and handed the *entire* buildPlaybackState() -- including per-track
// queueItems for every queued track -- to a synchronous IPC call
// (sendSync), which structured-clones its whole argument across the process
// boundary while blocking the renderer. The main-process handler for that
// channel (playback-state:saveSync) never reads queueItems/shuffleBaseItems
// at all, only paths and a handful of scalars, so none of that cloning cost
// bought anything.
test('saving the queue session sends only small scalar fields over the synchronous IPC call, not per-track queue metadata', () => {
  const start = renderer.indexOf('function saveQueueSession()');
  const end = renderer.indexOf('\n  function getPlaybackPositionForSave', start);
  assert.ok(start >= 0 && end > start, 'expected to find saveQueueSession()');
  const block = renderer.slice(start, end);
  assert.match(block, /window\.beehive\.savePlaybackStateSync\(\{/);
  assert.doesNotMatch(
    block,
    /savePlaybackStateSync\(playbackState\)/,
    'must not hand the full buildPlaybackState() (with queueItems for every track) to the synchronous IPC call'
  );
  const syncCallStart = block.indexOf('window.beehive.savePlaybackStateSync({');
  const syncCallEnd = block.indexOf('});', syncCallStart);
  const syncCallArgs = block.slice(syncCallStart, syncCallEnd);
  assert.doesNotMatch(syncCallArgs, /queueItems/, 'per-track queue metadata must not cross the synchronous IPC boundary');
  assert.doesNotMatch(syncCallArgs, /shuffleBaseItems/, 'per-track shuffle-base metadata must not cross the synchronous IPC boundary');
});
