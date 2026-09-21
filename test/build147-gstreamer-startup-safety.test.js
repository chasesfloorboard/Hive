'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'app/main/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');
// The GStreamer process lifecycle build 147 hardened now lives in its own
// module, extracted out of main.js's monolith.
const gstreamerBridge = fs.readFileSync(path.join(root, 'app/main/gstreamer-bridge.js'), 'utf8');

test('GStreamer helper cache is content-addressed, not only mtime-addressed', () => {
  assert.match(gstreamerBridge, /gstreamerHelperSourceHash|sha256/i);
  assert.match(gstreamerBridge, /const stamp = `\$\{out\}\.sha256`/);
});

test('GStreamer helper startup validates the native READY handshake before advertising availability', () => {
  assert.match(gstreamerBridge, /GSTREAMER READY/);
  assert.match(gstreamerBridge, /gstreamerRuntimeReady/);
  assert.match(gstreamerBridge, /READY.*GStreamer|GStreamer.*READY/i);
});

test('Native GStreamer startup reports readiness only after player and sink initialization', () => {
  assert.match(native, /player = gst_element_factory_make\("playbin3"/);
  assert.match(native, /audio-output/);
  assert.match(native, /event_line\("READY"/);
});

test('An unexpected native helper exit while a local track is active fails silent without an automatic replay retry', () => {
  const start = renderer.indexOf("if (name === 'PROCESS_EXIT')");
  assert.ok(start >= 0);
  const end = renderer.indexOf("if (name === 'ERROR'", start);
  const block = renderer.slice(start, end);
  assert.match(block, /gstFatalError\s*=\s*wasActive/);
  assert.doesNotMatch(block, /requestLoadAndPlayCurrent\(\)/);
});

test('GStreamer readiness timeout tears down an unvalidated helper instead of leaving a zombie backend', () => {
  assert.match(gstreamerBridge, /if \(!gstreamerRuntimeReady && gstreamerProcess\)[\s\S]*?failedProcess\.kill/);
  assert.match(gstreamerBridge, /gstreamerReadyWaiters\.splice/);
});

test('Renderer PLAYING acknowledgement does not bypass the native audio safety gate with an unmute command', () => {
  const start = renderer.indexOf("if (name === 'PLAYING' && gstActive)");
  assert.ok(start >= 0);
  const end = renderer.indexOf("if (name === 'TRIM_END'", start);
  const block = renderer.slice(start, end);
  assert.doesNotMatch(block, /gstSend\('MUTE\\t0'\)/);
});


test('Explicit queue skip clears a prior native audio fault so the next track can restart GStreamer safely', () => {
  const start = renderer.indexOf('function goNext()');
  assert.ok(start >= 0);
  const end = renderer.indexOf('function goPrev()', start);
  const block = renderer.slice(start, end);
  assert.match(block, /gstFatalError\s*=\s*false/);
  assert.match(block, /gstAvailabilityKnown\s*=\s*false/);
  assert.match(block, /gstAvailable\s*=\s*false/);
  assert.match(block, /gstAvailabilityPromise\s*=\s*null/);
});
