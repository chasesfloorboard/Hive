const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

// The first-party Monstercat Visualizer plugin (resources/hive-plugins/
// monstercat-visualizer) was removed -- it never worked under this app's CSP
// (plugins:run in main.js executes plugin code via `new Function(...)`,
// which requires 'unsafe-eval', and the CSP does not grant that) and is being
// rewritten. The native GStreamer spectrum contract itself (the level
// normalization at the C boundary) has its own coverage independent of any
// plugin -- see the gstreamer-spectrum-property-types tests.

test('resources/hive-plugins ships no first-party plugin while the Monstercat Visualizer is being rewritten', () => {
  const files = fs.readdirSync(path.join(root, 'resources', 'hive-plugins'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, 'resources', 'hive-plugins', entry.name, 'manifest.json')));
  assert.deepEqual(files.map(f => f.name), []);
});

test('plugin host exposes explicit lifecycle and capability surfaces without granting filesystem access', () => {
  const source = read('app/renderer/renderer.js');
  const block = source.slice(source.indexOf('// ---------------- Hive community plugin host API v2'));
  assert.match(block, /lifecycle:\{ onUnload:/);
  assert.match(block, /spectrum\.read/);
  assert.match(block, /library\.read/);
  assert.doesNotMatch(block, /require\(['"]fs['"]\)/);
  assert.doesNotMatch(block, /require\(['"]child_process['"]\)/);
});

test('plugin enable state is persisted and disabled plugins are not executed', () => {
  const main = read('app/main/main.js');
  assert.match(main, /plugins:setEnabled/);
  assert.match(main, /manifest\.enabledByDefault !== false/);
  const renderer = read('app/renderer/renderer.js');
  assert.match(renderer, /if\(!plugin\.enabled\) continue/);
  assert.match(renderer, /setPluginEnabled/);
});
