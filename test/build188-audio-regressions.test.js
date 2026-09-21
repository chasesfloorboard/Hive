'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');
// The GStreamer process-spawn code that build 188 fixed now lives in its own
// module (app/main/gstreamer-bridge.js), extracted out of main.js's monolith.
const gstreamerBridge = fs.readFileSync(path.join(root, 'app/main/gstreamer-bridge.js'), 'utf8');

test('Build 188 keeps local volume on the native audio-engine path without renderer smoothing', () => {
  assert.match(renderer, /function setNativeVolumeImmediate\(/);
  assert.doesNotMatch(renderer, /requestAnimationFrame\(flushNativeVolume\)/);
  const start = renderer.indexOf("el.pbVolume.addEventListener('input'");
  const end = renderer.indexOf("// Allow the mouse wheel", start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /scheduleVolumePersistence\(\)/);
  assert.doesNotMatch(block, /saveLastPlayback\(\);/);
});

test('Build 188 flushes the final volume value when slider interaction ends', () => {
  const start = renderer.indexOf("el.pbVolume.addEventListener('pointerup'");
  const end = renderer.indexOf("el.pbVolume.addEventListener('input'", start);
  assert.ok(start >= 0 && end > start);
  assert.match(renderer.slice(start, end), /flushVolumePersistence\(\)/);
});

test('Build 188 does not deliberately lower the GStreamer helper priority', () => {
  assert.doesNotMatch(main, /setPriority\([^,]+,\s*10\)/);
  assert.doesNotMatch(gstreamerBridge, /setPriority\([^,]+,\s*10\)/);
  assert.match(gstreamerBridge, /GStreamer owns the real-time-ish audio path/);
});


test('Build 188 preserves the single native transition path for manual track changes', () => {
  const start = renderer.indexOf('async function gstLoadCurrent(');
  const end = renderer.indexOf('\n  Object.defineProperties(audioEngine', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /setNativeVolumeImmediate\(engineVolume\)/);
  assert.match(block, /gstSend\(`LOAD\\t/);
  assert.match(block, /gstSend\('PLAY'\)/);
  // handle_load() synchronously waits for the persistent playbin's PAUSED/preroll
  // transition natively, so the renderer issues a single LOAD -> PLAY sequence
  // instead of a separate renderer-driven PAUSE/RAMPSTART round trip.
  assert.doesNotMatch(block, /gstSend\('RAMPSTART'\)/);
});
