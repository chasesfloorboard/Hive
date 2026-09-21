const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const main = read('app/main/main.js');
const gst = read('app/native/gstreamer-player.c');
const renderer = read('app/renderer/renderer.js');
// writeSession/flushSessionLogSync/prettyConsole/installConsoleCapture now
// live in their own module, extracted out of main.js's monolith.
const sessionLog = read('app/main/session-log.js');

test('session logging does not synchronously append every console message', () => {
  const writeSession = sessionLog.match(/function writeSession\([\s\S]*?\n  \}\n  function flushSessionLogSync/);
  assert.ok(writeSession);
  assert.doesNotMatch(writeSession[0], /appendFileSync/);
  assert.match(writeSession[0], /fsp\.appendFile/);
});

test('normal console output is quiet unless verbose logging is explicitly enabled', () => {
  const fn = sessionLog.match(/function prettyConsole\([\s\S]*?\n  \}\n  function installConsoleCapture/);
  assert.ok(fn);
  assert.match(fn[0], /HIVE_VERBOSE_LOGS/);
});

test('renderer console messages do not synchronously append to session logs', () => {
  const handler = main.match(/mainWindow\.webContents\.on\('console-message'[\s\S]*?\n  \}\);/);
  assert.ok(handler);
  assert.doesNotMatch(handler[0], /appendFileSync|writeFileSync/);
});

test('GStreamer spectrum consumes the documented GValue list', () => {
  assert.match(gst, /GST_VALUE_HOLDS_LIST\(mag\)/);
  assert.match(gst, /gst_value_list_get_size\(mag\)/);
  assert.match(gst, /gst_value_list_get_value\(mag, i\)/);
});

test('Sandbox exposes the plugin panel/launcher surfaces a redraw-on-data visualizer plugin would use', () => {
  // The first-party Monstercat Visualizer plugin this test used to also check
  // (resources/hive-plugins/monstercat-visualizer) was removed -- it never
  // worked under this app's CSP (plugins:run in main.js executes plugin code
  // via `new Function(...)`, which requires 'unsafe-eval') and is being
  // rewritten. The Sandbox host surface itself is independent of any specific
  // plugin and keeps its coverage here.
  const renderer = read('app/renderer/renderer.js');
  assert.match(renderer, /function showSandboxLauncher\(tab = getActiveTab\(\)\)/);
  assert.match(renderer, /function renderHivePluginPanels\(\)/);
});
