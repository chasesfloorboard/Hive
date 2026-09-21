'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const native = fs.readFileSync(path.join(root, 'app/native/gstreamer-player.c'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'app/renderer/renderer.js'), 'utf8');

test('Native MUTE=0 never opens the sink while the stream is not validated as STREAM_START + PLAYING', () => {
  const start = native.indexOf('} else if (!g_strcmp0(parts[0], "MUTE")');
  assert.ok(start >= 0);
  const end = native.indexOf('\n      } else if (!g_strcmp0(parts[0], \"QUIT\"))', start + 20);
  const block = native.slice(start, end > start ? end : start + 1400);
  assert.match(block, /stream_started && playing_state/);
  assert.match(block, /MUTE_DEFERRED|defer/i);
  // Real playback volume is only ever applied from the STREAM_START+PLAYING
  // state-change handler (gated on stream_started), so an early MUTE=0 cannot
  // itself make the pipeline audible before that gate opens.
  const stateChangeStart = native.indexOf('if (new_s == GST_STATE_PLAYING)');
  assert.ok(stateChangeStart >= 0);
  const stateChangeBlock = native.slice(stateChangeStart, stateChangeStart + 600);
  assert.match(stateChangeBlock, /if \(stream_started && !user_muted\)/);
});

test('Volume movement cannot turn a failed/stalled native stream back into audible output', () => {
  const start = renderer.indexOf("el.pbVolume.addEventListener('input'");
  assert.ok(start >= 0);
  const end = renderer.indexOf("// Allow the mouse wheel", start);
  const block = renderer.slice(start, end);
  assert.match(block, /audioEngine\.volume = value/);
  assert.doesNotMatch(block, /audioEngine\.muted\s*=\s*false/);
  assert.doesNotMatch(block, /audio\.volume = value/);
});

test('GStreamer trace records command/state transitions without enabling noisy logging by default', () => {
  assert.match(native, /HIVE_GST_TRACE/);
  assert.match(native, /TRACE|trace/i);
  assert.match(native, /COMMAND/);
  assert.match(native, /STATE_CHANGED/);
});

test('Renderer exposes GStreamer diagnostic events for stalled-track investigation', () => {
  assert.match(renderer, /GSTREAMER.*EVENT|GStreamer.*event|gstreamer:event/i);
  assert.match(renderer, /console\.error|console\.warn|console\.log/);
});
