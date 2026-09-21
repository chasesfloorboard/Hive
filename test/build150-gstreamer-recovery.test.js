const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'renderer', 'renderer.js'), 'utf8');
// The GStreamer process lifecycle (restart/start/QUIT) build 150 fixed now
// lives in its own module, extracted out of main.js's monolith.
const gstreamerBridgeSource = fs.readFileSync(path.join(__dirname, '..', 'app', 'main', 'gstreamer-bridge.js'), 'utf8');

// Build 150 reproduction: an AAC/M4A can decode initially, then report an
// unrecoverable decoder error. An explicit Play must be able to establish a
// fresh native transport instead of remaining permanently latched in
// gstFatalError. Safety remains fail-silent during the failed stream.
test('native backend exposes an explicit clean restart for audio-path recovery', () => {
  assert.match(gstreamerBridgeSource, /async function restartGstreamerProcess\(\)/);
  assert.match(gstreamerBridgeSource, /gstreamerProcess\.stdin\.write\(.*QUIT/);
  assert.match(gstreamerBridgeSource, /startGstreamerProcess\(\)/);
  assert.match(preloadSource, /gstreamerRestart:\s*\(\) => ipcRenderer\.invoke\(['"]gstreamer:restart['"]\)/);
  assert.ok(mainSource.includes("ipcMain.handle('gstreamer:restart', () => restartGstreamerProcess())"));
});

test('native decoder failure remains fail-silent and does not auto-replay the same stream', () => {
  assert.match(rendererSource, /Beehive audio safety shutdown: GStreamer helper exited/);
  assert.match(rendererSource, /Do not automatically replay the current file|failure may be in the file, sink, decoder/);
  assert.match(rendererSource, /Beehive audio safety shutdown: native GStreamer load failed/);
});

test('Play after a native fault requests a fresh backend before retrying the current track', () => {
  // The restart/recovery steps now live in a shared recoverFromGstFatalError()
  // helper (also used by loadAndPlayCurrent() -- see
  // test/build227-playback-queue-recovery.test.js -- so switching to a
  // different track can recover too, not just pressing Play again).
  const helperStart = rendererSource.indexOf('async function recoverFromGstFatalError()');
  const helperEnd = rendererSource.indexOf('\n  audioEngine.play = async', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helperBlock = rendererSource.slice(helperStart, helperEnd);
  assert.match(helperBlock, /gstreamerRestart/);
  assert.match(helperBlock, /gstFatalError = false/);

  const start = rendererSource.indexOf('audioEngine.play = async (userInitiated = false) =>');
  const end = rendererSource.indexOf('\n  audioEngine.pause = () =>', start);
  assert.ok(start >= 0 && end > start);
  const block = rendererSource.slice(start, end);
  assert.match(block, /gstFatalError && currentTrack\?\.path/);
  assert.match(block, /recoverFromGstFatalError\(\)/);
  assert.match(block, /requestLoadAndPlayCurrent/);
});

// Real bug, confirmed: playing a track whose file had been deleted from disk
// triggered a native GStreamer fatal error and correctly latched
// gstFatalError -- but loadAndPlayCurrent() (the entry point for double-
// clicking a different song, playing an album, jumping the queue, etc., not
// just the Play button) used to just bail out permanently once that flag was
// set, silently refusing to play ANYTHING, including a completely different,
// healthy track, until Hive was restarted. It must recover the same way
// audioEngine.play() already does, since loadAndPlayCurrent() only ever runs
// in response to a genuine user action (never an automatic retry loop).
test('switching to a different track recovers from a prior native fault instead of hanging forever', () => {
  const start = rendererSource.indexOf('async function loadAndPlayCurrent(');
  const end = rendererSource.indexOf('activateLocalProvider();', start);
  assert.ok(start >= 0 && end > start);
  const block = rendererSource.slice(start, end);
  assert.match(block, /if \(gstFatalError && t\?\.path\) \{/);
  assert.match(block, /if \(!window\.beehive\.gstreamerRestart \|\| !\(await recoverFromGstFatalError\(\)\)\) \{/);
  assert.doesNotMatch(block, /if \(gstFatalError && t\?\.path\) \{\s*\n\s*\/\/ A previous native audio-path fault is latched until Hive restarts\./);
});

// Moved here from build146-playlist-favorites.test.js (consolidated into
// test/playlist-sidebar-navigation.test.js) -- this test is about the native
// GStreamer selection path, not playlists/favorites.
test('A native GStreamer failure never falls through to the Web Audio fallback for a local track', () => {
  const start = rendererSource.indexOf('if (gstAvailable && gstCompatibleTrack(t))');
  assert.ok(start >= 0);
  const nativeBlock = rendererSource.slice(start, start + 2200);
  assert.match(nativeBlock, /const gstNativeSelected\s*=\s*true/);
  assert.match(nativeBlock, /if \(gstNativeSelected\)[\s\S]*?gstFatalError\s*=\s*true/);
  assert.match(nativeBlock, /gstSend\('MUTE\\t1'\)/);
  assert.match(nativeBlock, /return false/);
});

