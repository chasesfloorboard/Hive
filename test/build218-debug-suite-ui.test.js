'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'app/renderer/styles.css'), 'utf8');
const renderer = fs.readFileSync(path.join(ROOT, 'app/renderer/renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'app/main/main.js'), 'utf8');
const native = fs.readFileSync(path.join(ROOT, 'app/native/gstreamer-player.c'), 'utf8');
const diagnostics = fs.readFileSync(path.join(ROOT, 'app/main/diagnostics.js'), 'utf8');

function selectorBlock(selector) {
  const start = css.indexOf(selector);
  const end = css.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start, `${selector} must exist`);
  return css.slice(start, end + 2);
}

test('Build 218 gives sidebar and queue direct frosted surfaces instead of pseudo-element glass', () => {
  const sidebar = selectorBlock('#sidebar.player-glass-surface,');
  const queue = selectorBlock('#queue-panel.player-glass-surface');
  assert.match(sidebar, /backdrop-filter:blur\(var\(--blur\)\) saturate\(140%\)/);
  assert.match(queue, /backdrop-filter:blur\(var\(--blur\)\) saturate\(140%\)/);
  const queueBefore = selectorBlock('#queue-panel::before');
  assert.doesNotMatch(queueBefore, /content:|background:|backdrop-filter:/);
  const sidebarBefore = selectorBlock('#sidebar.player-glass-transparent::before');
  assert.match(sidebarBefore, /background:transparent !important/);
  assert.match(css, /#sidebar\.player-glass-transparent,[\s\S]*?backdrop-filter:none !important/);
  assert.match(css, /#queue-panel\.player-glass-transparent,[\s\S]*?backdrop-filter:none !important/);
});

test('Build 218 keeps ordinary volume separate from transport ramps and adds explicit trace markers', () => {
  const start = native.indexOf('} else if (!g_strcmp0(parts[0], "VOLUME")');
  const end = native.indexOf('} else if (!g_strcmp0(parts[0], "MUTE")', start);
  assert.ok(start >= 0 && end > start);
  const block = native.slice(start, end);
  assert.doesNotMatch(block, /start_volume_ramp\s*\(/);
  assert.match(native, /!g_strcmp0\(parts\[0\], "TRACE"\)/);
  assert.match(native, /trace_enabled =/);
});

test('Build 218 diagnostic sessions enable native GStreamer tracing for the session', () => {
  assert.match(main, /createDiagnosticsController\(\{[\s\S]*?onStart/);
  assert.match(main, /sendGstreamerCommand\('TRACE\\t1'\)/);
  assert.match(main, /sendGstreamerCommand\('TRACE\\t0'\)/);
  assert.match(diagnostics, /onStart/);
  assert.match(diagnostics, /onFinish/);
});

test('Build 218 renderer diagnostics mark the major backend crash-course phases', () => {
  assert.match(renderer, /diagnosticMark\('VOLUME INPUT'/);
  assert.match(renderer, /diagnosticMark\('SCRUBBER CLICK'/);
  assert.match(renderer, /diagnosticMark\('SCRUBBER COMMIT'/);
  assert.match(renderer, /diagnosticMark\('GSTREAMER COMMAND'/);
  assert.match(renderer, /diagnosticMark\('QUEUE NEXT REQUEST'/);
});
