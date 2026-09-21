'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'app/renderer/styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');

test('Build 241 gives themed Electron controls a dedicated hit-testable breathing row', () => {
  assert.match(css, /html\.theme-window-bar-enabled #topbar\s*\{[\s\S]*?height:\s*82px[\s\S]*?min-height:\s*82px/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-titlebar-row\s*\{[\s\S]*?height:\s*32px[\s\S]*?pointer-events:\s*auto[\s\S]*?-webkit-app-region:\s*drag/);
  assert.match(css, /html\.theme-window-bar-enabled \.window-titlebar-row > \.window-controls\s*\{[\s\S]*?pointer-events:\s*auto[\s\S]*?-webkit-app-region:\s*no-drag/);
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-app-row\s*\{[\s\S]*?height:\s*auto/);
  assert.match(css, /html\.theme-window-bar-enabled \.topbar-app-row\s*\{[\s\S]*?min-height:\s*0/);
});

test('Build 241 keeps ordinary local volume immediate and free of timer automation', () => {
  assert.doesNotMatch(renderer, /nativeVolumeDispatchTimer/);
  assert.doesNotMatch(renderer, /nativeVolumeDispatchPending/);
  const start = renderer.indexOf('function setNativeVolumeImmediate(');
  const end = renderer.indexOf('function scheduleVolumePersistence', start);
  assert.ok(start >= 0 && end > start);
  const block = renderer.slice(start, end);
  assert.match(block, /gstSend\('VOLUME\\t' \+ String\(next\)\)/);
  assert.doesNotMatch(block, /setTimeout/);
  const volumeStart = renderer.indexOf("el.pbVolume.addEventListener('input'");
  const volumeEnd = renderer.indexOf('// Allow the mouse wheel', volumeStart);
  assert.doesNotMatch(renderer.slice(volumeStart, volumeEnd), /start_volume_ramp/);
});
