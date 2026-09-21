'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');

test('Build 253 sends local volume changes immediately during slider input', () => {
  const start = renderer.indexOf("el.pbVolume.addEventListener('input', () => {");
  const end = renderer.indexOf('// Allow the mouse wheel', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /audioEngine\.volume\s*=\s*value/);
  assert.match(renderer, /volume:\s*\{ get\(\) \{ return engineVolume; \}, set\(v\) \{[\s\S]*?setNativeVolumeImmediate\(engineVolume\)/);
  assert.doesNotMatch(block, /setTimeout\(/);
});

test('Build 253 has no timed native volume debounce in the renderer', () => {
  assert.match(renderer, /function setNativeVolumeImmediate\(value\)/);
  assert.doesNotMatch(renderer, /NATIVE_VOLUME_DISPATCH_MS/);
  assert.doesNotMatch(renderer, /nativeVolumeDispatchTimer/);
  assert.doesNotMatch(renderer, /nativeVolumePending/);
});

// The native volume-element architecture (this test used to assert its
// absence) now has its own coverage in test/volume.test.js, which explains
// why it's back: builds 248-258's direct-apply design never actually fixed
// the audible popping a real user reported.
